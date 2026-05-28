# ABL Platform — Production Topology Sizing Design

**Date:** 2026-03-04
**Status:** Approved
**Approach:** Hybrid (Bottom-Up Micro-Benchmarks + Top-Down Scenario Tests + Sizing Calculator)

---

## Table of Contents

1. [Overview](#1-overview)
2. [Service Taxonomy](#2-service-taxonomy)
3. [Component Versions & Recommendations](#3-component-versions--recommendations)
4. [Data Store Cluster Management](#4-data-store-cluster-management)
5. [Disk Growth Model](#5-disk-growth-model)
6. [Benchmark Architecture](#6-benchmark-architecture)
7. [Customer Questionnaire](#7-customer-questionnaire)
8. [Reference Architectures (S/M/L/XL)](#8-reference-architectures-smlxl)
9. [Managed vs Self-Hosted Decision Matrix](#9-managed-vs-self-hosted-decision-matrix)
10. [Deliverables](#10-deliverables)

---

## 1. Overview

This document defines the framework for generating production K8s topology recommendations for ABL Platform deployments. It covers:

- **Per-service micro-benchmarks** (k6) to establish scaling curves
- **Integration benchmarks** across critical user journeys
- **System-wide stress tests** for production validation
- **Customer questionnaire** to capture deployment parameters
- **Sizing calculator** that maps customer inputs + benchmark data → K8s topology
- **Reference architectures** for S/M/L/XL deployment tiers

### Deployment Models

- **Single-cluster K8s**: All services in one cluster with namespace isolation (base case)
- **Multi-cluster / multi-region**: Geo-distributed clusters with cross-region replication (advanced tier)

### LLM Hosting Models

- **External APIs**: OpenAI, Anthropic, Google, Azure OpenAI
- **Self-hosted**: vLLM/TGI on GPU nodes within the cluster (air-gapped option)

### Benchmark Tooling

- **k6 1.0** with Grafana k6 Operator on K8s
- **Targets**: Local K8s (kind) for dev/CI regression + Cloud K8s (EKS/GKE/AKS) for official sizing numbers
- **Metrics pipeline**: k6 → Prometheus Remote Write → Grafana dashboards

---

## 2. Service Taxonomy

### Tier 1 — Compute-Intensive (GPU/High-CPU)

| Service                        | Resource Driver                    | Managed Alternative                                                    |
| ------------------------------ | ---------------------------------- | ---------------------------------------------------------------------- |
| **BGE-M3 Embeddings**          | CPU/GPU, 4-8Gi RAM/pod             | AWS Bedrock Embeddings, Azure OpenAI Embeddings, GCP Vertex Embeddings |
| **Docling**                    | CPU (OCR/PDF), 2-4Gi RAM           | AWS Textract, Azure Document Intelligence, GCP Document AI             |
| **Runtime (Agent Execution)**  | CPU, WebSocket connections, memory | None (core platform)                                                   |
| **Self-hosted LLM (vLLM/TGI)** | GPU (A100/H100), 16-80Gi VRAM      | OpenAI API, Anthropic API, Azure OpenAI, GCP Vertex AI                 |

### Tier 2 — Stateful Services (Durable, Clustered)

| Service        | Resource Driver                           | Managed Alternative                                     | Disk Growth Sensitivity                                      |
| -------------- | ----------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------ |
| **MongoDB**    | IOPS, storage, RAM (working set)          | Atlas, DocumentDB, CosmosDB                             | **High** — all 113 models, conversations, audit logs         |
| **ClickHouse** | Storage, CPU (analytic queries)           | ClickHouse Cloud, Timestream                            | **Very High** — traces, metrics, usage events (append-only)  |
| **OpenSearch** | RAM (JVM heap), IOPS, CPU                 | AWS OpenSearch Service, Azure AI Search, Elastic Cloud  | **Very High** — vector indices, document chunks, k-NN graphs |
| **Redis**      | RAM, network                              | AWS ElastiCache, Azure Cache for Redis, GCP Memorystore | **Low** — ephemeral cache + queues, TTL-based                |
| **Neo4j**      | RAM (heap + page cache), storage          | Neo4j AuraDB, Neptune (partial)                         | **Medium** — knowledge graphs grow with KB ingestion         |
| **Qdrant**     | RAM (vector index), storage               | Qdrant Cloud, Pinecone, Weaviate Cloud                  | **High** — vector indices scale with document count          |
| **Restate**    | CPU, storage (journal/snapshots), network | None (self-hosted required)                             | **Medium** — durable journal grows with workflow volume      |

### Tier 3 — Application Services (Horizontally Scalable)

| Service                   | Resource Driver                  | Managed Alternative       |
| ------------------------- | -------------------------------- | ------------------------- |
| **Search AI (Ingestion)** | CPU, queue depth                 | None (core platform)      |
| **Search AI Runtime**     | CPU, network                     | None (core platform)      |
| **Workflow Engine**       | CPU, Restate state               | None (core platform)      |
| **Studio (Next.js)**      | CPU, RAM (SSR)                   | Vercel (dev/staging only) |
| **Admin (Next.js)**       | CPU, RAM (SSR)                   | None (core platform)      |
| **Multimodal Service**    | CPU (Sharp/FFmpeg), S3 bandwidth | None (core platform)      |
| **Preprocessing**         | CPU (NLP), RAM                   | None (core platform)      |
| **NLU Sidecar**           | CPU, RAM                         | None (core platform)      |
| **Crawler (Go Worker)**   | Network I/O, CPU                 | None (core platform)      |
| **Crawler MCP**           | RAM (Chromium ~500Mi/tab)        | None (core platform)      |

---

## 3. Component Versions & Recommendations

| Component               | Latest Version (March 2026) | K8s Operator                         | Production Recommendation                                        |
| ----------------------- | --------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| **Kubernetes**          | 1.35.2                      | —                                    | 1.35.x; DRA stable for GPU scheduling                            |
| **MongoDB**             | 8.0.17 LTS                  | MCK 1.4.x / Percona 1.22.0           | 8.0 LTS; Percona Operator (auto PVC resize, Vault, service mesh) |
| **Redis**               | 8.6.0                       | OpsTree redis-operator               | 8.6; `noeviction` for BullMQ; hash tags for cluster mode         |
| **ClickHouse**          | 26.2.3                      | Altinity Operator 0.26.0             | 26.2; ClickHouse Keeper (46× less memory than ZK)                |
| **OpenSearch**          | 3.3                         | OpenSearch K8s Operator 3.0-alpha    | 3.3; Faiss engine for >10M vectors; NMSLIB blocked               |
| **Neo4j**               | 2026.1.4                    | Official Helm charts 2026.01.4       | Self-hosted or AuraDB Enterprise                                 |
| **Qdrant**              | 1.17.0                      | Community Helm + Enterprise Operator | 1.17; tiered multitenancy; scalar quantization                   |
| **Restate**             | 1.5                         | Restate Operator (Helm)              | 1.5; Raft consensus + S3 snapshots                               |
| **vLLM**                | 0.16.0                      | KServe InferenceService              | vLLM + KServe for self-hosted LLMs                               |
| **k6**                  | 1.0                         | k6 Operator 0.0.14                   | Native TypeScript; Prometheus remote write                       |
| **Prometheus**          | 3.10.0                      | kube-prometheus-stack                | 3.10 + Grafana Mimir for long-term retention                     |
| **Grafana**             | 12.3                        | kube-prometheus-stack                | 12.3; Drilldown GA for traces/logs/metrics                       |
| **Loki**                | 3.6.7                       | Grafana Alloy (Promtail deprecated)  | 3.6; Alloy replaces Promtail                                     |
| **Cilium**              | Latest                      | Cilium CNI                           | eBPF dataplane + Hubble + Gateway API native                     |
| **Karpenter**           | 1.9.0                       | —                                    | Node auto-provisioning for all pools                             |
| **NVIDIA GPU Operator** | 25.3.2                      | DaemonSet                            | MIG on H100; DRA for dynamic GPU partitioning                    |
| **Gateway API**         | v1.1+                       | Cilium or Envoy Gateway              | Replace ingress-nginx (archived March 2026)                      |
| **KEDA**                | 2.15+                       | —                                    | Event-driven scaling from queue depth                            |

---

## 4. Data Store Cluster Management

### 4.1 MongoDB

**Operator:** Percona Operator 1.22.0 (auto PVC resizing, Vault integration, service mesh support, Fluent Bit sidecar)

| Tier   | Topology                                                             | Sharding                                                                               | Replication                                              | Backup                                                   |
| ------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------- | -------------------------------------------------------- |
| **S**  | 3-node replica set                                                   | None                                                                                   | 1 primary + 2 secondaries, `w:majority`                  | PBM daily + oplog continuous                             |
| **M**  | 3-node replica set                                                   | Optional: shard by `tenantId` if >50 tenants                                           | 1 primary + 2 secondaries + 1 hidden (analytics)         | PBM continuous oplog + hourly snapshots to S3            |
| **L**  | 2-3 shards × 3-node RS + 3 config servers + 2 mongos                 | Shard key: `{ tenantId: 1, _id: 1 }`. Hot collections: messages, traces, conversations | 3 replicas per shard, `secondaryPreferred` for analytics | PBM physical + PITR per shard + cross-region replication |
| **XL** | 5+ shards × 3-node RS + 3 config servers + 3+ mongos (or Atlas M50+) | Zone-based sharding by region + tenant                                                 | Cross-region replica sets for DR                         | PBM physical + PITR + point-in-time recovery             |

**Partition strategy:**

- `messages`: shard by `{ tenantId: "hashed" }` — highest write volume
- `conversations`: shard by `{ tenantId: 1, createdAt: -1 }` — time-range queries
- `audit-logs`: shard by `{ tenantId: "hashed" }` — append-only, high volume
- Agent configs, projects: no sharding (low cardinality, read-heavy)

**Index management:**

- TTL indexes on messages, trace events, sessions per retention policy
- Compound: `{ tenantId: 1, projectId: 1, createdAt: -1 }` on all tenant-scoped collections
- Rolling background index builds across replica set members

**Connection pooling:**

- Single `MongoClient` per pod; `maxPoolSize` tuned per mongos count
- Total connection budget: `app_replicas × pool_size < mongos_connection_limit`
- Formula: keep inbound connections per shard node under 1,000

**Storage classes:**

- AWS: `gp3` (3,000 baseline IOPS, scalable to 16,000); `io2` for sub-ms latency primaries
- Azure: `managed-csi-premium`; Ultra Disk for latency-critical nodes
- GCP: `pd-ssd`; `pd-extreme` for max IOPS
- All: XFS filesystem, `reclaimPolicy: Retain`, `volumeBindingMode: WaitForFirstConsumer`

**Backup:** PBM 2.7.x for data (physical: 3-5× faster than mongodump; PITR via oplog slices) + Velero for K8s control plane DR.

**Monitoring:** Percona mongodb-exporter → Prometheus → Grafana (replication lag, oplog window, WiredTiger cache, connection pool).

---

### 4.2 Redis / ElastiCache

**Operator:** OpsTree redis-operator (cluster/replication/sentinel modes, built-in exporter)

| Tier   | Topology                                                                                                             | Partitioning                                                                 | Replication                                   | Persistence                         |
| ------ | -------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------------- | ----------------------------------- |
| **S**  | 3-node Sentinel (1 primary + 2 replicas)                                                                             | None                                                                         | Async replication, auto-failover via Sentinel | AOF `everysec` + RDB every 15min    |
| **M**  | 6-node Cluster (3 primary + 3 replica) or ElastiCache r6g.large × 3 shards                                           | Hash slot distribution. Key prefix: `sess:*`, `queue:*`, `lock:*`, `cache:*` | 1 replica per primary, auto-failover          | AOF `everysec`, RDB hourly          |
| **L**  | 12-node Cluster (6 primary + 6 replica) or ElastiCache r6g.xlarge × 6 shards. **Separate clusters: cache vs queues** | Hash tags for tenant co-location: `{tenant:123}:sess:*`                      | 1 replica per primary, cross-AZ               | AOF `everysec` + RDB                |
| **XL** | 24+ node Cluster or ElastiCache r6g.2xlarge × 12 shards + Global Datastore                                           | Regional hash tag routing. Separate clusters: cache / queues / pub-sub       | 2 replicas per primary, cross-region          | Multi-AZ + cross-region replication |

**Key namespace design:**

```
sess:{tenantId}:{sessionId}        → Session state (TTL: 24h)
queue:channel-inbound:{jobId}      → BullMQ inbound jobs
queue:webhook-delivery:{jobId}     → BullMQ delivery jobs
lock:{resource}:{id}               → Distributed locks (TTL: 30s, SET NX PX)
cache:agent:{tenantId}:{agentId}   → Agent config cache (TTL: 5min)
cache:llm:{hash}                   → LLM response cache (TTL: configurable)
circuit:{service}:{endpoint}       → Circuit breaker state (TTL: 60s)
rate:{tenantId}:{endpoint}         → Rate limit counters
```

**BullMQ requirements (critical):**

- `maxmemory-policy: noeviction` — absolute requirement
- Hash tags in cluster mode: `{bullmq}:*` or per-queue prefixes
- IORedis: `maxRetriesPerRequest: null` for Workers
- Alert at 80% of `maxmemory`

**Eviction policies:**

- Cache namespace: `allkeys-lfu` (hot/cold data skew)
- Queue/lock namespace: `noeviction`
- At tier L+: separate clusters for cache (evictable) vs queues (durable)

**Memory budgeting:**

```
sessions  = concurrent_conversations × ~2KB
queues    = queue_depth × ~1KB × queue_count
cache     = cached_agents × ~5KB + llm_cache × ~2KB
overhead  = ~15% fragmentation + replication buffer
```

**Active defragmentation (Redis 8.6):**

```
activedefrag yes
active-defrag-threshold-lower 10
active-defrag-cycle-max 25
```

**ElastiCache notes:** Use provisioned cluster mode with Valkey engine for cost savings. Serverless is not BullMQ-safe. Azure Cache for Redis Enterprise supports active geo-replication (CRDTs, 99.999% SLA).

---

### 4.3 ClickHouse

**Operator:** Altinity Operator 0.26.0 (zero-downtime upgrades, `abort-on-recreate-sts` safety)

| Tier   | Topology                                    | Partitioning                                                      | Replication                           | Retention                                                        |
| ------ | ------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------- |
| **S**  | Single node + 3-node ClickHouse Keeper      | `toYYYYMM(timestamp)`                                             | None (backup-based DR)                | TTL: traces 7d, metrics 30d, usage 90d                           |
| **M**  | 2-node ReplicatedMergeTree + 3-node Keeper  | `toYYYYMMDD(timestamp)` for traces, `toYYYYMM` for metrics        | 2 replicas, quorum writes             | TTL: traces 30d, metrics 90d, usage 1y. Hot SSD → Cold S3        |
| **L**  | 3 shards × 2 replicas + 3 Keeper            | Day partition. Shard by `cityHash64(tenantId)`                    | 2 replicas per shard, cross-AZ        | TTL: traces 90d, metrics 1y, usage 2y. Hot → Warm → Cold S3      |
| **XL** | 6+ shards × 2 replicas + 3 Keeper + S3 cold | Day partition + tenant shard. Separate tables for high/low volume | 2 replicas per shard, cross-region DR | Per-table TTL, S3 cold tier, materialized downsampled aggregates |

**Table design with codecs:**

```sql
CREATE TABLE trace_events (
    tenant_id String         CODEC(ZSTD(1)),
    timestamp DateTime64(3)  CODEC(Delta(4), ZSTD(1)),
    event_type LowCardinality(String),
    latency_ms Float64       CODEC(Gorilla, ZSTD(1)),
    trace_id FixedString(32) CODEC(ZSTD(1)),
    message String           CODEC(ZSTD(3))
) ENGINE = ReplicatedMergeTree('/clickhouse/{shard}/trace_events', '{replica}')
PARTITION BY toYYYYMMDD(timestamp)
ORDER BY (tenant_id, timestamp)
TTL timestamp + INTERVAL 90 DAY DELETE
```

**Tiered storage (TTL-based):**

```sql
TTL
  ts + INTERVAL 7 DAY TO VOLUME 'warm_volume',
  ts + INTERVAL 30 DAY TO VOLUME 'cold_s3_volume',
  ts + INTERVAL 90 DAY DELETE
SETTINGS storage_policy = 'hot_warm_cold';
```

**Compaction & merges:**

- `parts_to_delay_insert: 150`, `parts_to_throw_insert: 300`
- Background merge threads: 2 (S), 4 (M), 8 (L+)
- Monitor: `system.parts` for part count, `system.merges` for merge lag, `system.replicas` for replica lag

**Monitoring:** Native Prometheus endpoint at `:9363/metrics`. Key: part count, replica lag, merge queue, query duration. Use ClickHouse Prometheus/Grafana mix-in dashboards.

---

### 4.4 OpenSearch

**Version:** 3.3 (11× faster vs 1.3; 2.5× faster vector search; concurrent segment search default)

| Tier   | Topology                                                                   | Sharding                                                                   | Replication                                      | Index Lifecycle                                               |
| ------ | -------------------------------------------------------------------------- | -------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------- |
| **S**  | 2 data + 0 dedicated masters                                               | 1 primary shard/index, 1 replica                                           | 1 replica                                        | Single tier (hot). ISM delete after retention                 |
| **M**  | 3 data + 3 dedicated masters (or AWS OpenSearch r5.xlarge × 3)             | 3 primary shards/index (target 10-50GB/shard), 1 replica                   | 1 replica, cross-AZ                              | Hot (SSD) → Warm (EBS) after 7d. ISM rollover                 |
| **L**  | 6+ hot + 3 warm + 3 masters (or AWS OpenSearch r5.2xlarge × 6 + UltraWarm) | 6 shards (chunks), 3 (vectors). Routing by `tenantId`                      | 1-2 replicas, cross-AZ. Force-merge warm indices | Hot → Warm 7d → Cold S3 30d → Delete. Per-index ISM           |
| **XL** | 12+ hot + 6+ warm + 3 cold (S3) + 3 masters                                | Index-per-tenant (large), shared with routing (small). Time-based rollover | 2 replicas, cross-AZ + cross-region snapshots    | Hot → Warm → Cold → Delete. Separate lifecycle per index type |

**Index design:**

```
search-chunks-{tenantId}-{YYYY.MM}    → Document chunks + text (rollover at 50GB or 30d)
search-vectors-{tenantId}-{YYYY.MM}   → Vector embeddings (Faiss, 1024-dim, HNSW)
search-metadata-{tenantId}            → Document metadata (small, long-lived)
```

**k-NN configuration (Faiss HNSW):**

```json
{
  "settings": {
    "index.knn": true,
    "index.knn.algo_param.ef_search": 100,
    "index.knn.algo_param.ef_construction": 256,
    "index.knn.algo_param.m": 16
  }
}
```

- `ef_search`: 100 (S/M), 200 (L/XL)
- HNSW memory: ~1.1 × (4 bytes × 1024 dims × num_vectors × M) per shard
- JVM heap: 50% of node RAM, max 31Gi (compressed OOPs limit)
- Faiss: SIMD accelerated (AVX2/AVX-512/Neon). NMSLIB blocked in 3.0+.

**Segment replication:** Opt-in for 40% higher write throughput (primary indexes, replicas copy segments).

**ISM policy (hot → warm → cold → delete):**

```json
{
  "states": [
    {
      "name": "hot",
      "actions": [{ "rollover": { "min_size": "50gb", "min_index_age": "7d" } }],
      "transitions": [{ "state_name": "warm", "conditions": { "min_index_age": "7d" } }]
    },
    {
      "name": "warm",
      "actions": [
        { "replica_count": { "number_of_replicas": 1 }, "force_merge": { "max_num_segments": 1 } }
      ],
      "transitions": [{ "state_name": "cold", "conditions": { "min_index_age": "30d" } }]
    },
    {
      "name": "cold",
      "actions": [{ "snapshot": { "repository": "s3-backup" } }],
      "transitions": [{ "state_name": "delete", "conditions": { "min_index_age": "90d" } }]
    },
    { "name": "delete", "actions": [{ "delete": {} }] }
  ]
}
```

**Cross-cluster replication:** Active-passive for multi-region. FGAC required. ISM `stop_replication` for failover promotion.

---

### 4.5 Neo4j

**Version:** 2026.1.4 (calendar versioning)

| Tier   | Topology                                          | Partitioning                                         | Replication                              | Backup                           |
| ------ | ------------------------------------------------- | ---------------------------------------------------- | ---------------------------------------- | -------------------------------- |
| **S**  | Single instance                                   | Single database, all tenants                         | Offline backup (neo4j-admin dump)        | Weekly to S3                     |
| **M**  | 3-node causal cluster (Raft)                      | DB-per-tenant for top 5, shared default              | Raft consensus, read replicas            | Daily via neo4j-admin Helm chart |
| **L**  | 3 core + 2-3 read replicas (or AuraDB Enterprise) | DB-per-tenant for top 20, sharded by KB domain       | Raft consensus, routed reads to replicas | Continuous backup, query caching |
| **XL** | 5 core + 5+ read replicas, multi-DC Fabric        | Fabric composite DBs + Infinigraph property sharding | Multi-DC Raft, causal clustering         | Cross-region backup              |

**Memory configuration:**

```
heap.initial_size = heap.max_size (prevent GC pauses)
heap + pagecache + 1GB < container memory limit
Example: 16GB container → 6GB heap + 9GB pagecache + 1GB OS
```

- Page cache: total data store file size × 1.2
- JVM heap: 4-16GB, never exceed 31GB (compressed OOPs)
- Run `neo4j-admin server memory-recommendation` before production

**Infinigraph (v2025+):** Property sharding — graph structure in single shard, property data distributed across cluster. 100TB+ scale with full ACID.

**Backup:** `neo4j-admin` Helm chart → K8s CronJob → S3. Restore via `initContainer` pattern for self-healing clusters.

---

### 4.6 Qdrant

**Version:** 1.17.0

| Tier   | Topology                         | Sharding                                                                        | Replication                                        | Management                                   |
| ------ | -------------------------------- | ------------------------------------------------------------------------------- | -------------------------------------------------- | -------------------------------------------- |
| **S**  | Single node                      | 1 shard/collection                                                              | Snapshot backup to S3                              | Manual snapshots                             |
| **M**  | 3-node cluster                   | Auto-sharding (2-4 shards based on point count)                                 | Replication factor 2                               | Scheduled snapshots, collection aliases      |
| **L**  | 5-node cluster (or Qdrant Cloud) | Shard per 1M vectors. Custom shard key: `tenantId`. Tiered multitenancy (v1.16) | Replication factor 2, write consistency `majority` | Continuous snapshots, scalar quantization    |
| **XL** | 10+ node cluster, multi-region   | Shard per 500K vectors, distributed across regions                              | Replication factor 3, cross-region                 | Product quantization, mmap for cold segments |

**Collection configuration:**

```json
{
  "vectors": { "size": 1024, "distance": "Cosine" },
  "optimizers_config": {
    "indexing_threshold": 20000,
    "memmap_threshold": 50000
  },
  "quantization_config": {
    "scalar": { "type": "int8", "always_ram": true }
  }
}
```

**Quantization guide:**
| Method | Compression | Accuracy Loss | Use Case |
|--------|-------------|---------------|----------|
| Scalar (int8) | 4× | Low | Universal starting point |
| Binary (1-bit) | 32× | Moderate-High | Centered vectors (OpenAI embeddings) |
| Binary 2-bit | 16× | Low-Moderate | Balanced |
| Product (PQ) | Highest | High | Extreme storage constraints |

**Tiered multitenancy (v1.16):** Fallback shards route requests to dedicated tenant shard or shared shard. Zero-downtime promotion of growing tenants.

**Backup:** Daily PVC volume snapshots (fast, consistent) + weekly Qdrant logical snapshots to S3.

---

### 4.7 Restate (Durable Execution)

**Version:** 1.5 (live execution timeline UI, gossip-based failure detection)

| Tier   | Topology                    | Journal                                                                      | Replication                     | Recovery                          |
| ------ | --------------------------- | ---------------------------------------------------------------------------- | ------------------------------- | --------------------------------- |
| **S**  | 3-node cluster (Raft)       | 1 partition, 20Gi high-IOPS PVC                                              | 3-way Raft                      | ~5s failover                      |
| **M**  | 3-node cluster              | 4 partitions, 100Gi PVC. Snapshot every 10K entries                          | 3-way Raft, cross-AZ            | <10s failover, snapshot recovery  |
| **L**  | 5-node cluster              | 8-16 partitions, 500Gi io2 SSD. Snapshot every 5K entries, compaction hourly | 5-way Raft, 2 nodes can fail    | <10s failover, PDB minAvailable=3 |
| **XL** | 5-node primary + standby DR | 32+ partitions, 1Ti+ io2 SSD. Compaction every 15min. Archival to S3         | 5-way primary, async to standby | Primary <10s, DR <5min            |

**Architecture:**

- Control plane: Raft consensus (built-in, no external etcd)
- Log partitioning: each partition owns orchestration + state for its key range
- Metadata store: `type = "replicated"` (Raft) or `type = "object-store"` (S3)
- State materialized in embedded RocksDB (deterministically derivable from log)

**Journal sizing:**

```
journal_size = executions/day × avg_steps × ~1KB/step × retention_days + snapshot_overhead (20%)
Example (M): 50,000 × 5 × 1KB × 7d = ~1.75 GB → allocate 100Gi with growth headroom
```

**Compaction:** Trigger when journal exceeds 2× last snapshot size. `worker.trim-delay-interval = 10m` (safe log trimming).

**Snapshots:** S3, Azure Blob, or GCS. Required for production — bounds recovery time.

**Monitoring:** Prometheus metrics, OTel traces, SQL query interface, live execution timeline UI (v1.5). Alert on: retry rates, leader election frequency, log lag, snapshot age.

---

## 5. Disk Growth Model

| Data Store     | Growth Driver                                | Rate per Unit                                 | Retention Lever                                                  |
| -------------- | -------------------------------------------- | --------------------------------------------- | ---------------------------------------------------------------- |
| **MongoDB**    | Conversations, messages, audit logs          | ~1KB/msg, ~5KB/conversation, ~2KB/audit event | Message TTL, conversation archival, audit rotation               |
| **ClickHouse** | Trace events, LLM usage, billing             | ~500B/trace, ~200B/metric                     | Partition TTL (7d/30d/90d), downsampled aggregates, S3 cold tier |
| **OpenSearch** | Chunks + vector embeddings (1024-dim BGE-M3) | ~4KB/chunk text + ~4KB/vector                 | ISM lifecycle (hot→warm→cold→delete), chunk dedup                |
| **Neo4j**      | Knowledge graph nodes, relationships         | ~200B/node, ~100B/relationship                | Graph pruning, stale entity TTL                                  |
| **Qdrant**     | Vector points (mirrors OpenSearch)           | ~4KB/point (1024-dim float32)                 | Collection TTL, scalar quantization (4× reduction)               |
| **Restate**    | Journal entries, workflow state              | ~1KB/step execution                           | Snapshot + compaction frequency                                  |
| **S3**         | Files, documents, attachments                | Varies (KB to GB/file)                        | Lifecycle policies (archive→glacier→delete)                      |

**Growth formula:**

```
Monthly disk = Σ (feature_volume × per_unit_size × retention_multiplier)

Example for OpenSearch:
  10,000 docs/mo × 50 chunks/doc × 8KB × 3 months retention = ~12 GB/quarter
```

---

## 6. Benchmark Architecture

### Level 1: Per-Service Micro-Benchmarks

**Tier 1 (Compute-Intensive) — 4 benchmarks:**

| Service             | Key Scenarios                                                                        | Metrics                                               |
| ------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------- |
| **Runtime**         | Single-turn, multi-turn, tool-calling (3-5 calls), parallel conversations, streaming | RPS, p50/p95/p99 latency, TTFT, WebSocket concurrency |
| **BGE-M3**          | Single/batch embed (16/32/64/128), concurrent (1/10/50/100)                          | Docs/sec, batch throughput, latency at percentiles    |
| **Docling**         | PDF (1/10/100 page), image OCR, table extraction, mixed batch                        | Docs/hour, CPU utilization, memory peak               |
| **Self-hosted LLM** | Single/batched inference, long context (4K/16K/32K/128K), streaming                  | Tokens/sec, TTFT, concurrent request handling         |

**Tier 2 (Stateful) — 7 benchmarks:**

| Service        | Key Scenarios                                                                  | Metrics                                                    |
| -------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------- |
| **MongoDB**    | CRUD conversations, message inserts, agent reads, aggregations                 | Read/write IOPS, query latency, pool saturation            |
| **ClickHouse** | Bulk trace inserts (1K/10K/100K), time-range queries, concurrent writers       | Insert throughput, query latency, compression ratio        |
| **OpenSearch** | Document indexing (single/bulk), vector search (k=5/10/50), hybrid search      | Indexing throughput, k-NN latency, concurrent queries      |
| **Redis**      | GET/SET (1KB/10KB), BullMQ enqueue/dequeue, lock contention, pub/sub           | Command throughput, pub/sub latency, queue processing rate |
| **Neo4j**      | Cypher traversals (1/3/5 hop), batch node creation, fan-out queries            | Traversal latency, write throughput                        |
| **Qdrant**     | Point upsert (single/batch), search (k=5/10/50), filtered search               | Insert throughput, search latency, collection scaling      |
| **Restate**    | 3-step/10-step workflows, sleep/retry, cluster failover, compaction under load | Step throughput, recovery time, journal growth rate        |

**Tier 3 (Application) — 8 benchmarks:**

| Service               | Key Scenarios                                                           |
| --------------------- | ----------------------------------------------------------------------- |
| **Search AI**         | Single/bulk ingest (100/1000 docs), connector sync, enrichment pipeline |
| **Search AI Runtime** | Simple/filtered/faceted query, concurrent users (10/50/100)             |
| **Workflow Engine**   | Simple/branching/external-API workflows, concurrent execution           |
| **Studio**            | Page load, API CRUD, concurrent developers                              |
| **Admin**             | Dashboard load, config updates, audit log queries                       |
| **Multimodal**        | Image upload+resize, video transcode, ClamAV scan, concurrent uploads   |
| **Preprocessing**     | Query preprocessing, entity extraction, batch processing                |
| **Crawler (Go)**      | Static crawl (100/1K/10K pages), depth-limited, rate-limited targets    |

### Level 2: Integration Benchmarks (Critical Paths)

| Scenario                       | Services Exercised                                                        | Metrics                                        |
| ------------------------------ | ------------------------------------------------------------------------- | ---------------------------------------------- |
| **Agent Conversation E2E**     | Studio → Runtime → LLM → MongoDB → ClickHouse                             | Total latency, TTFT, concurrent conversations  |
| **KB Ingestion E2E**           | Studio → Search AI → Docling → BGE-M3 → OpenSearch/Qdrant → Neo4j         | Docs/hour, pipeline backlog, storage growth    |
| **Search Query E2E**           | Runtime → Search AI Runtime → Preprocessing → BGE-M3 → OpenSearch → Neo4j | Query latency p50/p95/p99                      |
| **Workflow Execution E2E**     | Studio → Workflow Engine → Restate → Runtime → External APIs              | Step latency, total duration, failure recovery |
| **Multi-Agent Orchestration**  | Runtime (supervisor → delegates) → LLM → Tools                            | Delegation overhead, total resolution time     |
| **Channel Message Processing** | Channel webhook → Runtime → BullMQ → Agent → Response delivery            | Queue-to-response latency                      |

### Level 3: System-Wide Stress Tests

| Test                       | Description                             | Target Metric                                  |
| -------------------------- | --------------------------------------- | ---------------------------------------------- |
| **Steady-state soak**      | Constant load, 4+ hours                 | Memory leaks, pool exhaustion, disk growth, GC |
| **Ramp-up to saturation**  | Linear ramp to breaking point           | Max throughput, first bottleneck service       |
| **Multi-tenant isolation** | Multiple tenants, different workloads   | Cross-tenant latency impact, noisy neighbor    |
| **Burst traffic**          | 10× spike for 5 min, return to baseline | Recovery time, queue drain rate, error rates   |
| **Failover/recovery**      | Kill pods mid-test                      | Recovery time, data loss, reconnection         |
| **Disk pressure**          | Sustained write workload                | Hourly growth rate, compaction effectiveness   |

### Benchmark Infrastructure

**k6 1.0** with native TypeScript, deployed via k6 Operator on K8s.

**Metrics pipeline:**

```
k6 pods (k6 Operator)
  → Prometheus Remote Write (built-in, no xk6 needed)
  → Prometheus 3.10 (or VictoriaMetrics)
  → Grafana 12.3 dashboards
```

**Configuration:**

```bash
K6_PROMETHEUS_RW_SERVER_URL=http://prometheus:9090/api/v1/write
K6_PROMETHEUS_RW_PUSH_INTERVAL=5s
K6_PROMETHEUS_RW_NATIVE_HISTOGRAMS=true
K6_PROMETHEUS_RW_TREND_STATS=p(50),p(95),p(99),max
```

**Distributed testing:** `TestRun` CRD with `parallelism: N` splits VUs across runner pods. Results aggregated in Prometheus.

---

## 7. Customer Questionnaire

### Section A: Deployment & Infrastructure

| Parameter         | Type         | Options/Range                                     | Impacts                                           |
| ----------------- | ------------ | ------------------------------------------------- | ------------------------------------------------- |
| Cloud provider    | Select       | AWS, Azure, GCP, On-prem (OpenShift/Rancher)      | Instance types, managed services, storage classes |
| Region count      | Number       | 1-5                                               | Cluster count, replication, cross-region latency  |
| HA requirement    | Select       | Standard (2 AZ), High (3 AZ), Maximum (3 AZ + DR) | Replica counts, PDB, backup strategy              |
| Network isolation | Select       | Shared VPC, Dedicated VPC, Air-gapped             | Ingress, managed service eligibility, LLM model   |
| Compliance        | Multi-select | SOC2, HIPAA, PCI-DSS, GDPR, FedRAMP, None         | Encryption, audit retention, data residency       |

### Section B: LLM & AI Configuration

| Parameter               | Type         | Options/Range                                             | Impacts                                    |
| ----------------------- | ------------ | --------------------------------------------------------- | ------------------------------------------ |
| LLM hosting model       | Select       | External API, Self-hosted (vLLM/TGI), Hybrid              | GPU nodes, network egress, latency         |
| Self-hosted model(s)    | Multi-select | Llama 3.1 (8B/70B/405B), Mistral, Mixtral, Custom         | GPU type, VRAM, model parallelism          |
| Concurrent LLM requests | Number       | 10-10,000                                                 | Runtime replicas, queue depth, rate limits |
| Average context window  | Select       | Small (<4K), Medium (4-16K), Large (16-64K), XL (64-128K) | GPU memory, batch size, throughput         |
| Embedding model         | Select       | BGE-M3 (platform), External API, Custom                   | BGE-M3 replicas, GPU/CPU allocation        |

### Section C: Agent & Conversation Volume

| Parameter                      | Type       | Options/Range  | Impacts                                              |
| ------------------------------ | ---------- | -------------- | ---------------------------------------------------- |
| Number of agents               | Number     | 1-1,000        | MongoDB storage, compiler cache                      |
| Concurrent conversations       | Number     | 10-100,000     | Runtime pods, WebSocket limits, Redis, MongoDB IOPS  |
| Average conversation length    | Number     | 5-100 messages | MongoDB growth, ClickHouse trace volume              |
| Messages per day               | Number     | 1K-10M         | Runtime throughput, MongoDB IOPS, ClickHouse inserts |
| Tool calls per conversation    | Number     | 0-50           | Runtime CPU, external API volume                     |
| Multi-agent (supervisor) usage | Percentage | 0-100%         | Runtime memory, delegation overhead                  |

### Section D: Knowledge Base & Search

| Parameter                   | Type         | Options/Range                                              | Impacts                                       |
| --------------------------- | ------------ | ---------------------------------------------------------- | --------------------------------------------- |
| Total documents             | Number       | 100-10M                                                    | OpenSearch/Qdrant storage, embedding compute  |
| Average document size       | Select       | Small (<10p), Medium (10-50p), Large (50-200p), XL (200+p) | Docling time, chunk count, storage            |
| Document types              | Multi-select | PDF, Word, HTML, Spreadsheet, Image, Video                 | Docling resources, Multimodal usage           |
| Ingestion frequency         | Select       | One-time, Daily, Hourly, Real-time                         | Search AI queue, BGE-M3 load, indexing rate   |
| Connector types             | Multi-select | Web crawl, SharePoint, Git, API, File upload               | Crawler workers, connector resources          |
| Knowledge bases per project | Number       | 1-50                                                       | Neo4j complexity, cross-KB search             |
| Vector search queries/day   | Number       | 1K-1M                                                      | OpenSearch/Qdrant replicas, BGE-M3 query load |

### Section E: Workflows & Automation

| Parameter                       | Type         | Options/Range                            | Impacts                                      |
| ------------------------------- | ------------ | ---------------------------------------- | -------------------------------------------- |
| Active workflows                | Number       | 0-10,000                                 | Restate journal, Workflow Engine memory      |
| Workflow executions/day         | Number       | 0-1M                                     | Restate throughput, Workflow Engine replicas |
| Average steps per workflow      | Number       | 2-50                                     | Restate journal growth                       |
| Workflow triggers               | Multi-select | Scheduled, Webhook, Event-driven, Manual | Restate scheduler, inbound capacity          |
| External API calls per workflow | Number       | 0-20                                     | Network egress, timeout/retry budget         |

### Section F: Channels & Integrations

| Parameter             | Type         | Options/Range                                                 | Impacts                                |
| --------------------- | ------------ | ------------------------------------------------------------- | -------------------------------------- |
| Active channels       | Multi-select | Web widget, Slack, Teams, WhatsApp, Voice, SMS, Email, Custom | Channel pods, WebSocket, voice compute |
| Voice/video usage     | Percentage   | 0-100%                                                        | LiveKit sizing, STT/TTS API costs      |
| Inbound webhooks/day  | Number       | 0-1M                                                          | BullMQ queue, channel workers          |
| Outbound webhooks/day | Number       | 0-1M                                                          | Delivery queue, retry storage          |

### Section G: Admin & Observability

| Parameter             | Type   | Options/Range                                              | Impacts                                |
| --------------------- | ------ | ---------------------------------------------------------- | -------------------------------------- |
| Admin/developer users | Number | 1-500                                                      | Studio/Admin SSR, API rate limits      |
| Trace retention       | Select | 7d, 30d, 90d, 1y                                           | ClickHouse storage, partition strategy |
| Metrics retention     | Select | 30d, 90d, 1y, 2y                                           | ClickHouse storage, downsampling       |
| Audit log retention   | Select | 1y, 3y, 7y (compliance)                                    | MongoDB storage, archival              |
| Monitoring stack      | Select | Platform built-in, Prometheus+Grafana, Datadog, CloudWatch | Sidecar overhead, metric export        |

### Section H: Retention & Storage Policy

| Parameter              | Type   | Options/Range                                         | Impacts                               |
| ---------------------- | ------ | ----------------------------------------------------- | ------------------------------------- |
| Conversation retention | Select | 30d, 90d, 1y, Indefinite                              | MongoDB growth, archival pipeline     |
| Document retention     | Select | Until deleted, 1y, 3y                                 | OpenSearch/Qdrant, S3 lifecycle       |
| Attachment retention   | Select | 30d, 90d, 1y                                          | S3 storage, Multimodal cleanup        |
| Encryption at rest     | Select | Platform AES-256, Customer KMS (BYOK), None           | KMS integration, ~10-15% CPU overhead |
| Backup frequency       | Select | Continuous, Hourly, Daily                             | Backup storage, IOPS overhead         |
| DR RTO/RPO             | Select | RPO<1min/RTO<15min, RPO<1hr/RTO<1hr, RPO<24hr/RTO<4hr | Replication topology, standby sizing  |

---

## 8. Reference Architectures (S/M/L/XL)

### Sizing Calculator Formula

```
replicas = ceil(peak_load / throughput_per_replica) × ha_multiplier
cpu_per_replica = baseline_cpu + (load_factor × scaling_coefficient)
memory_per_replica = baseline_mem + (working_set × data_factor)
```

Where `throughput_per_replica` and `scaling_coefficient` come from benchmark results.

### Tier S — Starter

**Profile:** 1-10 agents, <1K conversations/day, <10K docs

| Component                  | Spec                                | Replicas     | Node Pool                           |
| -------------------------- | ----------------------------------- | ------------ | ----------------------------------- |
| Runtime                    | 1 vCPU, 2Gi                         | 2            | General (m5.large / e2-standard-4)  |
| Studio                     | 0.5 vCPU, 1Gi                       | 2            | General                             |
| Admin                      | 0.5 vCPU, 1Gi                       | 1            | General                             |
| Search AI                  | 1 vCPU, 2Gi                         | 1            | General                             |
| Search AI Runtime          | 0.5 vCPU, 1Gi                       | 2            | General                             |
| Workflow Engine            | 0.5 vCPU, 1Gi                       | 2            | General                             |
| BGE-M3                     | 2 vCPU, 4Gi                         | 2            | Compute (c5.xlarge / c2-standard-8) |
| Docling                    | 1 vCPU, 2Gi                         | 1            | General                             |
| Preprocessing              | 0.5 vCPU, 512Mi                     | 1            | General                             |
| NLU Sidecar                | 0.5 vCPU, 512Mi                     | 1            | General                             |
| Crawler Go                 | 0.5 vCPU, 512Mi                     | 1            | General                             |
| Multimodal                 | 1 vCPU, 1Gi                         | 1            | General                             |
| MongoDB                    | 2 vCPU, 8Gi, 100Gi gp3              | 3 (RS)       | Data (r5.xlarge / n2-highmem-4)     |
| ClickHouse                 | 2 vCPU, 4Gi, 50Gi gp3               | 1 + 3 Keeper | Data                                |
| OpenSearch                 | 2 vCPU, 4Gi, 50Gi gp3               | 2            | Data                                |
| Redis                      | 1 vCPU, 4Gi                         | 3 (Sentinel) | Data                                |
| Neo4j                      | 1 vCPU, 2Gi, 20Gi gp3               | 1            | Data                                |
| Qdrant                     | 1 vCPU, 2Gi, 20Gi gp3               | 1            | Data                                |
| Restate                    | 1 vCPU, 2Gi, 20Gi gp3               | 3 (Raft)     | Data                                |
| **Total nodes**            | ~3-4 general + 1 compute + 2-3 data |              |                                     |
| **Monthly storage growth** | ~5-15 GB                            |              |                                     |

### Tier M — Mid-Market

**Profile:** 10-100 agents, 1K-50K conversations/day, 10K-500K docs

| Component                  | Spec                                            | Replicas                | Node Pool                             |
| -------------------------- | ----------------------------------------------- | ----------------------- | ------------------------------------- |
| Runtime                    | 2 vCPU, 4Gi                                     | 3-6 (HPA)               | General (m5.xlarge / e2-standard-8)   |
| Studio                     | 1 vCPU, 2Gi                                     | 2-4 (HPA)               | General                               |
| Admin                      | 0.5 vCPU, 1Gi                                   | 2                       | General                               |
| Search AI                  | 2 vCPU, 4Gi                                     | 2-4 (HPA)               | General                               |
| Search AI Runtime          | 1 vCPU, 2Gi                                     | 2-4 (HPA)               | General                               |
| Workflow Engine            | 1 vCPU, 2Gi                                     | 2-4 (HPA)               | General                               |
| BGE-M3                     | 4 vCPU, 8Gi                                     | 3-8 (HPA)               | Compute (c5.2xlarge / c2-standard-16) |
| Docling                    | 2 vCPU, 4Gi                                     | 2-4 (HPA)               | Compute                               |
| Preprocessing              | 1 vCPU, 1Gi                                     | 2                       | General                               |
| NLU Sidecar                | 0.5 vCPU, 1Gi                                   | 2                       | General                               |
| Crawler Go                 | 1 vCPU, 1Gi                                     | 2-4                     | General                               |
| Crawler MCP                | 2 vCPU, 2Gi                                     | 1-2                     | General                               |
| Multimodal                 | 2 vCPU, 2Gi                                     | 2                       | General                               |
| MongoDB                    | 4 vCPU, 16Gi, 500Gi gp3                         | 3 (RS)                  | Data (r5.2xlarge / n2-highmem-8)      |
| ClickHouse                 | 4 vCPU, 8Gi, 200Gi gp3                          | 2 replicated + 3 Keeper | Data                                  |
| OpenSearch                 | 4 vCPU, 16Gi, 500Gi gp3                         | 3 (cluster)             | Data                                  |
| Redis                      | 2 vCPU, 8Gi                                     | 6-node Cluster (3P+3R)  | Data                                  |
| Neo4j                      | 2 vCPU, 8Gi, 100Gi gp3                          | 3 (causal cluster)      | Data                                  |
| Qdrant                     | 2 vCPU, 8Gi, 200Gi gp3                          | 3 (distributed)         | Data                                  |
| Restate                    | 2 vCPU, 4Gi, 100Gi io1                          | 3 (Raft)                | Data                                  |
| Self-hosted LLM (opt)      | 8 vCPU, 24Gi + 1× A10G                          | 2-4                     | GPU (g5.2xlarge / a2-highgpu-1g)      |
| **Total nodes**            | ~6-8 general + 2-3 compute + 4-6 data + 0-4 GPU |                         |                                       |
| **Monthly storage growth** | ~50-200 GB                                      |                         |                                       |

### Tier L — Enterprise

**Profile:** 100-1000 agents, 50K-500K conversations/day, 500K-5M docs

| Component                  | Spec                                               | Replicas                                       | Node Pool                             |
| -------------------------- | -------------------------------------------------- | ---------------------------------------------- | ------------------------------------- |
| Runtime                    | 4 vCPU, 8Gi                                        | 6-20 (HPA)                                     | General (m5.2xlarge / e2-standard-16) |
| Studio                     | 2 vCPU, 4Gi                                        | 4-8 (HPA)                                      | General                               |
| Admin                      | 1 vCPU, 2Gi                                        | 2-3                                            | General                               |
| Search AI                  | 4 vCPU, 8Gi                                        | 4-10 (HPA)                                     | General                               |
| Search AI Runtime          | 2 vCPU, 4Gi                                        | 4-10 (HPA)                                     | General                               |
| Workflow Engine            | 2 vCPU, 4Gi                                        | 4-8 (HPA)                                      | General                               |
| BGE-M3                     | 4 vCPU, 8Gi                                        | 6-20 (HPA/KEDA)                                | Compute (c5.4xlarge / c2-standard-30) |
| Docling                    | 4 vCPU, 8Gi                                        | 4-10 (HPA)                                     | Compute                               |
| Preprocessing              | 2 vCPU, 2Gi                                        | 2-4                                            | General                               |
| NLU Sidecar                | 1 vCPU, 1Gi                                        | 2-3                                            | General                               |
| Crawler Go                 | 2 vCPU, 2Gi                                        | 4-10                                           | General                               |
| Crawler MCP                | 4 vCPU, 4Gi                                        | 2-4                                            | General                               |
| Multimodal                 | 2 vCPU, 4Gi                                        | 2-4                                            | General                               |
| MongoDB                    | 8 vCPU, 32Gi, 2Ti gp3                              | 2-3 shards × 3 RS                              | Data (r5.4xlarge / n2-highmem-16)     |
| ClickHouse                 | 8 vCPU, 16Gi, 1Ti gp3                              | 3 shards × 2 replicas + 3 Keeper               | Data                                  |
| OpenSearch                 | 8 vCPU, 32Gi, 2Ti gp3                              | 5+ (hot) + 3 (warm) + 3 masters                | Data                                  |
| Redis                      | 4 vCPU, 16Gi                                       | 12-node (6P+6R). Separate cache/queue clusters | Data                                  |
| Neo4j                      | 4 vCPU, 16Gi, 500Gi gp3                            | 3 core + 2-3 read replicas                     | Data                                  |
| Qdrant                     | 4 vCPU, 16Gi, 1Ti gp3                              | 3-5 (distributed)                              | Data                                  |
| Restate                    | 4 vCPU, 8Gi, 500Gi io2                             | 5 (Raft)                                       | Data                                  |
| Self-hosted LLM (opt)      | 12 vCPU, 48Gi + 1-4× A100 80GB                     | 4-8                                            | GPU (p4d.24xlarge / a2-megagpu-16g)   |
| **Total nodes**            | ~10-15 general + 3-5 compute + 8-12 data + 0-8 GPU |                                                |                                       |
| **Monthly storage growth** | ~500 GB - 2 TB                                     |                                                |                                       |

### Tier XL — Hyperscale

**Profile:** 1000+ agents, 500K+ conversations/day, 5M+ docs, multi-region

| Aspect                 | Spec                                                                                                                  |
| ---------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Cluster topology       | Primary + DR region, active-passive or active-active                                                                  |
| Application services   | 2-5× Tier L replicas, dedicated node pools per service                                                                |
| Data stores            | All managed services recommended (Atlas, OpenSearch Service, ElastiCache)                                             |
| MongoDB                | 5+ shards, zone-based, Atlas M50+ or cross-region RS                                                                  |
| ClickHouse             | 6+ shards, S3 cold storage, materialized downsampled views                                                            |
| OpenSearch             | 12+ hot + 6 warm + 3 cold, cross-region snapshots                                                                     |
| Redis                  | 24+ nodes or ElastiCache Global Datastore, separate clusters                                                          |
| Neo4j                  | 5 core + 5+ read replicas, Fabric composite DBs                                                                       |
| Qdrant                 | 10+ nodes, cross-region, product quantization                                                                         |
| Restate                | 5-node primary + standby DR, 32+ partitions                                                                           |
| Self-hosted LLM        | Multi-node model parallelism, H100/H200 clusters                                                                      |
| Total nodes            | 30-60+ per region                                                                                                     |
| Monthly storage growth | 2-10+ TB                                                                                                              |
| Special considerations | Sharded MongoDB, cross-region replication, CDN for Studio, dedicated ingress, Cilium network policies, PSA restricted |

---

## 9. Managed vs Self-Hosted Decision Matrix

| Data Store     | Self-Host When                                   | Use Managed When                                                                          |
| -------------- | ------------------------------------------------ | ----------------------------------------------------------------------------------------- |
| **MongoDB**    | Air-gapped, cost-sensitive at small scale        | Atlas/DocumentDB for HA, backups, scaling (caveat: DocumentDB/CosmosDB have feature gaps) |
| **OpenSearch** | Custom plugins, air-gapped                       | AWS OpenSearch for auto-scaling, GPU acceleration, serverless vector engine               |
| **Redis**      | Simple cache, low volume                         | ElastiCache (provisioned, Valkey engine) for cluster mode, failover, encryption           |
| **Neo4j**      | <100K nodes, simple graphs                       | AuraDB for scaling, managed backups, enterprise features                                  |
| **ClickHouse** | Full control, >50TB, strong DevOps team          | ClickHouse Cloud for auto-scaling, lower ops burden                                       |
| **Qdrant**     | Air-gapped, high query volume (fixed infra cost) | Qdrant Cloud for zero ops, Hybrid Cloud for middle ground                                 |
| **Restate**    | Always self-hosted                               | No managed offering                                                                       |

**Cloud provider managed service notes:**

- **AWS DocumentDB 8.0**: Wire-compatible but no Queryable Encryption, time-series, GridFS, or complex aggregations
- **Azure CosmosDB vCore**: ~32% API surface compatibility; significant gaps in aggregation and indexing
- **AWS ElastiCache Serverless**: Not BullMQ-safe (Lua script limitations); use provisioned cluster mode
- **GCP Memorystore Cluster**: No cross-slot Lua scripts; same BullMQ hash-tag requirements apply

---

## 10. Deliverables

| Deliverable                         | Description                                                                                                                            |
| ----------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **k6 benchmark suite**              | ~19 per-service scripts + 6 integration scripts + 6 system-wide scripts. Organized in `benchmarks/` directory                          |
| **Benchmark dashboard**             | Grafana dashboards with k6 Prometheus remote write. Per-service and E2E panels                                                         |
| **Customer questionnaire**          | Structured form (web or CLI) covering all 8 sections above                                                                             |
| **Sizing calculator**               | Takes questionnaire inputs + benchmark data → outputs K8s manifests (resource requests/limits, replica counts, PVC sizes, HPA configs) |
| **Helm values generator**           | Per-tier Helm values files for each data store operator                                                                                |
| **Reference architecture diagrams** | Mermaid/draw.io diagrams for S/M/L/XL tiers                                                                                            |
| **Capacity planning spreadsheet**   | Disk growth projections by tier and retention policy                                                                                   |
| **Runbook**                         | Operational procedures: scaling triggers, backup verification, failover testing                                                        |

---

## Appendix: Autoscaling Strategy

| Layer                 | Tool                 | Purpose                                                      |
| --------------------- | -------------------- | ------------------------------------------------------------ |
| **Pod horizontal**    | HPA                  | Scale replicas on CPU/custom metrics                         |
| **Pod vertical**      | VPA                  | Right-size CPU/memory requests (memory only when HPA on CPU) |
| **Event-driven**      | KEDA 2.15+           | Scale from BullMQ queue depth, Kafka lag, custom metrics     |
| **Node provisioning** | Karpenter 1.9.0      | Right-size nodes, GPU pools, spot/on-demand mix              |
| **GPU sharing**       | MIG + DRA (K8s 1.35) | Partition H100 for multi-model serving                       |

**Networking:** Cilium CNI (eBPF, L7 policies, Hubble observability, Gateway API native). Gateway API replaces ingress-nginx (archived March 2026).

**Security:** PSA `restricted` on production namespaces. Distroless images for all services.

**Monitoring:** Prometheus 3.10 + Grafana 12.3 + Loki 3.6 + Grafana Alloy + Mimir (long-term metrics) + OTel Operator (traces).
