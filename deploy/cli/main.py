"""Portable command surface. All host actions remain outside the core."""

from __future__ import annotations

import argparse
import os
import shutil
import sys
from pathlib import Path

from . import __version__, compose, install, launcher, operations
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
        code, _, _ = compose.run([opener, url], timeout_s=15)
        if code != 0:
            raise compose.RunError("failed")
    except compose.RunError:
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
    log = operations.log_event("setup" if command == "setup" else "cli", reference,
                               result.get("error", {}).get("stage", command),
                               result.get("error", {}).get("code", "ok"), result["outcome"])
    if log is None:
        result["warnings"].append("The private operation log is unavailable.")
    return emit(result, use_json)


if __name__ == "__main__":
    sys.exit(main())
