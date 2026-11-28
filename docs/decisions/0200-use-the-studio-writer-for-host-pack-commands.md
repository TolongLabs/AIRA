# ADR-0200: Use the Studio Writer for Host Pack Commands

- **Date:** 2026-11-28
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The installed host CLI sends pack operations to the running core's protected Studio routes using the existing
owner token. The core shares startup validation and its configured prompt ceiling with JSON draft validation.
Preview uses an isolated scripted model by default; explicit live mode uses the configured model with no delivery.

## Rationale

A second filesystem writer would bypass revision checks, recovery and the audit receipt. The existing owner
credential already grants Studio access, so the host CLI needs no new credential or public write endpoint.
A scripted preview avoids unintentional provider calls with a private draft.

## Source

Owner's decision on [issue #390](https://github.com/TolongLabs/AIRA/issues/390), 25 Nov 2026.
