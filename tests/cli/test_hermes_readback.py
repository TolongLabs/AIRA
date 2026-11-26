"""Status and doctor must describe the exact authenticated route version."""

import tempfile
import unittest
from contextlib import ExitStack
from pathlib import Path
from unittest.mock import patch

from deploy.cli import compose, diagnostics, hermes, install


class RouteReadbackTests(unittest.TestCase):
    def observe(self, version, **extra):
        with tempfile.TemporaryDirectory() as tmp:
            home = Path(tmp)
            manifest = install.Manifest(project="fixture", imageId="sha256:" + "a" * 64,
                                        sitePort=9890, corePort=9881, stage="installed")
            route = {"state": "connected", "profile": "fixture", "adapterVersion": version,
                     "verifiedAt": "2026-11-26T00:00:00Z", **extra}
            health = {"status": "ready", "schemaVersion": 1, "installationMode": "standalone",
                      "configuration": "configured", "chatbot": "ready", "hermes": route}
            with ExitStack() as stack:
                for target, name, value in (
                    (install, "detect_hermes", ("detected", "")),
                    (install, "looks_like_install", True),
                    (install, "_project", "fixture"),
                    (install, "read_owner_token", "a" * 64),
                    (install, "check_persistence", ("verified", "")),
                    (compose, "ps_entries", [{"State": "running"}]),
                    (compose, "published_bindings", {9881: ("127.0.0.1", 9881), 9890: ("127.0.0.1", 9890)}),
                    (compose, "container_image_id", manifest.imageId),
                    (compose, "http_get_json", (200, health, "ok")),
                    (compose, "probe_owner_standalone", (True, health)),
                ):
                    stack.enter_context(patch.object(target, name, return_value=value))
                return install.observe(home, manifest)

    def test_status_reads_each_reviewed_route_version(self):
        for version in ("hermes-v0.23.2", "hermes-v0.23.3", "hermes-v0.23.4"):
            with self.subTest(version=version):
                result = self.observe(version)
                self.assertEqual(result["state"]["hermes"], "connected")
                self.assertEqual(result["hermesRoute"]["adapterVersion"], version)

    def test_status_refuses_unknown_connected_route_and_chatbot_claim(self):
        result = self.observe("hermes-v0.23.5")
        self.assertEqual(result["state"]["hermes"], "unsupported")
        self.assertEqual(result["state"]["chatbot"], "inactive")
        self.assertIsNone(result["hermesRoute"])

    def test_status_preserves_typed_route_and_refuses_partial_or_unknown_capabilities(self):
        fields = {"protocolVersion": 2, "routeId": "12345678-1234-4234-8234-123456789abc", "capabilities": ["text"]}
        result = self.observe("hermes-v0.23.4", **fields)
        self.assertEqual(result["state"]["hermes"], "connected")
        self.assertEqual({key: result["hermesRoute"][key] for key in fields}, fields)
        for broken in ({"protocolVersion": 3}, {"routeId": "invalid"}, {"capabilities": ["text", "document"]}):
            result = self.observe("hermes-v0.23.4", **{**fields, **broken})
            self.assertEqual(result["state"]["chatbot"], "inactive")
            self.assertIsNone(result["hermesRoute"])

    def test_doctor_checks_installed_source_for_each_reviewed_version(self):
        selection = {"mode": "standalone"}
        for version in ("hermes-v0.23.2", "hermes-v0.23.3", "hermes-v0.23.4"):
            with self.subTest(version=version):
                route = {"state": "connected", "profile": "fixture", "adapterVersion": version}
                with (patch.object(diagnostics.configure, "api_call", return_value={"hermes": route}),
                      patch.object(hermes, "inspect_attachment", return_value=True) as inspect):
                    result = diagnostics.check_hermes(selection, owner_ok=True)
                self.assertEqual(result["reason"], "route_verified")
                inspect.assert_called_once_with(selection, route)

    def test_doctor_refuses_unknown_connected_route_without_host_inspection(self):
        route = {"state": "connected", "profile": "fixture", "adapterVersion": "hermes-v0.23.5"}
        with (patch.object(diagnostics.configure, "api_call", return_value={"hermes": route}),
              patch.object(hermes, "inspect_attachment") as inspect,
              patch.object(install, "detect_hermes", return_value=("detected", ""))):
            result = diagnostics.check_hermes({"mode": "standalone"}, owner_ok=True)
        self.assertEqual(result["reason"], "hermes_unsupported")
        self.assertEqual(result["status"], "failed")
        inspect.assert_not_called()
