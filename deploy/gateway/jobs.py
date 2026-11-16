#!/usr/bin/env python3
"""Tag or untag the owner's gateway jobs that the AIRA core runs (docs/trd/system.md#gateway-jobs).

A tagged job's text starts with `[AIRA-SCHEDULED v1 kind=job id=<job id>]`. The core runs a tagged job only when the
host's `gateway.jobs` lists it. Cutover tags, rollback untags. Both are safe to repeat.

It changes jobs only through the gateway's `cron.jobs` functions, which hold the schedule's lock.

    HERMES_HOME=~/.hermes python3 deploy/gateway/jobs.py --hermes-agent ~/.hermes/hermes-agent --ids a1,b2 --tag
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from pathlib import Path
from typing import Callable

JOB_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
TAG_LINE = re.compile(r"^\[AIRA-SCHEDULED v1 kind=job id=[A-Za-z0-9_-]{1,64}\]\n?")


def tag_for(job_id: str) -> str:
    return f"[AIRA-SCHEDULED v1 kind=job id={job_id}]"


def retag(
    ids: list[str],
    mode: str,
    get_job: Callable[[str], dict | None],
    update_job: Callable[[str, dict], object],
    check_only: bool = False,
) -> dict[str, list[str]]:
    """Puts the tag first in each job's prompt (`tag`) or takes it out (`untag`). Returns what changed."""
    result: dict[str, list[str]] = {"changed": [], "unchanged": [], "missing": []}
    for job_id in ids:
        job = get_job(job_id)
        if job is None:
            result["missing"].append(job_id)
            continue
        prompt = job.get("prompt") or ""
        bare = TAG_LINE.sub("", prompt, count=1)
        wanted = f"{tag_for(job_id)}\n{bare}" if mode == "tag" else bare
        if wanted == prompt:
            result["unchanged"].append(job_id)
            continue
        if not check_only:
            update_job(job_id, {"prompt": wanted})
        result["changed"].append(job_id)
    return result


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--hermes-agent", metavar="PATH", required=True, type=Path,
                        help="the gateway tree whose cron.jobs is used")
    parser.add_argument("--ids", required=True, help="comma-separated job ids, as listed in gateway.jobs")
    mode = parser.add_mutually_exclusive_group(required=True)
    mode.add_argument("--tag", action="store_true")
    mode.add_argument("--untag", action="store_true")
    parser.add_argument("--check", action="store_true", help="report only")
    args = parser.parse_args(argv)
    ids = [item.strip() for item in args.ids.split(",") if item.strip()]
    bad = [item for item in ids if not JOB_ID.match(item)]
    if not ids or bad:
        print(f"bad job ids: {bad or 'none given'}")
        return 2
    if not os.environ.get("HERMES_HOME"):
        print("HERMES_HOME is not set: refusing to guess which schedule to change")
        return 2
    sys.path.insert(0, str(args.hermes_agent.expanduser().resolve()))
    from cron import jobs  # noqa: E402  (the gateway's own schedule functions and lock)

    result = retag(ids, "tag" if args.tag else "untag", jobs.get_job, jobs.update_job, check_only=args.check)
    print(json.dumps(result))
    return 1 if result["missing"] else 0


if __name__ == "__main__":
    sys.exit(main())
