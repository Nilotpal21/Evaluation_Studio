# Testing Guide: Workflow Triggers

**Feature**: [Workflow Triggers](../../features/sub-features/workflow-triggers.md)
**Parent Feature**: [Workflows & Human Tasks](../../features/workflows.md)
**Status**: PLANNED
**Last Updated**: 2026-04-19

---

## Current State

No tests exist for the Process API (new). Existing trigger infrastructure has unit test coverage in:

- `apps/workflow-engine/src/__tests__/trigger-engine.test.ts` (register/deregister/pause/resume/fire)
- `apps/workflow-engine/src/__tests__/trigger-environment.test.ts` (environment resolution)
- `apps/workflow-engine/src/__tests__/trigger-fire-resolution.test.ts` (version resolution)
- `packages/connectors/src/__tests__/webhook-handler.test.ts`
- `packages/connectors/src/__tests__/polling-scheduler.test.ts`
- `packages/connectors/src/__tests__/cron-scheduler.test.ts`
- `packages/shared-kernel/src/security/__tests__/webhook-signature.test.ts`

---

## Coverage Matrix

| FR    | Requirement                                | Unit | Integration | E2E | Manual |
| ----- | ------------------------------------------ | ---- | ----------- | --- | ------ |
| FR-01 | Process API endpoint with API key auth     | -    | -           | -   | -      |
| FR-02 | Input payload passed as triggerPayload     | -    | -           | -   | -      |
| FR-03 | Sync execution returns result (≤30s)       | -    | -           | -   | -      |
| FR-04 | Async execution returns traceId (HTTP 202) | -    | -           | -   | -      |
| FR-05 | Sync timeout auto-promotes to async        | -    | -           | -   | -      |
| FR-06 | Status polling endpoint                    | -    | -           | -   | -      |
| FR-07 | Status response format                     | -    | -           | -   | -      |
| FR-08 | Callback URL for async push                | -    | -           | -   | -      |
| FR-09 | Callback HMAC signing + retry              | -    | -           | -   | -      |
| FR-10 | Time-based trigger presets                 | -    | -           | -   | -      |
| FR-11 | Timezone support via BullMQ tz             | -    | -           | -   | -      |
| FR-12 | Daily/weekly/monthly preset config         | -    | -           | -   | -      |
| FR-13 | One-shot trigger auto-pause                | -    | -           | -   | -      |
| FR-14 | Raw cron expression validation             | -    | -           | -   | -      |
| FR-15 | Preset metadata in TriggerRegistration     | -    | -           | -   | -      |
| FR-16 | External app trigger catalog endpoint      | -    | -           | -   | -      |
| FR-17 | API-triggered execution audit trail        | -    | -           | -   | -      |
| FR-18 | Workflow status check (active only)        | -    | -           | -   | -      |
| FR-19 | API key management CRUD                    | -    | -           | -   | -      |
| FR-20 | Input schema validation                    | -    | -           | -   | -      |

### Post-ALPHA Trigger-Surface Polish (2026-04-19, commit `a98c6fa5ab`)

| Gap   | Requirement                                                                                               | Unit | Integration | E2E | Manual |
| ----- | --------------------------------------------------------------------------------------------------------- | ---- | ----------- | --- | ------ |
| G-008 | Cron `register()` persists resolved `config.cronExpression` for preset inputs                             | -    | -           | -   | -      |
| G-008 | UI falls back to `formatCronPreset` when only the preset form is stored (daily / weekly / monthly / once) | -    | -           | -   | 📝     |
| G-009 | `register()` emits a warn log when the BullMQ scheduler is unavailable                                    | -    | -           | -   | -      |
| G-009 | `resume()` emits the same warn log for legacy cron records on boot without a scheduler                    | -    | -           | -   | -      |
| G-010 | Fire Now on paused/deleted trigger sets an inline error without calling the backend                       | -    | -           | -   | 📝     |
| G-011 | Trigger list renders a Skeleton placeholder while SWR registrations fetch is in flight                    | -    | -           | -   | 📝     |

All six rows are currently manual / uncovered. Recommend adding (a) a Vitest integration case for `register()` that seeds a scheduler stub and asserts the `findOneAndUpdate` $set carries `config.cronExpression`, (b) a Vitest integration case that constructs `TriggerEngine` with `deps.scheduler = undefined` and asserts the warn log path, and (c) a Playwright test that exercises Fire Now on a paused trigger + the Skeleton loading state by delaying the registrations fetch.

---

## E2E Test Scenarios

All E2E tests must exercise the real system through HTTP API. No mocks, no direct DB access. Start real servers on random ports.

### E2E-1: Sync Process API — Happy Path

**Precondition**: Active workflow with API key created via JWT-authenticated management endpoint.

```
1. POST /api/v1/projects/:projectId/workflows/:workflowId/api-keys (JWT auth) → get raw key
2. POST /api/v1/process/:workflowId (x-api-key: <raw-key>) with { input: { name: "test" } }
3. Assert HTTP 200 with { status: "completed", result: { ... } }
4. GET /api/v1/projects/:projectId/workflows/:workflowId/executions (JWT auth)
5. Assert execution exists with triggerType: "api", triggerMetadata.apiKeyId matches
```

### E2E-2: Async Process API with Polling

```
1. Create workflow + API key via management endpoints
2. POST /api/v1/process/:workflowId with { input: {}, isAsync: true }
3. Assert HTTP 202 with { traceId: <id>, status: "running" }
4. Poll GET /api/v1/process/:workflowId/status?traceId=<id> until status != "running"
5. Assert final response has status: "completed" and result is present
```

### E2E-3: API Key Auth — Invalid Key Returns 401

```
1. POST /api/v1/process/:workflowId with x-api-key: "wfk_invalid_key"
2. Assert HTTP 401 with error response
3. Assert no workflow execution was created
```

### E2E-4: Tenant Isolation — Cross-Workflow Key Returns 404

```
1. Create workflow A + API key (tenant 1, project 1)
2. Create workflow B (tenant 1, project 1)
3. POST /api/v1/process/:workflowBId with workflow A's API key
4. Assert HTTP 404 (key's workflowId doesn't match requested workflowId)
```

### E2E-5: Draft Workflow Returns 404

```
1. Create workflow in draft status + API key
2. POST /api/v1/process/:workflowId with valid API key
3. Assert HTTP 404 (workflow not active)
```

### E2E-6: Time-Based Trigger — Schedule with Timezone

```
1. POST /api/v1/projects/:projectId/triggers (JWT auth) with:
   { workflowId, type: "cron", config: { preset: "daily", time: "09:00", timezone: "America/New_York" } }
2. Assert trigger created with status: "active"
3. GET /api/v1/projects/:projectId/triggers → verify trigger in list
4. Assert trigger config contains resolved cronExpression and timezone
5. POST /api/v1/projects/:projectId/triggers/:id/pause → verify status: "paused"
6. POST /api/v1/projects/:projectId/triggers/:id/resume → verify status: "active"
```

### E2E-7: API Key Lifecycle (Create, List, Revoke)

```
1. POST /api/v1/projects/:projectId/workflows/:workflowId/api-keys → get raw key
2. GET /api/v1/projects/:projectId/workflows/:workflowId/api-keys → verify key in list (prefix only)
3. POST /api/v1/process/:workflowId with key → assert 200
4. DELETE /api/v1/projects/:projectId/workflows/:workflowId/api-keys/:keyId → revoke
5. POST /api/v1/process/:workflowId with revoked key → assert 401
```

---

## Integration Test Scenarios

### INT-1: API Key Auth Middleware

Test `workflow-api-key-auth.ts` with real MongoDB (WorkflowApiKey model):

- Valid key resolves to correct tenantId/projectId/workflowId
- Expired key returns 401
- Missing key returns 401
- Key for different workflow returns 404

### INT-2: Sync Execution Timeout → Auto-Async

Test with a workflow that takes >30s:

- Start sync execution
- Assert that after timeout, response is HTTP 202 with traceId
- Assert execution continues in background

### INT-3: Schedule Preset Resolver

Test preset-to-cron resolution:

- daily at 14:30 → `30 14 * * *`
- weekly Monday at 09:00 → `0 9 * * 1`
- monthly 15th at 00:00 → `0 0 15 * *`
- once at specific datetime → BullMQ delay option
- Invalid timezone rejected with 400

### INT-4: Callback Webhook Delivery

Test callback delivery worker with real BullMQ:

- On workflow completion, callback job enqueued
- Worker POSTs to callback URL with HMAC headers
- Failed delivery retried up to 3 times
- Final failure recorded in triggerMetadata

### INT-5: One-Shot Trigger Lifecycle

Test with real BullMQ + MongoDB:

- Schedule one-shot trigger with future datetime
- Manually fire the job
- Assert workflow execution started
- Assert trigger status changed to "paused"

### INT-6: Trigger Registration with Invalid Config

- Invalid timezone (e.g., "Invalid/Zone") → 400
- dayOfMonth > 28 → 400
- Invalid cron expression → 400
- Missing required fields per preset → 400

---

## Security & Isolation Tests

### SEC-1: Cross-Tenant API Key Access

- Create API key in tenant A
- Attempt to use it from tenant B context → 404

### SEC-2: API Key Not Returned After Creation

- Create API key → raw key in response
- List API keys → only prefix visible, no raw key

### SEC-3: Callback URL HTTPS Enforcement

- In production mode, callbackUrl with HTTP → rejected
- In development mode, HTTP → allowed

---

## Performance Tests

### PERF-1: Sync Execution Latency

- Measure p50/p95/p99 for sync execution of a simple 2-step workflow
- Target: p99 < 5s

### PERF-2: Status Polling Latency

- Measure response time for status endpoint
- Target: p99 < 200ms

---

> Full feature details: [../../features/sub-features/workflow-triggers.md](../../features/sub-features/workflow-triggers.md)
