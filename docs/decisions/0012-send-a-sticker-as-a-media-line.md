# ADR-0012: Send a Sticker as a `MEDIA:` Line

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A sticker is a `MEDIA:` line in the reply. One new gateway patch sends a `.webp` from a `stickers/` folder as a sticker.

## Rationale

The gateway sends files after the text, so order holds. The core's container cannot reach the host's bridge port without
host networking.

## Source

Migrated from row 12 of the Architecture table in the former `docs/DECISIONS.md`.
