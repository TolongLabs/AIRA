# ADR-0184: Use typed core commands for the dashboard

- **Date:** 2026-11-24
- **Status:** Accepted
- **Group:** [Site](README.md#site)

## Decision

Use typed same-origin HTTP commands and queries. Resolve each field through its existing owner.
Scoped settings belong to SQLite, editable cards to data packs, and deployment inputs to the deployment runner.
Delegate host actions through the protected owner boundary established in ADR-0183. A future CLI can call the
same operations. Publish revision, source and application status on the corresponding read model.

## Rationale

A CLI subprocess in a web request would add a second serialization and privilege boundary. It would still need
concurrency control for each backing store. SQLite transactions can couple writes and audits. Pack writes need
staging, whole-pack validation, verification and recovery under a coordinated writer lock. An independent
editor can replace bytes outside that lock. Support strict concurrent updates through coordinated apply or import.

## Source

[Dashboard state ownership](../trd/dashboard-state.md) and [parent issue](https://github.com/TolongLabs/AIRA/issues/22).
