"""Host CLI character pack commands via the selected loopback owner API.

All reads, validation, previews, imports and revision-guarded updates run
through the owner API; no direct pack disk writes, raw provider calls, tokens
or raw drafts enter output or logs.
"""

from __future__ import annotations

import ipaddress
import json
import os
import re
import stat
from urllib.parse import urlsplit

from . import EXIT_CONFLICT, compose, configure, install
from .result import (
    CommandError,
    args_error,
    conflict_error,
    error_envelope,
    ok_envelope,
    operational_error,
)

PACK_SCHEMA_PATH = "/owner-api/core/pack/schema"
PACK_CHECK_PATH = "/owner-api/core/pack/check"
PACK_TRY_PATH = "/owner-api/core/pack/try"
CHARACTERS_PATH = "/owner-api/core/characters"

PACK_ID_RE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
REVISION_RE = re.compile(r"^[0-9a-f]{64}$")
MAX_PACK_FILE_BYTES = 768 * 1024
MAX_PACK_RESPONSE_BYTES = 4 * 1024 * 1024
API_TIMEOUT_S = 10
LIVE_TRY_TIMEOUT_S = 120

ALLOWED_ERROR_CODES = frozenset({
    "invalid_id",
    "invalid_pack",
    "preview_unavailable",
    "invalid_body",
    "invalid_json",
    "not_found",
    "pack_not_found",
    "pack_read_only",
    "pack_unparseable",
    "conflict",
    "stale_revision",
    "revision_required",
    "busy",
    "too_large",
    "body_too_large",
    "unsupported_media_type",
    "capability_unavailable",
    "owner_token_required",
    "origin_refused",
    "host_refused",
})


def _is_loopback_host(host: object) -> bool:
    if not isinstance(host, str) or not host:
        return False
    try:
        return ipaddress.ip_address(host.strip("[]")).is_loopback
    except ValueError:
        return False


def _is_loopback_base(base: object) -> bool:
    if not isinstance(base, str) or not base:
        return False
    try:
        parts = urlsplit(base)
        port = parts.port
    except ValueError:
        return False
    if parts.scheme != "http" or parts.username or parts.password or parts.query or parts.fragment:
        return False
    if port is None or not 1 <= port <= 65535 or parts.path not in ("", "/"):
        return False
    return _is_loopback_host(parts.hostname)


def _select_loopback_api(explicit_home: str | None) -> dict:
    """Select the running installation and enforce a loopback owner endpoint."""
    try:
        selection = configure.selected_api(explicit_home, need_running=True)
    except CommandError as err:
        if err.code == "owner_auth_failed" and err.exit_code != EXIT_CONFLICT:
            raise conflict_error("owner_auth_failed", err.message, stage="discover", recovery=err.recovery) from err
        raise
    if not isinstance(selection, dict):
        raise operational_error("not_installed", "No installation was selected.", "discover", "Run aira setup.")
    # The selected URL, not the legacy service's wildcard bind, is the credential destination.
    bindings = selection.get("bindings")
    if bindings is not None:
        if (
            not isinstance(bindings, dict)
            or 9890 not in bindings
            or not isinstance(bindings[9890], (tuple, list))
            or len(bindings[9890]) < 2
            or (not _is_loopback_host(bindings[9890][0])
                and not (selection.get("mode") == "legacy" and bindings[9890][0] in ("0.0.0.0", "::")))
        ):
            raise conflict_error(
                "port_conflict",
                "Pack owner requests require a loopback binding.",
                stage="discover",
                recovery="Bind the owner API to a loopback address or use SSH port forwarding.",
            )
    if not _is_loopback_base(selection.get("base")):
        raise conflict_error(
            "port_conflict",
            "Pack owner requests require a loopback owner endpoint.",
            stage="discover",
            recovery="Bind the owner API to a loopback address or use SSH port forwarding.",
        )
    return selection


def _observe_state(selection: dict) -> dict | None:
    if isinstance(selection.get("state"), dict):
        return selection["state"]
    home = selection.get("home")
    if home is None:
        return None
    return install.observe(home, selection.get("manifest"))["state"]


def _safe_error_code(status: int, body: object) -> str:
    if isinstance(body, dict) and isinstance(body.get("error"), str) and body["error"] in ALLOWED_ERROR_CODES:
        return body["error"]
    return f"http_{status}"


def _pack_api_call(
    selection: dict,
    method: str,
    path: str,
    body: dict | None = None,
    *,
    timeout_s: int = API_TIMEOUT_S,
    stage: str = "pack",
) -> dict:
    """Invoke the selected owner API via configure.api_request and map pack errors."""
    status, parsed, kind = configure.api_request(selection, method, path, body, timeout_s=timeout_s,
                                                      response_limit=MAX_PACK_RESPONSE_BYTES)
    if kind == "timeout":
        raise operational_error("owner_unreachable", "The owner API timed out.", stage,
                                "Check the service, then retry.", retryable=True)
    if kind in ("unreachable", "invalid_url"):
        raise operational_error("owner_unreachable", "The owner API is unreachable.", stage,
                                "Run aira setup to resume, or aira doctor to diagnose.", retryable=True)
    if kind == "too_large":
        raise operational_error("owner_unreachable", "The owner API response exceeded its size limit.", stage,
                                "Retry; if it repeats, run aira doctor.")
    if kind == "bad_json":
        raise operational_error("owner_unreachable", "The owner API gave an unreadable answer.", stage,
                                "Retry; if it repeats, run aira doctor.")
    if status in (401, 403):
        raise conflict_error("owner_auth_failed", "The owner credential was refused.", stage=stage,
                             recovery="Restore the verified owner credential; never rotate it implicitly.")
    code = _safe_error_code(status, parsed)
    if status == 404:
        if code == "pack_not_found" or (code == "not_found" and path.startswith(CHARACTERS_PATH + "/")):
            raise operational_error("not_found", "The requested character pack was not found.", stage,
                                    "Check the pack id and retry.")
        raise operational_error("capability_unavailable", "This install does not offer that pack operation.", stage,
                                "Upgrade the core image to use pack commands.")
    if status == 409:
        messages = {
            "stale_revision": ("The character pack changed since it was read.",
                               "Run aira pack get and retry with the current revision."),
            "conflict": ("A character pack with this id already exists.",
                         "Choose a new pack id or use aira pack update."),
            "pack_read_only": ("Repository packs are read-only.",
                               "Import an editable copy under a new id instead."),
            "pack_unparseable": ("The installed character pack could not be parsed.",
                                 "Repair the pack before editing it."),
            "busy": ("Another character pack write is in progress.", "Wait and retry."),
        }
        msg, rec = messages.get(code, ("The pack request conflicted with current state.",
                                       "Read the current pack state and retry."))
        raise conflict_error(code, msg, stage=stage, recovery=rec)
    if status == 428:
        raise conflict_error("revision_required", "An expected revision is required.", stage=stage,
                             recovery="Provide --expected-revision from aira pack get.")
    if status == 503 and code == "preview_unavailable":
        raise operational_error(code, "The preview could not complete.", stage,
                                "Check the configured model and retry; use scripted mode without --live.")
    if status == 503:
        raise conflict_error("capability_unavailable", "This install does not offer that operation.", stage=stage,
                             recovery="Check installation capabilities and retry.")
    if status == 400 and stage == "try" and code == "invalid_pack" and isinstance(parsed, dict):
        return parsed
    if status in (400, 413, 415):
        raise operational_error(code, "The owner API rejected the pack request.", stage,
                                "Check the draft format and size, then retry.")
    if status < 200 or status >= 300:
        raise operational_error(code, "The owner API request failed.", stage,
                                "Retry; if it repeats, run aira doctor.", retryable=True)
    if not isinstance(parsed, dict):
        raise operational_error("owner_unreachable", "The owner API returned an invalid response.", stage,
                                "Retry; if it repeats, run aira doctor.")
    return parsed


def _reject_constant(token: str) -> None:
    raise ValueError(f"non-finite JSON constant: {token}")


def _strict_object_pairs(pairs: list[tuple[str, object]]) -> dict:
    obj: dict = {}
    for key, value in pairs:
        if key in obj:
            raise ValueError("duplicate JSON key")
        obj[key] = value
    return obj


def _read_pack_file(raw_path: str, stage: str = "read", *, require_documents=True):
    """Read a bounded regular JSON file and validate the strict {card, moods, lines} envelope."""
    if not isinstance(raw_path, str) or not raw_path.strip():
        raise args_error("A pack file path is required.", "Provide a path to a pack JSON file.")
    try:
        fd = os.open(raw_path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    except OSError as exc:
        raise operational_error("pack_file_unreadable", "The pack JSON file could not be read.", stage,
                                "Use a readable regular JSON file within the size limit.") from exc
    try:
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if not stat.S_ISREG(info.st_mode):
                raise operational_error("pack_file_unreadable", "The pack path is not a regular file.", stage,
                                        "Provide a regular JSON file.")
            raw = handle.read(MAX_PACK_FILE_BYTES + 1)
    except CommandError:
        raise
    except OSError as exc:
        raise operational_error("pack_file_unreadable", "The pack JSON file could not be read.", stage,
                                "Check permissions and retry.") from exc
    if len(raw) > MAX_PACK_FILE_BYTES:
        raise operational_error("pack_file_too_large", "The pack JSON file exceeds the size limit.", stage,
                                "Reduce the pack JSON size and retry.")
    try:
        text = raw.decode("utf-8")
        parsed = json.loads(text, parse_constant=_reject_constant, object_pairs_hook=_strict_object_pairs)
    except (UnicodeError, ValueError, RecursionError) as exc:
        raise operational_error("invalid_pack_file", "The pack file is not valid strict JSON.", stage,
                                "Provide valid UTF-8 JSON with card, moods, and lines objects.") from exc
    if require_documents and (
        not isinstance(parsed, dict)
        or set(parsed) != {"card", "moods", "lines"}
        or any(not isinstance(parsed[k], dict) for k in ("card", "moods", "lines"))
    ):
        raise operational_error("invalid_pack_file",
                                "The pack file must be a JSON object with card, moods, and lines objects.",
                                stage, "Format the file with exact top-level keys card, moods, and lines.")
    return parsed


def _validate_pack_id(pack_id: object, *, from_args: bool, stage: str) -> str:
    if isinstance(pack_id, str) and PACK_ID_RE.fullmatch(pack_id):
        return pack_id
    if from_args:
        raise args_error("Invalid character pack id.",
                         "Use 1-64 lowercase letters, digits, hyphens, or underscores starting with a letter or digit.")
    raise operational_error("invalid_draft", "Draft card.id must be a valid pack id.", stage,
                            "Set a valid lowercase card.id and retry.")


def _json_equal(left: object, right: object) -> bool:
    if type(left) is not type(right):
        if isinstance(left, bool) or isinstance(right, bool):
            return False
        if isinstance(left, (int, float)) and isinstance(right, (int, float)):
            return left == right
        return False
    if isinstance(left, dict):
        return len(left) == len(right) and all(k in right and _json_equal(v, right[k]) for k, v in left.items())
    if isinstance(left, list):
        return len(left) == len(right) and all(_json_equal(a, b) for a, b in zip(left, right))
    return left == right


def _diff_object(old: dict, new: dict, prefix: str) -> tuple[dict, list[dict]]:
    """Compute RFC 7396 merge patch and displayed changes from the same object walk."""
    patch: dict = {}
    diff: list[dict] = []
    for key, value in old.items():
        path = f"{prefix}.{key}"
        if key not in new:
            patch[key] = None
            diff.append({"path": path, "old": value, "new": None})
        elif isinstance(value, dict) and isinstance(new[key], dict):
            nested_patch, nested_diff = _diff_object(value, new[key], path)
            if nested_patch:
                patch[key] = nested_patch
                diff.extend(nested_diff)
        elif not _json_equal(value, new[key]):
            patch[key] = new[key]
            diff.append({"path": path, "old": value, "new": new[key]})
    for key, value in new.items():
        if key not in old:
            patch[key] = value
            diff.append({"path": f"{prefix}.{key}", "old": None, "new": value})
    return patch, diff


def _diff_documents(current: dict, draft: dict) -> tuple[dict, list[dict]]:
    patch: dict = {}
    diff: list[dict] = []
    for name in ("card", "moods", "lines"):
        nested_patch, nested_diff = _diff_object(current[name], draft[name], name)
        if nested_patch:
            patch[name] = nested_patch
            diff.extend(nested_diff)
    return patch, diff


def _normalize_check(data: dict) -> dict:
    faults_raw = data.get("faults")
    if not isinstance(faults_raw, list) or not all(isinstance(item, str) for item in faults_raw):
        raise operational_error("owner_unreachable", "The owner API returned an invalid pack check payload.", "check")
    info = {
        "id": data.get("id") if isinstance(data.get("id"), str) else "",
        "ok": data.get("ok") is True and not faults_raw,
        "faults": list(faults_raw),
        "ceiling": data.get("ceiling"),
        "moods": data.get("moods", 0),
        "stickers": data.get("stickers", 0),
    }
    if "promptTokens" in data and data["promptTokens"] is not None:
        info["promptTokens"] = data["promptTokens"]
    return info


def _run_check(selection: dict, draft: object, *, existing_id: str | None = None, stage: str = "check") -> dict:
    payload: dict = {"draft": draft}
    if existing_id is not None:
        payload["existingId"] = existing_id
    data = _pack_api_call(selection, "POST", PACK_CHECK_PATH, payload, stage=stage)
    info = _normalize_check(data)
    if existing_id is not None and info["ok"]:
        normalized = data.get("normalizedCard")
        if not isinstance(normalized, dict) or normalized.get("id") != existing_id:
            raise operational_error("owner_unreachable", "The owner API returned an invalid normalized card.", stage)
        info["normalizedCard"] = normalized
    return info


def _invalid_draft_envelope(op: str, state: dict | None, pack_payload: dict, stage: str) -> dict:
    err = operational_error(
        "invalid_draft",
        "The character pack draft failed validation.",
        stage,
        "Fix every reported fault and rerun aira pack check.",
    )
    env = error_envelope("pack", op, err, state, [{"name": "pack_check", "ok": False, "reason": "invalid_draft"}])
    env["pack"] = pack_payload
    return env


def _is_file_target(target: str) -> bool:
    if target.lower().endswith(".json") or "/" in target or "\\" in target:
        return True
    return target in (".", "..") or target.startswith(".")


def _cmd_schema(args, op: str) -> dict:
    selection = _select_loopback_api(getattr(args, "home", None))
    data = _pack_api_call(selection, "GET", PACK_SCHEMA_PATH, stage="schema")
    if not isinstance(data.get("schema"), dict) or not isinstance(data.get("setupPrompt"), str):
        raise operational_error("owner_unreachable", "The owner API returned an invalid schema response.", "schema")
    env = ok_envelope("pack", op, _observe_state(selection))
    env["pack"] = {
        "action": "schema",
        "schema": data["schema"],
        "setupPrompt": data["setupPrompt"],
    }
    return env


def _cmd_check(args, op: str) -> dict:
    draft = _read_pack_file(args.file, stage="check", require_documents=False)
    selection = _select_loopback_api(getattr(args, "home", None))
    check_info = _run_check(selection, draft, stage="check")
    state = _observe_state(selection)
    payload = {"action": "check", **check_info}
    if not check_info["ok"]:
        return _invalid_draft_envelope(op, state, payload, "check")
    env = ok_envelope("pack", op, state, [{"name": "pack_check", "ok": True}])
    env["pack"] = payload
    return env


def _cmd_get(args, op: str) -> dict:
    pack_id = _validate_pack_id(args.id, from_args=True, stage="get")
    selection = _select_loopback_api(getattr(args, "home", None))
    data = _pack_api_call(selection, "GET", f"{CHARACTERS_PATH}/{pack_id}/studio", stage="get")
    if (
        not isinstance(data.get("id"), str)
        or not isinstance(data.get("source"), str)
        or not isinstance(data.get("writable"), bool)
        or not isinstance(data.get("revision"), str)
        or any(not isinstance(data.get(k), dict) for k in ("card", "moods", "lines"))
    ):
        raise operational_error("owner_unreachable", "The owner API returned an invalid studio pack.", "get")
    env = ok_envelope("pack", op, _observe_state(selection))
    env["pack"] = {
        "action": "get",
        "id": data["id"],
        "source": data["source"],
        "writable": data["writable"],
        "revision": data["revision"],
        "card": data["card"],
        "moods": data["moods"],
        "lines": data["lines"],
    }
    return env


def _write_receipt(data: dict, pack_id: str, stage: str) -> dict:
    if (data.get("id") != pack_id or not isinstance(data.get("revision"), str)
            or not REVISION_RE.fullmatch(data["revision"]) or not isinstance(data.get("changed"), bool)):
        raise operational_error("owner_unreachable", "The owner API returned an invalid write receipt.", stage,
                                "Read the pack with aira pack get before retrying.")
    return {key: data[key] for key in ("id", "revision", "changed")}


def _cmd_import(args, op: str) -> dict:
    draft = _read_pack_file(args.file, stage="import")
    selection = _select_loopback_api(getattr(args, "home", None))
    check_info = _run_check(selection, draft, stage="import")
    state = _observe_state(selection)
    if not check_info["ok"]:
        payload = {"action": "import", "dryRun": bool(args.dry_run), "changed": False, **check_info}
        return _invalid_draft_envelope(op, state, payload, "import")
    pack_id = _validate_pack_id(draft["card"].get("id"), from_args=False, stage="import")
    chars_data = _pack_api_call(selection, "GET", CHARACTERS_PATH, stage="import")
    characters = chars_data.get("characters")
    faults = chars_data.get("faults", [])
    if not isinstance(characters, list) or not isinstance(faults, list):
        raise operational_error("owner_unreachable", "The owner API returned an invalid characters list.", "import")
    existing_ids = {
        item["id"]
        for group in (characters, faults)
        for item in group
        if isinstance(item, dict) and isinstance(item.get("id"), str)
    }
    if pack_id in existing_ids:
        raise conflict_error("conflict", f"Character pack '{pack_id}' already exists.", stage="import",
                             recovery="Choose a new pack id or use aira pack update.")
    check_summary = {k: v for k, v in check_info.items() if k != "id"}
    if args.dry_run:
        env = ok_envelope("pack", op, state)
        env["pack"] = {
            "action": "import",
            "id": pack_id,
            "dryRun": True,
            "changed": False,
            "wouldCreate": True,
            "check": check_summary,
        }
        return env
    created = _pack_api_call(
        selection,
        "POST",
        CHARACTERS_PATH,
        {"id": pack_id, "card": draft["card"], "moods": draft["moods"], "lines": draft["lines"]},
        stage="import",
    )
    env = ok_envelope("pack", op, state)
    env["pack"] = {
        "action": "import",
        **_write_receipt(created, pack_id, "import"),
        "dryRun": False,
        "check": check_summary,
    }
    return env


def _cmd_update(args, op: str) -> dict:
    expected_rev = args.expected_revision
    if not isinstance(expected_rev, str) or not REVISION_RE.fullmatch(expected_rev):
        raise args_error("A valid expected revision is required.", "Provide --expected-revision from aira pack get.")
    draft = _read_pack_file(args.file, stage="update")
    pack_id = _validate_pack_id(draft["card"].get("id"), from_args=False, stage="update")
    selection = _select_loopback_api(getattr(args, "home", None))
    studio_path = f"{CHARACTERS_PATH}/{pack_id}/studio"
    current = _pack_api_call(selection, "GET", studio_path, stage="update")
    if (
        not isinstance(current.get("revision"), str)
        or not current["revision"]
        or not isinstance(current.get("writable"), bool)
        or any(not isinstance(current.get(k), dict) for k in ("card", "moods", "lines"))
    ):
        raise operational_error("owner_unreachable", "The owner API returned an invalid studio pack.", "update")
    if not current["writable"]:
        raise conflict_error("pack_read_only", f"Character pack '{pack_id}' is read-only.", stage="update",
                             recovery="Import an editable copy under a new id instead.")
    if current["revision"] != expected_rev:
        raise conflict_error("stale_revision", f"Character pack '{pack_id}' changed since it was read.",
                             stage="update", recovery="Run aira pack get and retry with the current revision.")
    check_info = _run_check(selection, draft, existing_id=pack_id, stage="update")
    state = _observe_state(selection)
    if not check_info["ok"]:
        payload = {
            "action": "update",
            "dryRun": bool(args.dry_run),
            "changed": False,
            "expectedRevision": expected_rev,
            **check_info,
        }
        return _invalid_draft_envelope(op, state, payload, "update")
    draft = {**draft, "card": check_info.pop("normalizedCard")}
    patch_body, diff = _diff_documents(current, draft)
    check_summary = {k: v for k, v in check_info.items() if k != "id"}
    if args.dry_run:
        env = ok_envelope("pack", op, state)
        env["pack"] = {
            "action": "update",
            "id": pack_id,
            "dryRun": bool(args.dry_run),
            "changed": False,
            "expectedRevision": expected_rev,
            "revision": current["revision"],
            "diff": diff,
            "check": check_summary,
        }
        return env
    updated = _pack_api_call(
        selection,
        "PUT",
        studio_path,
        {"expectedRevision": expected_rev, "patch": patch_body},
        stage="update",
    )
    env = ok_envelope("pack", op, state)
    env["pack"] = {
        "action": "update",
        **_write_receipt(updated, pack_id, "update"),
        "dryRun": False,
        "expectedRevision": expected_rev,
        "diff": diff,
        "check": check_summary,
    }
    return env


def _cmd_try(args, op: str) -> dict:
    if not isinstance(args.message, str) or not args.message.strip():
        raise args_error("A test message is required.", "Provide a non-empty message for aira pack try.")
    if not isinstance(args.target, str) or not args.target:
        raise args_error("A pack id or JSON file path is required.", "Provide a pack id or file path.")
    is_file = _is_file_target(args.target)
    draft = None
    if is_file:
        draft = _read_pack_file(args.target, stage="try")
        body: dict = {"draft": draft, "message": args.message, "live": bool(args.live)}
    else:
        pack_id = _validate_pack_id(args.target, from_args=True, stage="try")
        body = {"id": pack_id, "message": args.message, "live": bool(args.live)}
    selection = _select_loopback_api(getattr(args, "home", None))
    timeout_s = LIVE_TRY_TIMEOUT_S if args.live else API_TIMEOUT_S
    data = _pack_api_call(selection, "POST", PACK_TRY_PATH, body, timeout_s=timeout_s, stage="try")
    if data.get("ok") is False:
        return _invalid_draft_envelope(op, _observe_state(selection),
                                       {"action": "try", **_normalize_check(data)}, "try")
    if not isinstance(data.get("mood"), str) or not isinstance(data.get("reply"), str) or data.get("shape") is None:
        raise operational_error("owner_unreachable", "The owner API returned an invalid preview response.", "try")
    pack_payload: dict = {
        "action": "try",
        "target": args.target,
        "source": "file" if is_file else "id",
        "live": bool(data.get("live", args.live)),
        "mood": data["mood"],
        "shape": data["shape"],
        "reply": data["reply"],
    }
    if not is_file:
        pack_payload["id"] = args.target
    elif draft is not None and isinstance(draft["card"].get("id"), str):
        pack_payload["id"] = draft["card"]["id"]
    env = ok_envelope("pack", op, _observe_state(selection))
    env["pack"] = pack_payload
    return env


_DISPATCH = {
    "schema": _cmd_schema,
    "check": _cmd_check,
    "get": _cmd_get,
    "import": _cmd_import,
    "update": _cmd_update,
    "try": _cmd_try,
}


def run_pack(args, operation_id: str) -> dict:
    """Run one `aira pack` subcommand. Returns the stable CLI result envelope."""
    command = getattr(args, "pack_command", None)
    handler = _DISPATCH.get(command)
    try:
        if handler is None:
            raise args_error("Select a pack command.", "Use check, schema, get, import, update or try.")
        return handler(args, operation_id)
    except CommandError as err:
        return error_envelope("pack", operation_id, err)
    except compose.RunError:
        return error_envelope("pack", operation_id, operational_error(
            "docker_unreachable", "Docker state could not be verified.", "pack",
            "Run aira doctor and retry."))
    except (OSError, ValueError):
        return error_envelope("pack", operation_id, operational_error(
            "path_unwritable", "Installation state could not be read.", "pack",
            "Check the selected installation and permissions."))
