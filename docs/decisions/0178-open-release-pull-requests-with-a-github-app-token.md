# ADR-0178: Open Release Pull Requests With a GitHub App Token

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

Release pull requests are opened with a TolongLabs GitHub App token, and the ruleset needs no approval for bot commits.

## Rationale

Measured on #216: GITHUB_TOKEN started no checks, then GitHub did not count them until a user pushed (#228).

## Source

Migrated from row 16 of the Deployment table in the former `docs/DECISIONS.md`.
