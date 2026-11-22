# ADR-0116: Promote LinkedIn to an Opt-In Apify Mirror

- **Date:** 2026-11-22
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Promote LinkedIn to an opt-in Apify mirror (`social.mirrors.linkedin` + `APIFY_API_TOKEN`) using
`apimaestro~linkedin-post-detail`, enable Bluesky/Threads video fetch, raise `ytDlpTimeoutMs` to 9,000 ms, and apply
mirror `read_and_group` to both groups and DMs.

## Rationale

Owner approved LinkedIn Apify (probed 4.64 s at $0.005/post), Bluesky/Threads video fetch, and unified group+DM
autofetch; dev2 Bilibili yt-dlp timed out at 4,500 ms.

## Source

Migrated from row 116 of the Architecture table in the former `docs/DECISIONS.md`.
