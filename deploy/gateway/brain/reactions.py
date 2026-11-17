"""AIRA's brain.reactions for passive emoji reactions (docs/trd/system.md#gateway-helper-modules).

Reacts to inbound human WhatsApp messages on a per-chat chance and per-chat
cooldown when the core's chats.json enables reactions for that chat.
"""

from __future__ import annotations

import http.client as _httpclient
import json as _json
import logging
import math
import os
import random
import re
import threading
import time
import urllib.error as _urlerr
import urllib.request as _urlreq
from collections import OrderedDict

from brain import chatflags

LOG = logging.getLogger("aira.reactions")

DEFAULT_CHANCE = 0.33
DEFAULT_COOLDOWN = 180
MAX_SEEN_IDS = 512
MAX_CHATS = 256
SEND_TIMEOUT = 5.0
RETRY_DELAY = 1.0


def _parse_chance(raw, default=DEFAULT_CHANCE):
    try:
        if raw is None or isinstance(raw, bool):
            return default
        val = float(raw)
        if not math.isfinite(val):
            return default
        return max(0.0, min(1.0, val))
    except Exception:
        return default


def _parse_int(raw, default):
    try:
        if raw is None or isinstance(raw, bool):
            return default
        return int(raw)
    except Exception:
        return default


def _parse_enabled(raw, default=True):
    try:
        if raw is None:
            return default
        return str(raw).strip().lower() not in ("0", "off", "no", "false")
    except Exception:
        return default


_INIT_CHANCE = _parse_chance(os.environ.get("AIRA_REACTION_CHANCE"), DEFAULT_CHANCE)
CHANCE = _INIT_CHANCE
_INIT_COOLDOWN = _parse_int(os.environ.get("AIRA_REACTION_COOLDOWN"), DEFAULT_COOLDOWN)
COOLDOWN = _INIT_COOLDOWN
_INIT_ENABLED = _parse_enabled(os.environ.get("AIRA_REACTIONS"), True)
ENABLED = _INIT_ENABLED

# Ordered: the first rule to match wins, so affection outranks sadness ("miss
# you" is love, not grief) and a laugh outranks the thing laughed at. Each
# rule carries two or three faces so the same message shape does not get the
# same emoji every time; the last one used per chat is never picked twice
# running.
RULES = (
    # ASCII terms sit inside \b groups; CJK terms sit OUTSIDE them, because
    # \b is meaningless between ideographs (晚安了 never matched \b晚安\b) —
    # and the love terms refuse a leading 不, so 我不爱你 earns no heart.
    ("love", re.compile(
        r"\b(?:love (?:you|u|ya)|i love|miss (?:you|u)|cute|kawaii|you'?re the best|"
        r"marry|sayang|cinta)\b|(?<!不)(?:喜欢你|爱你|想你)|"
        r"♡|❤|💕|💖|😘|🥰|🫶", re.I), ("❤️", "🩷", "🥰")),
    ("laugh", re.compile(
        r"\b(?:lol|lmao|lmfao|rofl|(?:ha){2,}h?|(?:he){2,}h?|(?:hi){2,}h?|(?:wk){2,}|kekw?)\b|"
        r"(?<![\w.])w{3,}(?![\w.])|草|😂|🤣|😆|😹", re.I), ("😂", "🤣")),
    ("night", re.compile(
        r"\b(?:good ?night|night night|nighty|nini|oyasumi|sleep well|sweet dreams|"
        r"off to bed|going to bed|heading to bed|bedtime|selamat malam)\b|晚安|おやすみ|"
        r"🌙|😴|💤", re.I), ("🌙", "💤", "😴")),
    ("sad", re.compile(
        r"\b(?:sad|lonely|(?:so|all|feel|feeling) alone|scared|afraid|anxious|panic|"
        r"overwhelmed|cried|crying|upset|awful|terrible|rough day|hard day|heartbroken|"
        r"depressed|sedih|takut)\b|难过|害怕|伤心|😢|😭|💔|🥲|😞", re.I), ("🫂", "😢", "💔")),
    ("worry", re.compile(
        r"\b(?:sick|unwell|fever|flu|headache|migraine|haven'?t eaten|no sleep|"
        r"all ?nighter|exhausted|knackered|drained|demam|sakit)\b|生病|发烧|🤒|🤧|🤕",
        re.I), ("🥺", "🍵", "🫂")),
    ("food", re.compile(
        r"\b(?:breakfast|brunch|lunch|dinner|supper|eating|hungry|starving|cooking|"
        r"cooked|baking|baked|snack|ramen|sushi|onigiri|bento|nasi lemak|roti|"
        r"makan|lapar|masak)\b|吃饭|饿了|做饭|🍳|🍙|🍜|🍵|🍱|🍞|🥟|☕", re.I),
     ("🍳", "🍵", "🍙")),
    ("win", re.compile(
        r"\b(?:shipped|merged|deployed|deploy landed|passed (?:the |my |an? )?(?:exam|test|"
        r"interview|check|driving|audit)|fixed it|nailed it|we won|i won|solved|it worked|"
        r"it works|all green|got the job|promoted|berjaya)\b|成功|搞定|🎉|✅|🥳|🏆", re.I),
     ("🎉", "✨", "👏")),
    ("thanks", re.compile(
        r"\b(?:thank you|thanks|thankyou|thx|tysm|arigatou|arigato|terima kasih)\b|"
        r"谢谢|ありがとう|🙏", re.I), ("🥹", "🙏", "🩷")),
)

# A link is not a sentence: "www" is not a laugh and a shop URL is not a win.
_URL = re.compile(r"https?://\S+|\bwww\.\S+", re.I)

_STATE: dict = {"seen": OrderedDict(), "chats": OrderedDict()}
_LOCK = threading.Lock()
_STAMP = re.compile(r"^\s*(?:\[[^\]\n]+\]\s+)?\[HERMES-SCOPE[^\]]*\]\n?")


def _is_enabled() -> bool:
    if ENABLED != _INIT_ENABLED:
        return bool(ENABLED)
    raw = os.environ.get("AIRA_REACTIONS")
    if raw is not None:
        return _parse_enabled(raw, True)
    return bool(ENABLED)


def _fallback_chance() -> float:
    if CHANCE != _INIT_CHANCE:
        return _parse_chance(CHANCE, DEFAULT_CHANCE)
    raw = os.environ.get("AIRA_REACTION_CHANCE")
    if raw is not None and raw.strip() != "":
        return _parse_chance(raw, DEFAULT_CHANCE)
    return DEFAULT_CHANCE


def _default_cooldown() -> int:
    if COOLDOWN != _INIT_COOLDOWN:
        return _parse_int(COOLDOWN, DEFAULT_COOLDOWN)
    raw = os.environ.get("AIRA_REACTION_COOLDOWN")
    if raw is not None and raw.strip() != "":
        return _parse_int(raw, DEFAULT_COOLDOWN)
    return DEFAULT_COOLDOWN


def _is_ignored_chat(chat: str) -> bool:
    low = chat.lower()
    return "@broadcast" in low or "status@" in low


def _state_buckets(st: dict) -> tuple[OrderedDict, OrderedDict]:
    seen = st.get("seen")
    if not isinstance(seen, OrderedDict):
        seen = OrderedDict()
        st["seen"] = seen
    chats = st.get("chats")
    if not isinstance(chats, OrderedDict):
        chats = OrderedDict()
        st["chats"] = chats
    return seen, chats


def category(text):
    """The rule this message trips, or None. Never raises."""
    try:
        t = _URL.sub(" ", str(text or ""))
        if not t.strip():
            return None
        for name, pattern, _faces in RULES:
            if pattern.search(t):
                return name
        return None
    except Exception:
        return None


def _faces_for(name):
    for n, _p, faces in RULES:
        if n == name:
            return faces
    return ()


def choose(text, chat_id, *, from_me=False, now=None, rng=None, state=None,
           chance=None, cooldown=None, message_id=None):
    """The emoji to put on this message, or None. Pure apart from `state`. Never raises."""
    try:
        if not _is_enabled():
            LOG.debug("reaction skipped: disabled")
            return None
        if from_me:
            LOG.debug("reaction skipped: own message")
            return None
        chat = str(chat_id or "").strip()
        if not chat or _is_ignored_chat(chat):
            LOG.debug("reaction skipped: ignored chat")
            return None
        body = str(text or "").strip()
        if not body or body.startswith("/"):
            LOG.debug("reaction skipped: empty or command")
            return None
        if not chatflags.reactions_on(chat):
            LOG.debug("reaction skipped: chat disabled")
            return None
        name = category(body)
        if name is None:
            LOG.debug("reaction skipped: no rule matched")
            return None

        eff_chance = (
            _parse_chance(chance, DEFAULT_CHANCE)
            if chance is not None
            else chatflags.reaction_chance(chat, default=_fallback_chance())
        )
        eff_cooldown = _default_cooldown() if cooldown is None else _parse_int(cooldown, DEFAULT_COOLDOWN)
        now_val = time.time() if now is None else float(now)
        st = _STATE if state is None else state
        if not isinstance(st, dict):
            LOG.debug("reaction skipped: invalid state")
            return None
        msg_key = None if message_id is None else (str(message_id).strip() or None)

        with _LOCK:
            seen, chats = _state_buckets(st)
            if msg_key is not None:
                if msg_key in seen:
                    seen.move_to_end(msg_key)
                    LOG.debug("reaction skipped: already decided")
                    return None
                seen[msg_key] = True
                while len(seen) > MAX_SEEN_IDS:
                    seen.popitem(last=False)

            entry = chats.get(chat)
            if entry is not None:
                chats.move_to_end(chat)
                last = entry.get("at")
            else:
                last = None

            if last is not None and now_val - last < eff_cooldown:
                LOG.debug("reaction skipped: cooldown")
                return None
            r = rng if rng is not None else random
            if r.random() >= eff_chance:
                LOG.debug("reaction skipped: chance missed")
                return None
            faces = list(_faces_for(name))
            if not faces:
                LOG.debug("reaction skipped: no faces")
                return None
            prev = entry.get("faces", {}).get(name) if entry is not None else None
            options = [f for f in faces if f != prev] or faces
            face = r.choice(options)

            if entry is None:
                entry = {"at": now_val, "faces": {name: face}}
                chats[chat] = entry
                while len(chats) > MAX_CHATS:
                    chats.popitem(last=False)
            else:
                entry["at"] = now_val
                faces_map = entry.setdefault("faces", {})
                faces_map[name] = face

            LOG.debug("reaction chosen")
            return face
    except Exception as exc:
        try:
            LOG.debug("reaction decision failed: error=%s", type(exc).__name__)
        except Exception:
            pass
        return None


def _truthy(v):
    try:
        if isinstance(v, str):
            return v.strip().lower() in ("true", "1", "yes")
        return bool(v)
    except Exception:
        return False


def strip_stamp(text):
    """The message without the scope marker the adapter prepends. Never raises."""
    try:
        return _STAMP.sub("", str(text or ""), count=1)
    except Exception:
        return ""


def bridge_port(default=3000):
    """Port for the loopback WhatsApp bridge. Never raises."""
    try:
        raw = os.environ.get("AIRA_BRIDGE_PORT")
        if not raw:
            return default
        port = int(raw)
        return port if 1 <= port <= 65535 else default
    except Exception:
        return default


def _http_status(exc: BaseException) -> int | None:
    if isinstance(exc, _urlerr.HTTPError):
        return exc.code
    status = getattr(exc, "code", None)
    if isinstance(status, int) and not isinstance(status, bool):
        return status
    status = getattr(exc, "status", None)
    if isinstance(status, int) and not isinstance(status, bool):
        return status
    return None


def _is_retryable(exc: BaseException) -> bool:
    if isinstance(exc, _urlerr.HTTPError):
        return 500 <= exc.code < 600
    status = _http_status(exc)
    if status is not None:
        return 500 <= status < 600
    return isinstance(exc, (_urlerr.URLError, OSError, _httpclient.HTTPException))


def _post_once(key, emoji, port=None, timeout=SEND_TIMEOUT) -> bool:
    eff_timeout = SEND_TIMEOUT if timeout is None else timeout
    body = _json.dumps({"key": key, "emoji": emoji}).encode("utf-8")
    url = f"http://127.0.0.1:{port or bridge_port()}/react"
    req = _urlreq.Request(
        url, data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    with _urlreq.urlopen(req, timeout=eff_timeout) as resp:
        status = getattr(resp, "status", 200)
        if 200 <= status < 300:
            return True
        raise _urlerr.HTTPError(url, status, "unexpected HTTP status", None, None)


def _send_with_retry(send_fn, key, emoji, port) -> bool:
    for attempt in range(2):
        try:
            res = send_fn(key, emoji, port)
            if res is False:
                LOG.warning("reaction send failed: error=SendReturnedFalse status=none")
                return False
            LOG.debug("reaction sent")
            return True
        except Exception as exc:
            if attempt == 0 and _is_retryable(exc):
                try:
                    time.sleep(RETRY_DELAY)
                except Exception:
                    pass
                continue
            status = _http_status(exc)
            LOG.warning(
                "reaction send failed: error=%s status=%s",
                type(exc).__name__,
                status if status is not None else "none",
            )
            return False
    return False


def post_reaction(key, emoji, port=None, timeout=SEND_TIMEOUT) -> bool:
    """POST /react to the loopback WhatsApp bridge, retrying once after 1s. Never raises."""
    try:
        return _send_with_retry(
            lambda k, e, p: _post_once(k, e, p, timeout=timeout),
            key,
            emoji,
            port,
        )
    except Exception as exc:
        try:
            LOG.warning("reaction send failed: error=%s status=none", type(exc).__name__)
        except Exception:
            pass
        return False


def react_to(raw, *, port=None, sender=None, now=None, rng=None, state=None,
             chance=None, cooldown=None):
    """Decide on, and fire, a reaction to one inbound bridge event. Never raises.

    `raw` is the bridge's event dict (the adapter's raw_message). Returns
    the emoji it chose, or None. The send runs on a daemon thread so the
    caller — the gateway's dispatch path — is never held on the socket.
    """
    try:
        if not isinstance(raw, dict):
            LOG.debug("reaction skipped: invalid event")
            return None
        key = raw.get("readReceiptKey")
        if not isinstance(key, dict):
            LOG.debug("reaction skipped: missing receipt key")
            return None
        msg_id = str(key.get("id") or "").strip()
        remote = str(key.get("remoteJid") or "").strip()
        if not msg_id or not remote:
            LOG.debug("reaction skipped: missing receipt key")
            return None
        chat = str(raw.get("chatId") or remote).strip()
        if _is_ignored_chat(chat) or _is_ignored_chat(remote):
            LOG.debug("reaction skipped: ignored chat")
            return None
        # A bridge that serialised booleans as strings would make "false" True
        # here, and every human message hers — the whole feature silently off.
        from_me = _truthy(key.get("fromMe")) or _truthy(raw.get("fromMe")) or _truthy(raw.get("fromOwner"))
        text = strip_stamp(raw.get("body") or "")
        emoji = choose(text, chat,
                       from_me=from_me, now=now, rng=rng, state=state,
                       chance=chance, cooldown=cooldown, message_id=msg_id)
        if not emoji:
            return None

        def _go():
            try:
                if sender is None:
                    post_reaction(key, emoji, port)
                else:
                    _send_with_retry(sender, key, emoji, port)
            except Exception as exc:
                try:
                    LOG.warning("reaction send failed: error=%s status=none", type(exc).__name__)
                except Exception:
                    pass

        threading.Thread(target=_go, name="aira-react", daemon=True).start()
        return emoji
    except Exception as exc:
        try:
            LOG.warning("reaction dispatch failed: error=%s", type(exc).__name__)
        except Exception:
            pass
        return None
