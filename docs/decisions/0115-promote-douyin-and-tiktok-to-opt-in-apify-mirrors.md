# ADR-0115: Promote Douyin and TikTok to Opt-In Apify Mirrors

- **Date:** 2026-11-22
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Promote Douyin to an opt-in Apify mirror (`social.mirrors.douyin` + `APIFY_API_TOKEN`) using
`natanielsantos~douyin-scraper`, and add `gentle_cloud~tiktok-videos-watermark-free-scraper` as TikTok's Apify fallback
after TikWM.

## Rationale

Owner approved Apify for Douyin and TikTok. Live probes returned Douyin video in 7.9 s (7.4 MB MP4 downloaded in 4.1 s
on dev2) and watermark-free TikTok MP4 in 4.2 s at $0.0005/video.

## Source

Migrated from row 115 of the Architecture table in the former `docs/DECISIONS.md`.
