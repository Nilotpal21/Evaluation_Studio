# Feature Test Guide: MCP Support

**Feature**: MCP server registry, Studio CRUD/discovery/import, runtime providers, auth resolution, and tool execution
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/mcp-support.md](../features/mcp-support.md)
**First audited**: 2026-03-19
**Last updated**: 2026-03-22
**Coverage basis**: Repository test inventory audit on 2026-03-22; code-grounded review of all MCP source files
**Overall status**: PARTIAL

---

## Current State (as of 2026-03-22)

MCP support has strong unit coverage across the compiler MCP client/executor layer, shared registry/auth/repository layer, runtime provider behavior, and Studio route/client/discovery services. The platform has solid guardrails around config loading, auth header construction, route-level validation, discovery response shaping, runtime lazy-loading, circuit breaker resilience, and result normalization.

The primary gap is a true end-to-end execution path against a live MCP server. Existing tests validate the moving parts in isolation but there is no black-box scenario that starts with a real server registration, imports tools, and then executes an agent-bound MCP tool through the runtime against a live HTTP or SSE server. A secondary gap is the absence of full auth-profile-backed MCP server integration tests spanning encrypted env/auth, registry loading, and runtime execution as one continuous scenario.

### Quick Health Dashboard

| Area                           | Status      | Evidence                                                                   | Notes                                                                       |
| ------------------------------ | ----------- | -------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| MCP client protocol/transport  | PASS        | `packages/compiler/src/__tests__/mcp-client.test.ts`                       | Covers protocol initialization, transport handling, security controls       |
| MCP tool executor resilience   | PASS        | `packages/compiler/src/__tests__/constructs/mcp-tool-executor.test.ts`     | Covers circuit breaker, retry, timeout, placeholder resolution              |
| MCP tool result normalization  | PASS        | `packages/compiler/src/__tests__/constructs/mcp-tool-result-cap.test.ts`   | Covers result size capping and content type normalization                   |
| Tool binding routing           | PASS        | `packages/compiler/src/__tests__/constructs/tool-binding-executor.test.ts` | Covers routing to MCP executor by tool_type                                 |
| Shared registry loading        | PASS        | `packages/shared/src/__tests__/mcp-server-registry.test.ts`                | Covers decryption, filtering, caching, and placeholder resolution paths     |
| Auth header resolution         | PASS        | `packages/shared/src/__tests__/mcp-auth-resolver.test.ts`                  | Covers bearer, API key, custom headers, OAuth2 client credentials, and CRLF |
| Repository CRUD + cascade      | PASS        | `packages/shared/src/__tests__/mcp-server-config-repo.test.ts`             | Covers persistence and server/tool delete cascade behavior                  |
| Runtime DB-backed provider     | PASS        | `apps/runtime/src/__tests__/runtime-mcp-provider.test.ts`                  | Covers lazy project initialization, client lookup, connection cap           |
| Runtime inline provider        | PASS        | `apps/runtime/src/__tests__/inline-mcp-provider.test.ts`                   | Covers inline `server_config`, SSRF checks, auth/env handling               |
| Runtime registry wiring        | PASS        | `apps/runtime/src/__tests__/mcp-server-registry.test.ts`                   | Covers runtime-facing registry interactions                                 |
| Studio API routes              | PASS        | `apps/studio/src/__tests__/api-mcp-routes.test.ts`                         | Covers CRUD, test-connection, discover, preview, and tool-test routes       |
| Studio API client              | PASS        | `apps/studio/src/__tests__/api-mcp-client.test.ts`                         | Keeps client surface aligned with route contracts                           |
| Studio discovery service       | PASS        | `apps/studio/src/__tests__/mcp-discovery-service.test.ts`                  | Covers preview, import, testing, and status updates                         |
| Studio response normalization  | PASS        | `apps/studio/src/__tests__/mcp-server-response.test.ts`                    | Covers response shaping and type normalization                              |
| Real live-server E2E           | NOT COVERED | --                                                                         | No live MCP server round-trip in CI                                         |
| Auth-profile-backed full chain | NOT COVERED | --                                                                         | Auth profile MCP tested indirectly, not as one continuous scenario          |

---

## Audit Scope

This guide covers the MCP stack across four layers:

1. **Compiler layer**: MCP protocol types, client implementation, server manager, tool executor (circuit breaker, retry, timeout, result normalization)
2. **Shared layer**: Repository CRUD/cascade, registry service (decrypt/filter/cache), auth resolver (5 modes + CRLF), type definitions
3. **Runtime layer**: DB-backed provider (lazy loading, connection cap, init TTL), inline provider (ephemeral, SSRF, auth/env), tool binding wiring
4. **Studio layer**: CRUD routes, discovery service, connection test, API client, response shaping, UI components and stores

---

## Coverage Goals

The feature will be substantially better covered when the repo proves all of the following:

- Studio can create a real MCP server, discover/import tools, and hand that configuration off to runtime successfully
- Runtime can execute an agent-bound MCP tool against a live HTTP or SSE server
- Auth-profile-backed MCP configuration is validated across storage, discovery, and execution as one continuous scenario
- SSRF and invalid-auth negative paths are covered through full user-facing flows
- Circuit breaker behavior is validated with simulated repeated failures and recovery
- Multi-tool discovery, selective import, and schema drift detection are tested end-to-end

---

## E2E Test Scenarios (Minimum 5)

| #   | Scenario                                                                                               | Type | Priority | Status      | Test File / Notes                                                                       |
| --- | ------------------------------------------------------------------------------------------------------ | ---- | -------- | ----------- | --------------------------------------------------------------------------------------- |
| E1  | Studio create -> test-connection -> discover -> import -> runtime execute against live HTTP MCP server | E2E  | P0       | NOT COVERED | Requires a live HTTP MCP fixture server that exposes 2+ tools                           |
| E2  | Studio create with bearer auth -> import -> runtime execute with auth headers forwarded to MCP server  | E2E  | P0       | NOT COVERED | Verify auth headers reach the MCP server by checking fixture server received headers    |
| E3  | Studio create with SSRF-blocked URL returns error and does not connect                                 | E2E  | P0       | NOT COVERED | Attempt to register server with `http://169.254.169.254/` and verify rejection          |
| E4  | Delete MCP server cascades to remove all imported project tools                                        | E2E  | P1       | NOT COVERED | Create server, import 3 tools, delete server, verify tools gone from project_tools      |
| E5  | Runtime circuit breaker trips after repeated MCP server failures and recovers after reset period       | E2E  | P1       | NOT COVERED | Simulate 3 consecutive failures, verify TOOL_CIRCUIT_OPEN, wait reset, verify recovery  |
| E6  | Inline compiled MCP binding executes without DB via ephemeral connect-execute-disconnect               | E2E  | P1       | PARTIAL     | `apps/runtime/src/__tests__/inline-mcp-provider.test.ts` covers unit; needs live server |
| E7  | Multi-tool selective import: discover 5 tools, import only 2, verify only 2 in project_tools           | E2E  | P2       | NOT COVERED | Tests selective import via `toolNames` filter parameter                                 |

---

## Integration Test Scenarios (Minimum 5)

| #   | Scenario                                                                             | Type        | Priority | Status  | Test File                                                                           |
| --- | ------------------------------------------------------------------------------------ | ----------- | -------- | ------- | ----------------------------------------------------------------------------------- |
| I1  | Registry service decrypts, validates, filters, and caches project MCP configs        | Integration | P0       | PASS    | `packages/shared/src/__tests__/mcp-server-registry.test.ts`                         |
| I2  | Auth resolver covers all 5 auth modes with CRLF sanitization and OAuth2 token cache  | Integration | P0       | PASS    | `packages/shared/src/__tests__/mcp-auth-resolver.test.ts`                           |
| I3  | Repository CRUD + delete cascade removes server and all associated project tools     | Integration | P0       | PASS    | `packages/shared/src/__tests__/mcp-server-config-repo.test.ts`                      |
| I4  | Studio discovery service previews, imports, detects schema drift, and tests tools    | Integration | P0       | PASS    | `apps/studio/src/__tests__/mcp-discovery-service.test.ts`                           |
| I5  | MCP tool executor handles circuit breaker open/close, retry on transient errors      | Integration | P0       | PASS    | `packages/compiler/src/__tests__/constructs/mcp-tool-executor.test.ts`              |
| I6  | Runtime provider lazy-loads project servers and caps at 20 per project               | Integration | P1       | PASS    | `apps/runtime/src/__tests__/runtime-mcp-provider.test.ts`                           |
| I7  | Inline provider validates SSRF, enforces stdio command allowlist, decrypts env       | Integration | P1       | PASS    | `apps/runtime/src/__tests__/inline-mcp-provider.test.ts`                            |
| I8  | Studio CRUD routes validate input, enforce project isolation, and shape responses    | Integration | P1       | PASS    | `apps/studio/src/__tests__/api-mcp-routes.test.ts`                                  |
| I9  | Auth-profile dual-read resolves MCP env from auth profile when authProfileId present | Integration | P2       | PARTIAL | Tested indirectly in `packages/shared/src/__tests__/auth-profile/dual-read.test.ts` |
| I10 | MCP result normalization handles mixed content types and truncates at 100K chars     | Integration | P2       | PASS    | `packages/compiler/src/__tests__/constructs/mcp-tool-result-cap.test.ts`            |

---

## Coverage Map

### Compiler Layer

| File                                                                       | Type | Coverage Area                                                  |
| -------------------------------------------------------------------------- | ---- | -------------------------------------------------------------- |
| `packages/compiler/src/__tests__/mcp-client.test.ts`                       | unit | Protocol initialization, transport handling, security controls |
| `packages/compiler/src/__tests__/constructs/mcp-tool-executor.test.ts`     | unit | Circuit breaker, retry, timeout, placeholder resolution        |
| `packages/compiler/src/__tests__/constructs/mcp-tool-result-cap.test.ts`   | unit | Result size capping, mixed content normalization               |
| `packages/compiler/src/__tests__/constructs/tool-binding-executor.test.ts` | unit | Routing to MCP executor by tool_type, middleware composition   |
| `packages/compiler/src/__tests__/constructs/tool-schema-validator.test.ts` | unit | MCP tool schema validation                                     |
| `packages/compiler/src/__tests__/constructs/tool-lifecycle-e2e.test.ts`    | unit | End-to-end tool lifecycle including MCP path                   |

### Shared Layer

| File                                                           | Type | Coverage Area                                               |
| -------------------------------------------------------------- | ---- | ----------------------------------------------------------- |
| `packages/shared/src/__tests__/mcp-server-registry.test.ts`    | unit | Project config loading, decryption paths, cache behavior    |
| `packages/shared/src/__tests__/mcp-auth-resolver.test.ts`      | unit | Auth-header construction, CRLF sanitization, OAuth2 caching |
| `packages/shared/src/__tests__/mcp-server-config-repo.test.ts` | unit | CRUD helpers, delete cascade semantics, project isolation   |

### Runtime Layer

| File                                                      | Type | Coverage Area                                                  |
| --------------------------------------------------------- | ---- | -------------------------------------------------------------- |
| `apps/runtime/src/__tests__/runtime-mcp-provider.test.ts` | unit | Lazy server loading, client lookup, connection cap, TTL        |
| `apps/runtime/src/__tests__/inline-mcp-provider.test.ts`  | unit | Inline transport/auth/env, SSRF enforcement, command allowlist |
| `apps/runtime/src/__tests__/mcp-server-registry.test.ts`  | unit | Runtime integration around registry-backed loading             |

### Studio Layer

| File                                                      | Type | Coverage Area                                                   |
| --------------------------------------------------------- | ---- | --------------------------------------------------------------- |
| `apps/studio/src/__tests__/api-mcp-routes.test.ts`        | unit | Route-level validation, project isolation, response behavior    |
| `apps/studio/src/__tests__/api-mcp-client.test.ts`        | unit | Typed client request/response contracts                         |
| `apps/studio/src/__tests__/mcp-discovery-service.test.ts` | unit | Discovery preview/import/test, schema drift, status persistence |
| `apps/studio/src/__tests__/mcp-server-response.test.ts`   | unit | Response shaping and normalization                              |

---

## What Is Well Covered

- **Protocol and client**: MCP protocol types, JSON-RPC message handling, transport initialization, and security controls are tested at the compiler level.
- **Resilience**: Circuit breaker behavior, transient error retry, timeout enforcement, and result size capping are thoroughly tested in the executor.
- **Auth resolution**: All five auth modes (none, bearer, api_key, custom_headers, oauth2_client_credentials) are tested with CRLF sanitization and OAuth2 token caching.
- **Registry loading**: Decryption, filtering, SSRF validation, auth-profile dual-read, and TTL caching are covered in the shared registry tests.
- **Runtime providers**: Both DB-backed (lazy loading, connection cap, init TTL) and inline (SSRF, command allowlist, env decryption, ephemeral connect/disconnect) providers have dedicated unit coverage.
- **Studio surface**: Route validation, discovery preview/import, connection testing, tool testing, client contracts, and response shaping are covered across multiple Studio test files.
- **Delete cascade**: Server deletion propagating to associated project tools is tested in the repository layer.

---

## Gaps

- **GAP-001**: No live MCP server E2E that validates Studio create/import plus runtime tool execution against a real HTTP or SSE server.
  - **Severity**: High
  - **Reason**: Current suites are unit-oriented and mock the remote MCP boundary. A live fixture server is needed.

- **GAP-002**: No Studio-facing test coverage for `stdio` server management because Studio CRUD only exposes `http` and `sse`.
  - **Severity**: Medium
  - **Reason**: `stdio` currently exists only on the inline runtime path. No Studio UI or routes exist for it.

- **GAP-003**: No full auth-profile-backed MCP server integration test spanning encrypted env/auth, registry loading, and runtime execution as one continuous scenario.
  - **Severity**: Medium
  - **Reason**: Auth profile MCP pieces are tested indirectly in isolation, not as one MCP scenario.

- **GAP-004**: No E2E test for circuit breaker behavior under repeated MCP server failures and automatic recovery.
  - **Severity**: Medium
  - **Reason**: Circuit breaker is unit-tested but not exercised through a realistic multi-call failure/recovery sequence.

- **GAP-005**: No E2E test for selective tool import from multi-tool discovery (import subset, verify only subset persisted).
  - **Severity**: Low
  - **Reason**: Import logic is unit-tested; E2E selective import needs a real multi-tool server fixture.

- **GAP-006**: No negative-path E2E for OAuth2 with non-HTTPS token endpoint or expired/invalid credentials.
  - **Severity**: Medium
  - **Reason**: Auth resolver unit tests cover these, but no full user-facing flow exercises them.

---

## Recommended Next Coverage Pass

1. **P0 -- Live MCP server fixture**: Build a lightweight HTTP MCP server (e.g., Express + MCP SDK) that exposes 3+ tools with known schemas. Use it as a test fixture for E2E scenarios E1 through E4.

2. **P0 -- Auth header forwarding E2E**: Configure the fixture server to echo received headers. Verify bearer, API key, and custom headers arrive correctly through the full Studio create -> runtime execute path.

3. **P0 -- SSRF negative path**: Attempt to create servers with `http://169.254.169.254/`, `http://10.0.0.1/`, and `http://[::1]/` URLs. Verify all are rejected before connection attempt.

4. **P1 -- Delete cascade E2E**: Create a server, import multiple tools, delete the server, verify all associated tools are removed from `project_tools`.

5. **P1 -- Circuit breaker E2E**: Configure the fixture server to fail on the first 3 calls, then succeed. Verify the executor reports `TOOL_CIRCUIT_OPEN` after threshold, then recovers after reset period.

6. **P2 -- Auth-profile-backed chain**: Register an MCP server with an `authProfileId`, verify env vars resolve from the auth profile through registry loading, discovery, and runtime execution.

7. **P2 -- Schema drift detection**: Import tools, modify the fixture server's tool schema, re-run discovery, verify `schemaDrift` entries are returned and tools are updated.

---

## Test Infrastructure Requirements

### Live MCP Server Fixture

A reusable test fixture server is needed for E2E testing. Requirements:

- Exposes 3+ tools with known input schemas and deterministic outputs
- Supports HTTP and/or SSE MCP transports
- Can be configured to:
  - Require specific auth headers (for auth forwarding tests)
  - Fail on demand (for circuit breaker tests)
  - Return large results (for result capping tests)
  - Change tool schemas between calls (for drift detection tests)
- Starts on a random port via `{ port: 0 }` for parallel test safety
- Implements MCP protocol version `2024-11-05`

### Database Setup

E2E tests need:

- Real MongoDB instance (MongoMemoryServer or shared test DB)
- Encryption master key configured for env/auth decryption
- Project and tenant records pre-seeded for isolation verification

---

## Related Docs

- Feature doc: [../features/mcp-support.md](../features/mcp-support.md)
- Adjacent features: [../features/tool-invocations.md](../features/tool-invocations.md), [../features/auth-profiles.md](../features/auth-profiles.md)
- MCP Specification: https://modelcontextprotocol.io/specification
