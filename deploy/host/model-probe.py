"""Single authenticated probe request on a systemd Accept=yes Unix socket."""
import hmac
import http.client
import json
import socket
from http.server import BaseHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit


def probe(endpoint):
    url = urlsplit(endpoint)
    if (url.scheme not in ("http", "https") or not url.hostname or url.username
            or url.password or url.query or url.fragment or url.path.strip("/")):
        raise ValueError("Enter an HTTP or HTTPS origin for Ollama")
    connection = (http.client.HTTPSConnection if url.scheme == "https" else http.client.HTTPConnection)(
        url.hostname, url.port, timeout=4)
    try:
        connection.request("GET", "/api/tags", headers={"Accept": "application/json"})
        response = connection.getresponse()
        if response.status != 200:
            raise OSError("Endpoint did not return model tags")
        body = response.read(1024 * 1024 + 1)
        if len(body) > 1024 * 1024:
            raise OSError("Model list exceeds size limit")
        models = json.loads(body)["models"]
        if not isinstance(models, list) or not all(isinstance(m, dict) and isinstance(m.get("name"), str) for m in models):
            raise OSError("Invalid model list")
        return {"endpoint": endpoint, "reachable": True, "tags": [m["name"] for m in models]}
    finally:
        connection.close()


class Handler(BaseHTTPRequestHandler):
    def reply(self, status, body):
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        if self.path != "/api/settings/models_probe":
            return self.reply(404, {"error": "Unknown route"})
        try:
            token = (Path.home() / ".hermes/brain/.site-token").read_bytes().strip()
            supplied = self.headers.get("X-TolongAI-Token", "").encode()
            if not token or not hmac.compare_digest(token, supplied):
                return self.reply(401, {"error": "Owner token required"})
            length = int(self.headers.get("Content-Length", 0))
            if not 0 < length <= 4096:
                return self.reply(400, {"error": "Invalid probe request"})
            endpoint = json.loads(self.rfile.read(length))["endpoint"]
            if not isinstance(endpoint, str):
                raise ValueError()
            status, result = 200, probe(endpoint)
        except (ValueError, KeyError, TypeError):
            status, result = 400, {"error": "Invalid endpoint or model response"}
        except (OSError, http.client.HTTPException):
            status, result = 502, {"error": "Could not reach Ollama or read its model list"}
        self.reply(status, result)

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    with socket.fromfd(0, socket.AF_UNIX, socket.SOCK_STREAM) as stream:
        stream.settimeout(8)
        Handler(stream, ("localhost", 0), None)
