"""Read-only installation diagnostics and redacted log reading.

Doctor reports ordered checks without starting, restarting, installing or
probing a paid model. Logs normalizes bounded events without copying raw
output, identities or secret material.
"""

from __future__ import annotations

import json
import re
import sys
import time

from . import compose, configure, install, operations
from .result import (
    CommandError, args_error, blank_state, error_envelope, ok_envelope,
    operational_error,
)

CHECK_STATUSES = ("ok", "warning", "failed", "not_applicable")
LOG_COMPONENTS = ("setup", "cli", "core", "gateway", "update")
OPERATION_COMPONENTS = ("setup", "cli", "update", "gateway")
CONTAINER_COMPONENTS = ("core", "gateway")

LOG_LEVELS = ("debug", "info", "warn", "error")
TIME_CODE = re.compile(r"^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?Z$")
# Only literal events emitted by the core are eligible for a support view.
EVENT_CODES = frozenset("""
core.ready core.stopping core.start_failed core.start_cleanup_failed core.stop_failed
site_api.ready site_api.off site_api.error site_api.write dashboard.request
process.failure_not_recorded process.unhandled_rejection process.uncaught_exception
storage.snapshot storage.snapshot_failed storage.migrated storage.recovered storage.newer_schema
storage.low_space storage.write_failed storage.failure_record_failed storage.cache_trimmed
storage.offsite storage.offsite_failed storage.offsite_check storage.offsite_check_failed
storage.offsite_record_failed storage.offsite_stale_check_failed storage.retention_failed
gateway.malformed gateway.malformed_not_recorded gateway.request_failed gateway.turn_failed
gateway.turn_failure_not_recorded gateway.unmarked gateway.unmarked_not_recorded gateway.write_failed
gateway.unavailable_line_failed turn.received turn.returned turn.cleaned turn.failure turn.uncaught
turn.storage_failed turn.storage_fallback_failed model.spend_failed model_role.off search.off
memory.job_failed memory.no_extraction_model memory.tick_failed memory.fail_failed memory.run_record_failed
schedule.written schedule.write_failed pack.invalid binding.invalid media.off media.dir_missing media.no_gateway_dirs
social.lookup social.lookup_failed social.lookup_record_failed social.mirror_off social.extractor_off
research.job_failed research.tick_failed research.schedule_failed feedback.sync_failed feedback.synced
judge.unavailable api_tool_failed subscription_run_failed tool_record_failed records.weak_secret
""".split())

FOLLOW_POLL_S = 2.0
FOLLOW_POLL_TAIL = 200
LOGS_TIMEOUT_S = 30
SEEN_CAP = 20000


def check_result(name, status, reason="", duration_ms=0, recovery=""):
    if status not in CHECK_STATUSES:
        status = "failed"
    return {
        "name": name, "status": status, "reason": reason,
        "durationMs": int(duration_ms), "recovery": recovery,
        "ok": status != "failed",
    }


def not_applicable(names, reason):
    return [check_result(name, "not_applicable", reason) for name in names]


def docker_step(args, timeout_s=10):
    try:
        code, out, stderr = compose.run(args, timeout_s=timeout_s)
    except compose.RunError as exc:
        raise operational_error("docker_unreachable", "The Docker daemon is unavailable.",
                                "doctor", "Start Docker Engine and retry.") from exc
    if code != 0:
        reason = compose.classify_docker_error(stderr)
        if reason == "denied":
            raise operational_error("docker_permission", "Docker denied access.",
                                    "doctor", "Grant the install owner Docker access and retry.")
        raise operational_error("docker_unreachable", "Docker did not answer.",
                                "doctor", "Start Docker Engine and retry.")
    return out.strip()


def check_prerequisites():
    timer = operations.Timer()
    try:
        import platform
        if platform.system() != "Linux" or platform.machine() not in ("x86_64", "amd64"):
            return check_result("prerequisites", "failed", "unsupported_platform",
                                timer.elapsed_ms(), "Use a supported Linux amd64 host.")
        version = docker_step(["docker", "compose", "version", "--short"])
        if not re.match(r"^v?[2-9][0-9]*\.", version):
            return check_result("prerequisites", "failed", "docker_missing",
                                timer.elapsed_ms(), "Install Docker Compose v2 or later.")
        docker_step(["docker", "info", "--format", "{{.ServerVersion}}"])
    except CommandError as err:
        return check_result("prerequisites", "failed", err.code,
                            timer.elapsed_ms(), err.recovery)
    return check_result("prerequisites", "ok", "docker_available", timer.elapsed_ms())


def resolve_selection(explicit_home=None):
    home, _ = install.resolve_home(explicit_home)
    manifest = install.read_manifest(home)
    if not install.looks_like_install(home):
        return home, None, False
    return home, manifest, True


def check_selection(home, manifest, installed):
    timer = operations.Timer()
    if not installed:
        return check_result("selection", "ok", "not_installed",
                            timer.elapsed_ms(),
                            "Run aira setup to create an installation.")
    try:
        install.check_owned(home, "installation")
        for name in ("compose.yml", ".env", "config.yml"):
            target = home / name
            if not target.is_file():
                return check_result("selection", "failed", "missing_deployment_input",
                                    timer.elapsed_ms(),
                                    "Repair the existing deployment inputs without replacing data.")
            install.check_owned(target, "deployment file")
    except CommandError as err:
        return check_result("selection", "failed", err.code, timer.elapsed_ms(), err.recovery)
    reason = manifest.mode if manifest else "legacy_adopted"
    return check_result("selection", "ok", reason, timer.elapsed_ms())


def check_compose_state(home, manifest=None):
    timer = operations.Timer()
    try:
        project = install._project(home, manifest)
    except CommandError as err:
        return check_result("compose_state", "failed", err.code,
                            timer.elapsed_ms(), err.recovery), None
    except compose.RunError:
        return check_result("compose_state", "failed", "docker_unreachable",
                            timer.elapsed_ms(), "Start Docker Engine and retry."), None
    if not project:
        return check_result("compose_state", "failed", "no_compose_project",
                            timer.elapsed_ms(), "Inspect the installation; no automatic replacement."), None
    try:
        entries = compose.ps_entries(home, project)
        bindings = compose.published_bindings(home, project)
        image = compose.container_image_id(home, project)
    except compose.RunError:
        return check_result("compose_state", "failed", "docker_unreachable",
                            timer.elapsed_ms(), "Start Docker Engine and retry."), None
    if set(bindings) != {9881, 9890}:
        return check_result("compose_state", "failed", "mapping_unavailable",
                            timer.elapsed_ms(),
                            "Inspect the chosen Compose project; the CLI never moves ports."), None
    if not image:
        return check_result("compose_state", "failed", "image_unknown",
                            timer.elapsed_ms(), "Rerun setup or update to record the image."), None
    if manifest and manifest.stage == "installed" and (
        bindings[9881][1] != manifest.corePort or bindings[9890][1] != manifest.sitePort or
        (manifest.mode == "standalone" and (image != manifest.imageId or any(v[0] != "127.0.0.1" for v in bindings.values())))
    ):
        return check_result("compose_state", "failed", "manifest_mismatch", timer.elapsed_ms(),
                            "Inspect the actual ports and image; no automatic rerouting."), None
    running = compose.service_running(entries)
    reason = "running" if running else "stopped"
    return check_result("compose_state", "ok", reason, timer.elapsed_ms()), {
        "project": project, "entries": entries, "bindings": bindings, "image": image,
    }


def check_service_health(mode, compose_state):
    timer = operations.Timer()
    if compose_state is None:
        return check_result("service_health", "not_applicable", "no_compose_state",
                            timer.elapsed_ms())
    if not compose.service_running(compose_state["entries"]):
        return check_result("service_health", "warning", "service_stopped",
                            timer.elapsed_ms(), "Run aira setup to resume; doctor never starts it.")
    result, body = compose.probe_core(compose_state["bindings"][9881][1],
                                      deadline_s=10, mode=mode)
    if result == "ready":
        return check_result("service_health", "ok", "core_ready", timer.elapsed_ms())
    if result == "incompatible":
        return check_result("service_health", "failed", "image_incompatible",
                            timer.elapsed_ms(), "Use a compatible release image.")
    return check_result("service_health", "failed", "health_timeout",
                        timer.elapsed_ms(), "Check the service, then run aira logs.")


def check_owner_health(selection):
    timer = operations.Timer()
    if selection is None:
        return check_result("owner_health", "not_applicable", "service_not_running",
                            timer.elapsed_ms())
    mode = selection["mode"]
    port = selection["bindings"][9890][1]
    token = selection["token"]
    if mode == "standalone":
        ok, _ = compose.probe_owner_standalone(port, token, deadline_s=10)
    else:
        ok = compose.probe_owner_legacy(install.url_for(selection["bindings"][9890], ""), token)
    if ok:
        return check_result("owner_health", "ok", "owner_ready", timer.elapsed_ms())
    return check_result("owner_health", "failed", "owner_auth_failed",
                        timer.elapsed_ms(),
                        "Restore the verified owner credential; never rotate it implicitly.")


def check_configuration(selection, owner_ok):
    timer = operations.Timer()
    if selection is None or not owner_ok:
        return check_result("configuration", "not_applicable", "owner_unavailable",
                            timer.elapsed_ms())
    if selection["mode"] != "standalone":
        try:
            data = configure.api_call(selection, "GET", configure.CONFIG_PATH, timeout_s=10)
        except CommandError as err:
            return check_result("configuration", "failed", err.code, timer.elapsed_ms(), err.recovery)
        status = data.get("status", "unknown")
        if status == "current":
            return check_result("configuration", "ok", "deployment_current", timer.elapsed_ms())
        if status not in ("pending_restart", "invalid", "inaccessible", "memory_only"):
            status = "unknown"
        return check_result("configuration", "failed" if status in ("invalid", "inaccessible") else "warning", f"deployment_{status}",
                            timer.elapsed_ms(), "Recreate the service after a valid config edit.")
    try:
        data = configure.readback(selection)
    except CommandError as err:
        return check_result("configuration", "failed", err.code,
                            timer.elapsed_ms(), err.recovery)
    configuration = data.get("configuration") or "unknown"
    if configuration not in ("configured", "invalid", "setup_required", "pending_activation"):
        configuration = "unknown"
    if configuration == "configured":
        return check_result("configuration", "ok", "model_configured", timer.elapsed_ms())
    if configuration == "invalid":
        return check_result("configuration", "failed", "model_config_invalid",
                            timer.elapsed_ms(), "Correct the saved model revision and activate it.")
    return check_result("configuration", "warning", f"model_{configuration}",
                        timer.elapsed_ms(), "Save and activate a model revision.")


def check_persistence(home, project):
    timer = operations.Timer()
    status, reason = install.check_persistence(home, project)
    if status == "verified":
        return check_result("persistence", "ok", "boot_persistence_verified", timer.elapsed_ms())
    return check_result("persistence", "warning", f"persistence_{status}",
                        timer.elapsed_ms(),
                        reason or "Ask the administrator to enable docker.service.")


def check_hermes(selection=None, owner_ok=False):
    timer = operations.Timer()
    if selection is not None and owner_ok and selection["mode"] == "standalone":
        try:
            health = configure.api_call(selection, "GET", "/owner-api/core/health")
            route = health.get("hermes") or {}
            if route.get("state") == "connected" and route.get("adapterVersion") == "hermes-v0.23.4":
                from .hermes import inspect_attachment
                running = inspect_attachment(selection, route)
                return check_result("hermes", "ok" if running else "warning", "route_verified" if running else "route_verified_gateway_stopped",
                                    timer.elapsed_ms(), "" if running else "Start the selected Hermes gateway explicitly when ready.")
            if route.get("state") in ("invalid", "unsupported"):
                return check_result("hermes", "failed", "hermes_" + route["state"], timer.elapsed_ms(), "Verify the pinned source and repeat dry-run.")
        except (CommandError, OSError, ValueError):
            return check_result("hermes", "failed", "route_unverified", timer.elapsed_ms(), "Run aira attach-hermes --dry-run with the selected profile.")
    state, reason = install.detect_hermes()
    if state == "detected":
        return check_result("hermes", "warning", "hermes_detected_not_verified", timer.elapsed_ms(),
                            "Run aira attach-hermes --dry-run with the selected profile.")
    return check_result("hermes", "warning", "hermes_not_detected",
                        timer.elapsed_ms(), reason or "Hermes is optional until attachment.")


def run_doctor(args, operation_id):
    """Run read-only ordered checks. Returns the result envelope."""
    checks = []
    warnings = []
    home = manifest = None
    try:
        checks.append(check_prerequisites())
        if checks[-1]["status"] != "failed":
            try:
                home, manifest, installed = resolve_selection(getattr(args, "home", None))
            except CommandError as err:
                checks.append(check_result("selection", "failed", err.code, 0, err.recovery))
                checks.extend(not_applicable(
                    ("compose_state", "service_health", "owner_health",
                     "configuration", "persistence", "hermes"), "selection_failed"))
            else:
                checks.append(check_selection(home, manifest, installed))
                if installed:
                    state_check, compose_state = check_compose_state(home, manifest)
                    checks.append(state_check)
                    mode = manifest.mode if manifest else "legacy"
                    checks.append(check_service_health(mode, compose_state))
                    selection = None
                    owner_ok = False
                    running = (compose_state is not None
                               and compose.service_running(compose_state["entries"]))
                    if running:
                        try:
                            selection = configure.selected_api(
                                getattr(args, "home", None), need_running=True)
                        except CommandError as err:
                            checks.append(check_result("owner_health", "failed", err.code,
                                                       0, err.recovery))
                        if selection is not None:
                            owner_check = check_owner_health(selection)
                            checks.append(owner_check)
                            owner_ok = owner_check["status"] == "ok"
                    else:
                        checks.append(check_result("owner_health", "not_applicable",
                                                   "service_not_running", 0))
                    checks.append(check_configuration(selection, owner_ok))
                    project = compose_state["project"] if compose_state else None
                    checks.append(check_persistence(home, project))
                    checks.append(check_hermes(selection, owner_ok))
                else:
                    checks.extend(not_applicable(
                        ("compose_state", "service_health", "owner_health",
                         "configuration", "persistence", "hermes"), "not_installed"))
        try:
            report = install.observe(home, manifest) if home is not None else None
            state = report["state"] if report else blank_state()
            dashboard = report.get("dashboard") if report else None
        except (CommandError, compose.RunError, OSError, ValueError):
            state, dashboard = blank_state(), None
        for item in checks:
            if item["status"] == "warning":
                warnings.append(f"{item['name']}: {item['reason']}")
        if any(item["status"] == "failed" for item in checks):
            result = error_envelope("doctor", operation_id, operational_error(
                "check_failed", "One or more required checks failed.", "doctor",
                "See each check recovery; run aira logs for detail."), state, checks,
                warnings, dashboard)
        else:
            result = ok_envelope("doctor", operation_id, state, checks, warnings, dashboard)
    except CommandError as err:
        result = error_envelope("doctor", operation_id, err)
    except compose.RunError:
        result = error_envelope("doctor", operation_id, operational_error(
            "docker_unreachable", "Docker state could not be verified.", "doctor",
            "Start Docker Engine and retry."))
    except (OSError, ValueError):
        result = error_envelope("doctor", operation_id, operational_error(
            "path_unwritable", "Installation state could not be read.", "doctor",
            "Check the selected installation and permissions."))
    return result


def normalize_container_log(component, line):
    try:
        raw = json.loads(line)
    except (ValueError, UnicodeError):
        return None
    if not isinstance(raw, dict):
        return None
    text = raw.get("ts") or raw.get("time") or raw.get("timestamp")
    ts = text if isinstance(text, str) and TIME_CODE.fullmatch(text) else None
    level = raw.get("level")
    level = level.lower() if isinstance(level, str) else "info"
    if level not in LOG_LEVELS:
        level = "info"
    is_gateway = raw.get("module") == "gateway"
    if (component == "gateway") != is_gateway:
        return None
    module = "gateway" if is_gateway else "core"
    event = raw.get("event")
    if not isinstance(event, str) or event not in EVENT_CODES:
        return None
    out = {"component": component, "level": level, "module": module,
           "event": event, "message": event.replace("_", " ")}
    if ts is not None:
        out["ts"] = ts
    return out


def read_container_logs(selection, component, tail):
    cid = compose.container_id(selection["home"], selection["project"])
    if cid is None:
        raise compose.RunError("missing")
    code, out, _ = compose.run(["docker", "logs", "--tail", str(tail), cid], timeout_s=LOGS_TIMEOUT_S)
    if code != 0:
        raise configure.compose.RunError("failed")
    events = []
    for line in out.splitlines():
        entry = normalize_container_log(component, line.strip())
        if entry is not None:
            events.append(entry)
    return events


def collect_logs(components, lines, selection):
    events = []
    checks = []
    warnings = []
    for component in components:
        found = []
        if component in OPERATION_COMPONENTS:
            try:
                found = operations.read_events(lines, component)
            except (OSError, ValueError):
                found = []
            for entry in found:
                entry = dict(entry)
                entry.setdefault("component", component)
                events.append(entry)
            if component not in CONTAINER_COMPONENTS:
                checks.append({"name": component, "ok": True, "reason": "operation_events"})
        if component in CONTAINER_COMPONENTS:
            if selection is None:
                checks.append({"name": component, "ok": bool(found), "reason": "operation_events" if found else "component_unavailable"})
                warnings.append(f"{component}: the container source is unavailable.")
                continue
            try:
                events.extend(read_container_logs(selection, component, lines))
            except configure.compose.RunError:
                checks.append({"name": component, "ok": bool(found), "reason": "operation_events" if found else "component_unavailable"})
                warnings.append(f"{component}: the container source is unavailable.")
                continue
            checks.append({"name": component, "ok": True, "reason": "container_logs"})
    events.sort(key=lambda e: e.get("ts") or "")
    return events[-lines:], checks, warnings


def format_text(event):
    head = str(event.get("ts") or "")
    middle = f"{event.get('component', '?')}/{event.get('module', '?')}"
    tail = f"{event.get('event', 'unknown')}: {event.get('message', '')}"
    return f"{head} {event.get('level', 'info')} {middle} {tail}".strip()


def _log_options(args):
    component = getattr(args, "component", None) or "all"
    lines = getattr(args, "lines", 50)
    if type(lines) is not int or not 1 <= lines <= 1000:
        raise args_error("Lines is out of range.", "Use --lines 1..1000.")
    if component != "all" and component not in LOG_COMPONENTS:
        raise args_error("Unknown log component.", "Use setup, cli, core, gateway or update.")
    return component, lines, LOG_COMPONENTS if component == "all" else (component,)


def _log_selection(args):
    # Private host operation logs are still available with a broken manifest or
    # stopped core. Container logs require the actual owned Compose selection,
    # not an owner token (the host owner is already authorized for Docker).
    selection = None
    report = {}
    try:
        home, _ = install.resolve_home(getattr(args, "home", None))
        manifest = install.read_manifest(home)
        if install.looks_like_install(home):
            project = install._project(home, manifest)
            if project:
                selection = {"home": home, "project": project}
        report = install.observe(home, manifest)
    except (CommandError, compose.RunError, OSError, ValueError):
        pass
    return selection, report.get("state", blank_state()), report.get("dashboard")


def run_logs(args, operation_id):
    component, lines, wanted = _log_options(args)
    selection, state, dashboard = _log_selection(args)
    if getattr(args, "follow", False):
        return stream_logs(args, operation_id, component, lines, wanted, selection)
    events, checks, warnings = collect_logs(wanted, lines, selection)
    if component != "all" and any(not check["ok"] for check in checks):
        return error_envelope("logs", operation_id, operational_error(
            "component_unavailable", "The selected log source is unavailable.", "logs",
            "Run aira doctor; stopped containers stay readable while their logs exist."),
            state, checks, warnings, dashboard)
    result = ok_envelope("logs", operation_id, state, checks, warnings, dashboard)
    result["events"] = events
    if not args.json:
        for entry in events:
            sys.stdout.write(format_text(entry) + "\n")
    return result


def stream_logs(args, operation_id, component, lines, wanted, selection):
    """Read bounded JSONL or human events until interrupted."""
    seen = {}
    operations.log_event("cli", operation_id, "logs", "follow_start", "ok")
    try:
        while True:
            batch, checks, _ = collect_logs(wanted, lines, selection)
            if component != "all" and any(not check["ok"] for check in checks):
                raise operational_error("component_unavailable", "The selected log source is unavailable.",
                                        "logs", "Run aira doctor.")
            for entry in batch:
                key = json.dumps(entry, sort_keys=True)
                if key in seen:
                    continue
                seen[key] = True
                if len(seen) > SEEN_CAP:
                    seen.pop(next(iter(seen)))
                line = json.dumps({"schemaVersion": 1, **entry}, sort_keys=True) if args.json else format_text(entry)
                sys.stdout.write(line + "\n")
                sys.stdout.flush()
            time.sleep(FOLLOW_POLL_S)
    except KeyboardInterrupt:
        operations.log_event("cli", operation_id, "logs", "follow_interrupted", "ok")
        return 0
