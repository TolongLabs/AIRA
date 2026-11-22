"""Host-side owner console contracts, with a temporary gateway and model server."""

import importlib.util
import json
import os
import socket
import subprocess
import sys
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path

HOST = Path(__file__).resolve().parents[2] / "host"


class OwnerHostTest(unittest.TestCase):
    def test_directory_replacements_and_removal(self):
        spec = importlib.util.spec_from_file_location("mirror", HOST / "sync-directory.py")
        mirror = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mirror)
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            source, dest = root / "directory", root / "projection"
            for name in ("first", "second"):
                pending = root / "pending"
                pending.write_text(json.dumps({"platforms": {"whatsapp": [
                    {"id": "fixture", "name": name, "extra": "private"}
                ]}}))
                pending.replace(source)
                mirror.sync(source, dest)
                projected = dest / "channel_directory.json"
                self.assertEqual(json.loads(projected.read_text())["platforms"]["whatsapp"],
                                 [{"id": "fixture", "name": name}])
                self.assertEqual(projected.stat().st_mode & 0o777, 0o600)
            source.unlink()
            mirror.sync(source, dest)
            self.assertFalse(projected.exists())

    def test_probe_socket_checks_token_before_reading_model_tags(self):
        calls = []

        class Tags(BaseHTTPRequestHandler):
            def do_GET(self):
                calls.append(self.path)
                self.send_response(200)
                self.end_headers()
                self.wfile.write(b'{"models":[{"name":"fixture"}]}')

            def log_message(self, *args):
                pass

        with tempfile.TemporaryDirectory() as folder, HTTPServer(("127.0.0.1", 0), Tags) as server:
            token = Path(folder) / ".hermes/brain/.site-token"
            token.parent.mkdir(parents=True)
            token.write_text("fixture-secret")
            thread = threading.Thread(target=server.serve_forever, daemon=True)
            thread.start()
            try:
                for supplied, status in (("wrong", "401"), ("fixture-secret", "200")):
                    data = json.dumps({"endpoint": f"http://127.0.0.1:{server.server_port}"}).encode()
                    client, worker = socket.socketpair()
                    with client, worker:
                        with subprocess.Popen([sys.executable, HOST / "model-probe.py"], stdin=worker,
                                              env={**os.environ, "HOME": folder}) as proc:
                            worker.close()
                            client.settimeout(5)
                            client.sendall((f"POST /api/settings/models_probe HTTP/1.0\r\n"
                                            f"Content-Length: {len(data)}\r\n"
                                            f"X-TolongAI-Token: {supplied}\r\n\r\n").encode() + data)
                            with client.makefile("rb") as stream:
                                reply = stream.read()
                            self.assertIn(status.encode(), reply.splitlines()[0])
                            if status == "200":
                                self.assertEqual(json.loads(reply.split(b"\r\n\r\n")[1])["tags"], ["fixture"])
                self.assertEqual(calls, ["/api/tags"])
            finally:
                server.shutdown()
                thread.join()
