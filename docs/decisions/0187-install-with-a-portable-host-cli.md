# ADR-0187: Install with a Portable Host CLI

- **Date:** 2026-11-25
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

Use a standard-library Python host CLI and a prebuilt Compose image. Keep the one-directory install,
the shared deployment lock and the CI-managed legacy installation. New installs use explicit stable updates.

## Rationale

A shell, developer toolchain or manually populated model key must not be required to discover and sign in
to the dashboard. The CLI owns host actions, actual port discovery and recovery; the core owns private
application state. No Docker socket or general host command authority enters the web application.
See the [standalone CLI contract](../trd/deployment.md#standalone-cli).

## Source

[Portable onboarding milestone](https://github.com/TolongLabs/AIRA/issues/393).
