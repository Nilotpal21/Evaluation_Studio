# Feature: Structured Error Framework

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `observability`, `governance`, `enterprise`, `customer experience`
**Package(s)**: `@agent-platform/shared-kernel`, `@agent-platform/runtime`, `@agent-platform/i18n`, `@agent-platform/shared-auth-profile`, `@agent-platform/database`, `@agent-platform/studio`, `@agent-platform/admin`
**Owner(s)**: Platform team
**Testing Guide**: [../testing/structured-error-framework.md](../testing/structured-error-framework.md)
**Last Updated**: 2026-03-25

---

## 1. Introduction / Overview

### Problem Statement

The runtime codebase has **668+ inline error responses across 94 route files** using **5 different response shapes**, zero `AppError`/`ErrorCodes` usage in routes, and 6 fragmented error hierarchies. When an error occurs:

- **Agent developers** see generic "I encountered an error. Please try again." in Studio chat with no indication of root cause (billing limit, expired credential, context overflow, tool failure).
- **AI agents** cannot self-recover because tool call failures return unstructured string messages instead of typed error codes.
- **Support engineers** cannot diagnose customer issues because error codes are not emitted as trace events in Observatory.
- **Platform operators** cannot aggregate error patterns because response shapes are inconsistent and most errors lack machine-readable codes.

A recent audit (2026-03-25) quantified the gap:

| Finding                                 | Count   |
| --------------------------------------- | ------- |
| Inline error responses (no error codes) | 668     |
| Different response shapes in use        | 5       |
| Route files using AppError/ErrorCodes   | 0 of 94 |
| Uses of centralized error helpers       | 7       |
| Fragmented error class hierarchies      | 6       |
| Empty catch blocks (swallowed errors)   | 30+     |
| `console.error`/`warn` in server code   | 55+     |
| Unhandled promise rejections (WS)       | 11      |
| ErrorCodes declared but never thrown    | 4       |
| Error information leaks to client       | 6       |

### Goal Statement

Establish a unified, machine-readable error code system that every API response, WebSocket message, trace event, and tool call result uses consistently. Errors should be self-documenting: an agent developer seeing `MODEL_RATE_LIMITED` in Studio chat can understand the problem and take action without contacting support. An AI agent receiving `TOOL_TIMEOUT` in a tool result can decide to retry. A support engineer filtering Observatory traces by error code can pinpoint the failure in seconds. Architecture fitness tests and linting hooks enforce this standard on every commit.

### Summary

This feature introduces:

1. **Unified Error Registry** — A single source-of-truth mapping every error code to its HTTP status, category, retryability, i18n message key, and documentation URL.
2. **Standard Error Response Shape** — All HTTP and WebSocket error responses use `{ success: false, error: { code, message }, traceId?, requestId? }`.
3. **Error-handling Express middleware** — An `asyncHandler` wrapper + enhanced global error handler that eliminates per-route error response construction.
4. **Error classification at system boundaries** — Classifiers for LLM providers (already done), tool execution, and external service failures that map raw errors to registry codes.
5. **Trace event integration** — Error codes emitted as structured TraceEvents for Observatory, debug tools, and ClickHouse analytics.
6. **Architecture fitness tests** — Ratcheted metrics tracking error response shape consistency, AppError adoption, swallowed catches, and console.log usage.
7. **Linting hooks** — PreToolUse hooks blocking new inline error responses and enforcing the standard shape at write-time.
8. **Full route migration** — All 668 inline error responses migrated to the standard shape, tracked by ratchet metrics.

---

## 2. Scope

### Goals

- G1: Every API error response across runtime uses `{ success: false, error: { code, message } }` with a machine-readable code from the unified registry.
- G2: AI agents receive structured error codes in tool call failure results, enabling programmatic self-recovery.
- G3: Error codes are emitted as TraceEvents, visible in Observatory session debugger and `debug_get_errors` MCP tool output.
- G4: All error class hierarchies (AppError, SearchError, MongoAppError, AuthProfileError) are interoperable via a shared `StructuredError` interface.
- G5: Architecture fitness tests enforce error response consistency with ratchet ceilings, preventing regression.
- G6: PreToolUse linting hooks block new inline error responses at write-time.
- G7: All 668 existing inline error responses are migrated to the standard shape.
- G8: Security information leaks in error responses are eliminated.
- G9: All swallowed catch blocks in critical paths have at minimum debug-level logging.
- G10: All `console.error`/`warn` in server code are replaced with structured `createLogger` calls.
- G11: Client-side (Studio, Admin, SDK) error handling is standardized — Studio and Admin parse `{ success: false, error: { code, message } }`, SDK WebSocket uses `{ type: 'error', code, message }` (breaking change accepted).
- G12: Studio displays custom error pages/components for error codes — contextual error cards in chat, error code badges, and user-actionable error UIs.
- G13: Error messages are internationalized beyond English — i18n message templates for all error codes support locale-aware formatting.

### Non-Goals (Out of Scope)

- NG1: Error analytics dashboards or alerting rules — depends on ClickHouse error code data, enabled by this feature but built separately.
- NG2: Changing the existing ABL DSL `ON_ERROR`/`ESCALATE`/`COMPLETE` constructs.
- NG3: Search-AI route migration — deferred to a future release (SearchAI already has structured SearchAIError).

---

## 3. User Stories

1. As an **agent developer**, I want to see a specific error code like `MODEL_RATE_LIMITED` with a clear message in Studio chat so that I can fix the issue (e.g., increase my API spend limit) without filing a support ticket.
2. As an **AI agent**, I want tool call failures to include a structured error code and `retryable` flag so that I can automatically retry transient failures and escalate permanent ones.
3. As a **support engineer**, I want to filter Observatory traces by error code so that I can diagnose a customer's issue in seconds instead of reading through raw logs.
4. As a **platform operator**, I want error codes in ClickHouse analytics so that I can identify the top error categories across tenants and prioritize fixes.
5. As a **platform developer**, I want a PreToolUse hook that blocks me from writing `res.status(500).json({ error: 'Internal server error' })` so that I never accidentally ship an unstructured error response.
6. As a **platform developer**, I want an `asyncHandler` wrapper that lets me `throw new AppError(...)` in route handlers instead of manually constructing `res.json(...)` responses, reducing boilerplate.
7. As an **agent developer**, I want errors in WebSocket messages to include error codes (not just `"Failed to process message"`) so that my SDK integration can show contextual error UIs.

---

## 4. Functional Requirements

1. **FR-1**: The system must define a `StructuredError` interface in `@agent-platform/shared-kernel` with properties `code: string`, `statusCode: number`, `message: string`, and optional `retryable: boolean`, `category: string`, `docsPath: string`.
2. **FR-2**: The system must provide a unified `ErrorRegistry` in `@agent-platform/shared-kernel` that maps every error code to `{ code, statusCode, category, retryable, messageKey, docsPath }`. The registry must contain all existing `ErrorCodes` entries plus new codes identified by the audit.
3. **FR-3**: The system must extend `errorToResponse()` to duck-type check for `code`/`statusCode` on any thrown error (not just `instanceof AppError`), enabling all 6 error hierarchies to produce standard responses without migration.
4. **FR-4**: The system must provide an `asyncHandler(fn)` Express wrapper that catches thrown errors and calls `next(err)`, eliminating per-route try/catch.
5. **FR-5**: The system must enhance the global Express error handler (the `app.use((err, _req, res, _next) => {...})` middleware near `errorToResponse` in `server.ts`) to inject `traceId` (from OTEL/W3C context) and `requestId` into every error response.
6. **FR-6**: Every HTTP error response from runtime routes must use the shape `{ success: false, error: { code: string, message: string, details?: object }, traceId?: string, requestId?: string }`.
7. **FR-7**: Every WebSocket error message must use `{ type: 'error', code: string, message: string }` — never disguise errors as `response_end` text content.
8. **FR-8**: Tool call failures returned to AI agents must include `{ code: string, message: string, retryable: boolean }` in the tool result `is_error` content, enabling programmatic recovery.
9. **FR-9**: The system must emit a `TraceEvent` with `severity: 'error'` for every classified error, containing `{ code, message, statusCode, category, source }` in the event data.
10. **FR-10**: The system must add architecture fitness test metrics: (a) non-standard error response shape count (ceiling = current, ratchet to 0), (b) route files using AppError/toErrorResponse (floor = current, ratchet to 100%), (c) empty catch blocks in server code (ceiling = current, ratchet to 0).
11. **FR-11**: The system must add a PreToolUse linting hook that blocks new `res.status(N).json({ error: '<string>' })` patterns (Shape A: no success field, no error code) in route files.
12. **FR-12**: The system must add a PreToolUse linting hook that blocks new `res.status(N).json({ success: false, error: '<string>' })` patterns (Shape B: flat string error, no code) in route files.
13. **FR-13**: The system must eliminate all error information leaks — raw error messages, stack traces, tenantIds, and internal URLs must not be sent to clients. Sensitive details must be logged server-side and replaced with the registry message.
14. **FR-14**: The system must add debug-level logging to all empty catch blocks in critical paths (encryption, Redis locks, dedup, cross-pod delivery) so that silent failures are diagnosable.
15. **FR-15**: The system must replace all `console.error`/`console.warn`/`console.log` in server-side runtime code with structured `createLogger` calls.
16. **FR-16**: The system must add `.catch()` error handlers to the 11 unhandled async WebSocket message handlers in `handler.ts`.
17. **FR-17**: All 4 unused ErrorCodes (`TOOL_BINDING_FAILED`, `FLOW_STEP_ERROR`, `HANDOFF_TARGET_MISSING`, `EXECUTION_TIMEOUT`) must be wired into the execution chain where the corresponding errors actually occur.
18. **FR-18**: The `classifyLlmError()` pattern must be extended to cover `MODEL_NOT_CONFIGURED` and `CREDENTIAL_DECRYPTION` error paths in `model-resolution.ts`.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                          |
| -------------------------- | ------------ | ------------------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Error codes scoped by projectId in trace events                                |
| Agent lifecycle            | PRIMARY      | AI agents receive structured error codes for self-recovery                     |
| Customer experience        | PRIMARY      | Agent developers see actionable errors instead of generic messages             |
| Integrations / channels    | SECONDARY    | SDK, WS, HTTP all emit standard error shape                                    |
| Observability / tracing    | PRIMARY      | Error codes in TraceEvents, Observatory filtering, debug_get_errors            |
| Governance / controls      | PRIMARY      | Architecture fitness tests and linting hooks enforce standards on every commit |
| Enterprise / compliance    | SECONDARY    | Eliminates information leaks; error audit trail via traces                     |
| Admin / operator workflows | SECONDARY    | Error code aggregation in ClickHouse enables operational dashboards            |

### Related Feature Integration Matrix

| Related Feature                                     | Relationship Type | Why It Matters                                                 | Key Touchpoints                                | Current State                          |
| --------------------------------------------------- | ----------------- | -------------------------------------------------------------- | ---------------------------------------------- | -------------------------------------- |
| [Tracing & Observability](tracing-observability.md) | emits into        | Error codes must be emitted as TraceEvents                     | TraceStore, TraceEmitter, Observatory UI       | TraceEvent supports `error`            |
| [Diagnostics Engine](diagnostics.md)                | extends           | Error codes enable richer diagnostic patterns                  | DiagnosticPatterns, FindingGenerator           | Patterns exist but lack codes          |
| [Rate Limiting](rate-limiting.md)                   | depends on        | Rate limit errors must use standard codes                      | rate-limiter.ts, tenant-config.ts              | Returns flat `{ error }` string        |
| [Model Hub](model-hub.md)                           | depends on        | LLM credential/model errors use error codes                    | classify-llm-error.ts, model-resolution.ts     | Partially done (LLM classifier)        |
| [Guardrails](guardrails.md)                         | shares data with  | Guardrail blocks must use standard error codes                 | guardrail-messages.ts, pipeline-factory.ts     | Uses i18n ErrorCatalog                 |
| [Circuit Breaker](circuit-breaker.md)               | depends on        | Circuit open errors must use `CIRCUIT_OPEN` code               | CircuitOpenError, runtime catch handlers       | Code exists but unused in runtime      |
| [Tool Invocations](tool-invocations.md)             | extends           | Tool execution errors must carry structured codes to AI agents | ToolExecutionError, reasoning-executor.ts      | ToolErrorCode exists, not in responses |
| [Observatory](observatory.md)                       | configured by     | Error code filtering in session debugger                       | Observatory trace viewer, debug_get_errors MCP | Raw error strings only                 |
| [Audit Logging](audit-logging.md)                   | emits into        | Error events logged to audit store with codes                  | ClickHouseAuditStore                           | Uses console.error (!!)                |

---

## 6. Design Considerations

### Error Code Naming Convention

All error codes follow `DOMAIN_SPECIFIC_ERROR` format using SCREAMING_SNAKE_CASE:

- **Domain prefix**: `MODEL_`, `TOOL_`, `AUTH_`, `TENANT_`, `SESSION_`, `DEPLOYMENT_`, `GUARDRAIL_`, `SEARCH_`, `VOICE_`, `CHANNEL_`
- **Generic codes**: `BAD_REQUEST`, `NOT_FOUND`, `INTERNAL_ERROR`, `SERVICE_UNAVAILABLE` — used when no domain-specific code applies
- **No numeric codes** — human-readable strings throughout (matches existing convention)

### Error Response Shape Contract

```typescript
// HTTP responses
{
  success: false,
  error: {
    code: string,        // 'MODEL_RATE_LIMITED'
    message: string,     // 'AI Model Error: You have reached your API usage limits...'
    details?: object     // Optional structured context (never raw errors)
  },
  traceId?: string,      // W3C trace ID from OTEL context
  requestId?: string     // Express request ID
}

// WebSocket error messages
{
  type: 'error',
  code: string,          // 'MODEL_RATE_LIMITED'
  message: string        // Human-readable message
}

// Tool call failure results (to AI agent)
{
  is_error: true,
  content: [{
    type: 'text',
    text: JSON.stringify({
      code: string,       // 'TOOL_TIMEOUT'
      message: string,    // 'Tool xyz timed out after 30s'
      retryable: boolean  // true — agent can retry
    })
  }]
}
```

---

## 7. Technical Considerations

### Migration Strategy

The 668 inline error responses cannot be migrated in a single commit (CLAUDE.md: max 40 files, max 3 packages per commit). Migration follows the ratchet pattern:

1. **Phase 1**: Build infrastructure (registry, middleware, fitness tests, hooks) — ~5 commits
2. **Phase 2**: Migrate routes file-by-file, starting with highest-traffic routes — ~20 commits
3. **Phase 3**: Tighten ratchet ceilings to 0, making the standard shape enforced

Each migration commit touches 1-3 route files and their tests.

### Backwards Compatibility

SDK clients currently parse `{ error: string }` and `{ success: false, error: string }` shapes. The new shape `{ success: false, error: { code, message } }` changes the `error` field from string to object. Breaking changes are accepted across all surfaces:

- **Runtime API (HTTP)**: Migrate immediately — Studio and Admin are internal consumers, updated in lockstep.
- **SDK WebSocket**: Breaking change — migrate from `{ type: 'error', message }` to `{ type: 'error', code, message }`. SDK consumers must update.
- **HTTP Async Channel**: Breaking change — migrate to `{ success: false, error: { code, message } }`. External integrators must update.
- **Studio/Admin**: Standardize error parsing to consume `error` as an object with `code` and `message` fields. Add error code badges and contextual error UIs.

### StructuredError Interface

```typescript
// packages/shared-kernel/src/errors.ts
export interface StructuredError {
  readonly code: string;
  readonly statusCode: number;
  readonly message: string;
  readonly retryable?: boolean;
}
```

`errorToResponse()` will be updated to check for this interface via duck-typing instead of `instanceof AppError`, enabling all 6 error hierarchies to produce standard responses.

---

## 8. How to Consume

### Studio UI

- Error messages in chat display the error code as a badge/tag alongside the human-readable message
- Studio WebSocket client parses `{ type: 'error', code, message }` and renders contextual error cards
- Observatory session debugger gains error code filtering: search for `code:MODEL_RATE_LIMITED`

### API (Runtime)

| Method | Path                   | Purpose                                                                 |
| ------ | ---------------------- | ----------------------------------------------------------------------- |
| GET    | `/api/v1/errors`       | List all error codes in the registry with categories and docs           |
| GET    | `/api/v1/errors/:code` | Get details for a specific error code                                   |
| —      | All existing endpoints | Error responses standardized to `{ success, error: { code, message } }` |

### API (Studio)

N/A — Studio consumes runtime errors. No Studio-specific error endpoints.

### Admin Portal

- Error code distribution dashboard (powered by ClickHouse error code aggregation from TraceEvents)
- Filter tenant issues by error code in admin Observatory

### Channel / SDK / Voice / A2A / MCP Integration

- SDK WebSocket: `{ type: 'error', code, message }` shape with backwards-compatible `message` field
- HTTP Async Channel: Standard `{ success, error: { code, message } }` shape
- Voice: Error codes propagated through voice gateway error responses
- A2A: Error codes included in JSON-RPC error responses
- MCP: `debug_get_errors` returns structured `{ code, message, timestamp, source }` entries

---

## 9. Data Model

### Collections / Tables

No new MongoDB collections required. Error codes are metadata on existing data flows:

```text
TraceEvent (existing, enriched):
  - severity: 'error'
  - data.errorCode: string    // NEW: machine-readable code
  - data.errorMessage: string // NEW: human-readable message
  - data.errorCategory: string // NEW: 'llm', 'tool', 'auth', 'infra', 'validation'
  - data.errorRetryable: boolean // NEW
  - data.errorSource: string   // NEW: 'anthropic', 'redis', 'mongodb', etc.

ClickHouse audit_events (existing, enriched):
  - error_code: String        // NEW: for error aggregation queries
```

### Key Relationships

- `ErrorRegistry` → `i18n ErrorCatalog`: Each registry entry has a `messageKey` that resolves to an i18n template
- `TraceEvent.data.errorCode` → `ErrorRegistry.code`: Trace events reference registry codes
- `ToolExecutionError.code` → `ErrorRegistry.code`: Tool errors map to registry for AI agent consumption

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                          | Purpose                                                                               |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/shared-kernel/src/errors.ts`                        | `StructuredError` interface, `ErrorRegistry`, enhanced `errorToResponse`              |
| `packages/shared-kernel/src/utils/errors.ts`                  | `ToolExecutionError` alignment with registry                                          |
| `packages/i18n/src/errors.ts`                                 | New error message templates for missing codes                                         |
| `apps/runtime/src/services/llm/classify-llm-error.ts`         | LLM error classifier (existing, extend)                                               |
| `apps/runtime/src/services/execution/error-handler-router.ts` | Extend existing IR error routing to add structured error classification for AI agents |

### Routes / Handlers

| File                                           | Purpose                                              |
| ---------------------------------------------- | ---------------------------------------------------- |
| `apps/runtime/src/server.ts`                   | Enhanced global error handler with traceId/requestId |
| `apps/runtime/src/middleware/async-handler.ts` | New `asyncHandler` wrapper                           |
| `apps/runtime/src/routes/*.ts` (94 files)      | Migration from inline to thrown AppError             |
| `apps/runtime/src/websocket/handler.ts`        | Structured WS errors, `.catch()` fixes               |
| `apps/runtime/src/websocket/sdk-handler.ts`    | Structured SDK WS errors                             |

### Jobs / Workers / Background Processes

| File                                                   | Purpose                            |
| ------------------------------------------------------ | ---------------------------------- |
| `apps/runtime/src/services/queues/inbound-worker.ts`   | Add logging to swallowed catches   |
| `apps/runtime/src/services/queues/session-lock.ts`     | Add logging to lock failures       |
| `apps/runtime/src/services/session/session-service.ts` | Add logging to encryption failures |

### Tests

| File                                                                | Type        | Coverage Focus                 |
| ------------------------------------------------------------------- | ----------- | ------------------------------ |
| `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts` | fitness     | Error shape ratchets           |
| `apps/runtime/src/__tests__/classify-llm-error.test.ts`             | unit        | LLM error classification       |
| New: `apps/runtime/src/__tests__/error-response-shape.test.ts`      | integration | Standard shape enforcement     |
| New: `apps/runtime/src/__tests__/error-trace-events.test.ts`        | integration | Error code TraceEvent emission |
| New: `apps/runtime/src/__tests__/async-handler.test.ts`             | unit        | asyncHandler wrapper           |

---

## 11. Configuration

### Environment Variables

| Variable                   | Default        | Description                            |
| -------------------------- | -------------- | -------------------------------------- |
| `ERROR_INCLUDE_TRACE_ID`   | `true`         | Include W3C traceId in error responses |
| `ERROR_INCLUDE_REQUEST_ID` | `true`         | Include requestId in error responses   |
| `ERROR_DOCS_BASE_URL`      | `/docs/errors` | Base URL for error documentation links |

### Runtime Configuration

- Feature flag: `structured_errors` — enables new error response shape. Initially `true` for all tiers.
- No per-tenant configuration — error response shape is platform-wide.

### DSL / Agent IR / Schema

No DSL changes. The ABL `ON_ERROR` construct continues to work — it receives the classified error code in the `error` context variable, enabling agent authors to handle specific error types:

```abl
ON_ERROR(code: "TOOL_TIMEOUT") {
  RESPOND "The tool took too long. Let me try a different approach."
}
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                              |
| ----------------- | ------------------------------------------------------------------------------------------------------ |
| Project isolation | Error codes are not project-scoped. TraceEvents carrying error codes are scoped by projectId.          |
| Tenant isolation  | Error responses never leak tenantId or cross-tenant information. TraceEvents scoped by tenantId.       |
| User isolation    | Error responses never leak userId or user-specific details. Sensitive context logged server-side only. |

### Security & Compliance

- **Information leak elimination** (FR-13): Raw error messages from LLM providers, databases, and external services must be classified and replaced with registry messages. The original error is logged server-side only.
- **No stack traces in responses**: Stack traces are logged at `error` level, never included in HTTP or WS responses.
- **Audit trail**: Error codes in TraceEvents provide a compliance-friendly audit trail of all failures.
- **KMS admin fix**: The CRITICAL information leak in `kms-admin.ts` (sending raw error + tenantId to client) is fixed as a P0 security item.

### Performance & Scalability

- **Zero overhead for happy path**: Error classification only runs in error paths.
- **Registry is a compile-time constant**: No runtime lookups — the registry is a static object.
- **TraceEvent emission is async**: Error trace events use the existing fire-and-forget trace infrastructure.
- **No additional DB queries**: Error classification is pure in-memory pattern matching.

### Reliability & Failure Modes

- **Classifier fallback**: If `classifyLlmError()` or other classifiers encounter an unrecognized error, they fall back to `INTERNAL_ERROR` with the generic message — never crash.
- **Empty catch remediation**: Critical path catches (encryption, Redis locks, dedup) get debug logging but maintain their fail-open/fail-safe behavior — no behavioral change.
- **Middleware resilience**: The `asyncHandler` wrapper and global error handler must never throw — they are the last-resort error boundary.

### Observability

- **TraceEvents**: Every classified error emits a `severity: 'error'` TraceEvent with `{ code, message, category, source, retryable }`.
- **Metrics**: Prometheus counter `runtime_error_total{code, category, source}` for error rate dashboards.
- **debug_get_errors**: MCP tool returns structured `{ code, message, timestamp, source }` entries.
- **Structured logging**: All error paths use `createLogger` with context fields `{ errorCode, tenantId, sessionId, agentName }`.

### Data Lifecycle

- TraceEvents with error codes follow existing trace retention (7-365 days by plan tier).
- ClickHouse audit events with error codes follow existing audit retention.
- No new data stores or retention policies required.

---

## 13. Delivery Plan / Work Breakdown

1. **Error infrastructure (shared-kernel)**
   1.1 Add `StructuredError` interface to `shared-kernel/src/errors.ts`
   1.2 Create `ErrorRegistry` with all existing + new codes, categories, retryability, messageKeys, docsPaths
   1.3 Enhance `errorToResponse()` with duck-typing and traceId/requestId injection
   1.4 Add new i18n message templates for missing error codes
   1.5 Align `ToolExecutionError` with `StructuredError` interface

2. **Express error middleware (runtime)**
   2.1 Create `asyncHandler` wrapper in `middleware/async-handler.ts`
   2.2 Enhance global error handler in `server.ts` to inject traceId/requestId and use `ErrorRegistry`
   2.3 Add error code TraceEvent emission to global error handler
   2.4 Add `runtime_error_total` Prometheus counter

3. **Security fixes (P0)**
   3.1 Fix information leak in `kms-admin.ts` — stop sending raw error + tenantId
   3.2 Fix information leak in `clickhouse-diagnostics.ts` — sanitize ClickHouse errors
   3.3 Fix information leak in `channel-oauth.ts` — sanitize raw error.message
   3.4 Sanitize raw LLM provider errors in `chat.ts` error responses

4. **Critical bug fixes**
   4.1 Add `.catch()` to 11 unhandled async WS handlers in `handler.ts`
   4.2 Fix `decrementActiveSessions()` missing from WS error handler
   4.3 Add debug logging to silent encryption failure in `session-service.ts`
   4.4 Add debug logging to silent Redis lock/dedup failures in `session-lock.ts`, `inbound-worker.ts`
   4.5 Add debug logging to silent cross-pod delivery failures in `handler.ts`

5. **WebSocket error standardization**
   5.1 Standardize WS error shape to `{ type: 'error', code, message }` — remove `response_end` disguised errors
   5.2 Extend `isLlmError` pattern to cover all AppError codes (not just LLM) in WS handlers
   5.3 Replace raw `ws.send(JSON.stringify(...))` with `send()` helper throughout

6. **console.log to structured logger migration**
   6.1 Replace `console.*` in `trace-store.ts` (11 instances)
   6.2 Replace `console.*` in `clickhouse-audit-store.ts` (2 instances)
   6.3 Replace `console.*` in `agent-registry-adapter.ts` (4 instances)
   6.4 Replace `console.*` in `redis-client.ts` (3 instances)
   6.5 Replace `console.*` in `dsl-utils.ts` (2 instances)
   6.6 Replace `console.*` in route files: `sessions.ts` (13), `device-auth.ts` (4), `agents.ts` (2), `contact-merge.ts` (3), `merge-suggestions.ts` (2), `auth.ts` (1)

7. **Error classifier extensions**
   7.1 Wire `MODEL_NOT_CONFIGURED` and `CREDENTIAL_DECRYPTION` into `classify-llm-error.ts` and `model-resolution.ts`
   7.2 Wire `TOOL_BINDING_FAILED`, `EXECUTION_TIMEOUT`, `HANDOFF_TARGET_MISSING`, `FLOW_STEP_ERROR` into execution chain
   7.3 Align `ToolExecutionError` codes with `ErrorRegistry` codes
   7.4 Update tool call failure results to include `{ code, message, retryable }` for AI agent consumption

8. **Architecture fitness tests**
   8.1 Add "non-standard error response shape count" metric (ceiling = current count)
   8.2 Add "route files with AppError/toErrorResponse usage" metric (floor = current count)
   8.3 Add "empty catch blocks in server code" metric (ceiling = current count)
   8.4 Tighten existing "console.log in server packages" ceiling (currently 170)

9. **Linting hooks**
   9.1 Create `error-response-shape-lint.sh` — blocks `res.json({ error: '<string>' })` (Shape A) in route files
   9.2 Create `error-response-flat-lint.sh` — blocks `res.json({ success: false, error: '<string>' })` (Shape B) in route files
   9.3 Update `empty-response-lint.sh` to also check for missing `code` field in error objects

10. **Route migration (incremental, ~20 commits)**
    10.1 Migrate Shape A files (12 files, 137 instances): `http-async-channel.ts`, `chat.ts`, `channel-webhooks.ts`, `voice.ts`, `device-auth.ts`, `kms-admin.ts`, `livekit.ts`, `sdk-init.ts`, `channel-audiocodes.ts`, `sdk.ts`, `auth.ts`, `callbacks.ts`
    10.2 Migrate Shape B files (49 files, 498 instances): Starting with highest-traffic routes — `sessions.ts`, `tenant-models.ts`, `platform-admin-tenants.ts`, `deployments.ts`, `environment-variables.ts`, etc.
    10.3 Audit remaining ~33 route files (of 94 total) that may use other shapes or have no error responses — categorize and migrate as needed
    10.4 Lower architecture fitness ratchet ceilings as files are migrated
    10.5 Replace `catch (error: any)` with proper type narrowing (59 instances across 12 files)

11. **Error documentation endpoint**
    11.1 Add `GET /api/v1/errors` endpoint returning registry entries
    11.2 Add `GET /api/v1/errors/:code` endpoint with troubleshooting steps

---

## 14. Success Metrics

| Metric                            | Baseline      | Target                                          | How Measured                                    |
| --------------------------------- | ------------- | ----------------------------------------------- | ----------------------------------------------- |
| Non-standard error response count | 668           | 0                                               | Architecture fitness test                       |
| Route files using AppError        | 0 of 94       | 94 of 94                                        | Architecture fitness test                       |
| Empty catch blocks (server)       | 30+           | 0                                               | Architecture fitness test                       |
| console.log in server code        | 170           | 0                                               | Architecture fitness test (existing)            |
| Error codes in TraceEvents        | 0%            | 100%                                            | ClickHouse query on trace events with errorCode |
| Mean time to diagnose (support)   | Unknown       | Measurable via error code search in Observatory | Manual observation                              |
| AI agent self-recovery rate       | 0% (no codes) | Measurable via retry-after-error trace patterns | ClickHouse analytics                            |
| Error information leaks           | 6             | 0                                               | Security review + PreToolUse hooks              |
| Unhandled WS promise rejections   | 11            | 0                                               | Code audit + fitness test                       |

---

## 15. Open Questions

1. Should the `ErrorRegistry` be a static TypeScript object or loaded from a JSON/YAML file for easier editing by non-developers?
2. Should error codes be versioned (e.g., `MODEL_RATE_LIMITED_V2`) or always backwards-compatible?
3. Should the `docsPath` field point to internal docs (repo) or external docs (docs site)? For self-hosted deployments, what's the base URL?
4. Should the error documentation endpoint (`/api/v1/errors`) be public (no auth) or require at minimum viewer role?
5. What is the rollout timeline for SDK WebSocket error shape changes — should we provide a deprecation period for the old `{ type: 'error', message }` shape?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                     | Severity | Status   |
| ------- | --------------------------------------------------------------------------------------------------------------- | -------- | -------- |
| GAP-001 | i18n ErrorCatalog and shared-kernel ErrorCodes have overlapping but disconnected code namespaces                | High     | Open     |
| GAP-002 | `MongoAppError` extends `Error` not `AppError` — duck-typing workaround needed until migrated                   | Medium   | Open     |
| GAP-003 | `AuthProfileError` extends `Error` not `AppError` — same duck-typing workaround                                 | Medium   | Open     |
| GAP-004 | SearchAI has 17 error classes (including abstract base) with their own code system — deferred to future release | Medium   | Deferred |
| GAP-005 | SDK clients parse `error` as string — breaking change accepted, SDK consumers must update                       | Medium   | Accepted |
| GAP-006 | 59 instances of `catch (error: any)` defeat TypeScript type narrowing                                           | Low      | Open     |
| GAP-007 | Voice error paths (AudioCodes, Twilio, KoreVG) have their own error conventions                                 | Medium   | Open     |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                           | Coverage Type | Status     | Test File / Note             |
| --- | ---------------------------------------------------------------------------------- | ------------- | ---------- | ---------------------------- |
| 1   | ErrorRegistry contains all existing ErrorCodes                                     | unit          | NOT TESTED | shared-kernel errors.test.ts |
| 2   | errorToResponse duck-types StructuredError interface                               | unit          | NOT TESTED | shared-kernel errors.test.ts |
| 3   | asyncHandler catches thrown AppError and calls next(err)                           | unit          | NOT TESTED | async-handler.test.ts        |
| 4   | Global error handler injects traceId and requestId                                 | integration   | NOT TESTED | error-response-shape.test.ts |
| 5   | LLM rate limit returns `{ success: false, error: { code: 'MODEL_RATE_LIMITED' } }` | e2e           | NOT TESTED | error-response-shape.test.ts |
| 6   | Tool timeout returns structured error to AI agent with retryable=true              | integration   | NOT TESTED | error-trace-events.test.ts   |
| 7   | TraceEvent emitted with errorCode on classified error                              | integration   | NOT TESTED | error-trace-events.test.ts   |
| 8   | WS error message includes code field                                               | integration   | NOT TESTED | ws error shape test          |
| 9   | Architecture fitness: non-standard shape count <= ceiling                          | fitness       | NOT TESTED | architecture-fitness.test.ts |
| 10  | Architecture fitness: AppError adoption >= floor                                   | fitness       | NOT TESTED | architecture-fitness.test.ts |
| 11  | Lint hook blocks `res.json({ error: 'string' })` in route files                    | manual        | NOT TESTED | Hook smoke test              |
| 12  | No error response leaks raw error messages or tenantId                             | e2e           | NOT TESTED | Security-focused E2E test    |
| 13  | Cross-tenant error does not leak resource existence (404 not 403)                  | e2e           | NOT TESTED | Existing isolation tests     |

### Testing Notes

E2E tests must exercise the real middleware chain — start an Express server on a random port, send requests that trigger known error paths (invalid auth, missing model, tool timeout), and assert the response shape matches the standard. No mocking of the error handling middleware.

Integration tests for TraceEvent emission must verify that error codes appear in the trace store after a classified error occurs.

Architecture fitness tests run in the shared-kernel test suite and scan the entire codebase at build time. They are the primary enforcement mechanism for the ratchet-based migration.

> Full testing details: [../testing/structured-error-framework.md](../testing/structured-error-framework.md)

---

## 18. References

- Design docs: `docs/reference/ERROR_HANDLING.md` (DSL-level error handling)
- Remediation specs: `docs/specs/unsafe-error-handling-phase1.changes.md`, `docs/specs/h3-h4-h6-swallowed-errors-console.changes.md`
- Related feature docs: [Tracing & Observability](tracing-observability.md), [Diagnostics Engine](diagnostics.md), [Observatory](observatory.md), [Rate Limiting](rate-limiting.md), [Model Hub](model-hub.md)
- Audit data: Runtime error handling audit (2026-03-25) — 4-agent parallel scan of routes, services, middleware/WS, and error infrastructure
