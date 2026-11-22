# ADR-0150: Share One Lessons Library Across Chats

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

The lessons library, songs and words are one store shared by every chat with lessons on. Only lyrics search results stay
in their chat. This replaces the per-chat model.

## Rationale

Measured: the old core kept one shared library, and its songs belong to no chat. The library is study material, not
memory about a member.

## Source

Migrated from row 28 of the Data table in the former `docs/DECISIONS.md`.
