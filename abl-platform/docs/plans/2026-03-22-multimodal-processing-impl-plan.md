# LLD + Implementation Plan: Multimodal Processing

> **Feature ID:** #40
> **Status:** PLANNED
> **Last Updated:** 2026-03-22
> **Feature Spec:** `docs/features/multimodal-processing.md`
> **Test Spec:** `docs/testing/multimodal-processing.md`
> **HLD:** `docs/specs/multimodal-processing.hld.md`

---

## Implementation Overview

This plan implements the multimodal processing feature in 5 phases, building from foundational validation through to full audio/video support. Each phase has clear exit criteria and is independently deployable.

**Total estimated effort:** 8-12 developer days across 5 phases.

---

## Phase 1: Upload Validation and Tenant Config Enforcement (P0)

**Objective:** Ensure all file uploads are validated against tenant configuration before any processing begins.

**Duration:** 1-2 days

### 1.1 Tasks

#### Task 1.1.1: Upload Validation Middleware

**File:** `apps/search-ai/src/middleware/upload-validator.ts` (new)

**Implementation:**

Create Express middleware that validates incoming multipart uploads against `TenantAttachmentConfig`:

1. Load tenant config: `TenantAttachmentConfig.findOne({ tenantId })` with fallback to platform defaults.
2. Check file size against `maxFileSizeBytes`.
3. Detect MIME type via `file-type` package (magic bytes, not extension).
4. Check detected MIME against `blockedMimeTypes` (reject if match) and `allowedMimeTypes` (reject if non-empty and no match).
5. Check per-session attachment count against `maxAttachmentsPerSession`.
6. Return HTTP 400/413 with `{ success: false, error: { code, message } }` on failure.

**Platform defaults (when no TenantAttachmentConfig exists):**

```typescript
const PLATFORM_DEFAULTS = {
  maxFileSizeBytes: 20 * 1024 * 1024, // 20 MB
  allowedMimeTypes: [], // Allow all
  blockedMimeTypes: [], // Block none
  scanEnabled: true,
  processingEnabled: true,
  embeddingEnabled: true,
  maxAttachmentsPerSession: 100,
  maxTotalStorageBytes: 1024 * 1024 * 1024, // 1 GB
  retentionDays: { image: 90, document: 90, audio: 90, video: 90 },
};
```

**Error codes:**

- `FILE_TOO_LARGE` -- File exceeds `maxFileSizeBytes`
- `BLOCKED_MIME_TYPE` -- MIME type in block list
- `DISALLOWED_MIME_TYPE` -- MIME type not in allow list
- `SESSION_ATTACHMENT_LIMIT` -- Per-session limit exceeded
- `STORAGE_QUOTA_EXCEEDED` -- Tenant storage quota exceeded

#### Task 1.1.2: Content Category Classifier

**File:** `apps/search-ai/src/services/multimodal/content-classifier.ts` (new)

**Implementation:**

Map detected MIME types to content categories:

```typescript
export function classifyContent(mimeType: string): 'image' | 'document' | 'audio' | 'video' {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('audio/')) return 'audio';
  if (mimeType.startsWith('video/')) return 'video';
  // Documents: PDF, Office formats, HTML, Markdown, plain text
  return 'document';
}
```

#### Task 1.1.3: Wire Validation into Existing Upload Routes

**Files:**

- `apps/search-ai/src/routes/indexes.ts` -- Document upload route
- `apps/runtime/src/routes/attachments.ts` -- Attachment upload route (if exists)

**Changes:**

- Add `uploadValidator` middleware before the upload handler.
- Pass validated category to the downstream processing logic.

#### Task 1.1.4: Unit Tests for Validation

**File:** `apps/search-ai/src/__tests__/upload-validator.test.ts` (new)

**Tests:**

- UT-1: MIME type validation (accept/reject scenarios)
- UT-3: File size validation (at limit, over limit, under limit)
- Content category classification for all supported types
- Platform defaults applied when no tenant config exists

### 1.2 Exit Criteria

- [ ] Upload validator middleware created and wired into routes.
- [ ] MIME type detection uses magic bytes (not extension).
- [ ] Blocked MIME types are rejected with HTTP 400.
- [ ] File size limits are enforced with HTTP 413.
- [ ] Platform defaults applied when `TenantAttachmentConfig` is absent.
- [ ] Unit tests pass for all validation scenarios.
- [ ] `pnpm build --filter=search-ai` succeeds with no type errors.

---

## Phase 2: Attachment-to-Search Bridge (P0)

**Objective:** Bridge processed attachments from runtime conversations into the SearchAI ingestion pipeline for embedding and search.

**Duration:** 2-3 days

### 2.1 Tasks

#### Task 2.1.1: Attachment Bridge Service

**File:** `apps/search-ai/src/services/multimodal/attachment-bridge.ts` (new)

**Implementation:**

```typescript
export class AttachmentBridgeService {
  /**
   * Bridge a completed attachment into the SearchAI pipeline.
   *
   * 1. Check tenant embedding config
   * 2. Deduplicate by contentHash
   * 3. Create SearchDocument
   * 4. Update Attachment with searchDocumentId
   * 5. Enqueue for chunking and embedding
   */
  async bridgeAttachment(attachment: IAttachment): Promise<{
    searchDocumentId: string;
    deduplicated: boolean;
  }>;
}
```

**Key logic:**

- Load `TenantAttachmentConfig` for the attachment's tenant. Skip if `embeddingEnabled === false`.
- Check `SearchDocument.findOne({ indexId, contentHash: attachment.contentHash })` for dedup.
- If no duplicate, create new `SearchDocument` with `extractedText = attachment.processedContent`.
- Update `Attachment` with `searchDocumentId`, `searchIndexId`, `embeddingStatus: 'processing'`.
- Enqueue to the ingestion pipeline for chunking and embedding.

#### Task 2.1.2: Attachment Bridge Worker

**File:** `apps/search-ai/src/workers/attachment-bridge-worker.ts` (new)

**Implementation:**

BullMQ worker consuming from `search-attachment-bridge` queue.

**Job data:**

```typescript
interface AttachmentBridgeJobData {
  attachmentId: string;
  tenantId: string;
  projectId: string;
}
```

**Processing:**

1. Load attachment by `{ _id: attachmentId, tenantId }`.
2. Verify `processingStatus === 'completed'` and `processedContent` is non-null.
3. Call `AttachmentBridgeService.bridgeAttachment()`.
4. Emit `TraceEvent` for bridge completion.

#### Task 2.1.3: Queue Constants

**File:** `packages/search-ai-sdk/src/constants.ts` (modify)

**Add:**

```typescript
export const QUEUE_ATTACHMENT_BRIDGE = 'search-attachment-bridge';
export const QUEUE_AUDIO_TRANSCRIPTION = 'search-audio-transcription';
export const QUEUE_VIDEO_PROCESSING = 'search-video-processing';
```

#### Task 2.1.4: Register Worker

**File:** `apps/search-ai/src/workers/index.ts` (modify)

**Add:** Import and register `AttachmentBridgeWorker` in the worker registry.

#### Task 2.1.5: Update MAX_QUEUE_DEPTH

**File:** `apps/search-ai/src/services/pipeline-orchestration/types.ts` (modify)

**Add:**

```typescript
'search-attachment-bridge': 500,
'search-audio-transcription': 200,
'search-video-processing': 100,
```

#### Task 2.1.6: Integration Test -- Attachment Bridge

**File:** `apps/search-ai/src/__tests__/integration/attachment-bridge.test.ts` (new)

**Tests:**

- INT-4: Processing status transition and SearchDocument creation.
- Deduplication when same content hash exists.
- Skip when `embeddingEnabled === false`.
- Correct `tenantId` isolation.

### 2.2 Exit Criteria

- [ ] `AttachmentBridgeService` creates SearchDocument from completed attachment.
- [ ] Deduplication by `contentHash` prevents duplicate SearchDocuments.
- [ ] Tenant `embeddingEnabled` flag is respected.
- [ ] Worker registered and consuming from `search-attachment-bridge` queue.
- [ ] Queue constants added to `search-ai-sdk`.
- [ ] Integration tests pass.
- [ ] `pnpm build` succeeds across affected packages.

---

## Phase 3: Audio Transcription Worker (P1)

**Objective:** Transcribe audio files to searchable text via a configurable transcription provider.

**Duration:** 2-3 days

### 3.1 Tasks

#### Task 3.1.1: Transcription Provider Interface

**File:** `apps/search-ai/src/services/transcription/types.ts` (new)

```typescript
export interface TranscriptionSegment {
  start: number; // seconds
  end: number; // seconds
  text: string;
  speaker?: string; // speaker label (if diarization enabled)
  confidence?: number;
}

export interface TranscriptionResult {
  transcript: string;
  segments: TranscriptionSegment[];
  language: string;
  confidence: number;
  durationSeconds: number;
  provider: string;
  model: string;
  tokensUsed?: number;
  costUsd?: number;
}

export interface TranscriptionProvider {
  name: string;
  transcribe(
    audioBuffer: Buffer,
    options: {
      language?: string;
      enableDiarization?: boolean;
    },
  ): Promise<TranscriptionResult>;
  healthCheck(): Promise<{ ok: boolean; latencyMs: number }>;
}
```

#### Task 3.1.2: Whisper API Provider

**File:** `apps/search-ai/src/services/transcription/whisper-api-provider.ts` (new)

**Implementation:**

- Uses OpenAI Whisper API (`POST /v1/audio/transcriptions`).
- Sends audio as multipart form data.
- Supports language hint and response format (`verbose_json` for segments).
- Handles rate limiting with retry.

#### Task 3.1.3: Whisper Local Provider

**File:** `apps/search-ai/src/services/transcription/whisper-local-provider.ts` (new)

**Implementation:**

- Calls self-hosted Whisper service via HTTP.
- Same interface as API provider.
- Configurable `baseUrl` (default: `http://localhost:8004`).

#### Task 3.1.4: Audio Transcription Worker

**File:** `apps/search-ai/src/workers/audio-transcription-worker.ts` (new)

**Implementation:**

1. Consume from `search-audio-transcription` queue.
2. Load attachment by `{ _id: attachmentId, tenantId }`.
3. Download audio from S3 using `storageKey`.
4. Select transcription provider based on config.
5. Transcribe audio.
6. Update `Attachment.processedContent` with transcript.
7. Update `Attachment.processingStatus` to `'completed'`.
8. Enqueue to `search-attachment-bridge` for embedding.
9. Emit `TraceEvent`s.

**Error handling:**

- Retry 3x with exponential backoff.
- On final failure, set `processingStatus: 'failed'` and `processingError`.

#### Task 3.1.5: Register Worker and Wire Queue

**Files:**

- `apps/search-ai/src/workers/index.ts` -- Register worker.
- `apps/search-ai/src/queues/index.ts` -- Register queue.
- `apps/search-ai/src/queues/queue-factory.ts` -- Add queue creation.

#### Task 3.1.6: Content Router Integration

**File:** `apps/search-ai/src/services/multimodal/content-classifier.ts` (modify)

**Add:** When category is `'audio'`, enqueue to `search-audio-transcription` instead of document pipeline.

#### Task 3.1.7: Unit + Integration Tests

**Files:**

- `apps/search-ai/src/__tests__/transcription-provider.test.ts` -- Unit tests for provider logic.
- `apps/search-ai/src/__tests__/integration/audio-transcription.test.ts` -- Integration test with HTTP stub.

### 3.2 Exit Criteria

- [ ] `TranscriptionProvider` interface defined with `WhisperAPIProvider` and `WhisperLocalProvider`.
- [ ] Audio transcription worker processes jobs from queue.
- [ ] Transcribed text stored as `processedContent`.
- [ ] Attachment bridges to SearchAI pipeline after transcription.
- [ ] Provider health check implemented.
- [ ] Unit and integration tests pass.
- [ ] `pnpm build` succeeds.

---

## Phase 4: Video Processing Worker (P1)

**Objective:** Process video files by extracting audio for transcription and sampling key frames for visual analysis.

**Duration:** 2-3 days

### 4.1 Tasks

#### Task 4.1.1: FFmpeg Service

**File:** `apps/search-ai/src/services/video/ffmpeg-service.ts` (new)

**Implementation:**

```typescript
export class FFmpegService {
  /** Extract audio track from video as WAV buffer */
  async extractAudio(videoPath: string): Promise<Buffer>;

  /** Sample key frames at interval (seconds) */
  async sampleKeyFrames(videoPath: string, intervalSeconds: number): Promise<Buffer[]>;

  /** Get video metadata (duration, resolution, codec) */
  async getMetadata(videoPath: string): Promise<VideoMetadata>;
}
```

Uses `child_process.execFile` with `ffmpeg` and `ffprobe` binaries. Input validated (file existence, size, format) before execution.

#### Task 4.1.2: Video Processing Worker

**File:** `apps/search-ai/src/workers/video-processing-worker.ts` (new)

**Implementation:**

1. Consume from `search-video-processing` queue.
2. Load attachment by `{ _id: attachmentId, tenantId }`.
3. Download video from S3 to temp directory.
4. Extract audio track via `FFmpegService.extractAudio()`.
5. Transcribe audio (call transcription provider directly or enqueue to audio queue).
6. Sample key frames via `FFmpegService.sampleKeyFrames()`.
7. Analyze key frames via `VisionService` (existing).
8. Combine transcript + frame descriptions into `processedContent`.
9. Update attachment and trigger bridge.
10. Clean up temp files.

**Key frame analysis format:**

```
[00:00:30] Frame 1: Description of what is visible...
[00:01:00] Frame 2: Description of what is visible...
...
```

**Combined processedContent format:**

```
## Transcript
[Full transcript with timestamps]

## Visual Summary
[Key frame descriptions with timestamps]
```

#### Task 4.1.3: Dockerfile Update

**File:** `apps/search-ai/Dockerfile` (modify)

**Add:** Install `ffmpeg` package in the Docker image.

```dockerfile
RUN apt-get update && apt-get install -y ffmpeg && rm -rf /var/lib/apt/lists/*
```

#### Task 4.1.4: Docker Compose Update

**File:** `docker-compose.yml` (modify)

**No changes needed** -- video processing runs within the search-ai service; FFmpeg is installed in the Docker image.

#### Task 4.1.5: Register Worker and Wire Queue

Same pattern as Phase 3.

#### Task 4.1.6: Integration Tests

**File:** `apps/search-ai/src/__tests__/integration/video-processing.test.ts` (new)

**Tests:**

- Video metadata extraction.
- Audio extraction and transcription flow.
- Key frame sampling and analysis.
- Combined processedContent generation.
- Temp file cleanup on success and failure.

### 4.2 Exit Criteria

- [ ] `FFmpegService` extracts audio and samples key frames.
- [ ] Video processing worker combines transcript + visual descriptions.
- [ ] Temp files cleaned up after processing (success and failure paths).
- [ ] FFmpeg installed in Docker image.
- [ ] Integration tests pass.
- [ ] `pnpm build` succeeds.

---

## Phase 5: Observability, Cost Tracking, and Progress Events (P0)

**Objective:** Add unified observability, cost tracking, and real-time progress events across all multimodal processing stages.

**Duration:** 1-2 days

### 5.1 Tasks

#### Task 5.1.1: Multimodal TraceEvent Types

**File:** `packages/observatory/src/trace-events/multimodal-events.ts` (new)

**Implementation:**

Define TraceEvent types for all multimodal processing stages:

```typescript
export type MultimodalTraceEventType =
  | 'multimodal.upload.validated'
  | 'multimodal.extraction.start'
  | 'multimodal.extraction.complete'
  | 'multimodal.extraction.error'
  | 'multimodal.vision.start'
  | 'multimodal.vision.complete'
  | 'multimodal.vision.error'
  | 'multimodal.transcription.start'
  | 'multimodal.transcription.complete'
  | 'multimodal.transcription.error'
  | 'multimodal.video.start'
  | 'multimodal.video.complete'
  | 'multimodal.video.error'
  | 'multimodal.bridge.start'
  | 'multimodal.bridge.complete'
  | 'multimodal.bridge.deduplicated';
```

#### Task 5.1.2: Cost Aggregation Service

**File:** `apps/search-ai/src/services/multimodal/cost-tracker.ts` (new)

**Implementation:**

```typescript
export class MultimodalCostTracker {
  /** Record cost for a processing operation */
  recordCost(params: {
    tenantId: string;
    indexId: string;
    documentId: string;
    stage: 'vision' | 'transcription' | 'embedding';
    provider: string;
    model: string;
    tokensUsed: number;
    costUsd: number;
  }): void;

  /** Get aggregate cost for a document */
  getDocumentCost(documentId: string): Promise<{
    totalCostUsd: number;
    byStage: Record<string, number>;
  }>;
}
```

Stores cost data in `SearchChunkMetadata.totalCost` and `SearchChunkMetadata.totalTokens`.

#### Task 5.1.3: SSE Progress Events

**File:** `apps/search-ai/src/routes/progress.ts` (modify, existing)

**Add:** Emit progress events for multimodal processing stages:

```typescript
publishProgressEvent({
  type: 'multimodal_processing',
  indexId,
  documentId,
  stage: 'extraction' | 'vision' | 'transcription' | 'embedding',
  progress: 0-100,
  details: { pagesProcessed, totalPages, imagesAnalyzed, ... }
});
```

#### Task 5.1.4: Prometheus Metrics

**File:** `apps/search-ai/src/metrics/multimodal-metrics.ts` (new)

**Metrics:**

```typescript
// Processing counters
multimodal_processing_total { category, stage, status }
multimodal_processing_duration_seconds { category, stage }
multimodal_processing_errors_total { category, stage, error_type }

// Cost tracking
multimodal_cost_usd_total { tenant_id, index_id, stage }
multimodal_tokens_total { tenant_id, index_id, stage }
```

#### Task 5.1.5: Wire TraceEvents into Workers

**Files:** All existing and new workers.

**Add:** `TraceEvent` emissions at job start, completion, and error boundaries.

#### Task 5.1.6: Integration Tests

**File:** `apps/search-ai/src/__tests__/integration/multimodal-observability.test.ts` (new)

**Tests:**

- TraceEvent emission for each processing stage.
- Cost aggregation accuracy.
- SSE progress event delivery.

### 5.2 Exit Criteria

- [ ] TraceEvents emitted for all multimodal processing stages.
- [ ] Cost tracking aggregates correctly per document and per stage.
- [ ] SSE progress events published for real-time UI.
- [ ] Prometheus metrics registered and incrementing.
- [ ] Integration tests pass.
- [ ] `pnpm build` succeeds.

---

## Wiring Checklist

Every new component must be wired into the system. This checklist prevents the common failure mode of building components that are never called.

| #   | Wiring Point                               | Source                            | Target                         | Verified |
| --- | ------------------------------------------ | --------------------------------- | ------------------------------ | -------- |
| 1   | Upload validator middleware                | Route handler                     | `uploadValidator()` middleware | [ ]      |
| 2   | Content classifier called on upload        | Upload handler                    | `classifyContent()`            | [ ]      |
| 3   | Audio files enqueue to transcription queue | Content router                    | `QUEUE_AUDIO_TRANSCRIPTION`    | [ ]      |
| 4   | Video files enqueue to video queue         | Content router                    | `QUEUE_VIDEO_PROCESSING`       | [ ]      |
| 5   | Bridge triggered on processing completion  | Processing worker                 | `QUEUE_ATTACHMENT_BRIDGE`      | [ ]      |
| 6   | Queue constants exported from SDK          | `search-ai-sdk/constants`         | All workers                    | [ ]      |
| 7   | Workers registered in worker index         | `workers/index.ts`                | Worker startup                 | [ ]      |
| 8   | Queues registered in queue factory         | `queues/queue-factory.ts`         | Queue creation                 | [ ]      |
| 9   | MAX_QUEUE_DEPTH includes new queues        | `pipeline-orchestration/types.ts` | Backpressure checks            | [ ]      |
| 10  | TraceEvents wired in all workers           | Each worker                       | `TraceStore`                   | [ ]      |
| 11  | Prometheus metrics registered              | `metrics/multimodal-metrics.ts`   | `/metrics` endpoint            | [ ]      |
| 12  | FFmpeg available in Docker image           | `Dockerfile`                      | Worker container               | [ ]      |

---

## File Change Summary

### New Files (14)

| File                                                                  | Phase | Purpose                             |
| --------------------------------------------------------------------- | ----- | ----------------------------------- |
| `apps/search-ai/src/middleware/upload-validator.ts`                   | 1     | Upload validation middleware        |
| `apps/search-ai/src/services/multimodal/content-classifier.ts`        | 1     | MIME-to-category classification     |
| `apps/search-ai/src/services/multimodal/attachment-bridge.ts`         | 2     | Attachment-to-search bridge service |
| `apps/search-ai/src/workers/attachment-bridge-worker.ts`              | 2     | Bridge worker                       |
| `apps/search-ai/src/services/transcription/types.ts`                  | 3     | Transcription provider interface    |
| `apps/search-ai/src/services/transcription/whisper-api-provider.ts`   | 3     | OpenAI Whisper provider             |
| `apps/search-ai/src/services/transcription/whisper-local-provider.ts` | 3     | Self-hosted Whisper provider        |
| `apps/search-ai/src/workers/audio-transcription-worker.ts`            | 3     | Audio transcription worker          |
| `apps/search-ai/src/services/video/ffmpeg-service.ts`                 | 4     | FFmpeg wrapper service              |
| `apps/search-ai/src/workers/video-processing-worker.ts`               | 4     | Video processing worker             |
| `packages/observatory/src/trace-events/multimodal-events.ts`          | 5     | TraceEvent type definitions         |
| `apps/search-ai/src/services/multimodal/cost-tracker.ts`              | 5     | Cost aggregation service            |
| `apps/search-ai/src/metrics/multimodal-metrics.ts`                    | 5     | Prometheus metrics                  |
| Test files (6)                                                        | 1-5   | Unit + integration tests            |

### Modified Files (8)

| File                                                          | Phase | Change                         |
| ------------------------------------------------------------- | ----- | ------------------------------ |
| `packages/search-ai-sdk/src/constants.ts`                     | 2     | Add queue constants            |
| `apps/search-ai/src/workers/index.ts`                         | 2,3,4 | Register new workers           |
| `apps/search-ai/src/queues/index.ts`                          | 2,3,4 | Register new queues            |
| `apps/search-ai/src/queues/queue-factory.ts`                  | 2,3,4 | Add queue creation             |
| `apps/search-ai/src/services/pipeline-orchestration/types.ts` | 2     | Add MAX_QUEUE_DEPTH entries    |
| `apps/search-ai/src/routes/indexes.ts`                        | 1     | Wire upload validator          |
| `apps/search-ai/src/routes/progress.ts`                       | 5     | Add multimodal progress events |
| `apps/search-ai/Dockerfile`                                   | 4     | Install ffmpeg                 |

---

## Risk Mitigations

| Risk                                      | Phase | Mitigation                                                       |
| ----------------------------------------- | ----- | ---------------------------------------------------------------- |
| Magic-byte detection adds latency         | 1     | `file-type` package is fast (~1ms); only reads first few KB      |
| FFmpeg child process hangs                | 4     | Timeout (60s) + cleanup on error; temp files in `/tmp` with TTL  |
| Whisper API cost overrun                  | 3     | Track cost per transcription; tenant config can disable          |
| Queue depth explosion during bulk uploads | 2     | `MAX_QUEUE_DEPTH` limits; backpressure error with `retryAfterMs` |
| Memory leak in vision service             | 5     | Worker concurrency limits; restart on OOM; Prometheus monitoring |

---

## Dependency Graph

```
Phase 1 (Validation) ←── required by ──┐
                                        │
Phase 2 (Bridge) ←── required by ──────┤
  └── Phase 5 (Observability)           │
                                        │
Phase 3 (Audio) ←── required by ───────┤
  └── Phase 2 (Bridge)                  │
                                        │
Phase 4 (Video) ←── depends on ────────┘
  └── Phase 3 (Audio transcription)
  └── Phase 2 (Bridge)
```

**Recommended execution order:** Phase 1 -> Phase 2 -> Phase 5 -> Phase 3 -> Phase 4

Phase 5 (Observability) can be done early since it defines types and infrastructure used by Phases 3 and 4.
