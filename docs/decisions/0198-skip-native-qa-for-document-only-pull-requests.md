# ADR-0198: Skip Native QA for Document-Only Pull Requests

- **Date:** 2026-11-27
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

A pull request whose changed files all match `docs/`, `graphify-out/` or a `.md` suffix still builds and
verifies the native candidate image, but skips the synthetic install, rollback, refusal and Hermes pipeline
steps. A push to `main` always runs every step. The decision lives in an `image-scope` job whose output
gates those steps, not in `paths-ignore`, so no required check is left unrun.

## Rationale

The synthetic QA is the whole cost of the gate: the image build is 35 to 45 seconds, and the steps after it add
five to eight minutes per architecture, which bounded every pull request in the day's runs at 9 to 11 minutes.
That work cannot change for a document-only diff. `check` still typechecks, lints, formats and runs the full
unit, contract and replay suite; `image-platform` still builds the image and proves its architecture and pinned
binaries; `image` and `images-ok` still gate on the matrix.

A condition on the steps rather than `paths-ignore` on the trigger is deliberate. A workflow skipped by a path
filter reports no conclusion, and the ruleset's required checks then never turn green. Deploy only runs on a push
to `main`, where the full gate always runs, so the host never receives an image that skipped its QA.

See [CI](../trd/deployment.md#ci).

## Source

Owner asked why pull requests took about ten minutes, and chose a document-only path over leaving the gate
unchanged or moving the QA to `main` only.
