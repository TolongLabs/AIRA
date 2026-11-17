"""Tests for deploy/gateway/schedule.py with a fake schedule. The gateway's real schedule is never touched here."""

import importlib.util
import io
import json
import os
import tempfile
import unittest
from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gateway_schedule", HERE / "schedule.py")
schedule = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schedule)

NOW = datetime(2026, 11, 16, 12, 0, tzinfo=timezone.utc)


def entry(rid="rem_a", chat="test-chat-d1@s.whatsapp.net", due="2026-11-17T08:00:00.000Z"):
    stamp = schedule.compact(datetime.fromisoformat(due.replace("Z", "+00:00")))
    return {"id": rid, "chat": chat, "due": due, "name": f"aira:{rid}:{stamp}",
            "text": f"[AIRA-SCHEDULED v1 kind=reminder id={rid} due={stamp}]"}


class FakeSchedule:
    def __init__(self, jobs=()):
        self.jobs = [dict(job) for job in jobs]
        self.created, self.removed = [], []

    def list_jobs(self):
        return [dict(job) for job in self.jobs]

    def create_job(self, **job):
        job_id = f"j{len(self.jobs) + 1}"
        self.jobs.append({"id": job_id, "name": job["name"], "state": "scheduled"})
        self.created.append(job)
        return {"id": job_id}

    def remove_job(self, job_id):
        self.jobs = [job for job in self.jobs if job["id"] != job_id]
        self.removed.append(job_id)
        return True

    def run(self, wanted, check_only=False):
        return schedule.reconcile(wanted, list_jobs=self.list_jobs, create_job=self.create_job,
                                  remove_job=self.remove_job, now=NOW, check_only=check_only)


class ReconcileTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        (Path(self.dir.name) / "gateway").mkdir()
        self.file = Path(self.dir.name) / "gateway" / "schedule.json"

    def wanted(self, *entries):
        self.file.write_text(json.dumps({"version": 1, "reminders": list(entries)}), encoding="utf-8")
        return schedule.read_wanted(self.file)

    def test_creates_a_missing_job_then_leaves_it(self):
        fake = FakeSchedule([{"id": "other", "name": "news digest", "state": "scheduled"}])
        wanted = self.wanted(entry())
        self.assertEqual(fake.run(wanted)["created"], ["aira:rem_a:20261117T080000Z"])
        job = fake.created[0]
        self.assertEqual(job["prompt"], "[AIRA-SCHEDULED v1 kind=reminder id=rem_a due=20261117T080000Z]")
        self.assertEqual(job["schedule"], "2026-11-17T08:00:00+00:00")
        self.assertEqual((job["repeat"], job["deliver"]), (1, "origin"))
        self.assertEqual(job["origin"]["chat_id"], "test-chat-d1@s.whatsapp.net")
        again = fake.run(wanted)
        self.assertEqual((again["created"], again["removed"], again["kept"]), ([], [], ["aira:rem_a:20261117T080000Z"]))
        self.assertEqual([job["name"] for job in fake.jobs], ["news digest", "aira:rem_a:20261117T080000Z"])

    def test_creates_a_research_job_and_refuses_a_mismatched_tag(self):
        research = entry(rid="res_test", chat="0000000000@g.us")
        research["text"] = "[AIRA-SCHEDULED v1 kind=research id=res_test]"
        fake = FakeSchedule()
        fake.run(self.wanted(research))
        self.assertEqual(fake.created[0]["prompt"], research["text"])
        self.assertEqual(fake.created[0]["origin"]["chat_id"], "0000000000@g.us")
        self.assertEqual(fake.created[0]["repeat"], 1)
        with self.assertRaises(schedule.BadFile):
            self.wanted(dict(research, text="[AIRA-SCHEDULED v1 kind=research id=res_other]"))

    def test_removes_unwanted_and_completed_aira_jobs_and_no_other_job(self):
        fake = FakeSchedule([
            {"id": "j1", "name": "aira:rem_old:20261101T080000Z", "state": "scheduled"},
            {"id": "j2", "name": "aira:rem_a:20261116T080000Z", "state": "completed"},
            {"id": "j3", "name": "market alert", "state": "scheduled"},
        ])
        result = fake.run(self.wanted())
        self.assertEqual(result["removed"], ["aira:rem_old:20261101T080000Z"])
        self.assertEqual(sorted(fake.removed), ["j1", "j2"])
        self.assertEqual([job["name"] for job in fake.jobs], ["market alert"])

    def test_a_moved_reminder_replaces_its_job(self):
        fake = FakeSchedule([{"id": "j1", "name": "aira:rem_a:20261116T080000Z", "state": "scheduled"}])
        result = fake.run(self.wanted(entry(due="2026-11-17T08:00:00.000Z")))
        self.assertEqual((result["removed"], result["created"]),
                         (["aira:rem_a:20261116T080000Z"], ["aira:rem_a:20261117T080000Z"]))

    def test_a_due_time_already_past_is_scheduled_a_minute_ahead(self):
        fake = FakeSchedule()
        fake.run(self.wanted(entry(due="2026-11-16T11:00:00.000Z")))
        self.assertEqual(fake.created[0]["schedule"], (NOW + timedelta(minutes=1)).isoformat())

    def test_check_only_changes_nothing(self):
        fake = FakeSchedule([{"id": "j1", "name": "aira:rem_old:20261101T080000Z", "state": "scheduled"}])
        result = fake.run(self.wanted(entry()), check_only=True)
        self.assertEqual((len(result["created"]), len(result["removed"])), (1, 1))
        self.assertEqual((fake.created, fake.removed), ([], []))

    def test_a_bad_file_is_refused(self):
        bad = [
            "not json",
            json.dumps({"version": 2, "reminders": []}),
            json.dumps({"version": 1, "reminders": [dict(entry(), id="bad id")]}),
            json.dumps({"version": 1, "reminders": [dict(entry(), chat="no-at-sign")]}),
            json.dumps({"version": 1, "reminders": [dict(entry(), due="2026-11-17T08:00:00")]}),
            json.dumps({"version": 1, "reminders": [dict(entry(), text="[AIRA-SCHEDULED v1 kind=reminder id=x due=y]")]}),
            json.dumps({"version": 1, "reminders": [dict(entry(), name="news digest")]}),
        ]
        for text in bad:
            self.file.write_text(text, encoding="utf-8")
            with self.assertRaises(schedule.BadFile, msg=text):
                schedule.read_wanted(self.file)
        self.file.unlink()
        with self.assertRaises(schedule.BadFile):
            schedule.read_wanted(self.file)

    def test_main_refuses_without_a_home_and_changes_nothing_for_a_bad_file(self):
        self.file.write_text("not json", encoding="utf-8")
        with redirect_stdout(io.StringIO()), mock.patch.dict(os.environ, {"HERMES_HOME": ""}):
            self.assertEqual(schedule.main(["--hermes-agent", self.dir.name, "--data-dir", self.dir.name]), 2)
        with redirect_stdout(io.StringIO()) as out, mock.patch.dict(os.environ, {"HERMES_HOME": self.dir.name}):
            self.assertEqual(schedule.main(["--hermes-agent", self.dir.name, "--data-dir", self.dir.name]), 1)
        self.assertIn("nothing changed", out.getvalue())


if __name__ == "__main__":
    unittest.main()
