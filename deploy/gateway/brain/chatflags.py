"""AIRA's brain.chatflags for per-chat voice and reaction flags (docs/trd/system.md#chat-flags-file).

The core writes <AIRA_HOST_DATA_DIR>/gateway/chats.json with:
{"version": 1, "chats": {"<whatsapp chat id>": {"voice": "all", "reactions": true}}}.

This module caches the parsed chats map and reloads it only when the file's
modification time changes. A missing, unreadable, or invalid file means
everything is off. No function here ever raises.
"""

from __future__ import annotations

import json
import os
import threading
from pathlib import Path

_LOCK = threading.Lock()
_CACHE_PATH: Path | None = None
_CACHE_KEY: tuple[int, int] | None = None
_CACHE_CHATS: dict[str, dict] = {}


def _chats_path() -> Path | None:
    root = os.environ.get("AIRA_HOST_DATA_DIR", "").strip()
    if not root:
        return None
    return Path(root) / "gateway" / "chats.json"


def _load_chats() -> dict[str, dict]:
    global _CACHE_PATH, _CACHE_KEY, _CACHE_CHATS
    try:
        path = _chats_path()
        if path is None:
            return {}
        st = path.stat()
        key = (st.st_mtime_ns, st.st_size)
        with _LOCK:
            if _CACHE_PATH == path and _CACHE_KEY == key:
                return _CACHE_CHATS
            raw = path.read_text(encoding="utf-8")
            data = json.loads(raw)
            if not isinstance(data, dict) or data.get("version") != 1:
                chats: dict[str, dict] = {}
            else:
                raw_chats = data.get("chats")
                chats = {
                    str(k): dict(v)
                    for k, v in raw_chats.items()
                    if isinstance(v, dict)
                } if isinstance(raw_chats, dict) else {}
            _CACHE_PATH = path
            _CACHE_KEY = key
            _CACHE_CHATS = chats
            return _CACHE_CHATS
    except Exception:
        with _LOCK:
            _CACHE_PATH = None
            _CACHE_KEY = None
            _CACHE_CHATS = {}
        return {}


def flags(chat_id: str | None) -> dict:
    """The flag dict for one chat, or {} when absent or unreadable."""
    try:
        key = str(chat_id or "").strip()
        if not key:
            return {}
        entry = _load_chats().get(key)
        return dict(entry) if isinstance(entry, dict) else {}
    except Exception:
        return {}


def voice_mode(chat_id: str | None) -> str:
    """'all' when voice is enabled for the chat, otherwise 'off'."""
    try:
        return "all" if flags(chat_id).get("voice") == "all" else "off"
    except Exception:
        return "off"


def reactions_on(chat_id: str | None) -> bool:
    """True when passive reactions are enabled for the chat."""
    try:
        return flags(chat_id).get("reactions") is True
    except Exception:
        return False
