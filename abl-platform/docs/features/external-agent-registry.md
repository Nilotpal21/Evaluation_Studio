# Feature: External Agent Registry

**Doc Type**: MAJOR FEATURE
**Parent Feature**: [A2A Integration](a2a-integration.md)
**Status**: ALPHA
**Feature Area(s)**: `agent lifecycle`, `integrations`, `admin operations`
**Package(s)**: `packages/database`, `apps/runtime`, `apps/studio`, `packages/compiler`
**Owner(s)**: `Platform team`
**Testing Guide**: [docs/testing/external-agent-registry.md](../testing/external-agent-registry.md)
**Last Updated**: 2026-04-28

---

## 1. Introduction / Overview

### Problem Statement

Three gaps exist in the current remote agent integration story:

1. **Auth gap** _(fixed)_: `resolveRemoteFromHandoff()` at `agent-lookup.ts:92` intentionally leaves `auth.value` absent (credentials are never serialised into IR). The runtime had no way to inject credentials for remote A2A endpoints requiring authentication. Fixed by `enrichWithRegistryAuth()` in `handleHandoff()` (see §7, FR-6).
2. **Discovery gap**: There is no Studio surface to list, verify, or browse remote agents that a project's agents can hand off to. Developers must manually configure endpoints and auth in DSL without any feedback on whether those endpoints are reachable.
3. **Health gap**: There is no connection-state tracking for remote agent endpoints. Operators cannot see if a remote agent is reachable, when it was last verified, or what error occurred on the last attempt.

### Goal Statement

Provide a project-scoped External Agent Registry in Studio where developers and operators can register remote agent endpoints (name, endpoint URL, protocol, auth credentials), fetch and display the remote agent's card and skills, and track connection health. The runtime resolves registered agents during `HANDOFF TO:` execution and injects encrypted credentials automatically. The agent editor provides autocomplete for registered agent names.

### Summary

The External Agent Registry is a project-scoped CRUD surface for managing remote agent endpoints. Each entry stores a name (unique within the project), endpoint URL, protocol (`a2a` or `rest`), auth type (`none`, `bearer`, or `api_key`), and encrypted auth credentials. On registration and on-demand test-connection, the system fetches the remote agent's card (for A2A endpoints) and stores discovered skills, connection status, latency, and any error.

At runtime, `enrichWithRegistryAuth()` (called within `handleHandoff()`) looks up the registry by `{tenantId, projectId, name}` and injects decrypted credentials into the `AgentRegistryEntry` before remote dispatch. Registry entries take precedence over inline `ENDPOINT:` in the DSL, falling back to inline when no registry entry exists.

Studio provides a list page with status badges, a registration modal, an edit panel with skills display, and `HANDOFF TO:` autocomplete in the agent editor. An advisory (non-blocking) warning appears in the editor when a `HANDOFF TO:` target with `LOCATION: remote` has no matching registry entry.

---

## 2. Scope

### Goals

- Project-scoped CRUD for external agent configurations with encrypted credential storage
- Agent card discovery on registration and on-demand test-connection with health tracking
- Runtime auth injection via `enrichWithRegistryAuth()` in `handleHandoff()` with registry-takes-precedence semantics
- Studio list page with connection status, registration modal, edit panel, and skills display
- Agent editor `HANDOFF TO:` autocomplete and advisory warning for unregistered remote targets
- SSRF validation on all endpoint URL inputs before any outbound fetch
- Credential masking in all API responses (never expose `encryptedAuthConfig`)
- Trace event emission for every registry lookup (hit/miss, endpoint, authType — no credentials)
- Cascade delete of registry entries on project deletion

### Non-Goals (Out of Scope)

- **OAuth2 auth type**: Only `none`, `bearer`, and `api_key` are supported in Phase 1. OAuth2 client-credentials flow is deferred.
- **gRPC protocol**: Only `a2a` and `rest` protocols are supported. gRPC support is a future phase.
- **Periodic health-ping BullMQ job**: Phase 2 fields for scheduled health checks are included in the data model but the background job is not implemented.
- **Tenant-scoped (shared) registry**: All entries are project-scoped. A shared tenant-wide registry is out of scope.
- **Admin audit history**: No audit log of registry changes beyond standard `createdBy`/`modifiedBy` timestamps.
- **Compiler validation**: The ABL compiler does not validate `HANDOFF TO:` targets against the registry. Validation is advisory in the editor only.
- **DSL syntax changes**: No new DSL keywords or syntax. The existing `HANDOFF TO:`, `LOCATION:`, `ENDPOINT:`, `PROTOCOL:` syntax is unchanged.

---

## 3. User Stories

1. As an **agent developer**, I want to register a remote A2A endpoint with credentials in Studio so that my agents can hand off to it without hardcoding secrets in the DSL.
2. As an **agent developer**, I want to see the skills advertised by a remote agent so that I can understand what capabilities are available before configuring a handoff.
3. As an **agent developer**, I want `HANDOFF TO:` autocomplete for registered agent names so that I can quickly reference registered agents without memorizing exact names.
4. As an **operator**, I want to see connection status, last-verified timestamp, and last error for each registered agent so that I can diagnose connectivity issues.
5. As an **operator**, I want to click "Test Connection" to re-fetch the agent card and verify reachability so that I can confirm agents are available after network changes.
6. As a **platform engineer**, I want the runtime to automatically inject auth credentials from the registry during handoff so that secrets are managed centrally and never stored in DSL source.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide project-scoped CRUD endpoints at `/api/projects/:projectId/external-agents` with permission gates `external_agent:create`, `external_agent:read`, `external_agent:update`, `external_agent:delete`.
2. **FR-2**: The data model must include: `name` (unique within `{tenantId, projectId}`, ABL identifier format), `displayName` (optional), `endpoint` (URL, SSRF-validated), `protocol` (`'a2a'` | `'rest'`), `authType` (`'none'` | `'bearer'` | `'api_key'`), `encryptedAuthConfig` (encrypted JSON `{value, header?}`, project-scoped DEK), `lastDiscoveredCard` (cached agent card JSON), `lastConnectionStatus` (`'connected'` | `'failed'` | `null`), `lastConnectionAt`, `lastConnectionLatencyMs`, `lastConnectionError`, `createdBy`, `modifiedBy`.
3. **FR-3**: The system must fetch the agent card on create and on test-connection requests; store discovered skills; update `lastConnectionStatus`, `lastConnectionLatencyMs`, and `lastConnectionError`. Card fetch failure must be non-blocking — registration succeeds with `lastConnectionStatus: 'failed'`.
4. **FR-4**: The system must perform SSRF validation via `EndpointValidator`/`SsrfEndpointValidator` on all endpoint URL inputs before any outbound fetch.
5. **FR-5**: The system must mask auth credentials in all API responses: `encryptedAuthConfig` must be absent from every response body; `authConfigured: boolean` must be present instead.
6. **FR-6**: The runtime must look up `external_agent_configs` by `{tenantId, projectId, name}` via `enrichWithRegistryAuth()` in `handleHandoff()` (D-2 deviation from HLD — see post-impl notes in HLD); inject the decrypted `auth.value` into the `AgentRegistryEntry`; registry endpoint takes precedence over inline `ENDPOINT:`; fall back to inline endpoint if no registry entry exists; emit a descriptive error when both are absent.
7. **FR-7**: Studio must provide `HANDOFF TO:` autocomplete in the agent editor populated from the registry.
8. **FR-8**: Studio must display an advisory (non-blocking) warning in the agent editor when a `HANDOFF TO:` target with `LOCATION: remote` has no matching registry entry.
9. **FR-9**: Studio must provide a list page with columns: name, protocol, status, latency, last-verified; status badges; and a test-connection action per row.
10. **FR-10**: Studio must provide a registration form (modal) and an edit panel; skills discovered from the agent card must be displayed after save or test-connection.
11. **FR-11**: Cross-project access must return 404; cross-tenant access must return 404. The system must not return 403, which would leak the existence of the resource.
12. **FR-12**: The system must emit a trace event for every registry lookup containing: `agentName`, `registryHit` (boolean), `endpoint`, `authType`. The trace event must never contain `auth.value`.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                |
| -------------------------- | ------------ | -------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Registry entries are project-scoped and cascade-deleted with project |
| Agent lifecycle            | PRIMARY      | Directly affects agent handoff resolution and credential injection   |
| Customer experience        | NONE         | No end-user facing impact                                            |
| Integrations / channels    | PRIMARY      | Core integration surface for remote A2A and REST agents              |
| Observability / tracing    | SECONDARY    | Trace events for registry lookup hit/miss                            |
| Governance / controls      | SECONDARY    | Encrypted credential storage, SSRF validation, permission gates      |
| Enterprise / compliance    | SECONDARY    | Credential encryption at rest, no secrets in API responses           |
| Admin / operator workflows | PRIMARY      | Studio management surface for operators                              |

### Related Feature Integration Matrix

| Related Feature                                                   | Relationship Type | Why It Matters                                                             | Key Touchpoints                                                              | Current State                           |
| ----------------------------------------------------------------- | ----------------- | -------------------------------------------------------------------------- | ---------------------------------------------------------------------------- | --------------------------------------- |
| [A2A Integration](a2a-integration.md)                             | extends           | Registry provides credential and endpoint management for A2A outbound path | `enrichWithRegistryAuth()` in `handleHandoff()`, `createA2AClientWithAuth()` | BETA — outbound works but no auth store |
| [MCP Servers](ancillary/mcp-servers.md)                           | shares data with  | Same encrypted-config pattern, same CRUD + test-connection UI pattern      | `mcp-server-config.model.ts`, Studio MCP server pages                        | STABLE — reference implementation       |
| [Agent Transfer & Orchestration](agent-transfer-orchestration.md) | depends on        | `HANDOFF TO:` routing in `routing-executor.ts` triggers registry lookup    | `createClientForAgent()`, `AgentRegistryEntry`                               | STABLE                                  |

---

## 6. Design Considerations (Optional)

- **Registration Modal**: Follows the MCP Server registration pattern — modal form with fields for name, display name, endpoint URL, protocol selector, auth type selector, and auth credential input. Auth credential fields are conditionally shown based on auth type.
- **Skills Panel**: After successful card fetch, display the agent's skills list (id, name, description) in a read-only panel below the edit form. Skills refresh on test-connection.
- **Status Badges**: Connection status uses semantic color tokens — `connected` (success/green), `failed` (error/red), `null`/never-tested (neutral/gray).
- **Autocomplete**: `HANDOFF TO:` autocomplete in the agent editor shows registered agent names with protocol and status indicators. Non-blocking advisory warning for unregistered targets.

---

## 7. Technical Considerations (Optional)

- **Encryption**: Uses the existing `encryptionPlugin` with project-scoped DEK (same pattern as `mcp-server-config.model.ts`). No new encryption keys or KMS configuration required. Relies on existing `ENCRYPTION_MASTER_KEY` / KMS setup.
- **SSRF Validation**: All endpoint URLs pass through `SsrfEndpointValidator.validate()` before any outbound HTTP request. The validator rejects private/internal IPs (127.0.0.1, 10.x, 169.254.x, 192.168.x, ::1). Test environments use `allowPrivate: true` for in-process stub servers.
- **DI for Testing**: `RoutingExecutor` accepts an injectable `LookupExternalAgent` as an optional 3rd constructor parameter; tests pass a fake function without `vi.mock`.
- **Agent Card Fetch**: Non-blocking on registration — if the remote endpoint is unreachable, registration still succeeds with `lastConnectionStatus: 'failed'`. The agent card is fetched from `GET /.well-known/agent-card.json` for A2A protocol endpoints.
- **Backward Compatibility**: Inline `ENDPOINT:` in DSL continues to work when no registry entry exists. Registry takes precedence when both are present.

---

## 8. How to Consume

### Studio UI

- **List Page**: `Projects > [Project] > External Agents` — lists all registered external agents with name, protocol, connection status badge, latency, and last-verified timestamp. Each row has a "Test Connection" action button.
- **Registration**: "Register Agent" button opens a modal with fields: name, display name, endpoint URL, protocol, auth type, auth credentials. On save, the system fetches the agent card and displays results.
- **Edit Panel**: Clicking an agent row opens an edit panel with the same fields plus discovered skills display. "Test Connection" button re-fetches the card.
- **Agent Editor**: `HANDOFF TO:` keyword triggers autocomplete with registered agent names. Selecting an entry auto-fills the name. An advisory warning appears for unregistered remote targets.

### Surface Semantics Matrix

| Asset / Entity Type   | Source of Truth / Ownership                          | Design-Time Surface(s)                 | Editable or Read-Only? | Consumer Reference / Binding Model    | Runtime Materialization / Resolution                                                        | Notes / Unsupported State                             |
| --------------------- | ---------------------------------------------------- | -------------------------------------- | ---------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| External Agent Config | `external_agent_configs` collection (project-scoped) | Studio External Agents page            | Editable               | Referenced by `name` in `HANDOFF TO:` | `enrichWithRegistryAuth()` (in `handleHandoff()`) looks up by `{tenantId, projectId, name}` | No compiler validation — advisory editor warning only |
| Agent Card / Skills   | Remote endpoint (cached)                             | Studio Edit Panel / Skills Panel       | Read-Only              | Cached in `lastDiscoveredCard`        | Not used at runtime; informational only                                                     | Stale if remote agent updates without test-connection |
| Auth Credentials      | `encryptedAuthConfig` (encrypted at rest)            | Studio Registration Modal (write-only) | Write-Only             | Never exposed in API responses        | Decrypted at runtime by `enrichWithRegistryAuth()` in `handleHandoff()`                     | Masked as `authConfigured: boolean` in all responses  |

### Design-Time vs Runtime Behavior

- **Design-Time**: Studio CRUD manages the registry. Agent card is fetched on create/test-connection for informational display. Editor autocomplete reads the registry for name suggestions. Advisory warnings are design-time only.
- **Runtime**: `enrichWithRegistryAuth()` (called within `handleHandoff()`) queries the registry by `{tenantId, projectId, name}` on every `HANDOFF TO:` with `LOCATION: remote`. Decrypted credentials are injected into the `AgentRegistryEntry`. Registry endpoint takes precedence over inline. If no registry entry and no inline endpoint, the runtime emits a descriptive error.

### API (Runtime)

| Method | Path                                                           | Purpose                                          |
| ------ | -------------------------------------------------------------- | ------------------------------------------------ |
| POST   | `/api/projects/:projectId/external-agents`                     | Register a new external agent                    |
| GET    | `/api/projects/:projectId/external-agents`                     | List all external agents for the project         |
| GET    | `/api/projects/:projectId/external-agents/:id`                 | Get a single external agent                      |
| PATCH  | `/api/projects/:projectId/external-agents/:id`                 | Update an external agent                         |
| DELETE | `/api/projects/:projectId/external-agents/:id`                 | Delete an external agent                         |
| POST   | `/api/projects/:projectId/external-agents/:id/test-connection` | Re-fetch agent card and update connection status |

### API (Studio)

| Method | Path                                                           | Purpose                                     |
| ------ | -------------------------------------------------------------- | ------------------------------------------- |
| POST   | `/api/projects/[id]/external-agents`                           | Proxy to runtime: register external agent   |
| GET    | `/api/projects/[id]/external-agents`                           | Proxy to runtime: list external agents      |
| GET    | `/api/projects/[id]/external-agents/[agentId]`                 | Proxy to runtime: get single external agent |
| PATCH  | `/api/projects/[id]/external-agents/[agentId]`                 | Proxy to runtime: update external agent     |
| DELETE | `/api/projects/[id]/external-agents/[agentId]`                 | Proxy to runtime: delete external agent     |
| POST   | `/api/projects/[id]/external-agents/[agentId]/test-connection` | Proxy to runtime: test connection           |

### Admin Portal

N/A — External agent registry is project-scoped and managed through Studio.

### Channel / SDK / Voice / A2A / MCP Integration

The External Agent Registry is consumed by the A2A outbound path during `HANDOFF TO:` execution. It provides credentials and endpoint resolution for `createAuthenticatedA2AClient()`. The registry does not directly interact with inbound A2A, channels, SDK, voice, or MCP — those integrations remain unchanged.

---

## 9. Data Model

### Collections / Tables

```text
Collection: external_agent_configs
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed — tenantIsolationPlugin)
  - projectId: string (required, indexed — project scope)
  - name: string (required — ABL identifier, unique per {tenantId, projectId})
  - displayName?: string
  - endpoint: string (required — URL, SSRF-validated)
  - protocol: 'a2a' | 'rest' (required)
  - authType: 'none' | 'bearer' | 'api_key' (required)
  - encryptedAuthConfig?: string (Mongoose String; encrypted JSON `{ value: string, header?: string }` — field is `header`, not `headerName`)
  - lastDiscoveredCard?: object (cached agent card JSON)
  - lastConnectionStatus: 'connected' | 'failed' | null (default: null)
  - lastConnectionAt?: Date
  - lastConnectionLatencyMs?: number
  - lastConnectionError?: string
  - createdBy: string (required)
  - modifiedBy: string (required)
  - createdAt: Date (automatic — timestamps)
  - updatedAt: Date (automatic — timestamps)
Indexes:
  - { tenantId: 1, projectId: 1, name: 1 } (unique)
  - { tenantId: 1, projectId: 1 } (query optimization)
Plugins:
  - tenantIsolationPlugin (enforces tenantId on all queries)
  - encryptionPlugin (project-scoped DEK for encryptedAuthConfig)
```

### Key Relationships

- **Project**: Each `external_agent_configs` document belongs to exactly one project. Cascade-deleted when the project is deleted.
- **Agent DSL**: Referenced by `name` in `HANDOFF TO:` instructions. The runtime resolves the name to an endpoint + credentials at execution time.
- **MCP Server Config**: Follows the same model pattern (`mcp-server-config.model.ts`) for encrypted config storage and CRUD + test-connection.
- **Trace Events**: Registry lookups emit trace events consumed by the tracing pipeline.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                          | Purpose                                                                  |
| ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `packages/database/src/models/external-agent-config.model.ts` | Mongoose model with encryption + tenant isolation plugins                |
| `packages/shared/src/repos/external-agent-config-repo.ts`     | Module-level CRUD functions + `testExternalAgentConnection`              |
| `packages/shared/src/types/external-agent.ts`                 | Shared types (`ExternalAgentLookupResult`, `LookupExternalAgent`, etc.)  |
| `apps/runtime/src/services/execution/routing-executor.ts`     | `enrichWithRegistryAuth()` + `LookupExternalAgent` DI in `handleHandoff` |
| `apps/runtime/src/services/runtime-executor.ts`               | Wires `findExternalAgentConfigByName` to `RoutingExecutor` constructor   |

### Routes / Handlers

| File                                                                                       | Purpose                                                           |
| ------------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| `apps/runtime/src/routes/external-agents.ts`                                               | Runtime CRUD + test-connection endpoints with SSRF + auth masking |
| `apps/studio/src/app/api/projects/[id]/external-agents/route.ts`                           | Studio proxy routes for list + create                             |
| `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/route.ts`                 | Studio proxy routes for get + update + delete                     |
| `apps/studio/src/app/api/projects/[id]/external-agents/[agentId]/test-connection/route.ts` | Studio proxy for test-connection                                  |

### UI Components

| File                                                                        | Purpose                                                             |
| --------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `apps/studio/src/components/external-agents/ExternalAgentsPage.tsx`         | List page with status badges + test-connection (wired via AppShell) |
| `apps/studio/src/components/external-agents/RegisterExternalAgentModal.tsx` | Registration form modal                                             |
| `apps/studio/src/components/external-agents/ExternalAgentEditPanel.tsx`     | Edit panel with skills display                                      |
| `apps/studio/src/components/navigation/AppShell.tsx`                        | Imports and wires ExternalAgentsPage into project navigation        |
| `apps/studio/src/components/abl/ABLEditor.tsx`                              | `loadExternalAgentsForContext()` — autocomplete for HANDOFF TO:     |
| `apps/studio/src/api/external-agents.ts`                                    | Typed API client module (follows apiFetch pattern)                  |

### Jobs / Workers / Background Processes

N/A — No background jobs in Phase 1. Periodic health-ping is deferred to Phase 2.

### Tests

| File                                                                    | Type             | Coverage Focus                                                                     |
| ----------------------------------------------------------------------- | ---------------- | ---------------------------------------------------------------------------------- |
| `packages/database/src/models/__tests__/external-agent-config.test.ts`  | unit             | Schema validation, unique index, encrypted field round-trip                        |
| `apps/runtime/src/__tests__/external-agents-integration.test.ts`        | integration      | CRUD, test-connection, SSRF rejection, auth response masking, isolation            |
| `apps/runtime/src/__tests__/external-agent-registry.e2e.test.ts`        | e2e              | Full handoff with registry auth injection; cross-project 404; test-connection flow |
| `apps/runtime/src/__tests__/external-agent-registry-resolution.test.ts` | integration+unit | `enrichWithRegistryAuth()` lookup, auth injection, trace events                    |
| `packages/database/src/__tests__/cascade-delete-modules.test.ts`        | integration      | Cascade delete on project deletion (ExternalAgentConfig + MCPServerConfig)         |
| `apps/studio/src/__tests__/external-agents-api.test.ts`                 | integration      | Studio proxy routes, permission gates                                              |
| `apps/runtime/src/__tests__/helpers/mock-a2a-remote-agent.ts`           | test helper      | Configurable A2A stub with `getReceivedHeaders()` for auth verification            |
| `apps/runtime/src/__tests__/helpers/runtime-api-harness.ts`             | test helper      | Extended with `allowPrivateEndpoints` + `ALLOW_SSRF_PRIVATE_RANGES` support        |

---

## 11. Configuration

### Environment Variables

No new environment variables. Uses existing `ENCRYPTION_MASTER_KEY` / KMS for the `encryptionPlugin` project-scoped DEK. `ALLOW_SSRF_PRIVATE_RANGES` is an existing dev/test env var that enables private endpoint access.

| Variable                    | Default | Description                                                                      |
| --------------------------- | ------- | -------------------------------------------------------------------------------- |
| `ENCRYPTION_MASTER_KEY`     | —       | Existing — used by encryptionPlugin for DEK                                      |
| `ALLOW_SSRF_PRIVATE_RANGES` | —       | Existing — enables SSRF private range bypass for dev/test (used by test harness) |

### Runtime Configuration

No feature flags needed for Phase 1. The registry is available to all projects once deployed.

### DSL / Agent IR / Schema

No DSL or schema changes required. The existing `RemoteAgentLocation` in `packages/compiler/src/platform/ir/schema.ts:587-597` is sufficient:

```typescript
// Existing — no changes needed
interface RemoteAgentLocation {
  type: 'remote';
  protocol: 'a2a' | 'rest';
  endpoint?: string; // inline ENDPOINT: from DSL
  auth?: {
    type: 'bearer' | 'api_key' | 'none';
    // value intentionally absent — injected at runtime from registry
    header?: string; // custom header name (api_key only) — NOT headerName
  };
}
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                               |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Every query includes `projectId`. Cross-project access returns 404. `enrichWithRegistryAuth()` scopes by `{tenantId, projectId, name}`. |
| Tenant isolation  | `tenantIsolationPlugin` enforces `tenantId` on all queries. Cross-tenant access returns 404 (not 403).                                  |
| User isolation    | N/A — registry entries are project-owned, not user-owned. Access controlled by project permissions.                                     |

### Security & Compliance

- **Credential Encryption**: Auth credentials encrypted at rest via `encryptionPlugin` with project-scoped DEK. Uses existing `ENCRYPTION_MASTER_KEY` / KMS infrastructure.
- **Credential Masking**: `encryptedAuthConfig` is stripped from all API responses. Only `authConfigured: boolean` is exposed.
- **SSRF Validation**: All endpoint URLs validated via `SsrfEndpointValidator` before any outbound fetch. Private/internal IPs rejected.
- **Permission Gates**: CRUD operations require `external_agent:create/read/update/delete` project permissions.
- **Trace Safety**: Registry lookup trace events include `agentName`, `registryHit`, `endpoint`, `authType` — never `auth.value`.

### Performance & Scalability

- **Hot Path Impact**: Single indexed MongoDB query per `HANDOFF TO:` on the runtime hot path. Index `{tenantId, projectId, name}` ensures O(1) lookup.
- **Expected Latency**: <2ms for registry lookup (indexed query against a small collection per project).
- **No Caching**: Phase 1 does not cache registry entries in memory. The indexed MongoDB query is fast enough. In-memory caching with TTL can be added in Phase 2 if needed.

### Reliability & Failure Modes

- **Non-Blocking Card Fetch**: Agent card fetch failure on registration is non-blocking. Registration succeeds with `lastConnectionStatus: 'failed'` and `lastConnectionError` populated.
- **Registry Miss Fallback**: When no registry entry exists, `enrichWithRegistryAuth()` falls back to inline `ENDPOINT:` from the DSL.
- **Both Absent Error**: When neither registry entry nor inline endpoint is available, the runtime emits a descriptive error containing the agent name (no credentials or cross-tenant data).

### Observability

- **Trace Events**: Every `enrichWithRegistryAuth()` call emits a `remote_agent_registry_lookup` trace event with: `agentName`, `registryHit` (boolean), `endpoint`, `authType`. No credentials in traces.
- **Connection Status**: `lastConnectionStatus`, `lastConnectionAt`, `lastConnectionLatencyMs`, and `lastConnectionError` provide operator-visible health data in Studio.

### Data Lifecycle

- **Cascade Delete**: Project deletion cascades to delete all `external_agent_configs` documents for the project (added to `cascade-delete.ts`).
- **No TTL**: Registry entries persist until explicitly deleted or cascade-deleted.
- **Agent Card Staleness**: Cached `lastDiscoveredCard` may become stale if the remote agent updates its card. Operators can refresh via test-connection.

---

## 13. Delivery Plan / Work Breakdown

1. **Database model + repository**
   1.1 Create `external-agent-config.model.ts` with Mongoose schema, `tenantIsolationPlugin`, `encryptionPlugin`, unique index `{tenantId, projectId, name}`
   1.2 Create `external-agent-repo.ts` with CRUD operations + `findByName(tenantId, projectId, name)`
   1.3 Register model in `ModelRegistry.bindModelsForRuntime()`

2. **Runtime CRUD + test-connection routes**
   2.1 Create `external-agents.ts` route file with POST/GET/GET/:id/PATCH/DELETE/:id/POST/:id/test-connection
   2.2 Implement SSRF validation on all endpoint URL inputs
   2.3 Implement auth credential masking in all response serialization
   2.4 Implement agent card fetch (non-blocking) on POST and test-connection
   2.5 Add permission gates (`external_agent:create/read/update/delete`)
   2.6 Mount routes in runtime server

3. **Runtime resolution extension**
   3.1 Add `enrichWithRegistryAuth()` to `handleHandoff()` with injectable `LookupExternalAgent` (3rd constructor param on `RoutingExecutor`)
   3.2 Implement registry-takes-precedence semantics over inline endpoint
   3.3 Implement fallback to inline endpoint when no registry entry
   3.4 Implement descriptive error when both absent
   3.5 Emit `remote_agent_registry_lookup` trace event

4. **Studio proxy routes**
   4.1 Create proxy route handlers for all CRUD + test-connection endpoints
   4.2 Forward auth headers and project context

5. **Studio UI components**
   5.1 Create `ExternalAgentsPage` (list page with status badges, columns, test-connection action)
   5.2 Create `RegisterAgentModal` (form with conditional auth fields)
   5.3 Create `EditAgentPanel` (edit form + skills display)
   5.4 Create `AgentSkillsPanel` (read-only skills list from cached card)
   5.5 Create `ConnectionStatusBadge` (semantic color status indicator)

6. **Agent editor autocomplete + advisory warning**
   6.1 Add `HANDOFF TO:` autocomplete from registry in agent editor
   6.2 Add advisory (non-blocking) warning for unregistered `HANDOFF TO:` targets with `LOCATION: remote`

7. **Cascade delete**
   7.1 Extend `deleteProject()` in `cascade-delete.ts` to delete `external_agent_configs`

8. **Documentation + agents.md updates**
   8.1 Run `/post-impl-sync` to update all SDLC artifacts
   8.2 Update `agents.md` for all touched packages

---

## 14. Success Metrics

| Metric                             | Baseline | Target              | How Measured                                            |
| ---------------------------------- | -------- | ------------------- | ------------------------------------------------------- |
| Remote handoff auth injection rate | 0%       | 100% for registered | Registry lookup trace events (registryHit: true)        |
| Registry entries per project       | 0        | 1-10 (typical)      | Count of `external_agent_configs` per project           |
| Agent card fetch success rate      | N/A      | >90%                | `lastConnectionStatus: 'connected'` vs `'failed'` ratio |
| Test-connection p99 latency        | N/A      | <5s                 | `lastConnectionLatencyMs` distribution                  |
| Registry lookup hot-path latency   | N/A      | <2ms p99            | Trace event timing for `remote_agent_registry_lookup`   |

---

## 15. Open Questions

1. **gRPC Protocol Support**: Should the `protocol` enum be extended to include `grpc` in a future phase? If so, what discovery mechanism replaces `/.well-known/agent-card.json`? — _Deferred to Phase 2._
2. **Performance Under Load**: With 50+ registered agents per project and 100+ concurrent handoffs, does the single indexed MongoDB query remain <2ms p99? — _To be validated after implementation with load testing._

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                      | Severity | Status    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | No periodic health-ping job — operators must manually test-connection                                                            | Medium   | Open      |
| GAP-002 | Agent card can become stale if remote agent updates without operator re-testing                                                  | Low      | MITIGATED |
| GAP-003 | No in-memory cache for registry lookups on runtime hot path (relies on MongoDB indexed query)                                    | Low      | Open      |
| GAP-004 | MCPServerConfig not included in cascade-delete — fixed alongside ExternalAgentConfig in `cascade-delete.ts` (commit `6d33f4291`) | Medium   | MITIGATED |
| GAP-005 | No OAuth2 auth type — limits integration with OAuth2-only remote agents                                                          | Medium   | Open      |
| GAP-006 | `enrichWithRegistryAuth` covers only sequential `handleHandoff` path — `handleFanOut` remote auth injection deferred (D-9)       | Medium   | Open      |
| GAP-007 | UT-3 tests `enrichWithRegistryAuth` (not `resolveRemoteFromHandoff` as originally spec'd) — test spec drift from LLD D-2         | Low      | MITIGATED |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                           | Coverage Type | Status  | Test File / Note                                        |
| --- | ---------------------------------------------------------------------------------- | ------------- | ------- | ------------------------------------------------------- |
| 1   | Register external agent with bearer auth — agent card fetched — skills stored      | e2e           | WRITTEN | `external-agent-registry.e2e.test.ts` (E2E-1)           |
| 2   | HANDOFF TO: registered agent — runtime injects bearer token from registry          | e2e           | WRITTEN | `external-agent-registry.e2e.test.ts` (E2E-2)           |
| 3   | PATCH registered agent with new api_key auth — old credential overwritten          | integration   | WRITTEN | `external-agents-integration.test.ts` (INT-2)           |
| 4   | test-connection to unreachable endpoint — lastConnectionStatus: 'failed'           | integration   | WRITTEN | `external-agents-integration.test.ts` (INT-3)           |
| 5   | test-connection to private IP — SSRF rejection, 400                                | integration   | WRITTEN | `external-agents-integration.test.ts` (INT-4)           |
| 6   | GET list — encryptedAuthConfig absent, authConfigured: true                        | integration   | WRITTEN | `external-agents-integration.test.ts` (INT-5)           |
| 7   | Cross-project access — 404                                                         | integration   | WRITTEN | `external-agents-integration.test.ts` (INT-7)           |
| 8   | Cross-tenant access — 404                                                          | e2e           | WRITTEN | `external-agent-registry.e2e.test.ts` (E2E-6)           |
| 9   | Delete project — cascade deleted                                                   | integration   | WRITTEN | `cascade-delete-modules.test.ts` (mock registry assert) |
| 10  | Studio page renders list, shows status badges, opens registration modal            | e2e (browser) | MANUAL  | Playwright scenario (MANUAL-3)                          |
| 11  | HANDOFF TO: unknown remote agent with no inline endpoint — runtime error           | e2e           | WRITTEN | `external-agent-registry.e2e.test.ts` (E2E-8)           |
| 12  | Duplicate agent name in same project — 409 Conflict                                | integration   | WRITTEN | `external-agents-integration.test.ts` (INT-2)           |
| 13  | Cross-project GET/PATCH/DELETE — 404 (not 403)                                     | e2e           | WRITTEN | `external-agent-registry.e2e.test.ts` (E2E-6)           |
| 14  | Register agent with api_key auth — HANDOFF — runtime injects custom header         | e2e           | WRITTEN | `external-agent-registry.e2e.test.ts` (E2E-3)           |
| 15  | HANDOFF with inline ENDPOINT + matching registry entry — registry takes precedence | e2e           | WRITTEN | `external-agent-registry.e2e.test.ts` (E2E-5, INT-6)    |

### Testing Notes

E2E tests use `startRuntimeServerHarness()` with MongoMemoryServer, real auth, and real encryption — no Docker required. FR-7 through FR-10 (Studio UI) are manual until Playwright is available. The most critical test is auth injection (E2E-2) which validates that the runtime correctly resolves encrypted credentials from the registry and injects them into outbound A2A requests.

The full test specification was approved after 3 audit rounds on 2026-04-28.

> Full testing details: [docs/testing/external-agent-registry.md](../testing/external-agent-registry.md)

---

## 18. References

- [A2A Integration feature spec](a2a-integration.md) — parent feature
- [Agent Transfer & Orchestration](agent-transfer-orchestration.md) — handoff routing hub
- [ABL Language spec](abl-language.md) — DSL syntax reference
- `packages/compiler/src/platform/ir/schema.ts` — `RemoteAgentLocation` interface (line 587)
- `apps/runtime/src/services/execution/routing-executor.ts` — `enrichWithRegistryAuth()` + `handleHandoff()` (auth injection path)
- `apps/runtime/src/services/execution/routing-executor.ts` — `createClientForAgent()` (line ~1622)
- `packages/a2a/src/infrastructure/authenticated-client-factory.ts` — `createAuthenticatedA2AClient()`
- `packages/database/src/models/mcp-server-config.model.ts` — reference model pattern for encrypted config
- `apps/studio/src/app/api/projects/[id]/mcp-servers/` — reference CRUD + test-connection pattern
