# Runtime Workflow Routes — agents.md

Agent learning journal for workflow routes in `apps/runtime/src/routes/`.

Agents MUST read this file before modifying runtime workflow routes. Agents MUST append learnings after completing work.

---

## What This Is

The Runtime owns workflow **CRUD** and **proxies** execution operations to the Workflow Engine. This file covers the routing layer only — for the execution engine, see `apps/workflow-engine/agents.md`.

## Architecture at a Glance

### The CRUD vs Proxy Split

Runtime handles two categories of workflow routes:

| Category              | Handled By                             | Routes                                                                          |
| --------------------- | -------------------------------------- | ------------------------------------------------------------------------------- |
| **CRUD** (direct)     | `workflows.ts`, `workflow-versions.ts` | Create, read, update, archive workflows + version management                    |
| **Execution** (proxy) | `workflow-engine-proxy.ts` middleware  | Execute, cancel, get executions, triggers, approvals, notifications, connectors |

**Key principle:** Runtime never executes workflows. It validates, authenticates, and forwards.

### Route Files

| File                   | Purpose                                                                                                   |
| ---------------------- | --------------------------------------------------------------------------------------------------------- |
| `workflows.ts`         | `POST /` (create), `GET /` (list), `GET /:id` (read), `PUT /:id` (update), `PUT /:id/archive` (archive)   |
| `workflow-versions.ts` | `POST /:id/versions` (create snapshot), `GET /:id/versions` (list), `GET /:id/versions/:versionId` (read) |
| `workflow-helpers.ts`  | Shared utilities for route handlers                                                                       |

### Proxy Middleware

`middleware/workflow-engine-proxy.ts` forwards requests to the Workflow Engine:

```
Runtime (3112) --HTTP--> Workflow Engine (9080)
```

**Proxy route mapping:**

| Runtime Path                            | Engine Path                   | Auth                  |
| --------------------------------------- | ----------------------------- | --------------------- |
| `POST /:wfId/executions/execute`        | `POST .../executions/execute` | `workflow:execute`    |
| `GET /:wfId/executions`                 | `GET .../executions`          | `workflow:read`       |
| `GET /:wfId/executions/:execId`         | `GET .../executions/:execId`  | `workflow:read`       |
| `POST /:wfId/executions/:execId/cancel` | `POST .../cancel`             | `workflow:execute`    |
| `GET/POST/DELETE /triggers/...`         | `triggers/...`                | `workflow:read/write` |
| `GET /connectors`                       | `connectors`                  | `workflow:read`       |
| `CRUD /:wfId/notifications/...`         | `notifications/...`           | `workflow:update`     |
| Approvals                               | `approvals/...`               | `workflow:execute`    |

### Supporting Files

| File                                   | Purpose                                      |
| -------------------------------------- | -------------------------------------------- |
| `validation/workflow-validation.ts`    | Server-side Zod validation for create/update |
| `services/workflow-version-service.ts` | Version snapshot creation logic              |
| `middleware/workflow-engine-proxy.ts`  | HTTP proxy to engine with auth forwarding    |

## Patterns & Conventions

### Adding a New CRUD Route

1. Add route handler in `workflows.ts` or create new file if it's a new resource
2. Use `requireProjectPermission(req, res, 'workflow:<action>')` for RBAC
3. Always include `tenantId` AND `projectId` in MongoDB queries (isolation invariant)
4. Validate input with Zod schemas from `packages/shared/src/types/workflow-schemas.ts`
5. Return `{ success: true, data: ... }` on success, `{ success: false, error: { code, message } }` on failure

### Adding a New Proxied Route

1. Add the route mapping in `workflow-engine-proxy.ts`
2. Ensure the corresponding route exists on the engine side (`apps/workflow-engine/src/routes/`)
3. The proxy forwards auth headers — no additional auth handling needed
4. Test via the runtime port (3112), not the engine port (9080)

### Auth Flow

```
Request -> createUnifiedAuthMiddleware -> requireAuth -> requireProjectPermission -> handler/proxy
```

Three token types: JWT (user sessions), SDK token (`X-SDK-Token`), API key (`x-api-key`).

### Testing

Test files in `apps/runtime/src/__tests__/`:

| Test File                              | What It Tests          |
| -------------------------------------- | ---------------------- |
| `workflow-routes.test.ts`              | CRUD operations        |
| `workflow-validation.test.ts`          | Input validation       |
| `workflow-step-denormalize.test.ts`    | Step format conversion |
| `workflow-create-sanitization.test.ts` | Input sanitization     |
| `workflow-version-service.test.ts`     | Version service logic  |
| `workflow-version-routes.test.ts`      | Version route handlers |
| `auth/workflows-authz.test.ts`         | Authorization checks   |

## Known Gaps & Gotchas

- **Proxy timeout** — the proxy to workflow-engine has a default timeout. Long-running operations (execute with 30s poll) need adequate timeout configuration.
- **Archive, not delete** — workflows use soft-delete (`PUT /:id/archive`), not `DELETE`. The archive operation sets `status: 'archived'`.
- **Version snapshots are immutable** — once created, a version cannot be updated or deleted.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work>
-->

## 2026-04-14 — Proxy Context Forwarding Must Stay Server-Derived

**Category**: architecture
**Learning**: The workflow proxy should forward `authorization`, `x-api-key`, request IDs, and W3C trace headers, but it must derive `x-tenant-id` from `req.tenantContext` set by auth middleware instead of trusting raw client headers. The proxy also relies on merged parent params, so `projectId` comes from the `/api/projects/:projectId/workflows` mount.
**Files**: `apps/runtime/src/middleware/workflow-engine-proxy.ts`, `apps/runtime/src/server.ts`
**Impact**: New proxied routes have to preserve auth and observability context without reopening tenant spoofing or losing project scope.

## 2026-04-14 — Approval Writes Need Both Runtime Route Shapes

**Category**: gotcha
**Learning**: Approval actions must support both `/approvals/:workflowId/executions/:executionId/steps/:stepId/approve` and `/:workflowId/executions/:executionId/steps/:stepId/approve`. In local Studio/Turbopack flows, deeply nested approval paths can be rewritten directly to Runtime and skip the Studio handler that normally inserts the `approvals/` path segment.
**Files**: `apps/runtime/src/middleware/workflow-engine-proxy.ts`
**Impact**: Any approval-routing change has to keep both path shapes aligned or approvals will regress only in one proxy path.

## 2026-04-14 — Runtime Talks To The Engine API, Not The Restate Endpoint

**Category**: architecture
**Learning**: Runtime proxies workflow execution traffic to the workflow-engine Express API on port `9080`. Port `9081` is the separate Restate endpoint used for Restate registration/callbacks, not the HTTP API that Runtime or Studio should call.
**Files**: `apps/runtime/src/middleware/workflow-engine-proxy.ts`, `apps/runtime/src/server.ts`, `apps/workflow-engine/src/index.ts`, `apps/workflow-engine/src/constants.ts`
**Impact**: Local debugging, proxy config, and E2E harnesses should point workflow HTTP traffic at `9080` and reserve `9081` for Restate wiring only.

## 2026-04-17 — Proxy Must Forward All Engine-Schema Fields (workflowVersionId, webhookMode, …)

**Category**: gotcha
**Learning**: The execute proxy's body-translation block used to build `enginePayload` with only `executionId`, `payload`, `triggerType`, and `triggerMetadata`, silently dropping four engine-schema fields: `workflowVersionId`, `workflowVersion`, `webhookMode`, `webhookDelivery`. The engine's `executeBodySchema` accepts all of them but has no `.passthrough()`, so any caller that sent a version pin or explicit webhook semantics had those fields stripped — the engine just ran with defaults. Now the proxy extracts each via type guards (`typeof body.workflowVersionId === 'string'`, `body.webhookMode === 'sync' | 'async'`, etc.) and appends them to `enginePayload` only when present. Studio's client does not send any of these (it relies on the engine's active-version default, see `apps/workflow-engine/agents.md`), but API-key and SDK callers that hit this proxy need the fields to survive translation.
**Files**: `apps/runtime/src/middleware/workflow-engine-proxy.ts`
**Impact**: Any future field added to `executeBodySchema` must also be extracted + forwarded here. Without forwarding, Zod's default `.strip` hides the drop — tests that assert on the engine's `restateClient.startWorkflow` arguments would catch the miss, but tests that only assert on proxy output do not.

## 2026-04-17 — Trigger Catalog Proxy Route + Ordering Gotcha

**Category**: gotcha
**Learning**: The workflow-engine exposes `GET /api/v1/connectors/triggers/catalog` (registry-wide, not project-scoped). The runtime proxy now forwards `GET /api/projects/:pid/workflows/triggers/catalog` to that engine path so Studio clients can call it with a normal JWT + per-project RBAC check. **Route ordering matters**: Express matches routes top-down, and `/triggers/catalog` must be registered BEFORE `/triggers/:registrationId/{pause,resume,fire,...}` — otherwise the literal string `catalog` is captured as a `registrationId` param and hits the wrong engine path. The `workflow-proxy-admin` E2E suite has an explicit route-ordering guard (E2E-PROXY-ADM-04 test 4) to catch regressions if someone reorders routes or adds a new `GET /triggers/:registrationId` endpoint later. Note: the Studio component `ExternalAppCatalog.tsx` still calls the legacy path `/api/connectors/triggers/catalog` (unwired); that component is currently unused, and updating its call site to the new project-scoped path is the correct fix before it is re-enabled.
**Files**: `apps/runtime/src/middleware/workflow-engine-proxy.ts`, `apps/runtime/src/__tests__/e2e/workflows/workflow-proxy-admin.e2e.test.ts`, `apps/runtime/src/__tests__/helpers/mock-workflow-engine.ts`
**Impact**: When adding any future proxy route with a literal string segment that could collide with an existing `:param` segment (e.g., `/triggers/:x`, `/connectors/:name`), register the literal route first and add a route-ordering assertion to the E2E suite.

## 2026-04-17 — Dead Top-Level callbackUrl/accessToken Removed From process-api

**Category**: gotcha
**Learning**: `apps/runtime/src/routes/process-api.ts` previously sent `callbackUrl` and `accessToken` at the top level of the engine payload in addition to inside `triggerMetadata`. The engine's `executeBodySchema` has no top-level entries for them and no `.passthrough()`, so Zod silently stripped the duplicates — the real values flowed via `triggerMetadata`, which is what `callback-delivery-worker` reads. Removed the top-level keys to prevent future readers from assuming top-level consumption.
**Files**: `apps/runtime/src/routes/process-api.ts`
**Impact**: Callback-related fields belong in `triggerMetadata`, not top-level. If a new top-level field is ever needed, the engine's `executeBodySchema` must be updated in the same change — otherwise Zod will silently strip it.

## 2026-04-21 — Historical `/sessions/:id/agent-spec` Is Version-Scoped, Not Name-Scoped

**Category**: gotcha
**Learning**: The sessions router's `/:id/agent-spec` handler cannot treat a historical session like a flat `GET /api/agents/:name` lookup. For stored sessions, the route must: (1) load the DB session, (2) 404 on cross-project access, (3) normalize `currentAgent` from a possible path to the project agent name, (4) look up the project agent with both `tenantId` and `projectId`, (5) if `agentVersion` is present, load `AgentVersion` and extract the active agent's IR from the persisted compilation output. If that pinned version is unavailable, the route should return only identity metadata for the historical agent and leave the spec unavailable.
**Files**: `apps/runtime/src/routes/sessions.ts`, `apps/runtime/src/__tests__/sessions/session-routes.test.ts`
**Impact**: Any new session-history route that surfaces agent configuration should be session-version aware. Returning the current project agent for a historical session produces misleading debugging data even though the request shape looks superficially correct; prefer a partial "pinned version unavailable" response over substituting newer config.
