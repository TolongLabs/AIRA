"""AIRA's brain.bubbles for the gateway's bubble patches (docs/trd/system.md#gateway-helper-modules).

The core decides the bubbles and writes a line holding only U+2063 between two of them. This module only finds
those breaks. It reads no chat setting and no persona: every reply the core sends is already split as it should be.

The gateway patches call four names: for_chat, typing_pause, is_interrupt and receipts_of. Any error here makes the
patch send the reply as one message, so every function fails towards that.
"""

from __future__ import annotations

import re

BUBBLE_BREAK = "⁣"

PAUSE_MIN = 0.1  # seconds
PAUSE_PER_CHAR = 0.01
PAUSE_MAX = 2.0

_INTERRUPT = re.compile(
    r"^\s*(?:(?:no |oh )?wait(?: wait)?|w8|stop(?: stop)?|hold on|hang on|hold up|nvm"
    r"|never ?mind|shh+|等等|等一下|先别(?:说|发|回)?|停(?:一下)?|打住|别说了)"
    r"[\s!！.。…?？~～]*$",
    re.I,
)


def split_bubbles(text: str) -> list[str]:
    """The bubbles between the core's break lines, in order. A reply with no break is one bubble."""
    text = str(text or "")
    parts: list[str] = []
    current: list[str] = []
    for line in text.split("\n"):
        if line.strip() == BUBBLE_BREAK:
            parts.append("\n".join(current))
            current = []
        else:
            current.append(line)
    parts.append("\n".join(current))
    bubbles = [part.strip("\n") for part in parts if part.strip()]
    return bubbles or [text]


def for_chat(platform: str, chat_id: str, text: str) -> list[str]:
    """The bubbles of one reply. The chat does not matter: the core already decided."""
    try:
        return split_bubbles(text)
    except Exception:
        return [text]


def typing_pause(bubble: str) -> float:
    """Seconds of "typing..." before a bubble that is not the first."""
    return min(PAUSE_MAX, PAUSE_MIN + PAUSE_PER_CHAR * len(bubble or ""))


def is_interrupt(text) -> bool:
    """Is the message only "wait", "stop", "hold on" or the like? Then the bubbles not yet sent are dropped."""
    return bool(_INTERRUPT.match(str(text or "")))


def receipts_of(parts) -> str:
    """What an interrupt still sends of the unsent bubbles: nothing. The turn record keeps every receipt."""
    return ""
