# Feature Test Guide: PII Detection & Redaction

**Feature**: PII Detection & Redaction -- regex-based PII detection, tokenization vault, consumer-aware rendering
**Owner**: Platform Team
**Branch**: develop
**Related Feature Doc**: [docs/features/pii-detection.md](../features/pii-detection.md)
**First tested**: 2026-03-08
**Last updated**: 2026-04-27
**Overall status**: PASS -- comprehensive unit and integration coverage for PII detection/redaction plus ABLP-535 live/history parity, exact reveal authorization, durable vault reveal, and Studio reveal UX. Remaining E2E gap is still the pattern CRUD API.

---

## Coverage Matrix

| FR    | Description                                    | Unit | Integration | E2E | Manual | Status    |
| ----- | ---------------------------------------------- | ---- | ----------- | --- | ------ | --------- |
| FR-1  | Detect 5 built-in PII types with validation    | PASS | PASS        | N/A | N/A    | Covered   |
| FR-2  | Custom patterns scoped to tenant + project     | PASS | PASS        | GAP | N/A    | Partial   |
| FR-3  | Reversible tokenization vault                  | PASS | PASS        | N/A | N/A    | Covered   |
| FR-4  | Per-consumer rendering (5 modes)               | PASS | PASS        | N/A | N/A    | Covered   |
| FR-5  | 3 redaction modes (predefined, masked, random) | PASS | N/A         | N/A | N/A    | Unit only |
| FR-6  | Output PII filtering (legacy + vault-aware)    | PASS | PASS        | N/A | N/A    | Covered   |
| FR-7  | Streaming chunk-boundary detection             | PASS | N/A         | N/A | N/A    | Unit only |
| FR-8  | Encrypted vault persistence                    | PASS | PASS        | N/A | N/A    | Covered   |
| FR-9  | PII audit logging with TTL retention           | PASS | N/A         | GAP | N/A    | Unit only |
| FR-10 | Custom regex validation + backtracking         | PASS | N/A         | N/A | N/A    | Unit only |
| FR-11 | Pattern test endpoint with consumer previews   | PASS | N/A         | GAP | N/A    | Unit only |
| FR-12 | Context-aware gather field exemptions          | PASS | N/A         | N/A | N/A    | Unit only |
| FR-13 | Builtin-pii guardrail provider                 | PASS | PASS        | N/A | N/A    | Covered   |
| FR-14 | Trace scrubbing of tool call data              | PASS | N/A         | N/A | N/A    | Unit only |
| FR-15 | Vault + registry capacity limits + eviction    | PASS | N/A         | N/A | N/A    | Unit only |
| FR-16 | Normal history/read APIs do not reveal raw PII | PASS | PASS        | N/A | N/A    | Covered   |
| FR-17 | Exact-permission audited admin reveal          | PASS | PASS        | N/A | N/A    | Covered   |
| FR-18 | Durable encrypted token reveal vault           | PASS | PASS        | N/A | N/A    | Covered   |
| FR-19 | Studio reveal UX is gated and ephemeral        | PASS | PASS        | N/A | N/A    | Covered   |

---

## Test Inventory

### Unit Tests

| Test File                                                                      | Suites | Status | Key Scenarios                                                                                                                                     |
| ------------------------------------------------------------------------------ | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/__tests__/security/pii-detector.test.ts`                | ~8     | PASS   | All 5 PII types, Luhn validation, IP range validation, phone digit count, overlap removal, selective redaction with exemptions                    |
| `packages/compiler/src/__tests__/security/pii-vault.test.ts`                   | ~10    | PASS   | Tokenize, detokenize, consumer rendering (LLM/user/logs/tools), masked rendering per type, random replacement, eviction, serialize/deserialize    |
| `packages/compiler/src/__tests__/security/pii-recognizer-registry.test.ts`     | ~6     | PASS   | Register, unregister, permanent protection, detectAll, max 50 eviction, error isolation per recognizer, built-in registrations                    |
| `packages/compiler/src/__tests__/security/streaming-pii-buffer.test.ts`        | ~5     | PASS   | Chunk boundary phone split, email across chunks, buffer flush, empty chunk handling, short text accumulation                                      |
| `packages/compiler/src/__tests__/security/encrypted-vault.test.ts`             | ~4     | PASS   | Encrypt/decrypt round-trip, empty vault returns null, encryption failure handling, decryption failure handling                                    |
| `packages/compiler/src/__tests__/security/pii-audit.test.ts`                   | ~4     | PASS   | Buffered writes, flush on buffer full (100 entries), TTL calculation (90 days), flush failure logging                                             |
| `packages/compiler/src/__tests__/guardrails/providers/builtin-pii.test.ts`     | ~6     | PASS   | Provider name/cost, availability, email/SSN detection, clean text safe, latency tracking, raw detection result                                    |
| `packages/compiler/src/__tests__/guardrails/providers/builtin-pii-e2e.test.ts` | ~4     | PASS   | Full guardrail pipeline E2E: detection through evaluate() across all 5 kinds (input, output, tool_input, tool_output, handoff) with valid actions |
| `packages/compiler/src/__tests__/enterprise/pii-guard.test.ts`                 | ~4     | PASS   | Gather exemptions mapping, PII guard hook creation, config-disabled passthrough                                                                   |
| `apps/runtime/src/__tests__/output-pii-filter.test.ts`                         | ~5     | PASS   | Legacy redaction, vault-aware rendering, config disabled passthrough, exempt types, consumer parameter                                            |
| `apps/runtime/src/__tests__/pii-pattern-loader.test.ts`                        | ~5     | PASS   | DB loading, custom recognizer registration, built-in override handling, consumer access config, load failure graceful                             |
| `apps/runtime/src/__tests__/pii-sandbox-escape.test.ts`                        | ~3     | PASS   | Regex-only validation, JS expression as harmless regex, catastrophic backtracking rejection, invalid regex rejection                              |
| `apps/runtime/src/__tests__/pii-testpattern-redos.test.ts`                     | ~4     | PASS   | ReDoS prevention, nested quantifier rejection, valid regex validator, invalid regex skips filtering                                               |
| `apps/runtime/src/__tests__/reported-pii-masking-gaps.test.ts`                 | ~4     | PASS   | PII masking edge cases, message persistence redaction policies (env + tenant config), redactSensitive integration                                 |
| `packages/database/src/__tests__/pii-audit-log.test.ts`                        | ~3     | PASS   | PIIAuditLog model schema validation, TTL index, required fields                                                                                   |
| `packages/database/src/__tests__/pii-pattern-model.test.ts`                    | ~1     | PASS   | PIIPattern model `validate` field handling, Mongoose reserved-key warning suppression                                                             |
| `packages/database/src/__tests__/pii-token-vault-model.test.ts`                | ~3     | PASS   | PIITokenVault schema validation, encryption field registration, TTL/index behavior                                                                |
| `apps/runtime/src/__tests__/pii/pii-token-vault-service.test.ts`               | 10     | PASS   | Durable token flush, reveal selection, unavailable/erased/expired handling, audit fail-closed behavior                                            |
| `apps/runtime/src/__tests__/auth/middleware/rbac.test.ts`                      | 34     | PASS   | Exact-sensitive `pii:reveal`; broad project admin, project owner, and unscoped API key denial                                                     |
| `apps/studio/src/__tests__/components/pii-reveal-controls.test.tsx`            | 6      | PASS   | Reveal affordance gating, required reason, message-scoped request, ephemeral clear on close/session switch, unavailable state                     |
| `apps/studio/src/__tests__/project-permission.test.ts`                         | varies | PASS   | Studio exact-sensitive project permission behavior                                                                                                |
| `apps/studio/src/__tests__/api-routes/route-handler-rbac.test.ts`              | varies | PASS   | Studio route-handler exact-sensitive denial behavior                                                                                              |
| `apps/runtime/src/attachments/__tests__/message-preprocessor-pii.test.ts`      | ~5     | PASS   | Message preprocessor PII redaction policy (redact/block/allow), attachment content handling                                                       |
| `apps/multimodal-service/src/jobs/__tests__/process-job-pii.test.ts`           | ~4     | PASS   | PII detection in document/audio/video processing jobs, non-blocking on PII failure                                                                |

### Integration Tests

#### Output Path Integration (Vault + Output Filter)

| Test File                 | Suites | Status | Detailed Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pii-integration.test.ts` | ~17    | PASS   | **Output Path (4 tests):** reversible tokenization — history stores tokens, user sees masked; destructive fallback when vault unavailable; no filtering when config disabled; no filtering when response has no PII. **Streaming Chunks (3 tests):** streaming chunk with PII filtered via vault; chunk without PII passes through; multiple chunks accumulate tokens. **Transient Cleanup (2 tests):** transient fields (CVV, OTP) removed on gather completion; no-op when no transient fields. **Vault Lifecycle (2 tests):** vault init empty → populate after tokenize → clear on complete; detokenize returns tokens unchanged after clear. **Per-Tool Access (5 tests):** tools consumer sees original values; user sees masked; logs sees redacted labels; LLM sees tokens; restricted tool gets masked context vars. Uses **real `PIIVault`** and **real `filterOutputPII`** — no mocks. |

#### Vault Session Integration

| Test File                            | Suites | Status | Detailed Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `sessions/session-pii-vault.test.ts` | ~22    | PASS   | **Tokenize/detokenize per type (8 tests):** phone, email, SSN, credit card, IP address — each with per-consumer rendering verification (user=masked, logs=redacted, tools=original, llm=token-as-is). **Edge cases (5 tests):** tokenize with exemptions; detokenize after clear returns tokens unchanged; no PII returns text unchanged; unknown token ID returns as-is; multiple PII values in single input. **maskValue utility (9 tests):** phone (last 4), short phone (**\*), email (first char + domain), malformed email, credit card (last 4), short credit card, SSN (fixed pattern), IP (fixed pattern), unknown type. Uses **real `PIIVault`** and **real `maskValue`\*\* — no mocks. |

#### Attachment Preprocessor Integration (Real PII Detection)

| Test File                              | Suites | Status | Detailed Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| -------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `preprocessor-pii-integration.test.ts` | ~4     | PASS   | **I-0.5:** redaction preserves surrounding text around phone number. **I-0.6:** multiple PII types (email + SSN + credit card) each get correct `[REDACTED:type]` tag. **I-0.7:** 50,000-char content with PII near the end — PII at boundary still redacted. **I-0.8:** Japanese text mixed with email — email detected and redacted, Unicode preserved. Uses **real `detectPII`** from `@abl/compiler/platform` wired through `MessagePreprocessor`. Only `MultimodalServiceClient` is mocked (returns pre-built attachment data). |

#### Multimodal Pipeline Integration (Real PII Detection)

| Test File                          | Suites | Status | Detailed Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pii-pipeline-integration.test.ts` | ~4     | PASS   | **I-0.1:** document with email — real `detectPII` sets `hasPII: true` with email detection persisted to real MongoDB. **I-0.2:** re-upload same content hash preserves PII flags from first upload (dedup). **I-0.3:** clean document with no PII — `hasPII: false`, empty piiDetections. **I-0.4:** large document with 50+ email addresses — all detected (includes <5s performance assertion). Uses **real `detectPII`**, **real `createProcessWorker`**, and **real MongoDB** (MongoMemoryServer). Only external services (StorageProvider, DocumentParser, Transcription) are mocked via dependency injection. |

#### ABLP-535 Runtime/Studio Boundary Integration

| Test File                                                       | Suites | Status | Detailed Scenarios                                                                                                                                                                                                                                                                                |
| --------------------------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/sessions/session-routes.test.ts`    | 95     | PASS   | Runtime session detail, message pagination, trace list, and span-child responses are scrubbed; reveal route validates reason/selectors, enforces project/session scope, expands selected message source refs into durable token ids, and does not expose raw message content through normal APIs. |
| `apps/studio/src/__tests__/api-routes/api-proxy-routes.test.ts` | 35+    | PASS   | Studio exact `pii:reveal` permission probe and reveal proxy; proxy requires `projectId`, repeats permission check before forwarding, sends no-store responses, and does not proxy denied requests.                                                                                                |

### E2E Tests

#### Attachment PII E2E (Real Express + MongoDB + Auth)

| Test File                                     | Suites | Status | Detailed Scenarios                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| --------------------------------------------- | ------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `tools-deployment/attachment-pii.e2e.test.ts` | ~6     | PASS   | **E2E-0.1:** PII in document is redacted before reaching the LLM — upload file, simulate processing with `hasPII: true`, send chat, verify LLM request payload has redacted content. **E2E-0.2:** clean document content reaches the LLM verbatim. **E2E-0.3:** `piiPolicy=block` sends block message instead of content — entire attachment blocked. **E2E-0.4:** `piiPolicy=allow` passes raw PII content to the LLM unmodified. **E2E-0.5:** image upload processed normally without PII-related redaction. **E2E-0.6:** mixed attachments — PII file is redacted, clean file is verbatim. Uses **real Express servers** (auth, tenants, models, SDK, chat, sessions, attachments), **real MongoDB** (MongoMemoryServer), **real auth middleware**. LLM is a mock capture server. Multimodal processing is simulated via PATCH endpoint. |

---

## E2E Test Scenarios (MANDATORY -- minimum 5)

### E2E-1: PII Pattern CRUD via HTTP API

**Preconditions**: Runtime server running on random port with full auth middleware, test tenant + project seeded
**Auth Context**: tenant-1, project-1, user with `pii-pattern:write` permission
**Steps**:

1. POST `/api/projects/:projectId/pii-patterns` with custom regex pattern for employee IDs (`\bEMP-\d{6}\b`)
2. GET `/api/projects/:projectId/pii-patterns` -- verify pattern appears in list
3. PUT `/api/projects/:projectId/pii-patterns/:id` -- update redaction to masked with showLast: 4
4. GET `/api/projects/:projectId/pii-patterns/:id` -- verify update persisted
5. DELETE `/api/projects/:projectId/pii-patterns/:id` -- verify deletion
6. GET `/api/projects/:projectId/pii-patterns/:id` -- verify 404

**Expected Result**: Full CRUD lifecycle works with correct auth, tenant isolation, and audit logging
**Isolation Check**: POST with different tenant credentials returns 404 for the pattern created by tenant-1
**Status**: GAP -- no real-server E2E test exists

### E2E-2: Pattern Test Endpoint with Live Detection

**Preconditions**: Runtime server running, test tenant + project seeded
**Auth Context**: tenant-1, project-1, user with `pii-pattern:read` permission
**Steps**:

1. POST `/api/projects/:projectId/pii-patterns/test` with `{ regex: "\\bEMP-\\d{6}\\b", text: "Contact EMP-123456 for details", defaultRenderMode: "redacted" }`
2. Verify response contains detections with match "EMP-123456"
3. Verify consumer previews show redacted version

**Expected Result**: Detection + consumer preview rendering correct
**Status**: GAP -- no real-server E2E test exists

### E2E-3: Cross-Tenant Pattern Isolation

**Preconditions**: Runtime server running, two tenants seeded, each with a project
**Auth Context**: tenant-1/project-A creates pattern, tenant-2 attempts access
**Steps**:

1. POST pattern as tenant-1 on project-A
2. GET pattern by ID as tenant-2 on project-A -- expect 404 (not 403)
3. GET all patterns as tenant-2 on project-A -- expect empty list
4. PUT pattern as tenant-2 -- expect 404
5. DELETE pattern as tenant-2 -- expect 404

**Expected Result**: Tenant isolation enforced at query level via `findOne({_id, tenantId, projectId})`
**Status**: GAP

### E2E-4: Invalid Pattern Rejection

**Preconditions**: Runtime server running, test tenant + project
**Auth Context**: tenant-1, project-1, user with `pii-pattern:write` permission
**Steps**:

1. POST pattern with invalid regex `[unclosed` -- expect 400 VALIDATION_ERROR
2. POST pattern with catastrophic backtracking `(a+)+$` -- expect 400 VALIDATION_ERROR
3. POST pattern with regex exceeding 2048 chars -- expect 400 VALIDATION_ERROR
4. POST pattern with duplicate name -- expect 409 DUPLICATE

**Expected Result**: All validation errors returned with correct HTTP status codes and error codes
**Status**: GAP

### E2E-5: End-to-End PII Detection Through Agent Conversation

**Preconditions**: Runtime server with agent configured, PII redaction enabled in project runtime config
**Auth Context**: tenant-1, project-1
**Steps**:

1. Send message containing email + phone via WebSocket/REST
2. Verify LLM receives tokenized text (no raw PII)
3. Verify user response contains masked PII (not raw values)
4. Verify session audit log contains tokenize events

**Expected Result**: PII detected, tokenized for LLM, masked for user, audit logged
**Status**: PARTIAL -- `pii-integration.test.ts` covers vault rendering but does not exercise full HTTP path

### E2E-6: Streaming Response PII Filtering

**Preconditions**: Runtime server with streaming-enabled agent, PII redaction enabled
**Auth Context**: tenant-1, project-1
**Steps**:

1. Send message that triggers a streaming agent response containing PII
2. Verify streaming chunks have PII redacted even when PII spans chunk boundaries
3. Verify final assembled response has no raw PII

**Expected Result**: Streaming PII buffer correctly handles chunk-boundary detection
**Status**: GAP -- `streaming-pii-buffer.test.ts` covers unit but not real streaming E2E

### E2E-7: Custom Pattern Registration and Runtime Detection

**Preconditions**: Runtime server running, PII redaction enabled
**Auth Context**: tenant-1, project-1
**Steps**:

1. POST custom pattern for employee IDs via API
2. Start a new session (triggers `loadProjectPIIPatterns()`)
3. Send message containing employee ID pattern
4. Verify custom PII type is detected and redacted per pattern config

**Expected Result**: Custom patterns loaded at session init and applied to detection
**Status**: GAP

---

## Integration Test Scenarios (MANDATORY -- minimum 5)

### INT-1: Vault Tokenize -> Render -> Detokenize Round-Trip

**Boundary**: `pii-vault.ts` + `pii-detector.ts`
**Setup**: Create PIIVault instance, text with multiple PII types
**Steps**:

1. `vault.tokenize(text)` -- verify tokens created
2. `vault.renderForConsumer(tokenized, 'user')` -- verify masked output
3. `vault.renderForConsumer(tokenized, 'logs')` -- verify redacted output
4. `vault.renderForConsumer(tokenized, 'tools')` -- verify original output
5. `vault.detokenize(tokenized)` -- verify original text restored

**Expected Result**: Round-trip preserves original values, each consumer sees correct rendering
**Status**: PASS -- covered in `pii-integration.test.ts`

### INT-2: Custom Pattern Loader with Registry

**Boundary**: `pattern-loader.ts` + `pii-recognizer-registry.ts` + `pii-pattern-repo.ts` (mocked DB)
**Setup**: Mock DB returns custom patterns, create fresh recognizer registry
**Steps**:

1. Call `loadProjectPIIPatterns(tenantId, projectId, registry)`
2. Verify custom recognizer registered in registry
3. Run `registry.detectAll(textWithCustomPII)`
4. Verify custom PII type detected

**Expected Result**: Custom patterns from DB registered as recognizers and applied to detection
**Status**: PASS -- covered in `pii-pattern-loader.test.ts`

### INT-3: Output PII Filter with Vault-Aware Mode

**Boundary**: `output-pii-filter.ts` + `pii-vault.ts`
**Setup**: Create vault, tokenize input, configure output filter with vault options
**Steps**:

1. Create vault with tokenized PII
2. Call `filterOutputPII(tokenizedText, config, { vault, patternConfigs, consumer: 'user' })`
3. Verify output uses vault rendering (masked), not destructive redaction

**Expected Result**: Vault-aware mode uses `renderForConsumer()` instead of `detectPIISelective()`
**Status**: PASS -- covered in `pii-integration.test.ts`

### INT-4: Encrypted Vault Persistence Across Sessions

**Boundary**: `encrypted-vault.ts` + `pii-vault.ts`
**Setup**: Create vault, tokenize PII, mock encryption service
**Steps**:

1. `vault.tokenize(text)` -- store PII tokens
2. `encryptVault(vault, tenantId, encService)` -- serialize + encrypt
3. `decryptVault(encrypted, tenantId, encService)` -- decrypt + deserialize
4. `restoredVault.detokenize(tokenizedText)` -- verify original values recovered

**Expected Result**: Vault state survives serialize/encrypt/decrypt/deserialize cycle
**Status**: PASS -- covered in `encrypted-vault.test.ts` and `session-pii-vault.test.ts`

### INT-5: Context-Aware PII Exemption During Gather

**Boundary**: `pii-guard.ts` + `pii-detector.ts`
**Setup**: NLU context with active gather for `phone_number` field
**Steps**:

1. Create PII guard hook with piiRedaction enabled
2. Call hook with text containing phone + email, gather fields = ['phone_number']
3. Verify phone PII is exempt (still in text), email PII is redacted

**Expected Result**: Phone exempt because gather field maps to phone PII type; email redacted normally
**Status**: PASS -- covered in `pii-guard.test.ts`

### INT-6: Audit Logger Buffered Writes

**Boundary**: `pii-audit.ts` + `pii-audit-store-adapter.ts`
**Setup**: Create audit logger with mock store
**Steps**:

1. Log 50 audit entries (below 100 buffer threshold)
2. Verify store has not been called yet (buffered)
3. Log 50 more entries (hits 100 threshold)
4. Verify store.insert() called for all 100 entries
5. Call `logger.stop()` and verify final flush

**Expected Result**: Buffered batch writes at capacity threshold and on stop
**Status**: PASS -- covered in `pii-audit.test.ts`

### INT-7: Pattern Validation Rejects Dangerous Regex

**Boundary**: `pattern-service.ts` + `pattern-loader.ts`
**Setup**: Validation function with test inputs
**Steps**:

1. Validate regex with nested quantifiers `(a+)+` -- expect rejection
2. Validate regex exceeding 2048 chars -- expect rejection
3. Validate regex with invalid syntax `[unclosed` -- expect rejection
4. Validate valid regex `\\d{3}-\\d{4}` -- expect acceptance

**Expected Result**: All dangerous patterns rejected before DB storage
**Status**: PASS -- covered in `pii-testpattern-redos.test.ts` and `pii-sandbox-escape.test.ts`

### INT-8: ABLP-535 Live/History Read Boundary

**Boundary**: Runtime sessions route + message/trace read-boundary helpers
**Setup**: Session route harness with tenant/project-scoped session data and stored message/trace payloads containing redaction candidates
**Steps**:

1. Request session detail and paginated messages.
2. Request trace list and span-child data.
3. Verify raw email/card values are scrubbed at every read boundary.

**Expected Result**: Post-live session reads match the protected live representation and do not expose raw PII through normal APIs.
**Status**: PASS -- covered in `sessions/session-routes.test.ts`

### INT-9: Audited Reveal Requires Exact Permission And Message Scope

**Boundary**: Runtime reveal route + durable token-vault service + Studio proxy
**Setup**: Durable token-vault rows, exact `pii:reveal` permission, and selected message source refs
**Steps**:

1. Submit reveal with reason and selected message scope.
2. Runtime resolves token ids from scoped encrypted message content.
3. Reveal service returns only selected durable originals and writes audit before response.
4. Denied/missing permission, missing reason, and unavailable token paths fail closed.

**Expected Result**: Raw values are returned only through the audited reveal path; no normal history route exposes token ids or originals.
**Status**: PASS -- covered in `pii-token-vault-service.test.ts`, `sessions/session-routes.test.ts`, `api-proxy-routes.test.ts`, `auth/middleware/rbac.test.ts`, `project-permission.test.ts`, and `route-handler-rbac.test.ts`

### INT-10: Studio Reveal Values Are Ephemeral

**Boundary**: Studio `PIIRevealControls`
**Setup**: Component rendered with exact reveal permission and a redacted message marker
**Steps**:

1. Open reveal modal and attempt submit without reason.
2. Submit reveal with reason and optional ticket/case ID.
3. Verify returned values display only inside the modal.
4. Close the modal and switch session/message.

**Expected Result**: Reveal requires reason; raw values clear on close/session switch and are not persisted in Zustand/local storage/URL state.
**Status**: PASS -- covered in `pii-reveal-controls.test.tsx`

---

## How to Run

```bash
# All PII-related compiler tests
pnpm build --filter=compiler && pnpm test --filter=compiler -- --reporter=verbose -t "pii"

# All PII-related runtime tests
pnpm build --filter=runtime && pnpm test --filter=runtime -- --reporter=verbose -t "pii"

# Specific test files
pnpm test --filter=compiler -- pii-detector.test
pnpm test --filter=compiler -- pii-vault.test
pnpm test --filter=compiler -- pii-recognizer-registry.test
pnpm test --filter=compiler -- streaming-pii-buffer.test
pnpm test --filter=compiler -- encrypted-vault.test
pnpm test --filter=compiler -- pii-audit.test
pnpm test --filter=compiler -- builtin-pii.test
pnpm test --filter=compiler -- pii-guard.test
pnpm test --filter=runtime -- output-pii-filter.test
pnpm test --filter=runtime -- pii-pattern-loader.test
pnpm test --filter=runtime -- pii-sandbox-escape.test
pnpm test --filter=runtime -- pii-testpattern-redos.test
pnpm test --filter=runtime -- pii-integration.test
pnpm test --filter=runtime -- session-pii-vault.test
pnpm test --filter=runtime -- reported-pii-masking-gaps.test
pnpm test --filter=database -- pii-audit-log.test
pnpm test --filter=database -- pii-pattern-model.test
pnpm --filter @agent-platform/runtime exec vitest run --config vitest.integration.config.ts --maxWorkers=1 src/__tests__/sessions/session-routes.test.ts
pnpm --filter @agent-platform/runtime exec vitest run --config vitest.core.config.ts src/__tests__/pii/pii-token-vault-service.test.ts src/__tests__/auth/middleware/rbac.test.ts
pnpm --filter @agent-platform/studio exec vitest run --config vitest.node.config.ts src/__tests__/api-routes/api-proxy-routes.test.ts src/__tests__/project-permission.test.ts src/__tests__/api-routes/route-handler-rbac.test.ts
pnpm --filter @agent-platform/studio exec vitest run --config vitest.config.ts src/__tests__/components/pii-reveal-controls.test.tsx

# Attachment PII (E2E + integration)
pnpm test --filter=runtime -- attachment-pii.e2e.test
pnpm test --filter=runtime -- message-preprocessor-pii.test
pnpm test --filter=runtime -- preprocessor-pii-integration.test

# Multimodal PII (integration + unit)
pnpm test --filter=multimodal-service -- pii-pipeline-integration.test
pnpm test --filter=multimodal-service -- process-job-pii.test

# Guardrail pipeline E2E (all kinds)
pnpm test --filter=compiler -- builtin-pii-e2e.test
```

---

## Test Environment

- **Node.js**: Required for all tests
- **MongoDB**: Required for attachment E2E tests (uses `MongoMemoryServer`), mocked in unit tests
- **No Docker required**: All unit and integration tests run without Docker
- **CI**: Tests run as part of `pnpm test` in Turbo pipeline

---

## Gaps & Recommendations

### Critical Gaps

| ID    | Gap                                         | Impact | Recommendation                                               |
| ----- | ------------------------------------------- | ------ | ------------------------------------------------------------ |
| TG-01 | No real-server E2E for PII pattern CRUD API | High   | Write E2E with Express on random port, full auth middleware  |
| TG-02 | No E2E for cross-tenant pattern isolation   | High   | Add multi-tenant isolation test                              |
| TG-03 | No E2E for streaming PII filtering          | Medium | Test with real streaming agent response                      |
| TG-04 | No E2E for custom pattern runtime detection | Medium | Test full lifecycle: create pattern -> new session -> detect |

### Lower Priority Gaps

| ID    | Gap                                            | Impact | Recommendation                                    |
| ----- | ---------------------------------------------- | ------ | ------------------------------------------------- |
| TG-05 | Audit log E2E (verify MongoDB TTL works)       | Low    | Manual or integration test with MongoMemoryServer |
| TG-06 | Performance test for regex detection at scale  | Low    | Benchmark 5 patterns on 10K-char messages         |
| TG-07 | Studio UI component tests for PIIProtectionTab | Low    | Visual regression + interaction tests             |

### Accepted Non-Gaps

| ID    | Decision                                     | Rationale                                                                                                                                                                                                                                               |
| ----- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TG-08 | No legacy-session backfill test for ABLP-535 | Product explicitly decided not to migrate or scrub old sessions for this issue. Legacy records without durable token-vault provenance are non-revealable; the covered behavior is unavailable/non-revealable reveal results rather than a backfill job. |
