# ADR-0195: Keep Optional Media in Applied Revisions

- **Date:** 2026-11-26
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

An optional standalone Gemini media watcher has its own explicitly saved/applied model and write-only
credential. Store separate immutable private media settings and credential sidecars beside the existing
schema-1 main/fallback revision, and publish all files before the revision pointer. Absence of both
sidecars denotes a historical disabled role; partial or invalid data fails closed.

## Rationale

A negotiated transport capability alone cannot authorize model spend. The legacy environment and base
configuration are not standalone credential or role authority. The separate sidecars preserve readability
of existing main/fallback revisions by previous cores. An older core's new revision without sidecars
disables the optional role rather than inheriting a different revision's credentials. Configuration alone
does not enable inbound media or prove native delivery.

See [model revision authority](../trd/dashboard-state.md#model-revision-authority).

## Source

[Standalone compatibility expansion](https://github.com/TolongLabs/AIRA/issues/402).
