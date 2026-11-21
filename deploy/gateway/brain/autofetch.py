"""AIRA's brain.autofetch: a group's post links answered with their media (docs/trd/system.md#autofetch).

The adapter's auto-fetch hook hands every group message its mention gate drops
to `offer`. In a chat whose chats.json entry has `autofetch: true`, a message
with a link goes to the core, which reads the post links and answers the files
to send. This module sends them, in order, through the adapter.

Nothing here keeps or logs the text, a link, the sender or the chat. A failure
is silent: nobody asked the bot anything. No function raises.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import urllib.request as _urlreq

from brain import chatflags

LOG = logging.getLogger("aira.autofetch")

CORE_TIMEOUT = 90.0
DEFAULT_CORE_URL = "http://127.0.0.1:9881"
_LINK = re.compile(r"https?://", re.I)

_locks: dict[str, asyncio.Lock] = {}
_tasks: set = set()


def core_url() -> str:
    """The core's address: AIRA_CORE_URL, or the loopback port the gateway already calls. Never raises."""
    try:
        raw = str(os.environ.get("AIRA_CORE_URL") or "").strip().rstrip("/")
        return raw if raw.startswith(("http://127.0.0.1:", "http://localhost:")) else DEFAULT_CORE_URL
    except Exception:
        return DEFAULT_CORE_URL


def _truthy(value) -> bool:
    try:
        if isinstance(value, str):
            return value.strip().lower() in ("true", "1", "yes")
        return bool(value)
    except Exception:
        return False


def wanted(data) -> str | None:
    """The chat id when this message goes to the core, else None. Never raises."""
    try:
        if not isinstance(data, dict) or not _truthy(data.get("isGroup")):
            return None
        if _truthy(data.get("fromMe")) or _truthy(data.get("fromOwner")):
            return None
        chat = str(data.get("chatId") or "").strip()
        if not chat or not chatflags.autofetch_on(chat):
            return None
        if not _LINK.search(str(data.get("body") or "")):
            return None
        return chat
    except Exception:
        return None


def ask_core(chat: str, text: str, *, timeout: float = CORE_TIMEOUT, opener=None) -> tuple[list[dict], str | None]:
    """The ordered files and the delivery key. Never raises."""
    try:
        request = _urlreq.Request(
            f"{core_url()}/v1/aira/autofetch",
            data=json.dumps({"chat": chat, "text": text}).encode("utf-8"),
            method="POST",
            headers={"content-type": "application/json"},
        )
        with (opener or _urlreq.urlopen)(request, timeout=timeout) as response:
            data = json.loads(response.read().decode("utf-8"))
        items = data.get("media") if isinstance(data, dict) else None
        media = []
        for item in items if isinstance(items, list) else []:
            if not isinstance(item, dict):
                continue
            kind, path = item.get("kind"), item.get("path")
            if kind in ("image", "video") and isinstance(path, str) and path:
                media.append({"kind": kind, "path": path})
        key = data.get("deliveryKey") if isinstance(data, dict) else None
        listed = items if isinstance(items, list) else []
        if not isinstance(key, str) or len(key) != 36 or len(media) != len(listed):
            return [], None
        return media, key
    except Exception as exc:
        try:
            LOG.warning("autofetch core request failed: error=%s", type(exc).__name__)
        except Exception:
            pass
        return [], None


def _delivery(action: str, body: dict) -> bool:
    try:
        request = _urlreq.Request(
            f"{core_url()}/v1/aira/autofetch/{action}",
            data=json.dumps(body).encode("utf-8"),
            method="POST",
            headers={"content-type": "application/json"},
        )
        with _urlreq.urlopen(request, timeout=5.0) as response:
            return json.loads(response.read(1024)).get("accepted") is True
    except Exception:
        LOG.warning("autofetch delivery record failed: phase=%s", action)
        return False


async def send_all(adapter, chat: str, media: list[dict]) -> list[bool]:
    """Return adapter outcomes in the core's slot order."""
    outcomes = []
    for item in media:
        try:
            send = adapter.send_video if item.get("kind") == "video" else adapter.send_image_file
            result = await send(chat, item["path"])
            outcomes.append(bool(getattr(result, "success", False)))
        except Exception as exc:
            outcomes.append(False)
            try:
                LOG.warning("autofetch send failed: error=%s", type(exc).__name__)
            except Exception:
                pass
    return outcomes


async def _run(adapter, chat: str, text: str) -> None:
    # One job per chat at a time, so a burst of links arrives in order.
    lock = _locks.setdefault(chat, asyncio.Lock())
    async with lock:
        media, key = await asyncio.to_thread(ask_core, chat, text)
        if not media or not key or not await asyncio.to_thread(_delivery, "claim", {"key": key}):
            return
        outcomes = await send_all(adapter, chat, media)
        # The core accepts one completion per claim, so a retry after a refused connection is safe.
        for delay in (0, 1, 2):
            await asyncio.sleep(delay)
            if await asyncio.to_thread(_delivery, "complete", {"key": key, "outcomes": outcomes}):
                break
        LOG.info("autofetch sent %d of %d", sum(outcomes), len(outcomes))


def offer(adapter, data) -> None:
    """A group message the mention gate is dropping. Returns at once; the work runs as a task. Never raises."""
    try:
        chat = wanted(data)
        if chat is None:
            return
        task = asyncio.get_running_loop().create_task(_run(adapter, chat, str(data.get("body") or "")))
        _tasks.add(task)
        task.add_done_callback(_tasks.discard)
    except Exception as exc:
        try:
            LOG.warning("autofetch offer failed: error=%s", type(exc).__name__)
        except Exception:
            pass
