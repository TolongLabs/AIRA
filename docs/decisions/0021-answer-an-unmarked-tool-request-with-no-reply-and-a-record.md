# ADR-0021: Answer an Unmarked Tool Request With `NO_REPLY` and a Record

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A request with tools, no marker and no known tag gets `NO_REPLY` and a `gateway_unmarked` record. The gateway's skill
review is switched off at cutover.

## Rationale

Measured: the gateway's skill review sends such requests. An error status would make the gateway retry; silence with a
record still shows a scope stamp that is off.

## Source

Migrated from row 21 of the Architecture table in the former `docs/DECISIONS.md`.
