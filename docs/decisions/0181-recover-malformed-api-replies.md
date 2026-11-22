# ADR-0181: Recover Malformed Replies Within the Turn Deadline

- **Date:** 2026-11-23
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Give the API runner a bounded answer-generation retry after its provider route returns an unusable continuation.
Reuse completed tool evidence and receipts. Apply exponential backoff within the existing turn and spend limits.
See [model fallback](../trd/models.md#fallback).

## Rationale

A model can reject the next request even after tools have returned useful results. A fresh answer-only request can
use those results. Restarting the entire turn could repeat a completed action. [Issue #349](https://github.com/TolongLabs/AIRA/issues/349)
records the failure sequence.
