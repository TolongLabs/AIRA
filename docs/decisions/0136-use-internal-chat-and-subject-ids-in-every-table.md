# ADR-0136: Use Internal Chat and Subject IDs in Every Table

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

Every table uses an internal chat id and subject id. Only `chat` and `identity` hold a WhatsApp id.

## Rationale

Record tables must not hold WhatsApp ids. One mapping at the door keeps them out of every other table and log.

## Source

Migrated from row 14 of the Data table in the former `docs/DECISIONS.md`.
