# Appended only to the exact document helper for the direct-media generation.

CAPABILITIES = ["text", "document", "receive-image", "receive-audio", "receive-video", "receive-pdf"]
MAX_MEDIA = 5 * 1024 * 1024
MAX_MEDIA_REQUEST = 4 * ((MAX_MEDIA + 2) // 3) + MAX_RESPONSE
MEDIA_KINDS = {
    ("imageMessage", "image", "photo"): "image",
    ("audioMessage", "audio", "audio"): "audio",
    ("audioMessage", "ptt", "voice"): "voice",
    ("pttMessage", "ptt", "voice"): "voice",
    ("videoMessage", "video", "video"): "video",
    ("documentMessage", "document", "document"): "document",
}
MEDIA_TYPES = {
    "image": ("image/png", "image/jpeg"),
    "audio": ("audio/ogg", "audio/mpeg"),
    "voice": ("audio/ogg", "audio/mpeg"),
    "video": ("video/mp4",),
    "document": ("application/pdf",),
}
MEDIA_CACHE = {"image": ("image_cache", "cache/images"), "audio": ("audio_cache", "cache/audio"),
               "voice": ("audio_cache", "cache/audio"), "video": ("document_cache", "cache/documents"),
               "document": ("document_cache", "cache/documents")}


def _native_event(config, event, source):
    raw = event.raw_message
    sender = event.sender_id()
    if (not isinstance(raw, dict) or _value(source.platform) != "whatsapp"
            or source.chat_type not in ("dm", "group") or event.internal or event.reply_expected is False
            or event.metadata.get("whatsapp_from_owner") or raw.get("fromOwner")
            or getattr(source, "is_bot", False)
            or not all(isinstance(v, str) and IDENTITY.fullmatch(v) for v in (source.chat_id, sender, event.message_id))
            or source.user_id not in (None, "", sender) or source.chat_id.lower().endswith(("@broadcast", "@newsletter"))
            or getattr(source, "profile", None) not in (None, "", config["profile"])
            or getattr(event.source, "profile", None) not in (None, "", config["profile"])
            or (event.source.chat_id, event.source.chat_type, _value(event.source.platform)) !=
                (source.chat_id, source.chat_type, "whatsapp")
            or event.source.user_id not in (None, "", sender)
            or getattr(source, "message_id", None) not in (None, event.message_id)
            or getattr(event.source, "message_id", None) not in (None, event.message_id)
            or (raw.get("chatId"), raw.get("senderId"), raw.get("messageId")) !=
                (source.chat_id, sender, event.message_id)
            or raw.get("isGroup") is not (source.chat_type == "group")
            or raw.get("hasQuotedMessage", False) is not False
            or any(raw.get(key) for key in ("quotedMessageId", "quotedParticipant", "quotedRemoteJid", "quotedText",
                                           "quotedMediaUrls", "quotedMediaType"))
            or any(getattr(event, key, None) for key in ("reply_to_message_id", "reply_to_text", "reply_to_author_id",
                                                        "reply_to_author_name", "reply_to_is_own_message"))):
        return None
    native = raw.get("nativeType")
    metadata = raw.get("nativeMetadata", {})
    if (not isinstance(native, str) or native != event.metadata.get("whatsapp_native_type")
            or not isinstance(metadata, dict) or metadata != event.metadata.get("whatsapp_native", {})):
        return None
    return raw, sender, native, metadata


def _native_body(raw):
    # Match only stock's native body normalization (including group mention removal).
    # A batched, rewritten or inlined normalized body is not a new native event.
    text = raw.get("body")
    if not isinstance(text, str):
        raise ValueError("invalid native body")
    if raw["isGroup"] and text:
        cleaned = text
        for bot in raw.get("botIds") or []:
            bare = re.sub(r":\d+(?=@)", "", str(bot).strip()).split("@", 1)[0]
            if bare:
                cleaned = re.sub(rf"@{re.escape(bare)}\b[,:\-]*\s*", "", cleaned)
        text = cleaned.strip() or text
    return text


def _read_cache_file(home, kind, name):
    # Use a dir-fd walk with NOFOLLOW on every component. No path supplied by the
    # bridge can authorize a read outside the selected profile's immediate cache.
    if not isinstance(name, str):
        return None
    path = Path(name)
    home = Path(home)
    if (not path.is_absolute() or str(path) != name or ".." in path.parts
            or path.parent not in tuple(home / folder for folder in MEDIA_CACHE[kind])):
        return None
    flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW
    fd = os.open("/", flags)
    try:
        for index, component in enumerate(path.parent.parts[1:], 1):
            child = os.open(component, flags, dir_fd=fd)
            os.close(fd)
            fd = child
            if index >= len(home.parts) - 1 and os.fstat(fd).st_uid != os.geteuid():
                return None
        before = os.stat(path.name, dir_fd=fd, follow_symlinks=False)
        if (not stat.S_ISREG(before.st_mode) or before.st_uid != os.geteuid()
                or before.st_nlink != 1 or not 0 < before.st_size <= MAX_MEDIA):
            return None
        file_fd = os.open(path.name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=fd)
        with os.fdopen(file_fd, "rb") as handle:
            info = os.fstat(handle.fileno())
            if (not stat.S_ISREG(info.st_mode) or info.st_uid != os.geteuid() or info.st_nlink != 1
                    or (info.st_dev, info.st_ino, info.st_size) != (before.st_dev, before.st_ino, before.st_size)):
                return None
            data = handle.read(info.st_size)
            after = os.fstat(handle.fileno())
            if len(data) != info.st_size or after.st_size != info.st_size or after.st_mtime_ns != info.st_mtime_ns:
                return None
            return data
    finally:
        os.close(fd)


def _media_signature(mime, data):
    if mime == "image/png":
        return data.startswith(b"\x89PNG\r\n\x1a\n")
    if mime == "image/jpeg":
        return data.startswith(b"\xff\xd8\xff")
    if mime == "audio/ogg":
        return data.startswith(b"OggS")
    if mime == "audio/mpeg":
        return data.startswith(b"ID3") or (len(data) >= 2 and data[0] == 0xff and data[1] & 0xe0 == 0xe0)
    if mime == "video/mp4":
        return len(data) >= 12 and data[4:8] == b"ftyp"
    return mime == "application/pdf" and data.startswith(b"%PDF-")


def _media_input(config, raw, native, metadata, event):
    bridge_kind = raw.get("mediaType")
    kind = MEDIA_KINDS.get((native, bridge_kind, _value(event.message_type)))
    if (kind is None or raw.get("hasMedia") is not True or not isinstance(raw.get("mime"), str)
            or not isinstance(raw.get("mediaUrls"), list) or len(raw["mediaUrls"]) != 1
            or event.media_urls != raw["mediaUrls"] or event.media_types != [raw["mime"]]):
        return None
    # Stock skips document text injection for command captions; both representations mean no inline content.
    flags = event.media_text_inlined
    if flags != [] and not (kind == "document" and isinstance(flags, list) and len(flags) == 1 and flags[0] is False):
        return None
    expected = ({"audio": {"ptt": kind == "voice"}} if kind in ("audio", "voice")
                else {"video": {"gifPlayback": False}} if kind == "video" else {})
    if metadata != expected:
        return None
    if kind in ("audio", "voice") and metadata["audio"]["ptt"] is not (kind == "voice"):
        return None
    if kind == "video" and metadata["video"]["gifPlayback"] is not False:
        return None
    mime = "audio/ogg" if raw["mime"] == "audio/ogg; codecs=opus" else raw["mime"]
    if mime not in MEDIA_TYPES[kind]:
        return None
    body = _native_body(raw)
    if kind == "voice" and body.strip().lower() == "[ptt received]":
        body = ""
    if event.text != body or not _text_fits(body):
        return None
    text = "[attachment]" if not body.strip() or body == f"[{bridge_kind} received]" else body
    data = _read_cache_file(config["profileHome"], kind, raw["mediaUrls"][0])
    if data is None or not _media_signature(mime, data):
        return None
    return text, {"kind": kind, "mime": mime, "sha256": hashlib.sha256(data).hexdigest(),
                  "base64": base64.b64encode(data).decode("ascii")}


def _post_media(config, path, payload, timeout):
    if path != "/v2/aira/media-turn":
        return None
    connection = http.client.HTTPConnection("127.0.0.1", config["port"], timeout=timeout)
    try:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        if len(encoded) > MAX_MEDIA_REQUEST:
            return None
        connection.request("POST", path, encoded, {
            "Content-Type": "application/json", "Authorization": "Bearer " + config["token"]
        })
        response = connection.getresponse()
        data = response.read(MAX_RESPONSE + 1)
        if response.status != 200 or len(data) > MAX_RESPONSE:
            return None
        return json.loads(data, object_pairs_hook=_unique)
    finally:
        connection.close()


async def route_typed(marker, event, source, runner):
    """An exact native event may authorize one typed turn; delivery never falls through."""
    try:
        config = read_typed_marker(marker)
        if config["state"] != "active":
            return None
        admitted = _native_event(config, event, source)
        if admitted is None:
            return None
        raw, sender, native, metadata = admitted
        base = {"schemaVersion": 2, "profile": config["profile"], "routeId": config["routeId"],
                "chat": source.chat_id, "mid": event.message_id}
        payload = {**base, "platform": "whatsapp", "kind": source.chat_type, "sender": sender}
        if native in ("conversation", "extendedTextMessage"):
            if (_value(event.message_type) != "text" or metadata or raw.get("hasMedia") is not False
                    or raw.get("mediaType") != "" or raw.get("mime") != "" or raw.get("mediaUrls") != []
                    or event.media_urls != [] or event.media_types != [] or event.media_text_inlined != []
                    or event.text != _native_body(raw) or not event.text.strip() or not _text_fits(event.text)):
                return None
            response = await _typed_post(config, "/v2/aira/turn", {**payload, "text": event.text}, 115)
        else:
            media_input = _media_input(config, raw, native, metadata, event)
            if media_input is None:
                return None
            text, media = media_input
            response = await asyncio.wait_for(asyncio.to_thread(
                _post_media, config, "/v2/aira/media-turn", {**payload, "text": text, "media": media}, 115), timeout=120)
        deliveries = _descriptors(response)
        if deliveries is None:
            return None
        target = runner._delivery_adapter_for(source)
        for delivery in deliveries:
            binding = {**base, "id": delivery["id"]}
            if delivery["kind"] == "text":
                claimed = await _typed_post(config, "/v2/aira/delivery/claim", binding, 15)
                result_payload = _claimed_text(claimed, delivery["id"])
            else:
                claimed = await asyncio.wait_for(asyncio.to_thread(
                    _post_document_claim, config, "/v2/aira/delivery/claim", binding, 15), timeout=20)
                result_payload = _claimed_document(claimed, delivery["id"])
            if result_payload is None:
                continue
            outcome = "failed" if target is None else "unknown"
            if target is not None:
                try:
                    if delivery["kind"] == "text":
                        result = await target.send(source.chat_id, result_payload)
                    else:
                        result = await _send_document(target, source.chat_id, *result_payload)
                    message_id = getattr(result, "message_id", None)
                    if getattr(result, "success", None) is True and isinstance(message_id, str) and message_id.strip():
                        outcome = "confirmed"
                except asyncio.CancelledError:
                    raise
                except Exception:
                    pass
            try:
                await _typed_post(config, "/v2/aira/delivery/ack", {**binding, "outcome": outcome}, 15)
            except asyncio.CancelledError:
                raise
            except Exception:
                logging.getLogger(__name__).warning("aira.adapter.typed_ack_unavailable")
    except asyncio.CancelledError:
        raise
    except Exception:
        logging.getLogger(__name__).warning("aira.adapter.typed_route_unavailable")
    return None
