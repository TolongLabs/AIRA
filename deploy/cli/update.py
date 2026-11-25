"""Standalone stable update transaction (host stdlib-only).

Implements the ``Standalone stable update`` contract in
``docs/trd/deployment.md``: pin the previous and candidate images to
installation-specific local tags, pull the target, refuse incompatible
candidates before interruption, journal before stopping, stop, back up via the
``backup`` module, switch only ``AIRA_IMAGE``/``AIRA_VERSION`` in ``.env``,
verify the pinned candidate (setup verifier plus the isolated in-image
deploy probe), then commit the manifest. Any failure after stopping recovers
the exact previous pinned image and ports.

Host side uses only the standard library plus the Docker CLI through the
existing ``compose`` helpers. The deploy probe runs inside the container, so
no Node assumption is made about the host. Legacy and CI-managed installs
get a read-only report with no change. Never restores data automatically,
never prunes images, never overwrites another image's local tag.
"""

from __future__ import annotations

import json
import os
import re
import time
from pathlib import Path

from . import compose, install, operations
from .result import (
    CommandError,
    blank_state,
    conflict_error,
    error_envelope,
    ok_envelope,
    operational_error,
    progress,
    rollback_error,
)

JOURNAL_NAME = "update.json"
CONTRACT_LABEL = "io.tolonglabs.aira.standalone-contract"
IDLE_TIMEOUT_S = 120
IDLE_POLL_S = 2
DIGEST_RE = re.compile(r"^sha256:[0-9a-f]{64}$")
HEX32_RE = re.compile(r"^[0-9a-f]{32}$")

_JOURNAL_KEYS = frozenset({
    "schemaVersion", "operationId", "project", "sitePort", "corePort",
    "priorRef", "priorRelease", "previousImageId", "previousTag",
    "candidateRef", "candidateImageId", "candidateTag", "backupId",
})


def _journal_path(home: Path) -> Path:
    return home / JOURNAL_NAME


def _read_journal(home: Path) -> dict | None:
    """Strict read of the unfinished-update journal; None when absent."""
    try:
        raw = json.loads(install.read_owned_text(_journal_path(home), 8192))
    except FileNotFoundError:
        return None
    if not isinstance(raw, dict) or set(raw) != set(_JOURNAL_KEYS) or raw.get("schemaVersion") != 1:
        raise operational_error("config_invalid", "The unfinished update journal is invalid.", "recover",
                                "Inspect update.json; no new candidate was started.")
    for key in ("operationId", "backupId"):
        if not isinstance(raw[key], str) or not HEX32_RE.fullmatch(raw[key]):
            raise operational_error("config_invalid", "The unfinished update journal is invalid.", "recover",
                                    "Inspect update.json; no new candidate was started.")
    if not isinstance(raw["project"], str) or not install.PROJECT_RE.fullmatch(raw["project"]):
        raise operational_error("config_invalid", "The unfinished update journal is invalid.", "recover",
                                "Inspect update.json; no new candidate was started.")
    for key in ("sitePort", "corePort"):
        if type(raw[key]) is not int or not 1 <= raw[key] <= 65535:
            raise operational_error("config_invalid", "The unfinished update journal is invalid.", "recover",
                                    "Inspect update.json; no new candidate was started.")
    if raw["sitePort"] == raw["corePort"]:
        raise operational_error("config_invalid", "The unfinished update journal is invalid.", "recover",
                                "Inspect update.json; no new candidate was started.")
    if not isinstance(raw["priorRelease"], str) or not re.fullmatch(r"[a-zA-Z0-9._-]+", raw["priorRelease"]):
        raise operational_error("config_invalid", "The unfinished update journal is invalid.", "recover",
                                "Inspect update.json; no new candidate was started.")
    for key in ("previousImageId", "candidateImageId"):
        if not isinstance(raw[key], str) or not DIGEST_RE.fullmatch(raw[key]):
            raise operational_error("config_invalid", "The unfinished update journal is invalid.", "recover",
                                    "Inspect update.json; no new candidate was started.")
    for key in ("priorRef", "previousTag", "candidateRef", "candidateTag"):
        try:
            compose.split_image_ref(raw[key])
        except CommandError as exc:
            raise operational_error("config_invalid", "The unfinished update journal is invalid.", "recover",
                                    "Inspect update.json; no new candidate was started.") from exc
    return raw


def _write_journal(home: Path, journal: dict) -> None:
    install.atomic_write_text(_journal_path(home),
                              json.dumps(journal, indent=2, sort_keys=True) + "\n", mode=0o600)


def _remove_journal(home: Path) -> None:
    _journal_path(home).unlink(missing_ok=True)
    try:
        install.fsync_dir(home)
    except OSError:
        pass


def _docker_image_id(ref: str) -> str | None:
    """Exact image digest for a ref, or None when the ref is absent."""
    code, out, _ = compose.run(["docker", "image", "inspect", "--format", "{{.Id}}", ref], timeout_s=10)
    image = out.strip().splitlines()[0] if out.strip() else ""
    if code != 0 or not DIGEST_RE.fullmatch(image):
        return None
    return image


def _docker_label(image_id: str, name: str) -> str | None:
    """A config label value, or None when missing/unreadable (fail-closed by caller)."""
    code, out, _ = compose.run(
        ["docker", "image", "inspect", "--format", '{{index .Config.Labels "%s"}}' % name, image_id],
        timeout_s=10)
    if code != 0:
        return None
    value = out.strip()
    return None if value in ("", "<no value>", "<nil>", "<none>") else value


def _pin_ref(install_id: str, image_id: str, kind: str) -> str:
    """Owned unique local pin: install-scoped repo, digest-scoped tag."""
    return f"aira-standalone-{install_id[:12]}:{kind}-{image_id[7:19]}"


def _ensure_pin(image_id: str, pin: str) -> None:
    """Tag an image ID at a pin without ever overwriting another image."""
    compose.split_image_ref(pin)
    existing = _docker_image_id(pin)
    if existing == image_id:
        return
    if existing is not None:
        raise conflict_error("install_ambiguous", "A local update tag names another image.", stage="plan",
                             recovery="Remove the stale local tag or repair the install explicitly.")
    code, _, _ = compose.run(["docker", "image", "tag", image_id, pin], timeout_s=30)
    if code != 0:
        raise operational_error("image_tag_failed", "The image could not be pinned locally.", "plan",
                                "Run aira doctor, then retry the update.")


def _prior_ref(home: Path) -> str:
    known = compose.parse_env_file(home / ".env")
    return f"{known.get('AIRA_IMAGE', 'ghcr.io/tolonglabs/aira')}:{known.get('AIRA_VERSION', 'stable')}"


def _rewrite_env_image(home: Path, repo: str, tag: str) -> None:
    """Replace only the two image-selection lines; every other line is kept."""
    compose.split_image_ref(f"{repo}:{tag}")
    text = install.read_owned_text(home / ".env", 1024 * 1024)
    found_image = found_version = False
    lines = []
    for line in text.splitlines():
        stripped = line.strip()
        if stripped.startswith("AIRA_IMAGE="):
            if found_image:
                raise conflict_error("config_invalid", "The image selection is ambiguous.")
            lines.append(f"AIRA_IMAGE='{repo}'")
            found_image = True
        elif stripped.startswith("AIRA_VERSION="):
            if found_version:
                raise conflict_error("config_invalid", "The version selection is ambiguous.")
            lines.append(f"AIRA_VERSION='{tag}'")
            found_version = True
        else:
            lines.append(line)
    if not found_image:
        lines.append(f"AIRA_IMAGE='{repo}'")
    if not found_version:
        lines.append(f"AIRA_VERSION='{tag}'")
    install.atomic_write_text(home / ".env", "\n".join(lines) + "\n", mode=0o600)
    known = compose.parse_env_file(home / ".env")
    if known.get("AIRA_IMAGE") != repo or known.get("AIRA_VERSION") != tag:
        raise operational_error("path_unwritable", "The image selection could not be verified.", "switch",
                                "Check permissions and disk space, then retry.")


def _wait_for_idle(core_port: int, timeout_s: int = IDLE_TIMEOUT_S) -> bool:
    deadline = time.monotonic() + timeout_s
    while True:
        _, body, kind = compose.http_get_json(
            f"http://127.0.0.1:{core_port}/health", min(max(deadline - time.monotonic(), 0.1), 5))
        if kind != "ok" or not isinstance(body, dict) or body.get("status") != "ready":
            raise operational_error("health_timeout", "Core health was unreachable while draining.", "drain",
                                    "Run aira doctor, then retry when the service is healthy.")
        turns = body.get("activeTurns")
        if type(turns) is not int or turns < 0:
            raise operational_error("health_timeout", "Core turn count is unavailable.", "drain")
        if turns == 0:
            return True
        if time.monotonic() >= deadline:
            return False
        time.sleep(min(IDLE_POLL_S, max(deadline - time.monotonic(), 0)))


def _probe_candidate(home: Path, project: str) -> bool:
    """Isolated in-image deploy probe; last line must be exactly deploy-turn-ok."""
    try:
        code, out, _ = compose.compose_run(
            home, project,
            ["exec", "-T", "aira", "node", "dist/scripts/deploy-turn-probe.js", "--standalone"],
            timeout_s=60)
    except compose.RunError:
        return False
    if code != 0:
        return False
    lines = [line.strip() for line in out.splitlines() if line.strip()]
    return bool(lines) and lines[-1] == "deploy-turn-ok"


def _recover_previous(home: Path, manifest, journal: dict) -> None:
    """Rewrite .env to the previous pin, start it, and verify ID, ports, health."""
    repo, tag = compose.split_image_ref(journal["previousTag"])
    _rewrite_env_image(home, repo, tag)
    try:
        compose.compose_up(home, journal["project"])
    except compose.PortInUseError as exc:
        raise conflict_error("port_conflict", "The previous ports are occupied.", stage="recovery",
                             recovery="Free the previous ports, then retry the update.") from exc
    running = _docker_image_id(journal["previousTag"])
    actual = compose.container_image_id(home, journal["project"])
    if running != journal["previousImageId"] or actual != journal["previousImageId"]:
        raise rollback_error("rollback_failed", "The previous image could not be restored.", stage="recovery",
                             recovery="Recover manually; data was not restored over later writes.")
    bindings = compose.published_bindings(home, journal["project"])
    if bindings.get(9881, (None, None))[1] != journal["corePort"] or \
            bindings.get(9890, (None, None))[1] != journal["sitePort"]:
        raise rollback_error("rollback_failed", "The previous ports could not be restored.", stage="recovery",
                             recovery="Recover manually; data was not restored over later writes.")
    install._verify(home, manifest, "standalone", journal["project"], [], [], timeout=60)
    manifest.imageId = journal["previousImageId"]
    manifest.release = journal["priorRelease"]
    install.write_manifest(home, manifest)


def _observe_best_effort(home: Path, manifest):
    try:
        return install.observe(home, manifest)
    except (CommandError, OSError, ValueError, compose.RunError):
        return {"state": blank_state(), "checks": [], "warnings": [], "dashboard": None}


def _managed_report(op: str, home: Path, manifest, timer: operations.Timer) -> dict:
    """Read-only report for legacy/CI-managed installs: no lock, no change."""
    report = _observe_best_effort(home, manifest)
    channel = "legacy host management" if manifest is None or manifest.mode != "standalone" else "CI-managed updates"
    report["warnings"] = list(report["warnings"]) + [f"Managed by {channel}; aira update changes nothing."]
    result = ok_envelope("update", op, report["state"], report["checks"], report["warnings"], report["dashboard"])
    if report.get("imageId"):
        result["imageId"] = report["imageId"]
    if report.get("mode"):
        result["installationMode"] = report["mode"]
    if report.get("management"):
        result["management"] = report["management"]
    if report.get("release"):
        result["release"] = report["release"]
    operations.log_event("update", op, "discover", "managed_elsewhere", "ok",
                         duration_ms=timer.elapsed_ms())
    return result


def _fail(op: str, err: CommandError, home, manifest, checks: list, warnings: list,
          timer: operations.Timer, image: str | None = None) -> dict:
    report = _observe_best_effort(home, manifest) if home is not None else \
        {"state": blank_state(), "checks": [], "warnings": [], "dashboard": None}
    result = error_envelope("update", op, err, report["state"], checks,
                            warnings + report["warnings"], report["dashboard"])
    operations.log_event("update", op, err.stage or "update", err.code, "error",
                         duration_ms=timer.elapsed_ms(), image=image)
    return result


def _recover_and_report(op: str, err: CommandError, home: Path, manifest, journal: dict,
                        checks: list, warnings: list, timer: operations.Timer,
                        old_id: str | None, candidate_id: str | None) -> dict:
    """Restore the previous pin after a post-stop failure; journal is retained."""
    backup_id = journal.get("backupId", op)
    try:
        _recover_previous(home, manifest, journal)
        _remove_journal(home)
    except (CommandError, OSError, ValueError, compose.RunError, KeyboardInterrupt):
        ferr = rollback_error(
            "rollback_failed",
            "Update failed and recovery failed; journal update.json retained. "
            f"Check backup {backup_id} under data/deploy-recovery/.",
            stage="recovery",
            recovery="Recover manually from the retained backup reference; data was not restored automatically.")
        report = _observe_best_effort(home, manifest)
        result = error_envelope("update", op, ferr, report["state"], checks,
                                warnings + report["warnings"], report["dashboard"])
        result["backupId"] = backup_id
        if old_id:
            result["previousImageId"] = old_id
        if candidate_id:
            result["candidateImageId"] = candidate_id
        operations.log_event("update", op, "recovery", "rollback_failed", "error",
                             duration_ms=timer.elapsed_ms())
        return result
    report = _observe_best_effort(home, manifest)
    rolled = operational_error(
        "update_rolled_back",
        f"Update failed ({err.code}); the previous image was restored. "
        f"Check backup {backup_id} under data/deploy-recovery/.",
        stage=err.stage or "update",
        recovery="Retry the update when ready; the running service is unchanged.",
        retryable=True)
    result = error_envelope("update", op, rolled, report["state"], checks,
                            warnings + report["warnings"], report["dashboard"])
    result["backupId"] = backup_id
    if old_id:
        result["previousImageId"] = old_id
    if candidate_id:
        result["candidateImageId"] = candidate_id
    operations.log_event("update", op, err.stage or "update", "update_rolled_back", "error",
                         duration_ms=timer.elapsed_ms())
    return result


def update_command(args, home, manifest, op) -> dict:
    """Run the standalone stable update; return the result envelope.

    ``args.image`` is an optional explicit fixture local image (otherwise the
    public ``stable`` tag). ``home`` selects the install, ``manifest`` is the
    pre-lock manifest (re-read under the lock), and ``op`` is the operation
    ID. The orchestrator wires ``main.py`` and the argument parser.
    """
    home = Path(home)
    checks: list = []
    warnings: list = []
    timer = operations.Timer()

    try:
        current = manifest if manifest is not None else install.read_manifest(home)
    except (CommandError, OSError, ValueError) as exc:
        err = exc if isinstance(exc, CommandError) else operational_error(
            "config_invalid", "install.json cannot be read.", "discover",
            "Repair the saved install metadata; do not delete data.")
        return _fail(op, err, home if home.exists() else None, None, checks, warnings, timer)
    if current is None:
        if install.looks_like_install(home) and install._mode(home, None) == "legacy":
            return _managed_report(op, home, None, timer)
        return _fail(op, operational_error("not_installed", "No installation was selected.", "discover",
                                           "Run aira setup."), home, None, checks, warnings, timer)
    if current.mode != "standalone" or current.management != "stable":
        return _managed_report(op, home, current, timer)

    with install.DeployLock(home):
        journal: dict | None = None
        pending: dict | None = None
        old_id: str | None = None
        candidate_id: str | None = None
        candidate_ref: str | None = None
        stage = "discover"
        try:
            manifest = install.read_manifest(home)
            if manifest is None:
                raise operational_error("not_installed", "No installation was selected.", "discover",
                                        "Run aira setup.")
            if manifest.mode != "standalone" or manifest.management != "stable":
                return _managed_report(op, home, manifest, timer)
            if manifest.stage != "installed":
                raise conflict_error("repair_required", "The installation is not complete.", stage="discover",
                                     recovery="Run aira setup to complete it.")
            if manifest.uid != os.geteuid() or manifest.gid != os.getegid():
                raise conflict_error("path_unwritable", "The install belongs to another user.", stage="discover",
                                     recovery="Use the installation owner.")
            install.check_owned(home, "installation")

            pending = _read_journal(home)
            if pending is not None:
                stage = "recover"
                progress("Recovering the unfinished update.")
                if (pending["project"] != manifest.project or pending["sitePort"] != manifest.sitePort or
                    pending["corePort"] != manifest.corePort or manifest.imageId not in (pending["candidateImageId"], pending["previousImageId"]) or
                    pending["previousTag"] != _pin_ref(manifest.installId, pending["previousImageId"], "prev") or
                    pending["candidateTag"] != _pin_ref(manifest.installId, pending["candidateImageId"], "next")):
                    raise rollback_error("rollback_failed", "The update journal does not match this install.", "recover", "Inspect the retained journal and backups; no new candidate was started.")
                current_id = compose.container_image_id(home, pending["project"])
                if current_id == manifest.imageId == pending["candidateImageId"]:
                    bindings = compose.published_bindings(home, pending["project"])
                    if (bindings.get(9881, (None, None))[1] == pending["corePort"]
                            and bindings.get(9890, (None, None))[1] == pending["sitePort"]):
                        try:
                            install._verify(home, manifest, "standalone", pending["project"], [], [], timeout=60)
                            if not _probe_candidate(home, pending["project"]):
                                raise operational_error("synthetic_turn_failed", "Candidate readback failed.", "recover")
                        except CommandError:
                            pass
                        else:
                            manifest.imageId = pending["candidateImageId"]
                            manifest.release = compose.split_image_ref(pending["candidateRef"])[1]
                            manifest.management = "stable"
                            manifest.corePort = pending["corePort"]
                            manifest.sitePort = pending["sitePort"]
                            install.write_manifest(home, manifest)
                            _remove_journal(home)
                            warnings.append("Completed the journalled update before starting.")
                            manifest = install.read_manifest(home)
                            pending = None
                if pending is not None:
                    return _recover_and_report(op, operational_error("operation_interrupted", "An earlier update was interrupted.", "recover"),
                                               home, manifest, pending, checks, warnings, timer, pending["previousImageId"], pending["candidateImageId"])

            stage = "discover"
            try:
                project = manifest.project
                name = compose.detect_project(home)
                if name and name != manifest.project:
                    raise conflict_error("install_ambiguous", "The observed Compose project differs.",
                                         stage="discover", recovery="Inspect the existing project.")
                entries = compose.ps_entries(home, project)
            except compose.RunError as exc:
                raise operational_error("docker_unreachable", "Docker state could not be verified.", "discover",
                                        "Run aira doctor and retry the update.") from exc
            if not compose.service_running(entries):
                raise operational_error("health_timeout", "The service is not running.", "discover",
                                        "Run aira setup to resume; update changes nothing while stopped.")
            bindings = compose.published_bindings(home, project)
            old_id = compose.container_image_id(home, project)
            if not old_id or set(bindings) != {9881, 9890}:
                raise operational_error("health_timeout", "Actual service mapping or image ID is missing.",
                                        "discover", "Inspect the chosen Compose project and rerun.")
            if old_id != manifest.imageId:
                raise conflict_error("repair_required", "The running image differs from the committed image.")
            if bindings[9881][1] != manifest.corePort or bindings[9890][1] != manifest.sitePort:
                raise conflict_error("port_conflict", "Observed ports differ from the manifest.", stage="discover",
                                     recovery="Repair the mapping explicitly; the CLI will not move it.")

            stage = "verify"
            _, old_id, _ = install._verify(home, manifest, "standalone", project, checks, warnings, timeout=60)

            stage = "plan"
            prev_pin = _pin_ref(manifest.installId, old_id, "prev")
            _ensure_pin(old_id, prev_pin)
            requested = getattr(args, "image", None)
            if requested:
                candidate_ref = requested
                compose.split_image_ref(candidate_ref)
                if not compose.local_image_present(candidate_ref):
                    raise conflict_error("config_invalid", "The explicit image is not present locally.",
                                         stage="plan",
                                         recovery="Load the fixture image locally or omit the flag for stable.")
            else:
                candidate_ref = compose.default_image_ref()
                progress("Pulling the candidate image.")
                compose.pull_image(candidate_ref)
            candidate_id = _docker_image_id(candidate_ref)
            if not candidate_id:
                raise operational_error("image_pull_failed", "The candidate image ID could not be read.", "pull",
                                        "Check Docker and registry access, then retry the update.", retryable=True)
            if _docker_label(candidate_id, CONTRACT_LABEL) != "1":
                raise operational_error("image_incompatible", "The candidate is not a compatible release.",
                                        "compatibility", "Use a compatible stable release.")
            if candidate_id == old_id:
                report = install.observe(home, manifest)
                result = ok_envelope("update", op, report["state"], checks + report["checks"],
                                     warnings + report["warnings"], report["dashboard"])
                result.update(imageId=old_id, previousImageId=old_id, installationMode="standalone",
                              management="stable", release=manifest.release)
                operations.log_event("update", op, "verify", "up_to_date", "ok",
                                     duration_ms=timer.elapsed_ms(), image=candidate_ref)
                return result

            next_pin = _pin_ref(manifest.installId, candidate_id, "next")
            _ensure_pin(candidate_id, next_pin)
            prior_ref = _prior_ref(home)

            stage = "drain"
            progress("Waiting for idle turns.")
            if not _wait_for_idle(bindings[9881][1], IDLE_TIMEOUT_S):
                raise operational_error("turns_busy", "Turns were still in flight after 120 seconds.", "drain",
                                        "Retry when no turn is active.", retryable=True)

            stage = "prepare"
            planned_journal = {"schemaVersion": 1, "operationId": op, "project": project,
                       "sitePort": bindings[9890][1], "corePort": bindings[9881][1],
                       "priorRef": prior_ref, "priorRelease": manifest.release,
                       "previousImageId": old_id, "previousTag": prev_pin,
                       "candidateRef": candidate_ref, "candidateImageId": candidate_id,
                       "candidateTag": next_pin, "backupId": op}
            _write_journal(home, planned_journal)
            journal = planned_journal

            stage = "stop"
            progress("Stopping the previous container.")
            compose.compose_stop(home, project)

            stage = "backup"
            try:
                from . import backup as backup_mod
                backup_mod.create_backup(home / "data", op)
            except Exception as exc:
                raise operational_error("backup_failed", "The pre-update backup failed.", "backup",
                                        "Retry the update; the previous image was restored.",
                                        retryable=True) from exc

            stage = "switch"
            repo, tag = compose.split_image_ref(next_pin)
            _rewrite_env_image(home, repo, tag)

            stage = "start"
            progress("Starting the candidate image.")
            try:
                compose.compose_up(home, project)
            except compose.PortInUseError as exc:
                raise conflict_error("port_conflict", "A concurrent listener took a selected port.",
                                     stage="start", recovery="Free the port, then retry the update.") from exc

            stage = "verify"
            progress("Verifying the candidate.")
            if compose.container_image_id(home, project) != candidate_id:
                raise operational_error("health_timeout", "The running image differs from the candidate.",
                                        "verify", "The previous image was restored; check the candidate release.")
            verified = install._verify(home, manifest, "standalone", project, checks, warnings, timeout=60)
            if verified[0][9881][1] != journal["corePort"] or verified[0][9890][1] != journal["sitePort"]:
                raise conflict_error("port_conflict", "The candidate published different ports.",
                                     stage="verify", recovery="The previous image was restored; inspect the install.")
            if not _probe_candidate(home, project):
                raise operational_error("synthetic_turn_failed", "The isolated deployment probe failed.",
                                        "verify", "The previous image was restored; check the candidate release.")
            checks.append({"name": "deploy_probe", "ok": True})

            stage = "commit"
            manifest.imageId = candidate_id
            manifest.release = compose.split_image_ref(candidate_ref)[1]
            manifest.management = "stable"
            manifest.corePort = verified[0][9881][1]
            manifest.sitePort = verified[0][9890][1]
            manifest.stage = "installed"
            install.write_manifest(home, manifest)
            journal = None
            try:
                _remove_journal(home)
            except OSError:
                # Committed; the candidate-match branch of the next run completes this safely.
                warnings.append("Journal cleanup failed; the next update completes it safely.")

            report = install.observe(home, manifest)
            result = ok_envelope("update", op, report["state"], checks + report["checks"],
                                 warnings + report["warnings"], report["dashboard"])
            result.update(imageId=candidate_id, previousImageId=old_id, installationMode="standalone",
                          management="stable", release=manifest.release, backupId=op)
            operations.log_event("update", op, "commit", "updated", "ok",
                                 duration_ms=timer.elapsed_ms(), image=candidate_ref)
            return result
        except KeyboardInterrupt as exc:
            err = operational_error("operation_interrupted", "Update was interrupted.", stage,
                                    "Retry the update; an unfinished journal is recovered first.")
            recovery_journal = journal
            if recovery_journal is not None:
                return _recover_and_report(op, err, home, manifest, recovery_journal, checks,
                                           warnings, timer, old_id, candidate_id)
            raise operational_error("operation_interrupted", "Update was interrupted.", stage,
                                    "Retry the update.") from exc
        except CommandError as err:
            if journal is not None:
                return _recover_and_report(op, err, home, manifest, journal, checks, warnings,
                                           timer, old_id, candidate_id)
            return _fail(op, err, home, manifest, checks, warnings, timer, candidate_ref)
        except compose.RunError as exc:
            err = operational_error("docker_unreachable", "Docker state could not be verified.", stage,
                                    "Run aira doctor and retry the update.")
            if journal is not None:
                return _recover_and_report(op, err, home, manifest, journal, checks, warnings,
                                           timer, old_id, candidate_id)
            return _fail(op, err, home, manifest, checks, warnings, timer, candidate_ref)
        except (OSError, ValueError, RuntimeError) as exc:
            err = operational_error("path_unwritable", "Update could not read or write a required file.",
                                    stage, "Check permissions and disk space, then retry.")
            if journal is not None:
                return _recover_and_report(op, err, home, manifest, journal, checks, warnings,
                                           timer, old_id, candidate_id)
            return _fail(op, err, home, manifest, checks, warnings, timer, candidate_ref)
