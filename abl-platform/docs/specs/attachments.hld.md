# HLD: Attachments

**Status**: STABLE
**Author**: Platform team
**Date**: 2026-03-22

---

## 1. Problem Statement

Modern conversational AI agents must handle multimodal input beyond plain text. Users send images, documents, audio recordings, and video files through web, mobile, and enterprise messaging channels. The platform needs a unified attachment pipeline that:

1. **Accepts files** from any channel (web SDK, Slack, Teams, WhatsApp, email, Telegram, Messenger, Instagram, LINE) with consistent validation and security scanning.
2. **Processes files** asynchronously (document parsing, image analysis, audio transcription, video processing) without blocking the conversation.
3. **Injects processed content** into the LLM context as structured `ContentBlock[]`, with PII policy enforcement (redact/block/allow).
4. **Exposes files to agent tools** so agents can read, list, upload, download, and route attachments via DSL-defined destinations.
5. **Manages lifecycle** with configurable retention, TTL-based expiry, and GDPR cascade deletion.

The system spans all 7 tiers of the platform stack: DSL, shared types, data layer, dedicated microservice, runtime integration, web SDK, and Studio UI.

---

## 2. Alternatives Considered

This is a post-implementation document. The architecture described below is the actual implementation, not a proposal. No alternatives analysis is applicable.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        External Channels                            │
│  Web SDK · Slack · Teams · WhatsApp · Email · Telegram ·           │
│  Messenger · Instagram · LINE · Twilio SMS                         │
└──────────┬─────────────────────────────────────────────────────────┘
           │ File upload (multipart/stream/base64/URL)
           ▼
┌──────────────────────────────────────────────────────────────────────┐
│                       apps/runtime (port 3112)                       │
│                                                                      │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ Attachment Routes │  │ Message          │  │ Attachment Tool  │  │
│  │ (upload, list,   │  │ Preprocessor     │  │ Executor         │  │
│  │  get, delete)    │  │ (→ContentBlock[])│  │ (5 agent tools)  │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│           │                     │                      │            │
│  ┌────────┴─────────────────────┴──────────────────────┴─────────┐  │
│  │  MultimodalServiceClient + Circuit Breaker                     │  │
│  │  Config Resolver (project → tenant → platform defaults)        │  │
│  └────────────────────────────────────┬───────────────────────────┘  │
└───────────────────────────────────────┼──────────────────────────────┘
                                        │ Internal HTTP (X-Tenant-Id)
                                        ▼
┌──────────────────────────────────────────────────────────────────────┐
│                 apps/multimodal-service (port 3006)                   │
│                                                                      │
│  ┌─────────┐  ┌──────────┐  ┌───────────┐  ┌───────┐  ┌─────────┐ │
│  │  Scan   │→ │ Validate │→ │  Process   │→ │ Index │→ │ Cleanup │ │
│  │ ClamAV  │  │ MIME     │  │ Tika/      │  │Search │  │ TTL/    │ │
│  │         │  │ magic-   │  │ Whisper/   │  │ AI    │  │ Storage │ │
│  │         │  │ byte     │  │ FFmpeg/PII │  │       │  │         │ │
│  └─────────┘  └──────────┘  └───────────┘  └───────┘  └─────────┘ │
│  ┌────────────────────────────┐  ┌─────────────────────────────┐   │
│  │  Storage Factory           │  │  BullMQ Job Queues          │   │
│  │  Local · S3 · MinIO · GCS │  │  scan · validate · process  │   │
│  │  Azure Blob · GridFS      │  │  index · cleanup · expiry   │   │
│  └────────────────────────────┘  └─────────────────────────────┘   │
└──────────────────────────────────────────────────────────────────────┘
                                        │
                              ┌─────────┴─────────┐
                              │   MongoDB          │
                              │   attachments      │
                              │   project_att_cfg  │
                              │   tenant_att_cfg   │
                              └────────────────────┘
```

### Component Diagram

```
Tier 1: DSL & Compilation
  packages/core/src/parser/agent-based-parser.ts
    ├── parseAttachments()     → AttachmentFieldAST[]
    └── parseDestinations()    → DestinationAST[]
  packages/compiler/src/platform/ir/compiler.ts
    ├── compileAttachments()   → AttachmentFieldIR[]
    ├── compileDestinations()  → DestinationIR[]
    └── isSSRFUrl()            → compile-time SSRF block
  packages/compiler/src/platform/ir/schema.ts
    ├── AttachmentFieldIR      (name, prompt, category, required, allowed_mime_types, max_file_size_bytes, processing)
    └── DestinationIR          (name, url, method, auth, headers)

Tier 2: Shared Types & Interfaces
  packages/shared/src/attachments/
    ├── types.ts               → AttachmentCategory, ScanStatus, ProcessingStatus, EmbeddingStatus, AttachmentInput, AttachmentConfig
    └── interfaces/
        ├── storage-provider.ts    → StorageProvider (upload, download, getSignedUrl, delete, deleteMany, exists, copy, healthCheck)
        ├── scan-provider.ts       → ScanProvider (scan, healthCheck)
        ├── document-parser.ts     → DocumentParser
        ├── transcription-provider.ts → TranscriptionProvider
        └── video-processor.ts     → VideoProcessor

Tier 3: Data Layer
  packages/database/src/models/
    ├── attachment.model.ts                → Attachment (30+ fields, 8 indexes, SHA-256 dedup, TTL)
    ├── project-attachment-config.model.ts → ProjectAttachmentConfig (per-project overrides)
    └── tenant-attachment-config.model.ts  → TenantAttachmentConfig (per-tenant defaults)

Tier 4: Multimodal Service (Dedicated Microservice)
  apps/multimodal-service/src/
    ├── server.ts              → Express app (port 3006)
    ├── config.ts              → Storage, scan, processing config (env-driven)
    ├── routes/attachments.ts  → Internal REST API
    ├── services/
    │   ├── multimodal-service.ts       → AttachmentService (core upload/get/delete)
    │   ├── queues.ts                   → BullMQ queue initialization
    │   ├── attachment-search-producer.ts → Search AI indexing producer
    │   └── tenant-config-service.ts    → Tenant config resolution
    ├── storage/
    │   ├── storage-factory.ts → createStorageProvider() (Local, S3, MinIO, GCS, Azure, GridFS)
    │   ├── local-storage.ts   → LocalStorageProvider
    │   └── s3-storage.ts      → S3StorageProvider
    ├── security/
    │   ├── mime-validator.ts   → Magic-byte MIME detection
    │   ├── clamav-scanner.ts   → ClamAV integration
    │   ├── ssrf-validator.ts   → SSRF URL validation
    │   └── upload-rate-limiter.ts → Per-tenant sliding window
    ├── processing/
    │   ├── image-processor.ts         → Resize + thumbnail generation
    │   ├── document-parser-tika.ts    → Apache Tika integration
    │   ├── transcriber-whisper.ts     → Whisper transcription
    │   └── video-processor-ffmpeg.ts  → FFmpeg video processing
    └── jobs/
        ├── queues.ts           → QUEUE_NAMES, shared queue config
        ├── scan-job.ts         → ClamAV scan worker
        ├── validate-job.ts     → MIME validation worker
        ├── process-job.ts      → Document/image/audio/video processing + PII detection
        ├── index-job.ts        → Search AI indexing worker
        ├── cleanup-job.ts      → Storage + DB cleanup worker
        └── expiry-sweep-job.ts → Hourly TTL sweep

Tier 5: Runtime Integration
  apps/runtime/src/
    ├── attachments/
    │   ├── attachment-config-resolver.ts  → 3-tier merge (project → tenant → platform)
    │   ├── multimodal-service-client.ts   → HTTP client (upload, get, list, delete, status, retry, downloadUrl)
    │   ├── multimodal-circuit-breaker.ts  → CLOSED → OPEN → HALF_OPEN pattern
    │   └── message-preprocessor.ts        → Attachments → ContentBlock[] with PII policy
    ├── tools/
    │   ├── attachment-tool-executor.ts     → 5 tools (get/list/upload/url/route_attachment)
    │   └── attachment-param-validator.ts   → Validates attachment ID exists + session ownership
    ├── routes/
    │   ├── attachments.ts                 → Public API (session-scoped CRUD)
    │   └── attachment-config.ts           → Project config GET/PUT
    └── channels/adapters/
        ├── email-attachment-processor.ts
        ├── slack-file-processor.ts / slack-file-downloader.ts
        ├── msteams-file-processor.ts / msteams-file-downloader.ts
        ├── whatsapp-media-processor.ts
        ├── telegram-media-processor.ts / telegram-media-downloader.ts
        ├── messenger-media-processor.ts / messenger-media-downloader.ts
        ├── instagram-media-processor.ts / instagram-media-downloader.ts
        ├── line-media-processor.ts / line-media-downloader.ts
        └── twilio-sms-media-processor.ts / twilio-sms-media-downloader.ts

Tier 6: Web SDK
  packages/web-sdk/src/chat/ChatClient.ts
    ├── uploadAttachment(file: File) → multipart POST → attachmentId
    ├── send({attachmentIds})         → include attachment refs in messages
    └── Events: attachmentUploaded, attachmentError

Tier 7: Studio UI
  apps/studio/src/components/chat/
    ├── ChatInput.tsx    → File picker, drag-and-drop (dragCounterRef for flicker prevention), clipboard paste
    ├── MessageList.tsx  → DownloadableChip (presigned URL on click), ImageThumbnail (auto-fetch, 200x200), StatusIndicator
    └── ChatPanel.tsx    → Orchestrates attachment flow between input and message list
```

### Data Flow

**Upload (User → Storage → Processing):**

```
1. User sends file via channel adapter (web SDK, Slack, Teams, etc.)
2. Channel adapter normalizes to AttachmentInput { source: stream|base64|url, tenantId, projectId, sessionId }
3. Runtime attachment route validates:
   a. Auth: requireAuth + requireProjectScope + requireSessionOwnership
   b. Rate limit: tenantRateLimit('request')
   c. Config: resolveAttachmentConfig(tenantId, projectId) → maxFileSizeBytes, allowedMimeTypes, piiPolicy
   d. File size: rejects if > maxFileSizeBytes (413)
4. Runtime → MultimodalServiceClient.upload() → multipart POST to multimodal-service
5. Multimodal-service:
   a. Upload rate limiter checks per-tenant sliding window (429 if exceeded)
   b. Store file to storage provider (S3/MinIO/local)
   c. Create Attachment document in MongoDB (status: pending)
   d. Enqueue to BullMQ scan queue
   e. Return { attachmentId, status: 'pending' }
6. BullMQ pipeline runs asynchronously:
   scan (ClamAV) → validate (magic-byte MIME) → process (Tika/Whisper/FFmpeg/PII) → index (Search AI) → cleanup
```

**LLM Injection (Message Preprocessor):**

```
1. User message arrives with attachmentIds[]
2. MessagePreprocessor.preprocess():
   a. Fetch attachment metadata from multimodal-service via HTTP
   b. For each attachment:
      - Images: create ImageContent block with presigned URL
      - Documents/audio/video: inject processedContent as TextContent (capped at 50,000 chars)
      - PII enforcement:
        · 'redact': replace PII spans with [REDACTED:type]
        · 'block':  replace entire content with [File contains PII - blocked by policy]
        · 'allow':  inject raw processedContent
   c. Return EngineReadyMessage { content, contentBlocks[], metadata }
3. Engine processes message with multimodal ContentBlocks
```

**Agent Tool Calls:**

```
1. Agent IR includes attachment tools (get_attachment, list_attachments, upload_attachment, get_attachment_url, route_attachment)
2. AttachmentToolExecutor.execute() dispatches by tool name
3. All tools use MultimodalServiceClient (never query Attachment model directly)
4. route_attachment:
   a. Validates destination name exists in IR-compiled DestinationDef[]
   b. SSRF validation on destination URL (blocks private IPs, localhost, link-local)
   c. POST/PUT file to external destination with configured auth/headers
```

### Sequence Diagram: Upload with Circuit Breaker

```
ChatInput        Runtime Routes    ConfigResolver    MultimodalClient    CircuitBreaker    Multimodal-Service
    │                 │                  │                  │                  │                   │
    │── POST file ──>│                  │                  │                  │                   │
    │                 │── resolve ──────>│                  │                  │                   │
    │                 │                  │── Promise.all ──>│                  │                   │
    │                 │                  │   (project +     │                  │                   │
    │                 │                  │    tenant query)  │                  │                   │
    │                 │<── config ───────│                  │                  │                   │
    │                 │                  │                  │                  │                   │
    │                 │── upload() ─────────────────────────>│                  │                   │
    │                 │                  │                  │── execute() ────>│                   │
    │                 │                  │                  │                  │── isOpen()? ────>│ (check state)
    │                 │                  │                  │                  │<── CLOSED ───────│
    │                 │                  │                  │                  │                   │
    │                 │                  │                  │── POST /internal/attachments ───────>│
    │                 │                  │                  │<── { attachmentId, status } ─────────│
    │                 │                  │                  │                  │                   │
    │                 │                  │                  │── recordSuccess()>│                   │
    │                 │<── { success, attachmentId } ───────│                  │                   │
    │<── 200 ────────│                  │                  │                  │                   │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Every query includes `tenantId` in the filter. Attachment model uses `findOne({ _id, tenantId })`, never `findById`. `ProjectAttachmentConfig` uses `{ projectId, tenantId }`. `TenantAttachmentConfig` uses `{ tenantId }` (unique index). Cross-tenant access returns 404 (not 403) to avoid leaking resource existence. The `tenantIsolationPlugin` is applied to all three Mongoose schemas. Runtime routes pass `X-Tenant-Id` header to multimodal-service for internal auth.                                                                                                |
| 2   | **Data Access Pattern** | Runtime never queries MongoDB directly for attachments -- all access goes through `MultimodalServiceClient` (HTTP). The multimodal-service owns the Attachment model and all CRUD. Config resolution uses Mongoose models directly (`ProjectAttachmentConfig.findOne`, `TenantAttachmentConfig.findOne`) with parallel `Promise.all` for performance. The `AttachmentToolExecutor` depends on the `AttachmentServiceClient` interface (structural typing) for testability.                                                                                                        |
| 3   | **API Contract**        | Standard error envelope: `{ success: true/false, data/error: { code, message } }`. Runtime public API is session-scoped: `/api/projects/:projectId/sessions/:sessionId/attachments/...`. Config API at `/api/projects/:projectId/attachment-config`. Multimodal-service internal API at `/internal/attachments/...`. SDK exposes `uploadAttachment(file) → attachmentId` and `send({attachmentIds})`.                                                                                                                                                                             |
| 4   | **Security Surface**    | Multi-layered: (a) Compile-time SSRF validation blocks private IPs in DESTINATIONS URLs. (b) Runtime SSRF validation in `route_attachment` tool. (c) Magic-byte MIME detection (not extension-based). (d) ClamAV virus scanning via BullMQ. (e) PII detection during processing with configurable policy. (f) Per-tenant upload rate limiting (sliding window). (g) Base64 pre-validation (67MB limit) prevents memory bombs. (h) EXIF stripping on images. (i) Content hash (SHA-256) for dedup. (j) Only named destinations from DSL allowed (no arbitrary URLs in tool calls). |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Upload failures return proper HTTP codes: 413 (too large), 415 (unsupported MIME), 403 (disabled), 429 (rate limited). Processing failures: `processingStatus='failed'` with `processingError` stored, `retryCount` tracked, retry endpoint available. Tool errors: descriptive messages returned as `{ error }` -- `AttachmentToolExecutor` never throws from public methods. Circuit breaker: `MultimodalCircuitBreaker` tracks failures via `HybridCircuitBreakerRegistry`, records success/failure with persistence, and fails fast when circuit is open. |
| 6   | **Failure Modes** | **Multimodal service down**: Circuit breaker transitions CLOSED -> OPEN after threshold failures. Subsequent calls fail fast (no HTTP attempt). HALF_OPEN allows probe to check recovery. **Processing failure**: Attachment stays in `failed` status. Retry endpoint re-enqueues to BullMQ pipeline. `retryCount` prevents infinite retries. **Config resolution failure**: Falls through to PLATFORM_DEFAULTS (hardcoded). **Session validation failure**: Returns 404 (session ownership enforced).                                                        |
| 7   | **Idempotency**   | SHA-256 `contentHash` enables dedup: duplicate files within a tenant share storage but get separate Attachment records. Processing pipeline is idempotent: retry resets status fields and re-enqueues. Upload rate limiter uses sliding window (not counters) for accuracy across pod restarts. Config upsert uses `findOneAndUpdate` with `upsert: true`.                                                                                                                                                                                                    |
| 8   | **Observability** | Structured logging via `createLogger('attachments')`, `createLogger('message-preprocessor')`, `createLogger('multimodal-circuit-breaker')`, `createLogger('attachment-config-route')`. Each processing stage updates status fields (`scanStatus`, `processingStatus`, `embeddingStatus`) for pipeline visibility. Circuit breaker state changes logged with operation, tenant, and duration. Config resolution logs whether project/tenant configs exist.                                                                                                     |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Config resolution: two parallel MongoDB queries via `Promise.all` (project + tenant fetched concurrently). Upload: async processing via BullMQ -- upload returns immediately with `pending` status. Downloads: presigned URLs enable direct S3/storage download (no proxying through runtime or multimodal-service). Image thumbnails: pre-generated during processing (256px default). LLM injection: processedContent capped at 50,000 chars (~12k tokens). Circuit breaker: prevents cascading latency when multimodal service is degraded. |
| 10  | **Migration Path**     | N/A (post-implementation). Current architecture supports extension via: (a) New storage providers via `StorageProvider` interface and `storage-factory.ts`. (b) New processing stages via additional BullMQ workers. (c) New channel adapters via the established media processor/downloader pattern. (d) New destinations via DSL DESTINATIONS block. (e) New processing modes (`full`, `scan-only`, `store-raw`) per upload.                                                                                                                 |
| 11  | **Rollback Plan**      | Database schema is additive (no renames). BullMQ jobs are recoverable: workers poll queues on startup. Storage provider is config-driven (switch via `STORAGE_PROVIDER` env var). Config resolution always falls back to `PLATFORM_DEFAULTS` if DB records are missing. Attachment model uses `_v` field for schema versioning. Circuit breaker state is per-tenant and resets on pod restart (not persisted across deploys).                                                                                                                  |
| 12  | **Test Strategy**      | Detailed coverage below. Source test files span compiler, database, multimodal-service, runtime (unit, integration, E2E), Studio UI, and SDK layers.                                                                                                                                                                                                                                                                                                                                                                                           |

---

## 5. Data Model

### Collections

**`attachments`** -- Core attachment metadata and processing state.

| Field                   | Type                                                  | Purpose                        |
| ----------------------- | ----------------------------------------------------- | ------------------------------ |
| `_id`                   | String (UUIDv7)                                       | Primary key                    |
| `tenantId`              | String                                                | Tenant isolation               |
| `projectId`             | String                                                | Project scoping                |
| `sessionId`             | String                                                | Session scoping                |
| `messageId`             | String (nullable)                                     | Optional message association   |
| `originalFilename`      | String                                                | User-provided filename         |
| `mimeType`              | String                                                | Declared MIME type             |
| `detectedMimeType`      | String (nullable)                                     | Magic-byte detected MIME       |
| `category`              | Enum: image, document, audio, video                   | File classification            |
| `sizeBytes`             | Number                                                | File size                      |
| `contentHash`           | String (nullable)                                     | SHA-256 for dedup              |
| `storageProvider`       | String                                                | Storage backend identifier     |
| `storageKey`            | String                                                | Storage path/key               |
| `storageBucket`         | String                                                | Bucket/container name          |
| `encrypted`             | Boolean (default: true)                               | Encryption at rest flag        |
| `encryptionKeyVersion`  | Number                                                | Key rotation tracking          |
| `scanStatus`            | Enum: pending, clean, infected, error                 | Virus scan state               |
| `scanEngine`            | String (nullable)                                     | Scanner identifier             |
| `scannedAt`             | Date (nullable)                                       | Scan timestamp                 |
| `hasPII`                | Boolean                                               | PII detection result           |
| `piiDetections`         | Array of { type, start, end, value }                  | PII span details               |
| `exifStripped`          | Boolean                                               | EXIF metadata removal flag     |
| `processingMode`        | Enum: full, scan-only, store-raw                      | Processing level               |
| `processingStatus`      | Enum: pending, processing, completed, failed, skipped | Processing state               |
| `processedContent`      | String (nullable)                                     | Extracted text/transcription   |
| `processedContentHash`  | String (nullable)                                     | Hash of processed content      |
| `processingError`       | String (nullable)                                     | Error message on failure       |
| `processingEngine`      | String (nullable)                                     | Processor identifier           |
| `processedAt`           | Date (nullable)                                       | Processing timestamp           |
| `resizedStorageKey`     | String (nullable)                                     | Resized image storage key      |
| `resizedSizeBytes`      | Number (nullable)                                     | Resized image size             |
| `thumbnailStorageKey`   | String (nullable)                                     | Thumbnail storage key          |
| `imageDescription`      | String (nullable)                                     | AI-generated image description |
| `imageDescriptionModel` | String (nullable)                                     | Model used for description     |
| `searchIndexId`         | String (nullable)                                     | Search AI index reference      |
| `searchDocumentId`      | String (nullable)                                     | Search AI document reference   |
| `embeddingStatus`       | Enum: pending, processing, completed, failed, skipped | Embedding state                |
| `embeddedAt`            | Date (nullable)                                       | Embedding timestamp            |
| `retryCount`            | Number (default: 0)                                   | Processing retry counter       |
| `expiresAt`             | Date (nullable)                                       | TTL expiration                 |
| `createdAt`             | Date                                                  | Auto-managed                   |
| `updatedAt`             | Date                                                  | Auto-managed                   |
| `_v`                    | Number                                                | Schema version                 |

**Indexes (8):**

| Index                                                       | Purpose                                 |
| ----------------------------------------------------------- | --------------------------------------- |
| `{ tenantId: 1, sessionId: 1, createdAt: -1 }`              | Primary query: list session attachments |
| `{ tenantId: 1, projectId: 1, messageId: 1 }`               | Message-scoped lookup                   |
| `{ tenantId: 1, contentHash: 1 }` (partial)                 | Deduplication                           |
| `{ expiresAt: 1 }` (TTL, expireAfterSeconds: 0)             | Auto-expire                             |
| `{ scanStatus: 1, createdAt: 1 }`                           | Pipeline: scan queue                    |
| `{ processingStatus: 1, createdAt: 1 }`                     | Pipeline: processing queue              |
| `{ embeddingStatus: 1, createdAt: 1 }`                      | Pipeline: embedding queue               |
| `{ tenantId: 1, projectId: 1, category: 1, createdAt: -1 }` | Browse by category                      |

**`project_attachment_configs`** -- Per-project overrides (nullable fields fall through to tenant/platform).

| Field                   | Type                                       | Purpose                      |
| ----------------------- | ------------------------------------------ | ---------------------------- |
| `_id`                   | String (UUIDv7)                            | Primary key                  |
| `tenantId`              | String                                     | Tenant isolation             |
| `projectId`             | String                                     | Project scoping              |
| `enabled`               | Boolean (nullable)                         | Enable/disable attachments   |
| `maxFileSizeBytes`      | Number (nullable)                          | File size limit override     |
| `allowedMimeTypes`      | String[] (nullable)                        | MIME type whitelist override |
| `piiPolicy`             | Enum (nullable): redact, block, allow      | PII handling override        |
| `defaultProcessingMode` | Enum (nullable): full, metadata_only, skip | Processing mode override     |

Unique index: `{ tenantId: 1, projectId: 1 }`

**`tenant_attachment_configs`** -- Per-tenant defaults.

| Field                      | Type                                     | Default          | Purpose                           |
| -------------------------- | ---------------------------------------- | ---------------- | --------------------------------- |
| `_id`                      | String (UUIDv7)                          | --               | Primary key                       |
| `tenantId`                 | String                                   | --               | Tenant isolation                  |
| `maxFileSizeBytes`         | Number                                   | 20 MB            | File size limit                   |
| `allowedMimeTypes`         | String[]                                 | [] (all allowed) | MIME whitelist                    |
| `blockedMimeTypes`         | String[]                                 | []               | MIME blocklist (takes precedence) |
| `scanEnabled`              | Boolean                                  | true             | Virus scanning toggle             |
| `processingEnabled`        | Boolean                                  | true             | Processing toggle                 |
| `embeddingEnabled`         | Boolean                                  | true             | Search indexing toggle            |
| `piiPolicy`                | Enum: redact, block, allow               | redact           | PII handling policy               |
| `maxAttachmentsPerSession` | Number                                   | 100              | Session quota                     |
| `maxTotalStorageBytes`     | Number                                   | 1 GB             | Tenant storage quota              |
| `retentionDays`            | Object { image, document, audio, video } | 90 each          | Per-category retention            |

Unique index: `{ tenantId: 1 }`

### Config Resolution Chain

```
ProjectAttachmentConfig (per field, nullable = skip)
         │
         ▼
TenantAttachmentConfig (per field)
         │
         ▼
PLATFORM_DEFAULTS (hardcoded in attachment-config-resolver.ts):
  enabled: true
  maxFileSizeBytes: 20 MB
  maxFilesPerSession: 100
  allowedMimeTypes: [17 common types]
  piiPolicy: 'redact'
```

Resolution uses a null-aware `pick()` function with strict `!== null && !== undefined` checks. Project and tenant configs are fetched in parallel via `Promise.all`.

---

## 6. API Design

### Runtime Public API (Session-Scoped)

All routes under `/api/projects/:projectId/sessions/:sessionId/attachments`.

Middleware chain: `authMiddleware` -> `tenantRateLimit('request')` -> `requireProjectScope('projectId')` -> `requireSessionOwnership` (SDK users can only access their own sessions).

| Method | Path                                | Purpose                            | Auth                   |
| ------ | ----------------------------------- | ---------------------------------- | ---------------------- |
| POST   | `/attachments`                      | Upload file (multipart via Busboy) | Session owner or admin |
| GET    | `/attachments`                      | List session attachments           | Session owner or admin |
| GET    | `/attachments/:attachmentId`        | Get attachment detail              | Session owner or admin |
| GET    | `/attachments/:attachmentId/url`    | Get presigned download URL         | Session owner or admin |
| GET    | `/attachments/:attachmentId/status` | Get processing status              | Session owner or admin |
| DELETE | `/attachments/:attachmentId`        | Delete attachment                  | Session owner or admin |

### Runtime Config API (Project-Scoped)

Mounted at `/api/projects/:projectId/attachment-config`.

| Method | Path | Purpose                                     | Auth               |
| ------ | ---- | ------------------------------------------- | ------------------ |
| GET    | `/`  | Get resolved config + raw project overrides | `attachment:read`  |
| PUT    | `/`  | Upsert project-level overrides              | `attachment:write` |

### Multimodal Service Internal API

All routes under `/internal/attachments`. Auth via `X-Tenant-Id` header (internal service mesh only).

| Method | Path                  | Purpose                             |
| ------ | --------------------- | ----------------------------------- |
| POST   | `/`                   | Upload file (multipart)             |
| GET    | `/:id`                | Get attachment metadata             |
| GET    | `/session/:sessionId` | List by session (with limit/offset) |
| GET    | `/:id/url`            | Get presigned download URL          |
| GET    | `/:id/status`         | Get processing status               |
| DELETE | `/:id`                | Delete single attachment            |
| DELETE | `/session/:sessionId` | Delete all session attachments      |
| POST   | `/:id/retry`          | Retry failed processing             |

### Agent Tool Definitions

| Tool Name            | Parameters                                   | Returns                                                                             |
| -------------------- | -------------------------------------------- | ----------------------------------------------------------------------------------- |
| `get_attachment`     | `attachmentId`                               | `{ id, filename, mimeType, category, processingStatus, content, imageDescription }` |
| `list_attachments`   | `limit?`, `offset?`                          | `[{ id, filename, mimeType, category, processingStatus }]`                          |
| `upload_attachment`  | `base64Data`, `filename`, `mimeType`         | `{ attachmentId, status }`                                                          |
| `get_attachment_url` | `attachmentId`, `disposition?`, `expiresIn?` | `{ url, expiresInSeconds }`                                                         |
| `route_attachment`   | `attachmentId`, `destinationName`            | `{ routed: true, destination, statusCode }`                                         |

### Error Responses

| Code | Error Code             | Description                                    |
| ---- | ---------------------- | ---------------------------------------------- |
| 413  | `FILE_TOO_LARGE`       | Exceeds maxFileSizeBytes                       |
| 415  | `UNSUPPORTED_TYPE`     | MIME type not in allowedMimeTypes              |
| 403  | `ATTACHMENTS_DISABLED` | Attachments disabled for project               |
| 429  | `RATE_LIMITED`         | Upload rate limit exceeded                     |
| 404  | `NOT_FOUND`            | Attachment not found (or cross-tenant/session) |
| 401  | `AUTH_REQUIRED`        | Missing authentication or tenant context       |
| 400  | `VALIDATION_ERROR`     | Invalid config update payload                  |
| 503  | `SERVICE_UNAVAILABLE`  | Circuit breaker open (multimodal service down) |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Upload, delete, and config update operations logged via structured loggers. Processing stage transitions captured in Attachment status fields. Circuit breaker state changes logged with tenant ID and operation.

- **Rate Limiting**: Per-tenant sliding window on uploads via `UploadRateLimiter` in multimodal-service. Runtime routes also apply platform-level `tenantRateLimit('request')`. Configurable via `TenantAttachmentConfig.quotas`.

- **Caching**: Config resolution is NOT cached -- always hits DB for fresh values. This is intentional: config changes must take effect immediately without cache invalidation. Presigned URLs are ephemeral (1-hour default). Storage provider metadata is cached at service init.

- **Encryption**: Files encrypted at rest via storage provider encryption. `encrypted` flag and `encryptionKeyVersion` tracked per attachment. PII detections stored in DB for policy enforcement without re-scanning.

- **GDPR Compliance**: Cascade delete via `packages/database/src/cascade/cascade-delete.ts` handles right-to-erasure. TTL-based auto-expiry via MongoDB TTL index. Configurable `retentionDays` per category per tenant. Expiry sweep job (hourly BullMQ) enqueues cleanup for expiring attachments.

- **Channel Adapters**: Each channel (Slack, Teams, WhatsApp, Telegram, Messenger, Instagram, LINE, email, Twilio SMS) has a dedicated media processor and/or media downloader that normalizes platform-specific file formats into `AttachmentInput`. Located in `apps/runtime/src/channels/adapters/`.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                    | Type                                                                         | Risk                                       |
| ----------------------------- | ---------------------------------------------------------------------------- | ------------------------------------------ |
| `@agent-platform/database`    | MongoDB models (Attachment, ProjectAttachmentConfig, TenantAttachmentConfig) | Low -- stable                              |
| `@agent-platform/shared`      | Types (AttachmentCategory, AttachmentConfig, provider interfaces)            | Low -- stable                              |
| `@agent-platform/shared-auth` | Session ownership, project scope validation                                  | Low -- stable                              |
| `@abl/compiler/platform`      | Logger, ContentBlock types, IR schema                                        | Low -- stable                              |
| `@agent-platform/config`      | Config composition and loading                                               | Low -- stable                              |
| BullMQ + Redis                | Processing pipeline queues                                                   | Low -- well-tested infra                   |
| MongoDB                       | Data persistence, TTL indexes                                                | Low -- core infrastructure                 |
| Apache Tika                   | Document parsing (external service)                                          | Medium -- requires separate deployment     |
| Whisper                       | Audio transcription (external service)                                       | Medium -- requires GPU/separate deployment |
| ClamAV                        | Virus scanning (external daemon)                                             | Medium -- requires separate deployment     |
| FFmpeg                        | Video processing (system binary)                                             | Low -- well-established                    |
| External channel APIs         | Slack, Teams, WhatsApp, etc. file download                                   | High -- external, rate-limited             |

### Downstream (depends on this feature)

| Consumer            | Impact                                                                           |
| ------------------- | -------------------------------------------------------------------------------- |
| `apps/runtime`      | Attachment routes, tool executor, message preprocessor, channel adapters         |
| `apps/studio`       | ChatInput (upload UI), MessageList (display/download), ChatPanel (orchestration) |
| `packages/web-sdk`  | `ChatClient.uploadAttachment()`, `send({attachmentIds})`                         |
| `packages/compiler` | `ATTACHMENTS:` and `DESTINATIONS:` DSL compilation                               |
| `packages/core`     | `parseAttachments()`, `parseDestinations()` in parser                            |
| Search AI           | Indexing of processed attachment content via `attachment-search-producer`        |

---

## 9. Open Questions & Known Gaps

1. **External processing services in CI**: Tika, Whisper, ClamAV, and FFmpeg are not available in the CI environment. Processing-stage tests mock these services. This is the primary E2E coverage gap.

2. **Storage provider E2E testing**: S3/MinIO/GCS/Azure Blob providers are unit-tested with mocks. No real cloud storage integration tests exist in CI.

3. **Video processing depth**: `video-processor-ffmpeg.ts` exists but video support is the least mature processing path compared to images and documents.

4. **Image description model**: The `imageDescription` and `imageDescriptionModel` fields are in the schema but the vision model integration for auto-description is not fully wired.

5. **Multimodal service port discrepancy**: The multimodal-service Dockerfile sets port 3006. The `MultimodalServiceClient` defaults to `http://multimodal-service:3006`. The user-provided architecture overview referenced port 8123 -- the actual deployed port is 3006.

---

## 10. Test Coverage

### Source Test Files (non-dist, .ts/.tsx only)

**Compiler (Tier 1):**

- `packages/compiler/src/__tests__/attachments.test.ts` -- ATTACHMENTS/DESTINATIONS parsing and compilation

**Database (Tier 3):**

- `packages/database/src/__tests__/attachment-model.test.ts` -- Schema validation, indexes
- `packages/database/src/__tests__/message-model-attachments.test.ts` -- Message-attachment relationship

**Multimodal Service (Tier 4):**

- `apps/multimodal-service/src/__tests__/attachment-routes.test.ts` -- Internal API routes
- `apps/multimodal-service/src/__tests__/attachment-rate-limit.test.ts` -- Upload rate limiting
- `apps/multimodal-service/src/__tests__/attachment-retry.test.ts` -- Retry processing
- `apps/multimodal-service/src/__tests__/upload-modes.test.ts` -- Processing mode variants
- `apps/multimodal-service/src/__tests__/multimodal-service.test.ts` -- Service unit tests
- `apps/multimodal-service/src/__tests__/pii-pipeline-integration.test.ts` -- PII detection pipeline
- `apps/multimodal-service/src/jobs/__tests__/scan-job.test.ts` -- ClamAV scan worker
- `apps/multimodal-service/src/jobs/__tests__/validate-job.test.ts` -- MIME validation worker
- `apps/multimodal-service/src/jobs/__tests__/process-job.test.ts` -- Processing worker
- `apps/multimodal-service/src/jobs/__tests__/process-job-pii.test.ts` -- PII in processing
- `apps/multimodal-service/src/jobs/__tests__/index-job.test.ts` -- Search AI indexing worker
- `apps/multimodal-service/src/jobs/__tests__/cleanup-job.test.ts` -- Storage cleanup worker
- `apps/multimodal-service/src/jobs/__tests__/expiry-sweep-job.test.ts` -- TTL sweep
- `apps/multimodal-service/src/storage/__tests__/s3-storage.test.ts` -- S3 provider
- `apps/multimodal-service/src/storage/__tests__/local-storage.test.ts` -- Local provider
- `apps/multimodal-service/src/storage/__tests__/storage-factory.test.ts` -- Factory pattern
- `apps/multimodal-service/src/security/__tests__/mime-validator.test.ts` -- Magic-byte MIME
- `apps/multimodal-service/src/security/__tests__/clamav-scanner.test.ts` -- ClamAV integration
- `apps/multimodal-service/src/security/__tests__/ssrf-validator.test.ts` -- SSRF validation
- `apps/multimodal-service/src/security/__tests__/upload-rate-limiter.test.ts` -- Rate limiter
- `apps/multimodal-service/src/processing/__tests__/image-processor.test.ts` -- Image resize/thumb
- `apps/multimodal-service/src/processing/__tests__/document-parser-tika.test.ts` -- Tika parsing
- `apps/multimodal-service/src/processing/__tests__/transcriber-whisper.test.ts` -- Whisper
- `apps/multimodal-service/src/processing/__tests__/video-processor-ffmpeg.test.ts` -- FFmpeg
- `apps/multimodal-service/src/services/__tests__/attachment-search-producer.test.ts` -- Search AI

**Runtime (Tier 5):**

- `apps/runtime/src/attachments/__tests__/attachment-config-resolver.test.ts` -- 3-tier config resolution
- `apps/runtime/src/attachments/__tests__/multimodal-service-client.test.ts` -- HTTP client
- `apps/runtime/src/attachments/__tests__/message-preprocessor.test.ts` -- ContentBlock[] generation
- `apps/runtime/src/attachments/__tests__/message-preprocessor-pii.test.ts` -- PII policy enforcement
- `apps/runtime/src/tools/__tests__/attachment-tool-executor.test.ts` -- Core tool dispatch
- `apps/runtime/src/tools/__tests__/attachment-tool-executor-route.test.ts` -- route_attachment tool
- `apps/runtime/src/tools/__tests__/attachment-tool-executor-upload.test.ts` -- upload_attachment tool
- `apps/runtime/src/tools/__tests__/attachment-tool-executor-url.test.ts` -- get_attachment_url tool
- `apps/runtime/src/tools/__tests__/tool-input-validator-attachment.test.ts` -- Param validation
- `apps/runtime/src/__tests__/multimodal-circuit-breaker.test.ts` -- Circuit breaker
- `apps/runtime/src/__tests__/flow-step-await-attachment.test.ts` -- AWAIT_ATTACHMENT flow step
- `apps/runtime/src/__tests__/inbound-worker-attachments.test.ts` -- Inbound worker integration
- `apps/runtime/src/__tests__/adapters/slack-file-attachments.test.ts` -- Slack adapter
- `apps/runtime/src/__tests__/adapters/email-attachment-processor.test.ts` -- Email adapter
- `apps/runtime/src/__tests__/adapters/msteams-file-attachments.test.ts` -- Teams adapter
- `apps/runtime/src/__tests__/adapters/whatsapp-file-attachments.test.ts` -- WhatsApp adapter
- `apps/runtime/src/services/agent-transfer/__tests__/message-bridge-attachments.test.ts` -- Agent transfer

**Runtime E2E (Tier 5):**

- `apps/runtime/src/__tests__/attachment-tools.e2e.test.ts` -- Tool execution E2E
- `apps/runtime/src/__tests__/attachment-pii.e2e.test.ts` -- PII pipeline E2E
- `apps/runtime/src/__tests__/attachment-advanced.e2e.test.ts` -- Advanced scenarios E2E
- `apps/runtime/src/__tests__/attachment-ownership-authz.test.ts` -- Session ownership authz

**Studio UI (Tier 7):**

- `apps/studio/src/__tests__/chat-input-attachments.test.tsx` -- Upload UI
- `apps/studio/src/__tests__/message-list-attachments.test.tsx` -- Display/download UI
- `apps/studio/src/__tests__/retention-attachment-cascade.test.ts` -- Cascade deletion

**Cross-Package:**

- `packages/observatory/src/__tests__/trace-events-attachments.test.ts` -- Trace events
- `packages/agent-transfer/src/__tests__/unit/event-handler-attachments.test.ts` -- Agent transfer events
- `packages/database/src/__tests__/cascade-delete-modules.test.ts` -- Cascade delete (includes attachments)
- `packages/database/src/__tests__/mongo-cascade.test.ts` -- Cascade delete infrastructure

**E2E Test Harness:**

- `apps/runtime/src/__tests__/helpers/multimodal-service-harness.ts` -- Shared E2E infrastructure

---

## Post-Implementation Notes

### Attachment Settings UI (2026-03-22)

The Studio attachment settings UI was implemented as a sub-feature (GAP-001 from the parent feature spec). This added:

- **`AttachmentSettingsTab`** component in `apps/studio/src/components/settings/` — renders 5 editable fields (enabled, maxFileSizeBytes, allowedMimeTypes, piiPolicy, defaultProcessingMode) and 1 read-only field (maxFilesPerSession) with override/inherited badges and per-field reset-to-default.
- **Studio proxy route** at `apps/studio/src/app/api/projects/[id]/attachment-config/route.ts` — forwards GET/PUT to runtime.
- **Runtime enhancements**: Zod validation hardened (500 MB upper bound, MIME regex, 50-item array cap), `attachment:read` added to developer/viewer roles, `enabled: false` blocks upload endpoint (403 ATTACHMENTS_DISABLED).
- **Test coverage**: 23 unit tests, 4 integration (proxy), 14 validation integration, 10 API E2E, 6 Playwright browser E2E.

The parent feature status was promoted from ALPHA → BETA with this addition.

---

## 11. References

- Platform invariants: `CLAUDE.md` (tenant isolation, centralized auth, stateless distributed)
- Attachment config resolution changes: `docs/specs/attachment-config-resolution.changes.md`
- PII E2E changes: `docs/specs/attachment-pii-e2e.changes.md`
- Core attachment tooling changes: `docs/specs/core-attachment-tooling.changes.md`
- Studio attachment UX changes: `docs/specs/phase-2a-studio-attachment-ux.changes.md`
- Advanced attachments changes: `docs/specs/phase-3a-advanced-attachments.changes.md`
- Related features: Connectors (tool execution pipeline), Search AI (embedding indexing), Omnichannel (channel adapters)
