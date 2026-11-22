# ADR-0050: Offer Short Source Links From a Cloudflare Worker

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Footer sources can use plain short links from a Cloudflare Worker once `links.baseUrl` is set (#242). Failed or late
requests show domains alone.

## Rationale

WhatsApp makes plain short URLs clickable. The domain-only footer keeps its italic style while short links are disabled.

## Source

Migrated from row 50 of the Architecture table in the former `docs/DECISIONS.md`.
