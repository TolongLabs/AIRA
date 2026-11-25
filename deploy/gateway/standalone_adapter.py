"""Pinned public Hermes text adapter, installed as gateway/aira_transport.py.

Only trusted normalized event fields become identity. An attached event is consumed
even on failure; the caller's pinned insertion never falls through to Hermes.
"""

from __future__ import annotations

import argparse
import asyncio
import http.client
import json
import os
import re
import stat
import sys

ADAPTER_VERSION = "hermes-v0.23.4"
MARKER_NAME = "aira-transport.json"
PROFILE = re.compile(r"^[a-z0-9][a-z0-9_-]{0,63}$")
IDENTITY = re.compile(r"^[A-Za-z0-9@._:+-]{1,256}$")
TOKEN = re.compile(r"^[0-9a-f]{64}$")
MAX_RESPONSE = 65_536


def _unique(pairs):
    result = {}
    for key, value in pairs:
        if key in result:
            raise ValueError("duplicate key")
        result[key] = value
    return result


def read_marker(path):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o777 != 0o600:
            raise ValueError("invalid marker permissions")
        raw = handle.read(4097)
    if len(raw) > 4096:
        raise ValueError("marker too large")
    value = json.loads(raw, object_pairs_hook=_unique)
    if not isinstance(value, dict) or set(value) != {"schemaVersion", "profile", "port", "token"}:
        raise ValueError("invalid marker")
    if (type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
        or not isinstance(value["profile"], str) or not PROFILE.fullmatch(value["profile"])
        or type(value["port"]) is not int or not 1 <= value["port"] <= 65535
        or not isinstance(value["token"], str) or not TOKEN.fullmatch(value["token"])):
        raise ValueError("invalid marker")
    return value


def _post(config, path, payload, timeout):
    connection = http.client.HTTPConnection("127.0.0.1", config["port"], timeout=timeout)
    try:
        connection.request("POST", path, json.dumps(payload).encode("utf-8"), {
            "Content-Type": "application/json", "Authorization": "Bearer " + config["token"]
        })
        response = connection.getresponse()
        data = response.read(MAX_RESPONSE + 1)
        if response.status != 200 or len(data) > MAX_RESPONSE:
            return None
        return json.loads(data, object_pairs_hook=_unique)
    finally:
        connection.close()


def _value(value):
    return getattr(value, "value", value)


def _reply(value):
    if (not isinstance(value, dict) or set(value) != {"schemaVersion", "disposition", "reply"}
        or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 1
        or value["disposition"] != "reply"):
        return None
    reply = value["reply"]
    if (not isinstance(reply, str) or not reply.strip() or len(reply) > 32_768
        or reply.strip() == "NO_REPLY" or any(line.startswith("MEDIA:") for line in reply.splitlines())):
        return None
    return reply


async def route(marker, event, source):
    try:
        config = read_marker(marker)
        if (_value(source.platform) != "whatsapp" or source.chat_type not in ("dm", "group")
            or event.internal or event.media_urls or event.reply_expected is False
            or _value(event.message_type) != "text" or getattr(source, "is_bot", False)):
            return None
        sender = event.sender_id()
        if not all(isinstance(v, str) and IDENTITY.fullmatch(v)
                   for v in (source.chat_id, sender, event.message_id)):
            return None
        if not isinstance(event.text, str) or not event.text.strip() or len(event.text) > 32_768:
            return None
        payload = {
            "schemaVersion": 1, "profile": config["profile"], "platform": "whatsapp",
            "kind": source.chat_type, "chat": source.chat_id, "sender": sender,
            "mid": event.message_id, "text": event.text,
        }
        response = await asyncio.wait_for(
            asyncio.to_thread(_post, config, "/v1/aira/turn", payload, 55), timeout=60
        )
        return _reply(response)
    except asyncio.CancelledError:
        raise
    except Exception:
        # No exception content or message text is logged. The pinned caller consumes this event.
        return None


def check(marker, action):
    try:
        config = read_marker(marker)
        response = _post(config, "/v1/aira/attach-check", {
            "schemaVersion": 1, "adapterVersion": ADAPTER_VERSION,
            "profile": config["profile"], "action": action,
        }, 15)
        if not isinstance(response, dict) or set(response) != {"schemaVersion", "hermes"} or response["schemaVersion"] != 1:
            return False
        status = response["hermes"]
        if not isinstance(status, dict):
            return False
        if action == "connect":
            return (status.get("state") == "connected" and status.get("profile") == config["profile"]
                    and status.get("adapterVersion") == ADAPTER_VERSION and isinstance(status.get("verifiedAt"), str))
        return status.get("state") == "disconnected"
    except Exception:
        return False


def main(argv=None):
    parser = argparse.ArgumentParser(description="Verify the installed adapter's local route; no messages are sent.")
    group = parser.add_mutually_exclusive_group(required=True)
    group.add_argument("--check")
    group.add_argument("--disconnect")
    args = parser.parse_args(argv)
    return 0 if check(args.check or args.disconnect, "connect" if args.check else "disconnect") else 1


if __name__ == "__main__":
    sys.exit(main())
