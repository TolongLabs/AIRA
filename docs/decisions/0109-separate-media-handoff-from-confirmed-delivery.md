# ADR-0109: Separate Media Handoff From Confirmed Delivery

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A post media handoff is separate from adapter-confirmed delivery.

## Rationale

The core can verify a file or return a batch without knowing whether the gateway sent it. See
[Records](../trd/records.md#child-records).

## Source

Migrated from row 109 of the Architecture table in the former `docs/DECISIONS.md`.
