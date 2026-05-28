# Test Spec: Multimodal Processing

> **Feature ID:** #40
> **Status:** PLANNED
> **Last Updated:** 2026-03-22
> **Feature Spec:** `docs/features/multimodal-processing.md`

---

## 1. Test Strategy Overview

This test spec covers the multimodal processing feature which spans multiple services (Docling, BGE-M3, preprocessing, vision, transcription), BullMQ workers, and MongoDB models. The testing strategy follows the platform's mandatory E2E/integration test standards:

- **E2E tests** exercise the full HTTP API path with real Express middleware, auth, and BullMQ queues.
- **Integration tests** test real service boundaries with MongoDB and Redis, mocking only external third-party APIs (LLM providers, S3).
- **No mocking of codebase components** -- `vi.mock()` is forbidden in E2E tests.
- **Unit tests** cover isolated service logic (parsing, validation, transformation).

## 2. Coverage Matrix

| Component                   | Unit | Integration | E2E | Priority |
| --------------------------- | ---- | ----------- | --- | -------- |
| Docling Extraction Worker   | Y    | Y           | Y   | P0       |
| Page Processing Worker      | Y    | Y           | Y   | P0       |
| Visual Enrichment Worker    | Y    | Y           | Y   | P0       |
| Multimodal Enricher Service | Y    | Y           | N   | P0       |
| Vision Service              | Y    | Y           | N   | P0       |
| Audio Transcription Worker  | Y    | Y           | Y   | P1       |
| Video Processing Worker     | Y    | Y           | Y   | P1       |
| Attachment-to-Search Bridge | Y    | Y           | Y   | P0       |
| Tenant Config Enforcement   | Y    | Y           | Y   | P0       |
| MIME Type Validation        | Y    | N           | Y   | P0       |
| Queue Backpressure          | N    | Y           | N   | P1       |
| Cost Tracking               | Y    | Y           | N   | P1       |
| Progress Events (SSE)       | N    | Y           | Y   | P1       |
| Deduplication               | Y    | Y           | Y   | P0       |

## 3. E2E Test Scenarios

All E2E tests interact via HTTP API only. Real Express servers started on random ports with full middleware chain (auth, rate limiting, tenant isolation, validation).

### E2E-1: Document Upload and Full Pipeline Processing

**Objective:** Verify that uploading a PDF document triggers the complete pipeline: extraction, page processing, visual enrichment, chunking, embedding, and search indexing.

**Preconditions:**

- Search AI server running on random port
- MongoDB and Redis available
- Docling service mock (HTTP stub returning structured pages)
- BGE-M3 service mock (HTTP stub returning embeddings)
- S3/MinIO mock (HTTP stub accepting uploads)

**Steps:**

1. POST `/api/projects/:projectId/indexes` to create a knowledge base index.
2. POST `/api/projects/:projectId/indexes/:indexId/documents` with a PDF file upload.
3. Poll GET `/api/projects/:projectId/indexes/:indexId/documents/:docId` until `status === 'processed'`.
4. GET `/api/projects/:projectId/indexes/:indexId/documents/:docId/pages` to verify extracted pages.
5. GET `/api/projects/:projectId/indexes/:indexId/search?q=<visual term>` to verify search returns results.

**Expected Results:**

- Document transitions through statuses: `pending` -> `extracting` -> `processing` -> `processed`.
- Pages contain text, layout headings, and table data.
- Search returns the document for queries matching extracted text content.
- `pageCount` on the document matches the number of extracted pages.

**Validation:**

- HTTP 200 on all GET requests with correct `{ success: true, data: ... }` envelope.
- Document `status === 'processed'` within 30 seconds.
- At least 1 page returned with non-empty `text` field.

### E2E-2: Image Analysis and Visual Enrichment

**Objective:** Verify that documents with embedded images have those images analyzed by the vision service and descriptions stored in chunk metadata.

**Preconditions:**

- Docling service mock configured to return pages with base64 images.
- Vision LLM provider mock (HTTP stub returning image descriptions).
- S3 mock accepting image uploads.

**Steps:**

1. Create an index with multimodal enabled in LLM config.
2. Upload a document that Docling will extract with images.
3. Wait for processing to complete.
4. GET `/api/projects/:projectId/indexes/:indexId/documents/:docId/chunks` to retrieve chunks.
5. Inspect chunk `metadata.visualAnalysis.imageDescriptions` for populated descriptions.

**Expected Results:**

- At least one chunk has `metadata.visualAnalysis.processed === true`.
- Image descriptions include `description`, `model`, `tokensUsed`, `costUsd` fields.
- `metadata.visualAnalysis.visualContext` is non-empty (progressive context chain).
- Total cost is tracked and non-zero.

**Validation:**

- HTTP 200 on chunk retrieval.
- At least 1 image description per page that had images.
- `costUsd > 0` for processed chunks.

### E2E-3: Tenant Configuration Enforcement -- Blocked MIME Type

**Objective:** Verify that uploading a file with a blocked MIME type is rejected at the API boundary.

**Preconditions:**

- Tenant attachment config created with `blockedMimeTypes: ['application/exe', 'application/x-msdownload']`.

**Steps:**

1. PUT `/api/tenants/:tenantId/attachment-config` to set blocked MIME types.
2. POST `/api/projects/:projectId/attachments` with a file having MIME type `application/x-msdownload`.
3. Verify the response is a 400 error.
4. POST `/api/projects/:projectId/attachments` with a valid PDF file.
5. Verify the response is 201 (accepted).

**Expected Results:**

- Blocked MIME type upload returns HTTP 400 with error code `BLOCKED_MIME_TYPE`.
- Valid file upload succeeds with HTTP 201.
- No processing job is enqueued for the blocked file.

**Validation:**

- Response body: `{ success: false, error: { code: 'BLOCKED_MIME_TYPE', message: '...' } }`.
- Valid upload returns `{ success: true, data: { id: '...' } }`.

### E2E-4: Attachment-to-Search Bridge

**Objective:** Verify that an attachment uploaded during a conversation is automatically bridged to the SearchAI pipeline and becomes searchable.

**Preconditions:**

- A project with a knowledge base index configured for attachment bridging.
- Tenant config with `embeddingEnabled: true`.

**Steps:**

1. Create a session via POST `/api/projects/:projectId/sessions`.
2. Upload an attachment via POST `/api/projects/:projectId/sessions/:sessionId/attachments` with a text document.
3. Wait for `processingStatus === 'completed'` on the attachment.
4. Verify `searchDocumentId` and `searchIndexId` are populated on the attachment.
5. GET the linked SearchDocument and verify it exists with correct `contentHash`.

**Expected Results:**

- Attachment processing completes successfully.
- `searchDocumentId` links to a valid SearchDocument.
- SearchDocument `contentHash` matches the attachment's `contentHash`.
- No duplicate SearchDocument exists for the same content hash.

**Validation:**

- Attachment `processingStatus === 'completed'`.
- `searchDocumentId` is a valid UUID.
- GET on SearchDocument returns 200 with matching content hash.

### E2E-5: File Size Limit Enforcement

**Objective:** Verify that files exceeding the tenant's `maxFileSizeBytes` are rejected at the upload boundary.

**Preconditions:**

- Tenant config with `maxFileSizeBytes: 1048576` (1 MB).

**Steps:**

1. PUT `/api/tenants/:tenantId/attachment-config` with `maxFileSizeBytes: 1048576`.
2. POST an attachment with a 2 MB file.
3. Verify rejection with HTTP 413 or 400.
4. POST an attachment with a 500 KB file.
5. Verify acceptance with HTTP 201.

**Expected Results:**

- Oversized file rejected with appropriate error code.
- Under-limit file accepted normally.

**Validation:**

- Error response includes file size limit in the message.
- Small file gets `processingStatus: 'pending'` on creation.

### E2E-6: Cross-Tenant Isolation in Processing

**Objective:** Verify that attachments from tenant A cannot be accessed or processed in the context of tenant B.

**Steps:**

1. Create an attachment as tenant A.
2. Attempt to GET the attachment as tenant B using the same attachment ID.
3. Verify HTTP 404 (not 403).
4. Attempt to query tenant A's documents from tenant B's project.
5. Verify HTTP 404.

**Expected Results:**

- Cross-tenant access returns 404 (no existence leak).
- Each tenant's processing is completely isolated.

**Validation:**

- All cross-tenant requests return 404.
- No data from tenant A appears in tenant B responses.

### E2E-7: Deduplication by Content Hash

**Objective:** Verify that uploading the same file twice does not create duplicate processing jobs.

**Steps:**

1. Upload a file to an index.
2. Wait for processing to complete.
3. Upload the same file again (identical content).
4. Verify the second upload is deduplicated.
5. Check that only one SearchDocument exists for the given content hash.

**Expected Results:**

- Second upload is recognized as a duplicate.
- No duplicate SearchDocument is created.
- The existing document ID is returned or linked.

**Validation:**

- Only 1 SearchDocument with the content hash exists in the index.

## 4. Integration Test Scenarios

Integration tests use real MongoDB (MongoMemoryServer) and Redis, with real BullMQ queues. External APIs (LLM providers, Docling, S3) are mocked via HTTP stubs.

### INT-1: Docling Extraction Worker -- Successful Extraction

**Objective:** Verify the docling-extraction-worker correctly processes a job, calls the Docling service, uploads images to S3, and stores DocumentPage records.

**Setup:**

- MongoMemoryServer with SearchDocument and DocumentPage models.
- Redis with BullMQ queue `search-docling-extraction`.
- HTTP stub for Docling service returning 3 pages with images and tables.
- HTTP stub for S3 upload.

**Steps:**

1. Insert a SearchDocument with `status: 'pending'`.
2. Enqueue a `DoclingExtractionJobData` job.
3. Wait for job completion.
4. Query DocumentPage collection for the document.

**Assertions:**

- 3 DocumentPage records created with correct `documentId`, `indexId`, `tenantId`.
- Each page has `text`, `layout.headings`, `tables`, and `images` populated.
- Images have S3 URLs (from the stub).
- SearchDocument `status` updated to `'extracting'` then `'page_processing'`.
- SearchDocument `pageCount === 3`.

### INT-2: Visual Enrichment Worker -- Progressive Context Chain

**Objective:** Verify the visual-enrichment-worker chains context from page to page and generates accurate visual analysis.

**Setup:**

- MongoDB with DocumentPage records (3 pages, each with images).
- Redis with BullMQ queue `search-visual-enrichment`.
- HTTP stub for vision LLM returning descriptions.

**Steps:**

1. Enqueue visual enrichment jobs for pages 1, 2, 3 (in order).
2. Wait for all jobs to complete.
3. Query SearchChunk metadata for each page's chunk.

**Assertions:**

- Page 1 chunk: `visualAnalysis.visualContext` set (no previous context).
- Page 2 chunk: `visualAnalysis.visualContext` includes elements from page 1.
- Page 3 chunk: `visualAnalysis.visualContext` includes elements from pages 1+2.
- All chunks have `visualAnalysis.processed === true`.
- Token count is bounded (not growing unboundedly across pages).

### INT-3: Multimodal Enricher -- Image Description Generation

**Objective:** Verify the MultiModalEnricher service correctly generates image descriptions and table summaries.

**Setup:**

- HTTP stub for vision LLM provider.
- HTTP stub for table summarizer LLM.

**Steps:**

1. Call `service.describeImage(imageData)` with a base64 image.
2. Call `service.summarizeTable(tableData)` with HTML table content.
3. Verify returned descriptions.

**Assertions:**

- Image description includes `description`, `provider`, `model`, `tokensUsed`.
- Table summary includes `summary`, `insights`, `provider`, `model`.
- Cost tracking fields are populated.

### INT-4: Attachment Bridge -- Processing Status Transition

**Objective:** Verify the attachment bridge correctly transitions attachment status and creates SearchDocument records.

**Setup:**

- MongoDB with Attachment and SearchDocument models.
- Redis with BullMQ queues.

**Steps:**

1. Insert an Attachment with `processingStatus: 'completed'`, `processedContent: 'extracted text'`.
2. Trigger the bridge worker.
3. Verify SearchDocument creation.
4. Verify Attachment update with `searchDocumentId`.

**Assertions:**

- New SearchDocument created with `contentHash` matching the attachment.
- Attachment `searchDocumentId` set to the new document ID.
- Attachment `embeddingStatus` set to `'processing'`.
- SearchDocument `extractedText` matches the attachment's `processedContent`.

### INT-5: Queue Backpressure -- Depth Limit Enforcement

**Objective:** Verify that queue backpressure rejects new jobs when depth exceeds `MAX_QUEUE_DEPTH`.

**Setup:**

- Redis with BullMQ queue.
- Fill queue with jobs up to `MAX_QUEUE_DEPTH[queue]`.

**Steps:**

1. Enqueue jobs until the queue reaches its max depth (300 for docling).
2. Attempt to enqueue one more job.
3. Verify `BackpressureError` is thrown.

**Assertions:**

- `BackpressureError` includes `queueName`, `currentDepth`, `maxDepth`.
- `retryAfterMs` is set (default 30000).
- Queue depth does not exceed the limit.

### INT-6: Tenant Config -- Processing Toggle

**Objective:** Verify that `TenantAttachmentConfig.processingEnabled = false` skips content extraction.

**Setup:**

- MongoDB with TenantAttachmentConfig (`processingEnabled: false`) and Attachment.

**Steps:**

1. Insert a TenantAttachmentConfig with `processingEnabled: false`.
2. Upload an attachment for that tenant.
3. Verify the attachment is stored but `processingStatus` is set to `'skipped'`.

**Assertions:**

- Attachment created with `processingStatus: 'skipped'`.
- No processing job enqueued.
- `processedContent` remains null.

### INT-7: Cost Tracking Aggregation

**Objective:** Verify that cost tracking correctly aggregates across images and tables within a document.

**Setup:**

- MongoDB with SearchChunk records after visual enrichment.

**Steps:**

1. Process a document with 5 images across 3 pages.
2. Query chunk metadata for cost fields.
3. Sum `costUsd` across all chunks.

**Assertions:**

- Each chunk with images has `visualAnalysis.enrichmentCost > 0`.
- Total cost is sum of individual image costs + table summarization costs.
- `enrichmentTokens` is consistent with `enrichmentCost`.

## 5. Unit Test Scenarios

### UT-1: MIME Type Validation

- Accept: `application/pdf`, `image/png`, `image/jpeg`, `audio/mpeg`, `video/mp4`.
- Reject: blocked MIME types from config.
- Handle: empty allow list (allow all not blocked), empty block list (block none).

### UT-2: Content Hash Computation

- Same file content produces same hash.
- Different content produces different hash.
- Hash is SHA-256 hex string.

### UT-3: File Size Validation

- Reject files exceeding `maxFileSizeBytes`.
- Accept files at exactly the limit.
- Accept files under the limit.

### UT-4: Visual Context Truncation

- Context exceeding 500 tokens is truncated.
- Truncation preserves most recent context (not oldest).
- Empty context produces empty string (no errors).

### UT-5: Extraction Options Defaults

- Default options enable OCR, images, tables, layout, screenshots.
- Overridden options are respected.
- Invalid options are rejected with validation errors.

## 6. Security Test Scenarios

### SEC-1: MIME Type Bypass

- Upload file with mismatch between extension and magic bytes.
- Verify `detectedMimeType` is used for validation (not the declared MIME type).

### SEC-2: Path Traversal in Filename

- Upload file with `../../etc/passwd` as filename.
- Verify filename is sanitized before storage.

### SEC-3: Oversized Payload

- Send multipart upload exceeding Content-Length limit.
- Verify server rejects before fully reading the body.

### SEC-4: Cross-Tenant S3 Key Access

- Verify S3 keys include tenant ID.
- Verify different tenants cannot construct valid S3 keys for other tenants' files.

## 7. Performance Test Scenarios

### PERF-1: Concurrent Document Processing

- Upload 50 documents simultaneously.
- Verify all complete within 5 minutes.
- Monitor queue depths stay within limits.

### PERF-2: Large Document Extraction

- Upload a 200-page PDF.
- Verify extraction completes within 2 minutes.
- Monitor worker memory stays under 512MB.

## 8. Test Data Requirements

| Data                              | Source               | Notes                              |
| --------------------------------- | -------------------- | ---------------------------------- |
| Sample PDF (5 pages, with images) | `test_data/docling/` | Existing in repo                   |
| Sample PDF (50 pages, text-only)  | Generate             | For performance testing            |
| Sample PNG, JPEG, WEBP images     | Fixtures             | Various sizes 100KB-5MB            |
| Sample MP3, WAV audio (30s, 5min) | Fixtures             | For audio transcription            |
| Sample MP4 video (2min)           | Fixtures             | For video processing               |
| Docling service response fixtures | JSON                 | Mock structured extraction results |
| Vision API response fixtures      | JSON                 | Mock image descriptions            |
| BGE-M3 response fixtures          | JSON                 | Mock embedding vectors             |

## 9. Test Environment

| Component       | E2E                | Integration       | Unit   |
| --------------- | ------------------ | ----------------- | ------ |
| MongoDB         | MongoMemoryServer  | MongoMemoryServer | Mocked |
| Redis           | Real (Docker)      | Real (Docker)     | Mocked |
| BullMQ          | Real queues        | Real queues       | Mocked |
| Docling Service | HTTP stub          | HTTP stub         | N/A    |
| BGE-M3 Service  | HTTP stub          | HTTP stub         | N/A    |
| Vision LLM      | HTTP stub          | HTTP stub         | Mocked |
| S3/MinIO        | HTTP stub          | HTTP stub         | Mocked |
| Express Server  | Real (random port) | N/A               | N/A    |

## 10. Exit Criteria

- All 7 E2E scenarios passing.
- All 7 integration scenarios passing.
- All 5 unit test suites passing.
- All 4 security test scenarios passing.
- Zero cross-tenant data leakage in any test.
- Code coverage > 80% for new processing services.
- No `vi.mock()` or `jest.mock()` usage in E2E tests.
