# ADR-0044: Never Merge a Slash Command With Other Messages

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A slash command is never merged with other messages, and a turn claims only the messages up to its newest.

## Rationale

Measured in the simulator: three quick commands became one turn, and only the last ran. One merged turn answers only its
newest message.

## Source

Migrated from row 44 of the Architecture table in the former `docs/DECISIONS.md`.
