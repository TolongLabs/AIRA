# ADR-0128: Keep a Verified Encrypted Off-Host Copy

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

A verified, encrypted copy of the data lives off the host, at most 15 minutes old, and a restore is rehearsed.

## Rationale

The host has lost its disks before. Copies on the same disk are lost with it.

## Source

Migrated from row 6 of the Data table in the former `docs/DECISIONS.md`.
