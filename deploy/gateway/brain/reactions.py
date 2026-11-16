"""AIRA's brain.reactions for passive emoji reactions (docs/trd/system.md#gateway-helper-modules).

Reacts to inbound human WhatsApp messages on a configurable chance and per-chat
cooldown when the core's chats.json enables reactions for that chat.
"""

from __future__ import annotations

import json as _json
import os
import random
import re
import threading
import time
import urllib.request as _urlreq

from brain import chatflags

CHANCE = float(os.environ.get("AIRA_REACTION_CHANCE", "0.33"))
COOLDOWN = int(os.environ.get("AIRA_REACTION_COOLDOWN", "180"))
ENABLED = os.environ.get("AIRA_REACTIONS", "1").strip().lower() not in ("0", "off", "no", "false")

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

_STATE: dict = {}
_LOCK = threading.Lock()
_STAMP = re.compile(r"^\s*\[HERMES-SCOPE[^\]]*\]\n?")


def category(text):
    """The rule this message trips, or None."""
    t = _URL.sub(" ", str(text or ""))
    if not t.strip():
        return None
    for name, pattern, _faces in RULES:
        if pattern.search(t):
            return name
    return None


def _faces_for(name):
    for n, _p, faces in RULES:
        if n == name:
            return faces
    return ()


def choose(text, chat_id, *, from_me=False, now=None, rng=None, state=None,
           chance=None, cooldown=None):
    """The emoji to put on this message, or None. Pure apart from `state`."""
    if not ENABLED:
        return None
    if from_me:
        return None
    body = str(text or "").strip()
    if not body or body.startswith("/"):
        return None
    chat = str(chat_id or "").strip()
    if not chat:
        return None
    if not chatflags.reactions_on(chat):
        return None
    name = category(body)
    if name is None:
        return None
    now = time.time() if now is None else now
    st = _STATE if state is None else state
    with _LOCK:
        last = st.get(("at", chat), 0)
        if now - last < (COOLDOWN if cooldown is None else cooldown):
            return None
        r = rng if rng is not None else random
        if r.random() >= (CHANCE if chance is None else chance):
            return None
        faces = list(_faces_for(name))
        prev = st.get(("face", chat, name))
        options = [f for f in faces if f != prev] or faces
        face = r.choice(options)
        st[("at", chat)] = now
        st[("face", chat, name)] = face
        return face


def _truthy(v):
    if isinstance(v, str):
        return v.strip().lower() in ("true", "1", "yes")
    return bool(v)


def strip_stamp(text):
    """The message without the scope marker the adapter prepends."""
    return _STAMP.sub("", str(text or ""), count=1)


def bridge_port(default=3000):
    try:
        return int(os.environ.get("AIRA_BRIDGE_PORT") or default)
    except ValueError:
        return default


def post_reaction(key, emoji, port=None, timeout=5.0):
    """POST /react to the loopback WhatsApp bridge. True on 2xx."""
    body = _json.dumps({"key": key, "emoji": emoji}).encode("utf-8")
    req = _urlreq.Request(
        f"http://127.0.0.1:{port or bridge_port()}/react", data=body,
        headers={"Content-Type": "application/json"}, method="POST")
    with _urlreq.urlopen(req, timeout=timeout) as resp:
        return 200 <= resp.status < 300


def react_to(raw, *, port=None, sender=None, now=None, rng=None, state=None,
             chance=None, cooldown=None):
    """Decide on, and fire, a reaction to one inbound bridge event.

    `raw` is the bridge's event dict (the adapter's raw_message). Returns
    the emoji it chose, or None. The send runs on a daemon thread so the
    caller — the gateway's dispatch path — is never held on the socket.
    """
    if not isinstance(raw, dict):
        return None
    key = raw.get("readReceiptKey")
    if not isinstance(key, dict) or not key.get("id") or not key.get("remoteJid"):
        return None
    # A bridge that serialised booleans as strings would make "false" True
    # here, and every human message hers — the whole feature silently off.
    from_me = _truthy(key.get("fromMe")) or _truthy(raw.get("fromOwner"))
    text = strip_stamp(raw.get("body") or "")
    emoji = choose(text, raw.get("chatId") or key.get("remoteJid"),
                   from_me=from_me, now=now, rng=rng, state=state,
                   chance=chance, cooldown=cooldown)
    if not emoji:
        return None
    send = sender or post_reaction

    def _go():
        try:
            send(key, emoji, port)
        except Exception:
            pass
    threading.Thread(target=_go, name="aira-react", daemon=True).start()
    return emoji
