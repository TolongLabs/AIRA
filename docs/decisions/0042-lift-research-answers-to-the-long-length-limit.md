# ADR-0042: Lift Research Answers to the Long Length Limit

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A research answer lifts the length to `long`, 1,400 characters, not to no limit. The research and command bypasses are
detected at clean time, from the turn's tool calls.

## Rationale

Measured: they never fired, because the prompt is built before any tool runs. Unlimited would let one search fill every
bubble.

## Source

Migrated from row 42 of the Architecture table in the former `docs/DECISIONS.md`.
