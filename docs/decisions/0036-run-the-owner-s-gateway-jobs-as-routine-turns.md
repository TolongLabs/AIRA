# ADR-0036: Run the Owner's Gateway Jobs as Routine Turns

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The core runs the owner's gateway jobs: a job listed in the host's `gateway.jobs` and tagged in its text runs as a
`routine` turn in its chat.

## Rationale

Measured: 5 recurring jobs call the model. Without this they would get `NO_REPLY` after cutover. One loop and one voice
run them.

## Source

Migrated from row 36 of the Architecture table in the former `docs/DECISIONS.md`.
