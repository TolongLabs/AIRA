"""Tests for deploy/gateway/patches.py on invented trees. The real gateway tree is never touched here."""

import importlib.util
import io
import json
import os
import re
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gateway_patches", HERE / "patches.py")
patches = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patches)

PY = [sys.executable, "-m", "py_compile", "{target}"]


def patch(**over):
    base = {
        "name": "demo",
        "target": "gateway/demo.py",
        "present": "# [demo]",
        "edits": (("x = 1\n", "x = 1  # [demo]\n"),),
        "syntax": PY,
        "tests": [],
        "cwd": ".",
        "why": "a demo",
    }
    base.update(over)
    return base


class ApplyTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.tree = Path(self.dir.name)
        (self.tree / "gateway").mkdir()
        self.file = self.tree / "gateway" / "demo.py"
        self.file.write_text("x = 1\n", encoding="utf-8")

    def apply(self, p, check_only=False):
        with redirect_stdout(io.StringIO()) as out:
            ok = patches.apply_patch(p, self.tree, check_only=check_only, python=sys.executable)
        return ok, out.getvalue()

    def test_apply_then_repeat(self):
        ok, out = self.apply(patch())
        self.assertTrue(ok)
        self.assertIn("applied, syntax and tests OK", out)
        self.assertEqual(self.file.read_text(encoding="utf-8"), "x = 1  # [demo]\n")
        ok, out = self.apply(patch())
        self.assertTrue(ok)
        self.assertIn("already applied", out)

    def test_two_patches_on_one_file_keep_two_backups(self):
        self.assertTrue(self.apply(patch())[0])
        second = patch(name="demo2", present="# [two]", edits=(("x = 1  # [demo]\n", "x = 1  # [demo] [two]\n"),))
        self.assertTrue(self.apply(second)[0])
        backups = sorted(self.tree.glob("gateway/demo.py.bak-*"))
        self.assertEqual([b.read_text(encoding="utf-8") for b in backups], ["x = 1\n", "x = 1  # [demo]\n"])

    def test_check_only_writes_nothing(self):
        ok, out = self.apply(patch(), check_only=True)
        self.assertFalse(ok)
        self.assertIn("ABSENT", out)
        self.assertEqual(self.file.read_text(encoding="utf-8"), "x = 1\n")

    def test_a_missing_or_repeated_anchor_writes_nothing(self):
        for text in ("y = 2\n", "x = 1\nx = 1\n"):
            self.file.write_text(text, encoding="utf-8")
            ok, out = self.apply(patch())
            self.assertFalse(ok)
            self.assertIn("ABORT", out)
            self.assertEqual(self.file.read_text(encoding="utf-8"), text)
        self.assertEqual(list(self.tree.glob("gateway/*.bak-*")), [])

    def test_a_failed_check_restores_the_file(self):
        broken = patch(edits=(("x = 1\n", "x = (  # [demo]\n"),))
        ok, out = self.apply(broken)
        self.assertFalse(ok)
        self.assertIn("FAILED", out)
        self.assertEqual(self.file.read_text(encoding="utf-8"), "x = 1\n")

    def test_a_failed_test_restores_the_file(self):
        failing = patch(tests=[[sys.executable, "-c", "raise SystemExit(3)"]])
        ok, _ = self.apply(failing)
        self.assertFalse(ok)
        self.assertEqual(self.file.read_text(encoding="utf-8"), "x = 1\n")

    def test_a_removal_is_applied_when_its_mark_is_absent(self):
        self.file.write_text("x = 1\ntrace()  # [trace]\n", encoding="utf-8")
        removal = patch(present=None, edits=(("trace()  # [trace]\n", ""),))
        del removal["present"]
        removal["absent"] = "[trace]"
        ok, _ = self.apply(removal)
        self.assertTrue(ok)
        self.assertEqual(self.file.read_text(encoding="utf-8"), "x = 1\n")
        self.assertIn("already applied", self.apply(removal)[1])

    def test_a_missing_target_fails(self):
        ok, out = self.apply(patch(target="gateway/none.py"))
        self.assertFalse(ok)
        self.assertIn("TARGET MISSING", out)


class RealPatchesTest(unittest.TestCase):
    def test_each_patch_is_well_formed(self):
        names = [p["name"] for p in patches.patches()]
        self.assertEqual(len(names), len(set(names)))
        self.assertIn("sticker-media-type", names)
        for p in patches.patches():
            with self.subTest(p["name"]):
                self.assertEqual(("present" in p) + ("absent" in p), 1)
                self.assertTrue(p["edits"])
                for find, replace in p["edits"]:
                    self.assertNotEqual(find, replace)
                    self.assertNotIn(find, replace)
                joined_find = "".join(find for find, _ in p["edits"])
                joined_replace = "".join(replace for _, replace in p["edits"])
                if "present" in p:
                    self.assertNotIn(p["present"], joined_find)
                    self.assertIn(p["present"], joined_replace)
                else:
                    self.assertIn(p["absent"], joined_find)
                    self.assertNotIn(p["absent"], joined_replace)

    def test_a_tree_that_is_not_a_gateway_is_refused(self):
        with tempfile.TemporaryDirectory() as empty, redirect_stdout(io.StringIO()):
            self.assertEqual(patches.main(["--hermes-agent", empty, "--check"]), 2)


WHATSAPP_COMMON_FIXTURE = '''import re
from typing import Any, Dict


class WhatsAppBehaviorMixin:
    _mention_patterns = []

    def _is_broadcast_chat(self, chat_id: str) -> bool:
        return chat_id.endswith("@broadcast") or chat_id.startswith("status@")

    def _is_group_allowed(self, chat_id: str) -> bool:
        return True

    def _whatsapp_free_response_chats(self) -> set[str]:
        return set()

    def _whatsapp_require_mention(self) -> bool:
        return True

    def _normalize_whatsapp_id(self, raw: Any) -> str:
        value = str(raw or "").strip()
        if not value:
            return ""
        return value.replace(":", "@")

    def _bot_ids_from_message(self, data: Dict[str, Any]) -> list[str]:
        return [self._normalize_whatsapp_id(b) for b in (data.get("botIds") or []) if b]

    def _message_is_reply_to_bot(self, data: Dict[str, Any]) -> bool:
        quoted_participant = self._normalize_whatsapp_id(data.get("quotedParticipant"))
        if not quoted_participant:
            return False
        return quoted_participant in self._bot_ids_from_message(data)

    def _message_mentions_bot(self, data: Dict[str, Any]) -> bool:
        def _bare(value: Any) -> str:
            return str(value).split("@", 1)[0].split(":", 1)[0]

        bot_users = {_bare(b) for b in self._bot_ids_from_message(data) if b}
        return any(_bare(m) in bot_users for m in (data.get("mentionedIds") or []) if m)

    def _message_matches_mention_patterns(self, data: Dict[str, Any]) -> bool:
        if not self._mention_patterns:
            return False
        body = str(data.get("body") or "")
        return any(pattern.search(body) for pattern in self._mention_patterns)

    def _should_process_message(self, data: Dict[str, Any]) -> bool:
        chat_id = str(data.get("chatId") or "")
        if self._is_broadcast_chat(chat_id):
            return False
        if not data.get("isGroup"):
            return True
        if not self._is_group_allowed(chat_id):
            return False
        # Group messages: check mention / free-response settings
        chat_id = str(data.get("chatId") or "")
        if chat_id in self._whatsapp_free_response_chats():
            return True
        if not self._whatsapp_require_mention():
            return True
        if self._message_is_reply_to_bot(data):
            return True
        if self._message_mentions_bot(data):
            return True
        return self._message_matches_mention_patterns(data)
'''

GROUP_NAMED = "12345678901@g.us"
GROUP_OTHER = "123456789012@g.us"
GROUP_FREE = "1234567890123@g.us"
GROUP_OFF = "12345678901234@g.us"
GROUP_ABSENT = "123456789012345@g.us"
DM_ALLOWED = "1234567890123456@s.whatsapp.net"
BOT_IDS = ["12345678901:3@lid", "123456789012:12@s.whatsapp.net"]


class GroupAddressingPatchesTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.tree = Path(self.dir.name) / "hermes-agent"
        platforms = self.tree / "gateway" / "platforms"
        platforms.mkdir(parents=True)
        (self.tree / "gateway" / "__init__.py").write_text("", encoding="utf-8")
        (platforms / "__init__.py").write_text("", encoding="utf-8")
        self.wa_file = platforms / "whatsapp_common.py"
        self.wa_file.write_text(WHATSAPP_COMMON_FIXTURE, encoding="utf-8")

        self.hermes_home = Path(self.dir.name) / "hermes_home"
        scripts_dir = self.hermes_home / "scripts"
        scripts_dir.mkdir(parents=True)
        shutil.copytree(HERE / "brain", scripts_dir / "brain")

        self.data_dir = Path(self.dir.name) / "data"
        (self.data_dir / "gateway").mkdir(parents=True)
        self.chats_file = self.data_dir / "gateway" / "chats.json"

        self.env_patch = mock.patch.dict(
            os.environ,
            {
                "HERMES_HOME": str(self.hermes_home),
                "AIRA_HOST_DATA_DIR": str(self.data_dir),
                "PYTHONDONTWRITEBYTECODE": "1",
            },
        )
        self.env_patch.start()
        self.addCleanup(self.env_patch.stop)

        if str(HERE) not in sys.path:
            sys.path.insert(0, str(HERE))

    def patch_named(self, name: str) -> dict:
        for item in patches.patches():
            if item["name"] == name:
                return item
        self.fail(f"patch not found: {name}")

    def apply(self, name: str, *, check_only: bool = False):
        p = self.patch_named(name)
        with redirect_stdout(io.StringIO()) as out:
            ok = patches.apply_patch(p, self.tree, check_only=check_only, python=sys.executable)
        return ok, out.getvalue()

    def write_chats(self, chats: dict, *, mtime_ns: int):
        self.chats_file.write_text(json.dumps({"version": 1, "chats": chats}), encoding="utf-8")
        os.utime(self.chats_file, ns=(mtime_ns, mtime_ns))

    def load_mixin(self):
        name = f"_test_whatsapp_common_{id(self)}_{os.urandom(4).hex()}"
        mod_spec = importlib.util.spec_from_file_location(name, self.wa_file)
        module = importlib.util.module_from_spec(mod_spec)
        mod_spec.loader.exec_module(module)
        return module.WhatsAppBehaviorMixin

    @staticmethod
    def group_msg(chat_id: str, body: str = "ok", **extra) -> dict:
        return {"chatId": chat_id, "isGroup": True, "body": body, **extra}

    def test_reply_to_bot_ids_applies_and_wakes_on_device_suffixed_bot_ids(self):
        unpatched = self.load_mixin()()
        self.assertFalse(
            unpatched._message_is_reply_to_bot({"quotedParticipant": "12345678901@lid", "botIds": BOT_IDS})
        )

        ok, out = self.apply("reply-to-bot-ids", check_only=True)
        self.assertFalse(ok)
        self.assertIn("ABSENT", out)

        ok, out = self.apply("reply-to-bot-ids")
        self.assertTrue(ok, out)
        self.assertIn("applied, syntax and tests OK", out)

        ok, out = self.apply("reply-to-bot-ids")
        self.assertTrue(ok, out)
        self.assertIn("already applied", out)

        mixin = self.load_mixin()()
        for quoted in ("12345678901@lid", "123456789012@s.whatsapp.net", "12345678901:7@lid"):
            self.assertTrue(
                mixin._should_process_message(
                    self.group_msg(GROUP_OFF, quotedParticipant=quoted, botIds=BOT_IDS)
                )
            )
        # Preserve raw colon device suffix on normalization too.
        mixin._normalize_whatsapp_id = lambda raw: str(raw or "").strip()
        self.assertTrue(
            mixin._message_is_reply_to_bot(
                {"quotedParticipant": "12345678901@lid", "botIds": ["12345678901:3@lid"]}
            )
        )
        self.assertFalse(
            mixin._should_process_message(
                self.group_msg(GROUP_OFF, quotedParticipant="12345678901234567@lid", botIds=BOT_IDS)
            )
        )
        self.assertTrue(
            mixin._should_process_message(
                self.group_msg(GROUP_OFF, mentionedIds=["12345678901@lid"], botIds=BOT_IDS)
            )
        )
        self.assertFalse(
            mixin._should_process_message(
                self.group_msg(GROUP_OFF, mentionedIds=["12345678901234567@lid"], botIds=BOT_IDS)
            )
        )
        self.assertFalse(mixin._message_is_reply_to_bot({"quotedParticipant": "", "botIds": BOT_IDS}))
        self.assertFalse(mixin._message_is_reply_to_bot({"quotedParticipant": "12345678901@lid", "botIds": []}))

    def test_name_call_from_core_applies_and_wakes_on_chat_names_and_free_response(self):
        ok, out = self.apply("name-call-from-core", check_only=True)
        self.assertFalse(ok)
        self.assertIn("ABSENT", out)

        ok, out = self.apply("name-call-from-core")
        self.assertTrue(ok, out)
        self.assertIn("applied, syntax and tests OK", out)

        ok, out = self.apply("name-call-from-core")
        self.assertTrue(ok, out)
        self.assertIn("already applied", out)

        self.write_chats(
            {
                GROUP_NAMED: {"names": ["Aira", "Bot Alias", "a.b"]},
                GROUP_OTHER: {"names": ["Example"]},
                GROUP_FREE: {"free": True},
                GROUP_OFF: {"voice": "all", "reactions": True, "free": False, "names": []},
            },
            mtime_ns=1_000_000_000,
        )

        mixin = self.load_mixin()()
        # Free-response chat wakes on any message.
        self.assertTrue(mixin._should_process_message(self.group_msg(GROUP_FREE, "hello all")))
        # Chat names wake only for that chat's entry, whole word, any case.
        for body in ("AIRA, hi", "hey bot alias!", "hey a.b!"):
            self.assertTrue(mixin._should_process_message(self.group_msg(GROUP_NAMED, body)), body)
        for body in ("airasia", "myaira", "aira2", "axb", "example"):
            self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_NAMED, body)), body)
        self.assertTrue(mixin._should_process_message(self.group_msg(GROUP_OTHER, "example?")))
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_OTHER, "aira")))
        # Chats with name call off and no free response stay quiet.
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_OFF, "aira")))
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_ABSENT, "aira")))
        # Mentions still wake even when name call is off; bad chats.json fails closed for names/free.
        self.chats_file.write_text("{bad json", encoding="utf-8")
        os.utime(self.chats_file, ns=(1_500_000_000, 1_500_000_000))
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_NAMED, "aira")))
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_FREE, "hello")))
        self.assertTrue(
            mixin._should_process_message(
                self.group_msg(GROUP_OFF, "hello", mentionedIds=["12345678901@lid"], botIds=BOT_IDS)
            )
        )
        # Before name-call-only-from-core, global mention_patterns still wake any group.
        mixin._mention_patterns = [re.compile(r"\baira\b", re.IGNORECASE)]
        self.assertTrue(mixin._should_process_message(self.group_msg(GROUP_OFF, "aira")))

    def test_name_call_only_from_core_requires_name_call_from_core_and_blocks_global_patterns(self):
        # Cannot apply before name-call-from-core.
        ok, out = self.apply("name-call-only-from-core")
        self.assertFalse(ok)
        self.assertIn("ABORT", out)
        self.assertEqual(self.wa_file.read_text(encoding="utf-8"), WHATSAPP_COMMON_FIXTURE)

        self.assertTrue(self.apply("name-call-from-core")[0])

        ok, out = self.apply("name-call-only-from-core", check_only=True)
        self.assertFalse(ok)
        self.assertIn("ABSENT", out)

        ok, out = self.apply("name-call-only-from-core")
        self.assertTrue(ok, out)
        self.assertIn("applied, syntax and tests OK", out)

        ok, out = self.apply("name-call-only-from-core")
        self.assertTrue(ok, out)
        self.assertIn("already applied", out)
        self.assertIn("already applied", self.apply("name-call-from-core")[1])

        self.write_chats(
            {
                GROUP_NAMED: {"names": ["Aira"]},
                GROUP_OTHER: {"names": ["Example"]},
                GROUP_OFF: {"voice": "all", "reactions": True},
            },
            mtime_ns=2_000_000_000,
        )

        mixin = self.load_mixin()()
        mixin._mention_patterns = [re.compile(r"\baira\b", re.IGNORECASE)]
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_OFF, "aira")))
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_ABSENT, "aira")))
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_OTHER, "aira")))
        self.assertTrue(mixin._should_process_message(self.group_msg(GROUP_OTHER, "example")))
        self.assertTrue(mixin._should_process_message(self.group_msg(GROUP_NAMED, "aira")))

    def test_all_three_group_addressing_patches_enforce_fr1(self):
        for name in ("reply-to-bot-ids", "name-call-from-core", "name-call-only-from-core"):
            ok, out = self.apply(name)
            self.assertTrue(ok, f"{name}: {out}")

        self.write_chats(
            {
                GROUP_NAMED: {"names": ["Aira"]},
                GROUP_OTHER: {"names": ["Example"]},
                GROUP_FREE: {"free": True},
                GROUP_OFF: {"voice": "all", "reactions": True},
            },
            mtime_ns=3_000_000_000,
        )

        mixin = self.load_mixin()()
        mixin._mention_patterns = [re.compile(r"\baira\b", re.IGNORECASE)]

        # 1. DM from allowed sender wakes on any message.
        self.assertTrue(mixin._should_process_message({"chatId": DM_ALLOWED, "isGroup": False, "body": "hello"}))

        # 2. Mention of the bot wakes even when name call and free response are off.
        self.assertTrue(
            mixin._should_process_message(
                self.group_msg(GROUP_OFF, "ping", mentionedIds=["123456789012@s.whatsapp.net"], botIds=BOT_IDS)
            )
        )

        # 3. Reply to a bot id with a device suffix wakes; reply to someone else does not.
        self.assertTrue(
            mixin._should_process_message(
                self.group_msg(GROUP_OFF, "what about this?", quotedParticipant="12345678901@lid", botIds=BOT_IDS)
            )
        )
        self.assertFalse(
            mixin._should_process_message(
                self.group_msg(GROUP_OFF, "what about this?", quotedParticipant="12345678901234567@lid", botIds=BOT_IDS)
            )
        )

        # 4. Free-response chat wakes on any message.
        self.assertTrue(mixin._should_process_message(self.group_msg(GROUP_FREE, "random line")))

        # 5. Chat name wakes only when that chat's entry lists it and name call is on.
        self.assertTrue(mixin._should_process_message(self.group_msg(GROUP_NAMED, "Hey Aira")))
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_NAMED, "airasia")))
        self.assertTrue(mixin._should_process_message(self.group_msg(GROUP_OTHER, "Example?")))
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_OTHER, "Aira")))

        # 6. Global name pattern does not wake chats without name call or missing that name.
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_OFF, "aira")))
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_ABSENT, "aira")))

        # 7. Reloading chats.json turns name call and free response off immediately.
        self.write_chats({GROUP_NAMED: {"voice": "all"}}, mtime_ns=4_000_000_000)
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_NAMED, "Hey Aira")))
        self.assertFalse(mixin._should_process_message(self.group_msg(GROUP_FREE, "random line")))



ADAPTER_FIXTURE = """def _aira_autofetch():
    \"\"\"[aira] The social plugin's auto-fetch module, or None if not loaded.\"\"\"
    try:
        import importlib
        return importlib.import_module("hermes_plugins.social.autofetch")
    except Exception:
        return None
"""


class AutofetchPatchTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.tree = Path(self.dir.name) / "hermes-agent"
        self.adapter = self.tree / "plugins" / "platforms" / "whatsapp" / "adapter.py"
        self.adapter.parent.mkdir(parents=True)
        self.adapter.write_text(ADAPTER_FIXTURE, encoding="utf-8")
        (self.tree / "gateway").mkdir()

    def apply(self, *, check_only: bool = False):
        p = next(item for item in patches.patches() if item["name"] == "autofetch-from-core")
        with redirect_stdout(io.StringIO()) as out:
            ok = patches.apply_patch(p, self.tree, check_only=check_only, python=sys.executable)
        return ok, out.getvalue()

    def test_the_hook_loads_brain_autofetch_instead_of_the_old_plugin(self):
        ok, out = self.apply(check_only=True)
        self.assertFalse(ok)
        self.assertIn("ABSENT", out)

        ok, out = self.apply()
        self.assertTrue(ok, out)
        self.assertIn("applied, syntax and tests OK", out)
        text = self.adapter.read_text(encoding="utf-8")
        self.assertIn('importlib.import_module("brain.autofetch")', text)
        self.assertNotIn("hermes_plugins.social.autofetch", text)

        ok, out = self.apply()
        self.assertTrue(ok, out)
        self.assertIn("already applied", out)


if __name__ == "__main__":
    unittest.main()
