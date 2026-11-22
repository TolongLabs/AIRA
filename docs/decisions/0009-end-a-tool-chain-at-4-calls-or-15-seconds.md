# ADR-0009: End a Tool Chain at 4 Calls or 15 Seconds

- **Date:** 2026-11-16
- **Status:** Superseded by [ADR-0066](0066-set-the-tool-call-limit-per-chat-under-a-deployment-ceiling.md)
- **Group:** [Architecture](README.md#architecture)

## Decision

A tool chain ends at 4 calls or 15 seconds of tool time, whichever comes first.

## Rationale

The old system averaged about 3 calls on a tool turn. A count alone ignores that one slow call costs more than three
fast ones.

## Source

Migrated from row 9 of the Architecture table in the former `docs/DECISIONS.md`.
