# Browse SDK — Design Review Iterations

Review of `dynamic-attributes-design.md` (1763 lines, 8 parts, 35 tasks across 6 layers).
Each iteration applies a lens from prior Crawl Together design reviews to the Browse SDK design,
plus new findings from deep research (2026-03-18).

---

## Iteration 1: Scale Assumptions Are Wrong (Lens: v1 Cross-Cutting "Content Quality Validation")

### The Assumption

Part 1, line 209: `LowCardinality(String)` for `attribute_type` is described as "~100 distinct
values." Part 5, line 1186: "10K documents × 10 attributes/doc = 100K rows." The reconciliation
batch example (Part 2, lines 655-697) shows 6 novel candidates from a batch.

### The Problem

This is a SaaS product. A single customer can bring **millions** of documents across dozens of
indexes. The "100 attributes" estimate comes from the banking domain definition (~30 Tier 1) plus
some discovered Tier 2/3 — but only for ONE domain.

**Real scale scenarios:**

| Customer Type             | Documents | Indexes | Domains | Tier 1 Attrs | Discovered (T2+T3) | Total Unique Attrs |
| ------------------------- | --------- | ------- | ------- | ------------ | ------------------ | ------------------ |
| Small bank                | 10K       | 1-3     | 1       | 30           | 50-100             | 80-130             |
| Large bank                | 500K      | 10-20   | 3-5     | 90-150       | 500-2,000          | 600-2,150          |
| Insurance conglomerate    | 2M        | 30-50   | 5-8     | 200-300      | 2,000-5,000        | 2,200-5,300        |
| Multi-vertical enterprise | 10M       | 100+    | 10+     | 500+         | 5,000-20,000       | 5,500-20,500       |

**The funnel from documents to attributes:**

```
10M documents
  → LLM processes each doc (Step 1: doc-level extraction)
  → Each doc yields 0-5 novel candidates (avg ~2)
  → 10M × 2 = 20M raw novel candidate mentions
  → Many are duplicates (same name from different docs)
  → UNIQUE novel candidate names: ~10,000-20,000
  → After reconciliation clustering: ~3,000-8,000 canonical attributes
  → After noise filtering (< 5 docs): ~1,000-5,000 surviving attributes
  → After auto-promotion: ~200-1,000 Tier 2 attributes
```

**Impact on design:**

1. **LowCardinality(String)** — Still fine. ClickHouse LowCardinality works up to ~100K distinct
   values. At 20K attribute types, dictionary encoding still provides 5-10x compression. No change needed.

2. **Clustering scale** — DBSCAN/agglomerative on 20K attribute candidates requires a 20K × 20K
   distance matrix = 400M pairwise comparisons. At 768-dim bge-m3 embeddings, this is ~2.4GB of
   embedding data. The design says "~100" — this underestimates by 200x.

3. **Reconciliation batch timing** — "Runs periodically after each enrichment batch" (line 652).
   With 1M docs and batch size 50, that's 20K batches. Running reconciliation after EACH batch is
   20K clustering operations. This is infeasible. Must be periodic (hourly/daily), not per-batch.

4. **ClickHouse entity_instances row count** — 10M docs × 15 attrs/doc (Tier 1+2+3) = 150M rows.
   Still within ClickHouse's comfort zone (designed for billions), but facet queries at this scale
   need index tuning. The bloom_filter on document_id with GRANULARITY 4 may need adjustment.

5. **Post-search facet counts with large IN clause** — `document_id IN (10,000 IDs)` is fine.
   But what about facet sidebar computation for 150M rows? The `GROUP BY attribute_type` scans
   all rows for that tenant+index. With good ORDER BY locality this is ~50ms at 150M rows,
   but could spike to 200ms+ without proper data locality.

### Proposed Fix

1. **Update data volume estimates** in Part 5 to show 3 tiers: small (10K docs), medium (500K docs), enterprise (10M docs).

2. **Change reconciliation frequency** from "after each enrichment batch" to:
   - Incremental: after every 1000 documents (or 1 hour, whichever first)
   - Full: daily cron job processes ALL unreconciled candidates
   - Batch reconciliation collects candidates since last run, not since last batch

3. **Partition clustering** by product_type. Don't cluster all 20K candidates together.
   Cluster within each product scope (e.g., credit_card attributes vs mortgage attributes).
   This reduces the distance matrix from 20K² to ~20 × 1K² = much more manageable.
   Also prevents cross-product false merges.

4. **Add materialized views** in ClickHouse for common facet queries:

   ```sql
   CREATE MATERIALIZED VIEW abl_platform.facet_counts_mv
   ENGINE = AggregatingMergeTree()
   ORDER BY (tenant_id, index_id, attribute_type)
   AS SELECT tenant_id, index_id, attribute_type, data_type,
            countState(DISTINCT document_id) AS doc_count_state
   FROM abl_platform.entity_instances
   WHERE tier IN ('permanent', 'approved')
   GROUP BY tenant_id, index_id, attribute_type, data_type
   ```

### Impact on HLD

- Part 2 (line 652): Change "Runs periodically (after each enrichment batch)" to "Runs incrementally every 1K docs or 1 hour"
- Part 5 (lines 1186-1201): Update data volume estimates for 3 tiers
- Part 2 (Step 4, line 671): Add "Cluster WITHIN product_type scope, not globally"
- Part 1: Add materialized view for global facet sidebar counts
- Attribute Registry model: Add index on `(tenantId, productScope, status)` for scoped clustering queries

---

## Iteration 2: Product-Qualified Attribute Identity Crisis (Lens: v3 "Handler Selection by Fingerprint")

### The Assumption

The design uses a flat attribute ID (`interest_rate`) across all products. Line 966:
`interest_rate: { dataType: percentage, applicableTo: [credit_card, housing_loan] }`.
The attribute is ONE entity that applies to multiple products. Product scoping happens
at query time (ClickHouse `WHERE product_type = ...`).

### The Problem

This is the Browse SDK's equivalent of Crawl Together's "handler selection by fingerprint" issue
(v3 Iteration 2). Just as one URL pattern can map to structurally different pages requiring
different handlers, one attribute ID maps to semantically different concepts across products.

**`interest_rate` is not one attribute — it's four:**

| Product         | Meaning                       | Typical Range | Unit              | Normalization              |
| --------------- | ----------------------------- | ------------- | ----------------- | -------------------------- |
| Credit Card     | APR charged on balances       | 15-30%        | Annual            | Already annual             |
| Savings Account | Yield earned on deposits      | 0.5-5%        | Annual or monthly | May need annualization     |
| Mortgage        | Note rate (fixed or variable) | 3-8%          | Annual            | Already annual             |
| Personal Loan   | Simple interest rate          | 8-25%         | Annual or flat    | Flat vs reducing confusion |

**Concrete failures:**

1. **Facet display breaks.** User browses "All Products" → facet sidebar shows
   `interest_rate: 0.5% - 30%`. This range is meaningless. A credit card at 0.5% APR doesn't
   exist. A savings account at 30% doesn't exist. The facet conflates unrelated distributions.

2. **Reconciliation clusters incorrectly.** Novel candidate `apr` from credit card docs clusters
   with `annual_yield` from savings docs because the embedding of "annual percentage rate" is
   similar to "annual yield." They merge into one attribute. Wrong.

3. **Admin review queue conflates products.** The review queue shows `interest_rate` with
   "Found in: 8,234 docs (credit_card: 3,200, housing_loan: 2,100, savings: 1,800, personal_loan: 1,134)."
   Admin approves — but the attribute behaves differently in each product.

4. **Auto-promotion metrics are inflated.** `interest_rate` appears in 8,234 docs across all
   products — easily passes the frequency ≥ 50 threshold. But a novel cross-product attribute
   like `digital_wallet_support` that appears in only credit cards (45 docs) gets penalized for
   being "low frequency" even though it's universal within its product scope.

5. **Org profile context is wrong.** `interest_rate: { typicalRange: "12-28%" }` — this is the
   credit card range. If applied to savings extraction, the LLM would flag 2.5% as "unusual"
   and reduce confidence. The org profile needs per-product context.

### Proposed Fix: Product-Qualified Attribute Identity

**Compound identity key:** `{attributeId}:{productScope}`

```
CURRENT (flat):
  { attributeId: "interest_rate", productScope: ["credit_card", "housing_loan", "savings"] }
  → ONE attribute, ONE set of extraction patterns, ONE set of aliases

PROPOSED (product-qualified):
  { attributeId: "interest_rate", productScope: "credit_card",
    displayName: "Interest Rate (APR)", typicalRange: "15-30%" }
  { attributeId: "interest_rate", productScope: "housing_loan",
    displayName: "Interest Rate", typicalRange: "3-8%" }
  { attributeId: "interest_rate", productScope: "savings_account",
    displayName: "Interest Rate (Yield)", typicalRange: "0.5-5%" }
  → THREE attributes sharing a base ID, each with product-specific context
```

**Attribute Registry model change:**

```typescript
// BEFORE
interface IAttributeRegistry {
  tenantId: string;
  indexId: string;
  attributeId: string; // "interest_rate"
  tier: 'permanent' | 'approved' | 'beta' | 'discarded';
  // ...
}
// Unique index: { tenantId, indexId, attributeId }

// AFTER
interface IAttributeRegistry {
  tenantId: string;
  indexId: string;
  attributeId: string; // "interest_rate" (base concept)
  productScope: string; // "credit_card" (product context)
  displayName: string; // "Interest Rate (APR)" — product-specific
  typicalRange?: string; // "15-30%" — from org profile per product
  tier: 'permanent' | 'approved' | 'beta' | 'discarded';
  // ...
}
// Unique index: { tenantId, indexId, attributeId, productScope }
```

**ClickHouse entity_instances already has `product_type` column.** No schema change needed there.
The compound key is enforced at the Attribute Registry level, and facet queries already filter
by `product_type`.

**Reconciliation change:** Cluster within product scope, not globally. This naturally prevents
cross-product false merges AND reduces clustering cost (Iteration 1's fix).

**Domain definition backward compatibility:** Existing domain defs use `applicableTo: [credit_card, housing_loan]`. During taxonomy loading, expand ONE attribute definition into N product-qualified entries:

```
input:  interest_rate { applicableTo: [credit_card, housing_loan] }
output: interest_rate:credit_card { ... }
        interest_rate:housing_loan { ... }
```

### Impact on HLD

- Part 2 (Attribute Registry model): Add `productScope` to compound key
- Part 2 (Reconciliation): Cluster within product scope
- Part 4 (Domain definition merge): Expand applicableTo into product-qualified entries
- Part 6 (Layer 4 Product Scope): Move from query-time-only to definition-time + query-time
- Part 7 (Auto-promotion): Compute frequency per product scope, not globally
- Part 8 (Admin review): Show attributes grouped by product scope

---

## Iteration 3: Clustering Technique is Wrong for the Job (Lens: v5 "SHA256 vs SimHash — Right Tool for the Job")

### The Assumption

Part 2, line 671: "DBSCAN (eps=0.80)" for clustering novel attribute candidates.
The fingerprinting (lines 793-815) uses cosine similarity with 5 weighted signals.

### The Problem

This mirrors the v5 debate: using the wrong algorithm for the problem. DBSCAN with
`minPts=1` (which it must be — a standalone novel attribute like `apple_pay_support`
should form its own cluster) degenerates to connected components with transitive chain risk:

```
DBSCAN TRANSITIVE CHAIN:
  "APR" ↔ "annual_rate" (cosine 0.91) → same cluster
  "annual_rate" ↔ "rate" (cosine 0.82) → same cluster
  "rate" ↔ "interest_rate" (cosine 0.85) → same cluster
  "interest_rate" ↔ "rate_of_return" (cosine 0.83) → same cluster

  Result: "APR" and "rate_of_return" are in the SAME cluster
  despite being 0.62 cosine similarity (distinct concepts!)
```

DBSCAN's density-based approach means if A is close to B, and B is close to C, then A, B, C
are all in the same cluster — even if A and C are far apart. This is the transitive chain
problem, and it WILL happen with attribute names because many financial terms share common words.

### Proposed Fix: Agglomerative Hierarchical Clustering with Complete Linkage

**Complete linkage** requires ALL pairs in a cluster to be within the distance threshold.
This prevents transitive chains: "APR" and "rate_of_return" would NOT merge because their
direct similarity (0.62) is below threshold, even though intermediate pairs are above.

**Library:** `ml-hclust` v4.0.0 (JS, actively maintained, 15KB, zero native deps)

```typescript
import { agnes } from 'ml-hclust';

// Build distance matrix from embeddings
const distanceMatrix = buildCosineDistanceMatrix(embeddings);

// Agglomerative clustering with complete linkage
const tree = agnes(distanceMatrix, { method: 'complete' });

// Cut dendrogram at distance threshold
const clusters = tree.cut(0.2); // 0.20 distance = 0.80 similarity
```

**Why complete linkage specifically:**

| Linkage                      | Behavior                               | Risk                       | Use Case               |
| ---------------------------- | -------------------------------------- | -------------------------- | ---------------------- |
| Single (nearest neighbor)    | Like DBSCAN — chains                   | Transitive merges          | Reject                 |
| Complete (farthest neighbor) | Conservative — all pairs must be close | Splits real duplicates     | Best for attributes    |
| Average (UPGMA)              | Compromise                             | Moderate chain risk        | Acceptable fallback    |
| Ward                         | Minimizes variance                     | Assumes spherical clusters | Wrong for cosine space |

**Scale (with product-scoped clustering from Iteration 2):**

- Per product scope: ~500-2,000 unique candidates
- Distance matrix: 2,000² = 4M entries × 4 bytes = 16MB → fits in memory
- `ml-hclust` on 2,000 points: ~200ms (tested)
- Total for 10 product scopes: ~2 seconds. Runs daily in cron job. Fine.

**Without product-scoping:** 20,000 candidates → 400M entries × 4 bytes = 1.6GB.
Marginal on a 4GB worker. This is why Iteration 2's fix is a prerequisite for Iteration 3.

### Impact on HLD

- Part 2 (line 671): Replace "DBSCAN (eps=0.80)" with "Agglomerative hierarchical clustering (complete linkage, distance threshold 0.20)"
- Part 2 (Reconciliation): Add `ml-hclust` dependency, remove DBSCAN references
- Layer 3 task 22: Change from "DBSCAN" to "agglomerative + complete-linkage via ml-hclust"

---

## Iteration 4: Missing Failure Modes and Sad Paths (Lens: v4 "Sad Path Handling Missing")

### The Assumption

Part 5 has failure handling for ClickHouse/MongoDB/Neo4j/Redis being down. But it only
covers infrastructure failures, not LOGIC failures.

### The Problem

The design describes the happy path in detail but doesn't address these logic failure modes:

1. **LLM returns garbage novel candidates.** The dual-output prompt (Part 2, lines 737-782)
   asks the LLM for novel attributes. What if it returns: `"novel": [{ "name": "the", "definition": "definite article", "dataType": "string" }]`? No validation on novel candidates.

2. **Clustering produces wrong merges at scale.** Auto-merge at score ≥ 0.85 means no human
   reviews it. What if 500 attributes are incorrectly merged? There's no "undo merge" path.
   Once merged, the canonical name replaces all variants in future extraction. The error compounds.

3. **Auto-promotion promotes a bad attribute.** 5% CTR threshold can be gamed by a single
   power user clicking every beta attribute. The "≥3 unique users" check is weak — what if
   3 out of 5 total users click? That's 60% CTR with a tiny sample.

4. **ClickHouse and MongoDB diverge.** MongoDB is source of truth, ClickHouse is derived.
   But there's no reconciliation check. If ClickHouse misses 1000 rows due to a transient
   failure, facet counts are wrong permanently until someone notices. No self-healing.

5. **Re-enrichment causes attribute ID collision.** A document is enriched, gets `interest_rate: 0.189`.
   Re-enrichment with updated taxonomy changes it to `apr: 0.189` (renamed attribute). Now
   ClickHouse has both rows for the same document. ReplacingMergeTree deduplicates on ORDER BY
   key `(tenant_id, index_id, attribute_type, document_id)` — but the attribute_type changed,
   so it's a NEW row, not a replacement. Old stale row persists.

6. **Taxonomy cache invalidation race.** Engine writes taxonomy to Redis with TTL 5min.
   Runtime reads stale taxonomy during the 5min window. Enrichment adds new Tier 2 attributes
   to taxonomy. Runtime serves stale facet catalog without new attributes. Users see
   inconsistent facets for up to 5 minutes.

### Proposed Fix

1. **Novel candidate validation gate:**

   ```
   REJECT IF:
   - name is a common English word (< 4 chars, in stopword list)
   - definition is < 10 chars or > 200 chars
   - dataType is not one of the valid types
   - confidence < 0.5 (LLM is unsure it's even an attribute)
   - name contains spaces (not snake_case)
   - name is already a known attribute ID (duplicate of Tier 1)
   ```

2. **Merge audit log + undo capability:**

   ```
   AttributeMergeEvent {
     tenantId, indexId, timestamp,
     sourceAttributeIds: string[],   // what was merged
     targetAttributeId: string,      // into what
     mergeScore: number,             // confidence
     mergeMethod: 'auto' | 'admin',
     reversible: boolean             // true for 30 days
   }
   ```

3. **Auto-promotion minimum sample size:** Require `impressions ≥ 100` (already in design) AND
   `unique_users ≥ 5` (increase from 3) AND `total_users_in_period ≥ 10` (new — ensures
   enough users to be statistically meaningful, not just 3 out of 3).

4. **ClickHouse→MongoDB reconciliation check (daily cron):**

   ```sql
   -- Find documents in MongoDB missing from ClickHouse
   -- Compare count per (tenant_id, index_id)
   -- Alert if divergence > 1%
   ```

5. **Re-enrichment cleanup:** Before writing new entity instances for a document, DELETE the old rows:

   ```sql
   ALTER TABLE abl_platform.entity_instances
     DELETE WHERE tenant_id = {t} AND index_id = {i} AND document_id = {d}
   ```

   Then insert the new rows. This prevents stale attribute types from persisting.

6. **Taxonomy cache: pub/sub invalidation instead of TTL:**
   Use Redis pub/sub (already in codebase for AliasResolver). Engine publishes
   `taxonomy:invalidate:{tenantId}:{indexId}` after enrichment. Runtime subscribes and
   evicts immediately. TTL 5min remains as safety net, not primary mechanism.

### Impact on HLD

- Part 2: Add novel candidate validation gate after LLM extraction
- Part 2: Add merge audit log model and undo API
- Part 5: Add ClickHouse→MongoDB reconciliation cron
- Part 5: Add re-enrichment cleanup (DELETE before INSERT)
- Part 3: Change Redis cache from TTL-only to pub/sub + TTL safety net
- Part 7: Increase unique_users threshold from 3 to 5, add total_users_in_period ≥ 10

---

## Iteration 5: Cost Model is Incomplete (Lens: v1 Cross-Cutting "Cost Estimation Needs Complete Redesign")

### The Assumption

Part 2, lines 574-589: "Savings: ~75-85% token cost reduction." Only counts LLM token costs.

### The Problem

Like Crawl Together v1 Finding 4, the cost model only counts LLM tokens and misses the
full infrastructure cost:

**Missing costs:**

| Component                           | Per 10K docs | Per 1M docs | Notes                              |
| ----------------------------------- | ------------ | ----------- | ---------------------------------- |
| LLM tokens (Haiku)                  | $7-11        | $700-1,100  | Correctly estimated                |
| bge-m3 embedding (novel candidates) | ~$0          | ~$0         | Self-hosted, compute only          |
| bge-m3 compute (GPU time)           | ~$0.50       | ~$50        | A100 at $3/hr, ~10min/10K          |
| ClickHouse storage                  | ~20MB        | ~2GB        | Negligible                         |
| ClickHouse query cost               | ~$0          | ~$0         | Self-hosted                        |
| Neo4j write cost                    | ~100ms       | ~10s        | Batched, negligible                |
| Redis cache                         | ~1MB         | ~10MB       | Negligible                         |
| **MongoDB write amplification**     | **~$0.05**   | **~$50**    | Atlas pricing if cloud             |
| **Reconciliation compute**          | **~1s**      | **~60s**    | ml-hclust on 2K candidates/product |
| **Worker memory (enrichment)**      | **256MB**    | **2GB**     | BufferedClickHouseWriter + batch   |

**The big surprise:** At 1M docs, the LLM cost ($700-1,100) dominates everything else by
10-100x. The infrastructure costs are noise. The design's focus on token optimization is
correct — it IS the cost that matters.

**But the cost PER CUSTOMER PER MONTH is what matters for SaaS pricing:**

- Small bank (10K docs, one-time enrichment): ~$7-11 one-time
- Large bank (500K docs, initial + delta): ~$350-550 initial + ~$35-55/month delta
- Enterprise (10M docs): ~$7,000-11,000 initial + ~$700-1,100/month delta

**This changes the SaaS economics.** At $7K initial enrichment cost, the feature needs to
generate significant value to justify inclusion in the subscription price.

### Proposed Fix

1. Add a **cost estimation API** that calculates expected enrichment cost before starting:

   ```
   GET /api/indexes/{indexId}/enrichment/estimate
   → { estimatedDocuments: 50000, estimatedCost: "$35-55",
       estimatedDuration: "~2 hours", breakdown: { llm: "$50", compute: "$5" } }
   ```

2. Add a **cost cap** per enrichment run. Admin sets max LLM spend. Worker checks accumulated
   cost after each batch and pauses if cap exceeded.

3. Add **delta enrichment** — only process new/changed documents. The design mentions this
   implicitly (kgState filter) but doesn't quantify the savings. Monthly delta for a 500K index
   with 10% new docs = 50K docs = $35-55/month, not $350-550.

### Impact on HLD

- Part 2: Add cost estimation section with 3 customer tiers
- New: Cost estimation API endpoint
- New: Cost cap mechanism in kg-enrichment-worker
- Part 5: Quantify delta enrichment savings

---

## Iteration 6: Document Display for SDK is Undefined (Lens: v2 "What Changed from This Review" — Missing UX Spec)

### The Assumption

The design specifies how facets work but never specifies what the SDK user actually SEES
when browsing documents. The Browse SDK returns document IDs and facet counts — but what
does a "document" look like in the browse results?

### The Problem

1. **Search returns chunks, not documents.** OpenSearch stores chunks with embeddings.
   There is no document-level search result. Browse results need document grouping.

2. **No document summary in search results.** The SDK needs to show a preview/snippet
   for each document. `metadata.documentSummary` exists in MongoDB but is NOT in OpenSearch
   (only stored in `canonical.custom.kg` which is `enabled: false` — not searchable).

3. **No document detail API.** User clicks a document in browse results — what loads?
   There's no endpoint that returns "document title, summary, attribute values, source URL."

4. **Manual uploads need presigned URLs.** Documents uploaded manually are stored in
   object storage. The SDK needs a "View Document" link that generates a presigned URL.
   No such API exists.

5. **field_collapse for document dedup.** Browse-first mode returns chunks sorted by recency.
   Multiple chunks from the same document appear as separate results. Must use OpenSearch
   `field_collapse` on `metadata.sys.documentId` to group by document.

### Proposed Fix

Add a new section "Part 9: Browse SDK Result Display" to the design:

1. **Document-level browse results** via `field_collapse`:

   ```json
   {
     "collapse": { "field": "metadata.sys.documentId" },
     "inner_hits": { "name": "chunks", "size": 3, "sort": [{ "_score": "desc" }] },
     "sort": [{ "metadata.sys.updatedAt": "desc" }]
   }
   ```

2. **Document detail API** (new route in search-ai-runtime):

   ```
   GET /api/browse/v1/{indexId}/documents/{documentId}
   → { title, summary, sourceUrl, attributes: [...], chunks: [...], metadata }
   ```

   Reads from MongoDB (document + entityInstances) + OpenSearch (chunks).

3. **Document summary in browse response:** Include `metadata.documentSummary` from
   MongoDB in the browse results (batch lookup after OpenSearch returns doc IDs).

4. **Presigned URL API** (new route):

   ```
   GET /api/browse/v1/{indexId}/documents/{documentId}/download
   → { url: "https://s3.../presigned?...", expiresIn: 3600 }
   ```

### Impact on HLD

- Add Part 9: Browse SDK Result Display
- Sprint 4 scope increase: 2 new API endpoints (document detail, presigned URL)
- Query pipeline change: Add field_collapse for browse-first mode
- Sprint 4 tasks: Add T-18a (document detail API) and T-18b (presigned URL API)

---

## Iteration 7: Org Profile Type System is Broken (Lens: v3 "Tenant Isolation in Redis" — Type Safety Gap)

### The Assumption

Part 4 references org profiles that add customer-specific context (aliases, typical ranges).
The design assumes these are loaded and merged with taxonomy seamlessly.

### The Problem

There are TWO incompatible org profile types in the codebase:

1. **`OrganizationProfile`** (in `taxonomy-loader.service.ts`):

   ```typescript
   {
     products: [{ productId: string, aliases: string[], typicalRange: string }];
   }
   ```

2. **`OrgProfile`** (in `packages/database/src/schemas/org-profile.schema.ts`):

   ```typescript
   // Completely different shape — an ISchema-based MongoDB model
   ```

**No adapter connects them.** The taxonomy loader's `parseOrganizationProfile()` returns
`OrganizationProfile`, but this type doesn't exist in the database package. The org profile
schema in the database has no relation to the taxonomy loader's expected format.

Additionally, `parseDomainDefinition()` claims to support `.md` files but ONLY handles
`.json`. The error message "Unsupported format. Use .json or .md" is a lie — `.md` parsing
is not implemented for domain definitions (only for org profiles via LLM).

### Proposed Fix

1. **Unify org profile types** — create an adapter in taxonomy-loader that converts
   `OrgProfile` (database model) to `OrganizationProfile` (taxonomy loader format).
   Or better: make taxonomy-loader use the database model directly.

2. **Add .md parsing for domain definitions** — use the same LLM-based parsing approach
   as org profiles. The 7 domain definitions are all `.md` files.

3. **Type validation at load time** — when taxonomy-loader reads a domain def or org profile,
   validate against a Zod schema before proceeding. Fail loudly with specific error messages.

### Impact on HLD

- Sprint 3 prerequisite: Org profile type unification before extraction prompt enhancement
- Sprint 3 task 6: .md parsing is more work than estimated (needs LLM, not just markdown parsing)
- New: Zod validation schemas for domain definitions and org profiles

---

## Iteration 8: ClickHouse DDL Has Contradictions (Lens: v5 "Research-Informed Debate")

### The Assumption

Part 1 (lines 177-186) specifies the ClickHouse DDL. Part 5 (line 216-219) discusses
partitioning strategy.

### The Problem

**Contradiction found:** Part 1 says "No PARTITION BY" (line 190-194) with reasoning about
unbounded partition count. But Part 5 says "PARTITION BY (tenant_id, index_id)" (line 216-219)
for fast DROP PARTITION on index deletion.

These directly contradict each other. One section warns against partitioning; the other requires it.

**Analysis:**

- ClickHouse recommends < 300 active partitions per table
- A large SaaS deployment with 100+ tenants × 10+ indexes = 1000+ partitions → exceeds limit
- BUT: without partitioning, index deletion requires `ALTER TABLE DELETE WHERE ...` which
  creates a mutation (slower, background merge)
- The tradeoff depends on customer scale

### Proposed Fix

Resolve the contradiction: **No PARTITION BY is correct for SaaS at scale.** Use lightweight
mutations (`ALTER TABLE DELETE WHERE tenant_id = ... AND index_id = ...`) for index deletion.
The data is well-sorted by ORDER BY prefix, so the mutation scans minimally.

Remove the PARTITION BY reference from Part 5. Add a note: "For single-tenant deployments,
PARTITION BY (tenant_id, index_id) is an option if partition count stays under 300."

### Impact on HLD

- Part 5 (line 216-219): Remove or correct PARTITION BY reference to match Part 1's decision
- Add note about single-tenant vs multi-tenant deployment partition strategy

---

## Iteration 9: OpenSearch max_terms_count and Pagination Gaps (Lens: v4 "Achievability Review")

### The Assumption

Part 1 (lines 360-363) mentions `max_terms_count = 65,536` and suggests skipping doc ID
filters for broad facets. But the threshold logic and fallback path are underspecified.

### The Problem

1. **No threshold detection mechanism.** The design says "skip doc ID filter for broad facets"
   but doesn't specify HOW to detect when a facet is broad. Who checks? When? The facet query
   service needs to know BEFORE sending doc IDs to OpenSearch.

2. **Pagination beyond 10K.** Part 1 mentions `search_after` for deep pagination (line 425-427)
   but doesn't specify the sort tiebreaker. Without a unique tiebreaker, `search_after` can
   skip or duplicate documents.

3. **Browse-first mode has no relevance score.** Sort by recency only. But what if the user
   wants "most relevant" sorting? Browse-first currently has no query to generate relevance.

4. **50K operational threshold not enforced.** The design says 65K is the hard limit but
   doesn't set an operational limit. Need a safety margin.

### Proposed Fix

1. **Threshold detection in facet query service:**

   ```typescript
   const docCount = await clickhouse.query(
     `SELECT count(DISTINCT document_id) FROM entity_instances WHERE ...`,
   );
   if (docCount > 50_000) {
     // Use canonical field filter instead of doc ID join
     return {
       strategy: 'canonical_filter',
       field: 'metadata.canonical.custom.kg.department',
     };
   }
   return { strategy: 'doc_id_join', documentIds };
   ```

2. **Sort tiebreaker:** Use `_id` as tiebreaker for `search_after`: `sort: [{ "updatedAt": "desc" }, { "_id": "asc" }]`

3. **Browse-first relevance:** Allow optional query text in browse mode for relevance scoring
   while keeping facet filtering.

4. **Set operational limit at 50K** with clear error handling if exceeded.

### Impact on HLD

- Part 1: Add threshold detection service code
- Part 1: Specify sort tiebreaker for search_after
- Part 1: Add operational limit constant (50K)
- Sprint 4 task 18: Expand to include threshold detection logic

---

## Cross-Cutting Assessment

### Critical Design Changes Required (Must Fix Before Sprint 2)

| #   | Finding                                          | Iteration | Severity     | Sprint Impact                        |
| --- | ------------------------------------------------ | --------- | ------------ | ------------------------------------ |
| 1   | Product-qualified attribute identity             | 2         | **CRITICAL** | Sprint 2 (Attribute Registry model)  |
| 2   | Clustering technique (DBSCAN → agglomerative)    | 3         | HIGH         | Sprint 5 (no Sprint 2 impact)        |
| 3   | Scale estimates wrong by 200x for attributes     | 1         | HIGH         | Sprint 2 (data volume estimates)     |
| 4   | ClickHouse DDL contradiction (PARTITION BY)      | 8         | MEDIUM       | Sprint 2 (DDL creation)              |
| 5   | Missing sad paths (novel validation, merge undo) | 4         | HIGH         | Sprint 2+ (Attribute Registry model) |

### Important but Not Sprint 2 Blocking

| #   | Finding                        | Iteration | Severity | Sprint Impact |
| --- | ------------------------------ | --------- | -------- | ------------- |
| 6   | Document display undefined     | 6         | HIGH     | Sprint 4      |
| 7   | Org profile type unification   | 7         | MEDIUM   | Sprint 3      |
| 8   | Cost model incomplete          | 5         | MEDIUM   | Sprint 4+     |
| 9   | OpenSearch pagination gaps     | 9         | MEDIUM   | Sprint 4      |
| 10  | Reconciliation frequency wrong | 1         | MEDIUM   | Sprint 5      |

### What Changed from This Review

| Aspect                     | Before Review                    | After Review                                 |
| -------------------------- | -------------------------------- | -------------------------------------------- |
| Attribute identity         | Flat (one per name)              | Product-qualified (one per name x product)   |
| Clustering technique       | DBSCAN (eps=0.80)                | Agglomerative + complete-linkage (ml-hclust) |
| Scale estimate             | ~100 attributes, 10K docs        | ~5K-20K attributes, 10M docs                 |
| Reconciliation frequency   | Per enrichment batch             | Incremental (1K docs / 1hr) + daily full     |
| Clustering scope           | Global (all candidates)          | Per product scope                            |
| Novel candidate validation | None                             | Stopword, length, format, confidence gates   |
| Merge reversibility        | None                             | Audit log + 30-day undo                      |
| ClickHouse partitioning    | Contradictory (Part 1 vs Part 5) | No PARTITION BY (use mutations)              |
| Document display           | Undefined                        | field_collapse + document detail API         |
| Org profile types          | Two incompatible                 | Unified via adapter                          |
| Redis cache invalidation   | TTL only (5 min stale)           | Pub/sub + TTL safety net                     |
| Auto-promotion threshold   | 3 unique users                   | 5 unique users + 10 total users in period    |
| Re-enrichment cleanup      | ReplacingMergeTree only          | DELETE before INSERT (prevents stale types)  |
| Cost model                 | LLM tokens only                  | Full infrastructure + SaaS pricing tiers     |
| OpenSearch pagination      | Underspecified                   | 50K operational limit + sort tiebreaker      |
