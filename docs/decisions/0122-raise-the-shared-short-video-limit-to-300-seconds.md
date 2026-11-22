# ADR-0122: Raise the Shared Short-Video Limit to 300 Seconds

- **Date:** 2026-11-22
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Raise the shared short-video limit to 300 seconds. Keep the 48 MB input cap, 16 MB delivery cap, full-duration check and
one bounded transcode.

## Rationale

Longer clips may qualify when their bytes fit. An oversized or incomplete result is discarded.

## Source

Migrated from row 122 of the Architecture table in the former `docs/DECISIONS.md`.
