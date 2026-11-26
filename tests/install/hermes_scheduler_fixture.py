"""Exact stock WhatsApp lifecycle; fake loopback core/bridge, no live account or provider."""

import asyncio
import json
import uuid
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import pytest
from aiohttp import web
from gateway.config import Platform
from gateway.run import _profile_runtime_scope
from tests.gateway.test_whatsapp_formatting import _make_adapter

CAPS = ["text", "document", "receive-image", "receive-audio", "receive-video", "receive-pdf", "scheduler"]


@pytest.mark.asyncio
@pytest.mark.parametrize("mode", ["delivery", "foreign-profile", "foreign-adapter", "multiplex", "provisional",
                                  "refused", "cancel-poll"])
async def test_stock_scheduler_lifecycle(tmp_path, monkeypatch, mode):
    from gateway import aira_transport

    assert aira_transport.CAPABILITIES == CAPS
    profile = tmp_path / "profiles" / "fixture"
    profile.mkdir(parents=True)
    token = "ab" * 32
    bridge_token = "synthetic-bridge-token"
    route_id, delivery_id = str(uuid.uuid4()), str(uuid.uuid4())
    scope = {"schemaVersion": 2, "profile": "fixture", "routeId": route_id}
    calls, sends = [], []
    acked = asyncio.Event()
    poll_received, release_poll, poll_completed = asyncio.Event(), asyncio.Event(), asyncio.Event()
    claimed = False

    async def core(request):
        nonlocal claimed
        assert request.headers.get("Authorization") == "Bearer " + token
        data = await request.json()
        calls.append((request.path, data))
        if request.path.endswith("/poll"):
            assert data == scope
            poll_received.set()
            if mode == "refused":
                return web.json_response({"error": "synthetic route refusal"}, status=403)
            if mode == "cancel-poll":
                await release_poll.wait()
                poll_completed.set()
            return web.json_response({"schemaVersion": 2, "delivery": None if claimed else {"id": delivery_id, "kind": "text"}})
        if request.path.endswith("/claim"):
            assert data == {**scope, "id": delivery_id} and not claimed
            claimed = True
            return web.json_response({"schemaVersion": 2, "delivery": {"id": delivery_id, "kind": "text",
                                     "chat": "fixture-scheduled@lid", "text": "synthetic due reminder"}})
        assert request.path.endswith("/ack") and data == {**scope, "id": delivery_id, "outcome": "confirmed"}
        assert sends == [{"chatId": "fixture-scheduled@lid", "message": "synthetic due reminder"}]
        acked.set()
        return web.json_response({"schemaVersion": 2, "accepted": True})

    async def bridge(request):
        assert request.headers.get("Authorization") == "Bearer " + bridge_token and claimed
        body = await request.json()
        sends.append({"chatId": body["chatId"], "message": body["message"]})
        return web.json_response({"messageId": "fixture-native-confirmed"})

    endpoint = web.Application()
    for path in ("poll", "claim", "ack"):
        endpoint.router.add_post("/v2/aira/reminders/" + path, core)
    endpoint.router.add_post("/send", bridge)
    server = web.AppRunner(endpoint)
    await server.setup()
    await web.TCPSite(server, "127.0.0.1", 0).start()
    native = None
    try:
        marker = profile / "aira-transport.json"
        marker.write_text(json.dumps({**scope, "profileHome": str(profile), "port": server.addresses[0][1],
                                      "token": token, "state": "provisional" if mode == "provisional" else "active",
                                      "routeId": None if mode == "provisional" else route_id, "capabilities": CAPS}))
        marker.chmod(0o600)
        runner = SimpleNamespace(config=SimpleNamespace(multiplex_profiles=False), _primary_profile_name="fixture",
                                 _running=False, _draining=False, adapters={})
        if mode == "foreign-profile":
            runner._primary_profile_name = "foreign"
        elif mode == "foreign-adapter":
            runner.adapters[Platform.WHATSAPP] = object()
        elif mode == "multiplex":
            runner.config.multiplex_profiles = True
        with _profile_runtime_scope(profile):
            native = _make_adapter()
            native._profile_home = profile
            native._bridge_port = server.addresses[0][1]
            native._bridge_token = bridge_token
            native._session_path = profile / "session"
            native._session_path.mkdir()
            native._runtime_status_platform_key = ""
            native._shutting_down = False
            native._running = False
            native.gateway_runner = runner
            monkeypatch.setattr(native, "_check_managed_bridge_exit", AsyncMock(return_value=None))
            monkeypatch.setattr(native, "_release_platform_lock", lambda: None)
            monkeypatch.setattr(native, "_mark_disconnected", lambda: setattr(native, "_running", False))
            monkeypatch.setattr(native, "_close_bridge_log", lambda: None)

            async def idle_stock_poll():
                await asyncio.Event().wait()

            monkeypatch.setattr(native, "_poll_messages", idle_stock_poll)
            # Real exact stock startup seam, no account setup, bridge subprocess or inbound message.
            native._attach_to_bridge(None)
            if mode in ("foreign-profile", "foreign-adapter", "multiplex", "provisional"):
                # Even a live runner and genuine stock adapter cannot start polling outside the owned route.
                native._running = runner._running = True
                runner.adapters.setdefault(Platform.WHATSAPP, native)
                assert getattr(native, "_aira_schedule_task", None) is None
                await asyncio.sleep(0.05)
                assert calls == [] and sends == []
                await native.disconnect()
                assert native._aira_schedule_task is None
                native = None
                return
            task = native._aira_schedule_task
            assert isinstance(task, asyncio.Task)
            await asyncio.sleep(0.05)
            assert calls == [] and sends == []
            # Stock publishes the exact adapter after successful connect.
            native._running = True
            runner.adapters[Platform.WHATSAPP] = native
            runner._running = True
            if mode == "cancel-poll":
                # A real loopback poll is in flight. Disconnect must cancel/await the owning task
                # without waiting for a late response, and that descriptor cannot trigger a claim.
                await asyncio.wait_for(poll_received.wait(), timeout=12)
                await asyncio.wait_for(native.disconnect(), timeout=3)
                assert native._aira_schedule_task is None and task.cancelled()
                assert not poll_completed.is_set()
                release_poll.set()
                await asyncio.wait_for(poll_completed.wait(), timeout=3)
                await asyncio.sleep(0.05)
                assert calls == [("/v2/aira/reminders/poll", scope)] and sends == []
                native = None
                return
            if mode == "refused":
                await asyncio.wait_for(task, timeout=12)
                assert calls == [("/v2/aira/reminders/poll", scope)] and sends == []
                await native.disconnect()
                assert native._aira_schedule_task is None
                native = None
                return
            await asyncio.wait_for(acked.wait(), timeout=12)
            assert [path.rsplit("/", 1)[-1] for path, _ in calls] == ["poll", "claim", "ack"]
            before = len(calls)
            # Real exact stock shutdown seam must cancel/await the retained task before bridge teardown.
            await native.disconnect()
            assert native._aira_schedule_task is None and task.done()
            await asyncio.sleep(0.05)
            assert len(calls) == before and len(sends) == 1
            native = None
    finally:
        release_poll.set()
        if native is not None and getattr(native, "_http_session", None) is not None:
            await native.disconnect()
        await server.cleanup()
