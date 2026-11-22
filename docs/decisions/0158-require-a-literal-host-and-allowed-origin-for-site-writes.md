# ADR-0158: Require a Literal Host and Allowed Origin for Site Writes

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Site](README.md#site)

## Decision

A site write needs a literal `Host` (an IP address or localhost) and, when it carries `Origin`, one listed in
`site.allowedOrigins`. The first write is the chat's on and off switch.

## Rationale

The token alone does not stop a page that rebinds its name to the private address. Switching a chat on was the one step
no route could do.

## Source

Migrated from row 2 of the Site table in the former `docs/DECISIONS.md`.
