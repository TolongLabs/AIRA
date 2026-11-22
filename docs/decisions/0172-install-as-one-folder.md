# ADR-0172: Install as One Folder

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Deployment](README.md#deployment)

## Decision

An install is one folder: compose file, `.env`, a host `config.yml` mounted read-only, and a bind-mounted data folder.
The ports and image are compose values in `.env`.

## Rationale

The gateway must read the core's files at one host path, which a named volume hides. One folder backs up, moves and
rolls back as one.

## Source

Migrated from row 10 of the Deployment table in the former `docs/DECISIONS.md`. The former log lists this row twice,
here and as [ADR-0165](0165-install-as-one-folder.md), with identical text.
