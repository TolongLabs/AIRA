"""Tests for AIRA's gateway helper modules. Run: python3 -m unittest discover -s deploy/gateway/tests"""

import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain import bubbles, failure  # noqa: E402

BREAK = "⁣"


class BubblesTest(unittest.TestCase):
    def test_splits_only_at_the_core_break_lines(self):
        text = f"first bubble\n\nstill first\n{BREAK}\nsecond\n{BREAK}\nthird"
        self.assertEqual(bubbles.for_chat("whatsapp", "c1", text), ["first bubble\n\nstill first", "second", "third"])

    def test_a_reply_with_no_break_is_one_bubble_whatever_its_paragraphs(self):
        text = "one\n\ntwo\n\nthree"
        self.assertEqual(bubbles.for_chat("whatsapp", "c1", text), [text])

    def test_a_break_with_spaces_around_it_still_counts_and_empty_bubbles_are_dropped(self):
        text = f"{BREAK}\na\n  {BREAK}  \n{BREAK}\nb\n{BREAK}"
        self.assertEqual(bubbles.for_chat("whatsapp", "", text), ["a", "b"])

    def test_a_break_inside_a_line_is_not_a_break(self):
        text = f"a{BREAK}b"
        self.assertEqual(bubbles.for_chat("whatsapp", "c1", text), [text])

    def test_bad_input_is_one_message(self):
        self.assertEqual(bubbles.for_chat("whatsapp", "c1", None), [""])

    def test_typing_pause_grows_with_length_and_is_capped(self):
        self.assertAlmostEqual(bubbles.typing_pause(""), 0.1)
        self.assertAlmostEqual(bubbles.typing_pause("x" * 50), 0.6)
        self.assertEqual(bubbles.typing_pause("x" * 5000), 2.0)

    def test_interrupt_words_only(self):
        for text in ("wait", "Stop!", "hold on...", "nvm", "等一下"):
            self.assertTrue(bubbles.is_interrupt(text), text)
        for text in ("wait for me at six", "stop the reminder", ""):
            self.assertFalse(bubbles.is_interrupt(text), text)

    def test_an_interrupt_sends_nothing_more(self):
        self.assertEqual(bubbles.receipts_of(["Reminder set for 6 pm.", "more"]), "")


class FailureTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        (Path(self.dir.name) / "gateway").mkdir()
        self.file = Path(self.dir.name) / "gateway" / "unavailable.txt"

    def env(self, value):
        return mock.patch.dict(os.environ, {"AIRA_HOST_DATA_DIR": value})

    def test_a_failed_turn_gets_the_line_the_core_wrote(self):
        self.file.write_text("\nI'm away for a moment.\n", encoding="utf-8")
        with self.env(self.dir.name):
            self.assertEqual(failure.for_failed_turn({"failed": True, "error": "Timed out"}), "I'm away for a moment.")
            self.assertEqual(failure.for_exception(RuntimeError("boom")), "I'm away for a moment.")

    def test_no_data_dir_or_no_file_gets_the_neutral_line(self):
        with self.env(""):
            self.assertEqual(failure.for_failed_turn({"failed": True}), failure.NEUTRAL_LINE)
        with self.env(self.dir.name):
            self.assertEqual(failure.for_failed_turn({"failed": True}), failure.NEUTRAL_LINE)
        self.file.write_text("   \n", encoding="utf-8")
        with self.env(self.dir.name):
            self.assertEqual(failure.for_exception(ValueError()), failure.NEUTRAL_LINE)

    def test_raw_error_text_never_reaches_the_chat(self):
        with self.env(""):
            line = failure.for_failed_turn({"failed": True, "error": "HTTP 500 secret-token-123"})
        self.assertNotIn("500", line)
        self.assertNotIn("secret", line)

    def test_a_turn_that_did_not_fail_gets_no_line(self):
        with self.env(self.dir.name):
            self.assertIsNone(failure.for_failed_turn({"final_response": "hello"}))
            self.assertIsNone(failure.for_failed_turn({"failed": True, "interrupted": True}))
            self.assertIsNone(failure.for_failed_turn({"failed": True, "failure_reason": "content_policy_blocked"}))
            self.assertIsNone(failure.for_failed_turn(None))

    def test_an_empty_sentinel_reply_is_a_failure(self):
        with self.env(""):
            self.assertEqual(failure.for_failed_turn({"final_response": "(empty)"}), failure.NEUTRAL_LINE)

    def test_a_long_line_is_cut(self):
        self.file.write_text("x" * 2000, encoding="utf-8")
        with self.env(self.dir.name):
            self.assertEqual(len(failure.for_exception(RuntimeError())), failure.MAX_LINE)


if __name__ == "__main__":
    unittest.main()
