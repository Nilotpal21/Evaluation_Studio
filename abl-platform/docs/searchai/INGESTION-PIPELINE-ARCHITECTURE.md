# Search-AI Ingestion Pipeline Architecture

> **Service:** Search-AI (`apps/search-ai`, port 3005 production / 3113 local dev)
> **Purpose:** Document ingestion with background processing (minutes per document)
> **Last Updated:** March 3, 2026

---

## Table of Contents

1. [Overview](#overview)
2. [Worker Orchestration Patterns](#worker-orchestration-patterns)
3. [Two Parallel Paths (Legacy vs Docling)](#two-parallel-paths-legacy-vs-docling)
4. [17 Workers Deep-Dive](#17-workers-deep-dive)
5. [Error Handling & Retry Logic](#error-handling--retry-logic)
6. [Pipeline Health Monitoring](#pipeline-health-monitoring)
7. [Scaling Considerations](#scaling-considerations)
8. [Production Operational Concerns](#production-operational-concerns)

---

## Overview

### Ingestion-Time vs Query-Time

| Concern            | Ingestion-Time (Search-AI)                | Query-Time (Search-AI Runtime)         |
| ------------------ | ----------------------------------------- | -------------------------------------- |
| **Latency**        | Minutes per document (background workers) | <500ms per query (HTTP handlers)       |
| **Port**           | 3113 (local dev) / 3005 (prod)            | 3114 (local dev) / 3004 (prod)         |
| **Focus**          | Extract, chunk, enrich, embed documents   | Search, rank, cache, return results    |
| **Infrastructure** | 17 BullMQ workers + Redis + MongoDB       | HTTP server + OpenSearch + Redis cache |
| **Scaling**        | Horizontal (worker concurrency)           | Horizontal (pods behind load balancer) |

**Key Insight:** Search-AI is **write-heavy** — it processes uploaded documents through 17 background workers, writing to MongoDB and OpenSearch.

---

### Pipeline Flow

```
upload → ingestion → extraction/docling-extraction → page-processing → canonical-mapper → enrichment
                                                                                            ↓
                                                            ┌───────────────────────────────┤
                                                            ↓               ↓               ↓
                                                      embedding    knowledge-graph    question-synthesis
                                                                                     scope-classification
```

**17 Workers:**

- **14 always-started** (core pipeline)
- **3 optional** (tree-building, question-synthesis, scope-classification)

**Infrastructure:**

- **BullMQ** - Job queue and worker orchestration
- **Redis** (port 6380) - BullMQ coordination and job persistence
- **MongoDB** - Document metadata, chunks, progress tracking
- **OpenSearch** - Vector embeddings and text index
- **Neo4j** (optional) - Knowledge graph
- **Docling Service** (port 8080) - PDF/DOCX extraction via Python

---

## Worker Orchestration Patterns

### BullMQ Architecture

**Location:** `apps/search-ai/src/workers/shared.ts`

```typescript
// Shared BullMQ configuration
export const createQueue = (name: string) => {
  return new Queue(name, {
    connection: {
      host: process.env.REDIS_HOST || 'localhost',
      port: process.env.REDIS_PORT || 6380,
    },
    defaultJobOptions: {
      attempts: 3,
      backoff: {
        type: 'exponential',
        delay: 2000, // Start with 2 seconds
      },
      removeOnComplete: {
        age: 3600, // Keep completed jobs for 1 hour
        count: 1000,
      },
      removeOnFail: {
        age: 86400, // Keep failed jobs for 24 hours
      },
    },
  });
};
```

### Job State Management

**States:**

```
waiting → active → completed
   ↓         ↓
delayed   failed → waiting (retry)
```

**State Transitions:**

1. **waiting** - Job added to queue, waiting for worker
2. **active** - Worker picked up job, processing
3. **completed** - Job finished successfully
4. **failed** - Job failed, will retry if attempts remaining
5. **delayed** - Job waiting for retry delay (exponential backoff)

**Redis Keys:**

```bash
# Queue lists
bull:ingestion:waiting    # Jobs waiting to be processed
bull:ingestion:active     # Jobs currently being processed
bull:ingestion:completed  # Completed jobs (TTL: 1 hour)
bull:ingestion:failed     # Failed jobs (TTL: 24 hours)

# Job data
bull:ingestion:1          # Job #1 data (JSON)
bull:ingestion:2          # Job #2 data

# Worker heartbeat
bull:ingestion:workers    # Active workers list
```

### Worker Registration

**Location:** `apps/search-ai/src/workers/index.ts`

```typescript
export const workers = [
  { name: 'ingestion', worker: createIngestionWorker() },
  { name: 'extraction', worker: createExtractionWorker() },
  { name: 'docling-extraction', worker: createDoclingExtractionWorker() },
  { name: 'page-processing', worker: createPageProcessingWorker() },
  { name: 'canonical-mapper', worker: createCanonicalMapperWorker() },
  { name: 'noise-detection', worker: createNoiseDetectionWorker() },
  { name: 'visual-enrichment', worker: createVisualEnrichmentWorker() },
  { name: 'enrichment', worker: createEnrichmentWorker() },
  { name: 'kg-enrichment', worker: createKGEnrichmentWorker() },
  { name: 'taxonomy-setup', worker: createTaxonomySetupWorker() },
  { name: 'knowledge-graph', worker: createKnowledgeGraphWorker() },
  { name: 'multimodal', worker: createMultimodalWorker() },
  { name: 'embedding', worker: createEmbeddingWorker() },
  { name: 'structured-data-ingestion', worker: createStructuredDataIngestionWorker() },
  // Optional workers
  { name: 'tree-building', worker: createTreeBuildingWorker() },
  { name: 'question-synthesis', worker: createQuestionSynthesisWorker() },
  { name: 'scope-classification', worker: createScopeClassificationWorker() },
];

// Start all workers
workers.forEach(({ name, worker }) => {
  worker.on('completed', (job) => {
    log.info('Job completed', { queue: name, jobId: job.id });
  });

  worker.on('failed', (job, err) => {
    log.error('Job failed', { queue: name, jobId: job.id, error: err.message });
  });

  log.info('Worker started', { queue: name });
});
```

### Job Enqueuing Pattern

```typescript
// Ingestion worker enqueues extraction job
const job = await extractionQueue.add(
  'extract',
  {
    documentId: doc._id,
    tenantId: doc.tenantId,
    fileType: doc.fileType,
    filePath: doc.filePath,
  },
  {
    jobId: `extract-${doc._id}`, // Deduplicate by ID
    priority: doc.priority || 1, // Higher priority = processed first
  },
);

log.info('Enqueued extraction job', { documentId: doc._id, jobId: job.id });
```

---

## Two Parallel Paths (Legacy vs Docling)

### Decision Point: Document Upload

When a document is uploaded, the system routes it to one of two extraction paths based on file type:

```
                         ┌─── UPLOAD DOCUMENT ───┐
                         │                        │
                         ▼                        ▼
          ┌────────────────────────┐    ┌────────────────────────┐
          │ PATH 1: LEGACY         │    │ PATH 2: DOCLING        │
          │ (extraction-worker)    │    │ (docling-extraction)   │
          └────────────────────────┘    └────────────────────────┘
                    │                              │
                    │                              │
           Simple Documents              Complex Documents
           (TXT, MD)                     (PDF, DOCX, PPTX, HTML, Images)
                    │                              │
                    ▼                              ▼
          Extraction Worker                Docling Extraction Worker
          (Reads pre-extracted text)       (Python service - port 8080)
                    │                              │
                    ▼                              ▼
          Canonical Mapper                 Page Processing Worker
          (Basic chunking)                 (Progressive summarization,
                                            question generation)
                    │                              │
                    │                              │
                    ▼                              ▼
          ┌────────────────────────────────────────────────┐
          │         CONVERGENCE POINT                      │
          │         (Both paths merge here)                │
          └────────────────────────────────────────────────┘
                              │
                              ▼
                    Enrichment Worker
                              │
                              ▼
          ┌────────────────────────────────────────────────┐
          │  PARALLEL ADVANCED FEATURES (Optional)         │
          │  - Question Synthesis                          │
          │  - Scope Classification                        │
          │  - Knowledge Graph                             │
          │  - Tree Building                               │
          │  - Multimodal Enrichment                       │
          └────────────────────────────────────────────────┘
                              │
                              ▼
                    Embedding Worker
                              │
                              ▼
                          INDEXED
```

### Path 1: Legacy Extraction (Simple)

**File Types:** `.txt`, `.md`

**Flow:**

1. **Ingestion Worker** → Creates `SearchDocument` record
2. **Extraction Worker** → Reads pre-extracted text (no processing)
3. **Canonical Mapper** → Basic chunking (fixed-size, 512 tokens)
4. **Enrichment Worker** → Entity extraction (stub)
5. **Embedding Worker** → BGE-M3 embeddings → OpenSearch

**Characteristics:**

- Fast: ~10 seconds per document
- No layout extraction (plain text only)
- No Phase 2 LLM features (no summarization, no questions)

### Path 2: Docling Extraction (Advanced)

**File Types:** `.pdf`, `.docx`, `.pptx`, `.html`, `.png`, `.jpg`

**Flow:**

1. **Ingestion Worker** → Creates `SearchDocument` record
2. **Docling Extraction Worker** → Docling service (port 8080):
   - Layout extraction (columns, tables, images)
   - OCR for scanned documents
   - Structure-aware text extraction
3. **Page Processing Worker** → ATLAS-KG chunking:
   - Progressive summarization (Claude Haiku)
   - Question synthesis (Gemini Flash)
   - Markdown-aware chunking
4. **Canonical Mapper** → Applies canonical metadata schema
5. **Enrichment Worker** → Entity extraction, language detection
6. **Embedding Worker** → BGE-M3 embeddings → OpenSearch

**Characteristics:**

- Slower: ~2-5 minutes per 100-page PDF
- Preserves layout and structure
- Phase 2 LLM features enabled (if tenant has credentials)

### Routing Logic

**Location:** `apps/search-ai/src/workers/ingestion-worker.ts`

```typescript
function determineExtractionPath(document: SearchDocument): 'legacy' | 'docling' {
  const doclingTypes = ['pdf', 'docx', 'pptx', 'html', 'image'];
  const fileType = document.fileType.toLowerCase();

  if (doclingTypes.includes(fileType)) {
    return 'docling';
  }

  return 'legacy';
}

// Enqueue appropriate extraction job
if (path === 'docling') {
  await doclingExtractionQueue.add('extract', { documentId: doc._id });
} else {
  await extractionQueue.add('extract', { documentId: doc._id });
}
```

---

## 17 Workers Deep-Dive

### Core Pipeline Workers (14 Always-Started)

#### 1. ingestion-worker

**Queue:** `ingestion`
**Concurrency:** 3
**Purpose:** Receives upload, creates document record, enqueues extraction

**Job Data:**

```typescript
{
  documentId: string;
  tenantId: string;
  indexId: string;
  sourceId: string;
  fileType: string;
  filePath: string;
  metadata: Record<string, any>;
}
```

**Processing:**

1. Validate tenant/index access
2. Create `SearchDocument` record in MongoDB
3. Determine extraction path (legacy vs docling)
4. Enqueue extraction job
5. Update document status to `processing`

**Error Handling:**

- Invalid tenant → return 404
- Duplicate document (same contentHash) → skip processing
- MongoDB write failure → retry 3 times with exponential backoff

---

#### 2. extraction-worker

**Queue:** `extraction`
**Concurrency:** 5
**Purpose:** Legacy text extraction for TXT, MD files

**Processing:**

1. Read file from storage (S3 or local filesystem)
2. Extract plain text (no processing)
3. Create `DocumentPage` records (one page = entire file)
4. Enqueue page-processing job
5. Update document status to `extracted`

---

#### 3. docling-extraction-worker

**Queue:** `docling-extraction`
**Concurrency:** 5
**Purpose:** Docling extraction for PDF, DOCX, PPTX, HTML, images

**Processing:**

1. Call Docling service (port 8080): `POST /extract`
2. Receive structured output (pages, tables, images)
3. Create `DocumentPage` records with layout metadata
4. Enqueue page-processing job for each page
5. Update document status to `extracted`

**Docling API:**

```bash
POST http://localhost:8080/extract
Content-Type: multipart/form-data

{
  "file": <binary>,
  "options": {
    "ocr": true,
    "tables": true,
    "images": true
  }
}

# Response
{
  "pages": [
    {
      "pageNumber": 1,
      "text": "...",
      "layout": {
        "columns": 2,
        "tables": [{ ... }],
        "images": [{ ... }]
      }
    }
  ]
}
```

**Error Handling:**

- Docling service timeout (120s) → retry with backoff
- OCR failure → fall back to text extraction only
- Unsupported file type → return error

---

#### 4. page-processing-worker

**Queue:** `page-processing`
**Concurrency:** 4
**Purpose:** Chunks pages into SearchChunks, structure-aware for markdown

**Processing:**

1. Load `DocumentPage` from MongoDB
2. Detect document type (markdown, plain text, structured)
3. Choose chunking strategy:
   - **Markdown:** `MarkdownChunker` (AST-based, preserves headings)
   - **Plain text:** `ChunkingService` (token-based, 512 tokens)
   - **Docling:** Page-based chunking (one chunk per page)
4. Generate progressive summaries (if LLM credentials available)
5. Generate questions per chunk (if LLM credentials available)
6. Create `SearchChunk` records in MongoDB
7. Enqueue canonical-mapper job for each chunk

**Phase 2 LLM Features:**

```typescript
// Progressive Summarization (Claude Haiku)
const summary = await llmService.summarize({
  text: chunk.text,
  previousSummary: previousChunk?.summary, // Context from previous page
  maxTokens: 200,
});

// Question Synthesis (Gemini Flash)
const questions = await llmService.generateQuestions({
  text: chunk.text,
  numQuestions: 3,
});

chunk.summary = summary;
chunk.questions = questions;
```

**Cost:** ~$0.06 per 100-page document (Phase 2 LLM features)

---

#### 5. canonical-mapper-worker

**Queue:** `canonical-mapping`
**Concurrency:** 5
**Purpose:** Applies canonical metadata schema to chunks

**Processing:**

1. Load `SearchChunk` from MongoDB
2. Map source metadata to 75-field canonical schema:
   - **Core fields** (15): `sys.tenantId`, `sys.indexId`, `sys.documentId`, `sys.chunkId`, ...
   - **Common fields** (25): `doc.title`, `doc.createdAt`, `doc.modifiedAt`, `doc.author`, ...
   - **Custom fields** (35): `doc.custom01` - `doc.custom35`
3. Update `SearchChunk` with canonical metadata
4. Enqueue enrichment job

**Mapping Example:**

```typescript
// Source metadata (SharePoint)
{
  Title: "Q3 Report",
  Modified: "2024-01-15",
  Editor: "John Doe",
  ContentType: "Document"
}

// Canonical metadata
{
  "doc.title": "Q3 Report",
  "doc.modifiedAt": "2024-01-15T00:00:00Z",
  "doc.author": "John Doe",
  "doc.documentType": "report"
}
```

---

#### 6. noise-detection-worker

**Queue:** `noise-detection`
**Concurrency:** 1
**Purpose:** Filters low-quality/noisy chunks

**Processing:**

1. Load `SearchChunk` from MongoDB
2. Calculate noise metrics:
   - **TF-IDF** → detect boilerplate (high frequency, low uniqueness)
   - **Token density** → detect sparse content
   - **Repeated ngrams** → detect headers/footers
3. Mark chunk as `isNoise: true` if noisy
4. Skip noisy chunks from embedding pipeline

**Config-Gated:** Enabled via `getConfig().noiseDetection.enabled`

---

#### 7. visual-enrichment-worker

**Queue:** `visual-enrichment`
**Concurrency:** 3
**Purpose:** Extracts info from images/screenshots in documents

**Processing:**

1. Load `SearchChunk` with images
2. Call vision model (Florence, LLaVA, GPT-4V) for each image
3. Generate text description: "Bar chart showing Q3 revenue growth of 15% YoY"
4. Append description to chunk text
5. Update `SearchChunk` in MongoDB

**Config-Gated:** Enabled via `getConfig().visualEnrichment.enabled`

---

#### 8. enrichment-worker

**Queue:** `enrichment`
**Concurrency:** 5
**Purpose:** Entity extraction, language detection, summarization stubs. Enqueues downstream jobs.

**Processing:**

1. Load `SearchChunk` from MongoDB
2. Entity extraction (stub - currently disabled)
3. Language detection (langdetect)
4. Enqueue downstream jobs:
   - `embedding` queue (always)
   - `kg-enrichment` queue (if config-gated)
   - `knowledge-graph` queue (if config-gated)
   - `question-synthesis` queue (if LLM-gated)
   - `scope-classification` queue (if LLM-gated)
5. Update chunk status to `enriched`

**Enqueuing Logic:**

```typescript
// Always enqueue embedding
await embeddingQueue.add('embed', { chunkId: chunk._id });

// Conditional enqueues
if (getConfig().knowledgeGraph.enabled) {
  await knowledgeGraphQueue.add('build', { chunkId: chunk._id });
}

if (hasLLMCredentials(tenantId)) {
  await questionSynthesisQueue.add('synthesize', { chunkId: chunk._id });
}
```

---

#### 9. kg-enrichment-worker

**Queue:** `kg-enrichment`
**Concurrency:** 2
**Purpose:** Knowledge graph entity extraction with taxonomy

**Processing:**

1. Load `SearchChunk` from MongoDB
2. Extract entities using taxonomy-guided LLM prompt
3. Store entities in `EntityExtraction` collection
4. Enqueue knowledge-graph job to build graph

**Config-Gated:** Enabled via `getConfig().knowledgeGraph.enabled`

---

#### 10. taxonomy-setup-worker

**Queue:** `taxonomy-setup`
**Concurrency:** 1
**Purpose:** Sets up KG taxonomy for an index (LLM-intensive)

**Processing:**

1. Analyze sample documents from index (100 docs)
2. Generate taxonomy using LLM (entity types, relationships)
3. Store taxonomy in `IndexTaxonomy` collection
4. Used by kg-enrichment worker for entity extraction

**Config-Gated:** Enabled via `getConfig().knowledgeGraph.enabled`

**Cost:** ~$5 per index (one-time setup)

---

#### 11. knowledge-graph-worker

**Queue:** `knowledge-graph`
**Concurrency:** 2
**Purpose:** Builds Neo4j graph from entities/references

**Processing:**

1. Load `EntityExtraction` from MongoDB
2. Create nodes in Neo4j (entities)
3. Create relationships (co-occurrence, references)
4. Update graph metadata

**Config-Gated:** Enabled via `getConfig().knowledgeGraph.enabled`

---

#### 12. multimodal-worker

**Queue:** `multimodal`
**Concurrency:** 2
**Purpose:** Multi-modal processing (images, tables)

**Processing:**

1. Load `SearchChunk` with multimodal content
2. Process images (vision model descriptions)
3. Process tables (structure extraction)
4. Update chunk with multimodal metadata

**Config-Gated:** Enabled via `getConfig().multiModal.enabled`

---

#### 13. embedding-worker

**Queue:** `embedding`
**Concurrency:** 3
**Purpose:** Generates BGE-M3 embeddings, upserts to OpenSearch

**Processing:**

1. Load `SearchChunk` from MongoDB
2. Call BGE-M3 service (port 8000): `POST /embeddings`
3. Receive 1024-dim vector
4. Resolve index via IndexRegistry (shared vs dedicated)
5. Upsert to OpenSearch with metadata
6. Update chunk status to `indexed`

**Batching:**

```typescript
// Process chunks in batches of 8 (CPU-safe)
const chunks = await SearchChunk.find({ status: 'enriched' }).limit(8);
const texts = chunks.map((c) => c.text);
const embeddings = await embedProvider.embed(texts); // Single API call

// Upsert to OpenSearch in bulk
await opensearchClient.bulk({
  body: chunks.flatMap((chunk, i) => [
    { index: { _index: indexName, _id: chunk._id } },
    {
      vector: embeddings[i],
      text: chunk.text,
      'sys.tenantId': chunk.tenantId,
      'sys.indexId': chunk.indexId,
      doc: chunk.canonicalMetadata,
    },
  ]),
});
```

**Always Runs:** This worker is never skipped (all chunks must be embedded)

---

#### 14. structured-data-ingestion-worker

**Queue:** `structured-data-ingestion`
**Concurrency:** 1
**Purpose:** CSV/JSON/Excel ingestion to ClickHouse

**Processing:**

1. Load structured data file (CSV, JSON, Excel)
2. Parse rows
3. Insert into ClickHouse table
4. Index metadata in OpenSearch (no vectors)

**On-Demand:** Only runs for structured data uploads (not regular documents)

---

### Optional Workers (3)

#### 15. tree-building-worker

**Queue:** `tree-building`
**Concurrency:** 1
**Purpose:** Hierarchical chunk tree construction

**Processing:**

1. Load all chunks for a document
2. Build tree structure (max depth=4, max children=10)
3. Generate summaries for parent nodes (LLM)
4. Store tree in `ChunkTree` collection

**Config-Gated:** Enabled via `getConfig().treeBuilder.enabled`

**Cost:** ~$0.10 per 100-page document (tree summarization)

---

#### 16. question-synthesis-worker

**Queue:** `question-synthesis`
**Concurrency:** 1
**Purpose:** Generates questions per chunk via LLM

**Processing:**

1. Load `SearchChunk` from MongoDB
2. Call LLM (Gemini Flash): "Generate 3-5 questions this chunk answers"
3. Store questions in `ChunkQuestion` collection
4. Questions used at query-time to improve matching

**LLM-Gated:** Requires tenant LLM credentials

**Cost:** ~$0.006 per 100-page document (Gemini Flash)

---

#### 17. scope-classification-worker

**Queue:** `scope-classification`
**Concurrency:** 1
**Purpose:** Classifies chunk scope via LLM

**Processing:**

1. Load `SearchChunk` from MongoDB
2. Call LLM: "Classify scope: snippet / section / document-level"
3. Update chunk with scope classification
4. Used at query-time for scope-aware retrieval

**LLM-Gated:** Requires tenant LLM credentials

---

## Error Handling & Retry Logic

### Retry Strategy (per Worker)

**Default (BullMQ exponential backoff):**

```typescript
{
  attempts: 3,
  backoff: {
    type: 'exponential',
    delay: 2000,  // 2 seconds, 4 seconds, 8 seconds
  }
}
```

**Custom Retry (per worker):**

```typescript
// Docling extraction - longer timeouts
{
  attempts: 5,
  backoff: {
    type: 'exponential',
    delay: 5000,  // 5s, 10s, 20s, 40s, 80s
  },
  timeout: 120000,  // 2 minutes max per attempt
}

// Embedding - fast retries
{
  attempts: 3,
  backoff: {
    type: 'fixed',
    delay: 1000,  // 1 second fixed
  },
  timeout: 30000,  // 30 seconds max
}
```

### Graceful Degradation

**Optional Workers Failure:**

```typescript
// If question-synthesis fails, continue without questions
try {
  await questionSynthesisQueue.add('synthesize', { chunkId });
} catch (error) {
  log.warn('Question synthesis failed, continuing without questions', { chunkId, error });
  // Document still gets indexed (without questions)
}
```

**LLM Credential Resolution Failure:**

```typescript
// If no LLM credentials, skip LLM-gated workers
const hasLLM = await resolveIndexLLMConfig(tenantId, indexId);
if (!hasLLM) {
  log.info('No LLM credentials, skipping question-synthesis and scope-classification');
  // Continue with non-LLM features (embedding, knowledge graph, etc.)
}
```

### Dead Letter Queues

**Failed Jobs:**

```typescript
// After 3 attempts, move to failed queue
worker.on('failed', async (job, err) => {
  if (job.attemptsMade >= job.opts.attempts) {
    await deadLetterQueue.add('failed-job', {
      originalQueue: job.queue.name,
      jobId: job.id,
      data: job.data,
      error: err.message,
      stack: err.stack,
      failedAt: new Date(),
    });

    log.error('Job moved to dead letter queue', {
      queue: job.queue.name,
      jobId: job.id,
      attempts: job.attemptsMade,
    });
  }
});
```

**Manual Retry:**

```bash
# CLI tool to retry failed jobs
pnpm cli:search-ai retry-failed --queue=docling-extraction --limit=100
```

---

## Pipeline Health Monitoring

### Metrics (Prometheus)

```typescript
// Job metrics
job_total{queue="ingestion", status="completed|failed"}
job_duration_seconds{queue="ingestion"}
job_attempts_total{queue="ingestion"}

// Worker metrics
worker_active{queue="ingestion"}
worker_idle{queue="ingestion"}
worker_utilization{queue="ingestion"}  // active / total

// Queue metrics
queue_waiting{queue="ingestion"}
queue_active{queue="ingestion"}
queue_delayed{queue="ingestion"}
queue_failed{queue="ingestion"}
```

### Health Check Endpoint

**API:** `GET /api/admin/workers/health`

```json
{
  "status": "healthy",
  "workers": [
    {
      "name": "ingestion",
      "status": "running",
      "active": 2,
      "waiting": 15,
      "failed": 0,
      "utilization": 0.67 // 2/3 active
    },
    {
      "name": "docling-extraction",
      "status": "running",
      "active": 5,
      "waiting": 120,
      "failed": 3,
      "utilization": 1.0 // Fully utilized
    }
  ],
  "redis": {
    "status": "connected",
    "memory": "512MB",
    "evictions": 0
  }
}
```

### Alerts

**Critical:**

- Worker not processing jobs for 5 minutes → `worker_idle > 300`
- Failed job rate > 10% → `job_failed_rate > 0.1`
- Redis memory > 80% → `redis_memory_usage > 0.8`

**Warning:**

- Queue waiting > 1000 jobs → `queue_waiting > 1000`
- Worker utilization > 90% for 10 minutes → `worker_utilization > 0.9`
- Dead letter queue > 100 jobs → `dead_letter_queue_size > 100`

---

## Scaling Considerations

### Horizontal Scaling (Worker Pods)

**Strategy:** Run multiple pods, each with all 17 workers

```yaml
# Kubernetes Deployment
replicas: 3 # 3 pods × 17 workers = 51 workers total

env:
  - name: WORKER_CONCURRENCY
    value: '1' # Each worker processes 1 job at a time per pod


# Result:
# - ingestion: 3 workers (1 per pod)
# - docling-extraction: 3 workers
# - embedding: 3 workers
# ...
```

**Pros:**

- Simple deployment (all workers in one image)
- Auto-scaling based on CPU/memory
- No need to coordinate which pod runs which worker

**Cons:**

- All workers scale together (can't scale docling-extraction independently)
- Memory overhead (17 workers per pod)

---

### Vertical Scaling (Worker Concurrency)

**Strategy:** Increase concurrency per worker

```typescript
// Before: 3 workers × concurrency 1 = 3 concurrent jobs
createWorker('ingestion', { concurrency: 1 });

// After: 3 workers × concurrency 5 = 15 concurrent jobs
createWorker('ingestion', { concurrency: 5 });
```

**When to Use:**

- CPU-bound workers (embedding, chunking) → increase concurrency to use all CPU cores
- I/O-bound workers (docling API calls) → increase concurrency to maximize throughput

**Limits:**

- Memory: Each concurrent job uses ~50-100MB RAM
- Database connections: MongoDB/Redis pool size must support total concurrency
- External API rate limits: Docling service, LLM APIs

---

### Queue Prioritization

**Strategy:** Process high-priority documents first

```typescript
// High priority: User-uploaded documents (real-time ingestion)
await ingestionQueue.add('ingest', { documentId }, { priority: 10 });

// Low priority: Background sync from connectors (batch ingestion)
await ingestionQueue.add('ingest', { documentId }, { priority: 1 });
```

**BullMQ Priority:**

- Higher number = higher priority (1-100)
- Priority queue sorts by priority + FIFO within same priority

---

### Backpressure Mechanisms

**Strategy:** Slow down upstream if downstream is overwhelmed

```typescript
// Check queue size before enqueuing
const queueSize = await doclingExtractionQueue.getWaitingCount();
if (queueSize > 1000) {
  log.warn('Docling extraction queue overwhelmed, slowing down ingestion');
  await delay(5000); // Wait 5 seconds before enqueuing more
}
```

**Rate Limiting:**

```typescript
// Limit ingestion rate from connectors
const rateLimiter = new RateLimiter({
  maxRequests: 100, // Max 100 documents per minute
  windowMs: 60000,
});

await rateLimiter.consume(tenantId);
await ingestionQueue.add('ingest', { documentId });
```

---

## Production Operational Concerns

### Capacity Planning

**Throughput Targets:**

- **Ingestion:** 1000 documents/hour (typical), 5000/hour (peak)
- **Docling extraction:** 500 PDF pages/hour per worker
- **Embedding:** 10,000 chunks/hour (batch size 8, 120s timeout)

**Resource Requirements (per worker pod):**

- CPU: 2 cores (shared across 17 workers)
- Memory: 4GB (2GB for workers, 2GB for Docling/LLM API buffers)
- Redis: 512MB (BullMQ job data)
- MongoDB: 50 connections (pool size)

**Scaling Example:**

```
100,000 documents/day ÷ 24 hours = 4,167 docs/hour
4,167 docs/hour ÷ 1000 docs/hour per pod = 5 pods needed

Peak (5× normal): 5 pods × 5 = 25 pods
```

---

### Latency Targets

| Worker                   | P50   | P95   | P99  |
| ------------------------ | ----- | ----- | ---- |
| ingestion                | 100ms | 500ms | 1s   |
| extraction (TXT/MD)      | 500ms | 2s    | 5s   |
| docling-extraction (PDF) | 10s   | 60s   | 120s |
| page-processing          | 2s    | 10s   | 20s  |
| canonical-mapper         | 100ms | 500ms | 1s   |
| enrichment               | 500ms | 2s    | 5s   |
| embedding                | 5s    | 15s   | 30s  |

**Total Pipeline Latency:**

- Simple documents (TXT): ~10 seconds (P95)
- Complex documents (100-page PDF): ~5 minutes (P95)

---

### Throughput Optimization

**1. Increase worker concurrency**

```typescript
// High-throughput workers
createWorker('embedding', { concurrency: 10 }); // CPU-bound
createWorker('docling-extraction', { concurrency: 5 }); // I/O-bound
```

**2. Batch operations**

```typescript
// Embedding: Batch 8 chunks per API call
const chunks = await SearchChunk.find({ status: 'enriched' }).limit(8);
const embeddings = await embedProvider.embed(chunks.map((c) => c.text));
```

**3. Parallel enqueuing**

```typescript
// Enqueue multiple jobs in parallel
await Promise.all([
  embeddingQueue.add('embed', { chunkId: chunk1._id }),
  embeddingQueue.add('embed', { chunkId: chunk2._id }),
  embeddingQueue.add('embed', { chunkId: chunk3._id }),
]);
```

---

## See Also

- [QUERY-PIPELINE-DESIGN.md](./design/QUERY-PIPELINE-DESIGN.md) - Query pipeline design (7 stages, vocabulary, agent integration)
- [SERVICES-INVENTORY.md](./design/SERVICES-INVENTORY.md) - Complete catalog of workers and services
- [PIPELINE_INVOCATION_GUIDE.md](./PIPELINE_INVOCATION_GUIDE.md) - When workers are invoked (legacy/docling paths)

---

**Last Updated:** March 3, 2026
**Maintained By:** ABL Platform Team
