# ADR-0121: Extend Native Attachments to Verified Non-YouTube Video

- **Date:** 2026-11-22
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)
- **Extends:** [ADR-0108](0108-require-verified-native-attachments-for-group-autofetch.md)

## Decision

Extend the 21 Nov native attachment decision to video on verified non-YouTube platforms. Use an inclusive 180-second
limit, ffprobe for missing duration and one bounded compression attempt.

## Rationale

Native identity, type and a measured duration establish eligibility. Keep YouTube excluded and require live proof on
both hosts before enabling an operation.

## Source

Migrated from row 121 of the Architecture table in the former `docs/DECISIONS.md`.
