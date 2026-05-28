# Feature: Tool Invocations

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: STABLE
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `customer experience`, `integrations`, `observability`, `governance`, `enterprise`
**Package(s)**: `@abl/compiler`, `apps/runtime`, `apps/studio`, `@agent-platform/shared`, `@agent-platform/shared-kernel`, `@agent-platform/database`, `packages/connectors`, `packages/core`, `packages/project-io`, `packages/pipeline-engine`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/tool-invocations.md](../testing/tool-invocations.md)
**Last Updated**: 2026-04-15

---

## 1. Introduction / Overview

### Problem Statement

Agents need a secure, traceable, and unified way to call external systems, execute code, query knowledge sources, and trigger actions during conversations. Without a shared invocation system each agent implementation would reinvent execution semantics, leading to inconsistent validation, divergent security posture, fragile runtime wiring, and duplicated Studio authoring patterns. The problem affects agent builders who must compose tools into agents, runtime engineers who must ensure safe execution across tool types, and operators who need auditable control over outbound actions.

### Goal Statement

Tool Invocations makes tool definition, validation, binding, execution, confirmation, secret/credential management, OAuth flows, resilience controls, and tracing first-class platform primitives. Every supported tool type can be authored in Studio and executed at runtime through a consistent, secure pipeline regardless of channel (digital, voice, A2A, SDK, MCP).

### Summary

Tool Invocations is the core mechanism by which agents interact with external systems during conversations. Tools are defined at the project level, compiled into the agent's Intermediate Representation (IR), and dispatched at runtime through a type-specific executor pipeline with full resilience, security, and audit capabilities.

The system supports multiple tool types: HTTP API calls, MCP (Model Context Protocol) server integrations, sandboxed code execution (JavaScript/Python), SearchAI knowledge base queries, connector-bound tools, workflow-bound tools, and async webhook tools. Each type has a dedicated executor with its own binding configuration, and all share a common parameter validation, middleware, and tracing infrastructure.

Security is a first-class concern: SSRF protection on all outbound HTTP requests, AES-256-GCM encrypted secret/credential resolution, tenant-scoped circuit breakers and rate limiters, sandboxed code execution with memory and time limits, and immutable parameter confirmation for side-effect-bearing operations.

### Key Capabilities

- **Multi-type tool execution**: HTTP, MCP, Sandbox, SearchAI, Connector, Workflow, Async Webhook
- **SSRF protection**: Blocks private IPs, cloud metadata endpoints, octal/decimal IP encoding, userinfo bypass
- **Secret/credential management**: AES-256-GCM encrypted storage, per-tool namespace-scoped resolution, OAuth 2.0 flows
- **Auth profile injection**: Runtime middleware resolves per-tool credentials, takes precedence over inline HTTP auth, and mutates HTTP headers, query params, or TLS config immediately before dispatch
- **Resilience**: Per-tool circuit breakers, rate limiters, retry with backoff, configurable timeouts
- **Parameter validation**: Schema-based type checking, coercion (string-to-number/boolean), enum enforcement, default injection
- **Tool confirmation**: Immutable parameter snapshots prevent tampering between user confirmation and execution
- **Tool result compaction**: Structured compression, truncation, and LLM-powered summarization for large results
- **Pipeline tool filtering**: LLM-based pre-selection of relevant tools per user message
- **Variable namespace auto-tagging**: Tools auto-assigned to default namespace for scoped env var resolution
- **Middleware chain**: Composable onion-model middleware for logging, PII scrubbing, audit
- **Studio tool builder**: Visual UI with type-specific wizards (HTTP, MCP, Sandbox), live testing, import/export
- **Declarative context access**: Session variables auto-injected into tool params before execution and auto-written from responses
- **JIT authentication**: Just-in-time auth support for interactive channels with structured fallback for non-interactive channels
- **A2A execution**: Authenticated agent-to-agent traffic runs through the same invocation pipeline

---

## 2. Scope

### Goals

- Provide one secure runtime execution pipeline for all supported tool types (HTTP, MCP, Sandbox, SearchAI, Connector, Workflow, Async Webhook).
- Keep tool authoring, testing, import/export, and agent binding coherent across Studio and runtime.
- Reuse shared confirmation, secrets, OAuth, resilience, and tracing primitives across all tool executions.
- Ensure every tool execution is traceable through structured audit events, trace logs, and observability signals.
- Enforce tenant, project, and user isolation at every layer of the tool lifecycle.

### Non-Goals (Out of Scope)

- Full implementation of every declared IR tool type (lambda and async_webhook remain partial).
- Replacing feature-specific docs for MCP, connectors, or SearchAI integrations with this spec.
- Complete API-level E2E coverage for every isolation boundary and infrastructure-dependent execution mode.
- Real external-backend CI coverage for MCP servers, gvisor sandboxes, and live OAuth providers (nightly integration lanes planned).

---

## 3. User Stories

1. As an **agent builder**, I want to create and test tools in Studio so that I can bind them to agents without hand-authoring runtime code.
2. As a **runtime engineer**, I want a single dispatcher and middleware chain for all tool types so that validation, tracing, and auth behavior stay consistent regardless of tool type.
3. As an **operator**, I want tool executions to be auditable, rate-limited, and secure so that risky outbound actions remain controllable in production.
4. As an **agent builder**, I want to define confirmation gates on side-effecting tools so that the end user must approve sensitive operations before they execute.
5. As a **platform administrator**, I want tool secrets encrypted at rest and tenant-scoped so that credentials cannot leak across tenants or be exposed in API responses.
6. As an **agent builder**, I want to bind auth profiles to tools so that per-user OAuth tokens are resolved at runtime without embedding credentials in tool definitions.
7. As an **end user**, I want tools that require my authorization to prompt me for consent before executing so that my external accounts are not accessed without permission.
8. As a **runtime engineer**, I want large tool results compressed before entering conversation history so that LLM context windows are not exhausted by verbose tool output.

---

## 4. Functional Requirements

1. **FR-1**: The system must support multiple tool types (HTTP, MCP, Sandbox, SearchAI, Connector, Workflow, Async Webhook) through a shared runtime dispatcher (`ToolBindingExecutor`) and type-specific executors.
2. **FR-2**: The system must validate tool definitions at compile time (`ToolSchemaValidator`) and invocation parameters at runtime before dispatch (required fields, type coercion, enum enforcement, defaults injection, size limits).
3. **FR-3**: The system must resolve encrypted secrets (`{{secrets.KEY}}`), environment variables (`{{env.KEY}}`), auth profiles, and OAuth credentials at runtime where required by the tool binding.
4. **FR-4**: The system must support confirmation gates for side-effecting operations with immutable parameter snapshots that prevent tampering between user confirmation and execution.
5. **FR-5**: The system must apply resilience controls: configurable timeouts (default 30s), retry with exponential backoff (MCP), tenant-scoped circuit breakers (3-failure threshold, 30s reset), and per-tool rate limiters (Redis-backed sliding window).
6. **FR-6**: The system must emit trace events (`tool_call` via `TraceContextManager.logToolCall()`), structured audit logs (`ToolAuditLogger`), and `tool.execution` log entries for every tool execution with tenant/session correlation.
7. **FR-7**: The system must support a composable middleware chain (onion model) that can mutate tool call metadata before dispatch, including auth-profile-backed HTTP auth injection, PII scrubbing, and audit logging.
8. **FR-8**: The system must provide Studio UI for tool creation (type-specific wizards), editing, testing with sample input, import/export, and agent binding through `ToolPickerDialog`/`ToolPickerModal`.
9. **FR-9**: The system must enforce SSRF protection on all HTTP tool URLs: private IP ranges (RFC 1918, loopback, link-local, CGN), cloud metadata endpoints, octal/decimal IP encoding, and userinfo bypass attacks.
10. **FR-10**: The system must support declarative context access (`context_access.read`/`write`) for auto-injecting session variables into tool params and auto-writing tool response values back to session state.
11. **FR-11**: The system must support JIT (just-in-time) authentication for interactive channels and return a structured `JIT_AUTH_NOT_SUPPORTED` result for non-interactive channels without dispatching the outbound request.
12. **FR-12**: The system must compact large tool results using structured compression, truncation, or LLM-powered summarization strategies before they enter the conversation history.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                   |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | Tools are authored, stored, imported, and managed per project.                                          |
| Agent lifecycle            | PRIMARY      | Agent IR embeds tool definitions and runtime sessions execute them directly.                            |
| Customer experience        | SECONDARY    | Tool behavior affects end-user responses and side effects, but the surface is builder/runtime oriented. |
| Integrations / channels    | PRIMARY      | HTTP, MCP, sandbox, connector, SearchAI, workflow, and async-webhook execution all converge here.       |
| Observability / tracing    | PRIMARY      | Every execution is expected to emit trace/audit/log signals.                                            |
| Governance / controls      | PRIMARY      | Confirmation, RBAC, SSRF protection, OAuth, and resilience controls live here.                          |
| Enterprise / compliance    | SECONDARY    | Secret handling, auditability, and secure execution are important in enterprise deployments.            |
| Admin / operator workflows | SECONDARY    | Tool secret CRUD, rotation, and test execution matter operationally.                                    |

### Related Feature Integration Matrix

| Related Feature                                     | Relationship Type        | Why It Matters                                                                  | Key Touchpoints                                | Current State           |
| --------------------------------------------------- | ------------------------ | ------------------------------------------------------------------------------- | ---------------------------------------------- | ----------------------- |
| [MCP Support](mcp-support.md)                       | depends on               | MCP-backed tools execute through the shared dispatcher and provider path.       | `mcp_binding`, runtime MCP executor/provider   | Active integration      |
| [Webhook System](webhook-system.md)                 | shares execution surface | Async webhook tools and callback-style flows are adjacent execution primitives. | async webhook bindings, callback execution     | Partial/planned overlap |
| [Auth Profiles](auth-profiles.md)                   | configured by            | Tool auth can be injected by auth-profile middleware at runtime.                | auth-profile tool middleware, OAuth/preflight  | Active integration      |
| [Tracing & Observability](tracing-observability.md) | emits into               | Tool execution traces and audit events are key observability outputs.           | trace manager, audit logger                    | Active integration      |
| [Guardrails](guardrails.md)                         | extends                  | Pre/post tool guardrails can gate or modify tool execution.                     | tool-rails middleware, LLM eval guardrails     | Active integration      |
| [Memory & Sessions](memory-sessions.md)             | shares data with         | Tool memory bridge provides imperative memory API for sandbox tools.            | ToolMemoryBridge, session variable mapping     | Active integration      |
| [Connectors](connectors.md)                         | depends on               | Connector-bound tools route through connector tool executor.                    | ConnectorBindingIR, connector tool executor    | Active integration      |
| [Attachments](attachments.md)                       | extends                  | Attachment preprocessing feeds extracted text into downstream tool input.       | attachment tool executor, file upload pipeline | Active integration      |

---

## 6. Design Considerations

- Studio uses type-specific creation/test flows (HTTP, MCP, Sandbox wizards) rather than a single generic text-editor-only experience.
- Tool execution is intentionally channel-agnostic so the same runtime pipeline works for direct chat, SDK, voice, A2A, and MCP entry points.
- Security-sensitive behaviors such as confirmation, SSRF validation, and sandboxing are built into platform primitives rather than left to tool authors.
- The `DynamicToolInputForm` component generates parameter input forms directly from the tool's parameter schema, enabling live testing in Studio without manual form construction.
- Stale tool detection (`StaleToolBanner`, `useStaleToolCheck`) warns agent builders when referenced tools have changed since the last agent save.

---

## 7. Technical Considerations

- IR compilation and runtime dispatch are intentionally separated: project tools are compiled into agent IR, then executed through the runtime dispatcher. This avoids per-request DB lookups during execution.
- Middleware can mutate execution metadata immediately before dispatch, including auth-profile-backed HTTP auth injection. When an auth profile applies, its resolved credentials override inline HTTP auth.
- The `ToolBindingExecutor` creates namespace-scoped executors (HTTP, MCP, Sandbox) per-tool only when `variable_namespace_ids` are present, avoiding unnecessary executor proliferation.
- Several tool types share adjacent infrastructure but still have distinct executor implementations. Lambda and async webhook executors remain partial.
- The proxy resolver supports async initialization (`setProxyReadyPromise`) so that proxy config resolution does not block session startup.
- Coverage is broad (1,000+ test cases across 66+ test files), but some infrastructure-dependent modes still rely on mocked or in-suite fixtures instead of external backends.

---

## 8. How to Consume

### Studio UI

**Tools List Page** (`/projects/:projectId/tools`):

- Lists all project tools with type badges (HTTP, MCP, Sandbox, SearchAI)
- Filtering by tool type, text search on name/description
- Create new tool via `NewToolDropdown` with type-specific wizards

**Tool Detail Page** (`/projects/:projectId/tools/:toolId`):

- `ToolMetadataSection`: Name, description, type badge
- `ToolConfigurationSection` / `ToolConfigView`: DSL content editor, binding configuration
- `ToolTestingSection` / `TestToolDialog`: Live test execution with `DynamicToolInputForm` for parameter input
- `ToolTestPanel`: Displays test results including HTTP request/response inspection, sandbox metadata, MCP server info

**Tool Creation Wizards**:

- `HttpToolWizard`: Endpoint, method, auth config, headers, query params, body schema
- `McpToolWizard`: MCP server selection, tool name, transport type
- `SandboxToolWizard`: Runtime (JS/Python), inline code editor, memory/timeout limits

**Agent Editor Integration**:

- `ToolsEditor`: Bind tools to agents via `ToolPickerDialog` / `ToolPickerModal`
- `StaleToolBanner`: Warns when agent references tools that have been modified since last agent save

### API (Runtime)

| Method | Path                              | Purpose                                      |
| ------ | --------------------------------- | -------------------------------------------- |
| POST   | `/api/tool-secrets`               | Create encrypted tool secret                 |
| GET    | `/api/tool-secrets?projectId=...` | List tool secrets (metadata only, no values) |
| POST   | `/api/tool-secrets/:id/rotate`    | Rotate secret to new version                 |
| DELETE | `/api/tool-secrets/:id`           | Delete a tool secret                         |

### API (Studio)

| Method | Path                                        | Purpose                                                   |
| ------ | ------------------------------------------- | --------------------------------------------------------- |
| GET    | `/api/projects/:id/tools`                   | List project tools (paginated, filterable by type/search) |
| POST   | `/api/projects/:id/tools`                   | Create a project tool                                     |
| GET    | `/api/projects/:id/tools/:toolId`           | Get tool detail                                           |
| PUT    | `/api/projects/:id/tools/:toolId`           | Update a tool                                             |
| DELETE | `/api/projects/:id/tools/:toolId`           | Delete a tool                                             |
| POST   | `/api/projects/:id/tools/:toolId/duplicate` | Duplicate a tool                                          |
| POST   | `/api/projects/:id/tools/:toolId/test`      | Test tool execution with sample input                     |
| GET    | `/api/projects/:id/tools/:toolId/export`    | Export tool as JSON                                       |
| POST   | `/api/projects/:id/tools/import`            | Import tool from JSON                                     |

### Admin Portal

- Tool Secrets CRUD: full lifecycle management via `/api/tool-secrets` endpoints with RBAC (`credential:read`, `credential:write`, `credential:delete`)
- Secret rotation: version-tracked rotation with `rotatedAt` timestamp
- Expiry monitoring: secrets enriched with `expiryWarning` (`expired` or `expiring_soon`) in list responses
- Encryption availability check: returns 503 if encryption service is unavailable
- Audit logging: all secret operations (create, rotate, delete) produce audit log entries

### Channel / SDK / Voice / A2A / MCP Integration

Tools execute identically across all channels (digital, voice, A2A, SDK). The `ToolBindingExecutor` is channel-agnostic: it receives tool calls from the LLM conversation loop and dispatches them through the same executor pipeline regardless of channel. Session context (sessionId, tenantId, userId, callerContext) is propagated for audit trail correlation.

JIT authentication is channel-aware: interactive channels (WebSocket) can prompt for real-time consent, while non-interactive channels (REST, A2A) receive a structured `JIT_AUTH_NOT_SUPPORTED` result.

---

## 9. Data Model

### Collections / Tables

```
Collection: project_tools
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - name: string (required, 1-64 chars, lowercase snake_case, unique per project)
  - slug: string (required, immutable after creation, unique per project)
  - toolType: enum ['http', 'mcp', 'sandbox', 'searchai']
  - description: string | null (max 2048 chars)
  - dslContent: string (required, max 512KB, complete tool DSL)
  - sourceHash: string (SHA-256 hex, 64 chars)
  - variableNamespaceIds: string[] (linked variable namespaces for env var scoping)
  - createdBy: string
  - lastEditedBy: string | null
  - _v: number (optimistic concurrency)
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } (unique)
  - { tenantId: 1, projectId: 1, slug: 1 } (unique)
  - { tenantId: 1, projectId: 1, toolType: 1 }
  - { tenantId: 1, projectId: 1 } (compound for batch $in queries)
  - { name: 'text', description: 'text' } (full-text search)
Plugins:
  - tenantIsolationPlugin (ensures tenantId scoping on all queries)
Guards:
  - slug immutability enforced in pre-save and pre-findOneAndUpdate hooks
```

```
Collection: tool_secrets (managed by @agent-platform/shared/repos)
Fields:
  - _id: string
  - tenantId: string (required)
  - projectId: string (required)
  - toolName: string
  - secretKey: string
  - encryptedValue: string (AES-256-GCM encrypted)
  - environment: string (default: 'dev')
  - version: number (incremented on rotation)
  - expiresAt: Date | null
  - rotatedAt: Date | null
  - createdBy: string
  - createdAt: Date
  - updatedAt: Date
```

```
Collection: end_user_oauth_tokens (managed by ToolOAuthService)
Fields:
  - tenantId: string
  - userId: string
  - provider: string
  - encryptedAccessToken: string (AES-256-GCM, tenant-scoped key)
  - encryptedRefreshToken: string | null
  - scope: string
  - expiresAt: Date | null
```

### Key Relationships

- `project_tools.projectId` links to a project; tools are project-scoped
- `project_tools.variableNamespaceIds` links to `variable_namespaces` collection for env var scoping
- Agent IR references tools by `name`; tools are resolved from `project_tools` at compilation time via `loadProjectToolsAsIR()` or `resolveToolImplementations()`
- `tool_secrets` are resolved at runtime via `SecretsProvider` interface using `{{secrets.KEY}}` placeholders
- `end_user_oauth_tokens` are resolved per-user per-provider via `ToolOAuthService`

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                           | Purpose                                                                                                              |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/ir/schema.ts`                                  | `ToolDefinition`, `ToolParameter`, `HttpBindingIR`, `McpBindingIR`, `SandboxBindingIR`, `SearchAIBindingIR` IR types |
| `packages/compiler/src/platform/constructs/types.ts`                           | `ToolExecutor` interface, `LLMToolDefinition`, `LLMToolCall`, `LLMToolResult`, `ToolMemoryAPI`                       |
| `packages/compiler/src/platform/constructs/executors/tool-binding-executor.ts` | Central dispatcher: routes tool calls to type-specific executors based on `tool_type`                                |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`    | HTTP tool executor with SSRF protection, OAuth/Bearer/API-key auth, resilience                                       |
| `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts`     | MCP server tool executor with circuit breaker, retry, result normalization                                           |
| `packages/compiler/src/platform/constructs/executors/sandbox-tool-executor.ts` | Sandboxed code execution (JS/Python) with memory/timeout limits                                                      |
| `packages/compiler/src/platform/constructs/executors/tool-middleware.ts`       | Composable middleware chain (onion model) for cross-cutting concerns                                                 |
| `packages/compiler/src/platform/ir/tool-schema-validator.ts`                   | Compile-time validation of tool definitions                                                                          |
| `packages/shared-kernel/src/security/ssrf-validator.ts`                        | SSRF protection: IP validation, octal/decimal decode, metadata endpoint blocking                                     |

### Routes / Handlers

| File                                                                      | Purpose                                                                |
| ------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `apps/runtime/src/routes/tool-secrets.ts`                                 | Runtime CRUD for encrypted tool secrets (create, list, rotate, delete) |
| `apps/studio/src/app/api/projects/[id]/tools/route.ts`                    | Studio API: list + create project tools                                |
| `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts`           | Studio API: get, update, delete individual tool                        |
| `apps/studio/src/app/api/projects/[id]/tools/[toolId]/test/route.ts`      | Studio API: test tool execution                                        |
| `apps/studio/src/app/api/projects/[id]/tools/[toolId]/duplicate/route.ts` | Studio API: duplicate a tool                                           |
| `apps/studio/src/app/api/projects/[id]/tools/[toolId]/export/route.ts`    | Studio API: export tool as JSON                                        |
| `apps/studio/src/app/api/projects/[id]/tools/import/route.ts`             | Studio API: import tool from JSON                                      |

### UI Components

| File                                                                     | Purpose                                           |
| ------------------------------------------------------------------------ | ------------------------------------------------- |
| `apps/studio/src/components/tools/ToolsListPage.tsx`                     | Main tools listing page with filtering            |
| `apps/studio/src/components/tools/ToolDetailPage.tsx`                    | Tool detail/edit page                             |
| `apps/studio/src/components/tools/ToolCreatePage.tsx`                    | Tool creation page                                |
| `apps/studio/src/components/tools/ToolCreateDialog.tsx`                  | Tool creation dialog                              |
| `apps/studio/src/components/tools/ToolCard.tsx`                          | Tool card for list view                           |
| `apps/studio/src/components/tools/ToolTypeBadge.tsx`                     | Type badge component                              |
| `apps/studio/src/components/tools/ToolPreviewDialog.tsx`                 | Tool preview dialog                               |
| `apps/studio/src/components/tools/ToolTestPanel.tsx`                     | Test execution panel                              |
| `apps/studio/src/components/tools/TestToolDialog.tsx`                    | Test dialog wrapper                               |
| `apps/studio/src/components/tools/DynamicToolInputForm.tsx`              | Dynamic form generated from tool parameter schema |
| `apps/studio/src/components/tools/NewToolDropdown.tsx`                   | Type-selection dropdown for new tools             |
| `apps/studio/src/components/tools/wizard/HttpToolWizard.tsx`             | HTTP tool creation wizard                         |
| `apps/studio/src/components/tools/wizard/McpToolWizard.tsx`              | MCP tool creation wizard                          |
| `apps/studio/src/components/tools/wizard/SandboxToolWizard.tsx`          | Sandbox tool creation wizard                      |
| `apps/studio/src/components/tools/sections/ToolConfigView.tsx`           | Tool configuration display                        |
| `apps/studio/src/components/tools/sections/ToolConfigurationSection.tsx` | Tool configuration edit section                   |
| `apps/studio/src/components/tools/sections/ToolMetadataSection.tsx`      | Tool metadata section                             |
| `apps/studio/src/components/tools/sections/ToolTestingSection.tsx`       | Tool testing section                              |
| `apps/studio/src/components/agent-detail/ToolsSection.tsx`               | Agent detail: bound tools list                    |
| `apps/studio/src/components/agent-detail/StaleToolBanner.tsx`            | Warning banner for stale tool references          |
| `apps/studio/src/components/agent-editor/sections/ToolsEditor.tsx`       | Agent editor: tool binding editor                 |
| `apps/studio/src/components/abl/ToolPickerDialog.tsx`                    | Tool picker dialog for agent binding              |
| `apps/studio/src/components/abl/pickers/ToolPickerModal.tsx`             | Tool picker modal                                 |
| `apps/studio/src/store/tool-store.ts`                                    | Zustand store for tool state management           |
| `apps/studio/src/api/tools.ts`                                           | API client functions for tool CRUD                |
| `apps/studio/src/services/tool-test-service.ts`                          | Tool test execution service                       |
| `apps/studio/src/components/tools/tool-utils.ts`                         | Utility functions for tool operations             |
| `apps/studio/src/hooks/useStaleToolCheck.ts`                             | Hook to detect stale tool references in agents    |

### Jobs / Workers / Background Processes

| File                                                                     | Purpose                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| `apps/runtime/src/tools/load-project-tools-as-ir.ts`                     | Load tools from MongoDB and convert to IR format                                     |
| `apps/runtime/src/services/auth-profile/auth-profile-tool-middleware.ts` | Resolves auth profiles into per-request HTTP headers, query params, or TLS mutations |
| `apps/runtime/src/services/tool-oauth-service.ts`                        | OAuth 2.0 authorization code flow for end-user tool access                           |
| `apps/runtime/src/services/tool-audit-logger.ts`                         | Structured audit event logging for tool executions                                   |
| `apps/runtime/src/services/pipeline/tool-filter.ts`                      | LLM-based tool pre-selection per user message                                        |
| `apps/runtime/src/services/execution/tool-confirmation.ts`               | Immutable parameter snapshots for tool call confirmation                             |
| `apps/runtime/src/services/execution/llm-wiring.ts`                      | Wires `ToolBindingExecutor` with runtime middleware, including auth-profile handling |
| `apps/runtime/src/services/execution/tool-memory-bridge.ts`              | Imperative memory API for sandbox tools (get/set/delete_content)                     |
| `apps/runtime/src/services/execution/tool-result-compressor.ts`          | Compression/truncation/summarization of large tool results                           |
| `apps/runtime/src/services/resilience/tool-resilience-factory.ts`        | Circuit breaker and rate limiter factory backed by Redis                             |
| `apps/runtime/src/services/search-ai/search-ai-tool-executor.ts`         | SearchAI knowledge base tool executor                                                |
| `apps/runtime/src/services/search-ai/searchai-kb-tool-executor.ts`       | KB-specific tool executor for SearchAI-bound tools                                   |
| `apps/runtime/src/services/execution/transfer-tool-executor.ts`          | Agent handoff/transfer tool executor                                                 |
| `apps/runtime/src/tools/attachment-tool-executor.ts`                     | File attachment tool handling                                                        |

### Tests

| File                                                                       | Type        | Coverage Focus                                                |
| -------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------- |
| `packages/compiler/src/__tests__/constructs/http-tool-executor.test.ts`    | unit        | SSRF, auth, resilience, headers, proxy, timeout               |
| `packages/compiler/src/__tests__/constructs/tool-binding-executor.test.ts` | unit        | Dispatch routing, parallel execution, validation              |
| `packages/compiler/src/__tests__/constructs/middleware-chain.test.ts`      | unit        | Middleware order, trace dedupe, auth-profile mutation         |
| `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts`    | integration | Full tool lifecycle through construct execution               |
| `apps/runtime/src/__tests__/tool-confirmation.test.ts`                     | unit        | Snapshots, immutability, expiry, confirmation gate            |
| `apps/runtime/src/__tests__/tool-oauth-service.test.ts`                    | unit        | OAuth flow, token refresh, revocation                         |
| `apps/runtime/src/__tests__/tool-secrets-authz.test.ts`                    | unit        | Secret CRUD with RBAC, encryption, rotation                   |
| `apps/runtime/src/__tests__/llm-wiring.test.ts`                            | unit        | Runtime wiring, middleware registration, auth-profile         |
| `apps/studio/src/__tests__/e2e/tool-invocations-api.e2e.test.ts`           | e2e         | Full lifecycle: create, bind, execute, respond (19 scenarios) |
| `apps/studio/src/__tests__/tool-store.test.ts`                             | unit        | Zustand store operations                                      |
| `apps/studio/src/__tests__/tools-editor.test.tsx`                          | unit        | Agent tool binding UI                                         |
| `packages/shared/src/__tests__/project-tool-validator.test.ts`             | unit        | Tool validation rules                                         |

---

## 11. Configuration

### Environment Variables

| Variable                              | Default  | Description                                      |
| ------------------------------------- | -------- | ------------------------------------------------ |
| `TOOL_DEFAULT_TIMEOUT_MS`             | `30000`  | Default timeout for tool execution               |
| `TOOL_MAX_RESULT_SIZE`                | `512000` | Maximum tool result size in bytes                |
| `HTTP_TOOL_KEEPALIVE_MS`              | `30000`  | HTTP keep-alive timeout for tool connections     |
| `HTTP_TOOL_MAX_SOCKETS`               | `50`     | Maximum concurrent HTTP sockets per host         |
| `SANDBOX_BACKEND`                     | `gvisor` | Sandbox backend (`gvisor`, `lambda`)             |
| `ALLOW_SSRF_PRIVATE_RANGES`           | `false`  | Allow private IP ranges in HTTP tools (dev only) |
| `OAUTH_PROVIDER_<NAME>_CLIENT_ID`     | --       | OAuth provider client ID                         |
| `OAUTH_PROVIDER_<NAME>_CLIENT_SECRET` | --       | OAuth provider client secret                     |
| `OAUTH_PROVIDER_<NAME>_AUTHORIZE_URL` | --       | OAuth authorization endpoint                     |
| `OAUTH_PROVIDER_<NAME>_TOKEN_URL`     | --       | OAuth token endpoint                             |
| `OAUTH_PROVIDER_<NAME>_SCOPES`        | --       | Comma-separated OAuth scopes                     |
| `OAUTH_PROVIDER_<NAME>_REVOKE_URL`    | --       | OAuth revocation endpoint (optional)             |

### Runtime Configuration

- **Max parallel tools**: Configurable via `ConstructExecutionConfig.maxParallelTools` (default: 10)
- **Tool confirmation TTL**: 5 minutes (hardcoded in `tool-confirmation.ts`)
- **MCP result cap**: 100,000 characters (`MAX_MCP_RESULT_CHARS`)
- **Tool params size limit**: 512 KB (`MAX_TOOL_PARAMS_BYTES`)
- **Max tools per project**: 500 (enforced at creation time)
- **Circuit breaker threshold**: 3 failures before open, 30s reset
- **MCP retry**: 1 retry with exponential backoff for transient errors

### DSL / Agent IR / Schema

Tool definitions in the IR include:

```typescript
interface ToolDefinition {
  name: string;
  description: string;
  parameters: ToolParameter[];
  returns: ToolReturnType;
  hints: ToolHints; // cacheable, latency, parallelizable, side_effects, requires_auth, timeout
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
  context_access?: { read: string[]; write: string[] };
  variable_namespace_ids?: string[];
  auth_profile_ref?: string;
  jit_auth?: boolean;
  connection_mode?: 'per_user' | 'shared';
  consent_mode?: 'preflight' | 'inline';
  compaction?: ToolCompactionConfig;
}
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                     |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Tool CRUD and binding must remain project-scoped, and runtime execution should not resolve tools across project boundaries.   |
| Tenant isolation  | Secrets, auth-profile-backed dispatch, resilience controls, and execution traces must remain tenant-scoped.                   |
| User isolation    | Session/user context is propagated for audit and memory access, and tool-execution side effects should not leak across users. |

### Security & Compliance

- **SSRF protection**: All HTTP tool URLs validated against private IPs (RFC 1918, loopback, link-local, CGN), cloud metadata endpoints, octal/decimal IP encoding, userinfo bypass attacks. Only http/https schemes allowed.
- **Secret encryption**: AES-256-GCM with tenant-scoped keys; values never returned in API responses
- **Sandbox isolation**: Code runs in gvisor pods with memory limits (default 128MB) and timeouts; path traversal validation on code_content
- **Error sanitization**: Stack traces, file paths, and internal details stripped from tool errors before reaching the LLM
- **Tool params size limit**: 512KB maximum to prevent DoS
- **OAuth HTTPS enforcement**: OAuth token endpoints validated for HTTPS
- **Header injection prevention**: CRLF stripped from HTTP tool headers
- **RBAC**: Tool CRUD requires project-level permissions (`TOOL_READ`, `TOOL_WRITE`); secrets require `credential:*` permissions

### Performance & Scalability

- HTTP tools use keep-alive connections with configurable socket pool (`HTTP_TOOL_MAX_SOCKETS`)
- Parallel tool execution capped at configurable concurrency limit (default: 10)
- Tool results compressed before entering conversation history to reduce token usage
- Pipeline tool filter adds ~1-2s latency but reduces downstream LLM costs by limiting tool count
- Proxy resolver supports async initialization to avoid blocking session startup
- Circuit breakers are tenant-scoped via Redis (`HybridCircuitBreakerRegistry`), supporting multi-pod deployments
- Rate limiters use Redis-backed sliding window per tenant per tool
- Tool definitions cached in agent IR at compilation time: no per-request DB lookups during execution
- Namespace-scoped executors created per-tool only when `variable_namespace_ids` are present

### Reliability & Failure Modes

- Circuit breakers open after 3 consecutive failures, reset after 30s
- MCP executor retries once with exponential backoff for transient errors
- Tool confirmation snapshots expire after 5 minutes
- OAuth state store defaults to in-memory (single-pod only) unless Redis is configured
- Lambda tool type returns "not yet implemented" error
- All tool executor errors are caught, sanitized, and returned as structured `LLMToolResult` with `success: false`

### Observability

- Every tool execution produces a structured `tool.execution` log entry with: toolName, toolType, success, latencyMs, tenantId, sessionId, userId, timestamp
- Tool call traces logged via `TraceContextManager` with input/output/metadata
- Audit events persisted via the shared `AuditStore` (Kafka -> ClickHouse pipeline when enabled; otherwise ClickHouse > InMemory)
- Pipeline tool filter emits trace events with original/filtered tool counts and latency
- MCP result truncation logged as warnings

### Data Lifecycle

- Tool secrets support version-tracked rotation with `rotatedAt` timestamp
- Secrets can have `expiresAt` with `expiryWarning` enrichment in list responses
- OAuth tokens are encrypted at rest with tenant-scoped keys
- Tool definitions persist in `project_tools` with no automatic TTL (project-scoped lifecycle)
- Audit events follow the platform-wide AuditStore retention policy

---

## 13. Delivery Plan / Work Breakdown

1. Close remaining execution-surface gaps
   1.1 Add isolation-focused API E2E for cross-tenant and cross-project dispatch.
   1.2 Expand end-to-end coverage for secret rotation, config-backed auth swaps, and auth-profile precedence.
2. Improve external-backend confidence
   2.1 Add nightly integration coverage for real MCP and sandbox backends.
   2.2 Revisit OAuth flow coverage with a realistic provider harness.
3. Tighten runtime diagnostics
   3.1 Extend trace outputs with clearer auth-gate, retry, cancellation, and consent reason codes.
   3.2 Continue hardening tool-type validation for connector/workflow/searchai types in `ToolSchemaValidator`.
4. Complete partial tool types
   4.1 Evaluate lambda executor implementation priority.
   4.2 Finalize async webhook executor with workflow engine integration.

---

## 14. Success Metrics

| Metric                       | Baseline                                                                      | Target                                                                                      | How Measured                                           |
| ---------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| Tool execution confidence    | Broad unit/integration coverage with one focused API-surface E2E suite        | High-confidence coverage across happy path, isolation, and external-backend variants        | Test inventory and E2E pass set                        |
| Secure execution consistency | Shared controls already exist for SSRF, secrets, confirmation, and resilience | Every tool type continues to inherit shared security/runtime controls instead of diverging  | Runtime/platform design review and regression coverage |
| Builder/runtime coherence    | Tools can already be created, tested, and bound through Studio and runtime    | Tool authoring and execution remain aligned across new tool types and auth models           | Studio/runtime contract coverage and support outcomes  |
| Test coverage breadth        | 66+ test files, 1,000+ individual test cases                                  | 100% FR coverage in E2E + integration, zero critical gaps in isolation and security testing | Coverage matrix tracking                               |

---

## 15. Open Questions

1. When should planned or partial tool types such as async-webhook and lambda move from declared schema support to fully implemented executors?
2. How much external-backend coverage is required in CI versus nightly integration lanes for MCP, sandbox, and OAuth-backed tools?
3. Should isolation-specific E2E become mandatory for all tool execution surfaces before the feature can be considered fully mature?
4. Should the MCP result cap transition from character-based (100K chars) to token-based to better align with LLM context budgets?
5. Should OAuth state store be required to use Redis in production, or is the in-memory default acceptable for single-pod deployments?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                    | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | -------- | ------ |
| GAP-001 | Lambda tool type declared in IR schema but executor returns "not yet implemented"                                              | Low      | Open   |
| GAP-002 | Async webhook tools require workflow engine integration                                                                        | Medium   | Open   |
| GAP-003 | Tool schema validator only validates http/mcp/sandbox; missing connector/workflow/searchai                                     | Low      | Open   |
| GAP-004 | MCP result truncation is character-based, not token-based                                                                      | Low      | Open   |
| GAP-005 | OAuth state store defaults to in-memory (single-pod only) unless Redis is configured                                           | Medium   | Open   |
| GAP-006 | API-surface E2E now covers HTTP, MCP, sandbox, auth, and secure-tool flows, but isolation-focused runtime E2E is still missing | Medium   | Open   |
| GAP-007 | No API-level E2E coverage for cross-tenant/project isolation on tool execution                                                 | High     | Open   |
| GAP-008 | OAuth token refresh with real provider not tested                                                                              | Medium   | Open   |
| GAP-009 | Sandbox tool execution with real gvisor pod not tested in CI                                                                   | Medium   | Open   |
| GAP-010 | Variable namespace scoping and tool secret rotation not covered by API-level E2E                                               | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario               | Coverage Type | Status | Test File / Note                                                    |
| --- | ---------------------- | ------------- | ------ | ------------------------------------------------------------------- |
| 1   | HTTP tool execution    | unit + e2e    | PASS   | `http-tool-executor.test.ts`, `tool-invocations-api.e2e.test.ts`    |
| 2   | MCP tool execution     | unit + e2e    | PASS   | `mcp-tool-executor.test.ts`, `tool-invocations-api.e2e.test.ts`     |
| 3   | Sandbox tool execution | unit + e2e    | PASS   | `sandbox-tool-executor.test.ts`, `tool-invocations-api.e2e.test.ts` |
| 4   | Tool confirmation gate | unit + e2e    | PASS   | `tool-confirmation.test.ts`, `tool-invocations-api.e2e.test.ts`     |
| 5   | Auth profile injection | unit + e2e    | PASS   | `llm-wiring.test.ts`, `tool-invocations-api.e2e.test.ts`            |
| 6   | SSRF protection        | unit          | PASS   | `http-tool-executor.test.ts`, `ssrf-validator.test.ts`              |
| 7   | Tool secrets RBAC      | unit          | PASS   | `tool-secrets-authz.test.ts`                                        |
| 8   | OAuth flow             | unit          | PASS   | `tool-oauth-service.test.ts`                                        |
| 9   | Cross-tenant isolation | NOT TESTED    | GAP    | GAP-007                                                             |
| 10  | Tool result compaction | unit          | PASS   | `tool-result-compressor.test.ts`                                    |
| 11  | Pipeline tool filter   | unit          | PASS   | `pipeline-tool-filter.test.ts`                                      |
| 12  | A2A tool execution     | e2e           | PASS   | `tool-invocations-api.e2e.test.ts`                                  |

### Testing Notes

The feature has extensive unit and integration test coverage across 66+ test files and 1,000+ individual test cases spanning the compiler, runtime, shared packages, and Studio. A 19-scenario API-surface E2E suite exercises the full create-bind-execute-respond chain against a real runtime without touching Mongo directly.

Primary gaps: cross-tenant/project isolation E2E (GAP-007), external-backend coverage for MCP/sandbox/OAuth (GAP-008/009), and variable namespace scoping E2E (GAP-010).

> Full testing details: [docs/testing/tool-invocations.md](../testing/tool-invocations.md)

---

## 18. References

- Design docs: `docs/testing/sub-features/variable-namespaces-tool-auto-tagging.md` (variable namespace auto-tagging)
- Related features: [Tracing & Observability](tracing-observability.md), [Auth Profiles](auth-profiles.md), [Channels](channels.md), [Guardrails](guardrails.md), [Connectors](connectors.md)
- Security: `docs/plans/2026-03-11-runtime-security-hardening.md` (SSRF hardening plan)
- Database model: `packages/database/src/models/project-tool.model.ts`
- IR schema: `packages/compiler/src/platform/ir/schema.ts` (ToolDefinition at line 612)
- HLD: [docs/specs/tool-invocations.hld.md](../specs/tool-invocations.hld.md)
- LLD: [docs/plans/2026-03-22-tool-invocations-impl-plan.md](../plans/2026-03-22-tool-invocations-impl-plan.md)
