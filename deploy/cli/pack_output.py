"""Human-readable rendering for pack command result payloads."""

import json
import sys


def _bool_word(value: object) -> str:
    return "true" if value else "false"


def _render_check_summary(prefix: str, info: dict) -> None:
    status = "ok" if info.get("ok") else "fail"
    tokens = info.get("promptTokens")
    ceiling = info.get("ceiling")
    ceiling_str = str(ceiling) if ceiling is not None else "-"
    token_str = f"{tokens}/{ceiling_str}" if tokens is not None else f"-/{ceiling_str}"
    sys.stdout.write(
        f"{prefix}: {status} (moods={info.get('moods', 0)} stickers={info.get('stickers', 0)} tokens={token_str})\n"
    )
    for fault in info.get("faults") or ():
        sys.stdout.write(f"  fault: {fault}\n")


def render_pack_human(pack_data: object) -> None:
    if not isinstance(pack_data, dict):
        sys.stdout.write("pack: " + json.dumps(pack_data, indent=2, sort_keys=True) + "\n")
        return
    action = pack_data.get("action")
    pack_id = pack_data.get("id") or "(unknown)"
    if action == "schema":
        sys.stdout.write("pack schema:\n")
        sys.stdout.write("setupPrompt:\n" + str(pack_data.get("setupPrompt", "")) + "\n")
        sys.stdout.write("schema: " + json.dumps(pack_data.get("schema"), indent=2, sort_keys=True) + "\n")
        return
    if action == "check":
        _render_check_summary(f"pack {pack_id}", pack_data)
        return
    if action == "get":
        sys.stdout.write(
            f"pack {pack_id}: source={pack_data.get('source', '?')} "
            f"writable={_bool_word(pack_data.get('writable'))} revision={pack_data.get('revision', '')}\n"
        )
        for doc_name in ("card", "moods", "lines"):
            sys.stdout.write(f"{doc_name}: " + json.dumps(pack_data.get(doc_name), indent=2, sort_keys=True) + "\n")
        return
    if action == "import":
        rev = f" revision={pack_data['revision']}" if pack_data.get("revision") else ""
        sys.stdout.write(
            f"pack import {pack_id}: dryRun={_bool_word(pack_data.get('dryRun'))} "
            f"changed={_bool_word(pack_data.get('changed'))}{rev}\n"
        )
        if "faults" in pack_data:
            _render_check_summary(f"check {pack_id}", pack_data)
        elif isinstance(pack_data.get("check"), dict):
            _render_check_summary(f"check {pack_id}", pack_data["check"])
        return
    if action == "update":
        rev = f" revision={pack_data['revision']}" if pack_data.get("revision") else ""
        sys.stdout.write(
            f"pack update {pack_id}: dryRun={_bool_word(pack_data.get('dryRun'))} "
            f"changed={_bool_word(pack_data.get('changed'))} "
            f"expectedRevision={pack_data.get('expectedRevision', '')}{rev}\n"
        )
        if "faults" in pack_data:
            _render_check_summary(f"check {pack_id}", pack_data)
            return
        if isinstance(pack_data.get("check"), dict):
            _render_check_summary(f"check {pack_id}", pack_data["check"])
        diff = pack_data.get("diff") or []
        if not diff:
            sys.stdout.write("diff: none (no changes)\n")
        else:
            for item in diff:
                sys.stdout.write(
                    f"  diff {item.get('path', '?')}: "
                    f"{json.dumps(item.get('old'), sort_keys=True)} -> {json.dumps(item.get('new'), sort_keys=True)}\n"
                )
        return
    if action == "try":
        if "faults" in pack_data:
            _render_check_summary(f"check {pack_id}", pack_data)
            return
        target = pack_data.get("id") or pack_data.get("target", "?")
        sys.stdout.write(
            f"pack try {target}: live={_bool_word(pack_data.get('live'))} mood={pack_data.get('mood', '?')}\n"
        )
        shape = pack_data.get("shape")
        shape_text = json.dumps(shape, sort_keys=True) if isinstance(shape, (dict, list)) else str(shape)
        sys.stdout.write(f"shape: {shape_text}\n")
        sys.stdout.write("reply:\n" + str(pack_data.get("reply", "")) + "\n")
        return
    sys.stdout.write("pack: " + json.dumps(pack_data, indent=2, sort_keys=True) + "\n")
