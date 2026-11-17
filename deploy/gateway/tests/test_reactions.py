"""Tests for AIRA's brain.reactions. Run: python3 -m unittest tests/test_reactions.py"""

import io
import json
import logging
import os
import random
import sys
import tempfile
import threading
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain import chatflags, reactions  # noqa: E402

CHAT_ON = "0000000000@g.us"
CHAT_OTHER = "12345678901@g.us"


class _FakeResponse:
    def __init__(self, status=200):
        self.status = status

    def __enter__(self):
        return self

    def __exit__(self, *args):
        return False


class _FixedRng:
    def __init__(self, roll, pick=0):
        self._roll = roll
        self._pick = pick

    def random(self):
        return self._roll

    def choice(self, seq):
        return seq[self._pick]


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
                },
            }),
            encoding="utf-8",
        )
        self.state = {}

    def env(self, extra=None):
        values = {"AIRA_HOST_DATA_DIR": self.dir.name}
        if extra:
            values.update(extra)
        return mock.patch.dict(os.environ, values)

    def test_gated_off_for_absent_or_disabled_chat(self):
        rng = random.Random(0)
        with self.env():
            self.assertIsNone(reactions.choose("goodnight!", CHAT_OTHER, now=1000, rng=rng, state=self.state, chance=1.0))
            self.file.write_text(
                json.dumps({
                    "version": 1,
                    "chats": {
                        CHAT_ON: {"voice": "off", "reactions": True},
                        CHAT_OTHER: {"voice": "all", "reactions": False},
                    },
                }),
                encoding="utf-8",
            )
            os.utime(self.file, ns=(9_000_000_000, 9_000_000_000))
            self.assertIsNone(reactions.choose("goodnight!", CHAT_OTHER, now=1000, rng=rng, state=self.state, chance=1.0))

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
            "body": f"[HERMES-SCOPE chat={CHAT_ON}]\nmaking sushi now",
            "readReceiptKey": {"id": "msg-1", "remoteJid": CHAT_ON, "fromMe": False},
        }
        with self.env():
            chosen = reactions.react_to(raw, port=3100, sender=fake_sender, now=1000, rng=random.Random(3), state=self.state, chance=1.0)
        self.assertIn(chosen, ("🍳", "🍵", "🍙"))
        self.assertTrue(done.wait(timeout=2.0))
        self.assertEqual(sent, [(raw["readReceiptKey"], chosen, 3100)])

    def test_chance_comes_from_file_and_env_is_fallback_only(self):
        self.file.write_text(
            json.dumps({
                "version": 1,
                "chats": {
                    CHAT_ON: {"reactions": True, "reactionChance": 0.75},
                    CHAT_OTHER: {"reactions": True},
                },
            }),
            encoding="utf-8",
        )
        os.utime(self.file, ns=(10_000_000_000, 10_000_000_000))
        with self.env({"AIRA_REACTION_CHANCE": "0.1"}):
            # File's 0.75 wins over env's 0.1.
            self.assertIsNotNone(reactions.choose("goodnight!", CHAT_ON, now=1000, rng=_FixedRng(0.5), state=self.state))
            self.assertIsNone(reactions.choose("goodnight!", CHAT_ON, now=2000, rng=_FixedRng(0.8), state=self.state))
            # Absent reactionChance falls back to env's 0.1.
            self.assertIsNone(reactions.choose("goodnight!", CHAT_OTHER, now=1000, rng=_FixedRng(0.5), state=self.state))
            self.assertIsNotNone(reactions.choose("goodnight!", CHAT_OTHER, now=2000, rng=_FixedRng(0.05), state=self.state))

    def test_one_reaction_per_message_id_even_after_negative_decision(self):
        sent = []
        done = threading.Event()

        def fake_sender(key, emoji, port):
            sent.append((key, emoji, port))
            done.set()

        raw = {
            "chatId": CHAT_ON,
            "body": "making ramen now",
            "readReceiptKey": {"id": "msg-dedup-1", "remoteJid": CHAT_ON, "fromMe": False},
        }
        with self.env():
            first = reactions.react_to(raw, sender=fake_sender, now=1000, rng=_FixedRng(0.0), state=self.state, chance=1.0, cooldown=0)
            second = reactions.react_to(raw, sender=fake_sender, now=1001, rng=_FixedRng(0.0), state=self.state, chance=1.0, cooldown=0)
        self.assertIsNotNone(first)
        self.assertIsNone(second)
        self.assertTrue(done.wait(timeout=2.0))
        self.assertEqual(len(sent), 1)

        raw_declined = {
            "chatId": CHAT_ON,
            "body": "goodnight!",
            "readReceiptKey": {"id": "msg-dedup-2", "remoteJid": CHAT_ON, "fromMe": False},
        }
        with self.env():
            declined = reactions.react_to(raw_declined, sender=fake_sender, now=2000, rng=_FixedRng(0.9), state=self.state, chance=0.2, cooldown=0)
            retried = reactions.react_to(raw_declined, sender=fake_sender, now=2001, rng=_FixedRng(0.0), state=self.state, chance=1.0, cooldown=0)
        self.assertIsNone(declined)
        self.assertIsNone(retried)
        self.assertEqual(len(sent), 1)

    def test_seen_and_chat_lru_bounds(self):
        self.assertEqual(reactions.MAX_SEEN_IDS, 512)
        self.assertEqual(reactions.MAX_CHATS, 256)
        self.file.write_text(
            json.dumps({
                "version": 1,
                "chats": {
                    CHAT_ON: {"reactions": True, "reactionChance": 1.0},
                    CHAT_OTHER: {"reactions": True, "reactionChance": 1.0},
                },
            }),
            encoding="utf-8",
        )
        os.utime(self.file, ns=(11_000_000_000, 11_000_000_000))
        with self.env():
            for i in range(512):
                res = reactions.choose("goodnight", CHAT_ON, now=1000 + i, rng=_FixedRng(0.0), state=self.state, chance=1.0, cooldown=0, message_id=f"m-{i}")
                self.assertIsNotNone(res)
            self.assertEqual(len(self.state["seen"]), 512)
            # Still remembered before eviction.
            self.assertIsNone(reactions.choose("goodnight", CHAT_ON, now=2000, rng=_FixedRng(0.0), state=self.state, chance=1.0, cooldown=0, message_id="m-0"))
            # Adding two more evicts m-1 (since m-0 was moved to MRU) and m-2, keeping size 512.
            self.assertIsNotNone(reactions.choose("goodnight", CHAT_ON, now=2001, rng=_FixedRng(0.0), state=self.state, chance=1.0, cooldown=0, message_id="m-512"))
            self.assertEqual(len(self.state["seen"]), 512)
            self.assertIsNotNone(reactions.choose("goodnight", CHAT_ON, now=2002, rng=_FixedRng(0.0), state=self.state, chance=1.0, cooldown=0, message_id="m-1"))
            self.assertEqual(len(self.state["seen"]), 512)

            chat_state = {}
            with mock.patch.object(reactions, "MAX_CHATS", 1):
                self.assertIsNotNone(reactions.choose("goodnight", CHAT_ON, now=1000, rng=_FixedRng(0.0), state=chat_state, chance=1.0, cooldown=180))
                self.assertIsNotNone(reactions.choose("goodnight", CHAT_OTHER, now=1010, rng=_FixedRng(0.0), state=chat_state, chance=1.0, cooldown=180))
                self.assertEqual(len(chat_state["chats"]), 1)
                self.assertNotIn(CHAT_ON, chat_state["chats"])
                # Evicted chat has no cooldown entry left, so it reacts immediately.
                self.assertIsNotNone(reactions.choose("goodnight", CHAT_ON, now=1020, rng=_FixedRng(0.0), state=chat_state, chance=1.0, cooldown=180))

    def test_skip_rules_broadcast_status_own_empty_and_slash(self):
        with self.env():
            for bad_chat in ("status@broadcast", "0000000000@broadcast", "status@g.us"):
                self.assertIsNone(reactions.choose("goodnight!", bad_chat, now=1000, rng=_FixedRng(0.0), state=self.state, chance=1.0))
                raw_bad = {
                    "chatId": bad_chat,
                    "body": "goodnight!",
                    "readReceiptKey": {"id": f"m-{bad_chat}", "remoteJid": bad_chat, "fromMe": False},
                }
                self.assertIsNone(reactions.react_to(raw_bad, sender=lambda *_: None, now=1000, state=self.state, chance=1.0))
            raw_remote_status = {
                "chatId": CHAT_ON,
                "body": "goodnight!",
                "readReceiptKey": {"id": "m-status-remote", "remoteJid": "status@broadcast", "fromMe": False},
            }
            self.assertIsNone(reactions.react_to(raw_remote_status, sender=lambda *_: None, now=1000, state=self.state, chance=1.0))
            for raw_skip in (
                {"chatId": CHAT_ON, "body": "goodnight!", "readReceiptKey": {"id": "m-own-1", "remoteJid": CHAT_ON, "fromMe": True}},
                {"chatId": CHAT_ON, "body": "goodnight!", "fromMe": True, "readReceiptKey": {"id": "m-own-2", "remoteJid": CHAT_ON, "fromMe": False}},
                {"chatId": CHAT_ON, "body": "goodnight!", "fromOwner": True, "readReceiptKey": {"id": "m-own-3", "remoteJid": CHAT_ON, "fromMe": False}},
                {"chatId": CHAT_ON, "body": "   \n", "readReceiptKey": {"id": "m-empty", "remoteJid": CHAT_ON, "fromMe": False}},
                {"chatId": CHAT_ON, "body": f"[HERMES-SCOPE chat={CHAT_ON}]\n/remind me", "readReceiptKey": {"id": "m-slash", "remoteJid": CHAT_ON, "fromMe": False}},
            ):
                self.assertIsNone(reactions.react_to(raw_skip, sender=lambda *_: None, now=1000, state=self.state, chance=1.0))

    def test_retry_once_on_connection_error_and_5xx_then_give_up_no_retry_on_4xx(self):
        key = {"id": "msg-http", "remoteJid": CHAT_ON, "fromMe": False}

        # 503 then 200 -> succeeds on retry after 1 s sleep with 5 s timeout each.
        with mock.patch("brain.reactions.time.sleep") as sleep_mock, \
             mock.patch("urllib.request.urlopen", side_effect=[
                 urllib.error.HTTPError("http://127.0.0.1:3000/react", 503, "down", {}, io.BytesIO(b"")),
                 _FakeResponse(200),
             ]) as open_mock:
            self.assertTrue(reactions.post_reaction(key, "🌙", port=3000))
        self.assertEqual(open_mock.call_count, 2)
        for call in open_mock.call_args_list:
            self.assertEqual(call.kwargs["timeout"], 5.0)
        sleep_mock.assert_called_once_with(1.0)

        # Connection error twice -> retries once, logs warning, returns False.
        with mock.patch("brain.reactions.time.sleep") as sleep_mock, \
             mock.patch("urllib.request.urlopen", side_effect=[
                 urllib.error.URLError(ConnectionRefusedError("refused")),
                 urllib.error.URLError(ConnectionRefusedError("refused")),
             ]) as open_mock, \
             self.assertLogs("aira.reactions", level="WARNING") as logs:
            self.assertFalse(reactions.post_reaction(key, "🌙", port=3000))
        self.assertEqual(open_mock.call_count, 2)
        sleep_mock.assert_called_once_with(1.0)
        self.assertEqual(len(logs.output), 1)
        self.assertIn("URLError", logs.output[0])

        # 500 twice -> retries once, logs warning with error class and status 500.
        with mock.patch("brain.reactions.time.sleep") as sleep_mock, \
             mock.patch("urllib.request.urlopen", side_effect=[
                 urllib.error.HTTPError("http://127.0.0.1:3000/react", 500, "err", {}, io.BytesIO(b"")),
                 urllib.error.HTTPError("http://127.0.0.1:3000/react", 500, "err", {}, io.BytesIO(b"")),
             ]) as open_mock, \
             self.assertLogs("aira.reactions", level="WARNING") as logs:
            self.assertFalse(reactions.post_reaction(key, "🌙", port=3000))
        self.assertEqual(open_mock.call_count, 2)
        sleep_mock.assert_called_once_with(1.0)
        self.assertIn("HTTPError", logs.output[0])
        self.assertIn("500", logs.output[0])

        # 400 -> no retry, logs warning with status 400.
        with mock.patch("brain.reactions.time.sleep") as sleep_mock, \
             mock.patch("urllib.request.urlopen", side_effect=[
                 urllib.error.HTTPError("http://127.0.0.1:3000/react", 400, "bad", {}, io.BytesIO(b"")),
             ]) as open_mock, \
             self.assertLogs("aira.reactions", level="WARNING") as logs:
            self.assertFalse(reactions.post_reaction(key, "🌙", port=3000))
        self.assertEqual(open_mock.call_count, 1)
        sleep_mock.assert_not_called()
        self.assertIn("400", logs.output[0])

    def test_no_function_raises_on_invalid_inputs_or_broken_deps(self):
        class _BadStr:
            def __str__(self):
                raise RuntimeError("bad str")

        self.assertIsNone(reactions.category(_BadStr()))
        self.assertEqual(reactions.strip_stamp(_BadStr()), "")
        with mock.patch.dict(os.environ, {"AIRA_BRIDGE_PORT": "not-a-port"}):
            self.assertEqual(reactions.bridge_port(), 3000)
        with mock.patch.object(chatflags, "reactions_on", side_effect=RuntimeError("boom")):
            self.assertIsNone(reactions.choose("goodnight!", CHAT_ON, state=self.state))
        self.assertIsNone(reactions.choose("goodnight!", CHAT_ON, now="bad", state=self.state))
        self.assertIsNone(reactions.choose("goodnight!", CHAT_ON, rng=object(), state="bad"))
        self.assertIsNone(reactions.react_to(None))
        self.assertIsNone(reactions.react_to({"readReceiptKey": "bad"}))
        with self.env(), \
             mock.patch("threading.Thread", side_effect=RuntimeError("thread error")), \
             self.assertLogs("aira.reactions", level="WARNING"):
            raw = {
                "chatId": CHAT_ON,
                "body": "goodnight!",
                "readReceiptKey": {"id": "m-thread-err", "remoteJid": CHAT_ON, "fromMe": False},
            }
            self.assertIsNone(reactions.react_to(raw, state=self.state, chance=1.0))
        with self.assertLogs("aira.reactions", level="WARNING"):
            self.assertFalse(reactions.post_reaction({"bad": object()}, "🌙"))

    def test_react_to_retries_sender_once_on_connection_error(self):
        calls = []
        done = threading.Event()

        def flaky_sender(key, emoji, port):
            calls.append((key, emoji, port))
            if len(calls) == 2:
                done.set()
            raise ConnectionRefusedError("refused")

        raw = {
            "chatId": CHAT_ON,
            "body": "goodnight!",
            "readReceiptKey": {"id": "m-sender-retry", "remoteJid": CHAT_ON, "fromMe": False},
        }
        with self.env(), \
             mock.patch("brain.reactions.time.sleep") as sleep_mock, \
             self.assertLogs("aira.reactions", level="WARNING") as logs:
            chosen = reactions.react_to(raw, port=3100, sender=flaky_sender, now=1000, rng=_FixedRng(0.0), state=self.state, chance=1.0)
            self.assertIsNotNone(chosen)
            self.assertTrue(done.wait(timeout=2.0))
            for t in threading.enumerate():
                if t.name == "aira-react":
                    t.join(timeout=2.0)
        self.assertEqual(len(calls), 2)
        sleep_mock.assert_called_once_with(1.0)
        self.assertIn("ConnectionRefusedError", logs.output[0])

    def test_logs_never_contain_id_emoji_key_or_message_text(self):
        secret_msg_id = "mid-secret-999"
        secret_text = "making ramen because secret-phrase-xyz"
        raw = {
            "chatId": CHAT_ON,
            "body": secret_text,
            "readReceiptKey": {"id": secret_msg_id, "remoteJid": CHAT_ON, "fromMe": False},
        }
        with self.env(), \
             mock.patch("brain.reactions.time.sleep"), \
             mock.patch("urllib.request.urlopen", side_effect=urllib.error.HTTPError(
                 f"http://127.0.0.1:3000/react?id={secret_msg_id}", 502, secret_text, {}, io.BytesIO(b"")
             )), \
             self.assertLogs("aira.reactions", level=logging.DEBUG) as logs:
            chosen = reactions.react_to(raw, port=3000, now=1000, rng=_FixedRng(0.0), state=self.state, chance=1.0)
            reactions.choose("just chatting", CHAT_ON, now=2000, state=self.state)
            reactions.post_reaction(raw["readReceiptKey"], chosen, port=3000)
            # Wait briefly for daemon thread to finish its mocked send.
            for t in threading.enumerate():
                if t.name == "aira-react":
                    t.join(timeout=2.0)

        self.assertIn(chosen, ("🍳", "🍵", "🍙"))
        joined = "\n".join(logs.output)
        for forbidden in (CHAT_ON, CHAT_OTHER, secret_msg_id, secret_text, "secret-phrase-xyz", "food", "🍳", "🍵", "🍙"):
            self.assertNotIn(forbidden, joined)
        self.assertIn("HTTPError", joined)
        self.assertIn("502", joined)


if __name__ == "__main__":
    unittest.main()
