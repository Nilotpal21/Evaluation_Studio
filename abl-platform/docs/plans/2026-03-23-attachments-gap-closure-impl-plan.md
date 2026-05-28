# LLD: Attachments Gap Closure (BETA → STABLE)

**Feature Spec**: `docs/features/attachments.md`
**HLD**: `docs/specs/attachments-gap-closure.hld.md`
**Test Spec**: `docs/testing/attachments.md`
**Status**: DONE
**Date**: 2026-03-23

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                                                     | Rationale                                                                                                                                                                                                     | Alternatives Rejected                                                                                                            |
| --- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| D-1 | 4-phase sequential structure with parallel tasks within phases                               | GAP-005 has internal dependencies (parser→compiler→runtime); other gaps slot into phases based on risk and overlap                                                                                            | Fully parallel (no phase boundaries) — harder to verify/revert                                                                   |
| D-2 | GAP-006 (logging) before GAP-T1 (test doubles)                                               | 7 `console.spy` assertions in 3 existing test files break after logging migration                                                                                                                             | GAP-T1 first — would write stubs against stale console pattern                                                                   |
| D-3 | New `pendingAwaitAttachment` field on AgentThread (not sentinel)                             | Needs structured data (category, variable, timeout, prompt, startedAt); can't encode in `string[]`                                                                                                            | Reuse `waitingForInput` with sentinel value                                                                                      |
| D-4 | `await_attachment` placed before `respond` in step type ternary                              | AWAIT_ATTACHMENT steps also have `respond` field; checking respond first misclassifies them                                                                                                                   | First in chain (unnecessary overhead on every step evaluation)                                                                   |
| D-5 | New file `platform-admin-attachment-config.ts` for runtime proxy                             | Matches established 10-file pattern for platform-admin routes; single responsibility                                                                                                                          | Add to existing `platform-admin-config.ts` (quota concerns)                                                                      |
| D-6 | Test doubles in `__tests__/helpers/` (multimodal-service local)                              | Interfaces are package-local imports; no other package needs these stubs                                                                                                                                      | Shared test utilities location (unnecessary coupling)                                                                            |
| D-7 | Mount `attachmentConfigRouter` in PII test harness (project-level)                           | `piiPolicy` is per-project config; 3-tier resolution means project config is the correct E2E path                                                                                                             | Mount multimodal-service admin route (wrong config tier)                                                                         |
| D-8 | `pendingAwaitAttachment` on `AgentThread`/`AgentThreadData` only (NOT `SESSION_JSON_FIELDS`) | Thread-level fields serialize automatically inside the `threads` JSON blob. `SESSION_JSON_FIELDS` controls top-level `SessionData` serialization — adding a thread-only field there would be silently ignored | Add to `SESSION_JSON_FIELDS` + `SessionData` (dual-level like `waitingForInput` — unnecessary complexity for a per-thread field) |

### Key Interfaces & Types

```typescript
// NEW: AST type in packages/core/src/types/agent-based.ts
interface AwaitAttachmentAST {
  name: string; // variable name to store attachment ID
  prompt: string; // user-facing prompt text
  category?: string; // 'image' | 'document' | 'audio' | 'video'
  required?: boolean; // defaults to true
  timeout?: number; // seconds (maps to timeout_seconds in IR)
  on_timeout?: string; // step name to transition to
}

// EXISTING: IR type in packages/compiler/src/platform/ir/schema.ts:1804
interface AwaitAttachmentIR {
  variable: string;
  category?: string;
  required: boolean;
  prompt: string;
  timeout_seconds?: number;
  on_timeout?: string;
}

// NEW: Session state in apps/runtime/src/services/execution/types.ts
interface PendingAwaitAttachment {
  type: 'await_attachment';
  variable: string;
  category?: string;
  required: boolean;
  prompt: string;
  timeoutSeconds?: number;
  onTimeout?: string;
  startedAt: number;
}
```

### Module Boundaries

| Module              | Responsibility                                           | Depends On                              |
| ------------------- | -------------------------------------------------------- | --------------------------------------- |
| `packages/core`     | AST type + parser for AWAIT_ATTACHMENT within FLOW steps | None (foundational)                     |
| `packages/compiler` | AST→IR compilation + IR validation for await_attachment  | `packages/core` (AST types)             |
| `apps/runtime`      | Flow step executor, session state, step thought          | `packages/compiler` (IR types)          |
| `apps/multimodal`   | Admin router mounting, structured logging, server wiring | `@abl/compiler/platform` (createLogger) |
| `apps/admin`        | Tenant attachment config UI + proxy route                | `apps/runtime` (platform admin proxy)   |

---

## 2. File-Level Change Map

### New Files

| File                                                                       | Purpose                                       | LOC Estimate |
| -------------------------------------------------------------------------- | --------------------------------------------- | ------------ |
| `apps/runtime/src/services/execution/await-attachment-executor.ts`         | AWAIT_ATTACHMENT step executor + MIME utility | ~200-250     |
| `apps/runtime/src/routes/platform-admin-attachment-config.ts`              | Runtime platform-admin proxy to multimodal    | ~80          |
| `apps/admin/src/app/api/admin/tenant-attachment-config/route.ts`           | Admin Next.js proxy route                     | ~50          |
| `apps/admin/src/app/(dashboard)/tenants/[id]/AttachmentConfigTab.tsx`      | Admin UI component for tenant attachment cfg  | ~200         |
| `apps/multimodal-service/src/__tests__/helpers/clamav-stub.ts`             | ClamAV TCP stub server                        | ~80          |
| `apps/multimodal-service/src/__tests__/helpers/tika-stub.ts`               | Tika HTTP stub server                         | ~60          |
| `apps/multimodal-service/src/__tests__/helpers/whisper-stub.ts`            | Whisper HTTP stub server                      | ~60          |
| `apps/multimodal-service/src/__tests__/helpers/ffmpeg-test-double.ts`      | FFmpeg VideoProcessor stub                    | ~50          |
| `apps/multimodal-service/src/__tests__/external-services-contract.test.ts` | Contract tests for all 4 test doubles         | ~200         |
| `apps/multimodal-service/src/__tests__/admin-routes-integration.test.ts`   | Integration test for admin router mounting    | ~80          |
| `apps/runtime/src/__tests__/platform-admin-attachment-config.test.ts`      | Integration test for runtime proxy route      | ~80          |
| `packages/compiler/src/__tests__/await-attachment-compilation.test.ts`     | Compiler unit tests for AWAIT_ATTACHMENT      | ~100         |

### Modified Files

| File                                                                            | Change Description                                                 | Risk     |
| ------------------------------------------------------------------------------- | ------------------------------------------------------------------ | -------- |
| `packages/core/src/types/agent-based.ts`                                        | Add `AwaitAttachmentAST` interface                                 | Low      |
| `packages/core/src/parser/agent-based-parser.ts`                                | Add `parseAwaitAttachment()` in flow step parsing section          | Medium   |
| `packages/compiler/src/platform/ir/compiler.ts`                                 | Add `await_attachment` mapping in `compileFlow()`                  | Medium   |
| `packages/compiler/src/platform/ir/validate-ir.ts`                              | Add `on_timeout` to step target collection + category/field checks | Low      |
| `apps/runtime/src/services/execution/flow-step-executor.ts`                     | Add `await_attachment` to step type ternary + handler block        | **High** |
| `apps/runtime/src/services/execution/types.ts`                                  | Add `PendingAwaitAttachment`, `currentAttachmentIds?` to types     | Low      |
| `apps/runtime/src/services/runtime-executor.ts`                                 | Set `session.currentAttachmentIds` before flow step execution      | Medium   |
| `apps/runtime/src/services/session/types.ts`                                    | Add `pendingAwaitAttachment?` to `AgentThreadData`                 | Low      |
| `apps/runtime/src/services/session/redis-session-store.ts`                      | Verify thread deserialization includes `pendingAwaitAttachment`    | Low      |
| `apps/runtime/src/services/execution/step-thought.ts`                           | Add `await_attachment` case to `buildStepSummary()`                | Low      |
| `apps/runtime/src/server.ts`                                                    | Mount platform-admin-attachment-config route                       | Low      |
| `apps/multimodal-service/src/server.ts`                                         | Mount `createAdminRouter` (1-line add)                             | Low      |
| `apps/admin/src/app/(dashboard)/tenants/[id]/page.tsx`                          | Add AttachmentConfigTab to tenant detail tabs                      | Low      |
| `apps/runtime/src/__tests__/attachment-pii.e2e.test.ts`                         | Mount config route, unskip E2E-0.3/0.4, remove stale comments      | Medium   |
| `apps/runtime/src/__tests__/flow-step-await-attachment.test.ts`                 | Update to test actual executor behavior (not just IR shape)        | Medium   |
| `apps/runtime/src/__tests__/attachment-advanced.e2e.test.ts`                    | Remove "empty response is acceptable" fallbacks                    | Medium   |
| `apps/multimodal-service/src/server.ts`                                         | Replace console.\* → createLogger (already listed for admin mount) | Low      |
| `apps/multimodal-service/src/index.ts`                                          | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/config.ts`                                         | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/routes/attachments.ts`                             | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/routes/admin.ts`                                   | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/services/multimodal-service.ts`                    | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/services/queues.ts`                                | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/jobs/queues.ts`                                    | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/storage/local-storage.ts`                          | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/storage/s3-storage.ts`                             | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/security/clamav-scanner.ts`                        | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/security/upload-rate-limiter.ts`                   | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/processing/transcriber-whisper.ts`                 | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/processing/document-parser-tika.ts`                | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/processing/video-processor-ffmpeg.ts`              | Replace console.\* → createLogger                                  | Low      |
| `apps/multimodal-service/src/processing/__tests__/transcriber-whisper.test.ts`  | Update 3 console spies → createLogger mocks                        | Low      |
| `apps/multimodal-service/src/processing/__tests__/document-parser-tika.test.ts` | Update 1 console spy → createLogger mock                           | Low      |
| `apps/multimodal-service/src/security/__tests__/clamav-scanner.test.ts`         | Update 3 console spies → createLogger mock                         | Low      |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Foundation — Logging Migration + PII Test Fix + Admin Router Mount

**Goal**: Close GAP-006 (logging) and GAP-002 (PII test unskip), and unblock GAP-003 by mounting the admin router. These are low-risk mechanical changes that establish a clean baseline.

**Tasks**:

1.1. **GAP-006: Replace 61 console.\* calls with createLogger across 15 multimodal-service files**

- Add `import { createLogger } from '@abl/compiler/platform';` and `const log = createLogger('<module-name>');` to each file
- Replace `console.error(msg)` → `log.error(msg, { context })`, `console.warn(msg)` → `log.warn(msg, { context })`, `console.log(msg)` → `log.info(msg, { context })`
- Convert string interpolation to structured data objects where applicable
- Module names per HLD section 9 GAP-006 table (15 mappings)

  1.2. **GAP-006: Update 7 console spies in 3 existing test files**

- `processing/__tests__/transcriber-whisper.test.ts`: Update 3 spies (lines 39, 435, 458) — replace `vi.spyOn(console, 'error/warn')` with `vi.mock('@abl/compiler/platform')` and assert on the mock logger
- `processing/__tests__/document-parser-tika.test.ts`: Update 1 spy (line 32) — same pattern
- `security/__tests__/clamav-scanner.test.ts`: Update 3 spies (lines 105, 128, 168) — same pattern

  1.3. **GAP-003 prerequisite: Mount createAdminRouter in multimodal-service server.ts**

- Add `import { TenantConfigService } from './services/tenant-config-service.js';`
- Add `import { createAdminRouter } from './routes/admin.js';`
- Instantiate: `const configService = new TenantConfigService();` (stateless constructor, no deps)
- Mount: `app.use('/admin', createAdminRouter(configService));`
- Place this block in `startServer()` AFTER `wireAttachmentRoutes()` and BEFORE `wireErrorHandlers()` (~line 239). The 404 handler in `wireErrorHandlers()` catches all unmatched routes — if admin routes come after, they'll never be reached.
- Note: Tasks 1.1 and 1.3 both touch `server.ts`. Apply logging migration (1.1) first, then admin mount (1.3) in sequence.

  1.4. **GAP-002: Unskip PII block/allow E2E tests**

- Mount `attachmentConfigRouter` at `/api/projects/:projectId/attachment-config` in the test harness (after line 202 in `attachment-pii.e2e.test.ts`)
- Before E2E-0.3: Add `PUT /api/projects/:projectId/attachment-config` with `{ piiPolicy: 'block' }` using admin auth
- Before E2E-0.4: Add `PUT /api/projects/:projectId/attachment-config` with `{ piiPolicy: 'allow' }` using admin auth
- Remove `test.skip` from both tests (lines 379, 441)
- Remove stale "Task #17" comments
- If tests reveal actual bugs in PII block/allow path, fix them inline (contingency — see D-7 in oracle decisions)

**Files Touched**:

- `apps/multimodal-service/src/server.ts` — mount admin router
- `apps/multimodal-service/src/index.ts` — console → createLogger
- `apps/multimodal-service/src/config.ts` — console → createLogger
- `apps/multimodal-service/src/routes/attachments.ts` — console → createLogger
- `apps/multimodal-service/src/routes/admin.ts` — console → createLogger
- `apps/multimodal-service/src/services/multimodal-service.ts` — console → createLogger
- `apps/multimodal-service/src/services/queues.ts` — console → createLogger
- `apps/multimodal-service/src/jobs/queues.ts` — console → createLogger
- `apps/multimodal-service/src/storage/local-storage.ts` — console → createLogger
- `apps/multimodal-service/src/storage/s3-storage.ts` — console → createLogger
- `apps/multimodal-service/src/security/clamav-scanner.ts` — console → createLogger
- `apps/multimodal-service/src/security/upload-rate-limiter.ts` — console → createLogger
- `apps/multimodal-service/src/processing/transcriber-whisper.ts` — console → createLogger
- `apps/multimodal-service/src/processing/document-parser-tika.ts` — console → createLogger
- `apps/multimodal-service/src/processing/video-processor-ffmpeg.ts` — console → createLogger
- `apps/multimodal-service/src/processing/__tests__/transcriber-whisper.test.ts` — update 3 console spies
- `apps/multimodal-service/src/processing/__tests__/document-parser-tika.test.ts` — update 1 console spy
- `apps/multimodal-service/src/security/__tests__/clamav-scanner.test.ts` — update 3 console spies
- `apps/runtime/src/__tests__/attachment-pii.e2e.test.ts` — mount config route, unskip tests

**Exit Criteria**:

- [x] Zero `console.log`, `console.error`, or `console.warn` calls remain in `apps/multimodal-service/src/**/*.ts` production files (verify with `grep -r 'console\.' --include='*.ts' apps/multimodal-service/src/ --exclude-dir=__tests__`)
- [x] `pnpm build --filter=multimodal-service` succeeds with 0 errors
- [x] `pnpm test --filter=multimodal-service` passes (all existing tests including the 3 updated spy tests)
- [x] E2E-0.3 (`piiPolicy=block`) and E2E-0.4 (`piiPolicy=allow`) pass: `pnpm test --filter=runtime -- attachment-pii-e2e`
- [x] `GET /admin/config/:tenantId` is reachable on multimodal-service (verified in Phase 2 integration test)
- [x] No `test.skip` remains in `attachment-pii.e2e.test.ts`

**Test Strategy**:

- Unit: Existing multimodal-service tests pass (80+ tests), updated spy assertions verify logger calls
- E2E: 2 unskipped PII tests pass end-to-end

**Rollback**: `git revert` on the GAP-006 commit (cosmetic change, no functional impact). GAP-002 revert re-skips the tests. Admin router mount revert removes the route.

---

### Phase 2: Admin UI + AWAIT_ATTACHMENT Parser/Compiler + Test Doubles

**Goal**: Close GAP-003 (admin UI) and GAP-T1 (test doubles), and complete GAP-005 Phase 1 (parser + compiler). These are independent work streams.

**Tasks**:

2.1. **GAP-003: Admin integration test for multimodal-service admin router**

- Create `apps/multimodal-service/src/__tests__/admin-routes-integration.test.ts`
- Test `GET /admin/config/:tenantId` returns 200 with valid internal auth
- Test `GET /admin/config/:tenantId` returns 401 without auth
- Test `PUT /admin/config/:tenantId` with valid body returns 200 and persists changes

  2.2. **GAP-003: Runtime platform-admin proxy route**

- Create `apps/runtime/src/routes/platform-admin-attachment-config.ts`
- Apply the full 4-layer auth middleware chain (matching all 10 existing platform-admin routes):
  1. `platformAdminAuthMiddleware` (from `../middleware/auth.js`) — authenticate + verify super-admin
  2. `tenantRateLimit('request')` (from `../middleware/rate-limiter.js`) — rate limiting
  3. `requirePlatformAdmin()` (from `@agent-platform/shared-auth`) — redundant guard
  4. `requirePlatformAdminIp(() => getConfig().security.platformAdminAllowedIps)` (from `@agent-platform/shared-auth`) — IP allowlist
- `GET /?tenantId=<id>` — proxy to multimodal-service `GET /admin/config/:tenantId`, extract `tenantId` from query parameter (matching `platform-admin-config.ts` GET pattern at line 106)
- `PUT /?tenantId=<id>` — proxy to multimodal-service `PUT /admin/config/:tenantId`, validate body with Zod schema for defense-in-depth (same fields as `validateConfigUpdate` in admin.ts), forward validated body
- Discover multimodal-service URL from `process.env.MULTIMODAL_SERVICE_URL || 'http://multimodal-service:3006'` (same pattern as `multimodal-service-client.ts:75`)
- Write audit log on PUT via `writeAuditLog()`
- Mount in `apps/runtime/src/server.ts` at `/api/platform/admin/tenant-attachment-config`
- Create `apps/runtime/src/__tests__/platform-admin-attachment-config.test.ts` with 4 tests: auth required (401), IP allowlist enforced, GET forwarding, PUT forwarding + validation

  2.3. **GAP-003: Admin Next.js proxy route**

- Create `apps/admin/src/app/api/admin/tenant-attachment-config/route.ts`
- Follow `apps/admin/src/app/api/tenant-config/route.ts` pattern exactly
- `GET`: `withAdminRoute({ role: 'VIEWER' })`, proxy to runtime
- `PUT`: `withAdminRoute({ role: 'ADMIN' })`, proxy to runtime

  2.4. **GAP-003: Admin UI component — AttachmentConfigTab**

- Create `apps/admin/src/app/(dashboard)/tenants/[id]/AttachmentConfigTab.tsx`
- Fields: `maxFileSizeBytes`, `allowedMimeTypes`, `blockedMimeTypes`, `scanEnabled`, `processingEnabled`, `embeddingEnabled`, `piiPolicy`, `maxAttachmentsPerSession`, `maxTotalStorageBytes`, `retentionDays`
- Follow existing tenant config tab patterns (form layout, save/reset). Use raw `fetch()` for PUT mutations (matching existing OverviewTab pattern — no API client abstraction exists in admin app).
- Add lazy import using `next/dynamic` (NOT `React.lazy`) in `apps/admin/src/app/(dashboard)/tenants/[id]/page.tsx`: `const AttachmentConfigTab = dynamic(() => import('./AttachmentConfigTab'), { ssr: false, loading: () => <Skeleton /> })` — matching the existing UsageTab dynamic import pattern at line 23

  2.5. **GAP-005 Phase 1a: AST type + parser**

- Add `AwaitAttachmentAST` interface to `packages/core/src/types/agent-based.ts`
- Add `awaitAttachment?: AwaitAttachmentAST` to the `FlowStep` interface at ~line 270 (after the `corrections` field) — without this, the parser cannot store parsed data and the compiler cannot read it
- Add `'AWAIT_ATTACHMENT'` to the `stepPropertyKeywords` array at ~line 655 in `packages/core/src/parser/agent-based-parser.ts` — prevents the keyword from being misinterpreted as a step name
- Add `case 'AWAIT_ATTACHMENT':` to the step property switch at ~line 1109 in `agent-based-parser.ts`. Parse block sub-properties using indent-based reading (matching the TRANSFORM pattern at ~line 1153). Do NOT create a separate `parseAwaitAttachment()` function — the parser uses inline case handling for step properties, not separate functions.
- Map YAML fields: `name` → `name`, `prompt` → `prompt`, `category` → `category`, `required` → `required` (default true), `timeout` → `timeout`, `on_timeout` → `on_timeout`

  2.6. **GAP-005 Phase 1b: Compiler mapping + IR validation**

- Add `await_attachment` mapping in `compileFlow()` in `packages/compiler/src/platform/ir/compiler.ts` (~line 2562, after `corrections` mapping)
- Complete mapping (note: AST uses camelCase `step.awaitAttachment`, IR uses snake_case `await_attachment`):
  ```typescript
  await_attachment: step.awaitAttachment
    ? {
        variable: step.awaitAttachment.name,
        category: step.awaitAttachment.category,
        timeout_seconds: step.awaitAttachment.timeout,
        on_timeout: step.awaitAttachment.on_timeout,
        required: step.awaitAttachment.required ?? true,
        prompt: step.awaitAttachment.prompt,
      }
    : undefined;
  ```
- Add validation in `packages/compiler/src/platform/ir/validate-ir.ts`:
  - `category` must be one of `['image', 'document', 'audio', 'video']` if present
  - `timeout_seconds` must be > 0 if present
  - `on_timeout` must reference a valid step name in the flow (add to `collectStepTargets` at ~line 213)
  - `variable` must be non-empty, no spaces
  - `prompt` must be non-empty
- Create `packages/compiler/src/__tests__/await-attachment-compilation.test.ts` with 8+ test cases:
  - Basic AWAIT_ATTACHMENT compiles to correct IR
  - Category validation (valid/invalid)
  - Timeout validation (positive, zero, negative)
  - on_timeout references valid step / invalid step
  - Required defaults to true
  - Missing prompt → error
  - Missing variable → error
  - Full round-trip: DSL → AST → IR

    2.7. **GAP-T1: Create 4 test doubles**

- Create `apps/multimodal-service/src/__tests__/helpers/clamav-stub.ts` — TCP server implementing ClamAV INSTREAM protocol, returns CLEAN/FOUND based on fixture
- Create `apps/multimodal-service/src/__tests__/helpers/tika-stub.ts` — HTTP server, `PUT /tika`, returns extracted text for known fixtures
- Create `apps/multimodal-service/src/__tests__/helpers/whisper-stub.ts` — HTTP server, `POST /asr`, returns transcription JSON for known audio fixtures
- Create `apps/multimodal-service/src/__tests__/helpers/ffmpeg-test-double.ts` — implements `VideoProcessor` interface (`extractAudio`, `extractKeyFrames`), validates input params, returns fixture output

  2.8. **GAP-T1: Create contract tests**

- Create `apps/multimodal-service/src/__tests__/external-services-contract.test.ts`
- ClamAV: 3 tests (clean file, infected file, connection error)
- Tika: 3 tests (valid document, unsupported MIME, timeout)
- Whisper: 3 tests (valid audio, invalid format, timeout)
- FFmpeg: 3 tests (extract audio, extract keyframes, invalid input)

**Files Touched**:

- `apps/multimodal-service/src/__tests__/admin-routes-integration.test.ts` — NEW
- `apps/runtime/src/routes/platform-admin-attachment-config.ts` — NEW
- `apps/runtime/src/server.ts` — mount new route
- `apps/runtime/src/__tests__/platform-admin-attachment-config.test.ts` — NEW
- `apps/admin/src/app/api/admin/tenant-attachment-config/route.ts` — NEW
- `apps/admin/src/app/(dashboard)/tenants/[id]/AttachmentConfigTab.tsx` — NEW
- `apps/admin/src/app/(dashboard)/tenants/[id]/page.tsx` — add tab
- `packages/core/src/types/agent-based.ts` — add AST type
- `packages/core/src/parser/agent-based-parser.ts` — add parser
- `packages/compiler/src/platform/ir/compiler.ts` — add compilation mapping
- `packages/compiler/src/platform/ir/validate-ir.ts` — add validation rules
- `packages/compiler/src/__tests__/await-attachment-compilation.test.ts` — NEW
- `apps/multimodal-service/src/__tests__/helpers/clamav-stub.ts` — NEW
- `apps/multimodal-service/src/__tests__/helpers/tika-stub.ts` — NEW
- `apps/multimodal-service/src/__tests__/helpers/whisper-stub.ts` — NEW
- `apps/multimodal-service/src/__tests__/helpers/ffmpeg-test-double.ts` — NEW
- `apps/multimodal-service/src/__tests__/external-services-contract.test.ts` — NEW

**Exit Criteria**:

- [x] `GET/PUT /admin/config/:tenantId` reachable on multimodal-service with auth — integration test passes
- [x] Runtime proxy route forwards to multimodal-service — `pnpm test --filter=runtime -- platform-admin-attachment-config` passes
- [x] Admin UI loads tenant attachment config, saves changes, resets to defaults
- [x] `AWAIT_ATTACHMENT:` DSL compiles to correct `AwaitAttachmentIR` — `pnpm test --filter=compiler -- await-attachment` passes (8+ tests)
- [x] IR validation catches invalid category, negative timeout, missing prompt/variable — compiler tests pass
- [x] `on_timeout` referencing non-existent step produces validation error
- [x] `pnpm build --filter=core && pnpm build --filter=compiler` succeeds with 0 errors
- [x] All 4 test doubles start, respond to requests, and shut down cleanly — 12+ contract tests pass
- [x] `pnpm test --filter=multimodal-service -- external-services-contract` passes

**Test Strategy**:

- Unit: Compiler unit tests for AST→IR mapping and validation (8+ tests)
- Integration: Admin router auth/forwarding (3 tests), runtime proxy route (3 tests), contract tests for test doubles (12+ tests)
- E2E: Admin UI is functional (manual verification; browser E2E in Phase 4)

**Rollback**: Each gap is a separate commit — `git revert` on any individual gap's commit(s).

---

### Phase 3: AWAIT_ATTACHMENT Runtime Executor

**Goal**: Complete GAP-005 by implementing the runtime executor and wiring it into the flow execution engine. This is the highest-risk phase — isolated for careful review.

**Tasks**:

3.1. **Session state extension**

- Define `PendingAwaitAttachment` interface in `apps/runtime/src/services/execution/types.ts`:
  ```typescript
  export interface PendingAwaitAttachment {
    type: 'await_attachment';
    variable: string;
    category?: string;
    required: boolean;
    prompt: string;
    timeoutSeconds?: number;
    onTimeout?: string;
    startedAt: number;
  }
  ```
- Add `pendingAwaitAttachment?: PendingAwaitAttachment` to `AgentThread` in `apps/runtime/src/services/execution/types.ts`
- Add `pendingAwaitAttachment?: PendingAwaitAttachment` to `AgentThreadData` in `apps/runtime/src/services/session/types.ts`
- **Do NOT add to `SESSION_JSON_FIELDS`** — `pendingAwaitAttachment` is a per-thread field. It serializes automatically inside the `threads` JSON blob (which is already in `SESSION_JSON_FIELDS`). The `SESSION_JSON_FIELDS` array controls top-level `SessionData` fields. Adding a thread-only field there would be silently ignored.
- Verify thread reconstruction in `redis-session-store.ts` (~line 969+) includes `pendingAwaitAttachment` in the thread data round-trip. If the thread deserialization uses explicit field picks (not spread), add `pendingAwaitAttachment` to the pick list.
- **Known limitation**: The MongoDB `session-state-repo.ts` `docToSessionData` method (~line 306) uses explicit field picking for thread deserialization. The new field may be dropped on MongoDB restore. This matches pre-existing behavior for other thread fields (e.g., `handoffStartedAt`, `handoffTimeoutMs`). Accepted limitation — Redis is the primary session store.

  3.1b. **Attachment data access for executor**

- **Problem**: `executeFlowStep()` in `flow-step-executor.ts` (~line 2141) receives `(session, userMessage: string, onChunk, onTraceEvent)` — no attachment data. The `options.attachmentIds` from `ExecuteMessageOptions` is NOT forwarded to the flow step executor.
- **Fix**: Add `currentAttachmentIds?: string[]` to `RuntimeSession` in `apps/runtime/src/services/execution/types.ts`. In `apps/runtime/src/services/runtime-executor.ts`, set `session.currentAttachmentIds = options?.attachmentIds` before calling `executeFlowStep()` (~line 2268), and clear it after execution. The executor then reads from `session.currentAttachmentIds` to check if the current message carries attachments.
- This avoids changing the `executeFlowStep` function signature (which would have a large blast radius).
- **Important**: Wrap in `try/finally` to prevent stale IDs leaking to next turn: `session.currentAttachmentIds = options?.attachmentIds; try { ... } finally { session.currentAttachmentIds = undefined; }`

  3.2. **AwaitAttachmentExecutor**

- Create `apps/runtime/src/services/execution/await-attachment-executor.ts` (~200-250 LOC including utility + trace events)
- Create `deriveCategoryFromMimeType(mimeType: string): string | undefined` utility in the executor file — maps MIME type prefix to category: `image/*` → `'image'`, `application/pdf` and document types → `'document'`, `audio/*` → `'audio'`, `video/*` → `'video'`
- Follow the GATHER suspension pattern in `flow-step-executor.ts` (~line 3901):
  1.  **Check completion**: If `session.currentAttachmentIds` is non-empty, resolve attachment metadata from the multimodal-service client (or use `session.pendingContentBlocks` if available) to get MIME types. Use `deriveCategoryFromMimeType()` to match against `step.await_attachment.category` (or accept any if category is unset). If matched, store the first matching attachment ID in `session.data.values[step.await_attachment.variable]`. Clear `session.pendingAwaitAttachment`. Return advance signal.
  2.  **Timeout check**: If `session.pendingAwaitAttachment` exists and `timeoutSeconds` is set, check if elapsed time exceeds timeout. If so: if `onTimeout` is a step name, transition to that step; otherwise, emit timeout error response and return error signal.
  3.  **Not complete (first entry or re-prompt)**: Emit `step.await_attachment.prompt` as a response. Set `session.pendingAwaitAttachment` with IR fields + `startedAt: Date.now()`. Return wait signal.
  4.  **Optional attachment** (`required: false`): If user sends a message without attachment, set variable to `null`, clear pending state, advance flow.
- `AwaitAttachmentExecutor.execute()` must accept `onTraceEvent` callback as a parameter (matching the GATHER handler pattern in `flow-step-executor.ts`). Use `emitDecisionEvent()` from `./trace-helpers.js`:
  - Prompt: `emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'await_attachment', { action: 'prompt', variable, category })`
  - Received: `emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'await_attachment', { action: 'received', variable, attachmentId })`
  - Timeout: `emitDecisionEvent(onTraceEvent, session.traceVerbosity, 'await_attachment', { action: 'timeout', variable, onTimeout })`
- **Prerequisite**: Add `'await_attachment'` to the `DecisionKind` union type in `apps/runtime/src/services/execution/trace-helpers.ts` (~line 15). Also add entry to `DECISION_KIND_VERBOSITY` map (~line 108) with level `2` (verbose — matching `gather_extraction`). Without this, `emitDecisionEvent` calls will fail TypeScript compilation.

  3.3. **Flow step executor wiring**

- In `apps/runtime/src/services/execution/flow-step-executor.ts`:
  - Add `step.await_attachment ? 'await_attachment'` to the step type classification ternary (~line 2484), inserted **before** the `step.respond` check:
    ```typescript
    : step.transform
      ? 'transform'
      : step.await_attachment    // <-- NEW
        ? 'await_attachment'     // <-- NEW
        : step.respond
          ? 'respond'
          : 'unknown';
    ```
  - Add handler block for `await_attachment` step type, placed before the `respond` handler in the main execution switch/if chain. Delegate to `AwaitAttachmentExecutor.execute()`.

    3.4. **Step thought extension**

- In `apps/runtime/src/services/execution/step-thought.ts`:
  - Add `await_attachment?: { variable: string; category?: string; prompt: string }` to the step parameter type of `buildStepSummary()`
  - Add handler: `if (step.await_attachment) return \`Waiting for file upload: ${step.await_attachment.variable}\`;`

**Files Touched**:

- `apps/runtime/src/services/execution/types.ts` — add `PendingAwaitAttachment`, `currentAttachmentIds?` to `AgentThread`/`RuntimeSession`
- `apps/runtime/src/services/session/types.ts` — add field to `AgentThreadData`
- `apps/runtime/src/services/session/redis-session-store.ts` — verify thread deserialization includes new field
- `apps/runtime/src/services/runtime-executor.ts` — set `session.currentAttachmentIds` before `executeFlowStep()`, clear after
- `apps/runtime/src/services/execution/await-attachment-executor.ts` — NEW (~200-250 LOC)
- `apps/runtime/src/services/execution/flow-step-executor.ts` — step type ternary + handler block
- `apps/runtime/src/services/execution/step-thought.ts` — add `await_attachment` case
- `apps/runtime/src/services/execution/trace-helpers.ts` — add `'await_attachment'` to `DecisionKind` union + `DECISION_KIND_VERBOSITY` map

**Exit Criteria**:

- [x] `pnpm build --filter=runtime` succeeds with 0 errors
- [x] `pnpm test --filter=runtime` passes — all 8,861+ existing tests still pass (no regressions)
- [x] AWAIT_ATTACHMENT step type correctly classified (not misclassified as 'respond')
- [x] `session.pendingAwaitAttachment` is serialized to Redis and survives session reload (verified by updated `flow-step-await-attachment.test.ts` in Phase 4)
- [x] Step thought emits `"Waiting for file upload: <variable>"` for await_attachment steps

**Test Strategy**:

- Unit: Step thought extension (trivial assertion)
- Regression: Full runtime test suite (8,861+ tests) — confirms zero regressions in flow execution

**Rollback**: Revert touches 6 files. The `await-attachment-executor.ts` is a new file (just delete). The ternary change + handler in `flow-step-executor.ts` and the type extensions are additive — revert via `git revert`.

---

### Phase 4: Test Hardening + Integration Verification

**Goal**: Update existing tests to exercise real executor behavior, remove false-confidence fallbacks, verify end-to-end across all gaps.

**Tasks**:

4.1. **Update `flow-step-await-attachment.test.ts` — test actual executor behavior**

- **Preserve** the existing GATHER `type: attachment` tests (lines 182-219) — these cover a separate code path (gather field extraction) and must not be removed
- Replace/extend IR-shape-only AWAIT_ATTACHMENT assertions with executor behavior tests:
  - Prompt emission when no attachment present
  - Attachment matching by category (using `deriveCategoryFromMimeType`)
  - Variable storage in session.data.values
  - Timeout handling (transition to onTimeout step)
  - Optional attachment skip (required: false + text-only message)
  - Re-prompt on wrong category
  - Session state persistence (`pendingAwaitAttachment` set/cleared correctly)
  - `currentAttachmentIds` data access path

    4.2. **Update `attachment-advanced.e2e.test.ts` — remove "empty response is acceptable" fallbacks**

- The AWAIT_ATTACHMENT E2E tests currently accept empty responses as "passing" because the executor didn't exist. Now that it does:
  - Assert the response contains the configured prompt text
  - Assert that sending an attachment causes the variable to be stored
  - Assert that the flow advances after attachment receipt
  - Remove any `|| response === ''` or `"empty response is acceptable"` patterns

    4.3. **Cross-gap integration verification**

- Run full test suites for all affected packages:
  - `pnpm build && pnpm test --filter=runtime`
  - `pnpm test --filter=compiler`
  - `pnpm test --filter=multimodal-service`
  - `pnpm test --filter=core`
- Verify no cross-gap interference (e.g., logging migration didn't break any runtime test, admin route doesn't conflict with existing routes)

**Files Touched**:

- `apps/runtime/src/__tests__/flow-step-await-attachment.test.ts` — rewrite for executor behavior
- `apps/runtime/src/__tests__/attachment-advanced.e2e.test.ts` — remove false-confidence fallbacks

**Exit Criteria**:

- [x] `flow-step-await-attachment.test.ts` has 7+ test cases covering all executor behaviors (prompt, match, store, timeout, skip, re-prompt, persistence)
- [x] `attachment-advanced.e2e.test.ts` AWAIT_ATTACHMENT tests assert real prompt emission and variable storage — no empty-response fallbacks
- [x] `pnpm build` succeeds across entire monorepo with 0 errors
- [x] `pnpm test --filter=runtime` passes (8,861+ tests)
- [x] `pnpm test --filter=compiler` passes (3,947+ tests)
- [x] `pnpm test --filter=multimodal-service` passes (all tests including logging updates + contract tests)
- [x] Zero `console.log/error/warn` in multimodal-service production code
- [x] Zero `test.skip` in attachment E2E tests

**Test Strategy**:

- Unit: Executor behavior tests (7+ cases)
- E2E: Updated advanced E2E with real assertions
- Regression: Full suite across runtime, compiler, multimodal-service

**Rollback**: Test-only changes — revert to prior test versions.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [x] `createAdminRouter` mounted in `apps/multimodal-service/src/server.ts` at `/admin` path
- [x] `platform-admin-attachment-config` route imported and mounted in `apps/runtime/src/server.ts` at `/api/platform/admin/tenant-attachment-config`
- [x] `tenant-attachment-config/route.ts` created in `apps/admin/src/app/api/admin/` (Next.js file-based routing auto-wires)
- [x] `AttachmentConfigTab` lazy-imported and rendered in `apps/admin/src/app/(dashboard)/tenants/[id]/page.tsx` tenant tab list
- [x] `AwaitAttachmentAST` type exported from `packages/core/src/types/agent-based.ts`
- [x] `awaitAttachment?` property added to `FlowStep` interface in `packages/core/src/types/agent-based.ts`
- [x] `'AWAIT_ATTACHMENT'` added to `stepPropertyKeywords` array in `agent-based-parser.ts`
- [x] `case 'AWAIT_ATTACHMENT':` added to step property switch at ~line 1109 in `agent-based-parser.ts`
- [x] `'await_attachment'` added to `DecisionKind` union + `DECISION_KIND_VERBOSITY` map in `trace-helpers.ts`
- [x] `await_attachment` IR mapping added in `compileFlow()` in `packages/compiler/src/platform/ir/compiler.ts`
- [x] `on_timeout` target added to `collectStepTargets()` in `packages/compiler/src/platform/ir/validate-ir.ts`
- [x] `await_attachment` step type added to classification ternary in `flow-step-executor.ts`
- [x] `await_attachment` handler block added to execution dispatch in `flow-step-executor.ts`
- [x] `pendingAwaitAttachment` field added to `AgentThread` and `AgentThreadData` (serializes via `threads` JSON blob — do NOT add to `SESSION_JSON_FIELDS`)
- [x] `createAdminRouter` mounted in `startServer()` AFTER `wireAttachmentRoutes()` and BEFORE `wireErrorHandlers()` — ordering is critical (404 handler catches all if admin routes come after)
- [x] Runtime proxy route uses full 4-layer auth: `platformAdminAuthMiddleware` → `tenantRateLimit` → `requirePlatformAdmin` → `requirePlatformAdminIp`
- [x] `await_attachment` case added to `buildStepSummary()` in `step-thought.ts`
- [x] `AwaitAttachmentExecutor` imported and called from `flow-step-executor.ts` handler block
- [x] `attachmentConfigRouter` mounted in PII E2E test harness Express app

---

## 5. Cross-Phase Concerns

### Database Migrations

None. All changes are additive to in-memory/session state. No MongoDB schema changes.

### Feature Flags

None. All 5 gaps are either completing missing functionality (GAP-005), replacing internal logging (GAP-006), fixing tests (GAP-002, GAP-T1), or adding admin UI (GAP-003). No gradual rollout needed.

### Configuration Changes

No new environment variables. `createAdminRouter` mounting requires instantiating `new TenantConfigService()` in `startServer()` — this class has a stateless constructor (no deps). The `MULTIMODAL_SERVICE_URL` env var is already used by the runtime for the existing multimodal-service client.

---

## 6. Acceptance Criteria (Whole Feature)

- [x] All 5 gaps closed: GAP-002 (PII tests unskipped and passing), GAP-003 (admin UI functional), GAP-005 (AWAIT_ATTACHMENT fully wired parser→compiler→runtime), GAP-006 (zero console.\* in production), GAP-T1 (4 test doubles with contract tests)
- [x] E2E tests from test spec passing: all 36+ existing E2E tests + 2 unskipped PII tests
- [x] Integration tests from test spec passing: all 46+ existing + new admin/proxy/contract tests
- [x] No regressions in existing tests: `pnpm build && pnpm test` passes across runtime (8,861+), compiler (3,947+), multimodal-service
- [x] Feature spec updated with implementation details (via post-impl-sync)
- [x] Testing matrix updated with actual coverage (via post-impl-sync)
- [x] Feature status evaluated for STABLE promotion (pending 1-week staging criterion)

---

## 7. Open Questions

1. **PII block/allow bug contingency**: If unskipping E2E-0.3/E2E-0.4 reveals bugs in the PII pipeline, inline fixes are planned. If the fix scope exceeds S effort, should it be tracked as a separate issue or absorbed into this work?

2. **Admin UI testing level**: The admin UI component (AttachmentConfigTab) will have manual verification in Phase 2. Should Playwright browser E2E tests be added in Phase 4, or deferred to a separate testing pass?

3. **AWAIT_ATTACHMENT attachment matching logic**: RESOLVED — The message preprocessor (`apps/runtime/src/attachments/message-preprocessor.ts`) already resolves attachment records from the multimodal-service and maps them to `ContentBlock[]` with metadata including `mimeType`. The executor should derive category from MIME type prefix: `image/*` → `'image'`, `application/pdf` and document types → `'document'`, `audio/*` → `'audio'`, `video/*` → `'video'`. This mapping should be a utility function in the executor file. The executor receives the processed `currentMessage` which includes `ContentBlock[]` with attachment metadata — no additional multimodal-service query needed.
