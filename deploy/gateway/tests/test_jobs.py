"""Tests for deploy/gateway/jobs.py: tagging the owner's gateway jobs."""

import importlib.util
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gateway_jobs", HERE / "jobs.py")
jobs = importlib.util.module_from_spec(spec)
spec.loader.exec_module(jobs)


class FakeJobs:
    def __init__(self, prompts):
        self.prompts = dict(prompts)
        self.updates = []

    def get_job(self, job_id):
        return {"id": job_id, "prompt": self.prompts[job_id]} if job_id in self.prompts else None

    def update_job(self, job_id, updates):
        self.updates.append(job_id)
        self.prompts[job_id] = updates["prompt"]


class RetagTest(unittest.TestCase):
    def test_tag_puts_the_tag_first_once(self):
        fake = FakeJobs({"a1": "Check the trains.", "b2": "Send a word."})
        result = jobs.retag(["a1", "b2"], "tag", fake.get_job, fake.update_job)
        self.assertEqual(result["changed"], ["a1", "b2"])
        self.assertEqual(fake.prompts["a1"], "[AIRA-SCHEDULED v1 kind=job id=a1]\nCheck the trains.")
        again = jobs.retag(["a1", "b2"], "tag", fake.get_job, fake.update_job)
        self.assertEqual(again["unchanged"], ["a1", "b2"])
        self.assertEqual(len(fake.updates), 2)

    def test_untag_restores_the_original_text(self):
        fake = FakeJobs({"a1": "Check the trains.\nTwice a day."})
        jobs.retag(["a1"], "tag", fake.get_job, fake.update_job)
        jobs.retag(["a1"], "untag", fake.get_job, fake.update_job)
        self.assertEqual(fake.prompts["a1"], "Check the trains.\nTwice a day.")
        again = jobs.retag(["a1"], "untag", fake.get_job, fake.update_job)
        self.assertEqual(again["unchanged"], ["a1"])

    def test_check_only_changes_nothing_and_missing_is_reported(self):
        fake = FakeJobs({"a1": "Check the trains."})
        result = jobs.retag(["a1", "zz"], "tag", fake.get_job, fake.update_job, check_only=True)
        self.assertEqual(result, {"changed": ["a1"], "unchanged": [], "missing": ["zz"]})
        self.assertEqual(fake.updates, [])

    def test_a_tag_with_another_id_is_replaced(self):
        fake = FakeJobs({"a1": "[AIRA-SCHEDULED v1 kind=job id=old]\nCheck the trains."})
        jobs.retag(["a1"], "tag", fake.get_job, fake.update_job)
        self.assertEqual(fake.prompts["a1"], "[AIRA-SCHEDULED v1 kind=job id=a1]\nCheck the trains.")


if __name__ == "__main__":
    unittest.main()
