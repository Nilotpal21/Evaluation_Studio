# Embedding Dimension Change Flow - Complete Design

## Problem Statement

When user changes embedding dimensions in pipeline (e.g., 1536d → 1024d), the system needs to:

1. Create new OpenSearch index with new dimensions
2. Re-embed all documents with new dimensions
3. Ensure query/search uses new dimensions
4. Keep old index for rollback

## Current Issues

- ❌ Dimension change doesn't auto-create new index
- ❌ Query runtime uses env vars instead of pipeline config
- ❌ Workers don't re-embed when dimensions change
- ❌ No automatic reindex trigger

## Complete Flow (Should Be)

```
┌────────────────────────────────────────────────────────────┐
│ 1. USER CHANGES DIMENSIONS IN UI                           │
│    - Edit pipeline → Change embedding provider/dimensions │
│    - Click "Publish"                                       │
└───────────────┬────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│ 2. PUBLISH HANDLER (pipelines.ts)                          │
│    - Compare old vs new activeEmbeddingConfig.dimensions  │
│    - If changed:                                           │
│      a. Generate new index name                            │
│      b. Create OpenSearch index with NEW dimensions        │
│      c. Update SearchIndex.activeVectorIndex → new index   │
│      d. Trigger reindex orchestrator                       │
└───────────────┬────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│ 3. REINDEX ORCHESTRATOR                                    │
│    - Marks all chunks for re-embedding (checkpoint 4)      │
│    - Dispatches to embedding queue                         │
└───────────────┬────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│ 4. EMBEDDING WORKER                                        │
│    - Reads pipeline.activeEmbeddingConfig                  │
│    - Uses NEW dimensions from config                       │
│    - Reads SearchIndex.activeVectorIndex                   │
│    - Writes vectors to NEW index                           │
└───────────────┬────────────────────────────────────────────┘
                │
                ▼
┌────────────────────────────────────────────────────────────┐
│ 5. QUERY RUNTIME                                           │
│    - Reads pipeline.activeEmbeddingConfig (per query)      │
│    - Uses NEW dimensions for query embedding              │
│    - Queries NEW index (from SearchIndex.activeVectorIndex)│
└────────────────────────────────────────────────────────────┘
```

## Key Principles

1. **Single Source of Truth**: Pipeline's `activeEmbeddingConfig` is the ONLY source
   - Workers read it ✓ (already implemented)
   - Runtime reads it ✓ (already implemented)
   - Publish handler reads it ✓ (already implemented)

2. **Automatic**: No manual steps required
   - Dimension change → Auto-create index ✓ (needs fix)
   - Index created → Auto-trigger reindex ✓ (already works)
   - Reindex triggered → Auto-embed with new dims ✓ (already works)

3. **Zero-Downtime**: Old data remains queryable until migration done
   - Old index kept alive
   - Can rollback by changing activeVectorIndex pointer

## Implementation Checklist

### ✅ Already Working

- [x] Embedding worker reads pipeline config dynamically
- [x] Query runtime reads pipeline config dynamically
- [x] Reindex orchestrator can mark chunks for re-embedding

### ❌ Needs Fix

- [ ] Publish handler: Detect dimension change correctly
- [ ] Publish handler: Create index with unique name (timestamp-based)
- [ ] Publish handler: Ensure reindex actually triggers workers
- [ ] Test: Full end-to-end flow (change → publish → reindex → query)

## Files That Need Changes

1. `/apps/search-ai/src/routes/pipelines.ts` (lines 494-560)
   - Simplify dimension change detection
   - Use timestamp for index names (not version numbers)
   - Ensure reindex triggers properly

2. **No changes needed** to:
   - `/apps/search-ai/src/workers/embedding-worker.ts` (already reads pipeline)
   - `/apps/search-ai-runtime/src/services/embedding/embedding-provider-resolver-init.ts` (already reads pipeline)

## Test Plan

1. **Setup**: KB with 2 docs, 1536d embeddings
2. **Change**: Switch to 1024d BGE-M3, publish
3. **Verify**:
   - New OpenSearch index created with 1024d
   - SearchIndex.activeVectorIndex updated
   - Reindex job created
   - Workers re-embed with 1024d
   - Data appears in new index
   - Query uses 1024d for search
   - Results returned correctly
4. **Cleanup**: Old index can be deleted manually later

## Current State (April 1, 2026)

- Pipeline v50: OpenAI 1536d (was active, now updated to BGE-M3 1024d)
- Index v1: 1536d (19 vectors, old data)
- Index v2: 3072d (empty, created during testing)
- Index v3: 1024d (empty, created manually)
- SearchIndex.activeVectorIndex: v3
- Documents: status='extracted' (need to re-trigger embedding)

## Next Steps

1. Restart embedding workers to pick up pipeline config
2. Manually trigger embedding jobs for the 2 documents
3. Verify v3 gets populated with 1024d vectors
4. Test query - should work with 1024d
5. Test dimension change again (e.g., to 3072d) - should auto-create v4
