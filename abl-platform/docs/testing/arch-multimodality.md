# Test Spec: B03 Multimodality Support (Arch v0.3)

**Feature**: Multimodal file upload -- text files, images, vision, session-scoped storage, smart routing, provider-aware pipeline
**Owner**: Platform team
**Related Feature Docs**: [S1-F10 Text File Upload](../arch/features/S1-F10-text-file-upload.md), [S1-F11 Image Upload Vision](../arch/features/S1-F11-image-upload-vision.md)
**Design Doc**: [2026-04-05-multimodality-design.md](../arch/research/2026-04-05-multimodality-design.md)
**Dev Plan Review**: [2026-04-05-multimodality-dev-plan-review.md](../arch/research/2026-04-05-multimodality-dev-plan-review.md)
**Last Updated**: 2026-04-06
**Overall Status**: BETA (81 tests passing — 52 existing unit/integration + 19 new integration + 10 new E2E across multiple test files.)

> **Note (2026-04-06):** Implementation of Phases 0-3 is complete (10 commits, 16 new files, ~52 files touched across arch-ai, database, and studio packages). 19 integration tests passing (INT-1 through INT-6 scenarios covered) and 10 E2E tests passing (E2E-1 through E2E-7 scenarios covered). Total: 81 tests (52 existing + 19 integration + 10 E2E).

---

## Coverage Matrix

| FR    | Description                                                           | Unit | Integration | E2E | Manual | Status      |
| ----- | --------------------------------------------------------------------- | ---- | ----------- | --- | ------ | ----------- |
| FR-1  | Upload text files via POST /api/arch-ai/files with blobId return      | Yes  | Yes         | Yes | --     | PASSING     |
| FR-2  | Upload images (PNG, JPEG, WebP, GIF) with vision pipeline             | Yes  | Yes         | Yes | --     | PASSING     |
| FR-3  | SessionFileStore CRUD with SHA-256 dedup                              | Yes  | Yes         | Yes | --     | PASSING     |
| FR-4  | ArchContentBlock serialization in StoredMessage.content               | Yes  | Yes         | Yes | --     | PASSING     |
| FR-5  | Provider-aware content block resolution (Anthropic, OpenAI, Google)   | Yes  | Yes         | --  | --     | PASSING     |
| FR-6  | Non-vision model graceful degradation (text fallback)                 | Yes  | Yes         | Yes | --     | PASSING     |
| FR-7  | Session resume with multimodal messages (no [object Object])          | Yes  | Yes         | Yes | --     | PASSING     |
| FR-8  | File preamble injection in system prompt (outside sliding window)     | Yes  | Yes         | Yes | --     | PASSING     |
| FR-9  | SSE events: file_processed, file_error, file_context_change           | Yes  | Yes         | Yes | --     | PASSING     |
| FR-10 | Client-side validation (size, type, count limits)                     | Yes  | --          | --  | --     | NOT STARTED |
| FR-11 | Image resize in Web Worker (OffscreenCanvas)                          | Yes  | --          | --  | Yes    | NOT STARTED |
| FR-12 | Clipboard paste (Cmd+V screenshots)                                   | --   | --          | --  | Yes    | NOT STARTED |
| FR-13 | SVG XSS sanitization (DOMPurify)                                      | Yes  | Yes         | --  | --     | PASSING     |
| FR-14 | IDEPanel UPLOADS group with token gauge                               | --   | --          | --  | Yes    | NOT STARTED |
| FR-15 | SpecificationCard attached files section                              | --   | --          | --  | Yes    | NOT STARTED |
| FR-16 | Chat message file renderers (thumbnail, syntax preview, PDF badge)    | --   | --          | --  | Yes    | NOT STARTED |
| FR-17 | Image lightbox modal                                                  | --   | --          | --  | Yes    | NOT STARTED |
| FR-18 | Per-file upload progress indicators                                   | --   | --          | --  | Yes    | NOT STARTED |
| FR-19 | File context menu (per-type actions)                                  | --   | --          | --  | Yes    | NOT STARTED |
| FR-20 | Smart routing: OpenAPI import, ABL compile, CSV schema, PDF summarize | Yes  | Yes         | Yes | --     | PASSING     |
| FR-21 | Failed image auto-skip in executor                                    | Yes  | Yes         | Yes | --     | PASSING     |
| FR-22 | Token cost calculation per provider                                   | Yes  | --          | --  | --     | NOT STARTED |
| FR-23 | Magic byte verification (MIME vs content)                             | Yes  | Yes         | --  | --     | PASSING     |
| FR-24 | File status state machine (active/excluded/evicted/deleted/failed)    | Yes  | Yes         | --  | --     | PASSING     |
| FR-25 | Drag-drop zone prevention (ArchOverlay browser navigation fix)        | --   | --          | --  | Yes    | NOT STARTED |

---

## E2E Test Scenarios (MANDATORY -- minimum 5)

CRITICAL: E2E tests must NOT mock codebase components. API-only interaction. Real servers. Full middleware chain.

### E2E-1: Upload File via POST /api/arch-ai/files and Verify blobId

**Preconditions**: Studio running with real database. Active ArchSession exists.

**Steps**:

1. Create a test YAML file content (valid OpenAPI fragment, ~2KB)
2. Base64-encode the file content
3. `POST /api/arch-ai/files` with `{ sessionId, file: { name: 'api-spec.yaml', type: 'application/x-yaml', size: 2048, content: base64 } }`
4. Assert response status 200
5. Assert response body contains `blobId` (non-empty string)
6. Assert response body contains `metadata.tokenEstimate` (number > 0)
7. Assert response body contains `metadata.lineCount` (number > 0)
8. Re-upload the same file content (same bytes) to the same session
9. Assert returned `blobId` matches the first upload (SHA-256 dedup)

**Expected Result**: Upload endpoint returns blobId with metadata. Duplicate content returns the same blobId.

**Auth Context**: `tenantId: tenant-dev-001`, valid session token

**Isolation Check**: `POST /api/arch-ai/files` with a `sessionId` from a different tenant returns 404.

---

### E2E-2: Send Message with fileRef and Verify LLM Receives Content

**Preconditions**: Studio running with real LLM credentials. Active ArchSession with uploaded file (blobId from E2E-1).

**Steps**:

1. Upload a JSON file containing `{ "service": "payment-gateway", "port": 8080 }` via `POST /api/arch-ai/files` -- capture `blobId`
2. `POST /api/arch-ai/message` with `{ sessionId, type: 'message', text: 'What service is defined in the attached file?', fileRefs: [{ blobId }] }`
3. Consume SSE stream until `done` event
4. Assert at least one `text_delta` event contains text referencing "payment-gateway" or "8080" (proving LLM saw the file content)
5. Assert no `file_error` events were emitted
6. Verify `file_processed` SSE event was emitted with the correct `blobId`

**Expected Result**: LLM response references the file content, confirming the file was resolved and included in the LLM context.

**Auth Context**: `tenantId: tenant-dev-001`, valid session token

---

### E2E-3: Session Resume with Multimodal Messages -- No [object Object]

**Preconditions**: Session with at least one message containing ArchContentBlock[] (file_ref or image_ref).

**Steps**:

1. Upload a text file via `POST /api/arch-ai/files` -- capture `blobId`
2. Send a message with `fileRefs: [{ blobId }]` via `POST /api/arch-ai/message`
3. Wait for `done` event (message fully persisted)
4. Load session via `GET /api/arch-ai/sessions/:sessionId`
5. Assert the stored message `content` field is an array (ArchContentBlock[]), NOT a string containing `[object Object]`
6. Assert ArchContentBlock array contains a block with `type: 'text'` and a block with `type: 'file_ref'`
7. Assert the `file_ref` block has `blobId`, `name`, `mediaType`, `tokenCost`
8. Verify that `normalizeContent()` applied to the stored content returns a clean text string (no `[object Object]`)

**Expected Result**: Stored messages with content blocks survive persistence and restore without data corruption. The `[object Object]` regression from dev diary issues 14/15/21 does not recur.

**Auth Context**: `tenantId: tenant-dev-001`, valid session token

---

### E2E-4: Upload Image with Non-Vision Model -- Verify Text Fallback

**Preconditions**: ArchSession configured with a model that does NOT support vision (e.g., a text-only model where `supportsVision: false` in ModelCapabilities registry).

**Steps**:

1. Upload a PNG image via `POST /api/arch-ai/files` -- capture `blobId`
2. Assert upload succeeds (images are stored regardless of model capability)
3. `POST /api/arch-ai/message` with `{ text: 'Describe this image', fileRefs: [{ blobId }] }`
4. Consume SSE stream until `done`
5. Assert NO LLM API error (no 400 from provider)
6. Assert the LLM received a text fallback block (not a native image content block)
7. Assert the text fallback contains the image metadata: filename, dimensions, file type
8. Assert the response does not crash or produce an empty response

**Expected Result**: Non-vision models receive text metadata about the image instead of native image content blocks. The chat does not freeze or error.

**Auth Context**: `tenantId: tenant-dev-001`, valid session token

---

### E2E-5: Phase Transition with Files -- Verify File Preamble Persists

**Preconditions**: Active ArchSession in INTERVIEW phase with uploaded files.

**Steps**:

1. Upload two files (YAML + JSON) via `POST /api/arch-ai/files` in INTERVIEW phase
2. Send several messages to advance past the sliding window boundary (>8 messages)
3. Verify via session API that the file preamble is included in the system prompt
4. Trigger phase transition to BLUEPRINT (via normal Interview completion flow)
5. Send a message in BLUEPRINT phase: "What files do I have attached?"
6. Assert the LLM response references both uploaded files by name (proving preamble persisted across phase transition)
7. Assert `file_context_change` SSE events were NOT emitted (files remain active)
8. Send 8+ more messages in BLUEPRINT to push original file messages out of sliding window
9. Send another message referencing the files -- assert LLM still knows about them (preamble, not history)

**Expected Result**: Files injected via system prompt preamble survive phase transitions and sliding window eviction. This validates the resolution of review finding H1.

**Auth Context**: `tenantId: tenant-dev-001`, valid session token

---

### E2E-6: Full Interview Flow with File Upload -- Zero Regression

**Preconditions**: Clean ArchSession. Real LLM credentials. ONBOARDING mode.

**Steps**:

1. Start new ArchSession (INTERVIEW phase)
2. Send opening message without files -- assert normal Interview response
3. Upload a YAML config file via `POST /api/arch-ai/files`
4. Send message with fileRef: "Here's my existing API spec"
5. Assert LLM references the file content in response
6. Continue Interview flow (respond to questions, advance through widgets)
7. Assert no `ask_user` widgets are corrupted by content block changes
8. Assert `gate_request` events still work correctly (not overwritten by text_delta)
9. Transition to BLUEPRINT phase
10. Assert all messages (including file-carrying ones) are in session history

**Expected Result**: The full ONBOARDING path works with file uploads without regression to widgets, gates, or phase transitions.

**Auth Context**: `tenantId: tenant-dev-001`, valid session token

---

### E2E-7: Concurrent Multi-File Upload with Error Recovery

**Preconditions**: Active ArchSession. Studio running.

**Steps**:

1. Upload 5 valid files concurrently (parallel POST requests to `/api/arch-ai/files`)
2. Assert all 5 return 200 with unique blobIds
3. Upload 1 corrupt file (invalid base64 content)
4. Assert `file_error` SSE event with `code: 'decode_failed'`
5. Send a message with fileRefs pointing to the 5 valid blobIds + the failed blobId
6. Assert the message succeeds -- failed file is auto-skipped
7. Assert the LLM response references content from the 5 valid files
8. Assert the failed file does not cause subsequent messages to fail

**Expected Result**: Individual file failures do not block the message pipeline. Failed files are gracefully excluded.

**Auth Context**: `tenantId: tenant-dev-001`, valid session token

---

## Integration Test Scenarios (MANDATORY -- minimum 5)

### INT-1: SessionFileStore CRUD with SHA-256 Dedup

**Test file**: `packages/arch-ai/src/session/__tests__/session-file-store.integration.test.ts`

**Preconditions**: Real MongoDB connection (test database).

**Steps**:

1. Create a SessionFile with known content bytes
2. Assert document stored with correct `sessionId`, `tenantId`, `name`, `mediaType`, `size`, `hash`
3. Query by `{ sessionId, status: 'active' }` -- assert file found
4. Query by `{ sessionId, hash }` -- assert file found (dedup path)
5. Store identical content bytes for the same session -- assert same `_id` returned (dedup hit)
6. Store identical content bytes for a DIFFERENT session -- assert new `_id` (no cross-session dedup)
7. Update file status to `'excluded'` -- assert query by `{ sessionId, status: 'active' }` no longer includes it
8. Update file status to `'deleted'` -- assert still queryable (soft delete)
9. Query with wrong `tenantId` -- assert empty result (tenant isolation)
10. Verify indexes exist: `{ sessionId, status }`, `{ sessionId, hash }`, `{ tenantId, sessionId }`

**Expected Result**: SessionFileStore provides correct CRUD, SHA-256 dedup within sessions, tenant isolation, and soft deletion.

---

### INT-2: Content Block Resolution in Executor (Provider-Specific Formats)

**Test file**: `packages/arch-ai/src/executor/__tests__/content-block-resolution.integration.test.ts`

**Preconditions**: Executor with mock LLM client (external service mock via DI). Real content block resolution logic.

**Steps**:

1. Create an ArchContentBlock[] with `[{ type: 'text', text: 'hello' }, { type: 'file_ref', blobId: 'x', name: 'spec.yaml', mediaType: 'application/x-yaml', tokenCost: 500 }]`
2. Resolve for Anthropic provider -- assert output contains `[{ type: 'text', text: 'hello' }, { type: 'text', text: '[File: spec.yaml]\n...\n[/File]' }]`
3. Create an ArchContentBlock[] with `image_ref` block
4. Resolve for Anthropic provider (vision model) -- assert output `{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: '...' } }`
5. Resolve for OpenAI provider (vision model) -- assert output `{ type: 'image_url', image_url: { url: 'data:image/png;base64,...' } }`
6. Resolve for non-vision model with image_ref -- assert text fallback: `[Image: wireframe.png, 1200x800, PNG]`
7. Resolve with `image_ref` having `status: 'failed'` -- assert block is skipped entirely
8. Resolve file_ref where blobId not found in store -- assert graceful degradation (not crash)

**Expected Result**: Executor correctly converts ArchContentBlock[] to provider-specific formats with fallbacks for non-vision models and failed images.

---

### INT-3: SSE Event Parsing for New Event Types

**Test file**: `packages/arch-ai/src/streaming/__tests__/sse-parser.integration.test.ts`

**Preconditions**: Real SSE parser with updated Zod schema.

**Steps**:

1. Parse a `file_processed` event with full payload (blobId, name, mediaType, size, tokenCost, metadata) -- assert valid parse
2. Parse a `file_processed` event with `smartAction` (type, prompt, actions array) -- assert valid parse
3. Parse a `file_error` event with all error codes (corrupt, parse_failed, type_mismatch, too_large, decode_failed, invalid_spec) -- assert each valid
4. Parse a `file_context_change` event with all change types (evicted, included, excluded, deleted, failed) -- assert each valid
5. Parse a `file_context_change` event with `contextBudget: { used, total }` -- assert budget fields present
6. Parse an event with unknown `type: 'future_event'` -- assert `safeParse` returns `success: false` (no crash)
7. Parse all 15+ existing event types -- assert no regressions (text_delta, tool_call, done, error, activity, etc.)
8. Emit `file_processed` from a test server, consume via SSE client -- assert event arrives and parses correctly

**Expected Result**: SSE parser accepts all 3 new B03 event types, rejects unknown types gracefully, and does not regress on existing events.

---

### INT-4: File Preamble Injection in System Prompt

**Test file**: `apps/studio/src/app/api/arch-ai/__tests__/file-preamble.integration.test.ts`

**Preconditions**: Real route handler logic. Real SessionFileStore with test files.

**Steps**:

1. Store 3 files in SessionFileStore (1 YAML, 1 JSON, 1 image) for a session
2. Build the system prompt with file preamble injection
3. Assert preamble contains `[Session Files]` header
4. Assert preamble contains `[File: api-spec.yaml (YAML, 2.4KB)]` with inline content
5. Assert preamble contains `[Image: wireframe.png (PNG, 1200x800, 1.2MB)]` for the image
6. Mark the JSON file as `status: 'excluded'` -- rebuild preamble
7. Assert excluded file is NOT in the preamble
8. Test budget overflow: add files totaling >50% of context window
9. Assert oldest files evicted first, images before text
10. Assert `file_context_change` event data generated for each eviction

**Expected Result**: File preamble correctly includes active files, respects status changes, and evicts in the correct order when budget is exceeded.

---

### INT-5: ArchContentBlock Serialization/Deserialization Round-Trip

**Test file**: `packages/arch-ai/src/types/__tests__/content-blocks.integration.test.ts`

**Preconditions**: Real MongoDB connection.

**Steps**:

1. Create a StoredMessage with `content: 'plain text string'` -- save and reload -- assert `content === 'plain text string'`
2. Create a StoredMessage with `content: [{ type: 'text', text: 'hello' }, { type: 'file_ref', blobId: 'abc', name: 'spec.yaml', mediaType: 'application/x-yaml', tokenCost: 500 }]` -- save and reload
3. Assert loaded `content` is an array with 2 elements
4. Assert `content[0].type === 'text'` and `content[0].text === 'hello'`
5. Assert `content[1].type === 'file_ref'` with all fields preserved
6. Apply `normalizeContent()` to the loaded content -- assert returns `'hello'` (text extraction)
7. Apply `normalizeContent()` to a plain string -- assert returns the string unchanged
8. Create a StoredMessage with `content: [{ type: 'image_ref', blobId: 'img1', name: 'wireframe.png', mediaType: 'image/png', width: 1200, height: 800, tokenCost: 1920, status: 'active' }]`
9. Save, reload, apply `normalizeContent()` -- assert returns empty string (no text blocks)
10. Verify Mongoose `Schema.Types.Mixed` correctly stores both string and array forms

**Expected Result**: Content blocks survive MongoDB round-trip without corruption. `normalizeContent()` extracts text from both string and array content.

---

### INT-6: Magic Byte Verification and MIME Validation

**Test file**: `packages/arch-ai/src/session/__tests__/file-validation.integration.test.ts`

**Preconditions**: Real file processing pipeline.

**Steps**:

1. Upload a PNG file with correct magic bytes (`89 50 4E 47`) and `mediaType: 'image/png'` -- assert accepted
2. Upload a file with PNG extension but JPEG magic bytes (`FF D8 FF`) -- assert `file_error` with `code: 'type_mismatch'`
3. Upload a file with `.exe` extension -- assert rejected with unsupported type error
4. Upload a zero-byte file -- assert rejected with empty file error
5. Upload a file >10MB -- assert rejected with size limit error
6. Upload a valid SVG containing `<script>` tags -- assert DOMPurify strips the script (XSS prevention)
7. Upload a valid PDF -- assert magic bytes `%PDF` match claimed type

**Expected Result**: Server validates magic bytes against claimed MIME types and rejects mismatches, oversized files, empty files, and unsupported types.

---

## Unit Test Scenarios

### UNIT-1: normalizeContent() with String and ArchContentBlock[]

**Test file**: `packages/arch-ai/src/types/__tests__/content-blocks.unit.test.ts`

| #   | Input                                                                 | Expected Output                      |
| --- | --------------------------------------------------------------------- | ------------------------------------ |
| 1   | `'plain text message'`                                                | `'plain text message'`               |
| 2   | `[{ type: 'text', text: 'hello world' }]`                             | `'hello world'`                      |
| 3   | `[{ type: 'text', text: 'line1' }, { type: 'text', text: 'line2' }]`  | `'line1\nline2'`                     |
| 4   | `[{ type: 'file_ref', blobId: 'x', ... }]`                            | `''` (no text blocks)                |
| 5   | `[{ type: 'text', text: 'msg' }, { type: 'image_ref', blobId: 'y' }]` | `'msg'` (only text blocks extracted) |
| 6   | `[]` (empty array)                                                    | `''`                                 |
| 7   | `[{ type: 'tool_use', id: 'x', name: 'fn', input: {} }]`              | `''` (tool blocks filtered out)      |
| 8   | `undefined` (defensive)                                               | `''`                                 |

---

### UNIT-2: Client-Side Validation (Size, Type, Count Limits)

**Test file**: `apps/studio/src/components/arch-v3/chat/__tests__/file-validation.unit.test.ts`

| #   | Scenario                       | Input                            | Expected                              |
| --- | ------------------------------ | -------------------------------- | ------------------------------------- |
| 1   | File within size limit         | 5MB PNG                          | Accepted                              |
| 2   | File exceeds 10MB limit        | 15MB PNG                         | Error: "exceeds the 10 MB limit"      |
| 3   | Unsupported extension          | `.exe` file                      | Error: "Unsupported file type"        |
| 4   | Supported extensions accepted  | `.yaml`, `.json`, `.png`, `.pdf` | All accepted                          |
| 5   | 10 text files (at limit)       | 10 `.txt` files                  | Accepted                              |
| 6   | 11 text files (over limit)     | 11 `.txt` files                  | Error: "Maximum 10 text files"        |
| 7   | 5 images (at limit)            | 5 `.png` files                   | Accepted                              |
| 8   | 6 images (over limit)          | 6 `.png` files                   | Error: "Maximum 5 images per message" |
| 9   | Empty file (0 bytes)           | 0-byte `.txt`                    | Error: "is empty (0 bytes)"           |
| 10  | Session storage full (50MB)    | File pushing total over 50MB     | Error: "Session storage full"         |
| 11  | Mixed files within both limits | 10 text + 5 images               | Accepted                              |
| 12  | Image oversized (>1568px)      | 12000x8000 PNG                   | Silent resize, no error               |

---

### UNIT-3: Token Cost Calculation Per Provider

**Test file**: `packages/arch-ai/src/executor/__tests__/token-cost.unit.test.ts`

| #   | Provider  | Image Dimensions | Expected Calculation                   |
| --- | --------- | ---------------- | -------------------------------------- |
| 1   | Anthropic | 1200x800         | `(1200 * 800) / 750 = 1280 tokens`     |
| 2   | Anthropic | 1568x1568        | `(1568 * 1568) / 750 = 3277 tokens`    |
| 3   | OpenAI    | 1024x1024        | `~85 tokens/tile` (tile-based)         |
| 4   | OpenAI    | 512x512          | `85 tokens` (single tile)              |
| 5   | Google    | 1200x800         | Provider-specific formula              |
| 6   | Any       | Text file 2KB    | Estimate from character count (~500)   |
| 7   | Any       | Text file 50KB   | Estimate from character count (~12500) |

---

### UNIT-4: Magic Byte Verification

**Test file**: `packages/arch-ai/src/session/__tests__/magic-bytes.unit.test.ts`

| #   | Claimed MIME      | Actual Bytes (first 4) | Expected          |
| --- | ----------------- | ---------------------- | ----------------- |
| 1   | `image/png`       | `89 50 4E 47`          | Match (accept)    |
| 2   | `image/jpeg`      | `FF D8 FF E0`          | Match (accept)    |
| 3   | `image/png`       | `FF D8 FF E0`          | Mismatch (reject) |
| 4   | `image/gif`       | `47 49 46 38`          | Match (accept)    |
| 5   | `application/pdf` | `25 50 44 46`          | Match (accept)    |
| 6   | `image/webp`      | `52 49 46 46`          | Match (accept)    |
| 7   | `image/png`       | `00 00 00 00`          | Mismatch (reject) |

---

### UNIT-5: ArchContentBlock Type Guards

**Test file**: `packages/arch-ai/src/types/__tests__/content-block-guards.unit.test.ts`

| #   | Scenario                                    | Expected                                        |
| --- | ------------------------------------------- | ----------------------------------------------- |
| 1   | `isTextBlock({ type: 'text', text: 'hi' })` | `true`                                          |
| 2   | `isImageRef({ type: 'image_ref', ... })`    | `true`                                          |
| 3   | `isFileRef({ type: 'file_ref', ... })`      | `true`                                          |
| 4   | `isTextBlock({ type: 'file_ref', ... })`    | `false`                                         |
| 5   | `hasFileRefs([text, file_ref])`             | `true`                                          |
| 6   | `hasFileRefs([text, text])`                 | `false`                                         |
| 7   | `getTextContent(blocks)` with mixed blocks  | Returns concatenated text from text blocks only |
| 8   | `getFileRefs(blocks)` with mixed blocks     | Returns only file_ref and image_ref blocks      |

---

## Chat Freeze Prevention Tests

These 12 scenarios validate that no chat freeze occurs across all B03 phases. Derived from the design doc section 16 (Chat Freeze Prevention Checklist).

**Test file**: `apps/studio/e2e/arch-multimodality-freeze.spec.ts`

| #   | Scenario                            | Prevention Mechanism                               | Test Method                                                                  |
| --- | ----------------------------------- | -------------------------------------------------- | ---------------------------------------------------------------------------- |
| 1   | 5 images dropped at once            | Web Worker encoding + per-file progress            | Upload 5 images concurrently, assert chat input remains responsive           |
| 2   | Large file send                     | Separate upload endpoint, <1KB message payload     | Upload 10MB file, assert message POST payload <2KB (blobId reference only)   |
| 3   | Corrupt PDF uploaded                | 30s processing timeout, `file_error` emitted       | Upload corrupt PDF, assert `file_error` within 30s, chat not frozen          |
| 4   | 12000x8000 image pasted             | `OffscreenCanvas` in Worker                        | Paste oversized image, assert resize completes without main thread block     |
| 5   | Session resume with content blocks  | `normalizeContent()` type narrowing                | Resume session with ArchContentBlock[] messages, assert no `[object Object]` |
| 6   | New SSE events emitted              | All event types in Zod schema before emission      | Emit all 3 new event types, assert parser accepts (no silent drop)           |
| 7   | File "in context" but LLM can't see | File preamble in system prompt, not sliding window | Send 10+ messages after file, assert LLM still references file content       |
| 8   | Upload before session loads         | Queue uploads, show "connecting..." state          | Trigger upload before session ready, assert queued (not crashed)             |
| 9   | `refreshSession` during stream      | Metadata-only refresh, not full `loadSession`      | Trigger session refresh mid-stream, assert in-flight messages preserved      |
| 10  | `file_processed` after `done`       | Handle file events regardless of chat state        | Emit `file_processed` after `done` event, assert UI processes it             |
| 11  | Phase transition + upload race      | File preamble auto-includes in new phase           | Upload file during phase transition, assert file appears in new phase        |
| 12  | Processing error not caught         | Global 60s streaming timeout, forced idle          | Simulate hung processing, assert chat returns to idle within 60s             |

---

## Regression Tests (Phase-by-Phase)

All 42 regression tests from the dev plan review, organized by implementation phase. Each test maps to a specific past incident or fragile code path.

### Phase 0: Prerequisites (8 tests)

| #   | Test                                                                           | Validates            | Past Incident Ref         |
| --- | ------------------------------------------------------------------------------ | -------------------- | ------------------------- |
| 1   | Emit `file_processed` from server, confirm parser accepts                      | SSE schema alignment | Issue 1.5 (silent drops)  |
| 2   | Emit `file_error` from server, confirm parser accepts                          | SSE schema alignment | Issue 1.5                 |
| 3   | Emit `file_context_change` from server, confirm parser accepts                 | SSE schema alignment | Issue 1.5                 |
| 4   | Emit unknown event type, confirm silently dropped (not crash)                  | Parser safety        | Issue 1.5                 |
| 5   | Create session with `content: string`, resume, renders correctly               | Backward compat      | Issue 1.1 (schema chain)  |
| 6   | Create session with `content: ArchContentBlock[]`, resume, renders correctly   | Forward compat       | Issue 1.1                 |
| 7   | Drop file on ArchOverlay, browser does NOT navigate away                       | Prerequisite 3       | Issue 1.4 (overlay)       |
| 8   | Send message with files from ChatInputBar, `useArchChat.send()` receives files | Prerequisite 4       | Issue 1.3 (dropped files) |

### Phase 1: Upload + Content Blocks (12 tests)

| #   | Test                                                                          | Validates             | Past Incident Ref              |
| --- | ----------------------------------------------------------------------------- | --------------------- | ------------------------------ |
| 9   | POST file to `/api/arch-ai/files`, 200 with `blobId`                          | Upload endpoint       | --                             |
| 10  | Send message with fileRef, `StoredMessage.content` is `ArchContentBlock[]`    | Persistence           | Issue 1.1 (schema mismatch)    |
| 11  | Reload after file message, message renders correctly (not `[object Object]`)  | Session resume        | Issue 1.4 (widget not rebuilt) |
| 12  | Send 10+ messages after file, file still in LLM context via preamble          | Sliding window        | Review finding H1              |
| 13  | `llmMessages` array has provider content blocks for file messages             | LLM builder           | Issue 1.1                      |
| 14  | Send message producing `content: []`, no crash                                | Edge case             | Defensive (empty array)        |
| 15  | Full Interview flow (message, widget, continue to Blueprint), zero regression | ONBOARDING path       | Issue 1.4                      |
| 16  | Send message in overlay, multi-turn completes                                 | IN_PROJECT path       | Prerequisite 3                 |
| 17  | Reload with pending `ask_user` widget + content block history, widget renders | Widget reconstruction | Issue 1.4                      |
| 18  | Reload with pending gate + content block history, gate renders                | Gate reconstruction   | Issue 1.4                      |
| 19  | Send file message, LLM response doesn't overwrite file message                | text_delta guard      | Issue 1.3 (delta overwrites)   |
| 20  | Upload file, processing exceeds 30s timeout, `file_error` emitted             | Processing timeout    | Review finding H4              |

### Phase 2: Image + Vision (10 tests)

| #   | Test                                                                  | Validates          | Past Incident Ref             |
| --- | --------------------------------------------------------------------- | ------------------ | ----------------------------- |
| 21  | Paste 12000x8000 image, resize in Worker, no main thread freeze       | Worker resize      | Review finding H5             |
| 22  | Send image to non-vision model, text fallback (not crash)             | Vision gating      | Design decision (section 3.3) |
| 23  | Send image to Anthropic, `source.type: 'base64'` format               | Provider format    | --                            |
| 24  | Upload corrupt image, `status: 'failed'`, subsequent messages skip it | Auto-skip          | Design section 7.5            |
| 25  | Cmd+V screenshot, file appears in attachment area                     | Clipboard paste    | --                            |
| 26  | Upload SVG with `<script>`, DOMPurify strips it                       | XSS prevention     | Edge case E6                  |
| 27  | Reload after sending image, thumbnails render                         | Resume with images | Issue 1.4                     |
| 28  | Drop 5 images simultaneously, per-file progress, no freeze            | Concurrent uploads | Review finding C2/C3          |
| 29  | Upload files totaling 45MB, token gauge shows near-limit              | Budget calculation | --                            |
| 30  | Upload file, switch model, gauge recalculates immediately             | Model switch       | Edge case E4                  |

### Phase 3: UI Integration (8 tests)

| #   | Test                                                             | Validates           | Past Incident Ref |
| --- | ---------------------------------------------------------------- | ------------------- | ----------------- |
| 31  | Upload file, appears in IDEPanel UPLOADS group                   | File tree           | --                |
| 32  | Upload during Interview, "Attached Files" in SpecificationCard   | Spec card           | --                |
| 33  | Use FileAttachment in overlay, file uploads                      | Overlay integration | Prerequisite 3    |
| 34  | Right-click file, per-type context menu                          | Context menu        | --                |
| 35  | Image thumbnail, code syntax preview, PDF badge render correctly | Chat renderers      | --                |
| 36  | Click image thumbnail, lightbox opens                            | Lightbox            | --                |
| 37  | Upload large file, per-file progress indicator                   | Progress bar        | Review C2/C3      |
| 38  | Delete file, "removed" badge in chat history                     | Deleted state       | --                |

### Phase 4: Smart Routing (4 tests)

| #   | Test                                               | Validates   | Past Incident Ref |
| --- | -------------------------------------------------- | ----------- | ----------------- |
| 39  | Upload OpenAPI spec, "Import as tools?" suggestion | Auto-detect | --                |
| 40  | Upload `.abl.yaml`, "Compile?" suggestion          | Auto-detect | --                |
| 41  | Upload CSV, schema analysis suggestion             | Auto-detect | --                |
| 42  | Upload >5 page PDF, summarization offer            | Auto-detect | --                |

---

## Acceptance Criteria Traceability

### From S1-F10 (Text File Upload)

| Acceptance Criterion                         | Covered By    |
| -------------------------------------------- | ------------- |
| Drag-drop file onto chat area, badge appears | E2E-6, Reg #8 |
| Click attachment button, file browser opens  | Manual, FR-1  |
| Upload JSON, LLM references content          | E2E-2         |
| Upload 11 files, error message               | UNIT-2 #6     |
| Upload >10MB file, error message             | UNIT-2 #2     |
| Upload `.exe`, error message                 | UNIT-2 #3     |
| File badge shows filename and type label     | Reg #35       |
| PDF upload: LLM receives extracted text      | E2E-2, INT-2  |
| DOCX upload: LLM receives extracted text     | INT-2         |

### From S1-F11 (Image Upload Vision)

| Acceptance Criterion                           | Covered By         |
| ---------------------------------------------- | ------------------ |
| Drag-drop PNG, thumbnail appears               | Reg #25, Reg #35   |
| Send image, LLM describes content              | E2E-2 (with image) |
| Wireframe upload, LLM identifies UI components | Manual, E2E-2      |
| Image in `files` array of POST request         | E2E-1              |
| Server does NOT OCR images                     | INT-2 #4 (vision)  |
| Thumbnail renders at max 200px width           | Reg #35, Manual    |
| Click thumbnail, lightbox opens                | Reg #36            |
| Upload 15MB image, error message               | UNIT-2 #2          |
| Upload 6 images, error message                 | UNIT-2 #8          |

---

## Test Infrastructure Requirements

### E2E Test Setup

- Real Studio server running on test port (random port via `{ port: 0 }`)
- Real MongoDB instance (test database, cleaned between tests)
- Real LLM credentials (or provider sandbox if available)
- No `vi.mock()` or `jest.mock()` -- only DI-based external service mocks
- SSE client for consuming streaming responses
- File fixtures: sample YAML, JSON, PNG, PDF, DOCX, CSV files in `__fixtures__/`

### Integration Test Setup

- Real MongoDB connection (test database)
- Real file processing pipeline (no mocked extraction)
- Real SSE parser with Zod schema
- Provider-specific content block formatters (real code, mocked LLM API calls via DI)

### Unit Test Setup

- No external dependencies
- Pure function testing (normalizeContent, validation, token calculation, magic bytes)
- Standard vitest assertions

---

## Risk Matrix

| Risk                                              | Likelihood | Impact   | Mitigation                                        |
| ------------------------------------------------- | ---------- | -------- | ------------------------------------------------- |
| `[object Object]` from partial content migration  | HIGH       | CRITICAL | normalizeContent() at all 10 read sites (INT-5)   |
| SSE events silently dropped by parser             | HIGH       | HIGH     | Schema-first: Zod updated before emission (INT-3) |
| text_delta overwrites file-carrying message       | MEDIUM     | HIGH     | Guard condition extended for all message shapes   |
| File lost after sliding window eviction           | HIGH       | HIGH     | File preamble in system prompt (E2E-5, INT-4)     |
| Main thread freeze from base64 encoding           | MEDIUM     | HIGH     | Web Worker encoding (Freeze #1, #4)               |
| Failed image bricks all subsequent messages       | LOW        | CRITICAL | Auto-skip failed images (INT-2 #7, E2E-7)         |
| ArchOverlay file drop navigates browser away      | HIGH       | MEDIUM   | preventDefault handlers (Reg #7)                  |
| loadSession during stream destroys in-flight msgs | MEDIUM     | HIGH     | refreshSession (metadata-only) during streams     |
