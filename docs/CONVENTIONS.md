# Conventions

House rules for this repository.

## Language And Modules

- Write TypeScript in strict mode using ES modules, targeting Node 24 at runtime.
- Use Bun as the package manager and script runner (`bun install`, `bun run ...`).
- Keep modules small with one job each.

## Formatting And Linting

- Maximum line length is 120 columns.
- Prettier owns formatting: single quotes, no semicolons, no trailing commas and 2 spaces.
- Biome owns TypeScript linting.

## Naming

- Use Title Case for Markdown headings and table headers. Never re-case identifiers, paths, commands or config keys.
- Files directly under `docs/` use uppercase names. Files under `docs/trd/` use lowercase names.

## Tests

- Place tests beside the layer they belong to using Vitest, following the layers in `docs/trd/harness.md`.

## Commits

- Use Conventional Commits (`<type>(<scope>): <description>`), enforced by commitlint and husky.
- Keep commit messages to one imperative sentence with no trailing period.

## Documentation

- **One Owner per Fact:** a behaviour, limit, default or key lives in one TRD module. Other pages link to it.

## Rules Across Modules

Defined in [`docs/TRD.md`](TRD.md#rules-across-modules):

1. SQLite Is Canonical
2. Identity Comes From Code
3. A Fact Never Leaves Its Chat
4. One Loop, One Tool Set, One Voice
5. The Character Pack Is the Persona Source
6. Every State Change Has a Receipt
7. Every Turn Leaves a Record
8. Untrusted Text Is Labelled
9. The System Prompt Has a Size Cap
