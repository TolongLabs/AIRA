# ADR-0040: Show the Model the Candidate Rows Before Cancel and Forget

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Before `/cancel` and `/forget`, code shows the model the rows it may choose from.

## Rationale

A removal must name exactly one row by id. The model cannot name an id it has not seen.

## Source

Migrated from row 40 of the Architecture table in the former `docs/DECISIONS.md`.
