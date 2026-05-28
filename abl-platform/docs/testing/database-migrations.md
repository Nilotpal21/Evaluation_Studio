# Feature Test Guide: Database Migrations Strategy

**Feature**: MongoDB and ClickHouse schema migration lifecycle, backfill orchestration, validation, and cross-service version gates
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/database-migrations.md](../features/database-migrations.md)
**First audited**: 2026-03-23
**Last updated**: 2026-03-23
**Overall status**: NOT TESTED

---

## Current State (as of 2026-03-23)

The platform has a functional migration runner (`packages/database/src/migrations/runner.ts`) with distributed locking, sequential execution, transaction support (when replica set is available), and history tracking in `_migration_history`. There are 18 migration scripts covering schema validation, index fixes, field backfills, and data seeding. A CLI (`cli.ts`) provides `migrate`, `status`, and `rollback` commands.

However, **there are zero automated tests** for the migration infrastructure. The runner, lock, CLI, and all 18 migration scripts have been validated only through manual execution in development and production environments. The feature spec introduces significant new functionality (phase filtering, dry-run, backfill orchestrator, ClickHouse versioning, validation framework, cross-service gates, admin API) that requires comprehensive test coverage from the start.

### Quick Health Dashboard

| Area                                       | Status     | Last Verified | Notes                                                               |
| ------------------------------------------ | ---------- | ------------- | ------------------------------------------------------------------- |
| MigrationRunner sequential execution       | NOT TESTED | manual only   | Works in production but no automated test                           |
| MigrationRunner halt-on-failure            | NOT TESTED | manual only   | First failure stops remaining migrations                            |
| Distributed lock acquire/release           | NOT TESTED | manual only   | lock.ts uses MongoDB upsert with TTL                                |
| Distributed lock TTL expiry                | NOT TESTED | manual only   | 5-minute TTL auto-releases on crash                                 |
| Lock extension (extendLock)                | NOT TESTED | manual only   | Function exists but not called by runner                            |
| Rollback execution                         | NOT TESTED | manual only   | Reverses last N applied migrations                                  |
| Migration history tracking                 | NOT TESTED | manual only   | Records version, status, timestamp, duration in \_migration_history |
| Transaction support detection              | NOT TESTED | manual only   | Detects replica set via `hello` command                             |
| CLI migrate/status/rollback commands       | NOT TESTED | manual only   | cli.ts entry point                                                  |
| Phase-filtered execution (pre/post-deploy) | NOT TESTED | planned       | New feature — phase metadata on Migration interface                 |
| Dry-run mode                               | NOT TESTED | planned       | New feature — preview without executing                             |
| Checksum computation and verification      | NOT TESTED | planned       | New feature — SHA-256 of up function body                           |
| Automatic lock TTL extension               | NOT TESTED | planned       | New feature — extend every 2 minutes during long migrations         |
| Backfill orchestrator (BullMQ)             | NOT TESTED | planned       | New feature — batched, resumable, cursor-paginated                  |
| Backfill pause/resume                      | NOT TESTED | planned       | New feature — via BullMQ job control                                |
| Tenant-scoped backfill                     | NOT TESTED | planned       | New feature — filter by tenantId                                    |
| ClickHouse migration runner                | NOT TESTED | planned       | New feature — versioned ClickHouse migrations                       |
| Post-migration validation                  | NOT TESTED | planned       | New feature — data integrity verification queries                   |
| Cross-service version gate                 | NOT TESTED | planned       | New feature — startup health check                                  |
| Admin API migration endpoints              | NOT TESTED | planned       | New feature — status, progress, control                             |
| CI migration lint gate                     | NOT TESTED | planned       | New feature — pre-deployment validation                             |

---

## Coverage Matrix

| FR    | Description                                                     | Unit       | Integration | E2E        | Manual | Status  |
| ----- | --------------------------------------------------------------- | ---------- | ----------- | ---------- | ------ | ------- |
| FR-1  | Sequential migration execution, skip applied, halt on failure   | NOT TESTED | NOT TESTED  | NOT TESTED | PASS   | Manual  |
| FR-2  | Phase metadata and phase-filtered execution                     | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-3  | Dry-run mode previews without modifying data                    | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-4  | Batched backfill via BullMQ with progress and pause/resume      | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-5  | Checksum computation and verification                           | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-6  | ClickHouse migration versioning and history                     | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-7  | Rollback executes down functions in reverse order               | NOT TESTED | NOT TESTED  | NOT TESTED | PASS   | Manual  |
| FR-8  | Tenant-scoped backfill with per-tenant progress                 | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-9  | Cross-service version gate blocks startup on missing migrations | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-10 | Admin API for migration status, progress, and control           | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-11 | CI migration lint (parseable, unique versions, idempotency)     | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-12 | Post-migration validation queries                               | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-13 | Automatic lock TTL extension for long-running migrations        | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-14 | Structured logs and OpenTelemetry metrics for migration events  | NOT TESTED | NOT TESTED  | NOT TESTED | N/A    | Planned |
| FR-15 | Background index creation (non-blocking)                        | NOT TESTED | NOT TESTED  | NOT TESTED | PASS   | Manual  |

---

## E2E Test Scenarios (minimum 5)

### E2E-1: Full MongoDB Migration Lifecycle via CLI

**Preconditions**: Real MongoDB instance (Docker Compose or testcontainers). Empty `_migration_history` collection. Three test migration scripts registered: `test_001` (add field), `test_002` (create index), `test_003` (backfill data).

**Steps**:

1. Run `pnpm db:migrate:mongo` (apply all pending).
2. Assert CLI output shows 3 migrations applied in order: `test_001`, `test_002`, `test_003`.
3. Query `_migration_history` collection — assert 3 documents with `status: "applied"`, `durationMs > 0`, `appliedAt` set.
4. Run `pnpm db:migrate:mongo` again (re-run).
5. Assert CLI output shows "No pending migrations" (idempotent — no re-application).
6. Run `pnpm db:migrate:mongo:status`.
7. Assert output lists all 3 migrations as "applied" with timestamps.
8. Run `pnpm db:migrate:mongo:rollback 1`.
9. Assert `test_003` is rolled back (status changes to `rolled_back` in history).
10. Run `pnpm db:migrate:mongo:status` — assert `test_001` and `test_002` are "applied", `test_003` is "rolled_back".
11. Run `pnpm db:migrate:mongo` — assert `test_003` is re-applied.

**Expected Result**: Full lifecycle (apply, idempotent re-run, status check, rollback, re-apply) works end-to-end via CLI against real MongoDB.

**Auth Context**: CLI runs with `MONGODB_URL` credentials from environment.

**Isolation Check**: N/A (infrastructure test, not tenant-scoped).

---

### E2E-2: Rollback with Compensating Migration on Real Data

**Preconditions**: Real MongoDB instance. Collection `test_widgets` pre-populated with 100 documents, each having `{ name: "widget-N", category: "legacy" }`. Migration `test_rename_001` renames `category` to `type` via expand-contract: `up` adds `type` field copied from `category`, `down` copies `type` back to `category` and removes `type`.

**Steps**:

1. Verify all 100 documents have `category` field and no `type` field.
2. Run `pnpm db:migrate:mongo` to apply `test_rename_001`.
3. Query `test_widgets` — assert all 100 documents now have `type` field equal to their original `category` value.
4. Assert `_migration_history` shows `test_rename_001` as "applied".
5. Run `pnpm db:migrate:mongo:rollback 1`.
6. Query `test_widgets` — assert all 100 documents have `category` restored and `type` removed.
7. Assert `_migration_history` shows `test_rename_001` as "rolled_back".

**Expected Result**: Rollback correctly reverses data transformation. No documents lost or corrupted.

**Auth Context**: CLI credentials.

**Isolation Check**: N/A.

---

### E2E-3: Large Backfill Migration with Pause and Resume

**Preconditions**: Real MongoDB instance + Redis instance (for BullMQ). Collection `test_events` pre-populated with 10,000 documents, each missing `projectId` field. Backfill migration `test_backfill_001` adds `projectId` by looking up the event's `sessionId` in a `test_sessions` collection. `test_sessions` has 100 sessions, each mapped to a project. `MIGRATION_BACKFILL_BATCH_SIZE=200`.

**Steps**:

1. Run `pnpm db:backfill:start test_backfill_001`.
2. Assert `_migration_backfill_progress` document created with `status: "running"`, `totalEstimated: 10000`, `batchSize: 200`.
3. Wait for approximately 5 batches to complete (check `totalProcessed >= 1000`).
4. Run `pnpm db:backfill:pause test_backfill_001`.
5. Assert `_migration_backfill_progress.status` changes to `"paused"`.
6. Assert `lastCursorId` is set (checkpoint for resumption).
7. Verify that the BullMQ job is in paused state.
8. Run `pnpm db:backfill:resume test_backfill_001`.
9. Assert `_migration_backfill_progress.status` changes back to `"running"`.
10. Wait for backfill to complete.
11. Assert `_migration_backfill_progress.status` is `"completed"`, `totalProcessed` equals `totalEstimated`.
12. Query `test_events` — assert all 10,000 documents now have `projectId` set.
13. Verify no documents were processed twice (count of updates equals 10,000, not more).

**Expected Result**: Backfill processes all documents in batches, supports pause/resume from checkpoint, and completes without data duplication.

**Auth Context**: CLI credentials + Redis connection.

**Isolation Check**: N/A (global backfill).

---

### E2E-4: Concurrent Access During Migration (Zero-Downtime Proof)

**Preconditions**: Real MongoDB instance. Collection `test_orders` with 5,000 documents. Migration `test_expand_001` adds a new optional field `shippingRegion` with default `""` to all documents. A background writer script continuously inserts new `test_orders` documents (1 per 100ms) during migration.

**Steps**:

1. Start background writer that inserts new documents to `test_orders` with `{ orderId, amount, createdAt }` (no `shippingRegion` — simulating old application code).
2. Run `pnpm db:migrate:mongo` to apply `test_expand_001` (adds `shippingRegion` to existing documents).
3. Assert migration completes without error.
4. Stop background writer. Record how many new documents were inserted during migration.
5. Query `test_orders` — assert original 5,000 documents all have `shippingRegion` field.
6. Assert newly inserted documents during migration do NOT have `shippingRegion` (they were inserted by old code) — this is expected; the contract phase (a later migration) would handle these.
7. Verify that no inserts failed during migration (zero write errors from the background writer).
8. Verify that no reads failed during migration (run a parallel reader that queries `test_orders` throughout).

**Expected Result**: Migration does not block concurrent reads or writes. New documents inserted during migration may not have the new field (expected for expand phase). Zero write errors, zero read errors.

**Auth Context**: CLI credentials.

**Isolation Check**: Background writer and reader operate concurrently with migration.

---

### E2E-5: Cross-Service Migration Version Gate

**Preconditions**: Real MongoDB instance. `_migration_history` contains applied migrations up to version `20260319_016`. Runtime configured with `MIGRATION_REQUIRED_VERSION=20260323_017`. SearchAI configured with `MIGRATION_REQUIRED_VERSION=20260319_016`.

**Steps**:

1. Start SearchAI server on random port.
2. Assert SearchAI starts successfully (required version `20260319_016` is applied).
3. Call SearchAI health endpoint — assert HTTP 200 with `{ migrations: "ok" }`.
4. Start Runtime server on random port.
5. Assert Runtime fails to start or starts in degraded mode (required version `20260323_017` is NOT applied).
6. Assert Runtime health endpoint returns HTTP 503 with `{ migrations: "pending", required: "20260323_017", current: "20260319_016" }`.
7. Apply migration `20260323_017` to MongoDB.
8. Restart Runtime server.
9. Assert Runtime starts successfully.
10. Call Runtime health endpoint — assert HTTP 200 with `{ migrations: "ok" }`.

**Expected Result**: Services with satisfied migration requirements start normally. Services with unsatisfied requirements refuse traffic or report unhealthy.

**Auth Context**: Service startup credentials.

**Isolation Check**: N/A (infrastructure health check).

---

### E2E-6: ClickHouse Migration Lifecycle

**Preconditions**: Real ClickHouse instance (Docker Compose). Empty `_migration_history` table in ClickHouse. Two test migrations: `ch_001` (ADD COLUMN), `ch_002` (ADD INDEX).

**Steps**:

1. Run `pnpm db:migrate:clickhouse`.
2. Assert both migrations applied in order.
3. Query ClickHouse `_migration_history` — assert 2 rows with `status = 'applied'`.
4. Query ClickHouse `system.columns` — verify the new column exists on the target table.
5. Run `pnpm db:migrate:clickhouse` again — assert "No pending migrations" (idempotent).
6. Run `pnpm db:migrate:clickhouse:status` — assert both migrations shown as "applied".

**Expected Result**: ClickHouse migrations are versioned, tracked, and idempotent.

**Auth Context**: `CLICKHOUSE_URL` credentials.

**Isolation Check**: N/A.

---

### E2E-7: Admin API Migration Status and Backfill Control

**Preconditions**: Admin server started on random port. Real MongoDB + Redis. Two MongoDB migrations applied. One backfill migration in progress.

**Steps**:

1. GET `/api/admin/migrations/status` — assert HTTP 200 with array of migration statuses.
2. Assert each migration has `version`, `description`, `status`, `phase`, `appliedAt`, `durationMs`, `checksum`.
3. GET `/api/admin/migrations/backfills` — assert HTTP 200 with array containing the in-progress backfill.
4. Assert backfill entry has `status: "running"`, `totalProcessed`, `totalEstimated`, `batchSize`.
5. POST `/api/admin/migrations/backfills/pause` with `{ version: "<backfill-version>" }` — assert HTTP 200.
6. GET `/api/admin/migrations/backfills` — assert backfill status changed to `"paused"`.
7. POST `/api/admin/migrations/backfills/resume` with `{ version: "<backfill-version>" }` — assert HTTP 200.
8. GET `/api/admin/migrations/backfills` — assert backfill status changed back to `"running"`.
9. GET `/api/admin/migrations/health` — assert HTTP 200 with service migration health summary.

**Expected Result**: Admin API provides full visibility and control over migration state and backfill jobs.

**Auth Context**: Admin user with `platform-admin` permission. Authenticated via `createUnifiedAuthMiddleware`.

**Isolation Check**: Endpoint requires `platform-admin` role. Non-admin users receive HTTP 403.

---

## Integration Test Scenarios (minimum 5)

### INT-1: MigrationRunner Sequential Execution with Real MongoDB

**Boundary**: `MigrationRunner` + real MongoDB instance.

**Setup**: Real MongoDB via testcontainers or Docker Compose. Three test migrations registered.

**Steps**:

1. Call `runner.migrate()` — assert `result.applied` contains all 3 versions in order.
2. Query `_migration_history` — verify 3 documents with `status: "applied"`.
3. Call `runner.migrate()` again — assert `result.applied` is empty (already applied).
4. Modify second migration to throw an error. Register a fourth migration.
5. Rollback the third and second migration. Re-register the error-throwing second migration.
6. Call `runner.migrate()` — assert second migration fails, third and fourth are skipped.
7. Assert `result.failed` is the second migration version.
8. Assert `result.skipped` contains the third and fourth versions.
9. Assert `_migration_history` records the failure with `status: "failed"`.

**Expected Result**: Runner applies pending migrations sequentially, halts on first failure, and correctly tracks applied/failed/skipped state.

**Failure Mode**: If MongoDB is unavailable, runner throws connection error before lock acquisition.

---

### INT-2: Distributed Lock Contention with Concurrent Runners

**Boundary**: `acquireLock` / `releaseLock` + real MongoDB instance.

**Setup**: Real MongoDB. Two `MigrationRunner` instances pointing to the same database.

**Steps**:

1. Runner A calls `acquireLock()` — assert returns `true`.
2. Runner B calls `acquireLock()` — assert returns `false` (lock held by A).
3. Query `_migration_lock` — verify single document with A's `lockedBy`.
4. Runner A calls `releaseLock()`.
5. Runner B calls `acquireLock()` — assert returns `true` (lock released).
6. Simulate crash: Runner B does NOT call `releaseLock()`.
7. Wait for lock TTL expiry (5 minutes, or use shorter test TTL).
8. Runner A calls `acquireLock()` — assert returns `true` (expired lock overwritten).

**Expected Result**: Only one runner holds the lock at a time. Lock auto-expires on crash.

**Failure Mode**: Duplicate key error (E11000) during concurrent upsert is correctly handled as "lock not acquired".

---

### INT-3: Backfill Orchestrator Batch Processing with BullMQ

**Boundary**: `BackfillOrchestrator` + `BackfillWorker` + real MongoDB + real Redis.

**Setup**: Real MongoDB with `test_items` collection containing 2,000 documents. Real Redis for BullMQ. `batchSize = 100`.

**Steps**:

1. Create backfill migration that adds `normalizedName = name.toLowerCase()` to each document.
2. Call `orchestrator.start('test_backfill_batch', { batchSize: 100 })`.
3. Assert `_migration_backfill_progress` document created with `status: "queued"`.
4. Wait for BullMQ worker to process.
5. After completion, assert `_migration_backfill_progress.status` is `"completed"`.
6. Assert `totalProcessed` equals 2000.
7. Query `test_items` — assert all 2,000 documents have `normalizedName` field.
8. Verify `lastCursorId` was updated after each batch (check intermediate progress snapshots or BullMQ job logs).

**Expected Result**: Backfill processes all documents in 20 batches of 100. Progress is tracked. All documents are transformed.

**Failure Mode**: If Redis disconnects mid-backfill, BullMQ job stalls. On reconnect, the job can be retried from the last checkpoint.

---

### INT-4: Tenant-Scoped Backfill Isolation

**Boundary**: `BackfillOrchestrator` with tenant filter + real MongoDB.

**Setup**: Real MongoDB. `test_records` collection with 500 documents for Tenant A (tenantId: "t-a") and 500 documents for Tenant B (tenantId: "t-b"). Both missing `region` field.

**Steps**:

1. Start backfill migration targeting only Tenant A (`--tenant-id=t-a`).
2. Wait for backfill to complete.
3. Query `test_records` where `tenantId = "t-a"` — assert all 500 have `region` field set.
4. Query `test_records` where `tenantId = "t-b"` — assert all 500 do NOT have `region` field (untouched).
5. Assert `_migration_backfill_progress` shows tenant-scoped progress: `tenantId: "t-a"`, `totalProcessed: 500`.
6. Start backfill migration targeting Tenant B.
7. Wait for completion. Assert all Tenant B documents now have `region` field.

**Expected Result**: Tenant-scoped backfill modifies only the targeted tenant's data. Other tenants are unaffected.

**Failure Mode**: If tenant filter is omitted, all tenants are migrated (global mode).

---

### INT-5: ClickHouse Migration Runner with Version Tracking

**Boundary**: `ClickHouseMigrationRunner` + real ClickHouse instance.

**Setup**: Real ClickHouse via Docker Compose. Target table `test_analytics` with initial schema. Two migrations: `ch_001_add_region` (ADD COLUMN `region String DEFAULT ''`), `ch_002_add_index` (ADD INDEX on `region`).

**Steps**:

1. Call `clickhouseRunner.migrate()`.
2. Assert both migrations applied.
3. Query ClickHouse `_migration_history` — assert 2 rows with `status = 'applied'`, timestamps, and durations.
4. Query `system.columns` for `test_analytics` — assert `region` column exists with type `String`.
5. Call `clickhouseRunner.migrate()` again — assert "No pending migrations".
6. Call `clickhouseRunner.status()` — assert both migrations reported as "applied".
7. Add migration `ch_003_drop_column` (DROP COLUMN — destructive).
8. Call `clickhouseRunner.migrate()` without `--allow-destructive` — assert error/warning about destructive operation.
9. Call `clickhouseRunner.migrate({ allowDestructive: true })` — assert migration applied.

**Expected Result**: ClickHouse migrations are versioned, tracked, idempotent, and destructive operations are gated.

**Failure Mode**: If ClickHouse is unavailable, runner throws connection error.

---

### INT-6: Post-Migration Validation Query Execution

**Boundary**: `MigrationValidator` + real MongoDB.

**Setup**: Real MongoDB. Migration `test_validate_001` has a validation block: `{ name: "all_orders_have_region", query: "db.orders.countDocuments({ region: { $exists: false } })", expected: "0" }`. Collection `orders` with 1,000 documents.

**Steps**:

1. Apply migration `test_validate_001` (adds `region` field to all orders).
2. Call `validator.validate('test_validate_001')`.
3. Assert validation result: `{ overallPassed: true, checks: [{ name: "all_orders_have_region", passed: true, expected: "0", actual: "0" }] }`.
4. Assert `_migration_validation_results` document stored with results.
5. Manually remove `region` from 5 documents (simulate partial failure).
6. Call `validator.validate('test_validate_001')` again.
7. Assert validation result: `{ overallPassed: false, checks: [{ name: "all_orders_have_region", passed: false, expected: "0", actual: "5" }] }`.

**Expected Result**: Validation detects data integrity issues after migration.

**Failure Mode**: Validation query timeout is configurable (default 30 seconds). On timeout, check reports as failed with error message.

---

### INT-7: Checksum Verification and Mismatch Detection

**Boundary**: `MigrationRunner` checksum logic + real MongoDB.

**Setup**: Real MongoDB. Migration `test_checksum_001` applied with checksum stored in `_migration_history`.

**Steps**:

1. Apply `test_checksum_001`. Verify `_migration_history` document has `checksum` field set (SHA-256 hex string).
2. Modify the `up` function of `test_checksum_001` (change a string constant).
3. Compute new checksum — assert it differs from stored checksum.
4. Run `runner.migrate()` with `MIGRATION_CHECKSUM_ENFORCE=warn` — assert warning logged about mismatch but migration continues (no pending migrations to apply, just warning on comparison).
5. Run `runner.migrate()` with `MIGRATION_CHECKSUM_ENFORCE=fail` — assert error thrown about checksum mismatch.
6. Run `runner.migrate()` with `MIGRATION_CHECKSUM_ENFORCE=ignore` — assert no warning, no error.

**Expected Result**: Checksum enforcement mode controls behavior on mismatch detection.

**Failure Mode**: If checksum computation fails (e.g., function serialization issue), the runner logs a warning and falls back to `ignore` mode.

---

## Unit Test Scenarios

### UNIT-1: MigrationRunner Phase Filtering

**Module**: `MigrationRunner.migrate({ phase })`.

**Input**: 4 migrations: M1 (`pre-deploy`), M2 (`pre-deploy`), M3 (`post-deploy`), M4 (`backfill`). Call `migrate({ phase: 'pre-deploy' })`.

**Expected Output**: Only M1 and M2 are applied. M3 and M4 are skipped. `result.applied` contains M1, M2 versions.

---

### UNIT-2: MigrationRunner Dry-Run Mode

**Module**: `MigrationRunner.migrate({ dryRun: true })`.

**Input**: 2 pending migrations. Each has `dryRunInfo()` that returns `{ collections: ['orders'], estimatedDocuments: 5000, indexChanges: ['add idx_region'] }`.

**Expected Output**: Returns dry-run report with migration details. `_migration_history` is NOT modified. No `up` functions are called.

---

### UNIT-3: Checksum Computation

**Module**: `computeChecksum(migration)`.

**Input**: Migration with `up` function body `async (db) => { await db.collection('x').createIndex({ a: 1 }); }`.

**Expected Output**: Deterministic SHA-256 hex string. Same input always produces same output. Different function body produces different hash.

---

### UNIT-4: Lock TTL Auto-Extension

**Module**: `LockExtender` class.

**Input**: Lock acquired at T=0 with TTL=300s. Extension interval=120s.

**Expected Output**: `extendLock()` called at T=120s, T=240s, etc. Each call updates `expiresAt` to `now + 300s`. Extension stops when `stop()` is called.

---

### UNIT-5: Cross-Service Version Gate

**Module**: `checkRequiredMigrations(requiredVersion, db)`.

**Input Case 1**: `requiredVersion = '20260323_017'`, `_migration_history` contains applied up to `20260323_017`. Expected: returns `{ ready: true }`.

**Input Case 2**: `requiredVersion = '20260323_017'`, `_migration_history` contains applied up to `20260319_016`. Expected: returns `{ ready: false, current: '20260319_016', required: '20260323_017' }`.

**Input Case 3**: `requiredVersion = ''` (empty). Expected: returns `{ ready: true }` (no version requirement).

---

### UNIT-6: Backfill Progress Tracking

**Module**: `BackfillOrchestrator.updateProgress()`.

**Input**: Migration version `test_bf_001`. Batch of 200 documents processed. Previous `totalProcessed = 800`. New `lastCursorId = "abc123"`.

**Expected Output**: `_migration_backfill_progress` updated to `{ totalProcessed: 1000, lastCursorId: "abc123", updatedAt: <now> }`.

---

### UNIT-7: Migration CLI Argument Parsing

**Module**: CLI argument parser in `cli.ts`.

**Input Cases**:

- `migrate` -> command=migrate, phase=all, dryRun=false
- `migrate --phase=pre-deploy` -> command=migrate, phase=pre-deploy
- `migrate --dry-run` -> command=migrate, dryRun=true
- `status` -> command=status
- `rollback 3` -> command=rollback, steps=3
- `rollback` -> command=rollback, steps=1 (default)

**Expected Output**: Parsed arguments match expected values for each case.

---

## Security & Isolation Tests

- [ ] Admin migration API requires `platform-admin` permission — non-admin users get HTTP 403
- [ ] Admin migration API requires authentication — unauthenticated requests get HTTP 401
- [ ] Tenant-scoped backfill only modifies target tenant's documents — cross-tenant data is untouched (INT-4)
- [ ] Migration CLI does not expose database credentials in logs or error messages
- [ ] Checksum mismatch is logged but does not expose migration script contents
- [ ] Backfill progress endpoint does not expose document contents — only aggregate counts
- [ ] Migration validation results do not contain PII — only aggregate counts and boolean pass/fail

---

## Performance & Load Tests

- [ ] **LOAD-1**: Backfill migration on 1M document collection — verify sustained throughput of 5,000+ docs/sec with batch size 500 and 100ms inter-batch delay
- [ ] **LOAD-2**: Lock acquisition under 10 concurrent runners — verify exactly one acquires, others fail gracefully with no deadlock
- [ ] **LOAD-3**: Concurrent reads/writes during migration — verify zero blocked operations on collections being migrated (background index creation)
- [ ] **LOAD-4**: ClickHouse ADD COLUMN on table with 10M rows — verify operation completes in <5 seconds (non-blocking DDL)
- [ ] **LOAD-5**: Backfill progress tracking overhead — verify updating `_migration_backfill_progress` after each batch adds <5ms latency per batch

---

## Test Infrastructure

- **Required services**: MongoDB (replica set for transaction tests, standalone for basic tests), Redis (for BullMQ backfill tests), ClickHouse (for ClickHouse migration tests).
- **Docker Compose**: All services available via existing `docker-compose.yml`. ClickHouse Keeper is included for ReplicatedMergeTree support.
- **Test migrations**: Dedicated test migration scripts in `packages/database/src/__tests__/fixtures/migrations/` — NOT the production migration scripts.
- **Data seeding**: Test fixtures create temporary collections with known data for each test scenario. Cleanup removes test collections after each test.
- **Environment variables**: `MIGRATION_LOCK_TTL_MS=10000` (10s for faster lock expiry tests), `MIGRATION_BACKFILL_BATCH_SIZE=100` (smaller for faster tests), `MIGRATION_BACKFILL_DELAY_MS=10` (minimal delay for test speed).
- **CI configuration**: Integration tests require Docker in CI (MongoDB + Redis + ClickHouse). E2E tests start real servers on random ports.
- **Isolation between test runs**: Each test creates uniquely named collections (e.g., `test_widgets_<randomSuffix>`) and cleans up after itself. Tests do NOT share `_migration_history` state.

---

## Test File Mapping

| Test File                                                                         | Type        | Covers                    |
| --------------------------------------------------------------------------------- | ----------- | ------------------------- |
| `packages/database/src/__tests__/migrations/runner.test.ts` (new)                 | unit        | FR-1, FR-2, FR-3          |
| `packages/database/src/__tests__/migrations/lock.test.ts` (new)                   | unit        | FR-13                     |
| `packages/database/src/__tests__/migrations/checksum.test.ts` (new)               | unit        | FR-5                      |
| `packages/database/src/__tests__/migrations/version-gate.test.ts` (new)           | unit        | FR-9                      |
| `packages/database/src/__tests__/migrations/validator.test.ts` (new)              | unit        | FR-12                     |
| `packages/database/src/__tests__/migrations/cli-args.test.ts` (new)               | unit        | FR-2, FR-3 (CLI parsing)  |
| `packages/database/src/__tests__/migrations/runner.integration.test.ts` (new)     | integration | FR-1, FR-7                |
| `packages/database/src/__tests__/migrations/lock.integration.test.ts` (new)       | integration | FR-13 (INT-2)             |
| `packages/database/src/__tests__/migrations/backfill.integration.test.ts` (new)   | integration | FR-4, FR-8 (INT-3, INT-4) |
| `packages/database/src/__tests__/migrations/clickhouse.integration.test.ts` (new) | integration | FR-6 (INT-5)              |
| `packages/database/src/__tests__/migrations/validation.integration.test.ts` (new) | integration | FR-12 (INT-6)             |
| `packages/database/src/__tests__/migrations/checksum.integration.test.ts` (new)   | integration | FR-5 (INT-7)              |
| `packages/database/src/__tests__/e2e/migration-lifecycle.test.ts` (new)           | e2e         | FR-1, FR-7 (E2E-1, E2E-2) |
| `packages/database/src/__tests__/e2e/backfill-lifecycle.test.ts` (new)            | e2e         | FR-4, FR-8 (E2E-3)        |
| `packages/database/src/__tests__/e2e/concurrent-access.test.ts` (new)             | e2e         | FR-15 (E2E-4)             |
| `packages/database/src/__tests__/e2e/version-gate.test.ts` (new)                  | e2e         | FR-9 (E2E-5)              |
| `packages/database/src/__tests__/e2e/clickhouse-lifecycle.test.ts` (new)          | e2e         | FR-6 (E2E-6)              |
| `apps/admin/src/__tests__/e2e/migration-admin-api.test.ts` (new)                  | e2e         | FR-10 (E2E-7)             |

---

## Open Testing Questions

1. Should integration tests use testcontainers (isolated per test, slower startup) or a shared Docker Compose instance (faster, requires cleanup discipline)?
2. What is the minimum MongoDB replica set configuration needed for transaction tests? Single-node replica set or 3-node cluster?
3. Should the CI pipeline run ClickHouse integration tests on every PR, or only on changes to `packages/database/src/clickhouse-schemas/` and `packages/database/src/migrations/`?
4. How should we test the lock TTL expiry scenario without waiting 5 minutes? Override TTL to 2 seconds for tests, or mock the clock?
5. Should backfill performance tests (LOAD-1) run in CI or only in a dedicated performance testing environment?

---

## Test Coverage Map

### Migration Runner (Existing + Enhanced)

- [ ] Sequential execution applies pending migrations in version order
- [ ] Already-applied migrations are skipped (idempotent)
- [ ] First failure halts execution and records failure in history
- [ ] Skipped migrations (after failure) are reported in result
- [ ] Phase-filtered execution applies only matching phase
- [ ] Dry-run mode reports impact without executing
- [ ] Transaction support used when replica set detected
- [ ] Non-transaction fallback when standalone MongoDB

### Distributed Lock

- [ ] Lock acquired by first runner, rejected for second runner
- [ ] Lock released explicitly after migration
- [ ] Lock auto-expires after TTL on crash
- [ ] Lock extended periodically during long migrations
- [ ] Concurrent upsert race condition handled gracefully (E11000)

### Checksum

- [ ] Deterministic SHA-256 for same function body
- [ ] Different function body produces different checksum
- [ ] Mismatch detected when applied migration script is modified
- [ ] Enforcement mode controls behavior (warn/fail/ignore)

### Backfill Orchestrator

- [ ] Batch processing with configurable batch size
- [ ] Cursor-based pagination (no skip)
- [ ] Progress tracked in `_migration_backfill_progress`
- [ ] Pause/resume via BullMQ job control
- [ ] Resume from last checkpoint cursor
- [ ] Tenant-scoped backfill only modifies target tenant
- [ ] Completion status recorded after all batches

### ClickHouse Runner

- [ ] Version tracking in ClickHouse `_migration_history` table
- [ ] ADD COLUMN IF NOT EXISTS is idempotent
- [ ] Destructive operations gated by `--allow-destructive`
- [ ] Status query returns all migration versions with state

### Validation Framework

- [ ] Validation queries execute after migration
- [ ] Pass/fail results stored in `_migration_validation_results`
- [ ] Aggregate counts reported (no PII exposure)
- [ ] Failed validation reports specific check details

### Cross-Service Version Gate

- [ ] Service starts when required version is applied
- [ ] Service refuses/degrades when required version is missing
- [ ] Empty required version always passes
- [ ] Health endpoint reports migration state

### Admin API

- [ ] Migration status endpoint returns all versions with metadata
- [ ] Backfill progress endpoint returns active/completed jobs
- [ ] Pause/resume endpoints control BullMQ jobs
- [ ] Health endpoint aggregates service migration state
- [ ] RBAC enforced: only platform-admin can access

### What the Current Coverage Actually Proves

- [ ] **Nothing automated.** All current validation is manual CLI execution in dev/prod.
- [ ] The runner works end-to-end (manual proof from 18 successful production migrations)
- [ ] The lock prevents concurrent execution (manual proof from multi-pod deployments)
- [ ] Rollback works for the subset of migrations with meaningful `down` functions

---

## Pending / Future Work

- [ ] Add unit tests for existing MigrationRunner (phase 1 prerequisite)
- [ ] Add unit tests for existing lock.ts (phase 1 prerequisite)
- [ ] Add integration tests for runner with real MongoDB
- [ ] Add integration tests for lock contention with real MongoDB
- [ ] Add unit tests for phase filtering (after phase metadata is implemented)
- [ ] Add unit tests for dry-run mode (after dry-run is implemented)
- [ ] Add unit tests for checksum computation
- [ ] Add integration tests for backfill orchestrator with real MongoDB + Redis
- [ ] Add integration tests for tenant-scoped backfill
- [ ] Add integration tests for ClickHouse runner with real ClickHouse
- [ ] Add integration tests for validation framework
- [ ] Add E2E tests for full migration lifecycle via CLI
- [ ] Add E2E tests for concurrent access during migration
- [ ] Add E2E tests for cross-service version gate
- [ ] Add E2E tests for admin API endpoints
- [ ] Add load tests for backfill throughput on large collections
- [ ] Add CI migration lint as a required check

---

## References

- Related feature doc: [docs/features/database-migrations.md](../features/database-migrations.md)
- Existing migration runner: `packages/database/src/migrations/runner.ts`
- Existing migration CLI: `packages/database/src/migrations/cli.ts`
- Existing migration lock: `packages/database/src/migrations/lock.ts`
- Existing migration scripts: `packages/database/src/migrations/scripts/`
- Existing ClickHouse schemas: `packages/database/src/clickhouse-schemas/`
