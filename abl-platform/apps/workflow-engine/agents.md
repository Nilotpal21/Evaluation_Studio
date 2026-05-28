# agents.md — apps / workflow-engine

Agent learning journal for this package. Append-only log of architectural decisions, patterns, gotchas, and insights discovered during SDLC work.

Agents MUST read this file before modifying code in this package. Agents MUST append learnings after completing work.

---

<!-- Append new entries below this line. Format:
## <DATE> — <Feature/Context>
**Category**: architecture | testing | pattern | gotcha | process
**Learning**: <what was learned — specific and actionable>
**Files**: <key files involved>
**Impact**: <how this affects future work in this package>
-->

## 2026-03-24 — Workflow Triggers HLD

**Category**: architecture
**Learning**: The execute endpoint (`POST /execute`) must be extended to accept an optional `executionId` parameter. When the Process API (runtime) provides an executionId, workflow-engine uses it instead of generating one via `crypto.randomUUID()`. This enables runtime to subscribe to the Redis Pub/Sub completion channel BEFORE starting the workflow, eliminating the subscribe-before-start race condition. Existing internal callers (Studio, manual triggers) are unaffected — they omit executionId and the engine generates one as today.
**Files**: `src/routes/workflow-executions.ts`, `src/trigger-engine.ts`, `src/trigger-scheduler.ts`
**Impact**: Any future caller that needs to know the executionId before workflow start should generate and pass it. The Pub/Sub channel format is `workflow:{tenantId}:execution:{executionId}:status`.

**Category**: architecture
**Learning**: Redis Pub/Sub completion events on `workflow:{tenantId}:execution:{executionId}:status` carry both step-level events (via `WorkflowRedisPublisher.publishStepStatus()`) and workflow-level terminal events. Consumers must filter for `type: 'workflow.completed' | 'workflow.failed' | 'workflow.cancelled'` and ignore step-level updates. The completion event is notification-only — no result payload. Consumers must fetch the result from MongoDB after receiving the notification.
**Files**: `src/workflow-handler.ts`, `src/services/workflow-redis-publisher.ts`
**Impact**: Any new consumer of the completion channel must implement event type filtering and a subsequent MongoDB fetch for results.

**Category**: architecture
**Learning**: Callback webhook delivery uses a separate BullMQ queue (`workflow-callbacks`) from scheduling (`workflow-triggers`). The callbackUrl flows: Process API request → `triggerMetadata.callbackUrl` → persisted on `WorkflowExecution` → workflow-handler checks on completion → enqueues BullMQ job with HMAC-SHA256 signing. 3 retries with exponential backoff.
**Files**: `src/workflow-handler.ts` (completion check), new `src/workers/callback-delivery-worker.ts` (planned)
**Impact**: The callback queue needs its own worker process registration and monitoring. Rollback requires draining/obliterating the `workflow-callbacks` queue.

## 2026-04-14 — Engine To Runtime Calls Must Use Service JWTs

**Category**: architecture
**Learning**: Workflow-engine should call Runtime internal APIs with a short-lived service JWT minted from the verified tenant and project scope, not by forwarding end-user auth headers or raw tenant headers. Runtime internal routes extract scope from the verified token and reject project mismatches.
**Files**: `src/index.ts`, `apps/runtime/src/server.ts`, `apps/runtime/src/middleware/internal-service-auth.ts`
**Impact**: Any new engine-to-runtime integration must mint a service token and send scope in the request body, or it will fail auth or reopen spoofable trust boundaries.

## 2026-04-14 — `POST /execute` Must Validate Correlation IDs And Strip Callback Sinks

**Category**: gotcha
**Learning**: The manual execute route may accept a caller-supplied `executionId`, but only as a valid UUID. It also explicitly deletes `triggerMetadata.callbackUrl` on manual runs so only trigger-owned entry points can register async callback destinations.
**Files**: `src/routes/workflow-executions.ts`
**Impact**: New execution entry points need explicit boundary validation and sanitization or they reopen subscribe-before-start and output-exfiltration bugs.

## 2026-04-14 — Express API And Restate Endpoint Are Different Surfaces

**Category**: architecture
**Learning**: Workflow-engine serves the developer-facing HTTP API on port `9080`, while the Restate service endpoint runs separately on `9081` and is what gets registered with Restate admin. Runtime and Studio should talk to `9080`, not the Restate endpoint.
**Files**: `src/index.ts`, `src/constants.ts`
**Impact**: Local setup docs, E2E harnesses, and debugging should keep the API port and Restate endpoint distinct before chasing auth or routing issues.

## 2026-03-24 — Workflow Triggers LLD

**Category**: gotcha
**Learning**: `triggerMetadata` does NOT currently exist as a field on the `WorkflowExecution` model. It must be added as `{ type: Schema.Types.Mixed, default: {} }`. The `ExecutionPersistence` interface (workflow-handler.ts lines 76-85) and `ExecutionStore.createExecution()` must both be updated to accept and persist it. The `createExecution()` call at line ~378 of workflow-handler.ts must thread `triggerMetadata` from the `startWorkflow` input.
**Files**: `src/handlers/workflow-handler.ts`, `src/persistence/execution-store.ts`, `packages/database/src/models/workflow-execution.model.ts`
**Impact**: Any feature that needs queryable trigger context on executions must use this new field.

**Category**: architecture
**Learning**: The preset resolver (`preset-resolver.ts`) is a pure function module — no class, no state. It converts user-friendly presets (daily/weekly/monthly/once/cron) to BullMQ-compatible `{ cronExpression, tz }` or `{ delay, tz }`. The `cron-parser` npm package is used for cron validation. One-shot (`once`) presets use `scheduler.scheduleOnce()` with a delay instead of `scheduleCron()`.
**Files**: new `src/services/preset-resolver.ts` (planned), `src/services/trigger-scheduler.ts`
**Impact**: The existing `TriggerScheduler` needs two additions: `tz` parameter in `scheduleCron()` and new `scheduleOnce()` method. Also needs `removeOnComplete`/`removeOnFail` added to existing job options (currently missing).

## 2026-04-07 — Workflow Context & Output Enhancements

**Category**: architecture
**Learning**: The expression resolver (`expression-resolver.ts`) now supports a `context.` prefix. `{{context.steps.API0001.output.body}}` strips the prefix before resolving. Unknown top-level keys (e.g., `context.myCustomVar`) fall through to `ctx.vars.myCustomVar`. The `WorkflowStepData` interface was extracted with optional `output`/`status` to support spread patterns in `setStepContext`.
**Files**: `src/context/expression-resolver.ts`
**Impact**: All existing expressions without the `context.` prefix still work. New expressions can use either form.

**Category**: architecture
**Learning**: Steps are now indexed in `ctx.steps` by **both UUID and node name**. `setStepContext()` writes to both `ctx.steps[step.id]` and `ctx.steps[step.name]`. The name comes from `(step as any).name` which `canvas-to-steps.ts` attaches during conversion. This enables `{{context.steps.API0001.output.body}}` without knowing the UUID.
**Files**: `src/handlers/workflow-handler.ts`, `src/handlers/canvas-to-steps.ts`
**Impact**: `Object.keys(ctx.steps)` now includes both UUIDs and names — tests checking step count must account for this doubling plus the synthetic `start` entry.

**Category**: architecture
**Learning**: The execute endpoint (`POST /execute`) now polls for completion (up to 30s) and returns `{ success, executionId, startTime, endTime, output, status }` synchronously. If the workflow takes longer than 30s, it falls back to async 202 response. Output is resolved from the end node's `outputMapping` config (Studio `EndNodeConfig.tsx` uses `Record<string, string>` format, converted to `OutputMapping[]` in `canvas-to-steps.ts`).
**Files**: `src/routes/workflow-executions.ts`, `src/handlers/workflow-handler.ts`, `src/handlers/canvas-to-steps.ts`
**Impact**: Callers can now get results in a single POST call. The `CanvasConversionResult` type exposes `nameToIdMap`, `outputMappings`, and `startInputVariables` for the handler.

**Category**: gotcha
**Learning**: A synthetic "Start" step (`stepId: 'start'`, `name: 'Start'`, `type: 'start'`) is prepended to `nodeExecutions` in the persistence layer so the debug panel shows workflow input. `ctx.steps['start']` is populated in `buildWorkflowContext()` with `input: triggerPayload`. The step type `'start'` is not in the `WorkflowStep` union — the step records array must be typed as `Array<{stepId: string; name: string; type: string; status: string}>` to avoid TS errors.
**Files**: `src/handlers/workflow-handler.ts`, `src/persistence/execution-store.ts`
**Impact**: Tests that check `createExecution` mock calls or step counts must account for the extra start record.

**Category**: gotcha
**Learning**: Node name uniqueness is enforced at two levels: (1) Studio store `updateNodeName` silently rejects duplicate names, (2) execution route validates unique names server-side and returns 400 `DUPLICATE_NODE_NAMES`. The `useWorkflowValidation` hook already flags duplicates as errors in the UI.
**Files**: `apps/studio/src/store/workflow-canvas-store.ts`, `src/routes/workflow-executions.ts`
**Impact**: Workflows with duplicate node names cannot be executed.

**Category**: gotcha
**Learning**: The workflow-engine runs in Docker, not via `pnpm dev:workflows`. After any code change in `apps/workflow-engine/src/`, you must: (1) `pnpm build`, (2) `docker compose build workflow-engine`, (3) `docker compose up -d workflow-engine`. The container takes ~40s to become healthy. `pnpm dev:workflows` only starts Studio (5173) + Runtime (3112) with hot-reload.
**Files**: `docker-compose.yml`, `apps/workflow-engine/Dockerfile`
**Impact**: Every agent working on workflow-engine code must follow the Docker rebuild cycle to verify changes live.

## 2026-04-13 — Workflow-as-Tool Phase 5: INT-6 Execution Isolation

**Category**: testing
**Learning**: INT-6 (`executions-isolation.integration.test.ts`) tests tenant/project isolation on the execution GET and list endpoints. Uses in-memory execution store via DI (same pattern as existing integration tests). Creates Express app per test context with middleware injecting `tenantId`/`projectId`. Cross-tenant and cross-project access returns 404.
**Files**: `src/__tests__/executions-isolation.integration.test.ts`
**Impact**: Future isolation tests can follow this DI pattern — no MongoMemoryServer needed, just inject a fake store.

**Category**: gotcha
**Learning**: New integration test files must be added to `vitest.http.config.ts` includes AND `vitest.fast.config.ts` excludes. Otherwise vitest won't find the test in any tier.
**Files**: `vitest.http.config.ts`, `vitest.fast.config.ts`
**Impact**: Always update both config files when adding new integration test files.

## 2026-04-14 — Workflow Async Completion

**Category**: architecture
**Learning**: When `triggerMetadata.source === 'agent_tool'`, the `CallbackDeliveryWorker` must use `INTERNAL_CALLBACK_SECRET` (env var) instead of the tenant's webhook secret. This is because internal callbacks go to the runtime's `/api/internal/workflow-callback` endpoint which verifies against the shared internal secret, not the per-tenant secret.
**Files**: `src/services/callback-delivery-worker.ts`, `src/index.ts`
**Impact**: Future internal callback consumers must use the same `INTERNAL_CALLBACK_SECRET` mechanism.

**Category**: gotcha
**Learning**: The callback payload should NOT include `result: ctx.steps` — this field can be arbitrarily large (contains all intermediate step outputs) and may exceed Express body-parser limits. The `output` field (declared workflow outputs only) is sufficient.
**Files**: `src/handlers/workflow-handler.ts`
**Impact**: Never include unbounded step data in callback payloads — use declared outputs only.

## 2026-04-15 — Workflow Versioning: Trigger Engine Changes

**Category**: architecture
**Learning**: Key patterns for version-aware trigger binding in workflow-engine:

1. **Version-first binding** — `fireWebhookTrigger()` in `src/services/trigger-engine.ts` now resolves workflow definition via `workflowVersionId` on the trigger registration first. Falls back to deployment resolution, then working copy, for Phase 1 backward compatibility.
2. **`environmentsMatch()` predicate** — exported from trigger-engine for testability. Uses strict equality including both-null matching: an event fires a trigger only when both environments are equal (including both being `null`).
3. **`strategy` → `triggerType` mapping** — legacy trigger registration data uses `strategy` field; new model uses `triggerType`. The `VERSION_INACTIVE` guard in `processJob()` checks version state before executing.
   **Files**: `src/services/trigger-engine.ts`, `src/services/trigger-scheduler.ts`, `src/__tests__/trigger-fire-resolution.test.ts`, `src/__tests__/trigger-environment.test.ts`
   **Impact**: Future trigger changes must maintain the version-first → deployment → working-copy fallback chain during Phase 1. When Phase 2 cleanup removes the fallback chain, remove the backward-compat code paths.

## 2026-04-15 — GAP-004: Cron Job Data Version/Environment Threading

**Category**: gotcha
**Learning**: `TriggerEngine.register()` and `resume()` were building `jobData` for BullMQ cron jobs WITHOUT including `workflowVersionId` or `environment`, even though the `TriggerJobData` interface had optional fields for both and `processJob()` checked `job.data.workflowVersionId`. This made the version resolution in the scheduler dead code for cron triggers, and caused environment-gated triggers to be silently skipped (because `environmentsMatch(undefined, 'production')` returns `false`). Fixed by spreading both fields from the trigger registration into jobData.
**Files**: `src/services/trigger-engine.ts` (register at ~line 150, resume at ~line 287)
**Impact**: Any future code that builds jobData for BullMQ trigger jobs MUST include `workflowVersionId` and `environment` from the registration. The scheduler's `processJob()` relies on job data for version resolution, not on re-reading the registration document.

## 2026-04-16 — Data-Flow Audit: Silent Field Drops

**Category**: gotcha
**Learning**: Mongoose `strict: true` (default) silently strips fields from `$set`/`$setOnInsert` that are not in the schema. Found `cancelledAt`, `approvalDecision/DecidedBy/DecidedAt/Reason`, `webhookMode`, `webhookDelivery`, and `workflowVersion` all being written by route handlers but dropped by the DB.
**Files**: `src/routes/workflow-executions.ts` (cancel route), `src/routes/workflow-approvals.ts` (approve route), `src/persistence/execution-store.ts`, `src/handlers/workflow-handler.ts`
**Impact**:

- Always verify new fields appear in both the TypeScript interface AND the Mongoose schema definition.
- When an interface (`ExecutionPersistence`) and its implementation (`ExecutionStore`) define `createExecution()` input as duplicate inline types, both must be updated. Prefer a shared type to avoid drift.
- Barrel exports (`routes/index.ts`) should include ALL routers — `createHumanTaskResolutionRouter` was mounted in `start()` via direct import but missing from the barrel.

## 2026-04-17 — Callback Route System E2E (HMAC + Raw Body)

**Category**: testing
**Learning**: The async-webhook callback route (`POST /workflows/callbacks/:eid/:sid`) enforces three boundary guards — HMAC signature, replay timestamp, and `waiting_callback` step status. A system-level E2E for this route needs three things that route-integration tests with mocked models cannot provide:

1. **Raw-body capture in the test Express app.** The HMAC check reads `(req as any).rawBody`, set by `express.json({ verify: captureRawBody })`. The test harness must mirror `src/index.ts` line 116-120:

   ```ts
   const captureRawBody = (req, _res, buf) => {
     (req as any).rawBody = buf;
   };
   app.use(express.json({ limit: '1mb', verify: captureRawBody }));
   ```

   Otherwise every signed request fails at "missing body" instead of exercising the HMAC path.

2. **Passthrough decrypt stub.** The route calls `deps.decryptSecret(step.callbackSecret, tenantId)`. In tests, store the secret in plain form and pass `async (s) => s`. The HMAC is then computed against the same value the route reads — no real crypto setup needed.

3. **Seed `nodeExecutions[]` subdocs carefully.** Mongoose sub-schemas distinguish "field absent" from "field explicitly undefined". To test "no callbackSecret configured" (401 branch), build the step doc conditionally: `if (!omitSecret) stepDoc.callbackSecret = SECRET;`. Passing `callbackSecret: undefined` is **not** equivalent — the ternary `x === undefined ? FALLBACK : x` trap bit once.

See `src/__tests__/system-callback.test.ts` for the full 11-scenario reference (happy path, 4 auth-header branches, replay, 503 transactional integrity).
**Files**: `src/__tests__/system-callback.test.ts`, `src/routes/workflow-callbacks.ts`, `src/constants.ts` (CALLBACK_REPLAY_TOLERANCE_MS)
**Impact**: Any new route that uses `(req as any).rawBody` must ship a system test with the matching body-parser setup. Any boundary that inspects an optional Mongoose subdoc field should have a test that asserts the "field absent" case separately from "field present but falsy".

## 2026-04-17 — System-Level HTTP E2E Pattern for Route Handlers

**Category**: testing
**Learning**: Engine-side HTTP E2E for a route handler lives in `src/__tests__/system-*.test.ts` and runs under `vitest.system.config.ts` (invoked via `pnpm test:system`). The pattern combines `helpers/setup-mongo.ts` (MongoMemoryServer + Mongoose) with supertest against an `express()` app built on top of `createWorkflowExecutionRouter(...)` / equivalent, passing real Mongoose models (e.g., `Workflow`, `WorkflowVersion`) as deps and stubbing only external side-effects (Restate client, Redis publisher). This catches schema-level bugs that mocked-model route-integration tests miss: soft-delete filters (`deleted: { $ne: true }`), unique indexes, UUIDv7 `_id` generation, tenant-isolation plugin behavior. Each test should call `requireMongo(skip)` first so the suite is skippable when the MongoMemoryServer binary is unavailable. Use `afterEach(clearCollections)` — not `beforeEach` — to avoid cross-contamination when a test itself seeds mid-body. See `system-execute-version.test.ts` (GAP-11 closer) for a reference implementation.
**Files**: `src/__tests__/system-execute-version.test.ts`, `src/__tests__/helpers/setup-mongo.ts`, `vitest.system.config.ts`
**Impact**: Use this tier for new route handlers that touch real Mongo — do NOT add them to `vitest.http.config.ts` (that tier keeps models mocked for speed). Tests in the system tier are opt-in: they run via `pnpm test:system`, not the default `pnpm test`. When adding schema-touching behavior (new plugins, new indexes, new soft-delete flags), mirror the assertions in a system test so future refactors catch index/plugin regressions.

## 2026-04-17 — /execute Honors Active Workflow Version

**Category**: architecture
**Learning**: `POST /execute` now resolves the workflow version before starting Restate, with precedence: explicit `workflowVersionId` → active version → draft. The schema previously accepted `workflowVersionId` but only annotated the execution record — the handler always loaded the draft `Workflow` doc. Now the handler consults the `WorkflowVersion` collection:

- Explicit `workflowVersionId` → load `WorkflowVersion` (scoped by `workflowId`/`tenantId`/`projectId`, excluding soft-deleted). Miss returns 404 `WORKFLOW_VERSION_NOT_FOUND` — no silent fall-back to draft.
- No `workflowVersionId` → look up `state: 'active'` version for this workflow. When present, use its `definition.nodes`/`edges` (mirrors `trigger-engine.ts` version-first binding).
- No active version → fall back to the `Workflow` draft (preserves behavior for first-time / never-published workflows).

Studio's run button sends no `workflowVersionId`, so it naturally lands on the active-version branch — clicking Run tests whatever version is live, not the canvas draft. The resolved `workflowVersionId` + `workflowVersion` are forwarded to `restateClient.startWorkflow`, so the execution record is annotated with the version that actually ran.
**Files**: `src/routes/workflow-executions.ts` (new `WorkflowVersionModel` interface + resolution block), `src/index.ts` (wires `WorkflowVersion` into `createWorkflowExecutionRouter` deps)
**Impact**: Any new caller of `/execute` that needs the draft explicitly must either pin a draft-specific `workflowVersionId` or accept active-if-exists semantics. Tests that previously mocked only `workflowModel` continue to pass (missing `workflowVersionModel` ⇒ draft path); tests that want the active or pinned branch must add a `workflowVersionModel` mock returning a `{ _id, version, definition: { nodes, edges } }` doc. When the version path is used, `definition.nodes`/`edges` run through `convertCanvasToSteps`; do not read `definition.steps` directly.

## 2026-04-18 — Workflow Webhook Versioning Phase 3: Engine Semver-String Resolver

**Category**: architecture
**Learning**: `POST /execute` now has a 3-branch version resolution with this precedence: (1) explicit `workflowVersionId` → load by `_id`; (2) `workflowVersion` (semver string) without `workflowVersionId` → load by `{ workflowId, version, tenantId, projectId, deleted: { $ne: true } }` — state-agnostic; (3) default → find active version, fall back to draft. The semver branch error uses a static message (`'Requested workflow version not found'`) to avoid leaking user input into error bodies.
**Files**: `src/routes/workflow-executions.ts`
**Impact**: Phase 5 will add a semver-desc sort to the default branch (3). The semver branch (2) is intentionally state-agnostic — it resolves inactive, active, and draft versions as long as they are not soft-deleted.

**Category**: testing
**Learning**: Engine tests that use MongoMemoryServer MUST be named `system-*.test.ts` to be picked up by `vitest.system.config.ts`. The fast tier (`vitest.fast.config.ts`) excludes `system-*` files, and the HTTP tier (`vitest.http.config.ts`) uses an explicit include list. Adding a Mongo-backed test without the `system-` prefix causes it to run in the fast tier (threads pool) where Mongoose connections may conflict, or not run at all if accidentally excluded.
**Files**: `src/__tests__/system-executions-semver.test.ts`, `vitest.system.config.ts`, `vitest.fast.config.ts`
**Impact**: Always use the `system-` prefix for tests needing MongoMemoryServer. If the test only needs Express supertest without real Mongo, add it to the HTTP tier's explicit include list instead.

## 2026-04-18 — Workflow Webhook Versioning Phase 5: Semver-Desc Default Resolution

**Category**: architecture
**Learning**: The default branch in `POST /execute` now uses `find({state:'active', deleted:{$ne:true}, version:{$ne:'draft'}}).lean()` + client-side `compareSemverDesc()` sort instead of `findOne({state:'active'})`. This ensures deterministic resolution to the highest-semver active version. The `WorkflowVersionModel` interface was extended with a `find()` method (returning `{lean(): Promise<Doc[]>}`); `findOne` is still used by the explicit-pin and semver-string-pin branches.
**Files**: `src/routes/workflow-executions.ts`, `src/lib/semver-compare.ts`
**Impact**: Any new consumer of `WorkflowVersionModel` must provide both `findOne` and `find` in DI mocks. The `compareSemverDesc` helper lives in `src/lib/semver-compare.ts` — it strips leading `v`, treats `'draft'` as LAST, delegates to `semver.rcompare()`.

**Category**: gotcha
**Learning**: When extending a DI interface (e.g. adding `find` to `WorkflowVersionModel`), ALL existing mock sites in route-integration tests must be updated — even mocks for code paths that don't use the new method. TypeScript demands interface completeness. In Phase 5, 4 mock sites in `workflow-executions-routes.test.ts` needed updating.
**Files**: `src/__tests__/workflow-executions-routes.test.ts`
**Impact**: After any DI interface change, grep all test files for the interface name and update every mock site.

**Category**: architecture
**Learning**: The engine now emits `workflow.version.resolution.miss` (via `createLogger`) when the default branch falls through to draft. This provides observability parity with runtime's `workflow-version-service.ts` which already emitted this metric. The logger is created as `createLogger('workflow-engine:executions')` at module scope in `workflow-executions.ts`.
**Files**: `src/routes/workflow-executions.ts`
**Impact**: Log monitoring dashboards should watch for `workflow.version.resolution.miss` events from both `workflow-version-service` (runtime) and `workflow-engine:executions` (engine).

## 2026-04-15 — Dynamic Dropdown Resolver Endpoint

**Category**: architecture
**Learning**: The dynamic dropdown options endpoint lives on the existing `/connectors` router even though it operates on project-scoped data. The connector catalog routes are flat (not under `/projects/:projectId/...`), and splitting the new POST across two mount points for URL consistency would fragment `createConnectorRouter`. Instead, `projectId` travels in the POST body alongside `connectionId`. Route: `POST /api/v1/connectors/:connectorName/actions/:actionName/props/:propName/options`. Tenant still comes from `(req as any).tenantContext?.tenantId` via auth middleware.
**Files**: `src/routes/connectors.ts`, `src/index.ts` (registration site)
**Impact**: Future project-scoped operations on the catalog surface should follow the same pattern (projectId in body) rather than adding a parallel project-scoped connector router.

**Category**: pattern
**Learning**: `ConnectorRouteDeps.connectionResolver` is optional — the catalog GET endpoints work without it and tests that only exercise listing don't need to stub a resolver. Missing resolver produces a 501 `NOT_IMPLEMENTED` on the POST instead of crashing at mount time. Error codes from `DropdownOptionsServiceError` map to HTTP via a dedicated `errorCodeToStatus()` helper (404 for all NOT_FOUND-family codes, 502 for RESOLVE_FAILED — an upstream-dependency failure, not our bug).
**Files**: `src/routes/connectors.ts`, `src/__tests__/connectors-routes.test.ts`
**Impact**: Keep the optional-dep pattern for any future route that combines read-only and resource-dependent endpoints. 502 vs 500 distinction matters: Studio can show "SaaS API returned an error" differently from "our server is broken."

## 2026-04-19 — Trigger-engine semver-desc fallback (GAP-009)

**Category**: architecture
**Learning**: `TriggerEngine.fireWebhookTrigger()` now runs a 3-tier version resolution: (1) pinned `workflowVersionId` on the trigger registration, (2) deployment-manifest match for the trigger's environment, (3) **highest-semver active non-draft non-deleted WorkflowVersion** via `workflowVersionModel.find({...})` + `compareSemverDesc`. Only if all three miss does the engine fall back to the workflow's working-copy steps/canvas. This closes the gap where legacy trigger registrations (created before workflow versioning shipped, with `workflowVersionId: undefined` and no deployment) silently executed the draft instead of the published build — violated FR-8. The new tier uses the canonical `compareSemverDesc` re-exported from `packages/shared-kernel` (via `src/lib/semver-compare.ts`).
**Files**: `src/services/trigger-engine.ts`, `src/lib/semver-compare.ts`, `src/__tests__/trigger-fire-resolution.test.ts`
**Impact**: Any new trigger-fire path (event triggers, connector-trigger passthrough) that needs to resolve an unpinned workflow must use the same 3-tier precedence. The `workflowVersionModel.find` method was added as an **optional** property on the deps interface so existing test doubles that only mock `findOne` continue to compile and continue to hit the working-copy fallback; new tests that exercise the semver branch must provide a `.find()` implementation returning `{lean(): Promise<Doc[]>}`.

**Category**: gotcha
**Learning**: When extending a DI interface with a new method, mark it **optional** (`find?:`) if any in-tree test stubs only provide a subset — changing it to required breaks compilation of every test file that uses `as any` stubs. Runtime guard the call with `this.deps.workflowVersionModel?.find` so the behaviour gracefully falls through to working-copy in test configs that don't supply it.
**Files**: `src/services/trigger-engine.ts` (deps interface)
**Impact**: The 3-package commit-scope guard makes "update every mock site in the same commit" impractical for broadly-used deps. Prefer optional methods + runtime guards over required methods + mass test-stub updates.

## 2026-04-19 — compareSemverDesc consolidated into shared-kernel

**Category**: pattern
**Learning**: `src/lib/semver-compare.ts` is now a thin re-export from `@agent-platform/shared-kernel`. Do NOT restore a local implementation here — LD-5's "per-app prod dep, 2 consumers, no propagation cost" rationale from the 2026-04-18 LLD was reversed once dedupe was contained to 3 packages. Both runtime and workflow-engine funnel through `packages/shared-kernel/src/utils/semver-compare.ts`. The `semver` npm package dep in `apps/workflow-engine/package.json` is no longer reached by this path, but it remains a direct dep because other engine code (e.g. version range parsing in deployment manifests) still uses it.
**Files**: `src/lib/semver-compare.ts`
**Impact**: Any new semver comparison in this package should import from the local `lib/semver-compare.ts` re-export — keeps the import surface stable if we ever move the dedupe again.

## 2026-04-19 — Canonical cron config + scheduler-absent visibility (GAP-008/009)

**Category**: pattern
**Learning**: `TriggerEngine.register()` now resolves preset/cronExpression into a canonical expression once and writes it to BOTH `config.cronExpression` (primary) and legacy top-level `cronExpression` via a single `findOneAndUpdate` $set. `resume()` reads `config.cronExpression` first, with a fallback to `trigger.cronExpression` for legacy records. This closes the "Schedule not configured" UI bug where preset-only registrations never materialised into a canonical expression, plus the `resume()`-on-boot bug that re-ran the preset resolver on every restart. Preset-resolution errors are caught (not thrown) — the trigger still persists so the user can fix and resume. Cron triggers registered without a BullMQ scheduler (`deps.scheduler === undefined`) are persisted with an explicit `log.warn` — previously they silently no-fired. Matching warn in `resume()` catches legacy cron records booted on a scheduler-less deployment.
**Files**: `src/services/trigger-engine.ts`
**Impact**: Future cron-trigger code should always read `config.cronExpression` first (falling back to `trigger.cronExpression` only for legacy records); never re-run preset resolution at read time. Any new trigger type that depends on external infrastructure (scheduler, Kafka, etc.) should follow the same "persist + warn when infra is absent" pattern instead of silent no-op.

## 2026-04-19 — Output convention `_state` → `_status`

**Category**: pattern
**Learning**: The workflow handler's terminal output contract is now `{ _status: 0 }` on success and `{ _status: 1, _reason }` on failure. Renamed from `_state` to avoid overloading against the execution-level `status` field and to match the Studio `StatusReasonBanner`. Guarded by `workflow-output-status-convention.test.ts` (success, failure via thrown HTTP step, and persistence-payload propagation). Any future rename here must update: (a) `buildFailureOutput`, (b) the success-path `resolvedOutput` seed in `runWorkflow`, (c) Studio `StepLogItem.tsx`'s `StatusReasonBanner`, and (d) the regression test in the same commit.
**Files**: `src/handlers/workflow-handler.ts`, `src/__tests__/workflow-output-status-convention.test.ts`
**Impact**: Downstream consumers reading `{{steps.end.output._state}}` in existing workflows will break silently — no back-compat shim was added because the convention was internal. If external users surface, add a read-side alias in the expression resolver, not a dual-write in the handler.

## 2026-04-19 — Restate-endpoint shared handlers extracted as pure exports

**Category**: testability
**Learning**: `buildRestateEndpoint` used to inline the 4 shared-handler bodies (cancel, resolveCallback, resolveApproval, resolveHumanTask) inside `restate.workflow({...})`. This made them untestable without mocking `@restatedev/restate-sdk` (an external third-party, but CLAUDE.md wants DI over `vi.mock`). The bodies are now exported as `handleCancel` / `handleResolveCallback` / `handleResolveApproval` / `handleResolveHumanTask` taking a `SharedCtxLike` interface (`{ key, promise(name).resolve(value) }`). The SDK wiring still references them by name inside `restate.handlers.workflow.shared(handler)`. A regression test pins the disjoint promise-key namespaces (`sys:cancel`, `sys:callback:<id>`, `sys:approval:<id>`, `sys:human_task:<id>`) so a concurrent resolution for the same `stepId` never cross-wakes a sibling handler.
**Files**: `src/services/restate-endpoint.ts`, `src/__tests__/restate-endpoint.test.ts`
**Impact**: New Restate shared handlers should be extracted the same way (pure exported function + minimal ctx-like interface) so they pick up DI-based unit coverage for free. The SDK-level `buildRestateEndpoint` only gets a smoke test because the endpoint object is opaque.

## 2026-04-19 — Coverage hardening across critical services

**Category**: testability
**Learning**: Added 7 new unit test files closing the audit's critical/high gaps: `oauth-grant-resolver.test.ts` (9 tests, DI fakes for tokenModel/authProfileModel/encryption/redis, covers SSRF guard + refresh lock semantics), `restate-client.test.ts` (11 tests, stubs `globalThis.fetch`, covers 404 "service not found" re-register-and-retry), `restate-endpoint.test.ts` (11 tests — see above), `version-resolution.test.ts` (11 tests, all 5 cascade tiers + priority regression guard), `trigger-scheduler-lifecycle.test.ts` (8 tests supplementing `trigger-scheduler-timezone.test.ts` — covers `schedulePolling`, version-cascade integration, callbackUrl propagation, worker failed-listener), `execution-payload.test.ts` (13 tests — pins the never-drop defaults for `nameToIdMap`/`outputMappings` + null-vs-undefined omit contract), `route-helpers.test.ts` (11 tests — 400 error-shape contract + asyncHandler Express-4 forwarding). All use DI only; the only "mocks" are `vi.stubGlobal('fetch')` or `globalThis.fetch = vi.fn()` which is a Web-API global, not an internal package.
**Files**: `src/__tests__/oauth-grant-resolver.test.ts`, `src/__tests__/restate-client.test.ts`, `src/__tests__/restate-endpoint.test.ts`, `src/__tests__/version-resolution.test.ts`, `src/__tests__/trigger-scheduler-lifecycle.test.ts`, `src/__tests__/execution-payload.test.ts`, `src/__tests__/route-helpers.test.ts`
**Impact**: The "90 new tests" matters less than the pattern — every critical DI-shaped module in this package should follow the same recipe: in-memory fakes, no internal-package mocks, assertions scoped to observable behaviour (URLs, body shape, promise keys). The one module that needed a small refactor (`restate-endpoint`) was fixed in the same commit as its test — the refactor is documented separately above. When the parallel step's branchRunner was added to `e2e-advanced.test.ts`, the initial design tried to inject a custom branchRunner via `dispatcherDeps` — that fails because `workflow-handler` overwrites the injected value at line 663 (its own branchRunner wraps `executeStepChain`). The correct pattern is to include branch sub-steps in `input.steps` so `stepIndex` resolves them during `executeStepChain`.

## 2026-04-19 — `trigger-scheduler-timezone.test.ts` leaves `schedulePolling` / version-cascade gaps

**Category**: gotcha
**Learning**: The sibling `trigger-scheduler-timezone.test.ts` is named for its primary focus (BullMQ `tz` option) but it does also cover `scheduleOnce`, basic processJob, unschedule, and shutdown. It does NOT cover `schedulePolling`, the version-cascade integration in processJob (pinned → deployment → semver → draft), callbackUrl propagation, or the worker-failed listener. The new `trigger-scheduler-lifecycle.test.ts` fills those without duplication — before adding another scheduler test, check both files to pick the right home.
**Files**: `src/__tests__/trigger-scheduler-timezone.test.ts`, `src/__tests__/trigger-scheduler-lifecycle.test.ts`
**Impact**: When the scheduler grows a new method (e.g. `scheduleEvent`), add the test to `trigger-scheduler-lifecycle.test.ts`. Keep `-timezone.test.ts` focused on the tz branch so it remains the canonical INT-3/INT-5/INT-6 home.

## 2026-04-19 — `startInputVariables` is extracted but dropped across every resolution/execution layer

**Category**: gotcha / data-flow
**Learning**: `canvas-to-steps.ts:351-358` has been extracting `startInputVariables` (declared start-node input variables with name/type/required) into `CanvasConversionResult` — but every downstream consumer destructures only `steps`, `nameToIdMap`, `outputMappings` and drops this field on the floor. Dead call sites: `ResolvedWorkflowDefinition` (`lib/version-resolution.ts:81-89` — every tier: pinned/active/deployment/draft/legacy), `ExecutionDefinition` (`routes/workflow-executions.ts:130-136` plus three `build*ExecutionDefinition` builder functions), trigger-engine.ts:555-575, trigger-scheduler.ts:263-287. The engine performs zero validation/coercion of trigger payloads against declared input variables — only `apps/studio` `RunDialog.tsx` does client-side checks for manual runs. Webhook/cron/agent/poll triggers send raw payloads; missing required fields silently become `undefined` in `ctx.vars`. Wiring fix must update EVERY layer in lockstep — see `docs/specs/workflow-start-end-first-class-steps.hld.md` for the full trace.
**Files**: `src/handlers/canvas-to-steps.ts`, `src/lib/version-resolution.ts`, `src/routes/workflow-executions.ts`, `src/services/trigger-engine.ts`, `src/services/trigger-scheduler.ts`, `src/lib/execution-payload.ts`, `src/handlers/workflow-handler.ts`
**Impact**: When adding any new field extracted from the canvas that must reach the engine, trace it through ALL five layers (extraction → ResolvedWorkflowDefinition → ExecutionDefinition → BuildExecutionPayloadInput → WorkflowExecutionPayload → WorkflowExecutionInput) or it will be silently dropped. Add a unit test that asserts round-trip preservation from `convertCanvasToSteps` to `WorkflowExecutionInput` for any new canvas-declared field.

## 2026-04-19 — End node performs real work but has no step record; failures silently swallowed

**Category**: gotcha / observability
**Learning**: `workflow-handler.ts:1357-1372` evaluates output-mapping expressions against the workflow context via `resolveExpressionTyped` — this is real runtime work, not a pure control-flow marker. Yet: (a) no `end` step record exists in `execution.steps[]` (unlike the synthetic Start at line 674-703), (b) per-expression failures are caught with `catch { resolvedOutput[m.name] = null; }` and silently replaced with `null`, with no log/trace/error-event/step-status. A misspelled `{{steps.frobnicate.output.bar}}` resolves to `null` indistinguishable from an intentional null. The Studio `DebugFlowLog.tsx` compensates client-side by fabricating a fake End step (`DebugFlowLog.tsx:72-111`) — this is why Debug panel shows 4 steps while Raw JSON and Monitor tab show 3. HLD `workflow-start-end-first-class-steps` converts End into a first-class step record with `mappingErrors[]` and fails the workflow on any mapping failure (product pre-live). Mongoose `NodeExecutionSchema` needs `mappingErrors: {type: [Schema.Types.Mixed]}` (strict:true strips undeclared fields — same GAP-14 class).
**Files**: `src/handlers/workflow-handler.ts`, `apps/studio/src/components/workflows/canvas/panels/DebugFlowLog.tsx`, `packages/database/src/models/workflow-execution.model.ts`
**Impact**: Any canvas node that performs runtime work (not just control-flow) must be a first-class step record — never rely on client fabrication to paper over missing engine truth. Any silently-swallowed catch in the workflow handler is almost always a bug; errors must be persisted on step records and emitted via SSE.

## 2026-04-19 — `VersionResolutionTier` has 6 members, NOT 5 (cascade fan-out)

**Category**: gotcha / reference
**Learning**: `apps/workflow-engine/src/lib/version-resolution.ts:34-40` defines `VersionResolutionTier` with **6** members: `pinned`, `deployment`, `semver-desc`, `draft`, `working-copy-steps`, `working-copy-canvas`. The "working copy" legacy fallback fans out into two tiers depending on whether the doc has a legacy `.steps` array (`working-copy-steps`, line 252-260) or only canvas `.nodes`/`.edges` (`working-copy-canvas`, line 264-272). `resolveWorkflowDefinition` has 6 `return` statements — every field added to `ResolvedWorkflowDefinition` must be propagated at all 6 sites. The doc comment at the top of the file lists only "5 tiers" (collapsing working-copy into one); treat the `VersionResolutionTier` union as the source of truth, not the header comment. `EMPTY_RESULT` is NOT in this file — it lives in `canvas-to-steps.ts:151-156`.
**Files**: `src/lib/version-resolution.ts`, `src/handlers/canvas-to-steps.ts`
**Impact**: When adding a field to `ResolvedWorkflowDefinition` or `CanvasConversionResult`, add a regression test that asserts the field surfaces from all 6 resolution tiers AND the `EMPTY_RESULT` in `canvas-to-steps.ts`. Otherwise one forgotten `return` silently drops the field for a subset of fire paths — same class of bug as the `startInputVariables` dead-wiring and GAP-14.

## 2026-04-19 — `system-*.test.ts` uses real Mongo; `e2e-*.test.ts` uses DI fakes (naming is misleading)

**Category**: gotcha / testing
**Learning**: The test file naming convention in `apps/workflow-engine/src/__tests__/` is counterintuitive: `system-*.test.ts` files (`system-handler.test.ts`, `system-persistence.test.ts`, `system-callback.test.ts`, `system-human-task-store.test.ts`, `system-execute-version.test.ts`, `system-executions-semver.test.ts`) use REAL MongoDB via `helpers/setup-mongo.ts` — these are the true system/E2E tests. The `e2e-*.test.ts` files (`e2e-basic.test.ts`, `e2e-medium.test.ts`, `e2e-advanced.test.ts`) despite the name use DI fakes for persistence — they're really integration tests. When writing tests that need to verify Mongo persistence (e.g. step record landing in `nodeExecutions[]`, Mongoose strict-field stripping), use the `system-*` pattern, NOT `e2e-*`.
**Files**: `src/__tests__/system-*.test.ts`, `src/__tests__/e2e-*.test.ts`, `src/__tests__/helpers/setup-mongo.ts`
**Impact**: When an implementer reads "add E2E tests" in an LLD, do not assume the `e2e-*` pattern is the right home. If the test must exercise real persistence, use `system-*.test.ts` + `setup-mongo.ts`. Call this out explicitly in LLD Phase 8 naming so implementers don't create a DI-faked test thinking it's E2E.

## 2026-04-20 — First-class Start/End boundary step lifecycle landed (ABLP-2)

**Category**: feature / architectural
**Learning**: Start and End canvas nodes are now real execution step records with the same `pending → running → completed|failed` lifecycle as every other step. Key implementation decisions now baked in:

1. **ExecutionStore.updateStepStatus data bag has 3 sync points.** Any field you add to step records must be added in THREE places or it silently drops on either the TS call site OR the Mongoose write:
   - `ExecutionPersistence.updateStepStatus` TypeScript `data?` type (`handlers/workflow-handler.ts:118-140`)
   - The runtime `update` map that builds the `$set` (`persistence/execution-store.ts:144-175`)
   - The Mongoose `NodeExecutionSchema` field declaration (`packages/database/src/models/workflow-execution.model.ts:133-180`)
2. **`resolveExpressionTyped` does NOT throw on missing paths.** It returns `undefined` when a path can't be resolved (e.g., `{{steps.frobnicate.output.x}}` on a non-existent step). If you need to detect "expression failed to resolve," check both `try/catch` AND `value === undefined` when the template contains `{{...}}`. See `workflow-handler.ts:1510-1531` End-phase detection.
3. **`Number("")` returns 0, not NaN.** If you ever need to coerce a string to a number, reject empty/whitespace strings explicitly — `Number("").isNaN` is `false`. See `validation/start-input-validator.ts:102-112`.
4. **`StartInputVariable` is engine-internal.** It's the `{name, type, required}` projection of the canonical canvas `StartNodeConfigSchema` (which also has `defaultValue`, `description` — Studio UI metadata). When the engine needs canvas-declared metadata, project it narrowly; don't import the full Zod schema type.
5. **SSE event ordering:** boundary steps fire their lifecycle events INSIDE the workflow.started/workflow.completed envelope naturally — Start emits `step.started → step.completed` BEFORE `workflow.started`; End emits `step.started → step.completed` AFTER the last user step and BEFORE `workflow.completed`. Studio sorts by `startedAt`, so arrival order doesn't matter.

**Files**: `src/handlers/workflow-handler.ts`, `src/validation/start-input-validator.ts`, `src/persistence/execution-store.ts`, `src/lib/{execution-payload,version-resolution}.ts`, `src/routes/workflow-executions.ts`, `packages/database/src/models/workflow-execution.model.ts`
**Impact**: Future work on boundary-step-adjacent features (e.g., loop nodes, parallel branches that want first-class persistence, workflow-level input validation tightening) should reuse `validateAndCoerceInput` and the `mappingErrors` shape. Output-mapping-adjacent work should inherit the fail-on-any-failure semantic from HLD D-17 rather than reintroducing silent-null.

---

**Category**: architecture
**Learning**: Transactional outbox via persistence-layer decorators (ABLP-2 Phase 3). The shipped `ExecutionPersistenceWithOutbox` + `HumanTaskStoreWithOutbox` decorators wrap the raw `ExecutionStore` + `MongoHumanTaskStore` and commit a `workflow_event_outbox` row inside the same Mongoose `ClientSession` as the domain write. This keeps atomicity intact without 30+ handler-site `withTransaction` wrappings — important because the commit-scope guard caps feat commits at 40 files / 3 packages. Pattern: raw stores + optional `session` param threaded through every write method; decorator opens `withTransaction` and passes the session through; Mongoose's single-doc `Model.create()` does NOT accept `session` options (use the array overload `Model.create([doc], { session })`). See `src/outbox/execution-persistence-with-outbox.ts` file header for the full rationale.
**Files**: `src/outbox/execution-persistence-with-outbox.ts`, `src/persistence/execution-store.ts`, `src/persistence/human-task-store.ts`
**Impact**: Future write-paths that need Mongo+secondary-store atomicity should reuse this decorator pattern instead of sprinkling `withTransaction` at call sites. The 40-file / 3-package commit-scope guard effectively forbids call-site-sprinkling on anything touching >3 handlers.

---

**Category**: gotcha
**Learning**: Mongo partial-filter expressions reject `$ne` — use `{field: {$type: 'date'}}` instead. This bit ABLP-2 Phase 2's outbox TTL index (fixed in commit ff16216e6e) and again in Phase 6's workflow/human-task TTL indexes. The error manifests as `Expression not supported in partial index: $not` at index creation time. Tests must load the model against a real Mongo (MongoMemoryReplSet or docker) to catch this at authoring time — a pure unit test of the schema file does not exercise index creation.
**Files**: `packages/database/src/models/workflow-event-outbox.model.ts`, `packages/database/src/models/workflow-execution.model.ts`, `packages/database/src/models/human-task.model.ts`
**Impact**: Every new TTL partial-filter index must use `$type: 'date'` (or the equivalent BSON-type check) — never `$ne: null`. Add a note when a new partial-filter TTL is introduced.

---

**Category**: testing
**Learning**: The dual-read merger (`src/persistence/dual-read-merger.ts`) is a pure function. Test it directly without any mocks — no Mongo, no CH, no imports from internal packages. The 9-case UT covers every combination (empty/empty, empty/one-side, disjoint, full overlap, partial overlap, within-side dup keys, DESC sort, numeric sort). Integration + E2E tests can assume the merger is correct and focus on the wiring (hybrid-reader + route) rather than re-testing the merge logic.
**Files**: `src/persistence/dual-read-merger.ts`, `src/persistence/__tests__/dual-read-merger.test.ts`
**Impact**: When the LLD §7 OQ resolves and the merger moves to `packages/database/src/migration-helpers/`, the test moves with it; callers keep their own wiring tests.

---

**Category**: architecture
**Learning**: Flag-gated TTL index creation at schema-load time. `packages/database/src/models/{workflow-execution,human-task}.model.ts` wrap their TTL `Schema.index()` calls in `if (process.env.WORKFLOW_MONGO_TTL_ENABLED === 'true')`. Mongoose calls `ensureIndexes` after model load, so the TTL index is only declared when the flag is on at boot. This matches the LLD directive that "ensureIndex only runs at startup when the flag is on". The `expiresAt: Date | null` field itself is always present (the write path fills it only on terminal transitions via `computeExecutionExpiresAt` / `computeHumanTaskExpiresAt`).
**Files**: `packages/database/src/models/workflow-execution.model.ts`, `packages/database/src/models/human-task.model.ts`, `apps/workflow-engine/src/persistence/workflow-ttl.ts`
**Impact**: Future feature-flag-gated indexes should follow this pattern. If a flag-gated index is needed on a collection that other features read, keep the column always-present and gate only the index declaration.

---

**Category**: architecture
**Learning**: TTL partial-filter index shape must be validated at startup. The partial-filter operator `{publishedAt: {$ne: null}}` is silently rejected by Mongo ("Expression not supported in partial index: $not") but the error only surfaces at index-build time, not at server boot. A pod can run for hours with a flag that says TTL is on but zero rows are actually being reaped. Fix: at startup, when `WORKFLOW_MONGO_TTL_ENABLED=true`, inspect `listIndexes()` for each TTL-bearing collection, extract `partialFilterExpression.expiresAt.$type`, and refuse to start with CRITICAL log + `process.exit(1)`if missing or not`'date'`.
**Files**: `src/index.ts`, `packages/database/src/models/workflow-execution.model.ts`, `packages/database/src/models/human-task.model.ts`**Impact**: Any feature using Mongo partial-filter TTL indexes should add the same startup validation — do not trust that`ensureIndexes()`succeeded silently. Use`{expiresAt: {$type: 'date'}}` (or the appropriate BSON type), never `{$ne: null}`.

---

**Category**: gotcha
**Learning**: Outbox bookkeeping `updateOne` calls must be try/caught individually. A transient Mongo hiccup during success-path stamping (`$set: {publishedAt, expiresAt}`) — or during failure-path accounting (`$inc: {retryCount}`) — would otherwise abort the remaining rows in the drain batch. Wrap each in its own try/catch and log `workflow.outbox.bookkeeping_failed` on secondary failure. ReplacingMergeTree `_version` dedup at CH absorbs any duplicate publish on the next drain cycle — the row is safe to redeliver.
**Files**: `src/outbox/outbox-poller.ts`, `src/outbox/__tests__/outbox-poller.test.ts`
**Impact**: Any drain-loop-style worker (BullMQ, cron, queue consumer) that mutates state after an external IO should isolate bookkeeping failures from the outer loop. Use ReplacingMergeTree-equivalent idempotency at the downstream sink so duplicates are safe.

---

**Category**: pattern
**Learning**: `publishAndAck(topic, event, key?)` is topic-agnostic for producers. The `KafkaEventQueue` constructor's `topic` binds only the consumer-side subscription, not the producer. A single `KafkaEventQueue` instance can `publishAndAck` to any topic — so the outbox poller correctly routes `abl.workflow.execution` and `abl.human.task` rows through the same queue instance by passing `row.topic` as the first argument.
**Files**: `src/outbox/outbox-poller.ts`, `packages/eventstore/src/queues/kafka-queue.ts`
**Impact**: When wiring outbox-style publishers, instantiate one KafkaEventQueue for the consumer side (one topic each) but reuse it for publishing to multiple topics. No need to create per-topic publisher instances.

---

**Category**: gotcha
**Learning**: After ABLP-573 isolated `safeFetch`/`assertUrlSafeForFetch` to the `@agent-platform/shared-kernel/security/safe-fetch` subpath, every workflow-engine production import (callback-delivery worker, http-executor, system-handler, e2e webhook flows) must reference that subpath. Tests mocking these must `vi.mock('@agent-platform/shared-kernel/security/safe-fetch', ...)` — the old `security` barrel mock no-ops silently because production no longer reaches that path. The `assertUrlSafeForSSRF` sync helper remains on the `security` barrel; when both are needed in one file, split the mock into two `vi.mock` blocks. The `SSRFError` class also moved with `safeFetch` — production code uses the production class, so test-side `instanceof SSRFError` checks against a mocked class WILL silently fail.
**Files**: `src/services/callback-delivery-worker.ts`, `src/executors/http-executor.ts`, `src/handlers/system-handler.ts`, `src/__tests__/callback-delivery.test.ts`, `src/__tests__/e2e-*.test.ts`, `src/__tests__/system-handler*.test.ts`, `src/__tests__/workflow-handler-suspension.test.ts`, `src/__tests__/workflow-integration.test.ts`, `src/__tests__/workflow-output-status-convention.test.ts`, `src/__tests__/http-executor.test.ts`
**Impact**: When adding a new safeFetch caller in workflow-engine, import from the subpath. When writing tests that touch any safeFetch path, mock at the subpath. Do not rely on the security barrel mock — it intercepts only the sync `assertUrlSafeForSSRF`.

## 2026-04-27 — Per-step dot-notation persistence (context cleanup)

**Category**: architecture
**Learning**: `ExecutionStore.updateStepStatus` now supports per-step dot-notation writes via `{ stepKey, stepData }` parameters. When both are provided, it writes `$set: { 'context.steps.<stepKey>': cleanStep }` instead of overwriting the entire `context` blob. This eliminates the parallel-branch race condition (where two concurrent `$set: { context: ctx }` would clobber each other) and reduces write amplification. The legacy whole-context path is preserved for backward compatibility when only `context` is passed.
**Files**: `src/persistence/execution-store.ts`, `src/handlers/workflow-handler.ts`
**Impact**: All new `updateStepStatus` calls should pass `{ stepKey, stepData }` — never `{ context: ctx }`. The `stepPersistArgs(ctx, step)` helper in `workflow-handler.ts` returns the correct shape. `setStepContext` MUST be called before `stepPersistArgs` so `getStepContext` returns current data.

**Category**: gotcha
**Learning**: `controlFlow` is stripped from `stepData` at the persistence boundary in `ExecutionStore.updateStepStatus`, not in the caller. The destructuring `{ controlFlow: _cf, ...cleanStep }` with `void _cf` suppresses the unused-var warning. This is the same boundary where `workflow` and `tenant` are stripped from the full context in the legacy path.
**Files**: `src/persistence/execution-store.ts`
**Impact**: When adding new internal-only fields to `WorkflowStepData`, strip them at the persistence boundary following the same destructuring pattern.

**Category**: gotcha
**Learning**: For boundary steps (start/end), the handler must build `ctx.steps.start` or `ctx.steps.end` via `buildCleanStepContext` and assign it BEFORE calling `updateStepStatus`, because `stepPersistArgs` reads from `getStepContext`. For approval/human_task decision paths, `setStepContext` with the updated status must also happen BEFORE the persistence call — the original code set context AFTER persistence, which would cause `stepPersistArgs` to read stale data.
**Files**: `src/handlers/workflow-handler.ts`
**Impact**: Any new step type that updates status in a decision path must follow the "set context first, then persist" order.

**Category**: testing
**Learning**: The `e2e-basic.test.ts` mock assertions check the exact shape of `updateStepStatus` data arguments (e.g., `fnCall![5]` containing `{output, consoleLogs}` or `{error}`). After switching to per-step writes, these assertions need updating to expect `{stepKey, stepData}` instead. These are outside the 3-file scope of the context-cleanup task but will fail until updated.
**Files**: `src/__tests__/e2e-basic.test.ts`
**Impact**: When changing the `updateStepStatus` call signature or data shape, grep for all mock assertion sites in test files and update them in the same change or immediately after.

## 2026-04-28 — ABLP-155 Direct WebSocket Push (workflows-websocket-direct)

**Category**: architecture
**Learning**: The WebSocket server (`ws-server.ts`) attaches to the existing HTTP server via the `upgrade` event, guarded by `WF_WS_ENABLED !== 'false'` in `index.ts`. The `WsBridge` singleton holds the `WsSubscriptionRegistry` and a Redis subscriber. No separate `redis-publisher.ts` was created — the existing `StatusPublisher` interface in `workflow-handler.ts` handles all publish calls inline. This kept the change additive and avoided a new module boundary.
**Files**: `src/websocket/ws-server.ts`, `src/websocket/ws-bridge.ts`, `src/websocket/ws-subscription-registry.ts`, `src/websocket/ws-handler.ts`, `src/websocket/ws-events.ts`, `src/index.ts`
**Impact**: When adding new event types to the WS protocol, add a Zod schema in `ws-events.ts` and a dispatch branch in `ws-bridge.ts` `onRedisMessage`. No new publish-side files needed unless the interface contract changes significantly.

**Category**: architecture
**Learning**: `WsBridge.handleSubscribeExecution` requires the fake WebSocket in tests to carry instance property `OPEN: 1` (not just `readyState: 1`). The `ws` library checks `ws.readyState !== ws.OPEN` — where `ws.OPEN` is an instance property on a real `ws.WebSocket` object, NOT just the numeric value 1. Without it, `readyState !== undefined` is always true and the send guard silently drops every message.
**Files**: `src/__tests__/ws-bridge.test.ts`
**Impact**: All fake WebSocket helpers in workflow-engine tests MUST carry `OPEN: 1` and `CLOSED: 3` alongside `readyState`.

**Category**: gotcha
**Learning**: `WF_WS_ENABLED=false` is the current default in dev (set via `ecosystem.config.js`). Studio polling is the active source of truth until integration tests pass and the kill switch is toggled. Don't enable WS in production before integration + E2E tests exist (see GAP-004, GAP-005 in the feature spec).
**Files**: `ecosystem.config.js`, `src/index.ts`
**Impact**: Before enabling `WF_WS_ENABLED=true` in any environment, implement IT-1 through IT-4 integration tests (subscribe-publish-receive round trip + isolation matrix).

**Category**: testing
**Learning**: 49 unit tests shipped across three files (execution-merge: 19, ws-bridge: 17, ws-subscription-registry: 13). Zero integration or E2E tests. GAP-004 and GAP-005 are HIGH severity gaps that block BETA. The integration harness needs a real Redis instance — `ioredis-mock` is NOT acceptable for testing pub/sub fan-out (would mask real event routing bugs).
**Files**: `src/__tests__/ws-bridge.test.ts`, `src/__tests__/ws-subscription-registry.test.ts`
**Impact**: When writing integration tests, start a real Redis container (or use the existing docker-compose service) and test the subscribe → publish → receive round-trip with actual `WsBridge.onRedisMessage`.

## 2026-04-29 — Workflow node `config.timeout` is SECONDS at storage, MILLISECONDS at engine

**Category**: architecture
**Learning**: Studio stores `config.timeout` as a plain integer in seconds for every workflow node type that has a "Timeout (seconds)" input — http, agent_invocation, tool_call, connector_action, async_webhook. `canvas-to-steps.ts` multiplies by 1000 at the boundary because `StepDispatchResult` and the step executors expect milliseconds. The `function` step is the one exception: function-executor consumes the value as seconds, so the converter passes it through unchanged. `human_task` uses a richer `{duration, unit}` shape that is normalized to ms inside its own case.

Pre-PR-797, the converter used `config.timeout ?? DEFAULT_STEP_TIMEOUT_MS` with no `* 1000`, which meant every workflow with an explicit timeout effectively timed out 1000× faster than the user configured (e.g. a 60-second HTTP step timed out after 60 ms). Migration was NOT needed when the conversion was added — Studio had always stored seconds, and no other writer in the codebase persisted `timeout` in milliseconds (audited via grep for `timeout.*1000` and `timeoutMs` across `apps/studio/src` + `apps/runtime/src`). Workflows that previously ran successfully had been getting `DEFAULT_STEP_TIMEOUT_MS` because their stored timeout was small enough to silently fail the timeout race.

**Files**: `src/handlers/canvas-to-steps.ts`, `apps/studio/src/components/workflows/canvas/config/{Api,Function,Generic,TextToText}NodeConfig.tsx`, `src/__tests__/canvas-to-steps.test.ts` (the conversion lock)
**Impact**: The seconds→ms conversion is locked by `canvas-to-steps.test.ts` (function 10→10, agent 5→5000, tool_call 12→12000, http 5→5000, connector_action 2→2000). Do NOT change this contract without (a) updating every Studio "Timeout (seconds)" label that consumes the same field, and (b) shipping a migration for persisted Workflow + WorkflowVersion documents. If you ever discover a node where `config.timeout` was stored in ms, audit upstream first — there is no such writer today, but adding one would silently break every other node that reads from the same field name.

---

**Category**: pattern
**Learning**: Agent projections (`agentSession`, `agentContext`) and `memory` are first-class top-level keys on `WorkflowContextData`. They are added to `KNOWN_TOP_LEVEL_KEYS` in `expression-resolver.ts:157` so paths like `{{agentSession.channel}}` and `{{memory.workflow.foo}}` resolve directly. They are also injected into the function-node V8 isolate as deep-frozen globals via `CONTEXT_READONLY_KEYS` (line 27) — overwriting throws via the readonly-key Proxy guard, mutation of nested fields silently fails (sloppy mode) or throws (strict mode). Phase 4 will replace the static `memory` snapshot with a Proxy that forwards `set/get/delete` to the host via `ivm.Reference.applySyncPromise`. The `agentSession` / `agentContext` snapshots stay frozen across phases.
**Files**: `src/context/expression-resolver.ts`, `src/context/agent-projection.ts`, `src/handlers/workflow-handler.ts`, `src/executors/function-executor.ts`
**Impact**: When extending the agent projection, update BOTH the type interface in `expression-resolver.ts` AND the materializer in `agent-projection.ts`. The materializer is the receive-side guard — fields added to the type but not the materializer will be dropped at materialization time. Conversely, fields added to the materializer but not the type will leak through TypeScript via `as Readonly<...>` cast. Keep both in sync.

---

**Category**: gotcha
**Learning**: `MemoryProjectionLoader` is a placeholder interface (`workflow-handler.ts:225`) whose Phase 4 implementation is `RuntimeMemoryClient` in `apps/workflow-engine/src/clients/runtime-memory-client.ts`. The `WorkflowHandlerDeps.memoryClient?` field is optional — when omitted, `loadMemoryProjection()` returns `{ workflow: {}, project: {}, user: undefined }`. This default lets existing tests and dev environments run without wiring the runtime memory route. When a real `memoryClient` IS supplied and `loadProjection()` throws, the run fails fast with `code: 'MEMORY_PROJECTION_FAILED'` — never silently fall back to the empty default. Rationale: a stale projection is worse than no projection (keys disappear without notice).
**Files**: `src/handlers/workflow-handler.ts`
**Impact**: Phase 4 will instantiate `RuntimeMemoryClient` at the composition root and pass it through `RestateEndpointDeps → WorkflowHandlerDeps`. Until then, the production runtime sees the empty projection. Function-node memory ops (Phase 4) will throw `STORAGE_UNAVAILABLE` when `memoryClient` is null at injection time — a clear signal that a wiring step was missed.

---

## 2026-04-27 — Phase 4: Function-node memory globals via `ivm.Reference.applySyncPromise`

**Category**: architecture
**Learning**: D-9 prototype (`scratch/applysync-prototype.ts`, gitignored) discovered four behaviors that drive the Phase 4 design:

1. **`applySyncPromise` requires a non-default thread.** It throws `"This function may not be called from the default thread"` when called from inside a script invoked via `script.runSync(ctx)` — runSync executes the script on the calling (main) thread. Function-executor.ts now uses `await script.run(isoContext, { timeout })` instead. The change is transparent to existing tests (the function was already async); script-side CPU timeout still works the same way.
2. **Script-level `timeout` does NOT cancel scripts blocked inside applySyncPromise.** Verified: a 200ms script timeout did not interrupt a script blocked on a 5000ms host promise. Per-host-call timeouts must live in the HTTP layer (`AbortSignal.timeout(MEMORY_OP_TIMEOUT_MS)` on the runtime memory client's fetch).
3. **applySyncPromise arguments and return values must be primitives** (string/number/boolean/null/undefined) or `ivm.ExternalCopy`/`Reference` wrappers — plain objects/arrays from inside the isolate are NOT transferable. We JSON-serialize values across the boundary in BOTH directions: bootstrap script `JSON.stringify(value)` before set, host `JSON.stringify(returnedValue)` before return-to-script, bootstrap `JSON.parse(...)` on receipt.
4. **Errors don't cross the boundary as instances either.** When `WorkflowMemoryError({ code, message })` is thrown by a host async function, only `.message` survives back to the script. The host-side wrapper rethrows as `new Error(\`\${code}: \${message}\`)`so authors get a parseable code prefix in`e.message`.

**Files**: `src/executors/function-executor.ts`, `src/clients/runtime-memory-client.ts`, `src/constants.ts` (MEMORY_OP_TIMEOUT_MS), `apps/workflow-engine/Dockerfile` (UV_THREADPOOL_SIZE=8)
**Impact**: Future host↔isolate sync bridges in this package should follow the same pattern: (a) use `script.run` not `runSync`, (b) keep arguments primitive — JSON-encode complex values across the boundary, (c) wrap thrown errors with a `<CODE>: <message>` prefix so authors can branch on the code without losing the human-readable suffix. The `RuntimeMemoryClient.set/get/delete` integration tests in `workflow-memory-isolate.test.ts` exercise this end-to-end including object/array round-trip with type fidelity.

**Category**: architecture
**Learning**: The 4-hop wiring chain for `RuntimeMemoryClient`:

1. `apps/workflow-engine/src/index.ts` (composition root) — instantiates `RuntimeMemoryClient` with `RUNTIME_URL` + `RUNTIME_JWT_SECRET`.
2. `RestateEndpointDeps` — accepts the same client at TWO call sites: top-level `memoryClient` (used by `workflow-handler.loadMemoryProjection` at run start) AND inside `dispatcherDeps.memoryClient` (used by `step-dispatcher.case 'function'`).
3. `StepDispatcherDeps.memoryClient?` — passed through to `executeFunctionStep(step, ctx, { memoryClient, runId, actor })` in the function case.
4. `FunctionExecutorDeps` (new optional 3rd param of `executeFunctionStep`) — when present, wires the host `ivm.Reference` callbacks; when absent, all memory ops throw `STORAGE_UNAVAILABLE`.

The `actor` is derived from `ctx.agentSession.endUserId`: agent-triggered runs with an end-user identity credit writes as `{ kind: 'end-user', endUserId }`; cron/webhook/manual runs credit as `{ kind: 'workflow-author' }`. `runId` is `ctx.workflow.executionId`.

**Files**: `src/index.ts`, `src/services/restate-endpoint.ts`, `src/handlers/step-dispatcher.ts`, `src/executors/function-executor.ts`
**Impact**: Any new function-node dependency that needs per-run identity should follow the same `FunctionExecutorDeps` extension. The `actor` derivation logic lives at the dispatcher layer (one place to change).

## 2026-05-06 — Redis Dual-Mode Phase B: DI pattern for createBullMQPair + vitest tier fixes

**Category**: pattern | gotcha
**Learning 1 — DI for BullMQPair in tests**: `vi.mock('@agent-platform/redis')` is forbidden by `platform-mock-lint.sh`. When a class (OutboxPoller, TriggerScheduler) calls `createBullMQPair(handle)` in its constructor, expose an optional `createBullMQPairFn?` dep on the deps interface. Tests inject a synthetic `BullMQConnectionPair`; production code falls back to the real `createBullMQPair`. The synthetic pair must implement `{ queueConnection, workerConnection, disconnect() }` — if disconnect() is a no-op, shutdown tests will silently miss the disconnect call.
**Learning 2 — vitest glob patterns are NOT recursive by default**: `src/__tests__/*.e2e.test.ts` does NOT match `src/__tests__/triggers/trigger-roundtrip.cluster.e2e.test.ts`. Use `src/**/*.e2e.test.ts` for recursive matching. The pre-push gate caught this because the cluster E2E test was picked up by the fast (threads) tier, which caused timeouts.
**Learning 3 — Supertest route tests need the HTTP tier**: Any file in `src/routes/__tests__/` that creates a real Express server (via supertest) must be excluded from `vitest.fast.config.ts` and included in `vitest.http.config.ts`. The http tier runs in a forks pool (maxWorkers: 1, fileParallelism: false) to prevent socket hang-ups under parallel load.
**Files**: `src/outbox/outbox-poller.ts`, `src/services/trigger-scheduler.ts`, `vitest.fast.config.ts`, `vitest.http.config.ts`
**Impact**: Future classes that accept BullMQ connections should follow the `createBullMQPairFn?` DI pattern from day 1. New test files in `src/routes/__tests__/` automatically land in the correct tier once the glob is `src/routes/__tests__/**/*.test.ts` in `vitest.http.config.ts`.

## 2026-05-08 — Multiple Canvas End Node Output Mappings

**Category**: gotcha
**Learning**: Canvas conversion must aggregate output mappings from every top-level `end` node. The previous `nodes.find(nodeType === 'end')` shape silently kept only one End node's mappings, so workflows with multiple terminal branches lost outputs before execution started.
**Files**: `src/handlers/canvas-to-steps.ts`, `src/__tests__/canvas-to-steps.test.ts`
**Impact**: Future End-node changes should treat End nodes as a collection. Keep loop-body `loop_end` markers and parented End-like controls out of workflow-level `outputMappings`.

## 2026-05-08 — End Output Mapping Errors Need Field Detail

**Category**: gotcha
**Learning**: End-step output mapping failures must include the same per-field details that loop body output mappings expose. A generic `N of N output mappings failed` message forces users to inspect raw `mappingErrors`; include `fieldName: Output mapping ... expected X, got Y` in the thrown workflow error and persisted End step error. Runtime object/array values should be described as `json` for author-facing type mismatch messages.
**Files**: `src/handlers/workflow-handler.ts`, `src/validation/output-mapping-validator.ts`, `src/__tests__/output-mapping-validator.test.ts`, `src/__tests__/system-handler-start-end.test.ts`
**Impact**: When changing output mapping validation, update both the structured `mappingErrors[]` payload and the top-level human-readable error string so Studio surfaces actionable diagnostics without requiring raw JSON inspection.

## 2026-05-09 — Multi-End-Node Schema Merge in deriveWorkflowOutputSchema

**Category**: gotcha
**Learning**: `apps/studio/src/lib/variables-to-json-schema.ts:deriveWorkflowOutputSchema` merges declared output fields from all end nodes using `Object.assign(properties, endNodeProps)`. When two end nodes declare a field with the same name but different types, the **last** end node in the canvas `nodes` array wins silently — no warning, no union, no error. This is intentional for now (flat merge avoids complex `oneOf` handling), but it means Studio's output-schema preview and tooling consumers may show the wrong type if field names collide. Authors who rename colliding fields see the correct schema immediately; authors who deliberately want the same field from two branches can rely on this last-wins behavior — they just need to know it is deterministic (document order) and not based on which branch fires at runtime.
**Files**: `apps/studio/src/lib/variables-to-json-schema.ts`, `apps/studio/src/__tests__/variables-to-json-schema.test.ts`
**Impact**: If Studio ever needs to surface field-name collisions to the author, add a pre-merge duplicate-key check in `deriveWorkflowOutputSchema` and emit a warning or UI annotation. Do not silently promote this to a `oneOf` union — downstream JSON Schema consumers (tooling, agent schema builders) may not handle `oneOf` at the property level.

## 2026-05-11 — Workflow HTTP Tool Async Completion (ABLP-155)

**Category**: pattern | gotcha
**Learning**: HTTP tools invoked from workflow `tool_call` nodes now support `sync` and `async_wait` execution modes. `async_continue` is intentionally absent for HTTP tools — it is semantically equivalent to `sync` for HTTP (both return immediately) and was removed to reduce surface area. Only `workflow`-type tools support `async_continue`. The callback injection guard in `http-tool-executor.ts` was tightened from `executionMode !== "sync"` to `executionMode === "async_wait"` to avoid injecting callback metadata for fire-and-forget tool nodes. When `callbackConfig` is present (HTTP async_wait path), BOTH `accepted` AND `completed` inline responses enter `waiting_callback` suspension in `workflow-handler.ts` — the callback URL was already injected so the step must wait regardless of inline response status. This differs from workflow-type tools (no callbackConfig) where only `accepted` enters suspension. `mcp`, `sandbox`, and `searchai` tool types are explicitly excluded from the async callback contract; they return `TOOL_CALLBACK_UNSUPPORTED` for any non-sync mode.
**Files**: `src/handlers/step-dispatcher.ts`, `src/handlers/workflow-handler.ts`, `src/handlers/canvas-to-steps.ts`, `src/executors/tool-call-executor.ts`
**Impact**: Any new executor that gains async job/callback capability should (a) add itself to the `supportsAsync` capability gate in `apps/runtime/src/routes/internal-tools.ts` and (b) decide whether to use the `callbackConfig`-present path (enters suspension on both accepted and completed) or the workflow-tool path (requires accepted). The `ToolExecutionResponse` discriminated type (`completed | accepted | failed`) is the contract between workflow-engine and runtime.

## 2026-05-15 — Document-Extraction Integrations (Phase 1-4) — ABLP-1073

**Category**: architecture | pattern | gotcha
**Learning**: A new `StepDispatchResult.callbackRequest` flow lets `connector_action` steps suspend via Restate's durable promises (`sys:callback:<stepId>`) without consuming a worker slot during long async work (e.g. Docling extraction). The suspension block in `workflow-handler.ts` mirrors the existing `webhookRequest` / `toolRequest` blocks (placement after the toolRequest block, before the cancel check at L3200) and is the canonical pattern for connectors that produce an `AsyncParkingSentinel`. The block: (1) persists `encryptedCallbackSecret` onto the step record, (2) increments the `workflow_docling_parked_promises_gauge`, (3) parks via `raceCancel(raceTimeout(restateCtx.promise(...).get(), timeout))`, (4) on resume scrubs the payload through `scrubTraceEvent` (PII / secret redaction), (5) records `workflow_docling_wait_duration_seconds` + emits an extraction audit event. The Azure DI piece needs a Redis-backed `KeyValueStore` to survive Restate replay; wired via `ConnectorDepsFactory(tenantId, projectId, workflowExecutionId, stepId, callbackContext?)` → `new ConnectorToolExecutor(deps, kvStore)` where `kvStore = new RedisKvStore(redisClient, 'connector-kv:')`. The breaker registry exposes `onEvent` — the engine subscribes once at boot to wire `azure_di_circuit_breaker_state` gauge updates.
**Files**: `src/handlers/workflow-handler.ts` (suspension block + audit emission), `src/handlers/step-dispatcher.ts` (StepDispatchResult.callbackRequest), `src/index.ts` (RedisKvStore wiring, breaker onEvent subscription, ExtractionAuditEmitter at boot, `enqueueWorkflowDoclingJob` wraps with `wrapJobDataForEncrypt`), `src/observability/extraction-metrics.ts` (OTel meter — 14 metrics), `src/services/extraction-audit-events.ts` (host-only sourceUrl emitter), `src/services/azure-di-usage-counter.ts` (CAS reset + cap-used gauge), `src/services/redis-kv-store.ts`, `src/routes/azure-di-usage.ts` (`projectRouter` mount).
**Impact**: New async-parked connector actions follow the same Sentinel→callbackRequest→suspension path. Callback secrets MUST be encrypted in two places: (1) at the step record (engine sees only ciphertext) AND (2) in the BullMQ job payload at-rest (via `wrapJobDataForEncrypt` → manifest entry in `packages/shared-encryption/src/encryption-manifest.ts`). The `workflow-callbacks` route returns a `code` field on 401 (`SIGNATURE_MISSING` / `TIMESTAMP_MISSING` / `TIMESTAMP_EXPIRED` / `SIGNATURE_INVALID`) so the worker's callback poster can split clock-skew failures from authentic HMAC mismatches in the `error_class` metric dimension.

## 2026-05-17 — Restate 1.6.2 suspended-state re-dispatch gotcha — ABLP-1073

**Category**: gotcha
**Learning**: On Restate server 1.6.2 (the version pinned in `docker-compose.yml` and likely in dev/prod), suspended workflow `run` invocations are NOT reliably re-dispatched after a `workflow.shared` handler resolves a durable promise (`sys:callback:STEPID`, `sys:approval:STEPID`, `sys:human_task:STEPID`). The resolve succeeds at the Restate level (admin API returns 200, `Invocation completed successfully` is logged on the shared handler), but the suspended `run` stays at `status: suspended` forever — the workflow record in Mongo is stuck at `waiting_*`. Tested with both `ctx.promise().resolve()` and `ctx.awakeable()` paths; both fail post-suspension. PRE-suspension resolution (resolve arrives while the handler is still in-flight, within `inactivity_timeout`) works correctly.
**Files**: `src/index.ts:466-493` (the workaround), `src/handlers/workflow-handler.ts` (suspension blocks at L2336, L2603, L3248), `src/services/restate-endpoint.ts:191` (shared handlers).
**Impact**: Until the BullMQ-driven workflow-resumption refactor lands (tracked in `docs/sdlc-logs/document-extraction-integrations/data-flow-audit.md` R5), the only mitigation is to **keep the handler in-flight long enough that the resolve always arrives pre-suspension**. `index.ts:466-493` PATCHes Restate's per-service `inactivity_timeout` from the default `1m` to `1h` after every successful Restate registration. Env-overridable via `RESTATE_WORKFLOW_RUNNER_INACTIVITY_TIMEOUT`. This unblocks Docling (100-180s extractions), short approvals, async webhooks. **Multi-day async waits are NOT supported until the architectural refactor lands.** If you see a workflow stuck at `waiting_*` past 60s, first check: was the handler in-flight when the resolve arrived? If not, you've hit this bug.

## 2026-05-17 — Restate workflow virtual object enforces one-invocation-per-key — ABLP-1073

**Category**: pattern
**Learning**: `restate.workflow()` (the type our `workflow-runner` uses) ALLOWS only ONE `run` invocation per key (executionId). A second POST to `/workflow-runner/<key>/run/send` returns `PreviouslyAccepted` and gives back the SAME invocation handle. This is by-design Restate behavior for workflow virtual objects. Implication: any "fresh Restate invocation per leg" pattern for the SAME executionId is impossible — to model legs as independent invocations you'd need either (a) a different key per leg, or (b) convert `workflow-runner` to `restate.service()` (unkeyed, multi-invocation) and persist shared state in Mongo. The `workflow.shared` handlers (`resolveCallback`, `resolveApproval`, etc.) are the only way to interact with an existing workflow's state.
**Files**: `src/services/restate-endpoint.ts:140-217`.
**Impact**: When designing async-wait mechanisms for this engine, do not assume you can spawn a second `run` invocation. Use either durable promises + shared handlers, awakeable, or migrate the service type. The Restate API hides the conflict (returns 202 + same invocationId), so a naive consumer might believe it spawned a new invocation when in fact nothing happened.

## 2026-05-18 — Restate Awakeable Pattern Replaces Durable Promise for All Suspension Sites — ABLP-1073

**Category**: architecture / gotcha
**Learning**: Restate 1.6.2 has a bug where a suspended `run` handler is not reliably re-dispatched after a `workflow.shared` handler resolves its durable promise. The fix: replace ALL 4 suspension sites (`connector_action`, `approval`, `human_task`, `async_webhook`) with `ctx.awakeable<T>()`. The awakeable is resolved via `/restate/awakeables/:id/resolve` (built-in Restate ingress endpoint, no shared handler involved). The `awakeableId` is persisted on the step record (`context.steps`) and stripped at the WS publish boundary (`PUBLISH_SENSITIVE_STEP_FIELDS`). The callback route reads `step.awakeableId` and branches: awakeable → `resolveAwakeable()`; no awakeableId → `resolveCallback()` (backward-compat for in-flight workflows).
**Files**: `workflow-handler.ts` (4 suspension blocks), `workflow-callbacks.ts`, `workflow-approvals.ts`, `human-task-resolution.ts`, `restate-client.ts` (resolveAwakeable), `step-context-schema.ts` (awakeableId fields), `index.ts` (inactivity_timeout PATCH)
**Impact**: All future async-wait patterns in the workflow engine must use awakeables, not durable promises. The 1h `inactivity_timeout` PATCH is defense-in-depth but awakeables are the primary fix.

## 2026-05-18 — ADI BullMQ Poll Worker Pattern — ABLP-1073

**Category**: architecture
**Learning**: Azure DI's `extract_document` action originally polled Azure inline inside the Restate handler (up to 30 min). This blocks the Restate invocation slot and creates memory pressure. Fix: connector POSTs to Azure, stashes `operationLocation` in `ctx.store` (Redis KV, replay-safe), enqueues `workflow-adi-poll` BullMQ job via `callbackContext.enqueueADIPollJob`, returns `AsyncParkingSentinel`. The `AdiPollWorker` in `apps/workflow-engine/src/services/adi-poll-worker.ts` runs one GET per job and re-enqueues with fixed 2s interval (not exponential — exponential adds latency without benefit for discrete jobs). Critical: `wrapJobDataForEncrypt` must be called on EVERY `queue.add()` including re-enqueues — the original decrypted data must not be spread raw into the next job.
**Files**: `adi-poll-worker.ts`, `extract-document.ts`, `types.ts` (enqueueADIPollJob), `context-translator.ts` (callbackContext in ctx.abl), `index.ts` (queue + worker wiring), `encryption-manifest.ts`
**Impact**: Any connector that needs async polling (not just ADI) should follow this BullMQ poll worker pattern rather than blocking the Restate handler. The Express body limit on `/api/v1/workflows/callbacks` must match the inline cap + 2MB headroom.

## 2026-05-20 — Relay-Race Execution Model Replaces Restate Awakeable Suspension — ABLP-1073

**Category**: architecture
**Learning**: The relay-race model replaces Restate `workflow.run` awakeable suspension with a MongoDB `parkStep` + `startWorkflow` relay pattern. Each execution is a series of short `restate.object()` exclusive handler invocations. `executeWorkflow()` reads `inputSnapshot` from MongoDB cold-start each time — no Restate journal dependency. The `workflow-executor` Restate virtual object exposes `runWorkflow` (exclusive) and `cancelWorkflow` (shared) handlers, registered alongside the legacy `workflow-runner` `restate.workflow()` in `buildRestateEndpoint()`.
**Files**: `src/handlers/workflow-handler.ts` (`executeWorkflow`, `WorkflowRunInput`, `WORKFLOW_EXECUTOR_SERVICE_NAME`), `src/services/restate-endpoint.ts` (`buildWorkflowExecutorObject`), `src/services/restate-client.ts` (`startWorkflow`, `cancelWorkflow`), `src/persistence/execution-store.ts` (`parkStep`, `resolveParkedStep`, `getExecutionForLeg`, `runCounter`)
**Impact**: All future async-wait patterns use the parkStep model. The Restate handler returns cleanly after parking; no suspended handlers in the journal. This is the root-cause fix for the Restate 1.6.2 re-dispatch bug (GAP-014). The intermediate awakeable fix (2026-05-18) is superseded.

---

**Category**: pattern
**Learning**: **parkStep pattern** — Steps needing async waits write `{ parkPoint: true, nextStepIds, callbackSecret, ... }` to MongoDB via `ExecutionStore.parkStep()` and return cleanly from the Restate handler. Callback routes read `parkPoint` to choose the tri-path: relay-race (`startWorkflow`) vs legacy awakeable (`resolveAwakeable`) vs legacy shared handler (`resolveCallback`). The `nextStepIds` array is stored so callback routes can dispatch the next relay via `startWorkflow()` without re-reading the DAG.
**Files**: `src/persistence/execution-store.ts` (`parkStep`, `resolveParkedStep`), `src/routes/workflow-callbacks.ts` (tri-path), `src/routes/workflow-approvals.ts`, `src/routes/human-task-resolution.ts`
**Impact**: Any new async-wait step type must implement the parkStep pattern. The callback route reads `parkPoint` to decide the dispatch path; if `parkPoint` is absent, legacy backward-compat paths are used.

---

**Category**: architecture
**Learning**: **Trigger path fix** — All trigger-fired executions go through `relayStartWorkflow()` in `index.ts`. This wrapper creates the MongoDB execution record and dispatches via relay-race. Both direct `/execute` and trigger-fired paths are protected. The wrapper is injected into TriggerEngine, TriggerScheduler, ConnectorTriggerEngine, webhook router, polling worker, and connector webhook router via the `restateClient` argument — the engines themselves are not modified.
**Files**: `src/index.ts` (`relayStartWorkflow`, wiring into 6 trigger points)
**Impact**: When adding new trigger types or execution entry points, wire them through `relayStartWorkflow()` — never call `restateClient.startLegacyWorkflow()` for new executions.

---

**Category**: pattern
**Learning**: **runCounter (formerly legCounter)** — MongoDB field on the execution document for Restate invocation sequence tracking. Incremented atomically by `ExecutionStore.incrementRunCounter()` at the start of each relay slice. Used for diagnostics and idempotency guards, not for correctness. The rename from `legCounter` to `runCounter` was part of the terminology cleanup.
**Files**: `src/persistence/execution-store.ts` (`incrementRunCounter`, field `runCounter`)
**Impact**: The field is internal to the engine; not exposed in API responses. `cleanExecutionDoc()` strips it from all read paths.

---

**Category**: architecture
**Learning**: **Legacy backward-compat** — `startLegacyWorkflow`/`cancelLegacyWorkflow` on `RestateWorkflowClient` kept for in-flight executions created before the relay-race cutover. `RELAY_RACE_DISABLED=true` env var restores legacy path for emergency rollback. The legacy `workflow-runner` `restate.workflow()` service remains registered in `buildRestateEndpoint()` alongside the new `workflow-executor` `restate.object()`.
**Files**: `src/services/restate-client.ts` (`startLegacyWorkflow`, `cancelLegacyWorkflow`), `src/services/restate-endpoint.ts` (dual registration)
**Impact**: After all in-flight legacy executions drain (deploy + inactivity_timeout expiry), the legacy service can be deregistered. Do not remove it prematurely — in-flight Restate invocations would be orphaned.

---

**Category**: testing
**Learning**: **Data flow audit** — Ran 4 rounds for the relay-race refactor. Key findings fixed: `callbackSecret` encrypted at park boundary, `inputSnapshot` stripped from API responses, `legCounter` → `runCounter` not exposed, `cleanExecutionDoc()` applied on all read paths including the hybrid reader. Test updates: `restate-client.test.ts` renamed to `startLegacyWorkflow`/`cancelLegacyWorkflow` and added relay-race `startWorkflow`/`cancelWorkflow` tests (URL contract: `/workflow-executor/{id}/runWorkflow/send`). `execution-store.test.ts` updated `updateExecutionStatus` assertion to per-field `$set` pattern.
**Files**: `src/__tests__/restate-client.test.ts`, `src/__tests__/execution-store.test.ts`
**Impact**: When adding new Restate service methods, add URL-contract tests in `restate-client.test.ts`. When changing persistence field shapes, update `execution-store.test.ts` assertions in the same commit.

## Data-Flow Audit Learnings (2026-05-20)

- **Rate limiter pattern**: Fixed-window per-IP rate limiter (module-level Map, MAX buckets, LRU eviction) used for defence-in-depth on unauthenticated endpoints. Pattern from `diagnose-access.ts`. Export as `createXxxRateLimit()` factory, mount before JSON body parser. Note: module-level Map not cleared between tests — don't add rate limiter to test app unless testing the limiter itself.

- **findBySource projectId**: Always include `projectId` in MongoDB `findBySource` filters alongside `tenantId`. executionId+stepId are UUIDs (practically unique) but projectId adds defense-in-depth for cross-project isolation within same tenant.

- **Stale test signatures**: When adding parameters to a function signature, grep ALL test files (not just route tests) for the old call pattern. `system-human-task-store.test.ts` was missed in the F-5 fix — 4 test cases still use the old 3-arg `findBySource(tenantId, sourceType, filter)` instead of the new 4-arg `findBySource(tenantId, projectId, sourceType, filter)`.

- **STEP_SENSITIVE_FIELDS boundary tests**: Security-critical stripping (callbackSecret, parkPoint, awakeableId, inputSnapshot) has no regression tests. A future developer removing a field from `STEP_SENSITIVE_FIELDS` would not be caught by CI. Add boundary tests that assert these fields are absent from GET /executions API responses.

- **Stale JSDoc route docs**: When a route is intentionally removed, update the JSDoc header in the router file. `workflow-approvals.ts` header still documents a GET listing route that was never implemented.

---

## 2026-05-21 — ABLP-1073 Phase 5: Approval/Data-Entry, Timeout Enforcement, Security Hardening

**Category**: architecture | pattern | gotcha

**Approval/Data-Entry rejection routing**:

- `rejectStepIds` is extracted from `step.onRejectSteps` at park time in `workflow-handler.ts` and stored via `parkStep`. Routes read it from MongoDB — never from request body. Prevents spoofing.
- `isRejection = decision === 'reject' || decision === 'rejected'` — Studio sends past tense on resolve events; normalize both.
- When `isRejection && rejectStepIds.length === 0` → call `updateExecutionStatus('rejected')` to terminal-terminate. Without this, executions stay `running` forever.
- `resolveParkedStep` status derivation: `reject`/`rejected`→`rejected`, `expired`→`failed`, `skipped`→`skipped`, `approved`→`completed`, `output.status=failed`→`failed`, else→`completed`.
- `data_entry` (human-task route) is identical to approval — same 5 behaviors. No reject button in UI so Case B (reject) is N/A.

**Restate-native exact timer (replaces sweeper polling)**:

- Don't use sweeper polling for step timeouts — 60s interval adds visible latency.
- Call `deps.startWorkflow(executionId, { stepTimeoutFor: { stepKey, stepId, expectedStatus, onTimeout, timeoutDecision, nextStepIds } }, { delayMs })` for an exact Restate timer.
- `timeoutDecision`: `'expired'` (→ failed), `'skipped'` (→ skipped), `'approved'` (→ completed).
- Known gap (F-2): the `startWorkflow` for timeout is outside `restateCtx.run()` — duplicate timer on Restate replay. CAS guard in `resolveParkedStep` prevents data corruption. Low priority.

**hasHumanWait + StuckExecutionSweeper**:

- Set `hasHumanWait: true` in `parkStep` for `waiting_approval`/`waiting_human_task`. Clear it in `resolveParkedStep`. Without this, the sweeper kills long-running approval executions.
- Sweeper queries `{ status: 'running', startedAt: { $lt: cutoff }, hasHumanWait: { $ne: true } }`. Default 4h cutoff for ADI/Docling.
- Compound partial index required in schema — Mongoose `ensureIndex` creates it automatically.

**Strip set parity (F-WS-1)**:

- Three sets MUST stay in sync: `STEP_SENSITIVE_FIELDS` (REST), `PUBLISH_SENSITIVE_STEP_FIELDS` (Redis pub-sub), `SNAPSHOT_STEP_SENSITIVE_FIELDS` (WS snapshot).
- All 11 fields: callbackSecret, awakeableId, parkPoint, nextStepIds, rejectStepIds, joinStepId, barrierTotal, barrierCount, barrierFailCount, branchId, failureStrategy.
- When adding new sensitive fields, update ALL THREE sets.

**Relay-race execute route test drift**:

- Route stores full payload via `persistence.createExecution()`, sends lean `{ tenantId, projectId, startFromStepIds }` to Restate.
- Test mocks MUST include `persistence: { createExecution: vi.fn() }` — without it the route falls through to `startLegacyWorkflow`.
- Error code on relay failure: `RELAY_START_FAILED` (not `RESTATE_START_FAILED`).
- Cancel: `cancelWorkflow(executionId, tenantId, projectId)` for relay-race (needs `inputSnapshot` in exec mock), `cancelLegacyWorkflow(executionId)` for legacy.

**Files**: `apps/workflow-engine/src/routes/workflow-approvals.ts`, `apps/workflow-engine/src/routes/human-task-resolution.ts`, `apps/workflow-engine/src/handlers/workflow-handler.ts` (stepTimeoutFor block, PUBLISH_SENSITIVE_STEP_FIELDS), `apps/workflow-engine/src/persistence/execution-store.ts` (hasHumanWait, resolveParkedStep), `apps/workflow-engine/src/services/stuck-execution-sweeper.ts`, `apps/workflow-engine/src/services/human-step-timeout-enforcer.ts`, `apps/runtime/src/websocket/wf-bridge.ts` (SNAPSHOT_STEP_SENSITIVE_FIELDS).
