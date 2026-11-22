# ADR-0061: Open YouTube and Social Post Links at Intake

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

YouTube links and social post links are opened at intake, one per turn, through readers ported from rokabot; YouTube
goes to Gemini as a URL.

## Rationale

Measured: a YouTube link got only its title. Gemini watched the same video from its URL in 5 s; rokabot's readers are
proven in production.

## Source

Migrated from row 61 of the Architecture table in the former `docs/DECISIONS.md`.
