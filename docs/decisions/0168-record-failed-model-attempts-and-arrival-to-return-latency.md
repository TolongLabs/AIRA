# ADR-0168: Record Failed Model Attempts and Arrival-to-Return Latency

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

Record every failed model attempt and arrival-to-return latency, including queue, media and tool time; remove the
non-streaming first-byte contract.

## Rationale

Failed retries must remain explainable, and latency must include the wait before a turn opens. Spend write failures warn
and leave a storage failure record.

## Source

Migrated from row 6 of the Deployment table in the former `docs/DECISIONS.md`.
