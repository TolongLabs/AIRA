# ADR-0077: Strip the Gateway Timestamp and Read Image Attachment Lines

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The core removes the gateway's leading timestamp before reading notes, and reads `[Image attached at: <path>]` lines as
images, one per inline image part. Quoted media is always watched.

## Rationale

Measured on dev2: a quoted video's note followed the timestamp on line 1 and was stored as text; a quoted image arrived
only as that line.

## Source

Migrated from row 77 of the Architecture table in the former `docs/DECISIONS.md`.
