"""Tests for AIRA's brain.reactions. Run: python3 -m unittest tests/test_reactions.py"""

import json
import os
import random
import sys
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain import reactions  # noqa: E402

CHAT_ON = "0000000000@lid"
CHAT_OFF = "1234567890@s.whatsapp.net"
CHAT_ABSENT = "0000000001@g.us"


class ReactionsTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        (Path(self.dir.name) / "gateway").mkdir()
        self.file = Path(self.dir.name) / "gateway" / "chats.json"
        self.file.write_text(
            json.dumps({
                "version": 1,
                "chats": {
                    CHAT_ON: {"voice": "off", "reactions": True},
                    CHAT_OFF: {"voice": "all", "reactions": False},
                },
            }),
            encoding="utf-8",
        )
        self.state = {}

    def env(self):
        return mock.patch.dict(os.environ, {"AIRA_HOST_DATA_DIR": self.dir.name})

    def test_gated_off_for_absent_or_disabled_chat(self):
        rng = random.Random(0)
        with self.env():
            self.assertIsNone(reactions.choose("goodnight!", CHAT_ABSENT, now=1000, rng=rng, state=self.state, chance=1.0))
            self.assertIsNone(reactions.choose("goodnight!", CHAT_OFF, now=1000, rng=rng, state=self.state, chance=1.0))

    def test_chooses_emoji_for_food_and_goodnight_when_on(self):
        rng = random.Random(1)
        with self.env():
            food = reactions.choose("making ramen for dinner", CHAT_ON, now=1000, rng=rng, state=self.state, chance=1.0)
            self.assertIn(food, ("🍳", "🍵", "🍙"))

            night = reactions.choose("goodnight everyone", CHAT_ON, now=2000, rng=rng, state=self.state, chance=1.0, cooldown=180)
            self.assertIn(night, ("🌙", "💤", "😴"))

    def test_skips_from_me_commands_urls_and_cooldown(self):
        rng = random.Random(2)
        with self.env():
            self.assertIsNone(reactions.choose("goodnight!", CHAT_ON, from_me=True, now=1000, rng=rng, state=self.state, chance=1.0))
            self.assertIsNone(reactions.choose("/goodnight", CHAT_ON, now=1000, rng=rng, state=self.state, chance=1.0))
            self.assertIsNone(reactions.choose("https://example.com/lunch", CHAT_ON, now=1000, rng=rng, state=self.state, chance=1.0))
            first = reactions.choose("hungry for lunch", CHAT_ON, now=1000, rng=rng, state=self.state, chance=1.0, cooldown=180)
            self.assertIsNotNone(first)
            second = reactions.choose("goodnight!", CHAT_ON, now=1050, rng=rng, state=self.state, chance=1.0, cooldown=180)
            self.assertIsNone(second)

    def test_react_to_stubs_sender_with_no_network_call(self):
        sent = []
        done = threading.Event()

        def fake_sender(key, emoji, port):
            sent.append((key, emoji, port))
            done.set()

        raw = {
            "chatId": CHAT_ON,
            "body": "[HERMES-SCOPE chat=0000000000@lid]\nmaking sushi now",
            "readReceiptKey": {"id": "msg-1", "remoteJid": CHAT_ON, "fromMe": False},
        }
        with self.env():
            chosen = reactions.react_to(raw, port=3100, sender=fake_sender, now=1000, rng=random.Random(3), state=self.state, chance=1.0)
        self.assertIn(chosen, ("🍳", "🍵", "🍙"))
        self.assertTrue(done.wait(timeout=2.0))
        self.assertEqual(sent, [(raw["readReceiptKey"], chosen, 3100)])


if __name__ == "__main__":
    unittest.main()
