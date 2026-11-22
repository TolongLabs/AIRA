# ADR-0033: Choose the Launch Models for Main and Fallback

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Launch models: `claude-haiku-5-5` at `medium` effort for `main`, and `deepseek-ai/DeepSeek-V4.1-Flash-1017` on
ModelScope at `high` for `fallback`, until the benchmark in #28.

## Rationale

The owner's choice. The fallback is near Haiku 5.5 on published indexes (59.4 against 57.2), with a 1M context, at about
one ModelScope credit per call.

## Source

Migrated from row 33 of the Architecture table in the former `docs/DECISIONS.md`.
