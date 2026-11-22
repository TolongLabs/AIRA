# ADR-0106: Keep Cookies per Host for One Page Lookup

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A plain page read keeps cookie names and values per host for that lookup only.

## Rationale

A same-host cookie redirect can complete without carrying cookies across hosts or turns.

## Source

Migrated from row 106 of the Architecture table in the former `docs/DECISIONS.md`.
