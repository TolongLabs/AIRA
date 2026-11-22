# ADR-0063: Make `/research` an Explicit Background Job

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

`/research` is explicit only: a background job behind a direct command, never a tool the model is offered.

## Rationale

A research job costs up to ten times a search. Only a member's command may spend that; the model may suggest the command
in words.

## Source

Migrated from row 63 of the Architecture table in the former `docs/DECISIONS.md`.
