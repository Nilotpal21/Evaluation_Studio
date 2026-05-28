# LLD + Implementation Plan: Tool Invocations

**Feature**: [Tool Invocations](../features/tool-invocations.md)
**HLD**: [Tool Invocations HLD](../specs/tool-invocations.hld.md)
**Test Spec**: [Tool Invocations Test Spec](../testing/tool-invocations.md)
**Date**: 2026-03-22
**Status**: STABLE (documenting existing system + improvement phases)

---

## 1. Design Decisions

### Decision Log

| Decision                                           | Rationale                                                                                   | Alternatives Rejected                                   |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| Dispatcher + type-specific executor pattern        | Open-closed: new tool types add new executors without modifying core dispatch               | Monolithic executor (violates OCP, hard to test)        |
| Composable onion-model middleware chain            | Cross-cutting concerns (auth, audit, PII) decoupled from executor logic                     | Hard-coded pre/post hooks in dispatcher                 |
| IR-embedded tool definitions                       | No per-request DB lookups; immutable per-version                                            | Runtime DB resolution (adds latency, breaks versioning) |
| Namespace-scoped executor instances                | Per-tool env var isolation via `variable_namespace_ids`                                     | Global secrets provider only (no per-tool scoping)      |
| SSRF validation in shared-kernel                   | Reusable across all HTTP-making code, not just tool executor                                | Per-executor SSRF logic (duplicated, drift risk)        |
| AES-256-GCM for secret encryption                  | Industry standard symmetric encryption; tenant-scoped keys                                  | RSA (slower for bulk), plaintext (unacceptable)         |
| Confirmation snapshots with immutable params       | Prevents TOCTOU tampering between user approval and execution                               | Stateless confirmation (no tamper detection)            |
| Auth profile as middleware, not executor concern   | Auth injection is cross-cutting; same logic for HTTP, MCP (future), any HTTP-backed type    | Per-executor auth logic (duplicated)                    |
| Tenant-scoped circuit breakers via Redis           | Multi-pod consistency; in-memory fallback for single-pod                                    | Global circuit breakers (no tenant isolation)           |
| Tool result compaction before history insertion    | Reduces LLM context window consumption; multiple strategies (compress, truncate, summarize) | Raw results only (context overflow risk)                |
| Pipeline tool filter via LLM                       | Reduces tool count presented to LLM; improves accuracy for agents with many tools           | Static tool filtering (less adaptive)                   |
| Session context propagation via ToolSessionContext | Audit trail correlation across tool executions in a session                                 | Per-execution context (no session correlation)          |

### Key Interfaces & Types

```typescript
// packages/compiler/src/platform/ir/schema.ts
export interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  returns: ToolReturnType;
  hints: ToolHints;
  system?: boolean;
  tool_type?:
    | 'http'
    | 'mcp'
    | 'sandbox'
    | 'lambda'
    | 'connector'
    | 'workflow'
    | 'searchai'
    | 'async_webhook';
  http_binding?: HttpBindingIR;
  mcp_binding?: McpBindingIR;
  sandbox_binding?: SandboxBindingIR;
  searchai_binding?: SearchAIBindingIR;
  connector_binding?: ConnectorBindingIR;
  workflow_binding?: WorkflowBindingIR;
  async_webhook_binding?: AsyncWebhookBindingIR;
  confirmation?: {
    require: 'always' | 'never' | 'when_side_effects';
    immutable_params?: string[];
  };
  pii_access?: 'tools' | 'user' | 'logs' | 'llm';
  on_result?: { set: Record<string, string> };
  on_error?: { set: Record<string, string> };
  context_access?: ToolContextAccess;
  variable_namespace_ids?: string[];
  auth_profile_ref?: string;
  jit_auth?: boolean;
  connection_mode?: 'per_user' | 'shared';
  consent_mode?: 'preflight' | 'inline';
  compaction?: ToolCompactionConfig;
}

// packages/compiler/src/platform/constructs/types.ts
export interface ToolExecutor {
  execute(toolCall: LLMToolCall): Promise<LLMToolResult>;
}

// packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts
export interface ToolBindingExecutorConfig {
  tools: ToolDefinition[];
  secrets: SecretsProvider;
  mcpClients?: McpClientProvider;
  sandboxRunner?: SandboxRunner;
  fallbackExecutor?: ToolExecutor;
  defaultTimeoutMs?: number;
  trace?: TraceContextManager;
  maxConcurrency?: number;
  middleware?: ToolMiddleware[];
  allowLocalhost?: boolean;
  resilienceFactory?: ResilienceFactory;
  proxyResolver?: ProxyResolver;
  projectId?: string;
  sessionContext?: ToolSessionContext;
  connectorToolExecutor?: ToolExecutor;
  workflowToolExecutor?: ToolExecutor;
  searchaiToolExecutor?: ToolExecutor;
  namespaceScopedSecretsFactory?: NamespaceScopedSecretsFactory;
}

// packages/compiler/src/platform/constructs/executors/tool-middleware.ts
export type ToolMiddleware = (
  ctx: ToolCallContext,
  next: () => Promise<ToolCallResult>,
) => Promise<ToolCallResult>;
```

### Module Boundaries

| Module                   | Package                    | Responsibility                                                       |
| ------------------------ | -------------------------- | -------------------------------------------------------------------- |
| Tool IR Schema           | `@abl/compiler`            | Type definitions for ToolDefinition, bindings, parameters            |
| Tool Binding Executor    | `@abl/compiler`            | Central dispatch, validation, confirmation gate, middleware chain    |
| HTTP Tool Executor       | `@abl/compiler`            | HTTP execution with SSRF, auth, proxy, resilience                    |
| MCP Tool Executor        | `@abl/compiler`            | MCP server calls with circuit breaker, retry, result cap             |
| Sandbox Tool Executor    | `@abl/compiler`            | Code execution with isolation, memory API, timeout                   |
| Tool Middleware          | `@abl/compiler`            | Composable onion-model middleware chain                              |
| Tool Schema Validator    | `@abl/compiler`            | Compile-time validation of tool definitions                          |
| SSRF Validator           | `shared-kernel`            | IP validation, metadata blocking, encoding detection                 |
| LLM Wiring               | `apps/runtime`             | Session-level tool executor construction and middleware registration |
| Auth Profile Middleware  | `apps/runtime`             | Per-request credential resolution and HTTP binding mutation          |
| Tool OAuth Service       | `apps/runtime`             | OAuth 2.0 flows (auth code, client credentials, refresh, revoke)     |
| Tool Secrets Routes      | `apps/runtime`             | CRUD API for encrypted tool secrets                                  |
| Tool Confirmation        | `apps/runtime`             | Immutable parameter snapshots for confirmation gates                 |
| Tool Memory Bridge       | `apps/runtime`             | Imperative memory API for sandbox tools                              |
| Tool Result Compressor   | `apps/runtime`             | Compression, truncation, LLM summarization of large results          |
| Tool Resilience Factory  | `apps/runtime`             | Tenant-scoped circuit breakers and rate limiters                     |
| Tool Audit Logger        | `apps/runtime`             | Structured audit event logging                                       |
| Pipeline Tool Filter     | `apps/runtime`             | LLM-based tool pre-selection                                         |
| Load Project Tools as IR | `apps/runtime`             | MongoDB to IR conversion                                             |
| SearchAI Tool Executors  | `apps/runtime`             | SearchAI KB tool execution                                           |
| Transfer Tool Executor   | `apps/runtime`             | Agent handoff/transfer tool                                          |
| Attachment Tool Executor | `apps/runtime`             | File attachment handling                                             |
| Connector Tool Executor  | `packages/connectors`      | Connector-bound tool execution                                       |
| Workflow Tool Executor   | `packages/connectors`      | Workflow-bound tool execution                                        |
| Studio Tool CRUD Routes  | `apps/studio`              | Next.js API routes for tool management                               |
| Studio Tool Store        | `apps/studio`              | Zustand store for client-side tool state                             |
| Studio Tool Components   | `apps/studio`              | UI components: wizards, editors, test panels, pickers                |
| Tool Test Service        | `apps/studio`              | Studio-side tool test execution                                      |
| Shared Tool Validation   | `@agent-platform/shared`   | Project tool validator, DSL serialization/parsing                    |
| Tool Effectiveness       | `packages/pipeline-engine` | Analytics for tool execution effectiveness                           |

---

## 2. File-Level Change Map

Since this is documenting an existing STABLE feature, the change map focuses on the improvement phases that close identified gaps.

### Existing Files (No Immediate Changes)

| File                                                                           | Purpose                 | Status |
| ------------------------------------------------------------------------------ | ----------------------- | ------ |
| `packages/compiler/src/platform/ir/schema.ts`                                  | ToolDefinition IR types | Stable |
| `packages/compiler/src/platform/constructs/types.ts`                           | ToolExecutor interface  | Stable |
| `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` | Central dispatcher      | Stable |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`    | HTTP executor           | Stable |
| `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts`     | MCP executor            | Stable |
| `packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts` | Sandbox executor        | Stable |
| `packages/compiler/src/platform/constructs/executors/tool-middleware.ts`       | Middleware chain        | Stable |
| `packages/compiler/src/platform/ir/tool-schema-validator.ts`                   | Compile-time validation | Stable |
| `packages/shared-kernel/src/security/ssrf-validator.ts`                        | SSRF protection         | Stable |
| `apps/runtime/src/services/execution/llm-wiring.ts`                            | Session-level wiring    | Stable |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts`       | Auth profile middleware | Stable |
| `apps/runtime/src/services/tool-oauth-service.ts`                              | OAuth service           | Stable |
| `apps/runtime/src/services/tool-audit-logger.ts`                               | Audit logger            | Stable |
| `apps/runtime/src/services/execution/tool-confirmation.ts`                     | Confirmation gate       | Stable |
| `apps/runtime/src/services/execution/tool-memory-bridge.ts`                    | Memory bridge           | Stable |
| `apps/runtime/src/services/execution/tool-result-compressor.ts`                | Result compressor       | Stable |
| `apps/runtime/src/services/resilience/tool-resilience-factory.ts`              | Resilience factory      | Stable |
| `apps/runtime/src/routes/tool-secrets.ts`                                      | Secret routes           | Stable |

### Phase 1: Planned New/Modified Files

| File                                                                   | Change Description                               | Risk |
| ---------------------------------------------------------------------- | ------------------------------------------------ | ---- |
| `apps/studio/src/__tests__/e2e/tool-invocations-isolation.e2e.test.ts` | New E2E: cross-tenant/project isolation          | Low  |
| `packages/compiler/src/platform/ir/tool-schema-validator.ts`           | Add connector/workflow/searchai validation rules | Low  |

### Phase 2: Planned New/Modified Files

| File                                                                    | Change Description                         | Risk   |
| ----------------------------------------------------------------------- | ------------------------------------------ | ------ |
| `apps/studio/src/__tests__/e2e/tool-invocations-resilience.e2e.test.ts` | New E2E: circuit breaker lifecycle via API | Medium |
| `apps/runtime/src/services/execution/tool-result-compressor.ts`         | Add token-aware truncation option          | Low    |
| `apps/runtime/src/services/tool-oauth-service.ts`                       | Add Redis-backed state store option        | Medium |

### Phase 3: Planned New/Modified Files

| File                                                                           | Change Description                             | Risk   |
| ------------------------------------------------------------------------------ | ---------------------------------------------- | ------ |
| `packages/compiler/src/platform/constructs/executors/lambda-tool-executor.ts`  | New: Lambda tool executor implementation       | Medium |
| `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` | Register lambda executor in dispatch table     | Low    |
| `apps/runtime/src/services/execution/llm-wiring.ts`                            | Wire lambda executor in session initialization | Low    |

---

## 3. Implementation Phases

### Phase 1: Close Isolation and Validation Gaps

**Goal**: Add cross-tenant/project isolation E2E tests and extend tool schema validator to cover all tool types.

**Tasks**:

1.1. Create `tool-invocations-isolation.e2e.test.ts` with E2E-13 scenarios from test spec: create tool in tenant A, attempt access from tenant B (expect 404), verify secret isolation across tenants.
1.2. Extend `tool-schema-validator.ts` to add validation rules for connector binding (require `connector` + `action` fields), workflow binding (require `workflowId` + `mode`), and searchai binding (require `tenantId` + `indexId`).
1.3. Add unit tests for the new validator rules in `tool-schema-validator.test.ts`.

**Files Touched**:

- `apps/studio/src/__tests__/e2e/tool-invocations-isolation.e2e.test.ts` -- new E2E test file
- `packages/compiler/src/platform/ir/tool-schema-validator.ts` -- add connector/workflow/searchai validation
- `packages/compiler/src/__tests__/constructs/tool-schema-validator.test.ts` -- add new validation tests

**Exit Criteria**:

- [ ] `tool-invocations-isolation.e2e.test.ts` has at least 5 scenarios covering cross-tenant tool access (404), cross-project tool access (404), cross-tenant secret access (404), cross-project secret access (404), and auth-profile isolation
- [ ] `tool-schema-validator.ts` validates connector, workflow, and searchai binding fields
- [ ] `pnpm build --filter=@abl/compiler` succeeds with 0 errors
- [ ] All existing tool-related tests continue to pass
- [ ] New validator unit tests pass for all 3 new tool types

**Test Strategy**:

- Unit: New validation rules for connector/workflow/searchai bindings
- E2E: Cross-tenant and cross-project isolation via public APIs

**Rollback**: Delete new test file and revert validator changes. No data model changes.

### Phase 2: Improve Resilience and Result Processing

**Goal**: Add resilience E2E coverage, token-aware result truncation, and Redis-backed OAuth state.

**Tasks**:

2.1. Create `tool-invocations-resilience.e2e.test.ts` exercising circuit breaker lifecycle through the API: trigger 3 failures (circuit opens), verify fast-fail, wait for reset, verify recovery.
2.2. Add token-aware truncation option to `tool-result-compressor.ts`: use tiktoken-compatible token counting when available, fall back to character-based.
2.3. Add Redis-backed OAuth state store option to `tool-oauth-service.ts`: when `REDIS_URL` is available, use Redis instead of in-memory Map for OAuth state.
2.4. Add unit tests for token-aware truncation and Redis-backed OAuth state.

**Files Touched**:

- `apps/studio/src/__tests__/e2e/tool-invocations-resilience.e2e.test.ts` -- new E2E test file
- `apps/runtime/src/services/execution/tool-result-compressor.ts` -- add token-aware option
- `apps/runtime/src/services/tool-oauth-service.ts` -- add Redis state store
- `apps/runtime/src/__tests__/tool-result-compressor.test.ts` -- add token-aware tests
- `apps/runtime/src/__tests__/tool-oauth-service.test.ts` -- add Redis state tests

**Exit Criteria**:

- [ ] Resilience E2E proves circuit breaker open/close/half-open lifecycle through public API
- [ ] Token-aware truncation produces smaller results than character-based for the same token budget
- [ ] Redis-backed OAuth state store passes state round-trip test (set -> get -> delete)
- [ ] `pnpm build --filter=@agent-platform/runtime` succeeds with 0 errors
- [ ] All existing tool tests continue to pass

**Test Strategy**:

- Unit: Token-aware truncation, Redis OAuth state store
- E2E: Circuit breaker lifecycle via agent chat API

**Rollback**: Revert compressor and OAuth changes; delete new test files. No data model changes.

### Phase 3: Implement Lambda Executor

**Goal**: Implement the lambda tool executor to complete the declared IR schema support.

**Tasks**:

3.1. Create `lambda-tool-executor.ts` following the `SandboxToolExecutor` pattern: accept `LambdaBindingIR`, invoke AWS Lambda via SDK, apply timeout, parse response.
3.2. Define `LambdaBindingIR` interface in `schema.ts` (function ARN, region, invocation type, timeout).
3.3. Register lambda executor in `ToolBindingExecutor` dispatch table.
3.4. Wire lambda executor in `llm-wiring.ts` session initialization.
3.5. Add unit tests for lambda executor (invoke, timeout, error handling, IAM auth).
3.6. Update `tool-schema-validator.ts` to validate lambda binding fields.

**Files Touched**:

- `packages/compiler/src/platform/constructs/executors/lambda-tool-executor.ts` -- new executor
- `packages/compiler/src/platform/ir/schema.ts` -- add LambdaBindingIR
- `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` -- register lambda
- `packages/compiler/src/platform/ir/tool-schema-validator.ts` -- add lambda validation
- `apps/runtime/src/services/execution/llm-wiring.ts` -- wire lambda executor
- `packages/compiler/src/__tests__/constructs/lambda-tool-executor.test.ts` -- new unit tests
- `packages/compiler/src/__tests__/constructs/tool-schema-validator.test.ts` -- add lambda validation tests

**Exit Criteria**:

- [ ] Lambda executor invokes mock Lambda function and returns structured result
- [ ] Lambda executor respects timeout and returns error on timeout
- [ ] Lambda executor handles invocation errors gracefully
- [ ] `ToolBindingExecutor` routes `tool_type: 'lambda'` to lambda executor
- [ ] `tool-schema-validator.ts` validates lambda binding fields (functionArn, region required)
- [ ] `pnpm build --filter=@abl/compiler` succeeds with 0 errors
- [ ] All existing tool tests continue to pass
- [ ] Lambda executor unit tests pass (minimum 8 test cases)

**Test Strategy**:

- Unit: Lambda executor (invoke, timeout, error, auth), validator rules
- Integration: Dispatch routing with lambda tool type

**Rollback**: Delete new executor file and revert dispatch/wiring changes. Lambda tool type remains declared in IR with "not yet implemented" error.

### Phase 4: Extend Trace Diagnostics

**Goal**: Add explicit reason codes to tool execution traces for improved production triage.

**Tasks**:

4.1. Define `ToolExecutionReasonCode` enum in `tool-binding-executor.ts`: `AUTH_GATE_BLOCKED`, `CONSENT_REQUIRED`, `RETRY_ATTEMPTED`, `CIRCUIT_OPEN`, `RATE_LIMITED`, `CONFIRMATION_PENDING`, `JIT_AUTH_FALLBACK`, `CANCELLED`.
4.2. Emit reason codes in trace events alongside existing success/failure signals.
4.3. Update `ToolAuditLogger` to include reason code in audit events.
4.4. Add unit tests for reason code emission in each scenario.

**Files Touched**:

- `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` -- add reason codes
- `apps/runtime/src/services/tool-audit-logger.ts` -- emit reason codes
- `packages/compiler/src/__tests__/constructs/tool-binding-executor.test.ts` -- add reason code tests
- `apps/runtime/src/__tests__/tool-audit-logger.test.ts` -- add reason code tests

**Exit Criteria**:

- [ ] `ToolExecutionReasonCode` enum covers all 8 defined reason codes
- [ ] Trace events include `reasonCode` field when applicable
- [ ] Audit events include `reasonCode` field when applicable
- [ ] Existing trace/audit tests continue to pass
- [ ] `pnpm build --filter=@abl/compiler --filter=@agent-platform/runtime` succeeds with 0 errors
- [ ] New reason code unit tests pass (minimum 8 test cases)

**Test Strategy**:

- Unit: Reason code emission for each scenario

**Rollback**: Revert reason code additions. Traces continue to work with existing success/failure signals.

---

## 4. Wiring Checklist

- [x] `ToolBindingExecutor` registered in session initialization via `llm-wiring.ts`
- [x] HTTP/MCP/Sandbox executors registered in `ToolBindingExecutor` constructor
- [x] Connector/Workflow/SearchAI executors wired via config properties
- [x] Middleware chain composed and applied in `ToolBindingExecutor.execute()`
- [x] Auth-profile middleware added to middleware chain in `llm-wiring.ts`
- [x] Tool secrets routes registered in runtime Express router
- [x] Studio tool CRUD routes registered as Next.js API routes
- [x] Tool store (Zustand) used by Studio tool components
- [x] Tool test service wired to Studio API routes
- [x] DynamicToolInputForm rendered in TestToolDialog
- [x] ToolPickerDialog/ToolPickerModal rendered in ToolsEditor
- [x] StaleToolBanner rendered in agent detail page
- [x] SSRF validator imported from shared-kernel in HTTP executor
- [x] AuditStore wired to ToolAuditLogger
- [x] TraceContextManager wired to ToolBindingExecutor

### Phase-Specific Wiring (Future)

- [ ] Phase 1: New isolation E2E test file added to test configuration
- [ ] Phase 1: New validator rules exported from tool-schema-validator
- [ ] Phase 3: Lambda executor imported and registered in tool-binding-executor dispatch
- [ ] Phase 3: Lambda executor wired in llm-wiring.ts session initialization
- [ ] Phase 4: Reason code enum exported from tool-binding-executor

---

## 5. Cross-Phase Concerns

### Database Migrations

No database migrations required. The existing schema supports all current and planned phases.

### Feature Flags

No feature flags required. All improvements are additive and backward-compatible:

- Phase 1: Additional tests and validation rules (no behavior change for existing tools)
- Phase 2: Token-aware truncation is opt-in; Redis OAuth state auto-detected
- Phase 3: Lambda executor is a new type; does not affect existing tool types
- Phase 4: Reason codes are additive trace metadata; do not change execution behavior

### Configuration Changes

| Phase | New Config                  | Default     | Notes                                     |
| ----- | --------------------------- | ----------- | ----------------------------------------- |
| 2     | `TOOL_RESULT_TOKEN_AWARE`   | `false`     | Enable token-aware truncation             |
| 2     | `OAUTH_STATE_STORE`         | `memory`    | `memory` or `redis`                       |
| 3     | `LAMBDA_DEFAULT_TIMEOUT_MS` | `30000`     | Lambda invocation timeout                 |
| 3     | `LAMBDA_REGION`             | `us-east-1` | Default AWS region for Lambda invocations |

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All phases complete with exit criteria met
- [ ] E2E tests from test spec passing (including new isolation and resilience E2E)
- [ ] Integration tests from test spec passing
- [ ] No regressions in existing 1,000+ tool-related tests
- [ ] Feature spec updated with implementation details for completed phases
- [ ] Testing matrix updated with actual coverage for new tests
- [ ] All identified GAPs have either been closed or have a documented plan with timeline

---

## 7. Open Questions

1. Should lambda executor implementation be prioritized or should the `lambda` tool type be deprecated from the IR schema?
2. What AWS SDK version and authentication approach should the lambda executor use (IAM role, access key)?
3. Should token-aware truncation depend on a specific tokenizer (tiktoken) or use a generic approximation?
4. What is the acceptable latency overhead for Redis-backed OAuth state compared to in-memory?
5. Should reason codes be a breaking change to the trace event schema or an additive field?
