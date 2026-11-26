#!/usr/bin/env python3
"""Disposable-runner standalone install smoke test (test-only packet).

Runs ONLY on an explicitly disposable Ubuntu runner/VM. Uses only the
Python standard library and the host Docker Engine; no Node on the host,
no external network calls, no Docker image builds. The orchestrator wires
CI and runs this script; this file changes no CI config or other file.

Flow: preconditions -> collision discovery setup -> rerun stability ->
protected health/site/API -> explicit port conflict -> synthetic model
config + activate -> global example character -> synthetic gateway
handshake (pending no_reply, detach) -> doctor + redacted logs ->
stop/start/resume -> compose down (task-owned project only).
"""

from __future__ import annotations

import argparse
import http.client
import json
import os
import platform
import re
import socket
import stat
import subprocess
import sys
import tempfile
import time
import uuid
from pathlib import Path

SITE_WANT = 9890
CORE_WANT = 9881
ADAPTER_VERSION = "hermes-v0.23.4"
ADAPTER_VERSIONS = ("hermes-v0.23.2", "hermes-v0.23.3", ADAPTER_VERSION)
PROFILE = "smoke-fixture"
CHAT = "smoke-fixture-a"
CANARY_MODEL = "smoke-canary-v1"
CANARY_BASE_URL = "http://127.0.0.1:9/v1"
CANARY_KEY = "synthetic-smoke-key-do-not-contact"
SETUP_TIMEOUT_S = 600
STEP_TIMEOUT_S = 120
GLOBAL_DEADLINE_S = 1800

SECRETS: list[str] = []
OUTPUTS: list[str] = []


class SmokeError(Exception):
    def __init__(self, code: str, message: str, recovery: str = ""):
        super().__init__(message)
        self.code = code
        self.recovery = recovery


def scrub(text: str) -> str:
    for secret in SECRETS:
        if secret and secret in text:
            text = text.replace(secret, "[redacted]")
    return text


def fail(code: str, message: str, recovery: str = "") -> SmokeError:
    return SmokeError(code, scrub(message), recovery)


def note(message: str) -> None:
    sys.stderr.write(f"smoke: {scrub(message)}\n")


def clean_env() -> dict[str, str]:
    return {k: v for k, v in os.environ.items()
            if not k.startswith(("AIRA_", "COMPOSE_"))}


def run(cmd: list[str], timeout_s: int, input_text: str | None = None) -> tuple[int, str, str]:
    try:
        proc = subprocess.run(
            cmd, input=input_text, capture_output=True, text=True,
            timeout=timeout_s, env=clean_env(), stdin=subprocess.DEVNULL if input_text is None else None,
            check=False)
    except subprocess.TimeoutExpired as exc:
        raise fail("timeout", f"Timed out after {timeout_s}s: {cmd[0]} {cmd[1] if len(cmd) > 1 else ''}",
                   "Retry on a quiet runner.") from exc
    except OSError as exc:
        raise fail("spawn_failed", f"Could not start {cmd[0]}: {exc}", "Check PATH and permissions.") from exc
    return proc.returncode, proc.stdout, proc.stderr


def run_json(launcher: str, args: list[str], timeout_s: int, input_text: str | None = None) -> tuple[int, dict]:
    code, out, err = run([launcher, *args, "--json", "--non-interactive"], timeout_s, input_text)
    OUTPUTS.extend([out, err])
    check(not any(secret in out or secret in err for secret in SECRETS), "secret_leak", "CLI output contains a private credential.")
    try:
        envelope = json.loads(out.strip())
    except (ValueError, UnicodeError):
        raise fail("bad_envelope", f"{args[0]} did not return one JSON object (exit {code}).",
                   "Run aira doctor on the install.") from None
    if not isinstance(envelope, dict) or envelope.get("schemaVersion") != 1:
        raise fail("bad_envelope", f"{args[0]} returned an unexpected envelope.",
                   "Run aira doctor on the install.")
    return code, envelope


def http_call(port: int, method: str, path: str, token: str | None = None,
              body: dict | None = None, timeout_s: int = 15) -> tuple[int, dict | None, bytes]:
    headers = {"Accept": "application/json"}
    raw = None
    if body is not None:
        raw = json.dumps(body).encode()
        headers["Content-Type"] = "application/json"
    if token is not None:
        headers["X-TolongAI-Token"] = token
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=timeout_s)
    try:
        conn.request(method, path, body=raw, headers=headers)
        response = conn.getresponse()
        content = response.read(256 * 1024 + 1)
    except (TimeoutError, OSError, http.client.HTTPException) as exc:
        raise fail("http_unreachable", f"{method} {path} on 127.0.0.1:{port} failed: {exc}",
                   "Check the service, then run aira doctor.") from exc
    finally:
        conn.close()
    parsed = None
    if content:
        try:
            parsed = json.loads(content)
        except (ValueError, UnicodeError):
            parsed = None
    return response.status, parsed if isinstance(parsed, dict) else None, content


def http_gateway(port: int, path: str, credential: str | None, body: dict) -> tuple[int, dict | None]:
    headers = {"Accept": "application/json", "Content-Type": "application/json"}
    if credential is not None:
        headers["authorization"] = "Bearer " + credential
    conn = http.client.HTTPConnection("127.0.0.1", port, timeout=15)
    try:
        conn.request("POST", path, body=json.dumps(body).encode(), headers=headers)
        response = conn.getresponse()
        content = response.read(256 * 1024 + 1)
    except (TimeoutError, OSError, http.client.HTTPException) as exc:
        raise fail("http_unreachable", f"POST {path} failed: {exc}",
                   "Check the service, then run aira doctor.") from exc
    finally:
        conn.close()
    try:
        parsed = json.loads(content)
    except (ValueError, UnicodeError):
        parsed = None
    return response.status, parsed if isinstance(parsed, dict) else None


def check(condition: bool, code: str, message: str, recovery: str = "") -> None:
    if not condition:
        raise fail(code, message, recovery)


def preconditions(image: str, home: Path, launcher: Path) -> str:
    check(platform.system() == "Linux" and platform.machine() in ("x86_64", "amd64"),
          "unsupported_platform", "Need Linux amd64.", "Run on the disposable Ubuntu runner.")
    uid = os.geteuid()
    check(uid != 0, "unsupported_platform", "Refusing to run as root.",
          "Run as the non-root installation owner.")
    check(uid != 1000, "unsupported_platform", f"Refusing to run with uid {uid}.",
          "Run as the provisioned non-1000 test user.")
    check(launcher.is_file() and os.access(launcher, os.X_OK), "missing_launcher",
          f"Checkout launcher is missing: {launcher}", "Run from the repository checkout.")
    check(not sys.version_info < (3, 10), "unsupported_platform", "Need Python 3.10+.",
          "Use the runner system Python.")
    code, out, _ = run(["docker", "compose", "version", "--short"], 30)
    check(code == 0 and re.match(r"^v?[2-9][0-9]*\.", out.strip()), "docker_missing",
          "Docker Compose v2 plugin is required.", "Install Docker Engine with Compose v2.")
    code, out, _ = run(["docker", "info", "--format", "{{.ServerVersion}}"], 30)
    check(code == 0, "docker_unreachable", "The Docker daemon is unavailable.",
          "Start Docker Engine on the runner.")
    code, out, _ = run(["systemctl", "is-enabled", "docker.service"], 15)
    check(code == 0 and out.strip() == "enabled", "persistence_degraded",
          "Docker is not enabled at boot.", "Enable docker.service on the runner image.")
    code, out, _ = run(["docker", "image", "inspect", image, "--format", "{{.Id}}"], 30)
    check(code == 0 and re.fullmatch(r"sha256:[0-9a-f]{64}", out.strip()) is not None,
          "image_missing", f"Candidate image is not loaded: {image}.",
          "Load the explicit candidate image first.")
    digest = out.strip()
    if home.exists():
        entries = [p for p in home.iterdir()]
        check(not entries, "home_not_fresh", f"Home is not fresh: {home}.",
              "Point --home at a fresh private path in runner temp.")
    else:
        home.mkdir(parents=True, mode=0o700)
    info = home.lstat()
    check(stat.S_ISDIR(info.st_mode) and info.st_uid == uid and info.st_mode & 0o777 == 0o700,
          "path_unwritable", f"Home is not an owned private directory: {home}.",
          "Choose an owned path with mode 0700.")
    return digest


def hold_port(port: int) -> socket.socket:
    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        sock.bind(("127.0.0.1", port))
        sock.listen(1)
    except OSError as exc:
        sock.close()
        raise fail("port_unavailable", f"Could not reserve 127.0.0.1:{port}: {exc}.",
                   "Free the preferred ports on the runner.") from exc
    return sock


def compose_base(home: Path, project: str) -> list[str]:
    return ["docker", "compose", "--project-directory", str(home), "--env-file", str(home / ".env"),
            "-f", str(home / "compose.yml"), "--project-name", project]


def compose_port(home: Path, project: str, target: int) -> tuple[str, int]:
    code, out, err = run([*compose_base(home, project), "port", "aira", str(target)], 30)
    check(code == 0, "mapping_unavailable", f"Could not read the {target} mapping. {scrub(err[-500:])}",
          "Inspect the task-owned Compose project.")
    host, _, port = out.strip().rpartition(":")
    host = host.strip("[]")
    check(host == "127.0.0.1" and port.isdigit(), "port_not_loopback",
          f"Mapping for {target} is not private loopback: {scrub(out.strip())}.",
          "Reinstall; standalone must bind loopback only.")
    return host, int(port)


def read_private(path: Path, what: str) -> str:
    try:
        info = path.lstat()
        check(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
              and info.st_mode & 0o777 == 0o600, "unsafe_credential",
              f"{what} has unsafe ownership or permissions: {path}.",
              "Restore the documented owner-only permissions.")
        value = path.read_text(encoding="utf-8").strip()
    except OSError as exc:
        raise fail("missing_credential", f"{what} is unreadable: {exc}.",
                   "Rerun setup to resume.") from exc
    check(bool(value) and "\n" not in value and "\r" not in value, "invalid_credential",
          f"{what} is empty or malformed.", "Restore the verified credential from backup.")
    return value


def discover_launcher() -> str:
    candidates = [Path.home() / ".local" / "bin" / "aira"]
    runtime = Path.home() / ".local" / "share" / "aira" / "cli"
    if runtime.is_dir():
        for child in sorted(runtime.iterdir()):
            fallback = child / "aira"
            if fallback.is_file():
                candidates.append(fallback)
    for candidate in candidates:
        if candidate.is_file() and os.access(candidate, os.X_OK):
            code, out, _ = run([str(candidate), "--version"], 30)
            if code == 0 and "aira" in out.lower():
                return str(candidate)
    raise fail("missing_launcher", "No installed launcher answered --version.",
               "Rerun setup, then check ~/.local/bin/aira.")


def verify_restored_auth(image, home, restore, token, revision):
    """Boot only the copied store, with no real transport or provider."""
    name = "aira-restore-fixture-" + uuid.uuid4().hex[:12]
    code, _, _ = run(["docker", "run", "--pull", "never", "--rm", "-d", "--name", name,
        "--user", f"{os.geteuid()}:{os.getegid()}", "--read-only", "--tmpfs", "/tmp",
        "--env", "AIRA_INSTALL_MODE=standalone", "--env", "AIRA_DASHBOARD_ENTRY=dashboard",
        "-p", "127.0.0.1::9890", "-v", f"{restore}:/data", "-v", f"{home / 'config.yml'}:/app/config.yml:ro", image], 60)
    check(code == 0, "restore_failed", "The isolated restored copy could not start.")
    try:
        code, mapping, _ = run(["docker", "port", name, "9890/tcp"], 20)
        check(code == 0 and mapping.strip().startswith("127.0.0.1:"), "restore_failed", "Restored copy has no private site mapping.")
        port = int(mapping.strip().rsplit(":", 1)[1])
        deadline = time.monotonic() + 90
        while time.monotonic() < deadline:
            try:
                code, health, _ = http_call(port, "GET", "/owner-api/core/health", token=token, timeout_s=3)
                if code == 200 and health and health.get("status") == "ready":
                    check(health.get("appliedRevision") == revision, "restore_failed", "Restored applied revision differs.")
                    return
            except SmokeError:
                pass
            time.sleep(2)
        raise fail("restore_failed", "Restored copy did not authenticate and become ready.")
    finally:
        run(["docker", "rm", "-f", name], 60)


def main() -> int:
    start = time.monotonic()
    parser = argparse.ArgumentParser(description="Disposable-runner standalone install smoke test.")
    parser.add_argument("--image", required=True, help="Explicit loaded candidate image ref.")
    parser.add_argument("--home", required=True, help="Fresh private owned path in runner temp.")
    parser.add_argument("--hermes-dir", type=Path, help="Disposable pinned upstream checkout.")
    parser.add_argument("--hermes-home", type=Path, help="Disposable independent Hermes profile root.")
    parser.add_argument("--adapter-version", choices=ADAPTER_VERSIONS, default=ADAPTER_VERSION,
                        help="Expected exact version for the selected public stock fixture.")
    parser.add_argument("--update-image", help="Loaded compatible second candidate.")
    parser.add_argument("--bad-image", help="Loaded candidate with a failing isolated deploy probe.")
    args = parser.parse_args()
    image, home = args.image, Path(args.home).expanduser().absolute()
    repo_root = Path(__file__).resolve().parents[2]
    checkout_launcher = repo_root / "aira"
    held: list[socket.socket] = []
    project = ""
    try:
        note("step 1/12 preconditions")
        digest = preconditions(image, home, checkout_launcher)
        check(bool(re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?", image)),
              "config_invalid", "Image ref is malformed.", "Use registry/repository:tag.")

        note("step 2/12 collision discovery setup")
        held = [hold_port(SITE_WANT), hold_port(CORE_WANT)]
        code, setup = run_json(str(checkout_launcher),
                               ["setup", "--home", str(home), "--no-open", "--image", image],
                               SETUP_TIMEOUT_S)
        check(code == 0 and setup.get("outcome") == "ok", "setup_failed",
              f"Setup failed: {setup.get('error', {}).get('code', code)} "
              f"{setup.get('error', {}).get('message', '')}",
              setup.get("error", {}).get("recovery", "Run aira doctor."))
        state = setup.get("state", {})
        check(state.get("installation") == "installed" and state.get("service") == "running",
              "setup_failed", f"Unexpected setup state: {state}.", "Run aira doctor.")
        check(setup.get("installationMode") == "standalone", "wrong_mode",
              "Install is not standalone.", "Use a fresh --home.")
        check(state.get("configuration") == "setup_required" and state.get("chatbot") == "inactive",
              "unexpected_state", f"No-keys state expected after setup: {state}.",
              "Start from a fresh --home.")
        check(setup.get("imageId") == digest, "image_mismatch",
              "Installed image ID differs from the loaded candidate.", "Rerun setup.")
        dashboard = setup.get("dashboard", {})
        site_port = dashboard.get("sitePort")
        core_port = dashboard.get("corePort")
        check(isinstance(site_port, int) and isinstance(core_port, int) and site_port != core_port,
              "bad_dashboard", "Setup dashboard has no usable ports.", "Rerun setup.")
        check(site_port != SITE_WANT and core_port != CORE_WANT, "collision_not_discovered",
              f"Setup reused the held ports: {site_port}/{core_port}.", "Check port discovery.")
        check(dashboard.get("url") == f"http://127.0.0.1:{site_port}/overview", "bad_url",
              "Dashboard URL is not the actual mapped URL.", "Rerun setup.")
        manifest = json.loads((home / "install.json").read_text(encoding="utf-8"))
        project = manifest["project"]
        check(manifest.get("imageId") == digest and manifest.get("sitePort") == site_port
              and manifest.get("corePort") == core_port, "manifest_mismatch",
              "Manifest does not record the verified mapping.", "Rerun setup.")
        compose_port(home, project, 9881)
        compose_port(home, project, 9890)
        owner_token = read_private(home / "data" / "standalone" / "owner.token", "Owner token")
        gateway_token = read_private(home / "data" / "standalone" / "gateway.token", "Gateway token")
        SECRETS.extend([owner_token, gateway_token, CANARY_KEY])
        check(not any(secret in output for output in OUTPUTS for secret in SECRETS), "secret_leak", "Initial CLI output contains a private credential.")
        check(owner_token != gateway_token, "credential_reuse",
              "Owner and gateway credentials are identical.", "Rerun setup from a fresh --home.")

        note("step 3/12 installed launcher, status, dashboard, rerun stability")
        launcher = discover_launcher()
        note(f"installed launcher: {launcher}")
        code, status = run_json(launcher, ["status", "--home", str(home)], STEP_TIMEOUT_S)
        check(code == 0 and status.get("outcome") == "ok", "status_failed",
              "Status failed on a running install.", "Run aira doctor.")
        code, dash = run_json(launcher, ["dashboard", "--home", str(home), "--no-open"], STEP_TIMEOUT_S)
        check(code == 0 and dash.get("dashboard", {}).get("url") == dashboard["url"], "bad_url",
              "Dashboard URL moved between calls.", "Rerun setup.")
        code, reveal = run_json(launcher, ["dashboard", "--home", str(home), "--show-token"], STEP_TIMEOUT_S)
        check(code == 4 and reveal.get("error", {}).get("code") == "owner_auth_failed",
              "credential_disclosure", "Non-interactive token reveal was not refused.")
        code, rerun = run_json(launcher, ["setup", "--home", str(home), "--no-open"], SETUP_TIMEOUT_S)
        check(code == 0 and rerun.get("outcome") == "ok", "resume_failed",
              "Setup resume failed on a healthy install.", "Run aira doctor.")
        check(rerun.get("imageId") == digest
              and rerun.get("dashboard", {}).get("sitePort") == site_port
              and rerun.get("dashboard", {}).get("corePort") == core_port, "resume_moved",
              "Resume changed the committed mapping or image.", "Inspect the Compose project.")
        check(read_private(home / "data" / "standalone" / "owner.token", "Owner token") == owner_token,
              "token_rotated", "Resume changed the owner credential.", "Restore it from backup.")

        note("step 4/12 protected health, site document, example/studio API")
        status_code, _, _ = http_call(core_port, "GET", "/health")
        check(status_code == 200, "core_down", "Core health is not ready.", "Run aira doctor.")
        code, health, _ = http_call(core_port, "GET", "/health")
        check(health is not None and health.get("status") == "ready"
              and health.get("installationMode") == "standalone"
              and health.get("schemaVersion") == 1, "incompatible_health",
              "Core health is not the standalone schema.", "Use a compatible image.")
        for bad in (None, "0" * 64):
            code, _, _ = http_call(site_port, "GET", "/owner-api/core/health", token=bad)
            check(code == 401, "auth_not_enforced", f"Owner health answered {code} without a valid token.",
                  "Use a compatible image.")
        code, owner_health, raw = http_call(site_port, "GET", "/owner-api/core/health", token=owner_token)
        check(code == 200 and owner_health is not None, "owner_health_failed",
              "Authenticated owner health failed.", "Run aira doctor.")
        check(owner_health.get("configuration") == "setup_required"
              and owner_health.get("chatbot") == "inactive", "unexpected_state",
              f"No-keys owner health unexpected: { {k: owner_health.get(k) for k in ('configuration', 'chatbot')} }.",
              "Start from a fresh --home.")
        check("apiKey" not in raw.decode("utf-8", "replace"), "secret_leak",
              "Owner health exposes key material.", "Use a compatible image.")
        code, chars, _ = http_call(site_port, "GET", "/owner-api/core/characters", token=owner_token)
        check(code == 200 and isinstance((chars or {}).get("characters"), list), "characters_failed",
              "Characters API is unavailable.", "Run aira doctor.")
        ids = [c.get("id") for c in chars["characters"] if isinstance(c, dict)]
        check("example" in ids, "example_missing",
              f"Example pack is not loaded: {ids}.", "Use a compatible image.")
        code, settings, _ = http_call(site_port, "GET", "/owner-api/core/settings?level=global&scope=",
                                      token=owner_token)
        check(code == 200 and settings is not None, "settings_failed",
              "Global settings read failed.", "Run aira doctor.")
        code, page, _ = http_call(site_port, "GET", "/overview")
        check(code == 200 and (b"<html" in _.lower() or b"<!doctype" in _.lower()), "dashboard_missing",
              "Dashboard document is unavailable.", "Run aira doctor.")

        note("step 5/12 explicit port conflict on a held port")
        conflict_home = Path(tempfile.mkdtemp(prefix="aira-smoke-conflict-"))
        code, conflict = run_json(launcher, ["setup", "--home", str(conflict_home), "--no-open",
                                             "--image", image, "--site-port", str(SITE_WANT),
                                             "--core-port", "9883"], STEP_TIMEOUT_S)
        check(code == 4 and conflict.get("outcome") == "error"
              and conflict.get("error", {}).get("code") == "port_conflict", "conflict_not_detected",
              f"Explicit held port was not refused: {conflict.get('error', {}).get('code', code)}.",
              "Check port conflict handling.")
        for sock in held:
            sock.close()
        held = []
        note("collision sockets torn down")

        note("step 6/12 synthetic model config, no live provider contact")
        code, saved = run_json(launcher, ["config", "set-model", "--home", str(home), "--role", "main",
                                          "--provider", "openai-compatible", "--model", CANARY_MODEL,
                                          "--base-url", CANARY_BASE_URL, "--key-stdin"],
                               STEP_TIMEOUT_S, input_text=CANARY_KEY + "\n")
        check(code == 0 and saved.get("outcome") == "ok", "set_model_failed",
              f"set-model failed: {saved.get('error', {}).get('code', code)}.",
              saved.get("error", {}).get("recovery", "Run aira doctor."))
        revision = saved.get("savedRevision")
        check(isinstance(revision, str) and bool(revision), "no_revision",
              "set-model returned no saved revision.", "Read the configuration again.")
        code, got = run_json(launcher, ["config", "get", "--home", str(home)], STEP_TIMEOUT_S)
        check(code == 0 and got.get("outcome") == "ok", "config_get_failed",
              "Config readback failed.", "Run aira doctor.")
        get_text = json.dumps(got.get("config", {}))
        check('"apiKey"' not in get_text and CANARY_KEY not in get_text, "secret_leak",
              "Config readback exposes key material.", "Use a compatible CLI.")
        check("credentialConfigured" in get_text, "credential_not_shown",
              "Readback does not show credentialConfigured.", "Use a compatible CLI.")
        check(got.get("config", {}).get("appliedRevision") != revision, "not_pending",
              "Model revision applied without activation.", "Check revision authority.")
        for envelope in (saved, got):
            blob = json.dumps(envelope)
            check(CANARY_KEY not in blob, "secret_leak", "CLI output exposes the key.",
                  "Use a compatible CLI.")

        note("step 7/12 activate waits for the applied revision")
        code, active = run_json(launcher, ["config", "activate", "--home", str(home),
                                           "--expected-revision", revision], STEP_TIMEOUT_S)
        check(code == 0 and active.get("outcome") == "ok", "activate_failed",
              f"Activate failed: {active.get('error', {}).get('code', code)}.",
              active.get("error", {}).get("recovery", "Check the readback and retry."))
        check(active.get("appliedRevision") == revision, "revision_mismatch",
              "Applied revision does not match the saved revision.", "Check the readback.")
        check(read_private(home / "data" / "standalone" / "owner.token", "Owner token") == owner_token,
              "token_rotated", "Activation changed the owner credential.", "Restore it from backup.")
        manifest = json.loads((home / "install.json").read_text(encoding="utf-8"))
        check(manifest.get("imageId") == digest and manifest.get("sitePort") == site_port
              and manifest.get("corePort") == core_port, "mapping_moved",
              "Activation moved ports or image.", "Inspect the Compose project.")

        note("step 8/12 global example character")
        code, char = run_json(launcher, ["config", "set-character", "--home", str(home),
                                        "--level", "global", "--pack", "example"], STEP_TIMEOUT_S)
        check(code == 0 and char.get("outcome") == "ok", "set_character_failed",
              f"set-character failed: {char.get('error', {}).get('code', code)}.",
              char.get("error", {}).get("recovery", "Run aira doctor."))

        note("step 9/12 verified gateway route, one pending chat, detach")
        profile = PROFILE
        if bool(args.hermes_dir) != bool(args.hermes_home):
            raise fail("invalid_args", "The pinned Hermes source and fixture home must be selected together.")
        if args.hermes_dir:
            profile = "default"
            source = args.hermes_dir / "gateway" / "run_inbound_consumer.py"
            helper = source.with_name("aira_transport.py")
            marker = args.hermes_home / "aira-transport.json"
            original = source.read_bytes()
            options = ["attach-hermes", "--home", str(home), "--profile", profile,
                       "--hermes-dir", str(args.hermes_dir), "--hermes-home", str(args.hermes_home)]
            code, plan = run_json(launcher, [*options, "--dry-run"], STEP_TIMEOUT_S)
            check(code == 0 and plan.get("attach", {}).get("dryRun") is True
                  and plan.get("attach", {}).get("adapterVersion") == args.adapter_version,
                  "hermes_dry_run_failed", "Pinned Hermes dry-run failed.")
            check(source.read_bytes() == original and not marker.exists() and not helper.exists(),
                  "dry_run_mutation", "Dry-run changed its source or profile.")

            # The running synthetic core retains its original gateway credential. Change only the disposable
            # fixture's on-disk gateway credential to force a real failed handshake after the candidate writes.
            # The normal attachment transaction must restore the exact original source and private files.
            tokenpath = home / "data/standalone/gateway.token"
            token_bytes = tokenpath.read_bytes()
            wrong_token = "0" * 64 if gateway_token != "0" * 64 else "1" * 64
            SECRETS.append(wrong_token)
            host_record = home / "data/standalone/attach-host.json"
            route_record = home / "data/standalone/hermes.json"
            before = {p: p.read_bytes() if p.exists() else None for p in (helper, marker, host_record, route_record)}
            try:
                tokenpath.write_text(wrong_token + "\n")
                code, failed = run_json(launcher, [*options, "--apply", "--yes"], STEP_TIMEOUT_S)
                check(code == 1 and failed.get("error", {}).get("code") == "attach_failed",
                      "hermes_rollback_failed", "The refused handshake did not report verified rollback.")
                check(source.read_bytes() == original and all(
                    (p.read_bytes() if p.exists() else None) == contents for p, contents in before.items()),
                    "hermes_rollback_failed", "Failed attachment changed its original source or private state.")
            finally:
                tokenpath.write_bytes(token_bytes)

            code, applied = run_json(launcher, [*options, "--apply", "--yes"], STEP_TIMEOUT_S)
            check(code == 0 and applied.get("state", {}).get("hermes") == "connected"
                  and applied.get("attach", {}).get("adapterVersion") == args.adapter_version
                  and applied.get("attach", {}).get("gatewayRunning") is False,
                  "hermes_attach_failed", "Selected stopped Hermes profile did not attach safely.")
            check(source.read_bytes() != original and marker.is_file() and marker.stat().st_mode & 0o777 == 0o600,
                  "hermes_marker_failed", "Pinned source or private marker was not installed.")
            attached = {p: p.read_bytes() for p in (source, helper, marker, host_record)}
            code, repeated = run_json(launcher, [*options, "--apply", "--yes"], STEP_TIMEOUT_S)
            check(code == 0 and repeated.get("attach", {}).get("adapterVersion") == args.adapter_version
                  and repeated.get("attach", {}).get("changes") == []
                  and all(p.read_bytes() == data for p, data in attached.items()),
                  "hermes_repeat_failed", "Repeated attachment did not preserve its source and selected marker.")
        attach = {"schemaVersion": 1, "adapterVersion": args.adapter_version,
                  "profile": profile, "action": "connect"}
        code, _ = http_gateway(core_port, "/v1/aira/attach-check", owner_token, attach)
        check(code == 401, "credential_not_separated",
              f"Attach-check accepted the owner credential: {code}.", "Use a compatible image.")
        code, body = http_gateway(core_port, "/v1/aira/attach-check", gateway_token, attach)
        check(code == 200 and body is not None and body.get("hermes", {}).get("adapterVersion") == args.adapter_version,
              "attach_failed", "Synthetic attach-check did not read back the selected version.", "Run aira doctor.")
        turn = {"schemaVersion": 1, "profile": profile, "platform": "whatsapp",
                "kind": "dm", "chat": CHAT, "sender": CHAT, "mid": "m1",
                "text": "smoke pending fixture"}
        code, _ = http_gateway(core_port, "/v1/aira/turn", owner_token, turn)
        check(code == 401, "turn_auth_not_enforced", f"Turn accepted the owner credential: {code}.",
              "Use a compatible image.")
        code, pending = http_gateway(core_port, "/v1/aira/turn", gateway_token, turn)
        check(code == 200 and pending is not None and pending.get("disposition") == "no_reply"
              and pending.get("reply") is None, "pending_turn_failed",
              f"Pending chat did not answer no_reply: {pending}.", "Run aira doctor.")
        code, chats, _ = http_call(site_port, "GET", "/owner-api/core/chats", token=owner_token)
        check(code == 200 and any(c.get("chatId") for c in (chats or {}).get("chats", [])),
              "chats_missing", "Pending chat is not listed.", "Run aira doctor.")

        # Synthetic direct handshake alone is not a verified host attachment.
        if not args.hermes_dir:
            code, _ = http_gateway(core_port, "/v1/aira/attach-check", gateway_token, dict(attach, action="disconnect"))
            check(code == 200, "detach_failed", "Synthetic detach failed.")
        note("step 10/12 doctor and redacted logs, canary absent")
        code, doctor = run_json(launcher, ["doctor", "--home", str(home)], STEP_TIMEOUT_S)
        checks = doctor.get("checks", []) if isinstance(doctor.get("checks"), list) else []
        failed = [c.get("name") for c in checks if isinstance(c, dict) and c.get("status") == "failed"]
        check(code == 0 and doctor.get("outcome") == "ok" and not failed, "doctor_failed",
              f"Doctor reported failures: {failed}.", "See each check recovery; run aira logs.")
        seen = ""
        for component in ("core", "gateway"):
            code, logs = run_json(launcher, ["logs", "--home", str(home), "--component", component,
                                             "--lines", "50"], STEP_TIMEOUT_S)
            check(code == 0 and logs.get("outcome") == "ok", "logs_failed",
                  f"Logs for {component} are unavailable.", "Run aira doctor.")
            seen += json.dumps(logs.get("events", []))
        for needle in (CANARY_MODEL, CANARY_KEY, owner_token, gateway_token):
            check(needle not in seen, "secret_leak",
                  "Logs expose sensitive material.", "Use a compatible CLI.")
        note("canary absent from bounded logs")

        detach = dict(attach, action="disconnect")
        code, _ = http_gateway(core_port, "/v1/aira/attach-check", gateway_token, detach)
        check(code == 200, "detach_failed", "Authenticated detach failed.", "Run aira doctor.")
        code, _ = http_gateway(core_port, "/v1/aira/turn", gateway_token, dict(turn, mid="m2"))
        check(code == 503, "detach_not_effective",
              f"Turn after detach did not stop: {code}.", "Run aira doctor.")

        note("step 11/12 stop, start, setup resume keeps token, ports, digest")
        code, _, err = run([*compose_base(home, project), "stop", "aira"], STEP_TIMEOUT_S)
        check(code == 0, "stop_failed", f"Compose stop failed. {scrub(err[-500:])}",
              "Inspect the task-owned Compose project.")
        code, resumed = run_json(launcher, ["setup", "--home", str(home), "--no-open"], SETUP_TIMEOUT_S)
        check(code == 0 and resumed.get("outcome") == "ok"
              and resumed.get("state", {}).get("service") == "running", "resume_failed",
              "Setup did not restart the stopped install.", "Run aira doctor.")
        check(read_private(home / "data" / "standalone" / "owner.token", "Owner token") == owner_token
              and resumed.get("imageId") == digest
              and resumed.get("dashboard", {}).get("sitePort") == site_port
              and resumed.get("dashboard", {}).get("corePort") == core_port, "resume_moved",
              "Resume changed token, ports or image.", "Inspect the Compose project.")

        if bool(args.update_image) != bool(args.bad_image):
            raise fail("invalid_args", "Both update and failure fixture images are required for update smoke.")
        if args.update_image:
            note("update smoke: compatible image, private backup and restored copy")
            code, upgraded = run_json(launcher, ["update", "--home", str(home), "--image", args.update_image], 300)
            check(code == 0 and upgraded.get("imageId") != digest and upgraded.get("backupId"),
                  "update_failed", "Compatible image update did not commit a new verified digest.")
            new_id = upgraded["imageId"]
            restore = home.parent / (home.name + "-restored")
            code, copied = run_json(launcher, ["restore", "--home", str(home), "--backup-id", upgraded["backupId"],
                                               "--destination", str(restore)], 300)
            check(code == 0 and copied.get("backup", {}).get("restoredCopy"), "restore_failed", "Verified backup restore failed.")
            check(read_private(restore / "standalone/owner.token", "Restored owner token") == owner_token,
                  "restore_failed", "Restored token differs from the original.")
            creds = "standalone/revisions/" + revision + ".credentials.json"
            check((restore / creds).read_bytes() == (home / "data" / creds).read_bytes() and
                  (restore / creds).stat().st_mode & 0o777 == 0o600, "restore_failed", "Restored model credential state differs.")
            verify_restored_auth(args.update_image, home, restore, owner_token, revision)
            note("update smoke: failing isolated probe rolls back exact previous image")
            code, failed = run_json(launcher, ["update", "--home", str(home), "--image", args.bad_image], 300)
            check(code == 1 and failed.get("error", {}).get("code") == "update_rolled_back",
                  "rollback_failed", "Failed candidate did not report verified rollback.")
            code, after = run_json(launcher, ["status", "--home", str(home)], STEP_TIMEOUT_S)
            check(code == 0 and after.get("imageId") == new_id and after.get("state", {}).get("service") == "running"
                  and after.get("dashboard", {}).get("sitePort") == site_port and after.get("dashboard", {}).get("corePort") == core_port
                  and read_private(home / "data/standalone/owner.token", "Owner token") == owner_token,
                  "rollback_failed", "The previous image, owner token or ports changed on rollback.")

        note("step 12/12 teardown task-owned project only")
        code, _, err = run([*compose_base(home, project), "down"], STEP_TIMEOUT_S)
        check(code == 0, "teardown_failed", f"Compose down failed. {scrub(err[-500:])}",
              "Remove the task-owned project manually; never use -v or prune.")
        elapsed = time.monotonic() - start
        sys.stdout.write(f"smoke: ok image={image} ports={site_port}/{core_port} "
                         f"project={project} elapsed={elapsed:.0f}s\n")
        sys.stdout.write(f"smoke: fixture dirs left in runner temp: {home} {conflict_home}\n")
        return 0
    except SmokeError as exc:
        elapsed = time.monotonic() - start
        sys.stderr.write(f"smoke: FAIL [{exc.code}] {exc}\n")
        if exc.recovery:
            sys.stderr.write(f"smoke: recovery: {exc.recovery}\n")
        sys.stderr.write(f"smoke: elapsed={elapsed:.0f}s project={project or '?'} home={home}\n")
        return 1
    finally:
        for sock in held:
            try:
                sock.close()
            except OSError:
                pass
        check_global = time.monotonic() - start
        if check_global > GLOBAL_DEADLINE_S:
            sys.stderr.write("smoke: WARNING global deadline exceeded\n")


if __name__ == "__main__":
    sys.exit(main())
