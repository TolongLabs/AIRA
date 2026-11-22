# ADR-0022: Take Quote and Media Notes Out of the Message Text

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Quote and media notes before a marker are taken out of the message text and kept as the message's quote and attachments.

## Rationale

Measured: the gateway writes them in the user text. Read as text, a quote was taken for an earlier unanswered message.

## Source

Migrated from row 22 of the Architecture table in the former `docs/DECISIONS.md`.
