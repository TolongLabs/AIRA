# ADR-0130: Key `inbound_message` by Chat and Message ID

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

`inbound_message` is keyed by the chat and the gateway's message id, not by the message id alone.

## Rationale

A message id is unique only inside its chat. With the chat in the key, a repeated id can never return another chat's
stored reply.

## Source

Migrated from row 8 of the Data table in the former `docs/DECISIONS.md`.
