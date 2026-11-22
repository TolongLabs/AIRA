# ADR-0125: Split Settings Across the Database, `config.yml` and `.env`

- **Date:** 2026-11-15
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

Chat settings live in the database, in a three-level hierarchy. Deployment settings live in `config.yml`. Secrets live
in `.env`.

## Rationale

Settings need transactions, validation and a change record. Deployment values need review in git.

## Source

Migrated from row 3 of the Data table in the former `docs/DECISIONS.md`.
