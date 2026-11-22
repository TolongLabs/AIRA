# ADR-0105: Limit Plain Page Reads to Five Guarded Redirects

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Plain page reads follow at most five guarded redirects.

## Rationale

A redirect target needs the same public-address checks as the first URL.

## Source

Migrated from row 105 of the Architecture table in the former `docs/DECISIONS.md`.
