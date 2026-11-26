"""Typed standalone and legacy configuration operations.

Reads and writes model and character configuration through the selected
owner API at its actual binding. No legacy credential fallback, no paid
model probe, no raw secret or URL in any result, log or error.
"""

from __future__ import annotations

import getpass
import json
import math
import re
import sys
import time
import warnings
from urllib.parse import urlencode, urlsplit

from . import compose, install, operations
from .result import (
    CommandError, args_error, conflict_error, error_envelope, ok_envelope,
    operational_error,
)

STANDALONE_CONFIG_PATH = "/owner-api/core/standalone-config"
STANDALONE_ACTIVATE_PATH = "/owner-api/core/standalone-config/activate"
SETTINGS_PATH = "/owner-api/core/settings"
DEPLOYMENT_SETTINGS_PATH = "/owner-api/core/deployment-settings"
CONFIG_PATH = "/owner-api/core/config"

ROLES = ("main", "fallback", "media")
MAIN_PROVIDERS = ("anthropic", "openai-compatible")
PROVIDERS = (*MAIN_PROVIDERS, "gemini")
LEVELS = ("global", "type", "chat")
TYPE_SCOPES = ("dm", "group")

PRICE_ARGS = (
    ("input_price", "usdPerMTokIn"),
    ("output_price", "usdPerMTokOut"),
    ("cached_price", "usdPerMTokCached"),
)

EFFORTS = ("low", "medium", "high", "xhigh", "max")
LOOPBACK_HOSTS = {"localhost", "127.0.0.1", "::1", "host.docker.internal"}
OWN_ROUTE_PORTS = {9881, 9890}

SECRET_KEY_NAMES = {
    "apikey", "api_key", "token", "secret", "password", "passwd",
    "credential", "credentials", "authorization", "cookie", "ref",
}

ACTIVATE_POLL_SECONDS = 60
ACTIVATE_POLL_INTERVAL_S = 2
KEY_STDIN_MAX_BYTES = 4096


def sanitize(value):
    """Drop secret-named keys and reduce URLs to origins. Never raises."""
    if isinstance(value, dict):
        clean = {}
        for key, item in value.items():
            if isinstance(key, str) and key.lower() in SECRET_KEY_NAMES:
                continue
            clean[key] = sanitize(item)
        return clean
    if isinstance(value, list):
        return [sanitize(item) for item in value]
    if isinstance(value, str) and "://" in value:
        try:
            parts = urlsplit(value)
            if parts.scheme in ("http", "https") and parts.hostname:
                host = parts.hostname
                if ":" in host:
                    host = f"[{host}]"
                if parts.port:
                    host = f"{host}:{parts.port}"
                return f"{parts.scheme}://{host}"
        except ValueError:
            pass
    return value


def error_code(status, body):
    allowed = {"stale_revision", "activation_in_progress", "activation_busy", "model_config_invalid",
               "activation_failed", "revision_required", "unknown_character", "invalid_value", "invalid_scope",
               "capability_unavailable", "configuration_unavailable", "invalid_settings", "setting_invalid"}
    if isinstance(body, dict) and isinstance(body.get("error"), str) and body["error"] in allowed:
        return body["error"]
    return f"http_{status}"


def check_response(selector, status, body, kind):
    """Raise a stable error for a failed owner API call."""
    if kind == "timeout":
        raise operational_error("owner_unreachable", f"The owner API at {selector} timed out.",
                                "config", "Check the service, then retry.", retryable=True)
    if kind in ("unreachable", "invalid_url"):
        raise operational_error("owner_unreachable", f"The owner API at {selector} is unreachable.",
                                "config", "Run aira setup to resume, or aira doctor to diagnose.",
                                retryable=True)
    if kind == "too_large":
        raise operational_error("owner_unreachable", f"The owner API at {selector} returned too much.",
                                "config", "Retry; if it repeats, run aira doctor.")
    if kind == "bad_json":
        raise operational_error("owner_unreachable", f"The owner API at {selector} gave an unreadable answer.",
                                "config", "Retry; if it repeats, run aira doctor.")
    code = error_code(status, body)
    if status in (401, 403):
        raise operational_error("owner_auth_failed", "The owner credential was refused.",
                                "config", "Restore the verified owner credential; never rotate it implicitly.")
    if status == 404:
        raise operational_error("capability_unavailable", "This install does not offer that operation.",
                                "config", "Use the dashboard for operations this install does not expose.")
    if status == 409:
        if code in ("stale_revision", "stale"):
            raise conflict_error("stale_revision", "The configuration changed since it was read.",
                                 stage="config",
                                 recovery="Read the configuration again and retry with the fresh revision.")
        if code in ("activation_in_progress", "activation_busy"):
            raise conflict_error("activation_in_progress", "A configuration activation is already running.",
                                 stage="config", recovery="Wait for it to finish, then check the readback.")
        raise conflict_error(code, "The configuration write was refused as conflicting.",
                             stage="config", recovery="Read the current state and retry.")
    if status == 503:
        raise conflict_error("capability_unavailable", "This install does not offer that operation.",
                             stage="config",
                             recovery="Use the dashboard for operations this install does not expose.")
    if status == 400:
        raise conflict_error(code, "The configuration write was refused.",
                             stage="config", recovery="Correct the value and retry.")
    raise operational_error(code, "The owner API request failed.", "config",
                            "Retry; if it repeats, run aira doctor.", retryable=True)


def selected_api(explicit_home=None, need_running=True):
    """Resolve the selected install to an authenticated owner API base.

    Uses the actual observed port binding only. Raises CommandError when
    the install is missing, has no project, has no mapping, or (when
    need_running) has no running service.
    """
    home, _ = install.resolve_home(explicit_home)
    manifest = install.read_manifest(home)
    if not install.looks_like_install(home):
        raise operational_error("not_installed", "No installation was selected.",
                                "discover", "Run aira setup.")
    if manifest is not None and manifest.mode == "standalone":
        mode = "standalone"
    elif manifest is not None:
        mode = manifest.mode
    else:
        known = compose.parse_env_file(home / ".env")
        if known.get("AIRA_INSTALL_MODE") == "standalone":
            raise operational_error("config_invalid", "Standalone files exist without their manifest.",
                                    "discover",
                                    "Restore the install metadata from backup; do not adopt as legacy.")
        mode = "legacy"
    try:
        project = install._project(home, manifest)
    except CommandError:
        raise
    except compose.RunError as exc:
        raise operational_error("docker_unreachable", "Docker state could not be verified.",
                                "discover", "Run aira doctor and retry.") from exc
    if not project:
        raise operational_error("repair_required", "No existing Compose project was found.",
                                "discover",
                                "Inspect the installation; no automatic project replacement.")
    try:
        entries = compose.ps_entries(home, project)
        bindings = compose.published_bindings(home, project)
    except compose.RunError as exc:
        raise operational_error("docker_unreachable", "Docker state could not be verified.",
                                "discover", "Run aira doctor and retry.") from exc
    if 9890 not in bindings:
        if need_running or not compose.service_running(entries):
            raise operational_error("service_stopped", "The service is not running.",
                                    "discover", "Run aira setup to resume, or aira doctor to diagnose.")
        raise operational_error("repair_required", "The actual dashboard mapping is unavailable.",
                                "discover", "Inspect the chosen Compose project.")
    if need_running and not compose.service_running(entries):
        raise operational_error("service_stopped", "The service is not running.",
                                "discover", "Run aira setup to resume, or aira doctor to diagnose.")
    if mode == "standalone":
        if any(binding[0] != "127.0.0.1" for binding in bindings.values()):
            raise conflict_error("port_conflict", "Standalone owner requests require private loopback bindings.")
        token = install.read_owner_token(home / "data" / "standalone" / "owner.token")
    else:
        token = install.read_owner_token(install.legacy_token_file(), standalone=False)
    return {
        "home": home, "manifest": manifest, "mode": mode, "project": project,
        "bindings": bindings, "token": token,
        "base": install.url_for(bindings[9890], ""),
    }


def api_request(selection, method, path, body=None, timeout_s=10):
    headers = {"X-TolongAI-Token": selection["token"], "Accept": "application/json"}
    raw = None
    if body is not None:
        raw = json.dumps(body).encode("utf-8")
        headers["Content-Type"] = "application/json"
    status, content, kind = compose.http_request(
        selection["base"].rstrip("/") + path, timeout_s, headers, method, raw)
    parsed = None
    if kind == "ok" and content:
        try:
            parsed = json.loads(content)
        except (ValueError, UnicodeError):
            return status, None, "bad_json"
    return status, parsed, kind


def api_call(selection, method, path, body=None, timeout_s=10):
    status, parsed, kind = api_request(selection, method, path, body, timeout_s)
    if kind != "ok" or status < 200 or status >= 300:
        check_response("the selected owner API", status, parsed, kind)
    return parsed if isinstance(parsed, dict) else {}


def readback(selection, timeout_s=10):
    status, parsed, kind = api_request(selection, "GET", STANDALONE_CONFIG_PATH, timeout_s=timeout_s)
    if kind != "ok" or status < 200 or status >= 300:
        check_response("the selected owner API", status, parsed, kind)
    if not isinstance(parsed, dict):
        raise operational_error("owner_unreachable", "The configuration readback was unreadable.",
                                "config", "Retry; if it repeats, run aira doctor.")
    return parsed


def strip_credentials(role_value):
    if not isinstance(role_value, dict):
        return None
    fields = ("provider", "model", "baseUrl", "effort", "deepEffort",
              "usdPerMTokIn", "usdPerMTokOut", "usdPerMTokCached")
    return {k: role_value[k] for k in fields if k in role_value}


def valid_base_url(value):
    try:
        parts = urlsplit(value)
        port = parts.port
    except ValueError:
        return False
    if parts.scheme not in ("http", "https") or not parts.hostname:
        return False
    if parts.username or parts.password or parts.query or parts.fragment:
        return False
    if parts.hostname.lower() in LOOPBACK_HOSTS and port in OWN_ROUTE_PORTS:
        return False
    return True


def check_effort(provider, name, value):
    if value is None:
        return None
    if not isinstance(value, str) or len(value) > 64:
        raise args_error(f"An effort must be a short name: {name}.",
                         "Use low, medium, high, xhigh or max for anthropic roles.")
    return value


def read_key(args):
    if args.clear_key:
        if args.key_stdin or args.prompt_key:
            raise args_error("Key options conflict.",
                             "Use one of --key-stdin, --prompt-key or --clear-key.")
        return None, True
    if args.key_stdin and args.prompt_key:
        raise args_error("Key options conflict.",
                         "Use one of --key-stdin or --prompt-key.")
    if args.key_stdin:
        data = sys.stdin.buffer.read(KEY_STDIN_MAX_BYTES + 1)
        if len(data) > KEY_STDIN_MAX_BYTES:
            raise args_error("The key input exceeds its bound.", "Provide the key within its limit.")
        try:
            text = data.decode("utf-8").strip()
        except UnicodeError as exc:
            raise args_error("The key input is not valid text.", "Provide the key again.") from exc
        if "\n" in text or "\r" in text or "\0" in text:
            raise args_error("The key input must be one line.", "Provide the key again.")
        return (text or None), False
    if args.prompt_key:
        if not sys.stdin.isatty():
            raise conflict_error("owner_auth_failed", "A key prompt needs an interactive TTY.",
                                 stage="args", recovery="Use --key-stdin from a pipe instead.")
        try:
            with warnings.catch_warnings():
                warnings.simplefilter("error", getpass.GetPassWarning)
                text = getpass.getpass("Model API key (empty keeps the current key): ").strip()
        except (OSError, ValueError, EOFError, getpass.GetPassWarning) as exc:
            raise args_error("The key prompt failed.", "Use --key-stdin instead.") from exc
        if len(text.encode("utf-8")) > KEY_STDIN_MAX_BYTES or any(c in text for c in "\r\n\0"):
            raise args_error("The key input is invalid.", "Provide a single bounded key.")
        return (text or None), False
    return None, False


def parse_price(name, value):
    if value is None:
        return None
    try:
        number = float(value)
    except (TypeError, ValueError) as exc:
        raise args_error(f"A price must be a number: {name}.",
                         "Use a nonnegative USD value per million tokens.") from exc
    if not math.isfinite(number) or number < 0:
        raise args_error(f"A price must be nonnegative: {name}.",
                         "Use a nonnegative USD value per million tokens.")
    return number


def build_target(args, saved_role):
    if args.role == "media":
        if (any(getattr(args, name) is not None for name in ("base_url", "effort", "deep_effort"))
                or any(getattr(args, name, None) is not None for name, _ in PRICE_ARGS)):
            raise args_error("The media role has no base, effort or pricing options.",
                             "Use --provider gemini and --model.")
        if args.provider is not None and args.provider != "gemini":
            raise args_error("The media role requires Gemini.", "Use --provider gemini.")
        if args.disable:
            return None
        model = (args.model or "").strip()
        if args.provider != "gemini" or not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,255}", model):
            raise args_error("The media role requires Gemini and a valid bare model id.",
                             "Use --provider gemini --model MODEL.")
        return {"provider": "gemini", "model": model}
    if args.provider is not None and args.provider not in MAIN_PROVIDERS:
        raise args_error("Unknown provider.", "Use anthropic or openai-compatible.")
    if args.disable:
        return None
    if not args.provider:
        raise args_error("A provider is required.", "Use anthropic or openai-compatible.")
    if not args.model:
        raise args_error("A model id is required.", "Provide --model for the selected role.")
    if args.base_url is None or not valid_base_url(args.base_url):
        raise args_error("The base URL must be absolute HTTP(S) without credentials.",
                         "Provide --base-url without user, query or fragment.")
    base = {"effort": "", "deepEffort": "", "usdPerMTokIn": 0, "usdPerMTokOut": 0, "usdPerMTokCached": 0}
    if isinstance(saved_role, dict):
        base.update(saved_role)
    base["provider"] = args.provider
    base["model"] = args.model
    if args.base_url is not None:
        if not valid_base_url(args.base_url):
            raise args_error("The base URL must be absolute HTTP(S) without credentials.",
                             "Provide an https origin without user, query or fragment.")
        base["baseUrl"] = args.base_url
    effort = check_effort(args.provider, "effort", args.effort)
    if effort is not None:
        base["effort"] = effort
    deep = check_effort(args.provider, "deep_effort", args.deep_effort)
    if deep is not None:
        base["deepEffort"] = deep
    for arg_name, key in PRICE_ARGS:
        number = parse_price(arg_name, getattr(args, arg_name, None))
        if number is not None:
            base[key] = number
    if base.get("provider") == "openai-compatible" and not base.get("baseUrl"):
        raise args_error("An openai-compatible role needs a base URL.",
                         "Provide --base-url for the selected role.")
    return base


def cmd_get(selection, args, readings):
    if selection["mode"] == "standalone":
        data = readback(selection)
        readings["config"] = sanitize(data)
        state = install.observe(selection["home"], selection["manifest"])["state"]
        return ok_envelope("config", args.operation_id, state, [], [], None)
    settings = api_call(selection, "GET", DEPLOYMENT_SETTINGS_PATH)
    config = api_call(selection, "GET", CONFIG_PATH)
    readings["config"] = sanitize({"deploymentSettings": settings, "config": config})
    state = install.observe(selection["home"], selection["manifest"])["state"]
    return ok_envelope("config", args.operation_id, state, [], [], None)


def cmd_set_model(selection, args, readings):
    if selection["mode"] != "standalone":
        raise conflict_error("capability_unavailable",
                             "Model writes are not supported on legacy installs.",
                             stage="config",
                             recovery="Edit models in the dashboard; the CLI writes models on standalone only.")
    if args.role not in ROLES:
        raise args_error("A role is required.", "Use --role main, fallback or media.")
    if args.disable and (args.key_stdin or args.prompt_key or args.clear_key):
        raise args_error("Key options do not apply with --disable.", "Drop the key option.")
    def require_media(current):
        if args.role == "media" and current.get("optionalRoles") != ["media"]:
            raise conflict_error("capability_unavailable", "This core does not advertise the media role.",
                                 stage="config", recovery="Upgrade the selected core before configuring media.")
    if args.role == "media":
        require_media(readback(selection))
        # Reject invalid targets before reading a private key or holding the deploy lock.
        build_target(args, None)
    key, clearing = read_key(args)
    with install.DeployLock(selection["home"]):
        current = readback(selection)
        require_media(current)
        saved = current.get("saved") or {}
        expected = args.expected_revision if args.expected_revision is not None else current.get("savedRevision")
        target = build_target(args, strip_credentials(saved.get(args.role)))
        if target is not None:
            if key is not None:
                target["apiKey"] = key
            elif clearing:
                target["apiKey"] = None
        pair = {role: strip_credentials(saved.get(role)) for role in ("main", "fallback")}
        pair[args.role] = target
        result = api_call(selection, "PUT", STANDALONE_CONFIG_PATH,
                          {"expectedRevision": expected, **pair})
        actual = readback(selection)
        readings["config"] = sanitize(actual)
        if not result.get("savedRevision") or result["savedRevision"] != actual.get("savedRevision"):
            raise operational_error("stale_revision", "The saved revision did not match readback.", "config",
                                    "Read the configuration again before applying.")
        readings["savedRevision"] = result["savedRevision"]
    state = install.observe(selection["home"], selection["manifest"])["state"]
    return ok_envelope("config", args.operation_id, state, [], [], None)


def cmd_activate(selection, args, readings):
    if selection["mode"] != "standalone":
        raise conflict_error("capability_unavailable",
                             "Model activation is not supported on legacy installs.",
                             stage="config",
                             recovery="Apply model changes in the dashboard on legacy installs.")
    with install.DeployLock(selection["home"]):
        current = readback(selection)
        expected = args.expected_revision or current.get("savedRevision")
        if not expected:
            raise operational_error("stale_revision", "No saved revision is available to activate.",
                                    "config", "Save a model revision first, then activate it.")
        if (current.get("savedRevision") == current.get("appliedRevision")
                and current.get("appliedRevision") == expected
                and current.get("activation") in (None, "idle")):
            readings["config"] = sanitize(current)
            readings["appliedRevision"] = expected
        else:
            accepted = api_call(selection, "POST", STANDALONE_ACTIVATE_PATH,
                                {"expectedRevision": expected})
            readings["config"] = sanitize(accepted)
        deadline = time.monotonic() + ACTIVATE_POLL_SECONDS
        while (remaining := deadline - time.monotonic()) > 0:
            try:
                latest = readback(selection, timeout_s=min(remaining, 5))
            except CommandError as err:
                if err.code != "owner_unreachable":
                    raise
            else:
                readings["config"] = sanitize(latest)
                if latest.get("appliedRevision") == expected and latest.get("activation") == "idle" and not latest.get("lastFailure"):
                    readings["appliedRevision"] = expected
                    state = install.observe(selection["home"], selection["manifest"])["state"]
                    return ok_envelope("config", args.operation_id, state, [], [], None)
                if latest.get("lastFailure") and latest.get("activation") == "idle":
                    raise operational_error("activation_failed", "The core reported an activation failure.",
                                            "activate", "Run aira config get to verify the previous applied revision, then retry after correcting the saved configuration.")
            time.sleep(min(ACTIVATE_POLL_INTERVAL_S, max(0, deadline - time.monotonic())))
    raise operational_error("activation_failed",
                            "Activation did not reach the applied readback in time.",
                            "activate",
                            "The restart may still finish. Run aira config get to check the applied revision before retrying.")


def check_scope(args):
    if args.level not in LEVELS:
        raise args_error("A level is required.", "Use --level global, type or chat.")
    scope = args.scope or ""
    if args.level == "global":
        if scope:
            raise args_error("A global write takes no scope.", "Omit --scope for --level global.")
        return ""
    if args.level == "type":
        if scope not in TYPE_SCOPES:
            raise args_error("A type scope is required.", "Use --scope dm or group.")
        return scope
    if not scope:
        raise args_error("A chat scope is required.", "Use --scope with the chat id.")
    return scope


def scoped_revision(selection, level, scope):
    query = urlencode({"level": level, "scope": scope})
    data = api_call(selection, "GET", f"{SETTINGS_PATH}?{query}")
    for key in ("settingsRevision", "revision", "expectedRevision"):
        value = data.get(key)
        if isinstance(value, str) and value:
            return value
    raise operational_error("stale_revision", "No settings revision is available to edit.",
                            "config", "Reload the chat settings, then retry.")


def cmd_set_character(selection, args, readings):
    if not args.pack:
        raise args_error("A character pack id is required.", "Provide --pack with the pack id.")
    scope = check_scope(args)
    with install.DeployLock(selection["home"]):
        expected = args.expected_revision or scoped_revision(selection, args.level, scope)
        result = api_call(selection, "PUT", SETTINGS_PATH,
                          {"level": args.level, "scope": scope, "key": "character",
                           "value": args.pack, "expectedRevision": expected})
        readings["setting"] = sanitize(result)
    state = install.observe(selection["home"], selection["manifest"])["state"]
    return ok_envelope("config", args.operation_id, state, [], [], None)


def run_config(args, operation_id):
    """Run one typed config command. Returns the result envelope."""
    args.operation_id = operation_id
    readings = {}
    try:
        command = getattr(args, "config_command", None)
        if command not in ("get", "set-model", "activate", "set-character"):
            raise args_error("Select a config command.",
                             "Use get, set-model, activate or set-character.")
        selection = selected_api(getattr(args, "home", None), need_running=True)
        if command == "get":
            result = cmd_get(selection, args, readings)
        elif command == "set-model":
            result = cmd_set_model(selection, args, readings)
        elif command == "activate":
            result = cmd_activate(selection, args, readings)
        else:
            result = cmd_set_character(selection, args, readings)
        result.update(readings)
    except CommandError as err:
        result = error_envelope("config", operation_id, err)
    except compose.RunError:
        result = error_envelope("config", operation_id, operational_error(
            "docker_unreachable", "Docker state could not be verified.", "config",
            "Run aira doctor and retry."))
    except (OSError, ValueError):
        result = error_envelope("config", operation_id, operational_error(
            "path_unwritable", "Installation state could not be read.", "config",
            "Check the selected installation and permissions."))
    result.update(readings)
    return result
