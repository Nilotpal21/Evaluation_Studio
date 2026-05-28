# LLD + Implementation Plan: MCP Support

**Feature**: MCP Support
**Status**: BETA (progressing toward STABLE)
**Date**: 2026-03-22
**Feature Spec**: [docs/features/mcp-support.md](../features/mcp-support.md)
**Test Spec**: [docs/testing/mcp-support.md](../testing/mcp-support.md)
**HLD**: [docs/specs/mcp-support.hld.md](../specs/mcp-support.hld.md)

---

## Executive Summary

MCP Support is a BETA feature with comprehensive implementation across five packages (compiler, database, shared, runtime, studio). The core infrastructure -- protocol types, client, server manager, tool executor, providers, registry, auth resolver, Studio CRUD/discovery -- is complete and unit-tested. This implementation plan defines three phases to reach STABLE status by closing E2E test gaps, strengthening auth-profile integration, and adding observability.

---

## Phase 1: E2E Test Foundation (P0)

**Goal**: Establish a live MCP server fixture and E2E test suite that proves the full Studio create -> import -> runtime execute flow.

**Duration**: 3-5 days

### 1.1 Build Live MCP HTTP Fixture Server

**File**: `packages/compiler/src/__tests__/fixtures/mcp-http-fixture-server.ts`

Create a lightweight HTTP MCP server that:

- Implements MCP protocol version `2024-11-05`
- Exposes 3+ tools with known schemas and deterministic outputs:
  - `echo` -- returns its input as output
  - `add` -- adds two numbers
  - `failing_tool` -- always returns an error (for negative testing)
- Supports configurable behavior:
  - `requireAuth: boolean` -- reject requests without expected auth header
  - `failCount: number` -- fail the first N calls (for circuit breaker testing)
  - `slowMs: number` -- add delay to responses (for timeout testing)
  - `toolSchemaVersion: number` -- change schema between calls (for drift testing)
- Starts on random port (`{ port: 0 }`) for parallel test safety
- Returns received headers in tool response metadata (for auth forwarding verification)
- Implements `initialize`, `tools/list`, `tools/call`, and `shutdown` methods

**Implementation details**:

```typescript
// Skeleton structure
export interface McpFixtureConfig {
  requireAuth?: { headerName: string; headerValue: string };
  failCount?: number;
  slowMs?: number;
  resultSizeChars?: number;
}

export async function startMcpFixtureServer(config?: McpFixtureConfig): Promise<{
  url: string;
  port: number;
  close: () => Promise<void>;
  resetFailCount: () => void;
}>;
```

**Exit criteria**:

- [ ] Fixture server starts, handles initialize/tools/list/tools/call/shutdown
- [ ] All 3 built-in tools return deterministic results
- [ ] Auth, fail, slow, and schema version modes work correctly
- [ ] Server cleanup is guaranteed (no port leaks in tests)

### 1.2 E2E: Studio Create -> Discover -> Import -> Runtime Execute

**File**: `apps/runtime/src/__tests__/e2e/mcp-live-server.e2e.test.ts`

Test scenario:

1. Start MCP fixture server on random port
2. Create `mcp_server_configs` record in test DB with fixture URL
3. Load server config via `MCPServerRegistryService`
4. Register and connect via `RuntimeMcpClientProvider`
5. Execute `echo` tool through `McpToolExecutor` with sample input
6. Verify output matches expected deterministic result
7. Execute `add` tool and verify numeric result
8. Disconnect and verify cleanup

**Exit criteria**:

- [ ] Test passes with real MongoDB (MongoMemoryServer) and real MCP fixture server
- [ ] No mocks of MCP boundary -- real JSON-RPC over HTTP
- [ ] Test file does not import Mongoose models directly (API-only interaction pattern)

### 1.3 E2E: Auth Header Forwarding

**File**: `apps/runtime/src/__tests__/e2e/mcp-auth-forwarding.e2e.test.ts`

Test scenario:

1. Start MCP fixture server with `requireAuth: { headerName: 'Authorization', headerValue: 'Bearer test-token-123' }`
2. Create server config with `authType: 'bearer'` and encrypted auth config
3. Load, connect, and execute a tool
4. Verify the fixture server received the correct `Authorization` header
5. Repeat with `api_key` auth type and custom header name

**Exit criteria**:

- [ ] Bearer auth headers forwarded correctly
- [ ] API key auth headers forwarded with correct custom header name
- [ ] Auth failure (wrong token) returns error, not success

### 1.4 E2E: SSRF Rejection

**File**: `apps/runtime/src/__tests__/e2e/mcp-ssrf-rejection.e2e.test.ts`

Test scenario:

1. Attempt to create/load server config with `url: 'http://169.254.169.254/'`
2. Verify SSRF validation rejects before connection attempt
3. Repeat with `http://10.0.0.1/`, `http://[::1]/`, `http://localhost:0/` (if not in dev mode)

**Exit criteria**:

- [ ] All private/metadata IPs rejected by SSRF validator
- [ ] No actual network connection attempted for blocked URLs
- [ ] Error messages are descriptive but do not leak internal network topology

### 1.5 E2E: Delete Cascade

**File**: `apps/runtime/src/__tests__/e2e/mcp-delete-cascade.e2e.test.ts`

Test scenario:

1. Create MCP server config in test DB
2. Import 3 tools into `project_tools` (using discovery service or direct repo)
3. Verify 3 tools exist in `project_tools`
4. Delete the MCP server via repository helper
5. Verify all 3 associated tools are removed from `project_tools`

**Exit criteria**:

- [ ] Delete cascade removes exactly the tools associated with the deleted server
- [ ] Other project tools are not affected
- [ ] Cascade handles edge cases (no associated tools, already-deleted tools)

---

## Phase 2: Resilience and Auth-Profile Integration (P1)

**Goal**: Validate circuit breaker behavior, auth-profile-backed MCP configs, and schema drift detection.

**Duration**: 2-3 days

### 2.1 E2E: Circuit Breaker Trip and Recovery

**File**: `apps/runtime/src/__tests__/e2e/mcp-circuit-breaker.e2e.test.ts`

Test scenario:

1. Start MCP fixture server with `failCount: 3`
2. Create and connect MCP server
3. Execute tool -- expect failure (attempt 1 of 3)
4. Execute tool -- expect failure (attempt 2 of 3)
5. Execute tool -- expect failure (attempt 3 of 3, breaker trips)
6. Execute tool -- expect `TOOL_CIRCUIT_OPEN` error (no network call)
7. Reset fixture server failures, wait for breaker reset period (30s or override)
8. Execute tool -- expect success (breaker closed)

**Exit criteria**:

- [ ] Circuit breaker opens after configured threshold failures
- [ ] Subsequent calls fail fast with `TOOL_CIRCUIT_OPEN`
- [ ] Breaker resets after configured period and allows calls again
- [ ] Tenant-scoped breaker keys prevent cross-tenant interference

### 2.2 Integration: Auth-Profile-Backed MCP Server

**File**: `packages/shared/src/__tests__/mcp-auth-profile-integration.test.ts`

Test scenario:

1. Create an auth profile with encrypted secrets (env vars for MCP server)
2. Create MCP server config with `authProfileId` pointing to the auth profile
3. Load config via `MCPServerRegistryService`
4. Verify env vars resolved from auth profile (not from `encryptedEnv`)
5. Verify auth headers resolved from auth profile secrets
6. Test dual-read fallback: when auth profile is disabled, falls back to `encryptedEnv`

**Exit criteria**:

- [ ] Auth profile env vars correctly override inline `encryptedEnv`
- [ ] Dual-read fallback works when auth profile is disabled or not found
- [ ] Tenant isolation maintained through auth profile resolution

### 2.3 Integration: Schema Drift Detection

**File**: `apps/studio/src/__tests__/mcp-schema-drift.integration.test.ts`

Test scenario:

1. Start MCP fixture server with `toolSchemaVersion: 1`
2. Import tools via discovery service
3. Record `sourceHash` of imported tools
4. Change fixture server to `toolSchemaVersion: 2` (add a parameter to `echo` tool)
5. Re-run `discoverAndPersist`
6. Verify `schemaDrift` entries returned for changed tools
7. Verify tool `dslContent` and `sourceHash` updated in `project_tools`

**Exit criteria**:

- [ ] Schema drift correctly detected via `sourceHash` comparison
- [ ] Changed tools updated in `project_tools` with new DSL content
- [ ] Unchanged tools not unnecessarily updated

### 2.4 E2E: Selective Tool Import

**File**: `apps/studio/src/__tests__/mcp-selective-import.e2e.test.ts`

Test scenario:

1. Start MCP fixture server exposing 3 tools
2. Preview discovery -- verify 3 tools returned
3. Import only 2 tools by name via `toolNames` filter
4. Verify exactly 2 tools persisted in `project_tools`
5. Verify the non-imported tool is not in `project_tools`

**Exit criteria**:

- [ ] Selective import respects `toolNames` filter
- [ ] Only specified tools persisted
- [ ] Discovery total count reflects all available tools

---

## Phase 3: Observability and Polish (P2)

**Goal**: Integrate MCP operations into platform tracing, add structured audit logging, and address remaining gaps.

**Duration**: 2-3 days

### 3.1 TraceStore Integration for MCP Operations

**Files**:

- `packages/compiler/src/platform/constructs/executors/mcp-tool-executor.ts` (modify)
- `apps/runtime/src/services/mcp/runtime-mcp-provider.ts` (modify)

Add `TraceEvent` emission for MCP operations:

- `mcp.server.connect` -- server connection established
- `mcp.server.disconnect` -- server disconnected
- `mcp.tool.call` -- tool call initiated (with server, tool, and project context)
- `mcp.tool.result` -- tool call completed (with latency and result size)
- `mcp.tool.error` -- tool call failed (with error code and retryable flag)
- `mcp.circuit_breaker.open` -- circuit breaker tripped
- `mcp.circuit_breaker.close` -- circuit breaker recovered

**Exit criteria**:

- [ ] MCP operations appear in the platform's trace timeline
- [ ] Trace events include serverId, projectId, tenantId, toolName, latencyMs
- [ ] Circuit breaker state changes are traceable

### 3.2 Structured Audit Logging

**Files**:

- `apps/runtime/src/services/mcp/runtime-mcp-provider.ts` (modify)
- `apps/studio/src/services/mcp-discovery-service.ts` (modify)

Replace ad-hoc `log.info('MCP server access', ...)` with structured `MCPAuditEvent` emission:

- Wire the `MCPAuditHook` callback from `MCPClient` config
- Emit audit events for: connect, disconnect, tool_call, discovery, import, delete
- Include tenantId, projectId, serverId, userId, timestamp, success/failure, durationMs

**Exit criteria**:

- [ ] All MCP operations emit structured audit events
- [ ] Audit events include sufficient context for security review
- [ ] Audit events are logged (not just debug-level)

### 3.3 Stale Tool Detection (Optional Enhancement)

**Files**:

- `apps/studio/src/hooks/useStaleToolCheck.ts` (existing, extend for MCP)
- `apps/studio/src/components/mcp-servers/McpServerDetailPage.tsx` (modify)

Add a "check for updates" button on the MCP server detail page:

- Connect to server, list tools, compare with imported `project_tools`
- Show which tools have schema drift, which are new, which are removed
- Allow selective re-import or cleanup

**Exit criteria**:

- [ ] UI shows stale/new/removed tool indicators
- [ ] Re-import updates only changed tools
- [ ] Removed remote tools can be cleaned up from project

---

## Wiring Checklist

The following wiring points must be verified for each phase:

### Phase 1 Wiring

| #   | Wiring Point                                                        | Verification Method                           |
| --- | ------------------------------------------------------------------- | --------------------------------------------- |
| W1  | Fixture server implements MCP protocol correctly                    | E2E test passes with real JSON-RPC exchange   |
| W2  | `MCPServerRegistryService` loads fixture server config from test DB | E2E test verifies config loaded and decrypted |
| W3  | `RuntimeMcpClientProvider` connects to fixture server               | E2E test verifies tool execution succeeds     |
| W4  | `McpToolExecutor` normalizes fixture server results                 | E2E test verifies result format               |
| W5  | Auth headers flow from encrypted config to fixture server           | Fixture server echoes received headers        |
| W6  | SSRF validator blocks private IPs before connection                 | E2E test verifies no network attempt made     |
| W7  | Delete cascade removes project tools by name prefix                 | E2E test verifies tool count before/after     |

### Phase 2 Wiring

| #   | Wiring Point                                                             | Verification Method                          |
| --- | ------------------------------------------------------------------------ | -------------------------------------------- |
| W8  | Circuit breaker state persists across tool calls within executor         | E2E test tracks breaker state transitions    |
| W9  | Auth profile env vars resolve through `dualReadCredentials`              | Integration test mocks auth profile lookup   |
| W10 | Schema drift detected by `sourceHash` comparison in `discoverAndPersist` | Integration test compares pre/post hashes    |
| W11 | Selective import filters tools by `toolNames` parameter                  | E2E test verifies only named tools persisted |

### Phase 3 Wiring

| #   | Wiring Point                                              | Verification Method                         |
| --- | --------------------------------------------------------- | ------------------------------------------- |
| W12 | TraceEvents emitted from McpToolExecutor reach TraceStore | Unit test verifies trace mock called        |
| W13 | MCPAuditEvent hook wired in runtime provider              | Integration test verifies audit log entries |
| W14 | Stale tool check UI calls discovery preview and compares  | Component test verifies comparison logic    |

---

## Risk Register

| #   | Risk                                                         | Likelihood | Impact | Mitigation                                                          |
| --- | ------------------------------------------------------------ | ---------- | ------ | ------------------------------------------------------------------- |
| R1  | Fixture server MCP protocol implementation has bugs          | Medium     | High   | Use official MCP SDK if available; otherwise thorough unit testing  |
| R2  | MongoMemoryServer flaky in CI for E2E tests                  | Medium     | Medium | Use shared test DB setup; add retry on connection timeout           |
| R3  | Circuit breaker timing in E2E tests is non-deterministic     | Medium     | Low    | Use shorter reset periods in test config; add time-based assertions |
| R4  | Auth-profile integration depends on encryption master key    | Low        | High   | Ensure E2E test setup includes encryption key configuration         |
| R5  | TraceStore integration may conflict with existing trace flow | Low        | Medium | Emit MCP events as child spans within existing execution trace      |

---

## Definition of Done (STABLE Criteria)

The MCP Support feature transitions from BETA to STABLE when:

1. **E2E coverage**: All 7 E2E scenarios from the test spec pass in CI
2. **Integration coverage**: All 10 integration scenarios pass
3. **Live server test**: At least one E2E test exercises a live MCP server through the full Studio create -> import -> runtime execute flow
4. **Auth coverage**: All 5 auth modes exercised in integration tests with real header verification
5. **Observability**: MCP operations emit trace events visible in the platform's trace timeline
6. **Documentation**: User-facing documentation covers MCP server setup, discovery, import, and troubleshooting
7. **No HIGH-severity gaps**: All HIGH gaps from the feature spec are resolved

---

## File Manifest (New Files)

| Phase | File                                                                  | Purpose                             |
| ----- | --------------------------------------------------------------------- | ----------------------------------- |
| 1     | `packages/compiler/src/__tests__/fixtures/mcp-http-fixture-server.ts` | Live HTTP MCP test fixture server   |
| 1     | `apps/runtime/src/__tests__/e2e/mcp-live-server.e2e.test.ts`          | Live server E2E test                |
| 1     | `apps/runtime/src/__tests__/e2e/mcp-auth-forwarding.e2e.test.ts`      | Auth header forwarding E2E test     |
| 1     | `apps/runtime/src/__tests__/e2e/mcp-ssrf-rejection.e2e.test.ts`       | SSRF rejection E2E test             |
| 1     | `apps/runtime/src/__tests__/e2e/mcp-delete-cascade.e2e.test.ts`       | Delete cascade E2E test             |
| 2     | `apps/runtime/src/__tests__/e2e/mcp-circuit-breaker.e2e.test.ts`      | Circuit breaker E2E test            |
| 2     | `packages/shared/src/__tests__/mcp-auth-profile-integration.test.ts`  | Auth-profile-backed MCP integration |
| 2     | `apps/studio/src/__tests__/mcp-schema-drift.integration.test.ts`      | Schema drift detection integration  |
| 2     | `apps/studio/src/__tests__/mcp-selective-import.e2e.test.ts`          | Selective tool import E2E test      |

---

## Phase Timeline

| Phase | Duration | Dependencies                     | Blocking |
| ----- | -------- | -------------------------------- | -------- |
| 1     | 3-5 days | None (all infrastructure exists) | Yes      |
| 2     | 2-3 days | Phase 1 fixture server           | No       |
| 3     | 2-3 days | Phase 1 E2E infrastructure       | No       |

**Total estimated duration**: 7-11 days

Phases 2 and 3 can run in parallel once Phase 1 fixture server is available.
