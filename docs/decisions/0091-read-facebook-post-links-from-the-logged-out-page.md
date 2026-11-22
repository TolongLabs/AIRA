# ADR-0091: Read Facebook Post Links From the Logged-Out Page

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)
- **Supersedes:** [ADR-0087](0087-read-facebook-video-links-through-yt-dlp.md)

## Decision

A Facebook post link is read from its logged-out page: text, author and every photo. Replaces the row leaving it to
`read_page`.

## Rationale

Measured: a public group photo post's page carries its text and both photos at 2048 px, from dev2 too; yt-dlp reads
videos only.

## Source

Migrated from row 91 of the Architecture table in the former `docs/DECISIONS.md`.
