# High-Level Design: Multimodal Processing

> **Feature ID:** #40
> **Status:** PLANNED
> **Last Updated:** 2026-03-22
> **Feature Spec:** `docs/features/multimodal-processing.md`
> **Test Spec:** `docs/testing/multimodal-processing.md`

---

## 1. Architecture Overview

The multimodal processing subsystem extends the existing SearchAI ingestion pipeline with unified processing for all content categories (image, document, audio, video). It follows the platform's established patterns: BullMQ-based worker orchestration, tenant-isolated MongoDB storage, S3 object storage for binary assets, and provider-agnostic LLM integration via the compiler's `LLMClient`.

### System Context

```
                    ┌──────────────────────┐
                    │   Studio / Runtime    │
                    │   (Upload Boundary)   │
                    └──────────┬───────────┘
                               │ HTTP multipart
                               ▼
                    ┌──────────────────────┐
                    │   Upload Validator    │
                    │  (MIME, size, tenant) │
                    └──────────┬───────────┘
                               │
                    ┌──────────▼───────────┐
                    │   Attachment Model    │
                    │      (MongoDB)        │
                    └──────────┬───────────┘
                               │ BullMQ
             ┌─────────────────┼─────────────────┐
             │                 │                  │
    ┌────────▼──────┐  ┌──────▼───────┐  ┌──────▼───────┐
    │   Document    │  │    Audio     │  │    Video     │
    │  Processing   │  │ Transcription│  │  Processing  │
    │   Pipeline    │  │   Worker     │  │   Worker     │
    └───────┬───────┘  └──────┬───────┘  └──────┬───────┘
            │                 │                  │
            ▼                 ▼                  ▼
    ┌──────────────────────────────────────────────────┐
    │            Attachment-to-Search Bridge            │
    │         (SearchDocument + Embedding Queue)        │
    └──────────────────────────────────────────────────┘
```

### Document Processing Pipeline (Existing, Extended)

```
Upload → Ingestion → Extraction → Docling Extraction → Page Processing
  → Visual Enrichment → Canonical Mapping → Question Synthesis
  → Scope Classification → Embedding → Indexed
```

## 2. Component Architecture

### 2.1 Upload Validator

**Responsibility:** Validate incoming files against tenant configuration before any processing begins.

**Location:** Middleware in SearchAI and Runtime Express routes.

**Checks (in order):**

1. File size against `TenantAttachmentConfig.maxFileSizeBytes` (default 20MB).
2. MIME type detection via magic bytes (not extension). Compare against `allowedMimeTypes` and `blockedMimeTypes`.
3. Per-session attachment count against `maxAttachmentsPerSession`.
4. Total tenant storage against `maxTotalStorageBytes`.

**Failure behavior:** Return HTTP 400/413 with `{ success: false, error: { code, message } }`. No job enqueued.

### 2.2 Content Router

**Responsibility:** Route validated uploads to the appropriate processing pipeline based on content category.

**Routing logic:**
| Category | MIME Types | Processing Path |
|----------|-----------|-----------------|
| `document` | `application/pdf`, `application/vnd.*`, `text/html`, `text/markdown` | Docling extraction pipeline |
| `image` | `image/png`, `image/jpeg`, `image/webp`, `image/gif`, `image/tiff` | Direct vision analysis |
| `audio` | `audio/mpeg`, `audio/wav`, `audio/ogg`, `audio/mp4`, `audio/webm` | Audio transcription worker |
| `video` | `video/mp4`, `video/webm`, `video/quicktime`, `video/x-msvideo` | Video processing worker |

### 2.3 Document Processing Pipeline (Existing)

This pipeline is already implemented and working. Key components:

- **Docling Extraction Worker** (`docling-extraction-worker.ts`): Calls the Docling Python service via HTTP, uploads images/screenshots to S3, stores `DocumentPage` records.
- **Page Processing Worker** (`page-processing-worker.ts`): Converts DocumentPages to SearchChunks with progressive summarization and question generation.
- **Visual Enrichment Worker** (`visual-enrichment-worker.ts`): Page-by-page visual analysis with progressive context chain.
- **Document Visual Enrichment Worker** (`document-visual-enrichment-worker.ts`): Document-level visual summary generation.
- **Multimodal Worker** (`multimodal-worker.ts`): Image description and table summarization for chunks.

### 2.4 Audio Transcription Worker (New)

**Responsibility:** Transcribe audio files to searchable text.

**Architecture:**

- Consumes from `search-audio-transcription` BullMQ queue.
- Downloads audio file from S3 using the `Attachment.storageKey`.
- Calls the configured transcription provider (OpenAI Whisper API or self-hosted Whisper).
- Stores result as `processedContent` on the Attachment record.
- Triggers the attachment-to-search bridge for embedding.

**Provider abstraction:**

```
TranscriptionProvider (interface)
  ├── WhisperAPIProvider   (OpenAI API)
  └── WhisperLocalProvider (self-hosted HTTP)
```

### 2.5 Video Processing Worker (New)

**Responsibility:** Extract and process both audio and visual content from video files.

**Architecture:**

- Consumes from `search-video-processing` BullMQ queue.
- Extracts audio track via FFmpeg (child process).
- Enqueues audio for transcription (reuses audio transcription path).
- Samples key frames at configurable intervals (default 30s).
- Sends key frames to vision service for analysis.
- Combines transcript + visual descriptions as `processedContent`.

### 2.6 Attachment-to-Search Bridge (New)

**Responsibility:** Bridge processed attachments into the SearchAI ingestion pipeline for embedding and search.

**Architecture:**

- Triggered when `Attachment.processingStatus` transitions to `'completed'`.
- Checks `TenantAttachmentConfig.embeddingEnabled` before proceeding.
- Deduplicates by `contentHash` against existing `SearchDocument` records.
- Creates a `SearchDocument` record linked to the attachment.
- Enqueues the document for chunking and embedding via the existing pipeline.
- Updates the attachment with `searchDocumentId` and `searchIndexId`.

## 3. Twelve Architectural Concerns

### 3.1 Tenant Isolation

- **Data isolation**: Every MongoDB query includes `tenantId` via the `tenantIsolationPlugin`. All models (`Attachment`, `TenantAttachmentConfig`, `DocumentPage`, `SearchDocument`, `SearchChunk`) have the plugin applied.
- **Storage isolation**: S3 object keys include `tenantId` as a prefix: `{tenantId}/{projectId}/{category}/{attachmentId}/{filename}`.
- **Processing isolation**: Workers use `withTenantContext({ tenantId })` to set the tenant context for all DB operations within a job.
- **Cross-tenant returns 404**: Never 403, to avoid leaking resource existence.

### 3.2 Authentication and Authorization

- **Upload routes**: Protected by `createUnifiedAuthMiddleware` / `requireAuth`.
- **Project-scoped routes**: Use `requireProjectPermission(req, res, 'attachment:create')`.
- **Admin routes**: Tenant config management requires `requirePermission('tenant:manage')`.
- **Worker-to-service calls**: Internal service calls (to Docling, BGE-M3) use internal network; no external auth needed. External LLM API calls use credentials resolved via `resolveIndexLLMConfig()`.

### 3.3 Stateless and Distributed

- **No pod-local state**: All processing state is in MongoDB (documents, pages, chunks) and Redis (BullMQ queues).
- **Worker scaling**: Any number of worker instances can consume from the same queue. BullMQ handles job distribution.
- **Distributed locks**: Not needed for processing (BullMQ provides at-least-once delivery). Content hash deduplication uses MongoDB unique index (`indexId + contentHash`).

### 3.4 Traceability

- **TraceEvents**: Every processing stage emits `TraceEvent`s via `TraceStore`:
  - `multimodal.extraction.start`, `multimodal.extraction.complete`, `multimodal.extraction.error`
  - `multimodal.vision.start`, `multimodal.vision.complete`
  - `multimodal.transcription.start`, `multimodal.transcription.complete`
  - `multimodal.bridge.start`, `multimodal.bridge.complete`
- **Structured logging**: Workers use `workerLog()` and `workerError()` (existing pattern).
- **Job tracking**: BullMQ job IDs correlate with `JobExecution` records for pipeline observability.

### 3.5 Compliance

- **Encryption at rest**: All S3 objects encrypted (SSE-S3). `Attachment.encrypted = true` and `encryptionKeyVersion` track state.
- **Data minimization**: `retentionDays` per content category triggers TTL-based expiry via MongoDB's `expiresAt` index on the Attachment model.
- **Right to erasure**: Deleting an attachment cascades to S3 object, DocumentPage records, SearchDocument, and SearchChunk records.
- **PII detection**: `Attachment.hasPII` flag enables downstream data handling policies.
- **EXIF stripping**: Image metadata (GPS, device info) stripped before storage. `exifStripped` flag tracks compliance.
- **Audit logging**: Attachment upload, processing, and deletion events recorded in audit log.

### 3.6 Performance

- **Batch processing**: BGE-M3 embeddings batched (8 for CPU, 32 for GPU). Vision API calls parallelized per page.
- **Queue backpressure**: `MAX_QUEUE_DEPTH` limits enforced per queue to prevent Redis OOM.
- **Rate limiting**: Vision API calls limited to `rateLimitPerMinute`. BullMQ limiter: 10 jobs/minute for visual enrichment.
- **Concurrency**: Worker concurrency configurable per type (default: 3 vision, 5 extraction).
- **Progressive context**: Visual context bounded to 500 tokens to prevent context window overflow.
- **S3 parallelism**: Images uploaded in parallel per page.

### 3.7 Error Handling

- **Retry with backoff**: All workers retry 3 times with exponential backoff (5s, 10s, 20s) via `FLOW_CHILD_DEFAULTS`.
- **Error recording**: Failed jobs update the relevant record (`Attachment.processingError`, `SearchDocument.processingError`).
- **Graceful degradation**: If vision service is unavailable, multimodal enrichment is skipped (not blocking) and the document is still indexed as text-only.
- **Dead letter**: Failed jobs retained for 24 hours for debugging (`removeOnFail.age: 86400`).
- **Error envelope**: All API errors use `{ success: false, error: { code, message } }` format.

### 3.8 Observability

- **Prometheus metrics**: Per-worker request count, duration, error count. Per-service health check latency.
- **BullMQ dashboard**: Queue depth, active/waiting/completed/failed job counts via `/api/queue-monitoring`.
- **SSE progress events**: `publishProgressEvent()` for real-time UI feedback.
- **Cost tracking**: Per-image, per-transcription, per-document cost aggregation in chunk metadata.
- **Health checks**: Each Python service exposes `/health` endpoint.

### 3.9 Scalability

- **Horizontal**: Add more worker instances for any queue. BullMQ distributes jobs automatically.
- **Vertical**: GPU-enabled BGE-M3 instances for higher throughput (batch size 32 vs 8 CPU).
- **Queue sharding**: Not needed at current scale. Can be added if a single queue exceeds Redis memory.
- **Service scaling**: Docling, BGE-M3, and transcription services are stateless and independently scalable.

### 3.10 Backward Compatibility

- **Schema additions**: All new fields on existing models use defaults and are optional.
- **API additions**: New endpoints are additive; no existing endpoint changes.
- **Worker additions**: New workers are deployed alongside existing ones; no impact on current processing.
- **Queue additions**: New queues are additive; existing queues unaffected.
- **Feature flags**: `TenantAttachmentConfig` toggles control activation per tenant.

### 3.11 Security

- **Input validation**: MIME type detection via magic bytes. File size enforced at upload boundary.
- **Virus scanning**: All files scanned before processing (`scanStatus: 'clean'` required gate).
- **Credential isolation**: LLM API keys resolved per-index via `resolveIndexLLMConfig()`, never logged or traced.
- **S3 key security**: Keys include tenant/project scope. Pre-signed URLs with short TTL for downloads.
- **Content size caps**: `maxImageSizeBytes`, `maxTableSizeBytes` in global config prevent abuse.
- **Filename sanitization**: Original filenames stored but never used for storage paths; UUID-based keys used instead.

### 3.12 Testing

- **E2E**: 7 scenarios testing full HTTP API paths with real Express, BullMQ, and MongoDB.
- **Integration**: 7 scenarios testing worker behavior with real queues and DB, HTTP stubs for external services.
- **Unit**: 5 suites covering validation logic, hash computation, context truncation.
- **Security**: 4 scenarios covering MIME bypass, path traversal, oversized payloads, cross-tenant access.
- **No mocking of codebase components**: E2E tests use real middleware chain. External services only are mocked via HTTP stubs.

## 4. Data Flow

### 4.1 Document Processing Flow

```
1. Upload (HTTP multipart) → Validate (MIME, size, tenant) → Store in S3
2. Create Attachment record (processingStatus: 'pending')
3. Enqueue to search-docling-extraction
4. Docling Worker: Call Docling service → Extract pages → Upload images to S3 → Store DocumentPages
5. Page Processing Worker: Convert pages to SearchChunks → Progressive summarization → Questions
6. Visual Enrichment Worker: Analyze images → Chain context → Store visual analysis
7. Document Visual Enrichment Worker: Generate document-level visual summary
8. Embedding Worker: Generate BGE-M3 embeddings → Index in OpenSearch
9. Update Attachment: processingStatus='completed', searchDocumentId, searchIndexId
```

### 4.2 Audio Processing Flow

```
1. Upload (HTTP multipart) → Validate (MIME, size, tenant) → Store in S3
2. Create Attachment record (processingStatus: 'pending', category: 'audio')
3. Enqueue to search-audio-transcription
4. Audio Worker: Download from S3 → Call Whisper API → Store transcript
5. Update Attachment: processedContent=transcript, processingStatus='completed'
6. Attachment Bridge: Create SearchDocument → Enqueue for chunking+embedding
7. Update Attachment: searchDocumentId, searchIndexId, embeddingStatus='processing'
```

### 4.3 Video Processing Flow

```
1. Upload (HTTP multipart) → Validate (MIME, size, tenant) → Store in S3
2. Create Attachment record (processingStatus: 'pending', category: 'video')
3. Enqueue to search-video-processing
4. Video Worker: Download from S3 → Extract audio → Sample key frames
5. Audio path: Transcribe audio → Get transcript
6. Visual path: Analyze key frames via vision service → Get frame descriptions
7. Combine: Merge transcript + frame descriptions → Store as processedContent
8. Attachment Bridge: Create SearchDocument → Enqueue for embedding
```

## 5. Design Alternatives Considered

### Alternative 1: Unified Multimodal Worker (Rejected)

**Approach:** Single worker handling all content types (document, image, audio, video).

**Pros:**

- Simpler deployment (one worker type).
- Single queue to monitor.

**Cons:**

- **Different resource profiles**: Document extraction is CPU-bound (Docling), vision is API-latency-bound, audio is network-bound (Whisper API). A single worker cannot be optimally configured for all.
- **No independent scaling**: Cannot scale audio transcription without also scaling document extraction.
- **Blast radius**: A bug in video processing could affect document processing.

**Decision:** Rejected. Separate workers per content type aligns with the platform's existing pattern (each queue has its own worker) and allows independent scaling and failure isolation.

### Alternative 2: Synchronous Attachment Bridge (Rejected)

**Approach:** Bridge attachments to SearchAI pipeline synchronously within the processing worker.

**Pros:**

- Simpler code path (no additional queue).
- Immediate search availability.

**Cons:**

- **Blocking**: Embedding generation is slow. Would block the processing worker.
- **Coupling**: Tight coupling between attachment processing and search indexing.
- **Retry complexity**: If embedding fails, the entire processing job retries.

**Decision:** Rejected. Async via BullMQ queue is consistent with the platform's architecture and allows independent retry of processing vs. embedding.

### Alternative 3: Direct LLM API Calls in Workers (Rejected)

**Approach:** Workers call vision/transcription APIs directly using `fetch` instead of the platform's `LLMClient`.

**Pros:**

- Simpler implementation (no abstraction layer).
- Direct control over request format.

**Cons:**

- **No cost tracking**: Platform's LLMClient provides automatic token counting and cost attribution.
- **No rate limiting**: Would need custom rate limiting per provider.
- **No credential management**: Would need to resolve API keys manually.
- **No provider switching**: Changing from OpenAI to Anthropic would require code changes.

**Decision:** Rejected. The existing `LLMClient` and `resolveIndexLLMConfig()` patterns provide cost tracking, rate limiting, credential management, and provider abstraction. Already used by the existing multimodal and vision services.

## 6. Technology Choices

| Concern                | Choice                              | Rationale                                                          |
| ---------------------- | ----------------------------------- | ------------------------------------------------------------------ |
| Job orchestration      | BullMQ                              | Already used for all SearchAI workers; proven at scale             |
| Document extraction    | Docling (Python/FastAPI)            | Already deployed and tested; supports PDF, DOCX, PPTX, HTML        |
| Text embedding         | BGE-M3 (Python/Flask)               | Already deployed; 1024-dim, multilingual, self-hosted              |
| Vision analysis        | LLMClient (OpenAI/Anthropic/Gemini) | Provider-agnostic; already used by VisionService                   |
| Audio transcription    | Whisper API + self-hosted option    | Industry standard; OpenAI API for simplicity, self-hosted for cost |
| Video frame extraction | FFmpeg (child process)              | Industry standard; available in Docker images                      |
| Object storage         | S3/MinIO                            | Already used for document images and screenshots                   |
| Database               | MongoDB (Mongoose)                  | Already used for all SearchAI models                               |

## 7. Capacity and Sizing

| Resource                           | Estimate   | Basis                                        |
| ---------------------------------- | ---------- | -------------------------------------------- |
| S3 storage per 1000 documents      | ~5 GB      | Avg 5 pages _ 3 images _ 200KB + screenshots |
| MongoDB storage per 1000 documents | ~500 MB    | Pages + chunks + metadata                    |
| Vision API cost per 1000 documents | ~$5-15     | Avg 15 images \* $0.001 per image            |
| Embedding cost per 1000 documents  | ~$0        | Self-hosted BGE-M3 (zero per-token cost)     |
| Redis memory per 10000 queued jobs | ~100 MB    | Job data ~10KB each                          |
| Worker memory (vision)             | 256-512 MB | Per instance, depends on batch size          |
| Worker memory (extraction)         | 128-256 MB | Per instance                                 |
| Docling service memory             | 1-2 GB     | Python + OCR models                          |
| BGE-M3 service memory (CPU)        | 2-4 GB     | Model weights + inference                    |
| BGE-M3 service memory (GPU)        | 4-8 GB     | VRAM for larger batches                      |

## 8. Risk Assessment

| Risk                           | Probability | Impact   | Mitigation                                                           |
| ------------------------------ | ----------- | -------- | -------------------------------------------------------------------- |
| Vision API rate limiting       | High        | Medium   | BullMQ limiter (10/min), exponential backoff, per-index config       |
| Large file OOM in workers      | Medium      | High     | File size limits, streaming S3 downloads, worker memory caps         |
| Docling service downtime       | Low         | High     | Health checks, retry with backoff, graceful degradation to text-only |
| Cross-tenant data leak in S3   | Low         | Critical | Tenant-prefixed keys, server-side encryption, access audit           |
| Redis OOM from queue backlog   | Medium      | High     | `MAX_QUEUE_DEPTH` limits, `removeOnComplete`/`removeOnFail` TTLs     |
| FFmpeg vulnerabilities (video) | Medium      | Medium   | Pin FFmpeg version, validate input, run in sandbox                   |
| Cost overrun on vision API     | Medium      | Medium   | Per-index cost tracking, configurable enable/disable per tenant      |

## 9. Implementation Dependencies

### Phase Dependencies

```
Phase 1: Upload Validation + Tenant Config Enforcement (P0)
  └── Phase 2: Audio Transcription Worker (P1)
  └── Phase 3: Video Processing Worker (P1, depends on Phase 2)
  └── Phase 4: Attachment-to-Search Bridge (P0)
  └── Phase 5: Observability + Cost Tracking (P0)
```

### External Dependencies

- Docling service must be deployed and healthy (existing).
- BGE-M3 service must be deployed and healthy (existing).
- Redis must have sufficient memory for new queues.
- S3/MinIO must be accessible from workers.
- FFmpeg must be available in video worker Docker image.
- Whisper API key (if using OpenAI) or self-hosted Whisper service.
