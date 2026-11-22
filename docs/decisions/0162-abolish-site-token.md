# ADR-0162: Abolish `SITE_TOKEN`

- **Date:** 2026-11-23
- **Status:** Accepted
- **Group:** [Site](README.md#site)

## Decision

Abolish `SITE_TOKEN` on the core's site API and frontend client; the core always starts the site server without bearer
authentication. This replaces the 2026-11-16 token requirement.

## Rationale

The site binds only to a private loopback or Tailscale address (`AIRA_SITE_BIND`), and write routes keep the literal
`Host` and `Origin` CSRF checks.

## Source

Migrated from row 6 of the Site table in the former `docs/DECISIONS.md`.
