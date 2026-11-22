# ADR-0029: Run Gateway Jobs as One-Time Jobs

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Gateway jobs are one-time jobs named by reminder and due time. The core moves a repeating reminder to its next time when
it fires.

## Rationale

The gateway's repeat rules cannot say "monthly". One kind of job keeps the reconciler a comparison of names.

## Source

Migrated from row 29 of the Architecture table in the former `docs/DECISIONS.md`.
