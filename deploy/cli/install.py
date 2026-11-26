"""Installation selection, observed state and resumable host setup."""

from __future__ import annotations

import fcntl
import json
import os
import platform
import re
import shutil
import socket
import stat
import tempfile
import time
import uuid
from dataclasses import dataclass, asdict
from pathlib import Path

from . import DEFAULT_CORE_PORT, DEFAULT_SITE_PORT, PORT_SCAN_MAX, LOCK_WAIT_TIMEOUT_S
from . import compose, hermes_versions, launcher, operations
from .result import (
    CommandError, args_error, blank_state, conflict_error, error_envelope,
    ok_envelope, operational_error, prereq_error, progress,
)

TOKEN_RE = re.compile(r"^[0-9a-f]{64}$")
PROJECT_RE = re.compile(r"^[a-z0-9][a-z0-9_-]*$")
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")


@dataclass
class Manifest:
    schemaVersion: int = 1
    installId: str = ""
    mode: str = "standalone"
    project: str = ""
    management: str = "stable"
    release: str = "stable"
    imageId: str | None = None
    sitePort: int | None = None
    corePort: int | None = None
    uid: int = 0
    gid: int = 0
    stage: str = "prepared"


def canonical(path):
    """Reject ambiguous symlink traversal instead of silently selecting its target."""
    path = Path(path).expanduser().absolute()
    if ".." in path.parts or path.resolve(strict=False) != path:
        raise conflict_error("path_unwritable", "The install path traverses a symlink or parent reference.",
                             stage="discover", recovery="Select a real absolute directory with --home.")
    return path


def locator_path():
    return Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "aira" / "cli.json"


def is_checkout_dir(path):
    return launcher.is_checkout_dir(path)


def looks_like_install(path):
    return not is_checkout_dir(path) and (
        (path / "install.json").is_file() or
        all((path / name).is_file() for name in ("compose.yml", ".env", "config.yml"))
    )


def read_owned_text(path, max_bytes=1024 * 1024, private=True):
    path = canonical(path)
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
            raise conflict_error("path_unwritable", "An install file is not an owned regular file.",
                                 recovery="Use the installation owner; do not follow symlinks.")
        if private and (info.st_mode & 0o777) not in (0o600, 0o400):
            raise conflict_error("path_unwritable", "An install file has unsafe permissions.",
                                 recovery="Restore the documented owner-only permissions.")
        data = handle.read(max_bytes + 1)
        if len(data) > max_bytes:
            raise operational_error("config_invalid", "An install file exceeds its size limit.", "discover")
        return data.decode("utf-8")


def read_locator():
    try:
        value = json.loads(read_owned_text(locator_path(), 4096))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise operational_error("config_invalid", "The CLI locator is unreadable.", "discover",
                                "Use --home to select an installation.") from exc
    if not isinstance(value, dict) or value.get("version") != 1 or not isinstance(value.get("home"), str):
        raise operational_error("config_invalid", "The CLI locator is invalid.", "discover",
                                "Use --home to select an installation.")
    return canonical(value["home"])


def write_locator(home):
    atomic_write_text(locator_path(), json.dumps({"version": 1, "home": str(home)}) + "\n")


def resolve_home(explicit=None):
    selected = explicit or os.environ.get("AIRA_HOME")
    if selected:
        return canonical(selected), "explicit"
    located = read_locator()
    default = canonical(launcher.fresh_home_default())
    fallback = canonical(launcher.fresh_home_fallback())
    plausible = {p for p in (default, fallback, located) if p is not None and looks_like_install(p)}
    if len(plausible) > 1:
        raise conflict_error("install_ambiguous", "More than one installation is plausible.",
                             stage="discover", recovery="Rerun with --home PATH.")
    if plausible:
        return next(iter(plausible)), "discovered"
    if located is not None:
        return located, "locator"
    return (fallback, "fallback") if is_checkout_dir(default) else (default, "default")


def manifest_path(home):
    return home / "install.json"


def read_manifest(home):
    try:
        raw = json.loads(read_owned_text(manifest_path(home), 8192))
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise operational_error("config_invalid", "install.json cannot be read.", "discover",
                                "Repair the saved install metadata; do not delete data.") from exc
    valid = (
        isinstance(raw, dict) and set(raw) == set(asdict(Manifest())) and raw.get("schemaVersion") == 1
        and isinstance(raw.get("installId"), str) and re.fullmatch(r"[0-9a-f]{32}", raw["installId"])
        and raw.get("mode") in ("legacy", "standalone") and raw.get("management") in ("stable", "ci")
        and isinstance(raw.get("project"), str) and PROJECT_RE.fullmatch(raw["project"])
        and isinstance(raw.get("release"), str) and re.fullmatch(r"[a-zA-Z0-9._-]+", raw["release"])
        and raw.get("stage") in ("prepared", "installed")
        and all(type(raw.get(k)) is int and raw[k] >= 0 for k in ("uid", "gid"))
        and (raw.get("imageId") is None or (isinstance(raw["imageId"], str) and DIGEST_RE.fullmatch(raw["imageId"])))
        and all(raw.get(k) is None or (type(raw[k]) is int and 1 <= raw[k] <= 65535)
                for k in ("sitePort", "corePort"))
    )
    if not valid or (raw["stage"] == "installed" and (
            not raw["imageId"] or not raw["sitePort"] or not raw["corePort"] or raw["sitePort"] == raw["corePort"])):
        raise operational_error("config_invalid", "install.json schema or state is invalid.", "discover",
                                "Repair the saved metadata without changing data or credentials.")
    return Manifest(**raw)


def write_manifest(home, manifest):
    atomic_write_text(manifest_path(home), json.dumps(asdict(manifest), indent=2, sort_keys=True) + "\n")


def check_owned(path, what="path"):
    path = canonical(path)
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if info.st_uid != os.geteuid() or stat.S_ISLNK(info.st_mode):
        raise conflict_error("path_unwritable", f"The {what} is not owned by this user.",
                             recovery="Use the installation owner and a real directory.")


def ensure_private_dir(path, mode=0o700):
    path = canonical(path)
    path.mkdir(parents=True, exist_ok=True, mode=mode)
    info = path.lstat()
    if not stat.S_ISDIR(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o777 != mode:
        raise conflict_error("path_unwritable", "A private directory is not owned or has unsafe permissions.",
                             recovery="Choose an owned directory with mode 0700.")


def fsync_dir(directory):
    fd = os.open(directory, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def atomic_write_text(path, text, mode=0o600):
    path = canonical(path)
    check_owned(path, "target")
    if path.exists() and not path.is_file():
        raise conflict_error("path_unwritable", "Refusing to replace a non-regular file.")
    path.parent.mkdir(parents=True, exist_ok=True, mode=0o700)
    check_owned(path.parent, "directory")
    fd, name = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as handle:
            os.fchmod(handle.fileno(), mode)
            handle.write(text)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(name, path)
        fsync_dir(path.parent)
    finally:
        Path(name).unlink(missing_ok=True)


class DeployLock:
    def __init__(self, home):
        self.path = home / "deploy.lock"
        self.fd = None

    def acquire(self, timeout_s=LOCK_WAIT_TIMEOUT_S):
        check_owned(self.path, "deployment lock")
        self.fd = os.open(self.path, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        try:
            info = os.fstat(self.fd)
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid():
                raise conflict_error("deploy_locked", "The deployment lock is not an owned regular file.")
            deadline = time.monotonic() + timeout_s
            while True:
                try:
                    fcntl.flock(self.fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    return
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise conflict_error("deploy_locked", "Another deploy holds the installation lock.",
                                             recovery="Wait for the current deploy, then retry.")
                    time.sleep(0.1)
        except BaseException:
            self.release()
            raise

    def release(self):
        if self.fd is not None:
            os.close(self.fd)
            self.fd = None

    def __enter__(self):
        self.acquire()
        return self

    def __exit__(self, *_):
        self.release()


def _ancestor(path):
    while not path.exists():
        path = path.parent
    return path


def _docker_check(args, code_on_failure, message):
    try:
        code, out, stderr = compose.run(args, timeout_s=10)
    except compose.RunError as exc:
        reason = {"missing": "docker_missing", "denied": "docker_permission"}.get(exc.kind, code_on_failure)
        raise prereq_error(reason, message, "Install or start Docker Engine and grant the owner Docker access.") from exc
    if code != 0:
        reason = "docker_permission" if compose.classify_docker_error(stderr) == "denied" else code_on_failure
        raise prereq_error(reason, message, "Install or start Docker Engine and grant the owner Docker access.")
    return out.strip()


def normalize_native_arch(system=None, machine=None):
    """Shared native host normalizer used by setup and doctor.

    Only Linux ``x86_64``/``amd64`` (``amd64``) and Linux ``aarch64``/``arm64``
    (``arm64``) are native; every other system or architecture returns None.
    """
    if system is None:
        system = platform.system()
    if machine is None:
        machine = platform.machine()
    if system != "Linux":
        return None
    return compose.normalize_arch(machine)


def check_native_host():
    """Return the native host architecture or refuse the host."""
    arch = normalize_native_arch()
    if arch is None:
        raise prereq_error("unsupported_platform", "AIRA supports native Linux amd64 and arm64.",
                           "Use a supported Linux host.")
    return arch


def check_native_daemon(expected_arch):
    """Refuse a daemon whose native platform disagrees with the host."""
    raw = _docker_check(["docker", "info", "--format", "{{.OSType}}/{{.Architecture}}"],
                        "docker_unreachable", "Docker daemon is unavailable.")
    ostype, sep, arch = raw.partition("/")
    daemon_arch = compose.normalize_arch(arch) if sep else None
    if not sep or ostype.strip().lower() != "linux" or daemon_arch is None or daemon_arch != expected_arch:
        raise prereq_error("unsupported_platform", "The Docker daemon must match the native host architecture.",
                           "Use the local rootful Linux Docker Engine for this host.")
    return f"linux/{daemon_arch}"


def check_native_platform():
    """Verify the local rootful native Docker authority before service operations."""
    arch = check_native_host()
    if os.geteuid() == 0:
        raise prereq_error("unsupported_platform", "Run setup as the non-root installation owner.",
                           "Use your ordinary host account with Docker access.")
    configured_host = os.environ.get("DOCKER_HOST")
    configured_context = os.environ.get("DOCKER_CONTEXT")
    if configured_host and not configured_host.startswith("unix://"):
        raise prereq_error("unsupported_platform", "Only the local rootful Docker daemon is supported.",
                           "Unset DOCKER_HOST and use the local Docker Engine.")
    version = _docker_check(["docker", "compose", "version", "--short"], "docker_missing", "Compose plugin unavailable.")
    if not re.match(r"^v?[2-9][0-9]*\.", version):
        raise prereq_error("docker_missing", "Docker Compose v2 plugin or later required.")
    # DOCKER_CONTEXT overrides DOCKER_HOST, even when that host is a local socket.
    context = ["docker", "context", "inspect", "--format", '{{(index .Endpoints "docker").Host}}']
    if configured_context:
        context.extend(["--", configured_context])
    host = _docker_check(context, "docker_unreachable", "Docker context is unavailable.") if (
        configured_context or not configured_host) else configured_host
    if not host.startswith("unix://"):
        raise prereq_error("unsupported_platform", "Only the local rootful Docker daemon is supported.",
                           "Select the local Docker Engine context.")
    security = _docker_check(["docker", "info", "--format", "{{json .SecurityOptions}}"],
                             "docker_unreachable", "Docker daemon is unavailable.")
    os_name = _docker_check(["docker", "info", "--format", "{{.OperatingSystem}}"],
                            "docker_unreachable", "Docker daemon is unavailable.")
    try:
        security_options = json.loads(security)
    except ValueError:
        security_options = None
    if (not isinstance(security_options, list) or not all(isinstance(value, str) for value in security_options)
            or any("rootless" in value.lower() for value in security_options)
            or not os_name or "desktop" in os_name.lower()):
        raise prereq_error("unsupported_platform", "Only rootful Linux Docker Engine is supported.",
                           "Use the local rootful Docker Engine on a supported Linux host.")
    return check_native_daemon(arch)


def verify_native_image(ref):
    """Refuse an unknown or non-native image before any service change."""
    arch = normalize_native_arch()
    platform_name = compose.image_platform(ref)
    if arch is None or platform_name is None or platform_name != f"linux/{arch}":
        raise operational_error("image_incompatible", "The image is not a compatible native release.",
                                "compatibility", "Use a compatible release image.")
    return platform_name


def preflight(home):
    check_native_platform()
    ancestor = _ancestor(home)
    if shutil.disk_usage(ancestor).free < 2 * 1024 ** 3:
        raise prereq_error("disk_full", "At least 2 GiB of host space is needed.", "Free disk space and retry.")
    if not os.access(ancestor, os.W_OK | os.X_OK):
        raise prereq_error("path_unwritable", "The installation path is not writable.", "Choose another --home.")
    check_owned(home, "installation")
    return [{"name": name, "ok": True} for name in ("platform", "docker", "disk", "paths")]


def read_owner_token(path, standalone=True):
    try:
        token = read_owned_text(path, 8192).strip()
    except (OSError, ValueError, CommandError) as exc:
        raise operational_error("owner_auth_failed", "The owner credential is unavailable.", "verify",
                                "Check the owned credential file and its permissions; never rotate it implicitly.") from exc
    if not token or (standalone and not TOKEN_RE.fullmatch(token)) or "\n" in token or "\r" in token:
        raise operational_error("owner_auth_failed", "The owner credential is invalid.", "verify",
                                "Restore the verified owner credential from backup.")
    return token


def legacy_token_file():
    return Path.home() / ".hermes" / "brain" / ".site-token"


def detect_hermes():
    # Presence is separate from compatibility and connection. P6 adds verified adapter status.
    if shutil.which("hermes") or (Path.home() / ".hermes").is_dir():
        return "detected", "Hermes detected; attachment has not been verified."
    return "not_detected", "Hermes is not installed or detected."


def check_persistence(home=None, project=None):
    try:
        code, out, _ = compose.run(["systemctl", "is-enabled", "docker.service"], timeout_s=5)
        if code == 0 and out.strip() == "enabled":
            if home is not None and project is not None and compose.restart_policy(home, project) != "unless-stopped":
                return "degraded", "The observed container lacks restart: unless-stopped."
            return "verified", ""
    except compose.RunError:
        return "unknown", "Docker boot enablement cannot be checked."
    return "degraded", "Docker is not enabled at boot. Ask the administrator to enable docker.service."


def url_for(binding, path=""):
    host, port = binding
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    if ":" in host:
        host = "[" + host + "]"
    return f"http://{host}:{port}{path}"


def _mode(home, manifest):
    if manifest:
        return manifest.mode
    known = compose.parse_env_file(home / ".env")
    if known.get("AIRA_INSTALL_MODE") == "standalone":
        raise conflict_error("config_invalid", "Standalone files exist without their manifest.",
                             recovery="Restore the install metadata from backup; do not adopt as legacy.")
    return "legacy"


def _project(home, manifest):
    name = compose.detect_project(home)
    if manifest and name and name != manifest.project:
        raise conflict_error("install_ambiguous", "The observed Compose project differs from the manifest.",
                             recovery="Inspect the existing project; no automatic rerouting.")
    return manifest.project if manifest else name


def _dashboard(bindings):
    if 9890 not in bindings:
        return None
    host, port = bindings[9890]
    if host in ("0.0.0.0", "::"):
        host = "127.0.0.1"
    target = f"[{host}]" if ":" in host else host
    return {
        "url": url_for(bindings[9890], "/overview"), "port": port, "sitePort": port,
        "corePort": bindings.get(9881, (None, None))[1],
        "forwarding": f"ssh -N -L 127.0.0.1:9890:{target}:{port} <user>@<host>",
    }


def _owner_ready(home, mode, bindings, timeout=5):
    if 9890 not in bindings:
        return False
    if mode == "standalone":
        token = read_owner_token(home / "data" / "standalone" / "owner.token")
        ok, _ = compose.probe_owner_standalone(bindings[9890][1], token, deadline_s=timeout)
        return ok
    token = read_owner_token(legacy_token_file(), standalone=False)
    return compose.probe_owner_legacy(url_for(bindings[9890]), token)


def observe(home, manifest, quick=True):
    state = blank_state()
    checks, warnings = [], []
    state["hermes"], hermes_reason = detect_hermes()
    if not looks_like_install(home):
        return dict(state=state, checks=checks, warnings=[hermes_reason], dashboard=None, manifest=None)
    mode = _mode(home, manifest)
    state["installation"] = "repair_required" if manifest and manifest.stage == "prepared" else "installed"
    state["configuration"] = None
    state["chatbot"] = "inactive"
    project = None
    bindings = {}
    image = None
    route = None
    chatbot_reason = None
    try:
        project = _project(home, manifest)
        if project:
            entries = compose.ps_entries(home, project)
            bindings = compose.published_bindings(home, project)
            image = compose.container_image_id(home, project)
            if compose.service_running(entries):
                state["service"] = "unhealthy"
                if mode == "standalone" and any(b[0] != "127.0.0.1" for b in bindings.values()):
                    warnings.append("Standalone ports are not private loopback bindings.")
                elif 9881 in bindings and 9890 in bindings:
                    status, body, _ = compose.http_get_json(url_for(bindings[9881], "/health"), timeout_s=3)
                    valid = status == 200 and isinstance(body, dict) and body.get("status") == "ready"
                    if valid and (mode != "standalone" or compose.is_standalone_health(body)):
                        owner_body = None
                        if mode == "standalone":
                            token = read_owner_token(home / "data" / "standalone" / "owner.token")
                            owner_ok, owner_body = compose.probe_owner_standalone(bindings[9890][1], token, deadline_s=5)
                        else:
                            owner_ok = _owner_ready(home, mode, bindings)
                        if owner_ok:
                            state["service"] = "running"
                            health = owner_body if isinstance(owner_body, dict) else body
                            state["configuration"] = health.get("configuration", "configured" if mode == "legacy" else None)
                            state["chatbot"] = health.get("chatbot", "ready" if mode == "legacy" else "inactive")
                            if mode == "standalone":
                                maybe_route = health.get("hermes") or {}
                                if (isinstance(maybe_route, dict) and maybe_route.get("state") == "connected" and
                                        maybe_route.get("adapterVersion") in hermes_versions.ADAPTER_VERSIONS and
                                        isinstance(maybe_route.get("profile"), str) and re.fullmatch(r"[a-z0-9][a-z0-9_-]{0,63}", maybe_route["profile"])):
                                    state["hermes"] = "connected"
                                    route = {k: maybe_route.get(k) for k in ("state", "profile", "adapterVersion", "verifiedAt")}
                                elif isinstance(maybe_route, dict) and maybe_route.get("state") == "connected":
                                    state["hermes"] = ("unsupported" if maybe_route.get("adapterVersion") not in
                                                        hermes_versions.ADAPTER_VERSIONS else "disconnected")
                                    state["chatbot"] = "inactive"
                                    warnings.append("The Hermes route is unverified; run aira doctor.")
                                elif isinstance(maybe_route, dict) and maybe_route.get("state") in ("invalid", "unsupported"):
                                    state["hermes"] = "unsupported" if maybe_route["state"] == "unsupported" else "disconnected"
                                    state["chatbot"] = "inactive"
                                    warnings.append("The Hermes route receipt is " + maybe_route["state"] + "; run aira doctor.")
                                elif state["hermes"] == "detected":
                                    state["hermes"] = "disconnected"
                                reason = health.get("chatbotReason")
                                if reason in ("hermes_disconnected", "model_setup_required", "model_config_invalid", "pending_activation"):
                                    chatbot_reason = reason
                        else:
                            warnings.append("The authenticated owner health check failed.")
                else:
                    warnings.append("Actual Compose port mappings are unavailable.")
            else:
                state["service"] = "stopped"
        else:
            warnings.append("No observed Compose project.")
    except compose.RunError:
        state["service"] = "unhealthy"
        warnings.append("Docker state is unavailable.")
    except CommandError as exc:
        # Authentication and state faults are visible; no credential or raw subprocess output.
        state["service"] = "unhealthy"
        warnings.append(exc.code + ": " + exc.message)
    state["persistence"], persist_reason = check_persistence(home, project)
    if persist_reason:
        warnings.append(persist_reason)
    if state["configuration"] is None:
        warnings.append("Runtime configuration is unknown while the core is unavailable.")
    checks.append({"name": "service", "ok": state["service"] in ("running", "stopped")})
    if manifest and manifest.stage == "installed" and bindings and (
        bindings.get(9881, (None, None))[1] != manifest.corePort or
        bindings.get(9890, (None, None))[1] != manifest.sitePort or
        (mode == "standalone" and image is not None and image != manifest.imageId)
    ):
        state["installation"] = "repair_required"
        warnings.append("Observed ports or image differ from the committed manifest.")
    management = manifest.management if manifest else None
    release = manifest.release if manifest else None
    if manifest is None:
        known = compose.parse_env_file(home / ".env")
        try:
            management, release = management_for_ref(_ref_from_env(known))
        except CommandError:
            warnings.append("The configured image reference could not be validated.")
    return dict(state=state, checks=checks, warnings=warnings, dashboard=_dashboard(bindings),
                manifest=manifest, project=project, mode=mode, bindings=bindings, imageId=image,
                management=management, release=release, hermesRoute=route, chatbotReason=chatbot_reason)


def port_free(port):
    try:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
            sock.bind(("127.0.0.1", port))
        return True
    except OSError:
        return False


def _scan(exclude, preferred, attempted=()):
    for port in range(preferred, PORT_SCAN_MAX + 1):
        if port != exclude and port not in attempted and port_free(port):
            return port
    raise conflict_error("port_exhausted", "No automatic port remains in the supported range.",
                         recovery="Free a port or pass an explicit port.")


def pick_ports(explicit_site, explicit_core, attempted=()):
    for port in (explicit_site, explicit_core):
        if port is not None and not 1 <= port <= 65535:
            raise args_error("A port must be between 1 and 65535.")
        if port is not None and not port_free(port):
            raise conflict_error("port_conflict", "An explicit port is occupied.",
                                 recovery="Free that port or select a different one.")
    if explicit_site is not None and explicit_site == explicit_core:
        raise conflict_error("port_conflict", "The gateway and dashboard ports must differ.")
    site = explicit_site if explicit_site is not None else _scan(explicit_core, DEFAULT_SITE_PORT, attempted)
    core = explicit_core if explicit_core is not None else _scan(site, DEFAULT_CORE_PORT, attempted)
    return site, core


def stage_config_template(template_text, data_dir_abs):
    value = "'" + data_dir_abs.replace("'", "''") + "'"
    if "\n" in value or "\r" in value or "\0" in value:
        raise conflict_error("config_invalid", "The data path contains unsupported characters.")
    result, count = re.subn(r"(?m)^  hostDataDir: ''[^\n]*$", lambda _: "  hostDataDir: " + value, template_text)
    if count != 1:
        raise operational_error("config_invalid", "The release template has no unique hostDataDir placeholder.", "prepare")
    return result


def stage_env(values):
    def quoted(value):
        text = str(value)
        if any(ch in text for ch in ("\n", "\r", "\0")):
            raise conflict_error("config_invalid", "An install value contains an invalid character.")
        return "'" + text.replace("'", "\\'") + "'"
    return "".join(f"{key}={quoted(value)}\n" for key, value in values.items())


def management_for_ref(ref):
    _, tag = compose.split_image_ref(ref)
    return ("ci" if re.fullmatch(r"(?:sha|rollback)-[0-9a-f]+", tag) else "stable", tag)


def _ref_from_env(known):
    return f"{known.get('AIRA_IMAGE', 'ghcr.io/tolonglabs/aira')}:{known.get('AIRA_VERSION', 'stable')}"


def _runtime(opts, warnings):
    if opts.repo_root and is_checkout_dir(Path(opts.repo_root)):
        _, _, notes = launcher.install_runtime(opts.repo_root)
        warnings.extend(note for note in notes if note not in warnings)


def _fresh_values(home, image_ref, site, core):
    repo, tag = compose.split_image_ref(image_ref)
    return {
        "AIRA_INSTALL_MODE": "standalone", "AIRA_DASHBOARD_ENTRY": "dashboard",
        "AIRA_IMAGE": repo, "AIRA_VERSION": tag, "AIRA_PORT": core,
        "AIRA_SITE_PORT": site, "AIRA_SITE_BIND": "127.0.0.1",
        "AIRA_DATA_DIR": str(home / "data"), "AIRA_UID": os.geteuid(), "AIRA_GID": os.getegid(),
    }


def _verify(home, manifest, mode, project, checks, warnings, timeout=60):
    bindings = compose.published_bindings(home, project)
    image = compose.container_image_id(home, project)
    if set(bindings) != {9881, 9890} or not image:
        raise operational_error("health_timeout", "Actual service mapping or image ID is missing.", "verify",
                                "Inspect the chosen Compose project and rerun setup.")
    if mode == "standalone" and any(b[0] != "127.0.0.1" for b in bindings.values()):
        raise conflict_error("port_conflict", "The standalone service is not bound privately.")
    if manifest and manifest.stage == "installed" and (
        bindings[9881][1] != manifest.corePort or bindings[9890][1] != manifest.sitePort
    ):
        raise conflict_error("port_conflict", "Existing published ports differ from the manifest.",
                             recovery="Repair the mapping explicitly; the CLI will not move it.")
    result, health = compose.probe_core(bindings[9881][1], deadline_s=timeout, mode=mode)
    if result != "ready":
        code = "image_incompatible" if result == "incompatible" else "health_timeout"
        raise operational_error(code, "The service did not return compatible health.", "verify",
                                "Use a compatible release or run aira doctor.")
    if not _owner_ready(home, mode, bindings, timeout=min(timeout, 30)):
        raise operational_error("owner_auth_failed", "Authenticated owner health failed.", "verify",
                                "Verify the selected authority and credential.")
    page_status, page, _ = compose.http_request(url_for(bindings[9890], "/overview"), timeout_s=5)
    if page_status != 200 or b"<" not in page[:1024]:
        raise operational_error("health_timeout", "The dashboard document is unavailable.", "verify",
                                "Check the installed dashboard entry and image.")
    checks.extend({"name": name, "ok": True} for name in ("mapping", "core_health", "owner_health", "dashboard"))
    return bindings, image, health


def _commit(home, manifest, verified, checks, warnings, opts, operation_id):
    bindings, image, health = verified
    manifest.imageId, manifest.corePort, manifest.sitePort = image, bindings[9881][1], bindings[9890][1]
    manifest.stage = "installed"
    write_manifest(home, manifest)
    write_locator(home)
    _runtime(opts, warnings)
    persistence, reason = check_persistence(home, manifest.project)
    state = {
        "installation": "installed", "service": "running", "persistence": persistence,
        "configuration": health.get("configuration", "configured" if manifest.mode == "legacy" else None),
        "hermes": detect_hermes()[0], "chatbot": health.get("chatbot", "ready" if manifest.mode == "legacy" else "inactive"),
    }
    dashboard = _dashboard(bindings)
    if persistence != "verified":
        warnings.append(reason)
        err = operational_error("persistence_degraded", "The service is running, but boot persistence is unverified.",
                                "persistence", "Ask the administrator to enable docker.service, then run aira setup.")
        result = error_envelope("setup", operation_id, err, state, checks, warnings, dashboard)
    else:
        result = ok_envelope("setup", operation_id, state, checks, warnings, dashboard)
    result.update(imageId=image, installationMode=manifest.mode, management=manifest.management, release=manifest.release)
    return result


def _fresh(home, manifest, opts, checks, warnings, operation_id):
    known = compose.parse_env_file(home / ".env")
    image = opts.image or (_ref_from_env(known) if known else compose.default_image_ref())
    management, release = management_for_ref(image)
    if manifest is None:
        # UUID project names cannot collide with an unrelated checkout or basename.
        manifest = Manifest(installId=uuid.uuid4().hex, project="aira-" + uuid.uuid4().hex[:16],
                            management=management, release=release, uid=os.geteuid(), gid=os.getegid())
        write_manifest(home, manifest)
    if manifest.mode != "standalone" or manifest.uid != os.geteuid() or manifest.gid != os.getegid():
        raise conflict_error("config_invalid", "The prepared manifest belongs to another installation identity.")
    existing_project = compose.detect_project(home) if (home / "compose.yml").exists() else None
    if existing_project and existing_project != manifest.project:
        raise conflict_error("install_ambiguous", "The prepared project differs from the observed project.")
    if existing_project and compose.service_running(compose.ps_entries(home, manifest.project)):
        # A crash after a successful Compose start: verify, not pull or recreate.
        return _commit(home, manifest, _verify(home, manifest, "standalone", manifest.project, checks, warnings),
                       checks, warnings, opts, operation_id)
    # Do not silently move a staged port on resume, but accept an explicit pre-commit repair override.
    explicit_site = opts.site_port if opts.site_port is not None else int(known["AIRA_SITE_PORT"]) if known.get("AIRA_SITE_PORT") else None
    explicit_core = opts.core_port if opts.core_port is not None else int(known["AIRA_PORT"]) if known.get("AIRA_PORT") else None
    site, core = pick_ports(explicit_site, explicit_core)
    _runtime(opts, warnings)
    template, config = launcher.template_sources(opts.repo_root)
    if not template or not config:
        raise operational_error("config_invalid", "The release templates are unavailable.", "prepare")
    ensure_private_dir(home / "data")
    if not (home / "compose.yml").exists():
        atomic_write_text(home / "compose.yml", template.read_text())
    if not (home / "config.yml").exists():
        atomic_write_text(home / "config.yml", stage_config_template(config.read_text(), str(home / "data")))
    manifest.management, manifest.release = management, release
    write_manifest(home, manifest)
    values = _fresh_values(home, image, site, core)
    atomic_write_text(home / ".env", stage_env(values))
    operations.log_event("setup", operation_id, "prepare", "prepared", "ok")
    if not ((opts.image or known) and compose.local_image_present(image)):
        progress("Pulling the compatible release image.")
        compose.pull_image(image)
    verify_native_image(image)
    attempted = set()
    for attempt in range(3):
        try:
            compose.compose_up(home, manifest.project)
            break
        except compose.PortInUseError:
            operations.log_event("setup", operation_id, "start", "port_conflict", "error", attempt=attempt + 1)
            if attempt == 2 or (explicit_site is not None and explicit_core is not None):
                raise conflict_error("port_conflict", "A concurrent listener took a selected port.",
                                     recovery="Free the port or specify a fresh pre-commit port.")
            attempted.update((site, core))
            site, core = pick_ports(explicit_site, explicit_core, attempted)
            atomic_write_text(home / ".env", stage_env(_fresh_values(home, image, site, core)))
    try:
        verified = _verify(home, manifest, "standalone", manifest.project, checks, warnings)
        if verified[0][9881][1] != core or verified[0][9890][1] != site:
            raise conflict_error("port_conflict", "Docker bound different ports from the staged mapping.")
    except CommandError:
        # This is the uncommitted candidate only. Keep files and data for repair.
        compose.compose_stop(home, manifest.project)
        raise
    return _commit(home, manifest, verified, checks, warnings, opts, operation_id)


def _existing(home, manifest, opts, checks, warnings, operation_id):
    mode = _mode(home, manifest)
    project = _project(home, manifest)
    if not project:
        raise conflict_error("repair_required", "No existing Compose project was found.",
                             recovery="Inspect the installation; no automatic project replacement.")
    entries = compose.ps_entries(home, project)
    bindings = compose.published_bindings(home, project)
    for flag, target in ((opts.site_port, 9890), (opts.core_port, 9881)):
        if flag is not None and (target not in bindings or bindings[target][1] != flag):
            raise conflict_error("port_conflict", "Existing ports cannot be changed by repeated setup.")
    if opts.image is not None:
        raise conflict_error("config_invalid", "Use aira update to change an installed image.")
    was_running = compose.service_running(entries)
    if not was_running:
        if not entries:
            raise operational_error("service_start_failed", "The existing container is absent.", "start",
                                    "Repair the existing installation without replacing its configuration.")
        try:
            compose.compose_start(home, project)
        except compose.PortInUseError as exc:
            raise conflict_error("port_conflict", "An existing published port is occupied.") from exc
    verified = _verify(home, manifest, mode, project, checks, warnings, timeout=15 if was_running else 60)
    if manifest and mode == "standalone" and verified[1] != manifest.imageId:
        raise conflict_error("repair_required", "The running image differs from the committed install.",
                             recovery="Use aira update to recover an interrupted update; do not adopt a new image implicitly.")
    if not manifest:
        management, release = management_for_ref(_ref_from_env(compose.parse_env_file(home / ".env")))
        manifest = Manifest(installId=uuid.uuid4().hex, mode=mode, project=project,
                            management=management, release=release, uid=os.geteuid(), gid=os.getegid())
        warnings.append("Legacy installation adopted without changing its deployment inputs.")
    return _commit(home, manifest, verified, checks, warnings, opts, operation_id)


def run_setup(opts):
    op = operations.new_operation_id()
    timer = operations.Timer()
    home = manifest = None
    checks, warnings = [], []
    stage = "discover"
    try:
        home, _ = resolve_home(opts.home)
        if is_checkout_dir(home):
            raise conflict_error("install_ambiguous", "Refusing to overwrite a source checkout.",
                                 recovery="Select a separate installation directory with --home.")
        if home.exists() and not looks_like_install(home) and any(p.name != "deploy.lock" for p in home.iterdir()):
            raise conflict_error("install_ambiguous", "The selected directory contains unrelated files.",
                                 recovery="Choose a new empty installation directory.")
        stage = "preflight"
        checks.extend(preflight(home))
        if not home.exists():
            ensure_private_dir(home)
        elif not looks_like_install(home):
            ensure_private_dir(home)
        else:
            check_owned(home, "installation")
        stage = "plan"
        with DeployLock(home):
            manifest = read_manifest(home)
            if manifest and manifest.mode == "standalone" and os.path.lexists(home / "update.json"):
                raise conflict_error("repair_required", "An unfinished update needs recovery.",
                                     recovery="Run aira update; it recovers the prior pinned image before starting another candidate.")
            if manifest and manifest.stage == "prepared":
                result = _fresh(home, manifest, opts, checks, warnings, op)
            elif looks_like_install(home):
                for name in ("compose.yml", ".env", "config.yml"):
                    check_owned(home / name, "deployment file")
                    if not (home / name).is_file():
                        raise conflict_error("config_invalid", "An existing deployment input is missing.")
                result = _existing(home, manifest, opts, checks, warnings, op)
            else:
                result = _fresh(home, None, opts, checks, warnings, op)
    except KeyboardInterrupt:
        err = operational_error("operation_interrupted", "Setup was interrupted.", stage, "Run aira setup to resume.")
        result = _failed_setup(home, err, op, checks, warnings)
    except CommandError as err:
        result = _failed_setup(home, err, op, checks, warnings)
    except compose.RunError:
        err = operational_error("docker_unreachable", "Docker state could not be verified.", stage,
                                "Run aira doctor and retry setup.")
        result = _failed_setup(home, err, op, checks, warnings)
    except (OSError, ValueError, RuntimeError):
        err = operational_error("path_unwritable", "Setup could not read or write a required owned file.", stage,
                                "Check permissions and disk space, then retry setup.")
        result = _failed_setup(home, err, op, checks, warnings)
    operations.log_event("setup", op, result.get("error", {}).get("stage", "commit"),
                         result.get("error", {}).get("code", "installed"), result["outcome"],
                         duration_ms=timer.elapsed_ms())
    return result, op


def _failed_setup(home, err, op, checks, warnings):
    state = blank_state()
    dashboard = None
    if home is not None and looks_like_install(home):
        try:
            manifest = read_manifest(home)
            state["installation"] = "repair_required" if manifest and manifest.stage == "prepared" else "installed"
            if err.stage not in ("preflight", "discover", "plan"):
                report = observe(home, manifest)
                state, dashboard = report["state"], report["dashboard"]
        except (CommandError, OSError, compose.RunError):
            state["installation"] = "repair_required"
    return error_envelope("setup", op, err, state, checks, warnings, dashboard)
