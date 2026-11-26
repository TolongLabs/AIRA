"""Exact two-anchor lifecycle insertion for the pinned public WhatsApp adapter."""

from __future__ import annotations

import hashlib
from typing import Literal

TARGET = "plugins/platforms/whatsapp/adapter.py"
ORIGINAL_SHA256 = "a530a1d6c352afe5c38c3fa6ad988b0f715e54c977495bcedbbda4705ab947d6"

START_ANCHOR = b"        self._poll_task = asyncio.create_task(self._poll_messages())\n"
STOP_ANCHOR = b"        self._shutting_down = True  # flip BEFORE signalling so send()/poll loop don't report the intentional exit as fatal\n"

START_ADDED = b'''        # AIRA: the owning attached native adapter polls core-owned reminders.
        try:
            _aira_marker = self._profile_home / "aira-transport.json"
            _aira_marker.lstat()
        except FileNotFoundError:
            pass
        except Exception:
            logger.warning("aira.adapter.schedule_start_unavailable")
        else:
            try:
                from gateway.aira_transport import start_schedule_poll
                _aira_task = start_schedule_poll(self, _aira_marker)
                if _aira_task is not None:
                    self._aira_schedule_task = _aira_task
            except Exception:
                logger.warning("aira.adapter.schedule_start_unavailable")
'''
STOP_ADDED = b'''        await cancel_task(getattr(self, "_aira_schedule_task", None))
        self._aira_schedule_task = None
'''
START_PATCHED = START_ANCHOR + START_ADDED
STOP_PATCHED = STOP_ANCHOR + STOP_ADDED


def patch_source(original: bytes | bytearray) -> bytes:
    """Insert both reviewed blocks only into the exact original bytes."""
    if isinstance(original, bytearray):
        original = bytes(original)
    if not isinstance(original, bytes):
        raise TypeError("original must be bytes")
    if hashlib.sha256(original).hexdigest() != ORIGINAL_SHA256:
        raise ValueError("digest mismatch: not the reviewed " + TARGET)
    if original.count(START_ANCHOR) != 1 or original.count(STOP_ANCHOR) != 1:
        raise ValueError("scheduler anchors must occur exactly once")
    return original.replace(START_ANCHOR, START_PATCHED, 1).replace(STOP_ANCHOR, STOP_PATCHED, 1)


def classify_source(current: bytes | bytearray) -> Literal["original", "patched", "unsupported"]:
    """Both complete insertions must restore the exact original digest."""
    if isinstance(current, bytearray):
        current = bytes(current)
    if not isinstance(current, bytes):
        raise TypeError("current must be bytes")
    if hashlib.sha256(current).hexdigest() == ORIGINAL_SHA256:
        return "original"
    if current.count(START_PATCHED) == 1 and current.count(STOP_PATCHED) == 1:
        restored = current.replace(START_PATCHED, START_ANCHOR, 1).replace(STOP_PATCHED, STOP_ANCHOR, 1)
        if hashlib.sha256(restored).hexdigest() == ORIGINAL_SHA256:
            return "patched"
    return "unsupported"


def select_scheduler(current: bytes | bytearray, enabled: bool) -> bytes:
    """Select or revert the exact lifecycle patch; never repair a partial or foreign source."""
    kind = classify_source(current)
    if kind == "unsupported" or type(enabled) is not bool:
        raise ValueError("unsupported scheduler lifecycle")
    if isinstance(current, bytearray):
        current = bytes(current)
    if kind == "patched":
        current = current.replace(START_PATCHED, START_ANCHOR, 1).replace(STOP_PATCHED, STOP_ANCHOR, 1)
    return patch_source(current) if enabled else current
