# ADR-0003: Attach the Core Through an OpenAI-Compatible Endpoint on Port 9881

- **Date:** 2026-11-15
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The core attaches at the seam that exists today: an OpenAI-compatible endpoint on `127.0.0.1:9881` that Hermes calls as
a custom model provider.

## Rationale

Cutover and rollback are one address change. No new Hermes patch is needed to attach.

## Source

Migrated from row 3 of the Architecture table in the former `docs/DECISIONS.md`.
