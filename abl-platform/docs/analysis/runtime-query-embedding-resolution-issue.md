# Runtime Query Embedding Resolution Issue

**Date**: 2026-04-01  
**Status**: Root Cause Identified  
**Severity**: High - Blocks all per-KB dynamic embedding resolution in runtime queries

---

## Problem Summary

When a search query is executed through the runtime's unified pipeline with `queryType: "hybrid"` or `"semantic"`, the query returns 0 results with `errorCount: 1`. The embedding provider fails to resolve dynamically, falling back to the global BGE-M3 provider (1024d), which creates a dimension mismatch with the OpenSearch index (1536d).

---

## Data Architecture (Current State)

### MongoDB Collections

**1. SearchIndex** (abl_platform DB):

```json
{
  "_id": "019d4416-2ba2-73a7-a3c5-3acd0f3279c0",
  "name": "testembed Index",
  "projectId": "019d2921-a270-79a4-871e-654c2ab0bffe",
  "activeVectorIndex": "search-vectors-019d4416-v1",
  "vectorIndexHistory": [
    {
      "indexName": "search-vectors-019d4416-v1",
      "dimensions": 1536,
      "provider": "openai",
      "model": "text-embedding-3-small",
      "createdAt": "2026-03-31T18:48:06.628Z"
    }
  ]
}
```

**2. KnowledgeBase** (abl_platform DB):

```json
{
  "_id": "019d4416-2bef-73d8-ae1a-84ebec4d0999",
  "tenantId": "tenant-dev-001",
  "projectId": "019d2921-a270-79a4-871e-654c2ab0bffe",
  "name": "testembed",
  "searchIndexId": "019d4416-2ba2-73a7-a3c5-3acd0f3279c0",
  "pipelineId": "019d4443-4176-7ca0-8442-40eb9f0d57c5"
}
```

**3. SearchPipelineDefinition** (search_ai DB):

```json
{
  "_id": "019d4443-4176-7ca0-8442-40eb9f0d57c5",
  "tenantId": "tenant-dev-001",
  "knowledgeBaseId": "019d4416-2bef-73d8-ae1a-84ebec4d0999",
  "status": "active",
  "activeEmbeddingConfig": {
    "provider": "openai",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

**4. OpenSearch Index** (search-vectors-019d4416-v1):

- 16 vectors, all 1536 dimensions
- Mapping confirms vector field with dimension: 1536

---

## Query Flow (Unified Pipeline)

### Request Path

```
POST /api/search-ai-runtime/search/:indexId/query
Body: { query: "manthan", queryType: "hybrid", topK: 10 }
```

### Execution Trace

```
QueryPipeline.executeUnified(query, tenantId='tenant-dev-001', ...)
  |
  | Has: query.indexId = '019d4416-2ba2-73a7-a3c5-3acd0f3279c0' (searchIndexId)
  | Has: tenantId = 'tenant-dev-001'
  |
  ├─ Stage 0: Permission Filter ✓
  ├─ Stage 1: Preprocessing ✓
  ├─ Stage 2: Vocabulary Resolution ✓
  ├─ Stage 2.5: Alias Resolution ✓
  |
  └─ Stage 3: Build + Execute Search
     |
     ├─ Call: hybridSearchBuilder.buildQueryFromResolution(
     |           vocabResult,
     |           resolvedQueryType='hybrid',
     |           { limit: 10, offset: 0 }
     |        )
     |
     |   ⚠️  PROBLEM: Does NOT pass tenantId or projectKbId!
     |
     └─ Inside HybridSearchBuilder.buildQueryFromResolution():
        |
        ├─ Creates params object:
        |    params = {
        |      query: searchQuery,
        |      queryType: 'hybrid',
        |      projectKbId: '',        ← ⚠️  EMPTY STRING
        |      tenantId: '',           ← ⚠️  EMPTY STRING
        |      limit: 10,
        |      offset: 0
        |    }
        |
        ├─ Calls: buildHybridQuery(vocabResult, searchQuery, params)
        |    |
        |    └─ Calls: resolveEmbeddingProvider(params.projectKbId='', params.tenantId='')
        |         |
        |         ├─ Tries: KnowledgeBase.findOne({ searchIndexId: '', tenantId: '' })
        |         |    → Returns null (no KB with empty searchIndexId)
        |         |
        |         └─ Throws: "KB not found for searchIndexId: "
        |              OR falls back to global provider (BGE-M3, 1024d)
        |
        └─ Result: Uses BGE-M3 1024d → dimension mismatch → 0 results
```

---

## Root Cause

### Design Gap in `buildQueryFromResolution`

**File**: `apps/search-ai-runtime/src/services/hybrid-search/hybrid-search-builder.ts`  
**Lines**: 192-205

```typescript
async buildQueryFromResolution(
  vocabResult: { resolutions: DynamicResolutionResult[]; originalQuery: string },
  queryType: QueryType,
  options?: { limit?: number; offset?: number },
): Promise<OpenSearchQuery> {
  const searchQuery = vocabResult.originalQuery;
  const params = {
    query: searchQuery,
    queryType,
    projectKbId: '',   // ⚠️  HARDCODED EMPTY STRING
    tenantId: '',      // ⚠️  HARDCODED EMPTY STRING
    limit: options?.limit,
    offset: options?.offset,
  };
  // ...
}
```

**Why This Fails:**

1. The `buildQueryFromResolution` method was designed to accept pre-resolved vocabulary results without context
2. It hardcodes `projectKbId` and `tenantId` as empty strings
3. When `buildSemanticQuery` or `buildHybridQuery` call `resolveEmbeddingProvider(params.projectKbId, params.tenantId)`, they pass empty strings
4. The resolver cannot find the KB or Pipeline → fails or falls back to global provider
5. Query uses wrong dimensions → OpenSearch returns 0 results

---

## Comparison: Worker vs Runtime

### Embedding Worker (Works Correctly)

**File**: `apps/search-ai/src/workers/embedding-worker.ts`

```typescript
async function resolveEmbeddingProviderForJob(
  tenantId: string,
  knowledgeBaseId?: string,
): Promise<EmbeddingProvider> {
  if (!knowledgeBaseId) {
    return getEmbeddingProvider(); // Fallback
  }

  // Query pipeline by knowledgeBaseId
  const pipeline = await SearchPipelineDefinition.findOne({
    tenantId,
    knowledgeBaseId, // ✓ Uses actual KB ID
    status: 'active',
  }).lean();

  if (!pipeline?.activeEmbeddingConfig) {
    return getEmbeddingProvider();
  }

  // Create provider from pipeline config
  const { provider, model, dimensions } = pipeline.activeEmbeddingConfig;
  const credentials = await resolveEmbeddingCredentials(provider, tenantId);
  return createEmbeddingProvider({ provider, model, dimensions, apiKey: credentials.apiKey });
}
```

**Why It Works:**

- Receives actual `knowledgeBaseId` from job data
- Queries pipeline directly with that ID
- Successfully resolves OpenAI 1536d provider

### Runtime Query (Fails)

**Current flow:**

- QueryPipeline has `tenantId` and `query.indexId` (searchIndexId)
- Calls `buildQueryFromResolution()` without passing them
- Builder hardcodes empty strings
- Resolver fails

---

## Design Analysis

### Architecture Mismatch

The unified pipeline has a **separation of concerns** issue:

1. **QueryPipeline** (orchestrator):
   - Has tenant/KB context
   - Manages all stages
   - Resolves OpenSearch collection name
   - BUT doesn't pass context to query builder

2. **HybridSearchBuilder** (query builder):
   - Builds OpenSearch DSL
   - Needs to embed query (requires provider)
   - BUT receives no context to resolve provider

3. **EmbeddingProviderResolver** (provider resolver):
   - Resolves provider from KB → Pipeline
   - Requires tenantId + searchIndexId
   - BUT receives empty strings

### Why Was It Designed This Way?

The `buildQueryFromResolution` method signature suggests it was designed for:

- **Stateless query building**: Just vocabulary + query type → DSL
- **Pre-embedded scenarios**: Where embedding happens before builder is called
- **Testing**: Easy to test with minimal input

But the **dynamic per-KB embedding** requirement conflicts with this design:

- Embedding must happen inside the builder (semantic/hybrid queries)
- Builder needs runtime context (tenant, KB) to resolve provider
- Current signature doesn't accept context

---

## Required Changes

### Option 1: Pass Context to buildQueryFromResolution

**Signature change:**

```typescript
async buildQueryFromResolution(
  vocabResult: { resolutions: DynamicResolutionResult[]; originalQuery: string },
  queryType: QueryType,
  options?: { limit?: number; offset?: number },
  context?: { tenantId: string; projectKbId: string },  // ← NEW
): Promise<OpenSearchQuery>
```

**Pros:**

- Minimal change
- Backward compatible (context is optional)
- Clear responsibility

**Cons:**

- Breaks "stateless builder" pattern
- All callers must pass context

### Option 2: Embed Query Before Builder

**Flow:**

```typescript
// In QueryPipeline.executeUnified:
const embedding = await this.embedQuery(searchQuery, tenantId, query.indexId);

const dslBody = await this.hybridSearchBuilder.buildQueryFromResolution(
  vocabResult,
  resolvedQueryType,
  { limit: 10, offset: 0 },
  embedding, // ← Pass pre-generated embedding
);
```

**Pros:**

- Builder stays stateless
- QueryPipeline controls embedding
- Matches legacy path pattern

**Cons:**

- Breaks builder encapsulation (builder can't control embedding)
- Requires new parameter for embedding
- Complicates builder logic (check if embedding provided vs generate)

### Option 3: Store Context in Builder Instance

**Constructor:**

```typescript
constructor(
  private vocabularyResolver: DynamicVocabularyResolver,
  private embeddingProvider: EmbeddingProvider,
  private embeddingProviderResolver?: EmbeddingProviderResolver,
  private defaultContext?: { tenantId: string; projectKbId: string },  // ← NEW
)
```

**Pros:**

- No method signature changes
- Works for single-tenant/single-KB scenarios

**Cons:**

- Shared builder instance can't handle multi-tenant queries
- Violates builder reusability

---

## Recommended Solution

**Option 1 with Enhanced API:**

```typescript
// Add overload for context-aware queries
async buildQueryFromResolution(
  vocabResult: { resolutions: DynamicResolutionResult[]; originalQuery: string },
  queryType: QueryType,
  options: {
    limit?: number;
    offset?: number;
    tenantId?: string;      // ← Add to options
    projectKbId?: string;   // ← Add to options
  },
): Promise<OpenSearchQuery> {
  const searchQuery = vocabResult.originalQuery;
  const params = {
    query: searchQuery,
    queryType,
    projectKbId: options.projectKbId ?? '',   // Use provided or fallback
    tenantId: options.tenantId ?? '',         // Use provided or fallback
    limit: options.limit,
    offset: options.offset,
  };
  // ... rest of method
}
```

**Why This Works:**

- Minimal signature change (options already exists)
- Backward compatible (fields optional)
- Clear where context comes from
- Matches expected builder pattern

---

## Testing Strategy

### Before Fix

```bash
# Current behavior: 0 results, errorCount: 1
curl http://localhost:5173/api/search-ai-runtime/search/019d4416-2ba2-73a7-a3c5-3acd0f3279c0/query \
  -H 'Authorization: Bearer <token>' \
  -H 'X-Tenant-Id: tenant-dev-001' \
  -d '{"query":"manthan","queryType":"hybrid","topK":10}'

# Response: { "results": [], "totalCount": 0, "metrics": { "errorCount": 1 } }
```

### After Fix

```bash
# Expected: 4 results (documents containing "manthan")
curl http://localhost:5173/api/search-ai-runtime/search/019d4416-2ba2-73a7-a3c5-3acd0f3279c0/query \
  -H 'Authorization: Bearer <token>' \
  -H 'X-Tenant-Id: tenant-dev-001' \
  -d '{"query":"manthan","queryType":"hybrid","topK":10}'

# Response: { "results": [ ... 4 items ... ], "totalCount": 4, "metrics": { "errorCount": 0 } }
```

### Validation Points

1. ✓ Query resolves correct embedding provider (OpenAI 1536d)
2. ✓ Query embedding dimensions match index (1536)
3. ✓ OpenSearch returns results (not 0)
4. ✓ No errors in metrics
5. ✓ Works for both semantic and hybrid query types

---

## Next Steps

1. **Implement Option 1**: Update `buildQueryFromResolution` signature
2. **Update QueryPipeline**: Pass tenantId and projectKbId in options
3. **Add logging**: Log resolved provider in builder for debugging
4. **Test all query types**: semantic, hybrid, structured, aggregation
5. **Update tests**: Add tests for per-KB provider resolution
6. **Document pattern**: Add to architecture docs

---

## Related Files

- `apps/search-ai-runtime/src/services/query/query-pipeline.ts:886-890`
- `apps/search-ai-runtime/src/services/hybrid-search/hybrid-search-builder.ts:192-229`
- `apps/search-ai-runtime/src/services/embedding/embedding-provider-resolver-init.ts:21-50`
- `apps/search-ai/src/workers/embedding-worker.ts:193-245`
