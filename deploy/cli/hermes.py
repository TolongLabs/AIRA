"""Version-pinned, reversible attachment of an independent Hermes profile."""

from __future__ import annotations

import importlib.util
import json
import os
import stat
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from types import SimpleNamespace
from urllib.parse import urlsplit

from . import compose, configure, hermes_versions, install, operations
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


def _load_module(name, path, source):
    spec = importlib.util.spec_from_file_location(name, path)
    module = importlib.util.module_from_spec(spec)
    # Avoid writing bytecode during a dry-run.
    exec(compile(source, str(path), "exec"), module.__dict__)
    return module


def _modules(repo_root):
    base = Path(repo_root) / "deploy" / "gateway" if repo_root else Path(__file__).resolve().parents[1]
    result = {}
    for name in ("standalone_patch", "standalone_adapter"):
        path = base / (name + ".py")
        source, _ = _read(path)
        if name == "standalone_adapter":
            source = hermes_versions.render_helper(source, hermes_versions.BASELINE_ADAPTER_VERSION)
            result["helper"] = source
        result[name] = _load_module("aira_" + name, path, source)
    result["typed"] = _read(base / "standalone_typed_adapter.py")[0]
    result["document"] = _read(base / "standalone_document_adapter.py")[0]
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
    requested_protocol = getattr(args, "protocol", None)
    protocol = 2 if requested_protocol == "v2" else 1
    requested_capabilities = getattr(args, "capabilities", None)
    if requested_capabilities is not None and (protocol != 2 or requested_capabilities not in ("text", "text,document")):
        raise args_error("Select --protocol v2 and a reviewed capability set.")
    if not adapter.PROFILE.fullmatch(args.profile):
        raise args_error("Select a valid Hermes profile name.")
    root = _owned_dir(args.hermes_home or Path.home() / ".hermes")
    source = _owned_dir(args.hermes_dir or root / "hermes-agent")
    profile_dir = _owned_dir(root if args.profile == "default" else root / "profiles" / args.profile)
    head = _process(["git", "rev-parse", "HEAD"], source, root)
    dirty = _process(["git", "diff", "--quiet", "HEAD", "--", ".", ":!" + patch.TARGET], source, root)
    version = hermes_versions.version_for_head(head.stdout.strip()) if head and not head.returncode else None
    if version is None or not dirty or dirty.returncode:
        _refuse("hermes_unsupported", "The public Hermes tree is not the exact supported revision.",
                "Use a reviewed Hermes source revision without unrelated tracked changes.")
    target = source / patch.TARGET
    helper = target.parent / "aira_transport.py"
    baseline = hermes_versions.render_helper(mods["helper"], version)
    typed = hermes_versions.render_typed_helper(mods["helper"], mods["typed"], version)
    document = hermes_versions.render_document_helper(mods["helper"], mods["document"], version)
    marker = profile_dir / adapter.MARKER_NAME
    receipt = home / "data" / "standalone" / "hermes.json"
    host_receipt = receipt.with_name("attach-host.json")
    original = {"source": _read(target), "helper": _read(helper, optional=True),
                "marker": _read(marker, private=True, optional=True), "receipt": _read(receipt, private=True, optional=True),
                "host": _read(host_receipt, private=True, optional=True)}
    kind = patch.classify_source(original["source"][0])
    previous = (hermes_versions.known_helper(mods["helper"], mods["typed"], mods["document"], original["helper"][0])
                if original["helper"] else None)
    previous_version, previous_protocol, previous_capabilities = previous or (None, None, ())
    previous_capabilities = list(previous_capabilities)
    if kind == "unsupported" or (original["helper"] and previous_version is None):
        _refuse("hermes_unsupported", "The adapter source or existing helper is unfamiliar.")
    capabilities = (requested_capabilities.split(",") if requested_capabilities is not None
                    else previous_capabilities if previous_protocol == 2 else ["text"])
    # A v1 downgrade uses the previous typed capability parser while retaining the exact new v1 bytes.
    typed_capabilities = capabilities if protocol == 2 else previous_capabilities or ["text"]
    typed_rendered = document if typed_capabilities == ["text", "document"] else typed
    rendered = typed_rendered if protocol == 2 else baseline
    adapter = _load_module("aira_selected_adapter", helper, rendered)
    typed_adapter = adapter if protocol == 2 else _load_module("aira_typed_adapter", helper, typed_rendered)
    route = report.get("hermesRoute")
    prior_host = json.loads(original["host"][0]) if original["host"] else None
    prior_marker = json.loads(original["marker"][0]) if original["marker"] else None
    if original["marker"] and not isinstance(prior_marker, dict):
        _refuse("hermes_profile_conflict", "The chosen profile marker is invalid.")
    try:
        prior_receipt = json.loads(original["receipt"][0]) if original["receipt"] else None
    except ValueError:
        prior_receipt = None
    prior_versions = [previous_version]
    if isinstance(prior_host, dict):
        prior_versions.append(prior_host.get("adapterVersion"))
    for record in (route, prior_receipt):
        if isinstance(record, dict) and record.get("state") == "connected":
            prior_versions.append(record.get("adapterVersion"))
    protocols = [previous_protocol, 1 if kind == "patched" else 2 if kind == "typed" else None]
    for record in (prior_host, prior_marker):
        if record is not None:
            if not isinstance(record, dict) or type(record.get("schemaVersion")) is not int or record["schemaVersion"] not in (1, 2):
                _refuse("hermes_profile_conflict", "The previous attachment protocol is unrecognized.")
            protocols.append(record["schemaVersion"])
    if isinstance(route, dict) and route.get("state") == "connected":
        protocols.append(route.get("protocolVersion", 1))
    if isinstance(prior_receipt, dict) and prior_receipt.get("state") == "connected":
        protocols.append(prior_receipt.get("schemaVersion", 1))
    if any(value is not None and (type(value) is not int or value not in (1, 2)) for value in protocols):
        _refuse("hermes_profile_conflict", "The previous attachment protocol is unrecognized.")
    typed_history = 2 in protocols
    if typed_history and requested_protocol is None:
        _refuse("hermes_profile_conflict", "Select --protocol v2 to reattach or --protocol v1 to downgrade explicitly.")
    changing_protocol = any(old is not None and old != protocol for old in protocols)
    changing_version = any(old is not None and old != version for old in prior_versions)
    changing_capabilities = previous_protocol == 2 and protocol == 2 and capabilities != previous_capabilities
    changing = changing_version or changing_protocol or changing_capabilities
    if changing and source != root / "hermes-agent":
        _refuse("hermes_contract_failed", "Version, protocol or capability migration requires the selected root's exclusive source checkout.")
    if kind == "original" or changing:
        other_markers = [root / adapter.MARKER_NAME]
        profiles = root / "profiles"
        if profiles.exists():
            other_markers.extend(child / adapter.MARKER_NAME for child in _owned_dir(profiles).iterdir() if child.is_dir())
        if any(path != marker and os.path.lexists(path) for path in other_markers):
            _refuse("hermes_contract_failed", "Other profile markers would be affected by changing the shared adapter.")
    token = install.read_owner_token(home / "data" / "standalone" / "gateway.token")
    expected = {"schemaVersion": 1, "profile": args.profile, "profileHome": str(profile_dir),
                "port": manifest.corePort, "token": token}
    provisional = {**expected, "schemaVersion": 2, "state": "provisional", "routeId": None, "capabilities": typed_capabilities}
    if prior_marker is not None:
        if prior_marker["schemaVersion"] == 2:
            if previous_protocol != 2 or not original["helper"]:
                _refuse("hermes_profile_conflict", "The previous typed marker has no verified helper.")
            previous_adapter = _load_module("aira_previous_adapter", helper, original["helper"][0])
            previous_marker = previous_adapter.read_typed_marker(marker)
            if (previous_marker["state"] != "active" or previous_marker != {
                    **provisional, "state": "active", "routeId": previous_marker["routeId"],
                    "capabilities": previous_capabilities}):
                _refuse("hermes_profile_conflict", "The previous typed marker is unfinished or belongs to a different route.")
        elif adapter.read_marker(marker) != expected:
            _refuse("hermes_profile_conflict", "The chosen profile marker belongs to a different route.")
    if route and route["profile"] != args.profile:
        _refuse("hermes_profile_conflict", "AIRA already has a different attached profile.")
    host_record = {"schemaVersion": 1, "sourceDir": str(source), "hermesHome": str(root),
                   "profile": args.profile, "adapterVersion": adapter.ADAPTER_VERSION}
    if changing or typed_history:
        prior_record = {**host_record, "adapterVersion": previous_version, "schemaVersion": previous_protocol}
        verified_at = route.get("verifiedAt") if isinstance(route, dict) else None
        prior_route = {"state": "connected", "profile": args.profile, "adapterVersion": previous_version,
                       "verifiedAt": verified_at}
        expected_receipt = {"schemaVersion": previous_protocol, **prior_route}
        if previous_protocol == 2 and isinstance(route, dict):
            route_id = route.get("routeId")
            prior_record.update(routeId=route_id, capabilities=previous_capabilities)
            prior_route.update(routeId=route_id, capabilities=previous_capabilities, protocolVersion=2)
            expected_receipt.update(routeId=route_id, capabilities=previous_capabilities)
        expected_kind = "typed" if previous_protocol == 2 else "patched"
        if (previous_version is None or not prior_marker or prior_marker.get("schemaVersion") != previous_protocol
                or (kind != expected_kind and not (kind == "original" and changing_version and previous_protocol == 1))
                or (previous_protocol == 2 and (not hermes_versions.valid_route_id(prior_route.get("routeId"))
                                                or prior_marker.get("routeId") != prior_route.get("routeId")))
                or prior_host != prior_record or not isinstance(verified_at, str)
                or route != prior_route or prior_receipt != expected_receipt):
            _refuse("hermes_profile_conflict", "The previous helper, host record and verified route do not agree.")
    elif original["host"] is not None and prior_host != host_record:
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
    if protocol == 2 or typed_history:
        patched = patch.select_protocol(original["source"][0], protocol)
    else:
        patched = patch.patch_source(original["source"][0]) if kind == "original" else original["source"][0]
    compile(patched, str(target), "exec")
    same_route = typed_history and not changing
    if protocol == 2:
        route_id = route["routeId"] if same_route else None
        expected = {**provisional, "state": "active" if same_route else "provisional", "routeId": route_id}
        host_record = {**host_record, "schemaVersion": 2, "routeId": route_id, "capabilities": capabilities}
    preserve = not changing
    preserve_marker = not changing_protocol and not changing_capabilities and (protocol == 1 or not changing_version)
    plan = {
        "home": home, "manifest": manifest, "selection": selection, "report": report, "sourceDir": source,
        "hermesHome": root, "profileDir": profile_dir, "profile": args.profile, "python": python, "binary": binary,
        "paths": {"source": target, "helper": helper, "marker": marker, "receipt": receipt, "host": host_receipt}, "original": original,
        "desired": {"source": (patched, original["source"][1]),
                    "helper": (rendered, original["helper"][1] if original["helper"] else 0o644),
                    "marker": original["marker"] if original["marker"] and preserve_marker else ((json.dumps(expected, sort_keys=True) + "\n").encode(), 0o600),
                    "host": (original["host"] if original["host"] and preserve else
                             ((json.dumps(host_record, sort_keys=True) + "\n").encode(), 0o600))},
        "kind": kind, "adapter": adapter,
        "typedAdapter": typed_adapter,
        "protocol": protocol, "typedTransaction": protocol == 2 or typed_history,
        "capabilities": capabilities if protocol == 2 else [],
        "provisional": ((json.dumps(provisional, sort_keys=True) + "\n").encode(), 0o600),
    }
    plan["running"] = _profile_status(plan)
    _guard_typed_lifecycle(plan)
    return plan


def _guard_typed_lifecycle(plan):
    if (plan.get("typedTransaction") and plan["running"]
            and any(plan["original"][name] != record for name, record in plan["desired"].items())):
        _refuse("hermes_unsupported", "State-changing typed attachment requires the selected gateway to be stopped.",
                "Stop only the selected profile through its existing supervisor, then repeat dry-run.")


def _detail(plan, apply):
    changes = [name for name, value in plan["desired"].items() if value != plan["original"][name]]
    return {"profile": plan["profile"], "dryRun": not apply, "adapterVersion": plan["adapter"].ADAPTER_VERSION,
            **({"protocol": "v" + str(plan["protocol"])} if plan.get("typedTransaction") else {}),
            **({"capabilities": plan["capabilities"]} if plan.get("protocol") == 2 else {}),
            "sourceState": plan["kind"], "gatewayRunning": plan["running"], "changes": changes,
            "verification": "synthetic local route; no real message; " + ("text and report documents" if plan.get("capabilities") == ["text", "document"] else "text only")}


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


def _private_record(value):
    return ((json.dumps(value, sort_keys=True) + "\n").encode(), 0o600)


def _publish_marker(path, record):
    """The rename is the commit point. No rollback is allowed after it succeeds."""
    fd, temporary = tempfile.mkstemp(prefix=".aira-marker-", dir=path.parent)
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), record[1])
            handle.write(record[0])
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    except (OSError, KeyboardInterrupt):
        Path(temporary).unlink(missing_ok=True)
        raise
    try:
        install.fsync_dir(path.parent)
    except OSError:
        return False
    return True


def _typed_restore(plan, written):
    """Keep the selected route inert until the exact previous files and liveness agree."""
    paths, original = plan["paths"], plan["original"]
    try:
        # Never overwrite executable files loaded by a concurrently started gateway.
        if _profile_status(plan):
            return False
        current = _read(paths["marker"], private=True, optional=True)
        if current != plan["provisional"]:
            # A failure before the provisional marker was published changed no other files.
            unchanged = current == original["marker"] and all(
                _read(paths[name], private=name in ("receipt", "host"), optional=True) == original[name]
                for name in ("source", "helper", "receipt", "host"))
            return unchanged
        for name in ("helper", "source", "receipt", "host"):
            before = original[name]
            value = _read(paths[name], private=name in ("receipt", "host"), optional=True)
            if value == before:
                continue
            if name == "receipt":
                # A failed or lost handshake may have changed its core receipt before returning.
                if name in written and value != written[name]:
                    return False
                try:
                    candidate = json.loads(value[0]) if value else None
                except ValueError:
                    return False
                keys = {"schemaVersion", "state", "profile", "adapterVersion", "verifiedAt"}
                if plan["protocol"] == 2:
                    keys.update({"routeId", "capabilities"})
                if (not isinstance(candidate, dict) or candidate.get("state") != "connected"
                        or set(candidate) != keys or not isinstance(candidate.get("verifiedAt"), str)
                        or candidate.get("schemaVersion") != plan["protocol"]
                        or candidate.get("profile") != plan["profile"]
                        or candidate.get("adapterVersion") != plan["adapter"].ADAPTER_VERSION
                        or (plan["protocol"] == 2 and (not hermes_versions.valid_route_id(candidate.get("routeId"))
                                                      or candidate.get("capabilities") != plan["capabilities"]))):
                    return False
            elif value != written.get(name):
                return False
            _write(paths[name], before)
            if _read(paths[name], private=name in ("receipt", "host"), optional=True) != before:
                return False
        if _profile_status(plan):
            return False
        if _read(paths["marker"], private=True) != plan["provisional"]:
            return False
        _write(paths["marker"], original["marker"])
        return _read(paths["marker"], private=True, optional=True) == original["marker"]
    except (CommandError, OSError, ValueError, compose.RunError, KeyboardInterrupt):
        return False


def _typed_apply(plan, warnings, op):
    paths, original, desired = plan["paths"], plan["original"], plan["desired"]
    written = {}
    final_marker = None
    report = None
    if plan["running"]:
        # Only an exact, read-only repeat can reach this branch. The fresh plan verified prior bytes,
        # authenticated receipt and profile liveness under both locks.
        _guard_typed_lifecycle(plan)
        if _profile_status(plan):
            return plan["report"]
        raise operational_error("attach_failed", "Gateway liveness changed during readback.", "verify")
    try:
        if _profile_status(plan):
            raise operational_error("attach_failed", "The selected gateway started before attachment.", "verify")
        # The existing v1 helper rejects this schema; the v2 helper rejects its provisional state.
        _write(paths["marker"], plan["provisional"])
        if _read(paths["marker"], private=True) != plan["provisional"]:
            raise operational_error("attach_failed", "The provisional marker did not match.", "patch")
        for name in ("source", "helper"):
            written[name] = desired[name]
            if _profile_status(plan):
                raise operational_error("attach_failed", "The selected gateway started during attachment.", "patch")
            if original[name] != desired[name]:
                _write(paths[name], desired[name])
            if _read(paths[name]) != desired[name]:
                raise operational_error("attach_failed", "Adapter readback did not match.", "patch")
        if _profile_status(plan):
            raise operational_error("attach_failed", "Gateway liveness changed during attachment.", "verify")

        if plan["protocol"] == 2:
            route = plan["adapter"].typed_check(paths["marker"])
            if not route or route.get("capabilities") != plan["capabilities"]:
                raise operational_error("hermes_contract_failed", "The typed adapter handshake failed.", "verify")
            marker_value = {**json.loads(desired["marker"][0]), "state": "active", "routeId": route["routeId"]}
            host_value = {**json.loads(desired["host"][0]), "routeId": route["routeId"]}
            known_id = json.loads(desired["marker"][0])["routeId"]
            if known_id is not None and known_id != route["routeId"]:
                raise operational_error("hermes_contract_failed", "An identical route changed its identifier.", "verify")
            prior_marker = json.loads(original["marker"][0]) if original["marker"] else None
            if (known_id is None and prior_marker and prior_marker.get("schemaVersion") == 2
                    and prior_marker.get("routeId") == route["routeId"]):
                raise operational_error("hermes_contract_failed", "A changed typed route did not rotate its identifier.", "verify")
        else:
            # A downgrade is also inert until the v1 handshake and receipt are verified; do not publish
            # a live v1 marker just so the old helper's check() can read it.
            marker_value = json.loads(desired["marker"][0])
            host_value = json.loads(desired["host"][0])
            route = plan["typedAdapter"].typed_downgrade(paths["marker"], json.loads(original["marker"][0])["routeId"])
            if not route:
                raise operational_error("hermes_contract_failed", "The v1 downgrade handshake failed.", "verify")

        # Preserve the exact existing marker and host bytes on identical reattachment.
        final_marker = desired["marker"] if json.loads(desired["marker"][0]) == marker_value else _private_record(marker_value)
        written["host"] = desired["host"] if json.loads(desired["host"][0]) == host_value else _private_record(host_value)
        if original["host"] != written["host"]:
            _write(paths["host"], written["host"])
        core_receipt = {"schemaVersion": plan["protocol"], **{k: v for k, v in route.items() if k != "protocolVersion"}}
        observed_receipt = _read(paths["receipt"], private=True, optional=True)
        if observed_receipt and json.loads(observed_receipt[0]) == core_receipt:
            written["receipt"] = observed_receipt
        report = install.observe(plan["home"], plan["manifest"])
        if (not observed_receipt or json.loads(observed_receipt[0]) != core_receipt
                or report["state"]["service"] != "running" or report.get("hermesRoute") != route
                or _read(paths["receipt"], private=True) != observed_receipt
                or _read(paths["host"], private=True) != written["host"]
                or any(_read(paths[name]) != desired[name] for name in ("source", "helper"))
                or _profile_status(plan) != plan["running"]
                or _read(paths["marker"], private=True) != plan["provisional"]):
            raise operational_error("hermes_contract_failed", "The complete typed attachment readback did not match.", "verify")
        if not _publish_marker(paths["marker"], final_marker):
            warnings.append("The verified marker was published, but directory durability could not be confirmed.")
        return report
    except (CommandError, OSError, ValueError, compose.RunError, KeyboardInterrupt) as err:
        # If the final rename succeeded just before an interrupt, it is already the live commit point.
        if final_marker is not None and report is not None:
            try:
                if _read(paths["marker"], private=True, optional=True) == final_marker:
                    warnings.append("The verified marker was published; final durability could not be confirmed.")
                    return report
            except (CommandError, OSError, ValueError):
                pass
        if not _typed_restore(plan, written):
            raise rollback_error("rollback_failed", "Attachment recovery was incomplete; the route remains inert when possible.",
                                 "rollback", "Restore the private attach backup " + op + " before retrying.") from err
        raise operational_error("attach_failed", "Attachment failed; prior files and gateway state were restored.",
                                "rollback", "Run aira doctor, then repeat dry-run.") from err


class SourceLock(install.DeployLock):
    def __init__(self, source):
        super().__init__(source)
        self.path = source / ".aira-attach.lock"


def _legacy_apply(plan, changed, op):
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
        if (report["state"]["service"] != "running" or route.get("state") != "connected"
                or route.get("profile") != plan["profile"]
                or route.get("adapterVersion") != plan["adapter"].ADAPTER_VERSION):
            raise operational_error("hermes_contract_failed", "Owner health did not confirm the attachment.", "verify")
        return report
    except (CommandError, OSError, ValueError, KeyboardInterrupt) as err:
        if not _restore(plan, changed):
            raise rollback_error("rollback_failed", "Attachment recovery was incomplete.", "rollback",
                                 "Restore the private attach backup " + op + " before retrying.") from err
        raise operational_error("attach_failed", "Attachment failed; prior files and gateway state were restored.",
                                "rollback", "Run aira doctor, then repeat dry-run.") from err


def run_attach(args, op):
    plan = None
    timer = operations.Timer()
    warnings = []
    try:
        if args.apply and not args.yes and (args.non_interactive or args.json or not sys.stdin.isatty() or not sys.stdout.isatty()):
            raise args_error("Apply requires TTY confirmation or explicit --yes.")
        plan = _plan(args)
        _guard_typed_lifecycle(plan)
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
            _guard_typed_lifecycle(plan)
            backup = _backup(plan, op)
            changed = any(plan["original"][name] != record for name, record in plan["desired"].items())
            report = (_typed_apply(plan, warnings, op) if plan.get("typedTransaction")
                      else _legacy_apply(plan, changed, op))
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
    typed = route.get("protocolVersion") == 2
    fields = {"schemaVersion", "sourceDir", "hermesHome", "profile", "adapterVersion"}
    if typed:
        fields.update({"routeId", "capabilities"})
    if (not isinstance(record, dict) or set(record) != fields
            or record["schemaVersion"] != (2 if typed else 1) or record["profile"] != route.get("profile")
            or record["adapterVersion"] != route.get("adapterVersion")):
        _refuse("hermes_contract_failed", "The host attachment record does not match the verified core receipt.")
    if typed and (record["routeId"] != route.get("routeId") or record["capabilities"] != route.get("capabilities")):
        _refuse("hermes_contract_failed", "The typed host route does not match the verified core receipt.")
    plan = _plan(SimpleNamespace(home=str(selection["home"]), repo_root=repo_root_for(Path(__file__).resolve()),
        profile=record["profile"], hermes_dir=record["sourceDir"], hermes_home=record["hermesHome"],
        protocol="v2" if typed else "v1"))
    if any(plan["original"][name] != value for name, value in plan["desired"].items()):
        _refuse("hermes_contract_failed", "The installed adapter or marker no longer matches.")
    return plan["running"]
