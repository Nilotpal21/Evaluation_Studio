# Feature Test Guide: Tool Invocations

**Feature**: Tool definition, validation, binding, execution, secrets, OAuth, resilience, and Studio UI
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/tool-invocations.md](../features/tool-invocations.md)
**Coverage basis**: Mixed source: repository test inventory plus targeted reruns captured in the latest verification snapshot
**Last updated**: 2026-03-22
**Overall status**: STABLE with expanded API-surface E2E coverage

---

## Current State (as of 2026-03-22)

The tool invocations feature has extensive unit and integration test coverage across at least 66 test files and 1,000+ individual test cases spanning the compiler, runtime, shared packages, and Studio. Coverage remains strongest for HTTP execution, tool form serialization/validation, and Studio UI components, and now includes a 19-scenario API-surface E2E suite that exercises the full create-bind-execute-respond chain against a real runtime without touching Mongo directly.

### Quick Health Dashboard

| Area                       | Status | Tests | Last Verified | Notes                                                                                                         |
| -------------------------- | ------ | ----- | ------------- | ------------------------------------------------------------------------------------------------------------- |
| HTTP Tool Executor         | PASS   | 96    | 2026-03-18    | SSRF, auth, resilience, headers, proxy, timeout                                                               |
| Tool Binding Executor      | PASS   | 11    | 2026-03-19    | Dispatch routing, parallel execution, validation, middleware-mutated HTTP tool execution                      |
| Middleware Wiring          | PASS   | 18    | 2026-03-19    | Middleware order, trace dedupe, and runtime HTTP tool mutation reaching the outbound dispatcher               |
| Runtime LLM Wiring         | PASS   | 49    | 2026-03-19    | Runtime agent loop wiring for tool execution, active-agent duplicate-tool resolution, middleware registration |
| MCP Tool Executor          | PASS   | 11    | 2026-03-18    | Circuit breaker, retry, result normalization, cap                                                             |
| Sandbox Tool Executor      | PASS   | 5     | 2026-03-18    | Path traversal, runtime selection, timeout                                                                    |
| Tool Schema Validator      | PASS   | 22    | 2026-03-18    | Compile-time validation of tool definitions                                                                   |
| Tool Middleware            | PASS   | 19    | 2026-03-18    | Composable middleware chain                                                                                   |
| Tool Lifecycle (E2E-style) | PASS   | 38    | 2026-03-18    | End-to-end construct execution with tools                                                                     |
| Parameter Validation       | PASS   | 11+   | 2026-03-18    | Type coercion, enum, defaults, required                                                                       |
| Tool Confirmation          | PASS   | 27    | 2026-03-18    | Snapshots, immutability, expiry, confirmation gate                                                            |
| Tool Memory Bridge         | PASS   | 19    | 2026-03-18    | Session/user/project scope, read/write access                                                                 |
| Tool OAuth Service         | PASS   | 33    | 2026-03-18    | Auth flow, token refresh, revocation, auth profiles                                                           |
| Tool Secrets RBAC          | PASS   | 24    | 2026-03-18    | Create, list, rotate, delete with permissions                                                                 |
| Tool Resilience            | PASS   | 5     | 2026-03-18    | Circuit breaker adapter, rate limiter                                                                         |
| Tool Audit Logger          | PASS   | 22    | 2026-03-18    | Structured audit events, MongoDB + AuditStore                                                                 |
| Tool Result Compressor     | PASS   | 16    | 2026-03-18    | Structured, truncate, summarize strategies                                                                    |
| Pipeline Tool Filter       | PASS   | 8     | 2026-03-18    | LLM-based tool pre-selection                                                                                  |
| Tool Rate Plan             | PASS   | 13    | 2026-03-18    | Per-tool rate limiting                                                                                        |
| Extraction Tool Call       | PASS   | 17    | 2026-03-18    | Tool call extraction from LLM responses                                                                       |
| Transfer Tool Executor     | PASS   | 11    | 2026-03-18    | Agent handoff/transfer tool                                                                                   |
| Parallel Tool Execution    | PASS   | 4     | 2026-03-18    | Concurrent tool dispatch                                                                                      |
| Post-Tool Mapping          | PASS   | 13    | 2026-03-18    | on_result/on_error variable mapping                                                                           |
| Cross-Turn Truncation      | PASS   | 8     | 2026-03-18    | Old tool result truncation                                                                                    |
| Normalize Tool Result      | PASS   | 7     | 2026-03-18    | Result normalization                                                                                          |
| Tool Guardrails            | PASS   | 19    | 2026-03-18    | Pre/post tool guardrails, LLM eval                                                                            |
| SearchAI Tool Executors    | PASS   | 35    | 2026-03-18    | KB tool execution, search-ai integration                                                                      |
| Attachment Tool Executor   | PASS   | 22    | 2026-03-18    | File attachment handling                                                                                      |
| HTTP Keepalive             | PASS   | 7     | 2026-03-18    | Connection pooling                                                                                            |
| Studio: Tool Store         | PASS   | 37    | 2026-03-18    | Zustand store operations                                                                                      |
| Studio: Tool Test Service  | PASS   | 54    | 2026-03-18    | Test execution service                                                                                        |
| Studio: API Tools Client   | PASS   | 19    | 2026-03-18    | API client functions                                                                                          |
| Studio: API Tool Routes    | PASS   | 31    | 2026-03-18    | Next.js route handlers                                                                                        |
| Studio: Tools Editor       | PASS   | 32    | 2026-03-18    | Agent tool binding UI                                                                                         |
| Studio: Tools Section      | PASS   | 9     | 2026-03-18    | Agent detail tools list                                                                                       |
| Studio: tool-utils         | PASS   | 48    | 2026-03-18    | Utility functions                                                                                             |
| Shared: DSL Serialization  | PASS   | 40    | 2026-03-18    | Form-to-DSL and DSL-to-form round-trip                                                                        |
| Shared: Tool Validation    | PASS   | 35    | 2026-03-18    | Project tool validator                                                                                        |
| Shared: Tool Definition    | PASS   | 9     | 2026-03-18    | DSL to ToolDefinition IR                                                                                      |
| Shared: Tool Resolution    | PASS   | 9     | 2026-03-18    | Resolve tool implementations                                                                                  |
| Shared: Standalone Adapter | PASS   | 17    | 2026-03-18    | Standalone tool adapter                                                                                       |
| Full E2E (API surface)     | PASS   | 19    | 2026-03-19    | API-only suite covers direct Studio HTTP/MCP/sandbox tests, runtime execution, auth, confirmation, A2A        |

---

## Coverage Matrix

| FR    | Description                                             | Unit | Integration | E2E | Manual | Status  |
| ----- | ------------------------------------------------------- | ---- | ----------- | --- | ------ | ------- |
| FR-1  | Multi-type tool execution (HTTP/MCP/Sandbox/etc.)       | Y    | Y           | Y   | N/A    | PASS    |
| FR-2  | Compile-time + runtime parameter validation             | Y    | Y           | Y   | N/A    | PASS    |
| FR-3  | Secret/env/auth-profile/OAuth credential resolution     | Y    | Y           | Y   | N/A    | PASS    |
| FR-4  | Confirmation gates with immutable snapshots             | Y    | N           | Y   | N/A    | PASS    |
| FR-5  | Resilience controls (timeout/retry/CB/rate limit)       | Y    | N           | N   | N/A    | PARTIAL |
| FR-6  | Trace events, audit logs, tool.execution logs           | Y    | N           | Y   | N/A    | PASS    |
| FR-7  | Composable middleware chain with auth-profile injection | Y    | Y           | Y   | N/A    | PASS    |
| FR-8  | Studio UI: creation wizards, testing, binding           | Y    | N           | N   | Y      | PASS    |
| FR-9  | SSRF protection on HTTP tool URLs                       | Y    | N           | N   | N/A    | PASS    |
| FR-10 | Declarative context access (read/write)                 | Y    | N           | Y   | N/A    | PASS    |
| FR-11 | JIT auth for interactive/non-interactive channels       | Y    | Y           | Y   | N/A    | PASS    |
| FR-12 | Tool result compaction (compress/truncate/summarize)    | Y    | N           | N   | N/A    | PASS    |

---

## E2E Test Scenarios (MANDATORY)

All E2E scenarios exercise the real system through HTTP APIs. No mocking codebase components. No direct DB access.

Primary suite: `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`

### E2E-1: HTTP Tool Create-Bind-Execute Lifecycle

**Preconditions**: In-memory MongoDB, mock HTTP tool backend, real runtime process
**Steps**:

1. `POST /api/projects/:id/tools` to create an HTTP tool with path/query/header/body parameter mapping
2. `POST /api/projects/:id/tools/:toolId/test` to verify Studio direct test execution
3. Bind tool to agent via project tool configuration
4. `POST /api/v1/chat/agent` with a user message that triggers tool invocation
5. Assert response includes tool call trace event and final assistant response

**Expected Result**: Tool created, tested in Studio, executed in runtime chat, trace event emitted
**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user`
**Isolation Check**: A different tenant's `POST /api/projects/:id/tools/:toolId/test` returns 404

### E2E-2: MCP Tool Discovery and Execution

**Preconditions**: In-memory MongoDB, in-suite MCP server, real runtime process
**Steps**:

1. `POST /api/projects/:id/mcp-servers/:serverId/tools/discover` to discover available MCP tools
2. `POST /api/projects/:id/mcp-servers/:serverId/tools/:toolName/test` to test MCP tool in Studio
3. `POST /api/v1/chat/agent` with agent configured with MCP-bound tool
4. Assert MCP tool executes end-to-end and result appears in agent response

**Expected Result**: MCP tools discovered, tested in Studio, and executed through runtime agent chat
**Auth Context**: `tenantId=test-tenant, projectId=test-project`
**Isolation Check**: Cross-project MCP server discovery returns 404

### E2E-3: Sandbox/Code Tool Execution

**Preconditions**: In-memory MongoDB, mock sandbox backend, real runtime process
**Steps**:

1. `POST /api/projects/:id/tools` to create a sandbox tool (JavaScript runtime)
2. `POST /api/projects/:id/tools/:toolId/test` to test sandbox execution in Studio
3. `POST /api/v1/chat/agent` with agent configured with sandbox-bound tool
4. Assert sandbox tool executes through runtime with proper result

**Expected Result**: Sandbox tool created, tested, and executed through runtime
**Auth Context**: `tenantId=test-tenant, projectId=test-project`
**Isolation Check**: N/A (sandbox backend is shared, isolation is at parameter level)

### E2E-4: Auth Profile Resolution and Injection

**Preconditions**: In-memory MongoDB, real runtime process, mock HTTP backend, auth profile configuration
**Steps**:

1. Configure auth profile for a tool via project settings
2. `POST /api/v1/chat/agent` to trigger tool execution with auth-profile-backed HTTP tool
3. Assert auth-profile middleware resolved per-request credentials and injected them into outbound HTTP headers
4. Repeat with config-variable-backed auth-profile reference to verify config resolution

**Expected Result**: Auth profile credentials resolved at runtime and injected into HTTP request headers before dispatch
**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user`
**Isolation Check**: Auth profile resolution is tenant-scoped; cross-tenant resolution must fail

### E2E-5: OAuth2 Client Credentials Flow

**Preconditions**: In-memory MongoDB, real runtime process, mock OAuth token endpoint
**Steps**:

1. Configure tool with client-credentials auth profile
2. `POST /api/v1/chat/agent` to trigger tool execution
3. Assert client-credentials flow mints a bearer token and injects it into the outbound request

**Expected Result**: OAuth2 client credentials token obtained and injected into tool HTTP request
**Auth Context**: `tenantId=test-tenant, projectId=test-project`
**Isolation Check**: OAuth tokens are tenant-scoped; token minting uses tenant-specific credentials

### E2E-6: OAuth Preflight Consent Gate

**Preconditions**: In-memory MongoDB, real runtime process, auth-profile with preflight consent
**Steps**:

1. `POST /api/v1/chat/agent` to trigger tool execution with preflight-consent-required auth profile
2. Assert tool execution blocks until consent exists
3. Grant consent via auth-profile OAuth consent API
4. `POST /api/v1/chat/agent` again in the same session
5. Assert tool now executes successfully after consent

**Expected Result**: Preflight gate blocks execution until consent is granted, then succeeds
**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user`
**Isolation Check**: Consent is user-scoped; another user's consent does not unlock the gate

### E2E-7: JIT Auth on Non-Interactive Channel

**Preconditions**: In-memory MongoDB, real runtime process, tool with JIT auth enabled
**Steps**:

1. `POST /api/v1/chat/agent` via REST (non-interactive channel) to trigger tool with JIT auth
2. Assert structured `JIT_AUTH_NOT_SUPPORTED` result returned
3. Assert outbound HTTP request was NOT dispatched

**Expected Result**: Non-interactive channels receive structured fallback without executing the tool
**Auth Context**: `tenantId=test-tenant, projectId=test-project`
**Isolation Check**: N/A (JIT auth is a channel-level behavior, not a data-isolation concern)

### E2E-8: Secure Tool Confirmation Gate

**Preconditions**: In-memory MongoDB, real runtime process, tool with `confirmation.require: 'always'`
**Steps**:

1. `POST /api/v1/chat/agent` to trigger secure tool
2. Assert tool halts behind confirmation (response contains confirmation request with immutable snapshot)
3. Confirm with original parameters
4. Assert tool executes successfully

**Expected Result**: Secure tool blocks until user confirmation, then executes with original immutable params
**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user`
**Isolation Check**: Confirmation snapshot is session-scoped

### E2E-9: Secure Tool Tamper Rejection

**Preconditions**: In-memory MongoDB, real runtime process, tool with `confirmation.require: 'always'`, immutable_params set
**Steps**:

1. `POST /api/v1/chat/agent` to trigger secure tool
2. Assert confirmation request returned with immutable snapshot
3. Attempt to confirm with mutated immutable parameters
4. Assert execution is rejected with tamper detection error

**Expected Result**: Tampered parameters detected and execution rejected
**Auth Context**: `tenantId=test-tenant, projectId=test-project`
**Isolation Check**: N/A (tamper detection is parameter-level, not data isolation)

### E2E-10: Cross-Turn Context Reuse

**Preconditions**: In-memory MongoDB, real runtime process, tool with `on_result` and `context_access` configured
**Steps**:

1. `POST /api/v1/chat/agent` (turn 1) to trigger tool; `on_result` writes session variable
2. `POST /api/v1/chat/agent` (turn 2) to trigger tool with `context_access.read` referencing the written variable
3. Assert the second tool receives the previously-written session value in its parameters

**Expected Result**: Session variable written by `on_result` in turn 1 is available via `context_access.read` in turn 2
**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user, sessionId=same-session`
**Isolation Check**: Session variables are session-scoped; different session does not see the value

### E2E-11: Attachment-Driven Tool Invocation

**Preconditions**: In-memory MongoDB, real runtime process, file upload support
**Steps**:

1. `POST /api/projects/:pid/sessions/:sid/attachments` to upload a file
2. `POST /api/v1/chat/agent` with message referencing the attachment
3. Assert attachment preprocessing runs, extracted text feeds into tool input mapping

**Expected Result**: Attachment uploaded, preprocessed, and extracted text available in tool parameters
**Auth Context**: `tenantId=test-tenant, projectId=test-project, userId=test-user`
**Isolation Check**: Attachments are session-scoped

### E2E-12: A2A Inbound Tool Execution

**Preconditions**: In-memory MongoDB, real runtime process, A2A connection configured
**Steps**:

1. `POST /a2a/:connectionId` with authenticated A2A message/send payload
2. Assert same tool invocation pipeline runs (tool call, trace event, response)
3. Assert response payload contains the final agent response

**Expected Result**: A2A traffic runs through the same tool invocation pipeline as direct chat
**Auth Context**: A2A connection authentication (API key or bearer token)
**Isolation Check**: A2A connections are scoped to specific agent/project combinations

### E2E-13: Cross-Tenant Tool Execution Isolation (PLANNED)

**Preconditions**: In-memory MongoDB, real runtime process, two tenant configurations
**Steps**:

1. Create tool in tenant A's project
2. Attempt to execute tool via tenant B's session
3. Assert 404 returned (tool not found in tenant B's scope)
4. Attempt to access tenant A's tool secrets from tenant B
5. Assert 404 returned

**Expected Result**: Cross-tenant tool access returns 404, no data leakage
**Auth Context**: `tenantId=tenant-a` and `tenantId=tenant-b` with separate credentials
**Isolation Check**: This IS the isolation check

---

## Integration Test Scenarios (MANDATORY)

### INT-1: Tool Binding Executor Dispatch Routing

**Boundary**: `ToolBindingExecutor` dispatching to type-specific executors
**Setup**: Instantiate `ToolBindingExecutor` with HTTP, MCP, and Sandbox tools and mock executors
**Steps**:

1. Execute tool call for each tool type
2. Verify correct executor is invoked based on `tool_type`
3. Execute parallel tool calls and verify concurrency limiting
4. Execute tool call for unknown tool type and verify fallback executor used

**Expected Result**: Each tool type routes to its dedicated executor; parallel execution respects max concurrency
**Failure Mode**: If executor registry is empty, `ToolExecutionError` with `TOOL_NOT_FOUND` code

### INT-2: Auth Profile Tool Middleware Chain

**Boundary**: `auth-profile-tool-middleware.ts` + `ToolBindingExecutor` middleware chain
**Setup**: Real middleware chain with auth-profile middleware, mock auth profile service
**Steps**:

1. Configure auth profile for an HTTP tool
2. Run tool through middleware chain
3. Verify auth-profile middleware mutates HTTP binding headers before dispatch
4. Verify auth-profile credentials take precedence over inline HTTP auth

**Expected Result**: Auth profile middleware resolves and injects credentials into HTTP binding before executor dispatch
**Failure Mode**: If auth profile service unavailable, middleware should log warning and fall through to inline auth

### INT-3: Tool Secret Resolution Pipeline

**Boundary**: `SecretsProvider` + `HttpToolExecutor` secret placeholder resolution
**Setup**: Real `SecretsProvider` with encrypted test secrets in MongoDB
**Steps**:

1. Create encrypted secret via `tool_secrets` repository
2. Define HTTP tool with `{{secrets.API_KEY}}` in headers
3. Execute tool and verify secret placeholder replaced with decrypted value
4. Verify decrypted value never appears in trace logs or audit events
5. Rotate secret and verify new value used on next execution

**Expected Result**: Secrets resolved, injected, and never leaked to observability layer
**Failure Mode**: If encryption service unavailable, return 503 on secret creation; execution with unresolved placeholder fails with clear error

### INT-4: Tool Result Compressor Pipeline

**Boundary**: `tool-result-compressor.ts` + conversation history integration
**Setup**: Real compressor with configurable strategies
**Steps**:

1. Execute tool that returns a large result (>100KB)
2. Verify structured compression strategy reduces result size
3. Verify truncation strategy caps at configured limit
4. Verify LLM summarization strategy (with mock LLM) produces summary
5. Verify compressed result enters conversation history instead of raw result

**Expected Result**: Large tool results are compressed before entering conversation history
**Failure Mode**: If compressor fails, raw result is used (no silent data loss)

### INT-5: SSRF Validator Integration with HTTP Executor

**Boundary**: `ssrf-validator.ts` (shared-kernel) + `HttpToolExecutor`
**Setup**: Real SSRF validator integrated into HTTP tool executor
**Steps**:

1. Execute HTTP tool with private IP (127.0.0.1) -- assert blocked
2. Execute HTTP tool with cloud metadata endpoint (169.254.169.254) -- assert blocked
3. Execute HTTP tool with octal-encoded private IP (0177.0.0.1) -- assert blocked
4. Execute HTTP tool with userinfo bypass (user@127.0.0.1) -- assert blocked
5. Execute HTTP tool with valid public URL -- assert allowed
6. Execute HTTP tool with `ALLOW_SSRF_PRIVATE_RANGES=true` and private IP -- assert allowed (dev mode)

**Expected Result**: SSRF validator blocks all private/metadata/encoded IPs; allows public URLs; respects dev override
**Failure Mode**: If SSRF validation fails to parse URL, tool execution is blocked (fail-closed)

### INT-6: Tool Confirmation Snapshot Lifecycle

**Boundary**: `tool-confirmation.ts` + `ToolBindingExecutor` confirmation gate
**Setup**: Real confirmation service with in-memory storage
**Steps**:

1. Execute tool with `confirmation.require: 'always'` -- verify snapshot created
2. Verify snapshot contains immutable parameter hash
3. Confirm with matching parameters -- verify execution proceeds
4. Confirm with mismatched parameters -- verify execution rejected
5. Wait for TTL expiry (5 minutes) -- verify snapshot expired and execution rejected

**Expected Result**: Confirmation snapshots are immutable, time-bounded, and tamper-proof
**Failure Mode**: If snapshot storage fails, confirmation gate should reject (fail-closed)

### INT-7: Circuit Breaker and Rate Limiter Integration

**Boundary**: `tool-resilience-factory.ts` + executor resilience wrappers
**Setup**: Real resilience factory with Redis-backed circuit breakers
**Steps**:

1. Execute tool successfully 2 times -- verify circuit breaker remains closed
2. Execute tool with 3 consecutive failures -- verify circuit breaker opens
3. Attempt execution while circuit is open -- verify fast-fail response
4. Wait for reset period (30s) -- verify circuit breaker transitions to half-open
5. Execute tool with rate limiter at capacity -- verify rate limit rejection

**Expected Result**: Circuit breaker opens after threshold, rate limiter enforces per-tool limits
**Failure Mode**: If Redis unavailable, fallback to in-memory circuit breaker (single-pod)

### INT-8: LLM Wiring and Tool Registration

**Boundary**: `llm-wiring.ts` + runtime agent session initialization
**Setup**: Real runtime session setup with tool registration
**Steps**:

1. Initialize agent session with multiple tools of different types
2. Verify `ToolBindingExecutor` is created with correct tool definitions
3. Verify middleware chain includes auth-profile middleware
4. Verify active-agent duplicate-tool resolution (active agent's tools take precedence)
5. Verify session context (tenantId, sessionId, userId) propagated to executor

**Expected Result**: Tool executor properly wired with all tools, middleware, and session context
**Failure Mode**: If tool registration fails, session initialization should log error and proceed without tools

---

## Security & Isolation Tests

- [x] Cross-tenant tool access returns 404 (unit: `tool-secrets-authz.test.ts`; E2E: PLANNED GAP-007)
- [x] Cross-project tool access returns 404 (unit: project tool validator)
- [x] Cross-user OAuth token access returns 404 (unit: `tool-oauth-service.test.ts`)
- [x] Missing auth returns 401 (unit: tool secrets RBAC)
- [x] Insufficient permissions returns 403 (unit: tool secrets RBAC)
- [x] Input validation rejects malformed data (unit: `tool-schema-validator.test.ts`, `project-tool-validator.test.ts`)
- [x] SSRF protection blocks private IPs (unit: `http-tool-executor.test.ts`, `ssrf-validator.test.ts`)
- [x] Secrets never returned in API responses (unit: `tool-secrets-authz.test.ts`)
- [x] Tool params size limit enforced (unit: `tool-binding-executor.test.ts`)
- [ ] Cross-tenant tool execution isolation E2E (PLANNED -- GAP-007)
- [ ] Cross-project tool execution isolation E2E (PLANNED)

---

## Test File Catalog

### Compiler Package (`packages/compiler`)

| File                                                                               | Tests | Type        | Coverage Area                                                    |
| ---------------------------------------------------------------------------------- | ----- | ----------- | ---------------------------------------------------------------- |
| `src/__tests__/constructs/http-tool-executor.test.ts`                              | 96    | unit        | SSRF, auth modes, header injection, proxy, resilience, timeout   |
| `src/__tests__/constructs/middleware-chain.test.ts`                                | 18    | unit        | Middleware execution order, trace dedupe, auth-profile mutation  |
| `src/__tests__/constructs/tool-lifecycle-e2e.test.ts`                              | 38    | integration | Full tool lifecycle through construct execution                  |
| `src/__tests__/constructs/tool-schema-validator.test.ts`                           | 22    | unit        | Compile-time validation: required fields, duplicates, type rules |
| `src/__tests__/constructs/tool-middleware.test.ts`                                 | 19    | unit        | Middleware composition, execution order, error propagation       |
| `src/__tests__/llm/extract-json-tool-use.test.ts`                                  | 12    | unit        | JSON extraction from LLM tool_use responses                      |
| `src/__tests__/constructs/tool-binding-executor.test.ts`                           | 11    | unit        | Dispatch routing by tool_type, parallel execution, fallback      |
| `src/__tests__/validate-tool-refs.test.ts`                                         | 11    | unit        | Tool reference validation in agent DSL                           |
| `src/platform/constructs/executors/__tests__/http-tool-executor-keepalive.test.ts` | 7     | unit        | HTTP connection pooling and keep-alive behavior                  |
| `src/__tests__/constructs/mcp-tool-executor.test.ts`                               | 6     | unit        | MCP server calls, circuit breaker, retry                         |
| `src/__tests__/constructs/sandbox-tool-executor.test.ts`                           | 5     | unit        | Sandbox execution, path traversal, runtime validation            |
| `src/__tests__/constructs/mcp-tool-result-cap.test.ts`                             | 5     | unit        | MCP result size capping at 100K chars                            |
| `src/__tests__/tool-binding-executor-connector.test.ts`                            | 5     | unit        | Connector tool binding dispatch                                  |
| `src/__tests__/ir/nested-tool-params-compilation.test.ts`                          | 3     | unit        | Nested object/array parameter compilation                        |
| `src/__tests__/tool-confirmation-schema.test.ts`                                   | 3     | unit        | Confirmation schema validation                                   |

### Runtime Package (`apps/runtime`)

| File                                                                 | Tests | Type | Coverage Area                                                               |
| -------------------------------------------------------------------- | ----- | ---- | --------------------------------------------------------------------------- |
| `src/__tests__/tool-executor-adapter.test.ts`                        | 32    | unit | Tool executor adapter (deprecated), mock injection                          |
| `src/__tests__/tool-oauth-service.test.ts`                           | 28    | unit | OAuth flow initiation, callback, token refresh, revocation, provider config |
| `src/__tests__/tool-secrets-authz.test.ts`                           | 24    | unit | Secret CRUD with RBAC, encryption, rotation, expiry                         |
| `src/__tests__/tool-audit-logger.test.ts`                            | 17    | unit | AuditStore-backed tool audit logging                                        |
| `src/__tests__/tool-confirmation.test.ts`                            | 22    | unit | Snapshot creation, immutability validation, expiry, confirmation messages   |
| `src/__tests__/tool-memory-bridge.test.ts`                           | 19    | unit | Session/user/project scope, read-only enforcement, MEMORY declarations      |
| `src/__tests__/extraction-tool-call.test.ts`                         | 17    | unit | Tool call extraction from LLM output                                        |
| `src/__tests__/tool-result-compressor.test.ts`                       | 16    | unit | Structured compression, truncation, item trimming, LLM summarization        |
| `src/__tests__/tool-call-rate-plan.test.ts`                          | 13    | unit | Per-tool rate limiting enforcement                                          |
| `src/__tests__/post-tool-mapping.test.ts`                            | 13    | unit | on_result/on_error session variable mapping                                 |
| `src/__tests__/transfer-tool-executor.test.ts`                       | 11    | unit | Agent handoff/transfer via handoff tool                                     |
| `src/__tests__/tool-binding-analyzer.test.ts`                        | 9     | unit | Tool binding diagnostics/analysis                                           |
| `src/__tests__/truncate-old-tool-results.test.ts`                    | 9     | unit | Old tool result truncation in conversation history                          |
| `src/__tests__/guardrails/tool-rails.test.ts`                        | 9     | unit | Pre/post tool execution guardrails                                          |
| `src/__tests__/cross-turn-tool-truncation.test.ts`                   | 8     | unit | Cross-turn tool result management                                           |
| `src/__tests__/pipeline-tool-filter.test.ts`                         | 8     | unit | LLM-based tool pre-selection, parse response, fallback                      |
| `src/__tests__/normalize-tool-result.test.ts`                        | 7     | unit | Tool result normalization                                                   |
| `src/services/execution/__tests__/flow-tool-guardrails.test.ts`      | 6     | unit | Flow-mode tool guardrails                                                   |
| `src/__tests__/tool-confirmation-gate.test.ts`                       | 5     | unit | Confirmation gate lifecycle                                                 |
| `src/__tests__/tool-resilience-factory.test.ts`                      | 5     | unit | Circuit breaker and rate limiter factory                                    |
| `src/__tests__/auth-profile/tool-oauth-service-auth-profile.test.ts` | 5     | unit | OAuth with auth profile resolver                                            |
| `src/services/execution/__tests__/tool-guardrail-llmeval.test.ts`    | 4     | unit | LLM-evaluated tool guardrails                                               |
| `src/__tests__/parallel-tool-execution.test.ts`                      | 4     | unit | Concurrent tool execution                                                   |
| `src/tools/__tests__/attachment-tool-executor.test.ts`               | 22    | unit | File attachment tool handling                                               |
| `src/services/search-ai/__tests__/searchai-kb-tool-executor.test.ts` | 17    | unit | SearchAI KB tool executor                                                   |
| `src/services/search-ai/__tests__/search-ai-tool-executor.test.ts`   | 12    | unit | SearchAI tool executor                                                      |
| `src/__tests__/e2e/searchai/06-kb-tool-executor.e2e.test.ts`         | 6     | e2e  | SearchAI KB tool E2E (requires live SearchAI)                               |
| `src/__tests__/pre-refactor/reasoning-tool-execution.test.ts`        | 10    | unit | Reasoning mode tool execution                                               |
| `src/__tests__/llm-wiring.test.ts`                                   | 49    | unit | Runtime chat wiring, tool middleware registration, auth-profile integration |

### Studio Package (`apps/studio`)

| File                                                           | Tests | Type | Coverage Area                                                                          |
| -------------------------------------------------------------- | ----- | ---- | -------------------------------------------------------------------------------------- |
| `src/__tests__/tool-test-service.test.ts`                      | 54    | unit | Tool test execution service                                                            |
| `src/components/tools/__tests__/tool-utils.test.ts`            | 48    | unit | Tool utility functions                                                                 |
| `src/__tests__/tool-store.test.ts`                             | 37    | unit | Zustand tool store operations                                                          |
| `src/__tests__/tools-editor.test.tsx`                          | 32    | unit | Agent tool editor component                                                            |
| `src/__tests__/api-tool-routes.test.ts`                        | 31    | unit | Next.js API route handlers                                                             |
| `src/__tests__/api-tools-client.test.ts`                       | 19    | unit | API client fetch functions                                                             |
| `src/__tests__/tools-section.test.tsx`                         | 9     | unit | Agent detail tools section                                                             |
| `src/__tests__/e2e/tool-invocations-api.e2e.test.ts`           | 19    | e2e  | API-only tool invocation lifecycle across Studio, runtime, auth, confirmation, and A2A |
| `src/components/tools/__tests__/DynamicToolInputForm.test.tsx` | --    | unit | Dynamic form from parameter schema                                                     |
| `src/hooks/__tests__/useStaleToolCheck.test.ts`                | --    | unit | Stale tool detection hook                                                              |

### Shared Packages

| File                                                                        | Tests | Type | Coverage Area                       |
| --------------------------------------------------------------------------- | ----- | ---- | ----------------------------------- |
| `packages/shared/src/__tests__/project-tool-validator.test.ts`              | 35    | unit | Tool validation rules               |
| `packages/shared/src/__tests__/parse-dsl-to-tool-form.test.ts`              | 32    | unit | DSL parsing to form data            |
| `packages/shared/src/__tests__/tools/standalone-tool-adapter.test.ts`       | 17    | unit | Standalone tool adapter             |
| `packages/shared/src/__tests__/to-tool-definition.test.ts`                  | 9     | unit | DSL to ToolDefinition IR conversion |
| `packages/shared/src/__tests__/resolve-tool-implementations.test.ts`        | 9     | unit | Tool implementation resolution      |
| `packages/shared/src/__tests__/serialize-tool-form-to-dsl.test.ts`          | 8     | unit | Form data to DSL serialization      |
| `packages/shared-kernel/src/security/__tests__/ssrf-validator.test.ts`      | --    | unit | SSRF validation (shared-kernel)     |
| `packages/shared/src/security/__tests__/ssrf-validator.test.ts`             | --    | unit | SSRF validation (shared)            |
| `packages/core/src/__tests__/tool-import-resolver.test.ts`                  | 7     | unit | Tool import resolution              |
| `packages/core/src/__tests__/tool-file-parser.test.ts`                      | 14    | unit | Tool file parsing                   |
| `packages/core/src/__tests__/parser-tool-on-result.test.ts`                 | 7     | unit | Tool on_result parsing              |
| `packages/project-io/src/__tests__/tool-extractor.test.ts`                  | 11    | unit | Tool extraction for import/export   |
| `packages/project-io/src/__tests__/import-applier-tools.test.ts`            | 5     | unit | Tool import application             |
| `packages/pipeline-engine/src/__tests__/compute-tool-effectiveness.test.ts` | 8     | unit | Tool effectiveness analytics        |
| `packages/connectors/src/__tests__/connector-tool-executor.test.ts`         | 9     | unit | Connector-bound tool execution      |
| `packages/connectors/src/__tests__/workflow-tool-executor.test.ts`          | 7     | unit | Workflow-bound tool execution       |

### Other Packages

| File                                                                       | Tests | Type | Coverage Area                      |
| -------------------------------------------------------------------------- | ----- | ---- | ---------------------------------- |
| `apps/workflow-engine/src/__tests__/tool-call-executor.test.ts`            | 6     | unit | Workflow engine tool call handling |
| `apps/search-ai/src/services/__tests__/searchai-tool-registration.test.ts` | 7     | unit | SearchAI tool registration         |

---

## Open Gaps

- **GAP-001**: No API-level E2E coverage yet for cross-tenant/project isolation on tool execution
  - **Severity**: High
  - **Reason**: The current suite proves the happy-path lifecycle and channel coverage, but not 404-style isolation guarantees across tenants/projects

- **GAP-002**: SSRF validator tests exist but are not part of the tool-specific test suite
  - **Severity**: Low
  - **Reason**: SSRF tests are in `packages/shared-kernel/src/security/__tests__/`

- **GAP-003**: OAuth token refresh with real provider not tested
  - **Severity**: Medium
  - **Reason**: OAuth tests use mocked HTTP responses

- **GAP-004**: Sandbox tool execution with real gvisor pod not tested in CI
  - **Severity**: Medium
  - **Reason**: Requires gvisor infrastructure

- **GAP-005**: MCP tool execution with an external MCP deployment is not tested in CI
  - **Severity**: Medium
  - **Reason**: The API-surface E2E suite uses an in-suite MCP server; CI still does not validate against an external MCP deployment

- **GAP-006**: Variable namespace scoping and tool secret rotation are not covered by API-level E2E
  - **Severity**: Medium
  - **Reason**: Current suite focuses on invocation flow, auth-profile resolution, secure confirmation, context passing, attachments, and A2A

- **GAP-007**: Resilience controls (circuit breaker, rate limiter) not covered by E2E
  - **Severity**: Medium
  - **Reason**: Resilience is tested at unit level but not through the full API lifecycle

---

## Pending / Future Work

- [ ] Cross-tenant tool isolation E2E (E2E-13)
- [ ] Sandbox execution with real gvisor pod (integration test)
- [ ] MCP execution with real MCP server (integration test)
- [ ] OAuth flow E2E with mock OAuth provider
- [ ] Tool secret rotation and runtime resolution E2E
- [ ] Pipeline tool filter accuracy testing with diverse user messages
- [ ] Load testing: concurrent tool executions under rate limiting and circuit breaker
- [ ] Variable namespace scoping E2E (tool env var isolation between namespaces)
- [ ] Resilience controls E2E (circuit breaker open/close lifecycle via API)

---

## Test Infrastructure

### Required Services

- **In-memory MongoDB**: MongoMemoryServer for test database
- **Mock HTTP backend**: Express server on random port for HTTP tool targets
- **Mock sandbox backend**: Lightweight sandbox simulation for code execution tests
- **In-suite MCP server**: MCP server for tool discovery and execution tests
- **Real runtime process**: Full runtime Express server with middleware chain
- **Mock LLM service**: Simulated LLM responses for agent chat tests

### Data Seeding Strategy

All test data is seeded through public APIs:

- Tools created via `POST /api/projects/:id/tools`
- Agent configurations via project tool configuration APIs
- Auth profiles via auth-profile configuration APIs
- No direct MongoDB model imports in E2E tests

### Environment Variables

| Variable                     | Required | Description                                  |
| ---------------------------- | -------- | -------------------------------------------- |
| `TOOL_INVOCATIONS_E2E_DEBUG` | No       | Enable debug logging for E2E suite           |
| `encryption_master_key`      | No       | Required for secret encryption tests         |
| `ALLOW_SSRF_PRIVATE_RANGES`  | No       | Allow localhost targets in development tests |

### CI Configuration

```bash
# Run all tool-related tests
pnpm test --filter=@abl/compiler -- --grep tool
pnpm test --filter=runtime -- --grep tool
pnpm test --filter=studio -- --grep tool

# Run specific test file
pnpm vitest run apps/runtime/src/__tests__/tool-confirmation.test.ts

# Run the focused tool invocation HTTP API E2E suite
TOOL_INVOCATIONS_E2E_DEBUG=true pnpm --filter @agent-platform/studio exec vitest run --config vitest.node.config.ts src/__tests__/e2e/tool-invocations-api.e2e.test.ts
```

---

## Open Testing Questions

1. Should cross-tenant isolation E2E (E2E-13) be mandatory before declaring tool invocations STABLE?
2. What is the acceptable level of external-backend coverage for MCP/sandbox in CI vs. nightly lanes?
3. Should resilience controls (circuit breaker lifecycle) have API-level E2E coverage or is unit-level sufficient?
4. How should OAuth flow E2E tests handle real-provider token endpoints without exposing real credentials in CI?
