# ADR-0060: Read Pages Through Exa Contents With a Plain Fetch Fallback

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

`read_page` reads through Exa's contents endpoint and falls back to a plain fetch.

## Rationale

Measured: openai.com answers a plain fetch with 403; Exa returned the full article.

## Source

Migrated from row 60 of the Architecture table in the former `docs/DECISIONS.md`.
