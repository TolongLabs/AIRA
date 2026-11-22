# ADR-0027: Store a Quoted Message Beside the Message That Quotes It

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

A quoted message is stored beside the message that quotes it, not in its text, and the model sees it as a labelled
block. Forget clears quotes of a cleared message.

## Rationale

Memory accepts a fact only from the person's own words. A quote inside the text would let another member's words count
as the sender's, and would keep a forgotten text alive.

## Source

Migrated from row 27 of the Architecture table in the former `docs/DECISIONS.md`.
