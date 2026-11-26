# ADR-0164: Deploy Every Merge to `main` Through a Self-Hosted Runner

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)
- **Supersedes:** [ADR-0163](0163-build-one-container-image-per-tagged-release.md)

## Decision

Every merge to `main` builds an image and deploys it through a self-hosted runner on the host. A release re-tags the
running image. This replaces the pull deploy on a timer.

## Rationale

The owner's choice. On a public repository the runner takes only the push-to-main deploy job, and outside workflows need
approval.

## Source

Migrated from row 2 of the Deployment table in the former `docs/DECISIONS.md`. The former log lists this row twice, here
and as [ADR-0171](0171-deploy-every-merge-to-main-through-a-self-hosted-runner.md), with identical text.
