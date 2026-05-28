# Insights & Metrics Presentation Design

> Design spec for the ABL Platform's analytics and insights UI — answering 233 customer queries across 14 personas, backed by ~47 ClickHouse tables and 17 materialized views.

**Date:** 2026-03-12
**Status:** Draft
**Scope:** Studio frontend (apps/studio), Runtime analytics API (apps/runtime), ClickHouse data layer (packages/pipeline-engine + packages/database)
**Review Status:** Spec-reviewed + codebase audit complete (Round 3, 2026-03-16). Critical findings: 5 features proposed as NEW already exist in backend — scoped to frontend-only. See Section 15 for full review log.

---

## Table of Contents

1. [Executive Summary](#1-executive-summary)
2. [Current State Analysis](#2-current-state-analysis)
3. [ClickHouse Data Access Strategy](#3-clickhouse-data-access-strategy)
4. [Page Architecture](#4-page-architecture)
5. [Shared Component Library](#5-shared-component-library)
6. [Page-by-Page Design](#6-page-by-page-design)
7. [API Layer Design](#7-api-layer-design)
8. [Suggested Pipeline & UI Changes](#8-suggested-pipeline--ui-changes)
9. [Charting Strategy](#9-charting-strategy)
10. [Performance & Caching Strategy](#10-performance--caching-strategy)
11. [Implementation Priority](#11-implementation-priority)
12. [Security, Accessibility & Error Handling](#12-security-accessibility--error-handling)
13. [API Routing Clarification](#13-api-routing-clarification)
14. [Known Bugs to Fix in Phase 1](#14-known-bugs-to-fix-in-phase-1)
15. [Review Log](#15-review-log)
16. [Appendix: Query-to-Page Mapping](#appendix-query-to-page-mapping)

---

## 1. Executive Summary

### The Problem

We have 233 customer queries across 14 personas that our analytics platform must answer. The backend is surprisingly mature — ~47 ClickHouse tables, 17 materialized views, 11 pipeline types with analytics API endpoints, a Redis caching layer, plus existing services for NL-to-SQL analytics, ROI calculations, alert evaluation, and experiment management. But the frontend has **zero connections** to the pipeline-analytics API. The Studio's "Insights" sidebar group has 3 of 6 pages showing "Coming Soon."

### The Approach

Rather than building 233 individual screens, we organize the queries into **7 primary pages** (plus 2 system pages) that map naturally to persona workflows. Each page uses a **drill-down architecture**: KPI cards → trend charts → breakdowns → conversation list → conversation detail. This "observe → diagnose → act" pattern matches how every modern analytics tool works (Datadog, Grafana, Amplitude, LangSmith).

### Key Design Decisions

1. **Unified Data Access Layer** — A single `ClickHouseQueryService` that knows which tables/MVs to query for each metric, with a composable query builder instead of hardcoded SQL per endpoint.
2. **Recharts + Custom Components** — We already use recharts v3. Rather than introducing ECharts/Nivo, we build a small library of reusable chart components (HeatmapGrid, SankeyFlow, DistributionPlot) on top of recharts + SVG.
3. **Pipeline-Aware Analytics** — Each pipeline type's output feeds specific dashboard sections. The `llm_evaluate` node (with its flexible tag/score schema) becomes the universal building block for custom evaluations.
4. **Progressive Disclosure** — KPI cards show the "what," clicking reveals the "why" via drill-down panels. No page ever shows more than 6 KPIs at the top level.
5. **Real-Time + Batch Hybrid** — Summary/breakdown endpoints use 5-min Redis cache. Timeseries uses 10-min cache. Conversation detail uses 1-hr cache. Proactive alerts use WebSocket push.

---

## 2. Current State Analysis

### What We Have (Backend — Strong)

| Layer              | Status                     | Details                                                                                                                                |
| ------------------ | -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| ClickHouse tables  | **~47 tables**             | 12 core platform + 6 aggregation dest, 23 analytics pipeline, 3 eval, 3 SearchAI (+ dynamic)                                           |
| Materialized views | **17 MVs**                 | 7 platform (AggregatingMergeTree), 6 analytics (SummingMergeTree), 4 eval (AggregatingMergeTree), plus 2 pre-designed but not deployed |
| Analytics API      | **5 endpoints × 11 types** | summary, breakdown, conversations, conversation/:id, timeseries                                                                        |
| Redis caching      | **Operational**            | 5-min summary, 10-min timeseries, 1-hr conversation detail (pipeline-analytics only — other routes uncached)                           |
| Pipeline engine    | **34 node types**          | Full execution with Restate workflows, graph + legacy modes                                                                            |
| Builtin pipelines  | **10 definitions**         | sentiment, intent, quality, hallucination, knowledge-gap, guardrail, friction, anomaly, drift, eval                                    |
| NL Analytics       | **Operational**            | `NLQueryService` + `semantic-layer.ts` — LLM-based NL-to-SQL against 22 tables, mounted at `/nl-analytics/ask`                         |
| ROI Calculator     | **Operational**            | `ROICalculator` service + `/roi/*` routes — monthly savings, annual ROI, FTE equivalent, budget status, simulation                     |
| Alert Evaluator    | **Operational**            | `AlertEvaluator` Restate service + `/alerts/*` routes — full CRUD, test-fire, cooldown, `AlertRuleModel` in MongoDB `alert_rules`      |
| Experiment Mgmt    | **Operational**            | `ExperimentModel` + `/experiments/*` routes — full CRUD, start/stop lifecycle, results/timeseries from ClickHouse                      |
| External Events    | **Operational**            | `/external-events/*` routes — POST single/batch ingestion, list, correlate with metric timeseries from MVs                             |

### What We Have (Frontend — Sparse)

| Component                | Status          | Details                                                                                                                                                                                                                                                                                                         |
| ------------------------ | --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Insights Dashboard       | **Live**        | Basic KPIs (sessions, cost, latency) from `platform_events` — NOT from pipeline analytics                                                                                                                                                                                                                       |
| Voice Analytics          | **Live**        | Voice-specific metrics from `platform_events_voice_hourly_dest` MV                                                                                                                                                                                                                                              |
| Agent Performance        | **Coming Soon** | Empty placeholder                                                                                                                                                                                                                                                                                               |
| Quality Monitor          | **Coming Soon** | Empty placeholder                                                                                                                                                                                                                                                                                               |
| Customer Insights        | **Coming Soon** | Empty placeholder                                                                                                                                                                                                                                                                                               |
| Pipeline Analytics hooks | **None**        | Zero SWR hooks calling `/api/projects/:projectId/pipeline-analytics/*`                                                                                                                                                                                                                                          |
| KPI Card components      | **5 variants**  | analytics/shared `KPICard` (`{title, value, subtitle}`), ui/`MetricCard` (`{label, value, trend, context, icon}`), InsightsDashboardPage inline (`{label, value, change}`), VoiceAnalyticsPage inline (`{label, value, unit, change, trend}`), VoiceMetricsTab inline (`{label, value, icon, color, subtitle}`) |
| Chart components         | **Basic**       | recharts line/bar/area/pie, MiniSparkline (CSS bars, not recharts), ChartCard (minimal), ChartWidget (richer, with description + info tooltip)                                                                                                                                                                  |
| Time range pickers       | **4 variants**  | Shared `TimeRangeSelector` (exists but **unused**), InsightsDashboardPage DropdownMenu (7d/30d/90d), VoiceAnalyticsPage pills (24h/7d/30d), AnalyticsPage Grafana-style pills (30m→30d + custom)                                                                                                                |

### What We Have (Backend Services — Strong, Partially Unknown to Frontend)

The following services are fully implemented but have **zero frontend integration**:

| Service                  | Location                                                                    | What It Does                                                                                                                                          | Frontend Status        |
| ------------------------ | --------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `NLQueryService`         | `packages/pipeline-engine/src/pipeline/services/nl-query.service.ts`        | LLM-based NL-to-SQL: semantic layer context → LLM SQL generation → validation (SELECT-only, tenant filter injection) → ClickHouse execution → results | No Studio UI           |
| `semantic-layer.ts`      | `packages/pipeline-engine/src/pipeline/services/semantic-layer.ts`          | Comprehensive schema context for 22 ClickHouse tables with column-level metadata, descriptions, examples                                              | Used by NLQueryService |
| `ROICalculator`          | `packages/pipeline-engine/src/pipeline/services/roi-calculator.service.ts`  | Computes monthlySavings, annualSavings, fteEquivalent, roiPercentage, budgetStatus + `simulateContainmentChange()`                                    | No Studio UI           |
| `ProjectCostConfig`      | `packages/pipeline-engine/src/schemas/project-cost-config.schema.ts`        | MongoDB model for configurable ROI cost parameters (human cost, AI cost, FTE capacity, budget)                                                        | No Studio UI           |
| `AlertEvaluator`         | `packages/pipeline-engine/src/pipeline/services/alert-evaluator.service.ts` | Restate activity: loads enabled AlertRules from MongoDB, queries ClickHouse, evaluates thresholds, respects cooldowns                                 | No Studio UI           |
| `AlertRuleModel`         | `packages/pipeline-engine/src/schemas/alert-rule.schema.ts`                 | MongoDB `alert_rules` collection with metric, sourceTable, aggregation, window, condition, threshold, channels, status (ok/firing/cooldown)           | No Studio UI           |
| `ExperimentModel`        | `@agent-platform/pipeline-engine`                                           | MongoDB model for experiments with status lifecycle (draft→running→stopped)                                                                           | No Studio UI           |
| `AnalyticsCache`         | `packages/pipeline-engine/src/pipeline/services/analytics-cache.ts`         | Redis fail-open cache with tiered TTLs. **Only used by pipeline-analytics.ts** — general analytics, voice, NL routes are uncached                     | Partial backend use    |
| `EventQueryService`      | `packages/eventstore/src/query/event-query-service.ts`                      | Wraps IEventReader with caching for platform_events queries                                                                                           | Used by analytics.ts   |
| `ClickHouseMetricsStore` | `apps/runtime/src/services/stores/clickhouse-metrics-store.ts`              | Direct SQL against llm_metrics for usage/billing                                                                                                      | Used by tenant-usage   |
| Eval alert templates     | `packages/pipeline-engine/src/pipeline/services/eval/eval-alerts.ts`        | 8 pre-configured alert rules for eval monitoring                                                                                                      | No Studio UI           |

### The Gap

The pipeline-analytics API returns rich, pre-aggregated data for 11 pipeline types. The Studio never calls it. Multiple backend services (NL analytics, ROI calculations, alert evaluation, experiment management, external event correlation) are **fully implemented with API routes** but have **zero frontend UI**. The 233 customer queries map almost entirely to data and services that **already exist** — the primary gap is the presentation layer, cross-pipeline composite query endpoints, and wiring existing APIs to the Studio frontend.

---

## 3. ClickHouse Data Access Strategy

### 3.1 Table Taxonomy

Understanding how to access all ClickHouse collections requires knowing their three categories:

#### Category A: Per-Node-Type Tables (23 tables)

These are created by `initAnalyticsTables()` and written to by individual pipeline compute nodes. Each table stores the output of one specific analysis type.

| Table                          | Written By                  | Primary Metrics                                                                                                     | Used For Queries       |
| ------------------------------ | --------------------------- | ------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| `message_sentiment`            | compute-sentiment           | Per-message sentiment score, label, frustration signals                                                             | #68-75, #76-80         |
| `conversation_sentiment`       | compute-sentiment           | Avg/start/end/min/max sentiment, `sentiment_trajectory` (not `trajectory`), pivot count                             | #1-17, #59-67          |
| `intent_classifications`       | compute-intent              | Primary/sub intent, confidence, secondary intents                                                                   | #95-103                |
| `quality_evaluations`          | compute-quality             | Overall score, helpfulness, accuracy, professionalism, flagged                                                      | #25-32, #59-67         |
| `conversation_outcomes`        | compute-quality             | Outcome (resolved/escalated/abandoned), method, goal status                                                         | #1-10, #25-32          |
| `hallucination_evaluations`    | conversation-analyzer       | Overall score, faithfulness, consistency, contradiction flag                                                        | #63-64                 |
| `knowledge_gap_evaluations`    | conversation-analyzer       | Retrieval precision, citation rate, gap detected, gap topics                                                        | #86-94                 |
| `guardrail_evaluations`        | conversation-analyzer       | FP/FN scores, bypass detected, severity                                                                             | #81-85                 |
| `context_evaluations`          | conversation-analyzer       | Context score, duplication, handoff count                                                                           | #211-218               |
| `friction_detections`          | compute-statistical         | Friction score, rephrase count, caps/exclamation counts                                                             | #68-75                 |
| `anomaly_detections`           | compute-statistical         | Anomaly flag, severity, z-score, metric name/value                                                                  | #190-200               |
| `drift_detections`             | compute-statistical         | Drift score, type, baseline vs current mean, trend slope                                                            | #150-154               |
| `toxicity_evaluations`         | compute-toxicity            | Avg/max toxicity, flagged, status                                                                                   | #65-66                 |
| `message_toxicity`             | compute-toxicity            | Per-message toxicity score                                                                                          | #65-66                 |
| `goal_completions`             | compute-goal-completion     | Overall score, goal detected/achieved, criteria                                                                     | #33-40                 |
| `conversation_mentions`        | compute-mentions            | Mention type (competitor/feature_request/bug_report), confidence                                                    | #104-110               |
| `experiment_assignments`       | (pipeline)                  | Experiment ID, `experiment_group` (Enum8: 'control'/'experiment', **not** `group`)                                  | #155-162               |
| `customer_predictive_features` | compute-predictive-features | Avg sentiment, escalation rate, churn risk score, risk level                                                        | #111-116               |
| `churn_risk_scores`            | compute-predictive-features | Risk score, risk level, contributing factors                                                                        | #111-116               |
| `llm_evaluate`                 | llm-evaluate                | Tag, `score` (Nullable Float32 — aggregations must use `sumIf(score, score IS NOT NULL)`), output (flexible schema) | Custom evaluations     |
| `custom_events`                | (pipeline)                  | Event name, properties                                                                                              | Custom tracking        |
| `conversation_tags`            | (pipeline)                  | Tag name, applied by, rule ID                                                                                       | Categorization         |
| `external_events`              | external-events API         | Event type (deployment/incident/...), title, properties, severity                                                   | Trend markers (#11-17) |

#### Category B: Common Platform Tables (18 base tables + 7 MVs)

Created by `initClickHouseSchema()` in `packages/database`. These store operational data independent of any specific pipeline. The 7 MVs in this category were previously undercounted.

**Base Tables (12):**

| Table                        | Engine                       | Purpose                   | Key Metrics                                                                      | Used For Queries      |
| ---------------------------- | ---------------------------- | ------------------------- | -------------------------------------------------------------------------------- | --------------------- |
| `messages`                   | ReplicatedMergeTree          | All conversation messages | Content (encrypted), role, tool calls, token count                               | #33-40, #186, #219    |
| `llm_metrics`                | ReplicatedMergeTree          | Per-LLM-call metrics      | Tokens (input/output/reasoning), cost, latency, model, provider                  | #138-154              |
| `platform_events`            | ReplicatedMergeTree          | Unified event store       | Category, event type, session, agent, duration, tokens, cost                     | #25-32, #41-48        |
| `platform_events_by_session` | ReplicatedReplacingMergeTree | Session-level event dedup | Deduplicated events per session (avoids double-counting)                         | Session-based metrics |
| `logs`                       | ReplicatedMergeTree          | Application logs          | Level, message, metadata                                                         | Engineering debugging |
| `facts`                      | ReplacingMergeTree           | Key-value store           | UPSERT semantics                                                                 | Configuration         |
| `audit_events`               | ReplicatedMergeTree          | Audit trail               | Action, actor, resource, no-delete TTL                                           | #219-225              |
| `search_queries`             | ReplicatedMergeTree          | SearchAI queries          | Query text, results, latency                                                     | SearchAI analytics    |
| `search_ingestion_events`    | ReplicatedMergeTree          | Ingestion tracking        | Source, status, document count                                                   | SearchAI analytics    |
| `dead_letter_events`         | ReplicatedMergeTree          | Failed events             | Original event, error, retry count                                               | Debugging             |
| `kms_audit_log`              | ReplicatedMergeTree          | Encryption audit          | Key operations                                                                   | Compliance            |
| `insight_results`            | ReplicatedMergeTree          | Pipeline insights         | Generic insight storage (note: uses ReplicatedMergeTree unlike analytics tables) | Cross-pipeline        |

**Aggregation Destination Tables (6):**

| Table                               | Engine               | Date Column | Purpose              | Used For Queries |
| ----------------------------------- | -------------------- | ----------- | -------------------- | ---------------- |
| `llm_metrics_hourly_dest`           | AggregatingMergeTree | `hour`      | Hourly LLM rollup    | #145-149         |
| `llm_metrics_daily_dest`            | AggregatingMergeTree | **`day`**   | Daily LLM rollup     | #145-149         |
| `platform_events_agent_hourly_dest` | AggregatingMergeTree | `hour`      | Agent metrics hourly | #25-32           |
| `platform_events_tool_daily_dest`   | AggregatingMergeTree | **`day`**   | Tool metrics daily   | #41-48           |
| `platform_events_error_hourly_dest` | AggregatingMergeTree | `hour`      | Error rate hourly    | #141, #192       |
| `platform_events_voice_hourly_dest` | AggregatingMergeTree | `hour`      | Voice/QoS hourly     | #201-210         |

**Materialized Views (7 — previously undercounted):**

| MV                              | Source          | Dest Table                        | Date Column |
| ------------------------------- | --------------- | --------------------------------- | ----------- |
| `llm_metrics_hourly`            | llm_metrics     | llm_metrics_hourly_dest           | `hour`      |
| `llm_metrics_daily`             | llm_metrics     | llm_metrics_daily_dest            | **`day`**   |
| `platform_events_agent_hourly`  | platform_events | platform_events_agent_hourly_dest | `hour`      |
| `platform_events_tool_daily`    | platform_events | platform_events_tool_daily_dest   | **`day`**   |
| `platform_events_error_hourly`  | platform_events | platform_events_error_hourly_dest | `hour`      |
| `platform_events_voice_hourly`  | platform_events | platform_events_voice_hourly_dest | `hour`      |
| `platform_events_by_session_mv` | platform_events | platform_events_by_session        | —           |

Additionally, 2 MVs are defined in `packages/eventstore` but **not auto-deployed** (marked "deploy lazily"): `session_metrics_daily_mv` (`day`), `llm_cost_hourly_mv` (`hour`).

#### Category C: Eval Tables (3 tables + 4 MVs)

Created by `initEvalTables()`. Store offline evaluation run data.

| Table                    | Engine    | Purpose                                | Used For Queries |
| ------------------------ | --------- | -------------------------------------- | ---------------- |
| `eval_conversations`     | MergeTree | Full eval conversation data (gzipped)  | #228-233         |
| `eval_scores`            | MergeTree | Evaluation scores with bias mitigation | #228-233         |
| `eval_production_scores` | MergeTree | Production monitoring scores           | #228-233         |

**Eval Materialized Views (4):**

| MV                                   | Engine               | Date Column  | Purpose                      |
| ------------------------------------ | -------------------- | ------------ | ---------------------------- |
| `mv_eval_heatmap_dest`               | AggregatingMergeTree | `month_date` | Evaluator × persona heatmap  |
| `mv_eval_run_evaluator_summary_dest` | AggregatingMergeTree | `month_date` | Per-evaluator summary        |
| `mv_eval_score_trend_dest`           | AggregatingMergeTree | **`day`**    | Score trend over time        |
| `mv_eval_production_hourly_dest`     | AggregatingMergeTree | `hour`       | Production monitoring hourly |

#### Category D: Dynamic Tables

| Table                       | Created By                       | Purpose                        |
| --------------------------- | -------------------------------- | ------------------------------ |
| `structured_data_{tableId}` | SearchAI structured data service | Per-uploaded-table data        |
| `table_metadata`            | SearchAI                         | Metadata about uploaded tables |
| `json_path_index`           | SearchAI migration               | JSON path indexing             |

### 3.2 Data Access Architecture

```
┌─────────────────────────────────────────────────────┐
│                    Studio Frontend                    │
│                                                       │
│  SWR Hooks (usePipelineAnalytics, useInsights, etc.) │
│         ↓                                             │
│  Next.js API Routes (proxy with auth)                │
└───────────────┬─────────────────────────────────────┘
                │ HTTP
┌───────────────▼─────────────────────────────────────┐
│                  Runtime Server                       │
│                                                       │
│  ┌─────────────────────────────────────────────────┐ │
│  │          Unified Analytics Router                │ │
│  │                                                   │ │
│  │  /pipeline-analytics/:type/*  (existing)         │ │
│  │  /analytics/*                 (existing)         │ │
│  │  /insights/*                  (NEW)              │ │
│  │  /alerts/*                    (NEW)              │ │
│  └───────────────┬─────────────────────────────────┘ │
│                  │                                     │
│  ┌───────────────▼─────────────────────────────────┐ │
│  │       ClickHouseQueryService (NEW)               │ │
│  │                                                   │ │
│  │  • Composable query builder                      │ │
│  │  • Table/MV routing per metric type              │ │
│  │  • Automatic MV preference (fast) → raw (flex)   │ │
│  │  • Cross-table joins for composite metrics       │ │
│  │  • Parameterized queries (tenant isolation)      │ │
│  │  • Redis cache integration (AnalyticsCache)      │ │
│  └───────────────┬─────────────────────────────────┘ │
│                  │                                     │
│  ┌───────────────▼─────────────────────────────────┐ │
│  │          ClickHouse Client                       │ │
│  │  (packages/database/src/clickhouse.ts)           │ │
│  └─────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────┘
```

### 3.3 ClickHouseQueryService — Cross-Pipeline Query Layer

> **Note:** Several query services already exist (see Section 2 "Backend Services" table): `NLQueryService` handles NL-to-SQL via the `semantic-layer.ts` schema context, `EventQueryService` wraps platform_events queries, and `ClickHouseMetricsStore` handles LLM billing queries. The proposed `ClickHouseQueryService` fills a different gap: **programmatic, type-safe cross-pipeline metric queries** with a declarative registry — complementing (not replacing) the existing services.

The current analytics API has hardcoded SQL per pipeline type per endpoint. This works for single-pipeline queries but fails for:

- **Cross-pipeline metrics** (e.g., "cost savings" requires joining `conversation_outcomes` + `llm_metrics` at query time — containment rate itself comes from `conversation_outcomes` alone: `countIf(outcome='resolved') / count(*)`)
- **Composite KPIs** (e.g., "cost per resolution by intent" requires joining `llm_metrics` + `conversation_outcomes` + `intent_classifications` — a 3-table query-time join that ClickHouse handles efficiently with partition pruning)
- **Drill-down chains** (summary → breakdown by agent → filter by intent → show conversations)

**Proposed service:**

```typescript
// packages/pipeline-engine/src/pipeline/services/clickhouse-query.service.ts

interface QueryOptions {
  tenantId: string;
  projectId: string;
  timeRange: { from: Date; to: Date };
  filters?: Record<string, string | string[]>; // agent_name, channel, intent, etc.
  groupBy?: string[]; // dimensions to group by
  orderBy?: { field: string; direction: 'ASC' | 'DESC' }[];
  limit?: number;
  offset?: number;
}

interface MetricDefinition {
  name: string;
  table: string; // primary table
  mvTable?: string; // materialized view (preferred if groupBy matches MV keys)
  expression: string; // SQL expression for raw table query
  mvExpression?: string; // SQL expression for MV query (MVs store sums, not averages)
  dateColumn: string; // date column on the raw table
  mvDateColumn?: string; // date column on the MV (varies: 'date' vs 'day' — see Known Bug below)
  filters?: string; // additional WHERE clauses
}

// ⚠️ KNOWN BUG: MV date column inconsistency
// The first 3 analytics MVs (mv_daily_sentiment, mv_daily_intent_distribution,
// mv_daily_quality_scores) use column name `date`.
// The later 3 MVs (mv_daily_custom_events, mv_daily_outcomes, mv_daily_llm_evaluate)
// use column name `day`.
// The existing pipeline-analytics.ts timeseries route queries all MVs using `day`,
// which fails silently for the first three MVs.
// Phase 1 MUST fix this: either migrate all MVs to use `day`, or use mvDateColumn
// in the metric registry to handle the discrepancy.

// ⚠️ KNOWN BUG: MV aggregate columns are sums, not averages
// Analytics MVs use SummingMergeTree and store totals (e.g., `total_sentiment`,
// `total_score`), NOT averages. To compute averages from MVs, you MUST use:
//   sum(total_sentiment) / sum(conversation_count)
// NOT: avg(avg_sentiment)
// The existing pipeline-analytics.ts has this same bug. Phase 1 fixes it.

// ⚠️ COLUMN NAME MISMATCHES — verified against actual schema:
// - `conversation_sentiment.sentiment_trajectory` (NOT `trajectory`)
// - `experiment_assignments.experiment_group` (NOT `group`) — Enum8('control'=0, 'experiment'=1)
// - `llm_evaluate.score` is Nullable(Float32) — use sumIf(score, score IS NOT NULL)
// - `conversation_outcomes.outcome` is LowCardinality(String), NOT an enum —
//   values 'resolved','escalated','abandoned' are convention, not enforced by DDL

// Registry of all queryable metrics
const METRIC_REGISTRY: Record<string, MetricDefinition> = {
  // Containment
  containment_rate: {
    name: 'Containment Rate',
    table: 'conversation_outcomes',
    mvTable: 'mv_daily_outcomes',
    expression: "countIf(outcome = 'resolved') / count(*) * 100",
    mvExpression: "sumIf(session_count, outcome = 'resolved') / sum(session_count) * 100",
    dateColumn: 'session_started_at',
    mvDateColumn: 'day',
  },
  // Sentiment
  avg_sentiment: {
    name: 'Average Sentiment',
    table: 'conversation_sentiment',
    mvTable: 'mv_daily_sentiment',
    expression: 'avg(avg_sentiment)', // raw table: avg() works
    mvExpression: 'sum(total_sentiment) / sum(conversation_count)', // MV: must compute from sums
    dateColumn: 'session_started_at',
    mvDateColumn: 'date', // ⚠️ this MV uses 'date', not 'day'
  },
  // Quality
  avg_quality_score: {
    name: 'Average Quality Score',
    table: 'quality_evaluations',
    mvTable: 'mv_daily_quality_scores',
    expression: 'avg(overall_score)', // raw table
    mvExpression: 'sum(total_score) / sum(conversation_count)', // MV: sums
    dateColumn: 'session_started_at',
    mvDateColumn: 'date', // ⚠️ this MV uses 'date', not 'day'
  },
  // Cost
  total_cost: {
    name: 'Total LLM Cost',
    table: 'llm_metrics',
    mvTable: 'llm_metrics_daily_dest',
    expression: 'sum(total_cost)',
    dateColumn: 'timestamp',
  },
  // ... 50+ more metrics
};
```

This service replaces the per-endpoint SQL in `pipeline-analytics.ts` with a declarative metric registry. The query builder automatically:

1. Chooses MV when groupBy dimensions match MV keys
2. Falls back to raw table when custom filters/groups needed
3. Handles cross-table joins for composite metrics
4. Applies tenant/project isolation on every query
5. Routes through AnalyticsCache

### 3.4 Table Access Patterns by Customer Query Category

| Query Category               | Primary Tables                                                             | MVs Used                                   | Join Tables                                  |
| ---------------------------- | -------------------------------------------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| Overall Performance (#1-10)  | conversation_outcomes, conversation_sentiment                              | mv_daily_outcomes, mv_daily_sentiment      | llm_metrics (cost), platform_events (volume) |
| Trends (#11-17)              | Same as above                                                              | Same + mv_daily_quality_scores             | external_events (deployment markers)         |
| ROI (#18-24)                 | conversation_outcomes, llm_metrics                                         | llm_metrics_daily_dest                     | —                                            |
| Agent Comparison (#25-32)    | quality_evaluations, conversation_outcomes                                 | mv_daily_quality_scores, mv_daily_outcomes | platform_events_agent_hourly_dest            |
| Agent Behavior (#33-40)      | platform_events, goal_completions, context_evaluations                     | platform_events_agent_hourly_dest          | messages (flow analysis)                     |
| Tool Usage (#41-48)          | platform_events                                                            | platform_events_tool_daily_dest            | —                                            |
| Quality Monitoring (#59-67)  | quality_evaluations, hallucination_evaluations, toxicity_evaluations       | mv_daily_quality_scores                    | —                                            |
| Friction/Struggle (#68-75)   | friction_detections, conversation_sentiment, message_sentiment             | mv_daily_sentiment                         | —                                            |
| Sentiment (#76-80)           | conversation_sentiment, message_sentiment                                  | mv_daily_sentiment                         | intent_classifications                       |
| Guardrails (#81-85)          | guardrail_evaluations                                                      | —                                          | —                                            |
| Knowledge Gaps (#86-94)      | knowledge_gap_evaluations                                                  | —                                          | —                                            |
| Intent/Topic (#95-103)       | intent_classifications                                                     | mv_daily_intent_distribution               | conversation_outcomes                        |
| Voice (#201-210)             | platform_events (voice)                                                    | platform_events_voice_hourly_dest          | —                                            |
| Multi-Agent (#211-218)       | context_evaluations, platform_events, llm_evaluate (tag: routing_accuracy) | platform_events_agent_hourly_dest          | —                                            |
| Experiments (#155-162)       | experiment_assignments                                                     | —                                          | conversation_outcomes, quality_evaluations   |
| Churn/Retention (#111-116)   | churn_risk_scores, customer_predictive_features                            | —                                          | conversation_sentiment                       |
| Alerts (#190-200)            | anomaly_detections                                                         | platform_events_error_hourly_dest          | All (threshold monitoring)                   |
| Compliance (#219-225)        | audit_events, messages                                                     | —                                          | —                                            |
| Eval/Optimization (#226-233) | eval_scores, eval_conversations, eval_production_scores                    | mv*eval*\*                                 | knowledge_gap_evaluations                    |
| NL/Ask AI (#163-189)         | ALL tables                                                                 | ALL MVs                                    | Dynamic joins                                |
| LLM Evaluate (custom)        | llm_evaluate                                                               | mv_daily_llm_evaluate                      | —                                            |

---

## 4. Page Architecture

### 4.1 Navigation Restructure

The current sidebar "Insights" group has 6 items (Dashboard, Agent Performance, Quality Monitor, Customer Insights, Voice Analytics, Pipelines). We expand to **7 primary insight pages** + **2 system pages**, reorganized into sub-groups:

```
Insights (sidebar group)
├── At a Glance          ← renamed from "Dashboard", answers queries #1-24
├── Agent Performance    ← currently "Coming Soon", answers #25-58
├── Quality & Safety     ← renamed from "Quality Monitor", answers #59-85
├── Customer Insights    ← currently "Coming Soon", answers #86-116
├── Experiments          ← NEW, answers #155-162
├── Voice Analytics      ← existing, answers #201-210
└── Ask AI               ← NEW, answers #163-189

Operate (sidebar group, existing)
├── Alerts & Watchtower  ← NEW or extend existing, answers #190-200
└── Compliance & Audit   ← NEW, answers #219-225
```

Every page follows a consistent 3-tier drill-down:

```
Tier 1: KPI Scorecard (max 6 cards) + Time Range Selector
  ↓ click card or "View Details"
Tier 2: Trend Charts + Dimension Breakdowns (tables with sparklines)
  ↓ click row or data point
Tier 3: Conversation List → Conversation Detail (full trace with per-message annotations)
```

### 4.2 Shared Page Layout

```
┌──────────────────────────────────────────────────────────┐
│ Page Header: Title + Description + Time Range Picker     │
│              + Refresh + Export + Filters Toggle          │
├──────────────────────────────────────────────────────────┤
│ Filter Bar (collapsible): Agent | Channel | Intent | ... │
├──────────────────────────────────────────────────────────┤
│ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ ┌──────┐ │
│ │ KPI  │ │ KPI  │ │ KPI  │ │ KPI  │ │ KPI  │ │ KPI  │ │
│ │ Card │ │ Card │ │ Card │ │ Card │ │ Card │ │ Card │ │
│ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ └──────┘ │
├──────────────────────────────────────────────────────────┤
│ Tab Bar: Overview | Trends | Breakdown | Conversations   │
├──────────────────────────────────────────────────────────┤
│                                                          │
│                    Tab Content Area                       │
│                                                          │
│  (Charts, tables, detail panels depending on tab)        │
│                                                          │
└──────────────────────────────────────────────────────────┘
```

### 4.3 Cross-Page Navigation

Insights pages are interconnected:

- **At a Glance → Agent Performance**: Click any per-agent metric to jump to that agent's detail
- **At a Glance → Quality & Safety**: Click quality score KPI to drill into quality breakdown
- **Quality & Safety → Conversations**: Click any flagged conversation to see full trace
- **Customer Insights → Agent Performance**: Click an intent to see which agents handle it
- **Experiments → At a Glance**: Compare experiment results against global baselines
- **Any page → Ask AI**: Natural language follow-up on any visible metric

---

## 5. Shared Component Library

### 5.1 KPI Components

We consolidate the three existing MetricCard variants into one unified component:

```typescript
// apps/studio/src/components/insights/shared/InsightKPICard.tsx

interface InsightKPICardProps {
  title: string; // "Containment Rate"
  value: string | number; // "72.3%"
  format?: 'percent' | 'number' | 'currency' | 'duration'; // auto-format
  trend?: {
    value: number; // +5.2 or -3.1
    period: string; // "vs last month"
    favorable: 'up' | 'down'; // is up good or bad?
  };
  sparkline?: number[]; // last 30 data points for embedded mini-chart
  target?: {
    // optional target line
    value: number;
    label: string; // "Q1 Target: 65%"
  };
  status?: 'healthy' | 'warning' | 'critical'; // color-codes the card border
  onClick?: () => void; // drill-down action
  loading?: boolean;
}
```

**Design inspiration**: Datadog's KPI cards with embedded sparklines and delta indicators. The sparkline gives instant trend context without needing to scroll down to charts.

**Visual treatment**:

- 160px wide, glass-morphism background matching existing Studio style
- Left border accent: green (healthy) / amber (warning) / red (critical)
- Trend arrow: green up/red down (or inverse for cost metrics)
- Sparkline: 30px tall, no axes, just the line in a muted color
- Hover: slight elevation + tooltip with exact values

### 5.2 Chart Components

All built on recharts v3 (already in dependencies):

#### TimeSeriesChart

```typescript
interface TimeSeriesChartProps {
  data: { date: string; [metric: string]: number }[];
  metrics: {
    key: string;
    label: string;
    color: string;
    type: 'line' | 'area' | 'bar';
  }[];
  annotations?: {
    // deployment markers, incidents
    date: string;
    label: string;
    type: 'deployment' | 'incident' | 'experiment';
  }[];
  target?: { value: number; label: string }; // horizontal reference line
  onPointClick?: (date: string) => void;
  height?: number;
}
```

#### BreakdownTable

A sortable table with embedded sparklines per row — the "What's driving the metric" pattern from Decagon.

```typescript
interface BreakdownTableProps {
  data: {
    dimension: string; // agent name, intent, channel
    metrics: Record<string, number>; // containment, csat, cost, etc.
    trend: number[]; // sparkline data
    conversationCount: number;
  }[];
  columns: ColumnDefinition[];
  sortable?: boolean;
  onRowClick?: (dimension: string) => void;
}
```

#### DistributionChart

For quality score distributions, sentiment distributions, friction score ranges.

```typescript
interface DistributionChartProps {
  data: { bucket: string; count: number; percentage: number }[];
  type: 'histogram' | 'donut' | 'stacked-bar';
  colorScale?: 'sequential' | 'diverging' | 'categorical';
  onSegmentClick?: (bucket: string) => void;
}
```

#### HeatmapGrid

For eval heatmaps (evaluator × persona × scenario), hourly activity patterns, agent × intent performance matrices.

```typescript
// Custom SVG component (recharts doesn't have native heatmap)
interface HeatmapGridProps {
  data: { row: string; col: string; value: number }[];
  colorScale: { min: string; mid: string; max: string }; // red-yellow-green
  rowLabel: string; // "Evaluator"
  colLabel: string; // "Persona"
  valueLabel: string; // "Score"
  onCellClick?: (row: string, col: string) => void;
}
```

#### SankeyFlow

For conversation flow analysis (AOP path visualization), escalation flow, intent routing.

```typescript
// Custom SVG component using d3-sankey layout (d3-sankey is lightweight, no full d3 needed)
interface SankeyFlowProps {
  nodes: { id: string; label: string; color?: string }[];
  links: { source: string; target: string; value: number }[];
  onNodeClick?: (nodeId: string) => void;
  onLinkClick?: (source: string, target: string) => void;
}
```

#### ComparisonChart

For A/B test results, before/after, version comparison.

```typescript
interface ComparisonChartProps {
  groups: {
    label: string; // "Control" / "Experiment"
    color: string;
    metrics: Record<string, number>;
  }[];
  metrics: string[]; // which metrics to compare
  showSignificance?: boolean; // show p-value / CI bars
}
```

### 5.3 Conversation Explorer Component

Reusable across all pages — the drill-down destination.

```typescript
interface ConversationExplorerProps {
  filters: {
    pipelineType: string;
    scoreRange?: [number, number];
    flagged?: boolean;
    intent?: string;
    agent?: string;
    timeRange: { from: Date; to: Date };
  };
  annotations: 'sentiment' | 'quality' | 'toxicity' | 'friction' | 'all';
}
```

Displays a list of conversations with:

- **Score badge** (color-coded by pipeline type)
- **Intent tag**
- **Agent name**
- **Duration** + **turn count**
- **Outcome** (resolved / escalated / abandoned)
- **Flag indicators** (quality, toxicity, friction, hallucination)

Click a conversation → opens a **Conversation Detail Panel** (slide-over or full page) showing:

- Full message thread with per-message annotations
- Sentiment sparkline along the conversation timeline
- Tool call trace (expandable)
- Quality evaluation breakdown (spider/radar chart)
- Escalation points marked on timeline

### 5.4 FilterBar Component

Shared across all insight pages:

```typescript
interface FilterBarProps {
  available: {
    agents: string[]; // from platform_events
    channels: string[]; // chat, voice, email
    intents: string[]; // from intent_classifications
    tags: string[]; // from conversation_tags
    outcomes: string[]; // from conversation_outcomes
    experiments: string[]; // from experiment_assignments
  };
  selected: Record<string, string[]>;
  onFilterChange: (filters: Record<string, string[]>) => void;
  timeRange: { from: Date; to: Date; preset?: string };
  onTimeRangeChange: (range: { from: Date; to: Date }) => void;
}
```

Time range presets: Last 24h, Last 7 days, Last 30 days, Last 90 days, Custom.

---

## 6. Page-by-Page Design

### 6.1 At a Glance (Executive Dashboard)

**Replaces:** Current `InsightsDashboardPage`
**Answers queries:** #1-24 (CX Operations Leader — Overall Performance, Trends, ROI)
**Primary persona:** VP/Director of Support

#### KPI Cards (6 max)

| Card                 | Metric                                                     | Source Table                        | SQL                          |
| -------------------- | ---------------------------------------------------------- | ----------------------------------- | ---------------------------- |
| Conversations        | `COUNT(DISTINCT session_id)`                               | platform_events                     | `WHERE category = 'session'` |
| Containment Rate     | `countIf(outcome='resolved') / count(*)`                   | conversation_outcomes               | —                            |
| CSAT / Quality Score | `avg(overall_score)`                                       | quality_evaluations                 | MV: mv_daily_quality_scores  |
| Avg Sentiment        | `avg(avg_sentiment)`                                       | conversation_sentiment              | MV: mv_daily_sentiment       |
| Cost Savings         | `(contained_vol × human_cost) - (contained_vol × ai_cost)` | conversation_outcomes + llm_metrics | Composite query              |
| Escalation Rate      | `countIf(outcome='escalated') / count(*)`                  | conversation_outcomes               | —                            |

Each card shows: value, trend vs prior period, 30-day sparkline, color-coded status.

#### Tabs

**Overview Tab:**

- Line chart: Conversation Volume + Containment Rate over time (dual Y-axis)
- Stacked area: Outcome distribution over time (resolved / escalated / abandoned)
- "What's driving the metric" table: Top 5 intents by volume with containment rate, CSAT, trend sparkline

**Trends Tab:**

- Multi-series line: Containment, CSAT, Escalation Rate, Cost — all on one chart with toggleable series
- Deployment markers (from `external_events`) as vertical dashed lines — **ingestion already exists** via `POST /external-events` and `POST /external-events/batch`; correlation via `GET /external-events/correlate`
- Target lines (from configurable targets)

**ROI Tab:**

> **Existing backend:** `ROICalculator` service + `/api/projects/:projectId/roi` routes already provide: `GET /summary` (monthlySavings, annualSavings, fteEquivalent, roiPercentage, budgetStatus), `GET /budget`, `POST /simulate` (containment rate change simulation), `GET /config` + `PUT /config` (cost parameters). Wire these existing endpoints to the UI below.

- KPI row: Monthly savings, Annual ROI, FTE equivalent, Payback period — **from existing `GET /roi/summary`**
- Stacked bar: Cost breakdown (AI cost vs estimated human cost) by month
- Line: Cumulative savings over time
- Table: Per-agent cost efficiency (cost per resolution) — **requires new cross-table query** (not in existing ROI route)

**Conversations Tab:**

- ConversationExplorer with default filters (no specific pipeline type — shows all)

#### Creative Design Elements

1. **"Executive Summary" Card** — AI-generated 3-sentence summary of the week (query #9). Uses the `llm_evaluate` node with a custom "executive-summary" tag that runs weekly, storing the output. Displayed as a highlighted card at the top with a subtle gradient background.

2. **Target Tracking Ring** — For query #6 ("Are we on track?"), a circular progress gauge showing current containment vs quarterly target. If behind pace, shows projected end-of-quarter value as a dashed arc.

3. **AI vs Human Comparison** — For query #7, a side-by-side bar chart comparing AI CSAT vs Human CSAT with a connecting line showing the gap. Inspired by Microsoft D365's "with/without AI" pattern.

---

### 6.2 Agent Performance

**Replaces:** "Coming Soon" placeholder
**Answers queries:** #25-58 (Agent Operations — Performance Comparison, Behavior, Tools, Extraction, Reasoning)
**Primary persona:** Agent designers, AOP authors

#### KPI Cards

| Card                   | Metric                          | Source                          |
| ---------------------- | ------------------------------- | ------------------------------- |
| Active Agents          | Count distinct agent_name       | platform_events                 |
| Worst Performer        | Agent with lowest quality score | quality_evaluations             |
| Top Performer          | Agent with highest containment  | conversation_outcomes           |
| Avg Steps/Conversation | Avg turn count per agent        | platform_events                 |
| Tool Failure Rate      | Failed tool calls / total       | platform_events_tool_daily_dest |
| Handoff Accuracy       | Context score on handoffs       | context_evaluations             |

#### Tabs

**Comparison Tab:**

- **Agent Comparison Table** — All agents, side-by-side columns: containment, CSAT, cost/conversation, avg turns, escalation rate, trend sparkline. Sortable by any column. Click row → drill into agent.
- Color-coded heatmap rows (red = bottom quartile, green = top quartile)

**Agent Detail Tab (drill-down):**

- Selected agent's KPIs at top
- **Conversation Flow Sankey** — For queries #33-36: nodes = AOP steps, links = conversation volume flowing between steps. Width proportional to volume. Color: green (resolved), red (escalated), gray (dropped). Shows where conversations get stuck or loop.
- **Drop-off Funnel** — Vertical funnel chart showing reach rate at each AOP step
- Step-level metrics table: reach %, evaluation %, avg time, success rate

**Tool Analysis Tab:**

- For queries #41-48
- Table: Tool name, call count, success rate, avg latency, retry rate
- Bar chart: Tool latency distribution (P50, P95, P99)
- Unused tools highlighted in amber

**Reasoning Tab:**

- For queries #49-58
- Extraction accuracy per field (horizontal bar chart)
- Extraction efficiency: actual vs optimal turns (paired bar)
- Self-correction rate trend line
- Routing accuracy confusion matrix (supervisor → agent) — uses `llm_evaluate` with `tag: 'routing_accuracy'`

#### Creative Design Elements

1. **Agent Health Matrix** — A compact heatmap grid (rows = agents, columns = metrics: containment, quality, cost, speed, satisfaction). Each cell is color-coded. At a glance, you see which agents are healthy vs struggling across all dimensions. Inspired by Grafana's panel grid.

2. **Flow Animation** — The Sankey diagram animates particles flowing along paths when first loaded, showing conversation volume as flowing "water." Particle speed correlates with conversation speed. Built with Framer Motion.

3. **"Worst → Best" Improvement Tracker** — A slope chart showing each agent's quality score last month → this month. Lines going up = improving (green), down = degrading (red). Immediately answers query #30.

---

### 6.3 Quality & Safety (Watchtower)

**Replaces:** "Coming Soon" Quality Monitor
**Answers queries:** #59-85 (QA/CX Analyst — Quality Monitoring, Friction, Sentiment, Guardrails)
**Primary persona:** QA team, CX analysts

#### KPI Cards

| Card                   | Metric                             | Source                    |
| ---------------------- | ---------------------------------- | ------------------------- |
| Conversations Analyzed | Total evaluated                    | quality_evaluations       |
| Flagged Rate           | flagged=true / total               | quality_evaluations       |
| Avg Quality Score      | avg(overall_score)                 | quality_evaluations       |
| Hallucination Rate     | avg(1 - faithfulness_score)        | hallucination_evaluations |
| Friction Rate          | friction_score > threshold / total | friction_detections       |
| Guardrail Bypass Rate  | bypass_detected=true / total       | guardrail_evaluations     |

#### Tabs

**Quality Overview Tab:**

- Quality score distribution histogram (1-5 scale, colored by grade: red/amber/green)
- Daily flagged rate trend line with anomaly markers
- Breakdown by criterion: helpfulness, accuracy, professionalism (grouped bar chart)
- "Top failing criteria" table with example conversations

**Sentiment Tab:**

- For queries #76-80
- Sentiment distribution donut (positive / neutral / negative)
- Sentiment trajectory stacked area (improving / stable / declining / volatile)
- **Sentiment Pivot Heatmap** — For query #77: heatmap where rows = agent responses, columns = conversation turn, cell color = sentiment delta. Hot spots show which responses cause sentiment drops.
- Recovery pattern analysis: % of negative conversations that recover to positive

**Friction Detection Tab:**

- For queries #68-75
- Friction score distribution (histogram)
- Top friction indicators: rephrase count, caps count, exclamation count (stacked bar by intent)
- **Message Length Escalation Chart** — For query #71: line chart of average user message length across turns for high-friction conversations. The telltale "hockey stick" pattern.
- Channel switch detection rate

**Guardrail & Safety Tab:**

- For queries #81-85
- Guardrail effectiveness table: rule name, trigger count, FP rate, FN rate
- Severity distribution (critical / medium / low) stacked bar over time
- Jailbreak attempt trend line
- PII violation count with drill-down to conversations

#### Creative Design Elements

1. **Watchtower Severity Strip** — A thin horizontal heatmap at the top of the page showing conversation quality across time (like a GitHub contribution graph rotated 90°). Each column is an hour, color intensity = flagged rate. Immediately shows when quality dipped.

2. **Conversation Health Score** — Each conversation gets a composite badge: 🟢 Healthy / 🟡 At Risk / 🔴 Critical, computed from quality + sentiment + friction + hallucination scores. The conversation list shows these badges for instant triage.

3. **"Sentiment Journey" Visualization** — For individual conversations, a connected dot plot showing sentiment score at each turn, with agent/user alternating on different Y positions. Lines connecting them show the emotional arc. Inspired by patient journey charts in healthcare UX.

---

### 6.4 Customer Insights

**Replaces:** "Coming Soon" placeholder
**Answers queries:** #86-116 (Knowledge Base Gaps, Voice of Customer, Churn Signals)
**Primary persona:** KB/Content Managers, Product Managers, VoC Analysts

#### KPI Cards

| Card                | Metric                               | Source                    |
| ------------------- | ------------------------------------ | ------------------------- |
| Knowledge Gaps      | gap_detected=true / total            | knowledge_gap_evaluations |
| Top Missing Topic   | Most frequent gap_topic              | knowledge_gap_evaluations |
| Citation Rate       | avg(citation_rate)                   | knowledge_gap_evaluations |
| Churn Risk Accounts | risk_level='high' count              | churn_risk_scores         |
| Feature Requests    | mention_type='feature_request' count | conversation_mentions     |
| Competitor Mentions | mention_type='competitor' count      | conversation_mentions     |

#### Tabs

**Knowledge Gaps Tab (Suggestions):**

- For queries #86-94
- **Gap Treemap** — Proportional area chart where each rectangle = a gap topic, size = conversation volume affected, color = severity. Inspired by Decagon's "Suggestions" screen showing "App Functionality 5.24%, Payment Issues 3.62%."
- Citation coverage trend line
- Context utilization chart (retrieved chunks vs used chunks)
- "Top articles powering resolutions" table
- Auto-draft suggestion cards (link to KB editor)

**Intent Analysis Tab:**

- For queries #95-103
- Intent distribution bar chart (ranked by volume)
- **"What's Driving the Metric" Table** — Intent × (containment rate, CSAT, trend) with sparklines. This is the Decagon pattern — decompose any metric movement into contributing intents.
- Intent co-occurrence heatmap (which intents appear together)
- Emerging topics alert (intents with >50% week-over-week growth)

**Voice of Customer Tab:**

- For queries #104-110
- Competitor mention timeline + sentiment overlay
- Feature request word cloud / ranked list
- Root cause distribution (product bug / user confusion / documentation gap) — donut chart
- Issue distribution by customer segment (if segment data available)
- Seasonal pattern calendar heatmap

**Churn Signals Tab:**

- For queries #111-116
- Churn risk distribution (low / medium / high) stacked bar
- **Risk Factor Radar** — Spider chart showing contributing factors per at-risk account
- Repeat contact rate trend
- "Customers expressing cancellation intent" real-time list
- Declining CSAT accounts table with contact history sparkline

#### Creative Design Elements

1. **Knowledge Gap → Article Draft Pipeline** — When a gap is detected, show a "Generate Draft" button that triggers an `llm_evaluate` pipeline with a "draft-article" tag, using the agent's successful resolution as training data. The drafted article appears in a preview panel.

2. **Intent Shift Animation** — A Sankey-like animated flow showing how intent distribution changed from last month to this month. New intents appear with a "glow" effect. Disappearing intents fade out.

3. **Churn Heatmap Calendar** — A GitHub-style contribution calendar where each day's color = average churn risk score across all active customers. Darker red = more at-risk day. Clicking a day shows the at-risk accounts.

---

### 6.5 Experiments (A/B Testing & Versioning)

**New page (frontend only — backend API and models ALREADY EXIST)**
**Answers queries:** #155-162 + #226-233 (Experimentation, Optimization Workflow)
**Primary persona:** Anyone running experiments

> **Existing backend:** `ExperimentModel` (MongoDB) + `/api/projects/:projectId/experiments` routes already provide full CRUD, start/stop lifecycle, `/:id/results` (session counts by group from ClickHouse), and `/:id/timeseries` (daily breakdown). The work here is **building the Studio UI** and **enhancing the results endpoints** to join `conversation_outcomes` + `quality_evaluations` for richer experiment metrics (containment, CSAT, cost comparisons — not just session counts).

#### KPI Cards

| Card                     | Metric                                     | Source                                         |
| ------------------------ | ------------------------------------------ | ---------------------------------------------- |
| Active Experiments       | Distinct experiment_id with recent traffic | experiment_assignments                         |
| Best Variant             | Highest containment group                  | experiment_assignments + conversation_outcomes |
| Statistical Significance | p-value < 0.05 count                       | Computed                                       |
| Active Eval Runs         | Recent eval runs                           | eval_scores                                    |
| Avg Eval Score           | avg across latest run                      | eval_scores                                    |
| Improvement Velocity     | Quality score change rate                  | quality_evaluations trend                      |

#### Tabs

**Experiments Tab:**

- Experiment list with status (running / concluded / significant)
- **Experiment Detail Panel:**
  - Side-by-side KPI comparison: control vs experiment (containment, CSAT, cost)
  - **Significance Indicator** — Green check when p < 0.05, amber spinner when still collecting data, with confidence interval bars
  - Time series: metric over time for both groups
  - Recommendation: "Roll out" / "Keep testing" / "Revert" based on significance + guardrails
  - Sample size progress bar

**Eval Runs Tab:**

- List of eval runs with aggregate scores
- **Eval Heatmap** — rows = evaluators, columns = personas/scenarios, cells = scores. Uses `mv_eval_heatmap_dest`. Color-coded red-to-green.
- Score trend over time (from `mv_eval_score_trend_dest`)
- Per-evaluator summary table with pass rate, avg score, P5/P50/P95

**Simulation Tab:**

- For queries #228-233
- Simulation configuration (select pipeline, define variant)
- Simulation results: before/after comparison table
- Gap tracking: which improvements are holding up in production (eval_production_scores trend)

**Optimization Workflow Tab:**

- For queries #226-233
- **Impact-Priority Matrix** — Scatter plot: X = volume affected, Y = potential improvement. Top-right quadrant = highest impact fixes. Data from knowledge_gap + quality_evaluations + friction_detections.
- Gap closure tracking: stacked bar showing open vs closed gaps over time
- Improvement velocity: quality score slope per month

#### Creative Design Elements

1. **"Should We Ship?" Card** — A single prominent card per experiment that synthesizes statistical significance, quality guardrails, and minimum sample size into a clear Yes/No/Wait recommendation with reasoning. Inspired by Eppo and LaunchDarkly's experiment decision panels.

2. **Version Timeline** — A horizontal timeline showing agent versions with traffic split annotations. Each version node shows key metrics. Lines between versions show improvement/degradation. Click to see the diff.

---

### 6.6 Alerts & Watchtower (Proactive)

**New page (frontend only — backend API, MongoDB model, and evaluation service ALREADY EXIST)**
**Answers queries:** #190-200 (Proactive Alerts & Notifications)
**Primary persona:** Operations teams

> **Existing backend:** Full alert infrastructure is already implemented:
>
> - `AlertRuleModel` (MongoDB `alert_rules` collection) with fields: metric, sourceTable, aggregation (avg/sum/count/min/max/p95/p99), windowMinutes, condition (gt/lt/gte/lte), threshold, cooldownMinutes, channels (slack/email/webhook), status (ok/firing/cooldown)
> - `/api/projects/:projectId/alerts` — CRUD + `/:alertId/history` + `/:alertId/test` (test-fires against live ClickHouse)
> - `/api/tenants/:tenantId/alerts` — tenant-scoped alert config (usage_threshold, credit_low, health_degraded, feature_limit)
> - `AlertEvaluator` Restate activity service — periodic evaluation against ClickHouse, cooldown management
> - 8 pre-configured eval alert templates in `eval-alerts.ts`
>
> The work here is **building the Studio UI** to surface these existing capabilities and potentially adding the preconfigured alert rules table below as seed data.

#### Design

- **Active Alerts Panel** — Real-time list of triggered alerts with severity badges (critical/warning/info)
- **Alert Configuration** — Threshold editor for each metric (e.g., "Containment rate drops > 10% in 1h window")
- **Alert History Timeline** — Chronological view of past alerts with duration and resolution
- **Anomaly Detection Dashboard** — From `anomaly_detections` table: flagged metrics with z-scores, severity, trend overlays

#### Alert Rules (preconfigured)

| Alert                    | Trigger                               | Source Table                      | Window     |
| ------------------------ | ------------------------------------- | --------------------------------- | ---------- |
| Containment Drop         | Rate > 10% below baseline             | conversation_outcomes             | 1h         |
| Escalation Spike         | Rate > 15% above normal               | conversation_outcomes             | 30m        |
| Error Rate               | > 5%                                  | platform_events_error_hourly_dest | 15m        |
| Latency Spike            | P95 > 10s                             | llm_metrics                       | 5m         |
| Negative Sentiment Spike | Rate > 40%                            | conversation_sentiment            | 1h         |
| Hallucination Spike      | Rate > 10%                            | hallucination_evaluations         | 1h         |
| Repeat Contacts          | 3+ in 7 days for same customer+intent | platform_events                   | 7d rolling |
| Budget Alert             | Projected spend > 120% of budget      | llm_metrics                       | Daily      |

**Implementation**: The `AlertEvaluator` Restate activity service already handles periodic evaluation. Enhancement: add the preconfigured rules above as seed data via the existing `POST /alerts` API. For anomaly-based alerts, the existing `compute-statistical` pipeline writes to `anomaly_detections`. The alerts page reads from `AlertRuleModel` (MongoDB) for config and `anomaly_detections` (ClickHouse) for anomaly dashboard.

---

### 6.7 Compliance & Audit

**New page under "Operate" group**
**Answers queries:** #219-225 (Compliance, Audit)
**Primary persona:** Legal, compliance, security

- **Audit Trail Explorer** — Full-text search over `audit_events` with filters: action, actor, resource, time range
- **Conversation Audit** — For query #219: given a conversation ID, show complete lifecycle (all events, tool calls, handoffs, state changes from `platform_events` + `messages`)
- **Data Access Log** — From `kms_audit_log` + `audit_events`: who accessed what data and when
- **Compliance Dashboard** — PII exposure events count, regulatory disclosure rate, data retention status
- **Export** — Filtered conversation export (CSV/JSON) by tag, intent, date range

---

### 6.8 Ask AI (Conversational Analytics)

**New page (frontend only — backend NL-to-SQL pipeline ALREADY EXISTS)**
**Answers queries:** #163-189 (Natural Language analytics)
**Primary persona:** All personas

> **Existing backend:** The complete NL-to-SQL pipeline is already implemented:
>
> - `NLQueryService` (`packages/pipeline-engine/src/pipeline/services/nl-query.service.ts`) — LLM-based SQL generation with validation (SELECT-only, mandatory tenant_id filter, forbidden DDL/DML patterns), 30s timeout, returns `{ question, sql, data, rowCount }`
> - `semantic-layer.ts` — comprehensive schema context covering 22 tables with column-level metadata, descriptions, and example queries (~2KB rendered)
> - `POST /api/projects/:projectId/nl-analytics/ask` — already mounted and operational
>
> The work here is **building the Studio chat UI**, adding chart auto-selection, conversation memory for follow-up queries, and the "Pin to Dashboard" feature. The backend NL-to-SQL service needs no changes for basic functionality.

#### Architecture (leveraging existing NLQueryService)

```
User types question in Studio chat UI
  ↓
Studio proxies to existing POST /nl-analytics/ask
  ↓
NLQueryService:
  1. getSemanticLayerPrompt() → LLM context (22 tables, column metadata)
  2. createPipelineLLMClient() → LLM generates SQL
  3. validateSQL() → SELECT-only, tenant_id required, forbidden patterns
  4. Execute against ClickHouse (30s timeout)
  ↓
Results returned: { question, sql, data, rowCount }
  ↓
Frontend: auto-select chart type + render data table
  ↓
User can refine ("break that down by agent", "show last month instead")
```

#### Frontend Enhancements Needed (backend already handles items 1-3)

1. ~~Schema Context~~ — **Already exists** in `semantic-layer.ts`
2. ~~Query Translation~~ — **Already exists** in `NLQueryService` (generates raw SQL, not structured JSON — works, but less controllable)
3. ~~Safety~~ — **Already exists** — `validateSQL()` enforces SELECT-only, tenant_id injection, forbidden patterns
4. **Chart Auto-Selection** (NEW): Based on the query result shape: single value → KPI card, time series → line chart, breakdown → bar chart, distribution → histogram, comparison → grouped bar.
5. **Conversation Memory** (NEW): Follow-up queries inherit context from prior queries (time range, filters, breakdown dimension). Requires frontend state + passing conversation history to the LLM.

#### UI

- Chat-style input at bottom
- Results appear above as cards (chart + data table + "Showing: [description of query]")
- Suggested follow-ups as chips below results
- "Pin to Dashboard" button to save a query as a reusable widget

#### Creative Design Elements

1. **"Thinking" Animation** — While the LLM processes the query, show a subtle animation of the query being decomposed: "Understanding question → Identifying tables → Building query → Executing → Rendering." Inspired by Perplexity's search steps.

2. **Suggested Questions** — On empty state, show persona-specific suggested questions based on which page the user came from. If they came from Agent Performance, suggest agent-related questions.

---

## 7. API Layer Design

### 7.1 API Endpoints — New vs Existing

The existing `pipeline-analytics` API covers single-pipeline queries well. Several other routes already exist. The table below distinguishes **truly new** endpoints from endpoints that should **wire to existing routes**.

#### `/api/projects/:projectId/insights` Routes (NEW — cross-pipeline composite queries)

| Endpoint                                  | Status           | Purpose                                                                    | Tables Queried                                                                 |
| ----------------------------------------- | ---------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `GET /at-a-glance`                        | **NEW**          | Executive KPIs (containment, CSAT, savings, volume, escalation, sentiment) | conversation_outcomes + conversation_sentiment + llm_metrics + platform_events |
| `GET /at-a-glance/trends`                 | **NEW**          | Multi-metric time series                                                   | Same + MVs                                                                     |
| `GET /at-a-glance/roi`                    | **USE EXISTING** | ROI calculations — **wire to existing `GET /roi/summary`**                 | conversation_outcomes + llm_metrics                                            |
| `GET /agent-comparison`                   | **NEW**          | All agents side-by-side                                                    | quality_evaluations + conversation_outcomes + platform_events                  |
| `GET /agent/:agentName/detail`            | **NEW**          | Single agent deep dive                                                     | All tables filtered by agent_name                                              |
| `GET /agent/:agentName/flow`              | **NEW**          | AOP flow analysis (Sankey data)                                            | platform_events + messages                                                     |
| `GET /quality/overview`                   | **NEW**          | Quality distribution + flagged rate                                        | quality_evaluations + hallucination_evaluations + guardrail_evaluations        |
| `GET /quality/friction`                   | **NEW**          | Friction metrics                                                           | friction_detections + conversation_sentiment                                   |
| `GET /quality/guardrails`                 | **NEW**          | Guardrail effectiveness                                                    | guardrail_evaluations                                                          |
| `GET /customer/knowledge-gaps`            | **NEW**          | KB gap analysis                                                            | knowledge_gap_evaluations                                                      |
| `GET /customer/intents`                   | **NEW**          | Intent distribution + drivers                                              | intent_classifications + conversation_outcomes                                 |
| `GET /customer/churn`                     | **NEW**          | Churn risk dashboard                                                       | churn_risk_scores + customer_predictive_features                               |
| `GET /customer/mentions`                  | **NEW**          | Competitor/feature mentions                                                | conversation_mentions                                                          |
| `GET /compliance/audit-trail`             | **NEW**          | Audit event search                                                         | audit_events                                                                   |
| `GET /compliance/conversation/:sessionId` | **NEW**          | Full conversation audit                                                    | platform_events + messages + audit_events                                      |

#### Existing Routes to Wire (NOT in `/insights/*` — already mounted)

| Existing Endpoint                                         | Mount Path                                 | Wire to Page        | Enhancement Needed                                                               |
| --------------------------------------------------------- | ------------------------------------------ | ------------------- | -------------------------------------------------------------------------------- |
| `GET /experiments`, `GET /experiments/:id/results`        | `/api/projects/:projectId/experiments`     | Experiments page    | **ENHANCE**: join conversation_outcomes + quality_evaluations for richer metrics |
| `GET /alerts`, `POST /alerts`, etc.                       | `/api/projects/:projectId/alerts`          | Alerts page         | **None** — full CRUD + history + test-fire already exists                        |
| `GET /roi/summary`, `POST /roi/simulate`                  | `/api/projects/:projectId/roi`             | At a Glance ROI tab | **None** — ROICalculator already computes all needed KPIs                        |
| `POST /nl-analytics/ask`                                  | `/api/projects/:projectId/nl-analytics`    | Ask AI page         | **ENHANCE**: add conversation memory, chart type hint in response                |
| `POST /external-events`, `GET /external-events/correlate` | `/api/projects/:projectId/external-events` | Trends tab markers  | **None** — ingestion + correlation already exists                                |

### 7.2 New Studio Proxy Routes

```
apps/studio/src/app/api/insights/[...path]/route.ts
  → proxies to RUNTIME_URL/api/projects/:projectId/insights/*

apps/studio/src/app/api/alerts/[...path]/route.ts
  → proxies to RUNTIME_URL/api/projects/:projectId/alerts/*
```

### 7.3 SWR Hooks — New and Existing

> **Existing hooks** (already implemented in `apps/studio/src/hooks/`):
>
> - `useInsightsDashboard` (`useInsightsDashboard.ts`) — fetches session-metrics + cost-breakdown for current InsightsDashboardPage
> - `useEventCounts`, `useSessionMetrics`, `useCostBreakdown`, `useAnalyticsEvents`, `useAggregateMetrics`, `useTenantUsage` (`useAnalytics.ts`) — general analytics hooks via EventQueryService
> - `useVoiceAnalytics` (`useVoiceAnalytics.ts`) — voice MV summary + hourly
> - `useAnalyticsQuery` (`useAnalyticsQuery.ts`) — developer SQL queries
>
> **None of these call `pipeline-analytics` endpoints.** The proxy is at `apps/studio/src/app/api/runtime/analytics/route.ts` → runtime `/analytics/:endpoint`.

```typescript
// NEW: apps/studio/src/hooks/useInsights.ts (cross-pipeline composite queries)

export function useAtAGlance(timeRange: TimeRange) { ... } // replaces useInsightsDashboard
export function useAtAGlanceTrends(timeRange: TimeRange) { ... }
export function useROI(timeRange: TimeRange) { ... } // wire to existing GET /roi/summary
export function useAgentComparison(timeRange: TimeRange) { ... }
export function useAgentDetail(agentName: string, timeRange: TimeRange) { ... }
export function useAgentFlow(agentName: string, timeRange: TimeRange) { ... }
export function useQualityOverview(timeRange: TimeRange) { ... }
export function useFrictionMetrics(timeRange: TimeRange) { ... }
export function useGuardrailMetrics(timeRange: TimeRange) { ... }

// NEW: apps/studio/src/hooks/useCustomerInsights.ts

export function useKnowledgeGaps(timeRange: TimeRange) { ... }
export function useIntentAnalysis(timeRange: TimeRange) { ... }
export function useChurnRisk(timeRange: TimeRange) { ... }
export function useMentions(timeRange: TimeRange) { ... }

// NEW: apps/studio/src/hooks/useExperiments.ts
// Wire to existing GET /experiments, GET /experiments/:id/results, GET /experiments/:id/timeseries

export function useExperiments(timeRange: TimeRange) { ... }
export function useExperimentDetail(experimentId: string) { ... }

// NEW: apps/studio/src/hooks/useAlerts.ts
// Wire to existing GET /alerts, GET /alerts/:id/history, POST /alerts/:id/test

export function useActiveAlerts() { ... }
export function useAlertConfig() { ... }
export function useAlertHistory(timeRange: TimeRange) { ... }

// NEW: apps/studio/src/hooks/useAskAI.ts
// Wire to existing POST /nl-analytics/ask

export function useAskAI(question: string) { ... }
```

---

## 8. Suggested Pipeline & UI Changes

### 8.1 Pipeline Engine Changes

#### No New Node Types Needed

After analysis, the three originally proposed node types (`compute-containment`, `compute-cost-attribution`, `compute-routing-accuracy`) are **not needed**. The data required for all 233 customer queries already exists in ClickHouse tables written by existing pipeline nodes. The metrics these nodes would have produced are better handled at query time:

| Originally Proposed        | Why Not Needed                                                                                                                                                                                                                                                                                                                                                                      | Query-Time Alternative                                                 |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `compute-containment`      | Containment rate = `countIf(outcome='resolved') / count(*)` from `conversation_outcomes` (written by existing `compute-quality` node). No join required — both numerator and denominator come from the same table. MV `mv_daily_outcomes` already pre-aggregates by outcome.                                                                                                        | `ClickHouseQueryService` computes rates from `conversation_outcomes`   |
| `compute-cost-attribution` | Cost per resolution by agent/intent is a query-time join of `llm_metrics` + `conversation_outcomes` + `intent_classifications`. ClickHouse handles 3-table joins efficiently with partition pruning on `(tenant_id, toYYYYMM(...))`. If performance becomes an issue, add a materialized view — cheaper than a pipeline node (no LLM cost, no Restate overhead, always up-to-date). | `ClickHouseQueryService` joins `llm_metrics` + `conversation_outcomes` |
| `compute-routing-accuracy` | Routing accuracy (#211) requires judgment ("did the supervisor pick the right agent?"). This is exactly what `llm-evaluate` is designed for — use it with `tag: 'routing_accuracy'`. Writes to `llm_evaluate` table with the existing `mv_daily_llm_evaluate` MV. Context preservation (#213-214) already covered by `context_evaluations`.                                         | `llm-evaluate` node with `tag: 'routing_accuracy'` in a pipeline       |

**Design principle**: Don't create pipeline nodes for what can be computed at query time. Pipeline nodes should only exist when they need to:

- Call an LLM (evaluation, classification, generation)
- Write data that doesn't exist yet (new analysis types)
- Perform stateful/sequential computation that can't be expressed as SQL

#### A. Enhance `llm_evaluate` to Support Multi-Tag Evaluation

The current `llm_evaluate` node writes one row per tag per conversation. For the "Ask AI" feature and custom evaluations, we should support:

- Batch evaluation of multiple tags in a single LLM call (cost optimization)
- Structured output validation against per-tag schemas
- Tag dependency chains (e.g., "extract intent, then evaluate quality based on that intent")

#### B. New Builtin Pipeline: `executive-summary`

A weekly pipeline that generates a natural language executive summary (answering query #9) by:

1. `db-query` → fetch aggregated containment/escalation rates from `conversation_outcomes` for past 7 days
2. `db-query` → fetch cost summary from `llm_metrics` for past 7 days
3. `llm-evaluate` with tag "executive_summary" → LLM generates natural language summary from the aggregated data
4. `store-insight` → stored for dashboard display

Note: Steps 1-2 use the existing `db-query` node to pull pre-computed aggregates. No custom node types needed.

#### C. ~~New Builtin Pipeline: `alert-monitor`~~ → ALREADY EXISTS as `AlertEvaluator`

> **Note:** The `AlertEvaluator` Restate activity service (`packages/pipeline-engine/src/pipeline/services/alert-evaluator.service.ts`) already implements periodic alert evaluation: loads enabled AlertRules from MongoDB, queries ClickHouse for each rule's metric within its time window, evaluates conditions, respects cooldowns, and updates statuses. The work here is ensuring the `anomaly_detections` table (written by `compute-statistical` pipeline) feeds into the alert page's anomaly dashboard, and adding any missing preconfigured alert rule seeds.

Enhancement (if needed beyond existing AlertEvaluator):

1. ~~Runs statistical checks~~ → existing `compute-statistical` pipeline writes to `anomaly_detections`
2. ~~Compares against configured thresholds~~ → existing `AlertEvaluator` does this via AlertRuleModel
3. ~~Triggers notifications~~ → existing `AlertEvaluator` supports slack/email/webhook channels
4. Stores results in `anomaly_detections` → existing

### 8.2 New ClickHouse Tables

| Table                        | Purpose                                 | Written By             | Status                                                            |
| ---------------------------- | --------------------------------------- | ---------------------- | ----------------------------------------------------------------- |
| ~~`alert_rules` (MongoDB)~~  | Alert threshold configurations          | Alert config API       | **ALREADY EXISTS** — `AlertRuleModel` in `alert_rules` collection |
| `alert_history` (ClickHouse) | Triggered alert history with resolution | alert-monitor pipeline | NEW                                                               |

No new per-node-type tables needed. Containment, cost attribution, and routing accuracy are computed at query time from existing tables (`conversation_outcomes`, `llm_metrics`, `llm_evaluate`).

### 8.3 New Materialized Views

| MV                        | Source                 | Aggregation                                       |
| ------------------------- | ---------------------- | ------------------------------------------------- |
| `mv_hourly_alert_metrics` | Multiple source tables | Rolling window metrics for alert threshold checks |

No new daily MVs needed. Containment rates use the existing `mv_daily_outcomes`. Cost breakdown uses `llm_metrics_daily_dest`. Routing accuracy uses `mv_daily_llm_evaluate` (filtered by `tag = 'routing_accuracy'`).

### 8.4 Pipeline Editor UI Changes

#### A. Pipeline Results Preview

Currently, after a pipeline runs, there's no way to see results in the editor. Add a **"Run Results" tab** to the Pipeline Editor that:

- Shows the last N pipeline run results
- Displays per-node output in a table/JSON viewer
- Links to the appropriate Insights page for that pipeline type

#### B. Node Output Preview

When editing a node, show a preview of the last execution's output for that node:

- Summary statistics (row count, avg score, etc.)
- Sample rows (first 5)
- Link to "View all in Analytics"

#### C. Pipeline → Insights Link

On each Insights page, add a "Powered by [Pipeline Name]" badge that links back to the pipeline editor. This creates a two-way navigation between configuration and results.

#### D. Custom Dashboard Builder (Phase 2)

For power users who want to pin specific charts from any page:

- "Pin to Dashboard" button on every chart
- Custom dashboard page where pinned charts are laid out in a grid
- Drag-and-drop reorder
- Auto-refresh at configurable intervals

---

## 9. Charting Strategy

### 9.1 Library Decision: Recharts + Custom SVG

We stick with **recharts v3** (already in `package.json`) for standard charts and build custom SVG components for specialized visualizations. This avoids adding a second charting library and keeps the bundle small.

| Chart Type       | Implementation                                      | Used For                                      |
| ---------------- | --------------------------------------------------- | --------------------------------------------- |
| Line/Area/Bar    | recharts `<LineChart>`, `<AreaChart>`, `<BarChart>` | Time series, trends, distributions            |
| Stacked Area/Bar | recharts with stacked prop                          | Outcome distribution, cost breakdown          |
| Dual Y-Axis      | recharts `<ComposedChart>` with two `<YAxis>`       | Volume + Rate overlays                        |
| Pie/Donut        | recharts `<PieChart>`                               | Sentiment distribution, outcome split         |
| Radar/Spider     | recharts `<RadarChart>`                             | Quality dimension breakdown per agent         |
| Funnel           | Custom SVG                                          | AOP drop-off funnel                           |
| Heatmap          | Custom SVG (grid of colored rects)                  | Agent × metric matrix, eval heatmap, calendar |
| Sankey           | Custom SVG using d3-sankey layout                   | Conversation flow, routing, intent flow       |
| Gauge/Ring       | Custom SVG (arc path)                               | Target tracking, containment goal             |
| Sparkline        | recharts `<LineChart>` minimal (no axes)            | Embedded in KPI cards and table rows          |
| Slope Chart      | Custom SVG (lines connecting two columns)           | Before/after comparison                       |

### 9.2 New Package: `d3-sankey` (Phase 2)

The only new dependency needed: `d3-sankey` (12KB gzipped) for Sankey diagram layout computation. The rendering is done with custom SVG + Framer Motion for animation. **Add this in Phase 2** when building the Agent Performance page — not in Phase 1.

```bash
pnpm add d3-sankey @types/d3-sankey --filter @abl/studio
```

### 9.3 Color System

Extend the existing `CHART_COLORS` from `analytics/shared.tsx`:

```typescript
const INSIGHT_COLORS = {
  // Status colors (for KPI card borders and status indicators)
  healthy: 'hsl(142, 71%, 45%)', // green
  warning: 'hsl(38, 92%, 50%)', // amber
  critical: 'hsl(0, 84%, 60%)', // red
  neutral: 'hsl(220, 14%, 46%)', // gray

  // Sentiment colors
  positive: 'hsl(142, 71%, 45%)', // green
  negative: 'hsl(0, 84%, 60%)', // red
  mixed: 'hsl(38, 92%, 50%)', // amber

  // Outcome colors
  resolved: 'hsl(142, 71%, 45%)', // green
  escalated: 'hsl(38, 92%, 50%)', // amber
  abandoned: 'hsl(0, 84%, 60%)', // red

  // Sequential scale (for heatmaps) — use colorblind-safe blue-to-orange diverging scale
  // (Section 12.2 mandates colorblind-safe palette; red-green scales removed)
  scale: ['hsl(220, 70%, 70%)', 'hsl(45, 10%, 85%)', 'hsl(25, 85%, 55%)'], // blue → neutral → orange (colorblind-safe)
  scaleBlue: ['hsl(220, 70%, 95%)', 'hsl(220, 70%, 50%)', 'hsl(220, 70%, 25%)'], // light → dark blue (sequential)

  // Categorical (for multi-series charts, up to 8)
  categorical: [
    'hsl(220, 70%, 50%)', // blue
    'hsl(280, 65%, 55%)', // purple
    'hsl(142, 71%, 45%)', // green
    'hsl(38, 92%, 50%)', // amber
    'hsl(0, 84%, 60%)', // red
    'hsl(200, 70%, 50%)', // cyan
    'hsl(330, 70%, 55%)', // pink
    'hsl(50, 90%, 50%)', // yellow
  ],
};
```

---

## 10. Performance & Caching Strategy

### 10.1 Redis Cache Tiers

> **Caching gap:** The existing `AnalyticsCache` (Redis, fail-open, key format `analytics:{tenantId}:{projectId}:{pipeline}:{queryType}:{hash}`) is currently **only used by `pipeline-analytics.ts`**. The general `analytics.ts`, `voice-analytics.ts`, `nl-analytics.ts`, `experiments.ts`, `alerts.ts`, and `roi.ts` routes query ClickHouse/MongoDB directly with **no Redis caching**. Phase 1 must extend `AnalyticsCache` to the new `/insights/*` routes. Existing uncached routes should be evaluated for caching in Phase 2.

| Data Type           | TTL    | Invalidation                   | Rationale                                     |
| ------------------- | ------ | ------------------------------ | --------------------------------------------- |
| At-a-Glance KPIs    | 5 min  | After batch pipeline completes | Balance freshness vs query cost               |
| Trend Time Series   | 10 min | After batch pipeline completes | Historical data changes slowly                |
| Breakdown Tables    | 5 min  | After batch pipeline completes | Moderate query cost                           |
| Conversation Lists  | 5 min  | After new evaluations written  | Pagination state doesn't need to be real-time |
| Conversation Detail | 1 hr   | Never (immutable once written) | Single-session data doesn't change            |
| Alert Status        | 30 sec | On alert state change          | Needs near-real-time for critical alerts      |
| Experiments         | 5 min  | After new assignment data      | Statistical significance needs fresh data     |
| Ask AI results      | 10 min | Per unique query hash          | NL queries are expensive (LLM + ClickHouse)   |

### 10.2 Frontend Caching (SWR)

```typescript
// Default SWR config for insights hooks
const insightsSWRConfig = {
  revalidateOnFocus: false, // Don't refetch on tab switch
  revalidateOnReconnect: true, // Refetch on network recovery
  dedupingInterval: 30000, // Dedup identical requests within 30s
  refreshInterval: 300000, // Auto-refresh every 5 min
  errorRetryCount: 3,
  errorRetryInterval: 5000,
};

// For alerts (near real-time)
const alertsSWRConfig = {
  ...insightsSWRConfig,
  refreshInterval: 30000, // Refresh every 30s
};
```

### 10.3 ClickHouse Query Optimization

1. **Always prefer MVs** — For summary/timeseries queries, route to materialized views first. MVs are pre-aggregated and orders of magnitude faster.
2. **Partition pruning** — All queries include `tenant_id` (partition key) + date range to limit scanned partitions.
3. **Skip indices** — The analytics tables have bloom filter and minmax skip indices on frequently filtered columns (intent, flagged, outcome, score).
4. **FINAL keyword sparingly** — Only use `FINAL` for ReplacingMergeTree queries that need deduplication. For aggregate queries, duplicate rows are acceptably rare and self-correct.
5. **Limit result sets** — All breakdown queries have `LIMIT 50`. Conversation lists max 200 per page. Ask AI queries capped at 10,000 rows.
6. **Async queries** — For heavy queries (Ask AI, cross-table joins), use async ClickHouse queries and poll for results.

### 10.4 Data Freshness Indicators

Every insight page shows a "Last updated: X minutes ago" indicator in the page header. This reads the latest `processed_at` timestamp from the relevant table. If data is stale (>1 hour for batch pipelines), show an amber warning with "Pipeline may not be running."

---

## 11. Implementation Priority

### Phase 1: Foundation + At a Glance (Weeks 1-3)

**Why first**: Answers the most common executive questions (#1-17), validates the data access pattern, and builds the reusable component library.

1. `ClickHouseQueryService` with metric registry
2. `/api/projects/:projectId/insights` routes (at-a-glance endpoints)
3. Studio proxy routes + SWR hooks
4. Shared components: `InsightKPICard`, `TimeSeriesChart`, `BreakdownTable`, `FilterBar`
5. "At a Glance" page with Overview + Trends + ROI tabs
6. Upgrade `InsightsDashboardPage` to use pipeline analytics data

### Phase 2: Quality & Agent Performance (Weeks 4-6)

**Why second**: These are the most requested "Coming Soon" pages. Agent Performance is critical for agent designers (daily users). Quality/Watchtower is critical for QA (daily users).

1. Agent Performance page (Comparison + Detail + Tool Analysis)
2. Quality & Safety page (Quality + Sentiment + Friction + Guardrails)
3. New components: `HeatmapGrid`, `DistributionChart`, `ConversationExplorer`
4. `SankeyFlow` component for AOP flow analysis
5. Wire up conversation drill-down across all pages

### Phase 3: Customer Insights + Alerts (Weeks 7-9)

1. Customer Insights page (Knowledge Gaps + Intent + VoC + Churn)
2. Alerts & Watchtower page (Alert config + Active alerts + History)
3. New builtin pipeline: `alert-monitor` (using existing `compute-statistical` + `evaluate-metrics` + `send-notification` nodes)
4. New components: `SankeyFlow` (intent flow), `GapTreemap`
5. `alert_history` ClickHouse table + `mv_hourly_alert_metrics` MV

### Phase 4: Experiments + Compliance (Weeks 10-11)

1. Experiments page (A/B testing + Eval runs + Optimization)
2. Compliance & Audit page
3. New component: `ComparisonChart` with statistical significance
4. Wire eval tables MVs to experiment dashboards

### Phase 5: Ask AI (Week 12+)

1. NL query translation service (LLM integration)
2. Ask AI page with chat UI
3. Auto chart selection
4. Follow-up query context
5. "Pin to Dashboard" feature

### Phase 6: Polish & Advanced (Ongoing)

1. Custom dashboard builder
2. Pipeline editor → Insights bidirectional navigation
3. Real-time WebSocket updates for alerts
4. PDF/CSV export for all pages
5. Scheduled report emails (executive summary)

---

## Appendix: Query-to-Page Mapping

### At a Glance Page

| Query # | Question Summary               | Tab            | Visualization               |
| ------- | ------------------------------ | -------------- | --------------------------- |
| 1       | Overall containment rate       | KPI Card       | Gauge + sparkline           |
| 2       | Cost savings vs human-only     | KPI Card + ROI | Currency card + stacked bar |
| 3       | CSAT score + month comparison  | KPI Card       | Score + trend arrow         |
| 4       | Total conversations this week  | KPI Card       | Count + sparkline           |
| 5       | Deflection rate vs containment | KPI Card       | Dual metric card            |
| 6       | On track vs quarterly target   | Overview       | Target ring gauge           |
| 7       | AI CSAT vs human CSAT          | Overview       | Side-by-side bar            |
| 8       | Cost per resolved vs escalated | ROI            | Grouped bar                 |
| 9       | Executive summary              | Overview       | AI-generated text card      |
| 10      | True cost including rework     | ROI            | Calculated KPI              |
| 11-17   | Trend queries                  | Trends         | Multi-series line chart     |
| 18-24   | ROI queries                    | ROI            | Stacked bar + line + table  |

### Agent Performance Page

| Query # | Question Summary              | Tab           | Visualization                                         |
| ------- | ----------------------------- | ------------- | ----------------------------------------------------- |
| 25-32   | Agent comparison queries      | Comparison    | Heatmap table + ranking                               |
| 33-36   | AOP flow analysis             | Agent Detail  | Sankey diagram + funnel                               |
| 37-38   | Escalation drivers            | Agent Detail  | Stacked bar (deflected/escalated-AOP/escalated-other) |
| 39-40   | Persona/guardrail consistency | Reasoning     | Score trend + flagged list                            |
| 41-48   | Tool usage queries            | Tool Analysis | Table + bar chart                                     |
| 49-53   | Extraction queries            | Reasoning     | Per-field bar + efficiency chart                      |
| 54-58   | Reasoning/decision queries    | Reasoning     | Calibration chart + routing matrix                    |

### Quality & Safety Page

| Query # | Question Summary     | Tab                | Visualization                           |
| ------- | -------------------- | ------------------ | --------------------------------------- |
| 59-67   | Quality monitoring   | Quality Overview   | Histogram + trend + breakdown           |
| 68-75   | Friction detection   | Friction           | Score distribution + indicators         |
| 76-80   | Sentiment analysis   | Sentiment          | Distribution + pivot heatmap + recovery |
| 81-85   | Guardrail monitoring | Guardrail & Safety | Effectiveness table + severity bar      |

### Customer Insights Page

| Query # | Question Summary        | Tab               | Visualization                                            |
| ------- | ----------------------- | ----------------- | -------------------------------------------------------- |
| 86-94   | Knowledge gap queries   | Knowledge Gaps    | Treemap + citation trend + article table                 |
| 95-103  | Intent/topic queries    | Intent Analysis   | Distribution bar + drivers table + co-occurrence heatmap |
| 104-110 | VoC queries             | Voice of Customer | Mention timeline + request list + root cause donut       |
| 111-116 | Churn/retention queries | Churn Signals     | Risk distribution + radar + repeat contact trend         |

### Experiments Page

| Query # | Question Summary         | Tab          | Visualization                                    |
| ------- | ------------------------ | ------------ | ------------------------------------------------ |
| 155-162 | A/B testing + versioning | Experiments  | Side-by-side comparison + significance indicator |
| 226-233 | Optimization workflow    | Optimization | Impact matrix + gap tracking + velocity chart    |

### Other Pages

| Query # | Page                                                              | Visualization                             |
| ------- | ----------------------------------------------------------------- | ----------------------------------------- |
| 117-137 | Customer Insights (telco intents) or At a Glance (filtered)       | Intent-specific breakdowns                |
| 138-154 | Existing Analytics (LLM Performance tab) — enhance, don't rebuild | Latency/cost/error charts                 |
| 163-189 | Ask AI                                                            | Dynamic charts based on NL query          |
| 190-200 | Alerts & Watchtower                                               | Alert list + anomaly dashboard            |
| 201-210 | Voice Analytics (existing — enhance)                              | Voice-specific metrics                    |
| 211-218 | Agent Performance (Multi-Agent sub-tab)                           | Routing heatmap + context scores          |
| 219-225 | Compliance & Audit                                                | Audit trail explorer + conversation audit |

---

## Summary of Changes Required

### New Code (Frontend-Only Unless Noted)

| Area                      | Items                                                                                                                                                                        |
| ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **New pages**             | At a Glance (replace), Agent Performance, Quality & Safety, Customer Insights, Experiments (UI only), Alerts (UI only), Compliance, Ask AI (UI only)                         |
| **New components**        | InsightKPICard, TimeSeriesChart, BreakdownTable, DistributionChart, HeatmapGrid, SankeyFlow, ComparisonChart, ConversationExplorer, FilterBar, TargetGauge                   |
| **New API routes**        | `/insights/*` (15 cross-pipeline composite endpoints). **NOT new:** `/alerts/*`, `/experiments/*`, `/roi/*`, `/nl-analytics/ask`, `/external-events/*` — these already exist |
| **New SWR hooks**         | ~20 hooks across useInsights, useCustomerInsights, useExperiments, useAlerts, useAskAI — many wire to existing backend routes                                                |
| **New proxy routes**      | insights catch-all proxy only. Alerts proxy may already exist or can use existing runtime proxy pattern                                                                      |
| **New builtin pipelines** | executive-summary (weekly, uses existing nodes)                                                                                                                              |
| **New ClickHouse tables** | alert_history (1 table)                                                                                                                                                      |
| **New MVs**               | mv_hourly_alert_metrics (1 MV)                                                                                                                                               |
| **New service**           | ClickHouseQueryService with metric registry (complements existing NLQueryService + semantic layer — see Section 3.3)                                                         |
| **New dependency**        | d3-sankey (~12KB, Phase 2 only)                                                                                                                                              |

**No new pipeline node types needed.** Containment/cost/routing metrics computed at query time from existing tables. Routing accuracy evaluation uses `llm-evaluate` with a tag.

**Key realization from codebase audit:** The backend is even more mature than initially assessed. Alerts (full CRUD + evaluator), experiments (CRUD + lifecycle + results), ROI (calculator + simulation), NL analytics (NL-to-SQL + semantic layer), and external events (ingestion + correlation) are all fully operational with zero Studio frontend. The primary work is **building the presentation layer**.

### Existing Backend to Wire (No API Changes Needed)

| Existing Service                | Existing Route                            | Wire to Page        |
| ------------------------------- | ----------------------------------------- | ------------------- |
| AlertEvaluator + AlertRuleModel | `/alerts/*` (full CRUD + test-fire)       | Alerts page         |
| ExperimentModel                 | `/experiments/*` (CRUD + results)         | Experiments page    |
| ROICalculator                   | `/roi/*` (summary + simulate)             | At a Glance ROI tab |
| NLQueryService                  | `/nl-analytics/ask`                       | Ask AI page         |
| External events                 | `/external-events/*` (ingest + correlate) | Trends tab markers  |

### Existing Backend to Enhance

| Service                    | Enhancement Needed                                                                 |
| -------------------------- | ---------------------------------------------------------------------------------- |
| `/experiments/:id/results` | Join conversation_outcomes + quality_evaluations for containment/CSAT/cost metrics |
| `/nl-analytics/ask`        | Add conversation memory, chart type hints in response                              |
| `AnalyticsCache`           | Extend to new `/insights/*` routes (currently only covers `pipeline-analytics`)    |

### Modified Code

| Area                               | Changes                                                                                                                                                  |
| ---------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Sidebar navigation**             | Add new pages, restructure Insights group. **Must update both** `config/navigation.ts` AND `ProjectSidebar.tsx` + `navigation-store.ts` ProjectPage type |
| **AppShell**                       | Add routing for new pages, replace ComingSoon placeholders                                                                                               |
| **Pipeline editor**                | Add "Run Results" tab, node output preview                                                                                                               |
| **Existing InsightsDashboardPage** | Replace with new At a Glance page                                                                                                                        |
| **Existing analytics hooks**       | Extend to include pipeline analytics data                                                                                                                |
| **init-analytics-tables.ts**       | Add `alert_history` table + `mv_hourly_alert_metrics` MV                                                                                                 |
| **init-analytics-tables.ts**       | Fix MV date column inconsistency (`date` → `day`) + MV avg-vs-sum bug (see data loss warning in Section 14)                                              |
| **pipeline-analytics.ts**          | Fix timeseries MV queries (wrong column names, wrong aggregate expressions, references nonexistent `avg_sentiment` on MV)                                |

---

---

## 12. Security, Accessibility & Error Handling

### 12.1 Security

#### Query Safety

All ClickHouse queries MUST use parameterized queries (`{param:Type}` syntax) — never string interpolation. The existing `pipeline-analytics.ts` already follows this pattern. The new `ClickHouseQueryService` must enforce:

```typescript
// CORRECT: Parameterized
WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String}

// NEVER: String interpolation
WHERE tenant_id = '${tenantId}'  // ← SQL injection risk
```

#### Ask AI Query Safety

The NL-to-query feature (Section 6.8) effectively gives users read access to ClickHouse. Mandatory safeguards:

1. **Table allowlist**: Only analytics tables (Category A) and aggregated platform tables (MVs) are queryable. Off-limits: `kms_audit_log`, `dead_letter_events`, `messages` (encrypted content), `audit_events` (admin-only).
2. **Mandatory tenant/project isolation**: Every generated query MUST include `tenant_id = {tenantId}` and `project_id = {projectId}` clauses. These are injected by the service, not by the LLM.
3. **Query limits**: Max execution time 30s, max rows scanned 10M, max result rows 10,000. Enforced via ClickHouse settings on the query.
4. **No DDL/DML**: The query builder only generates SELECT statements. The service validates the output contains no INSERT/UPDATE/DELETE/DROP/ALTER.
5. **Rate limiting**: Max 10 Ask AI queries per minute per user.

#### Data Sensitivity

- The `messages` table stores encrypted content via `ClickHouseEncryptionInterceptor`. Conversation detail views must decrypt via the existing store pattern — never expose raw encrypted values.
- The Compliance & Audit page is restricted to users with `compliance:read` permission.
- Conversation content is shown only to users with `conversations:read` permission on the project.

### 12.2 Accessibility

#### Color-Blind Safe Palette

All status indicators use **dual encoding** — color PLUS shape/icon:

- Healthy: green circle + checkmark icon
- Warning: amber triangle + exclamation icon
- Critical: red diamond + X icon

For heatmaps, use a **blue-to-orange diverging scale** (colorblind-safe) instead of red-to-green:

```typescript
const COLORBLIND_SAFE_SCALE = {
  low: 'hsl(220, 70%, 70%)', // blue
  mid: 'hsl(45, 10%, 85%)', // neutral
  high: 'hsl(25, 85%, 55%)', // orange
};
```

#### Screen Reader Support

- All charts include a visually hidden `<table>` fallback with the same data (recharts supports `accessibilityLayer` prop).
- KPI cards use `role="status"` with `aria-label` describing the metric, value, and trend.
- Heatmap cells include `title` attributes with the cell value.
- Interactive drill-downs are keyboard-navigable (Enter to drill in, Escape to go back).

#### Keyboard Navigation

- All interactive elements are focusable via Tab.
- Chart data points navigable via arrow keys when focused.
- Filter dropdowns support typeahead search.

### 12.3 Error & Empty States

Every insight page handles four states:

#### Loading State

- KPI cards show animated pulse placeholders (existing `AnalyticsSkeleton` pattern from `analytics/shared.tsx`)
- Charts show a gray placeholder with subtle shimmer
- Tables show skeleton rows

#### Empty State (No Data Yet)

- Full-page illustration + message: "No [pipeline type] data yet"
- Call-to-action: "Configure and activate the [Pipeline Name] pipeline" → links to pipeline editor
- If pipeline exists but hasn't run: "Pipeline is configured but hasn't processed data yet. It will run automatically when conversations complete."

#### Error State (ClickHouse Unreachable)

- Banner at top of page: "Analytics temporarily unavailable. Data will refresh automatically."
- KPI cards show last cached values (from SWR's stale data) with a "stale" badge
- Retry button with exponential backoff

#### Partial Data State

- When some pipeline types have data but others don't, show available data and gray out missing sections
- Each missing section shows: "Requires [pipeline name] pipeline. [Configure →]"

#### Data Freshness Indicator

- Page header shows "Last updated: X minutes ago" based on `processed_at` from the relevant table
- If stale > 1 hour: amber warning "Pipeline may not be running — check pipeline status"
- If stale > 24 hours: red warning "No recent data — pipeline may be disabled"

### 12.4 Responsive Design

Follow existing pattern from `InsightsDashboardPage`:

- KPI cards: `grid-cols-2 sm:grid-cols-3 lg:grid-cols-6`
- Charts: full width on mobile, 2-up on tablet, flexible on desktop
- Tables: horizontal scroll on mobile with sticky first column
- FilterBar: collapses to single dropdown on mobile
- Conversation detail: full-page on mobile (replaces list), slide-over on desktop

---

## 13. API Routing Clarification

### Which Tables Are Accessible via Existing vs New APIs

The existing `pipeline-analytics` API supports 11 pipeline types but does NOT cover several tables critical to the insights pages:

| Table                          | Existing API                   | New `/insights/*` API      | Notes                                                                    |
| ------------------------------ | ------------------------------ | -------------------------- | ------------------------------------------------------------------------ |
| `conversation_outcomes`        | No                             | Yes                        | Containment, escalation rates                                            |
| `goal_completions`             | No                             | Yes                        | Goal tracking metrics                                                    |
| `toxicity_evaluations`         | No                             | Yes                        | Toxicity monitoring                                                      |
| `conversation_mentions`        | No                             | Yes                        | VoC, competitor analysis                                                 |
| `churn_risk_scores`            | No                             | Yes                        | Churn prediction                                                         |
| `customer_predictive_features` | No                             | Yes                        | Predictive analytics                                                     |
| `experiment_assignments`       | Via `/experiments/:id/results` | Enhanced via `/insights/*` | A/B testing — existing route returns session counts; need richer metrics |
| `external_events`              | Via `/external-events/*`       | Also via `/insights/*`     | **Ingestion already exists** (POST single/batch + correlate endpoint)    |
| `platform_events`              | Via `/analytics/*`             | Also via `/insights/*`     | Volume, agent metrics, tool metrics                                      |
| `llm_metrics`                  | Via `/analytics/*`             | Also via `/insights/*`     | Cost, latency                                                            |
| All other analytics tables     | Via `/pipeline-analytics/*`    | Also via `/insights/*`     | Cross-pipeline joins go through new API                                  |

### External Events Ingestion — ALREADY EXISTS

~~The `external_events` table exists but has no ingestion mechanism.~~ **Corrected:** Full ingestion already exists at `/api/projects/:projectId/external-events`:

- `POST /` — single event creation (types: deployment, incident, crm_update, benchmark, product_release, outage, custom)
- `POST /batch` — batch ingestion up to 100 events
- `GET /` — list events with type filter and days lookback
- `GET /correlate` — correlate external events with metric timeseries from MVs (supports avg_sentiment, avg_quality, conversation_count)

The remaining Phase 3 work is:

- **Webhook receiver** for CI/CD tools (Harness, GitHub Actions) to auto-post deployment events
- **Studio UI** to display markers on trend charts (the data and correlation API already exist)

### KPI Component Migration Plan

The new `InsightKPICard` replaces **five** existing variants (not three — audit found 2 additional inline implementations). Migration path:

1. **Phase 1**: Create `InsightKPICard` as a new component. The `ui/MetricCard.tsx` is the most feature-rich existing variant (trend with favorable/unfavorable, icon, context) and should inform the design. Use `InsightKPICard` in all new insight pages.
2. **Phase 1**: Do NOT touch existing components yet — all five variants continue to work:
   - `KPICard` (analytics/shared.tsx, props: `{title, value, subtitle}`)
   - `MetricCard` (ui/MetricCard.tsx, props: `{label, value, trend, context, icon}`)
   - Inline `MetricCard` (InsightsDashboardPage.tsx, props: `{label, value, change}`)
   - Inline `MetricCard` (VoiceAnalyticsPage.tsx, props: `{label, value, unit, change, trend}`)
   - Inline `MetricCard` (VoiceMetricsTab.tsx, props: `{label, value, icon, color, subtitle}`)
3. **Phase 2**: When replacing InsightsDashboardPage with the new At a Glance page, the InsightsDashboardPage inline MetricCard is naturally removed.
4. **Phase 6 (Polish)**: Migrate remaining usages of `KPICard`, `MetricCard`, and all inline variants to `InsightKPICard`. Update `OverviewTab`, `LLMPerformanceTab`, `VoiceAnalyticsPage`, `VoiceMetricsTab`.

### Sidebar Navigation Duplication Warning

The sidebar navigation config is defined in **two places** that must be kept in sync when adding new pages:

- `apps/studio/src/config/navigation.ts` (canonical — 5 items under insights)
- `apps/studio/src/components/navigation/ProjectSidebar.tsx` (duplicate — adds `pipelines` as 6th item)

Additionally, the `ProjectPage` TypeScript union type in `apps/studio/src/store/navigation-store.ts` must be updated for any new page IDs.

### Time Range Picker Consolidation

Four different time range implementations exist — new insight pages should use the existing shared `TimeRangeSelector` component (`apps/studio/src/components/shared/TimeRangeSelector.tsx`) which is already exported but **unused by any analytics page**:

- InsightsDashboardPage: DropdownMenu (7d/30d/90d)
- VoiceAnalyticsPage: inline pills (24h/7d/30d)
- AnalyticsPage: Grafana-style pills (30m→30d + custom datetime)
- Shared `TimeRangeSelector`: preset buttons + custom date picker (presets: 1h/24h/7d/30d/90d/custom)

**Rule:** All new insight pages MUST use `TimeRangeSelector`. Phase 6 migrates existing pages.

### `insight_results` Deployment Note

The `insight_results` table uses `ReplicatedMergeTree` (from `packages/database/src/clickhouse-schemas/init.ts`), unlike the analytics tables which use non-replicated `ReplacingMergeTree`. In dev mode, this is automatically downgraded to `MergeTree`. In production, it requires ClickHouse Keeper to be available. The `store-insight` node (which already exists) writes to this table.

---

## 14. Known Bugs to Fix in Phase 1

These are pre-existing codebase bugs discovered during design research:

| Bug                             | Location                                   | Fix                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| MV date column inconsistency    | `init-analytics-tables.ts`                 | Standardize all MVs to use `day` column. Drop and recreate `mv_daily_sentiment`, `mv_daily_intent_distribution`, `mv_daily_quality_scores` with `day` instead of `date`. **DATA LOSS WARNING:** Dropping MVs loses all pre-aggregated historical data. Options: (a) backfill via INSERT INTO ... SELECT after recreate, (b) accept loss (MVs repopulate from new pipeline runs only), (c) ALTER TABLE to add `day` alias column instead of drop/recreate. |
| Timeseries queries wrong column | `pipeline-analytics.ts` (timeseries route) | Update MV queries to use correct date column (or fix the MVs first). Also: timeseries route references `avg_sentiment` which does not exist on the MV — it only has `total_sentiment` and `conversation_count`.                                                                                                                                                                                                                                           |
| MV avg vs sum bug               | `pipeline-analytics.ts` (timeseries route) | Change `avg(avg_sentiment)` to `sum(total_sentiment) / sum(conversation_count)` for all MV-backed queries. Same for quality and intent.                                                                                                                                                                                                                                                                                                                   |
| Column name mismatches          | Various spec references                    | Use `sentiment_trajectory` (not `trajectory`), `experiment_group` (not `group`, and it's Enum8 not String), `llm_evaluate.score` is Nullable(Float32).                                                                                                                                                                                                                                                                                                    |
| AnalyticsCache coverage gap     | All routes except `pipeline-analytics.ts`  | `analytics.ts`, `voice-analytics.ts`, `nl-analytics.ts`, `experiments.ts`, `alerts.ts`, `roi.ts` have **no Redis caching**. Evaluate and add `AnalyticsCache` where appropriate.                                                                                                                                                                                                                                                                          |

---

## 15. Review Log

### Spec Review — 2026-03-12

**Reviewer:** Automated spec-document-reviewer
**Verdict:** Issues Found → Fixed

#### Critical Issues (Fixed)

- C1: `dateColumn: 'session_start'` corrected to `'session_started_at'` in MetricDefinition examples
- C2: MV aggregate expressions corrected — added `mvExpression` field showing `sum(total_x) / sum(count)` pattern, with warning comments
- C3: MV date column inconsistency (`date` vs `day`) documented with `mvDateColumn` field and added to Known Bugs (Section 14)

#### Major Issues (Fixed)

- M1: Added Section 13 clarifying which tables are accessible via existing vs new API endpoints
- M2: Corrected table count from "43+" to "~42" and MV count from "10+" to "10"
- M3: Added `insight_results` ReplicatedMergeTree deployment note in Section 13
- M4: Added Section 12.3 — comprehensive error, empty, loading, partial, and stale state designs
- M5: Added Section 12.1 — security for query safety, Ask AI safety, data sensitivity
- M6: Added Section 12.2 — accessibility (colorblind palette, screen readers, keyboard nav)
- M7: Added KPI component migration plan in Section 13

#### Minor Issues (Acknowledged, will address during implementation)

- N1: Added Section 12.4 — responsive breakpoint guidance
- N3: `d3-sankey` noted as Phase 2 dependency
- N4: Sidebar item count corrected (6 current items, not 5)
- N5: API routing clarification added in Section 13
- N7: External events ingestion mechanism added in Section 13
- N8: Redis TTL parity confirmed — new endpoints use same `AnalyticsCache` with same TTLs

### Design Review — 2026-03-12 (Round 2)

**Reviewer:** User + Claude (collaborative discussion)
**Verdict:** Three proposed node types dropped

#### Decision: Drop All Three Proposed Node Types

After critical analysis, `compute-containment`, `compute-cost-attribution`, and `compute-routing-accuracy` are unnecessary:

| Node                       | Why Dropped                                                                                                                                                                                                                        | Alternative                                        |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------- |
| `compute-containment`      | Containment rate is `countIf(outcome='resolved') / count(*)` from `conversation_outcomes` — single table, no join needed. `mv_daily_outcomes` already pre-aggregates.                                                              | Query-time computation in `ClickHouseQueryService` |
| `compute-cost-attribution` | Cost per resolution by agent/intent is a query-time join of `llm_metrics` + `conversation_outcomes` + `intent_classifications`. ClickHouse handles this with partition pruning. If slow, add an MV — cheaper than a pipeline node. | Query-time join; MV if needed later                |
| `compute-routing-accuracy` | Routing accuracy requires LLM judgment — which is exactly what `llm-evaluate` with `tag: 'routing_accuracy'` does. No new node type needed.                                                                                        | `llm-evaluate` node with `routing_accuracy` tag    |

**Principle established**: Pipeline nodes should only exist when they call an LLM, write data that doesn't exist yet, or perform stateful computation that can't be expressed as SQL. Simple ratios and query-time joins belong in the query layer.

#### Cascading Changes Applied

- Section 1: Fixed "3 of 5" → "3 of 6" sidebar count
- Section 3.3: Corrected cross-pipeline metrics example (containment doesn't need 3 tables)
- Section 3.4: Added `llm_evaluate` to Multi-Agent row
- Section 6.2: Noted `llm_evaluate` tag for routing accuracy
- Section 8.1: Replaced 3 node type proposals with "No New Node Types Needed" rationale table
- Section 8.1: Updated executive-summary pipeline to use `db-query` instead of dropped nodes
- Section 8.2: Removed 3 tables (containment_metrics, cost_attribution, routing_decisions)
- Section 8.3: Removed 2 MVs (mv_daily_containment, mv_daily_cost_attribution)
- Section 11 Phase 3: Removed node type references
- Summary of Changes: Updated all counts and removed node-type-related modified code rows

### Codebase Audit Review — 2026-03-16 (Round 3)

**Reviewer:** Codebase cross-reference audit (Claude Opus)
**Verdict:** 5 Critical, 4 High, 8 Medium, 5 Low findings → All addressed in doc updates

#### Critical Findings (all addressed above)

| ID  | Finding                                                                                                                                                     | Resolution                                                                                                       |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| C1  | **Alerts system already fully exists** — AlertRuleModel, full CRUD routes, AlertEvaluator Restate service, eval alert templates. Spec proposed them as NEW. | Section 6.6 updated: "frontend only — backend ALREADY EXISTS". Section 7.1 split into NEW vs EXISTING endpoints. |
| C2  | **NL Analytics / Ask AI already fully exists** — NLQueryService, semantic-layer.ts (22 tables), POST /nl-analytics/ask. Spec proposed full backend as NEW.  | Section 6.8 rewritten: existing backend acknowledged, work scoped to frontend UI + enhancements only.            |
| C3  | **Experiments route already exists** — full CRUD + lifecycle + results/timeseries from ClickHouse.                                                          | Section 6.5 updated. Section 7.1 moved to "Existing Routes to Wire" table.                                       |
| C4  | **ROI route already exists** — ROICalculator service, GET /summary, POST /simulate, configurable cost params.                                               | Section 6.1 ROI tab updated to reference existing endpoints.                                                     |
| C5  | **External events ingestion already exists** — POST single/batch, GET list/correlate. Spec said "no ingestion mechanism".                                   | Section 13 corrected.                                                                                            |

#### High Findings (all addressed above)

| ID  | Finding                                                                                                                                         | Resolution                                                                                      |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| H1  | **Table count wrong** (~42 → 47), **MV count significantly wrong** (10 → 17 deployed). Missing 7 platform MVs from initClickHouseSchema.        | Section 1, 2, 3.1 all updated with correct counts and full MV listings.                         |
| H2  | **Column name mismatches** — `sentiment_trajectory` not `trajectory`, `experiment_group` not `group` (Enum8), `llm_evaluate.score` is Nullable. | Section 3.1 table annotations, Section 3.3 warning comments, Section 14 known bugs all updated. |
| H3  | **Missing tables from taxonomy** — `platform_events_by_session`, `external_events` miscategorized.                                              | Category A and B updated.                                                                       |
| H4  | **AnalyticsCache only used by pipeline-analytics.ts** — all other routes uncached.                                                              | Section 10.1 callout added, Section 14 known bugs updated.                                      |

#### Medium Findings (all addressed above)

| ID  | Finding                                                                                             | Resolution                                                      |
| --- | --------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| M1  | Color system contradiction (red-green in 9.3 vs blue-orange in 12.2)                                | Section 9.3 heatmap scale replaced with colorblind-safe palette |
| M2  | SWR hooks don't mention 8+ existing hooks                                                           | Section 7.3 updated with existing hooks inventory               |
| M3  | Missing backend services section — NLQueryService, ROICalculator, AlertEvaluator, etc. undocumented | New "Backend Services" table added to Section 2                 |
| M4  | `platform_events_by_session` table not mentioned (useful for session dedup)                         | Added to Category B                                             |
| M5  | ClickHouseQueryService overlaps with existing NLQueryService + semantic layer                       | Section 3.3 header note added clarifying complementary role     |
| M6  | Sidebar nav defined in 2 places that must stay in sync                                              | Section 13 sidebar duplication warning added                    |
| M7  | 4 different time range picker implementations, shared one unused                                    | Section 13 time range consolidation guidance added              |
| M8  | MV drop/recreate loses historical data — no warning                                                 | Section 14 data loss warning added with 3 mitigation options    |

#### Low Findings (all addressed above)

| ID  | Finding                                                                                        | Resolution                                                     |
| --- | ---------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| L1  | `conversation_outcomes.outcome` is LowCardinality(String) not enum                             | Section 3.3 column note added                                  |
| L2  | 5 KPI card variants exist (not 3)                                                              | Section 2 frontend table and Section 13 migration plan updated |
| L3  | Timeseries route references nonexistent `avg_sentiment` on MV                                  | Section 14 known bugs expanded                                 |
| L4  | `insight_results` uses ReplicatedMergeTree unlike other analytics tables                       | Already noted in Section 13                                    |
| L5  | Summary of Changes overcounted new items (alerts, experiments, ROI, NL analytics were not new) | Summary table split into New/Existing/Enhanced categories      |

---

_End of design spec. All 233 customer queries mapped to pages, visualizations, data sources, and API endpoints._
