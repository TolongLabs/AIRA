# ADR-0179: Bound Search Briefs for Typed Fields

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Search Depth](README.md#search-depth)

## Decision

Typed fields get a bounded search brief with cited passages and a list of missing fields. A missing field can trigger
one local-language search and guarded page reads.

## Rationale

Menus, prices and hours often need more than the first snippet. A fixed call budget and response deadline preserve time
for the reply.

## Source

Migrated from row 1 of the Search Depth table in the former `docs/DECISIONS.md`.
