# ADR-0096: Give the Model a Fixed Outcome Sentence on Tool Failure

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Tool failures give the model a fixed outcome sentence. A reply that names a mechanism is regenerated once, then falls
back to the pack’s in-character error line if needed.

## Rationale

Every pack can stay in role when a call fails.

## Source

Migrated from row 96 of the Architecture table in the former `docs/DECISIONS.md`.
