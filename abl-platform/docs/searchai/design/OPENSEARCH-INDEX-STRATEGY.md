# OpenSearch Index Strategy

**Last verified against code:** March 9, 2026 (`150f97ba`)

---

## Problem

Multi-tenant RAG systems need to organise vector indices efficiently. Small knowledge bases don't justify a dedicated index (cost), large ones need isolation (performance), and shared indices grow unbounded (degradation). Manual index management doesn't scale.

**Solution:** An `IndexRegistry` in MongoDB maps every `(tenantId, appId, connectorId)` tuple to an OpenSearch index name. Three strategies — shared, per-app, per-connector — can be mixed within a single knowledge base. A `SharedIndexTracker` monitors capacity and rotates shared indices automatically at 60%.

---

## How It Works

```
                     MongoDB                              OpenSearch
         ┌───────────────────────────┐      ┌──────────────────────────────┐
         │ IndexRegistry             │      │ search-vectors-v1 (full)     │
         │  kb-1 → search-vectors-v1 │─────▶│ search-vectors-v2 (active)   │
         │  kb-1/logs → search-...-l │─────▶│ search-tenant-a-kb-1-logs    │
         ├───────────────────────────┤      └──────────────────────────────┘
         │ SharedIndexTracker        │
         │  v1: 60% full → full      │
         │  v2: 10% → active         │
         └───────────────────────────┘
```

### Write path

The embedding worker calls `resolveIndexForWrite(vectorStore, tenantId, appId, connectorId)`:

1. Look up a **connector-specific override** in IndexRegistry (`connectorId != null`).
2. If none, fall back to the **app default** (`connectorId = null`).
3. If no entry exists at all, assign the app to the current active shared index via `getActiveSharedIndex()` (which may trigger rotation — see below).

### Read path

`getAppIndices(tenantId, appId)` returns **all** OpenSearch index names for an app (shared + any dedicated overrides). The query pipeline searches them in parallel and merges results by score.

### Tenant isolation

Isolation is enforced at two layers:

- **IndexRegistry queries** are always scoped by `tenantId`.
- **OpenSearch queries** always include a `metadata.sys.tenantId` filter, so even a shared index never leaks data across tenants.

---

## Three Strategies

| Strategy          | Index name pattern                  | When to use                      | Cost   |
| ----------------- | ----------------------------------- | -------------------------------- | ------ |
| **Shared**        | `search-vectors-v{N}`               | Default. Most KBs (< 1M vectors) | Low    |
| **Per-app**       | `search-{tenant}-{app}`             | Large KBs, compliance isolation  | Medium |
| **Per-connector** | `search-{tenant}-{app}-{connector}` | One noisy source (> 5M vectors)  | High   |

### Why default to shared?

Most knowledge bases are small (thousands to low millions of vectors). Dedicated indices waste resources — each index carries fixed overhead (shards, replicas, HNSW graph). A single shared index handles hundreds of small KBs with query-time tenant filtering that adds negligible latency.

### Hybrid strategy

A single knowledge base can use **multiple strategies at once**. The IndexRegistry supports this through a fallback pattern:

```
IndexRegistry entries for kb-1:
┌──────────────────────────────────────────────────────────┐
│ connectorId: null        → search-vectors-v1   (shared)  │  ← default
│ connectorId: 'logs-s3'  → search-t-a-kb-1-logs (dedicated)│  ← override
└──────────────────────────────────────────────────────────┘
```

- Documents from `web-crawler` and `reviews-api` → shared index (uses app default)
- Documents from `logs-s3` → dedicated index (uses connector override)
- Search queries both indices in parallel and merges results

**Why this matters:** You start every KB on shared (cheap) and only carve out a dedicated index when a specific connector proves too large — without migrating the rest.

---

## Shared Index Rotation

### Trigger

When `getActiveSharedIndex()` is called and the active index's `capacityPercent >= 60%`:

1. Mark current index `status: 'full'` — it keeps serving existing apps but accepts no new ones.
2. Create `search-vectors-v{N+1}` with `status: 'active'`.
3. New apps are assigned to the new index. Existing apps stay put.

### Why 60%?

We chose 60% over 70% or 80% because:

- **Write headroom:** Existing apps keep ingesting into "full" indices. Starting rotation early gives them 40% headroom before actual capacity problems.
- **Performance:** OpenSearch write throughput degrades as segment count grows. Rotating earlier keeps each index in a comfortable operating range.
- **Trade-off accepted:** More frequent rotations mean more indices to manage, but each index stays healthier.

### Why on-demand (not scheduled)?

Rotation only fires when a new app is assigned to a shared index. This is simpler than a cron job (no scheduler, no race conditions) and accurate (checks real capacity from OpenSearch at decision time). The downside is no proactive alerting — an index could sit at 95% for weeks if no new apps are created. Capacity alerting (see Pending Tasks) would address this gap.

### Why one active index at a time?

Only one shared index has `status: 'active'`. This makes assignment deterministic ("new apps go to THE active index") and avoids load-balancing complexity. If we ever need to distribute across multiple active indices, the IndexRegistry already supports it — the constraint is in `getActiveSharedIndex()`, not the data model.

### Why immutable app → index assignment?

Once an app is assigned to a shared index, it stays there. Moving data between indices requires a full reindex (expensive, risky). Since rotation only affects _new_ app assignments, existing apps are never disrupted. Old indices remain populated but can be archived once all their apps are deleted.

---

## Data Model

### IndexRegistry

Maps apps/connectors to OpenSearch indices. Lives in MongoDB collection `index_registry`.

```typescript
{
  tenantId: string,
  appId: string,                 // SearchIndex._id
  connectorId: string | null,    // null = app default, non-null = override
  indexName: string,
  strategy: 'shared' | 'per-app' | 'per-connector',
  status: 'active' | 'migrating' | 'deleting',
  vectorCount: number
}
```

**Key indexes:** `{ tenantId, appId, connectorId, status }` (unique), `{ indexName, status }`.

**Pattern:** `connectorId: null` is the fallback entry. A non-null `connectorId` overrides it for that specific connector.

### SharedIndexTracker

Tracks capacity and rotation state. Lives in MongoDB collection `shared_index_tracker`.

```typescript
{
  indexName: string,      // 'search-vectors-v1' (unique)
  version: number,        // 1, 2, 3...
  status: 'active' | 'full' | 'migrating' | 'archived',
  vectorCount: number,
  estimatedSizeGB: number,
  capacityPercent: number,
  maxVectors: number,     // from SEARCH_INDEX_MAX_VECTORS
  maxSizeGB: number,
  appCount: number,
  lastSyncedAt: Date
}
```

**Invariant:** At most one tracker has `status: 'active'`.

---

## Configuration

```bash
# Shared index capacity
SEARCH_INDEX_MAX_VECTORS=10000000    # 10M vectors per index
SEARCH_INDEX_MAX_SIZE_GB=50
SEARCH_INDEX_CAPACITY_THRESHOLD=0.6  # 60% triggers rotation
SEARCH_INDEX_AUTO_ROTATE=true

# Index settings
SEARCH_INDEX_SHARDS=1
SEARCH_INDEX_REPLICAS=1
SEARCH_INDEX_PREFIX=search
OPENSEARCH_REFRESH_INTERVAL=5s

# HNSW parameters
OPENSEARCH_HNSW_EF_CONSTRUCTION=128       # Build quality vs speed
OPENSEARCH_HNSW_M=16                      # Recall vs memory
OPENSEARCH_HNSW_EF_SEARCH=100             # Search recall vs latency
```

**Sizing guidance:**

| Deployment         | Max vectors | Threshold | Shards |
| ------------------ | ----------- | --------- | ------ |
| Small (< 100 apps) | 10M         | 60%       | 1      |
| Medium (100-1000)  | 20M         | 60%       | 2      |
| Large (1000+)      | 50M         | 50%       | 3      |

---

## Admin Operations

| Operation         | Endpoint                                          | Notes                                    |
| ----------------- | ------------------------------------------------- | ---------------------------------------- |
| Manual rotation   | `POST /api/admin/indexes/rotate-shared`           | Forces rotation regardless of capacity   |
| Check capacity    | `GET /api/admin/indexes/shared/status`            | Returns all trackers with capacity info  |
| Archive old index | `POST /api/admin/indexes/shared/archive/:version` | Only if `status: full` and `appCount: 0` |

All three are implemented and protected by `requirePermission('admin:indexes:*')`.

---

## Code Locations

| Component                        | File                                                                  |
| -------------------------------- | --------------------------------------------------------------------- |
| IndexRegistry model              | `packages/database/src/models/index-registry.model.ts`                |
| SharedIndexTracker model         | `packages/database/src/models/shared-index-tracker.model.ts`          |
| Index resolution & rotation      | `packages/search-ai-internal/src/vector-store/index-registry.ts`      |
| OpenSearch client                | `packages/search-ai-internal/src/vector-store/opensearch.ts`          |
| Index mappings (75-field schema) | `packages/search-ai-internal/src/vector-store/opensearch-mappings.ts` |
| Embedding worker (write path)    | `apps/search-ai/src/workers/embedding-worker.ts`                      |
| Admin routes                     | `apps/search-ai/src/routes/admin.ts`                                  |

---

## Implementation Status

### Implemented

- Three index strategies (shared, per-app, per-connector)
- Hybrid strategy via connector overrides in IndexRegistry
- Auto-rotation at 60% capacity with SharedIndexTracker
- Multi-index parallel search with score-based merge
- Write path resolution (`resolveIndexForWrite`)
- Cascade deletion (`deleteAppIndices`, `deleteConnectorIndex`)
- Admin APIs: manual rotation, capacity status, archive
- Tenant isolation (MongoDB scoping + OpenSearch filters)
- 75-field strict canonical schema on all indices

### Not Implemented

| Feature                | Priority | Description                                                                                                                                                                            |
| ---------------------- | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Move app API**       | High     | `POST /admin/indexes/move-app` — reindex app vectors from shared to per-app or vice versa. Needs: scroll all vectors, bulk reindex, update registry, verify count, delete from source. |
| **Move connector API** | High     | `POST /admin/indexes/move-connector` — isolate a connector into its own index. Enables hybrid strategy without manual OpenSearch work.                                                 |
| **Capacity alerting**  | Medium   | Background check every 10 min, alert at 80%/90%. Current gap: no warning until rotation fires.                                                                                         |
| **Auto-archival**      | Medium   | Daily job archives `status: full` indices where `appCount == 0` for 90+ days. Currently manual only.                                                                                   |
| **Cost monitoring**    | Low      | Dashboard showing index count, vector distribution, estimated storage cost per strategy.                                                                                               |

---

## Related Documents

- [OPENSEARCH-FIELD-SCHEMA-REFERENCE.md](./OPENSEARCH-FIELD-SCHEMA-REFERENCE.md) — 75-field canonical schema
- [ADMIN-API-REFERENCE.md](./ADMIN-API-REFERENCE.md) — Full admin endpoint docs
- [DATABASE-SCHEMA.md](./DATABASE-SCHEMA.md) — All MongoDB models
