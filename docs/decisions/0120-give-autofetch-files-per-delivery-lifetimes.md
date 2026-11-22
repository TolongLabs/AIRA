# ADR-0120: Give Autofetch Files Per-Delivery Lifetimes

- **Date:** 2026-11-22
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)
- **Supersedes:** [ADR-0089](0089-store-autofetch-files-in-cache-autofetch.md)

## Decision

Replace the 18 Nov disk-guard lifetime for `cache/autofetch/` with unique per-delivery files removed on completion,
ten-minute expiry and startup.

## Rationale

Identical files in separate deliveries must have independent lifetimes. No fetched bytes enter persistent copies.

## Source

Migrated from row 120 of the Architecture table in the former `docs/DECISIONS.md`.
