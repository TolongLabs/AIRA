# ADR-0025: Keep AIRA's Gateway Patches in `deploy/gateway/patches.py`

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

AIRA's gateway patches live in `deploy/gateway/patches.py`, run after the old core's reapply script. The older patches
stay in that script until the next re-pin.

## Rationale

Moving the whole 268 KB script would mean scrubbing it for a public repository. A small script of AIRA's own patches is
reviewable and changes nothing that works.

## Source

Migrated from row 25 of the Architecture table in the former `docs/DECISIONS.md`.
