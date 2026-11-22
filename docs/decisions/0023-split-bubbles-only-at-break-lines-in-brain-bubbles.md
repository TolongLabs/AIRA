# ADR-0023: Split Bubbles Only at Break Lines in `brain.bubbles`

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

AIRA's `brain.bubbles` splits only at the core's break lines and reads no chat setting. An interrupt drops the unsent
bubbles, receipts included.

## Rationale

The core answers every chat after cutover and decides the bubbles. The old helper's receipt marks belonged to the old
core.

## Source

Migrated from row 23 of the Architecture table in the former `docs/DECISIONS.md`.
