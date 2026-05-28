# Feature Test Guide: Pipeline Engine

**Feature**: Pipeline Engine -- graph-based analytics and evaluation pipeline framework
**Owner**: Platform team
**Branch**: develop
**Related Feature Doc**: [docs/features/pipeline-engine.md](../features/pipeline-engine.md)
**First tested**: 2026-03-09
**Last updated**: 2026-04-15
**Overall status**: PARTIAL -- 5 E2E suites (22 tests) passing; 6 integration test files (incl. trigger→execution path); 59 unit test files covering all 18 FRs; 36 pipeline observability tests (schema resolver, query builder, test route, project isolation)

---

## Current State (as of 2026-03-24)

The Pipeline Engine has broad unit test coverage across the core graph walker, expression evaluator, config schemas, node registry, pipeline triggers, all compute services (sentiment, intent, quality, statistical, toxicity, etc.), eval pipeline components, activity routing, and all 7 newly-wired node-type services (sub-pipeline, db-query, filter, aggregate, send-email, send-slack, publish-kafka). Additional coverage includes activity metadata completeness checks, alert evaluator activation, NL query, ROI calculation, outcome classification, and experiment results. Integration tests verify end-to-end graph pipeline execution, insight pipeline flows, toxicity pipeline flows, and the full trigger-to-execution path with real MongoDB. Runtime route tests cover pipeline configuration CRUD and analytics query endpoints. The primary gap is E2E testing of the full pipeline lifecycle through HTTP APIs and E2E evaluation pipeline testing.

### Quick Health Dashboard

| Area                                   | Status     | Last Verified | Notes                                                                                    |
| -------------------------------------- | ---------- | ------------- | ---------------------------------------------------------------------------------------- |
| Graph walker traversal                 | PASS       | 2026-03-22    | Node execution, transition resolution, visit limits, failure policies                    |
| Graph validation                       | PASS       | 2026-03-22    | Structure validation, cycle detection, unreachable nodes                                 |
| Graph utilities                        | PASS       | 2026-03-22    | Transition resolution, node lookup, back-edge detection                                  |
| Expression evaluator                   | PASS       | 2026-03-22    | CEL-like condition evaluation, safety validation                                         |
| Config schemas (Zod)                   | PASS       | 2026-03-22    | Per-pipeline-type validation, dynamic schema generation                                  |
| Pipeline config service                | PASS       | 2026-03-22    | Three-tier resolution, CRUD, trigger resolution                                          |
| Pipeline triggers                      | PASS       | 2026-03-22    | Trigger logic, trigger graph pipeline, sampling                                          |
| Node registry                          | PASS       | 2026-03-22    | Registration, lookup, validation, trait merging, DB loading                              |
| Cron expression parsing                | PASS       | 2026-03-22    | Cron schedule parsing and validation                                                     |
| Compute services (all 10+)             | PASS       | 2026-03-22    | Sentiment, intent, quality, toxicity, statistical, etc.                                  |
| Analytics cache                        | PASS       | 2026-03-22    | Redis cache hit/miss, fail-open fallback, TTL                                            |
| Activity router                        | PASS       | 2026-03-22    | Activity dispatch, unknown type handling                                                 |
| Activity services                      | PASS       | 2026-03-22    | Service execution patterns                                                               |
| Pipeline run workflow                  | PASS       | 2026-03-22    | Workflow logic, step execution, failure handling                                         |
| Eval circuit breakers                  | PASS       | 2026-03-22    | Circuit breaker error handling                                                           |
| Experiment results                     | PASS       | 2026-03-22    | Statistical significance, t-test                                                         |
| Activity metadata completeness         | PASS       | 2026-03-24    | Handler-metadata parity, orphan detection                                                |
| Node-type dispatch (7 new services)    | PASS       | 2026-03-24    | sub-pipeline, db-query, filter, aggregate, send-email, send-slack, publish-kafka         |
| Alert evaluator activation             | PASS       | 2026-03-24    | evaluateCondition, scheduler state, pipeline failure hooks                               |
| Integration: graph pipeline            | PASS       | 2026-03-22    | End-to-end graph execution with mock nodes                                               |
| Integration: insight pipeline          | PASS       | 2026-03-22    | Insight generation and storage                                                           |
| Integration: toxicity pipeline         | PASS       | 2026-03-22    | Toxicity detection pipeline flow                                                         |
| Integration: config-driven pipeline    | PASS       | 2026-03-22    | Config-driven node type pipeline                                                         |
| Runtime: pipeline config route         | PASS       | 2026-03-22    | CRUD API, project scope, auth                                                            |
| Runtime: pipeline analytics route      | PASS       | 2026-03-22    | Summary, breakdown, conversation queries                                                 |
| Studio: SchemaFieldBuilder             | PASS       | 2026-03-22    | Dynamic form field rendering                                                             |
| E2E: pipeline config CRUD (E2E-1)      | PASS       | 2026-03-23    | Config list, get, put, toggle, history, schema via HTTP                                  |
| E2E: pipeline config isolation (E2E-2) | PASS       | 2026-03-23    | Cross-project independence, cross-tenant 404, unauth 401                                 |
| E2E: pipeline config RBAC (E2E-7)      | PASS       | 2026-03-23    | Viewer read OK, viewer write 403, invalid type/body 400                                  |
| E2E: config validation (E2E-4)         | PASS       | 2026-03-23    | Zod schema rejects invalid configs at API boundary                                       |
| E2E: trigger states API (E2E-6)        | PASS       | 2026-03-23    | Trigger resolution, active states, config overrides                                      |
| Integration: execution pipeline        | PASS       | 2026-03-23    | walkGraph → buildExecutionContext → real handlers (full data flow)                       |
| Integration: trigger→execution path    | PASS       | 2026-03-23    | Kafka event → trigger matching → strategy resolution → dispatch (11 tests, real MongoDB) |
| Observability: schema resolver         | PASS       | 2026-04-13    | Pipeline output schema resolution from MongoDB (8 tests)                                 |
| Observability: query builder           | PASS       | 2026-04-13    | SQL construction, column allowlist, parameterization, tenant isolation (18 tests)        |
| Observability: test route              | PASS       | 2026-04-13    | Manual test trigger with Restate ingress, rate limit, permission check (7 tests)         |
| Observability: project isolation       | PASS       | 2026-04-13    | Project-scoped run queries return only matching records (3 tests)                        |
| E2E: pipeline analytics query          | NOT TESTED | -             | Requires ClickHouse — out of scope (analytics is separate feature)                       |
| E2E: eval pipeline lifecycle           | NOT TESTED | -             | Requires Restate + ClickHouse — infrastructure-dependent                                 |
| E2E: pipeline observability UI         | NOT TESTED | -             | Requires Restate + ClickHouse + running Studio                                           |

---

## Audit Scope

This guide covers:

- Core graph walker engine (traversal, transitions, failure policies, visit limits)
- Graph validation (structure, cycles, unreachable nodes)
- Expression evaluator for conditional transitions (safety, parsing, evaluation)
- Pipeline configuration (Zod schemas, three-tier resolution, CRUD routes, trigger resolution)
- Pipeline trigger logic and graph-based triggers
- Node registry and node type definitions (static + DB-backed)
- Compute services (sentiment, intent, quality, statistical, toxicity, goal completion, mentions, tool effectiveness, predictive features, LLM evaluation)
- Analytics cache with Redis (TTL, fail-open, invalidation)
- Experiment results service (statistical significance, t-test)
- Pipeline run workflow and eval run workflow (Restate)
- Activity router and activity services
- Node-type services (sub-pipeline, db-query, filter, aggregate, send-email, send-slack, publish-kafka)
- Activity metadata completeness (handler-metadata parity)
- Eval pipeline components (preflight, circuit breakers, compression)
- Alert evaluator activation (condition evaluation, scheduler state, pipeline failure hooks)
- NL query service (natural language to SQL)
- ROI calculator
- Outcome classification
- Studio pipeline editor components
- Backfill service
- Template engine
- Trait merging

---

## Coverage Matrix

### Functional Requirements Coverage

| FR    | Description                      | Unit | Integration | E2E | Status    |
| ----- | -------------------------------- | ---- | ----------- | --- | --------- |
| FR-1  | 10 built-in pipeline definitions | YES  | YES         | NO  | Partial   |
| FR-2  | Graph-based definitions          | YES  | YES         | NO  | Partial   |
| FR-3  | Graph walker execution           | YES  | YES         | NO  | Partial   |
| FR-4  | Three-tier config resolution     | YES  | NO          | YES | Covered   |
| FR-5  | Zod config validation            | YES  | NO          | YES | Covered   |
| FR-6  | Cron scheduling via Restate      | YES  | NO          | NO  | Unit only |
| FR-7  | Event-driven triggering          | YES  | NO          | YES | Covered   |
| FR-8  | ClickHouse result storage        | NO   | YES (mock)  | NO  | Partial   |
| FR-9  | Analytics query APIs             | YES  | NO          | NO  | Unit only |
| FR-10 | Eval pipeline execution          | NO   | NO          | NO  | GAP       |
| FR-11 | Pipeline definition validation   | YES  | NO          | NO  | Unit only |
| FR-12 | Dynamic Zod schema generation    | YES  | NO          | NO  | Unit only |
| FR-13 | Backfill capability              | YES  | NO          | NO  | Unit only |
| FR-14 | NL Query (NL→SQL)                | YES  | NO          | NO  | Unit only |
| FR-15 | ROI calculation                  | YES  | NO          | NO  | Unit only |
| FR-16 | Threshold-based alerting         | YES  | NO          | NO  | Unit only |
| FR-17 | Outcome classification           | YES  | NO          | NO  | Unit only |
| FR-18 | A/B experiment results           | YES  | NO          | NO  | Unit only |
| FR-19 | Inline control flow activities   | YES  | NO          | NO  | Unit only |

### Isolation & Security Coverage

| Scenario                           | Coverage Type | Status     | Notes                                             |
| ---------------------------------- | ------------- | ---------- | ------------------------------------------------- |
| Project-scoped config access       | unit          | PASS       | Route tests verify projectId in queries           |
| Cross-project config access denied | e2e           | PASS       | E2E-2 verifies cross-project independence         |
| Tenant-scoped config access        | unit + e2e    | PASS       | Route tests + E2E-2 verify tenantId in queries    |
| Cross-tenant config access denied  | e2e           | PASS       | E2E-2 verifies cross-tenant returns 404           |
| Auth required for all endpoints    | unit          | PASS       | Routes use authMiddleware                         |
| RBAC permissions enforced          | unit          | PASS       | Routes use requireProjectPermission               |
| Expression evaluator safety        | unit          | PASS       | Banned keywords, operators, bracket access tested |
| ClickHouse query parameterization  | N/A           | NOT TESTED | No integration test with real ClickHouse          |

---

## Test Inventory

### Unit Tests (packages/pipeline-engine)

| Test File                                              | Suites | Status | Key Scenarios                                                                                          |
| ------------------------------------------------------ | ------ | ------ | ------------------------------------------------------------------------------------------------------ |
| `src/__tests__/graph-walker.test.ts`                   | ~8     | PASS   | Linear traversal, conditional branching, visit limits, failure policies (stop/skip/continue), hard cap |
| `src/__tests__/graph-validation.test.ts`               | ~6     | PASS   | Valid graphs, missing entry node, unreachable nodes, cycle detection                                   |
| `src/__tests__/graph-utils.test.ts`                    | ~4     | PASS   | Transition resolution, default transitions, condition matching                                         |
| `src/__tests__/expression-evaluator.test.ts`           | ~8     | PASS   | Comparison, logical, nested access, safety validation, pipelineInput access                            |
| `src/__tests__/config-schemas.test.ts`                 | ~6     | PASS   | Per-pipeline-type Zod validation, dynamic schema builder, defaults                                     |
| `src/__tests__/pipeline-config.test.ts`                | ~5     | PASS   | Config service three-tier resolution, create, update, trigger resolution                               |
| `src/__tests__/pipeline-trigger.test.ts`               | ~4     | PASS   | Trigger evaluation, event matching, sampling                                                           |
| `src/__tests__/pipeline-trigger-graph.test.ts`         | ~3     | PASS   | Graph-based trigger pipeline                                                                           |
| `src/__tests__/pipeline-run.test.ts`                   | ~3     | PASS   | Pipeline run workflow logic                                                                            |
| `src/__tests__/node-registry.test.ts`                  | ~4     | PASS   | Node type registration, lookup, validation, bounded Map                                                |
| `src/__tests__/cron.test.ts`                           | ~3     | PASS   | Cron expression parsing, next run calculation                                                          |
| `src/__tests__/activity-router.test.ts`                | ~3     | PASS   | Activity dispatch routing                                                                              |
| `src/__tests__/activity-services.test.ts`              | ~3     | PASS   | Pipeline activity service patterns                                                                     |
| `src/__tests__/compute-sentiment.test.ts`              | ~4     | PASS   | Sentiment analysis node execution                                                                      |
| `src/__tests__/compute-intent.test.ts`                 | ~4     | PASS   | Intent classification node                                                                             |
| `src/__tests__/compute-quality.test.ts`                | ~4     | PASS   | Quality evaluation node                                                                                |
| `src/__tests__/compute-statistical.test.ts`            | ~3     | PASS   | Statistical computation node                                                                           |
| `src/__tests__/compute-toxicity.test.ts`               | ~3     | PASS   | Toxicity detection node                                                                                |
| `src/__tests__/compute-llm-evaluation.test.ts`         | ~3     | PASS   | LLM-based evaluation compute                                                                           |
| `src/__tests__/compute-goal-completion.test.ts`        | ~3     | PASS   | Goal completion tracking                                                                               |
| `src/__tests__/compute-mentions.test.ts`               | ~3     | PASS   | Mention extraction node                                                                                |
| `src/__tests__/compute-tool-effectiveness.test.ts`     | ~3     | PASS   | Tool effectiveness metrics                                                                             |
| `src/__tests__/compute-predictive-features.test.ts`    | ~3     | PASS   | Predictive ML feature computation                                                                      |
| `src/__tests__/llm-evaluate.test.ts`                   | ~3     | PASS   | LLM evaluation node                                                                                    |
| `src/__tests__/analytics-cache.test.ts`                | ~4     | PASS   | Cache hit, miss, TTL, fail-open on Redis error, invalidation                                           |
| `src/__tests__/experiment-results.test.ts`             | ~4     | PASS   | Statistical significance, group metrics, sample size adequacy                                          |
| `src/__tests__/insight-types.test.ts`                  | ~3     | PASS   | Typed insight validation                                                                               |
| `src/__tests__/insight-results-schema.test.ts`         | ~3     | PASS   | Insight result schema validation                                                                       |
| `src/__tests__/store-insight.test.ts`                  | ~3     | PASS   | ClickHouse insight storage                                                                             |
| `src/__tests__/nl-query.test.ts`                       | ~3     | PASS   | Natural language to SQL query                                                                          |
| `src/__tests__/outcome-classification.test.ts`         | ~3     | PASS   | Outcome classification logic                                                                           |
| `src/__tests__/roi-calculator.test.ts`                 | ~3     | PASS   | ROI calculation                                                                                        |
| `src/__tests__/alert-evaluator.test.ts`                | ~3     | PASS   | Alert threshold evaluation                                                                             |
| `src/__tests__/backfill.test.ts`                       | ~2     | PASS   | Historical data backfill                                                                               |
| `src/__tests__/read-conversation.test.ts`              | ~3     | PASS   | Conversation reading for pipeline input                                                                |
| `src/__tests__/conversation-reader.test.ts`            | ~3     | PASS   | Conversation reader service                                                                            |
| `src/__tests__/http-request.test.ts`                   | ~3     | PASS   | HTTP request node                                                                                      |
| `src/__tests__/template-engine.test.ts`                | ~3     | PASS   | Template rendering for pipeline prompts                                                                |
| `src/__tests__/trait-merger.test.ts`                   | ~2     | PASS   | Trait merging logic                                                                                    |
| `src/__tests__/config-driven-types.test.ts`            | ~3     | PASS   | Config-driven type validation                                                                          |
| `src/__tests__/node-type-definition-schema.test.ts`    | ~3     | PASS   | Node type definition schema validation                                                                 |
| `src/__tests__/node-types.test.ts`                     | ~3     | PASS   | Node type implementations                                                                              |
| `src/__tests__/execution-context.test.ts`              | ~3     | PASS   | Pipeline execution context                                                                             |
| `src/__tests__/validation.test.ts`                     | ~3     | PASS   | Pipeline input validation                                                                              |
| `src/__tests__/register-nodes.test.ts`                 | ~2     | PASS   | Node registration                                                                                      |
| `src/__tests__/seed-data.test.ts`                      | ~2     | PASS   | Built-in pipeline seeding                                                                              |
| `src/__tests__/seed-node-types.test.ts`                | ~2     | PASS   | Node type seeding                                                                                      |
| `src/__tests__/eval-preflight.test.ts`                 | ~2     | PASS   | Eval preflight validation (self-contained env setup)                                                   |
| `src/__tests__/eval-circuit-breaker-errors.test.ts`    | ~3     | PASS   | Eval circuit breaker error handling                                                                    |
| `src/__tests__/activity-metadata-completeness.test.ts` | ~3     | PASS   | Activity metadata wiring completeness, handler-metadata parity                                         |
| `src/__tests__/unwired-node-dispatch.test.ts`          | ~7     | PASS   | Dispatch integration for newly-wired node types (mock Restate ctx)                                     |
| `src/__tests__/sub-pipeline.test.ts`                   | ~3     | PASS   | SubPipeline service: validation, depth guard, input mapping                                            |
| `src/__tests__/db-query.test.ts`                       | ~4     | PASS   | DbQuery service: MongoDB/ClickHouse paths, tenant+project isolation, SQL validation                    |
| `src/__tests__/filter-service.test.ts`                 | ~3     | PASS   | Filter service: expression filtering, empty array handling, missing config                             |
| `src/__tests__/aggregate-service.test.ts`              | ~3     | PASS   | Aggregate service: count/sum/avg/min/max/collect, empty dataset, missing config                        |
| `src/__tests__/send-email.test.ts`                     | ~3     | PASS   | SendEmail service: validation, template substitution, graceful degradation                             |
| `src/__tests__/send-slack.test.ts`                     | ~3     | PASS   | SendSlack service: validation, webhook dispatch, graceful degradation                                  |
| `src/__tests__/publish-kafka.test.ts`                  | ~3     | PASS   | PublishKafka service: validation, message key templates, graceful degradation                          |
| `src/__tests__/alert-evaluator-activation.test.ts`     | ~4     | PASS   | Alert activation: evaluateCondition, input validation, scheduler state, failure hooks                  |

### Integration Tests (packages/pipeline-engine)

| Test File                                              | Suites | Status | Key Scenarios                                                                  |
| ------------------------------------------------------ | ------ | ------ | ------------------------------------------------------------------------------ |
| `src/__tests__/integration-graph-pipeline.test.ts`     | ~4     | PASS   | Full graph traversal with mock executors, branching, error handling            |
| `src/__tests__/integration-insight-pipeline.test.ts`   | ~3     | PASS   | End-to-end insight generation and storage                                      |
| `src/__tests__/integration-toxicity-pipeline.test.ts`  | ~3     | PASS   | Toxicity pipeline end-to-end                                                   |
| `src/__tests__/config-driven-integration.test.ts`      | ~3     | PASS   | Config-driven node type pipeline integration                                   |
| `src/__tests__/integration-execution-pipeline.test.ts` | ~5     | PASS   | walkGraph → buildExecutionContext → real handlers (full data flow)             |
| `src/__tests__/integration-trigger-execution.test.ts`  | ~11    | PASS   | Kafka event → trigger matching → strategy resolution → dispatch (real MongoDB) |

### Runtime Route Tests

| Test File                                                            | Suites | Status | Key Scenarios                                 |
| -------------------------------------------------------------------- | ------ | ------ | --------------------------------------------- |
| `apps/runtime/src/__tests__/pipeline-config.test.ts`                 | ~5     | PASS   | CRUD, project scope, auth, validation         |
| `apps/runtime/src/__tests__/routes/pipeline-analytics-route.test.ts` | ~4     | PASS   | Summary, breakdown, conversations, drill-down |

### Studio Component Tests

| Test File                                                                    | Suites | Status | Key Scenarios                                        |
| ---------------------------------------------------------------------------- | ------ | ------ | ---------------------------------------------------- |
| `apps/studio/src/components/pipelines/__tests__/SchemaFieldBuilder.test.tsx` | ~3     | PASS   | Field rendering, validation, dynamic form generation |

---

## E2E Test Scenarios (REQUIRED -- 5 of 7 implemented)

### E2E-1: Pipeline Config CRUD Lifecycle

**Priority**: HIGH
**Status**: PASS (covered by `pipeline-config.e2e.test.ts` — 6 tests)
**Description**: Full lifecycle test for pipeline configuration through Runtime HTTP API.
**Steps**:

1. POST auth to get JWT token
2. GET `/api/projects/:projectId/pipeline-config` -- verify empty or default list
3. PUT `/api/projects/:projectId/pipeline-config/sentiment_analysis` with valid config
4. GET `/api/projects/:projectId/pipeline-config/sentiment_analysis` -- verify saved config
5. PATCH `/api/projects/:projectId/pipeline-config/sentiment_analysis/toggle` with `{ enabled: true }`
6. GET `/api/projects/:projectId/pipeline-config/sentiment_analysis/history` -- verify version history
7. PUT again with modified config -- verify version incremented
8. GET `/api/projects/:projectId/pipeline-config/sentiment_analysis/schema` -- verify schema fields

**Assertions**: Status codes, response shape, version incrementing, config persistence, schema presence.

### E2E-2: Pipeline Config Isolation

**Priority**: HIGH
**Status**: PASS (covered by `pipeline-config.e2e.test.ts` — 3 tests)
**Description**: Verify project and tenant isolation for pipeline configs.
**Steps**:

1. Create config for project A under tenant T1
2. Attempt to read config for project B under tenant T1 -- should not see project A's config
3. Attempt to read config for project A under tenant T2 -- should return 404 or empty
4. Verify `requireProjectScope` middleware blocks cross-project access
5. Verify unauthenticated request returns 401

**Assertions**: Cross-project returns different/empty data, cross-tenant returns 404, auth required.

### E2E-3: Pipeline Analytics Query via HTTP

**Priority**: HIGH
**Description**: Full analytics query lifecycle through Runtime HTTP API.
**Steps**:

1. Authenticate and get JWT
2. GET `/api/projects/:projectId/pipeline-analytics/sentiment_analysis/summary` with date range
3. GET `/api/projects/:projectId/pipeline-analytics/sentiment_analysis/breakdown?dimension=agent`
4. GET `/api/projects/:projectId/pipeline-analytics/sentiment_analysis/conversations?minScore=0.5`
5. GET `/api/projects/:projectId/pipeline-analytics/sentiment_analysis/conversation/:sid`

**Assertions**: Status 200, response envelope `{ success: true, data }`, correct data shape per endpoint.

### E2E-4: Pipeline Config Validation

**Priority**: MEDIUM
**Status**: PASS (covered by `pipeline-config.e2e.test.ts` — 5 tests)
**Description**: Verify Zod schema validation rejects invalid configs at the API boundary.
**Steps**:

1. PUT config with invalid `samplingRate` (> 1.0) -- should return 400
2. PUT config with unknown pipeline type -- should return 400
3. PUT config with missing required `config` field -- should return 400
4. PUT config with valid config for `intent_classification` including taxonomy -- should return 200
5. PUT config with valid `activeTriggers` -- should return 200

**Assertions**: 400 responses include `issues` array, 200 responses include saved config.

### E2E-5: Backfill API Lifecycle

**Priority**: MEDIUM
**Description**: Test the backfill initiation and status tracking via HTTP API.
**Steps**:

1. GET `/api/projects/:projectId/pipeline-config/sentiment_analysis/backfill/status` -- should return initial state
2. POST `/api/projects/:projectId/pipeline-config/sentiment_analysis/backfill` -- initiate backfill
3. GET backfill status again -- should reflect new state
4. POST backfill while already running -- should return 409

**Assertions**: Status transitions, conflict detection, response shapes.

### E2E-6: Trigger States API

**Priority**: MEDIUM
**Status**: PASS (covered by `pipeline-config.e2e.test.ts` — 4 tests)
**Description**: Verify trigger state resolution through HTTP API.
**Steps**:

1. GET `/api/projects/:projectId/pipeline-config/sentiment_analysis/triggers`
2. Verify response includes supported triggers with active state and sampling rates
3. PUT config with custom `activeTriggers` array
4. GET triggers again -- verify updated active states

**Assertions**: Trigger list matches definition, active states reflect config overrides.

### E2E-7: Pipeline Config with Permission Checks

**Priority**: HIGH
**Status**: PASS (covered by `pipeline-config.e2e.test.ts` — 4 tests)
**Description**: Verify RBAC permissions are enforced.
**Steps**:

1. Authenticate as user with `session:read` permission only
2. GET config -- should succeed (requires `session:read`)
3. PUT config -- should fail 403 (requires `project:write`)
4. PATCH toggle -- should fail 403 (requires `project:write`)

**Assertions**: Read-only users can read but not write. Permission errors return appropriate status.

---

## Integration Test Scenarios (REQUIRED)

### INT-1: Graph Walker with Complex Pipeline

**Priority**: HIGH
**Status**: PASS (covered by `integration-graph-pipeline.test.ts`)
**Description**: Full graph traversal with multiple node types, conditional branching, failure handling, and execution context propagation.

### INT-2: Config Resolution Chain

**Priority**: HIGH
**Status**: Partial (unit test only in `pipeline-config.test.ts`)
**Description**: Verify project-level config overrides tenant-level, which overrides platform defaults. Test with real PipelineConfigService against MongoDB.

### INT-3: Expression Evaluator in Graph Pipeline

**Priority**: HIGH
**Status**: PASS (covered by integration tests)
**Description**: Verify CEL-like expressions control graph transitions correctly in integrated pipeline execution.

### INT-4: Pipeline Trigger Event Matching

**Priority**: MEDIUM
**Status**: Partial (unit test in `pipeline-trigger.test.ts`)
**Description**: Verify event-driven trigger matching: Kafka topic resolution, event filter application, sampling rate enforcement, strategy resolution.

### INT-5: Analytics Cache Integration

**Priority**: MEDIUM
**Status**: PASS (covered by `analytics-cache.test.ts`)
**Description**: Verify cache hit/miss behavior, TTL expiry, fail-open on Redis error.

### INT-6: Node Registry DB Loading

**Priority**: MEDIUM
**Status**: Partial (covered by `node-registry.test.ts`)
**Description**: Verify `loadFromDocs()` correctly loads node type definitions from MongoDB documents with trait merging.

### INT-7: Insight Pipeline End-to-End

**Priority**: MEDIUM
**Status**: PASS (covered by `integration-insight-pipeline.test.ts`)
**Description**: Verify full insight generation, scoring, and storage flow.

### INT-8: Eval Preflight Validation

**Priority**: MEDIUM
**Status**: PASS (covered by `eval-preflight.test.ts` — self-contained env setup)
**Description**: Verify eval preflight checks all prerequisites before starting an eval run.

---

## How to Run

```bash
# All pipeline-engine package tests
pnpm build --filter=pipeline-engine && pnpm test --filter=pipeline-engine -- --reporter=verbose

# Specific test files
pnpm test --filter=pipeline-engine -- src/__tests__/graph-walker.test.ts
pnpm test --filter=pipeline-engine -- src/__tests__/expression-evaluator.test.ts
pnpm test --filter=pipeline-engine -- src/__tests__/config-schemas.test.ts
pnpm test --filter=pipeline-engine -- src/__tests__/integration-graph-pipeline.test.ts

# Runtime pipeline route tests
pnpm build --filter=runtime && pnpm test --filter=runtime -- --reporter=verbose -t "pipeline"

# Studio pipeline component tests
pnpm test --filter=studio -- --reporter=verbose -t "SchemaFieldBuilder"

# Eval preflight test (self-contained, no env setup needed)
pnpm test --filter=pipeline-engine -- src/__tests__/eval-preflight.test.ts
```

---

## Coverage Gaps

| Gap                                                       | Severity | Notes                                                             |
| --------------------------------------------------------- | -------- | ----------------------------------------------------------------- |
| No E2E test for pipeline analytics through HTTP API       | High     | Analytics route tests mock ClickHouse client (separate feature)   |
| No E2E test for eval pipeline lifecycle                   | High     | Eval workflow requires Restate + MongoDB + ClickHouse             |
| No test for Restate pipeline scheduler                    | Medium   | Scheduler is a Restate virtual object; untestable without Restate |
| No test for ClickHouse query integration (analytics)      | Medium   | Analytics route tests mock ClickHouse client                      |
| No Studio UI integration tests for pipeline editor canvas | Low      | React Flow canvas interactions untested                           |
| No test for pipeline definition seeding lifecycle         | Low      | Seed data test exists but doesn't verify full lifecycle           |

**Resolved gaps (since BETA promotion):**

- ~~No E2E test for pipeline config CRUD~~ → E2E-1 (6 tests)
- ~~No cross-project isolation test~~ → E2E-2 (cross-project independence)
- ~~No cross-tenant isolation test~~ → E2E-2 (cross-tenant returns 404)
- ~~No RBAC permission boundary test~~ → E2E-7 (viewer read OK, viewer write 403)
- ~~Eval preflight requires ENCRYPTION_MASTER_KEY~~ → Test is self-contained (sets env in beforeEach)
