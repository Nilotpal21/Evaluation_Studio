# LLD & Implementation Plan: Workflows & Human Tasks

> **Feature ID**: #48
> **Status**: PLANNED
> **Created**: 2026-03-23
> **Last Updated**: 2026-03-23
> **Depends On**: Feature Spec, Test Spec, HLD

---

## 1. Current State Assessment

### What Exists (ALPHA)

The Workflows & Human Tasks feature has substantial implementation across multiple packages:

| Component                              | LOC    | Tests   | Status              |
| -------------------------------------- | ------ | ------- | ------------------- |
| Workflow Engine (apps/workflow-engine) | ~5,000 | 36 unit | Working, no E2E     |
| WorkflowRuntime (compiler)             | ~1,100 | 0       | Working, standalone |
| Shared Types (shared-kernel)           | ~225   | 0       | Stable              |
| Zod Schemas (shared)                   | ~175   | 0       | Stable              |
| Database Models                        | ~600   | 0       | Stable              |
| Studio API Client + Hooks              | ~165   | 0       | Working             |
| Studio API Routes                      | ~300   | 0       | Working, no auth    |

### Key Gaps to BETA

1. **No E2E tests** (GAP-01) -- 36 unit tests but zero through-API tests
2. **No project-level RBAC** (GAP-05) -- routes lack requireProjectPermission()
3. **No audit logging** (GAP-10) -- workflow lifecycle events not logged
4. **Expression sanitization** (GAP-08) -- prototype pollution risk
5. **Type alignment** (HLD 3.3) -- shared-kernel (9 types) vs database (12 types) vs Zod (9 types)
6. **Workflow CRUD routes** (GAP-09) -- missing from workflow-engine
7. **In-memory store violations** (GAP-02) -- no max size, TTL, eviction
8. **Console logging** (GAP-03) -- handler uses console instead of createLogger
9. **Notification channels** (GAP-06) -- dispatcher exists but channels are TODO
10. **Rate limiting** (GAP-07) -- no per-tenant rate limits on execution start

---

## 2. Implementation Phases

### Phase 1: Security & Compliance Hardening (P0)

**Objective**: Close security gaps and add audit logging before BETA promotion.

#### Tasks

| ID  | Task                                                                             | File(s)                                                                                                                                                                 | Effort |
| --- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| 1.1 | Add `requireProjectPermission` to all project-scoped routes                      | `apps/workflow-engine/src/routes/workflow-executions.ts`, `human-task-resolution.ts`, `workflow-approvals.ts`, `triggers.ts`, `connections.ts`, `notification-rules.ts` | M      |
| 1.2 | Add audit logging for workflow lifecycle events                                  | `apps/workflow-engine/src/handlers/workflow-handler.ts`                                                                                                                 | M      |
| 1.3 | Sanitize expression resolver against prototype pollution                         | `apps/workflow-engine/src/context/expression-resolver.ts`                                                                                                               | S      |
| 1.4 | Replace console logging with createLogger in workflow-handler                    | `apps/workflow-engine/src/handlers/workflow-handler.ts`                                                                                                                 | S      |
| 1.5 | Add per-tenant rate limiting on execution start                                  | `apps/workflow-engine/src/routes/workflow-executions.ts`                                                                                                                | M      |
| 1.6 | Add identity enforcement to approval route (match human-task-resolution pattern) | `apps/workflow-engine/src/routes/workflow-approvals.ts`                                                                                                                 | S      |

#### Exit Criteria

- [ ] All project-scoped routes call `requireProjectPermission` with appropriate permissions
- [ ] Workflow start, completion, failure, and cancellation emit audit log entries
- [ ] Expression resolver rejects paths containing `__proto__`, `constructor`, `prototype`
- [ ] No console.log/warn/error in workflow-engine server code
- [ ] Execution start route enforces per-tenant rate limit
- [ ] Approval route derives decidedBy from auth context (not request body)

#### Verification

```bash
# Grep for remaining console usage
grep -r 'console\.' apps/workflow-engine/src/ --include='*.ts' | grep -v node_modules | grep -v '.test.'

# Grep for requireProjectPermission usage
grep -r 'requireProjectPermission' apps/workflow-engine/src/routes/ --include='*.ts'
```

---

### Phase 2: Type Alignment & Schema Completeness (P0)

**Objective**: Align type definitions across packages and add missing Zod validation.

#### Tasks

| ID  | Task                                                                           | File(s)                                                  | Effort |
| --- | ------------------------------------------------------------------------------ | -------------------------------------------------------- | ------ |
| 2.1 | Add human_task, loop, transform step types to shared-kernel WorkflowStep union | `packages/shared-kernel/src/types/workflow-types.ts`     | M      |
| 2.2 | Add human_task, loop, transform to Zod WorkflowStepSchema                      | `packages/shared/src/types/workflow-schemas.ts`          | M      |
| 2.3 | Add Zod validation to workflow execution start route                           | `apps/workflow-engine/src/routes/workflow-executions.ts` | S      |
| 2.4 | Align IWorkflowStep type in database model with shared-kernel types            | `packages/database/src/models/workflow.model.ts`         | S      |
| 2.5 | Add unit tests for new Zod schemas                                             | `packages/shared/src/__tests__/workflow-schemas.test.ts` | M      |

#### Exit Criteria

- [ ] shared-kernel, shared (Zod), and database models all support 12 step types
- [ ] Zod schema validates human_task, loop, and transform step definitions
- [ ] Execution start route validates input against WorkflowExecutionInputSchema
- [ ] Unit tests cover all 12 step types in Zod schema
- [ ] `pnpm build --filter=@agent-platform/shared-kernel --filter=@agent-platform/shared --filter=@agent-platform/database` passes

#### Verification

```bash
pnpm build --filter=@agent-platform/shared-kernel --filter=@agent-platform/shared --filter=@agent-platform/database
pnpm test --filter=@agent-platform/shared
```

---

### Phase 3: Workflow CRUD API (P0)

**Objective**: Add missing workflow definition CRUD routes to workflow-engine.

#### Tasks

| ID  | Task                                                             | File(s)                                              | Effort |
| --- | ---------------------------------------------------------------- | ---------------------------------------------------- | ------ |
| 3.1 | Create workflow CRUD router (create, list, get, update, archive) | `apps/workflow-engine/src/routes/workflows.ts` (new) | L      |
| 3.2 | Wire router to Express app with auth + project scope             | `apps/workflow-engine/src/index.ts`                  | S      |
| 3.3 | Add Zod validation for workflow definition input                 | `apps/workflow-engine/src/routes/workflows.ts`       | M      |
| 3.4 | Add optimistic concurrency control via `_v` field                | `apps/workflow-engine/src/routes/workflows.ts`       | S      |
| 3.5 | Add workflow name uniqueness validation (tenant + project scope) | `apps/workflow-engine/src/routes/workflows.ts`       | S      |

#### Route Specifications

| Method | Path                                              | Body                        | Response                                  |
| ------ | ------------------------------------------------- | --------------------------- | ----------------------------------------- |
| POST   | /api/v1/projects/:projectId/workflows             | WorkflowDefinition          | 201 { success, data: workflow }           |
| GET    | /api/v1/projects/:projectId/workflows             | -                           | 200 { success, data: workflows[], total } |
| GET    | /api/v1/projects/:projectId/workflows/:id         | -                           | 200 { success, data: workflow }           |
| PATCH  | /api/v1/projects/:projectId/workflows/:id         | Partial<WorkflowDefinition> | 200 { success, data: workflow }           |
| POST   | /api/v1/projects/:projectId/workflows/:id/archive | -                           | 200 { success }                           |

#### Exit Criteria

- [ ] All 5 CRUD routes implemented with tenant + project isolation
- [ ] Zod validation on create and update
- [ ] Optimistic concurrency via `_v` field (409 on version conflict)
- [ ] Unique name constraint enforced per tenant + project
- [ ] requireProjectPermission applied to all routes

#### Verification

```bash
# Manual API test
curl -X POST http://localhost:9080/api/v1/projects/test/workflows \
  -H 'Content-Type: application/json' \
  -H 'Authorization: Bearer <token>' \
  -d '{"name":"test","type":"internal","steps":[]}'
```

---

### Phase 4: Integration Tests (P1)

**Objective**: Implement integration tests covering service boundaries.

#### Tasks

| ID  | Task                                              | File(s)                                                                                          | Effort |
| --- | ------------------------------------------------- | ------------------------------------------------------------------------------------------------ | ------ |
| 4.1 | INT-01: Workflow handler step sequencing tests    | `apps/workflow-engine/src/__tests__/integration/workflow-handler.integration.test.ts` (new)      | L      |
| 4.2 | INT-03: Expression resolver comprehensive tests   | `apps/workflow-engine/src/__tests__/expression-resolver.test.ts` (new)                           | M      |
| 4.3 | INT-04: Execution store with MongoMemoryServer    | `apps/workflow-engine/src/__tests__/integration/execution-store.integration.test.ts` (new)       | M      |
| 4.4 | INT-05: Human task store with MongoMemoryServer   | `apps/workflow-engine/src/__tests__/integration/human-task-store.integration.test.ts` (new)      | M      |
| 4.5 | INT-06: Human task resolution route tests         | `apps/workflow-engine/src/__tests__/integration/human-task-resolution.integration.test.ts` (new) | L      |
| 4.6 | INT-08: Restate durable promise integration tests | `apps/workflow-engine/src/__tests__/integration/restate-promises.integration.test.ts` (new)      | L      |

#### Exit Criteria

- [ ] All 6 integration test files pass
- [ ] MongoMemoryServer used for database tests (no external dependency)
- [ ] RestateWorkflowCtx mocked via DI interface (not vi.mock)
- [ ] Tenant isolation verified in all persistence tests
- [ ] Expression resolver sanitization tested

#### Verification

```bash
pnpm test --filter=apps/workflow-engine -- --reporter=verbose
```

---

### Phase 5: E2E Tests (P1)

**Objective**: Implement E2E tests exercising the full HTTP API with real server.

#### Tasks

| ID  | Task                                                                      | File(s)                                                                          | Effort |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------ |
| 5.1 | E2E test harness (Express server startup, MongoMemoryServer, auth helper) | `apps/workflow-engine/src/__tests__/e2e/test-harness.ts` (new)                   | L      |
| 5.2 | E2E-01: Workflow execution lifecycle                                      | `apps/workflow-engine/src/__tests__/e2e/workflow-execution.e2e.test.ts` (new)    | L      |
| 5.3 | E2E-02: Human task full lifecycle                                         | `apps/workflow-engine/src/__tests__/e2e/human-task-lifecycle.e2e.test.ts` (new)  | L      |
| 5.4 | E2E-03: Approval rejection flow                                           | `apps/workflow-engine/src/__tests__/e2e/approval-rejection.e2e.test.ts` (new)    | M      |
| 5.5 | E2E-04: Tenant isolation                                                  | `apps/workflow-engine/src/__tests__/e2e/tenant-isolation.e2e.test.ts` (new)      | M      |
| 5.6 | E2E-05: Workflow cancellation                                             | `apps/workflow-engine/src/__tests__/e2e/workflow-cancellation.e2e.test.ts` (new) | M      |

#### Test Harness Design

```typescript
// test-harness.ts (pseudocode)
export async function createTestServer(): Promise<TestContext> {
  const mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());

  const app = express();
  // Wire all middleware and routes exactly as in index.ts
  // Use DI for Restate client (mock via interface)

  const server = app.listen(0); // random port
  const port = (server.address() as AddressInfo).port;

  return {
    baseUrl: `http://localhost:${port}`,
    server,
    mongo,
    getAuthToken: (tenantId, userId) => jwt.sign({...}, TEST_JWT_SECRET),
    cleanup: async () => {
      server.close();
      await mongoose.disconnect();
      await mongo.stop();
    },
  };
}
```

#### Exit Criteria

- [ ] E2E test harness starts real Express server on random port
- [ ] All 5 E2E test files pass
- [ ] No vi.mock or jest.mock used
- [ ] No direct MongoDB model access in test assertions (use HTTP API only)
- [ ] Auth tokens generated with test JWT secret
- [ ] Tenant isolation verified (cross-tenant returns 404)

#### Verification

```bash
pnpm test --filter=apps/workflow-engine -- --reporter=verbose --testPathPattern='e2e'
```

---

### Phase 6: In-Memory Store Hardening (P2)

**Objective**: Fix platform invariant violations in compiler WorkflowRuntime.

#### Tasks

| ID  | Task                                                          | File(s)                                                                   | Effort |
| --- | ------------------------------------------------------------- | ------------------------------------------------------------------------- | ------ |
| 6.1 | Add max size, TTL, and LRU eviction to InMemoryWorkflowStore  | `packages/compiler/src/platform/runtimes/workflow-runtime.ts`             | M      |
| 6.2 | Add max size, TTL, and LRU eviction to InMemoryHumanTaskStore | `packages/compiler/src/platform/runtimes/workflow-runtime.ts`             | M      |
| 6.3 | Add max size, TTL, and eviction to workflowStates Map         | `packages/compiler/src/platform/runtimes/workflow-runtime.ts`             | S      |
| 6.4 | Add unit tests for eviction behavior                          | `packages/compiler/src/__tests__/workflow-runtime-eviction.test.ts` (new) | M      |

#### Exit Criteria

- [ ] All in-memory Maps have configurable max size (default 10,000)
- [ ] All entries have configurable TTL (default 24h for workflows, 1h for tasks)
- [ ] LRU eviction applied when max size reached
- [ ] Eviction emits warning log
- [ ] Unit tests verify eviction at boundary

#### Verification

```bash
pnpm test --filter=@abl/compiler -- --testPathPattern='workflow-runtime-eviction'
```

---

### Phase 7: Notification Channel Implementation (P2)

**Objective**: Implement webhook, slack, and email notification channel adapters.

#### Tasks

| ID  | Task                                                            | File(s)                                                                                  | Effort |
| --- | --------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ------ |
| 7.1 | Implement webhook notification channel adapter                  | `apps/workflow-engine/src/notifications/channels/webhook-channel.ts` (new)               | M      |
| 7.2 | Implement Slack notification channel adapter                    | `apps/workflow-engine/src/notifications/channels/slack-channel.ts` (new)                 | M      |
| 7.3 | Implement email notification channel adapter (via SendGrid/SES) | `apps/workflow-engine/src/notifications/channels/email-channel.ts` (new)                 | L      |
| 7.4 | Register channel adapters in index.ts                           | `apps/workflow-engine/src/index.ts`                                                      | S      |
| 7.5 | Add integration tests for notification dispatch                 | `apps/workflow-engine/src/__tests__/integration/notifications.integration.test.ts` (new) | M      |

#### Exit Criteria

- [ ] Webhook channel sends HTTP POST to configured target
- [ ] Slack channel sends message via Slack Incoming Webhook URL
- [ ] Email channel sends email via configurable provider (env-based)
- [ ] All channels registered in service startup
- [ ] Integration tests verify dispatch for each channel type

---

### Phase 8: Workflow Versioning (P2)

**Objective**: Support workflow definition versioning with execution pinning.

#### Tasks

| ID  | Task                                                 | File(s)                                                  | Effort |
| --- | ---------------------------------------------------- | -------------------------------------------------------- | ------ |
| 8.1 | Add version publishing flow (draft -> published)     | `apps/workflow-engine/src/routes/workflows.ts`           | M      |
| 8.2 | Pin execution to workflow version at start time      | `apps/workflow-engine/src/handlers/workflow-handler.ts`  | M      |
| 8.3 | Support version rollback (activate previous version) | `apps/workflow-engine/src/routes/workflows.ts`           | M      |
| 8.4 | Add version column to execution list view            | `apps/workflow-engine/src/routes/workflow-executions.ts` | S      |

#### Exit Criteria

- [ ] Workflow definitions support draft/published/archived status per version
- [ ] New executions use the latest published version
- [ ] In-flight executions continue with their pinned version
- [ ] Version history is queryable via API

---

## 3. Dependency Graph

```
Phase 1 (Security)
  |
  +-> Phase 2 (Type Alignment)
  |     |
  |     +-> Phase 3 (Workflow CRUD)
  |
  +-> Phase 4 (Integration Tests)  -- can start after Phase 1
        |
        +-> Phase 5 (E2E Tests)    -- requires Phase 3 for CRUD tests
              |
              +-> Phase 6 (In-Memory Stores) -- independent
              +-> Phase 7 (Notifications)    -- independent
              +-> Phase 8 (Versioning)       -- independent
```

---

## 4. BETA Promotion Criteria

The feature transitions from ALPHA to BETA when:

- [ ] Phase 1 complete (security hardening)
- [ ] Phase 2 complete (type alignment)
- [ ] Phase 3 complete (workflow CRUD)
- [ ] Phase 4 complete (minimum 5 integration tests passing)
- [ ] Phase 5 complete (minimum 5 E2E tests passing)
- [ ] All P0 gaps resolved
- [ ] Zero CRITICAL findings from pr-reviewer audit

---

## 5. STABLE Promotion Criteria

The feature transitions from BETA to STABLE when:

- [ ] Phase 6 complete (in-memory store hardening)
- [ ] Phase 7 complete (notification channels)
- [ ] Phase 8 complete (workflow versioning)
- [ ] All P1 and P2 gaps resolved
- [ ] Performance targets met (NFR-01 through NFR-08)
- [ ] 90%+ test coverage on workflow-engine package
- [ ] Production deployment with at least 2 tenants using workflows

---

## 6. Risk Mitigation Plan

| Risk                                                       | Phase     | Mitigation                                                                               |
| ---------------------------------------------------------- | --------- | ---------------------------------------------------------------------------------------- |
| Restate mock fidelity in E2E tests                         | Phase 5   | RestateWorkflowCtx interface is simple (sleep, run, promise) -- DI mock is high fidelity |
| MongoMemoryServer performance in CI                        | Phase 4-5 | Use shared instance across test files; parallel test isolation via unique tenantIds      |
| requireProjectPermission integration breaks existing tests | Phase 1   | Run existing 36 tests after each route change; fix immediately                           |
| Type alignment breaks build                                | Phase 2   | Incremental: add types first (backward compatible), then require in Zod                  |
| Workflow CRUD routes conflict with existing route mounting | Phase 3   | Register before parameterized routes (Express ordering rule)                             |

---

## 7. Effort Estimates

| Phase                  | Tasks  | Total Effort                | Calendar Days |
| ---------------------- | ------ | --------------------------- | ------------- |
| Phase 1: Security      | 6      | 3 M + 3 S = ~3d             | 3             |
| Phase 2: Types         | 5      | 2 M + 3 S + 1 M = ~3d       | 3             |
| Phase 3: CRUD          | 5      | 1 L + 1 M + 3 S = ~3d       | 3             |
| Phase 4: Integration   | 6      | 3 L + 3 M = ~5d             | 5             |
| Phase 5: E2E           | 6      | 3 L + 3 M = ~5d             | 5             |
| Phase 6: In-Memory     | 4      | 2 M + 1 S + 1 M = ~2d       | 2             |
| Phase 7: Notifications | 5      | 1 L + 2 M + 1 S + 1 M = ~4d | 4             |
| Phase 8: Versioning    | 4      | 3 M + 1 S = ~3d             | 3             |
| **Total**              | **41** |                             | **~28d**      |

---

## 8. Wiring Checklist

Every implementation phase must verify these wiring points:

- [ ] New routes registered in `apps/workflow-engine/src/index.ts` (Express app)
- [ ] New routes added to `apps/workflow-engine/src/routes/index.ts` (barrel export)
- [ ] New types exported from `packages/shared-kernel/src/types/index.ts`
- [ ] New Zod schemas exported from `packages/shared/src/types/index.ts`
- [ ] New models exported from `packages/database/src/models/index.ts`
- [ ] New executors imported in `apps/workflow-engine/src/handlers/step-dispatcher.ts`
- [ ] Dockerfile package.json COPY lines updated if new packages added
- [ ] `pnpm build` passes across all affected packages
- [ ] `pnpm test` passes across all affected packages
