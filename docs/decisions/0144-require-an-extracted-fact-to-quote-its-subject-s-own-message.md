# ADR-0144: Require an Extracted Fact to Quote Its Subject's Own Message

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

An extracted fact must quote one message written by the person it is about, and every number in it must be in that
message.

## Rationale

A quote check against the whole episode accepts AIRA's own words and another member's words, and lets a model invent a
number.

## Source

Migrated from row 22 of the Data table in the former `docs/DECISIONS.md`.
