# ADR-0039: Write Direct Command Answers in Plain Words

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Code writes the answer of a direct command in plain words until packs carry templates for it.

## Rationale

The pack contract has no template for a command answer. A plain list is better than no `/help`, and it holds no persona
text.

## Source

Migrated from row 39 of the Architecture table in the former `docs/DECISIONS.md`.
