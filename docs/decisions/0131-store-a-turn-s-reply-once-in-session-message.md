# ADR-0131: Store a Turn's Reply Once in `session_message`

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

A turn's reply is stored once, as its assistant row in `session_message`. A repeated request reads it from there.

## Rationale

Verbatim text may live in two tables only. A copy on `inbound_message` or `turn` would be a third.

## Source

Migrated from row 9 of the Data table in the former `docs/DECISIONS.md`.
