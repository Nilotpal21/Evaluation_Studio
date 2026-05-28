# Feature: Data Retention / TTL Policies

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `governance`, `enterprise`, `admin operations`
**Package(s)**: `packages/shared` (retention-policy module), `packages/database` (TTL indexes, ClickHouse DDL, retention repo), `apps/runtime` (enforcement workers), `apps/admin` (retention dashboard), `apps/studio` (project-level settings)
**Owner(s)**: Platform team
**Testing Guide**: [../testing/data-retention-ttl.md](../testing/data-retention-ttl.md)
**Last Updated**: 2026-03-23

---

## 1. Introduction / Overview

### Problem Statement

The ABL platform stores data across five storage layers -- MongoDB (sessions, conversations, agent configs, messages), ClickHouse (traces, analytics, audit logs, platform events), Redis (cache, rate-limit state, BullMQ job queues), S3 (uploaded files, attachments, export artifacts), and Qdrant (vector embeddings). Today, data retention is managed ad hoc: ClickHouse tables have hardcoded TTL clauses in DDL (e.g., 730 days for messages, 30 days for logs), MongoDB has a few TTL indexes on specific models (PII audit logs at 90 days, session tokens, workspace invitations), BullMQ jobs have per-queue `removeOnComplete`/`removeOnFail` settings, and S3 has no lifecycle policies managed by the platform.

This creates several problems:

1. **No tenant-configurable retention**: All tenants share the same hardcoded retention periods. Enterprise customers requiring 7-year retention for compliance and free-tier tenants generating unbounded data are treated identically.
2. **No legal hold**: There is no mechanism to suspend deletion when data is subject to litigation or regulatory investigation, creating legal liability.
3. **Inconsistent enforcement**: Each storage layer implements its own deletion timing (ClickHouse TTL merges every 24 hours, MongoDB TTL thread runs every 60 seconds, Redis expires lazily), with no unified policy engine or enforcement audit trail.
4. **No archival before deletion**: Data transitions directly from hot storage to deletion. There is no cold-archive pipeline for cost-effective long-term storage of data that must be retained but rarely accessed.
5. **Incomplete GDPR compliance**: While crypto-shredding exists for contact PII (encryption-at-rest feature), there is no systematic right-to-erasure cascade across all storage layers, and no proof-of-deletion for audit purposes.
6. **Audit log retention ambiguity**: Audit logs in ClickHouse move to cold storage after 90 days but are never deleted -- a compliance risk if retention exceeds the legally required period, and a cost issue at scale.

### Goal Statement

Provide a unified, tenant-configurable data retention policy engine that enforces tiered TTL policies across all five storage layers (MongoDB, ClickHouse, Redis, S3, Qdrant), supports legal hold overrides, generates deletion audit trails, enables archival to cold storage before deletion, and exposes a retention management dashboard in the admin portal -- delivering SOC 2, GDPR, and HIPAA compliance for data lifecycle management.

### Summary

The Data Retention / TTL Policies feature introduces a centralized retention policy engine (`packages/shared/src/retention/`) that:

1. **Policy definition**: Tenant-configurable retention policies per data classification (PII, operational, analytics, audit, configuration) with plan-based defaults (free: 30 days sessions / 90 days analytics, enterprise: 2 years / 7 years).
2. **Enforcement workers**: BullMQ-based retention scheduler jobs that scan each storage layer, identify expired data (respecting legal holds), archive eligible data to cold storage, and execute deletion with idempotent, batched operations.
3. **Legal hold**: Compliance-hold and litigation-hold overrides that suspend all deletion for specified tenants, projects, or individual resources -- with hold lifecycle tracking and automatic resumption.
4. **Deletion audit trail**: Every deletion operation emits an immutable audit event to ClickHouse (`retention_events` table) recording what was deleted, when, by which policy, and a cryptographic hash of the deleted data for non-repudiation.
5. **Admin dashboard**: A retention management UI in the admin portal showing per-tenant policy configuration, enforcement history, storage utilization trends, and legal hold status.
6. **GDPR cascade**: A right-to-erasure API that cascades deletion across all storage layers for a given contact/user, integrating with the existing crypto-shredding mechanism.

---

## 2. Scope

### Goals

- Centralized retention policy model with tenant-scoped, project-scoped, and data-classification-scoped TTL configuration
- Plan-based default retention tiers (free, professional, enterprise) with operator-configurable overrides
- Enforcement workers for all five storage layers: MongoDB (batched deletes + TTL index management), ClickHouse (partition-aligned TTL ALTER), Redis (key pattern expiration + BullMQ job cleanup), S3 (lifecycle policy generation), Qdrant (collection-level TTL)
- Legal hold / compliance hold with hold lifecycle (create, extend, release) and automatic deletion resumption
- Archival pipeline: hot -> warm -> cold -> archive -> delete, with configurable transitions per data classification
- Deletion audit trail with cryptographic proof (SHA-256 hash of deleted records)
- GDPR right-to-erasure cascade API integrating with crypto-shredding
- Admin portal dashboard for retention policy management, enforcement monitoring, and legal hold administration
- Retention metrics and alerting (enforcement lag, deletion backlog, hold count, storage utilization)
- Data classification taxonomy with automatic classification based on collection/table metadata

### Non-Goals (Out of Scope)

- Client-side data retention management (retention is always server-side/operator-managed)
- Per-field retention within a single document (retention is per-document/per-row granularity)
- Real-time deletion guarantees (enforcement is batch-based with configurable intervals)
- Cross-region data residency policies (addressed separately by a data-residency feature)
- Backup tape/media destruction (backup retention is managed by infrastructure, not the application)
- Retention policies for third-party integrations' data stores (only platform-managed storage)
- Automated data classification via ML/NLP (initial classification is metadata-based; ML classification is a future enhancement)

---

## 3. User Stories

1. As a **platform operator**, I want to define default retention periods for each data classification so that storage costs are controlled and compliance baselines are enforced across all tenants.
2. As a **tenant admin**, I want to configure retention periods for my tenant's data (sessions, analytics, audit logs) so that I can meet my organization's data governance requirements.
3. As a **compliance officer**, I want immutable deletion audit logs with cryptographic proof so that I can demonstrate data lifecycle compliance during SOC 2 and HIPAA audits.
4. As a **data protection officer (DPO)**, I want a GDPR right-to-erasure API that cascades deletion across all storage layers so that I can fulfill data subject access requests (DSARs) within the 30-day regulatory deadline.
5. As a **legal counsel**, I want to place a legal hold on specific tenants or projects so that data subject to litigation is preserved regardless of normal retention policies.
6. As a **auditor**, I want to view retention enforcement history showing what was deleted, when, and by which policy so that I can verify that retention policies are consistently enforced.
7. As a **enterprise customer**, I want extended retention periods (up to 7 years for audit logs, 2 years for sessions) so that I can meet financial services regulatory requirements.
8. As a **platform operator**, I want data to be archived to cold storage before final deletion so that I can recover data in case of accidental policy misconfiguration during a grace period.
9. As a **security engineer**, I want retention enforcement to respect encryption key lifecycle so that archived data remains decryptable and deleted data has its encryption keys destroyed.
10. As a **project manager**, I want project-level retention overrides so that test projects can have shorter retention (7 days) while production projects retain data longer.
11. As a **billing administrator**, I want storage utilization reports broken down by data classification and retention tier so that I can forecast infrastructure costs.
12. As a **DevOps engineer**, I want retention enforcement workers to be observable via metrics and alerts so that I can detect and respond to enforcement failures or backlogs.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide a `RetentionPolicy` data model that supports per-tenant, per-project, and per-data-classification retention period configuration with the fields: `tenantId`, `projectId` (optional), `dataClassification`, `retentionDays`, `archivalDays` (optional), `isDefault`, and `effectiveFrom`.
2. **FR-2**: The system must enforce plan-based default retention tiers: free (sessions: 30d, analytics: 90d, audit: 365d, logs: 14d), professional (sessions: 180d, analytics: 365d, audit: 3y, logs: 30d), enterprise (sessions: 730d, analytics: 730d, audit: 7y, logs: 90d).
3. **FR-3**: The system must resolve the effective retention period for any data item using the precedence chain: resource-level override > project-level policy > tenant-level policy > plan default > platform default.
4. **FR-4**: The system must provide a `LegalHold` data model with fields: `tenantId`, `projectId` (optional), `holdType` (litigation | compliance | regulatory), `reason`, `createdBy`, `createdAt`, `expiresAt` (optional), `releasedAt`, `resourceFilters` (optional collection/table/ID patterns).
5. **FR-5**: The system must suspend all deletion operations for resources covered by an active legal hold, even when the retention period has expired.
6. **FR-6**: The system must run retention enforcement workers as BullMQ repeatable jobs with configurable intervals (default: every 6 hours for MongoDB/ClickHouse, every 1 hour for Redis, every 24 hours for S3/Qdrant).
7. **FR-7**: The system must execute MongoDB retention enforcement using batched `deleteMany` operations (default batch size: 1,000) with configurable rate limiting (default: 500ms delay between batches) to minimize impact on production workloads.
8. **FR-8**: The system must execute ClickHouse retention enforcement by generating `ALTER TABLE ... MODIFY TTL` statements aligned with the tenant's configured retention periods, using `ttl_only_drop_parts = 1` for efficient partition-level deletion.
9. **FR-9**: The system must execute Redis retention enforcement by scanning key patterns with `SCAN` (never `KEYS`), applying `EXPIRE` commands for keys without TTL, and cleaning BullMQ completed/failed job data beyond the configured retention.
10. **FR-10**: The system must generate S3 lifecycle policy configurations for each tenant's upload bucket prefix, transitioning objects through storage classes (Standard -> Standard-IA at archivalDays, Standard-IA -> Glacier at retentionDays/2, Glacier -> delete at retentionDays).
11. **FR-11**: The system must emit an immutable `retention_event` to ClickHouse for every deletion operation, recording: `tenantId`, `dataClassification`, `storageLayer`, `collectionOrTable`, `recordCount`, `deletedAt`, `policyId`, `enforcementJobId`, `dataHash` (SHA-256 of deleted record IDs).
12. **FR-12**: The system must provide a GDPR right-to-erasure cascade API (`DELETE /api/admin/erasure-requests/:contactId`) that: (a) triggers crypto-shredding via encryption-at-rest, (b) deletes all contact-associated records across MongoDB collections, (c) deletes contact traces/events from ClickHouse, (d) invalidates Redis cached data, (e) deletes contact-associated S3 objects, and (f) emits a consolidated erasure audit event.
13. **FR-13**: The system must provide an archival pipeline that moves data from hot storage to a designated archive store (S3 Glacier or cold ClickHouse volume) before final deletion, with a configurable grace period (default: 30 days) during which archived data can be restored.
14. **FR-14**: The system must expose retention policy CRUD APIs in the admin portal with RBAC enforcement (`retention:manage` permission for write, `retention:view` for read).
15. **FR-15**: The system must provide a retention dashboard in the admin portal showing: active policies per tenant, enforcement history (last 30 runs), storage utilization by classification, active legal holds, and upcoming deletions forecast.
16. **FR-16**: The system must validate that retention periods do not fall below regulatory minimums per data classification (e.g., audit logs minimum 1 year, financial transaction data minimum 7 years) and reject policy updates that violate these constraints.
17. **FR-17**: The system must coordinate retention enforcement with encryption key lifecycle: when data is deleted, the associated DEK epoch entries in `dek_registry` must be checked and, if no other data references the epoch, transitioned to `destroyed` status.
18. **FR-18**: The system must support data classification labels on every MongoDB collection and ClickHouse table via a centralized `DATA_CLASSIFICATION_MANIFEST` that maps each collection/table to its classification (PII, operational, analytics, audit, configuration).

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                     |
| -------------------------- | ------------ | ------------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Project-level retention overrides; test project short-TTL                 |
| Agent lifecycle            | SECONDARY    | Agent config retention (long-lived), session data retention (TTL-managed) |
| Customer experience        | SECONDARY    | Session history availability depends on retention; archival affects UX    |
| Integrations / channels    | NONE         | Retention is transparent to channel integrations                          |
| Observability / tracing    | PRIMARY      | Traces, platform events, LLM metrics all subject to retention TTLs        |
| Governance / controls      | PRIMARY      | Core compliance feature for SOC 2, GDPR, HIPAA data lifecycle management  |
| Enterprise / compliance    | PRIMARY      | Legal hold, audit trail, tiered retention, GDPR cascade                   |
| Admin / operator workflows | PRIMARY      | Retention dashboard, policy management, legal hold administration         |

### Related Feature Integration Matrix

| Related Feature      | Relationship Type | Why It Matters                                                                                              | Key Touchpoints                                         | Current State |
| -------------------- | ----------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------- |
| Encryption at Rest   | depends on        | Retention enforcement must coordinate with DEK lifecycle; GDPR cascade integrates with crypto-shredding     | `EncryptionService`, `dek_registry`, `deriveContactKey` | BETA          |
| Audit Logging        | extends           | Deletion audit trail extends the audit event schema; audit logs have special immutable retention rules      | `audit_events` ClickHouse table, `AuditStore`           | BETA          |
| GDPR / PII Detection | depends on        | Right-to-erasure cascade depends on PII detection to identify contact-associated data across storage layers | PII vault, contact model, `has_pii` flag in ClickHouse  | ALPHA         |
| Session Management   | shares data with  | Sessions are the highest-volume MongoDB collection subject to retention; session archival affects UX        | `SessionState` model, `lastActivityAt` index            | STABLE        |
| Analytics Pipeline   | shares data with  | ClickHouse analytics tables (traces, LLM metrics, platform events) are primary targets for tiered retention | ClickHouse TTL DDL in `init.ts`, materialized views     | STABLE        |
| Backup / DR          | configured by     | Backup retention must be >= live data retention; archived data must be included in backup scope             | Infrastructure-level backup policies                    | PLANNED       |
| BullMQ Flows         | shares data with  | Job queue data (completed/failed jobs) requires retention management to prevent Redis memory growth         | `removeOnComplete`, `removeOnFail` settings             | STABLE        |
| Billing              | emits into        | Storage utilization metrics feed into billing calculations for usage-based pricing                          | Storage metrics aggregation                             | PLANNED       |
| Attachments / Files  | shares data with  | S3 uploaded files require lifecycle policy management aligned with session/message retention                | `multimodal-service`, S3 storage service                | STABLE        |

---

## 6. Design Considerations (Optional)

### Admin Portal - Retention Dashboard

The retention dashboard should be a dedicated section in the admin portal (`/admin/retention`) with the following views:

1. **Policy Overview**: Table of active retention policies grouped by tenant, showing data classification, retention period, archival period, effective date, and override count.
2. **Enforcement History**: Timeline view of retention enforcement runs with status (success/partial/failed), records processed, records deleted, duration, and next scheduled run.
3. **Storage Utilization**: Stacked bar chart showing storage consumption by data classification (PII, operational, analytics, audit, configuration) with trend lines and forecast.
4. **Legal Holds**: Active legal holds with hold type, scope (tenant/project/resource), reason, creation date, expiry, and release controls.
5. **GDPR Erasure Requests**: Queue of pending and completed erasure requests with status, affected storage layers, and completion timestamps.

### Tenant Settings - Retention Configuration

In Studio, tenant admins access retention settings via `Settings > Data Governance > Retention Policies`. The UI should allow:

- Viewing effective retention per data classification (resolved from policy precedence chain)
- Requesting retention period changes (subject to plan limits and regulatory minimums)
- Viewing enforcement history for their tenant
- No direct access to legal hold management (admin-only)

---

## 7. Technical Considerations (Optional)

- **MongoDB TTL indexes vs application-level deletion**: MongoDB TTL indexes are efficient for simple time-based expiry (single field, fixed interval). However, tenant-configurable retention requires application-level deletion because TTL indexes cannot vary per document based on tenant policy. The strategy is: use MongoDB TTL indexes for fixed-TTL collections (PII audit logs, session tokens, workspace invitations) and application-level batched deletion for tenant-configurable collections (sessions, messages, agent configs).
- **ClickHouse TTL mutation cost**: ClickHouse TTL enforcement happens during merge operations. `ALTER TABLE ... MODIFY TTL` triggers a metadata-only change; actual deletion occurs during the next merge cycle. With `ttl_only_drop_parts = 1`, ClickHouse drops whole parts when all rows are expired, which is far more efficient than row-level filtering. Partition alignment (PARTITION BY day/month) is critical for efficient deletion. Tenant-specific retention in ClickHouse is best implemented via a retention-scheduler worker that issues `ALTER TABLE ... DELETE WHERE tenant_id = ? AND created_at < ?` for tenants with non-default retention, running during off-peak hours.
- **Redis SCAN vs KEYS**: Retention enforcement for Redis must use `SCAN` with cursor-based iteration (never `KEYS *`, which blocks the event loop). BullMQ job cleanup should use the Bull `clean()` API for completed/failed jobs rather than direct key manipulation.
- **S3 lifecycle policy limits**: AWS S3 supports up to 1,000 lifecycle rules per bucket. For multi-tenant deployments with >1,000 tenants sharing a bucket, lifecycle policies must be applied at the prefix level with batched rule generation, or use a single tiered policy with application-level cleanup for tenant-specific overrides.
- **Deletion ordering for referential integrity**: Deletion must follow dependency order: messages before sessions, traces before platform events, S3 objects before MongoDB attachment records. The enforcement worker must process collections in topological order based on a dependency graph.
- **Idempotent enforcement**: Each enforcement run must be idempotent. The enforcement worker tracks progress via a `retention_enforcement_runs` MongoDB collection with `lastProcessedId` cursors, allowing safe restart after crashes without re-deleting already-processed records.
- **Encryption key coordination**: When the last document encrypted with a specific DEK epoch is deleted, the DEK should transition to `destroyed`. This requires a reference count or scan of the `dek_registry` after bulk deletion, which should be deferred to a separate background job to avoid blocking the deletion pipeline.

---

## 8. How to Consume

### Studio UI

Tenant admins access retention settings via:

- **Route**: `Settings > Data Governance > Retention Policies` (`/settings/data-governance/retention`)
- **Capabilities**: View effective retention per data classification, request changes (subject to plan limits), view enforcement history
- **Roles**: `tenant-admin` (read/write), `project-admin` (read-only for project-level overrides), `member` (no access)

### API (Runtime)

| Method | Path                                                          | Purpose                                                    |
| ------ | ------------------------------------------------------------- | ---------------------------------------------------------- |
| GET    | `/api/projects/:projectId/retention-policies`                 | List effective retention policies for a project            |
| GET    | `/api/projects/:projectId/retention-policies/:classification` | Get effective retention for a specific data classification |
| GET    | `/api/projects/:projectId/retention/enforcement-history`      | List enforcement history for the project                   |

### API (Studio)

| Method | Path                                                    | Purpose                                       |
| ------ | ------------------------------------------------------- | --------------------------------------------- |
| GET    | `/api/retention-policies`                               | List tenant retention policies (tenant-admin) |
| PUT    | `/api/retention-policies/:classification`               | Update retention for a data classification    |
| GET    | `/api/retention/enforcement-history`                    | List tenant enforcement history               |
| GET    | `/api/retention/storage-utilization`                    | Get storage utilization by classification     |
| POST   | `/api/projects/:projectId/retention-policies`           | Create project-level retention override       |
| DELETE | `/api/projects/:projectId/retention-policies/:policyId` | Remove project-level retention override       |

### Admin Portal

| Method | Path                                            | Purpose                                              |
| ------ | ----------------------------------------------- | ---------------------------------------------------- |
| GET    | `/api/admin/retention-policies`                 | List all retention policies (platform-wide)          |
| POST   | `/api/admin/retention-policies`                 | Create platform/tenant retention policy              |
| PUT    | `/api/admin/retention-policies/:policyId`       | Update a retention policy                            |
| DELETE | `/api/admin/retention-policies/:policyId`       | Delete a retention policy                            |
| GET    | `/api/admin/retention/enforcement-runs`         | List enforcement run history                         |
| POST   | `/api/admin/retention/enforcement-runs/trigger` | Manually trigger an enforcement run                  |
| GET    | `/api/admin/legal-holds`                        | List all legal holds                                 |
| POST   | `/api/admin/legal-holds`                        | Create a legal hold                                  |
| PUT    | `/api/admin/legal-holds/:holdId`                | Update a legal hold (extend, add notes)              |
| DELETE | `/api/admin/legal-holds/:holdId/release`        | Release a legal hold                                 |
| POST   | `/api/admin/erasure-requests`                   | Create a GDPR erasure request                        |
| GET    | `/api/admin/erasure-requests`                   | List erasure requests with status                    |
| GET    | `/api/admin/erasure-requests/:requestId`        | Get erasure request details and progress             |
| GET    | `/api/admin/retention/storage-utilization`      | Platform-wide storage utilization by classification  |
| GET    | `/api/admin/retention/deletion-forecast`        | Forecast upcoming deletions by tenant/classification |

### Channel / SDK / Voice / A2A / MCP Integration

Not channel-aware. Retention policies are enforced server-side by background workers. Channel integrations are not affected except that session history may become unavailable after the retention period expires.

---

## 9. Data Model

### Collections / Tables

```text
Collection: retention_policies (MongoDB)
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - projectId: string (optional, indexed)
  - dataClassification: string (required) — enum: 'pii', 'operational', 'analytics', 'audit', 'configuration', 'files'
  - retentionDays: number (required) — days before final deletion
  - archivalDays: number (optional) — days before archival (must be < retentionDays)
  - warmStorageDays: number (optional) — days before transition to warm storage
  - coldStorageDays: number (optional) — days before transition to cold storage
  - isDefault: boolean (default: false) — true for plan-level defaults
  - planTier: string (optional) — 'free', 'professional', 'enterprise' (for default policies)
  - regulatoryMinimumDays: number (optional) — enforced minimum, blocks lower values
  - effectiveFrom: Date (required)
  - effectiveUntil: Date (optional) — for scheduled policy transitions
  - createdBy: string (required)
  - updatedBy: string
  - _v: number (default: 1)
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, dataClassification: 1 } (unique, sparse on projectId)
  - { tenantId: 1, isDefault: 1 }
  - { planTier: 1, dataClassification: 1 } (for default lookup)
```

```text
Collection: legal_holds (MongoDB)
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - projectId: string (optional, indexed)
  - holdType: string (required) — enum: 'litigation', 'compliance', 'regulatory'
  - reason: string (required) — human-readable justification
  - caseReference: string (optional) — external case/ticket ID
  - scope: object — { collections: string[], tables: string[], resourceIds: string[] }
  - status: string — enum: 'active', 'released', 'expired'
  - createdBy: string (required)
  - releasedBy: string (optional)
  - createdAt: Date
  - expiresAt: Date (optional) — auto-release date
  - releasedAt: Date (optional)
  - releaseReason: string (optional)
  - notes: string[] — append-only notes log
  - _v: number (default: 1)
Indexes:
  - { tenantId: 1, status: 1 }
  - { status: 1, expiresAt: 1 } (for auto-expiry worker)
  - { tenantId: 1, projectId: 1, status: 1 }
```

```text
Collection: retention_enforcement_runs (MongoDB)
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - storageLayer: string (required) — enum: 'mongodb', 'clickhouse', 'redis', 's3', 'qdrant'
  - dataClassification: string (required)
  - status: string — enum: 'running', 'completed', 'failed', 'partial'
  - startedAt: Date (required)
  - completedAt: Date (optional)
  - recordsScanned: number (default: 0)
  - recordsArchived: number (default: 0)
  - recordsDeleted: number (default: 0)
  - recordsSkippedHold: number (default: 0)
  - bytesFreed: number (default: 0)
  - lastProcessedId: string (optional) — cursor for idempotent restart
  - policyId: string (required) — reference to retention_policies._id
  - enforcementJobId: string (required) — BullMQ job ID
  - errorMessage: string (optional)
  - _v: number (default: 1)
Indexes:
  - { tenantId: 1, startedAt: -1 }
  - { status: 1, storageLayer: 1 }
  - { policyId: 1 }
```

```text
Collection: erasure_requests (MongoDB)
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - contactId: string (required) — the data subject
  - requestType: string — enum: 'right_to_erasure', 'right_to_rectification', 'data_export'
  - status: string — enum: 'pending', 'in_progress', 'completed', 'failed', 'partially_completed'
  - requestedBy: string (required)
  - requestedAt: Date (required)
  - deadline: Date (required) — GDPR 30-day deadline
  - completedAt: Date (optional)
  - layers: object[] — [{ storageLayer, status, recordsDeleted, completedAt, error }]
  - cryptoShredded: boolean (default: false) — crypto-shredding confirmation
  - auditEventId: string (optional) — reference to consolidated audit event
  - _v: number (default: 1)
Indexes:
  - { tenantId: 1, status: 1, deadline: 1 }
  - { contactId: 1 }
  - { status: 1, deadline: 1 } (for SLA monitoring)
```

```text
ClickHouse Table: retention_events (new)
Fields:
  - tenant_id: String
  - timestamp: DateTime64(3)
  - event_id: String
  - event_type: LowCardinality(String) — 'deletion', 'archival', 'erasure', 'hold_created', 'hold_released'
  - storage_layer: LowCardinality(String) — 'mongodb', 'clickhouse', 'redis', 's3', 'qdrant'
  - collection_or_table: LowCardinality(String)
  - data_classification: LowCardinality(String)
  - record_count: UInt32
  - bytes_affected: UInt64
  - policy_id: String
  - enforcement_run_id: String
  - data_hash: String — SHA-256 of deleted record IDs for non-repudiation
  - actor_id: String
  - legal_hold_id: String (default: '')
  - metadata: String (JSON)
ENGINE: ReplicatedMergeTree
PARTITION BY: toYYYYMM(timestamp)
ORDER BY: (tenant_id, timestamp, event_type)
TTL: NONE (retention events are immutable and retained indefinitely, or per audit retention policy)
```

```text
Centralized Manifest: DATA_CLASSIFICATION_MANIFEST

MongoDB Collections:
  - sessions: 'operational'
  - messages: 'pii'
  - session_states: 'operational'
  - contacts: 'pii'
  - pii_audit_logs: 'audit'
  - llm_credentials: 'configuration'
  - auth_profiles: 'configuration'
  - environment_variables: 'configuration'
  - tool_secrets: 'configuration'
  - mcp_server_configs: 'configuration'
  - webhook_subscriptions: 'configuration'
  - channel_connections: 'configuration'
  - agent_configs: 'configuration'
  - projects: 'configuration'
  - organizations: 'configuration'

ClickHouse Tables:
  - messages: 'pii'
  - traces: 'analytics'
  - llm_metrics: 'analytics'
  - platform_events: 'analytics'
  - audit_events: 'audit'
  - logs: 'operational'
  - search_queries: 'analytics'
  - search_ingestion_events: 'operational'
  - dead_letter_events: 'operational'
  - insight_results: 'analytics'
  - retention_events: 'audit'

Redis Key Patterns:
  - 'session:*': 'operational'
  - 'cache:*': 'operational'
  - 'rate-limit:*': 'operational'
  - 'bull:*:completed': 'operational'
  - 'bull:*:failed': 'operational'

S3 Prefixes:
  - 'attachments/': 'files'
  - 'exports/': 'operational'
  - 'imports/': 'operational'
  - 'archives/': 'operational'
```

### Key Relationships

- `retention_policies` references `tenantId` from the organizations/tenants collection
- `retention_enforcement_runs.policyId` references `retention_policies._id`
- `legal_holds` can scope to specific `projectId` values and `collections`
- `erasure_requests.contactId` references the contact model; cascade deletes across all storage layers
- `retention_events` (ClickHouse) is append-only and references `policy_id` and `enforcement_run_id`
- Enforcement workers check `legal_holds` before every deletion batch
- GDPR erasure integrates with `EncryptionService.deriveContactKey` for crypto-shredding

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                            | Purpose                                                             |
| --------------------------------------------------------------- | ------------------------------------------------------------------- |
| `packages/shared/src/retention/retention-policy-engine.ts`      | Policy resolution: precedence chain, plan defaults, regulatory mins |
| `packages/shared/src/retention/data-classification-manifest.ts` | Centralized mapping of collections/tables to data classifications   |
| `packages/shared/src/retention/types.ts`                        | Type definitions: `RetentionPolicy`, `LegalHold`, `ErasureRequest`  |
| `packages/shared/src/retention/constants.ts`                    | Default retention periods, plan tiers, regulatory minimums          |
| `packages/shared/src/retention/index.ts`                        | Barrel exports                                                      |

### Routes / Handlers

| File                                                  | Purpose                                                     |
| ----------------------------------------------------- | ----------------------------------------------------------- |
| `apps/admin/src/routes/retention-policies.ts`         | Admin CRUD for retention policies                           |
| `apps/admin/src/routes/legal-holds.ts`                | Admin legal hold management                                 |
| `apps/admin/src/routes/erasure-requests.ts`           | Admin GDPR erasure request management                       |
| `apps/admin/src/routes/retention-dashboard.ts`        | Enforcement history, storage utilization, deletion forecast |
| `apps/studio/src/app/api/retention-policies/route.ts` | Tenant-level retention policy read/write                    |
| `apps/runtime/src/routes/retention-policies.ts`       | Project-level retention policy read                         |

### UI Components

| File                                                          | Purpose                                |
| ------------------------------------------------------------- | -------------------------------------- |
| `apps/admin/src/components/retention/RetentionDashboard.tsx`  | Main retention dashboard page          |
| `apps/admin/src/components/retention/PolicyTable.tsx`         | Retention policy list with edit/create |
| `apps/admin/src/components/retention/LegalHoldPanel.tsx`      | Legal hold management panel            |
| `apps/admin/src/components/retention/EnforcementTimeline.tsx` | Enforcement run history timeline       |
| `apps/admin/src/components/retention/StorageChart.tsx`        | Storage utilization stacked bar chart  |
| `apps/admin/src/components/retention/ErasureQueue.tsx`        | GDPR erasure request queue             |
| `apps/studio/src/components/settings/RetentionSettings.tsx`   | Tenant retention settings in Studio    |

### Jobs / Workers / Background Processes

| File                                                   | Purpose                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------ |
| `apps/runtime/src/jobs/retention-scheduler.ts`         | BullMQ repeatable job: schedules enforcement runs per tenant/layer |
| `apps/runtime/src/jobs/retention-mongodb-worker.ts`    | MongoDB batched deletion with legal hold check                     |
| `apps/runtime/src/jobs/retention-clickhouse-worker.ts` | ClickHouse TTL enforcement and tenant-specific deletion            |
| `apps/runtime/src/jobs/retention-redis-worker.ts`      | Redis key expiration and BullMQ job cleanup                        |
| `apps/runtime/src/jobs/retention-s3-worker.ts`         | S3 lifecycle policy generation and object cleanup                  |
| `apps/runtime/src/jobs/retention-qdrant-worker.ts`     | Qdrant collection-level point deletion                             |
| `apps/runtime/src/jobs/erasure-cascade-worker.ts`      | GDPR right-to-erasure cross-layer cascade                          |
| `apps/runtime/src/jobs/legal-hold-expiry-worker.ts`    | Auto-release expired legal holds                                   |
| `apps/runtime/src/jobs/retention-archival-worker.ts`   | Hot -> cold -> archive data transition                             |

### Tests

| File                                                             | Type | Coverage Focus                         |
| ---------------------------------------------------------------- | ---- | -------------------------------------- |
| `packages/shared/src/__tests__/retention/policy-engine.test.ts`  | unit | Policy resolution precedence chain     |
| `packages/shared/src/__tests__/retention/classification.test.ts` | unit | Data classification manifest           |
| `apps/runtime/src/__tests__/retention-scheduler.test.ts`         | unit | Scheduler job creation and tenant scan |
| `apps/runtime/src/__tests__/retention-mongodb-worker.test.ts`    | unit | Batched deletion logic and hold check  |
| `apps/runtime/src/__tests__/retention-enforcement-e2e.test.ts`   | e2e  | Full enforcement cycle via HTTP API    |
| `apps/admin/src/__tests__/retention-policies-api.test.ts`        | e2e  | Admin policy CRUD API                  |
| `apps/admin/src/__tests__/legal-holds-api.test.ts`               | e2e  | Legal hold lifecycle API               |
| `apps/admin/src/__tests__/erasure-cascade-e2e.test.ts`           | e2e  | GDPR erasure cascade across layers     |

---

## 11. Configuration

### Environment Variables

| Variable                               | Default            | Description                                                           |
| -------------------------------------- | ------------------ | --------------------------------------------------------------------- |
| `RETENTION_ENABLED`                    | `true`             | Master switch for retention enforcement workers                       |
| `RETENTION_ENFORCEMENT_INTERVAL_HOURS` | `6`                | Default interval for MongoDB/ClickHouse enforcement runs              |
| `RETENTION_REDIS_INTERVAL_HOURS`       | `1`                | Interval for Redis key expiration runs                                |
| `RETENTION_S3_INTERVAL_HOURS`          | `24`               | Interval for S3 lifecycle policy enforcement                          |
| `RETENTION_BATCH_SIZE`                 | `1000`             | Records per deletion batch (MongoDB)                                  |
| `RETENTION_BATCH_DELAY_MS`             | `500`              | Delay between batches to reduce DB load                               |
| `RETENTION_ARCHIVAL_ENABLED`           | `false`            | Enable archival pipeline (hot -> cold -> archive)                     |
| `RETENTION_ARCHIVAL_GRACE_DAYS`        | `30`               | Grace period before archived data is permanently deleted              |
| `RETENTION_DRY_RUN`                    | `false`            | Run enforcement without actually deleting (for testing/auditing)      |
| `RETENTION_CLICKHOUSE_OFF_PEAK_HOURS`  | `2,3,4`            | UTC hours during which ClickHouse tenant-specific deletion is allowed |
| `GDPR_ERASURE_DEADLINE_DAYS`           | `30`               | SLA deadline for completing erasure requests                          |
| `RETENTION_EVENTS_TABLE`               | `retention_events` | ClickHouse table name for deletion audit trail                        |

### Runtime Configuration

- **Plan-level defaults**: Configured in `packages/shared/src/retention/constants.ts` as `PLAN_RETENTION_DEFAULTS` (free, professional, enterprise tiers)
- **Regulatory minimums**: Configured in `packages/shared/src/retention/constants.ts` as `REGULATORY_MINIMUMS` per data classification
- **Per-tenant overrides**: Stored in `retention_policies` MongoDB collection, managed via admin API
- **Per-project overrides**: Stored in `retention_policies` with `projectId` set, managed via Studio/admin API
- **Feature flag**: `feature.retention.enforcement` (per-tenant) to gradually roll out enforcement
- **Feature flag**: `feature.retention.archival` (per-tenant) to enable archival pipeline
- **Feature flag**: `feature.retention.gdpr-cascade` (per-tenant) to enable GDPR erasure cascade

### DSL / Agent IR / Schema

Retention policies are not configurable via the ABL DSL. They are infrastructure/governance settings managed by platform operators and tenant admins through the admin portal and Studio settings.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Tenant isolation  | Every retention policy is scoped to `tenantId`. Enforcement workers process one tenant at a time with tenant-specific policy resolution. Cross-tenant policy access returns 404. |
| Project isolation | Project-level overrides require `projectId` in the policy. Enforcement filters by `projectId` when project-scoped. Cross-project policy access returns 404.                      |
| User isolation    | Erasure requests are scoped to `contactId` within a tenant. Users cannot view or manage other tenants' retention policies, enforcement history, or legal holds.                  |

### Security & Compliance

- **Deletion audit trail**: Every deletion emits an immutable `retention_event` to ClickHouse with SHA-256 hash of deleted record IDs for non-repudiation, satisfying SOC 2 CC6.5 (logical and physical access controls over data disposal)
- **Legal hold enforcement**: Holds are checked before every deletion batch. Attempting to delete held data is logged as a `hold_skipped` event. Holds can only be created/released by users with `legal-hold:manage` permission
- **GDPR compliance**: Right-to-erasure cascade completes within configurable deadline (default: 30 days per GDPR Article 17). Erasure proof is recorded as an audit event with per-layer completion status
- **Regulatory minimums**: Policy engine rejects retention periods below configured regulatory minimums. Minimums are configurable per deployment to match jurisdiction requirements
- **RBAC**: Retention policy management requires `retention:manage` permission. Legal hold management requires `legal-hold:manage` permission. Both are admin-tier permissions not available to regular tenant users
- **Encryption coordination**: Archived data remains encrypted. When data is permanently deleted, the enforcement worker emits an event that the DEK lifecycle manager can use to check and destroy orphaned DEK epochs

### Performance & Scalability

- **Background processing**: All retention enforcement runs as background BullMQ jobs, never blocking API request paths
- **Batched deletion**: MongoDB deletions use configurable batch size (default: 1,000) with inter-batch delays (default: 500ms) to prevent replica set lag and oplog overflow
- **ClickHouse partition alignment**: Tenant-specific ClickHouse deletions are issued as lightweight `ALTER TABLE ... DELETE` mutations during off-peak hours. Bulk TTL enforcement uses native ClickHouse TTL merge, which drops whole parts (`ttl_only_drop_parts = 1`)
- **Redis SCAN**: Key expiration uses cursor-based `SCAN` with count hints (default: 100) to avoid blocking the Redis event loop
- **Horizontal scaling**: Enforcement workers use BullMQ concurrency control (1 worker per storage layer) with distributed locks via Redis `SET NX PX` to prevent duplicate runs across pods
- **Impact budget**: Enforcement runs monitor real-time replica lag (MongoDB) and merge queue depth (ClickHouse). If lag exceeds thresholds, the worker pauses and retries in the next cycle

### Reliability & Failure Modes

- **Idempotent enforcement**: Each run tracks `lastProcessedId` in `retention_enforcement_runs`. On restart, the worker resumes from the last cursor position without re-processing
- **Partial failure**: If a batch fails, the run is marked `partial` with error details. The next scheduled run picks up where the failed run stopped
- **Legal hold race condition**: Legal holds are checked per-batch (not per-run) using `findOne({ status: 'active', tenantId, ... })`. A hold created mid-run is respected starting from the next batch
- **ClickHouse mutation failure**: Mutations are fire-and-forget with status checked in the next run via `system.mutations`. Failed mutations are retried with exponential backoff
- **S3 lifecycle propagation delay**: S3 lifecycle rules can take up to 48 hours to take effect. The enforcement worker verifies rule presence and logs warnings if rules are not yet active
- **DLQ for failed deletions**: Deletion operations that fail after 3 retries are written to the `dead_letter_events` ClickHouse table for manual investigation
- **Graceful degradation**: If a storage layer is unreachable, the enforcement worker skips that layer, logs a warning, and processes the remaining layers. The skipped layer is retried in the next cycle

### Observability

- **Metrics** (Prometheus):
  - `retention_enforcement_runs_total` (counter, labels: `storage_layer`, `status`, `tenant_id`)
  - `retention_records_deleted_total` (counter, labels: `storage_layer`, `data_classification`)
  - `retention_records_archived_total` (counter, labels: `storage_layer`, `data_classification`)
  - `retention_records_skipped_hold_total` (counter, labels: `tenant_id`)
  - `retention_enforcement_duration_seconds` (histogram, labels: `storage_layer`)
  - `retention_enforcement_lag_seconds` (gauge) -- time since last successful run per layer
  - `retention_legal_holds_active` (gauge, labels: `tenant_id`, `hold_type`)
  - `retention_erasure_requests_pending` (gauge)
  - `retention_erasure_requests_overdue` (gauge) -- past GDPR deadline
- **Alerts**:
  - Enforcement lag > 2x configured interval
  - Erasure request approaching deadline (< 7 days remaining)
  - Legal hold expiry within 48 hours (for review)
  - Enforcement failure rate > 10% in last 24 hours
  - Storage utilization growth > 20% week-over-week (cost anomaly)
- **Logging**: All enforcement workers use `createLogger('retention-<layer>')` with structured log context including `tenantId`, `policyId`, `enforcementRunId`, `batchNumber`
- **Tracing**: Each enforcement run creates a parent trace span with child spans per batch. Trace IDs are recorded in `retention_enforcement_runs` for correlation

### Data Lifecycle

- **Retention events**: The `retention_events` ClickHouse table is itself subject to retention. Default: 7 years (configurable per deployment). It must never be shorter than the longest data retention policy in the system
- **Policy versioning**: Retention policies use `effectiveFrom`/`effectiveUntil` dates. Historical policies are soft-deleted (not physically removed) for audit trail purposes
- **Enforcement run history**: `retention_enforcement_runs` records are retained for 2 years by default. Completed runs older than the retention period are subject to their own cleanup
- **Legal hold records**: Released legal holds are retained indefinitely (soft-delete only) for legal audit trail. This is a compliance requirement and is exempt from normal retention
- **Archive-before-delete**: When archival is enabled, data transitions through hot -> warm -> cold -> archive -> delete stages, with configurable durations per stage. Each transition is logged as a `retention_event`

---

## 13. Delivery Plan / Work Breakdown

### Phase 1: Foundation (Sprint 1-2)

1. Retention policy engine and data model
   1.1 `RetentionPolicy` MongoDB model with indexes and tenant isolation plugin
   1.2 `LegalHold` MongoDB model with lifecycle management
   1.3 `RetentionEnforcementRun` MongoDB model for tracking
   1.4 `DATA_CLASSIFICATION_MANIFEST` with all existing collections/tables mapped
   1.5 Policy resolution engine (precedence chain, plan defaults, regulatory minimums)
   1.6 Plan-tier default policies (free, professional, enterprise)
   1.7 Unit tests for policy engine and classification manifest

2. Admin API - retention policy CRUD
   2.1 Admin routes for retention policy CRUD with RBAC (`retention:manage`)
   2.2 Admin routes for legal hold CRUD with RBAC (`legal-hold:manage`)
   2.3 Input validation with Zod schemas (all ID fields use `z.string().min(1)`)
   2.4 E2E tests for admin API

### Phase 2: MongoDB Enforcement (Sprint 3-4)

3. MongoDB retention enforcement worker
   3.1 BullMQ repeatable job scheduler (per-tenant, per-classification)
   3.2 Batched deletion with cursor-based progress tracking
   3.3 Legal hold check per batch
   3.4 `retention_events` ClickHouse table DDL and insert
   3.5 Enforcement run history recording
   3.6 Dry-run mode support
   3.7 Integration tests with MongoMemoryServer

4. MongoDB session/message retention
   4.1 Session archival (status transition to `archived`, then deletion)
   4.2 Message cascade deletion (messages deleted with their parent session)
   4.3 Contact PII integration with crypto-shredding
   4.4 E2E tests for session retention lifecycle

### Phase 3: ClickHouse and Redis Enforcement (Sprint 5-6)

5. ClickHouse retention enforcement worker
   5.1 Tenant-specific `ALTER TABLE ... DELETE` for non-default retention
   5.2 Off-peak scheduling with `RETENTION_CLICKHOUSE_OFF_PEAK_HOURS`
   5.3 Mutation status monitoring via `system.mutations`
   5.4 Integration tests

6. Redis retention enforcement worker
   6.1 SCAN-based key expiration for non-TTL keys
   6.2 BullMQ `clean()` API integration for completed/failed jobs
   6.3 Rate-limit state cleanup
   6.4 Unit and integration tests

### Phase 4: GDPR Cascade and Archival (Sprint 7-8)

7. GDPR right-to-erasure cascade
   7.1 `ErasureRequest` MongoDB model and admin API
   7.2 Cascade worker: MongoDB -> ClickHouse -> Redis -> S3 -> Qdrant
   7.3 Integration with encryption-at-rest crypto-shredding
   7.4 SLA monitoring (30-day deadline) and alerting
   7.5 E2E tests for full cascade

8. Archival pipeline
   8.1 S3 lifecycle policy generator for tenant upload prefixes
   8.2 MongoDB document archival (export to S3 JSON, then delete)
   8.3 Archive restoration API (admin-only, within grace period)
   8.4 Qdrant point deletion worker
   8.5 Integration tests

### Phase 5: Admin Dashboard and Studio UI (Sprint 9-10)

9. Admin portal retention dashboard
   9.1 Policy overview table with tenant grouping
   9.2 Enforcement history timeline
   9.3 Storage utilization chart
   9.4 Legal hold management panel
   9.5 GDPR erasure request queue
   9.6 Deletion forecast view

10. Studio tenant settings
    10.1 Retention settings page under Data Governance
    10.2 Effective retention viewer (resolved from precedence chain)
    10.3 Enforcement history for tenant
    10.4 Plan limit enforcement in UI

### Phase 6: Observability and Hardening (Sprint 11-12)

11. Metrics, alerting, and observability
    11.1 Prometheus metrics export from all enforcement workers
    11.2 Alert rules for enforcement lag, erasure SLA, storage anomalies
    11.3 Grafana dashboard for retention operations
    11.4 Structured logging with trace correlation

12. Hardening and production readiness
    12.1 Load testing: simulate 1,000 tenants with mixed retention policies
    12.2 Chaos testing: worker crash during enforcement, storage layer unavailability
    12.3 DEK lifecycle coordination (orphaned epoch detection)
    12.4 Documentation and operator runbook

---

## 14. Success Metrics

| Metric                                  | Baseline                        | Target                                | How Measured                                      |
| --------------------------------------- | ------------------------------- | ------------------------------------- | ------------------------------------------------- |
| Retention policy enforcement compliance | 0% (no centralized enforcement) | 99.5% of policies enforced on time    | `retention_enforcement_lag_seconds` < 2x interval |
| GDPR erasure request SLA compliance     | N/A (no erasure API)            | 100% completed within 30-day deadline | `erasure_requests` with `completedAt < deadline`  |
| Storage cost reduction (free tier)      | Unbounded growth                | 40% reduction in first 6 months       | Per-tenant storage utilization metrics            |
| Deletion audit trail coverage           | 0% (no deletion logging)        | 100% of deletions audited             | `retention_events` count vs `recordsDeleted` sum  |
| Legal hold compliance                   | N/A (no hold mechanism)         | 0 held records deleted                | `retention_records_skipped_hold_total` > 0        |
| Enforcement worker reliability          | N/A                             | < 1% failure rate per week            | `retention_enforcement_runs` failure ratio        |
| Time to configure tenant retention      | N/A (requires DB access)        | < 5 minutes via admin portal          | Admin portal UX testing                           |
| SOC 2 audit finding reduction           | Manual evidence collection      | Zero data-lifecycle findings          | Annual SOC 2 audit report                         |

---

## 15. Open Questions

1. **Tenant data isolation in shared ClickHouse tables**: ClickHouse TTL rules are table-level, not row-level. For tenant-specific retention, should we use `ALTER TABLE ... DELETE` mutations (expensive for large tables) or implement tenant-partitioned tables (operational complexity)? The current approach uses mutations during off-peak hours, but this may not scale beyond 10,000 tenants.
2. **Archival format and restore latency**: Should archived MongoDB documents be stored as BSON (fast restore) or compressed JSON (smaller footprint)? What is the acceptable restore latency SLA for archived data (minutes vs hours)?
3. **Cross-region erasure**: For multi-region deployments, how should erasure requests be propagated to all regions? Should there be a centralized erasure queue or region-local workers with cross-region sync?
4. **Aggregated data retention**: ClickHouse materialized views (e.g., `llm_metrics_hourly_dest`, `platform_events_agent_hourly_dest`) contain aggregated data that cannot be attributed to individual contacts. Should aggregated data be exempt from GDPR erasure, or should it be deleted when the source data is deleted?
5. **Retention policy conflict resolution**: If a project-level policy specifies 30 days but a legal hold on the parent tenant requires indefinite retention, the legal hold takes precedence. But what if a project-level policy specifies a longer retention than the tenant policy -- should the longer period always win?
6. **Qdrant vector deletion**: Qdrant does not support TTL natively. Deleting points by filter is expensive for large collections. Should we implement collection-level rotation (create new collections periodically, drop old ones) instead of point-level deletion?
7. **Backup retention alignment**: If live data retention is 30 days but backups are retained for 90 days, a deleted record may still exist in backups. Should the retention dashboard clearly communicate that backup-retained data exists beyond the live retention period? How does this affect GDPR erasure compliance?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                         | Severity | Status |
| ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | ClickHouse TTL is table-level, not tenant-level. Tenant-specific retention requires mutation-based deletion, which is expensive for large tables                                                                                    | High     | Open   |
| GAP-002 | No existing archival infrastructure. S3 archival pipeline and restore API need to be built from scratch                                                                                                                             | High     | Open   |
| GAP-003 | Qdrant has no native TTL support. Point-level deletion by filter is O(n) and may impact search latency during enforcement runs                                                                                                      | Medium   | Open   |
| GAP-004 | ClickHouse materialized views (aggregate tables) have independent TTLs. Changing source table TTL does not propagate to materialized view TTL automatically                                                                         | Medium   | Open   |
| GAP-005 | BullMQ `clean()` API deletes job data but not the Redis keys used by flow dependencies. Orphaned flow keys may accumulate if parent jobs reference cleaned children                                                                 | Medium   | Open   |
| GAP-006 | S3 lifecycle rules are limited to 1,000 per bucket. Multi-tenant deployments with >1,000 tenants on a shared bucket require application-level object cleanup                                                                        | Medium   | Open   |
| GAP-007 | MongoDB TTL index thread runs every 60 seconds and processes one collection at a time. For collections with millions of expired documents, deletion can lag hours                                                                   | Medium   | Open   |
| GAP-008 | Encrypted archived data requires the encryption key to remain available until the archive is permanently deleted. DEK destruction must be deferred until all archives referencing the epoch are deleted                             | High     | Open   |
| GAP-009 | No existing storage utilization metrics per tenant. Building accurate per-tenant storage reporting requires `$collStats` aggregation for MongoDB and `system.parts` queries for ClickHouse, both of which can be expensive at scale | Medium   | Open   |
| GAP-010 | GDPR erasure of ClickHouse data uses `ALTER TABLE ... DELETE` mutations, which are asynchronous and may take hours to complete for large tenants. The erasure request may show "completed" before physical deletion finishes        | High     | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                     | Coverage Type | Status     | Test File / Note                      |
| --- | -------------------------------------------- | ------------- | ---------- | ------------------------------------- |
| 1   | Policy resolution precedence chain           | unit          | NOT TESTED | `policy-engine.test.ts`               |
| 2   | Data classification manifest completeness    | unit          | NOT TESTED | `classification.test.ts`              |
| 3   | Plan-tier default policies                   | unit          | NOT TESTED | `policy-engine.test.ts`               |
| 4   | Regulatory minimum enforcement               | unit          | NOT TESTED | `policy-engine.test.ts`               |
| 5   | MongoDB batched deletion with cursor         | unit          | NOT TESTED | `retention-mongodb-worker.test.ts`    |
| 6   | Legal hold skip during enforcement           | unit          | NOT TESTED | `retention-mongodb-worker.test.ts`    |
| 7   | Enforcement run idempotent restart           | integration   | NOT TESTED | `retention-enforcement-e2e.test.ts`   |
| 8   | Full enforcement cycle via HTTP API          | e2e           | NOT TESTED | `retention-enforcement-e2e.test.ts`   |
| 9   | Legal hold lifecycle (create/extend/release) | e2e           | NOT TESTED | `legal-holds-api.test.ts`             |
| 10  | GDPR erasure cascade across all layers       | e2e           | NOT TESTED | `erasure-cascade-e2e.test.ts`         |
| 11  | Tenant isolation for policies                | e2e           | NOT TESTED | `retention-policies-api.test.ts`      |
| 12  | Deletion audit trail in ClickHouse           | e2e           | NOT TESTED | `retention-enforcement-e2e.test.ts`   |
| 13  | Admin policy CRUD with RBAC                  | e2e           | NOT TESTED | `retention-policies-api.test.ts`      |
| 14  | ClickHouse tenant-specific deletion          | integration   | NOT TESTED | `retention-clickhouse-worker.test.ts` |
| 15  | Redis SCAN-based key expiration              | integration   | NOT TESTED | `retention-redis-worker.test.ts`      |
| 16  | Archival pipeline (MongoDB -> S3)            | integration   | NOT TESTED | `retention-archival-worker.test.ts`   |
| 17  | Dry-run mode (no actual deletion)            | integration   | NOT TESTED | `retention-mongodb-worker.test.ts`    |

### Testing Notes

No tests currently exist for this feature as it is in PLANNED status. The test plan above covers the minimum required scenarios. All E2E tests must exercise the real HTTP API with full middleware chain (auth, tenant isolation, validation). Integration tests must use real storage backends (MongoMemoryServer, ClickHouse test instance, Redis test instance). See the full testing guide for detailed scenarios.

> Full testing details: [../testing/data-retention-ttl.md](../testing/data-retention-ttl.md)

---

## 18. References

- Design docs: (to be created during HLD phase)
- Related feature docs:
  - [Encryption at Rest](./encryption-at-rest.md) -- crypto-shredding, DEK lifecycle, key derivation
  - [Audit Logging](./audit-logging.md) -- audit event schema, ClickHouse audit store
  - [Session Management](./session-management.md) -- session lifecycle, archival status
- Industry standards:
  - GDPR Article 5(1)(e) -- Storage Limitation Principle
  - GDPR Article 17 -- Right to Erasure
  - SOC 2 CC6.5 -- Logical and Physical Access Controls (data disposal)
  - NIST SP 800-88 -- Guidelines for Media Sanitization
  - ISO 27001 A.8.10 -- Information Deletion
- Technical references:
  - [MongoDB TTL Indexes](https://www.mongodb.com/docs/manual/core/index-ttl/)
  - [ClickHouse TTL Data Lifecycle](https://clickhouse.com/blog/using-ttl-to-manage-data-lifecycles-in-clickhouse)
  - [Redis EXPIRE Command](https://redis.io/docs/latest/commands/expire/)
  - [AWS S3 Lifecycle Policies](https://docs.aws.amazon.com/AmazonS3/latest/userguide/object-lifecycle-mgmt.html)
- Existing infrastructure:
  - ClickHouse schema DDL: `packages/database/src/clickhouse-schemas/init.ts`
  - PII Audit Log TTL: `packages/database/src/models/pii-audit-log.model.ts` (90-day TTL)
  - BullMQ job retention: `removeOnComplete`/`removeOnFail` settings in search-ai and multimodal-service
