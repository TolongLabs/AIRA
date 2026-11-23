#!/usr/bin/env python3
"""Switch the owner site entry on the currently installed, digest-pinned Compose service."""
import argparse
import fcntl
import json
import os
from pathlib import Path
import re
import stat
import subprocess
import tarfile
import tempfile
import time
import urllib.error
import urllib.request


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, *args):
        return None


def checked(args, cwd, env):
    return subprocess.check_output(args, cwd=cwd, env=env, text=True).strip()


def atomic_write(path, content):
    metadata = path.stat()
    fd, name = tempfile.mkstemp(dir=path.parent, prefix=".dashboard-entry-")
    try:
        with os.fdopen(fd, "wb") as stream:
            os.fchmod(fd, stat.S_IMODE(metadata.st_mode))
            stream.write(content)
            stream.flush()
            os.fsync(fd)
        os.replace(name, path)
        directory = os.open(path.parent, os.O_RDONLY)
        try:
            os.fsync(directory)
        finally:
            os.close(directory)
    finally:
        Path(name).unlink(missing_ok=True)


def verify(mode, url, token):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}), NoRedirect())

    def get(path, owner=False):
        request = urllib.request.Request(url + path, headers={"X-TolongAI-Token": token} if owner else {})
        try:
            return opener.open(request, timeout=5)
        except urllib.error.HTTPError as error:
            return error

    with get("/app/") as response:
        if mode == "dashboard":
            if (response.status, response.headers.get("Location")) != (302, "/overview"):
                raise ValueError("entry did not select the dashboard")
        elif response.status != 200 or b"/app/assets/" not in response.read():
            raise ValueError("classic entry failed")
    if mode == "dashboard":
        for path in ("overview", "chats", "characters", "library", "markets", "automations", "system"):
            with get("/" + path) as response:
                if response.status != 200 or b"/app/assets/" not in response.read():
                    raise ValueError("dashboard route failed: " + path)
        with get("/owner-api/core/chats") as response:
            if response.status != 401:
                raise ValueError("owner challenge failed")
    for path, field in [("/owner-api/core/chats" if mode == "dashboard" else "/api/chats", "chats"),
                        ("/owner-api/dashboard", "recent")]:
        with get(path, True) as response:
            if response.status != 200 or not isinstance(json.load(response).get(field), list):
                raise ValueError("owner readback failed")


def checkpoint(install, cid, compose, run, inspect):
    def health():
        # Read only the fields required for drain and snapshot verification.
        expression = ("const h=await (await fetch('http://127.0.0.1:9881/health')).json();"
                      "console.log(JSON.stringify([h.status,h.activeTurns,h.snapshot?.id??0,h.snapshot?.state]))")
        return json.loads(run(["docker","exec",cid,"node","--input-type=module","-e",expression]))

    deadline = time.monotonic() + 120
    while True:
        status, active, previous, _ = health()
        if status == "ready" and active == 0:
            break
        if time.monotonic() >= deadline:
            raise TimeoutError("core did not drain")
        time.sleep(2)
    data = Path(inspect('{{range .Mounts}}{{if eq .Destination "/data"}}{{.Source}}{{end}}{{end}}', cid))
    if not data.is_absolute() or list((data / ".studio-stage").glob("*.journal.json")):
        raise ValueError("reconcile pending pack operations before switching")
    run(compose + ["kill","-s","SIGUSR2","aira"])
    deadline = time.monotonic() + 60
    while True:
        _, _, snapshot, state = health()
        if snapshot > previous and state == "verified":
            break
        if (snapshot > previous and state == "failed") or time.monotonic() >= deadline:
            raise RuntimeError("fresh SQLite snapshot was not verified")
        time.sleep(1)
    recovery = install / "dashboard-recovery"
    recovery.mkdir(mode=0o700, exist_ok=True)
    archive = recovery / ("pack-config-" + str(snapshot) + ".tar.gz")
    packs = data / "characters"
    with open(archive, "xb", opener=lambda path, flags: os.open(path, flags, 0o600)) as stream:
        with tarfile.open(fileobj=stream, mode="w:gz") as backup:
            backup.add(install / "config.yml", arcname="config.yml")
            if packs.is_dir():
                backup.add(packs, arcname="characters")
        stream.flush()
        os.fsync(stream.fileno())
    print("verified snapshot", snapshot, "pack/config archive", archive.name, flush=True)


def switch(install, mode, digest):
    if not re.fullmatch(r"sha256:[0-9a-f]{64}", digest):
        raise ValueError("expected an installed image ID")
    env = {k: v for k, v in os.environ.items() if not k.startswith("AIRA_")}
    compose = ["docker", "compose", "-f", str(install / "compose.yml")]
    run = lambda args: checked(args, install, env)
    inspect = lambda field, cid: run(["docker", "inspect", "--format", field, cid])
    container = lambda: run(compose + ["ps", "-q", "aira"])
    with (install / "deploy.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        cid = container()
        if inspect("{{.Image}}", cid) != digest or inspect("{{.State.Health.Status}}", cid) != "healthy":
            raise ValueError("installed image or health changed")
        ref = inspect("{{.Config.Image}}", cid)
        if run(compose + ["config", "--images", "aira"]) != ref or run(["docker", "image", "inspect", "--format", "{{.Id}}", ref]) != digest:
            raise ValueError("Compose selector does not resolve to the installed image")
        address = run(["docker", "port", cid, "9890/tcp"])
        if len(address.splitlines()) != 1:
            raise ValueError("expected one private site bind")
        url = "http://" + address
        token = (Path.home() / ".hermes/brain/.site-token").read_text().strip()
        if not token:
            raise ValueError("owner credential unavailable")
        path = install / ".env"
        original = path.read_bytes()
        pattern = rb"(?m)^AIRA_DASHBOARD_ENTRY=([^\r\n]*)\r?$"
        values = re.findall(pattern, original)
        if len(values) > 1 or any(v.strip(b"\"'") not in (b"", b"classic", b"dashboard") for v in values):
            raise ValueError("ambiguous dashboard entry configuration")
        prior = "dashboard" if values and values[0].strip(b"\"'") == b"dashboard" else "classic"
        verify(prior, url, token)
        if mode == prior:
            print("verified", mode, digest)
            return
        checkpoint(install, cid, compose, run, inspect)
        value = b"AIRA_DASHBOARD_ENTRY=" + mode.encode()
        changed = re.sub(pattern, value, original) if values else original + (b"" if original.endswith(b"\n") else b"\n") + value + b"\n"

        def recreate(selected):
            run(compose + ["up", "-d", "--no-deps", "--pull", "never", "--force-recreate", "aira"])
            deadline = time.monotonic() + 90
            while time.monotonic() < deadline:
                current = container()
                if current and inspect("{{.Image}}", current) != digest:
                    raise RuntimeError("image changed during restart")
                if current and inspect("{{.State.Health.Status}}", current) == "healthy":
                    verify(selected, url, token)
                    return
                time.sleep(2)
            raise TimeoutError("service did not recover health")

        if path.read_bytes() != original:
            raise ValueError("deployment environment changed")
        atomic_write(path, changed)
        try:
            recreate(mode)
        except BaseException:
            if path.read_bytes() != changed:
                raise RuntimeError("deployment environment changed during switch; inspect before recovery")
            atomic_write(path, original)
            recreate(prior)
            raise
        print("verified", mode, digest)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install", type=Path, required=True)
    parser.add_argument("--expect-image", required=True)
    parser.add_argument("mode", choices=["classic", "dashboard"])
    args = parser.parse_args()
    switch(args.install.resolve(), args.mode, args.expect_image)
