# ADR-0146: Make Forget Move the Memory Cursor and End Queued Jobs

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

Every forget is a barrier: it moves the chat's memory cursor to its newest message and ends the chat's queued memory
jobs.

## Rationale

Otherwise a fact a member asked to forget could be extracted again from messages that were waiting.

## Consequences

The cost is that other facts in those messages are not extracted.

## Source

Migrated from row 24 of the Data table in the former `docs/DECISIONS.md`.
