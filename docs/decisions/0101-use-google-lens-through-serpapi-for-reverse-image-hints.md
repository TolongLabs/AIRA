# ADR-0101: Use Google Lens Through SerpApi for Reverse-Image Hints

- **Date:** 2026-11-21
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Reverse-image hints use Google Lens through SerpApi, with local images looked up by the uploaded image id. A member’s
photo leaves the host only when the tool runs in a chat with the switch on.

## Rationale

A reverse lookup can inform a product identification, with a separate listing required for confirmation.

## Source

Migrated from row 101 of the Architecture table in the former `docs/DECISIONS.md`.
