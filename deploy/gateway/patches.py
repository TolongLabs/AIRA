#!/usr/bin/env python3
"""AIRA's own patches to the pinned gateway (docs/trd/system.md#gateway-patches).

The gateway's older patches are applied by the reapply script that lives with the old core. This script holds the
patches AIRA owns: the new `sticker-media-type` and `reply-to-bot-ids`, the four edits that had no entry anywhere, and two removals. Run it
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


REPLY_TEST = '''from gateway.platforms.whatsapp_common import WhatsAppBehaviorMixin as M
m = object.__new__(M)
bots = ["1234:12@s.whatsapp.net", "9876:3@lid"]
assert m._message_is_reply_to_bot({"quotedParticipant": "9876@lid", "botIds": bots})
assert m._message_is_reply_to_bot({"quotedParticipant": "1234@s.whatsapp.net", "botIds": bots})
assert m._message_is_reply_to_bot({"quotedParticipant": "9876:3@lid", "botIds": bots})
assert not m._message_is_reply_to_bot({"quotedParticipant": "5555@lid", "botIds": bots})
assert not m._message_is_reply_to_bot({"quotedParticipant": "", "botIds": bots})
assert not m._message_is_reply_to_bot({"quotedParticipant": "9876@lid", "botIds": []})
'''


VOICE_FROM_CORE_TEST = '''import json, os, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(os.path.expanduser(os.environ.get("HERMES_HOME", "~/.hermes"))) / "scripts"))
from brain import chatflags
with tempfile.TemporaryDirectory() as d:
    (Path(d) / "gateway").mkdir()
    (Path(d) / "gateway" / "chats.json").write_text(
        json.dumps({"version": 1, "chats": {"0000000000@lid": {"voice": "all", "reactions": True}}}),
        encoding="utf-8",
    )
    os.environ["AIRA_HOST_DATA_DIR"] = d
    assert chatflags.voice_mode("0000000000@lid") == "all"
    assert chatflags.voice_mode("1234567890@s.whatsapp.net") == "off"
'''


NAME_CALL_FROM_CORE_TEST = '''import json, os, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(os.path.expanduser(os.environ.get("HERMES_HOME", "~/.hermes"))) / "scripts"))
from brain import chatflags
from gateway.platforms.whatsapp_common import WhatsAppBehaviorMixin as M
with tempfile.TemporaryDirectory() as d:
    (Path(d) / "gateway").mkdir()
    (Path(d) / "gateway" / "chats.json").write_text(
        json.dumps({
            "version": 1,
            "chats": {
                "0000000000@g.us": {"names": ["Taiga"]},
                "12345678901@g.us": {"free": True},
            },
        }),
        encoding="utf-8",
    )
    os.environ["AIRA_HOST_DATA_DIR"] = d
    assert chatflags.names("0000000000@g.us") == ["Taiga"]
    assert chatflags.names("123456789012@g.us") == []
    assert chatflags.free("12345678901@g.us") is True
    assert chatflags.free("0000000000@g.us") is False
    m = object.__new__(M)
    m._mention_patterns = []
    m._is_broadcast_chat = lambda _: False
    m._is_group_allowed = lambda _: True
    m._whatsapp_free_response_chats = lambda: set()
    m._whatsapp_require_mention = lambda: True
    m._message_is_reply_to_bot = lambda _: False
    m._message_mentions_bot = lambda _: False
    assert m._message_matches_mention_patterns({"chatId": "0000000000@g.us", "body": "TAIGA, hi"})
    assert not m._message_matches_mention_patterns({"chatId": "0000000000@g.us", "body": "taigabox"})
    assert m._should_process_message({"chatId": "0000000000@g.us", "isGroup": True, "body": "hey taiga!"})
    assert not m._should_process_message({"chatId": "0000000000@g.us", "isGroup": True, "body": "hello"})
    assert m._should_process_message({"chatId": "12345678901@g.us", "isGroup": True, "body": "hello"})
    assert not m._should_process_message({"chatId": "123456789012@g.us", "isGroup": True, "body": "taiga"})
'''


PASSIVE_REACTIONS_TEST = '''import sys, types
from gateway.platforms.whatsapp_common import WhatsAppBehaviorMixin as M
seen = []
fake_brain = types.ModuleType("brain")
fake_reactions = types.ModuleType("brain.reactions")
fake_reactions.react_to = lambda data: seen.append(data)
fake_brain.reactions = fake_reactions
sys.modules["brain"] = fake_brain
sys.modules["brain.reactions"] = fake_reactions
m = object.__new__(M)
m._mention_patterns = []
m._is_broadcast_chat = lambda _: False
m._is_group_allowed = lambda _: True
m._whatsapp_free_response_chats = lambda: set()
m._whatsapp_require_mention = lambda: True
m._message_is_reply_to_bot = lambda _: False
m._message_mentions_bot = lambda _: False
m._message_matches_mention_patterns = lambda d: "wakeword" in str(d.get("body") or "").lower()
unaddressed = {"chatId": "0000000000@g.us", "isGroup": True, "body": "making ramen"}
addressed = {"chatId": "12345678901@g.us", "isGroup": True, "body": "hey wakeword"}
assert m._should_process_message(unaddressed) is False
assert seen == [unaddressed]
assert m._should_process_message(addressed) is True
assert seen == [unaddressed]
def boom(_data):
    raise RuntimeError("boom")
fake_reactions.react_to = boom
assert m._should_process_message(unaddressed) is False
'''

AUTOFETCH_TEST = '''import ast, sys, types
tree = ast.parse(open(sys.argv[1], encoding="utf-8").read())
fn = next(n for n in tree.body if isinstance(n, ast.FunctionDef) and n.name == "_aira_autofetch")
scope = {}
exec(compile(ast.Module(body=[fn], type_ignores=[]), "adapter", "exec"), scope)
fake_brain = types.ModuleType("brain")
fake = types.ModuleType("brain.autofetch")
fake.offer = lambda adapter, data: None
fake_brain.autofetch = fake
sys.modules["brain"] = fake_brain
sys.modules["brain.autofetch"] = fake
assert scope["_aira_autofetch"]() is fake
'''

DM_AUTOFETCH_TEST = r'''import ast, sys
from pathlib import Path
from types import SimpleNamespace
tree = ast.parse(Path(sys.argv[1]).read_text())
# Exercise the installed adapter's gate and both offer calls without importing or starting the real gateway.
gate = next(n for n in ast.walk(tree) if isinstance(n, ast.If)
            and "_should_process_message" in ast.unparse(n.test)
            and any(isinstance(c, ast.Call) and getattr(c.func, "attr", None) == "offer" for c in ast.walk(n)))
block = next(n.body for n in ast.walk(tree) if isinstance(getattr(n, "body", None), list) and gate in n.body)
index = block.index(gate)
snippet = "def dispatch(self, data):\n" + "\n".join("    " + line for stmt in block[index:index + 3]
           for line in ast.unparse(stmt).splitlines()) + "\n    return 'normal reply'"
seen = []
af = SimpleNamespace(offer=lambda adapter, data, **kwargs: seen.append(kwargs))
scope = {"_aira_autofetch": lambda: af}
exec(snippet, scope)
assert scope["dispatch"](SimpleNamespace(_should_process_message=lambda data: True), {"isGroup": False}) == "normal reply"
assert seen == [{"accepted": True}], seen
seen.clear()
assert scope["dispatch"](SimpleNamespace(_should_process_message=lambda data: False), {"isGroup": True}) is None
assert seen == [{}], seen
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
            "name": "reply-to-bot-ids",
            "target": "gateway/platforms/whatsapp_common.py",
            "present": "[aira] reply-to-bot-ids",
            "edits": (('''        quoted_participant = self._normalize_whatsapp_id(data.get("quotedParticipant"))
        if not quoted_participant:
            return False
        return quoted_participant in self._bot_ids_from_message(data)
''',
                       '''        quoted_participant = self._normalize_whatsapp_id(data.get("quotedParticipant"))
        if not quoted_participant:
            return False
        # [aira] reply-to-bot-ids: the bridge keeps a device suffix on the bot's own ids, which normalising turns
        # into 1234@12@lid, while a quote names the bot as 1234@lid. Compare the user part only, as the mention
        # check does, so a reply to the bot in a group reaches the bot.
        def _bare(value):
            return str(value).split("@", 1)[0].split(":", 1)[0]

        return _bare(quoted_participant) in {_bare(b) for b in self._bot_ids_from_message(data) if b}
'''),),
            "syntax": py,
            "tests": [["{python}", "-c", REPLY_TEST]],
            "cwd": ".",
            "why": "a reply to the bot in a group was not seen as addressed to it, so the bot never answered",
        },
        {
            "name": "cron-tick-10s",
            "target": "gateway/run.py",
            "present": "[aira] cron-tick-10s",
            "edits": (
        ('''    if isinstance(cron_provider, InProcessCronScheduler):
        cron_start_kwargs["can_dispatch"] = lambda: not (
''',
         '''    if isinstance(cron_provider, InProcessCronScheduler):
        # [aira] cron-tick-10s: AIRA's reminders are one-time jobs; a 60 s tick made them up to a minute late.
        cron_start_kwargs["interval"] = 10
        cron_start_kwargs["can_dispatch"] = lambda: not (
'''),
    ),
            "syntax": py,
            "tests": [],
            "cwd": ".",
            "why": "the in-process cron ticker polled every 60 s, so a reminder could fire up to a minute late",
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
        {
            "name": "voice-from-core",
            "target": "gateway/run.py",
            "targets": ("gateway/run.py", "gateway/platforms/base.py"),
            "present": "[aira] voice-from-core",
            "edits": (
        ('''        chat_id = event.source.chat_id
        voice_key = self._voice_key(event.source.platform, chat_id)
        voice_mode = self._voice_mode.get(voice_key)
        is_voice_input = (event.message_type == MessageType.VOICE)
''',
         '''        chat_id = event.source.chat_id
        voice_key = self._voice_key(event.source.platform, chat_id)
        voice_mode = self._voice_mode.get(voice_key)
        # [aira] voice-from-core: WhatsApp voice mode comes from the core's chats.json.
        if str(getattr(event.source.platform, "value", event.source.platform) or "").lower() == "whatsapp":
            try:
                from brain import chatflags
                voice_mode = chatflags.voice_mode(chat_id)
            except Exception:
                voice_mode = "off"
        is_voice_input = (event.message_type == MessageType.VOICE)
'''),
        ('''        if chat_id in self._auto_tts_enabled_chats:
''',
         '''        # [aira] voice-from-core: WhatsApp auto-TTS follows the core's chats.json.
        if str(getattr(getattr(self, "platform", None), "value", getattr(self, "platform", None)) or "").lower() == "whatsapp":
            try:
                from brain import chatflags
                return chatflags.voice_mode(chat_id) == "all"
            except Exception:
                return False
        elif chat_id in self._auto_tts_enabled_chats:
'''),
    ),
            "syntax": py,
            "tests": [["{python}", "-c", VOICE_FROM_CORE_TEST]],
            "cwd": ".",
            "why": "WhatsApp voice mode was stored in gateway state instead of following the core's chats.json",
        },
        {
            "name": "name-call-from-core",
            "target": "gateway/platforms/whatsapp_common.py",
            "present": "[aira] name-call-from-core",
            "edits": (
        ('''    def _message_matches_mention_patterns(self, data: Dict[str, Any]) -> bool:
        if not self._mention_patterns:
            return False
        body = str(data.get("body") or "")
        return any(pattern.search(body) for pattern in self._mention_patterns)
''',
         '''    def _message_matches_mention_patterns(self, data: Dict[str, Any]) -> bool:
        body = str(data.get("body") or "")
        if self._mention_patterns and any(pattern.search(body) for pattern in self._mention_patterns):
            return True
        # [aira] name-call-from-core: also wake on the chat's own name-call names from chats.json.
        chat_id = str(data.get("chatId") or "")
        if not chat_id or not body:
            return False
        try:
            from brain import chatflags
            chat_names = chatflags.names(chat_id)
        except Exception:
            return False
        return any(
            name and re.search(rf"(?<![^\\W_]){re.escape(name)}(?![^\\W_])", body, re.IGNORECASE)
            for name in chat_names
        )
'''),
        ('''        # Group messages: check mention / free-response settings
        chat_id = str(data.get("chatId") or "")
        if chat_id in self._whatsapp_free_response_chats():
            return True
        if not self._whatsapp_require_mention():
            return True
''',
         '''        # Group messages: check mention / free-response settings
        chat_id = str(data.get("chatId") or "")
        if chat_id in self._whatsapp_free_response_chats():
            return True
        # [aira] name-call-from-core: wake on every message in a group with free: true in chats.json.
        try:
            from brain import chatflags
            if chatflags.free(chat_id):
                return True
        except Exception:
            pass
        if not self._whatsapp_require_mention():
            return True
'''),
    ),
            "syntax": py,
            "tests": [["{python}", "-c", NAME_CALL_FROM_CORE_TEST]],
            "cwd": ".",
            "why": "per-chat name-call names and free-response groups live in the core's chats.json",
        },
        {
            "name": "name-call-only-from-core",
            "target": "gateway/platforms/whatsapp_common.py",
            "present": "[aira] name-call-only-from-core",
            "edits": (
        ('''        if self._mention_patterns and any(pattern.search(body) for pattern in self._mention_patterns):
            return True
        # [aira] name-call-from-core:''',
         '''        # [aira] name-call-only-from-core: the global patterns no longer wake a WhatsApp chat. Only the names the
        # core lists for a chat with name call on do, so a chat with it off never shows typing for a name.
        # [aira] name-call-from-core:'''),
    ),
            "syntax": py,
            "tests": [],
            "cwd": ".",
            "why": "the global name patterns woke every group, so a chat with name call off showed typing and sent nothing",
        },
        {
            "name": "passive-reactions",
            "target": "gateway/platforms/whatsapp_common.py",
            "present": "[aira] passive-reactions",
            "edits": (
        ('''        if self._message_is_reply_to_bot(data):
            return True
        if self._message_mentions_bot(data):
            return True
        return self._message_matches_mention_patterns(data)
''',
         '''        if self._message_is_reply_to_bot(data):
            return True
        if self._message_mentions_bot(data):
            return True
        # [aira] passive-reactions: unaddressed group messages still reach brain.reactions.
        if self._message_matches_mention_patterns(data):
            return True
        try:
            from brain import reactions
            reactions.react_to(data)
        except Exception:
            pass
        return False
'''),
    ),
            "syntax": py,
            "tests": [["{python}", "-c", PASSIVE_REACTIONS_TEST]],
            "cwd": ".",
            "why": "unaddressed group messages never reached brain.reactions",
        },
        {
            "name": "autofetch-from-core",
            "target": ADAPTER,
            "present": "[aira] autofetch-from-core",
            "edits": (('''        import importlib
        return importlib.import_module("hermes_plugins.social.autofetch")
''',
                       '''        # [aira] autofetch-from-core: the core reads the post links and
        # brain.autofetch sends their media (docs/trd/system.md#autofetch).
        import importlib
        return importlib.import_module("brain.autofetch")
'''),),
            "syntax": py,
            "tests": [["{python}", "-c", AUTOFETCH_TEST, "{target}"]],
            "cwd": ".",
            "why": "the old core's plugin sent a Threads avatar and one image of six",
        },
        {
            "name": "autofetch-dm",
            "target": ADAPTER,
            "present": "[aira] autofetch-dm",
            "edits": (('''                    _af.offer(self, data)
                return None

            # Determine message type
''',
                       '''                    _af.offer(self, data)
                return None

            # [aira] autofetch-dm: accepted DMs can fetch media while the reply continues.
            _af = _aira_autofetch()
            if _af is not None:
                _af.offer(self, data, accepted=True)

            # Determine message type
'''),),
            "syntax": py,
            "tests": [["{python}", "-c", DM_AUTOFETCH_TEST, "{target}"]],
            "cwd": ".",
            "why": "an accepted DM never reached brain.autofetch; only dropped group messages were offered",
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
    edit_targets = list(patch.get("targets") or [patch["target"]] * len(patch["edits"]))
    unique_rels = list(dict.fromkeys(edit_targets))
    files = {rel: tree / rel for rel in unique_rels}
    for rel, target in files.items():
        if not target.exists():
            print(f"  {name}: TARGET MISSING: {target}")
            return False
    texts = {rel: target.read_text(encoding="utf-8") for rel, target in files.items()}
    if all(is_applied(patch, texts[rel]) for rel in unique_rels):
        print(f"  {name}: already applied")
        return True
    print(f"  {name}: ABSENT ({patch['why']})")
    if check_only:
        return False

    # Every anchor is checked before anything is written: a partial edit neither works nor looks broken.
    for i, (rel, (find, _)) in enumerate(zip(edit_targets, patch["edits"]), 1):
        count = texts[rel].count(find)
        if count != 1:
            print(f"  {name}: ABORT: anchor {i} found {count} times, expected 1. "
                  f"Upstream changed {files[rel].name}; re-derive this patch by hand. Nothing was written.")
            return False

    stamp = f".bak-{datetime.now():%Y%m%d-%H%M%S-%f}"
    backups = {}
    outs = dict(texts)
    for rel, target in files.items():
        backup = target.with_name(target.name + stamp)
        shutil.copy2(target, backup)
        backups[rel] = backup
    for rel, (find, replace) in zip(edit_targets, patch["edits"]):
        outs[rel] = outs[rel].replace(find, replace, 1)
    for rel, target in files.items():
        target.write_text(outs[rel], encoding="utf-8")

    def revert(reason: str) -> bool:
        for rel, target in files.items():
            shutil.copy2(backups[rel], target)
        backup_names = ", ".join(b.name for b in backups.values())
        print(f"  {name}: FAILED ({reason}), restored from {backup_names}")
        return False

    cwd = tree / patch["cwd"]
    syntax_cmds = [_argv(patch["syntax"], tree, files[rel], python) for rel in unique_rels]
    test_cmds = [_argv(cmd, tree, files[unique_rels[0]], python) for cmd in patch["tests"]]
    for argv in [*syntax_cmds, *test_cmds]:
        try:
            run = subprocess.run(argv, cwd=cwd, capture_output=True, text=True, timeout=300)
        except (OSError, subprocess.TimeoutExpired) as error:
            return revert(f"{argv[0]}: {error}")
        if run.returncode != 0:
            tail = (run.stdout + run.stderr).strip().splitlines()[-3:]
            return revert(" | ".join(tail) or f"exit {run.returncode}")
    backup_names = ", ".join(b.name for b in backups.values())
    print(f"  {name}: applied, syntax and tests OK (backup {backup_names})")
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
