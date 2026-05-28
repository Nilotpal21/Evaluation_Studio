# Open Questions Discussion: Knowledge Graph Design

> **Document Purpose**: Detailed discussion of 5 open design questions requiring decisions
> **Status**: Awaiting decisions before Phase 1 implementation
> **Last Updated**: 2026-02-24
> **Related Documents**: DESIGN-DISCUSSION-updated.md, DESIGN-domain-aware-knowledge-graph.md

This document provides in-depth analysis, options, tradeoffs, and recommendations for each open design question.

---

## Question 1: Neo4j Schema Optimization (Indexes & Constraints)

### Background

We're creating Neo4j nodes for:

- Taxonomy structure (Domain → Category → Department → Product → Attribute)
- Document/chunk linkages to taxonomy
- Cross-product relationships (EXCLUDES, APPLIES_TO, NOT_APPLICABLE_TO)

**Performance Requirements**:

- Query-time taxonomy traversal (fast lookups during query disambiguation)
- Document retrieval filtered by product scope
- Relationship validation during entity extraction

### Options & Analysis

#### Option 1A: Minimal Indexing (Fast Write, Slow Query)

**Indexes**:

- Primary key only: `Product.id` (unique)
- No secondary indexes

**Constraints**:

- `UNIQUE` on Product.id, Attribute.id, Domain.id

**Pros**:

- Fast writes during taxonomy setup (minimal index maintenance)
- Simple schema

**Cons**:

- Slow query-time lookups (full node scans)
- Poor performance for `MATCH (p:Product {name: "credit_card"})` queries (no index on `name`)
- Relationship traversal not optimized

**Performance Estimate**:

- Taxonomy setup: ~500ms for 1,000 nodes
- Query-time lookup: ~50-100ms per query (full scan)

**Verdict**: ❌ **Not acceptable** — Query-time performance is critical for user-facing search

---

#### Option 1B: Standard Indexing (Balanced)

**Indexes**:

- `Product.id` (unique) — Primary key
- `Product.name` (index) — Lookup by product name ("credit_card", "debit_card")
- `Attribute.id` (unique) — Primary key
- `Attribute.name` (index) — Lookup by attribute name ("interest_rate", "annual_fee")
- `Domain.id` (unique) — Primary key
- `Category.id` (unique) — Primary key
- `Department.id` (unique) — Primary key

**Constraints**:

- `UNIQUE` on all `.id` fields
- `EXISTS` on `Product.name`, `Attribute.name` (require these fields)

**Cypher**:

```cypher
// Create unique constraints (auto-creates index)
CREATE CONSTRAINT product_id_unique FOR (p:Product) REQUIRE p.id IS UNIQUE;
CREATE CONSTRAINT attribute_id_unique FOR (a:Attribute) REQUIRE a.id IS UNIQUE;
CREATE CONSTRAINT domain_id_unique FOR (d:Domain) REQUIRE d.id IS UNIQUE;
CREATE CONSTRAINT category_id_unique FOR (c:Category) REQUIRE c.id IS UNIQUE;
CREATE CONSTRAINT department_id_unique FOR (dept:Department) REQUIRE dept.id IS UNIQUE;

// Create indexes on name fields for fast lookup
CREATE INDEX product_name_index FOR (p:Product) ON (p.name);
CREATE INDEX attribute_name_index FOR (a:Attribute) ON (a.name);

// Create existence constraints (require field presence)
CREATE CONSTRAINT product_name_exists FOR (p:Product) REQUIRE p.name IS NOT NULL;
CREATE CONSTRAINT attribute_name_exists FOR (a:Attribute) REQUIRE a.name IS NOT NULL;
```

**Pros**:

- Fast query-time lookups by product name or attribute name
- Balanced write/read performance
- Standard approach used in production Neo4j systems

**Cons**:

- Slightly slower writes during taxonomy setup (index maintenance)
- More complex schema than minimal indexing

**Performance Estimate**:

- Taxonomy setup: ~1-2 seconds for 1,000 nodes (acceptable one-time cost)
- Query-time lookup: ~5-10ms per query (index seek)

**Verdict**: ✅ **RECOMMENDED** — Good balance, standard practice

---

#### Option 1C: Comprehensive Indexing (Fast Query, Slow Write)

**Indexes**:

- All fields from Option 1B PLUS:
- `Product.applicableTo` (multi-value index) — Fast filtering on attribute applicability
- `Product.disambiguationKeywords` (full-text search index) — Keyword matching
- Composite indexes: `(Product.name, Product.department)` — Multi-field queries

**Cypher**:

```cypher
// All from Option 1B PLUS:

// Full-text search index for keyword matching
CREATE FULLTEXT INDEX product_keywords_fulltext FOR (p:Product) ON EACH [p.disambiguationKeywords];

// Composite index for multi-field queries
CREATE INDEX product_name_department_composite FOR (p:Product) ON (p.name, p.department);
```

**Pros**:

- Extremely fast query-time performance (sub-5ms)
- Supports advanced queries (full-text search, composite filters)

**Cons**:

- Slower writes during taxonomy setup (significant index maintenance overhead)
- Increased storage (indexes consume disk space)
- Over-engineering for initial use case

**Performance Estimate**:

- Taxonomy setup: ~3-5 seconds for 1,000 nodes (3-5x slower than Option 1B)
- Query-time lookup: ~2-5ms per query (marginal improvement over Option 1B)

**Verdict**: ❌ **Not recommended for MVP** — Premature optimization, complexity not justified

---

### Recommended Approach: **Option 1B (Standard Indexing)**

**Reasoning**:

1. Query-time performance is critical (user-facing search)
2. One-time taxonomy setup cost is acceptable (1-2 seconds is negligible)
3. Standard indexes (`id` unique, `name` index) are production-proven
4. Allows fast lookups by product name and attribute name (common query pattern)
5. Constraints enforce data integrity (required fields, unique IDs)

**Implementation**:

```cypher
// 1. Create unique constraints (auto-creates index)
CREATE CONSTRAINT product_id_unique FOR (p:Product) REQUIRE p.id IS UNIQUE;
CREATE CONSTRAINT attribute_id_unique FOR (a:Attribute) REQUIRE a.id IS UNIQUE;
CREATE CONSTRAINT domain_id_unique FOR (d:Domain) REQUIRE d.id IS UNIQUE;
CREATE CONSTRAINT category_id_unique FOR (c:Category) REQUIRE c.id IS UNIQUE;
CREATE CONSTRAINT department_id_unique FOR (dept:Department) REQUIRE dept.id IS UNIQUE;

// 2. Create indexes on name fields
CREATE INDEX product_name_index FOR (p:Product) ON (p.name);
CREATE INDEX attribute_name_index FOR (a:Attribute) ON (a.name);

// 3. Create existence constraints
CREATE CONSTRAINT product_name_exists FOR (p:Product) REQUIRE p.name IS NOT NULL;
CREATE CONSTRAINT attribute_name_exists FOR (a:Attribute) REQUIRE a.name IS NOT NULL;
```

**Future Optimization** (if needed):

- Add full-text search index if keyword matching becomes bottleneck
- Add composite indexes if multi-field queries are common
- Monitor query performance and add indexes based on actual usage patterns

---

## Question 2: LLM Model Selection (Haiku vs Sonnet for Classification)

### Background

We need LLM calls for:

1. **Taxonomy parsing** (one-time): Parse domain definitions + organization profile → structured taxonomy
2. **Chunk classification** (per document): Classify each chunk by product scope during ingestion

**Volume Estimate** (per index):

- Taxonomy parsing: 1 call per index setup (50K tokens)
- Chunk classification: 1,000 chunks per index ingestion (500 tokens per chunk)

### Options & Analysis

#### Option 2A: Haiku for Everything (Cheap, Fast, Less Accurate)

**Model**: Claude 3.5 Haiku
**Pricing** (2026 pricing):

- Input: $0.25 per million tokens
- Output: $1.25 per million tokens

**Accuracy Characteristics**:

- Good at simple classification tasks (binary decisions, category selection)
- Less reliable for complex reasoning (nuanced disambiguation, multi-scope documents)
- Faster response time (~500ms per call)

**Cost Analysis** (1,000 docs):
| Task | Tokens | Calls | Cost |
|------|--------|-------|------|
| Taxonomy parsing (one-time) | 50K input, 10K output | 1 | $0.025 |
| Chunk classification (1,000 chunks) | 500 input, 100 output per chunk | 1,000 | $0.25 |
| **Total per 1,000 docs** | — | 1,001 | **$0.275** |

**Pros**:

- Extremely low cost ($0.275 per 1,000 docs)
- Fast response time (500ms per call)
- Sufficient for simple product scope classification ("credit_card" vs "debit_card")

**Cons**:

- Lower accuracy on ambiguous documents (multi-scope, cross-product mentions)
- May struggle with nuanced disambiguation (e.g., "distribution" as electrical vs logistics)
- Higher false positive rate (incorrect product scope assignments)

**Verdict**: ✅ **Acceptable for MVP** — Cost-effective, sufficient accuracy for 80% of cases

---

#### Option 2B: Sonnet for Everything (Expensive, Slow, Highly Accurate)

**Model**: Claude 3.5 Sonnet (2024-10-22)
**Pricing**:

- Input: $3 per million tokens
- Output: $15 per million tokens

**Accuracy Characteristics**:

- Excellent at complex reasoning (nuanced disambiguation, multi-scope documents)
- Handles ambiguous cases well (cross-product mentions, contextual interpretation)
- Slower response time (~1-2 seconds per call)

**Cost Analysis** (1,000 docs):
| Task | Tokens | Calls | Cost |
|------|--------|-------|------|
| Taxonomy parsing (one-time) | 50K input, 10K output | 1 | $0.30 |
| Chunk classification (1,000 chunks) | 500 input, 100 output per chunk | 1,000 | $3.00 |
| **Total per 1,000 docs** | — | 1,001 | **$3.30** |

**Pros**:

- Highest accuracy (95%+ correct product scope assignments)
- Handles ambiguous/multi-scope documents well
- Best user experience (fewer incorrect results)

**Cons**:

- 12x more expensive than Haiku ($3.30 vs $0.275)
- Slower response time (1-2 seconds per call)
- Overkill for simple/unambiguous documents

**Verdict**: ❌ **Not cost-effective for MVP** — Accuracy improvement doesn't justify 12x cost increase

---

#### Option 2C: Hybrid Approach (Haiku for Simple, Sonnet for Complex) — **RECOMMENDED**

**Strategy**:

1. **Taxonomy parsing**: Use **Sonnet** (one-time, high accuracy critical)
2. **Chunk classification**: Use **Haiku** with confidence threshold
   - If Haiku confidence ≥ 0.8 → Accept classification
   - If Haiku confidence < 0.8 → Escalate to Sonnet for re-classification

**Cost Analysis** (1,000 docs, assuming 20% escalation rate):
| Task | Model | Tokens | Calls | Cost |
|------|-------|--------|-------|------|
| Taxonomy parsing (one-time) | Sonnet | 50K input, 10K output | 1 | $0.30 |
| Chunk classification (Haiku) | Haiku | 500 input, 100 output | 1,000 | $0.25 |
| Chunk re-classification (Sonnet) | Sonnet | 500 input, 100 output | 200 (20%) | $0.60 |
| **Total per 1,000 docs** | — | — | 1,201 | **$1.15** |

**Accuracy Estimate**:

- Simple documents (80%): Haiku accuracy ~90% (acceptable)
- Complex documents (20%): Sonnet accuracy ~95% (excellent)
- **Overall accuracy**: ~91% (weighted average)

**Pros**:

- Cost-effective: $1.15 per 1,000 docs (4x cheaper than Sonnet-only, 4x more expensive than Haiku-only)
- High accuracy: 91% overall (vs 85% Haiku-only, 95% Sonnet-only)
- Adaptive: Uses Sonnet only when needed
- Best user experience: Fewer false positives than Haiku-only

**Cons**:

- Increased complexity (two-stage classification logic)
- Requires confidence threshold tuning (escalation rate depends on threshold)
- Slightly slower for ambiguous documents (two LLM calls)

**Verdict**: ✅ **RECOMMENDED** — Best balance of cost, accuracy, and user experience

---

### Recommended Approach: **Option 2C (Hybrid)**

**Reasoning**:

1. Taxonomy parsing is one-time → Use Sonnet for high accuracy (negligible cost: $0.30)
2. Chunk classification is high-volume → Use Haiku as primary model for cost efficiency
3. Confidence-based escalation → Use Sonnet for ambiguous cases only (20% of documents)
4. Accuracy matters for user trust → 91% accuracy is significantly better than 85% (Haiku-only)
5. Cost is manageable → $1.15 per 1,000 docs is reasonable for high-quality classification

**Implementation**:

```typescript
async function classifyChunk(
  chunkContent: string,
  taxonomy: DomainTaxonomy,
): Promise<ChunkClassification> {
  // Step 1: Try Haiku first
  const haikuResult = await classifyWithHaiku(chunkContent, taxonomy);

  // Step 2: Check confidence
  if (haikuResult.confidence >= 0.8) {
    // High confidence → Accept Haiku classification
    return {
      ...haikuResult,
      classificationMethod: 'haiku',
    };
  }

  // Step 3: Low confidence → Escalate to Sonnet
  const sonnetResult = await classifyWithSonnet(chunkContent, taxonomy);
  return {
    ...sonnetResult,
    classificationMethod: 'sonnet',
  };
}
```

**Monitoring**:

- Track escalation rate (target: 20% or less)
- If escalation rate > 30% → Consider lowering confidence threshold (0.8 → 0.75)
- If escalation rate < 10% → Consider raising confidence threshold (0.8 → 0.85) for cost savings

---

## Question 3: Multi-Scope Document Ranking Algorithm

### Background

Some documents mention multiple products (e.g., a comparison document: "Credit cards vs debit cards"):

```json
{
  "classification": {
    "productScope": {
      "primaryProduct": "credit_card",
      "confidence": 0.85,
      "secondaryProducts": ["debit_card"]
    }
  }
}
```

**User Query**: "What is the interest rate on credit cards?"

- Classified as: `credit_card`

**Retrieval Challenge**: How to rank documents?

- Document A: `primaryProduct: "credit_card"` (perfect match)
- Document B: `primaryProduct: "credit_card"`, `secondaryProducts: ["debit_card"]` (primary match, but also mentions debit card)
- Document C: `primaryProduct: "debit_card"`, `secondaryProducts: ["credit_card"]` (secondary match)

### Options & Analysis

#### Option 3A: Primary-Only Matching (Strict)

**Strategy**: Only return documents where `query_product == primaryProduct`

**Ranking**:

- Document A: ✅ Returned (rank 1)
- Document B: ✅ Returned (rank 2, equal to A)
- Document C: ❌ Excluded (query product is secondary, not primary)

**Pros**:

- High precision (only returns docs primarily about query product)
- No false positives from cross-product mentions

**Cons**:

- Low recall (misses comparison documents that mention query product as secondary)
- User may miss relevant information (e.g., "Credit card vs debit card comparison" excluded from credit card query)

**Verdict**: ❌ **Too restrictive** — Misses valuable comparison/context documents

---

#### Option 3B: Primary + Secondary Matching with Score Weighting (Balanced) — **RECOMMENDED**

**Strategy**: Return documents where `query_product` matches `primaryProduct` OR `secondaryProducts`, rank by match type

**Ranking Algorithm**:

```
score = base_score * product_match_multiplier * confidence_multiplier

where:
- base_score = semantic similarity score (existing vector search score)
- product_match_multiplier = 1.0 (primary match) or 0.7 (secondary match)
- confidence_multiplier = classification.productScope.confidence
```

**Example**:

- **Document A**: `primaryProduct: "credit_card"`, confidence 0.9, base_score 0.85
  - Final score: 0.85 _ 1.0 _ 0.9 = **0.765**

- **Document B**: `primaryProduct: "credit_card"`, `secondaryProducts: ["debit_card"]`, confidence 0.85, base_score 0.82
  - Final score: 0.82 _ 1.0 _ 0.85 = **0.697**

- **Document C**: `primaryProduct: "debit_card"`, `secondaryProducts: ["credit_card"]`, confidence 0.8, base_score 0.80
  - Final score: 0.80 _ 0.7 _ 0.8 = **0.448**

**Ranking** (descending by score):

1. Document A (0.765) — Primary match, high confidence
2. Document B (0.697) — Primary match, multi-scope
3. Document C (0.448) — Secondary match (comparison doc)

**Pros**:

- Balanced precision/recall (returns primary matches first, then secondary)
- User sees comparison documents lower in results (relevant but not top)
- Configurable weighting (adjust 0.7 multiplier based on user feedback)

**Cons**:

- More complex ranking algorithm
- Requires tuning of multiplier values

**Verdict**: ✅ **RECOMMENDED** — Good balance, configurable, user-friendly

---

#### Option 3C: Hybrid with Explicit "Comparison" Tag (Advanced)

**Strategy**: Detect comparison documents during classification, rank them separately

**Classification Output**:

```json
{
  "classification": {
    "productScope": {
      "primaryProduct": "credit_card",
      "secondaryProducts": ["debit_card"],
      "isComparison": true // NEW: Explicitly mark comparison docs
    }
  }
}
```

**Ranking Algorithm**:

```
if query_context == "comparison" (detected from query):
  // User wants comparison → Boost comparison docs
  score = base_score * (isComparison ? 1.2 : 1.0)
else:
  // User wants specific product → Penalize comparison docs
  score = base_score * (isComparison ? 0.6 : 1.0)
```

**Example Queries**:

- "What is the interest rate on credit cards?" → NOT a comparison query → Penalize comparison docs
- "Credit card vs debit card comparison" → Comparison query → Boost comparison docs

**Pros**:

- Best user experience (understands user intent)
- Returns comparison docs when wanted, hides them when not wanted

**Cons**:

- Requires query intent classification (additional LLM call or rule-based detection)
- Increased complexity
- "Comparison" detection may be inaccurate

**Verdict**: ⚠️ **Future enhancement** — Good idea, but defer to Phase 2 (after Option 3B is proven)

---

### Recommended Approach: **Option 3B (Primary + Secondary with Score Weighting)**

**Reasoning**:

1. Balances precision and recall (returns relevant comparison docs, ranked lower)
2. Simple to implement (weighted scoring)
3. Configurable (adjust multiplier based on user feedback)
4. No additional LLM calls (uses existing classification)

**Implementation**:

```typescript
function calculateFinalScore(doc: SearchDocument, queryProduct: string, baseScore: number): number {
  const { primaryProduct, secondaryProducts, confidence } = doc.classification.productScope;

  // Determine product match type
  let productMatchMultiplier: number;
  if (primaryProduct === queryProduct) {
    productMatchMultiplier = 1.0; // Primary match
  } else if (secondaryProducts.includes(queryProduct)) {
    productMatchMultiplier = 0.7; // Secondary match
  } else {
    productMatchMultiplier = 0.0; // No match (exclude)
  }

  // Apply multipliers
  const finalScore = baseScore * productMatchMultiplier * confidence;

  return finalScore;
}
```

**Tuning Guidance**:

- Start with `secondary_multiplier = 0.7`
- If users complain about irrelevant comparison docs → Lower to 0.5 or 0.6
- If users complain about missing comparison docs → Raise to 0.8

**Future Enhancement**: Add Option 3C (comparison intent detection) in Phase 2 after gathering user feedback

---

## Question 4: Taxonomy Version Migration Strategy

### Background

When taxonomy is updated (new domain definitions, updated organization profile):

- **Problem**: Existing chunks are classified with **old taxonomy** (version 1.0)
- **Required**: Re-classify all chunks with **new taxonomy** (version 1.1)

**Scale**: 10,000 chunks per index × 100 indexes = 1 million chunks to re-classify

### Options & Analysis

#### Option 4A: Immediate Re-Classification (All-at-Once)

**Strategy**: When taxonomy is updated, immediately re-classify ALL chunks

**Workflow**:

1. Admin uploads new taxonomy → Version 1.0 → 1.1
2. System flags all chunks: `needsReclassification: true`, `taxonomyVersion: "1.0"`
3. **Background job starts immediately**: Re-classify all chunks
4. System updates chunks: `needsReclassification: false`, `taxonomyVersion: "1.1"`

**Timeline** (10,000 chunks):

- Classification rate: 100 chunks/minute (using Haiku)
- Total time: 100 minutes (~1.5 hours)
- Cost: $2.75 (10,000 chunks × $0.275 per 1,000 chunks)

**Pros**:

- Simple implementation (single background job)
- Consistent state (all chunks use same taxonomy version after completion)
- Predictable cost

**Cons**:

- High immediate cost spike ($2.75 per 10K chunks)
- Resource contention (heavy LLM usage during re-classification)
- Temporary inconsistency (some chunks v1.0, some v1.1 during migration)

**Verdict**: ⚠️ **Acceptable for small indexes** (< 10,000 chunks), problematic for large indexes

---

#### Option 4B: Incremental Re-Classification (Lazy/On-Demand) — **RECOMMENDED**

**Strategy**: Re-classify chunks **on-demand** when they are retrieved in query results

**Workflow**:

1. Admin uploads new taxonomy → Version 1.0 → 1.1
2. System flags all chunks: `needsReclassification: true`, `taxonomyVersion: "1.0"`
3. **No immediate action** (chunks remain v1.0 until accessed)
4. **On query**:
   - Retrieve chunks using **old classification** (v1.0)
   - After retrieval, check `needsReclassification: true`
   - Re-classify chunk with **new taxonomy** (v1.1) in background
   - Update chunk: `needsReclassification: false`, `taxonomyVersion: "1.1"`
   - Return result to user (using old or new classification, depending on timing)

**Timeline** (10,000 chunks, assuming 20% accessed in first week):

- Week 1: 2,000 chunks re-classified (accessed during queries)
- Week 2-4: Remaining 8,000 chunks gradually re-classified
- Cost spread over 4 weeks: $0.55/week

**Pros**:

- Low immediate cost (only re-classify accessed chunks)
- No resource contention (re-classification happens gradually)
- Prioritizes high-traffic documents (frequently accessed chunks re-classified first)

**Cons**:

- Inconsistent state for weeks (some chunks v1.0, some v1.1)
- Complex implementation (query-time re-classification logic)
- Rarely accessed chunks may stay v1.0 indefinitely

**Verdict**: ✅ **RECOMMENDED for large indexes** — Cost-effective, scalable, prioritizes important docs

---

#### Option 4C: Hybrid (Immediate for Hot Documents, Lazy for Cold Documents)

**Strategy**: Immediately re-classify **frequently accessed** chunks, lazy re-classify rarely accessed chunks

**Workflow**:

1. Admin uploads new taxonomy → Version 1.0 → 1.1
2. System flags all chunks: `needsReclassification: true`, `taxonomyVersion: "1.0"`
3. **Identify hot documents** (top 20% by query frequency in last 30 days)
4. **Background job**: Immediately re-classify hot documents (2,000 chunks)
5. **Lazy re-classify**: Remaining 8,000 chunks on-demand (Option 4B)

**Timeline** (10,000 chunks):

- Immediate: 2,000 hot chunks re-classified in 20 minutes
- Lazy: 8,000 cold chunks re-classified over 4 weeks

**Pros**:

- Best user experience (hot docs updated immediately, users don't notice cold docs being stale)
- Balanced cost (immediate spike for 20%, spread over weeks for 80%)
- Scalable (works for large indexes)

**Cons**:

- Most complex implementation (hybrid logic)
- Requires query analytics (track document access frequency)

**Verdict**: ⚠️ **Future enhancement** — Good idea, but defer to Phase 2 (after Option 4B is proven)

---

### Recommended Approach: **Option 4B (Incremental Re-Classification)**

**Reasoning**:

1. Cost-effective (spread cost over time)
2. Scalable (works for million+ chunk indexes)
3. Prioritizes high-traffic documents (frequently accessed chunks updated first)
4. No resource contention (gradual re-classification)

**Implementation**:

```typescript
async function retrieveAndReclassifyIfNeeded(
  chunkId: string,
  currentTaxonomy: DomainTaxonomy,
): Promise<SearchChunk> {
  // Step 1: Retrieve chunk
  const chunk = await SearchChunk.findById(chunkId);

  // Step 2: Check if re-classification needed
  if (chunk.metadata.needsReclassification) {
    // Step 3: Re-classify in background (don't block query)
    reclassifyChunkInBackground(chunk, currentTaxonomy);
  }

  // Step 4: Return chunk (may use old classification if re-classification not complete)
  return chunk;
}

async function reclassifyChunkInBackground(
  chunk: SearchChunk,
  taxonomy: DomainTaxonomy,
): Promise<void> {
  // Re-classify chunk with new taxonomy
  const newClassification = await classifyChunk(chunk.content, taxonomy);

  // Update chunk
  await SearchChunk.updateOne(
    { _id: chunk._id },
    {
      $set: {
        classification: newClassification,
        'metadata.needsReclassification': false,
        'metadata.taxonomyVersion': taxonomy.version,
        'metadata.reclassifiedAt': new Date(),
      },
    },
  );
}
```

**Monitoring**:

- Track re-classification progress: % of chunks updated to v1.1
- Alert if re-classification rate is too slow (< 1% per day)
- Option to trigger batch re-classification if needed (fallback to Option 4A for specific indexes)

**Future Enhancement**: Add Option 4C (hot/cold split) in Phase 2 after gathering query analytics

---

## Question 5: API Authentication Model for Taxonomy Upload

### Background

Taxonomy upload is a **critical admin operation**:

- Affects all documents in the index (re-classification triggered)
- Modifies knowledge graph structure
- High cost implications (re-classification costs)

**Security Requirements**:

- Prevent unauthorized taxonomy changes
- Audit trail for taxonomy uploads
- Role-based access control

### Options & Analysis

#### Option 5A: Platform Admin Only (Most Restrictive)

**Who Can Upload**:

- Platform admins only (Anthropic/internal team)
- Tenants CANNOT upload custom taxonomy

**API Endpoint**:

```typescript
POST /api/admin/knowledge-graph/:indexId/taxonomy
Authorization: Bearer <platform_admin_token>
```

**Authentication**:

- Platform admin JWT token
- Required role: `platform_admin`

**Pros**:

- Highest security (minimal risk of misuse)
- Centralized control (Anthropic reviews all taxonomy changes)
- Simpler implementation (single auth level)

**Cons**:

- No self-service (tenants must contact support to update taxonomy)
- Slow turnaround (support ticket → approval → upload)
- Poor user experience (tenants want control over their taxonomy)

**Verdict**: ❌ **Too restrictive** — Not self-service, poor UX

---

#### Option 5B: Tenant Admin (Balanced) — **RECOMMENDED**

**Who Can Upload**:

- Tenant admins (users with `admin` role in their tenant)
- Platform admins (for all tenants)

**API Endpoint**:

```typescript
POST /api/knowledge-graph/:indexId/taxonomy
Authorization: Bearer <tenant_admin_token>
```

**Authentication**:

- Tenant admin JWT token
- Required role: `admin` (within tenant)
- Verify: `token.tenantId == index.tenantId` (tenant admins can only modify their own indexes)

**Pros**:

- Self-service (tenants manage their own taxonomy)
- Good security (only admins, not all users)
- Scalable (no support bottleneck)
- Standard pattern (same auth as other admin endpoints)

**Cons**:

- Requires tenant admin role implementation (if not already exists)
- Tenant admins could misconfigure taxonomy (but only affects their tenant)

**Verdict**: ✅ **RECOMMENDED** — Good balance, self-service, standard pattern

---

#### Option 5C: Project Admin (Most Permissive)

**Who Can Upload**:

- Project admins (users with `admin` role for a specific project)
- Tenant admins (all projects in tenant)
- Platform admins (all projects)

**API Endpoint**:

```typescript
POST /api/projects/:projectId/indexes/:indexId/taxonomy
Authorization: Bearer <project_admin_token>
```

**Authentication**:

- Project admin JWT token
- Required permission: `project:admin` or `knowledge-graph:write`
- Verify: `token.projectId == index.projectId`

**Pros**:

- Granular control (project-level permissions)
- Flexible (allows delegation to project admins, not just tenant admins)

**Cons**:

- More complex auth logic (project-level RBAC)
- Higher risk of misconfiguration (more users with upload permission)
- May be overkill for taxonomy management (taxonomy often tenant-wide, not project-specific)

**Verdict**: ⚠️ **Optional enhancement** — Good for multi-project tenants, but not required for MVP

---

### Recommended Approach: **Option 5B (Tenant Admin)**

**Reasoning**:

1. Self-service (tenants manage their own taxonomy)
2. Good security (only admins, not all users)
3. Standard pattern (aligns with existing admin endpoints)
4. Scalable (no support bottleneck)

**Implementation**:

```typescript
// API endpoint
router.post(
  '/api/knowledge-graph/:indexId/taxonomy',
  requireAuth,
  requireTenantAdmin, // Middleware: check if user has 'admin' role in tenant
  async (req, res) => {
    const { indexId } = req.params;
    const { tenantId } = req.user; // From JWT token
    const { organizationProfile, customDomainFiles } = req.body;

    // Step 1: Verify index belongs to tenant
    const index = await SearchIndex.findOne({ _id: indexId, tenantId });
    if (!index) {
      return res.status(404).json({ error: 'Index not found' });
    }

    // Step 2: Upload taxonomy files to S3
    const orgProfileUrl = await uploadToS3(organizationProfile);
    const domainFileUrls = await Promise.all(customDomainFiles.map(uploadToS3));

    // Step 3: Parse taxonomy with LLM (Sonnet)
    const taxonomy = await parseTaxonomyWithLLM(
      orgProfileUrl,
      domainFileUrls,
      index.knowledgeGraph.domains,
    );

    // Step 4: Store taxonomy
    await KnowledgeGraphTaxonomy.create({
      tenantId,
      indexId,
      taxonomy,
      version: '1.0',
      organizationProfileFile: orgProfileUrl,
      customDomainFiles: domainFileUrls,
    });

    // Step 5: Create taxonomy graph in Neo4j
    await createTaxonomyGraph(taxonomy);

    // Step 6: Return success
    res.json({ success: true, taxonomyVersion: '1.0' });
  },
);
```

**Audit Logging**:

```typescript
// Log taxonomy upload
await AuditLog.create({
  tenantId,
  userId: req.user.id,
  action: 'TAXONOMY_UPLOAD',
  resource: 'knowledge-graph-taxonomy',
  resourceId: indexId,
  metadata: {
    taxonomyVersion: '1.0',
    domainCount: customDomainFiles.length,
    organizationProfileSize: organizationProfile.length,
  },
  timestamp: new Date(),
});
```

**Future Enhancement**: Add Option 5C (project-level permissions) in Phase 2 for multi-project tenants

---

## Summary of Recommendations

| Question                    | Recommended Approach                                                                   | Reasoning                                                                           |
| --------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| **Q1: Neo4j Indexing**      | **Standard Indexing** (unique on `id`, index on `name`)                                | Balanced write/read performance, production-proven, fast query lookups (5-10ms)     |
| **Q2: LLM Model**           | **Hybrid** (Sonnet for taxonomy parsing, Haiku + Sonnet escalation for classification) | Cost-effective ($1.15 per 1K docs), high accuracy (91%), adaptive                   |
| **Q3: Multi-Scope Ranking** | **Primary + Secondary with Score Weighting** (1.0 for primary, 0.7 for secondary)      | Balanced precision/recall, configurable, returns comparison docs ranked lower       |
| **Q4: Taxonomy Migration**  | **Incremental Re-Classification** (on-demand during queries)                           | Cost-effective (spread over time), scalable (million+ chunks), prioritizes hot docs |
| **Q5: API Authentication**  | **Tenant Admin** (tenant-level admin role required)                                    | Self-service, good security, standard pattern, scalable                             |

---

## Next Steps

1. **Review and approve** recommendations above
2. **Finalize decisions** on any modified approaches
3. **Proceed with Phase 1 implementation**:
   - Task #60: Implement Neo4j schema with standard indexing
   - Task #61: Update chunk schema with classification field
   - Task #53: Implement domain context loading (Sonnet for taxonomy parsing)
   - Task #63: Build organization profile API (tenant admin auth)
4. **Gather metrics** during MVP:
   - Neo4j query performance (track lookup times)
   - LLM escalation rate (target: 20% or less)
   - Multi-scope document ranking effectiveness (user feedback)
   - Re-classification progress (track % of chunks updated)
   - Taxonomy upload frequency (how often tenants update)
5. **Iterate** based on real-world usage:
   - Adjust LLM confidence threshold if escalation rate too high/low
   - Tune multi-scope ranking multiplier based on user feedback
   - Consider hybrid re-classification (hot/cold) if lazy approach too slow
   - Add project-level permissions if tenant admins request delegation

---

**End of Open Questions Discussion**
