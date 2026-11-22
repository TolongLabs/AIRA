# ADR-0031: Reach Claude Through the Native Messages API

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The main role reaches Claude through its native Messages API. `openai-compatible` stays a provider for both roles.

## Rationale

Measured: Claude's OpenAI-compatible layer ignores effort, even an invalid value, and has no prompt caching.

## Source

Migrated from row 31 of the Architecture table in the former `docs/DECISIONS.md`.
