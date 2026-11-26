"""Owned versioned CLI runtime and local executable installation."""

from __future__ import annotations

import json
import hashlib
import os
import re
import shutil
import tempfile
from pathlib import Path

from . import __version__ as CLI_VERSION

SHIM_MARKER = "# aira-standalone-shim v1"


def runtime_root():
    return Path.home() / ".local" / "share" / "aira" / "cli"


def runtime_dir(version=CLI_VERSION):
    return runtime_root() / version


def bin_path():
    return Path.home() / ".local" / "bin" / "aira"


def fresh_home_default():
    return Path.home() / "aira"


def fresh_home_fallback():
    return Path.home() / ".local" / "share" / "aira" / "install"


def is_checkout_dir(path):
    return (path / "deploy").is_dir() and ((path / "src").is_dir() or (path / "package.json").is_file())


def path_has_bin():
    return str(bin_path().parent) in os.environ.get("PATH", "").split(os.pathsep)


def is_our_shim(path):
    from .install import read_owned_text
    try:
        return SHIM_MARKER in read_owned_text(path, 4096, private=False).splitlines()[:3]
    except Exception:
        return False


def shim_text(target):
    return (
        "#!/usr/bin/env python3\n" + SHIM_MARKER + "\n"
        "import runpy\nimport sys\nsys.dont_write_bytecode = True\n"
        f"sys.path.insert(0, {str(target)!r})\n"
        "runpy.run_module('cli.main', run_name='__main__')\n"
    )


def install_runtime(repo_root):
    from .install import DeployLock, atomic_write_text, check_owned, ensure_private_dir, fsync_dir, read_owned_text
    from .result import conflict_error

    source = Path(repo_root) / "deploy" / "cli"
    if not (source / "main.py").is_file():
        raise conflict_error("config_invalid", "The checkout CLI bundle is incomplete.")
    files = {}
    for item in source.glob("*.py"):
        if item.is_symlink() or not item.is_file():
            continue
        files["cli/" + item.name] = item.read_text(encoding="utf-8")
    for source_path, name in (
        (Path(repo_root) / "deploy" / "standalone.compose.yml", "standalone.compose.yml"),
        (Path(repo_root) / "config.yml", "config.template.yml"),
        (Path(repo_root) / "deploy" / "gateway" / "standalone_adapter.py", "standalone_adapter.py"),
        (Path(repo_root) / "deploy" / "gateway" / "standalone_typed_adapter.py", "standalone_typed_adapter.py"),
        (Path(repo_root) / "deploy" / "gateway" / "standalone_document_adapter.py", "standalone_document_adapter.py"),
        (Path(repo_root) / "deploy" / "gateway" / "standalone_patch.py", "standalone_patch.py"),
    ):
        files[name] = source_path.read_text(encoding="utf-8")
    digest = hashlib.sha256(json.dumps(files, sort_keys=True).encode()).hexdigest()
    target = runtime_dir(CLI_VERSION + "-" + digest[:16])
    ensure_private_dir(runtime_root())
    metadata = json.dumps({"version": CLI_VERSION, "digest": digest}, sort_keys=True) + "\n"
    files["runtime.json"] = metadata
    files["aira"] = shim_text(target)
    with DeployLock(runtime_root()):
        if not os.path.lexists(target):
            staging = Path(tempfile.mkdtemp(prefix=".runtime-", dir=runtime_root()))
            try:
                ensure_private_dir(staging / "cli")
                for name, contents in files.items():
                    atomic_write_text(staging / name, contents, mode=0o700 if name == "aira" else 0o600)
                fsync_dir(staging)
                staging.rename(target)
                fsync_dir(runtime_root())
            finally:
                if staging.exists():
                    shutil.rmtree(staging)
        # An existing digest is reusable only if every owned byte matches.
        for directory in (target, target / "cli"):
            check_owned(directory, "runtime directory")
            if not directory.is_dir() or directory.stat().st_mode & 0o777 != 0o700:
                raise conflict_error("install_ambiguous", "The immutable CLI runtime has unsafe permissions.")
        for name, contents in files.items():
            file = target / name
            try:
                matching = read_owned_text(file, private=name != "aira") == contents
                matching = matching and (file.stat().st_mode & 0o777 == (0o700 if name == "aira" else 0o600))
            except (OSError, ValueError):
                matching = False
            if not matching:
                raise conflict_error("install_ambiguous", "The immutable CLI runtime does not match the reviewed bundle.")
    fallback = target / "aira"
    dest = bin_path()
    dest.parent.mkdir(parents=True, exist_ok=True)
    check_owned(dest.parent, "launcher directory")
    warnings = []
    if dest.is_symlink() or (dest.exists() and not is_our_shim(dest)):
        warnings.append(f"Existing launcher left untouched. Use {fallback}.")
        return target, fallback, warnings
    atomic_write_text(dest, shim_text(target), mode=0o700)
    if not path_has_bin():
        warnings.append(f"The launcher is not on PATH. Use {dest}.")
    return target, dest, warnings


def template_sources(repo_root=None):
    if repo_root:
        base = Path(repo_root)
        return base / "deploy" / "standalone.compose.yml", base / "config.yml"
    base = Path(__file__).resolve().parents[1]
    return base / "standalone.compose.yml", base / "config.template.yml"


def repo_root_for(path):
    for parent in (path, *path.parents):
        if (parent / "deploy" / "cli" / "main.py").is_file() and (parent / "config.yml").is_file():
            return str(parent)
    return None
