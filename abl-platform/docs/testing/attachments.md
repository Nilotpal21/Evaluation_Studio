# Feature Test Guide: Attachments (Multimodal File Processing)

**Feature**: File upload, processing pipeline (scan/extract/transcribe), PII detection/redaction, attachment tools, DESTINATIONS routing, channel adapters, Studio UX
**Owner**: Platform team
**Branch**: develop
**First tested**: 2026-03-22
**Last updated**: 2026-03-25
**Overall status**: STABLE — comprehensive unit, integration, API E2E, and browser E2E coverage; external processing services now covered by contract test doubles

---

## Current State (as of 2026-03-25)

The Attachments feature has comprehensive test coverage across the full stack: multimodal-service (upload, processing pipeline, storage, security, admin config, external service contracts), runtime (tools, config resolution, preprocessor, flow steps, AWAIT_ATTACHMENT executor, platform admin proxy, channel adapters, authz, config API CRUD/validation, concurrency), compiler (DSL sections, AWAIT_ATTACHMENT compilation + IR validation), admin (attachment config tab UI + proxy), Studio (upload UX, rendering, downloads, attachment settings UI with browser E2E), and SDK (client integration). All previously open gaps (GAP-002 through GAP-006, GAP-T1) are resolved.

**Total test count: ~390+ tests across 77+ test files**

- E2E (API): 44 tests across 6 files (PII pipeline, tools, advanced modes, thoughts/status, config CRUD/permissions/isolation, admin chain)
- E2E (Browser): 13 tests across 2 Playwright specs (attachment settings UI, admin attachment config tab)
- Integration: 88 tests across 12 files (PII pipeline, preprocessor, DSL compilation, thoughts, correlation, SDK clients, config validation, Studio proxy, platform admin proxy, admin routes, external service contracts)
- Unit (multimodal-service): ~80+ tests across 24 files (routes, jobs, storage, security, processing)
- Unit (runtime): ~91+ tests across 20 files (tools, config resolver, preprocessor, flow steps, AWAIT_ATTACHMENT executor, concurrency, authz, circuit breaker, adapters)
- Unit (compiler): ~31 tests across 3 files (ATTACHMENTS, DESTINATIONS, AWAIT_ATTACHMENT DSL)
- Unit (studio/admin): ~71+ tests across 12 files (upload UX, rendering, thumbnails, downloads, status, GDPR, settings tab, settings save, admin config tab)

### Quick Health Dashboard

| Area                                        | Status  | Last Verified | Notes                                                            |
| ------------------------------------------- | ------- | ------------- | ---------------------------------------------------------------- |
| File upload (multipart)                     | PASS    | 2026-03-22    | Route handlers + E2E upload_attachment tool                      |
| ClamAV virus scanning                       | PASS    | 2026-03-25    | Unit + contract test double (real TCP protocol)                  |
| MIME validation (magic bytes)               | PARTIAL | 2026-03-22    | Unit only; no integration with real files                        |
| Document text extraction (Tika)             | PASS    | 2026-03-25    | Unit + contract test double (real HTTP protocol)                 |
| Audio transcription (Whisper)               | PASS    | 2026-03-25    | Unit + contract test double (real HTTP protocol)                 |
| Video processing (FFmpeg)                   | PASS    | 2026-03-25    | Unit + contract test double (PNG header verification)            |
| PII detection and redaction                 | PASS    | 2026-03-22    | Full stack: unit + integration + E2E                             |
| PII policy (block/allow)                    | PASS    | 2026-03-25    | Unit + integration + E2E coverage (GAP-002 tests unskipped)      |
| 3-tier config resolution                    | PASS    | 2026-03-22    | Unit + E2E coverage                                              |
| upload_attachment tool                      | PASS    | 2026-03-22    | Unit (12 tests) + E2E                                            |
| get_attachment_url tool                     | PASS    | 2026-03-22    | Unit (8 tests) + E2E                                             |
| route_attachment + DESTINATIONS             | PASS    | 2026-03-22    | Unit + integration (DSL) + E2E with SSRF                         |
| SSRF protection                             | PASS    | 2026-03-22    | Unit + integration + E2E                                         |
| AWAIT_ATTACHMENT flow step                  | PASS    | 2026-03-25    | 27 executor tests + 21 compiler tests + E2E                      |
| Processing modes (full/scan-only/store-raw) | PASS    | 2026-03-22    | Unit (6 tests) + E2E                                             |
| Studio drag-drop/paste upload               | PARTIAL | 2026-03-22    | Component tests only; no browser E2E                             |
| Studio image thumbnails                     | PARTIAL | 2026-03-22    | Component tests only (6 tests)                                   |
| Studio download button                      | PARTIAL | 2026-03-22    | Component tests only (6 tests)                                   |
| SDK uploadAttachment()                      | PARTIAL | 2026-03-22    | Integration tests; no full E2E                                   |
| Channel adapter media                       | PARTIAL | 2026-03-22    | Unit tests per channel; no real channel E2E                      |
| Session-scoped access control               | PASS    | 2026-03-22    | Unit + E2E cross-session isolation                               |
| Tenant isolation                            | PASS    | 2026-03-22    | Unit + E2E                                                       |
| Upload rate limiting                        | PARTIAL | 2026-03-22    | Unit only; no E2E                                                |
| Retention/TTL cleanup                       | PARTIAL | 2026-03-22    | Unit only; no integration with real MongoDB                      |
| GDPR cascade delete                         | PARTIAL | 2026-03-22    | Studio unit test; no integration-level                           |
| Search AI indexing                          | PARTIAL | 2026-03-22    | Unit only (producer test)                                        |
| Circuit breaker                             | PARTIAL | 2026-03-22    | Unit only; no E2E                                                |
| Studio attachment settings UI               | PASS    | 2026-03-22    | 23 unit + 4 integration + 10 E2E + 14 validation + 6 browser E2E |
| Thoughts/status WebSocket                   | PASS    | 2026-03-22    | E2E (7 tests) + integration + unit                               |

---

## Test File Inventory

### E2E Tests (apps/runtime/src/\_\_tests\_\_/)

| File                              | Type | Scenarios                                                                                                                                  | Tests | Status |
| --------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------------ | ----- | ------ |
| `attachment-pii.e2e.test.ts`      | E2E  | PII redaction pipeline: upload PII doc (redacted), clean doc (verbatim), piiPolicy=block, piiPolicy=allow, image no-PII, mixed attachments | 6     | PASS   |
| `attachment-tools.e2e.test.ts`    | E2E  | upload_attachment, get_attachment_url, type:attachment valid/invalid, retry, tool schemas, cross-session isolation                         | 7     | PASS   |
| `attachment-advanced.e2e.test.ts` | E2E  | Processing modes (full/scan-only/store-raw), DESTINATIONS routing, AWAIT_ATTACHMENT flow step, route_attachment SSRF protection            | 6     | PASS   |
| `thoughts-status-ws.e2e.test.ts`  | E2E  | Reason fallback, status_update rendering, status_clear, thought correlation                                                                | 7     | PASS   |
| `attachment-config.e2e.test.ts`   | E2E  | Config API CRUD, permissions, isolation, validation, disable/enable, 3-tier resolution                                                     | 10    | PASS   |

### Chain E2E Tests (apps/multimodal-service/src/\_\_tests\_\_/)

| File                             | Type | Scenarios                                                                                                               | Tests | Status |
| -------------------------------- | ---- | ----------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| `attachment-admin-chain.test.ts` | E2E  | Full proxy chain (admin → runtime → multimodal): GET/PUT success, 400 validation, 401 auth, 404 cross-tenant, 400 types | 8     | PASS   |

### Browser E2E Tests (apps/studio/e2e/ + apps/admin/e2e/)

| File                              | Type        | Scenarios                                                                                                                     | Tests | Status |
| --------------------------------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------- | ----- | ------ |
| `attachment-settings-e2e.spec.ts` | Browser E2E | Page load + defaults, override/inherited badges, save + reload persistence, MIME chip editor, reset-to-default, success toast | 6     | PASS   |
| `attachment-config-tab.spec.ts`   | Browser E2E | Admin tab load, form fields, save, reset, error states, MIME list editing, retention days                                     | 7     | PASS   |

### Integration Tests

| File                                                                          | Type        | Scenarios                                                                                 | Tests | Status |
| ----------------------------------------------------------------------------- | ----------- | ----------------------------------------------------------------------------------------- | ----- | ------ |
| `apps/multimodal-service/src/__tests__/pii-pipeline-integration.test.ts`      | Integration | Real detectPII through process job                                                        | 4     | PASS   |
| `apps/runtime/src/attachments/__tests__/preprocessor-pii-integration.test.ts` | Integration | Real redactPII with edge cases                                                            | 4     | PASS   |
| `packages/compiler/src/__tests__/destinations-integration.test.ts`            | Integration | DSL to IR compilation with SSRF validation                                                | 6     | PASS   |
| `apps/runtime/src/__tests__/flow-step-thoughts-integration.test.ts`           | Integration | step_thought emission                                                                     | 4     | PASS   |
| `apps/runtime/src/__tests__/llm-call-correlation-integration.test.ts`         | Integration | llmCallId threading                                                                       | 3     | PASS   |
| `packages/web-sdk/src/__tests__/voice-client-integration.test.ts`             | Integration | VoiceClient trace_event handling                                                          | 4     | PASS   |
| `packages/web-sdk/src/__tests__/chat-client-integration.test.ts`              | Integration | ChatClient status events                                                                  | 3     | PASS   |
| `apps/runtime/src/__tests__/attachment-config-validation.test.ts`             | Integration | Zod validation, upsert, resolver fallthrough                                              | 14    | PASS   |
| `apps/studio/src/__tests__/attachment-config-proxy.test.ts`                   | Integration | Studio proxy route forwarding + auth gates                                                | 4     | PASS   |
| `apps/runtime/src/__tests__/platform-admin-attachment-config.test.ts`         | Integration | Platform admin proxy: auth, Zod validation, proxy forwarding, audit log                   | 13    | PASS   |
| `apps/multimodal-service/src/__tests__/admin-routes-integration.test.ts`      | Integration | Admin routes: auth (401/404), GET/PUT, validation (6 types), error propagation            | 17    | PASS   |
| `apps/multimodal-service/src/__tests__/external-services-contract.test.ts`    | Integration | ClamAV TCP stub, Tika HTTP stub, Whisper HTTP stub, FFmpeg test double: 12 contract tests | 12    | PASS   |

### Unit Tests — Multimodal Service

| File                                                    | Focus                                                  | Status |
| ------------------------------------------------------- | ------------------------------------------------------ | ------ |
| `__tests__/attachment-routes.test.ts`                   | Route handlers (upload, download, metadata)            | PASS   |
| `__tests__/attachment-rate-limit.test.ts`               | Rate limiting configuration and enforcement            | PASS   |
| `__tests__/attachment-retry.test.ts`                    | Retry logic for transient failures                     | PASS   |
| `__tests__/upload-modes.test.ts`                        | Processing modes: full, scan-only, store-raw (6 tests) | PASS   |
| `__tests__/multimodal-service.test.ts`                  | AttachmentService lifecycle                            | PASS   |
| `services/__tests__/attachment-search-producer.test.ts` | Search AI indexing producer                            | PASS   |
| `jobs/__tests__/scan-job.test.ts`                       | ClamAV scan worker                                     | PASS   |
| `jobs/__tests__/validate-job.test.ts`                   | MIME validation worker                                 | PASS   |
| `jobs/__tests__/process-job.test.ts`                    | Document/audio/video processing orchestration          | PASS   |
| `jobs/__tests__/process-job-pii.test.ts`                | PII detection in processing pipeline (558 lines)       | PASS   |
| `jobs/__tests__/index-job.test.ts`                      | Search indexing worker                                 | PASS   |
| `jobs/__tests__/cleanup-job.test.ts`                    | Cleanup worker                                         | PASS   |
| `jobs/__tests__/expiry-sweep-job.test.ts`               | TTL sweep                                              | PASS   |
| `storage/__tests__/storage-factory.test.ts`             | Storage provider creation                              | PASS   |
| `storage/__tests__/s3-storage.test.ts`                  | S3 provider                                            | PASS   |
| `storage/__tests__/local-storage.test.ts`               | Local storage provider                                 | PASS   |
| `security/__tests__/mime-validator.test.ts`             | MIME detection via magic bytes                         | PASS   |
| `security/__tests__/clamav-scanner.test.ts`             | ClamAV scanner                                         | PASS   |
| `security/__tests__/ssrf-validator.test.ts`             | SSRF blocking                                          | PASS   |
| `security/__tests__/upload-rate-limiter.test.ts`        | Rate limiter                                           | PASS   |
| `processing/__tests__/image-processor.test.ts`          | Image resize and thumbnail generation                  | PASS   |
| `processing/__tests__/document-parser-tika.test.ts`     | Tika text extraction                                   | PASS   |
| `processing/__tests__/transcriber-whisper.test.ts`      | Whisper audio transcription                            | PASS   |
| `processing/__tests__/video-processor-ffmpeg.test.ts`   | FFmpeg video processing                                | PASS   |

### Unit Tests — Runtime

| File                                                       | Focus                                                                    | Status |
| ---------------------------------------------------------- | ------------------------------------------------------------------------ | ------ |
| `attachments/__tests__/attachment-config-resolver.test.ts` | 3-tier config resolution (7 tests)                                       | PASS   |
| `attachments/__tests__/multimodal-service-client.test.ts`  | HTTP client to multimodal-service                                        | PASS   |
| `attachments/__tests__/message-preprocessor.test.ts`       | ContentBlock generation from attachments                                 | PASS   |
| `attachments/__tests__/message-preprocessor-pii.test.ts`   | PII policy enforcement (348 lines)                                       | PASS   |
| `tools/__tests__/attachment-tool-executor.test.ts`         | Base tool executor                                                       | PASS   |
| `tools/__tests__/attachment-tool-executor-upload.test.ts`  | upload_attachment tool (12 tests)                                        | PASS   |
| `tools/__tests__/attachment-tool-executor-url.test.ts`     | get_attachment_url tool (8 tests)                                        | PASS   |
| `tools/__tests__/attachment-tool-executor-route.test.ts`   | route_attachment tool (6 tests)                                          | PASS   |
| `tools/__tests__/tool-input-validator-attachment.test.ts`  | Parameter validation (4 tests)                                           | PASS   |
| `__tests__/flow-step-await-attachment.test.ts`             | AWAIT_ATTACHMENT executor (27 tests: IR shape, behavior, MIME, boundary) | PASS   |
| `__tests__/attachment-concurrency.test.ts`                 | Concurrent tool execution: parallel get/list, error isolation (6 tests)  | PASS   |
| `__tests__/flow-step-thought-emission.test.ts`             | Thought emission from flow steps                                         | PASS   |
| `__tests__/thought-prompt-correlation.test.ts`             | Thought-prompt correlation (386 lines)                                   | PASS   |
| `__tests__/attachment-ownership-authz.test.ts`             | Authorization and session isolation                                      | PASS   |
| `__tests__/inbound-worker-attachments.test.ts`             | Inbound worker attachment handling                                       | PASS   |
| `__tests__/multimodal-circuit-breaker.test.ts`             | Circuit breaker for multimodal-service                                   | PASS   |

### Unit Tests — Compiler

| File                                                                   | Focus                                                       | Status |
| ---------------------------------------------------------------------- | ----------------------------------------------------------- | ------ |
| `packages/compiler/src/__tests__/attachments.test.ts`                  | ATTACHMENTS DSL section to IR compilation                   | PASS   |
| `packages/compiler/src/__tests__/destinations.test.ts`                 | DESTINATIONS DSL to IR + SSRF validation (4 tests)          | PASS   |
| `packages/compiler/src/__tests__/await-attachment-compilation.test.ts` | AWAIT_ATTACHMENT DSL compilation + IR validation (21 tests) | PASS   |

### Unit Tests — Admin

| File                                                     | Focus                                                    | Tests | Status |
| -------------------------------------------------------- | -------------------------------------------------------- | ----- | ------ |
| `apps/admin/src/__tests__/attachment-config-tab.test.ts` | Admin attachment config tab: rendering, form, save/reset | 14    | PASS   |

### Unit Tests — Studio

| File                                                 | Focus                                      | Tests | Status |
| ---------------------------------------------------- | ------------------------------------------ | ----- | ------ |
| `__tests__/chat-input-attachments.test.tsx`          | Upload button, file validation             | —     | PASS   |
| `__tests__/chat-input-dnd.test.tsx`                  | Drag-and-drop (9 tests)                    | 9     | PASS   |
| `__tests__/chat-input-media.test.tsx`                | Audio/video media types (3 tests)          | 3     | PASS   |
| `__tests__/message-list-attachments.test.tsx`        | Attachment rendering                       | —     | PASS   |
| `__tests__/message-list-thumbnails.test.tsx`         | Image thumbnails (6 tests)                 | 6     | PASS   |
| `__tests__/message-list-download.test.tsx`           | Download button (6 tests)                  | 6     | PASS   |
| `__tests__/status-update-rendering.test.tsx`         | Status indicator (9 tests)                 | 9     | PASS   |
| `__tests__/step-thought-and-project-config.test.tsx` | Thought cards + project config (191 lines) | —     | PASS   |
| `__tests__/retention-attachment-cascade.test.ts`     | GDPR cascade delete                        | —     | PASS   |
| `__tests__/attachment-settings-tab.test.tsx`         | Settings tab rendering, field interaction  | 14    | PASS   |
| `__tests__/attachment-settings-save.test.tsx`        | Save, reset, MIME validation, toasts       | 9     | PASS   |

### Channel Adapter Tests (Runtime)

| File                                                    | Focus                     | Status |
| ------------------------------------------------------- | ------------------------- | ------ |
| `__tests__/adapters/email-attachment-processor.test.ts` | Email attachment handling | PASS   |
| `__tests__/adapters/slack-file-attachments.test.ts`     | Slack file uploads        | PASS   |
| `__tests__/adapters/msteams-file-attachments.test.ts`   | MS Teams file handling    | PASS   |
| `__tests__/adapters/whatsapp-file-attachments.test.ts`  | WhatsApp file attachments | PASS   |
| `__tests__/adapters/whatsapp-media-processor.test.ts`   | WhatsApp media processor  | PASS   |
| `__tests__/adapters/whatsapp-media-downloader.test.ts`  | WhatsApp media downloader | PASS   |
| `__tests__/adapters/msteams-file-processor.test.ts`     | Teams file processor      | PASS   |
| `__tests__/adapters/twilio-sms-media-processor.test.ts` | Twilio SMS/MMS media      | PASS   |
| `__tests__/adapters/messenger-media-processor.test.ts`  | Messenger media processor | PASS   |
| `__tests__/adapters/instagram-adapter.test.ts`          | Instagram adapter         | PASS   |
| `__tests__/adapters/instagram-media-processor.test.ts`  | Instagram media processor | PASS   |

---

## Test Coverage Map

### File Upload and Processing Pipeline

- [x] File upload via multipart endpoint (attachment-routes.test.ts, attachment-tools.e2e.test.ts)
- [x] ClamAV virus scanning worker (scan-job.test.ts) — unit only
- [x] MIME validation via magic bytes (mime-validator.test.ts, validate-job.test.ts) — unit only
- [x] Document text extraction via Tika (document-parser-tika.test.ts) — unit only
- [x] Audio transcription via Whisper (transcriber-whisper.test.ts) — unit only
- [x] Video processing via FFmpeg (video-processor-ffmpeg.test.ts) — unit only
- [x] Image resize and thumbnail generation (image-processor.test.ts) — unit only
- [x] Processing modes: full, scan-only, store-raw (upload-modes.test.ts, attachment-advanced.e2e.test.ts)
- [x] Retry logic for transient pipeline failures (attachment-retry.test.ts)
- [x] Job orchestration: scan, validate, process, index, cleanup (individual job tests)

### PII Detection and Redaction

- [x] PII detection in document content (process-job-pii.test.ts, 558 lines)
- [x] PII redaction before LLM processing (message-preprocessor-pii.test.ts, 348 lines)
- [x] Real detectPII through process job pipeline (pii-pipeline-integration.test.ts)
- [x] Real redactPII with edge cases (preprocessor-pii-integration.test.ts)
- [x] E2E: upload PII doc results in redacted content (attachment-pii.e2e.test.ts)
- [x] E2E: upload clean doc passes through verbatim (attachment-pii.e2e.test.ts)
- [x] E2E: piiPolicy=block rejects PII-containing uploads (attachment-pii.e2e.test.ts)
- [x] E2E: piiPolicy=allow passes PII through unredacted (attachment-pii.e2e.test.ts)
- [x] E2E: image with no PII passes through (attachment-pii.e2e.test.ts)
- [x] E2E: mixed attachments with partial PII (attachment-pii.e2e.test.ts)

### Attachment Tools

- [x] upload_attachment tool execution and response (attachment-tool-executor-upload.test.ts, 12 tests)
- [x] get_attachment_url tool execution (attachment-tool-executor-url.test.ts, 8 tests)
- [x] route_attachment tool execution and SSRF validation (attachment-tool-executor-route.test.ts, 6 tests)
- [x] Tool parameter validation for attachment type inputs (tool-input-validator-attachment.test.ts, 4 tests)
- [x] Tool schemas exposed correctly (attachment-tools.e2e.test.ts)
- [x] E2E: upload_attachment creates attachment and returns metadata (attachment-tools.e2e.test.ts)
- [x] E2E: get_attachment_url returns signed URL (attachment-tools.e2e.test.ts)
- [x] E2E: type:attachment with valid/invalid file handled (attachment-tools.e2e.test.ts)
- [x] E2E: retry logic on transient failure (attachment-tools.e2e.test.ts)
- [x] E2E: cross-session isolation — cannot access another session's attachments (attachment-tools.e2e.test.ts)

### DESTINATIONS and Routing

- [x] DESTINATIONS DSL section compiles to IR (destinations.test.ts, 4 tests)
- [x] DESTINATIONS integration with SSRF validation (destinations-integration.test.ts, 6 tests)
- [x] route_attachment SSRF protection blocks internal IPs (ssrf-validator.test.ts, attachment-advanced.e2e.test.ts)
- [x] E2E: DESTINATIONS routing delivers to configured endpoints (attachment-advanced.e2e.test.ts)

### Flow Steps

- [x] AWAIT_ATTACHMENT flow step pauses execution until attachment received (flow-step-await-attachment.test.ts, 219 lines)
- [x] E2E: AWAIT_ATTACHMENT flow step end-to-end (attachment-advanced.e2e.test.ts)
- [x] Thought emission from flow steps (flow-step-thought-emission.test.ts)
- [x] Thought-prompt correlation (thought-prompt-correlation.test.ts, 386 lines)

### Configuration

- [x] 3-tier config resolution: platform, project, agent level (attachment-config-resolver.test.ts, 7 tests)
- [x] E2E: config resolution in processing mode selection (attachment-advanced.e2e.test.ts)

### Security and Isolation

- [x] Session-scoped attachment access control (attachment-ownership-authz.test.ts)
- [x] E2E: cross-session attachment isolation (attachment-tools.e2e.test.ts)
- [x] Tenant isolation for attachments (attachment-ownership-authz.test.ts)
- [x] Upload rate limiting enforcement (upload-rate-limiter.test.ts, attachment-rate-limit.test.ts)
- [x] SSRF blocking for route_attachment destinations (ssrf-validator.test.ts, attachment-advanced.e2e.test.ts)
- [x] Circuit breaker for multimodal-service connectivity (multimodal-circuit-breaker.test.ts) — unit only

### Storage

- [x] Storage provider factory (storage-factory.test.ts)
- [x] S3 storage operations (s3-storage.test.ts)
- [x] Local storage operations (local-storage.test.ts)

### Retention and Compliance

- [x] TTL expiry sweep job (expiry-sweep-job.test.ts) — unit only
- [x] Cleanup job execution (cleanup-job.test.ts) — unit only
- [x] GDPR cascade delete (retention-attachment-cascade.test.ts) — unit only
- [ ] Integration-level retention with real MongoDB

### Studio UX

- [x] Upload button and file validation (chat-input-attachments.test.tsx)
- [x] Drag-and-drop file upload (chat-input-dnd.test.tsx, 9 tests)
- [x] Audio/video media type handling (chat-input-media.test.tsx, 3 tests)
- [x] Attachment rendering in message list (message-list-attachments.test.tsx)
- [x] Image thumbnail rendering (message-list-thumbnails.test.tsx, 6 tests)
- [x] Download button behavior (message-list-download.test.tsx, 6 tests)
- [x] Status update rendering (status-update-rendering.test.tsx, 9 tests)
- [x] Thought cards and project config (step-thought-and-project-config.test.tsx, 191 lines)
- [x] Attachment settings UI — tab rendering, field interaction (attachment-settings-tab.test.tsx, 14 tests)
- [x] Attachment settings save, reset, MIME validation (attachment-settings-save.test.tsx, 9 tests)
- [x] Browser E2E via Playwright (attachment-settings-e2e.spec.ts, 6 tests: load, badges, save, MIME, reset, toast)

### SDK Integration

- [x] ChatClient status events (chat-client-integration.test.ts, 3 tests)
- [x] VoiceClient trace_event handling (voice-client-integration.test.ts, 4 tests)
- [ ] Full SDK uploadAttachment() E2E

### Channel Adapters

- [x] Email attachment processing (email-attachment-processor.test.ts) — unit only
- [x] Slack file upload handling (slack-file-attachments.test.ts) — unit only
- [x] MS Teams file handling (msteams-file-attachments.test.ts, msteams-file-processor.test.ts) — unit only
- [x] WhatsApp media (whatsapp-file-attachments.test.ts, whatsapp-media-processor.test.ts, whatsapp-media-downloader.test.ts) — unit only
- [x] Twilio SMS/MMS media (twilio-sms-media-processor.test.ts) — unit only
- [x] Messenger media (messenger-media-processor.test.ts) — unit only
- [x] Instagram media (instagram-adapter.test.ts, instagram-media-processor.test.ts) — unit only
- [ ] Real channel E2E for any adapter

### Compiler

- [x] ATTACHMENTS DSL section to IR compilation (attachments.test.ts)
- [x] DESTINATIONS DSL section to IR compilation (destinations.test.ts, 4 tests)
- [x] DESTINATIONS SSRF validation at compile time (destinations-integration.test.ts, 6 tests)

### Thoughts and Status (WebSocket)

- [x] E2E: reason fallback rendering (thoughts-status-ws.e2e.test.ts)
- [x] E2E: status_update rendering (thoughts-status-ws.e2e.test.ts)
- [x] E2E: status_clear behavior (thoughts-status-ws.e2e.test.ts)
- [x] E2E: thought correlation with prompts (thoughts-status-ws.e2e.test.ts)
- [x] Integration: step_thought emission (flow-step-thoughts-integration.test.ts, 4 tests)
- [x] Integration: llmCallId threading (llm-call-correlation-integration.test.ts, 3 tests)

---

## Functional Requirements Coverage Matrix

> FR numbering traces to [feature spec §4](../features/attachments.md#4-functional-requirements). Sub-items (a/b/c) decompose broad FRs for granular tracking. Additional test-only items (T-\*) cover areas not in the FR list.

| FR    | Description                                      | Unit | Integration | E2E | Status                                                |
| ----- | ------------------------------------------------ | ---- | ----------- | --- | ----------------------------------------------------- |
| FR-1  | File upload, MIME/size validation, storage       | Yes  | Yes         | Yes | PASS                                                  |
| FR-2  | ClamAV virus scanning                            | Yes  | No          | No  | PARTIAL (unit only, needs real ClamAV)                |
| FR-3  | MIME validation (magic bytes)                    | Yes  | No          | No  | PARTIAL (unit only)                                   |
| FR-4a | Document text extraction (Tika)                  | Yes  | No          | No  | PARTIAL (unit only, needs real Tika)                  |
| FR-4b | Audio transcription (Whisper)                    | Yes  | No          | No  | PARTIAL (unit only)                                   |
| FR-4c | Video processing (FFmpeg)                        | Yes  | No          | No  | PARTIAL (unit only)                                   |
| FR-4d | Image resize/thumbnail                           | Yes  | No          | No  | PARTIAL (unit only)                                   |
| FR-4e | Processing modes (full/scan-only/store-raw)      | Yes  | No          | Yes | PASS                                                  |
| FR-5  | PII detection in processed content               | Yes  | Yes         | Yes | PASS                                                  |
| FR-6  | PII policy enforcement (redact/block/allow)      | Yes  | Yes         | Yes | PASS                                                  |
| FR-7  | 3-tier config resolution                         | Yes  | Yes         | Yes | PASS                                                  |
| FR-8a | upload_attachment tool                           | Yes  | No          | Yes | PASS                                                  |
| FR-8b | get_attachment / list_attachments tools          | Yes  | No          | Yes | PASS                                                  |
| FR-8c | get_attachment_url tool                          | Yes  | No          | Yes | PASS                                                  |
| FR-8d | route_attachment tool                            | Yes  | Yes         | Yes | PASS                                                  |
| FR-9  | route_attachment SSRF protection                 | Yes  | Yes         | Yes | PASS                                                  |
| FR-10 | DSL ATTACHMENTS/DESTINATIONS sections            | Yes  | Yes         | No  | PASS                                                  |
| FR-11 | TTL-based attachment expiry                      | Yes  | No          | No  | PARTIAL (unit only)                                   |
| FR-12 | Session-scoped access control                    | Yes  | No          | Yes | PASS                                                  |
| FR-13 | Tenant isolation on all attachment queries       | Yes  | No          | Yes | PASS                                                  |
| FR-14 | Per-tenant upload rate limiting                  | Yes  | No          | No  | PARTIAL (unit only)                                   |
| FR-15 | Search AI content indexing                       | Yes  | No          | No  | PARTIAL (unit only)                                   |
| T-1   | Studio drag-drop/paste upload                    | Yes  | No          | No  | PARTIAL (component tests only)                        |
| T-2   | Studio image thumbnails / download               | Yes  | No          | No  | PARTIAL (component tests only)                        |
| T-3   | Studio attachment settings UI                    | Yes  | Yes         | Yes | PASS (23 unit + 4 integ + 10 API E2E + 6 browser E2E) |
| T-4   | SDK uploadAttachment() / send with attachmentIds | Yes  | Yes         | No  | PARTIAL                                               |
| T-5   | Channel adapter media handling                   | Yes  | No          | No  | PARTIAL (unit only, no real channel E2E)              |
| T-6   | Circuit breaker for multimodal service           | Yes  | No          | No  | PARTIAL (unit only)                                   |
| T-7   | GDPR cascade delete                              | Yes  | No          | No  | PARTIAL (unit only)                                   |
| T-8   | AWAIT_ATTACHMENT flow step                       | Yes  | Yes         | Yes | PASS (27 executor + 21 compiler tests)                |

---

## Detailed E2E Scenarios

### PII Redaction Pipeline (attachment-pii.e2e.test.ts)

**Goal**: Prove the PII detection and redaction pipeline works end-to-end through the upload, processing, and content delivery path.

**Setup**: Runtime with multimodal-service, PII detector configured at project level.

**Assertions**:

1. Upload a document containing PII (SSN, email) — extracted text has PII tokens redacted
2. Upload a clean document — content passes through verbatim without modification
3. piiPolicy=block configuration — upload with PII content is rejected before reaching LLM
4. piiPolicy=allow configuration — PII content passes through unredacted
5. Image with no PII — passes through normally (no false positives)
6. Mixed attachments (some with PII, some without) — only PII-bearing content is redacted

### Attachment Tools (attachment-tools.e2e.test.ts)

**Goal**: Prove attachment tools (upload, URL generation) work correctly through the agent execution path.

**Setup**: Runtime with attachment tools enabled on agent, multimodal-service running.

**Assertions**:

1. upload_attachment tool creates an attachment record and returns metadata (id, filename, size)
2. get_attachment_url tool returns a valid signed URL for a previously uploaded attachment
3. type:attachment input with valid file is accepted and processed
4. type:attachment input with invalid/corrupt file is rejected with actionable error
5. Transient failure triggers retry and eventually succeeds
6. Tool schemas are correctly exposed in agent capabilities
7. Cross-session isolation: session B cannot access attachments from session A

### Advanced Processing (attachment-advanced.e2e.test.ts)

**Goal**: Prove processing modes, DESTINATIONS routing, AWAIT_ATTACHMENT flow step, and SSRF protection.

**Setup**: Runtime with various agent configurations for each processing mode and routing scenario.

**Assertions**:

1. Processing mode `full` — file goes through scan, validate, extract/transcribe, and index
2. Processing mode `scan-only` — file is scanned and validated but not processed further
3. Processing mode `store-raw` — file is stored directly without any processing pipeline
4. DESTINATIONS routing delivers processed content to configured external endpoint
5. AWAIT_ATTACHMENT flow step pauses execution until an attachment is received
6. route_attachment to internal/private IP is blocked by SSRF validator

### Thoughts and Status WebSocket (thoughts-status-ws.e2e.test.ts)

**Goal**: Prove real-time thought and status updates flow correctly over WebSocket during attachment processing.

**Assertions**:

1. Reason events fall back to thought rendering when no explicit status
2. status_update events render as processing indicators in the client
3. status_clear events remove the processing indicator
4. Thought events correlate to the correct prompt/LLM call
5. Multiple concurrent thoughts do not cross-contaminate
6. Status events maintain correct ordering
7. Thought cards display step provenance

---

## Known Gaps

### ~~GAP-T1: Processing Pipeline E2E Requires External Services~~ — MITIGATED

**Severity**: ~~Medium~~ Mitigated
**Impact**: FR-2, FR-3, FR-4, FR-5, FR-6

~~ClamAV, Tika, Whisper, and FFmpeg are external binaries/services not available in CI. Unit tests mock these dependencies. The actual integration with real processing services is not tested end-to-end.~~

**Mitigation**: 4 contract test doubles exercise real protocols: ClamAV TCP stub (`clamav-stub.ts`), Tika HTTP stub (`tika-stub.ts`), Whisper HTTP stub (`whisper-stub.ts`), FFmpeg test double (`ffmpeg-test-double.ts`). 12 contract tests in `external-services-contract.test.ts` verify protocol compatibility, response formats, timeout handling, and error paths. Real service integration should still be tested in staging with Docker Compose for full confidence.

### GAP-T2: Channel Adapter Tests Are Unit-Only

**Severity**: Medium
**Impact**: FR-21

All 11 channel adapter test files (Email, Slack, Teams, WhatsApp, Twilio, Messenger, Instagram) use mocked HTTP responses. No test sends a real attachment through a real channel API.

**Mitigation**: Channel adapters follow a common interface pattern. Unit tests validate the adapter logic. Real channel E2E requires channel-specific sandbox accounts and webhook infrastructure.

### GAP-T3: Studio UI Tests Are Component-Level Only

**Severity**: Low
**Impact**: FR-17, FR-18, FR-19

Studio attachment tests (drag-drop, thumbnails, downloads) are React component tests using testing-library. No browser-level E2E tests (Playwright/Cypress) exist.

**Mitigation**: Component tests cover interaction logic and rendering. Browser E2E would primarily catch CSS/layout issues and real network request behavior.

### ~~GAP-T4: Studio Attachment Settings UI Not Built~~ — RESOLVED

**Severity**: ~~Low~~ Resolved
**Impact**: FR-28

~~The Studio UI for configuring attachment settings per agent/project does not exist yet. Zero test coverage.~~

**Resolution**: The `AttachmentSettingsTab` component was implemented with full test coverage: 14 unit tests (tab rendering/interaction), 9 unit tests (save/reset/validation), 4 integration tests (proxy route), 10 API E2E tests (config CRUD/permissions/isolation), 14 validation integration tests, and 6 Playwright browser E2E tests.

### GAP-T5: Upload Rate Limiting Has No E2E Coverage

**Severity**: Medium
**Impact**: FR-24

Rate limiting is tested at the unit level (upload-rate-limiter.test.ts, attachment-rate-limit.test.ts) but not through a real HTTP request sequence.

**Mitigation**: Unit tests validate the rate limiter algorithm and configuration. E2E would confirm middleware wiring and actual HTTP 429 responses.

### GAP-T6: Retention/GDPR Cascade Has No Integration-Level Test

**Severity**: Medium
**Impact**: FR-25, FR-26

TTL sweep and GDPR cascade delete are tested at unit level only. No test runs against a real MongoDB to verify cascading deletes across attachment records, storage blobs, and search indices.

**Mitigation**: Unit tests validate the cascade logic. Integration tests with MongoMemoryServer or a real MongoDB instance would confirm query correctness and index cleanup.

---

## Regression Matrix

| ID     | Regression Risk                                        | Required Assertion                                                   | Test Location                                                     |
| ------ | ------------------------------------------------------ | -------------------------------------------------------------------- | ----------------------------------------------------------------- |
| AT-R01 | File upload breaks for non-attachment agents           | Agents without ATTACHMENTS config still process messages normally    | E2E: non-attachment agent tests                                   |
| AT-R02 | PII redaction changes break clean document passthrough | Clean documents pass verbatim when PII detector finds nothing        | attachment-pii.e2e.test.ts                                        |
| AT-R03 | Tool schema changes break existing tool consumers      | Tool schemas match expected format (name, parameters, description)   | attachment-tools.e2e.test.ts                                      |
| AT-R04 | DESTINATIONS compile changes break routing             | DSL with DESTINATIONS compiles correctly and routes at runtime       | destinations-integration.test.ts, attachment-advanced.e2e.test.ts |
| AT-R05 | SSRF validator update blocks legitimate external URLs  | SSRF validator blocks private IPs but allows public endpoints        | ssrf-validator.test.ts, attachment-advanced.e2e.test.ts           |
| AT-R06 | Config resolution precedence changes                   | Agent-level overrides project-level overrides platform-level         | attachment-config-resolver.test.ts                                |
| AT-R07 | Session isolation regression                           | Cross-session attachment access still returns 404/403                | attachment-tools.e2e.test.ts, attachment-ownership-authz.test.ts  |
| AT-R08 | Channel adapter format changes                         | Each adapter correctly maps channel-specific format to internal      | Per-adapter unit tests                                            |
| AT-R09 | Circuit breaker threshold change                       | Circuit breaker opens after configured failure count                 | multimodal-circuit-breaker.test.ts                                |
| AT-R10 | WebSocket thought/status event format change           | Clients still receive correctly structured thought and status events | thoughts-status-ws.e2e.test.ts                                    |

---

## Running Tests

```bash
# E2E tests (runtime)
pnpm test --filter=runtime -- attachment-pii-e2e
pnpm test --filter=runtime -- attachment-tools-e2e
pnpm test --filter=runtime -- attachment-advanced-e2e
pnpm test --filter=runtime -- thoughts-status-ws-e2e
pnpm test --filter=runtime -- attachment-config-e2e

# Integration tests
pnpm test --filter=multimodal-service -- pii-pipeline-integration
pnpm test --filter=runtime -- preprocessor-pii-integration
pnpm test --filter=runtime -- flow-step-thoughts-integration
pnpm test --filter=runtime -- llm-call-correlation-integration
pnpm test --filter=compiler -- destinations-integration
pnpm test --filter=web-sdk -- voice-client-integration
pnpm test --filter=web-sdk -- chat-client-integration
pnpm test --filter=runtime -- attachment-config-validation

# Multimodal-service unit tests (all)
pnpm test --filter=multimodal-service

# Runtime attachment unit tests
pnpm test --filter=runtime -- attachment-config-resolver
pnpm test --filter=runtime -- message-preprocessor
pnpm test --filter=runtime -- attachment-tool-executor
pnpm test --filter=runtime -- flow-step-await-attachment
pnpm test --filter=runtime -- attachment-ownership-authz
pnpm test --filter=runtime -- multimodal-circuit-breaker

# Compiler tests
pnpm test --filter=compiler -- attachments
pnpm test --filter=compiler -- destinations

# Studio tests
pnpm test --filter=studio -- chat-input-attachments
pnpm test --filter=studio -- chat-input-dnd
pnpm test --filter=studio -- message-list-attachments
pnpm test --filter=studio -- message-list-thumbnails
pnpm test --filter=studio -- message-list-download
pnpm test --filter=studio -- status-update-rendering
pnpm test --filter=studio -- retention-attachment-cascade
pnpm test --filter=studio -- attachment-settings-tab
pnpm test --filter=studio -- attachment-settings-save
pnpm test --filter=studio -- attachment-config-proxy

# Browser E2E tests (Playwright — requires Studio + Runtime running)
npx playwright test --project=chromium apps/studio/e2e/attachment-settings-e2e.spec.ts

# Channel adapter tests
pnpm test --filter=runtime -- email-attachment-processor
pnpm test --filter=runtime -- slack-file-attachments
pnpm test --filter=runtime -- msteams-file-attachments
pnpm test --filter=runtime -- whatsapp-file-attachments
pnpm test --filter=runtime -- twilio-sms-media-processor
pnpm test --filter=runtime -- messenger-media-processor
pnpm test --filter=runtime -- instagram-adapter
```

---

## References

- Feature doc: (pending — `docs/features/attachments.md`)
- Multimodal service: `apps/multimodal-service/`
- Runtime attachments: `apps/runtime/src/attachments/`
- Runtime attachment tools: `apps/runtime/src/tools/`
- Compiler ATTACHMENTS section: `packages/compiler/src/`
- Studio components: `apps/studio/src/components/`
- SDK clients: `packages/sdk/src/`
