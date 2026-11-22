# ADR-0071: Let the Gateway Alone Decide Which Group Messages Are Addressed

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The gateway alone decides which group messages are addressed; the core answers every group message it receives. This
replaces the core's name-call check.

## Rationale

Measured: the gateway removes the bot's own mention from the text, so the core refused real @mentions as name calls.
With per-chat names in the gateway, the core check had nothing left to catch.

## Source

Migrated from row 71 of the Architecture table in the former `docs/DECISIONS.md`.
