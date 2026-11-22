# ADR-0092: Make `/report` the Direct Feedback Link Command

- **Date:** 2026-11-18
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

`/report` is the direct `feedback_link` command. It creates one single-use random reference tied to the sender and five
turn ids, then returns a prefilled Google Form link with the pack's optional `feedback` line or a plain prompt from
code.

## Rationale

Existing packs still load. The command works without a model and keeps WhatsApp ids, names, numbers and conversation
text out of Google, the reply, receipt and logs.

## Source

Migrated from row 92 of the Architecture table in the former `docs/DECISIONS.md`.
