"""Contract tests for `aira pack` host CLI commands.

Stdlib unittest only. Uses a fake selected owner API and temporary JSON fixtures;
no real credentials, Docker, live model calls, or real packs.
"""

from __future__ import annotations

import contextlib
import io
import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from deploy.cli import configure, install, main, pack, result


FIXTURE_REV_1 = "a" * 64
FIXTURE_REV_2 = "b" * 64
FIXTURE_TOKEN = "f" * 64


def make_draft(pack_id: str = "fixture_fox", **card_overrides) -> dict:
    card = {
        "id": pack_id,
        "displayName": "Fixture Fox",
        "aliases": ["Fox", "Foxy"],
        "languages": ["en"],
        "coreIdentity": "A calm fictional workshop fox.",
        "speechRules": ["Keep sentences short.", "Stay playful."],
        "defaultReplyLength": "default",
        "capitaliseBubbles": True,
        "toolFooter": {"icon": "🔍", "labels": {"web_search": "Look"}},
    }
    card.update(card_overrides)
    moods = {
        "default": "calm",
        "moods": {
            "calm": {
                "patterns": ["hello", "hi"],
                "tone": "gentle and concise",
                "openers": ["Oh, hey"],
                "endings": ["Got it"],
                "faces": ["(._.)"],
                "stickers": [],
            }
        },
    }
    lines = {
        "error": "Something slipped.",
        "limit": "Need a breather.",
        "refusal": "Not doing that.",
        "busy": "Hold on.",
        "slow": "Still thinking.",
        "unreadableMedia": "Cannot read that file.",
        "fallback": "Try again later.",
        "unavailable": "Away right now.",
        "feedback": "Noted.",
    }
    return {"card": card, "moods": moods, "lines": lines}


def apply_merge_patch(original: dict, patch_obj: dict) -> dict:
    merged = json.loads(json.dumps(original))
    for key, value in patch_obj.items():
        if value is None:
            merged.pop(key, None)
        elif isinstance(value, dict) and isinstance(merged.get(key), dict):
            merged[key] = apply_merge_patch(merged[key], value)
        else:
            merged[key] = json.loads(json.dumps(value))
    return merged


class FakeOwnerApi:
    """In-memory fake selected owner API matching the Site API pack contract."""

    def __init__(self) -> None:
        self.calls: list[dict] = []
        self.packs: dict[str, dict] = {}
        self.faults: list[dict] = []
        self.schema_response = {
            "schema": {"type": "object", "required": ["card", "moods", "lines"]},
            "setupPrompt": "Build card, moods, and lines. Private notes belong only in optional instructions.",
        }
        self.ceiling = 4096
        self.auth_status: int | None = None
        self.check_override = None
        self.create_conflict = False
        self.stale_on_put = False
        self.try_reply = "Oh, hey. Everything looks tidy."
        self.try_override = None

    def seed_pack(self, pack_id: str, draft: dict, *, source: str = "data", revision: str = FIXTURE_REV_1) -> None:
        self.packs[pack_id] = {
            "id": pack_id,
            "source": source,
            "writable": source == "data",
            "revision": revision,
            "card": json.loads(json.dumps(draft["card"])),
            "moods": json.loads(json.dumps(draft["moods"])),
            "lines": json.loads(json.dumps(draft["lines"])),
        }

    def request(self, selection, method, path, body=None, timeout_s=10, *, response_limit=None):
        self.calls.append({
            "method": method,
            "path": path,
            "body": json.loads(json.dumps(body)) if body is not None else None,
            "timeout_s": timeout_s,
            "token": selection.get("token"),
        })
        if self.auth_status in (401, 403):
            code = "owner_token_required" if self.auth_status == 401 else "origin_refused"
            return self.auth_status, {"error": code}, "ok"

        if method == "GET" and path == "/owner-api/core/pack/schema":
            return 200, self.schema_response, "ok"

        if method == "POST" and path == "/owner-api/core/pack/check":
            if not isinstance(body, dict) or not isinstance(body.get("draft"), dict):
                return 400, {"error": "invalid_body"}, "ok"
            if self.check_override is not None:
                return self.check_override(body)
            draft = body["draft"]
            card = draft.get("card") if isinstance(draft.get("card"), dict) else {}
            moods_doc = draft.get("moods") if isinstance(draft.get("moods"), dict) else {}
            pack_id = card.get("id") if isinstance(card.get("id"), str) else ""
            moods_map = moods_doc.get("moods") if isinstance(moods_doc.get("moods"), dict) else {}
            checked = {
                "id": pack_id,
                "ok": True,
                "faults": [],
                "ceiling": self.ceiling,
                "promptTokens": 512,
                "moods": len(moods_map),
                "stickers": 0,
            }
            if "existingId" in body:
                checked["normalizedCard"] = card
            return 200, checked, "ok"

        if method == "GET" and path == "/owner-api/core/characters":
            chars = [
                {
                    "id": p["id"],
                    "displayName": p["card"].get("displayName", p["id"]),
                    "source": p["source"],
                    "languages": p["card"].get("languages", ["en"]),
                }
                for p in sorted(self.packs.values(), key=lambda item: item["id"])
            ]
            return 200, {"characters": chars, "faults": list(self.faults)}, "ok"

        if method == "POST" and path == "/owner-api/core/characters":
            if not isinstance(body, dict) or not isinstance(body.get("id"), str):
                return 400, {"error": "invalid_body"}, "ok"
            pack_id = body["id"]
            if self.create_conflict or pack_id in self.packs or any(f.get("id") == pack_id for f in self.faults):
                return 409, {"error": "conflict"}, "ok"
            self.seed_pack(
                pack_id,
                {"card": body["card"], "moods": body["moods"], "lines": body["lines"]},
                source="data",
                revision=FIXTURE_REV_1,
            )
            return 201, {"id": pack_id, "revision": FIXTURE_REV_1, "changed": True}, "ok"

        if path.startswith("/owner-api/core/characters/") and path.endswith("/studio"):
            pack_id = path[len("/owner-api/core/characters/"):-len("/studio")]
            if method == "GET":
                entry = self.packs.get(pack_id)
                if entry is None:
                    return 404, {"error": "not_found"}, "ok"
                return 200, json.loads(json.dumps(entry)), "ok"
            if method == "PUT":
                entry = self.packs.get(pack_id)
                if entry is None:
                    return 404, {"error": "not_found"}, "ok"
                if not entry["writable"]:
                    return 409, {"error": "pack_read_only"}, "ok"
                if self.stale_on_put or body.get("expectedRevision") != entry["revision"]:
                    return 409, {"error": "stale_revision"}, "ok"
                patch_obj = body.get("patch") or {}
                changed = False
                for doc_name in ("card", "moods", "lines"):
                    if doc_name in patch_obj:
                        updated_doc = apply_merge_patch(entry[doc_name], patch_obj[doc_name])
                        if updated_doc != entry[doc_name]:
                            entry[doc_name] = updated_doc
                            changed = True
                if changed:
                    entry["revision"] = FIXTURE_REV_2
                return 200, {"id": pack_id, "revision": entry["revision"], "changed": changed}, "ok"

        if method == "POST" and path == "/owner-api/core/pack/try":
            if self.try_override is not None:
                return self.try_override
            live = bool(body.get("live"))
            return 200, {
                "mood": "calm",
                "shape": {"length": "default", "maxChars": 600, "lengthBypass": False},
                "reply": self.try_reply,
                "live": live,
            }, "ok"

        return 404, {"error": "not_found"}, "ok"


class PackCommandTests(unittest.TestCase):
    def setUp(self):
        temp = tempfile.TemporaryDirectory(prefix="aira-pack-fixture-")
        self.addCleanup(temp.cleanup)
        self.root = Path(temp.name)
        self.home = self.root / "install"
        self.home.mkdir(mode=0o700)
        self.env = patch.dict(
            os.environ,
            {
                "HOME": str(self.root),
                "PATH": os.environ.get("PATH", ""),
                "XDG_CONFIG_HOME": str(self.root / "config"),
                "XDG_STATE_HOME": str(self.root / "state"),
            },
            clear=True,
        )
        self.env.start()
        self.addCleanup(self.env.stop)

        self.api = FakeOwnerApi()
        self.selection = {
            "home": self.home,
            "manifest": None,
            "mode": "standalone",
            "project": "aira-fixture",
            "bindings": {9881: ("127.0.0.1", 9881), 9890: ("127.0.0.1", 9890)},
            "token": FIXTURE_TOKEN,
            "base": "http://127.0.0.1:9890",
        }
        self.state = {
            "state": {
                "installation": "installed",
                "service": "running",
                "persistence": "verified",
                "configuration": "configured",
                "hermes": "connected",
                "chatbot": "ready",
            }
        }

    def write_json(self, name: str, payload) -> Path:
        path = self.root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(payload), encoding="utf-8")
        return path

    def run_cli(self, argv: list[str]):
        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            patch.object(configure, "selected_api", return_value=self.selection),
            patch.object(configure, "api_request", side_effect=self.api.request),
            patch.object(install, "observe", return_value=self.state),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            code = main.main(argv)
        return code, stdout.getvalue(), stderr.getvalue()

    def test_json_flag_accepted_before_between_and_after_subcommands(self):
        draft_path = self.write_json("valid.json", make_draft())
        for argv in (
            ["--json", "pack", "schema"],
            ["pack", "--json", "schema"],
            ["pack", "schema", "--json"],
            ["--json", "pack", "check", str(draft_path)],
            ["pack", "--json", "check", str(draft_path)],
            ["pack", "check", str(draft_path), "--json"],
            ["pack", "--home", str(self.home), "schema", "--json"],
            ["pack", "--non-interactive", "schema", "--json"],
        ):
            with self.subTest(argv=argv):
                code, out, err = self.run_cli(argv)
                self.assertEqual(code, 0, err)
                self.assertEqual(err, "")
                parsed = json.loads(out)
                self.assertEqual(parsed["schemaVersion"], 1)
                self.assertEqual(parsed["command"], "pack")
                self.assertEqual(parsed["outcome"], "ok")

    def test_missing_required_flags_and_unsafe_pack_id_return_exit_args(self):
        draft_path = self.write_json("draft.json", make_draft())
        code_human, _, err_human = self.run_cli(["pack"])
        self.assertEqual(code_human, 2)
        self.assertIn("invalid_args", err_human)
        for argv in (
            ["pack", "--json"],
            ["pack", "update", str(draft_path), "--json"],
            ["pack", "update", str(draft_path), "--expected-revision", "", "--json"],
            ["pack", "get", "../escape", "--json"],
            ["pack", "get", "Bad_Id", "--json"],
            ["pack", "try", "fixture_fox", "   ", "--json"],
            ["pack", "try", "Bad_Id", "hello", "--json"],
        ):
            with self.subTest(argv=argv):
                code, out, _ = self.run_cli(argv)
                self.assertEqual(code, 2)
                self.assertEqual(self.api.calls, [])
                parsed = json.loads(out)
                self.assertEqual(parsed["outcome"], "error")
                self.assertEqual(parsed["error"]["exitClass"], "invalid_arguments")

    def test_wildcard_legacy_binding_uses_numeric_loopback(self):
        self.selection = {
            **self.selection, "mode": "legacy",
            "bindings": {9890: ("0.0.0.0", 9890)}, "base": "http://127.0.0.1:9890",
        }
        code, out, _ = self.run_cli(["pack", "schema", "--json"])
        self.assertEqual(code, 0)
        self.assertEqual(json.loads(out)["pack"]["action"], "schema")

    def test_non_loopback_owner_endpoint_refused_in_legacy_and_standalone_without_leaking_token(self):
        bad_selections = [
            {
                **self.selection,
                "mode": "legacy",
                "bindings": {9881: ("127.0.0.1", 9881), 9890: ("192.0.2.10", 9890)},
                "base": "http://192.0.2.10:9890",
            },
            {
                **self.selection,
                "mode": "standalone",
                "bindings": {9881: ("127.0.0.1", 9881), 9890: ("10.0.0.5", 9890)},
                "base": "http://10.0.0.5:9890",
            },
            {
                "mode": "legacy",
                "home": self.home,
                "manifest": None,
                "token": FIXTURE_TOKEN,
                "base": "http://example.invalid:9890",
            },
        ]
        bad_selections.extend([
            {**self.selection, "base": "http://127.0.0.1"},
            {**self.selection, "base": "http://127.0.0.1:9890/not-core"},
        ])
        for bad in bad_selections:
            with self.subTest(bad=bad.get("bindings") or bad.get("base")):
                self.selection = bad
                code, out, err = self.run_cli(["pack", "schema", "--json"])
                self.assertEqual(code, 4)
                self.assertEqual(self.api.calls, [])
                self.assertNotIn(FIXTURE_TOKEN, out)
                self.assertNotIn(FIXTURE_TOKEN, err)
                parsed = json.loads(out)
                self.assertEqual(parsed["error"]["code"], "port_conflict")

        # Loopback legacy endpoint is allowed.
        self.selection = {
            **self.selection,
            "mode": "legacy",
            "bindings": {9881: ("0.0.0.0", 9881), 9890: ("127.0.0.1", 9890)},
            "base": "http://127.0.0.1:9890",
        }
        code, out, _ = self.run_cli(["pack", "schema", "--json"])
        self.assertEqual(code, 0)
        self.assertNotIn(FIXTURE_TOKEN, out)

    def test_schema_and_get_output_in_json_and_human_stdout(self):
        draft = make_draft("alpha_fox")
        self.api.seed_pack("alpha_fox", draft, source="repository", revision=FIXTURE_REV_1)

        code, out, _ = self.run_cli(["pack", "schema"])
        self.assertEqual(code, 0)
        self.assertIn("setupPrompt", out)
        self.assertIn("optional instructions", out)
        self.assertIn("schema", out)

        code, out, _ = self.run_cli(["pack", "get", "alpha_fox"])
        self.assertEqual(code, 0)
        self.assertIn("alpha_fox", out)
        self.assertIn("repository", out)
        self.assertIn(FIXTURE_REV_1, out)
        self.assertIn("Fixture Fox", out)

        code, out, _ = self.run_cli(["pack", "get", "alpha_fox", "--json"])
        self.assertEqual(code, 0)
        parsed = json.loads(out)
        self.assertEqual(parsed["pack"]["id"], "alpha_fox")
        self.assertFalse(parsed["pack"]["writable"])
        self.assertEqual(parsed["pack"]["revision"], FIXTURE_REV_1)
        self.assertEqual(parsed["pack"]["card"], draft["card"])
        self.assertEqual(parsed["pack"]["moods"], draft["moods"])
        self.assertEqual(parsed["pack"]["lines"], draft["lines"])

    def test_malformed_and_bounded_file_reads_fail_without_api_calls(self):
        missing = self.root / "missing.json"
        target_real = self.write_json("real.json", make_draft())
        symlink = self.root / "link.json"
        symlink.symlink_to(target_real)
        directory = self.root / "dir.json"
        directory.mkdir()
        bad_json = self.root / "bad.json"
        bad_json.write_text("{not-json", encoding="utf-8")
        nonfinite = self.root / "nan.json"
        nonfinite.write_text('{"card": {"x": NaN}, "moods": {}, "lines": {}}', encoding="utf-8")
        dup_keys = self.root / "dup.json"
        dup_keys.write_text('{"card": {}, "card": {}, "moods": {}, "lines": {}}', encoding="utf-8")
        extra_key = self.write_json("extra.json", {**make_draft(), "extra": 1})
        missing_key = self.write_json("missing_key.json", {"card": {}, "moods": {}})
        non_obj_doc = self.write_json("list_doc.json", {"card": [], "moods": {}, "lines": {}})
        oversized = self.root / "huge.json"
        oversized.write_bytes(b"{" + b" " * (pack.MAX_PACK_FILE_BYTES + 32) + b"}")

        for bad_path in (missing, symlink, directory, bad_json, nonfinite, dup_keys, oversized):
            with self.subTest(path=bad_path.name):
                code, out, _ = self.run_cli(["pack", "check", str(bad_path), "--json"])
                self.assertEqual(code, 1)
                self.assertEqual(self.api.calls, [])
                parsed = json.loads(out)
                self.assertEqual(parsed["outcome"], "error")
                self.assertNotIn("secret", out.lower())

        for invalid in (extra_key, missing_key, non_obj_doc):
            self.api.calls.clear()
            self.api.check_override = lambda _body: (
                200, {"id": "", "ok": False, "faults": ["root: invalid", "card.yml: invalid"],
                      "ceiling": 4096, "moods": 0, "stickers": 0}, "ok")
            code, out, _ = self.run_cli(["pack", "check", str(invalid), "--json"])
            self.assertEqual(code, 1)
            self.assertEqual(len(self.api.calls), 1)
            self.assertEqual(len(json.loads(out)["pack"]["faults"]), 2)

    def test_check_validation_failure_reports_all_faults_in_json_and_human_stdout(self):
        faults = [
            "card: displayName: required",
            "moods: moods.calm.faces: invalid kaomoji",
            "prompt over the ceiling",
        ]
        self.api.check_override = lambda _body: (
            200,
            {
                "id": "fixture_fox",
                "ok": False,
                "faults": faults,
                "ceiling": 4096,
                "promptTokens": 4512,
                "moods": 1,
                "stickers": 0,
            },
            "ok",
        )
        draft_path = self.write_json("invalid.json", make_draft())

        code, out, err = self.run_cli(["pack", "check", str(draft_path), "--json"])
        self.assertEqual(code, 1)
        self.assertEqual(err, "")
        parsed = json.loads(out)
        self.assertEqual(parsed["outcome"], "error")
        self.assertEqual(parsed["error"]["code"], "invalid_draft")
        self.assertEqual(parsed["pack"]["ok"], False)
        self.assertEqual(parsed["pack"]["faults"], faults)
        self.assertEqual(parsed["pack"]["promptTokens"], 4512)
        self.assertEqual(parsed["pack"]["ceiling"], 4096)
        self.assertNotIn("existingId", self.api.calls[-1]["body"])

        code_h, out_h, err_h = self.run_cli(["pack", "check", str(draft_path)])
        self.assertEqual(code_h, 1)
        self.assertIn("invalid_draft", err_h)
        for fault in faults:
            self.assertIn(fault, out_h)
        self.assertIn("4512/4096", out_h)

        # Malformed request (400) maps to operational error.
        self.api.check_override = lambda _body: (400, {"error": "invalid_body"}, "ok")
        code_400, out_400, _ = self.run_cli(["pack", "check", str(draft_path), "--json"])
        self.assertEqual(code_400, 1)
        self.assertEqual(json.loads(out_400)["error"]["code"], "invalid_body")

    def test_import_dry_run_and_duplicate_conflict_including_repository_and_faults(self):
        self.api.seed_pack("repo_fox", make_draft("repo_fox"), source="repository")
        self.api.faults = [{"id": "broken_fox", "reason": "invalid card.yml"}]

        for dup_id in ("repo_fox", "broken_fox"):
            with self.subTest(dup_id=dup_id):
                path = self.write_json(f"{dup_id}.json", make_draft(dup_id))
                self.api.calls.clear()
                code, out, _ = self.run_cli(["pack", "import", str(path), "--dry-run", "--json"])
                self.assertEqual(code, 4)
                parsed = json.loads(out)
                self.assertEqual(parsed["error"]["code"], "conflict")
                self.assertFalse(any(
                    c["method"] == "POST" and c["path"] == "/owner-api/core/characters" for c in self.api.calls
                ))

        new_path = self.write_json("new_fox.json", make_draft("new_fox"))
        self.api.calls.clear()
        code, out, _ = self.run_cli(["pack", "import", str(new_path), "--dry-run", "--json"])
        self.assertEqual(code, 0)
        parsed = json.loads(out)
        self.assertTrue(parsed["pack"]["dryRun"])
        self.assertFalse(parsed["pack"]["changed"])
        self.assertNotIn("new_fox", self.api.packs)
        self.assertEqual(
            [(c["method"], c["path"]) for c in self.api.calls],
            [("POST", "/owner-api/core/pack/check"), ("GET", "/owner-api/core/characters")],
        )

        # Real import creates via POST /characters and catches atomic server conflict.
        self.api.calls.clear()
        code, out, _ = self.run_cli(["pack", "import", str(new_path), "--json"])
        self.assertEqual(code, 0)
        parsed = json.loads(out)
        self.assertFalse(parsed["pack"]["dryRun"])
        self.assertTrue(parsed["pack"]["changed"])
        self.assertEqual(parsed["pack"]["revision"], FIXTURE_REV_1)
        self.assertIn("new_fox", self.api.packs)
        self.assertEqual(
            [(c["method"], c["path"]) for c in self.api.calls],
            [
                ("POST", "/owner-api/core/pack/check"),
                ("GET", "/owner-api/core/characters"),
                ("POST", "/owner-api/core/characters"),
            ],
        )

        # Atomic server conflict on POST /characters even if GET /characters did not show it yet.
        race_path = self.write_json("race_fox.json", make_draft("race_fox"))
        self.api.create_conflict = True
        code, out, _ = self.run_cli(["pack", "import", str(race_path), "--json"])
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(out)["error"]["code"], "conflict")

        # Validation failure during import reports all faults and never queries characters or POSTs.
        self.api.create_conflict = False
        self.api.calls.clear()
        self.api.check_override = lambda _body: (
            200,
            {"id": "bad_fox", "ok": False, "faults": ["fault a", "fault b"],
             "ceiling": 4096, "moods": 1, "stickers": 0},
            "ok",
        )
        bad_import = self.write_json("bad_import.json", make_draft("bad_fox"))
        code, out, _ = self.run_cli(["pack", "import", str(bad_import), "--dry-run", "--json"])
        self.assertEqual(code, 1)
        parsed = json.loads(out)
        self.assertEqual(parsed["error"]["code"], "invalid_draft")
        self.assertEqual(parsed["pack"]["faults"], ["fault a", "fault b"])
        self.assertEqual([(c["method"], c["path"]) for c in self.api.calls], [("POST", "/owner-api/core/pack/check")])

    def test_update_dry_run_merge_patch_deletion_arrays_and_real_write(self):
        initial = make_draft("edit_fox")
        self.api.seed_pack("edit_fox", initial, source="data", revision=FIXTURE_REV_1)

        updated = make_draft("edit_fox")
        del updated["card"]["aliases"]  # optional key deletion -> null
        del updated["card"]["toolFooter"]["icon"]  # nested optional key deletion -> null
        updated["card"]["speechRules"] = ["One crisp rule."]  # array replacement
        updated["moods"]["moods"]["calm"]["tone"] = "focused and brief"  # nested object merge patch
        del updated["lines"]["feedback"]  # optional line deletion -> null
        draft_path = self.write_json("edit_fox.json", updated)

        # Dry run performs only reads and check, never PUT.
        code, out, _ = self.run_cli([
            "pack", "update", str(draft_path), "--expected-revision", FIXTURE_REV_1, "--dry-run",
        ])
        self.assertEqual(code, 0)
        self.assertIn("card.aliases", out)
        self.assertIn("card.toolFooter.icon", out)
        self.assertIn("card.speechRules", out)
        self.assertIn("moods.moods.calm.tone", out)
        self.assertIn("lines.feedback", out)
        self.assertFalse(any(c["method"] == "PUT" for c in self.api.calls))
        check_call = next(c for c in self.api.calls if c["path"] == "/owner-api/core/pack/check")
        self.assertEqual(check_call["body"]["existingId"], "edit_fox")
        self.assertEqual(self.api.packs["edit_fox"]["revision"], FIXTURE_REV_1)

        # Real write supplies original expected revision and RFC7396 merge patch.
        self.api.calls.clear()
        code, out, _ = self.run_cli([
            "pack", "update", str(draft_path), "--expected-revision", FIXTURE_REV_1, "--json",
        ])
        self.assertEqual(code, 0)
        parsed = json.loads(out)
        self.assertTrue(parsed["pack"]["changed"])
        self.assertEqual(parsed["pack"]["expectedRevision"], FIXTURE_REV_1)
        self.assertEqual(parsed["pack"]["revision"], FIXTURE_REV_2)
        put_calls = [c for c in self.api.calls if c["method"] == "PUT"]
        self.assertEqual(len(put_calls), 1)
        self.assertEqual(put_calls[0]["body"], {
            "expectedRevision": FIXTURE_REV_1,
            "patch": {
                "card": {
                    "aliases": None,
                    "toolFooter": {"icon": None},
                    "speechRules": ["One crisp rule."],
                },
                "moods": {"moods": {"calm": {"tone": "focused and brief"}}},
                "lines": {"feedback": None},
            },
        })
        stored = self.api.packs["edit_fox"]
        self.assertNotIn("aliases", stored["card"])
        self.assertNotIn("icon", stored["card"]["toolFooter"])
        self.assertEqual(stored["card"]["speechRules"], ["One crisp rule."])
        self.assertEqual(stored["moods"]["moods"]["calm"]["tone"], "focused and brief")
        self.assertEqual(stored["moods"]["moods"]["calm"]["openers"], ["Oh, hey"])
        self.assertNotIn("feedback", stored["lines"])

    def test_update_noop_and_conflicts(self):
        draft = make_draft("noop_fox")
        self.api.seed_pack("noop_fox", draft, source="data", revision=FIXTURE_REV_1)
        draft_path = self.write_json("noop_fox.json", draft)

        code, out, _ = self.run_cli([
            "pack", "update", str(draft_path), "--expected-revision", FIXTURE_REV_1,
        ])
        self.assertEqual(code, 0)
        self.assertIn("no changes", out.lower())
        self.assertTrue(any(c["method"] == "PUT" and c["body"]["patch"] == {} for c in self.api.calls))

        code_j, out_j, _ = self.run_cli([
            "pack", "update", str(draft_path), "--expected-revision", FIXTURE_REV_1, "--json",
        ])
        self.assertEqual(code_j, 0)
        parsed = json.loads(out_j)
        self.assertFalse(parsed["pack"]["changed"])
        self.assertEqual(parsed["pack"]["diff"], [])
        self.assertEqual(parsed["pack"]["revision"], FIXTURE_REV_1)

        # Stale revision refused before check or PUT.
        self.api.calls.clear()
        changed = make_draft("noop_fox", displayName="Changed Fox")
        changed_path = self.write_json("changed_fox.json", changed)
        code, out, _ = self.run_cli([
            "pack", "update", str(changed_path), "--expected-revision", FIXTURE_REV_2, "--json",
        ])
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(out)["error"]["code"], "stale_revision")
        self.assertEqual([(c["method"], c["path"]) for c in self.api.calls], [
            ("GET", "/owner-api/core/characters/noop_fox/studio"),
        ])

        # Server stale race on PUT still returns conflict (4).
        self.api.stale_on_put = True
        code, out, _ = self.run_cli([
            "pack", "update", str(changed_path), "--expected-revision", FIXTURE_REV_1, "--json",
        ])
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(out)["error"]["code"], "stale_revision")

        self.api.calls.clear()
        code, out, _ = self.run_cli([
            "pack", "update", str(draft_path), "--expected-revision", FIXTURE_REV_1, "--json",
        ])
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(out)["error"]["code"], "stale_revision")

        # Read-only repository pack refused before check or PUT.
        self.api.stale_on_put = False
        self.api.seed_pack("repo_ro", make_draft("repo_ro"), source="repository", revision=FIXTURE_REV_1)
        ro_path = self.write_json("repo_ro.json", make_draft("repo_ro", displayName="Edited"))
        self.api.calls.clear()
        code, out, _ = self.run_cli([
            "pack", "update", str(ro_path), "--expected-revision", FIXTURE_REV_1, "--json",
        ])
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(out)["error"]["code"], "pack_read_only")
        self.assertEqual([(c["method"], c["path"]) for c in self.api.calls], [
            ("GET", "/owner-api/core/characters/repo_ro/studio"),
        ])

    def test_pack_route_errors_distinguish_old_core_missing_pack_and_preview_failure(self):
        draft = make_draft("fixture_fox")
        self.api.seed_pack("fixture_fox", draft, revision=FIXTURE_REV_1)
        path = self.write_json("draft.json", draft)
        self.api.check_override = lambda _body: (404, {"error": "not_found"}, "ok")
        code, out, _ = self.run_cli(["pack", "update", str(path), "--expected-revision", FIXTURE_REV_1, "--json"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["error"]["code"], "capability_unavailable")
        for status, error, target, expected in (
            (404, "not_found", str(path), "capability_unavailable"),
            (404, "not_found", "fixture_fox", "capability_unavailable"),
            (404, "pack_not_found", "missing", "not_found"),
            (503, "preview_unavailable", "fixture_fox", "preview_unavailable"),
        ):
            self.api.try_override = (status, {"error": error}, "ok")
            code, out, _ = self.run_cli(["pack", "try", target, "hello", "--live", "--json"])
            self.assertEqual(code, 1)
            self.assertEqual(json.loads(out)["error"]["code"], expected)
        self.api.try_override = (400, {
            "error": "invalid_pack", "id": "fixture_fox", "ok": False, "faults": ["card: invalid"],
            "ceiling": 4096, "moods": 0, "stickers": 0
        }, "ok")
        code, out, _ = self.run_cli(["pack", "try", str(path), "hello", "--json"])
        self.assertEqual(code, 1)
        self.assertEqual(json.loads(out)["pack"]["faults"], ["card: invalid"])

    def test_update_validation_failure_reports_all_faults_and_never_puts(self):
        self.api.seed_pack("val_fox", make_draft("val_fox"), source="data", revision=FIXTURE_REV_1)
        bad_draft = make_draft("val_fox", displayName="Updated")
        draft_path = self.write_json("val_fox.json", bad_draft)
        self.api.check_override = lambda _body: (
            200,
            {"id": "val_fox", "ok": False, "faults": ["fault one", "fault two"],
             "ceiling": 4096, "moods": 1, "stickers": 0},
            "ok",
        )
        code, out, _ = self.run_cli([
            "pack", "update", str(draft_path), "--expected-revision", FIXTURE_REV_1, "--json",
        ])
        self.assertEqual(code, 1)
        parsed = json.loads(out)
        self.assertEqual(parsed["error"]["code"], "invalid_draft")
        self.assertEqual(parsed["pack"]["faults"], ["fault one", "fault two"])
        self.assertFalse(any(c["method"] == "PUT" for c in self.api.calls))

    def test_auth_failures_return_conflict_exit_4_without_exposing_token(self):
        for status in (401, 403):
            with self.subTest(status=status):
                self.api.auth_status = status
                code, out, err = self.run_cli(["pack", "schema", "--json"])
                self.assertEqual(code, 4)
                self.assertNotIn(FIXTURE_TOKEN, out)
                self.assertNotIn(FIXTURE_TOKEN, err)
                parsed = json.loads(out)
                self.assertEqual(parsed["error"]["code"], "owner_auth_failed")
                self.assertEqual(parsed["error"]["exitClass"], "conflict")

        # Token read failure from selected_api also maps to exit 4.
        stdout = io.StringIO()
        stderr = io.StringIO()
        with (
            patch.object(
                configure,
                "selected_api",
                side_effect=result.operational_error(
                    "owner_auth_failed", "The owner credential is unavailable.", "verify"
                ),
            ),
            contextlib.redirect_stdout(stdout),
            contextlib.redirect_stderr(stderr),
        ):
            code = main.main(["pack", "schema", "--json"])
        self.assertEqual(code, 4)
        self.assertEqual(json.loads(stdout.getvalue())["error"]["code"], "owner_auth_failed")

    def test_try_id_and_file_with_live_flag_and_bounded_timeout(self):
        # ID mode (scripted default).
        code, out, _ = self.run_cli(["pack", "try", "fixture_fox", "hello there"])
        self.assertEqual(code, 0)
        self.assertIn("calm", out)
        self.assertIn(self.api.try_reply, out)
        call = self.api.calls[-1]
        self.assertEqual(call["method"], "POST")
        self.assertEqual(call["path"], "/owner-api/core/pack/try")
        self.assertEqual(call["body"], {"id": "fixture_fox", "message": "hello there", "live": False})
        self.assertLessEqual(call["timeout_s"], 30)

        # FILE mode selected by .json extension and live mode bounded <= 120s.
        draft = make_draft("draft_fox")
        draft_path = self.write_json("try_draft.json", draft)
        self.api.calls.clear()
        code, out, _ = self.run_cli(["pack", "try", str(draft_path), "ping", "--live", "--json"])
        self.assertEqual(code, 0)
        parsed = json.loads(out)
        self.assertTrue(parsed["pack"]["live"])
        self.assertEqual(parsed["pack"]["mood"], "calm")
        self.assertEqual(parsed["pack"]["reply"], self.api.try_reply)
        call = self.api.calls[-1]
        self.assertEqual(call["body"], {"draft": draft, "message": "ping", "live": True})
        self.assertGreater(call["timeout_s"], 10)
        self.assertLessEqual(call["timeout_s"], 120)

        # Non-.json path with '/' is treated as FILE, not ID.
        rel_path = self.root / "sub" / "pack_file"
        rel_path.parent.mkdir(parents=True)
        rel_path.write_text(json.dumps(draft), encoding="utf-8")
        self.api.calls.clear()
        code, out, _ = self.run_cli(["pack", "try", str(rel_path), "path check", "--json"])
        self.assertEqual(code, 0)
        self.assertIn("draft", self.api.calls[-1]["body"])
        self.assertNotIn("id", self.api.calls[-1]["body"])
        self.assertFalse(any(
            c["method"] == "PUT" or (c["method"] == "POST" and c["path"] == "/owner-api/core/characters")
            for c in self.api.calls
        ))


if __name__ == "__main__":
    unittest.main()
