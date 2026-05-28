# Test Specification: Arch Intelligent File Processing

**Feature Spec**: `docs/features/sub-features/arch-intelligent-file-processing.md`
**Parent Feature**: [B03 Multimodality Support](../../features/arch-multimodality.md)
**HLD**: N/A (pending)
**LLD**: N/A (pending)
**Status**: PLANNED
**Last Updated**: 2026-04-12

---

## 1. Coverage Matrix

| FR    | Description                                | Unit              | Integration  | E2E                 | Manual | Status     |
| ----- | ------------------------------------------ | ----------------- | ------------ | ------------------- | ------ | ---------- |
| FR-1  | File Processing Protocol in base prompt    | UT-1              | -            | E2E-1, E2E-2        | -      | NOT TESTED |
| FR-2  | Phase-specific file handling instructions  | UT-2              | INT-2        | E2E-1, E2E-3, E2E-4 | -      | NOT TESTED |
| FR-3  | Interview extraction + spec pre-population | -                 | INT-2        | E2E-1, E2E-2        | M-1    | NOT TESTED |
| FR-4  | Blueprint file-assisted topology design    | -                 | INT-2, INT-5 | E2E-3               | M-2    | NOT TESTED |
| FR-5  | Build file-assisted agent code generation  | -                 | INT-2        | E2E-4               | M-3    | NOT TESTED |
| FR-6  | In-Project file-assisted specialist work   | -                 | INT-2        | E2E-5               | -      | NOT TESTED |
| FR-7  | Category annotation in preamble headers    | UT-3, UT-4, UT-12 | INT-1        | E2E-6               | -      | NOT TESTED |
| FR-8  | Phase-aware instruction block in preamble  | UT-5, UT-6        | INT-2, INT-3 | E2E-6               | -      | NOT TESTED |
| FR-9  | Phase parameter in buildFilePreamble       | UT-7              | -            | E2E-1 through E2E-5 | -      | NOT TESTED |
| FR-10 | classifyFileType exported                  | UT-8, UT-12       | -            | -                   | -      | NOT TESTED |
| FR-11 | User data precedence instruction in prompt | UT-9              | -            | -                   | M-4    | NOT TESTED |
| FR-12 | Backward compatibility for old files       | UT-10, UT-11      | INT-3        | E2E-7               | -      | NOT TESTED |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests exercise the real system through HTTP API. No mocks of platform components. No direct DB access. Auth via dev-login route. Mock LLM server for intercepting system prompt content.

### E2E-1: System prompt contains File Processing Protocol when files are present

- **Preconditions**: Session created via `POST /api/arch-ai/sessions`. File uploaded via `POST /api/arch-ai/files` with `{ sessionId, file: { name: 'api-spec.yaml', type: 'text/yaml', size: 1024, content: '<base64 of minimal OpenAPI>' } }`. Mock LLM server running to capture system prompt.
- **Steps**:
  1. `POST /api/arch-ai/message` with `{ sessionId, type: 'message', text: 'here is my API spec', fileRefs: [{ blobId }] }` with `Authorization: Bearer <token>`
  2. Wait for SSE stream to complete (`done` event)
  3. Read captured `llmRequests[last].body.messages` from mock LLM server
  4. Extract system message content
- **Expected Result**: System prompt contains `[Session Files]` block with category annotation (e.g., `(openapi | YAML |`). System prompt contains `[File Processing` instruction block with phase-specific instructions. Base prompt section includes File Processing Protocol text.
- **Auth Context**: Dev-login JWT with tenantId + userId
- **Isolation Check**: Second session (different user) cannot access this session's files — `POST /api/arch-ai/files` with wrong session returns 404

### E2E-2: Interview phase preamble contains extraction instructions

- **Preconditions**: Session in INTERVIEW phase. File uploaded (requirements.txt, text/plain, 500 bytes of requirements text).
- **Steps**:
  1. `POST /api/arch-ai/message` with text "check these requirements" + fileRefs
  2. Intercept LLM system prompt from mock server
- **Expected Result**: System prompt contains `[File Processing — Phase: INTERVIEW]` (or similar phase-tagged instruction block). Instruction references extraction and `update_specification`. File content appears in `[Session Files]` section. SSE response stream completes with `done` event and no error events.
- **Auth Context**: Dev-login JWT with tenantId + userId
- **Isolation Check**: Cross-tenant session access returns 404

### E2E-3: Blueprint phase preamble contains topology-alignment instructions

- **Preconditions**: Session in BLUEPRINT phase (Interview completed, phase transitioned). Image file uploaded (architecture.png, image/png, 10KB).
- **Steps**:
  1. `POST /api/arch-ai/message` with text "here's our architecture" + fileRefs
  2. Intercept LLM system prompt
- **Expected Result**: System prompt contains `[File Processing — Phase: BLUEPRINT]` instruction block. Image metadata appears as `[Image: architecture.png ...]`. Instruction references topology alignment. SSE response stream completes with `done` event and no error events.
- **Auth Context**: Dev-login JWT with tenantId + userId
- **Isolation Check**: Covered by E2E-1 cross-session check and E2E-2 cross-tenant check

### E2E-4: Build phase preamble contains agent-generation instructions

- **Preconditions**: Session in BUILD phase (Interview + Blueprint completed). YAML file uploaded (reference-agent.yaml, text/yaml, 2KB of ABL-like content).
- **Steps**:
  1. `POST /api/arch-ai/message` with text "use this as a reference" + fileRefs
  2. Intercept LLM system prompt
- **Expected Result**: System prompt contains `[File Processing — Phase: BUILD]` instruction block. File categorized as `openapi` (GAP-006: all YAML is `openapi`). Instruction references ABL validation and code patterns. SSE response stream completes with `done` event and no error events.
- **Auth Context**: Dev-login JWT with tenantId + userId
- **Isolation Check**: Covered by E2E-1 cross-session check and E2E-2 cross-tenant check

### E2E-5: In-Project mode preamble contains contextual instructions

- **Preconditions**: In-Project session (mode: IN_PROJECT). CSV file uploaded (data-sample.csv, text/csv, 1KB with header row + 3 data rows).
- **Steps**:
  1. `POST /api/arch-ai/message` with text "analyze this data" + fileRefs
  2. Intercept LLM system prompt
- **Expected Result**: System prompt contains `[File Processing — Phase: IN_PROJECT]` (or `Mode: IN_PROJECT`) instruction block. File categorized as `csv`. Instruction references contextual analysis. SSE response stream completes with `done` event and no error events.
- **Auth Context**: Dev-login JWT with tenantId + userId
- **Isolation Check**: Covered by E2E-1 cross-session check and E2E-2 cross-tenant check

### E2E-6: Category annotation appears in file headers

- **Preconditions**: Session created. Three files uploaded: api.json (application/json), code.ts (application/typescript), photo.png (image/png).
- **Steps**:
  1. `POST /api/arch-ai/message` with text "review these files" + fileRefs for all 3
  2. Intercept LLM system prompt
- **Expected Result**: System prompt contains file headers with categories: `[File: api.json (openapi | JSON |` , `[File: code.ts (code | TS |`, `[Image: photo.png (image |`. Each header includes token estimate. SSE response stream completes with `done` event and no error events.
- **Auth Context**: Dev-login JWT with tenantId + userId
- **Isolation Check**: Covered by E2E-1 cross-session check

### E2E-7: Backward compatibility — files without category produce valid preamble

- **Preconditions**: Session created. File uploaded via `POST /api/arch-ai/files` with `{ sessionId, file: { name: 'data.bin', type: 'application/octet-stream', size: 512, content: '<base64 of arbitrary bytes>' } }`. `classifyFileType()` returns `'unknown'` for this MIME type, simulating pre-feature files without category.
- **Steps**:
  1. `POST /api/arch-ai/message` with text "continue" + fileRefs for the binary file
  2. Intercept LLM system prompt from mock server
- **Expected Result**: System prompt contains `[Session Files]` with extension-based labels (e.g., `[File: data.bin (BIN, 0.5KB)]`). No crash, no missing preamble. Instruction block uses generic guidance (no category-specific instructions). SSE response stream completes with `done` event and no error events.
- **Auth Context**: Dev-login JWT with tenantId + userId
- **Isolation Check**: Covered by E2E-1 cross-session check and E2E-2 cross-tenant check

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: buildFilePreamble annotates file headers with category

- **Boundary**: `content-block-resolver.ts::buildFilePreamble()` ↔ `file-store-service.ts::classifyFileType()`
- **Setup**: Construct 3 `SessionFileRecord` objects: YAML (text/yaml), PNG (image/png), CSV (text/csv)
- **Steps**: Call `buildFilePreamble(files, { contextWindow: 200000, supportsVision: true, phase: 'INTERVIEW' })`
- **Expected Result**: Preamble string contains `(openapi | YAML |` for the YAML file, `(image |` for the PNG, and `(csv | CSV |` for the CSV. Token estimates present in headers.
- **Failure Mode**: If classifyFileType integration breaks, headers fall back to extension-only labels

### INT-2: Phase-aware instruction block varies by phase with FR-specific keywords

- **Boundary**: `content-block-resolver.ts::buildFilePreamble()` internal logic
- **Setup**: Same files as INT-1
- **Steps**:
  1. Call with `phase: 'INTERVIEW'` → capture instruction block
  2. Call with `phase: 'BLUEPRINT'` → capture instruction block
  3. Call with `phase: 'BUILD'` → capture instruction block
  4. Call with `phase: 'IN_PROJECT'` → capture instruction block (using string union)
- **Expected Result**: Each phase produces different instruction text.
  - INTERVIEW: mentions `update_specification`, extraction, pre-populate (FR-3 keywords)
  - BLUEPRINT: mentions topology, alignment, architecture (FR-4 keywords)
  - BUILD: mentions ABL, tools, validation, code patterns (FR-5 keywords)
  - IN_PROJECT: mentions contextual analysis, specialist, diagnostics (FR-6 keywords)
- **Failure Mode**: All phases produce identical instruction block, or phase-specific keywords missing

### INT-3: Instruction block omitted when no phase provided

- **Boundary**: `content-block-resolver.ts::buildFilePreamble()` backward compatibility
- **Setup**: Same files as INT-1
- **Steps**: Call `buildFilePreamble(files, { contextWindow: 200000, supportsVision: true })` — no `phase` in options
- **Expected Result**: Preamble contains `[Session Files]...[/Session Files]` but NO `[File Processing]` instruction block. Output matches the pre-feature behavior exactly (category annotations may still appear in headers as they're derived from classifyFileType).
- **Failure Mode**: Missing phase causes crash or empty preamble

### INT-4: Evicted files excluded from category annotations and instruction block

- **Boundary**: `content-block-resolver.ts::buildFilePreamble()` eviction + category interaction
- **Setup**: Construct 5 large files (each ~40K tokens) that exceed the 50% context budget
- **Steps**: Call `buildFilePreamble(files, { contextWindow: 200000, supportsVision: true, phase: 'INTERVIEW' })`
- **Expected Result**: Some files evicted (returned in `evictedFiles` array). Preamble `[Session Files]` section contains only remaining files. `[File Processing]` instruction block references only categories of remaining files. Evicted file categories do NOT appear in instruction text.
- **Failure Mode**: Instruction block references categories of evicted files, misleading the LLM

### INT-5: Files uploaded in Interview phase persist in Blueprint/Build preamble

- **Boundary**: `content-block-resolver.ts::buildFilePreamble()` cross-phase file availability
- **Setup**: Construct `SessionFileRecord[]` with a file whose `createdAt` is older (simulating upload in a prior phase). Call `buildFilePreamble()` with `phase: 'BLUEPRINT'`.
- **Steps**:
  1. Create file records representing files uploaded during INTERVIEW (e.g., requirements.txt)
  2. Call `buildFilePreamble(files, { contextWindow: 200000, supportsVision: true, phase: 'BLUEPRINT' })`
- **Expected Result**: Preamble includes the INTERVIEW-uploaded file in `[Session Files]`. `[File Processing]` instruction block uses BLUEPRINT phase instructions (not INTERVIEW). File is available regardless of upload phase.
- **Failure Mode**: Files from prior phases excluded from preamble or wrong phase instructions applied

---

## 4. Unit Test Scenarios

### UT-1: Base prompt contains File Processing Protocol section

- **Module**: `prompts/base.ts`
- **Input**: Read `BASE_PROMPT` string constant
- **Expected Output**: Contains "File Processing Protocol" heading. Contains all 6 protocol rules (acknowledge, extract, show, identify gaps, merge, never ignore). Contains category-to-extraction mapping.

### UT-2: Each phase prompt contains file-assisted instructions

- **Module**: `prompts/phases/interview.ts`, `blueprint.ts`, `build.ts`, `in-project.ts`
- **Input**: Read each phase prompt constant
- **Expected Output**: INTERVIEW contains "File-Assisted Interview". BLUEPRINT contains "File-Assisted Blueprint". BUILD contains "File-Assisted Build". IN_PROJECT contains "File-Assisted In-Project" (or "File-Assisted" text).

### UT-3: classifyFileType returns correct category for image types

- **Module**: `file-store-service.ts::classifyFileType()`
- **Input**: `'image/png'`, `'image/jpeg'`, `'image/webp'`, `'image/gif'`, `'image/svg+xml'`
- **Expected Output**: All return `'image'`

### UT-4: classifyFileType returns correct category for document/data types

- **Module**: `file-store-service.ts::classifyFileType()`
- **Input**: `'application/pdf'` → `'pdf'`, `'text/csv'` → `'csv'`, `'application/msword'` → `'docx'`
- **Expected Output**: Each returns its expected category

### UT-5: buildFilePreamble with INTERVIEW phase produces extraction instruction block

- **Module**: `content-block-resolver.ts::buildFilePreamble()`
- **Input**: 1 text file (text/yaml), options `{ contextWindow: 200000, supportsVision: true, phase: 'INTERVIEW' }`
- **Expected Output**: Preamble ends with `[File Processing — Phase: INTERVIEW]` block containing extraction-related instructions

### UT-6: buildFilePreamble instruction block differs per phase

- **Module**: `content-block-resolver.ts::buildFilePreamble()`
- **Input**: Same file, called 4 times with phases INTERVIEW, BLUEPRINT, BUILD, IN_PROJECT
- **Expected Output**: 4 different instruction blocks. Each contains phase-relevant keywords.

### UT-7: buildFilePreamble accepts phase in options without breaking existing behavior

- **Module**: `content-block-resolver.ts::buildFilePreamble()`
- **Input**: Same file, options with phase vs without phase
- **Expected Output**: With phase → instruction block appended. Without phase → no instruction block, preamble matches pre-feature format.

### UT-8: classifyFileType is importable from file-store-service

- **Module**: `file-store-service.ts`
- **Input**: `import { classifyFileType } from '../session/file-store-service.js'`
- **Expected Output**: Function is defined, callable, returns a string

### UT-9: Base prompt contains conflict-resolution instruction

- **Module**: `prompts/base.ts`
- **Input**: Read `BASE_PROMPT` string constant
- **Expected Output**: Contains instruction about user data taking precedence over file-extracted data

### UT-10: buildFilePreamble handles files with unknown category gracefully

- **Module**: `content-block-resolver.ts::buildFilePreamble()`
- **Input**: File with `mediaType: 'application/octet-stream'` (classifyFileType returns `'unknown'`)
- **Expected Output**: File header uses extension-based label (e.g., `[File: data.bin (BIN, 1.2KB)]`). No crash, valid preamble returned.

### UT-11: buildFilePreamble instruction block with all-unknown categories

- **Module**: `content-block-resolver.ts::buildFilePreamble()`
- **Input**: 2 files, both with `mediaType: 'application/octet-stream'`, phase `'INTERVIEW'`
- **Expected Output**: Instruction block present with generic guidance. No category-specific instructions.

### UT-12: classifyFileType returns correct category for all known MIME types (exhaustive)

- **Module**: `file-store-service.ts::classifyFileType()`
- **Input**: All known MIME types from the codebase
- **Expected Output**:
  - `image/png`, `image/jpeg`, `image/webp`, `image/gif` → `'image'`
  - `application/pdf` → `'pdf'`
  - `text/csv`, `application/csv` → `'csv'`
  - `application/vnd.openxmlformats-officedocument.wordprocessingml.document`, `application/msword` → `'docx'`
  - `application/json`, `application/x-yaml`, `text/yaml` → `'openapi'` (GAP-006)
  - `text/plain`, `text/html`, `application/javascript`, `application/typescript` → `'code'`
  - `application/octet-stream`, `multipart/form-data`, `video/mp4` → `'unknown'`

---

## 5. Security & Isolation Tests

- [x] **Cross-tenant file access returns 404**: Upload file in tenant A session, attempt `GET /api/arch-ai/files/{blobId}/content` with tenant B token — verified by B03 existing tests (E2E-3 in `arch-ai-multimodality.e2e.test.ts`)
- [x] **Cross-session file access returns 404**: Upload file in session A, attempt to reference blobId in session B message — verified by B03 existing tests
- [ ] **Preamble only includes files from current session**: Verify `buildFilePreamble()` receives only files from `getActiveFiles(ctx, session.id)` — no cross-session file leakage
- [ ] **classifyFileType does not execute file content**: Verify the function only reads `mediaType` string, never parses or executes file content buffer
- [x] **Missing auth returns 401**: `POST /api/arch-ai/message` without Authorization header — verified by existing auth middleware tests
- [x] **File size limits enforced**: Files > 10MB rejected by `POST /api/arch-ai/files` — verified by B03 tests

---

## 6. Performance & Load Tests

Not applicable for v1. The changes are:

- `classifyFileType()`: synchronous string comparison, sub-microsecond
- `buildFilePreamble()` additions: ~20 lines of string concatenation per file, negligible
- Prompt text additions: ~500-800 tokens, within existing `PREAMBLE_CONTEXT_FRACTION = 0.5` budget

If performance concerns arise, measure:

- Time delta for `buildFilePreamble()` with category + phase vs without (should be < 1ms difference)
- LLM response latency delta with enlarged system prompt (should be within normal variance)

---

## 7. Test Infrastructure

### Required Services

- **MongoMemoryServer**: For session and file storage (E2E and INT-5 only)
- **Mock LLM Server**: HTTP server capturing request bodies, returning controlled SSE responses. Pattern from `arch-ai-multimodality.e2e.test.ts` L78-L106.
- **Dev-login auth**: `ENABLE_DEV_LOGIN=true`, `JWT_SECRET`, `NEXTAUTH_SECRET` env vars

### Test Fixtures Needed (NEW)

| Fixture                 | Format           | Purpose                               | Size       |
| ----------------------- | ---------------- | ------------------------------------- | ---------- |
| `petstore-minimal.yaml` | OpenAPI 3.0 YAML | Test OpenAPI detection and extraction | ~500 bytes |
| `requirements.txt`      | Plain text       | Test requirements extraction          | ~300 bytes |
| `sample-data.csv`       | CSV with headers | Test CSV detection                    | ~200 bytes |
| `reference-agent.yaml`  | ABL-like YAML    | Test ABL detection                    | ~400 bytes |
| `architecture.png`      | 1x1 PNG          | Test image handling                   | ~100 bytes |

### Data Seeding

- E2E tests create sessions via `POST /api/arch-ai/sessions`
- Files uploaded via `POST /api/arch-ai/files` with base64-encoded fixtures
- No direct DB manipulation — all data seeded via HTTP API
- Phase transitions via mock LLM responses calling `proceed_to_next_phase`

### Environment Variables

| Variable           | Value                            | Purpose                     |
| ------------------ | -------------------------------- | --------------------------- |
| `ENABLE_DEV_LOGIN` | `true`                           | Enable test auth flow       |
| `JWT_SECRET`       | `test-jwt-secret-for-arch-tests` | JWT signing for dev-login   |
| `NEXTAUTH_SECRET`  | `test-nextauth-secret`           | NextAuth session encryption |

### CI Configuration

```bash
# Unit + Integration tests (no infra needed)
pnpm build --filter=@agent-platform/arch-ai && pnpm test --filter=@agent-platform/arch-ai

# E2E tests (requires MongoMemoryServer, runs in Studio test suite)
pnpm build && pnpm test --filter=@agent-platform/studio -- --testPathPattern="e2e/arch-ai"
```

---

## 8. Test File Mapping

| Test File                                                             | Type               | Covers                                                           | Status  |
| --------------------------------------------------------------------- | ------------------ | ---------------------------------------------------------------- | ------- |
| `packages/arch-ai/src/__tests__/classify-file-type.test.ts`           | unit               | FR-10, UT-3, UT-4, UT-8, UT-12                                   | PLANNED |
| `packages/arch-ai/src/__tests__/build-file-preamble-phase.test.ts`    | unit + integration | FR-7, FR-8, FR-9, FR-12, UT-5 through UT-11, INT-1 through INT-5 | PLANNED |
| `packages/arch-ai/src/__tests__/prompt-file-protocol.test.ts`         | unit               | FR-1, FR-2, FR-11, UT-1, UT-2, UT-9                              | PLANNED |
| `apps/studio/src/__tests__/e2e/arch-ai-file-intelligence.e2e.test.ts` | e2e                | E2E-1 through E2E-7, security checks                             | PLANNED |

---

## 9. Open Testing Questions

1. Should we add snapshot tests for the prompt text to detect unintentional changes to the File Processing Protocol?
2. How do we regression-test LLM extraction quality over time — golden test fixtures with expected extraction output?
3. Do we need a load test for `buildFilePreamble()` with 50+ files to verify the eviction + category annotation path doesn't degrade?

---

## Manual Validation Scenarios

### M-1: Interview extraction quality with OpenAPI spec

Upload a real OpenAPI spec (e.g., Stripe API subset) at Interview start. Verify the LLM extracts endpoints as tools, schemas as entities, auth as constraints. Count questions skipped vs baseline (no file).

### M-2: Blueprint topology alignment with architecture diagram

Upload a real architecture diagram during Blueprint. Verify the LLM describes the visible topology and aligns its `generate_topology` call with the diagram pattern.

### M-3: Build reference pattern usage

Upload a reference agent YAML during Build. Verify the LLM's generated agents follow patterns from the uploaded reference (e.g., similar GUARDRAILS structure, MEMORY pattern).

### M-4: Conflict resolution — user data wins

Upload a spec saying "3 agents" then tell the LLM "I want 5 agents." Verify the LLM uses 5 and notes the discrepancy.
