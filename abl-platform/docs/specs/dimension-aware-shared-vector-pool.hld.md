# Dimension-Aware Shared Vector Index Pool — High-Level Design

> **Scope**: Dimension-aware shared indexes with direct switch (NO blue-green).
> **Blue-green design**: See `dimension-aware-shared-vector-pool-blue-green.design.md`
> **Ticket**: ABLP-128

## What

Replace the current per-KB vector index creation pattern with a dimension-pooled shared
index system. Today, every KB that changes embedding dimensions gets its own dedicated
OpenSearch index (`search-vectors-{indexId}-{timestamp}`), causing index proliferation
(100 KBs at 1536d = 100 separate indexes). The new system pools vectors into shared
indexes by dimension (`search-vectors-1024-v1`, `search-vectors-1536-v1`), with
automatic capacity-based rotation per dimension.

**Key insight**: Different embedding models at the same dimension CAN coexist in the
same index because every query pre-filters by `indexId` before kNN computation —
vectors from different models never cross-pollinate.

**What this does NOT include**: Blue-green reindexing (zero-downtime model switching).
Model changes use the existing direct-switch approach: publish triggers reindex, queries
may be degraded until reindex completes. B-G is designed separately and requires a
multi-model UI that doesn't exist yet.

## Architecture Approach

### Packages Changed

| Package                       | Change                                                       |
| ----------------------------- | ------------------------------------------------------------ |
| `packages/database`           | SharedIndexTracker: add `dimensions` field + compound index  |
| `packages/search-ai-internal` | index-registry.ts: dimension-aware `getActiveSharedIndex()`  |
| `apps/search-ai`              | pipelines.ts: use shared pool instead of per-KB index create |

### Data Flow — Dimension-Aware Publish

```
PUBLISH (model change: 1024d → 1536d)
        │
        ▼
┌───────────────────────────────────────────────────┐
│ PIPELINE PUBLISH                                   │
│                                                    │
│ 1. Detect embeddingChanged (dimensions changed)   │
│ 2. getActiveSharedIndex(1536)                     │
│    → finds search-vectors-1536-v1 (or creates it) │
│ 3. Update SearchIndex.activeVectorIndex            │
│ 4. Delete old per-KB index (if was per-KB)        │
│    OR leave shared index alone (just update ref)  │
│ 5. Trigger reindex job                            │
│ 6. Invalidate runtime cache                       │
└───────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────┐
│ EMBEDDING WORKER                                   │
│                                                    │
│ Reads SearchIndex.activeVectorIndex                │
│ → "search-vectors-1536-v1"                        │
│ Embeds with new model, writes to shared index     │
└───────────────────────────────────────────────────┘
        │
        ▼
┌───────────────────────────────────────────────────┐
│ RUNTIME (after reindex completes)                  │
│                                                    │
│ Reads SearchIndex → activeVectorIndex              │
│ Embeds query with current model                   │
│ kNN search in search-vectors-1536-v1              │
│ Pre-filtered by indexId                           │
└───────────────────────────────────────────────────┘
```

### Data Flow — Capacity Rotation

```
search-vectors-1024-v1 reaches 60% capacity (6M vectors)
        │
        ▼
┌───────────────────────────────────────────────────┐
│ AUTO-ROTATION                                      │
│                                                    │
│ 1. Mark v1 status = 'full'                        │
│ 2. Create search-vectors-1024-v2                  │
│ 3. New KBs at 1024d → v2                         │
│ 4. Existing KBs stay in v1 (no migration)        │
└───────────────────────────────────────────────────┘
```

### Key Integration Points

1. **Pipeline Publish → SharedIndexTracker**: Resolves shared index by dimension
2. **Pipeline Publish → SearchIndex**: Updates activeVectorIndex to shared index name
3. **Embedding Worker → SearchIndex**: Reads activeVectorIndex (unchanged behavior)
4. **Runtime → SearchIndex**: Reads activeVectorIndex (unchanged behavior)
5. **SharedIndexTracker**: Capacity rotation per dimension pool

## Decisions & Tradeoffs

- **Decision 1**: Shared indexes keyed by dimension only (not provider+model+dimension).
  Different embedding models at same dimension coexist in one index.
  Reason: OpenSearch kNN pre-filters by indexId before computing similarity.
  Vectors from different models never interact. Fewer indexes = less overhead.

- **Decision 2**: Direct switch on model change (no blue-green).
  Reason: B-G requires credential retention for old model during reindex window.
  Without a multi-model UI, users can't declare both models upfront. Deferred to
  future scope. Current behavior: reindex, queries degraded until complete.

- **Decision 3**: Lazy index creation per dimension.
  First KB at dimension N triggers creation of `search-vectors-N-v1`.
  No pre-creation of indexes for all possible dimensions.

- **Decision 4**: Existing per-KB indexes continue working (gradual convergence).
  Only new dimension changes use the pool system. Over time, KBs naturally move
  into pools. No migration script needed.

- **Decision 5**: Old per-KB index deletion on transition to shared pool.
  When a KB moves from a per-KB index to a shared pool (via model change),
  the old per-KB index is deleted after reindex completes. This prevents
  orphaned indexes.

## Task Decomposition

| Task                                        | Package(s)         | Independent?  | Est. Files |
| ------------------------------------------- | ------------------ | ------------- | ---------- |
| T-1: SharedIndexTracker dimension field     | database           | Yes           | 1          |
| T-2: Dimension-aware getActiveSharedIndex() | search-ai-internal | No (T-1)      | 1          |
| T-3: Pipeline publish uses shared pool      | search-ai (routes) | No (T-1, T-2) | 1          |

## Out of Scope

- Blue-green reindexing (see `dimension-aware-shared-vector-pool-blue-green.design.md`)
- activeEmbeddingConfig on SearchIndex (needed only for B-G)
- vectorVersion tag on vectors (needed only for B-G)
- Multi-model UI
- Admin API for manual strategy selection
- Migration script for existing per-KB indexes → shared pools
- UI changes in Studio for reindex status display
- Multi-index fan-out search
- Wiring `forceRotateSharedIndex()` to an admin API endpoint
