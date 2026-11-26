"""Validate the exact two native image proofs before publishing their shared index."""

import argparse
import json
import re
from pathlib import Path

PLATFORMS = ("linux/amd64", "linux/arm64")
DIGEST = re.compile(r"sha256:[a-f0-9]{64}")
COMMIT = re.compile(r"[a-f0-9]{40}")


def read_proofs(directory: Path, commit: str) -> dict:
    if not COMMIT.fullmatch(commit):
        raise ValueError("invalid source commit")
    expected = {f"image-proof-{platform.split('/')[1]}" for platform in PLATFORMS}
    if {path.name for path in directory.iterdir()} != expected:
        raise ValueError("missing or unexpected native proof")
    proofs = {}
    for platform in PLATFORMS:
        path = directory / f"image-proof-{platform.split('/')[1]}" / "image-proof.json"
        value = json.loads(path.read_text(encoding="utf-8"))
        if (not isinstance(value, dict)
                or set(value) != {"commit", "platform", "imageId", "configDigest", "manifestDigest"}
                or value["commit"] != commit or value["platform"] != platform
                or not all(isinstance(value[key], str) and DIGEST.fullmatch(value[key])
                           for key in ("imageId", "configDigest", "manifestDigest"))):
            raise ValueError("invalid native proof")
        proofs[platform] = value
    for key in ("manifestDigest", "configDigest"):
        if len({proof[key] for proof in proofs.values()}) != len(PLATFORMS):
            raise ValueError("duplicate native manifest or config")
    return proofs


def verify_index(index: dict, proofs: dict) -> None:
    if (not isinstance(index, dict) or index.get("schemaVersion") != 2 or index.get("mediaType") not in (
            "application/vnd.oci.image.index.v1+json", "application/vnd.docker.distribution.manifest.list.v2+json")
            or not isinstance(index.get("manifests"), list) or len(index["manifests"]) != len(PLATFORMS)):
        raise ValueError("expected a two-platform image index")
    actual = {}
    for descriptor in index["manifests"]:
        if not isinstance(descriptor, dict) or not isinstance(descriptor.get("platform"), dict):
            raise ValueError("missing native manifest platform")
        platform = f'{descriptor["platform"].get("os")}/{descriptor["platform"].get("architecture")}'
        if platform not in PLATFORMS or platform in actual:
            raise ValueError("unexpected or duplicate native platform")
        actual[platform] = descriptor.get("digest")
    if actual != {platform: proof["manifestDigest"] for platform, proof in proofs.items()}:
        raise ValueError("image index differs from the tested native manifests")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--commit", required=True)
    parser.add_argument("--proofs", type=Path, required=True)
    parser.add_argument("--index", type=Path)
    args = parser.parse_args()
    proofs = read_proofs(args.proofs, args.commit)
    if args.index:
        verify_index(json.loads(args.index.read_text(encoding="utf-8")), proofs)
    print(json.dumps(proofs, sort_keys=True))


if __name__ == "__main__":
    main()
