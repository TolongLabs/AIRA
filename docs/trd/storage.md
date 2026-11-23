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
  The disk guard enforces the cap on each check: when `cache/` holds more than `storage.cacheMaxMb`, it deletes the
  oldest files first until it is under 90% of the cap, and logs `storage.cache_trimmed` with the bytes freed.
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

| Pragma           | Value   | Reason                                                                                       |
| ---------------- | ------- | -------------------------------------------------------------------------------------------- |
| `journal_mode`   | `WAL`   | Readers do not block the writer                                                              |
| `synchronous`    | `FULL`  | A committed transaction survives a power cut or a host crash                                 |
| `foreign_keys`   | `ON`    | Orphan rows are refused                                                                      |
| `busy_timeout`   | 5000 ms | A short lock wait is retried, not failed                                                     |
| `trusted_schema` | `OFF`   | The file cannot run code through its schema                                                  |
| `secure_delete`  | `ON`    | A deleted or cleared value is overwritten, so a forgotten fact leaves no trace in free pages |

At 4 to 16 turns a day, `synchronous=FULL` costs nothing that a person can notice.

## What A Write Promises

- A write is **acknowledged** when its transaction has committed. Only then may code issue a receipt, tick a job as
  done, or tell the model that something was saved.
- A file is written to a temporary name in the same folder, flushed to disk, then renamed. Its row in `file` is
  written after the rename. A file with no row is removed by the start-up sweep; a row with no file is a failure
  record.
- A stored file lives at `<first two hash characters>/<full SHA-256><extension>` under `files/`, so `putFile` in
  `src/storage/files.ts` addresses content and never a name. The extension is optional and holds one to eight
  lowercase letters or digits. Storing the same content twice leaves one file and one row.
- A multi-step change is one transaction or it is a job. There is no third kind.

## Restart Safety

The host restarts, the container is replaced on every deploy, and a process can be killed at any line. The design
assumes all three.

### Everything In Flight Is A Row

| Unit            | Table             | States                                                      | On Start-Up                                                             |
| --------------- | ----------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------- |
| Inbound message | `inbound_message` | `received`, `answered`, `dropped`                           | Unanswered rows are handled as [Interrupted Turns](#interrupted-turns)  |
| Turn            | `turn`            | `running`, `delivered`, `declined`, `failed`, `interrupted` | Every `running` row becomes `interrupted`, with a failure record        |
| Background job  | `memory_job`      | `queued`, `leased`, `done`, `failed`                        | Every lease returns to `queued`: its owner died with the old process    |
| Research job    | `research_job`    | `queued`, `running`, `done`, `failed`                       | A first interruption returns to `queued`; a second becomes `failed`     |
| Reminder        | `reminder`        | `active`, `fired`, `cancelled`                              | The wanted-jobs file is rewritten; the host reconciler recreates jobs   |
| Feedback report | `feedback_report` | `open`, `received`, `closed`, `expired`                     | Open rows remain open until sync receives or the daily job expires them |
| Snapshot        | `backup_run`      | `started`, `verified`, `failed`                             | A `started` row becomes `failed` and its file is removed                |

- An inbound request is written to `inbound_message`, keyed by the chat and the gateway's message id, before any
  other work. The chat is part of the key because a message id is unique only inside its chat, and a stored reply
  must never be returned to another chat.
- The reply of a turn is stored once, as that turn's assistant row in `session_message`, exactly as it was returned
  to the gateway. It is not copied into a record table.
- **A repeated id never runs a second turn.** If the first turn is delivered, the stored reply is returned. If it
  is still running, the request waits for it.
- A job handler is idempotent: running it twice for one job id leaves the same rows as running it once.
- A lease has an owner and an expiry. A worker extends it while it works. Nothing is "in progress" without a lease.
- While the core runs, a lease past its time returns to `queued`. A lease given back at shutdown does not count as
  an attempt. One cut short by a crash does, so a job that kills the process cannot retry for ever.
- A research job survives one interrupted attempt, never a third start. When start-up finds a `running` research job
  at its second attempt, the job becomes `failed` with an internal failure record instead of returning to `queued`.
- Feedback sync fetches and validates outside a transaction. Each returned row updates the report or writes
  `feedback_rejected` and advances `feedback_cursor.after` in one transaction. A kill before that transaction changes
  nothing; a kill after it leaves both classification and cursor committed.
- The lease helpers live in `src/storage/leases.ts`, and the start-up pass that calls them lives in
  `src/storage/recovery.ts`. Every job table joins `JOB_TABLES` there so the pass releases its leases.

### Interrupted Turns

A turn can die after the model answered and before the reply left. Measured on the gateway (spike S-3): when the
connection fails or drops, the gateway sends the identical request again, with the same `mid`, up to six times over
about 22 s to 50 s. Then it sends the failure line to the chat itself.

- The turn is marked `interrupted`, and a failure record is written with the stage it reached.
- If the gateway sends the same message again, the turn runs again and the reply goes out once.
- The core never sends a late reply by itself. Once the gateway has given up, the chat already has the failure line,
  and a late reply would arrive out of order. An interrupted turn is recorded and alerted. See
  [System](system.md#when-the-core-is-slow-or-down).

### Start-Up Sequence

In this order. A failure at any step stops start-up with a non-zero exit, so the updater returns to the previous
image.

1. Check the data volume is writable and free space is above `storage.criticalFreeMb`.
2. Open the database. Run `quick_check` and `foreign_key_check`.
3. Take a verified snapshot if a migration is pending on a database that already holds data. A fresh database
   applies migrations with no snapshot. Apply migrations.
4. Run the recovery pass: interrupted turns, released leases, reminders, unfinished snapshots, the file sweep.
5. Validate configuration, character packs and bindings, as in [Reliability](reliability.md#start-up-and-shutdown).
6. Report ready.

![Start-up checks disk and database, snapshots before pending migrations, applies them, then repairs
interrupted turns, leases, snapshots, and files](../diagrams/storage-startup.svg)

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
  `backup.everyMin` minutes, and start-up takes one more before pending migrations on a database that already holds
  data. Each run records a reason of `timer`, `migration`, `deploy` or `manual` in `backup_run`.
  The timer and the migration gate live in `src/storage/snapshot.ts` and `src/storage/startup.ts`.
- **Verify.** A snapshot counts only after it opens, passes `integrity_check`, and its row counts are within
  reason of the live file. An unverified snapshot is deleted and recorded as `backup_failed`.
- **One file.** A verified snapshot is one self-contained file with a rollback journal, not WAL. `snapshots/`
  holds verified snapshots and nothing else: the recovery pass removes every other entry.
- **Keep.** Verified snapshots are kept for `backup.keepDays` days on the data volume. The newest verified snapshot
  is never removed.
- **Ship.** After each verified snapshot, the backup job runs `restic backup` of that snapshot, `files/` and
  `archive/` into the repository named by `backup.offsite.repository`. restic encrypts and deduplicates on the host,
  so the destination never sees plain data. The repository password is `AIRA_BACKUP_PASSWORD` in `.env`; the
  destination's own credentials are restic's standard variables in `.env` (`RESTIC_REST_USERNAME` and
  `RESTIC_REST_PASSWORD` for a REST server, `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` for S3 or R2). Each run
  writes a `backup_run` row with reason `offsite` and its outcome; a failed run is a `backup_failed` failure and
  retries at the next snapshot. The restic binary is pinned and hash-checked in the image, like Typst.
- **Destination.** `backup.offsite.kind` is `rest` or `s3`. Today it is `rest`: the owner's workstation runs restic's
  `rest-server` in append-only mode, in Docker, listening only on its private-network address, and dev2 pushes to
  it. Append-only means a stolen host credential can add snapshots but cannot delete or rewrite them, and no outside
  system holds a key to the host. Moving to an S3-compatible bucket (S3 or Cloudflare R2) changes
  `backup.offsite.kind`, `backup.offsite.repository` (`s3:<endpoint>/<bucket>/aira`) and the two credential
  variables, and nothing else.
- **Check and prune.** Once a day the job runs `restic check` (structure, no data read) and records the outcome as
  a `backup_run` row. Pruning runs on the destination, never from dev2, because the host's credential is append-only:
  `deploy/offsite/prune.sh` keeps hourly snapshots for 2 days, daily for 30 and weekly for 26.
- **Stale alert.** The workstation can sleep, so the 15-minute target holds only while it is on. When the newest
  successful `offsite` run is older than `backup.offsite.staleAlertMin` (60), the core raises a `backup_stale`
  operator alert ([Reliability](reliability.md)), once until a run succeeds again.
- **Targets.** At most 15 minutes of data is lost if the host's disk is lost. A restore takes at most 30 minutes
  by a written procedure.
- **Restore drill.** Before cutover, and after any change to this module, one restore from the off-host
  repository into a scratch container must pass `integrity_check` and one replay scenario.
  `scripts/restore-offsite.ts --to <folder>` restores the newest snapshot, `files/` and `archive/` into an empty
  folder, runs `integrity_check`, and prints the snapshot time and row counts. The runbook holds the procedure.

![Local snapshots flow from the live database through verification and pruning, while the archive exports
Parquet and the off-host copy stays unbuilt](../diagrams/backups.svg)

The off-host destination is a pending input in the [Product Requirements](../PRD.md#pending-inputs). Continuous
replication of the write-ahead log is the upgrade if 15 minutes is ever too much.

## Analytics And The Archive

Social lookup rows follow their owning turn, tool call or group job retention window. Archive permitted structured fields
before pruning children and then parents. Raw URLs, post IDs, identifiers from share tokens, content,
headers and file paths stay out of social telemetry and archive rows. Keep delivery acknowledgement keys
and temporary repeat claims out of analytics exports.

- The daily retention job in [Records](records.md#retention) exports rows to Parquet under `archive/`, by table and
  month, before it deletes them. Verbatim diagnostics and `feedback_report.answers` are never archived.
- `archiveAndPrune` in `src/storage/archive.ts` collects the rows in a first pass that always rolls back, so
  nothing is deleted yet. It writes each table and month group through a temporary NDJSON file to a temporary
  Parquet file, then moves the finished file into place. Only after every file succeeds does it prune for real with
  the same clock. An export failure removes the files it already wrote and leaves the source rows untouched. Tables
  that hold verbatim text are refused rather than exported.
- Reports that need history read the newest verified snapshot and the archive together through DuckDB.
- The site's dashboard reads the live window through the core's API. It does not need DuckDB.
- Benchmark and harness runs write their results as files that DuckDB reads, so two runs can be compared in one
  query.
- No analysis tool opens the live database file.

## Migrations

- Numbered SQL files, applied in order at start-up, each in one transaction, each recorded in `schema_migration`
  with a checksum. A changed checksum stops start-up.
- A migration file is named `NNNN_name.sql`, and the numbers must run `0001`, `0002`, and on with no gap, or
  start-up refuses them. The ledger is checked the same way: a gap in `schema_migration` stops start-up, while a
  version the release does not know starts anyway, because a newer release applied it. The checks live in
  `src/storage/migrate.ts`.
- **Add first, remove later.** A migration must leave the previous release able to run. A column or table is
  removed one release after the code stopped using it.
- So an image rollback needs no data restore. A restore is for a damaged file only.
- A release that finds migrations in `schema_migration` that it does not know starts anyway: a newer release
  applied them, and they are add-first.
- A migration that cannot keep the previous release working ships in a release marked `manual`, with its own
  rehearsed restore.
- `0013_feedback.sql` is add-only and creates the `STRICT` `feedback_report` and `feedback_cursor` tables. The previous
  release ignores both, so image rollback remains safe.

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

| Key                              | Default | Effect                                                           |
| -------------------------------- | ------- | ---------------------------------------------------------------- |
| `storage.path`                   | `/data` | The data volume inside the container                             |
| `storage.minFreeMb`              | 2048    | Warn level for free space                                        |
| `storage.criticalFreeMb`         | 512     | Critical level for free space                                    |
| `storage.checkEveryMin`          | 5       | How often free space is checked                                  |
| `storage.cacheMaxMb`             | 512     | Size cap for `cache/`                                            |
| `backup.everyMin`                | 15      | Interval between snapshots                                       |
| `backup.keepDays`                | 14      | How long verified snapshots stay on the data volume              |
| `backup.offsite.kind`            | `off`   | `off`, `rest` or `s3`                                            |
| `backup.offsite.repository`      | none    | restic repository URL, such as `rest:http://<address>:8000/aira` |
| `backup.offsite.checkEveryHours` | 24      | Interval between `restic check` runs                             |
| `backup.offsite.staleAlertMin`   | 60      | Age of the newest good off-host run that raises an alert         |
| `archive.enabled`                | `on`    | Export records to Parquet before they are pruned                 |

Deployment values are validated against strict schemas in `src/config/schema.ts`, which also requires
`storage.criticalFreeMb` below `storage.minFreeMb`.

## Owner message submissions

A durable SQLite reservation keyed by submission UUID prevents a second gateway dispatch across concurrent
requests and restarts. Store the core chat reference, content fingerprint, timestamps and outcome. Exclude
message text, gateway identifiers and credentials. Persist unknown before contacting the gateway, then update the
same row after an authoritative acknowledgement. A failed final commit leaves the reservation intact for lookup.
