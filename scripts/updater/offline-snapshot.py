"""Back up a stopped or unreachable core using SQLite's online backup protocol."""
import os
import sqlite3
import sys
import tempfile
from datetime import datetime, timezone
from pathlib import Path

def snapshot(root):
    db = root / "aira.db"
    if not db.is_file():
        raise ValueError("Missing core database")
    out = root / "deploy-recovery"
    out.mkdir(mode=0o700, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=out, suffix=".partial")
    os.close(fd)
    try:
        src = sqlite3.connect(db.as_uri() + "?mode=ro", uri=True, timeout=5)
        dest = sqlite3.connect(tmp)
        try:
            src.backup(dest, pages=512, sleep=0.05)
            if dest.execute("PRAGMA integrity_check").fetchall() != [("ok",)]:
                raise ValueError("Snapshot integrity check failed")
        finally:
            dest.close()
            src.close()
        final = out / (datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%fZ") + ".db")
        os.replace(tmp, final)
    finally:
        Path(tmp).unlink(missing_ok=True)

if __name__ == "__main__":
    snapshot(Path(sys.argv[1]).resolve())
