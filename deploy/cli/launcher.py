"""Owned versioned CLI runtime and local executable installation."""

from __future__ import annotations

import json
import os
import re
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
        "import runpy\nimport sys\n"
        f"sys.path.insert(0, {str(target)!r})\n"
        "runpy.run_module('cli.main', run_name='__main__')\n"
    )


def install_runtime(repo_root):
    from .install import atomic_write_text, check_owned, ensure_private_dir
    from .result import conflict_error

    target = runtime_dir()
    modules = target / "cli"
    source = Path(repo_root) / "deploy" / "cli"
    if not (source / "main.py").is_file():
        raise conflict_error("config_invalid", "The checkout CLI bundle is incomplete.")
    ensure_private_dir(runtime_root())
    if target.exists() and not (target / "runtime.json").is_file():
        raise conflict_error("install_ambiguous", "The versioned CLI runtime path belongs to unknown files.")
    ensure_private_dir(target)
    ensure_private_dir(modules)
    atomic_write_text(target / "runtime.json", json.dumps({"version": CLI_VERSION}) + "\n")
    for item in source.glob("*.py"):
        if item.is_symlink() or not item.is_file():
            continue
        atomic_write_text(modules / item.name, item.read_text(encoding="utf-8"))
    for source_path, name in (
        (Path(repo_root) / "deploy" / "standalone.compose.yml", "standalone.compose.yml"),
        (Path(repo_root) / "config.yml", "config.template.yml"),
    ):
        atomic_write_text(target / name, source_path.read_text(encoding="utf-8"))
    fallback = target / "aira"
    atomic_write_text(fallback, shim_text(target), mode=0o700)
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
