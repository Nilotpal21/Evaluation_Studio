# Capability Gaps — E2E & Integration Test Plan

> Generated 2026-03-21. Covers all 16 gaps implemented across Phases 0–4.
> All 150 existing tests are **unit tests** (mocked deps). This plan adds **E2E** (real HTTP, real MongoDB, real middleware) and **integration** (real services, partial mocking) coverage.

---

## Test Infrastructure Reference

| Harness                           | Location                                                    | What It Provides                                            |
| --------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------- |
| `startRuntimeApiHarness()`        | `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts` | Real Express + MongoMemoryServer + random port              |
| `bootstrapProject()`              | `helpers/channel-e2e-bootstrap.ts`                          | devLogin → tenant → project via HTTP API                    |
| `startMockLLM()`                  | `tools/agents/e2e-functional/mock-llm-server.ts`            | OpenAI-compatible mock with pattern matching + streaming    |
| `startMultimodalServiceHarness()` | `helpers/multimodal-service-harness.ts`                     | Real AttachmentService + local storage + random port        |
| `startRedisServerHarness()`       | `helpers/redis-server-harness.ts`                           | Real redis-server on random port                            |
| `MockWebSocket`                   | `ws-sdk-handler.test.ts`                                    | EventEmitter-based WS mock with `send`/`close` tracking     |
| `injectTenantContext()`           | `helpers/auth-context.ts`                                   | Express middleware for RBAC injection                       |
| `requestJson()`                   | `helpers/channel-e2e-bootstrap.ts`                          | Generic fetch wrapper returning `{ status, body, headers }` |

**E2E Test Rules (from CLAUDE.md):**

- No `vi.mock()` or `jest.mock()` of codebase components
- API-only interaction (seed via POST, assert via GET)
- Real servers on random ports with full middleware chain
- No direct DB queries (no Mongoose models in tests)

---

## Part 1: E2E Test Checklist

### E2E-1: Attachment PII Redaction Pipeline (Phase 0)

**File:** `apps/runtime/src/__tests__/attachment-pii.e2e.test.ts`

**Harnesses:** `startRuntimeApiHarness()` + `startMultimodalServiceHarness()` + `startMockLLM()`

**Setup:**

```
bootstrapProject() → importProjectFiles() with basic chat agent
→ provisionTenantModel() pointing at mockLLM.url
```

| #       | Scenario                                                          | Steps                                                                                                                                     | Assert                                                                                       |
| ------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| E2E-0.1 | Upload doc with PII, send message → LLM receives redacted content | 1. POST upload with text file containing `user@example.com` 2. POST chat message referencing attachment 3. Check mockLLM.getLastRequest() | User message in LLM request does NOT contain `user@example.com`, contains `[REDACTED:email]` |
| E2E-0.2 | Upload clean doc → LLM receives full content                      | 1. POST upload with clean text file 2. POST chat message                                                                                  | LLM request contains full extracted text                                                     |
| E2E-0.3 | Tenant piiPolicy='block' → LLM receives block message             | 1. Update tenant attachment config with `piiPolicy: 'block'` via API 2. Upload PII doc 3. Send message                                    | LLM receives `[File contains PII and cannot be processed]`                                   |
| E2E-0.4 | Tenant piiPolicy='allow' → LLM receives raw content               | 1. Set `piiPolicy: 'allow'` 2. Upload PII doc 3. Send message                                                                             | LLM receives raw PII content                                                                 |
| E2E-0.5 | Image upload → no PII detection (regression)                      | 1. Upload PNG image 2. Send message                                                                                                       | No PII detection attempted, image processed normally                                         |
| E2E-0.6 | Multiple attachments, mixed PII → correct per-file handling       | 1. Upload 2 files (one with PII, one clean) 2. Send message                                                                               | PII file redacted, clean file verbatim in LLM context                                        |

---

### E2E-2: Attachment Tool Round-Trip (Phase 1)

**File:** `apps/runtime/src/__tests__/attachment-tools.e2e.test.ts`

**Harnesses:** `startRuntimeApiHarness()` + `startMultimodalServiceHarness()` + `startMockLLM()`

**Setup:**

```
bootstrapProject() → importProjectFiles() with agent that has attachment tools enabled
→ provisionTenantModel() → mockLLM with tool call patterns
```

| #       | Scenario                                                  | Steps                                                                                                                     | Assert                                                                                      |
| ------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| E2E-1.1 | Agent calls `upload_attachment` → file created in session | 1. Send message 2. mockLLM returns `upload_attachment` tool call with base64 PNG 3. Agent responds                        | Attachment created, `list_attachments` shows it, response references the file               |
| E2E-1.2 | Agent calls `get_attachment_url` → presigned URL returned | 1. Upload file via API 2. Send message 3. mockLLM returns `get_attachment_url` call with attachment ID                    | Response includes URL, URL is fetchable                                                     |
| E2E-1.3 | Agent uses `type: attachment` param → valid ID accepted   | 1. Upload file 2. Send message 3. mockLLM passes attachment ID to custom tool                                             | Tool executes successfully, no validation error                                             |
| E2E-1.4 | Agent uses `type: attachment` param → invalid ID rejected | 1. Send message 2. mockLLM passes fake attachment ID to custom tool                                                       | Tool returns error, agent receives helpful message about using `list_attachments`           |
| E2E-1.5 | Retry failed attachment via API                           | 1. Upload file 2. Force `processingStatus: 'failed'` (via internal endpoint or test setup) 3. POST `/:attachmentId/retry` | Status resets to `pending`, `retryCount` incremented, GET status shows reprocessing         |
| E2E-1.6 | Tool schemas include all attachment tools                 | 1. Load agent with attachments enabled 2. Inspect tool schemas from mockLLM request                                       | `list_attachments`, `get_attachment`, `upload_attachment`, `get_attachment_url` all present |
| E2E-1.7 | Cross-session attachment isolation                        | 1. Upload file in session A 2. In session B, mockLLM calls `get_attachment` with session A's ID                           | Tool returns error (not found), not 403                                                     |

---

### E2E-3: Advanced Attachment Modes & Routing (Phase 3A)

**File:** `apps/runtime/src/__tests__/attachment-advanced.e2e.test.ts`

**Harnesses:** `startRuntimeApiHarness()` + `startMultimodalServiceHarness()` + `startMockLLM()` + external destination mock server

| #        | Scenario                                               | Steps                                                                                                                         | Assert                                                                       |
| -------- | ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| E2E-3A.1 | `processingMode: 'scan-only'` → not injected into LLM  | 1. Upload with `processingMode: 'scan-only'` 2. Send message                                                                  | mockLLM.getLastRequest() does NOT contain file content                       |
| E2E-3A.2 | `processingMode: 'full'` (default) → injected into LLM | 1. Upload without specifying mode 2. Send message                                                                             | mockLLM request contains extracted text                                      |
| E2E-3A.3 | `route_attachment` to named destination                | 1. Import DSL with DESTINATIONS block 2. Upload file 3. mockLLM calls `route_attachment`                                      | External mock server receives HTTP request with file content                 |
| E2E-3A.4 | `route_attachment` SSRF blocked                        | 1. mockLLM calls `route_attachment` with `http://169.254.169.254/`                                                            | Tool returns error about blocked URL                                         |
| E2E-3A.5 | AWAIT_ATTACHMENT in scripted flow                      | 1. Import DSL with AWAIT_ATTACHMENT step 2. Send text message (no file) 3. Receive prompt to upload 4. Send message with file | Flow continues after file received, attachment ID stored in context variable |
| E2E-3A.6 | AWAIT_ATTACHMENT wrong category                        | 1. Flow expects `category: 'image'` 2. Upload PDF                                                                             | Error message about wrong file type                                          |

---

### E2E-4: Thoughts & Status via WebSocket (Phases 2B, 3B)

**File:** `apps/runtime/src/__tests__/thoughts-status-ws.e2e.test.ts`

**Harnesses:** `startRuntimeApiHarness()` + `startMockLLM()` + WebSocket client

**Note:** This test connects via WebSocket (not HTTP) to verify real-time event delivery.

| #        | Scenario                                                | Steps                                                                                                                       | Assert                                                                        |
| -------- | ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
| E2E-2B.1 | `tool_thought` event reaches WS client                  | 1. Connect WS 2. Send message 3. mockLLM returns tool call with `thought` field                                             | WS receives `trace_event` with `type: 'tool_thought'` containing thought text |
| E2E-2B.2 | `reason` fallback when thinking disabled                | 1. Deploy agent with `enableThinking: false` 2. Connect WS 3. Send message 4. mockLLM returns tool call with `reason` field | WS receives `tool_thought` with `thought: null, reasoning: <reason text>`     |
| E2E-2B.3 | `status_update` reaches WS client during tool execution | 1. Connect WS 2. Send message triggering slow tool 3. Filler service emits status                                           | WS receives `status_update` message with text                                 |
| E2E-2B.4 | `status_clear` sent after tool completes                | 1. Continuation of 2B.3                                                                                                     | WS receives `status_clear` after tool execution                               |
| E2E-2B.5 | `llmCallId` on tool_thought events (correlation)        | 1. Connect WS 2. Send message 3. mockLLM returns 2 tool calls                                                               | Both `tool_thought` events share same `llmCallId`                             |
| E2E-2B.6 | `step_thought` from scripted flow step                  | 1. Deploy scripted agent with flow steps 2. Connect WS 3. Send message triggering flow                                      | WS receives `trace_event` with `type: 'step_thought'`                         |
| E2E-2B.7 | Status auto-cleared on response_end                     | 1. Connect WS 2. Trigger tool with status 3. Wait for response_end                                                          | No stale `statusMessage` after response completes                             |

---

### E2E-5: Voice Thought & Status Flow (Phase 4)

**File:** `apps/runtime/src/__tests__/voice-thoughts-e2e.test.ts`

**Harnesses:** `startRuntimeApiHarness()` + `startMockLLM()` + SDK WebSocket client

| #       | Scenario                                                  | Steps                                                                                                        | Assert                                                                            |
| ------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| E2E-4.1 | Voice session → tool call → thought reaches SDK WS client | 1. Start voice session via WS 2. Mock voice provider triggers tool call with thought 3. Voice turn completes | SDK WS receives `trace_event` with `tool_thought`                                 |
| E2E-4.2 | Voice session → status filler during processing           | 1. Start voice session 2. Trigger slow tool execution                                                        | SDK WS receives `status_update` then `status_clear`                               |
| E2E-4.3 | Voice session → thought NOT silently dropped (regression) | 1. Start voice session 2. Provider sends tool call with thought                                              | Client `sentMessages` includes `tool_thought` event (verifies the fix for D1 gap) |

---

### E2E-6: Studio Attachment UX (Phase 2A)

**File:** `apps/studio/src/__tests__/e2e/attachment-ux-e2e.test.ts`

**Note:** Studio E2E tests use real runtime process (see `tool-invocations-api.e2e.test.ts` pattern) or can be component-level with real API calls against harness.

| #        | Scenario                                   | Steps                                                                          | Assert                                          |
| -------- | ------------------------------------------ | ------------------------------------------------------------------------------ | ----------------------------------------------- |
| E2E-2A.1 | Download attachment via presigned URL      | 1. Upload file to session via API 2. Click attachment chip 3. Verify URL fetch | Presigned URL returned, contains valid download |
| E2E-2A.2 | File upload via drag-and-drop              | 1. Simulate drop event with file 2. Verify upload API called                   | File appears in pending list, upload succeeds   |
| E2E-2A.3 | Image thumbnail renders from presigned URL | 1. Upload image attachment 2. Render message with attachment                   | `<img>` element rendered with presigned URL src |
| E2E-2A.4 | Audio/video files accepted by picker       | 1. Select .mp3 file 2. Verify upload triggered                                 | Upload proceeds (not rejected by accept filter) |

---

### E2E-7: Per-Project Attachment Config (Phase 3B)

**File:** `apps/runtime/src/__tests__/attachment-project-config-e2e.test.ts`

**Harnesses:** `startRuntimeApiHarness()` + `startMultimodalServiceHarness()`

| #        | Scenario                                    | Steps                                                                                                            | Assert                                    |
| -------- | ------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| E2E-3B.1 | Project config overrides tenant maxFileSize | 1. Set tenant config `maxFileSizeBytes: 10MB` 2. Set project config `maxFileSizeBytes: 50MB` 3. Upload 30MB file | Upload succeeds (project override)        |
| E2E-3B.2 | Tenant fallback when no project config      | 1. Set tenant config `maxFileSizeBytes: 5MB` 2. No project config 3. Upload 8MB file                             | Upload rejected (tenant limit)            |
| E2E-3B.3 | Project disables attachments                | 1. Set project config `enabled: false` 2. Upload file                                                            | Upload returns 403                        |
| E2E-3B.4 | Project piiPolicy overrides tenant          | 1. Tenant `piiPolicy: 'allow'` 2. Project `piiPolicy: 'block'` 3. Upload PII doc, send message                   | LLM receives block message (project wins) |

---

## Part 2: Integration Test Checklist

### INTEG-1: PII Detection Pipeline (Phase 0)

**File:** `apps/multimodal-service/src/__tests__/pii-pipeline-integration.test.ts`

**Setup:** Supertest against real Express app with real `containsPII`/`redactPII` (no mocking of PII detector).

| #     | Scenario                                        | Setup                                                                              | Assert                                                           |
| ----- | ----------------------------------------------- | ---------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| I-0.1 | Upload doc → process → hasPII flag set          | Upload text buffer containing email, run scan→validate→process workers in sequence | Attachment record has `hasPII: true`, `piiDetections.length > 0` |
| I-0.2 | Re-upload same content hash preserves PII flags | Upload same content twice                                                          | Second returns existing ID with PII flags                        |
| I-0.3 | PII detection failure non-blocking              | Mock `detectPII` to throw, process doc                                             | `processingStatus: 'completed'`, `hasPII: false`, error logged   |
| I-0.4 | Large doc with many PII instances               | Upload doc with 50+ PII instances                                                  | All detected, offsets correct, performance < 1s                  |

---

### INTEG-2: MessagePreprocessor + Real PII Detector (Phase 0)

**File:** `apps/runtime/src/attachments/__tests__/preprocessor-pii-integration.test.ts`

**Setup:** Real `MessagePreprocessor` with mocked `MultimodalServiceClient` returning real PII content. Real `redactPII` function (not mocked).

| #     | Scenario                               | Setup                                                     | Assert                                                |
| ----- | -------------------------------------- | --------------------------------------------------------- | ----------------------------------------------------- |
| I-0.5 | Redaction preserves surrounding text   | Attachment with `"Call John at 555-123-4567 for details"` | Result: `"Call John at [REDACTED:phone] for details"` |
| I-0.6 | Multiple PII types redacted correctly  | Email + SSN + credit card in same content                 | Each type gets correct `[REDACTED:type]` tag          |
| I-0.7 | Truncated content with PII at boundary | 50,000 char content with PII at char 49,990               | PII at boundary still redacted (offset validation)    |
| I-0.8 | Unicode content with PII               | Japanese text mixed with email address                    | Email detected and redacted, unicode preserved        |

---

### INTEG-3: Attachment Tool Execution (Phase 1)

**File:** `apps/runtime/src/tools/__tests__/attachment-tools-integration.test.ts`

**Setup:** Real `AttachmentToolExecutor` with real `MultimodalServiceClient` pointing at `startMultimodalServiceHarness()`.

| #     | Scenario                                            | Setup                          | Assert                                                           |
| ----- | --------------------------------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| I-1.1 | `upload_attachment` creates real file in storage    | Call tool with base64 content  | File exists in harness storage, retrievable via `get_attachment` |
| I-1.2 | `get_attachment_url` returns working presigned URL  | Upload file, call tool         | URL is fetchable, returns correct content                        |
| I-1.3 | `upload_attachment` → `list_attachments` round-trip | Upload 3 files via tool        | `list_attachments` returns all 3 with correct metadata           |
| I-1.4 | Attachment param validation against real service    | Call tool with non-existent ID | Service returns 404, validator produces correct error message    |

---

### INTEG-4: Compiler DESTINATIONS Pipeline (Phase 3A)

**File:** `packages/compiler/src/__tests__/destinations-integration.test.ts`

**Setup:** Real ABL parser + real IR compiler (no mocks).

| #      | Scenario                                             | Setup                                               | Assert                                                             |
| ------ | ---------------------------------------------------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| I-3A.1 | Full DSL with DESTINATIONS compiles to valid IR      | Parse + compile DSL with 3 destinations             | IR has `destinations[]` with correct URLs, methods, headers        |
| I-3A.2 | DSL without DESTINATIONS still compiles (regression) | Parse + compile DSL without DESTINATIONS block      | No `destinations` field on IR, zero errors                         |
| I-3A.3 | DESTINATIONS with invalid URL rejected               | DSL with `url: "not-a-url"`                         | Compiler error at correct line number                              |
| I-3A.4 | DESTINATIONS with private IP rejected (SSRF)         | DSL with `url: "http://10.0.0.1/internal"`          | Compiler warning/error about SSRF                                  |
| I-3A.5 | AWAIT_ATTACHMENT compiles to correct IR              | DSL with `AWAIT_ATTACHMENT` step                    | IR has `await_attachment` with variable, category, required fields |
| I-3A.6 | GATHER with attachment field compiles                | DSL with GATHER containing `type: attachment` field | IR gather field has `attachment_config`                            |

---

### INTEG-5: Flow Step Thought Emission (Phase 3B)

**File:** `apps/runtime/src/__tests__/flow-step-thoughts-integration.test.ts`

**Setup:** Real `FlowStepExecutor` with `ValidatingMockAnthropicClient` + `createTraceCollector()`.

| #      | Scenario                                        | Setup                                     | Assert                                                              |
| ------ | ----------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------- |
| I-3B.1 | Multi-step flow emits thought per step          | Flow with RESPOND → SET → COLLECT         | `traces` array has 3 `step_thought` events in order                 |
| I-3B.2 | Custom description overrides auto-generated     | Step with `description: "Checking order"` | `step_thought` event has custom description                         |
| I-3B.3 | `show_step_thoughts: false` suppresses emission | IR config disables step thoughts          | No `step_thought` events in traces                                  |
| I-3B.4 | Step thoughts interleave with tool_thoughts     | Scripted flow calls reasoning zone        | Both `step_thought` and `tool_thought` in traces, correctly ordered |

---

### INTEG-6: llmCallId Correlation (Phase 3B)

**File:** `apps/runtime/src/__tests__/llm-call-correlation-integration.test.ts`

**Setup:** Real `ReasoningExecutor` with `ValidatingMockAnthropicClient` + `createTraceCollector()`.

| #      | Scenario                                         | Setup                                  | Assert                                                              |
| ------ | ------------------------------------------------ | -------------------------------------- | ------------------------------------------------------------------- |
| I-3B.5 | Single LLM call → llmCallId on all tool_thoughts | LLM returns 3 tool calls with thoughts | All 3 `tool_thought` traces share same `llmCallId`                  |
| I-3B.6 | Sequential LLM calls → different llmCallIds      | Two LLM turns                          | First batch has `llmCallId_1`, second has `llmCallId_2`             |
| I-3B.7 | llmCallId also on `llm_call` trace event         | Single LLM call                        | Both `llm_call` and `tool_thought` traces have matching `llmCallId` |

---

### INTEG-7: WebSocket Status Event Forwarding (Phase 2B)

**File:** `apps/runtime/src/__tests__/ws-status-forwarding-integration.test.ts`

**Setup:** `MockWebSocket` + real `RuntimeExecutor` wiring (or sdk-handler with mock executor).

| #      | Scenario                                                      | Setup                                | Assert                                                         |
| ------ | ------------------------------------------------------------- | ------------------------------------ | -------------------------------------------------------------- |
| I-2B.1 | Filler service emits `status_update` → forwarded to WS client | Trigger tool call, filler fires      | `ws.send` called with `{ type: 'status_update', text: '...' }` |
| I-2B.2 | `status_clear` sent after tool completes                      | Tool execution finishes              | `ws.send` called with `{ type: 'status_clear' }`               |
| I-2B.3 | Status events NOT persisted to trace store                    | Status events emitted                | No `status_update` in persisted traces (transient only)        |
| I-2B.4 | Multiple rapid status updates → all forwarded                 | 3 status updates in quick succession | All 3 arrive at WS client                                      |

---

### INTEG-8: Voice Client Event Handling (Phase 4)

**File:** `packages/web-sdk/src/__tests__/voice-client-integration.test.ts`

**Setup:** Real `VoiceClient` + `MockSessionManager` (no vi.mock of VoiceClient internals).

| #     | Scenario                                                    | Setup                                    | Assert                                    |
| ----- | ----------------------------------------------------------- | ---------------------------------------- | ----------------------------------------- |
| I-4.1 | `trace_event` with `tool_thought` → `thought` event emitted | Simulate WS message                      | Event listener fires with correct payload |
| I-4.2 | `trace_event` with `status_update` → `statusUpdate` event   | Simulate WS message                      | Event fires                               |
| I-4.3 | `trace_event` with unknown type → no crash                  | Simulate WS with `type: 'unknown_event'` | No error, no event emitted                |
| I-4.4 | React `useVoice()` updates `thought` state                  | Simulate `tool_thought`                  | Hook returns updated `thought` value      |

---

### INTEG-9: ChatClient Status Handling (Phase 4)

**File:** `packages/web-sdk/src/__tests__/chat-client-integration.test.ts`

**Setup:** Real `ChatClient` + `MockSessionManager`.

| #     | Scenario                                          | Setup                                                     | Assert                          |
| ----- | ------------------------------------------------- | --------------------------------------------------------- | ------------------------------- |
| I-4.5 | `status_update` message → event emitted           | Simulate WS `{ type: 'status_update', text: '...' }`      | `statusUpdate` event fires      |
| I-4.6 | `status_clear` message → event emitted            | Simulate WS `{ type: 'status_clear' }`                    | `statusClear` event fires       |
| I-4.7 | Status events accessible via embedding app `on()` | Register listener via `chatClient.on('statusUpdate', fn)` | Listener called with `{ text }` |

---

### INTEG-10: Voice Filler Adapter (Phase 4)

**File:** `apps/runtime/src/__tests__/voice-filler-integration.test.ts`

**Setup:** Real `VoiceChannelFillerAdapter` + `TestRealtimeSession` (from existing voice tests).

| #      | Scenario                                       | Setup                             | Assert                                                     |
| ------ | ---------------------------------------------- | --------------------------------- | ---------------------------------------------------------- |
| I-4.8  | Filler emits audio for realtime mode           | Trigger filler → realtime session | `session.sendAudio()` called with synthesized audio buffer |
| I-4.9  | Filler suppressed during barge-in              | User speaking (barge-in active)   | No filler audio sent                                       |
| I-4.10 | Filler cancelled when response arrives quickly | LLM response within 200ms         | Filler not delivered                                       |
| I-4.11 | Message pool rotation                          | Trigger filler 5 times            | Different messages selected (not always same)              |

---

## Part 3: Regression Test Checklist

These tests verify existing functionality is NOT broken by the new capabilities.

### REG-1: Existing Attachment Flow (All Phases)

| #   | Scenario                                             | What It Guards                                      |
| --- | ---------------------------------------------------- | --------------------------------------------------- |
| R-1 | Upload via REST API (non-tool path) still works      | Tool upload path doesn't break REST upload          |
| R-2 | `get_attachment` tool returns same format            | New tools don't change existing tool response shape |
| R-3 | `list_attachments` tool unchanged                    | Same                                                |
| R-4 | Channel attachments (WhatsApp/Slack media) processed | Channel convergence unaffected                      |
| R-5 | Image processing unchanged (no PII detection)        | Image pipeline not broken by PII interceptor        |
| R-6 | Filename sanitization still works                    | Preprocessor changes don't break sanitization       |
| R-7 | Content truncation at 50K chars still works          | PII redaction doesn't interfere with truncation     |
| R-8 | Failed processing shows `[Failed to process]`        | Retry changes don't break failure display           |

### REG-2: Existing Thought Flow (Phases 2B, 3B)

| #    | Scenario                                                      | What It Guards                                                |
| ---- | ------------------------------------------------------------- | ------------------------------------------------------------- |
| R-9  | `enableThinking: true` still emits `thought` as before        | Reason fallback doesn't change thinking-enabled path          |
| R-10 | `thought` field still injected into tool schemas when enabled | Schema generation unchanged                                   |
| R-11 | Observatory still receives all trace events                   | Chat-side thought handling doesn't interfere with Observatory |
| R-12 | Existing `tool_thought` events have all current fields        | Adding `llmCallId` doesn't remove existing fields             |
| R-13 | `<status>` tag parsing in streaming still works               | Filler system changes don't break tag parser                  |

### REG-3: Existing Voice Flow (Phase 4)

| #    | Scenario                                                             | What It Guards                                          |
| ---- | -------------------------------------------------------------------- | ------------------------------------------------------- |
| R-14 | VoiceClient existing events (`transcription`, `responseStart`, etc.) | New `trace_event` handler doesn't break existing events |
| R-15 | Barge-in still works                                                 | Filler audio doesn't prevent barge-in                   |
| R-16 | VoiceWidget existing rendering                                       | Panel additions don't break voice-only widget           |
| R-17 | React `useVoice()` existing fields                                   | New fields (thought, statusMessage) are additive only   |
| R-18 | Pipeline voice path unaffected                                       | SDK voice changes don't touch pipeline paths            |

### REG-4: Existing Compiler/DSL (Phase 3A)

| #    | Scenario                                                 | What It Guards                                |
| ---- | -------------------------------------------------------- | --------------------------------------------- |
| R-19 | DSL without DESTINATIONS compiles                        | New parser section doesn't break existing DSL |
| R-20 | DSL without AWAIT_ATTACHMENT compiles                    | New step type doesn't break existing flows    |
| R-21 | Compiler full test suite (3,947+ tests) passes           | Parser/IR changes don't regress               |
| R-22 | `processingMode` defaults to 'full' for existing uploads | Mode control doesn't change default behavior  |

### REG-5: Existing Studio (Phase 2A)

| #    | Scenario                                           | What It Guards                                |
| ---- | -------------------------------------------------- | --------------------------------------------- |
| R-23 | Paperclip button upload still works                | DnD handlers don't break file input           |
| R-24 | Filename chip rendering unchanged for docs         | Thumbnail logic doesn't break non-image chips |
| R-25 | Session resume shows attachment filenames          | New metadata fields don't break replay        |
| R-26 | `chat-input-attachments.test.tsx` all tests pass   | No regression in upload flow                  |
| R-27 | `message-list-attachments.test.tsx` all tests pass | No regression in message rendering            |

---

## Part 4: Test Execution Commands

```bash
# ─── E2E Tests ───────────────────────────────────────────────────
pnpm build --filter=@abl/compiler --filter=@agent-platform/database \
  --filter=@agent-platform/multimodal-service --filter=@agent-platform/runtime

# Phase 0 E2E
pnpm vitest run apps/runtime/src/__tests__/attachment-pii.e2e.test.ts

# Phase 1 E2E
pnpm vitest run apps/runtime/src/__tests__/attachment-tools.e2e.test.ts

# Phase 2B + 3B E2E (WS)
pnpm vitest run apps/runtime/src/__tests__/thoughts-status-ws.e2e.test.ts

# Phase 3A E2E
pnpm vitest run apps/runtime/src/__tests__/attachment-advanced.e2e.test.ts

# Phase 3B E2E (config)
pnpm vitest run apps/runtime/src/__tests__/attachment-project-config-e2e.test.ts

# Phase 4 E2E (voice)
pnpm vitest run apps/runtime/src/__tests__/voice-thoughts-e2e.test.ts

# Phase 2A E2E (studio — requires real runtime process)
pnpm vitest run apps/studio/src/__tests__/e2e/attachment-ux-e2e.test.ts

# ─── Integration Tests ──────────────────────────────────────────
# Phase 0
pnpm vitest run apps/multimodal-service/src/__tests__/pii-pipeline-integration.test.ts
pnpm vitest run apps/runtime/src/attachments/__tests__/preprocessor-pii-integration.test.ts

# Phase 1
pnpm vitest run apps/runtime/src/tools/__tests__/attachment-tools-integration.test.ts

# Phase 2B
pnpm vitest run apps/runtime/src/__tests__/ws-status-forwarding-integration.test.ts

# Phase 3A
pnpm vitest run packages/compiler/src/__tests__/destinations-integration.test.ts

# Phase 3B
pnpm vitest run apps/runtime/src/__tests__/flow-step-thoughts-integration.test.ts
pnpm vitest run apps/runtime/src/__tests__/llm-call-correlation-integration.test.ts

# Phase 4
pnpm vitest run packages/web-sdk/src/__tests__/voice-client-integration.test.ts
pnpm vitest run packages/web-sdk/src/__tests__/chat-client-integration.test.ts
pnpm vitest run apps/runtime/src/__tests__/voice-filler-integration.test.ts

# ─── Full Regression ────────────────────────────────────────────
pnpm build && pnpm test
pnpm test --filter=@abl/compiler   # 3,947+ tests
pnpm test --filter=@agent-platform/runtime  # 8,861+ tests
pnpm test --filter=@agent-platform/multimodal-service
pnpm test --filter=@anthropic/agent-sdk
./tools/run-semgrep.sh
```

---

## Part 5: Priority Matrix

| Priority | Test                                   | Effort  | Risk If Missing                              |
| -------- | -------------------------------------- | ------- | -------------------------------------------- |
| **P1**   | E2E-0.1–0.6 (PII redaction)            | 1 day   | PII reaches LLM — compliance violation       |
| **P1**   | E2E-1.1–1.7 (attachment tools)         | 1 day   | Tools fail in production, broken round-trips |
| **P2**   | E2E-2B.1–2B.7 (thoughts/status WS)     | 1 day   | Silent UI — users see no agent activity      |
| **P2**   | I-0.1–I-0.8 (PII pipeline integration) | 0.5 day | PII detection edge cases missed              |
| **P2**   | E2E-3A.1–3A.6 (modes/routing)          | 1 day   | SSRF vulnerability, broken flow steps        |
| **P3**   | E2E-4.1–4.3 (voice thoughts)           | 0.5 day | Voice users see no agent reasoning           |
| **P3**   | I-3A.1–I-3A.6 (compiler integration)   | 0.5 day | DSL regression                               |
| **P3**   | E2E-3B.1–3B.4 (project config)         | 0.5 day | Config override doesn't work                 |
| **P3**   | I-3B.1–I-3B.7 (thoughts correlation)   | 0.5 day | Broken Observatory correlation               |
| **P4**   | E2E-2A.1–2A.4 (Studio UX)              | 0.5 day | UI bugs caught by manual testing             |
| **P4**   | I-4.1–I-4.11 (voice/SDK integration)   | 0.5 day | SDK event handling edge cases                |
| **P4**   | REG-1 through REG-27                   | 1 day   | Regression in existing features              |

**Total estimated: ~8 days for complete E2E + integration + regression coverage.**
