# ADR-0086: Read Instagram Posts From Page Data Before yt-dlp

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

An Instagram post is read from its logged-out page data first, and through yt-dlp only when the page holds no post.

## Rationale

Measured: yt-dlp refuses every Instagram photo post ("There is no video in this post"). The page carries the post, its
carousel and its reel video in the Meta shape the Threads reader already parses.

## Source

Migrated from row 86 of the Architecture table in the former `docs/DECISIONS.md`.
