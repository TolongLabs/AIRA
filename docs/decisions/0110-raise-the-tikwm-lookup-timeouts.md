# ADR-0110: Raise the TikWM Lookup Timeouts

- **Date:** 2026-11-22
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

TikWM gets 10 s per lookup and a social lookup 12 s in all, up from 5.5 s and 6 s.

## Rationale

Measured: TikWM answered in 5.7 to 7.5 s from dev2 and a workstation, so every TikTok lookup timed out. Other readers
keep their own shorter limits.

## Source

Migrated from row 110 of the Architecture table in the former `docs/DECISIONS.md`.
