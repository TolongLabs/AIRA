"""Coherent private deploy backups for standalone installs.

Implements the standalone deploy backup in `docs/trd/storage.md`
(`#standalone-deploy-backup`) with the Python standard library only.

The caller holds the install `DeployLock` and has gracefully stopped the
sole writer before `create_backup`, so the source database is quiescent
while SQLite's online-backup protocol reads it.

Layout: `<data>/deploy-recovery/<operationId>/` holds `aira.db`, the
complete `standalone/`, `characters/`, `files/` and `archive/` trees when
present, and a version-1 `inventory.json` of relative paths with SHA-256,
size, mode and owner. Disposable `cache/`, earlier `snapshots/` and
`deploy-recovery` itself are never carried.

Every failure raises `result.CommandError` with a fixed safe message. No
path, hash, credential or file content ever enters a message or a log.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import sqlite3
import stat
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path

from .result import args_error, conflict_error, operational_error

__all__ = [
    "BackupInventory",
    "InventoryEntry",
    "create_backup",
    "restore_backup",
    "verify_backup",
]

INVENTORY_VERSION = 1
INVENTORY_NAME = "inventory.json"
DATABASE_NAME = "aira.db"
RECOVERY_DIR_NAME = "deploy-recovery"
INCLUDED_TREES = ("standalone", "characters", "files", "archive")
OP_ID_RE = re.compile(r"[0-9a-f]{32}")
SHA_RE = re.compile(r"[0-9a-f]{64}")
MAX_INVENTORY_BYTES = 64 * 1024 * 1024
MAX_PATH_LEN = 1024
MAX_TREE_DEPTH = 128
_CHUNK = 1024 * 1024


@dataclass(frozen=True)
class InventoryEntry:
    """One typed inventory row: a relative path with its content identity."""

    path: str
    kind: str  # "file" or "dir"
    size: int
    mode: int
    uid: int
    sha256: str = ""

    @property
    def type(self) -> str:
        return self.kind


@dataclass(frozen=True)
class BackupInventory:
    """The typed form of a version-1 `inventory.json`."""

    version: int
    operation_id: str
    entries: tuple

    @property
    def operationId(self) -> str:
        return self.operation_id

    @property
    def files(self) -> tuple:
        return self.entries


class _Unsafe(Exception):
    """Internal: an entry the backup must not carry. Carries no payload."""


class _Mismatch(Exception):
    """Internal: inventory and disk disagree. Carries no payload."""


@dataclass
class _Record:
    kind: str
    size: int
    mode: int
    uid: int
    sha256: str = ""


def _euid() -> int:
    return os.geteuid()


def _check_operation_id(value: str) -> str:
    if not isinstance(value, str) or not OP_ID_RE.fullmatch(value):
        raise args_error("The backup operation ID is invalid.",
                         "Generate one with operations.new_operation_id; backups are never overwritten.")
    return value


def _clean_absolute(value) -> Path:
    try:
        result = Path(value).expanduser().absolute()
    except (OSError, ValueError, RuntimeError):
        raise args_error("A backup path is invalid.", "Use a real absolute directory path.")
    if Path(os.path.realpath(result)) != result:
        raise conflict_error("path_unwritable", "A backup path traverses a symlink or parent reference.",
                             stage="backup", recovery="Select a real absolute directory.")
    return result


def _lstat(path: Path) -> os.stat_result:
    try:
        return os.lstat(path)
    except FileNotFoundError:
        raise _Mismatch()
    except OSError:
        raise _Unsafe()


def _fsync_dir(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _fsync_file(path: Path) -> None:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        os.fsync(fd)
    finally:
        os.close(fd)


def _hash_file(path: Path) -> tuple:
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != _euid():
            raise _Unsafe()
        digest = hashlib.sha256()
        size = 0
        while True:
            chunk = os.read(fd, _CHUNK)
            if not chunk:
                break
            digest.update(chunk)
            size += len(chunk)
        return digest.hexdigest(), size
    finally:
        os.close(fd)


def _scan_tree(full: Path, rel: str, records: dict, strict: bool, depth: int) -> None:
    if depth > MAX_TREE_DEPTH:
        raise _Unsafe()
    info = _lstat(full)
    if stat.S_ISLNK(info.st_mode) or info.st_uid != _euid() or not stat.S_ISDIR(info.st_mode):
        raise _Unsafe()
    mode = stat.S_IMODE(info.st_mode)
    if strict and mode != 0o700:
        raise _Unsafe()
    if rel in records:
        raise _Mismatch()
    records[rel] = _Record("dir", 0, mode, info.st_uid)
    with os.scandir(full) as handle:
        children = sorted(entry.name for entry in handle)
    for child in children:
        child_rel = rel + "/" + child
        if len(child_rel) > MAX_PATH_LEN:
            raise _Unsafe()
        child_full = full / child
        info = _lstat(child_full)
        if stat.S_ISLNK(info.st_mode) or info.st_uid != _euid():
            raise _Unsafe()
        mode = stat.S_IMODE(info.st_mode)
        if stat.S_ISDIR(info.st_mode):
            _scan_tree(child_full, child_rel, records, strict, depth + 1)
        elif stat.S_ISREG(info.st_mode):
            if strict and mode != 0o600:
                raise _Unsafe()
            sha, size = _hash_file(child_full)
            if child_rel in records:
                raise _Mismatch()
            records[child_rel] = _Record("file", size, mode, info.st_uid, sha)
        else:
            raise _Unsafe()


def _scan_root(root: Path, live: bool, extra_top: frozenset = frozenset()) -> dict:
    """Walk the covered namespace: `aira.db` plus the included trees."""
    records: dict[str, _Record] = {}
    try:
        with os.scandir(root) as handle:
            names = sorted(entry.name for entry in handle)
    except OSError:
        raise _Unsafe()
    for name in names:
        if name in extra_top:
            continue
        if name not in (DATABASE_NAME, *INCLUDED_TREES):
            if live:
                continue
            raise _Mismatch()
        full = root / name
        if name == DATABASE_NAME:
            info = _lstat(full)
            if stat.S_ISLNK(info.st_mode) or info.st_uid != _euid() or not stat.S_ISREG(info.st_mode):
                raise _Unsafe()
            sha, size = _hash_file(full)
            records[name] = _Record("file", size, stat.S_IMODE(info.st_mode), info.st_uid, sha)
        else:
            _scan_tree(full, name, records, name == "standalone", 0)
    return records


def _copy_database(src: Path, dest: Path) -> _Record:
    info = _lstat(src)
    if stat.S_ISLNK(info.st_mode) or info.st_uid != _euid() or not stat.S_ISREG(info.st_mode):
        raise _Unsafe()
    fd = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
    os.close(fd)
    try:
        source = sqlite3.connect(src.absolute().as_uri() + "?mode=ro", uri=True, timeout=30)
    except sqlite3.Error:
        raise _Unsafe()
    try:
        try:
            target = sqlite3.connect(os.fspath(dest), timeout=30)
        except sqlite3.Error:
            raise _Unsafe()
        try:
            try:
                deadline = time.monotonic() + 300
                def check_deadline(_status, _remaining, _total):
                    if time.monotonic() > deadline:
                        raise _Mismatch()
                source.backup(target, pages=512, progress=check_deadline, sleep=0.05)
                # The source may be WAL. Publish one self-contained file; a later
                # read-only integrity check must not create untracked sidecars.
                if target.execute("PRAGMA journal_mode=DELETE").fetchone() != ("delete",):
                    raise _Mismatch()
                rows = target.execute("PRAGMA integrity_check").fetchall()
            except sqlite3.Error:
                raise _Mismatch()
            if rows != [("ok",)]:
                raise _Mismatch()
        finally:
            target.close()
    finally:
        source.close()
    os.chmod(dest, 0o600)
    sha, size = _hash_file(dest)
    _fsync_file(dest)
    return _Record("file", size, 0o600, _euid(), sha)


def _copy_file(src: Path, dest: Path, record: _Record) -> None:
    fd_in = os.open(src, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    try:
        info = os.fstat(fd_in)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != _euid() or info.st_size != record.size:
            raise _Mismatch()
        fd_out = os.open(dest, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW | os.O_CLOEXEC, 0o600)
        try:
            while True:
                chunk = os.read(fd_in, _CHUNK)
                if not chunk:
                    break
                view = memoryview(chunk)
                while view:
                    written = os.write(fd_out, view)
                    view = view[written:]
            os.fchmod(fd_out, record.mode)
            os.fsync(fd_out)
        finally:
            os.close(fd_out)
    finally:
        os.close(fd_in)


def _integrity_check(db: Path) -> None:
    info = _lstat(db)
    if stat.S_ISLNK(info.st_mode) or info.st_uid != _euid() or not stat.S_ISREG(info.st_mode):
        raise _Mismatch()
    try:
        connection = sqlite3.connect(db.absolute().as_uri() + "?mode=ro&immutable=1", uri=True, timeout=30)
    except sqlite3.Error:
        raise _Mismatch()
    try:
        try:
            rows = connection.execute("PRAGMA integrity_check").fetchall()
        except sqlite3.Error:
            raise _Mismatch()
    finally:
        connection.close()
    if rows != [("ok",)]:
        raise _Mismatch()


def _inventory_doc(operation_id: str, records: dict) -> bytes:
    items = []
    for rel in sorted(records):
        record = records[rel]
        item = {"kind": record.kind, "mode": record.mode, "path": rel, "size": record.size, "uid": record.uid}
        if record.kind == "file":
            item["sha256"] = record.sha256
        items.append(item)
    doc = {"entries": items, "operationId": operation_id, "version": INVENTORY_VERSION}
    return (json.dumps(doc, indent=2, sort_keys=True) + "\n").encode("utf-8")


def _write_inventory(staging: Path, payload: bytes) -> None:
    fd, tmp = tempfile.mkstemp(dir=staging, prefix=".inventory.", suffix=".partial")
    try:
        with os.fdopen(fd, "wb") as handle:
            os.fchmod(handle.fileno(), 0o600)
            handle.write(payload)
            handle.flush()
            os.fsync(handle.fileno())
        os.chmod(tmp, 0o600)
        os.replace(tmp, staging / INVENTORY_NAME)
        _fsync_dir(staging)
    finally:
        try:
            os.unlink(tmp)
        except OSError:
            pass


def _check_entry_shape(item: dict) -> InventoryEntry:
    kind = item.get("kind")
    if kind == "file":
        keys = {"kind", "mode", "path", "sha256", "size", "uid"}
    elif kind == "dir":
        keys = {"kind", "mode", "path", "size", "uid"}
    else:
        raise _Mismatch()
    if set(item) != keys:
        raise _Mismatch()
    path = item["path"]
    if not isinstance(path, str) or not 1 <= len(path) <= MAX_PATH_LEN or "\\" in path or path.startswith("/"):
        raise _Mismatch()
    parts = path.split("/")
    if any(not part or part in (".", "..") for part in parts):
        raise _Mismatch()
    if parts[0] == DATABASE_NAME:
        if len(parts) != 1:
            raise _Mismatch()
    elif parts[0] not in INCLUDED_TREES:
        raise _Mismatch()
    for key in ("size", "mode", "uid"):
        if type(item[key]) is not int or item[key] < 0:
            raise _Mismatch()
    if item["mode"] > 0o7777:
        raise _Mismatch()
    if kind == "dir":
        if item["size"] != 0:
            raise _Mismatch()
        return InventoryEntry(kind="dir", mode=item["mode"], path=path, size=0, uid=item["uid"])
    if item["size"] < 0 or not isinstance(item["sha256"], str) or not SHA_RE.fullmatch(item["sha256"]):
        raise _Mismatch()
    return InventoryEntry(kind="file", mode=item["mode"], path=path,
                          sha256=item["sha256"], size=item["size"], uid=item["uid"])


def _parse_inventory(raw: object) -> BackupInventory:
    if not isinstance(raw, dict) or set(raw) != {"entries", "operationId", "version"}:
        raise _Mismatch()
    if type(raw["version"]) is not int or raw["version"] != INVENTORY_VERSION:
        raise _Mismatch()
    if not isinstance(raw["operationId"], str) or not OP_ID_RE.fullmatch(raw["operationId"]):
        raise _Mismatch()
    if not isinstance(raw["entries"], list) or not raw["entries"]:
        raise _Mismatch()
    entries = []
    seen = set()
    for item in raw["entries"]:
        if not isinstance(item, dict):
            raise _Mismatch()
        entry = _check_entry_shape(item)
        if entry.path in seen:
            raise _Mismatch()
        seen.add(entry.path)
        entries.append(entry)
    if not {DATABASE_NAME, "standalone", "standalone/owner.token", "standalone/gateway.token"}.issubset(seen):
        raise _Mismatch()
    by_path = {entry.path: entry for entry in entries}
    if by_path[DATABASE_NAME].kind != "file":
        raise _Mismatch()
    return BackupInventory(entries=tuple(entries), operation_id=raw["operationId"], version=INVENTORY_VERSION)


def _compare(inv: BackupInventory, actual: dict) -> None:
    by_path = {entry.path: entry for entry in inv.entries}
    if set(actual) != set(by_path):
        raise _Mismatch()
    for rel, record in actual.items():
        entry = by_path[rel]
        if entry.uid != _euid():
            raise _Mismatch()
        if entry.kind != record.kind or entry.size != record.size or entry.mode != record.mode:
            raise _Mismatch()
        if record.uid != _euid():
            raise _Mismatch()
        if entry.kind == "file" and entry.sha256 != record.sha256:
            raise _Mismatch()


def _verify_disk(root: Path, inv: BackupInventory, extra_top: frozenset) -> None:
    actual = _scan_root(root, False, extra_top)
    _compare(inv, actual)
    _integrity_check(root / DATABASE_NAME)


def _read_inventory(root: Path) -> BackupInventory:
    path = root / INVENTORY_NAME
    try:
        fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK)
    except OSError:
        raise operational_error("backup_invalid", "The backup inventory is unreadable.", "verify",
                                "Discard this backup and take a fresh one; never restore an unverified copy.")
    try:
        with os.fdopen(fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != _euid()
                    or stat.S_IMODE(info.st_mode) != 0o600 or info.st_size > MAX_INVENTORY_BYTES):
                raise operational_error("backup_invalid", "The backup inventory is unreadable.", "verify",
                                        "Discard this backup and take a fresh one; never restore an unverified copy.")
            payload = handle.read(MAX_INVENTORY_BYTES + 1)
    except OSError:
        raise operational_error("backup_invalid", "The backup inventory is unreadable.", "verify",
                                "Discard this backup and take a fresh one; never restore an unverified copy.")
    if len(payload) > MAX_INVENTORY_BYTES:
        raise operational_error("backup_invalid", "The backup inventory is unreadable.", "verify",
                                "Discard this backup and take a fresh one; never restore an unverified copy.")
    try:
        raw = json.loads(payload.decode("utf-8"))
    except (ValueError, UnicodeError):
        raise operational_error("backup_invalid", "The backup inventory is unreadable.", "verify",
                                "Discard this backup and take a fresh one; never restore an unverified copy.")
    try:
        return _parse_inventory(raw)
    except (_Mismatch, _Unsafe):
        raise operational_error("backup_invalid", "The backup inventory is invalid.", "verify",
                                "Discard this backup and take a fresh one; never restore an unverified copy.")


def _ensure_recovery_root(root: Path) -> None:
    try:
        info = os.lstat(root)
    except FileNotFoundError:
        os.mkdir(root, 0o700)
        info = os.lstat(root)
    except OSError:
        raise operational_error("backup_failed", "The backup root could not be prepared.", "backup",
                                "Check the data volume ownership and free space, then retry the update.")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != _euid():
        raise conflict_error("path_unwritable", "The backup root is not an owned directory.",
                             stage="backup", recovery="Use the installation owner and a real data directory.")
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise conflict_error("path_unwritable", "The backup root has unsafe permissions.", stage="backup",
                             recovery="Choose an owned mode-0700 recovery directory.")


def _is_task_staging(root: Path, staging: Path, operation_id: str) -> bool:
    return (staging.parent == root and staging.name.startswith("." + operation_id + ".")
            and staging.name.endswith(".staging"))


def _cleanup_staging(root: Path, staging: Path, operation_id: str) -> None:
    try:
        if not _is_task_staging(root, staging, operation_id):
            return
        info = os.lstat(staging)
        if not stat.S_ISDIR(info.st_mode) or stat.S_ISLNK(info.st_mode) or info.st_uid != _euid():
            return
        shutil.rmtree(staging)
    except OSError:
        pass


def create_backup(data: Path, operation_id: str) -> Path:
    """Stage a verified backup under `<data>/deploy-recovery/<operationId>/`.

    The caller holds the install `DeployLock` and has gracefully stopped
    the sole writer. Publishes atomically only after an independent
    readback of the staging directory passes.
    """
    operation_id = _check_operation_id(operation_id)
    base = _clean_absolute(data)
    try:
        info = os.lstat(base)
    except OSError:
        raise operational_error("backup_failed", "The data directory is missing.", "backup",
                                "Point the update at the owned data directory.")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != _euid():
        raise conflict_error("path_unwritable", "The data directory is not an owned directory.",
                             stage="backup", recovery="Point the update at the owned data directory.")
    try:
        os.lstat(base / DATABASE_NAME)
    except OSError:
        raise operational_error("backup_failed", "The core database is missing from the data directory.",
                                "backup", "Restore the data directory before retrying the update.")
    root = base / RECOVERY_DIR_NAME
    _ensure_recovery_root(root)
    final = root / operation_id
    try:
        os.lstat(final)
    except FileNotFoundError:
        pass
    except OSError:
        raise operational_error("backup_failed", "The backup could not be staged.", "backup",
                                "Retry the update; no backup was published.")
    else:
        raise conflict_error("backup_exists", "A backup already exists for this operation.",
                             stage="backup",
                             recovery="Use a fresh operation ID; backups are never overwritten.")
    staging = Path(tempfile.mkdtemp(dir=root, prefix="." + operation_id + ".", suffix=".staging"))
    try:
        try:
            records = _scan_root(base, True)
            db_record = _copy_database(base / DATABASE_NAME, staging / DATABASE_NAME)
            records[DATABASE_NAME] = db_record
            for rel in sorted(records):
                if rel == DATABASE_NAME:
                    continue
                record = records[rel]
                target = staging / rel
                source = base / rel
                if record.kind == "dir":
                    os.mkdir(target, 0o700)
                else:
                    _copy_file(source, target, record)
            for rel in reversed(sorted(records)):
                if records[rel].kind == "dir":
                    os.chmod(staging / rel, records[rel].mode)
            _write_inventory(staging, _inventory_doc(operation_id, records))
            inv = _read_inventory(staging)
            if inv.operation_id != operation_id or {e.path for e in inv.entries} != set(records):
                raise _Mismatch()
            _verify_disk(staging, inv, frozenset({INVENTORY_NAME}))
        except _Unsafe:
            raise operational_error("backup_failed", "The data volume holds an entry the backup cannot carry.",
                                    "backup", "Remove the linked or special entry and retry the update.")
        except _Mismatch:
            raise operational_error("backup_failed", "The staged backup failed verification; nothing was published.",
                                    "backup", "Retry the update; no backup was published.")
        except (OSError, sqlite3.Error, ValueError):
            raise operational_error("backup_failed", "The backup could not be staged.", "backup",
                                    "Retry the update; no backup was published.")
        try:
            os.lstat(final)
        except FileNotFoundError:
            pass
        except OSError:
            raise operational_error("backup_failed", "The backup could not be staged.", "backup",
                                    "Retry the update; no backup was published.")
        else:
            raise conflict_error("backup_exists", "A backup already exists for this operation.",
                                 stage="backup",
                                 recovery="Use a fresh operation ID; backups are never overwritten.")
        try:
            os.replace(staging, final)
            _fsync_dir(root)
        except OSError:
            raise operational_error("backup_failed", "The backup could not be staged.", "backup",
                                    "Retry the update; no backup was published.")
        return final
    except BaseException:
        _cleanup_staging(root, staging, operation_id)
        raise


def verify_backup(path: Path) -> BackupInventory:
    """Independently verify a backup directory and return its typed inventory."""
    try:
        root = _clean_absolute(path)
    except Exception as exc:
        raise operational_error("backup_invalid", "The backup path is invalid.", "verify",
                                "Point at the backup directory published by the update.") from exc
    try:
        info = os.lstat(root)
    except OSError:
        raise operational_error("backup_invalid", "The backup is unreadable.", "verify",
                                "Discard this backup and take a fresh one; never restore an unverified copy.")
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != _euid():
        raise operational_error("backup_invalid", "The backup is unreadable.", "verify",
                                "Discard this backup and take a fresh one; never restore an unverified copy.")
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise operational_error("backup_invalid", "The backup is unreadable.", "verify",
                                "Discard this backup and take a fresh one; never restore an unverified copy.")
    inv = _read_inventory(root)
    try:
        _verify_disk(root, inv, frozenset({INVENTORY_NAME}))
    except (_Mismatch, _Unsafe):
        raise operational_error("backup_invalid", "The backup contents do not match its inventory.", "verify",
                                "Discard this backup and take a fresh one; never restore an unverified copy.")
    except (OSError, sqlite3.Error, ValueError):
        raise operational_error("backup_invalid", "The backup contents do not match its inventory.", "verify",
                                "Discard this backup and take a fresh one; never restore an unverified copy.")
    return inv


def _cleanup_restore(dest: Path, created: list, created_root: bool) -> None:
    for rel in reversed(created):
        try:
            target = dest / rel
            info = os.lstat(target)
            if info.st_uid != _euid() or stat.S_ISLNK(info.st_mode):
                continue
            if stat.S_ISDIR(info.st_mode):
                os.rmdir(target)
            else:
                os.unlink(target)
        except OSError:
            pass
    if created_root:
        try:
            os.rmdir(dest)
        except OSError:
            pass


def restore_backup(path: Path, destination: Path) -> Path:
    """Restore a verified backup into a new, empty owned mode-0700 directory.

    Validates the backup before copying and the copy afterwards. Never
    replaces a running install: the destination must be missing or empty.
    """
    try:
        dest = _clean_absolute(destination)
    except Exception as exc:
        raise conflict_error("restore_refused", "The restore destination is invalid.",
                             stage="restore",
                             recovery="Choose a new empty directory; restores never overwrite.") from exc
    inv = verify_backup(path)
    try:
        src_root = _clean_absolute(path)
    except Exception as exc:
        raise operational_error("backup_invalid", "The backup path is invalid.", "verify",
                                "Discard this backup and take a fresh one; never restore an unverified copy.") from exc
    if dest == src_root or src_root in dest.parents or dest in src_root.parents:
        raise conflict_error("restore_refused", "Refusing to restore a backup into itself.",
                             stage="restore",
                             recovery="Choose a new empty directory outside the backup.")
    try:
        parent_info = os.lstat(dest.parent)
    except OSError:
        raise conflict_error("restore_refused", "The restore destination parent is missing.",
                             stage="restore",
                             recovery="Choose a new empty directory under an owned directory.")
    if (stat.S_ISLNK(parent_info.st_mode) or not stat.S_ISDIR(parent_info.st_mode)
            or parent_info.st_uid != _euid()):
        raise conflict_error("restore_refused", "The restore destination parent is not an owned directory.",
                             stage="restore",
                             recovery="Choose a new empty directory under an owned directory.")
    try:
        info = os.lstat(dest)
    except FileNotFoundError:
        try:
            os.mkdir(dest, 0o700)
            info = os.lstat(dest)
        except OSError:
            raise conflict_error("restore_refused", "The restore destination could not be created.",
                                 stage="restore",
                                 recovery="Choose a new empty directory; restores never overwrite.")
        created_root = True
    except OSError:
        raise conflict_error("restore_refused", "The restore destination is not a new empty directory.",
                             stage="restore",
                             recovery="Choose a new empty directory; restores never overwrite.")
    else:
        created_root = False
    if stat.S_ISLNK(info.st_mode) or not stat.S_ISDIR(info.st_mode) or info.st_uid != _euid():
        raise conflict_error("restore_refused", "The restore destination is not a new empty directory.",
                             stage="restore",
                             recovery="Choose a new empty directory; restores never overwrite.")
    if stat.S_IMODE(info.st_mode) != 0o700:
        raise conflict_error("restore_refused", "The restore destination must be private mode 0700.",
                             stage="restore", recovery="Choose a new empty directory; restores never overwrite.")
    try:
        with os.scandir(dest) as handle:
            if any(True for _ in handle):
                raise conflict_error("restore_refused", "The restore destination is not a new empty directory.",
                                     stage="restore",
                                     recovery="Choose a new empty directory; restores never overwrite.")
    except OSError:
        raise conflict_error("restore_refused", "The restore destination is not a new empty directory.",
                             stage="restore",
                             recovery="Choose a new empty directory; restores never overwrite.")
    by_path = {entry.path: entry for entry in inv.entries}
    created: list[str] = []
    try:
        try:
            for rel in sorted(by_path):
                entry = by_path[rel]
                target = dest / rel
                if entry.kind == "dir":
                    os.mkdir(target, 0o700)
                else:
                    _copy_file(src_root / rel, target, _Record("file", entry.size, entry.mode,
                                                               entry.uid, entry.sha256))
                created.append(rel)
            for rel in reversed(sorted(by_path)):
                if by_path[rel].kind == "dir":
                    os.chmod(dest / rel, by_path[rel].mode)
            _verify_disk(dest, inv, frozenset())
        except (_Mismatch, _Unsafe):
            raise operational_error("restore_failed", "The restored copy failed verification.", "restore",
                                    "Remove the destination and restore again from a verified backup.")
        except (OSError, sqlite3.Error, ValueError):
            raise operational_error("restore_failed", "The restore could not copy the backup.", "restore",
                                    "Remove the destination and restore again from a verified backup.")
    except BaseException:
        _cleanup_restore(dest, created, created_root)
        raise
    return dest
