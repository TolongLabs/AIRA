"""Attachment transaction and marker boundary tests; no real account or service."""

import json
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy.cli import hermes, install, operations
from deploy.gateway import standalone_adapter


class MarkerTests(unittest.TestCase):
    def test_marker_is_private_and_bound_to_its_profile_home(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            selected = root / "profiles" / "fixture"
            selected.mkdir(parents=True)
            marker = selected / standalone_adapter.MARKER_NAME
            doc = {"schemaVersion": 1, "profile": "fixture", "profileHome": str(selected),
                   "port": 9881, "token": "a" * 64}
            install.atomic_write_text(marker, json.dumps(doc))
            self.assertEqual(standalone_adapter.read_marker(marker), doc)
            other = root / "profiles" / "other"
            other.mkdir()
            wrong = other / standalone_adapter.MARKER_NAME
            install.atomic_write_text(wrong, json.dumps(doc))
            with self.assertRaises(ValueError):
                standalone_adapter.read_marker(wrong)
            marker.chmod(0o644)
            with self.assertRaises(ValueError):
                standalone_adapter.read_marker(marker)

    def test_unicode_and_media_reply_boundaries(self):
        self.assertTrue(standalone_adapter._text_fits("🙂" * 16384))
        self.assertFalse(standalone_adapter._text_fits("🙂" * 16385))
        for text in ("NO_REPLY", "valid\r MEDIA:fixture", "valid\u2028MEDIA:fixture"):
            self.assertIsNone(standalone_adapter._reply({"schemaVersion": 1, "disposition": "reply", "reply": text}))


class AttachmentTests(unittest.TestCase):
    def setUp(self):
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        root = Path(tmp.name)
        home, source, profile = (root / name for name in ("install", "source", "profile"))
        for directory in (home, source, profile):
            directory.mkdir(mode=0o700)
        standalone = home / "data" / "standalone"
        standalone.mkdir(parents=True, mode=0o700)
        paths = {"source": source / "inbound.py", "helper": source / "adapter.py",
                 "marker": profile / "aira-transport.json", "receipt": standalone / "hermes.json",
                 "host": standalone / "attach-host.json"}
        paths["source"].write_text("original\n")
        paths["source"].chmod(0o644)
        self.report = {"state": {"service": "running", "installation": "installed", "hermes": "connected"},
                       "dashboard": None, "hermesRoute": {"state": "connected", "profile": "fixture",
                                                           "adapterVersion": "hermes-v0.23.4"}}
        self.plan = {"home": home, "manifest": None, "sourceDir": source, "profile": "fixture",
                     "paths": paths, "report": self.report, "kind": "original", "running": False,
                     "original": {name: hermes._read(path, optional=True) for name, path in paths.items()},
                     "desired": {"source": (b"patched\n", 0o644), "helper": (b"reviewed\n", 0o644),
                                 "marker": (b"fixture marker\n", 0o600), "host": (b"fixture record\n", 0o600)},
                     "adapter": SimpleNamespace(ADAPTER_VERSION="hermes-v0.23.4", check=self.handshake)}
        self.success = True
        self.commands = []
        self.args = SimpleNamespace(apply=True, yes=True, non_interactive=True, json=True)

    def handshake(self, _marker, _action):
        install.atomic_write_text(self.plan["paths"]["receipt"], "synthetic receipt")
        return self.success

    def run_attach(self):
        with (patch.object(hermes, "_plan", return_value=self.plan),
              patch.object(hermes, "_profile_status", return_value=self.plan["running"]),
              patch.object(hermes, "_gateway_command", side_effect=lambda _p, verb: self.commands.append(verb)),
              patch.object(install, "observe", return_value=self.report),
              patch.object(operations, "log_event", return_value="fixture")):
            return hermes.run_attach(self.args, "8" * 32)

    def test_dry_run_changes_nothing(self):
        self.args.apply = False
        result = self.run_attach()
        self.assertEqual(result["outcome"], "ok")
        self.assertTrue(result["attach"]["dryRun"])
        self.assertEqual(self.plan["paths"]["source"].read_text(), "original\n")
        self.assertFalse(self.plan["paths"]["marker"].exists())
        self.assertFalse((self.plan["home"] / "deploy.lock").exists())

    def test_apply_leaves_stopped_gateway_stopped_and_private_backup(self):
        result = self.run_attach()
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(self.commands, [])
        self.assertEqual(self.plan["paths"]["source"].read_text(), "patched\n")
        backup_dir = self.plan["home"] / "data/standalone/attach-backups" / ("8" * 32)
        self.assertEqual((backup_dir / "source.orig").read_text(), "original\n")
        self.assertEqual((backup_dir / "source.orig").stat().st_mode & 0o777, 0o600)

    def test_failed_handshake_restores_bytes_receipt_and_restarts_old_running_gateway(self):
        self.plan["running"] = True
        self.success = False
        result = self.run_attach()
        self.assertEqual(result["error"]["code"], "attach_failed")
        self.assertEqual(self.commands, ["restart", "restart"])
        self.assertEqual(self.plan["paths"]["source"].read_text(), "original\n")
        for name in ("helper", "marker", "receipt", "host"):
            self.assertFalse(self.plan["paths"][name].exists(), name)

    def test_wrong_version_owner_readback_rolls_back_despite_successful_handshake(self):
        self.report["hermesRoute"]["adapterVersion"] = "hermes-v0.23.3"
        result = self.run_attach()
        self.assertEqual(result.get("error", {}).get("code"), "attach_failed")
        self.assertEqual(self.plan["paths"]["source"].read_text(), "original\n")
        for name in ("helper", "marker", "receipt", "host"):
            self.assertFalse(self.plan["paths"][name].exists(), name)

    def test_failed_version_transition_restores_prior_attachment_bytes_and_modes(self):
        prior = {"source": (b"prior source\n", 0o644), "helper": (b"prior helper\n", 0o644),
                 "marker": (b"prior marker\n", 0o600), "receipt": (b"prior receipt\n", 0o600),
                 "host": (b"prior host\n", 0o600)}
        for name, record in prior.items():
            hermes._write(self.plan["paths"][name], record)
        self.plan["original"] = prior
        self.plan["desired"] = {"source": prior["source"], "helper": (b"new helper\n", 0o644),
                                "marker": prior["marker"], "host": (b"new host\n", 0o600)}
        self.plan["adapter"].ADAPTER_VERSION = "hermes-v0.23.2"
        self.plan["running"] = True
        result = self.run_attach()
        self.assertEqual(result.get("error", {}).get("code"), "attach_failed")
        self.assertEqual(self.commands, ["restart", "restart"])
        for name, record in prior.items():
            self.assertEqual(hermes._read(self.plan["paths"][name]), record, name)

    def typed_plan(self):
        route_id = "12345678-1234-4234-8234-123456789abc"
        marker = {"schemaVersion": 2, "state": "provisional", "routeId": None, "capabilities": ["text"]}
        host = {"schemaVersion": 2, "routeId": None, "capabilities": ["text"]}
        record = lambda data: ((json.dumps(data, sort_keys=True) + "\n").encode(), 0o600)
        route = {"state": "connected", "profile": "fixture", "adapterVersion": "hermes-v0.23.4",
                 "verifiedAt": "2026-11-26T00:00:00Z", "protocolVersion": 2, "routeId": route_id,
                 "capabilities": ["text"]}
        self.plan.update(protocol=2, typedTransaction=True, provisional=record(marker))
        self.plan["desired"].update(marker=record(marker), host=record(host))
        self.report["hermesRoute"] = route
        self.plan["running"] = True

        def handshake(path):
            self.assertEqual(hermes._read(path), self.plan["provisional"])
            receipt = {"schemaVersion": 2, **{k: v for k, v in route.items() if k != "protocolVersion"}}
            install.atomic_write_text(self.plan["paths"]["receipt"], json.dumps(receipt))
            return route if self.success else None

        self.plan["adapter"].typed_check = handshake
        return route_id, record

    def test_typed_marker_published_only_after_route_host_and_liveness_verification(self):
        route_id, _ = self.typed_plan()
        original_observe = self.report.copy()
        seen = []

        def observe(*_):
            self.assertEqual(hermes._read(self.plan["paths"]["marker"]), self.plan["provisional"])
            self.assertEqual(json.loads(self.plan["paths"]["host"].read_text())["routeId"], route_id)
            seen.append("verified")
            return original_observe

        with (patch.object(hermes, "_plan", return_value=self.plan),
              patch.object(hermes, "_profile_status", return_value=True),
              patch.object(hermes, "_gateway_command", side_effect=lambda *_: self.assertEqual(
                  hermes._read(self.plan["paths"]["marker"]), self.plan["provisional"])),
              patch.object(install, "observe", side_effect=observe),
              patch.object(operations, "log_event", return_value="fixture")):
            result = hermes.run_attach(self.args, "8" * 32)
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(seen, ["verified"])
        marker = json.loads(self.plan["paths"]["marker"].read_text())
        self.assertEqual((marker["state"], marker["routeId"]), ("active", route_id))

    def test_typed_failure_restores_previous_marker_last(self):
        self.typed_plan()
        prior = {"source": (b"prior source\n", 0o644), "helper": (b"prior helper\n", 0o644),
                 "marker": (b"prior active marker\n", 0o600), "receipt": (b"prior receipt\n", 0o600),
                 "host": (b"prior host\n", 0o600)}
        for name, record in prior.items():
            hermes._write(self.plan["paths"][name], record)
        self.plan["original"] = prior
        self.success = False
        calls = []

        def restart(*_):
            self.assertEqual(hermes._read(self.plan["paths"]["marker"]), self.plan["provisional"])
            calls.append("restart")

        with (patch.object(hermes, "_plan", return_value=self.plan),
              patch.object(hermes, "_profile_status", return_value=True),
              patch.object(hermes, "_gateway_command", side_effect=restart),
              patch.object(install, "observe", return_value=self.report),
              patch.object(operations, "log_event", return_value="fixture")):
            result = hermes.run_attach(self.args, "8" * 32)
        self.assertEqual(result["error"]["code"], "attach_failed")
        self.assertEqual(calls, ["restart", "restart"])
        for name, record in prior.items():
            self.assertEqual(hermes._read(self.plan["paths"][name]), record, name)

    def test_typed_readback_transport_error_rolls_back(self):
        self.typed_plan()
        with (patch.object(hermes, "_plan", return_value=self.plan),
              patch.object(hermes, "_profile_status", return_value=True),
              patch.object(hermes, "_gateway_command"),
              patch.object(install, "observe", side_effect=hermes.compose.RunError("fixture")),
              patch.object(operations, "log_event", return_value="fixture")):
            result = hermes.run_attach(self.args, "8" * 32)
        self.assertEqual(result["error"]["code"], "attach_failed")
        for name, record in self.plan["original"].items():
            self.assertEqual(hermes._read(self.plan["paths"][name], optional=True), record, name)

    def test_published_marker_durability_warning_does_not_roll_back(self):
        route_id, _ = self.typed_plan()

        def publish(path, record):
            hermes._write(path, record)
            return False

        with patch.object(hermes, "_publish_marker", side_effect=publish):
            result = self.run_attach()
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(json.loads(self.plan["paths"]["marker"].read_text())["routeId"], route_id)
        self.assertEqual(self.commands, ["restart"])


if __name__ == "__main__":
    unittest.main()
