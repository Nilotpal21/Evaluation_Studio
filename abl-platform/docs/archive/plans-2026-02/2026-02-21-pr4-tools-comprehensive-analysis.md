# PR #4: "Implemented Tools → Code/MCP/HTTP" — Comprehensive Analysis

> Analysis date: 2026-02-21
> Branch: `develop` (after squash merge of `code-tool-service-wiring`)

---

## Part 1: New Features & Capabilities

### A. Tool Management System (Studio)

- **Full CRUD UI** for project-scoped tools — create, edit, version, archive, delete
- **Tool versioning lifecycle**: Draft → Versioned (immutable snapshots) → Archived (terminal)
- **Three tool types**: HTTP (REST APIs), MCP (Model Context Protocol servers), Code (sandbox/lambda)
- **Tool testing panel** — test any tool with custom parameters and see live results
- **Tool import from MCP servers** — browse MCP server tools, select, and import into project

### B. MCP Server Integration (Studio + Runtime)

- **MCP Server Registry** — register/manage MCP server connections per project with encrypted credentials
- **RuntimeMcpClientProvider** — project-scoped MCP client loading with 5-min TTL cache, 20 servers/project cap
- **MCPServerRegistryService** (runtime) — loads, decrypts, SSRF-validates MCP configs from DB with bounded LRU cache
- **MCP tool discovery** — connect to MCP server and browse available tools for import

### C. Tool Execution Pipeline (Runtime)

- **ToolBindingExecutor** — unified dispatcher routing by `tool_type` (http, mcp, sandbox, lambda) with composable middleware chain
- **HttpToolExecutor** — full HTTP tool execution with auth (API key, bearer, OAuth2 client/user, SAML, custom), retry, circuit breaker, rate limiting
- **McpToolExecutor** — MCP tool execution via stdio/SSE transports
- **SandboxToolExecutor** — isolated code execution (JS/Python) with memory/timeout limits
- **LambdaToolExecutor** — serverless function invocation
- **Tool resilience** — per-tool circuit breakers, retry with backoff, rate limiting

### D. Secrets Management (Runtime)

- **RuntimeSecretsProvider** — 5-layer secret resolution chain: session auth → cache → encrypted DB → agent IR → env vars
- **Tool Secrets CRUD API** — create, list, rotate, delete encrypted per-tool/per-environment credentials
- **AES-256-GCM encryption** with tenant-scoped Data Encryption Keys (DEKs)
- **Secret rotation** with version tracking and audit logging

### E. Proxy Support (Runtime)

- **ProxyResolver** — priority-ordered URL pattern matching with bypass patterns
- **Proxy auth types**: basic, bearer, API key
- **CA certificate + mTLS** support for corporate proxies
- **Per-environment proxy configs** with enable/disable toggle

### F. OAuth for Tool Execution (Runtime)

- **ToolOAuthService** — full OAuth2 authorization code flow
- **CSRF state parameter** protection
- **Token refresh** with automatic retry on 401
- **Encrypted token storage** per-tenant
- **Token revocation** endpoint
- **Client credentials flow** for service-to-service tools

### G. Database Models (Shared)

| Model                          | Purpose                                                              |
| ------------------------------ | -------------------------------------------------------------------- |
| `Tool`                         | Tool definitions with versioning, bindings, parameters, return types |
| `ToolVersion`                  | Immutable version snapshots                                          |
| `ToolSecret`                   | Encrypted per-tool credentials                                       |
| `MCPServerConfig`              | MCP server connection configs                                        |
| `OrgProxyConfig`               | Organization proxy configurations                                    |
| `OAuthProvider` / `OAuthToken` | OAuth credential storage                                             |

---

## Part 2: End-to-End Integration

```
Studio UI → Studio API → Runtime API → Tool Executors → External Services
```

| Layer                            | What happens                                                                                              |
| -------------------------------- | --------------------------------------------------------------------------------------------------------- |
| **Studio UI**                    | User creates/manages tools, MCP servers, secrets via dedicated pages                                      |
| **Studio API**                   | CRUD routes for tools, MCP configs, tool testing (proxied to runtime)                                     |
| **Runtime: Session Bootstrap**   | `_loadAndMergeDbTools()` merges DB tools with DSL-defined tools (fire-and-forget async)                   |
| **Runtime: ToolBindingExecutor** | Routes tool calls by type → HttpToolExecutor / McpToolExecutor / SandboxToolExecutor / LambdaToolExecutor |
| **Runtime: Secrets**             | RuntimeSecretsProvider resolves credentials through 5-layer chain                                         |
| **Runtime: Proxy**               | ProxyResolver applies proxy config to HTTP tool outbound requests                                         |
| **Runtime: OAuth**               | ToolOAuthService handles token acquisition/refresh for user-context tools                                 |
| **Runtime: Resilience**          | Circuit breakers + retry + rate limiting per tool                                                         |
| **External**                     | HTTP APIs, MCP servers, Lambda functions, sandboxed code                                                  |

---

## Part 3: Remaining Gaps — Categorized by Severity

### CRITICAL (Security / Data Integrity)

| #   | Category             | Gap                                                  | Details                                                                                                                                                                                                                                                           |
| --- | -------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | **Security**         | Tool test endpoint has no project-scope RBAC         | Studio tool test route uses generic `requireProject: true` — no `tool:test` permission check. Any project member can test any tool.                                                                                                                               |
| C2  | **Security**         | Studio tool/MCP routes lack granular RBAC            | All Studio API routes use `requireProjectAccess()` only. The `permissions` field in `withRouteHandler` is marked "Reserved for future RBAC wiring" — not implemented. No `tool:read`, `tool:write`, `tool:delete`, `mcp:create`, `mcp:delete` enforcement.        |
| C3  | **Security**         | Tool test responses may leak secrets                 | Tool test endpoint returns full tool execution response including headers/body. If a tool returns sensitive data in error messages or response headers, it's exposed to the tester.                                                                               |
| C4  | **Security**         | No rate limiting on tool test endpoint               | Tool test can trigger arbitrary outbound HTTP/MCP calls. No rate limit = potential for abuse (SSRF probing, external API spam).                                                                                                                                   |
| C5  | **Tenant Isolation** | CallerContext not fully propagated to tool executors | Tool executors receive only `{ sessionId, tenantId, userId }`. Full `CallerContext` (channel, identityTier, verificationMethod, sourceIp, contactId, etc.) is lost. Tools cannot make user-context-aware decisions and audit trails lack caller identity details. |

### HIGH (Architecture / Correctness)

| #   | Category           | Gap                                        | Details                                                                                                                                                                                                                                                                                          |
| --- | ------------------ | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| H1  | **Redundant Code** | Two duplicate MCP Server Registries        | `packages/shared/src/services/mcp-server-registry.ts` vs `apps/runtime/src/services/mcp/mcp-server-registry.ts`. Runtime version adds SSRF validation and project ownership verification that the shared version lacks. Shared version used by Studio is less secure.                            |
| H2  | **Redundant Code** | Three separate SSRF validators             | `packages/a2a/src/infrastructure/ssrf-interceptor.ts` (simple regex), `packages/shared/src/security/ip-validator.ts` (comprehensive), `packages/compiler/src/.../http-tool-executor.ts` (advanced with octal/decimal IP decoding). Different security guarantees depending on which one is used. |
| H3  | **Wiring Gap**     | DB tools loaded fire-and-forget            | `_loadAndMergeDbTools()` runs async after session creation. If the first user message arrives before DB tools finish loading, those tools won't be available. No await, no readiness signal.                                                                                                     |
| H4  | **Wiring Gap**     | Proxy support missing for MCP tools        | `ProxyResolver` is wired into `HttpToolExecutor` but not `McpToolExecutor`. In corporate environments requiring proxy for all outbound traffic, MCP tools will fail to connect.                                                                                                                  |
| H5  | **Wiring Gap**     | No Studio UI for OAuth provider management | OAuth2 flows are fully implemented in runtime (`ToolOAuthService`) but Studio has no UI to register OAuth providers, configure callback URLs, or manage user consent.                                                                                                                            |
| H6  | **Redundant Code** | 5+ locations defining ToolDefinition types | Tool definition types exist in compiler IR, runtime types, shared types, Studio types, and DB models. Changes to tool schema require updates in multiple places.                                                                                                                                 |

### MEDIUM (UX / Developer Experience)

| #   | Category      | Gap                                           | Details                                                                                                                                                                                                                                     |
| --- | ------------- | --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M1  | **UX**        | No confirmation dialog for version publishing | Publishing a tool version (making it immutable) has no "Are you sure?" confirmation. Accidental publishes can't be undone.                                                                                                                  |
| M2  | **UX**        | No pagination in tool/MCP lists               | Tool and MCP server lists render all items. With 50+ tools, the UI will degrade.                                                                                                                                                            |
| M3  | **UX**        | No tool health dashboard                      | No visibility into tool execution success rates, latency, error rates. Users can't see which tools are failing without checking traces.                                                                                                     |
| M4  | **UX**        | MCP tool testing only works after import      | Users must import an MCP tool into their project before they can test it. No "try before you import" capability.                                                                                                                            |
| M5  | **UX**        | Agent DSL editor uses inline tool definitions | Agents define tools inline in ABL source rather than referencing project-level tool definitions by ID. No linkage between "tools managed in UI" and "tools used by agents".                                                                 |
| M6  | **Confusing** | Inconsistent auth middleware patterns         | Four different authorization patterns coexist: `requirePermission` (org-level), `requirePermissionInline` (inline check), `requireProjectPermission` (project RBAC), `requireWriteAccess` (legacy). New developers won't know which to use. |
| M7  | **Confusing** | `security-repo.ts` still exists in runtime    | After consolidation to `@agent-platform/shared/repos`, the runtime `security-repo.ts` still exists with env-var-only functions. Should be deleted or clearly scoped.                                                                        |

### LOW (Polish / Future)

| #   | Category         | Gap                             | Details                                                                                                  |
| --- | ---------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------- |
| L1  | **UX**           | No tool dependency graph        | No visibility into which agents use which tools, or which tools depend on which secrets/OAuth providers. |
| L2  | **UX**           | No bulk tool operations         | Can't bulk archive, bulk delete, or bulk version tools.                                                  |
| L3  | **Architecture** | No tool execution cost tracking | No per-tool, per-tenant cost attribution for external API calls.                                         |
| L4  | **Architecture** | No tool response caching        | `cacheable` hint exists in tool bindings but no cache implementation in the execution pipeline.          |

---

## Part 4: Recommended Priority Order

### Immediate (before next release)

1. **C1+C2**: Wire granular RBAC into Studio tool/MCP routes
2. **C4**: Add rate limiting to tool test endpoint
3. **C5**: Propagate full CallerContext to tool executors
4. **H3**: Add readiness signal for DB tool loading (await or queue)

### Next sprint

5. **H1**: Consolidate MCP registries (move SSRF + project verification to shared)
6. **H2**: Consolidate SSRF validators into single shared utility
7. **H4**: Add proxy support for MCP tool connections
8. **C3**: Sanitize tool test responses (strip sensitive headers)

### Backlog

9. **H5**: Build Studio UI for OAuth provider management
10. **M1-M4**: UX improvements (confirmations, pagination, health dashboard)
11. **M6**: Document and consolidate auth middleware patterns
12. **H6**: Unify ToolDefinition types with single source of truth
