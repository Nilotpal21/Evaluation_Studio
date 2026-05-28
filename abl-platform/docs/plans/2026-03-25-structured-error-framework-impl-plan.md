# LLD: Structured Error Framework

**Feature Spec**: `docs/features/structured-error-framework.md`
**HLD**: `docs/specs/structured-error-framework.hld.md`
**Test Spec**: `docs/testing/structured-error-framework.md`
**Status**: DRAFT
**Date**: 2026-03-25

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                                              | Rationale                                                                                                                                               | Alternatives Rejected                                                                            |
| ---- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| D-1  | Phase order: Foundation → Security → Middleware → Enforcement → Migration → Client    | Security fixes depend only on ErrorRegistry (Phase 1), not middleware. Enforcement before migration prevents regression accumulation.                   | Security after middleware (delays P0 fixes); Enforcement after migration (allows regression)     |
| D-2  | ErrorRegistry extends ErrorCodes (coexist)                                            | Zero consumer breakage — 152 ErrorCodes usages across 34 files remain unchanged. Additive only.                                                         | Replace ErrorCodes (breaks 152 consumers); Separate file (split source of truth)                 |
| D-3  | ServerMessages.error() overload for backward compat                                   | 60+ callsites across handler.ts/sdk-handler.ts. Overload allows incremental migration within 40-file commit limit.                                      | Direct signature change (60+ callsites in one commit); New function name (confusing dual API)    |
| D-4  | MongoErrorCode → ErrorRegistry via classifyDbError() function                         | Follows classifyLlmError pattern. No cross-package MongoAppError modifications. Database package untouched.                                             | Modify MongoAppError to extend AppError (circular dep risk); Add statusCode to MongoAppError     |
| D-5  | All 16 ToolErrorCodes in ErrorRegistry, coarser mapping for HTTP                      | AI agents need granularity for self-recovery. HTTP consumers get ~8 meaningful codes.                                                                   | Only 4 existing codes (agents lose self-recovery detail); All 16 exposed to HTTP (noise)         |
| D-6  | ErrorCatalog keys kept as-is, messageKey field provides mapping                       | Many-to-one relationship. Renaming would break guardrails, auth profiles, and other direct consumers.                                                   | Rename ErrorCatalog keys (breaks 62 consumers); Duplicate messages (divergence risk)             |
| D-7  | Fitness tests + lint hooks BEFORE route migration                                     | Enforcement during migration window prevents new inline errors from accumulating. Ratchet ceilings track progress.                                      | Enforcement after migration (Sisyphean — new inline errors added during multi-week migration)    |
| D-8  | Route migration grouped by domain, 2-4 files per commit                               | Domain grouping reduces context-switching. 3-4 files stays within 40-file commit limit.                                                                 | Single-file commits (too many commits); All-at-once (exceeds commit limits)                      |
| D-9  | Studio/Admin as separate phases, Studio builds parser → ErrorBadge → ErrorCard → Page | Admin is trivial (1-2 files). Studio has dependency chain. ErrorBadge simplest, ErrorPage least urgent.                                                 | Combined Studio+Admin phase (hides complexity difference)                                        |
| D-10 | i18n infrastructure in Phase 1, locale files deferred. English-only initial release.  | Locale resolution already exists in i18n package. Translations should not block ALPHA. G13 is a stretch goal.                                           | All locales upfront (blocks release on translation work)                                         |
| D-11 | asyncHandler is a simple try/catch → next(err) wrapper                                | Classification in global error handler per HLD. asyncHandler is ~10 lines. Separation of concerns.                                                      | asyncHandler does classification (mixes concerns, hard to test)                                  |
| D-12 | Global error handler checks res.headersSent before responding                         | Prevents double-response when partially migrated routes have both inline res.json() and thrown errors.                                                  | Assume all routes fully migrated (unsafe during incremental migration)                           |
| D-13 | Prometheus counter `runtime_error_total{code, category, source}` deferred             | Runtime does not currently have prom-client instrumented. Adding Prometheus requires new infrastructure. Will add when observability stack supports it. | Add prom-client now (unrelated infrastructure churn); Skip metric entirely (loses observability) |

### Key Interfaces & Types

```typescript
// packages/shared-kernel/src/errors.ts — NEW interface
export interface StructuredError {
  readonly code: string;
  readonly statusCode: number;
  readonly message: string;
  readonly retryable?: boolean;
}

// packages/shared-kernel/src/errors.ts — NEW registry type
export interface ErrorRegistryEntry {
  readonly code: string;
  readonly statusCode: number;
  readonly category: 'llm' | 'tool' | 'auth' | 'infra' | 'validation' | 'session' | 'deployment' | 'tenant';
  readonly retryable: boolean;
  readonly messageKey: string;
  readonly docsPath: string;
}

// packages/shared-kernel/src/errors.ts — ErrorRegistry (extends ErrorCodes)
export const ErrorRegistry = {
  NOT_FOUND: {
    ...ErrorCodes.NOT_FOUND,          // code: 'NOT_FOUND', statusCode: 404
    category: 'validation',
    retryable: false,
    messageKey: 'error.not_found',
    docsPath: '/errors/NOT_FOUND',
  },
  MODEL_RATE_LIMITED: {
    ...ErrorCodes.MODEL_RATE_LIMITED,  // code: 'MODEL_RATE_LIMITED', statusCode: 429
    category: 'llm',
    retryable: true,
    messageKey: 'error.model.rate_limited',
    docsPath: '/errors/MODEL_RATE_LIMITED',
  },
  // ... all 28 existing ErrorCodes + new codes
} as const satisfies Record<string, ErrorRegistryEntry>;

// apps/runtime/src/middleware/async-handler.ts — NEW
import type { Request, Response, NextFunction } from 'express';
export function asyncHandler(
  fn: (req: Request, res: Response, next: NextFunction) => Promise<unknown>,
) {
  return (req: Request, res: Response, next: NextFunction) => {
    Promise.resolve(fn(req, res, next)).catch(next);
  };
}

// Enhanced errorToResponse with duck-typing
export function errorToResponse(err: unknown): {
  statusCode: number;
  body: ReturnType<typeof toErrorResponse>;
} {
  // Case 1: AppError (instanceof — existing path)
  if (err instanceof AppError) {
    return { statusCode: err.statusCode, body: toErrorResponse(err.code, err.message) };
  }
  // Case 2: Duck-typed StructuredError (code + statusCode present)
  // Note: MongoAppError lacks statusCode entirely → this check safely fails, falls to Case 3.
  // ToolExecutionError.statusCode is optional → only duck-types when explicitly set.
  if (
    err != null &&
    typeof err === 'object' &&
    typeof (err as any).code === 'string' &&
    typeof (err as any).statusCode === 'number'
  ) {
    const se = err as StructuredError;
    // Validate statusCode is a valid HTTP error range (400-599), fallback to 500
    const statusCode = (se.statusCode >= 400 && se.statusCode < 600) ? se.statusCode : 500;
    return { statusCode, body: toErrorResponse(se.code, se.message) };
  }
  // Case 3: Fallback — unknown error
  const message = err instanceof Error ? err.message : String(err);
  return { statusCode: 500, body: toErrorResponse(ErrorCodes.INTERNAL_ERROR.code, message) };
}

// Enhanced ServerMessages.error() — single function with optional second param
// apps/runtime/src/websocket/events.ts (plain object, not class — no TS overloads)
// Also requires updating ServerMessage union in apps/runtime/src/types/index.ts:
//   error variant: { type: 'error'; message: string } → { type: 'error'; code: string; message: string }
error(codeOrMessage: string, message?: string): ServerMessage {
  if (message !== undefined) {
    return { type: 'error', code: codeOrMessage, message };
  }
  // Legacy single-arg path: code defaults to INTERNAL_ERROR
  return { type: 'error', code: 'INTERNAL_ERROR', message: codeOrMessage };
}

// classifyDbError — NEW function
// apps/runtime/src/services/classify-db-error.ts
export function classifyDbError(err: unknown): AppError {
  if (err instanceof MongoAppError) {
    const mapping: Record<MongoErrorCode, ErrorCodeEntry> = {
      DUPLICATE_KEY: ErrorCodes.CONFLICT,
      VALIDATION: ErrorCodes.BAD_REQUEST,
      TIMEOUT: ErrorCodes.SERVICE_UNAVAILABLE,
      NETWORK: ErrorCodes.SERVICE_UNAVAILABLE,
      WRITE_CONFLICT: ErrorCodes.CONFLICT,
      NOT_FOUND: ErrorCodes.NOT_FOUND,
      UNAUTHORIZED: ErrorCodes.INTERNAL_ERROR,
      SHARD_KEY_VIOLATION: ErrorCodes.INTERNAL_ERROR,
      DOCUMENT_TOO_LARGE: ErrorCodes.BAD_REQUEST,
      UNKNOWN: ErrorCodes.INTERNAL_ERROR,
    };
    const mapped = mapping[err.code] ?? ErrorCodes.INTERNAL_ERROR;
    return new AppError(err.message, { ...mapped, cause: err });
  }
  return new AppError(
    err instanceof Error ? err.message : String(err),
    { ...ErrorCodes.INTERNAL_ERROR, cause: err },
  );
}
```

### Module Boundaries

| Module                 | Responsibility                                                        | Depends On                                |
| ---------------------- | --------------------------------------------------------------------- | ----------------------------------------- |
| `shared-kernel/errors` | StructuredError interface, ErrorRegistry, ErrorCodes, errorToResponse | None                                      |
| `i18n/errors`          | ErrorCatalog message templates, formatErrorSync                       | None (own types)                          |
| `runtime/middleware`   | asyncHandler wrapper                                                  | Express types                             |
| `runtime/server`       | Global error handler (classification, traceId, TraceEvent)            | shared-kernel, shared-observability, i18n |
| `runtime/routes`       | Route handlers — throw AppError instead of inline res.json            | shared-kernel (ErrorCodes, AppError)      |
| `runtime/websocket`    | WS error standardization, .catch() fixes                              | shared-kernel, events.ts                  |
| `runtime/services/llm` | classifyLlmError (existing, extended)                                 | shared-kernel (ErrorCodes, AppError)      |
| `runtime/services/db`  | classifyDbError (new)                                                 | shared-kernel, database (MongoAppError)   |
| `studio/lib`           | Error response parser, sanitize-error update                          | None (client-side)                        |
| `studio/components`    | ErrorCard, ErrorBadge, ErrorPage                                      | Studio design system                      |
| `admin/lib`            | Error response parser update                                          | None (client-side)                        |
| `shared-kernel/tests`  | Architecture fitness ratchets                                         | Codebase scanning (fs)                    |
| `.claude/hooks`        | PreToolUse lint hooks for error shape enforcement                     | Bash, grep patterns                       |

---

## 2. File-Level Change Map

### New Files

| File                                                                        | Purpose                                                        | LOC Estimate |
| --------------------------------------------------------------------------- | -------------------------------------------------------------- | ------------ |
| `apps/runtime/src/middleware/async-handler.ts`                              | asyncHandler Express wrapper                                   | 15           |
| `apps/runtime/src/services/classify-db-error.ts`                            | MongoAppError → ErrorRegistry classifier                       | 45           |
| `.claude/hooks/error-response-shape-lint.sh`                                | Blocks Shape A `res.json({ error: 'string' })`                 | 30           |
| `.claude/hooks/error-response-flat-lint.sh`                                 | Blocks Shape B `res.json({ success: false, error: 'string' })` | 30           |
| `apps/studio/src/components/chat/ErrorCard.tsx`                             | Chat error card with code badge                                | 80           |
| `apps/studio/src/components/ui/ErrorBadge.tsx`                              | Inline error code badge component                              | 40           |
| `apps/studio/src/components/error/ErrorPage.tsx`                            | Full-page error display                                        | 60           |
| `apps/runtime/src/__tests__/async-handler.test.ts`                          | Unit: asyncHandler wrapper (UT-4)                              | 60           |
| `apps/runtime/src/__tests__/error-response-shape.e2e.test.ts`               | E2E: standard shape via HTTP (E2E-1–4, E2E-7, E2E-8, E2E-10)   | 250          |
| `apps/runtime/src/__tests__/error-ws-shape.e2e.test.ts`                     | E2E: WS structured errors (E2E-5)                              | 120          |
| `apps/runtime/src/__tests__/error-tool-codes.e2e.test.ts`                   | E2E: tool error codes for AI agents (E2E-6)                    | 120          |
| `apps/runtime/src/__tests__/error-security.e2e.test.ts`                     | E2E: information leak tests (E2E-9, SEC-1–7)                   | 200          |
| `apps/runtime/src/__tests__/integration/error-async-handler.test.ts`        | Integration: asyncHandler → global handler (INT-1)             | 100          |
| `apps/runtime/src/__tests__/integration/error-trace-events.test.ts`         | Integration: TraceEvent emission (INT-3, INT-6)                | 120          |
| `apps/runtime/src/__tests__/integration/error-registry-consistency.test.ts` | Integration: ErrorRegistry ↔ ErrorCatalog (INT-4)              | 80           |
| `apps/runtime/src/__tests__/integration/error-duck-typing.test.ts`          | Integration: errorToResponse duck-typing (INT-2)               | 100          |
| `apps/runtime/src/__tests__/integration/error-global-handler.test.ts`       | Integration: traceId injection (INT-6)                         | 80           |
| `apps/runtime/src/__tests__/integration/error-ws-concurrent.test.ts`        | Integration: WS concurrent error handling (INT-7)              | 120          |
| `apps/runtime/src/__tests__/integration/error-tool-results.test.ts`         | Integration: tool failure results (INT-8)                      | 100          |
| `apps/runtime/src/__tests__/integration/error-catch-remediation.test.ts`    | Integration: empty catch remediation (INT-9)                   | 80           |
| `apps/runtime/src/__tests__/integration/error-logger-migration.test.ts`     | Integration: console.\* → createLogger (INT-10)                | 80           |

### Modified Files

| File                                                                | Change Description                                                                                              | Risk   |
| ------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ------ |
| `packages/shared-kernel/src/errors.ts`                              | Add StructuredError interface, ErrorRegistryEntry type, ErrorRegistry, enhance errorToResponse with duck-typing | Medium |
| `packages/i18n/src/errors.ts`                                       | Add new ErrorCatalog message templates for all ErrorRegistry codes                                              | Low    |
| `apps/runtime/src/server.ts`                                        | Enhance global error handler: traceId, requestId, TraceEvent emission, res.headersSent check                    | High   |
| `apps/runtime/src/websocket/events.ts`                              | Add optional `code` param to ServerMessages.error() with backward-compat legacy path                            | Medium |
| `apps/runtime/src/types/index.ts`                                   | Update ServerMessage union — error variant gains `code: string` field                                           | Medium |
| `apps/runtime/src/websocket/handler.ts`                             | Add .catch() to 3 async handlers, migrate ~48 error sends incrementally                                         | High   |
| `apps/runtime/src/websocket/sdk-handler.ts`                         | Replace ~12 inline `{ type: 'error', message }` with ServerMessages.error()                                     | Medium |
| `apps/runtime/src/services/llm/classify-llm-error.ts`               | Extend with MODEL_NOT_CONFIGURED, CREDENTIAL_DECRYPTION paths                                                   | Low    |
| `packages/shared-kernel/src/utils/errors.ts`                        | Align ToolExecutionError: ensure code/statusCode/retryable match ErrorRegistry                                  | Medium |
| `packages/shared-kernel/src/__tests__/errors.test.ts`               | Add ErrorRegistry consistency tests, duck-typing tests                                                          | Low    |
| `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts` | Add 3 new ratchet metrics: error shape count, AppError adoption, empty catches                                  | Low    |
| `apps/runtime/src/routes/*.ts` (94 files)                           | Replace inline res.json error responses with throw AppError, wrap in asyncHandler                               | High   |
| `apps/runtime/src/routes/kms-admin.ts`                              | P0: Fix information leak — stop sending raw error + tenantId                                                    | Medium |
| `apps/runtime/src/routes/clickhouse-diagnostics.ts`                 | P0: Sanitize ClickHouse errors                                                                                  | Medium |
| `apps/runtime/src/routes/channel-oauth.ts`                          | P0: Sanitize raw error.message in OAuth callback                                                                | Medium |
| `apps/runtime/src/routes/chat.ts`                                   | P0: Sanitize raw LLM provider errors                                                                            | Medium |
| `apps/studio/src/lib/sanitize-error.ts`                             | Update to handle `{ code, message }` object shape                                                               | Medium |
| `apps/studio/src/components/ui/ErrorBoundary.tsx`                   | Extract error code if available from structured errors                                                          | Low    |
| `.claude/settings.json`                                             | Register new PreToolUse hooks                                                                                   | Low    |

### Deleted Files

None — all changes are additive per CLAUDE.md commit discipline.

---

## 3. Implementation Phases

### Phase Mapping (LLD ↔ HLD ↔ Feature Spec)

| LLD Phase                             | HLD Phase                                 | Feature Spec Delivery Groups                           | Notes                                                                             |
| ------------------------------------- | ----------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------- |
| Phase 1: Foundation                   | Phase 1: Foundation                       | Groups 1 (ErrorRegistry), 8 (i18n infra)               | i18n locale files deferred (D-10)                                                 |
| Phase 2: Security P0                  | Phase 1: Foundation (security subset)     | Group 3 (Security fixes)                               | Elevated to own phase per D-1                                                     |
| Phase 3: Middleware & WS              | Phase 2: Middleware                       | Groups 4 (asyncHandler, WS), 5 (WS standardization)    | Task 1.5 (classify LLM extensions) deferred to Phase 7 — see deviation note below |
| Phase 4: Enforcement                  | Phase 3: Enforcement                      | Group 9 (fitness), Group 10 (hooks)                    | Must complete BEFORE route migration                                              |
| Phase 5: Route Migration              | Phase 4: Route migration                  | Group 6 (HTTP migration), Group 7 (console.log subset) | ~25 batches, 2-4 files each                                                       |
| Phase 6: Client-Side                  | Phase 5: Client-side                      | Group 11 (Studio/Admin)                                | Studio builds parser → ErrorBadge → ErrorCard → ErrorPage                         |
| Phase 7: Classifiers + Tool Alignment | Phase 2: Middleware (classifier subset)   | Group 2 (classifiers), Group 1.5 (classify extensions) | Feature spec task 1.5 lands here, not Phase 3                                     |
| Phase 8: Console.log + Docs           | Phase 4: Route migration (cleanup subset) | Group 7 (console.log), Group 11 (error docs)           | Error docs endpoint is new (not in HLD)                                           |

**Deviation note — Feature spec task 1.5**: The feature spec places `classifyLlmError` extension (MODEL_NOT_CONFIGURED, CREDENTIAL_DECRYPTION) in delivery group 1 alongside the foundation. This LLD defers it to Phase 7 because: (a) Phase 1 focuses on shared-kernel types only, (b) the classify extensions depend on runtime code patterns that are clearer after middleware/WS work is complete, and (c) grouping all classifier work in one phase reduces context-switching.

**WS handler count note**: Feature spec delivery task 4.1 references "11 unhandled async handlers" across handler.ts and sdk-handler.ts. This LLD's Phase 3 task 3.4 addresses 3 confirmed handlers in handler.ts (handleSendMessage, handleRunTest, handleSubscribeSession). The remaining 8 will be identified and fixed during Phase 3 implementation by auditing the full switch-case blocks in both handler.ts and sdk-handler.ts. The 11-count was from the feature spec's static analysis — implementation will verify exact count.

### Phase 1: Foundation (shared-kernel + i18n)

**Goal**: Establish the StructuredError interface, ErrorRegistry, and enhanced errorToResponse with duck-typing. Add missing ErrorCatalog message templates.

**Tasks**:

1.1. Add `StructuredError` interface to `packages/shared-kernel/src/errors.ts` — readonly `code: string`, `statusCode: number`, `message: string`, optional `retryable?: boolean`

1.2. Add `ErrorRegistryEntry` type and `ErrorRegistry` constant to `packages/shared-kernel/src/errors.ts` — extends each `ErrorCodes` entry with `category`, `retryable`, `messageKey`, `docsPath`. Must include all 28 existing ErrorCodes entries plus new tool/auth/db codes (~40 total entries).

1.3. Enhance `errorToResponse()` in `packages/shared-kernel/src/errors.ts` — add duck-typing check for `StructuredError` (check `typeof err.code === 'string' && typeof err.statusCode === 'number'`) as a second case between the `instanceof AppError` check and the fallback. Add statusCode range validation (400-599, fallback to 500) to prevent arbitrary status code injection. Existing AppError path unchanged. **Safety note**: `MongoAppError` lacks `statusCode` entirely — the duck-type check safely fails (`typeof undefined !== 'number'`), falling to the 500 fallback. This must have an explicit test case.

1.4. Add new error message templates to `packages/i18n/src/errors.ts` ErrorCatalog — one entry per ErrorRegistry code that doesn't already have a template. Use ICU MessageFormat with named parameters. English only.

1.5. Add unit tests: ErrorRegistry contains all ErrorCodes entries (UT-1 subset), errorToResponse duck-types StructuredError correctly (INT-2 subset), ErrorRegistry → ErrorCatalog messageKey consistency (INT-4). **Must include**: test that MongoAppError (no statusCode) falls through to 500 fallback, test that invalid statusCode (e.g., 0, 200) is clamped to 500.

**Files Touched**:

- `packages/shared-kernel/src/errors.ts` — add StructuredError, ErrorRegistryEntry, ErrorRegistry, enhance errorToResponse
- `packages/i18n/src/errors.ts` — add ~15 new ErrorCatalog entries
- `packages/shared-kernel/src/__tests__/errors.test.ts` — add registry consistency + duck-typing tests

**Exit Criteria**:

- [ ] `StructuredError` interface exported from `@agent-platform/shared-kernel`
- [ ] `ErrorRegistry` contains all 28 ErrorCodes entries plus new tool/auth/db codes
- [ ] `errorToResponse()` handles: AppError (instanceof), StructuredError (duck-typed with statusCode 400-599 validation), unknown (fallback 500)
- [ ] **Known gap**: ToolExecutionError duck-typing will produce INTERNAL_ERROR (500) until Phase 7 aligns statusCode. This is acceptable — tool errors reach AI agents via tool results, not HTTP responses.
- [ ] Every ErrorRegistry entry has a valid `messageKey` that exists in ErrorCatalog
- [ ] `pnpm build --filter=@agent-platform/shared-kernel --filter=@agent-platform/i18n` succeeds with 0 errors
- [ ] All new and existing errors.test.ts tests pass

**Test Strategy**:

- Unit: ErrorRegistry type compliance, errorToResponse duck-typing branches, ErrorCatalog messageKey resolution
- Integration: ErrorRegistry ↔ ErrorCatalog consistency (INT-4 from test spec)

**Rollback**: Revert the shared-kernel commit. ErrorRegistry is additive — removing it breaks nothing. errorToResponse enhancement is backward-compatible (existing instanceof path is first).

---

### Phase 2: Security Fixes (P0)

**Goal**: Eliminate the 6 identified information leaks. Each fix uses ErrorCodes from Phase 1 to provide proper error codes instead of raw errors.

**Tasks**:

2.1. Fix `kms-admin.ts` — replace `res.status(500).json({ error: '...', detail: matErr.message, tenantId, configSaved, configActive })` (line ~125-131) with `throw new AppError('KMS operation failed', ErrorCodes.INTERNAL_ERROR)`. Remove tenantId AND raw error `detail` field from response. Log original error with tenantId server-side only.

2.2. Fix `clickhouse-diagnostics.ts` — replace raw ClickHouse error messages with `throw new AppError('Diagnostics query failed', ErrorCodes.INTERNAL_ERROR)`. Log original error server-side.

2.3. Fix `channel-oauth.ts` — replace `res.status(500).json({ error: error.message })` with `throw new AppError('OAuth callback failed', ErrorCodes.INTERNAL_ERROR)`. Sanitize provider-specific error details.

2.4. Fix `chat.ts` — replace raw LLM provider error messages in response body with classified error codes. Ensure `classifyLlmError()` is used for all LLM error paths, not just the main completion path.

2.5. Write security regression tests (SEC-1 through SEC-4) — each test asserts the response does NOT contain raw error messages, stack traces, tenantIds, or internal URLs. **Note**: SEC-5 (stack trace leaks), SEC-6 (cross-project isolation), and SEC-7 (cross-user session isolation) are written after Phase 5 route migration provides the full test surface — they are included in `error-security.e2e.test.ts` but may be marked `skip` until routes are migrated.

**Files Touched**:

- `apps/runtime/src/routes/kms-admin.ts` — sanitize error response
- `apps/runtime/src/routes/clickhouse-diagnostics.ts` — sanitize error response
- `apps/runtime/src/routes/channel-oauth.ts` — sanitize error response
- `apps/runtime/src/routes/chat.ts` — use classifyLlmError for all LLM error paths
- `apps/runtime/src/__tests__/error-security.e2e.test.ts` — NEW: security regression tests (SEC-1–4)

**Exit Criteria**:

- [ ] No route in the 4 fixed files sends raw error.message, err.stack, or tenantId to clients
- [ ] All error responses from fixed files use ErrorCodes entries
- [ ] SEC-1 through SEC-4 security tests pass
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds

**Test Strategy**:

- E2E: Real HTTP requests to each fixed endpoint, assert response body does NOT contain sensitive fields (SEC-1 through SEC-4)
- Manual: Semgrep scan on fixed files (`./tools/run-semgrep.sh`)

**Rollback**: `git revert` individual file fix commits. Each fix is independent.

---

### Phase 3: Middleware & WebSocket Handlers

**Goal**: Create asyncHandler wrapper, enhance global error handler with traceId/requestId/TraceEvent emission, fix unhandled WS rejections, and add ServerMessages.error() overload.

**Tasks**:

3.1. Create `apps/runtime/src/middleware/async-handler.ts` — simple `Promise.resolve(fn(req, res, next)).catch(next)` wrapper. Export `asyncHandler` function.

3.2. Enhance global error handler in `apps/runtime/src/server.ts:907-911`:

- Import `getCurrentTraceId` from `@abl/compiler/platform/observability` (for traceId extraction)
- Import `getCurrentRequestId` from `@agent-platform/shared-observability/middleware/request-id` (for requestId extraction — note: different package than traceId)
- Check existing `sendWithTrace` pattern at `apps/runtime/src/middleware/trace-response.ts` — reuse if it already injects traceId into responses. If not directly reusable (it may be response-level, not error-level), extract the traceId injection logic into a shared helper.
- Add `res.headersSent` guard before sending response
- Inject `traceId` (from getCurrentTraceId, may be undefined — omit from response if undefined) and `requestId` (from getCurrentRequestId or req.id) into response body
- Emit TraceEvent via the existing `TraceStore` instance (access via the request-scoped trace context, same pattern used in `handler.ts` WS code). TraceEvent data: `{ errorCode, errorMessage, errorCategory, errorRetryable, errorSource }`. Note: sessionId may not be available in all error paths — emit with whatever context is available.
- Log with structured context: `{ errorCode, tenantId, requestId, traceId }`

  3.3. Add optional `code` parameter to `ServerMessages.error()` in `apps/runtime/src/websocket/events.ts:238-240` — single function with optional second param (not TS overload — ServerMessages is a plain object, not a class). Update `ServerMessage` union in `apps/runtime/src/types/index.ts:259` — error variant gains `code: string` field. Backward-compatible: `error(message)` defaults code to `'INTERNAL_ERROR'`, `error(code, message)` uses provided code.

  3.3b. Migrate the 404 catch-all handler at `server.ts:897-903` to use the standard error shape: `res.status(404).json(toErrorResponse('NOT_FOUND', 'The requested resource was not found'))` instead of bare `{ error: 'Not found' }`.

  3.4. Add `.catch()` to all unhandled async WS handlers in `apps/runtime/src/websocket/handler.ts`. The 3 confirmed async functions without `.catch()`: `handleSendMessage` (line 1250), `handleRunTest` (line 1258), `handleSubscribeSession` (line 1266). Audit the full switch-case block (lines 1239-1344) for any additional async calls without `.catch()`. Each `.catch()` sends `ServerMessages.error()` and logs the error.

  3.4b. Fix missing `decrementActiveSessions()` call in WS error handler disconnect/error path — currently only called on clean close, not on error-initiated disconnects. This is a session count leak bug (feature spec delivery task 4.2).

  3.4c. Add debug logging to empty catch blocks in critical paths (FR-14): `session-service.ts` encryption catch, `session-lock.ts` Redis lock catch, `inbound-worker.ts` dedup catch, `handler.ts` cross-pod delivery catch. Add `logger.debug('Silent failure in ...', { error })` — maintain existing fail-open/fail-safe behavior.

  3.4d. WS error standardization (feature spec delivery tasks 5.1-5.3): (a) Audit and remove `response_end` messages that disguise errors. (b) Extend `isLlmError` checks in handler.ts/sdk-handler.ts to handle all AppError codes, not just LLM-related ones. (c) Replace raw `ws.send(JSON.stringify(...))` calls with the `send()` helper throughout handler.ts and sdk-handler.ts.

  3.5. Write asyncHandler unit tests (UT-2) and global error handler integration tests (INT-1, INT-6). **Note**: Prometheus counter `runtime_error_total{code, category, source}` is deferred — runtime does not currently have prom-client instrumented. Will be added when observability infrastructure supports it.

**Files Touched**:

- `apps/runtime/src/middleware/async-handler.ts` — NEW
- `apps/runtime/src/server.ts` — enhance global error handler + 404 catch-all
- `apps/runtime/src/websocket/events.ts` — add optional code param to error()
- `apps/runtime/src/types/index.ts` — update ServerMessage union error variant
- `apps/runtime/src/websocket/handler.ts` — add .catch() to 3 async handlers
- `apps/runtime/src/__tests__/async-handler.test.ts` — NEW: UT-2
- `apps/runtime/src/__tests__/integration/error-async-handler.test.ts` — NEW: INT-1

**Exit Criteria**:

- [ ] `asyncHandler` exported from `apps/runtime/src/middleware/async-handler.ts`
- [ ] Global error handler injects `traceId` (non-empty string) and `requestId` into error responses
- [ ] Global error handler checks `res.headersSent` before responding
- [ ] Global error handler emits TraceEvent with `errorCode` in data
- [ ] `ServerMessages.error('msg')` returns `{ type: 'error', code: 'INTERNAL_ERROR', message: 'msg' }`
- [ ] `ServerMessages.error('NOT_FOUND', 'msg')` returns `{ type: 'error', code: 'NOT_FOUND', message: 'msg' }`
- [ ] 3 async WS handlers have `.catch()` — no unhandled promise rejections from `handleSendMessage`, `handleRunTest`, `handleSubscribeSession`
- [ ] asyncHandler UT-2 tests pass (catches sync throw, async rejection, passes through success)
- [ ] INT-1 integration test passes (asyncHandler → global handler → standard response shape)
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds

**Test Strategy**:

- Unit: asyncHandler catches AppError, generic Error, and passes successful responses through (UT-2)
- Integration: HTTP request → asyncHandler → thrown AppError → global handler → `{ success: false, error: { code, message }, traceId, requestId }` (INT-1)
- Integration: TraceEvent emission with errorCode after classified error (INT-6)

**Rollback**: Remove asyncHandler file. Revert server.ts error handler. Revert events.ts overload. Each is independently revertable.

---

### Phase 4: Enforcement (Fitness Tests + Lint Hooks)

**Goal**: Establish architecture fitness test ratchets and PreToolUse lint hooks BEFORE route migration begins, so progress is measurable and new violations are blocked.

**Tasks**:

4.1. Add "non-standard error response shape count" ratchet to `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts` — scan `apps/runtime/src/routes/*.ts` for patterns: `res.json({ error:` (Shape A), `res.json({ success: false, error:` where error is a string (Shape B). Set ceiling to current count.

4.2. Add "route files with asyncHandler usage" ratchet — scan `apps/runtime/src/routes/*.ts` for `asyncHandler(` import/usage. Set floor to 0 (current baseline). Floor increases as routes are migrated.

4.3. Add "empty catch blocks in server code" ratchet — scan `apps/runtime/src/**/*.ts` for `catch` blocks with empty body or only comments. Set ceiling to current count.

4.4. Create `.claude/hooks/error-response-shape-lint.sh` — PreToolUse hook that blocks new `res.status(N).json({ error:` patterns (Shape A — no success field) in route files.

4.5. Create `.claude/hooks/error-response-flat-lint.sh` — PreToolUse hook that blocks new `res.json({ success: false, error:` patterns where error value is a string literal (Shape B).

4.6. Register new hooks in `.claude/settings.json` under PreToolUse for Write and Edit tools.

4.7. Update existing `.claude/hooks/empty-response-lint.sh` to additionally block error objects without a `code` field (e.g., `res.json({ success: false, error: { message: '...' } })` missing `code`).

**Files Touched**:

- `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts` — 3 new ratchet tests
- `.claude/hooks/error-response-shape-lint.sh` — NEW
- `.claude/hooks/error-response-flat-lint.sh` — NEW
- `.claude/settings.json` — register new hooks

**Exit Criteria**:

- [ ] Architecture fitness test "non-standard error shape count" passes with ceiling = current count (measure exact baseline)
- [ ] Architecture fitness test "asyncHandler adoption" passes with floor = 0
- [ ] Architecture fitness test "empty catch blocks" passes with ceiling = current count
- [ ] PreToolUse hook blocks `res.json({ error: 'some string' })` in route files (manual verification)
- [ ] PreToolUse hook blocks `res.json({ success: false, error: 'some string' })` in route files
- [ ] `pnpm build --filter=@agent-platform/shared-kernel && pnpm test --filter=@agent-platform/shared-kernel` succeeds

**Test Strategy**:

- Fitness: Run architecture fitness tests, verify ceilings match current codebase counts
- Manual: Write a test route with inline `res.json({ error: 'test' })`, verify hook blocks the write

**Rollback**: Remove ratchet tests (they are additive). Remove hook files and settings entries.

---

### Phase 5: Route Migration (Incremental, ~25 commits)

**Goal**: Migrate all 668 inline error responses across 94 route files to use `asyncHandler` + `throw new AppError(...)`. Tighten ratchet ceilings with each batch.

**Tasks**:

5.1. **Batch 1 — External channel routes** (5 files): `http-async-channel.ts`, `channel-webhooks.ts`, `channel-audiocodes.ts`, `channel-genesys.ts`, `channel-vxml.ts`. Wrap handlers in `asyncHandler`. Replace `res.status(N).json({ error: '...' })` with `throw new AppError('...', ErrorCodes.XXX)`.

5.2. **Batch 2 — Auth + SDK routes** (4 files): `auth.ts`, `sdk.ts`, `sdk-init.ts`, `device-auth.ts`.

5.3. **Batch 3 — Session + chat routes** (3 files): `sessions.ts`, `chat.ts`, `callbacks.ts`. Highest traffic — most important E2E coverage.

5.4. **Batch 4 — Deployment + agent routes** (4 files): `deployments.ts`, `agents.ts`, `project-agents.ts`, `versions.ts`.

5.5. **Batch 5 — Platform admin routes** (8 files): All `platform-admin-*.ts` files.

5.6. **Batch 6 — Model + LLM config routes** (4 files): `tenant-models.ts`, `agent-model-config.ts`, `model-catalog.ts`, `model-capabilities.ts`.

5.7. **Batch 7 — Voice routes** (3 files): `voice.ts`, `voice-analytics.ts`, `livekit.ts`.

5.8. **Batches 8-12 — Remaining routes** (~63 files): Group by domain in batches of 3-5 files. Lower ratchet ceiling after each batch.

5.9. **Replace `catch (error: any)` patterns** — across all migrated files, replace `catch (error: any)` with proper type narrowing: `catch (error: unknown)` + `err instanceof Error ? err.message : String(err)`.

5.10. **Tighten ratchet ceilings** — after each batch, update the architecture fitness test ceiling to reflect the new lower count. Final target: ceiling = 0.

**Files Touched**:

- `apps/runtime/src/routes/*.ts` — 94 route files (2-5 per commit batch)
- `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts` — ceiling updates per batch

**Exit Criteria**:

- [ ] Zero inline `res.status(N).json({ error: 'string' })` patterns in route files (architecture fitness ceiling = 0)
- [ ] All 94 route files import and use `asyncHandler` (architecture fitness floor = 94)
- [ ] All error responses match `{ success: false, error: { code, message } }` shape
- [ ] Zero `catch (error: any)` patterns — all use `catch (error: unknown)` with proper narrowing
- [ ] E2E-1 through E2E-6 pass (LLM rate limit, invalid credentials, validation, cross-tenant, WS, tool timeout)
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds after each batch
- [ ] No regressions in existing tests (full `pnpm test` after final batch)

**Test Strategy**:

- E2E: Write E2E-1 through E2E-6 after batch 3 (session/chat routes provide the test surface)
- Integration: INT-3 (TraceEvent emitted with errorCode on classified error) verified after batch 1
- Fitness: Ratchet ceilings verified after each batch commit. Per-batch exit: architecture fitness ceiling decremented by the count of migrated error responses in that batch.
- Performance: PERF-1 (error classification benchmark <1ms) verified after Phase 5 completes

**Rollback**: Per-batch `git revert`. Removing asyncHandler from a route restores inline error handling. The global error handler handles both paths safely (res.headersSent check).

**Note on voice routes (GAP-007)**: Batch 7 covers `voice.ts`, `voice-analytics.ts`, `livekit.ts`. These use AudioCodes/Twilio/KoreVG-specific error handling. The approach is to map voice-specific errors to generic ErrorRegistry codes (`SERVICE_UNAVAILABLE` for telephony failures, `BAD_REQUEST` for malformed voice payloads). If voice errors need more granularity, add voice-specific codes (`VOICE_TELEPHONY_ERROR`, `VOICE_TRANSCRIPTION_FAILED`) to the ErrorRegistry during implementation.

---

### Phase 6: Client-Side (Studio + Admin)

**Goal**: Update Studio and Admin error parsers for the new `{ code, message }` error shape. Add Studio ErrorCard, ErrorBadge, and ErrorPage components.

**Tasks**:

6.1. Update `apps/studio/src/lib/sanitize-error.ts` — handle `error` as `{ code, message }` object (breaking change from string). Pass through error codes for display. Maintain sanitization of unknown error shapes.

6.2. Update Studio WS error handler to parse `{ type: 'error', code, message }` instead of `{ type: 'error', message }`.

6.3. Create `apps/studio/src/components/ui/ErrorBadge.tsx` — inline error code badge component. Displays code as a styled tag (e.g., `MODEL_RATE_LIMITED`). Uses design tokens.

6.4. Create `apps/studio/src/components/chat/ErrorCard.tsx` — contextual error card for chat. Shows code badge + human-readable message + retry suggestion if retryable. Categorizes by error category (llm, tool, auth, etc.) for contextual styling.

6.5. Create `apps/studio/src/components/error/ErrorPage.tsx` — full-page error display for fatal errors. Shows error code, message, and traceId for support reference.

6.6. Update `apps/studio/src/components/ui/ErrorBoundary.tsx` — extract error code from structured errors if available. Pass to ErrorPage.

6.7. Update Admin error response parser — update `apps/admin/src/hooks/use-swr-fetch.ts` and API route handlers in `apps/admin/src/app/api/` to handle `error` as `{ code, message }` object instead of flat string.

**Files Touched**:

- `apps/studio/src/lib/sanitize-error.ts` — parse new error shape
- `apps/studio/src/components/ui/ErrorBadge.tsx` — NEW
- `apps/studio/src/components/chat/ErrorCard.tsx` — NEW
- `apps/studio/src/components/error/ErrorPage.tsx` — NEW
- `apps/studio/src/components/ui/ErrorBoundary.tsx` — extract error code
- `apps/admin/src/hooks/use-swr-fetch.ts` — error parser update
- `apps/admin/src/app/api/` — API route handler error parsing

**Exit Criteria**:

- [ ] Studio parses HTTP error responses as `{ success: false, error: { code, message } }` — no string assumption
- [ ] Studio parses WS errors as `{ type: 'error', code, message }`
- [ ] ErrorBadge renders error code as styled tag
- [ ] ErrorCard renders in chat with code badge + message + retry hint
- [ ] ErrorPage renders full-page error with code and traceId
- [ ] Admin parses error responses as `{ code, message }` objects
- [ ] `pnpm build --filter=@agent-platform/studio --filter=@agent-platform/admin` succeeds

**Test Strategy**:

- Unit: ErrorBadge renders code text, ErrorCard renders code + message, sanitize-error handles object shape
- Integration: Studio WS handler receives `{ type: 'error', code, message }` and renders ErrorCard

**Rollback**: Revert Studio error parser to expect string. Remove new components. Revert Admin parser. Each app is independently revertable.

---

### Phase 7: Error Classifier Extensions + Tool Error Alignment

**Goal**: Wire unused ErrorCodes into the execution chain, extend classifyLlmError, align ToolExecutionError with ErrorRegistry, and update tool result formatting.

**Tasks**:

7.1. Extend `apps/runtime/src/services/llm/classify-llm-error.ts` — add classification paths for `MODEL_NOT_CONFIGURED` (model chain resolution fails) and `CREDENTIAL_DECRYPTION` (KMS decryption fails). Add corresponding test cases to `classify-llm-error.test.ts`.

7.2. Create `apps/runtime/src/services/classify-db-error.ts` — `classifyDbError(err: unknown): AppError` function mapping MongoAppError codes to ErrorRegistry codes per D-4 mapping table. Import in global error handler.

7.3. Wire `TOOL_BINDING_FAILED`, `EXECUTION_TIMEOUT`, `HANDOFF_TARGET_MISSING`, `FLOW_STEP_ERROR` into the execution chain — find the code paths in `reasoning-executor.ts`, `tool-executor-adapter.ts`, and `flow-step-executor.ts` where these errors actually occur but are currently thrown as generic Error or untyped exceptions. Replace with `throw new AppError('...', ErrorCodes.XXX)`. (Note: verify exact file paths under `apps/runtime/src/services/execution/` at implementation time.)

7.4. Align `ToolExecutionError` in `packages/shared-kernel/src/utils/errors.ts` — ensure every `ToolErrorCode` value has a corresponding entry in `ErrorRegistry`. Add `statusCode` default (500) if not set. Ensure `retryable` is explicit (not undefined).

7.5. Update tool call failure result formatting in `reasoning-executor.ts` — when a tool returns `is_error: true`, include `{ code, message, retryable }` in the content text. This enables AI agents to parse error codes for self-recovery.

**Files Touched**:

- `apps/runtime/src/services/llm/classify-llm-error.ts` — add MODEL_NOT_CONFIGURED, CREDENTIAL_DECRYPTION
- `apps/runtime/src/services/classify-db-error.ts` — NEW
- `apps/runtime/src/services/execution/reasoning-executor.ts` — tool result error formatting
- `packages/shared-kernel/src/utils/errors.ts` — ToolExecutionError alignment
- `apps/runtime/src/__tests__/classify-llm-error.test.ts` — new classification tests

**Exit Criteria**:

- [ ] `classifyLlmError` handles MODEL_NOT_CONFIGURED and CREDENTIAL_DECRYPTION paths
- [ ] `classifyDbError` maps all 10 MongoErrorCodes to ErrorRegistry codes
- [ ] TOOL_BINDING_FAILED, EXECUTION_TIMEOUT, HANDOFF_TARGET_MISSING, FLOW_STEP_ERROR are thrown as AppError in execution chain
- [ ] Tool call failure results include `{ code, message, retryable }` for AI agent consumption
- [ ] All 16 ToolErrorCodes have corresponding ErrorRegistry entries
- [ ] Existing classify-llm-error tests still pass + 4 new test cases pass
- [ ] `pnpm build --filter=@agent-platform/shared-kernel --filter=@agent-platform/runtime` succeeds

**Test Strategy**:

- Unit: classifyLlmError new branches, classifyDbError mapping, ToolExecutionError alignment
- Integration: Tool failure → AI agent receives `{ code, message, retryable }` (INT-8 from test spec, not INT-5)
- E2E: E2E-6 (tool execution timeout returns retryable error)
- Performance: PERF-2 (concurrent WS error stress test) — 10 clients, 50 messages each

**Rollback**: Revert classifier files. Revert ToolExecutionError changes. Each is independent.

---

### Phase 8: Console.log Migration + Error Documentation Endpoint

**Goal**: Replace all console.\* in server code with structured createLogger calls. Add error documentation endpoint.

**Tasks**:

8.1. Replace `console.*` in `trace-store.ts` (11 instances) with `createLogger('trace-store')`.

8.2. Replace `console.*` in `clickhouse-audit-store.ts` (2 instances), `agent-registry-adapter.ts` (4 instances), `redis-client.ts` (3 instances), `dsl-utils.ts` (2 instances).

8.3. Replace `console.*` in route files: `sessions.ts` (13), `device-auth.ts` (4), `agents.ts` (2), `contact-merge.ts` (3), `merge-suggestions.ts` (2), `auth.ts` (1).

8.4. Add `GET /api/v1/errors` endpoint returning all ErrorRegistry entries with categories and docs links. Use `createUnifiedAuthMiddleware` with viewer role — error docs are developer reference, not public API.

8.5. Add `GET /api/v1/errors/:code` endpoint returning details for a specific error code. Validate `:code` param with `z.string().min(1).regex(/^[A-Z_]+$/)`. Return 404 for unknown codes.

8.6. Tighten `console.log in server packages` ratchet ceiling in architecture fitness test.

**Files Touched**:

- `apps/runtime/src/services/trace-store.ts` — replace console.\*
- `apps/runtime/src/services/stores/clickhouse-audit-store.ts` — replace console.\*
- `apps/runtime/src/services/adapters/agent-registry-adapter.ts` — replace console.\*
- `apps/runtime/src/services/redis/redis-client.ts` — replace console.\*
- `apps/runtime/src/services/dsl-utils.ts` — replace console.\*
- `apps/runtime/src/routes/sessions.ts`, `device-auth.ts`, `agents.ts`, `contact-merge.ts`, `merge-suggestions.ts`, `auth.ts` — replace console.\*
- `apps/runtime/src/routes/errors.ts` — NEW: error documentation endpoint
- `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts` — tighten console.log ceiling

**Exit Criteria**:

- [ ] Zero `console.error`/`console.warn`/`console.log` in files touched (verified by console-log-lint.sh hook)
- [ ] `GET /api/v1/errors` returns all ErrorRegistry entries as JSON array
- [ ] `GET /api/v1/errors/:code` returns single entry or 404
- [ ] Architecture fitness `console.log` ceiling decreased by count of replacements
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds

**Test Strategy**:

- Integration: GET /api/v1/errors returns all codes, GET /api/v1/errors/NOT_FOUND returns entry with correct statusCode
- Integration: INT-10 (console.\* replaced with createLogger — verify structured log output)
- Fitness: console.log ceiling verified

**Rollback**: Revert individual file console.\* replacement commits. Remove errors.ts route.

---

## 4. Wiring Checklist

- [x] ErrorRegistry exported from `packages/shared-kernel/src/errors.ts` index
- [x] StructuredError interface exported from `packages/shared-kernel/src/errors.ts` index
- [ ] asyncHandler exported from `apps/runtime/src/middleware/async-handler.ts`
- [ ] asyncHandler imported in all 94 route files
- [ ] classifyDbError imported in global error handler (`server.ts`)
- [ ] ServerMessages.error overload available in events.ts
- [ ] New ErrorCatalog entries added to `packages/i18n/src/errors.ts`
- [ ] Error documentation route registered in `apps/runtime/src/server.ts` router
- [ ] New PreToolUse hooks registered in `.claude/settings.json`
- [ ] New architecture fitness metrics added to `architecture-fitness.test.ts`
- [ ] Studio ErrorCard imported and rendered in chat message list component
- [ ] Studio ErrorBadge imported and used inside ErrorCard
- [ ] Studio ErrorPage imported and rendered by ErrorBoundary
- [ ] Studio error response parser updated in API client layer
- [ ] Admin error response parser updated in API client layer
- [ ] TraceEvent emission wired in global error handler (not forgotten after errorToResponse)
- [ ] getCurrentTraceId imported from `@abl/compiler/platform/observability` (NOT `@agent-platform/shared-observability` directly in runtime code)
- [ ] ServerMessage union type updated — error variant includes `code: string` field (`apps/runtime/src/types/index.ts:259`)
- [ ] ClickHouse ALTER TABLE for `error_code` column — deferred pending ops coordination (Open Question #2)
- [ ] ToolExecutionError `statusCode` defaults to 500 when not set (Phase 7)
- [ ] Studio WS message handler updated to parse `{ type: 'error', code, message }`
- [ ] `empty-response-lint.sh` updated to also check for missing `code` field in error objects

---

## 5. Cross-Phase Concerns

### Database Migrations

**ClickHouse `audit_events` table** — additive column:

```sql
ALTER TABLE audit_events ADD COLUMN IF NOT EXISTS
  error_code LowCardinality(String) DEFAULT '' CODEC(ZSTD(1));
```

Timing: Execute during Phase 5 (route migration) when error codes start flowing into TraceEvents. The column is DEFAULT '' so existing rows are unaffected.

### Feature Flags

None required. Each surface (runtime, Studio, Admin) migrates independently and is independently revertable. No dual-code-path feature flags. The `structured_errors` flag mentioned in the feature spec is always-on — no value in toggling it.

### Configuration Changes

| Variable                   | Default        | Phase | Description                            |
| -------------------------- | -------------- | ----- | -------------------------------------- |
| `ERROR_INCLUDE_TRACE_ID`   | `true`         | 3     | Include W3C traceId in error responses |
| `ERROR_INCLUDE_REQUEST_ID` | `true`         | 3     | Include requestId in error responses   |
| `ERROR_DOCS_BASE_URL`      | `/docs/errors` | 8     | Base URL for error documentation links |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete with exit criteria met
- [ ] Architecture fitness: non-standard error shape count = 0 (ceiling)
- [ ] Architecture fitness: asyncHandler adoption = 94 of 94 route files (floor)
- [ ] Architecture fitness: empty catch blocks = 0 (ceiling)
- [ ] E2E tests E2E-1 through E2E-10 passing
- [ ] Integration tests INT-1 through INT-10 passing
- [ ] Security tests SEC-1 through SEC-7 passing
- [ ] Unit tests UT-1 through UT-5 passing
- [ ] Performance benchmarks PERF-1, PERF-2 passing
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Studio displays error codes in chat errors (ErrorCard, ErrorBadge)
- [ ] Admin parses structured error responses
- [ ] All error responses include traceId and requestId
- [ ] Zero information leaks (verified by SEC tests and semgrep)
- [ ] Feature spec updated with implementation details via `/post-impl-sync`
- [ ] Testing matrix updated with actual coverage

---

## 7. Open Questions

1. **Error docs endpoint auth**: Decided — use `createUnifiedAuthMiddleware` with viewer role. Maintains platform auth invariant and audit trail. Self-hosted deployments can expose via separate public proxy if needed.
2. **ClickHouse migration ownership**: Who runs the `ALTER TABLE` on production ClickHouse? Is there a migration framework, or is it a manual ops step?
3. **Studio component library**: Should ErrorCard/ErrorBadge/ErrorPage be in `@agent-platform/design-tokens` or Studio-local? (Recommend Studio-local initially, extract to design system if reused by Admin.)
4. **Prometheus counter**: The HLD mentions `runtime_error_total{code, category, source}`. Is Prometheus already instrumented in runtime, or does this require new infrastructure?
5. **Five9 adapter conflict**: The `feature/five9-adapter` branch is actively modifying `handler.ts` and `sdk-handler.ts`. Phase 3 WS changes should coordinate with that branch.

---

## 8. Deferred Work

Items explicitly out of scope for this implementation but tracked for follow-up:

| Item                                                                 | Reason Deferred                                                                                                                       | Follow-up                                                                                                                                 |
| -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| **G13: Multi-locale i18n**                                           | English-only initial release (D-10). Locale resolution infrastructure exists in i18n package but translations should not block ALPHA. | Separate feature: add locale files for supported languages, wire locale resolution into error responses. Depends on translation workflow. |
| **Prometheus counter** `runtime_error_total{code, category, source}` | Runtime lacks prom-client instrumentation (D-13). Adding Prometheus requires new observability infrastructure.                        | Add when runtime observability stack supports Prometheus metrics. Counter definition is specified in HLD Section 8 (Observability).       |
| **SearchAI error standardization**                                   | Explicitly excluded from this release. SearchAI has its own error patterns.                                                           | Separate release — apply same ErrorRegistry/StructuredError patterns to SearchAI routes and workers.                                      |
| **ClickHouse `error_code` column migration**                         | DDL execution requires ops coordination (Open Question #2). Column is defined but migration ownership unclear.                        | Resolve migration ownership, execute `ALTER TABLE audit_events ADD COLUMN error_code` in production.                                      |
| **SDK deprecation notices**                                          | WebSDK breaking change accepted but deprecation timeline not set.                                                                     | Coordinate with SDK consumers, publish migration guide, set deprecation timeline for old `{ error: string }` shape.                       |
