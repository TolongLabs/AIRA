"""Tests for AIRA's brain.autofetch. Run: python3 -m unittest tests/test_autofetch.py"""

import asyncio
import io
import json
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from brain import autofetch  # noqa: E402

GROUP = "12345678901@g.us"
OTHER = "123456789012@g.us"


class _Response(io.BytesIO):
    def __enter__(self):
        return self

    def __exit__(self, *args):
        self.close()


class _Result:
    def __init__(self, success=True):
        self.success = success


class _Adapter:
    def __init__(self, fail_videos=False):
        self.sent = []
        self.fail_videos = fail_videos

    async def send_image_file(self, chat, path):
        self.sent.append(("image", chat, path))
        return _Result()

    async def send_video(self, chat, path):
        self.sent.append(("video", chat, path))
        if self.fail_videos:
            raise RuntimeError("bridge down")
        return _Result()


class AutofetchTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        (Path(self.dir.name) / "gateway").mkdir()
        flags = {"version": 1, "chats": {GROUP: {"autofetch": True}, OTHER: {"reactions": True}}}
        (Path(self.dir.name) / "gateway" / "chats.json").write_text(json.dumps(flags), encoding="utf-8")
        patcher = mock.patch.dict(os.environ, {"AIRA_HOST_DATA_DIR": self.dir.name, "AIRA_CORE_URL": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

    def message(self, **overrides):
        data = {"isGroup": True, "chatId": GROUP, "body": "look https://x.com/someone/status/1", "fromMe": False}
        data.update(overrides)
        return data

    def test_offers_only_a_group_message_with_a_link_in_a_chat_with_autofetch_on(self):
        self.assertEqual(autofetch.wanted(self.message()), GROUP)
        self.assertIsNone(autofetch.wanted(self.message(isGroup=False)))
        self.assertIsNone(autofetch.wanted(self.message(chatId=OTHER)))
        self.assertIsNone(autofetch.wanted(self.message(body="no link here")))
        self.assertIsNone(autofetch.wanted(self.message(fromMe=True)))
        self.assertIsNone(autofetch.wanted(self.message(fromOwner="true")))
        self.assertIsNone(autofetch.wanted("not a dict"))

    def test_asks_the_core_and_keeps_only_well_formed_files(self):
        seen = {}

        def opener(request, timeout):
            seen["url"] = request.full_url
            seen["body"] = json.loads(request.data.decode("utf-8"))
            seen["timeout"] = timeout
            answer = {
                "media": [
                    {"kind": "image", "path": "/data/cache/autofetch/a.jpg"},
                    {"kind": "audio", "path": "/data/x.mp3"},
                    {"kind": "video", "path": ""},
                    "junk",
                    {"kind": "video", "path": "/data/cache/autofetch/b.mp4"},
                ]
            }
            return _Response(json.dumps(answer).encode("utf-8"))

        media = autofetch.ask_core(GROUP, "look https://x.com/someone/status/1", opener=opener)

        self.assertEqual(seen["url"], "http://127.0.0.1:9881/v1/aira/autofetch")
        self.assertEqual(seen["body"], {"chat": GROUP, "text": "look https://x.com/someone/status/1"})
        self.assertEqual(seen["timeout"], 90.0)
        self.assertEqual(
            media,
            [
                {"kind": "image", "path": "/data/cache/autofetch/a.jpg"},
                {"kind": "video", "path": "/data/cache/autofetch/b.mp4"},
            ],
        )

    def test_a_failed_or_garbled_core_answer_sends_nothing_and_never_raises(self):
        def broken(request, timeout):
            raise OSError("connection refused")

        self.assertEqual(autofetch.ask_core(GROUP, "x", opener=broken), [])
        self.assertEqual(autofetch.ask_core(GROUP, "x", opener=lambda r, timeout: _Response(b"not json")), [])

    def test_only_a_loopback_core_url_is_used(self):
        with mock.patch.dict(os.environ, {"AIRA_CORE_URL": "http://127.0.0.1:9999/"}):
            self.assertEqual(autofetch.core_url(), "http://127.0.0.1:9999")
        with mock.patch.dict(os.environ, {"AIRA_CORE_URL": "http://203.0.113.5:9881"}):
            self.assertEqual(autofetch.core_url(), "http://127.0.0.1:9881")

    def test_sends_each_file_in_order_and_counts_what_went_out(self):
        adapter = _Adapter(fail_videos=True)
        media = [
            {"kind": "video", "path": "/c/v.mp4"},
            {"kind": "image", "path": "/c/a.jpg"},
            {"kind": "image", "path": "/c/b.jpg"},
        ]
        sent = asyncio.run(autofetch.send_all(adapter, GROUP, media))
        self.assertEqual(sent, 2)
        self.assertEqual(
            adapter.sent,
            [("video", GROUP, "/c/v.mp4"), ("image", GROUP, "/c/a.jpg"), ("image", GROUP, "/c/b.jpg")],
        )

    def test_offer_runs_the_whole_job_in_the_background(self):
        adapter = _Adapter()
        answer = [{"kind": "image", "path": "/c/a.jpg"}]

        async def scenario():
            with mock.patch.object(autofetch, "ask_core", return_value=answer) as ask:
                autofetch.offer(adapter, self.message())
                autofetch.offer(adapter, self.message(chatId=OTHER))
                await asyncio.gather(*list(autofetch._tasks))
                return ask.call_args_list

        calls = asyncio.run(scenario())
        self.assertEqual([call.args[0] for call in calls], [GROUP])
        self.assertEqual(adapter.sent, [("image", GROUP, "/c/a.jpg")])

    def test_offer_outside_an_event_loop_never_raises(self):
        autofetch.offer(_Adapter(), self.message())


if __name__ == "__main__":
    unittest.main()
