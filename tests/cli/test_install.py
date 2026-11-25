"""Contract tests: no real Docker, install, credentials, or live service."""
import json
import os
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy.cli import compose, install, launcher
from deploy.cli.result import CommandError

REPO = Path(__file__).resolve().parents[2]


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="aira-cli-fixture-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.env = patch.dict(
            os.environ,
            {
                "HOME": str(self.root),
                "PATH": os.environ.get("PATH", ""),
                "XDG_CONFIG_HOME": str(self.root / "config"),
                "XDG_STATE_HOME": str(self.root / "state"),
            },
            clear=True,
        )
        self.env.start()
        self.addCleanup(self.env.stop)

    def legacy(self, home):
        home.mkdir(mode=0o700)
        (home / "compose.yml").write_text("services:\n  aira:\n    image: example:stable\n")
        (home / "config.yml").write_text("gateway: {}\n")
        (home / ".env").write_text("AIRA_VERSION=sha-abcdef0\nAIRA_SITE_PORT=9890\n")
        (home / ".env").chmod(0o600)
        token = self.root / ".hermes" / "brain" / ".site-token"
        token.parent.mkdir(parents=True, exist_ok=True)
        token.write_text("synthetic-legacy-token")
        token.chmod(0o600)

    def test_checkout_falls_back_and_read_only_discovery_writes_nothing(self):
        source = self.root / "aira"
        (source / "deploy").mkdir(parents=True)
        (source / "src").mkdir()
        home, _ = install.resolve_home()
        self.assertEqual(home, launcher.fresh_home_fallback())
        self.assertFalse(home.exists())
        self.assertFalse(install.locator_path().exists())

    def test_ambiguous_install_requires_selection(self):
        self.legacy(self.root / "aira")
        fallback = launcher.fresh_home_fallback()
        fallback.parent.mkdir(parents=True)
        self.legacy(fallback)
        with self.assertRaises(CommandError) as ctx:
            install.resolve_home()
        self.assertEqual(ctx.exception.code, "install_ambiguous")
        self.assertEqual(install.resolve_home(str(fallback))[0], fallback)

    def test_port_scan_increases_and_explicit_port_is_exact(self):
        with patch.object(install, "port_free", side_effect=lambda p: p not in (9890, 9881)):
            self.assertEqual(install.pick_ports(None, None), (9891, 9882))
            with self.assertRaises(CommandError) as ctx:
                install.pick_ports(9890, None)
            self.assertEqual(ctx.exception.code, "port_conflict")

    def test_private_files_refuse_symlink_and_do_not_change_existing_mode(self):
        root = self.root / "private"
        root.mkdir(mode=0o700)
        other = root / "other"
        other.write_text("untouched")
        target = root / "target"
        target.symlink_to(other)
        with self.assertRaises(CommandError):
            install.atomic_write_text(target, "new")
        self.assertEqual(other.read_text(), "untouched")
        self.assertTrue(target.is_symlink())
        root.chmod(0o755)
        with self.assertRaises(CommandError):
            install.ensure_private_dir(root)
        self.assertEqual(root.stat().st_mode & 0o777, 0o755)

    def test_unrelated_directory_is_not_overwritten(self):
        unrelated = self.root / "unrelated"
        unrelated.mkdir(mode=0o700)
        existing = unrelated / "config.yml"
        existing.write_text("unrelated fixture")
        args = SimpleNamespace(home=str(unrelated), site_port=None, core_port=None,
                               image=None, repo_root=str(REPO), no_open=True,
                               json=True, non_interactive=True)
        with (patch.object(install, "preflight", return_value=[]),
              patch.object(compose, "run", side_effect=AssertionError("unexpected Docker call"))):
            result, _ = install.run_setup(args)
        self.assertEqual(result["outcome"], "error")
        self.assertEqual(existing.read_text(), "unrelated fixture")
        self.assertFalse((unrelated / "install.json").exists())

    def test_legacy_status_uses_observed_mapping_without_adoption_writes(self):
        home = self.root / "old"
        self.legacy(home)
        with (
            patch.object(compose, "detect_project", return_value="existing-project"),
            patch.object(compose, "ps_entries", return_value=[{"State": "running"}]),
            patch.object(compose, "published_bindings", return_value={
                9881: ("127.0.0.1", 9885), 9890: ("127.0.0.1", 9898)
            }),
            patch.object(compose, "container_image_id", return_value="sha256:" + "a" * 64),
            patch.object(compose, "http_get_json", return_value=(200, {"status": "ready"}, "ok")),
            patch.object(compose, "probe_owner_legacy", return_value=True),
            patch.object(install, "check_persistence", return_value=("verified", "")),
        ):
            report = install.observe(home, None)
        self.assertEqual(report["state"]["installation"], "installed")
        self.assertEqual(report["state"]["service"], "running")
        self.assertEqual(report["dashboard"]["url"], "http://127.0.0.1:9898/overview")
        self.assertFalse((home / "install.json").exists())
        self.assertFalse((home / "deploy.lock").exists())
        self.assertFalse(install.locator_path().exists())

    def test_fresh_setup_and_repeat_keep_committed_ports_and_inputs(self):
        home = self.root / "portable"
        args = SimpleNamespace(home=str(home), site_port=9891, core_port=9882,
                               image="fixture:local", repo_root=str(REPO),
                               no_open=True, json=True, non_interactive=True)
        running = False
        health = {"status": "ready", "schemaVersion": 1, "installationMode": "standalone",
                  "configuration": "setup_required", "chatbot": "inactive"}

        def current_project(_home):
            return install.read_manifest(home).project if running else None

        def start(_home, _project):
            nonlocal running
            running = True
            private = home / "data" / "standalone"
            private.mkdir(mode=0o700)
            token = private / "owner.token"
            token.write_text("ab" * 32 + "\n")
            token.chmod(0o600)

        def mappings(_home, _project):
            if not running:
                return {}
            known = compose.parse_env_file(home / ".env")
            return {9881: ("127.0.0.1", int(known["AIRA_PORT"])),
                    9890: ("127.0.0.1", int(known["AIRA_SITE_PORT"]))}

        with (
            patch.object(install, "preflight", return_value=[]),
            patch.object(install, "port_free", return_value=True),
            patch.object(compose, "detect_project", side_effect=current_project),
            patch.object(compose, "local_image_present", return_value=True),
            patch.object(compose, "compose_up", side_effect=start) as up,
            patch.object(compose, "ps_entries", side_effect=lambda *_: [{"State": "running"}] if running else []),
            patch.object(compose, "published_bindings", side_effect=mappings),
            patch.object(compose, "container_image_id", return_value="sha256:" + "a" * 64),
            patch.object(compose, "probe_core", return_value=("ready", health)),
            patch.object(compose, "probe_owner_standalone", return_value=(True, health)),
            patch.object(compose, "http_request", return_value=(200, b"<html>Fixture</html>", "ok")),
            patch.object(install, "check_persistence", return_value=("verified", "")) as persistence,
        ):
            result, _ = install.run_setup(args)
            self.assertEqual(result["outcome"], "ok", result)
            manifest = install.read_manifest(home)
            self.assertEqual(manifest.stage, "installed")
            self.assertEqual((manifest.sitePort, manifest.corePort), (9891, 9882))
            self.assertEqual(result["state"]["configuration"], "setup_required")
            self.assertEqual(result["dashboard"]["url"], "http://127.0.0.1:9891/overview")
            self.assertEqual((home / ".env").stat().st_mode & 0o777, 0o600)
            before = {name: (home / name).read_bytes() for name in ("compose.yml", "config.yml", ".env")}
            args.image = None
            args.site_port = args.core_port = None
            persistence.return_value = ("degraded", "fixture boot disabled")
            second, _ = install.run_setup(args)
            self.assertEqual(second["error"]["code"], "persistence_degraded")
            self.assertEqual(second["state"]["service"], "running")
            self.assertEqual(second["dashboard"]["url"], result["dashboard"]["url"])
            self.assertEqual(before, {name: (home / name).read_bytes() for name in before})
            up.assert_called_once()

    def test_deploy_lock_conflict_does_not_modify_state(self):
        home = self.root / "locked"
        home.mkdir(mode=0o700)
        with install.DeployLock(home):
            other = install.DeployLock(home)
            with self.assertRaises(CommandError) as ctx:
                other.acquire(timeout_s=0.01)
            self.assertEqual(ctx.exception.code, "deploy_locked")

    def test_cli_help_and_status_are_install_independent(self):
        command = [str(REPO / "aira")]
        help_result = subprocess.run(command + ["--help"], capture_output=True, text=True, timeout=10)
        self.assertEqual(help_result.returncode, 0)
        status = subprocess.run(command + ["--json", "status"], capture_output=True, text=True, timeout=10)
        self.assertEqual(status.returncode, 0)
        parsed = json.loads(status.stdout)
        self.assertEqual(parsed["state"]["installation"], "not_installed")
        self.assertFalse((self.root / "aira").exists())


class ProtectedProbeTests(unittest.TestCase):
    def test_owner_probe_does_not_follow_redirect(self):
        seen = []

        class Target(BaseHTTPRequestHandler):
            def log_message(self, *_): pass

            def do_GET(self):
                seen.append(self.headers.get("X-TolongAI-Token"))
                self.send_response(200)
                self.end_headers()

        target = ThreadingHTTPServer(("127.0.0.1", 0), Target)

        class Redirect(BaseHTTPRequestHandler):
            def log_message(self, *_): pass

            def do_GET(self):
                self.send_response(302)
                self.send_header("Location", f"http://127.0.0.1:{target.server_port}/")
                self.end_headers()

        redirect = ThreadingHTTPServer(("127.0.0.1", 0), Redirect)
        servers = [target, redirect]
        threads = [threading.Thread(target=s.serve_forever, daemon=True) for s in servers]
        for thread in threads:
            thread.start()
        try:
            status, _, _ = compose.http_get_json(
                f"http://127.0.0.1:{redirect.server_port}/", headers={"X-TolongAI-Token": "synthetic-canary"}
            )
            self.assertEqual(status, 302)
            self.assertEqual(seen, [])
        finally:
            for server in servers:
                server.shutdown()
                server.server_close()
            for thread in threads:
                thread.join()


if __name__ == "__main__":
    unittest.main()
