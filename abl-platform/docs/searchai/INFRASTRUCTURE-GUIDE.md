# Search-AI Infrastructure Guide

**Version:** 1.0
**Date:** 2026-03-04
**Purpose:** Production infrastructure essentials for deploying and operating Search-AI

---

## Table of Contents

1. [Introduction](#introduction)
2. [Kubernetes StatefulSets vs Deployments](#kubernetes-statefulsets-vs-deployments)
3. [Database Replication Patterns](#database-replication-patterns)
4. [Connection Pooling](#connection-pooling)
5. [Distributed Systems Fundamentals](#distributed-systems-fundamentals)
6. [Observability Stack](#observability-stack)
7. [Disaster Recovery Essentials](#disaster-recovery-essentials)
8. [Production Checklist](#production-checklist)

---

## Introduction

This guide covers **infrastructure skills** needed to deploy and operate Search-AI in production. While the main [DEVELOPER-ONBOARDING.md](./DEVELOPER-ONBOARDING.md) focuses on application development (RAG, workers, APIs), this guide covers:

- Deploying stateful services (MongoDB, OpenSearch, Neo4j) in Kubernetes
- Configuring database replication and high availability
- Managing connection pools and resource limits
- Implementing distributed locks and consistency patterns
- Monitoring systems with Prometheus and Grafana
- Executing disaster recovery procedures

**Prerequisites:**

- Basic Docker knowledge
- Familiarity with Kubernetes concepts (pods, services, deployments)
- Understanding of database fundamentals

**Related Documents:**

- [DEVELOPER-ONBOARDING.md](./DEVELOPER-ONBOARDING.md) - Core onboarding, architecture, security
- [ALGORITHMS-DEEP-DIVE.md](./ALGORITHMS-DEEP-DIVE.md) - RAG, embeddings, chunking algorithms

---

## Kubernetes StatefulSets vs Deployments

### Comparison

| Aspect           | Deployment (Stateless) | StatefulSet (Stateful)        |
| ---------------- | ---------------------- | ----------------------------- |
| **Pod Identity** | Interchangeable        | Stable (`pod-0`, `pod-1`)     |
| **DNS**          | Random                 | Predictable (`pod-0.service`) |
| **Storage**      | Ephemeral              | Persistent per pod            |
| **Scaling**      | Parallel               | Sequential (ordered)          |
| **Use Case**     | APIs, workers          | Databases                     |

**Search-AI Usage:**

- **Deployment**: Search-AI API servers (stateless)
- **StatefulSet**: MongoDB, OpenSearch, Neo4j (stateful)

### Example StatefulSet

```yaml
apiVersion: apps/v1
kind: StatefulSet
metadata:
  name: mongodb
spec:
  serviceName: mongodb-headless
  replicas: 3
  template:
    spec:
      containers:
        - name: mongo
          image: mongo:7
          command: ['mongod', '--replSet', 'rs0']
  volumeClaimTemplates:
    - metadata:
        name: data
      spec:
        accessModes: ['ReadWriteOnce']
        resources:
          requests:
            storage: 100Gi
```

### Key Points

- Each pod gets persistent storage that survives restarts
- Pods have stable network identities for cluster formation
- Scaling happens sequentially (mongo-0 → mongo-1 → mongo-2)

---

## Database Replication Patterns

### MongoDB Replica Sets

**Architecture:**

```
┌──────────┐     ┌──────────┐     ┌──────────┐
│ PRIMARY  │────▶│SECONDARY │────▶│SECONDARY │
│ (Write)  │Oplog│ (Read)   │Oplog│ (Read)   │
└──────────┘     └──────────┘     └──────────┘
```

**Why Required:**

- Transactions need replica sets
- High availability (automatic failover)
- Read scaling (route reads to secondaries)

**Read Preference:**

> **Note:** Read preference is configured at the connection level (not per-query). Search-AI currently uses default `primary` read preference for all queries. Per-query read preference optimization is planned but not yet implemented.

**Connection-Level Configuration:**

```typescript
// In mongoose.connect() options
await mongoose.connect(uri, {
  readPreference: 'primaryPreferred', // Connection-level setting
  w: 'majority',
});
```

**Write Concern:**

```typescript
// Wait for majority before acknowledging
await SearchChunk.create(chunk, {
  writeConcern: { w: 'majority', j: true },
});
```

### OpenSearch Clusters

**Architecture:**

```
3 Master nodes (cluster state)
6 Data nodes (store shards)
2 Coordinating nodes (route queries)
```

**Shard Allocation:**

```
Index: search-vectors-v1
├─ Shard 0 (Primary on node-0, Replica on node-1)
├─ Shard 1 (Primary on node-1, Replica on node-2)
└─ Shard 2 (Primary on node-2, Replica on node-0)
```

**Health States:**

- 🟢 **Green**: All shards assigned
- 🟡 **Yellow**: Primaries OK, replicas missing
- 🔴 **Red**: Some primaries missing (**data loss risk**)

---

## Connection Pooling

**Critical for Performance:** Pools prevent connection exhaustion under load.

### MongoDB Pool Sizing

**Formula Approach:**

```
Base calculation:
1. Core workers: 14 workers × 3-5 concurrent jobs = 42-70 connections
2. API server: ~10 connections (request handling)
3. Overhead buffer: 20%

Recommendations:
- Development: 50-70 (lighter load, easier debugging)
- Production: 100-150 (handles peak load, failover scenarios)
```

**Real-World Example (Search-AI):**

```
Current configuration:
- 14 core workers (always-on)
- Variable concurrency: 40%-100% of base (see SERVICES-INVENTORY.md)
- Average: ~50 concurrent database operations under normal load
- Configured: MONGODB_MAX_POOL_SIZE=50 (development)
- Production recommendation: 100+ (peak load + safety margin)
```

**Configuration:**

```bash
MONGODB_MAX_POOL_SIZE=50
MONGODB_MIN_POOL_SIZE=10
NEO4J_MAX_POOL_SIZE=100
```

### Diagnosing Pool Issues

**Common Issue:** Pool exhaustion

```
Error: MongoServerSelectionError: connection pool destroyed
```

**Diagnosis:**

```typescript
// Monitor pool health
const pool = mongoose.connection.getClient().topology.s.pool;
console.log({
  total: pool.totalConnectionCount,
  available: pool.availableConnectionCount,
  inUse: pool.currentCheckoutCount,
  waiting: pool.waitQueueSize, // ⚠️ High = problem
});
```

**Fixes:**

- Increase `maxPoolSize`
- Fix connection leaks (unclosed cursors, sessions)
- Reduce worker concurrency

---

## Distributed Systems Fundamentals

### CAP Theorem

**You can have 2 of 3:**

| Property                | Meaning                     |
| ----------------------- | --------------------------- |
| **Consistency**         | All nodes see same data     |
| **Availability**        | Every request gets response |
| **Partition Tolerance** | Works during network splits |

**Search-AI Choices:**

- **MongoDB**: CP (consistency over availability)
- **OpenSearch**: AP (availability over consistency)

### Distributed Locks (Redis)

**Use Case:** Prevent duplicate document processing across workers.

> **Note:** The distributed lock pattern shown below is from `packages/project-io/src/services/lock-service.ts`. Search-AI workers currently rely on **BullMQ's built-in job deduplication** for preventing duplicate processing. Implement this pattern if you need custom lock logic beyond BullMQ's capabilities.

```typescript
import Redis from 'ioredis';

async function acquireLock(resource: string, ttl = 5000): Promise<string | null> {
  const token = uuidv7();
  const result = await redis.set(
    `lock:${resource}`,
    token,
    'PX',
    ttl, // Expire in ms
    'NX', // Only if not exists
  );
  return result === 'OK' ? token : null;
}

async function releaseLock(resource: string, token: string) {
  // Lua script for atomic check-and-delete
  const script = `
    if redis.call("get", KEYS[1]) == ARGV[1] then
      return redis.call("del", KEYS[1])
    else
      return 0
    end
  `;
  return await redis.eval(script, 1, `lock:${resource}`, token);
}
```

**Usage in Worker:**

```typescript
const lockToken = await acquireLock(`document:${docId}`, 30000);
if (!lockToken) {
  console.log('Already processing, skipping');
  return;
}

try {
  await processDocument(docId);
} finally {
  await releaseLock(`document:${docId}`, lockToken);
}
```

### Idempotency Patterns

**Problem:** Worker crashes, job retries, creates duplicates.

**Solution 1: Unique Constraints**

```typescript
// MongoDB schema
SearchChunkSchema.index({ documentId: 1, chunkIndex: 1 }, { unique: true });

// Insert fails on retry (duplicate key)
try {
  await SearchChunk.create({ documentId, chunkIndex, content });
} catch (error) {
  if (error.code === 11000) {
    console.log('Chunk exists, skipping');
  }
}
```

**Solution 2: Upserts**

```typescript
// Always safe to retry
await SearchDocument.findOneAndUpdate(
  { _id: docId, tenantId },
  { $set: { status: 'indexed' } },
  { upsert: true },
);
```

---

## Observability Stack

### Prometheus Metrics

**Configuration:**

```yaml
annotations:
  prometheus.io/scrape: 'true'
  prometheus.io/port: '9090'
```

**Key Metrics to Track:**

| Metric                         | Type      | Purpose           |
| ------------------------------ | --------- | ----------------- |
| `bullmq_queue_depth`           | Gauge     | Job backlog       |
| `worker_processing_time`       | Histogram | Performance       |
| `mongodb_connection_pool_size` | Gauge     | Resource usage    |
| `opensearch_query_latency`     | Histogram | Query performance |

### Distributed Tracing

**Configuration:**

```bash
ENABLE_TRACING=true
OTEL_EXPORTER_OTLP_ENDPOINT=http://jaeger:4318
```

**Spans to Trace:**

- Document ingestion (end-to-end)
- Embedding generation
- Vector search queries
- Database operations

---

## Disaster Recovery Essentials

### MongoDB Backups

```bash
# Automated backup
mongodump --uri="mongodb://..." --out=/backups/$(date +%Y%m%d)

# Point-in-time recovery
mongorestore --uri="mongodb://..." /backups/20260304
```

### OpenSearch Snapshots

```json
PUT /_snapshot/s3_repository
{
  "type": "s3",
  "settings": {
    "bucket": "opensearch-backups",
    "region": "us-east-1"
  }
}

PUT /_snapshot/s3_repository/snapshot_2026_03_04
```

### Failover Procedures

**MongoDB Primary Fails:**

```
1. Secondaries detect (heartbeat timeout: 10s)
2. Election starts
3. New primary elected (majority vote)
4. Applications reconnect automatically
```

### RTO/RPO Targets

- **RTO** (Recovery Time Objective): 15 minutes
- **RPO** (Recovery Point Objective): 1 hour (snapshot frequency)

---

## Production Checklist

Before deploying Search-AI to production:

### Security (CRITICAL)

> See [DEVELOPER-ONBOARDING.md § Security: Tenant Isolation](./DEVELOPER-ONBOARDING.md#security-tenant-isolation-critical) for detailed tenant isolation requirements.

- [ ] **Tenant isolation audited** - All queries use `withTenantContext` or explicit `tenantId`
- [ ] **No `findById` usage** - All lookups include tenant scope
- [ ] **Database indexes audited** - All tenant-scoped collections have compound indexes with `tenantId` as first field (see DATABASE-SCHEMA.md)
- [ ] **OpenSearch queries include tenantId filter** - All vector/text searches scoped
- [ ] **Cache keys include tenantId** - Redis keys scoped to prevent cross-tenant access
- [ ] **Tenant isolation tests passing** - Cross-tenant query tests in test suite

### Infrastructure

- [ ] MongoDB replica set (3+ nodes)
- [ ] OpenSearch cluster (3+ data nodes, 3 master nodes)
- [ ] Connection pool sizing validated under load (100+ for production)
- [ ] Prometheus metrics exposed
- [ ] Backup automation configured (daily snapshots)
- [ ] Disaster recovery runbook tested
- [ ] Resource limits configured (CPU, memory, storage)
- [ ] Kubernetes HPA (Horizontal Pod Autoscaler) enabled
- [ ] Network policies configured

### Performance

- [ ] Load testing completed (expected peak traffic)
- [ ] Query latency meets SLA (<100ms p95)
- [ ] Worker throughput validated (documents/hour)
- [ ] Connection pool sizing verified under load

### Monitoring

- [ ] Prometheus metrics exposed and scraped
- [ ] Grafana dashboards configured
- [ ] Alerting rules configured (queue depth, error rates, latency)
- [ ] Distributed tracing enabled (Jaeger/Tempo)
- [ ] Log aggregation configured (ELK/Loki)

### Documentation

- [ ] Runbooks created for common incidents
- [ ] On-call rotation established
- [ ] Escalation procedures documented
- [ ] Architecture diagrams up to date

---

## Additional Resources

**Related Documents:**

- [DEVELOPER-ONBOARDING.md](./DEVELOPER-ONBOARDING.md) - Core onboarding, architecture, tenant isolation
- [ALGORITHMS-DEEP-DIVE.md](./ALGORITHMS-DEEP-DIVE.md) - RAG, embeddings, chunking strategies
- [SERVICES-INVENTORY.md](./design/SERVICES-INVENTORY.md) - Complete worker catalog
- [DATABASE-SCHEMA.md](./design/DATABASE-SCHEMA.md) - MongoDB models, indexes, relationships

**External Resources:**

- [Kubernetes StatefulSets Documentation](https://kubernetes.io/docs/concepts/workloads/controllers/statefulset/)
- [MongoDB Replica Sets](https://www.mongodb.com/docs/manual/replication/)
- [OpenSearch Cluster Formation](https://opensearch.org/docs/latest/tuning-your-cluster/)
- [Redis Distributed Locks](https://redis.io/docs/manual/patterns/distributed-locks/)
