# ADR-0055: Answer Name-Only Group Messages When Name Call Is On

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A group message that only names the character is answered when the chat's `nameCall` is on, off by default. The gateway
wakes on exact names in any case, never on typos.

## Rationale

The owner asked for a name call per chat. The gateway's name patterns cover every group, so the switch lives in the
core.

## Source

Migrated from row 55 of the Architecture table in the former `docs/DECISIONS.md`.
