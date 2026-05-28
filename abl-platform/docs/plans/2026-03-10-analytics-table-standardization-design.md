# Analytics Table Standardization & InsightResult Architecture

**Date:** 2026-03-10
**Status:** Approved
**Scope:** ClickHouse analytics tables, InsightResult role, pipeline provenance

## Problem

1. **Duplicate pipeline execution** — Builtin pipelines (sentiment, quality, knowledge-gap) fire alongside custom pipelines that run the same compute services, causing duplicate ClickHouse rows and wasted LLM tokens.
2. **No pipeline provenance** — Analytics tables don't record which pipeline produced the result (builtin vs custom, which pipeline ID). Cannot filter or compare.
3. **Missing columns** — `project_id` missing from `message_sentiment` and `conversation_mentions`. `channel` missing from `conversation_mentions`, `anomaly_detections`, and `drift_detections`.
4. **InsightResult mismatch** — `store-insight` node expects `InsightResult` format but compute services write directly to dedicated tables. The `store-insight` node fails when placed after compute services.
5. **Goal completion not persisted to ClickHouse** — The `eval-goal-completion` node (`call-llm` type) produces structured results (criteria scores, overall completion score, summary) but they only live in MongoDB `pipeline_run_records` step output. Not queryable for analytics.
6. **Toxicity uses generic table** — `compute-toxicity` is the only service writing to the generic `insight_results` table instead of a dedicated table, inconsistent with all other compute services.

## Decisions

### 1. InsightResult Role

**Dedicated tables for builtins. InsightResult for future custom insights.**

- Each builtin compute service (sentiment, quality, intent, mentions, etc.) continues to write to its own dedicated ClickHouse table with exploded, queryable columns.
- `InsightResult` / `store-insight` / `insight_results` table remain available for **future custom insight types** that don't have a dedicated compute service.
- Custom pipelines that use existing compute service node types (e.g., `compute-sentiment`) write to the same dedicated tables as builtins — no separate storage path needed.
- Upgrade path: a custom insight with high usage can be "promoted" to a dedicated table.

### 2. Pipeline Provenance Columns

Add two columns to **every** analytics table:

```sql
pipeline_id    LowCardinality(String) DEFAULT ''
pipeline_type  LowCardinality(String) DEFAULT ''   -- 'builtin' | 'custom'
```

This enables:

- Filtering: "show only custom pipeline quality scores"
- Comparison: "builtin vs custom sentiment for the same sessions"
- Debugging: trace which pipeline produced a record

### 3. Missing Column Additions

Add missing common columns for consistency:

| Table                   | Add `project_id` | Add `channel` |
| ----------------------- | :--------------: | :-----------: |
| `message_sentiment`     |       yes        |       -       |
| `conversation_mentions` |    - (exists)    |      yes      |
| `anomaly_detections`    |        -         |      yes      |
| `drift_detections`      |        -         |      yes      |

### 4. New Dedicated Table: `goal_completions`

Goal completion results currently live only in MongoDB run records. Create a dedicated ClickHouse table so they're queryable alongside other analytics.

```sql
CREATE TABLE IF NOT EXISTS abl_platform.goal_completions
(
    tenant_id             String,
    project_id            String,
    session_id            String,
    session_started_at    DateTime64(3),
    processed_at          DateTime64(3),
    agent_name            LowCardinality(String),
    channel               LowCardinality(String),

    -- Goal completion fields
    overall_score         Float64,
    goal_detected         String,
    goal_achieved         UInt8,
    summary               String,
    criteria              String,             -- JSON: { "criterion_name": { "score": 0-1, "evidence": "..." } }

    -- Provenance
    model_id              LowCardinality(String),
    config_version        UInt32,
    pipeline_id           LowCardinality(String),
    pipeline_type         LowCardinality(String),
    source                LowCardinality(String),
    processing_ms         UInt32,
    input_tokens          UInt32,
    output_tokens         UInt32
)
```

**Compute service:** Create `compute-goal-completion.service.ts` — a proper compute service that:

- Takes the same conversation input as other compute services
- Calls LLM with the goal-completion prompt (currently inline in the pipeline definition)
- Parses the structured JSON response
- Writes to `goal_completions` ClickHouse table
- Returns structured output like other compute services

This replaces the current approach of using a generic `call-llm` node with inline prompt config.

### 5. New Dedicated Table: `toxicity_evaluations`

Migrate toxicity from the generic `insight_results` table to its own dedicated table, consistent with all other compute services.

```sql
CREATE TABLE IF NOT EXISTS abl_platform.toxicity_evaluations
(
    tenant_id             String,
    project_id            String,
    session_id            String,
    session_started_at    DateTime64(3),
    processed_at          DateTime64(3),
    agent_name            LowCardinality(String),
    channel               LowCardinality(String),

    -- Session-level aggregate
    avg_toxicity          Float64,
    max_toxicity          Float64,
    flagged               UInt8,
    status                LowCardinality(String),     -- pass | warn | fail
    threshold             Float64,
    message_count         UInt16,

    -- Provenance
    model_id              LowCardinality(String),
    config_version        UInt32,
    pipeline_id           LowCardinality(String),
    pipeline_type         LowCardinality(String),
    source                LowCardinality(String),
    processing_ms         UInt32,
    input_tokens          UInt32,
    output_tokens         UInt32
)
```

Plus a per-message detail table:

```sql
CREATE TABLE IF NOT EXISTS abl_platform.message_toxicity
(
    tenant_id             String,
    project_id            String,
    session_id            String,
    message_id            String,
    message_at            DateTime64(3),
    processed_at          DateTime64(3),
    role                  LowCardinality(String),
    agent_name            LowCardinality(String),
    channel               LowCardinality(String),

    toxicity_score        Float64,
    status                LowCardinality(String),     -- pass | warn | fail
    content_length        UInt32,

    pipeline_id           LowCardinality(String),
    pipeline_type         LowCardinality(String)
)
```

**Compute service change:** Update `compute-toxicity.service.ts` to write to these dedicated tables instead of returning `InsightResult` for `store-insight`.

### 6. Builtin Pipeline Disable

For projects using custom pipelines that cover the same eval types:

- Disable overlapping builtin pipeline configs (`enabled: false`) at tenant level.
- Remove `store-insight` node from custom pipeline graphs (compute services handle their own persistence).

## Table Schema: Common vs Specialized

### Common Columns (target: present in ALL tables)

| Column           | Type                   | Present Today | Notes                          |
| ---------------- | ---------------------- | :-----------: | ------------------------------ |
| `tenant_id`      | String                 |     14/14     | Isolation key                  |
| `project_id`     | String                 |     12/14     | Add to `message_sentiment`     |
| `session_id`     | String                 |     14/14     | Session link                   |
| `processed_at`   | DateTime64(3)          |     14/14     | When evaluated                 |
| `processing_ms`  | UInt32                 |     11/14     | Perf tracking                  |
| `agent_name`     | LowCardinality(String) |     11/14     | Which agent handled session    |
| `channel`        | LowCardinality(String) |     11/14     | Add to 3 tables                |
| `model_id`       | LowCardinality(String) |     9/14      | LLM used (N/A for statistical) |
| `config_version` | UInt32                 |     9/14      | Config tracking                |
| `source`         | LowCardinality(String) |    ~13/14     | Event source                   |
| `pipeline_id`    | LowCardinality(String) |     0/14      | **NEW** — which pipeline       |
| `pipeline_type`  | LowCardinality(String) |     0/14      | **NEW** — builtin or custom    |

### Specialized Columns Per Table

| Table                       | Specialized Column Count | Key Fields                                                                                                 |
| --------------------------- | :----------------------: | ---------------------------------------------------------------------------------------------------------- |
| `conversation_sentiment`    |           ~10            | avg/start/end/min/max_sentiment, trajectory, shift_count, frustration, pivots                              |
| `message_sentiment`         |            ~6            | message_id, message_at, role, sentiment_score, sentiment_label, frustration_signals                        |
| `quality_evaluations`       |            ~8            | overall_score, helpfulness, accuracy, professionalism, instruction_following, custom_dimensions, reasoning |
| `conversation_outcomes`     |            ~8            | outcome, outcome_method, goal_detected, goal_achieved, outcome_reasoning, handoff_count, escalation_reason |
| `intent_classifications`    |            ~6            | intent, intent_display, sub_intent, secondary_intents, is_auto_discovered, taxonomy_version                |
| `conversation_mentions`     |            ~2            | mention_type (enum), mention_text                                                                          |
| `hallucination_evaluations` |            ~5            | faithfulness_score, claims, unsupported_claims, consistency_index, contradiction_detected                  |
| `knowledge_gap_evaluations` |            ~6            | retrieval_precision, citation_rate, gap_detected, gap_topics, unused_articles, article_ids_cited           |
| `guardrail_evaluations`     |            ~6            | false_positive/negative_score, bypass_detected, bypass_technique, severity, violation_categories           |
| `context_evaluations`       |            ~5            | context_score, lost_context_items, duplication_detected/count, handoff_count                               |
| `friction_detections`       |            ~6            | friction_score, rephrase_count, message_length_trend, turn_count_zscore, caps/exclamation_count            |
| `anomaly_detections`        |            ~8            | anomaly_flag, severity, z_score, metric_name/value, expected_range, spc_out_of_control                     |
| `drift_detections`          |            ~5            | drift_score, drift_type, baseline_mean, current_mean, trend_slope                                          |
| `goal_completions`          |            ~5            | **NEW** — overall_score, goal_detected, goal_achieved, summary, criteria (JSON)                            |
| `toxicity_evaluations`      |            ~5            | **NEW** — avg_toxicity, max_toxicity, status, threshold, message_count                                     |
| `message_toxicity`          |            ~4            | **NEW** — message_id, toxicity_score, status, content_length                                               |

## Migration Strategy

All column additions use `ALTER TABLE ... ADD COLUMN ... DEFAULT ''` — non-breaking for existing data. ClickHouse backfills defaults automatically.

### Phase 1: Schema migration

- Add `pipeline_id` and `pipeline_type` to all 13 existing dedicated analytics tables
- Add `project_id` to `message_sentiment`
- Add `channel` to `conversation_mentions`, `anomaly_detections`, `drift_detections`
- Create `goal_completions` table
- Create `toxicity_evaluations` and `message_toxicity` tables

### Phase 2: New compute services

- Create `compute-goal-completion.service.ts` — proper compute service with ClickHouse write
- Register `compute-goal-completion` node type in the node registry
- Update `compute-toxicity.service.ts` to write to dedicated tables instead of `InsightResult`

### Phase 3: Provenance plumbing

- Pass `pipelineId` and `pipelineType` through compute service input context
- Each compute service includes these fields in its ClickHouse write
- Pass `projectId` and `channel` to services that were missing them

### Phase 4: Verification

- Trigger a test conversation and verify new columns are populated
- Verify goal completion results appear in ClickHouse
- Verify toxicity writes to dedicated table, not `insight_results`
- Query ClickHouse to confirm data integrity

## Files Affected

### ClickHouse Schema

- `packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts` — ALTER TABLE migrations

### New Compute Service

- `compute-goal-completion.service.ts` — **NEW** — proper compute service for goal completion with ClickHouse write
- `register-nodes.ts` — register `compute-goal-completion` node type

### Compute Services (add pipeline_id/pipeline_type to writes)

- `compute-sentiment.service.ts`
- `compute-quality.service.ts`
- `compute-intent.service.ts`
- `compute-mentions.service.ts`
- `conversation-analyzer.service.ts` (hallucination, knowledge-gap, guardrail, context)
- `compute-statistical.service.ts` (friction, anomaly, drift)
- `compute-toxicity.service.ts` — also migrate from `InsightResult` to dedicated table write
- `compute-goal-completion.service.ts` — new, writes to `goal_completions`

### Pipeline Input Context

- `graph-walker.ts` or `activity-router` — ensure `pipelineId` and `pipelineType` are passed to compute services via `PipelineStepContext`

### Types

- `types.ts` — add `pipelineId` and `pipelineType` to `PipelineStepContext` if not already present
