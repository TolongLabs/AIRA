"""Exact public Hermes version and reviewed helper compatibility contract."""

import unittest
from pathlib import Path

from deploy.cli import hermes_versions


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
