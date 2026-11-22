# ADR-0011: Let the Core Decide Reply Bubbles With Break Lines

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The core decides reply bubbles and marks them with a break line. The gateway's bubble patch delivers them, through a
helper module AIRA ships.

## Rationale

The patch already sends bubbles in order with typing pauses. The old helper decided by the old core's bindings.

## Source

Migrated from row 11 of the Architecture table in the former `docs/DECISIONS.md`.
