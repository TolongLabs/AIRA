# ADR-0080: Name What Intake Read in the Footer

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The footer names what intake read, with its own kinds (`media_video` "watched a video" and others), and a link read at
intake is not opened again by a tool.

## Rationale

Measured: a YouTube watch timed out, the model read the page, and the footer showed the pack's page label; only tool
calls reached the footer.

## Source

Migrated from row 80 of the Architecture table in the former `docs/DECISIONS.md`.
