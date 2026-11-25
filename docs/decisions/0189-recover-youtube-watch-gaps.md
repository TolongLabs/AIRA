# ADR-0189: Recover YouTube Watch Gaps

- **Date:** 2026-11-26
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)
- **Supersedes in part:** [ADR-0081](0081-watch-youtube-links-in-parallel-segments.md)

## Decision

Retain the existing URL-based parallel planner, 600 s cap, and frame rate. Increase the default watch window
to 22 s within the existing outer deadline. Recover only eligible fast failures of the same range, with one
retry lane, two retry launches per link, and quota/auth guards. Preserve the existing verified Short fallback
window. Retain structured final range evidence until prompt rendering so that coverage and text agree.

See the [YouTube Links contract](../trd/media-pipelines.md#youtube-links) for the exact rules and limits.

## Rationale

The earlier 12 s window discarded slow valid readings and offered no recovery for early transient failures.
A second prompt truncation could discard successful later ranges even though the coverage implied they were
watched. A longer bounded window plus small recovery allowance preserves in-flight work and avoids the call
amplification of dynamic segment splitting. The original historical timings in ADR-0081 are not current
provider guarantees; measuring real coverage and latency is a separate rollout gate.
