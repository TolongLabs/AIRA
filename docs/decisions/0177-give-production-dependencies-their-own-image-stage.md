# ADR-0177: Give Production Dependencies Their Own Image Stage

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

Production dependencies get their own image stage keyed by the lockfile, and the pull has a 20-minute budget: 3 minutes
first, then the rest. Replaces three 3-minute tries.

## Rationale

Measured: every image carried a new 784 MB dependency layer and dev2 pulls at 1 to 2 MB/s, so no 3-minute attempt could
finish it (#224).

## Source

Migrated from row 15 of the Deployment table in the former `docs/DECISIONS.md`.
