# Agent Instructions

This repository builds **AIRA**, a WhatsApp chatbot agent that plays a configured character in each chat. Each `@` path
below imports a document, with a note on what it covers; harnesses without import support should open the files
directly. Edit this file, never `CLAUDE.md` or `GEMINI.md`, which are symlinks to it.

## Hard Rules

- Real character packs are private and never enter the repository.
- No real name, phone number or WhatsApp id in any file.
- Never print or commit `.env`.
- A contract changes in `docs/trd/` before the code changes.

## Instructions

- @docs/agents/coding-guidelines.md — how to approach a task: think before coding, keep it simple, change only what
  the request needs, and loop until the result is verified.
- @docs/agents/graphify.md — query the knowledge graph in `graphify-out/` before reading or searching raw files.
- @docs/agents/rtk.md — shell output comes back condensed; re-run a command with `rtk proxy` only when its result is
  unusable.

## References

- @docs/references/git-workflow.md — how every change gets from a branch to `main`, how commits and titles are named,
  and what enforces each step.
- @docs/references/markdown-style.md — the style every Markdown document here follows: line limits, ATX headings, and
  informative links.

## Project Documents

- @docs/PRD.md — the product requirements: what AIRA must do, for whom, and how far each requirement stands.
- @docs/TRD.md — the technical design: architecture, contracts, cost control, and testing.
- @docs/CONVENTIONS.md — the project conventions for code, naming, tooling, and layout.
- @docs/DECISIONS.md — architecture and design decisions, with context and rationale.
