"""Private, bounded operation events. Never copy raw child or request output."""

from __future__ import annotations

import fcntl
import json
import os
import re
import stat
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path

MAX_FILE_BYTES = 2 * 1024 * 1024
MAX_ROTATED = 4
COMPONENTS = {"setup", "cli", "core", "gateway", "update"}
LEVELS = {"debug", "info", "warn", "error"}
KEYS = ("ts", "level", "component", "operationId", "stage", "reason", "outcome",
        "attempt", "durationMs", "retryable", "image", "build", "message")
CODE = re.compile(r"^[a-zA-Z0-9_:-]{1,80}$")


def new_operation_id():
    return uuid.uuid4().hex


def log_path():
    return Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "aira" / "operations.jsonl"


def utc_now():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def _owned_file(path):
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o777 != 0o600:
        raise OSError("unsafe private log")
    return True


def _safe_code(value):
    return value if isinstance(value, str) and CODE.fullmatch(value) else "unknown"


def _event(component, operation_id, stage, reason, outcome, level, attempt, duration_ms, retryable, image, build):
    # Codes and numeric metadata are the only dynamic fields. Human text is derived from the stable reason,
    # not from child diagnostics, request bodies, secret values or arbitrary exception strings.
    code = _safe_code(reason)
    event = {
        "ts": utc_now(), "level": level if level in LEVELS else "info",
        "component": component if component in COMPONENTS else "cli",
        "operationId": _safe_code(operation_id), "stage": _safe_code(stage),
        "reason": code, "outcome": _safe_code(outcome),
        "attempt": attempt if type(attempt) is int else 1, "retryable": bool(retryable),
        "message": code.replace("_", " "),
    }
    if type(duration_ms) is int and duration_ms >= 0:
        event["durationMs"] = duration_ms
    if isinstance(image, str) and re.fullmatch(r"ghcr\.io/tolonglabs/aira:[a-zA-Z0-9._-]+", image):
        event["image"] = image
    if isinstance(build, str) and re.fullmatch(r"[0-9a-f]{7,64}", build):
        event["build"] = build
    return event


def log_event(component, operation_id, stage, reason, outcome, level="info",
              attempt=1, duration_ms=None, retryable=False, image=None, build=None, message=""):
    path = log_path()
    event = _event(component, operation_id, stage, reason, outcome, level, attempt, duration_ms, retryable, image, build)
    line = (json.dumps(event, sort_keys=True) + "\n").encode()
    # Separate lock inode: rotating the active log must not release the writer lock.
    try:
        if path.parent.resolve(strict=False) != path.parent.absolute():
            raise OSError("unsafe log path")
        path.parent.mkdir(parents=True, mode=0o700, exist_ok=True)
        info = path.parent.lstat()
        if info.st_uid != os.geteuid() or info.st_mode & 0o777 != 0o700:
            raise OSError("unsafe log directory")
        lock = path.parent / "operations.lock"
        _owned_file(lock)
        fd = os.open(lock, os.O_RDWR | os.O_CREAT | os.O_NOFOLLOW | os.O_NONBLOCK, 0o600)
        with os.fdopen(fd, "rb") as guard:
            info = os.fstat(guard.fileno())
            if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o777 != 0o600:
                raise OSError("unsafe log lock")
            deadline = time.monotonic() + 2
            while True:
                try:
                    fcntl.flock(guard.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
                    break
                except BlockingIOError:
                    if time.monotonic() >= deadline:
                        raise
                    time.sleep(0.05)
            for index in range(MAX_ROTATED + 1):
                _owned_file(path if index == 0 else path.with_name(f"{path.name}.{index}"))
            if path.exists() and path.stat().st_size + len(line) > MAX_FILE_BYTES:
                oldest = path.with_name(f"{path.name}.{MAX_ROTATED}")
                oldest.unlink(missing_ok=True)
                for index in range(MAX_ROTATED - 1, 0, -1):
                    entry = path.with_name(f"{path.name}.{index}")
                    if entry.exists():
                        entry.replace(path.with_name(f"{path.name}.{index + 1}"))
                path.replace(path.with_name(f"{path.name}.1"))
            fd = os.open(path, os.O_WRONLY | os.O_APPEND | os.O_CREAT | os.O_NOFOLLOW, 0o600)
            with os.fdopen(fd, "ab") as handle:
                handle.write(line)
                handle.flush()
                os.fsync(handle.fileno())
    except OSError:
        return None
    return str(path)


class Timer:
    def __init__(self):
        self.start = time.monotonic()

    def elapsed_ms(self):
        return int((time.monotonic() - self.start) * 1000)


def read_events(limit=50, component=None):
    path = log_path()
    events = []
    for index in range(MAX_ROTATED, -1, -1):
        entry = path if index == 0 else path.with_name(f"{path.name}.{index}")
        try:
            if not _owned_file(entry) or entry.stat().st_size > MAX_FILE_BYTES:
                continue
            fd = os.open(entry, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
            with os.fdopen(fd, encoding="utf-8") as handle:
                for line in handle:
                    try:
                        raw = json.loads(line)
                    except (ValueError, UnicodeError):
                        continue
                    if not isinstance(raw, dict) or component is not None and raw.get("component") != component:
                        continue
                    # Only events produced by the known schema are accepted. Never dump unknown raw log fields.
                    if not all(isinstance(raw.get(k), str) and CODE.fullmatch(raw[k])
                               for k in ("component", "stage", "reason", "outcome", "operationId")):
                        continue
                    safe = {k: raw[k] for k in KEYS if k in raw and k != "message"}
                    safe["message"] = raw["reason"].replace("_", " ")
                    events.append(safe)
        except (OSError, UnicodeError):
            continue
    return events[-min(max(limit, 1), 1000):]
