# ADR-0016: Return One Reply for a Merged Turn

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

One merged turn returns its reply for the newest message only. The other merged requests get `NO_REPLY`.

## Rationale

The gateway would send a reply once per request. One turn must send one reply.

## Source

Migrated from row 16 of the Architecture table in the former `docs/DECISIONS.md`.
