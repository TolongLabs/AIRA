# ADR-0173: Assign Every Issue

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

Every issue has an assignee, caught by `.github/workflows/assign-issues.yml` when an issue opens or reopens unassigned.

## Rationale

An owner on every issue keeps work from sitting unowned; whoever opens it still picks the right person, and the workflow
catches a miss.

## Source

Migrated from row 11 of the Deployment table in the former `docs/DECISIONS.md`. The former log lists this row twice,
here and as [ADR-0166](0166-assign-every-issue.md), with identical text.
