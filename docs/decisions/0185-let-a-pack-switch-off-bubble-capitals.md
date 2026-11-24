# ADR-0185: Let a Pack Switch Off Bubble Capitals

- **Date:** 2026-11-25
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)
- **Supersedes:** [ADR-0043](0043-capitalise-the-first-letter-of-each-bubble.md), in part

## Decision

A character card may set `capitaliseBubbles: false`. The cleaning chain then skips the capitals step for that pack.
Every other pack keeps the capitals step, and the default stays on.

## Rationale

[ADR-0043](0043-capitalise-the-first-letter-of-each-bubble.md) capitalises every bubble for every pack. A character
whose voice is lower-case texting cannot be built under that rule, because code rewrites the first letter after the
model follows the pack's speech rules. The switch lives on the card, since letter case is part of the persona
([Cleaning Chain](../trd/prompt-engine.md#cleaning-chain)).

## Consequences

The Character Studio form has no control for the field yet. It is set in an imported pack file and kept on later
saves.

## Source

Owner request, 25 Nov 2026.
