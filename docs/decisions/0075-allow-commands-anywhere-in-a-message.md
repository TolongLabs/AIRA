# ADR-0075: Allow Commands Anywhere in a Message

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A command may stand anywhere in a message, up to the chat's `commands.maxPerMessage` (1 by default). Each named tool is
offered alone until called; one reply covers them all. This replaces one command at the start of a message.

## Rationale

The owner wants commands used like skill calls in an agent. Forcing each named tool keeps the slash a guarantee.

## Source

Migrated from row 75 of the Architecture table in the former `docs/DECISIONS.md`.
