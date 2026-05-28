# PDF-to-KB Integration via File Connector

## Goal

Connect the multimodal-service's PDF processing pipeline (Tika extraction) to the search-ai knowledge base ingestion pipeline, exposed through the ConnectorsTab file connector UI in Studio.

## Architecture

The multimodal-service already has a complete async processing pipeline (scan → validate → process → index) with Apache Tika for PDF/document extraction and `AttachmentSearchProducer` for search-ai integration. The file connector in ConnectorsTab already has a UI card. The work is connecting three layers:

1. **ConnectorsTab file connector** gets a drag-and-drop file upload zone (replaces the current config-only form)
2. **Studio API proxy** gets a new route that forwards file uploads to multimodal-service with the target `indexId`
3. **Multimodal-service** gets BullMQ wired in `server.ts` so the pipeline actually executes
4. **`AttachmentSearchProducer`** gets an optional `targetSearchIndexId` override so it can target a specific KB index instead of resolving via project

## Data Flow

```
ConnectorsTab (drag-drop PDFs)
    ↓ FormData POST
Studio API /api/search-ai/knowledge-bases/[kbId]/indexes/[indexId]/upload
    ↓ proxy multipart to multimodal-service
POST /internal/attachments  (+ X-Search-Index-Id header)
    ↓ multer → AttachmentService.upload()
    ↓ enqueue scan job
BullMQ: scan → validate → process (Tika extracts PDF text) → index
    ↓
AttachmentSearchProducer.ingest(attachment, overrideIndexId)
    ↓
SearchAIClient.ingestDocument(indexId, { title, rawText, sourceMetadata })
    ↓
Search-AI: chunk → embed → vector store
```

## Component Changes

### ConnectorsTab File Connector Form

Replace the current `fileTypes` + `maxFileSize` config inputs with:

- Drag-and-drop zone using native HTML5 drag events (no new dependencies)
- File list with upload progress per file
- Accepted types: PDF, DOCX, TXT, MD, HTML, CSV (from multimodal-service's allowlist)
- Max 50MB per file (multimodal-service's multer limit)
- After upload: source record is created, documents appear in DocumentsTab as they're processed

### Studio API Route

New Next.js route handler:
`/api/search-ai/knowledge-bases/[kbId]/indexes/[indexId]/upload/route.ts`

- Accepts `multipart/form-data` with `file` field
- Forwards to multimodal-service `POST /internal/attachments` with:
  - The file as a stream
  - `X-Tenant-Id`, `X-Project-Id` headers (from auth context)
  - `X-Search-Index-Id` header with the target indexId
- Returns `{ attachmentId, status: 'accepted' }` (processing is async)

### Multimodal-Service `server.ts` — Wire BullMQ

- Create real queues: `createQueue(QUEUE_NAMES.SCAN)`, etc.
- Create workers: `new Worker(QUEUE_NAMES.SCAN, createScanWorker(deps), workerOpts)`, etc.
- Connect MongoDB on startup
- Graceful shutdown: close workers then queues

### Multimodal-Service Upload Route

Read optional `X-Search-Index-Id` header, store on Attachment record as `targetSearchIndexId`.

### `AttachmentSearchProducer.ingest()`

Check `attachment.targetSearchIndexId` first. If set, use it directly instead of calling `indexResolver.resolveForProject()`. This lets KB-targeted uploads go to the right index.

### Search-AI API Client

Add `uploadDocumentFile(indexId, file)` method in `apps/studio/src/api/search-ai.ts` that calls the Studio proxy route. Used by ConnectorsTab.

## What We're NOT Building

- No new storage provider (S3/local already works)
- No new processing pipeline stages (scan/validate/process/index all exist)
- No new Tika or ClamAV integration (already implemented)
- No polling UI for document processing status (DocumentsTab already shows status badges)
- No changes to search-ai ingestion pipeline (it already accepts `rawText` from any source)

## Error Handling

- Upload fails (multer size limit, invalid type) → immediate 400 response to UI
- ClamAV scan finds infected file → Attachment marked `scanStatus: 'infected'`, pipeline stops
- Tika extraction fails → Attachment marked `processingStatus: 'failed'` with error
- Search-AI ingestion fails → Attachment marked `embeddingStatus: 'failed'`, retryable

## Testing

- Unit tests: BullMQ wiring (mock queues), upload route (mock multimodal-service), `AttachmentSearchProducer` with `targetSearchIndexId` override
- Existing test suites: multimodal-service already has `scan-job.test.ts`, `validate-job.test.ts`, `process-job.test.ts`, `index-job.test.ts`

## Key Files

| File                                                                                         | Change                                 |
| -------------------------------------------------------------------------------------------- | -------------------------------------- |
| `apps/multimodal-service/src/server.ts`                                                      | Wire BullMQ queues + workers + MongoDB |
| `apps/multimodal-service/src/routes/attachments.ts`                                          | Read `X-Search-Index-Id` header        |
| `apps/multimodal-service/src/services/attachment-search-producer.ts`                         | Support `targetSearchIndexId` override |
| `apps/studio/src/components/search-ai/ConnectorsTab.tsx`                                     | File upload UI for file connector      |
| `apps/studio/src/api/search-ai.ts`                                                           | Add `uploadDocumentFile()` method      |
| `apps/studio/src/app/api/search-ai/knowledge-bases/[kbId]/indexes/[indexId]/upload/route.ts` | New proxy route                        |
| `packages/database/src/models/attachment.model.ts`                                           | Add `targetSearchIndexId` field        |

---

## Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Connect the multimodal-service PDF processing pipeline to search-ai knowledge base ingestion via the ConnectorsTab file connector UI.

**Architecture:** The multimodal-service has a complete BullMQ pipeline (scan → validate → process → index) with Tika for PDF extraction and `AttachmentSearchProducer` for search-ai ingestion. The file connector in ConnectorsTab needs a drag-and-drop UI. A new Studio API route proxies file uploads to multimodal-service. The Attachment model gets a `targetSearchIndexId` field so the index-job sends extracted content to the right KB index.

**Tech Stack:** TypeScript, Next.js 15 (App Router), React 18, BullMQ, Multer, Mongoose, Vitest

---

## Task 1: Add `targetSearchIndexId` to Attachment Model

The Attachment model needs a new optional field so KB-targeted uploads can specify which search index to ingest into, instead of relying on project-level resolution.

**Files:**

- Modify: `packages/database/src/models/attachment.model.ts`

**Step 1:** Add `targetSearchIndexId` to the `IAttachment` interface after line 66 (`embeddedAt`):

```typescript
// In IAttachment interface, after embeddedAt: Date | null;
/** Optional override: target search index for KB-specific uploads */
targetSearchIndexId: string | null;
```

**Step 2:** Add the schema field after line 144 (`embeddedAt`):

```typescript
    // KB-targeted upload
    targetSearchIndexId: { type: String, default: null },
```

**Step 3:** Run the build to verify types compile:

Run: `pnpm --filter @agent-platform/database build`
Expected: Build succeeds

**Step 4:** Commit:

```bash
git add packages/database/src/models/attachment.model.ts
git commit -m "[ABLP-2] feat(database): add targetSearchIndexId field to Attachment model"
```

---

## Task 2: Update `AttachmentSearchProducer` to Use `targetSearchIndexId`

When `targetSearchIndexId` is set on an attachment, the producer should use it directly instead of resolving via the project. This is the key integration point.

**Files:**

- Modify: `apps/multimodal-service/src/services/attachment-search-producer.ts`
- Test: `apps/multimodal-service/src/services/__tests__/attachment-search-producer.test.ts`

**Step 1:** Write the failing test. Create the test file:

```typescript
import { describe, test, expect, vi } from 'vitest';
import { AttachmentSearchProducer } from '../attachment-search-producer.js';
import type { IAttachment } from '@agent-platform/database';

function mockAttachment(overrides?: Partial<IAttachment>): IAttachment {
  return {
    _id: 'att-1',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'session-1',
    messageId: null,
    originalFilename: 'test.pdf',
    mimeType: 'application/pdf',
    detectedMimeType: null,
    category: 'document',
    sizeBytes: 1000,
    contentHash: 'abc',
    storageProvider: 'local',
    storageKey: 'tenant-1/project-1/session-1/att-1/original',
    storageBucket: 'attachments',
    encrypted: false,
    encryptionKeyVersion: 0,
    scanStatus: 'clean',
    scanEngine: 'clamav',
    scannedAt: new Date(),
    hasPII: false,
    exifStripped: false,
    processingStatus: 'completed',
    processedContent: 'Extracted PDF text content here.',
    processedContentHash: 'def',
    processingError: null,
    processingEngine: 'tika',
    processedAt: new Date(),
    resizedStorageKey: null,
    resizedSizeBytes: null,
    thumbnailStorageKey: null,
    imageDescription: null,
    imageDescriptionModel: null,
    searchIndexId: null,
    searchDocumentId: null,
    embeddingStatus: 'pending',
    embeddedAt: null,
    targetSearchIndexId: null,
    expiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    _v: 1,
  } as IAttachment;
}

// Mock the Attachment model
vi.mock('@agent-platform/database', () => ({
  Attachment: {
    findOneAndUpdate: vi.fn().mockResolvedValue(null),
  },
}));

describe('AttachmentSearchProducer', () => {
  test('uses targetSearchIndexId when set, skips resolver', async () => {
    const mockClient = {
      ingestDocument: vi.fn().mockResolvedValue({
        documentId: 'doc-1',
        title: 'test.pdf',
        chunkCount: 3,
      }),
    };
    const mockResolver = {
      resolveForProject: vi.fn().mockResolvedValue('project-index-1'),
    };

    const producer = new AttachmentSearchProducer({
      searchClient: mockClient as any,
      indexResolver: mockResolver,
    });

    const attachment = mockAttachment({
      targetSearchIndexId: 'kb-specific-index-99',
    });

    const result = await producer.ingest(attachment);

    expect(result.success).toBe(true);
    // Should NOT have called the project resolver
    expect(mockResolver.resolveForProject).not.toHaveBeenCalled();
    // Should have ingested into the target index
    expect(mockClient.ingestDocument).toHaveBeenCalledWith(
      'kb-specific-index-99',
      expect.objectContaining({ title: 'test.pdf' }),
    );
  });

  test('falls back to project resolver when targetSearchIndexId is null', async () => {
    const mockClient = {
      ingestDocument: vi.fn().mockResolvedValue({
        documentId: 'doc-1',
        title: 'test.pdf',
        chunkCount: 3,
      }),
    };
    const mockResolver = {
      resolveForProject: vi.fn().mockResolvedValue('project-default-index'),
    };

    const producer = new AttachmentSearchProducer({
      searchClient: mockClient as any,
      indexResolver: mockResolver,
    });

    const attachment = mockAttachment();

    const result = await producer.ingest(attachment);

    expect(result.success).toBe(true);
    expect(mockResolver.resolveForProject).toHaveBeenCalledWith('tenant-1', 'project-1');
    expect(mockClient.ingestDocument).toHaveBeenCalledWith(
      'project-default-index',
      expect.objectContaining({ title: 'test.pdf' }),
    );
  });
});
```

**Step 2:** Run test to verify it fails:

Run: `pnpm --filter multimodal-service test -- --run src/services/__tests__/attachment-search-producer.test.ts`
Expected: FAIL — `targetSearchIndexId` doesn't exist on IAttachment yet (or the test that checks resolver not called will fail because the current code always calls resolver)

**Step 3:** Modify `attachment-search-producer.ts`. Replace lines 108-123 (the index resolution block) with:

```typescript
// 2. Resolve search index — prefer targetSearchIndexId override, fall back to project resolver
let searchIndexId: string | null = null;

if (attachment.targetSearchIndexId) {
  searchIndexId = attachment.targetSearchIndexId;
  workerLog(WORKER_NAME, 'Using target search index override', {
    attachmentId,
    tenantId,
    searchIndexId,
  });
} else {
  searchIndexId = await this.indexResolver.resolveForProject(tenantId, projectId);
}

if (!searchIndexId) {
  workerLog(WORKER_NAME, 'No search index configured for project, skipping', {
    attachmentId,
    tenantId,
    projectId,
  });

  await Attachment.findOneAndUpdate(
    { _id: attachmentId, tenantId },
    { $set: { embeddingStatus: 'skipped' } },
  );

  return { success: true, skipped: true, reason: 'no_search_index' };
}
```

**Step 4:** Run test to verify it passes:

Run: `pnpm --filter multimodal-service test -- --run src/services/__tests__/attachment-search-producer.test.ts`
Expected: PASS

**Step 5:** Commit:

```bash
git add apps/multimodal-service/src/services/attachment-search-producer.ts apps/multimodal-service/src/services/__tests__/attachment-search-producer.test.ts
git commit -m "[ABLP-2] feat(multimodal): support targetSearchIndexId override in AttachmentSearchProducer"
```

---

## Task 3: Accept `targetSearchIndexId` in Upload Route

The upload route needs to read an optional `X-Search-Index-Id` header and pass it through to the Attachment record creation.

**Files:**

- Modify: `apps/multimodal-service/src/routes/attachments.ts`
- Modify: `apps/multimodal-service/src/services/multimodal-service.ts`
- Modify: `packages/shared/src/attachments/types.ts`

**Step 1:** Add `targetSearchIndexId` to `AttachmentInput` in `packages/shared/src/attachments/types.ts`. After line 20 (`channel: string;`), add:

```typescript
  /** Optional: target search index for KB-specific uploads */
  targetSearchIndexId?: string;
```

**Step 2:** In `apps/multimodal-service/src/services/multimodal-service.ts`, in the `upload()` method, add `targetSearchIndexId` to the `Attachment.create()` call at line 181. After line 218 (`expiresAt,`), add:

```typescript
      targetSearchIndexId: input.targetSearchIndexId ?? null,
```

**Step 3:** In `apps/multimodal-service/src/routes/attachments.ts`, in the POST handler (line 96-178), read the header and pass it through. After line 111 (`const channel = ...`), add:

```typescript
const targetSearchIndexId = req.headers['x-search-index-id'] as string | undefined;
```

Then in the `attachmentService.upload()` call (line 122-136), add `targetSearchIndexId` to the input object after `channel,`:

```typescript
            targetSearchIndexId,
```

**Step 4:** Build to verify types:

Run: `pnpm --filter @agent-platform/shared build && pnpm --filter multimodal-service build`
Expected: Build succeeds

**Step 5:** Commit:

```bash
git add packages/shared/src/attachments/types.ts apps/multimodal-service/src/routes/attachments.ts apps/multimodal-service/src/services/multimodal-service.ts
git commit -m "[ABLP-2] feat(multimodal): accept X-Search-Index-Id header in upload route"
```

---

## Task 4: Wire BullMQ Pipeline in `server.ts`

The multimodal-service `server.ts` currently has a placeholder `scanQueue = { add: async () => {} }`. Wire real BullMQ queues and workers so the pipeline actually executes.

**Files:**

- Modify: `apps/multimodal-service/src/server.ts`
- Test: `apps/multimodal-service/src/__tests__/server-bullmq.test.ts`

**Step 1:** Write the test first. Create `apps/multimodal-service/src/__tests__/server-bullmq.test.ts`:

```typescript
import { describe, test, expect, vi, beforeEach } from 'vitest';

// Mock BullMQ before any imports
vi.mock('bullmq', () => {
  const mockQueueAdd = vi.fn().mockResolvedValue({});
  const MockQueue = vi.fn().mockImplementation(() => ({
    add: mockQueueAdd,
    close: vi.fn().mockResolvedValue(undefined),
  }));
  const MockWorker = vi.fn().mockImplementation(() => ({
    close: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
  }));
  return { Queue: MockQueue, Worker: MockWorker };
});

// Mock database
vi.mock('@agent-platform/database', () => ({
  Attachment: {
    findOne: vi.fn(),
    findOneAndUpdate: vi.fn(),
    create: vi.fn(),
    deleteOne: vi.fn(),
    deleteMany: vi.fn(),
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          skip: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) }),
        }),
      }),
    }),
  },
  connectToMongoDB: vi.fn().mockResolvedValue(undefined),
}));

// Mock config
vi.mock('../config.js', () => ({
  getConfig: () => ({
    env: 'test',
    server: { port: 3006, host: '0.0.0.0' },
    storage: { provider: 'local', bucket: 'test', basePath: '/tmp/test' },
    cors: { origins: '*', credentials: true, methods: 'GET,POST', allowedHeaders: '*' },
    scan: { enabled: false },
    processing: { tikaUrl: 'http://localhost:9998', whisperUrl: 'http://localhost:8080' },
  }),
}));

describe('BullMQ pipeline wiring', () => {
  test('Queue and Worker constructors are importable from bullmq', async () => {
    const { Queue, Worker } = await import('bullmq');
    expect(Queue).toBeDefined();
    expect(Worker).toBeDefined();
  });

  test('createQueue creates a queue with correct name', async () => {
    const { createQueue } = await import('../jobs/queues.js');
    const queue = createQueue('test-queue');
    expect(queue).toBeDefined();
  });
});
```

**Step 2:** Run test to verify it passes (these are basic import tests):

Run: `pnpm --filter multimodal-service test -- --run src/__tests__/server-bullmq.test.ts`
Expected: PASS

**Step 3:** Modify `apps/multimodal-service/src/server.ts`. Replace the placeholder and add pipeline wiring:

Add imports at top (after existing imports):

```typescript
import { Worker } from 'bullmq';
import { connectToMongoDB } from '@agent-platform/database';
import { createQueue, createWorkerOptions, QUEUE_NAMES } from './jobs/queues.js';
import { createScanWorker } from './jobs/scan-job.js';
import { createValidateWorker } from './jobs/validate-job.js';
import { createProcessWorker } from './jobs/process-job.js';
import { createIndexWorker } from './jobs/index-job.js';
import { AttachmentSearchProducer } from './services/attachment-search-producer.js';
import { SearchAIClient } from '@agent-platform/search-ai-sdk';
import { TikaParser } from './processing/document-parser-tika.js';
import { ClamAVScanner } from './security/clamav-scanner.js';
```

Replace `wireAttachmentRoutes()` function (lines 74-92):

```typescript
/** Active workers for graceful shutdown */
const activeWorkers: Worker[] = [];
const activeQueues: ReturnType<typeof createQueue>[] = [];

/** Wire the attachment routes with real dependencies. Call once at startup. */
export function wireAttachmentRoutes(): void {
  if (attachmentRouterWired) return;
  const config = getConfigLazy();
  const storageProvider = createStorageProvider({
    provider: config.storage.provider,
    bucket: config.storage.bucket,
    region: config.storage.region,
    endpoint: config.storage.endpoint,
    basePath: config.storage.basePath,
  });

  // Create BullMQ queues
  const scanQueue = createQueue(QUEUE_NAMES.SCAN);
  const validateQueue = createQueue(QUEUE_NAMES.VALIDATE);
  const processQueue = createQueue(QUEUE_NAMES.PROCESS);
  const indexQueue = createQueue(QUEUE_NAMES.INDEX);
  activeQueues.push(scanQueue, validateQueue, processQueue, indexQueue);

  // AttachmentService uses scanQueue to enqueue the first pipeline stage
  const attachmentService = new AttachmentService({
    storageProvider,
    scanQueue,
    storageBucket: config.storage.bucket,
  });

  // Create processing dependencies
  const scanProvider = new ClamAVScanner({
    host: config.scan?.clamavHost || 'localhost',
    port: config.scan?.clamavPort || 3310,
  });
  const documentParser = new TikaParser({
    tikaUrl: config.processing?.tikaUrl || 'http://localhost:9998',
  });

  // Placeholder providers for image/audio/video (no-op for document-only flow)
  const imageProcessor = {
    process: async () => {
      throw new Error('Image processor not configured');
    },
  };
  const transcriptionProvider = {
    transcribe: async () => ({ success: false as const, error: 'Not configured', engine: 'none' }),
  };
  const videoProcessor = {
    extractAudio: async () => ({ success: false as const, error: 'Not configured' }),
    extractKeyFrames: async () => ({
      success: false as const,
      error: 'Not configured',
      totalFramesExtracted: 0,
      timestamps: [],
    }),
  };

  // Search AI client for the index worker
  const searchAIEngineUrl = process.env.SEARCH_AI_ENGINE_URL || 'http://localhost:3005';
  const searchClient = new SearchAIClient({ engineUrl: searchAIEngineUrl });
  const indexResolver = {
    resolveForProject: async (_tenantId: string, _projectId: string): Promise<string | null> => {
      // For KB-targeted uploads, targetSearchIndexId is used directly.
      // This resolver is a fallback for non-KB uploads (e.g. chat attachments).
      // TODO: Implement project-level default index resolution
      return null;
    },
  };
  const searchProducer = new AttachmentSearchProducer({ searchClient, indexResolver });

  // Create BullMQ workers
  const workerOpts = createWorkerOptions(5);

  const scanWorker = new Worker(
    QUEUE_NAMES.SCAN,
    createScanWorker({ storageProvider, scanProvider, validateQueue }),
    workerOpts,
  );
  const validateWorker = new Worker(
    QUEUE_NAMES.VALIDATE,
    createValidateWorker({ storageProvider, processQueue }),
    workerOpts,
  );
  const processWorker = new Worker(
    QUEUE_NAMES.PROCESS,
    createProcessWorker({
      storageProvider,
      imageProcessor: imageProcessor as any,
      documentParser,
      transcriptionProvider: transcriptionProvider as any,
      videoProcessor: videoProcessor as any,
      indexQueue,
    }),
    workerOpts,
  );
  const indexWorker = new Worker(
    QUEUE_NAMES.INDEX,
    createIndexWorker({ searchProducer }),
    workerOpts,
  );

  activeWorkers.push(scanWorker, validateWorker, processWorker, indexWorker);

  // Log worker errors
  for (const worker of activeWorkers) {
    worker.on('failed', (job, err) => {
      console.error(`[multimodal-service] Worker job failed: ${job?.name}`, err.message);
    });
  }

  app.use('/internal/attachments', createAttachmentRouter(attachmentService));
  attachmentRouterWired = true;
}
```

In `startServer()` (line 122), add MongoDB connection before wiring routes. Replace:

```typescript
// ─── Database Initialization (MongoDB) ──────────────────────────────────
// (Will be wired in later tasks when routes need DB)
```

With:

```typescript
// ─── Database Initialization (MongoDB) ──────────────────────────────────
const mongoUrl =
  process.env.MULTIMODAL_MONGO_URL ||
  process.env.MONGODB_URI ||
  'mongodb://localhost:27017/abl-platform';
await connectToMongoDB(mongoUrl);
console.log('[multimodal-service] Connected to MongoDB');
```

In `shutdown()` (line 148), add worker/queue cleanup before `server.close`:

```typescript
// Close BullMQ workers and queues
for (const worker of activeWorkers) {
  await worker
    .close()
    .catch((err) => console.error('[multimodal-service] Worker close error:', err));
}
for (const queue of activeQueues) {
  await queue.close().catch((err) => console.error('[multimodal-service] Queue close error:', err));
}
```

**Step 4:** Build to verify:

Run: `pnpm --filter multimodal-service build`
Expected: Build succeeds

**Step 5:** Commit:

```bash
git add apps/multimodal-service/src/server.ts apps/multimodal-service/src/__tests__/server-bullmq.test.ts
git commit -m "[ABLP-2] feat(multimodal): wire BullMQ pipeline (scan → validate → process → index)"
```

---

## Task 5: Create Studio API Upload Route

Create a new Next.js API route that accepts file uploads from the Studio UI and proxies them to the multimodal-service.

**Files:**

- Create: `apps/studio/src/app/api/search-ai/indexes/[id]/upload/route.ts`
- Modify: `apps/studio/src/lib/search-ai-proxy.ts`

**Step 1:** Add `proxyToMultimodalService` to `apps/studio/src/lib/search-ai-proxy.ts`. After the `SEARCH_AI_RUNTIME_URL` constant (line 15), add:

```typescript
const MULTIMODAL_SERVICE_URL = process.env.MULTIMODAL_SERVICE_URL || 'http://localhost:3006';
```

After the `proxyToSearchRuntime` function (line 39), add:

```typescript
/**
 * Proxy a multipart file upload to the multimodal service.
 * Unlike proxyToSearchEngine/Runtime, this forwards raw body (not JSON).
 */
export async function proxyFileUploadToMultimodal(
  request: NextRequest,
  opts: { tenantId: string; projectId: string; searchIndexId: string; sessionId: string },
): Promise<NextResponse> {
  const headers: Record<string, string> = {
    'X-Tenant-Id': opts.tenantId,
    'X-Project-Id': opts.projectId,
    'X-Search-Index-Id': opts.searchIndexId,
  };
  const auth = request.headers.get('Authorization');
  if (auth) headers['Authorization'] = auth;

  try {
    // Forward the raw request body (multipart/form-data) to multimodal-service.
    // We need to re-build the FormData because Next.js consumes the stream.
    const formData = await request.formData();
    const file = formData.get('file');
    if (!file || !(file instanceof Blob)) {
      return NextResponse.json(
        { success: false, error: { code: 'MISSING_FILE', message: 'No file provided' } },
        { status: 400 },
      );
    }

    // Build a new FormData for the downstream request
    const downstreamForm = new FormData();
    downstreamForm.append('file', file);
    downstreamForm.append('sessionId', opts.sessionId);
    downstreamForm.append('channel', 'studio-kb-upload');

    const response = await fetch(`${MULTIMODAL_SERVICE_URL}/internal/attachments`, {
      method: 'POST',
      headers, // Note: do NOT set Content-Type — fetch sets it with boundary for FormData
      body: downstreamForm,
    });

    // Remove Content-Type from headers so FormData boundary is preserved
    // (fetch auto-sets it when body is FormData)
    delete headers['Content-Type'];

    const data = await response.json();
    return NextResponse.json(data, { status: response.status });
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown error';
    console.error(`[SearchAI Proxy] Multimodal service unreachable:`, message);
    return NextResponse.json(
      {
        success: false,
        error: {
          code: 'SERVICE_UNAVAILABLE',
          message: 'Multimodal service is not available. Please ensure it is running.',
        },
      },
      { status: 503 },
    );
  }
}
```

**Step 2:** Create the upload route at `apps/studio/src/app/api/search-ai/indexes/[id]/upload/route.ts`:

```typescript
/**
 * POST /api/search-ai/indexes/:id/upload — Upload a file for KB ingestion
 *
 * Accepts multipart/form-data with a 'file' field.
 * Proxies to multimodal-service with X-Search-Index-Id header.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireAuth, isAuthError } from '@/lib/auth';
import { proxyFileUploadToMultimodal } from '@/lib/search-ai-proxy';
import crypto from 'crypto';

type Ctx = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, { params }: Ctx) {
  const user = await requireAuth(request);
  if (isAuthError(user)) return user;
  const { id: indexId } = await params;

  // Generate a synthetic sessionId for KB uploads (not tied to a chat session)
  const sessionId = `kb-upload-${crypto.randomUUID()}`;

  return proxyFileUploadToMultimodal(request, {
    tenantId: user.tenantId,
    projectId: user.projectId ?? '',
    searchIndexId: indexId,
    sessionId,
  });
}
```

**Step 3:** Build to verify:

Run: `pnpm --filter studio build`
Expected: Build succeeds (or at least TypeScript compiles — full Next.js build may require running services)

**Step 4:** Commit:

```bash
git add apps/studio/src/app/api/search-ai/indexes/\[id\]/upload/route.ts apps/studio/src/lib/search-ai-proxy.ts
git commit -m "[ABLP-2] feat(studio): add file upload proxy route for KB document ingestion"
```

---

## Task 6: Add `uploadDocumentFile` to Studio API Client

Add the client-side API function that ConnectorsTab will call to upload files.

**Files:**

- Modify: `apps/studio/src/api/search-ai.ts`

**Step 1:** Add the function at the end of the Documents API section (after `deleteDocument`, before the Schema API section):

```typescript
/**
 * Upload a file (PDF, DOCX, TXT, etc.) to a search index via the multimodal pipeline.
 * Returns immediately with an attachmentId — processing is async.
 */
export async function uploadDocumentFile(
  indexId: string,
  file: File,
): Promise<{
  success: boolean;
  data?: { attachmentId: string; status: string };
  error?: { code: string; message: string };
}> {
  const formData = new FormData();
  formData.append('file', file);

  const response = await fetch(`/api/search-ai/indexes/${encodeURIComponent(indexId)}/upload`, {
    method: 'POST',
    body: formData,
    // Note: do NOT set Content-Type — browser sets it with boundary for FormData
  });

  return response.json();
}
```

**Step 2:** Build to verify:

Run: `pnpm --filter studio build`
Expected: Build succeeds

**Step 3:** Commit:

```bash
git add apps/studio/src/api/search-ai.ts
git commit -m "[ABLP-2] feat(studio): add uploadDocumentFile API client function"
```

---

## Task 7: Replace File Connector Config Form with Drag-and-Drop Upload

Replace the existing `fileTypes` + `maxFileSize` config form in ConnectorsTab with a real file upload zone.

**Files:**

- Modify: `apps/studio/src/components/search-ai/ConnectorsTab.tsx`
- Modify: `packages/i18n/locales/en/studio.json`

**Step 1:** Add new i18n keys. In `packages/i18n/locales/en/studio.json`, in the `search_ai.connectors` section (after `"max_file_size_placeholder": "e.g. 50"` on line 3749), add:

```json
      "drop_zone_label": "Drop files here or click to browse",
      "drop_zone_hint": "Supports PDF, DOCX, TXT, MD, HTML, CSV (max 50 MB per file)",
      "drop_zone_dragging": "Drop files to upload",
      "uploading_files": "Uploading {count} file(s)...",
      "upload_success": "{count} file(s) uploaded — processing will begin shortly",
      "upload_error": "Failed to upload: {error}",
      "upload_file_too_large": "File \"{name}\" exceeds 50 MB limit",
      "upload_invalid_type": "File \"{name}\" has unsupported type",
```

**Step 2:** Modify `ConnectorsTab.tsx`. Add the import for the upload function:

```typescript
import { addSource, deleteSource, uploadDocumentFile } from '../../api/search-ai';
```

**Step 3:** Replace the `fileTypes` and `maxFileSize` state variables (lines 100-101) with:

```typescript
// File upload state
const [filesToUpload, setFilesToUpload] = useState<File[]>([]);
const [isDragging, setIsDragging] = useState(false);
const [uploadProgress, setUploadProgress] = useState<
  Record<string, 'pending' | 'uploading' | 'done' | 'error'>
>({});
```

**Step 4:** Add accepted MIME types constant after the `HTTP_METHODS` constant (line 48):

```typescript
const ACCEPTED_FILE_TYPES = [
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'text/plain',
  'text/markdown',
  'text/html',
  'text/csv',
];
const ACCEPTED_EXTENSIONS = '.pdf,.docx,.txt,.md,.html,.csv';
const MAX_FILE_SIZE_BYTES = 50 * 1024 * 1024; // 50 MB
```

**Step 5:** Replace `buildSourceConfig()` case for `'file'` (lines 158-162) with:

```typescript
      case 'file':
        return {
          uploadedFiles: filesToUpload.map((f) => f.name),
          fileCount: filesToUpload.length,
        };
```

**Step 6:** Replace `validateConfig()` case for file (remove the empty break at line 191-192, it's already permissive). After the `if (!name.trim())` check, add a file-specific check:

```typescript
if (selectedType === 'file' && filesToUpload.length === 0) {
  return 'At least one file is required';
}
```

**Step 7:** Replace `handleAdd` to upload files first for the file connector type. Replace the entire function (lines 205-232):

```typescript
const handleAdd = async () => {
  const validationError = validateConfig();
  if (validationError) {
    setError(validationError);
    return;
  }

  setLoading(true);
  setError(null);

  try {
    // 1. Create the source record
    await addSource(indexId, {
      name: name.trim(),
      sourceType: selectedType!,
      sourceConfig: buildSourceConfig(),
    });

    // 2. For file connectors, upload each file
    if (selectedType === 'file' && filesToUpload.length > 0) {
      const progress: Record<string, 'pending' | 'uploading' | 'done' | 'error'> = {};
      filesToUpload.forEach((f) => {
        progress[f.name] = 'uploading';
      });
      setUploadProgress(progress);

      const errors: string[] = [];
      for (const file of filesToUpload) {
        try {
          const result = await uploadDocumentFile(indexId, file);
          if (result.success) {
            progress[file.name] = 'done';
          } else {
            progress[file.name] = 'error';
            errors.push(`${file.name}: ${result.error?.message || 'Upload failed'}`);
          }
          setUploadProgress({ ...progress });
        } catch (err) {
          progress[file.name] = 'error';
          errors.push(`${file.name}: ${err instanceof Error ? err.message : 'Upload failed'}`);
          setUploadProgress({ ...progress });
        }
      }

      if (errors.length > 0) {
        toast.error(t('upload_error', { error: errors.join(', ') }));
      } else {
        toast.success(t('upload_success', { count: String(filesToUpload.length) }));
      }
    } else {
      toast.success(t('toast_added'));
    }

    setAddOpen(false);
    resetForm();
    onRefresh();
  } catch (err) {
    const msg = err instanceof Error ? err.message : t('error_add_failed');
    setError(msg);
    toast.error(msg);
  } finally {
    setLoading(false);
  }
};
```

**Step 8:** In `resetForm()`, replace `setFileTypes('')` and `setMaxFileSize('')` with:

```typescript
setFilesToUpload([]);
setIsDragging(false);
setUploadProgress({});
```

**Step 9:** Replace the `renderConfigForm()` case for `'file'` (lines 311-327) with the drag-and-drop zone:

```typescript
      case 'file':
        return (
          <div className="space-y-3">
            {/* Drop zone */}
            <div
              onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
              onDragLeave={() => setIsDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setIsDragging(false);
                const dropped = Array.from(e.dataTransfer.files).filter((f) => {
                  if (f.size > MAX_FILE_SIZE_BYTES) {
                    toast.error(t('upload_file_too_large', { name: f.name }));
                    return false;
                  }
                  if (!ACCEPTED_FILE_TYPES.includes(f.type) && !f.name.match(/\.(pdf|docx|txt|md|html|csv)$/i)) {
                    toast.error(t('upload_invalid_type', { name: f.name }));
                    return false;
                  }
                  return true;
                });
                setFilesToUpload((prev) => [...prev, ...dropped]);
              }}
              className={clsx(
                'relative flex flex-col items-center justify-center gap-2 p-8 rounded-xl border-2 border-dashed transition-default cursor-pointer',
                isDragging
                  ? 'border-accent bg-accent-subtle'
                  : 'border-default bg-background-subtle hover:border-accent hover:bg-background-muted',
              )}
            >
              <input
                type="file"
                multiple
                accept={ACCEPTED_EXTENSIONS}
                onChange={(e) => {
                  const selected = Array.from(e.target.files || []).filter((f) => {
                    if (f.size > MAX_FILE_SIZE_BYTES) {
                      toast.error(t('upload_file_too_large', { name: f.name }));
                      return false;
                    }
                    return true;
                  });
                  setFilesToUpload((prev) => [...prev, ...selected]);
                  e.target.value = ''; // Reset to allow re-selecting same file
                }}
                className="absolute inset-0 opacity-0 cursor-pointer"
              />
              <Upload className="w-8 h-8 text-muted" />
              <p className="text-sm font-medium text-foreground">
                {isDragging ? t('drop_zone_dragging') : t('drop_zone_label')}
              </p>
              <p className="text-xs text-muted">{t('drop_zone_hint')}</p>
            </div>

            {/* File list */}
            {filesToUpload.length > 0 && (
              <div className="space-y-1.5">
                {filesToUpload.map((file, i) => (
                  <div key={`${file.name}-${i}`} className="flex items-center justify-between gap-2 px-3 py-2 rounded-lg bg-background-muted text-sm">
                    <span className="truncate text-foreground">{file.name}</span>
                    <div className="flex items-center gap-2">
                      <span className="text-xs text-muted">{(file.size / 1024 / 1024).toFixed(1)} MB</span>
                      {uploadProgress[file.name] && (
                        <Badge variant={uploadProgress[file.name] === 'done' ? 'success' : uploadProgress[file.name] === 'error' ? 'error' : 'info'}>
                          {uploadProgress[file.name]}
                        </Badge>
                      )}
                      {!uploadProgress[file.name] && (
                        <button
                          type="button"
                          onClick={() => setFilesToUpload((prev) => prev.filter((_, j) => j !== i))}
                          className="p-0.5 text-muted hover:text-error transition-default"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        );
```

**Step 10:** Add `clsx` import if not already present (it's already imported in the current file — verify).

**Step 11:** Build to verify:

Run: `pnpm --filter studio build`
Expected: Build succeeds

**Step 12:** Commit:

```bash
git add apps/studio/src/components/search-ai/ConnectorsTab.tsx packages/i18n/locales/en/studio.json
git commit -m "[ABLP-2] feat(studio): replace file connector config with drag-and-drop upload zone"
```

---

## Task 8: Make `sessionId` Optional for KB Uploads

Currently the multimodal-service upload route requires `sessionId`. For KB uploads initiated from Studio (not from a chat session), we need to make it optional and generate a synthetic one.

**Files:**

- Modify: `apps/multimodal-service/src/routes/attachments.ts`

**Step 1:** In the POST handler (lines 113-119), replace the `sessionId` requirement:

```typescript
// sessionId is optional for KB uploads — generate a synthetic one if not provided
const sessionId = (req.body.sessionId as string | undefined) || `kb-upload-${Date.now()}`;
```

Remove the `if (!sessionId)` validation block (lines 113-119).

**Step 2:** Build to verify:

Run: `pnpm --filter multimodal-service build`
Expected: Build succeeds

**Step 3:** Commit:

```bash
git add apps/multimodal-service/src/routes/attachments.ts
git commit -m "[ABLP-2] feat(multimodal): make sessionId optional for KB file uploads"
```

---

## Task 9: Skip ClamAV Scan When Not Configured

In development, ClamAV is typically not running. The scan worker should gracefully skip scanning when `SCAN_ENABLED=false` and advance the pipeline directly to validate.

**Files:**

- Modify: `apps/multimodal-service/src/server.ts`

**Step 1:** In the `wireAttachmentRoutes()` function, after creating the scan provider, add a bypass mode. Replace the scan provider creation with:

```typescript
// Scan provider — skip ClamAV in dev if not configured
const scanEnabled = config.scan?.enabled !== false;
const scanProvider = scanEnabled
  ? new ClamAVScanner({
      host: config.scan?.clamavHost || 'localhost',
      port: config.scan?.clamavPort || 3310,
    })
  : {
      name: 'skip',
      scan: async () => ({ status: 'clean' as const, engine: 'skip', scannedAt: new Date() }),
    };
```

**Step 2:** Build to verify:

Run: `pnpm --filter multimodal-service build`
Expected: Build succeeds

**Step 3:** Commit:

```bash
git add apps/multimodal-service/src/server.ts
git commit -m "[ABLP-2] feat(multimodal): skip ClamAV scan when SCAN_ENABLED=false"
```

---

## Dependency Graph

```
Task 1 (Attachment model field)
  ↓
Task 2 (AttachmentSearchProducer override) — depends on Task 1
  ↓
Task 3 (Upload route reads header) — depends on Task 1
  ↓
Task 4 (BullMQ wiring) — depends on Task 2
  ↓
Task 5 (Studio API route) — independent of Task 4
Task 6 (API client function) — independent of Task 4
  ↓
Task 7 (ConnectorsTab UI) — depends on Task 6
  ↓
Task 8 (sessionId optional) — independent
Task 9 (ClamAV skip) — independent
```

Tasks 5+6 can run in parallel with Task 4. Tasks 8+9 are independent polish tasks.
