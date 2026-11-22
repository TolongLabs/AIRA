# ADR-0026: Remove the Reply-Prefix Test Edit and Defer `aira-trace` Removal to Cutover

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The unregistered reply-prefix test edit is removed and the upstream test restored. `aira-trace` is removed at cutover,
not before.

## Rationale

Measured: no gateway code writes the quote order the edit expects, and it fails. Removing the trace on live needs a
bridge restart, which cutover does anyway.

## Source

Migrated from row 26 of the Architecture table in the former `docs/DECISIONS.md`.
