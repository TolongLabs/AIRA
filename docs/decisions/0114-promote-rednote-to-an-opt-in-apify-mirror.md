# ADR-0114: Promote Rednote to an Opt-In Apify Mirror

- **Date:** 2026-11-22
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)
- **Supersedes:** [ADR-0113](0113-recognise-xiaohongshu-and-rednote-links-at-t0.md) when the mirror is enabled

## Decision

Promote Rednote (Xiaohongshu) to an opt-in Apify mirror (`social.mirrors.rednote` + `APIFY_API_TOKEN`) using
`socialdatax~socialdatax-xhs-data-api`. Replaces the T0-only row when enabled.

## Rationale

Owner approved Apify. Live probes returned identity-bound image and video notes in 3.7 to 6.2 s, and both hosts
downloaded `*.xhscdn.com` PNG and MP4 in under 600 ms.

## Source

Migrated from row 114 of the Architecture table in the former `docs/DECISIONS.md`.
