# ADR-0064: Render the Research PDF From a Validated Findings Object With Typst

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The model fills one validated findings object; code renders the PDF from it with Typst and a format profile.

## Rationale

The owner wants the model to follow a mold and wants PDF formats configurable on the site later. Typst is one small
pinned binary, fast and deterministic, and prints fields as plain text.

## Source

Migrated from row 64 of the Architecture table in the former `docs/DECISIONS.md`.
