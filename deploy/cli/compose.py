"""Host-only Docker and bounded private HTTP operations."""

from __future__ import annotations

import http.client
import ipaddress
import json
import os
import platform
import re
import shutil
import socket
import subprocess
import time
from pathlib import Path
from urllib.parse import urlsplit

from . import (
    COMPOSE_START_TIMEOUT_S,
    DEFAULT_IMAGE_REPOSITORY,
    DEFAULT_IMAGE_TAG,
    DOCKER_PULL_ATTEMPTS,
    DOCKER_PULL_BUDGET_MS,
    DOCKER_PULL_FIRST_ATTEMPT_MS,
    DOCKER_TIMEOUT_S,
    HEALTH_FETCH_TIMEOUT_S,
    HEALTH_VERIFY_TIMEOUT_S,
)
from .result import conflict_error, operational_error

KNOWN_ENV_KEYS = (
    "AIRA_PORT", "AIRA_SITE_PORT", "AIRA_SITE_BIND", "AIRA_DATA_DIR",
    "AIRA_IMAGE", "AIRA_VERSION", "AIRA_INSTALL_MODE", "AIRA_UID", "AIRA_GID",
    "AIRA_DASHBOARD_ENTRY",
)
IMAGE_REF = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9._/-]*(?::[a-zA-Z0-9._-]+)?$")
ARCH_ALIASES = {"x86_64": "amd64", "amd64": "amd64", "aarch64": "arm64", "arm64": "arm64"}


class RunError(Exception):
    def __init__(self, kind: str):
        super().__init__(kind)
        self.kind = kind


def run(argv, timeout_s=DOCKER_TIMEOUT_S, env=None):
    """Never return or raise an unredacted child diagnostic to the user."""
    if not argv or shutil.which(argv[0]) is None:
        raise RunError("missing")
    try:
        result = subprocess.run(argv, capture_output=True, text=True, timeout=timeout_s, env=env,
                                stdin=subprocess.DEVNULL, check=False)
    except subprocess.TimeoutExpired as exc:
        raise RunError("timeout") from exc
    except PermissionError as exc:
        raise RunError("denied") from exc
    except (OSError, UnicodeError) as exc:
        raise RunError("unreachable") from exc
    if len(result.stdout) > 2 * 1024 * 1024:
        raise RunError("invalid_output")
    return result.returncode, result.stdout, result.stderr[-4000:]


def classify_docker_error(stderr):
    text = stderr.lower()
    if "permission denied" in text or "operation not permitted" in text:
        return "denied"
    if "address already in use" in text or "port is already allocated" in text:
        return "port_in_use"
    if "cannot connect" in text or "connection refused" in text or "daemon is running" in text:
        return "unreachable"
    if any(s in text for s in ("timeout", "temporary", "connection reset", "unexpected eof", "network")):
        return "transient"
    return "failed"


def http_request(url, timeout_s=HEALTH_FETCH_TIMEOUT_S, headers=None, method="GET", body=None, *, response_limit=256 * 1024):
    """Direct numeric-host HTTP only: no proxy, redirect, or credential in URL."""
    parsed = urlsplit(url)
    try:
        ipaddress.ip_address(parsed.hostname or "")
        if parsed.scheme != "http" or parsed.username or parsed.password or parsed.fragment:
            raise ValueError()
        connection = http.client.HTTPConnection(parsed.hostname, parsed.port, timeout=timeout_s)
    except ValueError:
        return -1, b"", "invalid_url"
    try:
        path = parsed.path or "/"
        if parsed.query:
            path += "?" + parsed.query
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        content = response.read(response_limit + 1)
        if len(content) > response_limit:
            return response.status, b"", "too_large"
        return response.status, content, "ok"
    except (TimeoutError, socket.timeout):
        return -1, b"", "timeout"
    except (OSError, http.client.HTTPException, ValueError):
        return -1, b"", "unreachable"
    finally:
        connection.close()


def http_get_json(url, timeout_s=HEALTH_FETCH_TIMEOUT_S, headers=None):
    status, body, kind = http_request(url, timeout_s, headers)
    if kind != "ok" or status < 200 or status >= 300:
        return status, None, kind if kind != "ok" else f"http_{status}"
    try:
        return status, json.loads(body), "ok"
    except (ValueError, UnicodeError):
        return status, None, "bad_json"


def parse_env_file(path: Path, known=KNOWN_ENV_KEYS):
    """Only known values are returned; dotenv is never executed."""
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
        with os.fdopen(fd, encoding="utf-8") as handle:
            text = handle.read(1024 * 1024 + 1)
    except (OSError, UnicodeError):
        return {}
    if len(text) > 1024 * 1024:
        return {}
    values = {}
    for line in text.splitlines():
        key, sep, value = line.strip().partition("=")
        if not sep or key not in known:
            continue
        value = value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in ("'", '"'):
            value = value[1:-1].replace("\\'", "'")
        else:
            value = value.split(" #", 1)[0].strip()
        values[key] = value
    return values


def split_image_ref(ref):
    if not isinstance(ref, str) or not IMAGE_REF.fullmatch(ref):
        raise conflict_error("config_invalid", "Image must be a registry/repository:tag or a local image tag.",
                             recovery="Choose a compatible released image or an explicit local candidate.")
    repo, separator, tag = ref.rpartition(":")
    return (repo, tag) if separator else (ref, DEFAULT_IMAGE_TAG)


def default_image_ref():
    return f"{DEFAULT_IMAGE_REPOSITORY}:{DEFAULT_IMAGE_TAG}"


def compose_base(home, project):
    return ["docker", "compose", "--project-directory", str(home), "--env-file", str(home / ".env"),
            "-f", str(home / "compose.yml"), "--project-name", project]


def compose_run(home, project, args, timeout_s=DOCKER_TIMEOUT_S, overrides=None):
    # A caller's exported Compose/AIRA variables must not reroute another install.
    env = {k: v for k, v in os.environ.items() if not k.startswith(("AIRA_", "COMPOSE_"))}
    env.update(overrides or {})
    return run(compose_base(home, project) + list(args), timeout_s=timeout_s, env=env)


def _json_entries(out):
    try:
        value = json.loads(out or "[]")
        return value if isinstance(value, list) else [value] if isinstance(value, dict) else []
    except ValueError:
        try:
            return [json.loads(line) for line in out.splitlines() if line.strip()]
        except ValueError:
            return []


def projects():
    code, out, _ = run(["docker", "compose", "ls", "--all", "--format", "json"], timeout_s=30)
    if code != 0:
        raise RunError("unreachable")
    return [entry for entry in _json_entries(out) if isinstance(entry, dict)]


def detect_project(home):
    needle = str(home / "compose.yml")
    matches = []
    for entry in projects():
        files = str(entry.get("ConfigFiles", "")).split(",")
        if needle in [f.strip() for f in files]:
            name = entry.get("Name")
            if isinstance(name, str):
                matches.append(name)
    if len(set(matches)) > 1:
        raise conflict_error("install_ambiguous", "More than one Compose project uses this install.",
                             stage="discover", recovery="Select or repair the existing project explicitly.")
    return matches[0] if matches else None


def ps_entries(home, project, service="aira"):
    code, out, _ = compose_run(home, project, ["ps", "--all", "--format", "json", service], timeout_s=30)
    if code != 0:
        raise RunError("unreachable")
    return [entry for entry in _json_entries(out) if isinstance(entry, dict)]


def service_running(entries):
    return any(str(e.get("State", "")).lower() == "running" for e in entries)


def container_id(home, project, service="aira"):
    entries = ps_entries(home, project, service)
    ids = [e.get("ID") or e.get("Id") for e in entries]
    ids = [i for i in ids if isinstance(i, str) and re.fullmatch(r"[0-9a-f]{12,64}", i)]
    if len(ids) > 1:
        raise conflict_error("install_ambiguous", "Expected one AIRA container.", stage="discover",
                             recovery="Inspect the selected Compose project.")
    return ids[0] if ids else None


def _binding(text):
    host, _, port = text.strip().rpartition(":")
    host = host.strip("[]")
    try:
        ipaddress.ip_address(host)
        number = int(port)
        if 1 <= number <= 65535:
            return host, number
    except ValueError:
        pass
    return None


def published_bindings(home, project):
    """Read actual mappings; stopped container bindings come from Docker inspect."""
    entries = ps_entries(home, project)
    result = {}
    if service_running(entries):
        for target in (9881, 9890):
            code, out, _ = compose_run(home, project, ["port", "aira", str(target)], timeout_s=20)
            binding = _binding(out) if code == 0 else None
            if binding:
                result[target] = binding
        return result
    cid = container_id(home, project)
    if cid:
        code, out, _ = run(["docker", "inspect", "--format", "{{json .HostConfig.PortBindings}}", cid], 20)
        try:
            bindings = json.loads(out) if code == 0 else {}
            for target in (9881, 9890):
                candidates = bindings.get(f"{target}/tcp") or []
                if len(candidates) == 1:
                    entry = candidates[0]
                    binding = _binding(f"{entry['HostIp']}:{entry['HostPort']}")
                    if binding:
                        result[target] = binding
        except (ValueError, TypeError, KeyError, AttributeError):
            pass
    return result


def published_ports(home, project):
    return {target: binding[1] for target, binding in published_bindings(home, project).items()}


def container_image_id(home, project, service="aira"):
    cid = container_id(home, project, service)
    if not cid:
        return None
    code, out, _ = run(["docker", "inspect", "--format", "{{.Image}}", cid], timeout_s=20)
    image = out.strip()
    return image if code == 0 and re.fullmatch(r"sha256:[0-9a-f]{64}", image) else None


def restart_policy(home, project):
    cid = container_id(home, project)
    if not cid:
        return None
    code, out, _ = run(["docker", "inspect", "--format", "{{.HostConfig.RestartPolicy.Name}}", cid], 20)
    return out.strip() if code == 0 else None


def local_image_present(ref):
    split_image_ref(ref)
    code, _, _ = run(["docker", "image", "inspect", ref], timeout_s=10)
    return code == 0


def normalize_arch(value):
    """Normalize a CPU architecture alias to ``amd64`` or ``arm64``.

    Returns None for anything else, including non-string input.
    """
    if not isinstance(value, str):
        return None
    return ARCH_ALIASES.get(value.strip().lower())


def image_platform(ref):
    """Read-only image OS/architecture probe.

    Returns the exact known platform ``linux/amd64`` or ``linux/arm64``,
    or None when the image is unknown, unreadable or anything else.
    """
    try:
        code, out, _ = run(
            ["docker", "image", "inspect", "--format", "{{.Os}}/{{.Architecture}}", ref],
            timeout_s=10)
    except RunError:
        return None
    if code != 0:
        return None
    value = out.strip()
    return value if value in ("linux/amd64", "linux/arm64") else None


def pull_image(ref):
    split_image_ref(ref)
    deadline = time.monotonic() + DOCKER_PULL_BUDGET_MS / 1000
    for attempt in range(DOCKER_PULL_ATTEMPTS):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            break
        cap = DOCKER_PULL_FIRST_ATTEMPT_MS / 1000 if attempt == 0 else remaining
        try:
            code, _, stderr = run(["docker", "pull", ref], timeout_s=min(cap, remaining))
            if code == 0:
                return
            if classify_docker_error(stderr) not in ("transient", "unreachable"):
                break
        except RunError as error:
            if error.kind not in ("timeout", "unreachable"):
                break
    raise operational_error("image_pull_failed", "The image could not be pulled.", stage="pull",
                            recovery="Check Docker and registry access, then run aira setup.", retryable=True)


class PortInUseError(Exception):
    pass


def compose_up(home, project, env=None, timeout_s=COMPOSE_START_TIMEOUT_S):
    # Only standalone creation/update/rollback uses up; legacy resumes with start.
    native = normalize_arch(platform.machine()) if platform.system() == "Linux" else None
    if native is None:
        raise operational_error("image_incompatible", "Cannot start a non-native image.", "compatibility",
                                "Use a supported native Linux host.")
    overrides = {**(env or {}), "DOCKER_DEFAULT_PLATFORM": f"linux/{native}"}
    try:
        code, _, stderr = compose_run(home, project, ["up", "-d", "--pull", "never", "aira"],
                                      timeout_s=timeout_s, overrides=overrides)
    except RunError as exc:
        raise operational_error("service_start_failed", "Compose start did not complete.", stage="start",
                                recovery="Run aira doctor, then retry setup.", retryable=True) from exc
    if code != 0:
        if classify_docker_error(stderr) == "port_in_use":
            raise PortInUseError()
        raise operational_error("service_start_failed", "Compose could not start the service.", stage="start",
                                recovery="Run aira doctor, then retry setup.")


def compose_start(home, project):
    code, _, stderr = compose_run(home, project, ["start", "aira"], timeout_s=COMPOSE_START_TIMEOUT_S)
    if code != 0:
        if classify_docker_error(stderr) == "port_in_use":
            raise PortInUseError()
        raise operational_error("service_start_failed", "Existing service could not start.", stage="start",
                                recovery="Run aira doctor, then retry setup.")


def compose_stop(home, project):
    code, _, _ = compose_run(home, project, ["stop", "aira"], timeout_s=60)
    if code != 0:
        raise operational_error("service_start_failed", "Candidate could not stop.", stage="recovery",
                                recovery="Inspect the selected Compose project.")


def is_standalone_health(data):
    return (isinstance(data, dict) and data.get("status") == "ready" and
            data.get("installationMode") == "standalone" and data.get("schemaVersion") == 1)


def probe_core(core_port, deadline_s=HEALTH_VERIFY_TIMEOUT_S, mode="standalone"):
    deadline = time.monotonic() + deadline_s
    while (remaining := deadline - time.monotonic()) > 0:
        status, body, kind = http_get_json(f"http://127.0.0.1:{core_port}/health", min(remaining, 5))
        if status == 200 and isinstance(body, dict) and body.get("status") == "ready":
            if mode == "standalone" and not is_standalone_health(body):
                return "incompatible", body
            return "ready", body
        if status == 200 and kind == "bad_json":
            return "incompatible", None
        time.sleep(min(0.5, max(0, deadline - time.monotonic())))
    return "down", None


def probe_owner_standalone(site_port, token, deadline_s=HEALTH_VERIFY_TIMEOUT_S):
    url = f"http://127.0.0.1:{site_port}/owner-api/core/health"
    deadline = time.monotonic() + deadline_s
    while (remaining := deadline - time.monotonic()) > 0:
        status, body, _ = http_get_json(url, min(remaining, 5), {"X-TolongAI-Token": token})
        if status == 200:
            return is_standalone_health(body), body
        if status in (401, 403):
            return False, None
        time.sleep(min(0.5, max(0, deadline - time.monotonic())))
    return False, None


def probe_owner_legacy(site_url, token):
    status, body, _ = http_get_json(site_url.rstrip("/") + "/owner-api/core/health",
                                    headers={"X-TolongAI-Token": token})
    return status == 200 and isinstance(body, dict) and body.get("status") == "ready"
