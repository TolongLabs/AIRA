# ADR-0183: Route Owner Actions Through the Core Site

- **Date:** 2026-11-23
- **Status:** Accepted
- **Group:** [Site](README.md#site)

## Decision

Keep the core API at `/api/` and publish host owner operations under `/owner-api/` on the same origin.
Use private host sockets for authenticated owner traffic and model probes. Forward the owner's credential
only as a request header. Bind owner-created routines to an internal chat before the gateway can fire them.

## Rationale

The two servers expose incompatible Chats and Settings responses. The container cannot reach the host service
over its normal bridge on dev2. A host socket can reach the listener at its authenticated address without
opening a new network port. The scope binding keeps a job's prompt separate from its delivery authority.

## Source

[Owner console repairs](https://github.com/TolongLabs/AIRA/issues/339).
