# ADR-0068: Switch Memory per Chat

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

`features.memory` switches memory per chat, on by default. Off: nothing extracted, nothing recalled, `note` refused;
stored facts are kept but unused, and `/forget` still works.

## Rationale

Members worry that AIRA remembers every chat. Keeping facts while off means a mistaken click loses nothing; `/forget`
stays the way to remove one.

## Source

Migrated from row 68 of the Architecture table in the former `docs/DECISIONS.md`.
