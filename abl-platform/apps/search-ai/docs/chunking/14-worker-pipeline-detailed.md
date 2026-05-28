# Worker Pipeline - Complete Reference

**Status:** ✅ Fully Documented
**Last Updated:** 2026-02-24
**Workers Documented:** 16 workers across all document types

---

## Table of Contents

1. [Overview](#overview)
2. [Pipeline Entry Points](#pipeline-entry-points)
3. [Document Pipeline (PDF, DOCX, Images, Markdown, HTML, TXT)](#document-pipeline)
4. [Structured Data Pipeline (CSV, JSON, Excel)](#structured-data-pipeline)
5. [Worker Reference](#worker-reference)
6. [Queue Names](#queue-names)
7. [Job Data Structures](#job-data-structures)
8. [Error Handling and Retries](#error-handling-and-retries)
9. [Concurrency and Scaling](#concurrency-and-scaling)
10. [Monitoring and Debugging](#monitoring-and-debugging)

---

## Overview

The search-ai ingestion pipeline uses **BullMQ workers** backed by Redis for distributed job processing. All workers are stateless and can run on multiple pods for horizontal scaling.

**Architecture Principles:**

- **Asynchronous:** Upload returns immediately, processing happens in background
- **Distributed:** Workers run on multiple pods, jobs distributed via Redis queues
- **Resilient:** Automatic retries with exponential backoff
- **Observable:** Progress tracking, status updates, error reporting
- **Tenant-Isolated:** Every job includes tenantId, enforced at query level

**Total Workers:** 16
**Entry Points:** 2 (document ingestion, structured data ingestion)
**Terminal Stage:** embedding-worker (marks documents as INDEXED)

---

## Pipeline Entry Points

### 1. Document Upload (PDF, DOCX, Images, Markdown, HTML, TXT)

**API Endpoint:**

```http
POST /api/:indexId/documents/upload
Content-Type: multipart/form-data

file: [document file]
metadata: {"title": "...", "author": "..."}
```

**Supported Formats:** 14 formats via docling-service

- **Documents:** PDF, DOCX, DOC, PPTX, PPT
- **Images:** PNG, JPEG, JPG, TIFF, BMP, WEBP
- **Markup:** HTML, Markdown (MD)
- **Text:** TXT (via LlamaIndex)

**Flow:**

```
Upload → Create SearchDocument → Enqueue ingestion-worker
```

**Initial Status:** `DocumentStatus.PENDING`

---

### 2. Structured Data Upload (CSV, JSON, Excel)

**API Endpoint (Two-Phase):**

**Phase 1: Analyze**

```http
POST /api/:indexId/ingest/analyze
Content-Type: multipart/form-data

file: [CSV/JSON/Excel file]
```

Returns: Schema detection, cost estimates, quality warnings

**Phase 2: Finalize**

```http
POST /api/:indexId/ingest/finalize
Content-Type: application/json

{
  "analysisId": "...",
  "schema": { ... }
}
```

Returns: `jobId` for structured-data-ingestion-worker

**Flow:**

```
Analyze → User confirms schema → Finalize → Enqueue structured-data-ingestion-worker
```

---

## Document Pipeline

**Complete Flow:** 14 stages with optional branches

```
┌────────────────────────────────────────────────────────────────────┐
│ STAGE 1: Entry Point (ingestion-worker)                           │
│ - Load source documents                                            │
│ - Dedup by contentHash                                             │
│ - Mark as PENDING                                                  │
│ - Enqueue extraction jobs                                          │
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│ STAGE 2: Extraction (docling-extraction-worker)                   │
│ - Download document from S3/URL                                    │
│ - Call docling-service (14 formats supported)                      │
│ - Extract: pages, layout, tables, images, screenshots              │
│ - Upload assets to S3 (if enabled)                                 │
│ - Create DocumentPage records (MongoDB)                            │
│ - Mark as EXTRACTED                                                │
│ - Enqueue page-processing jobs (batches of 10 pages)               │
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│ STAGE 3: Page Processing (page-processing-worker)                 │
│ - Load batch of 10 pages                                           │
│ - Markdown-aware chunking (if .md file)                            │
│ - Progressive summarization (LLM, optional)                        │
│ - Question synthesis (LLM, optional)                               │
│ - Create SearchChunk records                                       │
│ - Create ChunkQuestion records                                     │
│ - Mark pages as PROCESSED                                          │
│ - Enqueue next batch OR enrichment-worker (if last batch)          │
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│ STAGE 4: Enrichment (enrichment-worker) - OPTIONAL                │
│ - Load all chunks for document                                     │
│ - Entity extraction (stub - NER service integration pending)       │
│ - Language detection (stub)                                        │
│ - Summarization (stub)                                             │
│ - Update chunk canonicalMetadata                                   │
│ - Mark document as ENRICHED                                        │
│ - Enqueue parallel jobs (Stage 5a, 5b, 5c) if enabled              │
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             ├─────────────────────────────────┐
                             │                                 │
                             ▼                                 ▼
┌──────────────────────────────────────┐  ┌──────────────────────────────────────┐
│ STAGE 5a: Knowledge Graph (optional) │  │ STAGE 5b: Vision (optional)          │
│ (knowledge-graph-worker)             │  │ (visual-enrichment-worker)           │
│ - Extract entities (NER + regex)     │  │ - Page-by-page visual analysis       │
│ - Extract references (citations)     │  │ - Progressive visual context         │
│ - Co-occurrence analysis (IDF)       │  │ - Enrich text summaries with vision  │
│ - Build Neo4j graph                  │  │ - Enhance questions with visuals     │
│ - Update chunk metadata              │  │ - Chain context across pages         │
└──────────────────────────────────────┘  └──────────────────────────────────────┘
                             │
                             │
                             ▼
┌──────────────────────────────────────┐
│ STAGE 5c: Question Synthesis         │
│ (question-synthesis-worker)          │
│ - Generate 3-5 questions per chunk   │
│ - Store in ChunkQuestion collection  │
│ - Optional: Generate embeddings      │
└──────────────────────────────────────┘
                             │
                             │ (All parallel workers complete)
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│ STAGE 6: Embedding (embedding-worker) - TERMINAL                  │
│ - Load all chunks for document                                     │
│ - Batch embed chunks (50 per batch)                                │
│ - Resolve OpenSearch index name via IndexRegistry                  │
│ - Upsert vectors to OpenSearch/Qdrant/Pinecone                     │
│ - Mark chunks as INDEXED                                           │
│ - Mark document as INDEXED                                         │
└────────────────────────────────────────────────────────────────────┘
```

### Optional Parallel Stages (Configurable per Index)

```
┌──────────────────────────────────────────────────────────────────┐
│ STAGE 7: Tree Building (tree-building-worker) - OPTIONAL        │
│ - Build hierarchical structure from headings                     │
│ - Store in ChunkHierarchy collection                             │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ STAGE 8: Noise Detection (noise-detection-worker) - OPTIONAL    │
│ - Detect low-quality content (boilerplate, disclaimers)          │
│ - Mark noisy chunks in metadata                                  │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ STAGE 9: Scope Classification (scope-classification-worker)     │
│ - Classify chunk scope (global, section, page)                  │
│ - Store in ChunkScope collection                                │
└──────────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────────┐
│ STAGE 10: Canonical Mapping (canonical-mapper-worker)           │
│ - Apply field mappings (source → canonical schema)              │
│ - Transform values (lowercase, split, date format, etc.)        │
│ - Update chunk canonicalMetadata                                │
└──────────────────────────────────────────────────────────────────┘
```

---

## Structured Data Pipeline

**Simplified Flow:** 2 stages (no enrichment, no vision, no questions)

```
┌────────────────────────────────────────────────────────────────────┐
│ STAGE 1: Structured Data Ingestion                                │
│ (structured-data-ingestion-worker)                                │
│                                                                    │
│ - Parse file (CSV via papaparse, JSON, Excel via xlsx)            │
│ - Detect schema: tabular vs nested                                │
│ - Create ClickHouse table (tenantId, indexId, tableId)            │
│ - Insert all rows into ClickHouse                                 │
│ - Create 1 metadata-only chunk in MongoDB SearchChunk             │
│   * chunkType: 'table_metadata'                                   │
│   * content: JSON.stringify(metadataChunk)                        │
│   * metadata: { tableName, schema, sampleRows, statistics }       │
│ - Mark chunks as PENDING                                          │
│ - Enqueue embedding-worker                                        │
└────────────────────────────┬───────────────────────────────────────┘
                             │
                             ▼
┌────────────────────────────────────────────────────────────────────┐
│ STAGE 2: Embedding (embedding-worker) - TERMINAL                  │
│                                                                    │
│ - Load metadata chunk                                              │
│ - Build embedding input:                                           │
│   * Table name                                                     │
│   * Display name                                                   │
│   * Description                                                    │
│   * Column names + descriptions                                    │
│   * Sample rows (first 5)                                          │
│ - Generate 1 embedding for metadata chunk                          │
│ - Upsert to vector store                                           │
│ - Mark chunk as INDEXED                                            │
│ - Mark document as INDEXED                                         │
└────────────────────────────────────────────────────────────────────┘
```

**Key Differences from Document Pipeline:**

| Aspect              | Document Pipeline                  | Structured Data Pipeline               |
| ------------------- | ---------------------------------- | -------------------------------------- |
| **Chunks Created**  | N chunks (1 per page/section)      | 1 metadata-only chunk                  |
| **Enrichment**      | Yes (optional)                     | No                                     |
| **Vision**          | Yes (optional)                     | No                                     |
| **Questions**       | Yes (optional)                     | No                                     |
| **Knowledge Graph** | Yes (optional)                     | No                                     |
| **Data Storage**    | MongoDB SearchChunk                | ClickHouse (data) + MongoDB (metadata) |
| **Embedding Input** | Page content + summary + questions | Metadata: schema + sample rows         |
| **Cost**            | $0.735/doc (with full enrichment)  | $0.0003/doc (metadata only)            |

---

## Worker Reference

### 1. ingestion-worker

**Queue:** `QUEUE_INGESTION`
**Concurrency:** 3
**Triggered By:** Document upload API
**Triggers:** extraction-worker (legacy) OR docling-extraction-worker

**Purpose:** Entry point for document ingestion pipeline. Discovers documents, deduplicates, and fans out extraction jobs.

**Job Data:**

```typescript
{
  indexId: string;
  sourceId: string;
  tenantId: string;
  documentIds?: string[];  // Optional: specific documents to process
  options?: {
    forceExtract?: boolean;  // Re-extract even if already indexed
    batchSize?: number;      // Default: 100
  }
}
```

**Logic:**

1. Load SearchSource record
2. Mark source as SYNCING
3. Load SearchDocument records (all or specific documentIds)
4. Skip documents with status=INDEXED (unless forceExtract)
5. Dedup by contentHash (skip duplicates)
6. Mark documents as PENDING
7. Enqueue extraction jobs (one per document)
8. Update source stats (documentCount, lastSyncAt)
9. Mark source as ACTIVE (or ERROR if failed)

**Error Handling:**

- Retries: 3 attempts with exponential backoff (5s, 25s, 125s)
- On failure: Mark source status=ERROR, set syncError message

**File:** `apps/search-ai/src/workers/ingestion-worker.ts:1`

---

### 2. docling-extraction-worker

**Queue:** `QUEUE_DOCLING_EXTRACTION`
**Concurrency:** 2
**Triggered By:** ingestion-worker
**Triggers:** page-processing-worker (batches of 10 pages)

**Purpose:** Extracts structured content from 14 document formats using docling-service (Python microservice with layout analysis, OCR, table extraction, image extraction, screenshot rendering).

**Supported Formats:** 14

- PDF, DOCX, DOC, PPTX, PPT (Docling path)
- PNG, JPEG, JPG, TIFF, BMP, WEBP (Image path)
- HTML, Markdown (Markup path)
- TXT (LlamaIndex path - single page extraction)

**Job Data:**

```typescript
{
  indexId: string;
  documentId: string;
  sourceUrl: string; // S3 URL or HTTP URL
  tenantId: string;
}
```

**Logic:**

1. Load SearchDocument record
2. Mark document as EXTRACTING
3. Download document from sourceUrl
4. Call docling-service unified extraction:
   - POST `/extract` with multipart/form-data
   - Options: extractImages=true, extractTables=true, renderScreenshots=true, ocrEnabled=true
5. Receive extraction result:
   - pages: Array of {pageNumber, text, layout, tables, images, screenshot}
   - metadata: {pageCount, hasOCR, totalTables, totalImages, processingTime}
   - structure: {outline, documentType}
6. Upload images/screenshots to S3 (if USE_S3_STORAGE=true)
7. Create DocumentPage records (MongoDB) for each page:
   - Store text, layout, tables, imageUrls, screenshotUrl
8. Mark document as EXTRACTED
9. Enqueue page-processing jobs in batches of 10 pages

**Error Handling:**

- Retries: 3 attempts with exponential backoff (5s, 25s, 125s)
- Timeout: 5 minutes per document
- On failure: Mark document status=ERROR, set processingError message

**File:** `apps/search-ai/src/workers/docling-extraction-worker.ts:1`

---

### 3. extraction-worker (Legacy)

**Queue:** `QUEUE_EXTRACTION`
**Concurrency:** 5
**Status:** Deprecated (use docling-extraction-worker instead)

**Purpose:** Original extraction worker using direct PDF parsing. Replaced by docling-extraction-worker which supports 14 formats.

**File:** `apps/search-ai/src/workers/extraction-worker.ts:1`

---

### 4. page-processing-worker

**Queue:** `QUEUE_PAGE_PROCESSING`
**Concurrency:** 5
**Triggered By:** docling-extraction-worker
**Triggers:** enrichment-worker (after last batch)

**Purpose:** Converts DocumentPages to SearchChunks with progressive summarization and question generation.

**Job Data:**

```typescript
{
  indexId: string;
  documentId: string;
  tenantId: string;
  pageIds: string[];                // Batch of 10 page IDs
  previousPageSummary: string | null;  // Context from previous batch
}
```

**Logic:**

1. Resolve per-index LLM config (llmConfig)
2. Load batch of pages (sorted by pageNumber)
3. Detect document type:
   - **Markdown:** Use structure-aware chunking (split on H1/H2, preserve code blocks/tables/lists)
   - **Other:** Page-based chunking
4. For each chunk:
   - Generate progressive summary (if enabled):
     - LLM call with: current page content + previous page summary → new summary
     - Chains context across pages for continuity
     - Cost: ~$0.0001/page (Gemini Flash)
   - Generate questions (if enabled):
     - LLM call: page content → 3-5 answerable questions
     - Store in ChunkQuestion collection
     - Cost: ~$0.00017/chunk (Gemini Flash)
   - Create SearchChunk record:
     - content: page text or markdown section
     - metadata: {progressiveSummary, sectionPath, pageNumber}
5. Mark pages as PROCESSED
6. Enqueue next page-processing batch (if more pages remain)
7. Enqueue enrichment-worker (if last batch)

**Per-Index Configuration:**

```typescript
llmConfig.useCases.progressiveSummarization: {
  enabled: boolean;
  provider: 'openai' | 'anthropic' | 'google';
  model: string;
  maxTokens: number;
}
llmConfig.useCases.questionSynthesis: {
  enabled: boolean;
  provider: 'openai' | 'anthropic' | 'google';
  model: string;
  questionsPerChunk: number;  // Default: 3
}
```

**Error Handling:**

- Retries: 3 attempts with exponential backoff (5s, 25s, 125s)
- LLM failures: Log warning, skip summarization/questions (continue with text-only chunking)

**File:** `apps/search-ai/src/workers/page-processing-worker.ts:1`

---

### 5. enrichment-worker

**Queue:** `QUEUE_ENRICHMENT`
**Concurrency:** 5
**Triggered By:** page-processing-worker (after last batch)
**Triggers:** knowledge-graph-worker, visual-enrichment-worker, question-synthesis-worker, embedding-worker

**Purpose:** Enriches chunks with entity extraction, language detection, and summarization. Currently stubbed - real NLP services integration pending.

**Job Data:**

```typescript
{
  indexId: string;
  documentId: string;
  chunkIds: string[];
  tenantId: string;
}
```

**Logic:**

1. Load document
2. Load all chunks
3. For each chunk:
   - Extract entities (stub - returns mock entities)
   - Detect language (stub - returns 'en')
   - Update chunk canonicalMetadata
4. Deduplicate entities across chunks
5. Generate document-level summary (stub)
6. Update SearchDocument: {entities, summary, language, status=ENRICHED}
7. Enqueue parallel jobs (if enabled):
   - knowledge-graph-worker (if config.knowledgeGraph.enabled)
   - visual-enrichment-worker (if config.vision.enabled)
   - question-synthesis-worker (if config.questionSynthesis.enabled)
   - embedding-worker (always)

**Stub Implementation:**

```typescript
function enrichChunkContent(content: string) {
  return {
    entities: [{ type: 'ORG', value: 'Example Corp', confidence: 0.9 }],
    language: 'en',
    metadata: {},
  };
}
```

**Future Integration:**

- spaCy for NER (entity extraction)
- fasttext for language detection
- LLM for summarization

**File:** `apps/search-ai/src/workers/enrichment-worker.ts:1`

---

### 6. knowledge-graph-worker

**Queue:** `QUEUE_KNOWLEDGE_GRAPH`
**Concurrency:** 2
**Triggered By:** enrichment-worker (optional)
**Runs In Parallel With:** visual-enrichment-worker, question-synthesis-worker, embedding-worker

**Purpose:** Extracts entities and relationships, builds knowledge graph in Neo4j.

**Job Data:**

```typescript
{
  indexId: string;
  documentId: string;
  chunkIds: string[];
  tenantId: string;
}
```

**Logic:**

1. Resolve per-index LLM config
2. Check if llmConfig.useCases.knowledgeGraph.enabled (skip if disabled)
3. Create KnowledgeGraphService with Neo4j connection
4. Load all chunks
5. Batch process chunks:
   - Entity extraction (NER + regex patterns)
   - Explicit reference extraction (citations, cross-references)
   - Co-occurrence analysis with IDF weighting
   - Build Neo4j graph:
     - Nodes: Entities with type, confidence, tenantId, indexId
     - Edges: Relationships (MENTIONS, CO_OCCURS, REFERENCES)
6. Update chunk metadata:
   - metadata.entities: [{text, type, start, end, confidence}]
   - metadata.references: [{text, type, identifier}]
   - metadata.entityIds: [Neo4j node IDs]
7. Update document metadata:
   - metadata.knowledgeGraph: {totalEntities, totalReferences, totalRelationships, processedAt}

**Per-Index Configuration:**

```typescript
llmConfig.useCases.knowledgeGraph: {
  enabled: boolean;
  enableCoOccurrence: boolean;
}
```

**Global Infrastructure Config:**

```typescript
config.knowledgeGraph: {
  neo4jUrl: string;
  neo4jUser: string;
  neo4jPassword: string;
  minIdfThreshold: number;  // Default: 0.1
}
```

**Error Handling:**

- Retries: 2 attempts with exponential backoff (10s, 100s)
- Neo4j failures: Log error, update document with partial results

**File:** `apps/search-ai/src/workers/knowledge-graph-worker.ts:1`

---

### 7. visual-enrichment-worker

**Queue:** `QUEUE_VISUAL_ENRICHMENT`
**Concurrency:** 3 (rate limited: 10 jobs/minute due to LLM vision costs)
**Triggered By:** enrichment-worker (optional) OR page-processing-worker
**Runs In Parallel With:** knowledge-graph-worker, question-synthesis-worker, embedding-worker

**Purpose:** Page-by-page visual analysis with progressive context chaining. Analyzes images/screenshots, enriches text summaries with visual insights, enhances questions.

**Job Data:**

```typescript
{
  tenantId: string;
  indexId: string;
  documentId: string;
  pageNumber: number;
  chunkId: string;
}
```

**Logic:**

1. Resolve per-index LLM config
2. Check if llmConfig.useCases.vision.enabled (skip if disabled)
3. Load SearchChunk (Phase 2 text-based outputs)
4. Load textSummary from chunk.metadata.progressiveSummary
5. Load questions from ChunkQuestion collection
6. Load previous page's visual context (if pageNumber > 1):
   - Query: SearchChunk where metadata.pageNumber = pageNumber - 1
   - Extract: chunk.metadata.visualAnalysis.visualContext
7. Load DocumentPage for images/screenshot
8. Call VisionService with:
   - Current page images/screenshot
   - Text summary from Phase 2
   - Questions from Phase 2
   - Previous visual context
9. Receive vision analysis:
   - visualDescription: Description of images/diagrams/charts
   - visualContext: Key visual elements for next page
   - enrichedSummary: Text summary + visual insights
   - enrichedQuestions: Questions enhanced with visual references
10. Update SearchChunk:
    - metadata.visualAnalysis: {visualDescription, visualContext, enrichedSummary}
11. Update ChunkQuestion records:
    - Merge visual references into question text
12. Enqueue next page visual enrichment (if more pages remain)

**Per-Index Configuration:**

```typescript
llmConfig.useCases.vision: {
  enabled: boolean;
  provider: 'openai' | 'anthropic' | 'google';
  model: string;  // e.g., 'gpt-4o', 'claude-3-5-sonnet-20241022'
  maxTokens: number;
}
```

**Cost:** ~$0.01-0.05/page (depends on model and image count)

**Error Handling:**

- Retries: 3 attempts with exponential backoff (5s, 25s, 125s)
- Vision API failures: Log error, skip visual enrichment (continue with text-only)

**File:** `apps/search-ai/src/workers/visual-enrichment-worker.ts:1`

---

### 8. document-visual-enrichment-worker

**Queue:** `QUEUE_VISUAL_ENRICHMENT` (shared with visual-enrichment-worker)
**Concurrency:** 3
**Job Name:** `enrich-document`
**Triggered By:** enrichment-worker (optional)

**Purpose:** Document-level visual summarization (aggregates visual insights across all pages).

**Job Data:**

```typescript
{
  tenantId: string;
  indexId: string;
  documentId: string;
}
```

**Logic:**

1. Load all SearchChunks for document
2. Aggregate visual insights:
   - Collect all chunk.metadata.visualAnalysis.visualDescription
   - Identify key visual themes (diagrams, charts, tables, images)
3. Generate document-level visual summary (LLM call)
4. Update SearchDocument:
   - metadata.visualSummary: Document-wide visual overview

**Use Case:** Document retrieval with visual context ("Find documents with flow charts about authentication")

**File:** `apps/search-ai/src/workers/document-visual-enrichment-worker.ts:1`

---

### 9. question-synthesis-worker

**Queue:** `QUEUE_QUESTION_SYNTHESIS`
**Concurrency:** 3
**Triggered By:** enrichment-worker (optional) OR page-processing-worker
**Runs In Parallel With:** knowledge-graph-worker, visual-enrichment-worker, embedding-worker

**Purpose:** Generates 3-5 answerable questions per chunk for question-based retrieval. Stores results in ChunkQuestion collection.

**Job Data:**

```typescript
{
  tenantId: string;
  indexId: string;
  documentId: string;
}
```

**Logic:**

1. Resolve per-index LLM config
2. Check if llmConfig.useCases.questionSynthesis.enabled (skip if disabled)
3. Load all SearchChunks for document
4. Load SearchDocument for context (title, type)
5. Batch generate questions:
   - For each chunk: LLM call with chunk content + document context
   - Generate questionsPerChunk questions (default: 3)
   - Question types: factual, analytical, conceptual, procedural, comparative
6. Store questions in ChunkQuestion collection:
   - tenantId, indexId, documentId, chunkId
   - question: string
   - questionType: string
   - confidence: number
   - questionIndex: number
   - vectorId: null (populated by embedding worker if enableEmbedding=true)
7. Update chunk metadata with question count

**Per-Index Configuration:**

```typescript
llmConfig.useCases.questionSynthesis: {
  enabled: boolean;
  provider: 'openai' | 'anthropic' | 'google';
  model: string;
  questionsPerChunk: number;  // Default: 3
  maxTokens: number;
  enableEmbedding: boolean;  // Embed questions separately
}
```

**Cost:** ~$0.00017/chunk (Gemini Flash for 3 questions)

**File:** `apps/search-ai/src/workers/question-synthesis-worker.ts:1`

---

### 10. embedding-worker

**Queue:** `QUEUE_EMBEDDING`
**Concurrency:** 5
**Triggered By:** enrichment-worker (documents) OR structured-data-ingestion-worker (CSV/JSON/Excel)
**Terminal Stage:** Marks documents/chunks as INDEXED

**Purpose:** Generates vector embeddings for all chunks, upserts to vector store (OpenSearch/Qdrant/Pinecone). Terminal stage of ingestion pipeline.

**Job Data:**

```typescript
{
  indexId: string;
  documentId: string;
  chunkIds: string[];
  tenantId: string;
}
```

**Logic:**

1. Load SearchIndex and SearchDocument
2. Mark document as EMBEDDING
3. Load all chunks (sorted by chunkIndex)
4. Get embedding provider (configured via env vars)
5. Get vector store (configured via env vars)
6. Resolve OpenSearch index name via IndexRegistry:
   - Tenant-scoped index name: `{tenantId}_{indexId}_{connectorId}`
7. Process chunks in batches (default: 50 chunks/batch):
   - Build embedding input per chunk type:
     - **Documents:** content + progressiveSummary + visualAnalysis + questions
     - **CSV/JSON:** tableName + displayName + description + column descriptions + sample rows
   - Call embedding provider (batch API)
   - Build VectorRecord for each chunk:
     - id: chunkId
     - vector: float array (1024 or 3072 dims)
     - metadata: {tenantId, indexId, documentId, chunkIndex, chunkType}
   - Upsert to vector store
   - Update SearchChunk: set vectorId
   - Mark chunk status=INDEXED
8. Mark document status=INDEXED
9. Update document indexedAt timestamp

**Embedding Providers:** Configured via env vars

- `EMBEDDING_PROVIDER`: 'openai' | 'cohere' | 'bge-m3' | 'custom'
- `EMBEDDING_MODEL`: Model name (e.g., 'text-embedding-3-small', 'bge-m3')
- `EMBEDDING_DIMENSIONS`: Vector dimensions (1024, 3072, etc.)
- `EMBEDDING_API_KEY`: Provider API key
- `EMBEDDING_BASE_URL`: Custom endpoint (for bge-m3-service)
- `EMBEDDING_MAX_BATCH_SIZE`: Chunks per batch (default: 50)

**Vector Stores:** Configured via env vars

- `VECTOR_STORE_PROVIDER`: 'opensearch' | 'qdrant' | 'pinecone' | 'pgvector'
- `VECTOR_STORE_URL`: Connection URL
- `VECTOR_STORE_API_KEY`: API key (if needed)

**Batch Size:** 50 chunks per batch (configurable via `INGESTION_EMBEDDING_BATCH_SIZE`)

**Error Handling:**

- Retries: 3 attempts with exponential backoff (5s, 25s, 125s)
- Embedding API failures: Mark document status=ERROR, set processingError
- Vector store failures: Retry batch, log errors

**File:** `apps/search-ai/src/workers/embedding-worker.ts:1`

---

### 11. structured-data-ingestion-worker

**Queue:** `structured-data-ingestion`
**Concurrency:** 5
**Triggered By:** Two-phase API (analyze → finalize)
**Triggers:** embedding-worker

**Purpose:** Parses CSV/JSON/Excel files, detects schema (tabular vs nested), inserts data into ClickHouse, creates metadata-only chunk in MongoDB.

**Job Data:**

```typescript
{
  tenantId: string;
  indexId: string;
  tableId: string;
  tableName: string;
  displayName: string;
  description: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    isEmbeddable: boolean;
    isFilterable: boolean;
  }>;
  primaryKey: string | null;
  fileBuffer: Buffer;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  metadata: any;
}
```

**Logic:**

1. Load SearchIndex
2. Parse file based on mimeType:
   - **CSV:** papaparse
   - **JSON:** JSON.parse + tabular detection
   - **Excel:** xlsx (first sheet)
3. Detect schema type:
   - **Tabular:** Array of flat objects, uniform schema, depth ≤ 2
   - **Nested:** Complex nested structures
4. Create ClickHouse table:
   - Table name: `data_{tenantId}_{indexId}_{tableId}`
   - Columns: tenantId, indexId, tableId, row_data (JSON)
5. Insert all rows into ClickHouse (bulk insert)
6. Build metadata chunk:
   - tableName, displayName, description
   - schema: {columns with types, isEmbeddable, isFilterable}
   - sampleRows: First 5 rows
   - statistics: {totalRows, embeddableColumns, filterableColumns, savingsPercent}
7. Create 1 SearchChunk in MongoDB:
   - chunkType: 'table_metadata'
   - content: JSON.stringify(metadataChunk)
   - metadata: metadataChunk
   - status: PENDING
8. Enqueue embedding-worker with chunkId

**Chunking Strategy:** Metadata-only (99.999% reduction)

- **Without metadata-only:** 100K rows × 10 columns = 1M chunks
- **With metadata-only:** 1 chunk (metadata) + ClickHouse (data)
- **Savings:** 99.999% chunk reduction, 99.998% embedding cost reduction

**File:** `apps/search-ai/src/workers/structured-data-ingestion-worker.ts:1`

---

### 12. canonical-mapper-worker

**Queue:** `QUEUE_CANONICAL_MAP`
**Concurrency:** 5
**Triggered By:** enrichment-worker (optional, when connectors are used)
**Runs In Parallel With:** Other enrichment workers

**Purpose:** Applies field mappings to transform source metadata into canonical fields. Used for multi-source data integration (Salesforce, HubSpot, etc.).

**Job Data:**

```typescript
{
  indexId: string;
  documentId: string;
  tenantId: string;
  connectorId?: string;
}
```

**Logic:**

1. Load SearchDocument
2. Load FieldMappings for connectorId (status=confirmed)
3. For each mapping:
   - Read source value from document.metadata (using sourcePath)
   - Apply transform (direct, lowercase, split, date_format, rename_value, extract, coalesce)
   - Write to canonicalMetadata[canonicalField]
4. Update SearchDocument: canonicalMetadata field
5. Update SearchChunks: Propagate canonicalMetadata to all chunks

**Transform Types:** 8 types

- **direct:** Copy as-is
- **lowercase:** Normalize to lowercase
- **split:** Split string by delimiter into array
- **date_format:** Parse and normalize to ISO 8601
- **rename_value:** Map source values to canonical values (value lookup)
- **extract:** Regex extraction
- **coalesce:** Try multiple source paths, return first non-null
- **compute:** Evaluate expression (stub)

**Use Case:** Unified queries across multiple sources

- Salesforce: `Contact.Email` → `email`
- HubSpot: `contact.properties.email` → `email`
- CSV: `customer_email` → `email`
- Query: `WHERE canonicalMetadata.email = 'user@example.com'` (works across all 3)

**File:** `apps/search-ai/src/workers/canonical-mapper-worker.ts:1`

---

### 13. tree-building-worker

**Queue:** `QUEUE_TREE_BUILDING`
**Concurrency:** 5
**Triggered By:** enrichment-worker (optional)
**Runs In Parallel With:** Other enrichment workers

**Purpose:** Builds hierarchical structure from document headings. Stores in ChunkHierarchy collection.

**Job Data:**

```typescript
{
  indexId: string;
  documentId: string;
  tenantId: string;
}
```

**Logic:**

1. Load all DocumentPages for document
2. Extract headings from layout:
   - H1, H2, H3, H4, H5, H6
   - Build parent-child relationships
3. Create ChunkHierarchy records:
   - tenantId, indexId, documentId, chunkId
   - level: 1-6
   - title: heading text
   - parentId: parent heading's chunkId
   - children: Array of child chunkIds
4. Update SearchChunk metadata:
   - metadata.hierarchy: {level, parentId, children}

**Use Case:** Hierarchical navigation, outline-based search

**File:** `apps/search-ai/src/workers/tree-building-worker.ts:1`

---

### 14. noise-detection-worker

**Queue:** `QUEUE_NOISE_DETECTION`
**Concurrency:** 5
**Triggered By:** enrichment-worker (optional)
**Runs In Parallel With:** Other enrichment workers

**Purpose:** Detects low-quality content (boilerplate, disclaimers, page numbers, headers/footers). Marks noisy chunks in metadata for filtering.

**Job Data:**

```typescript
{
  indexId: string;
  documentId: string;
  chunkIds: string[];
  tenantId: string;
}
```

**Logic:**

1. Load all chunks
2. For each chunk:
   - Check for boilerplate patterns (regex)
   - Check for short content (< 50 chars)
   - Check for high repetition (same text across multiple chunks)
   - Calculate noise score (0-1)
3. Update SearchChunk:
   - metadata.noiseScore: number
   - metadata.isNoisy: boolean (score > threshold)

**Noise Patterns:**

- "Page \d+ of \d+"
- "Copyright © \d{4}"
- "All rights reserved"
- Short chunks with no meaningful content

**Use Case:** Filter noisy chunks at query time (WHERE metadata.isNoisy = false)

**File:** `apps/search-ai/src/workers/noise-detection-worker.ts:1`

---

### 15. scope-classification-worker

**Queue:** `QUEUE_SCOPE_CLASSIFICATION`
**Concurrency:** 5
**Triggered By:** enrichment-worker (optional)
**Runs In Parallel With:** Other enrichment workers

**Purpose:** Classifies chunk scope (global, section, page) for retrieval optimization.

**Job Data:**

```typescript
{
  indexId: string;
  documentId: string;
  tenantId: string;
}
```

**Logic:**

1. Load all SearchChunks for document
2. For each chunk:
   - Analyze content scope:
     - **global:** Introduction, summary, conclusion (document-wide)
     - **section:** Section-specific content
     - **page:** Page-specific details
3. Create ChunkScope records:
   - tenantId, indexId, documentId, chunkId
   - scope: 'global' | 'section' | 'page'
   - confidence: number
4. Update SearchChunk:
   - metadata.scope: string

**Use Case:** Scope-aware retrieval (retrieve global chunks for broad questions, page chunks for specific details)

**File:** `apps/search-ai/src/workers/scope-classification-worker.ts:1`

---

### 16. multimodal-worker

**Queue:** `QUEUE_MULTIMODAL`
**Concurrency:** 3
**Triggered By:** enrichment-worker (optional)
**Runs In Parallel With:** Other enrichment workers

**Purpose:** Processes mixed content types (text + images + tables) with unified embedding.

**Job Data:**

```typescript
{
  indexId: string;
  documentId: string;
  chunkIds: string[];
  tenantId: string;
}
```

**Logic:**

1. Load all chunks
2. For each chunk:
   - Detect content types (text, table, image)
   - Extract multimodal features
   - Generate unified embedding (if provider supports multimodal)
3. Update chunk metadata:
   - metadata.contentTypes: ['text', 'table', 'image']
   - metadata.multimodalEmbedding: vector

**Status:** Optional (requires multimodal embedding provider)

**File:** `apps/search-ai/src/workers/multimodal-worker.ts:1`

---

## Queue Names

| Queue Name                  | Constant                     | Workers                                                     |
| --------------------------- | ---------------------------- | ----------------------------------------------------------- |
| `ingestion`                 | `QUEUE_INGESTION`            | ingestion-worker                                            |
| `extraction`                | `QUEUE_EXTRACTION`           | extraction-worker (legacy)                                  |
| `docling-extraction`        | `QUEUE_DOCLING_EXTRACTION`   | docling-extraction-worker                                   |
| `page-processing`           | `QUEUE_PAGE_PROCESSING`      | page-processing-worker                                      |
| `structured-data-ingestion` | (string literal)             | structured-data-ingestion-worker                            |
| `canonical-map`             | `QUEUE_CANONICAL_MAP`        | canonical-mapper-worker                                     |
| `enrichment`                | `QUEUE_ENRICHMENT`           | enrichment-worker                                           |
| `knowledge-graph`           | `QUEUE_KNOWLEDGE_GRAPH`      | knowledge-graph-worker                                      |
| `visual-enrichment`         | `QUEUE_VISUAL_ENRICHMENT`    | visual-enrichment-worker, document-visual-enrichment-worker |
| `question-synthesis`        | `QUEUE_QUESTION_SYNTHESIS`   | question-synthesis-worker                                   |
| `embedding`                 | `QUEUE_EMBEDDING`            | embedding-worker                                            |
| `tree-building`             | `QUEUE_TREE_BUILDING`        | tree-building-worker                                        |
| `noise-detection`           | `QUEUE_NOISE_DETECTION`      | noise-detection-worker                                      |
| `scope-classification`      | `QUEUE_SCOPE_CLASSIFICATION` | scope-classification-worker                                 |
| `multimodal`                | `QUEUE_MULTIMODAL`           | multimodal-worker                                           |

**Total Queues:** 15

---

## Job Data Structures

All job data interfaces defined in `apps/search-ai/src/workers/shared.ts:98`

### Base Fields (All Jobs)

```typescript
{
  tenantId: string; // Required: Tenant isolation
  indexId: string; // Required: Target index
  documentId: string; // Required: Document being processed
}
```

### IngestionJobData

```typescript
{
  jobId: string;
  indexId: string;
  sourceId: string;
  tenantId: string;
  documentIds?: string[];
  options?: {
    forceExtract?: boolean;
    forceEmbed?: boolean;
    skipEnrichment?: boolean;
    batchSize?: number;
  };
}
```

### ExtractionJobData

```typescript
{
  indexId: string;
  sourceId: string;
  documentId: string;
  tenantId: string;
}
```

### DoclingExtractionJobData

```typescript
{
  indexId: string;
  documentId: string;
  sourceUrl: string; // S3 URL or HTTP URL
  tenantId: string;
}
```

### PageProcessingJobData

```typescript
{
  indexId: string;
  documentId: string;
  tenantId: string;
  pageIds: string[];              // Batch of page IDs
  previousPageSummary: string | null;  // Context from previous batch
}
```

### StructuredDataIngestionJobData

```typescript
{
  tenantId: string;
  indexId: string;
  tableId: string;
  tableName: string;
  displayName: string;
  description: string;
  columns: Array<{
    name: string;
    type: string;
    nullable: boolean;
    isEmbeddable: boolean;
    isFilterable: boolean;
  }>;
  primaryKey: string | null;
  fileBuffer: Buffer;
  originalFilename: string;
  mimeType: string;
  fileSize: number;
  metadata: any;
}
```

### EnrichmentJobData

```typescript
{
  indexId: string;
  documentId: string;
  chunkIds: string[];
  tenantId: string;
}
```

### EmbeddingJobData

```typescript
{
  indexId: string;
  documentId: string;
  chunkIds: string[];
  tenantId: string;
}
```

### KnowledgeGraphJobData

```typescript
{
  indexId: string;
  documentId: string;
  chunkIds: string[];
  tenantId: string;
}
```

### VisualEnrichmentJobData

```typescript
{
  indexId: string;
  documentId: string;
  tenantId: string;
  pageNumber: number;
  chunkId: string;
}
```

### QuestionSynthesisJobData

```typescript
{
  tenantId: string;
  indexId: string;
  documentId: string;
  jobId?: string;
}
```

---

## Error Handling and Retries

### Retry Configuration

All workers use BullMQ retry mechanism with exponential backoff:

```typescript
{
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 5000  // 5 seconds base delay
  }
}
```

**Retry Schedule:**

- Attempt 1: Immediate
- Attempt 2: 5 seconds later
- Attempt 3: 25 seconds later
- Attempt 4: 125 seconds later (final)

**Exception:** knowledge-graph-worker uses 2 attempts with 10s base delay

### Failure Handling

**Document-Level Failures:**

1. Mark document status=ERROR
2. Set processingError field with error message
3. Stop pipeline (do not proceed to next stage)
4. Keep job in failed queue for manual inspection (7 days retention)

**Chunk-Level Failures:**

1. Log error
2. Mark specific chunk as failed (if applicable)
3. Continue processing other chunks
4. Partial success: Document marked INDEXED with some chunks failed

**LLM API Failures:**

- Progressive summarization: Skip summary, continue with text-only
- Question synthesis: Skip questions, continue with content
- Vision enrichment: Skip visual analysis, continue with text-only
- Do NOT fail entire pipeline for optional enrichment failures

### Dead Letter Queue

Failed jobs retained for 7 days:

```typescript
removeOnFail: {
  age: 604_800;
} // 7 days
```

Access failed jobs via BullMQ dashboard or Redis CLI:

```redis
LRANGE bull:{queueName}:failed 0 -1
```

---

## Concurrency and Scaling

### Per-Worker Concurrency

| Worker                           | Concurrency | Rationale                                                |
| -------------------------------- | ----------- | -------------------------------------------------------- |
| ingestion-worker                 | 3           | I/O bound (database queries)                             |
| docling-extraction-worker        | 2           | CPU bound (external service calls), slow (5 min timeout) |
| extraction-worker                | 5           | Legacy worker                                            |
| page-processing-worker           | 5           | LLM API bound (rate limited by provider)                 |
| enrichment-worker                | 5           | CPU bound (NLP processing)                               |
| knowledge-graph-worker           | 2           | External service (Neo4j) rate limiting                   |
| visual-enrichment-worker         | 3           | LLM vision API (expensive, rate limited: 10 jobs/min)    |
| question-synthesis-worker        | 3           | LLM API bound                                            |
| embedding-worker                 | 5           | Embedding API bound (batch size 50)                      |
| structured-data-ingestion-worker | 5           | I/O bound (ClickHouse inserts)                           |
| canonical-mapper-worker          | 5           | CPU bound (transform logic)                              |
| tree-building-worker             | 5           | CPU bound (tree construction)                            |
| noise-detection-worker           | 5           | CPU bound (pattern matching)                             |
| scope-classification-worker      | 5           | CPU bound (classification logic)                         |
| multimodal-worker                | 3           | LLM multimodal API bound                                 |

### Horizontal Scaling

All workers are stateless and can run on multiple pods:

**Deployment Strategy:**

1. Single pod for development
2. 3+ pods for production (high availability)
3. Auto-scaling based on queue depth (recommended: scale when queue > 100 jobs)

**Redis Cluster:**

- Use Redis Cluster (not standalone) for production
- Ensures queue availability across pod failures

**Worker Distribution:**

- All workers connect to same Redis instance
- Jobs distributed across pods automatically by BullMQ
- No coordination needed between pods

**Scaling Example:**

```yaml
# Kubernetes HPA
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: search-ai-workers
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: search-ai
  minReplicas: 3
  maxReplicas: 10
  metrics:
    - type: External
      external:
        metric:
          name: redis_queue_depth
        target:
          type: AverageValue
          averageValue: '100'
```

---

## Monitoring and Debugging

### Job Status Tracking

**Programmatic Status Check:**

```typescript
import { Queue } from 'bullmq';

const queue = new Queue('ingestion', { connection: getRedisConnection() });
const job = await queue.getJob(jobId);

const state = await job.getState();
// 'waiting' | 'active' | 'completed' | 'failed' | 'delayed'

const progress = job.progress; // 0-100
const data = job.data;
const result = job.returnvalue;
const error = job.failedReason;
```

**API Endpoint:**

```http
GET /api/:indexId/documents/:documentId/status
```

Returns:

```json
{
  "status": "EMBEDDING",
  "progress": 75,
  "lastUpdated": "2024-02-24T12:00:00Z",
  "processingError": null
}
```

### Document Status Values

Defined in `@agent-platform/search-ai-sdk`:

| Status       | Description                        |
| ------------ | ---------------------------------- |
| `PENDING`    | Enqueued for extraction            |
| `EXTRACTING` | Calling docling-service            |
| `EXTRACTED`  | Pages extracted, awaiting chunking |
| `PROCESSING` | Creating chunks                    |
| `ENRICHED`   | Enrichment complete                |
| `EMBEDDING`  | Generating embeddings              |
| `INDEXED`    | Terminal state - ready for search  |
| `ERROR`      | Failed (see processingError field) |

### Chunk Status Values

| Status    | Description                 |
| --------- | --------------------------- |
| `PENDING` | Created, awaiting embedding |
| `INDEXED` | Embedded, ready for search  |
| `FAILED`  | Embedding failed            |

### Queue Metrics

**Via BullMQ API:**

```typescript
const counts = await queue.getJobCounts();
// { waiting: 10, active: 5, completed: 100, failed: 2, delayed: 0 }
```

**Via Redis CLI:**

```bash
# List all queue keys
redis-cli KEYS "bull:*"

# Get queue length
redis-cli LLEN "bull:ingestion:waiting"

# Get failed jobs
redis-cli LRANGE "bull:ingestion:failed" 0 -1
```

### Worker Logs

All workers use standardized logging:

```typescript
workerLog('worker-name', 'message', { meta: 'data' });
workerError('worker-name', 'error message', error);
```

**Log Format:**

```
[worker][worker-name] message {"meta":"data"}
[worker][worker-name] error message: Error details
  at stack trace...
```

**Search Logs:**

```bash
# All worker logs
kubectl logs -l app=search-ai | grep '\[worker\]'

# Specific worker
kubectl logs -l app=search-ai | grep '\[worker\]\[embedding\]'

# Errors only
kubectl logs -l app=search-ai | grep '\[worker\]' | grep 'error'

# Specific document
kubectl logs -l app=search-ai | grep 'documentId":"abc123"'
```

### Common Failure Scenarios

| Failure                   | Symptom                                    | Resolution                                           |
| ------------------------- | ------------------------------------------ | ---------------------------------------------------- |
| **Docling timeout**       | Document stuck in EXTRACTING for > 5 min   | Increase timeout, check docling-service health       |
| **LLM rate limit**        | Jobs failing with 429 errors               | Reduce worker concurrency, implement rate limiting   |
| **Embedding API down**    | All documents stuck in EMBEDDING           | Check embedding provider status, verify API key      |
| **ClickHouse connection** | Structured data ingestion failing          | Verify ClickHouse URL, check network connectivity    |
| **Neo4j connection**      | Knowledge graph worker failing             | Verify Neo4j credentials, check connection pool      |
| **Redis connection**      | All workers offline                        | Check Redis cluster health, verify connection string |
| **S3 upload failure**     | Docling extraction failing on image upload | Verify S3 credentials, check bucket permissions      |
| **Out of memory**         | Worker pod restarting                      | Increase memory limits, reduce batch sizes           |

### Debugging Tools

**1. BullMQ Dashboard (UI):**

```bash
npm install -g @bull-board/cli
bull-board --redis redis://localhost:6379
# Open http://localhost:3000
```

**2. Job Inspection:**

```typescript
const job = await queue.getJob(jobId);
console.log(job.data); // Input data
console.log(job.returnvalue); // Output data
console.log(job.stacktrace); // Error stack
console.log(job.opts); // Job options
```

**3. Manual Job Retry:**

```typescript
await job.retry();
```

**4. Manual Job Completion:**

```typescript
await job.moveToCompleted('result', 'token', false);
```

**5. Clear Failed Jobs:**

```typescript
await queue.clean(0, 0, 'failed'); // Delete all failed jobs
```

---

## Related Documentation

- [Documents (PDF/DOCX)](./01-documents-pdf-docx.md) - 7-stage pipeline with progressive summarization
- [Structured CSV](./02-structured-csv.md) - Metadata-only chunking (99.9% reduction)
- [JSON Nested](./03-structured-json-nested.md) - Path extraction for nested JSON
- [JSON Tabular](./04-structured-json-tabular.md) - Array-of-objects detection
- [Excel](./05-structured-excel.md) - Multi-sheet processing
- [JSON Storage Architecture](./06-json-storage-architecture.md) - MongoDB vs ClickHouse storage
- [Auto-Mapping](./07-auto-mapping-and-schema-detection.md) - Schema detection and field mapping
- [Language Support Matrix](./12-language-support-matrix.md) - 100+ language support
- [Benchmarking](./13-benchmarking-and-quality.md) - Performance metrics

---

**Last Updated:** 2026-02-24
**Status:** ✅ Fully Documented (16 workers, 2 entry points, all flows documented)
**Next:** Update documents guide with docling integration details (Task #39)
