# Data Architecture

> **Scope**: Database selection, schema design, ClickHouse DDL, store interfaces, retention, GDPR, migration plan
> **Status**: Active -- MongoDB + ClickHouse is the production architecture
> **Last updated**: 2026-03-02

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Scale Requirements](#2-scale-requirements)
3. [Database Selection Rationale](#3-database-selection-rationale)
4. [MongoDB Schema](#4-mongodb-schema)
5. [ClickHouse Tables](#5-clickhouse-tables)
6. [Tiered Storage Architecture](#6-tiered-storage-architecture)
7. [Store Interfaces](#7-store-interfaces)
8. [OTEL Integration](#8-otel-integration)
9. [Retention Strategy & TTL Lifecycle](#9-retention-strategy--ttl-lifecycle)
10. [GDPR Implementation](#10-gdpr-implementation)
11. [Migration Plan](#11-migration-plan)
12. [Per-Tenant Cluster Isolation](#12-per-tenant-cluster-isolation)

---

## 1. Executive Summary

The ABL Platform uses **MongoDB** (metadata & control plane) + **ClickHouse** (high-volume operational data) as its production data architecture. This two-database approach was adopted after evaluating four options against 16 critical query patterns spanning real-time operations, batch maintenance, compliance, and analytics.

**Why this choice:**

- **330M writes/day** across messages, traces, logs, and LLM metrics -- no single general-purpose database handles this alongside live voice session reads
- **Conflicting access patterns** on message data that no single shard key satisfies (live reads by session, retention sweeps by time, GDPR by contact)
- **ClickHouse TTL partition drops** eliminate retention sweep jobs and PII scrubbing loops entirely -- both are declarative, executed during normal merge operations with zero additional I/O
- **Native tiered storage** (NVMe -> object storage) provides cloud-agnostic cold archival with transparent cross-tier querying -- no Athena/BigQuery/Synapse needed
- **MongoDB** handles low-volume metadata (~1M writes/day) where flexible schema, ad-hoc queries, and operational familiarity are the priorities

```
+------------------------------------------------------------------+
|                        Application Layer                          |
|                                                                   |
|  ConversationStore    MessageStore    TraceStore    MetricsStore   |
|  (MongoDB)            (ClickHouse     (ClickHouse   (ClickHouse   |
|                        + Redis)        via OTEL)     via OTEL)    |
+-------+------------------+--+------------+-+----------+----------+
        |                  |  |            | |          |
   +----v-----------+  +--v--v-+  +-------v-v----------v----------+
   |    MongoDB      |  | Redis  |  |         ClickHouse            |
   |                 |  |        |  |                               |
   |  Organization   |  | Active |  |  messages     (25M/day)      |
   |  User           |  | session|  |  traces       (200M/day)     |
   |  Contact        |  | message|  |  llm_metrics  (40M/day)      |
   |  Conversation   |  | buffer |  |  audit_events (10M/day)      |
   |  Workflow       |  |        |  |  logs         (65M/day)      |
   |  Project        |  | 100ms  |  |                               |
   |  AuditLog       |  | flush  |  |  Tiered Storage:             |
   |  Config...      |  |        |  |  NVMe (hot) -> ObjectStore   |
   |                 |  |        |  |  (S3 / Azure Blob / GCS)     |
   |  ~1M writes/d   |  |        |  |                               |
   +-----------------+  +--------+  |  TTL per table (automatic)   |
                                    +------+-----------------------+
                                           |
                                   +-------v--------+
                                   |  OTEL Collector |
                                   |  (K8s deployed) |
                                   +----------------+
```

| Component          | Data                                                                                               | Volume          | Purpose                                                  |
| ------------------ | -------------------------------------------------------------------------------------------------- | --------------- | -------------------------------------------------------- |
| **MongoDB**        | Orgs, Users, Contacts, Conversations (metadata), Workflows, Projects, Agents, Configs, Audit, GDPR | ~1M writes/day  | Flexible schema, ad-hoc queries, low volume              |
| **Redis**          | Active session message buffer                                                                      | Transient       | Sub-millisecond reads for live voice calls               |
| **ClickHouse**     | Messages, Traces, Logs, LLM Metrics, Audit Events                                                  | 330M writes/day | Columnar compression, TTL, tiered storage, SQL analytics |
| **Object Storage** | Cold archive (auto-tiered by ClickHouse)                                                           | Unlimited       | S3, Azure Blob, or GCS -- cloud-agnostic                 |

**Current status:** Phases 0-2 COMPLETE (store abstractions, critical bug fixes, ClickHouse tables created, stores implemented). Phase 3 (OTEL pipeline) and Phase 4 (Prisma removal) are PLANNED.

---

## 2. Scale Requirements

### 2.1 Volume Projections

Voice-heavy workload (primary use case):

```
Sessions:     1M/day (800K voice, 150K chat, 50K other)
Messages:     25M/day (avg 25 per session)
Traces:       100-200M/day (5-15 trace events per message turn)
Logs:         25-65M/day (structured application logs)
LLM Metrics:  12-40M/day (1-3 LLM calls per turn)
----------------------------------------------
Total writes: 160-330M documents/day
Peak writes:  9,000-19,000/second (5x sustained average)
```

### 2.2 Storage Projections (90-Day Active Retention)

| Data Type   | Daily Raw | Monthly (compressed)          | 90-Day Active |
| ----------- | --------- | ----------------------------- | ------------- |
| Messages    | 25 GB     | ~750 GB                       | ~2.25 TB      |
| Traces      | 50-100 GB | ~300 GB (columnar compressed) | ~900 GB       |
| Logs        | 12-32 GB  | ~90 GB (compressed)           | ~270 GB       |
| LLM Metrics | 6-20 GB   | ~60 GB (compressed)           | ~180 GB       |
| Metadata    | 0.5 GB    | ~15 GB                        | ~45 GB        |

### 2.3 Access Pattern Analysis

Each data type has fundamentally different access characteristics:

| Data Type   | Write Pattern                | Read Pattern                      | Retention                         | Access Frequency                |
| ----------- | ---------------------------- | --------------------------------- | --------------------------------- | ------------------------------- |
| Messages    | Per-turn, during live call   | During live conversation + replay | 90 days hot, years cold           | High during session, rare after |
| Traces      | Burst per turn (5-15 events) | Debugging specific sessions       | 7-30 days hot, 90 days queryable  | Very rare -- debugging only     |
| Logs        | Continuous streaming         | Troubleshooting incidents         | 7-14 days hot, 30 days searchable | Rare -- incidents only          |
| LLM Metrics | Per LLM call                 | Dashboards, cost reports          | Aggregated forever, raw 30 days   | Hourly aggregations             |
| Metadata    | Session create/update        | Session lookup, admin queries     | Forever                           | Moderate                        |

### 2.4 Tenant Distribution

Production deployments show significant tenant skew:

```
Tenant A (large enterprise):  800K sessions/day  = 80% of traffic
Tenant B (mid-size):          150K sessions/day  = 15%
Tenants C-Z (small):           50K sessions/day  =  5% combined
```

This skew is critical for any sharding strategy -- the largest tenant's workload exceeds many databases' single-shard capacity.

### 2.5 Voice-Specific Considerations

- ~60% of voice sessions are anonymous (no caller ID, blocked number, IVR-only)
- ~25% identified by phone number only (not a meaningful "contact")
- ~15% fully identified (CRM match, IVR authentication, employee SSO)
- Creating Contact records for anonymous callers is wasteful overhead
- Phone numbers are unreliable identifiers (shared phones, spoofing)
- Voice sessions have bursty write patterns (rapid turn-taking)

---

## 3. Database Selection Rationale

### 3.1 Options Evaluated

Four architectural options were evaluated against 16 query patterns (4 real-time, 4 operational, 3 analytics, 5 batch/compliance):

| Option | Architecture                      | Good+ Ratings | Critical/Very Poor | Verdict                                                |
| ------ | --------------------------------- | ------------- | ------------------ | ------------------------------------------------------ |
| A      | MongoDB single sharded cluster    | 5/16          | 4                  | Fails on retention sweeps and PII scrubbing at scale   |
| B      | MongoDB time-bucketed collections | 5/16          | 2                  | Solves retention but regresses contact-scoped queries  |
| C      | MongoDB + Cassandra/ScyllaDB      | 6/13\*        | 1                  | Excellent for messages, leaves traces/logs unaddressed |
| **D**  | **MongoDB + ClickHouse**          | **15/16**     | **0**              | **Only option with no critical ratings**               |

\*Option C does not address 3 query types (traces, logs, metrics), requiring additional systems.

### 3.2 Cross-Option Comparison Matrix

| Query                  | A (Mongo Single) | B (Mongo Bucketed) | C (Mongo+Cassandra) | D (Mongo+ClickHouse) |
| ---------------------- | ---------------- | ------------------ | ------------------- | -------------------- |
| Q1: Msg read (live)    | Good             | Good               | **Excellent**       | Good (Redis buffer)  |
| Q2: Msg write (live)   | Good             | Good               | **Excellent**       | Good (async batch)   |
| Q3: Session lookup     | Good             | Good               | Good                | Good                 |
| Q4: Contact resolve    | Moderate         | Moderate           | Good                | Good                 |
| Q5: Conv replay        | Good             | Moderate           | **Excellent**       | Good                 |
| Q6: Contact history    | Poor             | Poor               | Moderate            | Good                 |
| Q7: Trace debug        | Poor             | Poor               | N/A                 | **Excellent**        |
| Q8: Log search         | Very Poor        | Very Poor          | N/A                 | **Excellent**        |
| Q9: LLM cost rollup    | Poor             | Poor               | N/A                 | **Excellent**        |
| Q10: Session volume    | Moderate         | Moderate           | Moderate            | **Excellent**        |
| Q11: Cross-conv search | Very Poor        | Very Poor          | Very Poor           | Moderate             |
| Q12: Retention sweep   | **CRITICAL**     | **Excellent**      | **Excellent**       | **Excellent**        |
| Q13: PII scrubbing     | **CRITICAL**     | Poor               | Poor                | **Excellent**        |
| Q14: GDPR lookup       | Moderate         | Poor               | Moderate            | Good                 |
| Q15: GDPR deletion     | Moderate         | Poor               | Moderate            | Good                 |
| Q16: Audit trail       | Good             | Good               | Good                | Good                 |
| **Good+ count**        | **5/16**         | **5/16**           | **6/13\***          | **15/16**            |
| **Critical/Very Poor** | **4**            | **2**              | **1**               | **0**                |

### 3.3 Key Takeaways

1. **Option A fails on the exact queries that cause production outages** (Q12, Q13). No tuning of MongoDB single-cluster fixes the fundamental tension between TTL-based deletions at billion-scale and live write throughput.

2. **Option B solves retention (Q12) but regresses on contact-scoped queries** (Q6, Q14, Q15). The time-bucketed pattern trades one problem for several others and adds application-level collection routing complexity.

3. **Option C is excellent for message I/O but incomplete.** It solves the message store perfectly but leaves traces (200M/day), logs (65M/day), and metrics (40M/day) unaddressed -- requiring a third or fourth system.

4. **Option D is the only option with no critical or very poor ratings.** It handles all 16 query patterns in a single complementary pair of databases (MongoDB + ClickHouse), with purpose-built solutions for the two critical production problems (retention via partition drops, PII via columnar SET rules).

5. **The PII scrubbing problem (Q13) has no clean solution in MongoDB or Cassandra.** MongoDB's per-document updates at 350M scale cause I/O storms. Cassandra's tombstone-on-update model degrades read performance. Only ClickHouse's columnar TTL SET rewrites the content column in bulk during normal merge operations with zero additional I/O.

### 3.4 Why Not PostgreSQL

PostgreSQL was evaluated for three possible roles and rejected for all three.

**As metadata store (replacing MongoDB):** PostgreSQL offers marginally better referential integrity (foreign keys) and joins. However, the metadata volume (~1M writes/day) is low enough that neither database is stressed. The team already operates MongoDB. PostgreSQL is a "better" choice, not a "necessary" one. It remains a potential future enhancement if storage-enforced referential integrity is needed.

**As high-volume store (replacing ClickHouse):** Architectural mismatch. PostgreSQL's row-oriented MVCC model generates write amplification on every INSERT (WAL entries) and dead tuples on every UPDATE (PII scrubbing). At 330M writes/day:

| Requirement                      | PostgreSQL                                        | ClickHouse                                                 |
| -------------------------------- | ------------------------------------------------- | ---------------------------------------------------------- |
| Write throughput (330M/day)      | MVCC write amplification, WAL per row             | 10-50x better per node                                     |
| Compression (18 TB over 90 days) | 2-4x via toast/lz4                                | 10-30x columnar compression                                |
| PII scrubbing (Q13)              | UPDATE generates dead tuples, requires autovacuum | TTL SET rewrites column during merge, zero additional I/O  |
| Tiered storage to object storage | No native support, requires external ETL          | Native storage_policy with transparent cross-tier querying |
| Cold data queries                | Requires separate engine (Athena, Trino)          | Same SQL, same connection, slightly higher latency         |

**As a third database:** No unique capability justifies the operational overhead. If PostgreSQL enters, it replaces MongoDB for metadata -- it does not sit alongside it.

---

## 4. MongoDB Schema

### 4.1 Contact (NEW -- replaces loose `customerId`)

```javascript
// Collection: contacts
{
  _id: String,                    // CUID
  organizationId: String,         // Required -- tenant isolation

  // Identity
  type: String,                   // 'employee' | 'customer' | 'anonymous'
  identity: String | null,        // email, phone, or external ID
  identityType: String | null,    // 'email' | 'phone' | 'external'
  displayName: String | null,

  // Employee-specific
  department: String | null,
  employeeId: String | null,

  // Customer-specific
  company: String | null,
  accountRef: String | null,      // External CRM reference

  // Common
  channel: String | null,         // Preferred channel
  metadata: Object | null,
  tags: [String],
  firstSeenAt: Date,
  lastSeenAt: Date,
}

// Indexes
{ organizationId: 1, identityType: 1, identity: 1 }  // Lookup
{ organizationId: 1, type: 1 }                        // Filter by type
{ organizationId: 1, lastSeenAt: -1 }                 // Recent contacts
```

**Design notes:**

- No unique constraint on identity -- phone numbers can be shared, anonymous callers have none
- `contactId` is optional on Conversation -- 60% of voice sessions are anonymous
- Contact creation is async -- if caller is identified mid-conversation (IVR auth, CRM lookup), Contact is created and linked retroactively

### 4.2 Conversation (NEW -- replaces both AgentSession and Session)

```javascript
// Collection: conversations
{
  _id: String,                    // CUID
  organizationId: String,         // Required -- tenant isolation
  projectId: String,

  // Who
  contactId: String | null,       // Linked Contact (null for anonymous voice)
  callerNumber: String | null,    // Raw phone number for voice (even without Contact)
  initiatedById: String | null,   // Platform User ID (for debug/test sessions)

  // What
  currentAgent: String,
  agentVersion: String | null,
  environment: String,            // 'development' | 'staging' | 'production'

  // Workflow
  workflowId: String | null,
  workflowStepId: String | null,
  parentId: String | null,        // Sub-conversations (escalation, handoff)

  // Channel
  channel: String,                // 'web' | 'voice' | 'sms' | 'whatsapp' | 'email' | 'api'
  channelHistory: [String],

  // State
  status: String,                 // 'active' | 'idle' | 'archived' | 'terminated'
  disposition: String | null,     // Outcome code
  context: Object | null,
  metadata: Object | null,

  // Voice-specific
  callDuration: Number | null,    // Seconds
  dispositionCode: String | null, // IVR disposition

  // Timestamps
  startedAt: Date,
  lastActivityAt: Date,
  endedAt: Date | null,
  archivedAt: Date | null,
}

// Indexes
{ organizationId: 1, status: 1, lastActivityAt: -1 }   // Retention sweep
{ organizationId: 1, contactId: 1 }                     // Contact history
{ organizationId: 1, callerNumber: 1 }                  // Voice lookup
{ organizationId: 1, workflowId: 1 }                    // Workflow sessions
{ organizationId: 1, projectId: 1, environment: 1 }     // Project filter
```

### 4.3 Workflow (NEW)

```javascript
// Collection: workflows
{
  _id: String,
  organizationId: String,
  projectId: String,

  name: String,
  type: String,                   // 'cx_automation' | 'ex_automation' | 'internal'
  description: String | null,

  // Definition
  entryAgent: String,
  steps: Object | null,           // Step definitions
  triggers: Object | null,        // API, schedule, event triggers

  // SLA & Escalation
  slaMinutes: Number | null,
  escalationRules: Object | null,

  status: String,                 // 'active' | 'paused' | 'archived'
  metadata: Object | null,
  createdAt: Date,
}

// Indexes
{ organizationId: 1, projectId: 1, name: 1 }  // unique
{ organizationId: 1, type: 1, status: 1 }
```

### 4.4 Models That Stay Unchanged in MongoDB

These models have low volume and no performance issues:

- `User`, `RefreshToken`, `UserMFA`, `RecoveryCode`
- `Organization`, `OrgMember`, `ApiKey`, `SSOConfig`, `DomainMapping`
- `Project`, `ProjectAgent`, `AgentVersion`
- `LLMCredential`, `ModelConfig`, `ServiceNode`
- `DebugToken`, `DeviceAuthRequest`
- `KeyVersion`
- `PublicApiKey`, `WidgetConfig`
- `AuditLog` (fix: always include `organizationId` in queries)
- `DeletionRequest`
- `ArchiveManifest`

### 4.5 Models That Moved to ClickHouse

- `Message` -> `messages` table (ClickHouse)
- `LLMUsageMetric` -> `llm_metrics` table (ClickHouse)
- Trace events (currently in-memory) -> `traces` table (ClickHouse)
- Application logs (currently Pino stdout) -> `logs` table (ClickHouse)
- Audit events -> `audit_events` table (ClickHouse)

---

## 5. ClickHouse Tables

All tables use database `abl_platform`. All engines are `ReplicatedMergeTree` for both dev and prod (Docker Compose includes ClickHouse Keeper for local dev). All optional fields use `DEFAULT ''` or `DEFAULT 0` instead of `Nullable()` to avoid UInt8 bitmask overhead.

### 5.1 Messages (~300M writes/day, daily partitions, encrypted content)

```sql
CREATE TABLE IF NOT EXISTS abl_platform.messages
(
    -- Primary key columns (ORDER BY)
    tenant_id         String               CODEC(ZSTD(1)),
    session_id        String               CODEC(ZSTD(1)),
    created_at        DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    -- Identity
    message_id        String               CODEC(NONE),
    contact_id        String               DEFAULT '' CODEC(ZSTD(1)),

    -- Message classification
    role              LowCardinality(String) CODEC(ZSTD(1)),  -- user/assistant/system/tool
    channel           LowCardinality(String) CODEC(ZSTD(1)),  -- web/voice/sms/whatsapp/email/api

    -- ENCRYPTED: compress-then-encrypt (ZSTD + AES-256-GCM + Base64)
    content           String               CODEC(NONE),
    -- Metadata is NOT encrypted (plaintext JSON for querying)
    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    -- Encryption metadata
    encrypted         UInt8                DEFAULT 1 CODEC(T64, ZSTD(1)),
    key_version       UInt16               DEFAULT 1 CODEC(T64, ZSTD(1)),

    -- PII tracking (drives TTL SET rules)
    has_pii           UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    scrubbed          UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),

    -- Correlation
    trace_id          String               DEFAULT '' CODEC(ZSTD(1)),

    -- Secondary indexes
    INDEX idx_contact contact_id       TYPE bloom_filter GRANULARITY 4,
    INDEX idx_pii     (has_pii, scrubbed) TYPE set(4)   GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.messages', '{replica}')
PARTITION BY toYYYYMMDD(created_at)
ORDER BY (tenant_id, session_id, created_at)
TTL
    created_at + INTERVAL 14 DAY
        SET content = if(has_pii AND scrubbed = 0, '[PII_EXPIRED]', content),
            scrubbed = if(has_pii, 1, scrubbed),
    created_at + INTERVAL 30 DAY TO VOLUME 'warm',
    created_at + INTERVAL 90 DAY TO VOLUME 'cold',
    created_at + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;
```

**Design decisions:**

- **ORDER BY `(tenant_id, session_id, created_at)`**: `tenant_id` first for tenant isolation and maximum granule skipping; `session_id` second because the primary read is "get messages for a session"; `created_at` third for chronological ordering. ~25 messages/session fit in ~1 granule (8192 rows), so session lookup = 1-2 granule reads.
- **PARTITION BY daily**: ~150 GB/day compressed. Monthly would create ~4.5 TB partitions (too large, slow merges). 90 active daily partitions at 90-day retention.
- **Encryption**: `content` column encrypted at application layer. Pipeline: plaintext -> ZSTD compress (level 3) -> AES-256-GCM encrypt -> Base64 encode. Wire format: `Z1:{iv_b64}:{authTag_b64}:{ciphertext_b64}`. `encrypted` flag enables gradual migration (0 = plaintext during transition). `key_version` tracks which key version encrypted the row.
- **TTL SET for PII**: After 14 days, messages with `has_pii = 1` have their `content` rewritten to `[PII_EXPIRED]` during normal merge operations. Zero application code, zero I/O contention.
- **Indexes**: `bloom_filter` on `contact_id` for GDPR compliance deletion queries; `set(4)` on `(has_pii, scrubbed)` for PII dashboard (only 4 possible value combinations).

**TTL lifecycle:**

| Age      | Action                                                                    |
| -------- | ------------------------------------------------------------------------- |
| 14 days  | PII scrubbing: rewrites `content` to `[PII_EXPIRED]` for flagged messages |
| 30 days  | Move to warm storage                                                      |
| 90 days  | Move to cold storage (S3)                                                 |
| 730 days | Hard delete (partition drop)                                              |

**GDPR operations:**

```sql
-- Contact-level deletion (lightweight delete)
ALTER TABLE abl_platform.messages DELETE
WHERE tenant_id = {tenantId:String} AND contact_id = {contactId:String};

-- Tenant-level crypto-shredding: destroy tenant key -> all content unreadable in O(1)
```

**Query patterns:**

```sql
-- Get messages for a session (primary pattern)
SELECT * FROM abl_platform.messages
WHERE tenant_id = {tenantId:String} AND session_id = {sessionId:String}
ORDER BY created_at ASC;

-- Count messages by role for a tenant
SELECT role, count() FROM abl_platform.messages
WHERE tenant_id = {tenantId:String}
  AND created_at >= now() - INTERVAL 1 DAY
GROUP BY role;
```

### 5.2 Traces (~200M writes/day, daily partitions, encrypted data)

For trace event type reference, see [OBSERVABILITY_AND_TRACING.md](./OBSERVABILITY_AND_TRACING.md).

```sql
CREATE TABLE IF NOT EXISTS abl_platform.traces
(
    -- Primary key columns (ORDER BY)
    tenant_id         String               CODEC(ZSTD(1)),
    session_id        String               CODEC(ZSTD(1)),
    trace_id          String               CODEC(ZSTD(1)),
    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    -- Span hierarchy
    span_id           String               CODEC(NONE),
    parent_span_id    String               DEFAULT '' CODEC(ZSTD(1)),

    -- Event classification (17 event types from observatory schema)
    event_type        LowCardinality(String) CODEC(ZSTD(1)),
    agent_name        LowCardinality(String) CODEC(ZSTD(1)),

    -- ENCRYPTED: compress-then-encrypt (ZSTD + AES-256-GCM + Base64)
    data              String               DEFAULT '{}' CODEC(NONE),
    encrypted         UInt8                DEFAULT 1 CODEC(T64, ZSTD(1)),
    key_version       UInt16               DEFAULT 1 CODEC(T64, ZSTD(1)),

    -- Performance
    duration_ms       UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    has_error         UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    error_message     String               DEFAULT '' CODEC(ZSTD(1)),

    -- Distributed tracing (from HybridLogicalClock in trace-store.ts)
    node_id           LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    sequence          String               DEFAULT '' CODEC(ZSTD(1)),

    -- Secondary indexes
    INDEX idx_trace   trace_id   TYPE bloom_filter GRANULARITY 4,
    INDEX idx_type    event_type TYPE set(20)      GRANULARITY 4,
    INDEX idx_error   has_error  TYPE set(2)       GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.traces', '{replica}')
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (tenant_id, session_id, trace_id, timestamp)
TTL
    timestamp + INTERVAL 7 DAY TO VOLUME 'warm',
    timestamp + INTERVAL 30 DAY TO VOLUME 'cold',
    timestamp + INTERVAL 90 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;
```

**Design decisions:**

- **ORDER BY `(tenant_id, session_id, trace_id, timestamp)`**: `tenant_id` first for mandatory tenant isolation; `session_id` second because the primary access pattern is session-scoped debugging; `trace_id` third to group spans of the same trace for span tree reconstruction; `timestamp` fourth for chronological ordering within trace.
- **PARTITION BY daily**: ~200M rows/day \* ~100B = ~20 GB/day compressed. 90 active daily partitions at 90-day retention.
- **Encryption**: `data` column encrypted at application layer (compress-then-encrypt). Wire format: `Z1:{iv_b64}:{authTag_b64}:{ciphertext_b64}`. `CODEC(NONE)` because encrypted content is incompressible. All other columns remain plaintext for querying/filtering.
- **Indexes**: `bloom_filter` on `trace_id` for single-trace lookups across partitions; `set(20)` on `event_type` for the 17 observatory event types; `set(2)` on `has_error` for error scans.

**TTL lifecycle:**

| Age     | Action                       |
| ------- | ---------------------------- |
| 7 days  | Move to warm storage         |
| 30 days | Move to cold storage (S3)    |
| 90 days | Hard delete (partition drop) |

Shorter retention than messages -- traces are high-volume diagnostic data.

**Query patterns:**

```sql
-- Get all spans for a session (primary debugging pattern)
SELECT * FROM abl_platform.traces
WHERE tenant_id = {tenantId:String} AND session_id = {sessionId:String}
ORDER BY timestamp ASC;

-- Get a single trace's span tree
SELECT * FROM abl_platform.traces
WHERE tenant_id = {tenantId:String} AND trace_id = {traceId:String}
ORDER BY timestamp ASC;

-- Error traces in the last hour
SELECT trace_id, event_type, error_message, duration_ms
FROM abl_platform.traces
WHERE tenant_id = {tenantId:String}
  AND has_error = 1
  AND timestamp >= now() - INTERVAL 1 HOUR
ORDER BY timestamp DESC
LIMIT 100;
```

### 5.3 LLM Metrics (~100M writes/day, monthly partitions, + materialized views)

#### Raw Metrics Table

```sql
CREATE TABLE IF NOT EXISTS abl_platform.llm_metrics
(
    -- Primary key columns (ORDER BY)
    tenant_id         String               CODEC(ZSTD(1)),
    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    model_id          LowCardinality(String) CODEC(ZSTD(1)),
    provider          LowCardinality(String) CODEC(ZSTD(1)),

    -- Context
    session_id        String               CODEC(ZSTD(1)),
    project_id        String               CODEC(ZSTD(1)),
    operation_type    LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    agent_name        LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    -- Token usage
    input_tokens      UInt32               CODEC(T64, ZSTD(1)),
    output_tokens     UInt32               CODEC(T64, ZSTD(1)),
    total_tokens      UInt32               CODEC(T64, ZSTD(1)),

    -- Cost & performance
    estimated_cost    Float64              DEFAULT 0 CODEC(Gorilla, ZSTD(1)),
    latency_ms        UInt32               CODEC(T64, ZSTD(1)),
    streaming_used    UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    tool_call_count   UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),

    -- Status
    success           UInt8                DEFAULT 1 CODEC(T64, ZSTD(1)),
    error_type        LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    -- Secondary indexes
    INDEX idx_session   session_id     TYPE bloom_filter GRANULARITY 4,
    INDEX idx_operation operation_type TYPE set(10)      GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.llm_metrics', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, toStartOfHour(timestamp), model_id, provider)
TTL
    timestamp + INTERVAL 90 DAY TO VOLUME 'warm',
    timestamp + INTERVAL 365 DAY TO VOLUME 'cold',
    timestamp + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;
```

#### Hourly Rollup (AggregatingMergeTree)

```sql
CREATE TABLE IF NOT EXISTS abl_platform.llm_metrics_hourly_dest
(
    tenant_id           String,
    project_id          String,
    model_id            LowCardinality(String),
    provider            LowCardinality(String),
    agent_name          LowCardinality(String),
    hour                DateTime,

    total_input_tokens  SimpleAggregateFunction(sum, UInt64),
    total_output_tokens SimpleAggregateFunction(sum, UInt64),
    total_tokens        SimpleAggregateFunction(sum, UInt64),
    call_count          SimpleAggregateFunction(sum, UInt64),
    error_count         SimpleAggregateFunction(sum, UInt64),
    total_cost          SimpleAggregateFunction(sum, Float64),
    total_tool_calls    SimpleAggregateFunction(sum, UInt64),
    sum_latency_ms      SimpleAggregateFunction(sum, UInt64),
    max_latency_ms      SimpleAggregateFunction(max, UInt32),
    min_latency_ms      SimpleAggregateFunction(min, UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, project_id, model_id, provider, agent_name, hour)
TTL hour + INTERVAL 1095 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.llm_metrics_hourly
TO abl_platform.llm_metrics_hourly_dest
AS SELECT
    tenant_id, project_id, model_id, provider, agent_name,
    toStartOfHour(timestamp) AS hour,
    sumSimpleState(toUInt64(input_tokens))           AS total_input_tokens,
    sumSimpleState(toUInt64(output_tokens))           AS total_output_tokens,
    sumSimpleState(toUInt64(total_tokens))             AS total_tokens,
    sumSimpleState(toUInt64(1))                        AS call_count,
    sumSimpleState(toUInt64(if(success = 0, 1, 0)))    AS error_count,
    sumSimpleState(toFloat64(estimated_cost))           AS total_cost,
    sumSimpleState(toUInt64(tool_call_count))            AS total_tool_calls,
    sumSimpleState(toUInt64(latency_ms))                AS sum_latency_ms,
    maxSimpleState(latency_ms)                          AS max_latency_ms,
    minSimpleState(latency_ms)                          AS min_latency_ms
FROM abl_platform.llm_metrics
GROUP BY tenant_id, project_id, model_id, provider, agent_name, hour;
```

#### Daily Rollup (AggregatingMergeTree)

```sql
CREATE TABLE IF NOT EXISTS abl_platform.llm_metrics_daily_dest
(
    tenant_id           String,
    project_id          String,
    model_id            LowCardinality(String),
    provider            LowCardinality(String),
    day                 Date,

    total_input_tokens  SimpleAggregateFunction(sum, UInt64),
    total_output_tokens SimpleAggregateFunction(sum, UInt64),
    total_tokens        SimpleAggregateFunction(sum, UInt64),
    call_count          SimpleAggregateFunction(sum, UInt64),
    error_count         SimpleAggregateFunction(sum, UInt64),
    total_cost          SimpleAggregateFunction(sum, Float64),
    total_tool_calls    SimpleAggregateFunction(sum, UInt64),
    sum_latency_ms      SimpleAggregateFunction(sum, UInt64),
    max_latency_ms      SimpleAggregateFunction(max, UInt32),
    min_latency_ms      SimpleAggregateFunction(min, UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, project_id, model_id, provider, day)
TTL day + INTERVAL 1095 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.llm_metrics_daily
TO abl_platform.llm_metrics_daily_dest
AS SELECT
    tenant_id, project_id, model_id, provider,
    toDate(timestamp) AS day,
    sumSimpleState(toUInt64(input_tokens))           AS total_input_tokens,
    sumSimpleState(toUInt64(output_tokens))           AS total_output_tokens,
    sumSimpleState(toUInt64(total_tokens))             AS total_tokens,
    sumSimpleState(toUInt64(1))                        AS call_count,
    sumSimpleState(toUInt64(if(success = 0, 1, 0)))    AS error_count,
    sumSimpleState(toFloat64(estimated_cost))           AS total_cost,
    sumSimpleState(toUInt64(tool_call_count))            AS total_tool_calls,
    sumSimpleState(toUInt64(latency_ms))                AS sum_latency_ms,
    maxSimpleState(latency_ms)                          AS max_latency_ms,
    minSimpleState(latency_ms)                          AS min_latency_ms
FROM abl_platform.llm_metrics
GROUP BY tenant_id, project_id, model_id, provider, day;
```

**Design decisions:**

- **ORDER BY `(tenant_id, toStartOfHour(timestamp), model_id, provider)`**: `toStartOfHour` reduces merge CPU vs raw timestamp; aggregation queries are time-range scoped; `model_id` and `provider` enable streaming aggregation for cost breakdowns.
- **PARTITION BY monthly**: ~100M rows/day \* ~80B = ~8 GB/day compressed, ~240 GB/month.
- **Materialized views use AggregatingMergeTree** (not SummingMergeTree): `SimpleAggregateFunction` handles max/min correctly during merges. `SummingMergeTree` would incorrectly sum averages and max values. Both views read from the raw table independently (daily rollup is exact, not dependent on hourly merge state). Incremental views for real-time updates on every insert. Explicit `TO` clause gives control over target table engine, partitioning, ordering.
- **No encryption**: Token counts and costs are not PII.

**Query patterns:**

```sql
-- Dashboard: cost breakdown by model (hourly rollup with correct weighted average)
SELECT model_id, provider,
    sum(total_input_tokens) AS input_tokens,
    sum(call_count) AS calls,
    sum(sum_latency_ms) / sum(call_count) AS avg_latency_ms,
    max(max_latency_ms) AS peak_latency_ms,
    sum(total_cost) AS total_cost_usd,
    sum(error_count) / sum(call_count) AS error_rate
FROM abl_platform.llm_metrics_hourly_dest
WHERE tenant_id = {tenantId:String} AND hour >= now() - INTERVAL 7 DAY
GROUP BY model_id, provider
ORDER BY total_cost_usd DESC;

-- Raw percentile query (requires raw table, not rollups)
SELECT model_id,
    quantile(0.50)(latency_ms) AS p50,
    quantile(0.95)(latency_ms) AS p95,
    quantile(0.99)(latency_ms) AS p99
FROM abl_platform.llm_metrics
WHERE tenant_id = {tenantId:String} AND timestamp >= now() - INTERVAL 1 DAY
GROUP BY model_id;
```

### 5.4 Audit Events (~10M writes/day, monthly partitions, no delete TTL)

```sql
CREATE TABLE IF NOT EXISTS abl_platform.audit_events
(
    -- Primary key columns (ORDER BY)
    tenant_id         String               CODEC(ZSTD(1)),
    timestamp         DateTime             CODEC(Delta, ZSTD(1)),
    action            LowCardinality(String) CODEC(ZSTD(1)),

    -- Event identification
    event_id          String               CODEC(NONE),

    -- Actor
    actor_id          String               DEFAULT '' CODEC(ZSTD(1)),
    actor_type        LowCardinality(String) DEFAULT 'user' CODEC(ZSTD(1)),
    actor_ip          String               DEFAULT '' CODEC(ZSTD(1)),

    -- Resource
    resource_type     LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    resource_id       String               DEFAULT '' CODEC(ZSTD(1)),

    -- Context
    session_id        String               DEFAULT '' CODEC(ZSTD(1)),
    project_id        String               DEFAULT '' CODEC(ZSTD(1)),

    -- Change details (plaintext)
    old_value         String               DEFAULT '' CODEC(ZSTD(3)),
    new_value         String               DEFAULT '' CODEC(ZSTD(3)),
    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    -- Outcome
    success           UInt8                DEFAULT 1 CODEC(T64, ZSTD(1)),
    failure_reason    String               DEFAULT '' CODEC(ZSTD(1)),

    -- Secondary indexes
    INDEX idx_action   action        TYPE set(100)     GRANULARITY 4,
    INDEX idx_actor    actor_id      TYPE bloom_filter GRANULARITY 4,
    INDEX idx_session  session_id    TYPE bloom_filter GRANULARITY 4,
    INDEX idx_resource resource_type TYPE set(20)      GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.audit_events', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, timestamp, action)
TTL
    timestamp + INTERVAL 90 DAY TO VOLUME 'cold'
    -- NO DELETE TTL: regulatory 365-day retention. Deletion is manual + audited.
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 86400;
```

**Design decisions:**

- **ORDER BY `(tenant_id, timestamp, action)`**: time-range queries are the primary access pattern for audit trails; `action` as a primary filter dimension.
- **PARTITION BY monthly**: ~10M rows/day \* ~150B = ~1.5 GB/day, ~45 GB/month.
- **DateTime (not DateTime64)**: Second precision is sufficient. 4 bytes vs 8 bytes, with `Delta` codec for efficient compression of monotonic timestamps.
- **No delete TTL**: Regulatory requirement for 365+ day retention. Manual deletion only, which is itself audited.
- **No encryption**: Audit events are plaintext for compliance querying.
- **Indexes**: `set(100)` on `action`; `bloom_filter` on `actor_id` and `session_id`; `set(20)` on `resource_type`.

**Query patterns:**

```sql
-- Recent audit events for a tenant
SELECT timestamp, action, actor_id, resource_type, resource_id, success
FROM abl_platform.audit_events
WHERE tenant_id = {tenantId:String}
  AND timestamp >= now() - INTERVAL 24 HOUR
ORDER BY timestamp DESC
LIMIT 100;

-- Failed actions by a specific actor
SELECT timestamp, action, resource_type, failure_reason
FROM abl_platform.audit_events
WHERE tenant_id = {tenantId:String}
  AND actor_id = {actorId:String}
  AND success = 0
ORDER BY timestamp DESC;

-- Audit trail for a specific session
SELECT timestamp, action, actor_id, old_value, new_value
FROM abl_platform.audit_events
WHERE tenant_id = {tenantId:String}
  AND session_id = {sessionId:String}
ORDER BY timestamp ASC;
```

### 5.5 Logs (~65M writes/day, monthly partitions)

```sql
CREATE TABLE IF NOT EXISTS abl_platform.logs
(
    -- Primary key columns (ORDER BY)
    tenant_id         String               DEFAULT '' CODEC(ZSTD(1)),
    timestamp         DateTime             CODEC(Delta, ZSTD(1)),
    service           LowCardinality(String) CODEC(ZSTD(1)),
    level             LowCardinality(String) CODEC(ZSTD(1)),

    -- Correlation
    session_id        String               DEFAULT '' CODEC(ZSTD(1)),
    request_id        String               DEFAULT '' CODEC(ZSTD(1)),

    -- Log content (plaintext, searchable)
    message           String               CODEC(ZSTD(3)),
    data              String               DEFAULT '{}' CODEC(ZSTD(3)),

    -- Secondary indexes
    INDEX idx_level   level      TYPE set(5)                 GRANULARITY 4,
    INDEX idx_message message    TYPE tokenbf_v1(512, 3, 0)  GRANULARITY 4,
    INDEX idx_session session_id TYPE bloom_filter            GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.logs', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, timestamp, service, level)
TTL
    timestamp + INTERVAL 3 DAY TO VOLUME 'warm',
    timestamp + INTERVAL 14 DAY TO VOLUME 'cold',
    timestamp + INTERVAL 30 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;
```

**Design decisions:**

- **ORDER BY `(tenant_id, timestamp, service, level)`**: log queries are time-range dominated ("last 10 minutes"); `service` and `level` are the primary filter dimensions.
- **PARTITION BY monthly**: ~65M rows/day \* ~200B = ~13 GB/day compressed, ~390 GB/month.
- **DateTime (not DateTime64)**: Second precision sufficient. `Delta` codec for efficient compression.
- **Shortest retention**: 3 days warm, 14 days cold, 30 days delete. Logs are high volume with the lowest retention requirement.
- **No encryption**: PII must be scrubbed at log emission point, not storage layer. Engineers need to grep logs without decryption overhead.
- **Indexes**: `set(5)` on `level` (debug/info/warn/error/fatal); `tokenbf_v1(512, 3, 0)` on `message` for token-based full-text search; `bloom_filter` on `session_id` for single-session log lookups.
- Platform-level logs without tenant context use `DEFAULT ''` for `tenant_id`.

**Query patterns:**

```sql
-- Recent errors for a service
SELECT timestamp, message, data
FROM abl_platform.logs
WHERE tenant_id = {tenantId:String}
  AND level = 'error'
  AND timestamp >= now() - INTERVAL 10 MINUTE
ORDER BY timestamp DESC
LIMIT 100;

-- Full-text search in log messages
SELECT timestamp, service, level, message
FROM abl_platform.logs
WHERE tenant_id = {tenantId:String}
  AND message LIKE '%connection refused%'
  AND timestamp >= now() - INTERVAL 1 HOUR
ORDER BY timestamp DESC;

-- Log volume by service and level
SELECT service, level, count() AS cnt
FROM abl_platform.logs
WHERE tenant_id = {tenantId:String}
  AND timestamp >= now() - INTERVAL 1 DAY
GROUP BY service, level
ORDER BY cnt DESC;
```

---

## 6. Tiered Storage Architecture

### 6.1 Storage Hierarchy: Disks, Volumes, Policies

```
Policy (named, applied per table)
  +-- Volume (ordered list -- data moves down)
        +-- Disk (physical storage backend)
```

**Disks** are physical storage backends -- local filesystem, S3, Azure Blob, GCS. Each disk has different cost and latency characteristics.

**Volumes** group disks. A volume can contain multiple disks for redundancy. Data is assigned to a volume, not a specific disk.

**Policies** define the tiering strategy. A policy lists volumes in order (hot -> warm -> cold). TTL rules move data between volumes automatically.

### 6.2 Data Part Structure

Each partition contains one or more **data parts** -- the atomic unit of storage in MergeTree:

```
Partition 202602 (February 2026)
|
+-- Part: 202602_1_50_3/              <-- merged part (rows 1-50, merge level 3)
|   +-- organization_id.bin           <-- column data (LZ4 compressed)
|   +-- organization_id.mrk2          <-- mark file (sparse index into column)
|   +-- content.bin                   <-- message text (ZSTD compressed)
|   +-- content.mrk2
|   +-- timestamp.bin
|   +-- timestamp.mrk2
|   +-- primary.idx                   <-- sparse primary index
|   +-- minmax_timestamp.idx          <-- partition key min/max for pruning
|   +-- skp_idx_contact.idx           <-- bloom filter for contact_id lookups
|   +-- skp_idx_pii.idx               <-- set index for has_pii/scrubbed
|   +-- checksums.txt                 <-- integrity verification
|
+-- Part: 202602_51_60_1/             <-- newer, not yet merged
```

When ClickHouse moves data between tiers, it moves **entire part directories** -- all `.bin`, `.mrk2`, and `.idx` files together. No deserialization, no re-encoding, just a file copy (or upload to object storage).

### 6.3 How TTL Rules Execute

TTL is checked **during merge operations**, not by a separate background scanner. ClickHouse's MergeTree engine continuously merges small parts into larger ones. During each merge, it evaluates TTL rules:

```
Normal merge cycle (continuous):
  1. MergeTree identifies 3 small parts -> decides to merge
  2. Reads rows from source parts
  3. For each row, checks TTL rules:
     a. SET rule (e.g., PII scrub after 14 days):
        If timestamp + 14 days < now() -> rewrite content column
     b. TO VOLUME rule (e.g., move to cold after 90 days):
        If timestamp + 90 days < now() -> write merged part to cold volume
     c. DELETE rule (e.g., drop after 2 years):
        If timestamp + 730 days < now() -> exclude row from merged output
  4. Writes merged part to target volume
  5. Marks source parts for deletion
```

The `merge_with_ttl_timeout` setting controls how often ClickHouse proactively triggers merges for TTL purposes (86400 seconds = 24 hours in our config). For partition-level TTL (when ALL rows are past the DELETE threshold), ClickHouse drops the entire partition -- no row-by-row scan. This is O(1).

### 6.4 TTL SET for Automatic PII Scrubbing

The `SET` action rewrites specific columns without deleting the row:

```
Day 1:    INSERT message with content = "My card number is 4111-1111-1111-1111"
          -> stored on hot volume with has_pii = 1

Day 14:   Next merge of this part checks TTL SET rule
          -> content column rewritten to '[PII_EXPIRED]'
          -> scrubbed column set to 1
          -> All other columns preserved

Day 90:   Next merge checks TO VOLUME 'cold' rule
          -> Part (with already-scrubbed content) moved to object storage

Day 730:  Partition dropped entirely
```

This eliminates the N+1 PII scrub loop with zero application code. The scrubbing is declarative -- defined in the table schema, executed during normal merge operations.

### 6.5 How Queries Span Tiers

When a query executes, ClickHouse's query planner:

1. **Partition pruning**: Skip partitions outside the WHERE timestamp range
2. **Primary index lookup**: For each remaining partition across all volumes, read the sparse primary index
3. **Mark-based column reads**: Read only the columns in the SELECT clause, at only the indicated byte offsets
4. **Parallel execution**: Parts on different volumes are read in parallel

```
Query: SELECT * FROM messages
       WHERE tenant_id = 'org_123' AND session_id = 'sess_456'
       ORDER BY created_at

Execution:
  Partition 202602 (hot, NVMe):     ~1ms
  Partition 202601 (hot, NVMe):     ~1ms
  Partition 202512 (warm, SSD):     ~5ms
  Partition 202509 (cold, S3):      ~80ms (first byte) + streaming

  Total: ~90ms for conversation spanning 4 months across 3 tiers
  (vs. 500-2000ms for the LLM call that follows)
```

**Columnar advantage for cold reads:** On object storage, ClickHouse reads only the columns in the SELECT clause. If a message has 12 columns but you SELECT 4, the cold read transfers ~33% of the data.

### 6.6 Full Storage Configuration

```xml
<!-- ClickHouse storage policy -- cloud-agnostic -->
<storage_configuration>
  <disks>
    <!-- Hot: local NVMe or instance storage -->
    <local>
      <path>/var/lib/clickhouse/</path>
    </local>

    <!-- Warm (optional): attached block storage, cheaper than NVMe -->
    <warm_ssd>
      <path>/mnt/warm/clickhouse/</path>
    </warm_ssd>

    <!-- Cold: AWS S3 -->
    <cold_s3>
      <type>s3</type>
      <endpoint>https://{bucket}.s3.{region}.amazonaws.com/clickhouse/</endpoint>
      <access_key_id>{from_env}</access_key_id>
      <secret_access_key>{from_env}</secret_access_key>
      <metadata_path>/var/lib/clickhouse/disks/cold_s3/</metadata_path>
    </cold_s3>

    <!-- Cold: Azure Blob Storage -->
    <cold_azure>
      <type>azure_blob_storage</type>
      <storage_account_url>https://{account}.blob.core.windows.net</storage_account_url>
      <container_name>clickhouse-archive</container_name>
      <account_name>{from_env}</account_name>
      <account_key>{from_env}</account_key>
      <metadata_path>/var/lib/clickhouse/disks/cold_azure/</metadata_path>
    </cold_azure>

    <!-- Cold: GCP Cloud Storage (S3-compatible API) -->
    <cold_gcs>
      <type>s3</type>
      <endpoint>https://storage.googleapis.com/{bucket}/clickhouse/</endpoint>
      <access_key_id>{from_env}</access_key_id>
      <secret_access_key>{from_env}</secret_access_key>
      <metadata_path>/var/lib/clickhouse/disks/cold_gcs/</metadata_path>
    </cold_gcs>
  </disks>

  <policies>
    <!-- 3-tier policy: hot -> warm -> cold -->
    <tiered_3>
      <volumes>
        <hot>
          <disk>local</disk>
        </hot>
        <warm>
          <disk>warm_ssd</disk>
        </warm>
        <cold>
          <!-- Select ONE based on deployment target -->
          <disk>cold_s3</disk>          <!-- AWS -->
          <!-- <disk>cold_azure</disk>  <!-- Azure --> -->
          <!-- <disk>cold_gcs</disk>    <!-- GCP --> -->
        </cold>
      </volumes>
      <move_factor>0.1</move_factor>
    </tiered_3>

    <!-- 2-tier policy: hot -> cold (simpler, skip warm) -->
    <tiered_2>
      <volumes>
        <hot>
          <disk>local</disk>
        </hot>
        <cold>
          <disk>cold_s3</disk>          <!-- or cold_azure / cold_gcs -->
        </cold>
      </volumes>
    </tiered_2>
  </policies>
</storage_configuration>
```

### 6.7 Monitoring Tiered Storage

```sql
-- Check which parts are on which volume
SELECT
    partition,
    disk_name,
    count() AS parts,
    formatReadableSize(sum(bytes_on_disk)) AS size
FROM system.parts
WHERE table = 'messages' AND active
GROUP BY partition, disk_name
ORDER BY partition DESC;

-- Check TTL status
SELECT
    table,
    partition,
    rows,
    formatReadableSize(bytes_on_disk) AS size,
    delete_ttl_info_min,
    delete_ttl_info_max,
    move_ttl_info
FROM system.parts
WHERE table = 'messages' AND active
ORDER BY partition DESC
LIMIT 10;
```

### 6.8 Failure Handling and Resilience

**Object storage temporarily unreachable:**

- Writes continue to hot volume -- no impact on live operations
- Hot/warm reads unaffected
- Cold reads fail with retriable error -- application can fall back to "data unavailable" for old conversations
- TTL movement pauses -- data stays on current volume until target is available
- No data loss -- source data is never deleted until confirmed written to target
- Automatic recovery -- pending movements resume on next merge cycle

**Hot volume full:**

- ClickHouse uses `move_factor` (default 0.1) to proactively move data when disk usage exceeds 90%
- If hot volume fills completely, new writes fail -- this is a capacity planning issue
- Alert on `system.disks` free space to prevent this

**Merge contention during high write throughput:**

- ClickHouse has configurable `max_bytes_to_merge_at_max_space_in_pool` to limit merge size during peak writes
- TTL-triggered merges respect the same concurrency limits as normal merges
- In worst case, TTL movement is delayed (data stays on hot longer) but never lost

---

## 7. Store Interfaces

Abstract interfaces decouple application logic from storage engine. All application code uses interfaces via store factory.

```typescript
// packages/compiler/src/platform/stores/message-store.ts

export interface MessageStore {
  /** Write a single message (buffered for batch insert) */
  write(conversationId: string, msg: MessageInput): Promise<void>;

  /** Get messages for a conversation, ordered by timestamp */
  getByConversation(
    conversationId: string,
    opts?: { limit?: number; before?: Date; after?: Date },
  ): Promise<Message[]>;

  /** Delete all messages for a contact (GDPR) */
  deleteByContact(organizationId: string, contactId: string): Promise<number>;

  /** Scrub PII in messages older than date */
  scrubPII(organizationId: string, before: Date): Promise<number>;

  /** Count messages for a conversation */
  count(conversationId: string): Promise<number>;
}

// packages/compiler/src/platform/stores/trace-store.ts

export interface TraceStore {
  /** Write a batch of trace events */
  writeBatch(events: TraceEvent[]): Promise<void>;

  /** Get trace events for a conversation */
  getByConversation(
    conversationId: string,
    opts?: { types?: string[]; limit?: number },
  ): Promise<TraceEvent[]>;

  /** Search traces across conversations */
  search(query: TraceQuery): Promise<TraceEvent[]>;

  /** Get span tree for a conversation */
  getSpanTree(conversationId: string): Promise<SpanNode[]>;
}

// packages/compiler/src/platform/stores/metrics-store.ts

export interface MetricsStore {
  /** Record an LLM usage metric */
  record(metric: LLMMetricInput): Promise<void>;

  /** Get usage summary for an organization */
  getUsage(organizationId: string, period: { from: Date; to: Date }): Promise<UsageSummary>;

  /** Get cost breakdown by model */
  getCostBreakdown(
    organizationId: string,
    period: { from: Date; to: Date },
  ): Promise<CostBreakdown[]>;
}

// packages/compiler/src/platform/stores/conversation-store.ts

export interface ConversationStore {
  createSession(params: CreateConversationParams): Promise<Conversation>;
  getSession(conversationId: string): Promise<Conversation | null>;
  updateSession(conversationId: string, updates: Partial<Conversation>): Promise<void>;

  /** Link a contact to an existing conversation (async identification) */
  linkContact(conversationId: string, contactId: string): Promise<void>;

  /** Query conversations with filters */
  query(params: QueryConversationParams): Promise<PaginatedResult<Conversation>>;

  /** Archive old conversations (batch) */
  archiveBefore(organizationId: string, before: Date): Promise<number>;
}
```

### Implementation Mapping

| Interface           | Implementation                                  | Backend                                       |
| ------------------- | ----------------------------------------------- | --------------------------------------------- |
| `MessageStore`      | `ClickHouseMessageStore` + `RedisMessageBuffer` | ClickHouse (messages table)                   |
| `TraceStore`        | `ClickHouseTraceStore`                          | ClickHouse (traces table, via OTEL Collector) |
| `MetricsStore`      | `ClickHouseMetricsStore`                        | ClickHouse (llm_metrics table)                |
| `ConversationStore` | `MongoConversationStore`                        | MongoDB (conversations collection)            |
| `AuditStore`        | `ClickHouseAuditStore`                          | ClickHouse (audit_events table)               |
| `ContactStore`      | `MongoContactStore`                             | MongoDB (contacts collection)                 |
| `FactStore`         | `MongoFactStore`                                | MongoDB (facts collection)                    |

---

## 8. OTEL Integration

The platform deploys an OTEL Collector in Kubernetes. The target architecture routes traces, metrics, and logs through OTEL to ClickHouse. For the full observability roadmap, see [PLATFORM_OBSERVABILITY_ROADMAP.md](./PLATFORM_OBSERVABILITY_ROADMAP.md).

### 8.1 OTEL Collector Configuration

```yaml
# otel-collector-config.yaml
receivers:
  otlp:
    protocols:
      grpc:
        endpoint: 0.0.0.0:4317
      http:
        endpoint: 0.0.0.0:4318

exporters:
  clickhouse/traces:
    endpoint: tcp://clickhouse:9000
    database: abl
    table_name: traces
    ttl: 90d

  clickhouse/metrics:
    endpoint: tcp://clickhouse:9000
    database: abl
    metrics_table_name: llm_metrics

  clickhouse/logs:
    endpoint: tcp://clickhouse:9000
    database: abl
    logs_table_name: logs
    ttl: 30d

service:
  pipelines:
    traces:
      receivers: [otlp]
      exporters: [clickhouse/traces]
    metrics:
      receivers: [otlp]
      exporters: [clickhouse/metrics]
    logs:
      receivers: [otlp]
      exporters: [clickhouse/logs]
```

### 8.2 Application Instrumentation

```typescript
// packages/compiler/src/platform/observability/otel.ts

import { trace, metrics, SpanKind } from '@opentelemetry/api';

const tracer = trace.getTracer('abl-runtime');
const meter = metrics.getMeter('abl-llm');

// LLM call instrumentation
export function traceLLMCall(params: LLMCallParams) {
  return tracer.startActiveSpan(
    'llm.call',
    {
      kind: SpanKind.CLIENT,
      attributes: {
        'llm.model': params.modelId,
        'llm.provider': params.provider,
        'organization.id': params.organizationId,
        'conversation.id': params.conversationId,
      },
    },
    async (span) => {
      try {
        const result = await params.execute();
        span.setAttributes({
          'llm.input_tokens': result.inputTokens,
          'llm.output_tokens': result.outputTokens,
          'llm.latency_ms': result.latencyMs,
        });
        return result;
      } catch (error) {
        span.recordException(error);
        throw error;
      } finally {
        span.end();
      }
    },
  );
}
```

---

## 9. Retention Strategy & TTL Lifecycle

### 9.1 Retention by Data Type

| Data Type                | Hot (local NVMe) | Warm (SSD)  | Cold (object storage) | Delete             | Mechanism                  |
| ------------------------ | ---------------- | ----------- | --------------------- | ------------------ | -------------------------- |
| Messages                 | 30 days          | 30-90 days  | 90 days - 2 years     | After 2 years      | ClickHouse TTL             |
| Messages (PII content)   | 14 days          | --          | --                    | Scrubbed at 14d    | ClickHouse TTL SET         |
| Traces                   | 7 days           | 7-30 days   | 30-90 days            | After 90 days      | ClickHouse TTL             |
| Logs                     | 3 days           | 3-14 days   | 14-30 days            | After 30 days      | ClickHouse TTL             |
| LLM Metrics (raw)        | 90 days          | 90-365 days | 365-730 days          | After 730 days     | ClickHouse TTL             |
| LLM Metrics (hourly)     | Forever          | --          | --                    | After 3 years      | AggregatingMergeTree       |
| LLM Metrics (daily)      | Forever          | --          | --                    | After 3 years      | AggregatingMergeTree       |
| Audit Events             | 90 days          | --          | 90+ days              | Never (manual)     | ClickHouse TTL (no DELETE) |
| Conversations (metadata) | Forever          | --          | --                    | On explicit delete | MongoDB                    |
| Contacts                 | Forever          | --          | --                    | On GDPR request    | MongoDB                    |

### 9.2 How TTL Eliminates the Retention Sweep Problem

**Previous approach (caused outages):**

```
Daily cron -> query expired records -> loop -> DELETE one-by-one -> index updates -> I/O contention
```

**Current approach (zero operational load):**

```
ClickHouse background merge -> check TTL per partition -> drop expired partitions -> done
```

ClickHouse's TTL operates at the partition level. When all data in a partition expires, the entire partition is dropped -- equivalent to MongoDB's `collection.drop()` but automated. No per-row deletes, no index updates, no I/O contention with application queries.

### 9.3 Simplified Retention Scheduler

The retention scheduler handles only MongoDB metadata:

```typescript
// Only handles MongoDB metadata -- no message/trace/metric work
async function executeDailySweep(): Promise<void> {
  const orgs = await getOrganizations();

  for (const org of orgs) {
    const policy = resolveRetentionPolicy(org);

    // Archive old conversations (metadata only -- messages handled by ClickHouse TTL)
    await conversationStore.archiveBefore(org.id, policy.archiveDate);

    // Delete archived conversations past retention
    await conversationStore.deleteBefore(org.id, policy.deleteDate);

    // These are batch operations on MongoDB -- low volume, fast
  }
}
```

No message deletion. No trace purging. No PII scrubbing loop. ClickHouse handles all of it.

---

## 10. GDPR Implementation

### 10.1 Right to Erasure Flow

```
GDPR Request received
    |
    +-> MongoDB: Find Contact by identity
    |     +-> Get contactId
    |
    +-> MongoDB: Find Conversations by contactId
    |     +-> Get conversation IDs
    |     +-> Delete or anonymize conversation metadata
    |
    +-> ClickHouse: Delete messages by contactId
    |     ALTER TABLE messages DELETE
    |     WHERE tenant_id = ? AND contact_id = ?
    |     (async lightweight delete -- physically removed during merge)
    |
    +-> ClickHouse: Delete traces by conversation IDs
    |     ALTER TABLE traces DELETE
    |     WHERE tenant_id = ? AND session_id IN (?)
    |
    +-> ClickHouse: Delete metrics by conversation IDs
    |     ALTER TABLE llm_metrics DELETE
    |     WHERE tenant_id = ? AND session_id IN (?)
    |
    +-> MongoDB: Anonymize audit log entries
    |     db.auditLog.updateMany(
    |       { userId: subjectId, organizationId: tenantId },
    |       { $set: { userId: '[ANONYMIZED:hash]' } }
    |     )
    |
    +-> MongoDB: Mark DeletionRequest as completed
```

### 10.2 Key Fixes from Previous Implementation

| Bug                                     | Previous                         | Fixed                                                |
| --------------------------------------- | -------------------------------- | ---------------------------------------------------- |
| `findSubjectMessages` returns all users | `role: 'user'` only              | Query by `contact_id` on ClickHouse (denormalized)   |
| `anonymizeAuditEntries` ignores tenant  | `where: { userId }`              | `where: { userId, organizationId }`                  |
| N+1 trace anonymization                 | `for (id of ids) { update(id) }` | `ALTER TABLE traces DELETE WHERE ... IN (?)` (batch) |
| No pagination on GDPR queries           | `findMany` with no limit         | ClickHouse handles large result sets natively        |

---

## 11. Migration Plan

### Phase 0: Store Abstraction -- COMPLETE

Created `MessageStore`, `TraceStore`, `MetricsStore`, `ConversationStore`, `AuditStore`, `ContactStore`, `FactStore` interfaces in `packages/compiler/src/platform/stores/`. All application code uses interfaces via store factory.

### Phase 1: Fix Critical Bugs -- COMPLETE

All GDPR bugs fixed (commit `2424c69`). Contact and Conversation models implemented in MongoDB. N+1 patterns eliminated.

### Phase 2: ClickHouse Message Store -- COMPLETE

1. ClickHouse tables created (`messages`, `traces`, `llm_metrics`, `logs`, `audit_events`)
2. `ClickHouseMessageStore` implemented with `BufferedClickHouseWriter`
3. MongoDB stores implemented for metadata (conversations, contacts, facts, workflows)
4. Store factory (`DB_BACKEND=mongo`) routes to MongoDB + ClickHouse stores

**Why not dual-write:** A dual-write approach was considered and rejected. Failure ambiguity (which DB is source of truth on partial failure?), doubled write load at 25M messages/day, and unnecessary complexity for append-only data. The store abstraction makes the switch a single config change -- swap `MongoMessageStore` for `ClickHouseMessageStore`.

### Phase 3: OTEL Pipeline -- PLANNED

1. Configure OTEL Collector with ClickHouse exporters
2. Instrument runtime with OpenTelemetry spans for traces
3. Route LLM metrics through OTEL meter
4. Route structured logs through OTEL logger
5. Verify data in ClickHouse matches current in-memory traces

### Phase 4: Prisma Removal -- PLANNED

1. Remove Prisma `Message` model and `LLMUsageMetric` model
2. Remove all `prisma-*-store.ts` files from runtime
3. Remove `PrismaRetentionStore` and `PrismaGDPRStore`
4. Remove SQLite dev database and Prisma schema
5. Remove `DB_BACKEND` config toggle -- MongoDB + ClickHouse is the only path
6. Update MCP debug tools to query ClickHouse for traces

### Backfill Strategy

One-time historical data migration from MongoDB to ClickHouse:

```
MongoDB messages collection
    |
    +-> Export cursor (ordered by timestamp, batched by conversation)
    |     - Read batch of 10,000 messages
    |     - Transform: add tenant_id, contact_id (denormalize from Session/Contact)
    |     - Batch insert into ClickHouse
    |     - Checkpoint: record last processed timestamp
    |
    +-> Parallelism: one worker per tenant (large tenants get dedicated workers)
    |
    +-> Idempotency: ClickHouse ReplacingMergeTree deduplicates by message_id
    |     or use INSERT with deduplication token
    |
    +-> Validation after completion:
          - Count: MongoDB message count == ClickHouse message count per tenant
          - Spot check: random sample of 1,000 conversations, compare content hashes
          - Edge cases: verify conversations spanning midnight boundaries
```

**Duration estimate:** 90 days x 25M messages/day = ~2.25B messages. ClickHouse ingestion at 500K rows/sec = ~75 minutes for data transfer. With transformation and validation: 4-8 hours total.

---

## 12. Per-Tenant Cluster Isolation

### 12.1 When to Isolate

| Criterion        | Shared Cluster | Dedicated Cluster                               |
| ---------------- | -------------- | ----------------------------------------------- |
| Sessions/day     | < 500K         | > 500K                                          |
| Data sovereignty | Not required   | Required (EU, specific region)                  |
| Compliance       | Standard       | HIPAA, PCI-DSS with dedicated infra requirement |
| SLA              | Standard       | Custom SLA with independent maintenance windows |

### 12.2 Tenant Router

```typescript
// apps/platform/src/services/tenant-router.ts

interface ClusterConfig {
  mongoUri: string;
  clickhouseHost: string;
  redisUri: string;
}

class TenantRouter {
  private configs: Map<string, ClusterConfig> = new Map();
  private defaultConfig: ClusterConfig;

  async getConfig(organizationId: string): Promise<ClusterConfig> {
    // Check cache first
    if (this.configs.has(organizationId)) {
      return this.configs.get(organizationId)!;
    }

    // Look up in config store (MongoDB on management cluster)
    const override = await this.lookupOverride(organizationId);
    if (override) {
      this.configs.set(organizationId, override);
      return override;
    }

    return this.defaultConfig;
  }
}
```

### 12.3 Dedicated Cluster Topology

```
Per-tenant dedicated cluster:

  MongoDB:     3-node replica set (no sharding needed -- single tenant)
  ClickHouse:  2-node replicated (or ClickHouse Cloud)
  Redis:       Single node or ElastiCache/Memorystore

  All in tenant's required region.
  Independent backup, maintenance, and scaling schedule.
```

### 12.4 Management Plane

A lightweight management cluster holds:

- Tenant-to-cluster mapping
- Cluster health monitoring
- Schema migration status per cluster
- Cross-tenant analytics (aggregated, not raw data)

---

## Appendix A: Volume Reference

```
1M sessions/day x 25 messages/session:

  Messages:      25,000,000/day    =   290/sec sustained     1,500/sec peak
  Traces:       200,000,000/day    = 2,300/sec sustained    12,000/sec peak
  Logs:          65,000,000/day    =   750/sec sustained     3,750/sec peak
  LLM Metrics:   40,000,000/day    =   460/sec sustained     2,300/sec peak
  Audit Events:  10,000,000/day    =   115/sec sustained       580/sec peak
  -----------------------------------------------------------------------
  Total:        340,000,000/day    = 3,915/sec sustained    20,130/sec peak

  Monthly:    ~10,000,000,000 documents
  Annual:    ~120,000,000,000 documents

  Storage (90-day active, ClickHouse compressed):
    Messages:    ~2.25 TB
    Traces:      ~900 GB
    Logs:        ~270 GB
    Metrics:     ~180 GB
    Audit:       ~135 GB
    ----------------------
    Total:       ~3.7 TB active + cold archive on object storage
```

## Appendix B: Decision Log

| Decision              | Options Considered                              | Chosen                             | Rationale                                                                               |
| --------------------- | ----------------------------------------------- | ---------------------------------- | --------------------------------------------------------------------------------------- |
| Message store         | MongoDB, Cassandra/ScyllaDB, ClickHouse         | ClickHouse                         | Already deployed; handles all data types; built-in tiered storage; SQL analytics        |
| Trace store           | In-memory, MongoDB, ClickHouse                  | ClickHouse via OTEL                | Columnar compression for 200M/day; OTEL Collector already in K8s                        |
| Metadata store        | MongoDB, PostgreSQL                             | MongoDB                            | Flexible schema; adequate for ~1M writes/day; familiar to team                          |
| Cold storage          | S3+Parquet, Azure Blob, GCS                     | ClickHouse tiered storage          | Cloud-agnostic; no separate query engine needed; transparent to application             |
| Active session buffer | Application memory, Redis, DragonflyDB          | Redis                              | Well-understood; sub-ms reads; 100ms flush acceptable for voice latency budget          |
| Retention mechanism   | Batch DELETE sweep, TTL index, partition drop   | ClickHouse TTL (partition drop)    | Zero operational load; no sweep job; no I/O contention                                  |
| Contact model         | Inline on Session, separate model, external CRM | Separate MongoDB model (optional)  | Supports GDPR, journey tracking; optional for anonymous voice                           |
| Session model         | Keep dual (AgentSession + Session), unify       | Unified Conversation model         | Eliminates confusion; single model for debug, CX, and EX use cases                      |
| Migration strategy    | Dual-write, backfill + flag cutover             | Backfill + per-tenant feature flag | Dual-write adds failure ambiguity, doubles write load, unnecessary for append-only data |
| Audit store           | MongoDB, ClickHouse                             | ClickHouse                         | 10M/day volume; no delete TTL for regulatory compliance; cold-tier for long retention   |
| PII scrubbing         | Application sweep, TTL SET, crypto-shredding    | ClickHouse TTL SET                 | Zero application code; columnar rewrite during merge; no I/O contention                 |
| PostgreSQL            | Metadata store, high-volume store, third DB     | Not adopted                        | Marginally better for metadata (FK integrity); architectural mismatch for high volume   |
