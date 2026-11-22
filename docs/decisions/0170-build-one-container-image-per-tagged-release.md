# ADR-0170: Build One Container Image per Tagged Release

- **Date:** 2026-11-15
- **Status:** Superseded by [ADR-0171](0171-deploy-every-merge-to-main-through-a-self-hosted-runner.md)
- **Group:** [Deployment](README.md#deployment)

## Decision

A tagged release builds one container image. The host pulls and deploys it on a timer.

## Rationale

Updates cannot be forgotten, and no outside system holds a key to the host.

## Source

Migrated from row 8 of the Deployment table in the former `docs/DECISIONS.md`. The former log lists this row twice, here
and as [ADR-0163](0163-build-one-container-image-per-tagged-release.md), with identical text.
