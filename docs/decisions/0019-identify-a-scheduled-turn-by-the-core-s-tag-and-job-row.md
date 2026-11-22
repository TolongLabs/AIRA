# ADR-0019: Identify a Scheduled Turn by the Core's Tag and Job Row

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A scheduled turn is a request with tools, no scope marker and the core's tag after the gateway's cron block. Its chat
comes from the core's job row.

## Rationale

Measured: the gateway's schedule sends no marker and puts its own block before the job's text. A tag in text is not
identity; the job row is.

## Source

Migrated from row 19 of the Architecture table in the former `docs/DECISIONS.md`.
