# Retrieval Quality Testing

## Overview

Measures the impact of preprocessing on search retrieval quality using isolated tests (no service dependencies).

## Architecture

```
Query → Preprocessing → Embedding → Vector Search → Ranking
                                                        ↓
                                              Quality Metrics
                                              (Recall, Precision, MRR, NDCG)
```

## Testing Approaches

### 1. Isolated Testing (No Service Dependencies)

**Setup:**

- Local embedding model (sentence-transformers)
- In-memory vector store (FAISS or numpy)
- Ground truth dataset (queries + relevant docs)

**Pros:**

- Fast (no network calls)
- Reproducible (deterministic)
- No infrastructure dependencies
- Easy to debug

**Cons:**

- Simplified embedding model (not production)
- Limited document corpus

### 2. End-to-End Testing (Full Pipeline)

**Setup:**

- Preprocessing service (HTTP)
- Embedding service (HTTP)
- Vector database (Qdrant/Pinecone/Weaviate)
- Real document corpus

**Pros:**

- Production-realistic
- Tests full integration
- Real embedding quality

**Cons:**

- Slow (network + service overhead)
- Requires infrastructure
- Harder to debug
- Non-deterministic (service availability)

### 3. Hybrid Approach (Recommended)

**Development/CI:** Use isolated tests with local embeddings for fast iteration

**Pre-production:** Run end-to-end tests against staging environment with real services

**Production:** A/B test with real users, measure CTR, null result rate, query reformulation

## Metrics

### Recall@k

% of relevant documents in top k results

```
Recall@10 = (# relevant docs in top 10) / (total # relevant docs)
```

### Precision@k

% of top k results that are relevant

```
Precision@10 = (# relevant docs in top 10) / 10
```

### MRR (Mean Reciprocal Rank)

Average of 1/rank of first relevant result

```
MRR = avg(1 / rank_of_first_relevant_doc)
```

### NDCG@k (Normalized Discounted Cumulative Gain)

Ranking quality with graded relevance (0-3 scale)

```
DCG@k = sum(rel_i / log2(i+1)) for i in 1..k
NDCG@k = DCG@k / IDCG@k
```

## Ground Truth Dataset

### Format

```json
{
  "documents": [
    {
      "id": "doc_001",
      "title": "Kubernetes Deployment Guide",
      "content": "How to deploy applications on Kubernetes...",
      "metadata": { "category": "devops", "topic": "kubernetes" }
    }
  ],
  "queries": [
    {
      "id": "query_001",
      "query": "how to deplyo kubernetes app",
      "relevant_docs": [
        { "doc_id": "doc_001", "relevance": 3 },
        { "doc_id": "doc_015", "relevance": 2 }
      ],
      "expected_improvement_with_preprocessing": true,
      "preprocessing_helps_with": ["typo_correction: deplyo → deploy"]
    }
  ]
}
```

### Dataset Categories

1. **Typo Queries** (spelling errors should be corrected)
2. **Synonym Queries** (synonyms should expand search)
3. **Multilingual Queries** (translation/transliteration needed)
4. **Entity Queries** (entities should be preserved)
5. **Conversational Queries** (natural language → keywords)

### Creating Ground Truth

**Manual curation:**

- 100-200 representative queries
- Mark relevant documents (0-3 relevance scale)
- Expected improvement flag (should preprocessing help?)

**Crowdsourcing:**

- Use production query logs
- Ask annotators to mark relevant docs
- Use inter-annotator agreement (Cohen's kappa > 0.7)

## Configuration Comparison

Test 4 configurations:

1. **Baseline**: No preprocessing
2. **Full**: All stages enabled (spell + synonyms + entities)
3. **Adaptive**: Smart selection based on complexity
4. **Optimal**: Ground truth configuration from dataset

Compare metrics across configurations to measure:

- Does preprocessing improve quality? (Full vs Baseline)
- Is adaptive selection good enough? (Adaptive vs Full)
- How close to optimal? (Adaptive vs Optimal)

## CI Integration

Run isolated quality tests on every PR:

```bash
# Fast quality check (100 queries, 1000 docs)
pytest tests/quality/test_retrieval_quality.py --fast

# Full quality check (2000 queries, 10000 docs)
pytest tests/quality/test_retrieval_quality.py --full
```

## Production Monitoring

A/B test metrics:

- **CTR (Click-Through Rate)**: % queries with at least 1 click
- **Null Result Rate**: % queries with 0 results
- **Query Reformulation**: % queries followed by retry within 30s
- **Session Success**: % sessions ending with click (not reformulation)

## Next Steps

1. Create ground truth dataset (queries + relevant docs)
2. Implement isolated quality testing framework
3. Run baseline quality measurements
4. Measure improvement from adaptive preprocessing
5. Deploy to staging for end-to-end validation
6. A/B test in production
