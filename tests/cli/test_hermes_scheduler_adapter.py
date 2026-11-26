"""Exact scheduler helper and native lifecycle patch; synthetic marker and adapter only."""

import asyncio
import hashlib
import json
import tempfile
import unittest
from pathlib import Path
from types import ModuleType, SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

from deploy.gateway import standalone_scheduler_patch as lifecycle

CAPABILITIES = ["text", "document", "receive-image", "receive-audio", "receive-video", "receive-pdf", "scheduler"]
ROUTE = "12345678-1234-4234-8234-123456789abc"
DELIVERY = "87654321-4321-4321-8321-cba987654321"
SCOPE = {"schemaVersion": 2, "profile": "fixture", "routeId": ROUTE}
POLL = "/v2/aira/reminders/poll"
CLAIM = "/v2/aira/reminders/claim"
ACK = "/v2/aira/reminders/ack"


class SchedulerAdapterTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name) / "profiles" / "fixture"
        self.home.mkdir(parents=True)
        self.marker = self.home / "aira-transport.json"
        self.config = {**SCOPE, "profileHome": str(self.home), "port": 9881, "token": "a" * 64,
                       "state": "active", "capabilities": CAPABILITIES}
        self.write_marker()
        gateway = Path(__file__).resolve().parents[2] / "deploy/gateway"
        main = b'if __name__ == "__main__":\n    sys.exit(main())\n'
        script = (gateway / "standalone_adapter.py").read_bytes()[:-len(main)]
        for extension in ("document", "media", "scheduler"):
            script += (gateway / f"standalone_{extension}_adapter.py").read_bytes().rstrip(b"\n") + b"\n\n"
        self.helper = ModuleType("fixture_scheduler_adapter")
        exec(compile(script + main, "<scheduler-fixture>", "exec"), self.helper.__dict__)
        self.runner = SimpleNamespace(config=SimpleNamespace(multiplex_profiles=False), _primary_profile_name="fixture",
                                      _running=False, _draining=False, adapters={})
        self.native = SimpleNamespace(platform="whatsapp", _profile_home=self.home, gateway_runner=self.runner,
                                      _runtime_status_platform_key="", _running=False, is_connected=False,
                                      _shutting_down=False, send=AsyncMock(return_value=SimpleNamespace(
                                          success=True, message_id="fixture-native-id")))
        self.calls = []
        self.claimed = False
        self.ack = asyncio.Event()
        self.descriptor = {"schemaVersion": 2, "delivery": {"id": DELIVERY, "kind": "text"}}
        self.claim = {"schemaVersion": 2, "delivery": {"id": DELIVERY, "kind": "text",
                                                        "chat": "fixture-chat@lid", "text": "fixture reminder"}}
        self.addCleanup(patch.stopall)
        self.request_patch = patch.object(self.helper, "_schedule_request", side_effect=self.post)
        self.request_patch.start()
        patch.object(self.helper, "SCHEDULE_POLL_SECONDS", 0.01, create=True).start()
        patch.object(self.helper, "SCHEDULE_STARTUP_SECONDS", 0.01, create=True).start()

    def write_marker(self, **changes):
        self.marker.write_text(json.dumps({**self.config, **changes}))
        self.marker.chmod(0o600)

    def ready(self):
        self.native._running = self.native.is_connected = self.runner._running = True
        self.runner.adapters[self.native.platform] = self.native

    async def post(self, config, path, payload, timeout):
        self.assertEqual(config, self.config)
        self.calls.append((path, payload, timeout))
        if path == POLL:
            return {"schemaVersion": 2, "delivery": None} if self.claimed else self.descriptor
        if path == CLAIM:
            self.claimed = True
            return self.claim
        if path == ACK:
            self.ack.set()
            return {"schemaVersion": 2, "accepted": True}
        self.fail("unexpected endpoint")

    async def stop(self, task):
        task.cancel()
        await asyncio.gather(task, return_exceptions=True)

    def start(self):
        self.assertTrue(hasattr(self.helper, "start_schedule_poll"))
        task = self.helper.start_schedule_poll(self.native, self.marker)
        if task is not None:
            self.addAsyncCleanup(self.stop, task)
        return task

    async def finish(self, task):
        self.runner._draining = True
        await asyncio.wait_for(task, timeout=1)

    async def test_start_waits_for_exact_published_native_and_sends_without_inbound(self):
        self.assertEqual(self.helper.CAPABILITIES, CAPABILITIES)
        task = self.start()
        self.assertIsInstance(task, asyncio.Task)
        self.assertIs(task, self.native._aira_schedule_task)
        self.assertIs(self.start(), task)
        self.assertIsNone(self.helper.start_schedule_poll(self.native, self.home / "foreign-marker.json"))
        self.assertIs(task, self.native._aira_schedule_task)
        await asyncio.sleep(0.03)
        self.assertEqual(self.calls, [])
        self.ready()
        await asyncio.wait_for(self.ack.wait(), timeout=1)
        await self.finish(task)
        self.assertEqual(self.calls, [(POLL, SCOPE, 115), (CLAIM, {**SCOPE, "id": DELIVERY}, 15),
                                     (ACK, {**SCOPE, "id": DELIVERY, "outcome": "confirmed"}, 15)])
        self.native.send.assert_awaited_once_with("fixture-chat@lid", "fixture reminder")

    async def test_foreign_multiplex_secondary_profile_and_marker_are_refused(self):
        self.ready()
        for target, field, invalid in (
            (self.runner.config, "multiplex_profiles", True),
            (self.runner.config, "multiplex_profiles", None),
            (self.runner, "_primary_profile_name", "foreign"),
            (self.native, "_runtime_status_platform_key", "secondary-whatsapp"),
            (self.native, "_profile_home", self.home.parent / "foreign"),
            (self.native, "_shutting_down", True),
            (self.runner, "_draining", True),
        ):
            original = getattr(target, field)
            setattr(target, field, invalid)
            self.assertIsNone(self.start())
            setattr(target, field, original)
        for changes in ({"capabilities": CAPABILITIES[:-1]}, {"state": "provisional", "routeId": None}):
            self.write_marker(**changes)
            self.assertIsNone(self.start())
        self.write_marker()
        self.runner.adapters[self.native.platform] = object()
        self.assertIsNone(self.start())
        self.assertEqual(self.calls, [])
        self.native.send.assert_not_awaited()

    async def test_marker_is_rechecked_during_startup_and_before_claim(self):
        task = self.start()
        self.write_marker(token="b" * 64)
        self.ready()
        await asyncio.wait_for(task, timeout=1)
        self.assertEqual(self.calls, [])
        self.write_marker()

        async def rotate(config, path, payload, timeout):
            response = await self.post(config, path, payload, timeout)
            self.write_marker(routeId="11111111-1111-4111-8111-111111111111")
            return response

        with patch.object(self.helper, "_schedule_request", side_effect=rotate):
            task = self.start()
            await asyncio.wait_for(task, timeout=1)
        self.assertEqual([path for path, _, _ in self.calls], [POLL])
        self.native.send.assert_not_awaited()

    async def test_authority_and_publication_are_rechecked_before_native_send(self):
        self.ready()

        async def replace(config, path, payload, timeout):
            response = await self.post(config, path, payload, timeout)
            if path == CLAIM:
                self.runner.adapters[self.native.platform] = object()
            return response

        with patch.object(self.helper, "_schedule_request", side_effect=replace):
            await asyncio.wait_for(self.start(), timeout=1)
        self.assertEqual([path for path, _, _ in self.calls], [POLL, CLAIM])
        self.native.send.assert_not_awaited()

    async def test_malformed_poll_and_claim_do_not_deliver(self):
        self.ready()
        for bad in (
            {"schemaVersion": 2.0, "delivery": self.descriptor["delivery"]},
            {**self.descriptor, "extra": True},
            {"schemaVersion": 2, "delivery": {"id": "invalid", "kind": "text"}},
            {"schemaVersion": 2, "delivery": {"id": DELIVERY, "kind": "document"}},
            {"schemaVersion": 2, "delivery": {"id": DELIVERY, "kind": "text", "chat": "unexpected"}},
        ):
            with self.subTest(poll=bad):
                request = AsyncMock(return_value=bad)
                with patch.object(self.helper, "_schedule_request", request):
                    task = self.start()
                    await asyncio.sleep(0.03)
                    await self.stop(task)
                self.assertGreater(request.await_count, 0)
                self.assertTrue(all(call.args[1] == POLL for call in request.await_args_list))
        for change in (
            {"id": ROUTE}, {"kind": "document"}, {"chat": "status@broadcast"}, {"chat": "fixture@newsletter"},
            {"chat": "invalid chat"}, {"text": "NO_REPLY"}, {"text": "MEDIA: fixture"}, {"extra": "fixture"},
        ):
            with self.subTest(claim=change):
                bad = {**self.claim, "delivery": {**self.claim["delivery"], **change}}
                request = AsyncMock(side_effect=lambda _c, path, _p, _t: self.descriptor if path == POLL else bad)
                with patch.object(self.helper, "_schedule_request", request):
                    task = self.start()
                    await asyncio.sleep(0.03)
                    await self.stop(task)
                calls = [call.args[1] for call in request.await_args_list]
                self.assertIn(CLAIM, calls)
                self.assertNotIn(ACK, calls)
        self.native.send.assert_not_awaited()

    async def test_lost_poll_can_recover_but_lost_claim_is_not_retried(self):
        self.ready()
        polls = 0
        repeated = asyncio.Event()

        async def lost(config, path, payload, timeout):
            nonlocal polls
            self.calls.append((path, payload, timeout))
            if path == POLL:
                polls += 1
                if polls == 1:
                    raise ConnectionError("synthetic lost poll")
                if polls == 4:
                    repeated.set()
                return self.descriptor
            raise ConnectionError("synthetic lost claim")

        with patch.object(self.helper, "_schedule_request", side_effect=lost):
            task = self.start()
            await asyncio.wait_for(repeated.wait(), timeout=1)
            await self.finish(task)
        self.assertEqual([path for path, _, _ in self.calls], [POLL, POLL, CLAIM, POLL, POLL])
        self.native.send.assert_not_awaited()

    async def test_ambiguous_send_and_lost_ack_never_retry(self):
        self.ready()
        self.native.send.return_value = SimpleNamespace(success=True, message_id=None)
        repeated = asyncio.Event()

        async def ambiguous(config, path, payload, timeout):
            self.calls.append((path, payload, timeout))
            if path == POLL:
                if len(self.calls) >= 4:
                    repeated.set()
                return self.descriptor
            if path == CLAIM:
                return self.claim
            raise ConnectionError("synthetic lost acknowledgement")

        with patch.object(self.helper, "_schedule_request", side_effect=ambiguous):
            task = self.start()
            await asyncio.wait_for(repeated.wait(), timeout=1)
            await self.finish(task)
        self.native.send.assert_awaited_once()
        self.assertEqual([path for path, _, _ in self.calls], [POLL, CLAIM, ACK, POLL])
        self.assertEqual(self.calls[2][1], {**SCOPE, "id": DELIVERY, "outcome": "unknown"})

    async def test_cancelled_native_send_does_not_ack_or_retry(self):
        self.ready()
        sending = asyncio.Event()

        async def blocked(*_):
            sending.set()
            await asyncio.Event().wait()

        self.native.send.side_effect = blocked
        task = self.start()
        await asyncio.wait_for(sending.wait(), timeout=1)
        await self.stop(task)
        self.assertTrue(task.cancelled())
        self.native.send.assert_awaited_once()
        self.assertEqual([path for path, _, _ in self.calls], [POLL, CLAIM])

    async def test_losing_liveness_after_ready_exits_instead_of_waiting_for_reconnect(self):
        self.ready()
        task = self.start()
        await asyncio.wait_for(self.ack.wait(), timeout=1)
        self.native.is_connected = False
        await asyncio.wait_for(task, timeout=1)
        self.native.is_connected = True
        await asyncio.sleep(0.03)
        self.assertEqual(len(self.calls), 3)
        self.native.send.assert_awaited_once()

    def fake_http(self, responses):
        """Exercise the real bounded HTTP reader without a real connection."""
        requests, connections = [], []
        remaining = list(responses)

        def connect(host, port, *, timeout):
            status, value = remaining.pop(0) if remaining else responses[-1]
            response = SimpleNamespace(status=status, read=Mock(return_value=json.dumps(value).encode()))
            connection = Mock()
            connection.getresponse.return_value = response
            connection.request.side_effect = lambda method, path, body, headers: requests.append(
                (host, port, timeout, method, path, json.loads(body), headers, response))
            connections.append(connection)
            return connection

        return connect, requests, connections

    def assert_http_bounds(self, requests, connections):
        for host, port, timeout, method, path, body, headers, response in requests:
            self.assertEqual((host, port, method), ("127.0.0.1", self.config["port"], "POST"))
            self.assertEqual(timeout, 115 if path == POLL else 15)
            self.assertEqual(headers, {"Content-Type": "application/json",
                                       "Authorization": "Bearer " + self.config["token"]})
            self.assertEqual({key: body[key] for key in SCOPE}, SCOPE)
            if response.status == 200:
                response.read.assert_called_once_with(self.helper.MAX_RESPONSE + 1)
            else:
                response.read.assert_not_called()
        for connection in connections:
            connection.close.assert_called_once()

    async def test_auth_or_route_refusal_at_any_boundary_stops_polling(self):
        self.request_patch.stop()
        self.ready()
        prefix = [(200, self.descriptor), (200, self.claim), (200, {"schemaVersion": 2, "accepted": True})]
        for index, boundary in enumerate((POLL, CLAIM, ACK)):
            for status in (401, 403):
                with self.subTest(boundary=boundary, status=status):
                    self.native.send.reset_mock()
                    connect, requests, connections = self.fake_http(prefix[:index] + [(status, {})])
                    with patch.object(self.helper.http.client, "HTTPConnection", side_effect=connect):
                        task = self.start()
                        await asyncio.wait_for(task, timeout=1)
                        await asyncio.sleep(0.03)
                    self.assertEqual([request[4] for request in requests], [POLL, CLAIM, ACK][:index + 1])
                    self.assertEqual(self.native.send.await_count, int(boundary == ACK))
                    self.assert_http_bounds(requests, connections)

    async def test_service_unavailable_poll_retries_but_unavailable_claim_does_not(self):
        self.request_patch.stop()
        self.ready()
        connect, requests, connections = self.fake_http([
            (503, {}), (200, self.descriptor), (503, {}), (200, self.descriptor), (403, {})
        ])
        with patch.object(self.helper.http.client, "HTTPConnection", side_effect=connect):
            task = self.start()
            await asyncio.wait_for(task, timeout=1)
        self.assertEqual([request[4] for request in requests], [POLL, POLL, CLAIM, POLL, POLL])
        self.native.send.assert_not_awaited()
        self.assert_http_bounds(requests, connections)


class SchedulerPatchTests(unittest.TestCase):
    def test_patch_is_exact_reversible_and_foreign_or_partial_is_refused(self):
        self.assertTrue(hasattr(lifecycle, "select_scheduler"))
        start = b"        self._poll_task = asyncio.create_task(self._poll_messages())\n"
        stop = b"        self._shutting_down = True  # flip BEFORE signalling so send()/poll loop don't report the intentional exit as fatal\n"
        original = b"prefix\n" + start + b"middle\n" + stop + b"suffix\n"
        with patch.object(lifecycle, "ORIGINAL_SHA256", hashlib.sha256(original).hexdigest()):
            self.assertEqual(lifecycle.classify_source(original), "original")
            modified = lifecycle.select_scheduler(original, True)
            self.assertEqual(lifecycle.classify_source(modified), "patched")
            self.assertEqual(lifecycle.select_scheduler(modified, True), modified)
            self.assertEqual(lifecycle.select_scheduler(modified, False), original)
            self.assertEqual(lifecycle.select_scheduler(original, False), original)
            self.assertIn(b"self._profile_home / \"aira-transport.json\"", modified)
            self.assertIn(b"await cancel_task(getattr(self, \"_aira_schedule_task\", None))", modified)
            for foreign in (original + b"foreign", modified.replace(b"suffix", b"foreign"),
                            modified.replace(lifecycle.START_PATCHED, start),
                            modified.replace(lifecycle.STOP_PATCHED, stop)):
                self.assertEqual(lifecycle.classify_source(foreign), "unsupported")
                for enabled in (True, False):
                    with self.assertRaises(ValueError):
                        lifecycle.select_scheduler(foreign, enabled)

    def test_even_known_digest_requires_both_unique_anchors_to_patch(self):
        self.assertTrue(hasattr(lifecycle, "select_scheduler"))
        for original in (b"no anchors", lifecycle.START_ANCHOR * 2 + lifecycle.STOP_ANCHOR):
            with patch.object(lifecycle, "ORIGINAL_SHA256", hashlib.sha256(original).hexdigest()):
                with self.assertRaises(ValueError):
                    lifecycle.select_scheduler(original, True)


if __name__ == "__main__":
    unittest.main()
