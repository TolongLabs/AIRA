# ADR-0072: Wake on a Name Only Through Per-Chat Names

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

WhatsApp wakes on a name only through the core's per-chat names; the global name patterns no longer wake it.

## Rationale

Measured: the gateway showed typing in a group with name call off, then sent nothing. The core already refused the turn
with no model call.

## Source

Migrated from row 72 of the Architecture table in the former `docs/DECISIONS.md`.
