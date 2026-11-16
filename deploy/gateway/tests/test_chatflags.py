"""Tests for AIRA's brain.chatflags. Run: python3 -m unittest tests/test_chatflags.py"""

import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain import chatflags  # noqa: E402

CHAT_A = "0000000000@lid"
CHAT_B = "1234567890@s.whatsapp.net"


class ChatFlagsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        (Path(self.dir.name) / "gateway").mkdir()
        self.file = Path(self.dir.name) / "gateway" / "chats.json"

    def env(self, value):
        return mock.patch.dict(os.environ, {"AIRA_HOST_DATA_DIR": value})

    def write_flags(self, chats, *, mtime_ns=None):
        payload = {"version": 1, "chats": chats}
        self.file.write_text(json.dumps(payload), encoding="utf-8")
        if mtime_ns is not None:
            os.utime(self.file, ns=(mtime_ns, mtime_ns))

    def test_missing_file_and_unset_env_mean_everything_off(self):
        with self.env(""):
            self.assertEqual(chatflags.flags(CHAT_A), {})
            self.assertEqual(chatflags.voice_mode(CHAT_A), "off")
            self.assertFalse(chatflags.reactions_on(CHAT_A))

        with self.env(self.dir.name):
            self.assertEqual(chatflags.flags(CHAT_A), {})
            self.assertEqual(chatflags.voice_mode(CHAT_A), "off")
            self.assertFalse(chatflags.reactions_on(CHAT_A))

    def test_bad_json_means_everything_off_and_never_raises(self):
        self.file.write_text("{not valid json", encoding="utf-8")
        with self.env(self.dir.name):
            self.assertEqual(chatflags.flags(CHAT_A), {})
            self.assertEqual(chatflags.voice_mode(CHAT_A), "off")
            self.assertFalse(chatflags.reactions_on(CHAT_A))

    def test_voice_and_reactions_flags(self):
        self.write_flags({
            CHAT_A: {"voice": "all", "reactions": True},
            CHAT_B: {"voice": "off", "reactions": False},
        })
        with self.env(self.dir.name):
            self.assertEqual(chatflags.voice_mode(CHAT_A), "all")
            self.assertTrue(chatflags.reactions_on(CHAT_A))
            self.assertEqual(chatflags.voice_mode(CHAT_B), "off")
            self.assertFalse(chatflags.reactions_on(CHAT_B))
            self.assertEqual(chatflags.voice_mode("0000000001@g.us"), "off")
            self.assertFalse(chatflags.reactions_on("0000000001@g.us"))

    def test_reloads_when_mtime_changes_and_resets_when_removed(self):
        self.write_flags({CHAT_A: {"voice": "off", "reactions": False}}, mtime_ns=1_000_000_000)
        with self.env(self.dir.name):
            self.assertEqual(chatflags.voice_mode(CHAT_A), "off")
            self.assertFalse(chatflags.reactions_on(CHAT_A))

            self.write_flags({CHAT_A: {"voice": "all", "reactions": True}}, mtime_ns=2_000_000_000)
            self.assertEqual(chatflags.voice_mode(CHAT_A), "all")
            self.assertTrue(chatflags.reactions_on(CHAT_A))

            self.file.unlink()
            self.assertEqual(chatflags.voice_mode(CHAT_A), "off")
            self.assertFalse(chatflags.reactions_on(CHAT_A))


if __name__ == "__main__":
    unittest.main()
