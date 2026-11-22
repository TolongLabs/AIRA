# ADR-0149: Set the Judge Model Through `judge.model`

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

The judge's model id is the key `judge.model`, empty by default. With no judge, memory admits nothing and `note` is
refused.

## Rationale

The thresholds are chosen against one model version, so the id must be explicit. A missing judge must fail closed.

## Source

Migrated from row 27 of the Data table in the former `docs/DECISIONS.md`.
