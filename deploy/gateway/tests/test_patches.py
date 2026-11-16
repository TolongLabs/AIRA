"""Tests for deploy/gateway/patches.py on invented trees. The real gateway tree is never touched here."""

import importlib.util
import io
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parents[1]
spec = importlib.util.spec_from_file_location("gateway_patches", HERE / "patches.py")
patches = importlib.util.module_from_spec(spec)
spec.loader.exec_module(patches)

PY = [sys.executable, "-m", "py_compile", "{target}"]


def patch(**over):
    base = {
        "name": "demo",
        "target": "gateway/demo.py",
        "present": "# [demo]",
        "edits": (("x = 1\n", "x = 1  # [demo]\n"),),
        "syntax": PY,
        "tests": [],
        "cwd": ".",
        "why": "a demo",
    }
    base.update(over)
    return base


class ApplyTest(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.TemporaryDirectory()
        self.addCleanup(self.dir.cleanup)
        self.tree = Path(self.dir.name)
        (self.tree / "gateway").mkdir()
        self.file = self.tree / "gateway" / "demo.py"
        self.file.write_text("x = 1\n", encoding="utf-8")

    def apply(self, p, check_only=False):
        with redirect_stdout(io.StringIO()) as out:
            ok = patches.apply_patch(p, self.tree, check_only=check_only, python=sys.executable)
        return ok, out.getvalue()

    def test_apply_then_repeat(self):
        ok, out = self.apply(patch())
        self.assertTrue(ok)
        self.assertIn("applied, syntax and tests OK", out)
        self.assertEqual(self.file.read_text(encoding="utf-8"), "x = 1  # [demo]\n")
        ok, out = self.apply(patch())
        self.assertTrue(ok)
        self.assertIn("already applied", out)

    def test_check_only_writes_nothing(self):
        ok, out = self.apply(patch(), check_only=True)
        self.assertFalse(ok)
        self.assertIn("ABSENT", out)
        self.assertEqual(self.file.read_text(encoding="utf-8"), "x = 1\n")

    def test_a_missing_or_repeated_anchor_writes_nothing(self):
        for text in ("y = 2\n", "x = 1\nx = 1\n"):
            self.file.write_text(text, encoding="utf-8")
            ok, out = self.apply(patch())
            self.assertFalse(ok)
            self.assertIn("ABORT", out)
            self.assertEqual(self.file.read_text(encoding="utf-8"), text)
        self.assertEqual(list(self.tree.glob("gateway/*.bak-*")), [])

    def test_a_failed_check_restores_the_file(self):
        broken = patch(edits=(("x = 1\n", "x = (  # [demo]\n"),))
        ok, out = self.apply(broken)
        self.assertFalse(ok)
        self.assertIn("FAILED", out)
        self.assertEqual(self.file.read_text(encoding="utf-8"), "x = 1\n")

    def test_a_failed_test_restores_the_file(self):
        failing = patch(tests=[[sys.executable, "-c", "raise SystemExit(3)"]])
        ok, _ = self.apply(failing)
        self.assertFalse(ok)
        self.assertEqual(self.file.read_text(encoding="utf-8"), "x = 1\n")

    def test_a_removal_is_applied_when_its_mark_is_absent(self):
        self.file.write_text("x = 1\ntrace()  # [trace]\n", encoding="utf-8")
        removal = patch(present=None, edits=(("trace()  # [trace]\n", ""),))
        del removal["present"]
        removal["absent"] = "[trace]"
        ok, _ = self.apply(removal)
        self.assertTrue(ok)
        self.assertEqual(self.file.read_text(encoding="utf-8"), "x = 1\n")
        self.assertIn("already applied", self.apply(removal)[1])

    def test_a_missing_target_fails(self):
        ok, out = self.apply(patch(target="gateway/none.py"))
        self.assertFalse(ok)
        self.assertIn("TARGET MISSING", out)


class RealPatchesTest(unittest.TestCase):
    def test_each_patch_is_well_formed(self):
        names = [p["name"] for p in patches.patches()]
        self.assertEqual(len(names), len(set(names)))
        self.assertIn("sticker-media-type", names)
        for p in patches.patches():
            with self.subTest(p["name"]):
                self.assertEqual(("present" in p) + ("absent" in p), 1)
                self.assertTrue(p["edits"])
                for find, replace in p["edits"]:
                    self.assertNotEqual(find, replace)
                    self.assertNotIn(find, replace)
                joined_find = "".join(find for find, _ in p["edits"])
                joined_replace = "".join(replace for _, replace in p["edits"])
                if "present" in p:
                    self.assertNotIn(p["present"], joined_find)
                    self.assertIn(p["present"], joined_replace)
                else:
                    self.assertIn(p["absent"], joined_find)
                    self.assertNotIn(p["absent"], joined_replace)

    def test_a_tree_that_is_not_a_gateway_is_refused(self):
        with tempfile.TemporaryDirectory() as empty, redirect_stdout(io.StringIO()):
            self.assertEqual(patches.main(["--hermes-agent", empty, "--check"]), 2)


if __name__ == "__main__":
    unittest.main()
