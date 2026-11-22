# ADR-0067: Replace `make_report` With `/doc`

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

`make_report` becomes `/doc` and writes Markdown or PDF: the format named in the message, else the chat's
`report.defaultFormat` (PDF). The model fills a `NoteDocument` and code renders it.

## Rationale

The owner wants the member to choose the format, the model to follow a mold, and one renderer shared with `/research`.
`/report` is kept for the feedback form.

## Source

Migrated from row 67 of the Architecture table in the former `docs/DECISIONS.md`.
