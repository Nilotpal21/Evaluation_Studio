# Feature: MCP Support

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `project lifecycle`, `agent lifecycle`, `integrations`, `admin operations`, `enterprise`
**Package(s)**: `packages/compiler`, `packages/shared`, `packages/database`, `apps/runtime`, `apps/studio`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/mcp-support.md](../testing/mcp-support.md)
**Last Updated**: 2026-03-22

---

## 1. Introduction / Overview

### Problem Statement

Agent platforms need to integrate with external tool ecosystems exposed through the Model Context Protocol (MCP). Without first-class MCP support, project builders would need to handwrite runtime wiring for each remote MCP server, manage auth/encryption/SSRF concerns ad hoc, and lose the ability to discover and import remote tools into the standard project tool catalog. This fragments the tool ecosystem and makes remote MCP connectivity a second-class citizen relative to HTTP and sandbox tool types.

### Goal Statement

MCP Support makes remote MCP servers a first-class project capability: configurable in Studio, persisted securely with encrypted credentials, discoverable for tool import, and executable at runtime through the same tool pipeline used by HTTP, sandbox, and other tool types. The feature provides two execution paths -- a primary DB-backed project-scoped path and a secondary inline compiled path -- both enforcing SSRF controls, CRLF sanitization, and tenant-scoped encryption.

### Summary

MCP Support is the platform's first-class integration for Model Context Protocol servers. It lets projects register remote MCP servers (HTTP/SSE transport), test connectivity, discover tools exposed by those servers, import selected tools into the standard `project_tools` catalog, and execute them at runtime through the shared tool pipeline.

The implementation splits responsibilities across five packages:

- **`packages/compiler`**: MCP protocol types (`protocol.ts`), client implementation (`client.ts`), server manager (`server-manager.ts`), and MCP tool executor (`mcp-tool-executor.ts`) with circuit breaker resilience.
- **`packages/database`**: Mongoose model for `mcp_server_configs` with tenant isolation plugin, encryption plugin on `encryptedEnv`/`encryptedAuthConfig`, and compound indexes.
- **`packages/shared`**: Repository CRUD (`mcp-server-config-repo.ts`), registry service with TTL caching (`mcp-server-registry.ts`), auth header resolver with OAuth2 token caching (`mcp-auth-resolver.ts`), and MCP type definitions.
- **`apps/runtime`**: `RuntimeMcpClientProvider` for DB-backed project-scoped lazy loading and `InlineMcpClientProvider` for compiled `server_config` ephemeral execution, both wired through the `ToolBindingExecutor`.
- **`apps/studio`**: Full CRUD UI, connection testing, discovery preview/import, per-tool testing, Zustand store (`mcp-server-store.ts`), API client (`mcp-servers.ts`), and discovery service (`mcp-discovery-service.ts`).

### Key Capabilities

- Project-scoped MCP server registry backed by `mcp_server_configs` collection
- Studio CRUD with connection test, discovery preview, selective tool import, and per-tool testing
- Runtime lazy-loading and connection of only the MCP servers required by a project or tool set
- Five auth modes: `none`, `bearer`, `api_key`, `custom_headers`, `oauth2_client_credentials`
- Tenant-scoped encryption of server env vars and auth config blobs
- SSRF validation for server URLs and OAuth token endpoints
- CRLF sanitization on all auth header values to prevent header injection
- Cascade delete of imported project tools when an MCP server is removed
- Inline runtime provider for compiled `server_config` tool bindings with ephemeral per-call connections
- Circuit breaker resilience with tenant-scoped breaker keys on the MCP tool executor
- Result normalization and size capping (100K chars) for MCP tool responses
- Proxy support for HTTP/SSE transports through undici `ProxyAgent`
- Command allowlist (`npx`, `node`, `python`, `python3`, `uvx`, `docker`) for stdio transport security
- Blocked env var override protection (`PATH`, `LD_PRELOAD`, `NODE_OPTIONS`, etc.)

---

## 2. Scope

### Goals

- Allow projects to register, configure, test, discover, and import remote MCP tools through Studio.
- Reuse shared persistence, auth resolution, SSRF validation, encryption, and runtime provider logic for MCP-backed execution.
- Support both stored project-scoped MCP servers and inline compiled `server_config` execution paths.
- Provide circuit breaker and retry resilience for MCP tool calls to handle transient failures.
- Maintain full tenant and project isolation across all MCP operations.

### Non-Goals (Out of Scope)

- Tenant-global MCP server library or admin-only registry (servers are project-scoped only).
- Continuous synchronization of imported tool definitions after discovery; re-import remains manual.
- First-class Studio management for `stdio` MCP servers (only `http`/`sse` in Studio; `stdio` is inline-only).
- MCP resource or prompt primitives as first-class project entities (tools only).
- Bidirectional MCP: the platform acts as MCP client only, not as MCP server exposing its own tools.

---

## 3. User Stories

1. As a **project builder**, I want to register a remote MCP server with its URL and credentials in Studio so that I can safely import tools from it into my project.
2. As a **project builder**, I want to test my MCP server connection before importing tools so that I can verify connectivity and see available tools.
3. As a **project builder**, I want to preview discovered tools and selectively import only the ones I need so that my project tool catalog stays focused.
4. As a **agent developer**, I want imported MCP tools to execute through the normal runtime tool pipeline so that channel behavior, tracing, and guardrails stay consistent.
5. As a **platform engineer**, I want shared SSRF, auth, and encryption controls around MCP connectivity so that remote servers do not bypass existing safety boundaries.
6. As a **agent developer**, I want MCP tools with inline compiled `server_config` to execute without database lookups so that ephemeral or CI-driven agents work without DB infrastructure.
7. As a **operations engineer**, I want MCP tool calls to have circuit breaker protection so that a failing remote server does not cascade into agent execution failures.

---

## 4. Functional Requirements

1. **FR-1**: The system must persist project-scoped MCP server configurations in `mcp_server_configs` with encrypted env and auth blobs, enforced by `tenantIsolationPlugin` and `encryptionPlugin`.
2. **FR-2**: Studio must provide CRUD operations for MCP servers including create, read, update, delete with cascade deletion of imported project tools.
3. **FR-3**: Studio must support connection testing that opens a short-lived MCP connection, reports tool count/latency, and persists connection status to the server record.
4. **FR-4**: Studio must support discovery preview (list remote tools without persisting) and discovery import (persist selected tools as `project_tools` records with DSL content).
5. **FR-5**: Studio must support per-tool testing that executes a single MCP tool with given input through a temporary connection.
6. **FR-6**: The runtime must lazily load only the MCP servers required by a project's tools via `RuntimeMcpClientProvider` and resolve a client per `mcp_binding.server` reference.
7. **FR-7**: The runtime must support inline compiled `server_config` execution via `InlineMcpClientProvider` with ephemeral connect-execute-disconnect semantics.
8. **FR-8**: The system must support five auth modes (`none`, `bearer`, `api_key`, `custom_headers`, `oauth2_client_credentials`) with CRLF-sanitized header values and cached OAuth2 tokens.
9. **FR-9**: The system must validate all MCP server URLs for SSRF safety before connection attempts, blocking private/metadata IP ranges (with dev-mode exceptions).
10. **FR-10**: The MCP tool executor must implement circuit breaker protection with tenant-scoped breaker keys, single retry for transient errors, configurable timeout, and result size capping at 100K characters.
11. **FR-11**: The compiler must produce `mcp_binding` IR from the DSL `mcpBinding` AST, resolving the tool name to the definition name when not explicitly specified.
12. **FR-12**: The system must support auth-profile-backed credential resolution through dual-read semantics (`dualReadCredentials`) for MCP server env vars.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                                                    |
| -------------------------- | ------------ | -------------------------------------------------------------------------------------------------------- |
| Project lifecycle          | PRIMARY      | MCP servers are registered, managed, and scoped per project.                                             |
| Agent lifecycle            | SECONDARY    | Imported MCP tools participate in normal agent tool execution.                                           |
| Customer experience        | NONE         | MCP is a builder/runtime capability rather than a direct customer-facing surface.                        |
| Integrations / channels    | PRIMARY      | MCP connects the platform to remote MCP servers and imported tools remain channel-neutral.               |
| Observability / tracing    | SECONDARY    | Connection status, latency, and runtime access logs matter for operating MCP-backed tools.               |
| Governance / controls      | SECONDARY    | SSRF validation, encrypted config, and auth resolution are central control points.                       |
| Enterprise / compliance    | SECONDARY    | Remote network access, auth profile integration, and server governance matter in enterprise deployments. |
| Admin / operator workflows | SECONDARY    | Operators use Studio project tooling rather than a global admin registry.                                |

### Related Feature Integration Matrix

| Related Feature                         | Relationship Type         | Why It Matters                                                               | Key Touchpoints                                       | Current State                        |
| --------------------------------------- | ------------------------- | ---------------------------------------------------------------------------- | ----------------------------------------------------- | ------------------------------------ |
| [Tool Invocations](tool-invocations.md) | depends on                | Imported MCP tools execute through the shared tool pipeline.                 | `mcp_binding`, runtime providers, executor flow       | Active integration path              |
| [Auth Profiles](auth-profiles.md)       | configured by             | MCP auth can be sourced through auth profiles in dual-read resolution paths. | auth resolver, encrypted config, `authProfileId`      | Supported in shared/runtime services |
| [Channels](channels.md)                 | channel-neutral execution | Once imported, MCP tools execute the same way across channel entry points.   | runtime tool execution                                | Indirect but important integration   |
| [ABL Language](abl-language.md)         | compiled by               | MCP tool DSL compiles through the standard ABL pipeline to produce IR.       | `mcpBinding` AST, `compileMcpBinding`, `McpBindingIR` | Active compilation path              |

---

## 6. Design Considerations (Optional)

- MCP server management lives in the Tools area of Studio rather than in a completely separate configuration domain, maintaining a unified tool experience.
- Discovery, preview, and per-tool testing use short-lived `MCPServerManager` instances so Studio workflows do not share runtime singleton state.
- Imported MCP tools are persisted as normal `project_tools` records with DSL content generated via `serializeToolFormToDsl`, keeping downstream agent/tool UX consistent.
- The MCP client supports both SSE (Server-Sent Events) and HTTP (streamable) transports, with SSE being the legacy MCP transport and HTTP being the newer streamable HTTP transport.

---

## 7. Technical Considerations (Optional)

- **Dual execution paths**: The primary path is DB-backed and project-scoped via `RuntimeMcpClientProvider`, while the inline path via `InlineMcpClientProvider` supports compiled `server_config` payloads for ephemeral per-call execution without database lookups.
- **Security layers**: SSRF controls (`assertUrlSafeForSSRF`), CRLF-sanitized auth headers, command allowlists for stdio, blocked env var overrides, and HTTPS enforcement on OAuth2 token endpoints.
- **Caching strategy**: Registry caches configs for 60s with 500-entry cap. Runtime memoizes project initialization for 5 min. OAuth2 tokens cached with 60s pre-expiry refresh buffer (200-entry cap).
- **Resilience**: Circuit breakers trip after 3 failures with 30s reset. Single retry for transient errors (ECONNRESET, ECONNREFUSED, ETIMEDOUT) with exponential backoff. Configurable per-call timeout defaults to `DEFAULT_TOOL_TIMEOUT_MS`.
- **Protocol support**: Full MCP specification coverage including `initialize`, `tools/list`, `tools/call`, `resources/list`, `resources/read`, `prompts/list`, `prompts/get`, `sampling/createMessage`, and all notification types. Protocol version `2024-11-05`.
- **Tool drift**: Imports do not auto-refresh when remote MCP schemas change. Schema drift is detected on re-import via `sourceHash` comparison.
- **Connection limits**: Runtime caps at 20 MCP servers per project. Studio caps at 500 tools per server during discovery.

---

## 8. How to Consume

### Studio UI

MCP servers are managed from the Tools area of Studio:

- **MCP Servers list page**: `McpServersListPage` shows registered servers with DataTable columns for name, transport, status, endpoint, tools count, and last tested time.
- **Server create dialog**: `McpServerCreateDialog` provides server registration with name, transport, URL, auth configuration, and optional env vars.
- **Server detail page**: `McpServerDetailPage` provides configuration editing, connection testing, discovery preview, bulk import, single-tool import, and imported tool cleanup.
- **Tool config form**: `McpConfigForm` renders MCP-specific configuration when creating/editing MCP tools, including server reference and transport settings.
- **Dedicated store + client**: `useMcpServerStore` and `apps/studio/src/api/mcp-servers.ts` keep the UI synchronized with CRUD and discovery operations.

### API (Runtime)

There is no standalone public runtime CRUD API for MCP servers. MCP support is consumed indirectly when a runtime session executes an `mcp` tool that references a stored or inline server binding.

### API (Studio)

| Method | Path                                                             | Purpose                                                        |
| ------ | ---------------------------------------------------------------- | -------------------------------------------------------------- |
| GET    | `/api/projects/:id/mcp-servers`                                  | List project MCP server configs                                |
| POST   | `/api/projects/:id/mcp-servers`                                  | Create a server config                                         |
| GET    | `/api/projects/:id/mcp-servers/:serverId`                        | Get one server config                                          |
| PUT    | `/api/projects/:id/mcp-servers/:serverId`                        | Update a server config                                         |
| DELETE | `/api/projects/:id/mcp-servers/:serverId`                        | Delete a server and cascade imported tools                     |
| POST   | `/api/projects/:id/mcp-servers/:serverId/test-connection`        | Open a short-lived MCP connection and report tool availability |
| GET    | `/api/projects/:id/mcp-servers/:serverId/tools`                  | List already imported MCP-backed project tools                 |
| POST   | `/api/projects/:id/mcp-servers/:serverId/tools/discover/preview` | Preview tools exposed by the remote MCP server                 |
| POST   | `/api/projects/:id/mcp-servers/:serverId/tools/discover`         | Discover and persist project tools from the server             |
| POST   | `/api/projects/:id/mcp-servers/:serverId/tools/:toolName/test`   | Test one remote MCP tool via Studio                            |

### Admin Portal

No separate admin portal is wired for MCP server management. Access is project-scoped and permissioned through Studio route handlers.

### Channel Integration

MCP tools are channel-neutral. Once a tool has been imported into `project_tools` and bound to an agent, runtime execution is identical across digital chat, voice, SDK, and A2A channels because the tool pipeline resolves the same `mcp_binding` regardless of channel origin.

---

## 9. Data Model

### Collections / Tables

```text
Collection: mcp_server_configs
Fields:
  - _id: string (UUID v7)
  - tenantId: string (required)
  - projectId: string (required)
  - name: string (required, unique per project+tenant)
  - description: string | null
  - transport: 'http' | 'sse'
  - url: string | null
  - encryptedEnv: string | null (AES-256-GCM encrypted JSON object)
  - authType: 'none' | 'bearer' | 'api_key' | 'custom_headers' | 'oauth2_client_credentials'
  - encryptedAuthConfig: string | null (AES-256-GCM encrypted auth config)
  - authProfileId: string | null (reference to auth_profiles collection)
  - priority: number (default 0, higher = preferred for tool resolution)
  - tags: string | null (JSON array, parsed at load time)
  - connectionTimeoutMs: number (default 30000)
  - requestTimeoutMs: number (default 30000)
  - autoReconnect: boolean (default true)
  - maxReconnectAttempts: number (default 3)
  - lastConnectionStatus: 'connected' | 'failed' | 'untested' | null
  - lastConnectionAt: Date | null
  - lastConnectionLatencyMs: number | null
  - lastConnectionToolCount: number | null
  - lastConnectionError: string | null
  - createdBy: string | null
  - modifiedBy: string | null
  - _v: number (default 1)
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } (unique)
  - { tenantId: 1, projectId: 1, priority: -1 }
Plugins:
  - tenantIsolationPlugin
  - encryptionPlugin on ['encryptedEnv', 'encryptedAuthConfig']
```

```text
Collection: project_tools
Relationship:
  - Imported MCP tools are stored as normal project tools with toolType='mcp'
  - DSL content includes MCP binding referencing the server name
  - Binding points back to the server via mcp_binding.server (DB _id)
  - Delete cascade removes MCP project tools that reference the server's name prefix
```

### Key Relationships

- `mcp_server_configs` is the source of truth for remote server connectivity and discovery metadata.
- Imported MCP tools live in `project_tools`, not in a separate MCP tool collection.
- The runtime provider resolves a server by database `_id` (stored in `mcp_binding.server`), while Studio discovery/import preserves the human-readable server name in tool DSL slug generation via `mcpSlug(serverName, toolName)`.
- Auth profiles are optionally linked via `authProfileId` and resolved through `dualReadCredentials` at registry load time.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                                       | Purpose                                                                             |
| -------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `packages/compiler/src/platform/mcp/protocol.ts`                           | Full MCP protocol type definitions (JSON-RPC, tools, resources, prompts, sampling)  |
| `packages/compiler/src/platform/mcp/client.ts`                             | MCP client with stdio/SSE/HTTP transports, security controls, audit hooks           |
| `packages/compiler/src/platform/mcp/server-manager.ts`                     | Multi-server manager with tenant-scoped pools, tool aggregation, health monitoring  |
| `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts` | MCP tool execution with circuit breaker, retry, timeout, result normalization       |
| `packages/database/src/models/mcp-server-config.model.ts`                  | Mongoose schema with encryption/tenant plugins and compound indexes                 |
| `packages/shared/src/repos/mcp-server-config-repo.ts`                      | CRUD helpers plus delete cascade into project tools                                 |
| `packages/shared/src/services/mcp-server-registry.ts`                      | Loads/decrypts/validates server configs per project with 60s TTL caching            |
| `packages/shared/src/services/mcp-auth-resolver.ts`                        | Resolves auth headers with CRLF sanitization and OAuth2 client-credential caching   |
| `packages/shared/src/types/mcp-server.ts`                                  | Normalized and API response types for MCP server configs                            |
| `apps/runtime/src/services/mcp/runtime-mcp-provider.ts`                    | Runtime lazy-loading provider for DB-backed MCP servers with 5min init TTL          |
| `apps/runtime/src/services/mcp/inline-mcp-provider.ts`                     | Ephemeral provider for compiled inline `server_config` tool bindings                |
| `apps/studio/src/services/mcp-discovery-service.ts`                        | Short-lived manager for discovery, import, per-tool testing, and status persistence |

### Routes / Handlers

| File                                                                                           | Purpose                                      |
| ---------------------------------------------------------------------------------------------- | -------------------------------------------- |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/route.ts`                                   | List + create server configs                 |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/route.ts`                        | Get/update/delete a single server            |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/test-connection/route.ts`        | Test remote server connectivity              |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/tools/route.ts`                  | List already imported tools for the server   |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/tools/discover/preview/route.ts` | Preview tools from remote MCP server         |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/tools/discover/route.ts`         | Import discovered tools into `project_tools` |
| `apps/studio/src/app/api/projects/[id]/mcp-servers/[serverId]/tools/[toolName]/test/route.ts`  | Test a single remote tool                    |

### UI Components

| File                                                               | Purpose                                               |
| ------------------------------------------------------------------ | ----------------------------------------------------- |
| `apps/studio/src/components/mcp-servers/McpServersListPage.tsx`    | DataTable list of all project MCP servers             |
| `apps/studio/src/components/mcp-servers/McpServerCreateDialog.tsx` | Server registration and edit dialog                   |
| `apps/studio/src/components/mcp-servers/McpServerCard.tsx`         | Summary card for each project server                  |
| `apps/studio/src/components/mcp-servers/McpServerDetailPage.tsx`   | Main detail page for configuration + import workflows |
| `apps/studio/src/components/mcp-servers/McpServerStatusBadge.tsx`  | Transport and connection status badges                |
| `apps/studio/src/components/tools/McpConfigForm.tsx`               | MCP-specific config form for tool create/edit         |
| `apps/studio/src/components/tools/wizard/McpToolWizard.tsx`        | MCP tool creation wizard                              |
| `apps/studio/src/store/mcp-server-store.ts`                        | Zustand store for CRUD, discovery, and testing state  |
| `apps/studio/src/api/mcp-servers.ts`                               | Typed client for all MCP server APIs                  |

### Tests

| File                                                                     | Type | Coverage Focus                                        |
| ------------------------------------------------------------------------ | ---- | ----------------------------------------------------- |
| `packages/compiler/src/__tests__/mcp-client.test.ts`                     | unit | MCP client protocol, transports, security             |
| `packages/compiler/src/__tests__/constructs/mcp-tool-executor.test.ts`   | unit | Circuit breaker, retry, timeout, result normalization |
| `packages/compiler/src/__tests__/constructs/mcp-tool-result-cap.test.ts` | unit | Result size capping and truncation                    |
| `packages/shared/src/__tests__/mcp-server-registry.test.ts`              | unit | Registry decryption, filtering, caching               |
| `packages/shared/src/__tests__/mcp-auth-resolver.test.ts`                | unit | Auth header construction and OAuth2 token caching     |
| `packages/shared/src/__tests__/mcp-server-config-repo.test.ts`           | unit | CRUD helpers and delete cascade semantics             |
| `apps/runtime/src/__tests__/runtime-mcp-provider.test.ts`                | unit | Lazy project initialization and client lookup         |
| `apps/runtime/src/__tests__/inline-mcp-provider.test.ts`                 | unit | Inline transport/auth/env and SSRF enforcement        |
| `apps/studio/src/__tests__/api-mcp-routes.test.ts`                       | unit | Route-level validation and response behavior          |
| `apps/studio/src/__tests__/api-mcp-client.test.ts`                       | unit | Typed client request/response contracts               |
| `apps/studio/src/__tests__/mcp-discovery-service.test.ts`                | unit | Discovery preview/import/test behavior                |
| `apps/studio/src/__tests__/mcp-server-response.test.ts`                  | unit | Response shaping and normalization                    |

---

## 11. Configuration

### Environment Variables

| Variable                | Default       | Description                                                             |
| ----------------------- | ------------- | ----------------------------------------------------------------------- |
| `NODE_ENV`              | `development` | Controls dev SSRF allowances such as localhost/private-range exceptions |
| `encryption_master_key` | (none)        | Master key for AES-256-GCM encryption of env/auth blobs                 |

### Runtime Configuration

- `MCPServerRegistryService` caches configs for 60 seconds and caps the cache at 500 project entries.
- `RuntimeMcpClientProvider` caps connections to 20 registered servers per project and memoizes project initialization for 5 minutes.
- `resolveAuthHeaders()` caps custom headers at 20 entries and refreshes OAuth2 client-credential tokens 60 seconds before expiry with a 200-entry token cache.
- Studio CRUD permits `http` and `sse` transports. Inline runtime execution also handles `stdio` when the binding was compiled with `server_config`.
- MCP tool executor uses a circuit breaker with threshold=3 and reset=30s, and caps the breaker map at 2000 entries with eviction.
- MCP tool results are truncated at `MAX_MCP_RESULT_CHARS` (100,000 characters).

### DSL / Agent IR

Imported MCP tools resolve through `mcp_binding` metadata in the IR:

```json
{
  "tool_type": "mcp",
  "name": "search_docs",
  "mcp_binding": {
    "server": "srv_123",
    "tool": "searchDocs"
  }
}
```

Inline compiled tools can additionally include baked server config:

```json
{
  "tool_type": "mcp",
  "mcp_binding": {
    "server": "srv_inline",
    "tool": "searchDocs",
    "server_config": {
      "name": "docs-server",
      "transport": "http",
      "url": "https://example.com/mcp",
      "encrypted_env": "...",
      "connection_timeout_ms": 30000,
      "request_timeout_ms": 30000,
      "auth_type": "bearer",
      "encrypted_auth_config": "..."
    }
  }
}
```

---

## 12. Runtime Integration

### Lifecycle

1. Studio stores an MCP server config in `mcp_server_configs` with encrypted env/auth blobs.
2. Studio discovery opens a short-lived `MCPServerManager`, connects to the server, lists tools, and optionally imports selected tools into `project_tools` with generated DSL content.
3. When a runtime session needs an MCP tool, `llm-wiring.ts` (`wireToolExecutor`) checks for inline `server_config` first.
4. For inline tools, `InlineMcpClientProvider` creates ephemeral connections per call (SSRF-validated, CRLF-sanitized, env-decrypted).
5. For DB-backed tools, `RuntimeMcpClientProvider` asks `MCPServerRegistryService` for the project's configs, validates/decrypts them, registers relevant servers with `MCPServerManager`, and connects them lazily.
6. The `ToolBindingExecutor` composites both providers: inline first, DB-backed fallback.
7. `McpToolExecutor` handles the actual call with circuit breaker, timeout, retry, placeholder resolution, and result normalization.

### Dependencies

- `@abl/compiler` MCP server manager and client abstractions
- Shared encryption service for env/auth decryption
- Shared auth-profile services for dual-read credential resolution
- SSRF validation utilities (`@agent-platform/shared-kernel/security`)
- Optional proxy resolution through `ProxyResolver` interface
- Project tool repo for import/update/delete cascades

### Event Flow

- Connection test and discovery update `lastConnectionStatus`, latency, error, and discovered tool counts on `mcp_server_configs`.
- Runtime access logs emit MCP connect and `getClient` events with server ID and project ID.
- MCP tool executor emits debug logs for call initiation, response latency, and circuit breaker state changes.
- Once a tool call begins, tracing and execution behavior follow the shared tool invocations pipeline.

---

## 13. Delivery Plan / Work Breakdown

1. Strengthen end-to-end MCP confidence
   1.1 Add a live HTTP or SSE MCP server fixture that proves Studio create/import and runtime execution together.
   1.2 Add negative-path coverage for SSRF-blocked URLs and rejected OAuth2 token endpoints.
   1.3 Add multi-tool discovery and selective import E2E scenario.
2. Tighten platform ergonomics
   2.1 Decide whether Studio should expose a first-class `stdio` management path or keep it inline-only.
   2.2 Improve drift handling for imported tools so schema changes are easier to surface and reconcile.
   2.3 Add stale tool detection and notification when remote schemas have changed.
3. Harden repository/runtime boundaries
   3.1 Remove optional `projectId` behaviors that rely on route-layer compensation.
   3.2 Expand auth-profile-backed integration coverage across discovery and runtime execution.
   3.3 Add structured audit logging for MCP connection lifecycle events.

---

## 14. Success Metrics

| Metric                 | Baseline                                                          | Target                                                                          | How Measured                                           |
| ---------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| MCP project onboarding | Project-scoped CRUD, test, and import flows exist                 | Teams can register and validate MCP servers without custom runtime wiring       | Studio CRUD/discovery usage and support/debug outcomes |
| Runtime MCP confidence | Provider/unit coverage is good but end-to-end coverage is partial | Live server create -> import -> execute flow is directly covered in CI          | Automated MCP E2E test suite pass rate                 |
| Shared MCP reuse       | Imported tools already execute through the shared tool pipeline   | MCP remains a first-class tool type without bespoke execution paths per feature | Runtime/provider and tool-pipeline reuse audit         |
| Auth mode coverage     | All 5 auth modes implemented with unit tests                      | All 5 auth modes exercised in integration tests with real headers               | Auth resolver integration test matrix                  |

---

## 15. Open Questions

1. Should Studio eventually support `stdio` MCP management directly, or should that remain an inline/runtime-only path?
2. Should imported MCP tools gain drift detection or auto-refresh behavior instead of relying on manual rediscovery?
3. How far should auth-profile-backed MCP configuration be pushed as the default model versus inline encrypted auth blobs?
4. Should the platform support MCP resource and prompt primitives as first-class project entities beyond tools?
5. Should the platform expose its own tools as an MCP server for interoperability with external MCP clients?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                     | Severity | Status |
| ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Studio CRUD only supports `http` and `sse`; there is no first-class Studio UI for `stdio` MCP servers even though the inline runtime provider can execute them. | Medium   | Open   |
| GAP-002 | No true end-to-end test exercises a live MCP server through Studio create/import and runtime agent execution.                                                   | High     | Open   |
| GAP-003 | Repository helpers still accept optional `projectId` for some update/delete paths; route handlers compensate with explicit project ownership checks.            | Medium   | Open   |
| GAP-004 | Tool drift is not continuously synchronized after import; users must re-run discovery/import to refresh changed remote schemas.                                 | Low      | Open   |
| GAP-005 | MCP resources and prompts are supported at the protocol level but not exposed as first-class project entities in Studio or runtime.                             | Low      | Open   |
| GAP-006 | No structured audit logging for MCP connection lifecycle events beyond runtime debug logs.                                                                      | Medium   | Open   |

---

## 17. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                     |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | MCP server configs are scoped per `(tenantId, projectId)` with unique compound index. Route handlers verify project ownership.                |
| Tenant isolation  | `tenantIsolationPlugin` enforces tenantId on all queries. Decrypted auth/env blobs are tenant-scoped. Circuit breaker keys include tenant ID. |
| User isolation    | Project permissions gate Studio actions. `createdBy`/`modifiedBy` track ownership. No separate per-user MCP registry.                         |

### Performance

- Short-lived registry caching (60s TTL, 500-entry cap) prevents repeated DB reads during a session.
- Runtime only connects the subset of servers required by a project's tools (lazy loading with 5min TTL).
- Studio discovery uses ephemeral manager instances so test/discovery work does not pollute the runtime singleton.
- Inline provider avoids persistent MCP connections -- connect/execute/disconnect per call.
- OAuth2 token cache prevents repeated token requests (200-entry cap, 60s pre-expiry refresh).

### Security

- All stored env and auth blobs are encrypted at rest via `encryptionPlugin` with AES-256-GCM.
- URLs and OAuth token endpoints pass SSRF validation (`assertUrlSafeForSSRF`) before use.
- Header values are CRLF-sanitized before request dispatch to prevent header injection.
- Stdio transport enforces command allowlist (`npx`, `node`, `python`, `python3`, `uvx`, `docker`).
- Blocked env var set prevents override of security-sensitive variables (`PATH`, `LD_PRELOAD`, `NODE_OPTIONS`, etc.).
- OAuth2 token endpoints must use HTTPS.
- Project ownership is rechecked before any CRUD or discovery action.

### Scalability

- Config caching and project initialization TTL reduce repeated startup work across requests.
- Runtime caps per-project server count at 20 to prevent denial-of-service through over-registration.
- Circuit breaker map capped at 2000 entries with LRU eviction.
- Studio caps tool discovery at 500 tools per server.
- Inline provider avoids persistent MCP connections for long-lived sessions.

### Observability

- Server records capture `lastConnectionStatus`, `lastConnectionLatencyMs`, `lastConnectionToolCount`, and `lastConnectionError`.
- Runtime MCP provider emits connect/getClient logs with serverId and projectId.
- MCP tool executor emits debug logs for call initiation, response latency, retry attempts, and circuit breaker state.
- Discovery/import paths accumulate structured success/failure/schemaDrift/conflict results for the UI.
- `MCPAuditEvent` interface defined for operation-level audit hooks (connect, disconnect, tool_call, resource_read, prompt_get, error).

---

## 18. Testing & Validation

### E2E Test Scenarios

| #   | Scenario                                                                  | Status | Test File                                                 |
| --- | ------------------------------------------------------------------------- | ------ | --------------------------------------------------------- |
| 1   | Project-scoped MCP CRUD routes enforce auth and shape responses correctly | PASS   | `apps/studio/src/__tests__/api-mcp-routes.test.ts`        |
| 2   | Runtime resolves and connects DB-backed project servers lazily            | PASS   | `apps/runtime/src/__tests__/runtime-mcp-provider.test.ts` |
| 3   | Inline compiled MCP bindings execute through ephemeral client setup       | PASS   | `apps/runtime/src/__tests__/inline-mcp-provider.test.ts`  |

### Integration Test Scenarios

| #   | Scenario                                                                            | Status | Test File                                                                                                   |
| --- | ----------------------------------------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| 1   | Registry service decrypts, filters, and caches project configs                      | PASS   | `packages/shared/src/__tests__/mcp-server-registry.test.ts`                                                 |
| 2   | Auth resolver covers bearer, API key, custom headers, and OAuth2 client credentials | PASS   | `packages/shared/src/__tests__/mcp-auth-resolver.test.ts`                                                   |
| 3   | Repository CRUD + delete cascade maintain server/tool relationships                 | PASS   | `packages/shared/src/__tests__/mcp-server-config-repo.test.ts`                                              |
| 4   | Studio discovery service previews, imports, and tests remote tools                  | PASS   | `apps/studio/src/__tests__/mcp-discovery-service.test.ts`                                                   |
| 5   | Studio API client and response formatters stay aligned with route handlers          | PASS   | `apps/studio/src/__tests__/api-mcp-client.test.ts`, `apps/studio/src/__tests__/mcp-server-response.test.ts` |
| 6   | MCP tool executor handles circuit breaker, retry, timeout, and result capping       | PASS   | `packages/compiler/src/__tests__/constructs/mcp-tool-executor.test.ts`                                      |
| 7   | MCP client protocol and transport behavior                                          | PASS   | `packages/compiler/src/__tests__/mcp-client.test.ts`                                                        |

### Unit Test Coverage

| Package             | Tests                                               | Passing           |
| ------------------- | --------------------------------------------------- | ----------------- |
| `packages/compiler` | MCP client, tool executor, result cap               | Inventory present |
| `packages/shared`   | Registry, auth resolver, repository, type coverage  | Inventory present |
| `apps/runtime`      | Runtime provider and inline provider coverage       | Inventory present |
| `apps/studio`       | Route, client, discovery, response, config coverage | Inventory present |

> Full testing details: [docs/testing/mcp-support.md](../testing/mcp-support.md)

---

## 19. References

- MCP Specification: https://modelcontextprotocol.io/specification
- Protocol version: `2024-11-05` (with `2024-10-07` backward compatibility)
- Related features: [Tool Invocations](tool-invocations.md), [Auth Profiles](auth-profiles.md), [ABL Language](abl-language.md)
- Source inventories: `packages/compiler/src/platform/mcp/`, `apps/studio/src/components/mcp-servers/`, `apps/runtime/src/services/mcp/`
