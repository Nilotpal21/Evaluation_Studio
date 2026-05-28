# High-Level Design: Structured Error Framework

**Feature Spec**: [docs/features/structured-error-framework.md](../features/structured-error-framework.md)
**Test Spec**: [docs/testing/structured-error-framework.md](../testing/structured-error-framework.md)
**Status**: DRAFT
**Date**: 2026-03-25

---

## 1. Problem Statement

The ABL Platform runtime has **668 inline error responses across 94 route files** using **5 different response shapes**, zero `AppError`/`ErrorCodes` usage in routes, and 6 fragmented error hierarchies (`AppError`, `MongoAppError`, `AuthProfileError`, `ToolExecutionError`, `SearchAIError`, `CircuitOpenError`). This creates four compounding problems:

1. **Agent developers** see generic "I encountered an error" messages with no actionable information.
2. **AI agents** cannot self-recover because tool failures return unstructured strings instead of typed codes with retryability hints.
3. **Support engineers** cannot filter Observatory traces by error code because errors lack machine-readable codes.
4. **Platform developers** have no guardrails — 668 inline `res.json({ error: '...' })` patterns were shipped without any linting or fitness test enforcement.

The existing infrastructure is partially built but unused: `AppError` and `ErrorCodes` (28 entries) exist in `shared-kernel/src/errors.ts`, `classifyLlmError()` is implemented, and `errorToResponse()` works — but only 4 of 94 route files use any of it. The global error handler at `server.ts:907-911` catches uncaught errors but async route errors never reach it because there is no `asyncHandler` wrapper.

**Expanded scope**: This HLD covers error standardization across runtime, Studio/Admin client-side error handling, SDK WebSocket breaking changes, custom error UI components in Studio, and i18n of error messages beyond English. Breaking changes are accepted across all consumer surfaces. SearchAI route migration is deferred to a future release.

---

## 2. Alternatives Considered

### Option A: Incremental Enhancement of Existing Infrastructure

**Description**: Extend the current `AppError`/`ErrorCodes`/`errorToResponse` in `shared-kernel` with duck-typing, add `asyncHandler` middleware, and migrate routes incrementally using architecture fitness test ratchets.

**Pros**:

- Builds on existing, tested infrastructure (AppError, ErrorCodes, classifyLlmError)
- Zero new packages or services — changes within shared-kernel, runtime, i18n, Studio, and Admin
- Ratchet-based migration is the established pattern (console.log ceiling=170, findById ceiling=48)
- Per-route rollback — removing `asyncHandler` wrapper restores inline try/catch
- Compile-time safety via `as const` registry

**Cons**:

- Duck-typing is less type-safe than a shared base class
- Ratchet migration requires ~20 commits over time; not instant
- The 6 error hierarchies remain separate (no class unification)

**Effort**: M-L (medium-large) — runtime infrastructure in 1-2 sprints, route migration ongoing, Studio/Admin/i18n in parallel sprint

---

### Option B: Unified Error Base Class Migration

**Description**: Create a single `PlatformError` base class that all 6 error hierarchies extend. Migrate `MongoAppError`, `AuthProfileError`, `ToolExecutionError`, `CircuitOpenError`, and `SearchAIError` to extend `PlatformError` instead of `Error`.

**Pros**:

- `instanceof PlatformError` check is cleaner than duck-typing
- Single class hierarchy simplifies error handling logic
- Type inference is stronger with a shared base

**Cons**:

- **Breaking change to 5 packages**: `database`, `shared-auth-profile`, `circuit-breaker`, `shared-kernel/utils`, `search-ai-sdk` — all need their error class modified
- **Circular dependency risk**: `MongoAppError` in `database` package would need to import from `shared-kernel`
- **SearchAI has 17 error classes** (including abstract base) with their own code system — migration scope explodes
- Violates CLAUDE.md commit discipline: class hierarchy changes across 5+ packages in one commit
- No incremental migration path — it's all-or-nothing per error class

**Effort**: L (large) — requires coordinated changes across 5 packages, full regression testing

---

### Option C: Error Middleware Service (Centralized Error Processing)

**Description**: Create a dedicated error processing middleware service that intercepts all errors, classifies them, enriches with trace context, and returns standardized responses. Similar to an error boundary in React but for Express.

**Pros**:

- All error processing logic in one place
- Easy to add new classifiers without touching route files
- Can be deployed independently

**Cons**:

- Adds latency to every error response (extra middleware hop)
- Over-engineered for what is fundamentally a code-level problem (inline responses need to be replaced)
- Doesn't solve the root cause — routes still construct their own error shapes
- The global Express error handler already serves this role at `server.ts:907`

**Effort**: M (medium) — but solves less of the problem

---

### Recommendation: Option A — Incremental Enhancement

**Rationale**: Option A has the lowest risk, builds on proven infrastructure, and follows established codebase patterns (ratchet-based fitness tests). The duck-typing approach handles all 6 error hierarchies without requiring class modifications — 4 of 6 reliably have both `code` and `statusCode` properties. `MongoAppError` lacks `statusCode` entirely and `ToolExecutionError.statusCode` is optional — both fall back to 500, which is correct for their error domains. The ratchet migration is the same pattern used successfully for `console.log` (ceiling 170→goal 0) and `findById()` (ceiling 48→goal 0). Option B's all-or-nothing class migration violates the project's incremental commit discipline and creates unnecessary blast radius.

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        ABL Platform Runtime                         │
│                                                                     │
│  ┌──────────┐    ┌──────────────┐    ┌──────────────────────────┐  │
│  │  Routes   │───▶│ asyncHandler │───▶│ Global Error Handler     │  │
│  │ (94 files)│    │  (new)       │    │ (server.ts:907, enhanced)│  │
│  └──────────┘    └──────────────┘    └────────┬─────────────────┘  │
│                                                │                    │
│                        ┌───────────────────────┼──────────┐        │
│                        ▼                       ▼          ▼        │
│              ┌──────────────────┐  ┌──────────────┐  ┌─────────┐  │
│              │ errorToResponse()│  │ TraceEvent    │  │ Logger  │  │
│              │ (duck-typing)    │  │ (error code)  │  │ (struct)│  │
│              └────────┬─────────┘  └──────┬───────┘  └─────────┘  │
│                       │                   │                        │
│              ┌────────▼─────────┐  ┌──────▼───────┐               │
│              │ ErrorRegistry    │  │ TraceStore   │               │
│              │ (as const)       │  │ → ClickHouse │               │
│              └────────┬─────────┘  └──────────────┘               │
│                       │                                            │
│              ┌────────▼─────────┐                                  │
│              │ i18n ErrorCatalog│                                  │
│              │ (locale-aware)   │                                  │
│              └──────────────────┘                                  │
│                                                                     │
│  ┌──────────────┐    ┌─────────────────────┐                       │
│  │ WS Handlers  │───▶│ events.error(code,  │                       │
│  │ (handler.ts, │    │   message)          │                       │
│  │  sdk-handler)│    │ (enhanced helper)   │                       │
│  └──────────────┘    └─────────────────────┘                       │
└──────────────────────────┬──────────────────────────────────────────┘
                           │ standard error shape
         ┌─────────────────┼─────────────────┬──────────────────┐
         ▼                 ▼                 ▼                  ▼
┌─────────────────┐ ┌───────────┐ ┌──────────────┐ ┌──────────────┐
│ Studio (Next.js)│ │ SDK (WS)  │ │ Admin (React)│ │ Observatory  │
│ ┌─────────────┐ │ │ Breaking: │ │ Breaking:    │ │ (traces)     │
│ │ErrorBoundary│ │ │ parse code│ │ parse error  │ │ error code   │
│ │ErrorCards   │ │ │ from error│ │ as object    │ │ filtering    │
│ │ErrorBadges  │ │ │ messages  │ │              │ │              │
│ │ErrorPages   │ │ │           │ │              │ │              │
│ └─────────────┘ │ │           │ │              │ │              │
└─────────────────┘ └───────────┘ └──────────────┘ └──────────────┘

SearchAI: DEFERRED (future release — already has structured SearchAIError)
```

### Component Diagram

```
shared-kernel (core)
├── StructuredError interface        ← duck-typing contract
├── ErrorRegistry (as const)         ← single source of truth
│   ├── code → statusCode
│   ├── code → category
│   ├── code → retryable
│   ├── code → messageKey (→ i18n)
│   └── code → docsPath
├── errorToResponse() (enhanced)     ← duck-types any error
├── toErrorResponse() (unchanged)    ← body builder
└── AppError / ValidationError       ← existing, unchanged

i18n (locale-aware error messages)
├── ErrorCatalog (extended)          ← new message templates for all error codes
├── locale files (en, es, fr, ...)   ← NEW: ICU MessageFormat per locale
└── formatErrorSync() (unchanged)    ← existing, consumes ErrorCatalog

runtime (routes + middleware)
├── middleware/
│   └── async-handler.ts             ← NEW: catches + next(err)
├── server.ts
│   └── global error handler         ← ENHANCED: traceId, requestId, TraceEvent
├── routes/*.ts (94 files)
│   └── throw AppError(...)          ← MIGRATED from inline res.json()
├── websocket/
│   ├── events.ts                    ← ENHANCED: error(code, message)
│   ├── handler.ts                   ← .catch() fixes, structured errors
│   └── sdk-handler.ts              ← structured error sends
└── services/llm/
    └── classify-llm-error.ts        ← EXTENDED: MODEL_NOT_CONFIGURED

studio (client-side error handling)
├── ErrorBoundary                    ← NEW: catches unhandled errors, shows error page
├── ErrorCard component              ← NEW: contextual error display in chat
├── ErrorBadge component             ← NEW: inline error code badge (e.g., MODEL_RATE_LIMITED)
├── error response parser            ← UPDATED: parse error as { code, message } object
└── WS error handler                 ← UPDATED: parse { type: 'error', code, message }

admin (client-side error handling)
└── error response parser            ← UPDATED: parse error as { code, message } object

fitness + linting (enforcement)
├── architecture-fitness.test.ts     ← 3 new ratchet metrics
├── error-response-shape-lint.sh     ← blocks Shape A
└── error-response-flat-lint.sh      ← blocks Shape B
```

### Data Flow

**HTTP Error Path (post-migration)**:

```
1. Route handler throws:
   throw new AppError('Rate limited', { ...ErrorCodes.MODEL_RATE_LIMITED })

2. asyncHandler catches the rejected promise:
   asyncHandler(async (req, res) => { ... })
   → catch(err) → next(err)

3. Express routes to global error handler (server.ts:907):
   app.use((err, req, res, next) => { ... })

4. Enhanced global error handler:
   a. Log: serverLog.error('Request error', { errorCode, tenantId, sessionId })
   b. Classify: const { statusCode, body } = errorToResponse(err)
      → duck-types: err.code exists? err.statusCode exists? → use them
      → fallback: INTERNAL_ERROR / 500
   c. Enrich: body.traceId = getCurrentTraceId()  // from @agent-platform/shared-observability (AsyncLocalStorage)
              body.requestId = req.id              // from requestIdMiddleware (shared-observability)
   d. Emit: traceStore.emit({ type: 'error', data: { errorCode, ... } })
   e. Send: res.status(statusCode).json(body)

5. Client receives:
   { success: false, error: { code: 'MODEL_RATE_LIMITED', message: '...' },
     traceId: '00-abc...', requestId: 'req-123' }
```

**WebSocket Error Path**:

```
1. WS handler encounters error:
   catch (err) {
     const classified = classifyError(err);
     send(ws, events.error(classified.code, classified.message));
     traceStore.emit({ type: 'error', data: { errorCode: classified.code, ... } });
   }

2. Client receives:
   { type: 'error', code: 'MODEL_RATE_LIMITED', message: '...' }
```

**Tool Call Error Path (to AI agent)**:

```
1. Tool execution fails:
   ToolExecutionError { code: 'TOOL_TIMEOUT', retryable: true }

2. Reasoning executor wraps in tool result:
   { is_error: true, content: [{ type: 'text',
     text: '{"code":"TOOL_TIMEOUT","message":"...","retryable":true}' }] }

3. AI agent receives structured error → can decide to retry
```

**Studio Error Rendering Path**:

```
1. Studio receives HTTP error response:
   { success: false, error: { code: 'MODEL_RATE_LIMITED', message: '...' } }

2. Error response parser extracts code + message (breaking change from string):
   const { code, message } = response.error;  // was: const errorMsg = response.error

3. Error rendering by category:
   - Chat errors → ErrorCard component with code badge + actionable message
   - Page-level errors → ErrorBoundary catches, renders ErrorPage with code
   - Inline errors → ErrorBadge shows code, tooltip shows message

4. WS error rendering:
   { type: 'error', code: 'MODEL_RATE_LIMITED', message: '...' }
   → ErrorCard in chat thread with retry suggestion if retryable
```

**i18n Message Resolution Path**:

```
1. Error classified → code = 'MODEL_RATE_LIMITED'
2. ErrorRegistry lookup → messageKey = 'error.model.rate_limited'
3. i18n ErrorCatalog → template = 'AI Model Error: Rate limit exceeded for {provider}'
4. formatErrorSync('error.model.rate_limited', { provider: 'anthropic' })
   → 'AI Model Error: Rate limit exceeded for anthropic'
5. For non-English locales: locale file provides translated ICU template
   → formatError('error.model.rate_limited', { provider: 'anthropic' }, 'es')
   → 'Error del modelo IA: Límite de tasa excedido para anthropic'
```

### Sequence Diagram (HTTP Error)

```
Client          Route          asyncHandler    GlobalHandler    errorToResponse   TraceStore
  │               │                │               │                │               │
  │──POST /api/──▶│                │               │                │               │
  │               │──throw────────▶│               │                │               │
  │               │  AppError      │──next(err)───▶│                │               │
  │               │                │               │──classify──────▶│               │
  │               │                │               │◀──{status,body}─│               │
  │               │                │               │──emit(TraceEvent)──────────────▶│
  │               │                │               │──log(errorCode) │               │
  │◀──────────────┼────────────────┼──res.json()───│                │               │
  │  {success:false, error:{code}} │               │                │               │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Error responses NEVER leak tenantId, cross-tenant info, or internal URLs. Raw error messages from external services (LLM providers, MongoDB, Redis) are classified and replaced with registry messages. The original error is logged server-side with `tenantId` context for support diagnosis. Cross-tenant errors return 404 (not 403) per platform invariant. 6 identified information leaks (kms-admin, clickhouse-diagnostics, channel-oauth, chat.ts, etc.) are fixed as P0 security items.                                                                                                                                                                                                                                                                                                                                                                                               |
| 2   | **Data Access Pattern** | No new data access patterns. ErrorRegistry is a compile-time `as const` constant in `shared-kernel/src/errors.ts` — zero runtime lookups, zero database queries. Error codes ride in the existing `TraceEvent.data: Record<string, unknown>` bag. ClickHouse `audit_events` gains a `error_code: String` column for aggregation.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 3   | **API Contract**        | **HTTP**: `{ success: false, error: { code: string, message: string, details?: object }, traceId?: string, requestId?: string }`. Breaking change from current `{ error: 'string' }` (Shape A, 141 instances) and `{ success: false, error: 'string' }` (Shape B, 527 instances). Breaking changes accepted across all surfaces: Runtime API, SDK WebSocket, HTTP Async Channel. Studio/Admin updated in lockstep to parse `error` as object. **WS**: `{ type: 'error', code: string, message: string }` — breaking change from `{ type: 'error', message }`. **Tool results**: `{ code, message, retryable }` in `is_error` content. **Studio**: Error code badges, contextual error cards, custom error pages. **i18n**: All error messages support locale-aware formatting via ICU MessageFormat templates. **SearchAI**: Deferred to future release — already has structured SearchAIError. |
| 4   | **Security Surface**    | FR-13 eliminates 6 information leaks. Stack traces logged server-side only, never in responses. Sensitive context (tenantId, internal paths, raw provider errors) replaced with registry messages. `asyncHandler` + global error handler ensure no error path can accidentally leak raw errors. Security fixes are P0 (Phase 3 in delivery plan).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 5   | **Error Model**   | Six error hierarchies unified via duck-typing interface `StructuredError { code, statusCode, message, retryable? }`. `errorToResponse()` checks `typeof err.code === 'string'` and `typeof err.statusCode === 'number'` — no `instanceof` check. 4/6 hierarchies reliably have both `code` and `statusCode` (`AppError`, `AuthProfileError`, `CircuitOpenError`, `SearchAIError`). `MongoAppError` lacks `statusCode` entirely — fallback to 500. `ToolExecutionError.statusCode` is optional (`statusCode?: number`) — may be `undefined`, also falls back to 500. Unrecognized errors always fall back to `INTERNAL_ERROR`/500. Classifier chain: `classifyLlmError` → `classifyToolError` → `classifyDbError` → generic fallback. |
| 6   | **Failure Modes** | **asyncHandler fails**: Impossible — it's a 10-line wrapper that catches and calls `next(err)`. If the wrapper itself somehow throws, Express's built-in error handling catches it. **Registry lookup fails**: Impossible — registry is a compile-time constant; no runtime lookup can fail. **Classifier returns wrong code**: Moderate impact — wrong status code or retryability. Mitigated by INT-4 integration test (registry consistency) and compile-time `as const` type safety. **TraceEvent emission fails**: Fire-and-forget — error response is sent regardless. **Global error handler throws**: Last-resort `try/catch` in the handler itself returns `500 INTERNAL_ERROR`.                                            |
| 7   | **Idempotency**   | Not directly applicable — error responses are stateless. However, the `retryable` flag in error responses enables AI agents to safely retry idempotent operations (GET, tool calls). Non-idempotent operations (POST, PUT) are marked `retryable: false` even for transient failures like rate limits, to prevent duplicate writes.                                                                                                                                                                                                                                                                                                                                                                                                  |
| 8   | **Observability** | Every classified error emits a `TraceEvent` with `type: 'error'`, `data: { errorCode, errorMessage, errorCategory, errorRetryable, errorSource }`. Structured logging via `createLogger` with context `{ errorCode, tenantId, sessionId, agentName }`. `debug_get_errors` MCP tool returns structured `{ code, message, timestamp, source }` entries. Observatory session debugger gains error code filtering. Prometheus counter `runtime_error_total{code, category, source}` for dashboards.                                                                                                                                                                                                                                      |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | Zero overhead on happy path — error classification only runs in error paths. Registry is a compile-time constant (no Map lookup, no I/O). TraceEvent emission is async fire-and-forget via existing TraceStore. `asyncHandler` adds one `try/catch` per route invocation — negligible overhead (V8 optimizes non-throwing try/catch to near-zero cost). Error classification target: <1ms per error (pure in-memory pattern matching).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| 10  | **Migration Path**     | **Current state**: 668 inline `res.json({ error })` across 94 runtime files, 5 shapes, zero `AppError` usage in routes. Studio/Admin parse `error` as flat string. i18n has English-only ErrorCatalog. **Target state**: All routes throw `AppError`, asyncHandler catches, global handler responds with standard shape. Studio/Admin parse `error` as `{ code, message }`. i18n supports multiple locales. **Transition**: 5 phases: (1) Build infrastructure — registry, middleware, fitness tests, hooks (~5 commits), (2) Migrate runtime routes file-by-file (~20 commits, 1-3 files each), (3) Update Studio error parsing + add ErrorCard/ErrorBadge/ErrorPage components, (4) Update Admin error parsing, (5) Add i18n locale files and wire locale-aware formatting. Studio/Admin changes can run in parallel with runtime route migration. Ratchet ceilings tighten as each file is migrated.                                                                                                                                    |
| 11  | **Rollback Plan**      | **Runtime**: Per-route — remove `asyncHandler` wrapper restores inline try/catch. Per-file — `git revert` on migration commit. Infrastructure — enhanced `errorToResponse` is backwards-compatible (still handles `instanceof AppError`, falls through to duck-typing). **Studio/Admin**: Revert error parser to expect `error` as string. ErrorCard/ErrorBadge components can be feature-flagged via Next.js environment variable if needed. **i18n**: Revert to English-only ErrorCatalog — locale files are additive, removing them falls back to English templates. **No global feature flag needed**: Each surface migrates independently and is independently revertable.                                                                                                                                                                                                                                                                                                                                                            |
| 12  | **Test Strategy**      | **Unit tests**: StructuredError duck-typing, ErrorRegistry consistency, asyncHandler wrapper, classifier branches, i18n locale formatting. **Integration tests**: asyncHandler → global error handler pipeline, TraceEvent emission with error codes, concurrent WS error delivery, registry↔i18n↔TraceEvent consistency. **E2E tests**: Real HTTP requests triggering LLM rate limit, invalid credentials, validation failures, cross-tenant access, WS errors, tool timeouts, stack trace leaks, missing auth — all asserting standard response shape with correct codes. **Studio tests**: Error response parser correctly handles `{ code, message }` object shape; ErrorCard/ErrorBadge render with code; ErrorBoundary catches and displays error page. **Fitness tests**: 3 new ratchet metrics (non-standard shape count ceiling, AppError adoption floor, empty catch ceiling). **See**: [test spec](../testing/structured-error-framework.md) for 34 scenarios across 10 E2E, 10 integration, 5 unit, 7 security, 2 performance. |

---

## 5. Data Model

### New Collections/Tables

No new MongoDB collections. No new Redis keys.

### Modified Collections/Tables

**ClickHouse `audit_events` (additive)**:

| Column       | Type                                               | Purpose                                                                                                                                                                                                                 |
| ------------ | -------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `error_code` | `LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))` | Machine-readable error code for aggregation (e.g., `MODEL_RATE_LIMITED`). Uses `LowCardinality` matching existing `action` column pattern. ALTER TABLE migration created during Phase 2 when error codes start flowing. |

### Enriched Data Structures

**TraceEvent.data (existing `Record<string, unknown>` bag)**:

| Field            | Type      | Example                                                |
| ---------------- | --------- | ------------------------------------------------------ |
| `errorCode`      | `string`  | `'MODEL_RATE_LIMITED'`                                 |
| `errorMessage`   | `string`  | `'AI Model Error: Rate limited'`                       |
| `errorCategory`  | `string`  | `'llm'`, `'tool'`, `'auth'`, `'infra'`, `'validation'` |
| `errorRetryable` | `boolean` | `true`                                                 |
| `errorSource`    | `string`  | `'anthropic'`, `'redis'`, `'mongodb'`                  |

**ErrorRegistry entry shape (compile-time constant)**:

```typescript
// packages/shared-kernel/src/errors.ts
export const ErrorRegistry = {
  MODEL_RATE_LIMITED: {
    code: 'MODEL_RATE_LIMITED',
    statusCode: 429,
    category: 'llm',
    retryable: true,
    messageKey: 'error.model.rate_limited', // → i18n ErrorCatalog
    docsPath: '/errors/MODEL_RATE_LIMITED',
  },
  TOOL_TIMEOUT: {
    code: 'TOOL_TIMEOUT',
    statusCode: 504,
    category: 'tool',
    retryable: true,
    messageKey: 'error.tool.timeout',
    docsPath: '/errors/TOOL_TIMEOUT',
  },
  // ... all 28 existing ErrorCodes + new codes
} as const satisfies Record<
  string,
  {
    code: string;
    statusCode: number;
    category: string;
    retryable: boolean;
    messageKey: string;
    docsPath: string;
  }
>;
```

### Key Relationships

```
ErrorRegistry.code ──────────▶ i18n ErrorCatalog (messageKey → template)
ErrorRegistry.code ──────────▶ TraceEvent.data.errorCode
ErrorRegistry.code ──────────▶ ClickHouse audit_events.error_code
ErrorRegistry.code ──────────▶ HTTP response error.code
ErrorRegistry.code ──────────▶ WS message code
ErrorRegistry.code ──────────▶ Tool result code
AppError.code ───────────────▶ ErrorRegistry.code (same string)
ToolExecutionError.code ─────▶ ErrorRegistry.code (aligned, statusCode optional — fallback 500)
AuthProfileError.code ───────▶ ErrorRegistry.code (duck-typed)
MongoAppError.code ──────────▶ ErrorRegistry.code (duck-typed, statusCode fallback 500)
CircuitOpenError.code ───────▶ ErrorRegistry.code (extends AppError)
```

---

## 6. API Design

### New Endpoints

| Method | Path                   | Purpose                                       | Auth                                 |
| ------ | ---------------------- | --------------------------------------------- | ------------------------------------ |
| GET    | `/api/v1/errors`       | List all error codes with categories and docs | Viewer role (TBD — Open Question #4) |
| GET    | `/api/v1/errors/:code` | Get details for a specific error code         | Viewer role (TBD)                    |

### Modified Endpoints

All 94 runtime route files are affected — error responses change from:

- Shape A: `{ error: 'string' }` → `{ success: false, error: { code, message } }`
- Shape B: `{ success: false, error: 'string' }` → `{ success: false, error: { code, message } }`

No URL, method, or success-path changes. Only error response shapes change.

**Client-side changes (breaking)**:

- **Studio**: All HTTP error handlers and WS error handlers updated to parse `error` as `{ code, message }` object. New ErrorCard, ErrorBadge, and ErrorPage components render error codes contextually.
- **Admin**: All HTTP error handlers updated to parse `error` as `{ code, message }` object.
- **SDK WebSocket consumers**: Must update to parse `{ type: 'error', code, message }` instead of `{ type: 'error', message }`.

### Error Responses

Every error response from runtime follows this contract:

```typescript
// HTTP
{
  success: false,
  error: {
    code: string,        // ErrorRegistry key
    message: string,     // Human-readable from i18n
    details?: object     // Optional (validation errors, etc.)
  },
  traceId?: string,      // W3C trace ID (when ERROR_INCLUDE_TRACE_ID=true)
  requestId?: string     // Express request ID (when ERROR_INCLUDE_REQUEST_ID=true)
}

// WebSocket
{
  type: 'error',
  code: string,          // ErrorRegistry key
  message: string        // Human-readable
}

// Tool call result (to AI agent)
{
  is_error: true,
  content: [{
    type: 'text',
    text: JSON.stringify({
      code: string,
      message: string,
      retryable: boolean
    })
  }]
}
```

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: Every classified error emits a TraceEvent with `type: 'error'` and `data.errorCode`. These flow to ClickHouse via the existing trace pipeline. No additional audit logging infrastructure needed.
- **Rate Limiting**: Rate limit errors (`429 TOO_MANY_REQUESTS`, `429 MODEL_RATE_LIMITED`) use standard error shape. Rate limiter middleware continues to set `Retry-After` header — the error framework adds the `code` field to the response body.
- **Caching**: No caching implications. ErrorRegistry is a compile-time constant. Error responses are not cacheable (`Cache-Control: no-store` by default for error statuses).
- **Encryption**: No encryption changes. Error responses do not contain sensitive data (information leaks are eliminated by FR-13). Error logs include `tenantId` context for support diagnosis — these are already encrypted at rest via the existing log infrastructure.
- **Internationalization**: All error messages use ICU MessageFormat templates in `i18n/ErrorCatalog`. English templates are mandatory (fallback locale). Additional locale files are additive — missing translations fall back to English. Server-side formatting uses `formatErrorSync(code, params, locale?)`. Studio client-side may format locally if locale files are bundled, or consume pre-formatted messages from the server.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                                  | Type                           | Risk                                                                                                                                          |
| ----------------------------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared-kernel` AppError/ErrorCodes                         | Package (existing)             | None — extending, not replacing                                                                                                               |
| `i18n` ErrorCatalog/formatErrorSync                         | Package (existing)             | Medium — additive entries + locale-aware formatting for all error codes                                                                       |
| `studio` error handling                                     | App (existing)                 | Medium — client-side error parsing, error code badges, contextual error cards, custom error pages                                             |
| `admin` error handling                                      | App (existing)                 | Low — client-side error parsing updated to consume `error` as object                                                                          |
| `shared-observability` requestIdMiddleware                  | Package (existing)             | None — already mounted at server.ts:239                                                                                                       |
| `shared-observability` context module (`getCurrentTraceId`) | Package (existing)             | None — used for traceId extraction in error responses via `getCurrentTraceId()` (reads from AsyncLocalStorage populated by otel-trace-bridge) |
| OTEL W3C trace context                                      | Infrastructure (existing)      | None — already available via otel-trace-bridge                                                                                                |
| Express error handling semantics                            | Framework                      | None — standard Express patterns                                                                                                              |
| Architecture fitness test infrastructure                    | Test infrastructure (existing) | None — adding new metrics to existing framework                                                                                               |

### Downstream (depends on this feature)

| Consumer                           | Impact                                                                                               |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Studio WebSocket client            | **Breaking** — must parse `{ type: 'error', code, message }` instead of `{ type: 'error', message }` |
| Studio HTTP error handling         | **Breaking** — must parse `error` as `{ code, message }` object instead of string                    |
| Studio error UI                    | **New** — error code badges, contextual error cards, custom error pages per error category           |
| Admin HTTP error handling          | **Breaking** — must parse `error` as `{ code, message }` object instead of string                    |
| SDK consumers (HTTP async channel) | **Breaking** — shape change from `error: string` to `error: { code, message }`                       |
| SearchAI routes                    | **Deferred** — future release; SearchAI already has structured SearchAIError                         |
| Observatory session debugger       | Gains error code filtering via TraceEvent.data.errorCode — additive                                  |
| `debug_get_errors` MCP tool        | Returns structured `{ code, message, timestamp, source }` — additive                                 |
| AI agents (tool results)           | Receive `{ code, message, retryable }` — new capability, additive                                    |
| ClickHouse analytics               | New `error_code` column enables aggregation dashboards — additive                                    |
| i18n translations                  | **New** — all error message templates support locale-aware ICU MessageFormat                         |

---

## 9. Open Questions & Decisions Needed

1. **ErrorRegistry format**: Should it be a static TypeScript `as const` object (recommended by oracle — matches existing `ErrorCodes` pattern) or loaded from JSON/YAML for non-developer editing? **Recommendation**: `as const` — the registry is developer-owned infrastructure, not user configuration.

2. **Error docs endpoint auth**: Should `GET /api/v1/errors` be public (no auth) for developer convenience, or require at minimum viewer role? Self-hosted deployments may want this public. **Decision needed from product**.

3. **Error code versioning**: Should error codes ever be versioned (e.g., `MODEL_RATE_LIMITED_V2`)? **Recommendation**: No — error codes are semantic identifiers, not API versions. If meaning changes, create a new code.

4. **ClickHouse migration timing**: The `error_code` column addition to `audit_events` requires a ClickHouse migration. Should this be done as part of the infrastructure phase or deferred until error codes are actually emitted? **Recommendation**: Defer until Phase 2 (route migration), when error codes start flowing.

5. **Studio error UI component library**: Should error cards/pages be built as reusable design-system components in `@agent-platform/design-tokens`, or as Studio-local components? **Decision needed from design team**.

6. **i18n locale loading strategy**: Should locale files be bundled at build time or loaded dynamically at runtime? **Recommendation**: Build-time bundling for initial English + top 5 locales; dynamic loading for others.

---

## 10. References

- Feature spec: [docs/features/structured-error-framework.md](../features/structured-error-framework.md)
- Test spec: [docs/testing/structured-error-framework.md](../testing/structured-error-framework.md)
- Current implementation: `packages/shared-kernel/src/errors.ts` (AppError, ErrorCodes, errorToResponse)
- LLM classifier: `apps/runtime/src/services/llm/classify-llm-error.ts`
- Global error handler: `apps/runtime/src/server.ts:907-911`
- WS error helper: `apps/runtime/src/websocket/events.ts:238-240`
- Existing fitness tests: `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts`
- Related HLDs: [rate-limiting.hld.md](rate-limiting.hld.md), [tracing-observability.hld.md](tracing-observability.hld.md), [circuit-breaker.hld.md](circuit-breaker.hld.md)
- Prior remediation specs: `docs/specs/unsafe-error-handling-phase1.changes.md`, `docs/specs/h3-h4-h6-swallowed-errors-console.changes.md`
