"""Synthetic direct-media route via pinned native builder, hook and native WhatsApp sends."""

import base64
import hashlib
import json
import os
import stat
import uuid
from pathlib import Path
from unittest.mock import AsyncMock

import aiohttp
import pytest
from aiohttp import web
from gateway.config import Platform
from gateway.platforms.base import (
    get_audio_cache_dir, get_document_cache_dir, get_image_cache_dir, get_video_cache_dir,
)
from gateway.platforms.event import MessageType
from gateway.run import _profile_runtime_scope
from gateway.session import build_session_key
from tests.gateway.test_media_resend_dedup import _DummyAdapter, _hold_typing
from tests.gateway.test_post_gateway_admission import _runner
from tests.gateway.test_whatsapp_formatting import _make_adapter

CAPABILITIES = ["text", "document", "receive-image", "receive-audio", "receive-video", "receive-pdf"]
PNG = b"\x89PNG\r\n\x1a\nfixture"
REPORT = b"# Synthetic report\n"


@pytest.mark.asyncio
async def test_direct_media_uses_native_admission_and_delivery_without_fallback(tmp_path, monkeypatch):
    from gateway import aira_transport

    assert aira_transport.CAPABILITIES == CAPABILITIES
    monkeypatch.setenv("WHATSAPP_ALLOWED_USERS", "*")
    monkeypatch.setenv("WHATSAPP_MODE", "bot")
    monkeypatch.delenv("WHATSAPP_REPLY_PREFIX", raising=False)
    monkeypatch.setattr("gateway.rich_sent_store.record_media_async", AsyncMock())
    route_id, token = str(uuid.uuid4()), "ab" * 32
    bridge_token = "synthetic-bridge-token"
    calls, issued, claimed, acks, sent, report_paths = [], {}, set(), [], [], []
    expected = {}

    async def endpoint(request):
        assert request.headers.get("Authorization") == "Bearer " + token
        body = await request.json()
        calls.append((request.path, body))
        assert body["schemaVersion"] == 2 and body["profile"] == "fixture" and body["routeId"] == route_id
        chat, mid = body["chat"], body["mid"]
        if request.path in ("/v2/aira/turn", "/v2/aira/media-turn"):
            assert mid in expected, "Unadmitted event reached the media route"
            path, source, text, media = expected[mid]
            assert request.path == path
            assert body == {"schemaVersion": 2, "profile": "fixture", "routeId": route_id, "platform": "whatsapp",
                            "kind": source.chat_type, "sender": source.user_id, "chat": source.chat_id, "mid": mid,
                            "text": text, **({"media": media} if media else {})}
            kinds = ("text", "document") if mid == "pdf" else ("text",)
            deliveries = [{"id": issued.setdefault((chat, mid, kind), str(uuid.uuid4())), "kind": kind}
                          for kind in kinds]
            return web.json_response({"schemaVersion": 2, "disposition": "reply", "deliveries": deliveries})
        key = next(key for key, value in issued.items() if value == body["id"])
        assert key[:2] == (chat, mid)
        if request.path.endswith("/claim"):
            if body["id"] in claimed:
                return web.Response(status=409)
            claimed.add(body["id"])
            delivery = {"id": body["id"], "kind": key[2]}
            if key[2] == "text":
                delivery["text"] = "fixture-" + mid
            else:
                delivery.update(mime="text/markdown", filename="report.md", sha256=hashlib.sha256(REPORT).hexdigest(),
                                base64=base64.b64encode(REPORT).decode("ascii"))
            return web.json_response({"schemaVersion": 2, "delivery": delivery})
        assert request.path.endswith("/ack") and body["id"] in claimed
        acks.append((mid, key[2], body["outcome"]))
        return web.json_response({"schemaVersion": 2, "accepted": True})

    async def bridge(request):
        assert request.headers.get("Authorization") == "Bearer " + bridge_token
        body = await request.json()
        chat = body["chatId"]
        if request.path == "/send":
            mid = body["message"].removeprefix("fixture-")
            assert issued[(chat, mid, "text")] in claimed
            sent.append((mid, "text"))
        else:
            path = Path(body["filePath"])
            assert (body["mediaType"], body["fileName"], path.name) == ("document", "report.md", "report.md")
            assert path.read_bytes() == REPORT and issued[(chat, "pdf", "document")] in claimed
            assert stat.S_IMODE(path.stat().st_mode) == 0o600 and stat.S_IMODE(path.parent.stat().st_mode) == 0o700
            report_paths.append(path)
            sent.append(("pdf", "document"))
        return web.json_response({"messageId": "fixture-native-confirmed"})

    app = web.Application(client_max_size=8 * 1024 * 1024)
    for path in ("/v2/aira/turn", "/v2/aira/media-turn", "/v2/aira/delivery/claim", "/v2/aira/delivery/ack"):
        app.router.add_post(path, endpoint)
    for path in ("/send", "/send-media"):
        app.router.add_post(path, bridge)
    server = web.AppRunner(app)
    await server.setup()
    await web.TCPSite(server, "127.0.0.1", 0).start()
    try:
        profile = tmp_path / "profiles" / "fixture"
        profile.mkdir(parents=True)
        marker = profile / "aira-transport.json"
        marker.write_text(json.dumps({"schemaVersion": 2, "profile": "fixture", "profileHome": str(profile),
                                      "port": server.addresses[0][1], "token": token, "state": "active",
                                      "routeId": route_id, "capabilities": CAPABILITIES}))
        marker.chmod(0o600)
        runner = _runner()
        intake = _DummyAdapter(Platform.WHATSAPP)
        intake._keep_typing = _hold_typing
        intake.set_message_handler(runner._handle_message)
        foreign = _DummyAdapter(Platform.WHATSAPP)
        runner.adapters = {Platform.WHATSAPP: foreign}
        native = _make_adapter()
        native._bridge_port = server.addresses[0][1]
        native._dm_policy = "allowlist"
        native._allow_from = {"fixture-a@lid"}
        native.config.extra["require_mention"] = False
        monkeypatch.setattr(native, "_check_managed_bridge_exit", AsyncMock(return_value=None))
        runner._delivery_adapter_for = lambda _source: native
        runner._intake_adapter_for = lambda _source: intake

        async def build(mid, native_type, kind="", mime="", path=None, body="fixture caption", group=False,
                        native_metadata=None, **extra):
            chat = "fixture-group@g.us" if group else "fixture-a@lid"
            sender = "fixture-b@lid" if group else chat
            raw = {"messageId": mid, "chatId": chat, "senderId": sender, "isGroup": group, "body": body,
                   "hasMedia": path is not None, "mediaType": kind, "mediaUrls": [str(path)] if path else [],
                   "mime": mime, "nativeType": native_type, "nativeMetadata": native_metadata or {},
                   "hasQuotedMessage": False, "quotedMessageId": None, "quotedMediaUrls": [], "quotedText": "",
                   "quotedMediaType": "", **extra}
            event = await native._build_message_event(raw)
            assert event is not None and event.raw_message == raw
            assert (event.source.chat_id, event.source.user_id, event.message_id) == (chat, sender, mid)
            return event

        async def consume(event):
            await intake._process_message_background(event, build_session_key(event.source))

        def expect(event, text, media_kind=None, mime=None, data=None):
            media = ({"kind": media_kind, "mime": mime, "sha256": hashlib.sha256(data).hexdigest(),
                      "base64": base64.b64encode(data).decode("ascii")} if media_kind else None)
            path = "/v2/aira/media-turn" if media else "/v2/aira/turn"
            expected[event.message_id] = path, event.source, text, media

        async with aiohttp.ClientSession(headers={"Authorization": "Bearer " + bridge_token}) as session:
            native._http_session = session
            with _profile_runtime_scope(profile):
                for mid, native_type, text in (("text", "conversation", "fixture text"),
                                               ("extended", "extendedTextMessage", "fixture extended")):
                    event = await build(mid, native_type, body=text)
                    expect(event, text)
                    await consume(event)
                # A native group mention is stripped by stock, not trusted as a new message identity.
                event = await build("group-text", "extendedTextMessage", body="@fixture-bot: fixture group", group=True,
                                    botIds=["fixture-bot@lid"], mentionedIds=["fixture-bot@lid"])
                assert event.text == "fixture group"
                expect(event, event.text)
                await consume(event)

                image = get_image_cache_dir() / "fixture.png"
                audio = get_audio_cache_dir() / "fixture.mp3"
                voice = get_audio_cache_dir() / "fixture.ogg"
                video = get_document_cache_dir() / "fixture.mp4"
                pdf = get_document_cache_dir() / "doc_fixture_private.pdf"
                direct = [
                    ("png", "imageMessage", "image", "image/png", "image/png", image, PNG + b"x" * 300_000,
                     MessageType.PHOTO, {}, False, "[image received]", "[attachment]"),
                    ("audio", "audioMessage", "audio", "audio/mpeg", "audio/mpeg", audio, b"ID3fixture",
                     MessageType.AUDIO, {"audio": {"ptt": False}}, False, "[audio received]", "[attachment]"),
                    ("voice", "audioMessage", "ptt", "audio/ogg; codecs=opus", "audio/ogg", voice, b"OggSfixture",
                     MessageType.VOICE, {"audio": {"ptt": True}}, False, "[ptt received]", "[attachment]"),
                    ("ptt", "pttMessage", "ptt", "audio/ogg", "audio/ogg", voice, b"OggSfixture",
                     MessageType.VOICE, {"audio": {"ptt": True}}, False, "[ptt received]", "[attachment]"),
                    ("video", "videoMessage", "video", "video/mp4", "video/mp4", video, b"\x00\x00\x00\x14ftypisomfixture",
                     MessageType.VIDEO, {"video": {"gifPlayback": False}}, True, "[video received]", "[attachment]"),
                    ("pdf", "documentMessage", "document", "application/pdf", "application/pdf", pdf, b"%PDF-1.4\nfixture",
                     MessageType.DOCUMENT, {}, False, "fixture caption", "fixture caption"),
                ]
                for mid, native_type, kind, mime, canonical, file, data, normalized, metadata, group, body, text in direct:
                    file.write_bytes(data)
                    event = await build(mid, native_type, kind, mime, file, body, group, metadata,
                                        fileName="private.pdf" if kind == "document" else "")
                    assert event.message_type == normalized
                    assert event.media_urls == [str(file)] and event.media_types == [mime]
                    expect(event, text, "voice" if kind == "ptt" else kind, canonical, data)
                    await consume(event)
                # Explicit Hermes commands are handled before the AIRA hook. Verify the actual stock
                # uninlined representation in isolation, without changing that command routing.
                command_pdf = await build("pdf-command", "documentMessage", "document", "application/pdf", pdf,
                                          body="/fixture-command")
                assert command_pdf.media_text_inlined == []
                parsed = aira_transport._media_input(aira_transport.read_typed_marker(marker), command_pdf.raw_message,
                                                     "documentMessage", {}, command_pdf)
                assert parsed is not None and parsed[0] == "/fixture-command"
                assert base64.b64decode(parsed[1]["base64"]) == pdf.read_bytes()
                # A replay may return the old descriptors, but no second native claim can succeed.
                await consume(await build("pdf", "documentMessage", "document", "application/pdf", pdf))
                before = len(calls)

                quoted = await build("quote", "imageMessage", "image", "image/png", image, hasQuotedMessage=True,
                                     quotedMediaUrls=[str(image)], quotedMediaType="image")
                assert quoted.reply_to_message_id is None and len(quoted.media_urls) == 2
                refused = [quoted]
                refused.append(await build("quoted-text", "extendedTextMessage", body="fixture text",
                                           hasQuotedMessage=True, quotedText="fixture quote"))
                inlined = get_document_cache_dir() / "doc_fixture_notes.txt"
                inlined.write_text("synthetic inlined content")
                event = await build("inlined", "documentMessage", "document", "text/plain", inlined, body="")
                assert event.media_text_inlined == [True] and "synthetic inlined content" in event.text
                refused.append(event)
                monkeypatch.setattr("plugins.platforms.whatsapp.adapter.cache_image_from_url",
                                    AsyncMock(side_effect=RuntimeError("synthetic cache failure")))
                refused.append(await build("remote", "imageMessage", "image", "image/png", "https://example.invalid/fixture.png"))
                monkeypatch.setattr("plugins.platforms.whatsapp.adapter.cache_image_from_url",
                                    AsyncMock(return_value=str(image)))
                cached_remote = await build("cached-remote", "imageMessage", "image", "image/png",
                                            "https://example.invalid/cached.png")
                assert cached_remote.media_urls == [str(image)]
                refused.append(cached_remote)
                with _profile_runtime_scope(tmp_path / "foreign"):
                    other = get_image_cache_dir() / "foreign.png"
                    other.write_bytes(PNG)
                refused.append(await build("foreign", "imageMessage", "image", "image/png", other))
                link = image.parent / "link.png"
                link.symlink_to(image)
                nested = image.parent / "folder" / "nested.png"
                nested.parent.mkdir()
                nested.write_bytes(PNG)
                fifo = image.parent / "pipe.png"
                os.mkfifo(fifo)
                wrong = get_video_cache_dir() / "wrong.mp4"
                wrong.write_bytes(video.read_bytes())
                for mid, file in (("link", link), ("nested", nested), ("fifo", fifo)):
                    refused.append(await build(mid, "imageMessage", "image", "image/png", file))
                refused.append(await build("wrong-cache", "videoMessage", "video", "video/mp4", wrong,
                                           native_metadata={"video": {"gifPlayback": False}}))
                refused.append(await build("bad-signature", "imageMessage", "image", "image/jpeg", image))
                refused.append(await build("unsupported-mime", "imageMessage", "image", "image/webp", image))
                refused.append(await build("sticker", "stickerMessage", "sticker", "image/png", image))
                refused.append(await build("location", "locationMessage", "location", body="fixture location"))
                refused.append(await build("multiple", "imageMessage", "image", "image/png", image,
                                           mediaUrls=[str(image), str(image)]))
                for mid, native_type in (("reaction", "reactionMessage"), ("poll", "pollCreationMessage"),
                                         ("poll-update", "pollUpdateMessage"), ("contact", "contactMessage")):
                    event = await build(mid, native_type, mid, body="fixture summary", native_metadata={"fixture": mid})
                    assert event.message_type == MessageType.TEXT
                    refused.append(event)
                event = await build("metadata-mismatch", "conversation", body="fixture text")
                event.metadata["whatsapp_native_type"] = "extendedTextMessage"
                refused.append(event)
                event = await build("identity-mismatch", "imageMessage", "image", "image/png", image)
                event.raw_message["senderId"] = "fixture-other@lid"
                refused.append(event)
                for event in refused:
                    await consume(event)
                assert len(calls) == before, "Refused native events cannot contact the core"
        assert sent == [(mid, "text") for mid in expected] + [("pdf", "document")]
        assert acks == [(mid, kind, "confirmed") for mid, kind in sent]
        assert len(report_paths) == 1 and not report_paths[0].parent.exists()
        assert not foreign.sent and not foreign.documents and not intake.sent and not intake.documents
        runner._handle_message_with_agent.assert_not_awaited()
    finally:
        await server.cleanup()
