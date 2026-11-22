# ADR-0066: Set the Tool-Call Limit per Chat Under a Deployment Ceiling

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)
- **Supersedes:** [ADR-0009](0009-end-a-tool-chain-at-4-calls-or-15-seconds.md)

## Decision

A turn's tool-call limit is the chat's `tools.maxPerMessage` setting (default 3, at least N for N commands), under a
deployment ceiling of 8 (`tools.maxCallsPerTurn`). This replaces the fixed 4 calls.

## Rationale

The owner wants the call limit set per chat like `commands.maxPerMessage`, bounded by one deployment ceiling.

## Source

Migrated from row 66 of the Architecture table in the former `docs/DECISIONS.md`.
