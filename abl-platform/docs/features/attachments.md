# Feature: Attachments

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: STABLE
**Feature Area(s)**: `customer experience`, `agent lifecycle`, `integrations`, `governance`, `enterprise`
**Package(s)**: `apps/multimodal-service`, `apps/runtime`, `apps/studio`, `packages/shared`, `packages/database`, `packages/core`, `packages/compiler`, `packages/web-sdk`
**Owner(s)**: Platform team
**Testing Guide**: [docs/testing/attachments.md](../testing/attachments.md)
**Last Updated**: 2026-03-25

---

## 1. Introduction / Overview

### Problem Statement

Agents that can only receive and produce text are limited in real-world interactions. Users regularly need to share documents, images, audio recordings, and video clips with agents, and agents need to understand, reference, route, and respond to that multimodal content. Without a unified attachment pipeline, each channel, SDK, and agent would need its own ad-hoc file handling, leading to inconsistent security scanning, no centralized PII detection, duplicated storage logic, and no way for agent authors to declaratively define what files their agent accepts.

### Goal Statement

Provide an end-to-end attachment pipeline that handles upload, virus scanning, MIME validation, content processing (OCR, transcription, thumbnail generation), PII detection and redaction, LLM context injection, agent tool access, and outbound routing to external systems -- all governed by a 3-tier configuration model (project, tenant, platform defaults) and accessible from every channel, SDK, and Studio.

### Summary

The Attachments feature is a 7-tier system spanning the full stack:

1. **DSL Layer** -- `ATTACHMENTS:` and `DESTINATIONS:` sections in the ABL DSL let agent authors declaratively define accepted file types, size limits, processing options, and named external routing targets.
2. **Shared Types** -- Provider interfaces (`StorageProvider`, `ScanProvider`, `DocumentParser`, `TranscriptionProvider`, `VideoProcessor`) and core types (`AttachmentConfig`, `AttachmentInput`, `AttachmentCategory`) in `packages/shared`.
3. **Database Layer** -- Three MongoDB collections (`attachments`, `project_attachment_configs`, `tenant_attachment_configs`) with tenant isolation, TTL expiry, deduplication indexes, and processing pipeline indexes.
4. **Multimodal Service** -- A dedicated microservice (`apps/multimodal-service`) with a 5-stage BullMQ pipeline (scan, validate, process, index, cleanup), pluggable storage backends (local, S3, MinIO), and per-tenant rate limiting.
5. **Runtime Layer** -- 3-tier config resolution, HTTP client with circuit breaker to multimodal-service, message preprocessor that transforms attachments into LLM-ready `ContentBlock[]` with PII policy enforcement, 5 agent tools, and channel adapters for 10+ channels.
6. **SDK Layer** -- `uploadAttachment()` and `send()` with `attachmentIds` in the web SDK, plus `AttachmentRef` types on messages.
7. **Studio Layer** -- `ChatInput` with drag-drop, clipboard paste, and file picker; `MessageList` with thumbnails and download links; WebSocket events for real-time status updates.

---

## 2. Scope

### Goals

- Accept file uploads from any channel (web SDK, Slack, Teams, WhatsApp, email, Telegram, Messenger, Instagram, LINE, Twilio SMS) and route them through a unified processing pipeline.
- Scan all uploads for viruses (ClamAV), validate MIME types via magic-byte detection, and detect PII in processed content.
- Provide agents with 5 built-in tools (`get_attachment`, `list_attachments`, `upload_attachment`, `get_attachment_url`, `route_attachment`) so they can inspect, create, and route files programmatically.
- Let agent authors declare accepted attachment types and named external destinations in the DSL.
- Enforce configurable PII policies (redact, block, allow) before attachment content reaches the LLM.
- Support 3-tier configuration (project overrides, tenant defaults, platform defaults) for file size limits, MIME types, PII policy, and processing mode.

### Non-Goals (Out of Scope)

- Real-time collaborative editing of uploaded documents.
- Inline rendering of video/audio players in the agent chat (thumbnails and download links are provided instead).
- End-to-end encryption where the platform cannot access file contents (the platform must read files for processing, scanning, and PII detection).
- Custom ML model hosting for content analysis (relies on external services: ClamAV, Tika, Whisper, FFmpeg).

---

## 3. User Stories

1. As an **end user**, I want to upload a PDF to the chat so that the agent can read and answer questions about my document.
2. As an **end user**, I want to paste a screenshot into the chat so that the agent can see what I am describing.
3. As an **agent author**, I want to declare that my agent accepts only images and PDFs under 10 MB so that users get clear error messages for unsupported files.
4. As an **agent author**, I want to route uploaded documents to our CRM via a named destination so that the agent can file documents without custom code.
5. As a **project admin**, I want to configure PII policy to "block" for a sensitive project so that documents containing PII never reach the LLM.
6. As a **tenant admin**, I want to set file size limits and allowed MIME types at the tenant level so that all projects inherit safe defaults.
7. As an **agent** (in-conversation), I want to use the `get_attachment` tool to read the text content of an uploaded document so that I can summarize it.
8. As an **agent** (in-conversation), I want to use the `route_attachment` tool to send a user's file to an external webhook with SSRF protection.

---

## 4. Functional Requirements

1. **FR-1**: The system must accept file uploads via multipart/form-data (HTTP) and base64 encoding (agent tool), validate MIME type and file size, and store the file in the configured storage backend.
2. **FR-2**: The system must scan every uploaded file for viruses using ClamAV (when scan is enabled) and block infected files from reaching the LLM.
3. **FR-3**: The system must validate MIME types using magic-byte detection, not just the declared Content-Type or file extension.
4. **FR-4**: The system must process files based on category: images (resize, thumbnail, optional description), documents (text extraction via Tika), audio (transcription via Whisper), video (keyframe extraction via FFmpeg + transcription).
5. **FR-5**: The system must detect PII in processed text content and store detection metadata (`piiDetections[]`, `hasPII` flag) on the attachment record.
6. **FR-6**: The system must enforce the resolved PII policy (`redact`, `block`, `allow`) when injecting attachment content into the LLM prompt -- redacting detected PII tokens, blocking the entire content, or passing it through.
7. **FR-7**: The system must resolve attachment configuration via a 3-tier chain: project config, then tenant config, then platform defaults, with each field resolved independently.
8. **FR-8**: The system must provide 5 agent tools (`get_attachment`, `list_attachments`, `upload_attachment`, `get_attachment_url`, `route_attachment`) that agents can call during conversation.
9. **FR-9**: The `route_attachment` tool must validate destination URLs against SSRF patterns (private IPs, localhost, link-local) at both compile time and runtime.
10. **FR-10**: The system must parse `ATTACHMENTS:` and `DESTINATIONS:` DSL sections into AST, compile them into IR, and make them available to the runtime.
11. **FR-11**: The system must support TTL-based attachment expiry with configurable retention days per category.
12. **FR-12**: The system must enforce session-scoped access -- attachments for one session must not be accessible from another session's scope.
13. **FR-13**: The system must enforce tenant isolation on all attachment queries using `findOne({ _id, tenantId })`, never `findById()`.
14. **FR-14**: The system must support per-tenant upload rate limiting via a sliding-window rate limiter.
15. **FR-15**: The system must index processed content into Search AI for embedding-based retrieval (when embedding is enabled).

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                 |
| -------------------------- | ------------ | --------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Per-project attachment config, DSL attachment/destination definitions |
| Agent lifecycle            | PRIMARY      | Agents declare accepted types, use 5 tools, receive file content      |
| Customer experience        | PRIMARY      | Users upload files in chat, see thumbnails, download processed files  |
| Integrations / channels    | PRIMARY      | 10+ channel adapters extract and forward file attachments             |
| Observability / tracing    | SECONDARY    | Processing status tracking, retry counts, error states                |
| Governance / controls      | PRIMARY      | PII detection/redaction, virus scanning, MIME validation, SSRF block  |
| Enterprise / compliance    | PRIMARY      | Configurable retention, GDPR cascade delete, encryption at rest       |
| Admin / operator workflows | PRIMARY      | Tenant config API + admin UI (AttachmentConfigTab)                    |

### Related Feature Integration Matrix

| Related Feature  | Relationship Type | Why It Matters                                                | Key Touchpoints                                         | Current State |
| ---------------- | ----------------- | ------------------------------------------------------------- | ------------------------------------------------------- | ------------- |
| Channels         | depends on        | Channel adapters extract files from platform-native formats   | `*-media-processor.ts`, `*-file-downloader.ts` adapters | Implemented   |
| Search AI        | emits into        | Processed content is indexed for embedding-based retrieval    | `attachment-search-producer.ts`, index-job              | Implemented   |
| ABL Language     | configured by     | `ATTACHMENTS:` and `DESTINATIONS:` DSL sections               | Parser, compiler, IR schema                             | Implemented   |
| Sessions         | shares data with  | Attachments are session-scoped, session ownership enforced    | Session lookup in routes, ownership middleware          | Implemented   |
| Agent Tools      | extends           | 5 attachment-specific tools added to the tool executor system | `attachment-tool-executor.ts`                           | Implemented   |
| Guardrails / PII | depends on        | PII detection uses `detectPII()` from compiler platform       | `process-job.ts`, `message-preprocessor.ts`             | Implemented   |
| Web SDK          | extends           | `uploadAttachment()` and `attachmentIds` in send options      | `ChatClient.ts`, `types.ts`                             | Implemented   |
| GDPR / Retention | depends on        | Cascade delete, TTL expiry, right-to-erasure flows            | Retention service, expiry-sweep-job                     | Implemented   |

---

## 6. Design Considerations (Optional)

### Studio UX

- **ChatInput**: Supports three file input modes -- file picker button, drag-and-drop onto the chat area, and clipboard paste (Ctrl+V / Cmd+V). Files are uploaded immediately on selection and show inline progress indicators with cancel/remove controls.
- **MessageList**: Displays thumbnails for image attachments, file icons with filenames for documents/audio/video, and download links for completed attachments.
- **Upload state management**: Uses local component state with `pendingFiles` array tracking `localId`, `uploading` boolean, server-assigned `id`, and `error` string per file.

### Processing Pipeline UX

- Files show real-time status updates via WebSocket events: `pending` -> `processing` -> `completed`/`failed`.
- Failed processing can be retried via the `/retry` endpoint.

---

## 7. Technical Considerations (Optional)

### Architecture Decisions

- **Dedicated microservice**: The multimodal-service is a separate Express service (port 3006) to isolate CPU/memory-intensive file processing from the runtime. Communication is via internal HTTP with `X-Tenant-Id` / `X-Project-Id` headers.
- **BullMQ pipeline**: The 5-stage processing pipeline (scan, validate, process, index, cleanup) uses BullMQ for reliable async job processing with automatic retries and dead-letter handling.
- **Circuit breaker**: The runtime wraps all multimodal-service HTTP calls in a `MultimodalCircuitBreaker` that opens on repeated failures to prevent cascading latency.
- **Storage abstraction**: The `StorageProvider` interface supports local filesystem, S3, MinIO, GCS, Azure Blob, and GridFS backends via a factory pattern.
- **Busboy streaming**: The runtime public API uses Busboy for multipart parsing (not multer) to support streaming uploads with size limits before buffering the entire file.

### Processing Modes

- `full`: Complete pipeline -- scan, validate, process (extract text/thumbnail/transcribe), index for embedding.
- `scan-only`: Virus scan and MIME validation only -- no text extraction or embedding.
- `store-raw`: Store the file without any processing -- useful for passthrough routing.

### Content Injection

- The `MessagePreprocessor` transforms attachments into `ContentBlock[]` before the LLM call:
  - **Images**: Converted to `ImageContent` blocks (base64 for local files, URL for S3 presigned URLs).
  - **Documents/Audio/Video**: Processed text content prepended to the message with `[Attached document: filename]` headers.
- Content is truncated at 50,000 characters (~12k tokens) to prevent oversized payloads.
- Filenames are sanitized to prevent prompt injection via crafted filenames.

---

## 8. How to Consume

### Studio UI

- **Chat page**: Users can attach files via the paperclip button, drag-and-drop, or paste in `ChatInput`. Uploaded files appear as inline chips showing upload progress, then thumbnails/file icons after completion.
- **Message history**: `MessageList` renders attachment thumbnails for images and file download links for other categories.

### API (Runtime)

| Method | Path                                                                            | Purpose                                             |
| ------ | ------------------------------------------------------------------------------- | --------------------------------------------------- |
| POST   | `/api/projects/:projectId/sessions/:sessionId/attachments`                      | Upload attachment (multipart/form-data)             |
| GET    | `/api/projects/:projectId/sessions/:sessionId/attachments`                      | List attachments for session                        |
| GET    | `/api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId`        | Get attachment metadata                             |
| GET    | `/api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId/url`    | Get presigned download URL                          |
| GET    | `/api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId/status` | Get processing status (scan, processing, embedding) |
| POST   | `/api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId/retry`  | Retry failed processing                             |
| DELETE | `/api/projects/:projectId/sessions/:sessionId/attachments/:attachmentId`        | Delete attachment                                   |
| GET    | `/api/projects/:projectId/attachment-config`                                    | Get resolved attachment config                      |
| PUT    | `/api/projects/:projectId/attachment-config`                                    | Upsert project-level attachment config overrides    |
| GET    | `/api/platform/admin/tenant-attachment-config?tenantId=<id>`                    | Get tenant attachment config (platform admin only)  |
| PUT    | `/api/platform/admin/tenant-attachment-config?tenantId=<id>`                    | Update tenant attachment config (platform admin)    |

### API (Studio)

| Method | Path                                     | Purpose                                       |
| ------ | ---------------------------------------- | --------------------------------------------- |
| POST   | `/api/runtime/sessions/[id]/attachments` | Studio proxy for attachment upload to runtime |

### Studio Settings

- **Attachment Settings tab**: Navigate to Project Settings → Attachments. Admins can view effective config (resolved from project → tenant → platform defaults), override individual fields (enabled, max file size, allowed MIME types, PII policy, processing mode), and reset per-field to inherit defaults. Visual badges indicate "Custom override" vs "Inherited default" per field.

### Admin Portal

- **Tenant config UI**: Navigate to Admin Portal → Tenants → [tenant] → Attachments tab. Platform admins can view and update per-tenant attachment settings (file size limits, MIME types, scan/processing/embedding toggles, retention policies).
- **API chain**: Admin UI → Next.js proxy (`/api/admin/tenant-attachment-config`) → Runtime proxy (`/api/platform/admin/tenant-attachment-config`) → Multimodal Admin (`/admin/config/:tenantId`). 4-layer auth: platformAdminAuthMiddleware + rate limit + requirePlatformAdmin + IP allowlist.

### Channel / SDK / Voice / A2A / MCP Integration

- **Web SDK**: `ChatClient.uploadAttachment(file: File)` returns an attachment ID. `ChatClient.send(text, { attachmentIds })` includes attachment references in the message.
- **Channel adapters**: Each channel adapter has a dedicated media processor/file downloader that extracts files from platform-native formats:
  - Slack: `slack-file-processor.ts`, `slack-file-downloader.ts`
  - MS Teams: `msteams-file-processor.ts`, `msteams-file-downloader.ts`
  - WhatsApp: `whatsapp-media-processor.ts`
  - Telegram: `telegram-media-processor.ts`, `telegram-media-downloader.ts`
  - Messenger: `messenger-media-processor.ts`, `messenger-media-downloader.ts`
  - Instagram: `instagram-media-processor.ts`, `instagram-media-downloader.ts`
  - Twilio SMS: `twilio-sms-media-processor.ts`, `twilio-sms-media-downloader.ts`
  - LINE: `line-media-processor.ts`, `line-media-downloader.ts`
  - Email: `email-attachment-processor.ts`
- **SDK types**: `AttachmentRef` (id, filename, mimeType, sizeBytes, category) and `SendMessageOptions.attachmentIds` in `packages/web-sdk/src/core/types.ts`.
- **WebSocket events**: Studio receives attachment status updates via WebSocket context (`attachmentIds`, `attachmentFilenames`, `attachmentMimeTypes` on message frames).

---

## 9. Data Model

### Collections / Tables

```text
Collection: attachments
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - sessionId: string (required, indexed)
  - messageId: string | null
  - originalFilename: string (required)
  - mimeType: string (required, declared)
  - detectedMimeType: string | null (magic-byte detected)
  - category: 'image' | 'document' | 'audio' | 'video' (required)
  - sizeBytes: number (required, min: 1)
  - contentHash: string | null (SHA-256 for dedup)
  - storageProvider: string (required)
  - storageKey: string (required)
  - storageBucket: string (required)
  - encrypted: boolean (default: true)
  - encryptionKeyVersion: number (default: 0)
  - scanStatus: 'pending' | 'clean' | 'infected' | 'error' (default: 'pending')
  - scanEngine: string | null
  - scannedAt: Date | null
  - hasPII: boolean (default: false)
  - piiDetections: [{ type: string, start: number, end: number, value: string }]
  - exifStripped: boolean (default: false)
  - processingMode: 'full' | 'scan-only' | 'store-raw' (default: 'full')
  - processingStatus: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' (default: 'pending')
  - processedContent: string | null (extracted text)
  - processedContentHash: string | null
  - processingError: string | null
  - processingEngine: string | null
  - processedAt: Date | null
  - resizedStorageKey: string | null (image-specific)
  - resizedSizeBytes: number | null
  - thumbnailStorageKey: string | null
  - imageDescription: string | null (LLM-generated)
  - imageDescriptionModel: string | null
  - searchIndexId: string | null (Search AI integration)
  - searchDocumentId: string | null
  - embeddingStatus: 'pending' | 'processing' | 'completed' | 'failed' | 'skipped' (default: 'pending')
  - embeddedAt: Date | null
  - retryCount: number (default: 0)
  - expiresAt: Date | null (TTL)
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
  - _v: number (default: 1)
Indexes:
  - { tenantId: 1, sessionId: 1, createdAt: -1 }  -- Primary: list by session
  - { tenantId: 1, projectId: 1, messageId: 1 }    -- Lookup by message
  - { tenantId: 1, contentHash: 1 } (partial)       -- Deduplication
  - { expiresAt: 1 } (TTL, expireAfterSeconds: 0)   -- Auto-expiry
  - { scanStatus: 1, createdAt: 1 }                 -- Pipeline: pending scans
  - { processingStatus: 1, createdAt: 1 }           -- Pipeline: pending processing
  - { embeddingStatus: 1, createdAt: 1 }            -- Pipeline: pending embedding
  - { tenantId: 1, projectId: 1, category: 1, createdAt: -1 } -- Browse by category
Plugins: tenantIsolationPlugin
```

```text
Collection: project_attachment_configs
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required)
  - projectId: string (required)
  - enabled: boolean | null (null = inherit)
  - maxFileSizeBytes: number | null (null = inherit)
  - allowedMimeTypes: string[] | null (null = inherit)
  - piiPolicy: 'redact' | 'block' | 'allow' | null (null = inherit)
  - defaultProcessingMode: 'full' | 'metadata_only' | 'skip' | null (null = inherit)
  - _v: number
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
Indexes:
  - { tenantId: 1, projectId: 1 } (unique)
Plugins: tenantIsolationPlugin
```

```text
Collection: tenant_attachment_configs
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required)
  - maxFileSizeBytes: number (default: 20 MB)
  - allowedMimeTypes: string[] (default: [])
  - blockedMimeTypes: string[] (default: [])
  - scanEnabled: boolean (default: true)
  - processingEnabled: boolean (default: true)
  - embeddingEnabled: boolean (default: true)
  - piiPolicy: 'redact' | 'block' | 'allow' (default: 'redact')
  - maxAttachmentsPerSession: number (default: 100)
  - maxTotalStorageBytes: number (default: 1 GB)
  - retentionDays: { image: 90, document: 90, audio: 90, video: 90 }
  - _v: number
  - createdAt: Date (auto)
  - updatedAt: Date (auto)
Indexes:
  - { tenantId: 1 } (unique)
Plugins: tenantIsolationPlugin
```

### Key Relationships

- **Attachment -> Session**: `sessionId` links attachment to the runtime session. Session ownership middleware enforces that SDK users can only access their own session's attachments.
- **Attachment -> Project**: `projectId` links to the project. Project-scoped routes enforce `projectId` in all queries.
- **Attachment -> Message**: Optional `messageId` links to the specific message that triggered the upload.
- **Attachment -> Search AI**: `searchIndexId` and `searchDocumentId` link to the Search AI embedding index after the index-job completes.
- **Attachment -> Storage**: `storageProvider`, `storageKey`, `storageBucket` reference the physical file location.
- **ProjectAttachmentConfig -> TenantAttachmentConfig -> Platform Defaults**: 3-tier config resolution chain.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                   | Purpose                                                                                                   |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/shared/src/attachments/types.ts`                             | Core types: `AttachmentCategory`, `ScanStatus`, `ProcessingStatus`, `AttachmentInput`, `AttachmentConfig` |
| `packages/shared/src/attachments/interfaces/storage-provider.ts`       | `StorageProvider` interface                                                                               |
| `packages/shared/src/attachments/interfaces/scan-provider.ts`          | `ScanProvider` interface                                                                                  |
| `packages/shared/src/attachments/interfaces/document-parser.ts`        | `DocumentParser` interface                                                                                |
| `packages/shared/src/attachments/interfaces/transcription-provider.ts` | `TranscriptionProvider` interface                                                                         |
| `packages/shared/src/attachments/interfaces/video-processor.ts`        | `VideoProcessor` interface                                                                                |
| `packages/core/src/types/agent-based.ts`                               | `AttachmentFieldAST`, `DestinationAST`, `AwaitAttachmentAST`                                              |
| `packages/compiler/src/platform/ir/schema.ts`                          | `AttachmentFieldIR`, `DestinationIR`, `AwaitAttachmentIR`                                                 |
| `packages/compiler/src/platform/ir/compiler.ts`                        | `compileAttachments()`, `compileDestinations()`, `compileAwaitAttachment()` with SSRF validation          |
| `packages/compiler/src/platform/ir/validate-ir.ts`                     | IR validation including `await_attachment` field constraints                                              |
| `apps/multimodal-service/src/services/multimodal-service.ts`           | `AttachmentService` lifecycle orchestrator (validate, store, enqueue scan)                                |
| `apps/runtime/src/attachments/attachment-config-resolver.ts`           | 3-tier config resolution: project -> tenant -> platform defaults                                          |
| `apps/runtime/src/attachments/message-preprocessor.ts`                 | `MessagePreprocessor`: attachment -> `ContentBlock[]` with PII policy enforcement                         |
| `apps/runtime/src/attachments/multimodal-service-client.ts`            | HTTP client to multimodal-service with circuit breaker support                                            |
| `apps/runtime/src/attachments/multimodal-circuit-breaker.ts`           | Circuit breaker wrapper for multimodal-service calls                                                      |
| `apps/runtime/src/tools/attachment-tool-executor.ts`                   | 5 agent tools: get, list, upload, url, route                                                              |
| `apps/runtime/src/tools/attachment-param-validator.ts`                 | Zod-based parameter validation for attachment tools                                                       |
| `apps/runtime/src/services/execution/await-attachment-executor.ts`     | AWAIT_ATTACHMENT flow step executor (3-state: received/timeout/waiting)                                   |
| `apps/runtime/src/services/execution/step-thought.ts`                  | Human-readable step summaries for flow steps including AWAIT_ATTACHMENT                                   |

### Routes / Handlers

| File                                                                  | Purpose                                                                             |
| --------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `apps/runtime/src/routes/attachments.ts`                              | Public API: upload, list, get, download URL, status, retry, delete (session-scoped) |
| `apps/runtime/src/routes/attachment-config.ts`                        | Project attachment config: GET resolved, PUT upsert overrides                       |
| `apps/multimodal-service/src/routes/attachments.ts`                   | Internal API: upload (multer), get, list, update, delete, retry, URL, status        |
| `apps/multimodal-service/src/routes/admin.ts`                         | Tenant config admin API with validation and sanitization                            |
| `apps/runtime/src/routes/platform-admin-attachment-config.ts`         | Platform admin proxy: runtime → multimodal-service (4-layer auth, Zod validation)   |
| `apps/admin/src/app/api/admin/tenant-attachment-config/route.ts`      | Admin Next.js proxy: admin UI → runtime (role-based auth)                           |
| `apps/admin/src/app/(dashboard)/tenants/[id]/AttachmentConfigTab.tsx` | Admin UI: tenant attachment config form (view/edit all fields)                      |
| `apps/studio/src/app/api/runtime/sessions/[id]/attachments/route.ts`  | Studio proxy route for attachment upload                                            |

### UI Components

| File                                                               | Purpose                                                                      |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------- |
| `apps/studio/src/components/chat/ChatInput.tsx`                    | File upload UI: file picker, drag-drop, paste, upload progress, inline chips |
| `apps/studio/src/components/chat/MessageList.tsx`                  | Attachment rendering: thumbnails, file icons, download links                 |
| `apps/studio/src/components/chat/ChatPanel.tsx`                    | Chat panel orchestration including attachment state                          |
| `apps/studio/src/contexts/WebSocketContext.tsx`                    | WebSocket events for attachment metadata (IDs, filenames, MIME types)        |
| `apps/studio/src/components/settings/AttachmentSettingsTab.tsx`    | Project attachment config UI: 5 editable fields, override/inherited badges   |
| `apps/studio/src/app/api/projects/[id]/attachment-config/route.ts` | Studio proxy route (GET/PUT) forwarding to runtime attachment-config API     |

### Jobs / Workers / Background Processes

| File                                                                 | Purpose                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `apps/multimodal-service/src/jobs/scan-job.ts`                       | Stage 1: ClamAV virus scan                                                       |
| `apps/multimodal-service/src/jobs/validate-job.ts`                   | Stage 2: Magic-byte MIME validation                                              |
| `apps/multimodal-service/src/jobs/process-job.ts`                    | Stage 3: Content extraction (Tika, Whisper, FFmpeg, image resize), PII detection |
| `apps/multimodal-service/src/jobs/index-job.ts`                      | Stage 4: Send processed content to Search AI for embedding                       |
| `apps/multimodal-service/src/jobs/cleanup-job.ts`                    | Stage 5: Cleanup temporary files and failed artifacts                            |
| `apps/multimodal-service/src/jobs/expiry-sweep-job.ts`               | Periodic sweep: delete attachments past their `expiresAt` TTL                    |
| `apps/multimodal-service/src/services/attachment-search-producer.ts` | BullMQ producer for Search AI indexing                                           |
| `apps/multimodal-service/src/services/tenant-config-service.ts`      | Tenant config CRUD for admin API                                                 |

### Storage & Security

| File                                                               | Purpose                                                  |
| ------------------------------------------------------------------ | -------------------------------------------------------- |
| `apps/multimodal-service/src/storage/local-storage.ts`             | Local filesystem storage provider                        |
| `apps/multimodal-service/src/storage/s3-storage.ts`                | S3/MinIO storage provider                                |
| `apps/multimodal-service/src/storage/storage-factory.ts`           | Factory: creates storage provider based on config        |
| `apps/multimodal-service/src/security/mime-validator.ts`           | Magic-byte MIME detection and `mimeToCategory()` mapping |
| `apps/multimodal-service/src/security/clamav-scanner.ts`           | ClamAV daemon client for virus scanning                  |
| `apps/multimodal-service/src/security/ssrf-validator.ts`           | SSRF URL validation (compile time)                       |
| `apps/multimodal-service/src/security/upload-rate-limiter.ts`      | Per-tenant sliding-window upload rate limiter            |
| `apps/multimodal-service/src/processing/image-processor.ts`        | Image resize, thumbnail generation                       |
| `apps/multimodal-service/src/processing/document-parser-tika.ts`   | Document text extraction via Apache Tika                 |
| `apps/multimodal-service/src/processing/transcriber-whisper.ts`    | Audio transcription via Whisper                          |
| `apps/multimodal-service/src/processing/video-processor-ffmpeg.ts` | Video keyframe extraction + transcription via FFmpeg     |

### Channel Adapters (attachment-related)

| File                                                               | Purpose                                           |
| ------------------------------------------------------------------ | ------------------------------------------------- |
| `apps/runtime/src/channels/adapters/slack-file-processor.ts`       | Slack file download and attachment creation       |
| `apps/runtime/src/channels/adapters/msteams-file-processor.ts`     | MS Teams file download and attachment creation    |
| `apps/runtime/src/channels/adapters/whatsapp-media-processor.ts`   | WhatsApp media download and attachment creation   |
| `apps/runtime/src/channels/adapters/telegram-media-processor.ts`   | Telegram media download and attachment creation   |
| `apps/runtime/src/channels/adapters/messenger-media-processor.ts`  | Messenger media download and attachment creation  |
| `apps/runtime/src/channels/adapters/instagram-media-processor.ts`  | Instagram media download and attachment creation  |
| `apps/runtime/src/channels/adapters/twilio-sms-media-processor.ts` | Twilio SMS media download and attachment creation |
| `apps/runtime/src/channels/adapters/line-media-processor.ts`       | LINE media download and attachment creation       |
| `apps/runtime/src/channels/adapters/email-attachment-processor.ts` | Email attachment extraction                       |

### Tests

| File                                                                                | Type        | Coverage Focus                                              |
| ----------------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------- |
| `apps/runtime/src/__tests__/attachment-pii.e2e.test.ts`                             | e2e         | PII detection, redaction, block, allow policies (6 tests)   |
| `apps/runtime/src/__tests__/attachment-tools.e2e.test.ts`                           | e2e         | Agent tools: get, list, upload, url (7 tests)               |
| `apps/runtime/src/__tests__/attachment-advanced.e2e.test.ts`                        | e2e         | Destinations, SSRF, AWAIT_ATTACHMENT flow step (6 tests)    |
| `apps/runtime/src/__tests__/attachment-config.e2e.test.ts`                          | e2e         | Config API: CRUD, permissions, isolation, validation (10)   |
| `apps/runtime/src/__tests__/attachment-config-validation.test.ts`                   | integration | Zod validation, upsert, resolver fallthrough (14 tests)     |
| `apps/runtime/src/__tests__/attachment-ownership-authz.test.ts`                     | e2e         | Session ownership, cross-session 404, tenant isolation      |
| `apps/studio/src/__tests__/attachment-settings-tab.test.tsx`                        | unit        | Settings tab rendering, field interaction (14 tests)        |
| `apps/studio/src/__tests__/attachment-settings-save.test.tsx`                       | unit        | Save, reset, MIME validation, toasts (9 tests)              |
| `apps/studio/src/__tests__/attachment-config-proxy.test.ts`                         | integration | Studio proxy route forwarding + auth gates (4 tests)        |
| `apps/studio/e2e/attachment-settings-e2e.spec.ts`                                   | browser-e2e | Playwright: load, badges, save, MIME, reset (6 tests)       |
| `apps/runtime/src/__tests__/flow-step-await-attachment.test.ts`                     | unit        | AWAIT_ATTACHMENT executor: 27 tests (IR, behavior, MIME)    |
| `apps/runtime/src/__tests__/platform-admin-attachment-config.test.ts`               | integration | Platform admin proxy: auth, validation, proxy (13 tests)    |
| `apps/runtime/src/__tests__/attachment-concurrency.test.ts`                         | unit        | Concurrent tool execution: no race conditions (6 tests)     |
| `apps/multimodal-service/src/__tests__/admin-routes-integration.test.ts`            | integration | Admin routes: auth, validation, CRUD (17 tests)             |
| `apps/multimodal-service/src/__tests__/attachment-admin-chain.test.ts`              | e2e         | Full chain: admin → runtime → multimodal (8 tests)          |
| `apps/multimodal-service/src/__tests__/external-services-contract.test.ts`          | integration | ClamAV/Tika/Whisper/FFmpeg test doubles (12 tests)          |
| `apps/admin/src/__tests__/attachment-config-tab.test.ts`                            | unit        | Admin UI component rendering and interaction (14 tests)     |
| `apps/admin/e2e/attachment-config-tab.spec.ts`                                      | browser-e2e | Playwright: admin attachment config tab (7 tests)           |
| `packages/compiler/src/__tests__/await-attachment-compilation.test.ts`              | unit        | AWAIT_ATTACHMENT DSL compilation + IR validation (21 tests) |
| `apps/runtime/src/attachments/__tests__/attachment-config-resolver.test.ts`         | unit        | 3-tier config resolution                                    |
| `apps/runtime/src/attachments/__tests__/message-preprocessor.test.ts`               | unit        | Attachment -> ContentBlock transformation                   |
| `apps/runtime/src/attachments/__tests__/message-preprocessor-pii.test.ts`           | unit        | PII redaction/block/allow in preprocessor                   |
| `apps/runtime/src/attachments/__tests__/preprocessor-pii-integration.test.ts`       | integration | PII pipeline end-to-end                                     |
| `apps/runtime/src/attachments/__tests__/multimodal-service-client.test.ts`          | unit        | HTTP client methods                                         |
| `apps/runtime/src/tools/__tests__/attachment-tool-executor.test.ts`                 | unit        | Tool dispatch and error handling                            |
| `apps/runtime/src/tools/__tests__/attachment-tool-executor-route.test.ts`           | unit        | route_attachment: destinations, SSRF                        |
| `apps/runtime/src/tools/__tests__/attachment-tool-executor-upload.test.ts`          | unit        | upload_attachment: base64, MIME, size                       |
| `apps/runtime/src/tools/__tests__/attachment-tool-executor-url.test.ts`             | unit        | get_attachment_url: presigned URLs                          |
| `apps/runtime/src/tools/__tests__/tool-input-validator-attachment.test.ts`          | unit        | Zod parameter validation                                    |
| `apps/runtime/src/__tests__/adapters/whatsapp-file-attachments.test.ts`             | unit        | WhatsApp adapter attachment handling                        |
| `apps/runtime/src/__tests__/adapters/slack-file-attachments.test.ts`                | unit        | Slack adapter attachment handling                           |
| `apps/multimodal-service/src/__tests__/attachment-routes.test.ts`                   | unit        | Internal API routes                                         |
| `apps/multimodal-service/src/__tests__/multimodal-service.test.ts`                  | unit        | AttachmentService lifecycle                                 |
| `apps/multimodal-service/src/__tests__/attachment-retry.test.ts`                    | unit        | Retry processing logic                                      |
| `apps/multimodal-service/src/__tests__/upload-modes.test.ts`                        | unit        | Processing modes (full, scan-only, store-raw)               |
| `apps/multimodal-service/src/__tests__/pii-pipeline-integration.test.ts`            | integration | PII detection in processing pipeline                        |
| `apps/multimodal-service/src/__tests__/attachment-rate-limit.test.ts`               | unit        | Upload rate limiting                                        |
| `apps/multimodal-service/src/jobs/__tests__/scan-job.test.ts`                       | unit        | ClamAV scan job                                             |
| `apps/multimodal-service/src/jobs/__tests__/validate-job.test.ts`                   | unit        | MIME validation job                                         |
| `apps/multimodal-service/src/jobs/__tests__/process-job.test.ts`                    | unit        | Content processing job                                      |
| `apps/multimodal-service/src/jobs/__tests__/process-job-pii.test.ts`                | unit        | PII detection in process job                                |
| `apps/multimodal-service/src/jobs/__tests__/index-job.test.ts`                      | unit        | Search AI indexing job                                      |
| `apps/multimodal-service/src/jobs/__tests__/cleanup-job.test.ts`                    | unit        | Cleanup job                                                 |
| `apps/multimodal-service/src/jobs/__tests__/expiry-sweep-job.test.ts`               | unit        | TTL expiry sweep                                            |
| `apps/multimodal-service/src/storage/__tests__/s3-storage.test.ts`                  | unit        | S3 storage provider                                         |
| `apps/multimodal-service/src/storage/__tests__/local-storage.test.ts`               | unit        | Local storage provider                                      |
| `apps/multimodal-service/src/storage/__tests__/storage-factory.test.ts`             | unit        | Storage factory                                             |
| `apps/multimodal-service/src/security/__tests__/mime-validator.test.ts`             | unit        | MIME magic-byte validation                                  |
| `apps/multimodal-service/src/security/__tests__/clamav-scanner.test.ts`             | unit        | ClamAV scanner                                              |
| `apps/multimodal-service/src/security/__tests__/ssrf-validator.test.ts`             | unit        | SSRF URL validation                                         |
| `apps/multimodal-service/src/security/__tests__/upload-rate-limiter.test.ts`        | unit        | Rate limiter                                                |
| `apps/multimodal-service/src/processing/__tests__/image-processor.test.ts`          | unit        | Image resize/thumbnail                                      |
| `apps/multimodal-service/src/processing/__tests__/document-parser-tika.test.ts`     | unit        | Tika document parsing                                       |
| `apps/multimodal-service/src/processing/__tests__/transcriber-whisper.test.ts`      | unit        | Whisper transcription                                       |
| `apps/multimodal-service/src/processing/__tests__/video-processor-ffmpeg.test.ts`   | unit        | FFmpeg video processing                                     |
| `apps/multimodal-service/src/services/__tests__/attachment-search-producer.test.ts` | unit        | Search AI producer                                          |
| `packages/compiler/src/__tests__/attachments.test.ts`                               | unit        | DSL attachment compilation                                  |
| `packages/compiler/src/__tests__/destinations.test.ts`                              | unit        | DSL destination compilation                                 |
| `apps/studio/src/__tests__/chat-input-attachments.test.tsx`                         | unit        | ChatInput attachment UI                                     |
| `apps/studio/src/__tests__/message-list-attachments.test.tsx`                       | unit        | MessageList attachment rendering                            |

---

## 11. Configuration

### Environment Variables

| Variable                         | Default                          | Description                                                            |
| -------------------------------- | -------------------------------- | ---------------------------------------------------------------------- |
| `MULTIMODAL_SERVICE_URL`         | `http://multimodal-service:3006` | Base URL for runtime -> multimodal-service communication               |
| `STORAGE_PROVIDER`               | `local`                          | Storage backend: `local`, `s3`, `gcs`, `azure_blob`, `minio`, `gridfs` |
| `STORAGE_BUCKET`                 | `attachments`                    | Storage bucket or container name                                       |
| `STORAGE_REGION`                 | (none)                           | Cloud region (S3, GCS)                                                 |
| `STORAGE_ENDPOINT`               | (none)                           | Custom endpoint (MinIO, S3-compatible)                                 |
| `STORAGE_BASE_PATH`              | `./data/attachments`             | Local filesystem base path for `local` provider                        |
| `SCAN_ENABLED`                   | `false`                          | Whether ClamAV virus scanning is enabled                               |
| `CLAMAV_HOST`                    | `localhost`                      | ClamAV daemon host                                                     |
| `CLAMAV_PORT`                    | `3310`                           | ClamAV daemon port                                                     |
| `MAX_FILE_SIZE_BYTES`            | `52428800` (50 MB)               | Maximum file size at the multimodal-service level                      |
| `IMAGE_MAX_DIMENSION`            | `2048`                           | Maximum image dimension for resize (px)                                |
| `THUMBNAIL_SIZE`                 | `256`                            | Thumbnail size (px)                                                    |
| `TIKA_URL`                       | `http://localhost:9998`          | Apache Tika server URL for document parsing                            |
| `WHISPER_URL`                    | `http://localhost:8080`          | Whisper server URL for audio transcription                             |
| `PROCESSING_MAX_CONCURRENT_JOBS` | `5`                              | Maximum concurrent BullMQ processing jobs                              |

### Runtime Configuration

**3-tier config resolution** (per field, first non-null wins):

1. **Project level** (`ProjectAttachmentConfig`): `enabled`, `maxFileSizeBytes`, `allowedMimeTypes`, `piiPolicy`, `defaultProcessingMode`
2. **Tenant level** (`TenantAttachmentConfig`): `maxFileSizeBytes`, `allowedMimeTypes`, `blockedMimeTypes`, `scanEnabled`, `processingEnabled`, `embeddingEnabled`, `piiPolicy`, `maxAttachmentsPerSession`, `maxTotalStorageBytes`, `retentionDays`
3. **Platform defaults** (hardcoded): `enabled=true`, `maxFileSizeBytes=20MB`, `maxFilesPerSession=100`, `piiPolicy='redact'`, default MIME allowlist (16 types including images, PDFs, Office docs, audio, video)

### DSL / Agent IR / Schema

**DSL (ATTACHMENTS section)**:

```
ATTACHMENTS:
  - name: document
    prompt: "Upload a document"
    category: document
    required: true
    maxFileSizeMb: 10
    allowedMimeTypes: ["application/pdf", "text/plain"]
    ocrEnabled: true
```

**AST** (`AttachmentFieldAST`): `name`, `prompt`, `category`, `required`, `maxFileSizeMb`, `allowedMimeTypes`, `ocrEnabled`, `transcriptionEnabled`, `keyFrameExtraction`

**IR** (`AttachmentFieldIR`): `name`, `prompt`, `category`, `required`, `allowed_mime_types`, `max_file_size_bytes`, `processing`

**DSL (AWAIT_ATTACHMENT flow step)**:

```
FLOW:
  collect_document:
    AWAIT_ATTACHMENT:
      VARIABLE: uploaded_doc_id
      PROMPT: "Please upload your document."
      CATEGORY: document
      REQUIRED: true
      TIMEOUT_SECONDS: 300
      ON_TIMEOUT: timeout_step
    THEN: process_document
```

**AST** (`AwaitAttachmentAST`): `name`, `prompt`, `category`, `required`, `timeout`, `onTimeout`

**IR** (`AwaitAttachmentIR`): `variable`, `prompt`, `category`, `required`, `timeout_seconds`, `on_timeout`

**DSL (DESTINATIONS section)**:

```
DESTINATIONS:
  - name: crm_upload
    url: https://api.crm.com/files
    method: POST
    auth: Bearer ${CRM_API_KEY}
    headers:
      X-Source: agent-platform
```

**AST/IR** (`DestinationAST`/`DestinationIR`): `name`, `url`, `method`, `auth`, `headers`

The compiler validates destination URLs against SSRF patterns at compile time.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project isolation | All attachment queries in project-scoped routes include `projectId`. Cross-project access returns 404. Upload route validates `session.projectId === req.params.projectId`.                            |
| Tenant isolation  | All queries use `findOne({ _id, tenantId })`, never `findById()`. The `tenantIsolationPlugin` is applied to all three models. Internal API uses `X-Tenant-Id` header. Cross-tenant access returns 404. |
| User isolation    | Session ownership middleware (`createRequireSessionOwnership`) ensures SDK users can only access attachments in sessions they own. Non-admin platform members can only access sessions they initiated. |

### Security & Compliance

- **Virus scanning**: ClamAV integration scans every upload before processing. Infected files are quarantined (scanStatus='infected') and blocked from LLM injection.
- **MIME validation**: Magic-byte detection validates the actual file type, not just the declared Content-Type or extension, preventing MIME spoofing.
- **SSRF protection**: Destination URLs are validated against private IP ranges, localhost, and link-local addresses at both compile time (in the compiler) and runtime (in `route_attachment`).
- **PII detection and enforcement**: Processed content is scanned for PII. The configurable policy (redact/block/allow) is enforced before any content reaches the LLM.
- **Rate limiting**: Per-tenant sliding-window rate limiter on uploads prevents abuse. Rate limit headers (`X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset`) are returned on 429 responses.
- **Filename sanitization**: Filenames are stripped of newlines and control characters to prevent prompt injection.
- **Base64 validation**: Strict regex validation prevents malformed base64 from consuming memory. 67 MB pre-check before decode.
- **Encryption at rest**: `encrypted: true` default on attachment records. `encryptionKeyVersion` tracks key rotation.
- **RBAC**: Attachment routes require `attachment:read`, `attachment:write`, or `attachment:delete` permissions via `requireProjectPermission`.

### Performance & Scalability

- **Async pipeline**: File processing is fully async via BullMQ. Upload returns immediately with `status: 'accepted'`; processing happens in background workers.
- **Circuit breaker**: Runtime wraps multimodal-service calls in a circuit breaker that fails fast when the service is degraded, preventing cascading latency.
- **Content truncation**: Processed content is truncated at 50,000 characters before LLM injection to prevent context window bloat.
- **Configurable concurrency**: `PROCESSING_MAX_CONCURRENT_JOBS` controls BullMQ worker concurrency (default: 5).
- **Storage backend flexibility**: S3/MinIO for production (horizontally scalable), local for development.
- **Deduplication**: Content hash index enables dedup of identical uploads within a tenant.

### Reliability & Failure Modes

- **Retry processing**: Failed processing can be retried via `POST /:attachmentId/retry`. Retry count is tracked.
- **Never-throw pattern**: `MultimodalServiceClient` and `AttachmentToolExecutor` never throw -- all errors are returned as structured `{ success: false, error: { code, message } }` results.
- **Graceful degradation**: If the multimodal service is unavailable (circuit breaker open), uploads fail fast with clear error messages. Existing attachments remain accessible via cached metadata.
- **Pipeline idempotency**: Each pipeline stage reads the current attachment state before processing, allowing safe retries.

### Observability

- **Structured logging**: All components use `createLogger('module-name')` for structured logging with context fields (tenantId, attachmentId, sessionId).
- **Processing status tracking**: Three independent status fields (`scanStatus`, `processingStatus`, `embeddingStatus`) with timestamps (`scannedAt`, `processedAt`, `embeddedAt`) enable pipeline monitoring.
- **Error tracking**: `processingError` field stores the error message for failed processing.
- **Rate limit headers**: HTTP responses include `X-RateLimit-*` headers for client-side monitoring.

### Data Lifecycle

- **TTL-based expiry**: MongoDB TTL index on `expiresAt` auto-removes expired attachments. `expiresAt` is computed from tenant-configurable `retentionDays` per category.
- **Expiry sweep job**: Periodic `expiry-sweep-job` cleans up storage files for expired attachments.
- **Session cascade delete**: `deleteBySession()` removes all attachments when a session is deleted.
- **GDPR erasure**: Studio retention service (`apps/studio/src/services/retention/`) supports cascade delete and GDPR right-to-erasure flows for attachments.

---

## 13. Delivery Plan / Work Breakdown

The feature is already implemented. The implementation was delivered across multiple phases:

1. **Shared types and interfaces**
   1.1 Core types in `packages/shared/src/attachments/`
   1.2 Provider interfaces (storage, scan, document-parser, transcription, video-processor)

2. **Database models**
   2.1 Attachment model with indexes and tenant isolation
   2.2 ProjectAttachmentConfig model
   2.3 TenantAttachmentConfig model

3. **DSL and compiler**
   3.1 `ATTACHMENTS:` parser and AST types
   3.2 `DESTINATIONS:` parser and AST types
   3.3 IR compilation with SSRF validation

4. **Multimodal service**
   4.1 Storage providers (local, S3, MinIO) with factory
   4.2 Security layer (MIME validator, ClamAV scanner, SSRF validator, rate limiter)
   4.3 Processing layer (image, document/Tika, audio/Whisper, video/FFmpeg)
   4.4 BullMQ pipeline (scan, validate, process, index, cleanup, expiry-sweep)
   4.5 Internal REST API routes
   4.6 AttachmentService lifecycle orchestrator

5. **Runtime layer**
   5.1 3-tier config resolver
   5.2 MultimodalServiceClient with circuit breaker
   5.3 MessagePreprocessor (attachment -> ContentBlock[] + PII policy)
   5.4 Public attachment routes (upload, list, get, url, status, retry, delete)
   5.5 Attachment config routes (GET resolved, PUT overrides)
   5.6 AttachmentToolExecutor (5 tools)
   5.7 Channel adapters (10+ channels)

6. **SDK layer**
   6.1 `uploadAttachment()` and `send()` with `attachmentIds`
   6.2 `AttachmentRef` types on messages

7. **Studio layer**
   7.1 ChatInput with drag-drop, paste, file picker
   7.2 MessageList with thumbnails and download
   7.3 WebSocket events for attachment status
   7.4 Studio API proxy route

---

## 14. Success Metrics

| Metric                        | Baseline       | Target                                | How Measured                                                 |
| ----------------------------- | -------------- | ------------------------------------- | ------------------------------------------------------------ |
| Upload success rate           | N/A            | > 99%                                 | Multimodal service logs: successful uploads / total attempts |
| Processing completion rate    | N/A            | > 95%                                 | Attachment records: completed / (completed + failed)         |
| PII detection recall          | N/A            | > 90% for common PII types            | Manual evaluation against labeled test set                   |
| Upload-to-ready latency (P95) | N/A            | < 30s for documents, < 10s for images | Processing pipeline timing from upload to completed status   |
| E2E test coverage             | ~55 test files | All gaps closed                       | Test matrix completion                                       |

---

## 15. Open Questions

1. Should the platform support client-side encryption where the platform never sees plaintext file contents? This would prevent PII detection and content processing.
2. Should there be a maximum total attachment count per tenant (not just per session) to prevent storage abuse at scale?
3. Should processed content be cached in Redis for frequently-accessed attachments to reduce MongoDB reads during LLM calls?
4. Should the multimodal service support webhook callbacks for processing completion (in addition to polling via status endpoint)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                      | Severity | Status    |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------- | --------- |
| GAP-001 | Studio settings UI for per-project attachment config not yet built. Config is API-only via `PUT /api/projects/:projectId/attachment-config`.                                                                                                     | Medium   | Resolved  |
| GAP-002 | E2E tests for `piiPolicy=block` and `piiPolicy=allow` scenarios (E2E-0.3, E2E-0.4) were skipped in `attachment-pii.e2e.test.ts`. Now unskipped and passing.                                                                                      | Low      | Resolved  |
| GAP-003 | Admin UI for tenant-level attachment config. Full 3-tier proxy chain: Admin UI (AttachmentConfigTab) → Next.js proxy → Runtime proxy → Multimodal Admin. 4-layer auth on runtime proxy.                                                          | Medium   | Resolved  |
| GAP-004 | Processing pipeline depends on external services (Apache Tika, Whisper, ClamAV, FFmpeg) that are not available in CI/test environments. Now mitigated with contract test doubles (ClamAV TCP stub, Tika/Whisper HTTP stubs, FFmpeg test double). | Low      | Mitigated |
| GAP-005 | `AWAIT_ATTACHMENT` flow step fully implemented: parser (AWAIT_ATTACHMENT keyword), compiler (AST→IR), IR validation, runtime executor (3-state machine), flow-step-executor wiring, session state management.                                    | Medium   | Resolved  |
| GAP-006 | All 61 `console.*` calls in multimodal-service replaced with `createLogger` structured logging. Zero console.\* remaining in production code.                                                                                                    | Low      | Resolved  |
| GAP-T1  | External processing services (ClamAV, Tika, Whisper, FFmpeg) not testable in CI. Now mitigated with 4 test doubles and 12 contract tests exercising real protocols (TCP for ClamAV, HTTP for Tika/Whisper).                                      | Low      | Resolved  |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                     | Coverage Type | Status | Test File / Note                                                                                   |
| --- | -------------------------------------------- | ------------- | ------ | -------------------------------------------------------------------------------------------------- |
| 1   | Upload attachment via public API (multipart) | e2e           | PASS   | `attachment-tools.e2e.test.ts`                                                                     |
| 2   | Upload via agent tool (base64)               | e2e           | PASS   | `attachment-tools.e2e.test.ts`                                                                     |
| 3   | PII redaction in preprocessor                | e2e           | PASS   | `attachment-pii.e2e.test.ts`                                                                       |
| 4   | PII block policy                             | e2e           | PASS   | `attachment-pii.e2e.test.ts` (unskipped, GAP-002 resolved)                                         |
| 5   | PII allow policy                             | e2e           | PASS   | `attachment-pii.e2e.test.ts` (unskipped, GAP-002 resolved)                                         |
| 6   | Agent tool: get_attachment                   | e2e           | PASS   | `attachment-tools.e2e.test.ts`                                                                     |
| 7   | Agent tool: list_attachments                 | e2e           | PASS   | `attachment-tools.e2e.test.ts`                                                                     |
| 8   | Agent tool: get_attachment_url               | e2e           | PASS   | `attachment-tools.e2e.test.ts`                                                                     |
| 9   | Agent tool: route_attachment                 | e2e           | PASS   | `attachment-advanced.e2e.test.ts`                                                                  |
| 10  | SSRF blocking on destinations                | e2e           | PASS   | `attachment-advanced.e2e.test.ts`                                                                  |
| 11  | AWAIT_ATTACHMENT flow step                   | unit+int      | PASS   | `flow-step-await-attachment.test.ts` (27 tests), `await-attachment-compilation.test.ts` (21 tests) |
| 12  | Session ownership / cross-session 404        | e2e           | PASS   | `attachment-ownership-authz.test.ts`                                                               |
| 13  | 3-tier config resolution                     | unit          | PASS   | `attachment-config-resolver.test.ts`                                                               |
| 14  | Message preprocessor transformation          | unit          | PASS   | `message-preprocessor.test.ts`                                                                     |
| 15  | ClamAV virus scanning                        | unit          | PASS   | `scan-job.test.ts`, `clamav-scanner.test.ts`                                                       |
| 16  | MIME magic-byte validation                   | unit          | PASS   | `mime-validator.test.ts`, `validate-job.test.ts`                                                   |
| 17  | Image processing (resize/thumbnail)          | unit          | PASS   | `image-processor.test.ts`                                                                          |
| 18  | Document parsing (Tika)                      | unit          | PASS   | `document-parser-tika.test.ts`                                                                     |
| 19  | Audio transcription (Whisper)                | unit          | PASS   | `transcriber-whisper.test.ts`                                                                      |
| 20  | Video processing (FFmpeg)                    | unit          | PASS   | `video-processor-ffmpeg.test.ts`                                                                   |
| 21  | Storage providers (S3, local, factory)       | unit          | PASS   | `s3-storage.test.ts`, `local-storage.test.ts`, `storage-factory.test.ts`                           |
| 22  | Upload rate limiting                         | unit          | PASS   | `upload-rate-limiter.test.ts`, `attachment-rate-limit.test.ts`                                     |
| 23  | DSL attachment compilation                   | unit          | PASS   | `attachments.test.ts` (compiler)                                                                   |
| 24  | DSL destination compilation                  | unit          | PASS   | `destinations.test.ts` (compiler)                                                                  |
| 25  | Slack file attachments                       | unit          | PASS   | `slack-file-attachments.test.ts`                                                                   |
| 26  | WhatsApp file attachments                    | unit          | PASS   | `whatsapp-file-attachments.test.ts`                                                                |
| 27  | Studio ChatInput attachments                 | unit          | PASS   | `chat-input-attachments.test.tsx`                                                                  |
| 28  | Studio MessageList attachments               | unit          | PASS   | `message-list-attachments.test.tsx`                                                                |
| 29  | Search AI indexing                           | unit          | PASS   | `index-job.test.ts`, `attachment-search-producer.test.ts`                                          |
| 30  | TTL expiry sweep                             | unit          | PASS   | `expiry-sweep-job.test.ts`                                                                         |

### Testing Notes

The attachment feature has approximately 77 test files with 390+ tests across E2E, integration, unit, and browser E2E. Unit test coverage is strong across all tiers (storage, security, processing, routes, tools, DSL compilation, Studio components, settings UI). E2E coverage is comprehensive for all core paths (upload, tools, PII redaction/block/allow, destinations, SSRF, config API CRUD/permissions/isolation, admin chain). The attachment settings UI has full coverage: 23 unit tests, 4 integration tests, 10 API E2E tests, 14 validation tests, and 6 Playwright browser E2E tests. The admin attachment config has full coverage: 14 UI tests, 13 proxy tests, 17 admin integration tests, 8 chain E2E tests, 7 Playwright tests. AWAIT_ATTACHMENT is fully covered: 21 compiler tests, 27 executor tests. External services (ClamAV, Tika, Whisper, FFmpeg) have 12 contract tests using real protocol test doubles. All previously open gaps (GAP-002 through GAP-006, GAP-T1) are now resolved.

> Full testing details: [../testing/attachments.md](../testing/attachments.md)

---

## 18. References

- Design docs: `docs/archive/plans-2026-02/2026-02-21-attachment-pipeline-design.md`
- Implementation plan: `docs/plans/2026-03-13-agent-capabilities-phase2-attachment-tools.md`
- PII safety plan: `docs/plans/2026-03-13-agent-capabilities-phase1-pii-safety.md`
- Studio UX plan: `docs/plans/2026-03-13-agent-capabilities-phase4-studio-ux-tools.md`
- Related feature docs: [channels.md](channels.md), [abl-language.md](abl-language.md), [connectors.md](connectors.md)
- ABL specification: `docs/reference/ABL_SPEC.md`
- Feature matrix: `docs/feature-matrix.md`
