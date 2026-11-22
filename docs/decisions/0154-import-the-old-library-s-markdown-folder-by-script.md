# ADR-0154: Import the Old Library's Markdown Folder by Script

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

The old library's Markdown folder is imported by a script: dry run by default, one transaction on `--apply`, existing
keys never overwritten, raw lyrics not imported.

## Rationale

The owner approved reading the old library on 17 Nov. Never overwriting keeps words filed since cutover; raw lyrics are
a cache, not study material.

## Source

Migrated from row 32 of the Data table in the former `docs/DECISIONS.md`.
