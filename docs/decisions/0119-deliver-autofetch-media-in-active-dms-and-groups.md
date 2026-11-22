# ADR-0119: Deliver Autofetch Media in Active DMs and Groups

- **Date:** 2026-11-22
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)
- **Supersedes:** [ADR-0088](0088-move-autofetch-into-the-core.md)

## Decision

Replace the 18 Nov per-group autofetch decision with opt-in delivery in active DMs and groups. The DM adapter keeps its
normal reply and offers the message once to the existing batch sender.

## Rationale

Each native file has one ordered slot and one receipt. The same chat switches govern both surfaces.

## Source

Migrated from row 119 of the Architecture table in the former `docs/DECISIONS.md`.
