# LLD: Pipeline Engine

**Feature**: Pipeline Engine
**Status**: DONE (document finalized; feature is BETA — see prod-ready plan for STABLE path)
**Date**: 2026-03-24
**Feature Spec**: `docs/features/pipeline-engine.md`
**HLD**: `docs/specs/pipeline-engine.hld.md`
**Test Spec**: `docs/testing/pipeline-engine.md`
**Follow-up Plan**: `docs/plans/2026-03-24-pipeline-engine-prod-ready-impl-plan.md` — Security fixes, node wiring, alert activation, STABLE qualification

---

## 1. Design Decisions

### Decision Log

| Decision                               | Rationale                                                              | Alternatives Rejected                        |
| -------------------------------------- | ---------------------------------------------------------------------- | -------------------------------------------- |
| Graph walker as pure function          | Enables unit testing without Restate; Restate wraps for production     | Stateful walker (coupled to workflow engine) |
| Activity router dispatch table         | Centralized mapping, easy to extend, single entry point from workflow  | Direct service calls from workflow           |
| Dual execution mode in single workflow | One workflow handles both legacy and graph modes via runtime detection | Separate workflows (duplication)             |
| Expression evaluator with AST          | Security (no eval), extensibility, proper precedence handling          | Regex matching (fragile), eval() (unsafe)    |
| Bounded NodeRegistry (max 200)         | Prevents memory leaks from unbounded registration                      | Unbounded Map (memory risk)                  |
| Config history with 20-entry cap       | Provides audit trail without unbounded growth                          | Full history (unbounded document growth)     |
| Eval batched concurrency               | Controls LLM cost/rate limits per batch                                | Semaphore (harder in Restate context)        |
| Fail-open caching strategy             | Redis failure must not block analytics queries                         | Fail-closed (availability risk)              |

### Key Interfaces & Types

```typescript
// Core types (packages/pipeline-engine/src/pipeline/types.ts)
interface PipelineDefinition {
  _id;
  tenantId;
  name;
  pipelineType;
  version;
  status;
  nodes?;
  steps?;
  configSchema?;
  supportedTriggers?;
  strategies?;
}
interface PipelineNode {
  id;
  type;
  config;
  transitions: NodeTransition[];
  maxVisits?;
  onFailure?;
}
interface StepOutput {
  status: 'success' | 'fail' | 'skipped';
  data: Record<string, any>;
  durationMs?;
}
interface PipelineStepContext {
  tenantId;
  projectId?;
  config;
  previousSteps;
  executionContext?;
  pipelineInput;
}
interface ResolvedPipelineConfig {
  pipelineConfig;
  stepOverrides;
  configVersion;
  configSource;
}
interface NodeTypeDefinition {
  type;
  category;
  label;
  configSchema;
  executionModel;
  contextKey?;
}

// Eval types (packages/pipeline-engine/src/pipeline/services/eval/eval-types.ts)
interface PersonaConfig {
  _id;
  name;
  communicationStyle;
  domainKnowledge;
  behaviorTraits;
  goals;
  isAdversarial;
}
interface ScenarioConfig {
  _id;
  name;
  entryAgent?;
  initialMessage?;
  maxTurns;
  expectedMilestones;
  agentPath;
}
interface EvaluatorConfig {
  _id;
  name;
  type: 'llm_judge' | 'code_scorer' | 'trajectory' | 'human_review';
  scoringRubric?;
}
interface JudgeResult {
  score;
  passed;
  reasoning;
  evidence;
  confidence;
  wasPositionSwapped;
  needsHumanReview;
}
interface RunSummary {
  totalConversations;
  totalEvaluations;
  avgScore;
  passAtK;
  stdDev;
  confidenceInterval;
}
```

### Module Boundaries

| Module              | Responsibility                                      | Dependencies                        |
| ------------------- | --------------------------------------------------- | ----------------------------------- |
| Core Engine         | Graph traversal, expression eval, validation        | None (pure functions)               |
| Configuration       | Config CRUD, resolution, Zod validation             | MongoDB, Zod                        |
| Restate Handlers    | Workflow execution, scheduling, triggering          | Restate SDK, MongoDB, Core Engine   |
| Compute Services    | Domain-specific analytics (sentiment, intent, etc.) | LLM client factory, ClickHouse      |
| Eval Services       | Persona simulation, agent execution, judging        | Runtime API, LLM, ClickHouse        |
| Analytics & Storage | ClickHouse read/write, Redis caching                | ClickHouse, Redis                   |
| Node Type System    | Node registration, trait merging, schema validation | MongoDB                             |
| Runtime Routes      | HTTP API for config CRUD and analytics queries      | Express, Config service, ClickHouse |
| Studio UI           | Visual pipeline editor, config forms                | React Flow, Zustand, SWR            |

---

## 2. File-Level Change Map

### Phase 1: Core Engine (DONE)

| File                                     | Action  | Purpose                                   |
| ---------------------------------------- | ------- | ----------------------------------------- |
| `pipeline/graph-walker.ts`               | Created | Pure graph traversal with visit limits    |
| `pipeline/graph-utils.ts`                | Created | Transition resolution, cycle detection    |
| `pipeline/expression-evaluator.ts`       | Created | Safe CEL-like expression parser/evaluator |
| `pipeline/validation.ts`                 | Created | Pipeline definition validation            |
| `pipeline/types.ts`                      | Created | Core type definitions                     |
| `pipeline/node-registry.ts`              | Created | Bounded node type registry                |
| `pipeline/trait-merger.ts`               | Created | Trait-based config field merging          |
| `pipeline/execution-context.ts`          | Created | Execution context building                |
| `pipeline/activity-metadata.ts`          | Created | Static activity type metadata             |
| `pipeline/template-engine.ts`            | Created | Template rendering for prompts            |
| `pipeline/definitions/*.ts`              | Created | 10 built-in pipeline definitions          |
| `__tests__/graph-walker.test.ts`         | Created | Graph traversal tests                     |
| `__tests__/graph-validation.test.ts`     | Created | Graph validation tests                    |
| `__tests__/graph-utils.test.ts`          | Created | Graph utility tests                       |
| `__tests__/expression-evaluator.test.ts` | Created | Expression evaluator tests                |
| `__tests__/validation.test.ts`           | Created | Validation tests                          |
| `__tests__/node-registry.test.ts`        | Created | Node registry tests                       |

### Phase 2: Configuration System (DONE)

| File                                           | Action  | Purpose                              |
| ---------------------------------------------- | ------- | ------------------------------------ |
| `pipeline/config-schemas.ts`                   | Created | Static + dynamic Zod schema registry |
| `pipeline/config-defaults.ts`                  | Created | Platform default config values       |
| `pipeline/services/pipeline-config.service.ts` | Created | Three-tier config resolution, CRUD   |
| `schemas/pipeline-config.schema.ts`            | Created | Mongoose schema for pipeline_configs |
| `__tests__/config-schemas.test.ts`             | Created | Config schema tests                  |
| `__tests__/pipeline-config.test.ts`            | Created | Config service tests                 |

### Phase 3: Execution Engine (DONE)

| File                                            | Action  | Purpose                                |
| ----------------------------------------------- | ------- | -------------------------------------- |
| `pipeline/handlers/pipeline-run.workflow.ts`    | Created | Restate workflow (dual-mode execution) |
| `pipeline/handlers/eval-run.workflow.ts`        | Created | Restate eval workflow (fan-out)        |
| `pipeline/handlers/pipeline-scheduler.ts`       | Created | Restate virtual object for cron        |
| `pipeline/handlers/pipeline-trigger.service.ts` | Created | Restate trigger service                |
| `pipeline/handlers/activity-router.service.ts`  | Created | Activity dispatch router               |
| `pipeline/server.ts`                            | Created | Restate server registration            |
| `pipeline/bootstrap.ts`                         | Created | Environment validation + startup       |
| `schemas/pipeline-run-record.schema.ts`         | Created | Mongoose schema for run records        |
| `schemas/pipeline-definition.schema.ts`         | Created | Mongoose schema for definitions        |
| `__tests__/pipeline-run.test.ts`                | Created | Pipeline run tests                     |
| `__tests__/pipeline-trigger.test.ts`            | Created | Trigger tests                          |
| `__tests__/pipeline-trigger-graph.test.ts`      | Created | Graph trigger tests                    |
| `__tests__/activity-router.test.ts`             | Created | Activity router tests                  |

### Phase 4: Compute Services (DONE)

| File                                                       | Action  | Purpose                              |
| ---------------------------------------------------------- | ------- | ------------------------------------ |
| `pipeline/services/compute-sentiment.service.ts`           | Created | Sentiment analysis                   |
| `pipeline/services/compute-intent.service.ts`              | Created | Intent classification                |
| `pipeline/services/compute-quality.service.ts`             | Created | Quality evaluation                   |
| `pipeline/services/compute-statistical.service.ts`         | Created | Statistical computation              |
| `pipeline/services/compute-toxicity.service.ts`            | Created | Toxicity detection                   |
| `pipeline/services/compute-llm-evaluation.service.ts`      | Created | LLM-based evaluation                 |
| `pipeline/services/compute-goal-completion.service.ts`     | Created | Goal completion tracking             |
| `pipeline/services/compute-mentions.service.ts`            | Created | Mention extraction                   |
| `pipeline/services/compute-tool-effectiveness.service.ts`  | Created | Tool effectiveness                   |
| `pipeline/services/compute-predictive-features.service.ts` | Created | Predictive ML features               |
| `pipeline/services/llm-evaluate.service.ts`                | Created | Generic LLM evaluation               |
| `pipeline/services/llm-client-factory.ts`                  | Created | LLM client creation with credentials |
| `pipeline/services/store-insight.service.ts`               | Created | ClickHouse insight writer            |
| `pipeline/services/store-results.service.ts`               | Created | ClickHouse results writer            |
| `pipeline/services/read-conversation.service.ts`           | Created | Conversation reader                  |
| `pipeline/services/read-message-window.service.ts`         | Created | Message window reader                |
| `pipeline/services/http-request.service.ts`                | Created | HTTP callout node                    |
| `pipeline/services/filter.service.ts`                      | Created | Data filtering node                  |
| `pipeline/services/transform.service.ts`                   | Created | Data transformation node             |
| `pipeline/services/aggregate.service.ts`                   | Created | Data aggregation node                |
| `pipeline/services/backfill.service.ts`                    | Created | Historical backfill                  |
| 10+ test files                                             | Created | Unit tests for all compute services  |

### Phase 5: Analytics & Storage (DONE)

| File                                        | Action  | Purpose                             |
| ------------------------------------------- | ------- | ----------------------------------- |
| `pipeline/schemas/init-analytics-tables.ts` | Created | ClickHouse DDL for analytics tables |
| `pipeline/schemas/init-eval-tables.ts`      | Created | ClickHouse DDL for eval tables      |
| `pipeline/services/analytics-cache.ts`      | Created | Redis analytics cache               |
| `pipeline/services/definition-cache.ts`     | Created | Redis definition cache              |
| `pipeline/insight-types.ts`                 | Created | Typed insight definitions           |
| `__tests__/analytics-cache.test.ts`         | Created | Cache tests                         |
| `__tests__/insight-types.test.ts`           | Created | Insight type tests                  |
| `__tests__/store-insight.test.ts`           | Created | Store insight tests                 |

### Phase 6: Eval Pipeline (DONE)

| File                                                      | Action  | Purpose                                        |
| --------------------------------------------------------- | ------- | ---------------------------------------------- |
| `pipeline/services/eval/eval-types.ts`                    | Created | Eval type definitions                          |
| `pipeline/services/eval/simulate-persona.service.ts`      | Created | Persona simulation                             |
| `pipeline/services/eval/execute-agent-turn.service.ts`    | Created | Agent turn execution                           |
| `pipeline/services/eval/run-eval-conversation.service.ts` | Created | Conversation orchestration                     |
| `pipeline/services/eval/judge-conversation.service.ts`    | Created | LLM-as-judge scoring                           |
| `pipeline/services/eval/trajectory-scorers.ts`            | Created | Trajectory metric scoring                      |
| `pipeline/services/eval/aggregate-eval-run.service.ts`    | Created | Run aggregation + statistics                   |
| `pipeline/services/eval/eval-preflight.ts`                | Created | Preflight validation                           |
| `pipeline/services/eval/eval-preflight.service.ts`        | Created | Preflight Restate service                      |
| `pipeline/services/eval/eval-circuit-breakers.ts`         | Created | Circuit breaker pattern                        |
| `pipeline/services/eval/eval-compression.ts`              | Created | Gzip compression                               |
| `pipeline/services/eval/eval-clickhouse-writers.ts`       | Created | Eval ClickHouse writers                        |
| `pipeline/services/eval/eval-logger.ts`                   | Created | Eval structured logging                        |
| `pipeline/services/eval/eval-rate-limiter.ts`             | Created | Eval rate limiting                             |
| `pipeline/services/eval/eval-metrics.ts`                  | Created | Eval metrics tracking                          |
| `pipeline/services/eval/eval-alerts.ts`                   | Created | Eval alerting                                  |
| `pipeline/services/eval/eval-auth.ts`                     | Created | Eval auth resolution                           |
| `pipeline/prompts/*.ts`                                   | Created | LLM prompts (simulation, evaluation, analysis) |
| `__tests__/eval-preflight.test.ts`                        | Created | Preflight tests                                |
| `__tests__/eval-circuit-breaker-errors.test.ts`           | Created | Circuit breaker tests                          |

### Phase 7: Runtime Routes (DONE)

| File                                                                 | Action  | Purpose                        |
| -------------------------------------------------------------------- | ------- | ------------------------------ |
| `apps/runtime/src/routes/pipeline-config.ts`                         | Created | 9-endpoint config CRUD API     |
| `apps/runtime/src/routes/pipeline-analytics.ts`                      | Created | 4-endpoint analytics query API |
| `apps/runtime/src/__tests__/pipeline-config.test.ts`                 | Created | Config route tests             |
| `apps/runtime/src/__tests__/routes/pipeline-analytics-route.test.ts` | Created | Analytics route tests          |

### Phase 8: Studio UI (DONE)

| File                                                                         | Action  | Purpose                    |
| ---------------------------------------------------------------------------- | ------- | -------------------------- |
| `apps/studio/src/components/pipelines/PipelinesListPage.tsx`                 | Created | Pipeline listing           |
| `apps/studio/src/components/pipelines/BuiltinPipelinesList.tsx`              | Created | Built-in pipelines         |
| `apps/studio/src/components/pipelines/CustomPipelinesList.tsx`               | Created | Custom pipelines           |
| `apps/studio/src/components/pipelines/PipelineCard.tsx`                      | Created | Pipeline card              |
| `apps/studio/src/components/pipelines/PipelineConfigPage.tsx`                | Created | Config page                |
| `apps/studio/src/components/pipelines/PipelineEditorPage.tsx`                | Created | Graph editor page          |
| `apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx`               | Created | React Flow canvas          |
| `apps/studio/src/components/pipelines/PipelineEditorToolbar.tsx`             | Created | Editor toolbar             |
| `apps/studio/src/components/pipelines/NodePalette.tsx`                       | Created | Drag-and-drop node palette |
| `apps/studio/src/components/pipelines/NodeConfigPanel.tsx`                   | Created | Node configuration sidebar |
| `apps/studio/src/components/pipelines/TriggerManager.tsx`                    | Created | Trigger management         |
| `apps/studio/src/components/pipelines/TriggerConfigPanel.tsx`                | Created | Trigger configuration      |
| `apps/studio/src/components/pipelines/ConfigSchemaForm.tsx`                  | Created | Dynamic config form        |
| `apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx`                | Created | Schema field form builder  |
| `apps/studio/src/components/pipelines/PipelineNodeComponent.tsx`             | Created | Custom React Flow node     |
| `apps/studio/src/components/pipelines/PipelineGroupNode.tsx`                 | Created | Custom group node          |
| `apps/studio/src/components/pipelines/PipelineTriggerNode.tsx`               | Created | Custom trigger node        |
| `apps/studio/src/components/pipelines/PipelineEdgeComponent.tsx`             | Created | Custom edge                |
| `apps/studio/src/components/pipelines/__tests__/SchemaFieldBuilder.test.tsx` | Created | Field builder tests        |

---

## 3. Exit Criteria

### Phase 1: Core Engine

- [x] `walkGraph()` traverses DAG correctly (linear, branching, conditional)
- [x] Visit limits enforced (per-node and hard cap)
- [x] Failure policies work (stop/skip/continue)
- [x] Expression evaluator parses and evaluates safely
- [x] Graph validation catches structural issues
- [x] All unit tests pass

### Phase 2: Configuration System

- [x] Three-tier resolution works (project > tenant > platform)
- [x] Zod schemas validate all 10 pipeline types
- [x] Dynamic schema builder generates correct schemas from definitions
- [x] Config version auto-increments
- [x] Config history tracked (last 20 entries)

### Phase 3: Execution Engine

- [x] Pipeline run workflow executes in both legacy and graph mode
- [x] Parallel groups fan out and collect correctly
- [x] Early stop (`pipelineShouldStop`) works
- [x] Failure strategies propagate correctly
- [x] Run records persist to MongoDB
- [x] Scheduler starts/stops cron schedules

### Phase 4: Compute Services

- [x] All 10+ compute services implement uniform interface
- [x] LLM client factory resolves credentials
- [x] Store insight writes to ClickHouse
- [x] HTTP request node supports callouts

### Phase 5: Analytics & Storage

- [x] ClickHouse tables created with correct schema
- [x] Materialized views aggregate daily
- [x] Analytics cache hits/misses/invalidates correctly
- [x] Fail-open on Redis error

### Phase 6: Eval Pipeline

- [x] Eval workflow loads eval set and builds matrix
- [x] Preflight validation runs before execution
- [x] Conversations fan out with batched concurrency
- [x] Judging fans out with LLM-as-judge
- [x] Aggregation computes statistics (pass@k, confidence intervals)
- [x] Circuit breakers prevent cascading failures

### Phase 7: Runtime Routes

- [x] All 13 endpoints respond correctly
- [x] Auth middleware enforced on all routes
- [x] RBAC permissions enforced (session:read / project:write)
- [x] Config validation rejects invalid input with Zod errors

### Phase 8: Studio UI

- [x] Pipeline list page renders built-in and custom pipelines
- [x] Config page renders dynamic forms from schema
- [x] Graph editor renders nodes and edges
- [x] Trigger manager allows cron and event configuration

---

## 4. Wiring Checklist

| Component                   | Wired Into                                                              | Verified |
| --------------------------- | ----------------------------------------------------------------------- | -------- |
| Graph walker                | `pipeline-run.workflow.ts` (graph mode)                                 | Yes      |
| Expression evaluator        | `pipeline-run.workflow.ts` (conditions), `graph-utils.ts` (transitions) | Yes      |
| Config schemas              | `pipeline-config.ts` route (PUT validation)                             | Yes      |
| Config service              | `pipeline-config.ts` route (all endpoints)                              | Yes      |
| Activity router             | `pipeline-run.workflow.ts` (step dispatch)                              | Yes      |
| Pipeline scheduler          | `server.ts` (Restate registration)                                      | Yes      |
| Pipeline trigger            | `server.ts` (Restate registration)                                      | Yes      |
| Pipeline run workflow       | `pipeline-trigger.service.ts` (fire-and-forget)                         | Yes      |
| Eval run workflow           | `server.ts` (Restate registration)                                      | Yes      |
| Analytics cache             | `pipeline-analytics.ts` route                                           | Yes      |
| Definition cache            | `pipeline-trigger.service.ts`                                           | Yes      |
| All compute services        | `activity-router.service.ts` dispatch table                             | Yes      |
| All eval services           | `eval-run.workflow.ts` and `activity-router.service.ts`                 | Yes      |
| ClickHouse table init       | `server.ts` (startup)                                                   | Yes      |
| Node type seeding           | `server.ts` (startup)                                                   | Yes      |
| Pipeline definition seeding | `server.ts` (startup)                                                   | Yes      |
| Runtime routes              | Runtime app route registration                                          | Yes      |
| Studio components           | Studio app page routing                                                 | Yes      |

---

## 5. Open Gaps for Future Phases

### Gap 1: E2E Test Suite (Priority: HIGH) — DEFERRED

**What**: No E2E tests exist for any pipeline engine functionality through HTTP APIs.
**Why**: Unit tests mock stores and services. No test verifies the full request path (auth -> middleware -> route -> service -> DB -> response).
**Plan**: Implement 7 E2E scenarios defined in test spec (E2E-1 through E2E-7). Requires real Express server on random port with auth setup.
**Status**: Deferred — pipeline engine routes are thin wrappers over Restate invocations; core logic is tested via unit and integration tests. E2E requires Restate test infrastructure not yet available.

### Gap 2: Cross-Tenant/Project Isolation Tests (Priority: HIGH) — PARTIALLY RESOLVED

**What**: No test verifies that cross-tenant or cross-project access returns 404.
**Why**: Route handlers use `requireProjectScope` and `tenantId` filtering, but no test exercises these boundaries.
**Plan**: Add isolation-specific E2E tests as part of E2E-2 scenario.
**Status**: db-query tenant/project isolation enforced and tested (parameterized ClickHouse queries, MongoDB projectId injection). Route-level isolation deferred with E2E test suite.

### Gap 3: Pipeline Run Record Cleanup (Priority: MEDIUM) — RESOLVED

**What**: No TTL or archival policy for `pipeline_run_records` in MongoDB.
**Resolution**: Added 90-day TTL index on `startedAt` field in `PipelineRunRecordSchema`.

### Gap 4: console.log Replacement (Priority: LOW) — RESOLVED

**What**: Several files in Restate handlers used `console.log` instead of `createLogger`.
**Resolution**: All bare `console.log` migrated to `createLogger` in `activity-router.service.ts`, `pipeline-trigger.service.ts`, `pipeline-run.workflow.ts`. Restate's `ctx.console.log` (journal-aware) preserved.

### Gap 5: Eval Pipeline E2E Testing (Priority: MEDIUM)

**What**: No E2E test for the full eval pipeline lifecycle.
**Why**: Requires Restate runtime, MongoDB, ClickHouse, and either real LLM or DI-based mock.
**Plan**: Create integration test that exercises eval workflow with mocked LLM provider via DI.

---

## 6. Rollback Strategy

Since the Pipeline Engine implementation is complete (feature is BETA — 5 E2E suites, 5 integration files), rollback considerations are for future changes:

1. **Config schema changes**: New config fields must have `default` values in Zod schemas so existing configs parse without error. Never remove required fields.
2. **ClickHouse schema changes**: Use `ALTER TABLE ... ADD COLUMN IF NOT EXISTS` for additive changes. Never drop columns in production.
3. **Pipeline definition changes**: New built-in definitions are seeded with `upsert` semantics (idempotent). Existing definitions are not overwritten if they exist.
4. **Node type changes**: `NodeTypeDefinitionDoc` has a `version` field and `isActive` flag. New versions can coexist with old ones.
5. **API changes**: New endpoints are additive. Existing endpoint response shapes must maintain backward compatibility.
