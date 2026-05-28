# Dimension-Aware Shared Vector Index Pool — Blue-Green Reindexing Design

> **Status**: FUTURE — Not for current implementation.
> **Prerequisite**: Multi-model UI where users explicitly provide multiple embedding models.
> **Created**: 2026-04-03 | **Branch context**: ABLP-128

## 1. Problem Statement

When a user switches embedding models (e.g., BGE-M3 → Cohere embed-v3), all existing
vectors become incompatible with query embeddings from the new model. Today, we do a
"hard switch" — reindex everything with the new model, and queries are degraded until
reindex completes. This design eliminates that downtime via blue-green reindexing within
shared dimension-pooled indexes.

### Why This Is Deferred

Blue-green requires the runtime to continue embedding queries with the **old** model
during reindex. This requires:

1. **Old model credentials** — if the user deletes their OpenAI key after switching to
   Cohere, runtime can't embed with the old model. A 10-min cache is insufficient for
   large KB reindexes (hours).
2. **Multi-model UI** — user must explicitly declare "I'm transitioning from Model A to
   Model B" and keep both credentials active. This UI doesn't exist yet.
3. **Credential lifecycle** — system must block credential deletion while a B-G reindex
   is in progress.

## 2. Architecture Overview

### 2.1 Shared Index Pool (Prerequisite — Implemented Separately)

Indexes are pooled by dimension: `search-vectors-{dims}-v{N}`

- Different embedding models at the same dimension coexist in one index
- OpenSearch kNN pre-filters by `indexId` before computing similarity — vectors from
  different models never cross-pollinate
- Capacity-based rotation: at 60% (6M vectors), create next version

### 2.2 Blue-Green Data Flow

```
USER: Switches embedding model (same or different dimensions)
        │
        ▼
┌──────────────────────────────────────────────────────────────┐
│ PIPELINE PUBLISH                                              │
│                                                               │
│ 1. Save new config to SearchIndex.pendingEmbeddingConfig     │
│ 2. Set pendingVectorVersion = activeVectorVersion + 1        │
│ 3. Set pendingVectorIndex = resolveSharedIndex(newDims)      │
│ 4. Set reindexState = 'reindexing'                           │
│ 5. DO NOT update activeEmbeddingConfig (runtime keeps old)   │
│ 6. Trigger reindex job                                       │
└──────────────────┬───────────────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
┌───────▼──────┐    ┌────────▼──────────────┐
│ RUNTIME      │    │ EMBEDDING WORKER       │
│              │    │                        │
│ Reads:       │    │ Reads:                 │
│  active*     │    │  pending*              │
│  Embeds with │    │  Embeds with NEW model │
│  OLD model   │    │  Tags vectors with     │
│  Filters by  │    │  pendingVectorVersion  │
│  activeVer   │    │                        │
│              │    │ Handles:               │
│ Queries old  │    │  - Reindex chunks      │
│ vectors only │    │  - NEW uploads too     │
└───────┬──────┘    └────────┬──────────────┘
        │                    │
        ▼                    ▼
┌──────────────────────────────────────────────┐
│ OPENSEARCH SHARED INDEX                       │
│ (e.g., search-vectors-1024-v1)               │
│                                               │
│  KB-1 vectorVersion=1 (old, BGE-M3)    ← runtime queries
│  KB-1 vectorVersion=2 (new, Cohere)    ← invisible to runtime
│  KB-2 vectorVersion=1 (other KB)       ← unaffected
└──────────────────────────────────────────────┘
        │
  REINDEX COMPLETE (all chunks re-embedded)
        │
        ▼
┌──────────────────────────────────────────────┐
│ ATOMIC SWAP                                   │
│                                               │
│ 1. activeEmbeddingConfig ← pending            │
│ 2. activeVectorVersion ← pendingVectorVersion │
│ 3. activeVectorIndex ← pendingVectorIndex     │
│ 4. Clear all pending* fields                  │
│ 5. reindexState ← null                        │
│ 6. Invalidate runtime embedding cache          │
│ 7. Delete old vectorVersion docs from index   │
└──────────────────────────────────────────────┘
```

### 2.3 Key Insight: Same-Dimension Model Switch

When switching between models of the **same dimension** (e.g., BGE-M3 1024d → Cohere
1024d), both old and new vectors live in the **same shared index**. They're differentiated
only by `vectorVersion`. No new index creation needed.

When switching to a **different dimension** (e.g., 1024d → 1536d), the pending vectors
go to a different shared index (`search-vectors-1536-v1`). After swap, the old vectors
in `search-vectors-1024-v1` are cleaned up by filtered delete.

## 3. Schema Changes

### 3.1 SearchIndex Model Additions

```typescript
// In ISearchIndex interface — add these fields:
interface ISearchIndex {
  // ... existing fields ...

  // === ACTIVE STATE (what runtime uses) ===
  activeEmbeddingConfig?: {
    provider: string; // e.g., 'openai', 'cohere', 'bge-m3'
    model: string; // e.g., 'text-embedding-3-small'
    dimensions: number; // e.g., 1024
  };
  activeVectorVersion?: number; // e.g., 1
  // activeVectorIndex already exists

  // === PENDING STATE (what workers write to during B-G) ===
  pendingEmbeddingConfig?: {
    provider: string;
    model: string;
    dimensions: number;
  };
  pendingVectorVersion?: number; // e.g., 2
  pendingVectorIndex?: string; // e.g., 'search-vectors-1536-v1' (or same as active)

  // === REINDEX STATE ===
  reindexState?: 'reindexing' | null;
  reindexStartedAt?: Date;
  reindexProgress?: {
    totalChunks: number;
    completedChunks: number;
    percentComplete: number;
  };
}
```

**Schema definition:**

```typescript
activeEmbeddingConfig: {
  type: { provider: String, model: String, dimensions: Number },
  default: undefined,
},
activeVectorVersion: { type: Number, default: undefined },
pendingEmbeddingConfig: {
  type: { provider: String, model: String, dimensions: Number },
  default: undefined,
},
pendingVectorVersion: { type: Number, default: undefined },
pendingVectorIndex: { type: String, default: undefined },
reindexState: {
  type: String,
  enum: ['reindexing', null],
  default: null,
},
reindexStartedAt: { type: Date, default: undefined },
reindexProgress: {
  type: {
    totalChunks: Number,
    completedChunks: Number,
    percentComplete: Number,
  },
  default: undefined,
},
```

### 3.2 SharedIndexTracker Additions

```typescript
// Add dimensions field (also needed for non-B-G implementation)
dimensions: { type: Number, required: true, index: true },
```

**Compound index:** `{ dimensions: 1, status: 1, version: -1 }`

### 3.3 Vector Document Metadata

Each vector stored in OpenSearch gets a `vectorVersion` field:

```typescript
// In the OpenSearch document structure:
{
  vector: Float32Array,       // the embedding
  indexId: string,            // KB identifier
  chunkId: string,            // chunk reference
  vectorVersion: number,      // 1 = active, 2 = pending (during B-G)
  // ... other metadata
}
```

## 4. Detailed Implementation Plan

### 4.1 Pipeline Publish (Blue-Green Trigger)

**File:** `apps/search-ai/src/routes/pipelines.ts` (around line 490)

When `embeddingChanged` is detected during publish:

```typescript
// PSEUDO-CODE — not final implementation

if (embeddingChanged) {
  const newDims = newEmbeddingConfig.dimensions;
  const oldDims = existingIndex.activeEmbeddingConfig?.dimensions;

  // Resolve shared index for new dimensions
  const sharedIndex = await getActiveSharedIndex(newDims);

  // Determine new vector version
  const currentVersion = existingIndex.activeVectorVersion || 1;
  const nextVersion = currentVersion + 1;

  // Set pending state (DO NOT touch active state)
  await SearchIndex.findOneAndUpdate(
    { _id: existingIndex._id, tenantId },
    {
      $set: {
        pendingEmbeddingConfig: newEmbeddingConfig,
        pendingVectorVersion: nextVersion,
        pendingVectorIndex: sharedIndex.indexName,
        reindexState: 'reindexing',
        reindexStartedAt: new Date(),
      },
    },
  );

  // Trigger reindex — worker will read pending* fields
  await triggerReindex(existingIndex._id, tenantId);
}
```

### 4.2 Embedding Worker (Dual-Path Write)

**File:** `apps/search-ai/src/workers/embedding-worker.ts` (around line 274)

```typescript
// PSEUDO-CODE

async function resolveWriteTarget(index: ISearchIndex): Promise<{
  vectorIndex: string;
  vectorVersion: number;
  embeddingConfig: EmbeddingConfig;
}> {
  if (index.reindexState === 'reindexing') {
    // During B-G: ALL writes go to pending path
    return {
      vectorIndex: index.pendingVectorIndex!,
      vectorVersion: index.pendingVectorVersion!,
      embeddingConfig: index.pendingEmbeddingConfig!,
    };
  }

  // Normal: write to active path
  return {
    vectorIndex: index.activeVectorIndex,
    vectorVersion: index.activeVectorVersion || 1,
    embeddingConfig: index.activeEmbeddingConfig!,
  };
}
```

**Critical:** New document uploads during reindex MUST go to the pending path.
Otherwise, they'd be embedded with the new model but tagged with the old version,
making them invisible to runtime queries.

### 4.3 Runtime Query Pipeline (Version-Filtered kNN)

**File:** `apps/search-ai-runtime/src/services/query/query-pipeline.ts`

The kNN query must include a `vectorVersion` filter:

```typescript
// PSEUDO-CODE — in resolveCollectionName / buildKnnQuery

async function buildKnnQuery(indexId: string, queryVector: number[], k: number) {
  const searchIndex = await getSearchIndex(indexId);
  const vectorVersion = searchIndex.activeVectorVersion || 1;

  return {
    knn: {
      field: 'vector',
      query_vector: queryVector,
      k,
      filter: {
        bool: {
          must: [
            { term: { indexId } },
            { term: { vectorVersion } }, // ← NEW: version filter
          ],
        },
      },
    },
  };
}
```

### 4.4 Runtime Embedding Resolution (Read from SearchIndex)

**File:** `apps/search-ai-runtime/src/services/embedding/embedding-provider-resolver-init.ts`

Currently reads from `pipeline.activeEmbeddingConfig`. Must change to read from
`searchIndex.activeEmbeddingConfig`:

```typescript
// PSEUDO-CODE

// BEFORE (current):
const config = pipeline.activeEmbeddingConfig;

// AFTER (B-G):
const searchIndex = await SearchIndex.findOne({ _id: indexId, tenantId });
const config = searchIndex.activeEmbeddingConfig;
// This ensures runtime uses OLD model until swap, even though pipeline already
// has the NEW model config.
```

### 4.5 Reindex Completion (Atomic Swap)

**File:** `apps/search-ai/src/services/reindexing/` (new or existing handler)

```typescript
// PSEUDO-CODE

async function completeReindex(indexId: string, tenantId: string) {
  const searchIndex = await SearchIndex.findOne({ _id: indexId, tenantId });

  if (searchIndex.reindexState !== 'reindexing') {
    throw new Error('No reindex in progress');
  }

  const oldVectorVersion = searchIndex.activeVectorVersion || 1;
  const oldVectorIndex = searchIndex.activeVectorIndex;

  // ATOMIC SWAP
  await SearchIndex.findOneAndUpdate(
    { _id: indexId, tenantId, reindexState: 'reindexing' },
    {
      $set: {
        activeEmbeddingConfig: searchIndex.pendingEmbeddingConfig,
        activeVectorVersion: searchIndex.pendingVectorVersion,
        activeVectorIndex: searchIndex.pendingVectorIndex,
        reindexState: null,
      },
      $unset: {
        pendingEmbeddingConfig: 1,
        pendingVectorVersion: 1,
        pendingVectorIndex: 1,
        reindexStartedAt: 1,
        reindexProgress: 1,
      },
    },
  );

  // CLEANUP: Delete old version vectors
  await deleteVectorsByVersion(oldVectorIndex, indexId, oldVectorVersion);

  // INVALIDATE: Runtime embedding cache
  await invalidateRuntimeCache(tenantId, indexId);
}
```

### 4.6 Cleanup — Delete Old Vectors

```typescript
// Delete vectors with old vectorVersion from OpenSearch
async function deleteVectorsByVersion(indexName: string, indexId: string, vectorVersion: number) {
  await opensearchClient.deleteByQuery({
    index: indexName,
    body: {
      query: {
        bool: {
          must: [{ term: { indexId } }, { term: { vectorVersion } }],
        },
      },
    },
  });
}
```

## 5. Credential Handling (Multi-Model UI)

### 5.1 The Problem

During B-G reindex, runtime must embed queries with the **old** model. If the user
deletes the old provider's credentials (e.g., removes their OpenAI API key), runtime
can't generate query embeddings → queries fail.

### 5.2 The Solution: Multi-Model UI

The UI must support:

1. **Model transition declaration**: "I'm switching from OpenAI ada-002 to Cohere
   embed-v3"
2. **Both credentials required**: System validates that credentials for BOTH models
   exist before starting B-G reindex
3. **Credential lock**: While a B-G reindex is in progress, the old model's credentials
   cannot be deleted. UI shows: "This credential is in use by an active reindex.
   Complete or cancel the reindex before deleting."
4. **Transition status**: Dashboard shows reindex progress, which model is "active"
   (serving queries) and which is "pending" (being reindexed into)

### 5.3 Credential Lock Implementation

```typescript
// When user tries to delete a credential:
async function canDeleteCredential(tenantId: string, credentialId: string) {
  // Check if any KB is using this credential in active or pending config
  const activeUse = await SearchIndex.findOne({
    tenantId,
    'activeEmbeddingConfig.credentialId': credentialId,
  });

  const pendingUse = await SearchIndex.findOne({
    tenantId,
    'pendingEmbeddingConfig.credentialId': credentialId,
    reindexState: 'reindexing',
  });

  if (pendingUse) {
    return {
      canDelete: false,
      reason: `Credential is in use by an active reindex for KB "${pendingUse.name}". Cancel the reindex first.`,
    };
  }

  return { canDelete: true };
}
```

## 6. Edge Cases & Error Handling

### 6.1 Reindex Failure Mid-Way

If the reindex job fails (worker crash, OpenSearch down):

1. `reindexState` remains 'reindexing'
2. Runtime continues serving from active — no impact
3. Admin can retry the reindex or cancel it
4. Cancel: `$unset` all pending fields, delete pending vectorVersion vectors

### 6.2 User Changes Model Again During Reindex

If a second model change is published while B-G is in progress:

1. **Option A (recommended)**: Block — return error "Reindex already in progress.
   Wait for completion or cancel."
2. **Option B**: Cancel current reindex, start new one with latest model.

Recommendation: Option A for simplicity. The multi-model UI can show this state.

### 6.3 Shared Index Capacity During B-G

During B-G for same-dimension change, the shared index temporarily holds 2x vectors
for that KB. The capacity tracker must account for this:

```typescript
// When calculating capacity during B-G:
const effectiveCount = tracker.vectorCount; // includes both versions
// Rotation threshold should account for B-G overhead
const rotationThreshold = tracker.maxVectors * 0.5; // lower threshold during B-G
```

### 6.4 Cross-Dimension B-G

When switching from 1024d to 1536d:

- Pending vectors go to `search-vectors-1536-v1`
- Active vectors remain in `search-vectors-1024-v1`
- After swap: delete old vectors from `search-vectors-1024-v1`
- If that KB was the last one in 1024 index, capacity drops significantly

## 7. Testing Strategy

### 7.1 Unit Tests

- `resolveWriteTarget()` returns pending path when reindexState = 'reindexing'
- `resolveWriteTarget()` returns active path when reindexState = null
- kNN query includes vectorVersion filter
- Atomic swap correctly moves pending → active and clears pending
- Credential lock prevents deletion during active reindex

### 7.2 Integration Tests

- Full B-G cycle: publish → reindex → swap → query returns new vectors
- New upload during reindex goes to pending path
- Runtime uses old model during reindex, new model after swap
- Same-dimension model switch (vectors coexist in same index)
- Cross-dimension model switch (vectors in different indexes)
- Reindex cancellation cleans up pending vectors

### 7.3 E2E Tests

- User switches model → queries continue working throughout
- User uploads new doc during reindex → doc becomes queryable after swap
- User tries to delete credential during reindex → blocked with message
- Large KB reindex (10K+ chunks) completes successfully

## 8. Migration Path

When implementing B-G on top of the already-implemented dimension-aware pool:

1. Add pending\* fields to SearchIndex schema
2. Add vectorVersion to all vector documents (default: 1 for existing)
3. Update embedding worker to check reindexState
4. Update runtime kNN to include vectorVersion filter
5. Build reindex completion handler with atomic swap
6. Build multi-model UI (separate feature)
7. Wire credential lock to credential deletion endpoint

No data migration needed — existing vectors get vectorVersion=1 by default.
The B-G system is additive; it only activates when a model change triggers
reindexState='reindexing'.

## 9. Dependencies

| Dependency                 | Status           | Blocker? |
| -------------------------- | ---------------- | -------- |
| Dimension-aware pool       | Planned          | Yes      |
| Multi-model UI             | Not started      | Yes      |
| Credential lock API        | Not started      | Yes      |
| Reindex progress tracking  | Exists (partial) | No       |
| Runtime cache invalidation | Exists           | No       |
