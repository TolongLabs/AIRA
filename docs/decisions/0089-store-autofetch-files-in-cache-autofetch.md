# ADR-0089: Store Autofetch Files in `cache/autofetch/`

- **Date:** 2026-11-18
- **Status:** Superseded by [ADR-0120](0120-give-autofetch-files-per-delivery-lifetimes.md)
- **Group:** [Architecture](README.md#architecture)

## Decision

Autofetch files go to `cache/autofetch/`, not `files/`.

## Rationale

They are other people's public media, kept only until sent. The disk guard trims the cache; the off-host copy leaves it
out.

## Source

Migrated from row 89 of the Architecture table in the former `docs/DECISIONS.md`.
