# ADR-0169: Append Operator Alerts to `alerts.jsonl`

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

Operator alerts append kind and time to `alerts.jsonl` on the data volume and write a failure row.

## Rationale

A durable local delivery path works without a configured owner chat and keeps message text out of alerts.

## Source

Migrated from row 7 of the Deployment table in the former `docs/DECISIONS.md`.
