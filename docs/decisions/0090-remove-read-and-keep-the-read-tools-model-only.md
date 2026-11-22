# ADR-0090: Remove `/read` and Keep the Read Tools Model-Only

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

`/read` is removed. `read_post` and `read_page` stay as tools only the model calls.

## Rationale

The owner's call: a post link in a message is read at intake with its media watched, which `/read` turned off.

## Source

Migrated from row 90 of the Architecture table in the former `docs/DECISIONS.md`.
