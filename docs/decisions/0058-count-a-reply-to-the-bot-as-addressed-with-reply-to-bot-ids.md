# ADR-0058: Count a Reply to the Bot as Addressed With `reply-to-bot-ids`

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A gateway patch, `reply-to-bot-ids`, makes a group reply to the bot count as addressed to it.

## Rationale

Measured after cutover: the bridge's bot ids keep a device suffix, so a reply never matched and the bot never answered
it. Mentions worked because their check compares the user part.

## Source

Migrated from row 58 of the Architecture table in the former `docs/DECISIONS.md`.
