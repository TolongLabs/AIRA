# ADR-0053: Draw Faces From Face Groups With Guarded Characters

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Faces come from face groups, 4 offered fresh per reply, and code guards their markdown characters with full-width forms.
Roleplay beats are drawn by code at per-mood odds.

## Rationale

Ported from rokabot: a short fixed list made faces repeat, and beats left to the prompt were rare. WhatsApp has no
escape character, so a lookalike is the only guard.

## Source

Migrated from row 53 of the Architecture table in the former `docs/DECISIONS.md`.
