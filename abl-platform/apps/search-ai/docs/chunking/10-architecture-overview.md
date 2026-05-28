# Architecture Overview - ATLAS Search Chunking & Extraction

**Version:** 2.0
**Last Updated:** 2026-02-23
**Status:** Production

---

## System Architecture

ATLAS Search is a multi-tenant semantic search platform with specialized pipelines for different document types. The system uses a **worker-based architecture** with distributed job queues, multiple storage backends, and pluggable LLM providers.

```
┌─────────────────────────────────────────────────────────────────┐
│                         CLIENT LAYER                             │
│  Web UI, REST API, SDK Clients                                  │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       API GATEWAY LAYER                          │
│  • Unified Auth Middleware (JWT, Session Token, API Key)        │
│  • Tenant Context Resolution                                     │
│  • Rate Limiting & Request Validation                           │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                      ORCHESTRATION LAYER                         │
│  • BullMQ Job Queues (Redis-backed)                             │
│  • Job Scheduling & Priority Management                          │
│  • Worker Health Monitoring                                      │
└────────────┬────────────────────────────────────────────────────┘
             │
             ├────────────────────┬─────────────────────┐
             │                    │                     │
             ▼                    ▼                     ▼
┌─────────────────────┐ ┌──────────────────┐ ┌─────────────────────┐
│  DOCUMENT PIPELINE  │ │ STRUCTURED DATA  │ │  ENRICHMENT         │
│                     │ │    PIPELINE      │ │    PIPELINE         │
│  • Docling Extract  │ │  • CSV Ingestion │ │  • Vision (Images)  │
│  • Page Processing  │ │  • JSON Parse    │ │  • Entity Extract   │
│  • Progressive      │ │  • Excel Parse   │ │  • Question Synth   │
│    Summarization    │ │  • Schema Detect │ │  • Canonical Map    │
└─────────────────────┘ └──────────────────┘ └─────────────────────┘
             │                    │                     │
             └────────────────────┴─────────────────────┘
                                  │
                                  ▼
┌─────────────────────────────────────────────────────────────────┐
│                        EMBEDDING LAYER                           │
│  • Embedding Worker (Batch Processing)                          │
│  • Provider Abstraction (OpenAI, Cohere, Custom)                │
│  • Vector Generation (3072-dim, 1024-dim)                       │
└────────────┬────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                        STORAGE LAYER                             │
│                                                                  │
│  ┌──────────────┐  ┌──────────────┐  ┌─────────────────────┐  │
│  │   MongoDB    │  │  ClickHouse  │  │       Redis         │  │
│  │              │  │              │  │                     │  │
│  │ • SearchChunk│  │ • Table Data │  │ • Session Cache     │  │
│  │ • Documents  │  │ • Path Index │  │ • Analysis Cache    │  │
│  │ • Metadata   │  │ • Table Meta │  │ • Job Queue State   │  │
│  │ • Embeddings │  │ • Trace Data │  │ • Compilation Cache │  │
│  └──────────────┘  └──────────────┘  └─────────────────────┘  │
└─────────────────────────────────────────────────────────────────┘
             │
             ▼
┌─────────────────────────────────────────────────────────────────┐
│                       RETRIEVAL LAYER                            │
│  • Semantic Search (Vector Similarity)                          │
│  • Keyword Search (BM25, Full-Text)                             │
│  • Hybrid Search (Vector + Keyword Fusion)                      │
│  • Text-to-SQL (Natural Language → SQL)                         │
│  • Path-Based Queries (JSON Hierarchical)                       │
└─────────────────────────────────────────────────────────────────┘
```

---

## Worker Pipeline Architecture

### Document Pipeline (PDF, DOCX, PPTX)

```
User Upload
    │
    ▼
┌─────────────────────────────┐
│  ingestion-worker           │ → Document metadata creation
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  docling-extraction-worker  │ → Text, images, tables extraction
│  - OCR (if needed)          │
│  - Layout preservation      │
│  - Image extraction         │
│  - Table detection          │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  page-processing-worker     │ → Chunking & summarization
│  - Sentence-aligned chunks  │
│  - Progressive summaries    │
│  - Table extraction         │
└──────────┬──────────────────┘
           │
           ├─────────────────────────┐
           │                         │
           ▼                         ▼
┌─────────────────────────────┐  ┌─────────────────────────────┐
│  visual-enrichment-worker   │  │  embedding-worker           │
│  - Vision LLM analysis      │  │  - Batch embedding          │
│  - Image descriptions       │  │  - Vector storage           │
│  - Visual insights          │  └─────────────────────────────┘
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  question-synthesis-worker  │ → Q&A generation
│  - Generate questions       │
│  - Store for retrieval      │
└──────────┬──────────────────┘
           │
           ▼
┌─────────────────────────────┐
│  embedding-worker           │ → Final embedding (with questions)
└──────────┬──────────────────┘
           │
           ▼
      [INDEXED]
```

**Processing Time (50-page PDF):**

- Docling Extraction: 100-150s (2-3s/page)
- Page Processing: 10-20s
- Vision Enrichment: 20-40s (if images present)
- Question Synthesis: 15-30s
- Embedding: 5-10s
- **Total: ~150-250s (2.5-4 minutes)**

---

### Structured Data Pipeline (CSV, JSON, Excel)

```
User Upload
    │
    ▼
┌──────────────────────────────────┐
│  API: /analyze                   │ → Schema detection & analysis
│  - Parse file                    │
│  - Detect types                  │
│  - Detect foreign keys           │
│  - Calculate cost estimates      │
│  - Cache analysis (1-hour TTL)   │
└──────────┬───────────────────────┘
           │
           │ (User reviews schema,
           │  edits if needed)
           │
           ▼
┌──────────────────────────────────┐
│  API: /ingest                    │ → Create ingestion job
│  - Validate schema               │
│  - Retrieve cached file          │
│  - Enqueue job                   │
└──────────┬───────────────────────┘
           │
           ▼
┌──────────────────────────────────┐
│  structured-data-ingestion-worker│ → Parse & chunk
│  - Parse CSV/JSON/Excel          │
│  - Apply chunking strategy       │
│  - Metadata-only (no row chunks) │
└──────────┬───────────────────────┘
           │
           ├──────────────────┬─────────────────────┐
           │                  │                     │
           ▼                  ▼                     ▼
┌──────────────────┐ ┌─────────────────────┐ ┌────────────────────┐
│ ClickHouse       │ │  Path Extractor     │ │  MongoDB           │
│ (Data Storage)   │ │  (JSON nested only) │ │  (Metadata Chunk)  │
│                  │ │                     │ │                    │
│ • Table rows     │ │ • Extract paths     │ │ • 1 chunk per      │
│ • Table metadata │ │ • Index in CH       │ │   table/object     │
│ • Path index     │ │ • Parent-child      │ │ • Schema + samples │
└──────────────────┘ └─────────────────────┘ └────────┬───────────┘
                                                       │
                                                       ▼
                                              ┌─────────────────────┐
                                              │  embedding-worker   │
                                              │  - Embed metadata   │
                                              └─────────────────────┘
                                                       │
                                                       ▼
                                                  [INDEXED]
```

**Processing Time (100K row CSV):**

- Analysis: 1-2s
- Parsing: 2-3s
- Chunking: 0.1s (metadata only)
- ClickHouse Insert: 1-2s
- Embedding: 0.5s
- **Total: ~4-8s**

---

## Component Responsibilities

### 1. API Gateway

**Purpose:** Unified authentication, tenant resolution, and request routing.

**Key Files:**

- `apps/search-ai/src/middleware/unified-auth.ts`
- `packages/shared/src/auth/tenant-context.ts`

**Responsibilities:**

- Parse and validate JWT tokens, session tokens, and API keys
- Resolve tenant ID and index ID from request
- Enforce tenant isolation at API boundary
- Rate limiting and request validation
- CORS handling

**Auth Flow:**

```
Request → Parse Auth Header → Validate Token → Resolve Tenant → Set Context → Route to Handler
```

---

### 2. BullMQ Job Queues

**Purpose:** Distributed job orchestration with retries, priorities, and monitoring.

**Queues:**

- `document-ingestion` - Document upload coordination
- `docling-extraction` - PDF/DOCX extraction
- `page-processing` - Page chunking and summarization
- `structured-data-ingestion` - CSV/JSON/Excel ingestion
- `visual-enrichment` - Image analysis with vision LLM
- `embedding` - Batch vector embedding generation
- `canonical-mapping` - Entity extraction and normalization
- `question-synthesis` - Q&A generation

**Key Features:**

- Redis-backed for distributed workers
- Job priorities (0-10, higher = more urgent)
- Automatic retries with exponential backoff
- Job progress tracking
- Failed job monitoring and alerting

**Configuration:**

```typescript
{
  attempts: 3,              // Retry up to 3 times
  backoff: {
    type: 'exponential',
    delay: 5000             // Start with 5s delay, double each retry
  },
  removeOnComplete: 100,    // Keep last 100 completed jobs
  removeOnFail: 1000        // Keep last 1000 failed jobs
}
```

---

### 3. Workers

**Purpose:** Background processors for each pipeline stage.

**Worker Pattern:**

```typescript
export function createWorker(queueName: string, processor: JobProcessor) {
  return new Worker(
    queueName,
    async (job: Job) => {
      const { tenantId, indexId, ...data } = job.data;

      // Enforce tenant context
      await withTenantContext({ tenantId }, async () => {
        try {
          // Update progress
          await job.updateProgress(10);

          // Process job
          const result = await processor(job.data);

          // Update progress
          await job.updateProgress(100);

          return result;
        } catch (error) {
          // Log error with context
          workerError(queueName, 'Job failed', error);
          throw error; // Trigger retry
        }
      });
    },
    {
      concurrency: 5, // Process 5 jobs concurrently
      limiter: {
        max: 10, // Max 10 jobs per interval
        duration: 1000, // Per 1 second
      },
    },
  );
}
```

**Key Workers:**

| Worker                        | Concurrency | Rate Limit      | Avg Duration | Retries |
| ----------------------------- | ----------- | --------------- | ------------ | ------- |
| **docling-extraction**        | 3           | 3/s             | 100s         | 3       |
| **page-processing**           | 10          | 10/s            | 1s           | 3       |
| **structured-data-ingestion** | 5           | 5/s             | 5s           | 3       |
| **visual-enrichment**         | 5           | 2/s (LLM limit) | 4s           | 3       |
| **embedding**                 | 10          | 50/s            | 0.5s         | 3       |

---

### 4. Storage Layer

#### MongoDB

**Purpose:** Document metadata, chunk storage, embeddings.

**Collections:**

- `SearchIndex` - Index configuration and settings
- `SearchDocument` - Document metadata
- `SearchChunk` - Chunked content with embeddings
- `DocumentPage` - Page-level content (for documents)
- `ChunkQuestion` - Generated questions per chunk

**Key Indexes:**

- `{ tenantId: 1, indexId: 1, documentId: 1 }` - Tenant isolation
- `{ tenantId: 1, indexId: 1, status: 1 }` - Job status filtering
- `{ embedding: "vector" }` - Vector similarity search (Atlas Search)

**Tenant Isolation:**

```typescript
// ALWAYS include tenantId and indexId
SearchChunk.find({
  tenantId,
  indexId,
  documentId,
});

// NEVER use findById (no tenant isolation)
SearchChunk.findById(id); // ❌ SECURITY VIOLATION
```

#### ClickHouse

**Purpose:** Column-oriented analytics database for structured data and path indexing.

**Tables:**

- `structured_data` - Table rows (JSON-encoded)
- `table_metadata` - Table schema and statistics
- `json_path_index` - Hierarchical path index for nested JSON
- `trace_events` - Runtime trace data (observability)

**Key Features:**

- Columnar compression (5-10x smaller than MongoDB)
- Sub-second SQL queries on millions of rows
- Native JSON functions (`JSON_EXTRACT`, `JSON_VALUE`)
- Distributed query execution
- MergeTree engine for fast inserts and queries

**Tenant Isolation:**

```sql
-- ALWAYS include tenant_id and index_id in WHERE
SELECT * FROM structured_data
WHERE tenant_id = ? AND index_id = ? AND table_id = ?;

-- Index structure enforces isolation
ORDER BY (tenant_id, index_id, table_id, row_number)
```

#### Redis

**Purpose:** Distributed cache, session storage, job queue state.

**Key Patterns:**

- **Analysis Cache:** `analysis:{tenantId}:{analysisId}` (1-hour TTL)
- **Compilation Cache:** `ir:{irSourceHash}` (24-hour TTL)
- **Session Data:** `session:{sessionId}` (configurable TTL)
- **Job Queues:** `bull:{queueName}:*` (managed by BullMQ)

**Tenant Isolation:**

```typescript
// Prefix all keys with tenant ID
const key = `analysis:${tenantId}:${analysisId}`;
await redis.set(key, JSON.stringify(data), 'EX', 3600);

// Retrieve with tenant check
const data = await redis.get(`analysis:${tenantId}:${analysisId}`);
```

---

### 5. LLM Integration

**Purpose:** Provider-agnostic LLM access for summarization, vision, text-to-SQL, and question generation.

**Provider Abstraction:**

```typescript
interface LLMProvider {
  complete(prompt: string, options: CompletionOptions): Promise<string>;
  completeWithTools(prompt: string, tools: ToolDefinition[]): Promise<ToolCall[]>;
  embed(text: string): Promise<{ vector: number[]; model: string }>;
}
```

**Supported Providers:**

- **OpenAI**: GPT-4o, GPT-4o-mini, text-embedding-3-large
- **Anthropic**: Claude 3.5 Sonnet, Claude Haiku
- **Cohere**: Command, Embed-english-v3.0

**Use Cases:**

| Use Case                      | Model                  | Provider | Cost/Call            |
| ----------------------------- | ---------------------- | -------- | -------------------- |
| **Progressive Summarization** | gpt-4o-mini            | OpenAI   | $0.0001              |
| **Vision Enrichment**         | gpt-4o                 | OpenAI   | $0.01                |
| **Text-to-SQL**               | gpt-4o-mini            | OpenAI   | $0.0005              |
| **Question Synthesis**        | gpt-4o-mini            | OpenAI   | $0.0002              |
| **Embedding**                 | text-embedding-3-large | OpenAI   | $0.00013 / 1K tokens |

**Configuration (Per-Index):**

```typescript
{
  useCases: {
    vision: {
      enabled: boolean,
      model: 'gpt-4o' | 'claude-3.5-sonnet',
      maxTokens: number
    },
    summarization: {
      enabled: boolean,
      model: 'gpt-4o-mini' | 'claude-haiku',
      maxTokens: number
    },
    questionSynthesis: {
      enabled: boolean,
      model: 'gpt-4o-mini',
      questionsPerChunk: number
    },
    embedding: {
      model: 'text-embedding-3-large' | 'embed-english-v3.0',
      dimensions: 3072 | 1024
    }
  }
}
```

---

## Data Flow

### Document Ingestion Flow

```
1. User uploads document.pdf
   ↓
2. API creates Document record in MongoDB (status: pending)
   ↓
3. API enqueues job to document-ingestion queue
   ↓
4. ingestion-worker picks up job
   ↓
5. Worker enqueues docling-extraction job
   ↓
6. docling-extraction-worker extracts pages
   ↓
7. Worker creates DocumentPage records (1 per page)
   ↓
8. Worker enqueues page-processing jobs (parallel)
   ↓
9. page-processing-worker chunks each page
   ↓
10. Worker creates SearchChunk records
   ↓
11. Worker enqueues visual-enrichment jobs (if images)
   ↓
12. visual-enrichment-worker analyzes images with vision LLM
   ↓
13. Worker updates SearchChunk with visual insights
   ↓
14. Worker enqueues question-synthesis job
   ↓
15. question-synthesis-worker generates questions
   ↓
16. Worker creates ChunkQuestion records
   ↓
17. Worker enqueues embedding job (batched)
   ↓
18. embedding-worker generates embeddings
   ↓
19. Worker updates SearchChunk with embeddings
   ↓
20. Document status → completed
```

---

### Structured Data Ingestion Flow

```
1. User uploads data.csv
   ↓
2. API: POST /analyze
   ↓
3. Parse CSV, detect schema, calculate cost
   ↓
4. Cache analysis result (1-hour TTL)
   ↓
5. Return analysis to user
   ↓
   ... (user reviews, optionally edits) ...
   ↓
6. User submits: POST /ingest
   ↓
7. Retrieve cached file and analysis
   ↓
8. Create ingestion job in queue
   ↓
9. structured-data-ingestion-worker picks up job
   ↓
10. Worker parses CSV, extracts rows
   ↓
11. Worker applies metadata-only chunking (1 chunk)
   ↓
12. Worker inserts all rows into ClickHouse
   ↓
13. Worker inserts table metadata into ClickHouse
   ↓
14. Worker creates SearchChunk in MongoDB (metadata only)
   ↓
15. If JSON nested: extract paths, insert into ClickHouse path_index
   ↓
16. Worker enqueues embedding job
   ↓
17. embedding-worker embeds metadata chunk
   ↓
18. Worker updates SearchChunk with embedding
   ↓
19. Table status → completed
```

---

### Query Flow (Hybrid Retrieval)

```
User Query: "Show me users from California who ordered laptops"
   ↓
1. Query Router classifies intent
   ↓
2. Intent: SQL (structured query)
   ↓
3. Table Discovery finds relevant tables (users, orders, products)
   ↓
4. Text-to-SQL generates SQL with JOIN
   ↓
5. Security validation (no DROP/DELETE, tenant isolation enforced)
   ↓
6. Execute SQL on ClickHouse
   ↓
7. Return results to user
   ↓
   (Alternative path for semantic query:)
   ↓
1. Query Router classifies intent
   ↓
2. Intent: Semantic
   ↓
3. Embed query text
   ↓
4. Vector search on SearchChunk embeddings (MongoDB Atlas Search)
   ↓
5. Filter by tenantId, indexId
   ↓
6. Rerank results
   ↓
7. Return top K chunks
```

---

## Tech Stack

| Layer                   | Technology                  | Purpose                          |
| ----------------------- | --------------------------- | -------------------------------- |
| **Runtime**             | Node.js 20+                 | Server-side execution            |
| **API Framework**       | Express.js                  | REST API                         |
| **WebSockets**          | Socket.io                   | Real-time updates                |
| **Job Queue**           | BullMQ (Redis)              | Distributed job processing       |
| **Primary DB**          | MongoDB Atlas               | Document metadata, chunks        |
| **Analytics DB**        | ClickHouse                  | Structured data, path index      |
| **Cache**               | Redis Cluster               | Session cache, analysis cache    |
| **Vector Search**       | MongoDB Atlas Vector Search | Semantic similarity              |
| **Document Extraction** | Docling                     | PDF, DOCX extraction             |
| **LLM Providers**       | OpenAI, Anthropic           | Summarization, vision, embedding |
| **Monitoring**          | Datadog, Sentry             | Metrics, error tracking          |

---

## Deployment Architecture

```
┌───────────────────────────────────────────────┐
│              Load Balancer (ALB)              │
└──────────────┬────────────────────────────────┘
               │
               ├───────────────┬────────────────┐
               ▼               ▼                ▼
       ┌───────────┐   ┌───────────┐   ┌───────────┐
       │  API Pod  │   │  API Pod  │   │  API Pod  │
       │  (3 pods) │   │  (3 pods) │   │  (3 pods) │
       └───────────┘   └───────────┘   └───────────┘
               │               │                │
               └───────────────┴────────────────┘
                              │
               ┌──────────────┴──────────────┐
               ▼                             ▼
    ┌─────────────────────┐      ┌──────────────────────┐
    │  Worker Pods        │      │   Redis Cluster      │
    │  - Docling (3)      │      │   (3 nodes)          │
    │  - Processing (5)   │      │   - Job queues       │
    │  - Structured (5)   │      │   - Session cache    │
    │  - Vision (3)       │      └──────────────────────┘
    │  - Embedding (10)   │
    └─────────────────────┘
               │
               ├──────────────────┬─────────────────────┐
               ▼                  ▼                     ▼
    ┌─────────────────┐ ┌──────────────────┐ ┌─────────────────┐
    │  MongoDB Atlas  │ │  ClickHouse      │ │  S3 Storage     │
    │  (M30 cluster)  │ │  (3-node cluster)│ │  (Document      │
    │  - Replica set  │ │  - Sharded       │ │   originals)    │
    └─────────────────┘ └──────────────────┘ └─────────────────┘
```

**Scaling Strategy:**

- **API Pods:** Horizontal scaling (3-20 pods based on load)
- **Worker Pods:** Auto-scale based on queue depth
- **MongoDB:** Vertical scaling (M30 → M50 → M100)
- **ClickHouse:** Horizontal sharding for large datasets
- **Redis:** Cluster mode for high availability

---

## Performance & Capacity

### Throughput

| Metric                | Capacity | Notes                    |
| --------------------- | -------- | ------------------------ |
| **Documents/hour**    | 500-1000 | 50-page PDFs with vision |
| **CSV files/hour**    | 5000+    | 100K rows each           |
| **Embeddings/second** | 100      | Batched, 512 tokens each |
| **Queries/second**    | 500      | Mixed semantic + SQL     |

### Latency (p95)

| Operation                    | Latency | Notes                 |
| ---------------------------- | ------- | --------------------- |
| **Document ingestion start** | <500ms  | API response time     |
| **CSV analysis**             | <2s     | Schema detection      |
| **Semantic search**          | <100ms  | Top 10 results        |
| **Text-to-SQL query**        | <200ms  | Single table          |
| **Cross-table JOIN**         | <500ms  | 2-3 tables, 100K rows |

### Storage

| Data Type                   | Compression Ratio | Notes                |
| --------------------------- | ----------------- | -------------------- |
| **Text (MongoDB)**          | 1x                | BSON overhead        |
| **Embeddings (MongoDB)**    | N/A               | Raw float arrays     |
| **Table data (ClickHouse)** | 10x               | Columnar compression |
| **JSON paths (ClickHouse)** | 5x                | Dictionary encoding  |

---

## Security & Compliance

### Tenant Isolation (Platform Principle #1)

**Enforcement Points:**

1. **API Layer:** All requests validated for tenant + index access
2. **Worker Layer:** Jobs scoped to tenant context
3. **Database Layer:** All queries filtered by tenantId + indexId
4. **Cache Layer:** Keys prefixed with tenantId

**Validation:**

- Every SearchChunk query includes `{ tenantId, indexId }`
- Never use `findById()` (no tenant check)
- Never use global queries without tenant filter

### Data Encryption

- **At Rest:** MongoDB encrypted volumes, ClickHouse encryption
- **In Transit:** TLS 1.3 for all inter-service communication
- **Credentials:** KMS-backed secret storage

### Audit Logging

All actions logged with:

- Actor identity (userId, tenantId)
- Timestamp
- Action type (create, read, update, delete)
- Resource identifier

---

## Monitoring & Observability

### Metrics (Datadog)

- **Throughput:** Documents/hour, chunks/hour, embeddings/second
- **Latency:** API response time, worker processing time, query latency
- **Queue Depth:** Pending jobs per queue
- **Error Rate:** Failed jobs, API errors, worker crashes
- **Resource Usage:** CPU, memory, disk, network

### Traces (Custom Trace Store)

Every operation emits structured trace events:

- LLM calls (prompt, response, tokens, duration)
- Tool executions (input, output, duration)
- Database queries (query, rows, duration)
- Worker processing (job data, progress, result)

**Trace Storage:** ClickHouse `trace_events` table

### Alerts

- **High Error Rate:** >5% failed jobs
- **High Queue Depth:** >1000 pending jobs
- **High Latency:** API p95 >1s
- **Worker Crashes:** >3 crashes/hour
- **Storage Issues:** Disk >80% full

---

## Related Documentation

- [Documents Guide](./01-documents-pdf-docx.md) - Document pipeline details
- [CSV Guide](./02-structured-csv.md) - Structured data pipeline details
- [Tenant Isolation](./11-security-tenant-isolation.md) - Security patterns
- [Retrieval Checklist](./20-retrieval-checklist.md) - Optimization guide

---

**Next:** [Tenant Isolation Guide](./11-security-tenant-isolation.md) →
