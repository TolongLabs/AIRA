# ADR-0196: Transfer Direct Media as Bounded Bytes

- **Date:** 2026-11-26
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Use a separately negotiated direct-media helper generation. Transfer one independently checked,
bounded native attachment as bytes under the authenticated route. The core keeps verified content
only in the process-owned turn queue; it never receives the original path or filename.

## Rationale

Stock Hermes can fold quotes into media arrays or retain remote URLs. Neither is direct profile
cache authority. Exact native admission, current route and active chat checks protect the existing
media watcher. A bounded memory-only lifetime avoids host-path mounts and durable raw attachments.
Older exact helper behaviors and the legacy path remain unchanged. Synthetic acceptance cannot
establish live account delivery.

See [direct media](../trd/media-pipelines.md#standalone-direct-media).

## Source

[Standalone compatibility expansion](https://github.com/TolongLabs/AIRA/issues/402).
