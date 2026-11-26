"""Portable command surface. All host actions remain outside the core."""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

from . import (
    __version__, backup, compose, configure, diagnostics, hermes, hermes_versions, install, launcher, operations, update,
)
from .result import CommandError, args_error, conflict_error, emit, error_envelope, ok_envelope, operational_error


class Parser(argparse.ArgumentParser):
    def error(self, message):
        # Do not echo arbitrary arguments; secret material does not belong in CLI arguments.
        raise args_error("Invalid command or options.", "Run aira --help for supported flags.")


def _globals(parser, inherited=False):
    default = argparse.SUPPRESS if inherited else None
    parser.add_argument("--home", default=default, help="Select the install directory.")
    for name in ("--json", "--non-interactive"):
        parser.add_argument(name, action="store_true",
                            default=argparse.SUPPRESS if inherited else False)


def _browser_flags(parser):
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--open", action="store_true", help="Open on a usable local desktop.")
    group.add_argument("--no-open", action="store_true", help="Print the URL without opening a browser.")


def build_parser():
    parser = Parser(prog="aira", description="Portable AIRA installation and owner console.")
    parser.add_argument("--version", action="version", version=f"%(prog)s {__version__}")
    _globals(parser)
    sub = parser.add_subparsers(dest="command")
    setup = sub.add_parser("setup", help="Install, adopt, or resume the service.")
    _globals(setup, True)
    setup.add_argument("--site-port", type=int)
    setup.add_argument("--core-port", type=int)
    setup.add_argument("--image", help="Explicit compatible image reference (local candidate allowed).")
    _browser_flags(setup)
    dashboard = sub.add_parser("dashboard", help="Discover the dashboard without starting it.")
    _globals(dashboard, True)
    _browser_flags(dashboard)
    dashboard.add_argument("--show-token", action="store_true", help="Reveal the owned credential to an interactive TTY.")
    status = sub.add_parser("status", help="Read-only installation and runtime state.")
    _globals(status, True)
    doctor = sub.add_parser("doctor", help="Run read-only installation diagnostics.")
    _globals(doctor, True)
    logs = sub.add_parser("logs", help="Read bounded redacted operation events.")
    _globals(logs, True)
    logs.add_argument("--component", choices=diagnostics.LOG_COMPONENTS)
    logs.add_argument("--lines", type=int, default=50)
    logs.add_argument("--follow", action="store_true")
    config = sub.add_parser("config", help="Read and write typed owner configuration.")
    _globals(config, True)
    typed = config.add_subparsers(dest="config_command", required=True)
    get = typed.add_parser("get", help="Read saved and applied configuration.")
    _globals(get, True)
    model = typed.add_parser("set-model", help="Save a model role without activating it.")
    _globals(model, True)
    model.add_argument("--role", required=True, choices=configure.ROLES)
    model.add_argument("--provider", choices=configure.PROVIDERS)
    model.add_argument("--model")
    model.add_argument("--base-url")
    model.add_argument("--effort")
    model.add_argument("--deep-effort")
    for name in ("input-price", "output-price", "cached-price"):
        model.add_argument("--" + name)
    model.add_argument("--expected-revision")
    key = model.add_mutually_exclusive_group()
    for name in ("key-stdin", "prompt-key", "clear-key"):
        key.add_argument("--" + name, action="store_true")
    model.add_argument("--disable", action="store_true")
    activate = typed.add_parser("activate", help="Activate the saved model revision and verify it.")
    _globals(activate, True)
    activate.add_argument("--expected-revision")
    character = typed.add_parser("set-character", help="Change the character at a settings scope.")
    _globals(character, True)
    character.add_argument("--level", required=True, choices=configure.LEVELS)
    character.add_argument("--scope", default="")
    character.add_argument("--pack", required=True)
    character.add_argument("--expected-revision")
    attach = sub.add_parser("attach-hermes", help="Verify or attach a supported Hermes profile.")
    _globals(attach, True)
    attach.add_argument("--profile", required=True)
    attach.add_argument("--hermes-dir")
    attach.add_argument("--hermes-home")
    attach.add_argument("--protocol", choices=("v1", "v2"), help="Select v1 (default) or candidate typed v2 explicitly.")
    attach.add_argument("--capabilities", choices=hermes_versions.CAPABILITY_OPTIONS,
                        help="Explicit v2 capability set; omit to preserve an existing typed route.")
    apply = attach.add_mutually_exclusive_group(required=True)
    apply.add_argument("--dry-run", action="store_true")
    apply.add_argument("--apply", action="store_true")
    attach.add_argument("--yes", action="store_true")
    update_parser = sub.add_parser("update", help="Verify and switch a standalone stable release.")
    _globals(update_parser, True)
    update_parser.add_argument("--image", help="Explicit loaded compatible fixture image.")
    restore = sub.add_parser("restore", help="Verify and copy a backup to a new private directory.")
    _globals(restore, True)
    restore.add_argument("--backup-id", required=True)
    restore.add_argument("--destination", required=True)
    return parser


def _report(args):
    home, _ = install.resolve_home(args.home)
    manifest = install.read_manifest(home)
    return home, manifest, install.observe(home, manifest)


def _envelope(command, op, report):
    result = ok_envelope(command, op, report["state"], report["checks"],
                         report["warnings"], report["dashboard"])
    if report.get("imageId"):
        result["imageId"] = report["imageId"]
    if report.get("mode"):
        result["installationMode"] = report["mode"]
    if report.get("management"):
        result["management"] = report["management"]
    if report.get("release"):
        result["release"] = report["release"]
    for key in ("hermesRoute", "chatbotReason"):
        if report.get(key):
            result[key] = report[key]
    return result


def _open(args, result):
    if args.no_open or not result.get("dashboard") or result["state"]["service"] != "running":
        return
    url = result["dashboard"]["url"]
    warnings = result["warnings"]
    headless = any(os.environ.get(k) for k in ("SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"))
    desktop = bool(os.environ.get("DISPLAY") or os.environ.get("WAYLAND_DISPLAY"))
    if headless or not desktop:
        if args.open:
            warnings.append("No usable local desktop; use the printed URL or SSH forwarding.")
        return
    if (args.json or args.non_interactive) and not args.open:
        return
    opener = shutil.which("xdg-open")
    if not opener:
        warnings.append("browser_open_failed: no browser opener; use the printed URL.")
        return
    try:
        # A launched browser may inherit the opener's streams and outlive it. Never capture them.
        opened = subprocess.run([opener, url], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                                stderr=subprocess.DEVNULL, timeout=15, check=False)
        if opened.returncode == 0:
            return
    except (OSError, subprocess.TimeoutExpired):
        pass
    warnings.append("browser_open_failed: use the printed URL; service remains available.")


def cmd_setup(args):
    result, _ = install.run_setup(args)
    if result["state"]["service"] == "running":
        if result["state"]["configuration"] == "setup_required":
            result["nextAction"] = {
                "code": "configure_models", "message": "Run aira dashboard --show-token on the host, sign in, and configure a model."
            }
        _open(args, result)
    return result


def cmd_dashboard(args, op):
    if args.show_token and (args.json or args.non_interactive or not sys.stdin.isatty() or not sys.stdout.isatty()):
        raise conflict_error("owner_auth_failed", "Credential reveal requires an interactive owner TTY.",
                             stage="dashboard", recovery="Use aira dashboard --show-token on the host, without JSON.")
    home, manifest, report = _report(args)
    result = _envelope("dashboard", op, report)
    if report["state"]["installation"] == "not_installed":
        raise operational_error("not_installed", "No installation was selected.", "discover", "Run aira setup.")
    if args.show_token:
        mode = report.get("mode")
        if mode == "standalone":
            token = install.read_owner_token(home / "data" / "standalone" / "owner.token")
        else:
            token = install.read_owner_token(install.legacy_token_file(), standalone=False)
        sys.stdout.write(token + "\n")
        return result
    if report["state"]["service"] != "running" or not report["dashboard"]:
        err = operational_error("service_stopped" if report["state"]["service"] == "stopped" else "health_timeout",
                                "The dashboard service is not available.", "dashboard",
                                "Run aira setup to resume, or aira doctor to diagnose.")
        return error_envelope("dashboard", op, err, report["state"], report["checks"],
                              report["warnings"], report["dashboard"])
    _open(args, result)
    return result


def cmd_restore(args, op):
    home, _ = install.resolve_home(args.home)
    manifest = install.read_manifest(home)
    if not manifest or manifest.mode != "standalone" or manifest.stage != "installed":
        raise conflict_error("capability_unavailable", "Restore needs an installed standalone service.")
    destination = install.canonical(args.destination)
    if destination == home or home in destination.parents or destination in home.parents:
        raise conflict_error("restore_refused", "The restore destination must be outside the live installation.")
    backup_id = backup._check_operation_id(args.backup_id)
    with install.DeployLock(home):
        backup.restore_backup(home / "data" / "deploy-recovery" / backup_id, destination)
    report = install.observe(home, manifest)
    result = _envelope("restore", op, report)
    result["backup"] = {"backupId": backup_id, "restoredCopy": True}
    return result


def main(argv=None, repo_root=None):
    raw = list(sys.argv[1:] if argv is None else argv)
    op = operations.new_operation_id()
    command = "cli"
    use_json = "--json" in raw
    try:
        args = build_parser().parse_args(raw)
        command = args.command or "cli"
        use_json = args.json
        args.repo_root = repo_root or launcher.repo_root_for(Path(__file__).resolve())
        if command == "setup":
            result = cmd_setup(args)
        elif command == "dashboard":
            result = cmd_dashboard(args, op)
        elif command == "status":
            _, _, report = _report(args)
            result = _envelope("status", op, report)
        elif command == "doctor":
            result = diagnostics.run_doctor(args, op)
        elif command == "logs":
            result = diagnostics.run_logs(args, op)
            if isinstance(result, int):
                return result
        elif command == "config":
            result = configure.run_config(args, op)
        elif command == "attach-hermes":
            result = hermes.run_attach(args, op)
        elif command == "update":
            home, _ = install.resolve_home(args.home)
            result = update.update_command(args, home, install.read_manifest(home), op)
        elif command == "restore":
            result = cmd_restore(args, op)
        else:
            raise args_error("Select a command.", "Run aira --help.")
    except CommandError as err:
        result = error_envelope(command, op, err)
    except KeyboardInterrupt:
        result = error_envelope(command, op, operational_error("operation_interrupted", "Operation interrupted.", command))
    except (OSError, ValueError, compose.RunError):
        result = error_envelope(command, op, operational_error("path_unwritable", "Installation state could not be read.",
                                                               command, "Check the selected installation and permissions."))
    reference = result["operationId"]
    component = {"setup": "setup", "update": "update", "restore": "update", "attach-hermes": "gateway"}.get(command, "cli")
    log = operations.log_event(component, reference,
                               result.get("error", {}).get("stage", command),
                               result.get("error", {}).get("code", "ok"), result["outcome"])
    if log is None:
        result["warnings"].append("The private operation log is unavailable.")
    return emit(result, use_json)


if __name__ == "__main__":
    sys.exit(main())
