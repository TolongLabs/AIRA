# ADR-0186: Select Owner Authority by Installation Mode

- **Date:** 2026-11-25
- **Status:** Accepted
- **Group:** [Site](README.md#site)

## Decision

Persist an explicit installation mode: standalone uses a per-install owner credential and private typed
model settings, while legacy keeps its existing Hermes owner authority. Never fall back between authorities.

## Rationale

A clean dashboard needs to boot without model keys or the legacy host owner service. Automatic fallback
during an outage would change the authentication boundary and could lock out the real owner or authorize
the wrong credential. Keep Host and Origin checks and the protected core routes. See the
[standalone owner authentication contract](../trd/site.md#standalone-owner-authentication).

## Source

[Portable onboarding milestone](https://github.com/TolongLabs/AIRA/issues/393).
