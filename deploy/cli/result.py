"""Stable result envelope for the host CLI.

Non-streaming --json prints one object on stdout with schemaVersion 1.
Human output goes to stderr for progress and stdout for the final report.
No raw subprocess output, secret, token or environment ever enters either.
"""

from __future__ import annotations

import json
import sys
from dataclasses import dataclass

from . import (
    CHATBOT_STATES,
    CONFIGURATION_STATES,
    EXIT_ARGS,
    EXIT_CONFLICT,
    EXIT_OK,
    EXIT_OPERATIONAL,
    EXIT_PREREQ,
    EXIT_ROLLBACK,
    HERMES_STATES,
    INSTALLATION_STATES,
    PERSISTENCE_STATES,
    SCHEMA_VERSION,
    SERVICE_STATES,
)

from .pack_output import render_pack_human


@dataclass
class CommandError(Exception):
    """A stable, reportable CLI failure. Never carries secrets or raw output."""

    code: str
    message: str
    stage: str = ""
    recovery: str = ""
    retryable: bool = False
    exit_code: int = EXIT_OPERATIONAL
    warnings: tuple = ()
    log_ref: str = ""

    def __str__(self) -> str:  # pragma: no cover - trivial
        return f"{self.code}: {self.message}"


def args_error(message: str, recovery: str = "") -> CommandError:
    return CommandError("invalid_args", message, stage="args", recovery=recovery,
                        retryable=False, exit_code=EXIT_ARGS)


def prereq_error(code: str, message: str, recovery: str = "") -> CommandError:
    return CommandError(code, message, stage="preflight", recovery=recovery,
                        retryable=False, exit_code=EXIT_PREREQ)


def conflict_error(code: str, message: str, stage: str = "plan", recovery: str = "") -> CommandError:
    return CommandError(code, message, stage=stage, recovery=recovery,
                        retryable=False, exit_code=EXIT_CONFLICT)


def operational_error(code: str, message: str, stage: str, recovery: str = "",
                      retryable: bool = False) -> CommandError:
    return CommandError(code, message, stage=stage, recovery=recovery,
                        retryable=retryable, exit_code=EXIT_OPERATIONAL)


def rollback_error(code: str, message: str, stage: str, recovery: str = "") -> CommandError:
    return CommandError(code, message, stage=stage, recovery=recovery,
                        retryable=False, exit_code=EXIT_ROLLBACK)


def not_implemented(command: str, milestone: str) -> CommandError:
    return CommandError(
        "not_implemented",
        f"aira {command} is not implemented in this milestone; it reports nothing and changes nothing.",
        stage="dispatch",
        recovery=f"Wait for {milestone}, which adds this command. setup, dashboard and status work now.",
        retryable=False,
        exit_code=EXIT_CONFLICT,
    )


def blank_state() -> dict:
    return {
        "installation": "not_installed",
        "service": "stopped",
        "persistence": "unknown",
        "configuration": "setup_required",
        "hermes": "not_detected",
        "chatbot": "inactive",
    }


def coerce_state(state: dict | None) -> dict:
    merged = blank_state()
    if state:
        for key, allowed in (("installation", INSTALLATION_STATES), ("service", SERVICE_STATES),
                             ("persistence", PERSISTENCE_STATES),
                             ("configuration", CONFIGURATION_STATES),
                             ("hermes", HERMES_STATES), ("chatbot", CHATBOT_STATES)):
            value = state.get(key)
            merged[key] = value if key in state and (value is None or value in allowed) else merged[key]
    return merged


def ok_envelope(command: str, operation_id: str, state: dict | None = None,
                checks: list | None = None, warnings: list | None = None,
                dashboard: dict | None = None) -> dict:
    envelope: dict = {
        "schemaVersion": SCHEMA_VERSION,
        "command": command,
        "outcome": "ok",
        "operationId": operation_id,
        "state": coerce_state(state),
        "checks": checks or [],
        "warnings": warnings or [],
    }
    if dashboard is not None:
        envelope["dashboard"] = dashboard
    return envelope


def error_envelope(command: str, operation_id: str, err: CommandError,
                   state: dict | None = None, checks: list | None = None,
                   warnings: list | None = None, dashboard: dict | None = None) -> dict:
    envelope = ok_envelope(command, operation_id, state, checks,
                           list(warnings or []) + list(err.warnings or []), dashboard)
    envelope["outcome"] = "error"
    envelope["error"] = {
        "code": err.code,
        "stage": err.stage,
        "operationId": operation_id,
        "retryable": err.retryable,
        "message": err.message,
        "recovery": err.recovery,
        "exitClass": exit_name(err.exit_code),
        "log": err.log_ref or "aira logs --component " + {"setup": "setup", "update": "update", "restore": "update", "attach-hermes": "gateway"}.get(command, "cli"),
    }
    return envelope


def exit_name(code: int) -> str:
    return {
        EXIT_OK: "ok",
        EXIT_OPERATIONAL: "operational",
        EXIT_ARGS: "invalid_arguments",
        EXIT_PREREQ: "prerequisite",
        EXIT_CONFLICT: "conflict",
        EXIT_ROLLBACK: "rollback",
    }.get(code, "operational")


def exit_for_envelope(envelope: dict) -> int:
    if envelope.get("outcome") == "ok":
        return EXIT_OK
    try:
        name = envelope["error"]["exitClass"]
    except (KeyError, TypeError):
        return EXIT_OPERATIONAL
    return {
        "ok": EXIT_OK,
        "operational": EXIT_OPERATIONAL,
        "invalid_arguments": EXIT_ARGS,
        "prerequisite": EXIT_PREREQ,
        "conflict": EXIT_CONFLICT,
        "rollback": EXIT_ROLLBACK,
    }.get(name, EXIT_OPERATIONAL)


def emit(envelope: dict, as_json: bool) -> int:
    """Write the envelope. Returns the process exit code."""
    if as_json:
        sys.stdout.write(json.dumps(envelope, sort_keys=True) + "\n")
        return exit_for_envelope(envelope)
    render_human(envelope)
    return exit_for_envelope(envelope)


def progress(message: str) -> None:
    sys.stderr.write(f"aira: {message}\n")


def render_human(envelope: dict) -> None:
    state = envelope.get("state", {})
    if envelope.get("outcome") == "ok":
        sys.stdout.write(f"ok: {envelope.get('command')}\n")
    else:
        err = envelope.get("error", {})
        sys.stderr.write(f"error [{err.get('code', 'unknown')}]: {err.get('message', '')}\n")
        if err.get("recovery"):
            sys.stderr.write(f"recovery: {err['recovery']}\n")
        if err.get("log"):
            sys.stderr.write(f"log: {err['log']}\n")
    parts = [f"{key}={state.get(key, '?')}" for key in
             ("installation", "service", "persistence", "configuration", "hermes", "chatbot")]
    sys.stdout.write("state: " + " ".join(parts) + "\n")
    for check in envelope.get("checks", []):
        mark = check.get("status") or ("pass" if check.get("ok") else "fail")
        reason = f" ({check['reason']})" if check.get("reason") else ""
        sys.stdout.write(f"check {mark}: {check.get('name', '?')}{reason}\n")
        if check.get("recovery"):
            sys.stdout.write(f"  recovery: {check['recovery']}\n")
    for warning in envelope.get("warnings", []):
        sys.stdout.write(f"warning: {warning}\n")
    for key in ("config", "setting", "attach", "update", "backup"):
        if key in envelope:
            sys.stdout.write(f"{key}: " + json.dumps(envelope[key], indent=2, sort_keys=True) + "\n")
    if "pack" in envelope:
        render_pack_human(envelope["pack"])
    dashboard = envelope.get("dashboard")
    if dashboard and dashboard.get("url"):
        sys.stdout.write(f"dashboard: {dashboard['url']}\n")
        if dashboard.get("forwarding"):
            sys.stdout.write(f"forwarding: {dashboard['forwarding']}\n")
