# Query Pipeline Deep Dive: Complete Step-by-Step Flow

**Author:** Bharat R
**Date:** 2026-02-23
**Status:** Architectural Review in Progress

## Table of Contents

1. [Pipeline Overview](#pipeline-overview)
2. [Stage-by-Stage Data Transformations](#stage-by-stage-data-transformations)
3. [Performance & Cost Analysis](#performance--cost-analysis)
4. [Architectural Review & Gaps](#architectural-review--gaps)
5. [Recommendations](#recommendations)

---

## Pipeline Overview

The Query Pipeline orchestrates 5 stages to transform user queries into ranked search results:

```
┌─────────────────────────────────────────────────────────────┐
│                    Query Pipeline Flow                       │
├─────────────────────────────────────────────────────────────┤
│                                                               │
│  Stage 1: Vocabulary Resolution (15ms)                       │
│  ├─ Load domain vocabulary from MongoDB                      │
│  ├─ Match business terms (exact/alias/fuzzy)                 │
│  ├─ Extract structured filters                               │
│  └─ Remove matched terms from query text                     │
│                                                               │
│  Stage 2: Query Embedding (30ms)                             │
│  ├─ Send remaining text to BGE-M3                            │
│  └─ Receive 1024-dim vector                                  │
│                                                               │
│  Stage 3: Vector Search (85ms)                               │
│  ├─ Construct OpenSearch k-NN query                          │
│  ├─ Apply filters (metadata must match)                      │
│  ├─ Search with vector similarity                            │
│  └─ Return top K results                                     │
│                                                               │
│  Stage 4: Reranking (0ms - stub)                             │
│  └─ TODO: LLM-based cross-encoder reranking                  │
│                                                               │
│  Stage 5: Response Formatting (5ms)                          │
│  ├─ Add query ID                                             │
│  ├─ Calculate latency breakdown                              │
│  └─ Return SearchResponse                                    │
│                                                               │
└─────────────────────────────────────────────────────────────┘
```

---

## Stage-by-Stage Data Transformations

### Example Query Journey

**Initial Input:**

```json
{
  "query": "Show me premium customers in SF with revenue > 100K from Q1 2024",
  "queryType": "hybrid",
  "topK": 10,
  "hybridAlpha": 0.7,
  "rerank": true,
  "filters": [],
  "indexId": "kb_abc123"
}
```

### Stage 0: Input Preparation

```typescript
// Initial state
const latency = {
  vocabularyResolveMs: 0,
  vectorSearchMs: 0,
  structuredFilterMs: 0,
  rerankMs: 0,
  totalMs: 0,
};

let resolvedQuery = query.query; // Full original query
let filters = query.filters; // Empty array []
```

---

### Stage 1: Vocabulary Resolution (15ms)

**Location:** `apps/search-ai-runtime/src/services/vocabulary/vocabulary-resolver.ts`

#### Input:

```typescript
{
  projectKbId: "kb_abc123",
  query: "Show me premium customers in SF with revenue > 100K from Q1 2024",
  mode: "alias"
}
```

#### Processing:

**1. Load Vocabulary from MongoDB:**

```typescript
const vocabulary = await DomainVocabulary.findOne({
  projectKnowledgeBaseId: 'kb_abc123',
  status: 'active',
})
  .sort({ version: -1 })
  .lean();

// Returns vocabulary with entries:
{
  entries: [
    {
      term: 'premium customers',
      aliases: ['premium', 'VIP'],
      resolution: {
        type: 'filter',
        filters: [{ field: 'customerTier', operator: 'eq', value: 'premium' }],
      },
      enabled: true,
    },
    {
      term: 'SF',
      aliases: ['San Francisco', 'San Fran'],
      resolution: {
        type: 'filter',
        filters: [{ field: 'city', operator: 'eq', value: 'San Francisco' }],
      },
      enabled: true,
    },
    {
      term: 'revenue > 100K',
      aliases: ['high revenue', '> 100k'],
      resolution: {
        type: 'filter',
        filters: [{ field: 'revenue', operator: 'gt', value: 100000 }],
      },
      enabled: true,
    },
    {
      term: 'Q1 2024',
      aliases: ['first quarter 2024'],
      resolution: {
        type: 'composite',
        resolutions: [
          {
            type: 'filter',
            filters: [
              { field: 'date', operator: 'gte', value: '2024-01-01' },
              { field: 'date', operator: 'lte', value: '2024-03-31' },
            ],
          },
        ],
      },
      enabled: true,
    },
  ];
}
```

**2. Term Matching Algorithm:**

```typescript
let remainingQuery = 'Show me premium customers in SF with revenue > 100K from Q1 2024';

// Iteration 1: Match "premium customers"
// Found: exact match, confidence 1.0
// Extract filter: { field: "customerTier", operator: "eq", value: "premium" }
remainingQuery = remainingQuery.replace('premium customers', '').trim();
// Result: "Show me in SF with revenue > 100K from Q1 2024"

// Iteration 2: Match "SF"
// Found: alias of "San Francisco", confidence 0.9
remainingQuery = remainingQuery.replace('SF', '').trim();
// Result: "Show me in with revenue > 100K from Q1 2024"

// Iteration 3: Match "revenue > 100K"
// Found: alias match
remainingQuery = remainingQuery.replace('revenue > 100K', '').trim();
// Result: "Show me in with from Q1 2024"

// Iteration 4: Match "Q1 2024"
// Found: exact match
remainingQuery = remainingQuery.replace('Q1 2024', '').trim();
// Result: "Show me in with from"

// Split remaining into segments
unresolvedSegments = remainingQuery.split(/\s+/).filter((s) => s.length > 0);
// Result: ["Show", "me", "in", "with", "from"]
```

#### Output:

```typescript
{
  resolvedTerms: [
    {
      inputTerm: "premium customers",
      matchedTerm: "premium customers",
      matchType: "exact",
      confidence: 1.0,
      resolution: { type: "filter", filters: [...] }
    },
    {
      inputTerm: "SF",
      matchedTerm: "San Francisco",
      matchType: "alias",
      confidence: 0.9,
      resolution: { type: "filter", filters: [...] }
    },
    {
      inputTerm: "revenue > 100K",
      matchedTerm: "high revenue",
      matchType: "alias",
      confidence: 0.9,
      resolution: { type: "filter", filters: [...] }
    },
    {
      inputTerm: "Q1 2024",
      matchedTerm: "Q1 2024",
      matchType: "exact",
      confidence: 1.0,
      resolution: { type: "composite", resolutions: [...] }
    }
  ],

  unresolvedSegments: ["Show", "me", "in", "with", "from"],

  structuredFilters: [
    { field: "customerTier", operator: "eq", value: "premium" },
    { field: "city", operator: "eq", value: "San Francisco" },
    { field: "revenue", operator: "gt", value: 100000 },
    { field: "date", operator: "gte", value: "2024-01-01" },
    { field: "date", operator: "lte", value: "2024-03-31" }
  ]
}
```

#### State Changes:

```typescript
// BEFORE:
query.query = "Show me premium customers in SF with revenue > 100K from Q1 2024"
query.filters = []

// AFTER:
resolvedQuery = "Show me in with from"  // ← 68% reduction, only stopwords remain
query.filters = [5 structured filters]  // ← Merged vocabulary + original filters
```

**⚠️ CRITICAL ISSUE IDENTIFIED:**

- Remaining text contains only stopwords with zero semantic value
- Original query intent completely lost
- Embedding will be meaningless

---

### Stage 2: Query Embedding (30ms)

**Location:** `query-pipeline.ts:116-119` + BGE-M3 Service

#### Input:

```typescript
{
  text: "Show me in with from",  // ← Only stopwords!
  model: "bge-m3",
  dimensions: 1024
}
```

#### Processing:

```typescript
// HTTP POST to http://bge-m3-service:8001/embed
const response = await fetch('http://bge-m3-service:8001/embed', {
  method: 'POST',
  body: JSON.stringify({
    text: 'Show me in with from', // ← Useless text
    normalize: true,
  }),
});

const embedding = await response.json();
```

#### Output:

```typescript
embedding = [
  0.0234, -0.1567, 0.0892, 0.2341, -0.0456, 0.1789, -0.0923, 0.1234,
  // ... 1016 more float32 values ...
  0.0567, -0.189, 0.2456, 0.0789,
]; // 1024-dimensional vector representing stopwords
```

**⚠️ CRITICAL ISSUE:**

- Embedding represents stopwords, not actual query intent
- No semantic search capability retained
- Defeats the purpose of vector search

---

### Stage 3: Vector Search (85ms)

**Location:** `query-pipeline.ts:125-150` + OpenSearch

#### Input:

```typescript
{
  collection: "kb_abc123",
  params: {
    vector: [0.023, -0.156, ..., 0.078],  // Meaningless stopword embedding
    topK: 10,
    filters: [
      { field: "customerTier", operator: "eq", value: "premium" },
      { field: "city", operator: "eq", value: "San Francisco" },
      { field: "revenue", operator: "gt", value: 100000 },
      { field: "date", operator: "gte", value: "2024-01-01" },
      { field: "date", operator: "lte", value: "2024-03-31" }
    ]
  }
}
```

#### OpenSearch Query:

```json
{
  "bool": {
    "must": [
      {
        "knn": {
          "vector": {
            "vector": [0.023, -0.156, ...],
            "k": 10
          }
        }
      },
      { "term": { "metadata.customerTier": "premium" } },
      { "term": { "metadata.city": "San Francisco" } },
      { "range": { "metadata.revenue": { "gt": 100000 } } },
      { "range": { "metadata.date": { "gte": "2024-01-01" } } },
      { "range": { "metadata.date": { "lte": "2024-03-31" } } }
    ]
  }
}
```

**⚠️ ISSUE: Not True Hybrid Search**

- No BM25 full-text scoring
- No score fusion (RRF/RSF)
- This is "filtered vector search", not hybrid
- `hybridAlpha` parameter is ignored

#### Output:

```typescript
[
  {
    id: "chunk_001",
    score: 0.92,  // Pure k-NN similarity score
    content: "Premium customers in SF generated $150K in Q1 2024...",
    metadata: { customerTier: "premium", city: "San Francisco", revenue: 150000, ... }
  },
  // ... 9 more results
]
```

---

### Stage 4: Reranking (0ms - Not Implemented)

**Location:** `query-pipeline.ts:156-159`

#### Current Implementation:

```typescript
private async rerank(_query: string, results: SearchResult[]): Promise<SearchResult[]> {
  // TODO: Call reranker service (e.g., Cohere rerank-english-v3.0)
  return results;  // ← No-op, returns unchanged
}
```

**⚠️ ISSUE: Stub Only**

- No actual reranking happens
- `query.rerank` flag is ignored
- Scores remain from Stage 3

---

### Stage 5: Response Formatting (5ms)

#### Output:

```typescript
{
  queryId: "qry_1708562345678_a7k2m9",
  results: [
    {
      documentId: "doc_xyz789",
      chunkId: "chunk_001",
      score: 0.92,
      content: "Premium customers in SF generated $150K in Q1 2024...",
      metadata: { ... }
    }
    // ... 9 more
  ],
  totalCount: 10,
  latency: {
    vocabularyResolveMs: 15,
    vectorSearchMs: 115,
    structuredFilterMs: 0,
    rerankMs: 0,
    totalMs: 148
  }
}
```

---

## Performance & Cost Analysis

| Stage         | Latency   | Cost     | Bottleneck    | Issue                  |
| ------------- | --------- | -------- | ------------- | ---------------------- |
| Vocabulary    | 15ms      | Free     | MongoDB       | ✓ Working              |
| Embedding     | 30ms      | Free\*   | Inference     | ⚠️ Embedding stopwords |
| Vector Search | 85ms      | Free     | k-NN          | ⚠️ Not true hybrid     |
| Reranking     | 0ms       | N/A      | Not impl      | ❌ Stub only           |
| Formatting    | 5ms       | Free     | JSON          | ✓ Working              |
| **Total**     | **135ms** | **Free** | Vector search | ⚠️ Multiple issues     |

\*Free = self-hosted

---

## Architectural Review & Gaps

### 🔴 Critical Issues

#### 1. **Vocabulary Resolution Destroys Query Intent**

**Problem:**

```typescript
Input: 'Show me premium customers in SF with revenue > 100K from Q1 2024';
Output: 'Show me in with from'; // Only stopwords!
```

**Impact:**

- Embedding has zero semantic value
- Vector search cannot find relevant documents
- Query intent completely lost

**Root Cause:**

- Greedy term removal without preserving query structure
- No stopword detection before removal
- No semantic preservation strategy

**Evidence in Code:**

```typescript
// vocabulary-resolver.ts:70
remainingQuery = remainingQuery.replace(match.matchedText.toLowerCase(), '').trim();
// ← Blindly removes matched text, no semantic analysis
```

---

#### 2. **Not True Hybrid Search**

**Problem:**

- No BM25 full-text scoring
- No score fusion (RRF/RSF)
- `hybridAlpha` parameter completely ignored

**Current Implementation:**

```json
{
  "bool": {
    "must": [
      { "knn": { ... } },  // Vector score only
      { "term": { ... } }   // Filters (not scored)
    ]
  }
}
```

**Expected Hybrid Implementation:**

```json
{
  "query": {
    "hybrid": {
      "queries": [
        {
          "knn": { "vector": [...] }  // Vector score
        },
        {
          "match": { "content": "premium customers SF" }  // BM25 score
        }
      ],
      "fusion": {
        "type": "rrf",  // or "rsf"
        "weights": [0.7, 0.3]  // hybridAlpha
      }
    }
  }
}
```

**Evidence:**

```typescript
// opensearch.ts:126-169
// Only k-NN query, no BM25 match query
// No score fusion logic
```

---

#### 3. **Reranker Not Implemented**

**Problem:**

```typescript
// query-pipeline.ts:156-159
private async rerank(_query: string, results: SearchResult[]): Promise<SearchResult[]> {
  // TODO: Call reranker service
  return results;  // ← No-op
}
```

**Impact:**

- `query.rerank: true` has no effect
- Results not refined for final precision
- Missing 5-10% accuracy improvement

---

#### 4. **No Query Type Routing**

**Problem:**

- All queries go through same pipeline
- No specialized flows for different query types
- Cannot optimize per query type

**Missing:**

```typescript
// Should have:
switch (query.queryType) {
  case 'vector':
    return await vectorOnlyPipeline(query);
  case 'hybrid':
    return await hybridPipeline(query);
  case 'keyword':
    return await keywordOnlyPipeline(query);
  case 'structured':
    return await structuredQueryService.execute(query);
}
```

---

### 🟡 Moderate Issues

#### 5. **No Query Preprocessing**

**Missing:**

- Stopword detection/removal before vocabulary resolution
- Synonym expansion
- Query intent classification
- Typo correction

#### 6. **No Adaptive Pipeline Selection**

**Missing:**

- Query complexity analysis
- Cost-benefit analysis for reranking
- Dynamic topK adjustment
- Adaptive timeout handling

#### 7. **Incomplete Latency Tracking**

**Missing:**

- Per-filter latency
- Cache hit/miss tracking
- Embedding cache metrics
- Queue wait time

#### 8. **No Query Understanding Layer**

**Missing:**

- Intent detection (informational, navigational, transactional)
- Query expansion
- Spell correction
- Temporal query detection ("recent", "latest", "Q1 2024")

---

### 🟢 Minor Issues

#### 9. **Limited Error Handling**

**Example:**

```typescript
// query-pipeline.ts:76-78
try {
  const vocabResult = await this.vocabularyResolver.resolve(...);
} catch {
  // Vocabulary resolution failure is non-fatal
  // ← No logging, no metrics, no alerting
}
```

#### 10. **No Result Diversity**

**Missing:**

- MMR (Maximal Marginal Relevance) for diversity
- Duplicate detection
- Source diversity enforcement

#### 11. **No Explain/Debug Mode**

**Missing:**

- Query execution plan
- Score breakdown per component
- Filter application order
- Cache hit/miss details

---

## Recommendations

### 🎯 Immediate Fixes (P0)

#### Fix 1: Preserve Query Intent in Vocabulary Resolution

**Option A: Keep Original Query for Embedding**

```typescript
// vocabulary-resolver.ts
async resolve(projectKbId: string, query: string, mode: string) {
  // ... match terms, extract filters ...

  return {
    resolvedTerms,
    structuredFilters,
    // ✓ Return original query, not stripped version
    originalQuery: query,
    // Optional: return only unresolved noun phrases, not all segments
    unresolvedPhrases: this.extractNounPhrases(unresolvedSegments)
  };
}
```

```typescript
// query-pipeline.ts:62-80
const vocabResult = await this.vocabularyResolver.resolve(projectKbId, query.query);

// ✓ Use original query for embedding
const embedding = await this.embedQuery(vocabResult.originalQuery);

// ✓ Apply filters from vocabulary
if (vocabResult.structuredFilters.length > 0) {
  query.filters = [...(query.filters ?? []), ...vocabResult.structuredFilters];
}
```

**Option B: Smart Term Preservation**

```typescript
// Keep important terms, remove only if vocabulary provides equivalent filter
function shouldRemoveTerm(term: string, resolution: VocabularyResolution): boolean {
  // Only remove if resolution fully captures the term's meaning
  if (resolution.type === 'filter') {
    return true; // Filter captures exact meaning
  }
  if (resolution.type === 'field') {
    return false; // Field reference doesn't capture semantic meaning
  }
  // Keep term for semantic search
  return false;
}
```

**Recommended:** Option A (simpler, safer)

---

#### Fix 2: Implement True Hybrid Search

**Add BM25 + Vector Fusion:**

```typescript
// opensearch.ts - Add new method
async hybridSearch(
  collection: string,
  params: VectorSearchParams & { queryText: string, alpha: number }
): Promise<VectorSearchResult[]> {

  const query = {
    hybrid: {
      queries: [
        // Vector query
        {
          knn: {
            vector: {
              vector: params.vector,
              k: params.topK * 2  // Fetch more for fusion
            }
          }
        },
        // BM25 query
        {
          multi_match: {
            query: params.queryText,
            fields: ["content^2", "metadata.title^3"],  // Boosted fields
            type: "best_fields"
          }
        }
      ]
    }
  };

  // Add filters
  if (params.filters?.length) {
    query.hybrid.filters = this.buildFilter(params.filters);
  }

  const response = await this.client.search({
    index: collection,
    body: {
      size: params.topK,
      query,
      // RRF fusion
      rank: {
        rrf: {
          window_size: params.topK * 2,
          rank_constant: 60
        }
      }
    }
  });

  return this.mapHits(response.body.hits.hits);
}
```

**Use in Pipeline:**

```typescript
// query-pipeline.ts:125-150
private async vectorSearch(query: VectorSearchQuery, embedding: number[]): Promise<SearchResult[]> {
  if (!this.vectorStore || embedding.length === 0) return [];

  const collectionName = query.indexId;

  try {
    // ✓ Use hybrid search if queryType is 'hybrid'
    if (query.queryType === 'hybrid' && this.vectorStore.hybridSearch) {
      const results = await this.vectorStore.hybridSearch(collectionName, {
        vector: embedding,
        queryText: query.query,  // ← Original query for BM25
        alpha: query.hybridAlpha ?? 0.7,
        topK: query.topK ?? 10,
        scoreThreshold: query.similarityThreshold,
        filters: query.filters,
        includeMetadata: true
      });

      return results.map(r => ({ /* map to SearchResult */ }));
    }

    // Fallback to pure vector search
    const results = await this.vectorStore.search(collectionName, {
      vector: embedding,
      topK: query.topK ?? 10,
      scoreThreshold: query.similarityThreshold,
      filters: query.filters,
      includeMetadata: true
    });

    return results.map(r => ({ /* map */ }));
  } catch {
    return [];
  }
}
```

---

#### Fix 3: Implement Reranker

**Add Cohere Reranker:**

```typescript
// New file: apps/search-ai-runtime/src/services/rerank/cohere-reranker.ts

import fetch from 'node-fetch';

export interface RerankerConfig {
  apiKey: string;
  model: string; // 'rerank-english-v3.0'
  topN?: number;
}

export class CohereReranker {
  constructor(private config: RerankerConfig) {}

  async rerank(query: string, documents: string[]): Promise<RerankResult[]> {
    const response = await fetch('https://api.cohere.ai/v1/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        query,
        documents,
        model: this.config.model,
        top_n: this.config.topN ?? documents.length,
        return_documents: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Reranker API error: ${response.statusText}`);
    }

    const data = await response.json();
    return data.results; // [{ index: 0, relevance_score: 0.98 }, ...]
  }
}

interface RerankResult {
  index: number;
  relevance_score: number;
}
```

**Use in Pipeline:**

```typescript
// query-pipeline.ts

import { CohereReranker } from './rerank/cohere-reranker.js';

export class QueryPipeline {
  private readonly reranker?: CohereReranker;

  constructor(opts?: QueryPipelineOptions) {
    this.vocabularyResolver = opts?.vocabularyResolver ?? new VocabularyResolver();
    this.embeddingProvider = opts?.embeddingProvider;
    this.vectorStore = opts?.vectorStore;

    // ✓ Initialize reranker if API key provided
    if (process.env.COHERE_API_KEY) {
      this.reranker = new CohereReranker({
        apiKey: process.env.COHERE_API_KEY,
        model: 'rerank-english-v3.0',
        topN: 10,
      });
    }
  }

  private async rerank(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    if (!this.reranker || results.length === 0) {
      return results;
    }

    try {
      const documents = results.map((r) => r.content ?? '');
      const reranked = await this.reranker.rerank(query, documents);

      // Reorder results based on reranker scores
      const reorderedResults = reranked.map((r) => ({
        ...results[r.index],
        score: r.relevance_score, // ← Replace vector score
      }));

      return reorderedResults;
    } catch (error) {
      console.error('[query-pipeline] Reranking failed:', error);
      return results; // Graceful fallback
    }
  }
}
```

---

### 🚀 Short-Term Improvements (P1)

#### 4. Add Query Type Routing

```typescript
// New file: apps/search-ai-runtime/src/services/query/query-router.ts

export class QueryRouter {
  constructor(
    private queryPipeline: QueryPipeline,
    private structuredQueryService: StructuredQueryService,
    private aggregationQueryService: AggregationQueryService,
  ) {}

  async route(query: SearchQueryUnion, projectKbId?: string): Promise<SearchResponse> {
    switch (query.queryType) {
      case 'vector':
        return await this.queryPipeline.execute({ ...query, queryType: 'vector' }, projectKbId);

      case 'hybrid':
        return await this.queryPipeline.execute(query, projectKbId);

      case 'structured':
        return await this.structuredQueryService.execute(
          query as StructuredSearchQuery,
          projectKbId,
        );

      case 'aggregate':
        return await this.aggregationQueryService.execute(query as AggregationQuery, projectKbId);

      default:
        // Auto-detect query type
        return await this.autoRoute(query, projectKbId);
    }
  }

  private async autoRoute(query: any, projectKbId?: string): Promise<SearchResponse> {
    // If filters only, use structured
    if (query.filters?.length > 0 && !query.query) {
      return await this.structuredQueryService.execute(
        {
          ...query,
          queryType: 'structured',
        },
        projectKbId,
      );
    }

    // If aggregation specified, use aggregation
    if (query.aggregation) {
      return await this.aggregationQueryService.execute(
        {
          ...query,
          queryType: 'aggregate',
        },
        projectKbId,
      );
    }

    // Default: hybrid search
    return await this.queryPipeline.execute(
      {
        ...query,
        queryType: 'hybrid',
      },
      projectKbId,
    );
  }
}
```

---

### 📈 Medium-Term Enhancements (P2)

#### 5. Query Preprocessing Layer

```typescript
// New file: apps/search-ai-runtime/src/services/query/query-preprocessor.ts

export class QueryPreprocessor {
  async preprocess(query: string): Promise<PreprocessedQuery> {
    return {
      original: query,
      cleaned: await this.clean(query),
      intent: await this.detectIntent(query),
      expansion: await this.expand(query),
      corrected: await this.correctSpelling(query),
    };
  }

  private async clean(query: string): Promise<string> {
    // Remove stopwords only if they don't affect meaning
    // Normalize whitespace
    // Lowercase (optional)
    return query.trim().replace(/\s+/g, ' ');
  }

  private async detectIntent(query: string): Promise<QueryIntent> {
    // Simple heuristics:
    // - Starts with "show", "list", "find" → informational
    // - Contains "how to", "what is" → educational
    // - Contains "buy", "purchase", "order" → transactional
    // - Contains specific ID/name → navigational

    if (/^(show|list|find|get|search)/i.test(query)) {
      return 'informational';
    }
    if (/how to|what is|why|when|where/i.test(query)) {
      return 'educational';
    }
    if (/buy|purchase|order|subscribe/i.test(query)) {
      return 'transactional';
    }
    return 'informational';
  }

  private async expand(query: string): Promise<string[]> {
    // Synonym expansion
    // Acronym expansion (e.g., "ML" → "machine learning")
    // Domain-specific expansions
    return [query];
  }

  private async correctSpelling(query: string): Promise<string> {
    // Use spelling correction API or library
    // Only correct if confidence is high
    return query;
  }
}

type QueryIntent = 'informational' | 'navigational' | 'transactional' | 'educational';

interface PreprocessedQuery {
  original: string;
  cleaned: string;
  intent: QueryIntent;
  expansion: string[];
  corrected: string;
}
```

---

### 🔧 Long-Term Architecture (P3)

#### 6. Adaptive Pipeline with Cost-Benefit Analysis

```typescript
// New file: apps/search-ai-runtime/src/services/query/adaptive-pipeline.ts

export class AdaptivePipeline {
  async execute(query: VectorSearchQuery, projectKbId?: string): Promise<SearchResponse> {
    // Stage 1: Analyze query complexity
    const complexity = this.analyzeComplexity(query);

    // Stage 2: Decide pipeline stages
    const stages = this.selectStages(complexity, query);

    // Stage 3: Execute selected stages
    let result = await this.executeStages(query, projectKbId, stages);

    // Stage 4: Evaluate result quality
    const quality = this.evaluateQuality(result);

    // Stage 5: Adaptive refinement
    if (quality.confidence < 0.8 && !stages.includes('rerank')) {
      result = await this.rerank(query.query, result.results);
    }

    return result;
  }

  private analyzeComplexity(query: VectorSearchQuery): QueryComplexity {
    return {
      hasFilters: (query.filters?.length ?? 0) > 0,
      queryLength: query.query.length,
      topK: query.topK ?? 10,
      needsReranking: this.shouldRerank(query),
    };
  }

  private selectStages(complexity: QueryComplexity, query: VectorSearchQuery): PipelineStage[] {
    const stages: PipelineStage[] = ['vocabulary', 'embedding', 'search'];

    // Add reranking for complex queries
    if (complexity.topK > 20 || complexity.queryLength > 100) {
      stages.push('rerank');
    }

    // Skip vocabulary for simple queries
    if (!complexity.hasFilters && complexity.queryLength < 20) {
      stages.shift(); // Remove 'vocabulary'
    }

    return stages;
  }

  private shouldRerank(query: VectorSearchQuery): boolean {
    // Cost-benefit analysis
    const benefit = query.topK > 10 ? 0.1 : 0.05; // Expected accuracy gain
    const cost = 0.002; // $0.002 per query
    const latency = 120; // 120ms

    // Rerank if benefit > cost and latency is acceptable
    return benefit > cost && query.timeout > latency;
  }
}

type PipelineStage = 'vocabulary' | 'embedding' | 'search' | 'rerank';

interface QueryComplexity {
  hasFilters: boolean;
  queryLength: number;
  topK: number;
  needsReranking: boolean;
}
```

---

## Summary of Gaps

| #   | Issue                               | Severity    | Impact                   | Fix Priority |
| --- | ----------------------------------- | ----------- | ------------------------ | ------------ |
| 1   | Vocabulary destroys query intent    | 🔴 Critical | Zero semantic search     | P0           |
| 2   | Not true hybrid search (no RRF/RSF) | 🔴 Critical | Misleading API           | P0           |
| 3   | Reranker not implemented            | 🔴 Critical | Missing accuracy boost   | P0           |
| 4   | No query type routing               | 🟡 Moderate | Inefficient processing   | P1           |
| 5   | No query preprocessing              | 🟡 Moderate | Poor query understanding | P1           |
| 6   | No adaptive pipeline                | 🟡 Moderate | Fixed cost/latency       | P2           |
| 7   | Incomplete latency tracking         | 🟢 Minor    | Limited observability    | P2           |
| 8   | No query understanding layer        | 🟡 Moderate | Can't detect intent      | P2           |
| 9   | Limited error handling              | 🟢 Minor    | Poor debuggability       | P2           |
| 10  | No result diversity                 | 🟢 Minor    | Potential duplicates     | P3           |
| 11  | No explain/debug mode               | 🟢 Minor    | Hard to debug            | P3           |

---

## Next Steps

1. **Immediate (This Week)**
   - [ ] Fix vocabulary resolution to preserve query intent (Fix 1)
   - [ ] Implement true hybrid search with RRF (Fix 2)
   - [ ] Add Cohere reranker integration (Fix 3)

2. **Short-Term (Next Sprint)**
   - [ ] Add query type routing (Fix 4)
   - [ ] Add query preprocessing layer (Fix 5)
   - [ ] Improve error handling and logging

3. **Medium-Term (Next Quarter)**
   - [ ] Implement adaptive pipeline
   - [ ] Add query understanding layer
   - [ ] Enhance observability (metrics, tracing)

4. **Long-Term (Roadmap)**
   - [ ] Result diversity (MMR)
   - [ ] Query expansion with LLM
   - [ ] Personalized ranking
   - [ ] Multi-modal search (text + images)

---

**Document Version:** 1.0
**Last Updated:** 2026-02-23
**Review Status:** Awaiting architectural approval
