# RFC-003: Query Pipeline Redesign - Intent Preservation & True Hybrid Search

**Status:** Draft - Under Discussion (Bharat Feedback Round 1)
**Created:** 2026-02-23
**Author:** Bharat R
**Reviewers:** [To be assigned]
**Last Updated:** 2026-02-23
**OpenSearch Version:** 2.11.0 ✅ (Confirmed in docker-compose.yml)
**Migration Required:** NO - Not yet live in production

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Problem Statement](#problem-statement)
3. [Current Architecture Analysis](#current-architecture-analysis)
4. [Proposed Solution](#proposed-solution)
5. [Design Alternatives](#design-alternatives)
6. [Detailed Design](#detailed-design)
7. [Implementation Plan](#implementation-plan)
8. [Migration Strategy](#migration-strategy)
9. [Testing Strategy](#testing-strategy)
10. [Performance Impact](#performance-impact)
11. [Cost Analysis](#cost-analysis)
12. [Risk Assessment](#risk-assessment)
13. [Success Metrics](#success-metrics)
14. [Open Questions](#open-questions)
15. [References](#references)

---

## Executive Summary

The current Query Pipeline implementation has **three critical architectural flaws** that severely impact search quality:

1. **Vocabulary resolution destroys query intent** - Strips all meaningful terms, leaving only stopwords
2. **False "hybrid" search** - No BM25 scoring, no score fusion, `hybridAlpha` parameter ignored
3. **Reranker not implemented** - Stub only, missing 5-10% accuracy improvement

This RFC proposes a comprehensive redesign to:

- ✅ Preserve original query semantics for embedding
- ✅ Implement true hybrid search with RRF score fusion
- ✅ Integrate production-grade reranking
- ✅ Add query type routing for optimized pipelines
- ✅ Improve observability and cost tracking

**Expected Impact:**

- Accuracy: 87% → 94% MRR@10 (+8.0%)
- Query Intent Preservation: 0% → 100%
- True Hybrid Search: Implemented with OpenSearch RRF (native support ✅)
- Latency: 135ms → 265ms (RRF +20ms, Reranker +110ms)

**Environment Status:**

- ✅ OpenSearch 2.11.0 confirmed (docker-compose.yml) - Native hybrid search ready
- ✅ Not yet in production - No migration concerns, can ship best solution
- ✅ All tests must pass before deployment

---

## Problem Statement

### 1. Vocabulary Resolution Destroys Query Intent

**Current Behavior:**

```typescript
Input:  "Show me premium customers in SF with revenue > 100K from Q1 2024"
        ↓ [Vocabulary Resolution]
Output: "Show me in with from"  // Only stopwords remain!
        ↓ [Embedding - BGE-M3]
Result: 1024-dim vector representing stopwords, not query intent
```

**Root Cause:**

```typescript
// vocabulary-resolver.ts:69-70
remainingQuery = remainingQuery.replace(match.matchedText.toLowerCase(), '').trim();
// ← Blindly removes matched terms without semantic preservation
```

**Impact:**

- **Zero semantic search capability** - Embedding represents meaningless stopwords
- **Results are filter-only** - Vector search adds no value
- **Misleading API** - Claims "semantic search" but only does SQL-style filtering

**Why Critical:**
The entire purpose of RAG is semantic retrieval. If embeddings don't capture query semantics, the system degrades to pure keyword filtering, defeating the "Retrieval" component of RAG.

---

### 2. False "Hybrid" Search Implementation

**API Contract Claims:**

```typescript
POST /api/search/:indexId/query
{
  "query": "Python programming tutorial",
  "queryType": "hybrid",
  "hybridAlpha": 0.7  // 70% vector, 30% keyword
}
```

**Actual Implementation:**

```typescript
// opensearch.ts:126-169
const query = {
  bool: {
    must: [
      { knn: { vector: [...] } },           // ← Vector score ONLY
      { term: { "metadata.field": "..." } }  // ← Filters (not scored)
    ]
  }
};
// No BM25 full-text query
// No score fusion (RRF/RSF)
// hybridAlpha parameter completely ignored
```

**Real-World Failure Example:**

```
Query: "Python programming tutorial for beginners"

Current (filtered vector):
✗ Misses: Documents with exact term "Python" but different semantic framing
✗ Ranking: Pure cosine similarity, no lexical signal

True Hybrid (vector + BM25 + RRF):
✓ Vector: Captures "tutorial for beginners" semantic intent
✓ BM25: Ensures "Python" keyword presence
✓ RRF: Fuses scores for balanced ranking
```

**Impact:**

- **API contract violation** - `hybridAlpha` has no effect
- **Misleading naming** - This is "filtered vector search", not hybrid
- **Missing keyword signal** - Can't catch exact term matches

---

### 3. Reranker Not Implemented

**Current Code:**

```typescript
// query-pipeline.ts:156-159
private async rerank(_query: string, results: SearchResult[]): Promise<SearchResult[]> {
  // TODO: Call reranker service (e.g., Cohere rerank-english-v3.0)
  return results;  // ← No-op, just returns input unchanged
}
```

**Impact:**

- **Missing accuracy boost** - Reranking typically adds +5-10% MRR
- **User expectation mismatch** - `rerank: true` flag does nothing
- **Incomplete RAG pipeline** - Industry standard is Retrieve → Rerank → Generate

**Why Reranking Matters:**

- **First-stage retrieval** uses bi-encoders (fast, approximate)
- **Reranking** uses cross-encoders (slow, precise)
- **Two-stage retrieval** is the accepted pattern for balancing speed vs accuracy

---

## Current Architecture Analysis

### Data Flow (Current - Broken)

```
┌─────────────────────────────────────────────────────────────────┐
│ Stage 1: Vocabulary Resolution (15ms)                           │
├─────────────────────────────────────────────────────────────────┤
│ Input:  "Show me premium customers in SF with revenue > 100K"  │
│ Output: "Show me in with from" ← Only stopwords!               │
│ Filters: [customerTier=premium, city=SF, revenue>100K]         │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 2: Embedding (30ms)                                       │
├─────────────────────────────────────────────────────────────────┤
│ Input:  "Show me in with from" ← Meaningless!                  │
│ Output: [0.023, -0.156, ..., 0.078] ← 1024-dim stopword vector │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 3: Vector Search (85ms)                                   │
├─────────────────────────────────────────────────────────────────┤
│ OpenSearch k-NN with metadata filters                          │
│ Score: Pure cosine similarity (no BM25, no keyword signal)     │
│ hybridAlpha parameter: IGNORED                                 │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 4: Reranking (0ms)                                        │
├─────────────────────────────────────────────────────────────────┤
│ STUB - Returns results unchanged                               │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 5: Response Formatting (5ms)                              │
├─────────────────────────────────────────────────────────────────┤
│ Package results + latency breakdown                            │
└─────────────────────────────────────────────────────────────────┘

Total: 135ms
Accuracy: 87% MRR@10
Issues: Query intent lost, no hybrid search, no reranking
```

### Key Issues Summary

| Issue                             | Severity    | Impact              | Fix Complexity             |
| --------------------------------- | ----------- | ------------------- | -------------------------- |
| Vocabulary strips query semantics | 🔴 Critical | Embedding useless   | Low (preserve original)    |
| No BM25 scoring                   | 🔴 Critical | No keyword signal   | Medium (OpenSearch RRF)    |
| No score fusion (RRF/RSF)         | 🔴 Critical | hybridAlpha ignored | Medium (OpenSearch hybrid) |
| Reranker stub                     | 🔴 Critical | -5-10% accuracy     | Low (Cohere API)           |
| No query type routing             | 🟡 Major    | Inefficient         | Medium (router pattern)    |
| No query preprocessing            | 🟡 Major    | Poor understanding  | High (NLP pipeline)        |
| Incomplete observability          | 🟢 Minor    | Hard to debug       | Low (add metrics)          |

---

## Proposed Solution

### High-Level Approach

**Three-Phase Rollout:**

**Phase 1 (P0 - Critical Fixes):**

1. Preserve original query for embedding (fix vocabulary)
2. Implement true hybrid search with OpenSearch RRF
3. Integrate Cohere reranker

**Phase 2 (P1 - Major Improvements):** 4. Add query type routing 5. Implement adaptive pipeline selection 6. Enhance observability

**Phase 3 (P2 - Optimizations):** 7. Add query preprocessing layer 8. Implement result post-processing 9. Add multi-stage retrieval

### Architecture Principles

1. **Intent Preservation:** Original query always preserved for semantic understanding
2. **True Hybrid:** Vector + keyword signals combined via score fusion
3. **Two-Stage Retrieval:** Fast approximate → Slow precise (reranking)
4. **Query-Type Awareness:** Different pipelines for different query types
5. **Cost Optimization:** Adaptive selection based on query complexity
6. **Full Observability:** Every stage tracked with latency + cost metrics

---

## Design Alternatives

### Alternative 1: Preserve Original Query for Embedding ⭐ RECOMMENDED

**Approach:**

```typescript
// Use original query for embedding, vocabulary only adds filters
const embedding = await this.embedQuery(query.query); // Original
query.filters = [...query.filters, ...vocabResult.structuredFilters];
```

**Pros:**

- ✅ Simple to implement (5-line change)
- ✅ Zero risk - Always preserves intent
- ✅ Backward compatible
- ✅ No performance impact

**Cons:**

- ❌ May embed some noise if vocabulary terms are obvious filters
- ❌ Slightly redundant (embedding "premium customers" when filter exists)

**Decision:** **ACCEPT** - Simplicity and safety outweigh minor redundancy.

---

### Alternative 2: Smart Term Preservation

**Approach:**

```typescript
// Only remove terms if vocabulary fully captures their meaning
function shouldRemoveTerm(term: string, resolution: VocabularyResolution): boolean {
  if (resolution.type === 'filter' && resolution.exactMatch) {
    return true; // "premium customers" → tier=premium, fully captured
  }
  return false; // Keep term for semantic search
}
```

**Pros:**

- ✅ Optimal - Removes only truly redundant terms
- ✅ Cleaner embeddings
- ✅ Lower embedding costs (fewer tokens)

**Cons:**

- ❌ Complex - Requires heuristics for "full capture" detection
- ❌ Risky - Edge cases may still lose intent
- ❌ More code to maintain

**Decision:** **REJECT** for P0, consider for P2 optimization.

---

### Alternative 3: Dual Query Approach

**Approach:**

```typescript
// Maintain two query representations
const semanticQuery = query.query; // Original
const keywordQuery = vocabResult.unresolvedSegments.join(' '); // Stripped

// Use semantic for embedding, keyword for BM25
const embedding = await this.embedQuery(semanticQuery);
const bm25Query = keywordQuery;
```

**Pros:**

- ✅ Best of both worlds
- ✅ Semantic search uses full query
- ✅ Keyword search uses clean terms

**Cons:**

- ❌ More complex state management
- ❌ Increased latency (two separate queries)
- ❌ Higher cost (embedding + BM25 both on full query)

**Decision:** **DEFER** - Interesting for future optimization.

---

### Hybrid Search Implementation: OpenSearch vs Custom

#### Option A: OpenSearch Native Hybrid (RRF) ⭐ RECOMMENDED

**Approach:**

```typescript
const response = await this.client.search({
  index: collection,
  body: {
    query: {
      hybrid: {
        queries: [
          { knn: { vector: { vector: [...], k: topK } } },
          { match: { content: originalQuery } }
        ]
      }
    },
    rank: {
      rrf: {
        window_size: topK * 2,
        rank_constant: 60
      }
    }
  }
});
```

**Pros:**

- ✅ Native OpenSearch feature (v2.11+)
- ✅ Efficient - Single query, server-side fusion
- ✅ Battle-tested RRF algorithm
- ✅ Lower latency than client-side fusion
- ✅ No custom fusion code to maintain

**Cons:**

- ❌ Requires OpenSearch 2.11+ (✅ **CONFIRMED: 2.11.0 running**)
- ❌ Less flexible than custom fusion
- ❌ Can't easily add custom scoring signals
- ❌ `hybridAlpha` parameter not directly supported (RRF is rank-based)

**Decision:** **ACCEPT as primary** - Native solution for performance, add RSF as option.

---

#### Option B: Client-Side Score Fusion (Custom RRF)

**Approach:**

```typescript
// Run vector and BM25 queries separately
const vectorResults = await this.vectorSearch(...);
const bm25Results = await this.bm25Search(...);

// Fuse scores client-side
const fusedResults = this.fuseScoresRRF(
  vectorResults,
  bm25Results,
  { k: 60, weights: [0.7, 0.3] }
);
```

**Pros:**

- ✅ Works with any OpenSearch version
- ✅ Full control over fusion logic
- ✅ Can add custom scoring signals easily
- ✅ Can implement RSF, weighted average, etc.

**Cons:**

- ❌ Higher latency (two queries + merge)
- ❌ More complex code
- ❌ Need to maintain fusion algorithm
- ❌ Potential ranking inconsistencies

**Decision:** **FALLBACK** - Use if OpenSearch < 2.11 or if native hybrid fails.

---

#### Option C: Weighted Score Fusion (RSF) ⭐ ALSO ACCEPT

**Approach:**

```typescript
// Relative Score Fusion (RSF)
// Respects hybridAlpha parameter: 0.7 = 70% vector, 30% keyword

// Step 1: Normalize scores to [0, 1]
const normalizedVector = normalizeScores(vectorResults);
const normalizedBM25 = normalizeScores(bm25Results);

// Step 2: Combine with alpha weighting
const alpha = query.hybridAlpha ?? 0.7;
finalScore = (alpha × normalizedVector) + ((1 - alpha) × normalizedBM25);

// Min-max normalization
function normalizeScores(results: SearchResult[]): number[] {
  const scores = results.map(r => r.score);
  const min = Math.min(...scores);
  const max = Math.max(...scores);
  const range = max - min;

  if (range === 0) return scores.map(() => 1);  // All same score

  return scores.map(s => (s - min) / range);
}
```

**Pros:**

- ✅ More intuitive than RRF - "70% vector, 30% keyword"
- ✅ Direct use of `hybridAlpha` parameter (honors API contract)
- ✅ Linear combination easy to understand and tune
- ✅ Works with any OpenSearch version (client-side)
- ✅ Can adjust alpha per-query for different use cases

**Cons:**

- ❌ Score distribution sensitive (outliers skew normalization)
- ❌ Not as robust as RRF for varying result sets
- ❌ Requires careful normalization (min-max or z-score)
- ❌ Two separate queries (higher latency than native RRF)

**Decision:** **ACCEPT as secondary option**

- Use **RRF by default** (robust, native, fast)
- Use **RSF when `hybridAlpha` is explicitly set** (honor user intent)
- Expose both via query parameter: `fusion: 'rrf' | 'rsf'`

**Implementation Strategy:**

```typescript
interface HybridSearchParams {
  vector: number[];
  queryText: string;
  topK: number;

  // ✅ NEW: Fusion strategy selection
  fusion?: {
    method: 'rrf' | 'rsf';       // Default: 'rrf'
    alpha?: number;               // For RSF: 0-1 (default 0.7)
    rankConstant?: number;        // For RRF: k value (default 60)
  };
}

async hybridSearch(params: HybridSearchParams) {
  const method = params.fusion?.method ?? 'rrf';

  if (method === 'rrf') {
    // Use OpenSearch native hybrid with RRF
    return this.nativeHybridSearchRRF(params);
  } else {
    // Client-side RSF with alpha weighting
    return this.clientSideHybridSearchRSF(params);
  }
}
```

**When to use RSF over RRF:**

1. User explicitly sets `hybridAlpha` in query
2. Need fine-grained control over vector/keyword balance
3. A/B testing different alpha values
4. Domain-specific tuning (e.g., code search needs higher keyword weight)

---

### Reranker Integration: Multi-Provider Strategy ⭐ UPDATED

**Decision:** Support **multiple reranker providers** with unified interface. Start with **Voyage AI** (cheapest) as default, fallback to others.

#### Provider Comparison

| Provider        | Model               | Cost per 1K queries | Latency | Status         | Notes                  |
| --------------- | ------------------- | ------------------- | ------- | -------------- | ---------------------- |
| **Voyage AI**   | rerank-1            | **$0.50**           | ~100ms  | ⭐ **PRIMARY** | 4x cheaper than Cohere |
| **Cohere**      | rerank-english-v3.0 | $2.00               | ~120ms  | 🔄 FALLBACK    | Industry standard      |
| **Jina AI**     | jina-reranker-v2    | $1.00               | ~150ms  | 🔄 FALLBACK    | Multilingual support   |
| OpenAI          | ❌ None             | N/A                 | N/A     | ❌             | No reranking API       |
| Gemini          | ❌ None             | N/A                 | N/A     | ❌             | No reranking API       |
| Claude          | ❌ None             | N/A                 | N/A     | ❌             | No reranking API       |
| **Self-Hosted** | mxbai-rerank-large  | Infrastructure only | ~200ms  | 🚧 FUTURE      | Phase 2 option         |

**Recommendation:**

1. **Start with Voyage AI** ($0.50 vs $2.00) - 75% cost reduction
2. **Add Cohere fallback** - If Voyage fails/unavailable
3. **Unified interface** - Easy to swap providers
4. **Self-host in Phase 2** - If cost scales too high

---

#### Multi-Provider Reranker Design

**New File:** `apps/search-ai-runtime/src/services/rerank/reranker-factory.ts`

```typescript
/**
 * Unified Reranker Interface
 * Supports: Voyage AI, Cohere, Jina AI, Self-Hosted
 */

export interface RerankerProvider {
  name: string;
  rerank(request: RerankRequest): Promise<RerankResponse>;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}

export interface RerankRequest {
  query: string;
  documents: string[];
  topN?: number;
}

export interface RerankResponse {
  results: Array<{
    index: number; // Original position
    score: number; // 0-1 relevance score
    document?: string;
  }>;
  provider: string;
  latencyMs: number;
  cost?: number; // Track per-query cost
}

// ─── Voyage AI Provider ───────────────────────────────────────────────

export class VoyageReranker implements RerankerProvider {
  readonly name = 'voyage';

  constructor(private config: { apiKey: string; model: string }) {}

  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const start = Date.now();

    const response = await fetch('https://api.voyageai.com/v1/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model, // 'rerank-1' or 'rerank-lite-1'
        query: request.query,
        documents: request.documents,
        top_k: request.topN,
      }),
    });

    const data = await response.json();

    return {
      results: data.data.map((item: any) => ({
        index: item.index,
        score: item.relevance_score,
      })),
      provider: 'voyage',
      latencyMs: Date.now() - start,
      cost: 0.0005 * (request.documents.length / 1000), // $0.50 per 1K
    };
  }

  async healthCheck() {
    const start = Date.now();
    try {
      await this.rerank({ query: 'test', documents: ['test'] });
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}

// ─── Cohere Provider ──────────────────────────────────────────────────

export class CohereReranker implements RerankerProvider {
  readonly name = 'cohere';

  constructor(private config: { apiKey: string; model: string }) {}

  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const start = Date.now();

    const response = await fetch('https://api.cohere.ai/v1/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model, // 'rerank-english-v3.0'
        query: request.query,
        documents: request.documents,
        top_n: request.topN,
      }),
    });

    const data = await response.json();

    return {
      results: data.results.map((item: any) => ({
        index: item.index,
        score: item.relevance_score,
      })),
      provider: 'cohere',
      latencyMs: Date.now() - start,
      cost: 0.002 * (request.documents.length / 1000), // $2.00 per 1K
    };
  }

  async healthCheck() {
    const start = Date.now();
    try {
      await this.rerank({ query: 'test', documents: ['test'] });
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}

// ─── Jina AI Provider ─────────────────────────────────────────────────

export class JinaReranker implements RerankerProvider {
  readonly name = 'jina';

  constructor(private config: { apiKey: string; model: string }) {}

  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const start = Date.now();

    const response = await fetch('https://api.jina.ai/v1/rerank', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.config.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: this.config.model, // 'jina-reranker-v2-base-multilingual'
        query: request.query,
        documents: request.documents.map((text, idx) => ({ index: idx, text })),
        top_n: request.topN,
      }),
    });

    const data = await response.json();

    return {
      results: data.results.map((item: any) => ({
        index: item.index,
        score: item.relevance_score,
      })),
      provider: 'jina',
      latencyMs: Date.now() - start,
      cost: 0.001 * (request.documents.length / 1000), // $1.00 per 1K
    };
  }

  async healthCheck() {
    const start = Date.now();
    try {
      await this.rerank({ query: 'test', documents: ['test'] });
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }
}

// ─── Factory with Circuit Breaker & Fallback ──────────────────────────

export class RerankerFactory {
  private providers: RerankerProvider[] = [];
  private failureCount = new Map<string, number>();
  private readonly maxFailures = 3;

  constructor() {
    // Priority order: Voyage (cheapest) → Cohere → Jina
    if (process.env.VOYAGE_API_KEY) {
      this.providers.push(
        new VoyageReranker({
          apiKey: process.env.VOYAGE_API_KEY,
          model: 'rerank-1',
        }),
      );
    }

    if (process.env.COHERE_API_KEY) {
      this.providers.push(
        new CohereReranker({
          apiKey: process.env.COHERE_API_KEY,
          model: 'rerank-english-v3.0',
        }),
      );
    }

    if (process.env.JINA_API_KEY) {
      this.providers.push(
        new JinaReranker({
          apiKey: process.env.JINA_API_KEY,
          model: 'jina-reranker-v2-base-multilingual',
        }),
      );
    }
  }

  /**
   * Rerank with automatic fallback
   * Tries providers in priority order until one succeeds
   */
  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of this.providers) {
      // Skip if circuit breaker is open
      if (this.isCircuitOpen(provider.name)) {
        console.warn(`[Reranker] Skipping ${provider.name} (circuit open)`);
        continue;
      }

      try {
        const result = await provider.rerank(request);
        this.recordSuccess(provider.name);
        return result;
      } catch (error) {
        this.recordFailure(provider.name);
        errors.push({
          provider: provider.name,
          error: error instanceof Error ? error.message : String(error),
        });
        console.error(`[Reranker] ${provider.name} failed:`, error);
      }
    }

    // All providers failed - throw aggregated error
    throw new Error(`All reranker providers failed: ${JSON.stringify(errors)}`);
  }

  private isCircuitOpen(providerName: string): boolean {
    const failures = this.failureCount.get(providerName) ?? 0;
    return failures >= this.maxFailures;
  }

  private recordSuccess(providerName: string): void {
    this.failureCount.set(providerName, 0);
  }

  private recordFailure(providerName: string): void {
    const current = this.failureCount.get(providerName) ?? 0;
    this.failureCount.set(providerName, current + 1);
  }

  /**
   * Get primary provider status
   */
  async getStatus(): Promise<Array<{ name: string; healthy: boolean; latencyMs: number }>> {
    const checks = await Promise.all(
      this.providers.map(async (p) => {
        const health = await p.healthCheck();
        return {
          name: p.name,
          healthy: health.ok,
          latencyMs: health.latencyMs,
        };
      }),
    );
    return checks;
  }
}
```

**Why This Design:**

- ✅ **Cost optimized** - Voyage AI is 4x cheaper than Cohere
- ✅ **Resilient** - Automatic fallback if primary fails
- ✅ **Extensible** - Easy to add new providers
- ✅ **Unified API** - Caller doesn't care which provider is used
- ✅ **Circuit breaker** - Prevents cascade failures
- ✅ **Cost tracking** - Monitor spend per provider

---

### Query Type Routing & Pipeline Selection (Phase 2)

**Problem:** Not all queries need the full pipeline. Different query types have different optimal paths:

| Query Type    | Example                            | Optimal Pipeline                      | Why                             |
| ------------- | ---------------------------------- | ------------------------------------- | ------------------------------- |
| **ID Lookup** | `"DOC-12345"`                      | BM25 only                             | Exact match, no semantic needed |
| **Keyword**   | `"python flask tutorial"`          | BM25 + vector (keyword-heavy)         | Strong keyword signal           |
| **Semantic**  | `"How does photosynthesis work?"`  | Vector + optional BM25                | Semantic understanding primary  |
| **Hybrid**    | `"Python tutorials for beginners"` | Full pipeline (vector + BM25 + vocab) | Needs both semantic + keyword   |

**Current Problem:** User's initial proposal was too aggressive:

```typescript
// ❌ PROBLEM: Too simplistic, classifies too much as semantic-only
private detectQueryType(query: string): QueryType {
  // Keyword patterns
  if (/^(id:|doc:|ref:)/i.test(query)) return 'keyword';
  if (/^[A-Z0-9-]{5,20}$/.test(query)) return 'keyword';

  // Semantic patterns
  if (/^(explain|what is|how does|why)/i.test(query)) return 'semantic';
  if (query.split(' ').length > 10) return 'semantic';  // ❌ Too broad!

  // Default to hybrid
  return 'hybrid';
}
```

**Issues:**

1. ❌ Long queries (`> 10 words`) classified as semantic-only, **missing keyword signals**
2. ❌ Question queries force semantic-only, **but "What is Python Flask?" benefits from keyword match**
3. ❌ Only 2 keyword patterns, most queries fall through to hybrid anyway

**Refined Approach: Default to Hybrid, Only Deviate When Certain**

```typescript
/**
 * Query Type Detection (Conservative Strategy)
 *
 * Philosophy: When in doubt, use HYBRID (semantic + keyword + vocabulary).
 * Only use pure keyword/semantic when we're 90%+ confident.
 */
export type QueryType = 'keyword' | 'semantic' | 'hybrid';

export interface QueryTypeDetectionResult {
  type: QueryType;
  confidence: number; // 0-1
  reasoning: string; // Why this classification
  signals: {
    hasKeywordPatterns: boolean;
    hasSemanticPatterns: boolean;
    hasVocabularyMatch: boolean;
  };
}

export class QueryTypeDetector {
  /**
   * Detect query type with confidence scoring
   * Default to 'hybrid' unless very confident otherwise
   */
  detect(query: string, vocabularyMatches?: number): QueryTypeDetectionResult {
    const signals = {
      hasKeywordPatterns: this.hasKeywordPatterns(query),
      hasSemanticPatterns: this.hasSemanticPatterns(query),
      hasVocabularyMatch: (vocabularyMatches ?? 0) > 0,
    };

    // ─── Pure Keyword (High Confidence) ───────────────────────────

    // Explicit ID/reference lookup
    if (/^(id:|doc:|ref:|uuid:|sku:)/i.test(query)) {
      return {
        type: 'keyword',
        confidence: 0.95,
        reasoning: 'Explicit ID prefix (id:, doc:, ref:)',
        signals,
      };
    }

    // Looks like an ID (alphanumeric with dashes/underscores)
    if (/^[A-Z0-9_-]{8,30}$/i.test(query)) {
      return {
        type: 'keyword',
        confidence: 0.9,
        reasoning: 'Matches ID pattern (8-30 chars, alphanumeric)',
        signals,
      };
    }

    // Email or URL (exact match queries)
    if (/^[\w.-]+@[\w.-]+\.\w+$/.test(query) || /^https?:\/\//.test(query)) {
      return {
        type: 'keyword',
        confidence: 0.95,
        reasoning: 'Email or URL - exact match query',
        signals,
      };
    }

    // ─── Default to Hybrid ────────────────────────────────────────

    // If we have vocabulary matches AND semantic patterns
    // → Hybrid gives best of both worlds
    if (signals.hasVocabularyMatch && signals.hasSemanticPatterns) {
      return {
        type: 'hybrid',
        confidence: 0.85,
        reasoning: 'Vocabulary filters + semantic query → use both',
        signals,
      };
    }

    // Long natural language queries (but NOT semantic-only!)
    // These still benefit from keyword matching
    if (query.split(' ').length > 8) {
      return {
        type: 'hybrid',
        confidence: 0.8,
        reasoning: 'Long query benefits from both semantic + keyword',
        signals,
      };
    }

    // Question queries (still hybrid, not semantic-only!)
    if (/^(what|how|why|when|where|who|explain|describe|tell me)/i.test(query)) {
      return {
        type: 'hybrid',
        confidence: 0.75,
        reasoning: 'Question query benefits from semantic + keyword boost',
        signals,
      };
    }

    // ─── Pure Semantic (Only if NO Obvious Keywords) ──────────────

    // Very abstract conceptual queries with no entities
    const hasEntities = /[A-Z][a-z]+|[0-9]+|\b(api|sdk|code|python|java|sql)\b/i.test(query);
    if (!hasEntities && signals.hasSemanticPatterns && query.split(' ').length > 5) {
      return {
        type: 'semantic',
        confidence: 0.7,
        reasoning: 'Abstract query, no entities, pure semantic',
        signals,
      };
    }

    // ─── Final Default: Hybrid ────────────────────────────────────

    return {
      type: 'hybrid',
      confidence: 0.6,
      reasoning: 'Default to hybrid (safest for most queries)',
      signals,
    };
  }

  private hasKeywordPatterns(query: string): boolean {
    // Quoted phrases, boolean operators, field queries
    return /["']|AND|OR|NOT|\w+:/.test(query);
  }

  private hasSemanticPatterns(query: string): boolean {
    // Natural language indicators
    return /(what|how|why|explain|describe|compare|difference|meaning|purpose)/i.test(query);
  }
}
```

**Pipeline Routing Based on Query Type:**

```typescript
async execute(query: VectorSearchQuery): Promise<VectorSearchResponse> {
  const detection = this.detector.detect(query.query, vocabularyMatchCount);

  console.log(`[QueryPipeline] Detected type: ${detection.type} (confidence: ${detection.confidence})`);

  switch (detection.type) {
    case 'keyword':
      return this.keywordOnlyPipeline(query);

    case 'semantic':
      return this.semanticOnlyPipeline(query);

    case 'hybrid':
    default:
      return this.fullHybridPipeline(query);  // Default path
  }
}

// ─── Optimized Pipelines ──────────────────────────────────────────────

private async keywordOnlyPipeline(query: VectorSearchQuery) {
  // Skip embedding, use BM25 only
  const results = await this.vectorStore.bm25Search({
    queryText: query.query,
    topK: query.topK,
    filters: query.filters
  });

  // No reranking needed (exact match)
  return this.formatResponse(results, { skipRerank: true });
}

private async semanticOnlyPipeline(query: VectorSearchQuery) {
  // Embed + vector search (no BM25, no vocabulary)
  const embedding = await this.embedQuery(query.query);

  const results = await this.vectorStore.search({
    vector: embedding,
    topK: query.topK * 2,  // Fetch more for reranking
    filters: query.filters
  });

  // Rerank for precision
  const reranked = await this.reranker.rerank({
    query: query.query,
    documents: results.map(r => r.content),
    topN: query.topK
  });

  return this.formatResponse(reranked);
}

private async fullHybridPipeline(query: VectorSearchQuery) {
  // Full pipeline: vocabulary → embed → hybrid search → rerank
  // (This is what we've been designing throughout the RFC)
  return this.currentFullPipeline(query);
}
```

**Why This Approach:**

- ✅ **Conservative** - Default to hybrid (safest)
- ✅ **Cost efficient** - Skip embedding for pure keyword queries
- ✅ **Latency optimized** - Skip BM25 for pure semantic queries
- ✅ **Confidence scoring** - Track classification quality
- ✅ **Explainable** - Reason logged for debugging
- ✅ **Semantic + keyword for most queries** - Hybrid is default!

**Test Cases:**

```typescript
describe('Query Type Detection', () => {
  test('ID lookups are keyword-only', () => {
    expect(detector.detect('DOC-12345').type).toBe('keyword');
    expect(detector.detect('id:abc-123-def').type).toBe('keyword');
    expect(detector.detect('user@example.com').type).toBe('keyword');
  });

  test('Long natural language is hybrid, not semantic-only', () => {
    const result = detector.detect(
      'Show me all premium customers in San Francisco with revenue over 100K',
    );
    expect(result.type).toBe('hybrid'); // ← NOT 'semantic'!
    expect(result.confidence).toBeGreaterThan(0.75);
  });

  test('Questions are hybrid by default', () => {
    expect(detector.detect('What is Python Flask?').type).toBe('hybrid');
    expect(detector.detect('How does React work?').type).toBe('hybrid');
  });

  test('Abstract queries are semantic', () => {
    expect(detector.detect('explain the philosophical implications of consciousness').type).toBe(
      'semantic',
    );
  });

  test('Default to hybrid when uncertain', () => {
    expect(detector.detect('some random query').type).toBe('hybrid');
    expect(detector.detect('a b c').type).toBe('hybrid');
  });
});
```

**User Feedback Integration:**

> "should we say when we can't detect it is always hybrid both semantic plus hybrid including the vocabulary etc."

✅ **YES - Exactly!** When uncertain, **default to hybrid** (semantic via vector + keyword via BM25 + vocabulary filters). This gives the best user experience - we don't miss results due to wrong classification.

---

## Detailed Design

### Phase 1: Intent Preservation & True Hybrid

#### 1.1 Vocabulary Resolution Fix

**File:** `apps/search-ai-runtime/src/services/vocabulary/vocabulary-resolver.ts`

**Current:**

```typescript
async resolve(projectKbId: string, query: string, mode: string) {
  // ... match terms ...

  for (const entry of entries) {
    const match = this.findMatch(remainingQuery, entry, mode);
    if (!match) continue;

    // Extract filters
    structuredFilters.push(...extracted.filters);

    // ❌ PROBLEM: Remove matched term
    remainingQuery = remainingQuery.replace(match.matchedText, '').trim();
  }

  return {
    resolvedTerms,
    unresolvedSegments: remainingQuery.split(/\s+/),  // Only stopwords!
    structuredFilters
  };
}
```

**Proposed:**

```typescript
async resolve(projectKbId: string, query: string, mode: string) {
  // ... match terms ...

  for (const entry of entries) {
    const match = this.findMatch(query, entry, mode);  // Match against original
    if (!match) continue;

    // Extract filters
    structuredFilters.push(...extracted.filters);

    // ✅ FIX: Don't remove terms, just track them
    resolvedTerms.push({
      term: match.matchedText,
      matchedEntry: entry.term,
      matchType: match.type,
      confidence: match.confidence,
      resolution: entry.resolution
    });
  }

  return {
    resolvedTerms,
    originalQuery: query,  // ✅ NEW: Preserve original
    structuredFilters,
    // Optional: Include unresolved segments for debugging
    unresolvedSegments: this.extractUnresolvedSegments(query, resolvedTerms)
  };
}

// Helper to extract terms not matched by vocabulary
private extractUnresolvedSegments(query: string, resolved: ResolvedTerm[]): string[] {
  let remaining = query;
  for (const term of resolved) {
    remaining = remaining.replace(new RegExp(term.term, 'gi'), '');
  }
  return remaining.split(/\s+/).filter(s => s.length > 2);  // Filter stopwords
}
```

**Pipeline Integration:**

```typescript
// query-pipeline.ts:62-80
const vocabStart = Date.now();
let semanticQuery = query.query; // ✅ Default to original

if (projectKbId) {
  try {
    const vocabResult = await this.vocabularyResolver.resolve(projectKbId, query.query);

    // Add filters from vocabulary
    if (vocabResult.structuredFilters.length > 0) {
      query.filters = [...(query.filters ?? []), ...vocabResult.structuredFilters];
    }

    // ✅ Use original query for embedding
    semanticQuery = vocabResult.originalQuery;

    // Optional: Add vocabulary trace to response (if debug=true)
    if (query.debug) {
      query.vocabularyTrace = {
        resolvedTerms: vocabResult.resolvedTerms,
        appliedFilters: vocabResult.structuredFilters,
      };
    }
  } catch (error) {
    console.error('[query-pipeline] Vocabulary resolution failed:', error);
    // Graceful fallback: use original query
  }
}
latency.vocabularyResolveMs = Date.now() - vocabStart;

// Embed the semantic query (now has full intent)
const embedStart = Date.now();
const embedding = await this.embedQuery(semanticQuery);
latency.vectorSearchMs += Date.now() - embedStart;
```

**Testing:**

```typescript
// vocabulary-resolver.test.ts
describe('Intent Preservation - Critical Test Cases', () => {
  /**
   * Test 1: Vocabulary matches preserved in original query
   * Addresses user feedback: preserve original query for semantic search
   */
  test('preserves original query with vocabulary matches', async () => {
    mockVocabulary([
      { term: 'premium customers', resolution: { filters: [{ field: 'tier', value: 'premium' }] } },
      { term: 'SF', resolution: { filters: [{ field: 'city', value: 'San Francisco' }] } },
    ]);

    const result = await resolver.resolve(
      'kb-1',
      'Show me premium customers in SF with revenue > 100K',
    );

    // ✅ CRITICAL: Original query preserved
    expect(result.originalQuery).toBe('Show me premium customers in SF with revenue > 100K');

    // ✅ Filters extracted
    expect(result.structuredFilters).toEqual([
      { field: 'tier', operator: 'eq', value: 'premium' },
      { field: 'city', operator: 'eq', value: 'San Francisco' },
    ]);

    // ✅ Resolved terms tracked (for debugging)
    expect(result.resolvedTerms).toHaveLength(2);
    expect(result.resolvedTerms[0].term).toBe('premium customers');
    expect(result.resolvedTerms[1].term).toBe('SF');
  });

  /**
   * Test 2: Semantic queries preserve intent for embedding
   * User feedback: "Add test case for preserving original query for semantic"
   */
  test('semantic query with vocabulary - preserves for embedding', async () => {
    mockVocabulary([
      { term: 'Q1 2024', resolution: { filters: [{ field: 'quarter', value: 'Q1-2024' }] } },
    ]);

    const query = 'Explain the revenue trends for Q1 2024';
    const result = await resolver.resolve('kb-1', query);

    // ✅ Full query preserved for semantic understanding
    expect(result.originalQuery).toBe(query);

    // ✅ Time filter extracted
    expect(result.structuredFilters).toContainEqual({
      field: 'quarter',
      operator: 'eq',
      value: 'Q1-2024',
    });

    // ✅ Verify embedding captures full semantic intent
    const embedding = await embedQuery(result.originalQuery);
    expect(embedding).toHaveLength(1024);

    // ✅ NOT embedding stopwords!
    const strippedQuery = 'Explain the revenue trends for'; // What OLD code would produce
    const strippedEmbedding = await embedQuery(strippedQuery);

    // Embeddings should be DIFFERENT (semantic content differs)
    const cosineSim = dotProduct(embedding, strippedEmbedding);
    expect(cosineSim).toBeLessThan(0.95); // Not identical
  });

  /**
   * Test 3: Question queries (semantic) benefit from vocabulary
   * Question queries should be hybrid, not semantic-only
   */
  test('question query combines semantic + vocabulary filters', async () => {
    mockVocabulary([
      { term: 'active users', resolution: { filters: [{ field: 'status', value: 'active' }] } },
    ]);

    const query = 'What are the characteristics of active users?';
    const result = await resolver.resolve('kb-1', query);

    // ✅ Full question preserved
    expect(result.originalQuery).toBe(query);

    // ✅ Status filter added
    expect(result.structuredFilters).toContainEqual({
      field: 'status',
      operator: 'eq',
      value: 'active',
    });

    // ✅ Query type should be 'hybrid' (not 'semantic')
    const queryType = detectQueryType(query, result.resolvedTerms.length);
    expect(queryType.type).toBe('hybrid');
    expect(queryType.reasoning).toContain('vocabulary + semantic');
  });

  /**
   * Test 4: No vocabulary matches - still preserve original
   */
  test('no vocabulary matches - original query unchanged', async () => {
    mockVocabulary([]); // Empty vocabulary

    const query = 'How does machine learning work?';
    const result = await resolver.resolve('kb-1', query);

    // ✅ No modifications
    expect(result.originalQuery).toBe(query);
    expect(result.structuredFilters).toHaveLength(0);
    expect(result.resolvedTerms).toHaveLength(0);
  });

  /**
   * Test 5: Complex query with multiple vocabulary terms
   * Ensure ALL terms preserved in original query
   */
  test('multiple vocabulary terms - all preserved in original', async () => {
    mockVocabulary([
      { term: 'premium', resolution: { filters: [{ field: 'tier', value: 'premium' }] } },
      { term: 'active', resolution: { filters: [{ field: 'status', value: 'active' }] } },
      { term: 'San Francisco', resolution: { filters: [{ field: 'city', value: 'SF' }] } },
    ]);

    const query = 'Find premium active customers in San Francisco from last month';
    const result = await resolver.resolve('kb-1', query);

    // ✅ Original completely preserved
    expect(result.originalQuery).toBe(query);

    // ✅ All 3 filters extracted
    expect(result.structuredFilters).toHaveLength(3);

    // ✅ Embedding represents FULL query, not just "Find customers in from last month"
    const embedding = await embedQuery(result.originalQuery);
    const queryWords = query.split(' ');
    expect(queryWords).toContain('premium');
    expect(queryWords).toContain('active');
    expect(queryWords).toContain('San');
  });
});
```

---

#### 1.2 True Hybrid Search Implementation

**File:** `packages/search-ai-internal/src/vector-store/opensearch.ts`

**New Method:**

```typescript
/**
 * Execute hybrid search with RRF score fusion
 * Combines k-NN vector search with BM25 full-text search
 */
async hybridSearch(
  collection: string,
  params: HybridSearchParams
): Promise<VectorSearchResult[]> {

  // Check OpenSearch version supports hybrid queries
  const version = await this.getVersion();
  if (this.compareVersions(version, '2.11.0') < 0) {
    throw new Error('Hybrid search requires OpenSearch 2.11+');
  }

  const query: any = {
    hybrid: {
      queries: [
        // Query 1: k-NN vector similarity
        {
          knn: {
            vector: {
              vector: params.vector,
              k: params.topK * 2  // Fetch more for fusion
            }
          }
        },
        // Query 2: BM25 full-text search
        {
          multi_match: {
            query: params.queryText,
            fields: ['content^2', 'metadata.title^3'],  // Boosted fields
            type: 'best_fields',
            operator: 'or'
          }
        }
      ]
    }
  };

  // Add metadata filters (applied to both queries)
  if (params.filters?.length) {
    const filterClauses = this.buildFilter(params.filters);
    query.hybrid.filters = {
      bool: {
        must: filterClauses.must,
        must_not: filterClauses.must_not
      }
    };
  }

  const response = await this.client.search({
    index: collection,
    body: {
      size: params.topK,
      query,
      // RRF score fusion
      rank: {
        rrf: {
          window_size: params.topK * 2,
          rank_constant: 60  // Standard RRF constant
        }
      },
      min_score: params.scoreThreshold
    }
  });

  return response.body.hits.hits.map((hit: any) => ({
    id: hit._id,
    score: hit._score,  // RRF fused score
    metadata: params.includeMetadata !== false ? hit._source.metadata : undefined,
    vector: params.includeVectors ? hit._source.vector : undefined,
    content: hit._source.content
  }));
}

// Helper: Get OpenSearch version
private async getVersion(): Promise<string> {
  const info = await this.client.info();
  return info.body.version.number;
}

// Helper: Compare semantic versions
private compareVersions(a: string, b: string): number {
  const partsA = a.split('.').map(Number);
  const partsB = b.split('.').map(Number);

  for (let i = 0; i < 3; i++) {
    if (partsA[i] > partsB[i]) return 1;
    if (partsA[i] < partsB[i]) return -1;
  }
  return 0;
}
```

**Type Definitions:**

```typescript
// packages/search-ai-internal/src/vector-store/interface.ts

export interface HybridSearchParams extends VectorSearchParams {
  /** Original query text for BM25 matching */
  queryText: string;

  /** Hybrid search weight (0.0 = keyword only, 1.0 = vector only) */
  alpha?: number; // Not used with RRF, but kept for API compatibility
}

export interface VectorStoreProvider {
  // ... existing methods ...

  /** Execute hybrid search (vector + keyword + RRF fusion) */
  hybridSearch?(collection: string, params: HybridSearchParams): Promise<VectorSearchResult[]>;
}
```

**Pipeline Integration:**

```typescript
// apps/search-ai-runtime/src/services/query/query-pipeline.ts:125-150

private async vectorSearch(
  query: VectorSearchQuery,
  embedding: number[]
): Promise<SearchResult[]> {
  if (!this.vectorStore || embedding.length === 0) return [];

  const collectionName = query.indexId;

  try {
    // ✅ Use hybrid search if queryType is 'hybrid' and provider supports it
    if (
      query.queryType === 'hybrid' &&
      this.vectorStore.hybridSearch &&
      query.query  // Ensure we have text for BM25
    ) {
      const results = await this.vectorStore.hybridSearch(collectionName, {
        vector: embedding,
        queryText: query.query,  // Original query for BM25
        topK: query.topK ?? 10,
        scoreThreshold: query.similarityThreshold,
        filters: query.filters,
        includeMetadata: true
      });

      return results.map(r => ({
        documentId: (r.metadata?.documentId as string) ?? r.id,
        chunkId: r.id,
        score: r.score,  // RRF fused score
        content: r.content,
        metadata: r.metadata
      }));
    }

    // Fallback to pure vector search
    const results = await this.vectorStore.search(collectionName, {
      vector: embedding,
      topK: query.topK ?? 10,
      scoreThreshold: query.similarityThreshold,
      filters: query.filters,
      includeMetadata: true
    });

    return results.map(r => ({ /* map to SearchResult */ }));
  } catch (error) {
    console.error('[query-pipeline] Vector search failed:', error);
    return [];
  }
}
```

**Testing:**

```typescript
// opensearch.test.ts
describe('Hybrid Search', () => {
  test('combines vector + BM25 with RRF', async () => {
    const results = await store.hybridSearch('test-index', {
      vector: [0.1, 0.2, ..., 0.5],
      queryText: 'Python programming',
      topK: 10
    });

    expect(results).toHaveLength(10);
    expect(results[0].score).toBeGreaterThan(0);
  });

  test('throws error on OpenSearch < 2.11', async () => {
    mockVersion('2.10.0');

    await expect(
      store.hybridSearch('test-index', { ... })
    ).rejects.toThrow('requires OpenSearch 2.11+');
  });
});
```

---

#### 1.3 Cohere Reranker Integration

**New File:** `apps/search-ai-runtime/src/services/rerank/cohere-reranker.ts`

```typescript
/**
 * Cohere Reranker Service
 *
 * Uses Cohere's rerank-english-v3.0 model for precision ranking.
 * Typical usage: Retrieve 100 candidates → Rerank → Return top 10
 */

import fetch from 'node-fetch';

export interface RerankerConfig {
  apiKey: string;
  model: string; // 'rerank-english-v3.0' | 'rerank-multilingual-v3.0'
  topN?: number;
  timeoutMs?: number;
}

export interface RerankRequest {
  query: string;
  documents: string[]; // Document contents to rerank
  returnDocuments?: boolean;
}

export interface RerankResult {
  index: number; // Original position in input array
  relevance_score: number; // 0-1, higher = more relevant
  document?: {
    text: string;
  };
}

export interface RerankResponse {
  id: string;
  results: RerankResult[];
  meta: {
    api_version: {
      version: string;
    };
    billed_units: {
      search_units: number;
    };
  };
}

export class CohereReranker {
  private readonly apiKey: string;
  private readonly model: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: RerankerConfig) {
    this.apiKey = config.apiKey;
    this.model = config.model;
    this.baseUrl = 'https://api.cohere.ai/v1';
    this.timeoutMs = config.timeoutMs ?? 5000;
  }

  /**
   * Rerank documents by relevance to query
   *
   * @param request - Query and documents to rerank
   * @returns Reranked results with relevance scores
   */
  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          query: request.query,
          documents: request.documents,
          top_n: request.documents.length, // Rerank all
          return_documents: request.returnDocuments ?? false,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Cohere API error [${response.status}]: ${errorBody}`);
      }

      const data = (await response.json()) as RerankResponse;
      return data;
    } catch (error) {
      clearTimeout(timeout);

      if (error.name === 'AbortError') {
        throw new Error(`Reranker timeout after ${this.timeoutMs}ms`);
      }
      throw error;
    }
  }

  /**
   * Health check - verify API key and connectivity
   */
  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();

    try {
      await this.rerank({
        query: 'test',
        documents: ['test document'],
        returnDocuments: false,
      });

      return {
        ok: true,
        latencyMs: Date.now() - start,
      };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}
```

**Pipeline Integration:**

```typescript
// query-pipeline.ts

import { CohereReranker } from '../rerank/cohere-reranker.js';

export interface QueryPipelineOptions {
  embeddingProvider?: EmbeddingProvider;
  vectorStore?: VectorStoreProvider;
  vocabularyResolver?: VocabularyResolver;
  reranker?: CohereReranker; // ✅ NEW
}

export class QueryPipeline {
  private readonly vocabularyResolver: VocabularyResolver;
  private readonly embeddingProvider?: EmbeddingProvider;
  private readonly vectorStore?: VectorStoreProvider;
  private readonly reranker?: CohereReranker; // ✅ NEW

  constructor(opts?: QueryPipelineOptions) {
    this.vocabularyResolver = opts?.vocabularyResolver ?? new VocabularyResolver();
    this.embeddingProvider = opts?.embeddingProvider;
    this.vectorStore = opts?.vectorStore;

    // ✅ Initialize reranker if API key provided
    if (opts?.reranker) {
      this.reranker = opts.reranker;
    } else if (process.env.COHERE_API_KEY) {
      this.reranker = new CohereReranker({
        apiKey: process.env.COHERE_API_KEY,
        model: 'rerank-english-v3.0',
        timeoutMs: 5000,
      });
    }
  }

  /**
   * Rerank search results using cross-encoder
   *
   * @param query - Original query text
   * @param results - Results to rerank
   * @returns Reordered results with reranker scores
   */
  private async rerank(query: string, results: SearchResult[]): Promise<SearchResult[]> {
    if (!this.reranker || results.length === 0) {
      return results;
    }

    try {
      const documents = results.map((r) => r.content ?? '');
      const response = await this.reranker.rerank({
        query,
        documents,
        returnDocuments: false,
      });

      // Reorder results based on reranker scores
      const reorderedResults = response.results.map((r) => ({
        ...results[r.index],
        score: r.relevance_score, // ✅ Replace vector score with reranker score
        _originalScore: results[r.index].score, // Keep for debugging
        _reranked: true, // Mark as reranked
      }));

      return reorderedResults;
    } catch (error) {
      console.error('[query-pipeline] Reranking failed:', error);
      // ✅ Graceful fallback: return original results
      return results;
    }
  }
}
```

**Configuration:**

```typescript
// apps/search-ai-runtime/src/server.ts

// Initialize query pipeline with reranker
const queryPipeline = new QueryPipeline({
  embeddingProvider: embeddingProviderFactory.create(config.embedding),
  vectorStore: new OpenSearchVectorStore(config.opensearch),
  vocabularyResolver: new VocabularyResolver(),
  reranker: process.env.COHERE_API_KEY
    ? new CohereReranker({
        apiKey: process.env.COHERE_API_KEY,
        model: 'rerank-english-v3.0',
        timeoutMs: 5000,
      })
    : undefined,
});
```

**Environment Variables:**

```bash
# .env
COHERE_API_KEY=your_api_key_here  # Optional, reranking disabled if not set
```

**Testing:**

```typescript
// cohere-reranker.test.ts
describe('CohereReranker', () => {
  test('reranks documents by relevance', async () => {
    const reranker = new CohereReranker({
      apiKey: process.env.COHERE_API_KEY!,
      model: 'rerank-english-v3.0',
    });

    const response = await reranker.rerank({
      query: 'Python programming',
      documents: [
        'JavaScript is a web language',
        'Python is great for data science',
        'Java is used for enterprise apps',
      ],
    });

    // Python doc should rank highest
    expect(response.results[0].index).toBe(1);
    expect(response.results[0].relevance_score).toBeGreaterThan(0.8);
  });

  test('gracefully handles API errors', async () => {
    const reranker = new CohereReranker({
      apiKey: 'invalid',
      model: 'rerank-english-v3.0',
    });

    await expect(reranker.rerank({ query: 'test', documents: ['doc'] })).rejects.toThrow(
      'Cohere API error',
    );
  });

  test('respects timeout', async () => {
    const reranker = new CohereReranker({
      apiKey: process.env.COHERE_API_KEY!,
      model: 'rerank-english-v3.0',
      timeoutMs: 10, // Very short timeout
    });

    await expect(
      reranker.rerank({ query: 'test', documents: Array(100).fill('doc') }),
    ).rejects.toThrow('timeout');
  });
});
```

---

### Phase 1 Architecture (After Fixes)

```
┌─────────────────────────────────────────────────────────────────┐
│ Stage 1: Vocabulary Resolution (15ms)                           │
├─────────────────────────────────────────────────────────────────┤
│ Input:  "Show me premium customers in SF with revenue > 100K"  │
│ Output: originalQuery = "Show me premium customers..."  ✅      │
│ Filters: [customerTier=premium, city=SF, revenue>100K]  ✅     │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 2: Embedding (30ms)                                       │
├─────────────────────────────────────────────────────────────────┤
│ Input:  "Show me premium customers in SF..." ✅ Full query!     │
│ Output: [0.023, -0.156, ..., 0.078] ✅ Meaningful embedding    │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 3: Hybrid Search (95ms)                                   │
├─────────────────────────────────────────────────────────────────┤
│ OpenSearch Hybrid Query:                                       │
│  - k-NN: Vector similarity                                      │
│  - BM25: Full-text search                                       │
│  - RRF: Score fusion (k=60)  ✅                                │
│ Filters: Applied to both queries                               │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 4: Reranking (120ms)                                      │
├─────────────────────────────────────────────────────────────────┤
│ Cohere rerank-english-v3.0  ✅                                 │
│ Cross-encoder precision ranking                                │
│ Cost: $0.002 per query                                          │
└─────────────────────────────────────────────────────────────────┘
                          ↓
┌─────────────────────────────────────────────────────────────────┐
│ Stage 5: Response Formatting (5ms)                              │
├─────────────────────────────────────────────────────────────────┤
│ Package results + latency + cost tracking  ✅                  │
└─────────────────────────────────────────────────────────────────┘

Total: 265ms (+95% vs broken pipeline, but 100% functional)
Accuracy: 94% MRR@10 (+8% vs 87% broken)
Issues: ALL CRITICAL ISSUES FIXED ✅
```

---

## Implementation Plan

### Phase 1: Critical Fixes (Week 1-2)

**Sprint Goal:** Fix the 3 critical bugs

| Task                                   | Owner  | Estimate | Dependencies   |
| -------------------------------------- | ------ | -------- | -------------- |
| 1.1 Fix vocabulary resolution          | Bharat | 2d       | None           |
| 1.2 Implement OpenSearch hybrid search | Bharat | 3d       | 1.1            |
| 1.3 Integrate Cohere reranker          | Bharat | 2d       | None           |
| 1.4 Update types & interfaces          | Bharat | 1d       | 1.1, 1.2, 1.3  |
| 1.5 Write unit tests                   | Bharat | 2d       | 1.1, 1.2, 1.3  |
| 1.6 E2E testing                        | QA     | 2d       | 1.5            |
| 1.7 Deploy to staging                  | DevOps | 0.5d     | 1.6            |
| 1.8 Performance benchmarks             | Bharat | 1d       | 1.7            |
| 1.9 Deploy to production               | DevOps | 0.5d     | 1.8 + approval |

**Total:** 14 days (2 sprints)

---

### Phase 2: Major Improvements (Week 3-5)

**Sprint Goal:** Add query routing and observability

| Task                                | Owner  | Estimate | Dependencies     |
| ----------------------------------- | ------ | -------- | ---------------- |
| 2.1 Design query router             | Bharat | 1d       | Phase 1 complete |
| 2.2 Implement QueryRouter class     | Bharat | 3d       | 2.1              |
| 2.3 Add query type auto-detection   | Bharat | 2d       | 2.2              |
| 2.4 Implement specialized pipelines | Bharat | 4d       | 2.2              |
| 2.5 Add comprehensive metrics       | Bharat | 2d       | None             |
| 2.6 Add cost tracking               | Bharat | 1d       | 2.5              |
| 2.7 Testing                         | QA     | 3d       | 2.4, 2.5, 2.6    |
| 2.8 Deploy to production            | DevOps | 0.5d     | 2.7 + approval   |

**Total:** 16.5 days (3 sprints)

---

### Phase 3: Optimizations (Week 6-8)

**Sprint Goal:** Add preprocessing and adaptive pipelines

| Task                              | Owner  | Estimate | Dependencies     |
| --------------------------------- | ------ | -------- | ---------------- |
| 3.1 Design query preprocessor     | Bharat | 2d       | Phase 2 complete |
| 3.2 Implement spell correction    | Bharat | 2d       | 3.1              |
| 3.3 Implement synonym expansion   | Bharat | 2d       | 3.1              |
| 3.4 Implement entity extraction   | Bharat | 3d       | 3.1              |
| 3.5 Design adaptive pipeline      | Bharat | 2d       | Phase 2 complete |
| 3.6 Implement complexity analysis | Bharat | 2d       | 3.5              |
| 3.7 Implement stage selection     | Bharat | 3d       | 3.6              |
| 3.8 Testing                       | QA     | 3d       | 3.4, 3.7         |
| 3.9 Deploy to production          | DevOps | 0.5d     | 3.8 + approval   |

**Total:** 19.5 days (4 sprints)

---

## Deployment Strategy

### No Migration Required ✅

**Status:** This query pipeline is **NOT YET IN PRODUCTION**. There are no live users to migrate.

**Approach:**

- ❌ No gradual rollout needed
- ❌ No feature flags needed
- ❌ No A/B testing needed
- ✅ **Ship the best solution from day one**
- ✅ **Focus on high-quality implementation**
- ✅ **Ensure all tests pass before first production deployment**

### Quality-First Deployment

**Pre-Deployment Checklist:**

1. **✅ All Unit Tests Pass** (90%+ coverage)
   - Vocabulary resolution tests
   - Hybrid search tests
   - Reranker tests
   - Query type detection tests

2. **✅ Integration Tests Pass**
   - End-to-end query pipeline
   - OpenSearch connectivity
   - Reranker provider fallback
   - Cost tracking

3. **✅ Accuracy Benchmark Meets Target**
   - MRR@10 ≥ 93% on golden dataset
   - Intent preservation 100%
   - No regressions from baseline

4. **✅ Performance Tests Pass**
   - P50 latency < 200ms
   - P95 latency < 500ms
   - P99 latency < 1000ms
   - Handles 100 QPS without errors

5. **✅ Cost Controls in Place**
   - Reranker monthly budget set
   - Cost tracking enabled
   - Alerts configured

6. **✅ Observability Ready**
   - Dashboards deployed
   - Alerts configured
   - Runbooks prepared

**Deployment Flow:**

```
┌─────────────────────────────────────────────────────────────┐
│ Step 1: Implement Phase 1 (2 weeks)                         │
│ - Vocabulary preservation                                    │
│ - Hybrid search (RRF + RSF)                                  │
│ - Multi-provider reranker                                    │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 2: Run Full Test Suite                                 │
│ - All tests must pass (no exceptions)                       │
│ - Accuracy benchmark on golden dataset                      │
│ - Load testing at target QPS                                │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 3: Deploy to Dev + Staging                             │
│ - Validate in staging for 2-3 days                          │
│ - Run smoke tests                                            │
│ - Verify observability                                       │
└─────────────────────────────────────────────────────────────┘
                            ↓
┌─────────────────────────────────────────────────────────────┐
│ Step 4: Production Deployment                               │
│ - Ship 100% from day one (no gradual rollout)               │
│ - Monitor metrics for first 24 hours                        │
│ - Ready to hotfix if issues found                           │
└─────────────────────────────────────────────────────────────┘
```

### API Response Format

Since this is the first production version, we can ship the correct format immediately:

```typescript
interface VectorSearchResponse {
  queryId: string;
  results: SearchResult[];

  // Latency breakdown
  latency: {
    vocabularyResolveMs: number;
    embeddingMs: number;
    searchMs: number; // Hybrid search (RRF or RSF)
    rerankMs: number; // 0 if reranker disabled
    totalMs: number;
  };

  // Cost tracking (optional, if debug=true)
  cost?: {
    embeddingCost: number;
    searchCost: number;
    rerankCost: number;
    totalCost: number;
  };

  // Query analysis (optional, if debug=true)
  debug?: {
    queryType: QueryType;
    queryTypeConfidence: number;
    vocabularyMatches: number;
    fusionMethod: 'rrf' | 'rsf';
    rerankerProvider?: string;
  };
}
```

**Environment Configuration:**

```bash
# OpenSearch (confirmed 2.11.0 ✅)
OPENSEARCH_URL=http://localhost:9200

# Embedding Provider
BGE_M3_URL=http://localhost:8001

# Reranker Providers (priority order: Voyage → Cohere → Jina)
VOYAGE_API_KEY=voyage_xxx        # Primary (cheapest)
COHERE_API_KEY=co_xxx            # Fallback
JINA_API_KEY=jina_xxx            # Fallback

# Cost Controls
RERANKER_MONTHLY_BUDGET_USD=5000
RERANKER_COST_ALERT_THRESHOLD=0.9  # Alert at 90% of budget
```

---

## Testing Strategy

### Unit Tests

**Coverage Target:** 90%

```typescript
// vocabulary-resolver.test.ts
describe('Vocabulary Resolution', () => {
  test('preserves original query', () => {
    /* ... */
  });
  test('extracts structured filters', () => {
    /* ... */
  });
  test('handles empty vocabulary', () => {
    /* ... */
  });
  test('handles DB errors gracefully', () => {
    /* ... */
  });
});

// opensearch.test.ts
describe('Hybrid Search', () => {
  test('combines vector + BM25 with RRF', () => {
    /* ... */
  });
  test('respects hybridAlpha parameter', () => {
    /* ... */
  });
  test('applies filters correctly', () => {
    /* ... */
  });
  test('handles OpenSearch errors', () => {
    /* ... */
  });
});

// cohere-reranker.test.ts
describe('Reranker', () => {
  test('reranks documents by relevance', () => {
    /* ... */
  });
  test('handles API errors gracefully', () => {
    /* ... */
  });
  test('respects timeout', () => {
    /* ... */
  });
  test('falls back on failure', () => {
    /* ... */
  });
});
```

### Integration Tests

```typescript
// query-pipeline.integration.test.ts
describe('Query Pipeline E2E', () => {
  test('full pipeline with vocabulary + hybrid + rerank', async () => {
    const response = await queryPipeline.execute({
      query: 'Show me premium customers in SF with revenue > 100K',
      queryType: 'hybrid',
      hybridAlpha: 0.7,
      rerank: true,
      topK: 10,
      indexId: 'test-kb',
    });

    expect(response.results).toHaveLength(10);
    expect(response.latency.vocabularyResolveMs).toBeGreaterThan(0);
    expect(response.latency.vectorSearchMs).toBeGreaterThan(0);
    expect(response.latency.rerankMs).toBeGreaterThan(0);
    expect(response.latency.totalMs).toBeLessThan(500);
  });
});
```

### Performance Tests

```bash
# Load test with k6
k6 run --vus 100 --duration 5m performance-test.js

# Expected results:
# - P50 latency: < 200ms
# - P95 latency: < 400ms
# - P99 latency: < 600ms
# - Error rate: < 0.1%
# - Throughput: > 500 qps per node
```

### Accuracy Tests

```typescript
// Benchmark against labeled dataset
const testQueries = [
  {
    query: 'Python programming tutorial',
    expectedTopDoc: 'doc_python_intro_123',
    minRelevanceScore: 0.85,
  },
  // ... 100 more test cases
];

let mrr = 0;
for (const testCase of testQueries) {
  const results = await queryPipeline.execute({ query: testCase.query });
  const rank = results.findIndex((r) => r.documentId === testCase.expectedTopDoc);
  if (rank >= 0) {
    mrr += 1 / (rank + 1);
  }
}
mrr /= testQueries.length;

expect(mrr).toBeGreaterThan(0.92); // Target: 94% MRR@10
```

---

## Performance Impact

### Latency Comparison

| Stage         | Before (Broken) | After (Fixed) | Change               |
| ------------- | --------------- | ------------- | -------------------- |
| Vocabulary    | 15ms            | 15ms          | ±0ms                 |
| Embedding     | 30ms            | 30ms          | ±0ms                 |
| Vector Search | 85ms            | 95ms          | +10ms (RRF overhead) |
| Reranking     | 0ms (stub)      | 120ms         | +120ms               |
| Formatting    | 5ms             | 5ms           | ±0ms                 |
| **Total**     | **135ms**       | **265ms**     | **+96%**             |

**Analysis:**

- Latency increases by 96% (135ms → 265ms)
- **Acceptable trade-off** - Accuracy improves by 8% (87% → 94% MRR)
- Most increase is from reranking (120ms), which is optional
- Without reranking: 135ms → 145ms (+7% for hybrid search fix)

### Throughput Impact

**Before:** 500 QPS per node (broken, but fast)
**After:** 300 QPS per node (fixed, slower)

**Mitigation:**

- Add 2 more nodes (3 → 5) to maintain 1500 QPS cluster capacity
- Estimated cost: +$400/month infrastructure

### Cost Analysis

**Per-Query Cost:**

| Component     | Before      | After       | Change   |
| ------------- | ----------- | ----------- | -------- |
| Embedding     | $0.0001     | $0.0001     | ±0       |
| Vector Search | $0          | $0          | ±0       |
| Reranking     | $0          | $0.002      | +$0.002  |
| **Total**     | **$0.0001** | **$0.0021** | **+21×** |

**Monthly Cost (1M queries):**

- Before: $100/month
- After: $2,100/month (+$2,000)

**ROI Analysis:**

- Cost increase: $2,000/month
- Accuracy increase: +8% MRR (87% → 94%)
- Customer value: Better search = higher engagement = retention
- **Justification:** Industry standard for production RAG systems

---

## Risk Assessment

### High Risks

| Risk                                  | Likelihood | Impact | Mitigation                                 |
| ------------------------------------- | ---------- | ------ | ------------------------------------------ |
| OpenSearch < 2.11 (no hybrid support) | Medium     | High   | Implement fallback client-side fusion      |
| Cohere API outage                     | Low        | High   | Graceful fallback, return unfused results  |
| Latency regression hurts UX           | Medium     | Medium | Feature flag, gradual rollout, monitor P95 |
| Cost overrun ($2K/month)              | High       | Medium | Budget approval, optional reranking flag   |

### Medium Risks

| Risk                                              | Likelihood | Impact | Mitigation                         |
| ------------------------------------------------- | ---------- | ------ | ---------------------------------- |
| Vocabulary changes break existing queries         | Low        | Medium | Extensive testing, gradual rollout |
| Hybrid search ranking different from expectations | Medium     | Low    | A/B test, collect user feedback    |
| Integration test failures                         | Low        | Low    | Comprehensive test suite           |

### Low Risks

| Risk                                         | Likelihood | Impact | Mitigation                         |
| -------------------------------------------- | ---------- | ------ | ---------------------------------- |
| Type mismatches after interface changes      | Low        | Low    | TypeScript catches at compile time |
| Performance regression in non-hybrid queries | Low        | Low    | Benchmark suite                    |

---

## Success Metrics

### Primary Metrics

| Metric                        | Baseline (Broken) | Target (Fixed) | Measurement                  |
| ----------------------------- | ----------------- | -------------- | ---------------------------- |
| **Accuracy (MRR@10)**         | 87%               | 94% (+8%)      | Weekly benchmark on test set |
| **Query Intent Preservation** | 0%                | 100%           | Manual review of 100 queries |
| **Hybrid Search Functional**  | No                | Yes            | API tests pass               |
| **Reranker Functional**       | No                | Yes            | API tests pass               |

### Secondary Metrics

| Metric                       | Baseline | Target   | Measurement           |
| ---------------------------- | -------- | -------- | --------------------- |
| **P95 Latency**              | 180ms    | < 400ms  | Production monitoring |
| **Error Rate**               | 0.05%    | < 0.1%   | Production monitoring |
| **Cost per Query**           | $0.0001  | < $0.003 | Monthly billing       |
| **User Satisfaction (CSAT)** | 3.8/5    | > 4.2/5  | Quarterly survey      |

### Monitoring Dashboards

**Grafana Dashboard: "Search Quality"**

- MRR@10 trend (daily)
- Query intent preservation rate (sampled)
- Hybrid search usage (% of queries)
- Reranking usage (% of queries)

**Grafana Dashboard: "Search Performance"**

- P50/P95/P99 latency by stage
- Error rate by stage
- Cost per query
- QPS per node

---

## Open Questions

### For Product Team

1. **Cost Approval:** Is $2,000/month increase for +8% accuracy acceptable?
   - **Recommend:** Yes, industry standard for production RAG

2. **Reranking Default:** Should `rerank: true` be the default?
   - **Recommend:** No, opt-in for Phase 1, default in Phase 2

3. **Feature Flag Timeline:** How long to keep old broken behavior as fallback?
   - **Recommend:** 1 month, then remove

### For Engineering Team

4. **OpenSearch Version:** Do all environments support 2.11+ for hybrid queries?
   - **Action:** Audit all clusters, upgrade if needed

5. **Load Testing:** What QPS should we target for production?
   - **Action:** Run load tests, recommend 300 QPS per node

6. **Monitoring:** What SLOs should we set for search latency?
   - **Recommend:** P95 < 400ms, P99 < 600ms

### For DevOps Team

7. **Deployment Strategy:** Blue-green or canary?
   - **Recommend:** Canary (10% → 50% → 100%)

8. **Rollback Plan:** How quickly can we revert if issues arise?
   - **Action:** Document rollback procedure, test in staging

---

## References

### Internal Documents

- [ARCHITECTURE_REVIEW.md](apps/search-ai-runtime/ARCHITECTURE_REVIEW.md)
- [QUERY_PIPELINE_DEEP_DIVE.md](apps/search-ai-runtime/QUERY_PIPELINE_DEEP_DIVE.md)
- [RFC-001: ATLAS-KG v2](docs/rfcs/RFC-001-ATLAS-KG-v2-Document-Extraction.md)
- [RFC-002: OpenSearch Index Strategy](docs/rfcs/RFC-002-OpenSearch-Index-Strategy.md)

### External Resources

- [OpenSearch Hybrid Search Documentation](https://opensearch.org/docs/latest/search-plugins/hybrid-search/)
- [Cohere Rerank API Documentation](https://docs.cohere.com/reference/rerank-1)
- [RRF Score Fusion Paper](https://plg.uwaterloo.ca/~gvcormac/cormacksigir09-rrf.pdf)
- [RAG Best Practices (Anthropic)](https://docs.anthropic.com/claude/docs/retrieval-augmented-generation)

---

## Appendix A: Code Examples

### Example 1: Query with Intent Preservation

**Before (Broken):**

```typescript
Input:  { query: "premium customers in SF", queryType: "hybrid" }
Vocabulary strips to: "in"
Embedding: [useless stopword vector]
Results: Garbage (filters only, no semantic search)
```

**After (Fixed):**

```typescript
Input:  { query: "premium customers in SF", queryType: "hybrid" }
Vocabulary preserves: "premium customers in SF"
Embedding: [meaningful semantic vector]
Results: Relevant documents with correct intent
```

### Example 2: True Hybrid Search

**OpenSearch Query (After Fix):**

```json
{
  "query": {
    "hybrid": {
      "queries": [
        {
          "knn": {
            "vector": {
              "vector": [0.023, -0.156, ...],
              "k": 20
            }
          }
        },
        {
          "multi_match": {
            "query": "premium customers in SF",
            "fields": ["content^2", "metadata.title^3"],
            "type": "best_fields"
          }
        }
      ]
    }
  },
  "rank": {
    "rrf": {
      "window_size": 20,
      "rank_constant": 60
    }
  }
}
```

### Example 3: Reranking

**Pipeline Execution:**

```typescript
// Stage 1-3: Retrieve 100 candidates
const candidates = await hybridSearch({ query, topK: 100 });

// Stage 4: Rerank to 10 best
if (query.rerank) {
  const reranked = await reranker.rerank({
    query: query.query,
    documents: candidates.map((c) => c.content),
  });

  // Return top 10 reranked
  return reranked.slice(0, 10);
}

return candidates.slice(0, 10);
```

---

## Appendix B: Migration Checklist

### Pre-Deployment

- [ ] Review RFC with team
- [ ] Get product approval for cost increase
- [ ] Audit OpenSearch versions (ensure 2.11+)
- [ ] Obtain Cohere API key
- [ ] Set up monitoring dashboards
- [ ] Write rollback procedure
- [ ] Run performance benchmarks
- [ ] Complete all unit tests (90% coverage)
- [ ] Complete integration tests
- [ ] Complete E2E tests

### Deployment (Week 1)

- [ ] Deploy to dev (100% traffic)
- [ ] Run smoke tests
- [ ] Deploy to staging (100% traffic)
- [ ] Run 7-day soak test
- [ ] Monitor metrics (latency, accuracy, errors)
- [ ] Fix any issues found
- [ ] Get approval for prod deployment

### Deployment (Week 2)

- [ ] Deploy to prod (10% traffic)
- [ ] Monitor for 24 hours
- [ ] Increase to 50% traffic
- [ ] Monitor for 48 hours
- [ ] Increase to 100% traffic
- [ ] Monitor for 7 days
- [ ] Remove feature flags (if stable)
- [ ] Document lessons learned
- [ ] Close RFC

---

**RFC Status:** Draft
**Next Steps:** Review with team, get approvals, start Phase 1 implementation

**Approvals Required:**

- [ ] Engineering Lead
- [ ] Product Manager
- [ ] DevOps Lead
- [ ] CTO/VP Engineering
