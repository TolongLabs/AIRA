# ADR-0078: Drop Schema Limits for Claude and Enforce Them With zod

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The Claude client drops length and count limits from a structured-output schema; zod enforces them after parsing.
Research cuts an over-long list to its limit instead of failing.

## Rationale

Measured: every `/research` failed with HTTP 400, as Claude refuses `maxItems`, `minLength` and `minItems` above 1. A
cut list loses less than a failed job.

## Source

Migrated from row 78 of the Architecture table in the former `docs/DECISIONS.md`.
