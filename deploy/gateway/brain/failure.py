"""AIRA's brain.failure for the gateway's failure-line patch (docs/trd/system.md#gateway-helper-modules).

When the gateway could not get a reply from the core, the chat gets one line: the default character's unavailable
line, which the core writes to <AIRA_HOST_DATA_DIR>/gateway/unavailable.txt. If that file cannot be read, the chat
gets a fixed neutral line. Raw error text never reaches a chat.

The gateway patch calls two names: for_failed_turn and for_exception.
"""

from __future__ import annotations

import os
from pathlib import Path

NEUTRAL_LINE = "Sorry, I can't answer right now. Please try again in a moment."
MAX_LINE = 500


def unavailable_line() -> str:
    """The line the core last wrote for the default character, or the neutral line."""
    try:
        root = os.environ.get("AIRA_HOST_DATA_DIR", "").strip()
        if not root:
            return NEUTRAL_LINE
        text = (Path(root) / "gateway" / "unavailable.txt").read_text(encoding="utf-8")
        line = next((row.strip() for row in text.splitlines() if row.strip()), "")
        return line[:MAX_LINE] if line else NEUTRAL_LINE
    except Exception:
        return NEUTRAL_LINE


def for_failed_turn(result) -> str | None:
    """The line for a turn in which the core gave no reply, or None for a turn that did not fail.

    A turn that answered, was interrupted, or was blocked by a content policy is not a failure here.
    """
    if not isinstance(result, dict) or result.get("interrupted"):
        return None
    reply = str(result.get("final_response") or "").strip()
    if not result.get("failed") and reply != "(empty)":
        return None
    reason = str(result.get("failure_reason") or "")
    error = str(result.get("error") or "")
    if reason == "content_policy_blocked" or error.startswith("content_policy_blocked"):
        return None
    return unavailable_line()


def for_exception(exc: BaseException) -> str:
    """The line for an exception the gateway caught while running a turn."""
    return unavailable_line()
