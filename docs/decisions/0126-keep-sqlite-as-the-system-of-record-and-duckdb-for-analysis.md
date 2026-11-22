# ADR-0126: Keep SQLite as the System of Record and DuckDB for Analysis

- **Date:** 2026-11-16
- **Status:** Accepted
- **Group:** [Data](README.md#data)

## Decision

SQLite stays the system of record. DuckDB is the analysis engine, reading verified snapshots and a Parquet archive,
never the live file.

## Rationale

The core does many small transactions that must each survive a crash. Reports want aggregates across files. Each engine
does the job it was built for.

## Source

Migrated from row 4 of the Data table in the former `docs/DECISIONS.md`.
