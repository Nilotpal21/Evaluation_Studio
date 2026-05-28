# Dimension-Aware Shared Vector Index Pool — Low-Level Design

> **Ticket**: ABLP-128 | **HLD**: `dimension-aware-shared-vector-pool.hld.md`

## Task T-1: SharedIndexTracker dimension field

### Files to Modify

- `packages/database/src/models/shared-index-tracker.model.ts` — add `dimensions` field to interface and schema

### Changes

1. Add `dimensions: number` to `ISharedIndexTracker` interface
2. Add `dimensions` field to schema (required, indexed)
3. Replace existing `{ status: 1, version: -1 }` index with compound `{ dimensions: 1, status: 1, version: -1 }`

### Acceptance Criteria

- AC-1: `ISharedIndexTracker` has `dimensions: number` field
- AC-2: Schema requires `dimensions` on creation
- AC-3: Compound index enables efficient queries like `{ dimensions: 1024, status: 'active' }`

---

## Task T-2: Dimension-aware getActiveSharedIndex()

### Files to Modify

- `packages/search-ai-internal/src/vector-store/index-registry.ts` — modify `getActiveSharedIndex`, `createSharedIndex`, `forceRotateSharedIndex`, `syncSharedIndexStats`

### Changes

1. `getActiveSharedIndex(vectorStore, config)` → `getActiveSharedIndex(vectorStore, dimensions, config)`
   - Filter by `{ status: 'active', dimensions }` instead of just `{ status: 'active' }`
   - Pass `dimensions` to `createSharedIndex`

2. `createSharedIndex(vectorStore, version, config)` → `createSharedIndex(vectorStore, version, dimensions, config)`
   - Index name: `search-vectors-${dimensions}-v${version}` (was `search-vectors-v${version}`)
   - Pass `dimensions` to `vectorStore.createCollection()`
   - Store `dimensions` on tracker document

3. `forceRotateSharedIndex(vectorStore, config)` → `forceRotateSharedIndex(vectorStore, dimensions, config)`
   - Filter by `{ status: 'active', dimensions }` instead of just `{ status: 'active' }`

4. `syncSharedIndexStats` — update size estimate to use actual dimensions:
   - `(vectorCount * dimensions * 4) / 1024^3` instead of hardcoded 1024

5. Replace `console.log` with `createLogger('index-registry')`

### Acceptance Criteria

- AC-1: `getActiveSharedIndex(vectorStore, 1024)` returns `search-vectors-1024-v1`
- AC-2: `getActiveSharedIndex(vectorStore, 1536)` returns `search-vectors-1536-v1` (separate pool)
- AC-3: Rotation is per-dimension (1024 rotating doesn't affect 1536)
- AC-4: First call for a new dimension creates the index lazily

---

## Task T-3: Pipeline publish uses shared pool

### Files to Modify

- `apps/search-ai/src/routes/pipelines.ts` — replace per-KB index creation with shared pool resolution

### Changes

In the `dimensionsChanged` block (line ~501-614) and the first-publish block (line ~616-698):

1. **Dimensions changed**: Replace the per-KB index creation (`search-vectors-{indexId}-{timestamp}`) with:

   ```
   import { getActiveSharedIndex, createVectorStore } from '@agent-platform/search-ai-internal';
   const sharedIndexName = await getActiveSharedIndex(vectorStore, newDims);
   ```

   - Update `SearchIndex.activeVectorIndex` to the shared index name
   - Still delete old per-KB index if it was a per-KB index (not a shared one)
   - Keep the runtime cache invalidation
   - Keep the vectorIndexHistory push

2. **First publish (no dimension change)**: Same approach — use `getActiveSharedIndex(newDims)` instead of creating per-KB index

3. **Old index cleanup**: Only delete old index if it's a per-KB index (name contains the indexId prefix). Shared indexes are managed by the pool system and should NOT be deleted when one KB leaves.

### Acceptance Criteria

- AC-1: New KB publish creates/uses `search-vectors-{dims}-v1` (not per-KB)
- AC-2: Dimension change from 1024→1536 switches to `search-vectors-1536-v{N}`
- AC-3: Old per-KB index is deleted after transition
- AC-4: Old shared index is NOT deleted (other KBs may use it)
- AC-5: Runtime cache invalidation still happens
- AC-6: vectorIndexHistory still records the transition
