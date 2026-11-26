"""Exercise typed delivery on the disposable exact stock checkout, restoring v1 afterwards."""

import argparse
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT))

from deploy.cli import hermes_versions
from deploy.gateway import standalone_patch


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("source", type=Path)
    parser.add_argument("--documents", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    version = hermes_versions.version_for_head(head)
    if version is None:
        raise ValueError("unreviewed disposable Hermes checkout")
    target = source / standalone_patch.TARGET
    helper = target.with_name("aira_transport.py")
    fixture = "hermes_document_fixture.py" if args.documents else "hermes_typed_fixture.py"
    test = source / "tests/gateway" / ("test_aira_" + fixture)
    original, existing = target.read_bytes(), helper.read_bytes()
    base = (ROOT / "deploy/gateway/standalone_adapter.py").read_bytes()
    typed = (ROOT / "deploy/gateway/standalone_typed_adapter.py").read_bytes()
    if (standalone_patch.classify_source(original) != "patched"
            or existing != hermes_versions.render_helper(base, version) or test.exists()):
        raise ValueError("disposable checkout is not the exact v1 fixture")
    try:
        target.write_bytes(standalone_patch.select_protocol(original, 2))
        if args.documents:
            document = (ROOT / "deploy/gateway/standalone_document_adapter.py").read_bytes()
            helper.write_bytes(hermes_versions.render_document_helper(base, document, version))
        else:
            helper.write_bytes(hermes_versions.render_typed_helper(base, typed, version))
        test.write_bytes((ROOT / "tests/install" / fixture).read_bytes())
        return subprocess.run([str(source / ".venv/bin/python"), "-m", "pytest", "-q", str(test.relative_to(source))],
                              cwd=source, check=False).returncode
    finally:
        target.write_bytes(original)
        helper.write_bytes(existing)
        test.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
