# ADR-0188: Use a Fail-Closed Standalone Hermes Adapter

- **Date:** 2026-11-25
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Keep the existing patched legacy Hermes route. For standalone, pin the public Hermes source and use a
minimal profile-scoped post-admission adapter with a separate gateway credential and structured identity.
Never fall through to the ordinary Hermes model on failure of an attached route.

## Rationale

The v0.23.4 post-admission hook carries normalized sender, chat and message identity and can consume
the gateway's turn, but its public callback deliberately fails open. A bare provider configuration
cannot establish trusted identity. Disposable upstream tests proved consumption, profile scope,
no-reply and the original fail-open path; the selective insertion and local fake endpoint then
proved no fallback for an attached profile. See the [standalone transport contract](../trd/system.md#standalone-hermes-transport).
The candidate still requires end-to-end core and attach verification before advertising compatibility.

## Source

[Portable onboarding milestone](https://github.com/TolongLabs/AIRA/issues/397).
