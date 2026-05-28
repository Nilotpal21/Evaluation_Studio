# Feature: Variable Resolution Across Tool Types

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Environment Variables & Namespaces](../environment-variables.md)
**Status**: STABLE
**Feature Area(s)**: `agent lifecycle`, `integrations`, `governance`, `customer experience`
**Package(s)**: `packages/compiler`, `apps/runtime`, `apps/studio`, `packages/shared`, `packages/database`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/sub-features/variable-resolution.md](../../testing/sub-features/variable-resolution.md)
**Last Updated**: 2026-03-18

---

## 1. Introduction / Overview

### Problem Statement

Variable Resolution Across Tool Types is the execution-time feature that expands placeholders such as `{{env.KEY}}`, `{{secrets.KEY}}`, `{{input.foo}}`, `{{session.bar}}`, and `{{_context.baz}}` into concrete values before a tool call is dispatched. It spans Runtime executors, Studio's tool-test service, SSRF validation, and MCP server configuration.

### Goal Statement

The goal is consistency: the same logical variable should resolve in the same way whether it appears in an HTTP endpoint, request headers, query params, request body, MCP tool params, or an MCP server URL. The platform achieves that by centralizing DB-backed lookup in the secrets providers and then layering type-specific interpolation behavior on top.

### Summary

This feature is intentionally stricter than a simple string substitution pass. Resolution is namespace-scoped, SSRF protection resolves placeholders before deciding whether a URL is safe, Studio test execution intentionally does not auto-inject session/context variables unless the caller provides them, and Runtime has no `process.env` fallback for project variables.

### Key Capabilities

- HTTP tool resolution for endpoint URL, header keys/values, query params, and request body
- MCP tool parameter resolution for `{{secrets.*}}` and `{{env.*}}`
- MCP server URL resolution with project-env fallback
- Studio-side placeholder-aware SSRF validation before tool save/test
- Namespace-scoped DB-backed resolution for env vars and config vars
- Optional `{{input.*}}`, `{{session.*}}`, and `{{_context.*}}` handling during execution
- Session-scoped caching inside Runtime secrets resolution
- No silent `process.env` fallback for Runtime project variables

---

## 2. Scope

### Goals

- Provide consistent placeholder resolution across HTTP tools, MCP tools, MCP server URLs, and Studio tool-test execution.
- Keep resolution namespace-scoped and SSRF-safe so resolved values do not bypass runtime controls.
- Support execution-context placeholders such as `{{input.*}}`, `{{session.*}}`, and `{{_context.*}}` without making Studio test behavior misleading.

### Non-Goals (Out of Scope)

- A standalone public API for variable interpolation outside normal tool execution.
- Silent runtime fallback to arbitrary process environment variables for project-scoped data.
- Auto-injecting real runtime session/context into Studio tool tests when the caller does not provide them.

---

## 3. User Stories

1. As a tool author, I want placeholders to resolve the same way across HTTP and MCP tools so I can trust what will happen at runtime.
2. As a platform engineer, I want SSRF validation to evaluate the resolved destination instead of the raw template string.
3. As a tester, I want Studio tool-test behavior to mirror runtime resolution rules closely enough that placeholder bugs are caught before deployment.

---

## 4. Functional Requirements

1. **FR-1**: The system must resolve `{{env.*}}` and `{{secrets.*}}` placeholders across HTTP endpoints, headers, query params, body templates, MCP params, and MCP server URLs.
2. **FR-2**: The system must keep env/config resolution namespace-scoped based on the tool's linked namespace IDs.
3. **FR-3**: The system must validate placeholder-bearing URLs after substitution so SSRF checks run against the resolved target.
4. **FR-4**: The system must support `{{input.*}}`, `{{session.*}}`, and `{{_context.*}}` placeholders during execution without silently inventing session/context in Studio tests.
5. **FR-5**: The system must avoid runtime fallback to `process.env` for project-scoped variables.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                      |
| -------------------------- | ------------ | ------------------------------------------------------------------------------------------ |
| Project lifecycle          | SECONDARY    | Project variables and MCP configs are authored here, but the feature is execution-focused. |
| Agent lifecycle            | PRIMARY      | Placeholder resolution happens directly on the tool execution path.                        |
| Customer experience        | SECONDARY    | End users are affected indirectly through correct tool execution and fewer failures.       |
| Integrations / channels    | PRIMARY      | HTTP and MCP integrations rely on this behavior across all channels.                       |
| Observability / tracing    | SECONDARY    | Errors and warnings surface through normal tool-call and validation paths.                 |
| Governance / controls      | PRIMARY      | Namespace scope and SSRF validation are core control mechanisms here.                      |
| Enterprise / compliance    | SECONDARY    | Safe URL validation and no-env fallback reduce accidental leakage.                         |
| Admin / operator workflows | NONE         | There is no separate admin control surface for this capability.                            |

### Related Feature Integration Matrix

| Related Feature                                                                       | Relationship Type | Why It Matters                                                            | Key Touchpoints                              | Current State |
| ------------------------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- | -------------------------------------------- | ------------- |
| [Environment Variables & Namespaces](../environment-variables.md)                     | depends on        | Env/config lookup and namespace memberships come from the parent feature. | env vars, config vars, namespace memberships | Active        |
| [Variable Namespaces + Tool Auto-Tagging](./variable-namespaces-tool-auto-tagging.md) | depends on        | Tool namespace linkage determines what this resolver is allowed to see.   | `variableNamespaceIds`, runtime scope        | Active        |
| [Tool Invocations](../tool-invocations.md)                                            | shares data with  | Tool execution is where placeholder resolution actually runs.             | HTTP/MCP executors, tool traces              | Active        |
| [MCP Support](../mcp-support.md)                                                      | shares data with  | MCP server URLs and MCP params use the same placeholder and SSRF rules.   | server registry, MCP tool executor           | Active        |

---

## 6. Design Considerations (Optional)

The design intentionally favors consistent runtime semantics over convenience shortcuts. That is why Studio test execution does not magically invent session/context data and why URL validation happens after substitution instead of blindly trusting template-bearing strings.

---

## 7. Technical Considerations (Optional)

This sub-feature depends on DB-backed secrets providers, namespace membership data, HTTP SSRF validation utilities, and MCP server registry logic. Its stricter semantics also depend on the earlier removal of project-variable `process.env` fallback in runtime resolution.

---

## 8. How to Consume

### Studio UI

Users consume this feature mainly through tool authoring and testing:

- HTTP and MCP tool builders allow placeholder-bearing endpoints, headers, query params, body templates, and server URLs
- `ToolTestingSection` / `TestToolDialog` executes the tool through the Studio tool-test service, which mimics Runtime resolution using DB-backed env/config values
- The save path validates HTTP URLs only after placeholder substitution so SSRF checks see the resolved destination

### API (Runtime)

There is no standalone "variable resolution" endpoint. Resolution happens during tool execution on normal Runtime agent paths such as:

| Method | Path                                                    | Purpose                                        |
| ------ | ------------------------------------------------------- | ---------------------------------------------- |
| POST   | `/api/projects/:projectId/chat`                         | Agent execution that may invoke HTTP/MCP tools |
| POST   | `/api/projects/:projectId/sessions/:sessionId/messages` | Session-scoped tool execution path             |

### API (Studio)

| Method | Path                                   | Purpose                                                         |
| ------ | -------------------------------------- | --------------------------------------------------------------- |
| POST   | `/api/projects/:id/tools`              | Creates tools after placeholder-aware SSRF validation           |
| PUT    | `/api/projects/:id/tools/:toolId`      | Updates tools and re-validates placeholder-bearing content      |
| POST   | `/api/projects/:id/tools/:toolId/test` | Executes tool via Studio-side resolution logic                  |
| POST   | `/api/projects/:id/mcp-servers`        | Stores MCP server URLs and auth/env config for later resolution |

### Admin Portal

There is no admin-specific UI for this feature.

### Channel Integration

Resolution is channel-neutral. Once a tool is bound into agent execution, web, SDK, A2A, and voice requests all use the same resolution path.

---

## 9. Data Model

### Collections / Tables

```text
Collection: environment_variables
Relevant fields:
  - tenantId, projectId, environment, key, encryptedValue, isSecret
Purpose:
  - DB-backed source of `{{env.KEY}}` for Runtime and Studio test execution
```

```text
Collection: project_config_variables
Relevant fields:
  - tenantId, projectId, key, value
Purpose:
  - DB-backed source for namespace-scoped config lookups in Studio test execution
```

```text
Collection: variable_namespace_memberships
Relevant fields:
  - namespaceId, variableId, variableType
Purpose:
  - restricts which env/config variables a tool can resolve
```

```text
Collection: project_tools
Relevant fields:
  - dslContent
  - variableNamespaceIds
Purpose:
  - stores the placeholder-bearing tool definition plus namespace scope
```

```text
Collection: mcp_server_configs
Relevant fields:
  - url
  - encryptedEnv
  - encryptedAuthConfig
  - authProfileId
Purpose:
  - stores MCP server URLs and auth/env material that may contain placeholders
```

### Key Relationships

- `project_tools.variableNamespaceIds` -> namespace records used during Runtime/Studio resolution
- `variable_namespace_memberships` links env/config variables into those namespaces
- `mcp_server_configs` can reference env/auth material that is resolved before the MCP client connects

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                        | Purpose                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/runtime/src/services/secrets-provider.ts`                             | Runtime DB-backed env/config/secret resolution with namespace scope |
| `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts` | HTTP interpolation and SSRF-safe request building                   |
| `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts`  | MCP param placeholder resolution                                    |
| `packages/shared/src/services/mcp-server-registry.ts`                       | MCP server URL and auth/env resolution for server configs           |

### Routes / Handlers

| File                                                                 | Purpose                                            |
| -------------------------------------------------------------------- | -------------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/tools/route.ts`               | Create path with placeholder-aware SSRF validation |
| `apps/studio/src/app/api/projects/[id]/tools/[toolId]/route.ts`      | Update path with placeholder-aware re-validation   |
| `apps/studio/src/app/api/projects/[id]/tools/[toolId]/test/route.ts` | Studio test execution endpoint                     |
| `apps/studio/src/lib/resolve-and-validate-url.ts`                    | Resolves placeholders before SSRF validation       |
| `apps/studio/src/lib/route-handler.ts`                               | Ensures cross-tenant project access returns 404    |

### UI Components (Studio)

| File                                                         | Purpose                               |
| ------------------------------------------------------------ | ------------------------------------- |
| `apps/studio/src/components/tools/ToolTestingSection.tsx`    | Tool test surface                     |
| `apps/studio/src/components/tools/TestToolDialog.tsx`        | Test dialog wrapper                   |
| `apps/studio/src/components/tools/DynamicToolInputForm.tsx`  | Dynamic input form for test execution |
| `apps/studio/src/components/tools/wizard/HttpToolWizard.tsx` | HTTP placeholder authoring            |
| `apps/studio/src/components/tools/wizard/McpToolWizard.tsx`  | MCP server/tool authoring             |

### Tests

| File                                                        | Type      | Count                                           |
| ----------------------------------------------------------- | --------- | ----------------------------------------------- |
| `apps/studio/src/__tests__/tool-test-service.test.ts`       | unit      | Studio-side placeholder resolution coverage     |
| `apps/runtime/src/__tests__/secrets-provider.test.ts`       | unit      | Runtime env/config lookup behavior              |
| `packages/shared/src/__tests__/mcp-server-registry.test.ts` | unit      | MCP server URL resolution behavior              |
| `docs/testing/sub-features/variable-resolution.md`          | e2e guide | 4 live iterations across HTTP, MCP, and scoping |

---

## 11. Configuration

### Environment Variables

| Variable                          | Default    | Description                                   |
| --------------------------------- | ---------- | --------------------------------------------- |
| `HTTP_TOOL_MAX_RESPONSE_BYTES`    | `10485760` | Max HTTP response body size before truncation |
| `HTTP_TOOL_MAX_ERROR_BODY_LENGTH` | `256`      | Max error body length included in messages    |
| `HTTP_TOOL_MAX_RETRY_CAP`         | `10`       | Safety cap for HTTP retry counts              |
| `HTTP_TOOL_MAX_REDIRECT_HOPS`     | `5`        | Redirect-follow cap for HTTP tools            |
| `HTTP_TOOL_DEFAULT_TIMEOUT_MS`    | `30000`    | Default timeout for HTTP tool execution       |

### Runtime Configuration

- Runtime secrets resolution is DB-backed only; there is no project variable fallback to `process.env`
- Studio tool testing uses DB-backed env vars, DB-backed config vars, then process environment as a final local-development fallback
- `RuntimeSecretsProvider` keeps a session-scoped cache for resolved env vars and secrets
- MCP result text is capped at 100,000 characters

### DSL / Agent IR

Common patterns:

```text
endpoint: "https://api.example.com/{{env.VERSION}}/orders/{{input.orderId}}"
Authorization: "Bearer {{secrets.API_KEY}}"
X-Context: "{{_context.traceId}}"
X-Session: "{{session.userId}}"
```

At execution time, the HTTP executor resolves endpoint, header, query, and body placeholders. MCP param values resolve `{{env.*}}` and `{{secrets.*}}`, while server URLs are resolved by the MCP server registry.

---

## 12. Runtime Integration

### Lifecycle

1. Studio save/update paths resolve placeholders in candidate URLs before applying SSRF checks.
2. Runtime constructs a secrets provider with tenant, project, environment, and tool namespace scope.
3. HTTP execution resolves placeholders in endpoint, headers, query params, and body, then performs the outbound request.
4. MCP execution resolves placeholders inside param values before calling the server tool.
5. MCP server registry resolves placeholder-bearing server URLs before connection setup.
6. Studio tool-test execution follows the same resolution rules, but `{{session.*}}` and `{{_context.*}}` only work when explicitly provided in the test input.

### Dependencies

- `RuntimeSecretsProvider` and Studio test secrets provider
- Namespace membership data from env/config variable features
- HTTP SSRF validation utilities
- MCP server registry and MCP client/provider infrastructure

### Event Flow

- Resolution failures surface as missing values, SSRF validation errors, or executor warnings
- HTTP and MCP tool calls emit normal tool-call traces after interpolation succeeds
- Cross-tenant project access returns 404 through the Studio route-handler path before permission checks

---

## 13. Admin Integration

There is no dedicated admin management surface. Variable resolution is exercised through tool authoring, testing, and Runtime execution.

---

## 18. Gaps, Known Issues & Limitations

| ID      | Description                                                                            | Severity | Status |
| ------- | -------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Remote gVisor sandbox forwarding of env/secret globals is still partial                | Medium   | Open   |
| GAP-002 | Studio test execution does not auto-inject `session` or `_context` variables by design | Low      | Open   |
| GAP-003 | Browser-driven UI coverage for placeholder-heavy forms is still limited                | Medium   | Open   |

---

## 14. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                               |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Resolution must run with the current `projectId` and use only project-visible variable/config sources.                  |
| Tenant isolation  | Cross-tenant Studio project access must return 404 before exposing any tool or MCP metadata.                            |
| User isolation    | Studio test execution should use only the caller-provided context plus project-visible resources, not hidden user data. |

### Performance

Resolution is mostly string interpolation plus DB lookups, with session-scoped caching reducing repeated env/config fetches during long-running agent sessions.

### Security & Compliance

Resolved URLs are SSRF-checked after interpolation, not before. Runtime avoids project-variable `process.env` fallback to reduce accidental secret bleed. Namespace scoping ensures tools only see linked variables.

### Scalability

The feature scales with the underlying env/config stores and session caches. It is stateless at the executor layer beyond bounded in-memory caches.

### Observability

Errors appear through normal tool-execution error paths. Broader visibility comes from Tool Invocation tracing rather than a dedicated variable-resolution trace stream.

---

## 15. Delivery Plan / Work Breakdown

1. Close remaining runtime parity gaps.
   1.1 Finish the remote gVisor forwarding path for sandbox env/secret globals.
   1.2 Keep MCP server URL fallback behavior aligned with project env-var resolution rules.
2. Improve authoring confidence.
   2.1 Add browser-driven coverage for placeholder-heavy Studio forms.
   2.2 Keep cross-tenant 404 behavior covered whenever Studio route middleware changes.

---

## 16. Success Metrics

| Metric                                                 | Baseline               | Target   | How Measured                             |
| ------------------------------------------------------ | ---------------------- | -------- | ---------------------------------------- |
| HTTP and MCP placeholders resolve consistently         | Current implementation | Maintain | Live resolution guide plus unit coverage |
| SSRF validation evaluates resolved targets correctly   | Current implementation | Maintain | Create/update validation tests           |
| Runtime avoids project-variable `process.env` fallback | Current implementation | Maintain | Secrets-provider and live runtime checks |

---

## 17. Open Questions

1. Should Studio tool tests ever offer an explicit UX for injecting `_session` and `_context`, or should that stay power-user-only?
2. Does the sandbox path need a different contract for forwarding resolved env/secret globals than the in-process executors?
3. Should placeholder-heavy UI forms expose more explicit guidance for supported placeholder types?

---

## 19. Testing & Validation

### Coverage Checklist Summary

#### Integration

- [x] HTTP placeholder substitution covers endpoint, header, query, and body templates.
- [x] MCP URL resolution and grouped tool semantics are covered.
- [x] Secrets-provider and runtime cache behavior are covered.

#### E2E

- [x] HTTP placeholder resolution is live-verified.
- [x] MCP URL resolution and namespace scoping are live-verified.
- [x] Input/session/\_context placeholder behavior is live-verified.

### E2E Test Scenarios

| #   | Scenario                                               | Status     | Test File                                          |
| --- | ------------------------------------------------------ | ---------- | -------------------------------------------------- |
| 1   | HTTP endpoint/header/query/body placeholder resolution | PASS       | `docs/testing/sub-features/variable-resolution.md` |
| 2   | MCP param resolution and server URL fallback behavior  | PASS       | `docs/testing/sub-features/variable-resolution.md` |
| 3   | Namespace-scoped variable access                       | PASS       | `docs/testing/sub-features/variable-resolution.md` |
| 4   | Cross-tenant 404 behavior on Studio project routes     | PASS       | `docs/testing/sub-features/variable-resolution.md` |
| 5   | Browser-driven placeholder form behavior               | NOT TESTED | `docs/testing/sub-features/variable-resolution.md` |

### Integration Test Scenarios

| #   | Scenario                                     | Status | Test File                                                   |
| --- | -------------------------------------------- | ------ | ----------------------------------------------------------- |
| 1   | Runtime env/config lookup and cache behavior | PASS   | `apps/runtime/src/__tests__/secrets-provider.test.ts`       |
| 2   | Studio tool-test placeholder resolution      | PASS   | `apps/studio/src/__tests__/tool-test-service.test.ts`       |
| 3   | MCP server URL resolution                    | PASS   | `packages/shared/src/__tests__/mcp-server-registry.test.ts` |

### Unit Test Coverage

| Package           | Tests                                                      | Passing            |
| ----------------- | ---------------------------------------------------------- | ------------------ |
| `apps/runtime`    | `secrets-provider.test.ts` and related resolution coverage | Core flows passing |
| `apps/studio`     | `tool-test-service.test.ts`                                | Core flows passing |
| `packages/shared` | `mcp-server-registry.test.ts`                              | Core flows passing |

> Full testing details: [docs/testing/sub-features/variable-resolution.md](../../testing/sub-features/variable-resolution.md)

---

## 20. References

- Testing docs: [docs/testing/sub-features/variable-resolution.md](../../testing/sub-features/variable-resolution.md)
- Related features: [Tool Invocations](../tool-invocations.md), [Environment Variables & Namespaces](../environment-variables.md), [Variable Namespaces + Tool Auto-Tagging](./variable-namespaces-tool-auto-tagging.md)
- Runtime secrets provider: `apps/runtime/src/services/secrets-provider.ts`
- HTTP executor: `packages/compiler/src/platform/constructs/executors/http-tool-executor.ts`
