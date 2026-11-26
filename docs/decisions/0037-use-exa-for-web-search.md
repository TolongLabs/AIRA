# ADR-0037: Use Exa for Web Search

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Web search uses one Exa search call with highlights. `search.provider: exa`, key `EXA_API_KEY`.

## Rationale

The owner chose Exa. Its free tier covers the volume, and the key already exists on the host.

## Source

Migrated from row 37 of the Architecture table in the former `docs/DECISIONS.md`.
