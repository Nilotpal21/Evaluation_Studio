# Feature: Workflow Triggers

**Doc Type**: SUB-FEATURE
**Parent Feature**: [Workflows & Human Tasks](../workflows.md)
**Status**: PLANNED
**Feature Area(s)**: `integrations`, `agent lifecycle`, `project lifecycle`
**Package(s)**: `apps/workflow-engine`, `apps/runtime`, `packages/database`, `packages/connectors`, `packages/shared-kernel`, `apps/studio`
**Owner(s)**: Runtime Team
**Testing Guide**: [../../testing/sub-features/workflow-triggers.md](../../testing/sub-features/workflow-triggers.md)
**Last Updated**: 2026-04-19

---

## 1. Introduction / Overview

### Problem Statement

Workflows today can only be started manually (via Studio UI or internal project-scoped API with JWT auth). There is no public-facing API that external systems can call to invoke a workflow, no user-friendly scheduling UI for time-based triggers, and no catalog of external app triggers. Specifically:

1. **No public process API**: External consumers cannot call a workflow endpoint with a simple API key. The existing execution route (`/api/v1/projects/:projectId/workflows/:workflowId/executions`) requires JWT auth and knowledge of internal project/workflow IDs.
2. **No sync/async execution modes**: All executions are fire-and-forget. There is no way to get a result inline (sync) or poll for completion (async).
3. **No timezone support for cron triggers**: The existing `TriggerScheduler` passes cron expressions to BullMQ without timezone handling. All schedules run in server-local time.
4. **No friendly schedule presets**: Users must write raw cron expressions — there are no daily/weekly/monthly/once presets in the UI.
5. **No async result push**: When a workflow completes asynchronously, there is no mechanism to push the result to a user-configured callback URL.
6. **No external app trigger catalog**: While the connectors package has Nango/Activepieces adapters, there is no user-facing catalog of available external app triggers (Gmail, Jira, Slack, etc.).

### Goal Statement

Provide three trigger categories — **Webhook (API)**, **Time-based**, and **External Apps** — that allow workflows to be invoked from any external system via API, on a schedule, or in response to external app events. The webhook trigger must support synchronous (inline result), asynchronous (poll or push) execution modes with API key authentication.

### Summary

This sub-feature extends the existing trigger infrastructure (TriggerRegistration model, TriggerEngine, TriggerScheduler, connector trigger engine) to add:

- A **public Process API** (`/api/v1/process/:workflowId`) authenticated via workflow API keys (`wfk_*` prefix), supporting sync and async execution modes with polling and webhook push for async results.
- **Time-based scheduling** with user-friendly presets (daily, weekly, monthly, once, custom cron) and IANA timezone support, built on BullMQ's native `tz` option.
- An **External App trigger catalog** listing supported connectors (Gmail, Jira, Slack, GitHub, etc.) with references to the existing Nango/Activepieces integration layer. Implementation of external app triggers is out of scope for this PRD.

---

## 2. Scope

### Goals

- G1: Expose a public-facing Process API for workflow invocation with API key auth
- G2: Support synchronous execution (returns result inline) with configurable timeout
- G3: Support asynchronous execution (returns traceId) with poll and push notification
- G4: Provide user-friendly schedule presets (daily, weekly, monthly, once, custom cron) with timezone
- G5: Catalog external app triggers (Gmail, Jira, Slack, GitHub, etc.) for future implementation
- G6: Extend existing trigger infrastructure — no greenfield rewrite

### Non-Goals (Out of Scope)

- NG1: Implementation of external app triggers (Gmail, Jira, etc.) — catalog only
- NG2: Visual workflow builder/designer UI (covered in parent feature roadmap)
- NG3: Multi-tenant trigger sharing or marketplace
- NG4: Inbound webhook signature verification on the Process API (API key auth is sufficient for inbound requests; HMAC-SHA256 signing applies only to outbound callback deliveries per FR-09)
- NG5: Rate limiting per API key (will use existing tenant-level rate limiting; per-key limits are a follow-up)
- NG6: Workflow versioning integration with triggers. **Addressed by [Workflow Webhook Versioning](./workflow-webhook-versioning.md)** (ALPHA 2026-04-18) — short URL `/api/v1/workflows/:id/execute`, `?version=<semver>` pinning, deterministic semver-desc default resolution across runtime and engine, and `workflow_version` DSL property for agent-tool bindings. Blue-green trigger routing (active/candidate split) remains future work.

---

## 3. User Stories

1. **US-1**: As an **external developer**, I want to invoke a workflow via a simple REST API call with an API key so that I can integrate workflow execution into my application without needing JWT auth or internal project IDs.

2. **US-2**: As an **external developer**, I want to call the Process API synchronously and get the workflow result inline so that I can use it in request-response flows (e.g., form validation, data enrichment).

3. **US-3**: As an **external developer**, I want to call the Process API asynchronously and receive a traceId so that I can poll for the result or configure a webhook to receive it when ready — for long-running workflows.

4. **US-4**: As a **Studio user**, I want to configure a workflow to run daily at 9 AM in my timezone without writing a cron expression so that non-technical users can set up scheduled workflows.

5. **US-5**: As a **Studio user**, I want to schedule a one-time workflow execution at a specific date and time so that I can trigger a workflow for a specific event (e.g., end-of-quarter report).

6. **US-6**: As an **external developer**, I want to poll a status endpoint with my traceId to check if my async workflow has completed and retrieve the result.

7. **US-7**: As a **Studio user**, I want to configure a callback webhook URL for async workflow completions so that my system gets notified automatically when a workflow finishes.

8. **US-8**: As a **Studio user**, I want to browse a catalog of available external app triggers (Gmail, Jira, Slack, etc.) so that I know what integrations are planned and can request prioritization.

---

## 4. Functional Requirements

| ID    | Requirement                                                                                                                                                                                                                                                                                 | Priority    | Status   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------- | -------- | -------------------------------------------------------------------------------------------- | --- | ------- |
| FR-01 | The system must expose `POST /api/v1/process/:workflowId` on the Runtime service (port 3112), authenticated via `x-api-key` header using the existing `WorkflowApiKey` model (SHA-256 hash lookup).                                                                                         | P0          | PLANNED  |
| FR-02 | The process endpoint must accept `{ input: Record<string, unknown> }` as the request body and pass it as `triggerPayload` to the workflow execution.                                                                                                                                        | P0          | PLANNED  |
| FR-03 | When `isAsync` is absent or `false`, the system must execute the workflow synchronously, wait for completion (up to 30 seconds), and return the full execution result in the response body.                                                                                                 | P0          | PLANNED  |
| FR-04 | When `isAsync` is `true`, the system must start the workflow, return `{ traceId: string, status: 'running' }` immediately (HTTP 202), and not block.                                                                                                                                        | P0          | PLANNED  |
| FR-05 | If a sync execution exceeds the 30-second timeout, the system must return `{ traceId: string, status: 'running' }` (HTTP 202) so the caller can poll — effectively auto-promoting to async.                                                                                                 | P0          | PLANNED  |
| FR-06 | The system must expose `GET /api/v1/process/:workflowId/status?traceId=:traceId` authenticated via `x-api-key`, returning execution status and result (if completed).                                                                                                                       | P0          | PLANNED  |
| FR-07 | The status endpoint must return `{ status: 'running'                                                                                                                                                                                                                                        | 'completed' | 'failed' | 'cancelled', result?: Record<string, unknown>, error?: { code: string, message: string } }`. | P0  | PLANNED |
| FR-08 | The system must allow configuring a `callbackUrl` in the async request body: `{ input: {}, isAsync: true, callbackUrl: "https://..." }`. On workflow completion/failure, the system must POST the result to this URL.                                                                       | P1          | PLANNED  |
| FR-09 | Callback webhook delivery must include HMAC-SHA256 signature headers using the workflow's webhook secret (via existing `webhook-signature.ts` utilities), retry up to 3 times with exponential backoff.                                                                                     | P1          | PLANNED  |
| FR-10 | The system must support time-based trigger registration with friendly presets: `daily`, `weekly`, `monthly`, `once`, `cron`. Each preset maps to a cron expression internally.                                                                                                              | P0          | PLANNED  |
| FR-11 | Time-based trigger presets must accept a `timezone` field (IANA timezone string, e.g., `America/New_York`) and pass it to BullMQ's native `tz` option for repeatable jobs.                                                                                                                  | P0          | PLANNED  |
| FR-12 | Daily preset: configurable `time` (HH:MM, default `09:00`). Weekly preset: configurable `dayOfWeek` (0-6, default 1/Monday) + `time`. Monthly preset: configurable `dayOfMonth` (1-28, default 1) + `time`.                                                                                 | P0          | PLANNED  |
| FR-13 | The `once` preset must schedule a one-time execution at a specific `datetime` (ISO 8601 with timezone) using `strategy: 'cron'` with a BullMQ `delay` instead of a repeatable pattern. After firing, the trigger must auto-transition to `status: 'paused'` (not deleted, for audit trail). | P0          | PLANNED  |
| FR-14 | The `cron` preset must accept a raw cron expression (5-6 fields) and validate it before scheduling.                                                                                                                                                                                         | P0          | PLANNED  |
| FR-15 | The system must store `timezone` and `preset` metadata in the `TriggerRegistration.config` field alongside the resolved `cronExpression`.                                                                                                                                                   | P0          | PLANNED  |
| FR-16 | The system must provide a static catalog endpoint `GET /api/v1/connectors/triggers/catalog` that lists available external app triggers grouped by category (communication, project management, development, CRM, etc.).                                                                     | P2          | PLANNED  |
| FR-17 | The process API must record executions with `triggerType: 'api'` in the `WorkflowExecution` model, including the API key ID in `triggerMetadata` for audit.                                                                                                                                 | P0          | PLANNED  |
| FR-18 | The system must enforce that the workflow is in `active` status before accepting process API calls. Draft or archived workflows must return HTTP 404.                                                                                                                                       | P0          | PLANNED  |
| FR-19 | The Runtime service (port 3112) must expose workflow API key management endpoints: `POST /api/v1/projects/:projectId/workflows/:workflowId/api-keys` (create), `GET` (list), `DELETE /:keyId` (revoke), authenticated via JWT.                                                              | P0          | PLANNED  |
| FR-20 | The process API must validate `input` against the workflow's input schema (if defined in `workflow.definition.schemas.input`) and return HTTP 400 with validation errors on mismatch.                                                                                                       | P1          | PLANNED  |

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                                          |
| -------------------------- | ------------ | -------------------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Triggers are project-scoped                                    |
| Agent lifecycle            | SECONDARY    | Workflows can invoke agents; triggers start those workflows    |
| Customer experience        | PRIMARY      | External developers consume the Process API directly           |
| Integrations / channels    | PRIMARY      | Webhook API is a new integration surface; external app catalog |
| Observability / tracing    | SECONDARY    | Executions are tracked; API key usage logged                   |
| Governance / controls      | SECONDARY    | API key management, rate limiting                              |
| Enterprise / compliance    | SECONDARY    | Audit trail for API-triggered executions                       |
| Admin / operator workflows | SECONDARY    | Schedule management in Studio                                  |

### Related Feature Integration Matrix

| Related Feature                                          | Relationship Type | Why It Matters                                                  | Key Touchpoints                                              | Current State |
| -------------------------------------------------------- | ----------------- | --------------------------------------------------------------- | ------------------------------------------------------------ | ------------- |
| [Workflows & Human Tasks](../workflows.md)               | extends           | This is a sub-feature of workflows                              | WorkflowExecution, TriggerRegistration, Restate execution    | ALPHA         |
| [Connectors](../connectors.md)                           | depends on        | External app triggers use connector infrastructure              | ConnectorTriggerEngine, Nango/Activepieces adapters          | BETA          |
| [Webhook System](../webhook-system.md)                   | shares data with  | Callback push reuses webhook signature utilities                | `webhook-signature.ts`, WebhookDelivery tracking pattern     | TBD           |
| [Rate Limiting](../rate-limiting.md)                     | configured by     | Process API uses tenant-level rate limiting                     | `tenantRateLimit('request')` middleware                      | TBD           |
| [Deployments & Versioning](../deployments-versioning.md) | depends on        | Triggers can be pinned to workflow versions via deployment      | `Deployment.workflowVersionManifest`, environment resolution | TBD           |
| [Auth Profiles](../auth-profiles.md)                     | depends on        | Connector triggers may need OAuth credentials via auth profiles | `authProfileId` on TriggerRegistration                       | STABLE        |

---

## 6. Design Considerations

### Process API UX

The Process API is designed to mirror familiar patterns from automation platforms:

```bash
# Sync execution
curl -X POST https://platform.example.com/api/v1/process/{workflowId} \
  -H 'x-api-key: wfk_a1b2c3d4...' \
  -H 'Content-Type: application/json' \
  -d '{"input": {"orderId": "ORD-123"}}'

# Response (sync, <30s):
# { "status": "completed", "result": { "approved": true, "total": 150.00 } }

# Async execution
curl -X POST https://platform.example.com/api/v1/process/{workflowId} \
  -H 'x-api-key: wfk_a1b2c3d4...' \
  -H 'Content-Type: application/json' \
  -d '{"input": {"orderId": "ORD-123"}, "isAsync": true}'

# Response (HTTP 202):
# { "traceId": "exec_abc123", "status": "running" }

# Async with callback
curl -X POST https://platform.example.com/api/v1/process/{workflowId} \
  -H 'x-api-key: wfk_a1b2c3d4...' \
  -H 'Content-Type: application/json' \
  -d '{"input": {}, "isAsync": true, "callbackUrl": "https://myapp.com/webhook"}'

# Poll status
curl https://platform.example.com/api/v1/process/{workflowId}/status?traceId=exec_abc123 \
  -H 'x-api-key: wfk_a1b2c3d4...'

# Response:
# { "status": "completed", "result": { ... } }
```

### Schedule Preset UX (Studio)

The Studio trigger configuration should present friendly options:

| Preset  | User Sees                | Generated Cron       | Example                       |
| ------- | ------------------------ | -------------------- | ----------------------------- |
| Daily   | "Every day at [HH:MM]"   | `0 9 * * *`          | Every day at 9:00 AM          |
| Weekly  | "Every [day] at [HH:MM]" | `0 9 * * 1`          | Every Monday at 9:00 AM       |
| Monthly | "On day [N] at [HH:MM]"  | `0 9 1 * *`          | 1st of every month at 9:00 AM |
| Once    | "On [date] at [HH:MM]"   | N/A (BullMQ `delay`) | March 31, 2026 at 2:00 PM     |
| Cron    | "Custom: [expression]"   | User-provided        | `*/15 * * * *` (every 15 min) |

### External App Trigger Catalog (Phase 1 — Display Only)

| Category           | Connectors                      | Status  |
| ------------------ | ------------------------------- | ------- |
| Communication      | Gmail, Slack, Microsoft Teams   | PLANNED |
| Project Management | Jira, Asana, Linear, Trello     | PLANNED |
| Development        | GitHub, GitLab, Bitbucket       | PLANNED |
| CRM                | Salesforce, HubSpot             | PLANNED |
| Storage            | Google Drive, Dropbox, OneDrive | PLANNED |
| Productivity       | Google Sheets, Notion, Airtable | PLANNED |

---

## 7. Technical Considerations

### Sync Execution via Restate

Sync execution requires waiting for Restate workflow completion. The approach:

1. Start Restate workflow via `RestateWorkflowClient.startWorkflow()` — returns immediately.
2. Subscribe to Redis Pub/Sub channel `workflow:{executionId}` for completion events.
3. If completed within 30s, return result inline.
4. If timeout, return `{ traceId, status: 'running' }` (HTTP 202).

This avoids polling the database and uses the existing Redis Pub/Sub infrastructure (FR-21 from parent feature).

### Process API Route Location

The process API routes live in `apps/runtime/` (port 3112) because:

- Runtime is the public-facing service with existing API key resolution in `createUnifiedAuthMiddleware`.
- The route internally proxies to workflow-engine (port 9080) for execution, similar to the existing `workflow-engine-proxy.ts` pattern.
- API key validation happens at the runtime layer; execution happens at the workflow-engine layer.

### TraceId Mapping

The public-facing `traceId` returned by the Process API maps to `WorkflowExecution._id` internally. This is the UUIDv7 primary key of the execution record. The `restateWorkflowId` (Restate's internal correlation ID) is not exposed to API consumers. The status polling endpoint queries by `{ _id: traceId, workflowId }` to ensure the caller can only poll executions for the workflow their API key is scoped to.

### BullMQ Timezone Support

BullMQ repeatable jobs natively support `tz` (IANA timezone string). The `TriggerScheduler.scheduleCron()` method needs only one change: pass `repeat: { pattern: cronExpression, tz: timezone }` instead of `repeat: { pattern: cronExpression }`.

### One-Shot ("Once") Scheduling

BullMQ doesn't support one-shot repeatable jobs. The approach:

1. Calculate delay from now to target datetime.
2. Use `queue.add(jobName, data, { delay: delayMs, jobId: registrationId })`.
3. On job completion, the worker sets `TriggerRegistration.status = 'paused'`.

### Callback Webhook Delivery

Reuse `packages/shared-kernel/src/security/webhook-signature.ts` for HMAC signing. The delivery mechanism:

1. On workflow completion, if the execution has a `callbackUrl` in `triggerMetadata`, enqueue a BullMQ job on a new `workflow-callbacks` queue.
2. Worker POSTs result to `callbackUrl` with signature headers.
3. Retry 3 times with exponential backoff (1s, 4s, 16s).
4. Record delivery status (reuse `WebhookDelivery` model pattern but stored inline in execution metadata for simplicity).

---

## 8. How to Consume

### Studio UI

- **Trigger Tab**: Existing `WorkflowTriggersTab.tsx` extended with schedule preset picker (daily/weekly/monthly/once/cron), timezone selector (IANA dropdown), and external app catalog browser.
- **API Key Management**: New panel in workflow settings to create/list/revoke API keys. Shows the full key only once at creation.
- **Trigger Code Snippets**: When a webhook trigger is enabled, show copy-pasteable curl examples for sync, async, and poll.

### API (Runtime — Public Process API)

| Method | Path                                                  | Auth    | Purpose                          |
| ------ | ----------------------------------------------------- | ------- | -------------------------------- |
| POST   | `/api/v1/process/:workflowId`                         | API Key | Execute workflow (sync or async) |
| GET    | `/api/v1/process/:workflowId/status?traceId=:traceId` | API Key | Poll execution status by traceId |

### API (Runtime — API Key Management)

| Method | Path                                                                | Auth | Purpose        |
| ------ | ------------------------------------------------------------------- | ---- | -------------- |
| POST   | `/api/v1/projects/:projectId/workflows/:workflowId/api-keys`        | JWT  | Create API key |
| GET    | `/api/v1/projects/:projectId/workflows/:workflowId/api-keys`        | JWT  | List API keys  |
| DELETE | `/api/v1/projects/:projectId/workflows/:workflowId/api-keys/:keyId` | JWT  | Revoke API key |

### API (Workflow Engine — Trigger Management, proxied via Runtime)

| Method | Path                                              | Auth | Purpose                    |
| ------ | ------------------------------------------------- | ---- | -------------------------- |
| POST   | `/api/v1/projects/:projectId/triggers`            | JWT  | Register trigger           |
| GET    | `/api/v1/projects/:projectId/triggers`            | JWT  | List triggers              |
| DELETE | `/api/v1/projects/:projectId/triggers/:id`        | JWT  | Delete trigger             |
| POST   | `/api/v1/projects/:projectId/triggers/:id/pause`  | JWT  | Pause trigger              |
| POST   | `/api/v1/projects/:projectId/triggers/:id/resume` | JWT  | Resume trigger             |
| GET    | `/api/v1/connectors/triggers/catalog`             | JWT  | List external app triggers |

### Admin Portal

- Tenant-level view of all active triggers across projects (future admin dashboard).
- API key usage metrics per workflow (future).

### Channel / SDK / Voice / A2A / MCP Integration

The Process API is channel-agnostic. Any system that can make HTTP requests can invoke a workflow. No special channel awareness is needed. A2A agents could use the Process API to invoke workflows on the platform.

---

## 9. Data Model

### Collections / Tables

**Existing — Schema Change Required:**

The `WorkflowApiKey` model exists (`packages/database/src/models/workflow-api-key.model.ts`) but has no routes or middleware wired yet. Both the Process API routes and the API key management routes are new work. Additionally, a `keyHash` index is missing for efficient lookup.

```text
Collection: workflow_api_keys (existing model, needs index addition)
Fields:
  - _id: string (UUIDv7)
  - tenantId: string (required, indexed)
  - projectId: string (required)
  - workflowId: string (required)
  - name: string (required)
  - keyHash: string (SHA-256 hex hash)
  - keyPrefix: string (first 8 chars, e.g., "wfk_a1b2")
  - expiresAt?: Date (TTL index)
  - lastUsedAt?: Date
  - createdBy: string (required)
Indexes:
  - { tenantId: 1, workflowId: 1 }
  - { keyHash: 1 } (unique) ← NEW — required for efficient API key lookup
  - { keyPrefix: 1 }
  - { expiresAt: 1 } (TTL)
```

**Existing — Extended:**

```text
Collection: trigger_registrations (existing, extended)
Schema changes required:
  - connectorName: change from required to optional (currently required: true — time-based triggers have no connector)
  - connectionId: change from required to optional (currently required: true — time-based triggers have no connection)
New fields in config subdocument:
  - config.preset: 'daily' | 'weekly' | 'monthly' | 'once' | 'cron' (for time-based triggers)
  - config.timezone: string (IANA timezone, e.g., 'America/New_York')
  - config.time: string (HH:MM format, for daily/weekly/monthly)
  - config.dayOfWeek: number (0-6, for weekly)
  - config.dayOfMonth: number (1-28, for monthly)
  - config.datetime: string (ISO 8601, for once)
Existing fields used:
  - cronExpression: string (resolved from preset)
  - missedFirePolicy: 'fire_once' | 'fire_all' | 'skip'
```

**Existing — Extended:**

```text
Collection: workflow_executions (existing, extended)
New fields in triggerMetadata subdocument:
  - triggerMetadata.apiKeyId: string (for API-triggered executions)
  - triggerMetadata.callbackUrl: string (for async push)
  - triggerMetadata.callbackStatus: 'pending' | 'delivered' | 'failed'
  - triggerMetadata.callbackAttempts: number
```

### Key Relationships

- `WorkflowApiKey` N:1 `Workflow` (via `workflowId`) — multiple API keys per workflow
- `TriggerRegistration` N:1 `Workflow` (via `workflowId`) — multiple triggers per workflow
- `WorkflowExecution.triggerMetadata.apiKeyId` → `WorkflowApiKey._id` — audit trail
- Process API resolves `workflowId` → looks up `WorkflowApiKey` by `keyHash` → verifies `workflowId` matches → resolves `tenantId`/`projectId` from the key

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                       | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/workflow-engine/src/services/trigger-engine.ts`      | Trigger lifecycle (register/fire/pause). 2026-04-19: `register()` now resolves preset/cronExpression and writes the canonical value to both `config.cronExpression` and the legacy top-level field so UI and `resume()` don't re-run preset resolution; preset-resolution errors are caught and logged (trigger still persists); cron registered without a BullMQ scheduler is persisted with an explicit warn log instead of silently not firing; `resume()` prefers `config.cronExpression` with legacy fallback. |
| `apps/workflow-engine/src/services/trigger-scheduler.ts`   | BullMQ cron/polling scheduling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/connectors/src/triggers/trigger-engine.ts`       | Connector-specific trigger orchestration                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/connectors/src/triggers/cron-scheduler.ts`       | Connector cron scheduling                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/shared-kernel/src/security/webhook-signature.ts` | HMAC signing for callback webhooks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |

### Routes / Handlers

| File                                                     | Purpose                             |
| -------------------------------------------------------- | ----------------------------------- |
| `apps/runtime/src/routes/process-api.ts`                 | **NEW** — Public Process API routes |
| `apps/runtime/src/middleware/workflow-api-key-auth.ts`   | **NEW** — API key auth middleware   |
| `apps/runtime/src/routes/workflow-api-keys.ts`           | **NEW** — API key management routes |
| `apps/runtime/src/middleware/workflow-engine-proxy.ts`   | Existing proxy (trigger routes)     |
| `apps/workflow-engine/src/routes/triggers.ts`            | Existing trigger CRUD routes        |
| `apps/workflow-engine/src/routes/workflow-executions.ts` | Existing execution routes           |

### UI Components

| File                                                                     | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`      | Trigger management UI. 2026-04-19: trigger cards are collapsible (header always shows label + lifecycle actions; body reveals URL / cron / app details on expand); cron display falls back to a human-readable preset summary (`formatCronPreset`) when the server stored only the preset form; Fire Now fails fast with a clear message when the trigger is paused/deleted; initial render shows a `Skeleton` placeholder until the SWR registrations fetch resolves (avoids EmptyState flash); lifecycle actions (Fire/Delete/Pause) use `Button size="sm"` so padding and icon sizes align. |
| `apps/studio/src/components/workflows/triggers/SchedulePresetPicker.tsx` | **NEW** — Friendly schedule preset UI                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `apps/studio/src/components/workflows/triggers/ApiKeyManager.tsx`        | **NEW** — API key create/list/revoke                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx`         | **NEW** — Curl example generator                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `apps/studio/src/components/workflows/triggers/ExternalAppCatalog.tsx`   | **NEW** — External app trigger browser                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

### Jobs / Workers / Background Processes

| File                                                            | Purpose                                   |
| --------------------------------------------------------------- | ----------------------------------------- |
| `apps/workflow-engine/src/services/trigger-scheduler.ts`        | BullMQ worker for cron/polling            |
| `apps/workflow-engine/src/services/callback-delivery-worker.ts` | **NEW** — Async callback webhook delivery |

### Tests

| File                                                                    | Type        | Coverage Focus              |
| ----------------------------------------------------------------------- | ----------- | --------------------------- |
| `apps/runtime/src/__tests__/process-api.test.ts`                        | integration | Process API sync/async/poll |
| `apps/runtime/src/__tests__/process-api.e2e.test.ts`                    | e2e         | Full HTTP flow with auth    |
| `apps/workflow-engine/src/__tests__/trigger-engine.test.ts`             | unit        | Trigger lifecycle (exists)  |
| `apps/workflow-engine/src/__tests__/trigger-scheduler-timezone.test.ts` | unit        | Timezone/preset resolution  |
| `apps/workflow-engine/src/__tests__/callback-delivery.test.ts`          | integration | Callback webhook delivery   |

---

## 11. Configuration

### Environment Variables

| Variable                      | Default                 | Description                                        |
| ----------------------------- | ----------------------- | -------------------------------------------------- |
| `WORKFLOW_ENGINE_URL`         | `http://localhost:9080` | Workflow engine URL for runtime proxy (existing)   |
| `PROCESS_API_SYNC_TIMEOUT_MS` | `30000`                 | Max wait time for sync execution before auto-async |
| `CALLBACK_MAX_RETRIES`        | `3`                     | Max retry attempts for callback webhook delivery   |
| `CALLBACK_RETRY_BASE_MS`      | `1000`                  | Base delay for exponential backoff on retries      |

### Runtime Configuration

- **Per-workflow**: API key enabled/disabled toggle in workflow settings
- **Per-trigger**: Timezone, preset type, schedule parameters stored in `TriggerRegistration.config`
- **Per-tenant**: Rate limits applied via existing `tenantRateLimit` middleware

### DSL / Agent IR / Schema

No DSL changes. The Process API is a pure runtime concept. Trigger configuration is stored as structured JSON in `TriggerRegistration.config`:

```typescript
// Time-based trigger config shape
interface ScheduleTriggerConfig {
  preset: 'daily' | 'weekly' | 'monthly' | 'once' | 'cron';
  timezone: string; // IANA timezone
  time?: string; // HH:MM (daily, weekly, monthly)
  dayOfWeek?: number; // 0-6 (weekly)
  dayOfMonth?: number; // 1-28 (monthly)
  datetime?: string; // ISO 8601 (once)
  cronExpression?: string; // raw cron (cron preset)
}
```

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                                                                      |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Project isolation | Process API resolves `tenantId` and `projectId` from the API key — the caller never provides these. All downstream queries include both. Cross-project API keys are impossible (key is scoped to one workflow in one project). |
| Tenant isolation  | `WorkflowApiKey` and `TriggerRegistration` both use `tenantIsolationPlugin`. All queries include `tenantId`. Cross-tenant access returns 404.                                                                                  |
| User isolation    | API keys are created by authenticated users (`createdBy`). Key listing is project-scoped (any project member can list). Key creation requires `workflow:manage` permission.                                                    |

### Security & Compliance

- **API Key Storage**: SHA-256 hashed, never stored in plaintext. Raw key returned only once at creation.
- **API Key Prefix**: `wfk_` prefix for easy identification in logs without exposing the key.
- **API Key Expiration**: Optional TTL via `expiresAt` with MongoDB TTL index for automatic cleanup.
- **Callback URL Validation**: Must be HTTPS in production. HTTP allowed only in development.
- **Callback Signing**: HMAC-SHA256 signature headers on all callback webhook deliveries.
- **Input Validation**: Zod validation on all API inputs. Workflow input schema validation when defined.
- **Audit Trail**: Every API-triggered execution records the `apiKeyId` in `triggerMetadata`.

### Performance & Scalability

- **Sync execution**: 30s timeout with Redis Pub/Sub subscription — no polling overhead.
- **Async execution**: Immediate 202 response, sub-100ms latency.
- **Status polling**: Direct MongoDB query by `_id` — O(1) lookup.
- **BullMQ scheduling**: Existing concurrency of 10 workers. Repeatable jobs are distributed across workers.
- **Callback delivery**: Separate BullMQ queue (`workflow-callbacks`) to avoid blocking trigger scheduling.

### Reliability & Failure Modes

- **Sync timeout**: Auto-promotes to async (returns traceId) — no data loss.
- **Callback failure**: 3 retries with exponential backoff. Status tracked in `triggerMetadata.callbackStatus`.
- **Scheduler restart**: BullMQ repeatable jobs survive worker restart. One-shot jobs use `jobId` for dedup.
- **API key revocation**: Immediate — revoked keys fail auth on next request.
- **Trigger auto-pause**: After 10 consecutive errors, triggers auto-pause (existing behavior).

### Observability

- **Trace events**: Process API calls emit `TraceEvent` with `type: 'workflow_api_invocation'`, including `apiKeyId`, `isAsync`, execution time.
- **Metrics**: API key usage count, sync vs async ratio, callback delivery success rate.
- **Logs**: `createLogger('process-api')` for all route handlers.
- **Existing**: Workflow execution events via Redis Pub/Sub (workflow.started, step.completed, etc.).

### Data Lifecycle

- **API keys**: Optional TTL via `expiresAt`. Revoked keys remain in DB (soft-delete) for audit. MongoDB TTL index handles cleanup.
- **Trigger registrations**: Soft-deleted (`status: 'deleted'`, `deletedAt` set). Retained for audit.
- **Callback metadata**: Stored inline in `WorkflowExecution.triggerMetadata`. Subject to execution retention policy.
- **One-shot triggers**: Auto-paused after firing. Can be manually deleted or left for audit.

---

## 13. Delivery Plan / Work Breakdown

0. **Database Schema Preparation**
   0.1. Add `{ keyHash: 1 }` unique index to `WorkflowApiKey` model for efficient API key lookup
   0.2. Change `connectorName` and `connectionId` from `required: true` to optional in `TriggerRegistration` model (time-based triggers have no connector/connection)

1. **Process API (Webhook Trigger)**
   1.1. Create `workflow-api-key-auth.ts` middleware in `apps/runtime/` — hash incoming `x-api-key`, lookup `WorkflowApiKey` by `keyHash`, resolve `tenantId`/`projectId`/`workflowId`
   1.2. Create `process-api.ts` routes in `apps/runtime/` — `POST /api/v1/process/:workflowId` and `GET /api/v1/process/:workflowId/status`
   1.3. Implement sync execution: start Restate workflow, subscribe to Redis Pub/Sub, wait up to 30s, return result or auto-promote to async
   1.4. Implement async execution: start Restate workflow, return `{ traceId, status: 'running' }` immediately
   1.5. Implement status polling: query `WorkflowExecution` by `restateWorkflowId` or `_id`, return status + result
   1.6. Add input schema validation against `workflow.definition.schemas.input` (if defined)
   1.7. Mount routes in `apps/runtime/src/server.ts` before the workflow engine proxy

2. **API Key Management**
   2.1. Create `workflow-api-keys.ts` routes in `apps/runtime/` — CRUD endpoints with JWT auth
   2.2. Implement key generation: `crypto.randomBytes(32)` → `wfk_` + base62 encoding, store SHA-256 hash
   2.3. Add Studio UI `ApiKeyManager.tsx` component — create, list (show prefix only), revoke
   2.4. Add `CodeSnippets.tsx` component — generate curl examples with workflow URL and placeholder API key

3. **Async Callback Push**
   3.1. Create `callback-delivery-worker.ts` in `apps/workflow-engine/` — BullMQ worker on `workflow-callbacks` queue
   3.2. On workflow completion, if `triggerMetadata.callbackUrl` exists, enqueue callback job
   3.3. Worker POSTs result with HMAC signature headers, retries 3x with exponential backoff
   3.4. Update `triggerMetadata.callbackStatus` and `callbackAttempts` on success/failure

4. **Time-Based Trigger Enhancements**
   4.1. Add preset-to-cron resolver function: maps daily/weekly/monthly/once/cron → cron expression + BullMQ options
   4.2. Extend `TriggerScheduler.scheduleCron()` to pass `tz` option to BullMQ repeatable jobs
   4.3. Implement one-shot scheduling via BullMQ `delay` option with auto-pause on completion
   4.4. Add timezone validation (IANA timezone list) in trigger registration route
   4.5. Create Studio `SchedulePresetPicker.tsx` component — preset selector, time picker, timezone dropdown

5. **External App Trigger Catalog**
   5.1. Create static catalog JSON file with connector metadata (name, category, description, icon, status)
   5.2. Add `GET /api/v1/connectors/triggers/catalog` route (or extend existing connectors route)
   5.3. Create Studio `ExternalAppCatalog.tsx` component — grouped display with "Coming Soon" badges

6. **Testing & Validation**
   6.1. Unit tests for API key auth middleware, preset resolver, callback delivery
   6.2. Integration tests for Process API (sync, async, poll, callback)
   6.3. E2E tests through real HTTP with API key auth, tenant isolation, workflow execution
   6.4. Load test for sync execution timeout behavior

---

## 14. Success Metrics

| Metric                       | Baseline | Target        | How Measured                                    |
| ---------------------------- | -------- | ------------- | ----------------------------------------------- |
| Process API adoption         | 0        | 50+ calls/day | Count executions with `triggerType: 'api'`      |
| Sync execution p99 latency   | N/A      | < 5s          | Execution duration for sync API calls           |
| Async callback delivery rate | N/A      | > 99%         | `callbackStatus: 'delivered'` / total callbacks |
| Schedule trigger accuracy    | N/A      | < 60s drift   | `lastFiredAt` vs expected fire time             |
| API key creation in Studio   | 0        | 20+ keys      | Count `WorkflowApiKey` documents                |
| Time-based trigger adoption  | 0        | 10+ triggers  | Count triggers with `config.preset` set         |

---

## 15. Open Questions

1. **Rate limiting granularity**: Should the Process API have per-API-key rate limits in addition to per-tenant limits? If so, what's the default (e.g., 100 req/min per key)?
2. **Sync execution long-running workflows**: Should there be a configurable per-workflow sync timeout (instead of the global 30s default)?
3. **Callback URL allowlist**: Should tenants be able to restrict callback URLs to a pre-approved domain list (for security)?
4. **One-shot trigger rescheduling**: Should a paused one-shot trigger be re-schedulable via the resume endpoint with a new datetime?
5. **API key scoping**: Should API keys be scopable to specific input schemas or execution limits (e.g., max 100 executions)?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                                                                                                                                                                                                                                                                                                                                                                                        | Severity | Status    |
| ------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- | --------- |
| GAP-001 | No per-API-key rate limiting — only tenant-level limits apply                                                                                                                                                                                                                                                                                                                                                                                      | Medium   | Open      |
| GAP-002 | One-shot trigger does not support sub-minute precision (BullMQ delay is ms-accurate but cron is not)                                                                                                                                                                                                                                                                                                                                               | Low      | Open      |
| GAP-003 | Callback webhook delivery has no dead-letter queue — failed callbacks are logged but not retried beyond 3 attempts                                                                                                                                                                                                                                                                                                                                 | Medium   | Open      |
| GAP-004 | External app trigger catalog is static — no runtime discovery of installed connectors                                                                                                                                                                                                                                                                                                                                                              | Low      | Open      |
| GAP-005 | `missedFirePolicy` (fire_once/fire_all/skip) is defined in the model but not implemented in TriggerScheduler.processJob()                                                                                                                                                                                                                                                                                                                          | Medium   | Open      |
| GAP-006 | No E2E tests for trigger system (inherited from parent feature GAP-01)                                                                                                                                                                                                                                                                                                                                                                             | High     | Open      |
| GAP-007 | Sync execution relies on Redis Pub/Sub — if Redis is unavailable, sync mode degrades to async                                                                                                                                                                                                                                                                                                                                                      | Medium   | Open      |
| GAP-008 | Cron triggers stored only the preset form (`{preset, time, timezone, ...}`) at register time — UI showed "Schedule not configured" and `resume()` had to re-run the preset resolver. 2026-04-19: `register()` now persists the resolved `cronExpression` into `config.cronExpression` (and legacy top-level) at create time; UI reads `config.cronExpression` first with preset-summary fallback via `formatCronPreset`.                           | Medium   | Mitigated |
| GAP-009 | When Redis/BullMQ was absent, cron trigger registration silently no-fired — the scheduler delegation was skipped without a log, leaving operators to discover the gap only at first expected fire. 2026-04-19: `register()` and `resume()` now emit an explicit warn log (`"Cron trigger persisted/resumed but scheduler is unavailable …"` — match actual log text emitted from `register()` and `resume()`) so the condition is visible in logs. | Medium   | Mitigated |
| GAP-010 | "Fire Now" on a paused or deleted trigger was handed off to the backend, which rejected with a generic error — users saw no indication that the lifecycle state was the cause. 2026-04-19: `WorkflowTriggersTab` fails fast with `"Trigger is disabled. Resume it to fire."` before the HTTP call.                                                                                                                                                 | Low      | Mitigated |
| GAP-011 | Trigger-list initial render flashed `EmptyState` while the SWR registrations fetch was in flight, so a real trigger list briefly looked empty. 2026-04-19: a `Skeleton`-based placeholder matching the card layout renders until `!isLoading \|\| registrationsData`.                                                                                                                                                                              | Low      | Mitigated |

### Mitigation Notes (2026-04-19)

Follow-on commit `a98c6fa5ab` closed four trigger-surface gaps surfaced when exercising the trigger UI against deployments that register cron triggers before the BullMQ scheduler is wired, and against legacy preset-only records:

- **GAP-008 (canonical cron config)**: `trigger-engine.ts` `register()` now resolves preset/cronExpression into `resolvedCron` + `resolvedTz` and writes both to `config.cronExpression` (canonical) and the top-level `cronExpression` field (legacy readers). `resume()` reads `config.cronExpression` first. The Studio list renders the resolved expression + a `formatCronExpression` humanization; when only a preset is stored (older records), `formatCronPreset` produces `"Daily at 09:00"` / `"Weekly on Monday at 09:00 (America/New_York)"` style summaries instead of `"Schedule not configured"`.
- **GAP-009 (scheduler-absent visibility)**: preset resolution errors (e.g. missing `datetime` for `'once'`) are caught and logged as warnings — the trigger persists so the user can fix and resume. When `deps.scheduler` is `undefined`, both `register()` and `resume()` emit explicit warn logs so the no-fire condition is observable in service logs and Coroot.
- **GAP-010 (Fire Now fail-fast)**: `TriggerCard.handleFire()` checks `trigger.status !== 'active'` and sets a clear error before calling the backend. `status === 'paused'` adds the hint "Resume it to fire."
- **GAP-011 (list skeleton)**: `useSWR` now destructures `isLoading`; the list-loading branch renders a two-card Skeleton scaffold that matches the real card layout (icon, label line, body placeholder, 3 action buttons).

No HLD decisions overturned — these are additive fixes on existing flows.

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                                                                                         | Coverage Type    | Status     | Test File / Note                                                                                                                                                          |
| --- | ------------------------------------------------------------------------------------------------ | ---------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Process API sync execution returns result inline                                                 | e2e              | NOT TESTED | `process-api.e2e.test.ts`                                                                                                                                                 |
| 2   | Process API async execution returns traceId (HTTP 202)                                           | e2e              | NOT TESTED | `process-api.e2e.test.ts`                                                                                                                                                 |
| 3   | Status polling returns completed result                                                          | e2e              | NOT TESTED | `process-api.e2e.test.ts`                                                                                                                                                 |
| 4   | Invalid API key returns 401                                                                      | e2e              | NOT TESTED | `process-api.e2e.test.ts`                                                                                                                                                 |
| 5   | Cross-workflow API key returns 404                                                               | e2e              | NOT TESTED | `process-api.e2e.test.ts`                                                                                                                                                 |
| 6   | Expired API key returns 401                                                                      | integration      | NOT TESTED | `process-api.test.ts`                                                                                                                                                     |
| 7   | Sync timeout auto-promotes to async                                                              | integration      | NOT TESTED | `process-api.test.ts`                                                                                                                                                     |
| 8   | Callback webhook delivered on completion                                                         | integration      | NOT TESTED | `callback-delivery.test.ts`                                                                                                                                               |
| 9   | Callback retry on failure                                                                        | unit             | NOT TESTED | `callback-delivery.test.ts`                                                                                                                                               |
| 10  | Schedule preset → cron expression mapping                                                        | unit             | NOT TESTED | `trigger-scheduler-timezone.test.ts`                                                                                                                                      |
| 11  | BullMQ timezone option passed correctly                                                          | unit             | NOT TESTED | `trigger-scheduler-timezone.test.ts`                                                                                                                                      |
| 12  | One-shot trigger fires and auto-pauses                                                           | integration      | NOT TESTED | `trigger-scheduler-timezone.test.ts`                                                                                                                                      |
| 13  | Trigger registration with invalid timezone rejected                                              | unit             | NOT TESTED | `triggers.test.ts`                                                                                                                                                        |
| 14  | API key CRUD (create, list, revoke)                                                              | integration      | NOT TESTED | `workflow-api-keys.test.ts`                                                                                                                                               |
| 15  | Tenant isolation: cross-tenant API key returns 404                                               | e2e              | NOT TESTED | `process-api.e2e.test.ts`                                                                                                                                                 |
| 16  | Cron trigger registered with a preset persists `config.cronExpression` canonical value (GAP-008) | integration      | NOT TESTED | `trigger-engine.test.ts` — new case asserts `findOneAndUpdate` writes `config.cronExpression`                                                                             |
| 17  | Cron trigger registered without a scheduler persists + emits a warn log (GAP-009)                | unit             | NOT TESTED | `trigger-engine.test.ts` — assert log.warn called with `"Cron trigger persisted but scheduler is unavailable …"`                                                          |
| 18  | Fire Now on a paused trigger sets a client-side error before making the HTTP call (GAP-010)      | e2e (Playwright) | NOT TESTED | `apps/studio/e2e/workflows/*` — pause trigger, click Fire Now, assert inline error without backend hit                                                                    |
| 19  | Trigger list renders a Skeleton placeholder while the SWR fetch is in flight (GAP-011)           | e2e (Playwright) | NOT TESTED | `apps/studio/e2e/workflows/*` — delay the `/api/projects/:pid/workflows/triggers` response, assert `[data-testid=triggers-loading]` before `[data-testid=trigger-card-*]` |

### Testing Notes

Existing trigger tests cover TriggerEngine register/deregister/pause/resume/fire (unit level). No E2E tests exist for the trigger system. The Process API is entirely new and has zero test coverage. Priority: E2E tests for the Process API sync/async flow, followed by integration tests for callback delivery and timezone scheduling.

> Full testing details: [../../testing/sub-features/workflow-triggers.md](../../testing/sub-features/workflow-triggers.md)

---

## 18. References

- Parent feature: [docs/features/workflows.md](../workflows.md)
- HLD: [docs/specs/workflows.hld.md](../../specs/workflows.hld.md)
- LLD: [docs/plans/workflows.lld.md](../../plans/workflows.lld.md)
- Implementation plan: [docs/plans/2026-03-23-workflows-impl-plan.md](../../plans/2026-03-23-workflows-impl-plan.md)
- TriggerRegistration model: `packages/database/src/models/trigger-registration.model.ts`
- WorkflowApiKey model: `packages/database/src/models/workflow-api-key.model.ts`
- Webhook signature utils: `packages/shared-kernel/src/security/webhook-signature.ts`
- BullMQ helpers: `packages/redis/src/bullmq.ts`
