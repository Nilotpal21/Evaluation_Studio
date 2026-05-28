# Knowledge Graph Architecture — Complete Reference

> **Status**: Living Document (reflects actual implementation)
> **Last Updated**: 2026-04-06
> **Scope**: All KG capabilities across search-ai, search-ai-runtime, runtime, studio
> **Related**: [Feature Spec](../../features/knowledge-graph.md), [HLD](../../specs/knowledge-graph.hld.md), [LLD](../../plans/knowledge-graph.lld.md)

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [The Problem We Solved](#2-the-problem-we-solved)
3. [Architecture Overview](#3-architecture-overview)
4. [Data Model & Storage](#4-data-model--storage)
5. [Taxonomy System](#5-taxonomy-system)
6. [Document Classification](#6-document-classification)
7. [Entity Extraction Pipeline](#7-entity-extraction-pipeline)
8. [Novel Attribute Discovery](#8-novel-attribute-discovery)
9. [Graph Store Layer](#9-graph-store-layer)
10. [Caching Architecture](#10-caching-architecture)
11. [Worker Architecture](#11-worker-architecture)
12. [API Surface](#12-api-surface)
13. [Query & Retrieval Integration](#13-query--retrieval-integration)
14. [Runtime Agent Integration (KB-as-Tool)](#14-runtime-agent-integration-kb-as-tool)
15. [Studio UI Integration](#15-studio-ui-integration)
16. [Multi-Tenancy & Security](#16-multi-tenancy--security)
17. [Infrastructure & Configuration](#17-infrastructure--configuration)
18. [Test Coverage](#18-test-coverage)
19. [Known Gaps & Future Work](#19-known-gaps--future-work)
20. [File Reference](#20-file-reference)

---

## 1. Executive Summary

The Knowledge Graph (KG) subsystem adds **domain-aware entity extraction and product disambiguation** to SearchAI's vector search pipeline. Instead of treating all entities as generic text, the KG:

- **Classifies documents by product scope** using taxonomy-driven LLM classification
- **Extracts entities scoped to product type** (only attributes applicable to the document's product)
- **Stores relationships in Neo4j** for graph traversal and disambiguation
- **Writes facet data to ClickHouse** for fast Browse SDK aggregation queries
- **Augments vector search metadata** so downstream retrieval benefits from structured knowledge

The system operates as a **background enrichment layer** — it runs after the main ingestion pipeline completes and augments existing documents without disrupting core search.

### Current Maturity: ALPHA

| Phase                        | Status         | Description                                                       |
| ---------------------------- | -------------- | ----------------------------------------------------------------- |
| Phase 1: Entity Graph        | ✅ Done        | Generic entity extraction, co-occurrence, Neo4j storage           |
| Phase 2: Taxonomy Graph      | ✅ Done        | Domain-aware taxonomy, document classification, scoped extraction |
| Phase 3: KG Enrichment       | ✅ Done        | Background worker, multi-store writes, novel discovery            |
| Phase 4: Graph Retrieval API | ❌ Not Started | Graph-augmented search, entity-centric queries                    |
| Phase 5: Entity Resolution   | ❌ Not Started | Dedup across documents, cross-index linking                       |

---

## 2. The Problem We Solved

### Why Generic Knowledge Graphs Fail for Enterprise

When building knowledge graphs from enterprise document corpora, **similar but distinct products get incorrectly linked**, causing false relationships that destroy query accuracy.

**Real-World Example (Banking):**

```
User asks: "What is the interest rate on my debit card?"

Wrong Answer (generic KG):  Shows credit card APR (15-30%)
Right Answer (domain-aware): "Debit cards don't have interest rates.
                              They withdraw directly from your account."
```

**Root Causes:**

1. Both "credit card" and "debit card" contain "card" — embeddings treat them as related
2. Co-occurrence analysis links them because they appear in the same banking corpus
3. No product taxonomy → treats all "cards" as equivalent
4. No attribute scoping → doesn't know "interest_rate" only applies to credit cards
5. No department boundaries → links products across unrelated divisions

**Impact:** Enterprise customers with 10K+ documents report 30-40% irrelevant results in product-scoped queries. Banks, insurance companies, and healthcare orgs cannot deploy SearchAI for regulated product documentation where disambiguation is mandatory.

### Our Solution: Domain-Aware Knowledge Graph

```
┌─────────────────────────────────────────────────────────────────┐
│                  GENERIC APPROACH (fails)                        │
│                                                                  │
│  Document → Extract ALL entities → Link by co-occurrence         │
│  Result: "debit card" ←→ "credit card" (WRONG RELATIONSHIP)     │
└─────────────────────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────────────────────┐
│              DOMAIN-AWARE APPROACH (our solution)                │
│                                                                  │
│  1. Load Taxonomy:    Banking > Cards > Credit Card              │
│                                       > Debit Card               │
│  2. Classify Doc:     "This doc is about Credit Cards" (LLM)     │
│  3. Scoped Extract:   Only extract Credit Card attributes        │
│  4. Build Graph:      interest_rate → BELONGS_TO → Credit Card   │
│  5. Department Fence: Credit Card EXCLUDES Debit Card            │
│                                                                  │
│  Result: "debit card interest rate" → "Debit cards don't have    │
│          interest rates" (CORRECT DISAMBIGUATION)                │
└─────────────────────────────────────────────────────────────────┘
```

---

## 3. Architecture Overview

### System Context Diagram

```
                        ┌───────────────────────────────────────────────────┐
                        │                    Studio UI                       │
                        │  KG Tab · Taxonomy Config · Enrichment Trigger     │
                        └──────────┬────────────────────────┬───────────────┘
                                   │ REST                    │ REST
                        ┌──────────▼────────────┐  ┌────────▼──────────────┐
                        │   search-ai (3005)     │  │ search-ai-runtime     │
                        │   ENGINE               │  │ (3004) QUERY RUNTIME  │
                        │                        │  │                       │
                        │  ┌──────────────────┐  │  │  ┌─────────────────┐  │
                        │  │ kg-taxonomy.ts    │  │  │  │ QueryPipeline   │  │
                        │  │ kg-enrichment.ts  │  │  │  │ Browse Routes   │  │
                        │  │ knowledge-bases.ts│  │  │  │ Discovery API   │  │
                        │  └────────┬─────────┘  │  │  └────────┬────────┘  │
                        │           │            │  │           │           │
                        │  ┌────────▼─────────┐  │  │  ┌────────▼────────┐  │
                        │  │ Services         │  │  │  │ TaxonomyCache   │  │
                        │  │ · Classifier     │  │  │  │ Reader (Redis)  │  │
                        │  │ · Extractor      │  │  │  │ FacetQuery      │  │
                        │  │ · TaxonomyGraph  │  │  │  │ (ClickHouse)    │  │
                        │  │ · NovelValidator │  │  │  └─────────────────┘  │
                        │  └────────┬─────────┘  │  └───────────────────────┘
                        │           │            │
                        │  ┌────────▼─────────┐  │
                        │  │ BullMQ Workers   │  │    ┌────────────────────┐
                        │  │ · taxonomy-setup │  │    │  runtime (3112)    │
                        │  │ · kg-enrichment  │  │    │  AGENT PLATFORM    │
                        │  └────────┬─────────┘  │    │                    │
                        └───────────┼────────────┘    │  KB-as-Tool        │
                                    │                  │  SearchAIKBTool    │
                   ┌────────────────┼─────────────┐   │  Executor          │
                   │                │              │   └────────────────────┘
            ┌──────▼──────┐ ┌──────▼──────┐ ┌────▼─────┐ ┌────────────┐
            │  MongoDB     │ │   Neo4j     │ │ClickHouse│ │   Redis    │
            │              │ │             │ │          │ │            │
            │ · Taxonomy   │ │ · Domain    │ │ · Entity │ │ · BullMQ   │
            │ · Domains    │ │ · Category  │ │   facets │ │   queues   │
            │ · Documents  │ │ · Product   │ │          │ │ · Taxonomy │
            │ · Attributes │ │ · Attribute │ │          │ │   cache    │
            │ · MergeEvents│ │ · Entity    │ │          │ │ · Pub/Sub  │
            │              │ │ · Relations │ │          │ │            │
            └──────────────┘ └─────────────┘ └──────────┘ └────────────┘
```

### Data Flow: End-to-End KG Enrichment

```
Step 1: TAXONOMY SETUP (one-time per index)
═══════════════════════════════════════════

  Admin provides:
    - Domain definition (built-in or custom LLM-generated)
    - Organization profile (optional, LLM-parsed from website)

  Studio → POST /api/indexes/:indexId/kg-taxonomy/setup
         → BullMQ: taxonomy-setup queue
         → TaxonomyLoaderService.loadDomainDefinitions()
         → OrgProfileGenerator (if URL provided)
         → CustomDomainGenerator (if no built-in match)
         → MongoDB: KnowledgeGraphTaxonomy + KnowledgeGraphDomain
         → Neo4j: Domain → Category → Product → Attribute nodes
         → Redis: taxonomy:cache:* (30min TTL) + pub/sub invalidation


Step 2: KG ENRICHMENT (per-index, batch background job)
═══════════════════════════════════════════════════════

  Admin triggers:
    POST /api/indexes/:indexId/kg-enrich
    Options: { batchSize, forceReclassify, retrySkipped, uploadedAfter }

  BullMQ: kg-enrichment queue
  │
  ├─ For each document (cursor-based, batch of 50):
  │   │
  │   ├─ Step 1: CLASSIFY DOCUMENT
  │   │   DocumentClassifierService.classifyDocument()
  │   │   Input:  document summary (from prior ingestion)
  │   │   Model:  Haiku ($0.0002/doc) → Sonnet escalation if confidence < 0.8
  │   │   Output: { primaryProduct, confidence, department, category }
  │   │
  │   ├─ Per chunk (inner loop):
  │   │   │
  │   │   ├─ Step 2: EXTRACT ENTITIES
  │   │   │   EntityExtractorService.extractEntities()
  │   │   │   Method: Hybrid (regex primary → LLM fallback)
  │   │   │   Scope:  Only attributes applicable to document's product type
  │   │   │   Output: IEntityExtraction[] per chunk
  │   │   │   Write:  MongoDB chunk.metadata.entities + chunk.metadata.kgState
  │   │   │
  │   │   ├─ Step 4: UPDATE VECTOR METADATA (per chunk)
  │   │   │   VectorStore.upsert() — preserves original embedding vector
  │   │   │   Sets: canonical.custom.kg = { primaryProduct, secondaryProducts, confidence, department, category, kgEnriched, kgEnrichedAt }
  │   │   │
  │   │   └─ Step 5: DEDUPLICATE ENTITIES (accumulate)
  │   │       Map<"type:normalizedValue", IEntityInstance>
  │   │       Merge chunkIds across occurrences within this document
  │   │
  │   ├─ After all chunks (per document):
  │   │   │
  │   │   ├─ Step 5.5: DISCOVER NOVEL ATTRIBUTES
  │   │   │   LLM extraction finds unknown attributes → NovelCandidate
  │   │   │   validateNovelCandidate() → AttributeRegistry (tier: 'novel')
  │   │   │   Fail-open: errors don't block enrichment
  │   │   │
  │   │   ├─ Step 6: WRITE TO NEO4J (entity instances only)
  │   │   │   TaxonomyGraphService.batchUpsertEntityInstances()
  │   │   │   Cypher UNWIND for batch efficiency
  │   │   │   Relationships: INSTANCE_OF → Attribute, FOUND_IN_PRODUCT → Product
  │   │   │   Entity ID: "attributeId:normalizedValue" (deduplicated across docs)
  │   │   │   documentCount incremented on each occurrence
  │   │   │
  │   │   ├─ Step 6.5: WRITE TO CLICKHOUSE
  │   │   │   ClickHouseEntityStore.writeEntityInstances()
  │   │   │   BufferedWriter (batch 10K, flush 5s)
  │   │   │   DELETE-before-INSERT for re-enrichment safety
  │   │   │
  │   │   └─ Step 7: UPDATE MONGODB DOCUMENT
  │   │       Write classification + entityInstances + kgState to document
  │   │       kgState.status = 'ENRICHED'
  │   │
  │   └─ On error: mark document kgState.status = 'NOT_ENRICHED' with lastError
  │
  └─ Return stats: { documentsClassified, chunksEnriched, entitiesExtracted,
                      entityInstancesUpserted, llmCallsMade, vectorDbUpdates }


Step 3: QUERY-TIME USAGE (automatic, no user action)
════════════════════════════════════════════════════

  Query comes in → QueryPipeline → OpenSearch
  Vector search uses KG metadata in filters/boost
  Browse SDK reads from ClickHouse (facet queries)
  Runtime taxonomy reads from Redis cache
```

### Key Design Decisions

| #    | Decision                | Chose                                  | Over                   | Rationale                                                        |
| ---- | ----------------------- | -------------------------------------- | ---------------------- | ---------------------------------------------------------------- |
| D-1  | Graph storage           | Neo4j                                  | MongoDB graph patterns | True graph DB for traversal; MERGE for idempotent upserts        |
| D-2  | Tenant isolation        | Property-based (tenantId on all nodes) | Database-per-tenant    | Hundreds of DBs is operationally prohibitive                     |
| D-3  | Classification level    | Document-level                         | Chunk-level            | 10x cost reduction; documents have coherent product scope        |
| D-4  | Classification model    | Haiku primary, Sonnet escalation       | Sonnet for all         | $0.0002/doc vs $0.003/doc; escalate only when confidence < 0.8   |
| D-5  | Entity extraction       | Hybrid (regex + LLM)                   | LLM-only               | Regex is free and fast for known patterns; LLM for complex types |
| D-6  | Enrichment timing       | Post-ingestion background job          | Inline pipeline stage  | Decouples KG from core pipeline; no ingestion latency impact     |
| D-7  | Facet storage           | ClickHouse (dual-write)                | Neo4j aggregation      | Columnar storage for fast GROUP BY; Neo4j aggregation is slow    |
| D-8  | Re-enrichment safety    | DELETE-before-INSERT in ClickHouse     | Upsert                 | Prevents ghost rows from schema changes                          |
| D-9  | Novel attribute storage | Fail-open (try/catch)                  | Fail-closed            | Don't block enrichment for experimental discovery                |
| D-10 | Taxonomy caching        | Redis + pub/sub + LRU                  | Direct MongoDB reads   | 5min LRU + 30min Redis TTL; pub/sub for real-time invalidation   |

---

## 4. Data Model & Storage

### Four-Store Architecture

The KG writes to four storage systems, each optimized for a different access pattern:

```
┌─────────────────────────────────────────────────────────────────┐
│                         DATA STORES                              │
├─────────────┬──────────────┬──────────────┬─────────────────────┤
│  MongoDB    │   Neo4j      │  ClickHouse  │  Vector DB          │
│  (truth)    │   (graph)    │  (analytics) │  (search)           │
├─────────────┼──────────────┼──────────────┼─────────────────────┤
│ Taxonomy    │ Taxonomy     │ Entity       │ Chunk embeddings    │
│ definition  │ hierarchy:   │ instances    │ with KG metadata    │
│             │ Domain →     │ (facets)     │ in canonical.       │
│ Document    │ Category →   │              │ custom.kg           │
│ classifica- │ Product →    │              │                     │
│ tion state  │ Attribute    │              │                     │
│             │              │              │                     │
│ Entity      │ Entity       │              │                     │
│ instances   │ instance     │              │                     │
│ (per doc)   │ nodes (dedup)│              │                     │
│             │              │              │                     │
│ Attribute   │ Department   │              │                     │
│ registry    │ boundaries   │              │                     │
│ (novel)     │ (EXCLUDES)   │              │                     │
├─────────────┼──────────────┼──────────────┼─────────────────────┤
│ READ/WRITE  │ TRAVERSAL    │ AGGREGATION  │ SIMILARITY SEARCH   │
│ Source of   │ Graph queries│ Facet counts │ Vector + metadata   │
│ truth       │ Pathfinding  │ Browse SDK   │ filtering           │
└─────────────┴──────────────┴──────────────┴─────────────────────┘
```

### MongoDB Models

#### KnowledgeGraphTaxonomy

```
File: packages/database/src/models/knowledge-graph-taxonomy.model.ts
Database: searchaicontent (registered via ModelRegistry)
Collection: knowledge_graph_taxonomies
```

```typescript
interface IKnowledgeGraphTaxonomy {
  tenantId: string;
  indexId: string;
  version: number;                          // Current version (increments on update)
  domains: string[];                        // Domain IDs referenced
  customDomainFiles: string[];              // Paths to custom domain files
  organizationProfileFile?: string;         // Path to org profile file (string, not object)
  taxonomy: {
    domain: { id: string; name: string; version: number }; // Domain metadata
    domainSources: string[];                // Where domain definitions came from
    categories: IKGCategory[];              // Category definitions
    products: IKGProduct[];                 // Product definitions
    attributes: IKGAttribute[];             // Attribute definitions with extraction rules
    departmentBoundaries: IDepartmentBoundary[]; // EXCLUDES rules
  };
  previousVersions: Array<{                // Full snapshots for rollback
    version: number;
    taxonomy: {...};
    refinementAction: string;
    rollbackReason?: string;
  }>;
  // Indexes: { tenantId: 1, indexId: 1 } UNIQUE
}
```

#### KnowledgeGraphDomain

```
File: packages/database/src/models/knowledge-graph-domain.model.ts
Database: searchaicontent (registered via ModelRegistry)
Collection: knowledge_graph_domains
```

```typescript
interface IKnowledgeGraphDomain {
  tenantId: string;
  name: string; // e.g., "financial-services"
  version: number; // Domain definition version
  industry: string; // e.g., "Financial Services"
  categories: Array<{
    id: string;
    name: string;
    department: string;
    subDepartment?: string;
    products: Array<{
      id: string;
      name: string;
      disambiguationKeywords: string[]; // Terms that differentiate this product
      organizationSpecificNames: string[]; // Customer-specific product names
      attributes: Array<{
        id: string;
        name: string;
        dataType: 'string' | 'number' | 'percentage' | 'currency' | 'date' | 'boolean';
        extraction: {
          method: 'regex' | 'llm' | 'hybrid';
          patterns?: string[]; // Regex patterns for extraction
          keywords?: string[]; // Keywords that signal this attribute
        };
      }>;
    }>;
  }>;
  departmentBoundaries: IDepartmentBoundary[]; // EXCLUDES rules at domain level
  createdBy: string; // User who created/imported
  // Indexes: { tenantId: 1, name: 1 } UNIQUE, { tenantId: 1, createdAt: -1 }
}
```

#### SearchDocument KG Fields

```
File: packages/database/src/models/search-document.model.ts
Database: searchaicontent (via ModelRegistry)
```

```typescript
// Added to ISearchDocument:
interface IDocumentClassification {
  productScope: {
    primaryProduct: string; // e.g., "credit_card"
    confidence: number; // 0.0 - 1.0
    secondaryProducts: string[]; // Other products mentioned
  };
  department: string; // e.g., "Retail Banking"
  subDepartment?: string;
  category: string; // e.g., "lending"
  classifiedAt: Date;
  classificationMethod: 'llm'; // Only 'llm' is produced in practice
  model: string; // e.g., "claude-3-5-haiku-20241022"
  escalatedToSonnet: boolean; // Whether confidence was too low for Haiku
}

interface IDocumentKGState {
  status: 'NOT_ENRICHED' | 'ENRICHED' | 'SKIPPED' | 'NEEDS_RECLASSIFICATION';
  enrichedAt?: Date;
  skippedReason?: 'NO_TAXONOMY' | 'KG_DISABLED';
  taxonomyVersion?: string; // Enables re-enrichment when taxonomy changes
  needsReclassification: boolean;
}

interface IEntityInstance {
  entityInstanceId: string; // Format: "attributeId:normalizedValue"
  type: string; // Attribute type name
  rawValue: string; // Original text from document
  normalizedValue: string | number | boolean; // Normalized for comparison
  chunkIds: string[]; // Which chunks contain this entity
}

// MongoDB Indexes (sparse, KG-specific):
// { tenantId: 1, indexId: 1, 'metadata.kgState.status': 1 }
// { tenantId: 1, indexId: 1, 'metadata.kgState.needsReclassification': 1, 'metadata.kgState.taxonomyVersion': 1 }
// { tenantId: 1, indexId: 1, 'classification.productScope.primaryProduct': 1 }
// { tenantId: 1, indexId: 1, 'classification.department': 1, 'classification.category': 1 }
// { tenantId: 1, indexId: 1, 'entityInstances.entityInstanceId': 1 }
```

#### AttributeRegistry

```
File: packages/database/src/models/attribute-registry.model.ts
Database: searchaicontent
```

```typescript
interface IAttributeRegistry {
  tenantId: string;
  indexId: string;
  attributeId: string; // Unique attribute identifier
  productScope: string; // Product type this applies to
  displayName: string; // Human-readable name
  definition: string; // What this attribute means
  dataType: string; // e.g., 'percentage', 'currency'
  aliases: string[]; // Alternative names
  extractionPatterns: string[]; // Regex patterns for extraction
  typicalRange?: string; // Expected value range
  tier: 'permanent' | 'approved' | 'beta' | 'novel' | 'discarded';
  confidence: number; // Running confidence score
  discoverySource: 'domain_definition' | 'llm_extraction' | 'admin_manual';
  documentCount: number; // How many docs contain this attribute
  firstSeenAt: Date;
  lastSeenAt: Date;
  lastReconciledAt?: Date; // Last merge/dedup operation
  uniqueUsers?: number; // Distinct users who triggered extraction
  totalInteractions?: number; // Total extraction events
}
// Tier progression: novel → beta → approved → permanent
// 'discarded' is a dead end for auto-promotion; only admin manual can resurrect
```

#### TaxonomyHealthCache

```
File: packages/database/src/models/taxonomy-health-cache.model.ts
Database: searchaicontent
TTL: 1 hour (auto-expiry)
```

Cached quality signals for a health dashboard: coverage percentages, attribute utilization, classification confidence distributions.

#### AttributeMergeEvent

```
File: packages/database/src/models/attribute-merge-event.model.ts
Database: searchaicontent
```

Audit log for when duplicate attributes are reconciled (e.g., "interest rate" and "Interest Rate" merged).

### Neo4j Graph Model — Taxonomy Graph

The taxonomy graph stores the taxonomy hierarchy and deduplicated entity instances.
Document and Chunk nodes are **not** stored in the taxonomy graph — document classification
data lives in MongoDB. This keeps the graph lean and focused on relationships that benefit
from graph traversal.

A separate **permission graph** (in `packages/search-ai-internal/src/permissions/`) manages
its own `:Document` nodes in the same Neo4j database for access-control queries.

```
Node Labels & Properties:
═════════════════════════

  Domain { id, name, tenantId, indexId }
    │
    ├──[:HAS_CATEGORY]──► Category { id, name, department, tenantId, indexId }
    │                        │
    │                        ├──[:HAS_PRODUCT]──► Product { id, name, categoryId, department, subDepartment, disambiguationKeywords, organizationSpecificNames?, tenantId, indexId }
    │                        │                      │
    │                        │                      ├──[:HAS_ATTRIBUTE]──► Attribute { id, name, dataType, tenantId, indexId }
    │                        │                      │
    │                        │                      └──[:FOUND_IN_PRODUCT]──◄ EntityInstance
    │                        │
    │                        └──[:EXCLUDES { reason }]──► Product (different product)
    │
    └── ...

  EntityInstance { id, attributeId, rawValue, normalizedValue, documentCount,
                   firstSeenAt, lastSeenAt, tenantId, indexId }
    ├──[:INSTANCE_OF]──► Attribute     (what type of entity)
    └──[:FOUND_IN_PRODUCT]──► Product  (product scope)

  Entity ID format: "attributeId:normalizedValue"
  Multiple documents with the same entity value share ONE EntityInstance node.
  documentCount tracks how many documents contain that value.


Relationship Types:
═══════════════════
  HAS_CATEGORY     Domain → Category
  HAS_PRODUCT      Category → Product
  HAS_ATTRIBUTE    Product → Attribute
  INSTANCE_OF      EntityInstance → Attribute (what type of entity)
  FOUND_IN_PRODUCT EntityInstance → Product   (product scope)
  EXCLUDES         Product → Product          (department boundary fence)


Uniqueness Constraints (created on connect):
═══════════════════════════════════════════
  Domain(tenantId, indexId, id)
  Category(tenantId, indexId, id)
  Product(tenantId, indexId, id)
  Attribute(tenantId, indexId, id)
  EntityInstance(tenantId, indexId, id)

Lookup Indexes:
═══════════════
  EntityInstance.normalizedValue
  Domain(tenantId, indexId)
  Product(tenantId, indexId)
```

### ClickHouse Table

```
File: packages/database/src/clickhouse-schemas/init.ts (lines 771-796)
Table: abl_platform.entity_instances
Engine: ReplicatedReplacingMergeTree
```

```sql
CREATE TABLE abl_platform.entity_instances (
  tenant_id      String,
  index_id       String,
  document_id    String,
  chunk_id       String,
  attribute_type String,
  product_type   String,
  data_type      String,
  raw_value      String,
  normalized_value String,
  enriched_at    DateTime,
  taxonomy_version String
)
ENGINE = ReplicatedReplacingMergeTree
ORDER BY (tenant_id, index_id, product_type, attribute_type, document_id, chunk_id)
-- Bloom filter index on document_id
-- Set index on attribute_type
```

**Usage:** Browse SDK facet queries (count entities by product/attribute, enumerate facet values).

**Write pattern:** `BufferedClickHouseWriter` — batch 10K rows, flush every 5s, max 3 retries. On re-enrichment: DELETE rows for document first, then INSERT new rows (prevents ghost data from schema changes).

---

## 5. Taxonomy System

### Hierarchy

```
Domain (e.g., "financial-services")
  └── Category (e.g., "lending")
        ├── department: "Retail Banking"
        ├── subDepartment: "Consumer Lending"
        └── Product (e.g., "credit_card")
              ├── disambiguationKeywords: ["credit limit", "APR", "billing cycle"]
              ├── organizationSpecificNames: ["Platinum Card", "Rewards Card"]
              └── Attribute (e.g., "interest_rate")
                    ├── dataType: "percentage"
                    ├── extraction.method: "regex"
                    ├── extraction.patterns: ["\\d+\\.?\\d*\\s*%\\s*(?:APR|annual)"]
                    └── extraction.keywords: ["interest rate", "APR", "annual percentage"]

Department Boundary (EXCLUDES rule):
  Product "credit_card" EXCLUDES Product "debit_card"
  Reason: "Credit cards have interest rates and credit limits; debit cards
           withdraw directly from checking accounts. They share the word
           'card' but are fundamentally different financial products."
```

### Domain Sources

| Source               | Description                                          | File Location                  |
| -------------------- | ---------------------------------------------------- | ------------------------------ |
| Built-in domains     | Pre-configured for 5 industries (JSON runtime files) | `apps/search-ai/data/domains/` |
| Custom LLM domains   | Generated from org profile via LLM                   | `CustomDomainGenerator`        |
| Organization profile | LLM-parsed from customer website URL                 | `OrgProfileGenerator`          |

### Taxonomy Setup Flow

```
File: apps/search-ai/src/workers/taxonomy-setup-worker.ts
Queue: taxonomy-setup (concurrency: 1, LLM-intensive)
```

```
1. TaxonomyLoaderService.loadDomainDefinitions(paths)
   → Reads domain YAML/JSON files
   → Merges with organization profile (if provided)
   → Produces unified taxonomy definition

2. OrgProfileGenerator (if URL provided)
   → Fetches company website (SSRF-protected, circuit breaker)
   → LLM extracts: company name, industry, products, terminology
   → Enriches taxonomy with org-specific names and keywords

3. CustomDomainGenerator (if no built-in match)
   → LLM generates custom domain definition from org profile
   → Creates KnowledgeGraphDomain in MongoDB

4. MongoDB: Store KnowledgeGraphTaxonomy
   → Version incremented
   → Previous version pushed to previousVersions[]

5. Neo4j: TaxonomyGraphService.createTaxonomyGraph()
   → UNWIND per node type (categories, products, attributes)
   → Creates full graph in single transaction
   → EXCLUDES relationships for department boundaries

6. Redis: TaxonomyCacheWriter
   → Writes taxonomy JSON to Redis (TTL 30min)
   → Publishes invalidation on taxonomy:invalidate channel
```

### Taxonomy Versioning & Rollback

```typescript
// Taxonomy version lifecycle:
// v1: Initial setup from domain definition
// v2: Refined after first enrichment round (added org-specific names)
// v3: Rolled back to v1 (admin found v2 too aggressive)

taxonomy.previousVersions = [
  { version: 1, taxonomy: {...}, refinementAction: 'initial_setup' },
  { version: 2, taxonomy: {...}, refinementAction: 'org_profile_merge',
    rollbackReason: 'Too many false positives in debit card classification' }
];
taxonomy.version = 1; // After rollback
```

---

## 6. Document Classification

```
File: apps/search-ai/src/services/document-classifier.service.ts
```

### How It Works

Classification happens at **document level** (not chunk level) using existing document summaries — zero additional extraction cost.

```
Input:  Document summary (generated during ingestion pipeline)
        + Taxonomy definition (products, categories, departments)

Model:  Claude Haiku (primary) — $0.0002/doc, ~500ms
        Claude Sonnet (escalation) — $0.003/doc, ~2s
        Escalation trigger: Haiku confidence < 0.8

Output: ClassificationResult {    // Note: local type in classifier service, not IDocumentClassification
          productScope: {
            primaryProduct: "credit_card",
            confidence: 0.92,
            secondaryProducts: ["rewards_program"]
          },
          department: "Retail Banking",
          category: "cards",
          classificationMethod: "llm",
          model: "claude-3-5-haiku-20241022",
          escalatedToSonnet: false
        }
```

### Cost Model

```
1,000 documents:
  Haiku only (80% confident):     $0.20
  20% escalate to Sonnet:         $0.60
  Total:                          $0.80 (vs $3.00 for all-Sonnet)

10,000 documents:                 ~$8.00
```

### Classification Storage

After classification, the enrichment worker writes the result to **MongoDB only**:

```typescript
// Written to SearchDocument.classification (MongoDB)
{
  productScope: { primaryProduct: "credit_card", confidence: 0.92, secondaryProducts: [] },
  department: "Retail Banking",
  category: "cards",
  classifiedAt: new Date(),
  classificationMethod: "llm",
  model: "claude-3-5-haiku-20241022",
  escalatedToSonnet: false
}
```

Document classification is not stored in Neo4j. The taxonomy graph only stores the taxonomy
hierarchy and deduplicated entity instances. All document listing, filtering, and stats are
served from MongoDB.

---

## 7. Entity Extraction Pipeline

```
File: apps/search-ai/src/services/entity-extractor.service.ts
```

### Extraction Architecture

There are two independent extraction codebases:

**1. `EntityExtractorService` (production — used by kg-enrichment-worker):**

The service has its own built-in regex+LLM hybrid logic. It does NOT use the strategy classes below.

```typescript
// apps/search-ai/src/services/entity-extractor.service.ts
class EntityExtractorService {
  private enableRegex = true; // Regex extraction (free, fast)
  private enableLLM = true; // LLM extraction (costly, accurate)
  // Both enabled = hybrid mode (default)

  // Safety limits:
  static REGEX_TIMEOUT_MS = 100; // Max time per regex pattern
  static MAX_MATCHES_PER_PATTERN = 50; // Cap matches to prevent runaway

  extractEntities(chunkText, taxonomy, productType): Promise<ExtractionResult>;
  getApplicableAttributes(taxonomy, productType): IKGAttribute[]; // Scoping
}
```

`EntityExtractorService` is the sole production entity extraction implementation.
There are no alternative strategy classes — all extraction uses its built-in hybrid regex+LLM logic.

### Scoped Extraction

The critical innovation: **extraction is scoped to the document's classified product type**.

```
Document classified as: "credit_card"

Applicable attributes (extract these):
  ✅ interest_rate (applies to credit_card)
  ✅ credit_limit (applies to credit_card)
  ✅ annual_fee (applies to credit_card)

Excluded attributes (skip these):
  ❌ overdraft_limit (applies to checking_account only)
  ❌ loan_term (applies to personal_loan only)
  ❌ atm_withdrawal_limit (applies to debit_card only)
```

This prevents false entity extraction — a credit card document won't have "ATM withdrawal limit" entities even if the text mentions ATMs.

### Extraction Output

```typescript
interface IEntityExtraction {
  type: string; // Attribute type: "interest_rate"
  name: string; // Display name: "Interest Rate"
  dataType: string; // "percentage"
  rawValue: string; // "15.99% APR"
  normalizedValue: string | number | boolean; // 0.1599 (percentage normalized)
  productType: string; // "credit_card" (scoped)
  context: {
    chunkScope: string; // Product type scope
    inScopeMatch: boolean; // Whether match is within document's product scope
    attributeApplicable: boolean; // Whether attribute applies to product
  };
}
```

### Deduplication

Within a document, the same entity may appear in multiple chunks. The enrichment worker deduplicates:

```typescript
// Key: "interest_rate:15.99"
const entityMap = new Map<string, IEntityInstance>();

for (const chunk of document.chunks) {
  for (const entity of chunk.entities) {
    const key = `${entity.type}:${entity.normalizedValue}`;
    if (entityMap.has(key)) {
      // Merge chunkIds
      entityMap.get(key).chunkIds.push(chunk.id);
    } else {
      entityMap.set(key, {
        entityInstanceId: key,
        type: entity.type,
        rawValue: entity.rawValue,
        normalizedValue: entity.normalizedValue,
        chunkIds: [chunk.id],
      });
    }
  }
}
// Result: document.entityInstances = Array.from(entityMap.values())
```

---

## 8. Novel Attribute Discovery

```
File: apps/search-ai/src/services/novel-candidate-validator.ts
File: apps/search-ai/src/workers/kg-enrichment-worker.ts (Step 5.5)
```

### How It Works

During LLM-based extraction, the model sometimes discovers attributes not in the taxonomy. These are **novel candidates**.

```
Taxonomy has:    interest_rate, credit_limit, annual_fee
LLM extracts:   interest_rate: 15.99%, late_payment_fee: $39   ← NOVEL!

Novel candidate:
  name: "late_payment_fee"
  definition: "Fee charged when minimum payment is not received by due date"
  dataType: "currency"
  rawValue: "$39"
  confidence: 0.87
  productType: "credit_card"
```

### Validation & Tier Progression

```
1. validateNovelCandidate() filters:
   - Name not empty, not a stopword
   - Definition present and meaningful
   - DataType valid
   - Not already in taxonomy (avoid duplicates)

2. AttributeRegistry upsert (two-phase, race-condition safe):
   Phase 1: $setOnInsert + $set + $inc (first-seen fields, increment count)
   Phase 2: Conditional updateOne with $or query (only update if new
            confidence exceeds stored confidence — NOT $max operator)

3. Tier progression over time:
   novel (0-10 occurrences)
     → beta (10-50 occurrences, admin review)
       → approved (admin promoted)
         → permanent (integrated into taxonomy)

   OR: discarded (admin rejected, but may be re-discovered)
```

### Sampling Strategy

Novel discovery is computationally expensive (requires LLM extraction). The system samples:

- **30% of chunks** where regex already found known entities
- This biases toward chunks with rich content (more likely to have novel entities too)
- Configurable via enrichment options

---

## 9. Graph Store Layer

### Abstract Interface

```
File: apps/search-ai/src/stores/graph-store.ts
```

```typescript
interface GraphStore {
  addEntity(entity: EntityNode): Promise<void>;
  addRelationship(edge: RelationshipEdge): Promise<void>;
  getEntity(id: string): Promise<EntityNode | null>;
  getRelationships(entityId: string): Promise<RelationshipEdge[]>;
  getRelatedEntities(entityId: string, depth?: number): Promise<RelatedEntity[]>;
  getStats(): Promise<GraphStats>;
  clear(): Promise<void>;
}

// Only InMemoryGraphStore implemented (for testing)
// Production uses TaxonomyGraphService directly (Neo4j)
```

### TaxonomyGraphService (Production Graph)

```
File: apps/search-ai/src/services/knowledge-graph/taxonomy-graph.service.ts
Lines: 1-782
```

The real production graph operations bypass the abstract `GraphStore` interface and use Neo4j directly via `neo4j-driver`.

**Key Methods:**

| Method                             | What It Does                                  | Neo4j Operations                                                  |
| ---------------------------------- | --------------------------------------------- | ----------------------------------------------------------------- |
| `connect()`                        | Initialize driver, create constraints/indexes | CREATE CONSTRAINT, CREATE INDEX                                   |
| `close()`                          | Close Neo4j driver and clean up connection    | driver.close()                                                    |
| `createTaxonomyGraph()`            | Build full taxonomy from definition           | UNWIND + MERGE per node type                                      |
| `batchUpsertEntityInstances()`     | Write deduplicated entity instances in batch  | UNWIND + MERGE for EntityInstance + INSTANCE_OF, FOUND_IN_PRODUCT |
| `upsertEntityInstance()`           | Write single deduplicated entity instance     | MERGE EntityInstance + relationships                              |
| `getTopEntityInstancesByProduct()` | Query top entities for a product by doc count | MATCH (p:Product)←[:FOUND_IN_PRODUCT]-(e:EntityInstance)          |
| `getTaxonomyGraphStructure()`      | Full taxonomy tree for visualization          | MATCH Domain→Category→Product→Attribute paths                     |
| `getProductsByCategory()`          | List products under a category                | MATCH (c:Category)-[:HAS_PRODUCT]->(p:Product)                    |
| `getAttributesForProduct()`        | List attributes for a product                 | MATCH (p:Product)-[:HAS_ATTRIBUTE]->(a:Attribute)                 |
| `getTaxonomyStats()`               | Count nodes by type                           | CALL subqueries per node label                                    |
| `getEntityCountsByProduct()`       | Count EntityInstances per Product             | MATCH (p:Product)←[:FOUND_IN_PRODUCT]-(e:EntityInstance) COUNT    |
| `getAttributeSummaries()`          | Aggregate unique values & top-5 per Attribute | MATCH (a:Attribute)←[:INSTANCE_OF]-(e:EntityInstance) COLLECT     |
| `deleteTaxonomyGraph()`            | Clean up index graph data                     | DETACH DELETE with tenantId+indexId filter                        |

> **Singleton lifecycle (since ABLP-681):** Use `getTaxonomyGraphService()` to get the singleton instance.
> `initTaxonomyGraphService()` is called at server startup; `closeTaxonomyGraphService()` at shutdown.
> Do NOT instantiate `new TaxonomyGraphService(config)` directly — the per-request pattern was removed.

---

## 10. Caching Architecture

### Taxonomy Cache (Cross-Service)

```
┌─────────────────────────────┐         ┌─────────────────────────────┐
│  search-ai (Engine)          │         │  search-ai-runtime          │
│                              │         │                             │
│  TaxonomyCacheWriter         │         │  TaxonomyCacheReader        │
│  ├─ writes to Redis          │──Redis──│  ├─ reads from Redis        │
│  │  key: taxonomy:cache:*    │         │  │  fallback: MongoDB       │
│  │  TTL: 30 minutes          │         │  │                          │
│  │                           │         │  ├─ LRU in-process cache    │
│  └─ publishes on:            │──pub/──▶│  │  max: 200 entries        │
│     taxonomy:invalidate      │  sub    │  │  TTL: 5 minutes          │
│                              │         │  │                          │
│  Triggers:                   │         │  └─ Listens on:             │
│  ├─ taxonomy setup complete  │         │     taxonomy:invalidate     │
│  ├─ taxonomy update          │         │     (evicts LRU entry)      │
│  └─ taxonomy delete          │         │                             │
└─────────────────────────────┘         └─────────────────────────────┘

Read path (runtime):
  1. Check LRU cache (5min TTL) → hit? return
  2. Check Redis (30min TTL) → hit? populate LRU, return
  3. Read MongoDB → populate Redis + LRU, return

Write path (engine):
  1. Write to MongoDB (source of truth)
  2. Write to Redis (30min TTL)
  3. Publish invalidation event → runtime evicts LRU

Failure mode: Redis down → TaxonomyCacheReader returns null (fail-open)
             → Browse routes degrade gracefully (no taxonomy-based facets)
```

---

## 11. Worker Architecture

### Worker Registration

```
File: apps/search-ai/src/workers/index.ts
```

| Worker           | Queue Name       | Concurrency                | Lock Duration | Purpose                                           |
| ---------------- | ---------------- | -------------------------- | ------------- | ------------------------------------------------- |
| `taxonomy-setup` | `taxonomy-setup` | 1                          | 5 min         | One-time taxonomy creation (LLM-intensive)        |
| `kg-enrichment`  | `kg-enrichment`  | `floor(concurrency * 0.5)` | 5 min         | Batch document classification + entity extraction |

Both workers are in the "always-started" group (lines 107-113 of workers/index.ts).

### KG Enrichment Worker Detail

```
File: apps/search-ai/src/workers/kg-enrichment-worker.ts
Lines: 1-801
```

**Job Data:**

```typescript
interface KGEnrichmentJobData {
  indexId: string;
  tenantId: string;
  filter?: {
    documentIds?: string[]; // Specific documents
    uploadedAfter?: string; // ISO date
    productType?: string; // Re-enrich specific product
  };
  options?: {
    batchSize?: number; // Default: 50
    forceReclassify?: boolean; // Re-classify already-classified docs
    retrySkipped?: boolean; // Retry previously skipped docs
  };
}
```

**Processing Loop:**

```
For each batch of documents (cursor-based):
  │
  ├─ Filter: documents with summary AND kgState.status != 'ENRICHED'
  │          (unless forceReclassify)
  │
  ├─ Per document:
  │   ├─ Step 1: Classify (DocumentClassifierService)
  │   ├─ Step 2: Extract entities from chunks (EntityExtractorService)
  │   │   └─ Per chunk:
  │   │       ├─ Step 4: Update Vector DB metadata (preserves embedding)
  │   │       └─ Step 5: Deduplicate entities (accumulate into doc-level map)
  │   ├─ Step 5.5: Discover novel attributes → AttributeRegistry (fail-open)
  │   ├─ Step 6: Write Neo4j (deduplicated entity instances + relationships)
  │   ├─ Step 6.5: Write ClickHouse (facet rows, DELETE-before-INSERT)
  │   └─ Step 7: Write MongoDB (classification + entityInstances + kgState)
  │
  └─ Return stats: { documentsClassified, chunksEnriched, entitiesExtracted,
                      entityInstancesUpserted, llmCallsMade, vectorDbUpdates }
```

### Relationship to Main Ingestion Pipeline

```
MAIN INGESTION PIPELINE (always runs):
  ingest → extract → [docling → page-processing] → canonical-map → enrich
                                                                     │
                              ┌──────────────┬──────────────┐────────┤
                              │              │              │        │
                          embedding    multimodal    tree-build  question-synthesis
                                                                 scope-classification

KG ENRICHMENT (separate, triggered manually or by schedule):
  Runs AFTER ingestion completes
  Requires documents to have summaries
  Processes entire indexes in batches
  Does NOT generate new embeddings (preserves existing vectors)
  Only updates vector metadata (canonical.custom.kg)
```

**Key point:** KG enrichment is decoupled from the core ingestion pipeline. It runs as a background job after documents are fully ingested and have summaries. This means:

1. No latency impact on core ingestion
2. Can be re-run after taxonomy changes
3. Can be triggered manually for specific documents
4. Failure doesn't affect search availability

---

## 12. API Surface

### Engine Routes (search-ai :3005)

#### Taxonomy Management

```
File: apps/search-ai/src/routes/kg-taxonomy.ts
Mount: /api/indexes
Auth: createUnifiedAuthMiddleware
```

| Method | Path                                          | Description                                  |
| ------ | --------------------------------------------- | -------------------------------------------- |
| GET    | `/:indexId/kg-configuration-status`           | Check if workspace has LLM configured for KG |
| POST   | `/:indexId/kg-configure-model`                | Configure LLM model for KG operations        |
| POST   | `/:indexId/kg-taxonomy/setup`                 | Trigger one-time taxonomy setup (BullMQ job) |
| GET    | `/:indexId/kg-taxonomy/setup/:jobId`          | Poll taxonomy setup job status               |
| GET    | `/:indexId/kg-taxonomy`                       | Get current taxonomy for index               |
| PUT    | `/:indexId/kg-taxonomy`                       | Update taxonomy definition                   |
| DELETE | `/:indexId/kg-taxonomy`                       | Delete taxonomy and all graph data           |
| PUT    | `/:indexId/kg-toggle`                         | Toggle KG enabled/disabled for index         |
| GET    | `/kg-taxonomy/domains`                        | List all domains (global, no indexId)        |
| GET    | `/kg-taxonomy/domains/:domainId`              | Get domain by ID (global)                    |
| GET    | `/:indexId/kg-taxonomy/domains`               | List domains for index                       |
| GET    | `/:indexId/kg-taxonomy/domains/:domainId`     | Get domain for index                         |
| POST   | `/:indexId/kg-taxonomy/domains`               | Create custom domain                         |
| DELETE | `/:indexId/kg-taxonomy/domains/:domainId`     | Delete domain                                |
| POST   | `/:indexId/kg-taxonomy/domains/generate`      | LLM-generate domain from org profile         |
| POST   | `/:indexId/kg-taxonomy/generate-profile`      | LLM-generate org profile from URL            |
| GET    | `/kg-taxonomy/metrics/org-profile-generation` | Org profile generation metrics               |

#### KG Enrichment

```
File: apps/search-ai/src/routes/kg-enrichment.ts
Mount: /api/indexes
Auth: createUnifiedAuthMiddleware
```

| Method | Path                              | Description                                  |
| ------ | --------------------------------- | -------------------------------------------- |
| POST   | `/:indexId/kg-enrich`             | Trigger enrichment job                       |
| GET    | `/:indexId/kg-enrich/jobs/:jobId` | Get job status + progress                    |
| GET    | `/:indexId/kg-enrich/jobs`        | List enrichment jobs for index               |
| GET    | `/:indexId/kg-enrich/stats`       | Aggregated KG statistics                     |
| GET    | `/:indexId/kg-enrich/documents`   | Classified documents (paginated, filterable) |
| GET    | `/:indexId/kg-enrich/entities`    | Entity distribution by type/product          |
| GET    | `/:indexId/kg-enrich/graph`       | Graph structure for visualization            |

#### Knowledge Base CRUD

```
File: apps/search-ai/src/routes/knowledge-bases.ts
Mount: /api/knowledge-bases (NOT project-scoped in URL path)
Auth: createUnifiedAuthMiddleware
Note: projectId is passed as query param (GET) or body field (POST), not in the URL path.
```

| Method | Path                    | Description                                                           |
| ------ | ----------------------- | --------------------------------------------------------------------- |
| GET    | `/`                     | List KBs (paginated, searchable, sortable)                            |
| POST   | `/`                     | Create KB (auto-creates SearchIndex, CanonicalSchema, Pipeline, Tool) |
| GET    | `/:kbId`                | Get KB with linked index                                              |
| PATCH  | `/:kbId`                | Update name/description                                               |
| DELETE | `/:kbId`                | Cascading delete (chunks → docs → sources → index → KB → tool)        |
| GET    | `/:kbId/health-summary` | Aggregated health metrics                                             |
| GET    | `/:kbId/activity`       | Activity feed from audit logs                                         |

Additional internal routes (not listed above):

- `POST /:kbId/sync-counters` — Recalculate document/chunk counts
- `POST /:kbId/rebuild` — Rebuild KB pipeline (returns 501 — not yet implemented)

### Runtime Routes (search-ai-runtime :3004)

#### Search & Query

```
File: apps/search-ai-runtime/src/routes/query.ts
Mount: /api/search
```

| Method | Path                   | Description                                             |
| ------ | ---------------------- | ------------------------------------------------------- |
| POST   | `/:indexId/query`      | **Unified search** (all 4 query types)                  |
| POST   | `/:indexId/structured` | BM25 + metadata filter search                           |
| POST   | `/:indexId/aggregate`  | Group-by with metrics                                   |
| POST   | `/:indexId/suggest`    | Autocomplete suggestions                                |
| POST   | `/:indexId/similar`    | Find similar documents                                  |
| POST   | `/:indexId/resolve`    | Vocabulary resolution                                   |
| GET    | `/:indexId/discover`   | **Discovery manifest** (self-describing capability API) |

#### Browse SDK (KG-powered)

```
File: apps/search-ai-runtime/src/routes/browse.ts
```

| Method | Path                                               | Description                 |
| ------ | -------------------------------------------------- | --------------------------- |
| GET    | `/:indexId/browse/taxonomy`                        | Browse by taxonomy tree     |
| GET    | `/:indexId/browse/facets`                          | Facet value enumeration     |
| POST   | `/:indexId/browse/facet-counts`                    | Post-search facet counts    |
| GET    | `/:indexId/browse/facets/:attributeType/documents` | Documents for a facet value |

#### Agent Integration

```
File: apps/search-ai-runtime/src/routes/agent-integration.routes.ts
Mount: /api/agent (prefix not shown in paths below)
```

| Method | Path                                               | Description                                       |
| ------ | -------------------------------------------------- | ------------------------------------------------- |
| GET    | `/projects/:projectId/kb/:kbId/query-types`        | Download query classification examples (few-shot) |
| GET    | `/projects/:projectId/kb/:kbId/vocabulary-context` | Download vocabulary + schema for local resolution |

> Full paths are `/api/agent/projects/:projectId/kb/:kbId/...`

---

## 13. Query & Retrieval Integration

### Query Pipeline (search-ai-runtime)

```
File: apps/search-ai-runtime/src/services/query/query-pipeline.ts
```

The QueryPipeline processes user queries through multiple stages. KG metadata enhances search at two points:

```
Stage 0: Permission Filter ──────────────── Security gate (always)
Stage 1: Preprocessing ──────────────────── Spell correction, synonym expansion
Stage 2: Vocabulary Resolution + QType ──── LLM classifies query type
Stage 2.5: Alias Resolution ─────────────── Map aliases to OpenSearch paths
Stage 2.6: Doc-ID Filter ───────────────── Browse SDK facet-to-document scoping ◄── KG DATA
Stage 3: Build + Execute Search ─────────── HybridSearchBuilder → OpenSearch
         ↳ KG metadata in canonical.custom.kg enables filtering by:
           - productScope (e.g., only credit card documents)           ◄── KG DATA
           - department, category
           - entity types and values
Stage 4: Rerank ─────────────────────────── Voyage AI / Cohere / Jina
Stage 5: Metrics & Cost Tracking
```

### Discovery API (Self-Describing Manifest)

```
GET /api/search/:indexId/discover

Response:
{
  "kb": { "name", "description", "documentCount", "lastUpdated" },
  "searchEndpoint": { "url", "method" },
  "capabilities": {
    "queryClassification": {
      "types": ["structured", "semantic", "hybrid", "aggregation"],
      "examples": [...]     // Few-shot for LLM query classification
    },
    "vocabulary": {
      "terms": [
        { "name": "interest rate", "aliases": ["APR", "annual rate"],
          "fieldMapping": "canonical.custom.kg.entities.interest_rate",
          "enumValues": [...] }
      ]
    },
    "filters": {
      "productScope": { "type": "enum", "values": ["credit_card", "debit_card", ...] },
      "department": { "type": "enum", "values": ["Retail Banking", ...] }
    },
    "aggregation": { "functions": ["count", "sum", "avg", "min", "max"] },
    "reranking": { "available": true, "provider": "voyage-ai" },
    "preprocessing": { "spellCorrection": true, "synonymExpansion": true }
  },
  "_meta": { "version": "1.0", "ttl": 300 }
}
```

This manifest is cached for 5 minutes and consumed by the runtime agent integration for tool description building.

---

## 14. Runtime Agent Integration (KB-as-Tool)

### How Agents Use Knowledge Bases

```
File: apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts
```

When a knowledge base is created, it's automatically registered as a tool in the agent platform:

```
KB Created → registerSearchAITool()
           → ProjectTool record: { toolType: 'searchai', name: 'search_kb_{slug}' }
           → Available to all agents in the project
```

When an agent receives a user query:

```
1. Agent sees tool: "search_kb_banking_docs"
   Tool description built from Discovery manifest (vocabulary, filters, query types)

2. Agent decides to call the tool with:
   { query: "credit card interest rate", queryType: "semantic" }

3. SearchAIKBToolExecutor:
   a. Resolves binding (tool name → indexId)
   b. Fetches discovery manifest (cached 5min)
   c. Context-aware query enrichment (uses conversation history via LLM)
   d. Normalizes queryType (handles LLM hallucinations like "phrase" → "hybrid")
   e. Normalizes filters (maps "fileType" → "source_type")
   f. Calls SearchAIClient.unifiedSearch()
   g. Formats results for LLM consumption (strips heavy fields)

4. Agent receives search results → synthesizes answer for user
```

### Tool Description Builder

```
File: apps/runtime/src/services/search-ai/description-builder.ts
```

Converts the Discovery manifest into a text description that the LLM can understand:

```
Tool: search_kb_banking_docs
Description: Search the "Banking Documentation" knowledge base.
Contains 2,847 documents. Last updated: 2026-03-28.

Query Types:
- structured: Use for exact field matching (e.g., "show all credit cards with APR > 20%")
- semantic: Use for conceptual questions (e.g., "how do I apply for a credit card?")
- hybrid: Use when both exact and conceptual matching needed
- aggregation: Use for counts and statistics

Vocabulary:
- "interest rate" (aliases: APR, annual rate) → maps to interest_rate field
- "credit limit" → maps to credit_limit field
...

Filters:
- productScope: credit_card, debit_card, personal_loan, ...
- department: Retail Banking, Commercial Banking, ...
```

---

## 15. Studio UI Integration

### Key Components

```
apps/studio/src/components/search-ai/
├── KnowledgeGraphTab.tsx          # Main KG management tab
├── KGEnableCard.tsx               # Enable/configure KG for an index
├── KGConfigurationWizard.tsx      # Step-by-step taxonomy setup wizard
├── KnowledgeBaseDetailPage.tsx    # KB detail with all tabs
├── CreateKnowledgeBaseDialog.tsx  # KB creation dialog
├── QueryPlaygroundTab.tsx         # Query testing with KG filters
├── search/
│   ├── SearchTestSection.tsx      # Search testing interface
│   ├── QueryDiagnosticCard.tsx    # Query debugging (shows KG resolution)
│   ├── QueryHistory.tsx           # ClickHouse query history
│   ├── QueryCompare.tsx           # Compare query results
│   └── ResolutionChain.tsx        # Shows vocabulary → filter resolution chain
├── browse-preview/
│   └── BrowsePreviewPage.tsx      # Browse SDK preview (taxonomy-powered)
└── VocabularyEntryForm.tsx        # Vocabulary management
```

### Studio API Client

```
File: apps/studio/src/api/search-ai.ts
```

Key KG-related API functions:

| Function                                    | Backend Route                                         |
| ------------------------------------------- | ----------------------------------------------------- |
| `getKGStats(indexId)`                       | `GET /indexes/:indexId/kg-enrich/stats`               |
| `getClassifiedDocuments(indexId, params?)`  | `GET /indexes/:indexId/kg-enrich/documents`           |
| `getEntityDistribution(indexId, params?)`   | `GET /indexes/:indexId/kg-enrich/entities`            |
| `getGraphStructure(indexId, params?)`       | `GET /indexes/:indexId/kg-enrich/graph`               |
| `triggerEnrichment(indexId, options?)`      | `POST /indexes/:indexId/kg-enrich`                    |
| `setupTaxonomy(indexId, config)`            | `POST /indexes/:indexId/kg-taxonomy/setup`            |
| `getTaxonomySetupStatus(indexId, jobId)`    | `GET /indexes/:indexId/kg-taxonomy/setup/:jobId`      |
| `getTaxonomy(indexId)`                      | `GET /indexes/:indexId/kg-taxonomy`                   |
| `generateOrgProfile(indexId, data)`         | `POST /indexes/:indexId/kg-taxonomy/generate-profile` |
| `generateCustomDomain(indexId, orgProfile)` | `POST /indexes/:indexId/kg-taxonomy/domains/generate` |

> Note: `generateOrgProfile` takes a `data` object with `mode` + `input`, not just a URL string.

### SWR Hooks

| File                                         | Hooks                                               |
| -------------------------------------------- | --------------------------------------------------- |
| `apps/studio/src/hooks/useKnowledgeBases.ts` | `useKnowledgeBases(projectId)` — KB list            |
| `apps/studio/src/hooks/useKnowledgeBase.ts`  | `useKnowledgeBase(kbId)` — Single KB detail         |
| `apps/studio/src/hooks/useKnowledgeGraph.ts` | KG stats, enrichment, taxonomy, graph visualization |
| `apps/studio/src/hooks/useAttributes.ts`     | Attribute registry CRUD, tier management            |

---

## 16. Multi-Tenancy & Security

### Tenant Isolation Model

```
┌─────────────────────────────────────────────────────────────┐
│                    ISOLATION LAYERS                           │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  Layer 1: API Route Auth                                     │
│  ├─ createUnifiedAuthMiddleware on all /api routes           │
│  ├─ req.tenantContext.tenantId extracted from JWT            │
│  └─ Cross-tenant access returns 404 (not 403)               │
│                                                              │
│  Layer 2: Repository (MongoDB)                               │
│  ├─ TenantScopedRepository base class                       │
│  ├─ tenantIsolationPlugin on all KG models                  │
│  ├─ findOneByTenant() auto-injects tenantId                 │
│  └─ Never uses findById() (bypasses tenant filter)          │
│                                                              │
│  Layer 3: Graph (Neo4j)                                      │
│  ├─ All nodes include tenantId + indexId properties          │
│  ├─ All Cypher MATCH clauses filter by tenantId             │
│  ├─ Uniqueness constraints on (tenantId, indexId, id)       │
│  └─ Property-based isolation (not database-per-tenant)      │
│                                                              │
│  Layer 4: Analytics (ClickHouse)                             │
│  ├─ ORDER BY starts with (tenant_id, index_id, ...)        │
│  ├─ All queries include WHERE tenant_id = ?                 │
│  └─ Partition pruning for efficient tenant filtering        │
│                                                              │
│  Layer 5: Cache (Redis)                                      │
│  ├─ Cache keys include tenantId: taxonomy:cache:{tenantId}  │
│  └─ Pub/sub channels scoped by tenantId                    │
│                                                              │
│  Layer 6: Workers (BullMQ)                                   │
│  ├─ Job data includes tenantId                              │
│  ├─ WorkerLLMClient created per-job for tenant isolation    │
│  └─ LLM credentials resolved per-tenant via hierarchy      │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

### LLM Credential Resolution Hierarchy

```
Per-index override (SearchIndex.llmConfig.useCases.knowledgeGraph)
  ↓ fallback
Smart defaults (llm-config/defaults.ts — modelTier: 'fast')
  ↓ fallback
Tenant LLM policy
  ↓ fallback
Global environment variables
```

### Security Notes

- **No Cypher injection risk in production:** `TaxonomyGraphService` uses hardcoded relationship
  type strings (`HAS_CATEGORY`, `INSTANCE_OF`, `FOUND_IN_PRODUCT`, etc.) in parameterized Cypher
  queries. User input is always passed as `$parameters`, never interpolated into query strings.
- **`InMemoryGraphStore.upsertRelationship()`** in `graph-store.ts` accepts a `type` string but
  is only used for testing (in-memory Map, no Cypher). Not a security concern.
- **Cross-tenant job status** returns 403 at `kg-enrichment.ts:255`. This is **intentional** —
  prevents attackers from probing for resource existence via 404-vs-403 timing.

---

## 17. Infrastructure & Configuration

### Docker Services

```yaml
# docker-compose.yml

neo4j:
  image: neo4j:5
  ports: ['7474:7474', '7687:7687'] # HTTP browser + Bolt protocol
  env: NEO4J_AUTH=neo4j/abl_dev_password
  plugins: APOC
  memory: heap max 1G
  volumes: neo4j_data, neo4j_logs
  healthcheck: cypher-shell

clickhouse:
  image: clickhouse/clickhouse-server:24.3
  ports: ['8124:8123', '9001:9000'] # HTTP + TCP
  # Used by ClickHouseEntityStore for facet queries
```

### Environment Variables

```bash
# Knowledge Graph (search-ai)
KNOWLEDGE_GRAPH_ENABLED=false              # Feature flag (opt-in)
NEO4J_URI=neo4j://localhost:7687           # Bolt protocol
NEO4J_USERNAME=neo4j
NEO4J_PASSWORD=password
NEO4J_DATABASE=neo4j
NEO4J_MAX_POOL_SIZE=100
KNOWLEDGE_GRAPH_ENTITY_EXTRACTION_METHOD=hybrid  # regex | llm | hybrid
KNOWLEDGE_GRAPH_ENABLE_COOCCURRENCE=true
KNOWLEDGE_GRAPH_COOCCURRENCE_WINDOW=5
KNOWLEDGE_GRAPH_MIN_IDF_THRESHOLD=1.5
```

### Config Schema (Zod)

```
File: apps/search-ai/src/config/index.ts (lines 97-118)
```

All config values are validated at startup via Zod with sensible defaults.

---

## 18. Test Coverage

### Existing Tests

| Test File                                                                             | Type        | What It Tests                |
| ------------------------------------------------------------------------------------- | ----------- | ---------------------------- |
| `apps/search-ai/src/__tests__/kg-enrichment-integration.test.ts`                      | Integration | Full enrichment flow         |
| `apps/search-ai/src/workers/__tests__/kg-enrichment-logic.test.ts`                    | Unit        | Worker processing logic      |
| `apps/search-ai/src/routes/__tests__/kg-taxonomy-generate-profile.test.ts`            | Unit        | Profile generation API       |
| `apps/search-ai/src/services/__tests__/taxonomy-loader-parsing.test.ts`               | Unit        | Taxonomy parsing             |
| `apps/search-ai-runtime/src/routes/__tests__/browse.test.ts`                          | Unit        | Browse SDK routes            |
| `apps/search-ai-runtime/src/routes/__tests__/discover.test.ts`                        | Unit        | Discovery API                |
| `apps/studio/src/__tests__/arch-ai/arch-ai-tools-knowledge-ops.test.ts`               | Unit        | Studio KG tool ops           |
| `apps/search-ai/src/services/__tests__/novel-candidate-validator.test.ts`             | Unit        | Novel candidate validation   |
| `apps/search-ai/src/services/reconciliation/__tests__/auto-promoter.test.ts`          | Unit        | Auto-promotion decisions     |
| `apps/search-ai/src/services/reconciliation/__tests__/reconciliation.service.test.ts` | Unit        | Reconciliation pipeline      |
| `apps/search-ai/src/services/reconciliation/__tests__/clustering.service.test.ts`     | Unit        | Agglomerative clustering     |
| `apps/search-ai/src/services/reconciliation/__tests__/interaction-aggregator.test.ts` | Unit        | ClickHouse interaction stats |
| `apps/search-ai/src/routes/__tests__/attributes.test.ts`                              | Unit        | Attribute admin API          |
| `apps/studio/src/__tests__/search-ai/attribute-table.test.tsx`                        | Unit        | Attribute table component    |

### Coverage Gaps

| Area                      | Gap        | Risk                                             |
| ------------------------- | ---------- | ------------------------------------------------ |
| TaxonomyGraphService      | Zero tests | Neo4j operations untested                        |
| DocumentClassifierService | Zero tests | Classification logic untested                    |
| EntityExtractorService    | Zero tests | Core extraction untested                         |
| ClickHouseEntityStore     | Zero tests | Facet writes untested                            |
| Tenant isolation (Neo4j)  | Zero tests | Cross-tenant leakage unverified                  |
| E2E route tests           | Zero tests | No full-stack validation                         |
| Novel attribute discovery | Covered    | novel-candidate-validator + reconciliation tests |

---

## 19. Known Gaps & Future Work

### Code Issues

| #   | Severity | Issue                                                                                          | Location                            |
| --- | -------- | ---------------------------------------------------------------------------------------------- | ----------------------------------- |
| 1   | **P1**   | `console.log`/`console.error` in route handlers (8 instances, should use `createLogger`)       | `kg-enrichment.ts`                  |
| 2   | **P1**   | `previousVersions` array unbounded — can approach BSON 16MB limit on repeated taxonomy updates | `knowledge-graph-taxonomy.model.ts` |
| 3   | **P2**   | No automatic Neo4j cleanup when index is deleted — orphaned graph data                         | Missing integration                 |
| 4   | **P2**   | Graph visualization endpoint lacks pagination                                                  | `kg-enrichment.ts`                  |
| 5   | **P3**   | `any` types in route query/aggregation objects                                                 | `kg-enrichment.ts`                  |
| 6   | **P3**   | Generic `GraphStore` interface + `InMemoryGraphStore` are dead code                            | `stores/graph-store.ts`             |

> Cross-tenant job status returns 403 at `kg-enrichment.ts:255` — this is **intentional** (security design).

### Architectural Gaps

| #   | Gap                                         | Impact                                                                                                                                                                                                                                                                               | Effort                     |
| --- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------- |
| 1   | **AttributeRegistry → Taxonomy sync**       | Promoted novel attributes (`novel → approved`) never flow back to `KnowledgeGraphTaxonomy.taxonomy.attributes[]`. `EntityExtractorService` only reads taxonomy attributes — so promoted attributes are tracked but never become extractable. The system discovers but doesn't learn. | Medium-High                |
| 2   | **No admin UI for editing regex patterns**  | Patterns are baked at taxonomy setup time. No PATCH endpoint for individual attributes on the taxonomy. Admin must regenerate entire taxonomy to fix a bad pattern.                                                                                                                  | Medium                     |
| 3   | **`beta` tier has no automatic entry path** | Reconciliation promotes `novel → approved` directly. `beta` only exists via admin demotion or manual set. The documented progression `novel → beta → approved → permanent` is not the actual code flow (actual: `novel → approved` auto, `approved ↔ beta` via auto-promoter).       | Low (design clarification) |
| 4   | **Neo4j `documentCount` increment-only**    | No decrement on re-enrichment when an entity disappears from a document. Only full graph delete + re-enrichment resets counts. Inflated counts over time.                                                                                                                            | Low                        |
| 5   | **Domain definition files diverge**         | `data/domains/` has 5 JSON files (runtime). `docs/knowledge-graph/domain-definitions/` has 7 MD files (reference). Different industries in each.                                                                                                                                     | Low (cleanup)              |

### Test Coverage Gaps

| Area                        | Gap        | Risk                            |
| --------------------------- | ---------- | ------------------------------- |
| `TaxonomyGraphService`      | Zero tests | Neo4j operations untested       |
| `DocumentClassifierService` | Zero tests | Classification logic untested   |
| `EntityExtractorService`    | Zero tests | Core extraction untested        |
| `ClickHouseEntityStore`     | Zero tests | Facet writes untested           |
| Tenant isolation (Neo4j)    | Zero tests | Cross-tenant leakage unverified |
| E2E route tests             | Zero tests | No full-stack KG validation     |

### Planned Phases

| Phase                        | Status      | Content                                                                                                        |
| ---------------------------- | ----------- | -------------------------------------------------------------------------------------------------------------- |
| Phase 4: Graph Retrieval API | NOT STARTED | `POST /api/search/:indexId/graph` — entity-centric search, relationship-based ranking, graph traversal queries |
| Phase 5: Entity Resolution   | NOT STARTED | Merge duplicate entities ("Microsoft" = "Microsoft Corp"), cross-index entity linking, temporal graph analysis |

### Scaling Concerns (Documented in kg-scaling-fixes.hld.md)

| Bottleneck               | Current                        | Fix Planned / Status                         |
| ------------------------ | ------------------------------ | -------------------------------------------- |
| N+1 Neo4j sessions       | One session per entity write   | ✅ Fixed: batch UNWIND in single transaction |
| Unbounded Promise.all    | All documents in batch at once | `p-limit` concurrency control                |
| Serial taxonomy creation | One node at a time             | ✅ Fixed: UNWIND per node type               |
| Cartesian stats query    | Full cross-join in Cypher      | ✅ Fixed: CALL subqueries per metric         |

---

## 20. File Reference

### Core Implementation Files

| File                                                                     | Package   | Purpose                            |
| ------------------------------------------------------------------------ | --------- | ---------------------------------- |
| `apps/search-ai/src/workers/kg-enrichment-worker.ts`                     | search-ai | Main enrichment BullMQ worker      |
| `apps/search-ai/src/workers/taxonomy-setup-worker.ts`                    | search-ai | Taxonomy setup BullMQ worker       |
| `apps/search-ai/src/services/entity-extractor.service.ts`                | search-ai | Hybrid entity extraction service   |
| `apps/search-ai/src/services/document-classifier.service.ts`             | search-ai | LLM document classification        |
| `apps/search-ai/src/services/novel-candidate-validator.ts`               | search-ai | Novel attribute validation         |
| `apps/search-ai/src/services/kg-model-assessment.ts`                     | search-ai | LLM model suitability scoring      |
| `apps/search-ai/src/services/knowledge-graph/taxonomy-graph.service.ts`  | search-ai | Neo4j graph operations             |
| `apps/search-ai/src/services/knowledge-graph/clickhouse-entity-store.ts` | search-ai | ClickHouse facet storage           |
| `apps/search-ai/src/services/taxonomy-loader.service.ts`                 | search-ai | Domain definition loading          |
| `apps/search-ai/src/services/taxonomy-cache-writer.ts`                   | search-ai | Redis cache writer                 |
| `apps/search-ai/src/services/org-profile-generator.service.ts`           | search-ai | LLM org profile from URL           |
| `apps/search-ai/src/services/custom-domain-generator.service.ts`         | search-ai | LLM custom domain generation       |
| `apps/search-ai/src/services/reconciliation/reconciliation.service.ts`   | search-ai | Attribute reconciliation pipeline  |
| `apps/search-ai/src/services/reconciliation/auto-promoter.ts`            | search-ai | Tier promotion/demotion decisions  |
| `apps/search-ai/src/services/reconciliation/clustering.service.ts`       | search-ai | Agglomerative attribute clustering |
| `apps/search-ai/src/services/reconciliation/interaction-aggregator.ts`   | search-ai | ClickHouse interaction stats       |
| `apps/search-ai/src/workers/reconciliation-worker.ts`                    | search-ai | Reconciliation BullMQ worker       |
| `apps/search-ai/src/routes/attributes.ts`                                | search-ai | Attribute admin CRUD REST API      |
| `apps/search-ai/src/stores/graph-store.ts`                               | search-ai | Abstract GraphStore interface      |
| `apps/search-ai/src/routes/kg-enrichment.ts`                             | search-ai | Enrichment REST API                |
| `apps/search-ai/src/routes/kg-taxonomy.ts`                               | search-ai | Taxonomy REST API                  |
| `apps/search-ai/src/routes/knowledge-bases.ts`                           | search-ai | KB CRUD REST API                   |
| `apps/search-ai/src/repos/kg.repository.ts`                              | search-ai | Tenant-scoped data access          |
| `apps/search-ai/src/config/index.ts`                                     | search-ai | KG config schema (lines 97-118)    |

### Database Models

| File                                                             | Package  | Database                      |
| ---------------------------------------------------------------- | -------- | ----------------------------- |
| `packages/database/src/models/knowledge-graph-taxonomy.model.ts` | database | searchaicontent               |
| `packages/database/src/models/knowledge-graph-domain.model.ts`   | database | searchaicontent               |
| `packages/database/src/models/attribute-registry.model.ts`       | database | searchaicontent               |
| `packages/database/src/models/attribute-merge-event.model.ts`    | database | searchaicontent               |
| `packages/database/src/models/taxonomy-health-cache.model.ts`    | database | searchaicontent               |
| `packages/database/src/models/search-document.model.ts`          | database | searchaicontent               |
| `packages/database/src/models/search-index.model.ts`             | database | searchaicontent               |
| `packages/database/src/models/knowledge-base.model.ts`           | database | default (NOT searchaicontent) |
| `packages/database/src/clickhouse-schemas/init.ts`               | database | ClickHouse                    |

### Runtime Integration

| File                                                                    | Package           | Purpose                        |
| ----------------------------------------------------------------------- | ----------------- | ------------------------------ |
| `apps/search-ai-runtime/src/services/query/query-pipeline.ts`           | search-ai-runtime | Query processing pipeline      |
| `apps/search-ai-runtime/src/services/taxonomy/taxonomy-cache-reader.ts` | search-ai-runtime | Redis taxonomy reader          |
| `apps/search-ai-runtime/src/routes/browse.ts`                           | search-ai-runtime | Browse SDK (KG-powered)        |
| `apps/search-ai-runtime/src/routes/discover.ts`                         | search-ai-runtime | Discovery manifest API         |
| `apps/search-ai-runtime/src/routes/agent-integration.routes.ts`         | search-ai-runtime | Agent integration endpoints    |
| `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts`      | runtime           | KB-as-Tool executor            |
| `apps/runtime/src/services/search-ai/description-builder.ts`            | runtime           | Tool description from manifest |
| `apps/search-ai/src/services/searchai-tool-registration.ts`             | search-ai         | Auto-register KB as tool       |

### Existing Design Documents

| Document               | Path                                                                           |
| ---------------------- | ------------------------------------------------------------------------------ |
| Feature Spec           | `docs/features/knowledge-graph.md`                                             |
| HLD (Approved)         | `docs/specs/knowledge-graph.hld.md`                                            |
| LLD                    | `docs/plans/knowledge-graph.lld.md`                                            |
| Implementation Plan    | `docs/plans/2026-03-22-knowledge-graph-impl-plan.md`                           |
| Test Spec              | `docs/testing/knowledge-graph.md`                                              |
| KG Scaling Fixes HLD   | `docs/specs/browse-sdk/kg-scaling-fixes.hld.md`                                |
| Domain-Aware KG Design | `apps/search-ai/docs/knowledge-graph/DESIGN-domain-aware-knowledge-graph.md`   |
| KG Extraction Design   | `apps/search-ai/docs/chunking/15-knowledge-graph-extraction.md`                |
| RFC: Simplify Taxonomy | `apps/search-ai/docs/knowledge-graph/plans/RFC-001-simplify-taxonomy-setup.md` |
| SDLC Logs              | `docs/sdlc-logs/knowledge-graph/`                                              |

---

## Appendix A: Entity Extraction — Three Separate Systems

The platform has **three independent entity extraction systems** that serve different purposes:

| System                     | Location                                                               | Purpose                                                           | Runs When                 |
| -------------------------- | ---------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------- |
| **KG Entity Extraction**   | `apps/search-ai/src/services/entity-extractor.service.ts`              | Extract structured attributes from documents during KG enrichment | Background enrichment job |
| **Runtime NLU Extraction** | `packages/compiler/src/platform/nlu/tasks/entity-extractor.ts`         | Extract slot values from user utterances in conversational agents | Every agent turn          |
| **Query Preprocessing**    | `services/preprocessing-service/src/preprocessing/entity_extractor.py` | Extract dates, numbers, emails from search queries                | Every search query        |

These share no code and serve completely different pipeline stages.

## Appendix B: Enrichment Worker Responsibilities

The main `enrichment-worker.ts` (core ingestion pipeline) handles:

- **Text stats**: charCount, wordCount per chunk
- **Language propagation**: copies `document.language` (set by docling-extraction-worker) to chunk canonical metadata
- **Status transition**: sets document status to ENRICHED
- **Downstream routing**: enqueues embedding, multimodal, tree-building, question-synthesis, scope-classification jobs

Other pipeline responsibilities are handled by dedicated workers:

- **Language detection**: `docling-extraction-worker.ts` (Docling's fasttext/lingua, 176 languages)
- **Document summary**: `page-processing-worker.ts` (LLM progressive summarization → `metadata.documentSummary`)
- **Entity extraction**: `kg-enrichment-worker.ts` (taxonomy-scoped, hybrid regex+LLM → 4-store write)

## Appendix C: KnowledgeBase vs SearchIndex Model Split

```
KnowledgeBase (user-facing, project-scoped)
  ├─ name, description, projectId
  ├─ searchIndexId → links to SearchIndex
  └─ Database: default mongoose connection (NOT searchaicontent)

SearchIndex (system-internal, tenant-scoped)
  ├─ llmConfig, embedding config, pipeline settings
  ├─ KG config at llmConfig.useCases.knowledgeGraph
  └─ Database: searchaicontent (via ModelRegistry)
```

The KB is the user-facing entity (created in Studio UI). The SearchIndex is the system entity that holds all configuration. They're linked 1:1 but stored in different databases — this is intentional for separation of concerns (user data vs system data).
