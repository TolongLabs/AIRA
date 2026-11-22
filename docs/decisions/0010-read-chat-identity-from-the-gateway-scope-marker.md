# ADR-0010: Read Chat Identity From the Gateway Scope Marker

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The core reads chat, sender and message id from the gateway's scope marker. The scope stamp is switched on at cutover.

## Rationale

Measured: the gateway sends no id in any header. The marker is the only place the message id reaches the core.

## Source

Migrated from row 10 of the Architecture table in the former `docs/DECISIONS.md`.
