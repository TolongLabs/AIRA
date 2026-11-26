"""Public stock Hermes capability evaluation; fake transport only, no account or model."""

from unittest.mock import AsyncMock

import pytest
from gateway.config import Platform
from gateway.platforms.base import SendResult, get_image_cache_dir
from gateway.platforms.event import MessageEvent, MessageType
from gateway.run import _profile_runtime_scope
from gateway.session import SessionSource, build_session_key
from tests.gateway.test_media_resend_dedup import _DummyAdapter, _hold_typing
from tests.gateway.test_post_gateway_admission import _runner
from tests.gateway.test_whatsapp_formatting import _make_adapter
from plugins.platforms.whatsapp.adapter import WhatsAppAdapter


@pytest.mark.asyncio
@pytest.mark.parametrize("method,kind,extra", [
    ("send_image_file", "image", {}),
    ("send_document", "document", {"file_name": "fixture.pdf"}),
    ("send_video", "video", {}),
    ("send_voice", "audio", {"is_voice": True}),
    ("send_voice", "document", {"is_voice": False}),
])
async def test_stock_native_file_method_payload_and_confirmed_result(tmp_path, monkeypatch, method, kind, extra):
    adapter = _make_adapter()
    monkeypatch.setattr(adapter, "_bridge_unavailable", AsyncMock(return_value=None))
    monkeypatch.setattr("gateway.rich_sent_store.record_media_async", AsyncMock())
    calls = []

    async def post(endpoint, payload, timeout):
        calls.append((endpoint, payload, timeout))
        return SendResult(success=True, message_id="fixture-confirmed")

    monkeypatch.setattr(adapter, "_post_bridge_message", post)
    attachment = tmp_path / "fixture.dat"
    attachment.write_bytes(b"synthetic file")
    result = await getattr(adapter, method)("fixture-a@lid", str(attachment), caption="fixture", **extra)
    assert isinstance(result, SendResult) and result.success and result.message_id == "fixture-confirmed"
    assert len(calls) == 1
    endpoint, payload, _timeout = calls[0]
    assert endpoint == "send-media"
    assert payload["chatId"] == "fixture-a@lid"
    assert payload["filePath"] == str(attachment)
    assert payload["mediaType"] == kind and payload["caption"] == "fixture"
    if method == "send_document":
        assert payload["fileName"] == "fixture.pdf"


@pytest.mark.asyncio
async def test_stock_cache_profile_and_failed_remote_download_are_distinct(tmp_path, monkeypatch):
    left, right = tmp_path / "profile-a", tmp_path / "profile-b"
    left.mkdir()
    right.mkdir()
    with _profile_runtime_scope(left):
        foreign = get_image_cache_dir() / "foreign.png"
        foreign.write_bytes(b"synthetic foreign")
    with _profile_runtime_scope(right):
        own = get_image_cache_dir() / "own.png"
        own.write_bytes(b"synthetic own")
        adapter = _make_adapter()
        urls, mimes = await adapter._collect_bridge_media({
            "mediaUrls": [str(own), str(foreign)], "mime": "image/png"
        }, MessageType.PHOTO)
        assert urls == [str(own)] and mimes == ["image/png"]
        # The stock adapter preserves a URL on failed caching. AIRA must not treat it as a local file.
        monkeypatch.setattr("plugins.platforms.whatsapp.adapter.cache_image_from_url",
                            AsyncMock(side_effect=RuntimeError("synthetic cache failure")))
        urls, mimes = await adapter._collect_bridge_media({
            "mediaUrls": ["https://example.invalid/synthetic.png"], "mime": "image/png"
        }, MessageType.PHOTO)
        assert urls == ["https://example.invalid/synthetic.png"] and mimes == ["image/png"]


@pytest.mark.asyncio
@pytest.mark.parametrize("confirmed", [True, False])
async def test_post_admission_selected_typed_delivery_has_no_default_duplicate(tmp_path, monkeypatch, confirmed):
    monkeypatch.setenv("WHATSAPP_ALLOWED_USERS", "*")
    runner = _runner()
    selected = _DummyAdapter(Platform.WHATSAPP)
    selected._keep_typing = _hold_typing
    selected.set_message_handler(runner._handle_message)
    unrelated = _DummyAdapter(Platform.WHATSAPP)
    runner.adapters = {Platform.WHATSAPP: unrelated}
    runner._delivery_adapter_for = lambda _source: selected
    runner._intake_adapter_for = lambda _source: selected
    file_path = tmp_path / "synthetic.pdf"
    file_path.write_bytes(b"synthetic document")
    deliveries = []

    async def send_document(chat, path, **_kwargs):
        deliveries.append((chat, path))
        return SendResult(success=confirmed, message_id="fixture-file" if confirmed else None)

    monkeypatch.setattr(selected, "send_document", send_document)

    async def consume(active_runner, event, source, _session_key):
        sink = active_runner._delivery_adapter_for(source)
        text_result = await sink.send(source.chat_id, "synthetic reply")
        assert text_result.success
        result = await sink.send_document(source.chat_id, str(file_path))
        assert result.success is confirmed
        # Typed sends are already done (or ambiguous/failed): no default string and no fallback.
        return True, None

    monkeypatch.setattr("gateway.run_inbound_consumer.run_post_admission_hook", consume)
    source = SessionSource(platform=Platform.WHATSAPP, chat_id="fixture-a@lid", chat_type="dm",
                           user_id="fixture-a@lid")
    event = MessageEvent(text="synthetic request", source=source, message_id="fixture-inbound")
    await selected._process_message_background(event, build_session_key(source))
    assert selected.sent == [{"chat_id": "fixture-a@lid", "content": "synthetic reply"}]
    assert deliveries == [("fixture-a@lid", str(file_path))]
    assert unrelated.sent == [] and unrelated.documents == []
    runner._handle_message_with_agent.assert_not_awaited()


def test_sticker_and_reaction_are_not_native_stock_send_methods():
    assert not callable(getattr(WhatsAppAdapter, "send_sticker", None))
    assert not callable(getattr(WhatsAppAdapter, "send_reaction", None))
    assert WhatsAppAdapter._classify_bridge_message({"mediaType": "sticker", "hasMedia": True}) == MessageType.STICKER
    assert callable(WhatsAppAdapter.send_poll) and callable(WhatsAppAdapter.send_location)
