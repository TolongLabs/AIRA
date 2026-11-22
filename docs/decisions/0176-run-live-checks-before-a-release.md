# ADR-0176: Run Live Checks Before a Release

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

Live checks run fixed tool and persona cases against real models before a release, as `bun run live`, and a failed case
blocks it.

## Rationale

The owner chose to build the Live layer before closing #32. Replay cannot show whether a real model calls a tool or
stays in role.

## Source

Migrated from row 14 of the Deployment table in the former `docs/DECISIONS.md`.
