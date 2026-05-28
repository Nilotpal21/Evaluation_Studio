# Test Spec: Workflows & Human Tasks

> **Feature ID**: #48
> **Status**: PARTIAL
> **Created**: 2026-03-23
> **Last Updated**: 2026-04-20

---

## 1. Test Strategy

The Workflows & Human Tasks feature spans three packages (workflow-engine, compiler, studio) and requires testing at all levels:

- **E2E Tests**: Real Express server on random port, real MongoDB (MongoMemoryServer), real Redis (or mock). No mocking of codebase components. Tests exercise the full middleware chain including auth, tenant isolation, and validation.
- **Integration Tests**: Test service boundaries -- workflow handler + execution store, step dispatcher + executors, Restate client + durable promises. Real dependencies where feasible, DI-based stubs for external services only.
- **Unit Tests**: 36 existing unit tests cover individual executors, expression resolver, and step dispatcher. Additional unit tests target gap areas.

### Test Environment

- Express server started with `{ port: 0 }` for random port assignment.
- MongoDB via MongoMemoryServer (in-process, ephemeral).
- Redis via ioredis-mock or real Redis for Pub/Sub tests.
- Restate context mocked via the `RestateWorkflowCtx` interface (DI, not vi.mock).
- JWT tokens generated with test secret for authentication.

---

## 2. E2E Test Scenarios

### E2E-01: Workflow Execution Lifecycle (Happy Path)

**Objective**: Verify end-to-end workflow execution through the HTTP API.

| Step | Action                                                                                 | Expected                                                    |
| ---- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 1    | POST /api/v1/projects/:projectId/workflows/:workflowId/executions with trigger payload | 201 Created, execution ID returned                          |
| 2    | GET /api/v1/projects/:projectId/workflows/:workflowId/executions/:id                   | Status: running, steps in expected states                   |
| 3    | Wait for execution to complete (poll or Redis Pub/Sub)                                 | Status: completed                                           |
| 4    | GET execution again                                                                    | All steps show completed with output, duration, completedAt |

**Coverage**: FR-03, FR-04, FR-20, FR-21

### E2E-02: Human Task Full Lifecycle

**Objective**: Verify human task creation, assignment, claiming, resolution, and workflow resumption.

| Step | Action                                          | Expected                                                         |
| ---- | ----------------------------------------------- | ---------------------------------------------------------------- |
| 1    | Start workflow with a human_task step           | Execution status: waiting_human_task                             |
| 2    | GET /api/v1/projects/:projectId/human-tasks     | Task appears with status: pending                                |
| 3    | POST assign task to specific user               | Task status: assigned, assignedTo set                            |
| 4    | POST claim task by user                         | Task status: in_progress, claimedBy set                          |
| 5    | POST resolve task with form fields and decision | Task status: completed, response recorded                        |
| 6    | GET execution                                   | Workflow resumed and completed, humanTaskResponse in step output |

**Coverage**: FR-07, FR-08, FR-09, FR-24, FR-25

### E2E-03: Approval Step with Rejection

**Objective**: Verify approval workflow with rejection terminating execution.

| Step | Action                                 | Expected                                          |
| ---- | -------------------------------------- | ------------------------------------------------- |
| 1    | Start workflow with an approval step   | Execution status: waiting_approval                |
| 2    | POST reject approval with reason       | Execution status: rejected                        |
| 3    | GET execution                          | Error code: APPROVAL_REJECTED, decidedBy recorded |
| 4    | Verify HumanTask mirror record created | Task with source.type: workflow_approval exists   |

**Coverage**: FR-06, FR-07

### E2E-04: Tenant Isolation on Workflow Executions

**Objective**: Verify cross-tenant access returns 404.

| Step | Action                                           | Expected                |
| ---- | ------------------------------------------------ | ----------------------- |
| 1    | Start workflow as tenant-A                       | 201 Created             |
| 2    | GET execution as tenant-B                        | 404 Not Found (not 403) |
| 3    | POST resolve human task as tenant-B              | 404 Not Found           |
| 4    | GET human tasks as tenant-B for tenant-A project | Empty list or 404       |

**Coverage**: NFR-07, GAP-05

### E2E-05: Workflow Cancellation

**Objective**: Verify cancellation terminates running workflows and cleans up human tasks.

| Step | Action                                            | Expected                       |
| ---- | ------------------------------------------------- | ------------------------------ |
| 1    | Start workflow that will pause on human_task step | Status: waiting_human_task     |
| 2    | POST cancel execution                             | Status changes to cancelled    |
| 3    | GET execution                                     | Error code: WORKFLOW_CANCELLED |
| 4    | GET pending human tasks for this execution        | Tasks cancelled/cleaned up     |

**Coverage**: FR-22

### E2E-06: Async Webhook with Callback

**Objective**: Verify async webhook step sends outbound request and resumes on callback.

| Step | Action                                                            | Expected                                         |
| ---- | ----------------------------------------------------------------- | ------------------------------------------------ |
| 1    | Start workflow with async_webhook step (mock target server)       | Outbound HTTP request received by mock server    |
| 2    | GET execution                                                     | Step status: waiting_callback                    |
| 3    | POST callback to /api/v1/workflows/callbacks/:executionId/:stepId | Callback accepted                                |
| 4    | GET execution                                                     | Workflow resumed, callbackPayload in step output |

**Coverage**: FR-10

### E2E-07: Condition Step Branching

**Objective**: Verify condition steps route to correct branch.

| Step | Action                                                             | Expected                                     |
| ---- | ------------------------------------------------------------------ | -------------------------------------------- |
| 1    | Start workflow: condition step with expression evaluating to true  | thenSteps executed                           |
| 2    | Start workflow: same definition but context makes expression false | elseSteps executed                           |
| 3    | GET both executions                                                | Different steps completed based on condition |

**Coverage**: FR-12

### E2E-08: Parallel Step Execution

**Objective**: Verify parallel branches execute concurrently with failure strategies.

| Step | Action                                                                      | Expected                                    |
| ---- | --------------------------------------------------------------------------- | ------------------------------------------- |
| 1    | Start workflow with parallel step (3 branches, all succeed)                 | All branches completed                      |
| 2    | Start workflow with parallel step (1 branch fails, strategy: fail_fast)     | Execution fails immediately                 |
| 3    | Start workflow with parallel step (1 branch fails, strategy: ignore_errors) | Execution completes, failed branch recorded |

**Coverage**: FR-11

### E2E-09: Step Retry on Failure

**Objective**: Verify step retry with exponential backoff.

| Step | Action                                                                          | Expected                        |
| ---- | ------------------------------------------------------------------------------- | ------------------------------- |
| 1    | Start workflow with HTTP step targeting a server that fails twice then succeeds | Step completes after 3 attempts |
| 2    | Verify retry timing matches configured backoff                                  | Delays increase exponentially   |
| 3    | Start workflow with HTTP step targeting permanently failing server              | Step fails after max retries    |

**Coverage**: FR-05

### E2E-12: Engine /execute Version Resolution vs Real MongoDB (system-execute-version)

**Objective**: Exercise the workflow-engine `POST /execute` handler end-to-end against real `Workflow` and `WorkflowVersion` Mongoose models backed by MongoMemoryServer. Only Restate and the Redis publisher are stubbed — the route handler, Zod validation, Mongoose queries, indexes, soft-delete filters, and the tenant-isolation plugin all run for real. Closes **GAP-11** (engine-side HTTP E2E for /execute).

| #   | Scenario                              | Input                                                                                 | Expected                                                                                                                                             |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Explicit pin hit                      | Seeded version `state:'inactive'`; POST `{ workflowVersionId: <id>, payload: {key} }` | 202; `restateClient.startWorkflow` called with resolved `workflowVersionId` + `workflowVersion: '1.4.2'`; steps + outputMappings from version canvas |
| 2   | Explicit pin miss (no doc)            | POST `{ workflowVersionId: <valid UUID, not seeded> }`                                | 404 `WORKFLOW_VERSION_NOT_FOUND`; Restate never called                                                                                               |
| 3   | Explicit pin with soft-deleted doc    | Seeded version `deleted: true`; POST with that versionId                              | 404 (soft-delete filter excludes)                                                                                                                    |
| 4   | Cross-workflow pin                    | Version belongs to workflow B; POST targets workflow A                                | 404 (`workflowId` scope enforced)                                                                                                                    |
| 5   | No versionId + active exists          | Seed one active + one inactive; POST `{ payload: {} }`                                | 202; picks active version (`workflowVersion: '2.0.0'`)                                                                                               |
| 6   | No versionId + no versions            | POST `{ payload: {} }` against workflow with zero `WorkflowVersion` docs              | 202; falls back to draft — no version annotations                                                                                                    |
| 7   | No versionId + only inactive versions | Seed one inactive version; POST `{ payload: {} }`                                     | 202; falls back to draft (state filter excludes inactive)                                                                                            |
| 8   | No versionId + soft-deleted active    | Seed one version with `state:'active'` AND `deleted:true`; POST `{ payload: {} }`     | 202; falls back to draft (deleted filter excludes even active)                                                                                       |

**Coverage**: US-3a; FR-32. Implemented in `apps/workflow-engine/src/__tests__/system-execute-version.test.ts`. Runs via `pnpm --filter=@agent-platform/workflow-engine exec vitest run --config vitest.system.config.ts`.

### E2E-13: Callback HMAC + Replay Protection (system-callback)

**Objective**: Exercise `POST /api/v1/workflows/callbacks/:executionId/:stepId` end-to-end against the real `WorkflowExecution` Mongoose model via MongoMemoryServer, with real raw-body capture and real HMAC computation. Closes the engine-side async-callback E2E gap.

| #   | Scenario                         | Expected                                                                                           |
| --- | -------------------------------- | -------------------------------------------------------------------------------------------------- |
| 1   | Valid signature + timestamp      | 200; Restate `resolveCallback` invoked; `callbackReceivedAt` + `callbackPayload` persisted on step |
| 2   | Unknown executionId              | 404                                                                                                |
| 3   | Unknown stepId on execution      | 404                                                                                                |
| 4   | Step not in `waiting_callback`   | 409 with current status in error                                                                   |
| 5   | Step has no `callbackSecret`     | 401 `authentication not configured` (never trust unconfigured callback)                            |
| 6   | Missing `x-callback-signature`   | 401                                                                                                |
| 7   | Invalid signature (wrong secret) | 401 HMAC mismatch                                                                                  |
| 8   | Malformed signature hex          | 401                                                                                                |
| 9   | Missing `x-callback-timestamp`   | 401                                                                                                |
| 10  | Replay: stale timestamp          | 401 `Replay detected`                                                                              |
| 11  | Restate throws on resolve        | 503; step NOT marked received (transactional integrity)                                            |

**Coverage**: FR-10 (async webhook step completion path). Implemented in `apps/workflow-engine/src/__tests__/system-callback.test.ts`. Runs via `pnpm --filter=@agent-platform/workflow-engine test:system`.

### E2E-PROXY-ADM-04: Trigger Catalog Proxy (closes GAP-A)

**Objective**: Verify the runtime proxy exposes the engine's trigger catalog at `GET /api/projects/:pid/workflows/triggers/catalog` and forwards correctly.

| #   | Scenario                                                | Expected                                                                                     |
| --- | ------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| 1   | `GET /triggers/catalog` with JWT                        | 200; mock engine receives request at `/api/v1/connectors/triggers/catalog` (non-scoped path) |
| 2   | Query params forwarded (`category`, `limit`)            | Mock engine sees both query params                                                           |
| 3   | Unauthenticated request                                 | 401                                                                                          |
| 4   | Route-ordering guard (catalog not captured as `:regId`) | 200; still hits engine at catalog path                                                       |

**Coverage**: Closes a proxy-wiring omission — the engine endpoint had no forwarding route. Implemented in `apps/runtime/src/__tests__/e2e/workflows/workflow-proxy-admin.e2e.test.ts` under `Trigger Catalog`.

### E2E-11: Proxy Version + Webhook Field Forwarding (E2E-PROXY-05)

**Objective**: Verify the runtime proxy preserves engine-schema fields through body translation to the workflow-engine. Runs against a real runtime server + mock engine that records every request.

| Step | Action                                                                                                                                  | Expected                                                                                                             |
| ---- | --------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 1    | POST /executions/execute?mode=async with `{ input, workflowVersionId: 'wv-test-0001', workflowVersion: '1.4.2' }`                       | 202; mock engine receives `workflowVersionId: 'wv-test-0001'` and `workflowVersion: '1.4.2'` in the payload          |
| 2    | POST with `{ input, webhookMode: 'async', webhookDelivery: 'poll' }`                                                                    | 202; mock engine receives `webhookMode: 'async'` and `webhookDelivery: 'poll'`                                       |
| 3    | POST with `{ payload: {...} }` only (Studio's default shape)                                                                            | 202; engine payload does NOT contain any of `workflowVersionId`, `workflowVersion`, `webhookMode`, `webhookDelivery` |
| 4    | POST with type-invalid values: `{ workflowVersionId: 12345, workflowVersion: {nested}, webhookMode: 'invalid', webhookDelivery: null }` | 202; type guards strip all four — engine payload does NOT contain them                                               |

**Coverage**: US-3a (proxy side); FR-32. Implemented in `apps/runtime/src/__tests__/e2e/workflows/workflow-proxy-execution.e2e.test.ts` under `E2E-PROXY-05: Version and webhook field forwarding`. Runs via `pnpm --filter=@agent-platform/runtime test:e2e`.

### E2E-10: Human Task Timeout and Escalation

**Objective**: Verify human task timeout triggers configured action.

| Step | Action                                                                     | Expected                                  |
| ---- | -------------------------------------------------------------------------- | ----------------------------------------- |
| 1    | Start workflow with human_task step, short timeout (1s), onTimeout: expire | Task eventually expires                   |
| 2    | GET execution                                                              | Status: failed, error: HUMAN_TASK_EXPIRED |
| 3    | Start workflow with approval step, short timeout, timeoutAction: approve   | Auto-approved, workflow continues         |

**Coverage**: FR-27, FR-28

### E2E-14: Start Step — Declared Inputs Coerced Through to User Step and Output Mapping

**Objective**: Canvas with declared `startInputVariables` (`email: string required`, `amount: number required`) and a user HTTP step whose URL interpolates `{{vars.amount}}`, plus output mappings referencing the coerced value. Prove engine-side coercion reaches both dispatch and End output.

| Step | Action                                                               | Expected                                                                                                                                                  |
| ---- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `runWorkflow` with `triggerPayload: { email: 'a@b', amount: '250' }` | `status: 'completed'`                                                                                                                                     |
| 2    | HTTP step dispatched                                                 | URL is `https://api.example.com/q?amount=250` (number, not quoted string)                                                                                 |
| 3    | `GET /executions/:id` → `nodeExecutions`                             | Start → `completed`, `input = raw payload`, `output = {email:'a@b', amount:250}`; End → `completed`, `output = {_status:0, typedAmount:250, doubled:250}` |

**Coverage**: FR-41, FR-42, FR-43. Implemented in `apps/workflow-engine/src/__tests__/system-handler-start-end.test.ts` (Suite 6). Real Mongo + captured fetch URLs.

### E2E-15: Start Validation Failure Across Fire Paths

**Objective**: A workflow with a required declared input receives a payload missing that field. Route path returns 400; handler path (webhook/cron/agent fire) creates an execution with Start step `failed` and emits `workflow.failed` — in both cases no user step dispatches.

| Step | Action                                                            | Expected                                                                                                                                                                                                                                                                                                                   |
| ---- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1    | `POST /executions/execute` with payload missing a required field  | HTTP 400 `{code:'INPUT_VALIDATION_FAILED', fields:[{name, reason:'REQUIRED'}]}`; no execution record created                                                                                                                                                                                                               |
| 2    | `POST /executions/execute` with type mismatch (string for number) | HTTP 400 with `fields[0].reason:'TYPE_MISMATCH'`, `expected:'number'`, `got:'string'`                                                                                                                                                                                                                                      |
| 3    | Trigger-fired path: `runWorkflow` with missing required           | Execution created with `status:'failed'`; Start step `failed`, `error.code:'INPUT_VALIDATION_FAILED'`, `mappingErrors = [{name, error:'REQUIRED...'}]`; workflow-level output `{_status:1, _reason}`; user step stays `pending`; SSE: `step.started(start) → step.failed(start) → workflow.failed` (no `workflow.started`) |

**Coverage**: FR-41, FR-43. Implemented in `apps/workflow-engine/src/__tests__/system-handler-start-end.test.ts` (Suite 2) + `workflow-executions-routes.test.ts` (preflight suite — 4 tests).

### E2E-16: End Mapping Failure Fails the Workflow

**Objective**: A canvas with an output mapping whose expression references a non-existent step. End evaluation must accumulate the per-mapping error and fail the workflow with a structured summary. Partial results are preserved on the End step record for debug.

| Step | Action                                                                                                            | Expected                                                                                                                                                                                               |
| ---- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1    | Mappings `[{name:'ok', expression:'literal-value'}, {name:'bad', expression:'{{steps.nonexistent.output.foo}}'}]` | `status:'failed'`; workflow-level output `{_status:1, _reason:'1 of 2 output mappings failed'}`                                                                                                        |
| 2    | `nodeExecutions` End entry                                                                                        | `status:'failed'`, `error.code:'OUTPUT_MAPPING_FAILED'`, `mappingErrors = [{name:'bad', expression, error}]`, `output = {_status:0, ok:'literal-value', bad:null}` (partial resolution kept for debug) |
| 3    | SSE event stream                                                                                                  | `step.started(end) → step.failed(end) → workflow.failed`                                                                                                                                               |

**Coverage**: FR-42, FR-44. Implemented in `apps/workflow-engine/src/__tests__/system-handler-start-end.test.ts` (Suite 5).

### E2E-17: Multi-Mapping Partial Failure — All Errors Accumulated

**Objective**: 3 mappings, 2 reference missing paths. All failing mappings appear in `mappingErrors[]` (no short-circuit); the successful mapping's value is preserved in the End step's `output` but workflow still fails.

| Step | Action                                                                                                                              | Expected                                                                                                            |
| ---- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| 1    | Mappings `[{name:'a', '{{steps.missing-a.output.x}}'}, {name:'b', 'preserved-string'}, {name:'c', '{{steps.missing-c.output.y}}'}]` | `status:'failed'`; `end.mappingErrors` length = 2; `end.output = {_status:0, a:null, b:'preserved-string', c:null}` |

**Coverage**: FR-42, FR-44. Implemented in `apps/workflow-engine/src/__tests__/system-handler-start-end.test.ts` (Suite 5 "no short-circuit" case).

---

## 3. Integration Test Scenarios

### INT-01: Workflow Handler Step Sequencing

**Objective**: Test workflow handler processes steps in order, handles branching, updates context.

| Test                  | Input                         | Expected                                     |
| --------------------- | ----------------------------- | -------------------------------------------- |
| Sequential steps      | 3 HTTP steps in order         | All execute sequentially, outputs in context |
| Condition branch      | Condition true -> thenSteps   | Only thenSteps executed                      |
| Condition fallthrough | Condition false, no elseSteps | Remaining queue steps continue               |
| Loop iteration        | Loop over 3 items with body   | Body executed 3 times with item variable     |
| Transform step        | Transform expression          | Vars updated in context                      |

**Coverage**: FR-02, FR-04, FR-12, FR-14, FR-15

### INT-02: Step Dispatcher Routing

**Objective**: Test all 12 step types are correctly dispatched to their executors.

| Test             | Input                        | Expected                                     |
| ---------------- | ---------------------------- | -------------------------------------------- |
| connector_action | Step with connector/action   | executeConnectorAction called                |
| http             | Step with method/url         | executeHttpRequest called                    |
| tool_call        | Step with toolName/params    | executeToolCall called                       |
| agent_invocation | Step with agentId/message    | executeAgentInvocation called                |
| condition        | Step with expression         | evaluateCondition called, nextSteps returned |
| delay            | Step with duration           | resolveDelay called, delayMs returned        |
| parallel         | Step with branches           | executeParallel called with branchRunner     |
| async_webhook    | Step with request/callback   | buildAsyncWebhookRequest called              |
| approval         | Step with assignee/title     | buildApprovalRequest called                  |
| human_task       | Step with taskType/fields    | buildHumanTaskRequest called                 |
| loop             | Step with config.source/body | executeLoop called, loopIteration returned   |
| transform        | Step with config.expression  | executeTransform called                      |

**Coverage**: FR-02

### INT-03: Expression Resolver

**Objective**: Test expression resolution against all context paths.

| Test                       | Input                                             | Expected                          |
| -------------------------- | ------------------------------------------------- | --------------------------------- |
| trigger.payload path       | `{{trigger.payload.orderId}}`                     | Resolved to trigger payload value |
| steps.output path          | `{{steps.step-1.output.total}}`                   | Resolved to step output value     |
| vars path                  | `{{vars.retryCount}}`                             | Resolved to var value             |
| workflow metadata          | `{{workflow.executionId}}`                        | Resolved to execution ID          |
| tenant path                | `{{tenant.tenantId}}`                             | Resolved to tenant ID             |
| Missing path               | `{{trigger.payload.missing}}`                     | Returns undefined                 |
| Mixed text and expressions | `Order: {{trigger.payload.id}} for {{vars.name}}` | Both expressions interpolated     |
| Non-expression string      | `plain text`                                      | Returned as-is                    |

**Coverage**: FR-04

### INT-04: Execution Store Persistence

**Objective**: Test execution CRUD with tenant isolation.

| Test                  | Input                         | Expected                             |
| --------------------- | ----------------------------- | ------------------------------------ |
| createExecution       | Valid execution data          | Document created with all fields     |
| updateStepStatus      | Step ID + new status          | Step status updated in document      |
| updateExecutionStatus | New status + context          | Execution status and context updated |
| Tenant isolation      | Query with wrong tenantId     | Returns null/empty                   |
| Concurrent updates    | Two updates to same execution | Both applied (last-write-wins)       |

**Coverage**: FR-20, NFR-07

### INT-05: Human Task Store

**Objective**: Test human task CRUD with source-based queries.

| Test                       | Input                                 | Expected                         |
| -------------------------- | ------------------------------------- | -------------------------------- |
| createTask                 | Valid task params                     | Document created with defaults   |
| updateTaskStatus           | Status transition pending -> assigned | Status updated, extra fields set |
| findBySource               | workflow_human_task source filter     | Correct task returned            |
| findById with tenant       | Task ID + matching tenantId           | Task returned                    |
| findById with wrong tenant | Task ID + different tenantId          | Returns null                     |

**Coverage**: FR-08, NFR-07

### INT-06: Human Task Resolution Route

**Objective**: Test the resolve endpoint with auth, validation, and Restate integration.

| Test                 | Input                                     | Expected                         |
| -------------------- | ----------------------------------------- | -------------------------------- |
| Valid resolution     | Auth'd user, valid execution/step         | 200 OK, Restate promise resolved |
| Missing auth         | No JWT token                              | 401 Unauthorized                 |
| Wrong tenant         | Auth'd as different tenant                | 404 Not Found                    |
| Step not waiting     | Step in 'completed' status                | 409 Conflict                     |
| Invalid execution    | Non-existent execution ID                 | 404 Not Found                    |
| Identity enforcement | Body.respondedBy differs from auth'd user | Auth'd user used (body ignored)  |

**Coverage**: FR-09, GAP-05

### INT-07: Notification Rule Matching

**Objective**: Test notification dispatch for different event types.

| Test                | Input                          | Expected                |
| ------------------- | ------------------------------ | ----------------------- |
| step_failed event   | Matching rule                  | Notification dispatched |
| No matching rule    | Event with no configured rule  | No dispatch             |
| Multiple rules      | Two rules for same event       | Both dispatched         |
| Template resolution | Rule with template expressions | Expressions resolved    |

**Coverage**: FR-23

### INT-08: Restate Durable Promise Integration

**Objective**: Test durable promise patterns (approval, human_task, callback, cancel).

| Test               | Input                                        | Expected                        |
| ------------------ | -------------------------------------------- | ------------------------------- |
| Approval accept    | Resolve approval promise with approved=true  | Workflow continues              |
| Approval reject    | Resolve approval promise with approved=false | Workflow terminates as rejected |
| Approval timeout   | Promise times out                            | Timeout policy applied          |
| Human task resolve | Resolve human task promise with fields       | Fields available in context     |
| Cancel signal      | Resolve cancel promise                       | CancellationError thrown        |

**Coverage**: FR-06, FR-09, FR-22

### INT-09: /execute Version Resolution

**Objective**: Verify the `POST /executions/execute` handler resolves the workflow version with precedence: explicit `workflowVersionId` → active version → draft. Strict 404 on an explicit pin miss; annotation of the resolved version on the execution record.

| Test                           | Input                                                                                                             | Expected                                                                                                                                |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| Explicit pin hit               | Body `{ workflowVersionId: 'wv-123' }`; `WorkflowVersion` returns `{ version: '1.4.2', definition: {...} }`       | 202; `startWorkflow` called with `workflowVersionId: 'wv-123'`, `workflowVersion: '1.4.2'`, steps + output mappings from version canvas |
| Explicit pin miss              | Body `{ workflowVersionId: 'wv-missing' }`; `WorkflowVersion` returns `null`                                      | 404 `WORKFLOW_VERSION_NOT_FOUND`; `startWorkflow` never invoked                                                                         |
| Active-version default         | Body `{}`; `WorkflowVersion` returns `{ _id: 'wv-active', version: '2.0.0', state: 'active', definition: {...} }` | 202; `startWorkflow` annotated with `workflowVersionId: 'wv-active'` and `workflowVersion: '2.0.0'`                                     |
| No active → fall back to draft | Body `{}`; `WorkflowVersion.findOne({state:'active'})` returns `null`; `Workflow` has canvas nodes/edges          | 202; `startWorkflow` has no `workflowVersionId`/`workflowVersion`; steps + output mappings come from the `Workflow` draft               |

**Coverage**: US-3a; FR-32 (version lifecycle). Implemented in `apps/workflow-engine/src/__tests__/workflow-executions-routes.test.ts` under the `POST /executions/execute` → `version resolution` describe block (4 cases).

### INT-10: `startInputVariables` Propagation Across All 6 Resolution Tiers

**Objective**: Every tier of `resolveWorkflowDefinition` must surface `startInputVariables` from the canvas conversion. If any tier drops the field, that fire path silently loses input validation.

| Test                                | Input                                                           | Expected                                      |
| ----------------------------------- | --------------------------------------------------------------- | --------------------------------------------- |
| Tier `pinned`                       | `pinnedVersionId` matches a WorkflowVersion with inputVariables | `result.startInputVariables` = declared array |
| Tier `semver-desc`                  | No pin; active published version exists                         | `result.startInputVariables` = declared array |
| Tier `draft`                        | No pin; only draft version exists                               | `result.startInputVariables` = declared array |
| Tier `working-copy-steps` (legacy)  | Workflow doc with `.steps[]` + canvas nodes carrying inputVars  | `result.startInputVariables` = declared array |
| Tier `working-copy-canvas` (legacy) | Workflow doc with only canvas `.nodes/.edges`                   | `result.startInputVariables` = declared array |

**Coverage**: FR-43. Implemented in `apps/workflow-engine/src/__tests__/version-resolution.test.ts` under "startInputVariables propagation" describe block (5 tier assertions). Tier `deployment` shares the code path with `pinned`.

### INT-11: `buildWorkflowExecutionPayload` Never-Drop Contract

**Objective**: `startInputVariables` defaults to `[]` when omitted (never `undefined`), and pass-through preserves the caller's array by reference — same contract as `nameToIdMap` / `outputMappings`. Prevents the GAP-14-class silent-drop.

| Test                          | Input                                          | Expected                                               |
| ----------------------------- | ---------------------------------------------- | ------------------------------------------------------ |
| Omitted → defaults to `[]`    | `baseInput()` with no `startInputVariables`    | `payload.startInputVariables === []`, property present |
| Provided array passes through | Explicit `startInputVariables: [{...}, {...}]` | `payload.startInputVariables === declared` (same ref)  |

**Coverage**: FR-43. Implemented in `apps/workflow-engine/src/__tests__/execution-payload.test.ts` ("defaults startInputVariables to []", "forwards provided startInputVariables untouched").

### INT-12: `validateAndCoerceInput` Pure Function Coverage

**Objective**: 34 unit tests pin every coercion branch, every error classification, immutability guard, and the D-13 "no defaultValue application" regression.

| Test                      | Input                                                     | Expected                                             |
| ------------------------- | --------------------------------------------------------- | ---------------------------------------------------- |
| Empty declarations        | `[]` + any payload                                        | `{ok:true, coerced: {...payload}}`                   |
| REQUIRED — missing        | `[{name:'x', type:'string', required:true}]` + `{}`       | `{ok:false, errors:[{name:'x', reason:'REQUIRED'}]}` |
| REQUIRED — null/undefined | `{x: null}` / `{x: undefined}`                            | Treated as missing; REQUIRED                         |
| Number coercion           | `{n: '42'}`                                               | `{n: 42}` (number)                                   |
| Number empty string       | `{n: ''}`                                                 | TYPE_MISMATCH (NOT silent 0)                         |
| Number whitespace         | `{n: '   '}`                                              | TYPE_MISMATCH                                        |
| Number trimmed padding    | `{n: '  42  '}`                                           | `{n: 42}` (trimmed then coerced)                     |
| Boolean broadened set     | `"true"/"1"/"yes"`, `"false"/"0"/"no"` (case-insensitive) | Coerced to native boolean                            |
| JSON string → parsed      | `{j: '{"a":1}'}`                                          | `{j: {a:1}}`                                         |
| JSON invalid              | `{j: 'not json'}`                                         | JSON_PARSE_ERROR                                     |
| Extra fields              | Declared x + undeclared y                                 | `coerced` includes both                              |
| Multi-error accumulation  | Multiple failing fields                                   | All errors returned (no short-circuit)               |
| D-13: no defaultValue     | `[{name:'x', required:true, defaultValue:10}]` + `{}`     | REQUIRED (default is ignored)                        |
| Frozen input immutability | `Object.freeze(payload)`, run validator                   | Input unchanged                                      |

**Coverage**: FR-43. Implemented in `apps/workflow-engine/src/__tests__/start-input-validator.test.ts` (34 test cases, zero mocks).

### INT-13: First-Class Start/End Step Lifecycle Against Real Mongo

**Objective**: Start and End boundary steps produce real execution step records with full lifecycle, emit SSE events in the correct natural order, and persist structured `mappingErrors` on failure. Uses real `ExecutionStore` + `MongoMemoryServer`.

| Test                              | Input                                | Expected                                                                                    |
| --------------------------------- | ------------------------------------ | ------------------------------------------------------------------------------------------- |
| Start happy path — coerced output | Declared inputs + matching payload   | Start `completed`, `input=raw`, `output=coerced`, metrics.processingTimeMs, durationMs      |
| Start failure — missing required  | Declared required + missing field    | Start `failed` with mappingErrors; user steps stay pending; workflow `failed`               |
| Start SSE order                   | Valid input                          | `step.started(start) → step.completed(start) → workflow.started → ... → workflow.completed` |
| Start SSE order on failure        | Invalid input                        | `step.started(start) → step.failed(start) → workflow.failed` (NO workflow.started)          |
| End happy path                    | Mappings resolve cleanly             | End `completed`, `input=mappings`, `output={_status:0, ...}`, metrics                       |
| End no-mappings                   | `outputMappings = []`                | End `completed`, `output = {_status:0}`                                                     |
| End single mapping failure        | One `{{steps.nonexistent.output.x}}` | End `failed` with 1 mappingError, partial `output` preserved, workflow `failed`             |
| End multi-mapping partial failure | 3 mappings, 2 unresolvable           | `mappingErrors.length===2`, valid mapping kept in `output`                                  |
| Coerced vars visible in ctx.vars  | Number coercion `'42'→42`            | `result.context.vars.amount === 42` (number)                                                |
| Undeclared fields pass through    | Declared x + payload `{x, extraY}`   | Both in `ctx.vars`                                                                          |
| No-declarations pass through      | No declarations + any payload        | Pass through unchanged                                                                      |

**Coverage**: FR-41, FR-42, FR-43, FR-44. Implemented in `apps/workflow-engine/src/__tests__/system-handler-start-end.test.ts` (7 suites, 16 system tests). Runs via `pnpm --filter=@agent-platform/workflow-engine test:system`.

### INT-14: Execute-Route Preflight Input Validation

**Objective**: POST `/executions/execute` returns HTTP 400 with structured `fields[]` before touching Restate when declared inputs aren't satisfied. Handler re-runs validation as canonical check.

| Test                                 | Input                                    | Expected                                                                                                                         |
| ------------------------------------ | ---------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| REQUIRED field missing → 400         | Payload missing declared required        | HTTP 400, `error.code:'INPUT_VALIDATION_FAILED'`, `fields:[{name, reason:'REQUIRED'}]`; `restateClient.startWorkflow` NOT called |
| TYPE_MISMATCH → 400                  | String "not-a-number" for number field   | HTTP 400 with `fields:[{reason:'TYPE_MISMATCH', expected:'number', got:'string'}]`                                               |
| Valid payload → 202 + forwarded vars | Valid declared inputs                    | HTTP 202, `startWorkflow` called with `startInputVariables` + raw payload                                                        |
| No declarations → pass through       | Workflow with no declared inputVariables | HTTP 202, any payload accepted                                                                                                   |

**Coverage**: FR-43. Implemented in `apps/workflow-engine/src/__tests__/workflow-executions-routes.test.ts` under "input validation preflight" describe block (4 cases).

---

## 4. Unit/Integration Test Coverage (Actual)

### Workflow Engine (881 test cases across 64 files)

| File                                        | Tests | Coverage Area                                                                                                                                                                                                                             |
| ------------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `canvas-to-steps.test.ts`                   | 47    | Node/edge graph to step conversion — all 20 node types, edge wiring, outputMapping shapes, startInputVariables extraction                                                                                                                 |
| `start-input-validator.test.ts`             | 34    | Pure `validateAndCoerceInput` — every coercion branch, error classification, D-13 regression, immutability (INT-12)                                                                                                                       |
| `triggers-routes.test.ts`                   | 30    | Trigger CRUD routes + lifecycle (list, register, deregister, pause, resume, fire, sample-payload). Validates Zod guards, tenant-ctx 400, engine-error envelopes, 404 vs 500 routing on fire, and null-payload contract on sample-payload. |
| `route-integration.test.ts`                 | 28    | Express router + request validation + tenant isolation                                                                                                                                                                                    |
| `e2e-advanced.test.ts`                      | 27    | Complex flows (multi-branch, error recovery)                                                                                                                                                                                              |
| `workflow-integration.test.ts`              | 26    | Cross-component integration                                                                                                                                                                                                               |
| `workflow-executions-routes.test.ts`        | 25    | Execution CRUD routes + /execute version resolution (explicit hit, explicit miss 404, active default, no-active draft fallback — INT-09) + preflight input validation (INT-14)                                                            |
| `expression-resolver.test.ts`               | 25    | Template resolution                                                                                                                                                                                                                       |
| `e2e-medium.test.ts`                        | 24    | Medium complexity flows (parallel, loop, approval)                                                                                                                                                                                        |
| `workflow-handler.test.ts`                  | 24    | Core execution loop                                                                                                                                                                                                                       |
| `trigger-engine.test.ts`                    | 21    | Trigger registration + lifecycle                                                                                                                                                                                                          |
| `preset-resolver.test.ts`                   | 21    | Workflow presets/templates                                                                                                                                                                                                                |
| `human-task-executor.test.ts`               | 21    | Human task request/timeout builder                                                                                                                                                                                                        |
| `function-executor.test.ts`                 | 21    | V8 sandbox execution                                                                                                                                                                                                                      |
| `connections-routes.test.ts`                | 19    | Connection CRUD                                                                                                                                                                                                                           |
| `condition-executor.test.ts`                | 19    | Condition evaluation                                                                                                                                                                                                                      |
| `notification-rules.test.ts`                | 18    | Notification rule CRUD                                                                                                                                                                                                                    |
| `e2e-basic.test.ts`                         | 18    | Happy-path handler-level flows (HTTP, condition, transform, delay)                                                                                                                                                                        |
| `version-resolution.test.ts`                | 17    | Fire-time cascade — all 6 tiers (pinned → deployment → semver-desc → draft → working-copy-steps → working-copy-canvas) + cascade priority guard + startInputVariables propagation per tier (INT-10)                                       |
| `workflow-handler-suspension.test.ts`       | 16    | Delay, approval, webhook, human_task suspension                                                                                                                                                                                           |
| `system-handler-start-end.test.ts`          | 16    | First-class Start/End boundary step lifecycle: coercion, validation failure, SSE order, mapping errors (fail-on-any), end-to-end coerced-vars-reach-user-step (INT-13, E2E-14..E2E-17)                                                    |
| `workflow-approvals.test.ts`                | 15    | Approval resolution route                                                                                                                                                                                                                 |
| `trigger-scheduler-timezone.test.ts`        | 15    | Timezone handling + basic schedule/unschedule lifecycle                                                                                                                                                                                   |
| `trigger-fire-resolution.test.ts`           | 15    | Fire-path version resolution integration tests                                                                                                                                                                                            |
| `notification-dispatcher.test.ts`           | 15    | Event matching and dispatch                                                                                                                                                                                                               |
| `system-persistence.test.ts`                | 14    | MongoDB persistence operations                                                                                                                                                                                                            |
| `system-human-task-store.test.ts`           | 14    | Mongo-backed human task store CRUD + status lifecycle                                                                                                                                                                                     |
| `execution-payload.test.ts`                 | 13    | buildWorkflowExecutionPayload: required fields, never-drop defaults for nameToIdMap/outputMappings/startInputVariables (INT-11), null-vs-undefined omit, webhook-only fields                                                              |
| `restate-client.test.ts`                    | 13    | Ingress URL shape + body for start/cancel/resolveCallback/Approval/HumanTask; 404 "service not found" re-register+retry; 404 on cancel = success                                                                                          |
| `route-helpers.test.ts`                     | 13    | getTenantId edge cases, requireTenantProject happy + 400 error shape, asyncHandler Express-4 promise forwarding                                                                                                                           |
| `restate-endpoint.test.ts`                  | 11    | Extracted shared-handler bodies (cancel, resolveCallback, Approval, HumanTask) + promise-key uniqueness regression guard                                                                                                                  |
| `http-executor.test.ts`                     | 11    | HTTP step execution                                                                                                                                                                                                                       |
| `delay-executor.test.ts`                    | 11    | Duration resolution                                                                                                                                                                                                                       |
| `step-dispatcher.test.ts`                   | 11    | Step type routing                                                                                                                                                                                                                         |
| `system-handler.test.ts`                    | 10    | System-level handler — end-to-end persistence including first-class Start + End node records                                                                                                                                              |
| `execution-store.test.ts`                   | 10    | Persistence operations                                                                                                                                                                                                                    |
| `oauth-grant-resolver.test.ts`              | 9     | EndUserOAuthToken lookup (user-specific + tenant-shared), proactive refresh, SSRF guard, Redis lock semantics                                                                                                                             |
| `connectors-routes.test.ts`                 | 9     | Connector catalog: GET / (list), GET /:name, GET /:name/actions (action schemas incl. props, empty-actions case, 404 CONNECTOR_NOT_FOUND)                                                                                                 |
| `index-wiring.test.ts`                      | 9     | Express app wiring                                                                                                                                                                                                                        |
| `approval-executor.test.ts`                 | 9     | Approval request/timeout builder                                                                                                                                                                                                          |
| `system-executions-semver.test.ts`          | 8     | Mongo-backed semver-desc default resolution                                                                                                                                                                                               |
| `trigger-scheduler-lifecycle.test.ts`       | 8     | schedulePolling, version-cascade integration in processJob, callbackUrl propagation, worker `failed` listener, retry-propagation                                                                                                          |
| `workflow-output-status-convention.test.ts` | 7     | `_status`/`_reason` contract on success (`_status: 0`) and failure (`_status: 1 + _reason`); persistence payload propagation                                                                                                              |
| `loop-executor.test.ts`                     | 7     | Loop iteration                                                                                                                                                                                                                            |
| `transform-executor.test.ts`                | 7     | Data transformation                                                                                                                                                                                                                       |
| `parallel-executor.test.ts`                 | 6     | Branch execution with strategies                                                                                                                                                                                                          |
| `workflow-callbacks.test.ts`                | 6     | HMAC webhook callbacks                                                                                                                                                                                                                    |
| `callback-delivery.test.ts`                 | 6     | Async callback delivery                                                                                                                                                                                                                   |
| `callback-delivery-internal.test.ts`        | 6     | Callback delivery internal queue wiring                                                                                                                                                                                                   |
| `async-webhook-executor.test.ts`            | 6     | Outbound webhook + callback                                                                                                                                                                                                               |
| `tool-call-executor.test.ts`                | 6     | Tool call step                                                                                                                                                                                                                            |
| `human-task-resolution-routes.test.ts`      | 6     | Human task resolution HTTP routes                                                                                                                                                                                                         |
| `semver-compare.test.ts`                    | 5     | semver descending comparator                                                                                                                                                                                                              |
| `agent-invocation-executor.test.ts`         | 5     | Agent invocation                                                                                                                                                                                                                          |
| `connector-action-executor.test.ts`         | 4     | Connector action                                                                                                                                                                                                                          |
| `graceful-shutdown.test.ts`                 | 4     | BullMQ drain + HTTP server close                                                                                                                                                                                                          |
| `connector-trigger-rehydrator.test.ts`      | 4     | Connector trigger rehydration on resume                                                                                                                                                                                                   |
| `executions-isolation.integration.test.ts`  | 4     | Tenant+project isolation on execution CRUD                                                                                                                                                                                                |
| `system-execute-version.test.ts`            | 3     | Mongo-backed /execute version resolution smoke                                                                                                                                                                                            |
| `trigger-catalog-routes.test.ts`            | 3     | Trigger catalog HTTP routes                                                                                                                                                                                                               |
| `trigger-environment.test.ts`               | 3     | Trigger env handling                                                                                                                                                                                                                      |
| `trigger-version-frozen-flow.test.ts`       | 3     | Frozen workflow-version trigger flow                                                                                                                                                                                                      |
| `callback-url.test.ts`                      | 1     | Callback URL generation                                                                                                                                                                                                                   |

### Runtime -- Workflow + Human Tasks (283+ test cases)

| File                                      | Tests | Coverage Area                                                                                                                                                                                                                 |
| ----------------------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflows-authz.test.ts`                 | 56    | Workflow authorization                                                                                                                                                                                                        |
| `workflow-validation.test.ts`             | 21    | Zod schema validation                                                                                                                                                                                                         |
| `workflow-routes.test.ts`                 | 16    | CRUD route logic                                                                                                                                                                                                              |
| `workflow-version-service.test.ts`        | 23    | Version lifecycle (create, activate, deactivate, soft-delete, diff)                                                                                                                                                           |
| `workflow-version-routes.test.ts`         | 26    | Version HTTP routes + validateMutableFields + softDelete                                                                                                                                                                      |
| `workflow-step-denormalize.test.ts`       | 9     | Step denormalization                                                                                                                                                                                                          |
| `workflow-create-sanitization.test.ts`    | 3     | Input sanitization                                                                                                                                                                                                            |
| `human-task-routes.test.ts`               | 2     | Task list scoping + claim                                                                                                                                                                                                     |
| `deployment-workflow-versions.test.ts`    | 4     | Deployment version integration                                                                                                                                                                                                |
| `deployment-repo-snapshot.test.ts`        | 3     | Deployment repo snapshot isolation                                                                                                                                                                                            |
| `workflow-repo.test.ts`                   | 16    | Workflow repo CRUD + tenant isolation                                                                                                                                                                                         |
| `workflow-versioning.e2e.test.ts`         | 10    | Version lifecycle E2E (real HTTP + MongoMemoryServer)                                                                                                                                                                         |
| `workflow-version-deployment.e2e.test.ts` | 2     | Deployment version E2E (snapshot, pagination)                                                                                                                                                                                 |
| `workflow-version-triggers.e2e.test.ts`   | 4     | Trigger activate/deactivate E2E (frozen fields, multi-active)                                                                                                                                                                 |
| `workflow-crud.e2e.test.ts`               | 39    | CRUD lifecycle E2E (create, list, activate, deactivate, soft-delete)                                                                                                                                                          |
| `workflow-proxy-execution.e2e.test.ts`    | 21    | Proxy execute async/sync, list, get, cancel, auth, 502, + version/webhook field forwarding (E2E-PROXY-05: 4 cases — forwards workflowVersionId/Version, forwards webhookMode/Delivery, does not invent, type-guard rejection) |
| `workflow-proxy-triggers.e2e.test.ts`     | 10    | Proxy trigger register/list/delete/pause/resume/fire (E2E)                                                                                                                                                                    |
| `workflow-proxy-admin.e2e.test.ts`        | 19    | Proxy approvals (incl. alt turbopack path — GAP-D), notifications CRUD, connectors catalog, trigger catalog (E2E-PROXY-ADM-04 / GAP-A closer)                                                                                 |
| `system-callback.test.ts` (engine)        | 11    | Engine HTTP E2E for `/callbacks` with real Mongo + HMAC (E2E-13 / GAP-B closer)                                                                                                                                               |
| `workflow-human-task-resolve.e2e.test.ts` | 8     | Resolve approval/human_task, validation, associate-session (E2E)                                                                                                                                                              |

### Studio E2E (Playwright, 14 spec files)

| File                                  | Coverage Area                                                                                                                                                               |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workflow-canvas-uat.spec.ts`         | Canvas UAT (node CRUD, edges, validation)                                                                                                                                   |
| `workflow-create-execute.spec.ts`     | Create workflow, add steps, verify UI                                                                                                                                       |
| `workflow-lifecycle.spec.ts`          | Full workflow lifecycle                                                                                                                                                     |
| `workflow-comprehensive.spec.ts`      | Comprehensive multi-feature                                                                                                                                                 |
| `workflow-agent-node.spec.ts`         | Agent node configuration                                                                                                                                                    |
| `workflow-function-node.spec.ts`      | Function node configuration                                                                                                                                                 |
| `workflow-tool-node.spec.ts`          | Tool node configuration                                                                                                                                                     |
| `workflow-integration-node.spec.ts`   | Integration node configuration                                                                                                                                              |
| `workflow-monitor-triggers.spec.ts`   | Monitor tab + triggers                                                                                                                                                      |
| `workflow-trigger-api-key.spec.ts`    | API key trigger authentication                                                                                                                                              |
| `workflow-triggers-showcase.spec.ts`  | Trigger catalog showcase                                                                                                                                                    |
| `workflow-apple-care-e2e.spec.ts`     | AppleCare reference workflow E2E                                                                                                                                            |
| `workflow-webhook-versioning.spec.ts` | Webhook versioning badges, short URL, ?version= param, served-via caption                                                                                                   |
| `workflow-inbox.spec.ts`              | Unified Inbox UI shell (4 tests): empty state, filter-bar mailbox toggle, type-pill switching. Approve/reject lifecycle still Planned — needs live Restate suspension setup |

### Gap Areas (Tests Still Needed)

| Area                                       | Description                                                                                                                                                                     | Priority   |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| HTTP E2E (real server + real DB)           | Real Express server + MongoMemoryServer E2E tests for workflow-engine                                                                                                           | HIGH       |
| ~~Human task resolution E2E~~              | ~~Full task lifecycle via HTTP API with real middleware chain~~ COVERED: `workflow-human-task-resolve.e2e.test.ts` (8 tests)                                                    | ~~HIGH~~   |
| Cancellation E2E                           | Cancel via HTTP with step cleanup verification                                                                                                                                  | MEDIUM     |
| Notification delivery E2E                  | End-to-end notification dispatch with channel adapters                                                                                                                          | MEDIUM     |
| Expression resolver security               | Prototype pollution, deeply nested paths, injection                                                                                                                             | MEDIUM     |
| ~~OAuth grant resolver integration~~       | ~~Integration node OAuth flow with real encrypted connections~~ COVERED: `oauth-grant-resolver.test.ts` (9 tests, DI fakes)                                                     | ~~MEDIUM~~ |
| Approval / human-task Playwright lifecycle | End-to-end suspend → inbox resolve → workflow resume via UI. Blocked on dev-stack Restate suspension setup; testids + UI-shell spec already in place (`workflow-inbox.spec.ts`) | MEDIUM     |

---

## 5. Test Data Requirements

### Seed Data

- **Tenant**: `test-tenant-id` with JWT secret for auth token generation
- **Project**: `test-project-id` under test tenant
- **Workflow Definition**: Pre-created workflow with known steps for execution tests
- **User**: `test-user-id` with project permissions for task operations

### Workflow Definitions for Testing

1. **Simple Linear**: 2 HTTP steps -> complete
2. **Approval Workflow**: HTTP step -> approval step -> HTTP step
3. **Human Task Workflow**: HTTP step -> human_task step -> HTTP step
4. **Branching Workflow**: HTTP step -> condition step -> thenSteps / elseSteps
5. **Parallel Workflow**: HTTP step -> parallel step (3 branches)
6. **Full Feature**: trigger -> condition -> parallel -> approval -> human_task -> loop -> transform

---

## 6. Test Environment Configuration

```
MONGODB_URI=mongodb://localhost:27017/test (via MongoMemoryServer)
REDIS_URL=redis://localhost:6379 (or ioredis-mock)
JWT_SECRET=test-secret-for-e2e
ENCRYPTION_MASTER_KEY=test-key-32-bytes-exactly-here!!
RESTATE_ADMIN_URL=http://localhost:9070 (mocked)
WORKFLOW_ENGINE_PUBLIC_URL=http://localhost:<random>
```

---

## 7. Test Matrix

| Scenario                     | E2E (HTTP)                                                   | E2E (UI)      | Integration  | Unit  | Status                                                                                                               |
| ---------------------------- | ------------------------------------------------------------ | ------------- | ------------ | ----- | -------------------------------------------------------------------------------------------------------------------- |
| Workflow execution lifecycle | -                                                            | ✅ lifecycle  | ✅ INT-01    | ✅ 66 | Partial (no HTTP E2E)                                                                                                |
| Human task full lifecycle    | ✅ 8                                                         | -             | ✅ INT-05,06 | ✅ 2  | Covered (E2E resolve + validation)                                                                                   |
| Approval with rejection      | ✅ 2                                                         | -             | ✅ INT-08    | ✅ 12 | Covered (E2E approve + reject)                                                                                       |
| Tenant isolation             | -                                                            | -             | ✅ INT-04    | ✅ 56 | Covered (authz)                                                                                                      |
| Workflow cancellation        | ✅ 1                                                         | -             | ✅ INT-08    | ✅    | Covered (proxy cancel E2E)                                                                                           |
| Async webhook callback       | ✅ E2E-13 (system-callback, 11)                              | -             | ✅ INT-08    | ✅ 6  | Covered end-to-end (HMAC, replay, 404/409/401/503 branches — GAP-B closed 04-17)                                     |
| Trigger catalog proxy        | ✅ E2E-PROXY-ADM-04 (4)                                      | -             | -            | -     | Covered (GAP-A proxy wiring closed 04-17; Studio UI wire-up is a follow-up)                                          |
| Condition branching          | -                                                            | -             | ✅ INT-01    | ✅ 19 | Covered                                                                                                              |
| Parallel execution           | -                                                            | -             | ✅ INT-02    | ✅ 6  | Covered                                                                                                              |
| Step retry                   | -                                                            | -             | ✅ INT-01    | ✅    | Covered                                                                                                              |
| Human task timeout           | -                                                            | -             | -            | -     | Gap                                                                                                                  |
| Expression resolution        | -                                                            | -             | ✅ INT-03    | ✅ 25 | Covered                                                                                                              |
| Notification dispatch        | ✅ 6                                                         | -             | ✅ INT-07    | ✅ 29 | Covered (proxy CRUD E2E)                                                                                             |
| Step dispatcher routing      | -                                                            | -             | ✅ INT-02    | ✅ 11 | Covered                                                                                                              |
| Canvas UI (node CRUD)        | -                                                            | ✅ canvas-uat | -            | ✅ 3  | Covered (UI)                                                                                                         |
| Function node (V8 sandbox)   | -                                                            | ✅ func-node  | -            | ✅ 21 | Covered                                                                                                              |
| Integration node             | -                                                            | ✅ integ-node | -            | -     | Partial (UI only)                                                                                                    |
| Workflow versioning          | ✅ 16                                                        | -             | ✅ 26        | ✅ 34 | Covered (unit + integration + E2E)                                                                                   |
| /execute version resolution  | ✅ E2E-11 (PROXY-05, 4) + E2E-12 (system-execute-version, 8) | -             | ✅ INT-09    | ✅ 4  | Covered end-to-end (proxy forwarding + engine HTTP via real Mongoose + route-integration unit) — GAP-11 closed 04-17 |
| Trigger system               | ✅ 10                                                        | ✅ triggers   | -            | ✅ 17 | Covered (proxy E2E + UI)                                                                                             |
| Connector catalog            | ✅ 5                                                         | -             | -            | -     | Covered (proxy E2E)                                                                                                  |
| Route integration            | -                                                            | -             | ✅ 28        | -     | Covered                                                                                                              |
| Service JWT auth             | -                                                            | -             | -            | ✅ 9  | Covered (wiring)                                                                                                     |

**Legend**: ✅ = test files exist and exercise the scenario. "-" = no test coverage for this level.
