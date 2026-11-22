# ADR-0081: Watch YouTube Links in Parallel Segments

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A YouTube link is watched in parallel segments (60 s, then 180 s, at most 4) at 1 frame per 4 s, under one 12 s budget;
code merges what answers.

## Rationale

Measured: one call over a long video ran the 30 s media timeout and failed; a 3-minute span takes 5 s. The owner accepts
partial readings.

## Source

Migrated from row 81 of the Architecture table in the former `docs/DECISIONS.md`.
