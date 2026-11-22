# ADR-0074: Remove the Scope Marker From Tagged Gateway Jobs

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Tagging a gateway job removes the chat scope marker from its text. Rollback restores the job file from the cutover
backup.

## Rationale

Measured after cutover: all 6 jobs kept their chat's marker, so the core took them as members' messages and refused
them; the train check failed at 07:00.

## Source

Migrated from row 74 of the Architecture table in the former `docs/DECISIONS.md`.
