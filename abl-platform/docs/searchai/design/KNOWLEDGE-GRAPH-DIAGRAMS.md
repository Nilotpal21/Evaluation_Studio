# Knowledge Graph — Architecture Diagrams

> Companion to [KNOWLEDGE-GRAPH-ARCHITECTURE.md](./KNOWLEDGE-GRAPH-ARCHITECTURE.md)
> All diagrams reflect the actual implementation as of 2026-04-06.

---

## 1. System Context

```
                              ┌─────────────┐
                              │   End User   │
                              └──────┬───────┘
                                     │ Queries
                              ┌──────▼───────┐
                              │  Studio UI    │
                              │  (5173)       │
                              └──┬────────┬──┘
                    KB/Taxonomy  │        │  Search/Browse
                    Management   │        │  Testing
                              ┌──▼────┐ ┌─▼──────────┐
                              │search │ │ search-ai   │
                              │  -ai  │ │  -runtime   │
                              │(3005) │ │  (3004)     │
                              │ENGINE │ │ QUERY RT    │
                              └──┬────┘ └──┬──────────┘
                                 │         │
                    ┌────────────┼─────────┼────────────┐
                    │            │         │             │
              ┌─────▼──┐  ┌─────▼──┐ ┌────▼───┐  ┌─────▼──┐
              │MongoDB  │  │ Neo4j  │ │OpenSrch│  │  Redis  │
              │         │  │        │ │/Qdrant │  │         │
              │Taxonomy │  │ Graph  │ │Vectors │  │ Cache   │
              │Documents│  │ Nodes  │ │+KG meta│  │ Queues  │
              │Attribs  │  │ Edges  │ │        │  │ Pub/Sub │
              └─────────┘  └────────┘ └────────┘  └─────────┘
                                          │
                                    ┌─────▼──┐
                                    │ClickHs │
                                    │ Facets  │
                                    └────────┘
```

---

## 2. Taxonomy Setup Flow

```
┌─────────────────────────────────────────────────────────────────────┐
│                       TAXONOMY SETUP                                 │
│                       (one-time per index)                           │
└─────────────────────────────────────────────────────────────────────┘

  Admin in Studio
       │
       │ POST /api/indexes/:indexId/kg-taxonomy/setup
       │ { domainDefinitionPaths, organizationProfileUrl? }
       ▼
  ┌─────────────────┐
  │  kg-taxonomy.ts  │ ──validates──▶ Zod schema
  │  (route handler) │
  └────────┬────────┘
           │ enqueue
           ▼
  ┌─────────────────────┐
  │  BullMQ Queue:       │
  │  taxonomy-setup      │
  └────────┬─────────────┘
           │
           ▼
  ┌─────────────────────────────────────────┐
  │  taxonomy-setup-worker                   │
  │                                          │
  │  1. TaxonomyLoaderService                │
  │     └─ Load domain YAML/JSON files       │
  │                                          │
  │  2. OrgProfileGenerator           │
  │     └─ Fetch URL → LLM parse → profile  │  ◄── SSRF protection
  │                                          │      + circuit breaker
  │  3. CustomDomainGenerator         │
  │     └─ LLM generates domain if no       │
  │        built-in match                    │
  │                                          │
  │  4. Merge: domain + org profile          │
  │     → unified taxonomy definition        │
  └────────┬────────────────────────────────┘
           │
     ┌─────┼──────────┬──────────────┐
     │     │          │              │
     ▼     │          ▼              ▼
  MongoDB  │       Neo4j          Redis
  ┌────────▼──┐  ┌───────────┐  ┌───────────────┐
  │ KG        │  │ Domain    │  │ taxonomy:cache │
  │ Taxonomy  │  │  ↓        │  │ :tenantId:     │
  │ (v1)      │  │ Category  │  │  indexId       │
  │           │  │  ↓        │  │ TTL: 30min     │
  │ KG Domain │  │ Product   │  │                │
  │ (if new)  │  │  ↓        │  │ pub/sub:       │
  │           │  │ Attribute │  │ taxonomy:      │
  └───────────┘  │           │  │ invalidate     │
                 │ EXCLUDES  │  └───────────────┘
                 └───────────┘
```

---

## 3. KG Enrichment — Per-Document Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    KG ENRICHMENT (per document)                           │
│                    kg-enrichment-worker.ts                                │
└──────────────────────────────────────────────────────────────────────────┘

  ┌──────────────────────┐
  │ Document (has summary)│
  │ kgState: NOT_ENRICHED │
  └──────────┬───────────┘
             │
  ═══════════▼═══════════════════════════════════════════════════════
  Step 1: CLASSIFY DOCUMENT
  ═════════════════════════════════════════════════════════════════════

  DocumentClassifierService.classifyDocument()
  ┌─────────────┐     ┌──────────────────┐
  │ doc.summary  │────▶│   Claude Haiku    │──confidence─▶ ≥ 0.8? ──YES──▶ result
  │ + taxonomy   │     │   ($0.0002/doc)   │              │
  └─────────────┘     └──────────────────┘              NO
                                                         │
                                                         ▼
                                                  ┌──────────────┐
                                                  │ Claude Sonnet │──▶ result
                                                  │ ($0.003/doc)  │
                                                  └──────────────┘

  result = { primaryProduct: "credit_card", confidence: 0.92,
             department: "Retail Banking", category: "cards" }

  Classification is stored in MongoDB (document.classification), NOT in Neo4j.
  The taxonomy graph only stores the taxonomy hierarchy and entity instances.

  ═══════════▼═══════════════════════════════════════════════════════
  Step 2: EXTRACT ENTITIES (per chunk, scoped by product)
  ═════════════════════════════════════════════════════════════════════

  EntityExtractorService.extractEntities(chunkText, taxonomy, "credit_card")

  ┌──────────────┐     ┌───────────────────────────────┐
  │ chunk text    │────▶│ SCOPING: only credit_card     │
  │ + taxonomy    │     │ attributes considered          │
  └──────────────┘     │                                │
                       │  ✅ interest_rate               │
                       │  ✅ credit_limit                │
                       │  ✅ annual_fee                  │
                       │  ❌ atm_limit (debit_card only) │
                       └──────────┬────────────────────┘
                                  │
                       ┌──────────▼────────────────────┐
                       │ HYBRID EXTRACTION:             │
                       │                                │
                       │  Regex first (free, fast):     │
                       │  "15.99% APR" → interest_rate  │
                       │  "$5,000" → credit_limit       │
                       │                                │
                       │  LLM fallback (complex types): │
                       │  "variable rate" → interest_   │
                       │  rate_type: "variable"         │
                       └──────────┬────────────────────┘
                                  │
                                  ▼
  entities = [
    { type: "interest_rate", rawValue: "15.99% APR", normalizedValue: 0.1599 },
    { type: "credit_limit", rawValue: "$5,000", normalizedValue: 5000 }
  ]

  ═══════════▼═══════════════════════════════════════════════════════
  (Still per chunk) Step 4: UPDATE VECTOR METADATA
  ═════════════════════════════════════════════════════════════════════

  VectorStore.upsert() — preserves original embedding
  Sets: canonical.custom.kg = { primaryProduct, secondaryProducts,
        confidence, department, category, kgEnriched, kgEnrichedAt }

  ═══════════▼═══════════════════════════════════════════════════════
  (Still per chunk) Step 5: DEDUPLICATE ENTITIES (accumulate)
  ═════════════════════════════════════════════════════════════════════

  Map<"type:normalizedValue", IEntityInstance>
  Merge chunkIds across occurrences within this document

  ═══════════▼═══════════════════════════════════════════════════════
  (After all chunks) Steps 5.5-7: PER-DOCUMENT WRITES
  ═════════════════════════════════════════════════════════════════════

  Step 5.5: Novel attribute discovery (fail-open, see Section 4)

  ┌─────────────────────┬────────────────────┬───────────────────┐
  │   Neo4j (Step 6)     │ ClickHouse (6.5)   │ MongoDB (Step 7)  │
  │                      │                    │                   │
  │ EntityInstance       │ entity_instances   │ doc.classification│
  │   ├─ INSTANCE_OF     │ (buffered write)   │ doc.entityInstances│
  │   │   → Attribute    │                    │ doc.kgState =     │
  │   └─ FOUND_IN_       │ DELETE-before-     │   'ENRICHED'      │
  │       PRODUCT        │ INSERT on          │                   │
  │       → Product      │ re-enrichment      │                   │
  └─────────────────────┘────────────────────└───────────────────┘
```

Note: Vector DB updates happen per-chunk in Step 4 (inside the chunk loop),
not in the per-document write phase.

> **Note:** Document and Chunk nodes are **not** stored in the Neo4j taxonomy graph.
> Classification data (product, category) lives in MongoDB (`searchdocuments.metadata`).
> The permission graph manages its own `:Document` nodes separately for access-control queries.

---

## 4. Novel Attribute Discovery Flow

```
┌────────────────────────────────────────────────────────────────────┐
│              NOVEL ATTRIBUTE DISCOVERY (Step 5.5)                    │
│              Runs inside kg-enrichment-worker, fail-open             │
└────────────────────────────────────────────────────────────────────┘

  LLM extraction finds unknown attribute
       │
       │  { name: "late_payment_fee", definition: "...",
       │    rawValue: "$39", confidence: 0.87, productType: "credit_card" }
       ▼
  ┌──────────────────────────┐
  │ validateNovelCandidate() │
  │  ├─ Name not empty       │
  │  ├─ Not a stopword       │
  │  ├─ Definition present   │
  │  ├─ DataType valid       │
  │  └─ Not in taxonomy      │──FAIL──▶ Discard (logged)
  └──────────┬───────────────┘
             │ PASS
             ▼
  ┌──────────────────────────────┐
  │ AttributeRegistry upsert     │
  │ (two-phase, race-safe)       │
  │                              │
  │ Phase 1: $setOnInsert        │
  │   tier: 'novel'              │
  │   firstSeenAt: now           │
  │   source: 'llm-discovery'    │
  │                              │
  │ Phase 2: conditional $set     │
  │   lastSeenAt: now            │
  │   confidence + definition    │
  │   (only if new > stored)     │
  │   $inc: { documentCount: 1 } │
  └──────────┬───────────────────┘
             │
             ▼
  ┌──────────────────────────────────────────┐
  │ TIER PROGRESSION:                          │
  │                                           │
  │  novel ──(reconciliation)──▶ approved     │
  │  approved ──(admin)────────▶ permanent    │
  │  approved ──(auto-demotion)─▶ beta        │
  │  beta ──(auto-promotion)───▶ approved     │
  │                                           │
  │  OR: novel ──(low count + old age)──▶     │
  │      discarded (admin-only resurrection)  │
  └──────────────────────────────────────────┘
```

---

## 5. Taxonomy Caching (Cross-Service)

```
┌──────────────────────────────────────────────────────────────────────┐
│                    TAXONOMY CACHE ARCHITECTURE                        │
└──────────────────────────────────────────────────────────────────────┘

  search-ai (Engine, :3005)              search-ai-runtime (:3004)
  ┌─────────────────────────┐            ┌──────────────────────────┐
  │ TaxonomyCacheWriter      │            │ TaxonomyCacheReader       │
  │                          │            │                           │
  │ On taxonomy change:      │            │ Read path:                │
  │ 1. Write to MongoDB ─────┼── source ──│──────────────────┐       │
  │    (source of truth)     │   of       │  1. LRU cache    │       │
  │                          │   truth    │  │  200 entries   │       │
  │ 2. Write to Redis ───────┼── cache ──▶│  │  5min TTL      │       │
  │    TTL: 30 min           │            │  │  Hit? Return   │       │
  │                          │            │  │                │       │
  │ 3. Publish invalidation ─┼── pub/ ──▶│  2. Redis        │       │
  │    channel: taxonomy:    │   sub      │  │  30min TTL     │       │
  │    invalidate            │            │  │  Hit? → LRU    │       │
  │                          │            │  │  Return        │       │
  │                          │            │  │                │       │
  │                          │            │  3. MongoDB      │       │
  │                          │            │     → Redis + LRU│       │
  │                          │            │     Return       │       │
  └─────────────────────────┘            └──────────────────┘       │
                                                                     │
                                          On invalidation event:     │
                                          ├─ Evict LRU entry         │
                                          └─ Next read hits Redis    │
                                                                     │
                                          On Redis failure:          │
                                          └─ Return null (fail-open) │
                                             Browse degrades         │
                                             gracefully              │
```

---

## 6. KB-as-Tool: Agent Integration

```
┌────────────────────────────────────────────────────────────────────┐
│              KB-as-TOOL PATTERN (Runtime Agent Integration)         │
└────────────────────────────────────────────────────────────────────┘

  1. KB CREATION → AUTO TOOL REGISTRATION

  Studio: Create KB "Banking Docs"
       │
       ▼
  search-ai: POST /api/projects/:pid/knowledge-bases
       │
       ├─ Create KnowledgeBase (MongoDB)
       ├─ Create SearchIndex (1:1 link)
       ├─ Create CanonicalSchema
       ├─ Create Pipeline
       │
       └─ registerSearchAITool()
          └─ ProjectTool {
               toolType: 'searchai',
               name: 'search_kb_banking_docs',
               dsl: { index_id, tenant_id, kb_name }
             }


  2. AGENT USES KB TOOL

  User: "What's the interest rate on my credit card?"
       │
       ▼
  ┌─────────────────────────────────────┐
  │  Runtime Agent (3112)                │
  │                                      │
  │  LLM sees tool: search_kb_banking_   │
  │  docs                                │
  │  Description (from Discovery):       │
  │  "Search Banking Docs. 2,847 docs.   │
  │   Supports: structured, semantic,    │
  │   hybrid. Vocabulary: interest rate  │
  │   (APR), credit limit..."            │
  │                                      │
  │  LLM decides: call tool with         │
  │  { query: "credit card interest      │
  │    rate", queryType: "semantic" }     │
  └──────────┬──────────────────────────┘
             │
             ▼
  ┌─────────────────────────────────────┐
  │  SearchAIKBToolExecutor              │
  │                                      │
  │  a. Resolve: tool name → indexId     │
  │  b. Discovery manifest (5min cache)  │
  │  c. Query enrichment (conversation   │
  │     history → LLM rephrase)          │
  │  d. Normalize queryType              │
  │     ("phrase" → "hybrid")            │
  │  e. Normalize filters                │
  │     ("fileType" → "source_type")     │
  └──────────┬──────────────────────────┘
             │
             ▼ SearchAIClient.unifiedSearch()
  ┌─────────────────────────────────────┐
  │  search-ai-runtime (3004)            │
  │  QueryPipeline.executeUnified()      │
  │                                      │
  │  Stage 0: Permission filter          │
  │  Stage 1: (skip — agent flow)        │
  │  Stage 2: (skip — agent flow)        │
  │  Stage 2.5: Alias resolution         │
  │  Stage 3: OpenSearch hybrid search   │
  │           ↳ KG metadata filters:     │
  │             productScope=credit_card  │
  │  Stage 4: Rerank (Voyage AI)         │
  │  Stage 5: Metrics                    │
  └──────────┬──────────────────────────┘
             │
             ▼
  Results → Format for LLM → Agent synthesizes answer
  "The interest rate on your credit card is 15.99% APR..."
```

---

## 7. Data Hierarchy

```
┌─────────────────────────────────────────────────────────────────────┐
│                    KNOWLEDGE BASE DATA HIERARCHY                     │
└─────────────────────────────────────────────────────────────────────┘

  KnowledgeBase (user-facing, project-scoped)
  │ name: "Banking Documentation"
  │ projectId: "proj_123"
  │ DB: default mongoose
  │
  └──── SearchIndex (system, tenant-scoped, 1:1 with KB)
        │ llmConfig.useCases.knowledgeGraph: { enabled, modelTier }
        │ DB: searchaicontent
        │
        ├──── KnowledgeGraphTaxonomy (1 per index)
        │     │ Domain > Category > Product > Attribute
        │     │ Department boundaries (EXCLUDES)
        │     │ previousVersions[] (rollback support)
        │     │ DB: searchaicontent
        │     │
        │     └──── KnowledgeGraphDomain (N per tenant)
        │           │ Built-in or LLM-generated
        │           │ DB: searchaicontent
        │           │
        │           └──── AttributeRegistry (N per index)
        │                 │ Novel attributes discovered by LLM
        │                 │ Tier: novel → approved → permanent (beta via demotion)
        │                 DB: searchaicontent
        │
        ├──── SearchSource / Connector (N per index)
        │     │ SharePoint, file upload, web crawl, etc.
        │     │
        │     └──── SearchDocument (N per source)
        │           │ classification: IDocumentClassification
        │           │ entityInstances: IEntityInstance[]
        │           │ metadata.kgState: IDocumentKGState
        │           │
        │           └──── SearchChunk (N per document)
        │                 │ metadata.entities: IEntityExtraction[]
        │                 │ embedding: number[] (vector)
        │                 │ metadata.canonical.custom.kg: {...}
        │
        └──── Neo4j Graph (taxonomy hierarchy + entity dedup)
              │
              ├── Domain → Category → Product → Attribute
              │                         │
              │                         └── FOUND_IN_PRODUCT ◄── EntityInstance
              │                                                    │
              │                                                    └── INSTANCE_OF → Attribute
              │
              ├── Product ──[:EXCLUDES]──► Product (boundary)
              │
              └── (Permission graph: separate :Document nodes for access control,
                   managed by packages/search-ai-internal/src/permissions/)
```

---

## 8. Department Boundary Enforcement

```
┌────────────────────────────────────────────────────────────────────┐
│              DEPARTMENT BOUNDARY (EXCLUDES relationship)            │
└────────────────────────────────────────────────────────────────────┘

  WITHOUT BOUNDARIES (generic KG):

  ┌──────────┐   CO_OCCURS_WITH   ┌──────────┐
  │ Credit   │◄──────────────────▶│  Debit   │   ← FALSE LINK!
  │ Card     │                    │  Card    │
  └────┬─────┘                    └────┬─────┘
       │                               │
  interest_rate                   interest_rate  ← WRONG: debit cards
       │                               │           don't have APR
  15.99% APR                      15.99% APR


  WITH BOUNDARIES (domain-aware KG):

  ┌──────────┐      EXCLUDES       ┌──────────┐
  │ Credit   │─────────────────────│  Debit   │   ← BOUNDARY
  │ Card     │  "Different product │  Card    │
  └────┬─────┘   types. Credit has └────┬─────┘
       │         APR; debit does not."  │
       │                                │
  ┌────▼──────────────┐    ┌────────────▼───────┐
  │ HAS_ATTRIBUTE:    │    │ HAS_ATTRIBUTE:     │
  │ ✅ interest_rate  │    │ ✅ atm_withdrawal  │
  │ ✅ credit_limit   │    │ ✅ daily_limit     │
  │ ✅ annual_fee     │    │ ❌ interest_rate   │  ← NOT applicable
  │ ❌ atm_withdrawal │    │ ❌ credit_limit    │  ← NOT applicable
  └───────────────────┘    └────────────────────┘


  QUERY: "debit card interest rate"

  1. Classify query → targets "debit_card"
  2. Check attributes → interest_rate NOT in debit_card's attributes
  3. Check EXCLUDES → credit_card explicitly excluded
  4. Response: "Debit cards do not have interest rates.
               They withdraw directly from your checking account."
     NOT: "15.99% APR" (which is credit card data)
```
