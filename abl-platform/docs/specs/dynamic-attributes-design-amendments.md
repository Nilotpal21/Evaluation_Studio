# Dynamic Attributes Design — Amendments (Post-Review v1)

**Date:** 2026-03-18
**Source:** `browse-sdk-design-review-iterations.md` (9 iterations)
**Status:** PROPOSED — awaiting approval before Sprint 2 implementation

These amendments modify `dynamic-attributes-design.md` based on 9 review iterations
that applied patterns from Crawl Together v1-v5 reviews plus deep research findings.

---

## Amendment 1: Product-Qualified Attribute Identity (CRITICAL)

**Affects:** Part 2, Part 4, Part 6, Part 7, Part 8
**Severity:** CRITICAL — must be in Sprint 2 Attribute Registry model

### Change

Attribute identity changes from flat `{attributeId}` to compound `{attributeId, productScope}`.

**Before:**

```typescript
interface IAttributeRegistry {
  tenantId: string;
  indexId: string;
  attributeId: string; // "interest_rate" — ONE attribute across all products
  tier: 'permanent' | 'approved' | 'beta' | 'discarded';
  displayName: string;
  dataType: string;
  aliases: string[];
  extractionPatterns: string[];
  // ...
}
// Unique index: { tenantId, indexId, attributeId }
```

**After:**

```typescript
interface IAttributeRegistry {
  tenantId: string;
  indexId: string;
  attributeId: string; // "interest_rate" — base concept
  productScope: string; // "credit_card" — scoping context
  tier: 'permanent' | 'approved' | 'beta' | 'discarded';
  displayName: string; // "Interest Rate (APR)" — product-specific display
  dataType: string;
  aliases: string[];
  extractionPatterns: string[];
  typicalRange?: string; // "15-30%" — from org profile, per product
  // ...
}
// Unique index: { tenantId, indexId, attributeId, productScope }
```

**Rationale:** `interest_rate` means APR (15-30%) for credit cards but yield (0.5-5%) for
savings accounts. Flat identity produces meaningless facet ranges, incorrect clustering
(merges cross-product attributes), and inflated auto-promotion metrics. See Review Iteration 2.

**Domain definition backward compatibility:** `applicableTo: [credit_card, housing_loan]`
expands to N product-qualified entries during taxonomy loading.

**ClickHouse impact:** None — `product_type` column already exists in `entity_instances`.

---

## Amendment 2: Clustering Technique Change

**Affects:** Part 2 (Layer 3 Reconciliation)
**Severity:** HIGH — Sprint 5 implementation

### Change

Replace DBSCAN with agglomerative hierarchical clustering using complete linkage.

**Before:** "Step 4: CLUSTER remaining with DBSCAN (eps=0.80)"

**After:** "Step 4: CLUSTER remaining with agglomerative hierarchical clustering
(complete linkage, distance threshold 0.20 = 0.80 cosine similarity)"

**Library:** `ml-hclust` v4.0.0 (JS, 15KB, zero native deps)

**Rationale:** DBSCAN with minPts=1 degenerates to connected components, allowing
transitive chain merges: `APR → annual_rate → rate → interest_rate → rate_of_return`
all merge into one cluster despite `APR` and `rate_of_return` being semantically distinct.
Complete linkage prevents this by requiring ALL pairs in a cluster to be within threshold.
See Review Iteration 3.

**Prerequisite:** Amendment 1 (product-qualified identity) enables clustering within
product scope, reducing distance matrix from 20K² to ~20 × 1K² (manageable).

---

## Amendment 3: Scale Estimates Updated

**Affects:** Part 1 (line 209), Part 5 (lines 1186-1201)
**Severity:** HIGH — affects Sprint 2 data volume planning

### Change

Replace single-scale estimates with 3-tier SaaS scale model.

**Before:**

```
Per index:
  10K documents × 10 attributes/doc = 100K rows
  Each row: ~200 bytes → Total: ~20MB per index
```

**After:**

```
SCALE TIER 1 — Small Customer (single domain, 1-3 indexes):
  10K documents × 10 attributes/doc = 100K rows
  ~100 unique attribute types (30 Tier 1 + 70 discovered)
  ~20MB per index in ClickHouse
  Reconciliation: <1s, runs incrementally

SCALE TIER 2 — Large Customer (3-5 domains, 10-20 indexes):
  500K documents × 15 attributes/doc = 7.5M rows
  ~2,000 unique attribute types across all product scopes
  ~1.5GB total in ClickHouse
  Reconciliation: ~5s per product scope, runs hourly

SCALE TIER 3 — Enterprise (10+ domains, 100+ indexes):
  10M documents × 15 attributes/doc = 150M rows
  ~20,000 unique attribute types across all product scopes
  ~30GB total in ClickHouse (still within single-node capacity)
  Reconciliation: ~30s per product scope, runs daily
  Facet queries: ~50ms (may need materialized views for global sidebar)
```

**Also update:** LowCardinality note from "~100 distinct values" to "typically 100-20,000
distinct values per index; LowCardinality effective up to ~100K."

---

## Amendment 4: Reconciliation Frequency Change

**Affects:** Part 2 (line 652), Part 5 (write path)
**Severity:** MEDIUM — Sprint 5 implementation

### Change

**Before:** "Runs periodically (after each enrichment batch)"

**After:**

```
INCREMENTAL RECONCILIATION:
  Trigger: every 1,000 documents enriched OR 1 hour (whichever first)
  Scope: novel candidates since last reconciliation run
  Cost: ~1-5s per product scope

FULL RECONCILIATION:
  Trigger: daily cron job (configurable)
  Scope: ALL unreconciled candidates + re-check existing clusters
  Cost: ~30s per product scope at enterprise scale

BATCH ENRICHMENT DOES NOT TRIGGER RECONCILIATION.
  (20K batches × clustering = infeasible)
```

---

## Amendment 5: ClickHouse DDL Contradiction Resolved

**Affects:** Part 1 (lines 190-194), Part 5 (lines 216-219)
**Severity:** MEDIUM — Sprint 2 DDL creation

### Change

Part 1 says "No PARTITION BY" (correct for SaaS). Part 5 says "PARTITION BY (tenant_id,
index_id)" (contradicts Part 1).

**Resolution:** No PARTITION BY. Use lightweight mutations for index deletion:

```sql
ALTER TABLE abl_platform.entity_instances
  DELETE WHERE tenant_id = {t:String} AND index_id = {i:String}
```

The ORDER BY prefix gives data locality, making mutations efficient.

**Note for single-tenant deployments:** PARTITION BY (tenant_id, index_id) is acceptable
if total partitions stay under 300.

---

## Amendment 6: Novel Candidate Validation Gate

**Affects:** Part 2 (after LLM extraction, before storage)
**Severity:** HIGH — Sprint 2 implementation (part of enrichment write path)

### Change

Add validation before storing Tier 3 novel candidates:

```typescript
function validateNovelCandidate(candidate: NovelCandidate): boolean {
  // Reject common English words
  if (STOPWORDS.has(candidate.name) || candidate.name.length < 4) return false;
  // Reject missing/short definitions
  if (!candidate.definition || candidate.definition.length < 10) return false;
  // Reject invalid snake_case
  if (!/^[a-z][a-z0-9_]*$/.test(candidate.name)) return false;
  // Reject low confidence
  if (candidate.confidence < 0.5) return false;
  // Reject if already a known attribute
  if (knownAttributeIds.has(candidate.name)) return false;
  // Reject invalid data types
  if (!VALID_DATA_TYPES.has(candidate.dataType)) return false;
  return true;
}
```

---

## Amendment 7: Merge Audit Log and Undo

**Affects:** Part 2 (Reconciliation), Part 8 (Admin Review)
**Severity:** MEDIUM — Sprint 5 implementation

### Change

Add merge audit trail:

```typescript
interface IAttributeMergeEvent {
  tenantId: string;
  indexId: string;
  timestamp: Date;
  sourceAttributeIds: string[]; // what was merged
  targetAttributeId: string; // canonical winner
  mergeScore: number;
  mergeMethod: 'auto' | 'admin';
  reversible: boolean; // true for 30 days
  reversedAt?: Date;
}
```

Admin can undo auto-merges within 30 days. After 30 days, source attribute data is
compacted and undo is no longer possible.

---

## Amendment 8: Re-Enrichment Cleanup

**Affects:** Part 5 (write path during enrichment)
**Severity:** MEDIUM — Sprint 2 implementation

### Change

Before writing new entity instances for a re-enriched document, DELETE the old rows:

```sql
ALTER TABLE abl_platform.entity_instances
  DELETE WHERE tenant_id = {t} AND index_id = {i} AND document_id = {d}
```

**Rationale:** ReplacingMergeTree deduplicates on ORDER BY key
`(tenant_id, index_id, attribute_type, document_id)`. If re-enrichment changes the
`attribute_type` (e.g., taxonomy update renames an attribute), the old row has a different
ORDER BY key and persists as a stale ghost. Explicit DELETE before INSERT prevents this.

---

## Amendment 9: Redis Cache Pub/Sub Invalidation

**Affects:** Part 3 (Redis cache strategy)
**Severity:** MEDIUM — Sprint 3 implementation

### Change

**Before:** TTL 5min only.

**After:** Redis pub/sub for immediate invalidation + TTL 5min as safety net.

```
Engine (search-ai) after enrichment:
  redis.publish('taxonomy:invalidate', JSON.stringify({ tenantId, indexId }))

Runtime (search-ai-runtime) on startup:
  redis.subscribe('taxonomy:invalidate', (msg) => {
    const { tenantId, indexId } = JSON.parse(msg);
    taxonomyCache.delete(`taxonomy:${tenantId}:${indexId}`);
  })
```

Pattern matches existing AliasResolver pub/sub in the codebase.

---

## Amendment 10: Document Display for SDK (New Part 9)

**Affects:** New section in design doc
**Severity:** HIGH — Sprint 4 implementation

### Change

Add Part 9: Browse SDK Result Display.

**Key additions:**

1. Use `field_collapse` on `metadata.sys.documentId` for document-level browse results
2. New document detail API: `GET /api/browse/v1/{indexId}/documents/{documentId}`
3. New presigned URL API: `GET /api/browse/v1/{indexId}/documents/{documentId}/download`
4. Document summary sourced from MongoDB `metadata.documentSummary` (batch lookup)

**Browse result shape:**

```typescript
interface BrowseResult {
  documentId: string;
  title: string;
  summary: string; // from MongoDB metadata.documentSummary
  sourceUrl?: string;
  attributes: Array<{ name: string; value: string | number; type: string }>;
  chunkCount: number; // from inner_hits count
  productType: string;
  department: string;
  updatedAt: string;
}
```

---

## Amendment 11: Auto-Promotion Threshold Increase

**Affects:** Part 7 (auto-promotion query)
**Severity:** LOW — Sprint 6 implementation

### Change

**Before:** `unique_users >= 3`

**After:** `unique_users >= 5 AND total_users_in_period >= 10`

Rationale: 3 out of 3 users clicking = 100% CTR but statistically meaningless.
Requiring 10+ total users in the period ensures a meaningful sample size.

---

## Summary of Amendments by Sprint

| Sprint       | Amendments Required                                                                                                    |
| ------------ | ---------------------------------------------------------------------------------------------------------------------- |
| **Sprint 2** | #1 (product-qualified identity), #3 (scale estimates), #5 (DDL fix), #6 (novel validation), #8 (re-enrichment cleanup) |
| Sprint 3     | #7 (org profile unification — from Review Iteration 7), #9 (pub/sub cache)                                             |
| Sprint 4     | #10 (document display), OpenSearch pagination fixes                                                                    |
| Sprint 5     | #2 (clustering technique), #4 (reconciliation frequency), #7 (merge audit)                                             |
| Sprint 6     | #11 (auto-promotion threshold)                                                                                         |
