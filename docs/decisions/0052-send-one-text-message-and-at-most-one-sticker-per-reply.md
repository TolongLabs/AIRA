# ADR-0052: Send One Text Message and at Most One Sticker per Reply

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A reply is one text message and at most one sticker: `format.maxBubbles` is 1, `format.bubbleMaxChars` 3,800.

## Rationale

Members of the old bot complained about several messages per reply. 3,800 leaves the footer room under WhatsApp's 4,096.

## Source

Migrated from row 52 of the Architecture table in the former `docs/DECISIONS.md`.
