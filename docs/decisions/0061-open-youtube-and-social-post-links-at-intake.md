# ADR-0061: Open YouTube and Social Post Links at Intake

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

At intake, the readers open one YouTube or social post link per turn. Gemini receives a YouTube link as a URL.

## Rationale

A link lookup returned only the YouTube video’s title. Gemini watched the same video from its URL in 5 s. The
readers had already been used in production.

## Source

Migrated from row 61 of the Architecture table in the former `docs/DECISIONS.md`.
