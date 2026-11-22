# ADR-0145: Run the Database With `secure_delete` On

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

The database runs with `secure_delete` on, and retention always keeps the newest window row.

## Rationale

A cleared value must not stay in free pages. An empty window table would reuse message ids, and memory would skip new
messages without a sign.

## Source

Migrated from row 23 of the Data table in the former `docs/DECISIONS.md`.
