# ADR-0054: Take the Sender Display Name From the Group Message Prefix

- **Date:** 2026-11-17
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The bracketed name before a group message's marker is the sender's display name, stored on the identity. Mentions become
`@<name>`, and unknown numbers `@member`.

## Rationale

Measured on the live gateway: the core read the name as an earlier message and lost it, so the model saw "[member 1]"
and echoed raw WhatsApp ids.

## Source

Migrated from row 54 of the Architecture table in the former `docs/DECISIONS.md`.
