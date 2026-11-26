# Appended only to the exact direct-media helper for the scheduler generation.

CAPABILITIES = ["text", "document", "receive-image", "receive-audio", "receive-video", "receive-pdf", "scheduler"]
SCHEDULE_POLL_SECONDS = 5
SCHEDULE_STARTUP_SECONDS = 0.1
_SCHEDULE_REFUSED = object()


def _schedule_config(adapter, marker, runner):
    """The owning native adapter's exact active profile marker, never ambient profile state."""
    try:
        home = Path(adapter._profile_home)
        if (runner is None or adapter.gateway_runner is not runner
                or _value(adapter.platform) != "whatsapp" or not home.is_absolute()
                or Path(marker) != home / MARKER_NAME or home.resolve(strict=False) != home
                or runner.config.multiplex_profiles is not False
                or runner._draining is not False or adapter._shutting_down is not False
                or getattr(adapter, "_runtime_status_platform_key", None)
                or (runner.adapters.get(adapter.platform) is not None
                    and runner.adapters.get(adapter.platform) is not adapter)):
            return None
        config = read_typed_marker(marker)
        if config["state"] == "active" and config["profile"] == runner._primary_profile_name:
            return config
    except Exception:
        pass
    return None


def _schedule_ready(adapter, runner):
    try:
        return (runner._running is True and runner.adapters.get(adapter.platform) is adapter
                and adapter._running is True and adapter.is_connected is True)
    except Exception:
        return False


def _schedule_delivery(response):
    if (not isinstance(response, dict) or set(response) != {"schemaVersion", "delivery"}
            or type(response["schemaVersion"]) is not int or response["schemaVersion"] != 2):
        return None
    return response["delivery"]


def _schedule_descriptor(response):
    delivery = _schedule_delivery(response)
    if (isinstance(delivery, dict) and set(delivery) == {"id", "kind"}
            and delivery["kind"] == "text" and _route_id(delivery["id"])):
        return delivery["id"]
    return None


def _schedule_claimed(response, delivery_id):
    delivery = _schedule_delivery(response)
    if (not isinstance(delivery, dict) or set(delivery) != {"id", "kind", "chat", "text"}
            or delivery["id"] != delivery_id or delivery["kind"] != "text"):
        return None
    chat = delivery["chat"]
    if (not isinstance(chat, str) or not IDENTITY.fullmatch(chat)
            or chat.lower().endswith(("@broadcast", "@newsletter"))):
        return None
    try:
        text = _reply({"schemaVersion": 1, "disposition": "reply", "reply": delivery["text"]})
    except (ValueError, UnicodeError):
        return None
    return (chat, text) if text is not None else None


def _post_schedule(config, path, payload, timeout):
    """Keep scheduler authentication refusal distinct from an unavailable local endpoint."""
    if path not in ("/v2/aira/reminders/poll", "/v2/aira/reminders/claim", "/v2/aira/reminders/ack"):
        return None
    encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    if len(encoded) > MAX_RESPONSE:
        return None
    connection = http.client.HTTPConnection("127.0.0.1", config["port"], timeout=timeout)
    try:
        connection.request("POST", path, encoded, {
            "Content-Type": "application/json", "Authorization": "Bearer " + config["token"]
        })
        response = connection.getresponse()
        if response.status in (401, 403):
            return _SCHEDULE_REFUSED
        if response.status != 200:
            return None
        data = response.read(MAX_RESPONSE + 1)
        if len(data) > MAX_RESPONSE:
            return None
        return json.loads(data, object_pairs_hook=_unique)
    finally:
        connection.close()


async def _schedule_request(config, path, payload, timeout):
    return await asyncio.wait_for(asyncio.to_thread(_post_schedule, config, path, payload, timeout),
                                  timeout=timeout + 5)


async def _schedule_post(config, action, payload, timeout):
    try:
        response = await _schedule_request(config, "/v2/aira/reminders/" + action, payload, timeout)
        if response is _SCHEDULE_REFUSED:
            logging.getLogger(__name__).warning("aira.adapter.schedule_authority_refused")
        return response
    except asyncio.CancelledError:
        raise
    except Exception:
        logging.getLogger(__name__).warning("aira.adapter.schedule_request_unavailable")
        return None


async def _schedule_poll(adapter, marker, runner, config):
    scope = {"schemaVersion": 2, "profile": config["profile"], "routeId": config["routeId"]}
    ready = False
    last_attempted = None

    def authorized():
        return _schedule_config(adapter, marker, runner) == config and _schedule_ready(adapter, runner)

    while _schedule_config(adapter, marker, runner) == config:
        if not _schedule_ready(adapter, runner):
            if ready:
                return
            # Both fresh and adopted stock bridges attach before runner startup publishes the adapter.
            await asyncio.sleep(SCHEDULE_STARTUP_SECONDS)
            continue
        ready = True
        response = await _schedule_post(config, "poll", scope, 115)
        if response is _SCHEDULE_REFUSED:
            return
        delivery_id = _schedule_descriptor(response)
        if delivery_id is not None and delivery_id != last_attempted:
            if not authorized():
                return
            # Poll can repeat a lost descriptor; never repeat a claim attempt for the same pending item.
            last_attempted = delivery_id
            binding = {**scope, "id": delivery_id}
            response = await _schedule_post(config, "claim", binding, 15)
            if response is _SCHEDULE_REFUSED:
                return
            claimed = _schedule_claimed(response, delivery_id)
            if claimed is not None:
                if not authorized():
                    return
                chat, text = claimed
                outcome = "unknown"
                try:
                    result = await adapter.send(chat, text)
                    message_id = getattr(result, "message_id", None)
                    if getattr(result, "success", None) is True and isinstance(message_id, str) and message_id.strip():
                        outcome = "confirmed"
                except asyncio.CancelledError:
                    raise
                except Exception:
                    logging.getLogger(__name__).warning("aira.adapter.schedule_send_unavailable")
                if not authorized():
                    return
                ack = await _schedule_post(config, "ack", {**binding, "outcome": outcome}, 15)
                if ack is _SCHEDULE_REFUSED:
                    return
                if (not isinstance(ack, dict) or set(ack) != {"schemaVersion", "accepted"}
                        or type(ack["schemaVersion"]) is not int or ack["schemaVersion"] != 2
                        or ack["accepted"] is not True):
                    logging.getLogger(__name__).warning("aira.adapter.schedule_ack_unavailable")
        await asyncio.sleep(SCHEDULE_POLL_SECONDS)


def start_schedule_poll(adapter, marker):
    """Start and retain at most one poll task for the exact owning stock adapter."""
    runner = getattr(adapter, "gateway_runner", None)
    config = _schedule_config(adapter, marker, runner)
    if config is None:
        return None
    retained = getattr(adapter, "_aira_schedule_task", None)
    if isinstance(retained, asyncio.Task) and not retained.done():
        return retained
    try:
        task = asyncio.get_running_loop().create_task(_schedule_poll(adapter, Path(marker), runner, config))
        adapter._aira_schedule_task = task
        return task
    except Exception:
        logging.getLogger(__name__).warning("aira.adapter.schedule_start_unavailable")
        return None
