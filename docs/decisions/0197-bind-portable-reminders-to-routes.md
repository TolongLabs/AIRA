# ADR-0197: Bind Portable Reminders to Routes

- **Date:** 2026-11-26
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

An explicitly negotiated scheduler polls core-owned self-reminders bound to its exact route and profile.
Consume a due occurrence once, then use the durable typed delivery ledger for a separate text claim
and terminal acknowledgement. Do not invoke host cron or permit an adapter-supplied destination.

## Rationale

An identical profile label does not prove account continuity. Route-bound rows prevent an unrelated
adapter from delivering older work. The retained delivery receipt preserves at-most-once behavior
after a lost poll, claim or ambiguous send. The exact native lifecycle starts without an inbound
message and stops with the selected adapter.

See [standalone reminders](../trd/system.md#standalone-reminders).

## Source

[Standalone compatibility expansion](https://github.com/TolongLabs/AIRA/issues/402).
