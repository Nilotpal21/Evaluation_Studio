# Search Tool Call Latency Analysis

**Date**: 2026-04-17  
**Focus**: Understanding where time is spent during agent→search tool call flow

## Overview

When an agent calls a search tool, the request flows through multiple layers:

```
Agent LLM → Runtime Tool Executor → SearchAI SDK → SearchAI Runtime → Query Pipeline → OpenSearch
```

## Complete Flow with Timing Checkpoints

### 1. **Agent LLM Decision** (variable, typically 500ms-5s)

- **Location**: External LLM provider (Claude, GPT-4, etc.)
- **What happens**: LLM processes conversation, decides to call search tool, generates params
- **Timing**: Depends on model speed, prompt complexity, provider load
- **Observable**: Via reasoning executor latency metrics

### 2. **Runtime Tool Dispatch** (5-20ms)

- **Location**: `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts`
- **Entry point**: `SearchAIKBToolExecutor.execute()`
- **What happens**:
  - Validates tool binding exists
  - Checks discovery cache (first call: cache miss)
  - Translates LLM params to SDK format
  - Normalizes queryType, filters, aggregation params
- **Timing**: In-memory operations, minimal latency

### 3. **Discovery Phase** (first call only, 100-500ms)

- **Location**: `SearchAIKBToolExecutor.ensureDiscovery()`
- **What happens**:
  - HTTP call to `GET /api/search/:indexId/discover`
  - Fetches KB manifest (vocabulary, filter fields, doc count)
  - Builds dynamic tool description
  - Caches for 5 minutes
- **Timing breakdown**:
  - Network round-trip: 20-50ms
  - MongoDB query (SearchIndex + VocabularySet + FieldMapping): 50-200ms
  - Manifest assembly: 30-100ms
- **Optimization**: Eager discovery at session start eliminates this on first actual search
- **Logged metric**: `discoveryLatencyMs` in KB tool executor

### 4. **Query Enrichment** (optional, 300-1500ms)

- **Location**: `SearchAIKBToolExecutor.enrichQueryWithFilters()`
- **Trigger**: When LLM sends no filters AND conversation context exists
- **What happens**:
  - Calls agent's LLM with enrichment prompt
  - Adds conversation context + vocabulary terms
  - LLM returns enriched query + extracted filters
- **Timing**: Full LLM round-trip (depends on model)
- **Skip condition**: If LLM already provided filters, enrichment is skipped
- **Logged**: Currently not broken out separately in logs

### 5. **SDK HTTP Call** (10-30ms)

- **Location**: `SearchAIClient.unifiedSearch()`
- **What happens**:
  - Serializes request body
  - HTTP POST to SearchAI Runtime
  - Auth token forwarding
- **Timing**: Network round-trip, minimal processing
- **Timeout**: 30 seconds default

### 6. **SearchAI Runtime Entry** (5-10ms)

- **Location**: `apps/search-ai-runtime/src/routes/` (not shown in files read)
- **What happens**:
  - Express middleware chain
  - Auth validation
  - Tenant context injection
  - Request validation
- **Timing**: Middleware overhead

### 7. **Query Pipeline Orchestration** (total varies, see stages below)

- **Location**: `apps/search-ai-runtime/src/services/query/query-pipeline.ts`
- **Entry point**: `QueryPipeline.executeUnified()`
- **Returns**: Detailed latency object with per-stage breakdown

---

## Query Pipeline Stage-by-Stage Breakdown

The query pipeline is the **core of search latency**. Let's break down each stage:

### Stage 0: Permission Filter (10-50ms)

- **Lines**: 562-605
- **What happens**:
  - User mode: Builds permission filter from IdP token (Redis cache lookup)
  - Public mode: Applies public-only filter
  - Injects filter into query
- **Latency field**: `latency.permissionFilterMs`
- **Typical time**: 10-30ms (Redis hit), 30-50ms (cache miss)
- **Critical**: Security gate, never skipped in prod

### Stage 1: Preprocessing (50-300ms, conditional)

- **Lines**: 607-655
- **Skip condition**: `skipPreprocessing=true` (agent flow skips this)
- **What happens**:
  - HTTP call to Python preprocessing service (port 8003)
  - Language detection
  - Spell correction
  - Synonym expansion
  - Entity extraction
- **Latency field**: `latency.preprocessingMs`
- **Typical time**: 50-150ms (simple), 150-300ms (complex multilingual)
- **Agent optimization**: Runtime sets `skipPreprocessing=true` by default

### Stage 2: Vocabulary Resolution + Classification (100-1500ms, conditional)

- **Lines**: 660-824
- **Skip condition**: `skipVocabularyResolution=true` (agent flow skips by default)
- **What happens**:
  - **Dynamic resolver path** (LLM-based):
    - Calls LLM to classify query type (semantic/structured/aggregation)
    - Extracts structured filters from natural language
    - Maps terms to vocabulary (e.g., "PDFs" → `source_type=pdf`)
    - Returns resolutions + classified queryType
    - **Time**: 500-1500ms (full LLM call)
  - **Static resolver path** (regex/fuzzy match):
    - Matches query against pre-loaded vocabulary
    - Extracts filters via pattern matching
    - **Time**: 50-150ms (in-memory)
- **Latency field**: `latency.vocabularyResolveMs`
- **Agent optimization**: Skipped because agent already has vocabulary in tool description
- **Critical detail**: Even when skipped, the cached vocab is used for aggregations

### Stage 2.5: Alias Resolution (5-20ms, always runs)

- **Lines**: 829-866
- **What happens**:
  - Maps alias field names to OpenSearch paths
  - Coerces enum values (e.g., "PDF" → "pdf")
  - Handles `canonical.*` prefix normalization
- **Latency field**: `latency.aliasResolveMs`
- **Typical time**: 5-15ms (in-memory field mapping)

### Stage 2.6: Doc-ID Filter (< 5ms, optional)

- **Lines**: 869-884
- **Skip condition**: Only used by Browse SDK for facet-to-document scoping
- **What happens**: Injects `terms` filter for specific document IDs
- **Not separately timed** (included in search execution)

### Stage 3: Search Execution (50-1500ms, **the big one**)

- **Lines**: 886-1431
- **What happens** (varies by query type):

#### 3a. DSL Build (10-50ms)

- **Lines**: 931-1022
- **Sub-stages**:
  - Await precomputed embedding (if parallel embedding started in Stage 2): 0-5ms
  - `HybridSearchBuilder.buildQueryFromResolution()`: 10-30ms
  - Inject permission filter: < 1ms
  - Inject metadata filters (agent-provided): 1-5ms
  - Inject appId filter (multi-tenant isolation): < 1ms
  - Exclude question vectors (for aggregations): < 1ms
  - Boost kNN k (if filters present): < 1ms
  - Inject doc-ID filter (if Browse SDK): < 1ms
- **Time**: 15-50ms total
- **Logged**: `timingBreakdown.dslBuildMs`

#### 3b. Embedding Generation (semantic/hybrid only, 100-500ms)

- **Where**: Inside `HybridSearchBuilder` or via parallel promise
- **What happens**:
  - **Per-KB provider resolution**: Looks up activeEmbeddingConfig (MongoDB)
  - **HTTP call to embedding service**: BGE-M3 (port 8000) or external API
  - **Tokenization + inference**: Model-dependent
- **Timing**:
  - BGE-M3 (local): 80-200ms
  - OpenAI text-embedding-3-large: 100-300ms
  - Voyage AI: 150-500ms
- **Optimization**: Started in parallel with vocabulary resolution (Stage 2, line 668)
- **Logged**: `timingBreakdown.embeddingWaitMs` (if parallel), otherwise included in dslBuildMs

#### 3c. OpenSearch Query (50-1000ms)

- **What happens** (varies by query type):

**Hybrid queries (client-side RRF)**:

- **Lines**: 1044-1201
- **Parallel sub-queries**:
  - kNN query (pure vector): 50-300ms
  - BM25 query (keyword): 30-150ms
- **RRF fusion** (client-side): 5-10ms
- **Cross-KB leakage check**: < 1ms
- **Defensive post-filter**: 1-5ms
- **Time**: 80-450ms total (parallel sub-queries dominate)

**Semantic/Vector queries**:

- **Pure kNN with Faiss native filter**: 50-300ms
- **Factors**:
  - Index size (more vectors = slower HNSW traversal)
  - Filter selectivity (Faiss applies filter during traversal)
  - k value (higher k = more neighbors explored)

**Structured queries**:

- **BM25 with bool filters**: 30-200ms
- **Factors**:
  - Doc count in filtered subset
  - Filter complexity (term vs range vs wildcard)

**Aggregation queries**:

- **Terms aggregation with cardinality**: 50-500ms
- **Factors**:
  - Unique value count (higher cardinality = slower)
  - Filter selectivity (fewer docs = faster)
  - Grouping depth (multi-level groupBy)

- **Logged**: `timingBreakdown.osQueryMs`

#### 3d. Question → Parent Resolution (10-50ms)

- **Lines**: 2276-2372
- **What happens**:
  - Identifies question chunk results (have `metadata.sys.questionId`)
  - Bulk-fetches parent content chunks in ONE query (optimized)
  - Merges in score-preserving order (no re-sorting)
  - Deduplicates (same parent from multiple questions)
- **Timing**:
  - Pre-scan: < 1ms
  - Bulk fetch: 10-40ms (depends on parent count)
  - Merge pass: 1-5ms
- **Logged**: Included in `latency.searchExecutionMs`

### Stage 4: Rerank (optional, 200-1500ms)

- **Lines**: 1434-1492
- **Skip condition**: `rerank=false` OR queryType is structured/aggregation
- **What happens**:
  - **Batched reranker** (default):
    - Adds to Redis-backed batch queue
    - Waits for batch window (50ms) or batch size (10 queries)
    - Single HTTP call to reranker for entire batch
    - Distributes results back to waiting callers
  - **Standard reranker** (fallback):
    - Direct HTTP call per query
  - **Providers**: Cohere rerank-english-v3.0, Voyage rerank-lite-1, or custom
- **Latency field**: `latency.rerankMs`
- **Typical time**:
  - Batched: 200-600ms (includes 50ms batch wait)
  - Standard: 300-800ms (per-query call)
  - Cohere: 300-500ms
  - Voyage: 400-700ms
- **Fallback**: If reranker unavailable, returns original results (no added latency)

### Stage 5: Metrics & Cost (< 5ms)

- **Lines**: 1495-1619
- **What happens**:
  - Calculates embedding cost (tokens × provider rate)
  - Calculates rerank cost (docs × provider rate)
  - Records to in-memory metrics store
  - Fire-and-forget: Records to ClickHouse (async, no blocking)
- **Timing**: Pure in-memory math, negligible
- **Not separately timed**

---

## Real-World Latency Profiles

### Profile 1: Agent Semantic Search (Fast Path)

**Query**: "What are the main features of the platform?"  
**Query type**: Semantic (auto-detected)  
**Filters**: None  
**Rerank**: Yes

```
Stage 0: Permission Filter         15ms
Stage 1: Preprocessing            [SKIPPED - agent flow]
Stage 2: Vocabulary Resolution    [SKIPPED - agent flow]
Stage 2.5: Alias Resolution         8ms
Stage 3: Search Execution:
  - Embedding (parallel)          180ms
  - DSL build                      25ms
  - kNN query (Faiss)             220ms
  - Question→Parent resolution     35ms
Stage 4: Rerank (batched)         420ms
Stage 5: Metrics                    2ms

TOTAL: 905ms
```

**Bottlenecks**:

1. Rerank: 420ms (46% of total)
2. kNN query: 220ms (24%)
3. Embedding: 180ms (20%)

### Profile 2: Agent Structured Search with Filters (Ultra-Fast)

**Query**: "list all PDF documents"  
**Query type**: Structured  
**Filters**: `[{field: "source_type", operator: "equals", value: "pdf"}]`  
**Rerank**: No (structured queries don't rerank)

```
Stage 0: Permission Filter         12ms
Stage 1: Preprocessing            [SKIPPED]
Stage 2: Vocabulary Resolution    [SKIPPED]
Stage 2.5: Alias Resolution         6ms
Stage 3: Search Execution:
  - DSL build                      18ms
  - BM25 + filter query            85ms
Stage 4: Rerank                   [SKIPPED - structured query]
Stage 5: Metrics                    1ms

TOTAL: 122ms
```

**Bottlenecks**:

1. BM25 query: 85ms (70% of total) — unavoidable, this is the actual search

### Profile 3: Agent Aggregation Query (Medium)

**Query**: "how many documents per file type"  
**Query type**: Aggregation  
**Filters**: None  
**Rerank**: No (aggregations don't rerank)

```
Stage 0: Permission Filter         14ms
Stage 1: Preprocessing            [SKIPPED]
Stage 2: Vocabulary Resolution    [SKIPPED]
Stage 2.5: Alias Resolution         5ms
Stage 3: Search Execution:
  - DSL build                      22ms
  - Terms aggregation             180ms
  - Exclude question vectors        1ms
Stage 4: Rerank                   [SKIPPED - aggregation]
Stage 5: Metrics                    2ms

TOTAL: 224ms
```

**Bottlenecks**:

1. Terms aggregation: 180ms (80% of total) — cardinality-dependent

### Profile 4: Direct User Search (Full Pipeline)

**Query**: "financial reports Q4"  
**Query type**: Auto (hybrid)  
**Filters**: None (extracted by vocab resolver)  
**Rerank**: Yes  
**Flow**: Direct API call (not from agent)

```
Stage 0: Permission Filter         18ms
Stage 1: Preprocessing            220ms  ← NOT skipped
Stage 2: Vocabulary Resolution    850ms  ← NOT skipped (LLM call)
Stage 2.5: Alias Resolution         9ms
Stage 3: Search Execution:
  - Embedding (parallel)          [ALREADY DONE in Stage 2]
  - DSL build                      28ms
  - Hybrid RRF (parallel):
    - kNN sub-query               240ms
    - BM25 sub-query              110ms
    - RRF fusion                    8ms
  - Question→Parent resolution     42ms
Stage 4: Rerank (batched)         480ms
Stage 5: Metrics                    3ms

TOTAL: 2008ms (2.0 seconds)
```

**Bottlenecks**:

1. Vocabulary resolution: 850ms (42% of total) — LLM call
2. Rerank: 480ms (24%)
3. kNN sub-query: 240ms (12%)
4. Preprocessing: 220ms (11%)

**Agent vs Direct comparison**: Agent flow is **5-10x faster** for the same query because:

- Skips Stage 1 preprocessing (saves 200-300ms)
- Skips Stage 2 vocab resolution (saves 500-1500ms)
- Agent LLM already has vocab context in tool description

---

## Latency Observability

### Where to Find Timing Data

#### 1. SearchAI Runtime Response (latency object)

Every query returns a `latency` object:

```json
{
  "latency": {
    "permissionFilterMs": 15,
    "preprocessingMs": 0,
    "vocabularyResolveMs": 0,
    "aliasResolveMs": 8,
    "vectorSearchMs": 280,
    "searchExecutionMs": 280,
    "rerankMs": 420,
    "totalMs": 723
  }
}
```

**Note**: `vectorSearchMs` and `searchExecutionMs` often have the same value — both measure Stage 3.

#### 2. Debug Trace (debug=true)

Add `"debug": true` to the search request to get per-stage traces:

```json
{
  "debugTrace": {
    "stages": {
      "permissionFilter": { "applied": true, "durationMs": 15 },
      "preprocessing": { "applied": false, "durationMs": 0 },
      "vocabularyResolution": { "applied": false, "durationMs": 0 },
      "aliasResolution": { "applied": true, "durationMs": 8 },
      "searchExecution": {
        "applied": true,
        "durationMs": 280,
        "queryType": "semantic",
        "rawResultCount": 12
      },
      "rerank": {
        "applied": true,
        "durationMs": 420,
        "modelUsed": "cohere",
        "resultCountBefore": 12,
        "resultCountAfter": 12
      }
    },
    "totalDurationMs": 723
  }
}
```

#### 3. Server Logs (StructuredLogger)

Query pipeline logs include timing breakdowns:

```
[QueryPipeline] Search executed via unified path {
  queryType: 'semantic',
  resultsCount: 12,
  topScore: 0.89,
  collectionName: 'search-vectors-019d4416-v2',
  timingBreakdown: {
    embeddingWaitMs: 5,
    dslBuildMs: 25,
    osQueryMs: 220,
    usedPrecomputedEmbedding: true
  }
}
```

#### 4. KB Tool Executor Logs

Tool-level timing:

```
[searchai-kb-tool-executor] SearchAI KB tool search completed {
  indexId: '019d4416-...',
  query: 'platform features',
  queryType: 'semantic',
  filtersCount: 0,
  totalCount: 12,
  resultCount: 12,
  topScore: 0.89,
  searchLatencyMs: 723,  ← END-TO-END from SDK call start to response
  skipPreprocessing: true,
  skipVocabularyResolution: true,
  resolvedQueryType: 'semantic'
}
```

#### 5. ClickHouse Query Store (async)

Every query is recorded to `search_queries` table:

```sql
SELECT
  query_text,
  query_type,
  result_count,
  total_latency_ms,
  vocabulary_resolve_ms,
  vector_search_ms,
  rerank_ms,
  timestamp
FROM search_queries
WHERE tenant_id = '...' AND index_id = '...'
ORDER BY timestamp DESC
LIMIT 10;
```

---

## Optimization Opportunities

### 1. Reranking (saves 200-800ms)

**Current**: Enabled by default for semantic/hybrid queries  
**Options**:

- Disable for low-latency use cases: `rerank: false`
- Use faster model: Voyage rerank-lite-1 (400ms) vs Cohere v3 (500ms)
- Batch size tuning: Increase batch size to reduce per-query wait
- **Trade-off**: 5-15% relevance loss without reranking

### 2. Embedding Service (saves 50-200ms)

**Current**: BGE-M3 via HTTP (80-200ms)  
**Options**:

- In-process embedding (no HTTP overhead): 50-120ms
- GPU acceleration (if not already enabled)
- Batch embeddings when possible (agent multi-query)
- **Trade-off**: Memory overhead for in-process model

### 3. Parallel Discovery (saves 100-500ms on first call)

**Current**: Discovery happens on first tool execution  
**Implemented**: `triggerEagerDiscovery()` at session start  
**Usage**: Runtime calls this when agent session starts, before LLM sees tool list  
**Result**: First actual search has description ready, no discovery latency

### 4. Question→Parent Resolution (saves 10-40ms)

**Current**: Always runs for non-aggregation queries  
**Options**:

- Skip if no question vectors in index (check capability flag)
- Make optional via query param
- **Trade-off**: Questions provide better semantic matching

### 5. Permission Filter Caching (saves 10-30ms)

**Current**: Redis lookup on every query  
**Options**:

- Extend TTL (currently 5 minutes)
- Pre-warm cache at session start
- **Trade-off**: Staleness risk for rapidly changing permissions

### 6. Vocabulary Resolution Skip (already optimized)

**Agent flow**: Skipped by default (`skipVocabularyResolution=true`)  
**Savings**: 500-1500ms per query  
**Why it works**: Agent LLM already has vocabulary in tool description

### 7. Preprocessing Skip (already optimized)

**Agent flow**: Skipped by default (`skipPreprocessing=true`)  
**Savings**: 50-300ms per query  
**Why it works**: Agent's base model handles language/spelling better than microservice

---

## Prompt Optimization for Speed

The agent's tool description and param descriptions guide the LLM's behavior. Current optimizations:

### 1. Vocabulary in Tool Description (not in every call)

- **Pattern**: Discovery manifest → tool description (cached 5min)
- **Benefit**: LLM sees available terms/filters once, not per query
- **Impact**: Enables vocab resolution skip (saves 500-1500ms)

### 2. Clear queryType Guidance

- **Pattern**: Param description includes when to use each type
- **Benefit**: Reduces hallucinated types (e.g., "phrase", "keyword")
- **Impact**: Fewer normalization retries, cleaner logs

### 3. Filter Format Examples

- **Pattern**: Param description shows JSON structure
- **Benefit**: Reduces malformed filter objects
- **Impact**: Fewer runtime errors, no retry overhead

### 4. Aggregation Format Examples

- **Pattern**: Param description shows `{field, function}` structure
- **Benefit**: Reduces bare-string aggregations
- **Impact**: Fewer normalization warnings

---

## Current Bottlenecks (Priority Order)

### For Agent Queries (Typical Case)

1. **Reranking (420ms avg)** — 40-50% of total latency
2. **kNN query (220ms avg)** — 20-30% of total latency
3. **Embedding (180ms avg)** — 15-20% of total latency

### For Direct User Queries

1. **Vocabulary resolution (850ms avg)** — 40-50% of total latency
2. **Reranking (480ms avg)** — 20-25% of total latency
3. **Preprocessing (220ms avg)** — 10-15% of total latency
4. **kNN query (240ms avg)** — 10-15% of total latency

---

## Recommendations

### Immediate (No Code Change)

1. **Enable eager discovery** at session start (if not already)
2. **Profile your workload**: Add `debug: true` to 100 queries, measure stage distribution
3. **Tune reranking**: Disable for latency-sensitive use cases, or switch to faster model

### Short Term (Config Changes)

1. **Increase reranker batch size** (reduce per-query wait)
2. **Extend vocab cache TTL** (reduce MongoDB hits)
3. **Pre-warm permission cache** at session start

### Medium Term (Code Changes)

1. **Conditional question resolution** (skip if KB has no questions)
2. **In-process embedding** for local models (eliminate HTTP overhead)
3. **Streaming results** (return top results before reranking completes)

### Long Term (Architecture)

1. **Edge caching** for popular queries (Redis/CDN)
2. **Predictive embedding** (embed likely queries before agent asks)
3. **Multi-stage retrieval** (fast first-pass → rerank only top-k)
