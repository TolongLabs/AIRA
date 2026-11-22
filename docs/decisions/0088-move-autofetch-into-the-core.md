# ADR-0088: Move Autofetch Into the Core

- **Date:** 2026-11-18
- **Status:** Superseded by [ADR-0119](0119-deliver-autofetch-media-in-active-dms-and-groups.md)
- **Group:** [Architecture](README.md#architecture)

## Decision

Autofetch moves into the core: the kept hook loads `brain.autofetch`, which asks `POST /v1/aira/autofetch` for a post's
media and sends it. `features.autofetch`, per group, is off by default. Replaces the row removing it.

## Rationale

The owner wants it. The old plugin sent a Threads avatar and one image of six; the core's readers see every photo and
never take an avatar.

## Source

Migrated from row 88 of the Architecture table in the former `docs/DECISIONS.md`.
