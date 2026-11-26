"""Public stock Hermes capability evaluation; fake transport only, no account or model."""

import json
import threading
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import AsyncMock

import pytest
from gateway.config import Platform
from gateway.platforms.base import (
    SendResult, get_audio_cache_dir, get_document_cache_dir, get_image_cache_dir, get_video_cache_dir,
)
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


@pytest.mark.asyncio
async def test_stock_normalized_media_is_inert_on_the_installed_text_or_document_route(tmp_path, monkeypatch):
    # The native event builder and real post-admission hook are used. Only the endpoint and
    # delivery sink are local test doubles. No account, media service or model is contacted.
    from gateway import aira_transport

    monkeypatch.setenv("WHATSAPP_ALLOW_ALL_USERS", "true")
    monkeypatch.setenv("WHATSAPP_ALLOWED_USERS", "*")
    profile = tmp_path / "profiles" / "fixture"
    profile.mkdir(parents=True)
    typed = hasattr(aira_transport, "route_typed")
    schema = 2 if typed else 1
    capabilities = getattr(aira_transport, "CAPABILITIES", ["text"])
    token = "ab" * 32
    calls = []

    class Endpoint(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            calls.append((self.path, self.headers.get("Authorization"), body))
            result = ({"schemaVersion": 2, "disposition": "no_reply", "deliveries": []} if typed else
                      {"schemaVersion": 1, "disposition": "no_reply", "reply": None})
            data = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

    endpoint = ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
    thread = threading.Thread(target=endpoint.serve_forever, daemon=True)
    thread.start()
    try:
        marker_value = {"schemaVersion": schema, "profile": "fixture", "profileHome": str(profile),
                        "port": endpoint.server_port, "token": token}
        if typed:
            marker_value.update(state="active", routeId=str(uuid.uuid4()), capabilities=capabilities)
        marker = profile / "aira-transport.json"
        marker.write_text(json.dumps(marker_value))
        marker.chmod(0o600)

        runner = _runner()
        selected = _DummyAdapter(Platform.WHATSAPP)
        selected._keep_typing = _hold_typing
        selected.set_message_handler(runner._handle_message)
        foreign = _DummyAdapter(Platform.WHATSAPP)
        runner.adapters = {Platform.WHATSAPP: foreign}
        runner._delivery_adapter_for = lambda _source: selected
        runner._intake_adapter_for = lambda _source: selected
        native = _make_adapter()
        # The scoped secondary profile deliberately cannot inherit ambient open-DM opt-in.
        native._dm_policy = "allowlist"
        native._allow_from = {"fixture-a@lid"}
        native.config.extra["require_mention"] = False

        async def build(mid, kind="", mime="", path=None, body="fixture caption", group=False, **extra):
            chat = "fixture-group@g.us" if group else "fixture-a@lid"
            sender = "fixture-b@lid" if group else chat
            raw = {"messageId": mid, "chatId": chat, "senderId": sender, "isGroup": group,
                   "body": body, "hasMedia": path is not None, "mediaType": kind,
                   "mediaUrls": [str(path)] if path is not None else [], "mime": mime, **extra}
            event = await native._build_message_event(raw)
            assert event is not None and event.raw_message == raw
            assert (event.source.chat_id, event.source.user_id, event.message_id) == (chat, sender, mid)
            return event

        async def consume(event):
            await selected._process_message_background(event, build_session_key(event.source))

        with _profile_runtime_scope(profile):
            # A positive text event proves marker, route, runner and endpoint are operational.
            await consume(await build("text-control", body="fixture text"))
            assert len(calls) == 1
            assert calls[0][0:2] == (f"/v{schema}/aira/turn", "Bearer " + token)
            assert calls[0][2]["mid"] == "text-control"

            events = []
            direct = [
                ("image", "image/png", get_image_cache_dir() / "fixture.png", MessageType.PHOTO, False),
                ("audio", "audio/mpeg", get_audio_cache_dir() / "fixture.mp3", MessageType.AUDIO, False),
                ("ptt", "audio/ogg", get_audio_cache_dir() / "fixture.ogg", MessageType.VOICE, False),
                ("video", "video/mp4", get_video_cache_dir() / "fixture.mp4", MessageType.VIDEO, True),
                ("document", "application/pdf", get_document_cache_dir() / "fixture.pdf", MessageType.DOCUMENT, False),
            ]
            for kind, mime, path, expected, group in direct:
                # Here we verify stock metadata normalization, not decoding or content validity.
                path.write_bytes(b"synthetic fixture bytes")
                caption = "[ptt received]" if kind == "ptt" else "fixture caption"
                event = await build(kind, kind, mime, path, caption, group)
                assert event.message_type == expected
                assert event.media_urls == [str(path)] and event.media_types == [mime]
                assert event.text == ("" if kind == "ptt" else caption)
                assert event.media_text_inlined == ([False] if kind == "document" else [])
                assert event.reply_to_message_id is None
                events.append(event)

            quoted_path = get_image_cache_dir() / "quoted.png"
            quoted_path.write_bytes(b"synthetic quoted fixture")
            quoted = await build("quoted", "image", "image/png", direct[0][2], hasQuotedMessage=True,
                                 quotedMediaUrls=[str(quoted_path)], quotedMediaType="image")
            # Quote data is folded into direct arrays even without a quoted message ID.
            assert quoted.raw_message["hasQuotedMessage"] is True and quoted.reply_to_message_id is None
            assert quoted.media_urls == [str(direct[0][2]), str(quoted_path)]
            assert quoted.media_types == ["image/png", "image/jpeg"]
            events.append(quoted)

            inlined_path = get_document_cache_dir() / "doc_fixture_notes.txt"
            inlined_path.write_text("synthetic inline content")
            inlined = await build("inlined", "document", "text/plain", inlined_path, body="")
            assert inlined.media_text_inlined == [True] and "synthetic inline content" in inlined.text
            events.append(inlined)

            monkeypatch.setattr("plugins.platforms.whatsapp.adapter.cache_image_from_url",
                                AsyncMock(side_effect=RuntimeError("synthetic cache failure")))
            remote = await build("remote", "image", "image/png", "https://example.invalid/fixture.png")
            assert remote.media_urls == ["https://example.invalid/fixture.png"]
            events.append(remote)

            # Sticker and location use independent native event kinds, not ordinary text.
            sticker = await build("sticker", "sticker", "image/webp", quoted_path)
            location = await build("location", "location", body="synthetic location")
            assert sticker.message_type == MessageType.STICKER
            assert location.message_type == MessageType.LOCATION
            events.extend((sticker, location))

            for event in events:
                await consume(event)

        assert len(calls) == 1, "Unsupported inbound events must not reach the core"
        assert not selected.sent and not selected.documents and not foreign.sent and not foreign.documents
        runner._handle_message_with_agent.assert_not_awaited()
    finally:
        endpoint.shutdown()
        endpoint.server_close()
        thread.join()
