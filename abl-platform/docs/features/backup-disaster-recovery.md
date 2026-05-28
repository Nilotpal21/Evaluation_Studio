# Feature: Backup & Disaster Recovery

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `enterprise`, `governance`, `admin operations`
**Package(s)**: `packages/shared` (backup module), `packages/database` (backup adapters), `apps/admin` (backup management UI), `apps/runtime` (backup coordination)
**Owner(s)**: Platform team
**Testing Guide**: [../testing/backup-disaster-recovery.md](../testing/backup-disaster-recovery.md)
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

The ABL agent platform stores critical data across three storage systems (MongoDB, Redis, ClickHouse) plus S3-compatible object storage, serving multiple tenants in a Kubernetes-deployed environment. Today there is no unified backup strategy, no defined RPO/RTO targets, no automated restore verification, and no disaster recovery runbooks. A single data store failure, accidental deletion, ransomware event, or regional outage could result in permanent data loss for all tenants. Without backup infrastructure, the platform cannot meet SOC2 Availability Trust Services Criteria, GDPR Article 32 (security of processing), or HIPAA contingency plan requirements (45 CFR 164.308(a)(7)).

Enterprise customers require contractual RPO/RTO guarantees, tenant-scoped backup/restore capabilities, cross-region replication for business continuity, and auditable backup integrity verification. Platform operators need automated backup scheduling, monitoring, alerting on backup failures, and rehearsed restore procedures. Without these capabilities, the platform cannot serve regulated industries (healthcare, financial services) or achieve enterprise compliance certifications.

### Goal Statement

Provide a comprehensive, multi-layer backup and disaster recovery system that delivers tiered RPO/RTO guarantees across all data stores (MongoDB, Redis, ClickHouse, S3), supports tenant-scoped backup and restore operations, integrates with existing encryption-at-rest and KMS infrastructure, automates backup verification, and enables cross-region disaster recovery with documented failover runbooks.

### Summary

The Backup & Disaster Recovery feature introduces five layers of protection:

1. **Scheduled backups** -- automated, encrypted backups for MongoDB (oplog-based PITR + periodic snapshots), Redis (RDB + AOF persistence with S3 offloading), and ClickHouse (incremental + full backups via clickhouse-backup) stored in S3-compatible object storage with lifecycle policies.
2. **Tenant-scoped backup/restore** -- operators and enterprise tenant admins can trigger backup and restore operations scoped to a specific tenant's data, enabling self-service recovery without affecting other tenants.
3. **Cross-region replication** -- asynchronous replication of backup artifacts to a secondary region for disaster recovery, with configurable replication lag targets per tier.
4. **Backup verification** -- automated restore-to-scratch testing on a schedule, with integrity checks (checksum validation, record count comparison, sample query verification) and alerting on failures.
5. **Disaster recovery orchestration** -- runbook-driven failover procedures with automated and semi-automated steps, health checks, DNS cutover support, and recovery validation.

Backup metadata (schedules, retention policies, restore points, verification results) is stored in MongoDB with full tenant isolation. All backup artifacts are encrypted using the existing KMS infrastructure before storage. Backup operations are orchestrated via BullMQ jobs with progress tracking and observability through the existing tracing pipeline.

---

## 2. Scope

### Goals

- Establish tiered RPO/RTO targets: Tier 1 (Enterprise) RPO < 5 min / RTO < 15 min; Tier 2 (Business) RPO < 1 hr / RTO < 1 hr; Tier 3 (Standard) RPO < 24 hr / RTO < 4 hr
- Implement automated, encrypted backup pipelines for MongoDB, Redis, and ClickHouse with S3-compatible storage
- Support MongoDB oplog-based point-in-time recovery (PITR) for Tier 1 tenants
- Provide tenant-scoped backup and restore operations with full data isolation
- Implement cross-region backup replication for disaster recovery readiness
- Deliver automated backup verification (restore-to-scratch testing) with integrity checks
- Integrate with existing encryption-at-rest and KMS infrastructure for backup encryption
- Provide backup monitoring, alerting, and audit logging
- Implement S3 lifecycle policies for tiered retention (hot/warm/cold/archive)
- Deliver operator-facing Admin UI for backup management and DR orchestration
- Create documented disaster recovery runbooks with automated failover steps
- Support compliance requirements for SOC2, GDPR, and HIPAA backup retention

### Non-Goals (Out of Scope)

- Client-side (browser) backup initiation -- all backup operations are server-side operator/admin actions
- Real-time synchronous replication (active-active multi-region) -- only asynchronous replication is in scope
- Backup of Qdrant vector search indexes -- vectors are derived data and can be rebuilt from source
- Per-project granularity for backup/restore -- backup granularity is tenant-scoped (not project-scoped) in Phase 1
- Application-level change data capture (CDC) -- relies on database-native mechanisms (oplog, AOF, clickhouse-backup)
- Backup of external connector source data (Google Drive, Confluence, etc.) -- only platform-managed data is backed up
- Bare-metal or VM-level backup (Velero cluster snapshots) -- this is infrastructure-layer, managed separately
- Multi-cloud DR (e.g., AWS to GCP failover) -- single cloud provider, cross-region only in Phase 1

---

## 3. User Stories

1. As a **platform operator**, I want automated daily backups of all data stores so that I can recover from data loss without manual intervention.
2. As a **platform operator**, I want to define tiered RPO/RTO targets per tenant plan so that enterprise customers get faster recovery guarantees.
3. As an **SRE**, I want automated backup verification (restore-to-scratch testing) so that I have confidence backups are actually restorable before a disaster strikes.
4. As an **SRE**, I want real-time monitoring and alerting on backup job failures so that I am paged immediately when a backup pipeline breaks.
5. As a **compliance officer**, I want backup retention policies aligned to SOC2/GDPR/HIPAA requirements so that I can demonstrate compliance during audits.
6. As a **compliance officer**, I want an immutable audit trail of all backup and restore operations so that I can produce evidence for regulatory reviews.
7. As a **tenant admin** (enterprise tier), I want to trigger an on-demand backup of my tenant's data so that I can create a restore point before a risky deployment.
8. As a **tenant admin** (enterprise tier), I want to restore my tenant's data to a specific point in time so that I can recover from accidental data deletion or corruption.
9. As a **data protection officer**, I want backup artifacts encrypted with tenant-scoped keys so that a compromised backup does not expose another tenant's data.
10. As a **data protection officer**, I want GDPR-compliant backup retention with the ability to purge a specific tenant's backup data so that right-to-erasure requests can be honored.
11. As an **SRE**, I want documented disaster recovery runbooks with automated failover steps so that I can execute region failover under pressure without guessing.
12. As a **platform operator**, I want cross-region backup replication so that a regional outage does not result in permanent data loss.

---

## 4. Functional Requirements

1. **FR-1**: The system must perform automated, scheduled backups of MongoDB (full snapshot + oplog continuous archiving), Redis (RDB snapshots), and ClickHouse (full + incremental via clickhouse-backup) according to configurable cron schedules per backup tier.
2. **FR-2**: The system must encrypt all backup artifacts using the existing KMS infrastructure (AES-256-GCM with tenant-scoped key derivation) before writing to S3-compatible storage, and must decrypt on restore using the same key hierarchy.
3. **FR-3**: The system must support MongoDB point-in-time recovery (PITR) by continuously archiving oplog entries to S3 and replaying them during restore to achieve recovery to any timestamp within the retention window.
4. **FR-4**: The system must enforce tenant-scoped backup isolation -- backup operations for one tenant must not include, expose, or affect another tenant's data. Cross-tenant backup access must return 404.
5. **FR-5**: The system must support tenant-scoped restore operations that restore only the target tenant's data from a backup snapshot, preserving all other tenants' current state.
6. **FR-6**: The system must replicate backup artifacts to a configurable secondary region (S3 cross-region replication or application-level copy) with replication lag monitoring and alerting.
7. **FR-7**: The system must perform automated backup verification by restoring the latest backup to an isolated scratch environment on a configurable schedule, running integrity checks (record count comparison, checksum validation, sample query verification), and recording pass/fail results.
8. **FR-8**: The system must enforce configurable retention policies per backup tier with S3 lifecycle rules: hot (recent, immediate access), warm (30-90 days, infrequent access), cold (90-365 days, archive tier), and expired (auto-delete after retention period).
9. **FR-9**: The system must emit audit log events for all backup and restore operations (backup created, backup deleted, restore initiated, restore completed, verification passed/failed) via the existing audit logging pipeline.
10. **FR-10**: The system must provide backup monitoring and alerting -- emit metrics for backup job status, duration, size, verification results, and replication lag, with configurable alert thresholds integrated into the existing alerts framework.
11. **FR-11**: The system must support on-demand backup creation by authorized operators (platform admin) and enterprise tenant admins, with rate limiting to prevent abuse (max 1 on-demand backup per tenant per hour).
12. **FR-12**: The system must provide a disaster recovery orchestration API with runbook-driven steps: pre-failover health check, DNS cutover trigger, service promotion, post-failover validation, and rollback capability.
13. **FR-13**: The system must support GDPR right-to-erasure for backup data by maintaining a tenant-level backup manifest that enables selective purging of a specific tenant's data from backup artifacts, or by encrypting tenant backups with tenant-scoped keys (crypto-shredding on key deletion).
14. **FR-14**: The system must track backup metadata (backup ID, type, scope, status, size, duration, checksum, storage location, encryption key version, retention tier, verification status) in a MongoDB collection with tenant isolation.
15. **FR-15**: The system must support backup of BullMQ job queue state (pending/delayed/failed jobs) as part of the Redis backup pipeline, ensuring in-flight work can be recovered after a disaster.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                     |
| -------------------------- | ------------ | ------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Project data is backed up as part of tenant-scoped backups                |
| Agent lifecycle            | SECONDARY    | Agent definitions, credentials, and session state included in backups     |
| Customer experience        | SECONDARY    | Recovery from data loss preserves customer conversation history           |
| Integrations / channels    | SECONDARY    | Channel connection credentials and connector sync state backed up         |
| Observability / tracing    | SECONDARY    | ClickHouse trace data backed up; backup operations emit trace events      |
| Governance / controls      | PRIMARY      | Core compliance feature -- SOC2 Availability, GDPR Art. 32, HIPAA 164.308 |
| Enterprise / compliance    | PRIMARY      | Tiered RPO/RTO guarantees, audit trail, retention policies                |
| Admin / operator workflows | PRIMARY      | Operators manage backup schedules, monitor jobs, execute DR runbooks      |

### Related Feature Integration Matrix

| Related Feature       | Relationship Type | Why It Matters                                                                            | Key Touchpoints                                    | Current State |
| --------------------- | ----------------- | ----------------------------------------------------------------------------------------- | -------------------------------------------------- | ------------- |
| Encryption at Rest    | depends on        | All backup artifacts must be encrypted using the same KMS key hierarchy                   | `EncryptionService`, `KMSProvider`, key derivation | BETA          |
| KMS Integration       | depends on        | Backup encryption keys derived via tenant-scoped KMS; key version tracked per backup      | `TenantKMSConfig`, `MaterializedKMSConfig`         | BETA          |
| Audit Logging         | emits into        | All backup/restore operations emit audit events for compliance evidence                   | `audit_events` ClickHouse table                    | STABLE        |
| Alerts                | configured by     | Backup failure, verification failure, and replication lag trigger alerts                  | Alert rules, notification channels                 | STABLE        |
| Session Management    | shares data with  | Session state is included in tenant backups; restore must handle active sessions          | `SessionState` model, Redis session cache          | STABLE        |
| BullMQ Job Queues     | shares data with  | In-flight job state backed up with Redis; restore must handle job deduplication           | BullMQ queue state, Redis persistence              | STABLE        |
| Analytics Pipeline    | shares data with  | ClickHouse analytics data is backed up; restore must handle materialized view rebuilds    | ClickHouse tables, materialized views              | STABLE        |
| GDPR / Contact PII    | extends           | Tenant backup erasure leverages crypto-shredding (delete tenant key to invalidate backup) | Per-tenant encryption key deletion                 | BETA          |
| Model Hub             | shares data with  | LLM credentials included in tenant backup scope                                           | `LLMCredential` model                              | STABLE        |
| Environment Variables | shares data with  | Environment variable secrets included in tenant backup scope                              | `EnvironmentVariable` model                        | STABLE        |

---

## 6. Design Considerations (Optional)

### Admin Portal UI

The Admin Portal will provide a Backup Management dashboard with:

- **Backup Overview**: List of recent backups with status, size, duration, and verification state
- **Backup Schedule Configuration**: Cron-based schedule editor per tier with visual preview
- **Restore Wizard**: Multi-step restore flow with tenant selection, restore point picker (timeline-based for PITR), pre-restore validation, and progress tracking
- **DR Dashboard**: Real-time view of replication lag, secondary region health, last successful verification, and one-click failover trigger with confirmation gate
- **Retention Policy Editor**: Per-tier retention configuration with compliance preset templates (SOC2, GDPR, HIPAA)
- **Audit Trail View**: Filterable log of all backup/restore operations with export capability

### UX Flows

- Operators navigate to Admin > Backup Management to view backup status and configure schedules
- Enterprise tenant admins access tenant-scoped backup management via Studio > Settings > Backup & Recovery
- DR failover is initiated from Admin > Disaster Recovery with a confirmation gate requiring operator acknowledgment
- Restore operations show real-time progress with estimated time remaining and rollback option

---

## 7. Technical Considerations (Optional)

### MongoDB Backup Strategy

- **Snapshot backups**: Use `mongodump` with `--oplog` flag for consistent point-in-time snapshots of the replica set. For sharded clusters, coordinate across shards using `balancerStop`/`balancerStart` to ensure consistency.
- **Oplog continuous archiving**: A dedicated worker tails the MongoDB oplog and archives oplog entries to S3 in compressed, encrypted batches (every 60 seconds or 10MB, whichever comes first). This enables PITR for Tier 1 tenants.
- **Restore**: `mongorestore` with `--oplogReplay` to a target timestamp. For tenant-scoped restore, filter the dump and oplog by `tenantId` using `--nsInclude` and oplog filtering.
- **Alternative**: Percona Backup for MongoDB (PBM) provides native PITR with oplog slicing for production-grade deployments.

### Redis Backup Strategy

- **RDB snapshots**: Configure `save` directives for periodic RDB snapshots (e.g., `save 900 1`, `save 300 10`, `save 60 10000`). Upload RDB files to S3 encrypted.
- **AOF persistence**: Enable AOF with `appendfsync everysec` for sub-second durability. AOF files are backed up alongside RDB.
- **BullMQ state**: BullMQ jobs are stored in Redis. The RDB/AOF backup captures pending, delayed, and failed job state. On restore, BullMQ workers automatically resume processing.
- **Sentinel failover**: Redis Sentinel (minimum 3 instances across availability zones) handles automatic master failover. Backup operations target the master node.

### ClickHouse Backup Strategy

- **clickhouse-backup tool**: Use Altinity's `clickhouse-backup` for incremental and full backups to S3. Supports MergeTree family tables with hard-link-based instant local snapshots.
- **Full + incremental schedule**: Weekly full backups, daily incremental backups. Incremental backups capture only new data parts since the last full backup.
- **Encrypted backups**: ClickHouse backup files are encrypted using the platform's `EncryptionService` with tenant-scoped keys before S3 upload.
- **Restore**: Restore to an offline replica first, then let ClickHouse native replication propagate to other replicas. Materialized views are rebuilt automatically.

### S3 Storage Architecture

```text
s3://<backup-bucket>/
  ├── mongodb/
  │   ├── snapshots/<yyyy-mm-dd>/<backup-id>/        # Full mongodump snapshots
  │   ├── oplog/<yyyy-mm-dd>/<hh-mm>-<hh-mm>.gz.enc  # Oplog archive chunks
  │   └── tenant-exports/<tenant-id>/<backup-id>/      # Tenant-scoped exports
  ├── redis/
  │   ├── rdb/<yyyy-mm-dd>/<backup-id>.rdb.enc        # RDB snapshots
  │   └── aof/<yyyy-mm-dd>/<backup-id>.aof.enc        # AOF snapshots
  ├── clickhouse/
  │   ├── full/<yyyy-mm-dd>/<backup-id>/              # Full backups
  │   └── incremental/<yyyy-mm-dd>/<backup-id>/       # Incremental backups
  └── metadata/
      └── manifests/<backup-id>.json.enc               # Backup manifests
```

### Tenant-Scoped Backup Isolation

- MongoDB: Tenant-scoped backups use `mongodump --query '{"tenantId":"<id>"}'` per collection, or a custom export pipeline that filters by `tenantId`.
- Redis: Tenant data in Redis is prefixed by tenant ID (`tenant:<id>:*`). Tenant-scoped backup uses `SCAN` with pattern matching to export tenant-specific keys.
- ClickHouse: Tenant-scoped backup uses `SELECT ... WHERE tenantId = '<id>' INTO OUTFILE` for each table.
- Restore: Tenant-scoped restore merges tenant data back into the live database without affecting other tenants, using upsert semantics to prevent duplicates.

### Disaster Recovery Architecture

```text
Primary Region                      Secondary Region
┌──────────────────┐                ┌──────────────────┐
│  K8s Cluster     │                │  K8s Cluster     │
│  ├── Runtime     │                │  ├── Runtime     │  (standby)
│  ├── Studio      │                │  ├── Studio      │  (standby)
│  ├── Admin       │                │  ├── Admin       │  (standby)
│  ├── SearchAI    │                │  ├── SearchAI    │  (standby)
│  ├── MongoDB RS  │ ──── async ──► │  ├── MongoDB RS  │
│  ├── Redis Sent. │ ──── async ──► │  ├── Redis Sent. │
│  ├── ClickHouse  │                │  ├── ClickHouse  │
│  └── S3 (primary)│ ──── CRR ───► │  └── S3 (replica)│
└──────────────────┘                └──────────────────┘
         │                                    ▲
    DNS (Route53)                    Failover cutover
```

### Key Architectural Decisions

- **Backup encryption**: Reuse `EncryptionService` with a dedicated backup-scoped key derived via `HKDF(masterKey, "backup:<tenantId>", "backup-encryption")`. This ensures backup keys are independent from data-at-rest keys, allowing backup access revocation without affecting live data.
- **Job orchestration**: Backup jobs run as BullMQ flows (parent job with child jobs per data store) using `PipelineFlowBuilder`. This provides retry, progress tracking, and failure isolation per data store.
- **Idempotency**: Every backup and restore operation uses a unique `backupId` (UUIDv7) as an idempotency key. Re-running a failed backup with the same ID resumes from the last checkpoint.
- **Blast radius**: Backup operations run with resource limits (CPU/memory cgroups in K8s) to prevent impact on live traffic. MongoDB backups use `--readPreference secondaryPreferred` to avoid loading the primary.

---

## 8. How to Consume

### Studio UI

Enterprise tenant admins access backup management through:

- **Settings > Backup & Recovery**: View tenant-scoped backup history, trigger on-demand backup, initiate restore to a specific point in time
- Role requirement: `tenant:admin` or `backup:manage` permission

### API (Runtime)

No direct backup API on the Runtime service. Backup coordination is handled by the Admin service.

### API (Studio)

| Method | Path                                           | Purpose                              |
| ------ | ---------------------------------------------- | ------------------------------------ |
| GET    | `/api/tenant/backups`                          | List tenant-scoped backups           |
| POST   | `/api/tenant/backups`                          | Trigger on-demand tenant backup      |
| GET    | `/api/tenant/backups/:backupId`                | Get backup details and status        |
| GET    | `/api/tenant/backups/:backupId/restore-points` | List available restore points (PITR) |
| POST   | `/api/tenant/backups/:backupId/restore`        | Initiate tenant-scoped restore       |
| GET    | `/api/tenant/backups/restore-jobs/:jobId`      | Get restore job status and progress  |

### Admin Portal

| Method | Path                                      | Purpose                                |
| ------ | ----------------------------------------- | -------------------------------------- |
| GET    | `/api/admin/backups`                      | List all backups (platform-wide)       |
| POST   | `/api/admin/backups`                      | Trigger platform-wide or tenant backup |
| GET    | `/api/admin/backups/:backupId`            | Get backup details                     |
| DELETE | `/api/admin/backups/:backupId`            | Delete a backup (with audit logging)   |
| POST   | `/api/admin/backups/:backupId/restore`    | Initiate restore operation             |
| GET    | `/api/admin/backups/:backupId/verify`     | Get verification status                |
| POST   | `/api/admin/backups/:backupId/verify`     | Trigger manual verification            |
| GET    | `/api/admin/backup-schedules`             | List backup schedules                  |
| PUT    | `/api/admin/backup-schedules/:scheduleId` | Update backup schedule                 |
| GET    | `/api/admin/backup-retention`             | Get retention policies                 |
| PUT    | `/api/admin/backup-retention`             | Update retention policies              |
| GET    | `/api/admin/dr/status`                    | DR readiness status                    |
| POST   | `/api/admin/dr/failover`                  | Initiate DR failover                   |
| POST   | `/api/admin/dr/failover/rollback`         | Rollback DR failover                   |
| GET    | `/api/admin/dr/replication-lag`           | Get cross-region replication lag       |

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. Backup and disaster recovery is an operator/admin concern. All channel data flows through the platform where it is captured in the normal backup scope (MongoDB session/message data, ClickHouse analytics).

---

## 9. Data Model

### Collections / Tables

```text
Collection: backup_records
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed) -- "platform" for platform-wide backups
  - type: enum ('full' | 'incremental' | 'tenant_export' | 'pitr_snapshot')
  - scope: enum ('platform' | 'tenant')
  - status: enum ('pending' | 'in_progress' | 'completed' | 'failed' | 'cancelled' | 'verifying' | 'verified' | 'verification_failed')
  - dataStores: [enum ('mongodb' | 'redis' | 'clickhouse')]
  - schedule: { scheduleId: string, cronExpression: string } | null  -- null for on-demand
  - storage: {
      bucket: string,
      region: string,
      paths: { mongodb: string, redis: string, clickhouse: string },
      totalSizeBytes: number,
      checksums: { mongodb: string, redis: string, clickhouse: string }  -- SHA-256
    }
  - encryption: {
      keyVersion: number,
      kmsKeyId: string,
      algorithm: 'AES-256-GCM'
    }
  - retention: {
      tier: enum ('hot' | 'warm' | 'cold' | 'archive'),
      expiresAt: Date,
      policyId: string
    }
  - pitr: {
      oplogStartTs: Date,
      oplogEndTs: Date,
      earliestRestorePoint: Date,
      latestRestorePoint: Date
    } | null
  - verification: {
      lastVerifiedAt: Date,
      status: enum ('passed' | 'failed' | 'not_verified'),
      recordCounts: { [collection: string]: number },
      sampleQueryResults: [{ query: string, expected: number, actual: number }],
      errorDetails: string | null
    }
  - replication: {
      replicatedTo: string[],  -- region identifiers
      replicationStatus: enum ('pending' | 'replicated' | 'failed'),
      replicatedAt: Date | null
    }
  - duration: { startedAt: Date, completedAt: Date | null, durationMs: number | null }
  - initiatedBy: string  -- userId or 'system' for scheduled
  - errorDetails: string | null
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, createdAt: -1 }
  - { status: 1, createdAt: -1 }
  - { 'retention.expiresAt': 1 } (TTL index for auto-cleanup)
  - { 'schedule.scheduleId': 1 }
  - { type: 1, scope: 1, tenantId: 1 }

Collection: backup_schedules
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed) -- "platform" for platform-wide
  - name: string
  - description: string
  - tier: enum ('enterprise' | 'business' | 'standard')
  - cronExpression: string
  - dataStores: [enum ('mongodb' | 'redis' | 'clickhouse')]
  - backupType: enum ('full' | 'incremental')
  - enabled: boolean
  - retentionPolicyId: string
  - lastRunAt: Date | null
  - nextRunAt: Date
  - createdBy: string
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1 }
  - { enabled: 1, nextRunAt: 1 }
  - { tier: 1 }

Collection: backup_retention_policies
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed) -- "platform" for platform-wide defaults
  - name: string
  - description: string
  - tiers: {
      hot: { durationDays: number, storageClass: 'STANDARD' },
      warm: { durationDays: number, storageClass: 'STANDARD_IA' },
      cold: { durationDays: number, storageClass: 'GLACIER' },
      archive: { durationDays: number, storageClass: 'DEEP_ARCHIVE' }
    }
  - compliancePreset: enum ('soc2' | 'gdpr' | 'hipaa' | 'custom') | null
  - minimumRetentionDays: number  -- compliance floor
  - maximumRetentionDays: number  -- GDPR data minimization ceiling
  - createdBy: string
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1 }
  - { compliancePreset: 1 }

Collection: restore_jobs
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - backupId: string (required, indexed)
  - type: enum ('full_restore' | 'tenant_restore' | 'pitr_restore')
  - targetTimestamp: Date | null  -- for PITR restores
  - status: enum ('pending' | 'validating' | 'restoring_mongodb' | 'restoring_redis' | 'restoring_clickhouse' | 'post_validation' | 'completed' | 'failed' | 'rolled_back')
  - progress: {
      overall: number (0-100),
      mongodb: { status: string, progress: number },
      redis: { status: string, progress: number },
      clickhouse: { status: string, progress: number }
    }
  - validation: {
      preRestore: { recordCounts: object, checksums: object },
      postRestore: { recordCounts: object, checksums: object, matchPercentage: number }
    }
  - initiatedBy: string
  - approvedBy: string | null  -- for two-person restore approval
  - errorDetails: string | null
  - startedAt: Date
  - completedAt: Date | null
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, createdAt: -1 }
  - { backupId: 1 }
  - { status: 1 }

Collection: dr_configurations
Fields:
  - _id: string (UUIDv7)
  - tenantId: string ('platform' for global config)
  - primaryRegion: string
  - secondaryRegion: string
  - replicationMode: enum ('s3_crr' | 'application_level')
  - failoverMode: enum ('manual' | 'semi_automatic' | 'automatic')
  - healthCheck: {
      endpoint: string,
      intervalSeconds: number,
      failureThreshold: number
    }
  - dns: {
      provider: enum ('route53' | 'cloudflare' | 'manual'),
      recordName: string,
      ttlSeconds: number
    }
  - rpoTargetMinutes: number
  - rtoTargetMinutes: number
  - lastFailoverAt: Date | null
  - lastFailoverTestAt: Date | null
  - status: enum ('active' | 'failover_in_progress' | 'failed_over' | 'degraded')
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1 } (unique)
  - { status: 1 }
```

### Key Relationships

- `backup_records.schedule.scheduleId` references `backup_schedules._id`
- `backup_records.retention.policyId` references `backup_retention_policies._id`
- `restore_jobs.backupId` references `backup_records._id`
- `backup_records.encryption.kmsKeyId` references the KMS key used from `tenant_kms_configs` / `materialized_kms_configs`
- `backup_records.tenantId` scopes all queries for tenant isolation
- Backup operations emit `audit_events` in ClickHouse for compliance trail
- Backup job orchestration uses BullMQ flows tracked in Redis

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                               | Purpose                                                      |
| -------------------------------------------------- | ------------------------------------------------------------ |
| `packages/shared/src/backup/backup-service.ts`     | Core backup orchestration: schedule, execute, verify         |
| `packages/shared/src/backup/restore-service.ts`    | Restore orchestration: validate, restore, post-validate      |
| `packages/shared/src/backup/types.ts`              | Type definitions for backup records, schedules, policies     |
| `packages/shared/src/backup/constants.ts`          | Backup constants: retention defaults, size limits, intervals |
| `packages/shared/src/backup/encryption-adapter.ts` | Backup encryption wrapper using existing EncryptionService   |

### Storage Adapters

| File                                                        | Purpose                                                  |
| ----------------------------------------------------------- | -------------------------------------------------------- |
| `packages/shared/src/backup/adapters/mongodb-adapter.ts`    | MongoDB backup/restore: mongodump, oplog archiving, PITR |
| `packages/shared/src/backup/adapters/redis-adapter.ts`      | Redis backup/restore: RDB/AOF snapshot, BullMQ state     |
| `packages/shared/src/backup/adapters/clickhouse-adapter.ts` | ClickHouse backup/restore via clickhouse-backup          |
| `packages/shared/src/backup/adapters/s3-storage-adapter.ts` | S3 upload/download, lifecycle policy management          |

### Routes / Handlers

| File                                                                 | Purpose                               |
| -------------------------------------------------------------------- | ------------------------------------- |
| `apps/admin/src/routes/backup-routes.ts`                             | Admin backup management API endpoints |
| `apps/admin/src/routes/dr-routes.ts`                                 | Disaster recovery API endpoints       |
| `apps/studio/src/app/api/tenant/backups/route.ts`                    | Tenant-scoped backup API (Studio)     |
| `apps/studio/src/app/api/tenant/backups/[backupId]/restore/route.ts` | Tenant-scoped restore API (Studio)    |

### UI Components

| File                                                         | Purpose                               |
| ------------------------------------------------------------ | ------------------------------------- |
| `apps/admin/src/pages/backup-management.tsx`                 | Backup overview dashboard             |
| `apps/admin/src/pages/disaster-recovery.tsx`                 | DR status and failover control panel  |
| `apps/admin/src/components/backup/BackupScheduleEditor.tsx`  | Cron schedule configuration           |
| `apps/admin/src/components/backup/RestoreWizard.tsx`         | Multi-step restore workflow           |
| `apps/admin/src/components/backup/RetentionPolicyEditor.tsx` | Retention tier configuration          |
| `apps/admin/src/components/backup/PITRTimeline.tsx`          | Point-in-time restore timeline picker |
| `apps/studio/src/components/settings/BackupRecovery.tsx`     | Tenant backup management in Studio    |

### Jobs / Workers / Background Processes

| File                                                             | Purpose                                                      |
| ---------------------------------------------------------------- | ------------------------------------------------------------ |
| `packages/shared/src/backup/workers/backup-orchestrator.ts`      | BullMQ parent job: coordinates per-store backup child jobs   |
| `packages/shared/src/backup/workers/mongodb-backup-worker.ts`    | BullMQ child job: MongoDB snapshot + oplog archiving         |
| `packages/shared/src/backup/workers/redis-backup-worker.ts`      | BullMQ child job: Redis RDB/AOF backup                       |
| `packages/shared/src/backup/workers/clickhouse-backup-worker.ts` | BullMQ child job: ClickHouse incremental/full backup         |
| `packages/shared/src/backup/workers/verification-worker.ts`      | BullMQ job: restore-to-scratch verification                  |
| `packages/shared/src/backup/workers/replication-worker.ts`       | BullMQ job: cross-region backup replication                  |
| `packages/shared/src/backup/workers/retention-cleanup-worker.ts` | BullMQ cron job: expired backup cleanup per retention policy |
| `packages/shared/src/backup/workers/oplog-archiver.ts`           | Continuous oplog tailing and S3 archiving                    |

### Tests

| File                                                              | Type        | Coverage Focus                        |
| ----------------------------------------------------------------- | ----------- | ------------------------------------- |
| `packages/shared/src/__tests__/backup/backup-service.test.ts`     | unit        | Backup orchestration logic            |
| `packages/shared/src/__tests__/backup/restore-service.test.ts`    | unit        | Restore orchestration logic           |
| `packages/shared/src/__tests__/backup/mongodb-adapter.test.ts`    | unit        | MongoDB backup/restore operations     |
| `packages/shared/src/__tests__/backup/redis-adapter.test.ts`      | unit        | Redis backup/restore operations       |
| `packages/shared/src/__tests__/backup/clickhouse-adapter.test.ts` | unit        | ClickHouse backup/restore operations  |
| `packages/shared/src/__tests__/backup/encryption-adapter.test.ts` | unit        | Backup encryption integration         |
| `packages/shared/src/__tests__/backup/retention-policy.test.ts`   | unit        | Retention tier transitions, TTL logic |
| `apps/admin/src/__tests__/backup-routes.test.ts`                  | integration | Admin backup API endpoints            |
| `apps/admin/src/__tests__/dr-routes.test.ts`                      | integration | DR API endpoints                      |
| `apps/admin/src/__tests__/e2e/backup-e2e.test.ts`                 | e2e         | Full backup/restore lifecycle via API |
| `apps/admin/src/__tests__/e2e/dr-failover-e2e.test.ts`            | e2e         | DR failover and rollback via API      |

---

## 11. Configuration

### Environment Variables

| Variable                            | Default          | Description                                             |
| ----------------------------------- | ---------------- | ------------------------------------------------------- |
| `BACKUP_S3_BUCKET`                  | (required)       | S3 bucket name for backup storage                       |
| `BACKUP_S3_REGION`                  | `us-east-1`      | Primary S3 region                                       |
| `BACKUP_S3_ACCESS_KEY_ID`           | (required)       | S3 access key (or use IAM role)                         |
| `BACKUP_S3_SECRET_ACCESS_KEY`       | (required)       | S3 secret key (or use IAM role)                         |
| `BACKUP_S3_ENDPOINT`                | (AWS default)    | Custom S3 endpoint (for MinIO, etc.)                    |
| `BACKUP_S3_REPLICA_BUCKET`          | (optional)       | Secondary region S3 bucket for cross-region replication |
| `BACKUP_S3_REPLICA_REGION`          | (optional)       | Secondary S3 region                                     |
| `BACKUP_ENCRYPTION_ENABLED`         | `true`           | Enable backup artifact encryption                       |
| `BACKUP_MONGODB_URI`                | (from MONGO_URI) | MongoDB connection string for backup operations         |
| `BACKUP_REDIS_URL`                  | (from REDIS_URL) | Redis connection string for backup operations           |
| `BACKUP_CLICKHOUSE_HOST`            | (from CH config) | ClickHouse host for backup operations                   |
| `BACKUP_VERIFICATION_ENABLED`       | `true`           | Enable automated backup verification                    |
| `BACKUP_VERIFICATION_CRON`          | `0 6 * * 0`      | Weekly verification schedule (Sunday 6 AM)              |
| `BACKUP_OPLOG_ARCHIVE_INTERVAL_S`   | `60`             | Oplog archiving interval in seconds                     |
| `BACKUP_OPLOG_ARCHIVE_SIZE_MB`      | `10`             | Oplog archive chunk size threshold in MB                |
| `BACKUP_MAX_CONCURRENT_JOBS`        | `2`              | Max concurrent backup jobs                              |
| `BACKUP_ONDEMAND_RATE_LIMIT`        | `1`              | Max on-demand backups per tenant per hour               |
| `DR_FAILOVER_MODE`                  | `manual`         | Failover mode: manual, semi_automatic, automatic        |
| `DR_HEALTH_CHECK_INTERVAL_S`        | `30`             | DR health check interval in seconds                     |
| `DR_HEALTH_CHECK_FAILURE_THRESHOLD` | `3`              | Consecutive health check failures before alert          |

### Runtime Configuration

- **Backup schedules**: Configurable per tier via `backup_schedules` collection
  - Enterprise: Full daily + incremental hourly + continuous oplog
  - Business: Full daily + incremental every 6 hours
  - Standard: Full daily
- **Retention policies**: Configurable per tier via `backup_retention_policies` collection with compliance presets
  - SOC2: 90 days minimum retention
  - GDPR: Maximum retention bounded by data minimization (configurable, default 365 days)
  - HIPAA: 6 years minimum for records containing PHI
- **DR configuration**: Per-platform via `dr_configurations` collection
- **Feature flags**: `backup.enabled`, `backup.pitr.enabled`, `backup.crossRegion.enabled`, `backup.tenantSelfService.enabled`

### DSL / Agent IR / Schema

Not applicable. Backup & Disaster Recovery is an infrastructure/operator feature, not a DSL-level concept. No changes to the ABL compiler or IR are required.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                 |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Every backup record query includes `tenantId`. Tenant-scoped backups export only data matching `tenantId` across all collections. Cross-tenant backup access returns 404. |
| Project isolation | Project data is included within tenant-scoped backups. Per-project backup granularity is not supported in Phase 1; projects are restored as part of the tenant scope.     |
| User isolation    | Backup initiation is logged with `initiatedBy` (userId). Tenant admins can only manage their own tenant's backups. Platform admins can manage all backups.                |

### Security & Compliance

- **Backup encryption**: All backup artifacts encrypted with AES-256-GCM using tenant-scoped keys derived via `HKDF(masterKey, "backup:<tenantId>", "backup-encryption")` through the existing `EncryptionService` and KMS infrastructure
- **Immutable backups**: S3 Object Lock (Governance mode) prevents backup deletion during retention period, protecting against ransomware and accidental deletion
- **Access control**: Backup management requires `backup:manage` permission (platform admin) or `tenant:backup:manage` (enterprise tenant admin). Restore operations require `backup:restore` with optional two-person approval for production restores
- **Audit trail**: Every backup/restore operation emits an audit event to `audit_events` in ClickHouse with operator identity, action, target, and result
- **SOC2 compliance**: Automated backup schedules, verification results, and retention policy enforcement provide evidence for Availability Trust Services Criteria (A1.2, A1.3)
- **GDPR compliance**: Tenant-scoped backup encryption enables crypto-shredding (delete tenant encryption key to render backup data irrecoverable). Backup retention policies enforce data minimization ceilings. Right-to-erasure requests are logged with backup purge status
- **HIPAA compliance**: 6-year retention option for PHI-containing backups, encrypted storage, access logging, and verified restore capability satisfy 45 CFR 164.308(a)(7) contingency plan requirements
- **Network security**: Backup data transfer uses TLS 1.3. S3 access via VPC endpoints (no public internet). Cross-region replication uses AWS S3 CRR with server-side encryption

### Performance & Scalability

- **Backup window impact**: MongoDB backups use `--readPreference secondaryPreferred` to avoid loading the primary. ClickHouse backups use hard-link snapshots for near-zero I/O impact. Redis RDB snapshots use `BGSAVE` (background fork)
- **Resource limits**: Backup worker pods have dedicated K8s resource limits (e.g., 2 CPU, 4GB RAM) to prevent impact on live traffic
- **Concurrent job control**: Maximum 2 concurrent backup jobs per cluster (configurable) to limit I/O and network saturation
- **Oplog archiving throughput**: Oplog archiver must sustain >= 10MB/s write throughput to S3 to keep up with high-write workloads without accumulating lag
- **S3 multipart upload**: Backup artifacts > 100MB use S3 multipart upload with 64MB parts for reliable large file transfer
- **Compression**: Backup artifacts are compressed with gzip (MongoDB/Redis) or Zstd (ClickHouse) before encryption, reducing storage costs by 40-70%

### Reliability & Failure Modes

- **Backup job retry**: Failed backup jobs are retried up to 3 times with exponential backoff (1 min, 5 min, 15 min). Persistent failures trigger an alert and mark the backup as `failed`
- **Partial backup handling**: If one data store backup fails (e.g., ClickHouse) but others succeed, the backup is marked `partial_failed` with per-store status. Partial backups are not eligible for restore
- **Restore idempotency**: Restore operations use UUIDv7 job IDs as idempotency keys. Re-running a failed restore resumes from the last checkpoint
- **Restore rollback**: Before restoring, the system creates a pre-restore snapshot. If restore validation fails (record count mismatch > 5%), the system automatically rolls back to the pre-restore state
- **Oplog gap detection**: The oplog archiver detects gaps (oplog rolled over before archiving) and alerts. PITR is only available up to the last continuous oplog timestamp
- **S3 availability**: If S3 is temporarily unavailable, backup jobs retry with backoff. If prolonged (>30 min), backup is marked failed and alert is sent
- **DR failover safety**: Failover requires explicit confirmation (manual mode) or consecutive health check failures above threshold (semi-automatic). Automatic failover includes a 60-second grace period before DNS cutover
- **Split-brain prevention**: During failover, the old primary is fenced (MongoDB stepDown, Redis FAILOVER) before the new primary is promoted

### Observability

- **Metrics** (Prometheus):
  - `backup_job_duration_seconds` (histogram, labels: type, scope, data_store, status)
  - `backup_job_size_bytes` (gauge, labels: type, data_store)
  - `backup_job_status` (counter, labels: status)
  - `backup_verification_status` (counter, labels: status)
  - `backup_replication_lag_seconds` (gauge)
  - `backup_oplog_archive_lag_seconds` (gauge)
  - `backup_retention_expired_total` (counter)
  - `dr_health_check_status` (gauge, labels: region)
  - `dr_failover_total` (counter, labels: type)
- **Logs**: Structured logging via `createLogger('backup')` with `backupId`, `tenantId`, `dataStore`, `operation` context fields
- **Alerts**:
  - Backup job failure (any backup fails after all retries)
  - Backup verification failure (restore-to-scratch test fails)
  - Oplog archiving lag > 5 minutes
  - Cross-region replication lag > RPO target
  - DR health check failures > threshold
  - Backup storage utilization > 80%
- **Dashboard**: Grafana dashboard with backup job history, verification trend, replication lag timeline, and DR readiness score

### Data Lifecycle

- **Retention tiers**: Backups transition through hot -> warm -> cold -> archive -> deleted based on age and tier configuration
- **S3 lifecycle rules**: Automatically transition backup objects between S3 storage classes (STANDARD -> STANDARD_IA -> GLACIER -> DEEP_ARCHIVE) based on retention tier boundaries
- **TTL index**: `backup_records` collection has a TTL index on `retention.expiresAt` for automatic metadata cleanup
- **S3 cleanup worker**: Separate worker deletes S3 objects after backup metadata is TTL-expired, with 24-hour grace period
- **Compliance floor**: Retention policies enforce minimum retention periods per compliance framework (SOC2: 90 days, HIPAA: 6 years). Backups cannot be deleted before the compliance floor
- **GDPR ceiling**: Retention policies enforce maximum retention per GDPR data minimization. Backups exceeding the ceiling are auto-deleted
- **Tenant offboarding**: When a tenant is deactivated, their backup data follows the tenant data retention policy (configurable, default 90 days post-deactivation)

---

## 13. Delivery Plan / Work Breakdown

### Phase 1: Foundation (Weeks 1-3)

1. Core backup infrastructure
   1.1 Define data models (backup_records, backup_schedules, backup_retention_policies, restore_jobs) with Mongoose schemas
   1.2 Implement S3 storage adapter (upload, download, multipart, lifecycle rules)
   1.3 Implement backup encryption adapter (wrapping EncryptionService for backup-scoped keys)
   1.4 Implement BullMQ backup orchestrator (parent/child job flow pattern)
   1.5 Add backup constants and type definitions
2. MongoDB backup adapter
   2.1 Implement mongodump-based full snapshot backup
   2.2 Implement mongorestore-based full restore
   2.3 Add tenant-scoped export (filtered by tenantId)
   2.4 Add tenant-scoped restore (merge with upsert semantics)
3. Redis backup adapter
   3.1 Implement RDB snapshot capture and S3 upload
   3.2 Implement RDB restore from S3
   3.3 Add BullMQ job state preservation logic
4. ClickHouse backup adapter
   4.1 Integrate clickhouse-backup for full backups
   4.2 Integrate clickhouse-backup for incremental backups
   4.3 Implement restore with materialized view rebuild

### Phase 2: Scheduling & Retention (Weeks 4-5)

5. Backup scheduling
   5.1 Implement cron-based backup schedule execution via BullMQ repeatable jobs
   5.2 Add per-tier schedule defaults (Enterprise/Business/Standard)
   5.3 Implement schedule management CRUD APIs (Admin)
6. Retention policies
   6.1 Implement retention policy model and CRUD APIs
   6.2 Implement compliance presets (SOC2, GDPR, HIPAA)
   6.3 Implement retention cleanup worker (S3 lifecycle + metadata TTL)
   6.4 Add S3 lifecycle rule configuration per retention tier

### Phase 3: PITR & Verification (Weeks 6-8)

7. MongoDB Point-in-Time Recovery
   7.1 Implement continuous oplog archiver (tail + S3 upload)
   7.2 Implement oplog gap detection and alerting
   7.3 Implement PITR restore (snapshot + oplog replay to target timestamp)
   7.4 Add PITR timeline API (available restore points)
8. Backup verification
   8.1 Implement restore-to-scratch verification worker
   8.2 Add integrity checks (record count, checksums, sample queries)
   8.3 Implement verification scheduling (weekly by default)
   8.4 Add verification status tracking and alerting

### Phase 4: Admin UI & Tenant Self-Service (Weeks 9-11)

9. Admin Portal UI
   9.1 Backup overview dashboard
   9.2 Schedule configuration editor
   9.3 Retention policy editor with compliance presets
   9.4 Restore wizard with progress tracking
   9.5 PITR timeline picker component
10. Tenant self-service (Studio)
    10.1 Tenant backup history view
    10.2 On-demand backup trigger (rate-limited)
    10.3 Tenant restore initiation with progress tracking
11. Monitoring and alerting
    11.1 Prometheus metrics for backup jobs, verification, replication
    11.2 Alert rules for backup failures, lag, storage
    11.3 Grafana dashboard

### Phase 5: Disaster Recovery (Weeks 12-15)

12. Cross-region replication
    12.1 Implement replication worker (S3 CRR or application-level copy)
    12.2 Add replication lag monitoring and alerting
    12.3 Verify backup accessibility in secondary region
13. DR orchestration
    13.1 Implement DR configuration model and APIs
    13.2 Implement health check probe for primary region
    13.3 Implement failover API (DNS cutover, service promotion)
    13.4 Implement failover rollback
    13.5 Add DR readiness dashboard
14. DR testing and runbooks
    14.1 Create DR failover runbook documentation
    14.2 Implement DR drill mode (non-destructive failover test)
    14.3 Add DR test scheduling and result tracking

### Phase 6: Hardening & Compliance (Weeks 16-18)

15. Audit and compliance
    15.1 Emit audit events for all backup/restore operations
    15.2 Implement GDPR tenant backup erasure (crypto-shredding)
    15.3 Implement two-person approval for production restores
    15.4 Add S3 Object Lock for immutable backup protection
16. E2E testing and validation
    16.1 Full backup/restore lifecycle E2E tests
    16.2 Tenant-scoped backup isolation E2E tests
    16.3 PITR E2E tests
    16.4 DR failover E2E tests
    16.5 Backup verification E2E tests
17. Performance and chaos testing
    17.1 Backup under load testing (concurrent operations)
    17.2 Restore timing validation against RTO targets
    17.3 Chaos testing (data store failure during backup, S3 outage simulation)

---

## 14. Success Metrics

| Metric                              | Baseline | Target                                 | How Measured                                          |
| ----------------------------------- | -------- | -------------------------------------- | ----------------------------------------------------- |
| Backup success rate                 | N/A      | >= 99.9%                               | `backup_job_status{status="completed"}` / total       |
| RPO achievement (Enterprise)        | N/A      | < 5 minutes                            | `backup_oplog_archive_lag_seconds` P99                |
| RPO achievement (Business)          | N/A      | < 1 hour                               | Time since last successful backup per tenant          |
| RPO achievement (Standard)          | N/A      | < 24 hours                             | Time since last successful backup per tenant          |
| RTO achievement (Enterprise)        | N/A      | < 15 minutes                           | Restore job duration in DR drill                      |
| RTO achievement (Business)          | N/A      | < 1 hour                               | Restore job duration in DR drill                      |
| RTO achievement (Standard)          | N/A      | < 4 hours                              | Restore job duration in DR drill                      |
| Backup verification pass rate       | N/A      | >= 99%                                 | `backup_verification_status{status="passed"}` / total |
| Cross-region replication lag        | N/A      | < RPO target per tier                  | `backup_replication_lag_seconds` P99                  |
| DR failover time                    | N/A      | < 15 minutes (manual) / < 5 min (auto) | DR drill execution time                               |
| Backup storage cost efficiency      | N/A      | < $0.05/GB/month (after compression)   | S3 storage cost per GB of backed-up data              |
| Compliance audit pass               | N/A      | SOC2 + GDPR + HIPAA certification      | External audit certification                          |
| Tenant self-service restore success | N/A      | >= 95% success rate                    | Tenant restore job completion rate                    |
| Mean time to detect backup failure  | N/A      | < 5 minutes                            | Time from job failure to alert delivery               |

---

## 15. Open Questions

1. **MongoDB backup tooling**: Should we use `mongodump`/`mongorestore` (simpler, more portable) or Percona Backup for MongoDB (PBM) (native PITR, better sharded cluster support)? PBM adds operational complexity but provides more robust PITR for sharded deployments.
2. **Per-project backup granularity**: Enterprise customers may want project-scoped backup/restore (e.g., restore a single project without affecting others). This adds significant complexity to the restore pipeline. Should we plan for this in Phase 2 or defer indefinitely?
3. **ClickHouse backup granularity**: Should ClickHouse backups be full-cluster or per-tenant? Per-tenant ClickHouse backup requires table-level export with tenant filtering, which is slower than native clickhouse-backup. Should we accept cluster-level backup with tenant-scoped MongoDB/Redis for initial release?
4. **Two-person approval**: For production restores, should we enforce two-person approval (initiator + approver) by default, or make it a configurable policy? What role permissions should the approver have?
5. **Backup storage budget**: What is the expected storage budget for backups? Cross-region replication doubles storage costs. Should cross-region replication be enterprise-only?
6. **DR failover automation level**: Should automatic failover be supported at launch, or should we start with manual/semi-automatic only? Automatic failover introduces split-brain risk if health checks produce false positives.
7. **Existing infrastructure**: Does the deployment environment (abl-platform-infra) already have S3 buckets, cross-region replication, or MongoDB replica set members in a secondary region? What infrastructure exists today?
8. **BullMQ job queue recovery**: After a Redis restore, BullMQ may have stale or duplicate jobs. What is the correct recovery procedure -- drain and requeue, or rely on job idempotency?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                             | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | No per-project backup granularity -- tenant-scoped backups restore all projects within a tenant, no selective project restore                           | Medium   | Open   |
| GAP-002 | ClickHouse tenant-scoped backup requires row-level export (slow for large tables), native clickhouse-backup operates at table/database level            | Medium   | Open   |
| GAP-003 | Redis tenant-scoped backup relies on key prefix scanning (SCAN), which may be slow for tenants with millions of keys                                    | Medium   | Open   |
| GAP-004 | No automatic failover in Phase 1 -- DR failover requires manual operator action or semi-automatic confirmation                                          | Low      | Open   |
| GAP-005 | Oplog-based PITR requires sufficient oplog window; high-write workloads may roll the oplog before archival catches up, creating gaps                    | High     | Open   |
| GAP-006 | BullMQ job state recovery after Redis restore may produce duplicate job execution -- requires idempotency at the job handler level                      | Medium   | Open   |
| GAP-007 | Backup verification (restore-to-scratch) requires a scratch database cluster, adding infrastructure cost and operational complexity                     | Medium   | Open   |
| GAP-008 | GDPR right-to-erasure from backup artifacts relies on crypto-shredding (tenant key deletion) -- actual ciphertext remains in S3 until retention expires | Low      | Open   |
| GAP-009 | Cross-region replication lag monitoring depends on S3 replication metrics (CRR) or application-level heartbeat -- no sub-minute precision available     | Low      | Open   |
| GAP-010 | No backup for Qdrant vector indexes -- vectors must be rebuilt from source documents after restore, adding to RTO                                       | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                 | Coverage Type | Status     | Test File / Note              |
| --- | ---------------------------------------- | ------------- | ---------- | ----------------------------- |
| 1   | MongoDB full backup creation and restore | e2e           | NOT TESTED | `backup-e2e.test.ts`          |
| 2   | Redis RDB backup creation and restore    | e2e           | NOT TESTED | `backup-e2e.test.ts`          |
| 3   | ClickHouse backup creation and restore   | e2e           | NOT TESTED | `backup-e2e.test.ts`          |
| 4   | Tenant-scoped backup isolation           | e2e           | NOT TESTED | `backup-e2e.test.ts`          |
| 5   | PITR restore to specific timestamp       | e2e           | NOT TESTED | `pitr-e2e.test.ts`            |
| 6   | Backup encryption integration            | integration   | NOT TESTED | `backup-encryption.test.ts`   |
| 7   | Backup verification (restore-to-scratch) | e2e           | NOT TESTED | `verification-e2e.test.ts`    |
| 8   | Cross-region backup replication          | e2e           | NOT TESTED | `replication-e2e.test.ts`     |
| 9   | DR failover and rollback                 | e2e           | NOT TESTED | `dr-failover-e2e.test.ts`     |
| 10  | Backup retention policy enforcement      | integration   | NOT TESTED | `retention-policy.test.ts`    |
| 11  | On-demand backup rate limiting           | integration   | NOT TESTED | `backup-routes.test.ts`       |
| 12  | Backup audit event emission              | integration   | NOT TESTED | `backup-audit.test.ts`        |
| 13  | Restore rollback on validation failure   | integration   | NOT TESTED | `restore-rollback.test.ts`    |
| 14  | Backup job retry and failure handling    | unit          | NOT TESTED | `backup-orchestrator.test.ts` |
| 15  | S3 multipart upload for large backups    | unit          | NOT TESTED | `s3-storage-adapter.test.ts`  |

### Testing Notes

No tests exist yet as this feature is in PLANNED status. The test plan requires real database instances (MongoDB, Redis, ClickHouse) and S3-compatible storage (MinIO for local testing) for E2E and integration tests. Unit tests can mock storage adapters. See the detailed test spec for comprehensive scenario definitions.

> Full testing details: [../testing/backup-disaster-recovery.md](../testing/backup-disaster-recovery.md)

---

## 18. References

- Design docs: `docs/specs/backup-disaster-recovery.hld.md` (planned)
- Implementation plans: `docs/plans/<date>-backup-disaster-recovery-impl-plan.md` (planned)
- Related feature docs: [Encryption at Rest](./encryption-at-rest.md), [Audit Logging](./audit-logging.md), [Alerts](./alerts.md)
- Industry references:
  - [MongoDB Backup and Recovery Enterprise Guide](https://www.queryleaf.com/blog/2025/10/30/mongodb-backup-and-recovery-for-enterprise-data-protection-advanced-disaster-recovery-strategies-point-in-time-recovery-and-operational-resilience/)
  - [MongoDB Disaster Recovery](https://www.mongodb.com/resources/basics/disaster-recovery)
  - [Redis Backup & Disaster Recovery](https://redis.io/technology/backup-disaster-recovery/)
  - [Redis Persistence Documentation](https://redis.io/docs/latest/operate/oss_and_stack/management/persistence/)
  - [ClickHouse Backup & Restore](https://clickhouse.com/docs/operations/backup/overview)
  - [Altinity clickhouse-backup](https://github.com/Altinity/clickhouse-backup)
  - [Percona Backup for MongoDB - PITR](https://docs.percona.com/percona-backup-mongodb/features/point-in-time-recovery.html)
  - [AWS RPO/RTO Targets for Cloud Applications](https://aws.amazon.com/blogs/mt/establishing-rpo-and-rto-targets-for-cloud-applications/)
  - [Kubernetes Disaster Recovery Patterns](https://portworx.com/kubernetes-disaster-recovery/)
  - [SOC 2 Backup Requirements](https://pungroup.cpa/blog/soc-2-backup-requirements/)
  - [SOC 2 Data Retention Guide](https://www.konfirmity.com/blog/soc-2-data-retention-guide)
  - [Disaster Recovery for SaaS - Strategy Guide](https://atozdebug.com/disaster-recovery-for-saas/)
