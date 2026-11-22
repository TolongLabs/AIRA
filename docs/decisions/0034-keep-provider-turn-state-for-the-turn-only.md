# ADR-0034: Keep Provider Turn State for the Turn Only

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A provider's turn state, Claude's thinking blocks or `reasoning_content`, is kept for the turn and sent back within its
loop, never stored.

## Rationale

Claude refuses tool results without their thinking. The window holds text only, so the state cannot outlive the turn.

## Source

Migrated from row 34 of the Architecture table in the former `docs/DECISIONS.md`.
