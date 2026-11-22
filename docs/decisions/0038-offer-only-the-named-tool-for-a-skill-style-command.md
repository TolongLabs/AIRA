# ADR-0038: Offer Only the Named Tool for a Skill-Style Command

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

For a skill-style command, the named tool is the only tool offered until it has been called.

## Rationale

The command decides the tool. Offering nothing else makes that a property of the request, not a hope about the model.

## Source

Migrated from row 38 of the Architecture table in the former `docs/DECISIONS.md`.
