# HLD: Tool Invocations

**Feature**: [Tool Invocations](../features/tool-invocations.md)
**Status**: STABLE (documenting existing architecture)
**Date**: 2026-03-22
**Author**: Platform team

---

## 1. Problem Statement

Agents need a secure, traceable, and unified mechanism to call external systems (HTTP APIs, MCP servers, sandboxed code, knowledge bases, connectors, workflows, webhooks) during conversations. Without a shared invocation system:

- Each tool type would require its own ad-hoc execution path with inconsistent security, validation, and tracing behavior
- Secret/credential management would be fragmented, increasing the risk of credential leakage across tenants
- Auth-profile injection, OAuth flows, and JIT consent would need per-executor reimplementation
- SSRF protection, circuit breakers, rate limiting, and confirmation gates would either be missing or inconsistent
- Studio authoring and runtime execution would diverge, making the builder-to-production path unreliable
- Audit and observability signals would lack standardized structure, making production triage difficult

The Tool Invocations feature solves this by providing a central dispatcher (`ToolBindingExecutor`) with type-specific executors, a composable middleware chain, and shared primitives for security, resilience, confirmation, secrets, OAuth, and tracing.

---

## 2. Alternatives Considered

### Alternative A: Monolithic Tool Executor (Single Executor for All Types)

**Description**: A single executor class handles all tool types with internal branching logic for HTTP, MCP, Sandbox, etc.

**Pros**:

- Single entry point simplifies dispatch
- All cross-cutting concerns applied uniformly without middleware chain
- Fewer files to maintain

**Cons**:

- Violates open-closed principle: adding a new tool type requires modifying the monolithic class
- Type-specific concerns (SSRF for HTTP, sandbox isolation for code, circuit breaking for MCP) become deeply nested conditionals
- Testing becomes difficult: every test must account for all tool types
- Tool-type-specific configuration (HTTP auth modes, MCP transports, sandbox runtimes) bloats the interface

**Effort**: M (initial development), L (long-term maintenance burden)

### Alternative B: Dispatcher + Type-Specific Executors with Middleware Chain (SELECTED)

**Description**: A central `ToolBindingExecutor` routes tool calls to type-specific executors (`HttpToolExecutor`, `McpToolExecutor`, `SandboxToolExecutor`, etc.) based on the `tool_type` field in the tool's IR definition. A composable middleware chain handles cross-cutting concerns (auth-profile injection, audit logging, PII scrubbing) in an onion model.

**Pros**:

- Open for extension: new tool types add a new executor class without modifying the dispatcher core
- Type-specific executors own their domain (SSRF for HTTP, isolation for sandbox, transport for MCP)
- Middleware chain enables composable cross-cutting concerns without executor coupling
- Each executor is independently testable
- Namespace-scoped executor instances support per-tool environment variable isolation

**Cons**:

- More files and interfaces to maintain
- Middleware chain ordering requires careful documentation
- Namespace-scoped executors add per-tool memory overhead

**Effort**: M (initial development), S (incremental new tool types)

**Recommendation**: Alternative B is selected. The dispatcher + executor pattern provides clean separation of concerns, enables independent testing per tool type, and scales to new tool types without modifying the core dispatcher. The middleware chain enables cross-cutting concerns (auth, audit, PII) to be composed independently. This is the existing architecture.

### Alternative C: Event-Driven Tool Execution via Message Queue

**Description**: Tool calls dispatched as events to a message queue (BullMQ), with type-specific worker consumers executing tools asynchronously.

**Pros**:

- Natural support for async/long-running tools
- Built-in retry and dead-letter queue semantics
- Decouples tool execution from the LLM conversation loop

**Cons**:

- Adds significant latency for synchronous tools (HTTP, MCP) that complete in milliseconds
- Complicates the conversation loop: agent must poll or subscribe for tool results
- Secret/credential resolution must happen at the worker, requiring cross-service secret distribution
- Confirmation gates (which require synchronous user interaction) become much more complex
- Middleware chain (auth-profile injection, PII scrubbing) must be duplicated in worker context

**Effort**: L (significant architecture change, migration risk)

---

## 3. Architecture

### System Context Diagram

```
                                    ┌──────────────────────┐
                                    │     Studio UI         │
                                    │  (Tool Builder/Test)  │
                                    └───────────┬──────────┘
                                                │ REST API
                                    ┌───────────▼──────────┐
                                    │    Studio Server      │
                                    │  (Next.js API Routes) │
                                    └───────────┬──────────┘
                                                │ Tool CRUD / Test
┌──────────┐   ┌──────────┐       ┌─────────────▼─────────────┐
│  SDK/     │   │  Voice   │       │        Runtime             │
│  A2A/     │──▶│  Digital  │──────▶│  ┌─────────────────────┐  │
│  Channel  │   │  Gateway  │      │  │  LLM Conversation    │  │
└──────────┘   └──────────┘       │  │  Loop (llm-wiring)   │  │
                                    │  └──────────┬──────────┘  │
                                    │             │ tool_use     │
                                    │  ┌──────────▼──────────┐  │
                                    │  │ ToolBindingExecutor  │  │
                                    │  │  (Central Dispatcher)│  │
                                    │  └──┬───┬───┬───┬──────┘  │
                                    │     │   │   │   │         │
                                    │  ┌──▼┐┌─▼─┐┌▼──┐┌▼────┐  │
                                    │  │HTTP││MCP││SBX││ ... │  │
                                    │  │Exec││Exe││Exe││Exec │  │
                                    │  └──┬─┘└─┬─┘└─┬─┘└──┬──┘  │
                                    └─────┼────┼────┼─────┼─────┘
                                          │    │    │     │
                              ┌───────────▼┐ ┌▼──┐ ┌▼──┐  │
                              │ External   │ │MCP│ │SBX│  │
                              │ HTTP APIs  │ │Srv│ │Pod│  │
                              └────────────┘ └───┘ └───┘  │
                                                          ▼
                                                    ┌──────────┐
                                                    │ Connector │
                                                    │ SearchAI  │
                                                    │ Workflow   │
                                                    └──────────┘
```

### Component Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                      ToolBindingExecutor                             │
│                                                                     │
│  tools: Map<string, ToolDefinition>                                 │
│  middleware: ToolMiddleware[]  (composable onion chain)              │
│  sessionContext: ToolSessionContext                                  │
│                                                                     │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────────────┐   │
│  │ HTTP     │  │ MCP      │  │ Sandbox  │  │ Fallback/        │   │
│  │ Executor │  │ Executor │  │ Executor │  │ Custom Executor  │   │
│  └────┬─────┘  └────┬─────┘  └────┬─────┘  └───────┬──────────┘   │
│       │              │             │                │              │
│  ┌────▼─────┐  ┌────▼─────┐  ┌────▼─────┐                        │
│  │ SSRF     │  │ Circuit  │  │ Sandbox  │  ┌──────────────────┐   │
│  │ Validator│  │ Breaker  │  │ Runner   │  │ Connector Exec   │   │
│  │ Secrets  │  │ Retry    │  │ Memory   │  │ Workflow Exec    │   │
│  │ Auth     │  │ Result   │  │ API      │  │ SearchAI Exec    │   │
│  │ Proxy    │  │ Cap      │  │ Timeout  │  │ Transfer Exec    │   │
│  └──────────┘  └──────────┘  └──────────┘  └──────────────────┘   │
│                                                                     │
│  ┌─────────────────────────────────────────────────────────────┐   │
│  │                    Middleware Chain                           │   │
│  │  Auth-Profile → Audit → PII Scrub → Logging → ... → Core   │   │
│  └─────────────────────────────────────────────────────────────┘   │
│                                                                     │
│  ┌──────────────┐  ┌────────────┐  ┌─────────────────────────┐   │
│  │ Secrets      │  │ Resilience │  │ Trace Context           │   │
│  │ Provider     │  │ Factory    │  │ Manager                 │   │
│  └──────────────┘  └────────────┘  └─────────────────────────┘   │
└─────────────────────────────────────────────────────────────────────┘
```

### Data Flow

1. **Compilation**: Tools loaded from `project_tools` collection via `loadProjectToolsAsIR()` or `resolveToolImplementations()` and embedded in the agent IR
2. **Session Initialization**: `ToolBindingExecutor` instantiated with the agent's tools, secrets provider, MCP clients, sandbox runner, resilience factory, and middleware chain via `llm-wiring.ts`
3. **LLM Tool Use**: LLM returns `tool_use` stop reason with tool calls (`LLMToolCall[]`)
4. **Parameter Validation**: Parameters validated against `ToolParameter` schema (required fields, type coercion, enum enforcement, defaults injection, 512KB size limit)
5. **System Parameter Injection**: System params (`session_id`, `tenant_id`, `user_id`) auto-injected when declared in parameter schema
6. **Context Access Read**: If `context_access.read` defined, session variables auto-injected into tool params
7. **Confirmation Gate** (optional): If `confirmation.require` is active, immutable snapshot created and user approval requested
8. **Middleware Application**: Onion-model middleware chain executes. Auth-profile middleware resolves credentials and mutates HTTP binding. Audit middleware logs pre-execution event.
9. **Dispatch**: `ToolBindingExecutor.dispatch()` routes to type-specific executor based on `tool_type`
10. **Secret Resolution**: `{{secrets.KEY}}` and `{{env.KEY}}` placeholders resolved via `SecretsProvider` (with optional namespace scoping)
11. **Execution**: Type-specific executor runs the tool with timeout, circuit breaker, and rate limiting
12. **Result Processing**: Results compressed if large (via `tool-result-compressor.ts`), mapped to session variables via `on_result`/`on_error`, traced via `TraceContextManager`
13. **Context Access Write**: If `context_access.write` defined, response values written to session state
14. **Audit**: Structured audit event logged with tool name, type, success/failure, latency, tenant/session context

### Sequence Diagram (HTTP Tool Execution)

```
Agent Loop        ToolBindingExecutor    Middleware       HttpToolExecutor     External API
    │                    │                   │                  │                  │
    │  execute(toolCall) │                   │                  │                  │
    │───────────────────>│                   │                  │                  │
    │                    │  validate params   │                  │                  │
    │                    │──┐                │                  │                  │
    │                    │  │                │                  │                  │
    │                    │<─┘                │                  │                  │
    │                    │  confirm gate?     │                  │                  │
    │                    │──┐                │                  │                  │
    │                    │  │ (skip/block)   │                  │                  │
    │                    │<─┘                │                  │                  │
    │                    │  compose(chain)   │                  │                  │
    │                    │─────────────────>│                  │                  │
    │                    │                   │ auth-profile     │                  │
    │                    │                   │ resolve+mutate   │                  │
    │                    │                   │──┐               │                  │
    │                    │                   │  │               │                  │
    │                    │                   │<─┘               │                  │
    │                    │                   │  dispatch(http)  │                  │
    │                    │                   │────────────────>│                  │
    │                    │                   │                  │ resolve secrets  │
    │                    │                   │                  │──┐               │
    │                    │                   │                  │<─┘               │
    │                    │                   │                  │ SSRF validate    │
    │                    │                   │                  │──┐               │
    │                    │                   │                  │<─┘               │
    │                    │                   │                  │ HTTP request     │
    │                    │                   │                  │────────────────>│
    │                    │                   │                  │   response       │
    │                    │                   │                  │<────────────────│
    │                    │                   │   result         │                  │
    │                    │                   │<────────────────│                  │
    │                    │  audit+trace      │                  │                  │
    │                    │<─────────────────│                  │                  │
    │   LLMToolResult   │                   │                  │                  │
    │<───────────────────│                   │                  │                  │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

#### 1. Tenant Isolation

Every query against `project_tools` includes `tenantId` via the `tenantIsolationPlugin` Mongoose middleware. The `tool_secrets` collection is also tenant-scoped. At runtime, the `ToolSessionContext` carries `tenantId` and propagates it to:

- `HttpToolExecutor` for tenant-scoped circuit breakers and rate limiters via `HybridCircuitBreakerRegistry`
- `McpToolExecutor` for tenant-scoped MCP client resolution
- `ToolAuditLogger` for tenant-scoped audit events
- `TraceContextManager` for tenant-scoped trace correlation

Cross-tenant access to tools, secrets, or auth profiles returns 404 (not 403) to avoid leaking resource existence.

#### 2. Data Access Pattern

- **Repository pattern**: `project_tools` CRUD via Mongoose models with `tenantIsolationPlugin`
- **IR caching**: Tools compiled into `AgentIR` at compilation time; no per-request DB lookups during execution
- **Secret resolution**: `SecretsProvider` interface abstracts secret storage; resolved lazily at execution time
- **Namespace scoping**: `NamespaceScopedSecretsFactory` creates per-tool filtered secrets providers when `variable_namespace_ids` present
- **No direct model access in E2E tests**: All test data seeded through public APIs

#### 3. API Contract

**Studio API** (Next.js route handlers):

- CRUD operations on `project_tools` follow REST conventions
- Error envelope: `{ success: false, error: { code: string, message: string } }`
- Tool testing: `POST /api/projects/:id/tools/:toolId/test` with `{ params: Record<string, unknown> }`

**Runtime API**:

- Tool secret CRUD at `/api/tool-secrets` with RBAC middleware
- Tool execution occurs internally through the LLM conversation loop (not exposed as a direct API)

**IR Contract**:

- `ToolDefinition` interface in `packages/compiler/src/platform/ir/schema.ts`
- All tool types share the same `ToolDefinition` shape with type-specific binding fields (e.g., `http_binding`, `mcp_binding`)

#### 4. Security Surface

- **SSRF protection**: `ssrf-validator.ts` in `shared-kernel` blocks private IPs, metadata endpoints, octal/decimal encoding, userinfo bypass
- **Secret encryption**: AES-256-GCM with tenant-scoped keys; values never in API responses
- **Sandbox isolation**: gvisor pods with memory limits and timeouts; path traversal validation
- **Error sanitization**: Stack traces and internal paths stripped before reaching LLM
- **Size limits**: 512KB tool params (DoS protection), 100K chars MCP result cap
- **HTTPS enforcement**: OAuth token endpoints validated for HTTPS
- **CRLF injection prevention**: Header values sanitized
- **RBAC**: Tool CRUD requires `TOOL_READ`/`TOOL_WRITE`; secrets require `credential:*` permissions

### Behavioral Concerns

#### 5. Error Model

| Error Type             | Handler                               | User Experience                                                       |
| ---------------------- | ------------------------------------- | --------------------------------------------------------------------- |
| Tool not found         | `ToolExecutionError(TOOL_NOT_FOUND)`  | LLM receives structured error; can explain to user                    |
| Parameter validation   | `ToolExecutionError(INVALID_PARAMS)`  | LLM receives validation details; can retry with corrected params      |
| SSRF blocked           | `ToolExecutionError(SSRF_BLOCKED)`    | LLM receives "URL not allowed" error                                  |
| Timeout                | `ToolExecutionError(TIMEOUT)`         | LLM receives timeout error; may retry                                 |
| Circuit breaker open   | `ToolExecutionError(CIRCUIT_OPEN)`    | LLM receives "service unavailable" error                              |
| Rate limit exceeded    | `ToolExecutionError(RATE_LIMITED)`    | LLM receives "too many requests" error                                |
| Secret resolution fail | `ToolExecutionError(SECRET_ERROR)`    | LLM receives "credential unavailable" error                           |
| Confirmation tampered  | `ToolExecutionError(TAMPER_DETECTED)` | User informed that parameters were modified; re-confirmation required |
| JIT auth not supported | Structured `JIT_AUTH_NOT_SUPPORTED`   | Channel-specific fallback response                                    |

All errors are caught, sanitized (no stack traces), and returned as `LLMToolResult { success: false, error }`.

#### 6. Failure Modes

| Failure Scenario          | Behavior                                                                    | Blast Radius           |
| ------------------------- | --------------------------------------------------------------------------- | ---------------------- |
| External API down         | Circuit breaker opens after 3 failures; fast-fail for 30s reset period      | Single tool per tenant |
| MCP server unreachable    | 1 retry with exponential backoff; then circuit breaker                      | Single MCP tool        |
| Sandbox backend down      | Timeout after configured limit; error returned to LLM                       | All sandbox tools      |
| Redis unavailable         | Fall back to in-memory circuit breakers (single-pod); rate limiters degrade | Cross-pod resilience   |
| Encryption service down   | 503 on secret creation; existing encrypted secrets still decryptable        | New secret operations  |
| Auth profile service down | Middleware logs warning; falls through to inline auth if configured         | Auth-profile tools     |
| MongoDB down              | Tool CRUD fails; existing compiled IR unaffected during session             | New tool operations    |

#### 7. Idempotency

- **Tool creation**: Tool names are unique per project (compound index); duplicate creation returns conflict error
- **Tool execution**: Tool calls are inherently non-idempotent (HTTP POST to external API may have side effects). Confirmation gates mitigate this for side-effecting tools.
- **Secret rotation**: Version-tracked; rotation increments version number atomically
- **Confirmation snapshots**: Session-scoped, time-bounded (5 min TTL), consumed on use
- **Circuit breaker state**: Tenant-scoped in Redis; eventually consistent across pods

#### 8. Observability

Every tool execution produces:

1. **Structured log entry** (`tool.execution`): toolName, toolType, success, latencyMs, tenantId, sessionId, userId, timestamp
2. **Trace event** (`tool_call`): via `TraceContextManager.logToolCall()` with input/output/metadata
3. **Audit event**: via `ToolAuditLogger` persisted to the shared AuditStore (Kafka -> ClickHouse pipeline when enabled; otherwise ClickHouse > InMemory)
4. **Pipeline filter trace**: original/filtered tool counts and latency when tool filtering is active
5. **MCP truncation warning**: logged when MCP result exceeds 100K character cap

Debug entry points:

- `debug_get_errors` MCP tool surfaces tool binding errors, HTTP failures, schema mismatches
- `debug_diagnose` includes tool configuration in agent inspection
- `debug_traces` shows tool call traces with timing and result summaries

### Operational Concerns

#### 9. Performance Budget

| Operation                  | Target Latency | Payload Limit | Notes                                      |
| -------------------------- | -------------- | ------------- | ------------------------------------------ |
| HTTP tool execution        | <30s (default) | 512KB params  | Configurable via `TOOL_DEFAULT_TIMEOUT_MS` |
| MCP tool execution         | <30s           | 100K chars    | 1 retry for transient errors               |
| Sandbox code execution     | <30s           | 128MB memory  | gvisor pod with memory/time limits         |
| Parameter validation       | <10ms          | 512KB         | Synchronous, in-process                    |
| Secret resolution          | <50ms          | N/A           | AES-256-GCM decrypt per placeholder        |
| Auth profile resolution    | <100ms         | N/A           | May involve OAuth token refresh            |
| Middleware chain traversal | <5ms           | N/A           | Onion model, typically 3-5 middleware      |
| Tool result compaction     | <500ms         | 512KB output  | LLM summarization adds ~1-2s if triggered  |
| Pipeline tool filter       | ~1-2s          | N/A           | LLM-based; reduces downstream tool count   |
| Parallel tool execution    | N/A            | 10 concurrent | Configurable via `maxConcurrency`          |

#### 10. Migration Path

The current architecture is STABLE. No active migration is in progress. Future migrations:

- **Lambda executor**: When implemented, will add a new `LambdaToolExecutor` class following the existing pattern
- **Async webhook executor**: Requires workflow engine integration; will extend `ToolBindingExecutor` dispatch
- **Token-based MCP cap**: If adopted, will modify `McpToolExecutor.MAX_MCP_RESULT_CHARS` to a token-aware calculation
- **Redis-required OAuth state**: If adopted, will deprecate in-memory OAuth state store in production mode

#### 11. Rollback Plan

- **Tool definition changes**: `_v` optimistic concurrency field prevents concurrent overwrites; `sourceHash` tracks content changes
- **Secret rotation**: Version-tracked; previous version can be restored by creating a new secret with the old value
- **Executor changes**: New executor classes are additive; removing one falls back to the fallback executor
- **Middleware changes**: Middleware chain is configured at session initialization; removing a middleware is a runtime config change
- **IR schema changes**: IR is compiled per-version; rolling back agent version restores the previous tool definitions

#### 12. Test Strategy

| Layer       | Coverage Target | What Gets Tested                                                            |
| ----------- | --------------- | --------------------------------------------------------------------------- |
| Unit        | 90%+            | Individual executors, validators, middleware, compressors, mappers          |
| Integration | 70%+            | Executor dispatch routing, middleware chain, secret resolution pipeline     |
| E2E         | Critical paths  | Full lifecycle (create-bind-execute-respond), auth flows, confirmation, A2A |

Current state: 66+ test files, 1,000+ test cases, 19-scenario API E2E suite. Primary gap: cross-tenant isolation E2E.

---

## 5. Data Model

### Existing Collections

```
project_tools (primary tool storage)
  - _id, tenantId, projectId, name, slug, toolType, description
  - dslContent, sourceHash, variableNamespaceIds
  - createdBy, lastEditedBy, _v, createdAt, updatedAt
  - Indexes: {tenantId, projectId, name} unique, {tenantId, projectId, slug} unique
  - Plugin: tenantIsolationPlugin
  - Guard: slug immutability

tool_secrets (encrypted credential storage)
  - _id, tenantId, projectId, toolName, secretKey
  - encryptedValue (AES-256-GCM), environment, version
  - expiresAt, rotatedAt, createdBy, createdAt, updatedAt

end_user_oauth_tokens (per-user OAuth tokens)
  - tenantId, userId, provider
  - encryptedAccessToken, encryptedRefreshToken, scope, expiresAt
```

### No New Collections Required

The existing data model is complete for the current feature scope. No schema changes are needed.

### Key Relationships

- `project_tools.projectId` -> project (tools are project-scoped)
- `project_tools.variableNamespaceIds` -> `variable_namespaces` (env var scoping)
- Agent IR references tools by `name` (resolved at compilation time)
- `tool_secrets` resolved at runtime via `{{secrets.KEY}}` placeholders
- `end_user_oauth_tokens` resolved per-user per-provider via `ToolOAuthService`

---

## 6. API Design

### Existing Endpoints (No Changes Required)

**Studio API**:

| Method | Path                                        | Purpose             | Auth                        |
| ------ | ------------------------------------------- | ------------------- | --------------------------- |
| GET    | `/api/projects/:id/tools`                   | List project tools  | Project member (TOOL_READ)  |
| POST   | `/api/projects/:id/tools`                   | Create tool         | Project member (TOOL_WRITE) |
| GET    | `/api/projects/:id/tools/:toolId`           | Get tool detail     | Project member (TOOL_READ)  |
| PUT    | `/api/projects/:id/tools/:toolId`           | Update tool         | Project member (TOOL_WRITE) |
| DELETE | `/api/projects/:id/tools/:toolId`           | Delete tool         | Project member (TOOL_WRITE) |
| POST   | `/api/projects/:id/tools/:toolId/duplicate` | Duplicate tool      | Project member (TOOL_WRITE) |
| POST   | `/api/projects/:id/tools/:toolId/test`      | Test tool execution | Project member (TOOL_WRITE) |
| GET    | `/api/projects/:id/tools/:toolId/export`    | Export tool JSON    | Project member (TOOL_READ)  |
| POST   | `/api/projects/:id/tools/import`            | Import tool JSON    | Project member (TOOL_WRITE) |

**Runtime API**:

| Method | Path                           | Purpose       | Auth              |
| ------ | ------------------------------ | ------------- | ----------------- |
| POST   | `/api/tool-secrets`            | Create secret | credential:write  |
| GET    | `/api/tool-secrets`            | List secrets  | credential:read   |
| POST   | `/api/tool-secrets/:id/rotate` | Rotate secret | credential:write  |
| DELETE | `/api/tool-secrets/:id`        | Delete secret | credential:delete |

### Error Responses

All errors follow the platform error envelope:

```json
{
  "success": false,
  "error": {
    "code": "TOOL_NOT_FOUND",
    "message": "Tool 'get_weather' not found in project scope"
  }
}
```

---

## 7. Cross-Cutting Concerns

### Audit Logging

- Every tool execution produces a structured audit event via `ToolAuditLogger`
- Audit events include: action (`tool:<toolName>`), tool type, success/failure, latency, tenant/session/user context
- Audit persistence: shared AuditStore (Kafka -> ClickHouse pipeline when enabled; otherwise ClickHouse > InMemory)
- All secret operations (create, rotate, delete) produce audit log entries

### Rate Limiting

- Per-tool rate limiting via `tool-call-rate-plan.ts`
- Tenant-scoped rate limiters via Redis-backed sliding window
- Circuit breaker factory creates tenant-scoped circuit breakers via `HybridCircuitBreakerRegistry`

### Caching

- **Tool definitions**: Cached in agent IR at compilation time (no per-request DB lookups)
- **HTTP connections**: Keep-alive connection pooling with configurable socket pool (`HTTP_TOOL_MAX_SOCKETS`)
- **Circuit breaker state**: Redis-backed for cross-pod consistency
- **No explicit result caching**: Tool results are not cached between invocations (tools may return different results for the same input)

### Encryption

- **At rest**: Tool secrets encrypted with AES-256-GCM using tenant-scoped keys
- **In transit**: All external tool calls over HTTPS (enforced for OAuth endpoints)
- **OAuth tokens**: Encrypted at rest with tenant-scoped keys
- **Secret values**: Never returned in API responses; only metadata exposed

---

## 8. Dependencies

### Upstream (This Feature Depends On)

| Dependency                | Risk   | Notes                                                        |
| ------------------------- | ------ | ------------------------------------------------------------ |
| MongoDB                   | Low    | Primary storage for tools and secrets                        |
| Redis                     | Medium | Circuit breakers, rate limiters; in-memory fallback          |
| Encryption Service (KMS)  | Medium | Secret encryption; 503 if unavailable for new secrets        |
| LLM Provider              | Low    | Tool calls triggered by LLM tool_use; tool result compaction |
| MCP Server Infrastructure | Medium | Required for MCP tool execution; circuit breaker mitigates   |
| Sandbox Infrastructure    | Medium | Required for code execution; timeout mitigates               |
| Compiler (IR)             | Low    | Tool definitions compiled into agent IR                      |

### Downstream (Depends On This Feature)

| Dependent               | Impact | Notes                                                    |
| ----------------------- | ------ | -------------------------------------------------------- |
| Agent Conversation Loop | High   | All tool execution flows through this system             |
| Auth Profile System     | Medium | Auth profile middleware depends on tool middleware chain |
| Guardrails              | Medium | Pre/post tool guardrails integrate with tool execution   |
| Tracing & Observability | Medium | Tool trace events are a key data source                  |
| A2A Integration         | Medium | A2A inbound messages use the same tool pipeline          |
| Studio Tool Builder     | Medium | Studio depends on tool CRUD APIs and test execution      |
| Connectors              | Medium | Connector-bound tools route through this dispatcher      |

---

## 9. Open Questions & Decisions Needed

1. **Lambda executor priority**: Should lambda tool type be implemented or deprecated from the IR schema?
2. **Async webhook integration**: What is the timeline for workflow engine integration needed for async webhook tools?
3. **Token-based MCP cap**: Should the 100K character cap transition to a token-aware calculation?
4. **Redis requirement**: Should OAuth state store require Redis in production (deprecating in-memory)?
5. **Isolation E2E**: Should cross-tenant/project isolation E2E be a gate for STABLE status?

---

## 10. References

- Feature spec: [docs/features/tool-invocations.md](../features/tool-invocations.md)
- Test spec: [docs/testing/tool-invocations.md](../testing/tool-invocations.md)
- IR schema: `packages/compiler/src/platform/ir/schema.ts` (ToolDefinition at line 612)
- Central dispatcher: `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts`
- Middleware chain: `packages/compiler/src/platform/constructs/executors/tool-middleware.ts`
- SSRF validator: `packages/shared-kernel/src/security/ssrf-validator.ts`
- LLM wiring: `apps/runtime/src/services/execution/llm-wiring.ts`
- Security hardening: `docs/plans/2026-03-11-runtime-security-hardening.md`
