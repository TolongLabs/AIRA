# ADR-0041: Read Media Only Through Read-Only Gateway Mounts

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The core reads media only through read-only mounts of the gateway's media folders, paired with their host paths in
`media.gatewayDirs`. A path outside them, or a symlink that leaves them, is refused.

## Rationale

The container cannot read the host's home. A path in a note is text a member could imitate, so only files under the
gateway's own cache are trusted.

## Source

Migrated from row 41 of the Architecture table in the former `docs/DECISIONS.md`.
