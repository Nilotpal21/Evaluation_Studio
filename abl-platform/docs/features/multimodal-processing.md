# Feature Spec: Multimodal Processing

> **Feature ID:** #40
> **Status:** ALPHA
> **Owner:** Search AI Team
> **Last Updated:** 2026-03-22

---

## 1. Problem Statement

The ABL platform's SearchAI ingestion pipeline currently processes documents primarily as text, with emerging multimodal capabilities spread across multiple workers (multimodal-worker, visual-enrichment-worker, document-visual-enrichment-worker, docling-extraction-worker). These capabilities are partially implemented, lack unified orchestration, and do not cover the full spectrum of content types (images, audio, video, documents) that enterprise customers need. Specifically:

- **Fragmented processing**: Three separate visual/multimodal workers with overlapping responsibilities and no unified processing strategy.
- **Missing audio/video support**: The `Attachment` model defines `audio` and `video` categories, but no transcription or analysis services are wired.
- **No attachment-to-search bridge**: Uploaded attachments (`Attachment` model) are not automatically routed through the ingestion pipeline for embedding and search.
- **Inconsistent tenant configuration**: `TenantAttachmentConfig` controls feature toggles (scan, processing, embedding) but these are not enforced consistently across all workers.
- **No unified progress tracking**: Each worker tracks status independently; there is no single view of multimodal processing progress per document or attachment.

## 2. Goal

Deliver a unified multimodal processing subsystem within SearchAI that:

1. Processes all four content categories (image, document, audio, video) through specialized extraction services.
2. Routes content through a single pipeline flow with the `multimodal` stage type already defined in `SearchPipelineStageType`.
3. Enforces tenant-level configuration (`TenantAttachmentConfig`) at every processing boundary.
4. Bridges runtime attachments (from agent conversations) into the SearchAI ingestion pipeline for embedding and retrieval.
5. Provides end-to-end observability via `TraceEvent`s and progress SSE events.

## 3. Non-Goals

- **Real-time streaming analysis**: Processing video/audio frames in real-time during agent conversations. This is batch/async only.
- **Custom model training**: Training custom vision or audio models on tenant data.
- **Direct media playback**: Serving media files through the platform; only extracted text/metadata is stored.
- **Studio UI for multimodal configuration**: The pipeline configuration UI is a separate feature (#pipeline-ui). This feature covers the backend processing only.
- **Audio/video generation**: Only analysis and extraction, not synthesis.

## 4. User Stories

### US-1: Document Extraction via Docling

**As a** knowledge base administrator,
**I want** uploaded PDF, DOCX, PPTX, HTML, and image documents to be automatically extracted into structured pages with layout, tables, images, and screenshots,
**So that** the content is fully searchable and visually enriched.

**Acceptance Criteria:**

- Documents are routed to Docling service based on MIME type.
- Extracted pages include text, headings, tables (HTML + Markdown), images (S3), and screenshots.
- OCR is applied to scanned documents when `ocrEnabled` is true.
- Failed extraction is retried 3 times with exponential backoff.

### US-2: Image Analysis and Description

**As a** search user,
**I want** images embedded in documents to be analyzed and described by vision models,
**So that** I can find documents by searching for visual content.

**Acceptance Criteria:**

- Images are sent to the configured vision provider (OpenAI, Anthropic, Gemini).
- Descriptions include content summary, relevance to surrounding text, and extracted data (charts/diagrams).
- Descriptions are stored in `SearchChunkMetadata.visualAnalysis.imageDescriptions`.
- Cost tracking records tokens used and USD cost per image.

### US-3: Audio Transcription

**As a** knowledge base administrator,
**I want** audio files (MP3, WAV, M4A, OGG) to be transcribed to searchable text,
**So that** audio content is discoverable through the search system.

**Acceptance Criteria:**

- Audio files are transcribed via a configurable provider (Whisper API or self-hosted).
- Transcription includes timestamps, speaker diarization (when available), and language detection.
- Transcribed text is stored as `processedContent` on the `Attachment` record and chunked for embedding.
- Files exceeding the configured `maxFileSizeBytes` are rejected with a clear error.

### US-4: Video Processing

**As a** knowledge base administrator,
**I want** video files to have their audio track transcribed and key frames analyzed,
**So that** video content is searchable by both spoken and visual content.

**Acceptance Criteria:**

- Audio track is extracted and transcribed (same as US-3).
- Key frames are sampled at configurable intervals (default: 1 per 30 seconds).
- Key frames are analyzed by the vision model (same as US-2).
- Combined transcript + visual descriptions are stored as processed content.

### US-5: Attachment-to-Search Bridge

**As a** platform operator,
**I want** attachments uploaded during agent conversations to be automatically indexed in the relevant knowledge base,
**So that** conversation context is enrichable and searchable.

**Acceptance Criteria:**

- When an attachment reaches `processingStatus: 'completed'`, a job is enqueued to the ingestion pipeline.
- The attachment is linked to a `SearchDocument` via `searchDocumentId` and `searchIndexId`.
- Tenant embedding configuration (`embeddingEnabled`) is respected.
- Deduplication via `contentHash` prevents re-processing identical files.

### US-6: Tenant Configuration Enforcement

**As a** tenant administrator,
**I want** per-tenant attachment configuration to control which processing stages execute,
**So that** I can manage costs and compliance requirements.

**Acceptance Criteria:**

- `scanEnabled`, `processingEnabled`, `embeddingEnabled` from `TenantAttachmentConfig` are checked before each stage.
- `allowedMimeTypes` and `blockedMimeTypes` are validated at upload time.
- `maxFileSizeBytes` is enforced at the upload boundary.
- `retentionDays` per category triggers TTL-based expiry via the `expiresAt` index.
- Missing tenant config falls back to platform defaults (20MB limit, all enabled, 90-day retention).

### US-7: Progressive Visual Context

**As a** search system,
**I want** visual analysis to chain context from page to page within a document,
**So that** image descriptions benefit from understanding of the full document narrative.

**Acceptance Criteria:**

- The `VisionService` receives `previousVisualContext` from the prior page's analysis.
- Visual context includes key visual elements and running narrative themes.
- Context is bounded to prevent token overflow (max 500 tokens of context per page).
- The document-level visual summary (`VisualDocumentSummary`) is generated after all pages are processed.

## 5. Functional Requirements

| ID    | Requirement                                                                                    | Priority | User Story    |
| ----- | ---------------------------------------------------------------------------------------------- | -------- | ------------- |
| FR-01 | Route documents to Docling service based on MIME type (PDF, DOCX, PPTX, HTML, images)          | P0       | US-1          |
| FR-02 | Extract structured pages with text, layout, tables, images, and screenshots                    | P0       | US-1          |
| FR-03 | Upload extracted images and screenshots to S3 with tenant-scoped keys                          | P0       | US-1          |
| FR-04 | Analyze images via configurable vision provider (OpenAI, Anthropic, Gemini)                    | P0       | US-2          |
| FR-05 | Generate image descriptions with content summary, relevance, and extracted data                | P0       | US-2          |
| FR-06 | Store visual analysis in `SearchChunkMetadata.visualAnalysis`                                  | P0       | US-2          |
| FR-07 | Transcribe audio files via configurable transcription provider                                 | P1       | US-3          |
| FR-08 | Support speaker diarization and timestamp extraction                                           | P1       | US-3          |
| FR-09 | Detect audio language using preprocessing-service or provider-native detection                 | P1       | US-3          |
| FR-10 | Extract audio track from video files                                                           | P1       | US-4          |
| FR-11 | Sample key frames from video at configurable intervals                                         | P1       | US-4          |
| FR-12 | Combine transcript + visual descriptions for video content                                     | P1       | US-4          |
| FR-13 | Bridge completed attachments into SearchAI ingestion pipeline                                  | P0       | US-5          |
| FR-14 | Link attachments to SearchDocument via `searchDocumentId` and `searchIndexId`                  | P0       | US-5          |
| FR-15 | Deduplicate attachments by `contentHash` before processing                                     | P0       | US-5          |
| FR-16 | Enforce `TenantAttachmentConfig` at every processing boundary                                  | P0       | US-6          |
| FR-17 | Validate MIME types against allow/block lists at upload                                        | P0       | US-6          |
| FR-18 | Enforce file size limits from tenant config                                                    | P0       | US-6          |
| FR-19 | Apply TTL-based retention per content category                                                 | P1       | US-6          |
| FR-20 | Chain visual context between pages with bounded token window                                   | P0       | US-7          |
| FR-21 | Generate document-level `VisualDocumentSummary` after all pages processed                      | P0       | US-7          |
| FR-22 | Emit `TraceEvent`s for every processing stage (extraction, analysis, transcription, embedding) | P0       | Cross-cutting |
| FR-23 | Publish SSE progress events for real-time UI feedback                                          | P1       | Cross-cutting |
| FR-24 | Retry failed processing with exponential backoff (3 attempts)                                  | P0       | Cross-cutting |

## 6. Non-Functional Requirements

| ID     | Requirement                    | Target                                                                         |
| ------ | ------------------------------ | ------------------------------------------------------------------------------ |
| NFR-01 | Document extraction latency    | < 30s for 50-page PDF                                                          |
| NFR-02 | Image description latency      | < 5s per image                                                                 |
| NFR-03 | Audio transcription throughput | Process 1 hour of audio in < 10 minutes                                        |
| NFR-04 | Video processing throughput    | Process 10-minute video in < 5 minutes                                         |
| NFR-05 | Worker concurrency             | Configurable per worker type (default: 3 for vision, 5 for extraction)         |
| NFR-06 | Queue backpressure             | Respect `MAX_QUEUE_DEPTH` limits (300 for docling, 500 for multimodal/visual)  |
| NFR-07 | Memory usage                   | Workers must not exceed 512MB RSS per instance                                 |
| NFR-08 | Cost tracking accuracy         | Track token usage and USD cost within 5% of actual billing                     |
| NFR-09 | Tenant isolation               | No cross-tenant data leakage in any processing path                            |
| NFR-10 | Availability                   | Processing workers recover from crashes without data loss (BullMQ persistence) |

## 7. Data Model

### Existing Models (No Changes)

- **`Attachment`** (`packages/database/src/models/attachment.model.ts`): Stores file metadata, storage references, security scan status, processing state, and search integration links. Categories: `image`, `document`, `audio`, `video`.
- **`TenantAttachmentConfig`** (`packages/database/src/models/tenant-attachment-config.model.ts`): Per-tenant configuration for file limits, MIME type filtering, processing toggles, and retention.
- **`DocumentPage`** (`packages/database/src/models/document-page.model.ts`): Page-level extraction results from Docling with text, layout, tables, images, screenshots.
- **`SearchDocument`** (`packages/database/src/models/search-document.model.ts`): Document metadata with content hash, extraction status, flow ID, page count.
- **`SearchPipelineDefinition`** (`packages/database/src/models/search-pipeline-definition.model.ts`): Pipeline flows with `multimodal` stage type.

### Existing Types (No Changes)

- **`VisualAnalysisMetadata`** (`packages/database/src/models/visual-enrichment-types.ts`): Image descriptions, screenshot analysis, visual context chain.
- **`SearchChunkMetadata`**: Extended with `visualAnalysis`, `progressiveSummary`, `documentSummary`.
- **`ImageDescription`**, **`ScreenshotAnalysis`**, **`VisualDocumentSummary`**: Structured visual enrichment results.

### New Types Required

- **`AudioTranscriptionResult`**: Transcript text, segments with timestamps, speaker labels, language, confidence, provider, cost.
- **`VideoProcessingResult`**: Combined transcript + key frame analyses, frame sampling configuration.
- **`MultimodalProcessingEvent`**: Unified trace event type for all multimodal processing stages.

## 8. API Contracts

### Internal Service APIs

#### Docling Service (POST /extract) -- Existing

- Input: Uploaded file + extraction options (images, tables, layout, screenshots, OCR)
- Output: Array of pages with text, layout, tables, images (base64), screenshots (base64)
- Port: 8080

#### BGE-M3 Embedding Service (POST /v1/embeddings) -- Existing

- Input: Array of text strings
- Output: OpenAI-compatible embedding response with 1024-dim vectors
- Port: 8000

#### Preprocessing Service (POST /v1/preprocess) -- Existing

- Input: Query text, tenant ID, config options
- Output: Processed query with language detection, spell correction, synonym expansion
- Port: 8003

#### Audio Transcription Service (POST /v1/transcribe) -- New

- Input: Audio file (multipart), language hint (optional), diarization flag
- Output: `{ transcript, segments: [{ start, end, text, speaker? }], language, confidence }`
- Port: 8004 (proposed)

### BullMQ Queue Contracts

| Queue                        | Job Data                                        | Producer               | Consumer                         |
| ---------------------------- | ----------------------------------------------- | ---------------------- | -------------------------------- |
| `search-docling-extraction`  | `{ indexId, documentId, sourceUrl, tenantId }`  | ingestion-worker       | docling-extraction-worker        |
| `search-multimodal`          | `{ indexId, documentId, chunkIds, tenantId }`   | enrichment-worker      | multimodal-worker                |
| `search-visual-enrichment`   | `{ indexId, documentId, pageNumber, tenantId }` | page-processing-worker | visual-enrichment-worker         |
| `search-audio-transcription` | `{ attachmentId, tenantId, projectId }`         | attachment-bridge      | audio-transcription-worker (new) |
| `search-video-processing`    | `{ attachmentId, tenantId, projectId }`         | attachment-bridge      | video-processing-worker (new)    |

## 9. Security Considerations

- **File validation**: MIME type detection via magic bytes (not just extension). Use `detectedMimeType` field.
- **Virus scanning**: All uploaded files pass through scan before processing (`scanStatus: 'clean'` required).
- **PII detection**: `hasPII` flag on attachments; PII-containing content follows data minimization rules.
- **EXIF stripping**: `exifStripped` flag ensures GPS/device metadata is removed from images.
- **Encryption at rest**: All S3 objects use server-side encryption. `encrypted` and `encryptionKeyVersion` fields track state.
- **Tenant isolation**: Every DB query includes `tenantId`. S3 keys are tenant-scoped. Workers use `withTenantContext()`.
- **Content size limits**: Enforced at upload boundary and before LLM API calls to prevent abuse.
- **Credential isolation**: LLM API keys resolved per-index via `resolveIndexLLMConfig()`, never leaked in logs or traces.

## 10. Observability

- **TraceEvents**: Every processing stage emits start/complete/error events via `TraceStore`.
- **Prometheus metrics**: `preprocessing_requests_total`, `preprocessing_duration_seconds`, `preprocessing_errors_total` (existing preprocessing service). New metrics for each processing stage.
- **BullMQ monitoring**: Queue depth, completion rate, failure rate exposed via `/api/queue-monitoring` routes.
- **SSE progress events**: `publishProgressEvent()` for real-time UI updates during document processing.
- **Cost tracking**: Per-image, per-transcription, per-document cost aggregation in `VisualAnalysisMetadata` and `SearchChunkMetadata`.

## 11. Dependencies

### Internal Dependencies

- `@agent-platform/database` -- Mongoose models (Attachment, TenantAttachmentConfig, DocumentPage, SearchDocument, SearchChunk)
- `@agent-platform/search-ai-sdk` -- Queue constants, document status enums
- `@agent-platform/shared` -- S3StorageService, encryption utilities
- `@abl/compiler/platform/llm` -- LLMClient for vision and language model calls
- `@agent-platform/llm` -- WorkerLLMClient for worker-context LLM calls

### External Service Dependencies

- **Docling Service** (Python/FastAPI, port 8080) -- Document extraction
- **BGE-M3 Service** (Python/Flask, port 8000) -- Text embedding
- **Preprocessing Service** (Python/Flask, port 8003) -- Query preprocessing
- **Vision LLM Providers** (OpenAI GPT-4V, Anthropic Claude, Google Gemini) -- Image analysis
- **Transcription Providers** (OpenAI Whisper, self-hosted Whisper) -- Audio transcription
- **S3/MinIO** -- Object storage for images, screenshots, and processed content
- **Redis** -- BullMQ job queues, distributed locks, caching
- **MongoDB** -- Document metadata, page data, chunk data

## 12. Migration Strategy

This feature extends existing infrastructure. No destructive migrations required.

1. **Schema additions**: New fields on existing models are optional with defaults (backward compatible).
2. **New workers**: Deployed alongside existing workers; no impact on current processing.
3. **Queue additions**: New queues (`search-audio-transcription`, `search-video-processing`) are additive.
4. **Service deployment**: New audio transcription service deployed via Docker Compose alongside existing Python services.
5. **Feature flags**: `TenantAttachmentConfig.processingEnabled` and `embeddingEnabled` control activation per tenant.

## 13. Rollback Plan

- **Worker rollback**: Stop new workers; existing workers continue processing text-only pipeline.
- **Queue cleanup**: Drain new queues via BullMQ admin API.
- **Schema rollback**: New optional fields can be ignored by older code (no schema version bump needed).
- **Service rollback**: Remove new Python service container; existing Docling/BGE-M3 services unaffected.

## 14. Performance Considerations

- **Batch embedding**: BGE-M3 supports batching (default 8 for CPU, 32 for GPU) to amortize overhead.
- **Rate limiting**: Vision API calls limited to `rateLimitPerMinute` from global config. BullMQ limiter: 10 jobs/minute for visual enrichment.
- **Queue backpressure**: `MAX_QUEUE_DEPTH` enforced per queue (300 docling, 500 multimodal, 500 visual enrichment).
- **Progressive processing**: Visual context chain bounded to 500 tokens to prevent context window overflow.
- **Concurrent workers**: Configurable concurrency per worker type (3 for vision-heavy, 5 for extraction).
- **S3 upload optimization**: Images uploaded in parallel per page; screenshots uploaded only when `renderScreenshots` is enabled.

## 15. Testing Strategy

- **Unit tests**: Service-level tests for each processing service (multimodal enricher, vision service, audio transcriber).
- **Integration tests**: End-to-end pipeline tests with real BullMQ queues and MongoDB, mocking only external LLM/S3 providers.
- **E2E tests**: Full HTTP API tests uploading documents, triggering processing, and verifying search results. Minimum 5 scenarios.
- **Load tests**: Concurrent document processing with queue depth monitoring.
- **Security tests**: MIME type validation bypass attempts, oversized file handling, cross-tenant access.

## 16. Feature Flags

| Flag                                                     | Type       | Default | Description                            |
| -------------------------------------------------------- | ---------- | ------- | -------------------------------------- |
| `TenantAttachmentConfig.scanEnabled`                     | Per-tenant | `true`  | Enable virus scanning                  |
| `TenantAttachmentConfig.processingEnabled`               | Per-tenant | `true`  | Enable content extraction/analysis     |
| `TenantAttachmentConfig.embeddingEnabled`                | Per-tenant | `true`  | Enable search embedding                |
| `llmConfig.useCases.multimodal.enabled`                  | Per-index  | `true`  | Enable multimodal enrichment for index |
| `llmConfig.useCases.multimodal.enableImageDescription`   | Per-index  | `true`  | Enable image description generation    |
| `llmConfig.useCases.multimodal.enableTableSummarization` | Per-index  | `true`  | Enable table summarization             |
| `llmConfig.useCases.multimodal.enableChartAnalysis`      | Per-index  | `true`  | Enable chart/diagram analysis          |

## 17. Success Metrics

| Metric                           | Target                                             | Measurement                                     |
| -------------------------------- | -------------------------------------------------- | ----------------------------------------------- |
| Document extraction success rate | > 99%                                              | `SearchDocument.status === 'processed'` / total |
| Image description coverage       | > 95% of images in processed documents             | Images with descriptions / total images         |
| Audio transcription accuracy     | > 90% WER (Word Error Rate)                        | Sampled comparison against human transcripts    |
| Processing latency P95           | < 60s for single-page documents                    | BullMQ job completion timestamps                |
| Search relevance improvement     | > 10% improvement in recall for multimodal queries | A/B testing on search quality benchmarks        |
| Cost per document                | < $0.05 for text-only, < $0.50 for image-heavy     | Aggregated from cost tracking fields            |

## 18. Open Questions

| #   | Question                                                                       | Status   | Decision                                                                   |
| --- | ------------------------------------------------------------------------------ | -------- | -------------------------------------------------------------------------- |
| 1   | Should audio transcription use OpenAI Whisper API or self-hosted Whisper?      | DECIDED  | Support both via provider config, default to API for simplicity            |
| 2   | What is the key frame sampling strategy for video?                             | DECIDED  | Time-based (every 30s) with scene-change detection as P2 enhancement       |
| 3   | Should the attachment-to-search bridge be synchronous or async?                | DECIDED  | Async via BullMQ queue to avoid blocking the conversation flow             |
| 4   | How should multimodal costs be attributed -- per tenant or per knowledge base? | DECIDED  | Per knowledge base (via `indexId`), aggregated to tenant for billing       |
| 5   | What is the maximum video length supported?                                    | DECIDED  | 30 minutes (configurable per tenant), enforced at upload                   |
| 6   | Should document visual summaries be regenerated when new pages are added?      | INFERRED | Yes, on incremental updates the document-level summary should be refreshed |
| 7   | How do we handle unsupported file formats gracefully?                          | DECIDED  | Mark `processingStatus: 'skipped'` with reason, still store raw file       |
