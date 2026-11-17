# Readiness

The cutover readiness check (#32) for release `v1.1.0` (`01941e4`), run on 18 Nov 2026 on the live host (dev2) and in
CI. Each row is one item of #32.

| Item                      | Target                                            | Result                                                                                             | Status |
| ------------------------- | ------------------------------------------------- | -------------------------------------------------------------------------------------------------- | ------ |
| NFR-1 Casual latency      | p50 5 to 7 s, p90 10 s                            | 12 of 12 delivered; p50 3.2 s, p90 3.7 s; $0.0002 a turn; cache 76%                                | Pass   |
| NFR-1 Tool latency        | p90 under 25 s                                    | 8 of 8 delivered, 6 with tools; p50 5.9 s, p90 8.7 s; $0.0006 a turn                               | Pass   |
| NFR-2 Prompt size         | Under 8,000 tokens for every pack in use          | `aira` 1,335, `taiga` 2,596 (private packs, checked read-only on the host); repository packs in CI | Pass   |
| NFR-3 Both transports     | Same prompt, tools and cleaning on both           | Subscription replay suite 4 of 4; live benchmark on both transports on 17 Nov (#28)                | Pass   |
| NFR-4 Memory simulator    | Isolation, lost writes, drift, forget, recovery   | `tests/simulator` 30 of 30                                                                         | Pass   |
| NFR-5 Privacy and secrets | Both scans pass on the release                    | Privacy Scan in `tests/gates` 4 of 4; gitleaks `scan` job: no leaks                                | Pass   |
| Fixed gates in CI         | All pass, zero live calls in replay and simulator | `check` on `01941e4`: 1,301 passed, 4 skipped; Zero Live Calls gate passes                         | Pass   |
| Live layer                | Tool triggering and persona checks on real models | `bun run live` (#211) on `4608ef5`, both packs: tools 6 of 6, persona 8 of 8                       | Pass   |
| Migration dry run         | Report with no unassigned fact                    | 124 kept, 7 rejected, 0 unassigned (16 Nov); real run at cutover, same counts                      | Pass   |
| Rollback on staging       | Rehearsed once                                    | Waived: the owner cut over without staging on 17 Nov (`docs/DECISIONS.md`)                         | Waived |
| NFR-11 Restart suite      | No lost write, no double reply, no stuck lease    | `tests/restart` 10 of 10                                                                           | Pass   |
| NFR-12 Restore drill      | Off-host restore under 30 minutes                 | 4 s; `integrity_check: ok`; scratch core `ready`, synthetic turn 200 (#36)                         | Pass   |
| Disk-full suite           | Passes                                            | `tests/diskfull` 2 of 2                                                                            | Pass   |

The default pack first failed 2 persona cases, because its card said it was an AI. On 18 Nov the owner had the card
rewritten to answer as its persona, and both packs then passed.

The benchmark and live check raw results are kept outside the repository with the session files. Latency is
measured from arrival to return and includes the 1.5 s batch wait.
