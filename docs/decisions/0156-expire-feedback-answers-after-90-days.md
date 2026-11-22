# ADR-0156: Expire Feedback Answers After 90 Days

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

Feedback answers live in `feedback_report.answers`, become null after `records.feedbackDays` (90 by default), and never
enter the Parquet archive.

## Rationale

Answers are untrusted verbatim text collected for a short post-mortem window. Turn metadata keeps its existing retention
instead of being copied into feedback.

## Source

Migrated from row 34 of the Data table in the former `docs/DECISIONS.md`.
