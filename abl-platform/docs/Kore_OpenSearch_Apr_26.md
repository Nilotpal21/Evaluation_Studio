# Kore.ai — OpenSearch review (Apr 26)

**Source:** `Kore_OpenSearch_Apr_26.pdf`  
**ARN:** `arn:aws:es:us-east-1:358587034707:domain/us-uxo-search-opensearch`

## Executive summary

The review revealed no major concerns; metrics were at good levels. The main recommendation relates to **sharding** (see [AWS: How many shards do I need?](https://aws.amazon.com/blogs/big-data/amazon-opensearch-service-101-how-many-shards-do-i-need/)).

---

## Ingestion strategy and performance

### Scenario: ~1 million documents

**During ingestion, can we:**

- Set `refresh_interval = -1`
- Set `replicas = 0`

**Post ingestion, can we revert:**

- `refresh_interval` back to the original value (e.g. 1/30/60/120s)
- Replicas back to the desired count (e.g. 1 or 2)

**Answer — cluster impact of dynamically updating these settings during ingestion**

- Adding replicas: small compute and memory increase while replication completes on other nodes; should be brief (under a minute).
- Resetting refresh: causes a large flush to disk → spike in disk activity; again minimal overall impact.

### Other best practices for ingestion throughput

**Answer:** Even shard distribution is key. The sharding doc linked above covers more.

### Force-merge and deleted documents

**Question:** Many deleted docs — what is the impact if we force-merge to only delete docs marked for deletion?

**Answer:** No major impact; only slight overhead while the merge runs.

---

## Migration from Elasticsearch to OpenSearch

### Full index migration approach

**Question:** Recommended approach to migrate a complete index from Elasticsearch to OpenSearch?

**Answer:** Depends on source/target versions and whether it is within the managed service vs self-managed — to be discussed on a call.

### Prior migration script — scores were 0

**Context:** Earlier, a script migrated ES → OS; on ingestion, scores were 0 for some queries, possibly due to incorrect graph formation.

**Ask:** Clear strategy to migrate the existing ES index to OS **without impact on recall**.

_(Call / follow-up for detailed migration strategy.)_

---

## Performance requirement (~100 ms query latency)

**Expectation:** OpenSearch query latency should not exceed ~100 ms.

**Answer — configurations / best practices**

- Sharding distribution and sizing: even distribution; shard size **10–30 GB** for search.
- For hardware: consider **NVMe-backed** instances.
- Example: `answer_index` has primary store ~**185 GB** with **3 primary shards** → ~**60 GB** per shard. Consider **reindexing** into a new index with **9 primary shards** (~20 GB per shard), allowing for growth.

### Search consistency without segment replication (graphs differ on replicas vs primaries)

**Answer**

If moving to OR2 is not an option:

1. **`_primary` routing** — Using `_primary` to force routing to a primary shard is **not scalable**. If “consistent” means **not global** (e.g. same result for the same request id or a stable id), you can use a **custom preference** like `_preference=<id>` so routing is stable to the same shard (primary or replica). Depends on the case; different ids → different hashes.
2. **`ef_search`** — Tuning can increase chances of graph results converging, with a **latency tradeoff**.
3. **Combination** — Using both can allow using replicas and getting **close** to the same results.

### Index with ~1M documents — tuning for ingestion

**Topics:** thread pool/queue, refresh/replica strategies, segment merging, indexing buffer.

**Answer:** Covered in [OpenSearch: Tuning your cluster for performance](https://docs.opensearch.org/latest/tuning-your-cluster/performance/). Some settings are **restricted on managed service**. **Do not** run **0 replicas** on an index that is **actively searched**.

---

## Filtered vector search (primary use case)

- Major use case: **filter-based vector search** using **HNSW**.
- **ACORN** (ANN Constraint-Optimized Retrieval Network) reference: [Weaviate: Speed up filtered vector search](https://weaviate.io/blog/speed-up-filtered-vector-search)

**Questions**

- Does OpenSearch support ACORN-based KNN filtering?
- If yes: which version, configuration, limitations?
- If not: roadmap/timeline for ACORN-like optimizations for filtered KNN?

**Answer:** Under investigation (“currently looking into this”).

---

## Query strategy (KNN + keyword)

- Attached file with current/modified OpenSearch queries (KNN + keyword) — review and improvements.
- **Single hybrid query vs vector + keyword in parallel** — what improvements (latency, relevance, resources) from a single hybrid query? Default hybrid KNN fusion logic, score normalization, post-processing vs built-in, score ranges?

_(Section title “Query Analysis” / “New KNN default query” in PDF.)_

---

## Query analysis — KNN default query

### Example query (as reviewed)

```json
{
  "size": 0,
  "query": {
    "bool": {
      "must": [],
      "should": [
        {
          "knn": {
            "chunkVector_1024": {
              "vector": ["..."],
              "k": 100,
              "filter": {
                "bool": {
                  "filter": [
                    {
                      "terms": {
                        "searchIndexId.keyword": ["sidx-7e681182-4bd2-5658-866a-d39c954b7607"]
                      }
                    }
                  ]
                }
              }
            }
          }
        }
      ]
    }
  },
  "aggs": {
    "generative": {
      "top_hits": {
        "from": 0,
        "size": 20,
        "_source": {
          "excludes": [
            "sections",
            "page_html",
            "faq_question_vector",
            "page_title_vector",
            "file_title_vector",
            "serviceNow_raw_text",
            "*_vector",
            "*Vector*"
          ]
        }
      }
    }
  }
}
```

### What’s better

- Filter is **inside the `knn` clause** — correct for filtered KNN; filter applied during ANN search, not only after.
- No `function_score` wrapper — simpler, less overhead.

### Issues and improvements

1. **`must: []`** — Remove; use only `should`, or drop `bool` if there is a single clause.
2. Prefer top-level `knn` when there is only one clause (no redundant `bool`).
3. **Filter nesting** — `bool.filter[terms]` can be simplified to `terms` directly for a single condition.
4. **`"from": 0`** in `top_hits` — default; can omit.
5. **`_source.excludes`** — wildcards already cover several explicit vector fields; can simplify to:  
   `["sections", "page_html", "serviceNow_raw_text", "*_vector", "*Vector*"]`
6. **`k: 100`** with **`top_hits` size 20** — tune `k` for recall vs latency.

### Simplified KNN query (recommended shape)

```json
{
  "size": 0,
  "query": {
    "knn": {
      "chunkVector_1024": {
        "vector": ["..."],
        "k": 100,
        "filter": {
          "terms": {
            "searchIndexId.keyword": ["sidx-7e681182-4bd2-5658-866a-d39c954b7607"]
          }
        }
      }
    }
  },
  "aggs": {
    "generative": {
      "top_hits": {
        "size": 20,
        "_source": {
          "excludes": ["sections", "page_html", "serviceNow_raw_text", "*_vector", "*Vector*"]
        }
      }
    }
  }
}
```

---

## Keyword query example and fixes

### Original-style keyword query

```json
{
  "size": 0,
  "query": {
    "bool": {
      "must": [],
      "should": [
        {
          "multi_match": {
            "query": "advantages propstream",
            "fields": ["chunkText^0.03", "chunkTitle^0.04", "recordTitle^0.02"],
            "lenient": "true"
          }
        }
      ],
      "filter": [
        {
          "terms": {
            "searchIndexId.keyword": ["sidx-7e681182-4bd2-5658-866a-d39c954b7607"]
          }
        }
      ]
    }
  },
  "aggs": {
    "generative": {
      "top_hits": {
        "from": 0,
        "size": 20,
        "_source": {
          "excludes": [
            "sections",
            "page_html",
            "faq_question_vector",
            "page_title_vector",
            "file_title_vector",
            "serviceNow_raw_text",
            "*_vector",
            "*Vector*"
          ]
        }
      }
    }
  }
}
```

### Problems noted

1. `must: []` — remove.
2. Single `should` + `filter` — move `multi_match` to **`must`** (clearer; `should` with no `must` behaves like required match via `minimum_should_match`).
3. **Trailing comma** after terms filter — invalid JSON in strict parsers.
4. **`"lenient": "true"`** — use boolean `true`.
5. `from: 0` — omit (default).
6. Redundant `_source.excludes` entries where wildcards suffice.
7. Boosts **0.03 / 0.04 / 0.02** — very low; ratios matter (e.g. 4:3:2 title:text:recordTitle); can use cleaner integers.

### Optimized keyword query

```json
{
  "size": 0,
  "query": {
    "bool": {
      "must": [
        {
          "multi_match": {
            "query": "advantages propstream",
            "fields": ["chunkText^3", "chunkTitle^4", "recordTitle^2"],
            "lenient": true
          }
        }
      ],
      "filter": [
        {
          "terms": {
            "searchIndexId.keyword": ["sidx-7e681182-4bd2-5658-866a-d39c954b7607"]
          }
        }
      ]
    }
  },
  "aggs": {
    "generative": {
      "top_hits": {
        "size": 20,
        "_source": {
          "excludes": ["sections", "page_html", "serviceNow_raw_text", "*_vector", "*Vector*"]
        }
      }
    }
  }
}
```

---

## Mapping review

### Major problems

#### 1. KNN vector field explosion

- **50+** `knn_vector` fields across many dimensions (128, 256, 384, 512, 768, 1024, 1028, 1536, 2048, 3072) and variants (`chunkVector`, `chunkVector_2`, `chunkVector_3`, `chunkVector_exact_knn`, etc.).
- Each HNSW graph is built and held **per field, per segment**.
- If only **`chunkVector_1024`** is queried, other vector fields still:
  - Waste disk (large HNSW graphs)
  - Consume heap for graphs
  - Slow segment merges
  - Increase indexing latency

**Fix:** Map only dimensions you use; multiple embedding models → prefer **separate indices** rather than one index with dozens of vector fields.

#### 2. `dynamic: "strict"` but mapping is very large

- ~**300+** fields; many sources (ServiceNow, Jira, Slack, GitHub, CRM, HR, etc.) in one index → sparse docs, mapping overhead, poor compression.

**Fix:** Split by source type or normalize schema.

#### 3. `.keyword` with `ignore_above: 256` on almost every text field

- Long content (URLs, descriptions, chunk text) often **exceeds 256 chars** → keyword subfield **drops** values silently → missing filter results if used for filters; if never filtered, wastes space.

**Fix:** Audit which fields truly need keyword subfields; chunk text / descriptions / `page_html` often **do not** need keyword.

#### 4. ID-like fields as `text` + `keyword`

- `searchIndexId`, `docId`, `chunkId`, `connectorId`, `sourceId`, `workspaceId` — typically **keyword only** (no full-text need).

**Fix:** Keyword-only where appropriate; align with existing keyword fields (`connectorId`, `workspaceId`, etc.).

#### 5. `cfs1`–`cfs45` generic custom fields

- Same text+keyword mapping on 45 generics → schema-less pattern forced into strict mapping → bloat or unmaintainable optimization.

### Estimated impact of cleanup

- Remove unused vector fields: **60–80%** heap reduction (estimate)
- Remove unnecessary keyword subfields: **10–20%** storage savings (estimate)
- Keyword-only IDs: faster filtering, less disk
- Split by source: better compression, faster queries

---

## Document metadata

- PDF pages: **11**
- Topics: AWS OpenSearch review, ingestion, migration, latency, filtered KNN / ACORN, hybrid queries, query examples, index mapping.
