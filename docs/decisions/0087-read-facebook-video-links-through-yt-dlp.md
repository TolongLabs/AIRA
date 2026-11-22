# ADR-0087: Read Facebook Video Links Through yt-dlp

- **Date:** 2026-11-18
- **Status:** Accepted, partly superseded by [ADR-0091](0091-read-facebook-post-links-from-the-logged-out-page.md)
- **Group:** [Architecture](README.md#architecture)

## Decision

Facebook video links are read through yt-dlp. Facebook post links stay with `read_page`.

## Rationale

Measured on dev2: yt-dlp read a public share video and a watch link, and has no reader for photo posts. The old
autofetch sent 15 Facebook links since 5 Nov.

## Source

Migrated from row 87 of the Architecture table in the former `docs/DECISIONS.md`.
