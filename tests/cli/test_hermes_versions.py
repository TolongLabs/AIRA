"""Exact public Hermes version and reviewed helper compatibility contract."""

import hashlib
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.cli import hermes, hermes_versions, launcher, main
from deploy.cli.result import CommandError


DIRECT_MEDIA = ["text", "document", "receive-image", "receive-audio", "receive-video", "receive-pdf"]
SCHEDULER = DIRECT_MEDIA + ["scheduler"]


class HermesVersionsTests(unittest.TestCase):
    def test_registry_contains_only_the_reviewed_exact_revisions(self):
        expected = {
            "ae2a81ccc00e9b7c06301523e5bb09608397149c": "hermes-v0.23.2",
            "caafe5389ae585ef77387a962aee05b1bcf17029": "hermes-v0.23.3",
            "8fc0374447313e276f6b9a2764bfc750190c966a": "hermes-v0.23.4",
        }
        self.assertEqual(set(hermes_versions.ADAPTER_VERSIONS), set(expected.values()))
        for head, version in expected.items():
            with self.subTest(head=head):
                self.assertEqual(hermes_versions.version_for_head(head), version)
                self.assertIsNone(hermes_versions.version_for_head(head[:12]))
        self.assertIsNone(hermes_versions.version_for_head("0" * 40))
        self.assertIsNone(hermes_versions.version_for_head("v0.23.4"))

    def test_rendered_helpers_are_exact_and_the_existing_helper_is_unchanged(self):
        root = Path(__file__).resolve().parents[2]
        template = (root / "deploy/gateway/standalone_adapter.py").read_bytes()
        baseline = b'ADAPTER_VERSION = "hermes-v0.23.4"'
        self.assertEqual(template.count(baseline), 1)
        for version in ("hermes-v0.23.2", "hermes-v0.23.3", "hermes-v0.23.4"):
            with self.subTest(version=version):
                expected = template.replace(baseline, f'ADAPTER_VERSION = "{version}"'.encode())
                rendered = hermes_versions.render_helper(template, version)
                self.assertEqual(rendered, expected)
                self.assertEqual(hermes_versions.known_helper_version(template, rendered), version)
                module = {"__name__": "synthetic_adapter"}
                exec(compile(rendered, "<synthetic-adapter>", "exec"), module)
                self.assertEqual(module["ADAPTER_VERSION"], version)
        self.assertEqual(hermes_versions.render_helper(template, "hermes-v0.23.4"), template)
        self.assertIsNone(hermes_versions.known_helper_version(template, template + b"\n# unfamiliar\n"))
        with self.assertRaises(ValueError):
            hermes_versions.render_helper(template, "hermes-v0.23.5")
        with self.assertRaises(ValueError):
            hermes_versions.render_helper(b"unknown template", "hermes-v0.23.4")
        with self.assertRaises(ValueError):
            hermes_versions.render_helper(template + b"\n# unfamiliar modification\n", "hermes-v0.23.4")

    def test_media_capabilities_are_one_finite_ordered_selection(self):
        for accepted in (["text"], ["text", "document"], DIRECT_MEDIA, SCHEDULER):
            self.assertTrue(hermes_versions.valid_capabilities(accepted))
            args = main.build_parser().parse_args(["attach-hermes", "--profile", "fixture", "--dry-run",
                                                  "--protocol", "v2", "--capabilities", ",".join(accepted)])
            self.assertEqual(args.capabilities, ",".join(accepted))
        for refused in (DIRECT_MEDIA[0:-1], list(reversed(DIRECT_MEDIA)), DIRECT_MEDIA + ["receive-image"],
                        ["text", "scheduler"], SCHEDULER + ["scheduler"], ["scheduler"] + DIRECT_MEDIA):
            self.assertFalse(hermes_versions.valid_capabilities(refused))
            with self.assertRaises(CommandError):
                main.build_parser().parse_args(["attach-hermes", "--profile", "fixture", "--dry-run",
                                                "--protocol", "v2", "--capabilities", ",".join(refused)])

    def test_direct_media_renderer_appends_only_a_pinned_extension(self):
        gateway = Path(__file__).resolve().parents[2] / "deploy/gateway"
        template = (gateway / "standalone_adapter.py").read_bytes()
        typed = (gateway / "standalone_typed_adapter.py").read_bytes()
        document = (gateway / "standalone_document_adapter.py").read_bytes()
        # A synthetic extension isolates renderer and digest checks from native admission.
        media = f"CAPABILITIES = {DIRECT_MEDIA!r}\n".encode()
        entrypoint = b'if __name__ == "__main__":\n    sys.exit(main())\n'
        with patch.object(hermes_versions, "_MEDIA_SHA256", hashlib.sha256(media).hexdigest()):
            for version in hermes_versions.ADAPTER_VERSIONS:
                with self.subTest(version=version):
                    old_document = hermes_versions.render_document_helper(template, document, version)
                    expected = old_document[:-len(entrypoint)] + media.rstrip(b"\n") + b"\n\n" + entrypoint
                    rendered = hermes_versions.render_media_helper(template, document, media, version)
                    self.assertEqual(rendered, expected)
                    for helper, key in (
                        (hermes_versions.render_helper(template, version), (version, 1, ())),
                        (hermes_versions.render_typed_helper(template, typed, version), (version, 2, ("text",))),
                        (old_document, (version, 2, ("text", "document"))),
                        (rendered, (version, 2, tuple(DIRECT_MEDIA))),
                    ):
                        self.assertEqual(hermes_versions.known_helper(template, typed, document, media, helper), key)
                    self.assertIsNone(hermes_versions.known_helper(template, typed, document, media, rendered + b"\n"))
                    with self.assertRaises(ValueError):
                        hermes_versions.render_media_helper(template, document, media + b"\n", version)

    def test_scheduler_renderer_appends_only_a_pinned_extension(self):
        gateway = Path(__file__).resolve().parents[2] / "deploy/gateway"
        template = (gateway / "standalone_adapter.py").read_bytes()
        typed = (gateway / "standalone_typed_adapter.py").read_bytes()
        document = (gateway / "standalone_document_adapter.py").read_bytes()
        media = (gateway / "standalone_media_adapter.py").read_bytes()
        scheduler = f"CAPABILITIES = {SCHEDULER!r}\n".encode()
        entrypoint = b'if __name__ == "__main__":\n    sys.exit(main())\n'
        with patch.object(hermes_versions, "_SCHEDULER_SHA256", hashlib.sha256(scheduler).hexdigest()):
            for version in hermes_versions.ADAPTER_VERSIONS:
                with self.subTest(version=version):
                    old_media = hermes_versions.render_media_helper(template, document, media, version)
                    expected = old_media[:-len(entrypoint)] + scheduler.rstrip(b"\n") + b"\n\n" + entrypoint
                    rendered = hermes_versions.render_scheduler_helper(template, document, media, scheduler, version)
                    self.assertEqual(rendered, expected)
                    for helper, key in (
                        (hermes_versions.render_helper(template, version), (version, 1, ())),
                        (hermes_versions.render_typed_helper(template, typed, version), (version, 2, ("text",))),
                        (hermes_versions.render_document_helper(template, document, version),
                         (version, 2, ("text", "document"))),
                        (old_media, (version, 2, tuple(DIRECT_MEDIA))),
                        (rendered, (version, 2, tuple(SCHEDULER))),
                    ):
                        self.assertEqual(hermes_versions.known_helper(template, typed, document, media, helper,
                                                                    scheduler=scheduler), key)
                    self.assertIsNone(hermes_versions.known_helper(template, typed, document, media, rendered + b"\n",
                                                                  scheduler=scheduler))
                    with self.assertRaises(ValueError):
                        hermes_versions.render_scheduler_helper(template, document, media, scheduler + b"\n", version)

    def test_installed_runtime_contains_the_exact_media_and_scheduler_extensions(self):
        root = Path(__file__).resolve().parents[2]
        gateway = root / "deploy/gateway"
        expected = (gateway / "standalone_media_adapter.py").read_bytes()
        scheduler = (gateway / "standalone_scheduler_adapter.py").read_bytes()
        lifecycle_patch = (gateway / "standalone_scheduler_patch.py").read_bytes()
        with tempfile.TemporaryDirectory() as temp, patch.object(Path, "home", return_value=Path(temp)):
            runtime, _launcher, _warnings = launcher.install_runtime(str(root))
            with patch.object(hermes, "__file__", str(runtime / "cli/hermes.py")):
                modules = hermes._modules(None)
            self.assertEqual(modules["media"], expected)
            self.assertEqual(modules["scheduler"], scheduler)
            self.assertEqual((runtime / "standalone_scheduler_patch.py").read_bytes(), lifecycle_patch)
            self.assertEqual(modules["standalone_scheduler_patch"].TARGET, "plugins/platforms/whatsapp/adapter.py")
