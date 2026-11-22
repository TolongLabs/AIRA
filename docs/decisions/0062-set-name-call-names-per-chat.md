# ADR-0062: Set Name-Call Names per Chat

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Each chat may set its own name-call names, `nameCall.names`, matched as whole words in any case. The core writes them
into `chats.json` for the gateway.

## Rationale

The owner wants the wake word to differ per chat, such as `Taiga` in one group. A per-chat file keeps the gateway's live
config unchanged.

## Source

Migrated from row 62 of the Architecture table in the former `docs/DECISIONS.md`.
