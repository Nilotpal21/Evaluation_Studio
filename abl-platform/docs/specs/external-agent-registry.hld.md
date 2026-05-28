# HLD: External Agent Registry

**Feature Spec**: `docs/features/external-agent-registry.md`
**Test Spec**: `docs/testing/external-agent-registry.md`
**Status**: DONE
**Author**: Prasanna Arikala
**Date**: 2026-04-28

---

## 1. Problem Statement

Three gaps block production use of authenticated remote A2A handoffs:

1. **Auth gap**: `resolveRemoteFromHandoff()` at `apps/runtime/src/services/execution/agent-lookup.ts:92`
   builds `AgentRegistryEntry` from session IR only. The IR deliberately omits `auth.value` (it holds
   `auth.type` and `auth.header` but the credential value is never serialised into IR). Consequently
   `createClientForAgent()` always falls through to the unauthenticated path even when the remote agent
   requires a bearer token or API key.

2. **Discovery gap**: No Studio surface exists to list, register, or verify remote agent endpoints.
   Developers must configure endpoints and auth credentials directly in DSL without any feedback on
   reachability or available skills.

3. **Health gap**: No connection-state tracking exists for remote agent endpoints. Operators cannot see
   whether a remote agent is reachable, when it was last verified, or what error occurred.

This feature closes all three gaps with a project-scoped registry backed by the existing
`encryptionPlugin`/`tenantIsolationPlugin` stack, a new runtime lookup step in the handoff path, a
Studio management surface, and an agent-editor autocomplete integration.

---

## 2. Alternatives Considered

### Option A: Inline DSL Encryption (Rejected)

Extend the ABL DSL to allow credential placeholders (e.g., `AUTH_TOKEN: {{secrets.MY_TOKEN}}`), resolved
at compile time and injected into IR.

- **Pros**: No new runtime DB lookup; credentials stay in the compile artifact.
- **Cons**: Secrets appear in IR (stored in MongoDB, logged in traces, transmitted to SDK clients).
  Rotation requires recompile + redeploy. No centralized management surface. Violates the "credentials
  never in IR" invariant already established for LLM provider keys.
- **Effort**: M — requires compiler changes, new secret-resolution pipeline, masking in all trace
  surfaces.

### Option B: Project Secrets Table (Rejected)

Store remote agent credentials as generic project secrets (alongside the existing env-var store), keyed
by a user-assigned variable name, referenced by a new DSL directive.

- **Pros**: Reuses existing encrypted secret storage.
- **Cons**: Loses structural typing (endpoint, protocol, auth type, health fields). No agent card
  discovery. No connection-status tracking. No Skills panel. The "generic secret" model does not model
  the "external agent" concept — operators cannot see which agents are registered at a glance.
- **Effort**: S — but delivers < 30% of FR coverage.

### Option C: Project-Scoped Registry Collection (Chosen)

A dedicated `external_agent_configs` MongoDB collection with `tenantIsolationPlugin` and
`encryptionPlugin`, CRUD routes on the runtime, Studio proxy + UI, and a minimal lookup injection in
`resolveRemoteFromHandoff()`.

- **Pros**: Full structural typing for endpoint, protocol, auth, and health fields. Agent card discovery
  and skill caching. Connection-status monitoring. Clean registry-takes-precedence / inline-fallback
  semantics. Directly follows the `mcp-server-config.model.ts` reference pattern — minimal novel code.
  Backward-compatible: existing DSL with inline `ENDPOINT:` is unaffected when no registry entry exists.
- **Cons**: Adds one MongoDB round-trip to the handoff hot path (mitigated by indexed lookup; cache in
  Phase 2 if needed).
- **Effort**: L (7–8 tasks, all incremental changes to existing patterns).

**Recommendation**: Option C.

**Rationale**: The hot-path cost is a single indexed MongoDB query (<2 ms p99 at project scale). The
structural richness — encrypted credential storage, agent card caching, connection health — is not
achievable without a dedicated collection. The `mcp-server-config.model.ts` reference pattern reduces
novel code to near zero for the data layer. The risk of the globalThis.fetch monkey-patching in
`createA2AClientWithAuth()` → `createAuthenticatedA2AClient()` is unchanged (it already runs in
production for inline-auth cases).

---

## 3. Architecture

### System Context Diagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  Studio (Next.js)                                                           │
│                                                                             │
│  ┌─────────────────────────────┐   ┌───────────────────────────────────┐   │
│  │  External Agents List Page  │   │  Agent Editor (Monaco/ABL)        │   │
│  │  - Status badges            │   │  - HANDOFF TO: autocomplete       │   │
│  │  - Register modal           │   │  - Advisory warning (unregistered)│   │
│  │  - Edit panel + Skills      │   └──────────────┬────────────────────┘   │
│  └─────────────────────────────┘                  │                        │
│         │ proxy (all 6 ops)                       │ GET /external-agents   │
│         ▼                                         ▼                        │
│  ┌─────────────────────────────────────────────────────────────────────┐   │
│  │  Studio API Routes (/api/projects/[id]/external-agents/*)           │   │
│  │  Proxy only — forwards token, no business logic                     │   │
│  └────────────────────────────────────┬────────────────────────────────┘   │
└───────────────────────────────────────┼─────────────────────────────────────┘
                                        │ HTTP (internal)
                                        ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  Runtime (Express)                                                          │
│                                                                             │
│  ┌────────────────────────────────────────────────────────────────────┐    │
│  │  /api/projects/:projectId/external-agents (CRUD + test-connection) │    │
│  │  - createUnifiedAuthMiddleware + requireProjectPermission          │    │
│  │  - SsrfEndpointValidator.validate(url, allowPrivate)               │    │
│  │  - discoverAgent() from @abl/a2a (/.well-known/agent-card.json)    │    │
│  └─────────────────────────────────┬──────────────────────────────────┘    │
│                                    │                                        │
│  ┌────────────────────────────────┐│  ┌───────────────────────────────┐    │
│  │  ExternalAgentConfigRepo       ││  │  resolveRemoteFromHandoff()   │    │
│  │  findByName(t,p,name) ────────►│└─►│  + injectable lookupFn param  │    │
│  │  CRUD helpers                  │   │  + decryptedAuth injection     │    │
│  └────────────────────────────────┘   └──────────────┬────────────────┘    │
│                                                      │                     │
│  ┌────────────────────────────────────────────────────▼──────────────┐    │
│  │  createClientForAgent() → createA2AClientWithAuth()               │    │
│  │  (unchanged — already consumes auth.value when present)           │    │
│  └────────────────────────────────────────────────────────────────────┘    │
└─────────────────────────────────────────────────────────────────────────────┘
                    │                                │
                    ▼                                ▼
             MongoDB                        Remote A2A Agent
        external_agent_configs              /.well-known/agent-card.json
        (tenantIsolation + encryption)      + remote task endpoint
```

### Component Diagram

```
packages/database
  └── models/
        └── external-agent-config.model.ts   ← new; mirrors mcp-server-config.model.ts
  └── cascade/
        └── cascade-delete.ts                ← add ExternalAgentConfig to deleteProject()

apps/runtime
  └── src/routes/
        └── external-agents.ts               ← new; 6 route handlers
  └── src/services/execution/
        └── agent-lookup.ts                  ← extend resolveRemoteFromHandoff()
  └── src/__tests__/helpers/
        └── runtime-api-harness.ts           ← add allowPrivateEndpoints option

apps/studio
  └── src/app/api/projects/[id]/external-agents/
        └── route.ts                         ← new; proxy POST/GET list
  └── src/app/api/projects/[id]/external-agents/[agentId]/
        └── route.ts                         ← new; proxy GET/PATCH/DELETE
        └── test-connection/route.ts         ← new; proxy POST test-connection
  └── src/components/external-agents/
        └── ExternalAgentsPage.tsx            ← new; list + status badges
        └── RegisterExternalAgentModal.tsx    ← new; registration form
        └── ExternalAgentEditPanel.tsx        ← new; edit + skills display
  └── src/components/abl/
        └── ABLEditor.tsx                    ← extend loadAgentsForContext()
```

### Data Flow

#### Registration Flow

```
1. User submits Registration Modal in Studio
2. Studio /api/projects/[id]/external-agents POST → forwards to Runtime
3. Runtime POST handler:
   a. requireProjectPermission('external_agent:create')
   b. Validate body (Zod schema)
   c. SsrfEndpointValidator.validate(endpoint, allowPrivate=false) → 400 if fails
   d. ExternalAgentConfigRepo.create({tenantId, projectId, name, endpoint, ...})
   e. discoverAgent({endpoint, tenantId}, deps) from packages/a2a → non-blocking
      - 5 s timeout enforced via AbortController signal passed in deps (or Promise.race)
      - Success: update lastDiscoveredCard, lastConnectionStatus='connected', latency
      - Failure: update lastConnectionStatus='failed', lastConnectionError
   f. Return 201 with masked response (no encryptedAuthConfig, add authConfigured)
```

#### Runtime Handoff Resolution Flow

```
1. Agent executes HANDOFF TO: <agentName> (LOCATION: remote)
2. lookupAgentForSession() calls resolveRemoteFromHandoff(session, agentName, lookupFn)
3. resolveRemoteFromHandoff():
   a. lookupFn(tenantId, projectId, agentName) → ExternalAgentConfig | null
   b. If found: build AgentRegistryEntry using registry endpoint + inject auth
      - authType 'none': set remote.auth = undefined → createClientForAgent() uses
        unauthenticated createA2AClient path (guard: auth?.type && auth?.value at routing-executor.ts:1626)
      - authType 'bearer' | 'api_key': decrypt encryptedAuthConfig, populate
        remote.auth = { type, value, header? } in AgentRegistryEntry
      Emit TraceEvent: {agentName, registryHit: true, endpoint, authType, NO credentials}
   c. If not found: fall back to inline IR endpoint (current behaviour)
      Emit TraceEvent: {agentName, registryHit: false, endpoint: inline_or_null, authType}
   d. If neither: return undefined → existing 'Agent not found' path in routing-executor
4. createClientForAgent() consumes populated auth.value via createA2AClientWithAuth()
   (unchanged code path — already handles auth.value when present)
```

#### Test-Connection Flow

```
1. User clicks "Test Connection" in Studio Edit Panel
2. Studio proxy POST → Runtime /external-agents/:id/test-connection
3. Runtime handler:
   a. requireProjectPermission('external_agent:update')
   b. discoverAgent({endpoint: entry.endpoint, tenantId}, deps) from packages/a2a (5 s timeout via AbortController)
   c. Patch entry: lastConnectionStatus, lastConnectionAt, latency, lastConnectionError
   d. Return 200 with updated masked entry
```

### Sequence Diagram — Runtime Handoff with Registry Auth

```
routing-executor        resolveRemote    ExternalAgentConfigRepo     MongoDB
       │                FromHandoff()           │                       │
       │──── lookupAgent ──►│                  │                       │
       │     ForSession()   │                  │                       │
       │                    │── findByName ───►│                       │
       │                    │   (t, p, name)   │──── findOne ─────────►│
       │                    │                  │◄─── doc (decrypted) ──│
       │                    │◄─── config ──────│                       │
       │                    │                  │                       │
       │                    │ inject auth.value │                       │
       │                    │ emit TraceEvent   │                       │
       │◄─── AgentRegistry ─│                  │                       │
       │     Entry (+ auth) │                  │                       │
       │                    │                  │                       │
       │── createClient ───►│ (unchanged)       │                       │
       │   ForAgent() →     │                  │                       │
       │   createA2AClient  │                  │                       │
       │   WithAuth()       │                  │                       │
       │── sendTask ───────────────────────────────────► Remote Agent  │
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | All queries include `tenantId` via `tenantIsolationPlugin` (auto-injected). Route handlers also pass explicit `tenantId: req.user.tenantId`. Cross-tenant access returns 404 (not 403) — same pattern as MCP servers.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| 2   | **Data Access Pattern** | `ExternalAgentConfigRepo` class with typed methods: `create`, `findById`, `findByProjectId`, `findByName(tenantId, projectId, name)`, `update`, `delete`. The runtime handoff path calls `findByName` via injectable function parameter with this signature: `type LookupExternalAgent = (tenantId: string, projectId: string, name: string) => Promise<{ endpoint: string; protocol: string; authType: string; encryptedAuthConfig?: string } \| null>`. The `encryptionPlugin` auto-decrypts on read — the returned `encryptedAuthConfig` is the plaintext JSON string `{ value, header? }`. No direct model access outside the repo class. |
| 3   | **API Contract**        | REST routes at `/api/projects/:projectId/external-agents` (runtime) and `/api/projects/[id]/external-agents` (Studio proxy). Responses use the `{ success, data?, error? }` envelope. `encryptedAuthConfig` never appears in responses; replaced by `authConfigured: boolean`. Error codes: `SSRF_REJECTED`, `AGENT_NOT_FOUND`, `CARD_FETCH_FAILED` (informational, not error status).                                                                                                                                                                                                                                                        |
| 4   | **Security Surface**    | (a) SSRF: `SsrfEndpointValidator.validate(url, false)` on every create/update before any outbound fetch. (b) Encryption: `encryptionPlugin` with `scope:'project'` DEK for `encryptedAuthConfig`. (c) Auth: `requireProjectPermission('external_agent:*')` on every route. (d) Credential masking: `encryptedAuthConfig` stripped before serialisation, `authConfigured` added. (e) Trace events never include `auth.value`.                                                                                                                                                                                                                  |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                              |
| --- | ----------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | Registration: SSRF rejection → 400 `{code: 'SSRF_REJECTED', message: '...'}`. Card fetch failure → 201 with `lastConnectionStatus: 'failed'` (non-blocking). Auth decryption failure in runtime → hard-fail handoff with sanitized message; log raw error. Duplicate name → 409 `{code: 'DUPLICATE_NAME'}`. Not found → 404. |
| 6   | **Failure Modes** | Card fetch timeout (5 s budget): registration still succeeds, `lastConnectionStatus: 'failed'`. Registry lookup failure (MongoDB down): `resolveRemoteFromHandoff()` throws → existing `handleHandoffFailure()` path in `routing-executor.ts:887`. No circuit-breaker in Phase 1 — MongoDB availability is platform-wide.    |
| 7   | **Idempotency**   | POST create is not idempotent — duplicate `name` returns 409. PATCH update and POST test-connection are idempotent. DELETE is idempotent (returns 404 on second call). No upsert endpoints in Phase 1.                                                                                                                       |
| 8   | **Observability** | `TraceEvent` emitted per registry lookup: `{type: 'registry_lookup', agentName, registryHit, endpoint, authType}` — no credential value. `createLogger('external-agents')` used in route handlers. Card-fetch latency stored in `lastConnectionLatencyMs`. Hot-path lookup latency measurable via existing trace spans.      |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| --- | ---------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 9   | **Performance Budget** | Registry lookup: single indexed MongoDB query `{tenantId, projectId, name}` — unique index ensures O(1) scan. Expected <2 ms p99. No in-memory cache in Phase 1 (Phase 2 LRU TTL cache if benchmarks show need). Card fetch: 5 s timeout, server-side only. Studio proxy adds one internal HTTP hop per operation.                                                                                                                                                            |
| 10  | **Migration Path**     | Purely additive. Existing inline `ENDPOINT:`/`PROTOCOL:` DSL continues to work unchanged. `enrichWithRegistryAuth()` (in `handleHandoff()`) tries registry first, falls back to inline on miss. No schema migration required — new collection created on first write. `ENCRYPTION_MASTER_KEY` must be set (already required by server startup check at `server.ts:~1963`). _Post-impl-sync: feature spec corrected from `RUNTIME_ENCRYPTION_KEY` to `ENCRYPTION_MASTER_KEY`._ |
| 11  | **Rollback Plan**      | Feature flag not required — the new code path (`findByName()`) returns `null` for all existing handoffs (collection is empty on rollout), falling through to inline handling unchanged. If the collection has data and a rollback is needed: (a) disable runtime routes (remove route registration), (b) `resolveRemoteFromHandoff()` will fall back to inline. Zero-downtime rollback.                                                                                       |
| 12  | **Test Strategy**      | E2E (8 scenarios): real runtime server + HTTP API, in-process A2A stub, `bootstrapProject()`. Integration (8 scenarios): real Express + MongoDB, SSRF rejection, cascade delete, cross-tenant isolation. Unit (3 groups): `resolveRemoteFromHandoff()` with injected fake repo, credential masking, SSRF validator. See `docs/testing/external-agent-registry.md` for full scenarios.                                                                                         |

---

## 5. Data Model

### New Collections

#### `external_agent_configs`

```typescript
{
  _id: string;                          // uuidv7()
  tenantId: string;                     // required — tenantIsolationPlugin
  projectId: string;                    // required — project scope
  name: string;                         // required, unique per {tenantId,projectId}, ABL identifier
  displayName?: string;                 // optional human-readable label
  endpoint: string;                     // required, URL, SSRF-validated before store
  protocol: 'a2a' | 'rest';            // required
  authType: 'none' | 'bearer' | 'api_key'; // required
  encryptedAuthConfig?: string;         // Mongoose String — encryptionPlugin encrypts/decrypts as
                                        // a whole. Plaintext is JSON: { value: string, header?: string }
                                        // where header is the custom header name (api_key only).
  lastDiscoveredCard?: object;          // cached agent card JSON (A2A only)
  lastConnectionStatus: 'connected' | 'failed' | null;  // null = never tested; deliberate divergence
                                        // from MCP reference ('untested' string) — feature spec uses
                                        // null for the initial state, which is idiomatic MongoDB default.
  lastConnectionAt?: Date;
  lastConnectionLatencyMs?: number;
  lastConnectionError?: string;
  createdBy: string;                    // userId
  modifiedBy: string;                   // userId
  createdAt: Date;
  updatedAt: Date;
}
```

**Indexes**:

- `{ tenantId: 1, projectId: 1, name: 1 }` — unique (primary lookup index for registry resolution)
- `{ tenantId: 1, projectId: 1 }` — non-unique (list queries)
- `{ tenantId: 1 }` — auto-added by `tenantIsolationPlugin`

**Plugins applied** (identical pattern to `mcp-server-config.model.ts`):

```typescript
schema.plugin(tenantIsolationPlugin);
schema.plugin(encryptionPlugin, {
  fieldsToEncrypt: ['encryptedAuthConfig'],
  scope: 'project',
  scopeFields: { tenantId: 'tenantId', projectId: 'projectId' },
});
```

### Modified Collections

None — purely additive.

### Key Relationships

```
Project (project_configs)
  └── 0..N ExternalAgentConfig (external_agent_configs)
        └── 0..N Skills (embedded in lastDiscoveredCard JSON, not a separate collection)

Tenant (tenant_configs)
  └── N..N ExternalAgentConfig (via tenantId field + tenantIsolationPlugin)
```

Cascade delete: `deleteProject()` in `packages/database/src/cascade/cascade-delete.ts` extended to
`ExternalAgentConfig.deleteMany({ projectId })`. Also added to `deleteTenant()` via
`ExternalAgentConfig.deleteMany({ tenantId })`.

---

## 6. API Design

### New Endpoints (Runtime)

| Method | Path                                                           | Purpose                            | Permission              |
| ------ | -------------------------------------------------------------- | ---------------------------------- | ----------------------- |
| POST   | `/api/projects/:projectId/external-agents`                     | Register new external agent        | `external_agent:create` |
| GET    | `/api/projects/:projectId/external-agents`                     | List external agents for project   | `external_agent:read`   |
| GET    | `/api/projects/:projectId/external-agents/:id`                 | Get single external agent          | `external_agent:read`   |
| PATCH  | `/api/projects/:projectId/external-agents/:id`                 | Update external agent              | `external_agent:update` |
| DELETE | `/api/projects/:projectId/external-agents/:id`                 | Delete external agent              | `external_agent:delete` |
| POST   | `/api/projects/:projectId/external-agents/:id/test-connection` | Re-fetch agent card, update status | `external_agent:update` |

### New Endpoints (Studio Proxy)

All six routes are thin proxies — they forward the incoming request (with the Studio session token) to
the corresponding Runtime endpoint and stream the response back. No business logic lives in Studio routes.

> **Design note — deliberate divergence from MCP server pattern**: MCP server routes in Studio access the
> database directly via `@agent-platform/shared/repos`. External agent routes proxy to the Runtime
> because SSRF validation, `encryptionPlugin`, and agent card discovery (`discoverAgent()`) all live in
> the Runtime. Proxying is the correct separation. Studio uses the existing `proxyToRuntime` helper from
> `@/lib/runtime-proxy` (already used by human-tasks and tenant-models routes).

| Method | Path                                                           | Proxied To (Runtime)                                        |
| ------ | -------------------------------------------------------------- | ----------------------------------------------------------- |
| POST   | `/api/projects/[id]/external-agents`                           | Runtime POST `/api/projects/:id/external-agents`            |
| GET    | `/api/projects/[id]/external-agents`                           | Runtime GET `/api/projects/:id/external-agents`             |
| GET    | `/api/projects/[id]/external-agents/[agentId]`                 | Runtime GET `/api/projects/:id/external-agents/:agentId`    |
| PATCH  | `/api/projects/[id]/external-agents/[agentId]`                 | Runtime PATCH `/api/projects/:id/external-agents/:agentId`  |
| DELETE | `/api/projects/[id]/external-agents/[agentId]`                 | Runtime DELETE `/api/projects/:id/external-agents/:agentId` |
| POST   | `/api/projects/[id]/external-agents/[agentId]/test-connection` | Runtime POST `.../:agentId/test-connection`                 |

### Request / Response Shapes

**POST /external-agents — Create**

```typescript
// Request body
{
  name: string;                          // ABL identifier, unique in project
  displayName?: string;
  endpoint: string;                      // URL
  protocol: 'a2a' | 'rest';
  authType: 'none' | 'bearer' | 'api_key';
  authConfig?: { value: string; header?: string };  // write-only, encrypted at rest; header = custom header name (api_key only)
}

// Response 201
{
  success: true,
  data: ExternalAgentConfigView    // see masking section below
}
```

**GET /external-agents — List**

No pagination in Phase 1. Returns all entries for the project (expected: 1–50 per project). No filter/sort
query parameters. Response: `{ success: true, data: ExternalAgentConfigView[] }`.

**PATCH /external-agents/:id — Update**

```typescript
// Request body (all fields optional, partial update)
{
  displayName?: string;
  endpoint?: string;          // SSRF re-validated when changed
  protocol?: 'a2a' | 'rest';
  authType?: 'none' | 'bearer' | 'api_key';
  authConfig?: { value: string; header?: string } | null; // null clears credentials
}
// Immutability: `name` is NOT updatable after creation (it is the registry lookup key).
// Auth clearing: setting authType to 'none' or authConfig to null clears encryptedAuthConfig.
// SSRF: endpoint changes are re-validated before saving.
```

**ExternalAgentConfigView (response shape — all endpoints)**

```typescript
{
  id: string;
  name: string;
  displayName?: string;
  endpoint: string;
  protocol: 'a2a' | 'rest';
  authType: 'none' | 'bearer' | 'api_key';
  authConfigured: boolean;               // true when encryptedAuthConfig exists
  // encryptedAuthConfig: NEVER present
  lastDiscoveredCard?: object;
  lastConnectionStatus: 'connected' | 'failed' | null;
  lastConnectionAt?: string;
  lastConnectionLatencyMs?: number;
  lastConnectionError?: string;
  createdBy: string;
  modifiedBy: string;
  createdAt: string;
  updatedAt: string;
}
```

### Error Responses

| Code                | HTTP Status | Condition                                                     |
| ------------------- | ----------- | ------------------------------------------------------------- |
| `SSRF_REJECTED`     | 400         | Endpoint URL resolves to a private/internal IP                |
| `INVALID_PROTOCOL`  | 400         | Protocol not `a2a` or `rest`                                  |
| `INVALID_AUTH_TYPE` | 400         | Auth type not `none`, `bearer`, or `api_key`                  |
| `DUPLICATE_NAME`    | 409         | Name already exists in `{tenantId, projectId}`                |
| `NOT_FOUND`         | 404         | Agent config not found (or cross-tenant/cross-project access) |
| `FORBIDDEN`         | 403         | Missing `external_agent:*` permission                         |

---

## 7. Cross-Cutting Concerns

- **Audit Logging**: `createdBy` and `modifiedBy` fields on every write. No separate audit event stream in Phase 1 (deferred per feature spec Non-Goals).
- **Rate Limiting**: Inherits existing per-project rate limits on `/api/projects/:projectId/*` routes. Card fetch (test-connection) has an additional 5 s timeout enforced server-side.
- **Caching**: No in-memory cache in Phase 1. `lastDiscoveredCard` is a server-side document cache. Phase 2: LRU TTL cache for `findByName()` hot-path lookups.
- **Encryption**: `encryptionPlugin` with project-scoped DEK handles `encryptedAuthConfig`. Master key validated at server startup (`server.ts:~1963` — throws if `ENCRYPTION_MASTER_KEY` absent). No new key management required.
- **SSRF**: `SsrfEndpointValidator.validate(url, allowPrivate)` called on every create/update/test-connection before any outbound fetch. `allowPrivate: false` in production. Test harness extended with `allowPrivateEndpoints?: boolean` option to enable `allowPrivate: true` for in-process stub servers in E2E tests.
- **Trace Events**: `TraceEvent` per registry lookup — `{agentName, registryHit, endpoint, authType}`. Explicitly excludes `auth.value`. Follows existing `TraceStore` patterns in `agent-lookup.ts`.
- **User-Facing Error Sanitization**: Auth decryption errors logged with full context (`log.error`) but surfaced to users as `"Agent not found: {name}"` per CLAUDE.md sanitization rules.

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                                                       | Type                                  | Risk                                                                               |
| ---------------------------------------------------------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| `packages/database` — `encryptionPlugin`                         | Existing package plugin               | Low — stable, used by MCPServerConfig                                              |
| `packages/database` — `tenantIsolationPlugin`                    | Existing package plugin               | Low — stable, used by all collections                                              |
| `packages/database` — `cascade-delete.ts`                        | Extension to existing module          | Low — additive only                                                                |
| `packages/a2a` — `createA2AClientWithAuth()` / `discoverAgent()` | Existing functions                    | Low — unchanged; registry just provides the `auth.value` the factory already reads |
| `apps/runtime` — `SsrfEndpointValidator`                         | Existing class                        | Low — `allowPrivate` param already exists                                          |
| `apps/runtime` — `requireProjectPermission()`                    | Existing middleware                   | Low — new permission names follow existing convention                              |
| `apps/runtime` — `startRuntimeServerHarness()`                   | Test helper extension                 | Medium — `allowPrivateEndpoints` option must be added                              |
| `apps/studio` — `ABLEditor.tsx`                                  | Extension to `loadAgentsForContext()` | Low — additive parallel fetch                                                      |

### Downstream (depends on this feature)

| Consumer                                                             | Impact                                                    |
| -------------------------------------------------------------------- | --------------------------------------------------------- |
| `resolveRemoteFromHandoff()` callers (via `lookupAgentForSession()`) | New optional DB lookup per handoff; no API change         |
| Studio Agent Editor (`ABLEditor.tsx`)                                | New autocomplete completions from registry                |
| Agent editors using `HANDOFF TO:` with `LOCATION: remote`            | Advisory warning if target not in registry (non-blocking) |

---

## 9. Open Questions & Decisions Needed

1. **Permission naming**: `external_agent:create/read/update/delete` follows the `<resource>:<operation>` convention. These permissions do not yet exist in the platform permission registry. They must be added before the route guards compile. Confirm with platform team whether a migration is needed or if permissions are registered dynamically.

2. ~~**Studio proxy auth forwarding**~~ **RESOLVED**: The existing `proxyToRuntime` helper from
   `@/lib/runtime-proxy` (used by human-tasks and tenant-models Studio routes) handles auth forwarding.
   All external agent Studio proxy routes will use this helper.

3. **Phase 2 LRU cache boundary**: If Phase 1 MongoDB benchmarks show the `findByName()` index query adds >5 ms to high-throughput handoff paths, Phase 2 should add an LRU cache with a short TTL (e.g., 30 s) per `{tenantId, projectId, name}`. The cache invalidation boundary must be: PATCH or DELETE on the registry entry clears the cached entry. This is tracked as GAP-003 in the feature spec.

---

## 10. References

- Feature spec: `docs/features/external-agent-registry.md`
  > Note: Feature spec previously used `headerName` — corrected to `header` (matching
  > `OutboundAuthConfig.header` at `authenticated-client-factory.ts:57`) during post-impl-sync.
  > Note: Feature spec previously referenced `RUNTIME_ENCRYPTION_KEY` — corrected to
  > `ENCRYPTION_MASTER_KEY` during post-impl-sync.
- Test spec: `docs/testing/external-agent-registry.md`
- Related HLD: `docs/specs/a2a-integration.hld.md`
- Reference data model: `packages/database/src/models/mcp-server-config.model.ts`
- Auth injection factory: `packages/a2a/src/infrastructure/authenticated-client-factory.ts`
- Current handoff resolution: `apps/runtime/src/services/execution/agent-lookup.ts:92`
- Current client creation: `apps/runtime/src/services/execution/routing-executor.ts:1622`
- Cascade delete: `packages/database/src/cascade/cascade-delete.ts:222`
- SSRF validator: search `SsrfEndpointValidator` in `apps/runtime/src/`
- Test harness: `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`

---

## 11. Post-Implementation Notes

**D-2 Deviation: Auth injection moved from `resolveRemoteFromHandoff()` to `enrichWithRegistryAuth()` in `handleHandoff()`**

The HLD (Sections 3, 4, and sequence diagram) describes auth injection happening inside `resolveRemoteFromHandoff()`. During LLD phase, `lookupAgentForSession()` was found to have ~20 synchronous call sites in `routing-executor.ts`. Making `resolveRemoteFromHandoff()` async would cascade all of them. Instead, auth injection was implemented as `enrichWithRegistryAuth()` — a private async method on `RoutingExecutor` called in `handleHandoff()` (which is already async). The `LookupExternalAgent` function is injected via RoutingExecutor's constructor (optional 3rd parameter, default `undefined`).

**Stale references in this HLD**: Sections 3 (data flow, sequence diagram), 4 (concern #2 data access pattern, #10 migration path, #11 rollback plan) reference `resolveRemoteFromHandoff()` as the integration point. The actual integration point is `enrichWithRegistryAuth()` in `handleHandoff()` at `routing-executor.ts`.

**handleFanOut gap (D-9)**: `handleFanOut` at line ~4239 has its own `lookupAgentForSession` + `createClientForAgent` path bypassing `handleHandoff`. This path is NOT enriched with registry auth. Fan-out with authenticated external registry agents requires a separate future iteration. Tracked as GAP-006 in the feature spec.

**Env var correction**: Section 10 of this HLD correctly identified that the feature spec referenced `RUNTIME_ENCRYPTION_KEY` when the correct env var is `ENCRYPTION_MASTER_KEY`. This has been corrected in the feature spec during post-impl-sync.
