# DSL-Native Tool Architecture: Deep Analysis

**Date**: 2026-02-23
**Status**: Design Brainstorming
**Scope**: Per-tool-type feasibility, enterprise multi-tenant scaling, UI/UX for developers and non-developers
**Constraint**: No filesystem. Fully enterprise multi-tenant platform. No backward compatibility with `USE TOOL:`.

---

## 1. Problem Statement

The ABL platform currently maintains **two parallel systems** for tool definitions:

1. **DB entities**: 3 MongoDB collections (`tools`, `tool_versions`, `tool_secrets`), 13+ API routes, 30+ UI components (~7,800 lines), resolution pipeline
2. **DSL-native**: Inline tool definitions in agent DSL, `.tools.abl` files with `FROM...USE` imports, `{{env.X}}`/`{{secrets.X}}` runtime placeholders

These two systems overlap in capability, create a dual mental model, and make AI generation difficult (`USE TOOL: slug` is opaque to AI). This analysis evaluates whether the platform can consolidate to **DSL as the single source of truth**, stored in MongoDB, with a UI that serves both developers and non-developers.

---

## 2. Per-Tool-Type DSL Feasibility

### 2.1 HTTP Tools

#### What DB stores today (HttpToolConfig)

| Field                      | Type                                                 | DSL Equivalent                                    |
| -------------------------- | ---------------------------------------------------- | ------------------------------------------------- |
| `endpoint`                 | string                                               | `endpoint: "{{env.API_URL}}/search"`              |
| `method`                   | GET/POST/PUT/PATCH/DELETE                            | `method: POST`                                    |
| `authType`                 | none/api_key/bearer/oauth2_client/oauth2_user/custom | `auth: bearer`                                    |
| `authConfig`               | Record<string, string>                               | Not in DSL today                                  |
| `headers`                  | Record<string, string>                               | `headers:` block with `{{secrets.X}}`             |
| `retryCount`               | 0-10                                                 | `retry: 3`                                        |
| `retryDelayMs`             | 0-60000                                              | `retry_delay: 1000`                               |
| `rateLimitPerMinute`       | number                                               | `rate_limit: 100`                                 |
| `circuitBreaker.threshold` | number                                               | `circuit_breaker: {threshold: 5, resetMs: 30000}` |
| `circuitBreaker.resetMs`   | number                                               | (see above)                                       |

#### DSL already supports

The parser (`tool-file-parser.ts`) already handles all HTTP properties: `endpoint`, `method`, `auth`, `headers`, `timeout`, `retry`, `retry_delay`, `rate_limit`, `circuit_breaker`. The compiler (`compileHttpBinding()`) maps these to `HttpBindingIR`. The runtime executor (`HttpToolExecutor`) resolves `{{env.X}}` and `{{secrets.X}}` at execution time.

#### Gap: `authConfig` details

The DB stores structured auth config (e.g., OAuth2 `tokenUrl`, `clientId`, `scopes`). The DSL currently stores `auth: oauth2_client` but NOT the OAuth details. These details flow through `buildAuthConfig()` in `convertDbToolToIR()`.

**Solution — extend DSL auth block:**

```abl
TOOLS:
  charge_card(amount: number, currency: string) -> {transactionId: string}
    type: http
    endpoint: "{{env.PAYMENTS_URL}}/v1/charge"
    method: POST
    auth: oauth2_client
    auth_config:
      token_url: "{{env.OAUTH_TOKEN_URL}}"
      client_id: "{{env.OAUTH_CLIENT_ID}}"
      client_secret: "{{secrets.OAUTH_CLIENT_SECRET}}"
      scopes: "payments:write payments:read"
    headers:
      X-Idempotency-Key: "{{env.IDEMPOTENCY_PREFIX}}-{{input.amount}}"
    timeout: 10000
    retry: 2
    retry_delay: 1000
    rate_limit: 60
    circuit_breaker:
      threshold: 5
      reset_ms: 30000
```

**Parser change**: Add `auth_config:` block parsing (indented key-value pairs under `auth_config:`). Map to `HttpBindingAST.authConfig?: Record<string, string>`.

**Compiler change**: Pass `authConfig` through to `HttpBindingIR.auth.config`. The existing `buildAuthConfig()` logic in `convertDbToolToIR()` moves to the compiler.

**Verdict: HTTP tools are fully expressible in DSL.** One parser addition (`auth_config:` block) closes the gap. All secrets use `{{secrets.X}}` placeholders — never stored in DSL.

---

### 2.2 Sandbox (Code) Tools

#### What DB stores today (SandboxToolConfig)

| Field         | Type               | DSL Equivalent          |
| ------------- | ------------------ | ----------------------- |
| `runtime`     | javascript/python  | `runtime: "javascript"` |
| `codeContent` | string (max 256KB) | Not in DSL today        |
| `memoryMb`    | 128-4096           | `memory_mb: 256`        |

#### What DSL supports today

```abl
calculate_risk(data: object) -> {score: number, factors: string[]}
  type: sandbox
  runtime: "javascript"
  entrypoint: "calculateRisk"
  timeout: 5000
  memory_mb: 128
```

The DSL defines the interface (params, returns, type, runtime, entrypoint, limits) but **not the code**. The DB stores code in `sandboxConfig.codeContent`. At compile time, `convertDbToolToIR()` bakes `code_content` into the IR.

#### The code storage question

Sandbox code can be 1-100+ lines. Embedding it in DSL is feasible but creates readability challenges for large code blocks.

**Option A — Inline code block in DSL:**

```abl
calculate_risk(data: object) -> {score: number, factors: string[]}
  type: sandbox
  runtime: "javascript"
  entrypoint: "calculateRisk"
  memory_mb: 256
  code: |
    function calculateRisk(data) {
      const score = data.revenue * 0.3 + data.debt * 0.7;
      const factors = [];
      if (data.debt > 100000) factors.push('high_debt');
      if (data.revenue < 50000) factors.push('low_revenue');
      return { score, factors };
    }
```

**Option B — Separate code field on the tool entity:**

```typescript
interface IProjectTool {
  // ... other fields
  dslContent: string; // Tool interface + binding config
  codeBlobs?: Record<string, string>; // toolName → code content
}
```

DSL references:

```abl
calculate_risk(data: object) -> {score: number, factors: string[]}
  type: sandbox
  runtime: "javascript"
  entrypoint: "calculateRisk"
  memory_mb: 256
  code: @embedded  // signals: code stored in codeBlobs["calculate_risk"]
```

**Recommendation: Option A (inline code block)** for simplicity. The `|` YAML-style multiline block is a well-understood pattern. For very large code (rare), the Studio editor can show a split view (DSL on left, code editor on right). The parser already handles multiline strings in other contexts.

**Parser change**: Add `code:` property with `|` multiline block support. Store as `SandboxBindingAST.codeContent?: string`.

**Compiler change**: Map `ast.codeContent` to `SandboxBindingIR.code_content`. No DB lookup needed.

**Verdict: Sandbox tools are fully expressible in DSL.** Inline code block closes the gap. Memory limits, runtime, entrypoint — all already supported.

---

### 2.3 MCP Tools

#### What DB stores today

**McpToolConfig:**

| Field            | Type                              | DSL Equivalent                |
| ---------------- | --------------------------------- | ----------------------------- |
| `serverUrl`      | string (optional)                 | `server_url: "https://..."`   |
| `transportType`  | sse/http                          | `transport: sse`              |
| `serverToolName` | string                            | `tool: "get_current_weather"` |
| `headers`        | Array<{key, value}>               | `headers:` block              |
| `serverId`       | string (FK to mcp_server_configs) | Not in DSL                    |

**MCPServerConfig (23 fields):**

| Field                        | Purpose                                                      |
| ---------------------------- | ------------------------------------------------------------ |
| `name`                       | Human-readable name                                          |
| `transport`                  | sse/http                                                     |
| `url`                        | Server endpoint                                              |
| `authType`                   | none/bearer/api_key/custom_headers/oauth2_client_credentials |
| `encryptedAuthConfig`        | Encrypted auth details                                       |
| `encryptedEnv`               | Encrypted env variables                                      |
| `connectionTimeoutMs`        | Connection timeout                                           |
| `requestTimeoutMs`           | Request timeout                                              |
| `autoReconnect`              | Auto-reconnect flag                                          |
| `maxReconnectAttempts`       | Max reconnect attempts                                       |
| `priority`                   | Server priority                                              |
| `tags`                       | JSON array of tags                                           |
| Connection status fields (5) | Last connection status, latency, tool count, error           |

#### What DSL supports today

```abl
get_weather(location: string) -> {temp: number, conditions: string}
  type: mcp
  server: "weather-service"
  tool: "get_current_weather"
```

Minimal — just server name and tool name. The actual connection details (URL, auth, transport) come from the `mcp_server_configs` DB collection at runtime.

#### The MCP server config question

MCP servers are **shared infrastructure** — one server serves multiple tools, multiple agents, multiple projects. They have connection state (connected/failed/untested), encrypted credentials, and discovery capability. This is fundamentally different from HTTP or Sandbox tools where each tool is self-contained.

**Key insight: MCP servers are infrastructure, not tool definitions.** The server config (URL, auth, transport, connection settings) is analogous to a database connection string or an API gateway config. It belongs in infrastructure config, not in tool DSL.

**Approach: Keep `mcp_server_configs` collection, reference from DSL by name:**

```abl
TOOLS:
  # MCP tools reference a server by name — server config lives in infrastructure
  get_weather(location: string) -> {temp: number, conditions: string}
    type: mcp
    server: "weather-service"          # references mcp_server_configs.name
    tool: "get_current_weather"        # tool name on server
    description: "Get current weather for a location"

  search_docs(query: string, limit: number) -> {results: object[]}
    type: mcp
    server: "docs-search-server"
    tool: "search"
    description: "Search documentation index"
```

**At compile time**: Compiler resolves `server: "weather-service"` → looks up `mcp_server_configs` by `(tenantId, projectId, name)` → bakes `server_config` into IR (existing behavior).

**MCP discovery flow**: Discover tools from server → auto-generate DSL for each tool (with correct `server:` reference) → user adds to agent or creates a tool.

**Verdict: MCP tools work well in DSL.** The `mcp_server_configs` collection stays (it's infrastructure config, not tool definition). DSL references servers by name. Discovery auto-generates DSL snippets.

---

### 2.4 Per-Type Summary

| Dimension                          | HTTP                                    | Sandbox                                 | MCP                                             |
| ---------------------------------- | --------------------------------------- | --------------------------------------- | ----------------------------------------------- |
| **DSL can express full interface** | Yes                                     | Yes                                     | Yes                                             |
| **DSL can express full binding**   | Yes (with `auth_config:` addition)      | Yes (with `code:` block addition)       | Yes (server ref by name)                        |
| **Secrets handled**                | `{{secrets.X}}`, `{{env.X}}`            | N/A (no secrets in code)                | Server config encrypted in `mcp_server_configs` |
| **Parser changes needed**          | Add `auth_config:` block                | Add `code:` multiline block             | None (already supported)                        |
| **What stays in DB**               | `tool_secrets`, `environment_variables` | `tool_secrets`, `environment_variables` | `mcp_server_configs` (infrastructure)           |
| **What moves to DSL**              | All tool config                         | All tool config + code                  | Tool interface + server reference               |

---

## 3. Enterprise Multi-Tenant Architecture

### 3.1 Data Model

```
┌──────────────────────────────────────────────────────────┐
│  project_tools                                       │
│  ─────────────────                                        │
│  _id: UUIDv7                                              │
│  tenantId: string          ← tenant isolation             │
│  projectId: string         ← project scope                │
│  name: string              ← unique per (tenant, project) │
│  slug: string              ← URL-safe identifier          │
│  description: string | null                               │
│  dslContent: string        ← full .tools.abl DSL          │
│  sourceHash: string        ← SHA-256 of dslContent        │
│  toolCount: number         ← cached count of tools in DSL │
│  toolNames: string[]       ← cached list of tool names    │
│  source: 'manual' | 'discovered' | 'ai_generated'        │
│  createdBy: string                                        │
│  lastEditedBy: string | null                              │
│  createdAt: Date                                          │
│  updatedAt: Date                                          │
│                                                           │
│  Indexes:                                                 │
│    (tenantId, projectId, name) UNIQUE                     │
│    (tenantId, projectId, slug) UNIQUE                     │
│    (tenantId, toolNames) for cross-tool search            │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  mcp_server_configs (EXISTING — unchanged)                │
│  ──────────────────                                       │
│  Infrastructure config for MCP servers                    │
│  23 fields including encrypted auth + env                 │
│  Connection status tracking                               │
│  Scoped by (tenantId, projectId)                          │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  tool_secrets (EXISTING — unchanged)                      │
│  ────────────                                             │
│  Encrypted secret values for {{secrets.X}} resolution     │
│  Scoped by (tenantId, projectId)                          │
│  Audit trail plugin for SOC 2 compliance                  │
└──────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────┐
│  environment_variables (EXISTING — unchanged)             │
│  ─────────────────────                                    │
│  Per-environment values for {{env.X}} resolution          │
│  Scoped by (tenantId, projectId, environment)             │
└──────────────────────────────────────────────────────────┘
```

### 3.2 Tenant Isolation

Every query on `project_tools` includes `tenantId` at the query level — not post-hoc filtering:

```typescript
// CORRECT
ProjectTool.findOne({ _id: id, tenantId, projectId });

// NEVER
ProjectTool.findById(id); // then check tenantId
```

Cross-tenant access returns 404 (not 403) to prevent existence leakage.

### 3.3 Agent ↔ Tool Reference

Agents reference tools via `FROM...USE` with name-based resolution:

```abl
AGENT: PaymentProcessor

TOOLS:
  FROM "payments-api" USE: charge_card, refund, get_balance
  FROM "analytics-tools" USE: track_event

  # Inline tools (no tool reference)
  format_receipt(items: object[]) -> string
    description: "Format a receipt for display"
```

**Resolution at compile time:**

1. Parser extracts `FROM "payments-api" USE: charge_card, refund, get_balance`
2. Compiler resolves `"payments-api"` → query `project_tools.findOne({ name: "payments-api", tenantId, projectId })`
3. Parse the tool's `dslContent` → extract requested tools
4. Merge into agent's tool list
5. Compile to IR

**Resolution is deterministic**: same name + same DSL content = same IR. No version IDs, no slug resolution, no draft/published lifecycle.

### 3.4 What Gets Deleted — Full Inventory

#### 3.4.1 Studio UI Components (`apps/studio/src/components/tools/`)

**Deleted entirely: ~7,845 lines across 25+ files**

| File                           | Lines | Purpose                                           |
| ------------------------------ | ----: | ------------------------------------------------- |
| `SandboxConfigForm.tsx`        |   986 | Sandbox tool configuration form                   |
| `ToolDetailPage.tsx`           |   758 | Main tool detail/edit page                        |
| `HttpConfigForm.tsx`           |   730 | HTTP tool configuration form                      |
| `ToolsListPage.tsx`            |   481 | Tool listing with 3-tab layout (HTTP/Sandbox/MCP) |
| `TestToolDialog.tsx`           |   410 | Tool testing modal                                |
| `DynamicToolInputForm.tsx`     |   352 | Dynamic parameter input form                      |
| `ToolTestPanel.tsx`            |   329 | Tool test execution panel                         |
| `VersionPreviewDialog.tsx`     |   305 | Version diff preview                              |
| `ToolPreviewDialog.tsx`        |   261 | Tool preview modal                                |
| `VersionHistory.tsx`           |   255 | Version timeline                                  |
| `CurlImportDialog.tsx`         |   252 | Import tool from cURL command                     |
| `ToolCreateDialog.tsx`         |   226 | New tool creation dialog                          |
| `HttpToolWizard.tsx`           |   223 | HTTP tool creation wizard                         |
| `ToolCard.tsx`                 |   219 | Tool card in listings                             |
| `SandboxToolWizard.tsx`        |   194 | Sandbox tool creation wizard                      |
| `McpToolWizard.tsx`            |   186 | MCP tool creation wizard                          |
| `McpConfigForm.tsx`            |   176 | MCP server configuration form                     |
| `ToolCreatePage.tsx`           |   161 | Tool creation page                                |
| `ToolMetadataSection.tsx`      |   161 | Tool metadata panel                               |
| `TestResultCard.tsx`           |   148 | Test result display                               |
| `WizardLayout.tsx`             |   139 | Shared wizard layout                              |
| `ToolConfigurationSection.tsx` |   107 | Tool config section                               |
| `NewToolDropdown.tsx`          |    85 | New tool type picker                              |
| `LambdaConfigForm.tsx`         |    55 | Lambda tool configuration                         |
| `ToolTypeBadge.tsx`            |    54 | Tool type display badge                           |
| `ToolTestingSection.tsx`       |    52 | Testing section                                   |
| `VersionHistorySection.tsx`    |    42 | Version history section                           |

#### 3.4.2 Studio API Routes (`apps/studio/src/app/api/projects/[id]/tools/`)

**Deleted entirely: ~706 lines across 14 route files**

| File                                                     | Lines | Purpose                          |
| -------------------------------------------------------- | ----: | -------------------------------- |
| `[toolId]/route.ts`                                      |   123 | GET/PUT/DELETE single tool       |
| `import/route.ts`                                        |    82 | Import tool from external source |
| `[toolId]/versions/[vid]/route.ts`                       |    81 | GET/DELETE specific version      |
| `[toolId]/duplicate/route.ts`                            |    76 | Duplicate tool                   |
| `route.ts` (list)                                        |    71 | GET list, POST create            |
| `[toolId]/publish/route.ts`                              |    40 | Publish tool version             |
| `[toolId]/test/route.ts`                                 |    36 | Execute tool test                |
| `[toolId]/versions/[vid]/publish/route.ts`               |    36 | Publish specific version         |
| `mcp-servers/[serverId]/tools/discover/route.ts`         |    36 | MCP tool discovery               |
| `[toolId]/versions/route.ts`                             |    26 | List versions                    |
| `mcp-servers/[serverId]/tools/discover/preview/route.ts` |    25 | Discovery preview                |
| `[toolId]/export/route.ts`                               |    24 | Export tool                      |
| `mcp-servers/[serverId]/tools/route.ts`                  |    21 | List MCP server tools            |
| `mcp-servers/[serverId]/tools/[toolName]/test/route.ts`  |    29 | Test MCP tool                    |

#### 3.4.3 Studio Stores, Services & Hooks

**Deleted or heavily simplified: ~843 lines**

| File                            | Lines | Action                                        |
| ------------------------------- | ----: | --------------------------------------------- |
| `services/tool-test-service.ts` |   345 | **Deleted** — replaced by DSL-based test      |
| `api/tools.ts`                  |   197 | **Deleted** — API client for old routes       |
| `store/tool-store.ts`           |   186 | **Deleted** — Zustand store for tool entities |
| `hooks/useStaleToolCheck.ts`    |   113 | **Deleted** — stale reference detection       |

#### 3.4.4 Agent/ABL Integration (modified, not fully deleted)

**Modified: ~1,656 lines across 5 files**

| File                                          | Lines | Action                                                       |
| --------------------------------------------- | ----: | ------------------------------------------------------------ |
| `components/agent-detail/ToolsSection.tsx`    |   784 | **Rewritten** — `FROM...USE` linking instead of DB linking   |
| `components/agents/AgentDetailPage.tsx`       |   733 | **Modified** — remove `USE TOOL:` parsing, add `FROM...USE`  |
| `lib/abl-serializers.ts`                      |   453 | **Modified** — serialize `FROM...USE` instead of `USE TOOL:` |
| `components/abl/ToolPickerDialog.tsx`         |   139 | **Modified** — insert `FROM...USE` snippets                  |
| `components/agent-detail/StaleToolBanner.tsx` |   115 | **Deleted** — no stale references in new model               |

#### 3.4.5 Shared Package — Tool Resolution & Conversion (`packages/shared/src/`)

**Deleted entirely: ~3,249 lines**

| File                                | Lines | Action                                                |
| ----------------------------------- | ----: | ----------------------------------------------------- |
| `repos/tool-version-repo.ts`        |   810 | **Deleted** — no tool versions                        |
| `repos/tool-repo.ts`                |   502 | **Deleted** — replaced by simple `project_tools` CRUD |
| `tools/convert-db-tool-to-ir.ts`    |   375 | **Deleted** — DSL compiles directly to IR             |
| `tools/resolve-tool-links.ts`       |   268 | **Deleted** — no `USE TOOL:` resolution               |
| `tools/load-project-tools-as-ir.ts` |   226 | **Deleted** — no standalone tool→IR loading           |
| `validation/tool-schemas.ts`        |   218 | **Deleted** — Zod schemas for DB tool entities        |
| `validation/tool-validation.ts`     |   207 | **Deleted** — validation for DB tool entities         |
| `validation/tool-secret-schemas.ts` |    81 | **Kept** — secrets remain                             |
| `types/tools.ts`                    |    75 | **Deleted** — DB tool types                           |
| `tools/index.ts`                    |    18 | **Deleted** — barrel exports                          |

#### 3.4.6 Database Models & Migrations (`packages/database/src/`)

**Deleted: ~1,675 lines**

| File                                                              | Lines | Action                               |
| ----------------------------------------------------------------- | ----: | ------------------------------------ |
| `migrations/scripts/20260211_000_initial_schema_validation.ts`    |   556 | **Deleted** — old tool schema        |
| `migrations/scripts/20260216_001_unified_tool_schema.ts`          |   272 | **Deleted** — tool schema migration  |
| `models/tool-version.model.ts`                                    |   228 | **Deleted** — tool version model     |
| `models/tool.model.ts`                                            |   115 | **Deleted** — tool model             |
| `__tests__/tool-slug-immutability.test.ts`                        |   146 | **Deleted** — slug immutability test |
| `models/tool-secret.model.ts`                                     |    70 | **Kept** — secrets remain            |
| `migrations/scripts/20260216_002_drop_legacy_tool_collections.ts` |    58 | **Deleted** — already dropped        |

#### 3.4.7 Parser/Core (`packages/core/src/`)

**Modified: ~1,189 lines**

| File                             |   Lines | Action                                                           |
| -------------------------------- | ------: | ---------------------------------------------------------------- |
| `parser/tool-file-parser.ts`     |     426 | **Kept** — parses `.tools.abl` / `project_tools.dslContent`      |
| `parser/tool-import-resolver.ts` |     110 | **Modified** — resolve `FROM` against `project_tools` collection |
| `parser/tool-parser-utils.ts`    |     101 | **Kept** — shared parser utilities                               |
| `types/tool-file.ts`             |      30 | **Kept** — tool file types                                       |
| `types/agent-based.ts`           | partial | **Modified** — remove `ToolLink`, keep `AgentTool`               |

#### 3.4.8 Compiler Tool Executors (`packages/compiler/src/`)

**Kept — these are runtime execution, not DB resolution: ~2,363 lines**

| File                                                     | Lines | Action                                    |
| -------------------------------------------------------- | ----: | ----------------------------------------- |
| `platform/constructs/executors/http-tool-executor.ts`    |   897 | **Kept** — HTTP tool runtime execution    |
| `platform/constructs/executors/tool-binding-executor.ts` |   616 | **Kept** — unified tool dispatch          |
| `platform/constructs/executors/mcp-tool-executor.ts`     |   334 | **Kept** — MCP tool runtime execution     |
| `platform/ir/tool-schema-validator.ts`                   |   250 | **Kept** — IR-level schema validation     |
| `platform/constructs/executors/sandbox-tool-executor.ts` |   193 | **Kept** — sandbox tool runtime execution |
| `platform/constructs/executors/tool-middleware.ts`       |    42 | **Kept** — tool middleware chain          |
| `platform/constructs/executors/lambda-tool-executor.ts`  |    31 | **Kept** — lambda tool runtime execution  |

#### 3.4.9 Runtime Services (`apps/runtime/src/`)

**Mostly kept — runtime execution is independent of DB tool model: ~5,971 lines**

| File                                           |  Lines | Action                                                       |
| ---------------------------------------------- | -----: | ------------------------------------------------------------ |
| `services/adapters/tool-executor-adapter.ts`   |  1,077 | **Kept** — executes IR-compiled tools                        |
| `services/version-service.ts`                  |    762 | **Modified** — remove tool versioning, keep agent versioning |
| `routes/tool-secrets.ts`                       |    474 | **Kept** — secret management routes                          |
| `services/tool-oauth-service.ts`               |    449 | **Kept** — OAuth flow for HTTP tools                         |
| `services/search-ai/search-ai-tool-handler.ts` |    244 | **Kept** — SearchAI integration                              |
| Other executors & services                     | ~2,965 | **Kept** — runtime execution layer                           |

#### 3.4.10 Tests

**Deleted or rewritten: ~16,712 lines across 35+ test files**

| Category                       | Files | Lines | Action                                                                                |
| ------------------------------ | ----: | ----: | ------------------------------------------------------------------------------------- |
| Studio API/store/service tests |     8 | 3,377 | **Deleted** — old API/store tests                                                     |
| Shared repo/resolution tests   |     6 | 4,382 | **Deleted** — tool-repo, tool-version-repo, resolve-tool-links, convert-db-tool-to-ir |
| Compiler tool executor tests   |    10 | 3,515 | **Kept** — runtime execution tests                                                    |
| Runtime tool tests             |     6 | 2,631 | **Mostly kept** — runtime execution                                                   |
| Core parser tests              |     4 |   531 | **Modified** — update for new syntax                                                  |
| Database tests                 |     1 |   146 | **Deleted** — slug immutability                                                       |

#### 3.4.11 Summary

```
┌─────────────────────────────────────────────────────────────────┐
│               DELETION / MODIFICATION SUMMARY                    │
├─────────────────────────┬──────────┬──────────┬────────────────┤
│ Category                │ Lines    │ Action   │ Source Lines   │
├─────────────────────────┼──────────┼──────────┼────────────────┤
│ Studio UI Components    │   7,845  │ DELETE   │                │
│ Studio API Routes       │     706  │ DELETE   │                │
│ Studio Stores/Services  │     843  │ DELETE   │                │
│ Shared Tool Resolution  │   3,249  │ DELETE   │                │
│ Database Models/Migr.   │   1,675  │ DELETE   │                │
│ Tests (deleted portion) │   8,436  │ DELETE   │                │
├─────────────────────────┼──────────┼──────────┼────────────────┤
│ TOTAL DELETED           │  22,754  │          │                │
├─────────────────────────┼──────────┼──────────┼────────────────┤
│ Agent/ABL Integration   │   1,656  │ MODIFY   │                │
│ Parser/Core             │   1,189  │ MODIFY   │                │
│ Runtime Services        │     762  │ MODIFY   │                │
│ Tests (modified portion)│   2,000  │ MODIFY   │                │
├─────────────────────────┼──────────┼──────────┼────────────────┤
│ TOTAL MODIFIED          │   5,607  │          │                │
├─────────────────────────┼──────────┼──────────┼────────────────┤
│ Compiler Executors      │   2,363  │ KEEP     │                │
│ Runtime Executors       │   5,209  │ KEEP     │                │
│ Tests (kept portion)    │   6,276  │ KEEP     │                │
├─────────────────────────┼──────────┼──────────┼────────────────┤
│ TOTAL KEPT              │  13,848  │          │                │
├─────────────────────────┼──────────┼──────────┼────────────────┤
│ NEW CODE (estimated)    │  ~2,500  │ ADD      │                │
│  - project_tools CRUD   │    ~300  │          │                │
│  - Tool editor UI       │  ~1,200  │          │                │
│  - FROM...USE resolver  │    ~200  │          │                │
│  - MCP discovery→DSL    │    ~300  │          │                │
│  - Test from DSL panel  │    ~300  │          │                │
│  - New tests            │    ~200  │          │                │
├─────────────────────────┼──────────┼──────────┼────────────────┤
│ NET REMOVAL             │ ~20,254  │          │                │
└─────────────────────────┴──────────┴──────────┴────────────────┘
```

**Key insight**: The previous estimate of ~7,300 net lines removed was significantly understated. With actual file-by-file inventory, the true net removal is **~20,000 lines** — nearly 3x the original estimate. The bulk of the deletion is in Studio UI components (7,845), shared resolution pipeline (3,249), and tests for deleted code (8,436).

---

## 4. UI/UX Design: Serving Both Developers and Non-Developers

### 4.1 Design Philosophy

The key insight: **DSL is the source of truth, but the UI doesn't have to show raw DSL to everyone.** The Studio can present different views of the same underlying data:

- **Developer view**: DSL editor with syntax highlighting, autocomplete, inline errors
- **Non-developer view**: Form-based interface that reads from and writes to DSL

Both views operate on the same `dslContent` field. The form view is a **projection** of the DSL, not a separate data model.

### 4.2 Tool List Page

Replace the current 3-tab ToolsListPage (HTTP | Sandbox | MCP Servers) with a unified tool list:

```
┌─────────────────────────────────────────────────────────┐
│  Tools                                         [+ New]   │
│                                                          │
│  ┌─ Search ─────────────────────┐  ┌─ Filter ────────┐  │
│  │ 🔍 Search tools...           │  │ All Types  ▼    │  │
│  └──────────────────────────────┘  └─────────────────┘  │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 📦 payments-api                    3 tools        │   │
│  │ HTTP tools for payment processing                 │   │
│  │ charge_card · refund · get_balance                │   │
│  │ Updated 2h ago by sai@company.com                 │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 🔌 weather-mcp-tools              5 tools        │   │
│  │ MCP tools from weather-service                    │   │
│  │ get_weather · forecast · alerts · uv_index · ...  │   │
│  │ Discovered · Updated 1d ago                       │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  ┌──────────────────────────────────────────────────┐   │
│  │ ⚙️ risk-models                     2 tools        │   │
│  │ Sandbox scoring models                            │   │
│  │ calculate_risk · analyze_sentiment                │   │
│  │ Updated 3d ago by dev@company.com                 │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  MCP Servers ─────────────────────────────── [+ Add]    │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 🟢 weather-service    sse    5 tools   12ms       │   │
│  │ 🔴 docs-search        http   0 tools   failed     │   │
│  │ ⚪ analytics-server   http   — tools   untested   │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Key UX decisions:**

- Tools are the primary unit, not individual tools
- MCP Servers section stays separate (infrastructure config)
- Tool names shown as chips for quick scanning
- Source indicator: manual / discovered / AI-generated
- "[+ New]" opens creation flow (see 4.3)

### 4.3 Tool Creation

**Three entry points:**

**A. From scratch (developer or non-developer):**

```
┌─────────────────────────────────────────────────────────┐
│  Create Tool                                        │
│                                                          │
│  Name: [payments-api                    ]                │
│  Description: [Payment processing tools  ]               │
│                                                          │
│  How do you want to create tools?                        │
│                                                          │
│  ┌────────────────┐  ┌────────────────┐                  │
│  │  📝 Form        │  │  </> DSL       │                  │
│  │  Step-by-step   │  │  Write DSL     │                  │
│  │  guided setup   │  │  directly      │                  │
│  └────────────────┘  └────────────────┘                  │
│                                                          │
│  ┌────────────────┐  ┌────────────────┐                  │
│  │  🔌 Discover    │  │  🤖 AI Generate│                  │
│  │  From MCP       │  │  Describe what │                  │
│  │  server         │  │  you need      │                  │
│  └────────────────┘  └────────────────┘                  │
└─────────────────────────────────────────────────────────┘
```

**B. From MCP discovery:**
Discover server → select tools → auto-generate tool DSL → save as `project_tools` entry.

**C. From AI generation:**
User describes what they need → AI generates complete tool DSL → user reviews and saves.

### 4.4 Tool Editor — Dual-Mode Interface

This is the core of the UX. The editor has two synchronized modes that operate on the same `dslContent`:

```
┌─────────────────────────────────────────────────────────┐
│  payments-api                    [Form] [DSL] [Test]     │
│  Payment processing tools                    [Save]      │
│─────────────────────────────────────────────────────────│
│                                                          │
│  ┌── Form Mode ─────────────────────────────────────┐   │
│  │                                                    │   │
│  │  Shared Defaults                          [▼]     │   │
│  │  ┌────────────────────────────────────────────┐   │   │
│  │  │ Base URL: [{{env.PAYMENTS_URL}}           ]│   │   │
│  │  │ Auth:     [Bearer                       ▼] │   │   │
│  │  │ Timeout:  [10000] ms                       │   │   │
│  │  │ Retry:    [2]                              │   │   │
│  │  └────────────────────────────────────────────┘   │   │
│  │                                                    │   │
│  │  Tools ──────────────────────────────── [+ Add]   │   │
│  │                                                    │   │
│  │  ┌─ charge_card ─────────────────── HTTP ──┐      │   │
│  │  │ Description: [Charge a payment card     ]│      │   │
│  │  │ Endpoint:    [/v1/charge                ]│      │   │
│  │  │ Method:      [POST ▼]                    │      │   │
│  │  │                                          │      │   │
│  │  │ Parameters:                              │      │   │
│  │  │ ┌──────────┬────────┬──────┬───────────┐ │      │   │
│  │  │ │ Name     │ Type   │ Req  │ Desc      │ │      │   │
│  │  │ ├──────────┼────────┼──────┼───────────┤ │      │   │
│  │  │ │ amount   │ number │  ✓   │ Amount... │ │      │   │
│  │  │ │ currency │ string │  ✓   │ ISO 4217  │ │      │   │
│  │  │ │ card_id  │ string │  ✓   │ Card tok  │ │      │   │
│  │  │ └──────────┴────────┴──────┴───────────┘ │      │   │
│  │  │                                          │      │   │
│  │  │ Returns: {transactionId: string,         │      │   │
│  │  │          status: string}                 │      │   │
│  │  │                                  [▼ More]│      │   │
│  │  └──────────────────────────────────────────┘      │   │
│  │                                                    │   │
│  │  ┌─ refund ──────────────────────── HTTP ──┐      │   │
│  │  │ ...                                      │      │   │
│  │  └──────────────────────────────────────────┘      │   │
│  └────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

```
┌─────────────────────────────────────────────────────────┐
│  payments-api                    [Form] [DSL] [Test]     │
│  Payment processing tools                    [Save]      │
│─────────────────────────────────────────────────────────│
│                                                          │
│  ┌── DSL Mode ──────────────────────────────────────┐   │
│  │                                                    │   │
│  │  1  TOOLS:                                         │   │
│  │  2    base_url: "{{env.PAYMENTS_URL}}"             │   │
│  │  3    auth: bearer                                 │   │
│  │  4    timeout: 10000                               │   │
│  │  5    retry: 2                                     │   │
│  │  6                                                 │   │
│  │  7    charge_card(amount: number, currency:        │   │
│  │  8      string, card_id: string)                   │   │
│  │  9      -> {transactionId: string, status: string} │   │
│  │ 10      type: http                                 │   │
│  │ 11      endpoint: "/v1/charge"                     │   │
│  │ 12      method: POST                               │   │
│  │ 13      description: "Charge a payment card"       │   │
│  │ 14                                                 │   │
│  │ 15    refund(transaction_id: string, amount:       │   │
│  │ 16      number) -> {refundId: string}              │   │
│  │ 17      type: http                                 │   │
│  │ 18      endpoint: "/v1/refund"                     │   │
│  │ 19      method: POST                               │   │
│  │ 20      description: "Refund a transaction"        │   │
│  │                                                    │   │
│  │  ── Diagnostics ──────────────────────────────    │   │
│  │  ✓ 2 tools parsed successfully                     │   │
│  │  ✓ No compilation errors                           │   │
│  └────────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**Synchronization:**

- Switch from Form → DSL: serialize form state to DSL text
- Switch from DSL → Form: parse DSL text to structured form state
- Parse errors in DSL mode: show inline diagnostics, disable Form tab until fixed
- Form changes: auto-serialize to DSL in background (debounced)

### 4.5 Sandbox Tool Editor — Split View

For Sandbox tools, the form mode includes a code editor:

```
┌─────────────────────────────────────────────────────────┐
│  risk-models                     [Form] [DSL] [Test]     │
│─────────────────────────────────────────────────────────│
│                                                          │
│  ┌─ calculate_risk ──── Sandbox (JavaScript) ────────┐  │
│  │                                                    │  │
│  │ ┌── Config ──────────┐ ┌── Code ────────────────┐ │  │
│  │ │ Runtime: [JS ▼]    │ │ function calculateRisk │ │  │
│  │ │ Entrypoint:        │ │   (data) {             │ │  │
│  │ │ [calculateRisk]    │ │   const score =        │ │  │
│  │ │ Memory: [256] MB   │ │     data.revenue *     │ │  │
│  │ │ Timeout: [5000] ms │ │     0.3 + ...          │ │  │
│  │ │                    │ │   return { score,      │ │  │
│  │ │ Parameters:        │ │     factors };         │ │  │
│  │ │ ┌────────┬──────┐  │ │ }                      │ │  │
│  │ │ │ data   │object│  │ │                        │ │  │
│  │ │ └────────┴──────┘  │ │   [Templates ▼]       │ │  │
│  │ │                    │ │                        │ │  │
│  │ │ Returns:           │ │                        │ │  │
│  │ │ {score: number,    │ │                        │ │  │
│  │ │  factors: string[]}│ │                        │ │  │
│  │ └────────────────────┘ └────────────────────────┘ │  │
│  └────────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

### 4.6 MCP Tool — Discovery-Driven Creation

```
┌─────────────────────────────────────────────────────────┐
│  Create from MCP Server                                  │
│                                                          │
│  Server: [weather-service ▼]         [🔄 Refresh]       │
│  Status: 🟢 Connected (12ms) · 5 tools available        │
│                                                          │
│  Select tools to include:                                │
│  ┌──────────────────────────────────────────────────┐   │
│  │ ☑ get_weather(location: string) -> object         │   │
│  │   Get current weather for a location              │   │
│  │                                                    │   │
│  │ ☑ forecast(location: string, days: number)        │   │
│  │   Get weather forecast                            │   │
│  │                                                    │   │
│  │ ☐ alerts(region: string) -> object                │   │
│  │   Get weather alerts for a region                 │   │
│  │                                                    │   │
│  │ ☑ uv_index(location: string) -> object            │   │
│  │   Get UV index                                    │   │
│  │                                                    │   │
│  │ ☐ historical(location: string, date: string)      │   │
│  │   Get historical weather data                     │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│  Tool name: [weather-mcp-tools]                     │
│                                                          │
│  Preview generated DSL:                                  │
│  ┌──────────────────────────────────────────────────┐   │
│  │ TOOLS:                                            │   │
│  │   get_weather(location: string) -> object         │   │
│  │     type: mcp                                     │   │
│  │     server: "weather-service"                     │   │
│  │     tool: "get_weather"                           │   │
│  │     description: "Get current weather..."         │   │
│  │                                                    │   │
│  │   forecast(location: string, days: number)        │   │
│  │     -> object                                     │   │
│  │     type: mcp                                     │   │
│  │     server: "weather-service"                     │   │
│  │     tool: "forecast"                              │   │
│  │     description: "Get weather forecast"           │   │
│  │   ...                                             │   │
│  └──────────────────────────────────────────────────┘   │
│                                                          │
│                              [Cancel]  [Create Tool]│
└─────────────────────────────────────────────────────────┘
```

### 4.7 Tool Testing — Test from DSL

Replace the current `ToolTestPanel` (tests by tool entity ID) with a DSL-aware test panel:

```
┌─────────────────────────────────────────────────────────┐
│  Test: charge_card                                       │
│─────────────────────────────────────────────────────────│
│                                                          │
│  ┌── Input ─────────────────────────────────────────┐   │
│  │  [Form] [JSON]                                    │   │
│  │                                                    │   │
│  │  amount:   [100.00              ]  number          │   │
│  │  currency: [USD                 ]  string          │   │
│  │  card_id:  [tok_test_12345      ]  string          │   │
│  │                                                    │   │
│  │                                    [▶ Run Test]    │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  ┌── Result ────────────────────────────────────────┐   │
│  │  ✅ Success · 234ms                               │   │
│  │                                                    │   │
│  │  {                                                │   │
│  │    "transactionId": "txn_abc123",                 │   │
│  │    "status": "succeeded"                          │   │
│  │  }                                                │   │
│  │                                                    │   │
│  │  ▶ Request details                                │   │
│  │  ▶ Response headers                               │   │
│  └───────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

**How it works:**

1. Parse tool definition from DSL text
2. Generate input form from parameters (or accept raw JSON)
3. Resolve `{{env.X}}` and `{{secrets.X}}` via SecretsProvider
4. Execute tool (HTTP call / sandbox run / MCP call)
5. Display result with latency, request/response details

### 4.8 Agent Editor — Tool Integration

In the ABL editor, tools from tools are referenced via `FROM...USE`:

```
┌─────────────────────────────────────────────────────────┐
│  Agent: PaymentProcessor                                 │
│─────────────────────────────────────────────────────────│
│                                                          │
│  AGENT: PaymentProcessor                                 │
│  MODE: reasoning                                         │
│                                                          │
│  TOOLS:                                                  │
│    FROM "payments-api" USE: charge_card, refund ←[hover] │
│    FROM "analytics" USE: track_event                     │
│                                                          │
│    format_receipt(items: object[]) -> string              │
│      description: "Format receipt for display"           │
│                                                          │
│  ┌── Hover tooltip on "payments-api" ───────────────┐   │
│  │ Tool: payments-api                           │   │
│  │ 3 tools: charge_card, refund, get_balance         │   │
│  │ Last updated: 2h ago                              │   │
│  │ [Open Tool] [Insert More Tools]              │   │
│  └───────────────────────────────────────────────────┘   │
│                                                          │
│  ┌── Right sidebar / Tool picker ────────────────────┐  │
│  │ Available Tools:                              │  │
│  │ ┌────────────────────────────────────────┐        │  │
│  │ │ payments-api (3 tools)          [+ Add]│        │  │
│  │ │ weather-mcp-tools (5 tools)     [+ Add]│        │  │
│  │ │ risk-models (2 tools)           [+ Add]│        │  │
│  │ └────────────────────────────────────────┘        │  │
│  └───────────────────────────────────────────────────┘  │
└─────────────────────────────────────────────────────────┘
```

**Tool picker behavior:**

- Click "[+ Add]" on a tool → opens tool selector for that file
- Select specific tools → inserts `FROM "name" USE: tool1, tool2` into DSL
- Autocomplete on `FROM "` shows available tool names
- Autocomplete on `USE:` shows tools in the referenced file

### 4.9 cURL Import (Enhanced)

Keep the existing cURL import capability, but output DSL instead of DB entities:

```
Paste cURL → Parse → Generate tool DSL snippet → Insert into tool editor
```

```abl
# Generated from cURL import
search_users(query: string, page: number) -> object
  type: http
  endpoint: "https://api.example.com/v1/users/search"
  method: GET
  auth: bearer
  headers:
    Accept: "application/json"
    X-Request-ID: "{{env.REQUEST_PREFIX}}"
  timeout: 5000
  description: "Search for users by query"
```

---

## 5. Enterprise Concerns

### 5.1 Audit Trail

| Concern             | Solution                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Who changed a tool? | `project_tools.lastEditedBy` + `updatedAt`                                                                            |
| What changed?       | `sourceHash` change detection + agent version `dslContent` snapshots                                                  |
| Full history        | Agent versions capture the complete state at each publish point                                                       |
| SOC 2 compliance    | `tool_secrets` audit plugin stays (encrypted secrets). Tool changes tracked via DB timestamps + agent version history |

**Enhanced audit**: Add an optional `tool_audit_log` collection that records each save with diff:

```typescript
interface IToolAuditEntry {
  tenantId: string;
  projectId: string;
  toolId: string;
  action: 'create' | 'update' | 'delete';
  userId: string;
  previousHash: string | null;
  newHash: string;
  changedTools: string[]; // which tools were modified
  timestamp: Date;
}
```

### 5.2 Access Control

| Level   | Permission          | Notes                                         |
| ------- | ------------------- | --------------------------------------------- |
| Project | `PROJECT_READ`      | View tools and their content                  |
| Project | `PROJECT_WRITE`     | Create/edit tools                             |
| Project | `PROJECT_DELETE`    | Delete tools                                  |
| Project | `TOOL_EXECUTE`      | Execute tool tests                            |
| Project | `MCP_SERVER_MANAGE` | Create/edit/delete MCP server configs         |
| Project | `SECRETS_MANAGE`    | Create/edit environment variables and secrets |

This is simpler than the current per-tool-entity permissions, and aligned with the project-scoped RBAC model already used for agents and sessions.

### 5.3 Rate Limiting & Governance

Tool execution rate limits and circuit breakers are defined **per tool in DSL**:

```abl
charge_card(amount: number) -> object
  type: http
  endpoint: "{{env.PAYMENTS_URL}}/charge"
  rate_limit: 60          # 60 requests/minute
  circuit_breaker:
    threshold: 5
    reset_ms: 30000
```

These compile into the IR and are enforced by the runtime executor's `RateLimiter` and `CircuitBreaker` instances — same as today. No change needed.

**Project-level governance**: If needed in the future, add a `project_tool_policies` collection for project-wide rate limits, allowed domains, blocked patterns. This is orthogonal to tool storage format.

### 5.4 Large Team Workflows (100+ tools, 50+ agents)

| Challenge                    | Solution                                                                                          |
| ---------------------------- | ------------------------------------------------------------------------------------------------- |
| Tool discovery across files  | `toolNames` array index on `project_tools` enables "find which file has tool X"                   |
| Avoiding tool name conflicts | Compiler validates no duplicate tool names across all files imported by an agent                  |
| Change impact analysis       | Query: "which agents import tool X?" → scan `project_agents.dslContent` for `FROM "X"` references |
| Bulk operations              | Tool API supports batch create/update for migration and discovery                                 |
| Search across all tools      | Full-text index on `dslContent` + `toolNames` array for structured search                         |

### 5.5 Tool Deprecation & Breaking Changes

```abl
# Mark a tool as deprecated in its description
charge_card_v1(amount: number) -> object
  type: http
  endpoint: "{{env.PAYMENTS_URL}}/v1/charge"
  description: "@deprecated Use charge_card instead. Will be removed 2026-06-01."
```

**Compiler enhancement**: Parse `@deprecated` in description → emit warning diagnostic during compilation → Studio shows deprecation warnings in agent editor.

### 5.6 Cross-Project Tool Sharing

Current limitation: `project_tools` is scoped to `(tenantId, projectId)`. Tools can't be shared across projects natively.

**Future option**: Add `org_tools` collection scoped to `tenantId` only (no `projectId`). Projects reference via `FROM "@org/payments-api" USE: charge`. The `@org/` prefix signals organization-level resolution. This is a future enhancement — not needed for initial implementation.

---

## 6. Comparison with Current System

### 6.1 What improves

| Dimension           | Current (DB entities)                              | DSL-Native                                 |
| ------------------- | -------------------------------------------------- | ------------------------------------------ |
| AI generation       | Cannot generate `USE TOOL:` slugs                  | Generates complete DSL                     |
| Mental model        | Two systems (DB + DSL)                             | One system (DSL)                           |
| Code to maintain    | ~9,800 lines (API + UI + pipeline)                 | ~2,500 lines (API + UI)                    |
| MongoDB collections | 3 (tools, tool_versions, tool_secrets)             | 1 new (project_tools) + keep secrets       |
| API routes          | 13+                                                | 4                                          |
| Compilation         | Parse + resolve slugs + DB query + convert + merge | Parse + resolve names + parse tool + merge |
| Self-contained DSL  | No (needs DB for USE TOOL)                         | Yes (FROM...USE is resolvable)             |
| Code review         | Cannot see tool config (DB-hidden)                 | Full visibility in DSL                     |

### 6.2 What stays the same

| Dimension                      | Notes                                                                   |
| ------------------------------ | ----------------------------------------------------------------------- |
| Runtime execution              | Same executors (HttpToolExecutor, SandboxToolExecutor, McpToolExecutor) |
| Secret management              | Same SecretsProvider, same {{env.X}}/{{secrets.X}}                      |
| MCP server infrastructure      | Same mcp_server_configs collection                                      |
| IR output                      | Same ToolDefinition IR format                                           |
| SSRF protection                | Same validation in executors                                            |
| Circuit breakers & rate limits | Same resilience patterns                                                |

### 6.3 What requires investment

| Dimension                     | Effort | Notes                                                |
| ----------------------------- | ------ | ---------------------------------------------------- |
| Parser additions              | Low    | `auth_config:` block + `code:` multiline block       |
| Tool editor UI                | Medium | Dual-mode (Form + DSL) editor — the main UI work     |
| MCP discovery → DSL generator | Low    | Replace "create DB entities" with "generate DSL"     |
| Test from DSL panel           | Low    | Parse tool from DSL → execute (simpler than current) |
| `project_tools` collection    | Low    | Simple CRUD collection                               |
| Form ↔ DSL synchronization    | Medium | Bidirectional parsing/serialization                  |

---

## 7. DSL Grammar Extensions Required

### 7.1 `auth_config:` block (for HTTP tools)

```
auth_config:
  token_url: "{{env.OAUTH_TOKEN_URL}}"
  client_id: "{{env.OAUTH_CLIENT_ID}}"
  client_secret: "{{secrets.OAUTH_CLIENT_SECRET}}"
  scopes: "read write"
```

Parser: indented key-value pairs under `auth_config:`. Same as `headers:` parsing. Map to `HttpBindingAST.authConfig: Record<string, string>`.

### 7.2 `code:` multiline block (for Sandbox tools)

```
code: |
  function calculateRisk(data) {
    const score = data.revenue * 0.3;
    return { score, factors: [] };
  }
```

Parser: `|` signals multiline block. Read all subsequent lines at deeper indentation as the code content. Trim common leading whitespace. Map to `SandboxBindingAST.codeContent: string`.

### 7.3 `description:` multiline (already works)

The parser already handles `description: "..."` as a quoted string. For long descriptions:

```
description: |
  Charge a payment card with the specified amount and currency.
  Requires a valid card token from the tokenization service.
  Returns transaction ID and status.
```

### 7.4 No changes needed for MCP

The existing `server:` and `tool:` properties are sufficient. Server config resolution by name is a compiler change, not a parser change.

---

## 8. Complete DSL Examples (All Tool Types)

### 8.1 HTTP Tool

```abl
TOOLS:
  base_url: "{{env.PAYMENTS_URL}}"
  auth: bearer
  timeout: 10000
  retry: 2
  retry_delay: 1000

  charge_card(amount: number, currency: string, card_id: string)
    -> {transactionId: string, status: string}
    type: http
    endpoint: "/v1/charge"
    method: POST
    description: "Charge a payment card"
    rate_limit: 60
    circuit_breaker:
      threshold: 5
      reset_ms: 30000

  refund(transaction_id: string, amount: number)
    -> {refundId: string, status: string}
    type: http
    endpoint: "/v1/refund"
    method: POST
    description: "Refund a transaction"

  get_balance(account_id: string) -> {balance: number, currency: string}
    type: http
    endpoint: "/v1/accounts/{account_id}/balance"
    method: GET
    description: "Get account balance"
```

### 8.2 Sandbox Tool

```abl
TOOLS:
  calculate_risk(data: object) -> {score: number, factors: string[]}
    type: sandbox
    runtime: javascript
    entrypoint: calculateRisk
    memory_mb: 256
    timeout: 5000
    description: "Calculate financial risk score"
    code: |
      function calculateRisk(data) {
        const weights = { revenue: 0.3, debt: 0.5, history: 0.2 };
        let score = 0;
        const factors = [];

        if (data.revenue) score += data.revenue * weights.revenue;
        if (data.debt > 100000) {
          score += data.debt * weights.debt;
          factors.push('high_debt');
        }
        if (data.history < 2) factors.push('short_history');

        return { score: Math.round(score), factors };
      }

  analyze_sentiment(text: string) -> {sentiment: string, confidence: number}
    type: sandbox
    runtime: python
    entrypoint: analyze
    memory_mb: 512
    timeout: 10000
    description: "Analyze text sentiment"
    code: |
      def analyze(text):
          positive_words = ['good', 'great', 'excellent', 'amazing']
          negative_words = ['bad', 'terrible', 'awful', 'poor']

          text_lower = text.lower()
          pos = sum(1 for w in positive_words if w in text_lower)
          neg = sum(1 for w in negative_words if w in text_lower)

          total = pos + neg
          if total == 0:
              return {"sentiment": "neutral", "confidence": 0.5}

          if pos > neg:
              return {"sentiment": "positive", "confidence": pos / total}
          return {"sentiment": "negative", "confidence": neg / total}
```

### 8.3 MCP Tool

```abl
TOOLS:
  get_weather(location: string) -> {temp: number, conditions: string, humidity: number}
    type: mcp
    server: "weather-service"
    tool: "get_current_weather"
    description: "Get current weather for a location"

  forecast(location: string, days: number) -> {daily: object[]}
    type: mcp
    server: "weather-service"
    tool: "forecast"
    description: "Get multi-day weather forecast"

  search_docs(query: string, limit: number) -> {results: object[], total: number}
    type: mcp
    server: "docs-search"
    tool: "search"
    description: "Search documentation index"
```

### 8.4 Mixed Tool

```abl
TOOLS:
  # HTTP tool with full config
  geocode(address: string) -> {lat: number, lng: number}
    type: http
    endpoint: "{{env.GEOCODING_URL}}/v1/search"
    method: GET
    auth: api_key
    auth_config:
      header_name: "X-Api-Key"
    headers:
      X-Api-Key: "{{secrets.GEOCODING_KEY}}"
    timeout: 3000
    description: "Geocode an address to coordinates"

  # MCP tool
  get_weather(location: string) -> object
    type: mcp
    server: "weather-service"
    tool: "get_current_weather"
    description: "Get weather for coordinates"

  # Sandbox tool
  calculate_route(origin: object, destination: object) -> {distance: number, duration: number}
    type: sandbox
    runtime: javascript
    entrypoint: calculateRoute
    memory_mb: 128
    timeout: 3000
    description: "Calculate driving route between two points"
    code: |
      function calculateRoute(origin, destination) {
        const R = 6371;
        const dLat = (destination.lat - origin.lat) * Math.PI / 180;
        const dLng = (destination.lng - origin.lng) * Math.PI / 180;
        const a = Math.sin(dLat/2) * Math.sin(dLat/2);
        const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
        const distance = R * c;
        return { distance: Math.round(distance * 10) / 10, duration: Math.round(distance / 60 * 60) };
      }
```

### 8.5 Agent Referencing Tools

```abl
AGENT: TravelAssistant
MODE: reasoning

GOAL: |
  Help users plan trips by finding flights, hotels, weather,
  and local recommendations.

TOOLS:
  FROM "payments-api" USE: charge_card, refund
  FROM "weather-mcp-tools" USE: get_weather, forecast
  FROM "travel-utils" USE: geocode, calculate_route

  # Inline tool (no tool)
  format_itinerary(segments: object[]) -> string
    description: "Format a travel itinerary for display"

INSTRUCTIONS: |
  1. Ask the user for destination and dates
  2. Check weather forecast for the destination
  3. Search for flights and hotels
  4. Present options with pricing
  5. Process payment when user confirms
```

---

## 9. End-to-End Flow: DSL → AST → IR → Execution

This section traces the complete lifecycle of a tool from DSL text to runtime execution, covering every transformation, caching layer, and latency consideration.

### 9.1 Phase 1: Parse (DSL → AST)

**Current flow** (inline tools):

```
Agent dslContent (from project_agents.dslContent in MongoDB)
  ↓
parseAgentBasedABL(dslContent)
  ↓
AgentBasedDocument {
  tools: AgentTool[]           ← inline tool definitions
  toolImports: ToolImport[]    ← FROM "name" USE: tool1, tool2
  toolLinks: ToolLink[]        ← USE TOOL: slug (being removed)
}
```

**New flow** (DSL-native with tools):

```
Agent dslContent (from project_agents.dslContent)
  ↓
parseAgentBasedABL(dslContent)
  ↓
AgentBasedDocument {
  tools: AgentTool[]           ← inline tool definitions
  toolImports: ToolImport[]    ← FROM "payments-api" USE: charge, refund
}
  ↓
resolveToolImports(toolImports, tenantId, projectId)
  ↓  1. Query: project_tools.findOne({ name: "payments-api", tenantId, projectId })
  ↓  2. parseToolDsl(tool.dslContent) → ToolDocument
  ↓  3. Extract requested tools + merge shared defaults (base_url, auth, headers)
  ↓  4. Return merged AgentTool[] with sourceFile metadata
  ↓
Merged AgentTool[] (inline + resolved imports)
```

**Per-tool-type AST output:**

| Tool Type | AST Fields Populated                                                                                      | New Fields (this design)                         |
| --------- | --------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| HTTP      | `httpBinding: { endpoint, method, auth, headers, timeout, retry, retryDelay, rateLimit, circuitBreaker }` | `httpBinding.authConfig: Record<string, string>` |
| Sandbox   | `sandboxBinding: { runtime, entrypoint, timeout, memoryMb }`                                              | `sandboxBinding.codeContent: string`             |
| MCP       | `mcpBinding: { server, tool }`                                                                            | None — already complete                          |

**Latency**: Parse is CPU-bound, single-pass. ~10-50ms for typical agents. Tool resolution adds 1 DB query per unique `FROM` reference (batched if multiple imports from same file).

**Key change from current**: Replaces `resolveToolLinks()` (batch slug query → `convertDbToolToIR()` per tool) with `resolveToolImports()` (name query → parse DSL → extract tools). The new flow is simpler: one query returns a DSL string, the existing tool parser handles the rest. No per-type conversion logic needed.

### 9.2 Phase 2: Compile (AST → IR)

```
Merged AgentTool[] (inline + imported)
  ↓
compileTools(doc) → ToolDefinition[]
  ↓  Per tool:
  ↓    compileHttpBinding(ast)    → HttpBindingIR
  ↓    compileMcpBinding(ast)     → McpBindingIR
  ↓    compileSandboxBinding(ast) → SandboxBindingIR
  ↓    inferToolHints(tool)       → ToolHints
  ↓
compileSystemTools(doc) → system ToolDefinition[] (__handoff__, __delegate__, etc.)
  ↓
Validate tool references (all tools in flow steps exist)
  ↓
resolveConfigVariables(ir, configVars)
  ↓  {{config.X}} → replaced with values
  ↓  {{env.X}}    → PRESERVED (runtime resolution)
  ↓  {{secrets.X}} → PRESERVED (runtime resolution)
  ↓
CompilationOutput {
  agents: AgentIR[]
  entry_agent: string
  metadata: { source_hash, compiled_at, config_hash }
}
```

**Per-type IR output:**

**HTTP → HttpBindingIR:**

```typescript
{
  endpoint: "{{env.PAYMENTS_URL}}/v1/charge",  // env placeholders preserved
  method: "POST",
  auth: {
    type: "oauth2_client",
    config: {                                   // NEW: from auth_config: block
      oauth: {
        tokenUrl: "{{env.OAUTH_TOKEN_URL}}",
        clientId: "{{env.OAUTH_CLIENT_ID}}",
        scopes: ["payments:write"]
      }
    }
  },
  headers: {
    "X-Api-Key": "{{secrets.API_KEY}}"         // secret placeholders preserved
  },
  timeout_ms: 10000,
  retry: { count: 2, delay_ms: 1000 },
  rate_limit_per_minute: 60,
  circuit_breaker: { threshold: 5, reset_ms: 30000 }
}
```

**Sandbox → SandboxBindingIR:**

```typescript
{
  runtime: "javascript",
  entrypoint: "calculateRisk",
  timeout_ms: 5000,
  memory_mb: 256,
  code_content: "function calculateRisk(data) { ... }"  // NEW: from code: block
}
```

**MCP → McpBindingIR:**

```typescript
{
  server: "weather-service",                    // name reference
  tool: "get_current_weather",
  server_config: {                              // baked at compile time
    name: "weather-service",
    transport: "sse",
    url: "https://weather.api.com/mcp",
    encrypted_env: "...",
    encrypted_auth_config: "...",
    auth_type: "bearer",
    connection_timeout_ms: 30000,
    request_timeout_ms: 30000
  }
}
```

**MCP server config baking**: The compiler resolves `server: "weather-service"` → queries `mcp_server_configs` by `(tenantId, projectId, name)` → bakes the full server config into the IR. This means **zero DB lookups at runtime** for MCP server details. Auth and env are stored encrypted — decrypted only at execution time.

**Tool hints inference** (automatic, per type):

| Tool Type                  | Default Latency | Default Side Effects | Default Requires Auth  |
| -------------------------- | --------------- | -------------------- | ---------------------- |
| HTTP GET                   | slow            | false                | true if auth specified |
| HTTP POST/PUT/PATCH/DELETE | slow            | true                 | true if auth specified |
| MCP                        | slow            | true                 | false                  |
| Sandbox                    | medium          | true                 | false                  |

Hints can be overridden explicitly in DSL: `cacheable: true`, `latency: fast`, `side_effects: false`.

**Latency**: Compilation is CPU-bound + 1 DB query for MCP server config resolution. ~50-200ms for typical agents. Happens once at deploy/publish time, not per request.

**Source hash**: `hashSource(JSON.stringify(doc))` produces a 16-char hex SHA-256 prefix. Used as cache key for IR storage. Same DSL content = same hash = cache hit.

### 9.3 Phase 3: Store & Cache (IR → Storage)

```
CompilationOutput
  ↓
┌─────────────────────────────────────────────┐
│ L0: Database (persistent)                    │
│                                              │
│ agent_versions.irContent = JSON.stringify(   │
│   compilationOutput)                         │
│ agent_versions.dslContent = original DSL     │
│                                              │
│ Stored at: publish/deploy time               │
│ Retrieved: deployment resolver fallback      │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ L2: Redis (cluster-ready, 2h TTL)            │
│                                              │
│ Key: ir:{sourceHash}                         │
│ Value: gzip(JSON.stringify(agentIR))         │
│                                              │
│ Key: comp:{compilationHash}                  │
│ Value: gzip(JSON.stringify(compilationOutput))│
│                                              │
│ Compression: async promisify(gzip)           │
│ Decompression: async promisify(gunzip)       │
│ TTL: 7200s (2 hours)                         │
│ Tenant-agnostic keys (same source = same IR) │
└─────────────────────────────────────────────┘
  ↓
┌─────────────────────────────────────────────┐
│ L1: In-Memory (per pod, bounded)             │
│                                              │
│ Map<sourceHash, AgentIR>                     │
│ LRU eviction, no TTL (pod-local)             │
│                                              │
│ Warmed on: session creation                  │
│ Hit on: session rehydration                  │
└─────────────────────────────────────────────┘
```

**Session stores reference, not copy:**

```typescript
SessionData {
  irSourceHash: "a1b2c3d4e5f67890"   // 16-char hash → lookup IR from cache
  compilationHash: "f0e1d2c3b4a59687" // hash → lookup full CompilationOutput
  // NOT: agentIR: { ... }  ← never stored on session
}
```

This is critical for distributed architecture: sessions are small (~1-5KB), IR is large (~10-100KB). Sessions are stored in Redis per-tenant. IR is stored once per unique source hash, shared across all tenants with the same agent definition.

### 9.4 Phase 4: Session Load & IR Retrieval

```
Incoming request (message for session)
  ↓
Load SessionData from Redis: sess:{tenantId}:{sessionId}
  ↓
Get irSourceHash from session
  ↓
┌─ L1 check ─────────────────────────────┐
│ irL1Cache.get(irSourceHash)             │
│ Hit: ~0ms (in-memory Map lookup)        │
│ Miss: proceed to L2                     │
└─────────────────────────────────────────┘
  ↓ miss
┌─ L2 check ─────────────────────────────┐
│ redis.getBuffer("ir:" + irSourceHash)   │
│ Hit: ~2-5ms (Redis GET + gunzip)        │
│ Miss: proceed to L0                     │
│                                         │
│ On hit: decompress, parse, cache in L1  │
└─────────────────────────────────────────┘
  ↓ miss
┌─ L0 check ─────────────────────────────┐
│ DeploymentResolver → AgentVersion.irContent │
│ Hit: ~10-50ms (MongoDB query + parse)   │
│ Miss: error — agent not deployed        │
│                                         │
│ On hit: cache in L2 + L1               │
└─────────────────────────────────────────┘
  ↓
AgentIR in execution context
```

**Latency budget for session rehydration:**

- L1 hit: <1ms (typical after first request to pod)
- L2 hit: 2-5ms (Redis roundtrip + gunzip decompression)
- L0 hit: 10-50ms (MongoDB query, rare — only on cold start or cache eviction)

### 9.5 Phase 5: Tool Execution

```
LLM decides to call tool "charge_card"
  ↓
ToolBindingExecutor.execute("charge_card", params, timeoutMs)
  ↓
Route by tool_type:
  ├─ http    → HttpToolExecutor.execute()
  ├─ mcp     → McpToolExecutor.execute()
  └─ sandbox → SandboxToolExecutor.execute()
```

#### HTTP Execution Pipeline

```
HttpToolExecutor.execute("charge_card", {amount: 100, currency: "USD"})
  ↓
1. Rate limit check
   binding.rate_limit_per_minute → acquire token from RateLimiter
   (in-memory sliding window, per tool name, tenant-scoped key)
  ↓
2. Circuit breaker check
   breaker.isOpen() → throw TOOL_CIRCUIT_OPEN if open
   (per-tool breaker, threshold + reset_ms from IR)
  ↓
3. Build request
   a. Resolve {{secrets.X}} → SecretsProvider.getSecret(key)
   b. Resolve {{env.X}}     → SecretsProvider.getEnvVar(key)
   c. Apply auth:
      - api_key:    resolve secret → set header
      - bearer:     resolve secret → "Bearer {token}" header
      - oauth2_client: exchange credentials at tokenUrl → cache token → set header
      - oauth2_user:   get user OAuth token from provider → set header
      - custom:     resolve custom headers
   d. Substitute path params: /v1/accounts/{account_id} → /v1/accounts/acc_123
   e. SSRF validation: block private IPs, cloud metadata, non-HTTP schemes
   f. Header CRLF sanitization
  ↓
4. Retry loop (0 to retry.count)
   fetch(endpoint, { method, headers, body, timeout })
     ↓ success
     breaker.recordSuccess()
     parse response (JSON or text)
     validate size (max 10MB, truncate with warning)
     return parsed result
     ↓ failure
     breaker.recordFailure()
     exponential backoff: delay_ms * 2^attempt
     retry or throw
```

#### MCP Execution Pipeline

```
McpToolExecutor.execute("get_weather", {location: "NYC"})
  ↓
1. Get MCP client
   mcpClients.getClient(binding.server, projectId)
   → RuntimeMcpClientProvider resolves server by ID
   → MCPServerManager returns connected client
   (server already connected at session creation via ensureServersForTools)
  ↓
2. Circuit breaker check (per server, not per tool)
   breaker.isOpen() → throw if open
  ↓
3. Call tool with single retry
   client.callTool(binding.tool, params)
     ↓ success
     breaker.recordSuccess()
     normalizeMcpResult(result)
       → extract text from MCP content array
       → note non-text content (images, resources)
       → return: string | { text, nonTextContent }
     ↓ transient failure (ECONNRESET, ETIMEDOUT)
     retry once with backoff
     ↓ permanent failure
     breaker.recordFailure()
     throw
```

#### Sandbox Execution Pipeline

```
SandboxToolExecutor.execute("calculate_risk", {data: {revenue: 50000}})
  ↓
1. Validate entrypoint
   Block: null bytes, absolute paths, parent traversal (..)
  ↓
2. Load code
   code_content from IR (baked at compile time)
   OR codeProvider(toolName) for runtime loading
  ↓
3. Execute in gVisor sandbox
   GvisorSandboxRunner.run({
     code, entrypoint, runtime, params,
     limits: { timeoutMs, memoryMb }
   })
   → Route to pod: javascriptPodUrl or pythonPodUrl
   → POST /execute-script with code + params
   → JavaScript: $-prefix all parameter keys
   → Python: passthrough
  ↓
4. Parse pod response
   { response: <result>, logs: string[], error?: string }
   → return response (the function's return value)
   → log execution details (toolName, runtime, latencyMs, success)
```

### 9.6 Phase 6: Result Handling & LLM Feedback

```
Tool result (unknown)
  ↓
Serialize: JSON.stringify(result)
  ↓
Build LLM tool_result message:
{
  type: "tool_result",
  tool_use_id: toolCall.id,
  content: serializedResult
}
  ↓
Append to conversation history
  ↓
Store in session values: session.data.values["last_charge_card_result"] = result
  ↓
Send to LLM for next reasoning step
```

**Result size considerations:**

- HTTP responses truncated at 10MB (`MAX_RESPONSE_BYTES`)
- Error bodies truncated at 256 chars (`MAX_ERROR_BODY_LENGTH`)
- MCP results normalized: content arrays flattened to text
- Sandbox results: raw function return value (JSON-serializable)

**Cacheable tools** (when `hints.cacheable: true`):

- Result can be cached by `hash(toolName + JSON.stringify(params))`
- Cache TTL configurable per tool
- Useful for read-only lookups (weather, search, reference data)
- Not cached by default — explicit opt-in via DSL hint

### 9.7 Latency Summary

| Phase              | Step                                 | Latency         | Frequency                    |
| ------------------ | ------------------------------------ | --------------- | ---------------------------- |
| **Parse**          | Parse agent DSL                      | 10-50ms         | Per compile                  |
| **Parse**          | Resolve tool imports (DB query)      | 2-10ms per file | Per compile                  |
| **Parse**          | Parse tool DSL                       | 5-20ms per file | Per compile                  |
| **Compile**        | compileTools() + inferHints()        | 20-100ms        | Per compile                  |
| **Compile**        | Resolve MCP server config (DB query) | 2-10ms          | Per compile (if MCP tools)   |
| **Compile**        | resolveConfigVariables()             | 1-5ms           | Per compile (if config vars) |
| **Store**          | Gzip + Redis SET                     | 5-20ms          | Per compile                  |
| **Store**          | MongoDB write (irContent)            | 10-30ms         | Per publish                  |
| **Session create** | Store session + cache IR ref         | <5ms            | Per session                  |
| **Session load**   | L1 cache hit                         | <1ms            | Per request (warm)           |
| **Session load**   | L2 Redis hit (GET + gunzip)          | 2-5ms           | Per request (cold pod)       |
| **Session load**   | L0 MongoDB fallback                  | 10-50ms         | Rare (cache eviction)        |
| **Tool execute**   | HTTP tool (network + processing)     | 100-5000ms      | Per tool call                |
| **Tool execute**   | MCP tool (server call)               | 50-2000ms       | Per tool call                |
| **Tool execute**   | Sandbox (pod execution)              | 50-5000ms       | Per tool call                |
| **Tool execute**   | Secret resolution                    | 1-5ms           | Per tool call (cached)       |
| **LLM call**       | Model inference                      | 500-3000ms      | Per reasoning step           |

**Critical path for user-perceived latency:**

```
User message → Session load (L1: <1ms) → LLM call (500-3000ms) → Tool execution (100-5000ms) → LLM call (500-3000ms) → Response
```

Tool execution and LLM calls dominate latency. The DSL-native approach does NOT change runtime latency — the IR output is identical, the executors are identical. The only change is in compile-time flow (which happens once at publish, not per request).

### 9.8 What Changes vs. What Stays Identical

| Component                        | Current Flow                                                              | DSL-Native Flow                                              | Change?                        |
| -------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------ | ------------------------------ |
| **Parse agent DSL**              | `parseAgentBasedABL()`                                                    | Same                                                         | No                             |
| **Resolve tool imports**         | `resolveToolLinks()` → DB query by slugs → `convertDbToolToIR()` per tool | `resolveToolImports()` → DB query by name → `parseToolDsl()` | **Yes** — simpler              |
| **Compile tools**                | `compileTools()` for inline + merge DB-resolved                           | `compileTools()` for all (inline + imported)                 | **Simplified** — no merge step |
| **Compile HTTP binding**         | `compileHttpBinding(ast)`                                                 | Same + handle `authConfig`                                   | **Minor addition**             |
| **Compile Sandbox binding**      | `compileSandboxBinding(ast)`                                              | Same + include `code_content`                                | **Minor addition**             |
| **Compile MCP binding**          | `compileMcpBinding(ast)` + bake server config                             | Same                                                         | No                             |
| **IR format**                    | `ToolDefinition` with bindings                                            | Same                                                         | No                             |
| **IR storage**                   | Redis L2 (gzipped) + MongoDB L0                                           | Same                                                         | No                             |
| **IR caching**                   | L1 in-memory + L2 Redis                                                   | Same                                                         | No                             |
| **Session data**                 | `irSourceHash` reference                                                  | Same                                                         | No                             |
| **ToolBindingExecutor dispatch** | Route by `tool_type`                                                      | Same                                                         | No                             |
| **HttpToolExecutor**             | Resolve secrets → build request → SSRF → retry → parse                    | Same                                                         | No                             |
| **McpToolExecutor**              | Get client → call tool → normalize result                                 | Same                                                         | No                             |
| **SandboxToolExecutor**          | Load code → execute in gVisor → parse response                            | Same                                                         | No                             |
| **Secret resolution**            | `SecretsProvider.getSecret()` / `getEnvVar()`                             | Same                                                         | No                             |
| **Rate limiting**                | Per-tool RateLimiter                                                      | Same                                                         | No                             |
| **Circuit breakers**             | Per-tool/server CircuitBreaker                                            | Same                                                         | No                             |
| **Result parsing**               | JSON.stringify → tool_result → LLM                                        | Same                                                         | No                             |
| **Compression**                  | Async gzip/gunzip for Redis storage                                       | Same                                                         | No                             |
| **Tenant isolation**             | tenantId on all queries + Redis keys                                      | Same                                                         | No                             |

**Summary**: The DSL-native change affects ONLY the compile-time tool resolution path (Phase 1-2). Everything from IR storage onwards (Phase 3-6) is identical. Zero runtime performance impact.

---

## 10. Database Modeling & Design Patterns

### 10.1 Current State: Entity-Relationship Diagram

```
┌──────────────┐     ┌─────────────────┐     ┌───────────────────┐
│   projects   │     │     tools       │     │  tool_versions    │
│──────────────│     │─────────────────│     │───────────────────│
│ _id          │◄────│ projectId       │     │ _id               │
│ tenantId     │     │ tenantId        │◄────│ toolId            │
│ name         │     │ name            │     │ tenantId          │
│ slug         │     │ slug (immut.)   │     │ version (number)  │
│ entryAgent   │     │ toolType        │     │ versionName       │
│ ownerId      │     │ source          │     │ description       │
│              │     │ tags            │     │ inputSchema       │
│              │     │ createdBy       │     │ outputSchema      │
│              │     │                 │     │ timeoutMs (30000) │
│              │     │ IDX: tenant+    │     │ cacheable         │
│              │     │   project+slug  │     │ parallelizable    │
│              │     │   (unique)      │     │ sideEffects       │
│              │     │                 │     │ requiresAuth      │
│              │     │ IDX: tenant+    │     │ returnDirect      │
│              │     │   project+type  │     │ isPublished       │
│              │     │                 │     │ httpConfig: {     │
│              │     │ TEXT: name+tags │     │   endpoint        │
│              │     │                 │     │   method          │
└──────────────┘     └─────────────────┘     │   authType        │
                                              │   authConfig      │
┌──────────────────┐                          │   headers         │
│ project_agents   │                          │   retryCount      │
│──────────────────│                          │   retryDelayMs    │
│ _id              │                          │   rateLimitPerMin │
│ projectId        │                          │   circuitBreaker  │
│ name             │                          │ }                 │
│ agentPath        │                          │ mcpConfig: {      │
│ dslContent ◄─────┼── DSL with              │   serverUrl       │
│ sourceHash       │   "USE TOOL: slug"       │   transportType   │
│ domain           │                          │   serverToolName  │
│ activeVersions   │                          │   headers[]       │
│ ownerId          │                          │   serverId ───────┼──┐
│                  │                          │ }                 │  │
│ IDX: project+    │                          │ sandboxConfig: {  │  │
│   name (unique)  │                          │   runtime         │  │
│                  │                          │   codeContent     │  │
└──────────────────┘                          │   memoryMb        │  │
                                              │ }                 │  │
┌──────────────────┐                          │                   │  │
│ agent_versions   │                          │ IDX: tenant+tool+ │  │
│──────────────────│                          │   version (unique)│  │
│ _id              │                          │ IDX: tenant+tool+ │  │
│ agentId          │                          │   published (uniq)│  │
│ version          │                          │ IDX: tenant+      │  │
│ status           │                          │   mcpConfig.      │  │
│ dslContent       │                          │   serverId        │  │
│ irContent ◄──────┼── Full compiled IR       └───────────────────┘  │
│ sourceHash       │   (JSON string)                                  │
│ toolVersionSnap  │                          ┌───────────────────┐  │
│                  │                          │mcp_server_configs │  │
└──────────────────┘                          │───────────────────│  │
                                              │ _id ◄─────────────┼──┘
┌──────────────────┐                          │ tenantId          │
│  tool_secrets    │                          │ projectId         │
│──────────────────│                          │ name              │
│ _id              │                          │ transport         │
│ tenantId         │                          │ url               │
│ projectId        │                          │ authType          │
│ toolName         │                          │ encryptedAuthCfg  │
│ secretKey        │                          │ encryptedEnv      │
│ encryptedValue   │                          │ connectionTimeout │
│ environment      │                          │ requestTimeout    │
│ version          │                          │ autoReconnect     │
│ expiresAt        │                          │ maxReconnectAtmpt │
│                  │                          │ priority          │
│ ENCRYPTED:       │                          │ tags              │
│  AES-256-GCM     │                          │ lastConnStatus    │
│ AUDIT: yes       │                          │ lastConnLatencyMs │
│                  │                          │ lastConnToolCount │
│ IDX: tenant+proj+│                          │                   │
│  name+key+env    │                          │ IDX: tenant+proj+ │
│  (unique)        │                          │   name (unique)   │
└──────────────────┘                          └───────────────────┘

┌────────────────────────┐    ┌────────────────────────────┐
│ environment_variables  │    │ project_config_variables   │
│────────────────────────│    │────────────────────────────│
│ _id                    │    │ _id                        │
│ tenantId               │    │ tenantId                   │
│ projectId              │    │ projectId                  │
│ environment            │    │ key                        │
│ key                    │    │ value (plaintext)          │
│ encryptedValue         │    │ description                │
│ isSecret               │    │                            │
│ description            │    │ Resolved at: compile time  │
│                        │    │ Pattern: {{config.KEY}}    │
│ Resolved at: runtime   │    │                            │
│ Pattern: {{env.KEY}}   │    │ IDX: tenant+proj+key       │
│                        │    │   (unique)                 │
│ IDX: tenant+proj+env+  │    │ AUDIT: yes                 │
│   key (unique)         │    └────────────────────────────┘
│ AUDIT: yes             │
└────────────────────────┘

Total collections for tool system: 3 (tools, tool_versions, tool_secrets)
+ 2 infrastructure (mcp_server_configs, environment_variables)
+ 1 config (project_config_variables)
= 6 collections
```

**Problems with current model:**

1. `tools` + `tool_versions` = 2 collections for one logical concept (a tool definition)
2. `tool_versions` has 4 mutually exclusive config sub-schemas (http, mcp, sandbox, lambda) — complex validation
3. `USE TOOL: slug` resolution requires: query tools by slug → join tool_versions → convertDbToolToIR() per type → merge into compiler
4. `toolVersionSnapshot` on agent_versions duplicates tool metadata for audit trail
5. Tool slug is immutable after creation — renames require delete + recreate

### 10.2 New State: DSL-Native Entity-Relationship Diagram

```
┌──────────────┐     ┌─────────────────────┐
│   projects   │     │ project_tools   │   ◄── NEW (replaces tools + tool_versions)
│──────────────│     │─────────────────────│
│ _id          │◄────│ projectId           │
│ tenantId     │     │ tenantId            │
│ name         │     │ name                │   "payments-api"
│ slug         │     │ slug                │   "payments-api"
│ entryAgent   │     │ description         │   "Payment processing tools"
│ ownerId      │     │ dslContent          │   ◄── FULL .tools.abl DSL (source of truth)
│              │     │ sourceHash          │   SHA-256 of dslContent
│              │     │ toolCount           │   3 (cached count)
│              │     │ toolNames           │   ["charge_card","refund","get_balance"]
│              │     │ toolTypes           │   ["http"] (cached unique types)
│              │     │ source              │   "manual" | "discovered" | "ai_generated"
│              │     │ createdBy           │
│              │     │ lastEditedBy        │
│              │     │                     │
│              │     │ IDX: tenant+proj+   │
│              │     │   name (unique)     │
│              │     │ IDX: tenant+proj+   │
│              │     │   slug (unique)     │
│              │     │ IDX: tenant+        │
│              │     │   toolNames (array) │
│              │     │ TEXT: name+         │
│              │     │   description       │
└──────────────┘     └─────────────────────┘

┌──────────────────┐
│ project_agents   │     References tools via FROM...USE in dslContent
│──────────────────│
│ _id              │     dslContent example:
│ projectId        │     ┌──────────────────────────────────────┐
│ name             │     │ AGENT: PaymentProcessor              │
│ agentPath        │     │ TOOLS:                               │
│ dslContent ──────┼────▶│   FROM "payments-api" USE: charge,   │
│ sourceHash       │     │     refund                           │
│ domain           │     │   FROM "weather-mcp" USE: get_weather│
│ activeVersions   │     │   format_receipt(items) -> string    │
│ ownerId          │     │     description: "Format receipt"    │
│                  │     └──────────────────────────────────────┘
└──────────────────┘

┌──────────────────┐
│ agent_versions   │     Snapshots: dslContent + irContent at version time
│──────────────────│     irContent contains compiled ToolDefinition[] with
│ _id              │     all bindings baked in (http, mcp server_config, sandbox code)
│ agentId          │
│ version          │     toolSnapshot (NEW): full tool DSL frozen at compile time
│ status           │     [{ name: "payments-api",
│ dslContent       │        sourceHash: "abc123",
│ irContent        │        dslSnapshot: "TOOLS:\n  base_url: ...",
│ sourceHash       │        toolNames: ["charge", "refund"] }]
│ toolSnapshot │ ◄── NEW: replaces toolVersionSnapshot (includes full dslSnapshot)
└──────────────────┘

┌───────────────────┐          UNCHANGED — infrastructure config
│mcp_server_configs │
│───────────────────│          Referenced from DSL by name:
│ _id               │            server: "weather-service"
│ tenantId          │
│ projectId         │          Baked into IR at compile time
│ name              │          (zero DB lookups at runtime)
│ transport         │
│ url               │
│ authType          │
│ encryptedAuthCfg  │
│ encryptedEnv      │
│ connectionTimeout │
│ requestTimeout    │
│ ...               │
└───────────────────┘

┌──────────────────┐    ┌────────────────────────┐    ┌────────────────────────────┐
│  tool_secrets    │    │ environment_variables  │    │ project_config_variables   │
│──────────────────│    │────────────────────────│    │────────────────────────────│
│ UNCHANGED        │    │ UNCHANGED              │    │ UNCHANGED                  │
│                  │    │                        │    │                            │
│ {{secrets.X}}    │    │ {{env.X}} resolved     │    │ {{config.X}} resolved      │
│ resolved at      │    │ at runtime             │    │ at compile time            │
│ runtime          │    │                        │    │                            │
└──────────────────┘    └────────────────────────┘    └────────────────────────────┘

DELETED: tools, tool_versions (replaced by project_tools)
DELETED: USE TOOL: syntax, resolveToolLinks(), convertDbToolToIR()
KEPT: tool_secrets, environment_variables, project_config_variables, mcp_server_configs
NEW: project_tools (1 simple collection)
```

### 10.3 `project_tools` Collection — Complete Schema

```typescript
import { Schema, model } from 'mongoose';

// ─── Interface ───────────────────────────────────────────

export interface IProjectTool {
  _id: string;
  tenantId: string;
  projectId: string;

  // Identity
  name: string; // Human-readable: "payments-api"
  slug: string; // URL-safe: "payments-api"
  description: string | null;

  // Content (source of truth)
  dslContent: string; // Full .tools.abl DSL text

  // Cached metadata (derived from dslContent, updated on save)
  sourceHash: string; // SHA-256 of dslContent (for change detection)
  toolCount: number; // Number of tools defined in this file
  toolNames: string[]; // ["charge_card", "refund", "get_balance"]
  toolTypes: string[]; // ["http"] or ["http", "mcp"] (unique types)

  // Provenance
  source: 'manual' | 'discovered' | 'ai_generated';

  // Audit
  createdBy: string;
  lastEditedBy: string | null;
  createdAt: Date;
  updatedAt: Date;

  // Optimistic concurrency
  _v: number;
}

// ─── Schema ──────────────────────────────────────────────

const projectToolSchema = new Schema<IProjectTool>(
  {
    _id: { type: String, default: () => generateUUIDv7() },
    tenantId: { type: String, required: true },
    projectId: { type: String, required: true },

    name: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 128,
      trim: true,
    },
    slug: {
      type: String,
      required: true,
      minlength: 1,
      maxlength: 128,
      trim: true,
      lowercase: true,
    },
    description: { type: String, default: null, maxlength: 2048 },

    dslContent: {
      type: String,
      required: true,
      maxlength: 512 * 1024, // 512KB max (handles large sandbox code blocks)
    },

    sourceHash: { type: String, required: true },
    toolCount: { type: Number, default: 0, min: 0 },
    toolNames: [{ type: String }],
    toolTypes: [{ type: String, enum: ['http', 'mcp', 'sandbox'] }],

    source: {
      type: String,
      required: true,
      enum: ['manual', 'discovered', 'ai_generated'],
      default: 'manual',
    },
    createdBy: { type: String, required: true },
    lastEditedBy: { type: String, default: null },

    _v: { type: Number, default: 1 },
  },
  {
    timestamps: true,
    collection: 'project_tools',
  },
);

// ─── Indexes ─────────────────────────────────────────────

// Unique name per project (primary lookup for FROM "name" USE:)
projectToolSchema.index({ tenantId: 1, projectId: 1, name: 1 }, { unique: true });

// Unique slug per project (for URL routing)
projectToolSchema.index({ tenantId: 1, projectId: 1, slug: 1 }, { unique: true });

// Find which record contains a specific tool name
projectToolSchema.index({ tenantId: 1, projectId: 1, toolNames: 1 });

// Text search across name and description
projectToolSchema.index({ name: 'text', description: 'text' });

// ─── Pre-save: compute cached metadata ───────────────────

projectToolSchema.pre('save', function (next) {
  if (this.isModified('dslContent')) {
    // Recompute hash
    this.sourceHash = createHash('sha256').update(this.dslContent).digest('hex');

    // Parse DSL to extract tool metadata
    const parseResult = parseToolDsl(this.dslContent);
    if (parseResult.document) {
      const tools = parseResult.document.tools;
      this.toolCount = tools.length;
      this.toolNames = tools.map((t) => t.name);
      this.toolTypes = [...new Set(tools.map((t) => t.type).filter(Boolean))];
    }
  }
  next();
});

// ─── Plugins ─────────────────────────────────────────────

projectToolSchema.plugin(tenantIsolationPlugin);
// Optional: auditTrailPlugin for SOC 2 compliance

export const ProjectTool = model<IProjectTool>('ProjectTool', projectToolSchema);
```

### 10.4 Design Pattern: Pre-Save Metadata Extraction

The `project_tools` model uses a **derived cache** pattern. The `dslContent` field is the single source of truth, but we extract and cache metadata on every save for efficient querying:

```
Save dslContent
  ↓ pre-save hook
  ├─ sourceHash = SHA-256(dslContent)          → change detection
  ├─ parseToolDsl(dslContent)                 → parse DSL
  ├─ toolCount = tools.length                  → display in list UI
  ├─ toolNames = tools.map(t => t.name)        → "find file containing tool X"
  └─ toolTypes = unique types from tools       → filter by type in UI
```

**Why cache?** Without these fields, listing tools would require parsing every `dslContent` to show tool counts and names in the UI. With cached metadata:

- List page: single MongoDB query returns name, description, toolCount, toolNames, toolTypes
- Search "which file has charge_card": query `{ toolNames: "charge_card" }` — indexed
- Filter by type: query `{ toolTypes: "http" }` — indexed
- Change detection: compare `sourceHash` without parsing

**Consistency guarantee**: Pre-save hook runs synchronously before write. Cached fields are always consistent with `dslContent` at rest. If DSL parsing fails in the hook, the save is rejected.

### 10.5 Design Pattern: Agent → Tool Reference Resolution

```typescript
// ─── Compiler resolver ───────────────────────────────────

interface ToolImport {
  name: string; // FROM "payments-api" → name = "payments-api"
  toolNames: string[]; // USE: charge_card, refund → ["charge_card", "refund"]
}

async function resolveToolImports(
  imports: ToolImport[],
  tenantId: string,
  projectId: string,
): Promise<{ tools: AgentTool[]; errors: string[] }> {
  const tools: AgentTool[] = [];
  const errors: string[] = [];

  // Batch: fetch all referenced tools in one query
  const names = imports.map((i) => i.name);
  const projectTools = await ProjectTool.find({
    tenantId,
    projectId,
    name: { $in: names },
  });

  // Build lookup map
  const toolMap = new Map(projectTools.map((t) => [t.name, t]));

  for (const imp of imports) {
    const tool = toolMap.get(imp.name);
    if (!tool) {
      errors.push(`Tool "${imp.name}" not found in project`);
      continue;
    }

    // Parse the tool DSL
    const parseResult = parseToolDsl(tool.dslContent);
    if (!parseResult.document) {
      errors.push(`Tool "${imp.name}" has parse errors`);
      continue;
    }

    // Extract only the requested tools
    const availableTools = new Map(parseResult.document.tools.map((t) => [t.name, t]));

    for (const toolName of imp.toolNames) {
      const tool = availableTools.get(toolName);
      if (!tool) {
        errors.push(
          `Tool "${toolName}" not found in tool "${imp.name}". ` +
            `Available: ${[...availableTools.keys()].join(', ')}`,
        );
        continue;
      }
      tools.push({ ...tool, sourceFile: imp.name });
    }
  }

  return { tools, errors };
}
```

**Batch query pattern**: All tool references resolved in a single `$in` query, not N+1 queries. For an agent referencing 3 tools: 1 query returns all 3.

### 10.6 Design Pattern: Agent Version Snapshot

When an agent version is created, the `agent_versions` record captures the exact tool state — including the full DSL content of each referenced tool. This is the **only** versioning mechanism for tools (see Section 12 for full details).

```typescript
// ─── agent_versions.toolSnapshot ─────────────────────

interface ToolSnapshotEntry {
  name: string;           // "payments-api"
  sourceHash: string;     // "a1b2c3..." — exact content hash at compile time
  dslSnapshot: string;    // Full DSL content of tool at compile time
  toolNames: string[];    // ["charge_card", "refund"] — which tools were imported
}

// Example agent_versions record:
{
  _id: "01JMKR...",
  agentId: "01JMKP...",
  version: "1.0.0",
  status: "draft",
  dslContent: "AGENT: PaymentProcessor\nTOOLS:\n  FROM \"payments-api\" USE: ...",
  irContent: "{ \"agents\": [...], ... }",   // Full compiled IR
  sourceHash: "f0e1d2c3...",
  toolSnapshot: [
    {
      name: "payments-api",
      sourceHash: "a1b2c3d4...",
      dslSnapshot: "TOOLS:\n  base_url: \"{{env.STRIPE_URL}}\"\n  ...",
      toolNames: ["charge_card", "refund"]
    },
    {
      name: "weather-mcp",
      sourceHash: "e5f67890...",
      dslSnapshot: "TOOLS:\n  get_weather(location: string) -> object\n  ...",
      toolNames: ["get_weather"]
    }
  ],
  createdBy: "user_123",
  createdAt: "2026-02-24T10:00:00Z"
}
```

**Why `dslSnapshot` (full DSL) instead of just `sourceHash`:**

- Self-contained audit trail — see exactly what the tool looked like at version time
- Diff between agent versions — compare `dslSnapshot` across versions
- Revert tool to previous state — copy `dslSnapshot` back to `project_tools.dslContent`
- No separate tool version collection needed — the agent version IS the snapshot

### 10.7 Design Pattern: MCP Discovery → Tool DSL Generation

```typescript
// ─── Discovery flow ──────────────────────────────────────

async function discoverAndCreateTool(
  serverId: string,
  tenantId: string,
  projectId: string,
  userId: string,
  selectedTools?: string[], // optional filter
): Promise<IProjectTool> {
  // 1. Get server config
  const server = await McpServerConfig.findOne({
    _id: serverId,
    tenantId,
    projectId,
  });

  // 2. Discover tools from MCP server
  const discovered = await discoverPreview(serverId, tenantId, projectId);

  // 3. Filter to selected tools (or all)
  const tools = selectedTools
    ? discovered.tools.filter((t) => selectedTools.includes(t.name))
    : discovered.tools;

  // 4. Generate DSL content
  const dslContent = generateMcpToolDsl(server.name, tools);

  // 5. Create or update project_tools entry
  return await ProjectTool.findOneAndUpdate(
    { tenantId, projectId, name: `${server.name}-tools` },
    {
      $set: {
        dslContent,
        source: 'discovered',
        lastEditedBy: userId,
        description: `MCP tools from ${server.name}`,
      },
      $setOnInsert: {
        slug: slugify(`${server.name}-tools`),
        createdBy: userId,
      },
    },
    { upsert: true, new: true },
  );
}

function generateMcpToolDsl(serverName: string, tools: DiscoveredTool[]): string {
  const lines = ['TOOLS:'];

  for (const tool of tools) {
    // Generate parameter signature from inputSchema
    const params = inputSchemaToParamString(tool.inputSchema);
    lines.push(`  ${tool.name}(${params}) -> object`);
    lines.push(`    type: mcp`);
    lines.push(`    server: "${serverName}"`);
    lines.push(`    tool: "${tool.name}"`);
    if (tool.description) {
      lines.push(`    description: "${tool.description}"`);
    }
    lines.push('');
  }

  return lines.join('\n');
}
```

**Example generated DSL:**

```abl
TOOLS:
  get_weather(location: string) -> object
    type: mcp
    server: "weather-service"
    tool: "get_weather"
    description: "Get current weather for a location"

  forecast(location: string, days: number) -> object
    type: mcp
    server: "weather-service"
    tool: "forecast"
    description: "Get multi-day weather forecast"
```

### 10.8 Design Pattern: Tool CRUD API

```typescript
// ─── API routes (4 routes replace 13+) ──────────────────

// GET /api/projects/:projectId/tool-files
//   → list all tools (uses cached metadata, no DSL parsing)
//   → supports: ?search=payments&type=http&published=true
//   Response: { id, name, slug, description, toolCount, toolNames, toolTypes, source, updatedAt }[]

// GET /api/projects/:projectId/tool-files/:idOrSlug
//   → get single tool with full dslContent
//   Response: { id, name, slug, description, dslContent, toolCount, toolNames, source, ... }

// PUT /api/projects/:projectId/tool-files/:idOrSlug
//   → create or update tool
//   → pre-save hook validates DSL, extracts metadata
//   → returns validation diagnostics if DSL has errors
//   Body: { name?, description?, dslContent }
//   Response: { id, name, slug, dslContent, toolCount, toolNames, diagnostics[] }

// DELETE /api/projects/:projectId/tool-files/:idOrSlug
//   → delete tool
//   → returns impact analysis: which agents reference this file
//   Response: { deleted: true, impactedAgents: string[] }
```

**Impact analysis on delete:**

```typescript
async function getImpactedAgents(
  tenantId: string,
  projectId: string,
  toolName: string,
): Promise<string[]> {
  // Search agent dslContent for FROM "toolName" references
  const agents = await ProjectAgent.find({
    projectId,
    dslContent: { $regex: `FROM\\s+"${escapeRegex(toolName)}"` },
  });
  return agents.map((a) => a.name);
}
```

### 10.9 Design Pattern: Form ↔ DSL Bidirectional Sync

The dual-mode editor (Form + DSL) uses a **parse → structured state → serialize** pattern:

```typescript
// ─── DSL → Form (parse) ─────────────────────────────────

interface ToolFormState {
  defaults: {
    baseUrl?: string;
    auth?: string;
    timeout?: number;
    retry?: number;
    headers?: Record<string, string>;
  };
  tools: ToolFormState[];
}

interface ToolFormState {
  name: string;
  description?: string;
  type: 'http' | 'mcp' | 'sandbox';
  parameters: { name: string; type: string; required: boolean; description?: string }[];
  returns: string;

  // HTTP-specific
  endpoint?: string;
  method?: string;
  auth?: string;
  authConfig?: Record<string, string>;
  headers?: Record<string, string>;
  rateLimit?: number;
  circuitBreaker?: { threshold: number; resetMs: number };

  // MCP-specific
  server?: string;
  tool?: string;

  // Sandbox-specific
  runtime?: string;
  entrypoint?: string;
  memoryMb?: number;
  code?: string;
}

function dslToFormState(dslContent: string): ToolFormState | null {
  const result = parseToolDsl(dslContent);
  if (!result.document) return null;

  return {
    defaults: {
      baseUrl: result.document.defaults?.baseUrl,
      auth: result.document.defaults?.auth,
      timeout: result.document.defaults?.timeout,
      retry: result.document.defaults?.retry,
      headers: result.document.defaults?.headers,
    },
    tools: result.document.tools.map((t) => ({
      name: t.name,
      description: t.description,
      type: t.type || 'http',
      parameters: t.parameters.map((p) => ({
        name: p.name,
        type: p.type,
        required: p.required ?? true,
        description: p.description,
      })),
      returns: serializeReturnType(t.returns),
      // HTTP
      endpoint: t.httpBinding?.endpoint,
      method: t.httpBinding?.method,
      auth: t.httpBinding?.auth,
      authConfig: t.httpBinding?.authConfig,
      headers: t.httpBinding?.headers,
      rateLimit: t.httpBinding?.rateLimit,
      circuitBreaker: t.httpBinding?.circuitBreaker,
      // MCP
      server: t.mcpBinding?.server,
      tool: t.mcpBinding?.tool,
      // Sandbox
      runtime: t.sandboxBinding?.runtime,
      entrypoint: t.sandboxBinding?.entrypoint,
      memoryMb: t.sandboxBinding?.memoryMb,
      code: t.sandboxBinding?.codeContent,
    })),
  };
}

// ─── Form → DSL (serialize) ─────────────────────────────

function formStateToDsl(state: ToolFormState): string {
  const lines: string[] = ['TOOLS:'];

  // Shared defaults
  if (state.defaults.baseUrl) lines.push(`  base_url: "${state.defaults.baseUrl}"`);
  if (state.defaults.auth) lines.push(`  auth: ${state.defaults.auth}`);
  if (state.defaults.timeout) lines.push(`  timeout: ${state.defaults.timeout}`);
  if (state.defaults.retry) lines.push(`  retry: ${state.defaults.retry}`);
  if (state.defaults.headers) {
    lines.push(`  headers:`);
    for (const [k, v] of Object.entries(state.defaults.headers)) {
      lines.push(`    ${k}: "${v}"`);
    }
  }
  if (Object.values(state.defaults).some(Boolean)) lines.push('');

  // Tools
  for (const tool of state.tools) {
    const params = tool.parameters.map((p) => `${p.name}: ${p.type}`).join(', ');
    lines.push(`  ${tool.name}(${params}) -> ${tool.returns}`);
    lines.push(`    type: ${tool.type}`);
    if (tool.description) lines.push(`    description: "${tool.description}"`);

    if (tool.type === 'http') {
      if (tool.endpoint) lines.push(`    endpoint: "${tool.endpoint}"`);
      if (tool.method) lines.push(`    method: ${tool.method}`);
      if (tool.auth) lines.push(`    auth: ${tool.auth}`);
      if (tool.authConfig && Object.keys(tool.authConfig).length > 0) {
        lines.push(`    auth_config:`);
        for (const [k, v] of Object.entries(tool.authConfig)) {
          lines.push(`      ${k}: "${v}"`);
        }
      }
      if (tool.headers && Object.keys(tool.headers).length > 0) {
        lines.push(`    headers:`);
        for (const [k, v] of Object.entries(tool.headers)) {
          lines.push(`      ${k}: "${v}"`);
        }
      }
      if (tool.rateLimit) lines.push(`    rate_limit: ${tool.rateLimit}`);
      if (tool.circuitBreaker) {
        lines.push(`    circuit_breaker:`);
        lines.push(`      threshold: ${tool.circuitBreaker.threshold}`);
        lines.push(`      reset_ms: ${tool.circuitBreaker.resetMs}`);
      }
    }

    if (tool.type === 'mcp') {
      if (tool.server) lines.push(`    server: "${tool.server}"`);
      if (tool.tool) lines.push(`    tool: "${tool.tool}"`);
    }

    if (tool.type === 'sandbox') {
      if (tool.runtime) lines.push(`    runtime: ${tool.runtime}`);
      if (tool.entrypoint) lines.push(`    entrypoint: ${tool.entrypoint}`);
      if (tool.memoryMb) lines.push(`    memory_mb: ${tool.memoryMb}`);
      if (tool.code) {
        lines.push(`    code: |`);
        for (const codeLine of tool.code.split('\n')) {
          lines.push(`      ${codeLine}`);
        }
      }
    }

    lines.push('');
  }

  return lines.join('\n');
}
```

**Round-trip guarantee**: `formStateToDsl(dslToFormState(dsl))` should produce functionally equivalent DSL (may differ in whitespace/formatting). Comprehensive round-trip tests validate this.

### 10.10 Complete Worked Example

**Scenario**: User creates a project with 3 tools, 2 agents, deploys to production.

**Step 1: Create tools**

```
project_tools:

┌────────────────────────────────────────────────────────────────┐
│ _id: "01JMKR-A"                                                │
│ tenantId: "tenant_acme"                                        │
│ projectId: "proj_travel"                                       │
│ name: "payments-api"                                           │
│ slug: "payments-api"                                           │
│ description: "Stripe payment processing tools"                 │
│ dslContent: |                                                  │
│   TOOLS:                                                       │
│     base_url: "{{env.STRIPE_URL}}"                             │
│     auth: bearer                                               │
│     timeout: 10000                                             │
│                                                                │
│     charge(amount: number, currency: string) -> object         │
│       type: http                                               │
│       endpoint: "/v1/charges"                                  │
│       method: POST                                             │
│       headers:                                                 │
│         Authorization: "Bearer {{secrets.STRIPE_KEY}}"         │
│       description: "Create a charge"                           │
│                                                                │
│     refund(charge_id: string) -> object                        │
│       type: http                                               │
│       endpoint: "/v1/refunds"                                  │
│       method: POST                                             │
│       headers:                                                 │
│         Authorization: "Bearer {{secrets.STRIPE_KEY}}"         │
│       description: "Refund a charge"                           │
│                                                                │
│ sourceHash: "a1b2c3d4e5f67890..."                              │
│ toolCount: 2                                                   │
│ toolNames: ["charge", "refund"]                                │
│ toolTypes: ["http"]                                            │
│ source: "manual"                                               │
│ createdBy: "user_sai"                                          │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ _id: "01JMKR-B"                                                │
│ name: "weather-mcp"                                            │
│ dslContent: |                                                  │
│   TOOLS:                                                       │
│     get_weather(location: string) -> object                    │
│       type: mcp                                                │
│       server: "weather-svc"                                    │
│       tool: "get_current_weather"                              │
│       description: "Get weather"                               │
│                                                                │
│ toolCount: 1                                                   │
│ toolNames: ["get_weather"]                                     │
│ toolTypes: ["mcp"]                                             │
│ source: "discovered"                                           │
└────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────┐
│ _id: "01JMKR-C"                                                │
│ name: "scoring-models"                                         │
│ dslContent: |                                                  │
│   TOOLS:                                                       │
│     score_risk(data: object) -> {score: number}                │
│       type: sandbox                                            │
│       runtime: javascript                                      │
│       entrypoint: scoreRisk                                    │
│       memory_mb: 256                                           │
│       description: "Risk scoring model"                        │
│       code: |                                                  │
│         function scoreRisk(data) {                             │
│           return { score: data.amount * 0.01 };                │
│         }                                                      │
│                                                                │
│ toolCount: 1                                                   │
│ toolNames: ["score_risk"]                                      │
│ toolTypes: ["sandbox"]                                         │
│ source: "manual"                                               │
└────────────────────────────────────────────────────────────────┘
```

**Step 2: Create agent that references tools**

```
project_agents:

┌────────────────────────────────────────────────────────────────┐
│ _id: "01JMKR-D"                                                │
│ projectId: "proj_travel"                                       │
│ name: "BookingAgent"                                           │
│ dslContent: |                                                  │
│   AGENT: BookingAgent                                          │
│   MODE: reasoning                                              │
│                                                                │
│   GOAL: Help users book travel and process payments            │
│                                                                │
│   TOOLS:                                                       │
│     FROM "payments-api" USE: charge, refund                    │
│     FROM "weather-mcp" USE: get_weather                        │
│     FROM "scoring-models" USE: score_risk                      │
│                                                                │
│     format_booking(details: object) -> string                  │
│       description: "Format booking confirmation"               │
│                                                                │
│   INSTRUCTIONS: |                                              │
│     1. Check weather at destination                            │
│     2. Score risk for the booking                              │
│     3. Process payment                                         │
│     4. Format and return confirmation                          │
│                                                                │
│ sourceHash: "d4e5f678..."                                      │
└────────────────────────────────────────────────────────────────┘
```

**Step 3: Compile → what happens**

```
1. Parse agent DSL
   → inline tools: [format_booking]
   → imports: [
       { name: "payments-api", toolNames: ["charge", "refund"] },
       { name: "weather-mcp", toolNames: ["get_weather"] },
       { name: "scoring-models", toolNames: ["score_risk"] }
     ]

2. Resolve imports (1 batch DB query)
   → ProjectTool.find({ name: { $in: ["payments-api", "weather-mcp", "scoring-models"] } })
   → 3 documents returned
   → Parse each dslContent → extract requested tools → merge defaults

3. Compile all tools to IR
   → charge:       HttpBindingIR  { endpoint: "{{env.STRIPE_URL}}/v1/charges", ... }
   → refund:       HttpBindingIR  { endpoint: "{{env.STRIPE_URL}}/v1/refunds", ... }
   → get_weather:  McpBindingIR   { server: "weather-svc", server_config: { baked } }
   → score_risk:   SandboxBindingIR { runtime: "javascript", code_content: "function..." }
   → format_booking: (no binding — inline tool, LLM uses description)

4. Add system tools
   → __escalate__, __complete__

5. Store IR + snapshot
   → agent_versions.irContent = JSON.stringify(compilationOutput)
   → agent_versions.toolSnapshot = [
       { name: "payments-api", sourceHash: "a1b2c3...",
         dslSnapshot: "<full DSL at compile time>",
         toolNames: ["charge", "refund"] },
       { name: "weather-mcp", sourceHash: "e5f678...",
         dslSnapshot: "<full DSL at compile time>",
         toolNames: ["get_weather"] },
       { name: "scoring-models", sourceHash: "f0e1d2...",
         dslSnapshot: "<full DSL at compile time>",
         toolNames: ["score_risk"] }
     ]
```

**Step 4: Runtime — user sends "Book a flight to NYC"**

```
1. Session load → irSourceHash → L1 cache hit → AgentIR

2. LLM reasoning: "I should check the weather first"
   → tool_use: get_weather({location: "NYC"})
   → McpToolExecutor → client.callTool("get_current_weather", {location: "NYC"})
   → Result: {temp: 45, conditions: "cloudy"}

3. LLM: "Now score the risk"
   → tool_use: score_risk({data: {amount: 500, destination: "NYC"}})
   → SandboxToolExecutor → gVisor pod → {score: 5}

4. LLM: "Process payment"
   → tool_use: charge({amount: 500, currency: "USD"})
   → HttpToolExecutor:
       resolve {{env.STRIPE_URL}} → "https://api.stripe.com"
       resolve {{secrets.STRIPE_KEY}} → "sk_live_..."
       POST https://api.stripe.com/v1/charges
   → Result: {id: "ch_123", status: "succeeded"}

5. LLM: "Format the confirmation"
   → tool_use: format_booking({details: {...}})
   → (No binding — LLM generates the formatted text itself)

6. LLM response → user sees booking confirmation
```

---

## 11. Deployments & Environments

Tools participate in the existing deployment and environment pipeline. No new deployment machinery is needed — tools are resolved at compile time and baked into the IR that deployments serve.

### 11.1 How Tools Flow Through Deployments

```
┌─────────────────────────────────────────────────────────────────────┐
│                        AUTHORING TIME                               │
│                                                                     │
│  project_tools (mutable)                                            │
│  ┌──────────────────┐  ┌──────────────────┐  ┌──────────────────┐  │
│  │ payments-api     │  │ weather-mcp      │  │ scoring-models   │  │
│  │ dslContent: ...  │  │ dslContent: ...  │  │ dslContent: ...  │  │
│  │ sourceHash: abc  │  │ sourceHash: def  │  │ sourceHash: ghi  │  │
│  └────────┬─────────┘  └────────┬─────────┘  └────────┬─────────┘  │
│           └───────────────┬─────┘                      │            │
│                           ▼                            │            │
│  project_agents (mutable working copy)                 │            │
│  ┌───────────────────────────────────────────┐         │            │
│  │ BookingAgent                               │         │            │
│  │ dslContent:                                │         │            │
│  │   TOOLS:                                   │         │            │
│  │     FROM "payments-api" USE: charge, refund│         │            │
│  │     FROM "weather-mcp" USE: get_weather    │         │            │
│  │     FROM "scoring-models" USE: score_risk ─┼─────────┘            │
│  └────────┬──────────────────────────────────┘                      │
└───────────┼─────────────────────────────────────────────────────────┘
            │
            ▼  Create Version (compile)
┌─────────────────────────────────────────────────────────────────────┐
│                        VERSION TIME                                 │
│                                                                     │
│  agent_versions (immutable snapshot)                                │
│  ┌───────────────────────────────────────────────────────┐          │
│  │ agentId: BookingAgent                                  │          │
│  │ version: "1.0.0"                                       │          │
│  │ dslContent: (frozen copy of agent DSL)                 │          │
│  │ irContent: (compiled IR with all tool bindings baked)  │          │
│  │ toolSnapshot: [                                        │          │
│  │   { name: "payments-api", sourceHash: "abc",           │          │
│  │     dslSnapshot: "<full DSL content at compile time>", │          │
│  │     toolNames: ["charge", "refund"] },                 │          │
│  │   { name: "weather-mcp", sourceHash: "def",            │          │
│  │     dslSnapshot: "<full DSL content at compile time>", │          │
│  │     toolNames: ["get_weather"] },                      │          │
│  │   { name: "scoring-models", sourceHash: "ghi",         │          │
│  │     dslSnapshot: "<full DSL content at compile time>", │          │
│  │     toolNames: ["score_risk"] }                        │          │
│  │ ]                                                      │          │
│  └────────┬──────────────────────────────────────────────┘          │
└───────────┼─────────────────────────────────────────────────────────┘
            │
            ▼  Deploy to environment
┌─────────────────────────────────────────────────────────────────────┐
│                        DEPLOYMENT TIME                              │
│                                                                     │
│  deployments (one per environment)                                  │
│  ┌───────────────────────────────────────────────┐                  │
│  │ environment: "production"                      │                  │
│  │ status: "active"                               │                  │
│  │ agentVersionManifest: {                        │                  │
│  │   "BookingAgent": "1.0.0",                     │                  │
│  │   "SupportAgent": "2.1.0"                      │                  │
│  │ }                                              │                  │
│  │ modelOverrides: {                              │                  │
│  │   "BookingAgent": { model: "claude-sonnet-..." }│                  │
│  │ }                                              │                  │
│  │ compilationHash: "xyz789"                      │                  │
│  │ endpointSlug: "acme-travel-prod"               │                  │
│  └────────┬──────────────────────────────────────┘                  │
└───────────┼─────────────────────────────────────────────────────────┘
            │
            ▼  Runtime: session created against deployment
┌─────────────────────────────────────────────────────────────────────┐
│                        RUNTIME                                      │
│                                                                     │
│  Session → irSourceHash → L1/L2/L0 cache → AgentIR                 │
│  AgentIR contains compiled ToolDefinition[] with all bindings       │
│  {{env.X}} → resolved from environment_variables (env-scoped)       │
│  {{secrets.X}} → resolved from tool_secrets (env-scoped)            │
│  No queries to project_tools at runtime                             │
└─────────────────────────────────────────────────────────────────────┘
```

**Key principle**: `project_tools` is a **mutable authoring-time** collection. It is never read at runtime. All tool data is compiled into the IR at version/deploy time. The deployment serves frozen, compiled IR.

### 11.2 Environment-Scoped Resolution

Tools reference secrets and environment variables via placeholders. These are resolved differently per environment:

```
┌─────────────────────────────────────────────────────────────┐
│  Same IR (same compiled tools)                               │
│  charge.endpoint = "{{env.STRIPE_URL}}/v1/charges"          │
│  charge.headers.Authorization = "Bearer {{secrets.STRIPE_KEY}}"│
└──────┬──────────────────────────────┬───────────────────────┘
       │                              │
       ▼ deployed to staging          ▼ deployed to production
┌──────────────────┐           ┌──────────────────┐
│ environment_variables       │ environment_variables
│ env: "staging"   │           │ env: "production" │
│ STRIPE_URL:      │           │ STRIPE_URL:       │
│  api.stripe.com/ │           │  api.stripe.com/  │
│  test            │           │  live             │
└──────────────────┘           └──────────────────┘
┌──────────────────┐           ┌──────────────────┐
│ tool_secrets     │           │ tool_secrets      │
│ env: "staging"   │           │ env: "production" │
│ STRIPE_KEY:      │           │ STRIPE_KEY:       │
│  sk_test_xxx     │           │  sk_live_xxx      │
└──────────────────┘           └──────────────────┘
```

**Same compiled IR, different runtime values.** The deployment doesn't change when you rotate a secret or update an env var — the IR still says `{{secrets.STRIPE_KEY}}`, and `SecretsProvider` resolves it per-environment at tool execution time.

### 11.3 Environment Lifecycle

| Environment  | Purpose                      | Tool Behavior                                                                                           |
| ------------ | ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `dev`        | Working copy, fast iteration | Tools compiled from latest `project_tools` + `project_agents` (no version required — "auto" versioning) |
| `staging`    | Pre-production testing       | Pinned agent versions with frozen tool snapshots. Separate env vars and secrets.                        |
| `production` | Live traffic                 | Pinned agent versions. Production secrets. Promotion from staging.                                      |
| `test`       | Automated testing            | Ephemeral. Can use mock secrets.                                                                        |

**Promotion flow (existing — unchanged by this design):**

```
staging deployment → promote to production
  1. Clone agentVersionManifest (same versions)
  2. Layer modelOverrides (production-specific models)
  3. Update channels: auto-follow channels in production switch to new deployment
  4. Previous production deployment → status: "draining" → auto-retire after 30 min
```

Tools don't need separate promotion — they're already baked into the agent versions. Promoting a deployment promotes the exact tool state that was compiled.

### 11.4 Deployment Validation

Before creating a deployment, validate that all required env vars and secrets exist for the target environment:

```typescript
// Existing: POST /api/projects/:projectId/env-vars/validate
// Enhanced: also check tool-referenced placeholders from IR

async function validateDeploymentEnvVars(
  projectId: string,
  tenantId: string,
  environment: string,
  compilationOutput: CompilationOutput,
): Promise<{ missing: string[]; warnings: string[] }> {
  // 1. Extract all {{env.X}} and {{secrets.X}} from compiled IR
  const requiredEnvVars = extractEnvPlaceholders(compilationOutput);
  const requiredSecrets = extractSecretPlaceholders(compilationOutput);

  // 2. Check environment_variables for this environment
  const existingVars = await EnvironmentVariable.find({
    tenantId,
    projectId,
    environment,
    key: { $in: requiredEnvVars },
  });
  const existingVarKeys = new Set(existingVars.map((v) => v.key));

  // 3. Check tool_secrets for this environment
  const existingSecrets = await ToolSecret.find({
    tenantId,
    projectId,
    environment,
    secretKey: { $in: requiredSecrets },
  });
  const existingSecretKeys = new Set(existingSecrets.map((s) => s.secretKey));

  // 4. Report missing
  const missingVars = requiredEnvVars.filter((k) => !existingVarKeys.has(k));
  const missingSecrets = requiredSecrets.filter((k) => !existingSecretKeys.has(k));

  return {
    missing: [...missingVars.map((k) => `env.${k}`), ...missingSecrets.map((k) => `secrets.${k}`)],
    warnings: [],
  };
}
```

**UI integration**: Studio deployment dialog shows a "pre-flight check" before deploying — red flags for missing env vars/secrets in the target environment. Copy from another environment if needed (existing `POST /env-vars/copy` endpoint).

### 11.5 Rollback & Tool State

```
Timeline:
  t0: Deploy v1 (tools at hash abc)
  t1: Edit project_tools (tools now at hash def)
  t2: Deploy v2 (tools at hash def)
  t3: Rollback to v1
       → v1's irContent still has tools at hash abc
       → v1's toolSnapshot still records sourceHash: abc
       → Runtime uses v1's compiled IR — tools at original state
       → No re-compilation needed
```

**Rollback is safe** because agent versions contain the full compiled IR. Changing `project_tools` after a version was created has no effect on that version — it was already frozen.

---

## 12. Versioning Strategy: Agent-Level Only

### 12.1 Design Principle

**Tools have no independent versioning.** `project_tools` is a mutable collection — edits are in-place. Version control happens exclusively at the **agent level** via `agent_versions`, which snapshots the complete tool state at compile time.

```
┌──────────────────────────────────────────────────────────────┐
│  WHY: Tools are like source files, agents are like releases   │
│                                                               │
│  project_tools = source code (mutable, editable)              │
│  agent_versions = release artifacts (immutable, deployable)   │
│                                                               │
│  You don't version individual source files independently.     │
│  You version the release that includes them.                  │
│  If you need to see what a tool looked like at release time,  │
│  look at the agent version's snapshot.                        │
└──────────────────────────────────────────────────────────────┘
```

### 12.2 What Gets Snapshotted

When an agent version is created (via `POST /api/projects/:projectId/agents/:agentName/versions`):

```typescript
interface ToolSnapshotEntry {
  name: string;           // "payments-api" — which project_tools record
  sourceHash: string;     // SHA-256 of dslContent at compile time
  dslSnapshot: string;    // Full DSL content at compile time (frozen copy)
  toolNames: string[];    // ["charge", "refund"] — which tools were imported
}

// On agent_versions record:
{
  _id: "01JMKR...",
  agentId: "01JMKP...",
  version: "1.0.0",
  status: "draft",
  dslContent: "AGENT: BookingAgent\n...",  // Agent DSL frozen
  irContent: "{ \"agents\": [...] }",       // Full compiled IR frozen
  sourceHash: "f0e1d2c3...",
  toolSnapshot: [                           // Tool state frozen
    {
      name: "payments-api",
      sourceHash: "a1b2c3d4...",
      dslSnapshot: "TOOLS:\n  base_url: \"{{env.STRIPE_URL}}\"\n  ...",
      toolNames: ["charge", "refund"]
    },
    {
      name: "weather-mcp",
      sourceHash: "e5f67890...",
      dslSnapshot: "TOOLS:\n  get_weather(location: string) -> object\n  ...",
      toolNames: ["get_weather"]
    }
  ],
  createdBy: "user_sai",
  createdAt: "2026-02-24T10:00:00Z"
}
```

**Three things frozen per agent version:**

1. `dslContent` — the agent's own DSL source
2. `irContent` — compiled IR (all bindings resolved and baked)
3. `toolSnapshot` — full DSL content of each referenced tool at compile time

### 12.3 Why Snapshot DSL Content (Not Just Hash)

Storing `dslSnapshot` (the full tool DSL at compile time) instead of just `sourceHash` means:

1. **Self-contained audit trail** — you can see exactly what the tool looked like when the agent was versioned, even if the tool has since been edited or deleted
2. **Diff capability** — compare `toolSnapshot[i].dslSnapshot` between two agent versions to see what changed in the tool
3. **Revert capability** — restore a tool to its state from a previous agent version by copying `dslSnapshot` back to `project_tools.dslContent`
4. **No dependency on project_tools history** — the agent version is a complete record; you don't need to reconstruct state from a separate audit log

**Size impact**: Minimal. Tool DSL is typically 1-5KB. An agent with 5 tool references adds ~5-25KB to the snapshot. The `irContent` itself is already 10-100KB — the snapshot is a small fraction.

### 12.4 Stale Tool Detection

Since tools are mutable and agents reference them by name, a tool may change after an agent version was created. The UI should detect and surface this:

```typescript
interface StaleToolInfo {
  toolName: string;
  versionedHash: string; // hash at compile time (from toolSnapshot)
  currentHash: string; // current hash in project_tools
  isDeleted: boolean; // tool no longer exists
}

async function detectStaleTools(
  agentVersion: AgentVersion,
  tenantId: string,
  projectId: string,
): Promise<StaleToolInfo[]> {
  if (!agentVersion.toolSnapshot?.length) return [];

  // Batch query current state
  const names = agentVersion.toolSnapshot.map((s) => s.name);
  const currentTools = await ProjectTool.find({
    tenantId,
    projectId,
    name: { $in: names },
  });
  const currentMap = new Map(currentTools.map((t) => [t.name, t]));

  return agentVersion.toolSnapshot
    .map((snap) => {
      const current = currentMap.get(snap.name);
      if (!current) {
        return {
          toolName: snap.name,
          versionedHash: snap.sourceHash,
          currentHash: '',
          isDeleted: true,
        };
      }
      if (current.sourceHash !== snap.sourceHash) {
        return {
          toolName: snap.name,
          versionedHash: snap.sourceHash,
          currentHash: current.sourceHash,
          isDeleted: false,
        };
      }
      return null;
    })
    .filter(Boolean) as StaleToolInfo[];
}
```

**UI display**: On the agent detail page, show a banner:

```
⚠ Tools changed since version 1.0.0:
  • payments-api — modified (was abc123, now def456)
  • weather-mcp — deleted
  → Create new version to capture changes
```

### 12.5 Version Comparison

Compare tools between two agent versions using the frozen snapshots:

```typescript
interface ToolDiff {
  toolName: string;
  status: 'added' | 'removed' | 'modified' | 'unchanged';
  oldDsl?: string; // from version A's toolSnapshot
  newDsl?: string; // from version B's toolSnapshot
}

function compareToolSnapshots(versionA: AgentVersion, versionB: AgentVersion): ToolDiff[] {
  const snapA = new Map((versionA.toolSnapshot ?? []).map((s) => [s.name, s]));
  const snapB = new Map((versionB.toolSnapshot ?? []).map((s) => [s.name, s]));

  const allNames = new Set([...snapA.keys(), ...snapB.keys()]);
  return [...allNames].map((name) => {
    const a = snapA.get(name);
    const b = snapB.get(name);
    if (!a) return { toolName: name, status: 'added', newDsl: b!.dslSnapshot };
    if (!b) return { toolName: name, status: 'removed', oldDsl: a.dslSnapshot };
    if (a.sourceHash === b.sourceHash) return { toolName: name, status: 'unchanged' };
    return { toolName: name, status: 'modified', oldDsl: a.dslSnapshot, newDsl: b.dslSnapshot };
  });
}
```

### 12.6 Complete Versioning Flow

```
1. Author: Edit project_tools freely (mutable, no versioning overhead)
     ↓
2. Compile: Create agent version
     → Resolve FROM...USE imports → query project_tools
     → Compile everything → IR
     → Snapshot: freeze agent DSL + tool DSL + compiled IR
     → Status: draft
     ↓
3. Test: Promote version to testing/staged
     → Deploy to staging environment
     → Test with staging env vars and secrets
     ↓
4. Ship: Promote version to active
     → Deploy to production environment
     → Production secrets resolve at runtime
     ↓
5. Iterate: Edit project_tools again
     → Working copy (dev) sees changes immediately
     → Existing deployments unaffected (frozen IR)
     → Create new version when ready
     ↓
6. Rollback: Revert to previous version
     → Deployment switches agentVersionManifest
     → Previous version's frozen IR serves traffic
     → Tools at their original state (from snapshot)
```

**No tool versioning API, no draft/published lifecycle on tools, no version numbers on tools.** Tools are always "latest" in the working copy. Versioning is a property of the agent release, not of individual tools.

---

## 13. Tool Representation at Each Pipeline Stage

This section shows the **exact TypeScript types** from the codebase at each stage of the pipeline, so it's clear how tool data transforms from DSL text to runtime-executable IR.

### 13.1 Stage 1: DSL Text (What You Write)

```abl
charge(amount: number, currency: string) -> {txId: string}
  type: http
  endpoint: "{{env.STRIPE_URL}}/v1/charges"
  method: POST
  auth: bearer
  headers:
    Authorization: "Bearer {{secrets.STRIPE_KEY}}"
  retry: 2
  rate_limit: 60
```

Raw text. Stored in `project_tools.dslContent` or inline in `project_agents.dslContent`.

### 13.2 Stage 2: AST (After Parsing)

Source: `packages/core/src/types/agent-based.ts`

```typescript
// ─── Tool contract ───────────────────────────────────
interface AgentTool {
  name: string; // "charge"
  description?: string;
  parameters: ToolParam[]; // [{name:"amount", type:"number", required:true}, ...]
  returns: ToolReturn; // {type:"object", fields:{txId:{type:"string"}}}
  hints?: ToolHintsAST; // {cacheable, latency, side_effects, requires_auth}
  type?: ToolType; // "http" | "mcp" | "sandbox" | undefined
  httpBinding?: HttpBindingAST; // Present when type: http
  mcpBinding?: McpBindingAST; // Present when type: mcp
  sandboxBinding?: SandboxBindingAST; // Present when type: sandbox
}

// ─── HTTP binding (parsed, not yet compiled) ─────────
interface HttpBindingAST {
  endpoint: string; // "{{env.STRIPE_URL}}/v1/charges" — raw placeholder
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  auth?: ToolAuthType; // "bearer"
  timeout?: number;
  retry?: number; // 2 (just the count)
  retryDelay?: number; // separate field
  headers?: Record<string, string>; // {"Authorization": "Bearer {{secrets.STRIPE_KEY}}"}
  rateLimit?: number; // 60
  circuitBreaker?: { threshold: number; resetMs: number };
}

// ─── MCP binding (parsed) ────────────────────────────
interface McpBindingAST {
  server: string; // "weather-service" (name reference, not URL)
  tool?: string; // "get_current_weather" (defaults to tool name)
}

// ─── Sandbox binding (parsed) ────────────────────────
interface SandboxBindingAST {
  runtime: 'javascript' | 'python';
  entrypoint: string;
  timeout?: number;
  memoryMb?: number;
  // NEW (this design): codeContent?: string
}

// ─── Tool parameter ──────────────────────────────────
interface ToolParam {
  name: string; // "amount"
  type: string; // "number"
  required: boolean; // true
  default?: unknown;
  description?: string;
  validate?: string;
}

// ─── Tool return type ────────────────────────────────
interface ToolReturn {
  type: string; // "object"
  fields?: Record<string, ToolReturn>; // {txId: {type: "string"}}
  items?: ToolReturn; // For array returns
  optional?: boolean;
}
```

**Key**: At this stage, placeholders (`{{env.X}}`, `{{secrets.X}}`) are **raw strings** — not yet resolved. The AST is a faithful parse of the DSL text.

### 13.3 Stage 2b: Tool File AST (For `project_tools`)

Source: `packages/core/src/types/tool-file.ts`

```typescript
interface ToolFileDocument {
  defaults: ToolFileDefaults; // Shared base_url, auth, timeout, etc.
  tools: AgentTool[]; // Same AgentTool type as inline!
}

interface ToolFileDefaults {
  baseUrl?: string; // "{{env.STRIPE_URL}}"
  auth?: ToolAuthType; // "bearer"
  timeout?: number; // 10000
  retry?: number; // 2
  retryDelay?: number;
  rateLimit?: number;
  headers?: Record<string, string>;
}
```

**Key insight**: Tool files and inline tools produce the **same `AgentTool` type**. The parser doesn't care where the tool came from — same AST output. Defaults are merged into each tool during parsing.

### 13.4 Stage 2c: Agent Document (Full Parse Output)

Source: `packages/core/src/types/agent-based.ts`

```typescript
interface AgentBasedDocument {
  name: string; // "PaymentProcessor"
  mode: ExecutionMode; // "reasoning"
  tools: AgentTool[]; // Inline tool definitions (already parsed)
  toolImports?: ToolImport[]; // FROM...USE references (not yet resolved)
  toolLinks?: ToolLink[]; // USE TOOL: references (BEING DELETED)
  // ... identity, gather, flow, coordination, etc.
}

// FROM "payments-api" USE: charge, refund
interface ToolImport {
  source: string; // "payments-api"
  toolNames: string[]; // ["charge", "refund"]
}

// USE TOOL: slug@version AS alias (BEING DELETED)
interface ToolLink {
  slug: string;
  versionPin: string | null;
  alias: string | null;
}
```

### 13.5 Stage 3: IR (After Compilation)

Source: `packages/compiler/src/platform/ir/schema.ts`

```typescript
// ─── Compiled tool definition ────────────────────────
interface ToolDefinition {
  name: string; // "charge"
  description: string; // "Execute charge" (always present in IR)
  parameters: ToolParameter[]; // Same shape, but required defaults filled
  returns: ToolReturnType;
  hints: ToolHints; // ALWAYS present — defaults inferred by type
  system?: boolean; // true for __handoff__, __complete__, etc.
  tool_type?: 'http' | 'mcp' | 'sandbox';
  http_binding?: HttpBindingIR;
  mcp_binding?: McpBindingIR;
  sandbox_binding?: SandboxBindingIR;
}

// ─── Hints (always fully populated in IR) ────────────
interface ToolHints {
  cacheable: boolean; // false (default)
  latency: 'fast' | 'medium' | 'slow'; // 'slow' (inferred: HTTP)
  parallelizable: boolean; // false
  side_effects: boolean; // true (inferred: POST method)
  requires_auth: boolean; // true (inferred: auth: bearer)
  timeout?: number;
}

// ─── HTTP binding IR ─────────────────────────────────
interface HttpBindingIR {
  endpoint: string; // "{{env.STRIPE_URL}}/v1/charges" — STILL a placeholder!
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  auth: {
    type: ToolAuthTypeIR; // "bearer"
    config?: {
      // NEW (this design): from auth_config: block
      headerName?: string;
      headerPrefix?: string;
      oauth?: { tokenUrl: string; clientId: string; scopes: string[] };
      customHeaders?: Record<string, string>;
    };
  };
  timeout_ms?: number; // Note: renamed from AST's timeout → timeout_ms
  retry?: { count: number; delay_ms: number }; // Structured (AST had separate fields)
  rate_limit_per_minute?: number;
  circuit_breaker?: { threshold: number; reset_ms: number };
  headers?: Record<string, string>;
}

// ─── MCP binding IR (server config BAKED at compile) ─
interface McpBindingIR {
  server: string; // "weather-service"
  tool: string; // "get_current_weather"
  server_config?: {
    // BAKED from mcp_server_configs at compile time!
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    url?: string;
    encrypted_env?: string;
    encrypted_auth_config?: string;
    auth_type?: string;
    connection_timeout_ms?: number;
    request_timeout_ms?: number;
  };
}

// ─── Sandbox binding IR ──────────────────────────────
interface SandboxBindingIR {
  runtime: 'javascript' | 'python';
  entrypoint: string;
  timeout_ms?: number;
  memory_mb?: number;
  code_content?: string; // Code baked in at compile time
}
```

### 13.6 AST → IR Transformation (What the Compiler Does)

Source: `packages/compiler/src/platform/ir/compiler.ts`

```typescript
function compileTools(doc: AgentBasedDocument): ToolDefinition[] {
  return doc.tools.map((tool) => ({
    name: tool.name,
    description: tool.description || `Execute ${tool.name}`,
    parameters: tool.parameters.map((p) => ({
      name: p.name,
      type: p.type,
      description: p.description,
      required: p.required,
      default: p.default,
      validation: p.validate,
    })),
    returns: { type: tool.returns.type, fields: tool.returns.fields },
    hints: inferToolHints(tool), // ← AUTO-INFER from tool type
    tool_type: tool.type,
    http_binding: tool.httpBinding ? compileHttpBinding(tool.httpBinding) : undefined,
    mcp_binding: tool.mcpBinding ? compileMcpBinding(tool.mcpBinding, tool.name) : undefined,
    sandbox_binding: tool.sandboxBinding ? compileSandboxBinding(tool.sandboxBinding) : undefined,
  }));
}

// Key transformations AST → IR:
// 1. retry: 2, retry_delay: 1000  →  retry: { count: 2, delay_ms: 1000 }
// 2. timeout: 5000  →  timeout_ms: 5000
// 3. hints: inferred from type if not specified
// 4. description: defaults to "Execute {name}" if missing
// 5. MCP server_config: baked from mcp_server_configs DB at compile time
// 6. {{config.X}}: resolved at compile time
// 7. {{env.X}}, {{secrets.X}}: PRESERVED (resolved at runtime)
```

### 13.7 Transformation Summary Table

| Field             | DSL                                | AST (`AgentTool`)                        | IR (`ToolDefinition`)                                                             |
| ----------------- | ---------------------------------- | ---------------------------------------- | --------------------------------------------------------------------------------- |
| Name              | `charge(...)`                      | `name: "charge"`                         | `name: "charge"`                                                                  |
| Params            | `amount: number, currency: string` | `parameters: [{name, type, required}]`   | `parameters: [{name, type, required}]`                                            |
| Return            | `-> {txId: string}`                | `returns: {type, fields}`                | `returns: {type, fields}`                                                         |
| Type              | `type: http`                       | `type: "http"`                           | `tool_type: "http"`                                                               |
| Endpoint          | `endpoint: "{{env.X}}/v1"`         | `httpBinding.endpoint: "{{env.X}}/v1"`   | `http_binding.endpoint: "{{env.X}}/v1"`                                           |
| Method            | `method: POST`                     | `httpBinding.method: "POST"`             | `http_binding.method: "POST"`                                                     |
| Auth              | `auth: bearer`                     | `httpBinding.auth: "bearer"`             | `http_binding.auth.type: "bearer"`                                                |
| Retry             | `retry: 2` + `retry_delay: 1000`   | `httpBinding.retry: 2, retryDelay: 1000` | `http_binding.retry: {count:2, delay_ms:1000}`                                    |
| Rate limit        | `rate_limit: 60`                   | `httpBinding.rateLimit: 60`              | `http_binding.rate_limit_per_minute: 60`                                          |
| Hints             | (absent)                           | `hints: undefined`                       | `hints: {cacheable:false, latency:"slow", side_effects:true, requires_auth:true}` |
| Description       | `description: "..."`               | `description: "..."`                     | `description: "..."` (or default)                                                 |
| `{{env.X}}`       | Raw placeholder                    | Raw placeholder                          | **Raw placeholder** (resolved at runtime)                                         |
| `{{secrets.X}}`   | Raw placeholder                    | Raw placeholder                          | **Raw placeholder** (resolved at runtime)                                         |
| `{{config.X}}`    | Raw placeholder                    | Raw placeholder                          | **RESOLVED** (replaced at compile time)                                           |
| MCP server config | `server: "name"`                   | `mcpBinding.server: "name"`              | `mcp_binding.server_config: {url, auth, ...}` (baked)                             |
| Sandbox code      | `code: \|` block                   | `sandboxBinding.codeContent`             | `sandbox_binding.code_content` (baked)                                            |

### 13.8 What the DB-to-IR Bridge Used to Do (Being Deleted)

Source: `packages/shared/src/tools/convert-db-tool-to-ir.ts`

This function (`convertDbToolToIR`) currently converts `ITool` + `IToolVersion` → `ToolDefinition`:

```
DB: tools.slug + tool_versions.httpConfig  →  IR: ToolDefinition.http_binding
DB: tools.slug + tool_versions.mcpConfig   →  IR: ToolDefinition.mcp_binding
DB: tools.slug + tool_versions.sandboxConfig → IR: ToolDefinition.sandbox_binding
```

**In the DSL-native model, this function is deleted.** The parser produces `AgentTool` (AST) and the compiler produces `ToolDefinition` (IR) — no DB-to-IR bridge needed. The tool DSL goes through the same code path as inline tools.

```
Current:   DSL → AST → [resolveToolLinks() → DB → convertDbToolToIR()] → IR
                        ↑ this whole bridge is deleted

Proposed:  DSL → AST → [resolveToolImports() → DB(dslContent) → parseToolDsl() → AST] → IR
                        ↑ simpler: DB returns DSL text, reuses same parser
```

---

## 14. Arch AI Integration

The platform includes an AI-powered assistant called **Arch** (built into Studio) that helps users create and modify agents and tools. The DSL-native model significantly improves Arch's capabilities.

### 14.1 Current Arch Capabilities

Source: `apps/studio/src/lib/arch-tools.ts`, `apps/studio/src/lib/arch-workflow.ts`

| Tool                   | Purpose                                               |
| ---------------------- | ----------------------------------------------------- |
| `read_agent_dsl`       | Read any agent's DSL source                           |
| `list_project_agents`  | List all agents with metadata                         |
| `compile_abl`          | Validate + compile ABL syntax                         |
| `query_session_traces` | Read execution traces for debugging                   |
| `propose_modification` | Propose changes (user must confirm)                   |
| `modify_agent_abl`     | Apply section-level edits to ABL (after confirmation) |

**Workflow state machine** gates tool access:

```
idle → contextualizing → responding → confirming → executing → idle
```

- `responding`: read-only tools + `propose_modification`
- `executing`: `modify_agent_abl` (only after user confirms)

### 14.2 Current Limitation: AI Cannot Generate DB Tool References

When Arch generates agent DSL today, it can only create **inline tool definitions**. It cannot generate `USE TOOL: slug` because:

1. AI has no knowledge of which slugs exist in the project's DB
2. Even if it did, slugs are opaque — the AI can't see the tool's interface
3. Tool creation requires navigating a multi-step wizard UI, not DSL generation

**Result**: AI generates inline tools → users must manually convert to DB tools → dual system friction.

### 14.3 DSL-Native Unlocks Full AI Tool Generation

With `project_tools`, the AI can:

1. **Generate complete tool DSL** → save directly to `project_tools.dslContent`
2. **Generate `FROM...USE` imports** in agent DSL → referencing tools by name
3. **Read existing tool DSL** → understand the full interface and modify it
4. **Propose tool changes** → same workflow as agent DSL changes

### 14.4 New Arch Tools for DSL-Native

| New Tool             | Purpose                                  | Implementation                                     |
| -------------------- | ---------------------------------------- | -------------------------------------------------- |
| `read_tool_dsl`      | Read a `project_tools` record's DSL      | Query by name, return `dslContent`                 |
| `list_project_tools` | List tools with names, types, tool count | Query `project_tools`, return cached metadata      |
| `create_tool`        | Create a new `project_tools` record      | Generate DSL → save to DB                          |
| `modify_tool_dsl`    | Edit a `project_tools` record's DSL      | Parse → modify → save (same as `modify_agent_abl`) |

### 14.5 AI-Powered Tool Generation Flow

```
User: "I need a payment processing agent with Stripe integration"
  ↓
Arch AI (build workflow):

  1. Generate tool DSL:
     TOOLS:
       base_url: "{{env.STRIPE_URL}}"
       auth: bearer
       headers:
         Authorization: "Bearer {{secrets.STRIPE_KEY}}"

       charge(amount: number, currency: string) -> {txId: string, status: string}
         type: http
         endpoint: "/v1/charges"
         method: POST
         description: "Create a charge"

       refund(charge_id: string, amount?: number) -> {refundId: string}
         type: http
         endpoint: "/v1/refunds"
         method: POST
         description: "Refund a charge"

  → calls create_tool("stripe-api", dslContent)
  → saved to project_tools

  2. Generate agent DSL:
     AGENT: PaymentProcessor
     MODE: reasoning

     TOOLS:
       FROM "stripe-api" USE: charge, refund

       format_receipt(items: object[]) -> string
         description: "Format receipt for display"

     GOAL: Process payments for customers
     INSTRUCTIONS: |
       1. Validate payment details
       2. Process charge
       3. Format and return receipt

  → calls modify_agent_abl("PaymentProcessor", dslContent)
  → saved to project_agents

  3. Validate:
  → calls compile_abl("PaymentProcessor")
  → resolves FROM "stripe-api" → parses tool DSL → compiles to IR
  → returns: ✓ compiled successfully, 3 tools (charge, refund, format_receipt)
```

### 14.6 Context-Aware Tool Suggestions

The Arch store already provides section-aware suggestions. For tools:

| Context                 | Suggestions                                                                  |
| ----------------------- | ---------------------------------------------------------------------------- |
| Agent has no tools      | "Add tools from project", "Create new tool", "Import from MCP server"        |
| Agent has HTTP tools    | "Add error handling", "Configure retry/circuit breaker", "Add rate limiting" |
| Agent has MCP tools     | "Discover more tools from server", "Add fallback tools"                      |
| Tool has no auth        | "Add authentication", "Configure API key"                                    |
| Tool has no description | "Add description for better LLM tool selection"                              |

### 14.7 NL-to-ABL Generator

Source: `packages/nl-parser/src/generator.ts`

The platform also has a natural language → ABL generator that infers tools from descriptions:

```
Input: "I need a tool that searches for hotels by destination and dates"
  ↓
Output:
  search_hotels(destination: string, dates: string) -> {hotels: object[]}
    type: http
    endpoint: "{{env.HOTEL_API}}/search"
    method: POST
    description: "Search for hotels by destination and dates"
```

This generator can be enhanced to also generate `project_tools` records and `FROM...USE` imports.

---

## 15. Weighted Comparison Scorecard

### 15.1 Cross-Cutting Dimensions

| #   | Dimension                 | Weight      | Current (DB) | DSL-Native | Notes                                                                |
| --- | ------------------------- | ----------- | :----------: | :--------: | -------------------------------------------------------------------- |
| 1   | **AI Generation**         | High (3x)   |      2       |   **5**    | AI cannot generate `USE TOOL:` slugs; DSL is fully AI-generatable    |
| 2   | **Security & Compliance** | High (3x)   |      5       |   **5**    | Both use `{{secrets.X}}` — never in DSL. `tool_secrets` stays        |
| 3   | **Reusability**           | High (3x)   |      4       |   **5**    | `FROM...USE` + shared defaults > `USE TOOL:` with no defaults        |
| 4   | **Developer Experience**  | High (3x)   |      2       |   **5**    | One mental model, reviewable DSL, single editing surface             |
| 5   | **Maintainability**       | High (3x)   |      2       |   **5**    | ~2,500 lines vs ~22,700+ lines; 1 collection vs 3; net ~20K removal  |
| 6   | **MCP Discovery**         | Medium (2x) |      5       |   **5**    | Both auto-create from discovery; B writes DSL instead of DB entities |
| 7   | **Tool Testing**          | Medium (2x) |    **5**     |     4      | A has it built; B needs "test from DSL" panel (simpler architecture) |
| 8   | **Versioning**            | Medium (2x) |      4       |     4      | A: tool-level versions; B: agent-level snapshots (sufficient)        |
| 9   | **Non-Developer Users**   | Medium (2x) |    **5**     |     3      | A: built wizards; B: form overlay on DSL (needs build investment)    |
| 10  | **Migration Cost**        | Medium (2x) |    **5**     |     3      | A: zero; B: DB-to-DB migration (lower risk than filesystem)          |
| 11  | **Scalability**           | Low (1x)    |      4       |     4      | Both use DB; B has simpler queries                                   |
|     | **Weighted Total**        |             |   **3.4**    |  **4.4**   |                                                                      |

_(Weights: High=3x, Medium=2x, Low=1x. Scores 1-5.)_

### 15.2 Dimension Details

**AI Generation (2 vs 5)**: The Arch AI system can generate complete, compilable DSL for tools. With DB entities, AI generates inline tools but can't reference project tools via `USE TOOL:`. This is the strongest argument for DSL-native.

**Security & Compliance (5 vs 5)**: Both are fully PCI/SOC 2 compliant. Secrets never appear in DSL (`{{secrets.X}}` placeholders only). `tool_secrets` and `environment_variables` collections (encrypted, audited) stay unchanged in both approaches.

**Reusability (4 vs 5)**: `FROM...USE` imports with shared defaults (base_url, auth, timeout) > `USE TOOL:` with no shared defaults. Tool files are a natural unit of reuse. DB tools require per-tool config duplication.

**Developer Experience (2 vs 5)**: Currently developers must understand two systems (DSL + DB entities), two editing surfaces, and the resolution pipeline between them. DSL-native collapses to one system — what you see in DSL is what compiles.

**Maintainability (2 vs 5)**: 30+ UI components, 13+ API routes, 3 collections, `resolveToolLinks()` + `convertDbToolToIR()` pipeline → replaced by ~5 components, 4 routes, 1 collection. Net removal: ~20,000 lines (see §3.4 detailed inventory).

**Non-Developer Users (5 vs 3)**: This is the only dimension where DB entities score higher. The current wizards and forms are already built. DSL-native needs a form overlay that reads/writes DSL. Achievable but requires build investment.

---

## 16. Addressing Concerns

### "What about non-developer users who need form-based editing?"

Build a tool editor with a **form overlay**. The editor shows DSL (source of truth) with a side panel that presents structured form inputs for the currently selected tool (endpoint, method, auth, headers, etc.). Form changes write back to DSL via `formStateToDsl()`. This is simpler than the current system — one editor component with two views, instead of 30+ components managing DB entities with versioning. See Section 4 for detailed mockups.

### "What about MCP discovery?"

Discovery flow is preserved: discover tools from server → auto-generate tool DSL content → create a `project_tools` entry. The Studio UI shows the generated DSL and offers to save. The UX is identical — one-click discovery, auto-populated tools. The only difference is the storage format (DSL string in `project_tools.dslContent` vs structured DB entities). See Section 10.7 for implementation pattern.

### "What about independent tool testing?"

Build a lightweight **"Test Tool" panel** that: parses a tool definition from DSL text → resolves `{{env.X}}`/`{{secrets.X}}` via `SecretsProvider` → executes the tool → shows results. This is simpler than the current DB-backed testing because there's no entity lookup, no version resolution, no ID-based routing. See Section 4.7 for the mockup.

### "What about tool versioning?"

**Tools don't need independent versioning.** Agent versions (`agent_versions`) snapshot `dslContent` + `irContent` + `toolSnapshot` (including full DSL of each referenced tool). This captures the exact tool state at every publish point. For most enterprise teams, the agent version snapshot provides sufficient audit trail. See Section 12 for the complete versioning strategy.

### "What about the audit trail for SOC 2?"

Three layers of audit:

1. `project_tools.lastEditedBy` + `updatedAt` — who changed what, when
2. `agent_versions.toolSnapshot[].dslSnapshot` — full tool DSL frozen at each version
3. `tool_secrets` with `auditTrailPlugin` — all secret access/changes audited

For enhanced audit, add an optional `tool_audit_log` collection (see Section 5.1). This records each save with previous/new hash and changed tool names.

### "What about tool change impact across agents?"

When a tool changes, all importing agents are affected on next compile. The UI can show impact analysis:

```typescript
// Query: which agents import this tool?
const agents = await ProjectAgent.find({
  projectId,
  dslContent: { $regex: `FROM\\s+"${escapeRegex(toolName)}"` },
});
```

This is shown in the tool editor's save confirmation and in the delete confirmation dialog (see Section 10.8).

### "What about sandbox tools with large code blocks?"

The `code: |` multiline block supports any code size up to the `dslContent` max (512KB). For the Studio UI, the form mode shows a **split view** — config on the left, code editor on the right — providing the same editing experience as a dedicated IDE. See Section 4.5 for the mockup.

### "What about the migration risk?"

**Zero backward compatibility** — this is a clean break. No `USE TOOL:` support, no DB tool entities. The migration is a one-time DB-to-DB operation: export each DB tool as DSL → create `project_tools` entries → rewrite agent `dslContent` to use `FROM...USE` instead of `USE TOOL:`. Validate by compiling all agents and diffing IR output for equivalence.

### "What about cross-project tool sharing?"

Current limitation: `project_tools` is scoped to `(tenantId, projectId)`. Future enhancement: add `org_tools` collection scoped to `tenantId` only. Projects reference via `FROM "@org/payments-api" USE: charge`. Not needed for initial implementation.

---

## 17. Recommendation

### For enterprise multi-tenant platform with long-term maintainability:

**Adopt DSL-native tools with `project_tools` DB storage.**

**Why:**

1. **Single source of truth** — DSL is the only format, stored in DB, no sync issues
2. **AI-native** — AI generates complete, compilable DSL (critical for AI-powered agent building)
3. **~20,000 lines net removal** — massive reduction across UI (7,845), API (706), shared pipeline (3,249), DB models (1,675), and tests (8,436)
4. **2 collections deleted** (`tools`, `tool_versions`) — simpler DB schema
5. **Dual-mode editor** — serves both developers (DSL) and non-developers (Forms) from the same data
6. **All tool types fully expressible** — HTTP (with auth_config), Sandbox (with inline code), MCP (server reference)
7. **Secrets remain secure** — `{{secrets.X}}` / `{{env.X}}` placeholders, never stored in DSL
8. **MCP infrastructure stays** — `mcp_server_configs` is infrastructure, not tool definition
9. **Enterprise patterns preserved** — tenant isolation, project scoping, audit trail, access control
10. **No tool-level versioning** — agent versions snapshot tool state; simpler model, zero version sprawl
11. **Deployment-compatible** — tools baked into IR at compile time; fits existing deployment/environment/rollback pipeline with zero changes

**Parser additions needed:**

- `auth_config:` block (HTTP OAuth details)
- `code:` multiline block (Sandbox code)
- Both are straightforward additions to existing parser infrastructure

**UI investment:**

- Tool dual-mode editor (Form + DSL) — the main work item
- MCP discovery → DSL generator
- Test from DSL panel
- Stale tool detection banner on agent detail page
- Estimated: 2-3 weeks for full UI
