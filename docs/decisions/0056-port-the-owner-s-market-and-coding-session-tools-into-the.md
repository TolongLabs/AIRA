# ADR-0056: Port the Owner's Market and Coding-Session Tools Into the Core

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The owner's 6 market and coding-session tools are ported into the core in TypeScript, gated by `features.owner`. Their
shared host files are mounted. Cutover waits for them.

## Rationale

The owner wants their source in this repository with the other tools. Mounting the files keeps the alerts timer and the
session relay working unchanged.

## Source

Migrated from row 56 of the Architecture table in the former `docs/DECISIONS.md`.
