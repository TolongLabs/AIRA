"""Exact stock Hermes admitted turn -> native WhatsApp transport -> fake local bridge."""

import base64
import hashlib
import json
import stat
import uuid
from pathlib import Path
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
async def test_report_document_uses_native_send_once_and_removes_private_file(tmp_path, monkeypatch):
    monkeypatch.setenv("WHATSAPP_ALLOWED_USERS", "*")
    monkeypatch.setenv("WHATSAPP_MODE", "bot")
    monkeypatch.delenv("WHATSAPP_REPLY_PREFIX", raising=False)
    monkeypatch.setattr("gateway.rich_sent_store.record_media_async", AsyncMock())
    route_id = str(uuid.uuid4())
    token = "ab" * 32
    bridge_token = "synthetic-bridge-token"
    issued = {}
    claimed = set()
    acknowledged = []
    calls = []
    sent_text, sent_documents, paths = [], [], []

    def content(mid):
        if mid == "pdf":
            return "application/pdf", "report.pdf", b"%PDF-1.4\nfixture-pdf\n"
        return "text/markdown", "report.md", ("# fixture-" + mid + "\n").encode()

    async def endpoint(request):
        assert request.headers.get("Authorization") == "Bearer " + token
        body = await request.json()
        assert body["schemaVersion"] == 2 and body["profile"] == "fixture" and body["routeId"] == route_id
        calls.append((request.path, body))
        chat, mid = body["chat"], body["mid"]
        if request.path.endswith("/turn"):
            if mid == "silent":
                return web.json_response({"schemaVersion": 2, "disposition": "no_reply", "deliveries": []})
            descriptors = [{"id": issued.setdefault((chat, mid, kind), str(uuid.uuid4())), "kind": kind}
                           for kind in ("text", "document")]
            return web.json_response({"schemaVersion": 2, "disposition": "reply", "deliveries": descriptors})
        identity = next(key for key, value in issued.items() if value == body["id"])
        assert identity[:2] == (chat, mid)
        kind = identity[2]
        if request.path.endswith("/claim"):
            if body["id"] in claimed:
                return web.Response(status=409)
            claimed.add(body["id"])
            delivery = {"id": body["id"], "kind": kind}
            if kind == "text":
                delivery["text"] = "fixture-" + mid
            else:
                mime, filename, data = content(mid)
                delivery.update(mime=mime, filename=filename, base64=base64.b64encode(data).decode(),
                                sha256="f" * 64 if mid == "bad-hash" else hashlib.sha256(data).hexdigest())
            return web.json_response({"schemaVersion": 2, "delivery": delivery})
        assert request.path.endswith("/ack") and body["id"] in claimed
        acknowledged.append((chat, mid, kind, body["outcome"]))
        return web.json_response({"schemaVersion": 2, "accepted": True})

    async def bridge(request):
        assert request.headers.get("Authorization") == "Bearer " + bridge_token
        body = await request.json()
        chat = body["chatId"]
        if request.path == "/send":
            mid = body["message"].removeprefix("fixture-")
            assert issued[(chat, mid, "text")] in claimed
            sent_text.append((chat, mid))
        else:
            path = Path(body["filePath"])
            data = path.read_bytes()
            mid = "pdf" if data.startswith(b"%PDF-") else data.decode().strip().removeprefix("# fixture-")
            _, filename, expected = content(mid)
            assert data == expected and path.name == filename and body["fileName"] == filename
            assert body["mediaType"] == "document" and issued[(chat, mid, "document")] in claimed
            assert stat.S_IMODE(path.stat().st_mode) == 0o600
            assert stat.S_IMODE(path.parent.stat().st_mode) == 0o700
            paths.append(path)
            sent_documents.append((chat, mid))
            if mid == "ambiguous":
                return web.Response(status=503, text="synthetic unavailable")
        return web.json_response({"messageId": "fixture-native-confirmed"})

    app = web.Application()
    for path in ("/v2/aira/turn", "/v2/aira/delivery/claim", "/v2/aira/delivery/ack"):
        app.router.add_post(path, endpoint)
    app.router.add_post("/send", bridge)
    app.router.add_post("/send-media", bridge)
    server = web.AppRunner(app)
    await server.setup()
    await web.TCPSite(server, "127.0.0.1", 0).start()
    try:
        profile = tmp_path / "profiles" / "fixture"
        profile.mkdir(parents=True)
        marker = profile / "aira-transport.json"
        marker_value = {"schemaVersion": 2, "profile": "fixture", "profileHome": str(profile),
                        "port": server.addresses[0][1], "token": token, "state": "active",
                        "routeId": route_id, "capabilities": ["text", "document"]}
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

        async def deliver(chat, sender, mid, kind="dm"):
            source = SessionSource(platform=Platform.WHATSAPP, chat_id=chat, user_id=sender, chat_type=kind)
            event = MessageEvent(text="request", source=source, message_id=mid)
            await intake._process_message_background(event, build_session_key(source))

        dm, group = "fixture-a@lid", "fixture-group@g.us"
        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + bridge_token}) as session:
            native._http_session = session
            with _profile_runtime_scope(profile):
                await deliver(dm, dm, "markdown")
                await deliver(group, "fixture-b@lid", "pdf", kind="group")
                await deliver(dm, dm, "ambiguous")
                await deliver(dm, dm, "ambiguous")
                await deliver(dm, dm, "bad-hash")
                await deliver(dm, dm, "silent")
                before = len(calls)
                marker.write_text(json.dumps({**marker_value, "state": "provisional", "routeId": None}))
                await deliver(dm, dm, "inert")
                assert len(calls) == before
        assert sent_text == [(dm, "markdown"), (group, "pdf"), (dm, "ambiguous"), (dm, "bad-hash")]
        assert sent_documents == [(dm, "markdown"), (group, "pdf"), (dm, "ambiguous")]
        assert len(paths) == 3 and all(not path.parent.exists() for path in paths)
        assert [(mid, outcome) for _, mid, kind, outcome in acknowledged if kind == "document"] == [
            ("markdown", "confirmed"), ("pdf", "confirmed"), ("ambiguous", "unknown")]
        assert not foreign.sent and not intake.sent
        runner._handle_message_with_agent.assert_not_awaited()
    finally:
        await server.cleanup()
