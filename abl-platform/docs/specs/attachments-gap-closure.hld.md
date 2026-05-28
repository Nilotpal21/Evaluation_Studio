# HLD: Attachments Gap Closure (BETA → STABLE)

**Feature Spec**: `docs/features/attachments.md`
**Test Spec**: `docs/testing/attachments.md`
**Parent HLD**: `docs/specs/attachments.hld.md`
**Status**: DONE
**Author**: Platform team
**Date**: 2026-03-23

---

## 1. Problem Statement

The Attachments feature is at BETA status with 5 remaining gaps preventing promotion to STABLE:

| Gap     | Description                                                                                                                    | Severity | Effort |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| GAP-002 | PII `block`/`allow` E2E tests skipped — production code is wired but test harness doesn't mount the config route               | Low      | S      |
| GAP-003 | No admin UI for tenant-level attachment config — API exists in multimodal-service but no UI anywhere                           | Medium   | M      |
| GAP-005 | `AWAIT_ATTACHMENT` flow step has IR schema type but zero production code (no parser, no compiler mapping, no runtime executor) | Medium   | L      |
| GAP-006 | multimodal-service uses 61 `console.*` calls across 15 files instead of structured `createLogger`                              | Low      | S      |
| GAP-T1  | External processing services (ClamAV, Tika, Whisper, FFmpeg) have no CI-runnable integration tests                             | Low      | M      |

Per `docs/sdlc/pipeline.md` BETA → STABLE criteria: no open CRITICAL/HIGH gaps, MEDIUM gaps must be resolved or accepted with rationale, all E2E/integration scenarios passing, docs current. GAP-003 and GAP-005 (both Medium) are mandatory. The remaining Low-severity gaps should also close to meet CLAUDE.md invariants (no `console.log` in server code) and test completeness.

---

## 2. Alternatives Considered

### Option A: Close All 5 Gaps (Recommended)

- **Description**: Implement all 5 gaps in parallel — full AWAIT_ATTACHMENT implementation, admin UI, PII test unskip, logging migration, and CI test doubles.
- **Pros**: Clean STABLE promotion with zero open gaps. All CLAUDE.md invariants satisfied. Advertised features (AWAIT_ATTACHMENT) actually work. Full observability via structured logging.
- **Cons**: Largest scope (~5-7 days of work across all gaps). AWAIT_ATTACHMENT touches critical flow execution path.
- **Effort**: L (aggregate)

### Option B: Close Mandatory Gaps Only (GAP-003, GAP-005)

- **Description**: Close only the two Medium-severity gaps required for STABLE. Defer GAP-002, GAP-006, GAP-T1 with documented rationale.
- **Pros**: Faster path to STABLE (~3-4 days). Lower risk surface.
- **Cons**: Leaves `console.log` violations in multimodal-service (CLAUDE.md non-compliance). Skipped PII E2E tests reduce confidence in a critical security path. CI test doubles deferred indefinitely.
- **Effort**: M

### Option C: Accept Gaps With Rationale, Promote Anyway

- **Description**: Document all 5 gaps as accepted limitations and promote to STABLE based on existing coverage.
- **Pros**: Zero implementation effort. Feature is functional for all currently-used paths.
- **Cons**: AWAIT_ATTACHMENT is documented in IR schema and feature spec but has zero implementation — "STABLE" status would be misleading. Violates CLAUDE.md logging invariant. Undermines test spec integrity (PASS status on tests that mask failures).
- **Effort**: S

### Recommendation: Option A

**Rationale**: The gaps are well-understood, parallelizable, and low-risk individually. GAP-005 (AWAIT_ATTACHMENT) has complete design docs and LLD already written. GAP-002 and GAP-006 are mechanical. GAP-003 follows an established admin portal pattern. GAP-T1 follows the existing mock-server pattern. Closing all 5 gives genuine confidence in the STABLE label.

---

## 3. Architecture

### Work Stream Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                    Attachments Gap Closure                          │
│                                                                     │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────────────────┐  │
│  │ GAP-002      │  │ GAP-003      │  │ GAP-005                  │  │
│  │ PII Test Fix │  │ Admin UI     │  │ AWAIT_ATTACHMENT          │  │
│  │              │  │              │  │                            │  │
│  │ apps/runtime │  │ apps/admin   │  │ packages/core (parser)    │  │
│  │ (tests only) │  │ apps/runtime │  │ packages/compiler (IR)    │  │
│  │              │  │ (proxy route)│  │ apps/runtime (executor)   │  │
│  │ Effort: S    │  │ Effort: M    │  │ Effort: L                │  │
│  └──────────────┘  └──────────────┘  └──────────────────────────┘  │
│                                                                     │
│  ┌──────────────────────────┐  ┌────────────────────────────────┐  │
│  │ GAP-006                  │  │ GAP-T1                         │  │
│  │ Structured Logging       │  │ CI Test Doubles                │  │
│  │                          │  │                                 │  │
│  │ apps/multimodal-service  │  │ apps/multimodal-service        │  │
│  │ (15 prod files, 61 calls)│  │ (test infrastructure)          │  │
│  │ Effort: S                │  │ Effort: M                      │  │
│  └──────────────────────────┘  └────────────────────────────────┘  │
│                                                                     │
│  All 5 work streams have ZERO file-level overlap.                  │
│  They can be implemented fully in parallel.                        │
└─────────────────────────────────────────────────────────────────────┘
```

### GAP-005: AWAIT_ATTACHMENT Architecture

```
DSL Source                    Compiler Pipeline                Runtime Execution
─────────────                ──────────────────               ──────────────────

FLOW:                        ┌──────────────────┐             ┌──────────────────┐
  steps:                     │ agent-based-      │             │ flow-step-       │
    - AWAIT_ATTACHMENT:  ──▶ │ parser.ts         │             │ executor.ts      │
        name: id_doc         │                   │             │                  │
        prompt: "Upload..."  │ Parse into AST    │             │ Dispatch to      │
        category: image      │ AwaitAttachmentAST│             │ handler based    │
        required: true       └────────┬──────────┘             │ on step type     │
                                      │                        └────────┬─────────┘
                                      ▼                                 │
                             ┌──────────────────┐                       ▼
                             │ compiler.ts       │             ┌──────────────────┐
                             │                   │             │ await-attachment- │
                             │ Compile to IR     │             │ executor.ts      │
                             │ AwaitAttachmentIR │             │ (NEW)            │
                             │ + validate fields │             │                  │
                             └────────┬──────────┘             │ 1. Emit prompt   │
                                      │                        │ 2. Set pending   │
                                      ▼                        │    on session    │
                             ┌──────────────────┐             │ 3. Return (wait) │
                             │ validate-ir.ts    │             │ 4. On next msg:  │
                             │                   │             │    check attach  │
                             │ Validate category │             │ 5. Match category│
                             │ enum, timeout > 0 │             │ 6. Store in var  │
                             └──────────────────┘             │ 7. Advance flow  │
                                                              └──────────────────┘

Session State (mirrors GATHER pending pattern in flow-step-executor.ts):
  session.pendingAwaitAttachment = {
    type: 'await_attachment',
    variable: 'id_doc',
    category: 'image',         // single string (per IR schema)
    required: true,
    prompt: 'Please upload your ID',
    timeoutSeconds: 300,
    onTimeout: 'fallback_step', // step name to transition to (per IR schema)
    startedAt: 1711152000000
  }
```

### GAP-003: Admin UI Data Flow

```
Admin Portal                 Runtime                          Multimodal Service
───────────                 ────────                         ──────────────────

Browser (apps/admin)
  │
  │ GET/PUT /api/admin/
  │   tenant-attachment-config
  ▼
┌─────────────────┐        ┌──────────────────────┐        ┌──────────────────┐
│ Admin Next.js   │  HTTP  │ Runtime              │  HTTP  │ Multimodal Svc   │
│ API route       │ ──────▶│ Platform admin route  │ ──────▶│ /admin/          │
│                 │        │ /api/platform/admin/  │        │ config/:tenantId │
│ withAdminRoute  │        │ tenant-attachment-    │        │                  │
│ ({ role: ... }) │        │ config                │        │ requireInternal  │
└─────────────────┘        │ (appends tenantId    │        │ Auth             │
                           │  to forwarded URL)   │        └──────────────────┘
                           └──────────────────────┘
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | No new isolation concerns. GAP-003 admin UI reads/writes tenant config scoped by `X-Tenant-Id`. GAP-005 AWAIT_ATTACHMENT is session-scoped (inherits existing session isolation). All existing `findOne({ _id, tenantId })` patterns remain.                                                                                  |
| 2   | **Data Access Pattern** | No new data models. GAP-005 adds a `pendingAwaitAttachment` field to the in-memory session state (mirrors GATHER pending pattern in `flow-step-executor.ts`). GAP-003 consumes the existing `TenantAttachmentConfig` collection via the multimodal-service admin API.                                                         |
| 3   | **API Contract**        | GAP-003 adds one new runtime route: `GET/PUT /api/platform/admin/tenant-attachment-config` (pass-through to multimodal-service). Request/response shapes match the existing multimodal-service admin API. Standard error envelope `{ success, data?, error?: { code, message } }`.                                            |
| 4   | **Security Surface**    | GAP-003: Admin route protected by `requirePlatformAdmin` middleware. GAP-005: AWAIT_ATTACHMENT validates `category` enum at compile time (no new runtime security surface — category is a closed enum, not arbitrary MIME patterns). GAP-002: Validates PII block/allow actually works E2E (security validation improvement). |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                           |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | GAP-005: If AWAIT_ATTACHMENT times out, the `on_timeout` field specifies a step name to transition to (e.g., `fallback_step`). If `on_timeout` is unset, the step fails with an error response. If no attachment matches the `category` constraint, re-prompt with the configured prompt text. If `required: false` and user sends a text-only message, treat as skipped (set variable to `null`, advance flow).                          |
| 6   | **Failure Modes** | GAP-005: Session pending state is serialized to Redis (via `AgentThreadData`), so it survives pod restarts. However, if Redis loses the session entry (e.g., eviction, TTL expiry), the pending state is lost and the user must re-trigger the flow. This matches existing `waitingForInput`/`pendingResponse` durability behavior. GAP-T1: Test double failures return HTTP 500 with descriptive error (matching real service behavior). |
| 7   | **Idempotency**   | GAP-003: PUT is idempotent (upsert). GAP-005: Receiving multiple attachments while pending replaces the variable (last-write-wins, matching GATHER behavior for repeated inputs).                                                                                                                                                                                                                                                         |
| 8   | **Observability** | GAP-006 directly addresses this — replacing 61 `console.*` calls with structured `createLogger` across 15 files. Module names follow kebab-case convention: `multimodal-routes`, `scan-job`, `s3-storage`, etc. GAP-005: `buildStepSummary()` in `step-thought.ts` extended to emit `"Waiting for file upload"` for `await_attachment` steps.                                                                                             |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --- | ---------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | No new performance concerns. AWAIT_ATTACHMENT adds zero latency to the flow execution path — it suspends and waits for user input (same as GATHER). Admin UI is low-traffic (admin-only). Test doubles run only in CI.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| 10  | **Migration Path**     | No data migration needed. All changes are additive: new parser support, new executor, new admin route, logging replacement. No breaking changes to existing APIs or data models.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| 11  | **Rollback Plan**      | Each gap is independent and can be reverted individually via `git revert` on its commit. **GAP-005** (highest risk): Revert touches 4 locations — `packages/core/src/types/agent-based.ts` (AST type), `packages/core/src/parser/agent-based-parser.ts` (parser), `packages/compiler/src/platform/ir/compiler.ts` (compiler mapping), `packages/compiler/src/platform/ir/validate-ir.ts` (validator), `apps/runtime/src/services/execution/await-attachment-executor.ts` (new file — delete), `apps/runtime/src/services/execution/flow-step-executor.ts` (conditional branch), `apps/runtime/src/services/execution/step-thought.ts` (summary case). Each gap should be a separate commit to enable surgical revert. **GAP-006**: Logging change is cosmetic — revert does not affect functionality. **GAP-003**: Admin route removable without affecting project-level config. |
| 12  | **Test Strategy**      | **GAP-002**: Unskip 2 existing E2E tests + mount config route in harness. **GAP-003**: 3 integration tests (proxy route auth, forwarding, error handling) + 6 unit tests (admin UI component). **GAP-005**: 8 unit tests (parser, compiler, validator), 5 integration tests (DSL→IR→runtime), 3 E2E tests (full flow with attachment upload). Update existing E2E to remove "empty response is acceptable" fallbacks. **GAP-006**: No new tests (mechanical replacement — existing tests cover behavior). **GAP-T1**: 4 contract test doubles (ClamAV, Tika, Whisper, FFmpeg stub servers) with 12+ test cases validating request/response contracts.                                                                                                                                                                                                                            |

---

## 5. Data Model

### No New Collections

All 5 gaps operate on existing data models. No schema changes required.

### Session State Extension (GAP-005)

GAP-005 adds an optional `pendingAwaitAttachment` field to the runtime session state. This requires:

1. **Extend `AgentThread`** in `apps/runtime/src/services/execution/types.ts` — add `pendingAwaitAttachment?: PendingAwaitAttachment`
2. **Extend `AgentThreadData`** in `apps/runtime/src/services/session/types.ts` — add the same field for Redis serialization
3. **Add to `SESSION_JSON_FIELDS`** in `apps/runtime/src/services/session/redis-session-store.ts` (~line 134) — ensures the object is JSON-serialized/deserialized with the session (objects go in `SESSION_JSON_FIELDS`, not `SESSION_HASH_FIELDS`)

This follows the same serialization approach as `waitingForInput` and `pendingResponse`, which are also persisted to Redis. This means AWAIT_ATTACHMENT pending state **survives pod restarts** (unlike what was stated in concern #6 — the accepted limitation applies only if the session store loses the entry, which Redis handles durably).

```typescript
interface PendingAwaitAttachment {
  type: 'await_attachment';
  variable: string; // Variable name to store attachment ID in session.data.values
  category?: string; // Optional category constraint: 'image', 'document', 'audio', 'video'
  required: boolean; // Whether the attachment is required or optional
  prompt: string; // Re-prompt text shown to user
  timeoutSeconds?: number; // Max wait time (undefined = no timeout)
  onTimeout?: string; // Step name to transition to on timeout (undefined = fail)
  startedAt: number; // Timestamp for timeout calculation
}
```

Field mapping from `AwaitAttachmentIR` (per `packages/compiler/src/platform/ir/schema.ts` lines 1804-1817):

- `variable` → `variable` (direct)
- `category?: string` → `category` (single optional string: `'image'`, `'document'`, `'audio'`, `'video'`)
- `required: boolean` → `required` (direct)
- `prompt: string` → `prompt` (direct)
- `timeout_seconds?: number` → `timeoutSeconds` (camelCase conversion)
- `on_timeout?: string` → `onTimeout` (step name to transition to, NOT an enum)

---

## 6. API Design

### New Endpoints

| Method | Path                                           | Purpose                                                         | Auth                    |
| ------ | ---------------------------------------------- | --------------------------------------------------------------- | ----------------------- |
| GET    | `/api/platform/admin/tenant-attachment-config` | Get tenant attachment config (proxied to multimodal-service)    | Platform Admin (VIEWER) |
| PUT    | `/api/platform/admin/tenant-attachment-config` | Update tenant attachment config (proxied to multimodal-service) | Platform Admin (ADMIN)  |

### Admin Portal Routes

| Method | Path                                  | Purpose                        | Auth                                 |
| ------ | ------------------------------------- | ------------------------------ | ------------------------------------ |
| GET    | `/api/admin/tenant-attachment-config` | Admin Next.js proxy to runtime | `withAdminRoute({ role: 'VIEWER' })` |
| PUT    | `/api/admin/tenant-attachment-config` | Admin Next.js proxy to runtime | `withAdminRoute({ role: 'ADMIN' })`  |

### Modified Endpoints

None. All existing attachment routes remain unchanged.

### Error Responses

Standard error envelope for all new routes:

```json
{
  "success": false,
  "error": {
    "code": "TENANT_NOT_FOUND",
    "message": "No tenant attachment config found for tenant abc123"
  }
}
```

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: GAP-003 admin config changes should emit audit log entries (existing admin audit pattern). GAP-005 AWAIT_ATTACHMENT step execution emits `TraceEvent` via `step-thought.ts`.
- **Rate Limiting**: N/A — admin routes are low-traffic, AWAIT_ATTACHMENT is user-paced.
- **Caching**: N/A — no new caching layers.
- **Encryption**: N/A — no new encryption concerns (attachment encryption at rest is already handled).

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                                        | Type            | Risk                           |
| ----------------------------------------------------------------- | --------------- | ------------------------------ |
| GATHER suspension pattern in `flow-step-executor.ts` (~line 3901) | Runtime pattern | Low — well-established, stable |
| Admin portal routing (`withAdminRoute`)                           | Auth middleware | Low — existing, tested         |
| `createLogger` from `@abl/compiler/platform`                      | Logger API      | Low — already a dependency     |
| Multimodal-service admin API                                      | Internal API    | Low — exists, tested           |

### Downstream (depends on this feature)

| Consumer                                    | Impact                                                          |
| ------------------------------------------- | --------------------------------------------------------------- |
| Agent authors using `AWAIT_ATTACHMENT:` DSL | GAP-005 enables this DSL section for the first time             |
| Platform admins managing tenant config      | GAP-003 provides UI for existing API                            |
| Observability/monitoring tooling            | GAP-006 enables structured log ingestion for multimodal-service |

---

## 9. Per-Gap Design Details

### GAP-002: PII Block/Allow E2E Test Unskip

**Scope**: Test-only changes in `apps/runtime/src/__tests__/attachment-pii.e2e.test.ts`

**Changes**:

1. Mount `attachmentConfigRouter` on `/api/projects/:projectId/attachment-config` in the test harness Express app
2. Before E2E-0.3: `PUT /api/projects/:projectId/attachment-config` with `{ piiPolicy: 'block' }` using admin auth
3. Before E2E-0.4: `PUT /api/projects/:projectId/attachment-config` with `{ piiPolicy: 'allow' }` using admin auth
4. Remove `test.skip` from both tests
5. Remove stale "Task #17" comments
6. Update `docs/specs/attachment-pii-e2e.changes.md` to reflect resolution

**Zero production code changes.**

### GAP-003: Tenant Attachment Config Admin UI

**Scope**: `apps/admin` (UI + proxy route), `apps/runtime` (platform admin proxy route)

**Prerequisite**: Mount `createAdminRouter` in `apps/multimodal-service/src/server.ts`. The router is defined in `routes/admin.ts` but currently **not mounted** (dead code). Add `app.use('/admin', createAdminRouter(configService))` in `server.ts` after the attachment routes.

**Runtime proxy route** (`apps/runtime/src/routes/platform-admin-attachment-config.ts`):

- Thin pass-through to multimodal-service `GET/PUT /admin/config/:tenantId`
- Protected by `requirePlatformAdmin` middleware
- Extracts `tenantId` from the admin auth context and appends it to the forwarded URL path

**Admin proxy route** (`apps/admin/src/app/api/admin/tenant-attachment-config/route.ts`):

- Follows existing `apps/admin/src/app/api/tenant-config/route.ts` pattern exactly
- `withAdminRoute({ role: 'VIEWER' })` for GET, `withAdminRoute({ role: 'ADMIN' })` for PUT

**Admin UI component** (`apps/admin/src/app/(dashboard)/tenants/[id]/attachment-config/page.tsx`):

- New tab on tenant detail page
- Fields: `maxFileSizeBytes`, `allowedMimeTypes`, `blockedMimeTypes`, `scanEnabled`, `processingEnabled`, `embeddingEnabled`, `piiPolicy`, `maxAttachmentsPerSession`, `maxTotalStorageBytes`, `retentionDays`
- Follow existing tenant config tab patterns for form layout, validation, save/reset

### GAP-005: AWAIT_ATTACHMENT Full Implementation

**Scope**: `packages/core` (parser), `packages/compiler` (compiler + validator), `apps/runtime` (executor + wiring)

**Phase 1 — Parser & Compiler**:

1. **AST type** (`packages/core/src/types/agent-based.ts`): Add `AwaitAttachmentAST` interface matching the IR contract:
   - `name: string` — variable name to store attachment ID
   - `prompt: string` — user-facing prompt text
   - `category?: string` — optional category constraint (`'image'`, `'document'`, `'audio'`, `'video'`)
   - `required?: boolean` — defaults to `true`
   - `timeout?: number` — seconds (maps to `timeout_seconds` in IR)
   - `on_timeout?: string` — step name to transition to on timeout

2. **Parser** (`packages/core/src/parser/agent-based-parser.ts`): Add `parseAwaitAttachment()` method in the flow step parsing section (adjacent to existing `parseGather()` / `parseCheck()` methods). Recognize `AWAIT_ATTACHMENT:` or `await_attachment:` as a flow step keyword under `steps:`. Map YAML fields directly to AST. Note: the parser currently handles flow steps in the `parseFlowSteps()` method — the new handler goes there.

3. **Compiler** (`packages/compiler/src/platform/ir/compiler.ts`): Add `await_attachment` mapping in the flow step compilation function (~line 2562, after `corrections` mapping). Map AST fields directly to `AwaitAttachmentIR`: `name` → `variable`, `category` → `category` (passthrough single string), `timeout` → `timeout_seconds`, `on_timeout` → `on_timeout` (step name string).

4. **Validator** (`packages/compiler/src/platform/ir/validate-ir.ts`): Add validation rules:
   - `category` must be one of `['image', 'document', 'audio', 'video']` if present
   - `timeout_seconds` must be >= 0 if present
   - `on_timeout` must reference a valid step name in the flow if present
   - `variable` must be a valid identifier string (non-empty, no spaces)
   - `prompt` must be non-empty

**Phase 2 — Runtime Executor**:

5. **AwaitAttachmentExecutor** (`apps/runtime/src/services/execution/await-attachment-executor.ts`):
   - Follows the GATHER suspension pattern in `flow-step-executor.ts` (~line 3901): check completeness → if incomplete, prompt and wait → on next message, re-check → if complete, store result and advance flow.
   - `execute(step, session, currentMessage)`:
     - **Check completion**: If `currentMessage` has attachment IDs and `step.await_attachment.category` matches (or category is unset), the step is complete. Store the first matching attachment ID in `session.data.values[step.await_attachment.variable]`. Return advance signal.
     - **Not complete (first entry or re-prompt)**: Emit `step.await_attachment.prompt` as a response. Set `session.pendingAwaitAttachment` with the IR fields + `startedAt` timestamp. Return wait signal (same as GATHER returning when fields are missing).
     - **Timeout**: If `step.await_attachment.timeout_seconds` is set and elapsed time exceeds it: if `on_timeout` is a step name, transition to that step; otherwise, emit an error response.
     - **Optional attachment** (`required: false`): If the user sends a message without an attachment, treat it as "skipped" — set the variable to `null` and advance the flow.

6. **Flow step executor wiring** (`apps/runtime/src/services/execution/flow-step-executor.ts`):
   - Add `step.await_attachment ? 'await_attachment'` to the step type classification ternary chain (~line 2484) **BEFORE** the `step.respond` check (otherwise `await_attachment` steps with a `respond` field would be misclassified as `'respond'` type)
   - Add `if (step.await_attachment)` handler block that delegates to `AwaitAttachmentExecutor`, placed before the `step.respond` handler in the main execution loop

7. **Step thought** (`apps/runtime/src/services/execution/step-thought.ts`):
   - Extend the `buildStepSummary()` function's step parameter type to include `await_attachment?: { variable: string }`
   - Add `await_attachment` case returning `"Waiting for file upload"`

**Phase 3 — Tests**:

8. Update `apps/runtime/src/__tests__/flow-step-await-attachment.test.ts` to test actual executor behavior (not just IR shape)
9. Update `apps/runtime/src/__tests__/attachment-advanced.e2e.test.ts` to remove "empty response is acceptable" fallbacks — require actual prompt emission
10. Add compiler unit tests for `compileAwaitAttachment()` and validator tests

### GAP-006: Structured Logging Migration

**Scope**: `apps/multimodal-service/src/` — 15 production files, 61 `console.*` calls

**Approach**: Single-commit big-bang replacement.

**Dependency verified**: `@abl/compiler` is already in `apps/multimodal-service/package.json` (`"@abl/compiler": "workspace:*"` at line 22). The import `import { createLogger } from '@abl/compiler/platform';` will work without any dependency changes. Test files already mock `createLogger` from this path.

Per file:

1. Add `import { createLogger } from '@abl/compiler/platform';`
2. Add `const log = createLogger('<module-name>');` at module level
3. Replace `console.error(msg)` → `log.error(msg, { context })`
4. Replace `console.warn(msg)` → `log.warn(msg, { context })`
5. Replace `console.log(msg)` → `log.info(msg, { context })`
6. Convert string interpolation to structured data objects

**Module names**:

| File                                   | Logger Name             |
| -------------------------------------- | ----------------------- |
| `server.ts`                            | `multimodal-server`     |
| `index.ts`                             | `multimodal-service`    |
| `config.ts`                            | `multimodal-config`     |
| `routes/attachments.ts`                | `multimodal-routes`     |
| `routes/admin.ts`                      | `multimodal-admin`      |
| `services/multimodal-service.ts`       | `attachment-service`    |
| `services/queues.ts`                   | `multimodal-queues`     |
| `jobs/queues.ts`                       | `multimodal-job-queues` |
| `storage/local-storage.ts`             | `local-storage`         |
| `storage/s3-storage.ts`                | `s3-storage`            |
| `security/clamav-scanner.ts`           | `clamav-scanner`        |
| `security/upload-rate-limiter.ts`      | `upload-rate-limiter`   |
| `processing/transcriber-whisper.ts`    | `whisper-transcriber`   |
| `processing/document-parser-tika.ts`   | `tika-parser`           |
| `processing/video-processor-ffmpeg.ts` | `ffmpeg-processor`      |

### GAP-T1: CI Test Doubles for External Services

**Scope**: `apps/multimodal-service/src/__tests__/` — new test infrastructure

**Approach**: Lightweight Express-based stub servers (matching the existing `startMockLLM()` pattern from E2E tests).

**Test doubles to implement**:

1. **ClamAV stub** (`__tests__/helpers/clamav-stub.ts`): TCP server implementing ClamAV INSTREAM protocol. Returns `CLEAN` or `FOUND` based on test fixture content. Validates protocol framing (size-prefixed chunks, zero-terminator).

2. **Tika stub** (`__tests__/helpers/tika-stub.ts`): HTTP server on random port. Accepts `PUT /tika` with binary body, returns extracted text. Validates Content-Type header. Returns canned responses for known fixtures.

3. **Whisper stub** (`__tests__/helpers/whisper-stub.ts`): HTTP server on random port. Accepts `POST /asr` with multipart audio, returns JSON `{ text: "..." }`. Validates multipart boundary and audio MIME type.

4. **FFmpeg test double** (`__tests__/helpers/ffmpeg-test-double.ts`): Implement a stub `VideoProcessor` that implements the existing `VideoProcessor` interface (`extractAudio`, `extractKeyFrames`) from `apps/multimodal-service/src/processing/video-processor-ffmpeg.ts`. The `createProcessWorker` factory in `process-job.ts` already accepts `videoProcessor` via its deps parameter — the DI boundary already exists. The stub validates input parameters (file paths, format) and returns fixture output files. No production code changes needed. Note: The actual `FFmpegVideoProcessor` uses the `fluent-ffmpeg` library (not `child_process.spawn` directly), so the DI boundary is at the `VideoProcessor` interface level, not the spawn level.

**Contract tests**: Each stub validates:

- Request format matches what multimodal-service sends
- Response format matches what the processing jobs expect
- Error cases (connection refused, timeout, malformed response) are handled correctly

---

## 10. Open Questions & Decisions Needed

1. **AWAIT_ATTACHMENT timeout persistence**: RESOLVED — The pending state is serialized to Redis via `AgentThreadData` + `SESSION_JSON_FIELDS`, surviving pod restarts. This follows the same pattern as `waitingForInput` and `gatherFieldsCollected`.

2. **Tenant admin UI scope**: Should the admin UI support bulk operations (applying a config template to multiple tenants)? (Current answer: No — single-tenant CRUD only for initial implementation.)

3. **FFmpeg test strategy**: Resolved — use a stub `VideoProcessor` implementation injected via the existing DI boundary in `process-job.ts`. The `VideoProcessor` interface already exists; no production code changes needed.

---

## 11. References

- Feature spec: `docs/features/attachments.md`
- Test spec: `docs/testing/attachments.md`
- Parent HLD: `docs/specs/attachments.hld.md`
- AWAIT_ATTACHMENT design: `docs/plans/2026-03-12-agent-capabilities-gaps-design.md` (section 2.6)
- AWAIT_ATTACHMENT LLD: `docs/plans/2026-03-13-agent-capabilities-phase2-attachment-tools.md` (Chunk 4, Tasks 8-9)
- SDLC pipeline (promotion criteria): `docs/sdlc/pipeline.md` (lines 111-121)
- GATHER suspension pattern (reference): `apps/runtime/src/services/execution/flow-step-executor.ts` (~line 3901, GATHER step handling with `checkGatherComplete`, prompt-and-wait, re-check-on-message)
- Admin portal tenant config (reference pattern): `apps/admin/src/app/api/tenant-config/route.ts`
