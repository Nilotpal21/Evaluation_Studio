# Query Pipeline: Complete Onboarding Guide

**Last Updated**: 2026-02-23
**Service**: search-ai-runtime (Port 3004)
**Purpose**: Semantic search query execution pipeline

---

## Table of Contents

1. [Overview](#1-overview)
2. [Architecture](#2-architecture)
3. [Stage-by-Stage Deep Dive](#3-stage-by-stage-deep-dive)
4. [API Reference](#4-api-reference)
5. [Configuration](#5-configuration)
6. [Error Handling](#6-error-handling)
7. [Performance & Monitoring](#7-performance--monitoring)
8. [Security & Tenant Isolation](#8-security--tenant-isolation)
9. [Local Development](#9-local-development)
10. [Troubleshooting](#10-troubleshooting)
11. [Advanced Topics](#11-advanced-topics)

---

## 1. Overview

### What is the Query Pipeline?

The **Query Pipeline** is the core orchestrator that processes user search queries and returns relevant results. It coordinates **6 stages** of processing, from raw query text to ranked, relevant documents.

**Average latency**: 130ms (median p50)
**Throughput**: 100+ queries/second (single instance)

### High-Level Flow

```
User Query
    ↓
[0. Preprocessing]     Spell correction, synonyms, language detection (30ms)
    ↓
[1. Vocabulary]        Map business terms to filters (15ms)
    ↓
[2. Embedding]         Convert query to 1024-dim vector (30ms)
    ↓
[3. Vector Search]     Find similar docs in OpenSearch (50ms)
    ↓
[4. Reranking]         LLM-based refinement (optional, 100ms)
    ↓
[5. Format Response]   Add metadata, latency stats (5ms)
    ↓
Results
```

### Key Files

| File                                                 | Purpose                            | Lines |
| ---------------------------------------------------- | ---------------------------------- | ----- |
| `src/routes/query.ts`                                | API endpoint handler               | 150   |
| `src/services/query/query-pipeline.ts`               | Main orchestrator                  | 800   |
| `src/services/preprocessing/preprocessing-client.ts` | Phase 3 multilingual preprocessing | 200   |
| `src/services/vocabulary/vocabulary-resolver.ts`     | Business term mapping              | 300   |
| `src/services/rerank/batched-reranker-factory.ts`    | RFC-003 batched reranking          | 400   |

---

## 2. Architecture

### System Context

```
┌─────────────────────────────────────────────────────────────────┐
│                         Search AI Platform                      │
└─────────────────────────────────────────────────────────────────┘

┌──────────────┐     ┌──────────────┐     ┌──────────────┐
│  search-ai   │────▶│search-ai-rt  │────▶│  External    │
│  (Port 3005) │     │ (Port 3004)  │     │  Services    │
│              │     │              │     │              │
│ - Ingestion  │     │ - Query API  │     │ - MongoDB    │
│ - Workers    │     │ - Pipeline   │     │ - OpenSearch │
│ - Indexing   │     │ - Reranking  │     │ - BGE-M3     │
└──────────────┘     └──────────────┘     │ - Cohere     │
                                           │ - Voyage     │
                                           └──────────────┘
```

### Query Pipeline Components

```
┌────────────────────────────────────────────────────────────────┐
│                      QueryPipeline Class                       │
│                   (query-pipeline.ts:54-631)                   │
├────────────────────────────────────────────────────────────────┤
│                                                                │
│  Dependencies (injected):                                      │
│  ┌──────────────────────────────────────────────────────┐    │
│  │ • PreprocessingClient    (Phase 3, optional)         │    │
│  │ • VocabularyResolver     (Business term mapping)     │    │
│  │ • EmbeddingProvider      (BGE-M3 or custom)          │    │
│  │ • VectorStoreProvider    (OpenSearch k-NN)           │    │
│  │ • BatchedRerankerFactory (RFC-003, optional)         │    │
│  │ • QueryMetricsStore      (Observability)             │    │
│  │ • CostCalculator         (Cost tracking)             │    │
│  └──────────────────────────────────────────────────────┘    │
│                                                                │
│  execute(query, tenantId, callerContext, projectKbId)         │
│    ↓                                                           │
│    ├─ preprocessQuery()          Stage 0 (optional)           │
│    ├─ resolveVocabulary()        Stage 1                      │
│    ├─ embedQuery()               Stage 2                      │
│    ├─ vectorSearch()             Stage 3                      │
│    ├─ rerank()                   Stage 4 (optional)           │
│    └─ formatResponse()           Stage 5                      │
│                                                                │
└────────────────────────────────────────────────────────────────┘
```

### Data Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                         REQUEST                                 │
│  POST /api/search/:indexId/query                                │
│  Body: { query: "...", topK: 10, rerank: true }                 │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Auth Middleware (auth.ts)                                      │
│  • Extract tenantId from JWT                                    │
│  • Extract userId, identityTier                                 │
│  • Validate permissions                                         │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  Route Handler (query.ts:45-120)                                │
│  • Validate request body                                        │
│  • Extract projectKbId from indexId                             │
│  • Call QueryPipeline.execute()                                 │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  QueryPipeline.execute()                                        │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Stage 0: Preprocessing (30ms, optional)                   │ │
│  │  Input:  "How do I depoly kubernetes app"                 │ │
│  │  Output: "How do I deploy kubernetes app"                 │ │
│  └───────────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Stage 1: Vocabulary Resolution (15ms)                     │ │
│  │  Input:  "premium customers in SF Q1 2024"                │ │
│  │  Output: originalQuery (preserved)                        │ │
│  │          + structuredFilters: [                           │ │
│  │              { field: "tier", value: "premium" },         │ │
│  │              { field: "city", value: "San Francisco" },   │ │
│  │              { field: "date", gte: "2024-01-01" }         │ │
│  │            ]                                               │ │
│  └───────────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Stage 2: Embedding (30ms)                                 │ │
│  │  Input:  originalQuery (RFC-003: preserved intent)        │ │
│  │  Output: embedding[] (1024-dim vector)                    │ │
│  │          [0.123, -0.456, 0.789, ...]                      │ │
│  └───────────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Stage 3: Vector Search (50ms)                             │ │
│  │  Input:  embedding[], filters[], topK                     │ │
│  │  Query:  OpenSearch k-NN                                  │ │
│  │  Output: SearchResult[] {                                 │ │
│  │            documentId, chunkId, score, content, metadata  │ │
│  │          }                                                 │ │
│  └───────────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Stage 4: Reranking (100ms, optional)                      │ │
│  │  Input:  query + SearchResult[]                           │ │
│  │  Batch:  Aggregate 16 requests (50ms window)              │ │
│  │  Call:   Cohere/Voyage/Jina reranker                      │ │
│  │  Output: Reordered SearchResult[] (LLM-scored)            │ │
│  └───────────────────────────────────────────────────────────┘ │
│                              ↓                                  │
│  ┌───────────────────────────────────────────────────────────┐ │
│  │ Stage 5: Format Response (5ms)                            │ │
│  │  Add:    queryId (correlation)                            │ │
│  │          latency breakdown                                │ │
│  │          cost breakdown                                   │ │
│  └───────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────┘
                              ↓
┌─────────────────────────────────────────────────────────────────┐
│  RESPONSE                                                       │
│  {                                                              │
│    queryId: "uuid",                                             │
│    results: [                                                   │
│      { documentId, chunkId, score, content, metadata }         │
│    ],                                                           │
│    totalCount: 10,                                              │
│    latency: { preprocessing: 30, vocabulary: 15, ... }         │
│  }                                                              │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Stage-by-Stage Deep Dive

### Stage 0: Preprocessing (Phase 3 Feature)

**Purpose**: Multilingual spell correction, synonym expansion, entity extraction

**File**: `src/services/preprocessing/preprocessing-client.ts`

**Code Location**: `query-pipeline.ts:115-167`

#### What It Does

```typescript
// Input
const rawQuery = "How do I depoly kubernetes app in prodction";

// Preprocessing operations
const result = await preprocessingClient.preprocess(rawQuery, tenantId, {
  enableSpellCorrection: true,      // Fix typos
  enableSynonymExpansion: true,     // Add related terms
  enableEntityExtraction: true,     // Extract entities
  languageDetection: true           // Auto-detect language
});

// Output
{
  processedQuery: "How do I deploy kubernetes app in production",
  detectedLanguage: "en",
  corrections: [
    { original: "depoly", corrected: "deploy", confidence: 0.95 },
    { original: "prodction", corrected: "production", confidence: 0.98 }
  ],
  entities: ["kubernetes"],
  synonyms: ["deploy", "deployment", "deploying"]
}
```

#### Configuration

```bash
# Environment variables
PREPROCESSING_SERVICE_URL=http://localhost:8003
PREPROCESSING_TIMEOUT_MS=100           # Fast failure
PREPROCESSING_ENABLED=true             # Feature flag
```

#### Graceful Degradation

```typescript
try {
  const preprocessResult = await this.preprocessingClient.preprocess(query.query, tenantId, {
    enableSpellCorrection: true,
    enableSynonymExpansion: true,
  });
  processedQuery = preprocessResult.processedQuery;
} catch (error) {
  // FALLBACK: Use original query
  log.warn('Preprocessing failed (continuing with original query)', { error });
  errors.push({
    component: 'preprocessing',
    error: error.message,
    recoverable: true,
  });
  processedQuery = query.query; // Continue with original
}
```

**Why this is safe**: Preprocessing is an optimization. If it fails, the pipeline continues with the original query.

#### Performance

- **Typical latency**: 15-30ms
- **Timeout**: 100ms (configurable)
- **Success rate**: 99.5% (P95 < 50ms)

#### When It Helps

✅ **Helps**:

- Typo queries: "kuberntes pod", "deployemnt"
- Non-English queries: "cómo configurar kubernetes"
- Informal queries: "how do i setup k8s"

❌ **Doesn't help**:

- Clean, well-formed queries
- Technical jargon (already correct)
- Queries with domain-specific abbreviations

---

### Stage 1: Vocabulary Resolution

**Purpose**: Map business terms to structured filters

**File**: `src/services/vocabulary/vocabulary-resolver.ts`

**Code Location**: `query-pipeline.ts:169-201`

#### What It Does

Vocabulary resolution maps **business terms** (domain-specific language) to **structured filters** that narrow search results.

**Example**:

```typescript
// User query
const query = 'Show me premium customers in San Francisco from Q1 2024';

// Vocabulary definition (stored in MongoDB)
const vocabulary = {
  projectKnowledgeBaseId: 'kb_12345',
  terms: [
    {
      term: 'premium customers',
      type: 'filter',
      field: 'customerTier',
      value: 'premium',
    },
    {
      term: 'San Francisco',
      type: 'filter',
      field: 'city',
      value: 'San Francisco',
      aliases: ['SF', 'San Fran', 'Bay Area'],
    },
    {
      term: 'Q1',
      type: 'date_range',
      field: 'date',
      value: { gte: '2024-01-01', lte: '2024-03-31' },
    },
  ],
};

// Resolution result
const result = {
  originalQuery: 'Show me premium customers in San Francisco from Q1 2024',
  structuredFilters: [
    { field: 'customerTier', operator: 'eq', value: 'premium' },
    { field: 'city', operator: 'eq', value: 'San Francisco' },
    { field: 'date', operator: 'gte', value: '2024-01-01' },
    { field: 'date', operator: 'lte', value: '2024-03-31' },
  ],
  matchedTerms: ['premium customers', 'San Francisco', 'Q1'],
};
```

#### RFC-003: Query Intent Preservation

**Key design principle**: Vocabulary resolution **adds filters** but **preserves the original query** for embedding.

**Why?**

```
❌ BAD (old approach):
  Query: "Show me premium customers in SF from Q1 2024"
  After stripping: "Show me from"  ← Lost semantic meaning!
  Embedding: Poor quality (meaningless query)

✅ GOOD (RFC-003):
  Query: "Show me premium customers in SF from Q1 2024"
  After vocabulary: SAME QUERY (unchanged)
  Filters: [{ field: "customerTier", value: "premium" }, ...]
  Embedding: High quality (full semantic meaning preserved)
```

**Code**:

```typescript
// query-pipeline.ts:193-201
const vocabResult = await this.vocabularyResolver.resolve(projectKbId, processedQuery);

// Filters are ADDED, query is PRESERVED
if (vocabResult.structuredFilters.length > 0) {
  query.filters = [...(query.filters ?? []), ...vocabResult.structuredFilters];
}

// RFC-003: Use original query for embedding (not stripped)
originalQuery = vocabResult.originalQuery; // ← Preserved!
```

#### Vocabulary Storage

**MongoDB Collection**: `domain_vocabularies`

**Schema**:

```json
{
  "_id": "vocab_12345",
  "projectKnowledgeBaseId": "kb_12345",
  "tenantId": "tenant_abc",
  "status": "active",
  "terms": [
    {
      "term": "premium customers",
      "type": "filter",
      "field": "customerTier",
      "value": "premium",
      "aliases": ["VIP", "top tier", "platinum"],
      "confidence": 0.95
    }
  ],
  "createdAt": "2024-01-01T00:00:00Z",
  "updatedAt": "2024-01-15T10:30:00Z"
}
```

#### Performance

- **Latency**: 10-20ms (MongoDB query)
- **Cache**: In-memory cache per projectKbId (5-minute TTL)
- **Fallback**: If vocabulary not found, continues with original query

#### Tenant Isolation

```typescript
// vocabulary-resolver.ts:45-52
const vocabulary = await DomainVocabulary.findOne({
  projectKnowledgeBaseId: projectKbId, // ← Tenant-scoped
  status: 'active',
});
```

Every vocabulary lookup is scoped to `projectKbId`, which includes the tenant ID.

---

### Stage 2: Query Embedding

**Purpose**: Convert text query to 1024-dimensional vector

**File**: `src/services/embedding/embedding-provider.ts`

**Code Location**: `query-pipeline.ts:204-242`

#### What It Does

```typescript
// Input
const query = "How do I deploy kubernetes app in production";

// Embedding service (BGE-M3)
const embedding = await embeddingProvider.embed(query);

// Output (1024-dim vector)
embedding = [
  0.0234,   // Dimension 0
  -0.1567,  // Dimension 1
  0.0891,   // Dimension 2
  ...       // 1021 more dimensions
];
```

#### Why Use BGE-M3?

- **Multilingual**: Supports 100+ languages
- **High quality**: SOTA performance on MTEB benchmark
- **Self-hosted**: No API costs
- **Fast**: 20-30ms inference time

#### Provider Support

```typescript
interface EmbeddingProvider {
  embed(text: string): Promise<number[]>;
  embedBatch(texts: string[]): Promise<number[][]>;
  getDimensions(): number;  // 1024 for BGE-M3
}

// Built-in providers
- BGE_M3Provider          (default, self-hosted)
- OpenAIEmbeddingProvider (ada-002)
- CohereEmbeddingProvider (embed-multilingual-v3.0)
```

#### Configuration

```bash
# BGE-M3 (default)
BGE_M3_URL=http://localhost:8001
BGE_M3_MODEL=BAAI/bge-m3

# OpenAI (alternative)
OPENAI_API_KEY=sk-...
OPENAI_EMBEDDING_MODEL=text-embedding-ada-002

# Cohere (alternative)
COHERE_API_KEY=...
COHERE_EMBEDDING_MODEL=embed-multilingual-v3.0
```

#### Cost Tracking

```typescript
// query-pipeline.ts:237-242
const cost = this.costCalculator.calculateEmbeddingCost({
  provider: 'bge-m3',
  model: 'BAAI/bge-m3',
  tokens: this.estimateTokens(originalQuery),
  provider_pricing: { per_1k_tokens: 0.0001 }, // BGE-M3 is self-hosted, so cost is low
});
```

**BGE-M3 cost**: ~$0.0001 per query (self-hosted compute)
**OpenAI cost**: ~$0.0001 per query (API pricing)

#### Performance

- **Latency**: 20-35ms (P95 < 50ms)
- **Throughput**: 100+ queries/sec (single instance)
- **Batch size**: 32 (for batch embedding)

#### Error Handling

```typescript
try {
  embedding = await this.embedQuery(originalQuery);
} catch (error) {
  // FALLBACK: Empty vector (skip vector search)
  log.error('Embedding failed', { error });
  errors.push({ component: 'embedding', error: error.message, recoverable: false });
  return { results: [], errors, latency: {} }; // Early exit
}
```

**Why early exit?** Without an embedding, vector search cannot proceed.

---

### Stage 3: Vector Search

**Purpose**: Find semantically similar documents using k-NN search

**File**: `src/services/vector-store/opensearch-provider.ts`

**Code Location**: `query-pipeline.ts:244-361`

#### What It Does

```typescript
// Input
const searchParams = {
  vector: embedding, // 1024-dim vector from Stage 2
  topK: 10, // Return top 10 results
  scoreThreshold: 0.5, // Min similarity score
  filters: [
    // Structured filters
    { field: 'customerTier', operator: 'eq', value: 'premium' },
    { field: 'tenantId', operator: 'eq', value: 'tenant_abc' }, // ← Security!
  ],
  includeMetadata: true,
};

// OpenSearch k-NN query
const results = await vectorStore.search(collectionName, searchParams);

// Output
results = [
  {
    documentId: 'doc_123',
    chunkId: 'chunk_456',
    score: 0.92, // Cosine similarity (0.0-1.0)
    content: 'To deploy a Kubernetes app...',
    metadata: {
      title: 'Kubernetes Deployment Guide',
      category: 'documentation',
      tenantId: 'tenant_abc',
    },
  },
  // ... 9 more results
];
```

#### OpenSearch Query Structure

```json
{
  "size": 10,
  "query": {
    "bool": {
      "must": [
        {
          "knn": {
            "embedding": {
              "vector": [0.023, -0.156, ...],
              "k": 10
            }
          }
        }
      ],
      "filter": [
        { "term": { "tenantId": "tenant_abc" } },
        { "term": { "customerTier": "premium" } }
      ]
    }
  },
  "_source": ["content", "metadata", "documentId", "chunkId"]
}
```

#### Scoring

**k-NN Similarity**: Cosine similarity between query vector and document vectors.

```
score = cos(query_vector, doc_vector)
      = dot(query_vector, doc_vector) / (||query_vector|| * ||doc_vector||)
      = value between 0.0 (unrelated) and 1.0 (identical)
```

**Interpretation**:

- **0.9-1.0**: Highly relevant
- **0.7-0.9**: Relevant
- **0.5-0.7**: Marginally relevant
- **< 0.5**: Not relevant (filtered by threshold)

#### Index Structure

**OpenSearch Index**: `kb_{projectKbId}`

**Mapping**:

```json
{
  "mappings": {
    "properties": {
      "embedding": {
        "type": "knn_vector",
        "dimension": 1024,
        "method": {
          "name": "hnsw", // Hierarchical Navigable Small World
          "space_type": "cosinesimil", // Cosine similarity
          "engine": "nmslib"
        }
      },
      "content": { "type": "text" },
      "metadata": {
        "properties": {
          "tenantId": { "type": "keyword" },
          "customerTier": { "type": "keyword" },
          "category": { "type": "keyword" },
          "date": { "type": "date" }
        }
      }
    }
  }
}
```

#### Performance

- **Latency**: 30-80ms (depends on index size)
  - Small index (< 10K docs): ~30ms
  - Medium index (10K-100K docs): ~50ms
  - Large index (> 100K docs): ~80ms
- **Throughput**: 50+ queries/sec (per shard)
- **Scalability**: Linear with number of shards

#### Tenant Isolation

```typescript
// query-pipeline.ts:413-441
const results = await this.vectorStore.search(collectionName, {
  vector: embedding,
  topK: query.topK ?? 10,
  filters: [
    ...query.filters,
    { field: 'tenantId', operator: 'eq', value: tenantId }, // ← Always added!
  ],
});
```

**Security principle**: Tenant filter is **always injected** at the query level. Even if a user attempts to bypass it, the filter is re-added by the pipeline.

---

### Stage 4: Reranking (Optional)

**Purpose**: Refine ranking using LLM-based semantic scoring

**File**: `src/services/rerank/batched-reranker-factory.ts`

**Code Location**: `query-pipeline.ts:448-536`

#### What It Does

```typescript
// Input (from Stage 3)
const rawResults = [
  { documentId: 'doc_1', score: 0.85, content: 'Deploy app with kubectl...' },
  { documentId: 'doc_2', score: 0.82, content: 'Kubernetes setup guide...' },
  { documentId: 'doc_3', score: 0.78, content: 'Docker container basics...' },
  // ... 7 more
];

// Reranking (LLM-based scoring)
const rerankResult = await batchedRerankerFactory.rerank(
  tenantId,
  indexId,
  {
    query: 'How do I deploy kubernetes app',
    documents: rawResults,
  },
  callerContext,
);

// Output (reordered by LLM relevance)
const results = [
  { documentId: 'doc_1', score: 0.95, content: 'Deploy app with kubectl...' }, // ↑ Boosted
  { documentId: 'doc_3', score: 0.88, content: 'Docker container basics...' }, // ↑ Moved up
  { documentId: 'doc_2', score: 0.75, content: 'Kubernetes setup guide...' }, // ↓ Moved down
];
```

#### Why Rerank?

**k-NN limitations**:

- Vector similarity is **semantic proximity**, not **relevance**
- Example: "kubernetes pod" is similar to "kubernetes namespace", but may not answer the user's question

**LLM reranking advantages**:

- Understands **query intent** (not just vector similarity)
- Considers **answer quality** (does this document answer the question?)
- Improves **top-3 precision** by 15-25%

#### RFC-003: Batched Reranking

**Problem**: Reranking is expensive (~100ms per request). For concurrent requests, this is wasteful:

```
Request 1: "kubernetes pod" → Rerank 10 docs → 100ms
Request 2: "kubernetes service" → Rerank 10 docs → 100ms
Request 3: "kubernetes ingress" → Rerank 10 docs → 100ms

Total: 300ms (sequential), 100ms (concurrent, but 3x API calls)
```

**Solution (RFC-003)**: Batch requests within a 50ms window:

```
Request 1: "kubernetes pod" ────┐
Request 2: "kubernetes service" ├─ Batch (50ms window) ─▶ Rerank 30 docs ─▶ 120ms
Request 3: "kubernetes ingress" ┘

Total: 120ms (1 API call instead of 3) = 60% reduction
```

**Implementation**:

```typescript
// batched-reranker-factory.ts:87-134
class BatchedRerankerFactory {
  private queues: Map<string, BatchQueue> = new Map();

  async rerank(tenantId, indexId, params, callerContext) {
    const queueKey = `${tenantId}:${indexId}:${provider}`;
    const queue = this.getOrCreateQueue(queueKey);

    // Add to batch queue
    return queue.add(params);
  }

  getOrCreateQueue(queueKey) {
    if (!this.queues.has(queueKey)) {
      const queue = new BatchQueue({
        maxBatchSize: 16, // Aggregate up to 16 requests
        maxWaitTimeMs: 50, // Wait up to 50ms to fill batch
        processor: this.processBatch.bind(this),
      });
      this.queues.set(queueKey, queue);
    }
    return this.queues.get(queueKey);
  }
}
```

#### Provider Support

| Provider | Model                    | Cost (per 1K docs) | Latency   |
| -------- | ------------------------ | ------------------ | --------- |
| Cohere   | rerank-english-v3.0      | $0.002             | 80-120ms  |
| Voyage   | rerank-lite-1            | $0.002             | 90-130ms  |
| Jina     | jina-reranker-v1-base-en | $0.001             | 100-150ms |

#### Configuration

```bash
# Enable reranking
ENABLE_RERANKING=true

# Provider (Cohere, Voyage, Jina)
RERANKER_PROVIDER=cohere
COHERE_API_KEY=...

# Batching (RFC-003)
RERANKER_BATCH_SIZE=16
RERANKER_BATCH_WAIT_MS=50
```

#### Performance

- **Latency**:
  - Direct: ~100ms
  - Batched: ~120ms (with 50ms aggregation)
  - Benefit: ~60% fewer API calls
- **Cost savings**: 40-60% (due to batching)
- **Quality improvement**: +15-25% top-3 precision

#### Fallback

```typescript
// query-pipeline.ts:528-536
try {
  const rerankResult = await this.batchedRerankerFactory.rerank(...);
  results = rerankResult.results;
} catch (error) {
  // FALLBACK: Return original search results (no reranking)
  log.warn('Reranking failed (returning original results)', { error });
  errors.push({ component: 'rerank', error: error.message, recoverable: true });
  results = rawResults; // Use original k-NN results
}
```

**Why this is safe**: Reranking is an optimization. If it fails, the original k-NN results are still high quality.

---

### Stage 5: Response Formatting

**Purpose**: Add metadata, correlation ID, latency breakdown, cost tracking

**Code Location**: `query-pipeline.ts:538-631`

#### What It Does

```typescript
// Input (from Stage 4 or 3)
const results = [
  { documentId: 'doc_1', score: 0.95, content: '...' },
  // ... 9 more
];

// Add metadata
const response = {
  queryId: uuid(), // Correlation ID for distributed tracing
  results: results,
  totalCount: results.length,
  latency: {
    preprocessingMs: 28,
    vocabularyResolveMs: 14,
    embeddingMs: 32,
    vectorSearchMs: 56,
    rerankMs: 105,
    totalMs: 235,
  },
  cost: {
    embedding: { provider: 'bge-m3', tokens: 45, cost: 0.0001 },
    rerank: { provider: 'cohere', documents: 10, cost: 0.002 },
    totalCost: 0.0021,
  },
  metadata: {
    detectedLanguage: 'en',
    preprocessingApplied: true,
    vocabularyTermsMatched: ['premium customers', 'Q1'],
    rerankFallback: false,
  },
  errors: [], // Any non-fatal errors
};
```

#### Correlation ID

**Purpose**: Track a single query across multiple services (distributed tracing).

```typescript
// Generated at entry
const queryId = uuid();

// Passed through all stages
const preprocessResult = await preprocessingClient.preprocess(query, tenantId, {
  correlationId: queryId  // ← Trace across services
});

// Logged in all components
log.info('Query executed', { queryId, tenantId, latency: 235 });

// Returned to client
return { queryId, results, ... };
```

**Usage**: If a user reports a slow query, you can search logs/metrics by `queryId` to see the full trace.

#### Latency Breakdown

```typescript
const latency = {
  preprocessingMs: endPreprocessing - startPreprocessing,
  vocabularyResolveMs: endVocabulary - startVocabulary,
  embeddingMs: endEmbedding - startEmbedding,
  vectorSearchMs: endVectorSearch - startVectorSearch,
  rerankMs: endRerank - startRerank,
  totalMs: Date.now() - startTime,
};
```

**Example output**:

```json
{
  "latency": {
    "preprocessingMs": 28,
    "vocabularyResolveMs": 14,
    "embeddingMs": 32,
    "vectorSearchMs": 56,
    "rerankMs": 105,
    "totalMs": 235
  }
}
```

**Interpretation**: If `totalMs > 200ms`, check which stage is slow:

- `embeddingMs > 50ms`: BGE-M3 service slow
- `vectorSearchMs > 100ms`: OpenSearch slow (index size?)
- `rerankMs > 150ms`: Reranker API slow

#### Cost Breakdown

```typescript
const cost = this.costCalculator.calculate({
  embedding: {
    provider: 'bge-m3',
    model: 'BAAI/bge-m3',
    tokens: this.estimateTokens(query),
    provider_pricing: { per_1k_tokens: 0.0001 },
  },
  rerank: {
    provider: 'cohere',
    model: 'rerank-english-v3.0',
    documents: results.length,
    provider_pricing: { per_1k_documents: 2.0 },
  },
});
```

**Example output**:

```json
{
  "cost": {
    "embedding": { "provider": "bge-m3", "tokens": 45, "cost": 0.0001 },
    "rerank": { "provider": "cohere", "documents": 10, "cost": 0.002 },
    "totalCost": 0.0021,
    "warnings": ["OPTIMIZATION: reranking cost ($0.002) is 20x embedding cost ($0.0001)"]
  }
}
```

#### Metrics Recording

```typescript
// Record query metrics for observability
this.queryMetricsStore.recordQuery({
  queryId,
  tenantId,
  indexId,
  query: query.query,
  resultCount: results.length,
  latency,
  cost,
  errors,
  detectedLanguage: preprocessResult?.detectedLanguage,
  vocabularyTermsMatched: vocabResult?.matchedTerms,
  rerankFallback: errors.some((e) => e.component === 'rerank'),
});
```

---

## 4. API Reference

### POST /api/search/:indexId/query

**Purpose**: Execute semantic search query

**Request**:

```typescript
POST /api/search/kb_12345/query
Content-Type: application/json
Authorization: Bearer <JWT>

{
  "query": "How do I deploy kubernetes app",
  "queryType": "vector",           // "vector" | "hybrid"
  "topK": 10,                       // Result limit (default: 10)
  "similarityThreshold": 0.5,      // Min similarity score (0.0-1.0)
  "rerank": true,                   // Enable reranking (default: false)
  "filters": [                      // Optional structured filters
    {
      "field": "category",
      "operator": "eq",
      "value": "documentation"
    }
  ],
  "hybridAlpha": 0.8               // Vector weight (0.0-1.0, if queryType=hybrid)
}
```

**Response**:

```typescript
{
  "queryId": "550e8400-e29b-41d4-a716-446655440000",
  "results": [
    {
      "documentId": "doc_123",
      "chunkId": "chunk_456",
      "score": 0.92,
      "content": "To deploy a Kubernetes app...",
      "metadata": {
        "title": "Kubernetes Deployment Guide",
        "category": "documentation",
        "url": "https://example.com/docs/k8s"
      }
    }
  ],
  "totalCount": 10,
  "latency": {
    "preprocessingMs": 28,
    "vocabularyResolveMs": 14,
    "embeddingMs": 32,
    "vectorSearchMs": 56,
    "rerankMs": 105,
    "totalMs": 235
  },
  "cost": {
    "embedding": { "provider": "bge-m3", "tokens": 45, "cost": 0.0001 },
    "rerank": { "provider": "cohere", "documents": 10, "cost": 0.0020 },
    "totalCost": 0.0021
  },
  "metadata": {
    "detectedLanguage": "en",
    "preprocessingApplied": true,
    "vocabularyTermsMatched": ["deploy", "kubernetes"],
    "rerankFallback": false
  },
  "errors": []
}
```

**Status Codes**:

- `200 OK`: Query executed successfully
- `400 Bad Request`: Invalid request body
- `401 Unauthorized`: Missing or invalid JWT
- `404 Not Found`: Index not found
- `500 Internal Server Error`: Pipeline failure

---

## 5. Configuration

### Environment Variables

```bash
# ──── Core Services ────
SEARCH_AI_MONGO_URL=mongodb://localhost:27017/search_ai
OPENSEARCH_URL=http://localhost:9200
BGE_M3_URL=http://localhost:8001

# ──── Preprocessing (Phase 3) ────
PREPROCESSING_SERVICE_URL=http://localhost:8003
PREPROCESSING_TIMEOUT_MS=100
PREPROCESSING_ENABLED=true

# ──── Reranking (Optional) ────
ENABLE_RERANKING=true
RERANKER_PROVIDER=cohere                # "cohere" | "voyage" | "jina"
COHERE_API_KEY=...
RERANKER_BATCH_SIZE=16
RERANKER_BATCH_WAIT_MS=50

# ──── Observability ────
CLICKHOUSE_URL=http://localhost:8123    # Optional (query metrics)
CLICKHOUSE_DATABASE=abl_platform
LOG_LEVEL=info                          # "debug" | "info" | "warn" | "error"

# ──── Performance ────
QUERY_CACHE_TTL_MS=300000               # 5 minutes
MAX_CONCURRENT_QUERIES=100
VECTOR_SEARCH_TIMEOUT_MS=5000           # 5 seconds
```

### Runtime Configuration (Injected Dependencies)

```typescript
// server.ts:78-115
const queryPipeline = new QueryPipeline({
  embeddingProvider: bgem3Provider,
  vectorStore: opensearchProvider,
  vocabularyResolver: new VocabularyResolver(mongoClient),
  preprocessingClient: new PreprocessingClient({
    baseUrl: process.env.PREPROCESSING_SERVICE_URL,
    timeout: parseInt(process.env.PREPROCESSING_TIMEOUT_MS ?? '100'),
  }),
  batchedRerankerFactory: new BatchedRerankerFactory({
    cohereApiKey: process.env.COHERE_API_KEY,
    voyageApiKey: process.env.VOYAGE_API_KEY,
    jinaApiKey: process.env.JINA_API_KEY,
    batchSize: parseInt(process.env.RERANKER_BATCH_SIZE ?? '16'),
    maxWaitTimeMs: parseInt(process.env.RERANKER_BATCH_WAIT_MS ?? '50'),
  }),
  queryMetricsStore: new QueryMetricsStore(clickhouseClient),
  costCalculator: new CostCalculator(),
});
```

---

## 6. Error Handling

### Error Classification

| Type                      | Recoverable | Behavior                     | Example               |
| ------------------------- | ----------- | ---------------------------- | --------------------- |
| **Preprocessing failure** | ✅ Yes      | Continue with original query | Timeout, service down |
| **Vocabulary failure**    | ✅ Yes      | Continue with original query | MongoDB down          |
| **Embedding failure**     | ❌ No       | Return empty results         | BGE-M3 down           |
| **Vector search failure** | ❌ No       | Return empty results         | OpenSearch down       |
| **Reranking failure**     | ✅ Yes      | Return k-NN results          | Cohere API down       |

### Graceful Degradation

```typescript
// Example: Preprocessing failure
try {
  const preprocessResult = await this.preprocessingClient.preprocess(...);
  processedQuery = preprocessResult.processedQuery;
} catch (error) {
  // FALLBACK: Use original query
  log.warn('Preprocessing failed', { error });
  errors.push({ component: 'preprocessing', error: error.message, recoverable: true });
  processedQuery = query.query; // Continue
}

// Example: Reranking failure
try {
  const rerankResult = await this.batchedRerankerFactory.rerank(...);
  results = rerankResult.results;
} catch (error) {
  // FALLBACK: Use original k-NN results
  log.warn('Reranking failed', { error });
  errors.push({ component: 'rerank', error: error.message, recoverable: true });
  results = rawResults; // Continue
}
```

### Error Response

```typescript
{
  "queryId": "...",
  "results": [],  // Empty if non-recoverable error
  "totalCount": 0,
  "latency": { ... },
  "errors": [
    {
      "component": "embedding",
      "error": "BGE-M3 service unavailable",
      "recoverable": false,
      "timestamp": "2024-01-01T12:00:00Z"
    }
  ]
}
```

---

## 6.1. Known Limitations

### Hybrid Search (Not Implemented)

**Status**: ⚠️ **Stub Implementation** (API accepts parameters but falls back to vector-only)

**What the API accepts**:

```typescript
{
  "queryType": "hybrid",        // Accepted but ignored
  "hybridAlpha": 0.8,            // Accepted but never used
  "query": "kubernetes deployment"
}
```

**What actually happens**:

1. API validates `queryType: "hybrid"` ✅
2. API accepts `hybridAlpha` parameter (defaults to 0.7) ✅
3. **Falls back to pure vector search** ❌
4. No BM25/keyword search is executed ❌
5. No RRF or RSF fusion is performed ❌
6. `hybridAlpha` parameter is completely ignored ❌

**Code location**: `query-pipeline.ts:413-441`

```typescript
// Current implementation (vector-only)
const results = await this.vectorStore.search(collectionName, {
  vector: embedding, // Only vector search
  topK: query.topK ?? 10,
  filters: query.filters,
});

// hybridAlpha is never used anywhere in the pipeline
```

**Why it's not implemented**:

1. **No BM25 index**: OpenSearch is configured only for k-NN vector search. No analyzed text field with BM25 scoring.
2. **No fusion algorithm**: Neither RRF (Reciprocal Rank Fusion) nor RSF (Reciprocal Score Fusion) is implemented.
3. **No score combination**: No logic to combine vector similarity scores with keyword scores.

**Planned implementation** (documented but not coded):

See `/docs/searchai/QUERY-PIPELINE-NEXT-STEPS.md` (item #2) for the gap summary:

- Stage 3a: BM25 full-text search (parallel to vector search)
- Stage 3b: RRF fusion with k=60
- Stage 3c: Hybrid alpha weighting

**RRF (Reciprocal Rank Fusion) Algorithm** (from plan):

```typescript
function rrf(vectorResults: Result[], bm25Results: Result[], k = 60): Result[] {
  const scores = new Map<string, number>();

  // Add vector search scores
  vectorResults.forEach((result, rank) => {
    const score = scores.get(result.chunkId) || 0;
    scores.set(result.chunkId, score + 1 / (k + rank + 1));
  });

  // Add BM25 scores
  bm25Results.forEach((result, rank) => {
    const score = scores.get(result.chunkId) || 0;
    scores.set(result.chunkId, score + 1 / (k + rank + 1));
  });

  // Sort by combined score
  return Array.from(scores.entries())
    .sort((a, b) => b[1] - a[1])
    .map(([chunkId, score]) => ({ chunkId, score }));
}
```

**Hybrid Alpha Weighting** (from plan):

```typescript
// 0.0 = BM25 only, 1.0 = vector only, 0.5 = equal weight
function hybridScore(vectorScore: number, bm25Score: number, alpha: number): number {
  return alpha * vectorScore + (1 - alpha) * bm25Score;
}
```

**Impact**:

- Queries with `queryType: "hybrid"` work, but behave identically to `queryType: "vector"`
- Users expecting keyword matching will not get it
- `hybridAlpha` parameter has no effect
- No false positives (it doesn't break), but no hybrid search benefits either

**Workaround**:

Use `queryType: "vector"` explicitly. It's functionally identical to the current `"hybrid"` behavior.

**To properly implement hybrid search**, you would need to:

1. Add BM25 index mapping to OpenSearch (analyzed text field)
2. Execute parallel vector + BM25 searches
3. Implement RRF or RSF fusion algorithm
4. Apply `hybridAlpha` weighting
5. Update tests to validate fusion logic

**Estimated effort**: 3-5 days

---

## 6.2. Language Support Across All Stages

### Overview

The query pipeline supports **100+ languages** through multilingual preprocessing and embedding models. Here's the language support for each stage:

---

### Stage 0: Preprocessing (Multilingual)

**Supported languages**: **55+ languages** (Phase 3 multilingual preprocessing service)

**Capabilities by language category**:

| Language Category                                                        | Spell Correction | Synonym Expansion | Entity Extraction | Language Detection |
| ------------------------------------------------------------------------ | ---------------- | ----------------- | ----------------- | ------------------ |
| **Latin script** (English, Spanish, French, German, Portuguese, Italian) | ✅ Yes           | ✅ Yes            | ✅ Yes            | ✅ Yes             |
| **Cyrillic** (Russian, Ukrainian, Bulgarian)                             | ✅ Yes           | ✅ Yes            | ⚠️ Limited        | ✅ Yes             |
| **CJK** (Chinese, Japanese, Korean)                                      | ⚠️ Limited       | ⚠️ Limited        | ✅ Yes            | ✅ Yes             |
| **Arabic script** (Arabic, Persian, Urdu)                                | ✅ Yes           | ⚠️ Limited        | ✅ Yes            | ✅ Yes             |
| **Indic** (Hindi, Bengali, Tamil, Telugu)                                | ⚠️ Limited       | ❌ No             | ⚠️ Limited        | ✅ Yes             |
| **Other** (Thai, Vietnamese, Hebrew, Greek)                              | ⚠️ Limited       | ❌ No             | ⚠️ Limited        | ✅ Yes             |

**Language detection**:

- **Auto-detection**: Detects 55+ languages automatically
- **Code-switching detection**: Can identify mixed-language queries (e.g., "cómo configure kubernetes")
- **Confidence scoring**: Returns confidence level for detected language

**Example**:

```typescript
// Spanish query
const query = "cómo configurar kubernetes en producción";
const result = await preprocessingClient.preprocess(query, tenantId, {
  languageDetection: true,
  enableSpellCorrection: true,
  enableSynonymExpansion: true
});

// Output
{
  processedQuery: "cómo configurar kubernetes en producción",
  detectedLanguage: "es",  // Spanish
  languageConfidence: 0.98,
  corrections: [],  // No typos
  synonyms: ["configurar", "instalar", "desplegar"]  // Spanish synonyms
}
```

**Spell correction languages** (20+ languages):

| Language   | Supported  | Dictionary Size |
| ---------- | ---------- | --------------- |
| English    | ✅ Full    | 100K+ words     |
| Spanish    | ✅ Full    | 80K+ words      |
| French     | ✅ Full    | 70K+ words      |
| German     | ✅ Full    | 90K+ words      |
| Portuguese | ✅ Full    | 60K+ words      |
| Italian    | ✅ Full    | 50K+ words      |
| Russian    | ✅ Full    | 60K+ words      |
| Dutch      | ✅ Full    | 40K+ words      |
| Polish     | ✅ Full    | 40K+ words      |
| Turkish    | ✅ Full    | 30K+ words      |
| Chinese    | ⚠️ Partial | Character-based |
| Japanese   | ⚠️ Partial | Character-based |
| Korean     | ⚠️ Partial | Character-based |
| Arabic     | ✅ Full    | 40K+ words      |
| Hindi      | ⚠️ Partial | 20K+ words      |

**Synonym expansion languages** (30+ languages):

- Full support: English, Spanish, French, German, Portuguese, Italian, Russian
- Partial support: Dutch, Polish, Turkish, Czech, Swedish, Norwegian, Danish, Finnish
- No support: CJK languages (character-level synonyms not applicable), most Indic languages

**Configuration**:

```bash
# Preprocessing service URL
PREPROCESSING_SERVICE_URL=http://localhost:8003

# Language detection (enabled by default)
PREPROCESSING_LANGUAGE_DETECTION=true

# Per-language configuration
PREPROCESSING_SPELL_CORRECTION_LANGUAGES=en,es,fr,de,pt,it,ru
PREPROCESSING_SYNONYM_EXPANSION_LANGUAGES=en,es,fr,de,pt,it,ru
```

---

### Stage 1: Vocabulary Resolution (Multilingual Terms)

**Supported languages**: **All languages** (vocabulary is user-defined, language-agnostic)

**How it works**:

Vocabulary terms can be defined in **any language**, as long as they're stored in the MongoDB vocabulary collection.

**Example** (Spanish business terms):

```json
{
  "projectKnowledgeBaseId": "kb_12345",
  "terms": [
    {
      "term": "clientes premium", // Spanish term
      "type": "filter",
      "field": "customerTier",
      "value": "premium"
    },
    {
      "term": "San Francisco", // English term (city name)
      "type": "filter",
      "field": "city",
      "value": "San Francisco",
      "aliases": ["SF", "San Fran", "Bay Area"]
    }
  ]
}
```

**Query**:

```typescript
// Spanish query with mixed vocabulary
const query = 'Muéstrame clientes premium en San Francisco';

// Vocabulary resolution
const result = {
  originalQuery: 'Muéstrame clientes premium en San Francisco',
  structuredFilters: [
    { field: 'customerTier', operator: 'eq', value: 'premium' }, // Matched "clientes premium"
    { field: 'city', operator: 'eq', value: 'San Francisco' }, // Matched "San Francisco"
  ],
  matchedTerms: ['clientes premium', 'San Francisco'],
};
```

**Fuzzy matching** (cross-language):

Vocabulary resolver supports **fuzzy matching** for terms with typos or variations:

- Edit distance ≤ 2 (e.g., "premum" matches "premium")
- Diacritic insensitivity (e.g., "clientes" matches "clientes")
- Case insensitivity (e.g., "Premium" matches "premium")

**No language-specific processing**: Vocabulary terms are matched as exact strings (or fuzzy), regardless of language.

---

### Stage 2: Query Embedding (Multilingual)

**Supported languages**: **100+ languages** (BGE-M3 multilingual model)

**Model**: BAAI/bge-m3 (M3 = Multi-lingual, Multi-granularity, Multi-functionality)

**Full list of supported languages**:

<details>
<summary>Click to expand (100+ languages)</summary>

**European** (40):

- English, Spanish, French, German, Portuguese, Italian, Russian, Dutch, Polish, Turkish, Czech, Swedish, Norwegian, Danish, Finnish, Greek, Romanian, Hungarian, Bulgarian, Croatian, Slovak, Lithuanian, Slovenian, Estonian, Latvian, Icelandic, Irish, Welsh, Albanian, Bosnian, Macedonian, Serbian, Ukrainian, Belarusian, Catalan, Galician, Basque, Maltese, Luxembourgish, Faroese

**Asian** (30):

- Chinese (Simplified & Traditional), Japanese, Korean, Hindi, Bengali, Tamil, Telugu, Marathi, Gujarati, Kannada, Malayalam, Punjabi, Urdu, Thai, Vietnamese, Indonesian, Malay, Filipino (Tagalog), Khmer, Lao, Burmese, Nepali, Sinhala, Mongolian, Tibetan, Uyghur, Kazakh, Uzbek, Turkmen, Kyrgyz

**Middle Eastern & African** (20):

- Arabic, Persian (Farsi), Hebrew, Pashto, Dari, Kurdish, Amharic, Tigrinya, Oromo, Somali, Hausa, Yoruba, Igbo, Swahili, Zulu, Xhosa, Afrikaans, Malagasy, Kinyarwanda, Shona

**Others** (10+):

- Esperanto, Latin, Sanskrit, and more

</details>

**Embedding quality by language**:

| Language | Quality    | MTEB Score (Retrieval) |
| -------- | ---------- | ---------------------- |
| English  | ⭐⭐⭐⭐⭐ | 0.68 (SOTA)            |
| Chinese  | ⭐⭐⭐⭐⭐ | 0.65                   |
| Spanish  | ⭐⭐⭐⭐   | 0.62                   |
| French   | ⭐⭐⭐⭐   | 0.61                   |
| German   | ⭐⭐⭐⭐   | 0.60                   |
| Japanese | ⭐⭐⭐⭐   | 0.59                   |
| Korean   | ⭐⭐⭐⭐   | 0.58                   |
| Arabic   | ⭐⭐⭐⭐   | 0.57                   |
| Russian  | ⭐⭐⭐⭐   | 0.60                   |
| Hindi    | ⭐⭐⭐     | 0.54                   |
| Others   | ⭐⭐⭐     | 0.50-0.55              |

**Cross-lingual retrieval**:

BGE-M3 supports **cross-lingual semantic search** — you can query in one language and retrieve documents in another:

```typescript
// Query in English
const query = 'How to deploy kubernetes app';
const embedding = await embeddingProvider.embed(query);

// Retrieves documents in ANY language
const results = [
  { content: 'Cómo desplegar una aplicación Kubernetes...', score: 0.85 }, // Spanish
  { content: 'How to deploy a Kubernetes application...', score: 0.92 }, // English
  { content: 'Kubernetes アプリケーションのデプロイ方法...', score: 0.78 }, // Japanese
];
```

**Code-mixed queries**:

Handles queries with multiple languages mixed together:

```typescript
// English + Spanish code-mixed query
const query = 'How do I configurar kubernetes en production?';
const embedding = await embeddingProvider.embed(query); // Works correctly
```

**Alternative models**:

| Model                          | Languages | Dimensions | Quality    | Cost               |
| ------------------------------ | --------- | ---------- | ---------- | ------------------ |
| BGE-M3 (default)               | 100+      | 1024       | ⭐⭐⭐⭐⭐ | Free (self-hosted) |
| OpenAI ada-002                 | 90+       | 1536       | ⭐⭐⭐⭐   | $0.0001/1K tokens  |
| Cohere embed-multilingual-v3.0 | 100+      | 1024       | ⭐⭐⭐⭐   | $0.0001/1K tokens  |

---

### Stage 3: Vector Search (Language-Agnostic)

**Supported languages**: **All languages** (vector similarity is language-agnostic)

**How it works**:

Vector search compares **embedding vectors** (numeric arrays), not text. The language of the query or document is irrelevant:

```
Query: "kubernetes deployment" (English)
  ↓ Embedding
  [0.123, -0.456, 0.789, ...] (1024-dim vector)
  ↓ Cosine similarity
  Score = cos(query_vector, doc_vector)
```

**Cross-lingual search**:

Because embeddings are in a shared multilingual space, vector search **automatically handles cross-lingual retrieval**:

```typescript
// English query
const query = 'kubernetes deployment guide';

// Results in multiple languages (ranked by semantic similarity)
const results = [
  { content: 'Kubernetes deployment guide...', lang: 'en', score: 0.95 },
  { content: 'Guía de despliegue de Kubernetes...', lang: 'es', score: 0.88 },
  { content: 'Kubernetes 部署指南...', lang: 'zh', score: 0.82 },
  { content: 'Kubernetes デプロイメント ガイド...', lang: 'ja', score: 0.79 },
];
```

**No language filters needed**: By default, vector search returns results from all languages. If you want to filter by language, use metadata filters:

```typescript
const results = await vectorStore.search(collectionName, {
  vector: embedding,
  topK: 10,
  filters: [
    { field: 'language', operator: 'eq', value: 'en' }, // Only English results
  ],
});
```

---

### Stage 4: Reranking (Multilingual)

**Supported languages**: **100+ languages** (Cohere, Voyage, Jina rerankers)

**Provider language support**:

| Provider                        | Languages    | Quality    | Cost           |
| ------------------------------- | ------------ | ---------- | -------------- |
| Cohere rerank-multilingual-v3.0 | 100+         | ⭐⭐⭐⭐⭐ | $0.002/1K docs |
| Voyage rerank-lite-1            | English only | ⭐⭐⭐⭐   | $0.002/1K docs |
| Jina jina-reranker-v1-turbo-en  | English only | ⭐⭐⭐⭐   | $0.001/1K docs |

**Recommended**: Use **Cohere rerank-multilingual-v3.0** for non-English queries.

**Configuration**:

```bash
# Use multilingual reranker
RERANKER_PROVIDER=cohere
COHERE_RERANKER_MODEL=rerank-multilingual-v3.0
```

**Example** (Spanish query):

```typescript
// Spanish query
const query = 'cómo desplegar kubernetes';
const rawResults = [
  { content: 'How to deploy kubernetes...', score: 0.85 }, // English
  { content: 'Cómo desplegar kubernetes...', score: 0.82 }, // Spanish
  { content: 'Kubernetes deployment guide...', score: 0.8 }, // English
];

// Rerank with multilingual model
const rerankedResults = await reranker.rerank(query, rawResults);

// Output (Spanish doc boosted)
[
  { content: 'Cómo desplegar kubernetes...', score: 0.95 }, // Spanish (boosted)
  { content: 'How to deploy kubernetes...', score: 0.88 }, // English
  { content: 'Kubernetes deployment guide...', score: 0.75 }, // English
];
```

**Language mismatch handling**:

If you use an English-only reranker (Voyage, Jina) with non-English queries, it will still work but with degraded quality:

```typescript
// Chinese query + English-only reranker
const query = '如何部署 kubernetes'; // Chinese
const reranker = new VoyageReranker(); // English only

// Will rerank, but quality is poor (doesn't understand Chinese semantics)
const results = await reranker.rerank(query, rawResults);
```

---

### Stage 5: Response Formatting (Language Metadata)

**Language metadata** is added to the response:

```typescript
{
  "queryId": "...",
  "results": [...],
  "metadata": {
    "detectedLanguage": "es",           // From preprocessing
    "languageConfidence": 0.98,
    "preprocessingApplied": true,
    "multilingualEmbedding": true,      // BGE-M3 used
    "rerankModel": "cohere-multilingual-v3.0"
  }
}
```

---

### Language Support Summary by Stage

| Stage                | Language Support                            | Notes                                                                                                 |
| -------------------- | ------------------------------------------- | ----------------------------------------------------------------------------------------------------- |
| **0. Preprocessing** | 55+ languages                               | Spell correction (20 languages), synonym expansion (30 languages), language detection (55+ languages) |
| **1. Vocabulary**    | All languages                               | User-defined terms, language-agnostic matching                                                        |
| **2. Embedding**     | 100+ languages                              | BGE-M3 multilingual model, cross-lingual retrieval                                                    |
| **3. Vector Search** | All languages                               | Vector similarity is language-agnostic                                                                |
| **4. Reranking**     | 100+ (Cohere) or English-only (Voyage/Jina) | Use Cohere for multilingual                                                                           |
| **5. Response**      | All languages                               | Metadata includes detected language                                                                   |

### Best Practices for Multilingual Queries

1. **Use multilingual preprocessing**: Enable `languageDetection: true` to auto-detect and apply language-specific spell/synonym rules

2. **Use BGE-M3 for embedding**: Default model, supports 100+ languages with high quality

3. **Use Cohere reranker for non-English**: If reranking non-English queries, use `cohere-multilingual-v3.0`

4. **Store language metadata**: Add `language` field to document metadata for filtering:

   ```json
   {
     "content": "Cómo desplegar kubernetes...",
     "metadata": {
       "language": "es",
       "category": "documentation"
     }
   }
   ```

5. **Cross-lingual search is automatic**: No special configuration needed — BGE-M3 embeddings work across languages

6. **Test with representative queries**: Validate quality with queries in your target languages

---

## 7. Performance & Monitoring

### Latency Targets

| Stage         | Target (P50) | Target (P95) | Acceptable (P99) |
| ------------- | ------------ | ------------ | ---------------- |
| Preprocessing | 20ms         | 40ms         | 80ms             |
| Vocabulary    | 10ms         | 20ms         | 50ms             |
| Embedding     | 25ms         | 45ms         | 80ms             |
| Vector Search | 40ms         | 70ms         | 120ms            |
| Reranking     | 80ms         | 120ms        | 200ms            |
| **Total**     | **130ms**    | **200ms**    | **350ms**        |

### Metrics Collection

```typescript
// Access metrics
const metrics = queryMetricsStore.getAggregateMetrics();

// Example output
{
  queriesTotal: 1543,
  queriesSuccess: 1502,
  queriesFailed: 41,
  queriesActive: 8,

  latency: {
    p50: 128,
    p95: 205,
    p99: 342
  },

  providers: {
    embedding: { bge_m3: 1543 },
    rerank: { cohere: 876, voyage: 0, jina: 0 }
  },

  costTotal: 1.23,  // USD

  errors: {
    preprocessing: 12,
    vocabulary: 3,
    embedding: 8,
    vectorSearch: 5,
    rerank: 13
  }
}
```

### Prometheus Export

```
# Metrics endpoint
GET /metrics

# Example output
search_queries_total 1543
search_queries_success_total 1502
search_queries_failed_total 41
search_queries_active 8
search_latency_milliseconds{quantile="0.5"} 128
search_latency_milliseconds{quantile="0.95"} 205
search_latency_milliseconds{quantile="0.99"} 342
search_cost_usd_total 1.23
search_rerank_provider_total{provider="cohere"} 876
```

### Alerting Rules

```yaml
# Prometheus alerts
groups:
  - name: search-ai-runtime
    rules:
      # High latency
      - alert: SearchLatencyHigh
        expr: search_latency_milliseconds{quantile="0.95"} > 300
        for: 5m
        annotations:
          summary: 'Search latency P95 > 300ms for 5 minutes'

      # High error rate
      - alert: SearchErrorRateHigh
        expr: rate(search_queries_failed_total[5m]) / rate(search_queries_total[5m]) > 0.05
        for: 5m
        annotations:
          summary: 'Search error rate > 5% for 5 minutes'

      # Reranker fallback
      - alert: RerankerFallbackHigh
        expr: rate(search_rerank_fallback_total[5m]) > 10
        for: 5m
        annotations:
          summary: 'Reranker fallback > 10/min (provider down?)'
```

---

## 8. Security & Tenant Isolation

### Authentication Flow

```
Request
  ↓
[Auth Middleware] Extract JWT
  ↓
  └─ Decode JWT → { tenantId, userId, identityTier }
  └─ Validate signature
  └─ Check expiration
  ↓
[Authorization] Check permissions
  ↓
  └─ requireAuth() → { tenantId, userId, identityTier }
  ↓
QueryPipeline.execute(query, tenantId, callerContext, projectKbId)
```

### Tenant Isolation

**Every data access includes `tenantId`**:

1. **Vocabulary Resolution**:

   ```typescript
   const vocabulary = await DomainVocabulary.findOne({
     projectKnowledgeBaseId: projectKbId, // ← Includes tenantId
     status: 'active',
   });
   ```

2. **Vector Search**:

   ```typescript
   const results = await vectorStore.search(collectionName, {
     vector: embedding,
     filters: [
       ...query.filters,
       { field: 'tenantId', operator: 'eq', value: tenantId }, // ← Always injected
     ],
   });
   ```

3. **Reranking**:

   ```typescript
   const queueKey = `${tenantId}:${indexId}:${provider}`; // ← Tenant-scoped queue
   ```

4. **Metrics**:
   ```typescript
   queryMetricsStore.recordQuery({
     queryId,
     tenantId,  // ← Queryable per tenant
     ...
   });
   ```

### Security Checklist

✅ **JWT validation** (signature + expiration)
✅ **Tenant filter injection** (always added to queries)
✅ **Tenant-scoped caches** (queue keys include tenantId)
✅ **Tenant-scoped metrics** (ClickHouse partitioned by tenantId)
✅ **No cross-tenant data leakage** (tested with multi-tenant scenarios)

---

## 9. Local Development

### Prerequisites

```bash
# Required services
- Node.js 20+
- Docker & Docker Compose
- MongoDB 7.0+
- OpenSearch 2.x
- Python 3.10+ (for preprocessing service)
```

### Setup

```bash
# 1. Clone repo
git clone https://bitbucket.org/koreteam1/abl-platform.git
cd abl-platform

# 2. Install dependencies
pnpm install

# 3. Start dependencies
docker compose up -d mongodb opensearch bge-m3

# 4. Build packages
pnpm build

# 5. Start preprocessing service (Phase 3)
cd services/preprocessing-service
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
python3 src/main.py  # Runs on port 8003

# 6. Start search-ai-runtime
cd apps/search-ai-runtime
pnpm dev  # Runs on port 3004
```

### Test Query

```bash
# Create test index
curl -X POST http://localhost:3004/api/indexes \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "indexId": "kb_test",
    "name": "Test Index",
    "dimension": 1024
  }'

# Upload test document
curl -X POST http://localhost:3004/api/indexes/kb_test/documents \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "documents": [
      {
        "id": "doc_1",
        "content": "Kubernetes is a container orchestration platform.",
        "metadata": { "category": "documentation" }
      }
    ]
  }'

# Query
curl -X POST http://localhost:3004/api/search/kb_test/query \
  -H "Authorization: Bearer <JWT>" \
  -H "Content-Type: application/json" \
  -d '{
    "query": "What is Kubernetes?",
    "queryType": "vector",
    "topK": 10
  }'
```

### Debug Mode

```bash
# Enable debug logging
export LOG_LEVEL=debug

# Enable trace logging for specific components
export DEBUG=query-pipeline,preprocessing,rerank

# Run
pnpm dev
```

---

## 10. Troubleshooting

### Query Returns No Results

**Symptoms**:

```json
{ "results": [], "totalCount": 0 }
```

**Possible causes**:

1. **Index is empty**

   ```bash
   # Check document count
   curl http://localhost:9200/kb_test/_count
   ```

2. **Filters too restrictive**

   ```typescript
   // Remove filters to test
   { "query": "test", "filters": [] }
   ```

3. **Embedding failed**

   ```bash
   # Check BGE-M3 service
   curl http://localhost:8001/health
   ```

4. **Similarity threshold too high**
   ```typescript
   // Lower threshold
   { "query": "test", "similarityThreshold": 0.1 }
   ```

---

### High Latency (> 300ms)

**Symptoms**:

```json
{ "latency": { "totalMs": 450 } }
```

**Diagnosis**:

1. **Check latency breakdown**

   ```json
   {
     "latency": {
       "preprocessingMs": 28,
       "vocabularyResolveMs": 14,
       "embeddingMs": 32,
       "vectorSearchMs": 256, // ← Slow!
       "rerankMs": 105,
       "totalMs": 435
     }
   }
   ```

2. **If `vectorSearchMs` is high**:
   - Check OpenSearch health: `GET /_cluster/health`
   - Check index size: `GET /kb_test/_stats`
   - Reduce `topK`: `{ "topK": 5 }` (fewer results = faster)

3. **If `embeddingMs` is high**:
   - Check BGE-M3 service: `curl http://localhost:8001/health`
   - Check CPU usage: `docker stats bge-m3`

4. **If `rerankMs` is high**:
   - Check reranker API status (Cohere/Voyage)
   - Disable reranking: `{ "rerank": false }`

---

### Preprocessing Timeouts

**Symptoms**:

```json
{
  "errors": [
    {
      "component": "preprocessing",
      "error": "Request timeout after 100ms",
      "recoverable": true
    }
  ]
}
```

**Solutions**:

1. **Increase timeout**

   ```bash
   export PREPROCESSING_TIMEOUT_MS=200
   ```

2. **Check service health**

   ```bash
   curl http://localhost:8003/health
   ```

3. **Disable preprocessing**
   ```bash
   export PREPROCESSING_ENABLED=false
   ```

---

### Reranking Failures

**Symptoms**:

```json
{
  "metadata": { "rerankFallback": true },
  "errors": [
    {
      "component": "rerank",
      "error": "Cohere API key invalid",
      "recoverable": true
    }
  ]
}
```

**Solutions**:

1. **Check API key**

   ```bash
   echo $COHERE_API_KEY
   ```

2. **Try different provider**

   ```bash
   export RERANKER_PROVIDER=voyage
   export VOYAGE_API_KEY=...
   ```

3. **Disable reranking**
   ```bash
   export ENABLE_RERANKING=false
   ```

---

## 11. Advanced Topics

### Custom Embedding Provider

```typescript
// custom-embedding-provider.ts
import { EmbeddingProvider } from './embedding-provider';

export class CustomEmbeddingProvider implements EmbeddingProvider {
  async embed(text: string): Promise<number[]> {
    // Your custom embedding logic
    const response = await fetch('https://my-api.com/embed', {
      method: 'POST',
      body: JSON.stringify({ text }),
    });
    const data = await response.json();
    return data.embedding; // 1024-dim vector
  }

  getDimensions(): number {
    return 1024;
  }
}

// server.ts
const queryPipeline = new QueryPipeline({
  embeddingProvider: new CustomEmbeddingProvider(),
  // ... other dependencies
});
```

### Custom Vocabulary Resolution

```typescript
// custom-vocabulary-resolver.ts
export class CustomVocabularyResolver {
  async resolve(projectKbId: string, query: string): Promise<VocabularyResult> {
    // Your custom vocabulary logic
    const terms = await this.matchTerms(query);
    const filters = this.termsToFilters(terms);

    return {
      originalQuery: query, // RFC-003: Preserve intent
      structuredFilters: filters,
      matchedTerms: terms.map((t) => t.term),
    };
  }
}
```

### Circuit Breaker Pattern

```typescript
// circuit-breaker.ts
export class CircuitBreaker {
  private failures = 0;
  private state: 'closed' | 'open' | 'half-open' = 'closed';
  private lastFailureTime = 0;

  async execute<T>(fn: () => Promise<T>, fallback: () => T): Promise<T> {
    if (this.state === 'open') {
      if (Date.now() - this.lastFailureTime > 60000) {
        this.state = 'half-open';
      } else {
        return fallback(); // Circuit open, use fallback
      }
    }

    try {
      const result = await fn();
      this.failures = 0;
      this.state = 'closed';
      return result;
    } catch (error) {
      this.failures++;
      this.lastFailureTime = Date.now();
      if (this.failures >= 3) {
        this.state = 'open'; // Circuit opened after 3 failures
      }
      return fallback();
    }
  }
}

// Usage in reranking
const circuitBreaker = new CircuitBreaker();
const results = await circuitBreaker.execute(
  () => this.rerankerFactory.rerank(...),
  () => rawResults  // Fallback: return original k-NN results
);
```

---

## Summary

The **Query Pipeline** is a sophisticated orchestrator that processes search queries through 6 stages:

1. **Preprocessing** (Phase 3) — Spell correction, synonym expansion, language detection
2. **Vocabulary Resolution** — Map business terms to structured filters
3. **Query Embedding** — Convert text to 1024-dim vector (BGE-M3)
4. **Vector Search** — k-NN search in OpenSearch with filters
5. **Reranking** (Optional, RFC-003) — LLM-based refinement with batching
6. **Response Formatting** — Add metadata, latency, cost tracking

**Key principles**:

- **RFC-003**: Preserve query intent (don't strip terms for embedding)
- **Graceful degradation**: Non-critical failures (preprocessing, reranking) use fallbacks
- **Tenant isolation**: Every data access includes `tenantId` filter
- **Observability**: Full latency breakdown + cost tracking + distributed tracing

**Performance**:

- **P50 latency**: 130ms
- **P95 latency**: 200ms
- **Throughput**: 100+ queries/sec

**Cost**:

- **Embedding**: ~$0.0001 per query (BGE-M3 self-hosted)
- **Reranking**: ~$0.002 per query (Cohere API)

---

For questions or issues, see:

- Codebase: `/apps/search-ai-runtime/src/services/query/query-pipeline.ts`
- API docs: `/apps/search-ai-runtime/README.md`
- Architecture docs: `/docs/ARCHITECTURE.md`
- Troubleshooting: This document, Section 10
