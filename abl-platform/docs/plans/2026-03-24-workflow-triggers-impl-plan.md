# LLD: Workflow Triggers

**Feature Spec**: `docs/features/sub-features/workflow-triggers.md`
**HLD**: `docs/specs/workflow-triggers.hld.md`
**Test Spec**: `docs/testing/sub-features/workflow-triggers.md`
**Status**: DRAFT
**Date**: 2026-03-24

---

## 1. Design Decisions

### Decision Log

| #   | Decision                                                      | Rationale                                                                                      | Alternatives Rejected                                          |
| --- | ------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| D-1 | 3-phase order: Process API → Scheduling+Callbacks → Studio UI | P0 FRs are all Process API; schema changes are prerequisites; Studio depends on backend        | Feature-slice (webhook E2E first), single-phase                |
| D-2 | Bundle schema relaxation (connectorName optional) in Phase 1  | One-line change per field; MongoDB schema-less; TriggerEngine already defaults absent values   | Standalone migration phase                                     |
| D-3 | Ship without feature flag                                     | No feature flag infrastructure exists; rollback = route mount removal; all changes additive    | Feature flag system (overkill for additive routes)             |
| D-4 | Dedicated Redis subscriber connection for sync execution      | Matches existing `redis.duplicate()` pattern; avoids connection-per-request overhead           | Connection-per-request, MongoDB polling                        |
| D-5 | Pure function module for preset-resolver                      | No external deps; matches `webhook-signature.ts` and `canvas-to-steps.ts` patterns             | DI class                                                       |
| D-6 | Separate BullMQ Worker for callback delivery                  | Different queue (`workflow-callbacks`), different retry semantics than `workflow-triggers`     | Integrate into TriggerScheduler                                |
| D-7 | Extend existing POST /execute for optional executionId        | One-line additive change; existing callers unaffected                                          | New endpoint                                                   |
| D-8 | HMAC signing secret: per-tenant from tenant config            | User decision. Avoids per-workflow secret management overhead.                                 | Per-workflow secret, per-trigger secret                        |
| D-9 | Filter terminal events in subscriber, not separate channel    | Non-breaking; step events have `stepId` field, terminal events have `type: 'workflow.*'` field | Separate channel for terminal events (requires handler change) |

### Key Interfaces & Types

```typescript
// apps/runtime/src/services/sync-execution.ts
export interface SyncExecutionDeps {
  redisSubscriber: Redis; // dedicated Pub/Sub connection via redis.duplicate()
}

export interface SyncExecutionResult {
  status: 'completed' | 'failed' | 'cancelled' | 'timeout';
  result?: Record<string, unknown>;
  error?: { code: string; message: string };
}

// apps/runtime/src/routes/process-api.ts
export interface ProcessApiDeps {
  syncExecution: SyncExecutionService;
  engineBaseUrl: string;
}

// apps/workflow-engine/src/services/preset-resolver.ts
export interface PresetConfig {
  preset: 'daily' | 'weekly' | 'monthly' | 'once' | 'cron';
  timezone: string; // IANA timezone
  time?: string; // HH:MM
  dayOfWeek?: number; // 0-6
  dayOfMonth?: number; // 1-28
  datetime?: string; // ISO 8601
  cronExpression?: string; // raw cron (for 'cron' preset)
}

export interface ResolvedSchedule {
  cronExpression?: string; // undefined for 'once' preset
  delay?: number; // ms from now (for 'once' preset)
  tz?: string; // IANA timezone for BullMQ
}

// apps/workflow-engine/src/services/callback-delivery-worker.ts
export interface CallbackDeliveryDeps {
  webhookSecret: (tenantId: string) => Promise<string>; // per-tenant secret resolver
}

export interface CallbackJobData {
  executionId: string;
  tenantId: string;
  callbackUrl: string;
  payload: {
    traceId: string;
    status: string;
    result?: Record<string, unknown>;
    error?: { code: string; message: string };
  };
}
```

### Module Boundaries

| Module                     | Responsibility                                                    | Depends On                                        |
| -------------------------- | ----------------------------------------------------------------- | ------------------------------------------------- |
| `process-api.ts` (runtime) | Auth, scope check, proxy to engine, sync/async orchestration      | `sync-execution.ts`, `auth-repo.ts`, engine proxy |
| `sync-execution.ts`        | Redis Pub/Sub subscribe, timeout, event filtering, result fetch   | Redis (dedicated subscriber), MongoDB             |
| `preset-resolver.ts`       | Preset config → cron expression + BullMQ options                  | None (pure function)                              |
| `callback-delivery-worker` | BullMQ worker: HMAC sign, POST to URL, retry, status tracking     | Redis (BullMQ), webhook-signature utils           |
| `trigger-engine.ts` (ext)  | Extended: preset resolution on register, timezone in scheduleCron | `preset-resolver.ts`, `trigger-scheduler.ts`      |
| `trigger-scheduler.ts`     | Extended: pass `tz` option to BullMQ repeatable jobs              | BullMQ, Redis                                     |

---

## 2. File-Level Change Map

### New Files

| File                                                                        | Purpose                                              | LOC Estimate |
| --------------------------------------------------------------------------- | ---------------------------------------------------- | ------------ |
| `apps/runtime/src/routes/process-api.ts`                                    | Process API routes (POST execute, GET status)        | ~200         |
| `apps/runtime/src/services/sync-execution.ts`                               | Redis Pub/Sub sync wait with timeout + result fetch  | ~150         |
| `apps/workflow-engine/src/services/preset-resolver.ts`                      | Preset-to-cron pure function module                  | ~80          |
| `apps/workflow-engine/src/services/callback-delivery-worker.ts`             | BullMQ callback delivery worker                      | ~180         |
| `apps/workflow-engine/src/routes/trigger-catalog.ts`                        | Static external app catalog endpoint                 | ~50          |
| `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx`       | Quick Start panel (endpoint, curl snippets, key)     | ~250         |
| `apps/studio/src/components/workflows/triggers/WebhookKeyCreationModal.tsx` | One-time key reveal modal                            | ~120         |
| `apps/studio/src/components/workflows/triggers/SchedulePresetPicker.tsx`    | Friendly schedule preset UI                          | ~200         |
| `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx`            | Tabbed curl generator (Sync/Async/Poll)              | ~100         |
| `apps/studio/src/components/workflows/triggers/ExternalAppCatalog.tsx`      | External app trigger browser (display only)          | ~100         |
| `apps/runtime/src/__tests__/process-api.e2e.test.ts`                        | E2E: E2E-1, E2E-2, E2E-13 (sync/async/timeout)       | ~300         |
| `apps/runtime/src/__tests__/process-api-auth.e2e.test.ts`                   | E2E: E2E-3, E2E-4, E2E-5, E2E-6, E2E-10, SEC-1–SEC-6 | ~400         |
| `apps/runtime/src/__tests__/process-api-callback.e2e.test.ts`               | E2E: E2E-8 (callback push)                           | ~200         |
| `apps/runtime/src/__tests__/trigger-schedule.e2e.test.ts`                   | E2E: E2E-7, E2E-9, SEC-7 (schedule + one-shot)       | ~300         |
| `apps/runtime/src/__tests__/trigger-webhook-key.e2e.test.ts`                | E2E: E2E-11, E2E-12 (auto-key + catalog)             | ~200         |
| `apps/runtime/src/__tests__/process-api.integration.test.ts`                | INT-1, INT-2, INT-8, INT-9, INT-10                   | ~400         |
| `apps/workflow-engine/src/__tests__/trigger-scheduler-timezone.test.ts`     | INT-3, INT-5, INT-6 (scheduling + timezone)          | ~300         |
| `apps/workflow-engine/src/__tests__/callback-delivery.test.ts`              | INT-4 (callback delivery with HMAC)                  | ~200         |
| `apps/workflow-engine/src/__tests__/trigger-webhook-key.test.ts`            | INT-7 (auto-key creation with reuse)                 | ~150         |
| `apps/workflow-engine/src/__tests__/preset-resolver.test.ts`                | UT-1, UT-2, UT-3, UT-6, UT-7 (preset resolver)       | ~200         |

### Modified Files

| File                                                                | Change Description                                                            | Risk   |
| ------------------------------------------------------------------- | ----------------------------------------------------------------------------- | ------ |
| `packages/database/src/models/trigger-registration.model.ts`        | `connectorName`/`connectionId` → optional; no other changes                   | Low    |
| `apps/workflow-engine/src/routes/workflow-executions.ts`            | Accept optional `executionId` in body; use if provided                        | Low    |
| `apps/workflow-engine/src/services/trigger-engine.ts`               | Call preset-resolver on register for cron/webhook types; pass tz to scheduler | Medium |
| `apps/workflow-engine/src/services/trigger-scheduler.ts`            | Pass `tz` option to BullMQ `repeat`; add one-shot scheduling via `delay`      | Medium |
| `apps/workflow-engine/src/handlers/workflow-handler.ts`             | On completion: check `triggerMetadata.callbackUrl`, enqueue callback job      | Medium |
| `apps/workflow-engine/src/index.ts`                                 | Wire callback-delivery-worker, catalog route                                  | Low    |
| `apps/runtime/src/server.ts`                                        | Mount Process API routes                                                      | Low    |
| `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx` | Integrate WebhookQuickStart, SchedulePresetPicker, ExternalAppCatalog         | Medium |

---

## 3. Implementation Phases

### Phase 1: Core Process API (FR-01 through FR-07, FR-17, FR-18)

**Goal**: Deliver a working sync/async Process API with API key auth, status polling, and execution audit trail.

**Tasks**:

1.1. **Schema relaxation + triggerMetadata field** — Make `connectorName` and `connectionId` optional in `packages/database/src/models/trigger-registration.model.ts` (change `required: true` to `required: false` on lines 50 and 57). Add a new `triggerMetadata` field to `WorkflowExecution` schema in `packages/database/src/models/workflow-execution.model.ts`: `triggerMetadata: { type: Schema.Types.Mixed, default: {} }`. Update `IWorkflowExecution` interface to include `triggerMetadata?: Record<string, unknown>`. Also update `ExecutionStore.createExecution()` in `apps/workflow-engine/src/persistence/execution-store.ts` to accept and persist `triggerMetadata` from the input. Additionally, update the `ExecutionPersistence` interface in `apps/workflow-engine/src/handlers/workflow-handler.ts` (lines 76-85) to include `triggerMetadata?: Record<string, unknown>` in the `createExecution` input type — `ExecutionStore` implements this interface. Update the `createExecution()` call at line 378 of `workflow-handler.ts` to pass `triggerMetadata: input.triggerMetadata`.

1.2. **Execute endpoint extension** — In `apps/workflow-engine/src/routes/workflow-executions.ts` (line ~162), change `const executionId = crypto.randomUUID()` to `const executionId = req.body.executionId ?? crypto.randomUUID()`. Add Zod validation for `executionId` when present: `z.string().min(1).optional()` — this is a security-critical field used as MongoDB `_id`, so it MUST be validated even though the existing endpoint doesn't use Zod for other body fields. Thread the `executionId` through to `deps.restateClient.startWorkflow(executionId, input)` — the Restate handler already receives executionId as a parameter and passes it to `ExecutionStore.createExecution()`. Also thread `triggerMetadata` from `req.body.triggerMetadata` into the `startWorkflow` input so `workflow-handler.ts` can persist it via `ExecutionStore.createExecution()`. This is the full execution ID threading path: Process API generates ID → passes in body to execute endpoint → endpoint passes to `startWorkflow(executionId, { ..., triggerMetadata })` → Restate handler calls `persistence.createExecution({ ..., triggerMetadata })` → stored in MongoDB.

1.3. **SyncExecutionService** — Create `apps/runtime/src/services/sync-execution.ts`:

- Constructor accepts a dedicated Redis subscriber connection (via `redis.duplicate({ maxRetriesPerRequest: null })`)
- `async waitForCompletion(tenantId: string, executionId: string, timeoutMs: number): Promise<SyncExecutionResult>`
- Subscribes to `workflow:{tenantId}:execution:{executionId}:status` BEFORE returning control
- Filters messages for `type` in `['workflow.completed', 'workflow.failed', 'workflow.cancelled']`
- On terminal event: unsubscribes, fetches result from `WorkflowExecution` by `{ _id: executionId, tenantId }`, returns result
- On timeout: unsubscribes, returns `{ status: 'timeout' }`
- On client disconnect (`req.on('close')`): unsubscribes (cleanup)
- `async shutdown()`: unsubscribes all channels, quits subscriber connection

  1.4. **Process API routes** — Create `apps/runtime/src/routes/process-api.ts`:

- `POST /api/v1/process/:workflowId` — Auth via existing `authMiddleware` (chains `unifiedAuth` → `requireAuth` → `requireTenantContext`). After auth, tenant context is populated from the API key resolution. Steps:
  1. Verify `req.tenantContext?.authType === 'api_key'` — return 401 if not API key auth (JWT auth is not valid for Process API)
  2. Verify `'workflow:execute'` in `req.tenantContext.permissions` — return 403 (`FORBIDDEN`) if missing scope. Note: 404 is for cross-tenant/cross-project resource access; 403 is for missing permission on the caller's own key (matching HLD error table)
  3. Validate body with Zod: `{ input: z.record(z.unknown()), isAsync: z.boolean().optional(), callbackUrl: z.string().url().optional() }`
  4. Fetch workflow: Query `Workflow` model by `{ _id: workflowId, tenantId: req.tenantContext.tenantId }` (tenant-scoped, not project-scoped — we don't know projectId yet). Return 404 if not found or not active. Then verify `workflow.projectId` is in `req.tenantContext.projectScope` array — return 404 if not in scope. Note: This is a direct MongoDB query in runtime, not a proxy call to workflow-engine, because the Process API doesn't have projectId to construct a project-scoped URL. Alternatively, proxy to a tenant-scoped workflow-engine endpoint if one exists.
  5. Generate `executionId` via `uuidv7()` from `@agent-platform/database` (matching the existing `WorkflowExecution` model's `_id` generator for sort-order consistency)
  6. If `!isAsync`: subscribe via SyncExecutionService, then proxy `POST /execute` with `{ executionId, triggerType: 'api', triggerPayload: input, triggerMetadata: { apiKeyId: req.tenantContext.apiKeyId, callbackUrl } }`, await completion, return 200 with `{ success: true, data: { status, result, traceId } }` or 202 with `{ success: true, data: { traceId, status: 'running' } }` on timeout
  7. If `isAsync`: proxy `POST /execute` directly, return 202 with `{ success: true, data: { traceId: executionId, status: 'running' } }`
  - **Response envelope**: Process API uses the platform-standard `{ success, data?, error? }` envelope even though some existing workflow-engine routes use bare string errors. The Process API is a new public surface and should follow the standard: `{ success: true, data: { status, result?, traceId } }` for success, `{ success: false, error: { code, message } }` for errors.
  8. Emit structured log via `createLogger('process-api')` for every request: `{ workflowId, executionId, apiKeyId: req.tenantContext.apiKeyId, isAsync, duration }`
- `GET /api/v1/process/:workflowId/status` — Same auth. Validate `traceId` query param (`z.string().min(1)`). First verify `req.tenantContext?.authType === 'api_key'` and `'workflow:execute'` in `req.tenantContext.permissions`. Then fetch the workflow to get its `projectId`, verify `projectId` is in `req.tenantContext.projectScope`. Query `WorkflowExecution` by `{ _id: traceId, workflowId, tenantId, projectId }`. Return status, result, error.

  1.5. **Wire Process API into runtime** — In `apps/runtime/src/server.ts`:

- Import and create the process API router with deps (SyncExecutionService, engine base URL)
- Mount with `app.use('/api/v1/process', authMiddleware, processApiRouter)` — place after the execution plane block (after line ~431) and before the control plane block (before line ~442). `/api/v1/process` is a static prefix that won't conflict with existing `/api/v1/chat`, `/api/v1/voice` etc. Note: `authMiddleware` is the alias for `tenantAuthMiddleware` (imported at line 172-174), which chains `unifiedAuth → requireAuth → requireTenantContext`. For API key auth, `unifiedAuth` detects the `Bearer abl_*` header, resolves via `resolveApiKey()`, and populates `req.tenantContext` with `tenantId`, `apiKeyId`, `permissions`, `projectScope`, and `authType: 'api_key'`.
- Initialize SyncExecutionService at startup (create dedicated Redis subscriber connection), shut down on graceful exit
- Max concurrent sync requests limit: SyncExecutionService tracks active subscriptions and rejects new sync requests with HTTP 503 when the limit (default: 100) is exceeded. The 30s timeout provides TTL-based eviction.

  1.6. **Unit tests for sync-execution** — Create `apps/runtime/src/__tests__/sync-execution.test.ts` covering: successful completion, timeout → async promotion, workflow failure, client disconnect cleanup, event filtering (ignores step events).

  1.7. **E2E tests** — Create two test files per test spec Section 8 mapping:
  - `apps/runtime/src/__tests__/process-api.e2e.test.ts` covering E2E-1 (sync happy path), E2E-2 (async + polling), E2E-13 (sync timeout → 202)
  - `apps/runtime/src/__tests__/process-api-auth.e2e.test.ts` covering E2E-3 (invalid key → 401), E2E-4 (project isolation → 404), E2E-5 (draft workflow → 404), E2E-6 (scope enforcement → 403), E2E-10 (cross-tenant → 404), SEC-1 through SEC-6
    Tests start real Express + real MongoDB + real Redis, Restate mocked via DI.

    1.8. **Integration tests** — Create `apps/runtime/src/__tests__/process-api.integration.test.ts` covering INT-1 (auth middleware scope enforcement), INT-2 (sync timeout promotion), INT-8 (input schema validation boundary), INT-9 (workflow failure status propagation), INT-10 (cancelled workflow status). Note: UT-4 (status response format) is subsumed by INT-9 and INT-10 which verify the full response envelope including status fields.

**Files Touched**:

- `packages/database/src/models/trigger-registration.model.ts` — connectorName/connectionId optional
- `packages/database/src/models/workflow-execution.model.ts` — add `triggerMetadata: { type: Schema.Types.Mixed, default: {} }` field + interface update
- `apps/workflow-engine/src/persistence/execution-store.ts` — accept and persist `triggerMetadata` in `createExecution()`
- `apps/workflow-engine/src/routes/workflow-executions.ts` — optional executionId + triggerMetadata pass-through
- `apps/workflow-engine/src/handlers/workflow-handler.ts` — thread triggerMetadata from startWorkflow input to createExecution call
- `apps/runtime/src/services/sync-execution.ts` — NEW
- `apps/runtime/src/routes/process-api.ts` — NEW
- `apps/runtime/src/server.ts` — mount new routes
- `apps/runtime/src/__tests__/process-api.e2e.test.ts` — NEW
- `apps/runtime/src/__tests__/process-api-auth.e2e.test.ts` — NEW
- `apps/runtime/src/__tests__/process-api.integration.test.ts` — NEW
- `apps/runtime/src/__tests__/sync-execution.test.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/database` succeeds with 0 type errors
- [ ] `pnpm build --filter=@abl/runtime` succeeds with 0 type errors
- [ ] `pnpm build --filter=@abl/workflow-engine` succeeds with 0 type errors
- [ ] E2E-1 passes: sync execution returns result with `triggerType: 'api'` and `apiKeyId` in audit trail
- [ ] E2E-2 passes: async returns 202, polling returns completed result
- [ ] E2E-3 passes: invalid key returns 401
- [ ] E2E-4 passes: wrong-project key returns 404
- [ ] E2E-5 passes: draft workflow returns 404
- [ ] E2E-6 passes: missing scope returns 403 (FORBIDDEN — missing permission on own key)
- [ ] E2E-10 passes: cross-tenant returns 404
- [ ] E2E-13 passes: sync timeout auto-promotes to 202
- [ ] INT-1, INT-2, INT-8, INT-9, INT-10 pass
- [ ] Existing workflow-engine tests pass (no regressions)

**Test Strategy**:

- Unit: SyncExecutionService (event filtering, timeout, cleanup)
- Integration: Auth middleware scope enforcement, sync timeout, input validation, failure propagation
- E2E: Full HTTP flow with real servers, real DB, real Redis, mocked Restate via DI

**Rollback**: Remove `app.use('/api/v1/process', ...)` line from `server.ts` and redeploy. Schema changes are additive — no revert needed.

---

### Phase 2: Time-Based Scheduling + Callback Delivery (FR-08 through FR-15, FR-20)

**Goal**: Add friendly schedule presets with timezone, callback webhook delivery, and input schema validation.

**Tasks**:

2.1. **Preset resolver** — Create `apps/workflow-engine/src/services/preset-resolver.ts`:

- `export function resolvePreset(config: PresetConfig): ResolvedSchedule`
- Daily: `{ cronExpression: '${min} ${hr} * * *', tz: config.timezone }`
- Weekly: `{ cronExpression: '${min} ${hr} * * ${dow}', tz: config.timezone }`
- Monthly: `{ cronExpression: '${min} ${hr} ${dom} * *', tz: config.timezone }`
- Once: `{ delay: calculateDelayMs(config.datetime), tz: config.timezone }` — no cronExpression
- Cron: `{ cronExpression: config.cronExpression, tz: config.timezone }` — validate with `cron-parser`
- `export function validateTimezone(tz: string): boolean` — check `Intl.supportedValuesOf('timeZone').includes(tz)`
- `export function validateCronExpression(expr: string): boolean` — validate with `cron-parser` library. Note: `cron-parser` must be added to `apps/workflow-engine/package.json` as a new dependency (npm package — no Dockerfile COPY needed, it's installed by `pnpm install --frozen-lockfile` automatically)

  2.2. **TriggerScheduler timezone support** — Modify `apps/workflow-engine/src/services/trigger-scheduler.ts`:

- `scheduleCron()` method: accept optional `tz` parameter, pass as `repeat: { pattern: cron, tz }` to BullMQ
- Add `scheduleOnce(registrationId, data, delayMs)` method: use `queue.add(name, data, { delay: delayMs, jobId: registrationId })`
- One-shot post-fire: In the worker's `processJob()`, after execution completes, if `data.type === 'once'`, call `triggerModel.findOneAndUpdate({ _id: registrationId }, { status: 'paused' })`
- Fix-up: Add `removeOnComplete: { count: 100 }` and `removeOnFail: { count: 500 }` to existing `scheduleCron()` and `schedulePolling()` job options (currently missing — required by platform BullMQ standards). Note: This only affects newly created jobs; existing completed/failed jobs already in Redis won't be auto-cleaned — they'll expire naturally or can be drained manually

  2.3. **TriggerEngine preset integration** — Modify `apps/workflow-engine/src/services/trigger-engine.ts`:

- In `register()`: when `type === 'cron'` and `config.preset` exists, call `resolvePreset(config)` to get `cronExpression` and `tz`
- Store resolved `cronExpression` in `TriggerRegistration.cronExpression`
- Store original preset config in `TriggerRegistration.config` (timezone, preset, time, dayOfWeek, dayOfMonth, datetime)
- Pass `tz` to `scheduler.scheduleCron()` for repeatable presets
- For `once` preset: call `scheduler.scheduleOnce()` instead of `scheduleCron()`

  2.4. **Callback delivery worker** — Create `apps/workflow-engine/src/services/callback-delivery-worker.ts`:

- Constructor: takes Redis connection, `CallbackDeliveryDeps` (with per-tenant secret resolver)
- Creates BullMQ Queue `'workflow-callbacks'` and Worker
- Worker processor:
  1. Resolve HMAC secret: `const secret = await deps.webhookSecret(job.data.tenantId)` (per-tenant from config)
  2. Build signed headers via `buildSignatureHeaders(secret, JSON.stringify(job.data.payload))`
  3. SSRF check on `job.data.callbackUrl`: reject RFC 1918, localhost, link-local, cloud metadata IPs
  4. `fetch(callbackUrl, { method: 'POST', headers: { 'Content-Type': 'application/json', ...signatureHeaders }, body: JSON.stringify(job.data.payload) })`
  5. On success (2xx): update `WorkflowExecution.triggerMetadata.callbackStatus = 'delivered'`
  6. On failure: throw to trigger BullMQ retry (exponential backoff: `{ attempts: 3, backoff: { type: 'exponential', delay: 1000 } }`)
  7. On final failure: update `callbackStatus = 'failed'`, `callbackAttempts = 3`
- Default job options: `{ removeOnComplete: { count: 100 }, removeOnFail: { count: 500 } }` — required by platform BullMQ standards to prevent Redis memory growth
- Worker options: `{ lockDuration: 30000, concurrency: 5 }` — 30s lock allows for HTTP request timeout + retry negotiation. `failParentOnFailure` is N/A (standalone jobs, no flow hierarchy)
- `async shutdown()`: close worker and queue

  2.5. **Workflow handler callback enqueue** — Modify `apps/workflow-engine/src/handlers/workflow-handler.ts`:

- After updating execution status to terminal (lines ~800-814), check if `execution.triggerMetadata?.callbackUrl` exists
- If yes: enqueue job on `workflow-callbacks` queue with `CallbackJobData`
- This requires access to the callback queue — add it to `WorkflowHandlerDeps`

  2.6. **Wire callback worker into engine** — In `apps/workflow-engine/src/index.ts`:

- Create `CallbackDeliveryWorker` instance with Redis and tenant secret resolver
- Add to graceful shutdown sequence
- Pass callback queue reference to workflow-handler deps

  2.7. **Input schema validation** — In `apps/runtime/src/routes/process-api.ts`:

- After verifying workflow is active, check if `workflow.inputSchema` exists (top-level field on Workflow model at `packages/database/src/models/workflow.model.ts:92`, type `Record<string, unknown> | null`)
- If yes: validate `req.body.input` against the schema (Zod or JSON Schema)
- If validation fails: return 400 `SCHEMA_MISMATCH` with validation errors

  2.8. **Unit tests** — Create `apps/workflow-engine/src/__tests__/preset-resolver.test.ts` covering UT-1 (preset-to-cron mapping), UT-2 (timezone validation), UT-3 (cron expression validation), UT-6 (once-schedule delay calculation), UT-7 (preset edge cases — DST, leap year, month overflow).

  2.9. **Integration tests** — Create:

- `apps/workflow-engine/src/__tests__/trigger-scheduler-timezone.test.ts` covering INT-3 (preset → BullMQ with tz), INT-5 (one-shot lifecycle), INT-6 (BullMQ timezone scheduling)
- `apps/workflow-engine/src/__tests__/callback-delivery.test.ts` covering INT-4 (callback delivery with HMAC)

  2.10. **E2E tests** — Create:

- `apps/runtime/src/__tests__/trigger-schedule.e2e.test.ts` covering E2E-7 (schedule CRUD with timezone), E2E-9 (one-shot fires and auto-pauses), SEC-7 (schedule tenant isolation)
- `apps/runtime/src/__tests__/process-api-callback.e2e.test.ts` covering E2E-8 (async with callback URL)

**Files Touched**:

- `apps/workflow-engine/src/services/preset-resolver.ts` — NEW
- `apps/workflow-engine/src/services/callback-delivery-worker.ts` — NEW
- `apps/workflow-engine/src/services/trigger-scheduler.ts` — add tz support, scheduleOnce method
- `apps/workflow-engine/src/services/trigger-engine.ts` — integrate preset-resolver
- `apps/workflow-engine/src/handlers/workflow-handler.ts` — callback enqueue on completion
- `apps/workflow-engine/src/index.ts` — wire callback worker
- `apps/runtime/src/routes/process-api.ts` — add input schema validation
- `apps/workflow-engine/src/__tests__/preset-resolver.test.ts` — NEW
- `apps/workflow-engine/src/__tests__/trigger-scheduler-timezone.test.ts` — NEW
- `apps/workflow-engine/src/__tests__/callback-delivery.test.ts` — NEW
- `apps/runtime/src/__tests__/trigger-schedule.e2e.test.ts` — NEW
- `apps/runtime/src/__tests__/process-api-callback.e2e.test.ts` — NEW

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/workflow-engine` succeeds with 0 type errors
- [ ] UT-1 through UT-3, UT-6, UT-7 pass (preset resolver, timezone, cron, once-schedule, edge cases)
- [ ] INT-3 passes: preset resolves to correct cron with timezone in BullMQ
- [ ] INT-4 passes: callback delivered with valid HMAC, retries on failure
- [ ] INT-5 passes: one-shot fires once and auto-pauses
- [ ] INT-6 passes: BullMQ `tz` option produces correct next-run time
- [ ] E2E-7 passes: schedule CRUD with timezone works end-to-end
- [ ] E2E-8 passes: callback URL receives result with HMAC headers
- [ ] E2E-9 passes: one-shot trigger fires and auto-pauses
- [ ] All Phase 1 tests still pass (no regressions)

**Test Strategy**:

- Unit: Preset-to-cron conversion, timezone validation, cron validation, HMAC signing, SSRF URL blocking
- Integration: BullMQ scheduling with timezone, callback delivery with retry, one-shot lifecycle
- E2E: Full trigger CRUD, callback push, one-shot lifecycle via HTTP API

**Rollback**: Revert trigger-engine.ts and trigger-scheduler.ts changes. Stop callback worker. Orphaned `workflow-callbacks` jobs expire via BullMQ TTL.

---

### Phase 3: Studio UI + External App Catalog (FR-16, FR-19, FR-21 through FR-24)

**Goal**: Deliver Studio UI components for webhook quick start, schedule presets, auto-key creation, and external app catalog.

**Tasks**:

3.1. **External app catalog endpoint** — Create `apps/workflow-engine/src/routes/trigger-catalog.ts`:

- `GET /api/v1/connectors/triggers/catalog` — returns static JSON: `{ categories: [{ name, connectors: [{ name, icon, status: 'planned' }] }] }`
- Wire in `apps/workflow-engine/src/index.ts`

  3.2. **WebhookKeyCreationModal** — Create `apps/studio/src/components/workflows/triggers/WebhookKeyCreationModal.tsx`:

- Props: `{ workflowId, projectId, workflowName, onKeyCreated: (key: { id, rawKey, name }) => void, onClose }`
- On mount: fetch existing keys via `GET /api/settings/api-keys`, then filter client-side for keys where `scopes` includes `'workflow:execute'` AND `projectIds` includes `projectId` AND `revokedAt` is null AND (`expiresAt` is null OR in the future). This filtering is client-side because the existing API keys list endpoint doesn't support scope/project query params — adding a backend filter would require modifying the Settings API, which is out of scope. The client already receives all tenant keys in the list response.
- If matching keys exist: show dropdown with "Or create new key" option
- On create: `POST /api/settings/api-keys` with `{ name: 'Webhook: <workflowName>', scopes: ['workflow:execute'], projectIds: [projectId] }` → capture raw key
- Display raw key once with copy-to-clipboard + warning

  3.3. **CodeSnippets** — Create `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx`:

- Props: `{ workflowId, apiKeyPrefix, baseUrl }`
- Three tabs: Sync / Async / Async+Poll — each with copyable curl command
- API key shown as `abl_****...` with masked display

  3.4. **WebhookQuickStart** — Create `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx`:

- Props: `{ workflow, trigger, apiKey }`
- Shows endpoint URL with copy button
- Embeds `CodeSnippets` component
- Shows API key status badge (active/expired/revoked)
- "Manage API Keys" link to Settings page

  3.5. **SchedulePresetPicker** — Create `apps/studio/src/components/workflows/triggers/SchedulePresetPicker.tsx`:

- Props: `{ value: PresetConfig, onChange: (config: PresetConfig) => void }`
- Preset selector: daily/weekly/monthly/once/cron
- Per-preset fields: time picker (daily/weekly/monthly), day-of-week (weekly), day-of-month (monthly), datetime picker (once), cron expression input (cron)
- Timezone selector: dropdown with IANA timezones (use `Intl.supportedValuesOf('timeZone')`)
- Shows resolved cron preview for user feedback

  3.6. **ExternalAppCatalog** — Create `apps/studio/src/components/workflows/triggers/ExternalAppCatalog.tsx`:

- Fetches from catalog endpoint
- Grid of connector cards grouped by category
- All show "Coming Soon" status badge

  3.7. **Integrate into WorkflowTriggersTab** — Modify `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx`:

- Webhook trigger type: show WebhookKeyCreationModal on enable → WebhookQuickStart after
- Schedule trigger: use SchedulePresetPicker instead of raw cron input
- Add "External Apps" tab section with ExternalAppCatalog
- Persist `config.apiKeyId` when creating webhook trigger (FR-24)
- **SWR invalidation**: Call `mutate()` to revalidate trigger list after trigger creation/deletion, API key list after auto-creation, and workflow data after trigger enablement
- **Loading states**: "Create Key" button disabled during API call with spinner; copy-to-clipboard button shows checkmark feedback on success; "Enable Trigger" button disabled while in-flight

  3.8. **`workflow:execute` scope in Settings** — In the API Keys creation UI (`apps/studio/src/components/settings/ApiKeysPage.tsx`), add `workflow:execute` to the available scopes dropdown/checkbox list.

  3.9. **E2E + security tests** — Create tests covering E2E-11 (auto-create API key on webhook enable), E2E-12 (catalog endpoint returns categories), INT-7 (auto-key creation with reuse detection). Security tests SEC-1 through SEC-8 are covered across Phase 1 E2E tests (SEC-1/2/3/4/5/6 map to E2E-3/4/6/10), Phase 2 E2E tests (SEC-7 maps to `trigger-schedule.e2e.test.ts` tenant isolation), and existing trigger route integration tests (SEC-8 — project-scoped trigger management is already enforced by the existing trigger CRUD routes which filter by projectId).

  3.10. **i18n setup** — All 5 new Studio components must use i18n for user-visible strings. Add translation keys to `packages/i18n/locales/en/studio.json` under a `workflowTriggers` namespace. Key categories: button labels ("Create Key", "Copy", "Reveal", "Enable Trigger"), warnings ("This key will not be shown again"), status badges ("Active", "Expired", "Revoked", "Coming Soon"), preset labels ("Daily", "Weekly", "Monthly", "Once", "Custom Cron"), tab names. Components use `useTranslation('studio')` and access keys via `t('workflowTriggers.<key>')`. Note: existing `WorkflowTriggersTab.tsx` has no i18n — this introduces it for the first time in workflow trigger UI.

**Files Touched**:

- `apps/workflow-engine/src/routes/trigger-catalog.ts` — NEW
- `apps/workflow-engine/src/index.ts` — wire catalog route
- `apps/studio/src/components/workflows/triggers/WebhookKeyCreationModal.tsx` — NEW
- `apps/studio/src/components/workflows/triggers/CodeSnippets.tsx` — NEW
- `apps/studio/src/components/workflows/triggers/WebhookQuickStart.tsx` — NEW
- `apps/studio/src/components/workflows/triggers/SchedulePresetPicker.tsx` — NEW
- `apps/studio/src/components/workflows/triggers/ExternalAppCatalog.tsx` — NEW
- `apps/studio/src/components/workflows/tabs/WorkflowTriggersTab.tsx` — integrate new components
- `apps/studio/src/components/settings/ApiKeysPage.tsx` — add `workflow:execute` scope option

**Exit Criteria**:

- [ ] `pnpm build --filter=@abl/studio` succeeds with 0 type errors
- [ ] `pnpm build --filter=@abl/workflow-engine` succeeds with 0 type errors
- [ ] E2E-11 passes: webhook trigger enable auto-creates API key with correct scope/projectIds
- [ ] E2E-12 passes: catalog endpoint returns expected categories and connector list
- [ ] All Phase 1 and Phase 2 tests still pass (no regressions)
- [ ] Component render test: WebhookQuickStart renders endpoint URL, 3 curl snippet tabs, key status badge
- [ ] Component render test: SchedulePresetPicker renders all 5 preset types with correct per-preset fields
- [ ] Component render test: ExternalAppCatalog renders grid with 6 categories and correct connector count
- [ ] Manual smoke test (not gated): visual verification of component layout and interactions in browser

**Test Strategy**:

- E2E: Auto-key creation flow, catalog endpoint
- Manual: Visual verification of UI components (Quick Start panel, preset picker, catalog grid)

**Rollback**: Revert Studio component changes. Backend catalog endpoint is harmless (static data).

---

## 4. Wiring Checklist

- [ ] `sync-execution.ts` — imported and instantiated in `server.ts` with dedicated Redis subscriber connection
- [ ] `process-api.ts` routes — mounted in `server.ts` via `app.use('/api/v1/process', authMiddleware, router)`
- [ ] `process-api.ts` — receives `SyncExecutionService` and `engineBaseUrl` as constructor deps
- [ ] `preset-resolver.ts` — imported by `trigger-engine.ts` (direct import, no DI — pure functions)
- [ ] `trigger-scheduler.ts` — `scheduleCron()` updated to accept and pass `tz` option
- [ ] `trigger-scheduler.ts` — `scheduleOnce()` new method added and called by `trigger-engine.ts`
- [ ] `callback-delivery-worker.ts` — instantiated in `apps/workflow-engine/src/index.ts` with Redis + deps
- [ ] `callback-delivery-worker.ts` — callback queue reference passed to workflow-handler deps
- [ ] `workflow-handler.ts` — on terminal execution status, checks `triggerMetadata.callbackUrl` and enqueues job
- [ ] `trigger-catalog.ts` — route mounted in `apps/workflow-engine/src/index.ts`
- [ ] `WorkflowExecution` model — `triggerMetadata` field added as `Schema.Types.Mixed`, interface updated
- [ ] `ExecutionStore.createExecution()` — accepts and persists `triggerMetadata` from input
- [ ] `workflow-handler.ts` — threads `triggerMetadata` from `startWorkflow` input to `createExecution()` call
- [ ] `TriggerRegistration` model — `connectorName`/`connectionId` changed to optional
- [ ] Studio components — all imported and rendered in `WorkflowTriggersTab.tsx`
- [ ] `workflow:execute` scope — added to Settings API Keys UI scope options
- [ ] Graceful shutdown — `SyncExecutionService.shutdown()` and `CallbackDeliveryWorker.shutdown()` called on SIGTERM

---

## 5. Cross-Phase Concerns

### Database Migrations

No formal migrations needed. All changes are additive:

- `connectorName`/`connectionId` become optional (Mongoose schema change only)
- New `config` subfields are stored in existing `Mixed` type `config` field
- New `triggerMetadata` subfields are stored in existing `Mixed` type

### Feature Flags

None. All changes are additive route mounts and schema extensions. Rollback = route unmount.

### Configuration Changes

| Variable                      | Default | Phase | Description                                        |
| ----------------------------- | ------- | ----- | -------------------------------------------------- |
| `PROCESS_API_SYNC_TIMEOUT_MS` | `30000` | 1     | Max wait time for sync execution before auto-async |
| `CALLBACK_MAX_RETRIES`        | `3`     | 2     | Max retry attempts for callback delivery           |
| `CALLBACK_RETRY_BASE_MS`      | `1000`  | 2     | Base delay for exponential backoff                 |

### Tenant Webhook Secret Resolution

Per user decision (D-8), the HMAC signing secret for callback webhooks is per-tenant from tenant config. The callback delivery worker resolves the secret via a `webhookSecret(tenantId)` function that reads from the tenant configuration. If the tenant has no configured secret, generate one via `generateWebhookSecret()` from `packages/shared-kernel/src/security/webhook-signature.ts` and store it in tenant config. This is a lazy-initialization pattern — secrets are created on first callback delivery, not on tenant creation.

---

## 6. Acceptance Criteria (Whole Feature)

- [ ] All 24 FRs implemented with correct behavior
- [ ] All 13 E2E test scenarios passing (E2E-1 through E2E-13)
- [ ] All 10 integration test scenarios passing (INT-1 through INT-10)
- [ ] All 7 unit test suites passing (UT-1 through UT-7)
- [ ] No regressions in existing tests (`pnpm build && pnpm test`)
- [ ] Feature spec updated with implementation details via `/post-impl-sync`
- [ ] Testing matrix updated with actual coverage
- [ ] Feature status transitioned to ALPHA
- [ ] `agents.md` updated for all touched packages
- [ ] 5 audit rounds completed with no CRITICAL findings

---

## 7. Open Questions

1. **UUIDv7 for executionId**: RESOLVED. Use `uuidv7()` from `@agent-platform/database` to match the existing `WorkflowExecution` model's `_id` generator. This maintains sort-order consistency across all execution records.

2. **Tenant webhook secret storage location**: The secret is per-tenant from config — but which config document exactly? Options: `TenantSettings` model (if it exists), a new field on the `Tenant` model, or a dedicated secrets collection. **Decision needed during Phase 2 implementation — investigate existing tenant config patterns.**

3. **Process API rate limiting**: Currently uses tenant-level rate limiting. If a single API key makes excessive requests, it affects all tenant users. Per-key rate limiting is deferred (GAP-001 in feature spec) but should be tracked.
