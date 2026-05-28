# HLD: MCP Support

**Feature**: MCP Support
**Status**: BETA
**Author**: Platform team
**Date**: 2026-03-22
**Feature Spec**: [docs/features/mcp-support.md](../features/mcp-support.md)
**Test Spec**: [docs/testing/mcp-support.md](../testing/mcp-support.md)

---

## 1. Problem Statement

Agent platforms need a first-class way to integrate with external tool ecosystems exposed through the Model Context Protocol (MCP). Without dedicated MCP support, project builders must handwrite runtime wiring for each remote MCP server, manage auth/encryption/SSRF concerns ad hoc, and lose the ability to discover and import remote tools into the standard project tool catalog.

MCP Support addresses this by making remote MCP servers a normal project capability: configurable in Studio, persisted securely with encrypted credentials, discoverable for tool import, and executable at runtime through the same tool pipeline used by HTTP, sandbox, and other tool types. The implementation provides two execution paths -- a primary DB-backed project-scoped path and a secondary inline compiled path -- both enforcing SSRF controls, tenant-scoped encryption, and resilience patterns.

---

## 2. Alternatives Considered

### Alternative A: Treat MCP as a Special Case of HTTP Tools

**Description**: Map MCP servers to HTTP tool endpoints with custom headers and JSON-RPC body formatting. No separate MCP infrastructure.

**Pros**:

- Reuses existing HTTP tool infrastructure completely
- No new database model, registry service, or provider layer
- Simpler codebase with fewer abstractions

**Cons**:

- Loses MCP protocol semantics (initialize/shutdown lifecycle, capabilities negotiation, tool listing)
- Cannot support MCP-specific features like resources, prompts, sampling, notifications, and schema drift detection
- HTTP tool executor lacks MCP-aware error handling (JSON-RPC error codes) and result normalization
- Discovery/import workflow impossible without MCP protocol support
- SSE transport not supported by HTTP tool executor
- No path to MCP protocol evolution (version negotiation, new capabilities)

**Effort**: S (minimal new code, significant semantic loss)

### Alternative B: External MCP Gateway Service

**Description**: Deploy a standalone MCP gateway microservice that manages connections and exposes a simplified REST API. Runtime and Studio interact with the gateway, not MCP servers directly.

**Pros**:

- Centralizes MCP connection management and pooling
- Reduces per-pod memory from persistent MCP connections
- Gateway can implement protocol upgrades independently
- Easier to monitor and rate-limit MCP traffic centrally

**Cons**:

- Adds a new service to deploy, monitor, and scale (operational overhead)
- Extra network hop adds latency to every MCP tool call
- Gateway becomes a single point of failure for all MCP operations
- Requires new auth/credential forwarding between gateway and callers
- Doesn't align with the platform's "stateless distributed" principle (gateway holds connection state)

**Effort**: XL (new service, deployment, monitoring, gateway protocol)

### Alternative C: Current Architecture (Recommended)

**Description**: Embed MCP client and server manager in the compiler package, with runtime providers that load configs from the shared registry and connect lazily. Studio uses ephemeral managers for discovery. Two execution paths: DB-backed persistent servers and inline compiled ephemeral servers.

**Pros**:

- Full MCP protocol support (lifecycle, capabilities, tools, resources, prompts, sampling)
- Discovery, preview, and import workflow built into Studio
- No additional microservice to deploy or operate
- Inline path enables ephemeral execution without database infrastructure
- Resilience built in at the executor level (circuit breaker, retry, timeout)
- Tenant and project isolation enforced throughout
- Aligns with existing tool pipeline architecture (same executor/middleware chain)

**Cons**:

- MCP connections are per-pod (no cross-pod connection sharing)
- Server manager holds in-memory state (mitigated by lazy loading and TTL-based refresh)
- Two execution paths (DB-backed vs inline) add implementation complexity

**Effort**: M (already implemented, ongoing maintenance)

**Recommendation**: Alternative C. The current architecture provides full MCP protocol support with minimal operational overhead, aligns with the platform's stateless-distributed principle through lazy loading and TTL-based refresh, and avoids the complexity of a separate gateway service. The two execution paths serve distinct use cases (Studio-managed projects vs. CI-driven/compiled agents) and share the same executor/middleware infrastructure.

---

## 3. Architecture Overview

### System Context

```
+------------------+     +-------------------+     +-------------------+
|    Studio UI     |     |   Runtime Engine   |     |  Remote MCP       |
|  (MCP Server     |     |  (Agent Execution) |     |  Servers          |
|   Management)    |     |                   |     |  (HTTP/SSE/stdio) |
+--------+---------+     +--------+----------+     +--------+----------+
         |                         |                          |
    Studio API              Tool Binding              MCP Protocol
    (Next.js routes)        Executor                  (JSON-RPC 2.0)
         |                         |                          |
+--------+---------+     +--------+----------+               |
|  Discovery       |     |  MCP Providers    |               |
|  Service         |     |  (Runtime/Inline) +---------------+
|  (ephemeral      |     |                   |
|   managers)      |     +--------+----------+
+--------+---------+              |
         |                +-------+--------+
+--------+---------+      |  MCPClient    |
|  Shared Layer    |      |  (compiler)   |
|  - Registry      |      |  - protocol   |
|  - Auth Resolver |      |  - transports |
|  - Repo CRUD     |      |  - resilience |
|  - Encryption    |      +-------+--------+
+--------+---------+              |
         |                        |
+--------+---------+     +--------+----------+
|    MongoDB       |     |  MCPServerManager |
|  mcp_server_     |     |  (compiler)       |
|  configs         |     |  - tenant pools   |
+------------------+     |  - tool agg       |
                         +-------------------+
```

### Package Responsibilities

| Package             | Responsibility                                                                                               |
| ------------------- | ------------------------------------------------------------------------------------------------------------ |
| `packages/compiler` | MCP protocol types, client implementation (stdio/SSE/HTTP), server manager, tool executor with resilience    |
| `packages/database` | Mongoose model for `mcp_server_configs` with encryption and tenant isolation plugins                         |
| `packages/shared`   | Repository CRUD/cascade, registry service (decrypt/filter/cache), auth resolver, type definitions            |
| `apps/runtime`      | Runtime MCP provider (DB-backed lazy loading), inline MCP provider (compiled ephemeral), tool binding wiring |
| `apps/studio`       | CRUD routes/UI, discovery service, connection testing, tool testing, Zustand store, API client               |

---

## 4. Data Model

### Primary Collection: `mcp_server_configs`

```
mcp_server_configs
├── _id: string (UUIDv7)
├── tenantId: string (required, indexed)
├── projectId: string (required, indexed)
├── name: string (required, unique per project+tenant)
├── description: string | null
├── transport: 'http' | 'sse'
├── url: string | null
├── encryptedEnv: string | null (AES-256-GCM)
├── authType: enum (none|bearer|api_key|custom_headers|oauth2_client_credentials)
├── encryptedAuthConfig: string | null (AES-256-GCM)
├── authProfileId: string | null (FK to auth_profiles)
├── priority: number (default 0)
├── tags: string | null (JSON array)
├── connectionTimeoutMs: number (default 30000)
├── requestTimeoutMs: number (default 30000)
├── autoReconnect: boolean (default true)
├── maxReconnectAttempts: number (default 3)
├── lastConnectionStatus: enum | null
├── lastConnectionAt: Date | null
├── lastConnectionLatencyMs: number | null
├── lastConnectionToolCount: number | null
├── lastConnectionError: string | null
├── createdBy: string | null
├── modifiedBy: string | null
└── _v: number (default 1)

Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } (unique)
  - { tenantId: 1, projectId: 1, priority: -1 }

Plugins:
  - tenantIsolationPlugin (enforces tenantId on all queries)
  - encryptionPlugin on ['encryptedEnv', 'encryptedAuthConfig']
```

### Relationship to `project_tools`

Imported MCP tools are stored as normal `project_tools` records with `toolType: 'mcp'`. The DSL content includes an `MCP_BINDING` section referencing the server name. The `mcp_binding.server` in the compiled IR stores the server's DB `_id`. Delete cascade removes project tools whose name matches the server's name prefix pattern.

### IR Schema: `McpBindingIR`

```typescript
interface McpBindingIR {
  server: string; // DB _id or inline server name
  tool: string; // Resolved MCP tool name
  headers?: Record<string, string>; // Per-call headers with {{secrets.X}} placeholders
  server_config?: {
    // Inline compiled config (zero DB lookups)
    name: string;
    transport: 'stdio' | 'sse' | 'http';
    command?: string;
    args?: string[];
    url?: string;
    encrypted_env?: string;
    connection_timeout_ms?: number;
    request_timeout_ms?: number;
    allowed_commands?: string[];
    auth_type?: string;
    encrypted_auth_config?: string;
  };
}
```

---

## 5. Component Design

### 5.1 MCP Client (`packages/compiler/src/platform/mcp/client.ts`)

The MCP client implements the full MCP specification with three transport types:

- **stdio**: Spawns a child process, communicates over stdin/stdout with line-delimited JSON-RPC
- **SSE**: Connects to an SSE endpoint, sends requests via HTTP POST, receives responses and notifications via SSE stream
- **HTTP**: Streamable HTTP transport using standard fetch requests

**Security controls**:

- Command allowlist for stdio (`npx`, `node`, `python`, `python3`, `uvx`, `docker`)
- Blocked env var set (`PATH`, `LD_PRELOAD`, `NODE_OPTIONS`, etc.)
- SSRF validation on SSE/HTTP URLs via `assertUrlSafeForSSRF`
- CRLF sanitization on all header values
- Max pending request limit
- Force-kill timeout for child processes
- Reconnect jitter to avoid thundering herd

**Audit hook**: `MCPAuditHook` callback for operation-level audit events (connect, disconnect, tool_call, resource_read, prompt_get, error).

### 5.2 MCP Server Manager (`packages/compiler/src/platform/mcp/server-manager.ts`)

Manages the lifecycle of multiple MCP server connections with tenant-scoped pools:

- **Registration**: `registerServer(config, tenantId?)` -- tenant-scoped or global
- **Connection**: `connectServer(name, tenantId?)` -- lazy, deduped, with error handling
- **Resolution**: Tenant-first, global fallback for tool lookup and execution
- **Aggregation**: `listAllTools(tenantId?)` aggregates tools across all visible servers, sorted by priority
- **Health**: `checkHealth(tenantId?)` and `reconnectUnhealthy(tenantId?)`

**Singleton access**: `getMCPServerManager()` provides a default singleton, with `resetMCPServerManager()` for testing.

### 5.3 MCP Tool Executor (`packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts`)

Dispatches MCP tool calls with resilience:

- **Circuit breaker**: Tenant-scoped keys, trips after 3 failures, auto-resets after 30s. Breaker map capped at 2000 entries with LRU eviction.
- **Retry**: Single retry for transient errors (ECONNRESET, ECONNREFUSED, ETIMEDOUT) with exponential backoff.
- **Timeout**: Configurable per-call, defaults to `DEFAULT_TOOL_TIMEOUT_MS`. Uses `Promise.race` with `setTimeout` cleanup.
- **Placeholder resolution**: `{{secrets.X}}` and `{{env.X}}` resolved in parallel via `SecretsProvider`.
- **Result normalization**: Mixed MCP content types (text, image, resource) normalized to structured output. Text content truncated at 100K chars.

### 5.4 Runtime MCP Provider (`apps/runtime/src/services/mcp/runtime-mcp-provider.ts`)

Bridges the runtime's tool executor with the compiler's `MCPServerManager`:

- Loads server configs from DB via `MCPServerRegistryService` per project
- Lazy initialization with 5-minute TTL and promise-based dedup
- Caps at 20 servers per project (DoS protection)
- Registers servers by DB `_id` for tool binding resolution
- Validates MCP bindings by checking connected servers and available tools
- Supports proxy resolution for HTTP/SSE transports
- Singleton pattern with `getRuntimeMcpProvider()`

### 5.5 Inline MCP Provider (`apps/runtime/src/services/mcp/inline-mcp-provider.ts`)

Handles compiled `server_config` tool bindings without database lookups:

- Reads config from `tool.mcp_binding.server_config` (baked at compile time)
- Creates `EphemeralMcpClient` per call: connect -> execute -> disconnect
- SSRF validation for SSE/HTTP URLs
- Command allowlist for stdio transport
- AES-256-GCM decryption of `encrypted_env` (CPU only, microseconds)
- Auth header resolution from `encrypted_auth_config`
- Proxy support via `ProxyResolver`

### 5.6 Shared Registry Service (`packages/shared/src/services/mcp-server-registry.ts`)

Loads and prepares MCP server configs for runtime consumption:

- Loads from `mcp_server_configs` via repository helpers
- Decrypts `encryptedEnv` and `encryptedAuthConfig` per tenant
- Auth-profile dual-read via `dualReadCredentials`
- Resolves auth headers via `resolveAuthHeaders`
- SSRF validation on server URLs
- TTL-based caching (60s, 500-entry cap with LRU eviction)
- Project ownership verification via injected verifier callback

### 5.7 Auth Resolver (`packages/shared/src/services/mcp-auth-resolver.ts`)

Pure function that resolves auth config to HTTP headers:

- **none**: Empty headers
- **bearer**: `Authorization: Bearer <token>`
- **api_key**: `<headerName>: <value>` (custom header name)
- **custom_headers**: Up to 20 custom key-value pairs
- **oauth2_client_credentials**: Token endpoint request with `client_id`/`client_secret`, cached with 60s pre-expiry refresh

Security: CRLF sanitization on all header names and values. HTTPS enforcement on OAuth2 token endpoints.

### 5.8 Studio Discovery Service (`apps/studio/src/services/mcp-discovery-service.ts`)

All Studio-facing MCP operations use short-lived `MCPServerManager` instances:

- **`discoverPreview`**: Connect, list tools, return preview without persisting
- **`discoverAndPersist`**: Connect, discover, persist selected tools as `project_tools` with DSL content
- **`testConnection`**: Open short-lived connection, report status/latency/tool count
- **`testMcpTool`**: Execute a single tool with given input through temporary connection
- **`listDiscoveredTools`**: Query `project_tools` by server name prefix pattern

Each operation uses `createTempManager()` with a unique scope (`studio:<uuid>`) and guaranteed cleanup in `finally` blocks.

### 5.9 Tool Binding Wiring (`apps/runtime/src/services/execution/llm-wiring.ts`)

The `wireToolExecutor` function creates the composite MCP provider:

1. Identifies `mcp` tools with `server_config` (inline candidates)
2. Creates `InlineMcpClientProvider` for inline tools
3. Creates `RuntimeMcpClientProvider` for DB-backed tools (if registry available)
4. Composites both: inline first, DB-backed fallback
5. Sets proxy resolver on both providers if configured
6. Passes composite provider to `ToolBindingExecutor`

---

## 6. 12 Architectural Concerns

### 6.1 Resource Isolation

- **Tenant**: `tenantIsolationPlugin` on `mcp_server_configs`. All registry queries include `tenantId`. Circuit breaker keys include `tenantId`.
- **Project**: Compound unique index `(tenantId, projectId, name)`. Route handlers verify `resource.projectId === req.params.projectId`. Runtime loads configs per project.
- **User**: `createdBy`/`modifiedBy` tracked. Project permissions gate Studio actions.
- **Cross-scope**: Returns 404 (not 403) for missing resources to avoid leaking existence.

### 6.2 Authentication & Authorization

- Studio routes use centralized auth middleware (`requireAuth` or project-scoped auth).
- No custom token verification in MCP code paths.
- Runtime auth is session-scoped; MCP server configs inherit project permissions.
- Auth resolver handles 5 auth modes for remote MCP server connections.

### 6.3 Encryption

- `encryptedEnv` and `encryptedAuthConfig` encrypted at rest via `encryptionPlugin` (AES-256-GCM).
- Decryption is tenant-scoped through `MCPDecryptor.decryptForTenant()`.
- Inline compiled `encrypted_env` is decrypted at call time (CPU only, PBKDF2 key cached 30min).
- No plaintext secrets stored in the database.

### 6.4 Performance

- **Caching**: Registry 60s TTL (500 entries), runtime init 5min TTL, OAuth2 tokens cached with 60s buffer (200 entries).
- **Lazy loading**: Runtime only connects servers required by the agent's tools.
- **Ephemeral connections**: Inline provider connect/execute/disconnect per call -- no persistent state.
- **Studio isolation**: Ephemeral managers prevent Studio discovery from polluting runtime singleton.
- **Batch operations**: Discovery import processes tools sequentially but could be parallelized for optimization.

### 6.5 Scalability

- **Per-project cap**: 20 MCP servers per project (DoS protection).
- **Per-server cap**: 500 tools per server in discovery.
- **Breaker map cap**: 2000 entries with LRU eviction.
- **Cache caps**: 500 registry entries, 200 OAuth2 tokens.
- **Result cap**: 100K characters per MCP tool result.
- **No cross-pod sharing**: Each pod maintains its own MCP connections. This is acceptable for current scale but could require connection pooling via a gateway at higher scale.

### 6.6 Observability

- Server records capture `lastConnectionStatus`, `lastConnectionLatencyMs`, `lastConnectionToolCount`, `lastConnectionError`.
- Runtime provider emits connect/getClient logs with serverId and projectId.
- MCP tool executor emits debug logs for call initiation, response latency, retry attempts, circuit breaker state.
- `MCPAuditEvent` interface defined for operation-level audit hooks.
- Discovery/import accumulates structured success/failure/schemaDrift/conflict results.
- Gap: No structured trace events integrated into the platform's `TraceStore` for MCP operations yet.

### 6.7 Error Handling

- Typed errors via `ToolExecutionError` with codes: `TOOL_NOT_FOUND`, `TOOL_MCP_SERVER_UNAVAILABLE`, `TOOL_CIRCUIT_OPEN`, `TOOL_TIMEOUT`, `TOOL_NETWORK_ERROR`, `TOOL_EXECUTION_ERROR`.
- MCP JSON-RPC errors mapped to standard error codes.
- Transient error classification for retry decisions.
- All error handlers use `err instanceof Error ? err.message : String(err)` pattern.
- No `.catch(() => {})` -- all errors logged or propagated.

### 6.8 Security

- **SSRF**: `assertUrlSafeForSSRF` validates server URLs and OAuth2 token endpoints. Blocks private/metadata IPs. Dev mode exceptions for localhost.
- **Header injection**: CRLF sanitization on all header names and values.
- **Command injection**: Stdio transport enforces command allowlist.
- **Env var injection**: Blocked env var set prevents PATH/LD_PRELOAD override.
- **HTTPS enforcement**: OAuth2 token endpoints must use HTTPS.
- **Max pending requests**: Client limits concurrent pending requests.
- **Force-kill**: Stdio child processes force-killed after timeout.

### 6.9 Compliance

- Encrypted at rest: env and auth blobs via `encryptionPlugin`.
- Tenant-scoped decryption: no cross-tenant credential access.
- Audit trail: `createdBy`/`modifiedBy` on server configs, `MCPAuditEvent` hook interface.
- Data minimization: connection status metadata has no TTL (could be improved).
- No PII stored in MCP server configs (only connection metadata and encrypted credentials).

### 6.10 Distributed Systems

- No pod-local state as truth: server configs in MongoDB, connection status persisted.
- In-memory state: MCP connections and caches are per-pod with TTL refresh.
- No distributed locks needed: connection dedup uses per-pod promise-based dedup.
- Singleton managers are per-process, not shared across pods.
- Reconnect jitter prevents thundering herd on server restarts.

### 6.11 Testing

- Unit coverage across all four layers (compiler, shared, runtime, studio).
- 10+ test files with dedicated MCP focus.
- Primary gap: no live MCP server E2E test (see test spec for detailed plan).
- Secondary gap: no auth-profile-backed full-chain integration test.
- Test infrastructure needed: live HTTP MCP fixture server with configurable behavior.

### 6.12 Maintainability

- Clear package boundaries: compiler owns protocol/client/executor, shared owns registry/auth/repo, runtime owns providers, studio owns UI/discovery.
- MCP protocol version negotiation supports forward compatibility (`MCP_SUPPORTED_VERSIONS`).
- Inline and DB-backed paths share the same executor/middleware chain.
- Typed interfaces throughout (`McpClientProvider`, `McpClient`, `MCPServerConfig`).
- Singleton patterns with reset functions for testability.

---

## 7. API Design

### Studio API (Next.js Route Handlers)

All routes are project-scoped: `/api/projects/:id/mcp-servers/...`

| Method | Path                                            | Request Body                         | Response                                       | Auth    |
| ------ | ----------------------------------------------- | ------------------------------------ | ---------------------------------------------- | ------- |
| GET    | `/mcp-servers`                                  | --                                   | `{ success, servers: McpServer[] }`            | Project |
| POST   | `/mcp-servers`                                  | `CreateMcpServerPayload`             | `{ success, server: McpServer }`               | Project |
| GET    | `/mcp-servers/:serverId`                        | --                                   | `{ success, server: McpServer }`               | Project |
| PUT    | `/mcp-servers/:serverId`                        | `Partial<CreateMcpServerPayload>`    | `{ success, server: McpServer }`               | Project |
| DELETE | `/mcp-servers/:serverId`                        | --                                   | `{ success: true }`                            | Project |
| POST   | `/mcp-servers/:serverId/test-connection`        | `{}`                                 | `{ success, result: TestConnectionResult }`    | Project |
| GET    | `/mcp-servers/:serverId/tools`                  | --                                   | `{ success, tools: ServerTool[] }`             | Project |
| POST   | `/mcp-servers/:serverId/tools/discover/preview` | `{}`                                 | `{ success, tools, totalDiscovered }`          | Project |
| POST   | `/mcp-servers/:serverId/tools/discover`         | `{ toolNames?: string[] }`           | `{ success, successful, failed, schemaDrift }` | Project |
| POST   | `/mcp-servers/:serverId/tools/:toolName/test`   | `{ input: Record<string, unknown> }` | `{ success, output, latencyMs, error? }`       | Project |

### Internal Interfaces

```typescript
// McpClientProvider -- implemented by both RuntimeMcpClientProvider and InlineMcpClientProvider
interface McpClientProvider {
  getClient(serverName: string, projectId?: string): Promise<McpClient | undefined>;
}

// McpClient -- minimal interface for tool execution
interface McpClient {
  callTool(toolName: string, params: Record<string, unknown>): Promise<unknown>;
}
```

---

## 8. Sequence Diagrams

### Discovery and Import Flow

```
Studio UI          Studio API           Discovery Service       MCPServerManager      Remote MCP Server
   |                   |                       |                       |                       |
   |--POST discover--->|                       |                       |                       |
   |                   |--discoverPreview()---->|                       |                       |
   |                   |                       |--createTempManager()-->|                       |
   |                   |                       |    registerServer()    |                       |
   |                   |                       |    connectServer()     |                       |
   |                   |                       |                       |---initialize---------->|
   |                   |                       |                       |<--capabilities---------|
   |                   |                       |    listAllTools()      |                       |
   |                   |                       |                       |---tools/list---------->|
   |                   |                       |                       |<--tool definitions-----|
   |                   |                       |<--tools[]-------------|                       |
   |                   |                       |    disconnectServer()  |                       |
   |                   |                       |                       |---shutdown------------>|
   |                   |<--preview result-------|                       |                       |
   |<--tools preview---|                       |                       |                       |
   |                   |                       |                       |                       |
   |--POST import----->|                       |                       |                       |
   |                   |--discoverAndPersist()->|                       |                       |
   |                   |                       |  [connect + discover]  |                       |
   |                   |                       |  [persist to project_tools]                    |
   |                   |<--import result--------|                       |                       |
   |<--import result---|                       |                       |                       |
```

### Runtime Tool Execution Flow

```
Agent Session     ToolBindingExecutor    McpToolExecutor     McpClientProvider      MCPClient        Remote MCP
     |                   |                    |                    |                    |                 |
     |--callTool()------>|                    |                    |                    |                 |
     |                   |--execute()-------->|                    |                    |                 |
     |                   |                    |--checkCircuitBreaker()                  |                 |
     |                   |                    |--resolveParams()   |                    |                 |
     |                   |                    |--getClient()------>|                    |                 |
     |                   |                    |                    |  [inline: create ephemeral client]   |
     |                   |                    |                    |  [DB: lookup from manager]           |
     |                   |                    |<--McpClient--------|                    |                 |
     |                   |                    |--callTool()------->|                    |                 |
     |                   |                    |                    |                    |--tools/call----->|
     |                   |                    |                    |                    |<--result---------|
     |                   |                    |<--raw result-------|                    |                 |
     |                   |                    |--normalizeMcpResult()                   |                 |
     |                   |                    |--recordSuccess()   |                    |                 |
     |                   |<--normalized result|                    |                    |                 |
     |<--tool result-----|                    |                    |                    |                 |
```

---

## 9. Security Design

### Threat Model

| Threat                          | Mitigation                                                              |
| ------------------------------- | ----------------------------------------------------------------------- |
| SSRF via MCP server URL         | `assertUrlSafeForSSRF` blocks private/metadata IPs before connection    |
| SSRF via OAuth2 token endpoint  | HTTPS enforcement + URL validation on token endpoints                   |
| Header injection via auth       | CRLF sanitization on all header names and values                        |
| Command injection via stdio     | Command allowlist (`npx`, `node`, `python`, `python3`, `uvx`, `docker`) |
| Env var injection via stdio     | Blocked env var set (`PATH`, `LD_PRELOAD`, `NODE_OPTIONS`, etc.)        |
| Credential leakage at rest      | AES-256-GCM encryption via `encryptionPlugin` on env and auth blobs     |
| Cross-tenant credential access  | Tenant-scoped decryption via `MCPDecryptor.decryptForTenant()`          |
| Cross-project server access     | Compound index + route-level project ownership verification             |
| DoS via excessive servers       | 20 servers per project cap, 500 tools per server cap                    |
| DoS via large MCP results       | 100K character result cap with truncation notice                        |
| Thundering herd on reconnect    | Jitter added to reconnect delays                                        |
| Runaway child processes (stdio) | Force-kill timeout after configurable period                            |

### Auth Flow for MCP Server Connections

```
1. Server config stored with encryptedEnv + encryptedAuthConfig
2. At load time (registry or inline):
   a. Decrypt env vars: AES-256-GCM with tenant-scoped key
   b. Resolve auth headers: bearer/api_key/custom_headers → static headers
                           oauth2_client_credentials → token endpoint request → cached token
   c. Validate URLs for SSRF safety
3. At connection time:
   a. Auth headers passed to MCP client constructor
   b. Client includes headers in all HTTP requests to MCP server
   c. Env vars passed as environment to stdio child process
```

---

## 10. Migration & Rollout

### Current State

MCP Support is in BETA status with the following implementation complete:

- Full CRUD, discovery, import, and testing in Studio
- Both runtime providers (DB-backed and inline)
- All 5 auth modes implemented and tested
- Circuit breaker, retry, timeout, result capping
- SSRF validation, CRLF sanitization, command allowlists

### Path to STABLE

1. **E2E Test Coverage**: Add live MCP server fixture and E2E test suite (test spec GAP-001)
2. **Auth-Profile Integration**: Complete integration testing for auth-profile-backed MCP configs (GAP-003)
3. **Observability**: Integrate MCP operations into platform `TraceStore` for unified tracing
4. **Documentation**: Finalize user-facing documentation for MCP server setup in Studio

### Backward Compatibility

- No breaking changes expected. The feature is additive.
- Inline compiled `server_config` bindings are backward-compatible with the existing tool pipeline.
- Protocol version negotiation (`MCP_SUPPORTED_VERSIONS`) ensures forward compatibility with MCP spec updates.

---

## 11. Open Architectural Questions

1. **Connection pooling at scale**: Should a shared MCP gateway or connection pool be introduced when per-pod connections become a scalability concern?
2. **Resource/Prompt promotion**: Should MCP resources and prompts be promoted to first-class project entities alongside tools?
3. **Bidirectional MCP**: Should the platform expose its own capabilities as an MCP server for interoperability?
4. **Event-driven refresh**: Should the platform subscribe to MCP `notifications/tools/list_changed` events for automatic tool catalog refresh?
5. **Stdio in Studio**: Should Studio manage `stdio` MCP servers directly, or keep it as a runtime/CLI-only path?

---

## 12. Decision Log

| #   | Decision                                                                       | Rationale                                                                                        | Date       |
| --- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ | ---------- |
| D1  | Embed MCP client/manager in `packages/compiler` rather than standalone package | Compiler already owns tool execution abstractions; keeps MCP close to tool IR and executor       | 2026-03-01 |
| D2  | Two execution paths (DB-backed + inline) rather than one                       | Studio-managed projects need DB persistence; CI/compiled agents need zero-DB ephemeral execution | 2026-03-01 |
| D3  | Studio discovery uses ephemeral managers, not runtime singleton                | Prevents Studio test/discovery from corrupting runtime connection state                          | 2026-03-05 |
| D4  | Register servers by DB `_id` rather than human-readable name                   | Avoids name collision ambiguity; `_id` is guaranteed unique per project                          | 2026-03-10 |
| D5  | Import MCP tools as `project_tools` records with DSL content                   | Keeps downstream agent/tool UX consistent; no special-case handling for MCP tools                | 2026-03-05 |
| D6  | Circuit breaker keys include tenantId                                          | Prevents one tenant's failing server from tripping breakers for other tenants                    | 2026-03-15 |
| D7  | Cap MCP tool results at 100K characters                                        | Prevents LLM context overflow and memory pressure from large MCP responses                       | 2026-03-15 |
| D8  | Auth-profile dual-read for MCP env vars                                        | Supports migration from inline encrypted env to centralized auth profiles                        | 2026-03-17 |
