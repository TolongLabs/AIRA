"""Offline backups and update transaction tests with a synthetic Docker boundary."""

import json
import os
import sqlite3
import tempfile
import unittest
from contextlib import ExitStack, closing
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy.cli import backup, compose, install, operations, update
from deploy.cli.result import CommandError, operational_error


def private(path, text):
    path.write_text(text, encoding="utf-8")
    path.chmod(0o600)


def fixture_data(data):
    data.mkdir(mode=0o700)
    with closing(sqlite3.connect(data / "aira.db")) as db, db:
        db.execute("CREATE TABLE fixture (value TEXT)")
        db.execute("INSERT INTO fixture VALUES ('before')")
    (data / "standalone").mkdir(mode=0o700)
    private(data / "standalone" / "owner.token", "a" * 64)
    private(data / "standalone" / "gateway.token", "b" * 64)
    (data / "standalone" / "revisions").mkdir(mode=0o700)
    private(data / "standalone" / "revisions" / "fixture.credentials.json", '{"main":"synthetic-secret"}')
    (data / "characters").mkdir(mode=0o755)
    private(data / "characters" / "fixture.yml", "fictional pack")


class BackupTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.data = self.root / "data"
        fixture_data(self.data)

    def test_verified_backup_restores_private_state_without_losing_later_writes(self):
        path = backup.create_backup(self.data, "1" * 32)
        inventory = backup.verify_backup(path)
        self.assertTrue(any(e.path.endswith("fixture.credentials.json") for e in inventory.entries))
        with closing(sqlite3.connect(self.data / "aira.db")) as db, db:
            db.execute("INSERT INTO fixture VALUES ('after')")
        restored = backup.restore_backup(path, self.root / "restored")
        self.assertEqual((restored / "standalone/owner.token").read_bytes(),
                         (self.data / "standalone/owner.token").read_bytes())
        self.assertEqual((restored / "standalone/revisions/fixture.credentials.json").stat().st_mode & 0o777, 0o600)
        with closing(sqlite3.connect(restored / "aira.db")) as db:
            self.assertEqual(db.execute("SELECT value FROM fixture").fetchall(), [("before",)])
        with closing(sqlite3.connect(self.data / "aira.db")) as db:
            self.assertEqual(db.execute("SELECT value FROM fixture").fetchall(), [("before",), ("after",)])

    def test_tamper_and_unsafe_destination_refuse_without_mutation(self):
        path = backup.create_backup(self.data, "2" * 32)
        target = self.root / "occupied"
        target.mkdir(mode=0o755)
        (target / "unrelated").write_text("untouched")
        with self.assertRaises(CommandError):
            backup.restore_backup(path, target)
        self.assertEqual(target.stat().st_mode & 0o777, 0o755)
        self.assertEqual((target / "unrelated").read_text(), "untouched")
        private(path / "standalone/owner.token", "corrupted")
        with self.assertRaises(CommandError):
            backup.verify_backup(path)
        with self.assertRaises(CommandError):
            backup.restore_backup(path, self.root / "absent")
        self.assertFalse((self.root / "absent").exists())

    def test_link_or_missing_credential_prevents_backup_publication(self):
        (self.data / "standalone/link").symlink_to(self.data / "standalone/owner.token")
        with self.assertRaises(CommandError):
            backup.create_backup(self.data, "3" * 32)
        self.assertFalse((self.data / "deploy-recovery" / ("3" * 32)).exists())
        (self.data / "standalone/link").unlink()
        (self.data / "standalone/gateway.token").unlink()
        with self.assertRaises(CommandError):
            backup.create_backup(self.data, "4" * 32)

    def test_wal_database_backup_remains_verifiable_after_repeated_readback(self):
        with closing(sqlite3.connect(self.data / "aira.db")) as db, db:
            self.assertEqual(db.execute("PRAGMA journal_mode=WAL").fetchone()[0], "wal")
            db.execute("INSERT INTO fixture VALUES ('wal-state')")
        path = backup.create_backup(self.data, "6" * 32)
        backup.verify_backup(path)
        backup.verify_backup(path)
        self.assertFalse((path / "aira.db-wal").exists())
        self.assertFalse((path / "aira.db-shm").exists())


class UpdateTests(unittest.TestCase):
    OLD = "sha256:" + "1" * 64
    NEW = "sha256:" + "2" * 64

    def setUp(self):
        temp = tempfile.TemporaryDirectory()
        self.addCleanup(temp.cleanup)
        self.home = Path(temp.name)
        self.manifest = install.Manifest(installId="a" * 32, project="aira-fixture", release="old",
            imageId=self.OLD, sitePort=9891, corePort=9882, uid=os.geteuid(), gid=os.getegid(), stage="installed")
        install.write_manifest(self.home, self.manifest)
        private(self.home / ".env", "AIRA_IMAGE='fixture'\nAIRA_VERSION='old'\nAIRA_SITE_PORT='9891'\n")
        fixture_data(self.home / "data")
        self.bindings = {9881: ("127.0.0.1", 9882), 9890: ("127.0.0.1", 9891)}
        self.active = self.OLD
        self.trace = []
        self.probe_ok = True
        self.fail_recovery = False
        self.fail_pull = False
        self.stack = ExitStack()
        self.addCleanup(self.stack.close)
        def pin(image, _tag): self.trace.append(("pin", image))
        def pull(_ref):
            self.trace.append(("pull", None))
            if self.fail_pull:
                raise operational_error("image_pull_failed", "Pull failed.", "pull")
        def up(home, _project):
            ref = compose.parse_env_file(home / ".env")["AIRA_VERSION"]
            self.active = self.OLD if ref.startswith("prev-") else self.NEW
            self.trace.append(("start", self.active))
            if self.active == self.OLD and self.fail_recovery:
                raise compose.RunError("failed")
        def verify(*_args, **_kwargs): return self.bindings, self.active, {"status": "ready"}
        def observe(*_args):
            return {"state": {"installation": "installed", "service": "running"}, "checks": [], "warnings": [],
                    "dashboard": None, "mode": "standalone", "management": "stable", "imageId": self.active}
        for obj, name, kw in [
            (compose, "detect_project", {"return_value": self.manifest.project}),
            (compose, "ps_entries", {"return_value": [{"State": "running"}]}),
            (compose, "published_bindings", {"return_value": self.bindings}),
            (compose, "container_image_id", {"side_effect": lambda *_args: self.active}),
            (compose, "pull_image", {"side_effect": pull}),
            (compose, "compose_stop", {"side_effect": lambda *_a: self.trace.append(("stop", None))}),
            (compose, "compose_up", {"side_effect": up}),
            (install, "_verify", {"side_effect": verify}),
            (install, "observe", {"side_effect": observe}),
            (update, "_ensure_pin", {"side_effect": pin}),
            (update, "_docker_image_id", {"side_effect": lambda ref: self.OLD if ":prev-" in ref else self.NEW}),
            (update, "_docker_label", {"return_value": "1"}),
            (update, "_wait_for_idle", {"return_value": True}),
            (update, "_probe_candidate", {"side_effect": lambda *_a: self.probe_ok}),
            (operations, "log_event", {"return_value": "fixture"}),
        ]:
            self.stack.enter_context(patch.object(obj, name, **kw))

    def run_update(self):
        return update.update_command(SimpleNamespace(image=None), self.home, self.manifest, "5" * 32)

    def test_good_update_pins_before_pull_and_commits_after_verified_snapshot(self):
        result = self.run_update()
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(self.trace[:2], [("pin", self.OLD), ("pull", None)])
        self.assertEqual(install.read_manifest(self.home).imageId, self.NEW)
        self.assertFalse((self.home / "update.json").exists())
        backup.verify_backup(self.home / "data/deploy-recovery" / ("5" * 32))

    def test_pull_failure_does_not_stop_or_change_selection(self):
        self.fail_pull = True
        before = (self.home / ".env").read_bytes()
        result = self.run_update()
        self.assertEqual(result["error"]["code"], "image_pull_failed")
        self.assertNotIn(("stop", None), self.trace)
        self.assertEqual((self.home / ".env").read_bytes(), before)

    def test_probe_failure_rolls_back_exact_image_and_keeps_data(self):
        self.probe_ok = False
        result = self.run_update()
        self.assertEqual(result["error"]["code"], "update_rolled_back")
        self.assertEqual(self.active, self.OLD)
        self.assertEqual(install.read_manifest(self.home).imageId, self.OLD)
        self.assertFalse((self.home / "update.json").exists())

    def test_failed_recovery_preserves_journal_and_reports_manual_recovery(self):
        self.probe_ok = False
        self.fail_recovery = True
        result = self.run_update()
        self.assertEqual(result["error"]["code"], "rollback_failed")
        self.assertEqual(result["error"]["exitClass"], "rollback")
        self.assertTrue((self.home / "update.json").exists())

    def test_ci_managed_install_changes_nothing(self):
        self.manifest.management = "ci"
        result = self.run_update()
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(self.trace, [])


if __name__ == "__main__":
    unittest.main()
