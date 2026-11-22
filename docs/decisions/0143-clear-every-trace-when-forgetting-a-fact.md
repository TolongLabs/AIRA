# ADR-0143: Clear Every Trace When Forgetting a Fact

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

Forgetting a fact also clears its older versions, its key, the episode summary of the same job, and the text of the
message that supported it.

## Rationale

Each of those can show the forgotten fact again. Replies, snapshots and the off-host copy keep it for their stated
retention only.

## Source

Migrated from row 21 of the Data table in the former `docs/DECISIONS.md`.
