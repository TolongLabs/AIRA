# ADR-0160: Edit a Pack's `toolFooter` Through the Site

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Site](README.md#site)

## Decision

The site edits a data pack's `toolFooter` in its `card.yml`, validated, under the writer lock, with a `setting_change`
row of target `pack`.

## Rationale

The pack is the only persona source, and packs reload on every turn. An override row would be a second source.

## Source

Migrated from row 4 of the Site table in the former `docs/DECISIONS.md`.
