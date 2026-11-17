<!-- Rebase merge (`gh pr merge <n> --rebase --delete-branch`) after `check` and `scan` pass.
Images go up with `gh pr create --body-file body.md --attach ./diagram.svg`, never committed. -->

## Summary

<!-- One plain sentence: what is better now. -->

| Field             | Answer                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------- |
| **Review**        | <!-- Read or Skim; Read when it touches a contract, a migration, the gateway or CI --> |
| **Action needed** | <!-- Anything to run, review or approve after merge, or None -->                       |
| **Not tested**    | <!-- What was not tested and why, or None -->                                          |
| **Door**          | <!-- one-way or two-way -->                                                            |
| **Blast radius**  | <!-- What a bad merge reaches, and whether the merge restarts the service -->          |
| **Start at**      | <!-- One or two files, and the real size of the diff -->                               |

<!-- One visual: an Archify diagram image, a | Before | After | image table for UI, a results table, or Visual: none, <reason>. -->

## What Changed

<!-- One or two sentences explaining what changed. -->

Closes #

## Why

<!-- Optional: why this change is needed. -->

## Verification

<!-- Commands run and their results. -->

- [ ] Tests added or updated
- [ ] Owning `docs/trd/` module updated if a contract changed
- [ ] `docs/DECISIONS.md` updated if a decision changed
- [ ] No private data in the diff
