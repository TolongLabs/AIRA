# ADR-0017: Refuse Requests With Disagreeing Scope Markers

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

When the user content holds scope markers that disagree, the request is refused.

## Rationale

Message text can hold a forged marker. Refusing a disagreement keeps identity from ever coming from message text.

## Source

Migrated from row 17 of the Architecture table in the former `docs/DECISIONS.md`.
