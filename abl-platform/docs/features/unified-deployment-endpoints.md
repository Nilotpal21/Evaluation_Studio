# Feature: Unified Deployment Endpoints

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: PLANNED
**Feature Area(s)**: `integrations`, `customer experience`, `project lifecycle`, `agent lifecycle`, `observability`
**Package(s)**: `apps/runtime`, `packages/database`, `apps/studio`, `apps/workflow-engine`
**Owner(s)**: Platform team
**Testing Guide**: [docs/testing/unified-deployment-endpoints.md](../testing/unified-deployment-endpoints.md)
**Last Updated**: 2026-04-10

---

## 1. Introduction / Overview

### Problem Statement

The ABL Platform currently exposes deployed capabilities through three structurally parallel but architecturally disconnected surface models:

1. **SDK Channels** (`sdk_channels`) -- linked to deployments via `deploymentId`, auto-followed via `followEnvironment`, authenticated with `pk_*` API keys. These serve interactive web/mobile conversations.
2. **Channel Connections** (`channel_connections`) -- linked to deployments via `deploymentId` and `environment`, authenticated with encrypted provider credentials. These serve third-party messaging/voice platforms (Slack, WhatsApp, Teams, etc.).
3. **Trigger Registrations** (`trigger_registrations`) -- linked to environments via the `environment` field, resolved to active deployments at fire time. These serve workflow automation triggers (webhook, cron, polling).

Each model has its own deployment-linking mechanism, its own lifecycle management, its own health tracking (or lack thereof), and its own URL addressing scheme. There is no unified way for external callers to discover, authenticate with, or invoke all capabilities a deployment exposes. The Deployment model already generates an `endpointSlug` (unique, indexed) but this slug is not exposed as a routable URL in any runtime route.

This creates concrete problems:

- **No single pane of glass**: Operators must check three different surfaces (SDK channels panel, channel connections list, workflow triggers tab) to understand what a deployment exposes.
- **Inconsistent deployment awareness**: SDK channels auto-follow deployments; channel connections optionally link; triggers resolve at fire time. Three different binding strategies for the same concept.
- **No unified health view**: SDK channels lack health tracking entirely. Trigger registrations have `consecutiveErrors`/`lastFiredAt`. Webhook subscriptions have `failureCount`. There is no deployment-level health aggregation.
- **Future scenarios are blocked**: Scheduled agents (cron -> agent without a workflow), webhook-triggered agents, proactive agent outreach, composite routing, and API products all require new surfaces that don't fit cleanly into either channels or triggers.

### Goal Statement

Introduce a **Deployment Endpoint** abstraction layer that provides a unified routing, discovery, authentication, and health-tracking surface for everything a deployment exposes -- without replacing the domain-specific models (SDKChannel, ChannelConnection, TriggerRegistration) that carry the operational state underneath.

### Summary

A Deployment Endpoint is a lightweight routing/discovery record that sits above the existing channel and trigger models. Each endpoint binds to exactly one deployment, references one underlying resource (SDK channel, channel connection, trigger registration, or future target types), and provides:

- A stable, deployment-scoped URL (`/api/v1/deployments/{slug}/endpoints/{path}`)
- A declared auth mode (inherited from the underlying resource)
- Optional per-endpoint rate limiting
- Standardized health tracking (`lastInvokedAt`, `consecutiveErrors`, status)
- A deployment-level observability contract (TraceEvent emission at the endpoint ingress layer)

The existing channel-specific URLs (`/api/v1/channels/:channelType/webhook/:identifier`) and trigger-specific URLs continue to work unchanged. The unified endpoint scheme is additive -- new integrations can prefer it while legacy integrations keep working.

---

## 2. Scope

### Goals

- Provide a unified Deployment Endpoint model that wraps SDK channels, channel connections, and trigger registrations as polymorphic targets
- Expose a deployment-scoped URL scheme (`/api/v1/deployments/{slug}/endpoints/{path}`) that routes to the correct underlying resource
- Auto-create endpoint records during the deployment pipeline (extending the existing channel auto-follow mechanism)
- Surface all deployment endpoints in a single "Endpoints" tab in the Studio deployment detail view
- Standardize health tracking across all endpoint types
- Emit `endpoint.invoked` TraceEvents at the ingress layer for unified observability
- Coexist with existing channel-specific and trigger-specific URLs (no breaking changes)

### Non-Goals (Out of Scope)

- Replacing the existing SDKChannel, ChannelConnection, or TriggerRegistration models (these remain as domain-specific backing stores)
- Introducing new auth modes beyond what the channel manifest and trigger system already support
- Scheduled agents (cron -> agent without a workflow) -- deferred to a future phase since TriggerRegistration currently requires `workflowId`
- Canary/blue-green traffic splitting between deployments
- Cross-deployment endpoint sharing (each endpoint is scoped to exactly one deployment)
- Composite routing / router target types (future phase)
- API product packaging / marketplace (future phase)
- Surfacing outbound webhook subscriptions (`WebhookSubscription`) as endpoints -- these are outbound delivery records with no inbound invocation path
- Retroactive backfill of endpoints for existing deployments in Phase 1 (forward-only creation; optional backfill migration in Phase 2)

---

## 3. User Stories

1. As a **project developer**, I want to see all surfaces my deployment exposes (SDK channels, messaging channels, workflow triggers) in a single view so that I can understand and manage my deployment's external footprint without checking three different panels.

2. As a **platform integrator**, I want a stable, deployment-scoped URL for invoking capabilities so that I can address "the production endpoint for project X" rather than remembering channel-specific webhook URLs or trigger-specific API paths.

3. As a **DevOps engineer**, I want standardized health metrics across all endpoint types so that I can set up unified alerting on endpoint degradation regardless of whether the underlying resource is an SDK channel, Slack connection, or workflow trigger.

4. As a **project admin**, I want endpoint configuration (rate limits, pause/resume) to be mutable without redeploying so that I can adjust operational parameters without triggering a full deployment cycle.

5. As a **security auditor**, I want every endpoint invocation to emit a standardized trace event so that I can audit all ingress traffic to a deployment from a single observability surface.

6. As a **workflow author**, I want my workflow's webhook triggers to be automatically exposed as deployment endpoints when I deploy so that I don't need to manually configure trigger URLs for each environment.

7. As an **enterprise tenant admin**, I want deployment endpoints to respect tenant isolation so that cross-tenant access returns 404 and no endpoint leaks the existence of resources across tenant boundaries.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide a `DeploymentEndpoint` model that stores `deploymentId`, `path` (unique within deployment), `targetType` (discriminated union), `targetId`, `authMode`, `status`, optional `rateLimitRpm`, and health tracking fields.

2. **FR-2**: The system must auto-create `DeploymentEndpoint` records during the deployment creation pipeline for all linked SDK channels (via `followEnvironment` auto-follow), channel connections (via `deploymentId`/`environment` binding updated by `bulkUpdateChannelDeployment`), and trigger registrations (via `environment` binding). Auto-creation runs after the existing channel auto-follow step.

3. **FR-3a**: The system must resolve an endpoint by deployment slug and path via `GET|POST /api/v1/deployments/:slug/endpoints/:path`, returning 404 if no matching active endpoint exists for the given slug+path combination.

4. **FR-3b**: The system must delegate ingress authentication to the underlying resource's auth mechanism, supporting at minimum `sdk_auth` (pk\_\* key validation), `hmac` (HMAC-SHA256 signature verification), `api_key`, `jwt`, `token`, and `none` modes, and rejecting unauthenticated requests with the appropriate HTTP status (401 for missing credentials, 403 for invalid credentials).

5. **FR-4**: The system must maintain existing channel-specific URLs (`/api/v1/channels/:channelType/webhook/:identifier`) and trigger-specific URLs unchanged, with no breaking changes to external integrations.

6. **FR-5**: The system must allow CRUD operations on endpoints via `GET|POST|PATCH|DELETE /api/projects/:projectId/deployment-endpoints` without requiring a redeployment. Listing must support filtering by `deploymentId` and/or `environment`. Creating custom endpoints must require an explicit `deploymentId`.

7. **FR-6**: The system must track health metrics on every endpoint: `lastInvokedAt`, `consecutiveErrors`, `lastErrorAt`, and auto-transition to `degraded` status after a configurable error threshold.

8. **FR-7**: The system must emit an `endpoint.invoked` TraceEvent at the ingress layer for every endpoint invocation, including `endpointId`, `deploymentId`, `targetType`, `authMode`, `durationMs`, and `status` (success/error).

9. **FR-8**: The system must support `active`, `paused`, `degraded`, and `error` endpoint statuses, with `paused` endpoints returning `503 Service Unavailable` and `error` endpoints returning `503` with error details.

10. **FR-9**: The system must display all deployment endpoints in a unified "Endpoints" tab in the Studio deployment detail view, showing endpoint path, target type, status, health metrics, and last invoked timestamp.

11. **FR-10**: The system must resolve target versions from the deployment's version manifests at request time: `agentVersionManifest` for conversational endpoints (SDK channels, channel connections), `workflowVersionManifest` for trigger endpoints. Channel connection endpoints delegate to the existing adapter pipeline for provider-specific resolution. No denormalized version copies on the endpoint.

12. **FR-11**: The system must clean up (soft-delete) deployment endpoints when a deployment is retired, and create fresh endpoints when a new deployment replaces it.

13. **FR-12**: The system must support optional per-endpoint rate limiting (`rateLimitRpm`) as an additional layer on top of the always-on tenant-level rate limit. Per-endpoint rate limiting requires a new Redis key namespace (`ratelimit:endpoint:{endpointId}`) distinct from the existing tenant-level keys.

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                                  |
| -------------------------- | ------------ | ---------------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Endpoints are project-scoped, created during deployment lifecycle      |
| Agent lifecycle            | SECONDARY    | Agent endpoints are resolved via deployment's agentVersionManifest     |
| Customer experience        | PRIMARY      | Unified URL scheme improves developer experience for SDK/API consumers |
| Integrations / channels    | PRIMARY      | Core feature -- unifies all deployment-exposed integration surfaces    |
| Observability / tracing    | SECONDARY    | Adds endpoint-level TraceEvent emission and health aggregation         |
| Governance / controls      | SECONDARY    | Unified endpoint view enables better security auditing                 |
| Enterprise / compliance    | SECONDARY    | Tenant isolation enforced at endpoint layer                            |
| Admin / operator workflows | SECONDARY    | Single-pane endpoint management replaces multi-surface navigation      |

### Related Feature Integration Matrix

| Related Feature                                       | Relationship Type | Why It Matters                                                                                  | Key Touchpoints                                                                      | Current State                                                     |
| ----------------------------------------------------- | ----------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------- |
| [Deployments & Versioning](deployments-versioning.md) | extends           | Endpoints extend the deployment model with an external surface layer                            | `Deployment.endpointSlug`, deployment create/retire/rollback routes, auto-follow     | BETA -- deployment model has `endpointSlug` but it's not routable |
| [Channels](channels.md)                               | depends on        | Channel adapters remain the execution backend for conversational endpoints                      | `ChannelAdapter` interface, `CHANNEL_MANIFEST`, session factory, connection resolver | STABLE -- 27 channel types, manifest-driven                       |
| [Workflows & Human Tasks](workflows.md)               | depends on        | Workflow triggers remain the execution backend for automation endpoints                         | `TriggerEngine`, `TriggerRegistration`, Restate workflow runner                      | ALPHA -- trigger system functional                                |
| [Webhook System](webhook-system.md)                   | shares data with  | HTTP Async webhook subscriptions could be surfaced as endpoints                                 | `WebhookSubscription` model, delivery worker                                         | ALPHA -- outbound delivery functional                             |
| [SDK](sdk.md)                                         | extends           | SDK init flow could use deployment-scoped URLs as an alternative to `pk_*` key-based resolution | `POST /api/v1/sdk/init`, SDK channel auth                                            | BETA -- SDK channels linked to deployments                        |
| [Tracing & Observability](tracing-observability.md)   | emits into        | Endpoint invocations emit TraceEvents into the shared trace infrastructure                      | `TraceStore`, `TraceEvent` schema                                                    | STABLE -- trace infrastructure available                          |
| [Rate Limiting](rate-limiting.md)                     | configured by     | Per-endpoint rate limits override tenant defaults                                               | `tenantRateLimit`, SDK channel `rateLimitRpm`                                        | STABLE -- tenant-level rate limiting active                       |

---

## 6. Design Considerations

### URL Scheme

The unified URL scheme uses the deployment's existing `endpointSlug` (already unique and indexed) plus a developer-chosen endpoint `path`:

```
POST /api/v1/deployments/{endpointSlug}/endpoints/{path}
GET  /api/v1/deployments/{endpointSlug}/endpoints/{path}
```

Examples:

- `POST /api/v1/deployments/abc12345-production-1712700000-x7k9/endpoints/channels/web-chat` -- SDK web chat
- `POST /api/v1/deployments/abc12345-production-1712700000-x7k9/endpoints/channels/slack` -- Slack connection
- `POST /api/v1/deployments/abc12345-production-1712700000-x7k9/endpoints/triggers/order-processor` -- workflow trigger

### Endpoint Auto-Creation

During deployment creation (extending the existing pipeline in `routes/deployments.ts`):

1. After the existing `bulkUpdateChannelDeployment()` step, query all linked SDK channels and channel connections for the project+environment
2. Query all active trigger registrations for the project+environment
3. Create `DeploymentEndpoint` records for each, with type-prefixed auto-generated `path` values (e.g., `channels/{name}` for SDK channels and connections, `triggers/{name}` for trigger registrations)
4. On deployment retirement, soft-delete the associated endpoints

### Studio UX

The deployment detail page gains an "Endpoints" tab alongside the existing Channels tab. The Endpoints tab shows:

- A table of all endpoints with columns: Path, Target Type, Target Name, Status, Auth Mode, Last Invoked, Error Rate
- Inline actions: Pause/Resume, Edit rate limit, Copy URL
- Health indicators (green/yellow/red based on `consecutiveErrors`)

The existing Channels tab remains for detailed channel configuration (credentials, provider settings, OAuth). Endpoints provide the overview; channels/triggers provide the detail.

---

## 7. Technical Considerations

### Design Rationale: Why a Separate Model?

Alternatives considered:

1. **Extend existing models** -- Add endpoint fields (path, health, rate limit) directly to SDKChannel, ChannelConnection, and TriggerRegistration. Rejected because: (a) these models serve different domains with different lifecycle concerns, (b) adding cross-cutting fields to three models creates maintenance burden and inconsistency, (c) new target types in the future would require finding yet another model to extend.
2. **Virtual/computed endpoints** -- No stored record; compute endpoints dynamically by querying all linked resources at request time. Rejected because: (a) no place to store per-endpoint configuration (rate limits, status overrides), (b) no place for health tracking state, (c) endpoint path assignment requires persistence.
3. **New unified model replacing all three** -- A single "surface" model replacing SDKChannel, ChannelConnection, and TriggerRegistration. Rejected because: (a) massive migration, (b) domain-specific state (provider credentials, BullMQ scheduler refs, encrypted secrets) doesn't belong in a generic model, (c) violates additive commit discipline.

The chosen approach -- a thin routing/discovery record that references underlying resources -- provides unified addressing and health without disturbing the mature domain models.

### Abstraction Layer, Not Replacement

DeploymentEndpoint is a thin routing/discovery record. It does NOT replace or duplicate:

- SDKChannel's auth lifecycle (pk\_\* keys, hosted_exchange, server secrets)
- ChannelConnection's encrypted credentials and provider-specific config
- TriggerRegistration's BullMQ job references, cron scheduling, and polling mechanics

The endpoint stores: `deploymentId`, `path`, `targetType`, `targetId`, `authMode`, `status`, `rateLimitRpm`, and health fields. Everything else is resolved from the underlying resource and the deployment's version manifests at request time.

### Request Flow (Conversational Endpoint)

```
Request -> /api/v1/deployments/{slug}/endpoints/{path}
  -> EndpointResolver: lookup endpoint by slug + path
  -> Auth: delegate to channel manifest's authMode
  -> ChannelAdapter pipeline: verifyRequest -> parseIncoming -> execution -> sendResponse
```

The full adapter pipeline MUST execute. Skipping `verifyRequest` (signature verification) or `parseIncoming` (payload normalization) would be a security and correctness violation.

### Request Flow (Trigger Endpoint)

```
Request -> /api/v1/deployments/{slug}/endpoints/{path}
  -> EndpointResolver: lookup endpoint by slug + path
  -> Auth: HMAC verification (from TriggerRegistration.webhookSecret)
  -> TriggerEngine.fire(): resolve workflow version from deployment manifest, start Restate execution
```

### Deployment Version Resolution

Endpoints do NOT store agent names or workflow names. At request time:

1. `DeploymentResolver.resolveByDeployment()` loads the deployment and its `agentVersionManifest`/`workflowVersionManifest`
2. The entry agent name or workflow name comes from the deployment's manifests
3. The existing L1/L2 compilation caching in `DeploymentResolver` provides adequate performance

### Rollback Behavior

When a deployment is rolled back (via `POST /:deploymentId/rollback`), the runtime creates a new deployment with the previous deployment's configuration. This new deployment triggers the standard FR-2 auto-creation pipeline, producing fresh endpoint records. The rolled-back deployment's endpoints remain soft-deleted. There is no endpoint restoration from soft-deleted state -- rollback creates new endpoints, matching the existing pattern where rollback creates a new Deployment document (not reactivating the old one).

### Provider-Registered Webhook URLs

Channel connections with provider-registered webhook URLs (Slack, WhatsApp, Teams, etc.) continue to use their existing URLs (`/api/v1/channels/:channelType/webhook/:identifier`). The unified endpoint is a discovery/reference record for these connections, not a replacement ingress path. External providers store the channel-specific URL and cannot be updated to use the unified scheme without customer action. The unified URL is primarily practical for SDK, HTTP Async, and other caller-controlled integrations where the platform consumer controls the URL they call.

### Express Route Ordering

Per CLAUDE.md: "Static routes MUST be registered BEFORE parameterized routes." The unified endpoint routes (`/api/v1/deployments/:slug/endpoints/:path`) must be registered with care to avoid capturing other deployment routes. The `:path` parameter should use a wildcard segment or be registered after all static deployment sub-routes.

---

## 8. How to Consume

### Studio UI

| Screen                   | Route                                                    | Description                                                           |
| ------------------------ | -------------------------------------------------------- | --------------------------------------------------------------------- |
| Deployment Endpoints Tab | `/projects/:id/deployments` (Endpoints tab)              | Table of all endpoints for the active deployment with health/status   |
| Endpoint Detail          | `/projects/:id/deployments` (Endpoints tab -> row click) | Endpoint config, URL preview, health history, linked resource details |

### API (Runtime)

| Method | Path                                                               | Purpose                                                  |
| ------ | ------------------------------------------------------------------ | -------------------------------------------------------- |
| POST   | `/api/v1/deployments/:slug/endpoints/:path`                        | Invoke an endpoint (route to channel adapter or trigger) |
| GET    | `/api/v1/deployments/:slug/endpoints/:path`                        | Invoke an endpoint (for webhook verification challenges) |
| GET    | `/api/projects/:projectId/deployment-endpoints`                    | List endpoints for a project's active deployment         |
| POST   | `/api/projects/:projectId/deployment-endpoints`                    | Create a custom endpoint                                 |
| PATCH  | `/api/projects/:projectId/deployment-endpoints/:endpointId`        | Update endpoint config (rate limit, status, path)        |
| DELETE | `/api/projects/:projectId/deployment-endpoints/:endpointId`        | Soft-delete an endpoint                                  |
| GET    | `/api/projects/:projectId/deployment-endpoints/:endpointId/health` | Get endpoint health metrics                              |

### API (Studio)

| Method | Path                                                   | Purpose                            |
| ------ | ------------------------------------------------------ | ---------------------------------- |
| GET    | `/api/projects/[id]/deployment-endpoints`              | Proxy to Runtime for endpoint list |
| PATCH  | `/api/projects/[id]/deployment-endpoints/[endpointId]` | Proxy to Runtime for config update |

### Admin Portal

- Tenant-level endpoint inventory view (all endpoints across projects)
- Health dashboard aggregation

### Channel / SDK / Voice / A2A / MCP Integration

This feature does not change how channels operate internally. All channel adapters continue to work as-is. The unified endpoint layer adds an alternative ingress path that delegates to the same adapter pipeline. Channels that receive webhooks from external providers (Slack, WhatsApp, etc.) continue to use their existing URLs. The unified URL is primarily for SDK, HTTP Async, and programmatic integrations where the caller controls the URL.

---

## 9. Data Model

### Collections / Tables

```text
Collection: deployment_endpoints
Fields:
  - _id: string (uuidv7)
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - deploymentId: string (required, indexed)
  - path: string (required, unique within deployment)
  - displayName: string
  - targetType: string (required, enum: 'sdk_channel' | 'channel_connection' | 'trigger_registration')
  - targetId: string (required, references underlying resource)
  - authMode: string (enum: 'sdk_auth' | 'api_key' | 'hmac' | 'jwt' | 'token' | 'none')
  - status: string (enum: 'active' | 'paused' | 'degraded' | 'error', default: 'active')
  - rateLimitRpm: number | null (optional per-endpoint override)
  - lastInvokedAt: Date | null
  - lastErrorAt: Date | null
  - consecutiveErrors: number (default: 0)
  - errorThreshold: number (default: 5, triggers degraded status)
  - createdBy: string (userId for manual creation, 'system' for auto-creation)
  - metadata: Mixed (extensible, for future use)
  - deletedAt: Date | null (soft delete)
  - _v: number (optimistic locking)
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1 } (tenant isolation)
  - { deploymentId: 1, path: 1 } (unique, for endpoint resolution)
  - { tenantId: 1, deploymentId: 1, status: 1 } (list active endpoints)
  - { targetType: 1, targetId: 1 } (reverse lookup)
  - { deletedAt: 1 } (exclude soft-deleted in queries)
Plugins:
  - tenantIsolationPlugin (enforces tenantId scoping)
```

### Key Relationships

```text
Deployment (1) ----< (N) DeploymentEndpoint     (via deploymentId)
DeploymentEndpoint (1) ----> (1) SDKChannel           (when targetType = 'sdk_channel')
DeploymentEndpoint (1) ----> (1) ChannelConnection    (when targetType = 'channel_connection')
DeploymentEndpoint (1) ----> (1) TriggerRegistration  (when targetType = 'trigger_registration')
```

The `DeploymentEndpoint` is a thin pointer. It does not duplicate data from the target model. All domain-specific fields (credentials, scheduling config, provider settings) remain on the underlying model.

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                        | Purpose                                                   |
| ----------------------------------------------------------- | --------------------------------------------------------- |
| `packages/database/src/models/deployment-endpoint.model.ts` | New -- Mongoose model for DeploymentEndpoint              |
| `apps/runtime/src/services/endpoint-resolver.ts`            | New -- resolves endpoint by deployment slug + path        |
| `apps/runtime/src/services/deployment-resolver.ts`          | Existing -- extended to support endpoint-based resolution |
| `apps/runtime/src/repos/deployment-endpoint-repo.ts`        | New -- CRUD repository for deployment endpoints           |

### Routes / Handlers

| File                                              | Purpose                                                               |
| ------------------------------------------------- | --------------------------------------------------------------------- |
| `apps/runtime/src/routes/deployment-endpoints.ts` | New -- CRUD routes for endpoint management                            |
| `apps/runtime/src/routes/endpoint-ingress.ts`     | New -- unified ingress route for `/deployments/:slug/endpoints/:path` |
| `apps/runtime/src/routes/deployments.ts`          | Existing -- extended to auto-create endpoints during deployment       |

### UI Components

| File                                                                  | Purpose                                           |
| --------------------------------------------------------------------- | ------------------------------------------------- |
| `apps/studio/src/components/deployments/endpoints/EndpointsTab.tsx`   | New -- unified endpoints tab in deployment detail |
| `apps/studio/src/components/deployments/endpoints/EndpointRow.tsx`    | New -- endpoint row with status, health, actions  |
| `apps/studio/src/components/deployments/endpoints/EndpointDetail.tsx` | New -- endpoint config and health detail view     |
| `apps/studio/src/api/deployment-endpoints.ts`                         | New -- API client for endpoint CRUD               |

### Jobs / Workers / Background Processes

| File                                                  | Purpose                                                   |
| ----------------------------------------------------- | --------------------------------------------------------- |
| `apps/runtime/src/workers/endpoint-health-monitor.ts` | New -- periodic health aggregation and status transitions |

### Tests

| File                                                          | Type        | Coverage Focus                                |
| ------------------------------------------------------------- | ----------- | --------------------------------------------- |
| `apps/runtime/src/__tests__/endpoint-resolver.test.ts`        | unit        | Endpoint resolution logic, slug+path lookup   |
| `apps/runtime/src/__tests__/deployment-endpoint-crud.test.ts` | integration | CRUD operations with tenant/project isolation |
| `apps/runtime/e2e/deployment-endpoint-ingress.spec.ts`        | e2e         | Full ingress flow through unified URL         |
| `apps/runtime/e2e/deployment-endpoint-auto-create.spec.ts`    | e2e         | Auto-creation during deployment pipeline      |
| `apps/runtime/e2e/deployment-endpoint-health.spec.ts`         | e2e         | Health tracking and status transitions        |

---

## 11. Configuration

### Environment Variables

| Variable                            | Default | Description                                    |
| ----------------------------------- | ------- | ---------------------------------------------- |
| `ENDPOINT_ERROR_THRESHOLD`          | `5`     | Consecutive errors before auto-degraded status |
| `ENDPOINT_HEALTH_CHECK_INTERVAL_MS` | `60000` | Interval for health status aggregation worker  |

### Runtime Configuration

- Per-endpoint `rateLimitRpm` overrides tenant-level rate limit
- Endpoint `status` can be toggled via API (pause/resume) without redeployment
- `errorThreshold` per endpoint for health auto-degradation

### DSL / Agent IR / Schema

No changes to the ABL DSL or AgentIR. Endpoints are a deployment-layer concern, not an agent definition concern.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                 |
| ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Every endpoint read/write must include `projectId` and cross-project access must return 404.                                              |
| Tenant isolation  | Every endpoint read/write must include `tenantId` and cross-tenant access must return 404. `tenantIsolationPlugin` enforced on the model. |
| User isolation    | Endpoint CRUD requires project-level permissions (`deployment:read`, `deployment:update`). Endpoints are project-owned, not user-owned.   |

### Security & Compliance

- Auth mode is declared per endpoint and delegated to the underlying channel/trigger auth mechanism. No new auth flows introduced.
- `createUnifiedAuthMiddleware`/`requireAuth` used for all management routes (CRUD). Ingress routes use the endpoint's declared auth mode.
- Endpoint paths are validated to prevent path traversal attacks (alphanumeric, hyphens, underscores only).
- No secrets stored on the endpoint model itself -- all secrets remain on the underlying resources (SDKChannel server secrets, TriggerRegistration webhook secrets, ChannelConnection encrypted credentials).
- Audit logging via `endpoint.invoked` TraceEvent for compliance visibility.

### Performance & Scalability

- Endpoint resolution is a single indexed query (`{ deploymentId, path }` compound unique index) -- O(1) with B-tree index.
- Version resolution uses existing `DeploymentResolver` with L1/L2 compilation caching -- no new cache layer needed.
- Health tracking uses atomic `$inc` for `consecutiveErrors` and `$set` for `lastInvokedAt` to avoid read-modify-write races.
- Rate limiting at endpoint ingress uses the existing Redis-backed `tenantRateLimit` infrastructure.

### Reliability & Failure Modes

- If an endpoint's underlying resource is deleted (e.g., SDK channel removed), the endpoint returns `502 Bad Gateway` with error details. The endpoint is NOT auto-deleted -- it enters `error` status for operator visibility.
- Degraded/error status is recoverable: consecutive successful invocations reset `consecutiveErrors` and transition status back to `active`.
- Soft-delete ensures endpoints can be recovered if accidentally removed.

### Observability

- `endpoint.invoked` TraceEvent emitted at ingress for every invocation (success and failure)
- TraceEvent fields: `endpointId`, `deploymentId`, `deploymentSlug`, `path`, `targetType`, `targetId`, `authMode`, `requestTimestamp`, `responseTimestamp`, `durationMs`, `httpStatus`, `errorCode`
- Health status changes emit `endpoint.health_changed` events for alerting integration
- Existing channel and workflow trace events continue to fire downstream -- the endpoint event is the ingress-layer addition

### Data Lifecycle

- Endpoints are soft-deleted when their deployment is retired (`deletedAt` set, excluded from queries)
- Hard deletion via TTL: endpoints with `deletedAt` older than 30 days are eligible for cleanup
- No PII stored on endpoint records (all PII is in the underlying resources)
- Endpoint records follow the project's data retention policy

---

## 13. Delivery Plan / Work Breakdown

### Phase 1: Core Model & Auto-Creation

1. DeploymentEndpoint model and repository
   1.1 Create `deployment-endpoint.model.ts` with schema, indexes, plugins
   1.2 Create `deployment-endpoint-repo.ts` with CRUD, bulk create, and resolution queries
   1.3 Unit tests for repository operations with tenant/project isolation

2. Endpoint auto-creation during deployment
   2.1 Extend `routes/deployments.ts` deployment create pipeline to auto-create endpoints for linked SDK channels, channel connections, and trigger registrations
   2.2 Extend deployment retire flow to soft-delete associated endpoints
   2.3 Integration tests for auto-creation and cleanup

3. CRUD routes for endpoint management
   3.1 Create `routes/deployment-endpoints.ts` with list, create, update, delete
   3.2 Zod validation schemas for endpoint create/update payloads
   3.3 Wire `createUnifiedAuthMiddleware`/`requireAuth` and project-scoped permission checks on all CRUD routes
   3.4 Integration tests for CRUD with auth and isolation

### Phase 2: Unified Ingress Route

4. EndpointResolver service
   4.1 Create `endpoint-resolver.ts` -- resolve by deployment slug + path
   4.2 Integrate with existing `DeploymentResolver` for version resolution
   4.3 Unit tests for resolution logic

5. Ingress route
   5.1 Create `routes/endpoint-ingress.ts` -- unified POST/GET handler
   5.2 Route to channel adapter pipeline for conversational targets
   5.3 Route to trigger engine fire for trigger targets
   5.4 Implement auth mode delegation at ingress -- map endpoint `authMode` to existing auth verification functions (SDK key validation, HMAC signature verification, JWT validation, passthrough for `none`)
   5.5 E2E tests for full ingress flow (SDK channel via unified URL, trigger via unified URL)

### Phase 3: Health & Observability

6. Health tracking
   6.1 Add atomic health field updates on endpoint invocation
   6.2 Implement status auto-transitions (active -> degraded -> error on threshold, error -> active on recovery)
   6.3 Create `endpoint-health-monitor.ts` background worker
   6.4 Integration tests for health state machine

7. Observability
   7.1 Add `endpoint.invoked` TraceEvent emission at ingress
   7.2 Add `endpoint.health_changed` event emission on status transitions
   7.3 Integration tests for trace event content

### Phase 4: Studio UI

8. Endpoints tab
   8.1 Create `EndpointsTab.tsx` with endpoint table, status badges, health indicators
   8.2 Create `EndpointRow.tsx` with inline actions (pause/resume, copy URL)
   8.3 Create `EndpointDetail.tsx` with config editing and health history
   8.4 Create `deployment-endpoints.ts` API client
   8.5 Wire endpoints tab into deployment detail page

### Phase 5: Migration & Backfill (Optional)

9. Backfill script
   9.1 One-time script to create endpoints for existing active deployments
   9.2 Dry-run mode for safety
   9.3 Idempotent (skip if endpoint already exists for target)

---

## 14. Success Metrics

| Metric                          | Baseline  | Target                                   | How Measured                                              |
| ------------------------------- | --------- | ---------------------------------------- | --------------------------------------------------------- |
| Endpoint resolution p99 latency | N/A (new) | < 10ms                                   | TraceEvent `durationMs` for endpoint resolution step      |
| Auto-creation success rate      | N/A (new) | > 99.9%                                  | Deployment creation events vs endpoint creation events    |
| Studio endpoint tab load time   | N/A (new) | < 500ms                                  | Client-side performance metrics                           |
| Unified URL adoption            | 0%        | 30% of new integrations in 3 months      | Ratio of unified URL invocations vs channel-specific URLs |
| Endpoint health accuracy        | N/A       | Status matches actual availability > 95% | Health worker checks vs actual invocation success rate    |

---

## 15. Resolved Design Decisions (formerly Open Questions)

1. **Deployment `endpointSlug` is NOT user-configurable in Phase 1.** Auto-generated slugs work. User-friendly aliases (e.g., `my-project-prod`) add uniqueness management, validation, and reserved-word complexity. Revisit when API product packaging needs it in a future phase.

2. **Endpoint paths are type-prefixed.** Auto-created paths use the pattern `channels/{name}`, `triggers/{name}` (e.g., `channels/slack`, `triggers/order-processor`). This eliminates collisions by construction -- a channel and trigger can share the same name without conflict. URLs read well: `/api/v1/deployments/{slug}/endpoints/triggers/order-processor`. Custom endpoints created via CRUD can use any valid path.

3. **Webhook verification challenges are the adapter's responsibility.** Provider-registered channels (Slack, WhatsApp, Teams) continue using their existing channel-specific URLs. If a verification challenge arrives at the unified URL, it flows through the normal adapter pipeline -- `verifyRequest` already handles challenges. No new logic needed at the endpoint layer.

4. **Endpoint CRUD reuses `deployment:read`/`deployment:update` permissions in Phase 1.** Endpoints are a deployment concern. Adding separate `endpoint:*` permissions increases RBAC surface area without clear demand. Revisit when API products need per-endpoint access control.

5. **Provider-registered channel connection endpoints are invocable (not discovery-only).** The adapter pipeline works regardless of which URL the request arrives on. Marking endpoints as `discovery_only` adds a special-case status and conditional logic for no practical benefit. Direct invocation through the unified URL is useful for testing and debugging even if the provider itself uses the channel-specific URL.

## 15b. Open Questions

1. **Should auto-created endpoint paths use the resource's `name` or `externalIdentifier`?** SDK channels have unique names within a project. Channel connections have `externalIdentifier` (Slack team:app ID, WhatsApp number). Trigger registrations have `triggerName`. Using names is more readable; using identifiers avoids issues if names contain special characters or are renamed.

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                   | Severity | Status |
| ------- | ------------------------------------------------------------------------------------------------------------- | -------- | ------ |
| GAP-001 | Scheduled agents (cron -> agent without workflow) not supported -- TriggerRegistration requires `workflowId`  | Medium   | Open   |
| GAP-002 | External provider webhook URLs (Slack, WhatsApp) cannot be migrated to unified scheme without provider action | Low      | Open   |
| GAP-003 | Composite routing / router target type deferred                                                               | Low      | Open   |
| GAP-004 | No request_response invocation type for sync workflow results (deferred to future phase)                      | Medium   | Open   |
| GAP-005 | Backfill migration for existing deployments not included in Phase 1                                           | Low      | Open   |
| GAP-006 | API product packaging (unified API keys, usage metering across endpoints) deferred                            | Medium   | Open   |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                  | Coverage Type | Status     | Test File / Note                          |
| --- | --------------------------------------------------------- | ------------- | ---------- | ----------------------------------------- |
| 1   | Endpoint CRUD with tenant isolation (cross-tenant -> 404) | e2e           | NOT TESTED | `deployment-endpoint-isolation.spec.ts`   |
| 2   | Endpoint CRUD with project isolation (cross-project 404)  | e2e           | NOT TESTED | `deployment-endpoint-isolation.spec.ts`   |
| 3   | Auto-create endpoints during deployment                   | e2e           | NOT TESTED | `deployment-endpoint-auto-create.spec.ts` |
| 4   | Invoke SDK channel via unified URL                        | e2e           | NOT TESTED | `deployment-endpoint-ingress.spec.ts`     |
| 5   | Invoke workflow trigger via unified URL                   | e2e           | NOT TESTED | `deployment-endpoint-ingress.spec.ts`     |
| 6   | Endpoint health degradation on consecutive errors         | integration   | NOT TESTED | `deployment-endpoint-health.spec.ts`      |
| 7   | Endpoint health recovery on successful invocation         | integration   | NOT TESTED | `deployment-endpoint-health.spec.ts`      |
| 8   | Paused endpoint returns 503                               | integration   | NOT TESTED | `deployment-endpoint-crud.test.ts`        |
| 9   | Endpoint soft-delete on deployment retirement             | integration   | NOT TESTED | `deployment-endpoint-auto-create.spec.ts` |
| 10  | TraceEvent emission on endpoint invocation                | integration   | NOT TESTED | `deployment-endpoint-ingress.spec.ts`     |
| 11  | Rate limit enforcement at endpoint level                  | integration   | NOT TESTED | `deployment-endpoint-ingress.spec.ts`     |
| 12  | Endpoint resolution with invalid slug -> 404              | e2e           | NOT TESTED | `deployment-endpoint-ingress.spec.ts`     |
| 13  | Version resolution via unified URL serves pinned version  | e2e           | NOT TESTED | `deployment-endpoint-ingress.spec.ts`     |
| 14  | Auth rejection on unified ingress (invalid/missing creds) | e2e           | NOT TESTED | `deployment-endpoint-ingress.spec.ts`     |

### Testing Notes

All tests must exercise the real system through HTTP API. No mocking of platform components. E2E tests start real Express servers, use full middleware chains, and verify tenant/project isolation by attempting cross-boundary access (expecting 404).

> Full testing details: [docs/testing/unified-deployment-endpoints.md](../testing/unified-deployment-endpoints.md)

---

## 18. References

- Design docs: (to be created -- `/hld` and `/lld` pending)
- Related feature docs: [Deployments & Versioning](deployments-versioning.md), [Channels](channels.md), [Workflows](workflows.md), [Webhook System](webhook-system.md), [SDK](sdk.md)
- Models: `packages/database/src/models/deployment.model.ts`, `sdk-channel.model.ts`, `channel-connection.model.ts`, `trigger-registration.model.ts`
- Runtime services: `apps/runtime/src/services/deployment-resolver.ts`, `apps/runtime/src/channels/manifest.ts`
- Studio types: `apps/studio/src/components/deployments/channels/types.ts`
