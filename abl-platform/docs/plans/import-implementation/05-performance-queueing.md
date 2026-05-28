# Section 5: Performance, Queueing, Rate Limits & Observability

**Scope:** Async import job design, progress tracking, memory management, rate limiting, timeouts, observability, circuit breakers, and cleanup for the v2 import pipeline.

**Context:** v2 imports handle 8 layers (connections, core, search, workflows, guardrails, evals, channels, vocabulary) compared to v1's agents-only model. A large project may contain hundreds of entities across all layers, with import payloads exceeding 50MB. The existing v1 import is synchronous within a single HTTP request-response cycle (`apps/runtime/src/routes/project-io.ts`). v2 must be asynchronous with progress tracking, leveraging the platform's existing BullMQ infrastructure.

**Key Codebase References:**

- Current sync import flow: `apps/runtime/src/routes/project-io.ts`
- StagedImporter (phase model): `packages/project-io/src/import/staged-importer.ts`
- Import types (ImportOperationState, ImportPhase, LayerName): `packages/project-io/src/types.ts`
- BullMQ connection helpers: `packages/redis/src/bullmq.ts`
- Shared worker utilities: `apps/search-ai/src/workers/shared.ts`
- Circuit breaker: `packages/circuit-breaker/src/redis-circuit-breaker.ts`
- Distributed lock: `packages/shared-observability/src/distributed-lock.ts`
- Progress WebSocket (existing pattern): `apps/search-ai/src/routes/progress.ts`
- TraceStore: `apps/runtime/src/services/trace-store.ts`

---

## 1. Async Import Job Design (BullMQ)

### 1.1 Queue Name & Job Type

```
Queue name:  import-v2
Job name:    import-v2-execute
```

One queue handles all v2 imports. Jobs are differentiated by their data payload. This follows the existing convention in SearchAI (`connector-sync`, `page-processing`, etc.), where each functional domain gets a single queue.

### 1.2 Job Data Schema

```typescript
/**
 * Job data stored in Redis by BullMQ.
 *
 * CRITICAL: No file content in the job payload. Files are stored in MongoDB
 * (ImportFileStore collection) and referenced by operationId. Redis job
 * payloads have a practical limit of ~512KB before performance degrades.
 */
export interface ImportV2JobData {
  /** Import operation ID (MongoDB _id of ImportOperationState) */
  operationId: string;
  /** Target project */
  projectId: string;
  /** Tenant scope — every query must include this */
  tenantId: string;
  /** User who initiated the import */
  userId: string;
  /** Layers requested for import */
  layers: LayerName[];
  /** Total entity count across all layers (for progress calculation) */
  totalEntityCount: number;
  /** Timestamp when the job was enqueued */
  enqueuedAt: string; // ISO 8601
  /** Import priority */
  priority: 'normal' | 'scheduled';
  /** Source: how the import was triggered */
  source: 'api' | 'git_sync' | 'cli' | 'studio';
}
```

### 1.3 File Storage Strategy

> **[R1 Fix: PERF-4]** Redesigned from single BSON document to GridFS-based storage.
> The original design stored up to 50MB (compressed) in a single BSON document, but
> MongoDB's maximum BSON document size is 16MB. DSL content and complex JSON with
> unique field values compress at 3-4x (not the originally estimated 5-10x), meaning
> a 50MB payload would compress to 12-17MB, exceeding the limit. GridFS automatically
> chunks data into 255KB segments and is already supported by Mongoose.

Files are stored in MongoDB via GridFS rather than in the Redis job payload or on disk.

```typescript
import { createReadStream } from 'fs';
import { GridFSBucket, ObjectId } from 'mongodb';

/**
 * Temporary file storage for import payloads using GridFS.
 *
 * Stored in MongoDB because:
 * 1. Redis job payloads should stay small (< 512KB) — a 50MB import would
 *    bloat the Redis dataset and slow BullMQ job fetching.
 * 2. Disk storage requires shared volumes in k8s (PVC) — operational overhead.
 * 3. MongoDB already handles replication, TTL indexes, and tenant isolation.
 *
 * Uses GridFS instead of a single BSON document because:
 * - MongoDB BSON document size limit is 16MB
 * - A 50MB import at 3-4x compression = 12-17MB, which exceeds the limit
 * - GridFS auto-chunks into 255KB segments, supporting any payload size
 * - GridFS is built into the MongoDB driver and supported by Mongoose
 *
 * GridFS bucket name: 'importFiles'
 * Files are stored as: {operationId}.gz
 * Metadata includes: operationId, projectId, tenantId, originalSizeBytes, expiresAt
 */
const IMPORT_FILES_BUCKET = 'importFiles';

interface ImportFileStoreMetadata {
  operationId: string;
  projectId: string;
  tenantId: string;
  /** Original uncompressed size in bytes (for metrics & validation) */
  originalSizeBytes: number;
  /** Compressed size in bytes (for compression ratio metrics) */
  compressedSizeBytes: number;
  /** Automatic cleanup after 2 hours (covers job timeout + buffer) */
  expiresAt: Date;
}

/**
 * Store compressed import files in GridFS.
 */
async function storeImportFiles(
  db: Db,
  operationId: string,
  projectId: string,
  tenantId: string,
  compressedBuffer: Buffer,
  originalSizeBytes: number,
): Promise<ObjectId> {
  const bucket = new GridFSBucket(db, { bucketName: IMPORT_FILES_BUCKET });
  const metadata: ImportFileStoreMetadata = {
    operationId,
    projectId,
    tenantId,
    originalSizeBytes,
    compressedSizeBytes: compressedBuffer.length,
    expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000), // 2 hours
  };

  return new Promise((resolve, reject) => {
    const uploadStream = bucket.openUploadStream(`${operationId}.gz`, { metadata });
    uploadStream.on('finish', () => resolve(uploadStream.id as ObjectId));
    uploadStream.on('error', reject);
    uploadStream.end(compressedBuffer);
  });
}

/**
 * Load and decompress import files from GridFS.
 *
 * [R2 Fix: R2-GRIDFS-1] Accepts operationId AND tenantId. Verifies
 * metadata.tenantId matches before returning data. This is defense-in-depth:
 * the worker receives tenantId from job data, but the function itself enforces
 * the scope to prevent future callers from loading cross-tenant files.
 */
async function loadImportFiles(db: Db, operationId: string, tenantId: string): Promise<Buffer> {
  const bucket = new GridFSBucket(db, { bucketName: IMPORT_FILES_BUCKET });

  // Scope query by both filename and tenantId in metadata
  const files = await bucket
    .find({
      filename: `${operationId}.gz`,
      'metadata.tenantId': tenantId,
    })
    .toArray();

  if (files.length === 0) {
    throw new Error(`Import files not found for operation ${operationId}`);
  }

  const chunks: Buffer[] = [];
  return new Promise((resolve, reject) => {
    const downloadStream = bucket.openDownloadStream(files[0]._id);
    downloadStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    downloadStream.on('end', () => resolve(Buffer.concat(chunks)));
    downloadStream.on('error', reject);
  });
}

/**
 * Delete import files from GridFS after import completion.
 *
 * [R3 Fix] R3-GRIDFS-DELETE: Added tenantId parameter for defense-in-depth
 * tenant scoping, consistent with the loadImportFiles signature. Prevents a
 * future caller from deleting another tenant's import files if they know the
 * operationId.
 */
async function deleteImportFiles(db: Db, operationId: string, tenantId: string): Promise<void> {
  const bucket = new GridFSBucket(db, { bucketName: IMPORT_FILES_BUCKET });
  const cursor = bucket.find({
    filename: `${operationId}.gz`,
    'metadata.tenantId': tenantId,
  });
  for await (const file of cursor) {
    await bucket.delete(file._id);
  }
}
```

Cleanup relies on the scheduled cleanup job (Section 8.2) which queries GridFS metadata
for expired files. MongoDB TTL indexes do not apply to GridFS directly, so the cleanup
job must handle expiration.

> **[R2 Fix: GridFS index]** Create an index on the `importFiles.files` collection's
> `metadata.expiresAt` field for efficient cleanup queries. Without this index, the
> `bucket.find({ 'metadata.expiresAt': { $lt: new Date() } })` query scans all GridFS
> file documents, which degrades with thousands of imports over time. This is a one-time
> migration step:
>
> ```
> db.collection('importFiles.files').createIndex({ 'metadata.expiresAt': 1 })
> ```

```typescript
// In the cleanup job (Section 8.2):
const bucket = new GridFSBucket(db, { bucketName: IMPORT_FILES_BUCKET });
const expiredFiles = bucket.find({
  'metadata.expiresAt': { $lt: new Date() },
});
for await (const file of expiredFiles) {
  await bucket.delete(file._id);
}
```

### 1.4 Job Flow

The job executes the existing `StagedImporter` phases, adapted for async execution:

```
API Request (POST /import/v2)
  |
  v
[1. Validate payload synchronously (fast — ~100ms)]
  |--- Reject invalid: 400 response immediately
  |
  v
[2. Store files in GridFS (importFiles bucket)]
  |
  v
[3. Create ImportOperationState (status: 'queued')]
  |
  v
[4. Enqueue BullMQ job]
  |
  v
[5. Return 202 Accepted with operationId]
  |
  v
  ======================= async boundary =======================
  |
  v
[Worker picks up job]
  |
  v
[6. Load files from GridFS, decompress]
  |
  v
[7. Phase 1: Validate — parse manifests, check dependencies]
  |--- Fail: mark ImportOperationState as 'failed', publish event
  |
  v
[8. Phase 2: Stage — StagedImporter.stage() per layer]
  |--- Fail: clean up staged records, mark 'failed'
  |
  v
[9. Phase 3: Activate — StagedImporter.activate() per layer in dependency order]
  |--- Fail: StagedImporter.rollback(), mark 'failed'
  |
  v
[10. Phase 4: Cleanup — delete superseded records (fire-and-forget)]
  |
  v
[11. Mark ImportOperationState as 'completed', delete GridFS import files]
  |
  v
[12. Publish completion event via Redis pub/sub]
```

### 1.5 Worker Concurrency Design

```typescript
/**
 * Worker configuration for import-v2.
 *
 * Concurrency model:
 * - Global worker concurrency: 3 (configurable via IMPORT_V2_WORKER_CONCURRENCY)
 *   This means up to 3 imports process simultaneously per pod.
 * - Per-project lock: Only 1 import per project at a time (Redis distributed lock).
 * - Per-tenant limit: Max 2 concurrent imports per tenant (checked at enqueue time).
 *
 * Why concurrency=3 and not 1:
 *   Different tenants/projects can safely import in parallel. The per-project
 *   lock prevents conflicts within a project. concurrency=1 would serialize
 *   all imports globally, creating unnecessary head-of-line blocking.
 */
const IMPORT_V2_WORKER_CONCURRENCY = parseInt(process.env.IMPORT_V2_WORKER_CONCURRENCY ?? '3', 10);
```

### 1.6 Worker Implementation Skeleton

```typescript
// packages/project-io/src/import/import-v2-worker.ts

import { Worker, Queue } from 'bullmq';
import type { Job } from 'bullmq';
import { createBullMQConnectionPair, defaultWorkerOptions } from '@agent-platform/redis/bullmq';
import { DistributedLockManager } from '@agent-platform/shared-observability';
import { RedisCircuitBreaker } from '@agent-platform/circuit-breaker';
import { createLogger } from '@abl/compiler/platform';
import type { ImportV2JobData } from './types.js';

const log = createLogger('import-v2-worker');

const QUEUE_NAME = 'import-v2';

export function createImportV2Worker(redis: Redis): {
  worker: Worker<ImportV2JobData>;
  queue: Queue<ImportV2JobData>;
  shutdown: () => Promise<void>;
} {
  const pair = createBullMQConnectionPair(redis);
  const lockManager = new DistributedLockManager(redis);
  const dbBreaker = new RedisCircuitBreaker(redis, 'app', {
    failureThreshold: 10,
    resetTimeout: 30_000,
    monitorWindow: 60_000,
  });

  const queue = new Queue<ImportV2JobData>(QUEUE_NAME, {
    connection: pair.queueConnection,
  });

  const worker = new Worker<ImportV2JobData>(
    QUEUE_NAME,
    async (job: Job<ImportV2JobData>) => {
      const { operationId, projectId, tenantId, userId, layers } = job.data;

      const jobLog = log.child({ operationId, projectId, tenantId, jobId: job.id });
      jobLog.info('Import job started', { layers, source: job.data.source });

      // 1. Acquire per-project lock
      // [R1 Fix: OPS-2] Lock TTL set to 15 minutes (1.5x job timeout of 10 min).
      // Previously TTL matched job timeout (both 10min), allowing a race condition:
      // lock expires at the same time the job is killed, permitting another import
      // to start before the dying job fully terminates.
      const lock = await lockManager.acquire(projectId, {
        keyPrefix: 'import-v2-lock',
        ttlMs: 900_000, // 15 minutes (1.5x job timeout)
        retryAttempts: 0, // Fail fast — job goes to DLQ
      });

      if (!lock) {
        throw new Error(`Project ${projectId} already has an import in progress`);
      }

      try {
        // 2. Load files from GridFS (via circuit breaker)
        // [R1 Fix: PERF-4] Files stored in GridFS instead of single BSON document
        // [R3 Fix] R3-GRIDFS-CALLSITE: Pass tenantId to match updated 3-arg signature
        const files = await dbBreaker.execute(`import-files:${tenantId}`, () =>
          loadImportFiles(db, operationId, tenantId),
        );

        // 3. Validate
        await updateOperationPhase(operationId, projectId, tenantId, 'validating');
        await publishProgress(operationId, 'validating', 0);
        const validationResult = await validateImportV2(files, layers);

        if (!validationResult.valid) {
          await updateOperationFailed(operationId, projectId, tenantId, {
            phase: 'validating',
            layer: 'all',
            message: validationResult.errors.join('; '),
          });
          await publishProgress(operationId, 'failed', 0);
          return;
        }

        // 4. Stage (per-layer, sequential)
        await updateOperationPhase(operationId, projectId, tenantId, 'staging');
        const stagedImporter = new StagedImporter(dbAdapter);
        // ... delegate to StagedImporter.execute() with progress callbacks

        // [R3 Fix] R3-WORKER-FLOW-GAP: Phase 2.5 — Cross-reference resolution
        // Runs after all layers are staged but before activation. Resolves stale
        // ObjectId references (indexId, channelConnectionId, workflowId, etc.)
        // to newly staged record IDs using the two-pass algorithm from Section 3.12.
        // Also runs the pre-activation safety-net to strip any residual data._
        // prefixed temp fields (R2 Fix: R2-CROSSREF-2).
        await updateOperationPhase(operationId, projectId, tenantId, 'resolving_refs');
        await publishProgress(operationId, 'resolving_refs', 62);
        await resolveCrossReferences(dbAdapter, stagedImporter.getStagedRecordIds());
        await stripResidualTempFields(dbAdapter, stagedImporter.getStagedRecordIds());

        // 5. Activate — flip staged records to 'active'
        await updateOperationPhase(operationId, projectId, tenantId, 'activating');
        // ... delegate to StagedImporter.activate()

        // 6. On success
        await updateOperationPhase(operationId, projectId, tenantId, 'completed');
        await publishProgress(operationId, 'completed', 100);
        await cleanupImportFiles(operationId);

        jobLog.info('Import job completed', {
          layers,
          durationMs: Date.now() - new Date(job.data.enqueuedAt).getTime(),
        });
      } catch (err) {
        jobLog.error('Import job failed', {
          error: err instanceof Error ? err.message : String(err),
        });
        await updateOperationFailed(operationId, projectId, tenantId, {
          phase: 'unknown',
          layer: 'unknown',
          message: err instanceof Error ? err.message : String(err),
        });
        await publishProgress(operationId, 'failed', 0);
        throw err; // Re-throw for BullMQ retry logic
      } finally {
        await lockManager.release(lock);
      }
    },
    {
      connection: pair.workerConnection,
      ...defaultWorkerOptions(IMPORT_V2_WORKER_CONCURRENCY),
      // Override removeOnComplete/removeOnFail for import jobs
      removeOnComplete: { age: 86_400 }, // 24 hours
      removeOnFail: { age: 604_800 }, // 7 days (for debugging)
    },
  );

  return {
    worker,
    queue,
    async shutdown() {
      await worker.close();
      await queue.close();
      pair.disconnect();
    },
  };
}
```

### 1.7 Job Priority

```typescript
// Normal imports get default priority (0)
// Scheduled imports (from git sync, cron) get lower priority (10)
// Higher number = lower priority in BullMQ

// [R1 Fix: OPS-1] attempts: 1 — no automatic retry. Failed jobs go to DLQ.
await queue.add('import-v2-execute', jobData, {
  priority: jobData.priority === 'scheduled' ? 10 : 0,
  attempts: 1,
  removeOnComplete: { age: 86_400 },
  removeOnFail: { age: 604_800 },
});
```

---

## 2. Progress Tracking

### 2.1 ImportOperationState (MongoDB)

The existing `ImportOperationState` type from `packages/project-io/src/types.ts` is extended for v2:

```typescript
export interface ImportOperationStateV2 {
  _id: ObjectId;
  projectId: string;
  tenantId: string;
  userId: string;

  /** Current phase of the import */
  status: ImportPhaseV2;

  /** Per-layer status tracking */
  layers: Record<
    string,
    {
      status: LayerImportStatus;
      entityCount: number;
      processedCount: number;
      startedAt?: Date;
      completedAt?: Date;
      error?: string;
    }
  >;

  /** Overall progress (0-100) */
  progressPercent: number;

  /** BullMQ job ID (for correlation) */
  jobId: string | null;

  /** Staged record IDs (for rollback tracking) */
  stagedRecordIds: Record<string, string[]>;
  supersededRecordIds: Record<string, string[]>;

  /** Error details if failed */
  error?: { phase: string; layer: string; message: string };

  /** Source metadata */
  source: 'api' | 'git_sync' | 'cli' | 'studio';
  totalEntityCount: number;
  totalFileSize: number;

  /** Timing */
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  /** TTL: auto-expire after 1 hour */
  expiresAt: Date;
}

export type ImportPhaseV2 =
  | 'queued'
  | 'validating'
  | 'staging'
  | 'activating'
  | 'completed'
  | 'failed'
  | 'rolling_back'
  | 'cancelled';
```

### 2.2 Real-Time Updates via Redis Pub/Sub

Following the existing pattern from `apps/search-ai/src/routes/progress.ts`:

```typescript
/**
 * Redis pub/sub channel for import progress events.
 *
 * Channel naming: import:progress:{operationId}
 *
 * This allows subscribers to listen to a specific import operation.
 * The Runtime WebSocket handler subscribes on behalf of connected clients.
 */
const IMPORT_PROGRESS_CHANNEL_PREFIX = 'import:progress:';

export interface ImportProgressEvent {
  operationId: string;
  projectId: string;
  tenantId: string;
  phase: ImportPhaseV2;
  progressPercent: number;
  currentLayer: string | null;
  layerStatuses: Record<
    string,
    {
      status: LayerImportStatus;
      processedCount: number;
      entityCount: number;
    }
  >;
  error?: { phase: string; layer: string; message: string };
  timestamp: string; // ISO 8601
}

async function publishProgress(
  redis: Redis,
  operationId: string,
  event: ImportProgressEvent,
): Promise<void> {
  const channel = `${IMPORT_PROGRESS_CHANNEL_PREFIX}${operationId}`;
  await redis.publish(channel, JSON.stringify(event));
}
```

### 2.3 Progress Percentage Calculation

Progress is weighted by entity count per layer, not by layer count. A layer with 500 vocabulary entries should contribute more to the progress bar than a layer with 2 channels.

```typescript
/**
 * Calculate overall progress percentage.
 *
 * Weights:
 * - Validation phase: 5% of total
 * - Staging phase: 60% of total (bulk of the work)
 * - Activation phase: 30% of total
 * - Cleanup phase: 5% of total
 *
 * Within staging/activation, progress is proportional to entity count.
 */
function calculateProgress(
  phase: ImportPhaseV2,
  layers: Record<
    string,
    { status: LayerImportStatus; entityCount: number; processedCount: number }
  >,
  totalEntityCount: number,
): number {
  const PHASE_WEIGHTS = {
    queued: 0,
    validating: 0, // 0-5%
    staging: 5, // 5-65%
    resolving_refs: 62, // [R3 Fix] R3-PROGRESS-PHASE: between staging (5-65%) and activating (65-95%)
    activating: 65, // 65-95%
    completed: 100,
    failed: -1, // preserve last known progress
    rolling_back: -1,
    cancelled: -1,
  };

  if (phase === 'completed') return 100;
  if (phase === 'queued') return 0;
  if (phase === 'validating') return 2; // midpoint of 0-5

  const basePercent = PHASE_WEIGHTS[phase];
  if (basePercent < 0) return -1; // caller preserves last known

  // Calculate intra-phase progress
  let processedEntities = 0;
  for (const layer of Object.values(layers)) {
    if (phase === 'staging' && (layer.status === 'staged' || layer.status === 'activated')) {
      processedEntities += layer.entityCount;
    } else if (phase === 'staging') {
      processedEntities += layer.processedCount;
    } else if (phase === 'activating' && layer.status === 'activated') {
      processedEntities += layer.entityCount;
    } else if (phase === 'activating') {
      processedEntities += layer.processedCount;
    }
  }

  const phaseRange = phase === 'staging' ? 60 : 30; // staging=60%, activating=30%
  const intraPhasePercent =
    totalEntityCount > 0 ? (processedEntities / totalEntityCount) * phaseRange : 0;

  return Math.min(Math.round(basePercent + intraPhasePercent), 99); // never 100 until 'completed'
}
```

### 2.4 Status API Endpoint

```
GET /api/projects/:projectId/project-io/import/v2/status/:operationId
```

> **[R1 Fix: VULN-5]** The status query MUST include `tenantId` and `projectId` in
> the filter to prevent cross-tenant information disclosure. Without these, a user from
> tenant A who guesses an `operationId` could view import details (error messages,
> layer names, entity counts) belonging to tenant B. The `tenantIsolationPlugin` on
> the model provides some protection, but explicit filtering is defense-in-depth.

```typescript
// Route handler implementation:
const operation = await ImportOperationState.findOne({
  _id: operationId,
  projectId, // from route params, verified by requireProjectScope
  tenantId, // from auth context, injected by tenantIsolationPlugin
});

if (!operation) {
  // Return 404 (not 403) to avoid leaking existence — per platform principle
  return res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message: 'Import operation not found' },
  });
}
```

Response schema:

```typescript
interface ImportStatusResponse {
  success: true;
  operation: {
    operationId: string;
    status: ImportPhaseV2;
    progressPercent: number;
    source: string;

    /** Per-layer breakdown */
    layers: Record<
      string,
      {
        status: LayerImportStatus;
        entityCount: number;
        processedCount: number;
        durationMs: number | null;
      }
    >;

    /** Timing */
    createdAt: string;
    startedAt: string | null;
    completedAt: string | null;
    elapsedMs: number;

    /** Error (only if status === 'failed') */
    error?: {
      phase: string;
      layer: string;
      message: string;
    };

    /** Summary (only if status === 'completed') */
    summary?: {
      created: number;
      updated: number;
      deleted: number;
      layerDurations: Record<string, number>;
      totalDurationMs: number;
    };
  };
}
```

### 2.5 WebSocket Event Schema

WebSocket event pushed to subscribed clients via Runtime's existing WebSocket infrastructure:

```typescript
/**
 * WebSocket message type for import progress.
 *
 * Clients subscribe by sending:
 *   { type: 'subscribe_import', operationId: '...' }
 *
 * Server pushes events:
 *   { type: 'import_progress', ... }
 */
interface ImportProgressWSMessage {
  type: 'import_progress';
  operationId: string;
  phase: ImportPhaseV2;
  progressPercent: number;
  currentLayer: string | null;
  layers: Record<
    string,
    {
      status: LayerImportStatus;
      processedCount: number;
      entityCount: number;
    }
  >;
  error?: { phase: string; layer: string; message: string };
  timestamp: string;
}
```

---

## 3. Memory Management

### 3.1 Problem Statement

A large v2 import might contain:

- 1,000 agents (core layer) at ~5KB each = ~5MB
- 10,000 vocabulary entries at ~200 bytes each = ~2MB
- 200 workflows with versions at ~10KB each = ~2MB
- Plus connections, guardrails, evals, search configs, channels

Total uncompressed: potentially 50MB+ in memory. Loading all files, parsing all entities, and holding all staged records simultaneously will exceed the ~150MB per-request budget in a worker processing 3 concurrent imports.

### 3.2 Streaming File Processing

```typescript
/**
 * Process import files in a streaming fashion.
 *
 * Instead of loading all files into memory:
 * 1. Decompress the GridFS payload into a Map<string, string>
 *    (unavoidable — gzip requires full decompression, but this is bounded
 *    by the 50MB MAX_IMPORT_TOTAL_SIZE limit)
 * 2. Parse files per-layer (not all at once)
 * 3. Release references to parsed layer data after staging
 */

async function processLayerFiles(
  allFiles: Map<string, string>,
  layer: LayerName,
  batchSize: number,
): AsyncGenerator<StagedRecord[]> {
  // Extract only files belonging to this layer
  const layerPrefix = getLayerFilePrefix(layer);
  const layerFiles: Array<[string, string]> = [];

  for (const [path, content] of allFiles) {
    if (path.startsWith(layerPrefix)) {
      layerFiles.push([path, content]);
    }
  }

  // Yield records in batches
  let batch: StagedRecord[] = [];
  for (const [path, content] of layerFiles) {
    const record = parseFileToRecord(layer, path, content);
    if (record) {
      batch.push(record);
    }
    if (batch.length >= batchSize) {
      yield batch;
      batch = [];
    }
  }

  if (batch.length > 0) {
    yield batch;
  }
}
```

### 3.3 Per-Layer Processing

```typescript
/**
 * Process layers sequentially, releasing memory after each.
 *
 * The ACTIVATION_ORDER from StagedImporter ensures dependency ordering:
 * connections -> core -> search -> workflows -> guardrails -> evals -> channels -> vocabulary
 */
async function processImportLayers(
  files: Map<string, string>,
  layers: LayerName[],
  operationId: string,
  config: ImportBatchConfig,
): Promise<void> {
  const orderedLayers = ACTIVATION_ORDER.filter((l) => layers.includes(l));

  for (const layer of orderedLayers) {
    // Process this layer in batches
    const batchGenerator = processLayerFiles(files, layer, config.stagingBatchSize);

    for await (const batch of batchGenerator) {
      await dbAdapter.insertStagedRecords(
        getCollectionForLayer(layer),
        batch.map((r) => r.data),
      );

      // Update progress after each batch
      await updateLayerProgress(operationId, layer, batch.length);
    }

    // Layer staging complete — no need to hold its parsed data
    log.info('Layer staged', { operationId, layer });
  }
}
```

### 3.4 Batch DB Operations

```typescript
/**
 * Configurable batch sizes for DB operations.
 *
 * These values balance memory usage against DB round-trip overhead.
 * Each batch is a single bulkWrite or insertMany call.
 */
export interface ImportBatchConfig {
  /** Records per insertMany call during staging (default: 100) */
  stagingBatchSize: number;
  /** Records per bulkWrite call during activation (default: 200) */
  activationBatchSize: number;
  /** Max concurrent DB operations (default: 1 — sequential for safety) */
  maxConcurrentDbOps: number;
  /** Memory budget per import in bytes (default: 150MB) */
  memoryBudgetBytes: number;
}

const DEFAULT_BATCH_CONFIG: ImportBatchConfig = {
  stagingBatchSize: 100,
  activationBatchSize: 200,
  maxConcurrentDbOps: 1,
  memoryBudgetBytes: 150 * 1024 * 1024,
};

/**
 * Environment-configurable overrides.
 */
function resolveImportBatchConfig(): ImportBatchConfig {
  return {
    stagingBatchSize: parseInt(process.env.IMPORT_STAGING_BATCH_SIZE ?? '100', 10),
    activationBatchSize: parseInt(process.env.IMPORT_ACTIVATION_BATCH_SIZE ?? '200', 10),
    maxConcurrentDbOps: parseInt(process.env.IMPORT_MAX_CONCURRENT_DB_OPS ?? '1', 10),
    memoryBudgetBytes: parseInt(process.env.IMPORT_MEMORY_BUDGET_MB ?? '150', 10) * 1024 * 1024,
  };
}
```

### 3.5 Back-Pressure

```typescript
/**
 * Back-pressure mechanism: pause processing if memory exceeds budget.
 *
 * Checks process.memoryUsage().heapUsed against the configured budget.
 * If exceeded, waits for GC (via setImmediate) before continuing.
 * After 3 consecutive over-budget checks, reduces batch size by half.
 */
async function checkMemoryPressure(config: ImportBatchConfig): Promise<{
  shouldContinue: boolean;
  adjustedBatchSize: number | null;
}> {
  const { heapUsed } = process.memoryUsage();

  if (heapUsed < config.memoryBudgetBytes * 0.8) {
    return { shouldContinue: true, adjustedBatchSize: null };
  }

  if (heapUsed >= config.memoryBudgetBytes) {
    // Force a microtask yield to allow GC
    await new Promise((resolve) => setImmediate(resolve));

    const afterGc = process.memoryUsage().heapUsed;
    if (afterGc >= config.memoryBudgetBytes) {
      // Reduce batch size for subsequent operations
      return {
        shouldContinue: true,
        adjustedBatchSize: Math.max(10, Math.floor(config.stagingBatchSize / 2)),
      };
    }
  }

  return { shouldContinue: true, adjustedBatchSize: null };
}
```

---

## 4. Rate Limiting & Concurrency

### 4.1 Redis Key Design for Rate Limiting

```
# Per-project import lock (mutual exclusion)
# [R1 Fix: OPS-2] TTL is 1.5x the 10-minute job timeout to prevent race conditions
import-v2-lock:{projectId}
  Value: {podId}:{timestamp}:{random}
  TTL:   900 seconds (15 minutes)

# Per-tenant concurrent import counter (sorted set)
import-v2:active:{tenantId}
  Members: operationId values
  Scores:  enqueue timestamp
  TTL:     700 seconds (10 min + buffer, refreshed on each import start)

# Per-tenant queue depth counter
import-v2:queued:{tenantId}
  Value: integer count
  TTL:   3600 seconds (1 hour)

# Per-project cooldown
import-v2:cooldown:{projectId}
  Value: "1"
  TTL:   30 seconds (minimum interval between imports)

# Import API rate limit (separate from general API limits)
ratelimit:import-v2:{tenantId}
  Value: request count
  TTL:   60 seconds (per-minute window)
```

### 4.2 Per-Tenant Concurrent Import Limit

```typescript
const MAX_CONCURRENT_IMPORTS_PER_TENANT = 2;
const MAX_QUEUED_IMPORTS_PER_TENANT = 5;

/**
 * Check tenant import limits before enqueuing.
 *
 * Uses a Redis sorted set to track active imports per tenant.
 * Score = enqueue timestamp, member = operationId.
 * Expired entries (older than 10 minutes) are cleaned on each check.
 */
async function checkTenantImportLimits(
  redis: Redis,
  tenantId: string,
  operationId: string,
): Promise<{ allowed: boolean; reason?: string }> {
  const activeKey = `import-v2:active:${tenantId}`;
  const queuedKey = `import-v2:queued:${tenantId}`;
  const now = Date.now();
  const maxAge = now - 600_000; // 10 minutes

  // Clean up expired entries
  await redis.zremrangebyscore(activeKey, '-inf', maxAge);

  // Check active count
  const activeCount = await redis.zcard(activeKey);
  if (activeCount >= MAX_CONCURRENT_IMPORTS_PER_TENANT) {
    return {
      allowed: false,
      reason: `Tenant has ${activeCount} active imports (max ${MAX_CONCURRENT_IMPORTS_PER_TENANT}). Please wait for one to complete.`,
    };
  }

  // Check queued count
  const queuedCount = parseInt((await redis.get(queuedKey)) ?? '0', 10);
  if (queuedCount >= MAX_QUEUED_IMPORTS_PER_TENANT) {
    return {
      allowed: false,
      reason: `Tenant has ${queuedCount} queued imports (max ${MAX_QUEUED_IMPORTS_PER_TENANT}). Please wait for some to complete.`,
    };
  }

  // Register this import
  await redis.zadd(activeKey, now, operationId);
  await redis.expire(activeKey, 700); // 10 min + buffer
  await redis.incr(queuedKey);
  await redis.expire(queuedKey, 3600);

  return { allowed: true };
}
```

### 4.3 Per-Project Import Lock (Extended for v2)

The existing v1 lock pattern from `project-io.ts` uses `SET NX EX` with a Lua release script. v2 extends this using the `DistributedLockManager` from `@agent-platform/shared-observability`, which provides the same atomic semantics with a cleaner API:

```typescript
// [R1 Fix: OPS-2] Lock TTL is 1.5x the job timeout to prevent concurrent import races.
const lock = await lockManager.acquire(projectId, {
  keyPrefix: 'import-v2-lock',
  ttlMs: 900_000, // 15 minutes (1.5x the 10-minute job timeout)
  retryAttempts: 0, // Fail fast — failed jobs go to DLQ
});
```

The existing v1 lock (`import:lock:{projectId}`, 2 minute TTL) is unmodified. v2 uses a separate key prefix (`import-v2-lock`) so v1 and v2 imports are independently lockable during the migration period. Post-migration, v1 locks are removed.

### 4.4 Project Cooldown

```typescript
const IMPORT_COOLDOWN_SECONDS = 30;

async function checkProjectCooldown(
  redis: Redis,
  projectId: string,
): Promise<{ allowed: boolean; retryAfterSeconds?: number }> {
  const key = `import-v2:cooldown:${projectId}`;
  const ttl = await redis.ttl(key);

  if (ttl > 0) {
    return { allowed: false, retryAfterSeconds: ttl };
  }

  await redis.set(key, '1', 'EX', IMPORT_COOLDOWN_SECONDS);
  return { allowed: true };
}
```

### 4.5 Import API Rate Limit

A separate rate limiter for import endpoints, more restrictive than the general API rate limit:

```typescript
/**
 * Import-specific rate limit: 10 requests per minute per tenant.
 *
 * This covers both v2 import initiation and status polling.
 * Uses the existing tenantRateLimit middleware pattern but with
 * a custom bucket.
 */
const IMPORT_RATE_LIMIT_WINDOW_SECONDS = 60;
const IMPORT_RATE_LIMIT_MAX_REQUESTS = 10;

// Applied in the route definition:
router.use(
  tenantRateLimit('import', {
    windowSeconds: IMPORT_RATE_LIMIT_WINDOW_SECONDS,
    maxRequests: IMPORT_RATE_LIMIT_MAX_REQUESTS,
  }),
);
```

### 4.6 MongoDB Write Throttling

```typescript
/**
 * Throttle DB writes during import to avoid overwhelming MongoDB.
 *
 * Strategy:
 * 1. Use writeConcern: { w: 1 } for staging (not majority — speed over durability
 *    since staged records can be recreated from GridFS import files).
 * 2. Use writeConcern: { w: 'majority' } for activation (must be durable).
 * 3. Batch inserts at 100 records per insertMany.
 * 4. 10ms delay between batches to yield CPU to other queries.
 */
const STAGING_WRITE_CONCERN = { w: 1 };
const ACTIVATION_WRITE_CONCERN = { w: 'majority' };
const INTER_BATCH_DELAY_MS = 10;
```

---

## 5. Timeout & Retry Strategy

### 5.1 Job-Level Timeout

> **[R1 Fix: OPS-1]** Changed `attempts` from 2 to 1 (no automatic retry). The
> original setting of `attempts: 2` would cause BullMQ to retry the entire job
> from the beginning after an activation failure. Since activation is NOT idempotent,
> re-staging would insert duplicate records. The worker is now made resume-aware:
> it checks the `ImportOperationState.status` field at startup and skips already-completed
> phases. Failed jobs go directly to the DLQ for manual investigation.

```typescript
/**
 * BullMQ job options with timeout and retry configuration.
 */
const IMPORT_V2_JOB_OPTIONS = {
  /** Maximum time for the entire import job */
  timeout: 600_000, // 10 minutes

  /**
   * [R1 Fix: OPS-1] No automatic retry — activation is not idempotent.
   * Re-staging after a partial activation would create duplicate records.
   * Failed jobs go to the DLQ for manual investigation/re-enqueue.
   */
  attempts: 1,

  /** Keep completed jobs for 24 hours (debugging) */
  removeOnComplete: { age: 86_400 },

  /** Keep failed jobs for 7 days (debugging) */
  removeOnFail: { age: 604_800 },
};
```

### 5.2 Phase-Level Timeouts

```typescript
/**
 * Per-phase timeout configuration.
 *
 * These are enforced within the worker using AbortController.
 * If a phase exceeds its timeout, the import fails with a clear error
 * indicating which phase timed out.
 */
const PHASE_TIMEOUTS: Record<string, number> = {
  /** Validation: parse manifests, check dependencies */
  validating: 30_000, // 30 seconds

  /** Staging: write records with status='staged' (per layer) */
  staging_per_layer: 120_000, // 2 minutes per layer

  /** Activation: atomic swap staged->active (per layer) */
  activation_per_layer: 60_000, // 1 minute per layer

  /** Cleanup: delete superseded records */
  cleanup: 60_000, // 1 minute (fire-and-forget, but bounded)
};

/**
 * Execute a phase with timeout using AbortController.
 */
async function executeWithTimeout<T>(
  phaseName: string,
  timeoutMs: number,
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fn(controller.signal);
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Import phase '${phaseName}' timed out after ${timeoutMs}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}
```

### 5.3 Retry Policy

> **[R1 Fix: OPS-1]** Job-level retry is disabled (`attempts: 1`). Instead, the worker
> is resume-aware: it checks `ImportOperationState.status` at startup and resumes from
> the correct phase if a previous attempt partially completed. This prevents duplicate
> staging from BullMQ's retry-from-beginning behavior.

```
Phase         | Retryable? | Rationale
------------- | ---------- | ---------
Validation    | No         | Pure computation, deterministic. If it fails, the input is bad.
Staging       | No (at job level) | Worker checks ImportOperationState.status on startup.
              |            | If status='staging', checks which layers are already staged
              |            | and resumes from the next incomplete layer.
Activation    | No         | NOT idempotent — partial activation leaves inconsistent state.
              |            | On failure, ROLLBACK instead of retry.
Cleanup       | Yes        | Idempotent deletes. Fire-and-forget with retry via scheduled job.
```

**Resume-aware worker startup:**

```typescript
/**
 * [R1 Fix: OPS-1] Check ImportOperationState before starting work.
 * If a previous attempt partially completed, resume from the correct phase
 * instead of re-staging from scratch.
 */
async function determineResumePoint(
  operationId: string,
  projectId: string,
  tenantId: string,
): Promise<{ phase: ImportPhaseV2; completedLayers: string[] }> {
  const state = await ImportOperationState.findOne({
    _id: operationId,
    projectId,
    tenantId,
  });

  if (!state) {
    return { phase: 'validating', completedLayers: [] };
  }

  // Determine which layers have already been staged
  const completedLayers: string[] = [];
  for (const [layerName, layerState] of Object.entries(state.layers ?? {})) {
    if (layerState.status === 'staged' || layerState.status === 'activated') {
      completedLayers.push(layerName);
    }
  }

  // If activation was in progress when the job failed, rollback first
  if (state.status === 'activating') {
    return { phase: 'rolling_back', completedLayers };
  }

  // [R2 Fix: R2-RESUME-1] If staging completed but cross-ref resolution may not have,
  // detect stale temp _ fields on staged records. If found, re-run cross-ref resolution.
  // The resolution is idempotent (reads staged records, builds maps, updates with $set/$unset).
  if (
    state.status === 'staging' &&
    completedLayers.length === Object.keys(state.layers ?? {}).length
  ) {
    // All layers staged — check if cross-ref resolution completed.
    // Phase 2.5 does not have a dedicated status, so detect by checking for
    // residual data._ fields on staged records. If any exist, resolution needs to re-run.
    return { phase: 'resolving_refs', completedLayers };
  }

  // If staging was in progress, resume from the next incomplete layer
  if (state.status === 'staging' && completedLayers.length > 0) {
    return { phase: 'staging', completedLayers };
  }

  // Default: start from the beginning
  return { phase: state.status === 'queued' ? 'validating' : state.status, completedLayers: [] };
}
```

BullMQ failure handler (all failures go directly to DLQ):

```typescript
worker.on('failed', async (job, err) => {
  if (!job) return;

  const { operationId, projectId, tenantId } = job.data;

  // [R1 Fix: OPS-1] No retries — move directly to DLQ
  log.error('Import job failed, moving to DLQ', {
    operationId,
    projectId,
    attempts: job.attemptsMade,
    error: err.message,
  });

  // Move to dead letter queue
  const dlq = new Queue('import-v2-dlq', { connection: pair.queueConnection });
  await dlq.add('import-v2-dead', {
    ...job.data,
    failedAt: new Date().toISOString(),
    lastError: err.message,
    attempts: job.attemptsMade,
  });
});
```

### 5.4 Stale Import Detection

The existing TTL on `ImportOperationState` (1 hour, set in `StagedImporter`) is retained. Additionally, a scheduled cleanup job detects and terminates stale imports:

```typescript
/**
 * Stale import detection runs every 5 minutes.
 *
 * An import is considered stale if:
 * 1. Status is 'queued' or 'validating'/'staging'/'activating' AND
 * 2. createdAt is older than 15 minutes AND
 * 3. No BullMQ job exists for the operationId (job was lost)
 *
 * Stale imports are marked as 'failed' with a clear error message.
 */
const STALE_IMPORT_CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
const STALE_IMPORT_THRESHOLD_MS = 15 * 60 * 1000; // 15 minutes
```

### 5.5 Dead Letter Queue

```
DLQ queue name: import-v2-dlq
```

Dead letter jobs are retained for 30 days. An admin API endpoint allows operators to inspect and re-enqueue DLQ jobs:

> **[R2 Fix: R2-AUTH-4]** All DLQ endpoints require `requirePlatformAdmin()` middleware.
> DLQ jobs contain full import metadata including `tenantId`, `projectId`, error messages,
> and layer details from potentially any tenant. Project-level auth is insufficient --
> only platform administrators should access DLQ operations to prevent cross-tenant
> information disclosure.

```
// All DLQ routes use: requireAuth(), requirePlatformAdmin()
GET    /api/admin/import/v2/dlq              — List dead-lettered imports
POST   /api/admin/import/v2/dlq/:jobId/retry — Re-enqueue a dead-lettered import
DELETE /api/admin/import/v2/dlq/:jobId       — Purge a dead-lettered import
```

```typescript
// Route registration in apps/runtime/src/routes/admin-routes.ts
import { requireAuth, requirePlatformAdmin } from '@abl/runtime/middleware/auth.js';

router.get('/api/admin/import/v2/dlq', requireAuth(), requirePlatformAdmin(), listDLQJobs);
router.post(
  '/api/admin/import/v2/dlq/:jobId/retry',
  requireAuth(),
  requirePlatformAdmin(),
  retryDLQJob,
);
router.delete(
  '/api/admin/import/v2/dlq/:jobId',
  requireAuth(),
  requirePlatformAdmin(),
  purgeDLQJob,
);
```

---

## 6. Observability & Tracing

### 6.1 Structured Logging

Every phase transition emits a structured log entry:

```typescript
// Phase transitions
log.info('Import phase transition', {
  operationId,
  projectId,
  tenantId,
  fromPhase: previousPhase,
  toPhase: newPhase,
  elapsedMs: Date.now() - phaseStartTime,
});

// Layer completions
log.info('Import layer completed', {
  operationId,
  projectId,
  layer,
  entityCount,
  durationMs,
  action: 'staged' | 'activated' | 'rolled_back',
});

// Job completion
log.info('Import job completed', {
  operationId,
  projectId,
  tenantId,
  totalDurationMs,
  layers: layerSummaries,
  created: totalCreated,
  updated: totalUpdated,
  deleted: totalDeleted,
  fileSizeBytes,
  source,
});

// Errors
log.error('Import job failed', {
  operationId,
  projectId,
  tenantId,
  phase: failedPhase,
  layer: failedLayer,
  error: err instanceof Error ? err.message : String(err),
  elapsedMs: Date.now() - jobStartTime,
  source,
});
```

### 6.2 TraceEvent Emission

Import operations emit `TraceEvent`s linked to the existing `TraceStore` for correlation with agent execution traces:

```typescript
/**
 * Import trace events follow the same TraceEvent interface from
 * apps/runtime/src/services/trace-store.ts.
 *
 * Event types:
 *   import:started    — Import job picked up by worker
 *   import:phase      — Phase transition (validating, staging, activating)
 *   import:layer      — Layer-level operation (staged, activated, rolled_back)
 *   import:completed  — Import succeeded
 *   import:failed     — Import failed
 *   import:rollback   — Rollback initiated
 */

function emitImportTraceEvent(
  traceStore: TraceStoreInterface,
  operationId: string,
  type: string,
  data: Record<string, unknown>,
): void {
  traceStore.addEvent(operationId, {
    id: `import-${operationId}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    sessionId: operationId,
    type,
    timestamp: new Date(),
    data,
  });
}
```

### 6.3 Metrics Specification

All metrics use the naming convention `import_v2_*` with labels for dimensional querying.

| Metric Name                      | Type      | Labels                                                   | Description                                               |
| -------------------------------- | --------- | -------------------------------------------------------- | --------------------------------------------------------- |
| `import_v2_duration_ms`          | Histogram | `phase`, `layer`, `status`, `tenant_id`                  | Duration of each phase/layer                              |
| `import_v2_entity_count`         | Counter   | `layer`, `operation` (create/update/delete), `tenant_id` | Entities processed per import                             |
| `import_v2_success_total`        | Counter   | `source`, `tenant_id`                                    | Successful import completions                             |
| `import_v2_failure_total`        | Counter   | `phase`, `source`, `tenant_id`                           | Failed imports by phase                                   |
| `import_v2_queue_depth`          | Gauge     | `tenant_id`                                              | Current queued imports per tenant                         |
| `import_v2_active_count`         | Gauge     | `tenant_id`                                              | Currently executing imports per tenant                    |
| `import_v2_file_size_bytes`      | Histogram | `tenant_id`                                              | Import payload size distribution                          |
| `import_v2_rollback_total`       | Counter   | `layer`, `tenant_id`                                     | Rollbacks triggered                                       |
| `import_v2_retry_total`          | Counter   | `phase`, `tenant_id`                                     | Retry attempts                                            |
| `import_v2_dlq_depth`            | Gauge     | (none)                                                   | Dead letter queue depth                                   |
| `import_v2_stale_cleaned`        | Counter   | (none)                                                   | Stale imports cleaned up                                  |
| `import_v2_memory_pressure`      | Counter   | (none)                                                   | Memory pressure back-off events                           |
| `import_v2_batch_size`           | Histogram | `phase`                                                  | Actual batch sizes used (may be reduced by back-pressure) |
| `import_v2_db_write_duration_ms` | Histogram | `operation` (insert/bulkWrite/delete), `collection`      | MongoDB write latency                                     |
| `import_v2_crossref_duration_ms` | Histogram | `collection`, `tenant_id`                                | Cross-reference resolution duration per collection        |
| `import_v2_compression_ratio`    | Gauge     | `tenant_id`                                              | Compression ratio (original / compressed) per import      |
| `import_v2_queue_wait_ms`        | Histogram | `tenant_id`                                              | Time waiting in BullMQ queue before processing            |
| `import_v2_cleanup_duration_ms`  | Histogram | (none)                                                   | Scheduled cleanup job execution time                      |
| `import_v2_gridfs_write_ms`      | Histogram | `tenant_id`                                              | Time to write compressed payload to GridFS                |

> **[R1 Fix: MON-1 through MON-5]** Added five metrics identified during performance
> audit: cross-reference resolution duration, compression ratio, queue wait time,
> cleanup job duration, and GridFS write time. The `queue_wait_ms` is calculated as
> `job.processedOn - job.timestamp` (both provided by BullMQ). An SLO should be
> defined during implementation: "95% of imports with <= 100 entities complete within
> 60 seconds" and "99% of imports complete within 5 minutes regardless of size."

### 6.4 Dashboard Design

Operators need visibility into import health across three dimensions:

**1. Real-Time Operations View**

```
+------------------------------------------------------+
| Import Operations (Last 24 Hours)                     |
+------------------------------------------------------+
| Active:  3    Queued: 7    Completed: 142    Failed: 5 |
|                                                        |
| [Live Table: operationId | project | tenant | phase    |
|  | progress% | duration | source]                      |
+------------------------------------------------------+
```

**2. Throughput & Latency**

```
+------------------------------------------------------+
| Import Throughput                                     |
+------------------------------------------------------+
| [Time series: imports/hour, p50/p95/p99 duration]     |
| [Breakdown by layer: which layers take the longest]   |
| [Entity throughput: entities/second by layer]          |
+------------------------------------------------------+
```

**3. Error & Health**

```
+------------------------------------------------------+
| Import Health                                         |
+------------------------------------------------------+
| Success Rate (1h): 97.2%    DLQ Depth: 0             |
| Circuit Breaker: CLOSED     Memory Pressure: 0/min   |
|                                                        |
| [Top errors: phase | layer | error message | count]   |
| [Tenant breakdown: which tenants are importing most]  |
+------------------------------------------------------+
```

### 6.5 Alert Conditions

| Alert                    | Condition                                                         | Severity | Action                                             |
| ------------------------ | ----------------------------------------------------------------- | -------- | -------------------------------------------------- |
| Import failure rate high | `import_v2_failure_total / (success + failure) > 10%` over 15 min | Warning  | Investigate logs for common error pattern          |
| Queue depth growing      | `import_v2_queue_depth > 20` for 10 min                           | Warning  | Check worker health, consider scaling              |
| DLQ accumulating         | `import_v2_dlq_depth > 5`                                         | Critical | Manual investigation required                      |
| Import duration spike    | `import_v2_duration_ms p99 > 300000` (5 min)                      | Warning  | Check MongoDB latency, entity counts               |
| Stale imports            | `import_v2_stale_cleaned > 3` in 1 hour                           | Warning  | Workers may be unhealthy or crashing               |
| Circuit breaker open     | `breaker:app:import-*:state = OPEN`                               | Critical | MongoDB or dependent service is degraded           |
| Memory pressure          | `import_v2_memory_pressure > 10` in 5 min                         | Warning  | Reduce IMPORT_V2_WORKER_CONCURRENCY or batch sizes |

---

## 7. Circuit Breaker for External Dependencies

### 7.1 Integration Points

The import worker depends on two external systems that can become degraded:

1. **MongoDB** -- All staging, activation, and state tracking operations
2. **Auth Profile Resolution Service** -- Resolving auth profiles referenced in connections layer

### 7.2 MongoDB Circuit Breaker

Using the existing `RedisCircuitBreaker` from `@agent-platform/circuit-breaker`:

```typescript
/**
 * Circuit breaker for MongoDB operations during import.
 *
 * Level: 'app' (scoped to import operations, not per-tenant).
 * Key: 'import-mongodb'
 *
 * Config tuned for import workload (higher threshold than default
 * because imports do many sequential DB operations — a single
 * transient failure shouldn't trip the breaker):
 */
const importDbBreaker = new RedisCircuitBreaker(redis, 'app', {
  failureThreshold: 15, // 15 failures before opening
  successThreshold: 3, // 3 successes to close from half-open
  resetTimeout: 30_000, // 30 seconds in OPEN before trying half-open
  monitorWindow: 60_000, // 1 minute rolling window
  halfOpenMaxConcurrent: 1, // Only 1 import tries when half-open
  failureRateThreshold: 40, // 40% failure rate triggers open
  minimumRequestCount: 10, // Need at least 10 requests before rate calculation
});

/**
 * Wrap every MongoDB operation in the circuit breaker.
 */
async function protectedDbOperation<T>(
  tenantId: string,
  operationName: string,
  fn: () => Promise<T>,
): Promise<T> {
  try {
    return await importDbBreaker.execute(`import-mongodb`, fn);
  } catch (err) {
    if (err instanceof CircuitOpenError) {
      log.warn('Import MongoDB circuit breaker OPEN, failing fast', {
        tenantId,
        operation: operationName,
        retryAfterMs: err.retryAfterMs,
      });
      throw new Error(
        `Import paused: database is experiencing high latency. Retry after ${Math.ceil(err.retryAfterMs / 1000)}s.`,
      );
    }
    throw err;
  }
}
```

### 7.3 Auth Profile Resolution Circuit Breaker

```typescript
/**
 * Circuit breaker for auth profile resolution during connection layer import.
 *
 * If the auth profile service is down, imports that include the 'connections'
 * layer fail fast instead of hanging on HTTP timeouts.
 *
 * Level: 'tool_service' (external service dependency).
 * Key: 'import-auth-profiles'
 */
const authProfileBreaker = new RedisCircuitBreaker(redis, 'tool_service', {
  failureThreshold: 5, // Service-level breaker: fewer failures to trip
  successThreshold: 2,
  resetTimeout: 60_000, // 1 minute before retry
  monitorWindow: 30_000,
  halfOpenMaxConcurrent: 1,
  failureRateThreshold: 30,
  minimumRequestCount: 3,
});

/**
 * When the auth profile breaker is OPEN:
 * - Imports WITHOUT 'connections' layer proceed normally.
 * - Imports WITH 'connections' layer fail with a clear message:
 *   "Cannot import connections: auth profile service is unavailable."
 */
async function resolveAuthProfiles(
  profiles: Array<{ name: string; authType: string }>,
  tenantId: string,
): Promise<ResolvedProfile[]> {
  return authProfileBreaker.execute(`import-auth-profiles:${tenantId}`, () =>
    authProfileService.resolveProfiles(profiles, tenantId),
  );
}
```

### 7.4 Breaker Event Logging

```typescript
importDbBreaker.onEvent((event) => {
  if ('from' in event && 'to' in event) {
    // State change
    log.warn('Import DB circuit breaker state change', {
      from: event.from,
      to: event.to,
      failureCount: event.failureCount,
      failureRate: event.failureRate,
    });
  }
});

authProfileBreaker.onEvent((event) => {
  if ('from' in event && 'to' in event) {
    log.warn('Auth profile circuit breaker state change', {
      from: event.from,
      to: event.to,
      failureCount: event.failureCount,
    });
  }
});
```

---

## 8. Cleanup & Garbage Collection

### 8.1 Cleanup Responsibilities

| Resource                                    | Cleanup Trigger                                     | Fallback                                                               |
| ------------------------------------------- | --------------------------------------------------- | ---------------------------------------------------------------------- |
| GridFS import files (`importFiles` bucket)  | On import completion/failure (worker deletes)       | Cleanup job checks `metadata.expiresAt` (2 hours)                      |
| Staged records (`status: 'staged'`)         | On activation (become active) or rollback (deleted) | Scheduled cleanup job: find orphaned staged records older than 2 hours |
| Superseded records (`status: 'superseded'`) | Fire-and-forget delete in StagedImporter.cleanup()  | Scheduled cleanup job: find superseded records older than 1 hour       |
| `ImportOperationState` documents            | TTL: `expiresAt` (1 hour)                           | MongoDB TTL index                                                      |
| Redis keys (locks, counters, cooldowns)     | TTL on each key                                     | No manual cleanup needed                                               |
| BullMQ completed jobs                       | `removeOnComplete: { age: 86400 }` (24h)            | BullMQ built-in cleanup                                                |
| BullMQ failed jobs                          | `removeOnFail: { age: 604800 }` (7 days)            | BullMQ built-in cleanup                                                |
| DLQ jobs                                    | Manual review by operators                          | 30-day TTL                                                             |

### 8.2 Scheduled Cleanup Job

A repeatable BullMQ job handles orphaned resources:

```typescript
/**
 * Import cleanup job — runs every 15 minutes.
 *
 * Handles resources that were not cleaned up by the import worker
 * (e.g., worker crashed, pod was terminated, lock expired).
 */
const CLEANUP_QUEUE_NAME = 'import-v2-cleanup';
const CLEANUP_INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

interface CleanupJobData {
  scheduledAt: string;
}

async function processCleanupJob(job: Job<CleanupJobData>): Promise<void> {
  const log = createLogger('import-v2-cleanup');
  const now = new Date();

  // 1. Clean up orphaned import files from GridFS
  //    [R1 Fix: PERF-4] Files are now stored in GridFS instead of a single BSON document.
  //    GridFS does not support TTL indexes, so expiration is handled here.
  const bucket = new GridFSBucket(db, { bucketName: 'importFiles' });
  const expiredFiles = bucket.find({
    'metadata.expiresAt': { $lt: now },
  });
  let deletedFileCount = 0;
  for await (const file of expiredFiles) {
    await bucket.delete(file._id);
    deletedFileCount++;
    if (deletedFileCount >= 100) break; // Cap per-run to avoid long cleanup
  }
  if (deletedFileCount > 0) {
    log.info('Cleaned up orphaned import files from GridFS', { count: deletedFileCount });
  }

  // 2. Clean up orphaned staged records
  //    Records with status='staged' that belong to failed/expired operations
  const staleThreshold = new Date(now.getTime() - 2 * 60 * 60 * 1000); // 2 hours ago
  const staleOperations = await ImportOperationState.find({
    status: { $in: ['failed', 'rolling_back'] },
    createdAt: { $lt: staleThreshold },
  }).limit(50);

  for (const op of staleOperations) {
    for (const [collection, ids] of Object.entries(op.stagedRecordIds)) {
      if (ids.length > 0) {
        const model = getCollectionModel(collection);
        await model.deleteMany({
          _id: { $in: ids },
          status: 'staged',
        });
        log.info('Cleaned up stale staged records', {
          operationId: op._id,
          collection,
          count: ids.length,
        });
      }
    }
  }

  // 3. Clean up superseded records missed by fire-and-forget
  //    Completed operations older than 1 hour that still have superseded records
  const completedThreshold = new Date(now.getTime() - 60 * 60 * 1000); // 1 hour ago
  const completedOps = await ImportOperationState.find({
    status: 'completed',
    createdAt: { $lt: completedThreshold },
    supersededRecordIds: { $exists: true, $ne: {} },
  }).limit(50);

  for (const op of completedOps) {
    for (const [collection, ids] of Object.entries(op.supersededRecordIds)) {
      if (ids.length > 0) {
        const model = getCollectionModel(collection);
        const result = await model.deleteMany({
          _id: { $in: ids },
          status: 'superseded',
        });
        log.info('Cleaned up superseded records', {
          operationId: op._id,
          collection,
          deleted: result.deletedCount,
        });
      }
    }
    // Clear supersededRecordIds to prevent re-processing
    await ImportOperationState.updateOne({ _id: op._id }, { $set: { supersededRecordIds: {} } });
  }

  // 4. Detect and fail stale in-progress imports
  const staleInProgress = await ImportOperationState.find({
    status: { $in: ['queued', 'validating', 'staging', 'activating'] },
    createdAt: { $lt: new Date(now.getTime() - STALE_IMPORT_THRESHOLD_MS) },
  }).limit(20);

  for (const op of staleInProgress) {
    await ImportOperationState.updateOne(
      { _id: op._id },
      {
        $set: {
          status: 'failed',
          error: {
            phase: op.status,
            layer: 'unknown',
            message:
              'Import timed out: no worker progress for 15+ minutes. The job may have been lost.',
          },
          completedAt: now,
        },
      },
    );
    log.warn('Marked stale import as failed', {
      operationId: op._id,
      projectId: op.projectId,
      previousStatus: op.status,
      age: now.getTime() - op.createdAt.getTime(),
    });
  }
}
```

### 8.3 Cleanup Job Registration

```typescript
/**
 * Register the repeatable cleanup job at worker startup.
 *
 * BullMQ ensures only one instance of a repeatable job runs at a time,
 * even across multiple pods. The `jobId` makes it deduplicated.
 */
async function registerCleanupJob(queue: Queue): Promise<void> {
  await queue.upsertJobScheduler(
    'import-v2-cleanup-scheduler',
    { every: CLEANUP_INTERVAL_MS },
    {
      name: 'import-v2-cleanup',
      data: { scheduledAt: new Date().toISOString() },
      opts: {
        removeOnComplete: { count: 10 }, // Keep last 10 runs
        removeOnFail: { count: 50 },
      },
    },
  );
}
```

---

## Capacity Calculations

### Import Size Budget

> **[R1 Fix: PERF-4]** GridFS removes the 16MB BSON limit concern. The 50MB hard
> limit is retained as the maximum uncompressed payload size. At worst-case 3x
> compression, this yields ~17MB compressed, well within GridFS capability.

```
Layer          | Max Entities | Avg Size/Entity | Max Layer Size
------------- | ------------ | --------------- | -------------
core           | 1,000        | 5 KB            | 5 MB
connections    | 200          | 2 KB            | 400 KB
guardrails     | 100          | 3 KB            | 300 KB
workflows      | 200          | 10 KB           | 2 MB
evals          | 500          | 2 KB            | 1 MB
search         | 100          | 1 KB            | 100 KB
channels       | 50           | 1 KB            | 50 KB
vocabulary     | 10,000       | 200 B           | 2 MB
------------- | ------------ | --------------- | -------------
TOTAL          | 12,150       |                 | ~11 MB typical
                                                | 50 MB hard limit
Compressed (worst-case 3x):                     | ~17 MB in GridFS
Compressed (typical 5x):                        | ~10 MB in GridFS
```

### Memory Budget per Import

> **[R1 Fix: PERF-4]** Updated compression estimates. DSL content and complex JSON
> compress at 3-4x (not 5-10x). GridFS storage removes the BSON limit concern, but
> the decompressed size in memory remains the dominant factor.

```
Compressed file in GridFS:      ~12-17 MB (gzip of 50MB, 3-4x ratio)
Decompressed file in memory:    ~50 MB (worst case)
Parsed records for one layer:   ~5 MB (largest layer = core, 1000 agents)
Batch in flight (100 records):  ~500 KB
MongoDB write buffers:          ~2 MB
Import state tracking:          ~100 KB
---------------------------------------------
Peak per import:                ~58 MB
x3 concurrent imports:          ~174 MB
Worker base memory:             ~100 MB
---------------------------------------------
Total worker memory budget:     ~275 MB (fits in 512MB pod)
```

### Throughput Estimates

```
Operation                | Latency      | Throughput
------------------------ | ------------ | ----------
insertMany (100 docs)    | ~50 ms       | 2,000 docs/s
bulkWrite (200 updates)  | ~80 ms       | 2,500 ops/s
Gzip decompress (50MB)   | ~200 ms      | one-time
File parsing (1000 files)| ~500 ms      | one-time
-----------------------------------------------------
Full import (1000 agents, all layers, 2000 entities total):
  - Validation:    ~500 ms
  - Staging:       ~5 s (20 batches x 100 docs x 50ms)
  - Activation:    ~3 s (8 layers x ~400ms bulkWrite)
  - Total:         ~10 s

Full import (12,150 entities, all layers at max):
  - Validation:    ~2 s
  - Staging:       ~60 s (122 batches)
  - Cross-ref resolution: ~500 ms (10 queries + 7-8 bulkWrites, ~18-20 round trips) [R3 Fix]
  - Activation:    ~20 s (8 layers, multiple collections)
  - Total:         ~90 s
```

### Redis Memory Budget

```
Key                                  | Size    | Count       | Total
------------------------------------ | ------- | ----------- | -----
import-v2-lock:{projectId}           | ~100 B  | 3 active    | 300 B
import-v2:active:{tenantId}          | ~200 B  | 10 tenants  | 2 KB
import-v2:queued:{tenantId}          | ~50 B   | 10 tenants  | 500 B
import-v2:cooldown:{projectId}       | ~50 B   | 50 projects | 2.5 KB
ratelimit:import-v2:{tenantId}       | ~50 B   | 10 tenants  | 500 B
BullMQ job data (queue)              | ~1 KB   | 20 queued   | 20 KB
BullMQ job data (completed, 24h)     | ~1 KB   | 500         | 500 KB
BullMQ job data (failed, 7 days)     | ~2 KB   | 50          | 100 KB
Redis pub/sub channels               | ~0 B    | ephemeral   | 0 B
Circuit breaker keys                 | ~500 B  | 12 keys     | 6 KB
-----------------------------------------------------------------
Total Redis footprint:                                        ~632 KB
```

Redis memory impact is negligible because file contents are stored in MongoDB, not in job payloads.

---

## Summary of Redis Key Design

```
# Distributed locks
import-v2-lock:{projectId}                    TTL: 900s   Purpose: Per-project mutual exclusion (1.5x job timeout)

# Rate limiting & concurrency
import-v2:active:{tenantId}                   TTL: 700s   Purpose: Sorted set of active operation IDs
import-v2:queued:{tenantId}                   TTL: 3600s  Purpose: Counter of queued imports
import-v2:cooldown:{projectId}                TTL: 30s    Purpose: Minimum interval between imports
ratelimit:import-v2:{tenantId}                TTL: 60s    Purpose: Per-minute API rate limit

# BullMQ (managed by BullMQ, listed for reference)
bull:import-v2:*                              Various     Purpose: Queue state, jobs, events
bull:import-v2-cleanup:*                      Various     Purpose: Cleanup scheduler
bull:import-v2-dlq:*                          Various     Purpose: Dead letter queue

# Redis pub/sub (no persistence, ephemeral)
import:progress:{operationId}                 N/A         Purpose: Real-time progress events

# Circuit breakers (managed by @agent-platform/circuit-breaker)
breaker:app:import-mongodb:*                  Various     Purpose: MongoDB health
breaker:tool_service:import-auth-profiles:*   Various     Purpose: Auth profile service health
```
