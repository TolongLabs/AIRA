"""Explicit document-capable adapter tests. No provider, bridge, or account is contacted."""

import asyncio
import base64
import hashlib
import json
import stat
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from deploy.cli import install


ROUTE = "12345678-1234-4234-8234-123456789abc"
TEXT = "87654321-4321-4321-8321-cba987654321"
DOCUMENT = "11111111-2222-4333-8444-555555555555"
DATA = b"# Synthetic report\n"


class DocumentAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        home = Path(temp.name)
        self.marker = home / "aira-transport.json"
        self.config = {"schemaVersion": 2, "profile": "default", "profileHome": str(home),
                       "port": 9881, "token": "a" * 64, "state": "active", "routeId": ROUTE,
                       "capabilities": ["text", "document"]}
        self.write_marker()
        gateway = Path(__file__).resolve().parents[2] / "deploy/gateway"
        baseline = (gateway / "standalone_adapter.py").read_bytes()
        suffix = (gateway / "standalone_document_adapter.py").read_bytes()
        main = b'if __name__ == "__main__":\n    sys.exit(main())\n'
        self.assertTrue(baseline.endswith(main))
        self.adapter = ModuleType("fixture_document_adapter")
        exec(compile(baseline[:-len(main)] + suffix + b"\n\n" + main, "<document-fixture>", "exec"), self.adapter.__dict__)
        self.source = SimpleNamespace(platform="whatsapp", chat_type="dm", chat_id="fixture-a@lid",
                                      user_id="fixture-a@lid", is_bot=False)
        self.event = SimpleNamespace(internal=False, media_urls=[], media_types=[], reply_expected=True,
                                     metadata={}, message_type="text", message_id="fixture-mid",
                                     sender_id=lambda: self.source.user_id, text="fixture request")
        self.result = SimpleNamespace(success=True, message_id="fixture-confirmed")
        self.selected = SimpleNamespace(send=AsyncMock(return_value=self.result), send_document=AsyncMock())
        self.runner = SimpleNamespace(_delivery_adapter_for=Mock(return_value=self.selected))
        self.seen = []
        self.fail_text_ack = False
        self.paths = []
        self.document = {"id": DOCUMENT, "kind": "document", "mime": "text/markdown",
                         "filename": "report.md", "sha256": hashlib.sha256(DATA).hexdigest(),
                         "base64": base64.b64encode(DATA).decode("ascii")}
        self.descriptors = [{"id": TEXT, "kind": "text"}, {"id": DOCUMENT, "kind": "document"}]

        async def send_document(chat, path, *, file_name):
            target = Path(path)
            self.paths.append(target)
            self.assertEqual((chat, file_name, target.name), (self.source.chat_id, "report.md", "report.md"))
            self.assertEqual(stat.S_IMODE(target.parent.stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE(target.stat().st_mode), 0o600)
            self.assertEqual(target.read_bytes(), DATA)
            return self.result

        self.selected.send_document.side_effect = send_document

    def write_marker(self):
        install.atomic_write_text(self.marker, json.dumps(self.config))

    def post(self, _config, path, body, _timeout):
        self.seen.append((path, body))
        if path.endswith("/turn"):
            return {"schemaVersion": 2, "disposition": "reply", "deliveries": self.descriptors}
        if path.endswith("/claim"):
            return {"schemaVersion": 2, "delivery": {"id": TEXT, "kind": "text", "text": "fixture reply"}}
        if path.endswith("/ack"):
            if self.fail_text_ack and body["id"] == TEXT:
                raise ConnectionError("synthetic lost acknowledgement")
            return {"schemaVersion": 2, "accepted": True}
        self.fail("Unexpected endpoint")

    def document_post(self, _config, path, body, _timeout):
        self.seen.append((path, body))
        return {"schemaVersion": 2, "delivery": self.document}

    async def route(self):
        with (patch.object(self.adapter, "_post", side_effect=self.post),
              patch.object(self.adapter, "_post_document_claim", side_effect=self.document_post)):
            self.assertIsNone(await self.adapter.route_typed(self.marker, self.event, self.source, self.runner))

    async def test_text_and_document_each_once_and_private_file_removed(self):
        await self.route()
        self.selected.send.assert_awaited_once_with(self.source.chat_id, "fixture reply")
        self.selected.send_document.assert_awaited_once()
        self.assertEqual(len(self.paths), 1)
        self.assertFalse(self.paths[0].parent.exists())
        claims = [body for path, body in self.seen if path.endswith("/claim")]
        self.assertEqual([row["id"] for row in claims], [TEXT, DOCUMENT])
        self.assertTrue(all(row["chat"] == self.source.chat_id and row["routeId"] == ROUTE for row in claims))
        acks = [body for path, body in self.seen if path.endswith("/ack")]
        self.assertEqual([(row["id"], row["outcome"]) for row in acks], [(TEXT, "confirmed"), (DOCUMENT, "confirmed")])


    async def test_lost_text_ack_does_not_stop_independent_document_claim(self):
        self.fail_text_ack = True
        await self.route()
        self.selected.send.assert_awaited_once()
        self.selected.send_document.assert_awaited_once()
        self.assertEqual(self.seen[-1][1]["id"], DOCUMENT)
        self.assertEqual(self.seen[-1][1]["outcome"], "confirmed")

    async def test_no_native_target_acknowledges_definite_failure(self):
        self.runner._delivery_adapter_for.return_value = None
        await self.route()
        self.selected.send.assert_not_awaited()
        self.selected.send_document.assert_not_awaited()
        self.assertEqual([(body["id"], body["outcome"]) for path, body in self.seen if path.endswith("/ack")],
                         [(TEXT, "failed"), (DOCUMENT, "failed")])

    async def test_invalid_document_payloads_never_send(self):
        original = self.document.copy()
        for bad in ({"filename": "../report.md"}, {"mime": "image/png"}, {"sha256": "b" * 64},
                    {"base64": "not base64"}, {"base64": "A" * (7_000_000 + 1)}, {"id": ROUTE},
                    {"extra": "fixture"}, {"kind": "image"}):
            self.document = {**original, **bad}
            await self.route()
        self.selected.send_document.assert_not_awaited()

    async def test_invalid_or_foreign_descriptors_are_inert(self):
        for descriptors in ([{"id": DOCUMENT, "kind": "document"}],
                            [{"id": TEXT, "kind": "text"}, {"id": TEXT, "kind": "document"}],
                            [{"id": TEXT, "kind": "text", "chat": "other"}],
                            list(reversed(self.descriptors))):
            self.descriptors = descriptors
            await self.route()
        self.selected.send.assert_not_awaited()
        self.selected.send_document.assert_not_awaited()

    async def test_ambiguous_send_acknowledged_unknown_without_retry(self):
        self.result = SimpleNamespace(success=True, message_id=None)
        await self.route()
        self.selected.send_document.assert_awaited_once()
        self.assertEqual(self.seen[-1][1]["outcome"], "unknown")
        self.assertFalse(self.paths[0].parent.exists())

    async def test_cancelled_document_send_removes_file_and_is_not_acked(self):
        async def cancelled(_chat, path, **_):
            self.paths.append(Path(path))
            raise asyncio.CancelledError()
        self.selected.send_document.side_effect = cancelled
        with self.assertRaises(asyncio.CancelledError):
            await self.route()
        self.assertFalse(self.paths[0].parent.exists())
        self.assertFalse(any(path.endswith("/ack") and body["id"] == DOCUMENT for path, body in self.seen))

    async def test_provisional_and_text_only_markers_never_contact_core(self):
        for change in ({"state": "provisional", "routeId": None}, {"capabilities": ["text"]}):
            self.config.update(state="active", routeId=ROUTE, capabilities=["text", "document"])
            self.config.update(change)
            self.write_marker()
            await self.route()
        self.assertEqual(self.seen, [])
        self.selected.send_document.assert_not_awaited()

    def test_connect_requires_exact_document_capability(self):
        self.config.update(state="provisional", routeId=None)
        self.write_marker()
        receipt = {"state": "connected", "profile": "default", "adapterVersion": "hermes-v0.23.4",
                   "verifiedAt": "2026-11-26T00:00:00.000Z", "protocolVersion": 2,
                   "routeId": ROUTE, "capabilities": ["text", "document"]}
        with patch.object(self.adapter, "_post", return_value={"schemaVersion": 2, "hermes": receipt}) as post:
            self.assertEqual(self.adapter.typed_check(self.marker), receipt)
            self.assertEqual(post.call_args.args[2]["capabilities"], ["text", "document"])
        with patch.object(self.adapter, "_post", return_value={"schemaVersion": 2, "hermes": {**receipt, "capabilities": ["text"]}}):
            self.assertIsNone(self.adapter.typed_check(self.marker))


if __name__ == "__main__":
    unittest.main()
