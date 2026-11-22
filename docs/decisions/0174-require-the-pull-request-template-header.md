# ADR-0174: Require the Pull Request Template Header

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

Every non-exempt pull request uses `.github/pull_request_template.md`, checked by `scripts/pr-header.ts` in
`.github/workflows/pr-header.yml`.

## Rationale

A header that tells a reviewer what to read, what was not tested and what a bad merge reaches, with one visual showing
the change.

## Source

Migrated from row 12 of the Deployment table in the former `docs/DECISIONS.md`. The former log lists this row twice,
here and as [ADR-0167](0167-require-the-pull-request-template-header.md), with identical text.
