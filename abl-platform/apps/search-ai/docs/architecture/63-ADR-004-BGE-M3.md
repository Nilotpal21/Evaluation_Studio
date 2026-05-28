# ADR-004: BGE-M3 Multilingual Embeddings

**Status:** Accepted
**Date:** 2025-Q4
**Deciders:** Platform Architecture Team
**Tags:** embeddings, multilingual, search-quality

---

## Context

The search-ai platform needs to generate vector embeddings for semantic search across 100+ languages. Requirements:

1. **Multilingual support:** 100+ languages (not just English)
2. **High retrieval quality:** NDCG@10 > 0.68 on BEIR benchmark
3. **Cost-effective:** <$0.0001 per chunk embedding
4. **Self-hosted option:** For compliance/data residency
5. **Reasonable vector dimension:** 512-1024 dims (balance quality vs storage)

**Use cases:**

- English technical documentation (Stack Overflow, GitHub)
- Multilingual customer support (Spanish, French, German, Chinese, Arabic)
- Cross-lingual search ("query in English, find results in Spanish")

---

## Decision

Use **BAAI/bge-m3** (BGE-M3) as the default embedding model, with OpenAI `text-embedding-3-small` as fallback for cost-sensitive deployments.

**Model specs:**

- **Name:** BAAI/bge-m3 (Beijing Academy of AI)
- **Languages:** 100+ (multilingual from pre-training)
- **Dimensions:** 1024
- **Max tokens:** 8192 (supports long documents)
- **License:** MIT (commercially usable)
- **Deployment:** Self-hosted (bge-m3-service) or SaaS (OpenAI/Cohere fallback)

---

## Rationale

### Embedding Model Comparison

| Model                                     | Languages | Dimensions | Quality (BEIR NDCG@10) | Cost (per 1M tokens) | Self-Hosted? |
| ----------------------------------------- | --------- | ---------- | ---------------------- | -------------------- | ------------ |
| **BGE-M3**                                | 100+      | 1024       | **0.72**               | $0 (self-hosted)     | ✅ Yes       |
| **OpenAI text-embedding-3-small**         | 100+      | 1536       | 0.68                   | $0.02                | ❌ No        |
| **OpenAI text-embedding-3-large**         | 100+      | 3072       | **0.74**               | $0.13                | ❌ No        |
| **Cohere embed-multilingual-v3**          | 100+      | 1024       | 0.70                   | $0.10                | ❌ No        |
| **Sentence-Transformers (all-MiniLM-L6)** | ~10       | 384        | 0.58                   | $0                   | ✅ Yes       |
| **OpenAI ada-002 (deprecated)**           | 100+      | 1536       | 0.64                   | $0.10                | ❌ No        |

### Why BGE-M3?

#### 1. **SOTA Multilingual Quality**

**BEIR Benchmark (Information Retrieval):**

```
BGE-M3:                   NDCG@10 = 0.72  ⭐ Top 3 open-source
OpenAI text-emb-3-small:  NDCG@10 = 0.68
Sentence-Transformers:    NDCG@10 = 0.58  (English-only trained)
```

**Multilingual MTEB Benchmark:**

```
BGE-M3 (Chinese):    0.71  ✅ Native support
BGE-M3 (Spanish):    0.69  ✅ Strong
BGE-M3 (Arabic):     0.66  ✅ Good
OpenAI (all langs):  0.67  ⚠️ Slightly better, but closed-source
```

**Key insight:** BGE-M3 matches or beats closed-source models on non-English languages.

#### 2. **Self-Hosted = Zero Marginal Cost**

**Cost comparison (1M chunks, 500 tokens avg):**

| Model                       | Deployment                   | Cost                             |
| --------------------------- | ---------------------------- | -------------------------------- |
| **BGE-M3**                  | Self-hosted (bge-m3-service) | $0 (compute only)                |
| **OpenAI text-emb-3-small** | API                          | $10,000 (500M tokens × $0.02/1M) |
| **Cohere embed-v3**         | API                          | $50,000                          |

**Infrastructure cost (self-hosted):**

- GPU: 1× A10 GPU ($500/month on AWS)
- Throughput: 10,000 embeddings/sec
- Amortized cost: $0.0005 per 1M embeddings (negligible)

**Break-even:** After 50M embeddings, self-hosted is cheaper.

#### 3. **Compliance & Data Residency**

**Self-hosted benefits:**

- ✅ **PCI/GDPR compliant:** Data never leaves infrastructure
- ✅ **No third-party data sharing:** OpenAI API sends data to external servers
- ✅ **Audit trail:** Full control over embedding generation

**Compliance requirement:** Financial/healthcare customers require on-premise processing.

#### 4. **Long Context Support (8192 tokens)**

BGE-M3 supports up to 8192 tokens per chunk:

```
Standard chunk: 512 tokens → BGE-M3 handles easily
Large chunk: 2048 tokens → BGE-M3 handles easily
Full document: 8192 tokens → BGE-M3 can embed entire doc

OpenAI text-emb-3-small: 8191 tokens (similar)
Sentence-Transformers: 512 tokens max (too short)
```

**Benefit:** Can embed large sections without splitting.

#### 5. **MIT License (Commercially Usable)**

- ✅ **No restrictions:** Can modify, redistribute, commercialize
- ✅ **No usage fees:** Unlike some research models with non-commercial clauses

---

### Why NOT Alternatives?

#### Alternative 1: OpenAI text-embedding-3-large

**Pros:**

- ✅ Highest quality (NDCG@10 = 0.74, +2.8% vs BGE-M3)
- ✅ No infrastructure management
- ✅ Auto-scaling

**Cons:**

- ❌ **6.5× more expensive** ($0.13/1M tokens vs $0.02 for small)
- ❌ **Cloud-only:** Data residency concerns
- ❌ **Vendor lock-in:** If OpenAI changes pricing, costs spike

**Why rejected:** 2.8% quality improvement NOT worth 6.5× cost + compliance risk.

---

#### Alternative 2: OpenAI text-embedding-3-small

**Pros:**

- ✅ Good quality (NDCG@10 = 0.68)
- ✅ No infrastructure
- ✅ Cheaper than large ($0.02/1M)

**Cons:**

- ❌ **5.9% worse than BGE-M3** (0.68 vs 0.72 NDCG@10)
- ❌ **Not free:** $10K per 1M chunks
- ❌ **Compliance issues:** Data sent to OpenAI servers

**Why rejected:** BGE-M3 is both higher quality AND free (self-hosted).

**When to use:** Cost-sensitive deployments where self-hosting isn't viable (e.g., low-volume tenants).

---

#### Alternative 3: Sentence-Transformers (all-MiniLM-L6)

**Pros:**

- ✅ Free (open-source)
- ✅ Lightweight (384 dims)
- ✅ Fast inference

**Cons:**

- ❌ **19% worse quality** (NDCG@10 = 0.58 vs 0.72)
- ❌ **English-centric:** Poor performance on other languages
- ❌ **512 token limit:** Can't handle long chunks

**Why rejected:** Quality gap too large. BGE-M3 provides superior multilingual support with minimal cost overhead.

---

## Consequences

### Positive

- ✅ **5.9% better quality** than OpenAI text-emb-3-small (0.72 vs 0.68 NDCG@10)
- ✅ **100+ language support** (native multilingual training)
- ✅ **Zero marginal cost** (self-hosted, no per-embedding fees)
- ✅ **PCI/GDPR compliant** (data never leaves infrastructure)
- ✅ **$10K/month saved** vs OpenAI API at 1M chunks/month

### Negative

- ❌ **Infrastructure dependency:** Requires GPU server (bge-m3-service)
- ❌ **Cold start latency:** ~5-10s for first request (model loading)
- ❌ **Memory footprint:** 2GB per worker (model weights)

### Neutral

- ⚪ **Vendor flexibility:** Can switch to OpenAI/Cohere if self-hosting becomes burden (abstracted behind provider interface)

---

## Implementation

### Deployment Architecture

```
search-ai (Node.js)
    ↓ HTTP POST /embed (batch)
bge-m3-service (Python/FastAPI)
    ↓ Loads BGE-M3 model
BAAI/bge-m3 (PyTorch)
    ↓ GPU inference
Embeddings (1024-dim vectors)
```

### Configuration

```typescript
// apps/search-ai/src/config/index.ts
export const config = {
  embedding: {
    provider: 'bge-m3', // 'openai' | 'cohere' | 'bge-m3'
    model: 'BAAI/bge-m3',
    dimensions: 1024,
    baseUrl: process.env.BGE_M3_SERVICE_URL || 'http://bge-m3-service:8000',
    batchSize: 100, // Embed 100 chunks per request
  },
};
```

### Provider Abstraction

```typescript
// apps/search-ai/src/services/embedding/provider-factory.ts
export async function createEmbeddingProvider(config: EmbeddingConfig): Promise<EmbeddingProvider> {
  switch (config.provider) {
    case 'bge-m3':
      return new BGE_M3Provider(config.baseUrl);
    case 'openai':
      return new OpenAIProvider(config.apiKey);
    case 'cohere':
      return new CohereProvider(config.apiKey);
    default:
      throw new Error(`Unknown provider: ${config.provider}`);
  }
}

// All providers implement same interface
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>; // [[emb1], [emb2], ...]
}
```

### Fallback Strategy

```typescript
// If bge-m3-service is down, fall back to OpenAI
try {
  embeddings = await bgeM3Provider.embed(chunks);
} catch (error) {
  console.warn('BGE-M3 service unavailable, falling back to OpenAI');
  embeddings = await openAIProvider.embed(chunks);
}
```

---

## Performance

**Benchmark (bge-m3-service, 1× A10 GPU):**

| Batch Size | Latency | Throughput         |
| ---------- | ------- | ------------------ |
| 1          | 15ms    | 67 embeddings/sec  |
| 10         | 45ms    | 222 embeddings/sec |
| 100        | 250ms   | 400 embeddings/sec |
| 1000       | 2,100ms | 476 embeddings/sec |

**Optimal:** Batch size = 100 (balance latency vs throughput)

**Scaling:** Add more GPU workers for higher throughput (linear scaling).

---

## Related Decisions

- **ADR-001: Docling Adoption** — Multilingual extraction complements multilingual embeddings
- **Language Support Matrix** — See `chunking/12-language-support-matrix.md` for per-language quality

---

## Future Considerations

**When to revisit:**

1. **BGE-M4 released:** If BAAI releases improved model, evaluate upgrade
2. **OpenAI price drop:** If OpenAI drops to <$0.005/1M tokens, re-evaluate vs self-hosted
3. **Specialized domains:** If domain-specific models (legal, medical) outperform BGE-M3 by >10%

**Migration path:** Provider abstraction allows swapping models without code changes (just config update).

---

**References:**

- Implementation: `apps/search-ai/src/services/embedding/`
- Benchmarks: `apps/search-ai/docs/chunking/13-benchmarking-and-quality.md`
- Language support: `apps/search-ai/docs/chunking/12-language-support-matrix.md`
- BGE-M3 paper: https://arxiv.org/abs/2402.03216

**Last Updated:** 2026-02-24
