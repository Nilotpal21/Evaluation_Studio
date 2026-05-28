# RFC-005: Job Tracking Architecture for Search-AI Pipeline

**Status:** Approved (Documenting Existing Implementation)
**Created:** 2026-03-04
**Author:** Platform Engineering Team
**Type:** Documentation RFC (captures existing design decisions)
**Related:** RFC-004 (Pluggable Pipelines), RFC-006 (Job Tracking + Flows Integration)

---

## Table of Contents

1. [Executive Summary](#executive-summary)
2. [Background & Motivation](#background--motivation)
3. [Goals & Non-Goals](#goals--non-goals)
4. [Architecture Overview](#architecture-overview)
5. [Schema Design](#schema-design)
6. [Design Decisions & Rationale](#design-decisions--rationale)
7. [Worker Instrumentation](#worker-instrumentation)
8. [Query Patterns](#query-patterns)
9. [Performance Analysis](#performance-analysis)
10. [Monitoring & Observability](#monitoring--observability)
11. [Strengths & Limitations](#strengths--limitations)
12. [Future Extensibility](#future-extensibility)
13. [References](#references)

---

## Executive Summary

This RFC documents the **existing job tracking architecture** for Search-AI's ingestion pipeline. The system tracks every worker job execution with comprehensive metrics, errors, and context for debugging, monitoring, and analytics.

**Key Design Decision:** ✅ **Flat schema with no parent-child linking**

Each job execution is tracked independently with contextual fields (`sourceId`, `documentId`, `workerStage`) for grouping and filtering, avoiding the complexity and performance issues of hierarchical parent-child relationships.

**Core Value:**

- Complete visibility into every pipeline stage
- Fast queries for document/source-level aggregations
- No hot document problems
- Worker-agnostic instrumentation
- Scalable to millions of jobs

---

## Background & Motivation

### **The Problem**

Search-AI's ingestion pipeline consists of 17 workers processing documents through multiple stages:

```
Upload → Ingestion → Extraction → Page Processing → Chunking →
Enrichment → [KG | Multimodal | Embedding] → Cleanup
```

**Without job tracking:**

- ❌ No visibility into pipeline execution
- ❌ Cannot debug failures ("Which stage failed?")
- ❌ No performance metrics ("Why is ingestion slow?")
- ❌ No cost tracking (LLM tokens, API calls)
- ❌ Cannot answer "Is this document indexed?"

### **Requirements**

1. **Per-Job Tracking**: Every worker execution tracked with full context
2. **Fast Queries**: Document/source-level aggregations in <500ms
3. **Full Metrics**: Duration, LLM calls, memory, items processed
4. **Error Details**: Stack traces, retry attempts, failure reasons
5. **Scalability**: Handle millions of jobs without performance degradation
6. **Worker Agnostic**: No changes to worker business logic

---

## Goals & Non-Goals

### **Goals**

- ✅ Track every job execution with complete context
- ✅ Enable fast document-level queries ("Show pipeline for doc-A")
- ✅ Enable fast source-level queries ("Summary of source sync")
- ✅ Capture comprehensive metrics (duration, LLM tokens, memory)
- ✅ Record full error details for debugging
- ✅ Support distributed tracing (trace IDs)
- ✅ Maintain flat schema for scalability
- ✅ Zero impact on worker business logic

### **Non-Goals**

- ❌ Real-time job status updates (eventual consistency acceptable)
- ❌ Parent-child job relationships (avoided for simplicity)
- ❌ Nested pipeline hierarchies (flat filtering sufficient)
- ❌ Job dependency graphs (inferred from time ordering)
- ❌ Cross-tenant job aggregations (tenant isolation maintained)

---

## Architecture Overview

### **High-Level Flow**

```
┌─────────────────────────────────────────────────────┐
│  1. Document Upload                                  │
│     → API creates job in BullMQ queue               │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│  2. Worker Picks Up Job                              │
│     → BullMQ worker polls queue                     │
│     → Gets job with data: { documentId, sourceId }  │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│  3. Instrumentation Wrapper Intercepts               │
│     ⚡ Creates JobExecution record                   │
│     → MongoDB insert with status: 'running'         │
│     → Captures enqueue time, worker info            │
└──────────────────┬──────────────────────────────────┘
                   │
┌──────────────────▼──────────────────────────────────┐
│  4. Worker Handler Executes                          │
│     → Business logic runs                           │
│     → ctx.recordLLMCall(tokens) updates metrics     │
│     → ctx.incrementItemsProcessed()                 │
└──────────────────┬──────────────────────────────────┘
                   │
        ┌──────────┴──────────┐
        │                     │
┌───────▼────────┐  ┌────────▼───────┐
│  5a. Success   │  │  5b. Failure   │
│  → Update:     │  │  → Update:     │
│    status:     │  │    status:     │
│    'completed' │  │    'failed'    │
│    completedAt │  │    error: {}   │
│    metrics: {} │  │    stack trace │
└────────────────┘  └────────────────┘
```

### **Component Interaction**

```
┌──────────────┐
│   BullMQ     │  Job queues (Redis)
│   Queues     │  - ingestion-queue
└──────┬───────┘  - extraction-queue
       │          - embedding-queue
       │
┌──────▼───────┐
│   Workers    │  17 worker types
│   (Node.js)  │  - Each wrapped with instrumentation
└──────┬───────┘
       │
┌──────▼───────┐
│ Instrument-  │  Automatic job tracking
│   ation      │  - Create JobExecution on job start
│   Layer      │  - Update metrics during execution
└──────┬───────┘  - Update status on completion/failure
       │
┌──────▼───────┐
│   MongoDB    │  job_executions collection
│ JobExecution │  - Flat schema
└──────────────┘  - Indexed for fast queries
```

---

## Schema Design

### **JobExecution Collection**

```javascript
{
  // Identity
  _id: ObjectId("..."),
  bullJobId: "bull-ingestion-12345",        // BullMQ job ID (unique)
  workerStage: "enrichment",                 // Which worker processed this
  queueName: "prod-interactive:enrichment",  // Full queue name

  // Context (for filtering and grouping)
  tenantId: "tenant-xyz",
  sourceId: "confluence-src-456",    // 🎯 Group by source sync
  documentId: "doc-042",              // 🎯 Group by document
  indexId: "idx-789",                 // Which index

  // Status & Timing
  status: "completed",                // running | completed | failed | retrying
  enqueuedAt: ISODate("2026-03-03T10:00:00Z"),
  startedAt: ISODate("2026-03-03T10:00:05Z"),
  completedAt: ISODate("2026-03-03T10:00:12Z"),

  // Metrics (comprehensive)
  metrics: {
    durationMs: 7000,                 // Total execution time
    queueWaitMs: 5000,                // Time waiting in queue
    itemsProcessed: 120,              // Chunks, pages, entities, etc.
    llmCallsCount: 12,                // Number of LLM API calls
    llmTokensUsed: 18000,             // Total tokens consumed
    externalApiCalls: 1,              // Docling, BGE-M3, etc.
    dbOperations: 125,                // MongoDB queries
    memoryUsedBytes: 450000000        // Peak memory usage
  },

  // Error (if failed)
  error: {
    message: "LLM API rate limit exceeded",
    code: "RATE_LIMIT_ERROR",
    stack: "Error: ...\n  at ...",
    context: {                        // Contextual debug info
      llmProvider: "gemini",
      retryAfter: 60
    }
  },

  // Retry tracking
  retryInfo: {
    attemptNumber: 2,                 // Current attempt (1-indexed)
    maxAttempts: 3,                   // Configured max
    lastRetryAt: ISODate("..."),
    nextRetryAt: ISODate("...")       // When next retry scheduled
  },

  // Worker & Infrastructure
  workerInstanceId: "search-ai-pod-3",        // Worker process ID
  podName: "search-ai-worker-7d4f9c8b-abc12", // K8s pod name
  traceId: "trace-uuid-xxx",                  // Distributed tracing ID

  // Timestamps
  createdAt: ISODate("2026-03-03T10:00:05Z"),
  updatedAt: ISODate("2026-03-03T10:00:12Z")
}
```

### **Field Descriptions**

| Field         | Type   | Purpose                          | Required   |
| ------------- | ------ | -------------------------------- | ---------- |
| `bullJobId`   | String | BullMQ job identifier (unique)   | Yes        |
| `workerStage` | Enum   | Which worker processed this job  | Yes        |
| `sourceId`    | String | Group jobs by source sync        | Optional\* |
| `documentId`  | String | Group jobs by document           | Optional\* |
| `status`      | Enum   | Current job state                | Yes        |
| `metrics`     | Object | Performance & resource metrics   | Yes        |
| `error`       | Object | Failure details (only if failed) | No         |
| `retryInfo`   | Object | Retry attempt tracking           | No         |
| `traceId`     | String | Link to distributed trace        | Yes        |

\*Either `sourceId` or `documentId` should be present for most jobs

### **Status Values**

```typescript
enum JobStatus {
  RUNNING = 'running', // Currently executing
  COMPLETED = 'completed', // Finished successfully
  FAILED = 'failed', // Failed (may retry)
  RETRYING = 'retrying', // Waiting for retry
}
```

### **Worker Stages**

```typescript
enum WorkerStage {
  // Core pipeline
  INGESTION = 'ingestion',
  EXTRACTION = 'extraction',
  DOCLING_EXTRACTION = 'docling-extraction',
  PAGE_PROCESSING = 'page-processing',
  CANONICAL_MAPPER = 'canonical-mapper',

  // Enrichment stages
  NOISE_DETECTION = 'noise-detection',
  VISUAL_ENRICHMENT = 'visual-enrichment',
  ENRICHMENT = 'enrichment',
  KG_ENRICHMENT = 'kg-enrichment',
  TAXONOMY_SETUP = 'taxonomy-setup',

  // Output stages
  KNOWLEDGE_GRAPH = 'knowledge-graph',
  MULTIMODAL = 'multimodal',
  TREE_BUILDING = 'tree-building',
  QUESTION_SYNTHESIS = 'question-synthesis',
  SCOPE_CLASSIFICATION = 'scope-classification',
  EMBEDDING = 'embedding',

  // Utility
  CLEANUP = 'cleanup',
}
```

---

## Design Decisions & Rationale

### **Decision 1: Flat Schema (No Parent-Child Links)**

#### **Rejected Alternative: Hierarchical Schema**

```javascript
// ❌ REJECTED: Parent-child linking
JobExecution {
  _id: "parent-job-1",
  childJobIds: ["child-1", "child-2", "child-3"],  // Array of children
  status: "waiting-children"
}

JobExecution {
  _id: "child-1",
  parentJobId: "parent-job-1"  // Link back to parent
}
```

**Why Rejected:**

1. **Hot Document Problem**
   - Parent updated every time child completes
   - With 50 parallel chunks → 50 concurrent writes to same parent document
   - MongoDB write contention → poor performance

2. **Array Bloat**
   - `childJobIds` array grows with pipeline complexity
   - Custom pipelines with 20 stages → 20-element array
   - Document size increases, indexing degrades

3. **Complex Queries**
   - "Show all jobs for document" requires recursive traversal
   - Must follow parent → children → grandchildren chains
   - Slow queries (10-100× vs flat schema)

4. **Race Conditions**
   - Concurrent children updating parent's `childJobIds[]`
   - Requires transactions or atomic array operations
   - Complexity without benefit

#### **Chosen Alternative: Flat Schema with Context Fields**

```javascript
// ✅ CHOSEN: Flat schema with grouping fields
JobExecution {
  _id: "job-1",
  documentId: "doc-A",  // Group by document
  sourceId: "src-123",  // Group by source
  workerStage: "enrichment",
  createdAt: Date
}

JobExecution {
  _id: "job-2",
  documentId: "doc-A",  // Same document
  sourceId: "src-123",  // Same source
  workerStage: "embedding",
  createdAt: Date
}
```

**Why Chosen:**

1. **No Hot Documents**
   - Each job is independent document
   - No concurrent writes to shared parent
   - Linear scalability

2. **Simple Queries**
   - "Show all jobs for doc-A": `find({ documentId: "doc-A" })`
   - Fast (single index scan)
   - No traversal needed

3. **Time Ordering Sufficient**
   - Sort by `createdAt` to see pipeline sequence
   - Natural chronological order
   - No explicit dependencies needed

4. **Easy Extensions**
   - Add new workers → no schema changes
   - Add new context fields → backward compatible
   - No complex relationship maintenance

**Trade-off:**

- ⚠️ Cannot reconstruct exact DAG from data alone
- ✅ But time ordering + stage names are sufficient for debugging
- ✅ And avoids all the downsides of hierarchical schema

### **Decision 2: Comprehensive Metrics in Single Object**

#### **Rejected Alternative: Separate Metrics Collection**

```javascript
// ❌ REJECTED: Normalized schema
JobExecution {
  _id: "job-1",
  // Basic fields only
}

JobMetrics {
  jobExecutionId: "job-1",
  metricName: "llmTokensUsed",
  value: 18000
}
// Multiple documents per job
```

**Why Rejected:**

- More complex queries (joins required)
- Higher storage overhead (repeated jobExecutionId)
- Slower aggregations

#### **Chosen Alternative: Embedded Metrics Object**

```javascript
// ✅ CHOSEN: Embedded metrics
JobExecution {
  _id: "job-1",
  metrics: {
    durationMs: 7000,
    llmCallsCount: 12,
    llmTokensUsed: 18000,
    itemsProcessed: 120,
    // ... all metrics in one place
  }
}
```

**Why Chosen:**

- Single document read gets all metrics
- Atomic updates (all metrics updated together)
- Better locality (related data together)
- Simpler queries

### **Decision 3: Worker-Side Instrumentation**

#### **Rejected Alternative: Job Orchestrator Tracks Jobs**

```javascript
// ❌ REJECTED: Central orchestrator
class PipelineOrchestrator {
  async processDocument(documentId) {
    const jobExec1 = await JobExecution.create({ stage: 'ingestion' });
    await runIngestion();
    await JobExecution.updateOne({ _id: jobExec1._id }, { status: 'completed' });

    const jobExec2 = await JobExecution.create({ stage: 'extraction' });
    await runExtraction();
    // ... etc
  }
}
```

**Why Rejected:**

- Tight coupling (orchestrator must know all workers)
- Breaks distributed architecture (single point of orchestration)
- Workers can't run independently

#### **Chosen Alternative: Wrapper Around Each Worker**

```typescript
// ✅ CHOSEN: Instrumentation wrapper
function createInstrumentedProcessor(
  workerStage: WorkerStage,
  queueName: string,
  handler: JobHandler
) {
  return async (job: Job) => {
    // Create JobExecution record
    const jobExec = await JobExecution.create({ ... });

    try {
      // Run actual handler
      await handler(job, createContext(jobExec));

      // Update on success
      await JobExecution.updateOne({ _id: jobExec._id }, {
        status: 'completed',
        metrics: ...
      });
    } catch (error) {
      // Update on failure
      await JobExecution.updateOne({ _id: jobExec._id }, {
        status: 'failed',
        error: ...
      });
    }
  };
}
```

**Why Chosen:**

- Decoupled (workers don't know about tracking)
- Distributed (each worker tracks itself)
- Flexible (easy to add new workers)
- Testable (can test workers without tracking)

---

## Worker Instrumentation

### **Integration Pattern**

Every worker follows this pattern:

```typescript
// File: apps/search-ai/src/workers/enrichment-worker.ts

import { Worker } from 'bullmq';
import { createInstrumentedProcessor, WorkerStage } from './instrumentation.js';

// 1. Define job handler (your business logic)
async function processEnrichmentJob(
  job: Job,
  ctx: JobExecutionContext, // ← Tracking context
): Promise<void> {
  const { documentId, indexId, tenantId } = job.data;

  // Your business logic
  const chunks = await SearchChunk.find({ documentId, tenantId });

  for (const chunk of chunks) {
    const entities = await extractEntities(chunk.text);

    // Track metrics (optional but recommended)
    ctx.incrementItemsProcessed();
    ctx.recordLLMCall(tokens);

    await chunk.save();
  }

  // Enqueue next stage (unchanged)
  await embeddingQueue.add('embed', { documentId, indexId, tenantId });
}

// 2. Wrap handler with instrumentation
export function createEnrichmentWorker(concurrency = 5): Worker {
  const processor = createInstrumentedProcessor(
    WorkerStage.ENRICHMENT, // Which worker stage
    QUEUE_ENRICHMENT, // Queue name
    processEnrichmentJob, // Your handler
  );

  return new Worker(QUEUE_ENRICHMENT, processor, createWorkerOptions(concurrency));
}
```

### **JobExecutionContext API**

```typescript
interface JobExecutionContext {
  // Metrics tracking
  incrementItemsProcessed(count?: number): void;
  recordLLMCall(tokens: number): void;
  recordExternalApiCall(): void;
  recordDbOperation(): void;

  // Batch updates (for long-running jobs)
  updateMetrics(): Promise<void>;

  // Get current metrics
  getMetrics(): JobMetrics;
}
```

### **Instrumentation Internals**

```typescript
// Simplified implementation
export function createInstrumentedProcessor(
  workerStage: WorkerStage,
  queueName: string,
  handler: JobHandler,
) {
  return async (job: Job) => {
    const startTime = Date.now();
    const { tenantId, sourceId, documentId, indexId } = job.data;

    // 1. Create JobExecution record (status: running)
    const jobExecution = await JobExecution.create({
      bullJobId: job.id,
      workerStage,
      queueName,
      tenantId,
      sourceId,
      documentId,
      indexId,
      status: 'running',
      enqueuedAt: new Date(job.timestamp),
      startedAt: new Date(),
      workerInstanceId: process.env.WORKER_ID,
      podName: process.env.POD_NAME,
      traceId: job.data.traceId || uuidv4(),
      metrics: {
        queueWaitMs: Date.now() - job.timestamp,
        itemsProcessed: 0,
        llmCallsCount: 0,
        llmTokensUsed: 0,
        externalApiCalls: 0,
        dbOperations: 0,
        memoryUsedBytes: 0,
      },
    });

    // 2. Create context for handler
    const ctx = createJobExecutionContext(jobExecution);

    try {
      // 3. Execute handler
      await handler(job, ctx);

      // 4. Update on success
      await JobExecution.updateOne(
        { _id: jobExecution._id },
        {
          status: 'completed',
          completedAt: new Date(),
          'metrics.durationMs': Date.now() - startTime,
          'metrics.memoryUsedBytes': process.memoryUsage().heapUsed,
          ...ctx.getMetrics(),
        },
      );
    } catch (error) {
      // 5. Update on failure
      await JobExecution.updateOne(
        { _id: jobExecution._id },
        {
          status: 'failed',
          completedAt: new Date(),
          'metrics.durationMs': Date.now() - startTime,
          error: {
            message: error instanceof Error ? error.message : String(error),
            code: error.code || 'UNKNOWN_ERROR',
            stack: error instanceof Error ? error.stack : undefined,
            context: error.context || {},
          },
          retryInfo: {
            attemptNumber: job.attemptsMade,
            maxAttempts: job.opts.attempts || 3,
          },
        },
      );

      throw error; // Re-throw for BullMQ retry logic
    }
  };
}
```

---

## Query Patterns

### **Query 1: Full Pipeline for Document**

**Use Case:** User asks "Is doc-042 indexed? Where did it fail?"

```javascript
const jobs = await JobExecution.find({
  documentId: 'doc-042',
}).sort({ createdAt: 1 });

// Returns all jobs in chronological order
[
  { workerStage: 'ingestion', status: 'completed', durationMs: 145 },
  { workerStage: 'docling-extraction', status: 'completed', durationMs: 11500 },
  { workerStage: 'page-processing', status: 'completed', durationMs: 3500 },
  { workerStage: 'enrichment', status: 'failed', error: 'Rate limit' },
  // No embedding job (because enrichment failed)
];
```

**Performance:** ~50ms with index on `{ documentId: 1, createdAt: -1 }`

### **Query 2: Source Sync Summary**

**Use Case:** User syncs Confluence source, wants summary

```javascript
const summary = await JobExecution.aggregate([
  { $match: { sourceId: 'confluence-src-456' } },
  {
    $group: {
      _id: { stage: '$workerStage', status: '$status' },
      count: { $sum: 1 },
      avgDuration: { $avg: '$metrics.durationMs' },
      totalTokens: { $sum: '$metrics.llmTokensUsed' },
    },
  },
]);

// Returns aggregated stats
[
  {
    _id: { stage: 'ingestion', status: 'completed' },
    count: 1,
    avgDuration: 145,
    totalTokens: 0,
  },
  {
    _id: { stage: 'docling-extraction', status: 'completed' },
    count: 1000,
    avgDuration: 12000,
    totalTokens: 0,
  },
  {
    _id: { stage: 'enrichment', status: 'completed' },
    count: 998,
    avgDuration: 4500,
    totalTokens: 1500000,
  },
  {
    _id: { stage: 'enrichment', status: 'failed' },
    count: 2,
    avgDuration: 3000,
    totalTokens: 50000,
  },
];
```

**Performance:** ~500ms for 8,000 records with index on `{ sourceId: 1, workerStage: 1, status: 1 }`

### **Query 3: Failed Jobs**

**Use Case:** Support needs list of failed documents

```javascript
const failedDocs = await JobExecution.distinct('documentId', {
  sourceId: 'confluence-src-456',
  status: 'failed',
});

// Returns: ["doc-042", "doc-789"]
```

**Performance:** ~200ms with index

### **Query 4: Performance Bottlenecks**

**Use Case:** Engineering wants to identify slow stages

```javascript
const slowStages = await JobExecution.aggregate([
  {
    $match: {
      tenantId: 'tenant-xyz',
      status: 'completed',
      createdAt: { $gte: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000) }, // Last 7 days
    },
  },
  {
    $group: {
      _id: '$workerStage',
      count: { $sum: 1 },
      avgDuration: { $avg: '$metrics.durationMs' },
      p95Duration: {
        $percentile: { input: '$metrics.durationMs', p: [0.95], method: 'approximate' },
      },
    },
  },
  { $sort: { p95Duration: -1 } },
  { $limit: 5 },
]);

// Returns slowest stages by P95
[
  { _id: 'docling-extraction', avgDuration: 12000, p95Duration: 18000 },
  { _id: 'embedding', avgDuration: 8000, p95Duration: 12000 },
  { _id: 'enrichment', avgDuration: 4500, p95Duration: 7000 },
];
```

### **Query 5: Cost Analysis**

**Use Case:** Finance wants to track LLM costs

```javascript
const costs = await JobExecution.aggregate([
  {
    $match: {
      tenantId: 'tenant-xyz',
      createdAt: { $gte: startOfMonth, $lte: endOfMonth },
    },
  },
  {
    $group: {
      _id: '$workerStage',
      totalTokens: { $sum: '$metrics.llmTokensUsed' },
      totalCalls: { $sum: '$metrics.llmCallsCount' },
    },
  },
]);

// Calculate cost (assuming $0.001 per 1K tokens)
costs.forEach((stage) => {
  stage.estimatedCost = (stage.totalTokens / 1000) * 0.001;
});
```

---

## Performance Analysis

### **Write Operations**

**Per Job:**

- 1 INSERT (create JobExecution)
- 1-2 UPDATES (complete/fail, optional metrics updates during execution)

**Example Document Flow (8 stages):**

- 8 inserts
- 16 updates
- **Total: 24 MongoDB operations**

**Performance:** Linear with job count (no hot documents)

### **Read Operations**

**With Proper Indexes:**

| Query Type       | Records Scanned | Time  | Index Used                                       |
| ---------------- | --------------- | ----- | ------------------------------------------------ |
| Document history | 8-20            | 50ms  | `{ documentId: 1, createdAt: -1 }`               |
| Source summary   | 8,000           | 500ms | `{ sourceId: 1, workerStage: 1 }`                |
| Failed jobs      | 2               | 200ms | `{ sourceId: 1, status: 1 }`                     |
| Tenant analytics | 50,000          | 2s    | `{ tenantId: 1, workerStage: 1, createdAt: -1 }` |

### **Storage**

**Per JobExecution:**

- Average size: 2KB (with metrics, no error)
- With error/stack trace: 4KB
- With retry info: 2.5KB

**Scale Estimates:**

| Scale                | Jobs/Day  | Storage/Day | Storage/Year | Query Time |
| -------------------- | --------- | ----------- | ------------ | ---------- |
| Small (10 tenants)   | 10,000    | 20 MB       | 7 GB         | <50ms      |
| Medium (100 tenants) | 100,000   | 200 MB      | 73 GB        | <200ms     |
| Large (1000 tenants) | 1,000,000 | 2 GB        | 730 GB       | <500ms     |

**MongoDB Cluster:** Standard 3-node replica set handles Large scale easily

### **Index Size**

**Primary Indexes:**

```javascript
db.job_executions.createIndex({ documentId: 1, createdAt: -1 });
// ~50 bytes per entry, 1M docs = 50MB

db.job_executions.createIndex({ sourceId: 1, workerStage: 1, status: 1 });
// ~100 bytes per entry, 1M docs = 100MB

db.job_executions.createIndex({ tenantId: 1, status: 1, workerStage: 1, createdAt: -1 });
// ~150 bytes per entry, 1M docs = 150MB

db.job_executions.createIndex({ bullJobId: 1 });
// ~50 bytes per entry, unique, 1M docs = 50MB

db.job_executions.createIndex({ traceId: 1 });
// ~50 bytes per entry, 1M docs = 50MB
```

**Total Index Size:** ~400MB for 1M jobs (manageable)

---

## Monitoring & Observability

### **Key Metrics to Monitor**

**1. Pipeline Health**

```javascript
// Jobs by status (gauge)
db.job_executions.aggregate([
  { $match: { createdAt: { $gte: lastHour } } },
  { $group: { _id: '$status', count: { $sum: 1 } } },
]);

// Alert if failure rate > 5%
```

**2. Stage Performance**

```javascript
// Average duration per stage (histogram)
db.job_executions.aggregate([
  { $match: { status: "completed", createdAt: { $gte: lastHour } } },
  { $group: {
      _id: "$workerStage",
      avgDuration: { $avg: "$metrics.durationMs" },
      p95Duration: { $percentile: ... }
  }}
])

// Alert if P95 > 2× baseline
```

**3. Queue Wait Times**

```javascript
// Time jobs spend in queue before processing
db.job_executions.aggregate([
  {
    $group: {
      _id: '$queueName',
      avgWait: { $avg: '$metrics.queueWaitMs' },
    },
  },
]);

// Alert if wait time > 60s (capacity issue)
```

**4. LLM Token Usage**

```javascript
// Tokens consumed per hour
db.job_executions.aggregate([
  { $match: { createdAt: { $gte: lastHour } } },
  {
    $group: {
      _id: null,
      totalTokens: { $sum: '$metrics.llmTokensUsed' },
    },
  },
]);

// Alert if usage spikes (cost control)
```

**5. Retry Rates**

```javascript
// Jobs that required retries
db.job_executions.countDocuments({
  'retryInfo.attemptNumber': { $gt: 1 },
});

// Alert if retry rate > 10%
```

### **Dashboards**

**Dashboard 1: Pipeline Overview**

- Jobs processed (last 24h)
- Success rate by stage
- Average processing time
- Current queue depths

**Dashboard 2: Source Sync Monitoring**

- Active syncs
- Documents processed
- Failure breakdown by stage
- Estimated completion time

**Dashboard 3: Performance**

- Stage durations (P50, P95, P99)
- Queue wait times
- Worker utilization
- Memory usage trends

**Dashboard 4: Costs**

- LLM tokens consumed
- API calls made
- Estimated monthly cost
- Cost per document

### **Alerting Rules**

```yaml
alerts:
  - name: HighFailureRate
    condition: failure_rate > 0.05
    severity: warning

  - name: StageSlow
    condition: p95_duration > 2 * baseline
    severity: warning

  - name: QueueBacklog
    condition: queue_wait_ms > 60000
    severity: critical

  - name: LLMCostSpike
    condition: hourly_tokens > 1.5 * avg_hourly
    severity: warning
```

---

## Strengths & Limitations

### **✅ Strengths**

1. **Scalability**
   - Flat schema → no hot documents
   - Linear performance with job count
   - Handles millions of jobs

2. **Fast Queries**
   - Document history: <50ms
   - Source summary: <500ms
   - Simple indexes, no traversal

3. **Complete Visibility**
   - Every job tracked
   - Full metrics captured
   - Comprehensive error details

4. **Worker Agnostic**
   - Workers don't know about tracking
   - Easy to add new workers
   - Business logic unchanged

5. **Extensible**
   - Add new fields without breaking existing
   - Add new workers without schema changes
   - Backward compatible

6. **Debuggable**
   - Trace IDs for distributed tracing
   - Full error stacks
   - Worker instance identification

### **⚠️ Limitations**

1. **Cannot Reconstruct Exact DAG**
   - No parent-child links
   - Must infer pipeline from time ordering
   - Acceptable tradeoff for simplicity

2. **Eventual Consistency**
   - Job status updates are async
   - Brief lag between completion and status update
   - Not suitable for real-time monitoring (few seconds lag)

3. **Storage Growth**
   - Jobs accumulate over time
   - Need retention policy (archive/delete old jobs)
   - ~730GB/year at 1M jobs/day

4. **No Built-In Flow Tracking**
   - Cannot track "flow instances" (BullMQ Flows)
   - Would need additional field (see RFC-006)

5. **Limited Cross-Tenant Analytics**
   - Intentionally isolated by tenant
   - Cannot easily compare across tenants
   - Privacy/security by design

---

## Future Extensibility

### **Planned Extensions**

#### **1. BullMQ Flows Support** (RFC-006)

Add optional fields for flow tracking:

```javascript
JobExecution {
  // New fields
  pipelineId?: string,
  pipelineVersion?: number,
  flowJobId?: string
}
```

#### **2. Custom Stage Metrics**

Allow custom stages to track domain-specific metrics:

```javascript
metrics: {
  // Standard metrics
  durationMs: 7000,

  // Custom stage metrics
  customStageMetrics?: {
    sandboxMemoryMB: 128,
    sandboxExecutionTime: 450,
    customFunctionCalls: 42
  }
}
```

#### **3. Pipeline Analytics**

Aggregate job data for pipeline optimization:

- Identify bottlenecks
- Compare pipeline versions
- Track improvement over time

#### **4. Cost Attribution**

Link job costs to customers for billing:

```javascript
JobExecution {
  // New fields
  costBreakdown?: {
    llmCost: 0.012,
    apiCost: 0.001,
    computeCost: 0.005,
    totalCost: 0.018
  }
}
```

### **Extension Guidelines**

1. **Add Optional Fields**
   - Never modify existing required fields
   - Always make new fields optional
   - Maintain backward compatibility

2. **Preserve Flat Schema**
   - Don't introduce parent-child links
   - Keep filtering simple
   - Maintain query performance

3. **Index Thoughtfully**
   - Add indexes for new query patterns
   - Monitor index size
   - Remove unused indexes

4. **Document Changes**
   - Update this RFC for major changes
   - Version schema changes
   - Provide migration guides

---

## References

### **Related RFCs**

- RFC-004: Pluggable Pipeline Architecture
- RFC-006: Job Tracking + BullMQ Flows Integration

### **Related Documentation**

- `docs/Job_Creation_Flow_Diagram.md` - Detailed flow diagrams
- `docs/searchai/INGESTION-PIPELINE-ARCHITECTURE.md` - Pipeline overview
- `docs/searchai/DATABASE-SCHEMA.md` - MongoDB schemas

### **External References**

- [BullMQ Documentation](https://docs.bullmq.io/)
- [MongoDB Schema Design Best Practices](https://www.mongodb.com/docs/manual/core/data-modeling-introduction/)
- [MongoDB Indexing Strategies](https://www.mongodb.com/docs/manual/indexes/)

---

## Changelog

| Date       | Version | Changes                                         | Author        |
| ---------- | ------- | ----------------------------------------------- | ------------- |
| 2026-03-04 | 1.0     | Initial RFC documenting existing implementation | Platform Team |

---

**END OF RFC-005**
