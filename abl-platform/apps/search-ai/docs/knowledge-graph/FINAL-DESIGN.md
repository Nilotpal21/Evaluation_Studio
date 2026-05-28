# Knowledge Graph Implementation - Final Design Document

**Version**: 1.0
**Date**: 2026-02-25
**Status**: Approved for Implementation
**Architecture**: Separate Jobs with Manual Triggers

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Architecture Overview](#architecture-overview)
3. [Component Architecture](#component-architecture)
4. [Storage Strategy](#storage-strategy)
5. [API Design](#api-design)
6. [Data Schemas](#data-schemas)
7. [Worker Implementation](#worker-implementation)
8. [Job Flows](#job-flows)
9. [Implementation Tasks](#implementation-tasks)

---

## Executive Summary

### Problem Statement

Current search system cannot disambiguate between similar products:

- "Interest rate on credit cards" vs "Interest rate on debit cards" (impossible query)
- Documents about credit cards incorrectly linked to debit card entities
- No product-scoped filtering during search

### Solution

Domain-aware knowledge graph with:

- **Taxonomy-driven classification**: Classify chunks by product scope (credit_card, debit_card, housing_loan)
- **Attribute scoping**: Interest rate applies to credit_card, NOT debit_card
- **Impossible query detection**: Block queries that don't make sense (e.g., "interest rate on debit cards")
- **Graph relationships**: Neo4j stores product-attribute relationships for validation

### Architecture Decisions

| Decision                | Choice                               | Rationale                                                             |
| ----------------------- | ------------------------------------ | --------------------------------------------------------------------- |
| **Job Architecture**    | Separate jobs                        | Fast ingestion (50s), KG enrichment in background (5-7 min)           |
| **Trigger Model**       | Manual API trigger per index         | Admin triggers once after upload batch completes                      |
| **Taxonomy Storage**    | MongoDB + Neo4j                      | MongoDB for fast access, Neo4j for graph traversal                    |
| **Content Duplication** | Store in vector DB                   | 2x faster queries (no MongoDB fetch), 15% storage overhead acceptable |
| **LLM Reuse**           | Existing LLMProvider                 | No new provider, reuse shared infrastructure                          |
| **Re-Classification**   | Re-classify chunks (no re-ingestion) | 33 min vs 52 days for re-ingestion                                    |

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Job Architecture (5 Phases)                       │
└─────────────────────────────────────────────────────────────────────┘

PHASE 0: Prerequisites
├─ Index created
├─ Documents uploaded via existing ingestion pipeline
└─ Documents SEARCHABLE with basic semantic search

PHASE 1: ONE-TIME TAXONOMY SETUP (Admin Manual Trigger)
├─ API: POST /api/knowledge-graph/indexes/:indexId/setup
├─ Job: taxonomy-setup-worker
├─ Duration: 2-5 seconds (LLM parsing)
├─ Output: Taxonomy stored in MongoDB + Neo4j
└─ Trigger: Once per index (before enrichment)

PHASE 2: DOCUMENT INGESTION (Automatic - Existing Pipeline)
├─ Trigger: Document upload (existing workflow)
├─ Job: document-ingestion-worker (EXISTING, REUSED)
├─ Duration: 50 seconds per document (200 chunks)
├─ Output: Document SEARCHABLE (embeddings + basic metadata)
└─ Changes: NONE (backward compatible)

PHASE 3: KG ENRICHMENT (Admin Manual Trigger - Index-Level)
├─ API: POST /api/knowledge-graph/indexes/:indexId/enrich
├─ Job: kg-enrichment-worker (NEW)
├─ Duration: 60-90 minutes (for 1,000 docs, 200K chunks)
├─ Output: All documents KG-enhanced (classification + entities + graph)
└─ Trigger: Once after upload batch completes

PHASE 4: TAXONOMY UPDATE (Admin Manual Trigger)
├─ API: PUT /api/knowledge-graph/indexes/:indexId/taxonomy
├─ Job: taxonomy-update-worker
├─ Duration: 2-5 seconds (LLM parsing)
├─ Output: New taxonomy stored, chunks flagged for re-classification
└─ Trigger: When business requirements change

PHASE 5: RE-CLASSIFICATION (Admin Manual Trigger)
├─ API: POST /api/knowledge-graph/indexes/:indexId/reclassify
├─ Job: reclassification-worker (NEW)
├─ Duration: 30-45 minutes (for 100K chunks)
├─ Output: All chunks re-classified with new taxonomy
└─ Trigger: After taxonomy update (optional)
```

---

## Component Architecture

### 3.1 Existing Components (REUSE)

```typescript
┌─────────────────────────────────────────────────────────────────────┐
│              Existing Components (DO NOT REBUILD)                    │
└─────────────────────────────────────────────────────────────────────┘

Component 1: LLM Provider Service (EXISTING)
├─ Location: packages/shared/src/services/llm-provider.ts
├─ Interface: LLMProvider (Anthropic, OpenAI, Google)
├─ Usage:
│  ├─ Taxonomy parsing (Sonnet)
│  ├─ Chunk classification (Haiku + Sonnet escalation)
│  └─ Entity extraction (Haiku)
├─ Configuration: Model selection per use case
└─ Import: import { getLLMProvider } from '@agent-platform/shared/services/llm-provider'

Component 2: Vector Database Service (EXISTING)
├─ Location: packages/search-ai/src/services/vector-store.ts
├─ Interface: VectorStore (Qdrant, Pinecone, Weaviate)
├─ Usage:
│  ├─ Store embeddings + metadata
│  ├─ Filtered search (by product scope)
│  └─ Update metadata (after KG enrichment)
├─ Changes: Add KG metadata fields (backward compatible)
└─ Import: import { getVectorStore } from '@agent-platform/search-ai/services/vector-store'

Component 3: Document Ingestion Worker (EXISTING)
├─ Location: apps/search-ai/src/workers/page-processing-worker.ts
├─ Functionality: Extract text, chunk, generate embeddings, store
├─ Usage: Phase 2 (no modifications needed)
├─ Changes: NONE (KG enrichment is separate job)
└─ Note: Already handles document upload → chunk → embed → store flow

Component 4: Embedding Service (EXISTING)
├─ Location: packages/search-ai/src/services/embedding.ts
├─ Interface: EmbeddingProvider (OpenAI, Cohere, Anthropic)
├─ Usage: Generate chunk embeddings (unchanged)
├─ Changes: NONE
└─ Import: import { getEmbeddingProvider } from '@agent-platform/search-ai/services/embedding'

Component 5: MongoDB (EXISTING)
├─ Collections: search_indexes, search_documents, search_chunks
├─ Usage: Add new fields to existing schemas (backward compatible)
├─ Changes:
│  ├─ Add classification field to search_chunks
│  ├─ Add kgState field to search_chunks.metadata
│  └─ Create knowledge_graph_taxonomy collection (NEW)
└─ Migration: Add fields with default null (existing chunks unaffected)
```

### 3.2 New Components (BUILD)

```typescript
┌─────────────────────────────────────────────────────────────────────┐
│                    New Components (TO BUILD)                         │
└─────────────────────────────────────────────────────────────────────┘

Component 1: Taxonomy Storage (NEW)
├─ MongoDB Collection: knowledge_graph_taxonomy
├─ Purpose: Store parsed taxonomy per index
├─ Schema: See Section 6.1
└─ CRUD: Create (setup), Read (enrichment), Update (taxonomy update)

Component 2: Neo4j Service (NEW)
├─ Location: packages/search-ai/src/services/neo4j.ts
├─ Purpose: Taxonomy graph CRUD, entity relationships
├─ Operations:
│  ├─ createTaxonomyGraph(taxonomy, scope)
│  ├─ createChunkLinks(chunkId, classification, entities, scope)
│  ├─ updateTaxonomyGraph(taxonomy, scope)
│  └─ queryRelationships(filters)
└─ Dependencies: neo4j-driver

Component 3: Taxonomy Loader Service (NEW)
├─ Location: packages/search-ai/src/services/taxonomy-loader.ts
├─ Purpose: Load domain definitions + parse org profile with LLM
├─ Operations:
│  ├─ loadTaxonomy(tenantId, indexId) → Get from MongoDB
│  ├─ loadDomainDefinitions(paths) → Read pre-defined JSON from system
│  ├─ parseOrganizationProfileWithLLM(markdown) → LLM call (Sonnet)
│  │  ├─ Extracts: organizationName, products, aliases, disambiguation keywords
│  │  ├─ Flexible markdown structure (customer's own format)
│  │  └─ Returns structured OrganizationProfile JSON
│  ├─ mergeTaxonomy(domains, orgProfile) → Combine domain + org context
│  └─ storeTaxonomy(taxonomy) → Save to MongoDB + Neo4j
├─ LLM Usage:
│  ├─ Input: Customer markdown (flexible structure)
│  ├─ Model: claude-3-5-sonnet-20241022 (accuracy critical)
│  ├─ Cost: ~$0.01 per setup (one-time per index)
│  └─ Output: Structured JSON with products and attribute context
└─ Dependencies: LLMClient (REUSE)

Component 4: Document Classifier Service (NEW) ✅ IMPLEMENTED
├─ Location: apps/search-ai/src/services/document-classifier.service.ts
├─ Purpose: Classify documents by product scope (Haiku + Sonnet escalation)
├─ Operations:
│  ├─ classifyDocument(document, taxonomy) → ClassificationResult
│  │  ├─ Uses EXISTING document summary (zero extra cost!)
│  │  ├─ Try Haiku first ($0.0002/doc)
│  │  ├─ Escalate to Sonnet if confidence < 0.8
│  │  └─ Returns: productScope, department, category, confidence
│  ├─ classifyWithModel(document, taxonomy, model, escalated) → Private helper
│  └─ buildClassificationPrompt(document, taxonomy) → Private helper
├─ Key Features:
│  ├─ Document-level (not chunk-level) → 10x cost reduction
│  ├─ Reuses existing summaries → no additional LLM calls for content
│  ├─ Smart escalation → only 20% need Sonnet
│  └─ Metadata tracking → classificationMethod, model, escalatedToSonnet
└─ Dependencies: LLMClient (REUSE)

Component 5: Entity Extractor Service (NEW)
├─ Location: packages/search-ai/src/services/entity-extractor.ts
├─ Purpose: Extract entities with product context and attribute scoping
├─ Operations:
│  ├─ extractEntities(content, taxonomy, productScope) → ContextualEntity[]
│  ├─ validateAttributeApplicability(attribute, product) → boolean
│  └─ extractWithRegex(content, patterns) → Entity[]
├─ Logic:
│  ├─ Filter applicable attributes (from taxonomy)
│  ├─ Try regex extraction first (fast)
│  ├─ Fall back to LLM extraction (with context)
│  └─ Tag entities with productType, applicability
└─ Dependencies: LLMProvider (REUSE)

Component 6: KG Enrichment Worker (NEW) ✅ IMPLEMENTED
├─ Location: apps/search-ai/src/workers/kg-enrichment-worker.ts
├─ Purpose: Background job for document classification + entity extraction
├─ Queue: kg-enrichment (BullMQ)
├─ Processing Flow:
│  ├─ Load taxonomy from MongoDB (check existence)
│  ├─ Query documents with summaries (NOT_ENRICHED or newly ingested)
│  ├─ Process DOCUMENTS in batches (cursor for memory efficiency)
│  │  ├─ Classify document using existing summary (DocumentClassifier)
│  │  ├─ Update MongoDB document with classification
│  │  ├─ Create Neo4j: (Document)-[:CLASSIFIED_AS]->(Product)
│  │  ├─ For each chunk:
│  │  │  ├─ Extract entities scoped by document classification (EntityExtractor)
│  │  │  ├─ Update MongoDB chunk with entities
│  │  │  ├─ Update Vector DB with document classification metadata
│  │  │  └─ Create Neo4j: (EntityInstance)-[:EXTRACTED_FROM_DOCUMENT]->(Document)
│  │  └─ Track statistics (documentsClassified, entitiesExtracted, llmCallsMade, etc.)
│  └─ Handle errors gracefully per-document (mark as NOT_ENRICHED, continue processing)
├─ Key Features:
│  ├─ Document-level approach → process by document, not chunk
│  ├─ Batch processing → default 50 documents per batch
│  ├─ Progress tracking → job.updateProgress() for polling
│  ├─ Graceful skipping → marks documents as SKIPPED if no taxonomy
│  ├─ Tenant/index isolation → all queries include tenantId + indexId
│  └─ Statistics tracking → full ProcessingStats returned on completion
├─ Concurrency: Default 3 parallel jobs (configurable)
└─ Dependencies: DocumentClassifier, EntityExtractor, TaxonomyGraphService, VectorStore

Component 7: Re-Classification Worker (NEW)
├─ Location: apps/search-ai/src/workers/reclassification-worker.ts
├─ Purpose: Re-classify chunks after taxonomy update
├─ Queue: reclassification-queue (BullMQ)
├─ Processing:
│  ├─ Find chunks with needsReclassification: true
│  ├─ Re-classify with new taxonomy
│  ├─ Re-extract entities
│  └─ Update MongoDB + vector DB + Neo4j
└─ Dependencies: Same as KG Enrichment Worker
```

---

## Storage Strategy

### 4.1 Storage Distribution

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Storage Architecture (3 Databases)                │
└─────────────────────────────────────────────────────────────────────┘

MongoDB (search_documents + search_chunks) - SOURCE OF TRUTH
├─ search_documents Collection:
│  ├─ ✓ Document metadata - 1-2 KB
│  ├─ ✓ Classification (IDocumentClassification) - 0.5 KB
│  │  ├─ productScope: { primaryProduct, confidence, secondaryProducts }
│  │  ├─ department, subDepartment, category
│  │  ├─ classifiedAt, classificationMethod, model
│  │  └─ escalatedToSonnet flag
│  ├─ ✓ KG State (metadata.kgState) - 0.2 KB
│  │  ├─ status: NOT_ENRICHED | ENRICHED | SKIPPED | NEEDS_RECLASSIFICATION
│  │  ├─ enrichedAt, taxonomyVersion
│  │  └─ needsReclassification flag
│  └─ Purpose: Document-level classification, KG tracking
├─ search_chunks Collection (per chunk):
│  ├─ ✓ Content (full text) - 2-5 KB
│  ├─ ✓ Embedding (vector) - 6 KB
│  ├─ ✓ Entities (metadata.entities) - 1-3 KB
│  │  ├─ type, name, dataType, rawValue, normalizedValue
│  │  ├─ productType (from document classification)
│  │  └─ context: { chunkScope, inScopeMatch, attributeApplicable }
│  └─ ✓ Other metadata - 0.5-1 KB
├─ Size: 10-15 KB per chunk + 1-2 KB per document
├─ Purpose: Authoritative storage, CRUD operations
└─ Query: Fetch by ID, update entities, query by classification

Vector Database (Qdrant/Pinecone) - OPTIMIZED REPLICA
├─ Stores: VECTOR + CONTENT + METADATA
│  ├─ ✓ Embedding (vector) - 6 KB
│  ├─ ✓ Content (text) - 2-5 KB [DUPLICATED]
│  ├─ ✓ Classification metadata - 0.5 KB [DUPLICATED]
│  └─ ✓ Search metadata (tenantId, indexId) - 0.2 KB
├─ Size: 8-12 KB per chunk
├─ Purpose: Fast similarity search + immediate result display
├─ Query: Vector search with metadata filters
└─ Duplication: Content duplicated for 2x faster queries (no MongoDB fetch)

Neo4j - RELATIONSHIPS ONLY
├─ Stores: GRAPH STRUCTURE (no content)
│  ├─ ✓ Document node (ID only) - 0.1 KB
│  ├─ ✓ (Document)-[:CLASSIFIED_AS { confidence, classifiedAt, model }]->(Product)
│  ├─ ✓ (EntityInstance)-[:EXTRACTED_FROM_DOCUMENT]->(Document)
│  ├─ ✓ (EntityInstance)-[:OF_TYPE]->(Attribute)
│  ├─ ✓ (Product)-[:BELONGS_TO]->(Category)-[:BELONGS_TO]->(Domain)
│  └─ ✓ Department boundary relationships (cross-product prevention)
├─ Size: ~0.3 KB per document (document-level, not chunk-level)
├─ Purpose: Graph traversal, relationship validation, disambiguation
└─ Query: Cypher queries for relationship traversal, impossible query detection

STORAGE COST (per 100K chunks / 10K documents):
├─ MongoDB: 1-1.5 GB chunks + 10-20 MB documents = 1.02-1.52 GB ($0.39/month)
├─ Vector DB: 0.87-1.17 GB ($0.47/month) [includes content duplication]
├─ Neo4j: 3 MB documents + relationships (~$0.001/month) [document-level, not chunk-level]
├─ TOTAL: 1.89-2.69 GB ($0.86/month)
└─ Duplication overhead: 200-500 MB (~15%), cost $0.13/month

PERFORMANCE TRADE-OFF:
├─ With duplication: 50-100ms (single query)
├─ Without duplication: 100-200ms (vector search + MongoDB fetch)
└─ Verdict: 2x faster queries, 15% storage cost increase - WORTH IT

LLM COST (per 100K chunks / 10K documents):
├─ Document classification: 10K calls × $0.0002 = $2.00 (Haiku primary)
├─ Escalation (20%): 2K calls × $0.003 = $6.00 (Sonnet)
├─ Entity extraction (regex 95%): ~$10 (5% LLM fallback)
├─ TOTAL: $18/100K chunks (one-time enrichment)
└─ 10x cheaper than chunk-level approach ($180 saved per 100K chunks)
```

### 4.2 Why Duplicate Content in Vector DB?

**Decision**: Store chunk content in vector DB metadata (duplicate from MongoDB)

**Rationale**:

1. **Performance**: 2x faster queries (50-100ms vs 100-200ms)
2. **Simplicity**: Single query returns everything (no MongoDB fetch)
3. **Cost**: Minimal overhead ($0.13/month per 100K chunks, ~15%)
4. **User Experience**: Instant search results (no fetch delay)

**Alternative Considered**: Store only ID in vector DB

- Would require 2 database queries (vector search + MongoDB fetch)
- Saves 15% storage but doubles query latency
- Rejected in favor of performance

**Future Optimization**: Can make this configurable per index if needed

---

## API Design

### 5.1 Setup Taxonomy (One-Time)

```http
POST /api/knowledge-graph/indexes/:indexId/setup
Authorization: Bearer <tenant_admin_token>
Content-Type: application/json

{
  "domains": ["banking", "financial-services"],
  "organizationProfileFile": "s3://uploads/tenant_123/org-profile.md",
  "customDomainFiles": ["s3://uploads/tenant_123/custom-banking.md"]
}
```

**Response**:

```json
{
  "success": true,
  "jobId": "job_taxonomy_setup_abc123",
  "status": "QUEUED",
  "message": "Taxonomy setup job queued. Expected completion in 2-5 seconds.",
  "pollUrl": "/api/knowledge-graph/jobs/job_taxonomy_setup_abc123",
  "estimatedCompletionTime": "2026-02-25T10:00:05Z"
}
```

### 5.2 Enrich All Documents (Manual Trigger) ✅ IMPLEMENTED

```http
POST /api/indexes/:indexId/kg-enrich
Authorization: Bearer <tenant_admin_token>
Content-Type: application/json

{
  "priority": "normal",
  "options": {
    "batchSize": 50,
    "retrySkipped": false
  },
  "filter": {
    "uploadedAfter": "2026-02-01T00:00:00Z"
  }
}
```

**Response**:

```json
{
  "success": true,
  "jobId": "kg-enrich:index_456:1740470400000",
  "status": "QUEUED",
  "indexId": "index_456",
  "taxonomyVersion": "1.0.0",
  "statistics": {
    "estimatedDocuments": 1000,
    "estimatedDurationMinutes": 33
  },
  "pollUrl": "/api/indexes/index_456/kg-enrich/jobs/kg-enrich:index_456:1740470400000",
  "createdAt": "2026-02-25T10:00:00Z"
}
```

### 5.3 Poll Job Status ✅ IMPLEMENTED

```http
GET /api/indexes/:indexId/kg-enrich/jobs/:jobId
Authorization: Bearer <tenant_admin_token>
```

**Response (In Progress)**:

```json
{
  "jobId": "kg-enrich:index_456:1740470400000",
  "status": "PROCESSING",
  "progress": 35,
  "createdAt": "2026-02-25T10:00:00Z",
  "processedAt": "2026-02-25T10:00:05Z",
  "statistics": {
    "documentsClassified": 350,
    "chunksEnriched": 35000,
    "entitiesExtracted": 143500,
    "neo4jLinksCreated": 144000,
    "llmCallsMade": 350,
    "llmEscalations": 70,
    "vectorDbUpdates": 35000
  },
  "documentsProcessed": 350,
  "estimatedCompletionAt": "2026-02-25T10:32:00Z"
}
```

**Response (Completed)**:

```json
{
  "jobId": "kg-enrich:index_456:1740470400000",
  "status": "COMPLETED",
  "progress": 100,
  "createdAt": "2026-02-25T10:00:00Z",
  "processedAt": "2026-02-25T10:00:05Z",
  "finishedAt": "2026-02-25T10:32:15Z",
  "documentsProcessed": 1000,
  "statistics": {
    "documentsClassified": 1000,
    "chunksEnriched": 100000,
    "entitiesExtracted": 410000,
    "neo4jLinksCreated": 411000,
    "llmCallsMade": 1000,
    "llmEscalations": 200,
    "vectorDbUpdates": 100000
  }
}
```

**Response (Skipped - No Taxonomy)**: ✅ IMPLEMENTED

```json
{
  "jobId": "kg-enrich:index_456:1740470400000",
  "status": "SKIPPED",
  "progress": 0,
  "reason": "NO_TAXONOMY",
  "message": "Taxonomy not configured for this index. Run taxonomy setup first.",
  "createdAt": "2026-02-25T10:00:00Z",
  "finishedAt": "2026-02-25T10:00:02Z"
}
```

### 5.4 Update Taxonomy

```http
PUT /api/knowledge-graph/indexes/:indexId/taxonomy
Authorization: Bearer <tenant_admin_token>
Content-Type: application/json

{
  "organizationProfileFile": "s3://uploads/tenant_123/org-profile-v2.md",
  "triggerReclassification": false
}
```

### 5.5 Re-Classify Chunks

```http
POST /api/knowledge-graph/indexes/:indexId/reclassify
Authorization: Bearer <tenant_admin_token>
Content-Type: application/json

{
  "mode": "incremental",
  "priority": "low"
}
```

---

## Data Schemas

### 6.0 Taxonomy Components: Domain Definitions vs Organization Profiles

**Two-Part Taxonomy System:**

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      TAXONOMY = DOMAIN + ORGANIZATION                     │
└──────────────────────────────────────────────────────────────────────────┘

DOMAIN DEFINITIONS (Platform-Provided)
├─ Format: Structured JSON
├─ Location: Pre-loaded in system (apps/search-ai/data/domains/)
├─ Content:
│  ├─ Standard products (credit-card, housing-loan, etc.)
│  ├─ Standard attributes (interest_rate, credit_limit, etc.)
│  ├─ Attribute scoping (applicableTo, notApplicableTo)
│  ├─ Extraction patterns (regex, LLM, hybrid)
│  └─ Default disambiguation keywords
├─ Versioned: Yes (domain.version)
├─ LLM Usage: NO (pre-structured, no parsing needed)
└─ Examples:
   ├─ banking-domain.json → Credit cards, loans, accounts
   ├─ financial-services-domain.json → Investments, insurance
   └─ manufacturing-domain.json → Products, equipment, materials

ORGANIZATION PROFILE (Customer-Provided)
├─ Format: Markdown (.md file)
├─ Location: Uploaded by customer (S3/file storage)
├─ Content:
│  ├─ Company name and industry
│  ├─ Organization-specific product names/aliases
│  │  Example: "Platinum Rewards Card", "Cashback Card" → credit-card
│  ├─ Disambiguation keywords specific to their context
│  │  Example: "Our housing loans use 'LTV', not 'down payment'"
│  ├─ Attribute context (typical ranges, aliases)
│  │  Example: "Interest rates typically 6-10% APR"
│  └─ Product hierarchies (parent brands, sub-brands)
├─ Structure: FLEXIBLE (customer writes in their own format)
├─ LLM Usage: YES (Sonnet parses markdown → structured JSON)
├─ Cost: ~$0.01 per setup (one-time)
└─ Example: customer-organization-template.md

MERGE PROCESS:
1. Load domain definitions (JSON) → structured taxonomy
2. Parse organization profile (Markdown + LLM) → structured context
3. Merge: Enhance domain products with organization-specific names
4. Result: Unified taxonomy with both standard + organization context
```

**Why This Design?**

1. **Domain Definitions (JSON)**:
   - Platform maintains standard product/attribute definitions
   - Updates centrally managed (versioned)
   - No LLM cost for loading
   - Consistent across all customers

2. **Organization Profile (Markdown + LLM)**:
   - Customers write in their own words/structure
   - No need to match exact format (LLM extracts)
   - Natural language descriptions
   - Flexible, user-friendly

3. **LLM Parsing**:
   - Model: claude-3-5-sonnet-20241022 (accuracy critical)
   - Input: Customer markdown (any structure)
   - Output: Structured JSON (organizationName, products, attributeContext)
   - Cost: ~$0.01 per setup (one-time per index)

**Example Flow:**

```typescript
// 1. Load domain (pre-defined JSON)
const domain = loadDomainDefinition('banking'); // No LLM
// domain.products = [{ id: 'credit-card', name: 'Credit Card', ... }]

// 2. Parse organization profile (customer markdown)
const orgProfile = await parseOrganizationProfileWithLLM(markdownContent); // LLM call
// orgProfile.products = [{
//   productId: 'credit-card',
//   organizationSpecificNames: ['Platinum Rewards Card', 'Cashback Card'],
//   attributeContext: { interest_rate: { typicalRange: '18-24% APR' } }
// }]

// 3. Merge
const taxonomy = mergeTaxonomy(domain, orgProfile);
// taxonomy.products[0].organizationSpecificNames = ['Platinum Rewards Card', 'Cashback Card']
```

---

### 6.1 MongoDB: knowledge_graph_taxonomy

```typescript
interface KnowledgeGraphTaxonomy {
  _id: ObjectId;
  tenantId: string;
  indexId: string;

  taxonomy: {
    domain: {
      id: string;
      name: string;
      version: string;
    };

    categories: Array<{
      id: string;
      name: string;
      department: string;
    }>;

    products: Array<{
      id: string;
      name: string;
      categoryId: string;
      department: string;
      subDepartment: string;
      disambiguationKeywords: string[];
      organizationSpecificNames: string[];
    }>;

    attributes: Array<{
      id: string;
      name: string;
      dataType:
        | 'percentage'
        | 'currency'
        | 'date'
        | 'duration'
        | 'identifier'
        | 'string'
        | 'number';

      // CRITICAL: Attribute scoping
      applicableTo: string[]; // Product IDs
      notApplicableTo: string[]; // Product IDs

      // Extraction configuration
      extraction: {
        method: 'regex' | 'llm' | 'hybrid';
        patterns?: string[]; // Regex patterns
        keywords?: string[]; // LLM hints
      };

      // Organization context
      organizationContext?: {
        typicalRange?: string;
        aliases?: string[];
      };
    }>;

    departmentBoundaries: Array<{
      product1: string;
      product2: string;
      reasoning: string;
    }>;
  };

  version: string;
  domains: string[];
  customDomainFiles: string[];
  organizationProfileFile: string;

  createdAt: Date;
  updatedAt: Date;
}
```

### 6.2 MongoDB: search_documents (Updated)

```typescript
interface SearchDocument {
  _id: ObjectId;
  tenantId: string;
  indexId: string;
  title: string;
  sourceUrl?: string;

  // NEW: KG Classification (Document-Level)
  classification?: {
    productScope: {
      primaryProduct: string;
      confidence: number;
      secondaryProducts: string[];
    };
    department: string;
    subDepartment?: string;
    category: string;
    classifiedAt: Date;
    classificationMethod: 'llm' | 'rule-based' | 'hybrid';
    model: string;
    escalatedToSonnet: boolean;
  };

  metadata: {
    // NEW: KG State Tracking (Document-Level)
    kgState?: {
      status: 'NOT_ENRICHED' | 'ENRICHED' | 'SKIPPED' | 'NEEDS_RECLASSIFICATION';
      enrichedAt?: Date;
      skippedReason?: 'NO_TAXONOMY' | 'KG_DISABLED';
      taxonomyVersion?: string;
      needsReclassification: boolean;
    };

    // Existing fields
    fileType?: string;
    pageCount?: number;
  };

  createdAt: Date;
  updatedAt: Date;
}
```

### 6.3 MongoDB: search_chunks (Updated)

```typescript
interface SearchChunk {
  _id: ObjectId;
  documentId: ObjectId;
  tenantId: string;
  indexId: string;
  content: string;

  metadata: {
    // NEW: KG Entities (Chunk-Level, scoped by document classification)
    entities?: Array<{
      type: string;
      name: string;
      dataType: string;
      rawValue: string;
      normalizedValue: any;
      text: string;
      start: number;
      end: number;
      extractionMethod: 'regex' | 'llm';
      confidence: number;
      productType: string; // Inherited from document classification
      context: {
        chunkScope: string;
        inScopeMatch: boolean;
        attributeApplicable: boolean;
      };
    }>;

    // Existing fields
    page?: number;
    section?: string;
  };

  embedding: number[];
  createdAt: Date;
  updatedAt: Date;
}
```

### 6.3 Vector Database: Metadata Schema

```typescript
// Vector DB entry (Qdrant/Pinecone)
{
  id: "chunk_100",
  vector: [0.123, -0.456, /* ... 1536 dimensions */],

  metadata: {
    // Identifiers
    tenantId: "tenant_123",
    indexId: "index_456",
    documentId: "doc_789",
    chunkId: "chunk_100",

    // DUPLICATED: Content (for fast display)
    content: "Our Platinum Rewards credit card offers 2% cashback...",

    // DUPLICATED: Classification (for filtering)
    primaryProduct: "credit_card",
    secondaryProducts: ["rewards_program"],
    department: "Card Services",
    category: "cards",
    confidence: 0.87,

    // KG metadata
    kgEnriched: true,
    kgEnrichedAt: "2026-02-25T10:10:00Z",

    // Timestamps
    createdAt: "2026-02-25T10:00:00Z"
  }
}
```

### 6.4 Neo4j: Graph Schema

```cypher
// Taxonomy nodes (created during setup)
(:Domain {id, name, version, tenantId, indexId})
(:Category {id, name, department})
(:Product {id, name, department, subDepartment, disambiguationKeywords})
(:Attribute {id, name, dataType, applicableTo, notApplicableTo})

// Taxonomy relationships
(Domain)-[:HAS_CATEGORY]->(Category)
(Category)-[:HAS_PRODUCT]->(Product)
(Product)-[:HAS_ATTRIBUTE]->(Attribute)
(Product)-[:EXCLUDES {reasoning}]->(Product)

// Document nodes (created during enrichment)
(:Document {id, tenantId, indexId, title, summary})

// Document relationships (DOCUMENT-LEVEL CLASSIFICATION)
(Document)-[:CLASSIFIED_AS {confidence, classifiedAt, model, escalatedToSonnet}]->(Product)

// Entity nodes (created during chunk entity extraction)
(:EntityInstance {
  id,
  attributeId,
  value,
  normalizedValue,
  chunkId,
  documentId,
  productType,
  confidence
})

// Entity relationships
(EntityInstance)-[:INSTANCE_OF]->(Attribute)
(EntityInstance)-[:BELONGS_TO]->(Product)
(EntityInstance)-[:EXTRACTED_FROM_DOCUMENT]->(Document)
```

---

## Worker Implementation

### 7.1 KG Enrichment Worker (Index-Level)

```typescript
// apps/search-ai/src/workers/kg-enrichment-worker.ts

import { Queue, Worker, Job } from 'bullmq';
import { LLMClient } from '@abl/compiler/platform/llm';
import { getVectorStore } from '@agent-platform/search-ai/services/vector-store';
import { TaxonomyLoaderService } from '../services/taxonomy-loader.service';
import { DocumentClassifierService } from '../services/document-classifier.service';
import { EntityExtractorService } from '../services/entity-extractor.service';
import { TaxonomyGraphService } from '../services/knowledge-graph/taxonomy-graph.service';

interface KGEnrichmentJobData {
  indexId: string;
  tenantId: string;
  filter?: {
    status?: ('NOT_ENRICHED' | 'SKIPPED')[];
    uploadedAfter?: string;
  };
  options?: {
    batchSize?: number;
    parallelBatches?: number;
    retrySkipped?: boolean;
  };
  priority: 'low' | 'normal' | 'high';
}

export class KGEnrichmentWorker {
  private queue: Queue;
  private worker: Worker;

  // REUSE existing services
  private llmClient: LLMClient;
  private vectorStore: VectorStore;

  // NEW services
  private taxonomyLoader: TaxonomyLoaderService;
  private documentClassifier: DocumentClassifierService;
  private entityExtractor: EntityExtractorService;
  private taxonomyGraph: TaxonomyGraphService;

  constructor() {
    // REUSE existing LLM client (provider-agnostic)
    this.llmClient = new LLMClient(); // Uses default provider
    this.vectorStore = getVectorStore();

    // NEW services (inject LLM client)
    this.taxonomyLoader = new TaxonomyLoaderService(this.llmClient);
    this.documentClassifier = new DocumentClassifierService(this.llmClient);
    this.entityExtractor = new EntityExtractorService(this.llmClient);
    this.taxonomyGraph = new TaxonomyGraphService(config.knowledgeGraph);

    // Create queue
    this.queue = new Queue('kg-enrichment', {
      connection: redisConnection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: 'exponential', delay: 5000 },
      },
    });

    // Create worker
    this.worker = new Worker('kg-enrichment', this.processJob.bind(this), {
      connection: redisConnection,
      concurrency: 5,
    });
  }

  async processJob(job: Job<KGEnrichmentJobData>) {
    const { indexId, tenantId, filter, options } = job.data;
    const batchSize = options?.batchSize || 50;

    // Step 1: Check if taxonomy exists
    const taxonomy = await this.taxonomyLoader.getTaxonomy(tenantId, indexId);

    if (!taxonomy) {
      // Mark documents as SKIPPED
      await SearchDocument.updateMany(
        {
          tenantId,
          indexId,
          'metadata.kgState.status': { $in: ['NOT_ENRICHED', null] },
        },
        {
          $set: {
            'metadata.kgState': {
              status: 'SKIPPED',
              skippedReason: 'NO_TAXONOMY',
              needsReclassification: false,
            },
          },
        },
      );

      return {
        status: 'SKIPPED',
        reason: 'NO_TAXONOMY',
      };
    }

    // Step 2: Build query filter for DOCUMENTS (not chunks!)
    const docQuery: any = {
      tenantId,
      indexId,
      summary: { $ne: null }, // Only process documents with summaries (already generated!)
    };
    const statusFilter = ['NOT_ENRICHED'];
    if (options?.retrySkipped) {
      statusFilter.push('SKIPPED');
    }
    docQuery['metadata.kgState.status'] = { $in: statusFilter };

    // Step 3: Count and process DOCUMENTS
    const totalDocuments = await SearchDocument.countDocuments(docQuery);
    let processed = 0;
    const stats = {
      documentsClassified: 0,
      chunksEnriched: 0,
      entitiesExtracted: 0,
      neo4jLinksCreated: 0,
      llmCallsMade: 0,
      llmEscalations: 0,
    };

    // Step 4: Process DOCUMENTS using cursor (memory efficient)
    const cursor = SearchDocument.find(docQuery).cursor();
    let batch: any[] = [];

    for await (const document of cursor) {
      batch.push(document);

      if (batch.length === batchSize) {
        await this.processDocumentBatch(batch, taxonomy, stats);
        processed += batch.length;
        batch = [];
        await job.updateProgress((processed / totalDocuments) * 100);
      }
    }

    // Process remaining documents
    if (batch.length > 0) {
      await this.processDocumentBatch(batch, taxonomy, stats);
      processed += batch.length;
      await job.updateProgress(100);
    }

    return { status: 'COMPLETED', documentsProcessed: processed, stats };
  }

  private async processDocumentBatch(batch: any[], taxonomy: any, stats: any) {
    await Promise.all(
      batch.map(async (document) => {
        // Classify document using EXISTING SUMMARY (zero extra cost!)
        const classificationResult = await this.documentClassifier.classifyDocument(
          {
            title: document.originalReference,
            summary: document.summary, // Already generated during ingestion!
            entities: document.entities, // Already extracted!
            metadata: document.sourceMetadata,
          },
          taxonomy,
        );
        stats.llmCallsMade++;
        stats.documentsClassified++;
        if (classificationResult.escalatedToSonnet) {
          stats.llmEscalations++;
        }

        // Update MongoDB DOCUMENT with classification
        await SearchDocument.updateOne(
          { _id: document._id },
          {
            $set: {
              classification: classificationResult.classification,
              'metadata.kgState': {
                status: 'ENRICHED',
                enrichedAt: new Date(),
                taxonomyVersion: taxonomy.version,
                needsReclassification: false,
              },
            },
          },
        );

        // Create Neo4j document node and classification link
        await this.taxonomyGraph.linkDocumentToProduct({
          tenantId: document.tenantId,
          indexId: document.indexId,
          documentId: document._id.toString(),
          productId: classificationResult.classification.productScope.primaryProduct,
          confidence: classificationResult.classification.productScope.confidence,
          classifiedAt: new Date(),
        });
        stats.neo4jLinksCreated++;

        // Extract entities from document's chunks (scoped by document classification)
        const documentChunks = await SearchChunk.find({
          tenantId: document.tenantId,
          indexId: document.indexId,
          documentId: document._id,
        });

        for (const chunk of documentChunks) {
          // Extract entities (scoped by document's product type)
          const entities = await this.entityExtractor.extractEntities(
            chunk.content,
            taxonomy,
            classificationResult.classification.productScope.primaryProduct, // Document's scope!
          );
          stats.llmCallsMade++;
          stats.entitiesExtracted += entities.length;
          stats.chunksEnriched++;

          // Update chunk metadata with entities
          await SearchChunk.updateOne(
            { _id: chunk._id },
            {
              $set: {
                'metadata.entities': entities,
              },
            },
          );

          // Update Vector DB with DOCUMENT classification (propagate to all chunks)
          await this.vectorStore.update(chunk._id.toString(), {
            metadata: {
              tenantId: chunk.tenantId,
              indexId: chunk.indexId,
              documentId: document._id.toString(),

              // DUPLICATE: Content (for fast display)
              content: chunk.content,

              // DUPLICATE: Document classification (for filtering)
              primaryProduct: classificationResult.classification.productScope.primaryProduct,
              secondaryProducts: classificationResult.classification.productScope.secondaryProducts,
              confidence: classificationResult.classification.productScope.confidence,
              department: classificationResult.classification.department,
              category: classificationResult.classification.category,

              kgEnriched: true,
              kgEnrichedAt: new Date().toISOString(),
            },
          });

          // Create Neo4j entity instance nodes
          for (const entity of entities) {
            await this.taxonomyGraph.createEntityInstance({
              tenantId: document.tenantId,
              indexId: document.indexId,
              id: `${chunk._id}_${entity.type}_${entity.name}`,
              attributeId: entity.type,
              value: entity.rawValue,
              normalizedValue: entity.normalizedValue,
              chunkId: chunk._id.toString(),
              documentId: document._id.toString(),
              productType: classificationResult.classification.productScope.primaryProduct,
              confidence: entity.confidence,
            });
            stats.neo4jLinksCreated++;
          }
        }
      }),
    );
  }
}

export const kgEnrichmentWorker = new KGEnrichmentWorker();
```

---

## Job Flows

### 8.1 Typical Workflow: Bulk Upload

```
┌─────────────────────────────────────────────────────────────────────┐
│              Typical Workflow: Upload 1,000 Documents                │
└─────────────────────────────────────────────────────────────────────┘

Step 1: Admin uploads 1,000 documents (UI bulk upload)
├─ Each document processed by EXISTING ingestion worker
├─ Duration: 1,000 docs × 50s = ~14 hours (with parallel workers)
└─ Output: All documents SEARCHABLE (embeddings, basic metadata)

Step 2: Admin triggers KG enrichment (ONE API CALL for entire index)
├─ API: POST /api/knowledge-graph/indexes/:indexId/enrich
├─ Job queued: Process all 1,000 documents (200,000 chunks)
├─ Duration: 200,000 chunks × 2s / 100 parallel = ~66 minutes
└─ Output: Job ID returned, admin polls for progress

Step 3: Background worker processes all documents
├─ Loads taxonomy once (cached)
├─ Processes chunks in batches (100 chunks at a time)
├─ Updates MongoDB, vector DB, Neo4j as it goes
└─ Admin can monitor progress via polling endpoint

Step 4: Enrichment completes
├─ All documents marked as "KG_ENRICHED"
├─ All chunks have classification + entities
└─ Admin receives completion notification
```

### 8.2 Chunk State Machine

```
NOT_ENRICHED (Initial state after ingestion)
├─ classification: null
├─ metadata.kgState.status: 'NOT_ENRICHED'
└─ Transition: Enrichment job → ENRICHED or SKIPPED

SKIPPED (Taxonomy not available)
├─ classification: null
├─ metadata.kgState.skippedReason: 'NO_TAXONOMY'
└─ Transition: Taxonomy setup → NOT_ENRICHED (can retry)

ENRICHED (Successfully processed)
├─ classification: {...}
├─ metadata.entities: [...]
├─ metadata.kgState.status: 'ENRICHED'
└─ Transition: Taxonomy update → NEEDS_RECLASSIFICATION

NEEDS_RECLASSIFICATION (Taxonomy updated)
├─ classification: {...} (outdated)
├─ metadata.kgState.needsReclassification: true
└─ Transition: Re-classification job → ENRICHED (new taxonomy)
```

---

## Implementation Tasks

### Phase 1: Foundation (Weeks 1-2) - PRIORITY

| Task | Description                                                    | Effort  | Priority | Dependencies |
| ---- | -------------------------------------------------------------- | ------- | -------- | ------------ |
| #60  | Implement Neo4j service + taxonomy graph creation              | 2 days  | P0       | None         |
| #61  | Update SearchChunk schema with classification + kgState fields | 1 day   | P0       | None         |
| #53  | Implement TaxonomyLoader service (reuse LLMProvider)           | 2 days  | P0       | None         |
| #63  | Build taxonomy setup API + worker                              | 2 days  | P0       | #53, #60     |
| #66  | Create MongoDB indexes for KG queries                          | 0.5 day | P0       | #61          |

### Phase 2: Classification (Week 3)

| Task | Description                                                   | Effort | Priority | Dependencies |
| ---- | ------------------------------------------------------------- | ------ | -------- | ------------ |
| #54  | Implement ChunkClassifier service (Haiku + Sonnet escalation) | 3 days | P0       | #53          |
| #62  | Implement configurable confidence threshold per index         | 1 day  | P1       | #54          |
| #67  | Add classification cost tracking and monitoring               | 1 day  | P1       | #54          |

### Phase 3: Entity Extraction (Week 4)

| Task | Description                                              | Effort | Priority | Dependencies |
| ---- | -------------------------------------------------------- | ------ | -------- | ------------ |
| #55  | Implement EntityExtractor service with attribute scoping | 3 days | P0       | #53, #54     |
| #68  | Add regex extraction optimization for common patterns    | 1 day  | P1       | #55          |

### Phase 4: KG Enrichment (Week 5)

| Task | Description                                                    | Effort | Priority | Dependencies  |
| ---- | -------------------------------------------------------------- | ------ | -------- | ------------- |
| #69  | Implement KG enrichment worker (index-level processing)        | 3 days | P0       | #54, #55, #60 |
| #70  | Build enrichment API endpoint + polling                        | 2 days | P0       | #69           |
| #71  | Implement vector DB metadata update (with content duplication) | 1 day  | P0       | #69           |

### Phase 5: Re-Classification (Week 6)

| Task | Description                                                | Effort | Priority | Dependencies |
| ---- | ---------------------------------------------------------- | ------ | -------- | ------------ |
| #65  | Build taxonomy update workflow + re-classification trigger | 3 days | P1       | #63, #69     |
| #72  | Implement re-classification worker (chunk-level)           | 2 days | P1       | #69          |
| #73  | Add incremental re-classification support                  | 1 day  | P1       | #72          |

### Phase 6: Query Integration (Week 7)

| Task | Description                                                      | Effort | Priority | Dependencies |
| ---- | ---------------------------------------------------------------- | ------ | -------- | ------------ |
| #57  | Implement query-time disambiguation (impossible query detection) | 3 days | P0       | #54          |
| #74  | Implement multi-scope ranking algorithm                          | 2 days | P1       | #57          |
| #75  | Add query classification and filtering                           | 2 days | P0       | #54          |

### Phase 7: Testing & Documentation (Week 8)

| Task | Description                                                      | Effort | Priority | Dependencies |
| ---- | ---------------------------------------------------------------- | ------ | -------- | ------------ |
| #59  | Create real-world test datasets for KG disambiguation validation | 3 days | P1       | All above    |
| #76  | Add integration tests for KG enrichment pipeline                 | 2 days | P1       | All above    |
| #77  | Create admin UI for taxonomy management                          | 3 days | P2       | #63, #70     |
| #78  | Write deployment guide and operational runbook                   | 1 day  | P1       | All above    |

---

## Success Metrics

### Accuracy Metrics

- **Classification accuracy**: ≥90% (chunks correctly classified by product)
- **False relationship prevention**: ≥95% (no interest_rate extracted from debit_card)
- **Impossible query detection**: 100% (all invalid queries blocked)

### Performance Metrics

- **Time to searchable**: ≤60 seconds (document ingestion)
- **Time to KG-enriched**: ≤90 minutes (1,000 docs)
- **Query latency**: ≤100ms (with KG filtering)
- **Neo4j query time**: ≤10ms (taxonomy lookup)

### Cost Metrics

- **LLM cost per 1K docs**: ≤$1.50 (Haiku primary, 20% Sonnet escalation)
- **Storage cost per 100K chunks**: ≤$1.00/month
- **Re-classification cost**: ≤$1.00 per 100K chunks

---

## Appendix

### A. Domain Definition vs Organization Profile

| Aspect        | Domain Definition                                           | Organization Profile                                   |
| ------------- | ----------------------------------------------------------- | ------------------------------------------------------ |
| **Focus**     | WHAT (products, attributes, rules)                          | WHO (company identity, context, terminology)           |
| **Scope**     | Generic domain knowledge                                    | Company-specific details                               |
| **Content**   | Product hierarchy, attribute scoping, department boundaries | Company structure, product names, internal terminology |
| **Purpose**   | Define extractable entities and validation rules            | Provide context for ambiguous terms                    |
| **Frequency** | Stable (rarely changes)                                     | Dynamic (changes with business)                        |
| **Source**    | Platform-provided + customer overrides                      | Customer-provided (required)                           |
| **Example**   | "interest_rate applies to credit_card"                      | "NBB's Platinum Rewards Card has APR 15.99%-24.99%"    |

### B. LLM Usage Summary

| Operation            | Model               | When           | Cost per Call | Frequency      |
| -------------------- | ------------------- | -------------- | ------------- | -------------- |
| Taxonomy parsing     | Sonnet              | Setup          | $0.75         | Once per index |
| Chunk classification | Haiku (primary)     | Enrichment     | $0.0003       | Per chunk      |
| Chunk classification | Sonnet (escalation) | Low confidence | $0.003        | 20% of chunks  |
| Entity extraction    | Haiku               | Enrichment     | $0.0005       | Per chunk      |
| Query classification | Haiku               | Query time     | $0.0001       | Per query      |

### C. Glossary

- **Chunk**: Text segment (200-500 tokens) from document
- **Classification**: Mapping chunk to product scope (e.g., credit_card)
- **Entity**: Extracted data point (e.g., interest_rate: 18%)
- **Attribute**: Type of entity defined in taxonomy
- **Taxonomy**: Hierarchical structure of products + attributes
- **Domain Definition**: Generic product/attribute rules
- **Organization Profile**: Company-specific context
- **KG State**: Status of chunk enrichment (NOT_ENRICHED, ENRICHED, SKIPPED, NEEDS_RECLASSIFICATION)

---

**End of Final Design Document**

**Version**: 1.0
**Approved**: 2026-02-25
**Ready for**: Phase 1 Implementation
