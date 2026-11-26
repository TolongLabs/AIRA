# ADR-0192: Publish Only Natively Verified Image Manifests

- **Date:** 2026-11-26
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

Build and smoke-test the Linux amd64 and arm64 images on their native architectures. The main CI publishes a
child only after the local image passes. A single aggregation gate validates the two child proofs for the exact
commit and publishes their index. The release job re-tags that same index after CI passes; historical images
retain their original manifests. Keep `image` and `images-ok` as the required checks.

The native host and Docker daemon must agree. Setup and update refuse a non-native image without starting or
stopping the service. This decision does not extend support to rootless or remote Docker, Docker Desktop, or
other operating systems. Public support claims require actual acceptance evidence.

See the [deployment contract](../trd/deployment.md#release-image).

## Rationale

The existing Dockerfile has architecture-specific pinned binaries. Building or emulating a second platform is
not proof that its native install, ownership, activation, backup, update or rollback works. Checking both native
images before assembly also prevents a partially tested variant from reaching a common release tag.

## Source

[Standalone compatibility expansion](https://github.com/TolongLabs/AIRA/issues/402).
