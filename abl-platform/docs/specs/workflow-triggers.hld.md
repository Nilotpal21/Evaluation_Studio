# HLD: Workflow Triggers

**Feature Spec**: [`docs/features/sub-features/workflow-triggers.md`](../features/sub-features/workflow-triggers.md)
**Test Spec**: [`docs/testing/sub-features/workflow-triggers.md`](../testing/sub-features/workflow-triggers.md)
**Parent HLD**: [`docs/specs/workflows.hld.md`](workflows.hld.md)
**Status**: DRAFT
**Author**: Runtime Team
**Date**: 2026-03-24
**Last Updated**: 2026-04-19

## Post-Implementation Notes (2026-04-19 — trigger-surface polish)

One additive commit on `feat/workflow-version` under ABLP-2 closed four operational gaps that surfaced when exercising the trigger UI against deployments without a BullMQ scheduler and against preset-only legacy records:

- **Canonical cron config at register time** (feature spec GAP-008): `TriggerEngine.register()` now resolves preset/cronExpression into a canonical expression and writes it to both `config.cronExpression` (primary) and the legacy top-level `cronExpression` field. `resume()` reads `config.cronExpression` first. The UI consequently renders the actual schedule — or, for older preset-only records, a `formatCronPreset` summary — instead of "Schedule not configured".
- **Scheduler-absent visibility** (GAP-009): cron triggers registered when `deps.scheduler` is unavailable are still persisted; `register()` and `resume()` emit explicit warn logs so the silent no-fire condition is observable in service logs.
- **Fire Now fail-fast** (GAP-010): `WorkflowTriggersTab` checks `trigger.status !== 'active'` and sets a clear inline error before calling the backend.
- **Trigger list skeleton** (GAP-011): SWR `isLoading` drives a Skeleton placeholder matching the card layout, replacing the brief `EmptyState` flash.

No architectural decisions overturned. Component diagram, data flow, and API design unchanged. These are additive fixes on existing flows; no rollout sequencing required beyond the single commit.

---

## 1. Overview & Goal

Enable workflows to be invoked from external systems via API, on a schedule, or in response to external app events — extending the existing trigger infrastructure with a public Process API, timezone-aware scheduling presets, and an external app trigger catalog.

### Problem Statement

Workflows today can only be started manually (Studio UI or internal JWT-authenticated API). External systems cannot invoke workflows via a simple API key, there is no sync/async execution mode, no timezone-aware scheduling with friendly presets, and no async result push mechanism.

### Design Goal

This design extends the existing trigger infrastructure to add:

1. **Process API** (`POST /api/v1/process/:workflowId`) — public-facing, API-key-authenticated, supporting sync (inline result ≤30s) and async (traceId + poll/push) execution modes
2. **Time-based scheduling enhancements** — friendly presets (daily/weekly/monthly/once/cron) with IANA timezone support via BullMQ native `tz`
3. **External app trigger catalog** — static listing of available connectors (display only, implementation separate)

The design reuses existing infrastructure: platform API keys (`abl_*`), unified auth middleware, TriggerRegistration model, TriggerScheduler, Redis Pub/Sub completion events, and webhook signature utilities.

---

## 2. Alternatives Considered

### Option A: Process API as Runtime Route with Redis Pub/Sub Sync Wait

- **Description**: New routes in `apps/runtime/` handle auth + scope checking. For sync execution: subscribe to existing Redis Pub/Sub completion channel, proxy start-execution to workflow-engine, wait up to 30s for completion event, return result or auto-promote to async (HTTP 202). For async: proxy start and return traceId immediately.
- **Pros**: Leverages existing Redis Pub/Sub channel (`workflow:{tenantId}:execution:{executionId}:status`) already published by `workflow-handler.ts`. No polling overhead. Runtime already has Redis connection. Maintains architectural boundary (Restate stays internal to workflow-engine).
- **Cons**: Requires new subscriber Redis connection in runtime (dedicated for Pub/Sub). Race condition risk if workflow completes before subscription established (mitigated by subscribing before starting). Redis unavailability degrades sync to async.
- **Effort**: M

### Option B: Process API with Database Polling for Sync Wait

- **Description**: Same route structure as Option A, but instead of Redis Pub/Sub, poll `WorkflowExecution` collection every 500ms until status changes from `running` to terminal.
- **Pros**: No Redis dependency for sync wait. Simpler implementation — no Pub/Sub lifecycle management.
- **Cons**: Polling creates MongoDB load (60 queries per 30s sync wait per request). Higher latency (500ms polling interval). Doesn't scale well with concurrent sync requests. Wastes resources polling a document that may not change for 30s.
- **Effort**: S

### Option C: Process API in Workflow-Engine (Direct Restate Access)

- **Description**: Place Process API routes directly in `apps/workflow-engine/` alongside existing execution routes. Runtime proxies all process requests to workflow-engine (like existing trigger routes).
- **Pros**: Direct access to Restate client — can potentially use the Restate ingress API to attach to a workflow and await its output. No Redis Pub/Sub subscription needed.
- **Cons**: Breaks architectural boundary — workflow-engine is not public-facing (port 9080, internal). Would need to add API key auth to workflow-engine (duplicating runtime's auth layer). Restate's `awaitResult` blocks the Express thread, reducing concurrency. Couples public API surface to internal service.
- **Effort**: M

### Recommendation: Option A — Runtime Route with Redis Pub/Sub

**Rationale**: Reuses the existing Redis Pub/Sub completion channel (already published by `workflow-handler.ts` lines 811-813), maintains the runtime-as-public-gateway architecture, and avoids database polling overhead. The race condition is eliminated by having runtime generate the `executionId` (UUIDv7) and subscribe to the completion channel BEFORE proxying the start-execution request — the `executionId` is passed with the start request so workflow-engine uses it (not a self-generated one). Redis Pub/Sub subscriber lifecycle is the main complexity, but it's bounded (one subscribe/unsubscribe per sync request with a 30s max TTL).

---

## 3. Architecture

### System Context Diagram

```
                              External Systems
                              (API consumers)
                                    |
                            Authorization: Bearer abl_*
                                    |
                                    v
                    +-------------------------------+
                    |     Runtime (port 3112)        |
                    |                               |
                    |  [Process API routes]  <new>  |
                    |  [Unified Auth Middleware]     |
                    |  [Tenant Rate Limiting]        |
                    |                               |
                    +-------+----------+------------+
                            |          |
                   start    |          | subscribe
                  workflow  |          | completion
                            v          v
          +------------------+    +---------+
          | Workflow Engine   |    |  Redis  |
          | (port 9080)      |    | Pub/Sub |
          |                  |    |         |
          | [workflow-handler]+--->| publish |
          | [trigger-engine] |    +---------+
          | [trigger-scheduler]       |
          | [callback-worker] <new>   |
          | [preset-resolver] <new>   |
          +--------+---------+--------+
                   |         |
                   v         v
              +--------+ +--------+
              | Restate| | BullMQ |
              | (9070) | | queues |
              +--------+ +--------+
                   |
                   v
              +---------+
              | MongoDB |
              +---------+

  Studio UI (port 5173)
       |
  JWT auth
       |
       v
  [Trigger CRUD] --> Runtime proxy --> Workflow Engine
  [Schedule Presets] <new>
  [Webhook Quick Start] <new>
  [Auto-Key Creation] <new>
```

### Component Diagram

```
runtime/
  routes/
    process-api.ts          <NEW>  POST /process/:workflowId
                                   GET  /process/:workflowId/status
  services/
    sync-execution.ts       <NEW>  Redis Pub/Sub subscribe + timeout
  middleware/
    auth.ts                 <EXT>  resolveApiKey() already handles abl_*
    workflow-engine-proxy.ts <EXT> proxy trigger routes (unchanged)

workflow-engine/
  services/
    preset-resolver.ts      <NEW>  preset config → cron + BullMQ options
    callback-delivery-worker.ts <NEW>  BullMQ worker on workflow-callbacks
    trigger-engine.ts       <EXT>  add webhook trigger type handling
    trigger-scheduler.ts    <EXT>  add tz option to scheduleCron()
  handlers/
    workflow-handler.ts     <USE>  publishes completion to Redis Pub/Sub
  pubsub/
    redis-publisher.ts      <USE>  existing completion event publisher

packages/database/
  models/
    trigger-registration.model.ts <EXT> connectorName/connectionId → optional
    api-key.model.ts              <USE> no changes needed

packages/shared-kernel/
  security/
    webhook-signature.ts    <USE>  HMAC signing for callback delivery

studio/
  workflows/triggers/
    WebhookQuickStart.tsx         <NEW>
    WebhookKeyCreationModal.tsx   <NEW>
    SchedulePresetPicker.tsx      <NEW>
    CodeSnippets.tsx              <NEW>
    ExternalAppCatalog.tsx        <NEW>
```

### Data Flow: Sync Process API Execution

**Key design decision**: Runtime generates the `executionId` (UUIDv7) and passes it with the start-execution request. This allows runtime to subscribe to the completion channel BEFORE starting the workflow, eliminating the race condition where a workflow could complete before the subscription is established.

**Internal API contract change**: The workflow-engine execute endpoint must be extended to accept an optional `executionId` parameter. When provided (by Process API), it uses the provided ID; when absent (internal/Studio calls), it generates one via `crypto.randomUUID()` as today. This is an additive change to the internal API contract — existing callers are unaffected.

```
External System                  Runtime (3112)                Workflow Engine (9080)         Redis        MongoDB
     |                               |                               |                        |             |
     | POST /process/:wfId           |                               |                        |             |
     | Authorization: Bearer abl_*   |                               |                        |             |
     |------------------------------>|                               |                        |             |
     |                               | 1. resolveApiKey(hash)        |                        |             |
     |                               |-------------------------------------------------------->| lookup      |
     |                               |<--------------------------------------------------------| ApiKey doc  |
     |                               |                               |                        |             |
     |                               | 2. verify scope:workflow:execute                        |             |
     |                               |    verify projectId in key.projectIds                   |             |
     |                               |                               |                        |             |
     |                               | 3. generate executionId (UUIDv7)                        |             |
     |                               |                               |                        |             |
     |                               | 4. SUBSCRIBE workflow:{tenantId}:execution:{execId}:status
     |                               |----------------------------------------------->|        |             |
     |                               |                               |               |        |             |
     |                               | 5. POST /execute (proxy)      |               |        |             |
     |                               |    { executionId, input,       |               |        |             |
     |                               |      triggerMetadata }        |               |        |             |
     |                               |------------------------------>|               |        |             |
     |                               |                               | 6. persist execution   |             |
     |                               |                               |    (uses provided      |             |
     |                               |                               |     executionId)       |             |
     |                               |                               |------------------------------>| save  |
     |                               |                               |               |        |             |
     |                               |                               | 7. startWorkflow()     |             |
     |                               |                               |---> Restate   |        |             |
     |                               |                               |               |        |             |
     |                               |                               | 8. [steps execute...]  |             |
     |                               |                               |               |        |             |
     |                               |                               | 9. PUBLISH completion  |             |
     |                               |                               |-------------->|        |             |
     |                               |                               |               |        |             |
     |                               | 10. receive completion event  |               |        |             |
     |                               |    (notification only, no     |               |        |             |
     |                               |     result payload)           |               |        |             |
     |                               |<----------------------------------------------|        |             |
     |                               |                               |                        |             |
     |                               | 11. UNSUBSCRIBE               |                        |             |
     |                               |----------------------------------------------->|        |             |
     |                               |                               |                        |             |
     |                               | 12. GET execution result      |                        |             |
     |                               |    { _id: execId, tenantId }  |                        |             |
     |                               |-------------------------------------------------------->| fetch       |
     |                               |<--------------------------------------------------------| result doc  |
     |                               |                               |                        |             |
     | 13. HTTP 200                  |                               |                        |             |
     | { status: "completed",        |                               |                        |             |
     |   result: { ... } }           |                               |                        |             |
     |<------------------------------|                               |                        |             |
```

### Data Flow: Async with Callback Push

```
External System            Runtime (3112)          Workflow Engine (9080)     BullMQ              Callback URL
     |                          |                          |                    |                     |
     | POST /process/:wfId      |                          |                    |                     |
     | { isAsync: true,          |                          |                    |                     |
     |   callbackUrl: "..." }   |                          |                    |                     |
     |------------------------->|                          |                    |                     |
     |                          | 1. auth + scope check    |                    |                     |
     |                          | 2. POST /execute (proxy) |                    |                     |
     |                          |------------------------->|                    |                     |
     |                          |                          | 3. persist execution (callbackUrl in triggerMetadata)
     | 4. HTTP 202               |                          |                    |                     |
     | { traceId, status }      |                          |                    |                     |
     |<-------------------------|                          |                    |                     |
     |                          |                          | 5. [steps execute]  |                     |
     |                          |                          |                    |                     |
     |                          |                          | 6. on completion, enqueue callback job  |
     |                          |                          |------------------->|                     |
     |                          |                          |                    |                     |
     |                          |                          | 7. callback-delivery-worker picks up    |
     |                          |                          |                    | POST result         |
     |                          |                          |                    | + HMAC headers      |
     |                          |                          |                    |-------------------->|
     |                          |                          |                    |                     |
     |                          |                          | 8. update callbackStatus in execution   |
```

### Data Flow: Time-Based Trigger

```
Studio UI          Runtime (3112)          Workflow Engine (9080)     BullMQ         MongoDB
   |                    |                          |                    |               |
   | POST /triggers     |                          |                    |               |
   | { preset: "daily", |                          |                    |               |
   |   time: "09:00",   |                          |                    |               |
   |   timezone: "..." }|                          |                    |               |
   |    (JWT auth)      |                          |                    |               |
   |------------------->| proxy                    |                    |               |
   |                    |------------------------->|                    |               |
   |                    |                          | 1. preset-resolver()               |
   |                    |                          |    "daily" + "09:00" → "0 9 * * *" |
   |                    |                          |                    |               |
   |                    |                          | 2. save TriggerRegistration        |
   |                    |                          |------------------------------>| save  |
   |                    |                          |                    |               |
   |                    |                          | 3. scheduleCron(cron, { tz })       |
   |                    |                          |------------------->|               |
   |                    |                          |                    | repeat job    |
   |                    |                          |                    | with tz       |
   |                    |                          |                    |               |
   |                    |                          |    ... at 09:00 in timezone ...    |
   |                    |                          |                    |               |
   |                    |                          | 4. processJob()    |               |
   |                    |                          |<-------------------|               |
   |                    |                          |                    |               |
   |                    |                          | 5. startWorkflow() |               |
   |                    |                          |---> Restate        |               |
```

---

## 4. The 12 Architectural Concerns

### Structural Concerns

| #   | Concern                 | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| --- | ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | **Tenant Isolation**    | Process API resolves `tenantId` from the API key via `resolveApiKey()` in unified auth middleware. All downstream queries include `tenantId`. Cross-tenant access returns 404 (not 403). TriggerRegistration and WorkflowExecution both use `tenantIsolationPlugin`. Status polling queries by `{ _id: traceId, workflowId }` ensuring the caller can only access executions for their scoped workflow.                                                                                                                                 |
| 2   | **Data Access Pattern** | No new repository layer. Process API reads `Workflow` model (via proxy to workflow-engine) to verify active status + projectId. Status polling queries by `{ _id: traceId, workflowId, tenantId }` where `tenantId` is resolved from the API key via unified auth (O(1) lookup on primary key). Trigger registration uses existing `TriggerRegistration` model with new optional `config` subfields. No caching layer — queries are simple primary-key lookups.                                                                         |
| 3   | **API Contract**        | **Process API**: `POST /process/:workflowId` accepts `{ input, isAsync?, callbackUrl? }`, returns `{ status, result?, traceId?, error? }`. `GET /process/:workflowId/status?traceId=` returns same shape. Error envelope: `{ error: { code: string, message: string } }`. **Trigger CRUD**: Existing contract unchanged; new `config` subfields are additive. No versioning needed — all changes backward-compatible.                                                                                                                   |
| 4   | **Security Surface**    | API key auth via existing `resolveApiKey()` (SHA-256 hash lookup). Scope check: `workflow:execute` required. Project check: `workflow.projectId` must be in `key.projectIds[]`. Input validation: Zod schema on request body; optional workflow input schema validation (FR-20). Callback URL: HTTPS enforced in production; SSRF mitigation rejects internal/private IP ranges (RFC 1918, localhost, link-local, cloud metadata 169.254.169.254). HMAC-SHA256 on outbound callbacks. Raw API key shown once at creation, never stored. |

### Behavioral Concerns

| #   | Concern           | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --- | ----------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 5   | **Error Model**   | **401**: Invalid/expired/revoked API key. **403**: Missing `workflow:execute` scope. **404**: Workflow not found, not active, or projectId not in key's projectIds (also cross-tenant). **400**: Invalid input, bad cron, invalid timezone, dayOfMonth > 28. **500**: Unexpected Restate/Redis failure (structured `{ error: { code, message } }`). Sync execution workflow failure returns 200 with `status: "failed"`.                                                                                                                                                                                    |
| 6   | **Failure Modes** | **Redis down**: Sync mode degrades to async (returns 202 with traceId; GAP-011). Workflow execution unaffected. **Workflow-engine down**: Proxy returns 502. **Restate down**: Start-execution fails, returns 503. **MongoDB unavailable at result fetch**: After Pub/Sub notification, runtime fetches result from MongoDB — if unavailable, returns 202 with traceId (degrade to async, caller can poll later). **Callback URL unreachable**: 3 retries with exponential backoff (1s, 4s, 16s); status tracked in `triggerMetadata.callbackStatus`. **BullMQ stalled**: Existing stall detection + retry. |
| 7   | **Idempotency**   | Process API is NOT idempotent — each call creates a new execution (correct for workflows). Status polling is naturally idempotent (read-only). One-shot triggers use `jobId: registrationId` for BullMQ dedup. Callback delivery retries are idempotent from the consumer's perspective (same payload, HMAC changes per attempt due to timestamp).                                                                                                                                                                                                                                                          |
| 8   | **Observability** | Process API calls emit `TraceEvent` with `type: 'workflow_api_invocation'` including `apiKeyId`, `isAsync`, execution duration. Callback deliveries log attempts/status. All route handlers use `createLogger('process-api')`. Existing workflow execution events via Redis Pub/Sub provide step-level visibility. Metrics: API key usage count, sync/async ratio, callback delivery rate.                                                                                                                                                                                                                  |

### Operational Concerns

| #   | Concern                | Design Decision                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| --- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 9   | **Performance Budget** | Sync execution p99 < 5s (workflow-dependent). Async response < 100ms (immediate 202). Status polling p99 < 200ms (primary key lookup). Redis Pub/Sub subscription overhead: ~1ms per subscribe/unsubscribe. Payload size: input validated by Zod (max 1MB default). Callback payload: execution result (same as sync response).                                                                                                                                                                                                                                                            |
| 10  | **Migration Path**     | No data migration needed. All changes are additive: (1) `connectorName`/`connectionId` become optional (MongoDB schema-less, no migration). (2) New `config` subfields added to `TriggerRegistration` (no existing data affected). (3) New `triggerMetadata` subfields in `WorkflowExecution`. (4) `workflow:execute` added to available scopes list (no existing keys affected).                                                                                                                                                                                                          |
| 11  | **Rollback Plan**      | Remove Process API route mount from `runtime/src/server.ts` and redeploy. All changes are additive — no existing routes/models/behaviors are modified. The `workflow-callbacks` BullMQ queue is new and independent; stopping the worker has no impact on the existing `workflow-triggers` queue. On rollback, orphaned jobs in the `workflow-callbacks` queue are harmless — they expire via BullMQ TTL or can be drained manually via `queue.obliterate()`. Schema changes (optional fields) are backward-compatible and don't need reverting.                                           |
| 12  | **Test Strategy**      | **E2E** (13 scenarios): Real Express on random ports, real MongoDB, real Redis, full auth middleware chain. Restate mocked via DI (external dependency). Covers: sync/async execution, auth enforcement, project/tenant isolation, callback push, one-shot lifecycle, auto-key creation. **Integration** (10): Service boundary tests — preset resolver, callback delivery, BullMQ scheduling, scope enforcement. **Unit** (7): Pure functions — preset-to-cron, cron validation, timezone validation, HMAC signing. See full test spec: `docs/testing/sub-features/workflow-triggers.md`. |

---

## 5. Data Model

### Modified Collections

**TriggerRegistration** (`trigger_registrations`):

Strategy enum mapping for new trigger types:

- **Webhook (API) trigger**: `strategy: 'webhook'`, `connectorName: undefined`, `connectionId: undefined`
- **Time-based trigger (cron/daily/weekly/monthly)**: `strategy: 'cron'`, `connectorName: undefined`, `connectionId: undefined`
- **Time-based trigger (once)**: `strategy: 'cron'` with BullMQ `delay` (not repeatable), auto-pauses after firing

```typescript
// Schema changes
{
  connectorName: { type: String, required: false }, // was: required: true
  connectionId: { type: String, required: false },  // was: required: true
  config: {
    // NEW subfields (all optional, type-dependent)
    apiKeyId: String,           // webhook triggers: links to auto-created ApiKey
    preset: String,             // time-based: 'daily'|'weekly'|'monthly'|'once'|'cron'
    timezone: String,           // time-based: IANA timezone
    time: String,               // time-based: HH:MM
    dayOfWeek: Number,          // weekly: 0-6
    dayOfMonth: Number,         // monthly: 1-28
    datetime: String,           // once: ISO 8601
    // ... existing config fields preserved
  }
}
```

**WorkflowExecution** (`workflow_executions`):

```typescript
// Extended triggerMetadata subdocument
{
  triggerMetadata: {
    // ... existing fields
    apiKeyId: String,           // NEW: API key that triggered this execution
    callbackUrl: String,        // NEW: where to push async result
    callbackStatus: String,     // NEW: 'pending'|'delivered'|'failed'
    callbackAttempts: Number,   // NEW: delivery attempt count
  }
}
```

**callbackUrl wiring**: When the Process API receives `{ isAsync: true, callbackUrl: "https://..." }`, it passes `callbackUrl` in the `triggerMetadata` object to the workflow-engine's execute endpoint. Workflow-engine persists it in `WorkflowExecution.triggerMetadata.callbackUrl` at creation time. On workflow completion, `workflow-handler.ts` checks for `callbackUrl` in the execution's triggerMetadata and enqueues a BullMQ job on the `workflow-callbacks` queue if present.

### Unchanged Collections

**ApiKey** (`api_keys`): No schema changes. The `workflow:execute` scope is a new string value in the existing `scopes[]` array — no model change needed, only a UI/validation update to list it as an available scope.

### New Indexes

None required. Existing indexes are sufficient:

- `{ keyHash: 1 }` (unique) — API key lookup by hash (O(1))
- `{ _id: 1 }` — WorkflowExecution lookup by traceId (O(1))
- `{ tenantId: 1, workflowId: 1, status: 1 }` — Trigger registration queries

---

## 6. API Design

### New Endpoints

| Method | Path                                                  | Auth                                      | Purpose                           | Response                                                |
| ------ | ----------------------------------------------------- | ----------------------------------------- | --------------------------------- | ------------------------------------------------------- |
| POST   | `/api/v1/process/:workflowId`                         | `Bearer abl_*` + `workflow:execute` scope | Execute workflow (sync or async)  | 200: `{ status, result }` or 202: `{ traceId, status }` |
| GET    | `/api/v1/process/:workflowId/status?traceId=:traceId` | `Bearer abl_*` + `workflow:execute` scope | Poll execution status             | 200: `{ status, result?, error? }`                      |
| GET    | `/api/v1/connectors/triggers/catalog`                 | JWT                                       | List external app trigger catalog | 200: `{ categories: [{ name, connectors: [...] }] }`    |

### Request/Response Schemas

**POST /api/v1/process/:workflowId**

```typescript
// Request
{
  input: Record<string, unknown>;      // required
  isAsync?: boolean;                    // default: false
  callbackUrl?: string;                 // optional, HTTPS in production
}

// Sync Response (HTTP 200) — workflow completed within timeout
{
  status: 'completed' | 'failed';
  result?: Record<string, unknown>;    // present when completed
  error?: { code: string; message: string }; // present when failed
  traceId: string;                     // always present for reference
}

// Async Response (HTTP 202) — isAsync:true or sync timeout exceeded
{
  traceId: string;
  status: 'running';
}
```

**GET /api/v1/process/:workflowId/status?traceId=:traceId**

```typescript
// Response (HTTP 200)
{
  status: 'running' | 'completed' | 'failed' | 'cancelled';
  result?: Record<string, unknown>;    // present when completed
  error?: { code: string; message: string }; // present when failed
}
```

### Error Responses

| HTTP | Code                   | Condition                                                                                           |
| ---- | ---------------------- | --------------------------------------------------------------------------------------------------- |
| 400  | `INVALID_INPUT`        | Request body validation failed                                                                      |
| 400  | `INVALID_TRACE_ID`     | Missing or malformed `traceId` query parameter (status endpoint) — validated as `z.string().min(1)` |
| 400  | `SCHEMA_MISMATCH`      | Input doesn't match workflow's input schema                                                         |
| 400  | `INVALID_TIMEZONE`     | IANA timezone validation failed                                                                     |
| 400  | `INVALID_CRON`         | Cron expression validation failed                                                                   |
| 401  | `UNAUTHORIZED`         | Missing/invalid/expired/revoked API key                                                             |
| 403  | `FORBIDDEN`            | API key lacks `workflow:execute` scope                                                              |
| 404  | `NOT_FOUND`            | Workflow not found, not active, or projectId not in key scope                                       |
| 502  | `UPSTREAM_UNAVAILABLE` | Workflow engine unreachable                                                                         |
| 503  | `SERVICE_UNAVAILABLE`  | Restate unavailable (workflow-engine cannot start execution)                                        |

### Modified Endpoints

**Trigger registration** (`POST /api/v1/projects/:projectId/triggers`): Extended to accept new `config` subfields for time-based presets. Backward-compatible — existing callers unaffected. New validation: timezone (IANA), dayOfMonth (1-28), cron expression (5-6 fields).

---

## 7. Cross-Cutting Concerns

### Audit Logging

- Every Process API call creates a `WorkflowExecution` with `triggerType: 'api'` and `triggerMetadata.apiKeyId`
- API key creation (auto or manual) logged via existing Settings API audit trail
- Callback delivery attempts logged with status and attempt count
- Trigger registration/pause/resume/delete actions logged via existing trigger routes

### Rate Limiting

- Process API uses existing `tenantRateLimit('request')` middleware (tenant-level)
- No per-API-key rate limiting in this phase (GAP-001)
- BullMQ concurrency of 10 for trigger scheduling (existing)

### Caching

- No caching layer introduced. All queries are either primary-key lookups (O(1)) or scope-limited (tenantId + projectId). Status polling by `_id` is inherently fast.
- API key resolution already uses short-lived in-memory cache in unified auth (existing behavior)

### Encryption

- API keys: SHA-256 hashed at rest (existing). Raw key visible only at creation response.
- Callback payloads: HMAC-SHA256 signed headers for integrity verification
- All service communication over internal network (runtime ↔ workflow-engine)
- Callback URLs: HTTPS enforced in production

---

## 8. Dependencies

### Upstream (this feature depends on)

| Dependency                    | Type     | Risk   | Notes                                                             |
| ----------------------------- | -------- | ------ | ----------------------------------------------------------------- |
| Platform API Key system       | existing | Low    | Fully wired: `ApiKey` model, `resolveApiKey()`, unified auth      |
| Redis Pub/Sub                 | existing | Medium | Sync execution depends on completion events from workflow-handler |
| BullMQ + Redis                | existing | Low    | Trigger scheduling and callback delivery queues                   |
| Restate (via workflow-engine) | existing | Low    | Workflow execution — existing integration                         |
| Webhook signature utils       | existing | Low    | HMAC signing for callbacks — well-tested utility                  |
| TriggerRegistration model     | existing | Low    | Schema extension (optional fields) — backward-compatible          |
| WorkflowExecution model       | existing | Low    | triggerMetadata extension — additive only                         |

### Downstream (depends on this feature)

| Consumer                    | Impact                                                      |
| --------------------------- | ----------------------------------------------------------- |
| External API consumers      | New capability — Process API                                |
| Studio UI                   | New trigger UX components (Quick Start, presets, catalog)   |
| Future: A2A agents          | Can invoke workflows via Process API                        |
| Future: Per-key rate limits | GAP-001 — builds on `workflow:execute` scope infrastructure |

---

## 9. Open Questions & Decisions Needed

1. **Redis Pub/Sub subscriber connection pooling**: Should runtime maintain a dedicated Redis connection for Pub/Sub subscribers, or create one per sync request? Dedicated connection is more efficient but requires lifecycle management. Per-request is simpler but may hit Redis connection limits under load.

2. **Sync execution — subscribe failure fallback**: The design generates the executionId at runtime, subscribes BEFORE starting the workflow (eliminating the race condition). If the Redis subscribe fails, should we fall back to database polling or immediately return 202 (async)?

3. **Callback webhook secret source**: The feature spec references "the workflow's webhook secret" for HMAC signing. Where is this secret stored? Options: per-workflow field in Workflow model, derived from tenant secret, or from the API key's associated data. This needs resolution before implementation.

4. **One-shot trigger re-scheduling**: Should a paused one-shot trigger support re-scheduling via the resume endpoint with a new `datetime`? Current design auto-pauses after firing; resume without a new datetime would be a no-op.

5. **Process API idempotency keys**: Should the Process API support optional request deduplication via an `Idempotency-Key` header for critical webhook-triggered workflows where callers may retry on timeout? This would prevent duplicate executions but adds complexity (key storage, TTL, conflict detection).

---

## 10. References

- Feature spec: [`docs/features/sub-features/workflow-triggers.md`](../features/sub-features/workflow-triggers.md)
- Test spec: [`docs/testing/sub-features/workflow-triggers.md`](../testing/sub-features/workflow-triggers.md)
- Parent HLD: [`docs/specs/workflows.hld.md`](workflows.hld.md)
- Parent LLD: [`docs/plans/workflows.lld.md`](../plans/workflows.lld.md)
- Redis Pub/Sub publisher: `apps/workflow-engine/src/pubsub/redis-publisher.ts`
- Workflow completion event: `apps/workflow-engine/src/handlers/workflow-handler.ts` (lines 811-813)
- Existing proxy pattern: `apps/runtime/src/middleware/workflow-engine-proxy.ts`
- API key resolution: `apps/runtime/src/repos/auth-repo.ts`
- Trigger scheduler: `apps/workflow-engine/src/services/trigger-scheduler.ts`
- BullMQ helpers: `packages/redis/src/bullmq.ts`
