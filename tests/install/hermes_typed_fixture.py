"""Actual pinned runner, typed adapter, native WhatsApp HTTP send, and local fake endpoints."""

import json
import uuid
from unittest.mock import AsyncMock

import aiohttp
from aiohttp import web
import pytest

from gateway.config import Platform
from gateway.platforms.event import MessageEvent
from gateway.run import _profile_runtime_scope
from gateway.session import SessionSource, build_session_key
from tests.gateway.test_media_resend_dedup import _DummyAdapter, _hold_typing
from tests.gateway.test_post_gateway_admission import _runner
from tests.gateway.test_whatsapp_formatting import _make_adapter


@pytest.mark.asyncio
async def test_typed_route_claims_before_native_send_and_never_falls_back(tmp_path, monkeypatch):
    monkeypatch.setenv("WHATSAPP_ALLOWED_USERS", "*")
    monkeypatch.setenv("WHATSAPP_MODE", "bot")
    monkeypatch.delenv("WHATSAPP_REPLY_PREFIX", raising=False)
    route_id = str(uuid.uuid4())
    token = "ab" * 32
    bridge_token = "synthetic-bridge-token"
    issued = {}
    claimed = set()
    acknowledged = []
    calls = []

    async def endpoint(request):
        assert request.headers.get("Authorization") == "Bearer " + token
        body = await request.json()
        assert body["schemaVersion"] == 2 and body["profile"] == "fixture" and body["routeId"] == route_id
        calls.append((request.path, body))
        if request.path == "/v2/aira/turn":
            if body["text"] == "silent":
                return web.json_response({"schemaVersion": 2, "disposition": "no_reply", "deliveries": []})
            key = (body["chat"], body["mid"])
            delivery_id = issued.setdefault(key, str(uuid.uuid4()))
            return web.json_response({"schemaVersion": 2, "disposition": "reply", "deliveries": [
                {"id": delivery_id, "kind": "text"}]})
        assert body["id"] == issued[(body["chat"], body["mid"])]
        if request.path == "/v2/aira/delivery/claim":
            if body["id"] in claimed:
                return web.Response(status=409)
            claimed.add(body["id"])
            return web.json_response({"schemaVersion": 2, "delivery": {
                "id": body["id"], "kind": "text", "text": "fixture-" + body["mid"]}})
        assert request.path == "/v2/aira/delivery/ack" and body["id"] in claimed
        acknowledged.append((body["mid"], body["outcome"]))
        return web.json_response({"schemaVersion": 2, "accepted": True})

    sent = []

    async def bridge(request):
        assert request.headers.get("Authorization") == "Bearer " + bridge_token
        body = await request.json()
        sent.append(body)
        mid = body["message"].removeprefix("fixture-")
        assert issued[(body["chatId"], mid)] in claimed
        if mid == "ambiguous":
            return web.Response(status=503, text="synthetic unavailable")
        return web.json_response({"messageId": "fixture-native-confirmed"})

    app = web.Application()
    for path in ("/v2/aira/turn", "/v2/aira/delivery/claim", "/v2/aira/delivery/ack"):
        app.router.add_post(path, endpoint)
    app.router.add_post("/send", bridge)
    server = web.AppRunner(app)
    await server.setup()
    await web.TCPSite(server, "127.0.0.1", 0).start()
    try:
        profile = tmp_path / "profiles" / "fixture"
        profile.mkdir(parents=True)
        marker = profile / "aira-transport.json"
        marker_value = {"schemaVersion": 2, "profile": "fixture", "profileHome": str(profile),
                        "port": server.addresses[0][1], "token": token, "state": "active",
                        "routeId": route_id, "capabilities": ["text"]}
        marker.write_text(json.dumps(marker_value))
        marker.chmod(0o600)
        runner = _runner()
        intake = _DummyAdapter(Platform.WHATSAPP)
        intake._keep_typing = _hold_typing
        intake.set_message_handler(runner._handle_message)
        foreign = _DummyAdapter(Platform.WHATSAPP)
        runner.adapters = {Platform.WHATSAPP: foreign}
        native = _make_adapter()
        native._bridge_port = server.addresses[0][1]
        monkeypatch.setattr(native, "_check_managed_bridge_exit", AsyncMock(return_value=None))
        runner._delivery_adapter_for = lambda _source: native
        runner._intake_adapter_for = lambda _source: intake

        async def deliver(chat, sender, mid, text="request", kind="dm"):
            source = SessionSource(platform=Platform.WHATSAPP, chat_id=chat, user_id=sender, chat_type=kind)
            event = MessageEvent(text=text, source=source, message_id=mid)
            await intake._process_message_background(event, build_session_key(source))

        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + bridge_token}) as session:
            native._http_session = session
            with _profile_runtime_scope(profile):
                await deliver("fixture-a@lid", "fixture-a@lid", "dm")
                await deliver("fixture-group@g.us", "fixture-b@lid", "group", kind="group")
                await deliver("fixture-a@lid", "fixture-a@lid", "ambiguous")
                await deliver("fixture-a@lid", "fixture-a@lid", "ambiguous")
                await deliver("fixture-a@lid", "fixture-a@lid", "silent", text="silent")
                before = len(calls)
                marker.write_text(json.dumps({**marker_value, "state": "provisional", "routeId": None}))
                await deliver("fixture-a@lid", "fixture-a@lid", "inert")
                assert len(calls) == before
        assert sent == [{"chatId": "fixture-a@lid", "message": "fixture-dm"},
                        {"chatId": "fixture-group@g.us", "message": "fixture-group"},
                        {"chatId": "fixture-a@lid", "message": "fixture-ambiguous"}]
        assert acknowledged == [("dm", "confirmed"), ("group", "confirmed"), ("ambiguous", "unknown")]
        assert not foreign.sent and not intake.sent
        runner._handle_message_with_agent.assert_not_awaited()
    finally:
        await server.cleanup()
