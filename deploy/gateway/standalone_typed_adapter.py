# Appended to the exact reviewed v1 helper only for an explicitly selected v2 route.

from datetime import datetime

ROUTE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")


def _route_id(value):
    return isinstance(value, str) and ROUTE_ID.fullmatch(value) is not None


def read_typed_marker(path):
    path = Path(path).absolute()
    if path.resolve(strict=False) != path:
        raise ValueError("invalid marker location")
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    with os.fdopen(fd, "rb") as handle:
        info = os.fstat(handle.fileno())
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_mode & 0o777 != 0o600:
            raise ValueError("invalid marker permissions")
        raw = handle.read(4097)
    if len(raw) > 4096:
        raise ValueError("marker too large")
    value = json.loads(raw, object_pairs_hook=_unique)
    if (not isinstance(value, dict) or set(value) != {"schemaVersion", "profile", "profileHome", "port", "token",
           "state", "routeId", "capabilities"} or type(value["schemaVersion"]) is not int or value["schemaVersion"] != 2
            or not isinstance(value["profile"], str) or not PROFILE.fullmatch(value["profile"])
            or value["profileHome"] != str(path.parent)
            or (value["profile"] != "default" and (path.parent.name != value["profile"] or path.parent.parent.name != "profiles"))
            or type(value["port"]) is not int or not 1 <= value["port"] <= 65535
            or not isinstance(value["token"], str) or not TOKEN.fullmatch(value["token"])
            or value["capabilities"] != ["text"]
            or not ((value["state"] == "provisional" and value["routeId"] is None)
                    or (value["state"] == "active" and _route_id(value["routeId"])))):
        raise ValueError("invalid typed marker")
    return value


def _typed_receipt(response, profile):
    if (not isinstance(response, dict) or set(response) != {"schemaVersion", "hermes"}
            or type(response["schemaVersion"]) is not int or response["schemaVersion"] != 2):
        return None
    receipt = response["hermes"]
    if (not isinstance(receipt, dict) or set(receipt) != {"state", "profile", "adapterVersion", "verifiedAt",
            "protocolVersion", "routeId", "capabilities"} or receipt["state"] != "connected"
            or receipt["profile"] != profile or receipt["adapterVersion"] != ADAPTER_VERSION
            or type(receipt["protocolVersion"]) is not int or receipt["protocolVersion"] != 2
            or receipt["capabilities"] != ["text"] or not _route_id(receipt["routeId"])
            or not isinstance(receipt["verifiedAt"], str)):
        return None
    try:
        if datetime.fromisoformat(receipt["verifiedAt"].replace("Z", "+00:00")).tzinfo is None:
            return None
    except ValueError:
        return None
    return receipt


def typed_check(marker):
    try:
        config = read_typed_marker(marker)
        response = _post(config, "/v2/aira/attach-check", {"schemaVersion": 2, "adapterVersion": ADAPTER_VERSION,
                         "profile": config["profile"], "action": "connect", "capabilities": ["text"]}, 15)
        receipt = _typed_receipt(response, config["profile"])
        if receipt and (config["routeId"] is None or config["routeId"] == receipt["routeId"]):
            return receipt
    except Exception:
        pass
    return None


def _descriptor(response):
    if (not isinstance(response, dict) or set(response) != {"schemaVersion", "disposition", "deliveries"}
            or type(response["schemaVersion"]) is not int or response["schemaVersion"] != 2
            or response["disposition"] != "reply" or not isinstance(response["deliveries"], list)
            or len(response["deliveries"]) != 1):
        return None
    delivery = response["deliveries"][0]
    if (not isinstance(delivery, dict) or set(delivery) != {"id", "kind"}
            or delivery["kind"] != "text" or not _route_id(delivery["id"])):
        return None
    return delivery["id"]


def _claimed_text(response, delivery_id):
    if (not isinstance(response, dict) or set(response) != {"schemaVersion", "delivery"}
            or type(response["schemaVersion"]) is not int or response["schemaVersion"] != 2):
        return None
    delivery = response["delivery"]
    if (not isinstance(delivery, dict) or set(delivery) != {"id", "kind", "text"}
            or delivery["id"] != delivery_id or delivery["kind"] != "text"):
        return None
    return _reply({"schemaVersion": 1, "disposition": "reply", "reply": delivery["text"]})


async def _typed_post(config, path, payload, timeout):
    return await asyncio.wait_for(asyncio.to_thread(_post, config, path, payload, timeout), timeout=timeout + 5)


async def route_typed(marker, event, source, runner):
    """Consume the admitted event; native delivery is performed here, never by default reply fallback."""
    try:
        config = read_typed_marker(marker)
        if (config["state"] != "active" or _value(source.platform) != "whatsapp" or source.chat_type not in ("dm", "group")
                or event.internal or event.media_urls or event.media_types or event.reply_expected is False
                or event.metadata.get("whatsapp_from_owner") is True or _value(event.message_type) != "text"
                or getattr(source, "is_bot", False)):
            return None
        sender = event.sender_id()
        if not all(isinstance(v, str) and IDENTITY.fullmatch(v) for v in (source.chat_id, sender, event.message_id)):
            return None
        if source.user_id not in (None, "", sender) or source.chat_id.lower().endswith("@broadcast"):
            return None
        if not isinstance(event.text, str) or not event.text.strip() or not _text_fits(event.text):
            return None
        base = {"schemaVersion": 2, "profile": config["profile"], "routeId": config["routeId"],
                "chat": source.chat_id, "mid": event.message_id}
        response = await _typed_post(config, "/v2/aira/turn", {**base, "platform": "whatsapp",
                                     "kind": source.chat_type, "sender": sender, "text": event.text}, 115)
        delivery_id = _descriptor(response)
        if delivery_id is None:
            return None
        binding = {**base, "id": delivery_id}
        claimed = await _typed_post(config, "/v2/aira/delivery/claim", binding, 15)
        text = _claimed_text(claimed, delivery_id)
        if text is None:
            return None
        # A claim authorizes exactly one native send. Stock may report a failed or ambiguous transport
        # result after partial delivery. Do not retry either case; acknowledge uncertainty conservatively.
        target = runner._delivery_adapter_for(source)
        outcome = "failed" if target is None else "unknown"
        if target is not None:
            try:
                result = await target.send(source.chat_id, text)
                message_id = getattr(result, "message_id", None)
                if getattr(result, "success", None) is True and isinstance(message_id, str) and message_id.strip():
                    outcome = "confirmed"
            except asyncio.CancelledError:
                raise
            except Exception:
                pass
        await _typed_post(config, "/v2/aira/delivery/ack", {**binding, "outcome": outcome}, 15)
    except asyncio.CancelledError:
        raise
    except Exception:
        logging.getLogger(__name__).warning("aira.adapter.typed_route_unavailable")
    return None
