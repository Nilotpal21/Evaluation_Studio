# Feature: Database Migrations Strategy

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `admin operations`, `enterprise`, `governance`
**Package(s)**: `packages/database`, `packages/eventstore`, `apps/runtime`, `apps/search-ai`, `apps/admin`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/database-migrations.md](../testing/database-migrations.md)
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

The ABL agent platform stores production data across MongoDB (150+ Mongoose models, 18 migration scripts), ClickHouse (analytics tables with materialized views), and Redis (ephemeral, no migration needed). As the platform grows in scale and tenant count, the current migration infrastructure faces several critical challenges:

1. **No expand-contract lifecycle enforcement.** Migrations today are single-step scripts. There is no formal mechanism to separate the expand phase (add new field, dual-write), the data migration phase (backfill), and the contract phase (remove old field). Developers must manually coordinate multi-deployment schema changes, which is error-prone and has already required cleanup scripts (`cleanup/drop-legacy-collections.ts`, `cleanup/remove-dual-read.ts`).

2. **No batched backfill orchestration for large collections.** The latest backfill migration (`20260323_017_backfill_message_project_ids`) processes sessions in batches of 100, but runs synchronously in a single CLI invocation. For collections with millions of documents (messages, sessions, trace events), this can take hours and risks CLI timeout, lock expiry (5-minute TTL), or OOM under memory pressure.

3. **No ClickHouse migration versioning.** ClickHouse schema changes are ad-hoc functions (e.g., `migrateAddCustomDimensions`) called directly, with no version tracking, no history collection, no rollback support, and no integration with the MongoDB migration runner.

4. **No dry-run or validation pass.** Operators cannot preview what a migration will do before executing it, nor validate data integrity after completion.

5. **No cross-service migration ordering.** Runtime, SearchAI, and Admin may depend on specific schema versions. There is no mechanism to declare that "Runtime v2.5 requires migration 20260319_016 to have been applied before startup."

6. **No tenant-scoped migration support.** All migrations run globally. There is no way to migrate a single tenant (for canary rollout) or to track per-tenant migration progress for large backfill operations.

7. **No CI gate.** Migrations are not validated in CI before deployment. A broken migration script can reach production and cause an outage.

### Goal Statement

Establish an enterprise-grade database migration strategy that enforces the expand-contract pattern for zero-downtime schema evolution, provides batched and resumable backfill orchestration via BullMQ, unifies MongoDB and ClickHouse migration versioning, supports dry-run previews and post-migration validation, enables tenant-scoped migration rollout, and integrates migration health into the CI/CD pipeline as a deployment gate.

### Summary

Database Migrations Strategy is the platform's schema evolution control plane. It encompasses:

1. **Migration Runner (enhanced)**: Extends the existing `MigrationRunner` in `packages/database/src/migrations/runner.ts` with phase-aware execution (pre-deploy expand, post-deploy contract), checksum verification, dry-run mode, and lock TTL extension for long-running migrations.

2. **Backfill Orchestrator**: A BullMQ-based job system that decomposes large data migrations into batched, resumable, cursor-paginated work units. Each batch processes a configurable number of documents, reports progress to the migration registry, and can be paused/resumed without losing state.

3. **ClickHouse Migration Versioner**: Brings ClickHouse schema changes under the same versioned, tracked, idempotent migration framework as MongoDB, with history stored in a ClickHouse `_migration_history` table.

4. **Validation Framework**: Pre-migration dry-run that reports estimated document counts and affected indexes, and post-migration validation queries that verify data integrity constraints.

5. **Cross-Service Version Gate**: Startup health checks that verify required migrations have been applied before a service begins accepting traffic.

6. **Admin API and Observability**: REST endpoints for migration status, progress monitoring, and manual trigger/pause/resume of backfill jobs, plus OpenTelemetry metrics and structured logging.

---

## 2. Scope

### Goals

- Enforce the expand-contract pattern as a first-class migration lifecycle with phase metadata (`pre-deploy`, `post-deploy`, `backfill`, `contract`)
- Provide batched, resumable, cursor-paginated backfill orchestration via BullMQ for migrations touching large collections (>100K documents)
- Unify MongoDB and ClickHouse migration versioning under a single registry with history tracking, checksums, and rollback support
- Support dry-run mode that previews migration impact (document counts, index changes, estimated duration) without modifying data
- Support post-migration validation queries to verify data integrity after migration completion
- Enable tenant-scoped migration execution for canary rollout and per-tenant progress tracking
- Provide cross-service migration version gates (startup health checks that verify required migrations are applied)
- Expose admin API endpoints for migration status, progress monitoring, and manual backfill control
- Integrate migration validation into CI as a deployment gate (migration scripts must be parseable, idempotent checks pass, checksums match)
- Emit OpenTelemetry metrics for migration duration, batch progress, failure rates, and lock contention

### Non-Goals (Out of Scope)

- Migrating data between different database engines (e.g., MongoDB to PostgreSQL) is not in scope
- Redis data migration is not in scope (Redis is ephemeral with TTLs)
- Automated schema diff generation (comparing Mongoose schema definitions to detect drift) is a future concern, not part of this feature
- A visual migration timeline UI in Studio is not in scope; admin API and CLI are the primary interfaces
- Prisma integration is not in scope (Prisma is not used in the platform despite earlier references)
- Blue-green database cutover patterns (running two database instances simultaneously) are not in scope
- Automated migration generation from Mongoose schema changes is not in scope

---

## 3. User Stories

1. As a `platform developer`, I want to write a migration script with explicit expand/contract phases so that I can safely add a new required field to an existing collection without downtime.
2. As a `platform developer`, I want to run `pnpm db:migrate:mongo --dry-run` so that I can preview what changes will be applied, how many documents are affected, and the estimated duration before committing to execution.
3. As an `SRE`, I want backfill migrations on large collections (messages, sessions, trace_events) to run as BullMQ jobs with progress tracking so that I can monitor completion percentage, pause if needed, and resume without restarting from zero.
4. As an `SRE`, I want a startup health check in Runtime and SearchAI that verifies all required migrations are applied so that a newly deployed pod does not serve traffic against an incompatible schema.
5. As a `DBA`, I want ClickHouse schema changes to be versioned and tracked in a `_migration_history` table so that I can audit what changed, when, and by whom, just like MongoDB migrations.
6. As a `DBA`, I want migration checksums stored in the history so that I can detect if a migration script was modified after being applied, which would indicate a potential integrity risk.
7. As a `platform operator`, I want to roll out a data backfill migration to a single canary tenant first so that I can verify correctness before applying it to all tenants.
8. As a `platform operator`, I want an admin API endpoint that shows migration status (applied, pending, failed, in-progress with percentage) so that I can monitor migration health from the admin portal.
9. As a `QA engineer`, I want migration scripts to be validated in CI (parseable, checksum-consistent, idempotent safety checks) so that broken migrations do not reach production.
10. As a `QA engineer`, I want post-migration validation queries defined alongside each migration so that I can verify data integrity automatically after migration completion.
11. As a `platform developer`, I want migrations to support optional MongoDB transactions (when replica set is available) so that multi-collection schema changes are atomic where possible.
12. As an `SRE`, I want migration lock TTL to be automatically extended for long-running backfill migrations so that the lock does not expire and allow a second runner to start concurrently.

---

## 4. Functional Requirements

1. **FR-1**: The system must execute MongoDB migrations sequentially in version order, skipping already-applied migrations and halting on the first failure, consistent with the current `MigrationRunner` behavior.
2. **FR-2**: The system must support migration phase metadata (`pre-deploy`, `post-deploy`, `backfill`, `contract`) so that the CLI and CI can filter which migrations to run at each deployment stage.
3. **FR-3**: The system must provide a dry-run mode (`--dry-run`) that reports for each pending migration: affected collections, estimated document count, index changes, and estimated duration — without modifying any data.
4. **FR-4**: The system must support batched backfill migrations that decompose large data transformations into cursor-paginated batches processed as BullMQ jobs, with configurable batch size (default 500), progress tracking (documents processed / total estimated), and pause/resume capability.
5. **FR-5**: The system must store a SHA-256 checksum of each migration script's `up` function body in the `_migration_history` collection, and warn (or fail, if configured) when a previously applied migration's checksum does not match the current script.
6. **FR-6**: The system must track ClickHouse migrations in a dedicated `_migration_history` table in ClickHouse with the same version/description/status/timestamp schema as MongoDB migrations.
7. **FR-7**: The system must provide a rollback mechanism (`pnpm db:migrate:mongo:rollback [steps]`) that executes the `down` function of the last N applied migrations in reverse order, with mandatory rollback script validation (non-empty `down` function).
8. **FR-8**: The system must support tenant-scoped migration execution where a backfill migration can target a specific `tenantId` (or list of tenantIds) for canary rollout, with per-tenant progress tracking.
9. **FR-9**: The system must provide cross-service migration version gates: each service declares its minimum required migration version, and the startup health check verifies all required migrations are applied before the service begins accepting traffic.
10. **FR-10**: The system must expose admin API endpoints for: listing migration status, viewing backfill progress, triggering manual migration runs, and pausing/resuming in-progress backfill jobs.
11. **FR-11**: The system must validate migration scripts in CI: check that scripts are parseable TypeScript, have non-empty `up` and `down` functions, have unique version strings, and pass idempotency lint checks (use of `IF NOT EXISTS` for index creation, `$nin`/`$exists` guards for backfills).
12. **FR-12**: The system must support post-migration validation queries defined alongside each migration that verify data integrity constraints (e.g., "all messages have non-empty projectId") and report results to the migration history.
13. **FR-13**: The system must automatically extend the distributed migration lock TTL for long-running migrations, using the existing `extendLock()` function on a configurable interval (default: every 2 minutes).
14. **FR-14**: The system must emit structured log events and OpenTelemetry metrics for: migration start/complete/fail, batch progress, lock acquisition/release/extension, checksum mismatches, and validation results.
15. **FR-15**: The system must support MongoDB background index creation (`{ background: true }` or ClickHouse `ADD INDEX IF NOT EXISTS`) for all index migrations to avoid blocking writes on large collections.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                             |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Migrations may add/modify project-scoped fields; project creation/deletion unaffected.            |
| Agent lifecycle            | SECONDARY    | Agent schema evolution (new fields, index changes) flows through the migration system.            |
| Customer experience        | SECONDARY    | Zero-downtime guarantee means end users should not experience disruption during migrations.       |
| Integrations / channels    | NONE         | Migrations are an internal platform concern; channel behavior is unaffected.                      |
| Observability / tracing    | PRIMARY      | Migration metrics, progress tracking, and validation results are core operational signals.        |
| Governance / controls      | PRIMARY      | Migration versioning, checksums, audit trails, and RBAC are governance controls.                  |
| Enterprise / compliance    | PRIMARY      | Audit-grade migration history, rollback support, and data validation are enterprise requirements. |
| Admin / operator workflows | PRIMARY      | Operators manage migrations via CLI and admin API; migration health is a deployment gate.         |

### Related Feature Integration Matrix

| Related Feature                                         | Relationship Type | Why It Matters                                                                             | Key Touchpoints                                         | Current State                                           |
| ------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------- | ------------------------------------------------------- |
| [Deployments & Versioning](deployments-versioning.md)   | depends on        | Deployment pipeline must run pre-deploy migrations before rolling out new pods.            | CI gate, startup health check, deployment hooks         | No integration exists today                             |
| [Configuration Management](configuration-management.md) | configured by     | Migration batch sizes, lock TTLs, and feature flags are configuration concerns.            | Env vars, tenant config                                 | Migration config is hard-coded in runner.ts and lock.ts |
| [Audit Logging](audit-logging.md)                       | emits into        | Migration events (apply, rollback, fail, validation) should be recorded in the audit log.  | `audit-log.model.ts`, audit event emitter               | No migration events in audit log today                  |
| [Observability](observability.md)                       | shares data with  | Migration metrics feed into platform dashboards and alerting.                              | OpenTelemetry metrics, structured logs                  | No migration-specific metrics today                     |
| [BullMQ Flows](bullmq-flows.md)                         | depends on        | Backfill orchestrator uses BullMQ for job management, progress tracking, and pause/resume. | `packages/pipeline-engine`, BullMQ queue infrastructure | BullMQ infrastructure exists; not used for migrations   |

---

## 6. Design Considerations (Optional)

- **Expand-contract as a convention, not a framework constraint.** The system enforces phase metadata (`pre-deploy`, `post-deploy`, `backfill`, `contract`) but does not force every migration through all four phases. Simple additive migrations (add optional field with default) can be single-phase `pre-deploy`. The phase system exists to give operators and CI pipelines the information they need to sequence migrations correctly.

- **Backfill orchestrator is opt-in.** Small migrations (affecting <10K documents) can run synchronously in the CLI as they do today. The BullMQ backfill orchestrator is for migrations that the developer explicitly marks as `backfill` phase, indicating they need batched, resumable execution.

- **ClickHouse migrations are append-only by convention.** ClickHouse does not support transactions, and `DROP COLUMN` can cause data loss. The migration framework will warn when a ClickHouse migration contains destructive operations and require explicit `--allow-destructive` flag.

- **Rollback is best-effort.** For MongoDB, rollback runs the `down` function which may be a no-op for irreversible data transformations (e.g., backfilling denormalized data). The framework requires `down` to be non-empty but documents when a migration is "forward-only" via metadata.

- **Migration file naming convention.** Continue the existing pattern: `YYYYMMDD_NNN_description.ts` where `YYYYMMDD` is the date and `NNN` is a zero-padded sequence number within that date.

---

## 7. Technical Considerations (Optional)

- **Existing infrastructure.** The platform already has a functional migration runner (`packages/database/src/migrations/runner.ts`), distributed lock (`lock.ts`), CLI (`cli.ts`), and 18 migration scripts. The strategy builds on this foundation rather than replacing it.

- **Lock TTL extension.** The current lock TTL is 5 minutes with no auto-extension. For backfill migrations that may run for hours, the runner must call `extendLock()` on a configurable interval (default: every 2 minutes) during batch processing.

- **MongoDB transaction support.** The runner already detects replica set availability and uses transactions when possible. This remains unchanged.

- **ClickHouse ADD COLUMN behavior.** ClickHouse `ALTER TABLE ADD COLUMN IF NOT EXISTS` is a non-blocking online DDL operation. It does not lock the table or block writes. This makes it safe for zero-downtime migrations. However, backfilling existing rows with the new column's default value requires a `OPTIMIZE TABLE FINAL` or materialized view rebuild.

- **Mongoose schema drift.** Mongoose schemas define field types and defaults at the application layer, but MongoDB does not enforce schemas by default. Migrations must handle both the MongoDB-level changes (indexes, validation rules) and the data-level changes (backfilling defaults, transforming field shapes). Schema validation rules set via `collMod` can catch drift at write time.

- **Cross-service ordering.** Each service (Runtime, SearchAI, Admin) will declare its minimum required migration version in a config constant. The service's startup health check reads `_migration_history` and refuses to start if the required version is not applied. This prevents deploying a service that expects a schema change that has not been applied yet.

---

## 8. How to Consume

### Studio UI

No direct Studio interaction. Migrations are infrastructure-level operations consumed via CLI and admin portal.

### API (Runtime)

Runtime does not expose migration endpoints. Runtime consumes the migration system indirectly through:

- Startup health check that verifies required migrations are applied
- Schema changes delivered by migrations that Runtime depends on

### API (Studio)

No Studio API endpoints for migrations.

### Admin Portal

| Method | Path                                     | Purpose                                                   |
| ------ | ---------------------------------------- | --------------------------------------------------------- |
| GET    | `/api/admin/migrations/status`           | List all migration versions with status and metadata      |
| GET    | `/api/admin/migrations/backfills`        | List active/completed backfill jobs with progress         |
| POST   | `/api/admin/migrations/run`              | Trigger a manual migration run (with optional phase)      |
| POST   | `/api/admin/migrations/backfills/pause`  | Pause an in-progress backfill job                         |
| POST   | `/api/admin/migrations/backfills/resume` | Resume a paused backfill job                              |
| GET    | `/api/admin/migrations/health`           | Migration health check (all services at required version) |
| POST   | `/api/admin/migrations/validate`         | Run post-migration validation queries                     |

### Channel / SDK / Voice / A2A / MCP Integration

Migrations are not channel-aware. This feature is purely an internal platform concern.

### CLI

| Command                                     | Purpose                                             |
| ------------------------------------------- | --------------------------------------------------- |
| `pnpm db:migrate:mongo`                     | Apply all pending MongoDB migrations (existing)     |
| `pnpm db:migrate:mongo --phase=pre-deploy`  | Apply only pre-deploy phase migrations              |
| `pnpm db:migrate:mongo --phase=post-deploy` | Apply only post-deploy phase migrations             |
| `pnpm db:migrate:mongo --dry-run`           | Preview pending migrations without executing        |
| `pnpm db:migrate:mongo:status`              | Show migration status (existing)                    |
| `pnpm db:migrate:mongo:rollback [steps]`    | Rollback last N migrations (existing)               |
| `pnpm db:migrate:clickhouse`                | Apply all pending ClickHouse migrations             |
| `pnpm db:migrate:clickhouse:status`         | Show ClickHouse migration status                    |
| `pnpm db:migrate:all`                       | Apply all pending migrations (MongoDB + ClickHouse) |
| `pnpm db:backfill:start <version>`          | Start a backfill migration as a BullMQ job          |
| `pnpm db:backfill:status <version>`         | Show backfill progress for a specific migration     |
| `pnpm db:backfill:pause <version>`          | Pause a running backfill                            |
| `pnpm db:backfill:resume <version>`         | Resume a paused backfill                            |
| `pnpm db:migrate:validate`                  | Run post-migration validation queries               |

---

## 9. Data Model

### Collections / Tables

```text
Collection: _migration_history (MongoDB — existing, enhanced)
Fields:
  - version: string (primary key — "YYYYMMDD_NNN")
  - description: string (human-readable summary)
  - phase: string ("pre-deploy" | "post-deploy" | "backfill" | "contract")
  - status: string ("applied" | "rolled_back" | "failed" | "in_progress")
  - appliedAt: Date
  - durationMs: number
  - checksum: string (SHA-256 of migration up function body)
  - appliedBy: string (hostname_pid of the runner)
  - metadata: object (optional — affected collections, document counts, etc.)
Indexes:
  - { version: 1 } (unique)
  - { status: 1, phase: 1 }
```

```text
Collection: _migration_lock (MongoDB — existing, unchanged)
Fields:
  - _id: string ("migration_runner")
  - lockedBy: string (hostname_pid)
  - lockedAt: Date
  - expiresAt: Date
Indexes:
  - { expiresAt: 1 } (TTL cleanup)
```

```text
Collection: _migration_backfill_progress (MongoDB — new)
Fields:
  - _id: string (migration version)
  - tenantId: string (optional — for tenant-scoped backfills, "" for global)
  - status: string ("queued" | "running" | "paused" | "completed" | "failed")
  - totalEstimated: number (estimated total documents to process)
  - totalProcessed: number (documents processed so far)
  - lastCursorId: string (cursor position for resumption)
  - batchSize: number
  - startedAt: Date
  - updatedAt: Date
  - completedAt: Date (optional)
  - errorMessage: string (optional — last error if failed)
  - bullmqJobId: string (BullMQ job ID for pause/resume)
Indexes:
  - { status: 1 }
  - { tenantId: 1, _id: 1 }
```

```text
Collection: _migration_validation_results (MongoDB — new)
Fields:
  - _id: ObjectId
  - version: string (migration version)
  - validatedAt: Date
  - checks: Array<{
      name: string,
      query: string,
      expected: string,
      actual: string,
      passed: boolean
    }>
  - overallPassed: boolean
Indexes:
  - { version: 1, validatedAt: -1 }
```

```text
Table: abl_platform._migration_history (ClickHouse — new)
Columns:
  - version         String
  - description     String
  - status          LowCardinality(String) -- "applied" | "rolled_back" | "failed"
  - applied_at      DateTime64(3)
  - duration_ms     UInt64
  - checksum        String
  - applied_by      String
Engine: ReplicatedMergeTree
ORDER BY (version)
```

### Key Relationships

- `_migration_history` is read by the startup health check in Runtime, SearchAI, and Admin to verify required migration versions.
- `_migration_backfill_progress` is updated by BullMQ backfill workers and read by the admin API for progress monitoring.
- `_migration_validation_results` is written by validation queries after migration completion and surfaced in the admin API.
- The ClickHouse `_migration_history` table mirrors the MongoDB one but tracks ClickHouse-specific migrations independently.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                              | Purpose                                                        |
| ----------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/database/src/migrations/runner.ts`                      | Core migration runner — enhanced with phase filtering, dry-run |
| `packages/database/src/migrations/lock.ts`                        | Distributed migration lock — enhanced with auto-extension      |
| `packages/database/src/migrations/types.ts`                       | Migration interfaces — enhanced with phase, checksum, validate |
| `packages/database/src/migrations/cli.ts`                         | CLI entry point — enhanced with phase and dry-run flags        |
| `packages/database/src/migrations/checksum.ts` (new)              | SHA-256 checksum computation and verification                  |
| `packages/database/src/migrations/validator.ts` (new)             | Post-migration validation query runner                         |
| `packages/database/src/migrations/backfill-orchestrator.ts` (new) | BullMQ-based batched backfill job management                   |
| `packages/database/src/migrations/clickhouse-runner.ts` (new)     | ClickHouse migration runner with version tracking              |
| `packages/database/src/migrations/version-gate.ts` (new)          | Cross-service required-version health check                    |

### Routes / Handlers

| File                                        | Purpose                                      |
| ------------------------------------------- | -------------------------------------------- |
| `apps/admin/src/routes/migrations.ts` (new) | Admin API endpoints for migration management |

### UI Components

| File | Purpose                                   |
| ---- | ----------------------------------------- |
| N/A  | No UI components — CLI and admin API only |

### Jobs / Workers / Background Processes

| File                                                        | Purpose                                            |
| ----------------------------------------------------------- | -------------------------------------------------- |
| `packages/database/src/migrations/backfill-worker.ts` (new) | BullMQ worker that processes backfill batches      |
| `packages/database/src/migrations/lock-extender.ts` (new)   | Periodic lock TTL extension during long migrations |

### Tests

| File                                                                             | Type        | Coverage Focus                                   |
| -------------------------------------------------------------------------------- | ----------- | ------------------------------------------------ |
| `packages/database/src/__tests__/migrations/runner.test.ts` (new)                | unit        | Runner phase filtering, dry-run, halt-on-failure |
| `packages/database/src/__tests__/migrations/lock.test.ts` (new)                  | unit        | Lock acquire/release/extend/expiry               |
| `packages/database/src/__tests__/migrations/checksum.test.ts` (new)              | unit        | Checksum computation and mismatch detection      |
| `packages/database/src/__tests__/migrations/backfill-orchestrator.test.ts` (new) | integration | BullMQ backfill job lifecycle                    |
| `packages/database/src/__tests__/migrations/clickhouse-runner.test.ts` (new)     | integration | ClickHouse migration apply/status/rollback       |
| `packages/database/src/__tests__/migrations/version-gate.test.ts` (new)          | unit        | Startup health check version verification        |
| `packages/database/src/__tests__/migrations/validator.test.ts` (new)             | unit        | Post-migration validation query execution        |
| `packages/database/src/__tests__/e2e/migration-lifecycle.test.ts` (new)          | e2e         | Full migration lifecycle via CLI                 |

---

## 11. Configuration

### Environment Variables

| Variable                            | Default              | Description                                                         |
| ----------------------------------- | -------------------- | ------------------------------------------------------------------- |
| `MIGRATION_LOCK_TTL_MS`             | `300000`             | Distributed lock TTL in milliseconds (5 minutes)                    |
| `MIGRATION_LOCK_EXTEND_INTERVAL_MS` | `120000`             | Interval for automatic lock TTL extension (2 minutes)               |
| `MIGRATION_BACKFILL_BATCH_SIZE`     | `500`                | Default number of documents per backfill batch                      |
| `MIGRATION_BACKFILL_DELAY_MS`       | `100`                | Delay between backfill batches to reduce DB pressure                |
| `MIGRATION_BACKFILL_QUEUE_NAME`     | `migration-backfill` | BullMQ queue name for backfill jobs                                 |
| `MIGRATION_CHECKSUM_ENFORCE`        | `warn`               | Behavior on checksum mismatch: `warn`, `fail`, or `ignore`          |
| `MIGRATION_DRY_RUN`                 | `false`              | Global dry-run mode (overridden by CLI flag)                        |
| `MIGRATION_REQUIRED_VERSION`        | `""`                 | Minimum required migration version for service startup health check |
| `MIGRATION_CLICKHOUSE_ENABLED`      | `true`               | Whether to run ClickHouse migrations alongside MongoDB              |
| `MONGODB_URL`                       | (dev default)        | MongoDB connection string (existing)                                |
| `MONGODB_DATABASE`                  | `abl_platform`       | MongoDB database name (existing)                                    |
| `CLICKHOUSE_URL`                    | (dev default)        | ClickHouse connection string (existing)                             |

### Runtime Configuration

- Migration phase filtering is a CLI argument, not a runtime config.
- Backfill batch size can be overridden per migration via the migration script's `backfillConfig` metadata.
- Tenant-scoped backfill targets are specified via CLI argument (`--tenant-id=xyz`) or admin API parameter.
- Checksum enforcement mode (`warn`/`fail`/`ignore`) can be overridden per environment to allow development flexibility while enforcing strictness in production.

### DSL / Agent IR / Schema

Migrations are not authored in ABL DSL. They are TypeScript files in `packages/database/src/migrations/scripts/` that implement the `Migration` interface.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Tenant-scoped backfill migrations filter by `tenantId` in all queries. A backfill targeting Tenant A must not read or modify Tenant B's data. |
| Project isolation | Migrations that add project-scoped fields must include `projectId` in backfill queries. Cross-project data access must return 404.            |
| User isolation    | Migration scripts must not expose user-owned data across users. Backfill queries filtering by `createdBy` must scope to the correct user.     |

### Security & Compliance

- **RBAC**: Admin migration API endpoints require `platform-admin` or `migration-operator` permission. The CLI runs with MongoDB credentials from environment variables.
- **Audit logging**: All migration events (apply, rollback, fail, validation) must be recorded in the audit log with actor identity, timestamp, and affected migration version.
- **Secret handling**: Migration scripts must not contain hardcoded credentials. Database connection strings come from environment variables.
- **Checksum integrity**: SHA-256 checksums detect unauthorized modification of applied migration scripts, supporting compliance audit requirements.
- **Data minimization**: Migration validation queries should not log or expose PII. Validation checks report aggregate counts and boolean pass/fail, not individual document contents.

### Performance & Scalability

- **Zero-downtime guarantee**: All schema changes must be non-blocking. MongoDB index creation must use `{ background: true }`. ClickHouse `ADD COLUMN` is inherently non-blocking. No collection-level locks during migration.
- **Backfill throughput**: Batched backfills process 500 documents per batch (configurable) with 100ms inter-batch delay (configurable) to cap DB write pressure at approximately 5,000 documents/second.
- **Lock contention**: Only one migration runner can execute at a time (distributed lock). Multiple pods attempting migration at startup will wait or skip, preventing concurrent execution.
- **Large collection handling**: For collections with >1M documents, backfill migrations must use cursor-based pagination (not `skip()`), process in batches, and checkpoint progress to `_migration_backfill_progress` after each batch.
- **Index build impact**: Background index creation on large collections may take minutes to hours. The migration should log estimated completion time and extend the lock accordingly.

### Reliability & Failure Modes

- **Idempotency**: Every migration must be safe to re-run. Use `IF NOT EXISTS` for index creation, `$set` with guards for field additions, and cursor-based pagination with checkpoint for backfills.
- **Resumability**: If a backfill migration fails mid-batch, the checkpoint in `_migration_backfill_progress` allows resumption from the last successfully processed cursor position.
- **Lock expiry recovery**: If the migration runner crashes, the 5-minute lock TTL ensures the lock auto-releases. The next runner picks up where the failed run left off (pending migrations are re-evaluated).
- **Transaction support**: When MongoDB replica set is available, individual migrations run within a transaction for atomicity. On standalone MongoDB (dev), migrations run without transactions.
- **Rollback limitations**: Rollback is best-effort. Data-transforming migrations (backfills, field renames) may have no-op `down` functions. The framework logs this clearly.
- **ClickHouse limitations**: ClickHouse does not support transactions. Destructive operations (DROP COLUMN) require explicit `--allow-destructive` flag and cannot be rolled back.

### Observability

- **Metrics (OpenTelemetry)**:
  - `migration.applied.total` — Counter of successfully applied migrations
  - `migration.failed.total` — Counter of failed migrations
  - `migration.duration.ms` — Histogram of migration execution duration
  - `migration.backfill.progress` — Gauge of backfill completion percentage per migration version
  - `migration.backfill.batch.duration.ms` — Histogram of individual batch processing time
  - `migration.lock.contention.total` — Counter of lock acquisition failures
  - `migration.checksum.mismatch.total` — Counter of checksum mismatches detected
- **Structured logging**: All migration events use `createLogger('migration')` with structured context (`version`, `phase`, `tenantId`, `durationMs`, `documentsProcessed`).
- **Alerts**: Migration failure should trigger a PagerDuty-level alert. Backfill stall (no progress for >30 minutes) should trigger a warning alert.

### Data Lifecycle

- **Migration history retention**: `_migration_history` records are permanent. They serve as an audit trail and must not be deleted.
- **Backfill progress retention**: `_migration_backfill_progress` records for completed backfills are retained for 90 days, then archived or deleted.
- **Validation result retention**: `_migration_validation_results` records are retained for 30 days.
- **Lock cleanup**: The `_migration_lock` document is deleted after each migration run. Stale locks auto-expire via the TTL mechanism.

---

## 13. Delivery Plan / Work Breakdown

1. **Phase 1: Enhanced Migration Runner (pre-deploy/post-deploy phases)**
   1.1 Extend `Migration` interface with `phase` and `backfillConfig` metadata
   1.2 Add phase-filtering to `MigrationRunner.migrate()` and CLI (`--phase=pre-deploy`)
   1.3 Add dry-run mode to CLI and runner (`--dry-run`)
   1.4 Add SHA-256 checksum computation and verification
   1.5 Add automatic lock TTL extension during migration execution
   1.6 Update existing 18 migration scripts with phase metadata (all are `pre-deploy`)
   1.7 Unit tests for runner enhancements, checksum, lock extension

2. **Phase 2: Backfill Orchestrator**
   2.1 Implement `BackfillOrchestrator` using BullMQ for job management
   2.2 Implement `BackfillWorker` with cursor-paginated batch processing
   2.3 Add `_migration_backfill_progress` collection and progress tracking
   2.4 Add pause/resume capability via BullMQ job control
   2.5 Add tenant-scoped backfill support (`--tenant-id` filter)
   2.6 Add CLI commands: `db:backfill:start`, `db:backfill:status`, `db:backfill:pause`, `db:backfill:resume`
   2.7 Integration tests for backfill lifecycle with real MongoDB + Redis

3. **Phase 3: ClickHouse Migration Versioner**
   3.1 Implement `ClickHouseMigrationRunner` with version tracking in ClickHouse `_migration_history` table
   3.2 Port existing `migrateAddCustomDimensions` to versioned migration format
   3.3 Add CLI commands: `db:migrate:clickhouse`, `db:migrate:clickhouse:status`
   3.4 Add destructive operation detection and `--allow-destructive` flag
   3.5 Integration tests with real ClickHouse instance

4. **Phase 4: Validation and Cross-Service Gates**
   4.1 Implement post-migration validation query runner
   4.2 Add `_migration_validation_results` collection
   4.3 Implement cross-service version gate (startup health check)
   4.4 Add `MIGRATION_REQUIRED_VERSION` config to Runtime, SearchAI, Admin
   4.5 Unit tests for validation and version gate

5. **Phase 5: Admin API and Observability**
   5.1 Implement admin migration status endpoint
   5.2 Implement admin backfill progress and control endpoints
   5.3 Add OpenTelemetry metrics for migration events
   5.4 Add audit log integration for migration events
   5.5 E2E tests for admin API endpoints

6. **Phase 6: CI Gate**
   6.1 Create migration lint script (`tools/migration-lint.sh`)
   6.2 Validate: parseable TypeScript, non-empty up/down, unique versions, checksum consistency
   6.3 Add to CI pipeline as a required check before deployment
   6.4 Add idempotency lint checks (IF NOT EXISTS, guard clauses)

---

## 14. Success Metrics

| Metric                             | Baseline                              | Target                                                           | How Measured                                             |
| ---------------------------------- | ------------------------------------- | ---------------------------------------------------------------- | -------------------------------------------------------- |
| Zero-downtime migrations           | Not enforced                          | 100% of migrations run without write-blocking locks              | Migration phase metadata + background index verification |
| Backfill resumability              | No checkpoint support                 | 100% of large backfills are resumable after failure              | `_migration_backfill_progress` checkpoint verification   |
| Migration failure detection in CI  | No CI gate                            | 100% of broken migrations caught before deployment               | CI migration lint pass rate                              |
| ClickHouse migration tracking      | No version tracking                   | 100% of ClickHouse changes versioned and tracked                 | ClickHouse `_migration_history` table completeness       |
| Cross-service version gate         | No startup verification               | All services verify required migrations before accepting traffic | Startup health check logs in Runtime, SearchAI, Admin    |
| Backfill throughput                | Synchronous CLI only                  | 5,000+ documents/second sustained backfill rate                  | Backfill progress metrics                                |
| Migration audit trail completeness | Basic history (version, status, time) | Full history with checksum, phase, duration, actor, validation   | `_migration_history` field completeness                  |
| Operator migration visibility      | CLI-only status                       | Admin API + metrics dashboard for migration health               | Admin API endpoint availability + metric emission        |

---

## 15. Open Questions

1. **Backfill concurrency model**: Should backfill migrations support parallel batch processing (multiple BullMQ workers processing different cursor ranges simultaneously), or is sequential batch processing sufficient? Parallel processing increases throughput but complicates cursor coordination and progress tracking.

2. **ClickHouse rollback strategy**: ClickHouse `DROP COLUMN` is destructive and cannot be undone. Should the framework support ClickHouse rollback at all, or should all ClickHouse migrations be explicitly forward-only? If forward-only, how do we handle a bad ClickHouse migration in production?

3. **Migration ordering across databases**: Should MongoDB and ClickHouse migrations share a single version sequence, or maintain independent version sequences? A unified sequence simplifies cross-database ordering but couples the two systems.

4. **Tenant migration isolation level**: For tenant-scoped backfills, should the system use MongoDB read concern `"majority"` and write concern `"majority"` to ensure consistency, or is the default write concern sufficient? Stronger consistency increases latency per batch.

5. **Startup health check behavior**: When a service detects that required migrations are not applied, should it refuse to start entirely (hard fail), start in degraded mode (soft fail with health check reporting unhealthy), or start normally and log a warning? Hard fail is safest but may cause deployment rollback cascades.

6. **Migration testing against production data**: Should the platform provide a mechanism to run migrations against a production-like snapshot (e.g., mongodump/mongorestore to a staging database) as part of the CI pipeline, or is linting and unit testing sufficient?

7. **Checksum scope**: Should the checksum cover only the `up` function body, or should it include the `down` function and metadata as well? Including `down` catches rollback script modifications but increases false positives during development.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                    | Severity | Status |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No expand-contract phase enforcement today. Developers must manually coordinate multi-deployment migrations.                                   | High     | Open   |
| GAP-002 | No batched/resumable backfill orchestration. Large migrations (>1M documents) risk timeout, OOM, or lock expiry in the synchronous CLI runner. | High     | Open   |
| GAP-003 | ClickHouse migrations have no version tracking, history, or rollback support. Ad-hoc function calls are not auditable.                         | High     | Open   |
| GAP-004 | No CI gate for migration validation. Broken migration scripts can reach production.                                                            | High     | Open   |
| GAP-005 | No cross-service version gate. A service can start with an incompatible schema version.                                                        | Medium   | Open   |
| GAP-006 | No dry-run or preview mode. Operators cannot see what a migration will do before executing it.                                                 | Medium   | Open   |
| GAP-007 | No post-migration validation framework. Data integrity is verified manually or not at all.                                                     | Medium   | Open   |
| GAP-008 | No tenant-scoped migration support. All migrations are global, preventing canary rollout of data changes.                                      | Medium   | Open   |
| GAP-009 | Migration checksums are defined in the type (`checksum?: string`) but not computed or verified by the runner.                                  | Medium   | Open   |
| GAP-010 | Two migration scripts share the same sequence number (`20260305_009_*`), which could cause ordering ambiguity.                                 | Low      | Open   |
| GAP-011 | Migration CLI uses `console.log` instead of `createLogger()` (acceptable for CLI context but inconsistent with platform logging standards).    | Low      | Open   |
| GAP-012 | No admin API for migration status. Operators must SSH into a pod and run the CLI to check migration state.                                     | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                         | Coverage Type | Status     | Test File / Note                                      |
| --- | ---------------------------------------------------------------- | ------------- | ---------- | ----------------------------------------------------- |
| 1   | Sequential migration execution with halt-on-failure              | unit          | NOT TESTED | Runner behavior exists but has no dedicated test file |
| 2   | Distributed lock acquire/release/extend/expiry                   | unit          | NOT TESTED | Lock behavior exists but has no dedicated test file   |
| 3   | Phase-filtered migration execution (pre-deploy only)             | unit          | NOT TESTED | Phase filtering is new functionality                  |
| 4   | Dry-run mode reports affected collections without modifying data | unit          | NOT TESTED | Dry-run is new functionality                          |
| 5   | Checksum computation and mismatch detection                      | unit          | NOT TESTED | Checksum is new functionality                         |
| 6   | Backfill orchestrator batch processing with progress tracking    | integration   | NOT TESTED | Backfill orchestrator is new functionality            |
| 7   | Backfill pause/resume from checkpoint                            | integration   | NOT TESTED | Pause/resume is new functionality                     |
| 8   | ClickHouse migration apply/status/rollback                       | integration   | NOT TESTED | ClickHouse runner is new functionality                |
| 9   | Cross-service version gate startup check                         | unit          | NOT TESTED | Version gate is new functionality                     |
| 10  | Admin API migration status endpoint                              | e2e           | NOT TESTED | Admin API is new functionality                        |
| 11  | Full migration lifecycle via CLI (apply, status, rollback)       | e2e           | NOT TESTED | CLI exists but has no automated test                  |
| 12  | Tenant-scoped backfill isolation                                 | integration   | NOT TESTED | Tenant-scoped backfill is new functionality           |

### Testing Notes

The existing migration runner, lock, and 18 migration scripts have no automated tests. They have been validated manually through successful production execution. The feature spec calls for comprehensive unit, integration, and E2E test coverage for both existing and new functionality.

> Full testing details: [docs/testing/database-migrations.md](../testing/database-migrations.md)

---

## 18. References

- Existing migration runner: `packages/database/src/migrations/runner.ts`
- Existing migration CLI: `packages/database/src/migrations/cli.ts`
- Existing migration lock: `packages/database/src/migrations/lock.ts`
- Existing migration scripts: `packages/database/src/migrations/scripts/`
- Existing ClickHouse schemas: `packages/database/src/clickhouse-schemas/init.ts`
- Existing ClickHouse migration: `packages/database/src/clickhouse-schemas/migrations/add-custom-dimensions.ts`
- Eventstore migration bridge: `packages/eventstore/src/migration/`
- Migration type definitions: `packages/database/src/migrations/types.ts`
- Related feature docs: [Deployments & Versioning](deployments-versioning.md), [Configuration Management](configuration-management.md), [Audit Logging](audit-logging.md)
- Industry references:
  - [Expand and Contract Pattern](https://www.tim-wellhausen.de/papers/ExpandAndContract/ExpandAndContract.html) -- zero-downtime schema evolution
  - [ClickHouse Schema Migration Tools](https://clickhouse.com/docs/knowledgebase/schema_migration_tools) -- official ClickHouse guidance
  - [migrate-mongo](https://github.com/seppevs/migrate-mongo) -- Node.js MongoDB migration framework
  - [Zero-Downtime Database Migration Guide](https://dev.to/ari-ghosh/zero-downtime-database-migration-the-definitive-guide-5672) -- comprehensive patterns
  - [ClickHouse Schema Migrations to Prevent Data Loss](https://www.tinybird.co/blog/clickhouse-schema-migrations) -- production patterns
