"""Typed transport envelope and one-time send boundary, without a messaging account."""

import json
import tempfile
import time
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from deploy.cli import hermes_versions, install


ROUTE = "12345678-1234-4234-8234-123456789abc"
DELIVERY = "87654321-4321-4321-8321-cba987654321"


class TypedAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        home = Path(temp.name)
        self.marker = home / "aira-transport.json"
        self.config = {"schemaVersion": 2, "profile": "default", "profileHome": str(home),
                       "port": 9881, "token": "a" * 64, "state": "active", "routeId": ROUTE,
                       "capabilities": ["text"]}
        self.write_marker()
        gateway = Path(__file__).resolve().parents[2] / "deploy/gateway"
        self.adapter = ModuleType("fixture_typed_adapter")
        rendered = hermes_versions.render_typed_helper(
            (gateway / "standalone_adapter.py").read_bytes(),
            (gateway / "standalone_typed_adapter.py").read_bytes(), "hermes-v0.23.4")
        exec(compile(rendered, "<typed-fixture>", "exec"), self.adapter.__dict__)
        self.source = SimpleNamespace(platform="whatsapp", chat_type="dm", chat_id="fixture-a@lid",
                                      user_id="fixture-a@lid", is_bot=False)
        self.event = SimpleNamespace(internal=False, media_urls=[], media_types=[], reply_expected=True,
                                     metadata={}, message_type="text", message_id="fixture-mid",
                                     sender_id=lambda: self.source.user_id, text="fixture request")
        self.selected = SimpleNamespace(send=AsyncMock(return_value=SimpleNamespace(success=True,
                                                                                     message_id="fixture-confirmed")))
        self.runner = SimpleNamespace(_delivery_adapter_for=Mock(return_value=self.selected))
        self.binding = {"schemaVersion": 2, "profile": "default", "routeId": ROUTE,
                        "chat": "fixture-a@lid", "mid": "fixture-mid", "id": DELIVERY}
        self.seen = []

    def write_marker(self):
        install.atomic_write_text(self.marker, json.dumps(self.config))

    def reply(self, _config, path, body, _timeout):
        self.seen.append((path, body))
        if path == "/v2/aira/turn":
            return {"schemaVersion": 2, "disposition": "reply", "deliveries": [{"id": DELIVERY, "kind": "text"}]}
        if path == "/v2/aira/delivery/claim":
            return {"schemaVersion": 2, "delivery": {"id": DELIVERY, "kind": "text", "text": "fixture reply"}}
        if path == "/v2/aira/delivery/ack":
            return {"schemaVersion": 2, "accepted": True}
        self.fail("Unexpected endpoint")

    async def route(self, response=None):
        with patch.object(self.adapter, "_post", side_effect=response or self.reply):
            # Direct delivery consumes the event without returning a legacy reply.
            self.assertIsNone(await self.adapter.route_typed(self.marker, self.event, self.source, self.runner))

    async def test_claim_send_ack_exact_selected_chat_once(self):
        await self.route()
        self.runner._delivery_adapter_for.assert_called_once_with(self.source)
        self.selected.send.assert_awaited_once_with("fixture-a@lid", "fixture reply")
        self.assertEqual(self.seen[1:], [("/v2/aira/delivery/claim", self.binding),
                                        ("/v2/aira/delivery/ack", {**self.binding, "outcome": "confirmed"})])

    async def test_claim_refusal_never_sends_or_falls_back(self):
        def refused(config, path, body, timeout):
            if path == "/v2/aira/delivery/claim":
                return None
            return self.reply(config, path, body, timeout)
        await self.route(refused)
        self.selected.send.assert_not_awaited()
        self.assertEqual(len(self.seen), 1)

    async def test_ambiguous_native_result_never_retries(self):
        self.selected.send.return_value = SimpleNamespace(success=True, message_id=None)
        await self.route()
        self.selected.send.assert_awaited_once()
        self.assertEqual(self.seen[-1][1]["outcome"], "unknown")

    async def test_unfinished_marker_is_inert(self):
        self.config.update(state="provisional", routeId=None)
        self.write_marker()
        await self.route()
        self.assertEqual(self.seen, [])
        self.selected.send.assert_not_awaited()

    async def test_unreviewed_descriptor_and_foreign_claim_are_not_sent(self):
        for response in ({"schemaVersion": 2, "disposition": "reply", "deliveries": [{"id": DELIVERY, "kind": "document"}]},
                         {"schemaVersion": 2, "disposition": "reply", "deliveries": [{"id": DELIVERY, "kind": "text", "chat": "other"}]}):
            await self.route(lambda *_: response)
        def foreign(config, path, body, timeout):
            if path == "/v2/aira/delivery/claim":
                return {"schemaVersion": 2, "delivery": {"id": ROUTE, "kind": "text", "text": "fixture"}}
            return self.reply(config, path, body, timeout)
        await self.route(foreign)
        self.selected.send.assert_not_awaited()

    def test_connect_handshake_checks_exact_profile_version_and_capability(self):
        self.config.update(state="provisional", routeId=None)
        self.write_marker()
        receipt = {"state": "connected", "profile": "default", "adapterVersion": "hermes-v0.23.4",
                   "verifiedAt": "2026-11-26T00:00:00.000Z", "protocolVersion": 2,
                   "routeId": ROUTE, "capabilities": ["text"]}
        with patch.object(self.adapter, "_post", return_value={"schemaVersion": 2, "hermes": receipt}) as post:
            self.assertEqual(self.adapter.typed_check(self.marker), receipt)
        self.assertEqual(post.call_args.args[1], "/v2/aira/attach-check")
        self.assertGreater(post.call_args.args[2]["deadlineMs"], int(time.time() * 1000))
        self.assertLessEqual(post.call_args.args[2]["deadlineMs"], int(time.time() * 1000) + 10_000)
        for change in ({"profile": "other"}, {"adapterVersion": "hermes-v0.23.2"},
                       {"capabilities": ["text", "document"]}, {"routeId": "invalid"}):
            with patch.object(self.adapter, "_post", return_value={"schemaVersion": 2, "hermes": {**receipt, **change}}):
                self.assertIsNone(self.adapter.typed_check(self.marker))

    def test_downgrade_names_the_current_route_and_uses_typed_deadline(self):
        self.config.update(state="provisional", routeId=None)
        self.write_marker()
        receipt = {"state": "connected", "profile": "default", "adapterVersion": "hermes-v0.23.4",
                   "verifiedAt": "2026-11-26T00:00:00.000Z"}
        with patch.object(self.adapter, "_post", return_value={"schemaVersion": 2, "hermes": receipt}) as post:
            self.assertEqual(self.adapter.typed_downgrade(self.marker, ROUTE), receipt)
        self.assertEqual(post.call_args.args[1], "/v2/aira/attach-check")
        self.assertEqual(post.call_args.args[2]["action"], "downgrade")
        self.assertEqual(post.call_args.args[2]["routeId"], ROUTE)
        self.assertGreater(post.call_args.args[2]["deadlineMs"], int(time.time() * 1000))
