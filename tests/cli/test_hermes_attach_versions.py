"""Standalone attach planning at the exact-version and owned profile seam."""

import json
import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from deploy.cli import hermes, hermes_versions, install
from deploy.cli.result import CommandError


OLD_HEAD = "ae2a81ccc00e9b7c06301523e5bb09608397149c"
CURRENT_HEAD = "8fc0374447313e276f6b9a2764bfc750190c966a"
TARGET = "gateway/run_inbound_consumer.py"


class AttachVersionPlanningTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.addCleanup(self.tmp.cleanup)
        root = Path(self.tmp.name)
        self.home, self.root = root / "install", root / "hermes"
        self.home.mkdir(mode=0o700)
        self.root.mkdir(mode=0o700)
        self.source = self.root / "hermes-agent"
        self.source.mkdir(mode=0o700)
        self.target = self.source / TARGET
        self.target.parent.mkdir()
        self.target.write_bytes(b"# original synthetic consumer\n")
        self.helper = self.target.with_name("aira_transport.py")
        self.marker = self.root / "aira-transport.json"
        standalone = self.home / "data/standalone"
        standalone.mkdir(parents=True, mode=0o700)
        install.atomic_write_text(standalone / "gateway.token", "a" * 64 + "\n")
        self.host = standalone / "attach-host.json"
        self.receipt = standalone / "hermes.json"
        for name in ("python", "hermes"):
            executable = self.source / ".venv/bin" / name
            executable.parent.mkdir(parents=True, exist_ok=True)
            executable.touch(mode=0o700)
        self.repo = Path(__file__).resolve().parents[2]
        self.mods = hermes._modules(self.repo)
        self.template = self.mods["helper"]
        self.mods["standalone_patch"] = SimpleNamespace(
            TARGET=TARGET,
            classify_source=lambda data: {
                b"# original synthetic consumer\n": "original",
                b"# patched synthetic consumer\n": "patched",
                b"# typed synthetic consumer\n": "typed",
            }.get(data, "unsupported"),
            patch_source=lambda _: b"# patched synthetic consumer\n",
            select_protocol=lambda _, protocol: b"# typed synthetic consumer\n" if protocol == 2 else b"# patched synthetic consumer\n",
        )
        self.manifest = SimpleNamespace(mode="standalone", stage="installed", corePort=9881, sitePort=9890)
        self.selection = {"home": self.home, "manifest": self.manifest,
                          "bindings": {9881: ("127.0.0.1", 9881), 9890: ("127.0.0.1", 9890)}}
        self.report = {"state": {"service": "running", "installation": "installed"}, "dashboard": {}}
        self.head = OLD_HEAD
        self.dirty = False
        self.args = SimpleNamespace(home=str(self.home), repo_root=self.repo, profile="default",
                                    hermes_dir=str(self.source), hermes_home=str(self.root))

    def plan(self):
        def process(argv, *_args, **_kwargs):
            if argv[:3] == ["git", "rev-parse", "HEAD"]:
                return SimpleNamespace(returncode=0, stdout=self.head + "\n")
            if argv[:2] == ["git", "diff"]:
                return SimpleNamespace(returncode=int(self.dirty), stdout="")
            self.fail(f"Unexpected host process: {argv[0]}")
        with ExitStack() as stack:
            stack.enter_context(patch.object(hermes.configure, "selected_api", return_value=self.selection))
            stack.enter_context(patch.object(hermes.configure, "readback", return_value={}))
            stack.enter_context(patch.object(hermes.install, "observe", return_value=self.report))
            stack.enter_context(patch.object(hermes, "_modules", return_value=self.mods))
            stack.enter_context(patch.object(hermes, "_process", side_effect=process))
            stack.enter_context(patch.object(hermes, "_profile_status", return_value=False))
            return hermes._plan(self.args)

    def prior_attachment(self, version, protocol=1, capabilities=None):
        self.target.write_bytes(b"# typed synthetic consumer\n" if protocol == 2 else b"# patched synthetic consumer\n")
        capabilities = capabilities or ["text"]
        if protocol == 1:
            rendered = hermes_versions.render_helper(self.template, version)
        elif capabilities == ["text", "document"]:
            rendered = hermes_versions.render_document_helper(self.template, self.mods["document"], version)
        else:
            rendered = hermes_versions.render_typed_helper(self.template, self.mods["typed"], version)
        self.helper.write_bytes(rendered)
        marker = {
            "schemaVersion": 1, "profile": "default", "profileHome": str(self.root),
            "port": 9881, "token": "a" * 64,
        }
        host = {
            "schemaVersion": 1, "sourceDir": str(self.source), "hermesHome": str(self.root),
            "profile": "default", "adapterVersion": version,
        }
        route = {"state": "connected", "profile": "default", "adapterVersion": version,
                 "verifiedAt": "2026-11-26T00:00:00Z"}
        if protocol == 2:
            fields = {"routeId": "12345678-1234-4234-8234-123456789abc", "capabilities": capabilities}
            marker.update(schemaVersion=2, state="active", **fields)
            host.update(schemaVersion=2, **fields)
            route.update(protocolVersion=2, **fields)
        install.atomic_write_text(self.marker, json.dumps(marker))
        install.atomic_write_text(self.host, json.dumps(host))
        install.atomic_write_text(self.receipt, json.dumps({"schemaVersion": protocol, **{k: v for k, v in route.items() if k != "protocolVersion"}}))
        self.report["hermesRoute"] = route

    def test_explicit_protocol_migration_plans_without_mutation(self):
        self.prior_attachment("hermes-v0.23.2")
        self.args.protocol = "v2"
        plan = self.plan()
        self.assertEqual(plan["protocol"], 2)
        self.assertEqual(json.loads(plan["provisional"][0])["state"], "provisional")
        self.assertTrue(plan["typedTransaction"])
        self.assertEqual(json.loads(plan["desired"]["host"][0])["routeId"], None)
        self.assertEqual(json.loads(self.marker.read_text())["schemaVersion"], 1)
        self.prior_attachment("hermes-v0.23.2", protocol=2)
        plan = self.plan()
        self.assertEqual(plan["original"], {**plan["original"], **plan["desired"]})
        self.args.protocol = "v1"
        plan = self.plan()
        self.assertTrue(plan["typedTransaction"])
        self.assertEqual(json.loads(plan["desired"]["marker"][0])["schemaVersion"], 1)
        self.assertEqual(json.loads(self.marker.read_text())["schemaVersion"], 2)

    def test_document_capability_requires_explicit_selection_and_preserves_existing_route(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2)
        self.args.protocol = "v2"
        text_plan = self.plan()
        self.assertEqual(text_plan["capabilities"], ["text"])
        self.args.capabilities = "text,document"
        plan = self.plan()
        self.assertEqual(plan["capabilities"], ["text", "document"])
        self.assertEqual(json.loads(plan["provisional"][0])["capabilities"], ["text", "document"])
        self.assertIsNone(json.loads(plan["desired"]["host"][0])["routeId"])
        self.assertNotEqual(plan["desired"]["helper"], text_plan["desired"]["helper"])
        self.assertEqual(json.loads(self.marker.read_text())["capabilities"], ["text"])

        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=["text", "document"])
        del self.args.capabilities
        identical = self.plan()
        self.assertEqual(identical["capabilities"], ["text", "document"])
        self.assertEqual(identical["original"], {**identical["original"], **identical["desired"]})
        self.args.capabilities = "text"
        text_again = self.plan()
        self.assertEqual(text_again["desired"]["helper"], text_plan["desired"]["helper"])
        self.assertIsNone(json.loads(text_again["desired"]["marker"][0])["routeId"])
        self.args.protocol = "v1"
        del self.args.capabilities
        downgrade = self.plan()
        self.assertEqual(json.loads(downgrade["provisional"][0])["capabilities"], ["text", "document"])
        self.assertEqual(json.loads(downgrade["desired"]["marker"][0])["schemaVersion"], 1)

    def test_document_helper_cannot_bypass_prior_receipt_or_v1_option_validation(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=["text", "document"])
        self.args.protocol = "v2"
        self.report["hermesRoute"]["capabilities"] = ["text"]
        self.assert_refused_unchanged("hermes_profile_conflict")
        self.args.protocol = "v1"
        self.args.capabilities = "text,document"
        with self.assertRaises(CommandError):
            self.plan()

    def test_typed_history_requires_explicit_protocol_and_complete_route(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2)
        self.assert_refused_unchanged("hermes_profile_conflict")
        self.args.protocol = "v2"
        marker = json.loads(self.marker.read_text())
        install.atomic_write_text(self.marker, json.dumps({**marker, "routeId": "87654321-4321-4321-8321-cba987654321"}))
        self.assert_refused_unchanged("hermes_profile_conflict")
        self.prior_attachment("hermes-v0.23.2", protocol=2)
        self.host.unlink()
        self.assert_refused_unchanged("hermes_profile_conflict")

    def test_fresh_verified_revision_uses_its_exact_rendered_helper(self):
        plan = self.plan()
        expected = hermes_versions.render_helper(self.template, "hermes-v0.23.2")
        self.assertEqual(plan["adapter"].ADAPTER_VERSION, "hermes-v0.23.2")
        self.assertEqual(plan["desired"]["helper"][0], expected)
        self.assertEqual(json.loads(plan["desired"]["host"][0])["adapterVersion"], "hermes-v0.23.2")
        self.assertFalse(self.helper.exists())
        self.assertFalse(self.marker.exists())
        self.assertFalse(self.host.exists())
        self.assertEqual(self.target.read_bytes(), b"# original synthetic consumer\n")

    def test_unknown_revision_is_refused_before_writes(self):
        self.head = "0" * 40
        with self.assertRaises(CommandError) as error:
            self.plan()
        self.assertEqual(error.exception.code, "hermes_unsupported")
        self.assertFalse(self.helper.exists())
        self.assertFalse(self.marker.exists())

    def test_dirty_source_is_refused_before_writes(self):
        self.dirty = True
        with self.assertRaises(CommandError) as error:
            self.plan()
        self.assertEqual(error.exception.code, "hermes_unsupported")
        self.assertFalse(self.helper.exists())

    def test_explicit_version_transition_preserves_prior_files_during_planning(self):
        for previous, head, desired in (("hermes-v0.23.4", OLD_HEAD, "hermes-v0.23.2"),
                                        ("hermes-v0.23.2", CURRENT_HEAD, "hermes-v0.23.4")):
            with self.subTest(previous=previous, desired=desired):
                self.prior_attachment(previous)
                self.head = head
                before = {path: path.read_bytes()
                          for path in (self.target, self.helper, self.marker, self.host, self.receipt)}
                plan = self.plan()
                self.assertEqual(plan["adapter"].ADAPTER_VERSION, desired)
                self.assertEqual(plan["desired"]["helper"][0], hermes_versions.render_helper(self.template, desired))
                self.assertEqual(json.loads(plan["desired"]["host"][0])["adapterVersion"], desired)
                self.assertEqual(plan["desired"]["marker"], plan["original"]["marker"])
                self.assertEqual({path: path.read_bytes() for path in before}, before)
                seen = []
                def handshake(_config, _path, payload, _timeout):
                    seen.append(payload["adapterVersion"])
                    return {"schemaVersion": 1, "hermes": {"state": "connected", "profile": "default",
                            "adapterVersion": desired, "verifiedAt": "2026-11-26T00:00:00Z"}}
                with patch.object(plan["adapter"], "_post", side_effect=handshake):
                    self.assertTrue(plan["adapter"].check(self.marker, "connect"))
                self.assertEqual(seen, [desired])

    def assert_refused_unchanged(self, code):
        paths = (self.target, self.helper, self.marker, self.host, self.receipt)
        before = {p: p.read_bytes() if p.exists() else None for p in paths}
        with self.assertRaises(CommandError) as error:
            self.plan()
        self.assertEqual(error.exception.code, code)
        self.assertEqual({p: p.read_bytes() if p.exists() else None for p in paths}, before)

    def test_partial_prior_attachment_is_not_migrated(self):
        for missing in (self.marker, self.host, self.receipt):
            with self.subTest(missing=missing.name):
                self.prior_attachment("hermes-v0.23.4")
                missing.unlink()
                self.assert_refused_unchanged("hermes_profile_conflict")

    def test_surviving_old_route_cannot_bypass_incomplete_migration(self):
        self.prior_attachment("hermes-v0.23.4")
        self.helper.unlink()
        self.host.unlink()
        self.assert_refused_unchanged("hermes_profile_conflict")
        self.prior_attachment("hermes-v0.23.4")
        self.helper.write_bytes(hermes_versions.render_helper(self.template, "hermes-v0.23.2"))
        self.host.unlink()
        self.assert_refused_unchanged("hermes_profile_conflict")

    def test_mismatched_prior_versions_are_not_migrated(self):
        self.prior_attachment("hermes-v0.23.4")
        self.report["hermesRoute"]["adapterVersion"] = "hermes-v0.23.3"
        self.assert_refused_unchanged("hermes_profile_conflict")
        self.prior_attachment("hermes-v0.23.4")
        previous_host = json.loads(self.host.read_text())
        install.atomic_write_text(self.host, json.dumps({**previous_host, "adapterVersion": "hermes-v0.23.3"}))
        self.assert_refused_unchanged("hermes_profile_conflict")

    def test_other_profile_marker_prevents_shared_helper_migration(self):
        self.prior_attachment("hermes-v0.23.4")
        other = self.root / "profiles/other/aira-transport.json"
        other.parent.mkdir(parents=True, mode=0o700)
        install.atomic_write_text(other, "synthetic other profile")
        self.assert_refused_unchanged("hermes_contract_failed")
        self.assertEqual(other.read_text(), "synthetic other profile")

    def test_custom_source_can_attach_fresh_but_is_not_implicitly_migrated(self):
        custom = self.root / "custom-source"
        self.source.rename(custom)
        self.source = custom
        self.target = custom / TARGET
        self.helper = self.target.with_name("aira_transport.py")
        self.args.hermes_dir = str(custom)
        self.assertEqual(self.plan()["adapter"].ADAPTER_VERSION, "hermes-v0.23.2")
        self.prior_attachment("hermes-v0.23.4")
        self.assert_refused_unchanged("hermes_contract_failed")

    def test_existing_baseline_helper_is_reused_without_rewrite(self):
        self.head = CURRENT_HEAD
        self.prior_attachment("hermes-v0.23.4")
        plan = self.plan()
        self.assertEqual(plan["desired"]["helper"], plan["original"]["helper"])
        self.assertEqual(plan["desired"]["host"], plan["original"]["host"])
        self.assertEqual(plan["desired"]["marker"], plan["original"]["marker"])

    def test_unfamiliar_helper_is_never_rewritten(self):
        self.prior_attachment("hermes-v0.23.4")
        self.helper.write_bytes(self.helper.read_bytes() + b"\n# unfamiliar\n")
        self.assert_refused_unchanged("hermes_unsupported")
