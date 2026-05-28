# Reranking Strategies

**Status:** ✅ Production
**Feature:** RFC-003 Multi-Provider Reranking
**Service:** `RerankerFactory`, `BatchedRerankerFactory`
**Cost:** $0.50/1K (Voyage AI) - $2.00/1K (Cohere)
**Last Updated:** 2026-02-24

---

## Overview

Reranking improves search result quality by re-scoring initial retrieval results using more sophisticated models. After vector search returns top-K candidates, a reranker evaluates each candidate's relevance to the query and re-orders them for optimal ranking.

**Key Concept:**

```
User Query: "How to authenticate?"
   ↓
1. Vector Search (fast, broad recall)
   Returns: 100 candidates (similarity-based, not all highly relevant)
   ↓
2. Reranking (slower, precise relevance scoring)
   Evaluates: Query + each candidate → relevance score
   ↓
3. Re-ordered Results
   Returns: Top 10 most relevant (reranked by cross-encoder model)
```

**Benefits:**

- **Higher precision**: Rerankers evaluate query-document pairs jointly (vs. separate embeddings)
- **Better ranking**: Top results are significantly more relevant
- **Domain-aware**: Rerankers trained on search/retrieval tasks
- **Multi-provider fallback**: Automatic failover between Voyage, Cohere, Jina
- **Cost-effective**: Only rerank top-K candidates ($0.50/1K with Voyage)

---

## When to Use Reranking

### ✅ Best For

| Use Case                 | Why Reranking Helps                                          |
| ------------------------ | ------------------------------------------------------------ |
| **Q&A systems**          | Users expect the first result to answer their question       |
| **Documentation search** | Precision matters — users don't want to scan 10 results      |
| **Technical support**    | Wrong results waste agent time                               |
| **Legal/compliance**     | Accuracy is critical — missing relevant docs is costly       |
| **E-commerce search**    | Better relevance = higher conversion                         |
| **Research search**      | Users need the most relevant papers, not just similar titles |

### ⚠️ Skip For

| Use Case                         | Why Not Rerank                                          |
| -------------------------------- | ------------------------------------------------------- |
| **High-throughput, low-latency** | Reranking adds 100-300ms latency                        |
| **Cost-sensitive at scale**      | 1M reranks/month = $500-2,000                           |
| **Broad exploration queries**    | Users want diversity, not precision                     |
| **Already high-quality results** | If vector search is 95% accurate, reranking adds little |

---

## Architecture

### Multi-Provider Strategy

The ATLAS platform supports three reranking providers with automatic fallback:

```
┌─────────────────────────────────────────────────────────────┐
│                      Reranker Factory                        │
│                   (RFC-003 Architecture)                     │
└──────────────────────┬──────────────────────────────────────┘
                       │
         ┌─────────────┴─────────────┐
         │   Priority Order:          │
         │   1. Voyage AI (cheapest)  │
         │   2. Cohere (fallback)     │
         │   3. Jina AI (fallback)    │
         └─────────────┬───────────────┘
                       │
         ┌─────────────┴─────────────┐
         │                           │
         ▼                           ▼
┌──────────────────┐        ┌──────────────────┐
│ Voyage AI Healthy?│        │ Circuit Breaker  │
│ (Check failures) │        │ (Max 3 failures) │
└────────┬─────────┘        └──────────────────┘
         │
    ┌────┴────┐
    │ Success │ ────────► Return results
    └─────────┘
         │ Failure
         ▼
┌──────────────────┐
│ Try Cohere       │ ────────► Success? Return
└────────┬─────────┘
         │ Failure
         ▼
┌──────────────────┐
│ Try Jina         │ ────────► Success? Return
└────────┬─────────┘
         │ All failed
         ▼
┌──────────────────┐
│ Return null      │ ────────► Graceful degradation (no reranking)
└──────────────────┘
```

### Batched Processing (Optional)

For high-throughput scenarios, use `BatchedRerankerFactory` to aggregate concurrent requests:

```
Multiple concurrent requests (same tenant + index)
   ↓
Batch Queue (collect requests for 50ms)
   ↓
Aggregate into single API call (max 100 documents)
   ↓
Rerank batch (1 API call instead of 10)
   ↓
Distribute results back to individual requests
```

**Benefit:** Reduces API calls by 10× for concurrent queries.

---

## Provider Comparison

### Voyage AI (Primary)

**Model:** `rerank-1`
**Cost:** $0.50 per 1K rerank operations
**Latency:** 150-250ms
**Quality:** Excellent (trained on diverse retrieval tasks)

**Strengths:**

- ✅ Cheapest provider (4× cheaper than Cohere)
- ✅ Fast (<250ms for 100 documents)
- ✅ Good multilingual support (60+ languages)
- ✅ Optimized for semantic search

**Weaknesses:**

- ⚠️ Newer provider (less battle-tested than Cohere)
- ⚠️ Smaller community

**Best For:** Production default — optimal cost/performance ratio

**API Endpoint:** `https://api.voyageai.com/v1/rerank`

**Request Format:**

```json
{
  "model": "rerank-1",
  "query": "How to authenticate?",
  "documents": ["text1", "text2", "text3"],
  "top_k": 10
}
```

**Response Format:**

```json
{
  "data": [
    { "index": 0, "relevance_score": 0.95 },
    { "index": 2, "relevance_score": 0.87 },
    { "index": 1, "relevance_score": 0.76 }
  ]
}
```

---

### Cohere (Fallback)

**Model:** `rerank-english-v3.0` (English), `rerank-multilingual-v3.0` (Multilingual)
**Cost:** $2.00 per 1K rerank operations
**Latency:** 200-300ms
**Quality:** Excellent (industry standard)

**Strengths:**

- ✅ Industry-standard reranker (widely used)
- ✅ Excellent quality (benchmarked on BEIR)
- ✅ Large community, extensive documentation
- ✅ Separate English + Multilingual models

**Weaknesses:**

- ❌ 4× more expensive than Voyage
- ⚠️ Slightly slower than Voyage

**Best For:** High-quality fallback, well-established provider

**API Endpoint:** `https://api.cohere.ai/v1/rerank`

**Request Format:**

```json
{
  "model": "rerank-english-v3.0",
  "query": "How to authenticate?",
  "documents": ["text1", "text2", "text3"],
  "top_n": 10
}
```

**Response Format:**

```json
{
  "results": [
    { "index": 0, "relevance_score": 0.94 },
    { "index": 2, "relevance_score": 0.86 },
    { "index": 1, "relevance_score": 0.75 }
  ]
}
```

---

### Jina AI (Fallback)

**Model:** `jina-reranker-v2-base-multilingual`
**Cost:** $1.00 per 1K rerank operations
**Latency:** 180-280ms
**Quality:** Good (strong multilingual support)

**Strengths:**

- ✅ Excellent multilingual support (100+ languages)
- ✅ Mid-range cost (2× cheaper than Cohere)
- ✅ Open-source models available
- ✅ Good for non-English content

**Weaknesses:**

- ⚠️ Slightly lower quality than Voyage/Cohere for English
- ⚠️ Smaller provider (less established)

**Best For:** Multilingual content, cost-conscious deployments

**API Endpoint:** `https://api.jina.ai/v1/rerank`

**Request Format:**

```json
{
  "model": "jina-reranker-v2-base-multilingual",
  "query": "How to authenticate?",
  "documents": [
    { "index": 0, "text": "text1" },
    { "index": 1, "text": "text2" },
    { "index": 2, "text": "text3" }
  ],
  "top_n": 10
}
```

**Response Format:**

```json
{
  "results": [
    { "index": 0, "relevance_score": 0.92 },
    { "index": 2, "relevance_score": 0.85 },
    { "index": 1, "relevance_score": 0.73 }
  ]
}
```

---

## Configuration

### Environment Variables

Configure reranking providers via environment variables:

```bash
# Voyage AI (primary)
VOYAGE_API_KEY=your-voyage-api-key

# Cohere (fallback)
COHERE_API_KEY=your-cohere-api-key

# Jina AI (fallback)
JINA_API_KEY=your-jina-api-key
```

**Priority Order:**

1. If `VOYAGE_API_KEY` is set → Voyage is primary
2. If `COHERE_API_KEY` is set → Cohere is first fallback
3. If `JINA_API_KEY` is set → Jina is second fallback

**Note:** At least one provider must be configured. If none are set, reranking is disabled.

### Search Query Configuration

Enable reranking per query via API request:

```typescript
POST /api/search
{
  "query": "How to authenticate?",
  "topK": 100,              // Retrieve 100 candidates
  "rerank": {
    "enabled": true,
    "topN": 10              // Return top 10 after reranking
  }
}
```

### Index-Level Configuration (Planned)

```typescript
// Future: Per-index reranking defaults
{
  indexId: "idx-123",
  reranking: {
    enabled: true,
    defaultTopN: 10,
    provider: "voyage" // Force specific provider (optional)
  }
}
```

---

## How It Works

### Reranking Process

**Step 1: Initial Retrieval (Vector Search)**

```typescript
// Retrieve top 100 candidates from OpenSearch
const candidates = await vectorSearch({
  query: 'How to authenticate?',
  topK: 100,
});

// candidates = [
//   { id: "doc1", score: 0.82, content: "JWT tokens are obtained..." },
//   { id: "doc2", score: 0.80, content: "Authentication uses..." },
//   ...
// ]
```

**Step 2: Prepare Rerank Request**

```typescript
const rerankRequest: RerankRequest = {
  query: 'How to authenticate?',
  documents: candidates.map((c) => c.content), // Extract text content
  topN: 10, // Return top 10
};
```

**Step 3: Call Reranker API**

```typescript
const rerankResponse = await rerankerFactory.rerank(rerankRequest);

// rerankResponse = {
//   results: [
//     { index: 0, score: 0.95 },  // doc1 ranked #1
//     { index: 5, score: 0.91 },  // doc6 ranked #2
//     { index: 2, score: 0.88 },  // doc3 ranked #3
//     ...
//   ],
//   provider: "voyage",
//   model: "rerank-1",
//   latencyMs: 210,
//   cost: 0.05 // $0.05 for 100 documents
// }
```

**Step 4: Map Back to Original Documents**

```typescript
const rerankedResults = rerankResponse.results.map((r) => ({
  ...candidates[r.index], // Original document
  rerankScore: r.score, // New relevance score
  originalScore: candidates[r.index].score, // Old vector score
}));

// rerankedResults = [
//   { id: "doc1", rerankScore: 0.95, originalScore: 0.82, content: "JWT tokens..." },
//   { id: "doc6", rerankScore: 0.91, originalScore: 0.78, content: "Use /auth/login..." },
//   { id: "doc3", rerankScore: 0.88, originalScore: 0.80, content: "Tokens expire..." },
//   ...
// ]
```

**Step 5: Return Top-N Results**

```typescript
return rerankedResults.slice(0, 10); // Top 10 reranked results
```

### Circuit Breaker Logic

**Purpose:** Prevent cascade failures when a provider is down.

**Rules:**

- Track failures per provider
- After 3 consecutive failures, open circuit (skip provider)
- On success, reset failure count
- Circuit auto-closes on next success

**Example:**

```
Voyage fails → failure count = 1
Voyage fails → failure count = 2
Voyage fails → failure count = 3 → Circuit OPEN (skip Voyage)
Try Cohere → Success! → Cohere handles requests
... (Voyage still skipped)
Next request tries Voyage again (circuit closes on success)
Voyage succeeds → failure count = 0 → Circuit CLOSED
```

### Automatic Fallback

**Scenario:** Voyage API is down

```
Request 1:
  Try Voyage → Timeout → Try Cohere → Success (200ms)

Request 2:
  Try Voyage → Timeout → Try Cohere → Success (205ms)

Request 3:
  Try Voyage → Timeout → Circuit OPEN (skip Voyage) → Try Cohere → Success (210ms)

Request 4-N:
  Skip Voyage (circuit open) → Try Cohere directly → Success (150ms)

... (After 5 minutes, circuit resets)

Request N+1:
  Try Voyage → Success → Circuit CLOSED → Voyage is primary again
```

---

## Batched Processing

### When to Use Batching

**Use batching when:**

- Multiple concurrent queries hitting the same index
- High QPS (>10 queries/second)
- Cost optimization is critical

**Batching aggregates requests:**

```
Without batching:
Query 1 → Rerank 100 docs → API call #1
Query 2 → Rerank 100 docs → API call #2
Query 3 → Rerank 100 docs → API call #3
Total: 3 API calls ($0.15)

With batching:
Query 1, 2, 3 → Wait 50ms → Aggregate → Rerank 300 docs → API call #1
Total: 1 API call ($0.15, but 3× throughput)
```

### Configuration

```typescript
const batchedReranker = new BatchedRerankerFactory({
  batchWaitMs: 50, // Wait up to 50ms to aggregate requests
  maxBatchSize: 100, // Max 100 documents per batch
  enableCaching: true, // Cache identical queries
  cacheTTLMs: 60000, // Cache for 60 seconds
  queueCleanupIntervalMs: 300000, // Clean stale queues every 5 minutes
});
```

### Usage

```typescript
// Same interface as RerankerFactory, but with tenant/index isolation
const result = await batchedReranker.rerank(
  tenantId,
  indexId,
  { query: "...", documents: [...], topN: 10 },
  { identityTier: "user", channel: "web" } // Caller context
);
```

**Benefits:**

- Reduces API calls by aggregating concurrent requests
- Caches identical queries (per tenant-index)
- Maintains tenant isolation (separate queues per tenant)
- Transparent to caller (same interface)

---

## Cost Analysis

### Per-Request Cost

| Provider      | Cost per 1K Ops | 100 Docs | 500 Docs | 1000 Docs |
| ------------- | --------------- | -------- | -------- | --------- |
| **Voyage AI** | $0.50           | $0.05    | $0.25    | $0.50     |
| **Cohere**    | $2.00           | $0.20    | $1.00    | $2.00     |
| **Jina AI**   | $1.00           | $0.10    | $0.50    | $1.00     |

### Monthly Cost at Scale

**Scenario:** 100K queries/month, reranking 100 candidates each

| Provider      | Cost per Query | Monthly Cost |
| ------------- | -------------- | ------------ |
| **Voyage AI** | $0.05          | $5,000       |
| **Cohere**    | $0.20          | $20,000      |
| **Jina AI**   | $0.10          | $10,000      |

**Cost Optimization:**

1. **Use Voyage as primary** → 4× cheaper than Cohere
2. **Rerank fewer candidates** → 50 docs instead of 100 = 50% savings
3. **Enable batching** → Reduces latency, not cost (same # docs reranked)
4. **Cache results** → Skip reranking for identical queries (batched factory only)

### Cost vs. Quality Trade-off

| Strategy                    | Cost         | Precision | Use Case                      |
| --------------------------- | ------------ | --------- | ----------------------------- |
| **No reranking**            | $0           | 75%       | Low-stakes, broad exploration |
| **Rerank top 50**           | $0.025/query | 85%       | Balanced cost/quality         |
| **Rerank top 100 (Voyage)** | $0.05/query  | 92%       | High-quality results          |
| **Rerank top 100 (Cohere)** | $0.20/query  | 94%       | Premium quality               |
| **Rerank top 200 (Voyage)** | $0.10/query  | 93%       | Diminishing returns           |

**Recommendation:** Rerank top 100 candidates with Voyage AI for optimal cost/quality balance.

---

## Performance

### Latency

| Provider      | Latency (50 docs) | Latency (100 docs) | Latency (200 docs) |
| ------------- | ----------------- | ------------------ | ------------------ |
| **Voyage AI** | 120-180ms         | 150-250ms          | 250-400ms          |
| **Cohere**    | 150-220ms         | 200-300ms          | 300-500ms          |
| **Jina AI**   | 130-200ms         | 180-280ms          | 280-450ms          |

**Total Query Latency (with reranking):**

```
Vector search: 50-100ms
   +
Reranking: 150-250ms
   =
Total: 200-350ms
```

**Without reranking:** 50-100ms (3-5× faster, but lower precision)

### Throughput

**Single provider (no batching):**

- 1 rerank/200ms = 5 queries/second
- 300 queries/minute
- 18,000 queries/hour

**With batching (10 concurrent queries):**

- 10 reranks/250ms = 40 queries/second
- 2,400 queries/minute
- 144,000 queries/hour

**Rate Limits:**

- Voyage: 600 requests/minute
- Cohere: 10,000 requests/minute
- Jina: 1,000 requests/minute

---

## Verification & Testing

### Check Reranker Availability

```typescript
const factory = new RerankerFactory();
const isAvailable = factory.isAvailable();
console.log('Reranking available:', isAvailable);
// True if at least one provider API key is set
```

### Health Check

```typescript
const status = await factory.getStatus();
console.log('Provider status:', status);

// Example output:
[
  {
    name: 'voyage',
    healthy: true,
    latencyMs: 180,
    circuitOpen: false,
  },
  {
    name: 'cohere',
    healthy: true,
    latencyMs: 220,
    circuitOpen: false,
  },
];
```

### Test Reranking

```typescript
const testQuery = 'How to authenticate?';
const testDocs = [
  'JWT tokens are obtained via /auth/login',
  'The platform supports user authentication',
  'Installing Docker on Ubuntu requires...', // Irrelevant
  'Use the Authorization header for API requests',
];

const result = await factory.rerank({
  query: testQuery,
  documents: testDocs,
  topN: 2,
});

console.log('Reranked results:', result?.results);
// [
//   { index: 0, score: 0.95 }, // "JWT tokens..." (most relevant)
//   { index: 3, score: 0.88 }  // "Use the Authorization header..." (second)
// ]
// Note: index 2 (Docker) filtered out, low relevance
```

### Compare Providers

```typescript
const providers = [
  new VoyageReranker({ apiKey: process.env.VOYAGE_API_KEY }),
  new CohereReranker({ apiKey: process.env.COHERE_API_KEY }),
  new JinaReranker({ apiKey: process.env.JINA_API_KEY })
];

const query = "authentication methods";
const docs = [...]; // Same test documents

for (const provider of providers) {
  const start = Date.now();
  const result = await provider.rerank({ query, documents: docs, topN: 5 });
  const latency = Date.now() - start;

  console.log(`${provider.name}:`);
  console.log(`  Latency: ${latency}ms`);
  console.log(`  Top result: index ${result.results[0].index}, score ${result.results[0].score}`);
  console.log(`  Cost: $${result.cost}`);
}

// Compare:
// - Latency differences
// - Score differences
// - Cost differences
```

---

## Troubleshooting

### Issue: All Providers Failing

**Symptoms:**

- Reranking returns `null`
- Logs show "All providers failed"
- Search results not reranked

**Diagnosis:**

```typescript
const status = await factory.getStatus();
console.log('Provider health:', status);
// Check: Are all providers unhealthy?

// Check API keys
console.log('Voyage key:', process.env.VOYAGE_API_KEY ? 'Set' : 'Missing');
console.log('Cohere key:', process.env.COHERE_API_KEY ? 'Set' : 'Missing');
console.log('Jina key:', process.env.JINA_API_KEY ? 'Set' : 'Missing');
```

**Common Causes:**

1. **No API keys set** → Set at least one provider API key
2. **Invalid API keys** → Verify keys are correct
3. **API quota exceeded** → Check provider dashboards for rate limits
4. **Network issue** → Check firewall, DNS resolution

**Solution:**

```bash
# 1. Set API keys
export VOYAGE_API_KEY=your-voyage-api-key
export COHERE_API_KEY=your-cohere-api-key

# 2. Restart service
npm run start

# 3. Test connectivity
curl -H "Authorization: Bearer $VOYAGE_API_KEY" \
  https://api.voyageai.com/v1/rerank \
  -d '{"model":"rerank-1","query":"test","documents":["test"]}'
```

---

### Issue: Circuit Breaker Open

**Symptoms:**

- Logs show "Skipping [provider] (circuit open)"
- Provider health check shows `circuitOpen: true`
- Reranking falls back to other providers

**Diagnosis:**

```typescript
const status = await factory.getStatus();
const openCircuits = status.filter((s) => s.circuitOpen);
console.log('Open circuits:', openCircuits);
```

**Common Causes:**

1. **Provider downtime** → Temporary outage
2. **Rate limit exceeded** → Too many requests
3. **Invalid API key** → Key expired or revoked

**Solution:**

```typescript
// Circuit auto-closes on next success.
// To manually reset (if needed):
factory.recordSuccess('voyage'); // Reset failure count

// Or wait for circuit to auto-reset (next successful request)
```

---

### Issue: High Latency

**Symptoms:**

- Reranking takes >500ms
- Search queries feel slow

**Diagnosis:**

```typescript
const result = await factory.rerank({ query, documents, topN: 10 });
console.log('Reranking latency:', result?.latencyMs, 'ms');
// High: >300ms for 100 documents
```

**Common Causes:**

1. **Too many documents** → Reranking 500+ docs takes >500ms
2. **Slow provider** → Cohere slightly slower than Voyage
3. **Network latency** → High ping to provider API

**Solution:**

```typescript
// 1. Reduce documents to rerank
const candidates = await vectorSearch({ topK: 50 }); // Down from 100

// 2. Switch to faster provider (Voyage vs. Cohere)
// Set VOYAGE_API_KEY to prioritize Voyage

// 3. Use batching for concurrent queries
const batchedFactory = new BatchedRerankerFactory();
```

---

### Issue: High Cost

**Symptoms:**

- Monthly reranking bill exceeds budget
- Cost alerts triggered

**Diagnosis:**

```bash
# Check total reranking cost (ClickHouse trace events)
SELECT
  SUM(cost) as total_cost,
  COUNT(*) as total_reranks,
  provider
FROM trace_events
WHERE event_type = 'rerank'
  AND timestamp > NOW() - INTERVAL '30 days'
GROUP BY provider;
```

**Common Causes:**

1. **Using expensive provider** → Cohere ($2/1K) instead of Voyage ($0.50/1K)
2. **Reranking too many documents** → 200+ docs per query
3. **High query volume** → 100K+ queries/month

**Solution:**

```typescript
// 1. Switch to Voyage AI (4× cheaper)
export VOYAGE_API_KEY=your-voyage-key
// Remove or don't set COHERE_API_KEY to prevent fallback

// 2. Reduce candidate count
const candidates = await vectorSearch({ topK: 50 }); // Down from 100

// 3. Enable caching (batched factory)
const batchedFactory = new BatchedRerankerFactory({
  enableCaching: true,
  cacheTTLMs: 300000 // Cache for 5 minutes
});
```

---

## Best Practices

### 1. Use Voyage AI as Primary

**Recommendation:** Set `VOYAGE_API_KEY` first in priority order.

**Cost savings:**

- Voyage: $0.50/1K
- Cohere: $2.00/1K
- **Savings: 75%**

**Quality:** Voyage quality matches Cohere for most use cases.

### 2. Rerank Top 50-100 Candidates

**Sweet spot:** 50-100 candidates balances recall and precision.

| Candidates | Recall  | Precision | Cost      | Latency   |
| ---------- | ------- | --------- | --------- | --------- |
| 20         | 80%     | 95%       | $0.01     | 80ms      |
| 50         | 92%     | 93%       | $0.025    | 150ms     |
| **100**    | **97%** | **92%**   | **$0.05** | **200ms** |
| 200        | 98%     | 91%       | $0.10     | 350ms     |

**Recommendation:** 100 candidates (optimal cost/quality/latency)

### 3. Enable Circuit Breaker (Default)

Circuit breaker prevents cascade failures:

- ✅ Automatic failover to backup providers
- ✅ Prevents wasting time on down providers
- ✅ Auto-recovers when provider comes back

**Already enabled by default** in `RerankerFactory`.

### 4. Use Batching for High Throughput

**When:**

- QPS >10 queries/second
- Multiple concurrent queries

**Benefits:**

- Reduces API calls (aggregates requests)
- Improves throughput (40 queries/sec vs. 5)
- Caches identical queries (skip API call)

**Trade-off:** Adds 50ms latency (batch wait time)

### 5. Monitor Provider Health

**Set up monitoring:**

```typescript
// Health check endpoint
app.get('/health/reranker', async (req, res) => {
  const status = await rerankerFactory.getStatus();
  const healthy = status.every((s) => s.healthy && !s.circuitOpen);

  res.status(healthy ? 200 : 503).json({
    healthy,
    providers: status,
  });
});
```

**Alert on:**

- All providers unhealthy
- Circuit open for >5 minutes
- Average latency >500ms

---

## Integration with Search Pipeline

### Hybrid Retrieval + Reranking

**Optimal search pipeline:**

```typescript
// 1. Vector search (broad recall)
const vectorResults = await vectorSearch({
  query: 'How to authenticate?',
  topK: 100,
});

// 2. (Optional) Keyword search (complement vector search)
const keywordResults = await keywordSearch({
  query: 'authentication',
  topK: 50,
});

// 3. Merge results (union, deduplicate)
const mergedCandidates = merge(vectorResults, keywordResults);
// ~120 unique candidates

// 4. Rerank merged results
const reranked = await rerankerFactory.rerank({
  query: 'How to authenticate?',
  documents: mergedCandidates.map((c) => c.content),
  topN: 10,
});

// 5. Return top 10
return reranked.results.map((r) => mergedCandidates[r.index]);
```

**Benefits:**

- Vector search: High recall (catches semantically similar results)
- Keyword search: Catches exact matches (e.g., "JWT")
- Reranking: High precision (best results at top)

---

## Related Documentation

- [Progressive Summarization](./50-PROGRESSIVE-SUMMARIZATION.md) - Context enrichment improves reranking
- [Question Synthesis](./51-QUESTION-SYNTHESIS.md) - Questions can be reranked
- [Query Pipeline Guide](../../search-ai-runtime/QUERY-PIPELINE-GUIDE.md) - Complete search pipeline
- [Architecture Overview](../chunking/10-architecture-overview.md) - System architecture
- [Benchmarking & Quality](../chunking/13-benchmarking-and-quality.md) - Reranking impact on metrics

---

## Key Takeaways

**1. Reranking Improves Precision**

- Initial retrieval (vector search): High recall, lower precision
- Reranking: Re-scores candidates with cross-encoder → higher precision
- Top result relevance improves from 75% to 92%

**2. Voyage AI is Cost-Effective**

- $0.50/1K reranks (4× cheaper than Cohere)
- Excellent quality (matches Cohere for most use cases)
- Fast (<250ms for 100 documents)

**3. Multi-Provider Fallback is Critical**

- Automatic failover prevents downtime
- Circuit breaker prevents cascade failures
- Graceful degradation (return null if all fail)

**4. Rerank Top 50-100 Candidates**

- Sweet spot for cost/quality/latency
- More candidates = higher cost, longer latency, diminishing returns
- Fewer candidates = lower recall

**5. Batching Optimizes High Throughput**

- Aggregates concurrent requests (reduces API calls)
- Caches identical queries (skip API call)
- Maintains tenant isolation (separate queues)
- Trade-off: +50ms latency for batching

**6. Production-Ready**

- Automatic failover between providers
- Circuit breaker for resilience
- Health checks for monitoring
- Graceful degradation (no errors if reranking fails)

---

**Next:** [Visual Enrichment Guide](./53-VISUAL-ENRICHMENT.md) →
