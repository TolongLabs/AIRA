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
DM = "fixture-dm"


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
        flags = {"version": 1, "chats": {GROUP: {"autofetch": True}, DM: {"autofetch": True}, OTHER: {"reactions": True}}}
        (Path(self.dir.name) / "gateway" / "chats.json").write_text(json.dumps(flags), encoding="utf-8")
        patcher = mock.patch.dict(os.environ, {"AIRA_HOST_DATA_DIR": self.dir.name, "AIRA_CORE_URL": ""})
        patcher.start()
        self.addCleanup(patcher.stop)

    def message(self, **overrides):
        data = {"isGroup": True, "chatId": GROUP, "body": "look https://x.com/someone/status/1", "fromMe": False}
        data.update(overrides)
        return data

    def test_offers_a_group_or_dm_message_with_a_link_in_a_chat_with_autofetch_on(self):
        self.assertEqual(autofetch.wanted(self.message()), GROUP)
        self.assertEqual(autofetch.wanted(self.message(isGroup=False, chatId=DM), accepted=True), DM)
        self.assertIsNone(autofetch.wanted(self.message(isGroup=False, chatId=DM)))
        self.assertIsNone(autofetch.wanted(self.message(), accepted=True))
        self.assertIsNone(autofetch.wanted(self.message(chatId=OTHER)))
        self.assertIsNone(autofetch.wanted(self.message(isGroup=False, chatId=OTHER), accepted=True))
        self.assertIsNone(autofetch.wanted(self.message(body="no link here")))
        self.assertIsNone(autofetch.wanted(self.message(isGroup=False, chatId=DM, body="no link here"), accepted=True))
        self.assertIsNone(autofetch.wanted(self.message(fromMe=True)))
        self.assertIsNone(autofetch.wanted(self.message(isGroup=False, chatId=DM, fromMe=True), accepted=True))
        self.assertIsNone(autofetch.wanted(self.message(fromOwner="true")))
        self.assertIsNone(autofetch.wanted("not a dict"))

    def test_asks_the_core_for_ordered_files_and_delivery_key(self):
        seen = {}
        key = "00000000-0000-4000-8000-000000000001"

        def opener(request, timeout):
            seen["url"] = request.full_url
            seen["body"] = json.loads(request.data.decode("utf-8"))
            seen["timeout"] = timeout
            answer = {
                "deliveryKey": key,
                "media": [
                    {"kind": "image", "path": "/data/cache/autofetch/a.jpg"},
                    {"kind": "video", "path": "/data/cache/autofetch/b.mp4"},
                ]
            }
            return _Response(json.dumps(answer).encode("utf-8"))

        media, received_key = autofetch.ask_core(GROUP, "look https://x.com/someone/status/1", opener=opener)

        self.assertEqual(seen["url"], "http://127.0.0.1:9881/v1/aira/autofetch")
        self.assertEqual(seen["body"], {"chat": GROUP, "text": "look https://x.com/someone/status/1"})
        self.assertEqual(seen["timeout"], 90.0)
        self.assertEqual(received_key, key)
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

        self.assertEqual(autofetch.ask_core(GROUP, "x", opener=broken), ([], None))
        self.assertEqual(autofetch.ask_core(GROUP, "x", opener=lambda r, timeout: _Response(b"not json")), ([], None))

    def test_a_media_field_that_is_not_a_list_returns_no_key(self):
        for media in (123, "bad", {"kind": "image"}):
            body = json.dumps({"media": media, "deliveryKey": "00000000-0000-4000-8000-000000000001"}).encode()
            opener = lambda request, timeout, body=body: _Response(body)  # noqa: E731
            self.assertEqual(autofetch.ask_core(GROUP, "https://x.com/a/status/1", opener=opener), ([], None))

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
        self.assertEqual(sent, [False, True, True])
        self.assertEqual(
            adapter.sent,
            [("video", GROUP, "/c/v.mp4"), ("image", GROUP, "/c/a.jpg"), ("image", GROUP, "/c/b.jpg")],
        )

    def test_offer_runs_the_whole_job_in_the_background(self):
        adapter = _Adapter()
        answer = ([{"kind": "image", "path": "/c/a.jpg"}], "key")

        async def scenario():
            with (
                mock.patch.object(autofetch, "ask_core", return_value=answer) as ask,
                mock.patch.object(autofetch, "_delivery", return_value=True) as delivery,
            ):
                autofetch.offer(adapter, self.message())
                autofetch.offer(adapter, self.message(chatId=OTHER))
                await asyncio.gather(*list(autofetch._tasks))
                self.assertEqual(delivery.call_args_list, [
                    mock.call("claim", {"key": "key"}),
                    mock.call("complete", {"key": "key", "outcomes": [True]}),
                ])
                return ask.call_args_list

        calls = asyncio.run(scenario())
        self.assertEqual([call.args[0] for call in calls], [GROUP])
        self.assertEqual(adapter.sent, [("image", GROUP, "/c/a.jpg")])

    def test_retries_a_completion_the_core_did_not_take(self):
        adapter = _Adapter()
        answer = ([{"kind": "image", "path": "/c/a.jpg"}], "key")

        async def scenario():
            with (
                mock.patch.object(autofetch, "ask_core", return_value=answer),
                mock.patch.object(autofetch, "_delivery", side_effect=[True, False, True]) as delivery,
                mock.patch.object(autofetch.asyncio, "sleep", new=mock.AsyncMock()),
            ):
                autofetch.offer(adapter, self.message())
                await asyncio.gather(*list(autofetch._tasks))
                return delivery.call_args_list

        calls = asyncio.run(scenario())
        self.assertEqual([call.args[0] for call in calls], ["claim", "complete", "complete"])

    def test_offer_outside_an_event_loop_never_raises(self):
        autofetch.offer(_Adapter(), self.message())


if __name__ == "__main__":
    unittest.main()
