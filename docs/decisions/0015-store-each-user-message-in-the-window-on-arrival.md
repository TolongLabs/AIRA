# ADR-0015: Store Each User Message in the Window on Arrival

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The core stores each user message in its window when the message arrives, and a turn claims the messages it answers.

## Rationale

The window is then the durable input of a turn: a restart, a merged batch or a message that arrives mid-turn loses no
text and answers nothing twice.

## Source

Migrated from row 15 of the Architecture table in the former `docs/DECISIONS.md`.
