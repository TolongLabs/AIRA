# ADR-0190: Promote the Published Release Commit

- **Date:** 2026-11-26
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

Resolve the published release tag to its exact Git commit before waiting for the successful main CI and
re-tagging the existing image. Serialize promotion jobs without replacing pending jobs. Recheck the latest
release and tag before writing, and verify the version, minor and stable image digests. Allow a manual
`release` workflow dispatch on `main` to retry only the latest published non-prerelease version.

See the [deployment contract](../trd/deployment.md#ci).

## Rationale

A graph merge workflow can run release-please after a newer release pull request lands. The older workflow
creates the newer tag, but a promotion guard comparing against the triggering SHA skips it. The newer
workflow then sees an existing release and skips promotion too. Resolve by the published tag rather than
the triggering event, and allow the same verified promotion to be retried without changing a release tag,
rebuilding an image, or using a separate registry credential.
