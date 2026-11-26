# Appended to the exact reviewed v1 helper for an explicitly selected document-capable v2 route.

from datetime import datetime
import base64
import hashlib
import tempfile
import time

ROUTE_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
CAPABILITIES = ["text", "document"]
MAX_DOCUMENT = 5 * 1024 * 1024
MAX_DOCUMENT_BASE64 = 4 * ((MAX_DOCUMENT + 2) // 3)
MAX_DOCUMENT_RESPONSE = MAX_DOCUMENT_BASE64 + 1024
DOCUMENT_TYPES = {"application/pdf": "report.pdf", "text/markdown": "report.md"}
SHA256 = re.compile(r"^[0-9a-f]{64}$")


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
            or value["capabilities"] != CAPABILITIES
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
            or receipt["capabilities"] != CAPABILITIES or not _route_id(receipt["routeId"])
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
                         "profile": config["profile"], "action": "connect", "capabilities": CAPABILITIES,
                         "deadlineMs": int(time.time() * 1000) + 10_000}, 15)
        receipt = _typed_receipt(response, config["profile"])
        if receipt and (config["routeId"] is None or config["routeId"] == receipt["routeId"]):
            return receipt
    except Exception:
        pass
    return None


def typed_downgrade(marker, route_id):
    """Explicitly end the current typed route without publishing a live v1 marker."""
    try:
        config = read_typed_marker(marker)
        if config["state"] != "provisional" or not _route_id(route_id):
            return None
        response = _post(config, "/v2/aira/attach-check", {"schemaVersion": 2, "adapterVersion": ADAPTER_VERSION,
                         "profile": config["profile"], "action": "downgrade", "routeId": route_id,
                         "deadlineMs": int(time.time() * 1000) + 10_000}, 15)
        if (not isinstance(response, dict) or set(response) != {"schemaVersion", "hermes"}
                or type(response["schemaVersion"]) is not int or response["schemaVersion"] != 2):
            return None
        route = response["hermes"]
        if (isinstance(route, dict) and set(route) == {"state", "profile", "adapterVersion", "verifiedAt"}
                and route["state"] == "connected" and route["profile"] == config["profile"]
                and route["adapterVersion"] == ADAPTER_VERSION and isinstance(route["verifiedAt"], str)):
            return route
    except Exception:
        pass
    return None


def _descriptors(response):
    if (not isinstance(response, dict) or set(response) != {"schemaVersion", "disposition", "deliveries"}
            or type(response["schemaVersion"]) is not int or response["schemaVersion"] != 2
            or response["disposition"] != "reply" or not isinstance(response["deliveries"], list)
            or len(response["deliveries"]) not in (1, 2)):
        return None
    deliveries = response["deliveries"]
    for delivery, kind in zip(deliveries, CAPABILITIES):
        if (not isinstance(delivery, dict) or set(delivery) != {"id", "kind"}
                or delivery["kind"] != kind or not _route_id(delivery["id"])):
            return None
    if len({delivery["id"] for delivery in deliveries}) != len(deliveries):
        return None
    return deliveries


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


def _post_document_claim(config, path, payload, timeout):
    if path != "/v2/aira/delivery/claim":
        return None
    connection = http.client.HTTPConnection("127.0.0.1", config["port"], timeout=timeout)
    try:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(encoded) > MAX_RESPONSE:
            return None
        connection.request("POST", path, encoded, {
            "Content-Type": "application/json", "Authorization": "Bearer " + config["token"]
        })
        response = connection.getresponse()
        if response.status != 200:
            return None
        data = response.read(MAX_DOCUMENT_RESPONSE + 1)
        if len(data) > MAX_DOCUMENT_RESPONSE:
            return None
        return json.loads(data, object_pairs_hook=_unique)
    finally:
        connection.close()


def _claimed_document(response, delivery_id):
    if (not isinstance(response, dict) or set(response) != {"schemaVersion", "delivery"}
            or type(response["schemaVersion"]) is not int or response["schemaVersion"] != 2):
        return None
    delivery = response["delivery"]
    if (not isinstance(delivery, dict) or set(delivery) != {"id", "kind", "mime", "filename", "sha256", "base64"}
            or delivery["id"] != delivery_id or delivery["kind"] != "document"
            or not isinstance(delivery["mime"], str) or delivery["mime"] not in DOCUMENT_TYPES
            or delivery["filename"] != DOCUMENT_TYPES[delivery["mime"]]
            or not isinstance(delivery["sha256"], str) or not SHA256.fullmatch(delivery["sha256"])
            or not isinstance(delivery["base64"], str) or len(delivery["base64"]) > MAX_DOCUMENT_BASE64):
        return None
    try:
        data = base64.b64decode(delivery["base64"], validate=True)
        if (not 0 < len(data) <= MAX_DOCUMENT or base64.b64encode(data).decode("ascii") != delivery["base64"]
                or hashlib.sha256(data).hexdigest() != delivery["sha256"]):
            return None
        if delivery["mime"] == "application/pdf" and not data.startswith(b"%PDF-"):
            return None
        if delivery["mime"] == "text/markdown" and "\0" in data.decode("utf-8"):
            return None
    except (ValueError, UnicodeError):
        return None
    return delivery["filename"], data


async def _send_document(target, chat, filename, data):
    # The name was selected from the finite MIME/name pair, never a supplied path.
    with tempfile.TemporaryDirectory(prefix="aira-report-") as folder:
        os.chmod(folder, 0o700)
        path = Path(folder) / filename
        fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, "wb") as file:
            os.fchmod(file.fileno(), 0o600)
            file.write(data)
        return await target.send_document(chat, str(path), file_name=filename)


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
        deliveries = _descriptors(response)
        if deliveries is None:
            return None
        target = runner._delivery_adapter_for(source)
        for delivery in deliveries:
            binding = {**base, "id": delivery["id"]}
            if delivery["kind"] == "text":
                claimed = await _typed_post(config, "/v2/aira/delivery/claim", binding, 15)
                payload = _claimed_text(claimed, delivery["id"])
            else:
                claimed = await asyncio.wait_for(asyncio.to_thread(
                    _post_document_claim, config, "/v2/aira/delivery/claim", binding, 15), timeout=20)
                payload = _claimed_document(claimed, delivery["id"])
            if payload is None:
                continue
            # Each successful claim authorizes one native send to the original chat, no retry.
            outcome = "failed" if target is None else "unknown"
            if target is not None:
                try:
                    if delivery["kind"] == "text":
                        result = await target.send(source.chat_id, payload)
                    else:
                        result = await _send_document(target, source.chat_id, *payload)
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
