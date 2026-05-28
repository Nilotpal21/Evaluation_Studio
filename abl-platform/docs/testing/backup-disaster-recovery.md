# Testing Guide: Backup & Disaster Recovery

**Feature**: [Backup & Disaster Recovery](../features/backup-disaster-recovery.md)
**Status**: NOT STARTED
**Last Updated**: 2026-03-23

---

## Quick Health Dashboard

| Area                         | Status      | Notes                                      |
| ---------------------------- | ----------- | ------------------------------------------ |
| Unit tests                   | NOT STARTED | No tests exist yet (PLANNED feature)       |
| Integration tests            | NOT STARTED | Requires MongoDB, Redis, ClickHouse, MinIO |
| E2E tests                    | NOT STARTED | Requires full stack + S3 storage           |
| Manual validation            | NOT STARTED | DR failover requires manual validation     |
| Backup verification pipeline | NOT STARTED | Automated restore-to-scratch not yet built |
| DR drill results             | NOT STARTED | No DR drills executed yet                  |

---

## 1. Coverage Matrix

| FR    | Description                                        | Unit | Integration | E2E | Manual | Status     |
| ----- | -------------------------------------------------- | ---- | ----------- | --- | ------ | ---------- |
| FR-1  | Automated scheduled backups (MongoDB/Redis/CH)     | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-2  | Backup artifact encryption via KMS                 | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-3  | MongoDB PITR (oplog archiving + replay)            | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-4  | Tenant-scoped backup isolation                     | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-5  | Tenant-scoped restore operations                   | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-6  | Cross-region backup replication                    | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-7  | Automated backup verification (restore-to-scratch) | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-8  | Configurable retention policies with S3 lifecycle  | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-9  | Audit log events for backup/restore operations     | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-10 | Backup monitoring and alerting                     | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-11 | On-demand backup with rate limiting                | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-12 | DR orchestration API (failover/rollback)           | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-13 | GDPR backup erasure (crypto-shredding)             | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-14 | Backup metadata tracking                           | NO   | NO          | NO  | NO     | NOT TESTED |
| FR-15 | BullMQ job queue state backup                      | NO   | NO          | NO  | NO     | NOT TESTED |

---

## 2. Existing Test Inventory

### Unit Tests

None. Feature is in PLANNED status.

### Integration Tests

None. Feature is in PLANNED status.

### E2E Tests

None. Feature is in PLANNED status.

---

## 3. Test Infrastructure Requirements

### Local Test Environment

All E2E and integration tests require the following services running locally (via Docker Compose or testcontainers):

| Service           | Image / Tool                   | Purpose                           | Port  |
| ----------------- | ------------------------------ | --------------------------------- | ----- |
| MongoDB           | `mongo:7`                      | Primary data store backup/restore | 27017 |
| MongoDB (scratch) | `mongo:7`                      | Verification scratch database     | 27018 |
| Redis             | `redis:7`                      | Cache/queue backup/restore        | 6379  |
| Redis (scratch)   | `redis:7`                      | Verification scratch Redis        | 6380  |
| ClickHouse        | `clickhouse/clickhouse-server` | Analytics backup/restore          | 8123  |
| MinIO             | `minio/minio`                  | S3-compatible storage for backups | 9000  |
| MinIO (replica)   | `minio/minio`                  | Simulated secondary region        | 9001  |

### Test Utilities

- `createTestBackupContext()`: Seeds MongoDB, Redis, and ClickHouse with deterministic test data for a given tenant, returns expected record counts and checksums for validation
- `assertBackupIntegrity(backupId)`: Downloads backup from MinIO, decrypts, and validates checksums match
- `assertRestoreIntegrity(tenantId, expectedCounts)`: Queries all data stores and validates record counts match pre-backup state
- `waitForBackupCompletion(backupId, timeoutMs)`: Polls backup status until completed or timeout
- `waitForRestoreCompletion(jobId, timeoutMs)`: Polls restore job status until completed or timeout
- `seedTenantData(tenantId, options)`: Creates sample data across all stores (MongoDB documents, Redis keys, ClickHouse rows)

---

## 4. E2E Test Scenarios (Mandatory -- minimum 5)

### E2E-1: Full Platform Backup and Restore Lifecycle

**Objective**: Verify that a full platform backup captures all data stores and can be restored to produce an identical data state.

**Prerequisites**: Running Admin server with backup enabled, MongoDB/Redis/ClickHouse with seeded data, MinIO for S3 storage, `ENCRYPTION_MASTER_KEY` configured.

**Steps**:

1. Seed Tenant A with deterministic test data: 50 MongoDB documents across 5 collections (`llm_credentials`, `environment_variables`, `session_states`, `messages`, `auth_profiles`), 20 Redis keys (10 cache keys, 5 BullMQ pending jobs, 5 rate limit counters), 100 ClickHouse rows across 3 tables (`traces`, `messages`, `audit_events`)
2. Record pre-backup state: document counts per collection, Redis key counts, ClickHouse row counts, SHA-256 checksums of sample documents
3. POST `/api/admin/backups` with `{ scope: "platform", dataStores: ["mongodb", "redis", "clickhouse"] }`
4. Assert 202 response with `backupId` and status `pending`
5. Poll GET `/api/admin/backups/:backupId` until status is `completed` (timeout: 120s)
6. Assert backup record contains: `storage.totalSizeBytes > 0`, `storage.checksums` for each data store, `encryption.keyVersion` is set, `duration.durationMs > 0`
7. Verify backup artifacts exist in MinIO at the expected paths (`mongodb/snapshots/...`, `redis/rdb/...`, `clickhouse/full/...`)
8. Clear all data from MongoDB, Redis, and ClickHouse (simulate data loss)
9. POST `/api/admin/backups/:backupId/restore` with `{ type: "full_restore" }`
10. Poll GET restore job until status is `completed` (timeout: 180s)
11. Assert post-restore state matches pre-backup state: document counts, key counts, row counts, sample document checksums
12. Assert restore job `validation.postRestore.matchPercentage >= 99`

**Expected Result**: Full backup captures all data stores; restore produces an identical data state with >= 99% match.

**Validates**: FR-1 (automated backup), FR-2 (encryption), FR-14 (metadata tracking)

---

### E2E-2: Tenant-Scoped Backup and Restore Isolation

**Objective**: Verify that tenant-scoped backup captures only the target tenant's data, and tenant-scoped restore does not affect other tenants.

**Prerequisites**: Running Admin server, two tenants (A and B) with seeded data.

**Steps**:

1. Seed Tenant A with 30 MongoDB documents, 10 Redis keys, 50 ClickHouse rows
2. Seed Tenant B with 20 MongoDB documents, 8 Redis keys, 40 ClickHouse rows
3. Record pre-backup state for both tenants (counts and checksums)
4. POST `/api/admin/backups` with `{ scope: "tenant", tenantId: "<tenantA>", dataStores: ["mongodb", "redis", "clickhouse"] }`
5. Wait for backup completion
6. Delete all of Tenant A's data from MongoDB, Redis, and ClickHouse (simulate tenant data loss)
7. Verify Tenant B's data is unchanged (counts and checksums match pre-backup)
8. POST `/api/admin/backups/:backupId/restore` with `{ type: "tenant_restore", tenantId: "<tenantA>" }`
9. Wait for restore completion
10. Assert Tenant A's data matches pre-backup state (counts and checksums)
11. Assert Tenant B's data is STILL unchanged (counts and checksums match pre-backup -- restore did not affect Tenant B)
12. As Tenant B, attempt GET `/api/tenant/backups/:backupId` for Tenant A's backup -- expect 404

**Expected Result**: Tenant-scoped backup captures only target tenant's data; restore only affects target tenant; cross-tenant access returns 404.

**Validates**: FR-4 (tenant isolation), FR-5 (tenant restore), FR-14 (metadata)

---

### E2E-3: MongoDB Point-in-Time Recovery (PITR)

**Objective**: Verify that PITR restores MongoDB to a specific timestamp, recovering data that existed at that point and discarding later changes.

**Prerequisites**: Running Admin server with PITR enabled, oplog archiver running, Tier 1 (Enterprise) backup schedule.

**Steps**:

1. Seed Tenant A with 20 MongoDB documents at T0
2. Wait 30 seconds for oplog archiver to capture initial state
3. At T1, insert 10 more documents into Tenant A (documents D21-D30)
4. Record T1 timestamp
5. Wait 30 seconds for oplog archiver to capture T1 state
6. At T2, delete documents D21-D25 (5 of the 10 inserted at T1)
7. Wait 30 seconds for oplog archiver to capture T2 state
8. POST `/api/admin/backups/:latestSnapshotId/restore` with `{ type: "pitr_restore", targetTimestamp: T1 }`
9. Wait for restore completion
10. Assert MongoDB contains all 30 documents (D1-D30) -- the state at T1
11. Assert documents D21-D25 exist (they were deleted at T2, but PITR restored to T1 before deletion)
12. GET `/api/tenant/backups/:backupId/restore-points` and assert T1 is within the available PITR window

**Expected Result**: PITR restores to exact timestamp T1, including documents that were later deleted at T2.

**Validates**: FR-3 (PITR with oplog replay)

---

### E2E-4: Backup Encryption and Integrity Verification

**Objective**: Verify that backup artifacts are encrypted, that encrypted backups can be restored, and that backup verification detects integrity issues.

**Prerequisites**: Running Admin server with backup encryption enabled, MinIO for S3.

**Steps**:

1. Seed Tenant A with test data
2. Trigger a full backup and wait for completion
3. Download the raw backup artifact from MinIO
4. Assert the artifact is NOT readable as plaintext (encrypted with AES-256-GCM)
5. Assert `backup_records.encryption.keyVersion` and `backup_records.encryption.kmsKeyId` are set
6. POST `/api/admin/backups/:backupId/verify` to trigger manual verification
7. Wait for verification to complete
8. Assert `backup_records.verification.status === "passed"`
9. Assert `backup_records.verification.recordCounts` matches expected counts
10. Corrupt a backup artifact in MinIO (modify bytes in the encrypted file)
11. POST `/api/admin/backups/:backupId/verify` again
12. Assert `backup_records.verification.status === "failed"` with error details about checksum mismatch

**Expected Result**: Backups are encrypted at rest in S3; verification detects corruption; healthy backups pass integrity checks.

**Validates**: FR-2 (encryption), FR-7 (verification), FR-14 (metadata)

---

### E2E-5: Cross-Region Backup Replication

**Objective**: Verify that backup artifacts are replicated to a secondary region and are accessible for DR.

**Prerequisites**: Running Admin server, primary MinIO and secondary MinIO (simulating cross-region), replication worker enabled.

**Steps**:

1. Seed Tenant A with test data
2. Trigger a full backup and wait for completion
3. Assert `backup_records.replication.replicationStatus === "pending"`
4. Wait for replication worker to replicate to secondary MinIO (poll replication status, timeout: 60s)
5. Assert `backup_records.replication.replicationStatus === "replicated"`
6. Assert `backup_records.replication.replicatedTo` includes the secondary region identifier
7. Verify the backup artifact exists in secondary MinIO at the expected path
8. Download artifact from secondary MinIO and compare SHA-256 checksum with primary -- assert match
9. GET `/api/admin/dr/replication-lag` and assert lag is within acceptable bounds (< 5 minutes for Enterprise tier)

**Expected Result**: Backup artifacts are replicated to secondary region; checksums match; replication lag is monitored.

**Validates**: FR-6 (cross-region replication), FR-10 (monitoring)

---

### E2E-6: Disaster Recovery Failover and Rollback

**Objective**: Verify that DR failover promotes the secondary region and that rollback returns to the primary.

**Prerequisites**: Running primary and secondary environments (simulated), DR configuration set to `semi_automatic` mode.

**Steps**:

1. Configure DR with primary and secondary regions via PUT `/api/admin/dr/config`
2. Seed primary with test data and trigger a backup (replicated to secondary)
3. GET `/api/admin/dr/status` -- assert status is `active`
4. Simulate primary region health check failure (stop primary MongoDB/Redis)
5. Wait for health check failure threshold (3 consecutive failures)
6. Assert alert is generated for DR health check failure
7. POST `/api/admin/dr/failover` with `{ confirmation: true }`
8. Wait for failover completion (timeout: 300s)
9. GET `/api/admin/dr/status` -- assert status is `failed_over`
10. Verify application endpoints are served from secondary region
11. Verify data in secondary matches last replicated backup
12. Restart primary region services
13. POST `/api/admin/dr/failover/rollback`
14. Wait for rollback completion
15. GET `/api/admin/dr/status` -- assert status is `active` (back to primary)

**Expected Result**: Failover transitions to secondary region; rollback returns to primary; data integrity maintained throughout.

**Validates**: FR-12 (DR orchestration)

---

### E2E-7: Backup Audit Trail and Compliance

**Objective**: Verify that all backup and restore operations emit audit events for compliance evidence.

**Prerequisites**: Running Admin server with audit logging enabled, ClickHouse for audit events.

**Steps**:

1. Trigger a backup via POST `/api/admin/backups`
2. Wait for backup completion
3. Query ClickHouse `audit_events` table for events with `action = 'backup.created'` and matching `backupId`
4. Assert audit event contains: `actorId` (operator), `tenantId`, `action`, `resourceId` (backupId), `timestamp`, `result: "success"`
5. Trigger a restore via POST `/api/admin/backups/:backupId/restore`
6. Wait for restore completion
7. Query `audit_events` for `action = 'backup.restore.initiated'` and `action = 'backup.restore.completed'`
8. Assert both events exist with correct metadata
9. DELETE `/api/admin/backups/:backupId`
10. Query `audit_events` for `action = 'backup.deleted'`
11. Assert deletion audit event exists

**Expected Result**: All backup lifecycle operations (create, restore, delete) emit auditable events with operator identity and result.

**Validates**: FR-9 (audit logging)

---

## 5. Integration Test Scenarios (Mandatory -- minimum 5)

### INT-1: MongoDB Backup Adapter -- Snapshot and Restore

**Objective**: Test the MongoDB backup adapter creates a valid snapshot and restores it correctly, independent of the HTTP API layer.

**Setup**: MongoMemoryServer (primary) + MongoMemoryServer (scratch), MinIO testcontainer.

**Steps**:

1. Seed primary MongoDB with 100 documents across 5 collections, each with `tenantId` field
2. Call `mongodbAdapter.createSnapshot({ connectionUri, outputPath, encrypted: false })`
3. Assert snapshot file is created at `outputPath` with size > 0
4. Upload snapshot to MinIO via `s3Adapter.upload()`
5. Call `mongodbAdapter.restoreSnapshot({ connectionUri: scratchUri, inputPath, collections: ['all'] })`
6. Query scratch MongoDB and assert all 100 documents exist with correct field values
7. Compare document-by-document checksums between primary and scratch

**Validates**: FR-1 (MongoDB backup/restore), FR-14 (integrity)

---

### INT-2: Redis Backup Adapter -- RDB Snapshot and BullMQ State

**Objective**: Test that Redis backup captures RDB snapshot including BullMQ job state, and restore recovers pending jobs.

**Setup**: Redis testcontainer (primary) + Redis testcontainer (scratch).

**Steps**:

1. Connect to primary Redis, set 20 cache keys (`tenant:A:cache:*`)
2. Create 5 BullMQ pending jobs and 3 delayed jobs in a `test-queue`
3. Call `redisAdapter.createRDBSnapshot({ redisUrl, outputPath })`
4. Assert RDB file exists with size > 0
5. Call `redisAdapter.restoreRDBSnapshot({ redisUrl: scratchUrl, inputPath })`
6. Query scratch Redis and assert all 20 cache keys exist
7. Connect BullMQ to scratch Redis and assert 5 pending jobs and 3 delayed jobs are present in `test-queue`

**Validates**: FR-1 (Redis backup), FR-15 (BullMQ state)

---

### INT-3: Backup Encryption Adapter Integration

**Objective**: Test that the backup encryption adapter correctly encrypts and decrypts backup artifacts using the platform's EncryptionService.

**Setup**: EncryptionService initialized with test master key, MinIO testcontainer.

**Steps**:

1. Create a 10MB test backup artifact (random bytes)
2. Call `backupEncryptionAdapter.encryptAndUpload({ artifact, tenantId, s3Path })`
3. Download raw bytes from MinIO and assert they are NOT the original plaintext (encrypted)
4. Assert the encrypted artifact has the expected format (AES-256-GCM envelope with IV and auth tag)
5. Call `backupEncryptionAdapter.downloadAndDecrypt({ s3Path, tenantId })`
6. Assert decrypted artifact exactly matches the original 10MB test artifact (byte-for-byte comparison)
7. Attempt to decrypt with a DIFFERENT tenantId -- assert decryption fails (tenant key isolation)
8. Rotate the master key and assert old backups can still be decrypted via `decryptWithFallback`

**Validates**: FR-2 (backup encryption), FR-4 (tenant key isolation)

---

### INT-4: Backup Retention Policy Enforcement

**Objective**: Test that the retention cleanup worker correctly transitions backups through retention tiers and deletes expired backups.

**Setup**: MongoDB with backup_records collection, MinIO with test backup artifacts.

**Steps**:

1. Create 5 backup records with varying `createdAt` dates:
   - Backup A: 1 day old (should be in `hot` tier)
   - Backup B: 45 days old (should be in `warm` tier)
   - Backup C: 120 days old (should be in `cold` tier)
   - Backup D: 400 days old (past maximum retention -- should be deleted)
   - Backup E: 50 days old with `compliancePreset: 'hipaa'` (6-year minimum -- should NOT be deleted)
2. Configure retention policy: hot=30 days, warm=90 days, cold=365 days, max=365 days
3. Run `retentionCleanupWorker.execute()`
4. Assert Backup A tier is `hot`, B is `warm`, C is `cold`
5. Assert Backup D is deleted from both MongoDB and MinIO
6. Assert Backup E is NOT deleted (HIPAA minimum retention of 6 years overrides general max)
7. Verify S3 lifecycle configuration matches retention tier storage classes

**Validates**: FR-8 (retention policies), FR-13 (GDPR compliance)

---

### INT-5: Backup Schedule Execution

**Objective**: Test that backup schedules trigger backup jobs at the correct intervals and handle failures with retry.

**Setup**: MongoDB, Redis (BullMQ), MinIO, backup schedule configuration.

**Steps**:

1. Create a backup schedule with cron expression `*/1 * * * *` (every minute) for `tier: 'standard'`
2. Enable the schedule
3. Wait for 70 seconds (past the first cron trigger)
4. Assert a backup job was created in BullMQ with the correct parameters
5. Assert a `backup_records` entry exists with `schedule.scheduleId` matching the schedule
6. Assert `backup_schedules.lastRunAt` was updated
7. Assert `backup_schedules.nextRunAt` is ~1 minute in the future
8. Simulate a backup failure (e.g., disconnect MongoDB during backup)
9. Assert the backup record status is `failed` after retries exhausted
10. Assert the next scheduled backup still runs on the next cron tick (failure does not disable schedule)

**Validates**: FR-1 (scheduled backups), FR-10 (monitoring)

---

### INT-6: On-Demand Backup Rate Limiting

**Objective**: Test that on-demand backup requests are rate-limited to prevent abuse.

**Setup**: Running Admin server with authenticated tenant admin.

**Steps**:

1. As Tenant A admin, POST `/api/tenant/backups` to trigger on-demand backup
2. Assert 202 response (accepted)
3. Immediately POST `/api/tenant/backups` again
4. Assert 429 response (rate limited) with error message indicating rate limit (1 per hour)
5. As Tenant B admin, POST `/api/tenant/backups`
6. Assert 202 response (different tenant, independent rate limit)
7. As platform admin, POST `/api/admin/backups` with `{ tenantId: "<tenantA>" }`
8. Assert 202 response (platform admin bypasses tenant rate limit)

**Validates**: FR-11 (on-demand with rate limiting)

---

### INT-7: Backup Monitoring Metrics Emission

**Objective**: Test that backup operations emit the expected Prometheus metrics.

**Setup**: Running backup service with Prometheus metrics endpoint.

**Steps**:

1. Trigger a backup and wait for completion
2. Scrape `/metrics` endpoint
3. Assert `backup_job_duration_seconds` histogram has an observation for the completed backup
4. Assert `backup_job_size_bytes` gauge reports the correct backup size
5. Assert `backup_job_status{status="completed"}` counter incremented
6. Trigger a backup that fails (e.g., invalid S3 credentials)
7. Scrape `/metrics` again
8. Assert `backup_job_status{status="failed"}` counter incremented

**Validates**: FR-10 (monitoring and alerting)

---

## 6. Manual Validation Scenarios

### MAN-1: DR Failover Drill (Quarterly)

**Objective**: Validate full DR failover in a staging environment that mirrors production.

**Procedure**:

1. Confirm staging environment has primary and secondary regions configured
2. Verify latest backup is replicated to secondary region
3. Simulate primary region outage (shut down primary K8s cluster)
4. Execute DR failover runbook step-by-step
5. Verify all services are operational in secondary region
6. Run application smoke tests against secondary region endpoints
7. Verify data integrity (compare record counts to last known good state)
8. Execute rollback to primary region
9. Verify all services are operational in primary region
10. Document drill results: total failover time, data loss (if any), issues encountered

**Success Criteria**: RTO < 15 minutes (Enterprise), zero data loss for data backed up before replication lag.

---

### MAN-2: Tenant Self-Service Restore (User Acceptance)

**Objective**: Validate the tenant admin restore experience end-to-end in the Studio UI.

**Procedure**:

1. Log in as enterprise tenant admin
2. Navigate to Settings > Backup & Recovery
3. Verify backup history is displayed with correct timestamps and statuses
4. Trigger an on-demand backup
5. Verify backup progress is shown in real-time
6. Delete some test data (e.g., delete an agent definition)
7. Initiate a restore from the latest backup
8. Verify restore wizard shows progress and estimated time
9. After restore, verify the deleted agent definition is recovered
10. Verify no data from other tenants was affected

**Success Criteria**: Tenant admin can self-service backup and restore without platform operator intervention.

---

## 7. Test Data Requirements

### Deterministic Test Data Set

For consistency across test runs, the test utilities generate deterministic data:

| Data Store | Collection / Key Pattern   | Count | Tenant A | Tenant B | Size (approx) |
| ---------- | -------------------------- | ----- | -------- | -------- | ------------- |
| MongoDB    | `llm_credentials`          | 10    | 6        | 4        | 5 KB          |
| MongoDB    | `environment_variables`    | 20    | 12       | 8        | 3 KB          |
| MongoDB    | `session_states`           | 15    | 9        | 6        | 50 KB         |
| MongoDB    | `messages`                 | 50    | 30       | 20       | 100 KB        |
| MongoDB    | `auth_profiles`            | 5     | 3        | 2        | 2 KB          |
| Redis      | `tenant:<id>:cache:*`      | 20    | 12       | 8        | 10 KB         |
| Redis      | BullMQ jobs (`test-queue`) | 8     | 5        | 3        | 4 KB          |
| ClickHouse | `traces`                   | 100   | 60       | 40       | 200 KB        |
| ClickHouse | `messages`                 | 50    | 30       | 20       | 100 KB        |
| ClickHouse | `audit_events`             | 30    | 18       | 12       | 30 KB         |

### Checksums

Each test data set generates SHA-256 checksums for:

- Per-collection document counts
- Per-collection sample document content (first 5 documents, sorted by `_id`)
- Total key count per Redis key pattern
- Total row count per ClickHouse table with tenant filter

These checksums are used in post-restore integrity validation.

---

## 8. Performance Test Scenarios

### PERF-1: Backup Duration Under Load

**Objective**: Measure backup duration when the platform is under normal operational load.

**Setup**: Simulated load (100 concurrent API requests/s), 10GB MongoDB, 1GB Redis, 50GB ClickHouse.

**Measurements**:

| Metric                   | Target            |
| ------------------------ | ----------------- |
| MongoDB snapshot time    | < 30 minutes      |
| Redis RDB snapshot time  | < 5 minutes       |
| ClickHouse backup time   | < 60 minutes      |
| API latency impact (P99) | < 10% degradation |

### PERF-2: Restore Duration (RTO Validation)

**Objective**: Validate that restore operations meet RTO targets.

**Setup**: Backup artifacts of representative production size.

**Measurements**:

| Scenario              | Target (Enterprise) | Target (Business) | Target (Standard) |
| --------------------- | ------------------- | ----------------- | ----------------- |
| Full platform restore | < 15 minutes        | < 1 hour          | < 4 hours         |
| Tenant-scoped restore | < 10 minutes        | < 30 minutes      | < 2 hours         |
| PITR restore          | < 15 minutes        | N/A               | N/A               |

---

## 9. Chaos Test Scenarios

### CHAOS-1: Data Store Failure During Backup

**Objective**: Verify backup gracefully handles a data store becoming unavailable mid-backup.

**Steps**:

1. Start a full backup
2. During MongoDB snapshot phase, kill the MongoDB secondary being read
3. Assert backup reports partial failure with clear error message
4. Assert Redis and ClickHouse backup phases still complete
5. Assert backup status is `failed` (not `completed` with silent data loss)
6. Assert alert is generated

### CHAOS-2: S3 Unavailability During Backup Upload

**Objective**: Verify backup retries and eventually fails gracefully when S3 is unavailable.

**Steps**:

1. Start a full backup
2. During S3 upload phase, make MinIO unavailable (stop container)
3. Assert backup retries with exponential backoff (1 min, 5 min, 15 min)
4. After retries exhausted, assert backup status is `failed` with error details
5. Restore MinIO and trigger a new backup
6. Assert the new backup completes successfully

### CHAOS-3: Concurrent Backup and High-Write Load

**Objective**: Verify backup consistency under high write throughput.

**Steps**:

1. Start continuous writes to MongoDB (1000 inserts/s)
2. Trigger a full backup
3. Continue writes throughout the backup window
4. Restore the backup to a scratch environment
5. Assert scratch environment has a consistent snapshot (no torn writes, no partial documents)

---

## 10. Security Test Scenarios

### SEC-1: Backup Artifact Encryption at Rest

**Objective**: Verify backup artifacts in S3 cannot be read without decryption keys.

**Steps**:

1. Trigger a backup
2. Download raw artifact from S3 (bypass application layer)
3. Attempt to parse as mongodump/RDB/clickhouse-backup format -- assert failure (encrypted)
4. Attempt to decrypt with wrong tenant key -- assert failure
5. Decrypt with correct tenant key -- assert success

### SEC-2: Cross-Tenant Backup Access Prevention

**Objective**: Verify one tenant cannot access another tenant's backup operations or data.

**Steps**:

1. As Tenant A, create a backup
2. As Tenant B, attempt to list Tenant A's backups via API -- assert 404
3. As Tenant B, attempt to restore Tenant A's backup via API -- assert 404
4. As Tenant B, attempt to delete Tenant A's backup via API -- assert 404
5. As Tenant B, attempt to access Tenant A's backup S3 path directly -- assert access denied (IAM policy)

---

## 11. Compliance Test Scenarios

### COMP-1: SOC2 Availability Evidence

**Objective**: Verify backup system produces evidence required for SOC2 audit.

**Checklist**:

- [ ] Automated backup schedule is configured and executing
- [ ] Backup success/failure logs are available for the audit period
- [ ] Backup verification (restore-to-scratch) results are recorded
- [ ] Retention policies are documented and enforced
- [ ] Access to backup operations is logged with operator identity
- [ ] DR failover has been drilled within the last quarter

### COMP-2: GDPR Data Minimization

**Objective**: Verify backup retention respects GDPR maximum retention limits.

**Steps**:

1. Configure retention policy with GDPR preset (max 365 days)
2. Create a backup
3. Fast-forward time past 365 days (or set `createdAt` to > 365 days ago)
4. Run retention cleanup worker
5. Assert backup is deleted from both MongoDB metadata and S3 storage

### COMP-3: HIPAA Minimum Retention

**Objective**: Verify HIPAA-tagged backups cannot be deleted before the 6-year minimum.

**Steps**:

1. Configure retention policy with HIPAA preset (6-year minimum)
2. Create a backup with HIPAA compliance tag
3. Attempt to DELETE the backup via API -- assert 403 with "minimum retention period not met"
4. Attempt to run retention cleanup -- assert backup is NOT deleted
5. Fast-forward past 6 years -- assert backup is now eligible for deletion

---

## 12. Test Execution Order

For initial implementation, tests should be built and run in this order:

1. **Unit tests**: Backup service, adapters, encryption adapter, retention logic
2. **Integration tests**: INT-1 through INT-7 (requires Docker services)
3. **E2E tests**: E2E-1 through E2E-7 (requires full stack)
4. **Security tests**: SEC-1, SEC-2
5. **Compliance tests**: COMP-1 through COMP-3
6. **Performance tests**: PERF-1, PERF-2 (requires production-scale data)
7. **Chaos tests**: CHAOS-1 through CHAOS-3 (requires failure injection)
8. **Manual validation**: MAN-1, MAN-2 (requires staging environment)

---

## 13. CI/CD Integration

### Pipeline Stages

| Stage       | Tests Included          | Trigger                    | Timeout |
| ----------- | ----------------------- | -------------------------- | ------- |
| Unit        | All unit tests          | Every PR                   | 5 min   |
| Integration | INT-1 through INT-7     | Every PR (Docker required) | 15 min  |
| E2E         | E2E-1 through E2E-7     | Merge to develop           | 30 min  |
| Security    | SEC-1, SEC-2            | Merge to develop           | 10 min  |
| Performance | PERF-1, PERF-2          | Weekly (staging)           | 120 min |
| Chaos       | CHAOS-1 through CHAOS-3 | Weekly (staging)           | 60 min  |
| DR Drill    | MAN-1                   | Quarterly (staging)        | 60 min  |

### Required Test Containers

```yaml
# docker-compose.test.yml additions for backup tests
services:
  minio-primary:
    image: minio/minio
    command: server /data
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - '9000:9000'
  minio-secondary:
    image: minio/minio
    command: server /data
    environment:
      MINIO_ROOT_USER: minioadmin
      MINIO_ROOT_PASSWORD: minioadmin
    ports:
      - '9001:9000'
  mongo-scratch:
    image: mongo:7
    ports:
      - '27018:27017'
  redis-scratch:
    image: redis:7
    ports:
      - '6380:6379'
```
