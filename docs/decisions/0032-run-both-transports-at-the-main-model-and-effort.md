# ADR-0032: Run Both Transports at the Main Model and Effort

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Both transports run `llm.main.model` at `llm.main.effort`. `llm.subscription.model` is removed; the program gets
`--effort`, `medium` by default.

## Rationale

One model and one effort for the main role, whichever way it is reached. The owner chose `medium` for the wrapper.

## Source

Migrated from row 32 of the Architecture table in the former `docs/DECISIONS.md`.
