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
                       "dashboard": None, "hermesRoute": {"state": "connected", "profile": "fixture"}}
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


if __name__ == "__main__":
    unittest.main()
