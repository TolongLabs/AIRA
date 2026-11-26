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
LIFECYCLE = "plugins/platforms/whatsapp/adapter.py"
STOCK_LIFECYCLE = b"# original synthetic lifecycle\n"
PATCHED_LIFECYCLE = b"# patched synthetic lifecycle\n"
DIRECT_MEDIA = ["text", "document", "receive-image", "receive-audio", "receive-video", "receive-pdf"]
SCHEDULER = DIRECT_MEDIA + ["scheduler"]


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
        self.lifecycle = self.source / LIFECYCLE
        self.lifecycle.parent.mkdir(parents=True)
        self.lifecycle.write_bytes(STOCK_LIFECYCLE)
        self.lifecycle.chmod(0o640)
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
        self.mods["standalone_scheduler_patch"] = SimpleNamespace(
            TARGET=LIFECYCLE,
            classify_source=lambda data: {
                STOCK_LIFECYCLE: "original",
                PATCHED_LIFECYCLE: "patched",
            }.get(data, "unsupported"),
            select_scheduler=lambda _, enabled: PATCHED_LIFECYCLE if enabled else STOCK_LIFECYCLE,
        )
        self.manifest = SimpleNamespace(mode="standalone", stage="installed", corePort=9881, sitePort=9890)
        self.selection = {"home": self.home, "manifest": self.manifest,
                          "bindings": {9881: ("127.0.0.1", 9881), 9890: ("127.0.0.1", 9890)}}
        self.report = {"state": {"service": "running", "installation": "installed"}, "dashboard": {}}
        self.head = OLD_HEAD
        self.dirty = False
        self.running = False
        self.args = SimpleNamespace(home=str(self.home), repo_root=self.repo, profile="default",
                                    hermes_dir=str(self.source), hermes_home=str(self.root))

    def plan(self):
        def process(argv, *_args, **_kwargs):
            if argv[:3] == ["git", "rev-parse", "HEAD"]:
                return SimpleNamespace(returncode=0, stdout=self.head + "\n")
            if argv[:2] == ["git", "diff"]:
                self.assertEqual(argv, ["git", "diff", "--quiet", "HEAD", "--", ".", ":!" + TARGET, ":!" + LIFECYCLE])
                return SimpleNamespace(returncode=int(self.dirty), stdout="")
            self.fail(f"Unexpected host process: {argv[0]}")
        with ExitStack() as stack:
            stack.enter_context(patch.object(hermes.configure, "selected_api", return_value=self.selection))
            stack.enter_context(patch.object(hermes.configure, "readback", return_value={}))
            stack.enter_context(patch.object(hermes.install, "observe", return_value=self.report))
            stack.enter_context(patch.object(hermes, "_modules", return_value=self.mods))
            stack.enter_context(patch.object(hermes, "_process", side_effect=process))
            stack.enter_context(patch.object(hermes, "_profile_status", return_value=self.running))
            return hermes._plan(self.args)

    def prior_attachment(self, version, protocol=1, capabilities=None):
        self.target.write_bytes(b"# typed synthetic consumer\n" if protocol == 2 else b"# patched synthetic consumer\n")
        capabilities = capabilities or ["text"]
        self.lifecycle.write_bytes(PATCHED_LIFECYCLE if protocol == 2 and capabilities == SCHEDULER else STOCK_LIFECYCLE)
        if protocol == 1:
            rendered = hermes_versions.render_helper(self.template, version)
        elif capabilities == SCHEDULER:
            rendered = hermes_versions.render_scheduler_helper(self.template, self.mods["document"],
                                                               self.mods["media"], self.mods["scheduler"], version)
        elif capabilities == DIRECT_MEDIA:
            rendered = hermes_versions.render_media_helper(self.template, self.mods["document"], self.mods["media"], version)
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

    def test_direct_media_selection_is_explicit_and_omission_preserves_verified_selection(self):
        self.args.protocol = "v2"
        text = self.plan()
        self.assertEqual(text["capabilities"], ["text"])
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=["text", "document"])
        self.args.capabilities = ",".join(DIRECT_MEDIA)
        plan = self.plan()
        self.assertEqual(plan["capabilities"], DIRECT_MEDIA)
        self.assertEqual(plan["adapter"].CAPABILITIES, DIRECT_MEDIA)
        self.assertEqual(json.loads(plan["provisional"][0])["capabilities"], DIRECT_MEDIA)
        self.assertIsNone(json.loads(plan["desired"]["host"][0])["routeId"])
        self.assertNotEqual(plan["original"]["helper"], plan["desired"]["helper"])
        self.assertEqual(json.loads(self.marker.read_text())["capabilities"], ["text", "document"])
        self.assertIn("direct inbound media", hermes._detail(plan, False)["verification"])

        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=DIRECT_MEDIA)
        del self.args.capabilities
        self.running = True
        identical = self.plan()
        self.assertEqual(identical["capabilities"], DIRECT_MEDIA)
        self.assertEqual(identical["original"], {**identical["original"], **identical["desired"]})
        self.running = False
        self.args.capabilities = "text"
        text_again = self.plan()
        self.assertEqual(text_again["desired"]["helper"], text["desired"]["helper"])
        self.assertIsNone(json.loads(text_again["desired"]["marker"][0])["routeId"])

        self.args.protocol = "v1"
        del self.args.capabilities
        downgrade = self.plan()
        self.assertEqual(json.loads(downgrade["provisional"][0])["capabilities"], DIRECT_MEDIA)
        self.assertEqual(downgrade["typedAdapter"].CAPABILITIES, DIRECT_MEDIA)
        self.assertEqual(json.loads(downgrade["desired"]["marker"][0])["schemaVersion"], 1)

    def test_media_migration_requires_stopped_exclusive_checkout_and_exact_prior_receipt(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=["text", "document"])
        self.args.protocol = "v2"
        self.args.capabilities = ",".join(DIRECT_MEDIA)
        self.running = True
        self.assert_refused_unchanged("hermes_unsupported")
        self.running = False
        other = self.root / "profiles/other/aira-transport.json"
        other.parent.mkdir(parents=True, mode=0o700)
        install.atomic_write_text(other, "synthetic other profile")
        self.assert_refused_unchanged("hermes_contract_failed")
        other.unlink()
        receipt = json.loads(self.receipt.read_text())
        install.atomic_write_text(self.receipt, json.dumps({**receipt, "capabilities": ["text"]}))
        self.assert_refused_unchanged("hermes_profile_conflict")

    def test_media_attachment_cannot_be_requested_with_v1(self):
        self.args.protocol = "v1"
        self.args.capabilities = ",".join(DIRECT_MEDIA)
        with self.assertRaises(CommandError):
            self.plan()

    def test_media_version_reattach_rotates_route_and_preserves_capabilities_until_apply(self):
        self.args.protocol = "v2"
        for previous, head, desired in (("hermes-v0.23.4", OLD_HEAD, "hermes-v0.23.2"),
                                        ("hermes-v0.23.2", CURRENT_HEAD, "hermes-v0.23.4")):
            with self.subTest(previous=previous, desired=desired):
                self.prior_attachment(previous, protocol=2, capabilities=DIRECT_MEDIA)
                self.head = head
                before = {path: path.read_bytes()
                          for path in (self.target, self.helper, self.marker, self.host, self.receipt)}
                plan = self.plan()
                self.assertEqual(plan["capabilities"], DIRECT_MEDIA)
                self.assertEqual(plan["adapter"].ADAPTER_VERSION, desired)
                self.assertIsNone(json.loads(plan["desired"]["marker"][0])["routeId"])
                self.assertEqual({path: path.read_bytes() for path in before}, before)

    def apply_media_plan(self, plan, post, observed):
        self.args.apply = self.args.yes = self.args.json = self.args.non_interactive = True
        observation = {"side_effect": observed} if callable(observed) else {"return_value": observed}
        with (patch.object(hermes, "_plan", return_value=plan),
              patch.object(hermes, "_profile_status", return_value=False),
              patch.object(hermes, "_gateway_command") as gateway,
              patch.object(plan["adapter"], "_post", side_effect=post),
              patch.object(install, "observe", **observation),
              patch.object(hermes.operations, "log_event", return_value="fixture")):
            result = hermes.run_attach(self.args, "9" * 32)
        gateway.assert_not_called()
        return result

    def test_old_core_refusal_restores_exact_prior_attachment_when_media_is_selected(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=["text", "document"])
        self.args.protocol = "v2"
        self.args.capabilities = ",".join(DIRECT_MEDIA)
        plan = self.plan()
        attempts = []

        def post(_config, path, body, _timeout):
            attempts.append((path, body["capabilities"]))
            raise ValueError("synthetic unsupported capability")

        result = self.apply_media_plan(plan, post, self.report)
        self.assertEqual(attempts, [("/v2/aira/attach-check", DIRECT_MEDIA)])
        self.assertEqual(result["error"]["code"], "attach_failed")
        for name, record in plan["original"].items():
            self.assertEqual(hermes._read(plan["paths"][name]), record, name)

    def test_stopped_media_attachment_publishes_new_route_and_can_reattach_identically(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=["text", "document"])
        self.args.protocol = "v2"
        self.args.capabilities = ",".join(DIRECT_MEDIA)
        plan = self.plan()
        new_id = "87654321-4321-4321-8321-cba987654321"
        route = {**self.report["hermesRoute"], "capabilities": DIRECT_MEDIA, "routeId": new_id}

        def post(_config, path, body, _timeout):
            self.assertEqual(path, "/v2/aira/attach-check")
            self.assertEqual(body["capabilities"], DIRECT_MEDIA)
            self.assertEqual(hermes._read(self.marker), plan["provisional"])
            install.atomic_write_text(self.receipt, json.dumps({"schemaVersion": 2,
                **{k: v for k, v in route.items() if k != "protocolVersion"}}))
            return {"schemaVersion": 2, "hermes": route}

        self.report = {**self.report, "hermesRoute": route}
        result = self.apply_media_plan(plan, post, self.report)
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(json.loads(self.marker.read_text())["routeId"], new_id)
        self.assertEqual(json.loads(self.host.read_text())["routeId"], new_id)
        del self.args.capabilities
        identical = self.plan()
        self.assertEqual(identical["original"], {**identical["original"], **identical["desired"]})

    def test_stopped_reattach_can_reduce_direct_media_to_exact_document_helper(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=DIRECT_MEDIA)
        self.args.protocol = "v2"
        self.args.capabilities = "text,document"
        plan = self.plan()
        route = {**self.report["hermesRoute"], "capabilities": ["text", "document"],
                 "routeId": "87654321-4321-4321-8321-cba987654321"}

        def post(_config, path, body, _timeout):
            self.assertEqual(path, "/v2/aira/attach-check")
            self.assertEqual(body["capabilities"], route["capabilities"])
            self.assertEqual(hermes._read(self.marker), plan["provisional"])
            install.atomic_write_text(self.receipt, json.dumps({"schemaVersion": 2,
                **{k: v for k, v in route.items() if k != "protocolVersion"}}))
            return {"schemaVersion": 2, "hermes": route}

        self.report = {**self.report, "hermesRoute": route}
        result = self.apply_media_plan(plan, post, self.report)
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(json.loads(self.marker.read_text())["routeId"], route["routeId"])
        self.assertEqual(self.helper.read_bytes(),
                         hermes_versions.render_document_helper(self.template, self.mods["document"], "hermes-v0.23.2"))

    def test_scheduler_requires_explicit_selection_and_second_reviewed_patch(self):
        self.args.protocol = "v2"
        text = self.plan()
        self.assertEqual(text["capabilities"], ["text"])
        self.assertEqual(text["desired"]["lifecycle"], text["original"]["lifecycle"])
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=DIRECT_MEDIA)
        self.args.capabilities = ",".join(SCHEDULER)
        plan = self.plan()
        self.assertEqual(plan["capabilities"], SCHEDULER)
        self.assertEqual(plan["adapter"].CAPABILITIES, SCHEDULER)
        self.assertEqual(plan["paths"]["lifecycle"], self.lifecycle)
        self.assertEqual(plan["original"]["lifecycle"], (STOCK_LIFECYCLE, 0o640))
        self.assertEqual(plan["desired"]["lifecycle"], (PATCHED_LIFECYCLE, 0o640))
        self.assertIsNone(json.loads(plan["desired"]["host"][0])["routeId"])
        self.assertEqual(self.lifecycle.read_bytes(), STOCK_LIFECYCLE)
        self.args.protocol = "v1"
        self.assert_refused_unchanged("invalid_args")

    def test_lifecycle_patch_without_matching_helper_is_refused_before_writes(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=DIRECT_MEDIA)
        self.args.protocol = "v2"
        for invalid in (PATCHED_LIFECYCLE, b"# unreviewed lifecycle\n"):
            with self.subTest(invalid=invalid):
                self.lifecycle.write_bytes(invalid)
                self.assert_refused_unchanged("hermes_unsupported")
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=SCHEDULER)
        self.lifecycle.write_bytes(STOCK_LIFECYCLE)
        self.assert_refused_unchanged("hermes_unsupported")

    def test_scheduler_migration_requires_stopped_gateway_and_exclusive_source(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=DIRECT_MEDIA)
        self.args.protocol = "v2"
        self.args.capabilities = ",".join(SCHEDULER)
        self.running = True
        self.assert_refused_unchanged("hermes_unsupported")
        self.running = False
        other = self.root / "profiles/other/aira-transport.json"
        other.parent.mkdir(parents=True, mode=0o700)
        install.atomic_write_text(other, "synthetic other profile")
        self.assert_refused_unchanged("hermes_contract_failed")
        other.unlink()
        receipt = json.loads(self.receipt.read_text())
        install.atomic_write_text(self.receipt, json.dumps({**receipt, "capabilities": ["text"]}))
        self.assert_refused_unchanged("hermes_profile_conflict")

    def successful_scheduler_handshake(self, plan, capabilities, lifecycle):
        route = {**self.report["hermesRoute"], "capabilities": capabilities,
                 "routeId": "87654321-4321-4321-8321-cba987654321"}

        def post(_config, path, body, _timeout):
            self.assertEqual(path, "/v2/aira/attach-check")
            self.assertEqual(body["capabilities"], capabilities)
            self.assertEqual(hermes._read(self.marker), plan["provisional"])
            self.assertEqual(hermes._read(self.lifecycle), (lifecycle, 0o640))
            install.atomic_write_text(self.receipt, json.dumps({"schemaVersion": 2,
                **{k: v for k, v in route.items() if k != "protocolVersion"}}))
            return {"schemaVersion": 2, "hermes": route}
        self.report = {**self.report, "hermesRoute": route}
        return post, route

    def test_stopped_scheduler_apply_backs_up_both_sources_and_publishes_rotated_route(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=DIRECT_MEDIA)
        self.args.protocol = "v2"
        self.args.capabilities = ",".join(SCHEDULER)
        plan = self.plan()
        post, route = self.successful_scheduler_handshake(plan, SCHEDULER, PATCHED_LIFECYCLE)
        result = self.apply_media_plan(plan, post, self.report)
        self.assertEqual(result["outcome"], "ok")
        self.assertIn("self-reminder", result["attach"]["verification"])
        self.assertIn("lifecycle", result["attach"]["changes"])
        self.assertEqual(json.loads(self.marker.read_text())["routeId"], route["routeId"])
        self.assertEqual(json.loads(self.host.read_text())["routeId"], route["routeId"])
        backup = self.home / "data/standalone/attach-backups" / ("9" * 32)
        self.assertEqual(hermes._read(backup / "lifecycle.orig"), (STOCK_LIFECYCLE, 0o600))
        self.assertEqual(hermes._read(backup / "source.orig"), (plan["original"]["source"][0], 0o600))
        self.assertEqual(json.loads((backup / "manifest.json").read_text())["files"]["lifecycle"],
                         {"present": True, "mode": 0o640})
        del self.args.capabilities
        self.running = True
        identical = self.plan()
        self.assertEqual(identical["capabilities"], SCHEDULER)
        self.assertEqual(identical["original"], {**identical["original"], **identical["desired"]})

    def test_stopped_scheduler_downgrade_removes_only_exact_lifecycle_patch(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=SCHEDULER)
        self.args.protocol = "v1"
        v1 = self.plan()
        self.assertEqual(v1["desired"]["lifecycle"], (STOCK_LIFECYCLE, 0o640))
        self.assertEqual(v1["typedAdapter"].CAPABILITIES, SCHEDULER)
        self.args.protocol = "v2"
        self.args.capabilities = ",".join(DIRECT_MEDIA)
        plan = self.plan()
        post, route = self.successful_scheduler_handshake(plan, DIRECT_MEDIA, STOCK_LIFECYCLE)
        result = self.apply_media_plan(plan, post, self.report)
        self.assertEqual(result["outcome"], "ok")
        self.assertEqual(json.loads(self.marker.read_text())["routeId"], route["routeId"])
        self.assertEqual(self.helper.read_bytes(),
                         hermes_versions.render_media_helper(self.template, self.mods["document"],
                                                             self.mods["media"], "hermes-v0.23.2"))
        self.assertEqual(hermes._read(self.lifecycle), (STOCK_LIFECYCLE, 0o640))

    def test_scheduler_source_revision_change_preserves_exact_lifecycle_and_requires_new_route(self):
        self.args.protocol = "v2"
        for previous, head, desired in (("hermes-v0.23.4", OLD_HEAD, "hermes-v0.23.2"),
                                        ("hermes-v0.23.2", CURRENT_HEAD, "hermes-v0.23.4")):
            with self.subTest(previous=previous, desired=desired):
                self.prior_attachment(previous, protocol=2, capabilities=SCHEDULER)
                self.head = head
                plan = self.plan()
                self.assertEqual(plan["capabilities"], SCHEDULER)
                self.assertEqual(plan["adapter"].ADAPTER_VERSION, desired)
                self.assertEqual(plan["desired"]["lifecycle"], plan["original"]["lifecycle"])
                self.assertIsNone(json.loads(plan["desired"]["marker"][0])["routeId"])

    def test_old_core_scheduler_refusal_restores_exact_lifecycle_and_receipt(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=DIRECT_MEDIA)
        self.args.protocol = "v2"
        self.args.capabilities = ",".join(SCHEDULER)
        plan = self.plan()
        attempts = []

        def post(_config, path, body, _timeout):
            attempts.append((path, body["capabilities"], hermes._read(self.lifecycle), hermes._read(self.marker)))
            raise ValueError("synthetic old core refusal")

        result = self.apply_media_plan(plan, post, self.report)
        self.assertEqual(attempts, [("/v2/aira/attach-check", SCHEDULER,
                                     plan["desired"]["lifecycle"], plan["provisional"])])
        self.assertEqual(result["error"]["code"], "attach_failed")
        for name, record in plan["original"].items():
            self.assertEqual(hermes._read(plan["paths"][name]), record, name)

    def test_lost_scheduler_handshake_restores_prior_receipt_after_core_rotation(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=DIRECT_MEDIA)
        self.args.protocol = "v2"
        self.args.capabilities = ",".join(SCHEDULER)
        plan = self.plan()
        accept, _route = self.successful_scheduler_handshake(plan, SCHEDULER, PATCHED_LIFECYCLE)
        persisted = []

        def lost(*args):
            accept(*args)
            persisted.append(hermes._read(self.receipt))
            raise ConnectionError("synthetic lost response")

        result = self.apply_media_plan(plan, lost, self.report)
        self.assertEqual(len(persisted), 1)
        self.assertNotEqual(persisted[0], plan["original"]["receipt"])
        self.assertEqual(result["error"]["code"], "attach_failed")
        for name, record in plan["original"].items():
            self.assertEqual(hermes._read(plan["paths"][name]), record, name)

    def test_scheduler_lifecycle_write_failure_restores_exact_prior_files(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=DIRECT_MEDIA)
        self.args.protocol = "v2"
        self.args.capabilities = ",".join(SCHEDULER)
        plan = self.plan()
        write = hermes._write
        attempts = []

        def fail_after_lifecycle_write(path, record):
            write(path, record)
            if path == self.lifecycle and record == plan["desired"]["lifecycle"]:
                raise OSError("synthetic lifecycle write interruption")

        with patch.object(hermes, "_write", side_effect=fail_after_lifecycle_write):
            result = self.apply_media_plan(plan, lambda *_: attempts.append(True), self.report)
        self.assertEqual(attempts, [])
        self.assertEqual(result["error"]["code"], "attach_failed")
        for name, record in plan["original"].items():
            self.assertEqual(hermes._read(plan["paths"][name]), record, name)

    def test_final_scheduler_readback_refuses_foreign_lifecycle_and_keeps_inert_marker(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=DIRECT_MEDIA)
        self.args.protocol = "v2"
        self.args.capabilities = ",".join(SCHEDULER)
        plan = self.plan()
        post, _route = self.successful_scheduler_handshake(plan, SCHEDULER, PATCHED_LIFECYCLE)
        foreign = b"# foreign synthetic edit\n"

        def observe(*_):
            self.lifecycle.write_bytes(foreign)
            return self.report

        result = self.apply_media_plan(plan, post, observe)
        self.assertEqual(result["error"]["code"], "rollback_failed")
        self.assertEqual(self.lifecycle.read_bytes(), foreign)
        self.assertEqual(hermes._read(self.marker), plan["provisional"])

    def test_lifecycle_change_between_plans_refuses_before_backup_or_attachment_writes(self):
        self.prior_attachment("hermes-v0.23.2", protocol=2, capabilities=DIRECT_MEDIA)
        self.args.protocol = "v2"
        self.args.capabilities = ",".join(SCHEDULER)
        self.args.apply = self.args.yes = self.args.json = self.args.non_interactive = True
        plan = self.plan()
        self.lifecycle.chmod(0o600)
        fresh = self.plan()
        with (patch.object(hermes, "_plan", side_effect=[plan, fresh]),
              patch.object(hermes.operations, "log_event", return_value="fixture")):
            result = hermes.run_attach(self.args, "9" * 32)
        self.assertEqual(result["error"]["code"], "hermes_contract_failed")
        self.assertFalse((self.home / "data/standalone/attach-backups").exists())
        for name, record in fresh["original"].items():
            self.assertEqual(hermes._read(fresh["paths"][name]), record, name)

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
        paths = (self.target, self.lifecycle, self.helper, self.marker, self.host, self.receipt)
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
        self.lifecycle = custom / LIFECYCLE
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
