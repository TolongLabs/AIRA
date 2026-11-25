# Scripts

Operator and harness scripts specified in the TRD:

For portable installation and operations without a host Node.js or Bun runtime, use the root `aira` launcher
instead. See the [installation guide](../docs/INSTALL.md). The scripts below are developer and legacy-host tools.

- `turn`: Inspect one turn record (`docs/trd/records.md`, `docs/trd/harness.md`).
- `report`: Print latency, failure, cost and fallback figures (`docs/trd/records.md`, `docs/trd/harness.md`).
- `bench`: Run latency and cost benchmarks (`docs/trd/harness.md`).
- `chat`: Open a terminal conversation through the fake gateway (`docs/trd/harness.md`).
- `sim`: Open the WhatsApp chat preview on a core in process, or on a fake bridge with `--gateway` (`docs/trd/harness.md`).
- `pack:check`: Validate a character pack and print its prompt size (`docs/trd/harness.md`).
- Migration: Migrate bindings, settings and memory from the old stores (`docs/trd/memory.md`, `docs/trd/data.md`).
