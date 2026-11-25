"""Version-pinned, reversible attachment of an independent Hermes profile."""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

from . import compose, configure, install, operations
from .result import CommandError, args_error, conflict_error, error_envelope, ok_envelope, operational_error, rollback_error

COMMAND = "attach-hermes"
PROFILE_PROBE = r"""
import json, sys
from pathlib import Path
from hermes_cli.profiles import get_profile_dir, profile_exists, profile_is_standalone, list_profile_names
from gateway.status import resolve_gateway_liveness, get_running_pid
from hermes_cli.gateway import named_profile_served_by_running_multiplexer, host_multiplexer_serving

try:
    name, expected = sys.argv[1], Path(sys.argv[2])
    profile = get_profile_dir(name)
    if profile.resolve() != expected or not profile.is_dir() or not profile_exists(name):
        raise ValueError()
    live = resolve_gateway_liveness(profile_dir=profile, use_cache=False,
        pid_probe=lambda path: get_running_pid(path, cleanup_stale=False))
    served = host_multiplexer_serving(name)
    other = (served is not None and
        (not served.served_known or served.home.resolve() != expected or
         any(value != name for value in served.profiles)))
    independent = (list_profile_names() == ["default"] if name == "default"
        else profile_is_standalone(profile))
    print(json.dumps({"independent": independent and not other and live.source != "multiplexer"
        and not named_profile_served_by_running_multiplexer(name),
        "running": live.running, "unknown": live.probe_error}))
except Exception:
    print(json.dumps({"unknown": True}))
"""


def _refuse(code, message, recovery="Select the pinned independent Hermes profile and retry."):
    raise conflict_error(code, message, stage="plan", recovery=recovery)


def _owned_dir(path):
    path = install.canonical(path)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid():
        _refuse("hermes_unsupported", "Hermes source or profile is not an owned real directory.")
    return path


def _read(path, private=False, optional=False):
    path = install.canonical(path)
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except FileNotFoundError:
        if optional:
            return None
        raise
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        mode = stat.S_IMODE(info.st_mode)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or (private and mode != 0o600):
            _refuse("hermes_contract_failed", "A touched file has unsafe ownership or permissions.")
        data = handle.read(2 * 1024 * 1024 + 1)
        if len(data) > 2 * 1024 * 1024:
            _refuse("hermes_contract_failed", "A touched file exceeds its size bound.")
        return data, mode


def _write(path, record):
    # Source, marker and receipt all use UTF-8; backup original bytes exactly.
    if record is None:
        _read(path, optional=True)
        path.unlink(missing_ok=True)
        install.fsync_dir(path.parent)
    else:
        data, mode = record
        install.atomic_write_text(path, data.decode("utf-8"), mode=mode)


def _modules(repo_root):
    base = Path(repo_root) / "deploy" / "gateway" if repo_root else Path(__file__).resolve().parents[1]
    result = {}
    for name in ("standalone_patch", "standalone_adapter"):
        path = base / (name + ".py")
        source, _ = _read(path)
        spec = importlib.util.spec_from_file_location("aira_" + name, path)
        module = importlib.util.module_from_spec(spec)
        # Avoid writing bytecode during a dry-run.
        exec(compile(source, str(path), "exec"), module.__dict__)
        result[name] = module
        if name == "standalone_adapter":
            result["helper"] = source
    return result


def _process(argv, source, hermes_home, timeout=20):
    env = dict(os.environ)
    env["HERMES_HOME"] = str(hermes_home)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    try:
        result = subprocess.run(argv, cwd=source, env=env, stdin=subprocess.DEVNULL,
                                capture_output=True, text=True, timeout=timeout, check=False)
        if len(result.stdout) > 64 * 1024:
            return None
        return result
    except (OSError, UnicodeError, subprocess.TimeoutExpired):
        return None


def _profile_status(plan):
    result = _process([str(plan["python"]), "-c", PROFILE_PROBE, plan["profile"], str(plan["profileDir"])],
                      plan["sourceDir"], plan["hermesHome"])
    try:
        data = json.loads(result.stdout.strip().splitlines()[-1]) if result and result.returncode == 0 else {}
    except (ValueError, IndexError):
        data = {}
    if data.get("unknown") is not False or type(data.get("running")) is not bool:
        _refuse("hermes_contract_failed", "Cannot verify the selected profile's liveness.")
    if data.get("independent") is not True:
        _refuse("hermes_unsupported", "The selected profile is not independent.",
                "Use a single default profile or an existing named profile configured as standalone; do not change unrelated profiles.")
    return data["running"]


def _plan(args):
    selection = configure.selected_api(args.home)
    home, manifest = selection["home"], selection["manifest"]
    if not manifest or manifest.mode != "standalone" or manifest.stage != "installed":
        _refuse("capability_unavailable", "Attach requires an installed standalone service.")
    if set(selection["bindings"]) != {9881, 9890} or any(
        selection["bindings"][key][1] != value for key, value in ((9881, manifest.corePort), (9890, manifest.sitePort))
    ):
        _refuse("port_conflict", "The observed bindings differ from the committed install.")
    report = install.observe(home, manifest)
    if report["state"]["service"] != "running" or report["state"]["installation"] != "installed":
        _refuse("health_timeout", "The installed service is not authenticated and ready.", "Run aira doctor and setup first.")
    mods = _modules(args.repo_root)
    patch, adapter = mods["standalone_patch"], mods["standalone_adapter"]
    if not adapter.PROFILE.fullmatch(args.profile):
        raise args_error("Select a valid Hermes profile name.")
    root = _owned_dir(args.hermes_home or Path.home() / ".hermes")
    source = _owned_dir(args.hermes_dir or root / "hermes-agent")
    profile_dir = _owned_dir(root if args.profile == "default" else root / "profiles" / args.profile)
    head = _process(["git", "rev-parse", "HEAD"], source, root)
    dirty = _process(["git", "diff", "--quiet", "HEAD", "--", ".", ":!" + patch.TARGET], source, root)
    if not head or head.returncode or head.stdout.strip() != patch.PINNED_HERMES_TREE or not dirty or dirty.returncode:
        _refuse("hermes_unsupported", "The public Hermes tree is not the exact supported revision.",
                "Use the supported v0.23.4 installation without unrelated tracked changes.")
    target = source / patch.TARGET
    helper = target.parent / "aira_transport.py"
    marker = profile_dir / adapter.MARKER_NAME
    receipt = home / "data" / "standalone" / "hermes.json"
    host_receipt = receipt.with_name("attach-host.json")
    original = {"source": _read(target), "helper": _read(helper, optional=True),
                "marker": _read(marker, private=True, optional=True), "receipt": _read(receipt, private=True, optional=True),
                "host": _read(host_receipt, private=True, optional=True)}
    kind = patch.classify_source(original["source"][0])
    if kind == "unsupported" or (original["helper"] and original["helper"][0] != mods["helper"]):
        _refuse("hermes_unsupported", "The adapter source or existing helper is unfamiliar.")
    if kind == "original":
        other_markers = [root / adapter.MARKER_NAME]
        profiles = root / "profiles"
        if profiles.exists():
            other_markers.extend(child / adapter.MARKER_NAME for child in _owned_dir(profiles).iterdir() if child.is_dir())
        if any(path != marker and os.path.lexists(path) for path in other_markers):
            _refuse("hermes_contract_failed", "Other profile markers exist without the expected shared adapter.")
    token = install.read_owner_token(home / "data" / "standalone" / "gateway.token")
    expected = {"schemaVersion": 1, "profile": args.profile, "profileHome": str(profile_dir),
                "port": manifest.corePort, "token": token}
    if original["marker"] is not None and adapter.read_marker(marker) != expected:
        _refuse("hermes_profile_conflict", "The chosen profile marker belongs to a different route.")
    route = report.get("hermesRoute")
    if route and route["profile"] != args.profile:
        _refuse("hermes_profile_conflict", "AIRA already has a different attached profile.")
    host_record = {"schemaVersion": 1, "sourceDir": str(source), "hermesHome": str(root),
                   "profile": args.profile, "adapterVersion": adapter.ADAPTER_VERSION}
    if original["host"] is not None and json.loads(original["host"][0]) != host_record:
        _refuse("hermes_profile_conflict", "The saved attachment refers to different source or profile paths.")
    # Avoid a recursive provider route. The adapter never changes Hermes providers.
    cfg = configure.readback(selection)
    for pair in (cfg.get("saved"), cfg.get("applied")):
        for role in (pair or {}).values():
            if not isinstance(role, dict):
                continue
            url = urlsplit(role.get("baseUrl", ""))
            if url.hostname in ("localhost", "127.0.0.1", "::1", "host.docker.internal") and url.port in (
                manifest.corePort, manifest.sitePort, 9881, 9890
            ):
                _refuse("model_config_invalid", "The model endpoint points back to AIRA.", "Select an independent model provider.")
    environments = [(source / name / "bin" / "python", source / name / "bin" / "hermes") for name in (".venv", "venv")]
    environments = [pair for pair in environments if all(path.is_file() and os.access(path, os.X_OK) for path in pair)]
    if len(environments) != 1:
        _refuse("hermes_unsupported", "The pinned Hermes virtual environment is unavailable.")
    python, binary = environments[0]
    patched = patch.patch_source(original["source"][0]) if kind == "original" else original["source"][0]
    compile(patched, str(target), "exec")
    compile(mods["helper"], str(helper), "exec")
    plan = {
        "home": home, "manifest": manifest, "selection": selection, "report": report, "sourceDir": source,
        "hermesHome": root, "profileDir": profile_dir, "profile": args.profile, "python": python, "binary": binary,
        "paths": {"source": target, "helper": helper, "marker": marker, "receipt": receipt, "host": host_receipt}, "original": original,
        "desired": {"source": (patched, original["source"][1]),
                    "helper": (mods["helper"], original["helper"][1] if original["helper"] else 0o644),
                    "marker": original["marker"] or ((json.dumps(expected, sort_keys=True) + "\n").encode(), 0o600),
                    "host": original["host"] or ((json.dumps(host_record, sort_keys=True) + "\n").encode(), 0o600)},
        "kind": kind, "adapter": adapter,
    }
    plan["running"] = _profile_status(plan)
    return plan


def _detail(plan, apply):
    changes = [name for name, value in plan["desired"].items() if value != plan["original"][name]]
    return {"profile": plan["profile"], "dryRun": not apply, "adapterVersion": plan["adapter"].ADAPTER_VERSION,
            "sourceState": plan["kind"], "gatewayRunning": plan["running"], "changes": changes,
            "verification": "synthetic local route; no real message; text only"}


def _gateway_command(plan, verb):
    result = _process([str(plan["binary"]), "-p", plan["profile"], "gateway", verb],
                      plan["sourceDir"], plan["hermesHome"], timeout=60)
    if result is None or result.returncode:
        raise operational_error("attach_failed", "The selected Hermes gateway command failed.", "restart")
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        if _profile_status(plan) == (verb != "stop"):
            return
        time.sleep(1)
    raise operational_error("attach_failed", "The selected Hermes gateway did not return to its prior state.", "restart")


def _backup(plan, op):
    root = plan["home"] / "data" / "standalone" / "attach-backups"
    install.ensure_private_dir(root)
    backup = root / op
    backup.mkdir(mode=0o700)
    metadata = {}
    for name, record in plan["original"].items():
        metadata[name] = {"present": record is not None, "mode": record[1] if record else None}
        if record:
            _write(backup / (name + ".orig"), (record[0], 0o600))
    install.atomic_write_text(backup / "manifest.json", json.dumps({"schemaVersion": 1, "profile": plan["profile"],
        "files": metadata}, sort_keys=True) + "\n")
    return backup


def _restore(plan, changed):
    # Roll back while both locks are still held. Never replace unfamiliar concurrent edits.
    ok = True
    for name in ("marker", "helper", "source", "receipt", "host"):
        try:
            path, before = plan["paths"][name], plan["original"][name]
            current = _read(path, private=name in ("marker", "receipt", "host"), optional=True)
            if current == before:
                continue
            if name != "receipt" and current != plan["desired"].get(name):
                ok = False
                continue
            _write(path, before)
            ok = _read(path, private=name in ("marker", "receipt", "host"), optional=True) == before and ok
        except (CommandError, OSError, ValueError):
            ok = False
    try:
        if plan["running"] and changed:
            _gateway_command(plan, "restart")
        elif _profile_status(plan) != plan["running"]:
            ok = False
    except (CommandError, OSError, ValueError):
        ok = False
    return ok


class SourceLock(install.DeployLock):
    def __init__(self, source):
        super().__init__(source)
        self.path = source / ".aira-attach.lock"


def run_attach(args, op):
    plan = None
    timer = operations.Timer()
    warnings = []
    try:
        if args.apply and not args.yes and (args.non_interactive or args.json or not sys.stdin.isatty() or not sys.stdout.isatty()):
            raise args_error("Apply requires TTY confirmation or explicit --yes.")
        plan = _plan(args)
        if not args.apply:
            result = ok_envelope(COMMAND, op, plan["report"]["state"], [{"name": "pinned_profile", "ok": True}],
                                 [], plan["report"]["dashboard"])
            result["attach"] = _detail(plan, False)
            return result
        if not args.yes:
            sys.stderr.write("Apply the reviewed adapter to this profile? [y/N] ")
            if sys.stdin.readline().strip().lower() not in ("yes", "y"):
                raise conflict_error("attach_declined", "No change was made.")
        with install.DeployLock(plan["home"]), SourceLock(plan["sourceDir"]):
            fresh = _plan(args)
            if any(fresh[key] != plan[key] for key in ("original", "desired", "running", "paths")):
                _refuse("hermes_contract_failed", "The planned files or gateway state changed. Run dry-run again.")
            plan = fresh
            backup = _backup(plan, op)
            changed = any(plan["original"][name] != record for name, record in plan["desired"].items())
            try:
                for name, record in plan["desired"].items():
                    if plan["original"][name] != record:
                        _write(plan["paths"][name], record)
                    if _read(plan["paths"][name], private=name in ("marker", "host")) != record:
                        raise operational_error("attach_failed", "Adapter readback did not match.", "patch")
                if plan["running"] and changed:
                    _gateway_command(plan, "restart")
                if _profile_status(plan) != plan["running"]:
                    raise operational_error("attach_failed", "Gateway liveness changed during attachment.", "verify")
                if not plan["adapter"].check(plan["paths"]["marker"], "connect"):
                    raise operational_error("hermes_contract_failed", "The local adapter handshake failed.", "verify")
                report = install.observe(plan["home"], plan["manifest"])
                route = report.get("hermesRoute") or {}
                if report["state"]["service"] != "running" or route.get("state") != "connected" or route.get("profile") != plan["profile"]:
                    raise operational_error("hermes_contract_failed", "Owner health did not confirm the attachment.", "verify")
            except (CommandError, OSError, ValueError, KeyboardInterrupt) as err:
                if not _restore(plan, changed):
                    raise rollback_error("rollback_failed", "Attachment recovery was incomplete.", "rollback",
                                         "Restore the private attach backup " + op + " before retrying.") from err
                raise operational_error("attach_failed", "Attachment failed; prior files and gateway state were restored.",
                                        "rollback", "Run aira doctor, then repeat dry-run.") from err
            if not plan["running"]:
                warnings.append("The stopped gateway remains stopped. Start the selected profile with hermes -p "
                                + plan["profile"] + " gateway start when ready.")
            result = ok_envelope(COMMAND, op, report["state"], [{"name": "route_verified", "ok": True}],
                                 warnings, report["dashboard"])
            result["attach"] = _detail(plan, True)
            result["attach"]["backupId"] = backup.name
            operations.log_event("gateway", op, "verify", "attached", "ok", duration_ms=timer.elapsed_ms())
            return result
    except CommandError as err:
        result = error_envelope(COMMAND, op, err)
    except (OSError, ValueError, compose.RunError, KeyboardInterrupt):
        result = error_envelope(COMMAND, op, operational_error("hermes_contract_failed",
            "The selected profile or source could not be verified.", "discover", "Check the pinned Hermes installation and ownership."))
    operations.log_event("gateway", op, result["error"]["stage"], result["error"]["code"], "error",
                         duration_ms=timer.elapsed_ms())
    return result


def inspect_attachment(selection, route):
    """Cross-check the public core receipt against the exact installed host files."""
    from .launcher import repo_root_for
    record = json.loads(install.read_owned_text(selection["home"] / "data" / "standalone" / "attach-host.json", 8192))
    if (not isinstance(record, dict) or set(record) != {"schemaVersion", "sourceDir", "hermesHome", "profile", "adapterVersion"}
            or record["schemaVersion"] != 1 or record["profile"] != route.get("profile")
            or record["adapterVersion"] != route.get("adapterVersion")):
        _refuse("hermes_contract_failed", "The host attachment record does not match the verified core receipt.")
    plan = _plan(SimpleNamespace(home=str(selection["home"]), repo_root=repo_root_for(Path(__file__).resolve()),
        profile=record["profile"], hermes_dir=record["sourceDir"], hermes_home=record["hermesHome"]))
    if any(plan["original"][name] != value for name, value in plan["desired"].items()):
        _refuse("hermes_contract_failed", "The installed adapter or marker no longer matches.")
    return plan["running"]
