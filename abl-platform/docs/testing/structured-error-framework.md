# Test Specification: Structured Error Framework

**Feature Spec**: `docs/features/structured-error-framework.md`
**HLD**: N/A (not yet created)
**LLD**: N/A (not yet created)
**Status**: PLANNED
**Last Updated**: 2026-03-25

---

## 1. Coverage Matrix

| FR    | Description                                                   | Unit      | Integration | E2E     | Manual  | Status  |
| ----- | ------------------------------------------------------------- | --------- | ----------- | ------- | ------- | ------- |
| FR-1  | StructuredError interface in shared-kernel                    | PLANNED   | N/A         | N/A     | N/A     | PLANNED |
| FR-2  | ErrorRegistry maps all codes to metadata                      | PLANNED   | PLANNED     | N/A     | N/A     | PLANNED |
| FR-3  | errorToResponse duck-types StructuredError                    | PLANNED   | PLANNED     | PLANNED | N/A     | PLANNED |
| FR-4  | asyncHandler catches thrown errors, calls next(err)           | PLANNED   | PLANNED     | PLANNED | N/A     | PLANNED |
| FR-5  | Global error handler injects traceId/requestId                | N/A       | PLANNED     | PLANNED | N/A     | PLANNED |
| FR-6  | HTTP error response shape `{ success, error: { code, msg } }` | N/A       | PLANNED     | PLANNED | N/A     | PLANNED |
| FR-7  | WS error shape `{ type: 'error', code, message }`             | N/A       | PLANNED     | PLANNED | N/A     | PLANNED |
| FR-8  | Tool failures include `{ code, message, retryable }`          | PLANNED   | PLANNED     | PLANNED | N/A     | PLANNED |
| FR-9  | TraceEvent with errorCode emitted on classified error         | N/A       | PLANNED     | PLANNED | N/A     | PLANNED |
| FR-10 | Architecture fitness test ratchet metrics                     | N/A       | PLANNED     | N/A     | N/A     | PLANNED |
| FR-11 | Lint hook blocks Shape A inline errors                        | N/A       | N/A         | N/A     | PLANNED | PLANNED |
| FR-12 | Lint hook blocks Shape B flat string errors                   | N/A       | N/A         | N/A     | PLANNED | PLANNED |
| FR-13 | No information leaks in error responses                       | PLANNED   | PLANNED     | PLANNED | N/A     | PLANNED |
| FR-14 | Debug logging in empty catch blocks                           | PLANNED   | PLANNED     | N/A     | N/A     | PLANNED |
| FR-15 | console.\* replaced with createLogger                         | N/A       | PLANNED     | N/A     | N/A     | PLANNED |
| FR-16 | .catch() on all unhandled WS async handlers                   | N/A       | PLANNED     | PLANNED | N/A     | PLANNED |
| FR-17 | Unused ErrorCodes wired into execution chain                  | PLANNED   | PLANNED     | PLANNED | N/A     | PLANNED |
| FR-18 | classifyLlmError extended for MODEL_NOT_CONFIGURED            | PASS (16) | PLANNED     | PLANNED | N/A     | PARTIAL |

### Existing Test Baseline

| Test File                                                           | Tests                | Coverage                                                                                                                                                                                                                         |
| ------------------------------------------------------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/classify-llm-error.test.ts`             | 16                   | classifyLlmError: 429, 401, 403, context, filter, timeout, 500+, fallback, cause, non-Error. isLlmError: all branches.                                                                                                           |
| `packages/shared-kernel/src/__tests__/errors.test.ts`               | 13 (49 with it.each) | ErrorCodes (12 new codes x3 parametrized), AppError (creation, statusCode, cause, messages), ValidationError, toErrorResponse, errorToResponse (AppError, Error, string, null).                                                  |
| `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts` | 20                   | Ratchet metrics: console.log ceiling (170), findById ceiling (48), package structure, circular deps, workspace count, Dockerfile coverage, STI paths. Does NOT yet cover error shape count, AppError adoption, or empty catches. |

### Risk-Based Test Priority

| Risk Tier    | FRs                                                                                   | Rationale                                                                      |
| ------------ | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| **CRITICAL** | FR-13 (security leaks), FR-16 (WS rejections)                                         | Active vulnerabilities: 6 information leaks, 11 unhandled promise rejections.  |
| **HIGH**     | FR-3 (duck-typing), FR-5 (traceId), FR-8 (tool errors to AI)                          | FR-3 bridges 6 error hierarchies. FR-5 is OTEL. FR-8 enables AI self-recovery. |
| **MEDIUM**   | FR-6/FR-7 (shape migration), FR-10 (fitness), FR-17 (unused codes)                    | Bulk migration (668 instances), enforcement infra, code wiring.                |
| **LOWER**    | FR-1/FR-2 (registry), FR-4 (asyncHandler), FR-11/FR-12 (hooks), FR-14/FR-15 (logging) | Well-understood patterns, mechanical replacements.                             |

---

## 2. E2E Test Scenarios (MANDATORY)

CRITICAL: E2E tests must exercise the real system through its HTTP API. No mocks, no direct DB access, no stubbed servers. Only external LLM providers may be mocked via dependency injection at the Vercel AI SDK provider boundary.

### E2E-1: LLM rate limit returns standard error shape via HTTP

- **Preconditions**: Runtime server started on random port via `RuntimeApiHarness`. Real auth middleware, real MongoDB (MongoMemoryServer). Tenant with project, deployed agent, and LLM model config seeded via `bootstrapProject()`. LLM provider injected via DI to return 429.
- **Steps**:
  1. `devLogin()` as tenant owner, get auth headers
  2. Create session: `POST /api/projects/:projectId/sessions` with `{ agentName }` -> 201
  3. Send message: `POST /api/projects/:projectId/chat/complete` with `{ sessionId, message: 'Hello' }`
  4. LLM provider responds with `{ status: 429, message: 'Rate limit exceeded' }`
  5. Assert response status is 429
  6. Assert response body: `{ success: false, error: { code: 'MODEL_RATE_LIMITED', message: expect.stringContaining('AI Model Error') } }`
  7. Assert `traceId` field is present (string, non-empty)
  8. Assert `requestId` field is present
  9. Assert response body does NOT contain `"Rate limit exceeded"` raw provider text (sanitized via registry)
  10. Assert response body does NOT contain `tenantId`, `apiKey`, or any internal identifiers
- **Expected Result**: Standard error shape with `MODEL_RATE_LIMITED` code, sanitized message, traceId present
- **Auth Context**: Tenant owner with valid JWT, project member
- **Isolation Check**: N/A (single-tenant scenario)
- **Covers**: FR-5, FR-6, FR-9, FR-13, FR-18

### E2E-2: Invalid LLM credentials returns classified error

- **Preconditions**: Runtime server started. Tenant with agent configured with invalid/expired API key.
- **Steps**:
  1. Seed agent with model config pointing to invalid credential
  2. `POST /api/projects/:projectId/chat/complete` with valid user auth, message triggering LLM call
  3. LLM provider responds with 401
  4. Assert response status is 401
  5. Assert `error.code` is `CREDENTIAL_NOT_FOUND`
  6. Assert `error.message` contains `"credentials are invalid or expired"`
  7. Assert response does NOT contain the raw API key string, provider name, or internal credential ID
  8. Assert response does NOT contain stack trace or file paths
- **Expected Result**: Credential error classified, sanitized, no raw key leaks
- **Auth Context**: Tenant owner with valid JWT
- **Isolation Check**: Credential details not leaked
- **Covers**: FR-6, FR-13, FR-18

### E2E-3: Validation error returns standard shape with BAD_REQUEST

- **Preconditions**: Runtime server started with full middleware chain.
- **Steps**:
  1. `POST /api/projects/:projectId/sessions` with empty body `{}` (missing required `agentName`)
  2. Assert response status is 400
  3. Assert response body: `{ success: false, error: { code: 'BAD_REQUEST', message: expect.any(String) } }`
  4. Assert response does NOT contain `"stack"`, `"at "`, `/Users/`, or `node_modules`
  5. `POST /api/projects/:projectId/sessions` with `{ agentName: '' }` (empty string)
  6. Assert response status is 400
  7. Assert `error.code` is `BAD_REQUEST` or `VALIDATION_ERROR`
- **Expected Result**: Validation errors produce standard shape, no internals leaked
- **Auth Context**: Tenant owner with valid JWT, project member
- **Isolation Check**: N/A
- **Covers**: FR-4, FR-6

### E2E-4: Cross-tenant access returns 404 (not 403) with standard shape

- **Preconditions**: Two tenants seeded via two `bootstrapProject()` calls. Tenant A creates a session.
- **Steps**:
  1. `devLogin()` as Tenant A owner, create session: `POST /api/projects/:projectIdA/sessions` -> 201, capture `sessionId`
  2. `devLogin()` as Tenant B owner
  3. `GET /api/projects/:projectIdA/sessions/:sessionId` with Tenant B auth headers
  4. Assert response status is 404 (NOT 403)
  5. Assert response body: `{ success: false, error: { code: 'NOT_FOUND', message: expect.any(String) } }`
  6. Assert response body does NOT contain `tenantId`, `projectId`, `sessionId`, or any hint that the resource exists
  7. Assert response body does NOT contain `"access denied"`, `"permission"`, or `"forbidden"` (which would hint existence)
- **Expected Result**: 404 with standard shape, zero information leakage
- **Auth Context**: Tenant B owner JWT accessing Tenant A resources
- **Isolation Check**: Cross-tenant returns 404, no existence leak
- **Covers**: FR-6, FR-13

### E2E-5: WebSocket error message includes structured code

- **Preconditions**: Runtime WS server started on random port. Tenant with agent seeded. LLM provider injected to throw timeout error.
- **Steps**:
  1. Connect to WebSocket with valid auth token
  2. Send `new_session` message with valid `{ agentName }`
  3. Send `user_message` with `{ sessionId, message: 'trigger timeout' }`
  4. LLM provider throws `{ code: 'ABORT_ERR', message: 'The operation was aborted' }`
  5. Capture WS message of `type: 'error'`
  6. Assert WS message has `code` field: `'MODEL_TIMEOUT'`
  7. Assert WS message has `message` field: `expect.stringContaining('timed out')`
  8. Assert WS message does NOT have `type: 'response_end'` disguising the error
  9. Assert WS message does NOT contain raw abort error details or stack traces
- **Expected Result**: WS error with structured `{ type: 'error', code, message }`
- **Auth Context**: Tenant owner via WS auth handshake
- **Isolation Check**: No cross-tenant data in error
- **Covers**: FR-7, FR-13

### E2E-6: Tool execution timeout returns retryable error to AI agent

- **Preconditions**: Runtime server started. Agent configured with a tool that has a very short timeout (e.g., 1ms). LLM provider injected to return a tool call to that tool.
- **Steps**:
  1. Seed agent with tool definition (HTTP tool pointing to a slow/unreachable endpoint)
  2. `POST /api/projects/:projectId/chat/complete` with message that triggers tool call
  3. Tool execution times out
  4. Assert HTTP response includes the tool failure in the conversation
  5. Assert the tool result visible in traces contains: `{ code: 'TOOL_TIMEOUT', retryable: true }`
  6. Assert the AI agent's subsequent reasoning (if any) can see the structured error
  7. `GET /api/projects/:projectId/sessions/:sessionId/traces` -> verify TraceEvent with `data.errorCode: 'TOOL_TIMEOUT'` exists
- **Expected Result**: Tool timeout produces structured error with retryable flag; TraceEvent emitted
- **Auth Context**: Tenant owner
- **Isolation Check**: Tool error does not leak internal endpoint URL
- **Covers**: FR-8, FR-9, FR-17

### E2E-7: Error responses never leak stack traces or internal paths

- **Preconditions**: Runtime server started with `NODE_ENV=production` equivalent settings.
- **Steps**:
  1. Trigger a 500 error by sending request to an endpoint where the handler throws an unclassified `Error('internal failure')`
  2. Assert response status is 500
  3. Assert response body: `{ success: false, error: { code: 'INTERNAL_ERROR', message: expect.any(String) } }`
  4. Assert response body serialized to string does NOT contain `"at "`, `"/Users/"`, `"/home/"`, `"node_modules"`, `".ts:"`, `".js:"`
  5. Assert response body does NOT contain the original `'internal failure'` text (sanitized to generic message)
  6. Verify server-side logs DO contain the full stack trace (check log capture)
- **Expected Result**: No stack traces or file paths in client response; full details logged server-side
- **Auth Context**: Tenant owner
- **Isolation Check**: No internal infrastructure details leaked
- **Covers**: FR-6, FR-13

### E2E-8: Missing auth returns UNAUTHORIZED with standard shape

- **Preconditions**: Runtime server started with real auth middleware.
- **Steps**:
  1. `GET /api/projects/:projectId/sessions` with NO `Authorization` header
  2. Assert response status is 401
  3. Assert response body: `{ success: false, error: { code: 'UNAUTHORIZED', message: expect.any(String) } }`
  4. Assert response body does NOT contain raw JWT error details or middleware internals
  5. `GET /api/projects/:projectId/sessions` with `Authorization: Bearer invalid-token-xyz`
  6. Assert response status is 401
  7. Assert `error.code` is `UNAUTHORIZED`
  8. Assert response does NOT contain the token string `'invalid-token-xyz'`
- **Expected Result**: Auth errors use standard shape, no token/middleware leaks
- **Auth Context**: No auth / invalid auth
- **Isolation Check**: N/A
- **Covers**: FR-6, FR-13

### E2E-9: KMS admin endpoint does not leak tenantId or raw errors (regression)

- **Preconditions**: Runtime server started. Tenant seeded. KMS endpoints available.
- **Steps**:
  1. `POST /api/projects/:projectId/kms/...` with request that triggers an error (e.g., invalid key operation)
  2. Assert response uses standard error shape
  3. Assert response body serialized to string does NOT contain any tenantId UUID
  4. Assert response body does NOT contain raw KMS error messages or internal key identifiers
  5. Verify the fix from delivery plan 3.1 holds — this is a regression test for a P0 security fix
- **Expected Result**: KMS errors sanitized, no tenantId leak
- **Auth Context**: Tenant admin
- **Isolation Check**: No tenantId in error response body
- **Covers**: FR-13

### E2E-10: Rate limit error uses standard shape

- **Preconditions**: Runtime server started with rate limiting enabled. Tenant with low rate limit configured (or temporarily reduced for testing).
- **Steps**:
  1. Send requests in rapid succession to exceed rate limit
  2. Assert the rate-limited response has status 429
  3. Assert response body: `{ success: false, error: { code: 'TOO_MANY_REQUESTS', message: expect.any(String) } }`
  4. Assert standard rate limit headers present (`Retry-After` or `X-RateLimit-*`)
  5. Assert response does NOT use the old flat `{ error: 'string' }` shape
- **Expected Result**: Rate limit errors migrated to standard shape
- **Auth Context**: Tenant owner
- **Isolation Check**: Rate limit scoped to tenant, no cross-tenant counter leak
- **Covers**: FR-6

---

## 3. Integration Test Scenarios (MANDATORY)

### INT-1: asyncHandler catches thrown AppError and produces standard response

- **Boundary**: `asyncHandler` middleware -> Express global error handler -> `errorToResponse()`
- **Setup**: Minimal Express app with `asyncHandler`-wrapped route that throws `new AppError('Not found', ErrorCodes.NOT_FOUND)`. Global error handler registered.
- **Steps**:
  1. `GET /test-route` -> handler throws AppError
  2. Assert response status is 404
  3. Assert response body: `{ success: false, error: { code: 'NOT_FOUND', message: 'Not found' } }`
  4. Test with async handler that throws after `await`: `asyncHandler(async (req, res) => { await delay(1); throw new AppError('Timeout', ErrorCodes.EXECUTION_TIMEOUT); })`
  5. Assert response status is 504
  6. Test with handler that rejects a promise (not throws): verify asyncHandler catches it
- **Expected Result**: All async error paths produce standard response shape
- **Failure Mode**: If asyncHandler doesn't catch, Express returns raw 500 HTML page
- **Covers**: FR-4

### INT-2: errorToResponse duck-types StructuredError from non-AppError hierarchies

- **Boundary**: `errorToResponse()` -> StructuredError duck-typing
- **Setup**: Import `errorToResponse` from shared-kernel. Create instances of each non-AppError hierarchy.
- **Steps**:
  1. Create `MongoAppError` with `{ code: 'DUPLICATE_KEY' }` — verify duck-typing extracts code and falls back to 500 for statusCode (MongoAppError has no `statusCode` property)
  2. Create `AuthProfileError` with `{ code: 'PROFILE_EXPIRED', statusCode: 401 }` — verify duck-typing extracts both code and statusCode
  3. Create `ToolExecutionError` with `{ code: 'TOOL_TIMEOUT', statusCode: 504, retryable: true }` — verify code, statusCode, and retryable extracted
  4. Create plain `Error('unknown')` — verify fallback to `{ code: 'INTERNAL_ERROR', statusCode: 500 }`
  5. Pass `null` — verify fallback to INTERNAL_ERROR
  6. Pass `'string error'` — verify fallback with string as message
  7. Create error with `code` but no `statusCode` — verify statusCode defaults to 500
  8. Create error with `statusCode` but no `code` — verify code defaults to INTERNAL_ERROR
- **Expected Result**: Duck-typing handles all 6 error hierarchies + edge cases
- **Failure Mode**: Non-AppError hierarchies produce `INTERNAL_ERROR` instead of their actual code
- **Covers**: FR-3

### INT-3: TraceEvent emitted with errorCode on classified error

- **Boundary**: Error classifier -> TraceEmitter -> TraceStore
- **Setup**: Express app with real `TraceStore` (in-memory implementation, NOT a mock). Route that triggers `classifyLlmError()` for a 429 error. Global error handler emits TraceEvent on error.
- **Steps**:
  1. Send request that triggers LLM 429 error
  2. Wait for async TraceEvent emission (may need small delay)
  3. Query TraceStore: `getEvents(sessionId)` where `severity === 'error'`
  4. Assert event exists with `data.errorCode: 'MODEL_RATE_LIMITED'`
  5. Assert event has `data.errorCategory: 'llm'`
  6. Assert event has `data.errorRetryable: true`
  7. Assert event has `data.errorSource` (e.g., `'anthropic'`)
  8. Assert event has `data.errorMessage` (human-readable)
  9. Repeat for 401 error -> `CREDENTIAL_NOT_FOUND`, category `'auth'`, retryable `false`
  10. Repeat for timeout error -> `MODEL_TIMEOUT`, retryable `true`
- **Expected Result**: Each error classification produces a correctly-tagged TraceEvent
- **Failure Mode**: TraceStore receives events without errorCode fields, Observatory can't filter
- **Covers**: FR-9

### INT-4: ErrorRegistry contains all declared ErrorCodes and is consistent

- **Boundary**: `ErrorRegistry` -> `ErrorCodes` -> i18n `ErrorCatalog`
- **Setup**: Import `ErrorRegistry`, `ErrorCodes` from shared-kernel and `ErrorCatalog` from i18n.
- **Steps**:
  1. Enumerate all keys in `ErrorCodes` (currently 28 entries)
  2. Assert every code has a corresponding entry in `ErrorRegistry`
  3. Assert every registry entry has required fields: `code`, `statusCode`, `category`, `retryable` (boolean), `messageKey`
  4. Assert `category` is one of: `'llm'`, `'tool'`, `'auth'`, `'infra'`, `'validation'`, `'tenant'`, `'deployment'`, `'session'`
  5. Assert no duplicate `code` values in registry
  6. Assert every `messageKey` resolves to a non-empty i18n template in `ErrorCatalog`
  7. Assert `statusCode` in registry matches `statusCode` in ErrorCodes for every entry
  8. Assert registry does not contain entries not in ErrorCodes (no orphans)
- **Expected Result**: Registry is complete, consistent with ErrorCodes, and all message keys resolve
- **Failure Mode**: Missing registry entries cause runtime lookups to return undefined
- **Covers**: FR-2

### INT-5: Architecture fitness tests detect non-standard error shapes (ratchet)

- **Boundary**: Filesystem scanner -> ratchet metric -> test assertion
- **Setup**: Run architecture fitness test suite against the codebase.
- **Steps**:
  1. Run the "non-standard error response shape count" fitness test
  2. Assert count <= ceiling (initially set to current count, e.g., 668)
  3. Run the "route files using AppError/toErrorResponse" fitness test
  4. Assert count >= floor (initially 0, rising as routes are migrated)
  5. Run the "empty catch blocks in server code" fitness test
  6. Assert count <= ceiling (initially 30+)
  7. Verify that migrating one route file and re-running shows the shape count decrease by the number of migrated responses
  8. Verify that adding a new non-standard response in a test file does NOT trigger (fitness tests scan routes, not test files)
- **Expected Result**: Ratchet metrics accurately track migration progress
- **Failure Mode**: Regex patterns miss some non-standard shapes, count is lower than reality
- **Covers**: FR-10

### INT-6: Global error handler injects traceId from OTEL/W3C context

- **Boundary**: Express middleware -> OTEL context -> global error handler -> response
- **Setup**: Express app with OTEL trace context propagation and enhanced global error handler.
- **Steps**:
  1. Send request with `traceparent: 00-{traceId}-{spanId}-01` header
  2. Route handler throws `new AppError('Bad input', ErrorCodes.BAD_REQUEST)`
  3. Assert response body includes `traceId` matching the trace ID from the `traceparent` header
  4. Assert response body includes `requestId` (Express-generated or UUID)
  5. Send request WITHOUT `traceparent` header, trigger error
  6. Assert response body `traceId` is either absent or a new generated trace ID (not null/undefined string)
  7. Assert `requestId` is still present regardless of traceparent
- **Expected Result**: W3C trace context flows through to error responses for debugging
- **Failure Mode**: traceId is always undefined, making it impossible to correlate errors with traces
- **Covers**: FR-5

### INT-7: WS concurrent error handling — no unhandled rejections

- **Boundary**: WebSocket handler -> `.catch()` handlers -> session cleanup
- **Setup**: WS server on random port. Agent configured. LLM provider injected to always throw.
- **Steps**:
  1. Connect WS client
  2. Start session via `new_session` message
  3. Fire 10 concurrent `user_message` messages rapidly (all will trigger LLM errors)
  4. Collect all WS messages received
  5. Assert all error messages have `type: 'error'` with `code` field
  6. Assert NO unhandled promise rejection events occurred (attach `process.on('unhandledRejection')` listener)
  7. Assert active session count after all errors is 0 (sessions properly decremented)
  8. Assert WS connection is still open (errors don't crash the connection)
  9. Close WS client, assert clean shutdown
- **Expected Result**: Concurrent errors handled gracefully, no resource leaks
- **Failure Mode**: Unhandled rejection crashes WS handler, session count leaks, connection drops
- **Covers**: FR-16

### INT-8: Tool call failure result includes structured error for AI agent

- **Boundary**: Tool execution -> `ToolExecutionError` -> tool result formatting -> AI agent context
- **Setup**: Express app with agent that has a tool binding. Tool configured to fail with known error.
- **Steps**:
  1. Trigger agent execution where tool call will fail (e.g., HTTP tool targeting unreachable endpoint)
  2. Intercept the tool result that gets passed back to the AI model
  3. Assert tool result has `is_error: true`
  4. Parse the `content[0].text` as JSON
  5. Assert parsed content: `{ code: 'TOOL_TIMEOUT', message: expect.any(String), retryable: true }`
  6. Repeat with a tool that fails due to binding error -> assert `code: 'TOOL_BINDING_FAILED'`, `retryable: false`
  7. Repeat with a generic tool error -> assert `code` is a valid ErrorRegistry code
- **Expected Result**: AI agent receives machine-readable error codes in tool results
- **Failure Mode**: Tool failures return unstructured strings, AI agent cannot self-recover
- **Covers**: FR-8, FR-17

### INT-9: Remediated empty catch blocks log at debug level without behavior change

- **Boundary**: Critical path catch blocks -> `createLogger` -> log output
- **Setup**: Runtime services with remediated catch blocks. Log capture mechanism.
- **Steps**:
  1. Trigger encryption failure in `session-service.ts` (e.g., corrupted key)
  2. Assert `log.debug` or `log.warn` was called with error context `{ errorCode, message }`
  3. Assert the fail-open behavior is preserved (session still works, just without encryption)
  4. Trigger Redis lock failure in `session-lock.ts`
  5. Assert debug logging occurred
  6. Assert lock acquisition still returns the fail-open result
  7. Trigger cross-pod delivery failure in `handler.ts`
  8. Assert debug logging occurred
  9. Assert message delivery falls back to local handling
  10. Trigger dedup failure in `inbound-worker.ts` (e.g., Redis SETNX failure)
  11. Assert debug logging occurred
  12. Assert message is still processed (dedup fail-open behavior preserved)
- **Expected Result**: Logging added without changing fail-open/fail-safe behavior
- **Failure Mode**: Adding logging accidentally changes control flow, breaking fail-open behavior
- **Covers**: FR-14

### INT-10: console.\* replaced with createLogger — no regressions

- **Boundary**: Server modules -> `createLogger` -> structured log output
- **Setup**: Run targeted tests for modules that had console.\* replaced.
- **Steps**:
  1. Import `trace-store.ts` — verify no `console.log/warn/error` calls remain (11 instances replaced)
  2. Import `clickhouse-audit-store.ts` — verify 2 instances replaced
  3. Import `redis-client.ts` — verify 3 instances replaced
  4. Trigger error paths in each module, assert `createLogger` output format: `{ level, message, context: { ... } }`
  5. Run architecture fitness test: assert console.log ceiling has been lowered from 170
  6. Verify log levels are appropriate: `console.error` -> `log.error`, `console.warn` -> `log.warn`, `console.log` -> `log.info` or `log.debug`
- **Expected Result**: All server-side console calls use structured logger
- **Failure Mode**: Logger initialization fails silently, losing log output entirely
- **Covers**: FR-15

---

## 4. Unit Test Scenarios

### UT-1: StructuredError interface type compliance

- **Module**: `packages/shared-kernel/src/errors.ts`
- **Input**: Objects with various combinations of `code`, `statusCode`, `message`, `retryable`
- **Tests**:
  1. `AppError` satisfies `StructuredError` interface (has all required fields)
  2. `ToolExecutionError` with `statusCode` satisfies `StructuredError`
  3. Plain object `{ code: 'X', statusCode: 400, message: 'Y' }` satisfies `StructuredError`
  4. Object missing `code` does NOT satisfy (TypeScript compile-time check)
  5. Object missing `statusCode` does NOT satisfy
- **Covers**: FR-1

### UT-2: classifyLlmError extended — MODEL_NOT_CONFIGURED and CREDENTIAL_DECRYPTION

- **Module**: `apps/runtime/src/services/llm/classify-llm-error.ts`
- **Input**: Error objects matching model-not-configured and credential-decryption patterns
- **Tests**:
  1. Error with message `"No model configured for agent"` -> `MODEL_NOT_CONFIGURED`
  2. Error with message `"Failed to decrypt credential"` -> `CREDENTIAL_DECRYPTION`
  3. Error from `model-resolution.ts` with `code: 'MODEL_NOT_FOUND'` -> `MODEL_NOT_CONFIGURED`
  4. Error from `model-resolution.ts` with `code: 'DECRYPTION_FAILED'` -> `CREDENTIAL_DECRYPTION`
  5. Verify these new patterns don't interfere with existing classifications (run all 16 existing tests)
- **Covers**: FR-18

### UT-3: ErrorRegistry lookup and validation

- **Module**: `packages/shared-kernel/src/errors.ts`
- **Input**: Error code strings
- **Tests**:
  1. `getRegistryEntry('MODEL_RATE_LIMITED')` returns `{ code, statusCode: 429, category: 'llm', retryable: true, messageKey, docsPath }`
  2. `getRegistryEntry('NOT_FOUND')` returns `{ statusCode: 404, category: 'validation', retryable: false }`
  3. `getRegistryEntry('NONEXISTENT_CODE')` returns `undefined` or fallback entry
  4. Every `retryable` field is explicitly `true` or `false` (never undefined)
  5. Every `category` is a valid category string
- **Covers**: FR-2

### UT-4: asyncHandler wrapper

- **Module**: `apps/runtime/src/middleware/async-handler.ts`
- **Input**: Various async/sync route handlers
- **Tests**:
  1. Sync handler that throws -> `next(err)` called with the error
  2. Async handler that rejects -> `next(err)` called
  3. Async handler that resolves -> response sent normally, `next` not called with error
  4. Handler that calls `res.send()` then throws -> no double-response (verify `headersSent` check)
  5. Handler that throws non-Error (string) -> `next()` still called
  6. Nested async operations that reject -> outermost rejection caught
- **Covers**: FR-4

### UT-5: Non-Error input handling in classifiers

- **Module**: `classify-llm-error.ts`, `errorToResponse()`
- **Input**: Non-standard error types: `null`, `undefined`, `42`, `{ weird: 'object' }`, `Symbol('err')`
- **Tests**:
  1. Each non-standard input produces a valid AppError (never throws)
  2. Message is extracted via `String(input)` when not an Error instance
  3. Code defaults to `MODEL_API_ERROR` (classifyLlmError) or `INTERNAL_ERROR` (errorToResponse)
- **Covers**: FR-3, FR-18

---

## 5. Security & Isolation Tests

### SEC-1: Error responses never contain tenantId

- **Type**: E2E + static analysis
- **Steps**:
  1. Trigger errors across 5+ different endpoints (sessions, chat, agents, deployments, kms)
  2. For each error response, JSON.stringify the body and assert it does NOT match `/[0-9a-f]{8}-[0-9a-f]{4}.*tenantId/i`
  3. Assert the response body does NOT contain the seeded tenant's actual UUID
  4. Static analysis: grep all `res.json` and `res.status` calls in route files for `tenantId` in response construction

### SEC-2: Error responses never contain raw provider error messages

- **Type**: Integration
- **Steps**:
  1. Inject LLM provider that returns `{ status: 500, message: 'Internal: connection to gpu-cluster-7.anthropic.internal failed' }`
  2. Assert error response message does NOT contain `'gpu-cluster-7'`, `'anthropic.internal'`, or the raw message
  3. Assert response uses registry message: `'AI Model Error: The AI provider returned a server error.'`
  4. Verify server-side log DOES contain the raw message for debugging

### SEC-3: KMS admin tenantId leak regression test

- **Type**: E2E
- **Steps**:
  1. Trigger KMS error via `POST /api/projects/:projectId/kms/rotate` with invalid parameters
  2. Assert response body JSON.stringify does NOT match the seeded tenant UUID
  3. Assert response body does NOT contain raw KMS error stack or internal key IDs

### SEC-4: ClickHouse diagnostics does not leak connection strings

- **Type**: Integration
- **Steps**:
  1. Trigger ClickHouse diagnostics error (e.g., connection timeout)
  2. Assert response does NOT contain `'clickhouse://'`, internal hostnames, or port numbers
  3. Assert response uses generic `'Diagnostics service unavailable'` message

### SEC-5: Error responses never contain stack traces

- **Type**: E2E
- **Steps**:
  1. Trigger 5 different error types (validation, auth, LLM, tool, internal)
  2. For each response, assert body string does NOT match `/^\s+at\s+/m` (stack trace line pattern)
  3. Assert no file paths matching `/[a-zA-Z]:\\|\/[a-z]+\/[a-z]+\//` (Windows or Unix paths)

### SEC-6: Cross-project access returns 404 with standard shape

- **Type**: E2E
- **Steps**:
  1. Tenant A creates Project X and Project Y
  2. User with access only to Project X requests resource in Project Y
  3. Assert response status is 404 (not 403)
  4. Assert standard error shape with `NOT_FOUND` code
  5. Assert no project ID or resource details leaked

### SEC-7: Cross-user isolation — User B cannot access User A's session error details

- **Type**: E2E
- **Steps**:
  1. Seed tenant with Project P. Create User A (owner) and User B (editor role, restricted)
  2. User A creates session via `POST /api/projects/:projectId/sessions` -> capture `sessionIdA`
  3. User A triggers an error in that session (e.g., LLM rate limit)
  4. `devLogin()` as User B (same tenant, same project, different userId)
  5. User B attempts `GET /api/projects/:projectId/sessions/:sessionIdA` with their auth headers
  6. Assert response status is 404 (not 403) — User B cannot access User A's session
  7. Assert response body uses standard error shape with `NOT_FOUND` code
  8. Assert response body does NOT contain User A's userId, session error details, or any hint of session existence
  9. Assert no error context from User A's execution is leaked in the error response

---

## 6. Performance & Load Tests

### PERF-1: Error classification overhead is negligible

- **Type**: Unit benchmark
- **Steps**:
  1. Time 1000 invocations of `classifyLlmError()` with various error types
  2. Assert mean time per classification < 1ms
  3. Assert no memory accumulation (no Maps/Sets growing)

### PERF-2: Concurrent WS errors under load

- **Type**: Integration stress
- **Steps**:
  1. Connect 10 WS clients simultaneously
  2. Each client sends 50 messages that all trigger errors
  3. Assert all 500 error responses received
  4. Assert no unhandled rejections
  5. Assert active session counts are all zero after cleanup
  6. Assert total time < 30s

---

## 7. Test Infrastructure

### Required Services

| Service   | Purpose                           | How Provided                                                       |
| --------- | --------------------------------- | ------------------------------------------------------------------ |
| MongoDB   | Session/tenant/project/agent data | MongoMemoryServer (v7.0.20, 30s launch timeout)                    |
| Express   | HTTP API endpoints                | `RuntimeApiHarness` (random port)                                  |
| WebSocket | WS error testing                  | WS server via `RuntimeApiHarness`                                  |
| Redis     | Rate limit error testing only     | Docker Compose or skip (HybridRateLimiter falls back to in-memory) |

### Data Seeding

Use `channel-e2e-bootstrap.ts` helpers:

- `bootstrapProject()` — creates tenant + project + owner user + dev login
- `devLogin()` — authenticates and returns JWT
- `authHeaders()` — constructs Authorization header
- `requestJson()` — HTTP request helper with JSON parsing
- `addMember()` — adds viewer/editor to project

### LLM Provider Mocking

LLM providers are the ONLY external dependency mocked, via dependency injection at the Vercel AI SDK provider boundary:

- Inject a test provider that returns controlled responses (429, 401, timeout, tool call, success)
- Never mock `classifyLlmError`, `errorToResponse`, `asyncHandler`, or any codebase component

### Environment Variables

```
NODE_ENV=test
JWT_SECRET=test-secret-64-chars-long-0123456789abcdef0123456789abcdef
ERROR_INCLUDE_TRACE_ID=true
ERROR_INCLUDE_REQUEST_ID=true
MONGODB_URI=<MongoMemoryServer URI>
```

### CI Configuration

- Unit tests: `vitest.config.ts` (no external dependencies)
- Integration tests: `vitest.integration.config.ts` (MongoMemoryServer, optional Redis)
- Architecture fitness tests: run in `packages/shared-kernel` test suite
- Linting hook tests: manual verification (not CI-automated)

---

## 8. Test File Mapping

| Test File                                                                   | Type        | Covers                                                        | Status                                 |
| --------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------- | -------------------------------------- |
| `packages/shared-kernel/src/__tests__/errors.test.ts`                       | unit        | FR-1, FR-2, FR-3 (extend existing)                            | EXISTS (13 it-calls / 49 with it.each) |
| `packages/shared-kernel/src/__tests__/architecture-fitness.test.ts`         | fitness     | FR-10 (add new metrics)                                       | EXISTS (20 tests)                      |
| `apps/runtime/src/__tests__/classify-llm-error.test.ts`                     | unit        | FR-18 (extend existing)                                       | EXISTS (16 tests)                      |
| `apps/runtime/src/__tests__/async-handler.test.ts`                          | unit        | FR-4 (INT-1)                                                  | NEW                                    |
| `apps/runtime/src/__tests__/error-response-shape.e2e.test.ts`               | e2e         | FR-5, FR-6, FR-13 (E2E-1 through E2E-4, E2E-7, E2E-8, E2E-10) | NEW                                    |
| `apps/runtime/src/__tests__/error-ws-shape.e2e.test.ts`                     | e2e         | FR-7, FR-16 (E2E-5)                                           | NEW                                    |
| `apps/runtime/src/__tests__/error-tool-codes.e2e.test.ts`                   | e2e         | FR-8, FR-17 (E2E-6)                                           | NEW                                    |
| `apps/runtime/src/__tests__/error-security.e2e.test.ts`                     | e2e         | FR-13 (E2E-9, SEC-1 through SEC-7)                            | NEW                                    |
| `apps/runtime/src/__tests__/integration/error-async-handler.test.ts`        | integration | FR-4 (INT-1)                                                  | NEW                                    |
| `apps/runtime/src/__tests__/integration/error-trace-events.test.ts`         | integration | FR-9 (INT-3)                                                  | NEW                                    |
| `apps/runtime/src/__tests__/integration/error-registry-consistency.test.ts` | integration | FR-2 (INT-4)                                                  | NEW                                    |
| `apps/runtime/src/__tests__/integration/error-duck-typing.test.ts`          | integration | FR-3 (INT-2)                                                  | NEW                                    |
| `apps/runtime/src/__tests__/integration/error-global-handler.test.ts`       | integration | FR-5 (INT-6)                                                  | NEW                                    |
| `apps/runtime/src/__tests__/integration/error-ws-concurrent.test.ts`        | integration | FR-16 (INT-7)                                                 | NEW                                    |
| `apps/runtime/src/__tests__/integration/error-tool-results.test.ts`         | integration | FR-8 (INT-8)                                                  | NEW                                    |
| `apps/runtime/src/__tests__/integration/error-catch-remediation.test.ts`    | integration | FR-14 (INT-9)                                                 | NEW                                    |
| `apps/runtime/src/__tests__/integration/error-logger-migration.test.ts`     | integration | FR-15 (INT-10)                                                | NEW                                    |

---

## 9. Open Testing Questions

1. **MongoAppError duck-typing**: `MongoAppError.code` uses a `MongoErrorCode` enum (`DUPLICATE_KEY`, `TIMEOUT`), not an HTTP-style code. How should the duck-typing map these? Should there be a `MongoErrorCode → ErrorRegistry code` translation layer, or should `MongoAppError` be updated to use ErrorRegistry codes?

2. **LLM provider mock granularity**: Should the test LLM provider be a shared fixture in `__tests__/helpers/`, or should each E2E test file create its own? The observatory E2E tests use per-test configuration.

3. **Rate limit test flakiness**: Rate limit tests depend on timing (rapid request bursts). Should we use a deterministic rate limiter in test mode, or accept occasional timing-related flakiness?

4. **Fitness test regex accuracy**: The fitness tests use regex to detect non-standard error shapes. Complex multiline response constructions may be missed. Should we supplement with AST-based analysis (e.g., using ts-morph)?

5. **SDK backward compatibility**: E2E-10 tests the new standard shape for rate limits. How do we verify that existing SDK clients (which parse `{ error: string }`) are not broken? Should there be a separate backward-compatibility test suite for the transition period?
