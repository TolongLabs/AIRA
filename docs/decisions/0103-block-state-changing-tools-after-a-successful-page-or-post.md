# ADR-0103: Block State-Changing Tools After a Successful Page or Post Read

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A successful page or post read blocks state-changing tools for the rest of the turn, except the tool named by a member’s
slash command.

## Rationale

Untrusted page content cannot direct a state change.

## Source

Migrated from row 103 of the Architecture table in the former `docs/DECISIONS.md`.
