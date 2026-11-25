"""Copied into the pinned Hermes checkout by the disposable compatibility test.

Uses Hermes's real admitted-message and platform-delivery paths with a fake
transport and loopback AIRA endpoint. It never connects to a messaging account.
"""

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import pytest
from gateway.config import Platform
from gateway.platforms.event import MessageEvent
from gateway.run import _profile_runtime_scope
from gateway.session import SessionSource, build_session_key
from tests.gateway.test_media_resend_dedup import _DummyAdapter, _hold_typing
from tests.gateway.test_post_gateway_admission import _runner


def event(chat, sender, mid, text, kind="dm"):
    source = SessionSource(platform=Platform.WHATSAPP, chat_id=chat, chat_type=kind, user_id=sender)
    return MessageEvent(text=text, source=source, message_id=mid)


@pytest.mark.asyncio
async def test_local_adapter_consumes_and_delivers_only_to_the_selected_chat(tmp_path, monkeypatch):
    monkeypatch.setenv("WHATSAPP_ALLOWED_USERS", "*")
    seen = []
    token = "ab" * 32

    class Endpoint(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            seen.append((self.path, self.headers["Authorization"], body))
            if body.get("text") == "unavailable":
                self.send_response(503)
                self.end_headers()
                return
            result = {
                "schemaVersion": 1,
                "disposition": "no_reply" if body["text"] == "silent" else "reply",
                "reply": None if body["text"] == "silent" else f"reply for {body['chat']}",
            }
            encoded = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(encoded)))
            self.end_headers()
            self.wfile.write(encoded)

    endpoint = ThreadingHTTPServer(("127.0.0.1", 0), Endpoint)
    thread = threading.Thread(target=endpoint.serve_forever, daemon=True)
    thread.start()
    try:
        selected, unrelated = tmp_path / "profiles" / "fixture", tmp_path / "profiles" / "unrelated"
        selected.mkdir(parents=True)
        unrelated.mkdir()
        marker = selected / "aira-transport.json"
        marker.write_text(json.dumps({"schemaVersion": 1, "profile": "fixture", "profileHome": str(selected),
                                      "port": endpoint.server_port, "token": token}))
        marker.chmod(0o600)
        runner = _runner()
        adapter = _DummyAdapter(Platform.WHATSAPP)
        adapter._keep_typing = _hold_typing
        adapter.set_message_handler(runner._handle_message)
        runner.adapters = {Platform.WHATSAPP: adapter}
        runner._delivery_adapter_for = lambda _source: adapter
        runner._intake_adapter_for = lambda _source: adapter

        async def deliver(inbound):
            await adapter._process_message_background(inbound, build_session_key(inbound.source))

        with _profile_runtime_scope(selected):
            await deliver(event("fixture-a@lid", "fixture-a@lid", "m1", "hello"))
            await deliver(event("fixture-group@g.us", "fixture-b@lid", "m2", "hello", "group"))
            await deliver(event("fixture-a@lid", "fixture-a@lid", "m3", "silent"))
            await deliver(event("fixture-a@lid", "fixture-a@lid", "m4", "unavailable"))
            media = event("fixture-a@lid", "fixture-a@lid", "m5", "media")
            media.media_urls = ["synthetic-file"]
            assert await runner._handle_message(media) is None
            ambiguous = event("fixture-group@g.us", "fixture-b@lid", "m6", "ambiguous", "group")
            ambiguous.user_id = ""
            assert await runner._handle_message(ambiguous) is None
            conflicting = event("fixture-group@g.us", "fixture-b@lid", "m9", "conflicting", "group")
            conflicting.user_id = "fixture-c@lid"
            assert await runner._handle_message(conflicting) is None
            media_only = event("fixture-a@lid", "fixture-a@lid", "m10", "unsupported media")
            media_only.media_types = ["image/png"]
            assert await runner._handle_message(media_only) is None
            marker.write_text("intentionally invalid")
            assert await runner._handle_message(event("fixture-a@lid", "fixture-a@lid", "m7", "no fallback")) is None
        runner._handle_message_with_agent.assert_not_awaited()
        assert adapter.sent == [
            {"chat_id": "fixture-a@lid", "content": "reply for fixture-a@lid"},
            {"chat_id": "fixture-group@g.us", "content": "reply for fixture-group@g.us"},
        ]
        assert [entry[2]["chat"] for entry in seen] == [
            "fixture-a@lid", "fixture-group@g.us", "fixture-a@lid", "fixture-a@lid"
        ]
        assert seen[1][2]["kind"] == "group" and seen[1][2]["sender"] == "fixture-b@lid"
        assert all(path == "/v1/aira/turn" and credential == "Bearer " + token
                   for path, credential, _ in seen)
        with _profile_runtime_scope(unrelated):
            assert await runner._handle_message(event("fixture-a@lid", "fixture-a@lid", "m8", "legacy path")) == "agent-ok"
        runner._handle_message_with_agent.assert_awaited_once()
    finally:
        endpoint.shutdown()
        endpoint.server_close()
        thread.join()
