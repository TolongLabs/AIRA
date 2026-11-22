# ADR-0030: Honour a Scheduled Tag Only in an Unmarked Request

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A scheduled tag is honoured only in an unmarked request, and names only a reminder id. A firing marks the reminder in
the same transaction that stores it.

## Rationale

A tag in a member's message made the turn scheduled and skipped the sender check. Using a firing up once keeps a retried
or repeated job from reminding twice.

## Source

Migrated from row 30 of the Architecture table in the former `docs/DECISIONS.md`.
