# ADR-0199: Protect Only Private Persona Instructions

- **Date:** 2026-11-28
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

The card supports an optional `privateInstructions` string. The prompt puts it in a stable block before the
harness rules. The 12-word leak check compares the reply only against the harness and private blocks, not
identity or speech rules. Studio and the generated setup prompt distinguish private instructions from quotable
persona prose.

## Rationale

A character can repeat its own history or examples of its speech without triggering an unintended fallback.
Instructions expressly marked private retain the existing leak-check behavior. The model still sees those
instructions, so the field is not a secret store.

## Source

Owner's decision on [issue #390](https://github.com/TolongLabs/AIRA/issues/390), 25 Nov 2026.
