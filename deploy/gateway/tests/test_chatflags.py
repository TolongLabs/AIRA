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
            self.assertEqual(chatflags.voice_mode("12345678901@g.us"), "off")
            self.assertFalse(chatflags.reactions_on("12345678901@g.us"))

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

    def test_names_and_free_flags_never_raise_and_follow_cache(self):
        group_names = "0000000000@g.us"
        group_free = "12345678901@g.us"
        group_absent = "123456789012@g.us"

        with self.env(""):
            self.assertEqual(chatflags.names(group_names), [])
            self.assertFalse(chatflags.free(group_free))

        self.file.write_text("{bad json", encoding="utf-8")
        with self.env(self.dir.name):
            self.assertEqual(chatflags.names(group_names), [])
            self.assertFalse(chatflags.free(group_free))

        self.write_flags(
            {
                group_names: {"names": ["Taiga", "Ah Boy", "", 123]},
                group_free: {"free": True, "names": "not-a-list"},
                group_absent: {"free": "yes"},
            },
            mtime_ns=3_000_000_000,
        )
        with self.env(self.dir.name):
            self.assertEqual(chatflags.names(group_names), ["Taiga", "Ah Boy"])
            self.assertFalse(chatflags.free(group_names))
            self.assertEqual(chatflags.names(group_free), [])
            self.assertTrue(chatflags.free(group_free))
            self.assertEqual(chatflags.names(group_absent), [])
            self.assertFalse(chatflags.free(group_absent))

            self.write_flags(
                {group_names: {"names": ["Updated"], "free": True}},
                mtime_ns=4_000_000_000,
            )
            self.assertEqual(chatflags.names(group_names), ["Updated"])
            self.assertTrue(chatflags.free(group_names))

            self.file.unlink()
            self.assertEqual(chatflags.names(group_names), [])
            self.assertFalse(chatflags.free(group_names))

    def test_names_and_free_stay_off_for_wrong_version_false_values_and_other_flags(self):
        group_a = "12345678901@g.us"
        group_b = "123456789012@g.us"

        with self.env(self.dir.name):
            self.assertEqual(chatflags.names(None), [])
            self.assertFalse(chatflags.free(None))
            self.assertEqual(chatflags.names(""), [])
            self.assertFalse(chatflags.free(""))

            self.file.write_text(
                json.dumps({"version": 2, "chats": {group_a: {"names": ["Aira"], "free": True}}}),
                encoding="utf-8",
            )
            os.utime(self.file, ns=(8_500_000_000, 8_500_000_000))
            self.assertEqual(chatflags.names(group_a), [])
            self.assertFalse(chatflags.free(group_a))

            self.write_flags(
                {
                    group_a: {"voice": "all", "reactions": True, "free": False, "names": ["   ", ""]},
                    group_b: {"voice": "all"},
                },
                mtime_ns=9_000_000_000,
            )
            self.assertEqual(chatflags.names(group_a), [])
            self.assertFalse(chatflags.free(group_a))
            self.assertEqual(chatflags.names(group_b), [])
            self.assertFalse(chatflags.free(group_b))

    def test_reaction_chance_reads_clamps_defaults_and_never_raises(self):
        group_a = "0000000000@g.us"
        group_b = "12345678901@g.us"

        with self.env(""):
            self.assertEqual(chatflags.reaction_chance(group_a), 0.33)
            self.assertEqual(chatflags.reaction_chance(None), 0.33)

        self.file.write_text("{bad json", encoding="utf-8")
        with self.env(self.dir.name):
            self.assertEqual(chatflags.reaction_chance(group_a), 0.33)

        self.write_flags(
            {
                group_a: {"reactions": True, "reactionChance": 0.75},
                group_b: {"reactions": True, "reactionChance": 0},
            },
            mtime_ns=5_000_000_000,
        )
        with self.env(self.dir.name):
            self.assertEqual(chatflags.reaction_chance(group_a), 0.75)
            self.assertEqual(chatflags.reaction_chance(group_b), 0.0)
            self.assertEqual(chatflags.reaction_chance(group_a, default=0.9), 0.75)

            self.write_flags(
                {
                    group_a: {"reactions": True, "reactionChance": 1.8},
                    group_b: {"reactions": True, "reactionChance": -0.4},
                },
                mtime_ns=6_000_000_000,
            )
            self.assertEqual(chatflags.reaction_chance(group_a), 1.0)
            self.assertEqual(chatflags.reaction_chance(group_b), 0.0)

            self.write_flags(
                {
                    group_a: {"reactions": True, "reactionChance": True},
                    group_b: {"reactions": True, "reactionChance": "0.5"},
                },
                mtime_ns=7_000_000_000,
            )
            self.assertEqual(chatflags.reaction_chance(group_a), 0.33)
            self.assertEqual(chatflags.reaction_chance(group_b, default=0.5), 0.5)

            self.file.write_text('{"version": 1, "chats": {"0000000000@g.us": {"reactionChance": NaN}}}', encoding="utf-8")
            os.utime(self.file, ns=(8_000_000_000, 8_000_000_000))
            self.assertEqual(chatflags.reaction_chance(group_a), 0.33)

            self.file.unlink()
            self.assertEqual(chatflags.reaction_chance(group_a), 0.33)


if __name__ == "__main__":
    unittest.main()
