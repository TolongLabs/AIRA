# ADR-0098: Resolve Official Share Links Through Two Guarded Redirects

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Official share links resolve through at most two manual redirects on the same platform. The final address must parse as
an official post target.

## Rationale

Intake, tools and autofetch share one guarded lookup.

## Source

Migrated from row 98 of the Architecture table in the former `docs/DECISIONS.md`.
