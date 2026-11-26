# ADR-0048: Write the Tool Footer in Superscript With Source Domains

- **Date:** 2026-11-17
- **Status:** Superseded by [ADR-0051](0051-make-both-footer-lines-italic.md)
- **Group:** [Architecture](README.md#architecture)

## Decision

The tool footer writes its labels in Unicode superscript, adds a line of up to 3 source domains, and is a per-chat
setting with a per-chat emoji. This replaces the italic footer.

## Rationale

The owner wants the footer to read as small text. WhatsApp has no small text or link text, so superscript letters stand in, and
domains stay plain to stay tappable.

## Source

Migrated from row 48 of the Architecture table in the former `docs/DECISIONS.md`.
