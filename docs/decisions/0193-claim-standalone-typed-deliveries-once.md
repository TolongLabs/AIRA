# ADR-0193: Claim Standalone Typed Deliveries Once

- **Date:** 2026-11-26
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

Keep version 1 text attachment unchanged. An explicitly attached version 2 route uses typed delivery IDs scoped
to its current random route ID and the originating chat, inbound message and turn. A durable ledger claims each
item once before the selected adapter's external send. A confirmed result is acknowledged separately from the
core's returned reply. An ambiguous claim or send is never retried; no text directive opens a file or selects
another destination. Negotiate text first, and enable each additional capability only after its own tests.

See [typed delivery](../trd/system.md#standalone-typed-delivery) and
[the delivery ledger](../trd/storage.md#standalone-delivery-ledger).

## Rationale

The exact stock Hermes delivery seam can call selected native transport methods and consume the event without a
default second send. The synthetic result is not live account delivery evidence. A core reply or file receipt
alone cannot establish that a send took place, and retrying an unknown result can duplicate it. A one-time claim
preserves the existing fail-closed admission and permits bounded, receipt-scoped files in a later capability.

## Source

[Standalone compatibility expansion](https://github.com/TolongLabs/AIRA/issues/402).
