# Feature: Pipeline Engine

**Doc Type**: MAJOR FEATURE
**Parent Feature**: N/A
**Status**: BETA
**Feature Area(s)**: `observability`, `agent lifecycle`, `governance`
**Package(s)**: `packages/pipeline-engine`, `apps/runtime`, `apps/studio`
**Owner(s)**: Platform team
**Testing Guide**: `../testing/pipeline-engine.md`
**Last Updated**: 2026-03-24

---

## 1. Introduction / Overview

### Problem Statement

Agent-powered platforms produce vast amounts of conversational data across sessions, agents, channels, and tenants. Without automated, structured pipelines, operators cannot systematically measure conversation quality, detect sentiment drift, classify user intents, identify hallucinations, evaluate guardrail effectiveness, or detect anomalies. Manual analysis is error-prone, unscalable, and lacks the repeatability needed for CI/CD-integrated agent evaluation. Additionally, teams need a simulation/eval framework that can systematically test agents against persona-driven scenarios with LLM-as-judge scoring.

### Goal Statement

The Pipeline Engine provides a graph-based, extensible analytics and evaluation processing framework. It executes both analytics pipelines (sentiment, intent, quality, hallucination, knowledge-gap, guardrail, friction, anomaly, drift) and evaluation pipelines (persona simulation, agent execution, LLM judging, trajectory scoring) as durable workflows. Configuration follows a three-tier hierarchy (project > tenant > platform defaults), and results are stored in ClickHouse for fast analytical queries with Redis caching.

### Summary

The Pipeline Engine is a standalone package (`packages/pipeline-engine`) that defines, schedules, and executes pipelines, and provides several standalone analytical services:

1. **Analytics Pipelines** -- 10 built-in pipeline definitions that analyze conversation data across dimensions like sentiment, intent, quality, hallucination risk, knowledge gaps, guardrail effectiveness, friction, anomaly detection, and drift detection. Each pipeline is a directed acyclic graph (DAG) of processing nodes executed via Restate durable workflows. The activity router dispatches to 27 registered service handlers plus 3 inline control-flow types.

2. **Eval Pipelines** -- A simulation/evaluation framework that fans out persona x scenario x variant matrices, executes agent conversations, judges them with LLM-as-judge evaluators (including trajectory scorers and code scorers), and aggregates results with statistical analysis (pass@k, confidence intervals, regression detection). Includes per-tenant rate limiting, circuit breakers, and OpenTelemetry instrumentation.

3. **Standalone Services** -- NL-to-SQL query service (natural language → ClickHouse SQL via LLM with semantic layer), ROI calculator (savings, FTE equivalents, budget analysis from project cost configs), threshold-based metric alerting (Restate service monitoring ClickHouse data with cooldown and multi-channel notifications), A/B experiment results (t-test, chi-squared, power analysis), and heuristic outcome classification.

The Studio UI provides visual pipeline editing with a React Flow graph canvas, node configuration panels, trigger management, and dynamic config schema forms. Runtime routes expose pipeline configuration CRUD and analytics query APIs.

---

## 2. Scope

### Goals

- Provide 10 built-in pipeline definitions covering: sentiment analysis, intent classification, quality evaluation, hallucination detection, knowledge gap analysis, guardrail analysis, friction detection, anomaly detection, drift detection, and simulation/eval
- Support graph-based pipeline definitions with typed nodes, conditional transitions (CEL-like expression evaluator), and configurable visit limits
- Execute pipeline graphs via Restate durable workflows with crash recovery, parallel fan-out, and exactly-once semantics
- Provide tiered configuration resolution: project-level overrides > tenant defaults > platform defaults (Zod-validated)
- Store analytics results in ClickHouse tables with materialized views for daily aggregation
- Provide analytics query APIs with Redis caching (summary, breakdown, conversation-level drill-down)
- Support cron-based and event-driven (Kafka) pipeline triggering via Restate virtual objects
- Provide eval pipeline with persona simulation, agent turn execution, LLM-as-judge scoring, trajectory metrics, and regression detection
- Provide Studio UI for visual pipeline editing with graph canvas, node palette, and trigger management
- Provide NL-to-SQL query service for natural language analytics queries against ClickHouse via LLM
- Provide ROI calculation from per-project cost configurations with savings, FTE, and budget analysis
- Provide threshold-based metric alerting via Restate service monitoring ClickHouse data
- Provide A/B experiment infrastructure with statistical results analysis (t-test, chi-squared)
- Provide heuristic session outcome classification (contained/escalated/abandoned)

### Non-Goals (Out of Scope)

- Real-time streaming pipeline evaluation (current model is batch/event-driven)
- Custom ClickHouse table creation from Studio UI
- Pipeline marketplace or sharing between tenants
- Direct integration with external analytics platforms (Grafana, Datadog) -- handled at the ClickHouse level
- Human-in-the-loop review workflow for eval judgements (placeholder exists in schema but not implemented)

---

## 3. User Stories

1. As a **project admin**, I want to configure which analytics pipelines run on my project's conversations so that I get relevant insights without unnecessary compute cost.
2. As a **platform operator**, I want to define custom pipeline graphs with conditional transitions so that I can implement domain-specific analysis workflows.
3. As an **analyst**, I want to view sentiment trends, intent distributions, and quality scores broken down by agent and channel so that I can identify areas for improvement.
4. As a **developer**, I want to schedule pipelines on a cron basis so that batch analytics run automatically during off-peak hours.
5. As a **QA engineer**, I want to define eval sets with personas, scenarios, and evaluators so that I can systematically test agent behavior before deployment.
6. As a **QA engineer**, I want to compare eval run results against baselines so that I can detect regressions before promoting agent versions.
7. As a **developer**, I want to trigger pipelines manually or via Kafka events so that I can integrate analytics into CI/CD workflows.
8. As a **project admin**, I want to manage per-trigger sampling rates so that I can control pipeline execution costs for high-volume topics.

---

## 4. Functional Requirements

1. **FR-1**: The system must provide 10 built-in pipeline definitions that are auto-seeded on startup via `BUILTIN_DEFINITIONS` in `definitions/index.ts`.
2. **FR-2**: The system must support graph-based pipeline definitions with typed nodes (`PipelineNode`), conditional transitions (`NodeTransition` with CEL-like expressions), group nodes (`GroupChildNode`), and configurable visit limits (`maxVisits` with hard cap of 100).
3. **FR-3**: The system must execute pipeline graphs via a graph walker (`walkGraph()` in `graph-walker.ts`) that traverses nodes, evaluates transition conditions via `resolveTransition()`, and respects failure policies (`stop`/`skip`/`continue`).
4. **FR-4**: The system must resolve pipeline configuration using a three-tier hierarchy: project config > tenant config > platform defaults, implemented in `PipelineConfigService.resolveConfig()`.
5. **FR-5**: The system must validate pipeline configs against Zod schemas (per-pipeline-type via `PIPELINE_CONFIG_SCHEMAS` registry, and dynamically via `buildZodSchema()` from definition `configSchema` fields) at the API boundary.
6. **FR-6**: The system must support cron-based scheduling via `PipelineScheduler` Restate virtual object with start/stop lifecycle and single-writer guarantee.
7. **FR-7**: The system must support event-driven triggering via `PipelineTrigger` Restate service that handles Kafka events, matches active pipelines by topic, validates input schemas, applies sampling rates, resolves execution strategies, and dispatches pipeline runs — this is the **primary execution path** that runs in production when a Kafka event arrives. Testing must cover this end-to-end: event → trigger matching (real MongoDB) → tenant isolation → strategy resolution → workflow dispatch → activity handler execution → run record persistence.
8. **FR-8**: The system must store pipeline results in ClickHouse tables partitioned by tenant with TTL-based retention (730 days) and materialized views for daily aggregation.
9. **FR-9**: The system must provide analytics query APIs (summary, breakdown, conversations, conversation detail) with Redis-backed `AnalyticsCache` (TTL: 5 min summary, 10 min timeseries, 1 hour conversation detail).
10. **FR-10**: The system must support eval pipeline execution with persona x scenario x variant matrix fan-out, batched concurrency control (`maxConcurrency`), LLM-as-judge scoring, trajectory scoring, and aggregation with statistical analysis.
11. **FR-11**: The system must validate pipeline definitions at save time including step/node type validation, expression safety checking, step reference validation, graph structure validation (cycles, unreachable nodes), and trigger validation.
12. **FR-12**: The system must support dynamic Zod schema generation from pipeline definition `configSchema` fields with shared config field injection (model, provider, samplingRate, stepOverrides, timeoutOverrides).
13. **FR-13**: The system must provide backfill capability for discovering and reprocessing unprocessed sessions.
14. **FR-14**: The system must provide a natural language query service (`NLQueryService`) that translates user questions into ClickHouse SQL via LLM using a semantic layer context, with safety validation (SELECT-only, tenant_id filter required, forbidden DDL/DML patterns), 30-second timeout, and 1000-row limit.
15. **FR-15**: The system must provide ROI calculation via `ROICalculator` (savings, FTE equivalents, budget status, containment simulation) using per-project cost configs (`ProjectCostConfigModel`).
16. **FR-16**: The system must provide threshold-based metric alerting via `alertEvaluatorService` (Restate service) that loads alert rules from MongoDB, queries ClickHouse for metric values within time windows, evaluates conditions (gt/lt/gte/lte) with aggregations (avg/sum/count/min/max/p95/p99), fires alerts with cooldown, and delivers to Slack/email/webhook channels.
17. **FR-17**: The system must provide heuristic session outcome classification (`classifyOutcome`) deriving normalized outcomes (contained/escalated/abandoned) from session status and escalation events.
18. **FR-18**: The system must provide A/B experiment infrastructure including experiment definitions (`ExperimentModel` with traffic splits and metrics) and statistical results analysis (t-test, chi-squared, power analysis) via `ExperimentResultsService`.
19. **FR-19**: The system must support inline control-flow activity types handled directly in the activity router: `node-group` (parallel fan-out via recursive service calls), `wait-for-event` (Restate awakeable suspension), and `delay` (durable sleep).

---

## 5. Feature Classification & Integration Matrix

### Lifecycle / Platform Impact

| Area                       | Impact Level | Notes                                              |
| -------------------------- | ------------ | -------------------------------------------------- |
| Project lifecycle          | SECONDARY    | Pipeline configs are project-scoped                |
| Agent lifecycle            | PRIMARY      | Eval pipelines test agents; analytics analyze them |
| Customer experience        | NONE         | Analytics are operator-facing                      |
| Integrations / channels    | NONE         | Pipelines operate on stored conversation data      |
| Observability / tracing    | PRIMARY      | Core analytics and insight generation system       |
| Governance / controls      | SECONDARY    | Quality, hallucination, and guardrail evaluation   |
| Enterprise / compliance    | SECONDARY    | Tenant-isolated pipeline configs and results       |
| Admin / operator workflows | PRIMARY      | Pipeline configuration and analytics viewing       |

### Related Feature Integration Matrix

| Related Feature                                       | Relationship Type | Why It Matters                                                            | Key Touchpoints                                       | Current State |
| ----------------------------------------------------- | ----------------- | ------------------------------------------------------------------------- | ----------------------------------------------------- | ------------- |
| Experiments / A/B Testing                             | shares data with  | Experiment definitions and statistical results analysis (t-test, chi²)    | `experiment-results.service.ts`, `experiment.schema`  | Integrated    |
| Conversation Tracing                                  | depends on        | Pipelines read conversation trace data                                    | `read-conversation.service.ts`, `conversation-reader` | Integrated    |
| ClickHouse Analytics Store                            | depends on        | All pipeline results and NL queries target ClickHouse                     | `abl_platform.*` tables, `semantic-layer.ts`          | Integrated    |
| Auth Profiles                                         | configured by     | LLM-based pipeline steps resolve credentials via DB lookup                | `llm-client-factory.ts`, credential resolution        | Integrated    |
| Guardrails                                            | extends           | Guardrail analysis is a built-in pipeline type                            | `guardrail-pipeline.ts` definition                    | Integrated    |
| Restate                                               | depends on        | All workflow execution, scheduling, triggering, and alerting uses Restate | `pipeline-run.workflow.ts`, `alert-evaluator.service` | Integrated    |
| Model Hub                                             | configured by     | LLM model/provider selection for analysis and eval                        | `llm-client-factory.ts`, config schemas               | Integrated    |
| Alerts                                                | extends           | Threshold-based metric alerting from ClickHouse data                      | `alert-evaluator.service.ts`, `alert-rule.schema.ts`  | Integrated    |
| ROI Tracking                                          | shares data with  | ROI calculator uses project cost configs and session outcomes             | `roi-calculator.service.ts`, `project-cost-config`    | Integrated    |
| Tags                                                  | shares data with  | Tag rule schemas for condition-based conversation tagging                 | `tag-rule.schema.ts`                                  | Schema only   |
| [Pipeline Observability](./pipeline-observability.md) | extends           | Run monitoring, manual testing, ClickHouse data preview, health badges    | `PipelineRunRecord`, Studio pipeline routes           | ALPHA         |

---

## 6. Design Considerations (Optional)

The Studio pipeline editor uses React Flow for the graph canvas with custom node components:

- `PipelineNodeComponent` -- standard processing nodes
- `PipelineGroupNode` -- grouped/parallel nodes
- `PipelineTriggerNode` -- trigger entry points
- `PipelineEdgeComponent` -- custom edge rendering with condition labels

The `NodePalette` provides drag-and-drop node creation from categorized node types (`data`, `logic`, `integration`, `compute`, `action`). `NodeConfigPanel` renders dynamic configuration forms based on the node type's schema. `TriggerManager` and `TriggerConfigPanel` handle cron and event-based trigger configuration. `ConfigSchemaForm` renders pipeline-level configuration from the definition's embedded `configSchema`. `SchemaFieldBuilder` handles individual schema field form elements with conditional visibility (`showWhen`).

---

## 7. Technical Considerations (Optional)

- **Restate durable workflows**: Pipeline execution uses `PipelineRun` (workflow) and `EvalRunWorkflow` for crash recovery and exactly-once semantics. Steps/nodes are dispatched via `ActivityRouter` Restate service.
- **PipelineScheduler**: Restate virtual object keyed by pipeline ID providing single-writer guarantee to prevent duplicate schedule instances. Uses durable sleep + loop pattern.
- **Graph walker**: Pure function (`walkGraph()`) with no side effects beyond calling the node executor function, enabling testability. Supports both legacy step-array mode and graph-node mode within the same workflow.
- **Expression evaluator**: Custom recursive-descent parser supporting comparison operators (`==`, `!=`, `>`, `<`, `>=`, `<=`), logical operators (`&&`, `||`, `!`), dot-path property access (`steps.<id>.output.<path>`), and safety validation (banned keywords, no eval/Function, no bracket access, no arithmetic).
- **ClickHouse queries**: Parameterized with `max_execution_time = 15` safety limits. Materialized views (`mv_daily_sentiment`, `mv_daily_intent_distribution`, `mv_daily_quality_scores`, `mv_daily_llm_evaluate`) provide pre-aggregated daily rollups.
- **Redis definition cache**: `definition-cache.ts` caches pipeline definitions by Kafka topic, fail-open to MongoDB on cache miss.
- **Eval circuit breakers**: `eval-circuit-breakers.ts` provides circuit breaker pattern for eval pipeline to prevent cascading failures during LLM provider outages.
- **Eval compression**: `eval-compression.ts` compresses conversation data before ClickHouse storage.
- **Node type system**: Dual system -- static `ACTIVITY_TYPES` map and DB-backed `NodeTypeDefinitionDoc` collection with trait-based field merging (`trait-merger.ts`).
- **NL-to-SQL query**: `NLQueryService` translates natural language to ClickHouse SQL using `SEMANTIC_LAYER` context (JSON schema describing all analytics tables). Safety validation: SELECT-only, tenant_id filter required, forbidden DDL/DML patterns. 30s timeout, 1000 row limit.
- **ROI calculator**: `ROICalculator` class computes savings, FTE equivalents, budget status, and containment simulation from `ProjectCostConfigModel` per-project cost data.
- **Alert evaluator**: `alertEvaluatorService` (Restate service) evaluates threshold-based alert rules against ClickHouse metrics with configurable time windows, aggregations (avg/sum/count/min/max/p95/p99), conditions (gt/lt/gte/lte), cooldown periods, and multi-channel notifications (Slack, email, webhook).
- **Outcome classification**: `classifyOutcome` pure function derives normalized outcomes (contained/escalated/abandoned) from session status and escalation events.
- **Template engine**: `substituteTemplates` renders `{{variable}}` placeholders in pipeline prompts and step configurations.
- **LLM client factory**: `createPipelineLLMClient` resolves credentials via 3-step DB lookup (project ModelConfig → tenant TenantModel → LLMCredential), supports Anthropic (Claude) and OpenAI (GPT) providers, validates model-provider compatibility, auto-decrypts API keys.
- **Inline control-flow nodes**: Activity router handles `node-group` (parallel fan-out), `wait-for-event` (Restate awakeable), and `delay` (durable sleep) inline without SERVICE_HANDLERS dispatch.
- **Eval rate limiter**: Per-tenant rate limiting with tier-based concurrent run, conversation, and LLM call/min limits.
- **Eval OpenTelemetry**: 20+ OTel instruments for eval pipeline observability (counters, histograms, gauges).

---

## 8. How to Consume

### Studio UI

- **Pipelines List**: `/pipelines` -- shows built-in and custom pipelines with status cards (`PipelinesListPage.tsx`, `BuiltinPipelinesList.tsx`, `CustomPipelinesList.tsx`, `PipelineCard.tsx`)
- **Pipeline Config**: `/pipelines/:pipelineType/config` -- configure a specific pipeline (`PipelineConfigPage.tsx`, `ConfigSchemaForm.tsx`)
- **Pipeline Editor**: `/pipelines/:id/edit` -- visual graph editor for custom pipelines (`PipelineEditorPage.tsx`, `PipelineGraphCanvas.tsx`, `PipelineEditorToolbar.tsx`)
- **Trigger Manager**: Within pipeline editor -- manage cron and event triggers (`TriggerManager.tsx`, `TriggerConfigPanel.tsx`)

### API (Runtime)

| Method | Path                                                                     | Purpose                                  |
| ------ | ------------------------------------------------------------------------ | ---------------------------------------- |
| GET    | `/api/projects/:projectId/pipeline-config`                               | List all pipeline configs                |
| GET    | `/api/projects/:projectId/pipeline-config/:pipelineType`                 | Get effective config (project > tenant)  |
| PUT    | `/api/projects/:projectId/pipeline-config/:pipelineType`                 | Create or update pipeline config         |
| GET    | `/api/projects/:projectId/pipeline-config/:pipelineType/history`         | Get config change history                |
| PATCH  | `/api/projects/:projectId/pipeline-config/:pipelineType/toggle`          | Enable or disable a pipeline             |
| POST   | `/api/projects/:projectId/pipeline-config/:pipelineType/backfill`        | Trigger historical data backfill         |
| GET    | `/api/projects/:projectId/pipeline-config/:pipelineType/backfill/status` | Get backfill status                      |
| GET    | `/api/projects/:projectId/pipeline-config/:pipelineType/triggers`        | Get trigger states with sampling rates   |
| GET    | `/api/projects/:projectId/pipeline-config/:pipelineType/schema`          | Get config schema fields from definition |
| GET    | `/api/projects/:projectId/pipeline-analytics/:type/summary`              | Scorecard metrics for a pipeline         |
| GET    | `/api/projects/:projectId/pipeline-analytics/:type/breakdown`            | Breakdown by dimension (agent, channel)  |
| GET    | `/api/projects/:projectId/pipeline-analytics/:type/conversations`        | Conversation list with score filters     |
| GET    | `/api/projects/:projectId/pipeline-analytics/:type/conversation/:sid`    | Single conversation detail               |
| POST   | `/api/projects/:projectId/nl-analytics/ask`                              | NL-to-SQL analytics query                |
| GET    | `/api/projects/:projectId/roi/config`                                    | Get project cost config                  |
| PUT    | `/api/projects/:projectId/roi/config`                                    | Update project cost config               |
| GET    | `/api/projects/:projectId/roi/summary`                                   | Get ROI summary                          |
| GET    | `/api/projects/:projectId/roi/budget`                                    | Get budget status                        |
| POST   | `/api/projects/:projectId/roi/simulate`                                  | Simulate containment changes             |

### API (Studio)

| Method | Path                 | Purpose                    |
| ------ | -------------------- | -------------------------- |
| GET    | `/api/pipelines`     | List pipeline definitions  |
| GET    | `/api/pipelines/:id` | Get pipeline definition    |
| PUT    | `/api/pipelines/:id` | Update pipeline definition |

### Admin Portal

Pipeline analytics are accessible via the project-scoped analytics dashboard. No tenant-wide admin pipeline management exists currently.

### Channel / SDK / Voice / A2A / MCP Integration

Pipelines are not channel-aware. They operate on stored conversation data regardless of source channel.

---

## 9. Data Model

### Collections / Tables

```text
Collection: pipeline_definitions (MongoDB)
Fields:
  - _id: string
  - tenantId: string (indexed; '__platform__' for built-in)
  - projectId: string (optional)
  - name: string
  - description: string
  - pipelineType: string
  - version: number
  - status: 'draft' | 'active' | 'archived'
  - configSchema: { fields: ConfigField[] }
  - supportedTriggers: TriggerEntry[]
  - defaultTriggerIds: string[]
  - strategies: Record<string, ExecutionStrategy>
  - nodes: PipelineNode[] (graph mode)
  - entryNodeId: string (graph mode)
  - steps: PipelineStep[] (legacy mode)
  - onStepFailure: 'stop' | 'skip' | 'continue'
  - onNodeFailure: 'stop' | 'skip' | 'continue'
  - tags: string[]
  - maxConcurrency: number
  - createdBy: string
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, pipelineType: 1 }
  - { supportedTriggers.kafkaTopic: 1 }

Collection: pipeline_configs (MongoDB)
Fields:
  - _id: string
  - tenantId: string (required, indexed)
  - projectId: string (required, indexed)
  - pipelineType: string (required)
  - enabled: boolean
  - version: number (auto-incremented)
  - config: Record<string, unknown>
  - activeTriggers: string[]
  - triggerConfigs: Map<string, { samplingRate?, stepOverrides? }>
  - configHistory: Array<{ version, config, updatedBy, updatedAt }>
  - lastProcessedAt: Date
  - backfillStatus: string
  - updatedBy: string
  - createdAt: Date
  - updatedAt: Date
Indexes:
  - { tenantId: 1, projectId: 1, pipelineType: 1 } (unique)

Collection: pipeline_run_records (MongoDB)
Fields:
  - _id: string (runId)
  - runId: string
  - pipelineId: string
  - pipelineVersion: number
  - tenantId: string
  - status: 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'
  - trigger: { type, kafkaTopic?, triggeredBy?, triggerId?, executionMode? }
  - input: Record<string, unknown>
  - steps: Array<{ id, name, type, status, startedAt?, completedAt?, durationMs?, output? }>
  - startedAt: Date
  - completedAt: Date
  - error: { stepId: string, message: string } (optional)
Indexes:
  - { runId: 1 } (unique)
  - { tenantId: 1, pipelineId: 1, startedAt: -1 }
  - { tenantId: 1, status: 1 }
  - { startedAt: 1 } (TTL: 90 days)

Collection: node_type_definitions (MongoDB)
Fields:
  - _id: string (node type identifier)
  - tenantId: string
  - label: string
  - description: string
  - category: NodeCategory ('data'|'logic'|'integration'|'compute'|'action')
  - icon: string
  - executionModel: 'sync' | 'async' | 'control-flow'
  - defaultTimeout: number
  - defaultRetries: number
  - retryable: boolean
  - requiredCapabilities: string[]
  - contextKey: string
  - traits: NodeTrait[] ('compute'|'llm'|'storage')
  - configSchema: ConfigFieldDefinition[]
  - outputSchema: Record<string, { type, description }>
  - storageSchema: { tables: StorageTableDefinition[] }
  - version: number
  - isActive: boolean

Collection: alert_rules (MongoDB)
Fields:
  - _id: string
  - tenantId: string (required)
  - projectId: string (required)
  - name: string
  - metric: string
  - sourceTable: string (ClickHouse table)
  - aggregation: 'avg' | 'sum' | 'count' | 'min' | 'max' | 'p95' | 'p99'
  - windowMinutes: number
  - condition: 'gt' | 'lt' | 'gte' | 'lte'
  - threshold: number
  - cooldownMinutes: number
  - channels: { slack?, email?, webhook? }
  - status: 'ok' | 'firing' | 'cooldown'
  - lastFiredAt: Date
  - createdAt: Date
  - updatedAt: Date

Collection: tag_rules (MongoDB)
Fields:
  - _id: string
  - tenantId: string (required)
  - projectId: string (required)
  - tagName: string
  - description: string
  - color: string
  - conditions: Array<{ field, operator, value }>
  - conditionLogic: 'AND' | 'OR'
  - autoApply: boolean
  - createdBy: string
  - createdAt: Date
  - updatedAt: Date
Operators: eq, neq, gt, lt, contains, in

Collection: project_cost_configs (MongoDB)
Fields:
  - _id: string
  - tenantId: string (required)
  - projectId: string (required)
  - costPerHumanInteraction: number
  - costPerAIInteraction: number
  - fteCapacityPerDay: number
  - fteCostPerYear: number
  - monthlyBudget: number
  - containmentRate: number
  - totalConversationsPerMonth: number
  - createdAt: Date
  - updatedAt: Date

Collection: experiments (MongoDB)
Fields:
  - _id: string
  - tenantId: string (required)
  - projectId: string (required)
  - name: string
  - description: string
  - status: string
  - variants: Array<{ name, trafficPercentage, config }>
  - metrics: string[]
  - startDate: Date
  - endDate: Date
  - createdBy: string
  - createdAt: Date
  - updatedAt: Date

Tables (ClickHouse - analytics, 24 tables, ReplacingMergeTree, TTL 730 days):
  - abl_platform.message_sentiment
  - abl_platform.conversation_sentiment
  - abl_platform.intent_classifications
  - abl_platform.quality_evaluations
  - abl_platform.hallucination_evaluations
  - abl_platform.knowledge_gap_evaluations
  - abl_platform.guardrail_evaluations
  - abl_platform.friction_detections
  - abl_platform.anomaly_detections
  - abl_platform.drift_detections
  - abl_platform.llm_evaluate
  - abl_platform.insight_results (generic insight store)
  - abl_platform.toxicity_evaluations
  - abl_platform.message_toxicity
  - abl_platform.context_evaluations
  - abl_platform.conversation_outcomes
  - abl_platform.goal_completions
  - abl_platform.conversation_mentions
  - abl_platform.conversation_tags
  - abl_platform.custom_events
  - abl_platform.external_events
  - abl_platform.customer_predictive_features
  - abl_platform.churn_risk_scores
  - abl_platform.experiment_assignments

Tables (ClickHouse - eval, 3 tables, MergeTree, TTL 730 days):
  - abl_platform.eval_conversations
  - abl_platform.eval_scores
  - abl_platform.eval_production_scores

Materialized Views (ClickHouse - 10 views):
  Analytics (SummingMergeTree):
  - abl_platform.mv_daily_sentiment
  - abl_platform.mv_daily_intent_distribution
  - abl_platform.mv_daily_quality_scores
  - abl_platform.mv_daily_llm_evaluate
  - abl_platform.mv_daily_custom_events
  - abl_platform.mv_daily_outcomes
  Eval (AggregatingMergeTree):
  - abl_platform.mv_eval_heatmap_dest
  - abl_platform.mv_eval_run_evaluator_summary_dest
  - abl_platform.mv_eval_score_trend_dest
  - abl_platform.mv_eval_production_hourly_dest
```

### Key Relationships

- Pipeline configs reference pipeline definitions via `pipelineType`.
- Pipeline results in ClickHouse reference sessions and conversations via `session_id`, `tenant_id`, `project_id`.
- Pipeline scheduler (Restate) references pipeline definitions by ID.
- Eval runs reference `EvalSet`, `EvalPersona`, `EvalScenario`, `EvalEvaluator` MongoDB collections.
- Node type definitions are loaded from MongoDB into `NodeRegistry` at startup via `loadFromDocs()`.
- Alert rules reference ClickHouse source tables and are evaluated by `alertEvaluatorService` Restate service.
- Project cost configs are consumed by `ROICalculator` for savings/FTE/budget analysis.
- Experiment definitions are consumed by `ExperimentResultsService` for statistical analysis (t-test, chi-squared).
- Tag rules define condition-based tagging criteria (evaluation logic is external to pipeline-engine).

---

## 10. Key Implementation Files

### Domain / Core Logic

| File                                                            | Purpose                                                                    |
| --------------------------------------------------------------- | -------------------------------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/types.ts`                | Core type definitions (PipelineDefinition, PipelineNode, StepOutput, etc.) |
| `packages/pipeline-engine/src/pipeline/graph-walker.ts`         | Pure graph traversal engine (`walkGraph()`)                                |
| `packages/pipeline-engine/src/pipeline/graph-utils.ts`          | Graph utilities, transition resolution, cycle detection                    |
| `packages/pipeline-engine/src/pipeline/expression-evaluator.ts` | CEL-like expression evaluation with safety validation                      |
| `packages/pipeline-engine/src/pipeline/config-schemas.ts`       | Zod schemas per pipeline type + dynamic builder                            |
| `packages/pipeline-engine/src/pipeline/config-defaults.ts`      | Platform default configuration values                                      |
| `packages/pipeline-engine/src/pipeline/definitions/index.ts`    | 10 built-in pipeline definition barrel                                     |
| `packages/pipeline-engine/src/pipeline/insight-types.ts`        | Typed insight definitions (InsightResult, InsightRecord)                   |
| `packages/pipeline-engine/src/pipeline/node-registry.ts`        | Node type registry with bounded Map and trait merging                      |
| `packages/pipeline-engine/src/pipeline/validation.ts`           | Pipeline definition validation (steps, nodes, expressions, triggers)       |
| `packages/pipeline-engine/src/pipeline/trigger-registry.ts`     | Trigger definition registry loaded from JSON seed data                     |
| `packages/pipeline-engine/src/pipeline/trait-merger.ts`         | Trait-based config field merging for node types                            |
| `packages/pipeline-engine/src/pipeline/template-engine.ts`      | Template rendering for pipeline prompts                                    |
| `packages/pipeline-engine/src/pipeline/execution-context.ts`    | Execution context building across graph nodes                              |
| `packages/pipeline-engine/src/pipeline/activity-metadata.ts`    | Static activity type metadata                                              |

### Standalone Services (not pipeline nodes)

| File                                                                           | Purpose                                                              |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/services/nl-query.service.ts`           | NL-to-SQL via LLM with semantic layer and safety validation          |
| `packages/pipeline-engine/src/pipeline/services/semantic-layer.ts`             | JSON schema of all ClickHouse analytics tables for LLM context       |
| `packages/pipeline-engine/src/pipeline/services/roi-calculator.service.ts`     | ROI computation: savings, FTE equivalents, budget, simulation        |
| `packages/pipeline-engine/src/pipeline/services/alert-evaluator.service.ts`    | Restate service: threshold-based metric alerting from ClickHouse     |
| `packages/pipeline-engine/src/pipeline/services/outcome-classification.ts`     | Heuristic session outcome derivation (contained/escalated/abandoned) |
| `packages/pipeline-engine/src/pipeline/services/experiment-results.service.ts` | A/B experiment results with t-test, chi-squared, power analysis      |
| `packages/pipeline-engine/src/pipeline/services/llm-client-factory.ts`         | Provider-neutral LLM client with DB credential resolution            |
| `packages/pipeline-engine/src/pipeline/services/conversation-reader.ts`        | Encrypted conversation data reader with retry                        |

### Node Type Services (wired to SERVICE_HANDLERS, ACTIVITY_TYPES, and server.ts .bind())

| File                                                                      | Purpose                                                           |
| ------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/services/sub-pipeline.service.ts`  | Execute another pipeline as a nested node (max depth: 3)          |
| `packages/pipeline-engine/src/pipeline/services/db-query.service.ts`      | ClickHouse SQL or MongoDB JSON queries with template substitution |
| `packages/pipeline-engine/src/pipeline/services/filter.service.ts`        | Filter arrays from previous outputs based on expressions          |
| `packages/pipeline-engine/src/pipeline/services/aggregate.service.ts`     | Aggregate values (count, sum, avg, min, max, collect)             |
| `packages/pipeline-engine/src/pipeline/services/send-email.service.ts`    | Send emails with template substitution                            |
| `packages/pipeline-engine/src/pipeline/services/send-slack.service.ts`    | Send Slack messages via webhook or tenant integration             |
| `packages/pipeline-engine/src/pipeline/services/publish-kafka.service.ts` | Publish events to Kafka topics                                    |

### Routes / Handlers

| File                                                                           | Purpose                                                            |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `apps/runtime/src/routes/pipeline-config.ts`                                   | Pipeline configuration CRUD API (9 endpoints)                      |
| `apps/runtime/src/routes/pipeline-analytics.ts`                                | Pipeline analytics query API (4 endpoints)                         |
| `packages/pipeline-engine/src/pipeline/handlers/pipeline-scheduler.ts`         | Restate cron scheduler virtual object                              |
| `packages/pipeline-engine/src/pipeline/handlers/pipeline-run.workflow.ts`      | Restate pipeline run workflow (legacy + graph modes)               |
| `packages/pipeline-engine/src/pipeline/handlers/eval-run.workflow.ts`          | Restate eval pipeline workflow with fan-out                        |
| `packages/pipeline-engine/src/pipeline/handlers/pipeline-trigger.service.ts`   | Restate trigger service (Kafka + manual)                           |
| `packages/pipeline-engine/src/pipeline/handlers/activity-router.service.ts`    | Restate activity dispatch router (27 handlers + 3 inline)          |
| `packages/pipeline-engine/src/pipeline/handlers/alert-evaluation-scheduler.ts` | Restate virtual object: cron-triggered alert evaluation per tenant |

### UI Components

| File                                                             | Purpose                         |
| ---------------------------------------------------------------- | ------------------------------- |
| `apps/studio/src/components/pipelines/PipelinesListPage.tsx`     | Pipeline listing page           |
| `apps/studio/src/components/pipelines/BuiltinPipelinesList.tsx`  | Built-in pipelines section      |
| `apps/studio/src/components/pipelines/CustomPipelinesList.tsx`   | Custom pipelines section        |
| `apps/studio/src/components/pipelines/PipelineCard.tsx`          | Individual pipeline card        |
| `apps/studio/src/components/pipelines/PipelineConfigPage.tsx`    | Pipeline configuration page     |
| `apps/studio/src/components/pipelines/PipelineEditorPage.tsx`    | Visual graph editor page        |
| `apps/studio/src/components/pipelines/PipelineGraphCanvas.tsx`   | React Flow graph canvas         |
| `apps/studio/src/components/pipelines/PipelineEditorToolbar.tsx` | Editor toolbar                  |
| `apps/studio/src/components/pipelines/NodePalette.tsx`           | Drag-and-drop node palette      |
| `apps/studio/src/components/pipelines/NodeConfigPanel.tsx`       | Node configuration sidebar      |
| `apps/studio/src/components/pipelines/TriggerManager.tsx`        | Trigger management panel        |
| `apps/studio/src/components/pipelines/TriggerConfigPanel.tsx`    | Trigger configuration panel     |
| `apps/studio/src/components/pipelines/ConfigSchemaForm.tsx`      | Dynamic config form from schema |
| `apps/studio/src/components/pipelines/SchemaFieldBuilder.tsx`    | Schema field form builder       |
| `apps/studio/src/components/pipelines/PipelineNodeComponent.tsx` | Custom React Flow node          |
| `apps/studio/src/components/pipelines/PipelineGroupNode.tsx`     | Custom React Flow group node    |
| `apps/studio/src/components/pipelines/PipelineTriggerNode.tsx`   | Custom React Flow trigger node  |
| `apps/studio/src/components/pipelines/PipelineEdgeComponent.tsx` | Custom React Flow edge          |

### Jobs / Workers / Background Processes

| File                                                                                   | Purpose                                               |
| -------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/pipeline-engine/src/pipeline/handlers/pipeline-scheduler.ts`                 | Cron-based scheduling (Restate)                       |
| `packages/pipeline-engine/src/pipeline/services/eval/simulate-persona.service.ts`      | Persona simulation for eval                           |
| `packages/pipeline-engine/src/pipeline/services/eval/execute-agent-turn.service.ts`    | Agent turn execution for eval                         |
| `packages/pipeline-engine/src/pipeline/services/eval/run-eval-conversation.service.ts` | Full eval conversation orchestration                  |
| `packages/pipeline-engine/src/pipeline/services/eval/judge-conversation.service.ts`    | LLM-as-judge conversation judging                     |
| `packages/pipeline-engine/src/pipeline/services/eval/aggregate-eval-run.service.ts`    | Eval run aggregation and statistics                   |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.service.ts`        | Eval preflight validation                             |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-preflight.ts`                | Eval preflight checks (integration points)            |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts`                   | 8 pre-configured eval alert rules                     |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-auth.ts`                     | Service-to-service JWT for Runtime API                |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-circuit-breakers.ts`         | 3 circuit breakers (persona, judge, agent)            |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-clickhouse-writers.ts`       | Buffered ClickHouse writers (batch 500/2000)          |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-compression.ts`              | Gzip compress/decompress (threshold: 1KB)             |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-rate-limiter.ts`             | Per-tenant tier-based rate limiting                   |
| `packages/pipeline-engine/src/pipeline/services/eval/eval-metrics.ts`                  | 20+ OpenTelemetry instruments                         |
| `packages/pipeline-engine/src/pipeline/services/eval/trajectory-scorers.ts`            | 4 trajectory scorers (milestone, handoff, path, tool) |
| `packages/pipeline-engine/src/pipeline/services/backfill.service.ts`                   | Historical data backfill                              |

### Tests

| File                                                                            | Type        | Coverage Focus                                                       |
| ------------------------------------------------------------------------------- | ----------- | -------------------------------------------------------------------- |
| `packages/pipeline-engine/src/__tests__/graph-walker.test.ts`                   | unit        | Graph traversal, visit limits, failure                               |
| `packages/pipeline-engine/src/__tests__/graph-validation.test.ts`               | unit        | Graph structure validation                                           |
| `packages/pipeline-engine/src/__tests__/graph-utils.test.ts`                    | unit        | Graph utility functions                                              |
| `packages/pipeline-engine/src/__tests__/expression-evaluator.test.ts`           | unit        | Expression evaluation + safety                                       |
| `packages/pipeline-engine/src/__tests__/config-schemas.test.ts`                 | unit        | Zod schema validation, dynamic builder                               |
| `packages/pipeline-engine/src/__tests__/pipeline-config.test.ts`                | unit        | Config service logic                                                 |
| `packages/pipeline-engine/src/__tests__/pipeline-trigger.test.ts`               | unit        | Trigger logic                                                        |
| `packages/pipeline-engine/src/__tests__/pipeline-trigger-graph.test.ts`         | unit        | Trigger graph pipeline                                               |
| `packages/pipeline-engine/src/__tests__/node-registry.test.ts`                  | unit        | Node type registry                                                   |
| `packages/pipeline-engine/src/__tests__/cron.test.ts`                           | unit        | Cron expression parsing                                              |
| `packages/pipeline-engine/src/__tests__/pipeline-run.test.ts`                   | unit        | Pipeline run workflow logic                                          |
| `packages/pipeline-engine/src/__tests__/activity-router.test.ts`                | unit        | Activity routing dispatch                                            |
| `packages/pipeline-engine/src/__tests__/activity-services.test.ts`              | unit        | Pipeline activity services                                           |
| `packages/pipeline-engine/src/__tests__/compute-sentiment.test.ts`              | unit        | Sentiment analysis                                                   |
| `packages/pipeline-engine/src/__tests__/compute-intent.test.ts`                 | unit        | Intent classification                                                |
| `packages/pipeline-engine/src/__tests__/compute-quality.test.ts`                | unit        | Quality evaluation                                                   |
| `packages/pipeline-engine/src/__tests__/compute-statistical.test.ts`            | unit        | Statistical computation                                              |
| `packages/pipeline-engine/src/__tests__/compute-toxicity.test.ts`               | unit        | Toxicity detection                                                   |
| `packages/pipeline-engine/src/__tests__/compute-llm-evaluation.test.ts`         | unit        | LLM-based evaluation                                                 |
| `packages/pipeline-engine/src/__tests__/analytics-cache.test.ts`                | unit        | Redis cache, TTL, fail-open                                          |
| `packages/pipeline-engine/src/__tests__/experiment-results.test.ts`             | unit        | Statistical significance                                             |
| `packages/pipeline-engine/src/__tests__/eval-preflight.test.ts`                 | unit        | Eval preflight validation                                            |
| `packages/pipeline-engine/src/__tests__/eval-circuit-breaker-errors.test.ts`    | unit        | Circuit breaker error handling                                       |
| `packages/pipeline-engine/src/__tests__/nl-query.test.ts`                       | unit        | NL-to-SQL query service                                              |
| `packages/pipeline-engine/src/__tests__/roi-calculator.test.ts`                 | unit        | ROI calculation                                                      |
| `packages/pipeline-engine/src/__tests__/integration-graph-pipeline.test.ts`     | integration | End-to-end graph pipeline execution                                  |
| `packages/pipeline-engine/src/__tests__/integration-insight-pipeline.test.ts`   | integration | Insight pipeline integration                                         |
| `packages/pipeline-engine/src/__tests__/integration-toxicity-pipeline.test.ts`  | integration | Toxicity pipeline end-to-end                                         |
| `packages/pipeline-engine/src/__tests__/integration-execution-pipeline.test.ts` | integration | walkGraph → real handlers data flow                                  |
| `packages/pipeline-engine/src/__tests__/integration-trigger-execution.test.ts`  | integration | Kafka event → trigger matching → strategy → dispatch (real MongoDB)  |
| `packages/pipeline-engine/src/__tests__/register-nodes.test.ts`                 | unit        | Node registration, tryRegister, deduplication                        |
| `packages/pipeline-engine/src/__tests__/activity-metadata-completeness.test.ts` | unit        | Verifies all 36 ACTIVITY_TYPES entries present                       |
| `packages/pipeline-engine/src/__tests__/db-query.test.ts`                       | unit        | ClickHouse + MongoDB query execution, SQL validation                 |
| `packages/pipeline-engine/src/__tests__/sub-pipeline.test.ts`                   | unit        | Sub-pipeline depth guard, input mapping, tenant lookup               |
| `packages/pipeline-engine/src/__tests__/aggregate-service.test.ts`              | unit        | Aggregate operations (count, sum, avg, min, max, collect)            |
| `packages/pipeline-engine/src/__tests__/filter-service.test.ts`                 | unit        | Array filtering with expression evaluation                           |
| `packages/pipeline-engine/src/__tests__/send-email.test.ts`                     | unit        | Email sending with template substitution                             |
| `packages/pipeline-engine/src/__tests__/send-slack.test.ts`                     | unit        | Slack messaging via webhook                                          |
| `packages/pipeline-engine/src/__tests__/publish-kafka.test.ts`                  | unit        | Kafka event publishing                                               |
| `packages/pipeline-engine/src/__tests__/alert-evaluator.test.ts`                | unit        | Alert rule evaluation, ClickHouse queries, cooldown                  |
| `packages/pipeline-engine/src/__tests__/alert-evaluator-activation.test.ts`     | unit        | Alert scheduler, failure hook, evaluateCondition                     |
| `apps/runtime/src/__tests__/pipeline-config.e2e.test.ts`                        | e2e         | 5 E2E suites (22 tests): CRUD, isolation, RBAC, validation, triggers |
| `apps/runtime/src/__tests__/pipeline-config.test.ts`                            | unit        | Pipeline config route                                                |
| `apps/runtime/src/__tests__/routes/pipeline-analytics-route.test.ts`            | unit        | Pipeline analytics route                                             |
| `apps/studio/src/components/pipelines/__tests__/SchemaFieldBuilder.test.tsx`    | unit        | Schema field builder component                                       |

> **Note**: This table lists the primary test files. The full inventory (65 pipeline-engine test files + 3 runtime/studio test files = 69 total, 780+ tests) is in the [testing spec](../testing/pipeline-engine.md).

---

## 11. Configuration

### Environment Variables

| Variable                | Default                 | Description                                     |
| ----------------------- | ----------------------- | ----------------------------------------------- |
| `MONGODB_URL`           | --                      | MongoDB connection string (required)            |
| `ENCRYPTION_MASTER_KEY` | --                      | Master key for credential encryption (required) |
| `CLICKHOUSE_URL`        | --                      | ClickHouse connection URL                       |
| `REDIS_URL`             | --                      | Redis URL for analytics caching                 |
| `RUNTIME_URL`           | `http://localhost:3112` | Runtime API URL for eval agent execution        |

### Runtime Configuration

Pipeline configuration follows a three-tier resolution:

1. **Project-level**: Stored in `pipeline_configs` with `projectId` -- highest priority
2. **Tenant-level**: Stored in `pipeline_configs` without `projectId` -- fallback
3. **Platform defaults**: Zod schema `.default()` values in `config-schemas.ts` -- final fallback

Additional runtime config:

- **Sampling rates**: Per-pipeline and per-trigger sampling rates (0-1, default 1.0)
- **Trigger activation**: Active trigger selection per config, falling back to `defaultTriggerIds`
- **Step/timeout overrides**: Per-step config and timeout overrides via `stepOverrides`/`timeoutOverrides` fields
- **Backfill status**: Per-pipeline per-project backfill tracking
- **Kafka topics consumed**: `abl.session.created`, `abl.session.ended`, `abl.session.handoff`, `abl.session.escalation`, `abl.message.user`, `abl.message.agent`, `abl.tool.called`, `abl.tool.completed`
- **Trigger definitions**: 5 triggers — `session-ended` (→ `abl.session.ended`), `user-message` (→ `abl.message.user`), `agent-message` (→ `abl.message.agent`), `manual`, `schedule`

### DSL / Agent IR / Schema

Pipeline configuration is not part of the ABL DSL. It is managed through the Studio UI and Runtime API.

---

## 12. Non-Functional Concerns

### Isolation & Multitenancy

| Concern           | Requirement / Expectation                                                                                                                                                        |
| ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Project isolation | Pipeline configs are scoped by `tenantId + projectId`. Analytics queries include both. Routes use `requireProjectPermission()` and `requireProjectScope()`.                      |
| Tenant isolation  | All ClickHouse queries include `tenant_id` filter. All MongoDB queries include `tenantId`. Built-in definitions use `tenantId: '__platform__'` and are available to all tenants. |
| User isolation    | Not applicable -- pipeline configs are project-level, not user-owned. `updatedBy` tracks the last editor.                                                                        |

### Security & Compliance

- LLM credentials for pipeline steps are resolved through the auth profile system with encryption at rest (`ENCRYPTION_MASTER_KEY` required).
- ClickHouse query parameters are parameterized (not string-interpolated) to prevent injection. Safety limit: `max_execution_time = 15`.
- All routes require JWT authentication via `authMiddleware` and project-scoped RBAC permissions (`session:read` for reads, `project:write` for writes).
- Expression evaluator enforces whitelist of safe operations -- no `eval()`, no `Function()`, no bracket access, no arithmetic, banned keywords list.
- Pipeline definitions loaded via `loadActivePipeline()` verify `tenantId` matches `'__platform__'` or the requesting tenant.

### Performance & Scalability

- ClickHouse provides columnar storage optimized for analytical queries across millions of rows with TTL-based retention (730 days).
- Redis-backed `AnalyticsCache` reduces repeated ClickHouse queries (5 min TTL for summaries, 1 hour for immutable conversation details).
- Pipeline execution is distributed via Restate durable workflows -- scales horizontally.
- Graph walker supports configurable visit limits (`maxVisits` per node, hard cap 100) to prevent infinite loops.
- Eval pipeline supports batched concurrency control (`maxConcurrency`, default 5) to prevent overwhelming LLM providers.
- Definition cache (`definition-cache.ts`) caches pipeline definitions by Kafka topic in Redis.
- Materialized views provide pre-aggregated daily rollups to accelerate dashboard queries.

### Reliability & Failure Modes

- Restate durable workflows survive process crashes -- pipeline runs resume from last checkpoint.
- Graph walker supports `stop`, `skip`, and `continue` failure policies per node/step.
- `AnalyticsCache` follows fail-open pattern -- Redis unavailability falls through to ClickHouse.
- Definition cache is fail-open -- Redis miss falls through to MongoDB.
- Eval pipeline has circuit breakers (`eval-circuit-breakers.ts`) to prevent cascading failures.
- Eval pipeline diagnostics: failed conversations are grouped by error pattern and stored in `diagnosticSummary` on the EvalRun document.
- Pipeline `pipelineShouldStop` early-stop mechanism allows steps to halt the workflow gracefully.

### Observability

- Pipeline runs emit structured logs via `createLogger('pipeline-*')`.
- Pipeline run records are stored in MongoDB for auditing (includes step-level timing and status).
- ClickHouse stores all pipeline results with timestamps for trend analysis.
- Eval workflow exposes `getStatus` shared handler for live progress monitoring (conversations completed, judgements completed, diagnostic summary).
- All handler files use structured logging via `createLogger` from `@abl/compiler/platform`.

### Data Lifecycle

- ClickHouse tables use TTL-based retention: `TTL toDateTime(message_at) + INTERVAL 730 DAY DELETE`.
- Pipeline run records have a 90-day TTL index on `startedAt` for automatic cleanup.
- Pipeline configs support change history tracking (last 20 entries with version diffs).
- Eval conversations and scores stored in ClickHouse with same TTL policy.

---

## 13. Delivery Plan / Work Breakdown

1. Core engine (DONE)
   1.1 Graph walker with transition evaluation
   1.2 Expression evaluator for conditions
   1.3 Node registry with bounded Map, trait merging, and DB-backed loading
   1.4 10 built-in pipeline definitions
   1.5 Pipeline definition validation (steps, nodes, expressions, triggers, graphs)
   1.6 Execution context building
2. Configuration system (DONE)
   2.1 Zod schema validation per pipeline type (static + dynamic builder)
   2.2 Three-tier config resolution (project > tenant > platform defaults)
   2.3 Config CRUD API routes (9 endpoints)
   2.4 Config change history tracking
   2.5 Active trigger resolution and per-trigger sampling rates
3. Scheduling and execution (DONE)
   3.1 Restate PipelineScheduler virtual object with cron + durable sleep
   3.2 Pipeline run workflow (legacy step mode + graph mode)
   3.3 Pipeline trigger service (Kafka events + manual trigger)
   3.4 Activity router service with dispatch table
4. Analytics and results (DONE)
   4.1 ClickHouse analytics table initialization (DDL)
   4.2 Materialized views for daily aggregation
   4.3 Analytics query API with caching (summary, breakdown, conversations, drill-down)
   4.4 Analytics cache with TTL and fail-open
5. Compute services (DONE)
   5.1 Sentiment, intent, quality, toxicity, statistical compute services
   5.2 Goal completion, mentions, tool effectiveness, predictive features
   5.3 LLM evaluation service
   5.4 Store insight service (generic ClickHouse writer)
   5.5 HTTP request, filter, transform, aggregate services
   5.6 Notification services (email, Slack, generic)
6. Eval pipeline (DONE)
   6.1 Eval run workflow with fan-out orchestration
   6.2 Persona simulation service
   6.3 Agent turn execution service
   6.4 Run eval conversation service
   6.5 Judge conversation service (LLM-as-judge)
   6.6 Trajectory scorers (milestone, handoff, path efficiency)
   6.7 Aggregate eval run service (statistics, pass@k, regression detection)
   6.8 Eval preflight validation
   6.9 Eval circuit breakers
   6.10 Eval ClickHouse writers and compression
7. Studio UI (DONE)
   7.1 Pipeline list page with built-in and custom sections
   7.2 Pipeline configuration page with dynamic schema forms
   7.3 Visual graph editor with React Flow
   7.4 Node palette, config panels, trigger management
   7.5 Schema field builder for dynamic forms
8. Backfill (DONE)
   8.1 Backfill service for unprocessed session discovery
   8.2 Backfill status tracking
   8.3 Backfill API endpoints
9. NL Query subsystem (DONE)
   9.1 NL-to-SQL translation via LLM with semantic layer context
   9.2 SQL safety validation (SELECT-only, tenant_id required, DDL/DML blocked)
   9.3 ClickHouse execution with timeout (30s) and row limit (1000)
10. ROI & cost tracking (DONE)
    10.1 ROI calculator (savings, FTE equivalents, budget status, simulation)
    10.2 Project cost config schema (per-tenant, per-project)
    10.3 Outcome classification (contained/escalated/abandoned)
11. Alerting subsystem (DONE)
    11.1 Alert evaluator Restate service with ClickHouse metric queries
    11.2 Alert rule schema with conditions, aggregations, cooldown
    11.3 Multi-channel notification delivery (Slack, email, webhook)
    11.4 8 pre-configured eval-specific alert rules
12. Experiment infrastructure (DONE)
    12.1 Experiment schema with traffic splits and metrics
    12.2 Experiment results with t-test, chi-squared, power analysis
13. Tag rules (PARTIAL — schema only)
    13.1 Tag rule schema with conditions and auto-apply
    13.2 Tag rule evaluation (NOT IMPLEMENTED in pipeline-engine)
14. Node type wiring (DONE)
    14.1 sub-pipeline, db-query, filter, aggregate, send-email, send-slack, publish-kafka
    14.2 SERVICE_HANDLERS registration, ACTIVITY_TYPES metadata, server.ts .bind()

---

## 14. Success Metrics

| Metric                     | Baseline | Target   | How Measured                                    |
| -------------------------- | -------- | -------- | ----------------------------------------------- |
| Pipeline execution success | N/A      | > 95%    | Pipeline run records (completed/total)          |
| Analytics query latency    | N/A      | < 2s p95 | ClickHouse query timing + cache hit rate        |
| Config validation coverage | N/A      | 100%     | All 10 pipeline types have Zod schemas          |
| Built-in pipeline coverage | N/A      | 10 types | `BUILTIN_DEFINITIONS` array length              |
| Eval pipeline reliability  | N/A      | > 90%    | Eval run completion rate (completed/total)      |
| Unit test count            | N/A      | > 400    | `pnpm test --filter=pipeline-engine` pass count |
| Cache hit rate (analytics) | N/A      | > 70%    | Redis analytics cache hit/miss ratio            |

---

## 15. Open Questions

1. Should custom pipeline definitions be shareable across projects within a tenant?
2. ~~What is the retention policy for pipeline run records in MongoDB?~~ Resolved -- 90-day TTL index on `startedAt`.
3. Should pipeline execution history be visible in the Studio audit log?
4. Should the eval pipeline support human-in-the-loop review for judge results (schema supports `needsHumanReview` but no UI)?
5. Should pipeline definitions support versioning with rollback (currently version is a monotonic counter)?
6. ~~When should the 7 unwired node types (`sub-pipeline`, `db-query`, `filter`, `aggregate`, `send-email`, `send-slack`, `publish-kafka`) be registered in SERVICE_HANDLERS?~~ Resolved -- all 7 wired into SERVICE_HANDLERS, ACTIVITY_TYPES, and server.ts .bind().
7. ~~Should the NL query service be exposed via an HTTP API route?~~ Resolved -- exposed via `POST /api/projects/:projectId/nl-analytics/ask`.
8. Should tag rule evaluation logic live in pipeline-engine or in a separate package?
9. Should the alert evaluator be invokable as a pipeline node type (add to SERVICE_HANDLERS), or remain a standalone Restate service?

---

## 16. Gaps, Known Issues & Limitations

| ID      | Description                                                                              | Severity | Status                                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| GAP-001 | Eval preflight test requires `ENCRYPTION_MASTER_KEY` env var                             | Low      | Closed — test sets env var in beforeEach, self-contained                                                                                  |
| GAP-002 | No Studio UI for viewing pipeline execution history / run records                        | Medium   | Accepted — Execution history accessible via MongoDB/API; Studio UI is a UX enhancement — accepted for STABLE                              |
| GAP-003 | Custom pipeline graph definitions lack Studio-to-backend save workflow                   | Medium   | Accepted — Custom pipeline editing is an advanced feature; built-in pipelines cover all 10 analytics types — accepted for STABLE          |
| GAP-004 | No alerting for pipeline run failures (alert-evaluator monitors metrics, not run status) | Medium   | Resolved — Alert evaluator bound to Restate, cron-triggered, pipeline failure hook added                                                  |
| GAP-005 | Some files use `console.log` instead of `createLogger`                                   | Low      | Resolved — migrated to createLogger in all 3 handler files                                                                                |
| GAP-006 | No auto-cleanup / TTL for pipeline run records in MongoDB                                | Medium   | Resolved — 90-day TTL index on startedAt                                                                                                  |
| GAP-007 | No E2E tests for full pipeline lifecycle through HTTP API                                | High     | Resolved — 5 E2E suites (22 tests) + execution pipeline integration                                                                       |
| GAP-008 | Human review workflow for eval judgements not implemented (schema only)                  | Low      | Open                                                                                                                                      |
| GAP-009 | No test for Restate pipeline scheduler (requires Restate runtime)                        | Medium   | Accepted — Cron scheduling manually verified; automated test requires Restate test infrastructure — accepted for STABLE                   |
| GAP-010 | No test for ClickHouse query integration (analytics route tests mock CH)                 | Medium   | Accepted — Analytics queries integration-tested with mocked client; real ClickHouse verified in staging — accepted for STABLE             |
| GAP-011 | 7 node types have service implementations but are NOT wired in SERVICE_HANDLERS          | High     | Resolved — 7 node types wired into SERVICE_HANDLERS, ACTIVITY_TYPES, and server.ts .bind()                                                |
| GAP-012 | NL query service has no HTTP API route exposure                                          | Medium   | Resolved — exposed via `POST /api/projects/:projectId/nl-analytics/ask`                                                                   |
| GAP-013 | Tag rules have MongoDB schema but no runtime evaluation logic in pipeline-engine         | Medium   | Accepted — Tag rule evaluation is documented as out-of-scope for pipeline-engine; schema exists for future consumer — accepted for STABLE |
| GAP-014 | ACTIVITY_TYPES metadata missing for 10 node types                                        | Low      | Resolved — All activity types have ACTIVITY_TYPES metadata entries                                                                        |

---

## 17. Testing & Validation

### Required Test Coverage

| #   | Scenario                           | Coverage Type | Status     | Test File / Note                                                   |
| --- | ---------------------------------- | ------------- | ---------- | ------------------------------------------------------------------ |
| 1   | Graph walker traversal logic       | unit          | PASS       | `pipeline-engine/__tests__/graph-walker.test.ts`                   |
| 2   | Graph validation rules             | unit          | PASS       | `pipeline-engine/__tests__/graph-validation.test.ts`               |
| 3   | Expression evaluator               | unit          | PASS       | `pipeline-engine/__tests__/expression-evaluator.test.ts`           |
| 4   | Config schema validation           | unit          | PASS       | `pipeline-engine/__tests__/config-schemas.test.ts`                 |
| 5   | Pipeline config service            | unit          | PASS       | `pipeline-engine/__tests__/pipeline-config.test.ts`                |
| 6   | Pipeline config route              | unit          | PASS       | `runtime/__tests__/pipeline-config.test.ts`                        |
| 7   | Pipeline analytics route           | unit          | PASS       | `runtime/__tests__/routes/pipeline-analytics-route.test.ts`        |
| 8   | Integration graph pipeline         | integration   | PASS       | `pipeline-engine/__tests__/integration-graph-pipeline.test.ts`     |
| 9   | Integration insight pipeline       | integration   | PASS       | `pipeline-engine/__tests__/integration-insight-pipeline.test.ts`   |
| 10  | Integration toxicity pipeline      | integration   | PASS       | `pipeline-engine/__tests__/integration-toxicity-pipeline.test.ts`  |
| 11  | Config-driven integration pipeline | integration   | PASS       | `pipeline-engine/__tests__/config-driven-integration.test.ts`      |
| 12  | Cron expression parsing            | unit          | PASS       | `pipeline-engine/__tests__/cron.test.ts`                           |
| 13  | Node registry                      | unit          | PASS       | `pipeline-engine/__tests__/node-registry.test.ts`                  |
| 14  | Eval circuit breaker               | unit          | PASS       | `pipeline-engine/__tests__/eval-circuit-breaker-errors.test.ts`    |
| 15  | All compute services               | unit          | PASS       | 10+ test files covering sentiment, intent, quality, etc.           |
| 16  | E2E pipeline config CRUD           | e2e           | PASS       | `runtime/__tests__/pipeline-config.e2e.test.ts` (E2E-1)            |
| 17  | E2E pipeline config isolation      | e2e           | PASS       | `runtime/__tests__/pipeline-config.e2e.test.ts` (E2E-2)            |
| 18  | E2E pipeline config RBAC           | e2e           | PASS       | `runtime/__tests__/pipeline-config.e2e.test.ts` (E2E-7)            |
| 19  | E2E config validation              | e2e           | PASS       | `runtime/__tests__/pipeline-config.e2e.test.ts` (E2E-4)            |
| 20  | E2E trigger states API             | e2e           | PASS       | `runtime/__tests__/pipeline-config.e2e.test.ts` (E2E-6)            |
| 21  | Integration execution pipeline     | integration   | PASS       | `pipeline-engine/__tests__/integration-execution-pipeline.test.ts` |
| 22  | Integration trigger→execution path | integration   | PASS       | `pipeline-engine/__tests__/integration-trigger-execution.test.ts`  |
| 23  | E2E pipeline analytics query       | e2e           | NOT TESTED | Requires ClickHouse — out of scope (analytics is separate feature) |
| 24  | E2E eval pipeline lifecycle        | e2e           | NOT TESTED | Requires Restate + ClickHouse — infrastructure-dependent           |

### Testing Notes

The pipeline engine has extensive unit and integration test coverage (780+ tests across 65+ test files). Two integration tests cover the execution path:

1. **`integration-execution-pipeline.test.ts`** — bridges walkGraph → buildExecutionContext → real service handlers (EvaluateMetrics, EvaluatePolicy, Transform), verifying the graph execution data flow minus Restate durable state.
2. **`integration-trigger-execution.test.ts`** — tests the **production execution path**: Kafka event → `PipelineTrigger.handleEvent` → `findActivePipelinesForEvent` (real MongoDB) → trigger matching, tenant isolation, event filtering, multi-trigger strategy resolution, `activeTriggers` override, sampling rate enforcement, manual trigger path, activity dispatch with real service handlers, and run record persistence. This test found a real bug: Mongoose defaults `activeTriggers` to `[]`, which the `??` operator doesn't fall through, preventing trigger resolution.

**IMPORTANT: Execution path testing is a gate for BETA and above.** Pipeline config CRUD E2E tests alone are insufficient — they only test the API layer. The execution path (trigger matching → strategy resolution → activity dispatch → run record lifecycle) is the primary production code path and MUST have integration test coverage before claiming BETA status.

**Status rationale (BETA)**: 5 E2E test suites (22 tests) covering config CRUD lifecycle, isolation, RBAC, validation, and trigger states. 6 integration test files including 2 execution path tests. 49 unit test files. Remaining E2E gaps: analytics queries (separate feature) and eval pipeline lifecycle (requires Restate + ClickHouse infrastructure).

> Full testing details: `../testing/pipeline-engine.md`

---

## 18. References

- Design docs: `docs/specs/pipeline-engine.hld.md`, `docs/plans/pipeline-engine.lld.md`
- Related feature docs: [analytics-insights-dashboard](./analytics-insights-dashboard.md), [experiments](./experiments.md)
- Playbooks: `docs/sdlc/pipeline.md`
- SDLC logs: `docs/sdlc-logs/pipeline-engine/`
