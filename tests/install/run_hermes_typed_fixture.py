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
    capabilities = parser.add_mutually_exclusive_group()
    capabilities.add_argument("--documents", action="store_true")
    capabilities.add_argument("--media", action="store_true")
    capabilities.add_argument("--scheduler", action="store_true")
    args = parser.parse_args()
    source = args.source.resolve(strict=True)
    head = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=source, text=True).strip()
    version = hermes_versions.version_for_head(head)
    if version is None:
        raise ValueError("unreviewed disposable Hermes checkout")
    target = source / standalone_patch.TARGET
    helper = target.with_name("aira_transport.py")
    fixture = ("hermes_scheduler_fixture.py" if args.scheduler else "hermes_media_fixture.py" if args.media else
               "hermes_document_fixture.py" if args.documents else "hermes_typed_fixture.py")
    test = source / "tests/gateway" / ("test_aira_" + fixture)
    media_test = source / "tests/gateway/test_aira_normalized_media_boundary.py"
    original, existing = target.read_bytes(), helper.read_bytes()
    base = (ROOT / "deploy/gateway/standalone_adapter.py").read_bytes()
    typed = (ROOT / "deploy/gateway/standalone_typed_adapter.py").read_bytes()
    if (standalone_patch.classify_source(original) != "patched"
            or existing != hermes_versions.render_helper(base, version) or test.exists() or media_test.exists()):
        raise ValueError("disposable checkout is not the exact v1 fixture")
    lifecycle_target = lifecycle_original = None
    if args.scheduler:
        from deploy.gateway import standalone_scheduler_patch
        lifecycle_target = source / standalone_scheduler_patch.TARGET
        lifecycle_original = lifecycle_target.read_bytes()
        if standalone_scheduler_patch.classify_source(lifecycle_original) != "original":
            raise ValueError("disposable checkout is not the exact stock lifecycle")
    try:
        target.write_bytes(standalone_patch.select_protocol(original, 2))
        if args.scheduler:
            document = (ROOT / "deploy/gateway/standalone_document_adapter.py").read_bytes()
            media = (ROOT / "deploy/gateway/standalone_media_adapter.py").read_bytes()
            scheduler = (ROOT / "deploy/gateway/standalone_scheduler_adapter.py").read_bytes()
            helper.write_bytes(hermes_versions.render_scheduler_helper(base, document, media, scheduler, version))
            lifecycle_target.write_bytes(standalone_scheduler_patch.select_scheduler(lifecycle_original, True))
        elif args.media:
            document = (ROOT / "deploy/gateway/standalone_document_adapter.py").read_bytes()
            media = (ROOT / "deploy/gateway/standalone_media_adapter.py").read_bytes()
            helper.write_bytes(hermes_versions.render_media_helper(base, document, media, version))
        elif args.documents:
            document = (ROOT / "deploy/gateway/standalone_document_adapter.py").read_bytes()
            helper.write_bytes(hermes_versions.render_document_helper(base, document, version))
        else:
            helper.write_bytes(hermes_versions.render_typed_helper(base, typed, version))
        test.write_bytes((ROOT / "tests/install" / fixture).read_bytes())
        cases = [str(test.relative_to(source))]
        if not args.media and not args.scheduler:
            media_test.write_bytes((ROOT / "tests/install/hermes_capabilities_fixture.py").read_bytes())
            cases.append(str(media_test.relative_to(source)) + "::test_stock_media_boundaries_on_installed_route")
        return subprocess.run([str(source / ".venv/bin/python"), "-m", "pytest", "-q",
                               *cases], cwd=source, check=False).returncode
    finally:
        target.write_bytes(original)
        helper.write_bytes(existing)
        if lifecycle_target is not None:
            lifecycle_target.write_bytes(lifecycle_original)
        test.unlink(missing_ok=True)
        media_test.unlink(missing_ok=True)


if __name__ == "__main__":
    sys.exit(main())
