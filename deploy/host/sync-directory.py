"""Publish only the WhatsApp names needed by the site, using a directory bind mount."""

import json
import os
from pathlib import Path
from tempfile import NamedTemporaryFile


def sync(source, directory):
    directory.mkdir(mode=0o700, parents=True, exist_ok=True)
    target = directory / "channel_directory.json"
    if not source.exists():
        target.unlink(missing_ok=True)
        return
    entries = json.loads(source.read_text()).get("platforms", {}).get("whatsapp", [])
    if not isinstance(entries, list):
        raise ValueError("invalid WhatsApp directory")
    names = [
        {"id": entry["id"], "name": entry["name"]}
        for entry in entries
        if isinstance(entry, dict) and all(isinstance(entry.get(k), str) for k in ("id", "name"))
    ]
    with NamedTemporaryFile(mode="w", dir=directory, delete=False) as pending:
        try:
            json.dump({"platforms": {"whatsapp": names}}, pending)
            pending.flush()
            os.fsync(pending.fileno())
            os.replace(pending.name, target)
        finally:
            Path(pending.name).unlink(missing_ok=True)


if __name__ == "__main__":
    home = Path.home()
    sync(home / ".hermes/channel_directory.json", home / ".local/share/aira/gateway-directory")
