"""Direct-media helper tests with synthetic files and transport only."""

import base64
import hashlib
import json
import os
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

CAPABILITIES = ["text", "document", "receive-image", "receive-audio", "receive-video", "receive-pdf"]
ROUTE = "12345678-1234-4234-8234-123456789abc"
DELIVERY = "87654321-4321-4321-8321-cba987654321"
PNG = b"\x89PNG\r\n\x1a\nfixture"


class DirectMediaAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name) / "profiles" / "fixture"
        self.home.mkdir(parents=True)
        self.marker = self.home / "aira-transport.json"
        self.config = {"schemaVersion": 2, "profile": "fixture", "profileHome": str(self.home),
                       "port": 9881, "token": "a" * 64, "state": "active", "routeId": ROUTE,
                       "capabilities": CAPABILITIES}
        self.marker.write_text(json.dumps(self.config))
        self.marker.chmod(0o600)
        gateway = Path(__file__).resolve().parents[2] / "deploy/gateway"
        baseline = (gateway / "standalone_adapter.py").read_bytes()
        document = (gateway / "standalone_document_adapter.py").read_bytes()
        media = (gateway / "standalone_media_adapter.py").read_bytes()
        main = b'if __name__ == "__main__":\n    sys.exit(main())\n'
        self.adapter = ModuleType("fixture_media_adapter")
        script = baseline[:-len(main)] + document.rstrip(b"\n") + b"\n\n" + media.rstrip(b"\n") + b"\n\n" + main
        exec(compile(script, "<media-fixture>", "exec"), self.adapter.__dict__)
        self.source = SimpleNamespace(platform="whatsapp", chat_type="dm", chat_id="fixture-a@lid",
                                      user_id="fixture-a@lid", is_bot=False, profile="fixture",
                                      message_id="fixture-mid")
        self.selected = SimpleNamespace(send=AsyncMock(return_value=SimpleNamespace(success=True, message_id="sent")))
        self.runner = SimpleNamespace(_delivery_adapter_for=Mock(return_value=self.selected))
        self.seen = []

    def cache(self, folder, name, data):
        path = self.home / folder / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(data)
        return path

    def event(self, native="imageMessage", kind="image", normalized="photo", mime="image/png",
              path=None, text="[image received]", native_metadata=None):
        native_metadata = native_metadata or {}
        urls = [str(path)] if path else []
        raw = {"messageId": "fixture-mid", "chatId": self.source.chat_id,
               "senderId": self.source.user_id, "isGroup": False, "nativeType": native,
               "nativeMetadata": native_metadata, "hasMedia": bool(path), "mediaType": kind,
               "mediaUrls": urls.copy(), "mime": mime, "body": text}
        metadata = {"whatsapp_native_type": native}
        if native_metadata:
            metadata["whatsapp_native"] = native_metadata.copy()
        return SimpleNamespace(internal=False, media_urls=urls, media_types=[mime] if path else [],
                               reply_expected=True, metadata=metadata, message_type=normalized,
                               message_id="fixture-mid", sender_id=lambda: self.source.user_id,
                               source=self.source, text=text, raw_message=raw,
                               media_text_inlined=[False] if normalized == "document" else [],
                               reply_to_message_id=None, reply_to_text=None, reply_to_author_id=None,
                               reply_to_author_name=None, reply_to_is_own_message=False)

    def post(self, _config, path, body, _timeout):
        self.seen.append((path, body))
        if path.endswith("/turn") or path.endswith("/media-turn"):
            return {"schemaVersion": 2, "disposition": "reply", "deliveries": [{"id": DELIVERY, "kind": "text"}]}
        if path.endswith("/claim"):
            return {"schemaVersion": 2, "delivery": {"id": DELIVERY, "kind": "text", "text": "fixture reply"}}
        if path.endswith("/ack"):
            return {"schemaVersion": 2, "accepted": True}
        self.fail("Unexpected endpoint")

    async def route(self, event):
        with (patch.object(self.adapter, "_post", side_effect=self.post),
              patch.object(self.adapter, "_post_media", side_effect=self.post, create=True)):
            self.assertIsNone(await self.adapter.route_typed(self.marker, event, self.source, self.runner))

    async def test_native_media_encodes_exact_bytes_and_uses_typed_delivery(self):
        cases = [
            ("imageMessage", "image", "photo", "image/png", "image/png", "cache/images", "fixture.png", PNG, {}),
            ("imageMessage", "image", "photo", "image/jpeg", "image/jpeg", "image_cache", "fixture.jpg",
             b"\xff\xd8\xfffixture", {}),
            ("audioMessage", "audio", "audio", "audio/mpeg", "audio/mpeg", "cache/audio", "fixture.mp3",
             b"ID3fixture", {"audio": {"ptt": False}}),
            ("audioMessage", "ptt", "voice", "audio/ogg; codecs=opus", "audio/ogg", "audio_cache", "fixture.ogg",
             b"OggSfixture", {"audio": {"ptt": True}}),
            ("pttMessage", "ptt", "voice", "audio/ogg", "audio/ogg", "cache/audio", "voice.ogg",
             b"OggSvoice", {"audio": {"ptt": True}}),
            ("videoMessage", "video", "video", "video/mp4", "video/mp4", "cache/documents", "fixture.mp4",
             b"\x00\x00\x00\x14ftypisomfixture", {"video": {"gifPlayback": False}}),
            ("documentMessage", "document", "document", "application/pdf", "application/pdf", "document_cache",
             "private-file.pdf", b"%PDF-1.4\nfixture", {}),
        ]
        for native, kind, normalized, mime, canonical, folder, name, data, metadata in cases:
            with self.subTest(native=native, kind=kind, mime=mime):
                path = self.cache(folder, name, data)
                event = self.event(native, kind, normalized, mime, path, f"[{kind} received]", metadata)
                if normalized == "voice":
                    event.text = ""  # Stock removes the synthetic PTT caption.
                self.seen.clear()
                await self.route(event)
                self.assertEqual([path for path, _ in self.seen],
                                 ["/v2/aira/media-turn", "/v2/aira/delivery/claim", "/v2/aira/delivery/ack"])
                self.assertEqual(self.seen[0][1], {"schemaVersion": 2, "profile": "fixture", "routeId": ROUTE,
                    "platform": "whatsapp", "kind": "dm", "chat": self.source.chat_id, "sender": self.source.user_id,
                    "mid": "fixture-mid", "text": "[attachment]", "media": {
                        "kind": "voice" if kind == "ptt" else kind, "mime": canonical,
                        "sha256": hashlib.sha256(data).hexdigest(), "base64": base64.b64encode(data).decode("ascii")}})
                self.assertEqual(self.seen[-1][1]["outcome"], "confirmed")
                self.assertNotIn(str(path), json.dumps(self.seen))
        self.assertEqual(self.selected.send.await_count, len(cases))

    async def test_native_text_requires_unambiguous_native_metadata(self):
        for native in ("conversation", "extendedTextMessage"):
            event = self.event(native, "", "text", "", None, "hello")
            await self.route(event)
        self.assertEqual([path for path, _ in self.seen if path.endswith("/turn")], ["/v2/aira/turn"] * 2)
        self.seen.clear()
        for native in ("reactionMessage", "pollCreationMessage", "contactMessage", ""):
            await self.route(self.event(native, "", "text", "", None, "summary"))
        event = self.event("conversation", "", "text", "", None, "hello")
        event.metadata["whatsapp_native_type"] = "extendedTextMessage"
        await self.route(event)
        event = self.event("conversation", "", "text", "", None, "hello")
        event.text = "combined message"
        await self.route(event)
        self.assertEqual(self.seen, [])

    async def test_refuses_ambiguous_media_before_transport(self):
        path = self.cache("cache/images", "fixture.png", PNG)
        changes = [
            ("raw", {"hasQuotedMessage": True}), ("raw", {"quotedMessageId": "fixture-quote"}),
            ("raw", {"quotedMediaUrls": [str(path)]}), ("raw", {"chatId": "fixture-other@lid"}),
            ("raw", {"senderId": "fixture-other@lid"}), ("raw", {"messageId": "fixture-other-mid"}),
            ("raw", {"isGroup": True}), ("raw", {"hasMedia": False}), ("raw", {"mediaType": "sticker"}),
            ("raw", {"mime": "image/jpeg"}), ("raw", {"mediaUrls": [str(path), str(path)]}),
            ("raw", {"nativeMetadata": {"contact": {"displayName": "fixture"}}}),
            ("event", {"media_types": ["image/jpeg"]}), ("event", {"media_urls": [str(path), str(path)]}),
            ("event", {"media_text_inlined": [True]}), ("event", {"reply_to_message_id": "fixture-quote"}),
            ("event", {"reply_expected": False}), ("event", {"message_type": "text"}),
            ("event", {"metadata": {"whatsapp_native_type": "imageMessage", "whatsapp_from_owner": True}}),
        ]
        for layer, change in changes:
            with self.subTest(layer=layer, change=change):
                event = self.event(path=path)
                if layer == "raw":
                    event.raw_message.update(change)
                else:
                    vars(event).update(change)
                await self.route(event)
        self.assertEqual(self.seen, [])
        self.selected.send.assert_not_awaited()

    async def test_refuses_noncanonical_foreign_special_or_bad_media_files(self):
        path = self.cache("cache/images", "fixture.png", PNG)
        foreign = self.home.parent / "other" / "cache/images" / "fixture.png"
        foreign.parent.mkdir(parents=True)
        foreign.write_bytes(PNG)
        nested = self.cache("cache/images/subfolder", "fixture.png", PNG)
        wrong = self.cache("cache/documents", "fixture.png", PNG)
        link = path.parent / "symlink.png"
        link.symlink_to(path)
        fifo = path.parent / "pipe.png"
        os.mkfifo(fifo)
        large = path.parent / "large.png"
        with large.open("wb") as file:
            file.write(PNG)
            file.truncate(5 * 1024 * 1024 + 1)
        bad = self.cache("cache/images", "bad.png", b"bad signature")
        empty = self.cache("cache/images", "empty.png", b"")
        for candidate in (foreign, nested, wrong, link, fifo, large, bad, empty,
                          str(path.parent) + "/./fixture.png", "https://example.invalid/fixture.png"):
            with self.subTest(candidate=candidate):
                await self.route(self.event(path=candidate))
        self.assertEqual(self.seen, [])
        self.selected.send.assert_not_awaited()

    async def test_only_exact_capability_set_and_active_marker_are_admitted(self):
        path = self.cache("cache/images", "fixture.png", PNG)
        for changes in ({"capabilities": ["text", "document"]}, {"state": "provisional", "routeId": None}):
            self.marker.write_text(json.dumps({**self.config, **changes}))
            await self.route(self.event(path=path))
        self.assertEqual(self.seen, [])


if __name__ == "__main__":
    unittest.main()
