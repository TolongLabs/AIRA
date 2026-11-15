# Persistence

How AIRA keeps data safe: which store holds what, what a write promises, what happens on a restart, and how data
is copied off the host and brought back.

[Data and Settings](data.md) owns the tables and the settings hierarchy. This module owns everything under them.

## At a Glance

| Item             | Value                                                                         |
| ---------------- | ----------------------------------------------------------------------------- |
| System Of Record | One SQLite file, written by one process                                       |
| Files            | Content-addressed files on the data volume, each with a database row          |
| Analytics        | DuckDB, reading verified snapshots and a Parquet archive. Never the live file |
| Local Copies     | Verified snapshots on the data volume                                         |
| Off-Host Copy    | Encrypted, at most 15 minutes old, on another machine                         |
| Restart Model    | Every unit of work in flight is a database row with a state                   |

## Stores

| Store               | Holds                                                          | Written By                     | Lost If It Is Lost                      |
| ------------------- | -------------------------------------------------------------- | ------------------------------ | --------------------------------------- |
| `aira.db`           | Every durable fact: memory, settings, records, jobs, reminders | The core, one write connection | Everything since the last off-host copy |
| `files/`            | Stickers, studio packs, kept media                             | The core                       | Those files                             |
| `snapshots/`        | Verified copies of `aira.db`                                   | The backup job                 | Nothing; they are copies                |
| `archive/`          | Parquet exports of pruned records, by month                    | The archive job                | Old statistics only                     |
| `cache/`            | Fetched pages and media awaiting a turn                        | Tools and media intake         | Nothing; it is rebuilt                  |
| Off-host repository | Encrypted history of `snapshots/`, `files/` and `archive/`     | The backup job                 | Nothing; it is a copy                   |

- No durable state lives in process memory, in a text or JSON file, or in a temporary folder.
- `cache/` has a size cap and is the first thing emptied when space runs low. Nothing reads it as a source of truth.
- All of these sit on one data volume on the host's local disk. The database is never placed on a network file
  system.

## Why SQLite, And Where DuckDB Fits

| Need                                                   | SQLite                | DuckDB                                                     |
| ------------------------------------------------------ | --------------------- | ---------------------------------------------------------- |
| Many small transactions that must each survive a crash | Built for it          | Works, but built for bulk analysis                         |
| A second process reads while the first writes          | Yes, in WAL mode      | Not on one file. It needs its server mode or a lake format |
| Online backup of a live file                           | Built in              | Not the same tooling                                       |
| Aggregates over many rows, across files and formats    | Adequate at this size | Built for it                                               |
| Reads Parquet and a SQLite file in one query           | No                    | Yes                                                        |

So the core writes SQLite, and DuckDB is the analysis engine for reports, benchmarks and the archive. DuckDB is a
tool for scripts and operators. The reply path does not load it, and the core runs without it.

PostgreSQL is the step up if AIRA ever needs a second writing process or a second host. Nothing in this module
blocks that move: all access goes through one storage module, and no other module writes SQL against a connection.

## Connection Rules

- One write connection, owned by the storage module. Every write goes through its transaction helper.
- Read connections are opened `query_only`. The site API and reports use them.
- Every table is declared `STRICT`.
- A transaction never spans a model call, a tool call or any network call. Work is: read, call out, then write in
  one short transaction.
- Statements are prepared and parameterised. No SQL is built from input text.

| Pragma           | Value   | Reason                                                       |
| ---------------- | ------- | ------------------------------------------------------------ |
| `journal_mode`   | `WAL`   | Readers do not block the writer                              |
| `synchronous`    | `FULL`  | A committed transaction survives a power cut or a host crash |
| `foreign_keys`   | `ON`    | Orphan rows are refused                                      |
| `busy_timeout`   | 5000 ms | A short lock wait is retried, not failed                     |
| `trusted_schema` | `OFF`   | The file cannot run code through its schema                  |

At 4 to 16 turns a day, `synchronous=FULL` costs nothing that a person can notice.

## What A Write Promises

- A write is **acknowledged** when its transaction has committed. Only then may code issue a receipt, tick a job as
  done, or tell the model that something was saved.
- A file is written to a temporary name in the same folder, flushed to disk, then renamed. Its database row is
  written after the rename. A file with no row is removed by the start-up sweep; a row with no file is a failure
  record.
- A multi-step change is one transaction or it is a job. There is no third kind.

## Restart Safety

The host restarts, the container is replaced on every deploy, and a process can be killed at any line. The design
assumes all three.

### Everything In Flight Is A Row

| Unit            | Table                                | States                                                      | On Start-Up                                                            |
| --------------- | ------------------------------------ | ----------------------------------------------------------- | ---------------------------------------------------------------------- |
| Inbound message | `inbound_message`                    | `received`, `answered`, `dropped`                           | Unanswered rows are handled as [Interrupted Turns](#interrupted-turns) |
| Turn            | `turn`                               | `running`, `delivered`, `declined`, `failed`, `interrupted` | Every `running` row becomes `interrupted`, with a failure record       |
| Background job  | `memory_job` and any later job table | `queued`, `leased`, `done`, `failed`                        | A lease past its time returns to `queued`                              |
| Reminder        | `reminder`                           | `active`, `fired`, `cancelled`                              | Reconciled with the gateway's schedule: missing ones are recreated     |
| Snapshot        | `backup_run`                         | `started`, `verified`, `failed`                             | A `started` row becomes `failed` and its file is removed               |

- An inbound request is written to `inbound_message`, keyed by the gateway's message id, before any other work.
- **A repeated id never runs a second turn.** If the first turn is delivered, the stored reply is returned. If it
  is still running, the request waits for it.
- A job handler is idempotent: running it twice for one job id leaves the same rows as running it once.
- A lease has an owner and an expiry. A worker extends it while it works. Nothing is "in progress" without a lease.

### Interrupted Turns

A turn can die after the model answered and before the reply left. What the gateway does then is not yet known.

- The turn is marked `interrupted`, and a failure record is written with the stage it reached.
- If the gateway sends the same message again, the turn runs again and the reply goes out once.
- Whether the core may deliver a late reply by itself is decided by **Spike S-3**, which also covers this case.
  Until then, an interrupted turn is recorded and alerted, and no late reply is sent.

### Start-Up Sequence

In this order. A failure at any step stops start-up with a non-zero exit, so the updater returns to the previous
image.

1. Check the data volume is writable and free space is above `storage.criticalFreeMb`.
2. Open the database. Run `quick_check` and `foreign_key_check`.
3. Take a verified snapshot if a migration is pending. Apply migrations.
4. Run the recovery pass: interrupted turns, expired leases, reminders, unfinished snapshots, the file sweep.
5. Validate configuration, character packs and bindings, as in [Reliability](reliability.md#start-up-and-shutdown).
6. Report ready.

### Shutdown

On SIGTERM the core stops admitting turns, lets running turns finish up to `shutdown.graceMs`, releases its
leases, and closes the database. The container's stop grace period is longer than `shutdown.graceMs`, so the
runtime does not kill the process first.

## Disk Guard

The host's storage pool has filled before, and the old system then failed to open its database.

| Level    | Condition                                 | The Core Does                                                                   |
| -------- | ----------------------------------------- | ------------------------------------------------------------------------------- |
| Warn     | Free space under `storage.minFreeMb`      | Alerts. Empties `cache/`. Pauses the archive job and media caching              |
| Critical | Free space under `storage.criticalFreeMb` | Alerts. Pauses memory extraction. Keeps replying and keeps writing turn records |
| Error    | A write fails with an I/O error           | Fails that transaction, writes nothing partial, records `storage_error`, alerts |

Free space is checked at start-up and every `storage.checkEveryMin` minutes.

## Snapshots And The Off-Host Copy

- **Snapshot.** The backup job copies the live database with SQLite's online backup call, every
  `backup.everyMin` minutes, and before every migration and every deploy.
- **Verify.** A snapshot counts only after it opens, passes `integrity_check`, and its row counts are within
  reason of the live file. An unverified snapshot is deleted and recorded as `backup_failed`.
- **Keep.** Verified snapshots are kept for `backup.keepDays` days on the data volume.
- **Ship.** Each verified snapshot, plus `files/` and `archive/`, goes to an encrypted, deduplicated repository on
  another machine. The repository is checked on a schedule.
- **Targets.** At most 15 minutes of data is lost if the host's disk is lost. A restore takes at most 30 minutes
  by a written procedure.
- **Restore drill.** Before cutover, and after any change to this module, one restore from the off-host
  repository into a scratch container must pass `integrity_check` and one replay scenario.

The off-host destination is a pending input in the [Product Requirements](../PRD.md#pending-inputs). Continuous
replication of the write-ahead log is the upgrade if 15 minutes is ever too much.

## Analytics And The Archive

- The daily retention job in [Records](records.md#retention) exports rows to Parquet under `archive/`, by table and
  month, before it deletes them. Verbatim diagnostics are never archived.
- Reports that need history read the newest verified snapshot and the archive together through DuckDB.
- The site's dashboard reads the live window through the core's API. It does not need DuckDB.
- Benchmark and harness runs write their results as files that DuckDB reads, so two runs can be compared in one
  query.
- No analysis tool opens the live database file.

## Migrations

- Numbered SQL files, applied in order at start-up, each in one transaction, each recorded in `schema_migration`
  with a checksum. A changed checksum stops start-up.
- **Add first, remove later.** A migration must leave the previous release able to run. A column or table is
  removed one release after the code stopped using it.
- So an image rollback needs no data restore. A restore is for a damaged file only.
- A migration that cannot keep the previous release working ships in a release marked `manual`, with its own
  rehearsed restore.

## Embeddings And Search

- Keyword recall uses SQLite's full-text index.
- Embeddings are stored as blobs in a side table and compared in process. At a few thousand rows that is fast
  enough. A vector index extension is the upgrade when it is not.

## Tests

| Suite     | Does                                                                                      | Fails When                                                                                        |
| --------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| Restart   | Kills the core at random points during a scenario, restarts it, and checks the invariants | An acknowledged write is missing, a reply is sent twice, a lease is stuck, or `quick_check` fails |
| Disk Full | Runs a scenario on a volume that fills up                                                 | A write is half applied, or the core stops replying                                               |
| Restore   | Restores a snapshot into a fresh container and runs a scenario                            | The restored core cannot answer, or a row count is wrong                                          |
| Migration | Applies every migration from an empty file and from the previous release's schema         | A migration fails, or the previous release's tests fail on the new schema                         |

The Restart and Migration suites run in CI on every change. See [Test Harness](harness.md).

## Configuration

| Key                      | Default | Effect                                                    |
| ------------------------ | ------- | --------------------------------------------------------- |
| `storage.path`           | `/data` | The data volume inside the container                      |
| `storage.minFreeMb`      | 2048    | Warn level for free space                                 |
| `storage.criticalFreeMb` | 512     | Critical level for free space                             |
| `storage.checkEveryMin`  | 5       | How often free space is checked                           |
| `storage.cacheMaxMb`     | 512     | Size cap for `cache/`                                     |
| `backup.everyMin`        | 15      | Interval between snapshots                                |
| `backup.keepDays`        | 14      | How long verified snapshots stay on the data volume       |
| `backup.offsite`         | `off`   | The off-host repository. `off` until a destination is set |
| `archive.enabled`        | `on`    | Export records to Parquet before they are pruned          |
