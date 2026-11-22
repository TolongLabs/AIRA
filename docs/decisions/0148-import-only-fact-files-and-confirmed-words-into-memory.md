# ADR-0148: Import Only Fact Files and Confirmed Words Into Memory

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

The memory readers read the per-chat fact files and the confirmed words. The knowledge database, saved posts and
transcripts are not imported.

## Rationale

Measured: the database is an index of the same files, and saved posts are not memory about a person. Importing them
would copy text no member asked to be remembered.

## Source

Migrated from row 26 of the Data table in the former `docs/DECISIONS.md`.
