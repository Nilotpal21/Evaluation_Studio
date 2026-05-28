# Dynamic Attributes — Storage & Generation Design

**Date:** 2026-03-17
**Constraint:** Cannot add fields to OpenSearch mapping. 75-field schema is FIXED.

---

## Part 1: Storage Design — Where Do Attributes Live?

### The Constraint

OpenSearch has `dynamic: 'strict'` with a fixed 75-field mapping. We cannot add
a `nested` attributes field or new keyword fields. Attributes can be infinite
and non-intersecting — 40 custom slots are insufficient.

### What Already Stores Attribute Data

```
┌─────────────────────────────────────────────────────────────┐
│ NEO4J (already populated by KG enrichment)                  │
│                                                             │
│ (Attribute {id, name, dataType})                            │
│   ↑ :INSTANCE_OF                                           │
│ (EntityInstance {id, attributeId, normalizedValue,          │
│                  documentCount, firstSeenAt, lastSeenAt})   │
│   → :FOUND_IN_PRODUCT → (Product)                          │
│                                                             │
│ ✅ Has: attribute names, values, counts, product links      │
│ ❌ Missing: Document → EntityInstance edges (deduplicated   │
│    model dropped per-document links)                        │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ MONGODB (already populated by KG enrichment)                │
│                                                             │
│ SearchDocument.entityInstances[] = [                        │
│   { entityInstanceId: "interest_rate:0.189",                │
│     type: "interest_rate",                                  │
│     rawValue: "18.9% APR",                                  │
│     normalizedValue: 0.189,                                 │
│     chunkIds: ["chunk_1", "chunk_3"] }                      │
│ ]                                                           │
│                                                             │
│ SearchDocument.classification = {                           │
│   productScope: { primaryProduct: "credit_card" },          │
│   department: "Card Services",                              │
│   category: "Cards" }                                       │
│                                                             │
│ ✅ Has: per-document attribute values, document IDs         │
│ ❌ Missing: compound indexes for facet queries              │
└─────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────┐
│ OPENSEARCH (75-field fixed mapping)                         │
│                                                             │
│ metadata.canonical.custom = { enabled: false }              │
│   → Stored in _source but NOT indexed/searchable            │
│   → CAN store full attribute map for post-retrieval display │
│                                                             │
│ metadata.sys.documentId = keyword (indexed)                 │
│   → JOIN KEY to MongoDB and Neo4j                           │
│                                                             │
│ ✅ Has: vector search, document ID join key                 │
│ ❌ Cannot: filter/aggregate on dynamic attributes           │
└─────────────────────────────────────────────────────────────┘
```

### Why ClickHouse (Not MongoDB) for Facets

The stack already has **ClickHouse 24.3** deployed (`docker-compose.yml`), used
by search-ai (47 files) and search-ai-runtime (4 files) for analytics. It is
a columnar OLAP engine purpose-built for `GROUP BY + COUNT` — exactly the facet
query pattern. Here's why it wins over every alternative:

| Store              | 100K docs | 1M docs | Multi-facet  | Range queries | In stack? | Sync cost                         |
| ------------------ | --------- | ------- | ------------ | ------------- | --------- | --------------------------------- |
| **ClickHouse**     | ~2ms      | ~10ms   | Native SQL   | Native        | ✅ Yes    | Batch insert during KG enrichment |
| MongoDB            | ~150ms    | ~1s+    | $elemMatch   | Mixed type ⚠️ | ✅ Yes    | Already has data                  |
| OpenSearch sidecar | ~15ms     | ~50ms   | Nested agg   | Native        | ✅ Yes    | New index sync                    |
| Redis              | ~1ms      | ~50ms   | SINTER       | ZRANGEBYSCORE | ✅ Yes    | Full data duplication             |
| Neo4j              | ~100ms    | ~500ms  | Cypher WHERE | No columnar   | ✅ Yes    | Already has data                  |

**MongoDB fails at scale:** `$unwind` on `entityInstances[]` creates 1M
intermediate docs for 100K documents × 10 attrs. Hits the 100MB aggregation
memory limit at ~200K docs, forcing `allowDiskUse` which adds 500ms+. The
`Schema.Types.Mixed` on `normalizedValue` makes range queries unreliable.
Multi-facet `$elemMatch` only uses the compound index for ONE condition.

**ClickHouse is 100x faster:** Columnar scan of 10M rows in ~10ms.
`LowCardinality(String)` for attribute types gives dictionary encoding.
`ORDER BY (tenant_id, index_id, attribute_type)` gives perfect data locality.
Append-optimized — entity instances are written once during enrichment, rarely
updated. Already has `BufferedClickHouseWriter` and schema init patterns in
the codebase.

### Design: Tri-Store with Role Separation (v2)

Each store does what it's best at. No store tries to do everything.

```
┌──────────────────────────────────────────────────────────┐
│                    BROWSE SDK QUERY                       │
│                                                          │
│  User: "Show me credit card documents with APR > 15%"    │
│  OR: clicks Cards → Credit Card → interest_rate → >15%   │
└──────────────┬───────────────────────────────────────────┘
               │
    ┌──────────┼──────────────┐
    ▼          ▼              ▼
┌────────┐ ┌────────────┐ ┌──────────┐
│ NEO4J  │ │ CLICKHOUSE │ │OPENSEARCH│
│        │ │            │ │          │
│ ROLE:  │ │ ROLE:      │ │ ROLE:    │
│ Browse │ │ Facet      │ │ Search   │
│ tree   │ │ counts +   │ │ & Rank   │
│(cached)│ │ filter     │ │          │
└────┬───┘ └─────┬──────┘ └────┬─────┘
     │           │              │
     ▼           ▼              ▼
  Taxonomy    Facet counts   Ranked
  hierarchy   + doc IDs      results
  (Redis      matching       (vector +
   cached)    facet filters   keyword)
```

#### Neo4j Role: Taxonomy Browsing Only (Cached)

Neo4j is good at graph traversal, bad at aggregation. Use it ONLY for
navigating the taxonomy tree. Cache results in Redis (TTL 5 min, invalidate
on taxonomy update).

```cypher
-- Browse: Get categories for a domain
MATCH (d:Domain {tenantId:$t, indexId:$i})-[:HAS_CATEGORY]->(c:Category)
RETURN c.id, c.name

-- Browse: Get products for a category
MATCH (c:Category {tenantId:$t, indexId:$i, id:$catId})-[:HAS_PRODUCT]->(p:Product)
RETURN p.id, p.name

-- Browse: Get attribute catalog for a product
MATCH (p:Product {tenantId:$t, indexId:$i, id:$prodId})-[:HAS_ATTRIBUTE]->(a:Attribute)
RETURN a.id, a.name, a.dataType
```

**NOT used for:** Facet value counts (wrong — global counts, not filtered).
ClickHouse handles this instead.

**Cost: ~10-50ms** first call, **~1ms** from Redis cache.

#### ClickHouse Role: Facet Counts + Document ID Filtering

**New table** (entity instances, one row per attribute per document):

```sql
CREATE TABLE IF NOT EXISTS abl_platform.entity_instances
(
    tenant_id      LowCardinality(String)   CODEC(ZSTD(1)),
    index_id       LowCardinality(String)   CODEC(ZSTD(1)),
    document_id    String                   CODEC(ZSTD(1)),
    attribute_type LowCardinality(String)   CODEC(ZSTD(1)),
    attribute_name String                   CODEC(ZSTD(1)),
    data_type      LowCardinality(String)   CODEC(ZSTD(1)),
    string_value   Nullable(String)         CODEC(ZSTD(1)),
    number_value   Nullable(Float64)        CODEC(Gorilla, ZSTD(1)),
    bool_value     Nullable(UInt8)          CODEC(T64, ZSTD(1)),
    date_value     Nullable(DateTime)       CODEC(DoubleDelta, ZSTD(1)),
    raw_value      String                   CODEC(ZSTD(1)),
    product_type   LowCardinality(String)   CODEC(ZSTD(1)),
    tier           LowCardinality(String)   CODEC(ZSTD(1)),
    confidence     Float32                  DEFAULT 0 CODEC(Gorilla, ZSTD(1)),
    created_at     DateTime                 DEFAULT now() CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_document  document_id  TYPE bloom_filter GRANULARITY 4,
    INDEX idx_tier      tier         TYPE set(4)       GRANULARITY 4
)
ENGINE = ReplicatedReplacingMergeTree(
    '/clickhouse/tables/{shard}/abl_platform.entity_instances',
    '{replica}',
    created_at
)
ORDER BY (tenant_id, index_id, attribute_type, document_id)
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 86400
```

**Notes on DDL choices:**

- **No PARTITION BY** — partitioning by (tenant_id, index_id) risks unbounded
  partition count (ClickHouse recommends <300 active partitions). ORDER BY
  already gives data locality for all queries. For index deletion cleanup,
  use `ALTER TABLE DELETE WHERE tenant_id=... AND index_id=...` (lightweight
  mutation on well-ordered data).
- **ReplicatedReplacingMergeTree** — matches existing `Replicated*` pattern
  with `/clickhouse/tables/{shard}/...` path. ReplacingMergeTree deduplicates
  on ORDER BY key during merge (re-enrichment = insert, old rows cleaned up).
- **bloom_filter on document_id** — enables efficient post-search facet queries
  (`WHERE document_id IN (...)`) without requiring document_id in ORDER BY prefix.
- **confidence column** — needed for auto-promotion threshold queries in
  reconciliation service. Float32 is sufficient precision.
- **CODECs** — match existing table conventions: Gorilla for floats, T64 for
  integers, DoubleDelta for timestamps, ZSTD(1) for strings.

**Why this schema works:**

- **Typed columns** — no Mixed type problem. `number_value` is Float64, range
  queries are native and fast.
- **LowCardinality** — `attribute_type` with ~100 distinct values gets
  dictionary encoding (10x compression, faster scans).
- **ORDER BY** — data sorted by tenant+index+attribute, so facet queries on a
  single attribute type are sequential reads.
- **ReplicatedReplacingMergeTree** — matches all existing ClickHouse tables in
  the codebase (`ReplicatedMergeTree` family). Deduplicates on ORDER BY key
  during merge. Re-enrichment inserts new rows; old ones cleaned up automatically.
- **PARTITION BY (tenant_id, index_id)** — enables fast `DROP PARTITION` when
  an index is deleted (no scan needed). All existing tables partition by time;
  this table partitions by tenant+index because the primary query pattern is
  always scoped to one index.

**Write mechanism:** Use `BufferedClickHouseWriter<EntityInstanceRow>` (already
exists in `packages/database`) with `batchSize: 5000`, `flushIntervalMs: 3000`.
The KG enrichment worker already processes documents in batches — accumulate
entity instance rows and flush after each document batch.

**Cleanup:** When an index is deleted, `DROP PARTITION` by (tenant_id, index_id).
No row-level TTL needed — entity instances are valid as long as the index exists.

**Facet queries:**

All facet queries filter `tier IN ('permanent', 'approved')` — Tier 3 (pending)
candidates are stored in ClickHouse but NEVER exposed in the Browse SDK.

```sql
-- Facet sidebar: all attribute types with doc counts (single query)
SELECT attribute_type, data_type,
       count(DISTINCT document_id) AS doc_count
FROM abl_platform.entity_instances
WHERE tenant_id = {t:String} AND index_id = {i:String}
  AND tier IN ('permanent', 'approved')
GROUP BY attribute_type, data_type
ORDER BY doc_count DESC

-- Facet values for a STRING attribute
SELECT string_value AS value, count(DISTINCT document_id) AS doc_count
FROM abl_platform.entity_instances
WHERE tenant_id = {t:String} AND index_id = {i:String}
  AND attribute_type = {attr:String}
  AND tier IN ('permanent', 'approved')
  AND data_type = 'string'
GROUP BY string_value
ORDER BY doc_count DESC
LIMIT 50

-- Facet values for a BOOLEAN attribute
SELECT bool_value AS value, count(DISTINCT document_id) AS doc_count
FROM abl_platform.entity_instances
WHERE tenant_id = {t:String} AND index_id = {i:String}
  AND attribute_type = {attr:String}
  AND tier IN ('permanent', 'approved')
  AND data_type = 'boolean'
GROUP BY bool_value

-- Range facet (NUMERIC) — buckets computed dynamically
SELECT
  multiIf(number_value < {b1:Float64}, {l1:String},
          number_value < {b2:Float64}, {l2:String},
          number_value < {b3:Float64}, {l3:String},
          number_value < {b4:Float64}, {l4:String},
          {l5:String}) AS bucket,
  count(DISTINCT document_id) AS doc_count
FROM abl_platform.entity_instances
WHERE tenant_id = {t:String} AND index_id = {i:String}
  AND attribute_type = {attr:String}
  AND tier IN ('permanent', 'approved')
  AND data_type = 'number'
GROUP BY bucket

-- Range facet (DATE)
SELECT
  toStartOfMonth(date_value) AS month,
  count(DISTINCT document_id) AS doc_count
FROM abl_platform.entity_instances
WHERE tenant_id = {t:String} AND index_id = {i:String}
  AND attribute_type = {attr:String}
  AND tier IN ('permanent', 'approved')
  AND data_type = 'date'
GROUP BY month
ORDER BY month

-- Multi-facet filter → document IDs (AND across facets)
SELECT document_id
FROM abl_platform.entity_instances
WHERE tenant_id = {t:String} AND index_id = {i:String}
  AND tier IN ('permanent', 'approved')
  AND (
    (attribute_type = 'interest_rate' AND number_value >= 0.15)
    OR (attribute_type = 'rewards_program' AND string_value = 'cashback')
  )
GROUP BY document_id
HAVING count(DISTINCT attribute_type) = 2  -- must match ALL conditions

-- Post-search facet counts (WITHIN search results only)
-- Returns all types with values — single query for full sidebar refresh
SELECT attribute_type, data_type,
       CASE
         WHEN data_type = 'string' THEN string_value
         WHEN data_type = 'boolean' THEN toString(bool_value)
         WHEN data_type = 'number' THEN toString(number_value)
         WHEN data_type = 'date' THEN toString(toStartOfMonth(date_value))
         ELSE ''
       END AS display_value,
       count(DISTINCT document_id) AS doc_count
FROM abl_platform.entity_instances
WHERE tenant_id = {t:String} AND index_id = {i:String}
  AND tier IN ('permanent', 'approved')
  AND document_id IN ({result_doc_ids:Array(String)})
GROUP BY attribute_type, data_type, display_value
ORDER BY attribute_type, doc_count DESC
```

**Solving N+1:** The post-search facet counts query returns ALL attribute types
with their values in a single query. The application groups by `attribute_type`
client-side. For initial browse (no search results), the same query without the
`document_id IN (...)` clause returns global facet values.

**Key advantage over MongoDB:** The last query — post-search facet counts
within a result set — is the query that makes facet counts CORRECT. MongoDB
can't do this efficiently (`$unwind` + `$group` on filtered IDs = 1s+).
ClickHouse does it in ~5-15ms because it's a columnar scan.

**Parameter binding for large IN clauses:** The post-search facet query passes
result doc IDs as `{result_doc_ids:Array(String)}` — this uses ClickHouse's
parameterized query format (not string interpolation). The `@clickhouse/client`
library handles array parameters natively. For >10K doc IDs, the bloom filter
index on `document_id` accelerates the scan by skipping irrelevant granules.

**Cost: ~2-15ms** per query at 1M documents. **~50ms** for post-search facet
counts on 10K result documents.

#### OpenSearch Role: Search & Rank

Same as before — vector/hybrid search filtered by document IDs from ClickHouse.

```json
{
  "query": {
    "bool": {
      "must": [{ "knn": { "vector": { "vector": [...], "k": 50 } } }],
      "filter": [
        { "term": { "metadata.sys.tenantId": "t1" } },
        { "term": { "metadata.sys.indexId": "idx1" } },
        { "terms": { "metadata.sys.documentId": ["doc1", "doc2", ...] } }
      ]
    }
  }
}
```

**Scale limit:** OpenSearch `max_terms_count` = 65,536. For broad facet filters
matching >65K documents, skip the doc ID filter and use OpenSearch's existing
`metadata.canonical.category`/`department` fields for product-level filtering.
Only use ClickHouse→OpenSearch doc ID join for narrow attribute filters.

**Cost: ~50-200ms** depending on filter selectivity.

#### End-to-End Flows (Two Modes)

**Browse-first mode** (user clicks facets, no query typed):

Each numbered step is a separate API call triggered by user interaction.

```
REQUEST 1: Initial page load (taxonomy + global facets)
  1a. Redis: taxonomy tree → Categories, Products, Attributes
      → ~1ms (cache hit) / ~30ms (cache miss)
  1b. ClickHouse: global facet sidebar (all types + values)
      → ~5ms
  Response: taxonomy tree + facet sidebar with counts

REQUEST 2: User selects facet(s) → get matching documents
  2a. ClickHouse: multi-facet filter → document IDs
      → ~3ms
  2b. ClickHouse: updated facet counts WITHIN matched doc IDs
      → ~5ms (other facets update to reflect current selection)
  2c. OpenSearch: match_all query with terms filter on doc IDs
      sorted by recency (metadata.sys.updatedAt DESC)
      → ~50ms (no relevance scoring — pure filter + sort)
      Pagination: from/size (offset pagination, max 10K hits)
  Response: documents + updated facet sidebar

REQUEST 3+: User changes facet selection → repeat Request 2

Total: ~35ms (facet sidebar), ~60ms (documents), sequential = ~95ms
```

**Search-first mode** (user types query, facets update):

The SDK persists the original query text for re-execution on facet clicks.

```
REQUEST 1: User types query → search + compute facets
  1a. OpenSearch: vector/hybrid search → top-K results + doc IDs
      → ~100ms
  1b. ClickHouse: post-search facet counts WITHIN result doc IDs
      → ~10ms (correct counts, not global!)
  Response: ranked results + facet sidebar (counts within results)

REQUEST 2: User clicks a facet → narrow results
  SDK sends: original query text + selected facet filters
  2a. ClickHouse: multi-facet filter → narrowed doc IDs
      → ~3ms
  2b. OpenSearch: re-execute original query with doc ID filter
      → ~80ms (same query, restricted to facet-matching docs)
  2c. ClickHouse: updated facet counts within new result set
      → ~10ms
  Response: refined results + updated facets

REQUEST 3+: User changes facets → repeat Request 2

Total: ~110ms first search, ~95ms per facet click
```

**Pagination:** Both modes use OpenSearch's `from/size` for offset pagination
(simple, sufficient for <10K results). Deep pagination beyond 10K uses
`search_after` with sort values. Browse-first sorts by recency; search-first
sorts by relevance score + recency tiebreaker.

#### What Needs To Be Built for Storage

| #   | Change                                | Where                           | Effort |
| --- | ------------------------------------- | ------------------------------- | ------ |
| 1   | ClickHouse `entity_instances` table   | New schema in packages/database | Small  |
| 2   | Write to ClickHouse during enrichment | kg-enrichment-worker.ts         | Small  |
| 3   | Taxonomy browse API (Neo4j + cache)   | New routes in search-ai-runtime | Medium |
| 4   | Facet query API (ClickHouse)          | New routes in search-ai-runtime | Medium |
| 5   | Post-search facet counts API          | New routes in search-ai-runtime | Medium |
| 6   | Query pipeline: doc ID filter stage   | query-pipeline.ts               | Medium |
| 7   | Broad-facet threshold (skip doc IDs)  | Facet query service             | Small  |

Items 1-2 are changes to existing code (ClickHouse patterns already exist).
Items 3-7 are new runtime code.

**Removed from previous design:**

- ~~MongoDB compound indexes~~ — not needed, ClickHouse replaces MongoDB for facets
- ~~Document→EntityInstance edges in Neo4j~~ — not needed, ClickHouse has doc IDs
- ~~Write to `metadata.canonical.custom`~~ — no read path, wasted work
- ~~Neo4j for facet counts~~ — wrong (global counts, not filtered)

---

## Part 2: Consistent Generation Design — How to Extract Reliably

### The Problem

When 10,000 documents are processed, the same concept must resolve to ONE
canonical attribute:

```
Document 1: "Annual Percentage Rate: 18.9%"    →  interest_rate: 0.189
Document 2: "APR of 15.99%"                    →  interest_rate: 0.1599
Document 3: "annual rate is currently 22.5%"    →  interest_rate: 0.225
Document 4: "contactless payment supported"     →  ??? (not in taxonomy)
Document 5: "NFC-enabled for tap-to-pay"        →  ??? (same as contactless?)
```

### Token Optimization: Reuse What's Already Paid For

The ingestion pipeline already generates high-quality summaries via LLM. The
current KG enrichment ignores them completely. This is the biggest win.

```
WHAT EXISTS (already paid for during ingestion):
═══════════════════════════════════════════════

  document.metadata.documentSummary   ← LLM doc summary (100-300 tokens)
    Set by: page-processing-worker via ProgressiveSummarizationService
    Quality: High (Haiku, context-aware)
    Cost: Already paid (~$0.0002/doc)

  chunk.metadata.progressiveSummary   ← LLM chunk summary (50-150 tokens)
    Set by: page-processing-worker
    Quality: High (chained, section-aware)
    Cost: Already paid (~$0.0002/chunk)

WHAT KG ENRICHMENT USES TODAY (wasteful):
═════════════════════════════════════════

  document.summary                    ← STUB! First 500 chars truncated!
    Quality: Garbage (random cutoff mid-sentence)
    → classifier gets bad input → low confidence → escalates to Sonnet ($$$)

  chunk.content                       ← Raw text (500-2000 tokens)
    → entity extractor processes FULL raw text
    → 3-5x more tokens than the summary which has the same facts
```

**Three optimizations:**

| #   | Optimization                                                 | Token Savings                         | Quality Impact                                                  |
| --- | ------------------------------------------------------------ | ------------------------------------- | --------------------------------------------------------------- |
| 1   | Use `metadata.documentSummary` for classification (not stub) | Same tokens, FEWER Sonnet escalations | ↑ Better classification                                         |
| 2   | Use `metadata.progressiveSummary` for entity extraction      | 3-5x reduction per chunk              | ≈ Same for categorical attrs, slight ↓ for exact numeric values |
| 3   | Doc-level pass first, chunk-level only for gaps              | Skip 60-80% of chunk-level calls      | ≈ Same (doc summary captures most attrs)                        |

### Optimized Pipeline: Summary-First, Chunk-Drill-Down

```
STEP 1: DOCUMENT-LEVEL (1 LLM call, ~300 input tokens)
═══════════════════════════════════════════════════════

  Input: document.metadata.documentSummary (NOT stub)
       + taxonomy (known attributes for classified product)
       + org profile context (aliases, ranges)

  Combined prompt does BOTH classification + extraction:
  "Classify this document AND extract all product attributes."

  Output:
    classification: { product: "credit_card", department: "Card Services" }
    known_attrs: [
      { id: "interest_rate", value: 0.189, confidence: 0.95 },
      { id: "credit_limit", value: 50000, confidence: 0.90 }
    ]
    novel_candidates: [
      { name: "contactless_payment", definition: "...", value: true }
    ]
    needs_chunk_drill: false  ← LLM self-assesses if summary was sufficient

  Cost: ~$0.0003/doc (Haiku, 300 in + 200 out tokens)
  Consistency: ★★★★★ for known, ★★★☆☆ for novel

  If needs_chunk_drill = false → DONE for this document
  If needs_chunk_drill = true → Step 2


STEP 2: CHUNK-LEVEL DRILL-DOWN (only when needed)
══════════════════════════════════════════════════

  Only for documents where Step 1 found:
  - Low confidence on a known attribute (need exact value)
  - High-value novel candidates (need more examples)
  - Or document summary was too short/generic

  Input: chunk.metadata.progressiveSummary (NOT raw content)
       + known attributes list (only ones NOT yet found)
       + novel candidates from Step 1 (verify/extend)

  For each chunk with progressiveSummary:
    Regex first (free, on raw chunk.content for exact patterns)
    LLM only if regex misses AND summary mentions relevant terms

  Cost: ~$0.0001/chunk (Haiku, 150 in + 100 out tokens)
  Only 20-40% of chunks need this (rest were captured at doc level)


STEP 3: RAW CONTENT FALLBACK (rare)
════════════════════════════════════

  Only for:
  - Documents WITHOUT progressiveSummary (non-Docling path)
  - Chunks where summary-based extraction found hints but needs
    exact values from raw text (e.g., "mentions interest rate"
    but summary didn't include the number)

  Input: chunk.content (raw text, 500-2000 tokens)
  This is the current behavior — kept as last resort

  Cost: ~$0.0002/chunk (same as today)
  Expected: <10% of chunks
```

**Cost comparison for a 20-chunk document:**

```
TODAY:
  1 classification call (stub summary)      $0.0002
  + Sonnet escalation (30% chance)          $0.0006 avg
  + 20 chunk extractions (LLM fallback)     $0.004
  = $0.0048 per document

OPTIMIZED:
  1 combined call (real doc summary)        $0.0003
  + 0 Sonnet escalations (good summary)    $0.0000
  + 4-8 chunk drilldowns (20-40%)          $0.0004-$0.0008
  = $0.0007-$0.0011 per document

SAVINGS: ~75-85% token cost reduction
```

### Industry Consensus

No platform (Palantir Foundry, Databricks, Alation) fully automates canonical
normalization. All rely on **human-in-the-loop at the canonicalization layer**.
The automation is in discovery and suggestion, not in final naming.

### Design: EDC Pipeline (Extract → Define → Canonicalize)

Inspired by the EDC framework (EMNLP 2024) and adapted for our 3-layer model.
The key change from the original design: use **summaries as primary input**
instead of raw content, with raw content as fallback only.

```
┌─────────────────────────────────────────────────────────────┐
│           DOCUMENT-LEVEL EXTRACTION (Step 1)                 │
│                                                              │
│  Input: metadata.documentSummary + taxonomy + org context    │
│                                                              │
│  ┌─────────────────────┐    ┌──────────────────────────┐    │
│  │ CLASSIFY + GUIDED   │    │ OPEN DISCOVERY           │    │
│  │ (combined, Layer 1) │    │ (Layer 2, same call)     │    │
│  │                     │    │                          │    │
│  │ "Classify this doc  │    │ "Also report any other   │    │
│  │  AND extract these  │    │  product attributes you  │    │
│  │  known attributes:  │    │  find NOT in the list    │    │
│  │  - interest_rate    │    │  above. Include a 1-line │    │
│  │  - credit_limit"    │    │  definition for each."   │    │
│  │                     │    │                          │    │
│  │ Uses: doc summary   │    │ Same input, extra output │    │
│  │ Consistency: ★★★★★  │    │ Consistency: ★★☆☆☆       │    │
│  └─────────┬───────────┘    └────────────┬─────────────┘    │
│            └────────────────┬────────────┘                   │
│                             ▼                                │
│  Output: classification + known_attrs + novel_candidates     │
│        + needs_chunk_drill (boolean)                         │
└──────────────────────────────┬───────────────────────────────┘
                               │
              ┌────────────────┴───────────────────┐
              ▼                                    ▼
        needs_drill=false                    needs_drill=true
        DONE (most docs)                           │
                                                   ▼
                                  ┌───────────────────────────┐
                                  │ CHUNK DRILL-DOWN (Step 2) │
                                  │                           │
                                  │ Input: progressiveSummary │
                                  │ + unfound known attrs     │
                                  │ + novel candidates to     │
                                  │   verify                  │
                                  │                           │
                                  │ Regex on raw content FIRST│
                                  │ LLM only if regex misses  │
                                  └─────────────┬─────────────┘
                                                │
                    Stored immediately:          │
                    - Tier 1 → Neo4j + MongoDB   │
                    - Tier 3 → Candidate store   │
                               │                 │
                               ▼                 ▼
┌─────────────────────────────────────────────────────────────┐
│            BATCH RECONCILIATION (Layer 3)                     │
│            Runs periodically (after each enrichment batch)    │
│                                                              │
│  Step 1: COLLECT all novel candidates from this batch        │
│    "contactless_payment" (from 234 docs)                     │
│    "nfc_payment" (from 89 docs)                              │
│    "tap_to_pay" (from 45 docs)                               │
│    "apple_pay_support" (from 67 docs)                        │
│    "foreign_txn_fee" (from 12 docs)                          │
│    "card_color" (from 3 docs)                                │
│                                                              │
│  Step 2: EMBED names + definitions using bge-m3              │
│    (model already deployed in our stack)                      │
│                                                              │
│  Step 3: MATCH against existing canonical attributes         │
│    Cosine similarity > 0.85 → merge into existing            │
│    "nfc_payment" ↔ "contactless_payment" = 0.91 → merge     │
│    "tap_to_pay" ↔ "contactless_payment" = 0.87 → merge      │
│                                                              │
│  Step 4: CLUSTER remaining with DBSCAN (eps=0.80)           │
│    Cluster A: ["contactless_payment", "nfc_payment",         │
│                "tap_to_pay"] → elect: "contactless_payment"  │
│    Cluster B: ["apple_pay_support"] → standalone             │
│    Cluster C: ["foreign_txn_fee"] → standalone               │
│    Noise: ["card_color"] (3 docs, no cluster)                │
│                                                              │
│  Step 5: AUTO-PROMOTE or QUEUE for review                    │
│    Rules:                                                    │
│    - frequency ≥ 50 docs AND confidence ≥ 0.80 → Tier 2     │
│    - frequency < 50 OR confidence < 0.80 → stays Tier 3     │
│    - frequency < 5 → DISCARD (noise)                         │
│                                                              │
│    "contactless_payment" (368 docs total) → AUTO → Tier 2   │
│    "apple_pay_support" (67 docs) → AUTO → Tier 2            │
│    "foreign_txn_fee" (12 docs) → PENDING REVIEW → Tier 3    │
│    "card_color" (3 docs) → DISCARDED                         │
│                                                              │
│  Step 6: GENERATE few-shot examples for promoted attributes  │
│    For "contactless_payment":                                │
│      examples: ["contactless", "NFC", "tap-to-pay",         │
│                 "tap and pay", "contactless enabled"]        │
│      regex: /\b(contactless|nfc|tap.to.pay)\b/i             │
│    → Added to taxonomy as Tier 2 attribute                   │
│    → Future extraction uses these as known attributes        │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

### Consistency Guarantees by Tier

```
TIER 1: PERMANENT (from domain definition)
  ┌────────────────────────────────────────────────┐
  │ Source: Domain definition JSON (admin-authored) │
  │ ID: Pre-defined (e.g., "interest_rate")        │
  │ Extraction: Regex patterns + scoped LLM        │
  │ Aliases: From org profile + domain def         │
  │ Consistency: ★★★★★ (deterministic ID)          │
  │ Examples: interest_rate, credit_limit, emi      │
  └────────────────────────────────────────────────┘

TIER 2: APPROVED (discovered + promoted)
  ┌────────────────────────────────────────────────┐
  │ Source: LLM discovery → reconciliation          │
  │ ID: Elected canonical name from cluster         │
  │ Extraction: Auto-generated regex + LLM hints    │
  │ Aliases: Cluster members become aliases          │
  │ Consistency: ★★★★☆ (generated patterns,         │
  │   improving with each batch)                    │
  │ Examples: contactless_payment, apple_pay_support │
  └────────────────────────────────────────────────┘

TIER 3: PENDING (discovered, not yet promoted)
  ┌────────────────────────────────────────────────┐
  │ Source: LLM discovery, low frequency/confidence │
  │ ID: Raw LLM-generated name (may have dupes)     │
  │ Stored in: Candidate registry only              │
  │ NOT exposed: Not in Browse SDK, not in Neo4j    │
  │ Consistency: ★★☆☆☆ (LLM-dependent)             │
  │ Fate: Auto-promote, admin review, or discard    │
  └────────────────────────────────────────────────┘
```

### LLM Prompt Design (Single Call, Dual Output)

```yaml
system: |
  You are an entity extractor for {{domain}} documents.

  PART A — KNOWN ATTRIBUTES (extract these if present):
  {{#each knownAttributes}}
  - {{this.id}} ({{this.name}}): type={{this.dataType}}
    hints: [{{this.extraction.keywords}}]
    {{#if this.organizationContext}}
    context: range={{this.organizationContext.typicalRange}},
      aliases=[{{this.organizationContext.aliases}}]
    {{/if}}
  {{/each}}

  PART B — NOVEL DISCOVERY (report anything else):
  If you find product attributes NOT listed above, report them too.
  For each novel attribute, provide:
  - name: snake_case canonical name
  - definition: one sentence explaining what this attribute means
  - value: the extracted value
  - dataType: string|number|boolean|date|currency|percentage

  OUTPUT FORMAT (JSON):
  {
    "known": [
      { "attributeId": "interest_rate", "rawValue": "18.9% APR",
        "normalizedValue": 0.189, "confidence": 0.95 }
    ],
    "novel": [
      { "name": "contactless_payment",
        "definition": "Whether the card supports NFC contactless transactions",
        "rawValue": "contactless enabled", "normalizedValue": true,
        "dataType": "boolean", "confidence": 0.85 }
    ]
  }

  RULES:
  1. For known attributes: use the EXACT attributeId provided
  2. For novel attributes: use consistent snake_case naming
  3. Include a 1-sentence definition for EVERY novel attribute
     (this definition is used for deduplication — be precise)
  4. Confidence 0.0-1.0 for each extraction
  5. Only extract attributes of the product being discussed
  6. If the same concept appears in the known list, use the known ID
     (do NOT re-report known attributes as novel)
```

**Token budget per document (optimized):**

- Step 1 (doc summary): ~300 input + 200 output = ~$0.0003 (Haiku)
- Step 2 (chunk drilldown, 20-40% of chunks): ~150 input + 100 out = ~$0.0001/chunk
- Step 3 (raw fallback, <10% of chunks): ~1000 input + 200 out = ~$0.0002/chunk
- Total: ~$0.0007-0.0011/doc vs ~$0.0048/doc today (**75-85% savings**)

### Deduplication: Attribute Fingerprinting

Name-only similarity misses homonyms. We use multi-signal fingerprints:

```
Fingerprint = {
  name_embedding:    embed(name + definition)     // semantic meaning
  data_type:         "boolean"                     // structural constraint
  value_distribution: { true: 368, false: 45 }    // value profile
  product_context:   ["credit_card", "debit_card"] // which products
  co_occurrence:     ["rewards_program", "annual_fee"]  // neighbors
}

Match score = weighted combination:
  0.40 × name_embedding_cosine
  0.20 × data_type_match (1.0 or 0.0)
  0.15 × product_context_jaccard
  0.15 × co_occurrence_jaccard
  0.10 × value_distribution_similarity

Thresholds:
  score ≥ 0.85 → auto-merge (same attribute)
  score 0.70-0.85 → flag for review
  score < 0.70 → distinct attributes
```

### What Needs To Be Built for Generation

| #   | Change                     | Where                              | Effort |
| --- | -------------------------- | ---------------------------------- | ------ |
| 1   | Dual-output LLM prompt     | entity-extractor.service.ts        | Medium |
| 2   | Attribute Registry model   | New model in packages/database     | Small  |
| 3   | Reconciliation service     | New service in search-ai           | Large  |
| 4   | Embedding-based clustering | New service (uses existing bge-m3) | Medium |
| 5   | Auto-promotion rules       | Part of reconciliation service     | Small  |
| 6   | Few-shot example generator | Part of reconciliation service     | Small  |
| 7   | Admin review API + UI      | Routes + Studio component          | Large  |

---

## Part 3: Combined Architecture

### Critical Fix: `document.summary` vs `metadata.documentSummary`

The KG enrichment worker currently reads `document.summary` (a top-level field)
and filters `summary: { $ne: null }`. But the ingestion pipeline writes to
`metadata.documentSummary` (nested in metadata) via page-processing-worker.
These are **two different fields**. The top-level `summary` may be empty or a
500-char stub, while `metadata.documentSummary` is a high-quality LLM summary.

**Fix:** Change the KG enrichment worker to read `metadata.documentSummary`
instead of `summary`. Update the query filter to check the correct field path.

### Runtime Architecture: TaxonomyGraphService Access

search-ai-runtime currently has Neo4j access ONLY for `PermissionGraphService`
(user/group ACL). It does NOT have `TaxonomyGraphService` — that lives only in
the search-ai engine app.

**Approach:** Cache taxonomy trees in Redis during KG enrichment (engine writes).
Runtime reads taxonomy from Redis — no direct Neo4j dependency for taxonomy.
This also gives the ~1ms cache hit that Part 1 promises.

```
Engine (search-ai):                      Runtime (search-ai-runtime):
  TaxonomyGraphService                     Redis client (already exists)
    │                                        │
    ├─→ Neo4j: write taxonomy                ├─→ Redis: read taxonomy tree
    └─→ Redis: cache taxonomy tree           ├─→ ClickHouse: facet queries
         key: taxonomy:{tenantId}:{indexId}  └─→ OpenSearch: search + rank
         TTL: 5 min
         Invalidate: on enrichment complete
```

### End-to-End Data Flow

```
INGESTION TIME (progressive summarization — already happens)
═══════════════
  page-processing-worker:
    chunk.metadata.progressiveSummary  ← LLM summary per chunk (PAID)
    document.metadata.documentSummary  ← LLM doc summary (PAID)

KG ENRICHMENT (reuses summaries)          BATCH (periodic)
═══════════════════════════               ════════════════

Step 1: Doc-level (1 LLM call)           Reconciliation Service
  Input: metadata.documentSummary          1. Collect novel candidates
    (NOT top-level summary!)               2. Embed names+definitions
  Output: classification +                 3. Match against known attrs
    known attrs + novel candidates         4. DBSCAN cluster remaining
    + needs_chunk_drill                    5. Auto-promote or queue
      │                                    6. Generate regex patterns
      ├── needs_drill=false → DONE         7. Update taxonomy with
      │                                       new Tier 2 attributes
      └── needs_drill=true                       │
            │                                    │
            ▼                                    ▼
Step 2: Chunk drilldown (20-40%)           Next enrichment batch
  Input: chunk.metadata.progressiveSummary uses expanded taxonomy
  Regex on raw content FIRST               (virtuous cycle)
  LLM only if regex misses
      │
      ▼
Write to stores:
  ├─→ Neo4j: EntityInstance nodes (deduplicated, no doc edges)
  ├─→ MongoDB: SearchDocument.entityInstances[] (per-doc attrs)
  ├─→ MongoDB: Attribute Registry (Tier 3 novel candidates only)
  ├─→ ClickHouse: entity_instances table (one row per attr per doc)
  │     via BufferedClickHouseWriter, batch flush after doc batch
  ├─→ Redis: cache taxonomy tree for runtime to read
  └─→ OpenSearch: classification fields in metadata.canonical.*
       (primaryProduct, department, category — NOT flat metadata)


QUERY TIME — BROWSE-FIRST MODE
═══════════════════════════════
User clicks through taxonomy facets (no text query)

  1. Redis: taxonomy tree (cached by engine during enrichment)
     → Categories, Products, Attributes
     → ~1ms (cache hit) / ~30ms (cache miss → engine API fallback)

  2. ClickHouse: facet values + counts for selected product
     → ~5ms

  3. User selects facet values →
     ClickHouse: multi-facet filter → document IDs
     → ~3ms

  4. OpenSearch: ranked results within those doc IDs
     (vector/hybrid search with terms filter)
     → ~80ms

  Total: ~90ms warm, ~120ms cold


QUERY TIME — SEARCH-FIRST MODE
═══════════════════════════════
User types a query, facets update to show refinement options

  1. OpenSearch: vector/hybrid search → top-N result doc IDs
     → ~100ms

  2. ClickHouse: post-search facet counts WITHIN result doc IDs
     (correct counts, not global — the key requirement)
     → ~10ms for result sets ≤10K docs

  3. User selects a facet →
     ClickHouse: narrow doc IDs by facet selection
     → ~3ms

  4. OpenSearch: re-search within narrowed doc IDs
     → ~80ms

  Total: ~110ms first load, ~85ms per facet refinement
```

---

## Part 4: Domain Definitions → Attribute Lifecycle

### How Tier 1 Attributes Are Created Today

The existing system creates initial attributes from two admin-provided inputs:

```
ADMIN INPUTS (both uploaded via Studio KG Tab):
══════════════════════════════════════════════

1. DOMAIN DEFINITION (e.g., banking.md)
   Defines the taxonomy structure:
   - Departments: Card Services, Lending, Deposits, Wealth Management
   - Products: credit_card, debit_card, housing_loan, personal_loan...
   - Attributes per product:
     interest_rate: { dataType: percentage, applicableTo: [credit_card, housing_loan],
                      extraction: { method: hybrid, patterns: [/\d+\.?\d*\s*%/],
                                    keywords: ["APR", "annual rate", "interest"] } }
     credit_limit:  { dataType: currency, applicableTo: [credit_card],
                      extraction: { method: hybrid, keywords: ["limit", "credit line"] } }
   - Department boundaries, disambiguation rules, entity types

2. ORGANIZATION PROFILE (e.g., acme-bank.md)
   Adds customer-specific context overlays:
   - Product aliases: "Platinum Card" → credit_card, "Home Loan" → housing_loan
   - Attribute context:
     interest_rate: { typicalRange: "12-28%", aliases: ["APR", "annual charge"] }
     credit_limit:  { typicalRange: "$5K-$100K", aliases: ["spending power"] }

MERGE (TaxonomyLoaderService.mergeTaxonomy):
════════════════════════════════════════════
   Domain def attributes + org profile context → merged taxonomy
   Each attribute gets: id, name, dataType, applicableTo, extraction patterns,
                        AND organizationContext (aliases, typicalRange)

   This merged taxonomy is what EntityExtractorService uses for extraction.
   getApplicableAttributes(taxonomy, productType) → scoped attribute list
```

### What's Broken Today

```
PROBLEM 1: Domain definition loading is broken
  parseDomainDefinition() only handles .json files
  BUT all 7 domain definitions are .md files (banking.md, insurance.md, etc.)
  → Domain defs CANNOT be loaded → Tier 1 attributes don't work

PROBLEM 2: Single domain only
  mergeTaxonomy() throws if >1 domain definition is provided
  Multi-domain (banking + insurance) is not supported yet

PROBLEM 3: No bridge to ClickHouse
  Merged taxonomy attributes go to EntityExtractorService → Neo4j + MongoDB
  But the new design needs them in ClickHouse entity_instances table too
  This is covered in Part 1 (Layer 1 task: write to ClickHouse during enrichment)
```

### Tier 1 Attributes Are the Foundation

The Browse SDK attribute lifecycle starts with Tier 1:

```
Domain Definition (admin-authored)
        │
        ▼
  Tier 1: PERMANENT attributes
  ┌────────────────────────────────────┐
  │ interest_rate, credit_limit,       │
  │ annual_fee, rewards_program...     │
  │ (~30 for banking domain)           │
  │                                    │
  │ These are ALWAYS extracted         │
  │ These are ALWAYS shown in SDK      │
  │ These have deterministic IDs       │
  │ These have regex + LLM patterns    │
  └──────────────┬─────────────────────┘
                 │
    KG enrichment processes documents
    LLM also discovers novel attributes
                 │
                 ▼
  Tier 3: BETA attributes (novel discoveries)
  ┌────────────────────────────────────┐
  │ contactless_payment, nfc_payment,  │
  │ apple_pay_support, foreign_txn_fee │
  │                                    │
  │ Shown only in beta SDK URL         │
  │ User interactions tracked          │
  └──────────────┬─────────────────────┘
                 │
    Auto-promoted based on usage data
    OR admin-approved via review UI
                 │
                 ▼
  Tier 2: APPROVED attributes (promoted)
  ┌────────────────────────────────────┐
  │ contactless_payment (from 368 docs)│
  │ apple_pay_support (from 67 docs)   │
  │                                    │
  │ Shown in production SDK            │
  │ Have auto-generated regex patterns │
  │ Added to taxonomy for future runs  │
  └────────────────────────────────────┘
```

### Fixes Required for Domain Definitions

| #   | Fix                                     | Where                       | Effort |
| --- | --------------------------------------- | --------------------------- | ------ |
| 1   | Support .md parsing in parseDomainDef   | taxonomy-loader.service.ts  | Medium |
| 2   | Multi-domain merge support              | taxonomy-loader.service.ts  | Medium |
| 3   | Write Tier 1 attrs to ClickHouse        | kg-enrichment-worker.ts     | Small  |
| 4   | Populate org profile context in prompts | entity-extractor.service.ts | Small  |

---

## Part 5: ClickHouse Data Lifecycle

### Source of Truth

```
SOURCE OF TRUTH per store:
══════════════════════════

MongoDB SearchDocument.entityInstances[]
  → Source of truth for WHAT attributes a document has
  → Written during KG enrichment (per-document, per-attribute)
  → Used for: re-enrichment diffing, document detail view

ClickHouse entity_instances table
  → DERIVED from MongoDB (write-through during enrichment)
  → Optimized for: facet queries, aggregation, filtering
  → If ClickHouse is down: facets degrade, search still works

Neo4j EntityInstance nodes
  → Source of truth for TAXONOMY structure
  → Deduplicated: one node per attributeId:normalizedValue
  → Used for: taxonomy tree, attribute catalog

Redis taxonomy cache
  → DERIVED from Neo4j (cache-aside pattern)
  → TTL: 5 min, invalidated on enrichment complete
  → If Redis is down: runtime calls engine API as fallback

MongoDB Attribute Registry
  → Source of truth for ATTRIBUTE METADATA
  → Tier, status, aliases, extraction patterns, approval state
  → Used for: admin review UI, auto-promotion decisions
```

### Write Path (During KG Enrichment)

```
kg-enrichment-worker processes a document batch:

  For each document:
    1. Classify + extract (LLM call → known_attrs + novel_candidates)
    2. Write to MongoDB: SearchDocument.entityInstances[]
    3. Write to Neo4j: batchUpsertEntityInstances (deduplicated)
    4. Accumulate ClickHouse rows in BufferedClickHouseWriter

  After document batch:
    5. BufferedClickHouseWriter auto-flushes (batch 5K, interval 3s)
    6. Write novel candidates to MongoDB Attribute Registry
    7. Update Redis taxonomy cache (invalidate + refresh)

  After full index enrichment:
    8. Trigger reconciliation batch job (deduplicate, cluster, promote)
```

### Failure Handling

```
CLICKHOUSE DOWN during enrichment:
  BufferedClickHouseWriter has maxRetries: 3
  On persistent failure: rows dropped (logged with onError callback)
  MongoDB still has the data → ClickHouse can be backfilled:

  BACKFILL QUERY (MongoDB → ClickHouse):
    For each SearchDocument with entityInstances[]:
      Generate ClickHouse rows from entityInstances[]
      Insert via BufferedClickHouseWriter
    Run after ClickHouse recovers

  Impact: Facet queries return stale/incomplete data
          Search still works (OpenSearch unaffected)
          Admin notified via structured log alert

MONGODB DOWN during enrichment:
  Worker fails entirely (cannot read documents)
  BullMQ retries the job (default: 3 attempts with backoff)
  No partial state to clean up

NEO4J DOWN during enrichment:
  taxonomyGraph.batchUpsertEntityInstances() fails
  Document is marked as NOT_ENRICHED in MongoDB
  Other stores (ClickHouse, OpenSearch) still receive their writes
  Re-enrichment picks up failed documents on next run

REDIS DOWN during query:
  Runtime can't read taxonomy cache
  Fallback: call engine API directly for taxonomy tree
  Latency: ~30ms instead of ~1ms (acceptable degradation)
```

### Schema Evolution

```
ADDING NEW COLUMNS to entity_instances:
  ClickHouse supports ALTER TABLE ADD COLUMN (online, no downtime)
  Example: adding a "source_chunk_ids" Array(String) column later
  Existing rows get the default value (empty array)

ADDING NEW ATTRIBUTE TYPES:
  No schema change needed — attribute_type is LowCardinality(String)
  New attribute types are just new string values
  ClickHouse dictionary encoding handles new values automatically

CHANGING DATA TYPES:
  Not supported (ClickHouse is append-only conceptually)
  Instead: add a new typed column + backfill
  Example: if we need Array(Float64) for multi-value numbers:
    ALTER TABLE ADD COLUMN number_values Array(Float64)
    INSERT INTO ... SELECT ... FROM ... (backfill)

INDEX DELETION CLEANUP:
  ALTER TABLE abl_platform.entity_instances
    DELETE WHERE tenant_id = {t:String} AND index_id = {i:String}
  Creates a lightweight mutation (data is well-sorted by ORDER BY prefix)
  ~seconds for 100K rows, background merge cleans up
```

### Data Volume Estimates

```
Per index:
  10K documents × 10 attributes/doc = 100K rows
  Each row: ~200 bytes (with LowCardinality compression)
  Total: ~20MB per index in ClickHouse

At scale:
  100 indexes × 100K rows = 10M rows = ~2GB
  ClickHouse handles this trivially (designed for billions)

  1000 indexes × 100K rows = 100M rows = ~20GB
  Still well within single-node ClickHouse capacity

Facet_interactions (Part 7):
  1M impressions/month × 100 bytes = ~100MB/month
  TTL 90 days → max ~300MB
```

---

## Part 6: Relationship Model

### Which Relations Exist and How They're Established

```
LAYER 1: STRUCTURAL (from domain definition — admin-authored)
═══════════════════════════════════════════════════════════

  Domain → Category → Product → Attribute
  ─────────────────────────────────────────
  Banking → Cards → Credit Card → interest_rate
                                → credit_limit
                                → annual_fee
         → Lending → Housing Loan → interest_rate (different context!)
                                  → loan_tenure

  HOW: Admin uploads domain definition (.md or .json)
  REVIEW: Admin authored it, so implicitly reviewed
  STORED: Neo4j taxonomy graph + Redis cache


LAYER 2: ATTRIBUTE ALIASES (from org profile + reconciliation)
═════════════════════════════════════════════════════════════

  interest_rate ← "APR" (org profile)
                ← "annual percentage rate" (reconciliation)
                ← "yearly rate" (reconciliation)

  contactless_payment ← "nfc_payment" (reconciliation cluster)
                      ← "tap_to_pay" (reconciliation cluster)

  HOW: Org profile → LLM extraction → aliases
       Reconciliation → embedding similarity → cluster members become aliases
  REVIEW: NOT reviewed (automatic). Safe because:
    - Aliases don't change the canonical attribute ID
    - Wrong alias = extraction misses, not data corruption
    - Can be corrected by adding to org profile explicitly
  STORED: Attribute Registry (MongoDB) + taxonomy merge


LAYER 3: CO-OCCURRENCE (statistical, from document analysis)
═══════════════════════════════════════════════════════════

  interest_rate ↔ credit_limit: 89% co-occurrence in credit card docs
  annual_fee ↔ rewards_program: 76% co-occurrence
  interest_rate ↔ loan_tenure: 92% co-occurrence in loan docs

  HOW: During reconciliation batch, compute:
    For each pair of attributes seen in the same document,
    count(both_present) / count(either_present) = Jaccard similarity
  PURPOSE: Used in deduplication fingerprinting (Part 2)
           Used in facet relevance scoring (show related facets first)
  REVIEW: NOT reviewed. These are statistical facts, not design decisions.
  STORED: ClickHouse (computed from entity_instances on-the-fly)

  SQL for co-occurrence:
    SELECT a1.attribute_type, a2.attribute_type,
           count(DISTINCT a1.document_id) AS co_doc_count
    FROM abl_platform.entity_instances a1
    JOIN abl_platform.entity_instances a2
      ON a1.tenant_id = a2.tenant_id
      AND a1.index_id = a2.index_id
      AND a1.document_id = a2.document_id
      AND a1.attribute_type < a2.attribute_type  -- avoid duplicates
    WHERE a1.tenant_id = {t:String} AND a1.index_id = {i:String}
    GROUP BY a1.attribute_type, a2.attribute_type
    ORDER BY co_doc_count DESC
    LIMIT 100


LAYER 4: PRODUCT SCOPE (from classification — automatic)
═══════════════════════════════════════════════════════

  interest_rate → applies to: credit_card, housing_loan, personal_loan
                  NOT: savings_account (different concept: "interest earned")

  HOW: During extraction, the document's classified product type is recorded
       alongside the attribute in ClickHouse (product_type column)
  PURPOSE: Scope facets to current product context in Browse SDK
           Prevent showing irrelevant facets
  REVIEW: NOT reviewed. Domain definition pre-defines applicableTo for Tier 1.
          For Tier 2/3, product scope is inferred from which documents the
          attribute appears in.
  STORED: ClickHouse entity_instances.product_type column
```

### What's Reviewable vs Automatic

```
NEEDS REVIEW (small, finite set):
  ┌─────────────────────────────────────────────────────┐
  │ 1. MERGE DECISIONS (deduplication)                  │
  │    "Is nfc_payment the same as contactless_payment?"│
  │    Score 0.70-0.85 → ambiguous → show to admin      │
  │    ~5-20 decisions per enrichment batch              │
  │                                                     │
  │ 2. TAXONOMY PLACEMENT (for promoted Tier 2 attrs)   │
  │    "Does apple_pay_support apply to debit cards too?"│
  │    System suggests based on document distribution    │
  │    Admin confirms or adjusts applicableTo            │
  │    ~3-10 decisions per promotion cycle               │
  │                                                     │
  │ 3. DATA TYPE CONFLICTS                              │
  │    "credit_limit extracted as string '50K' and as    │
  │     number 50000 — which is correct?"               │
  │    ~rare, <5 per batch                              │
  └─────────────────────────────────────────────────────┘

FULLY AUTOMATIC (no review needed):
  ┌─────────────────────────────────────────────────────┐
  │ - Co-occurrence statistics (facts, not decisions)    │
  │ - Product scope inference (from document data)       │
  │ - Alias assignment from cluster members              │
  │ - High-confidence merges (score ≥ 0.85)              │
  │ - Auto-promotion from beta SDK usage data            │
  │ - Auto-demotion of unused beta attributes            │
  │ - Few-shot example generation                        │
  │ - Regex pattern generation for promoted attributes   │
  └─────────────────────────────────────────────────────┘
```

---

## Part 7: Beta SDK Self-Review & Attribute Promotion

### The Problem with Manual Review

If the system discovers 200 novel attributes across 10K documents, asking an
admin to review each one is impractical. Most admins will either:

- Approve everything (rubber stamp) — defeating the purpose
- Ignore the queue — attributes stay in limbo forever
- Cherry-pick a few — inconsistent coverage

**Solution:** Let real users review attributes by using them. Show beta
attributes in a beta SDK URL, track interactions, and auto-promote based on
actual usage patterns.

### Attribute Tier Lifecycle (Revised)

```
┌─────────────────────────────────────────────────────────┐
│                   ATTRIBUTE LIFECYCLE                      │
│                                                           │
│  DISCOVERED by LLM during enrichment                      │
│       │                                                   │
│       ├── frequency < 5 docs → DISCARDED (noise)          │
│       │                                                   │
│       └── frequency ≥ 5 docs → Tier 3: BETA              │
│             │                                             │
│             │  Shown in beta SDK URL with "Beta" badge    │
│             │  Impressions and clicks tracked             │
│             │                                             │
│             ├── After 14 days:                            │
│             │     click_rate ≥ 5% AND unique_users ≥ 3    │
│             │     AND impressions ≥ 100                    │
│             │         → AUTO-PROMOTE to Tier 2            │
│             │                                             │
│             ├── After 14 days:                            │
│             │     click_rate < 1% OR impressions < 20      │
│             │         → AUTO-DEMOTE to DISCARDED           │
│             │                                             │
│             └── Between thresholds:                        │
│                   → Stays Tier 3 (needs more data)        │
│                   → Rotated in beta display slots          │
│                                                           │
│  Tier 2: APPROVED                                         │
│    Shown in production SDK (no badge)                     │
│    Added to taxonomy for future extraction                │
│    Has auto-generated regex patterns + few-shot examples  │
│    Can be demoted by admin if problematic                 │
│                                                           │
│  Tier 1: PERMANENT                                        │
│    From domain definition (admin-authored)                │
│    Always shown, never auto-demoted                       │
│    Can only be removed by editing domain definition       │
└─────────────────────────────────────────────────────────┘
```

### Beta SDK URL Design

```
PRODUCTION vs BETA:
═══════════════════

Production endpoint (default):
  GET /api/browse/v1/{indexId}/facets
  → Returns Tier 1 + Tier 2 attributes only
  → Clean, curated facet sidebar

Beta endpoint (opt-in):
  GET /api/browse/v1/{indexId}/facets?include_beta=true
  → Returns Tier 1 + Tier 2 + Tier 3 attributes
  → Tier 3 attributes marked with { tier: 'beta', badge: true }
  → Every facet render = impression event
  → Every facet click = click event

Studio preview widget:
  KG Tab → "Preview Browse SDK" button
  → Opens embeddable widget in slide-out panel
  → Toggle: "Show beta attributes" ON/OFF
  → Admin can see what end users would see in beta mode
```

### Facet Display Rules (Preventing Overwhelming UI)

```
RULE 1: MAX VISIBLE FACETS = 8 (configurable per index)
════════════════════════════════════════════════════════
  Tier 1 + Tier 2 always shown (they earned their spot)
  Remaining slots filled by top Tier 3 sorted by:
    - document frequency (more docs = more useful)
    - data type variety (prefer mix of string/number/boolean)
  "Show more attributes" expands to full list

RULE 2: FACET VALUE LIMIT = 10 per facet
════════════════════════════════════════
  Top 10 values sorted by doc_count within current results
  "Show all N values" link for expansion
  Values with 0 docs in current results: HIDDEN
  Prevents dead-end selections (Endeca pattern)

RULE 3: CONTEXT RELEVANCE — scope to current product
═══════════════════════════════════════════════════════
  If user browsed to "Credit Cards" → only show attributes
    WHERE product_type = 'credit_card' (ClickHouse filter)
  If search results span multiple products → show attributes
    WHERE product_type IN (distinct product types in results)
  Prevents showing "loan_tenure" when browsing credit cards

RULE 4: MINIMUM DISTINCTNESS — at least 2 values
═════════════════════════════════════════════════
  Don't show a boolean facet where all docs have value=true
  Don't show a string facet where all docs have same value
  These provide no filtering power

RULE 5: BETA FACET BUDGET = max 3 Tier 3 facets at a time
═══════════════════════════════════════════════════════════
  Prevents beta attributes from dominating the sidebar
  Rotate which Tier 3 facets are shown across page loads
    (round-robin by impression_count — ensure fair exposure)
  Tracks impression_count to ensure statistical significance
  After enough impressions: promote, demote, or keep rotating
```

### Facet Interaction Tracking (ClickHouse)

```sql
CREATE TABLE IF NOT EXISTS abl_platform.facet_interactions
(
    tenant_id      LowCardinality(String)  CODEC(ZSTD(1)),
    index_id       LowCardinality(String)  CODEC(ZSTD(1)),
    attribute_type String                  CODEC(ZSTD(1)),
    tier           LowCardinality(String)  CODEC(ZSTD(1)),
    action         LowCardinality(String)  CODEC(ZSTD(1)),
    user_id        String                  DEFAULT '' CODEC(ZSTD(1)),
    session_id     String                  CODEC(ZSTD(1)),
    query_context  String                  DEFAULT '' CODEC(ZSTD(1)),
    timestamp      DateTime               CODEC(DoubleDelta, ZSTD(1))
)
ENGINE = ReplicatedMergeTree(
    '/clickhouse/tables/{shard}/abl_platform.facet_interactions',
    '{replica}'
)
ORDER BY (tenant_id, index_id, attribute_type, timestamp)
TTL timestamp + INTERVAL 90 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
```

**Actions tracked:**

| Action       | When                               | Data                          |
| ------------ | ---------------------------------- | ----------------------------- |
| `impression` | Facet rendered in sidebar          | attribute_type, tier          |
| `click`      | User clicks a facet value          | attribute_type, tier, value   |
| `expand`     | User clicks "Show more values"     | attribute_type                |
| `remove`     | User deselects a facet             | attribute_type                |
| `search_hit` | Facet appears in search-first mode | attribute_type, query_context |

**Auto-promotion query (runs daily via cron job):**

```sql
-- Candidates for auto-promotion
SELECT attribute_type,
       countIf(action = 'click') AS clicks,
       countIf(action = 'impression') AS impressions,
       if(impressions > 0, clicks / impressions, 0) AS click_rate,
       uniqExact(user_id) AS unique_users
FROM abl_platform.facet_interactions
WHERE tenant_id = {t:String} AND index_id = {i:String}
  AND tier = 'beta'
  AND timestamp > now() - INTERVAL 14 DAY
GROUP BY attribute_type
HAVING click_rate >= 0.05       -- ≥5% click-through rate
   AND unique_users >= 3        -- at least 3 distinct users
   AND impressions >= 100       -- statistically meaningful sample
ORDER BY click_rate DESC

-- Candidates for auto-demotion
SELECT attribute_type,
       countIf(action = 'impression') AS impressions,
       countIf(action = 'click') AS clicks
FROM abl_platform.facet_interactions
WHERE tenant_id = {t:String} AND index_id = {i:String}
  AND tier = 'beta'
  AND timestamp > now() - INTERVAL 14 DAY
GROUP BY attribute_type
HAVING (impressions >= 100 AND clicks / impressions < 0.01)
    OR (impressions < 20 AND min(timestamp) < now() - INTERVAL 14 DAY)
```

### Auto-Suggestion Restriction (Search Bar)

When the user types in the search bar, the SDK can suggest facet-based
refinements. This needs careful restriction to avoid noise:

```
USER TYPES: "credit card with low int..."

AUTO-SUGGESTIONS (max 5):
  1. interest_rate < 15%        ← Tier 1 attribute, high frequency
  2. interest_rate: 10-15%      ← Tier 1, bucketed range suggestion
  3. international_usage: true  ← Tier 2, keyword match on "int..."
  ─── beta suggestions below ───
  4. introductory_rate: true    ← Tier 3 (beta badge), keyword match

RESTRICTION RULES:
  - Max 5 suggestions total
  - Max 1 beta suggestion (prevents noise)
  - Only suggest attributes with ≥10 docs in current product scope
  - Match on: attribute name, alias names, value labels
  - Don't suggest if current search already has that facet selected
  - Debounce: 300ms after last keystroke (no mid-typing flicker)
```

---

## Part 8: Attribute Review UX (Studio)

### What Admins Actually Need to Review

Most attributes are handled automatically. The review queue contains only
items that need human judgment — typically 5-20 items per enrichment batch.

### Review Queue: Three Categories

```
CATEGORY 1: MERGE CONFLICTS (dedup score 0.70-0.85)
════════════════════════════════════════════════════
The system found two attributes that MIGHT be the same thing
but isn't confident enough to auto-merge.

  ┌─────────────────────────────────────────────────────┐
  │ ⚠️  Possible duplicate detected                      │
  │                                                     │
  │  "nfc_payment" (boolean, 89 docs)                   │
  │  "contactless_payment" (boolean, 234 docs)          │
  │                                                     │
  │  Similarity: 0.78 (threshold for auto-merge: 0.85)  │
  │  Same data type: ✅                                  │
  │  Same products: credit_card, debit_card ✅           │
  │  Sample values: both true/false                     │
  │                                                     │
  │  [Merge into "contactless_payment"]  [Keep separate] │
  └─────────────────────────────────────────────────────┘


CATEGORY 2: TAXONOMY PLACEMENT (promoted Tier 2 attributes)
═══════════════════════════════════════════════════════════
A beta attribute was auto-promoted but the system needs
confirmation on which products it applies to.

  ┌─────────────────────────────────────────────────────┐
  │ ✅ Auto-promoted: "apple_pay_support"                │
  │                                                     │
  │  Found in: 67 docs (credit_card: 45, debit_card: 22)│
  │  Data type: boolean                                  │
  │  Click rate: 12% (well above 5% threshold)          │
  │                                                     │
  │  Suggested applicableTo:                            │
  │    ☑ credit_card (45 docs)                          │
  │    ☑ debit_card (22 docs)                           │
  │    ☐ prepaid_card (0 docs, but related product)     │
  │                                                     │
  │  [Confirm]  [Edit applicableTo]  [Revert to beta]   │
  └─────────────────────────────────────────────────────┘


CATEGORY 3: DATA TYPE CONFLICTS
═══════════════════════════════
Same attribute extracted with different data types across documents.

  ┌─────────────────────────────────────────────────────┐
  │ ⚠️  Type conflict: "credit_limit"                    │
  │                                                     │
  │  As number: 50000, 25000, 100000  (312 docs)        │
  │  As string: "$50K", "25,000", "1 lakh"  (23 docs)   │
  │                                                     │
  │  Recommendation: number (93% of extractions)         │
  │  String values appear to be formatting variants      │
  │                                                     │
  │  [Use number (normalize strings)]  [Keep as string]  │
  └─────────────────────────────────────────────────────┘
```

### Studio UI: Attribute Manager Tab

Location: KG Tab → new "Attributes" sub-tab (alongside existing Graph/Stats)

```
┌──────────────────────────────────────────────────────────┐
│  KG Tab:  [Graph]  [Stats]  [Attributes]  [Preview SDK]  │
├──────────────────────────────────────────────────────────┤
│                                                          │
│  Review Queue (3 items)                    [Dismiss all]  │
│  ┌────────────────────────────────────────────────────┐  │
│  │ ⚠️ Merge: nfc_payment ↔ contactless_payment        │  │
│  │ ⚠️ Placement: apple_pay_support (auto-promoted)     │  │
│  │ ⚠️ Type conflict: credit_limit (number vs string)   │  │
│  └────────────────────────────────────────────────────┘  │
│                                                          │
│  ─────────────────────────────────────────────────────── │
│                                                          │
│  All Attributes                    Filter: [All tiers ▾]  │
│                                    Search: [__________]   │
│                                                          │
│  ┌──────────────────┬──────┬──────┬───────┬───────────┐  │
│  │ Name             │ Type │ Tier │ Docs  │ Click Rate│  │
│  ├──────────────────┼──────┼──────┼───────┼───────────┤  │
│  │ interest_rate    │ num  │ T1 ● │ 8,234 │ —         │  │
│  │ credit_limit     │ num  │ T1 ● │ 6,102 │ —         │  │
│  │ annual_fee       │ num  │ T1 ● │ 5,890 │ —         │  │
│  │ contactless      │ bool │ T2 ● │ 368   │ 12.3%     │  │
│  │ apple_pay        │ bool │ T2 ● │ 67    │ 8.1%      │  │
│  │ foreign_txn_fee  │ num  │ T3 β │ 45    │ 3.2%      │  │
│  │ reward_points    │ num  │ T3 β │ 28    │ 1.5%      │  │
│  │ card_material    │ str  │ T3 β │ 8     │ 0.2%      │  │
│  └──────────────────┴──────┴──────┴───────┴───────────┘  │
│                                                          │
│  Selected: foreign_txn_fee                                │
│  ┌────────────────────────────────────────────────────┐  │
│  │ Aliases: "foreign transaction fee", "intl fee"      │  │
│  │ Products: credit_card (34), debit_card (11)         │  │
│  │ Value distribution: min=1.5%, max=5%, median=3%     │  │
│  │ Sample docs: [View 3 examples]                      │  │
│  │ Beta since: 2026-03-10 (8 days)                     │  │
│  │ Impressions: 67 | Clicks: 2 | CTR: 3.0%            │  │
│  │                                                     │  │
│  │ [Promote to Tier 2]  [Demote]  [Edit]  [Merge...]   │  │
│  └────────────────────────────────────────────────────┘  │
└──────────────────────────────────────────────────────────┘
```

### Admin Actions

| Action            | Effect                                             | Available on |
| ----------------- | -------------------------------------------------- | ------------ |
| Promote to Tier 2 | Immediately visible in production SDK              | Tier 3       |
| Demote / Discard  | Removed from beta SDK, data kept in ClickHouse     | Tier 2, 3    |
| Merge             | Combines two attributes, updates aliases           | Any tier     |
| Edit              | Change name, data type, applicableTo               | Tier 2, 3    |
| Edit extraction   | Modify regex patterns, keywords, few-shot examples | Tier 2       |
| View sample docs  | Shows 3-5 documents where attribute was extracted  | Any tier     |
| Revert to beta    | Moves back to Tier 3 (undo auto-promotion)         | Tier 2       |
| Force-extract     | Re-run extraction for this attribute on all docs   | Any tier     |

### What Needs To Be Built for Review + Beta SDK

| #   | Change                           | Where                             | Effort |
| --- | -------------------------------- | --------------------------------- | ------ |
| 1   | Attribute Registry model         | New model in packages/database    | Small  |
| 2   | facet_interactions CH table      | clickhouse-schemas/init.ts        | Small  |
| 3   | Interaction tracking middleware  | search-ai-runtime routes          | Small  |
| 4   | Auto-promotion cron job          | New worker in search-ai           | Medium |
| 5   | Facet display rules service      | New service in search-ai-runtime  | Medium |
| 6   | Beta SDK endpoint (include_beta) | search-ai-runtime routes          | Small  |
| 7   | Review queue API                 | New routes in search-ai           | Medium |
| 8   | Attribute Manager UI             | New Studio component (KG sub-tab) | Large  |
| 9   | SDK Preview widget               | New Studio embeddable component   | Large  |

---

## Summary: Fixed vs Moving

### Fixed (don't touch)

- OpenSearch 75-field mapping (dynamic: strict, 75 pre-defined fields)
- Neo4j graph structure (Domain→Category→Product→Attribute→EntityInstance)
- Neo4j deduplicated EntityInstance model (no per-document edges — intentional)
- MongoDB SearchDocument.entityInstances[] shape
- Entity extraction hybrid approach (regex + LLM)
- Document classification (YAML template, Haiku/Sonnet)
- Taxonomy loader merge logic
- Alias resolver (for canonical schema fields)
- ClickHouse schema init pattern (`packages/database/src/clickhouse-schemas/`)
- BufferedClickHouseWriter API and singleton client pattern

### Moving (implement in order)

**Layer 0 — Token Optimization (immediate wins, no new features):**

1. Fix `document.summary` → read `metadata.documentSummary` in KG worker
2. Use `metadata.progressiveSummary` for entity extraction (not raw `content`)
3. Combine classification + extraction into single doc-level LLM call
4. Add `needs_chunk_drill` self-assessment to skip unnecessary chunk calls
5. Fix OpenSearch write: classification to `metadata.canonical.*` (not flat)

**Layer 0.5 — Domain Definition Fixes (unblock Tier 1):**

6. Support .md parsing in `parseDomainDefinition()` (currently JSON-only)
7. Multi-domain merge support in `mergeTaxonomy()`
8. Populate org profile context (aliases, ranges) in extraction prompts

**Layer 1 — ClickHouse + Runtime Bridge (connect stores):**

9. ClickHouse `entity_instances` table DDL in `clickhouse-schemas/init.ts`
10. ClickHouse `facet_interactions` table DDL (Part 7)
11. Write entity instances to ClickHouse during KG enrichment
    (BufferedClickHouseWriter in kg-enrichment-worker)
12. ClickHouse backfill script (MongoDB → ClickHouse for existing data)
13. Cache taxonomy tree in Redis during enrichment (engine writes, runtime reads)
14. Build taxonomy browse API in search-ai-runtime (reads Redis, not Neo4j)
15. Build facet query API in search-ai-runtime (reads ClickHouse)
16. Build post-search facet counts API (ClickHouse within result doc IDs)
17. Add doc-ID filter stage to query pipeline (OpenSearch terms filter)
18. Add broad-facet threshold (skip doc IDs when >65K matches)

**Layer 2 — Discovery (find novel attributes):**

19. Dual-output LLM prompt (known + novel in one call)
20. Attribute Registry MongoDB model (canonical attrs + aliases + status + tier)
21. Store novel candidates during enrichment (Tier 3 with metadata)

**Layer 3 — Reconciliation (maintain consistency):**

22. Embedding-based clustering service (bge-m3 + DBSCAN)
23. Attribute fingerprinting (name + type + product context + co-occurrence)
24. Auto-promotion rules (frequency + confidence thresholds)
25. Few-shot example generator (patterns from confirmed examples)

**Layer 4 — Beta SDK + Self-Review (usage-driven promotion):**

26. Beta SDK endpoint (`?include_beta=true` param on facet API)
27. Facet display rules service (max 8 facets, context relevance, beta budget)
28. Interaction tracking middleware (impression/click events → ClickHouse)
29. Auto-promotion cron job (daily: query facet_interactions, promote/demote)
30. Auto-suggestion restriction service (max 5 suggestions, 1 beta max)

**Layer 5 — Admin Review UX (Studio):**

31. Review queue API (merge conflicts, taxonomy placement, type conflicts)
32. Attribute Manager UI (KG sub-tab: table + detail panel + actions)
33. SDK Preview widget (embeddable, beta toggle, slide-out in Studio)
34. Merge workflow UI (side-by-side comparison, alias resolution)
35. Bulk actions (approve all safe promotions, dismiss resolved conflicts)
