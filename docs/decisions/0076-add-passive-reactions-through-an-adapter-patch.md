# ADR-0076: Add Passive Reactions Through an Adapter Patch

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Passive reactions reach unaddressed group messages through the `passive-reactions` adapter patch, each message gets at
most one reaction, and the odds are a per-chat `reactions.chance` setting (default 33%).

## Rationale

Before this, reactions ran only on messages forwarded to the core, so unaddressed group messages never got one;
deduplicating by message id lets both paths try safely and a per-chat setting avoids a single global rate.

## Source

Migrated from row 76 of the Architecture table in the former `docs/DECISIONS.md`.
