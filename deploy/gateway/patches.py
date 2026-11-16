#!/usr/bin/env python3
"""AIRA's own patches to the pinned gateway (docs/trd/system.md#gateway-patches).

The gateway's older patches are applied by the reapply script that lives with the old core. This script holds the
patches AIRA owns: the new `sticker-media-type`, the four edits that had no entry anywhere, and two removals. Run it
after the old script, on the same tree:

    deploy/gateway/patches.py --hermes-agent ~/.hermes-staging/hermes-agent --check
    deploy/gateway/patches.py --hermes-agent ~/.hermes-staging/hermes-agent
    deploy/gateway/patches.py --hermes-agent PATH --only sticker-media-type

Rules, the same as the old script's:

- Anchor-based. Every anchor must be found exactly once before anything is written, or the patch stops and says so.
- Idempotent. A patch whose mark is already in place is reported as applied and left alone.
- Verified. The file is backed up, edited, syntax-checked and tested. A failed check restores the backup.

A removal is applied when its mark is absent. Standard library only, for the gateway's Python 3.11.
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from datetime import datetime
from pathlib import Path

BRIDGE = "scripts/whatsapp-bridge"
ADAPTER = "plugins/platforms/whatsapp/adapter.py"

STICKER_TEST = '''import asyncio
from plugins.platforms.whatsapp.adapter import WhatsAppAdapter
adapter = object.__new__(WhatsAppAdapter)
seen = []
async def fake(chat_id, path, kind, caption=None, *rest):
    seen.append((kind, caption))
adapter._send_media_to_bridge = fake
for path in ("/data/characters/x/stickers/a.webp", "/data/pictures/a.webp", "/data/stickers/a.png"):
    asyncio.run(adapter.send_image_file("chat", path, "words"))
assert seen == [("sticker", None), ("image", "words"), ("image", "words")], seen
'''


def patches() -> list[dict]:
    """Every patch, in the order it is applied. Paths are relative to the gateway tree."""
    py = ["{python}", "-m", "py_compile", "{target}"]
    node = ["node", "--check", "{target}"]
    return [
        {
            "name": "sticker-media-type",
            "target": ADAPTER,
            "present": "[aira] sticker-media-type",
            "edits": (('''        """Send a local image file natively via bridge."""
        return await self._send_media_to_bridge(chat_id, image_path, "image", caption)
''',
                       '''        """Send a local image file natively via bridge."""
        # [aira] sticker-media-type: a .webp under a stickers/ folder goes to the
        # bridge as a sticker, which WhatsApp shows as a native sticker. Any other
        # image is sent as before. A sticker carries no caption.
        _parts = os.path.normpath(str(image_path)).split(os.sep)
        if str(image_path).lower().endswith(".webp") and "stickers" in _parts[:-1]:
            return await self._send_media_to_bridge(chat_id, image_path, "sticker", None)
        return await self._send_media_to_bridge(chat_id, image_path, "image", caption)
'''),),
            "syntax": py,
            "tests": [["{python}", "-c", STICKER_TEST]],
            "cwd": ".",
            "why": "a pack sticker reached the chat as a photo, not as a sticker",
        },
        {
            "name": "aira-edit-jitter",
            "target": "gateway/stream_consumer.py",
            "present": "[aira-jitter]",
            "edits": (
        ('''
logger = logging.getLogger("gateway.stream_consumer")

# Sentinel to signal the stream is complete
_DONE = object()
_NEW_SEGMENT = object()
''',
         '''
logger = logging.getLogger("gateway.stream_consumer")



def _aira_jittered_interval(base):  # [aira-jitter]
    """Uniform jitter around the configured edit interval.

    Range comes from AIRA_EDIT_MIN / AIRA_EDIT_MAX (seconds). Defaults to
    2.5-3.0s: still visibly progressive, but no two gaps are identical, so the
    edit stream does not read as a metronome to WhatsApp's classifiers.
    """
    import os as _os
    import random as _random
    try:
        lo = float(_os.environ.get("AIRA_EDIT_MIN", "2.5"))
        hi = float(_os.environ.get("AIRA_EDIT_MAX", "3.0"))
    except ValueError:
        lo, hi = 2.5, 3.0
    if hi < lo:
        lo, hi = hi, lo
    if lo <= 0:
        return base
    return _random.uniform(lo, hi)

# Sentinel to signal the stream is complete
_DONE = object()
_NEW_SEGMENT = object()
'''),
        ('''        # the stream task through a longer flood cooldown before retrying.
        self._max_fallback_flood_retry_seconds = 5.0
        self._flood_strikes = 0         # Consecutive flood-control edit failures
        self._current_edit_interval = self.cfg.edit_interval  # Adaptive backoff
        self._final_response_sent = False
        # Set when the final response content was sent to the user via
        # streaming, even if the final edit (cursor removal etc.)
''',
         '''        # the stream task through a longer flood cooldown before retrying.
        self._max_fallback_flood_retry_seconds = 5.0
        self._flood_strikes = 0         # Consecutive flood-control edit failures
        self._current_edit_interval = _aira_jittered_interval(
            self.cfg.edit_interval)  # [aira-jitter]
        self._final_response_sent = False
        # Set when the final response content was sent to the user via
        # streaming, even if the final edit (cursor removal etc.)
'''),
        ('''                            self._last_sent_text = text
                        # Successful edit — reset flood strike counter
                        self._flood_strikes = 0
                        return True
                    else:
                        immediate_final_fallback = False
''',
         '''                            self._last_sent_text = text
                        # Successful edit — reset flood strike counter
                        self._flood_strikes = 0
                        self._current_edit_interval = _aira_jittered_interval(
                            self.cfg.edit_interval)  # [aira-jitter]
                        return True
                    else:
                        immediate_final_fallback = False
'''),
    ),
            "syntax": py,
            "tests": [["{python}", "-m", "pytest", "tests/gateway/test_stream_consumer.py", "-q"]],
            "cwd": ".",
            "why": "streamed edits went out at one fixed interval",
        },
        {
            "name": "inbound-sticker-as-photo",
            "target": ADAPTER,
            "present": "A WhatsApp sticker is a WebP image, so it belongs on the PHOTO",
            "edits": (
        ('''            if media_type in {"location", "live_location"}:
                msg_type = MessageType.LOCATION
            elif media_type == "sticker":
                msg_type = MessageType.STICKER
            elif data.get("hasMedia"):
                if "image" in media_type:
                    msg_type = MessageType.PHOTO
''',
         '''            if media_type in {"location", "live_location"}:
                msg_type = MessageType.LOCATION
            elif media_type == "sticker":
                # A WhatsApp sticker is a WebP image, so it belongs on the PHOTO
                # path — that is the branch that records the real MIME in
                # media_types, and vision picks attachments by MIME, not by
                # message type.
                #
                # MessageType.STICKER is produced by three adapters and consumed
                # by none, so a sticker matched no branch below and ended up as
                # media_types=["unknown"]. _event_media_is_image rejects that, so
                # the sticker was never sent to vision and the turn was described
                # to the agent as "a document ... a binary format such as PDF or
                # DOCX ... extract the document's text yourself". For a sticker.
                # It deflected because that is what it was told it had.
                msg_type = MessageType.PHOTO
            elif data.get("hasMedia"):
                if "image" in media_type:
                    msg_type = MessageType.PHOTO
'''),
    ),
            "syntax": py,
            "tests": [],
            "cwd": ".",
            "why": "a sticker a member sent was described to the model as an unreadable document",
        },
        {
            "name": "standalone-send-trim",
            "target": ADAPTER,
            "present": "_outgoing = text.strip()",
            "edits": (
        ('''            # 1) Text first (skip the /send call when this chunk is media-only
            #    or when the text is delivered as the media caption instead).
            if text.strip() and not media_caption:
                async with session.post(
                    f"http://localhost:{bridge_port}/send",
                    json={"chatId": normalized_chat_id, "message": text},
''',
         '''            # 1) Text first (skip the /send call when this chunk is media-only
            #    or when the text is delivered as the media caption instead).
            if text.strip() and not media_caption:
                # Guard the boundary, not just the producers. This condition
                # already tested `text.strip()` while sending the RAW text, so
                # any leading blank lines upstream went straight to the phone and
                # cost two lines of screen on every message.
                #
                # The router has a tidy() that exists for this, but several
                # early-return paths bypass it, and leading whitespace in a chat
                # bubble is never intentional — so it is normalised here, at the
                # last point before the wire, where no future leak can get past.
                # Logged when it fires so the upstream producer is identifiable
                # instead of merely suppressed.
                _outgoing = text.strip()
                if _outgoing != text:
                    print("[whatsapp] trimmed whitespace before send: "
                          f"{len(text) - len(_outgoing)} char(s), "
                          f"leading={text[:6]!r}", flush=True)
                text = _outgoing
                async with session.post(
                    f"http://localhost:{bridge_port}/send",
                    json={"chatId": normalized_chat_id, "message": text},
'''),
    ),
            "syntax": py,
            "tests": [],
            "cwd": ".",
            "why": "a standalone send carried leading blank lines to the phone",
        },
        {
            "name": "view-once-v2-extension",
            "target": BRIDGE + "/bridge_helpers.js",
            "present": "viewOnceMessageV2Extension",
            "edits": (
        ('''  if (content.ephemeralMessage?.message) return content.ephemeralMessage.message;
  if (content.viewOnceMessage?.message) return content.viewOnceMessage.message;
  if (content.viewOnceMessageV2?.message) return content.viewOnceMessageV2.message;
  if (content.documentWithCaptionMessage?.message) return content.documentWithCaptionMessage.message;
  if (content.templateMessage?.hydratedTemplate) return content.templateMessage.hydratedTemplate;
  if (content.buttonsMessage) return content.buttonsMessage;
''',
         '''  if (content.ephemeralMessage?.message) return content.ephemeralMessage.message;
  if (content.viewOnceMessage?.message) return content.viewOnceMessage.message;
  if (content.viewOnceMessageV2?.message) return content.viewOnceMessageV2.message;
  if (content.viewOnceMessageV2Extension?.message) return content.viewOnceMessageV2Extension.message;
  if (content.documentWithCaptionMessage?.message) return content.documentWithCaptionMessage.message;
  if (content.templateMessage?.hydratedTemplate) return content.templateMessage.hydratedTemplate;
  if (content.buttonsMessage) return content.buttonsMessage;
'''),
    ),
            "syntax": node,
            "tests": [["node", "bridge.native.test.mjs"], ["node", "bridge.aira.test.mjs"]],
            "cwd": BRIDGE,
            "why": "a view-once message in the newer wrapper arrived empty",
        },
        {
            "name": "remove-aira-trace",
            "target": BRIDGE + "/bridge.js",
            "absent": "[aira-trace]",
            "edits": (
        ("  next();\n});\n\n// [aira-trace] log every outbound call so message fragmentation can be measured\napp.use((req, res, next) => {\n  if (req.method === 'POST' && (req.path === '/send' || req.path === '/edit')) {\n    const b = req.body || {};\n    const len = (b.message || '').length;\n    try {\n      appendFileSync('/tmp/aira-bridge-trace.log', JSON.stringify({\n        path: req.path, len,\n        messageId: b.messageId || null,\n        head: (b.message || '').slice(0, 40).replace(/\\n/g, '\\\\n'),\n        t: Date.now(),\n      }) + '\\n');\n    } catch (e) {}\n  }\n  next();\n});\n\n// Poll for new messages (long-poll style)\napp.get('/messages', (req, res) => {\n  const msgs = messageQueue.splice(0, messageQueue.length);\n",
         '''  next();
});

// Poll for new messages (long-poll style)
app.get('/messages', (req, res) => {
  const msgs = messageQueue.splice(0, messageQueue.length);
'''),
    ),
            "syntax": node,
            "tests": [["node", "bridge.native.test.mjs"], ["node", "bridge.aira.test.mjs"]],
            "cwd": BRIDGE,
            "why": "the bridge wrote the start of every outgoing message to /tmp",
        },
        {
            "name": "remove-reply-prefix-test",
            "target": "tests/gateway/test_reply_to_injection.py",
            "absent": "That quote is NOT the request",
            "edits": (
        ('''    )

    assert result is not None
    # The pointer now follows their words instead of preceding them. Prepended,
    # it put up to 500 chars of a DIFFERENT, older message at the top of the turn
    # and the agent answered THAT — a quoted reminder request got answered while
    # the typed "translate this" underneath it was ignored. The disambiguation
    # this test protects is unchanged; only the order and the labelling moved.
    assert result.startswith("What's the best time to go?")
    assert '"Japan is great for culture, food, and efficiency."' in result
    assert "That quote is NOT the request" in result

@pytest.mark.asyncio
async def test_reply_prefix_still_injected_when_text_in_history():
''',
         '''    )

    assert result is not None
    assert result.startswith(
        '[Replying to: "Japan is great for culture, food, and efficiency."]'
    )
    assert result.endswith("What's the best time to go?")


@pytest.mark.asyncio
async def test_reply_prefix_still_injected_when_text_in_history():
'''),
        ('''    )

    assert result is not None
    assert result.startswith("What's the best time to go?")
    assert quoted in result
    assert "That quote is NOT the request" in result


''',
         '''    )

    assert result is not None
    assert result.startswith(f'[Replying to: "{quoted}"]')
    assert result.endswith("What's the best time to go?")


'''),
    ),
            "syntax": py,
            "tests": [["{python}", "-m", "pytest", "tests/gateway/test_reply_to_injection.py", "-q"]],
            "cwd": ".",
            "why": "the test expected a quote order the gateway no longer writes, and failed",
        },
    ]


def _argv(cmd: list[str], tree: Path, target: Path, python: str) -> list[str]:
    return [part.replace("{python}", python).replace("{target}", str(target)) for part in cmd]


def is_applied(patch: dict, text: str) -> bool:
    if "present" in patch:
        return patch["present"] in text
    return patch["absent"] not in text


def apply_patch(patch: dict, tree: Path, *, check_only: bool, python: str) -> bool:
    """Applies one patch. True when it is in place afterwards."""
    name = patch["name"]
    target = tree / patch["target"]
    if not target.exists():
        print(f"  {name}: TARGET MISSING: {target}")
        return False
    text = target.read_text(encoding="utf-8")
    if is_applied(patch, text):
        print(f"  {name}: already applied")
        return True
    print(f"  {name}: ABSENT ({patch['why']})")
    if check_only:
        return False

    # Every anchor is checked before anything is written: a partial edit neither works nor looks broken.
    for i, (find, _) in enumerate(patch["edits"], 1):
        count = text.count(find)
        if count != 1:
            print(f"  {name}: ABORT: anchor {i} found {count} times, expected 1. "
                  f"Upstream changed {target.name}; re-derive this patch by hand. Nothing was written.")
            return False

    backup = target.with_name(target.name + f".bak-{datetime.now():%Y%m%d-%H%M%S}")
    shutil.copy2(target, backup)
    out = text
    for find, replace in patch["edits"]:
        out = out.replace(find, replace, 1)
    target.write_text(out, encoding="utf-8")

    def revert(reason: str) -> bool:
        shutil.copy2(backup, target)
        print(f"  {name}: FAILED ({reason}), restored from {backup.name}")
        return False

    cwd = tree / patch["cwd"]
    for cmd in [patch["syntax"], *patch["tests"]]:
        argv = _argv(cmd, tree, target, python)
        try:
            run = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=300)
        except (OSError, subprocess.TimeoutExpired) as error:
            return revert(f"{argv[0]}: {error}")
        if run.returncode != 0:
            tail = (run.stdout + run.stderr).strip().splitlines()[-3:]
            return revert(" | ".join(tail) or f"exit {run.returncode}")
    print(f"  {name}: applied, syntax and tests OK (backup {backup.name})")
    return True


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hermes-agent", metavar="PATH", required=True, type=Path,
                        help="the gateway tree to patch, for example ~/.hermes-staging/hermes-agent")
    parser.add_argument("--check", action="store_true", help="report only")
    parser.add_argument("--only", metavar="NAME", help="apply one patch")
    parser.add_argument("--python", default=None,
                        help="the interpreter for checks and tests (default: the tree's venv, else this one)")
    args = parser.parse_args(argv)
    tree = args.hermes_agent.expanduser().resolve()
    if not (tree / "gateway").is_dir():
        print(f"not a gateway tree: {tree}")
        return 2
    venv = tree / "venv" / "bin" / "python"
    python = args.python or (str(venv) if venv.exists() else sys.executable)
    chosen = [p for p in patches() if args.only in (None, p["name"])]
    if not chosen:
        print(f"no patch named {args.only}")
        return 2
    print(f"{tree}:")
    results = [apply_patch(p, tree, check_only=args.check, python=python) for p in chosen]
    return 0 if all(results) else 1


if __name__ == "__main__":
    sys.exit(main())
