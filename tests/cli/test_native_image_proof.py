"""Synthetic proof and index fixtures; no registry or Docker calls."""

import copy
import json
import tempfile
import unittest
from pathlib import Path

from scripts.native_image_proof import PLATFORMS, read_proofs, verify_index


class NativeImageProofTests(unittest.TestCase):
    def setUp(self):
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.root = Path(temporary.name)
        self.commit = "a" * 40
        for number, platform in enumerate(PLATFORMS, 1):
            directory = self.root / f"image-proof-{platform.split('/')[1]}"
            directory.mkdir()
            (directory / "image-proof.json").write_text(json.dumps({
                "commit": self.commit, "platform": platform, "imageId": "sha256:" + str(number) * 64,
                "manifestDigest": "sha256:" + str(number + 2) * 64,
                "configDigest": "sha256:" + str(number + 4) * 64,
            }))
        self.proofs = read_proofs(self.root, self.commit)
        self.index = {
            "schemaVersion": 2, "mediaType": "application/vnd.oci.image.index.v1+json",
            "manifests": [{"platform": {"os": "linux", "architecture": platform.split("/")[1]},
                            "digest": value["manifestDigest"]} for platform, value in self.proofs.items()],
        }

    def test_accepts_exact_native_proofs_in_either_index_order(self):
        verify_index(self.index, self.proofs)
        self.index["manifests"].reverse()
        verify_index(self.index, self.proofs)

    def test_refuses_wrong_commit_missing_and_unexpected_proofs(self):
        with self.assertRaises(ValueError):
            read_proofs(self.root, "b" * 40)
        (self.root / "image-proof-extra").mkdir()
        with self.assertRaises(ValueError):
            read_proofs(self.root, self.commit)
        (self.root / "image-proof-extra").rmdir()
        arm = self.root / "image-proof-arm64"
        (arm / "image-proof.json").unlink()
        arm.rmdir()
        with self.assertRaises(ValueError):
            read_proofs(self.root, self.commit)

    def test_refuses_duplicate_or_modified_native_proofs(self):
        arm = self.root / "image-proof-arm64" / "image-proof.json"
        for changed in ({"platform": "linux/amd64"}, {"manifestDigest": self.proofs["linux/amd64"]["manifestDigest"]},
                        {"configDigest": self.proofs["linux/amd64"]["configDigest"]}, {"imageId": "untrusted"}):
            with self.subTest(changed=changed):
                arm.write_text(json.dumps({**self.proofs["linux/arm64"], **changed}))
                with self.assertRaises(ValueError):
                    read_proofs(self.root, self.commit)

    def test_refuses_missing_extra_foreign_and_unproved_index_children(self):
        original = self.index["manifests"]
        wrong_digest = {**original[0], "digest": "sha256:" + "f" * 64}
        foreign = {**original[0], "platform": {"os": "windows", "architecture": "amd64"}}
        for manifests in ([original[0]], original + [original[1]], [original[0], original[0]],
                          [wrong_digest, original[1]], [foreign, original[1]]):
            with self.subTest(manifests=manifests):
                index = copy.deepcopy(self.index)
                index["manifests"] = manifests
                with self.assertRaises(ValueError):
                    verify_index(index, self.proofs)
