"""Stock Hermes native WhatsApp HTTP transport against a local fake bridge.

No real bridge process, credentials, account, or outbound network is involved.
This is not a pairing or a live WhatsApp delivery test.
"""

from unittest.mock import AsyncMock

import aiohttp
from aiohttp import web
import pytest

from gateway.platforms.base import SendResult
from tests.gateway.test_whatsapp_formatting import _make_adapter


@pytest.mark.asyncio
async def test_native_send_uses_only_the_selected_local_bridge(tmp_path, monkeypatch):
    calls = []
    token = "synthetic-bridge-token"

    async def bridge(request):
        assert request.headers.get("Authorization") == "Bearer " + token
        payload = await request.json()
        calls.append((request.path, payload))
        if payload.get("message") == "fixture-failed":
            return web.Response(status=503, text="synthetic transport unavailable")
        if payload.get("message") == "fixture-ambiguous":
            return web.json_response({})
        return web.json_response({"messageId": "fixture-confirmed"})

    app = web.Application()
    app.router.add_post("/send", bridge)
    app.router.add_post("/send-media", bridge)
    runner = web.AppRunner(app)
    await runner.setup()
    site = web.TCPSite(runner, "127.0.0.1", 0)
    await site.start()
    try:
        adapter = _make_adapter()
        adapter._bridge_port = runner.addresses[0][1]
        monkeypatch.setattr(adapter, "_check_managed_bridge_exit", AsyncMock(return_value=None))
        monkeypatch.setattr("gateway.rich_sent_store.record_media_async", AsyncMock())
        monkeypatch.setenv("WHATSAPP_MODE", "bot")
        monkeypatch.delenv("WHATSAPP_REPLY_PREFIX", raising=False)
        document = tmp_path / "fixture.pdf"
        document.write_bytes(b"synthetic document")

        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + token}) as session:
            adapter._http_session = session
            dm = await adapter.send("fixture-a@lid", "fixture-dm")
            group = await adapter.send("fixture-group@g.us", "fixture-group")
            file = await adapter.send_document("fixture-group@g.us", str(document), file_name="fixture.pdf")
            failed = await adapter.send("fixture-a@lid", "fixture-failed")
            ambiguous = await adapter.send("fixture-a@lid", "fixture-ambiguous")

        for result in (dm, group, file):
            assert isinstance(result, SendResult) and result.success and result.message_id == "fixture-confirmed"
        assert not failed.success and failed.message_id is None
        assert ambiguous.success and ambiguous.message_id is None
        assert calls == [
            ("/send", {"chatId": "fixture-a@lid", "message": "fixture-dm"}),
            ("/send", {"chatId": "fixture-group@g.us", "message": "fixture-group"}),
            ("/send-media", {"chatId": "fixture-group@g.us", "filePath": str(document),
                             "mediaType": "document", "fileName": "fixture.pdf"}),
            ("/send", {"chatId": "fixture-a@lid", "message": "fixture-failed"}),
            ("/send", {"chatId": "fixture-a@lid", "message": "fixture-ambiguous"}),
        ]
    finally:
        await runner.cleanup()
