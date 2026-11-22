# ADR-0085: Keep Every Photo of a Post

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A post keeps every photo, in order, up to 20, apart from its one picture. Intake watches the video and up to 4 photos at
once, the linked post's first, then the earlier posts of its Threads thread.

## Rationale

Measured: a post kept only its first image, so a 6-image post was read as one, and a shared reply lost its parent post,
which held the text and the images.

## Source

Migrated from row 85 of the Architecture table in the former `docs/DECISIONS.md`.
