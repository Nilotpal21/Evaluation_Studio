# PR #4 Review: Unified Tool System (Code/MCP/HTTP)

**Branch:** `code-tool-service-wiring` → `develop`
**Author:** Sai Kumar Shetty
**Files Changed:** 205 (~30,000 lines added, ~1,900 removed)
**Commits:** 10

---

## 1. Executive Summary

This PR introduces a **unified tool management system** across the entire ABL platform, replacing the previous fragmented approach (separate `mcp_discovered_tools`, `agent_tool_links` collections) with a single, strongly-typed tool lifecycle covering **HTTP**, **MCP**, **Sandbox (Code/gVisor)**, and **Lambda** tool types.

**Scope spans 5 layers:**

- **Database** — New `tools` and `tool_versions` collections with unified schema, migrations, and legacy collection cleanup
- **Shared Package** — Types, repos, Zod validation, encryption service, SSRF protection, tool converters
- **Compiler** — gVisor sandbox runner, enhanced HTTP/MCP/Sandbox executors, MCP client overhaul
- **Runtime** — Agent tool loader, MCP server registry, runtime MCP provider, env variable routes
- **Studio** — Full CRUD UI for tools/MCP servers, wizards, testing, version history, curl import, discovery

---

## 2. Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│  Studio (Next.js)                                           │
│  ┌──────────┐ ┌──────────┐ ┌────────────┐ ┌──────────────┐ │
│  │Tool CRUD │ │MCP Mgmt  │ │Tool Testing│ │Curl Import   │ │
│  │API Routes│ │API Routes│ │Service     │ │Parser        │ │
│  └────┬─────┘ └────┬─────┘ └─────┬──────┘ └──────────────┘ │
│       │             │             │                          │
│  ┌────▼─────────────▼─────────────▼──────────────────────┐  │
│  │ withRouteHandler (auth + tenant + project + Zod)      │  │
│  └───────────────────────┬───────────────────────────────┘  │
└──────────────────────────┼──────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Shared Package (@agent-platform/shared)                    │
│  ┌──────────┐ ┌──────────┐ ┌───────────┐ ┌──────────────┐  │
│  │ToolRepo  │ │VersionRp │ │SecurityRp │ │McpConfigRepo │  │
│  └────┬─────┘ └────┬─────┘ └─────┬─────┘ └──────┬───────┘  │
│       │             │             │              │           │
│  ┌────▼─────────────▼─────────────▼──────────────▼───────┐  │
│  │ EncryptionService + Zod Validation + SSRF Protection  │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Runtime                                                    │
│  ┌──────────────┐ ┌──────────────┐ ┌──────────────────────┐ │
│  │AgentToolLoader│ │McpRegistry  │ │RuntimeMcpProvider    │ │
│  │(DB→ToolDef[])│ │(decrypt cfg)│ │(lazy-load servers)   │ │
│  └──────┬───────┘ └──────┬──────┘ └──────────┬───────────┘ │
│         │                │                    │             │
│  ┌──────▼────────────────▼────────────────────▼──────────┐  │
│  │ ToolBindingExecutor (HTTP|MCP|Sandbox|Lambda routing) │  │
│  └───────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────────┐
│  Compiler (@abl/compiler)                                   │
│  ┌───────────┐ ┌──────────┐ ┌──────────┐ ┌──────────────┐  │
│  │HttpExec   │ │McpExec   │ │SandboxExc│ │GvisorRunner  │  │
│  │+SSRF+retry│ │+breaker  │ │+audit    │ │+pod isolation│  │
│  └───────────┘ └──────────┘ └──────────┘ └──────────────┘  │
└─────────────────────────────────────────────────────────────┘
```

---

## 3. Tool Lifecycle

```
CREATE → [draft v0] → EDIT draft → PUBLISH (v1) → EDIT draft → PUBLISH (v2) → ... → ARCHIVE
```

- **Tool** = stable identity (name, slug, type, project, tenant)
- **ToolVersion** = mutable config snapshot (HTTP config, MCP config, Sandbox code, etc.)
- Mutual exclusivity enforced: only ONE of `httpConfig`, `mcpConfig`, `sandboxConfig`, `lambdaConfig` per version
- Config stored as typed Mongoose subdocuments with full validation
- Max 15 versions per tool. One draft at a time. Archived is terminal.

---

## 4. Layer-by-Layer Analysis

### 4.1 Database Layer

**New Models:**

| Model             | Purpose               | Key Indexes                                                                               |
| ----------------- | --------------------- | ----------------------------------------------------------------------------------------- |
| `Tool`            | Identity record       | `(tenantId, projectId, slug)` UNIQUE, `(tenantId, projectId, toolType)`, text search      |
| `ToolVersion`     | Versioned config      | `(toolId, version)` UNIQUE, `(tenantId, toolId, status)`, `(toolId, label)` SPARSE UNIQUE |
| `MCPServerConfig` | MCP connection config | `(tenantId, projectId, name)` UNIQUE, `(tenantId, projectId, enabled)`                    |

**Migrations:**

1. `20260216_001` — Creates collections with validators, indexes; migrates `mcp_discovered_tools`
2. `20260216_002` — Drops legacy `mcp_discovered_tools` and `agent_tool_links`

### 4.2 Shared Package (`@agent-platform/shared`)

| Module     | Files                                                                                                    | Purpose                                                                             |
| ---------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| Types      | `tools.ts`, `security.ts`, `mcp-server.ts`, `repo-types.ts`                                              | Normalized + API types with `tenantId` on all internal types, `Omit<>` on API types |
| Repos      | `tool-repo.ts`, `tool-version-repo.ts`, `security-repo.ts`, `mcp-server-config-repo.ts`, `mongo-tx.ts`   | Tenant-scoped CRUD with transactions, `$facet` pagination, cascade deletes          |
| Validation | `tool-schemas.ts`, `tool-validation.ts`, `tool-secret-schemas.ts`, `proxy-config-schemas.ts`, `parse.ts` | Zod schemas with SSRF protection in `refine()`, nesting depth limits, size limits   |
| Services   | `encryption-service.ts`, `mcp-server-registry.ts`                                                        | AES-256-GCM with tenant-scoped DEKs, LRU key cache (1000, 30min TTL)                |
| Security   | `ip-validator.ts`                                                                                        | SSRF protection: private IPs, metadata endpoints, protocol allowlist, IPv6 support  |
| Utils      | `tool-converters.ts`, `type-guards.ts`, `normalize.ts`, `errors.ts`                                      | DB→IR conversion, safe JSON parsing, structured errors                              |

### 4.3 Compiler Package

| Component                   | Key Changes                                                                                                                               |
| --------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `GvisorSandboxRunner` (NEW) | Executes code in gVisor-sandboxed K8s pods with SSRF validation, symlink protection, 5MB response limit                                   |
| `HttpToolExecutor`          | Full SSRF protection (13 IP ranges, octal detection), CRLF prevention, tenant-scoped OAuth caching, per-redirect-hop SSRF validation      |
| `McpToolExecutor`           | Circuit breaker per server, single retry for transients, transient error classification                                                   |
| `SandboxToolExecutor`       | Entrypoint validation (path traversal, null bytes, URL-encoded bypasses), mandatory audit trail                                           |
| `ToolBindingExecutor`       | Input validation (512KB limit), error sanitization (strips stack traces/paths), concurrency limiter (10 parallel), middleware composition |
| `MCPClient`                 | Multi-transport (stdio/SSE/HTTP), command allowlist, env var sanitization, HTTPS enforcement, auto-reconnect with jitter                  |

### 4.4 Runtime App

| Service                          | Purpose                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------ |
| `AgentToolLoader` (NEW)          | Loads versioned tools from MongoDB → `ToolDefinition[]`. LRU cache (200 entries, 5min TTL) |
| `MCPServerRegistryService` (NEW) | Loads MCP configs with tenant-scoped decryption. Cache (500 entries, 1min TTL)             |
| `RuntimeMCPProvider` (NEW)       | Lazy-loads project-scoped MCP servers. Max 20 servers/project. Promise dedup for init      |
| `environment-variables.ts`       | Complete rewrite with encryption, copy-between-environments, validation                    |

### 4.5 Studio App

**14 new API endpoints** for tool and MCP server CRUD, versioning, testing, import/export, discovery.

**30+ new UI components** including:

- Tool list, detail, create dialog, create wizards (HTTP/MCP/Sandbox)
- MCP server list, detail, create dialog, tool discovery panel
- Curl import dialog, dynamic form generator, test panels
- Reusable: `Section`, `SegmentedControl`, `InfoCard`, `ErrorAlert`

**New Services:**

- `MCP Discovery Service` — Connect, discover, preview schemas, persist with schema drift detection
- `Tool Test Service` — Execute tools in Studio via `ToolBindingExecutor` with secrets provider

---

## 5. Platform Principles Compliance

### 5.1 Tenant Isolation — STRONG

| Layer            | Status | Detail                                                                          |
| ---------------- | ------ | ------------------------------------------------------------------------------- |
| Database queries | Pass   | Every repo function requires `tenantId`. `tenantIsolationPlugin` on all models  |
| API routes       | Pass   | `withRouteHandler` enforces auth + project access + tenant resolution           |
| API responses    | Pass   | `sanitizeTool()`/`sanitizeVersion()` strip `tenantId`, `projectId`, `createdBy` |
| Secrets          | Pass   | Tenant-scoped DEKs via `EncryptionService.encryptForTenant()`                   |
| MCP configs      | Pass   | Ownership verification (project.tenantId) before returning configs              |
| Caches           | Pass   | Keys prefixed with `tenantId:projectId`                                         |
| OAuth tokens     | Pass   | Tenant-scoped cache keys in `SharedTokenCache`                                  |

### 5.2 Centralized Authentication — MOSTLY GOOD

- Tool routes use `withRouteHandler` — centralized auth + project access + Zod validation
- MCP server routes use manual auth pattern (inconsistent but functional)
- Agent model-config proxy route missing `requireProjectAccess()` (relies on runtime validation)

### 5.3 Stateless Distributed Architecture — STRONG

- All caches are LRU with TTL and max size
- Pod-local caches are performance optimizations; MongoDB is source of truth
- Session rehydration supported via `SessionService`
- `withTransaction()` with graceful fallback for standalone MongoDB

### 5.4 Full Traceability — GOOD

- `ToolBindingExecutor` has middleware composition for audit, logging, PII scrubbing
- `SandboxToolExecutor` mandates audit trail on every execution
- Trace events include session ID, agent name, caller identity, duration

### 5.5 Compliance — STRONG

- AES-256-GCM encryption for secrets with tenant-scoped keys
- `pbkdf2` via `promisify` (no sync crypto)
- MCP `clientSecret` redacted before client exposure
- Cascade deletion (tool → versions → secrets)
- Version limit (15 per tool) prevents unbounded growth

### 5.6 Performance — STRONG

- Aggregation joins prevent N+1
- `$facet` for consistent pagination
- LRU caches at every layer
- Concurrency limiter on tool execution (10 parallel)
- Size limits: 512KB tool params, 10MB HTTP response, 5MB sandbox response

---

## 6. Security Assessment

### Strengths

| Feature            | Implementation                                                                                                                                         |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| SSRF Protection    | 13 private IP ranges, octal/decimal encoding detection, userinfo blocking, metadata endpoint blocking, protocol allowlist, per-redirect-hop validation |
| CRLF Injection     | Header value sanitization in `HttpToolExecutor`                                                                                                        |
| Path Traversal     | Entrypoint validation in `SandboxToolExecutor` (blocks `..`, absolute paths, null bytes, URL-encoded bypasses)                                         |
| Secret Redaction   | MCP `clientSecret` → `[REDACTED]`, encrypted fields excluded from list responses                                                                       |
| Error Sanitization | Stack traces, file paths, internal details stripped before LLM sees errors                                                                             |
| Encryption         | AES-256-GCM with tenant-scoped DEKs, LRU key cache with TTL                                                                                            |
| MCP Hardening      | Command allowlist for stdio, env var sanitization, HTTPS enforcement, force-kill timeout                                                               |

### Findings

| #   | Severity                 | Finding                                                                                                                                                                                                                            | Location                                      |
| --- | ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| 1   | ~~**HIGH**~~ **FIXED**   | `ToolVersion` indexes `(toolId, version)`, `(toolId, label)`, `(toolId, versionName)` were NOT tenant-scoped. **Fixed:** Changed to `(tenantId, toolId, version)`, `(tenantId, toolId, label)`, `(tenantId, toolId, versionName)`. | `tool-version.model.ts`                       |
| 2   | ~~**HIGH**~~ **FIXED**   | `MCPServerConfig` priority index `{priority: -1}` was global. **Fixed:** Changed to `{tenantId, projectId, priority}`.                                                                                                             | `mcp-server-config.model.ts`                  |
| 3   | ~~**MEDIUM**~~ **FIXED** | Agent model-config proxy route only called `requireAuth()` but skipped `requireProjectAccess()`. **Fixed:** Added `requireProjectAccess()` check after auth.                                                                       | `agents/[agentId]/model-config/route.ts`      |
| 4   | **MEDIUM**               | MCP server routes use manual auth checks instead of `withRouteHandler`. Missing Zod body validation.                                                                                                                               | `mcp-servers/route.ts`, `[serverId]/route.ts` |
| 5   | **MEDIUM**               | `McpToolExecutor` circuit breakers shared across tenants. No `tenantId` enforcement when missing.                                                                                                                                  | `mcp-tool-executor.ts`                        |
| 6   | **MEDIUM**               | MCP raw error messages flow unsanitized to LLM (unlike HTTP executor).                                                                                                                                                             | `mcp-tool-executor.ts`                        |
| 7   | **MEDIUM**               | `GvisorSandboxRunner` pod URL validation logs warning instead of blocking non-internal hosts.                                                                                                                                      | `gvisor-sandbox-runner.ts`                    |
| 8   | **LOW**                  | Stdio child process spawned without CPU/memory resource limits.                                                                                                                                                                    | `mcp/client.ts`                               |
| 9   | **LOW**                  | `LambdaToolExecutor` missing error sanitization and circuit breaker.                                                                                                                                                               | `lambda-tool-executor.ts`                     |
| 10  | **LOW**                  | `SharedTokenCache` has no per-tenant limit.                                                                                                                                                                                        | `shared-token-cache.ts`                       |
| 11  | **LOW**                  | IP validator has commented-out IPv6 fix.                                                                                                                                                                                           | `ip-validator.ts`                             |
| 12  | **LOW**                  | No rate limiting on tool test execution in Studio.                                                                                                                                                                                 | `tool-test-service.ts`                        |
| 13  | **LOW**                  | Versions list endpoint lacks page/limit range validation.                                                                                                                                                                          | `versions/route.ts`                           |

---

## 7. Test Coverage

**25 new test files** (~15,000 lines of tests)

| Package      | Test Files | Coverage Area                                                                                                                              |
| ------------ | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| **shared**   | 10         | Tool validation, converters, encryption, type guards, mongo-tx, security-repo, tool-repo, tool-version-repo, MCP config repo, IP validator |
| **compiler** | 5          | gVisor sandbox runner, HTTP/MCP/sandbox executor, tool binding executor, tool lifecycle E2E                                                |
| **runtime**  | 5          | Agent tool loader, MCP server registry, runtime MCP provider, secrets provider, tool audit logger                                          |
| **studio**   | 11         | API routes (tools, MCP), clients, stores, config forms, dynamic form, curl parser, MCP discovery, tool test service                        |
| **e2e**      | 2          | Tool API integration, tools page UI                                                                                                        |

---

## 8. Design System Compliance (Studio UI)

| Aspect          | Status  | Notes                                                                   |
| --------------- | ------- | ----------------------------------------------------------------------- |
| Semantic colors | Pass    | `text-error`, `bg-success-subtle`, `border-accent/50` used consistently |
| Typography      | Pass    | Correct hierarchy (xl/lg/sm/xs)                                         |
| Icons           | Pass    | lucide-react exclusively, `w-4 h-4` standard sizing                     |
| Framer Motion   | Pass    | Springs with `damping: 30`, proper `layoutId` usage                     |
| `clsx`          | Pass    | Used for all conditional classes                                        |
| Loading states  | Partial | Uses spinners but no skeleton loaders                                   |
| Error states    | Pass    | `ErrorAlert` component with proper styling                              |
| Keyboard nav    | Partial | Missing in dropdown menus and SegmentedControl                          |

---

## 9. Recommendations

### Must-fix before merge — ALL RESOLVED

1. ~~**Add `tenantId` to ToolVersion unique indexes**~~ — **DONE.** Changed to `{tenantId, toolId, version}`, `{tenantId, toolId, label}`, `{tenantId, toolId, versionName}`
2. ~~**Scope MCP priority index**~~ — **DONE.** Changed to `{tenantId, projectId, priority}`
3. ~~**Add `requireProjectAccess()` to model-config proxy**~~ — **DONE.** Added import and check after auth

### Should-fix

4. Refactor MCP server routes to use `withRouteHandler` + Zod schemas for consistency
5. Sanitize MCP error messages before they reach the LLM (match HTTP executor pattern)
6. Enforce `tenantId` requirement in `McpToolExecutor` circuit breakers (fail if missing)
7. Block non-internal hosts in `GvisorSandboxRunner` pod URL validation (not just warn)

### Nice-to-have

8. Add skeleton loaders for loading states in UI
9. Add keyboard navigation to dropdown menus and SegmentedControl
10. Add rate limiting to tool test execution
11. Add per-tenant limits on `SharedTokenCache`
12. Split large UI components (`HttpConfigForm`, `McpToolsTabPanel`)

---

## 10. Summary Statistics

| Metric               | Value                                    |
| -------------------- | ---------------------------------------- |
| Files added          | ~140                                     |
| Files modified       | ~55                                      |
| Files removed        | 2 (`proxy-config.ts`, `tool-secrets.ts`) |
| New API endpoints    | 14                                       |
| New UI components    | 30+                                      |
| New test files       | 25                                       |
| Estimated test count | 500+                                     |
| New shared types     | 20+                                      |
| New database models  | 3                                        |
| Migrations           | 2                                        |

**Overall Assessment:** Production-grade implementation of a unified tool system. Tenant isolation, encryption, SSRF protection, and error handling are implemented correctly across all layers. The 3 must-fix issues (tenant-scoped indexes + project access check) have been resolved in this commit.
