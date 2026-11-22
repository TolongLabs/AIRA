# ADR-0159: Serve the Built Site Under `/app/` on the Site API Port

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Site](README.md#site)

## Decision

The core serves the built site under `/app/` on the site API's port. The browser keeps the token in local storage and
sends it as a bearer header, as the existing site does.

## Rationale

One origin needs no cross-origin rules. A header the page sets cannot be forged by another site, so no cookie or session
store is needed.

## Source

Migrated from row 3 of the Site table in the former `docs/DECISIONS.md`.
