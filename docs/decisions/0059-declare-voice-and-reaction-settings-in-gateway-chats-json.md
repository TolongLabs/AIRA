# ADR-0059: Declare Voice and Reaction Settings in `gateway/chats.json`

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The core declares each chat's voice and reaction settings in `gateway/chats.json`; the gateway reads it when it changes.

## Rationale

The gateway owns voice notes and reactions, but the site edits the core's settings. A declared file needs no network or
token, like the schedule file.

## Source

Migrated from row 59 of the Architecture table in the former `docs/DECISIONS.md`.
