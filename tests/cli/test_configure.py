"""Typed config and diagnostic contracts, isolated from Docker and providers."""

import io
import json
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.cli import configure, diagnostics, install, main
from deploy.cli.result import CommandError, operational_error


class ConfigurationTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.selection = {"mode": "standalone", "home": self.home, "manifest": None}
        self.state = {"state": {"installation": "installed", "service": "running"}}

    def test_first_save_sends_null_revision_and_full_typed_role_without_disclosure(self):
        args = main.build_parser().parse_args([
            "config", "set-model", "--role", "main", "--provider", "openai-compatible",
            "--model", "fixture", "--base-url", "http://127.0.0.1:12345/v1", "--key-stdin", "--json",
        ])
        key = "synthetic-key-canary"
        first = {"schemaVersion": 1, "savedRevision": None, "saved": None}
        saved = {"schemaVersion": 1, "savedRevision": "fixture-revision", "appliedRevision": None,
                 "saved": {"main": {"credentialConfigured": True, "model": "fixture"}, "fallback": None}}

        with (patch.object(configure, "selected_api", return_value=self.selection),
              patch.object(configure, "readback", side_effect=[first, saved]),
              patch.object(configure, "api_call", return_value=saved) as write,
              patch.object(install, "observe", return_value=self.state),
              patch("sys.stdin", io.TextIOWrapper(io.BytesIO((key + "\n").encode())))):
            result = configure.run_config(args, "fixture-operation")
        payload = write.call_args.args[3]
        self.assertIsNone(payload["expectedRevision"])
        self.assertEqual(payload["main"], {
            "provider": "openai-compatible", "model": "fixture", "baseUrl": "http://127.0.0.1:12345/v1",
            "effort": "", "deepEffort": "", "usdPerMTokIn": 0, "usdPerMTokOut": 0,
            "usdPerMTokCached": 0, "apiKey": key,
        })
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(result["savedRevision"], "fixture-revision")
        self.assertNotIn(key, json.dumps(result))

    def test_activation_rechecks_after_restart_and_holds_the_lock(self):
        args = main.build_parser().parse_args(["config", "activate", "--json"])
        saved = {"savedRevision": "fixture-revision", "appliedRevision": None, "activation": "idle"}
        applied = {"savedRevision": "fixture-revision", "appliedRevision": "fixture-revision", "activation": "idle"}
        with (patch.object(configure, "selected_api", return_value=self.selection),
              patch.object(configure, "api_call", return_value={"activation": "requested"}),
              patch.object(configure, "readback", side_effect=[saved, operational_error("owner_unreachable", "offline", "config"), applied]),
              patch.object(install, "observe", return_value=self.state),
              patch.object(configure.time, "sleep")):
            result = configure.run_config(args, "fixture-operation")
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(result["appliedRevision"], "fixture-revision")

    def test_invalid_price_and_recursive_local_url_refused(self):
        self.assertFalse(configure.valid_base_url("http://127.0.0.1:9881/v1"))
        self.assertFalse(configure.valid_base_url("https://fixture.invalid:99999/v1"))
        for value in ("inf", "nan", "-1"):
            with self.assertRaises(CommandError):
                configure.parse_price("input-price", value)

    def test_unsupported_legacy_model_write_does_not_read_secret(self):
        args = main.build_parser().parse_args(["config", "set-model", "--role", "main", "--key-stdin"])
        self.selection["mode"] = "legacy"
        with (patch.object(configure, "selected_api", return_value=self.selection),
              patch.object(configure, "read_key", side_effect=AssertionError("must not read key"))):
            result = configure.run_config(args, "fixture-operation")
        self.assertEqual(result["error"]["code"], "capability_unavailable")


class DiagnosticTests(unittest.TestCase):
    def test_only_known_event_and_timestamp_survive(self):
        secret = "synthetic-canary"
        raw = {"time": "2026-11-25T13:00:00.000Z", "level": "error", "module": "gateway",
               "event": "gateway.turn_failed", "error": secret, "chatId": secret, "reason": secret}
        event = diagnostics.normalize_container_log("gateway", json.dumps(raw))
        self.assertEqual(event["event"], "gateway.turn_failed")
        self.assertNotIn(secret, json.dumps(event))
        self.assertIsNone(diagnostics.normalize_container_log("core", json.dumps(raw)))
        raw["event"] = secret
        self.assertIsNone(diagnostics.normalize_container_log("gateway", json.dumps(raw)))

    def test_stopped_container_log_reads_do_not_require_owner_credential(self):
        with (patch.object(diagnostics.compose, "container_id", return_value="f" * 64),
              patch.object(diagnostics.compose, "run", return_value=(0, '{"module":"boot","event":"core.ready","level":"info"}\n', "")) as run):
            events = diagnostics.read_container_logs({"home": Path("/fixture"), "project": "fixture"}, "core", 5)
        self.assertEqual(events[0]["event"], "core.ready")
        self.assertEqual(run.call_args.args[0][:4], ["docker", "logs", "--tail", "5"])


if __name__ == "__main__":
    unittest.main()
