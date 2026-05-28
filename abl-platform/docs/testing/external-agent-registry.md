# Test Specification: External Agent Registry

**Feature Spec**: [`docs/features/external-agent-registry.md`](../features/external-agent-registry.md)
**HLD**: [`docs/specs/external-agent-registry.hld.md`](../specs/external-agent-registry.hld.md)
**LLD**: [`docs/plans/2026-04-28-external-agent-registry-impl-plan.md`](../plans/2026-04-28-external-agent-registry-impl-plan.md)
**Status**: ALPHA
**Last Updated**: 2026-04-28

---

## 1. Coverage Matrix

| FR    | Description                                                                                                               | Unit    | Integration | E2E                    | Manual      | Status  |
| ----- | ------------------------------------------------------------------------------------------------------------------------- | ------- | ----------- | ---------------------- | ----------- | ------- |
| FR-1  | Project-scoped CRUD with permission gates (`external_agent:create/read/update/delete`)                                    | ❌      | ✅ INT-1    | ✅ E2E-1               | —           | WRITTEN |
| FR-2  | Data model: name uniqueness, protocol enum, authType, encrypted auth, health fields                                       | ✅ UT-1 | ✅ INT-2    | —                      | —           | WRITTEN |
| FR-3  | Agent card fetch on create + test-connection; store skills; update status/latency                                         | ❌      | ✅ INT-3    | ✅ E2E-4               | —           | WRITTEN |
| FR-4  | SSRF validation of endpoint URLs before any outbound fetch                                                                | ✅ UT-2 | ✅ INT-4    | ✅ E2E-1               | —           | WRITTEN |
| FR-5  | Auth credential masking — encryptedAuthConfig absent, authConfigured: boolean present in all responses                    | ❌      | ✅ INT-5    | ✅ E2E-2               | —           | WRITTEN |
| FR-6  | Runtime auth injection: `enrichWithRegistryAuth()` in `handleHandoff()` looks up registry, injects auth.value, falls back | ✅ UT-3 | ✅ INT-6    | ✅ E2E-2, E2E-3, E2E-5 | —           | WRITTEN |
| FR-7  | Studio agent editor HANDOFF TO: autocomplete from registry                                                                | —       | —           | —                      | ✅ MANUAL-1 | MANUAL  |
| FR-8  | Advisory warning for unregistered HANDOFF TO: target with LOCATION: remote                                                | —       | —           | —                      | ✅ MANUAL-2 | MANUAL  |
| FR-9  | Studio list page: columns, status badges, test-connection action                                                          | —       | —           | —                      | ✅ MANUAL-3 | MANUAL  |
| FR-10 | Studio registration form + edit panel; skills display after save/test-connection                                          | —       | —           | —                      | ✅ MANUAL-4 | MANUAL  |
| FR-11 | Cross-project 404, cross-tenant 404 on all CRUD operations                                                                | ❌      | ✅ INT-7    | ✅ E2E-6               | —           | WRITTEN |
| FR-12 | Trace event emitted for registry lookup with agentName, registryHit, endpoint, authType                                   | ❌      | ✅ INT-8    | —                      | —           | WRITTEN |

---

## 2. E2E Test Scenarios

> **CRITICAL**: All E2E tests use `startRuntimeServerHarness()` which starts the FULL runtime server with MongoMemoryServer, real auth middleware, real encryption via `initializeRuntimeTestEncryption()`, real RBAC, and real SSRF validation. No mocks of platform components. Remote agent endpoints are provided by in-process HTTP stub servers that validate received auth headers.

> **SSRF note**: The in-process stub servers listen on `127.0.0.1` which the SSRF validator rejects by default. The runtime harness must be started with `{ allowPrivateEndpoints: true }` to pass `allowPrivate: true` to the `SsrfEndpointValidator.validate()` call when running tests with in-process stubs. This is a test-environment-only configuration.

> **Import note**: `bootstrapProject`, `authHeaders`, `devLogin`, `setSuperAdmins`, `requestJson`, `uniqueEmail`, `uniqueSlug` are imported from `./helpers/channel-e2e-bootstrap.js` (not from the harness). `startRuntimeServerHarness` and `RuntimeApiHarness` are from `./helpers/runtime-api-harness.js`. See `apps/runtime/src/__tests__/prompt-library-rbac.e2e.test.ts` for the canonical import pattern.

### E2E-1: Full CRUD lifecycle with bearer auth and agent card verification

**File**: `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`

**Preconditions**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- `bootstrapProject(harness, email, tenantSlug, projSlug)` → `{ token, projectId, tenantId }` (imported from `./helpers/channel-e2e-bootstrap.js`)
- In-process agent card stub: `GET /.well-known/agent-card.json` returns `{ name: "TestAgent", skills: [{ id: "book", name: "Book Appointment" }] }`

**Steps**:

1. `POST /api/projects/:projectId/external-agents` — Body: `{ name: "Appointment_Agent", protocol: "a2a", authType: "bearer", endpoint: stubUrl, authConfig: { value: "sk-test-bearer-token" } }` → 201, `authConfigured: true`, `encryptedAuthConfig` ABSENT from response, `lastConnectionStatus: "connected"`, `lastDiscoveredCard` has skills
2. `GET /api/projects/:projectId/external-agents` → 200, `items.length === 1`, `encryptedAuthConfig` ABSENT
3. `GET /api/projects/:projectId/external-agents/:id` → 200, `encryptedAuthConfig` ABSENT
4. `PATCH /api/projects/:projectId/external-agents/:id` — Body: `{ displayName: "Appointment Scheduling Agent" }` → 200, `encryptedAuthConfig` ABSENT
5. `DELETE /api/projects/:projectId/external-agents/:id` → 200
6. `GET /api/projects/:projectId/external-agents` → 200, `items.length === 0`

**Expected**: Full CRUD lifecycle completes. Credentials never exposed in any response. Agent card fetched on create.

**Auth Context**: Real tenant + project + project owner token from `bootstrapProject`

**Isolation**: All operations scoped to `{tenantId, projectId}`

---

### E2E-2: Bearer auth injection during HANDOFF TO: execution

**File**: `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`

**Preconditions**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- `bootstrapProject` → `{ token, projectId, tenantId }`
- In-process A2A stub that: serves agent card at `/.well-known/agent-card.json`, handles `POST /` JSON-RPC `message/send`, validates `req.headers.authorization === 'Bearer sk-secret-bearer-token'`, returns canned response if valid / 401 if not

**Agent DSL**:

```
SUPERVISOR: TestSupervisor
  HANDOFF TO: Appointment_Agent
  LOCATION: REMOTE
  PROTOCOL: A2A
  RETURN: true
```

**Steps**:

1. `POST /api/projects/:projectId/external-agents` — Register `Appointment_Agent` with `authType: "bearer"`, `authConfig: { value: "sk-secret-bearer-token" }` → 201
2. Import DSL via API
3. Create deployment
4. `POST` session message → stub validates `req.headers.authorization === "Bearer sk-secret-bearer-token"` (**KEY ASSERTION**)

**Expected**: Registry lookup injects bearer auth. Stub validates the header was received correctly.

**Auth Context**: Tenant A, Project A, project owner token

---

### E2E-3: API key auth injection during HANDOFF TO: execution

**File**: `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`

**Preconditions**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- `bootstrapProject` → `{ token, projectId, tenantId }`
- In-process A2A stub that validates `req.headers['x-agent-key'] === 'sk-api-key-value'`

**Steps**:

1. `POST /api/projects/:projectId/external-agents` — Register `RemotePaymentAgent` with `authType: "api_key"`, `authConfig: { value: "sk-api-key-value", header: "X-Agent-Key" }` → 201
2. Import DSL with `HANDOFF TO: RemotePaymentAgent, LOCATION: REMOTE, PROTOCOL: A2A`
3. Create deployment and trigger session
4. Assert stub received `x-agent-key: sk-api-key-value` and `authorization` header is ABSENT

**Auth Context**: Tenant A, Project A, project owner token

---

### E2E-4: Test-connection updates status, latency, and cached skills

**File**: `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`

**Preconditions**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- `bootstrapProject` → `{ token, projectId, tenantId }`
- Register `FlakeyAgent` where initial card fetch fails (stub returns 500) → `lastConnectionStatus: "failed"`

**Steps**:

1. `POST /api/projects/:projectId/external-agents` — Register `FlakeyAgent` with endpoint pointing to failing stub → 201, `lastConnectionStatus: "failed"`
2. Swap stub to return valid agent card with skills
3. `POST /api/projects/:projectId/external-agents/:id/test-connection` → 200, `lastConnectionStatus: "connected"`, `lastConnectionLatencyMs > 0`, `lastDiscoveredCard` has skills array
4. `GET /api/projects/:projectId/external-agents/:id` → status persisted as `"connected"`

**Auth Context**: Tenant A, Project A, project owner token

---

### E2E-5: Registry fallback — HANDOFF with inline ENDPOINT but no registry entry

**File**: `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`

**Preconditions**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- `bootstrapProject` → `{ token, projectId, tenantId }`
- In-process A2A stub that validates no auth header is present

**Agent DSL**:

```
HANDOFF TO: UnregisteredAgent
LOCATION: REMOTE
ENDPOINT: "http://127.0.0.1:<stubPort>"
PROTOCOL: A2A
```

No registry entry for `UnregisteredAgent`.

**Steps**:

1. Import DSL via API
2. Create deployment and trigger session
3. Stub receives `message/send`, no auth header, responds 200

**Expected**: Inline endpoint is used as fallback. No auth injected (no registry entry).

**Auth Context**: Tenant A, Project A, project owner token

**Isolation**: Confirms backward compatibility — inline `ENDPOINT:` still works when no registry entry exists

---

### E2E-6: Cross-project isolation — 404 on all operations

**File**: `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`

**Preconditions**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- `bootstrapProject` A → `{ tokenA, projectIdA, tenantIdA }` (Tenant A)
- `bootstrapProject` B → `{ tokenB, projectIdB }` (different tenant)
- Register `agentIdA` in Project A via POST

**Steps**:

1. `GET /api/projects/:projectIdB/external-agents/:agentIdA` with `tokenB` → 404
2. `PATCH /api/projects/:projectIdB/external-agents/:agentIdA` with `tokenB` → 404
3. `DELETE /api/projects/:projectIdB/external-agents/:agentIdA` with `tokenB` → 404
4. `POST /api/projects/:projectIdB/external-agents/:agentIdA/test-connection` with `tokenB` → 404
5. `GET /api/projects/:projectIdB/external-agents` with `tokenB` → 200, `items.length === 0`
6. Import `HANDOFF TO: "Appointment_Agent"` in Project B, trigger → registry uses `projectIdB`, finds NO entry, error

**Auth Context**: Two separate bootstrap environments, different tenants

**Isolation**: This IS the isolation check — verifies 404 (not 403), no existence leakage

---

### E2E-7: No-auth registration — HANDOFF sends no auth header

**File**: `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`

**Preconditions**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- `bootstrapProject` → `{ token, projectId, tenantId }`
- In-process A2A stub that validates NO `authorization` header is present

**Steps**:

1. `POST /api/projects/:projectId/external-agents` — Register `PublicAgent` with `authType: "none"` → 201, `authConfigured: false`
2. Import DSL with `HANDOFF TO: PublicAgent, LOCATION: REMOTE, PROTOCOL: A2A`
3. Create deployment and trigger session
4. Stub received request, no `authorization` header, no custom auth headers

**Auth Context**: Tenant A, Project A, project owner token

---

### E2E-8: HANDOFF to unknown agent with no inline endpoint — runtime error

**File**: `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`

**Preconditions**:

- `startRuntimeServerHarness()` started (no `allowPrivateEndpoints` needed — no outbound fetch expected)
- `bootstrapProject` → `{ token, projectId, tenantId }`

**Agent DSL**:

```
HANDOFF TO: NonExistentAgent
LOCATION: REMOTE
PROTOCOL: A2A
```

No `ENDPOINT:` and no registry entry.

**Steps**:

1. Import DSL via API
2. Create deployment and trigger session
3. Error response contains `"NonExistentAgent"`, does not expose other tenant data

**Auth Context**: Tenant A, Project A, project owner token from `bootstrapProject`

**Isolation**: Error message does not leak cross-project data

---

## 3. Integration Test Scenarios

> Integration tests use `startRuntimeServerHarness()` for full middleware chain. No `vi.mock` of platform components. The only stubbed external service is the remote A2A endpoint (an in-process HTTP server).

### INT-1: Permission gates enforced on all CRUD operations

**File**: `apps/runtime/src/__tests__/external-agents-integration.test.ts`

**Boundary**: HTTP request → RBAC middleware → route handler

**Setup**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- `bootstrapProject(harness, email, tenantSlug, projSlug)` → `{ ownerToken, projectId }`
- `devLogin(harness, viewerEmail)` → `viewerToken` (viewer role, no write permissions)

**Steps**:

1. `POST /api/projects/:projectId/external-agents` with `viewerToken` → 403
2. `PATCH /api/projects/:projectId/external-agents/:id` with `viewerToken` → 403
3. `DELETE /api/projects/:projectId/external-agents/:id` with `viewerToken` → 403
4. `POST /api/projects/:projectId/external-agents` with no token → 401
5. `GET /api/projects/:projectId/external-agents` with `viewerToken` → 200

**Expected**: Write operations blocked for viewer role. Read operations allowed.

**Failure Mode**: Write operations succeed without proper permissions.

---

### INT-2: Data model uniqueness constraint and validation

**File**: `apps/runtime/src/__tests__/external-agents-integration.test.ts`

**Boundary**: HTTP request → route handler → MongoDB

**Setup**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- `bootstrapProject` → `{ ownerToken, projectId }`
- Register `"MyAgent"` in the project

**Steps**:

1. `POST` duplicate `"MyAgent"` in same project → 409 `DUPLICATE_NAME`
2. `POST` `"MyAgent"` in different project → 201 (allowed — uniqueness is per-project)
3. `POST` with `protocol: "grpc"` → 400
4. `POST` with `authType: "oauth2"` → 400
5. `POST` with `endpoint: "not-a-url"` → 400
6. `POST` with `name: ""` → 400
7. `POST` with `name: "My Agent"` (spaces) → 400

**Expected**: Uniqueness enforced per `{tenantId, projectId}`. Invalid enum values and format violations rejected.

---

### INT-3: Agent card fetch on create — success and failure paths

**File**: `apps/runtime/src/__tests__/external-agents-integration.test.ts`

**Boundary**: Route handler → SSRF validator → HTTP fetch → MongoDB

**Setup**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- Two in-process stubs: one returns valid agent card, one returns 500

**Steps**:

1. `POST` with valid stub URL → 201, `lastConnectionStatus: "connected"`, `lastConnectionLatencyMs > 0`, `lastDiscoveredCard` has `name` + `skills`, `encryptedAuthConfig` ABSENT
2. `POST` with failing stub URL → 201 (non-blocking), `lastConnectionStatus: "failed"`, `lastConnectionError` present
3. `PATCH` agent from step 2 to use valid stub URL, then `POST test-connection` → 200, `lastConnectionStatus: "connected"`, `lastDiscoveredCard` updated

**Expected**: Card fetch failure does not block registration. Test-connection updates status.

---

### INT-4: SSRF validation prevents private/internal endpoint registration

**File**: `apps/runtime/src/__tests__/external-agents-integration.test.ts`

**Boundary**: Route handler → `EndpointValidator` (`SsrfEndpointValidator`)

**Setup**: Harness started WITHOUT `allowPrivateEndpoints` (separate `describe` block from INT-1/INT-2/INT-3/INT-5/INT-7 which use `{ allowPrivateEndpoints: true }`)

**Steps**:

1. `POST` with `endpoint: "http://127.0.0.1/a2a"` → 400 `SSRF_REJECTED`
2. `POST` with `endpoint: "http://10.0.0.1/a2a"` → 400
3. `POST` with `endpoint: "http://169.254.169.254/latest/meta-data/"` → 400
4. `POST` with `endpoint: "http://192.168.1.1/a2a"` → 400
5. `POST` with `endpoint: "http://[::1]/a2a"` → 400
6. `POST` with `endpoint: "https://remote-agent.example.com/a2a"` → 201 (card fetch will fail but registration proceeds)
7. `PATCH` existing agent with private IP endpoint → 400

**Expected**: Private/internal IPs blocked. Public URLs allowed (even if unreachable).

---

### INT-5: Auth credential masking — all response surfaces

**File**: `apps/runtime/src/__tests__/external-agents-integration.test.ts`

**Boundary**: Route handler serializer → HTTP response body

**Setup**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- Register agent with `authType: "bearer"`, `authConfig: { value: "super-secret-token" }`

**Steps** (for each of 6 endpoints — POST, GET list, GET single, PATCH, test-connection, DELETE response):

- Assert `encryptedAuthConfig` is ABSENT from response body
- Assert `authConfigured === true`
- `JSON.stringify(response).includes("super-secret-token") === false`
- `JSON.stringify(response).includes("encryptedAuthConfig") === false`

**Expected**: Credentials never leak through any API response surface.

---

### INT-6: Registry lookup + auth injection in enrichWithRegistryAuth()

**File**: `apps/runtime/src/__tests__/external-agent-registry-resolution.test.ts`

**Boundary**: `enrichWithRegistryAuth()` (in `handleHandoff()`, with injectable `LookupExternalAgent`) → `ExternalAgentConfig` MongoDB lookup → decrypted auth value

**Setup**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- `bootstrapProject` → `{ token, projectId, tenantId }`
- Use HTTP API to seed registry entries (no direct Mongoose access)

**Steps**:

1. `POST` to register `PaymentAgent`: `authType: "bearer"`, `endpoint: "https://pay.example.com/a2a"`, `authConfig: { value: "pay-token" }` → 201
2. Build session IR: `HANDOFF TO: PaymentAgent`, `LOCATION: remote` (no inline endpoint)
3. Trigger `handleHandoff()` with `RoutingExecutor` constructed with injected fake `LookupExternalAgent` returning the registered agent
4. Assert: `entry.remote.endpoint === "https://pay.example.com/a2a"`, `entry.remote.auth.type === "bearer"`, `entry.remote.auth.value === "pay-token"`
5. Build session IR: `HANDOFF TO: PaymentAgent` WITH inline `ENDPOINT: "https://old.example.com/a2a"`
6. Trigger `handleHandoff()` via `RoutingExecutor` with injected lookup
7. Assert: `entry.remote.endpoint === "https://pay.example.com/a2a"` (registry TAKES PRECEDENCE), `auth.value === "pay-token"`
8. Call with `"UnknownAgent"` (no registry entry), inline `ENDPOINT: "https://fallback.example.com/a2a"`
9. Assert: falls back to inline endpoint, auth absent
10. Call with `"UnknownAgent"` (no registry entry, NO inline endpoint)
11. Assert: throws/returns null with descriptive error containing `"UnknownAgent"`

**Failure Mode**: Missing `projectId` in lookup → cross-project credential leakage

---

### INT-7: Cross-project isolation at the database level

**File**: `apps/runtime/src/__tests__/external-agents-integration.test.ts`

**Boundary**: Route handlers → `tenantIsolationPlugin` + project scoping

**Setup**:

- `startRuntimeServerHarness({ allowPrivateEndpoints: true })` started
- Two bootstrap environments: Project A + Project B (different tenants)

**Steps**:

1. Register `"SharedName"` in Project A → `agentIdA`
2. Register `"SharedName"` in Project B → `agentIdB` (201 — uniqueness is per-project)
3. `GET /api/projects/:projectIdA/external-agents/:agentIdB` with `tokenA` → 404
4. `PATCH /api/projects/:projectIdA/external-agents/:agentIdB` with `tokenA` → 404
5. `GET /api/projects/:projectIdA/external-agents` with `tokenA` → only `agentIdA` (1 result)
6. `DELETE /api/projects/:projectIdA/external-agents/:agentIdB` with `tokenA` → 404
7. `GET /api/projects/:projectIdB/external-agents` with `tokenB` → 200, `items.length === 1`, `items[0]._id === agentIdB` (API assertion, no DB access)

**Expected**: Same name allowed in different projects. Cross-project access returns 404.

---

### INT-8: Trace event emitted for registry lookup

**File**: `apps/runtime/src/__tests__/external-agent-registry-resolution.test.ts`

**Boundary**: `enrichWithRegistryAuth()` (in `handleHandoff()`) → `TraceStore` emission

**Setup**: Reuses harness and HTTP-seeded agent data from INT-6 describe block. DI-injected trace store spy.

**Steps**:

1. Trigger `handleHandoff()` with `RoutingExecutor` (injected lookup) → trace event: `type: "remote_agent_registry_lookup"`, `agentName: "PaymentAgent"`, `registryHit: true`, `endpoint: "https://pay.example.com/a2a"`, `authType: "bearer"`, `auth.value` ABSENT
2. Call with unregistered agent → trace event: `registryHit: false`, `authType` absent or `"none"`

**Expected**: Trace events emitted for every lookup. Credentials never appear in trace data.

---

## 4. Unit Test Scenarios

### UT-1: ExternalAgentConfig model schema and encryption round-trip

**File**: `packages/database/src/models/__tests__/external-agent-config.test.ts`

**Setup**: `setupTestMongo()` + `initializeRuntimeTestEncryption()` (real encryption)

**Tests** (10):

1. Valid document saves with all required fields
2. Missing required field (`name`) → validation error
3. Missing required field (`endpoint`) → validation error
4. Invalid `protocol` enum (`"grpc"`) → validation error
5. Invalid `authType` enum (`"oauth2"`) → validation error
6. Unique index enforced: same `{tenantId, projectId, name}` → duplicate key error
7. Unique index allows: same name, different `{tenantId, projectId}` → succeeds
8. `encryptedAuthConfig` round-trip: write `{ value: "secret" }` → read back decrypted → matches
9. `tenantIsolationPlugin` filters: query without `tenantId` returns empty
10. Null `lastConnectionStatus` on initial save, `createdAt`/`updatedAt` auto-populated

---

### UT-2: SSRF validation

**File**: Re-use existing `packages/a2a/src/__tests__/ssrf-interceptor.test.ts` + add coverage to INT-4

The existing SSRF test suite covers the `SsrfEndpointValidator` in isolation. INT-4 validates SSRF at the HTTP boundary (route handler level).

---

### UT-3: enrichWithRegistryAuth() DI-based unit tests

**File**: `apps/runtime/src/__tests__/external-agent-registry-resolution.test.ts`

**Setup**: Constructs `RoutingExecutor` with injected fake `LookupExternalAgent` (no `vi.mock`):

```typescript
const fakeRepo = {
  findByName: async (tenantId: string, projectId: string, name: string) => {
    if (name === 'KnownAgent')
      return {
        endpoint: 'https://known.example.com',
        authType: 'bearer',
        decryptedValue: 'tok-123',
      };
    return null;
  },
};
```

**Tests** (7):

1. Registry hit, no inline endpoint → returns registry endpoint + auth
2. Registry hit, inline endpoint present → registry endpoint takes precedence
3. Registry miss, inline endpoint present → falls back to inline, no auth
4. Registry miss, no inline endpoint → throws/returns error containing agent name
5. `authType: "api_key"` → returns `auth.type: "api_key"`, `auth.header` populated
6. `authType: "none"` → returns entry with no `auth.value`
7. Trace event emitted: `registryHit: true`, no `auth.value` in event payload

---

## 5. Security & Isolation Tests

### Checklist

- [x] Cross-tenant access returns 404 — E2E-6, INT-7 step 3
- [x] Cross-project access returns 404 — E2E-6, INT-7
- [x] Cross-user access — N/A; project-owned, not user-owned
- [x] Missing auth returns 401 — INT-1 step 4
- [x] Insufficient permissions returns 403 — INT-1 steps 1-3
- [x] Auth credentials never in API responses — INT-5, E2E-1
- [x] Auth credentials never in trace events — INT-8 step 2
- [x] SSRF validation blocks private IPs — INT-4, E2E-1
- [x] Duplicate name → 409 not 500 — INT-2 step 1
- [x] Cross-project registry lookup at runtime — E2E-6 step 6, INT-6
- [x] Input validation: invalid enum values → 400 — INT-2 steps 3-7
- [x] SQL/NoSQL injection: name field uses ABL identifier validation — INT-2 step 7
- [x] Cascade delete on project deletion — cascade-delete test

### Cascade Delete Test

**File**: `packages/database/src/__tests__/cascade-delete-modules.test.ts` (ExternalAgentConfig + MCPServerConfig added to mock registries; see also `mongo-cascade.test.ts`)

**Setup**:

- `setupTestMongo()`
- Create Projects P1, P2
- Create 3 `ExternalAgentConfig` documents for P1, 2 for P2

**Test**:

- Call `deleteProject(P1)`
- Assert: `countDocuments({ projectId: P1 }) === 0`
- Assert: `countDocuments({ projectId: P2 }) === 2`

---

## 6. Performance & Load Tests

Deferred for Phase 1. The index `{tenantId, projectId, name}` ensures O(1) lookup. Expected latency <2ms for registry lookup.

**Post-implementation validation**: Verify with 100 concurrent handoffs against a project with 50 registered agents. Target: p99 < 5ms for registry lookup.

---

## 7. Test Infrastructure

### Required Services

| Service              | Provider               | Used By              | Setup                                                  |
| -------------------- | ---------------------- | -------------------- | ------------------------------------------------------ |
| MongoDB              | MongoMemoryServer      | All tests            | Via `startRuntimeServerHarness()` / `setupTestMongo()` |
| Encryption (runtime) | Runtime test keys      | All tests            | Via `initializeRuntimeTestEncryption()` in harness     |
| Runtime HTTP server  | Express on random port | E2E + integration    | Via `startRuntimeServerHarness()` with `{ port: 0 }`   |
| In-process A2A stub  | Custom HTTP server     | E2E-2/3/4/7, INT-3/4 | Via `createAgentStub()` helper                         |
| Redis                | NOT required           | —                    | External agent registry does not use Redis             |

### A2A Stub Server Helper

**Check first**: `apps/runtime/src/__tests__/helpers/mock-a2a-remote-agent.ts` already exists — evaluate for extension to serve `/.well-known/agent-card.json` before creating a new helper.

If creating new `apps/runtime/src/__tests__/helpers/a2a-stub-server.ts`:

```typescript
export interface StubCallRecord {
  method: string;
  headers: Record<string, string>; // normalized to lowercase
  body: unknown;
}

export interface AgentStub {
  url: string;
  calls: StubCallRecord[];
  setAgentCard(card: object): void;
  setCardStatus(status: number): void;
  close(): Promise<void>;
}

export async function createAgentStub(agentCard?: object): Promise<AgentStub>;
// Serves /.well-known/agent-card.json
// Records POST requests with headers + body
// Configurable card content and HTTP status
// Listens on 127.0.0.1:0 (random port)
```

### SSRF Test Environment Configuration

`SsrfEndpointValidator.validate()` accepts `allowPrivate: boolean`. Tests that use in-process stubs on `127.0.0.1` must use `startRuntimeServerHarness({ allowPrivateEndpoints: true })`. INT-4 (SSRF rejection tests) must use harness WITHOUT this option (separate `describe` block).

Note: No `SSRF_ALLOWED_HOSTS` environment variable exists in the codebase.

### Data Seeding Helpers

```typescript
// apps/runtime/src/__tests__/helpers/external-agent-helpers.ts
export async function registerExternalAgent(
  harness: RuntimeApiHarness,
  token: string,
  projectId: string,
  config: {
    name: string;
    endpoint: string;
    protocol?: 'a2a' | 'rest';
    authType?: 'none' | 'bearer' | 'api_key';
    authConfig?: { value: string; header?: string }; // field is `header`, not `headerName`
  },
): Promise<{ id: string; item: object }>;
```

### Environment Variables

No new environment variables for production or tests. SSRF private-endpoint bypass is controlled via `{ allowPrivateEndpoints: true }` harness option at test setup time.

---

## 8. Test File Mapping

| File                                                                    | Type             | Coverage                                                                    |
| ----------------------------------------------------------------------- | ---------------- | --------------------------------------------------------------------------- |
| `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`        | e2e              | FR-1/3/5/6/11; E2E-1 through E2E-8                                          |
| `apps/runtime/src/__tests__/external-agents-integration.test.ts`        | integration      | FR-1/2/3/4/5/11; INT-1 through INT-5, INT-7                                 |
| `apps/runtime/src/__tests__/external-agent-registry-resolution.test.ts` | integration+unit | FR-6/12; INT-6/8, UT-3 (targets `enrichWithRegistryAuth` per LLD D-2)       |
| `apps/studio/src/__tests__/external-agents-api.test.ts`                 | integration      | FR-7 (proxy): Studio → Runtime proxy, credential masking at Studio boundary |
| `packages/database/src/models/__tests__/external-agent-config.test.ts`  | unit             | FR-2; UT-1                                                                  |
| `packages/database/src/__tests__/cascade-delete-modules.test.ts`        | integration      | Section 5 (cascade delete) — ExternalAgentConfig + MCPServerConfig          |
| `apps/runtime/src/__tests__/helpers/mock-a2a-remote-agent.ts`           | test helper      | Extended with `getReceivedHeaders()` + configurable responses               |
| `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`             | test helper      | Extended with `allowPrivateEndpoints` + `ALLOW_SSRF_PRIVATE_RANGES`         |

---

## 9. Open Testing Questions

1. **SSRF and in-process stubs**: RESOLVED — `SsrfEndpointValidator.validate()` accepts `allowPrivate: boolean`. Harness extended to accept `{ allowPrivateEndpoints: true }`. INT-4 uses harness without this option.

2. **Cascade delete gap for MCPServerConfig**: `deleteProject()` does not currently include `MCPServerConfig` deletion. Should this implementation also fix that gap? DECISION: Deferred — only add `ExternalAgentConfig` to cascade delete. MCPServerConfig gap is a separate issue (GAP-004 in feature spec).

3. **enrichWithRegistryAuth DI approach**: `RoutingExecutor` accepts `LookupExternalAgent` as an optional 3rd constructor parameter (implemented in Phase 3). Tests use this injectable to test `enrichWithRegistryAuth()` without `vi.mock`.

4. **Auth header case sensitivity in stubs**: HTTP headers are case-insensitive per RFC 7230. Stub validation should use case-insensitive comparison. The `a2a-stub-server.ts` helper normalizes all recorded headers to lowercase.
