# ADR-0151: Keep Meanings per Language

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

Meanings of lines, words and patterns are kept per language, and words keep their level, part of speech, forms and
example.

## Rationale

Measured: the old library holds an English and a Chinese meaning for most entries. One meaning column would drop half of
them.

## Source

Migrated from row 29 of the Data table in the former `docs/DECISIONS.md`.
