# ADR-0094: Prefix the Newest Message With a Media Note

- **Date:** 2026-11-19
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

When block 4 holds media, the newest user message starts with a fixed note saying it came with the files or link that
block 4 describes.

## Rationale

Measured on dev2: an image captioned "Explain" got a reply about the previous link. Replayed on Haiku 5.5 with the
example pack: 4 of 4 off topic, and 4 of 4 on the image with the note.

## Source

Migrated from row 94 of the Architecture table in the former `docs/DECISIONS.md`.
