# ADR-0084: Follow One Redirect for Threads Short Links

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A Threads short or share link is read by following its one redirect, whose `Location` must parse as a Threads post link.
Every other social redirect still fails.

## Rationale

Measured: `/share/<id>` answers 302 and `/t/<code>` 301 to `/@user/post/<code>`, and the reader refused both. Parsing
the target keeps a redirect from reaching another host.

## Source

Migrated from row 84 of the Architecture table in the former `docs/DECISIONS.md`.
