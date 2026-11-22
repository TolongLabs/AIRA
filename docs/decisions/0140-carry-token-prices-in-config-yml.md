# ADR-0140: Carry Token Prices in `config.yml`

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

`main` and `fallback` carry token prices in `config.yml`, used when the provider reports no cost.

## Rationale

Without a price or a reported cost, the spend cap could never be reached.

## Source

Migrated from row 18 of the Data table in the former `docs/DECISIONS.md`.
