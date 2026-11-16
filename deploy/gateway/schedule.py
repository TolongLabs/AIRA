#!/usr/bin/env python3
"""Makes the gateway's schedule match the reminders the core wants (docs/trd/system.md#scheduled-turns).

The core writes <AIRA_HOST_DATA_DIR>/gateway/schedule.json. This script, run every minute by a host timer in the
gateway's own environment, compares it with the gateway's jobs whose name starts with `aira:`:

- a wanted job that is missing is created, as a one-time job delivered to the reminder's chat;
- an `aira:` job that is no longer wanted is removed, including one the gateway marked completed.

It changes jobs only through the gateway's `cron.jobs` functions, which hold the schedule's lock. A missing,
unreadable or invalid file changes nothing. Other jobs are never touched. Standard library only.

    HERMES_HOME=~/.hermes AIRA_HOST_DATA_DIR=/srv/aira-data \\
      ~/.hermes/hermes-agent/venv/bin/python deploy/gateway/schedule.py --hermes-agent ~/.hermes/hermes-agent
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable

PREFIX = "aira:"
ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
CHAT = re.compile(r"^[A-Za-z0-9._:+-]+@[A-Za-z0-9.]+$")
# A due time already past, or this close, is scheduled this far ahead: the gateway only fires future jobs.
SOON = timedelta(minutes=1)


class BadFile(ValueError):
    """The wanted-jobs file cannot be trusted. Nothing is changed."""


def compact(due: datetime) -> str:
    return due.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")


def read_wanted(path: Path) -> dict[str, dict]:
    """The wanted jobs by name, after checking every entry the way the core writes it."""
    try:
        body = json.loads(path.read_text(encoding="utf-8"))
    except FileNotFoundError as error:
        raise BadFile(f"no file at {path}") from error
    except (OSError, ValueError) as error:
        raise BadFile(f"unreadable: {error}") from error
    if not isinstance(body, dict) or body.get("version") != 1 or not isinstance(body.get("reminders"), list):
        raise BadFile("not a version 1 wanted-jobs file")
    wanted: dict[str, dict] = {}
    for entry in body["reminders"]:
        if not isinstance(entry, dict):
            raise BadFile("an entry is not an object")
        rid, chat, due_text = entry.get("id"), entry.get("chat"), entry.get("due")
        if not isinstance(rid, str) or not ID.match(rid):
            raise BadFile("an entry has no valid id")
        if not isinstance(chat, str) or not CHAT.match(chat):
            raise BadFile(f"reminder {rid} has no valid chat")
        try:
            due = datetime.fromisoformat(str(due_text).replace("Z", "+00:00"))
        except ValueError as error:
            raise BadFile(f"reminder {rid} has no valid due time") from error
        if due.tzinfo is None:
            raise BadFile(f"reminder {rid} has a due time with no zone")
        name = f"{PREFIX}{rid}:{compact(due)}"
        text = f"[AIRA-SCHEDULED v1 kind=reminder id={rid} due={compact(due)}]"
        if entry.get("name") != name or entry.get("text") != text:
            raise BadFile(f"reminder {rid} has a name or text the core would not write")
        wanted[name] = {"id": rid, "chat": chat, "due": due, "text": text}
    return wanted


def reconcile(
    wanted: dict[str, dict],
    *,
    list_jobs: Callable[[], list[dict]],
    create_job: Callable[..., dict],
    remove_job: Callable[[str], bool],
    now: datetime,
    check_only: bool = False,
) -> dict[str, list[str]]:
    """Creates the missing `aira:` jobs and removes the unwanted ones. Returns the names of each."""
    existing: dict[str, str] = {}
    done: list[str] = []
    for job in list_jobs():
        name = str(job.get("name") or "")
        if not name.startswith(PREFIX):
            continue
        if job.get("state") == "completed":
            done.append(str(job.get("id")))
        else:
            existing[name] = str(job.get("id"))
    result: dict[str, list[str]] = {"created": [], "removed": [], "kept": []}
    for name, job_id in sorted(existing.items()):
        if name in wanted:
            result["kept"].append(name)
            continue
        result["removed"].append(name)
        if not check_only:
            remove_job(job_id)
    if not check_only:
        for job_id in done:
            remove_job(job_id)
    for name, entry in sorted(wanted.items()):
        if name in existing:
            continue
        result["created"].append(name)
        if check_only:
            continue
        due = entry["due"]
        when = due if due - now > SOON else now + SOON
        create_job(
            prompt=entry["text"],
            schedule=when.astimezone(timezone.utc).isoformat(),
            name=name,
            repeat=1,
            deliver="origin",
            origin={"platform": "whatsapp", "chat_id": entry["chat"], "chat_name": None, "thread_id": None,
                    "user_id": None},
        )
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hermes-agent", metavar="PATH", required=True, type=Path,
                        help="the gateway tree whose cron.jobs is used")
    parser.add_argument("--data-dir", metavar="PATH", type=Path, default=None,
                        help="the core's data volume on the host (default: $AIRA_HOST_DATA_DIR)")
    parser.add_argument("--check", action="store_true", help="report only")
    args = parser.parse_args(argv)
    data_dir = args.data_dir or (Path(os.environ["AIRA_HOST_DATA_DIR"]) if os.environ.get("AIRA_HOST_DATA_DIR") else None)
    if data_dir is None:
        print("no data dir: pass --data-dir or set AIRA_HOST_DATA_DIR")
        return 2
    if not os.environ.get("HERMES_HOME"):
        print("HERMES_HOME is not set: refusing to guess which schedule to change")
        return 2
    try:
        wanted = read_wanted(data_dir / "gateway" / "schedule.json")
    except BadFile as error:
        print(f"nothing changed: {error}")
        return 1
    sys.path.insert(0, str(args.hermes_agent.expanduser().resolve()))
    from cron import jobs  # noqa: E402  (the gateway's own schedule functions and lock)

    result = reconcile(
        wanted,
        list_jobs=lambda: jobs.list_jobs(include_disabled=True),
        create_job=jobs.create_job,
        remove_job=jobs.remove_job,
        now=datetime.now(timezone.utc),
        check_only=args.check,
    )
    print(json.dumps({key: len(value) for key, value in result.items()}))
    return 0


if __name__ == "__main__":
    sys.exit(main())
