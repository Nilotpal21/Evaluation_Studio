# Testing Guide: Data Retention / TTL Policies

**Feature**: [Data Retention / TTL Policies](../features/data-retention-ttl.md)
**Status**: NOT STARTED
**Last Updated**: 2026-03-23

---

## 1. Quick Health Dashboard

| Area                                                 | Status     | Last Verified | Notes                        |
| ---------------------------------------------------- | ---------- | ------------- | ---------------------------- |
| Retention policy engine (resolution chain)           | NOT TESTED | -             | No implementation exists yet |
| Data classification manifest                         | NOT TESTED | -             | No implementation exists yet |
| Plan-tier default policies (free/pro/enterprise)     | NOT TESTED | -             | No implementation exists yet |
| Regulatory minimum enforcement                       | NOT TESTED | -             | No implementation exists yet |
| Admin retention policy CRUD API                      | NOT TESTED | -             | No implementation exists yet |
| Admin legal hold CRUD API                            | NOT TESTED | -             | No implementation exists yet |
| Admin erasure request API                            | NOT TESTED | -             | No implementation exists yet |
| Studio tenant retention settings                     | NOT TESTED | -             | No implementation exists yet |
| MongoDB retention enforcement worker                 | NOT TESTED | -             | No implementation exists yet |
| ClickHouse retention enforcement worker              | NOT TESTED | -             | No implementation exists yet |
| Redis retention enforcement worker                   | NOT TESTED | -             | No implementation exists yet |
| S3 lifecycle policy generation                       | NOT TESTED | -             | No implementation exists yet |
| Qdrant point deletion worker                         | NOT TESTED | -             | No implementation exists yet |
| GDPR erasure cascade (cross-layer)                   | NOT TESTED | -             | No implementation exists yet |
| Legal hold enforcement (deletion suspension)         | NOT TESTED | -             | No implementation exists yet |
| Archival pipeline (hot -> cold -> archive -> delete) | NOT TESTED | -             | No implementation exists yet |
| Deletion audit trail (ClickHouse retention_events)   | NOT TESTED | -             | No implementation exists yet |
| Retention dashboard (admin portal)                   | NOT TESTED | -             | No implementation exists yet |
| Enforcement worker observability (metrics, alerts)   | NOT TESTED | -             | No implementation exists yet |
| Tenant isolation for retention policies              | NOT TESTED | -             | No implementation exists yet |
| Dry-run mode                                         | NOT TESTED | -             | No implementation exists yet |
| Idempotent enforcement restart                       | NOT TESTED | -             | No implementation exists yet |

---

## 2. Coverage Matrix

| FR    | Description                                              | Unit | Integration | E2E | Manual | Status     |
| ----- | -------------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | RetentionPolicy data model (tenant/project/class scoped) | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-2  | Plan-based default retention tiers                       | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-3  | Policy resolution precedence chain                       | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-4  | LegalHold data model with lifecycle                      | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-5  | Legal hold suspends deletion                             | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-6  | Enforcement workers on configurable intervals            | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-7  | MongoDB batched deletion with rate limiting              | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-8  | ClickHouse TTL enforcement (ALTER TABLE ... MODIFY TTL)  | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-9  | Redis SCAN-based expiration + BullMQ clean               | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-10 | S3 lifecycle policy generation                           | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-11 | Immutable retention_event audit trail                    | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-12 | GDPR erasure cascade API                                 | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-13 | Archival pipeline with grace period                      | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-14 | Admin retention policy CRUD with RBAC                    | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-15 | Retention dashboard (enforcement, storage, holds)        | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-16 | Regulatory minimum validation                            | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-17 | DEK lifecycle coordination on deletion                   | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-18 | DATA_CLASSIFICATION_MANIFEST for all collections/tables  | NO   | NO          | NO  | NO     | NOT TESTED |

---

## 3. Test Inventory

### Unit Tests

None currently exist. Planned unit test files:

| File (planned)                                                   | Scenarios | Coverage Area                                |
| ---------------------------------------------------------------- | --------- | -------------------------------------------- |
| `packages/shared/src/__tests__/retention/policy-engine.test.ts`  | ~15       | Precedence chain, plan defaults, reg. mins   |
| `packages/shared/src/__tests__/retention/classification.test.ts` | ~8        | Manifest completeness, classification lookup |
| `apps/runtime/src/__tests__/retention-scheduler.test.ts`         | ~6        | Scheduler job creation, tenant enumeration   |
| `apps/runtime/src/__tests__/retention-mongodb-worker.test.ts`    | ~10       | Batch deletion, cursor, hold check, dry-run  |
| `apps/runtime/src/__tests__/retention-clickhouse-worker.test.ts` | ~6        | Mutation generation, off-peak scheduling     |
| `apps/runtime/src/__tests__/retention-redis-worker.test.ts`      | ~6        | SCAN pattern, BullMQ clean, rate-limit keys  |
| `apps/runtime/src/__tests__/retention-s3-worker.test.ts`         | ~4        | Lifecycle rule generation, prefix mapping    |
| `apps/runtime/src/__tests__/legal-hold-expiry-worker.test.ts`    | ~4        | Auto-release expired holds                   |
| `apps/runtime/src/__tests__/erasure-cascade-worker.test.ts`      | ~8        | Per-layer cascade, crypto-shredding call     |

### Integration Tests

None currently exist. Planned integration test files:

| File (planned)                                                                    | Scenarios | Coverage Area                               |
| --------------------------------------------------------------------------------- | --------- | ------------------------------------------- |
| `apps/runtime/src/__tests__/integration/retention-mongodb-enforcement.test.ts`    | ~8        | Real MongoMemoryServer batched deletion     |
| `apps/runtime/src/__tests__/integration/retention-clickhouse-enforcement.test.ts` | ~6        | Real ClickHouse test instance mutation      |
| `apps/runtime/src/__tests__/integration/retention-redis-enforcement.test.ts`      | ~6        | Real Redis SCAN + BullMQ clean              |
| `apps/runtime/src/__tests__/integration/retention-archival.test.ts`               | ~5        | MongoDB -> S3 archival + restore            |
| `apps/runtime/src/__tests__/integration/retention-policy-resolution.test.ts`      | ~8        | Full resolution chain with real DB policies |
| `apps/runtime/src/__tests__/integration/erasure-cascade.test.ts`                  | ~6        | Cross-layer cascade with real backends      |

### E2E Tests

None currently exist. See Section 4 below for mandatory E2E scenarios.

---

## 4. E2E Test Scenarios (Mandatory -- minimum 5)

### E2E-1: MongoDB TTL Enforcement Lifecycle

**Objective**: Verify that the retention enforcement worker correctly identifies expired MongoDB documents, respects tenant-specific retention policies, executes batched deletion, and records deletion audit events.

**Prerequisites**: Running admin server and runtime with MongoDB, ClickHouse, and Redis. Authenticated admin user. Two tenants: Tenant A (30-day session retention) and Tenant B (180-day session retention).

**Steps**:

1. POST `/api/admin/retention-policies` to create Tenant A policy: `{ tenantId: "tenant-a", dataClassification: "operational", retentionDays: 30 }`
2. POST `/api/admin/retention-policies` to create Tenant B policy: `{ tenantId: "tenant-b", dataClassification: "operational", retentionDays: 180 }`
3. Seed 50 sessions for Tenant A with `lastActivityAt` = 35 days ago (expired under 30-day policy)
4. Seed 50 sessions for Tenant B with `lastActivityAt` = 35 days ago (NOT expired under 180-day policy)
5. POST `/api/admin/retention/enforcement-runs/trigger` with `{ storageLayer: "mongodb", dataClassification: "operational" }`
6. Poll `GET /api/admin/retention/enforcement-runs` until the run completes
7. Verify: Tenant A sessions are deleted (GET returns 0 sessions older than 30 days)
8. Verify: Tenant B sessions are untouched (GET returns all 50 sessions)
9. Query ClickHouse `retention_events` table to verify deletion audit events exist for Tenant A with correct `record_count`, `data_hash`, and `policy_id`
10. Verify the enforcement run record shows `status: 'completed'`, `recordsDeleted: 50`, `recordsSkippedHold: 0`

**Expected Result**: Only Tenant A's expired sessions are deleted. Tenant B's sessions with the same age remain because their tenant policy allows 180 days. Deletion is audited in ClickHouse.

**Validates**: FR-1, FR-2, FR-3, FR-7, FR-11

---

### E2E-2: Legal Hold Prevents Deletion

**Objective**: Verify that creating a legal hold on a tenant prevents retention enforcement from deleting any data for that tenant, and that releasing the hold allows deletion to resume.

**Prerequisites**: Running admin server with MongoDB and ClickHouse. Authenticated admin user with `legal-hold:manage` permission. Tenant with expired data.

**Steps**:

1. POST `/api/admin/retention-policies` to create a policy: `{ tenantId: "tenant-held", dataClassification: "operational", retentionDays: 7 }`
2. Seed 100 sessions for `tenant-held` with `lastActivityAt` = 14 days ago (expired)
3. POST `/api/admin/legal-holds` with `{ tenantId: "tenant-held", holdType: "litigation", reason: "Case #12345", caseReference: "CASE-12345" }`
4. Assert 201 response with `status: 'active'`
5. POST `/api/admin/retention/enforcement-runs/trigger` with `{ storageLayer: "mongodb", dataClassification: "operational" }`
6. Wait for enforcement run to complete
7. Verify: All 100 sessions still exist (legal hold prevented deletion)
8. Verify: Enforcement run shows `recordsSkippedHold: 100`, `recordsDeleted: 0`
9. Verify: `retention_events` in ClickHouse contain `hold_skipped` events
10. DELETE `/api/admin/legal-holds/:holdId/release` with `{ releaseReason: "Case settled" }`
11. Assert the hold status changes to `released` with `releasedAt` and `releasedBy` populated
12. POST `/api/admin/retention/enforcement-runs/trigger` again
13. Wait for enforcement run to complete
14. Verify: All 100 expired sessions are now deleted
15. Verify: Enforcement run shows `recordsDeleted: 100`, `recordsSkippedHold: 0`

**Expected Result**: Legal hold completely prevents deletion. After release, next enforcement run deletes the expired data. Both the hold and the eventual deletion are fully audited.

**Validates**: FR-4, FR-5, FR-7, FR-11

---

### E2E-3: Tenant-Scoped Policy Isolation

**Objective**: Verify that retention policies are tenant-isolated: Tenant A cannot view, modify, or be affected by Tenant B's policies. Cross-tenant API access returns 404.

**Prerequisites**: Running admin server with MongoDB. Two authenticated tenant-admin users (Tenant A and Tenant B).

**Steps**:

1. As admin, POST `/api/admin/retention-policies` for Tenant A: `{ tenantId: "tenant-a", dataClassification: "analytics", retentionDays: 90 }`
2. As admin, POST `/api/admin/retention-policies` for Tenant B: `{ tenantId: "tenant-b", dataClassification: "analytics", retentionDays: 365 }`
3. As Tenant A user, GET `/api/retention-policies` -- assert only Tenant A's policy is returned
4. As Tenant B user, GET `/api/retention-policies` -- assert only Tenant B's policy is returned
5. As Tenant A user, attempt PUT `/api/retention-policies/analytics` with a different `tenantId` in the body -- assert 404 or 403 (not 200)
6. As Tenant A user, GET `/api/retention/enforcement-history` -- assert only Tenant A's runs are returned
7. Verify that the effective retention for Tenant A's analytics is 90 days (not Tenant B's 365)
8. As unauthenticated user, GET `/api/retention-policies` -- assert 401
9. As regular member (not tenant-admin), PUT `/api/retention-policies/analytics` -- assert 403

**Expected Result**: Complete tenant isolation. Each tenant sees only their own policies. Cross-tenant access is blocked. RBAC is enforced.

**Validates**: FR-1, FR-3, FR-14

---

### E2E-4: GDPR Erasure Cascade Across All Storage Layers

**Objective**: Verify that a GDPR right-to-erasure request cascades deletion across all storage layers (MongoDB, ClickHouse, Redis) and integrates with crypto-shredding.

**Prerequisites**: Running admin server, runtime, with MongoDB, ClickHouse, and Redis. A contact with data in multiple storage layers. Encryption enabled with `ENCRYPTION_MASTER_KEY` configured.

**Steps**:

1. Seed data for contact `contact-123` in tenant `tenant-gdpr`:
   - 5 MongoDB sessions with `contactId: "contact-123"`
   - 20 MongoDB messages across those sessions with `contactId: "contact-123"`
   - 50 rows in ClickHouse `messages` table with `contact_id = "contact-123"`
   - 10 rows in ClickHouse `platform_events` table referencing `contact-123` in metadata
   - Redis cache keys `session:tenant-gdpr:contact-123:*` (3 keys)
2. POST `/api/admin/erasure-requests` with `{ tenantId: "tenant-gdpr", contactId: "contact-123", requestType: "right_to_erasure" }`
3. Assert 202 response with request ID and `status: 'pending'`, `deadline` set to 30 days from now
4. Poll GET `/api/admin/erasure-requests/:requestId` until `status: 'completed'`
5. Verify MongoDB: No sessions exist with `contactId: "contact-123"` in `tenant-gdpr`
6. Verify MongoDB: No messages exist for the deleted sessions
7. Verify ClickHouse: `SELECT count() FROM messages WHERE contact_id = 'contact-123' AND tenant_id = 'tenant-gdpr'` returns 0
8. Verify Redis: `SCAN` for `session:tenant-gdpr:contact-123:*` returns 0 keys
9. Verify the erasure request record shows per-layer completion: `layers: [{ storageLayer: 'mongodb', status: 'completed', recordsDeleted: 25 }, { storageLayer: 'clickhouse', status: 'completed', recordsDeleted: 60 }, { storageLayer: 'redis', status: 'completed', recordsDeleted: 3 }]`
10. Verify `cryptoShredded: true` on the erasure request (crypto-shredding was invoked)
11. Verify a consolidated `retention_event` of type `erasure` exists in ClickHouse with the request details

**Expected Result**: All data associated with the contact is deleted across every storage layer. Crypto-shredding renders any remaining encrypted data irrecoverable. Full audit trail exists.

**Validates**: FR-12, FR-11, FR-17

---

### E2E-5: Archival Pipeline with Grace Period Restore

**Objective**: Verify that expired data is archived to cold storage before deletion, and that archived data can be restored within the grace period but is permanently deleted after the grace period expires.

**Prerequisites**: Running admin server and runtime with MongoDB and S3 (or S3-compatible storage like MinIO). Archival enabled (`RETENTION_ARCHIVAL_ENABLED=true`, `RETENTION_ARCHIVAL_GRACE_DAYS=1` for fast testing).

**Steps**:

1. POST `/api/admin/retention-policies` to create policy: `{ tenantId: "tenant-archive", dataClassification: "operational", retentionDays: 7, archivalDays: 5 }`
2. Seed 20 sessions for `tenant-archive` with `lastActivityAt` = 6 days ago (past archival threshold, before deletion threshold)
3. POST `/api/admin/retention/enforcement-runs/trigger` with `{ storageLayer: "mongodb", dataClassification: "operational" }`
4. Wait for enforcement run to complete
5. Verify: Sessions are no longer in the active MongoDB collection (or have `archivedAt` set)
6. Verify: Archived data exists in S3 under the archive prefix (`archives/tenant-archive/sessions/`)
7. Verify: `retention_events` show `archival` events with record count and S3 location
8. POST `/api/admin/retention/restore` with `{ tenantId: "tenant-archive", archiveId: "<from step 6>", reason: "Accidental policy misconfiguration" }`
9. Verify: Restored sessions are back in MongoDB with original data intact
10. Seed 20 more sessions with `lastActivityAt` = 8 days ago (past deletion threshold)
11. Trigger enforcement again
12. Verify: These sessions are archived first, then after the grace period (simulated via time manipulation or reduced `RETENTION_ARCHIVAL_GRACE_DAYS`), permanently deleted
13. Verify: Permanent deletion events are recorded in `retention_events`
14. Attempt to restore after grace period -- assert 410 Gone or appropriate error

**Expected Result**: Data follows the lifecycle: active -> archived -> permanently deleted. Restoration is possible within the grace period. After grace period, data is unrecoverable.

**Validates**: FR-13, FR-11

---

### E2E-6: Admin Retention Dashboard Data Accuracy

**Objective**: Verify that the admin retention dashboard APIs return accurate data for policy overview, enforcement history, storage utilization, and legal hold status.

**Prerequisites**: Running admin server with MongoDB and ClickHouse. Multiple tenants with different policies, enforcement runs, and legal holds already seeded.

**Steps**:

1. Seed retention policies for 3 tenants with different classifications and retention periods
2. Seed 5 enforcement runs with varying statuses (completed, partial, failed)
3. Seed 2 legal holds (1 active, 1 released)
4. Seed 1 erasure request (completed)
5. GET `/api/admin/retention-policies` -- verify all 3 tenants' policies are returned with correct fields
6. GET `/api/admin/retention/enforcement-runs` -- verify all 5 runs are returned with correct status, counts, and timestamps
7. GET `/api/admin/legal-holds` -- verify both holds are returned with correct status
8. GET `/api/admin/erasure-requests` -- verify the completed request is returned with per-layer details
9. GET `/api/admin/retention/storage-utilization` -- verify storage breakdown by classification is returned
10. GET `/api/admin/retention/deletion-forecast` -- verify upcoming deletion estimates are returned

**Expected Result**: All dashboard APIs return accurate, tenant-scoped data. The responses are consistent with the seeded data.

**Validates**: FR-14, FR-15

---

### E2E-7: Concurrent Legal Hold and Enforcement Race Condition

**Objective**: Verify that a legal hold created during an active enforcement run is respected for subsequent batches within the same run.

**Prerequisites**: Running admin server with MongoDB. Large dataset (1,000+ expired sessions) to ensure multi-batch enforcement.

**Steps**:

1. Create retention policy for `tenant-race` with 7-day retention
2. Seed 2,000 expired sessions (14 days old) for `tenant-race`
3. Trigger enforcement run (will process in batches of 1,000)
4. While the first batch is processing, create a legal hold on `tenant-race`
5. Wait for enforcement run to complete
6. Verify: The first batch was deleted (up to 1,000 sessions), but the second batch was skipped due to the mid-run legal hold
7. Verify: Enforcement run shows both `recordsDeleted` > 0 AND `recordsSkippedHold` > 0
8. Verify: `retention_events` show both `deletion` events (first batch) and `hold_skipped` events (second batch)

**Expected Result**: Legal holds are checked per-batch, not per-run. A hold created mid-enforcement is respected for all subsequent batches.

**Validates**: FR-5, FR-7

---

## 5. Integration Test Scenarios (Mandatory -- minimum 5)

### INT-1: MongoDB Batched Deletion with Cursor Recovery

**Objective**: Verify that the MongoDB retention worker processes deletions in batches, tracks cursor progress, and correctly resumes after a simulated crash.

**Prerequisites**: MongoMemoryServer with seeded expired data.

**Steps**:

1. Start MongoMemoryServer, seed 5,000 expired sessions for a tenant
2. Configure batch size = 500
3. Start the retention MongoDB worker
4. After 2 batches (1,000 records deleted), simulate a crash by stopping the worker
5. Verify: `retention_enforcement_runs` record shows `status: 'partial'`, `lastProcessedId` set, `recordsDeleted: 1000`
6. Restart the worker with the same enforcement run ID
7. Verify: Worker resumes from `lastProcessedId`, not from the beginning
8. Wait for completion
9. Verify: All 5,000 records are deleted, total `recordsDeleted: 5000`
10. Verify: No duplicate deletion attempts (each record processed exactly once)

**Validates**: FR-7, idempotent enforcement

---

### INT-2: ClickHouse Tenant-Specific Mutation

**Objective**: Verify that the ClickHouse retention worker generates correct `ALTER TABLE ... DELETE` mutations for tenants with non-default retention and schedules them during off-peak hours.

**Prerequisites**: ClickHouse test instance with seeded data across multiple tenants.

**Steps**:

1. Seed ClickHouse `platform_events` table with 10,000 rows across 3 tenants, with `timestamp` ranging from 10 days to 400 days ago
2. Configure Tenant A with 30-day analytics retention, Tenant B with 365-day retention, Tenant C with platform default (730 days)
3. Set `RETENTION_CLICKHOUSE_OFF_PEAK_HOURS` to include the current hour
4. Trigger ClickHouse enforcement worker
5. Verify: `ALTER TABLE ... DELETE WHERE tenant_id = 'tenant-a' AND toDateTime(timestamp) < now() - INTERVAL 30 DAY` is executed
6. Verify: No mutation is issued for Tenant C (using platform default TTL, handled by native ClickHouse TTL)
7. Query `system.mutations` to verify mutations are submitted and eventually complete
8. After mutations complete, verify row counts match expected retention

**Validates**: FR-8

---

### INT-3: Redis SCAN-Based Key Expiration and BullMQ Cleanup

**Objective**: Verify that the Redis retention worker correctly identifies and expires non-TTL keys matching retention patterns, and cleans BullMQ completed/failed jobs.

**Prerequisites**: Redis test instance with seeded keys and BullMQ queues.

**Steps**:

1. Seed Redis with:
   - 50 `session:tenant-a:*` keys without TTL (simulating leaked keys)
   - 30 `cache:tenant-a:*` keys with TTL already set (should be left alone)
   - 100 completed BullMQ jobs older than 24 hours in the `llm-requests` queue
   - 50 failed BullMQ jobs older than 7 days in the `llm-requests` queue
2. Configure operational data retention: 30 days for sessions, 1 day for completed jobs, 7 days for failed jobs
3. Trigger Redis enforcement worker
4. Verify: All 50 `session:*` keys now have a TTL set (using `TTL` command)
5. Verify: The 30 `cache:*` keys are untouched (already had TTL)
6. Verify: BullMQ completed jobs older than 24 hours are cleaned
7. Verify: BullMQ failed jobs older than 7 days are cleaned
8. Verify: `retention_events` are emitted with correct counts

**Validates**: FR-9

---

### INT-4: Policy Resolution Precedence Chain with Real Database

**Objective**: Verify that the retention policy engine correctly resolves the effective retention period using the full precedence chain with real database-backed policies.

**Prerequisites**: MongoMemoryServer with seeded policies at multiple levels.

**Steps**:

1. Seed the following policies in MongoDB:
   - Platform default: `{ planTier: "free", dataClassification: "operational", retentionDays: 30, isDefault: true }`
   - Platform default: `{ planTier: "enterprise", dataClassification: "operational", retentionDays: 730, isDefault: true }`
   - Tenant-level override: `{ tenantId: "tenant-a", dataClassification: "operational", retentionDays: 180 }`
   - Project-level override: `{ tenantId: "tenant-a", projectId: "project-1", dataClassification: "operational", retentionDays: 90 }`
2. Resolve effective retention for `(tenant-a, project-1, operational)` -- expect 90 days (project override wins)
3. Resolve effective retention for `(tenant-a, project-2, operational)` -- expect 180 days (tenant override, no project override)
4. Resolve effective retention for `(tenant-b, project-3, operational)` on free plan -- expect 30 days (plan default)
5. Resolve effective retention for `(tenant-c, project-4, operational)` on enterprise plan -- expect 730 days (plan default)
6. Attempt to create a policy with `retentionDays: 100` for `dataClassification: "audit"` (regulatory minimum: 365 days) -- expect rejection with validation error
7. Verify that `effectiveFrom` and `effectiveUntil` are respected: create a policy with `effectiveFrom` in the future, verify it does not affect current resolution

**Validates**: FR-3, FR-16

---

### INT-5: Archival to S3 and Restoration

**Objective**: Verify that the archival worker correctly exports MongoDB documents to S3, removes them from the active collection, and that the restore API re-imports them.

**Prerequisites**: MongoMemoryServer, S3-compatible storage (MinIO).

**Steps**:

1. Seed 100 sessions in MongoMemoryServer for `tenant-archive` with `lastActivityAt` = 40 days ago
2. Create archival policy: `archivalDays: 30` (so 40-day-old data qualifies)
3. Trigger archival worker
4. Verify: Sessions are removed from the active MongoDB `sessions` collection
5. Verify: S3 contains a compressed JSON archive at `archives/tenant-archive/sessions/<date>/batch-001.json.gz`
6. Verify: Archive metadata is recorded in `retention_enforcement_runs` with `recordsArchived: 100`
7. Download and decompress the S3 archive, verify it contains all 100 session documents with correct field values (including encrypted fields)
8. Call the restore API with the archive ID
9. Verify: All 100 sessions are re-inserted into the active MongoDB collection
10. Verify: Restored sessions have identical `_id` values and field data
11. Verify: A `restoration` event is emitted to ClickHouse `retention_events`

**Validates**: FR-13

---

### INT-6: GDPR Erasure with Crypto-Shredding Integration

**Objective**: Verify that the erasure cascade worker integrates with the encryption-at-rest crypto-shredding mechanism to render contact data irrecoverable.

**Prerequisites**: MongoMemoryServer, Redis, `ENCRYPTION_MASTER_KEY` configured, contact with encrypted data.

**Steps**:

1. Seed a contact `contact-456` in `tenant-gdpr` with `encryptionSalt` set
2. Seed 5 encrypted sessions and 20 encrypted messages for this contact
3. Verify: Messages can be decrypted via the encryption service (using the contact's derived key)
4. Trigger erasure cascade for `contact-456`
5. Verify: The contact's `encryptionSalt` is deleted from the contacts collection
6. Verify: Attempting to derive the contact's encryption key now fails (salt is gone)
7. If any encrypted data remnants exist in ClickHouse (before mutation completes), verify they are undecryptable: `decryptForContact` returns null sentinel
8. Verify: `cryptoShredded: true` is set on the erasure request

**Validates**: FR-12, FR-17

---

## 6. How to Run

```bash
# Unit tests (once implemented)
pnpm build --filter=@agent-platform/shared && pnpm test --filter=@agent-platform/shared -- src/__tests__/retention/

# Retention worker unit tests
pnpm build --filter=runtime && pnpm test --filter=runtime -- src/__tests__/retention-

# Integration tests (requires MongoMemoryServer, real Redis)
pnpm build --filter=runtime && pnpm test --filter=runtime -- src/__tests__/integration/retention-

# E2E tests (requires running admin server, runtime, MongoDB, ClickHouse, Redis)
pnpm build --filter=admin && pnpm test --filter=admin -- src/__tests__/retention-
pnpm build --filter=admin && pnpm test --filter=admin -- src/__tests__/legal-holds-
pnpm build --filter=admin && pnpm test --filter=admin -- src/__tests__/erasure-cascade-

# All retention tests
pnpm build && pnpm test -- --filter='*retention*'
```

---

## 7. Test Data Seeding

### Retention Policy Seed Data

```typescript
// Plan-tier defaults
const FREE_DEFAULTS = [
  { planTier: 'free', dataClassification: 'operational', retentionDays: 30, isDefault: true },
  { planTier: 'free', dataClassification: 'pii', retentionDays: 30, isDefault: true },
  { planTier: 'free', dataClassification: 'analytics', retentionDays: 90, isDefault: true },
  { planTier: 'free', dataClassification: 'audit', retentionDays: 365, isDefault: true },
  { planTier: 'free', dataClassification: 'configuration', retentionDays: 365, isDefault: true },
  { planTier: 'free', dataClassification: 'files', retentionDays: 30, isDefault: true },
];

const ENTERPRISE_DEFAULTS = [
  {
    planTier: 'enterprise',
    dataClassification: 'operational',
    retentionDays: 730,
    isDefault: true,
  },
  { planTier: 'enterprise', dataClassification: 'pii', retentionDays: 365, isDefault: true },
  { planTier: 'enterprise', dataClassification: 'analytics', retentionDays: 730, isDefault: true },
  { planTier: 'enterprise', dataClassification: 'audit', retentionDays: 2555, isDefault: true }, // 7 years
  {
    planTier: 'enterprise',
    dataClassification: 'configuration',
    retentionDays: 2555,
    isDefault: true,
  },
  { planTier: 'enterprise', dataClassification: 'files', retentionDays: 730, isDefault: true },
];

// Regulatory minimums
const REGULATORY_MINIMUMS = {
  audit: 365, // 1 year minimum for audit logs
  pii: 0, // no minimum (GDPR prefers shorter)
  operational: 0,
  analytics: 0,
  configuration: 30, // 30-day minimum for config (recovery)
  files: 0,
};
```

### Session Seed Data Generator

```typescript
function seedExpiredSessions(tenantId: string, count: number, daysAgo: number) {
  const sessions = [];
  for (let i = 0; i < count; i++) {
    sessions.push({
      _id: uuidv7(),
      tenantId,
      projectId: 'project-1',
      status: 'ended',
      lastActivityAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
      startedAt: new Date(Date.now() - (daysAgo + 1) * 24 * 60 * 60 * 1000),
      endedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000),
    });
  }
  return sessions;
}
```

---

## 8. Edge Cases and Failure Scenarios

| #   | Scenario                                                       | Expected Behavior                                                          |
| --- | -------------------------------------------------------------- | -------------------------------------------------------------------------- |
| 1   | Enforcement worker crashes mid-batch                           | Next run resumes from `lastProcessedId`, no data loss or duplicate deletes |
| 2   | Legal hold created during active enforcement run               | Hold respected from next batch onward within the same run                  |
| 3   | ClickHouse unavailable during enforcement                      | Worker skips ClickHouse, processes other layers, retries next cycle        |
| 4   | Retention policy updated during active enforcement             | Current run uses policy snapshot at start; next run uses updated policy    |
| 5   | Two enforcement runs triggered simultaneously                  | Redis distributed lock prevents concurrent runs; second job waits or skips |
| 6   | Erasure request for non-existent contact                       | Request completes with `recordsDeleted: 0` per layer, no error             |
| 7   | Policy with `retentionDays: 0`                                 | Rejected by validation (minimum 1 day or regulatory minimum)               |
| 8   | Tenant deleted while enforcement is running                    | Worker detects missing tenant, marks run as `completed` with 0 records     |
| 9   | S3 bucket unreachable during archival                          | Archival fails, data remains in hot storage, retried next cycle            |
| 10  | Legal hold with `expiresAt` in the past                        | Auto-release worker marks hold as `expired`, next enforcement proceeds     |
| 11  | Multiple legal holds on same tenant (one released, one active) | Data remains held as long as ANY hold is active                            |
| 12  | Project-level policy conflicts with tenant-level policy        | Project-level wins (more specific scope), regardless of which is longer    |
| 13  | Encrypted data archived, then encryption key rotated           | Archived data must be re-encrypted or decryptable with previous key chain  |
| 14  | Erasure request deadline approaching (< 7 days)                | Alert fired, request escalated in dashboard                                |
| 15  | Enforcement deletes last data using a DEK epoch                | Event emitted; DEK lifecycle worker checks and destroys orphaned epoch     |

---

## 9. Performance Testing Guidelines

| Test                                     | Target                               | Method                                       |
| ---------------------------------------- | ------------------------------------ | -------------------------------------------- |
| MongoDB batch deletion throughput        | 10,000 records/minute at batch=1000  | Seed 100K records, measure deletion rate     |
| ClickHouse mutation completion time      | < 30 minutes for 1M rows per tenant  | Seed 1M rows, trigger tenant-specific DELETE |
| Redis SCAN throughput                    | 50,000 keys/minute with count=100    | Seed 100K keys, measure SCAN + EXPIRE rate   |
| Enforcement worker memory footprint      | < 256MB RSS per worker               | Monitor during 100K-record enforcement run   |
| Concurrent tenant enforcement            | 100 tenants processed per hour       | Seed 100 tenants with mixed policies         |
| Erasure cascade latency (single contact) | < 5 minutes for typical contact data | Seed contact with data across all layers     |
| Policy resolution latency                | < 5ms per resolution                 | Benchmark with 1,000 policies in DB          |
| Dashboard API response time              | < 500ms for enforcement history page | With 10,000 enforcement run records          |

---

## 10. Compliance Verification Checklist

| #   | Compliance Requirement                          | How to Verify                                                                 |
| --- | ----------------------------------------------- | ----------------------------------------------------------------------------- |
| 1   | GDPR Art. 17: Right to erasure within 30 days   | Create erasure request, verify completion within deadline                     |
| 2   | GDPR Art. 5(1)(e): Storage limitation principle | Verify data deleted per policy; no indefinite retention without justification |
| 3   | SOC 2 CC6.5: Data disposal controls             | Verify deletion audit trail in `retention_events` with cryptographic hash     |
| 4   | SOC 2 CC7.2: System monitoring                  | Verify enforcement metrics and alerts are operational                         |
| 5   | Legal hold preservation                         | Verify held data survives enforcement runs until hold is released             |
| 6   | Audit trail immutability                        | Verify `retention_events` cannot be modified after insertion                  |
| 7   | Regulatory minimum enforcement                  | Attempt to set audit log retention < 1 year; verify rejection                 |
| 8   | Deletion proof for auditors                     | Export `retention_events` for a tenant, verify record counts and hashes       |
| 9   | HIPAA: PHI retention (if applicable)            | Verify healthcare tenants have 6-year minimum on PII classification           |
| 10  | Encryption key lifecycle on deletion            | Verify DEK epochs are destroyed after last referencing data is deleted        |
