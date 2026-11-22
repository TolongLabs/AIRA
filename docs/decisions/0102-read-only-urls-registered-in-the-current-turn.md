# ADR-0102: Read Only URLs Registered in the Current Turn

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Page and post reads use only URLs registered in the current turn, by URL or source id.

## Rationale

A page cannot introduce a new destination for a later read.

## Source

Migrated from row 102 of the Architecture table in the former `docs/DECISIONS.md`.
