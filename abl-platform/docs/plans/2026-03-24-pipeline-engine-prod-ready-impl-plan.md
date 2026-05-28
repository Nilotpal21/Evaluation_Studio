# LLD: Pipeline Engine — BETA → STABLE Gap Closure

**Feature**: Pipeline Engine (Production Readiness)
**Status**: DONE (all 4 phases implemented, 5 review rounds complete, 780 tests passing)
**Date**: 2026-03-24
**Feature Spec**: `docs/features/pipeline-engine.md`
**HLD**: `docs/specs/pipeline-engine.hld.md`
**Test Spec**: `docs/testing/pipeline-engine.md`
**Prior LLD**: `docs/plans/pipeline-engine.lld.md` (original implementation, status DONE)

---

## 1. Design Decisions

### Decision Log

| #    | Decision                                                      | Rationale                                                                                                                         | Alternatives Rejected                                                            |
| ---- | ------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| D-1  | Group GAP-011 + GAP-014 into single phase for 7 unwired types | ACTIVITY_TYPES metadata is a prerequisite for SERVICE_HANDLERS wiring — router checks metadata at L179 before dispatch            | Separate phases (would require two passes through same files)                    |
| D-2  | Wire all 7 node types at once (not incrementally)             | All 7 use dynamic imports with MODULE_NOT_FOUND graceful degradation; blast radius limited to pipelines using those types         | Incremental wiring (unnecessary complexity, same risk profile)                   |
| D-3  | Fix `db-query` ClickHouse tenant isolation BEFORE wiring      | ClickHouse query path has no tenant_id filtering — wiring without fix promotes a tenant isolation breach to production            | Wire first, fix later (security risk)                                            |
| D-4  | Bind alert evaluator to Restate + activate via cron           | Service is code-complete (282 lines); cron mirrors PipelineScheduler pattern; alert rules use time-based windows                  | Leave dormant (delays GAP-004 closure), event-driven (overdesign)                |
| D-5  | Extend alert evaluator for pipeline failure alerting          | Avoids duplicating notification infrastructure (cooldown, multi-channel delivery already implemented)                             | Separate notification mechanism (DRY violation)                                  |
| D-6  | Create separate AlertEvaluationScheduler virtual object       | Alert evaluation is not a "pipeline schedule" — conflating concerns in PipelineScheduler mixes keying strategies                  | Reuse PipelineScheduler (semantic mismatch, confusing key space)                 |
| D-7  | Make alert evaluator `stepContext` optional for failure hook  | `execute()` only reads `config.tenantId/projectId`; `stepContext` is unused — making it optional avoids fragile stub construction | New handler (overdesign), full stub (fragile)                                    |
| D-8  | Add ACTIVITY_TYPES for inline control-flow types              | Needed for Studio Node Palette visibility via `listActivityTypes()`; marker `executionModel: 'control-flow'` prevents confusion   | Omit (Studio wouldn't show these valid node types)                               |
| D-9  | Accept GAP-010 (ClickHouse test) with documented rationale    | Analytics queries tested with mocked client; real ClickHouse verified in staging; CI infrastructure not available                 | Testcontainers (CI dependency not guaranteed)                                    |
| D-10 | Defer GAP-013 (tag rule evaluation) — out of scope            | Feature spec explicitly states "evaluation logic is external to pipeline-engine"; schema exists for future consumers              | Implement in pipeline-engine (wrong ownership)                                   |
| D-11 | Defer GAP-002 (Studio execution history UI)                   | UI enhancement, not correctness issue; run records queryable via API/MongoDB                                                      | Implement now (scope creep, not a STABLE blocker)                                |
| D-12 | Defer GAP-003 (Studio graph save workflow)                    | Advanced feature; built-in pipelines cover all 10 analytics types; custom editing is secondary                                    | Implement now (scope creep)                                                      |
| D-13 | Fix 3 pre-existing missing `.bind()` calls alongside new ones | `computeGoalCompletionService`, `httpRequestService`, `readMessageWindowService` are in SERVICE_HANDLERS but not `.bind()`-ed     | Leave unfixed (inconsistency, risk if services use ctx.serviceClient internally) |

### Key Interfaces & Types

No new types are introduced. All work uses existing interfaces:

```typescript
// Existing — used as-is
interface ActivityTypeMetadata {
  name: string;
  description: string;
  configSchema: { required: string[]; properties: Record<string, { type: string; description: string; ... }> };
  outputSchema: { properties: Record<string, { type: string; description: string }> };
  defaultTimeout: number;
  defaultRetries: number;
}

// Existing SERVICE_HANDLERS signature — new entries follow same pattern
const SERVICE_HANDLERS: Record<
  string,
  (ctx: restate.Context, input: PipelineStepContext) => Promise<StepOutput>
>;
```

### Module Boundaries

No new modules. All changes are wiring additions to existing modules:

| Module                   | Change                                                                       | Dependencies Added  |
| ------------------------ | ---------------------------------------------------------------------------- | ------------------- |
| Activity Router          | +7 SERVICE_HANDLERS entries, +7 imports                                      | 7 service files     |
| Activity Metadata        | +10 ACTIVITY_TYPES entries (7 unwired + 3 control-flow)                      | None                |
| Server                   | +12 `.bind()` calls (7 new + 3 pre-existing + alert evaluator + scheduler)   | 12 service files    |
| DB Query Service         | ClickHouse tenant isolation + SQL safety (reuse `validateSQL` from nl-query) | nl-query.service.ts |
| Sub-Pipeline Service     | Fix built-in definition access (`$in: ['__platform__', tenantId]`)           | None                |
| Alert Evaluator Service  | Make `stepContext` optional in `execute()` input                             | None                |
| AlertEvaluationScheduler | New Restate virtual object for alert cron (separate from PipelineScheduler)  | Alert Evaluator     |
| Pipeline Run Workflow    | Add post-run failure alert hook in BOTH legacy + graph mode paths            | Alert Evaluator     |

---

## 2. File-Level Change Map

All paths below are relative to `packages/pipeline-engine/`.

### Modified Files

| File                                               | Change Description                                                                | Risk |
| -------------------------------------------------- | --------------------------------------------------------------------------------- | ---- |
| `src/pipeline/handlers/activity-router.service.ts` | Add 7 imports + 7 SERVICE_HANDLERS entries for unwired node types                 | Low  |
| `src/pipeline/activity-metadata.ts`                | Add 10 ACTIVITY_TYPES entries (7 unwired + 3 inline control-flow)                 | Low  |
| `src/pipeline/server.ts`                           | Add 12 `.bind()` calls (7 new + 3 pre-existing + alertEvaluator + alertScheduler) | Low  |
| `src/pipeline/services/db-query.service.ts`        | Add ClickHouse tenant_id/project_id enforcement + SQL safety (reuse validateSQL)  | High |
| `src/pipeline/services/sub-pipeline.service.ts`    | Fix findOne to include `__platform__` tenantId for built-in definitions           | Med  |
| `src/pipeline/services/alert-evaluator.service.ts` | Make `stepContext` optional in execute input (only `config` is used)              | Low  |
| `src/pipeline/handlers/pipeline-run.workflow.ts`   | Add post-run failure alert hook                                                   | Med  |
| `docs/features/pipeline-engine.md`                 | Update GAP-011/GAP-014 status, update status toward STABLE                        | Low  |
| `docs/plans/pipeline-engine.lld.md`                | Cross-reference to this plan                                                      | Low  |

### New Files

| File                                                   | Purpose                                                  | LOC Estimate |
| ------------------------------------------------------ | -------------------------------------------------------- | ------------ |
| `src/pipeline/handlers/alert-evaluation-scheduler.ts`  | Restate virtual object for alert evaluation cron         | ~80          |
| `src/__tests__/unwired-node-dispatch.test.ts`          | Activity router dispatch tests for 7 newly-wired types   | ~200         |
| `src/__tests__/sub-pipeline.test.ts`                   | Sub-pipeline service unit tests (depth guard, mapping)   | ~120         |
| `src/__tests__/db-query.test.ts`                       | DB query service unit tests (MongoDB + ClickHouse paths) | ~100         |
| `src/__tests__/filter-service.test.ts`                 | Filter service unit tests                                | ~80          |
| `src/__tests__/aggregate-service.test.ts`              | Aggregate service unit tests                             | ~80          |
| `src/__tests__/send-email.test.ts`                     | Send email unit tests (webhook + graceful degradation)   | ~80          |
| `src/__tests__/send-slack.test.ts`                     | Send slack unit tests (webhook + graceful degradation)   | ~80          |
| `src/__tests__/publish-kafka.test.ts`                  | Publish kafka unit tests (graceful degradation)          | ~80          |
| `src/__tests__/alert-evaluator-activation.test.ts`     | Alert evaluator cron + pipeline failure alert tests      | ~120         |
| `src/__tests__/activity-metadata-completeness.test.ts` | Verify all SERVICE_HANDLERS have ACTIVITY_TYPES entries  | ~40          |

### Deleted Files

None.

---

## 3. Implementation Phases

### Phase 1: Security Fix + Wire 7 Node Types + Complete ACTIVITY_TYPES Metadata

**Goal**: Fix `db-query` ClickHouse tenant isolation vulnerability (CRITICAL prerequisite), then close GAP-011 (HIGH) and GAP-014 (LOW) — make all node types dispatchable at runtime and visible in Studio.

**Tasks**:

1.1. **[CRITICAL PREREQUISITE]** Fix `db-query` ClickHouse tenant isolation in `src/pipeline/services/db-query.service.ts`:

- **ClickHouse path**: The `executeClickHouseQuery()` function (lines 70-83) accepts user-provided queries and executes them against ClickHouse with NO `tenant_id` or `project_id` filtering. Update function signature from `(query, limit)` to `(query, limit, tenantId, projectId)`.
- **MongoDB path**: The `executeMongoDBQuery()` function (line 106) sets `filter.tenantId` but NOT `filter.projectId`. Add `filter.projectId = projectId` after line 106. Update function signature at line 86 to accept `projectId` as a 5th parameter.
- **Reuse existing validation**: Import `validateSQL` (or extract shared `validateSQLSafety`) from `nl-query.service.ts` (line 55) which already implements FORBIDDEN_PATTERNS, SELECT-only enforcement, and tenant_id checks. Do NOT reimplement — DRY principle.
- **Parameterized tenant isolation**: Inject mandatory `AND tenant_id = {tenantId:String} AND project_id = {projectId:String}` before any existing LIMIT clause using ClickHouse `query_params: { tenantId, projectId, limit }`. This matches the existing pattern in `nl-query.service.ts` (L138-143) and `alert-evaluator.service.ts` (L144-146).
- **Sanitize error messages**: Replace raw query interpolation in error returns (lines 62 and 101: `Invalid MongoDB filter JSON: ${query}`) with a generic message. Move raw query to log-only context: `log.warn('Invalid query', { query })`.
- This MUST be done BEFORE wiring `db-query` into SERVICE_HANDLERS (Task 1.3) — wiring without this fix promotes a tenant isolation breach to production.
- HLD section 5.1 states: "All ClickHouse queries include `tenant_id` parameter."

  1.2. Fix `sub-pipeline` built-in definition access in `src/pipeline/services/sub-pipeline.service.ts`:

- Line 44 queries `PipelineDefinitionModel.findOne({ _id: pipelineId, tenantId: pipelineInput.tenantId })` — this prevents sub-pipelines from referencing built-in definitions which have `tenantId: '__platform__'`.
- Fix: Change to `tenantId: { $in: ['__platform__', pipelineInput.tenantId] }` matching the pattern in `pipeline-trigger.service.ts` line 324.

  1.3. Add 10 ACTIVITY_TYPES entries to `src/pipeline/activity-metadata.ts`:

- 7 unwired types: `sub-pipeline`, `db-query`, `filter`, `aggregate`, `send-email`, `send-slack`, `publish-kafka`
- 3 inline control-flow types: `node-group`, `wait-for-event`, `delay` — these are handled inline by the activity router (lines 126-177) before the metadata lookup. Do NOT add an `executionModel` field (the `ActivityTypeMetadata` interface does not have this field). Instead, note their control-flow nature in the `description` field: "Control-flow type: handled inline by ActivityRouter, not dispatched via SERVICE_HANDLERS."
- Each entry must have: name, description, configSchema (required fields + properties), outputSchema, defaultTimeout, defaultRetries
- Read each service file to determine actual config requirements and output shapes

  1.4. Add 7 imports + 7 SERVICE_HANDLERS entries to `src/pipeline/handlers/activity-router.service.ts`:

- Import: `subPipelineService`, `dbQueryService`, `filterService`, `aggregateService`, `sendEmailService`, `sendSlackService`, `publishKafkaService`
- Add entries: `'sub-pipeline'`, `'db-query'`, `'filter'`, `'aggregate'`, `'send-email'`, `'send-slack'`, `'publish-kafka'`
- Follow existing pattern: `(service as any).service.execute`

  1.5. Add 10 `.bind()` calls to `src/pipeline/server.ts` (Phase 3 adds 2 more for alerting):

- Import the 7 new service modules + 3 pre-existing unbound services
- **7 new**: `.bind(subPipelineService)`, `.bind(dbQueryService)`, `.bind(filterService)`, `.bind(aggregateService)`, `.bind(sendEmailService)`, `.bind(sendSlackService)`, `.bind(publishKafkaService)`
- **3 pre-existing missing** (already in SERVICE_HANDLERS, never `.bind()`-ed): `.bind(computeGoalCompletionService)`, `.bind(httpRequestService)`, `.bind(readMessageWindowService)`
- Place new ones in a commented section: `// Extended node types`
- Place pre-existing fixes inline near existing `.bind()` calls

  1.6. Write `src/__tests__/activity-metadata-completeness.test.ts`:

- Test that every key in SERVICE_HANDLERS (excluding aliases like `call-llm`) has a corresponding ACTIVITY_TYPES entry
- Test that every ACTIVITY_TYPES entry has required fields (name, description, configSchema, outputSchema, defaultTimeout, defaultRetries)
- This prevents future wiring gaps

  1.7. Write `src/__tests__/unwired-node-dispatch.test.ts`:

- Test that activity router dispatches to each of the 7 newly-wired types
- Use the existing test pattern from `activity-router.test.ts` — mock Restate context, call execute handler with each activity type
- Verify each returns a valid StepOutput (status: 'success' | 'fail', data: object)
- Include a test for `db-query` ClickHouse path that verifies tenant_id enforcement

**Files Touched**:

- `src/pipeline/services/db-query.service.ts` — security fix (tenant isolation + SQL safety via shared `validateSQL`)
- `src/pipeline/services/sub-pipeline.service.ts` — fix `findOne` to include `__platform__` tenantId
- `src/pipeline/activity-metadata.ts` — add 10 entries
- `src/pipeline/handlers/activity-router.service.ts` — add 7 imports + 7 SERVICE_HANDLERS entries
- `src/pipeline/server.ts` — add 10 `.bind()` calls (7 new + 3 pre-existing)
- `src/__tests__/activity-metadata-completeness.test.ts` — new
- `src/__tests__/unwired-node-dispatch.test.ts` — new

**Exit Criteria**:

- [x] `db-query` ClickHouse path enforces `tenant_id` and `project_id` via parameterized `query_params`
- [x] `db-query` MongoDB path enforces `projectId` in filter (in addition to existing `tenantId`)
- [x] `db-query` ClickHouse path rejects DDL/DML queries (reuses `validateSQL` from nl-query)
- [x] `db-query` error messages do not interpolate raw user query strings
- [x] `sub-pipeline` can reference built-in definitions (`__platform__` tenantId)
- [x] All 10 ACTIVITY_TYPES entries present with complete metadata (verified by completeness test)
- [x] All 7 SERVICE_HANDLERS entries present and dispatching correctly (verified by dispatch test)
- [x] All 10 `.bind()` calls added to server.ts (7 new + 3 pre-existing)
- [x] `pnpm build --filter=@abl/pipeline-engine` succeeds with 0 errors
- [x] `pnpm test --filter=@abl/pipeline-engine` passes (all existing + new tests)
- [x] Existing activity router tests still pass (no regression)

**Test Strategy**:

- Unit: `activity-metadata-completeness.test.ts` verifies metadata registry completeness
- Unit: `unwired-node-dispatch.test.ts` verifies dispatch routing for 7 types + db-query tenant isolation
- Regression: All existing tests pass unchanged

**Rollback**: Remove the 7 SERVICE_HANDLERS entries, 7 imports, 10 ACTIVITY_TYPES entries, and 10 `.bind()` calls. Revert db-query.service.ts security fix (though this should never be reverted). All wiring changes are additive — removal restores prior state exactly.

---

### Phase 2: Unit Tests for 7 Node Type Services

**Goal**: Ensure each of the 7 services works correctly in isolation, including graceful degradation for external dependencies.

**Tasks**:

2.1. Write `__tests__/sub-pipeline.test.ts`:

- Test happy path: calls `ctx.serviceClient(pipelineRun).run()` with correct arguments
- Test depth guard: rejects when `_subPipelineDepth >= MAX_SUB_PIPELINE_DEPTH` (3)
- Test input mapping: verifies `applyMapping` helper maps fields correctly
- Test missing pipelineId validation

  2.2. Write `__tests__/db-query.test.ts`:

- Test MongoDB query path: constructs and executes Mongoose query with tenant scoping
- Test ClickHouse query path: constructs parameterized query
- Test validation: rejects missing `database` or `query` config (config field is `database`, not `queryType`)
- Test tenant isolation: verifies tenantId and projectId are always included in both ClickHouse and MongoDB queries

  2.3. Write `__tests__/filter-service.test.ts`:

- Test expression-based filtering: passes data through expression evaluator
- Test array filtering: filters array input based on conditions
- Test empty input handling

  2.4. Write `__tests__/aggregate-service.test.ts`:

- Test aggregation operations: sum, count, avg, min, max, collect
- Test empty dataset handling
- Test field path resolution

  2.5. Write `__tests__/send-email.test.ts`:

- Test graceful degradation: MODULE_NOT_FOUND returns `{ status: 'fail', data: { error: 'Email integration not available...' } }`
- Test validation: rejects missing `to` or `subject` config
- Test template rendering in email body (if applicable)

  2.6. Write `__tests__/send-slack.test.ts`:

- Test webhook path: sends POST to webhook URL with message payload (mock fetch)
- Test graceful degradation: MODULE_NOT_FOUND for `@agent-platform/notifications/slack`
- Test validation: rejects missing `channel` or `message` config

  2.7. Write `__tests__/publish-kafka.test.ts`:

- Test graceful degradation: MODULE_NOT_FOUND for `@agent-platform/messaging/kafka`
- Test validation: rejects missing `topic` or `payload` config
- Test message serialization

**Files Touched**:

- `src/__tests__/sub-pipeline.test.ts` — new
- `src/__tests__/db-query.test.ts` — new
- `src/__tests__/filter-service.test.ts` — new
- `src/__tests__/aggregate-service.test.ts` — new
- `src/__tests__/send-email.test.ts` — new
- `src/__tests__/send-slack.test.ts` — new
- `src/__tests__/publish-kafka.test.ts` — new

**Exit Criteria**:

- [x] Each of the 7 test files passes independently
- [x] External dependency tests verify graceful degradation (send-email, send-slack, publish-kafka)
- [x] Sub-pipeline depth guard test passes (rejects at depth 3)
- [x] DB query tenant isolation test passes
- [x] `pnpm test --filter=@abl/pipeline-engine` passes (all existing + new tests)

**Test Strategy**:

- Unit: Each service tested with mocked Restate context (`ctx.run` passthrough)
- External third-party deps mocked via `vi.mock()` of the dynamic import paths (e.g., `vi.mock('@agent-platform/notifications/slack')`) — these are external packages not in the monorepo, so mocking is permitted per E2E test standards. The services use `import(modulePath)` dynamic imports, not constructor DI.
- `send-slack` webhook path tested with a mock HTTP server (intercept `fetch` calls)

**Rollback**: Delete the 7 new test files. No production code changes in this phase.

---

### Phase 3: Alert Evaluator Activation + Pipeline Failure Alerting

**Goal**: Close GAP-004 (MEDIUM) — bind alert evaluator to Restate and add pipeline failure alerting.

**Tasks**:

3.1. Make `stepContext` optional in `alertEvaluatorService` input:

- In `src/pipeline/services/alert-evaluator.service.ts`, change the `execute()` input type to make `stepContext` optional
- The service only reads `input.config.tenantId` and `input.config.projectId` — `stepContext` is unused in the current implementation
- This allows the pipeline-run workflow to call the evaluator with just `{ config: { tenantId, projectId } }` without constructing a fragile PipelineStepContext stub

  3.2. Bind `alertEvaluatorService` in `src/pipeline/server.ts`:

- Import `alertEvaluatorService` from `./services/alert-evaluator.service.js`
- Add `.bind(alertEvaluatorService)` to the Restate endpoint chain
- Place in a commented section: `// Alert evaluation`

  3.3. Create `src/pipeline/handlers/alert-evaluation-scheduler.ts` — a new Restate virtual object:

- Separate from `PipelineScheduler` (different concern: alert evaluation cross-cuts all pipelines, not per-pipeline scheduling)
- Keyed by `${tenantId}` to provide single-writer guarantee per tenant
- Handler `start`: begins durable sleep + loop pattern (configurable interval, default 5 minutes)
- Handler `stop`: cancels the evaluation loop
- Each iteration: loads enabled alert rules for the tenant from MongoDB, calls `alertEvaluatorService.execute()` for each project with rules
- Bind this virtual object in `server.ts`

  3.4. Add post-run failure alert hook to `src/pipeline/handlers/pipeline-run.workflow.ts`:

- Import `alertEvaluatorService` from `../services/alert-evaluator.service.js`
- **BOTH execution paths** must have the hook — pipeline-run.workflow.ts has two independent finalize sections:
  - **Legacy mode**: `run` handler finalization (~lines 247-276)
  - **Graph mode**: `runGraphMode` function finalization (~lines 398-416)
- Extract a helper: `fireFailureAlertIfNeeded(ctx, overallStatus, tenantId, projectId)` to avoid duplication
- Use `ctx.serviceSendClient(alertEvaluatorService).execute(...)` (fire-and-forget) instead of `ctx.serviceClient` — avoids adding latency to pipeline finalization while still being durable (Restate guarantees delivery)
- Input: `{ config: { tenantId, projectId } }` — now possible because `stepContext` is optional (Task 3.1)
- Wrap in try/catch — alert evaluation failure must NOT cause the pipeline run to fail

  3.5. Write `src/__tests__/alert-evaluator-activation.test.ts`:

- Test that alertEvaluatorService is bound (verify it appears in server registration)
- Test AlertEvaluationScheduler: mock durable sleep, verify evaluation is triggered per-tenant
- Test pipeline failure hook: mock run failure, verify alert evaluation is called with correct tenant/project
- Test that alert evaluation failure in the hook does not propagate to the pipeline run
- Test cooldown: verify duplicate alerts are suppressed within cooldown window

**Files Touched**:

- `src/pipeline/services/alert-evaluator.service.ts` — make `stepContext` optional
- `src/pipeline/server.ts` — add `.bind(alertEvaluatorService)` + `.bind(alertEvaluationScheduler)` + imports
- `src/pipeline/handlers/alert-evaluation-scheduler.ts` — new Restate virtual object
- `src/pipeline/handlers/pipeline-run.workflow.ts` — add failure alert hook
- `src/__tests__/alert-evaluator-activation.test.ts` — new

**Exit Criteria**:

- [x] `alertEvaluatorService` bound to Restate endpoint in server.ts
- [x] `AlertEvaluationScheduler` virtual object created and bound
- [x] Alert cron handler runs per-tenant with single-writer guarantee
- [x] Pipeline failure triggers alert evaluation (non-blocking)
- [x] `pnpm build --filter=@abl/pipeline-engine` succeeds
- [x] `pnpm test --filter=@abl/pipeline-engine` passes
- [x] No regression in existing pipeline run workflow tests

**Test Strategy**:

- Unit: AlertEvaluationScheduler with mocked Restate context and MongoDB
- Unit: Pipeline failure hook with mocked ctx.serviceClient
- Unit: Alert evaluator accepts `{ config: { tenantId, projectId } }` without stepContext
- Integration: Alert evaluation chain (cron → evaluator → rule check) with mocked ClickHouse

**Rollback**: Remove `.bind(alertEvaluatorService)`, remove `.bind(alertEvaluationScheduler)`, delete `alert-evaluation-scheduler.ts`, remove failure hook, revert `stepContext` optionality. Alert evaluator returns to dormant state.

---

### Phase 4: Documentation Sync + Gap Acceptance

**Goal**: Update all documentation to reflect changes, accept deferred gaps with rationale, prepare for STABLE qualification.

**Tasks**:

4.1. Update feature spec `docs/features/pipeline-engine.md`:

- Mark GAP-011 as Resolved: "7 node types wired into SERVICE_HANDLERS, ACTIVITY_TYPES, and server.ts .bind()"
- Mark GAP-014 as Resolved: "All activity types have ACTIVITY_TYPES metadata entries"
- Mark GAP-004 as Resolved: "Alert evaluator bound to Restate, cron-triggered, pipeline failure hook added"
- Add acceptance rationale for deferred gaps:
  - GAP-002: "Execution history accessible via MongoDB/API; Studio UI is a UX enhancement"
  - GAP-003: "Custom pipeline editing is an advanced feature; built-in pipelines cover all 10 analytics types"
  - GAP-009: "Cron scheduling manually verified; automated test requires Restate test infrastructure"
  - GAP-010: "Analytics queries integration-tested with mocked client; real ClickHouse verified in staging"
  - GAP-013: "Tag rule evaluation is documented as out-of-scope for pipeline-engine; schema exists for future consumer"
- Update delivery plan items 14.1/14.2 status

  4.2. Update test spec `docs/testing/pipeline-engine.md`:

- Add rows for new test files (7 unit test files, 2 new test files from Phase 1, 1 alert test file)
- **Add FR-14 through FR-19 to Functional Requirements Coverage table**: The test spec currently maps only FR-1 through FR-13. The feature spec defines FR-14 (NL Query), FR-15 (ROI), FR-16 (Alerting), FR-17 (Outcome Classification), FR-18 (Experiments), FR-19 (Inline Control Flow). Add rows for each, documenting their actual coverage status (most have unit tests; FR-16 alerting gains new test coverage from this plan).
- Update coverage matrix

  4.3. Update existing LLD `docs/plans/pipeline-engine.lld.md`:

- Add cross-reference to this plan in a new section
- Update Gap 1 (E2E) and Gap 2 (isolation) if now resolved

  4.4. Update testing index `docs/testing/README.md`:

- Update pipeline-engine row if status changes

  4.5. Evaluate STABLE criteria from `docs/sdlc/pipeline.md`:

- All E2E scenarios passing (5+) ✅
- All integration scenarios passing (5+) ✅
- No open CRITICAL or HIGH gaps ✅ (GAP-011 resolved)
- MEDIUM gaps resolved or accepted with documented rationale ✅
- Security & isolation tests passing ✅
- All docs marked as current ✅ (after this phase)
- Coverage matrix: Green for core pipeline (FR-1 through FR-13) and newly-closed gaps. FR-14 through FR-19 (standalone services added during audit) have unit test coverage; pre-existing E2E gaps (eval pipeline lifecycle) accepted with rationale.

**Files Touched**:

- `docs/features/pipeline-engine.md` — gap status updates, acceptance rationale
- `docs/testing/pipeline-engine.md` — coverage matrix updates
- `docs/plans/pipeline-engine.lld.md` — cross-reference
- `docs/testing/README.md` — status update

**Exit Criteria**:

- [x] All resolved gaps marked as such in feature spec
- [x] All deferred gaps have documented acceptance rationale
- [x] Test spec coverage matrix reflects actual test coverage
- [x] STABLE criteria evaluation documented
- [x] `npx prettier --write` passes on all changed docs

**Test Strategy**:

- Manual: Verify all gap statuses match reality
- Automated: Grep for "Open" in gap table, verify only accepted gaps remain open

**Rollback**: Revert doc changes. Documentation is independent of code changes.

---

## 4. Wiring Checklist

CRITICAL: Every new component must be wired into its callers.

- [x] `sub-pipeline` registered in ACTIVITY_TYPES metadata
- [x] `sub-pipeline` registered in SERVICE_HANDLERS dispatch table
- [x] `subPipelineService` `.bind()` in `server.ts`
- [x] `db-query` registered in ACTIVITY_TYPES metadata
- [x] `db-query` registered in SERVICE_HANDLERS dispatch table
- [x] `dbQueryService` `.bind()` in `server.ts`
- [x] `filter` registered in ACTIVITY_TYPES metadata
- [x] `filter` registered in SERVICE_HANDLERS dispatch table
- [x] `filterService` `.bind()` in `server.ts`
- [x] `aggregate` registered in ACTIVITY_TYPES metadata
- [x] `aggregate` registered in SERVICE_HANDLERS dispatch table
- [x] `aggregateService` `.bind()` in `server.ts`
- [x] `send-email` registered in ACTIVITY_TYPES metadata
- [x] `send-email` registered in SERVICE_HANDLERS dispatch table
- [x] `sendEmailService` `.bind()` in `server.ts`
- [x] `send-slack` registered in ACTIVITY_TYPES metadata
- [x] `send-slack` registered in SERVICE_HANDLERS dispatch table
- [x] `sendSlackService` `.bind()` in `server.ts`
- [x] `publish-kafka` registered in ACTIVITY_TYPES metadata
- [x] `publish-kafka` registered in SERVICE_HANDLERS dispatch table
- [x] `publishKafkaService` `.bind()` in `server.ts`
- [x] `node-group` registered in ACTIVITY_TYPES metadata (control-flow marker)
- [x] `wait-for-event` registered in ACTIVITY_TYPES metadata (control-flow marker)
- [x] `delay` registered in ACTIVITY_TYPES metadata (control-flow marker)
- [x] `computeGoalCompletionService` `.bind()` in `server.ts` (pre-existing fix)
- [x] `httpRequestService` `.bind()` in `server.ts` (pre-existing fix)
- [x] `readMessageWindowService` `.bind()` in `server.ts` (pre-existing fix)
- [x] `db-query` ClickHouse tenant isolation enforced via parameterized `query_params` (CRITICAL)
- [x] `db-query` MongoDB path enforces `projectId` in filter
- [x] `db-query` ClickHouse SQL safety validation (reuses `validateSQL` from nl-query)
- [x] `db-query` error messages sanitized (no raw query interpolation)
- [x] `sub-pipeline` findOne includes `__platform__` tenantId for built-in definitions
- [x] `alertEvaluatorService` `stepContext` made optional in execute input
- [x] `alertEvaluatorService` `.bind()` in `server.ts`
- [x] `AlertEvaluationScheduler` virtual object created and `.bind()` in `server.ts`
- [x] Pipeline failure hook wired in `pipeline-run.workflow.ts` (non-blocking try/catch)
- [x] All new test files importable and passing
- [x] `activity-metadata-completeness.test.ts` enforces ongoing wiring completeness

---

## 5. Cross-Phase Concerns

### External Dependency Handling

The 3 services with external dependencies (`send-email`, `send-slack`, `publish-kafka`) use dynamic imports with `MODULE_NOT_FOUND` error handling. When the external packages are not installed:

- Services return `{ status: 'fail', data: { error: '<Integration> not available...' } }`
- The activity router wraps all handlers in try/catch — no crash propagation
- Pipeline definitions using these nodes should set `onFailure: 'skip'` or `'continue'` if the infrastructure is optional
- `send-slack` has a webhook fallback path using native `fetch` that works without any external package

### Configuration Changes

No new env vars or config keys. The alert evaluation cron interval should use the existing pipeline scheduler configuration pattern (configurable per tenant/project).

### Feature Flags

None needed. All changes are additive:

- New SERVICE_HANDLERS entries only activate when a pipeline definition uses the corresponding node type
- Existing built-in pipelines do not use any of the 7 newly-wired types
- Alert evaluator activation is opt-in (requires enabled alert rules in MongoDB)

---

## 6. Acceptance Criteria (Whole Feature — STABLE Qualification)

- [x] All phases complete with exit criteria met
- [x] `db-query` ClickHouse tenant isolation vulnerability fixed (CRITICAL prerequisite)
- [x] GAP-011 (HIGH) resolved: 7 node types wired and dispatchable
- [x] GAP-014 (LOW) resolved: All activity types have ACTIVITY_TYPES metadata
- [x] GAP-004 (MEDIUM) resolved: Alert evaluator active with cron + failure hooks
- [x] Deferred gaps (002, 003, 009, 010, 013) have documented acceptance rationale
- [x] No open CRITICAL or HIGH gaps remain
- [x] All existing tests pass (no regressions)
- [x] New tests pass: 7 unit test files + 2 infrastructure test files + 1 alert test file
- [x] `pnpm build --filter=@abl/pipeline-engine` succeeds with 0 errors
- [x] `pnpm test --filter=@abl/pipeline-engine` passes all tests
- [x] Feature spec updated with resolved/accepted gap statuses
- [x] Test spec coverage matrix updated
- [x] All changed files pass `npx prettier --write`

---

## 7. Open Questions

1. ~~Should the alert evaluation cron interval be tenant-configurable or a fixed platform default (5 minutes)?~~ **Resolved**: Default 5 minutes, passed as input to `AlertEvaluationScheduler.start()` (matching PipelineScheduler input pattern). Tenant-configurable as a future enhancement.
2. ~~Should `db-query` allow arbitrary MongoDB aggregation pipelines, or restrict to find/findOne operations for safety?~~ **Resolved**: Current implementation only supports `find()` with JSON filter (lines 86-115 of `db-query.service.ts`). Aggregation pipeline support would be a future enhancement.
3. When `send-email`/`send-slack`/`publish-kafka` fail due to missing external packages, should the pipeline run record include a warning that the integration is not configured?
4. ~~Sub-pipeline `findOne` uses `tenantId: pipelineInput.tenantId` but does NOT use `$in: ['__platform__', tenantId]` for built-in definitions.~~ **Resolved**: Elevated to Task 1.2 — fix to use `{ $in: ['__platform__', tenantId] }` matching pipeline-trigger.service.ts pattern.

---

## 8. Deferred Gaps — Acceptance Rationale

These gaps are accepted for STABLE with documented rationale per `docs/sdlc/pipeline.md` BETA→STABLE criteria ("MEDIUM gaps resolved or accepted with documented rationale"):

| Gap     | Severity | Acceptance Rationale                                                                                                                                                                                       |
| ------- | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GAP-002 | Medium   | Execution history is persisted in MongoDB `pipeline_run_records` and queryable via API. Studio UI is a UX enhancement, not a production-readiness requirement.                                             |
| GAP-003 | Medium   | Custom pipeline editing is an advanced feature. All 10 built-in analytics pipeline types work end-to-end. Custom graph definitions are a post-STABLE enhancement.                                          |
| GAP-008 | Low      | Human review workflow for eval judgements — schema supports `needsHumanReview` flag but no UI. Low-priority UX feature, not a correctness gap.                                                             |
| GAP-009 | Medium   | Cron scheduling has been manually verified in development. Automated testing requires Restate runtime infrastructure not available in CI.                                                                  |
| GAP-010 | Medium   | Analytics queries are parameterized and tested with mocked ClickHouse client at unit level. Real ClickHouse integration verified in staging. Automated testing deferred to CI infrastructure availability. |
| GAP-013 | Medium   | Tag rule evaluation is documented as external to pipeline-engine (feature spec §9: "evaluation logic is external"). Schema exists for future consumers. The `tags` feature owns evaluation logic.          |
