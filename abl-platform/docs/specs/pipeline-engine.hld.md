# HLD: Pipeline Engine

**Feature**: Pipeline Engine
**Status**: APPROVED (document finalized; feature is BETA — 5 E2E suites, 6 integration files)
**Date**: 2026-03-24
**Feature Spec**: `docs/features/pipeline-engine.md`
**Test Spec**: `docs/testing/pipeline-engine.md`

---

## 1. Problem Statement

Agent platforms generate vast conversational data but lack automated, systematic ways to evaluate conversation quality, detect trends, classify intents, identify hallucinations, and test agent behavior. The Pipeline Engine must provide:

1. A graph-based execution framework for analytics pipelines (10+ built-in analysis types) with 27 activity service handlers + 3 inline control-flow types
2. An evaluation framework for persona-driven agent testing with LLM-as-judge scoring, per-tenant rate limiting, circuit breakers, and OpenTelemetry instrumentation
3. Tiered configuration management (project > tenant > platform defaults)
4. Durable, crash-recoverable execution via Restate workflows
5. Fast analytical query APIs backed by ClickHouse with Redis caching
6. Standalone analytical services: NL-to-SQL queries, ROI calculation, threshold-based alerting, outcome classification, A/B experiment results

---

## 2. Alternatives Considered

### Alternative A: BullMQ-based Pipeline Execution (Rejected)

**Description**: Use BullMQ flows (already used elsewhere in the platform) for pipeline DAG execution.

**Pros**:

- Already available in the platform stack
- Good job visibility and retry semantics
- Redis-backed, familiar to the team

**Cons**:

- No built-in workflow durability (journal-based replay)
- Complex fan-out/fan-in requires custom orchestration
- No single-writer guarantee for scheduling (race conditions on cron)
- Parallel group execution requires manual coordination

**Why Rejected**: Restate provides durable workflow semantics with crash recovery, deterministic replay, and built-in parallelism (`CombineablePromise.all`). The `PipelineScheduler` Restate virtual object provides single-writer guarantee that prevents duplicate cron instances -- impossible with BullMQ without distributed locking.

### Alternative B: Temporal.io for Workflow Execution (Considered)

**Description**: Use Temporal for durable workflow execution.

**Pros**:

- Industry-standard workflow engine
- Excellent durability and replay semantics
- Strong TypeScript SDK

**Cons**:

- Additional infrastructure dependency (Temporal server)
- Higher operational complexity
- The platform already uses Restate for other services

**Why Not Chosen**: Restate was already adopted for other platform services. Adding Temporal would introduce a second workflow engine, increasing operational complexity. Restate's virtual object pattern (used for `PipelineScheduler`) maps naturally to the scheduling use case.

### Alternative C: Pure Function Pipeline without Workflow Engine (Rejected)

**Description**: Execute pipelines as direct function calls without a workflow engine.

**Pros**:

- Simplest architecture, no external dependencies
- Easy to test and debug

**Cons**:

- No crash recovery -- long-running pipelines (eval can run 30+ minutes) would be lost on restart
- No durable state -- progress not queryable during execution
- No parallelism guarantees without custom coordination
- No exactly-once semantics

**Why Rejected**: Eval pipelines can run 30+ minutes with hundreds of LLM calls. Without crash recovery, a single process restart would waste all progress. The `walkGraph()` function is kept pure for testability, but production execution wraps it in Restate workflows.

---

## 3. Chosen Architecture

### System Context

```
                          +------------------+
                          |   Studio UI      |
                          |  (React/Next.js) |
                          +--------+---------+
                                   | HTTP
                          +--------v---------+
                          |   Runtime API    |
                          |  (Express.js)    |
                          | pipeline-config  |
                          | pipeline-analytics|
                          | nl-analytics     |
                          | roi              |
                          +--------+---------+
                                   |
          +----------+-------------+--------------+
          |          |             |               |
   +------v------+  |      +-----v----+   +------v-----+
   |  Restate    |  |      | MongoDB  |   | ClickHouse |
   |  Server     |  |      |          |   |            |
   | +----------+|  |      | configs  |   | analytics  |
   | |Scheduler ||  |      | defs     |   | results    |
   | |Trigger   ||  |      | runs     |   | evals      |
   | |PipelineRun|  |      | nodes    |   | MVs        |
   | |EvalRun   ||  |      | alerts   |   +------+-----+
   | |ActivityRtr|  |      | tags     |          |
   | +----------+|  |      | exps     |   NL Query
   +------+------+  |      | costs    |   (LLM→SQL)
          |          |      +----------+
   +------v------+   |
   |   Kafka     |   |
   | 8 topics:   |   |
   | session.*   |   |
   | message.*   |   |
   | tool.*      |   |
   +-------------+   |
                      |
               +------v------+
               |   Redis     |
               |  analytics  |
               |  cache +    |
               |  def cache  |
               +-------------+
```

### Component Architecture

The Pipeline Engine consists of 7 major subsystems:

#### 3.1 Core Engine (`packages/pipeline-engine/src/pipeline/`)

- **Graph Walker** (`graph-walker.ts`): Pure function that traverses DAG nodes via `walkGraph()`. No side effects beyond calling the executor function. Supports visit limits (per-node `maxVisits`, hard cap 100), failure policies (`stop`/`skip`/`continue`).
- **Expression Evaluator** (`expression-evaluator.ts`): Custom recursive-descent parser for CEL-like expressions. Supports comparisons, logical operators, dot-path access. Safety enforcement: banned keywords, no eval/Function, no bracket access.
- **Graph Utilities** (`graph-utils.ts`): Transition resolution, cycle detection (`detectBackEdges`), reachable node computation (`findReachableNodes`).
- **Validation** (`validation.ts`): Pre-save validation of pipeline definitions -- step/node type checking, expression safety, step reference validation, graph structure validation.

#### 3.2 Configuration System

- **Config Schemas** (`config-schemas.ts`): Static Zod schemas for 10 built-in pipeline types plus dynamic schema builder (`buildZodSchema()`) for custom definitions. Shared base schema with `samplingRate`, `model`, `provider`, `stepOverrides`, `timeoutOverrides`.
- **Config Service** (`pipeline-config.service.ts`): Three-tier resolution (project > tenant > null) with version tracking (auto-increment), change history (last 20 entries), reprocessing detection, trigger resolution, and sampling rate resolution.
- **Config Defaults** (`config-defaults.ts`): Platform default values per pipeline type.

#### 3.3 Execution Engine (Restate)

- **Pipeline Run Workflow** (`pipeline-run.workflow.ts`): Dual-mode execution -- detects `nodes[]` + `entryNodeId` for graph mode, falls back to `steps[]` for legacy mode. Supports conditional steps, parallel groups (`CombineablePromise.all`), early stop (`pipelineShouldStop`), timeout overrides, and MongoDB persistence.
- **Eval Run Workflow** (`eval-run.workflow.ts`): Specialized eval orchestration -- loads eval set, runs preflight, builds persona x scenario x variant matrix, fans out conversations (batched by `maxConcurrency`), fans out judging, aggregates with statistics.
- **Pipeline Scheduler** (`pipeline-scheduler.ts`): Restate virtual object keyed by pipeline ID. Durable sleep + loop pattern for cron execution. Single-writer guarantee prevents duplicates.
- **Pipeline Trigger** (`pipeline-trigger.service.ts`): Handles Kafka events and manual triggers. Finds matching active pipelines, applies event filters, validates input schemas, enforces sampling rates, resolves execution strategies.
- **Activity Router** (`activity-router.service.ts`): Dispatch table mapping 27 activity types to handler functions, plus 3 inline control-flow types (`node-group` for parallel fan-out, `wait-for-event` for Restate awakeable suspension, `delay` for durable sleep).

#### 3.4 Analytics & Storage

- **ClickHouse Tables**: 27 tables (24 analytics with `ReplacingMergeTree`, 3 eval with `MergeTree`) partitioned by tenant with TTL (730 days). 10 materialized views for daily/hourly aggregation (6 analytics with `SummingMergeTree`, 4 eval with `AggregatingMergeTree`).
- **Analytics Cache** (`analytics-cache.ts`): Redis-backed with TTLs (5 min summary, 10 min timeseries, 1 hour conversation). Fail-open on Redis error.
- **Definition Cache** (`definition-cache.ts`): Redis-backed cache for pipeline definitions by Kafka topic. Fail-open to MongoDB.
- **Store Insight Service** (`store-insight.service.ts`): Generic ClickHouse writer for `InsightResult` records.

#### 3.5 Node Type System

- **Static Types** (`activity-metadata.ts`): Hardcoded `ACTIVITY_TYPES` map for built-in node types.
- **DB-Backed Types** (`node_type_definitions` collection): `NodeTypeDefinitionDoc` documents with configurable schemas, traits, storage schemas.
- **Node Registry** (`node-registry.ts`): Bounded Map (max 200) with `loadFromDocs()` for DB loading, trait-based field merging (`trait-merger.ts`), config validation.
- **Seed Node Types** (`seed-node-types.ts`): Auto-seeding of built-in node types on startup.
- **Extended Node Types**: 7 node types (`sub-pipeline`, `db-query`, `filter`, `aggregate`, `send-email`, `send-slack`, `publish-kafka`) have complete Restate service implementations, are seeded into MongoDB (visible in Studio Node Palette), and are registered in all three locations: `ACTIVITY_TYPES` metadata, `SERVICE_HANDLERS` dispatch table, and `.bind()` in `server.ts`.

#### 3.6 Eval Pipeline Services

- **Simulate Persona** (`simulate-persona.service.ts`): LLM-driven persona simulation.
- **Execute Agent Turn** (`execute-agent-turn.service.ts`): Sends messages to agent via Runtime API.
- **Run Eval Conversation** (`run-eval-conversation.service.ts`): Orchestrates persona-agent conversation loop.
- **Judge Conversation** (`judge-conversation.service.ts`): LLM-as-judge scoring with rubrics.
- **Trajectory Scorers** (`trajectory-scorers.ts`): Milestone completion, handoff correctness, path efficiency.
- **Aggregate Eval Run** (`aggregate-eval-run.service.ts`): Statistical aggregation (pass@k, confidence intervals, regression detection).
- **Eval Preflight** (`eval-preflight.ts`, `eval-preflight.service.ts`): Pre-run validation (credentials, agent availability).
- **Circuit Breakers** (`eval-circuit-breakers.ts`): 3 circuit breakers (persona LLM, judge LLM, agent executor) preventing cascading failures.
- **Compression** (`eval-compression.ts`): Gzip compression for ClickHouse storage (threshold: 1KB).
- **Rate Limiter** (`eval-rate-limiter.ts`): Per-tenant rate limiting with tier-based limits (free: 1 run / 3 conversations / 10 LLM/min; enterprise: 5 / 50 / 120). In-memory counters with sliding window, bounded Map (1000 entries, LRU eviction), auto-cleanup every 2 minutes.
- **Auth** (`eval-auth.ts`): Service-to-service JWT generation for Runtime API authentication during agent turn execution.
- **Buffered Writers** (`eval-clickhouse-writers.ts`): Batch-buffered ClickHouse writers (eval_conversations batch:500, eval_scores batch:2000).
- **OpenTelemetry** (`eval-metrics.ts`): 20+ OTel instruments (counters, histograms, gauges) covering conversation timing, judge latency, rate limit rejections, circuit breaker state, run completion status.
- **Alert Templates** (`eval-alerts.ts`): 8 pre-configured alert rules for eval monitoring (e.g., high error rate, slow conversations, judge failures).

#### 3.7 Standalone Analytical Services

Services that exist within the pipeline-engine package but operate independently of the pipeline execution framework. They do not use the activity router or graph walker.

- **NL Query Service** (`nl-query.service.ts`): Translates natural language questions to ClickHouse SQL via LLM using the semantic layer context (`semantic-layer.ts` -- JSON schema of all analytics tables). Safety validation: SELECT-only, tenant_id filter required, forbidden DDL/DML patterns. 30-second timeout, 1000-row limit. Exposed via `POST /api/projects/:projectId/nl-analytics/ask`.
- **ROI Calculator** (`roi-calculator.service.ts`): Computes savings, FTE equivalents, budget status, and containment simulation from per-project cost configs (`ProjectCostConfigModel`). Exposed via `GET|PUT /api/projects/:projectId/roi/config`, `GET /roi/summary`, `GET /roi/budget`, `POST /roi/simulate`.
- **Alert Evaluator** (`alert-evaluator.service.ts`): Restate service that evaluates threshold-based alert rules against ClickHouse metrics with configurable time windows, aggregations (avg/sum/count/min/max/p95/p99), conditions (gt/lt/gte/lte), cooldown, and multi-channel delivery (Slack/email/webhook). Bound via `AlertEvaluationScheduler` virtual object (cron-triggered per tenant) and pipeline failure hook in `pipeline-run.workflow.ts`.
- **Outcome Classification** (`outcome-classification.ts`): Pure function deriving normalized session outcomes (contained/escalated/abandoned) from session status and escalation events. Used at write time when sessions end.
- **Experiment Results** (`experiment-results.service.ts`): A/B experiment statistical analysis with t-test, chi-squared, and power analysis. Reads from ClickHouse experiment assignment data and `ExperimentModel` MongoDB collection. No API route -- exported for programmatic use only.
- **LLM Client Factory** (`llm-client-factory.ts`): Provider-neutral LLM client creation with 3-step DB credential resolution: (1) project-scoped ModelConfig → TenantModel → LLMCredential, (2) tenant fallback to default active TenantModel, (3) FAIL (no env var fallback). Supports Anthropic (Claude) and OpenAI (GPT) providers with model-provider compatibility validation and auto-decryption of API keys.

---

## 4. Data Flow

### 4.1 Analytics Pipeline Execution

```
Kafka Event -> PipelineTrigger.handleEvent
  |-- fetchDefinitions (Redis cache -> MongoDB fallback)
  |-- findActivePipelinesForEvent (filter by tenant, topic, enabled config)
  |-- Apply event filter, input validation, sampling
  +-- For each matching pipeline:
      |-- Resolve trigger strategy -> executionMode + steps
      |-- Create PipelineRunRecord in MongoDB
      +-- Start PipelineRun workflow (fire-and-forget)
          |-- Resolve pipeline config (project > tenant > platform)
          |-- Graph mode: traverse nodes via ActivityRouter
          |   |-- Execute node -> compute service
          |   |-- Build execution context
          |   |-- Resolve transition (expression evaluation)
          |   +-- Loop until no more transitions
          +-- Legacy mode: iterate steps array
              |-- Evaluate condition
              |-- Handle parallel groups (fan-out/fan-in)
              |-- Execute step via ActivityRouter
              +-- Handle failure policy (stop/skip/continue)
          |-- Finalize: overall status
          +-- Persist to MongoDB
```

### 4.2 Eval Pipeline Execution

```
Studio UI / API -> EvalRunWorkflow.run
  |-- Load EvalSet + Personas + Scenarios + Evaluators from MongoDB
  |-- Run preflight (credential check, agent check)
  |-- Build matrix: personas x scenarios x variants
  |-- Fan-out conversations (batched by maxConcurrency)
  |   +-- RunEvalConversation
  |       |-- SimulatePersona -> LLM
  |       |-- ExecuteAgentTurn -> Runtime API
  |       +-- Loop until maxTurns or END signal
  |-- Build diagnostic summary (group errors by pattern)
  |-- Fan-out judging (batched)
  |   +-- JudgeConversation
  |       |-- LLM-as-judge with rubric
  |       |-- Position swap for bias detection
  |       +-- Trajectory scoring
  |-- AggregateEvalRun
  |   |-- Compute statistics (pass@k, confidence intervals)
  |   |-- Regression detection (vs baseline)
  |   +-- Write to ClickHouse + MongoDB
  +-- Finalize status
```

### 4.3 Analytics Query Path

```
Studio UI -> Runtime API -> pipeline-analytics route
  |-- Auth + RBAC check
  |-- Check AnalyticsCache (Redis)
  |   |-- HIT -> return cached result
  |   +-- MISS -> query ClickHouse
  |       |-- Parameterized query with tenant_id, project_id filter
  |       |-- max_execution_time = 15 safety limit
  |       +-- Cache result in Redis with TTL
  +-- Return response
```

### 4.4 NL-to-SQL Query Path

```
Studio UI -> POST /api/projects/:projectId/nl-analytics/ask
  |-- Auth + RBAC + rate limit
  |-- Instantiate NLQueryService
  |-- Build LLM prompt with SEMANTIC_LAYER context
  |   +-- semantic-layer.ts: JSON schema of all ClickHouse analytics tables
  |-- Send to LLM (via llm-client-factory)
  |-- Validate generated SQL:
  |   |-- Must start with SELECT
  |   |-- Must include tenant_id = filter
  |   |-- Forbidden patterns: INSERT, UPDATE, DELETE, DROP, ALTER, etc.
  |   +-- Reject if validation fails
  |-- Execute against ClickHouse (30s timeout, 1000 row limit)
  +-- Return { question, sql, data, rowCount }
```

### 4.5 Kafka Event Flow

```
External System -> Kafka
  |-- 8 topics: abl.session.{created,ended,handoff,escalation},
  |             abl.message.{user,agent}, abl.tool.{called,completed}
  +-- Consumer (Restate-bound PipelineTrigger)
      |-- fetchDefinitions (Redis cache -> MongoDB fallback)
      |-- findActivePipelinesForEvent (filter by kafkaTopic, tenant, enabled)
      |-- For each match:
      |   |-- Resolve active triggers (config.activeTriggers || definition.defaultTriggerIds)
      |   |-- Apply event filter, input schema validation
      |   |-- Apply sampling rate (0-1, default 1.0)
      |   |-- Resolve execution strategy -> executionMode + steps
      |   +-- Dispatch PipelineRun workflow (fire-and-forget)
      +-- Trigger definitions: session-ended, user-message, agent-message, manual, schedule
```

---

## 5. Architectural Concerns (16)

### 5.1 Tenant Isolation

- All MongoDB queries include `tenantId` filter. Pipeline definitions use `tenantId: '__platform__'` for built-in definitions (available to all tenants).
- All ClickHouse queries include `tenant_id` parameter.
- Runtime routes enforce `requireProjectScope('projectId')` middleware.
- `loadActivePipeline()` filters by `tenantId: { $in: ['__platform__', tenantId] }`.

### 5.2 Project Isolation

- Pipeline configs have unique index `{ tenantId, projectId, pipelineType }`.
- All runtime routes use `requireProjectPermission()`.
- Analytics queries include `project_id` in ClickHouse WHERE clauses.

### 5.3 Authentication & Authorization

- Runtime routes use `authMiddleware` (JWT validation).
- Read operations require `session:read` permission.
- Write operations require `project:write` permission.
- Pipeline analytics route uses `requireProjectWideSessionVisibility` for session-level data access.
- NL Analytics route (`/nl-analytics/ask`) requires `authMiddleware` + `requireProjectScope` + `tenantRateLimit('request')`. Executes LLM-generated SQL -- safety validated but auth is critical.
- ROI route (`/roi/*`) requires `authMiddleware` + `requireProjectScope` + `tenantRateLimit`. Write operations (PUT config, POST simulate) require `project:write`.
- Eval pipeline uses service-to-service JWT (`eval-auth.ts`) for Runtime API calls during agent turn execution.

### 5.4 Performance

- **Targets**: Analytics query latency < 2s p95 (cached), pipeline execution success > 95%, cache hit rate > 70%.
- ClickHouse columnar storage for analytical queries.
- Materialized views for daily aggregation (avoid full-table scans).
- Redis analytics cache with tiered TTLs (5 min summary, 10 min timeseries, 1 hour conversation).
- Redis definition cache for high-frequency Kafka event handling (60s TTL).
- Eval pipeline batched concurrency control (`maxConcurrency`, default 5).
- ClickHouse TTL (730 days) for automatic data lifecycle.

### 5.5 Error Model

- Pipeline run failures are recorded in `PipelineRunRecord.error` with `{ stepId, message }`.
- Individual step failures follow the node's failure policy (`stop` = abort run, `skip` = continue to next, `continue` = mark failed but proceed).
- Activity router returns `{ status: 'fail', data: { error: string } }` for unknown/unregistered activity types.
- API routes return standard error envelope `{ success: false, error: { code, message } }`.
- NL Query returns validation errors if SQL safety checks fail (no query executed).
- ClickHouse query errors propagate as HTTP 500 with sanitized messages (no internal schema details leaked).

### 5.6 Reliability

- Restate durable workflows survive process crashes -- pipeline runs resume from last checkpoint.
- Fail-open caching (Redis unavailability falls through to data stores).
- Circuit breakers (3 in eval pipeline: persona LLM, judge LLM, agent executor) prevent cascading failures.
- Per-node failure policies (`stop`/`skip`/`continue`).
- Graph walker visit limits prevent infinite loops.
- `pipelineShouldStop` early-stop mechanism allows steps to halt the workflow gracefully.

### 5.7 Scalability

- Pipeline execution is horizontally scalable via Restate.
- ClickHouse scales with partitioning by tenant and date.
- Analytics cache reduces ClickHouse load under concurrent dashboard access.
- Eval pipeline fan-out is bounded by `maxConcurrency`.

### 5.8 Idempotency

- Restate workflows are inherently idempotent -- deterministic replay from journal means restarted workflows produce the same outcome.
- Pipeline config PUT is upsert-based (unique index on `{ tenantId, projectId, pipelineType }`) -- safe to retry.
- ClickHouse inserts are append-only; duplicate inserts for the same pipeline run would create duplicate rows. Mitigation: pipeline run has unique `runId`, and ClickHouse `ReplacingMergeTree` deduplicates by version during compaction.
- Kafka event processing: `PipelineTrigger.handleEvent` is invoked by Restate with exactly-once delivery semantics within a single invocation context.

### 5.9 Observability

- Structured logging via `createLogger()` throughout all handler files.
- Pipeline run records in MongoDB track step-level timing and status.
- Eval workflow `getStatus` shared handler for live progress monitoring (conversations completed, judgements completed, diagnostic summary).
- ClickHouse stores all results with timestamps for trend analysis.
- Eval pipeline: 20+ OpenTelemetry instruments covering conversation timing, judge latency, rate limit rejections, circuit breaker state, run completion status.
- **Audit logging**: Config changes are audit-logged via `configHistory` with `updatedBy`. NL Query executions log the generated SQL and user identity for security audit.

### 5.10 Data Lifecycle

- ClickHouse TTL: 730 days for analytics tables.
- Config history: last 20 entries.
- Pipeline run records: 90-day TTL index on `startedAt`.

### 5.11 User Isolation

N/A -- Pipeline configs are project-level resources, not user-owned. The `updatedBy` field tracks the last editor for audit purposes, but there is no per-user access control on pipeline configs. All users with `project:write` permission can modify any pipeline config in their project.

### 5.12 Security

- Expression evaluator safety validation prevents code injection (whitelist-only: comparisons, logical ops, dot-path access).
- ClickHouse parameterized queries prevent SQL injection.
- NL Query SQL validation: SELECT-only, tenant_id required, forbidden DDL/DML patterns. Residual risk: cross-table JOINs may bypass per-table tenant_id check.
- LLM credentials resolved via encrypted auth profile system (3-step DB lookup with auto-decryption).
- `max_execution_time = 15` prevents runaway ClickHouse queries (NL Query uses 30s for LLM-generated queries).

### 5.13 Migration & Compatibility

- Dual execution mode (legacy steps + graph nodes) maintains backward compatibility.
- `PipelineDefinition` retains optional legacy fields (`trigger`, `steps`, `inputSchema`, `outputSchema`).
- Node type system supports both static `ACTIVITY_TYPES` and DB-backed definitions.

### 5.14 Rollback Plan

- **Restate services**: Undeploy Restate services by removing `.bind()` calls in `server.ts` and restarting. In-flight workflows will stall but not corrupt data -- Restate retains journal entries.
- **ClickHouse DDL**: Analytics tables are append-only. Rollback = stop writing. Existing data can be retained or dropped with `DROP TABLE` (no foreign key dependencies).
- **MongoDB collections**: Pipeline configs, definitions, run records are independent. Drop collections or restore from backup. No cascading deletes to other features.
- **Kafka consumers**: PipelineTrigger is a Restate service consuming Kafka topics. Undeploy = stop consuming. Kafka retains messages per retention policy; no data loss.
- **Runtime routes**: Remove route registration in Express app. Immediate effect on restart.
- **NL Query / ROI routes**: Independent route files. Remove from route registration to disable.
- **In-flight pipeline runs**: Stalled runs will remain in `running` status in MongoDB. 90-day TTL will clean them up. No manual intervention needed.

### 5.15 Testability

- Graph walker is a pure function with no side effects -- unit testable without Restate.
- Expression evaluator is pure and fully unit-testable.
- Activity services implement a uniform interface (`execute(PipelineStepContext) => StepOutput`).
- Node registry validates against schemas independently.
- Integration tests extract Restate handlers via `(service as any).service.handlerName` and provide mock ctx with `run: async (label, fn) => fn()` to test execution paths without Restate infrastructure.

### 5.16 Extensibility

- Custom pipeline definitions with custom nodes and transitions.
- DB-backed node type definitions allow runtime extension without code changes.
- Trait-based field merging automatically injects standard fields.
- Trigger registry loaded from JSON seed data (add trigger = add JSON entry).
- Shared config fields auto-injected into all dynamic schemas.

---

## 6. Data Model

### MongoDB Collections

| Collection              | Key Fields                                              | Indexes                                              | Purpose                            |
| ----------------------- | ------------------------------------------------------- | ---------------------------------------------------- | ---------------------------------- |
| `pipeline_definitions`  | tenantId, pipelineType, nodes, steps, supportedTriggers | `{ tenantId, pipelineType }`, `{ kafkaTopic }`       | Pipeline definition DAGs           |
| `pipeline_configs`      | tenantId, projectId, pipelineType, enabled, config      | `{ tenantId, projectId, pipelineType }` (unique)     | Per-project pipeline configuration |
| `pipeline_run_records`  | runId, pipelineId, tenantId, status, steps              | `{ runId }` (unique), `{ startedAt }` (TTL: 90 days) | Execution state and audit trail    |
| `node_type_definitions` | tenantId, category, traits, configSchema                | default                                              | Extensible node type registry      |
| `alert_rules`           | tenantId, projectId, metric, sourceTable, threshold     | default                                              | Threshold-based metric alerting    |
| `tag_rules`             | tenantId, projectId, tagName, conditions                | default                                              | Conversation tagging rules         |
| `project_cost_configs`  | tenantId, projectId, costPerHumanInteraction, etc.      | default                                              | ROI calculator cost parameters     |
| `experiments`           | tenantId, projectId, variants, metrics                  | default                                              | A/B experiment definitions         |

### ClickHouse Tables (27 tables)

Analytics tables use `ReplacingMergeTree(processed_at)` for deduplication on reprocessing. Eval tables use `MergeTree`.

| Table                                       | Engine             | Purpose                        |
| ------------------------------------------- | ------------------ | ------------------------------ |
| `abl_platform.message_sentiment`            | ReplacingMergeTree | Per-message sentiment scores   |
| `abl_platform.conversation_sentiment`       | ReplacingMergeTree | Per-conversation sentiment     |
| `abl_platform.intent_classifications`       | ReplacingMergeTree | Intent classification results  |
| `abl_platform.quality_evaluations`          | ReplacingMergeTree | Quality evaluation scores      |
| `abl_platform.hallucination_evaluations`    | ReplacingMergeTree | Hallucination detection        |
| `abl_platform.knowledge_gap_evaluations`    | ReplacingMergeTree | Knowledge gap analysis         |
| `abl_platform.guardrail_evaluations`        | ReplacingMergeTree | Guardrail violation detection  |
| `abl_platform.friction_detections`          | ReplacingMergeTree | Friction point detection       |
| `abl_platform.anomaly_detections`           | ReplacingMergeTree | Anomaly detection              |
| `abl_platform.drift_detections`             | ReplacingMergeTree | Drift detection                |
| `abl_platform.llm_evaluate`                 | ReplacingMergeTree | Generic LLM evaluation         |
| `abl_platform.insight_results`              | ReplacingMergeTree | Generic insight store          |
| `abl_platform.toxicity_evaluations`         | ReplacingMergeTree | Toxicity detection             |
| `abl_platform.message_toxicity`             | ReplacingMergeTree | Per-message toxicity scores    |
| `abl_platform.context_evaluations`          | ReplacingMergeTree | Context preservation evals     |
| `abl_platform.conversation_outcomes`        | ReplacingMergeTree | Session outcome classification |
| `abl_platform.goal_completions`             | ReplacingMergeTree | Goal completion results        |
| `abl_platform.conversation_mentions`        | ReplacingMergeTree | Competitor/feature mentions    |
| `abl_platform.conversation_tags`            | ReplacingMergeTree | Tag assignments                |
| `abl_platform.custom_events`                | ReplacingMergeTree | Custom external events         |
| `abl_platform.external_events`              | ReplacingMergeTree | External event ingest          |
| `abl_platform.customer_predictive_features` | ReplacingMergeTree | Churn risk signals             |
| `abl_platform.churn_risk_scores`            | ReplacingMergeTree | Per-customer churn risk        |
| `abl_platform.experiment_assignments`       | ReplacingMergeTree | A/B experiment assignment log  |
| `abl_platform.eval_conversations`           | MergeTree          | Eval conversation transcripts  |
| `abl_platform.eval_scores`                  | MergeTree          | Eval judgment scores           |
| `abl_platform.eval_production_scores`       | MergeTree          | Production eval scores         |

All tables have TTL: 730 days. All tables partitioned by `tenant_id`.

### Materialized Views (10 views)

Analytics MVs use `SummingMergeTree`, eval MVs use `AggregatingMergeTree`.

- `mv_daily_sentiment` (SummingMergeTree) -- daily sentiment aggregation
- `mv_daily_intent_distribution` (SummingMergeTree) -- daily intent counts
- `mv_daily_quality_scores` (SummingMergeTree) -- daily quality score averages
- `mv_daily_llm_evaluate` (SummingMergeTree) -- daily LLM evaluation aggregation
- `mv_daily_custom_events` (SummingMergeTree) -- daily custom event counts
- `mv_daily_outcomes` (SummingMergeTree) -- daily outcome distribution
- `mv_eval_heatmap_dest` (AggregatingMergeTree) -- eval score heatmap
- `mv_eval_run_evaluator_summary_dest` (AggregatingMergeTree) -- per-evaluator summaries
- `mv_eval_score_trend_dest` (AggregatingMergeTree) -- eval score trends
- `mv_eval_production_hourly_dest` (AggregatingMergeTree) -- hourly production eval rollup

---

## 7. API Design

### Runtime API: Pipeline Configuration

```
Base: /api/projects/:projectId/pipeline-config

GET    /                              -> { success, data: PipelineConfigSummary[] }
GET    /:pipelineType                 -> { success, data: ResolvedConfig | null }
PUT    /:pipelineType                 -> { success, data: SavedConfig }
GET    /:pipelineType/history         -> { success, data: { history, currentVersion } }
PATCH  /:pipelineType/toggle          -> { success, data: { enabled, pipelineType } }
POST   /:pipelineType/backfill        -> { success, data: { unprocessedCount, backfillStatus } }
GET    /:pipelineType/backfill/status -> { success, data: { status, lastBackfillAt, unprocessedCount } }
GET    /:pipelineType/triggers        -> { success, data: { triggers, defaultTriggerIds } }
GET    /:pipelineType/schema          -> { success, data: { fields, sharedFields } }
```

### Runtime API: Pipeline Analytics

```
Base: /api/projects/:projectId/pipeline-analytics

GET    /:type/summary                -> { success, data: ScorecardSummary }
GET    /:type/breakdown              -> { success, data: BreakdownData }
GET    /:type/conversations          -> { success, data: ConversationList }
GET    /:type/conversation/:sid      -> { success, data: ConversationDetail }
```

### Runtime API: NL Analytics

```
Base: /api/projects/:projectId/nl-analytics

POST   /ask                           -> { success, data: { question, sql, data, rowCount } }
```

### Runtime API: ROI

```
Base: /api/projects/:projectId/roi

GET    /config                        -> { success, data: ProjectCostConfig }
PUT    /config                        -> { success, data: SavedConfig }
GET    /summary                       -> { success, data: ROISummary }
GET    /budget                        -> { success, data: BudgetStatus }
POST   /simulate                      -> { success, data: SimulationResult }
```

### Studio API: Pipeline Definitions

```
Base: /api/pipelines (Studio backend)

GET    /                              -> PipelineDefinition[] (list all definitions)
GET    /:id                           -> PipelineDefinition (single definition)
PUT    /:id                           -> PipelineDefinition (update definition)
```

Auth: Studio session auth. Write requires pipeline editor role.

All endpoints follow the standard error envelope: `{ success: false, error: { code, message } }`.

---

## 8. Key Design Decisions

| Decision                              | Rationale                                                                      | Alternatives Rejected                          |
| ------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| Restate for workflow execution        | Durable workflows, crash recovery, exactly-once, built-in parallelism          | BullMQ (no durability), Temporal (extra infra) |
| ClickHouse for analytics storage      | Columnar storage optimized for analytical queries, TTL, materialized views     | PostgreSQL (not optimized for analytics)       |
| Redis for analytics caching           | Fast read, TTL support, fail-open pattern reduces ClickHouse load              | No cache (ClickHouse load too high)            |
| Pure function graph walker            | Testability -- no side effects, fully deterministic                            | Stateful walker (harder to test)               |
| Custom expression evaluator           | Security -- no eval(), controlled operator set, safe by construction           | eval() (security risk), external DSL engine    |
| Dual execution mode (steps + graph)   | Backward compatibility with existing definitions + forward-looking graph model | Migration-only (breaking change)               |
| Zod for config validation             | Type-safe, composable, generates defaults, already used platform-wide          | JSON Schema (less ergonomic in TS)             |
| DB-backed node type definitions       | Runtime extensibility without code changes, tenant-customizable                | Code-only types (requires deployment)          |
| Trait-based field merging             | Standard fields (model, provider) auto-injected, reducing boilerplate          | Manual field duplication                       |
| Eval fan-out with batched concurrency | Prevents overwhelming LLM providers, controls cost                             | Unbounded parallelism (cost/rate limits)       |
| LLM-based NL-to-SQL for analytics     | Natural language access to analytics without building custom query UIs         | Custom query builder UI (high dev effort)      |
| In-memory eval rate limiter           | Simpler than Redis; bounded Map with LRU; acceptable for single-process eval   | Redis-based limiter (overkill for eval scale)  |
| DB-based LLM credential resolution    | Secure, supports per-project overrides, encrypted at rest                      | Env var fallback (insecure, not multi-tenant)  |

---

## 9. Risk Assessment

| Risk                                           | Severity   | Likelihood | Mitigation                                                                                                                                                                                            |
| ---------------------------------------------- | ---------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Restate server unavailability                  | High       | Low        | Pipeline engine has its own Dockerfile/compose for Restate                                                                                                                                            |
| ClickHouse query timeout on large datasets     | Medium     | Medium     | `max_execution_time = 15`, materialized views, partitioning                                                                                                                                           |
| LLM provider rate limiting during eval         | Medium     | High       | Circuit breakers, batched concurrency, per-tenant rate limiter, retry with backoff                                                                                                                    |
| Expression evaluator bypass                    | High       | Low        | Whitelist-only approach, extensive safety tests                                                                                                                                                       |
| Stale definition cache causing missed events   | Medium     | Low        | Fail-open to MongoDB, cache TTL (60s)                                                                                                                                                                 |
| Pipeline run MongoDB records growing unbounded | Medium     | Low        | Resolved -- 90-day TTL index on `startedAt`                                                                                                                                                           |
| Cross-tenant data leakage in ClickHouse        | Critical   | Low        | All queries parameterized with tenant_id. Needs E2E testing                                                                                                                                           |
| NL Query SQL injection / data exfiltration     | High       | Low        | SELECT-only, tenant_id required, forbidden patterns. Risk: cross-table joins may bypass tenant_id check on joined tables. Mitigation: ClickHouse read-only user restricted to `abl_platform` database |
| ~~Unwired node types visible in Studio~~       | ~~Medium~~ | ~~Medium~~ | Resolved -- all 7 wired into SERVICE_HANDLERS, ACTIVITY_TYPES, and server.ts `.bind()`                                                                                                                |
| ~~Alert evaluator not bound to Restate~~       | ~~Low~~    | ~~N/A~~    | Resolved -- bound via AlertEvaluationScheduler virtual object + pipeline failure hook                                                                                                                 |

---

## 10. Future Considerations

1. **Human review workflow**: Schema supports `needsHumanReview` on eval scores but no UI or workflow exists.
2. ~~**Pipeline run record cleanup**~~: Resolved -- 90-day TTL index on `startedAt` provides auto-cleanup.
3. **Streaming pipeline execution**: Current model is batch/event-driven; real-time streaming would require architecture changes.
4. **Pipeline versioning with rollback**: Current version is monotonic; no rollback mechanism.
5. **Cross-tenant pipeline sharing**: Pipeline marketplace or template sharing between tenants.
6. ~~**Alert evaluator activation**~~: Resolved -- bound via `AlertEvaluationScheduler` virtual object (cron-triggered per tenant), pipeline failure hook in `pipeline-run.workflow.ts`.
7. ~~**Wire 7 node types**~~: Resolved -- all 7 wired into `SERVICE_HANDLERS`, `ACTIVITY_TYPES`, and `server.ts` `.bind()`.
8. **Tag rule evaluation**: `TagRuleModel` schema exists but no runtime evaluator in pipeline-engine. Evaluation logic needs implementation.
9. **Experiment results API route**: `ExperimentResultsService` is internal-only -- no HTTP route exposes it.
10. **NL Query security hardening**: Consider ClickHouse read-only user restricted to `abl_platform` database, per-table tenant_id validation on JOINs.

---

## 11. Open Questions

1. ~~Should the 7 unwired node types be wired into SERVICE_HANDLERS as-is, or should they be hidden from the Studio Node Palette until wired?~~ Resolved -- wired as-is into SERVICE_HANDLERS, ACTIVITY_TYPES, and server.ts `.bind()`.
2. Should NL Query SQL validation enforce `tenant_id` per-table in JOINs, or is the single-query `tenant_id =` check sufficient?
3. ~~Should the alert evaluator be triggered on a cron schedule (like PipelineScheduler) or as a pipeline node type in SERVICE_HANDLERS?~~ Resolved -- dedicated `AlertEvaluationScheduler` virtual object with cron trigger (separate from PipelineScheduler).
4. Should ExperimentResultsService get an HTTP API route, or remain programmatic-only?
5. What ClickHouse user/role should NL Query use -- shared application user or a dedicated read-only user?
