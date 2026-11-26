# ADR-0194: Bind Portable Reports to Receipts

- **Date:** 2026-11-26
- **Status:** Accepted
- **Group:** [Architecture](README.md#architecture)

## Decision

An explicitly negotiated `document` capability enables the existing portable report tool only for the current
admitted typed route and chat setting. A delivery claim identifies a successful same-turn, same-chat report
receipt and its verified content-addressed file. Send bounded bytes over the private gateway seam rather than
exposing a host path, accepting a destination, or interpreting a reply directive as a send.

See [typed delivery](../trd/system.md#standalone-typed-delivery) and
[the delivery ledger](../trd/storage.md#standalone-delivery-ledger).

## Rationale

The stock native document method passed local fake-bridge tests on each exact reviewed Hermes version.
The core owns the file and receipt; the selected adapter owns external delivery. Keep those authorities separate
and make an ambiguous outcome non-retryable. No broader live or media capability follows from this candidate.

## Source

[Standalone compatibility expansion](https://github.com/TolongLabs/AIRA/issues/402).
