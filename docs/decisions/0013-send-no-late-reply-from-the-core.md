# ADR-0013: Send No Late Reply From the Core

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The core sends no late reply. When it cannot be reached, the gateway sends the default pack's unavailable line through a
helper module AIRA ships.

## Rationale

Measured: the gateway retries the same request for 22 s to 50 s, then answers the chat itself. A late reply would come
out of order.

## Source

Migrated from row 13 of the Architecture table in the former `docs/DECISIONS.md`.
