# Contributing

How to get a change into AIRA. Repository rules live in [`docs/CONVENTIONS.md`](docs/CONVENTIONS.md).

## Setup

Install dependencies with Bun:

```sh
bun install
```

AIRA targets Node 24 at runtime and uses Bun as its package manager and script runner.

## Branches And Commits

Branch from `main`. Every change lands through a pull request.

Write commit messages and pull request titles using Conventional Commits (`<type>(<scope>): <description>`), enforced by
commitlint and husky. Keep each commit message to one imperative sentence with no trailing period.

## Checks

Run these checks before asking for review:

```sh
bun run typecheck
bun run lint
bun run format:check
bun run test
```

## Changing a Contract

When a change alters a technical contract, follow the three steps in [`docs/TRD.md`](docs/TRD.md):

1. Change the module that owns the fact, and `docs/TRD.md` if a rule or decision changes.
2. Add a row to [`docs/DECISIONS.md`](docs/DECISIONS.md) with the date and the reason.
3. Change the code and its tests in the same pull request.

## Privacy Rules

This repository is public. Never commit real names, phone numbers, WhatsApp ids, secrets or real chat text in code,
tests, fixtures, recordings, issues or commit messages.

Real character packs are private and live on the host data volume, never in this repository. Only the invented `example`
pack belongs in `characters/`.
