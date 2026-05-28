# Production Readiness Assessment: Analytics & Observability

**Assessment Date**: 2026-02-27
**Branch**: events_architecture
**Scope**: ClickHouse infrastructure, event store architecture, observability stack

---

## Executive Summary

The analytics and observability infrastructure is **75% production-ready**. Core architecture is solid with proper tenant isolation, buffered writes, encryption, and tiered storage. However, **critical gaps exist in partitioning strategy, monitoring, disaster recovery, and operational tooling**.

### Status Overview

| Component                 | Status                     | Confidence |
| ------------------------- | -------------------------- | ---------- |
| **Data Architecture**     | ✅ Ready                   | High       |
| **Partitioning Strategy** | ⚠️ **NEEDS REVIEW**        | Medium     |
| **Tenant Isolation**      | ✅ Ready                   | High       |
| **Encryption & PII**      | ✅ Ready                   | High       |
| **Buffered Writes**       | ✅ Ready                   | High       |
| **Retention & TTL**       | ✅ Ready                   | High       |
| **Query Performance**     | ⚠️ Untested                | Low        |
| **Monitoring & Alerting** | ❌ **MISSING**             | N/A        |
| **Disaster Recovery**     | ❌ **MISSING**             | N/A        |
| **Replication**           | ⚠️ Configured but untested | Low        |
| **Load Testing**          | ❌ **NOT DONE**            | N/A        |
| **Runbooks**              | ❌ **MISSING**             | N/A        |

---

## 1. Partitioning Strategy Analysis

### Current Implementation

You correctly identified this as a critical concern. Here's the full breakdown:

| Table                     | Partition Key            | Granularity | Date Filter Optimized? |
| ------------------------- | ------------------------ | ----------- | ---------------------- |
| `messages`                | `toYYYYMMDD(created_at)` | **Daily**   | ✅ **Excellent**       |
| `traces`                  | `toYYYYMMDD(timestamp)`  | **Daily**   | ✅ **Excellent**       |
| `platform_events`         | `toDate(timestamp)`      | **Daily**   | ✅ **Excellent**       |
| `llm_metrics`             | `toYYYYMM(timestamp)`    | **Monthly** | ⚠️ **OK**              |
| `audit_events`            | `toYYYYMM(timestamp)`    | **Monthly** | ⚠️ **OK**              |
| `search_queries`          | `toYYYYMM(timestamp)`    | **Monthly** | ⚠️ **OK**              |
| `search_ingestion_events` | `toYYYYMM(timestamp)`    | **Monthly** | ⚠️ **OK**              |
| `logs`                    | `toYYYYMM(timestamp)`    | **Monthly** | ⚠️ **OK**              |
| `kms_audit_log`           | `toYYYYMM(timestamp)`    | **Monthly** | ⚠️ **OK**              |

### Assessment

#### ✅ **GOOD: High-volume, short-TTL tables use daily partitions**

- **messages** (90-day TTL, high write volume): Daily partitioning ✅
- **traces** (90-day TTL, highest write volume): Daily partitioning ✅
- **platform_events** (730-day TTL, high write volume): Daily partitioning ✅

**Why this works**:

- Partition pruning is extremely efficient for date range queries (e.g., "last 24 hours", "last 7 days")
- TTL deletion is fast — when entire partitions expire, ClickHouse drops them with `ALTER TABLE ... DROP PARTITION` (near-instant)
- Daily partitions mean ~90 partitions for 90-day retention — well within ClickHouse's recommended limit (1000 partitions/table)

#### ⚠️ **CONCERN: Monthly partitions for some long-retention tables**

- **llm_metrics** (730-day TTL): Monthly = ~24 partitions ✅
- **audit_events** (permanent, no DELETE TTL): Monthly = growing unbounded ❌
- **kms_audit_log** (1095-day TTL): Monthly = ~36 partitions ✅

**The Problem with `audit_events`**:

```sql
PARTITION BY toYYYYMM(timestamp)
TTL timestamp + INTERVAL 90 DAY TO VOLUME 'cold'
-- NO DELETE TTL!
```

This means:

- Partitions **never** drop automatically
- Audit data grows forever unless manually purged
- This might be intentional for compliance (7-year retention), but it's undocumented

**Recommendation**: Decide on audit retention policy NOW:

- **Option 1 (compliance)**: Keep monthly partitions, add explicit TTL: `TTL timestamp + INTERVAL 2555 DAY DELETE` (7 years)
- **Option 2 (cost-optimized)**: Add TTL: `TTL timestamp + INTERVAL 1095 DAY DELETE` (3 years)
- **Option 3 (aggressive)**: Add TTL: `TTL timestamp + INTERVAL 365 DAY DELETE` (1 year)

#### 🔍 **Date Filter Performance Check**

Your queries **DO leverage partition pruning correctly**. Evidence:

```typescript
// packages/eventstore/src/stores/clickhouse/clickhouse-event-store.ts:106
const conditions: string[] = [
  'tenant_id = {tenantId:String}',
  'project_id = {projectId:String}',
  'timestamp >= {from:DateTime64(3)}', // ✅ Date filter
  'timestamp <= {to:DateTime64(3)}', // ✅ Date filter
];
```

ClickHouse will prune partitions based on `timestamp >= from AND timestamp <= to` **before** scanning rows. This is optimal.

**However**, there's a subtle issue with monthly-partitioned tables:

```sql
-- Query: "Show me audit events from 2026-02-01 to 2026-02-03" (3 days)
-- Partition: 202602 (entire month of February)
-- Result: ClickHouse scans ALL OF FEBRUARY, then filters to 3 days
-- Wasted I/O: ~27 days of data read unnecessarily
```

For daily-partitioned tables, this problem doesn't exist — only 3 partitions are scanned.

### Recommendations

#### Immediate Actions

1. **Add explicit TTL to `audit_events`**:

   ```sql
   ALTER TABLE abl_platform.audit_events
   MODIFY TTL timestamp + INTERVAL 2555 DAY DELETE;
   ```

2. **Document partition strategy** in `docs/db/PARTITIONING_STRATEGY.md`:
   - Daily: High-volume, short-retention tables (<365 days)
   - Monthly: Lower-volume, long-retention tables (>365 days)
   - Rationale for each table's choice

3. **Add partition count monitoring** (see Monitoring section)

#### Future Optimizations

If audit queries commonly filter on narrow date ranges (e.g., "last 24 hours"), consider:

```sql
-- Migration: Switch to daily partitioning
ALTER TABLE abl_platform.audit_events
MODIFY PARTITION BY toYYYYMMDD(timestamp);
```

But this is **not urgent** — audit queries are infrequent and monthly partitioning is acceptable for compliance use cases.

---

## 2. ORDER BY Key Analysis

### Current ORDER BY Keys

| Table             | ORDER BY                                                    | Query Optimization                        |
| ----------------- | ----------------------------------------------------------- | ----------------------------------------- |
| `messages`        | `(tenant_id, session_id, created_at)`                       | ✅ Optimized for session retrieval        |
| `traces`          | `(tenant_id, session_id, trace_id, timestamp)`              | ✅ Optimized for trace retrieval          |
| `platform_events` | `(tenant_id, category, event_type, timestamp)`              | ✅ Optimized for category/type queries    |
| `llm_metrics`     | `(tenant_id, toStartOfHour(timestamp), model_id, provider)` | ⚠️ Hour-truncated timestamp               |
| `audit_events`    | `(tenant_id, timestamp, action)`                            | ✅ Optimized for time-based audit queries |

### Assessment

#### ✅ **Tenant isolation is PERFECT**

Every table has `tenant_id` as the **first column** in `ORDER BY`. This means:

- ClickHouse primary index is structured: `(tenant_id, ...other keys)`
- Queries filtering by `tenant_id` skip data for all other tenants **at the index level** (not just row-level filtering)
- This is a **zero-tolerance security requirement** — correctly implemented ✅

#### ⚠️ **Potential issue: `llm_metrics` ORDER BY hour-truncated timestamp**

```sql
ORDER BY (tenant_id, toStartOfHour(timestamp), model_id, provider)
```

**Problem**: If you query by exact timestamp (not hour boundary), ClickHouse can't use the index efficiently:

```sql
-- Efficient (queries by hour boundary):
SELECT * FROM llm_metrics
WHERE tenant_id = 'tenant-1'
  AND toStartOfHour(timestamp) = '2026-02-27 14:00:00';

-- Inefficient (queries by specific minute/second):
SELECT * FROM llm_metrics
WHERE tenant_id = 'tenant-1'
  AND timestamp >= '2026-02-27 14:23:15'
  AND timestamp <= '2026-02-27 14:45:30';
```

**Impact**: Medium — most LLM metrics queries are hourly/daily aggregations, so this is likely fine. But if you ever need high-resolution queries (e.g., "all LLM calls in the last 5 minutes for debugging"), performance will degrade.

**Recommendation**: Monitor query patterns. If sub-hour queries become common, change to:

```sql
ORDER BY (tenant_id, timestamp, model_id, provider)
```

---

## 3. Replication & High Availability

### Current State

```sql
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.platform_events', '{replica}')
```

All tables use `ReplicatedMergeTree` with ClickHouse Keeper paths configured. **This is correct**.

### Gaps

❌ **ClickHouse Keeper cluster is NOT production-ready**

The DDL assumes a Keeper ensemble exists at `/clickhouse/tables/{shard}/...`, but:

- **Keeper ensemble size not documented** — should be 3 or 5 nodes (odd number for quorum)
- **Keeper configuration not in repo** — need keeper config YAML
- **Failover behavior not tested** — what happens when a Keeper node dies?
- **Replication lag monitoring not configured** — how do you know replicas are in sync?

### Required Actions

1. **Document Keeper topology** in `docs/CLICKHOUSE_PRODUCTION.md`:

   ```yaml
   # Example: 3-node Keeper ensemble
   keeper-1: 10.0.1.10:2181
   keeper-2: 10.0.1.11:2181
   keeper-3: 10.0.1.12:2181
   ```

2. **Add Keeper health checks** to runtime health probe:

   ```typescript
   // apps/runtime/src/health/clickhouse-probe.ts
   async checkKeeperHealth() {
     const result = await this.client.query({
       query: 'SELECT * FROM system.zookeeper WHERE path = \'/clickhouse\'',
     });
     return result.rows.length > 0;
   }
   ```

3. **Test failover scenarios**:
   - Kill a Keeper node → verify writes continue
   - Kill a ClickHouse replica → verify reads failover
   - Network partition between replicas → verify split-brain doesn't occur

4. **Add replication lag monitoring**:
   ```sql
   SELECT
     database,
     table,
     replica_name,
     absolute_delay,
     queue_size
   FROM system.replicas
   WHERE absolute_delay > 60; -- Alert if replica is >60s behind
   ```

---

## 4. Write Path & Buffering

### Current Implementation

All stores use `BufferedClickHouseWriter`:

```typescript
new BufferedClickHouseWriter(this.client, {
  table: this.table,
  batchSize: 10_000, // Insert every 10K rows
  flushIntervalMs: 5_000, // Or every 5 seconds
  maxBufferSize: 100_000, // Max 100K rows in memory
  maxRetries: 3,
});
```

### Assessment

✅ **Buffering strategy is production-ready**

- **Batch size (10K)**: Optimal for ClickHouse — reduces insert overhead
- **Flush interval (5s)**: Acceptable latency for observability data (not real-time dashboards)
- **Max buffer (100K)**: Reasonable memory limit (~10-50MB depending on row size)
- **Retries (3)**: Handles transient network issues

✅ **Fire-and-forget writes with error logging**:

```typescript
onError: (err, context) => {
  console.error('ClickHouseEventStore buffer error', {
    error: err instanceof Error ? err.message : String(err),
    context,
    table: this.table,
  });
};
```

### Gaps

⚠️ **Error handling is insufficient for production**

Current implementation **logs errors but doesn't alert or retry intelligently**:

```typescript
onError: (err, ctx) => {
  console.error('[ClickHouseTraceStore] Writer flush error:', err, ctx);
  // What if ClickHouse is down for 10 minutes?
  // Buffer fills to 100K → new events are DROPPED SILENTLY
};
```

**Data loss scenarios**:

1. ClickHouse replica is down for 10 minutes
2. Buffer fills to 100K events
3. New events trigger `insert()` but buffer is full → **DROPPED**
4. No alert, no retry, no backpressure

### Required Actions

1. **Add buffer overflow alerting**:

   ```typescript
   if (this.writer.pending > 90_000) {
     // Alert: Buffer is 90% full
     logger.error('ClickHouse buffer near capacity', {
       pending: this.writer.pending,
       table: this.table,
     });
     // Trigger PagerDuty/Slack alert
   }
   ```

2. **Add backpressure mechanism**:

   ```typescript
   if (this.writer.pending > 95_000) {
     // Reject new writes with 503 Service Unavailable
     throw new Error('ClickHouse buffer full - writes temporarily unavailable');
   }
   ```

3. **Add dead-letter queue for failed batches**:

   ```typescript
   onError: async (err, rows) => {
     // Write failed batch to Redis/S3 for manual replay
     await redis.lpush('clickhouse:failed_events', JSON.stringify(rows));
     logger.error('ClickHouse write failed - events saved to DLQ', {
       count: rows.length,
       error: err.message,
     });
   };
   ```

4. **Add flush success metrics**:
   ```typescript
   onSuccess: (rowCount, durationMs) => {
     metrics.increment('clickhouse.writes.success', rowCount);
     metrics.histogram('clickhouse.write.latency', durationMs);
   };
   ```

---

## 5. Query Performance & Indexing

### Current Indexes

| Table             | Skip Indexes                                                              | Purpose                                 |
| ----------------- | ------------------------------------------------------------------------- | --------------------------------------- |
| `messages`        | `bloom_filter(contact_id)`, `set(has_pii, scrubbed)`                      | Contact lookup, PII filtering           |
| `traces`          | `bloom_filter(trace_id)`, `set(event_type)`, `set(has_error)`             | Trace lookup, type/error filtering      |
| `platform_events` | `bloom_filter(session_id, project_id)`, `set(has_error)`                  | Session/project lookup, error filtering |
| `llm_metrics`     | `bloom_filter(session_id)`, `set(operation_type)`                         | Session lookup, operation filtering     |
| `audit_events`    | `set(action)`, `bloom_filter(actor_id, session_id)`, `set(resource_type)` | Comprehensive audit filtering           |

### Assessment

✅ **Index strategy is solid** — bloom filters for high-cardinality lookups (IDs), set indexes for low-cardinality filters (types, flags).

### Gaps

❌ **No query performance testing**

You have **ZERO baseline performance metrics**:

- What's the p95 latency for "get trace by session_id"?
- What's the throughput for "aggregate LLM metrics by model, last 30 days"?
- What happens when you query 1 billion rows?

### Required Actions

1. **Run load test suite** (`scripts/load-test-clickhouse.ts`):

   ```bash
   # Seed 100M events
   node scripts/seed-clickhouse-data.js --events 100000000

   # Benchmark common queries
   node scripts/benchmark-clickhouse-queries.js
   ```

2. **Document query SLOs** in `docs/QUERY_PERFORMANCE_SLO.md`:

   ```markdown
   | Query Type                       | p50    | p95    | p99    |
   | -------------------------------- | ------ | ------ | ------ |
   | Get trace by session_id          | <100ms | <200ms | <500ms |
   | Aggregate LLM metrics (7 days)   | <500ms | <1s    | <2s    |
   | Audit events (30 days, by actor) | <200ms | <500ms | <1s    |
   ```

3. **Add query slow-log monitoring**:

   ```sql
   SELECT
     query,
     query_duration_ms,
     read_rows,
     read_bytes
   FROM system.query_log
   WHERE query_duration_ms > 2000  -- Queries slower than 2s
   ORDER BY query_start_time DESC
   LIMIT 100;
   ```

4. **Create explain-plan debugging tool**:
   ```bash
   # CLI tool: Explain any query
   pnpm clickhouse:explain "SELECT * FROM platform_events WHERE tenant_id = 'foo' AND timestamp > now() - 7d"
   ```

---

## 6. Encryption & PII Handling

### Current Implementation

#### ✅ **Traces & Messages**: Compress-then-encrypt

```typescript
// apps/runtime/src/services/stores/clickhouse-trace-store.ts:78
data: this.encryption.compressAndEncryptForTenant(
  JSON.stringify({ ... }),
  this.tenantId,
),
encrypted: 1,
key_version: 1,
```

#### ✅ **LLM Metrics**: No encryption (token counts are not PII)

```typescript
// apps/runtime/src/services/stores/clickhouse-metrics-store.ts:69
input_tokens: metric.inputTokens,   // Plaintext
output_tokens: metric.outputTokens, // Plaintext
estimated_cost: metric.estimatedCost ?? 0, // Plaintext
```

#### ✅ **Audit Events**: Plaintext (required for compliance queries)

```typescript
// apps/runtime/src/services/stores/clickhouse-audit-store.ts:79
old_value: auditLog.oldValue ? JSON.stringify(auditLog.oldValue) : '',
new_value: auditLog.newValue ? JSON.stringify(auditLog.newValue) : '',
```

### Assessment

✅ **Encryption strategy is correct**:

- PII (messages, traces) → encrypted
- Non-PII (metrics, audit) → plaintext for query performance
- Tenant-scoped DEKs (Data Encryption Keys) via `EncryptionService`

### Gaps

❌ **Key rotation not documented**

- How do you rotate tenant DEKs?
- What happens to old encrypted data after rotation?
- Is there a `key_version` migration path?

### Required Actions

1. **Document key rotation procedure** in `docs/ENCRYPTION_KEY_ROTATION.md`:

   ```markdown
   ## Key Rotation Procedure

   1. Generate new DEK for tenant: `POST /api/admin/tenants/:id/rotate-encryption-key`
   2. Update `key_version` in ClickHouse (no data migration needed — both versions work)
   3. New writes use new key version
   4. Old data decrypts with old key version (stored in `key_version` column)
   5. Background job re-encrypts old data with new key (optional, for compliance)
   ```

2. **Add key version alerting**:
   ```sql
   SELECT
     tenant_id,
     key_version,
     count() AS row_count
   FROM abl_platform.traces
   WHERE timestamp > now() - INTERVAL 7 DAY
   GROUP BY tenant_id, key_version
   HAVING count(DISTINCT key_version) > 2; -- Alert if >2 key versions active
   ```

---

## 7. Retention & TTL

### Current TTL Policies

| Table             | Hot (Local SSD) | Warm (HDD)     | Cold (Object Storage) | Delete             |
| ----------------- | --------------- | -------------- | --------------------- | ------------------ |
| `messages`        | 30 days         | 90 days        | N/A                   | 730 days (2 years) |
| `traces`          | 7 days          | 30 days        | 90 days               | 90 days            |
| `platform_events` | 30 days         | 90 days        | N/A                   | 730 days (2 years) |
| `llm_metrics`     | 90 days         | 365 days       | 730 days              | 730 days (2 years) |
| `audit_events`    | N/A             | 90 days (cold) | N/A                   | **NONE** ⚠️        |
| `logs`            | 3 days          | 14 days        | 30 days               | 30 days            |

### Assessment

✅ **TTL strategy is aggressive and cost-optimized**:

- Traces deleted after 90 days (debugging data)
- Logs deleted after 30 days (troubleshooting)
- Messages/events retained for 2 years (business data)

⚠️ **Audit events have NO deletion TTL** — see Partitioning section.

### Gaps

❌ **TTL scheduler job not implemented**

The schema includes:

```sql
-- PII scrubbing (SET content='[PII_EXPIRED]' after 14 days) is handled by
-- the retention-scheduler job, not TTL SET rules
```

But **no such job exists in the codebase**. PII scrubbing is **NOT HAPPENING**.

### Required Actions

1. **Implement PII scrubbing job** (`apps/runtime/src/jobs/pii-scrubber.ts`):

   ```typescript
   // Run daily via cron
   async function scrubExpiredPII() {
     const cutoffDate = new Date(Date.now() - 14 * 24 * 60 * 60 * 1000);

     await clickhouse.command({
       query: `
         ALTER TABLE abl_platform.messages
         UPDATE content = '[PII_EXPIRED]'
         WHERE has_pii = 1
           AND scrubbed = 0
           AND created_at < {cutoffDate:DateTime64(3)}
       `,
       query_params: { cutoffDate },
     });
   }
   ```

2. **Add TTL monitoring**:

   ```sql
   SELECT
     database,
     table,
     partition,
     min_time,
     max_time,
     rows
   FROM system.parts
   WHERE active = 1
     AND max_time < now() - INTERVAL 732 DAY; -- Alert: Partition should be deleted but still exists
   ```

3. **Document retention policy** in customer-facing docs:
   ```markdown
   | Data Type      | Retention Period                               |
   | -------------- | ---------------------------------------------- |
   | Messages (PII) | Scrubbed after 14 days, deleted after 730 days |
   | Traces         | 90 days                                        |
   | LLM Metrics    | 730 days                                       |
   | Audit Logs     | 7 years (configurable per tenant)              |
   ```

---

## 8. Monitoring & Alerting

### Current State

❌ **NO monitoring configured**

The codebase has:

- ✅ Health check endpoints (`/health`)
- ❌ No Prometheus metrics
- ❌ No Grafana dashboards
- ❌ No alerting rules

### Required Metrics

#### ClickHouse System Metrics

```prometheus
# Query performance
clickhouse_query_duration_seconds{quantile="0.95"}
clickhouse_query_rows_read_total
clickhouse_query_bytes_read_total

# Write performance
clickhouse_insert_rows_total
clickhouse_insert_duration_seconds

# Replication
clickhouse_replica_lag_seconds
clickhouse_replica_queue_size

# Storage
clickhouse_disk_usage_bytes
clickhouse_partition_count

# Errors
clickhouse_query_errors_total
clickhouse_insert_errors_total
```

#### Application Metrics

```prometheus
# Buffer health
clickhouse_buffer_pending_rows{table="traces"}
clickhouse_buffer_flush_success_total
clickhouse_buffer_flush_failure_total

# Event ingestion
platform_events_emitted_total{category="agent", event_type="llm.call.completed"}
platform_events_write_latency_seconds
```

### Required Alerts

```yaml
# Critical Alerts (PagerDuty)
- alert: ClickHouseDown
  expr: up{job="clickhouse"} == 0
  for: 2m

- alert: ClickHouseReplicaLagging
  expr: clickhouse_replica_lag_seconds > 300
  for: 5m

- alert: ClickHouseBufferOverflow
  expr: clickhouse_buffer_pending_rows > 90000
  for: 1m

# Warning Alerts (Slack)
- alert: ClickHouseSlowQueries
  expr: histogram_quantile(0.95, clickhouse_query_duration_seconds) > 5
  for: 10m

- alert: ClickHouseDiskUsageHigh
  expr: clickhouse_disk_usage_bytes / clickhouse_disk_capacity_bytes > 0.85
  for: 30m
```

### Required Actions

1. **Add Prometheus exporter** to runtime:

   ```bash
   pnpm add prom-client
   ```

   ```typescript
   // apps/runtime/src/metrics/prometheus.ts
   import { Registry, Counter, Histogram, Gauge } from 'prom-client';

   export const clickhouseBufferPending = new Gauge({
     name: 'clickhouse_buffer_pending_rows',
     help: 'Number of rows pending in ClickHouse write buffer',
     labelNames: ['table'],
   });
   ```

2. **Create Grafana dashboard** (`deploy/grafana/clickhouse-dashboard.json`):
   - Panel 1: Write throughput (rows/sec)
   - Panel 2: Query latency (p50, p95, p99)
   - Panel 3: Buffer utilization %
   - Panel 4: Replica lag
   - Panel 5: Disk usage by table

3. **Set up on-call rotation** with PagerDuty integration

---

## 9. Disaster Recovery

### Current State

❌ **NO backup strategy documented**

### Required Backup Strategy

ClickHouse supports two backup methods:

#### Option 1: `clickhouse-backup` (Recommended)

```bash
# Install clickhouse-backup
docker run --rm -v /var/lib/clickhouse:/var/lib/clickhouse \
  -v /backups:/backups \
  clickhouse-backup backup --tables "abl_platform.*"

# Incremental backups every 6 hours
# Full backups every Sunday
# Retention: 30 days hot, 90 days cold (S3 Glacier)
```

#### Option 2: Replication to cold standby

```yaml
# Cold standby cluster in different region
clickhouse-standby-us-west-2:
  replica_of: clickhouse-primary-us-east-1
  lag_tolerance: 5 minutes
  promote_to_primary: manual # Requires human approval
```

### Required Actions

1. **Implement automated backups**:

   ```bash
   # Cron job: Backup every 6 hours
   0 */6 * * * clickhouse-backup create --tables "abl_platform.*" --upload
   ```

2. **Test restore procedure** (monthly drill):

   ```bash
   # Restore to test cluster
   clickhouse-backup restore --tables "abl_platform.traces" \
     --from-backup "2026-02-27-00-00-00"

   # Verify data integrity
   clickhouse-client --query "SELECT count() FROM abl_platform.traces"
   ```

3. **Document RTO/RPO**:

   ```markdown
   ## Recovery Time Objective (RTO): 4 hours

   - Time to provision new ClickHouse cluster: 1 hour
   - Time to restore data from S3: 2 hours
   - Time to verify + switch traffic: 1 hour

   ## Recovery Point Objective (RPO): 6 hours

   - Backups run every 6 hours
   - Worst case: Lose last 6 hours of data
   ```

4. **Create runbook** (`docs/runbooks/CLICKHOUSE_RESTORE.md`)

---

## 10. Load Testing & Capacity Planning

### Current State

❌ **NO load testing performed**

You have **ZERO data** on:

- What's the max write throughput?
- What's the max query QPS?
- At what data volume does performance degrade?
- What's the cost per TB of storage?

### Required Load Tests

1. **Write throughput test**:

   ```bash
   # Simulate 10K events/sec for 1 hour
   node scripts/load-test-writes.js \
     --rate 10000 \
     --duration 3600 \
     --table platform_events

   # Measure:
   # - Sustained write rate (rows/sec)
   # - Buffer utilization %
   # - Disk I/O saturation
   # - Replication lag
   ```

2. **Query latency test**:

   ```bash
   # Simulate 100 concurrent dashboard queries
   node scripts/load-test-queries.js \
     --concurrency 100 \
     --queries queries/dashboard-*.sql

   # Measure:
   # - p50, p95, p99 latency
   # - Query cache hit rate
   # - CPU utilization
   ```

3. **Retention simulation**:

   ```bash
   # Seed 2 years of data (730 days)
   node scripts/seed-retention-test.js \
     --days 730 \
     --events-per-day 1000000

   # Measure:
   # - Total disk usage
   # - Query performance on 1-year-old data
   # - TTL deletion time
   ```

### Required Actions

1. **Estimate production load**:

   ```markdown
   ## Projected Load (Month 1)

   - Tenants: 50
   - Active sessions/day: 10,000
   - Events/session: 50
   - Total events/day: 500,000
   - Peak events/sec: ~20

   ## Projected Load (Month 12)

   - Tenants: 500
   - Active sessions/day: 100,000
   - Events/session: 75
   - Total events/day: 7,500,000
   - Peak events/sec: ~300
   ```

2. **Provision cluster for 3x peak load** (headroom for spikes)

3. **Set up autoscaling triggers** (if using cloud):
   ```yaml
   # Scale up when:
   - CPU > 70% for 5 minutes
   - Disk I/O > 80% for 5 minutes
   - Query latency p95 > 2s for 5 minutes
   ```

---

## 11. Operational Runbooks

### Required Runbooks

❌ **NO runbooks exist**

Create the following in `docs/runbooks/`:

1. **CLICKHOUSE_REPLICA_LAGGING.md**:
   - Symptom: `clickhouse_replica_lag_seconds > 300`
   - Diagnosis: `SELECT * FROM system.replicas WHERE absolute_delay > 60`
   - Resolution: Check network, check Keeper, restart replica

2. **CLICKHOUSE_DISK_FULL.md**:
   - Symptom: `clickhouse_disk_usage > 90%`
   - Resolution: Force TTL merge, drop old partitions, scale storage

3. **CLICKHOUSE_QUERY_SLOW.md**:
   - Symptom: Dashboard timeout
   - Diagnosis: `EXPLAIN` query, check `system.query_log`
   - Resolution: Add materialized view, adjust index, cache query

4. **CLICKHOUSE_DATA_LOSS.md**:
   - Symptom: User reports missing data
   - Diagnosis: Check buffer overflow logs, check write errors
   - Resolution: Replay from dead-letter queue, restore from backup

5. **CLICKHOUSE_RESTORE_FROM_BACKUP.md**:
   - Step-by-step restore procedure
   - Expected downtime
   - Verification checklist

---

## 12. Production Readiness Checklist

### Pre-Launch (Must Complete Before Production)

- [ ] **Add explicit TTL to `audit_events`**
- [ ] **Document partition strategy** (docs/db/PARTITIONING_STRATEGY.md)
- [ ] **Implement PII scrubbing job** (apps/runtime/src/jobs/pii-scrubber.ts)
- [ ] **Add buffer overflow alerting**
- [ ] **Add dead-letter queue for failed writes**
- [ ] **Set up Prometheus metrics**
- [ ] **Create Grafana dashboards**
- [ ] **Configure PagerDuty alerts**
- [ ] **Implement automated backups**
- [ ] **Test restore procedure** (monthly drill)
- [ ] **Document RTO/RPO**
- [ ] **Run load test suite**
- [ ] **Document query SLOs**
- [ ] **Create operational runbooks** (5 critical scenarios)
- [ ] **Test Keeper failover** (kill 1 of 3 nodes)
- [ ] **Test ClickHouse replica failover**
- [ ] **Add slow query logging**
- [ ] **Document key rotation procedure**

### Post-Launch (First 30 Days)

- [ ] **Monitor actual vs. projected load**
- [ ] **Tune batch sizes based on real traffic**
- [ ] **Identify slow queries** (p95 > 2s)
- [ ] **Create materialized views for slow queries**
- [ ] **Conduct failover drill** (scheduled maintenance window)
- [ ] **Review and optimize ORDER BY keys** (based on query patterns)
- [ ] **Evaluate monthly vs. daily partitioning** (audit_events, logs)
- [ ] **Set up cost monitoring** (ClickHouse disk usage by table)

---

## 13. Cost Estimation

### Storage Costs (Estimated)

Assumptions:

- 500,000 events/day (Month 1)
- Average event size: 1KB
- Compression ratio: 5:1 (ClickHouse ZSTD)
- Retention: 730 days (platform_events, messages)

```
Raw data/day:      500,000 events × 1KB = 500 MB/day
Compressed:        500 MB / 5 = 100 MB/day
Annual storage:    100 MB/day × 365 = 36.5 GB/year (hot)
2-year retention:  36.5 GB × 2 = 73 GB (total)

Hot storage (SSD): 30 GB × $0.10/GB = $3/month
Warm storage (HDD): 30 GB × $0.05/GB = $1.50/month
Cold storage (S3):  13 GB × $0.02/GB = $0.26/month
Total:              $4.76/month (Month 1)
```

At scale (Month 12):

```
Events/day: 7.5M
Compressed storage/day: 1.5 GB
Annual: 547 GB
2-year: 1.1 TB
Cost: ~$60-80/month
```

### Compute Costs (Estimated)

```
ClickHouse cluster:
- 3 nodes (m5.2xlarge): $0.384/hr × 3 × 730 hrs = $841/month
- ClickHouse Keeper (3 nodes, t3.small): $0.0208/hr × 3 × 730 hrs = $45/month

Total compute: ~$886/month
```

### Total Cost of Ownership (TCO)

```
Month 1:  $890/month (mostly compute)
Month 12: $950/month (compute + 1TB storage)
```

**Optimization opportunities**:

- Use spot instances for Keeper (50% savings)
- Implement tiered storage (move old data to S3)
- Use on-demand scaling (shut down standby replicas during low traffic)

---

## 14. Final Recommendation

### Go / No-Go Decision

**Recommendation: DO NOT launch to production yet**

**Blockers**:

1. ❌ No monitoring or alerting → **Blind to failures**
2. ❌ No disaster recovery → **Data loss risk**
3. ❌ No load testing → **Unknown capacity limits**
4. ❌ No operational runbooks → **Slow incident response**
5. ⚠️ `audit_events` TTL not configured → **Unbounded growth**
6. ⚠️ PII scrubbing job not implemented → **Compliance risk**

### Path to Production (4-Week Plan)

**Week 1: Critical Fixes**

- [ ] Add `audit_events` TTL (1 hour)
- [ ] Implement buffer overflow alerting (4 hours)
- [ ] Add dead-letter queue (8 hours)
- [ ] Implement PII scrubbing job (8 hours)

**Week 2: Monitoring**

- [ ] Add Prometheus metrics (16 hours)
- [ ] Create Grafana dashboards (8 hours)
- [ ] Configure PagerDuty alerts (4 hours)
- [ ] Set up on-call rotation (2 hours)

**Week 3: Disaster Recovery**

- [ ] Implement automated backups (8 hours)
- [ ] Test restore procedure (8 hours)
- [ ] Document RTO/RPO (2 hours)
- [ ] Create operational runbooks (16 hours)

**Week 4: Load Testing & Validation**

- [ ] Run write throughput test (8 hours)
- [ ] Run query latency test (8 hours)
- [ ] Run retention simulation (8 hours)
- [ ] Conduct failover drill (4 hours)

**Total effort**: ~120 hours (~3 weeks for 1 engineer)

---

## Appendix: Quick Wins

If you need to launch ASAP, do these **minimum viable fixes** (1 week):

1. **Add `audit_events` TTL** (1 hour)
2. **Add buffer overflow alerting** (4 hours)
3. **Set up basic Prometheus metrics** (8 hours)
4. **Create 1 Grafana dashboard** (4 hours)
5. **Implement automated backups** (8 hours)
6. **Write 1 runbook** (CLICKHOUSE_DOWN) (2 hours)

Total: **27 hours** (achievable in 1 week)

This gives you:

- ✅ Protection against unbounded growth
- ✅ Visibility into write failures
- ✅ Basic monitoring
- ✅ Data recovery capability
- ✅ Incident response guide

Still risky, but **launchable** if you commit to completing the full checklist within 30 days post-launch.
