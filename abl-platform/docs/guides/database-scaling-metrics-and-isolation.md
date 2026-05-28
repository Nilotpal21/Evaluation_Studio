# Database Scaling Metrics & Isolation Strategy

**Date:** 2026-04-09
**Based on:** Load test run 7220366 (300 VU, 8 runtime pods, zero errors)
**Status:** Recommendation — pending implementation

---

## Table of Contents

1. [Context](#1-context)
2. [Redis Scaling Metrics](#2-redis-scaling-metrics)
3. [MongoDB Scaling Metrics](#3-mongodb-scaling-metrics)
4. [ClickHouse Scaling Metrics](#4-clickhouse-scaling-metrics)
5. [Redis Instance Separation](#5-redis-instance-separation)
6. [Ingestion Isolation Strategy](#6-ingestion-isolation-strategy)
7. [Action Items](#7-action-items)

---

## 1. Context

### Current State (Run 7220366)

| Service    | Pods | CPU (avg) | Memory (avg) | Key Finding                              |
| ---------- | ---- | --------- | ------------ | ---------------------------------------- |
| Runtime    | 8    | 0.500/pod | 1,169 MB/pod | 99.0% scaling efficiency, 147.3 msg/s    |
| MongoDB    | 3    | 0.774 pri | 1,937 MB pri | Secondaries at 70-71% disk I/O, 99% peak |
| Redis      | 1    | 0.157     | 166 MB       | 28 req/s persistent 5-10s tail latency   |
| ClickHouse | 1    | 0.162     | 953 MB       | Batch-oriented, not a bottleneck         |

### Scaling Questions This Document Addresses

1. **What metrics reveal each database's scaling limits before they're hit?**
2. **Should Redis be split into multiple instances?** Yes — by workload type and by application.
3. **How do we prevent background ingestion from impacting real-time chat?** Three-layer isolation.

---

## 2. Redis Scaling Metrics

Redis is a single instance handling 2,403 req/s at 300 VU. It looks idle (0.157 cores, 166 MB), but has a persistent **28 req/s in the 5-10s latency bucket** that doesn't scale with pods. This is head-of-line blocking: Redis is single-threaded, so large session `HMSET` operations (30 fields, some gzip-compressed + encrypted) and `LUA_SAVE` scripts block all other commands.

Redis serves two fundamentally different roles in the platform:

- **Primary store**: Session state (hashes, conversation lists, agent registry) — the sole source of truth for live sessions. Loss means all active sessions are lost.
- **Cache**: Tenant config (5min TTL), IR/compilation output (2h TTL, 50KB-5MB gzipped) — regenerable from MongoDB.

### Metrics to Capture

| Metric                                                        | Why                                                                                                                                                                            | Source              | Alert Threshold                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------- | --------------------------------------------- |
| `used_memory` / `used_memory_rss` / `mem_fragmentation_ratio` | Session hashes, conversation lists, and IR/compilation caches compete for memory. Fragmentation > 1.5 means allocator waste.                                                   | `INFO memory`       | Fragmentation > 1.5                           |
| `connected_clients`                                           | Runtime: ~9/pod, Search-AI: ~35+/pod (mostly BullMQ), Search-AI-Runtime: ~7/pod. At 8+ pods each, 100+ connections on one Redis.                                               | `INFO clients`      | > 80% of `maxclients`                         |
| `instantaneous_ops_per_sec` by command type                   | Separate fast ops (GET/SET ~0.1ms) from slow ops (LRANGE on large conv lists, HMSET of 30-field session hashes, EVAL Lua scripts).                                             | `COMMANDSTATS`      | Slow command % > 5%                           |
| `SLOWLOG` entries                                             | Identifies the actual commands causing 5-10s latencies. Likely candidates: session HMSET with encrypted/compressed fields, LRANGE on long conversation histories, Lua scripts. | `SLOWLOG GET 128`   | Any entry > 1s                                |
| `keyspace_hits` / `keyspace_misses`                           | IR cache and compilation cache hit ratio. Low hit ratio = more MongoDB round-trips on the hot path.                                                                            | `INFO stats`        | Hit ratio < 80%                               |
| Pub/sub messages/s per channel                                | 6+ subscriber channels (WebSocket delivery, DEK invalidation, Model Hub invalidation, vocabulary/alias/canonical invalidation). Each PUBLISH is O(N) subscribers.              | `PUBSUB NUMSUB`     | —                                             |
| BullMQ queue depth + wait time                                | 25+ queues in search-ai, 3 in runtime. Queue backup = Redis memory growth + processing lag.                                                                                    | `getWaitingCount()` | Wait time > 1s on `llm-requests`              |
| Big key scan                                                  | Session conversation lists grow with every message. IR/compilation caches are 50KB-5MB. A single key > 1MB blocks the entire Redis.                                            | `MEMORY USAGE key`  | Any key > 5 MB                                |
| `total_net_input_bytes` / `total_net_output_bytes`            | Load test showed 1.71-1.72 MB/s bidirectional. Relevant when large gzipped IR buffers transfer.                                                                                | `INFO stats`        | > 100 MB/s                                    |
| `evicted_keys`                                                | If maxmemory with eviction policy is set, session state could be evicted (catastrophic).                                                                                       | `INFO stats`        | Any eviction > 0 (if sessions share instance) |

---

## 3. MongoDB Scaling Metrics

### The Memory Cliff Problem

MongoDB has two completely different performance regimes:

1. **Working set fits in WiredTiger cache + OS page cache**: reads are sub-millisecond, CPU-bound, scales linearly. This is where we are at 300 VU.
2. **Working set exceeds available memory**: reads trigger page faults, latency jumps 100-1000x, throughput collapses non-linearly. This is a **cliff**, not a gradient.

The transition is invisible until it hits — all latency metrics look fine, then suddenly they don't. The metrics below are organized by the question: **"are we near the cliff?"**

### Current Topology

- 3-node replica set: 1 primary (0.774 cores, 1,937 MB RSS, 4.2-5.0 GB with page cache), 2 secondaries.
- Primary serves all runtime reads and writes (`readPreference: 'primary'`).
- Secondaries at **70-71% avg / 99% peak disk I/O** from oplog replay — already near saturation.
- Runtime connection pool: `maxPoolSize: 5` per pod (40 total for 8 pods).
- Search-AI platform DB pool: `maxPoolSize: 100` (separate connection).

### Hot-Path Collections (Every Chat Message)

| Collection         | Operations per message                | Pattern                                              |
| ------------------ | ------------------------------------- | ---------------------------------------------------- |
| `channel_sessions` | 1 findOne                             | Resolve external session key to internal ID          |
| `sessions`         | 1 findOne + 1 updateOne ($set + $inc) | Load session, update counters                        |
| `messages`         | 1 insertOne or insertMany             | Persist chat message (append-only)                   |
| `session_states`   | 0-1 findOne                           | Load compressed state on session resume (Redis miss) |
| `tenant_models`    | 1 findOne                             | LLM model resolution per inference call              |
| `deployments`      | 0-1 findOne                           | On session creation (cached after)                   |
| `tenants`          | 0-1 findOne                           | Feature gating, rate limiting                        |

### Tier 1: Working Set vs Cache (Cliff Indicators)

These are the most important metrics. They tell you how close you are to the memory cliff.

| Metric                                                                       | Why                                                                                                                                                             | Healthy              | Danger                 |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------- | ---------------------- |
| `wiredTiger.cache.bytes currently in the cache` / `maximum bytes configured` | Cache utilization %. WiredTiger starts aggressive eviction at ~80%.                                                                                             | < 80%                | > 80%                  |
| **`wiredTiger.cache.pages evicted by application threads`**                  | **The smoking gun.** When background eviction can't keep up, application threads evict before they can read. Request latency is now dominated by eviction work. | 0                    | > 0 and rising         |
| `wiredTiger.cache.tracked dirty bytes in the cache`                          | Dirty ratio. High dirty bytes mean writes fill cache faster than checkpointing flushes. The `$inc` on every message (session counters) contributes.             | < 20% of cache       | > 50% of cache         |
| `wiredTiger.cache.internal pages evicted`                                    | Internal pages = B-tree index nodes. If evicted, index traversal requires disk seeks — every query slows down, not just data reads.                             | 0                    | > 0                    |
| `extra_info.page_faults`                                                     | OS-level page faults. Rising = both WiredTiger cache and OS page cache missed. Real disk reads happening.                                                       | Flat / low           | Rising under load      |
| Total index size vs available RAM                                            | 15+ compound indexes on hot-path collections. If index sizes exceed WiredTiger cache, performance degrades catastrophically.                                    | Indexes fit in cache | Indexes > 50% of cache |

### Tier 2: Disk I/O (Already Red-Flagged)

| Metric                         | Why                                                                                                                                                     | Healthy                | Danger                |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- | --------------------- |
| Secondary disk I/O utilization | Already at 70-71% avg / 99% peak. Secondaries replay oplog as individual ops (no batching), generating far more IOPS than the primary's journal writes. | < 50%                  | > 70% (current state) |
| Oplog window (hours)           | How far back the oplog reaches. Below 1 hour = risk of needing full resync on recovery.                                                                 | > 24h                  | < 2h                  |
| Replication lag (seconds)      | Lag between primary and secondaries. Fine now (40us RTT), but will spike when secondary disks saturate.                                                 | < 1s                   | > 10s                 |
| Read/write IOPS per node       | Primary: 45 IOPS (journal batching). Secondaries: 345-374 IOPS (oplog replay). 8x amplification on secondaries is the scaling constraint.               | Below provisioned IOPS | > 80% of provisioned  |
| Disk write latency             | Primary: 40ms avg / 130ms peak.                                                                                                                         | < 5ms for data reads   | > 50ms sustained      |

### Tier 3: Connection and Concurrency

| Metric                                         | Why                                                                                                                          | Healthy    | Danger         |
| ---------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | ---------- | -------------- |
| Connection pool utilization                    | Runtime: `maxPoolSize: 5` per pod, 40 total. At ~6 ops per warm message × 147 msg/s = 882 ops/s / 40 conns = ~22 ops/s/conn. | < 70%      | > 90%          |
| Pool checkout wait time                        | `waitQueueTimeoutMs: 10000` — 10s before failure.                                                                            | < 10ms     | > 100ms        |
| WiredTiger read/write tickets                  | Concurrent transaction slots (default 128 each).                                                                             | < 80% used | > 90% used     |
| `globalLock.currentQueue.readers` / `.writers` | Queued operations waiting for locks.                                                                                         | 0          | > 10 sustained |

### Tier 4: Document Growth Risks

| Collection                                            | Growth Pattern                                                                                                                    | Risk                                      |
| ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| `session_states`                                      | Buffer fields: compressed state, per-thread conversation history, IR data. 5-50 KB typical, 100KB+ for long multi-agent sessions. | Heavy working set pressure                |
| `messages`                                            | Append-only, fastest-growing collection. TTL on `expiresAt` but high volume between creation and expiry.                          | Index size growth                         |
| `crawl_history.statuses[]`, `documentStatusChanges[]` | Unbounded embedded arrays, no cap.                                                                                                | Document size growth, write amplification |
| `workflow_executions.steps[]`                         | Grows per workflow step, includes nested `branches[].steps[]`. No cap.                                                            | Document size growth                      |
| `channel_sessions.emailMessageIds[]`                  | Grows via `$addToSet` per email. No cap.                                                                                          | Document size growth                      |
| `contacts.identities[]`, `channelHistory[]`           | Grows as user seen on new channels. No cap. `contactContext` has 64KB guard.                                                      | Moderate growth                           |

### Why the Cliff Matters for Capacity Planning

At 300 VU, the working set (hot sessions, messages, tenant configs, deployments, tenant models) fits comfortably in the ~2GB WiredTiger cache. At 500 VU with 21 pods, more concurrent sessions, more messages, more session_states in active memory. The cliff might be at 400 VU or 800 VU — current data can't tell. Tier 1 metrics are what reveal the cliff approaching before it hits.

---

## 4. ClickHouse Scaling Metrics

ClickHouse handles ~3.2 req/s total (0.162 cores, 953 MB). Batch writes via `BufferedClickHouseWriter` (10K rows or 5s flush). Not a bottleneck today, but has 40+ tables with materialized views that matter at scale.

### Write Path

- Per chat message: ~3-7 rows across `platform_events` (2-5), `messages` (1), `llm_metrics` (1).
- At 147 msg/s: ~440-1030 rows/s, batched into ~1 insert every 5s.
- 7 materialized views fire on each insert to `platform_events` and `llm_metrics`.
- Client uses `async_insert: 1` with `wait_for_async_insert: 1` as server-side safety net.

### Metrics to Capture

| Metric                                                     | Why                                                                                                                                                      | Source                            | Alert Threshold               |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- | ----------------------------- |
| `InsertedRows` / `InsertedBytes` per second                | Baseline write throughput.                                                                                                                               | `system.events`                   | —                             |
| `MergeRows` / `ActiveMerges`                               | MergeTree merges parts in background. If merges can't keep up, part count grows, reads slow, eventually inserts are refused.                             | `system.metrics`, `system.merges` | `ActiveMerges` sustained > 10 |
| **`PartsActive` per table** (especially `platform_events`) | Parts > 300 in a single partition = danger. `platform_events` partitions by day.                                                                         | `system.parts`                    | > 300 per partition           |
| `ReplicasMaxQueueSize`                                     | Replication queue depth. Production uses `ReplicatedMergeTree` with Keeper.                                                                              | `system.replicas`                 | > 100                         |
| Query duration by type                                     | Separate INSERT (< 100ms for batches) from SELECT. Materialized views fire on every insert — slow views block the insert path.                           | `system.query_log`                | Insert p99 > 500ms            |
| Memory per query                                           | NL-to-SQL queries and query-log-analysis (10K rows, 30s timeout) are heavy readers.                                                                      | `system.query_log.memory_usage`   | Peak > 2 GB per query         |
| Disk space by table + compression ratio                    | 730-day retention on major tables. Tiered storage (warm to cold).                                                                                        | `system.parts` aggregated         | Cold tier > 80% capacity      |
| Buffer fill level (application-side)                       | `BufferedClickHouseWriter` has `maxBufferSize: 100,000`. At 90% it warns, at 100% drops oldest batch. Fills up in Node.js heap if ClickHouse slows down. | Custom metric                     | > 50% fill                    |

### Scaling Profile

ClickHouse scaling is mostly linear — column-oriented storage + compression means reads scale with columns touched, not row count. The risks are merge pressure (too many small inserts creating too many parts) and materialized view overhead on the insert path.

---

## 5. Redis Instance Separation

### Why Separate

The current single Redis instance has fundamentally incompatible workloads:

| Concern             | Sessions                                  | Cache                           | BullMQ Queues                         |
| ------------------- | ----------------------------------------- | ------------------------------- | ------------------------------------- |
| Data loss tolerance | **None** — sole source of truth           | Total — regenerate from MongoDB | Low — jobs re-enqueueable             |
| Eviction policy     | `noeviction`                              | `allkeys-lru`                   | `noeviction`                          |
| Persistence         | AOF for durability                        | None needed                     | RDB at minimum                        |
| Command profile     | Large values, Lua scripts, 30-field HMSET | Small fast GET/SET (< 5 KB)     | Blocking BRPOPLPUSH, XREADGROUP       |
| Connection count    | ~2-3 per runtime pod                      | ~2-3 per pod                    | 2 per queue x 25+ queues in search-ai |

Running all on one instance means: can't set the right eviction policy, can't tune persistence per workload, and slow operations in one domain block fast operations in another.

### Additionally: Separate Runtime and Search-AI Queues

Runtime BullMQ (3 queues, latency-sensitive, steady stream, small jobs) and Search-AI BullMQ (25+ queues, throughput-oriented, bursty FlowProducer DAGs, large document payloads) have incompatible profiles:

| Dimension       | Runtime Queues                                    | Search-AI Queues                                    |
| --------------- | ------------------------------------------------- | --------------------------------------------------- |
| Queue count     | 3                                                 | 25+                                                 |
| Connections/pod | ~6                                                | ~50+                                                |
| Job size        | 1-5 KB (LLM metadata, webhooks)                   | 10-500 KB (documents, embeddings)                   |
| Pattern         | Steady stream, latency-sensitive                  | Bursty — single ingestion triggers 10-50 child jobs |
| Criticality     | **High** — `llm-requests` is on the chat hot path | **Low** — background batch processing               |
| Scaling trigger | Concurrent chat sessions                          | Document ingestion volume                           |

A bulk ingestion burst's `FlowProducer` DAG writes 10-50 jobs atomically in one `MULTI/EXEC`, blocking Runtime's `llm-requests` BRPOPLPUSH.

### Recommended Topology: 4 Instances

```
+-----------------------------------------------------------+
|                    redis-sessions                          |
|  noeviction - AOF everysec - Runtime-only                 |
|                                                           |
|  sess:{t}:{s}  sess:{t}:{s}:conv  registry:{t}:{s}       |
|  lock:exec:*   exec:dedup:*       sessions:active:*       |
|  resolve:*     oauth_state:*      omnichannel:*           |
|  sso:*         verify:*           auth-gate:*             |
+-----------------------------------------------------------+

+-----------------------------------------------------------+
|                    redis-cache                             |
|  allkeys-lru - no persistence - Shared (both apps)        |
|                                                           |
|  cfg:{tenantId}    ir:{hash}       comp:{hash}            |
|  rl:{t}:{op}       budget:{t}:*    breaker:*              |
|  search-ai-runtime:rl:*                                   |
|  PUB/SUB: ws:deliver:*, dek-invalidate, model-hub,        |
|           vocabulary, alias, canonical-mapping             |
+-----------------------------------------------------------+

+-----------------------------------------------------------+
|                 redis-runtime-queues                       |
|  noeviction - RDB - Runtime-only                          |
|                                                           |
|  bull:llm-requests:*                                      |
|  bull:channel-inbound:*                                   |
|  bull:webhook-delivery:*                                  |
|  ~6 connections/pod x 8 pods = ~48 connections            |
+-----------------------------------------------------------+

+-----------------------------------------------------------+
|                 redis-search-queues                        |
|  noeviction - RDB - Search-AI only                        |
|                                                           |
|  bull:search-ingestion:*    bull:search-extraction:*      |
|  bull:search-embedding:*    bull:search-enrichment:*      |
|  bull:search-canonical-map:* bull:search-cleanup:*        |
|  bull:intelligence-crawl:*  bull:search-*-sync:*          |
|  ... (25+ queues)                                         |
|  FlowProducer DAGs for multi-stage pipelines              |
|  ~50 connections/pod x N search pods                      |
+-----------------------------------------------------------+
```

### 3-Instance Fallback (If 4 Is Too Much Operationally)

Merge the two queue instances into one. The upgrade trigger to split: when `llm-requests` queue wait time spikes during bulk ingestion.

| Instance         | What                                | Config                      |
| ---------------- | ----------------------------------- | --------------------------- |
| `redis-sessions` | Runtime session state + locks       | noeviction, AOF             |
| `redis-cache`    | Shared cache + rate limit + pub/sub | allkeys-lru, no persistence |
| `redis-queues`   | All BullMQ (Runtime + Search-AI)    | noeviction, RDB             |

### Codebase Changes Required

| File                                                         | Current                                        | Change                                                                  |
| ------------------------------------------------------------ | ---------------------------------------------- | ----------------------------------------------------------------------- |
| `packages/redis/src/connection.ts`                           | Single `REDIS_URL` singleton                   | Accept `REDIS_SESSIONS_URL`, `REDIS_CACHE_URL`, fallback to `REDIS_URL` |
| `packages/redis/src/bullmq.ts`                               | `createBullMQConnectionPair()` uses shared URL | Accept `REDIS_RUNTIME_QUEUES_URL` / `REDIS_SEARCH_QUEUES_URL`           |
| `apps/runtime/src/services/session/redis-session-store.ts`   | Uses shared client                             | Use sessions client                                                     |
| `apps/runtime/src/services/tenant-config.ts`                 | Uses shared client                             | Use cache client                                                        |
| `apps/runtime/src/services/resilience/redis-rate-limiter.ts` | Uses shared client                             | Use cache client                                                        |
| `apps/search-ai/src/queues/queue-factory.ts`                 | `getRedisConnection()`                         | Use search-queues URL                                                   |
| All pub/sub `client.duplicate()` calls                       | Duplicate from shared                          | Duplicate from cache client                                             |
| Helm values / docker-compose                                 | Single `REDIS_URL`                             | 4 URLs with fallback defaults                                           |

Backward compatibility: if only `REDIS_URL` is set, all 4 resolve to it. Roll out one tier at a time.

---

## 6. Ingestion Isolation Strategy

Ingestion is background batch work — it must never starve the real-time chat path. The problem extends beyond Redis to every shared resource.

### Contention Points

| Shared Resource              | How Ingestion Impacts Runtime                                                                                                                                                     | Severity                         |
| ---------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------- |
| Redis                        | FlowProducer DAGs (10-50 jobs atomically), 25+ queue workers with blocking commands                                                                                               | Addressed by redis-search-queues |
| MongoDB (platform DB)        | Search-AI connects with `maxPoolSize: 100` for auth/tenant lookups. Bursts exhaust connections on the shared primary. Runtime has `maxPoolSize: 5` + `waitQueueTimeoutMs: 10000`. | **HIGH**                         |
| MongoDB (secondary disk I/O) | Already at 70-99% from oplog replay. Ingestion writes to content DB generate additional oplog on the same replica set.                                                            | **HIGH**                         |
| ClickHouse                   | Ingestion writes `search_ingestion_events`, `entity_instances`. Sustained ingestion adds merge pressure.                                                                          | **MEDIUM**                       |
| CPU on shared nodes          | Search-AI worker pods can land on same nodes as runtime pods (load test showed 3 runtime pods on vmss00000C).                                                                     | **MEDIUM**                       |

### Layer 1: Infrastructure Isolation

**Dedicated Kubernetes node pool for search workers:**

```yaml
# search-ai worker deployment
spec:
  nodeSelector:
    agentpool: searchworkers
  tolerations:
    - key: workload
      value: search-ingestion
      effect: NoSchedule
```

Impact: Ingestion CPU can't steal cycles from runtime event loops. Can use different VM types (CPU-optimized for search vs memory-optimized for runtime).

**Separate MongoDB replica set for content DB:**

Search-AI's content DB (`search_documents`, `search_chunks`, `search_indexes`) is already a separate database. If on the same replica set as the platform DB, move it to its own replica set. Ingestion write IOPS go to its own disks, oplog, and secondaries.

If not feasible yet: use `readPreference: 'secondaryPreferred'` for search-ai content reads.

### Layer 2: Connection and Resource Caps

**MongoDB platform DB — reduce Search-AI's pool:**

Search-AI connects to the platform DB with `maxPoolSize: 100` (`apps/search-ai/src/server.ts:331`). That's 20x Runtime's pool of 5. For platform DB lookups (auth, tenant config — read-only, cacheable), this is far too high:

```typescript
// search-ai platform DB connection — recommended
minPoolSize: 2,
maxPoolSize: 10,                        // was 100
readPreference: 'secondaryPreferred',   // leave primary for runtime writes
```

**ClickHouse — lower priority for ingestion writes:**

```sql
INSERT INTO abl_platform.search_ingestion_events
SETTINGS priority = 2    -- lower priority than default (0)
```

Reduce ingestion buffer to shed load earlier:

```typescript
// ClickHouseIngestionStore
batchSize: 1_000,        // keep current
maxBufferSize: 20_000,   // reduce from 50,000
flushIntervalMs: 10_000, // increase from 5,000
```

**BullMQ — rate limit ingestion queues:**

```typescript
const queue = new Queue('search-ingestion', {
  connection: searchQueueRedis,
  limiter: {
    max: 50,
    duration: 1_000, // 50 jobs/s max
  },
});
```

Suggested limits for heavy queues:

| Queue                       | Limit | Why                                       |
| --------------------------- | ----- | ----------------------------------------- |
| `search-ingestion`          | 50/s  | Entry point — gates everything downstream |
| `search-extraction`         | 30/s  | CPU-heavy document parsing                |
| `search-docling-extraction` | 10/s  | Heaviest CPU — PDF/image processing       |
| `search-embedding`          | 20/s  | External API calls, network-bound         |
| `search-enrichment`         | 20/s  | LLM calls for entity extraction           |

Downstream queues (`search-tree-building`, `search-canonical-map`, `search-cleanup`) are fast — no limit needed.

### Layer 3: Adaptive Backpressure

Static caps aren't enough. Ingestion should sense runtime pressure and back off dynamically.

**Health-aware queue pausing:**

```
Runtime pod metrics (event loop blocked %, CPU %)
        |
        v
  Shared metric (Redis cache key, updated every 10s)
        |
        v
  Search-AI orchestrator checks before dispatching
        |
        +-- Runtime healthy (EL < 50%, CPU < 70%)  --> Normal rate
        |
        +-- Runtime warm (EL 50-70%, CPU 70-85%)    --> Reduce concurrency 50%
        |
        +-- Runtime hot (EL > 70%, CPU > 85%)       --> Pause ingestion queues
```

BullMQ supports programmatic pause/resume:

```typescript
const runtimeLoad = await cacheRedis.get('runtime:load:level');
if (runtimeLoad === 'hot') {
  await ingestionQueue.pause();
} else {
  await ingestionQueue.resume();
}
```

Runtime publishes its load level to `redis-cache` (one key, 10s interval). Search-AI reads before dispatching. No tight coupling — just a shared signal.

---

## 7. Action Items

### Priority Order

| #   | Change                                                             | Effort             | Impact       | Addresses                                         |
| --- | ------------------------------------------------------------------ | ------------------ | ------------ | ------------------------------------------------- |
| 1   | **Capture Tier 1 MongoDB metrics in next 400 VU test**             | Monitoring config  | **CRITICAL** | Reveals proximity to memory cliff                 |
| 2   | **Capture Redis SLOWLOG during load test**                         | One command        | **HIGH**     | Identifies root cause of 5-10s tail               |
| 3   | **Separate `redis-search-queues`**                                 | Config change      | **HIGH**     | Redis head-of-line blocking                       |
| 4   | **Dedicated K8s node pool for search workers**                     | Infra change       | **HIGH**     | CPU/memory contention on shared nodes             |
| 5   | **Reduce Search-AI platform DB pool to 10** + `secondaryPreferred` | 2-line code change | **HIGH**     | MongoDB connection contention                     |
| 6   | **BullMQ rate limits on ingestion queues**                         | Small code change  | **MEDIUM**   | Burst absorption, steady downstream load          |
| 7   | **Separate `redis-sessions` from `redis-cache`**                   | Config change      | **MEDIUM**   | Eviction policy isolation, persistence separation |
| 8   | **Separate MongoDB replica set for content DB**                    | Infra provisioning | **MEDIUM**   | Disk I/O isolation for secondaries                |
| 9   | **Separate `redis-runtime-queues` from `redis-search-queues`**     | Config change      | **MEDIUM**   | Queue workload isolation                          |
| 10  | **ClickHouse `priority = 2` for ingestion inserts**                | 1-line change      | **LOW**      | Query scheduling priority                         |
| 11  | **Adaptive backpressure (health-aware pause)**                     | New feature        | **MEDIUM**   | Dynamic protection during peak load               |

### Next Load Test Requirements

Run **400 VU step test** (200 -> 300 -> 400) with:

- All Tier 1 MongoDB WiredTiger cache metrics captured every 10s
- Redis `SLOWLOG` enabled with threshold 1000ms
- Redis `COMMANDSTATS` captured before and after
- Per-collection `db.collection.stats()` for hot-path collections (index sizes, document counts, avgObjSize)
- ClickHouse `system.parts` snapshot for `platform_events` partition part count

### Scaling Summary

| Database       | Scaling Model                                                                   | Key Risk                                                | First Metric to Watch                                                    |
| -------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------ |
| **Redis**      | Single-threaded ceiling — one core is the hard limit                            | Head-of-line blocking from large session persists       | `SLOWLOG` + `COMMANDSTATS`                                               |
| **MongoDB**    | Memory cliff — linear until working set exceeds cache, then non-linear collapse | WiredTiger cache exhaustion causing app-thread eviction | `wiredTiger.cache.pages evicted by application threads` (must stay at 0) |
| **ClickHouse** | Linear with merge pressure — scales well until part count grows                 | Materialized view overhead slowing insert path          | `PartsActive` per partition + `ActiveMerges`                             |
