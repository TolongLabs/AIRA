# ADR-0007: Make Every Tool Atomic

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Every tool is atomic: one action, one transaction, safe to repeat. Tools that bundled several actions are split.

## Rationale

The old tools reported failure after a save worked, forgot three facts at once, and hid several actions behind one name.

## Source

Migrated from row 7 of the Architecture table in the former `docs/DECISIONS.md`.
