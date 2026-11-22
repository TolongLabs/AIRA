# ADR-0095: Tell the Model to Speak of Media as Its Own Experience

- **Date:** 2026-11-19
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The media intro tells the model to speak of files and links as things it saw or heard itself, not to mention the
description. It no longer says the model cannot open them.

## Rationale

Measured: with "You cannot open them", Haiku 5.5 told members "I can't open the image, only a short description", which
breaks the role. Replayed with the new line: 4 of 4 stayed in role.

## Source

Migrated from row 95 of the Architecture table in the former `docs/DECISIONS.md`.
