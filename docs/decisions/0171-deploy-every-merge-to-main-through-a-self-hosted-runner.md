# ADR-0171: Deploy Every Merge to `main` Through a Self-Hosted Runner

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)
- **Supersedes:** [ADR-0170](0170-build-one-container-image-per-tagged-release.md)

## Decision

Every merge to `main` builds an image and deploys it through a self-hosted runner on the host, as rokabot does. A
release re-tags the running image. This replaces the pull deploy on a timer.

## Rationale

The owner's choice. On a public repository the runner takes only the push-to-main deploy job, and outside workflows need
approval.

## Source

Migrated from row 9 of the Deployment table in the former `docs/DECISIONS.md`. The former log lists this row twice, here
and as [ADR-0164](0164-deploy-every-merge-to-main-through-a-self-hosted-runner.md), with identical text.
