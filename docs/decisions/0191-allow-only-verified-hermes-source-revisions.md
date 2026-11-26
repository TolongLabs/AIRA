# ADR-0191: Allow Only Verified Hermes Source Revisions

- **Date:** 2026-11-26
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Extend the v1 text contract using a finite registry of exact source commits, reviewed consumer digest and
adapter-version IDs. Keep the existing v0.23.4 helper and v1 marker/receipt shape compatible. A host version
change requires an explicit reversible reattach of only the selected independent profile. The authenticated
core receipt and CLI readback identify the selected version; unknown source, helper or version refuses.

See the [transport contract](../trd/system.md#standalone-hermes-transport) and
[attachment transaction](../trd/deployment.md#hermes-attachment-transaction).

## Rationale

The public v0.23.2, v0.23.3 and v0.23.4 consumer files have identical reviewed bytes. The actual stock
admission and fake delivery fixture passed at each exact revision, and the independent-profile probe
worked at each. Other stock files differ, so a broad semantic version range is not verified compatibility.
Keep the legacy path unchanged and require actual attach/fixture and separately authorized live evidence
before expanding public support claims.

## Source

[Standalone compatibility expansion](https://github.com/TolongLabs/AIRA/issues/402).
