# ADR-0182: Enforce Site Binding, Footer, and Cron Guards

- **Date:** 2026-11-23
- **Status:** Accepted
- **Group:** [Site](README.md#site)

## Decision

Enforce character-binding checks (`400 missing_character`) on chat activation and chat-level character clears, restore
`card.yml` atomically via `writeFileAtomic` inside `storage.tx` on footer commit or reload failure, and keep read-only
access settings and core-managed `aira:` cron jobs non-editable in the owner site.

## Rationale

Stops chat-level UI edits from leaving active chats unbound (`binding_invalid`), keeps pack files and `setting_change`
rows consistent across commit errors, and prevents accidental override deletion or reconciler overwrites (#339, #340,
[`docs/trd/site.md`](../trd/site.md#write-routes)).

## Source

Added with PR #340.
