# BullMQ Usage Patterns Analysis

**Task:** Pre-Check #59 - Explore existing BullMQ usage patterns and configuration
**Status:** Complete
**Date:** 2026-03-07

## Executive Summary

SearchAI uses **BullMQ v5.0.0** with 25+ queues for ingestion pipeline orchestration. Current implementation uses **manual job chaining** with no BullMQ Flows. This analysis documents existing patterns for pipeline flow integration design.

**Key Finding:** Current setup has solid fundamentals (job IDs, retry, monitoring) but lacks **BullMQ Flows-specific configuration** (lockDuration per worker, failParentOnFailure, backpressure, streams config).

---

## 1. Package Versions

**Location:** `apps/search-ai/package.json`

```json
{
  "dependencies": {
    "bullmq": "^5.0.0"
  },
  "devDependencies": {
    "@bull-board/api": "6.19.0",
    "@bull-board/express": "6.19.0"
  }
}
```

**Bull Board** for UI monitoring at `/admin/queues`.

---

## 2. Queue Names and Conventions

**Location:** `packages/search-ai-sdk/src/constants.ts`

### Naming Pattern

All queues use `search-{stage}` prefix:

```typescript
// Core pipeline queues
export const QUEUE_INGESTION = 'search-ingestion';
export const QUEUE_EXTRACTION = 'search-extraction';
export const QUEUE_DOCLING_EXTRACTION = 'search-docling-extraction';
export const QUEUE_PAGE_PROCESSING = 'search-page-processing';
export const QUEUE_NOISE_DETECTION = 'search-noise-detection';
export const QUEUE_CANONICAL_MAP = 'search-canonical-map';
export const QUEUE_ENRICHMENT = 'search-enrichment';

// Parallel enrichment stages
export const QUEUE_KNOWLEDGE_GRAPH = 'search-knowledge-graph';
export const QUEUE_MULTIMODAL = 'search-multimodal';
export const QUEUE_QUESTION_SYNTHESIS = 'search-question-synthesis';
export const QUEUE_SCOPE_CLASSIFICATION = 'search-scope-classification';
export const QUEUE_TREE_BUILDING = 'search-tree-building';
export const QUEUE_VISUAL_ENRICHMENT = 'search-visual-enrichment';

// Terminal stage
export const QUEUE_EMBEDDING = 'search-embedding';

// IdP sync queues (Phase 2B)
export const QUEUE_AZUREAD_USER_SYNC = 'search-azuread-user-sync';
export const QUEUE_AZUREAD_GROUP_SYNC = 'search-azuread-group-sync';
export const QUEUE_OKTA_USER_SYNC = 'search-okta-user-sync';
export const QUEUE_OKTA_GROUP_SYNC = 'search-okta-group-sync';
export const QUEUE_GOOGLE_USER_SYNC = 'search-google-user-sync';
export const QUEUE_GOOGLE_GROUP_SYNC = 'search-google-group-sync';
```

**Total:** 25+ queues across ingestion, enrichment, IdP sync.

---

## 3. Redis Connection Pattern

**Location:** `apps/search-ai/src/workers/shared.ts`

```typescript
import { ConnectionOptions } from 'bullmq';

/**
 * Get Redis connection options from environment
 */
export function getRedisConnection(): ConnectionOptions {
  // Prioritize REDIS_URL (connection string)
  if (process.env.REDIS_URL) {
    return {
      host: new URL(process.env.REDIS_URL).hostname,
      port: parseInt(new URL(process.env.REDIS_URL).port || '6379', 10),
      password: process.env.REDIS_PASSWORD,
    };
  }

  // Fallback to REDIS_HOST + REDIS_PORT
  return {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379', 10),
    password: process.env.REDIS_PASSWORD,
  };
}
```

**Pattern:** Singleton connection config reused across all queues/workers.

---

## 4. Queue Factory Pattern

**Location:** `apps/search-ai/src/workers/shared.ts`

```typescript
import { Queue } from 'bullmq';

/**
 * Create a BullMQ queue with shared Redis connection
 */
export function createQueue(name: string): Queue {
  return new Queue(name, { connection: getRedisConnection() });
}
```

**Usage:** Every worker uses `createQueue(QUEUE_NAME)` to create queue instances.

---

## 5. Worker Options Factory

**Location:** `apps/search-ai/src/workers/shared.ts`

```typescript
import { WorkerOptions } from 'bullmq';

/**
 * Build common WorkerOptions for pipeline workers.
 *
 * @param concurrency — max parallel jobs per worker (default 5)
 */
export function createWorkerOptions(concurrency = 5): WorkerOptions {
  return {
    connection: getRedisConnection(),
    concurrency,
    // Auto-remove completed / failed jobs after 24h / 7d to avoid unbounded growth
    removeOnComplete: { age: 86_400 }, // 24 hours
    removeOnFail: { age: 604_800 }, // 7 days
  };
}
```

**Default Configuration:**

- Concurrency: 5 (configurable per worker)
- removeOnComplete: 24 hours
- removeOnFail: 7 days
- **No lockDuration set** (uses BullMQ default 30s)

---

## 6. Worker Concurrency Tuning

**Location:** `apps/search-ai/src/workers/index.ts`

### Concurrency Multipliers

Workers use different concurrency based on workload characteristics:

| Worker Type            | Multiplier | Reason                            |
| ---------------------- | ---------- | --------------------------------- |
| **Heavy I/O**          |            |                                   |
| ingestion              | 0.6x       | I/O-bound (scan sources)          |
| embedding              | 0.6x       | Rate-limited embedding APIs       |
| crawler-ingestion      | 0.6x       | S3 uploads, Readability overhead  |
| visual-enrichment      | 0.6x       | Multimodal API rate limits        |
| **Moderate I/O**       |            |                                   |
| page-processing        | 0.8x       | LLM chunking + noise detection    |
| **LLM-Heavy**          |            |                                   |
| knowledge-graph        | 0.5x       | GraphRAG extraction (slow)        |
| kg-enrichment          | 0.5x       | LLM entity linking                |
| taxonomy-setup         | 1          | LLM validation intensive          |
| **Compute-Heavy**      |            |                                   |
| multimodal             | 0.4x       | Vision model inference            |
| **Default Processing** |            |                                   |
| extraction             | 1.0x       | Fast text extraction              |
| docling-extraction     | 1.0x       | Docling service handles batching  |
| canonical-mapper       | 1.0x       | Text processing                   |
| enrichment             | 1.0x       | Orchestrator (delegates to queues |

| **External APIs** | | |
| schema-sync | 2 | Low volume, API calls |
| IdP workers | 1 | Low volume, API calls |

**Example from index.ts:**

```typescript
export async function startWorkers(concurrency = 5): Promise<void> {
  workers = [
    {
      name: 'ingestion',
      worker: createIngestionWorker(Math.max(Math.floor(concurrency * 0.6), 1)),
    },
    { name: 'extraction', worker: createExtractionWorker(concurrency) },
    {
      name: 'page-processing',
      worker: createPageProcessingWorker(Math.max(Math.floor(concurrency * 0.8), 1)),
    },
    {
      name: 'multimodal',
      worker: createMultiModalWorker(Math.max(Math.floor(concurrency * 0.4), 1)),
    },
    // ... 20+ more workers
  ];
}
```

---

## 7. Job ID Pattern

**Location:** `apps/search-ai/src/workers/job-id-patterns.ts`

### Pattern: `{stage}:{scope}:{timestamp}`

```typescript
/**
 * Standardized job ID generation for deduplication and idempotency.
 * Job IDs prevent duplicate processing when the same job is enqueued multiple times.
 *
 * Pattern: `{stage}:{scope}:{timestamp}`
 * - stage: worker/queue name (e.g., 'taxonomy-setup', 'kg-reclassify')
 * - scope: unique identifier for the work unit (indexId, documentId, etc.)
 * - timestamp: milliseconds since epoch (ensures uniqueness across retries)
 */
```

**Examples:**

```typescript
// Taxonomy setup (one per index)
export function taxonomySetupJobId(indexId: string): string {
  return `taxonomy-setup:${indexId}:${Date.now()}`;
}

// KG enrichment (one per document)
export function kgEnrichmentJobId(indexId: string, documentId: string): string {
  return `kg-enrichment:${indexId}:${documentId}:${Date.now()}`;
}

// Page processing (one per document)
export function pageProcessingJobId(documentId: string, pageNumber: number): string {
  return `page-processing:${documentId}:${pageNumber}:${Date.now()}`;
}

// Embedding (one per chunk)
export function embeddingJobId(chunkId: string): string {
  return `embedding:${chunkId}:${Date.now()}`;
}
```

**Scope Levels:**

- **Index-scoped:** taxonomy-setup, org-profile-gen
- **Document-scoped:** kg-reclassify, page-processing
- **Chunk-scoped:** embedding
- **Tenant-scoped:** custom-domain-gen

---

## 8. Standard Job Options

**Location:** `apps/search-ai/src/workers/job-id-patterns.ts`

```typescript
/**
 * Standard BullMQ job options with retry configuration
 */
export const STANDARD_JOB_OPTIONS = {
  attempts: 3,
  backoff: {
    type: 'exponential' as const,
    delay: 5_000, // 5 seconds initial delay, exponential backoff
  },
  removeOnComplete: {
    age: 86400, // Keep completed jobs for 24 hours
    count: 1000, // Keep last 1000 completed jobs
  },
  removeOnFail: {
    age: 604800, // Keep failed jobs for 7 days
  },
};
```

**Backoff Strategy:**

- 1st retry: 5s delay
- 2nd retry: 5s × 2 = 10s delay
- 3rd retry: 5s × 4 = 20s delay

**Cleanup:**

- Completed jobs: 24h or last 1000
- Failed jobs: 7 days (for debugging)

---

## 9. Retry Patterns Across Workers

### Standard Retry (Most Workers)

```typescript
await queue.add(`process:${documentId}`, jobData, {
  jobId: `process:${indexId}:${documentId}`,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
});
```

**Workers:** ingestion, extraction, docling-extraction, page-processing, canonical-mapper, noise-detection, embedding, question-synthesis

### Heavy LLM Retry (Longer Backoff)

```typescript
await kgQueue.add(`kg:${documentId}`, kgData, {
  jobId: `kg:${documentId}`,
  attempts: 3,
  backoff: { type: 'exponential', delay: 10_000 }, // 10s initial delay
});
```

**Workers:** enrichment (for KG, multimodal, tree-building, question-synthesis, scope-classification sub-jobs)

**Rationale:** LLM jobs may fail due to rate limits or transient API errors. Longer backoff reduces retry storm.

---

## 10. Lock Duration Configuration

**Critical Gap:** Only **one worker** sets custom lockDuration.

### Configured Lock Duration

**crawler-ingestion-worker.ts:**

```typescript
worker = new Worker<CrawlerIngestionJobData>('content-processing', processCrawlerIngestion, {
  ...options,
  // Crawler ingestion can take time (S3 uploads, Readability processing)
  lockDuration: 120000, // 2 min lock (was 60s)
  lockRenewTime: 60000, // Renew every 1 min
});
```

### Missing Lock Duration (Uses BullMQ Default 30s)

**All other workers** use `createWorkerOptions()` without lockDuration override:

```typescript
const worker = new Worker(
  QUEUE_DOCLING_EXTRACTION,
  processDoclingExtractionJob,
  createWorkerOptions(concurrency),
);
```

**BullMQ Default:** 30 seconds

**Problem:** Jobs taking >30s will stall and retry, causing:

- Duplicate processing
- Double LLM charges
- Wasted resources

**Affected Workers:**

| Worker             | Typical Duration | Risk Level  |
| ------------------ | ---------------- | ----------- |
| docling-extraction | 2-10 min         | 🔴 CRITICAL |
| page-processing    | 1-5 min          | 🔴 CRITICAL |
| knowledge-graph    | 3-8 min          | 🔴 CRITICAL |
| tree-building      | 2-5 min          | 🔴 CRITICAL |
| enrichment         | 1-3 min          | ⚠️ HIGH     |
| question-synthesis | 1-3 min          | ⚠️ HIGH     |
| multimodal         | 2-4 min          | ⚠️ HIGH     |

**Recommendation:** Set per-worker lockDuration matching expected job duration + buffer.

---

## 11. Job Chaining Pattern

**Current:** Manual `queue.add()` calls to next stage.

### Example: ingestion-worker.ts

```typescript
// After ingestion completes, enqueue extraction
const extractionQueue = createQueue(QUEUE_EXTRACTION);
await extractionQueue.add(`extract:${doc._id}`, extractionData, {
  jobId: `extract:${indexId}:${doc._id}`,
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
});
await extractionQueue.close(); // Always close after use
```

### Example: enrichment-worker.ts

```typescript
// After enrichment, enqueue 5 parallel stages
const kgQueue = createQueue(QUEUE_KNOWLEDGE_GRAPH);
const multiModalQueue = createQueue(QUEUE_MULTIMODAL);
const treeQueue = createQueue(QUEUE_TREE_BUILDING);
const questionQueue = createQueue(QUEUE_QUESTION_SYNTHESIS);
const scopeQueue = createQueue(QUEUE_SCOPE_CLASSIFICATION);

await Promise.all([
  kgQueue.add(`kg:${documentId}`, kgData, {
    jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
  }),
  multiModalQueue.add(`mm:${documentId}`, mmData, {
    jobId,
    attempts: 3,
    backoff: { type: 'exponential', delay: 10_000 },
  }),
  // ... etc
]);

// Close all queues
await Promise.all([
  kgQueue.close(),
  multiModalQueue.close(),
  treeQueue.close(),
  questionQueue.close(),
  scopeQueue.close(),
]);
```

**Pattern:**

1. Create queue instance
2. Add job(s)
3. Close queue in finally block

**No BullMQ Flows usage** — all dependencies managed manually.

---

## 12. Queue Monitoring System

**Location:** `apps/search-ai/src/workers/queue-monitor.ts`

### Stats Tracked

```typescript
export interface QueueStats {
  queueName: string;
  waiting: number; // Jobs in queue
  active: number; // Jobs being processed
  completed: number; // Jobs finished (kept per retention policy)
  failed: number; // Jobs failed (kept 7 days)
  delayed: number; // Jobs scheduled for future
  total: number;
  timestamp: Date;
}
```

### Health Assessment

```typescript
export interface QueueHealth {
  queueName: string;
  status: 'healthy' | 'degraded' | 'critical';
  waiting: number;
  active: number;
  failed: number;
  issues: string[];
  timestamp: Date;
}
```

**Thresholds:**

- **Critical:**
  - Failure rate >10%
  - Waiting jobs >1000
- **Degraded:**
  - Waiting jobs >100

**Example:**

```typescript
function assessQueueHealth(stats: QueueStats): QueueHealth {
  const issues: string[] = [];
  let status: 'healthy' | 'degraded' | 'critical' = 'healthy';

  // Critical: High failure rate (>10% of total jobs)
  if (stats.failed > 0 && stats.failed / Math.max(stats.total, 1) > 0.1) {
    issues.push(
      `High failure rate: ${stats.failed} failed jobs (${((stats.failed / stats.total) * 100).toFixed(1)}%)`,
    );
    status = 'critical';
  }

  // Critical: Very high backlog (>1000 waiting)
  if (stats.waiting > 1000) {
    issues.push(`Very high backlog: ${stats.waiting} jobs waiting`);
    status = 'critical';
  }
  // Degraded: Moderate backlog (>100 waiting)
  else if (stats.waiting > 100) {
    issues.push(`Moderate backlog: ${stats.waiting} jobs waiting`);
    if (status !== 'critical') status = 'degraded';
  }

  return {
    queueName: stats.queueName,
    status,
    waiting: stats.waiting,
    active: stats.active,
    failed: stats.failed,
    issues,
    timestamp: stats.timestamp,
  };
}
```

### Periodic Monitoring

```typescript
/**
 * Start periodic queue monitoring
 *
 * @param intervalMs - Monitoring interval in milliseconds (default: 60000 = 1 minute)
 * @returns Stop function to cancel monitoring
 */
export function startPeriodicMonitoring(intervalMs: number = 60000): () => void {
  const intervalId = setInterval(() => {
    monitorQueues().catch((error) => {
      console.error('[queue-monitor] Periodic monitoring failed:', error);
    });
  }, intervalMs);

  return () => {
    clearInterval(intervalId);
  };
}
```

**Default:** Monitor every 60 seconds.

---

## 13. Graceful Shutdown Pattern

**Location:** `apps/search-ai/src/workers/index.ts`

```typescript
/**
 * Gracefully close all workers and their Redis connections.
 * Waits for currently-running jobs to finish before closing.
 */
export async function stopWorkers(): Promise<void> {
  console.log('[workers] Stopping all pipeline workers...');

  // Close all workers in parallel
  await Promise.allSettled(
    workers.map(async ({ name, worker }) => {
      try {
        await worker.close();
        console.log(`[workers] ${name} worker stopped`);
      } catch (error) {
        console.error(
          `[workers] Error stopping ${name} worker:`,
          error instanceof Error ? error.message : String(error),
        );
      }
    }),
  );

  // Close embedding provider singletons
  await closeEmbeddingProviders();

  workers = [];
  console.log('[workers] All pipeline workers stopped');
}
```

**Pattern:**

- `Promise.allSettled()` ensures all workers attempt shutdown (no fail-fast)
- Close external providers (embedding, vector store)
- Clear workers array

**Note:** Current implementation does NOT account for BullMQ Flows parent jobs waiting for children.

---

## 14. Job Data Interfaces

**Location:** `apps/search-ai/src/workers/shared.ts`

**20+ typed interfaces** for job data:

```typescript
export interface IngestionJobData {
  indexId: string;
  sourceId: string;
  tenantId: string;
  force?: boolean;
}

export interface ExtractionJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
}

export interface DoclingExtractionJobData {
  indexId: string;
  documentId: string;
  sourceUrl: string; // S3 URL or HTTP URL
  tenantId: string;
}

export interface PageProcessingJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
  pageIds: string[];
  previousPageSummary: string | null;
}

export interface EmbeddingJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
}

export interface KnowledgeGraphJobData {
  indexId: string;
  documentId: string;
  tenantId: string;
}

// ... 15+ more interfaces
```

**Pattern:**

- All jobs include `tenantId` (tenant isolation)
- Most include `indexId` + `documentId` (scope)
- Stage-specific fields (e.g., `sourceUrl`, `pageIds`, `previousPageSummary`)

---

## 15. Worker Event Handlers

**Standard Pattern:**

```typescript
worker.on('completed', (job) =>
  workerLog('worker-name', `Job ${job.id} completed`, { documentId: job.data.documentId }),
);

worker.on('failed', (job, err) => workerError('worker-name', `Job ${job?.id} failed`, err));

worker.on('error', (error) => workerError('worker-name', 'Worker error', error));
```

**Logging Utilities:**

```typescript
// shared.ts
export function workerLog(
  workerName: string,
  message: string,
  metadata?: Record<string, any>,
): void {
  console.log(`[${workerName}] ${message}`, metadata || '');
}

export function workerError(workerName: string, message: string, error: unknown): void {
  console.error(
    `[${workerName}] ${message}`,
    error instanceof Error ? error.message : String(error),
  );
}
```

**No structured logging** — uses console.log/error.

---

## 16. Status Tracking

**Location:** `apps/search-ai/src/workers/status-logger.ts`

Workers emit lifecycle events for job tracking:

```typescript
export function logJobPickup(event: {
  worker: string;
  jobId: string;
  documentId: string;
  queueName: string;
  timestamp: Date;
}): void;

export function logStatusTransition(event: {
  documentId: string;
  indexId: string;
  tenantId: string;
  fromStatus: string;
  toStatus: string;
  worker: string;
  timestamp: Date;
  metadata?: Record<string, any>;
}): void;

export function logJobCompletion(event: {
  worker: string;
  jobId: string;
  documentId: string;
  status: 'completed' | 'failed';
  durationMs: number;
  timestamp: Date;
  error?: string;
}): void;

export function logQueueEnqueue(event: {
  targetQueue: string;
  jobId: string;
  documentId: string;
  worker: string;
  timestamp: Date;
}): void;
```

**Usage:**

```typescript
// docling-extraction-worker.ts
logJobPickup({
  worker: 'docling-extraction',
  jobId: job.id || 'unknown',
  documentId,
  queueName: QUEUE_DOCLING_EXTRACTION,
  timestamp: new Date(),
});

logStatusTransition({
  documentId,
  indexId,
  tenantId,
  fromStatus: DocumentStatus.EXTRACTING,
  toStatus: DocumentStatus.EXTRACTED,
  worker: 'docling-extraction',
  timestamp: new Date(),
  metadata: { pageCount: extractionResult.metadata.pageCount },
});
```

**Current Implementation:** Just console logging. Could be integrated with JobExecution tracking system from RFC-005.

---

## 17. Job Enqueueing Helper

**Location:** `apps/search-ai/src/workers/job-id-patterns.ts`

````typescript
/**
 * Helper to enqueue a job with standardized options
 *
 * @example
 * ```typescript
 * await enqueueJob(
 *   queue,
 *   'Process document',
 *   { documentId: '123', tenantId: 'abc' },
 *   kgReclassifyJobId('index-1', 'doc-123')
 * );
 * ```
 */
export async function enqueueJob<T>(
  queue: any, // BullMQ Queue instance
  jobName: string,
  jobData: T,
  jobId: string,
  customOptions: Record<string, any> = {},
): Promise<void> {
  try {
    await queue.add(jobName, jobData, {
      jobId,
      ...STANDARD_JOB_OPTIONS,
      ...customOptions,
    });
  } finally {
    // Always close queue connection in finally block
    await queue.close();
  }
}
````

**Pattern:** Auto-merge standard options, always close queue in finally.

---

## 18. Pipeline Flow (No BullMQ Flows)

**Current Sequential Stages:**

```
ingestion → extraction/docling-extraction → page-processing → canonical-map → enrichment
                                                                                  ↓
                            ┌─────────────────────────────────────────────────────┴──────────────────────────┐
                            │                                                                                 │
                    knowledge-graph    multimodal    tree-building    question-synthesis    scope-classification
                            │                │               │                    │                          │
                            └────────────────┴───────────────┴────────────────────┴──────────────────────────┤
                                                                                                              │
                                                                                                          embedding
```

**Parallel Stages After Enrichment:**

- knowledge-graph (GraphRAG entity extraction)
- multimodal (vision model inference)
- tree-building (hierarchical structure)
- question-synthesis (QA pairs)
- scope-classification (topic labeling)

**All queue to embedding** (terminal stage).

**No Flows:** Each worker manually enqueues next stage(s).

---

## 19. Gaps for BullMQ Flows Integration

Based on RFC-004 and BullMQ Flows requirements:

### ✅ Already Good

1. **Job ID patterns** — Stable, idempotent IDs
2. **Retry configuration** — Standard 3 attempts with exponential backoff
3. **Queue monitoring** — Health checks, stats, thresholds
4. **Graceful shutdown** — Promise.allSettled pattern
5. **Job data types** — 20+ typed interfaces
6. **Redis connection** — Singleton pattern

### 🔴 Critical Gaps

1. **No per-worker lockDuration** (only crawler-ingestion sets 2 min)
   - Risk: Docling, KG, tree-building jobs >30s will stall
   - Fix: Set lockDuration per worker based on expected duration
2. **No backpressure mechanism**
   - Risk: Queue depth can grow unbounded → Redis OOM
   - Fix: Application-level queue depth checks before adding flows
3. **No failParentOnFailure configuration**
   - Risk: Parent flow jobs wait forever if child fails
   - Fix: Set `failParentOnFailure: true` on ALL flow child jobs
4. **No FlowProducer usage**
   - Current: Manual job chaining
   - Fix: Use FlowProducer for conditional routing
5. **No flow-level deduplication**
   - Current: Job-level jobId deduplication
   - Fix: MongoDB-based deduplication via `contentHash` (per RFC-004)

### ⚠️ Important Gaps

1. **No streams.events.maxLen on queues**
   - Risk: 20+ queues accumulate events → memory growth
   - Fix: Set maxLen on queue creation
2. **No lockRenewTime configuration**
   - Only crawler-ingestion sets 60s
   - Fix: Set lockRenewTime = lockDuration / 2 for all long jobs
3. **No circuit breaker for flows**
   - Risk: Flow failures cascade with no fallback to legacy
   - Fix: Implement flow circuit breaker per RFC-004
4. **Graceful shutdown doesn't account for flow parents**
   - Risk: Parent jobs orphaned if worker shuts down mid-flow
   - Fix: Check for active flow parents before shutdown

### ℹ️ Nice to Have

1. **Structured logging** (currently console.log/error)
2. **Job Execution tracking integration** (from RFC-005)
3. **Per-tenant queue depth limits** (fairness)
4. **Job priority configuration** (high-priority indexes)

---

## 20. Recommended Per-Worker Lock Duration

Based on typical job duration analysis:

| Worker               | lockDuration | lockRenewTime | stalledInterval | Reasoning                                |
| -------------------- | ------------ | ------------- | --------------- | ---------------------------------------- |
| docling-extraction   | 10 min       | 5 min         | 5 min           | Large PDFs take 2-10 min                 |
| page-processing      | 5 min        | 2.5 min       | 2.5 min         | LLM chunking + noise detection 1-5 min   |
| knowledge-graph      | 5 min        | 2.5 min       | 2.5 min         | GraphRAG extraction 3-8 min              |
| tree-building        | 5 min        | 2.5 min       | 2.5 min         | Hierarchical parsing 2-5 min             |
| enrichment           | 2 min        | 1 min         | 1 min           | Orchestrator (delegates to sub-queues)   |
| multimodal           | 3 min        | 1.5 min       | 1.5 min         | Vision model inference 2-4 min           |
| question-synthesis   | 2 min        | 1 min         | 1 min           | LLM QA generation 1-3 min                |
| embedding            | 2 min        | 1 min         | 1 min           | Batch embedding API calls                |
| ingestion            | 1 min        | 30s           | 30s             | Fast scanning (I/O)                      |
| extraction           | 1 min        | 30s           | 30s             | Fast text extraction                     |
| canonical-mapper     | 1 min        | 30s           | 30s             | Text processing                          |
| noise-detection      | 1 min        | 30s           | 30s             | Heuristic-based                          |
| scope-classification | 1 min        | 30s           | 30s             | Fast LLM call                            |
| visual-enrichment    | 2 min        | 1 min         | 1 min           | Multimodal API                           |
| crawler-ingestion    | 2 min        | 1 min         | 1 min           | Already configured (S3 + Readability)    |
| kg-enrichment        | 2 min        | 1 min         | 1 min           | LLM entity linking                       |
| taxonomy-setup       | 5 min        | 2.5 min       | 2.5 min         | LLM validation intensive (one at a time) |
| schema-sync          | 1 min        | 30s           | 30s             | External API calls                       |
| IdP workers          | 1 min        | 30s           | 30s             | External API calls                       |
| connector-discovery  | 1 min        | 30s           | 30s             | API discovery                            |
| connector-sync       | 2 min        | 1 min         | 1 min           | Document batch processing                |
| structured-data      | 1 min        | 30s           | 30s             | CSV/JSON parsing                         |

**Formula:**

- lockDuration = expected max duration × 1.5 (buffer)
- lockRenewTime = lockDuration / 2
- stalledInterval = lockRenewTime (check for stalled jobs at renewal interval)

---

## 21. Example Worker Configurations

### Short-Duration Worker (extraction)

```typescript
const worker = new Worker(
  QUEUE_EXTRACTION,
  processExtractionJob,
  createWorkerOptions(concurrency), // Default 30s lockDuration OK
);
```

### Long-Duration Worker (docling-extraction) — NEEDS FIX

**Current (WRONG):**

```typescript
const worker = new Worker(
  QUEUE_DOCLING_EXTRACTION,
  processDoclingExtractionJob,
  createWorkerOptions(concurrency), // Uses default 30s — TOO SHORT
);
```

**Fixed:**

```typescript
const worker = new Worker(QUEUE_DOCLING_EXTRACTION, processDoclingExtractionJob, {
  ...createWorkerOptions(concurrency),
  lockDuration: 600000, // 10 min
  lockRenewTime: 300000, // 5 min
  settings: {
    stalledInterval: 300000, // 5 min
  },
});
```

---

## 22. BullMQ Flows Integration Checklist

For pipeline flow implementation (Task #42):

- [ ] **Create FlowProducer instance** (singleton, shared Redis connection)
- [ ] **Set per-worker lockDuration** (see table in §20)
- [ ] **Add backpressure checks** (queue depth thresholds before adding flows)
- [ ] **Configure failParentOnFailure: true** on all flow child jobs
- [ ] **Set removeOnComplete/removeOnFail on children** (not just parent)
- [ ] **Configure streams.events.maxLen** on queue creation
- [ ] **Implement flow deduplication** (MongoDB contentHash, per RFC-004)
- [ ] **Build circuit breaker** (flow → legacy fallback, per RFC-004)
- [ ] **Update graceful shutdown** (check for active flow parents)
- [ ] **Add FlowProducer.add() validation wrapper** (BullMQ #3851 silent failure workaround)
- [ ] **Set Kubernetes terminationGracePeriodSeconds >= 180s** (long jobs)
- [ ] **Test with BullMQ v5.0.0** (flows support added in v4.0.0, stable in v5.0.0)

---

## 23. Integration with RFC-005 Job Tracking

**Current Status:** Workers emit status events via `status-logger.ts` (console logging only).

**Recommended Integration:**

```typescript
import { instrumentBullMQWorker } from '@agent-platform/search-ai-internal/job-tracking';

// Wrap worker with instrumentation
const worker = instrumentBullMQWorker(
  new Worker(QUEUE_DOCLING_EXTRACTION, processDoclingExtractionJob, {
    ...createWorkerOptions(concurrency),
    lockDuration: 600000,
  }),
  { workerStage: 'docling-extraction' },
);
```

**Benefits:**

- Automatic JobExecution record creation/updates
- Metrics collection (duration, status transitions)
- Error capture with full stack traces
- Trace ID propagation

**See:** `docs/searchai/rfcs/RFC-006-Job-Tracking-BullMQ-Flows-Integration.md`

---

## 24. Backpressure Strategy

**Problem:** BullMQ has NO built-in queue depth limit. Queue can grow unbounded.

**Solution:** Application-level backpressure before adding flows.

```typescript
/**
 * Check if queue can accept new work
 */
async function canEnqueueFlow(queueName: string, maxDepth = 1000): Promise<boolean> {
  const queue = createQueue(queueName);
  try {
    const waiting = await queue.getWaitingCount();
    return waiting < maxDepth;
  } finally {
    await queue.close();
  }
}

// Before adding flow
if (!(await canEnqueueFlow(QUEUE_DOCLING_EXTRACTION, 500))) {
  throw new Error('Queue at capacity, try again later');
}

await flowProducer.add({
  name: 'document-ingestion-flow',
  queueName: QUEUE_INGESTION,
  data: ingestionData,
  children: [
    /* ... */
  ],
});
```

**Thresholds:**

- Ingestion queue: 1000 max
- Extraction/processing queues: 500 max
- Enrichment queues: 300 max (LLM rate limits)

---

## 25. Bull Board Configuration

**Location:** `apps/search-ai/src/server.ts` (not shown, but referenced)

Bull Board provides UI monitoring at `/admin/queues`:

- Real-time queue stats (waiting, active, failed)
- Job details (data, logs, stack traces)
- Retry failed jobs
- Clean completed jobs

**Setup:**

```typescript
import { createBullBoard } from '@bull-board/api';
import { BullMQAdapter } from '@bull-board/api/bullMQAdapter.js';
import { ExpressAdapter } from '@bull-board/express';

const serverAdapter = new ExpressAdapter();
createBullBoard({
  queues: [
    new BullMQAdapter(createQueue(QUEUE_INGESTION)),
    new BullMQAdapter(createQueue(QUEUE_EXTRACTION)),
    // ... 25+ queues
  ],
  serverAdapter,
});

app.use('/admin/queues', serverAdapter.getRouter());
```

---

## Conclusion

**Key Takeaways:**

1. ✅ **Solid Foundations:** Job IDs, retry, monitoring, graceful shutdown
2. 🔴 **Critical Gaps:** Per-worker lockDuration, backpressure, failParentOnFailure, FlowProducer
3. 📋 **Ready for Flows:** Architecture supports flows, just needs configuration updates

**Next Steps:**

1. **Task #42 (BullMQ Flows Integration):** Implement FlowProducer with conditional routing
2. **Task #44 (Circuit Breaker):** Flow → legacy fallback on failures
3. **Task #43 (Validation):** Pre-flight checks before flow execution

**Key Design Decisions for Task #42:**

- Use `FlowProducer` for all pipeline flows
- Set per-worker `lockDuration` from table in §20
- Implement backpressure checks (§24)
- Flow deduplication via MongoDB `contentHash`
- Circuit breaker for graceful degradation

---

**Analysis complete.** Ready for BullMQ Flows integration design.
