"""P8 supplemental failure evidence: install preflight, staged retry, logs, open, reveal.

Stdlib unittest only. No Docker, no network, no real tokens, no host reads.
Every external boundary is mocked; assertions check behavior and recovery.
"""
import contextlib
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy.cli import compose, diagnostics, install, main, operations
from deploy.cli.result import CommandError, EXIT_PREREQ, exit_for_envelope

REPO = Path(__file__).resolve().parents[2]
SYNTH_TOKEN = "ab" * 32
HEALTH = {
    "status": "ready", "schemaVersion": 1, "installationMode": "standalone",
    "configuration": "setup_required", "chatbot": "inactive",
}
IMAGE_ID = "sha256:" + "a" * 64


class TempEnv(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="aira-fail-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        env = patch.dict(os.environ, {
            "HOME": str(self.root),
            "XDG_CONFIG_HOME": str(self.root / "config"),
            "XDG_STATE_HOME": str(self.root / "state"),
            "PATH": os.environ.get("PATH", ""),
        }, clear=True)
        env.start()
        self.addCleanup(env.stop)


def fresh_args(home, **over):
    params = dict(home=str(home), site_port=None, core_port=None, image=None,
                  repo_root=str(REPO), no_open=True, json=True, non_interactive=True)
    params.update(over)
    return SimpleNamespace(**params)


def docker_ok(argv, timeout_s=10, env=None, daemon="linux/x86_64"):
    text = " ".join(argv)
    if argv[:3] == ["docker", "compose", "version"]:
        return 0, "v2.24.0\n", ""
    if argv[:3] == ["docker", "context", "inspect"]:
        return 0, "unix:///var/run/docker.sock\n", ""
    if "OperatingSystem" in text:
        return 0, "Ubuntu 22.04 LTS\n", ""
    if "OSType" in text:
        return 0, daemon + "\n", ""
    if "SecurityOptions" in text:
        return 0, "[]\n", ""
    raise AssertionError("Unexpected fixture command")


def assert_prereq(test, result, home, code):
    test.assertEqual(result["outcome"], "error")
    test.assertEqual(result["error"]["code"], code)
    test.assertEqual(result["error"]["stage"], "preflight")
    test.assertTrue(result["error"]["recovery"])
    test.assertEqual(result["error"]["exitClass"], "prerequisite")
    test.assertEqual(exit_for_envelope(result), EXIT_PREREQ)
    test.assertFalse((home / "install.json").exists())
    test.assertFalse((home / "compose.yml").exists())
    test.assertFalse((home / ".env").exists())


class PreflightFailureTests(TempEnv):
    def base(self, home):
        return fresh_args(home)

    def test_missing_docker_reports_docker_missing(self):
        home = self.root / "missing"
        with (patch("os.geteuid", return_value=1000),
              patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="x86_64"),
              patch.object(compose, "run", side_effect=compose.RunError("missing"))):
            result, _ = install.run_setup(self.base(home))
        assert_prereq(self, result, home, "docker_missing")
        self.assertIn("Docker", result["error"]["recovery"])

    def test_denied_docker_reports_permission(self):
        home = self.root / "denied"
        with (patch("os.geteuid", return_value=1000),
              patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="x86_64"),
              patch.object(compose, "run", side_effect=compose.RunError("denied"))):
            result, _ = install.run_setup(self.base(home))
        assert_prereq(self, result, home, "docker_permission")

    def test_unreachable_daemon_reports_unreachable(self):
        home = self.root / "down"

        def route(argv, timeout_s=10, env=None):
            text = " ".join(argv)
            if "version" in text:
                return 0, "v2.24.0\n", ""
            if "context" in text:
                return 0, "unix:///var/run/docker.sock\n", ""
            return 1, "", "Cannot connect to the Docker daemon"

        with (patch("os.geteuid", return_value=1000),
              patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="x86_64"),
              patch.object(compose, "run", side_effect=route),
              patch("shutil.disk_usage") as disk,
              patch("os.access", return_value=True)):
            disk.return_value.free = 8 * 1024 ** 3
            result, _ = install.run_setup(self.base(home))
        assert_prereq(self, result, home, "docker_unreachable")

    def test_unsupported_platform_and_arch(self):
        for system, machine in (("Darwin", "x86_64"), ("Darwin", "arm64"),
                                ("Linux", "riscv64"), ("Linux", "i686")):
            home = self.root / f"plat-{system}-{machine}"
            with (patch("os.geteuid", return_value=1000),
                  patch.object(install.platform, "system", return_value=system),
                  patch.object(install.platform, "machine", return_value=machine),
                  patch.object(compose, "run", side_effect=AssertionError("no docker call"))):
                result, _ = install.run_setup(self.base(home))
            assert_prereq(self, result, home, "unsupported_platform")

    def test_root_user_refused(self):
        home = self.root / "root"
        with (patch("os.geteuid", return_value=0),
              patch.object(compose, "run", side_effect=AssertionError("no docker call"))):
            result, _ = install.run_setup(self.base(home))
        assert_prereq(self, result, home, "unsupported_platform")

    def test_low_disk_reports_disk_full(self):
        home = self.root / "disk"
        with (patch("os.geteuid", return_value=1000),
              patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="x86_64"),
              patch.object(compose, "run", side_effect=docker_ok),
              patch("shutil.disk_usage") as disk):
            disk.return_value.free = 512
            result, _ = install.run_setup(self.base(home))
        assert_prereq(self, result, home, "disk_full")

    def test_unwritable_path_reports_path_unwritable(self):
        home = self.root / "nowrite"
        with (patch("os.geteuid", return_value=1000),
              patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="x86_64"),
              patch.object(compose, "run", side_effect=docker_ok),
              patch("shutil.disk_usage") as disk,
              patch("os.access", return_value=False)):
            disk.return_value.free = 8 * 1024 ** 3
            result, _ = install.run_setup(self.base(home))
        assert_prereq(self, result, home, "path_unwritable")


class StagedRetryTests(TempEnv):
    def state(self):
        return {"running": False}

    def mappings(self, home, flag):
        def current(_home, _project):
            if not flag["running"]:
                return {}
            known = compose.parse_env_file(home / ".env")
            return {9881: ("127.0.0.1", int(known["AIRA_PORT"])),
                    9890: ("127.0.0.1", int(known["AIRA_SITE_PORT"]))}
        return current

    def project(self, home):
        def current(_home):
            try:
                return install.read_manifest(home).project
            except (CommandError, OSError, ValueError):
                return None
        return current

    def starter(self, home, flag):
        def start(_home, _project):
            flag["running"] = True
            private = home / "data" / "standalone"
            private.mkdir(parents=True, exist_ok=True, mode=0o700)
            token = private / "owner.token"
            token.write_text(SYNTH_TOKEN + "\n")
            token.chmod(0o600)
        return start

    def base_patches(self, home, flag, **over):
        return [
            patch.object(compose, "run", side_effect=AssertionError("no external Docker command")),
            patch.object(install, "preflight", return_value=[]),
            patch.object(install, "port_free", return_value=True),
            patch.object(install, "check_persistence", return_value=("verified", "")),
            patch.object(compose, "detect_project", side_effect=self.project(home)),
            patch.object(compose, "local_image_present", return_value=True),
            patch.object(install, "verify_native_image", return_value="linux/amd64"),
            patch.object(compose, "pull_image", return_value=None),
            patch.object(compose, "ps_entries",
                         side_effect=lambda *_: [{"State": "running"}] if flag["running"] else []),
            patch.object(compose, "published_bindings", side_effect=self.mappings(home, flag)),
            patch.object(compose, "container_image_id", return_value=IMAGE_ID),
            patch.object(compose, "probe_core",
                         return_value=over.get("core", ("ready", HEALTH))),
            patch.object(compose, "probe_owner_standalone",
                         return_value=over.get("owner", (True, HEALTH))),
            patch.object(compose, "http_request",
                         return_value=(200, b"<html>Fixture</html>", "ok")),
            patch.object(compose, "http_get_json", return_value=(503, None, "fixture")),
            patch.object(compose, "compose_stop", side_effect=lambda *_: flag.update(running=False)),
        ]

    def start_all(self, patches):
        for entered in patches:
            entered.start()
            self.addCleanup(entered.stop)

    def staged_files_private(self, home):
        self.assertTrue((home / "compose.yml").is_file())
        self.assertTrue((home / "config.yml").is_file())
        self.assertTrue((home / ".env").is_file())
        self.assertEqual((home / ".env").stat().st_mode & 0o777, 0o600)
        self.assertEqual((home / "data").stat().st_mode & 0o777, 0o700)
        manifest = install.read_manifest(home)
        self.assertEqual(manifest.stage, "prepared")
        self.assertFalse(install.locator_path().exists())
        return manifest

    def test_pull_failure_keeps_prepared_manifest(self):
        home = self.root / "pull"
        flag = self.state()
        guards = self.base_patches(home, flag)
        guards.append(patch.object(compose, "local_image_present", return_value=False))
        guards.append(patch.object(
            compose, "pull_image",
            side_effect=install.operational_error(
                "image_pull_failed", "The image could not be pulled.", "pull",
                "Check Docker and registry access, then run aira setup.", retryable=True)))
        self.start_all(guards)
        with patch.object(compose, "compose_up",
                          side_effect=AssertionError("must not start before pull")):
            result, _ = install.run_setup(fresh_args(home))
        self.assertEqual(result["outcome"], "error")
        self.assertEqual(result["error"]["code"], "image_pull_failed")
        self.assertEqual(result["error"]["stage"], "pull")
        self.assertTrue(result["error"]["retryable"])
        self.staged_files_private(home)

    def test_interruption_retains_manifest_and_retry_succeeds(self):
        home = self.root / "interrupt"
        flag = self.state()
        self.start_all(self.base_patches(home, flag))
        calls = {"count": 0}

        def flaky(_home, _project):
            calls["count"] += 1
            if calls["count"] == 1:
                raise KeyboardInterrupt()
            self.starter(home, flag)(_home, _project)

        with patch.object(compose, "compose_up", side_effect=flaky):
            first, _ = install.run_setup(fresh_args(home))
            self.assertEqual(first["outcome"], "error")
            self.assertEqual(first["error"]["code"], "operation_interrupted")
            self.staged_files_private(home)
            second, _ = install.run_setup(fresh_args(home))
        self.assertEqual(second["outcome"], "ok", second)
        manifest = install.read_manifest(home)
        self.assertEqual(manifest.stage, "installed")
        self.assertTrue(install.locator_path().is_file())

    def test_port_bind_race_recovers_automatically(self):
        home = self.root / "race"
        flag = self.state()
        self.start_all(self.base_patches(home, flag))
        calls = []

        def flaky(_home, _project):
            calls.append(dict(flag))
            if len(calls) == 1:
                raise compose.PortInUseError()
            self.starter(home, flag)(_home, _project)

        with patch.object(compose, "compose_up", side_effect=flaky):
            result, _ = install.run_setup(fresh_args(home))
        self.assertEqual(result["outcome"], "ok", result)
        self.assertEqual(len(calls), 2)
        manifest = install.read_manifest(home)
        self.assertEqual(manifest.stage, "installed")
        self.assertEqual((manifest.sitePort, manifest.corePort), (9891, 9882))
        known = compose.parse_env_file(home / ".env")
        self.assertEqual(int(known["AIRA_SITE_PORT"]), manifest.sitePort)

    def test_health_timeout_preserves_staged_state(self):
        home = self.root / "health"
        flag = self.state()
        self.start_all(self.base_patches(home, flag, core=("down", None)))
        with patch.object(compose, "compose_up", side_effect=self.starter(home, flag)) as up:
            result, _ = install.run_setup(fresh_args(home))
            self.assertTrue(up.called)
        self.assertEqual(result["outcome"], "error")
        self.assertEqual(result["error"]["code"], "health_timeout")
        self.assertTrue(result["error"]["recovery"])
        self.staged_files_private(home)
        self.assertTrue((home / "data" / "standalone" / "owner.token").is_file())

    def test_owner_auth_failure_preserves_staged_state(self):
        home = self.root / "owner"
        flag = self.state()
        self.start_all(self.base_patches(home, flag, owner=(False, None)))
        with patch.object(compose, "compose_up", side_effect=self.starter(home, flag)):
            result, _ = install.run_setup(fresh_args(home))
        self.assertEqual(result["outcome"], "error")
        self.assertEqual(result["error"]["code"], "owner_auth_failed")
        self.staged_files_private(home)

    def test_start_failure_reports_truthfully(self):
        home = self.root / "start"
        flag = self.state()
        self.start_all(self.base_patches(home, flag))
        failure = install.operational_error(
            "service_start_failed", "Compose could not start the service.", "start",
            "Run aira doctor, then retry setup.")
        with patch.object(compose, "compose_up", side_effect=failure):
            result, _ = install.run_setup(fresh_args(home))
        self.assertEqual(result["outcome"], "error")
        self.assertEqual(result["error"]["code"], "service_start_failed")
        self.assertEqual(result["error"]["stage"], "start")
        self.staged_files_private(home)


class LogRotationTests(TempEnv):
    def test_rotation_caps_files_sanitizes_and_keeps_newest(self):
        secret = "SECRET-canary-must-never-persist"
        with (patch.object(operations, "MAX_FILE_BYTES", 600),
              patch.object(operations, "MAX_ROTATED", 2)):
            for index in range(20):
                path = operations.log_event(
                    "setup", f"op{index:04d}", f"stage_{index % 3}", f"probe_{index:02d}",
                    "ok", message=secret if index == 19 else "")
                self.assertIsNotNone(path)
            raw = "".join(
                entry.read_text(encoding="utf-8")
                for entry in sorted(Path(path).parent.glob("operations.jsonl*")))
            self.assertNotIn(secret, raw)
            files = sorted(Path(path).parent.glob("operations.jsonl*"))
            self.assertLessEqual(len(files), 3)
            for entry in files:
                self.assertLessEqual(entry.stat().st_size, 600)
                self.assertEqual(entry.stat().st_mode & 0o777, 0o600)
            self.assertEqual(Path(path).parent.stat().st_mode & 0o777, 0o700)
            reasons = [event["reason"] for event in operations.read_events(limit=100)]
            self.assertIn("probe_19", reasons)
            self.assertNotIn("probe_00", reasons)
            newest = operations.read_events(limit=1)[-1]
            self.assertEqual(newest["reason"], "probe_19")
            self.assertEqual(newest["message"], "probe 19")

    def test_invalid_reason_sanitized_to_unknown(self):
        with (patch.object(operations, "MAX_FILE_BYTES", 600),
              patch.object(operations, "MAX_ROTATED", 1)):
            operations.log_event("setup", "op0001", "stage", "bad reason!", "ok", message="x")
            events = operations.read_events(limit=10)
        self.assertTrue(events)
        self.assertEqual(events[-1]["reason"], "unknown")


class BrowserOpenTests(TempEnv):
    def envelope(self):
        return {"state": {"service": "running"},
                "dashboard": {"url": "http://127.0.0.1:9890/overview"}, "warnings": []}

    def args(self, **over):
        params = dict(no_open=False, open=False, json=False, non_interactive=False)
        params.update(over)
        return SimpleNamespace(**params)

    def test_success_invokes_opener_without_warning(self):
        result = self.envelope()
        with (patch.dict(os.environ, {"DISPLAY": ":0"}, clear=False),
              patch("shutil.which", return_value="/usr/bin/xdg-open") as which,
              patch.object(compose, "run", return_value=(0, "", "")) as run):
            main._open(self.args(open=True), result)
        which.assert_called_once_with("xdg-open")
        run.assert_called_once()
        self.assertEqual(run.call_args.args[0],
                         ["/usr/bin/xdg-open", "http://127.0.0.1:9890/overview"])
        self.assertEqual(result["warnings"], [])

    def test_headless_never_launches_and_warns_only_on_open(self):
        with (patch.dict(os.environ, {"SSH_CONNECTION": "1", "DISPLAY": ":0"}, clear=False),
              patch("shutil.which", side_effect=AssertionError("no desktop lookup")),
              patch.object(compose, "run", side_effect=AssertionError("no desktop launch"))):
            quiet = self.envelope()
            main._open(self.args(), quiet)
            self.assertEqual(quiet["warnings"], [])
            loud = self.envelope()
            main._open(self.args(open=True), loud)
            self.assertTrue(any("No usable local desktop" in w for w in loud["warnings"]))

    def test_json_without_open_and_no_open_never_launch(self):
        for argv in (self.args(json=True), self.args(no_open=True, open=True)):
            with (patch.dict(os.environ, {"DISPLAY": ":0"}, clear=False),
                  patch("shutil.which", side_effect=AssertionError("must not look up")),
                  patch.object(compose, "run", side_effect=AssertionError("must not launch"))):
                main._open(argv, self.envelope())

    def test_missing_opener_and_failed_launch_warn_without_throwing(self):
        with (patch.dict(os.environ, {"DISPLAY": ":0"}, clear=False),
              patch("shutil.which", return_value=None),
              patch.object(compose, "run", side_effect=AssertionError("must not run"))):
            result = self.envelope()
            main._open(self.args(open=True), result)
            self.assertTrue(any("browser_open_failed" in w for w in result["warnings"]))
        with (patch.dict(os.environ, {"DISPLAY": ":0"}, clear=False),
              patch("shutil.which", return_value="/usr/bin/xdg-open"),
              patch.object(compose, "run", side_effect=compose.RunError("failed"))):
            failed = self.envelope()
            main._open(self.args(open=True), failed)
            self.assertTrue(any("browser_open_failed" in w for w in failed["warnings"]))


class CredentialRevealTests(TempEnv):
    def test_json_reveal_refused_without_token_output(self):
        args = main.build_parser().parse_args(["dashboard", "--show-token", "--json"])
        buffer = io.StringIO()
        with (patch.object(install, "read_owner_token",
                           side_effect=AssertionError("must not read credential")),
              contextlib.redirect_stdout(buffer)):
            with self.assertRaises(CommandError) as ctx:
                main.cmd_dashboard(args, "opref123")
        self.assertEqual(ctx.exception.code, "owner_auth_failed")
        self.assertEqual(buffer.getvalue(), "")

    def test_non_interactive_reveal_refused(self):
        args = main.build_parser().parse_args(["dashboard", "--show-token", "--non-interactive"])
        with patch.object(install, "read_owner_token",
                          side_effect=AssertionError("must not read credential")):
            with self.assertRaises(CommandError) as ctx:
                main.cmd_dashboard(args, "opref123")
        self.assertEqual(ctx.exception.code, "owner_auth_failed")
        self.assertIn("--show-token", ctx.exception.recovery)
        self.assertIn("TTY", str(ctx.exception))

    def test_non_tty_reveal_refused(self):
        args = main.build_parser().parse_args(["dashboard", "--show-token"])
        buffer = io.StringIO()
        with (patch.object(install, "read_owner_token",
                           side_effect=AssertionError("must not read credential")),
              patch.object(sys.stdin, "isatty", return_value=False),
              patch.object(sys.stdout, "isatty", return_value=False),
              contextlib.redirect_stdout(buffer)):
            with self.assertRaises(CommandError) as ctx:
                main.cmd_dashboard(args, "opref123")
        self.assertEqual(ctx.exception.code, "owner_auth_failed")
        self.assertEqual(buffer.getvalue(), "")


class NativePlatformTests(TempEnv):
    def test_arch_aliases_normalize(self):
        self.assertEqual(install.normalize_native_arch("Linux", "x86_64"), "amd64")
        self.assertEqual(install.normalize_native_arch("Linux", "amd64"), "amd64")
        self.assertEqual(install.normalize_native_arch("Linux", "aarch64"), "arm64")
        self.assertEqual(install.normalize_native_arch("Linux", "arm64"), "arm64")

    def test_unsupported_os_and_arch_return_none(self):
        self.assertIsNone(install.normalize_native_arch("Darwin", "arm64"))
        self.assertIsNone(install.normalize_native_arch("Windows", "amd64"))
        self.assertIsNone(install.normalize_native_arch("Linux", "riscv64"))
        self.assertIsNone(install.normalize_native_arch("Linux", "i686"))
        self.assertIsNone(install.normalize_native_arch("Linux", ""))

    def daemon_route(self, daemon):
        def route(argv, timeout_s=10, env=None):
            return docker_ok(argv, timeout_s, env, daemon)
        return route

    def test_daemon_arch_mismatch_refused(self):
        home = self.root / "mismatch"
        with (patch("os.geteuid", return_value=1000),
              patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="x86_64"),
              patch.object(compose, "run", side_effect=self.daemon_route("linux/arm64")),
              patch("shutil.disk_usage") as disk,
              patch("os.access", return_value=True)):
            disk.return_value.free = 8 * 1024 ** 3
            result, _ = install.run_setup(fresh_args(home))
        assert_prereq(self, result, home, "unsupported_platform")

    def test_daemon_wrong_os_refused(self):
        home = self.root / "wrongos"
        with (patch("os.geteuid", return_value=1000),
              patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="x86_64"),
              patch.object(compose, "run", side_effect=self.daemon_route("windows/amd64")),
              patch("shutil.disk_usage") as disk,
              patch("os.access", return_value=True)):
            disk.return_value.free = 8 * 1024 ** 3
            result, _ = install.run_setup(fresh_args(home))
        assert_prereq(self, result, home, "unsupported_platform")

    def test_explicit_remote_docker_host_refused_without_daemon_access(self):
        home = self.root / "remote"
        env = patch.dict(os.environ, {"DOCKER_HOST": "tcp://192.0.2.1:2375"}, clear=False)
        env.start()
        self.addCleanup(env.stop)

        def route(argv, timeout_s=10, env=None):
            if "version" in " ".join(argv):
                return 0, "v2.24.0\n", ""
            raise AssertionError("daemon must not be contacted")

        with (patch("os.geteuid", return_value=1000),
              patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="x86_64"),
              patch.object(compose, "run", side_effect=route)):
            result, _ = install.run_setup(fresh_args(home))
        assert_prereq(self, result, home, "unsupported_platform")

    def test_rootless_daemon_remains_refused(self):
        home = self.root / "rootless"

        def route(argv, timeout_s=10, env=None):
            text = " ".join(argv)
            if "version" in text:
                return 0, "v2.24.0\n", ""
            if "context" in text:
                return 0, "unix:///var/run/docker.sock\n", ""
            return 0, '["rootless"]\n', ""

        with (patch("os.geteuid", return_value=1000),
              patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="x86_64"),
              patch.object(compose, "run", side_effect=route)):
            result, _ = install.run_setup(fresh_args(home))
        assert_prereq(self, result, home, "unsupported_platform")

    def test_desktop_daemon_remains_refused(self):
        home = self.root / "desktop"

        def route(argv, timeout_s=10, env=None):
            text = " ".join(argv)
            if "version" in text:
                return 0, "v2.24.0\n", ""
            if "context" in text:
                return 0, "unix:///var/run/docker.sock\n", ""
            if "OperatingSystem" in text:
                return 0, "Docker Desktop\n", ""
            return 0, "[]\n", ""

        with (patch("os.geteuid", return_value=1000),
              patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="x86_64"),
              patch.object(compose, "run", side_effect=route)):
            result, _ = install.run_setup(fresh_args(home))
        assert_prereq(self, result, home, "unsupported_platform")

    def test_doctor_accepts_native_arm64(self):
        with (patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="aarch64"),
              patch("os.geteuid", return_value=1000),
              patch.object(compose, "run", side_effect=self.daemon_route("linux/arm64"))):
            check = diagnostics.check_prerequisites()
        self.assertEqual(check["status"], "ok")
        self.assertEqual(check["name"], "prerequisites")

    def test_doctor_refuses_daemon_mismatch(self):
        with (patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="aarch64"),
              patch("os.geteuid", return_value=1000),
              patch.object(compose, "run", side_effect=self.daemon_route("linux/amd64"))):
            check = diagnostics.check_prerequisites()
        self.assertEqual(check["status"], "failed")
        self.assertEqual(check["reason"], "unsupported_platform")

    def test_shared_native_gate_refuses_remote_context_before_daemon_access(self):
        def route(argv, timeout_s=10, env=None):
            if argv[:3] == ["docker", "compose", "version"]:
                return 0, "v2.24.0\n", ""
            if argv[:3] == ["docker", "context", "inspect"]:
                return 0, "tcp://192.0.2.1:2375\n", ""
            self.fail("remote daemon must not be contacted")

        for env in ({}, {"DOCKER_HOST": "unix:///var/run/docker.sock", "DOCKER_CONTEXT": "fixture-remote"}):
            with (self.subTest(env=env), patch.dict(os.environ, env),
                  patch.object(install.platform, "system", return_value="Linux"),
                  patch.object(install.platform, "machine", return_value="x86_64"),
                  patch("os.geteuid", return_value=1000), patch.object(compose, "run", side_effect=route)):
                with self.assertRaises(CommandError) as refused:
                    install.check_native_platform()
                self.assertEqual(refused.exception.code, "unsupported_platform")

    def test_explicit_local_context_overrides_stale_remote_host(self):
        env = {"DOCKER_CONTEXT": "fixture-local", "DOCKER_HOST": "tcp://192.0.2.1:2375"}
        with (patch.dict(os.environ, env), patch.object(install.platform, "system", return_value="Linux"),
              patch.object(install.platform, "machine", return_value="x86_64"),
              patch("os.geteuid", return_value=1000),
              patch.object(compose, "run", side_effect=self.daemon_route("linux/amd64"))):
            self.assertEqual(install.check_native_platform(), "linux/amd64")

    def test_conflicting_default_platform_refused_before_docker_access(self):
        for requested in ("linux/arm64", "windows/amd64", "unknown"):
            with (self.subTest(requested=requested), patch.dict(os.environ, {"DOCKER_DEFAULT_PLATFORM": requested}),
                  patch.object(install.platform, "system", return_value="Linux"),
                  patch.object(install.platform, "machine", return_value="x86_64"),
                  patch("os.geteuid", return_value=1000),
                  patch.object(compose, "run", side_effect=AssertionError("no Docker access"))):
                with self.assertRaises(CommandError) as refused:
                    install.check_native_platform()
                self.assertEqual(refused.exception.code, "unsupported_platform")

    def test_native_default_platform_is_accepted(self):
        for requested in ("linux/arm64", "linux/arm64/v8"):
            with (self.subTest(requested=requested), patch.dict(os.environ, {"DOCKER_DEFAULT_PLATFORM": requested}),
                  patch.object(install.platform, "system", return_value="Linux"),
                  patch.object(install.platform, "machine", return_value="aarch64"),
                  patch("os.geteuid", return_value=1000),
                  patch.object(compose, "run", side_effect=self.daemon_route("linux/arm64"))):
                self.assertEqual(install.check_native_platform(), "linux/arm64")

    def test_shared_native_gate_refuses_matching_rootless_and_desktop_daemons(self):
        for security, operating_system in (('["rootless"]', "Ubuntu"), ("[]", "Docker Desktop")):
            with self.subTest(security=security, operating_system=operating_system):
                def route(argv, timeout_s=10, env=None):
                    text = " ".join(argv)
                    if "SecurityOptions" in text:
                        return 0, security, ""
                    if "OperatingSystem" in text:
                        return 0, operating_system, ""
                    return self.daemon_route("linux/amd64")(argv, timeout_s, env)

                with (patch.object(install.platform, "system", return_value="Linux"),
                      patch.object(install.platform, "machine", return_value="x86_64"),
                      patch("os.geteuid", return_value=1000), patch.object(compose, "run", side_effect=route)):
                    with self.assertRaises(CommandError) as refused:
                        install.check_native_platform()
                    self.assertEqual(diagnostics.check_prerequisites()["reason"], "unsupported_platform")
                self.assertEqual(refused.exception.code, "unsupported_platform")

    def test_image_platform_requires_one_exact_native_descriptor(self):
        for output, expected in (("linux/amd64\n", "linux/amd64"), ("linux/arm64\n", "linux/arm64"),
                                 ("linux/x86_64\n", None), ("linux/amd64\nlinux/arm64\n", None),
                                 ("windows/amd64\n", None), ("", None)):
            with self.subTest(output=output), patch.object(compose, "run", return_value=(0, output, "")):
                self.assertEqual(compose.image_platform("fixture:local"), expected)


class FreshImageTests(TempEnv):
    def fresh_patches(self, home, image_platform):
        def project(_home):
            try:
                return install.read_manifest(home).project
            except (CommandError, OSError, ValueError):
                return None

        return [
            patch.object(compose, "run", side_effect=AssertionError("no external Docker command")),
            patch.object(install, "preflight", return_value=[]),
            patch.object(install, "port_free", return_value=True),
            patch.object(install, "check_persistence", return_value=("verified", "")),
            patch.object(install, "normalize_native_arch", return_value="amd64"),
            patch.object(compose, "detect_project", side_effect=project),
            patch.object(compose, "local_image_present", return_value=True),
            patch.object(compose, "pull_image", return_value=None),
            patch.object(compose, "image_platform", return_value=image_platform),
            patch.object(compose, "ps_entries", return_value=[]),
        ]

    def start_all(self, patches):
        for entered in patches:
            entered.start()
            self.addCleanup(entered.stop)

    def test_wrong_image_platform_refuses_before_start(self):
        home = self.root / "wrong-image"
        self.start_all(self.fresh_patches(home, "linux/arm64"))
        with patch.object(compose, "compose_up",
                          side_effect=AssertionError("incompatible image must not start")) as up:
            result, _ = install.run_setup(fresh_args(home))
        self.assertEqual(result["outcome"], "error")
        self.assertEqual(result["error"]["code"], "image_incompatible")
        self.assertEqual(result["error"]["stage"], "compatibility")
        self.assertFalse(up.called)

    def test_unknown_image_platform_refuses_before_start(self):
        home = self.root / "unknown-image"
        self.start_all(self.fresh_patches(home, None))
        with patch.object(compose, "compose_up",
                          side_effect=AssertionError("incompatible image must not start")) as up:
            result, _ = install.run_setup(fresh_args(home))
        self.assertEqual(result["outcome"], "error")
        self.assertEqual(result["error"]["code"], "image_incompatible")
        self.assertEqual(result["error"]["stage"], "compatibility")
        self.assertFalse(up.called)


if __name__ == "__main__":
    unittest.main()
