# Phase 3 + 4 + 5: Output Schema, Presentation & Index Design -- LLM-as-Judge Quality Evaluation Pipeline

> **Pipeline**: `quality_evaluation`
> **Date**: 2026-03-03
> **Depends on**: Phase 1 (Input Data Readiness) -- completed, Phase 2 (Config Schema) -- completed
> **Companion docs**:
>
> - Phase 2 config schema: `docs/plans/2026-03-03-quality-evaluation-phase2-config-schema.md`
> - Pipeline implementation plan: `docs/plans/2026-03-03-analytics-phase2-pipelines.md`
> - Skill reference: `.claude/skills/analytics-pipeline-development.md`

---

## Table of Contents

1. [Phase 3: Output Schema Design](#phase-3-output-schema-design)
2. [Phase 4: Presentation Design](#phase-4-presentation-design)
3. [Phase 5: Index & Performance Design](#phase-5-index--performance-design)

---

# Phase 3: Output Schema Design

## Completed Checklist

- [x] **3.1** Define the primary output record (one per conversation? per message? per time bucket?)
- [x] **3.2** Define all output fields with types and descriptions
- [x] **3.3** Include provenance fields (model_version, config_version, processed_at)
- [x] **3.4** Include confidence/quality indicators
- [x] **3.5** Design for both per-record queries AND aggregation queries
- [x] **3.6** Choose storage: ClickHouse (analytics) vs MongoDB (config/lookup) vs both
- [x] **3.7** Define ClickHouse table engine, partitioning, and ORDER BY
- [x] **3.8** Define TTL policy aligned with source data TTLs
- [x] **3.9** Design materialized views for common aggregation patterns
- [x] **3.10** Ensure tenant isolation (tenant_id in every table, every query)
- [x] **3.11** Plan for re-processing: how to replace old results when config changes

---

### 3.1 Primary Output Record Granularity

**One record per evaluated conversation (session).** The quality evaluation pipeline produces exactly one row in `quality_evaluations` per session it evaluates. This is a per-conversation pipeline, not per-message.

Rationale:

- Quality is a conversation-level judgment. The judge LLM reads the entire transcript and scores the overall interaction.
- Per-dimension scores are stored as parallel arrays within the same row (not separate rows per dimension). This avoids joins and keeps the evaluation atomic.
- The array approach supports up to 10 dimensions (Phase 2 validation cap) without schema changes.

---

### 3.2 All Output Fields

#### Primary Table: `quality_evaluations`

| Column                 | Type                     | Description                                                                                                                                                              |
| ---------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `tenant_id`            | `String`                 | Tenant isolation key. Every query MUST filter on this.                                                                                                                   |
| `project_id`           | `String`                 | Project scope. Routes under `/api/projects/:projectId/`.                                                                                                                 |
| `session_id`           | `String`                 | The evaluated conversation. Foreign key to `messages` and `traces`.                                                                                                      |
| `session_started_at`   | `DateTime64(3)`          | When the conversation started. Used for time-range partitioning and filtering. Copied from the session's first message `created_at`.                                     |
| `processed_at`         | `DateTime64(3)`          | When this evaluation was produced. Used as the `ReplacingMergeTree` version column for deduplication on re-processing.                                                   |
| `agent_name`           | `LowCardinality(String)` | Primary agent that handled the conversation. Used for breakdown-by-agent queries.                                                                                        |
| `agent_version`        | `LowCardinality(String)` | Agent version at time of conversation. Enables version-over-version comparison.                                                                                          |
| `channel`              | `LowCardinality(String)` | Conversation channel (`web_chat`, `voice`, `whatsapp`, etc.). Used for breakdown-by-channel.                                                                             |
| `overall_score`        | `Float32`                | Single composite score across all dimensions. Computation method determined by `overall_method`. This is the "headline number" executives see.                           |
| `overall_method`       | `LowCardinality(String)` | How `overall_score` was computed: `'weighted'`, `'average'`, or `'minimum'`. Stored for auditability -- if config changes, you know how historical scores were computed. |
| `dimension_names`      | `Array(String)`          | Ordered list of evaluated dimension machine names. Parallel with `dimension_scores` and `dimension_rationales`.                                                          |
| `dimension_scores`     | `Array(Float32)`         | Per-dimension scores, same order as `dimension_names`.                                                                                                                   |
| `dimension_rationales` | `Array(String)`          | Per-dimension reasoning from the judge, same order. Compressed at application level before insert (gzip, stored as base64 string in each element).                       |
| `helpfulness`          | `Nullable(Float32)`      | Denormalized from arrays when dimension name matches. Enables `WHERE helpfulness < 3.0` without array functions.                                                         |
| `accuracy`             | `Nullable(Float32)`      | Denormalized. Same rationale.                                                                                                                                            |
| `professionalism`      | `Nullable(Float32)`      | Denormalized. Same rationale.                                                                                                                                            |
| `flagged`              | `UInt8`                  | `1` if `overall_score < flagThreshold` (from config at processing time). Enables fast `WHERE flagged = 1` without knowing the threshold.                                 |
| `critical`             | `UInt8`                  | `1` if `overall_score < criticalThreshold`. Same rationale.                                                                                                              |
| `judge_reasoning`      | `String`                 | Full reasoning output from the judge LLM. Compressed at application level (gzip + base64). Displayed in the single-conversation drill-down view.                         |
| `model_id`             | `LowCardinality(String)` | LLM model used for this evaluation (e.g., `claude-haiku-4-5`).                                                                                                           |
| `config_version`       | `UInt32`                 | Pipeline config version at time of evaluation. Enables filtering by "evaluations done with this rubric version".                                                         |
| `confidence`           | `Float32`                | Judge LLM's self-reported confidence (0.0-1.0). Extracted from structured output.                                                                                        |
| `processing_ms`        | `UInt32`                 | Wall-clock time for the full evaluation (decrypt + format + LLM call + parse).                                                                                           |
| `input_tokens`         | `UInt32`                 | Tokens sent to the judge LLM. For cost tracking.                                                                                                                         |
| `output_tokens`        | `UInt32`                 | Tokens received from the judge LLM. For cost tracking.                                                                                                                   |

**Why denormalize helpfulness/accuracy/professionalism?**

These three are the most common dimensions across all rubric templates (General CS, Telco, Healthcare). Denormalizing them as top-level `Nullable(Float32)` columns enables:

1. Direct `WHERE helpfulness < 3.0` without `arrayElement(dimension_scores, indexOf(dimension_names, 'helpfulness'))`.
2. Skip index on these columns for fast granule pruning.
3. MV aggregation without array functions (cheaper at insert time).

The application layer populates these from the arrays at write time. If a rubric does not include a dimension, the column is `NULL`.

---

### 3.3 Provenance Fields

| Field            | Purpose                                                                                                                                                                              |
| ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `model_id`       | Exact LLM used. Different models produce different scores. Enables "model A vs model B" comparison after model migration.                                                            |
| `config_version` | Links to `pipeline_configs.version`. When a customer changes the rubric, new evaluations get the new version. Enables filtering: "show me only evaluations from the current rubric." |
| `processed_at`   | Timestamp of evaluation. Serves as ReplacingMergeTree version: on re-processing, newer `processed_at` wins.                                                                          |
| `overall_method` | Records the score computation method. Protects against retroactive misinterpretation if the method changes.                                                                          |

---

### 3.4 Confidence / Quality Indicators

| Indicator                        | Source                      | Range     | Use                                                                                                            |
| -------------------------------- | --------------------------- | --------- | -------------------------------------------------------------------------------------------------------------- |
| `confidence`                     | Judge LLM structured output | 0.0 - 1.0 | Low confidence evaluations can be flagged for human review. Dashboard can filter by `confidence >= 0.7`.       |
| `processing_ms`                  | Wall clock measurement      | 0 - N     | Anomalously long processing times may indicate problematic transcripts. Useful for pipeline health monitoring. |
| `input_tokens` / `output_tokens` | LLM API response            | 0 - N     | Cost attribution per evaluation. Detects runaway cost from long transcripts.                                   |

---

### 3.5 Per-Record vs Aggregation Query Support

The schema supports both query patterns:

**Per-record** (drill-down to single conversation):

```sql
SELECT * FROM quality_evaluations FINAL
WHERE tenant_id = {tenantId} AND session_id = {sessionId}
```

Works efficiently because `(tenant_id, project_id, session_id)` is the ORDER BY prefix.

**Aggregation** (dashboard summaries):

```sql
SELECT agent_name, avg(overall_score), count()
FROM quality_evaluations FINAL
WHERE tenant_id = {tenantId} AND project_id = {projectId}
  AND session_started_at >= {from} AND session_started_at < {to}
GROUP BY agent_name
```

For high-traffic dashboards, this query hits the `mv_daily_quality_scores` materialized view instead (see 3.9).

---

### 3.6 Storage Decision

| Store          | What                                                       | Why                                                                                                                          |
| -------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| **ClickHouse** | All evaluation results (`quality_evaluations` table + MVs) | Time-series aggregation, high-volume append, dashboard backing. Primary use case is "avg score over time by agent."          |
| **MongoDB**    | Pipeline configuration, human review queue state           | Low-volume, document-oriented, needs per-record updates (e.g., review status changes). Already exists as `pipeline_configs`. |
| **Redis**      | Dashboard query cache                                      | Sub-100ms scorecard latency. TTL-based invalidation on batch completion.                                                     |

No evaluation data goes to MongoDB. All query paths read from ClickHouse (or Redis cache of ClickHouse results).

---

### 3.7 ClickHouse Table DDL

```sql
CREATE TABLE IF NOT EXISTS abl_platform.quality_evaluations
(
    -- Identity & isolation
    tenant_id          String                   CODEC(ZSTD(1)),
    project_id         String                   CODEC(ZSTD(1)),
    session_id         String                   CODEC(ZSTD(1)),

    -- Timing
    session_started_at DateTime64(3)            CODEC(DoubleDelta, ZSTD(1)),
    processed_at       DateTime64(3)            CODEC(DoubleDelta, ZSTD(1)),

    -- Context dimensions (GROUP BY targets)
    agent_name         LowCardinality(String)   CODEC(ZSTD(1)),
    agent_version      LowCardinality(String)   CODEC(ZSTD(1)),
    channel            LowCardinality(String)   CODEC(ZSTD(1)),

    -- Overall score
    overall_score      Float32                  CODEC(Gorilla, ZSTD(1)),
    overall_method     LowCardinality(String)   CODEC(ZSTD(1)),

    -- Per-dimension scores (parallel arrays, up to 10 dimensions)
    dimension_names      Array(String)          CODEC(ZSTD(3)),
    dimension_scores     Array(Float32)         CODEC(ZSTD(3)),
    dimension_rationales Array(String)          CODEC(ZSTD(5)),

    -- Common dimensions denormalized for fast filtering
    helpfulness        Nullable(Float32)        CODEC(Gorilla, ZSTD(1)),
    accuracy           Nullable(Float32)        CODEC(Gorilla, ZSTD(1)),
    professionalism    Nullable(Float32)        CODEC(Gorilla, ZSTD(1)),

    -- Flagging (pre-computed at write time using config thresholds)
    flagged            UInt8                    CODEC(T64, ZSTD(1)),
    critical           UInt8                    CODEC(T64, ZSTD(1)),

    -- LLM judge metadata
    judge_reasoning    String                   CODEC(ZSTD(5)),

    -- Provenance
    model_id           LowCardinality(String)   CODEC(ZSTD(1)),
    config_version     UInt32                   CODEC(T64, ZSTD(1)),
    confidence         Float32                  CODEC(Gorilla, ZSTD(1)),
    processing_ms      UInt32                   CODEC(T64, ZSTD(1)),
    input_tokens       UInt32                   CODEC(T64, ZSTD(1)),
    output_tokens      UInt32                   CODEC(T64, ZSTD(1)),

    -- Skip indices
    INDEX idx_overall_score overall_score TYPE minmax GRANULARITY 4,
    INDEX idx_flagged       flagged       TYPE set(2) GRANULARITY 4,
    INDEX idx_critical      critical      TYPE set(2) GRANULARITY 4,
    INDEX idx_helpfulness   helpfulness   TYPE minmax  GRANULARITY 4,
    INDEX idx_accuracy      accuracy      TYPE minmax  GRANULARITY 4,
    INDEX idx_confidence    confidence    TYPE minmax  GRANULARITY 4
)
ENGINE = ReplicatedReplacingMergeTree(
    '/clickhouse/tables/{shard}/abl_platform.quality_evaluations',
    '{replica}',
    processed_at
)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL
    toDateTime(session_started_at) + INTERVAL 90  DAY TO VOLUME 'warm',
    toDateTime(session_started_at) + INTERVAL 365 DAY TO VOLUME 'cold',
    toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;
```

**ENGINE choice: `ReplicatedReplacingMergeTree(processed_at)`**

- `Replicated` -- matches existing platform pattern (all tables use replicated engines with Keeper).
- `ReplacingMergeTree(processed_at)` -- when the pipeline re-processes a conversation (config change, model change), a new row is inserted with a newer `processed_at`. ClickHouse deduplicates by ORDER BY key `(tenant_id, project_id, session_id)`, keeping the row with the latest `processed_at`.
- PARTITION BY `(tenant_id, toYYYYMM(session_started_at))` -- enables partition pruning on tenant + month. Multi-tenant queries never scan other tenants' partitions.
- ORDER BY `(tenant_id, project_id, session_id)` -- optimized for single-session lookup (the drill-down path) and project-scoped aggregation.

---

### 3.8 TTL Policy

| Tier   | Duration     | Storage                      | Purpose                                      |
| ------ | ------------ | ---------------------------- | -------------------------------------------- |
| Hot    | 0-90 days    | Default volume (SSD)         | Active dashboard queries, recent evaluations |
| Warm   | 90-365 days  | Warm volume (HDD/S3)         | Historical trend analysis, QBR reports       |
| Cold   | 365-730 days | Cold volume (object storage) | Compliance retention, annual comparisons     |
| Delete | 730+ days    | Removed                      | Data lifecycle termination                   |

Alignment with source data:

- `messages` table: 90 day warm, 730 day delete.
- `traces` table: 7 day warm, 30 day cold, 90 day delete.
- `quality_evaluations`: 730 day delete -- **intentionally longer than source data**. The evaluation is a derived artifact that customers reference for long-term trend analysis. The original transcript may be gone, but the scores and reasoning persist.

---

### 3.9 Materialized Views

#### MV 1: Daily Quality Score Aggregation

Backs the time-series chart and scorecard. This is the highest-traffic query on every dashboard load.

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_quality_scores
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name, channel)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at)                                   AS date,
    agent_name,
    channel,

    -- Counts
    count()                                                      AS conversation_count,
    sumIf(1, flagged = 1)                                        AS flagged_count,
    sumIf(1, critical = 1)                                       AS critical_count,

    -- Overall score (compute avg as total/count at read time)
    sum(overall_score)                                           AS total_score,
    sum(overall_score * overall_score)                           AS total_score_sq,

    -- Denormalized dimensions (for quick avg computation)
    sumIf(helpfulness, helpfulness IS NOT NULL)                  AS total_helpfulness,
    countIf(helpfulness IS NOT NULL)                             AS helpfulness_count,
    sumIf(accuracy, accuracy IS NOT NULL)                        AS total_accuracy,
    countIf(accuracy IS NOT NULL)                                AS accuracy_count,
    sumIf(professionalism, professionalism IS NOT NULL)          AS total_professionalism,
    countIf(professionalism IS NOT NULL)                         AS professionalism_count,

    -- Confidence (for quality monitoring)
    sum(confidence)                                              AS total_confidence,

    -- Cost tracking
    sum(input_tokens)                                            AS total_input_tokens,
    sum(output_tokens)                                           AS total_output_tokens,
    sum(processing_ms)                                           AS total_processing_ms
FROM abl_platform.quality_evaluations
GROUP BY tenant_id, project_id, date, agent_name, channel;
```

**Read-time formulas** (applied in the API layer):

```
avg_score       = total_score / conversation_count
avg_helpfulness = total_helpfulness / helpfulness_count
flagged_rate    = flagged_count / conversation_count
stddev_score    = sqrt(total_score_sq / conversation_count - (total_score / conversation_count)^2)
```

The `total_score_sq` field enables standard deviation computation without storing individual scores, which powers the confidence interval display on the time-series chart.

#### MV 2: Weekly Dimension Heatmap

Backs the per-dimension breakdown view that shows which dimensions are weakest across all agents.

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_weekly_quality_dimensions
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(week))
ORDER BY (tenant_id, project_id, week, agent_name, dimension_name)
TTL week + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toMonday(session_started_at)                   AS week,
    agent_name,
    dim_name                                       AS dimension_name,
    count()                                        AS eval_count,
    sum(dim_score)                                 AS total_dim_score,
    sum(dim_score * dim_score)                     AS total_dim_score_sq
FROM abl_platform.quality_evaluations
ARRAY JOIN
    dimension_names AS dim_name,
    dimension_scores AS dim_score
GROUP BY tenant_id, project_id, week, agent_name, dimension_name;
```

**Why weekly?** Dimension-level drill-down is a slower-cadence analysis (weekly reviews, QBRs). Daily granularity for 10 dimensions x N agents creates too many rows in the MV for the marginal benefit.

#### MV 3: Score Distribution Histogram

Backs the score distribution chart (bell curve / histogram). Pre-buckets scores into 0.5-wide bins.

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_quality_score_distribution
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name, score_bucket)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at)                              AS date,
    agent_name,
    floor(overall_score * 2) / 2                            AS score_bucket,
    count()                                                 AS bucket_count
FROM abl_platform.quality_evaluations
GROUP BY tenant_id, project_id, date, agent_name, score_bucket;
```

Score buckets: 1.0, 1.5, 2.0, 2.5, 3.0, 3.5, 4.0, 4.5, 5.0 (for a 1-5 scale).

---

### 3.10 Tenant Isolation

Every ClickHouse table and MV includes `tenant_id` as:

1. The first column in ORDER BY -- ensures data locality per tenant.
2. The first element of PARTITION BY -- ensures partition pruning.
3. A mandatory filter in every query -- enforced at the API layer.

The analytics route middleware (`requireProjectScope`) extracts `tenantId` from the auth context and injects it into every query as a parameterized value `{tenantId:String}`. No query is executed without this filter. This matches the existing pattern in `apps/runtime/src/routes/analytics.ts`.

---

### 3.11 Re-processing Strategy

When a customer changes the rubric (or model, or context), historical evaluations become stale. The re-processing mechanism:

1. **Backfill trigger**: Customer clicks "Re-process Historical Data" in Studio (see Phase 2 section 2.10). The API sets `backfillStatus = 'running'` on the pipeline config.

2. **Backfill scope**: The pipeline queries sessions within `lookbackDays` that were evaluated with a prior `config_version`:

   ```sql
   SELECT DISTINCT session_id, session_started_at
   FROM abl_platform.quality_evaluations FINAL
   WHERE tenant_id = {tenantId}
     AND project_id = {projectId}
     AND config_version < {currentConfigVersion}
     AND session_started_at >= now() - INTERVAL {lookbackDays} DAY
   ORDER BY session_started_at ASC
   ```

3. **Insert new rows**: Each re-evaluated session produces a new row with `processed_at = now()` and `config_version = current`.

4. **Deduplication**: `ReplacingMergeTree(processed_at)` deduplicates by `(tenant_id, project_id, session_id)`. The newer row (higher `processed_at`) survives after merge. Queries use `FINAL` or `argMax` for pre-merge accuracy.

5. **MV impact**: Materialized views are insert-triggered -- they see the new row and add to their sums. This means MVs will temporarily double-count until the base table merges. For MV queries, the API applies the same `FINAL` or re-aggregation pattern.

6. **Cache invalidation**: On backfill completion, all Redis cache keys for this tenant+project+pipeline are invalidated (see Phase 5).

---

# Phase 4: Presentation Design

## Completed Checklist

- [x] **4.1** Identify the primary dashboard/widget this pipeline powers
- [x] **4.2** Define the "At a Glance" metric (single number the exec sees)
- [x] **4.3** Define the time-series chart (trend over time)
- [x] **4.4** Define the breakdown/distribution view (by agent, by intent, by channel)
- [x] **4.5** Define the drill-down path (from metric -> conversations -> single conversation)
- [x] **4.6** Define the comparison view (this week vs last, agent A vs agent B)
- [x] **4.7** Define export/report format (CSV, scheduled email)
- [x] **4.8** Define alert presentation (in-app notification, email, Slack)
- [x] **4.9** Specify the API endpoints needed to serve each view
- [x] **4.10** For each view, write the ClickHouse query that backs it

---

### 4.1 Primary Dashboard

**Navigation path**: `Studio > Project > Analytics > Quality`

The Quality dashboard is the executive-facing view. It answers: "How well are our agents performing?" It is organized into four tiers:

```
Tier 1: Scorecard (At a Glance)       -- 3-second answer for the VP
Tier 2: Trend & Distribution          -- 30-second analysis for the manager
Tier 3: Breakdown Tables              -- 5-minute drill-down for the analyst
Tier 4: Conversation Drill-Down       -- deep investigation for QA teams
```

---

### 4.2 "At a Glance" -- Scorecard

The single most important widget. Three cards showing the headline metrics:

```
+---------------------------------------------------------------------+
|  QUALITY SCORECARD                                    Period: 7 days |
+---------------------------------------------------------------------+
|                                                                     |
|  +-------------------+  +-------------------+  +------------------+ |
|  |  Overall Quality  |  |  Flagged Convos   |  |  Critical Convos | |
|  |                   |  |                   |  |                  | |
|  |      3.82         |  |      127          |  |      14          | |
|  |     /5.00         |  |     (5.4%)        |  |     (0.6%)       | |
|  |                   |  |                   |  |                  | |
|  |   ^ +0.14         |  |   v -23           |  |   v -3           | |
|  |  vs prior 7d      |  |  vs prior 7d      |  |  vs prior 7d     | |
|  +-------------------+  +-------------------+  +------------------+ |
|                                                                     |
|  Evaluated: 2,347 conversations  |  Confidence: 0.89 avg           |
|  Config version: 7               |  Model: claude-haiku-4-5         |
+---------------------------------------------------------------------+
```

**Cards**:

| Card                   | Value                                 | Delta           | Color Logic                                |
| ---------------------- | ------------------------------------- | --------------- | ------------------------------------------ |
| Overall Quality        | `avg(overall_score)`                  | vs prior period | Green if delta > 0, red if delta < 0       |
| Flagged Conversations  | `count WHERE flagged=1` + percentage  | vs prior period | Green if count decreased, red if increased |
| Critical Conversations | `count WHERE critical=1` + percentage | vs prior period | Green if count decreased, red if increased |

**Footer metadata**: Total evaluated count, avg confidence, current config version, model used.

---

### 4.3 Time-Series Chart (Trend)

Dual-axis chart: quality score (left Y) and conversation volume (right Y) over time.

```
  Quality                                                 Volume
  5.0 |                                                  | 400
      |                                                  |
  4.0 |         *---*                                    | 300
      |    *---*     *---*   *---*---*                   |
  3.0 | *-*               *-*         *---*             | 200
      |                                    *---*        |
  2.0 |                                                  | 100
      |   ___   ___   ___   ___   ___   ___   ___       |
  1.0 |  |   | |   | |   | |   | |   | |   | |   |     | 0
      +--+---+-+---+-+---+-+---+-+---+-+---+-+---+------+
        Mon   Tue   Wed   Thu   Fri   Sat   Sun

  --- Avg Quality Score    === Conversation Volume
  *** Flagged rate (%)     ... Confidence band (+/- 1 stddev)
```

**Data layers**:

1. **Average quality score** (line, primary): `total_score / conversation_count` per day from MV.
2. **Confidence band** (shaded area): +/- 1 standard deviation computed from `total_score_sq`.
3. **Conversation volume** (bar, secondary axis): `conversation_count` per day from MV.
4. **Flagged rate** (dotted line, optional toggle): `flagged_count / conversation_count` per day.

**Granularity options**: hourly (1-3 day periods), daily (4-90 day periods), weekly (91-365 day periods).

---

### 4.4 Breakdown / Distribution Views

#### 4.4a Breakdown by Agent

Horizontal bar chart + table showing per-agent quality performance:

```
+---------------------------------------------------------------------+
|  QUALITY BY AGENT                                     Period: 7 days |
+---------------------------------------------------------------------+
|                                                                     |
|  Agent              Score   Convos   Flagged   Helpfulness  Accuracy|
|  ----------------------------------------------------------------- |
|  BillingAgent       4.21    823      12 (1%)   4.35         4.18   |
|  |=================|                                                |
|                                                                     |
|  NetworkAgent       3.87    612      34 (6%)   3.92         3.78   |
|  |===============|                                                  |
|                                                                     |
|  AccountAgent       3.54    489      41 (8%)   3.67         3.41   |
|  |=============|                                                    |
|                                                                     |
|  CoverageAgent      2.91    423      40 (9%)   3.12         2.68   |
|  |==========|  [!]                                                  |
|                                                                     |
+---------------------------------------------------------------------+
```

The `[!]` indicator appears when an agent's score is below the flag threshold.

#### 4.4b Breakdown by Channel

Same format, grouping by channel:

```
  Channel        Score   Convos   Flagged
  web_chat       3.94    1,245    52 (4%)
  voice          3.67    789      61 (8%)
  whatsapp       3.82    313      14 (4%)
```

#### 4.4c Breakdown by Dimension (Radar / Heatmap)

Shows which evaluation dimensions are strongest/weakest across the project:

```
+---------------------------------------------------------------------+
|  DIMENSION PERFORMANCE                                Period: 7 days |
+---------------------------------------------------------------------+
|                                                                     |
|  Dimension          Avg Score   Trend    Lowest Agent               |
|  ----------------------------------------------------------------- |
|  Helpfulness        3.92        ^ +0.08  CoverageAgent (3.12)      |
|  Accuracy           3.71        v -0.12  CoverageAgent (2.68)      |
|  Professionalism    4.14        ^ +0.03  AccountAgent (3.89)       |
|  Technical Accuracy 3.45        = +0.00  NetworkAgent (3.21)       |
|  Compliance         4.32        ^ +0.15  BillingAgent (4.01)       |
|                                                                     |
+---------------------------------------------------------------------+
```

#### 4.4d Score Distribution (Histogram)

```
+---------------------------------------------------------------------+
|  SCORE DISTRIBUTION                                   Period: 7 days |
+---------------------------------------------------------------------+
|                                                                     |
|  Count                                                              |
|  600 |                                                              |
|      |                     ____                                     |
|  400 |                ____|    |____                                |
|      |          _____|              |_____                          |
|  200 |    _____|                          |_____                   |
|      |   |                                      |____              |
|    0 +---+------+------+------+------+------+------+------+---     |
|       1.0   1.5   2.0   2.5   3.0   3.5   4.0   4.5   5.0        |
|                                                                     |
|       |CRITICAL|  FLAG  |       GOOD        |   EXCELLENT  |       |
|                                                                     |
+---------------------------------------------------------------------+
```

Red/yellow/green zones are drawn based on `criticalThreshold` and `flagThreshold` from the pipeline config.

---

### 4.5 Drill-Down Path

The executive drill-down path is the most critical UX flow:

```
Level 1: Scorecard
   "Overall quality is 3.82 this week"
          |
          v  (click flagged count, or click agent bar)
Level 2: Flagged Conversation List
   "127 conversations scored below 3.0"
   Sortable table: session, score, agent, time, helpfulness, accuracy
          |
          v  (click a conversation row)
Level 3: Single Conversation View
   Full transcript with per-dimension scores and judge reasoning
   Left panel: conversation messages (user/assistant)
   Right panel: evaluation scorecard + dimension breakdown + reasoning
          |
          v  (click a trace event)
Level 4: Trace Detail (existing)
   LLM calls, tool executions, flow steps
   (Reuses existing trace viewer infrastructure)
```

#### Level 2: Flagged Conversation List

```
+---------------------------------------------------------------------+
|  FLAGGED CONVERSATIONS                     Period: 7d  Filter: <3.0 |
+---------------------------------------------------------------------+
|  Showing 127 conversations sorted by score (ascending)              |
|                                                                     |
|  Session ID     Score  Agent          Time        Help  Acc   Prof  |
|  ----------------------------------------------------------------- |
|  sess-a8f32..   1.40   CoverageAgent  Mar 2 14:23  1.8   1.0   1.4 |
|  sess-b91c4..   1.80   NetworkAgent   Mar 2 09:11  2.0   1.5   1.9 |
|  sess-c23d1..   2.10   AccountAgent   Mar 1 16:45  2.3   1.8   2.2 |
|  sess-d45e2..   2.30   BillingAgent   Mar 1 11:30  2.5   2.1   2.3 |
|  ...                                                                |
|                                                                     |
|  [1] [2] [3] ... [6]   Showing 1-20 of 127                         |
|                                                                     |
|  Filters: [Score range ▾] [Agent ▾] [Channel ▾] [Date range ▾]    |
+---------------------------------------------------------------------+
```

#### Level 3: Single Conversation View

```
+---------------------------------------------------------------------+
|  CONVERSATION QUALITY REVIEW                   Session: sess-a8f32.. |
+---------------------------------------------------------------------+
|                                                                     |
|  +--LEFT PANEL (60%)------------------+ +--RIGHT PANEL (40%)------+ |
|  |                                    | |                         | |
|  |  Transcript                        | |  EVALUATION SCORECARD   | |
|  |  --------------------------------  | |                         | |
|  |                                    | |  Overall: 1.4 / 5.0    | |
|  |  [14:23:01] User:                  | |  Method: weighted       | |
|  |  I've been trying to upgrade my    | |  Confidence: 0.92       | |
|  |  plan for three days now and       | |  Config v7              | |
|  |  nobody can help me.               | |                         | |
|  |                                    | |  DIMENSIONS             | |
|  |  [14:23:04] Assistant:             | |  ---------------------- | |
|  |  I understand you'd like to        | |  Helpfulness:   1.8 [!] | |
|  |  upgrade your plan. Let me look    | |  Accuracy:      1.0 [!] | |
|  |  into that for you.                | |  Professionalism: 1.4[!]| |
|  |                                    | |                         | |
|  |  [14:23:04] Tool: check_plan(...)  | |  JUDGE REASONING        | |
|  |  Result: { plan: "Enterprise",     | |  ---------------------- | |
|  |    eligible_upgrades: [...] }      | |  The agent failed to    | |
|  |                                    | |  acknowledge the        | |
|  |  [14:23:06] Assistant:             | |  customer's frustration | |
|  |  Your current plan is Enterprise.  | |  about 3 days of failed | |
|  |  Would you like to hear about      | |  attempts. The plan     | |
|  |  our upgrade options?              | |  information provided   | |
|  |                                    | |  was incorrect -- the   | |
|  |  [14:23:15] User:                  | |  tool returned "Fiber   | |
|  |  THAT'S NOT WHAT I ASKED. I        | |  Plus" but the agent    | |
|  |  already know my plan. I need      | |  said "Enterprise."     | |
|  |  to UPGRADE it.                    | |  The tone was adequate  | |
|  |                                    | |  but lacked empathy     | |
|  |  ...                               | |  given the customer's   | |
|  |                                    | |  visible frustration.   | |
|  +------------------------------------+ +-------------------------+ |
|                                                                     |
|  [View Full Trace]  [Export]  [Mark as Reviewed]                    |
+---------------------------------------------------------------------+
```

---

### 4.6 Comparison View

#### Period-over-Period Comparison

```
+---------------------------------------------------------------------+
|  QUALITY COMPARISON                  This Week vs Last Week         |
+---------------------------------------------------------------------+
|                                                                     |
|  Metric                This Week    Last Week    Delta              |
|  ----------------------------------------------------------------- |
|  Overall Score         3.82         3.68         +0.14  (^ 3.8%)   |
|  Helpfulness           3.92         3.81         +0.11  (^ 2.9%)   |
|  Accuracy              3.71         3.83         -0.12  (v 3.1%)   |
|  Professionalism       4.14         4.11         +0.03  (^ 0.7%)   |
|  Flagged Rate          5.4%         6.3%         -0.9pp (v 14.3%)  |
|  Critical Rate         0.6%         0.7%         -0.1pp (v 14.3%)  |
|  Evaluated Count       2,347        2,201        +146              |
|                                                                     |
+---------------------------------------------------------------------+
```

#### Agent-vs-Agent Comparison

```
+---------------------------------------------------------------------+
|  AGENT COMPARISON                                     Period: 7 days |
+---------------------------------------------------------------------+
|                                                                     |
|  Dimension          BillingAgent    NetworkAgent    Delta           |
|  ----------------------------------------------------------------- |
|  Overall            4.21            3.87            +0.34           |
|  Helpfulness        4.35            3.92            +0.43           |
|  Accuracy           4.18            3.78            +0.40           |
|  Professionalism    4.11            3.91            +0.20           |
|  Flagged Rate       1.5%            5.6%            -4.1pp          |
|  Volume             823             612             +211            |
|                                                                     |
+---------------------------------------------------------------------+
```

---

### 4.7 Export / Report Format

#### CSV Export

Headers:

```
session_id,session_started_at,agent_name,channel,overall_score,overall_method,
helpfulness,accuracy,professionalism,dimension_names,dimension_scores,
flagged,critical,confidence,model_id,config_version,judge_reasoning
```

- `dimension_names` and `dimension_scores` are pipe-delimited within the CSV cell (e.g., `helpfulness|accuracy|professionalism`).
- `judge_reasoning` is included but truncated to 500 chars with `[truncated]` suffix.
- Maximum export window: 90 days (to bound query cost).
- Maximum rows: 100,000 (paginated background export for larger datasets).

#### Scheduled Email Report (future, v2)

Weekly digest email with:

- Scorecard snapshot (overall score, flagged count, trend arrow).
- Top 5 worst-scoring conversations (links to drill-down).
- Dimension trend sparklines.

---

### 4.8 Alert Presentation

#### In-App (Watchtower Integration)

When a conversation scores below `criticalThreshold`:

```
+---------------------------------------------------------------------+
|  [!] CRITICAL QUALITY ALERT                          Just now       |
+---------------------------------------------------------------------+
|  Conversation sess-a8f32.. scored 1.4/5.0 (critical threshold: 2.0)|
|  Agent: CoverageAgent  |  Channel: web_chat                        |
|  Lowest dimension: Accuracy (1.0)                                   |
|  [View Conversation]  [Dismiss]                                     |
+---------------------------------------------------------------------+
```

When `autoEscalateOnCritical` is enabled, the alert also appears in the configured Slack channel / email.

#### Slack Integration (via existing webhook infrastructure)

```
:rotating_light: Quality Alert — Critical Score
Session: sess-a8f32..
Score: 1.4 / 5.0 (threshold: 2.0)
Agent: CoverageAgent | Channel: web_chat
Lowest: Accuracy (1.0)
<link|View in Studio>
```

---

### 4.9 API Endpoints

All endpoints are mounted under the existing analytics router pattern:

```
/api/projects/:projectId/analytics/quality/...
```

Auth: `authMiddleware` + `requireProjectScope('projectId')` + `requireProjectPermission(req, res, 'session:read')`.

Rate limiting: `tenantRateLimit('request')`.

---

#### Endpoint 1: Summary (Scorecard + Trend)

```
GET /api/projects/:projectId/analytics/quality/summary
    ?period=7d
    &granularity=daily
```

**Query parameters**:

| Param         | Type     | Default   | Validation                                            |
| ------------- | -------- | --------- | ----------------------------------------------------- |
| `period`      | `string` | `'7d'`    | One of: `1d`, `3d`, `7d`, `14d`, `30d`, `90d`, `365d` |
| `granularity` | `string` | `'daily'` | One of: `hourly`, `daily`, `weekly`                   |

**Response** `200 OK`:

```json
{
  "success": true,
  "data": {
    "scorecard": {
      "overallScore": 3.82,
      "overallScorePrior": 3.68,
      "overallScoreDelta": 0.14,
      "conversationCount": 2347,
      "flaggedCount": 127,
      "flaggedRate": 0.054,
      "flaggedCountPrior": 150,
      "criticalCount": 14,
      "criticalRate": 0.006,
      "criticalCountPrior": 17,
      "avgConfidence": 0.89,
      "configVersion": 7,
      "modelId": "claude-haiku-4-5"
    },
    "timeSeries": [
      {
        "date": "2026-02-25",
        "avgScore": 3.71,
        "stddevScore": 0.82,
        "conversationCount": 312,
        "flaggedCount": 21,
        "flaggedRate": 0.067,
        "avgHelpfulness": 3.85,
        "avgAccuracy": 3.63,
        "avgProfessionalism": 4.09
      },
      {
        "date": "2026-02-26",
        "avgScore": 3.89,
        "stddevScore": 0.74,
        "conversationCount": 345,
        "flaggedCount": 15,
        "flaggedRate": 0.043,
        "avgHelpfulness": 3.97,
        "avgAccuracy": 3.78,
        "avgProfessionalism": 4.12
      }
    ],
    "period": { "from": "2026-02-25T00:00:00Z", "to": "2026-03-04T00:00:00Z" },
    "granularity": "daily"
  }
}
```

**Backing ClickHouse query** (hits MV):

```sql
-- Scorecard: current period
SELECT
    sum(conversation_count)                        AS conversation_count,
    sum(total_score) / sum(conversation_count)     AS avg_score,
    sum(flagged_count)                             AS flagged_count,
    sum(critical_count)                            AS critical_count,
    sum(total_confidence) / sum(conversation_count) AS avg_confidence
FROM abl_platform.mv_daily_quality_scores
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {periodStart:Date}
  AND date < {periodEnd:Date};

-- Scorecard: prior period (for delta)
SELECT
    sum(conversation_count)                        AS conversation_count,
    sum(total_score) / sum(conversation_count)     AS avg_score,
    sum(flagged_count)                             AS flagged_count,
    sum(critical_count)                            AS critical_count
FROM abl_platform.mv_daily_quality_scores
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {priorPeriodStart:Date}
  AND date < {priorPeriodEnd:Date};

-- Time series
SELECT
    date,
    sum(conversation_count)                            AS conversation_count,
    sum(total_score) / sum(conversation_count)         AS avg_score,
    sqrt(
        sum(total_score_sq) / sum(conversation_count)
        - pow(sum(total_score) / sum(conversation_count), 2)
    )                                                  AS stddev_score,
    sum(flagged_count)                                 AS flagged_count,
    sum(total_helpfulness) / sum(helpfulness_count)    AS avg_helpfulness,
    sum(total_accuracy) / sum(accuracy_count)          AS avg_accuracy,
    sum(total_professionalism) / sum(professionalism_count) AS avg_professionalism
FROM abl_platform.mv_daily_quality_scores
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {periodStart:Date}
  AND date < {periodEnd:Date}
GROUP BY date
ORDER BY date ASC;
```

---

#### Endpoint 2: Breakdown

```
GET /api/projects/:projectId/analytics/quality/breakdown
    ?period=7d
    &dimension=agent_name
```

**Query parameters**:

| Param       | Type     | Default        | Validation                                                          |
| ----------- | -------- | -------------- | ------------------------------------------------------------------- |
| `period`    | `string` | `'7d'`         | Same as summary                                                     |
| `dimension` | `string` | `'agent_name'` | One of: `agent_name`, `channel`, `dimension` (evaluation dimension) |

**Response** `200 OK`:

```json
{
  "success": true,
  "data": {
    "dimension": "agent_name",
    "breakdown": [
      {
        "key": "BillingAgent",
        "avgScore": 4.21,
        "conversationCount": 823,
        "flaggedCount": 12,
        "flaggedRate": 0.015,
        "avgHelpfulness": 4.35,
        "avgAccuracy": 4.18,
        "avgProfessionalism": 4.11,
        "p25Score": 3.8,
        "p75Score": 4.6
      },
      {
        "key": "CoverageAgent",
        "avgScore": 2.91,
        "conversationCount": 423,
        "flaggedCount": 40,
        "flaggedRate": 0.095,
        "avgHelpfulness": 3.12,
        "avgAccuracy": 2.68,
        "avgProfessionalism": 2.93,
        "p25Score": 2.4,
        "p75Score": 3.4
      }
    ],
    "period": { "from": "2026-02-25T00:00:00Z", "to": "2026-03-04T00:00:00Z" }
  }
}
```

**Backing ClickHouse queries**:

For `dimension=agent_name` (hits MV):

```sql
SELECT
    agent_name                                     AS key,
    sum(conversation_count)                        AS conversation_count,
    sum(total_score) / sum(conversation_count)     AS avg_score,
    sum(flagged_count)                             AS flagged_count,
    sum(total_helpfulness) / sum(helpfulness_count) AS avg_helpfulness,
    sum(total_accuracy) / sum(accuracy_count)      AS avg_accuracy,
    sum(total_professionalism) / sum(professionalism_count) AS avg_professionalism
FROM abl_platform.mv_daily_quality_scores
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {periodStart:Date}
  AND date < {periodEnd:Date}
GROUP BY agent_name
ORDER BY avg_score DESC;
```

For `dimension=agent_name` with percentiles (hits base table, slower -- only used if client requests percentiles):

```sql
SELECT
    agent_name                                     AS key,
    avg(overall_score)                             AS avg_score,
    count()                                        AS conversation_count,
    quantile(0.25)(overall_score)                  AS p25_score,
    quantile(0.75)(overall_score)                  AS p75_score
FROM abl_platform.quality_evaluations FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {periodStart:DateTime64}
  AND session_started_at < {periodEnd:DateTime64}
GROUP BY agent_name
ORDER BY avg_score DESC;
```

For `dimension=dimension` (evaluation dimension breakdown, hits weekly MV):

```sql
SELECT
    dimension_name                                  AS key,
    sum(eval_count)                                AS conversation_count,
    sum(total_dim_score) / sum(eval_count)         AS avg_score,
    sqrt(
        sum(total_dim_score_sq) / sum(eval_count)
        - pow(sum(total_dim_score) / sum(eval_count), 2)
    )                                              AS stddev_score
FROM abl_platform.mv_weekly_quality_dimensions
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND week >= {periodStart:Date}
  AND week < {periodEnd:Date}
GROUP BY dimension_name
ORDER BY avg_score ASC;
```

---

#### Endpoint 3: Conversation List

```
GET /api/projects/:projectId/analytics/quality/conversations
    ?period=7d
    &filter=score_lt:3.0
    &sortBy=overall_score
    &sortOrder=asc
    &agent=CoverageAgent
    &channel=web_chat
    &page=1
    &pageSize=20
```

**Query parameters**:

| Param       | Type     | Default           | Validation                                                                                                |
| ----------- | -------- | ----------------- | --------------------------------------------------------------------------------------------------------- |
| `period`    | `string` | `'7d'`            | Same as summary                                                                                           |
| `filter`    | `string` | (none)            | Predicate: `score_lt:N`, `score_gt:N`, `flagged`, `critical`, `confidence_lt:N`                           |
| `sortBy`    | `string` | `'overall_score'` | One of: `overall_score`, `session_started_at`, `helpfulness`, `accuracy`, `professionalism`, `confidence` |
| `sortOrder` | `string` | `'asc'`           | One of: `asc`, `desc`                                                                                     |
| `agent`     | `string` | (none)            | Filter by agent name                                                                                      |
| `channel`   | `string` | (none)            | Filter by channel                                                                                         |
| `page`      | `number` | `1`               | Min: 1                                                                                                    |
| `pageSize`  | `number` | `20`              | Min: 1, max: 100                                                                                          |

**Response** `200 OK`:

```json
{
  "success": true,
  "data": {
    "conversations": [
      {
        "sessionId": "sess-a8f32c1e",
        "sessionStartedAt": "2026-03-02T14:23:01.000Z",
        "agentName": "CoverageAgent",
        "channel": "web_chat",
        "overallScore": 1.4,
        "overallMethod": "weighted",
        "helpfulness": 1.8,
        "accuracy": 1.0,
        "professionalism": 1.4,
        "flagged": true,
        "critical": true,
        "confidence": 0.92,
        "configVersion": 7
      }
    ],
    "pagination": {
      "page": 1,
      "pageSize": 20,
      "totalCount": 127,
      "totalPages": 7
    },
    "period": { "from": "2026-02-25T00:00:00Z", "to": "2026-03-04T00:00:00Z" }
  }
}
```

**Backing ClickHouse query**:

```sql
-- Count query (for pagination)
SELECT count() AS total
FROM abl_platform.quality_evaluations FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {periodStart:DateTime64}
  AND session_started_at < {periodEnd:DateTime64}
  AND overall_score < {scoreLt:Float32}         -- from filter=score_lt:3.0
  AND agent_name = {agent:String}               -- optional
  AND channel = {channel:String};               -- optional

-- Data query
SELECT
    session_id,
    session_started_at,
    agent_name,
    channel,
    overall_score,
    overall_method,
    helpfulness,
    accuracy,
    professionalism,
    flagged,
    critical,
    confidence,
    config_version
FROM abl_platform.quality_evaluations FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {periodStart:DateTime64}
  AND session_started_at < {periodEnd:DateTime64}
  AND overall_score < {scoreLt:Float32}
  AND agent_name = {agent:String}
  AND channel = {channel:String}
ORDER BY overall_score ASC
LIMIT {pageSize:UInt32}
OFFSET {offset:UInt32};
```

---

#### Endpoint 4: Single Conversation Detail

```
GET /api/projects/:projectId/analytics/quality/conversation/:sessionId
```

**Response** `200 OK`:

```json
{
  "success": true,
  "data": {
    "evaluation": {
      "sessionId": "sess-a8f32c1e",
      "sessionStartedAt": "2026-03-02T14:23:01.000Z",
      "processedAt": "2026-03-02T14:30:15.000Z",
      "agentName": "CoverageAgent",
      "agentVersion": "1.3.0",
      "channel": "web_chat",
      "overallScore": 1.4,
      "overallMethod": "weighted",
      "dimensions": [
        {
          "name": "helpfulness",
          "displayName": "Helpfulness",
          "score": 1.8,
          "rationale": "The agent failed to acknowledge the customer's frustration about repeated failed attempts over 3 days. While the agent offered to look into the upgrade, it re-stated known information (current plan) rather than addressing the actual request."
        },
        {
          "name": "accuracy",
          "displayName": "Accuracy",
          "score": 1.0,
          "rationale": "Critical factual error: the tool returned plan name 'Fiber Plus' but the agent told the customer their plan was 'Enterprise'. This is a direct misrepresentation of tool data."
        },
        {
          "name": "professionalism",
          "displayName": "Professionalism",
          "score": 1.4,
          "rationale": "The agent's tone was adequate initially but did not adapt when the customer showed clear frustration signals (ALL CAPS, repetition). No empathy statements were used."
        }
      ],
      "judgeReasoning": "Overall, this conversation represents a significant quality failure. The agent made a factual error by misquoting the customer's plan...",
      "flagged": true,
      "critical": true,
      "confidence": 0.92,
      "modelId": "claude-haiku-4-5",
      "configVersion": 7,
      "processingMs": 4521,
      "inputTokens": 2840,
      "outputTokens": 892
    },
    "transcript": [
      {
        "messageId": "msg-001",
        "role": "user",
        "content": "I've been trying to upgrade my plan for three days now and nobody can help me.",
        "timestamp": "2026-03-02T14:23:01.000Z"
      },
      {
        "messageId": "msg-002",
        "role": "assistant",
        "content": "I understand you'd like to upgrade your plan. Let me look into that for you.",
        "timestamp": "2026-03-02T14:23:04.000Z"
      },
      {
        "messageId": "msg-003",
        "role": "tool",
        "content": "{\"toolName\": \"check_plan\", \"result\": {\"plan\": \"Fiber Plus\", \"eligible_upgrades\": [\"Enterprise\", \"Enterprise Plus\"]}}",
        "timestamp": "2026-03-02T14:23:04.500Z"
      }
    ]
  }
}
```

**Backing ClickHouse queries**:

```sql
-- Evaluation data (primary key lookup, fastest possible)
SELECT *
FROM abl_platform.quality_evaluations FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_id = {sessionId:String};

-- Transcript (from messages table)
SELECT message_id, role, content, created_at, channel, metadata
FROM abl_platform.messages
WHERE tenant_id = {tenantId:String}
  AND session_id = {sessionId:String}
ORDER BY created_at ASC;
```

The transcript `content` field is encrypted. The API layer calls `EncryptionService.decryptAndDecompressForTenant()` per message before returning. The `judge_reasoning` and `dimension_rationales` are decompressed (gzip) at read time.

---

#### Endpoint 5: Export

```
GET /api/projects/:projectId/analytics/quality/export
    ?period=30d
    &format=csv
    &filter=flagged
```

**Query parameters**:

| Param     | Type     | Default | Validation                     |
| --------- | -------- | ------- | ------------------------------ |
| `period`  | `string` | `'30d'` | Max: `90d`                     |
| `format`  | `string` | `'csv'` | One of: `csv`, `json`          |
| `filter`  | `string` | (none)  | Same as conversations endpoint |
| `agent`   | `string` | (none)  | Filter by agent                |
| `channel` | `string` | (none)  | Filter by channel              |

**Response**: `200 OK` with `Content-Type: text/csv` and `Content-Disposition: attachment; filename="quality-export-2026-03-03.csv"`.

For exports exceeding 10,000 rows, the response is `202 Accepted` with a job ID. The client polls `GET /api/projects/:projectId/analytics/quality/export/:jobId` for completion, then downloads the file from a pre-signed URL.

**Backing query** (streaming):

```sql
SELECT
    session_id,
    session_started_at,
    agent_name,
    agent_version,
    channel,
    overall_score,
    overall_method,
    dimension_names,
    dimension_scores,
    helpfulness,
    accuracy,
    professionalism,
    flagged,
    critical,
    confidence,
    model_id,
    config_version,
    judge_reasoning
FROM abl_platform.quality_evaluations FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {periodStart:DateTime64}
  AND session_started_at < {periodEnd:DateTime64}
  AND flagged = 1
ORDER BY session_started_at DESC
FORMAT CSVWithNames;
```

Uses ClickHouse native CSV format for streaming without buffering the entire result set in memory.

---

### 4.10 Query Coverage Matrix

Every presentation view is backed by a specific query and data source:

| View                        | Data Source             | Query Target                       | Expected Latency |
| --------------------------- | ----------------------- | ---------------------------------- | ---------------- |
| Scorecard (current + prior) | MV + Redis cache        | `mv_daily_quality_scores`          | < 100ms (cached) |
| Time-series chart           | MV + Redis cache        | `mv_daily_quality_scores`          | < 200ms (cached) |
| Breakdown by agent          | MV                      | `mv_daily_quality_scores`          | < 200ms          |
| Breakdown by channel        | MV                      | `mv_daily_quality_scores`          | < 200ms          |
| Breakdown by dimension      | MV                      | `mv_weekly_quality_dimensions`     | < 300ms          |
| Score distribution          | MV                      | `mv_quality_score_distribution`    | < 200ms          |
| Conversation list           | Base table + FINAL      | `quality_evaluations`              | < 500ms          |
| Single conversation         | Base table + messages   | `quality_evaluations` + `messages` | < 300ms (cached) |
| Period comparison           | MV (two period queries) | `mv_daily_quality_scores`          | < 200ms          |
| Agent comparison            | MV                      | `mv_daily_quality_scores`          | < 200ms          |
| CSV export                  | Base table (streaming)  | `quality_evaluations`              | < 10s for 30d    |

---

# Phase 5: Index & Performance Design

## Completed Checklist

- [x] **5.1** For each Phase 4 query, verify the ClickHouse ORDER BY covers the WHERE + GROUP BY
- [x] **5.2** Design materialized views for high-frequency aggregation queries
- [x] **5.3** Design projection tables for alternative query patterns
- [x] **5.4** Verify partition pruning -- every query must filter by tenant_id + time range
- [x] **5.5** Add skip indices for low-cardinality filter columns
- [x] **5.6** Estimate storage size (rows x row size x retention period)
- [x] **5.7** Plan data lifecycle (warm -> cold -> delete TTLs)
- [x] **5.8** For MongoDB pipeline_configs: add compound index on (tenantId, pipelineType)
- [x] **5.9** Test query performance with realistic data volume
- [x] **5.10** Design cache strategy (Redis cache for dashboard queries, TTL-based invalidation)

---

### 5.1 ORDER BY Coverage Analysis

Base table ORDER BY: `(tenant_id, project_id, session_id)`

| Query                              | WHERE Columns                                              | GROUP BY | ORDER BY Prefix Used | Fast?   | Mitigation                                                                                    |
| ---------------------------------- | ---------------------------------------------------------- | -------- | -------------------- | ------- | --------------------------------------------------------------------------------------------- |
| Single session lookup              | `tenant_id, project_id, session_id`                        | --       | Full prefix          | YES     | Primary key scan                                                                              |
| Conversation list (by score)       | `tenant_id, project_id, session_started_at, overall_score` | --       | First 2 of 3         | PARTIAL | Skip index on `overall_score`, partition prune on `session_started_at` via PARTITION BY month |
| Conversation list (by agent)       | `tenant_id, project_id, agent_name`                        | --       | First 2 of 3         | PARTIAL | Full partition scan filtered by skip index; acceptable for paginated list                     |
| Backfill query (by config_version) | `tenant_id, project_id, config_version`                    | --       | First 2 of 3         | PARTIAL | Infrequent (only during backfill), acceptable                                                 |

All MV queries use the MV's own ORDER BY, which starts with `(tenant_id, project_id, ...)` -- fully aligned with the dashboard query patterns.

| MV                              | ORDER BY                                                    | Primary Query Pattern                                             | Aligned? |
| ------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------- | -------- |
| `mv_daily_quality_scores`       | `(tenant_id, project_id, date, agent_name, channel)`        | `WHERE tenant_id, project_id, date range GROUP BY agent_name`     | YES      |
| `mv_weekly_quality_dimensions`  | `(tenant_id, project_id, week, agent_name, dimension_name)` | `WHERE tenant_id, project_id, week range GROUP BY dimension_name` | YES      |
| `mv_quality_score_distribution` | `(tenant_id, project_id, date, agent_name, score_bucket)`   | `WHERE tenant_id, project_id, date range GROUP BY score_bucket`   | YES      |

---

### 5.2 Materialized Views

Fully defined in Phase 3 section 3.9. Summary of the three MVs:

| MV                              | Engine             | Backs                                                      | Insert Overhead                                                        |
| ------------------------------- | ------------------ | ---------------------------------------------------------- | ---------------------------------------------------------------------- |
| `mv_daily_quality_scores`       | `SummingMergeTree` | Scorecard, time-series, agent breakdown, channel breakdown | Low: 1 row per (date, agent, channel) per insert batch                 |
| `mv_weekly_quality_dimensions`  | `SummingMergeTree` | Dimension breakdown, dimension heatmap                     | Medium: 1 row per (week, agent, dimension) per insert; uses ARRAY JOIN |
| `mv_quality_score_distribution` | `SummingMergeTree` | Score histogram                                            | Low: 1 row per (date, agent, score_bucket) per insert                  |

---

### 5.3 Projection Tables

No separate projection tables are needed for v1. The ORDER BY `(tenant_id, project_id, session_id)` covers the primary per-session lookup, and the MVs cover all aggregation patterns. If conversation list queries sorted by `session_started_at` become slow at scale, a projection can be added:

```sql
-- FUTURE (add if conversation list latency exceeds 500ms at >1M rows/tenant)
ALTER TABLE abl_platform.quality_evaluations
    ADD PROJECTION proj_by_time
    (
        SELECT *
        ORDER BY (tenant_id, project_id, session_started_at, overall_score)
    );

ALTER TABLE abl_platform.quality_evaluations
    MATERIALIZE PROJECTION proj_by_time;
```

This projection would accelerate `WHERE session_started_at >= X ORDER BY overall_score` queries from the conversation list endpoint. Deferred to avoid unnecessary storage overhead until proven needed.

---

### 5.4 Partition Pruning Verification

Every query in Phase 4 includes both `tenant_id` and a time range filter. The PARTITION BY `(tenant_id, toYYYYMM(session_started_at))` ensures:

1. **Tenant isolation at the storage level**: Partitions for tenant A are never scanned when querying tenant B.
2. **Month-level pruning**: A 7-day query touches at most 2 monthly partitions (when the period spans a month boundary).

Verification checklist:

| Query               | Has `tenant_id`? | Has time filter?       | Max partitions scanned                                 |
| ------------------- | ---------------- | ---------------------- | ------------------------------------------------------ |
| Summary (scorecard) | YES (from auth)  | YES (`period` param)   | 2 (MV partitions)                                      |
| Time-series         | YES              | YES                    | 2-4 (MV partitions for 90d)                            |
| Breakdown           | YES              | YES                    | 2 (MV partitions)                                      |
| Conversation list   | YES              | YES                    | 2 (base table)                                         |
| Single conversation | YES              | NO (session_id lookup) | All partitions for tenant (but ORDER BY makes it fast) |
| Export              | YES              | YES                    | 3-4 (base table for 90d)                               |

The single conversation lookup does not filter by time -- it uses the primary key `(tenant_id, project_id, session_id)`. ClickHouse resolves this efficiently via the primary key index regardless of partition count. Adding `session_started_at` to the query would require the caller to know the date, which they may not have. Acceptable trade-off.

---

### 5.5 Skip Indices

All skip indices are defined in the table DDL (section 3.7). Summary:

```sql
INDEX idx_overall_score overall_score TYPE minmax GRANULARITY 4
INDEX idx_flagged       flagged       TYPE set(2) GRANULARITY 4
INDEX idx_critical      critical      TYPE set(2) GRANULARITY 4
INDEX idx_helpfulness   helpfulness   TYPE minmax  GRANULARITY 4
INDEX idx_accuracy      accuracy      TYPE minmax  GRANULARITY 4
INDEX idx_confidence    confidence    TYPE minmax  GRANULARITY 4
```

**Index type rationale**:

| Column          | Cardinality          | Index Type | Why                                                                                               |
| --------------- | -------------------- | ---------- | ------------------------------------------------------------------------------------------------- |
| `overall_score` | Continuous (1.0-5.0) | `minmax`   | Range queries (`< 3.0`). Minmax stores min/max per granule; skips granules where min > threshold. |
| `flagged`       | Binary (0, 1)        | `set(2)`   | Equality filter (`= 1`). Set index stores distinct values per granule.                            |
| `critical`      | Binary (0, 1)        | `set(2)`   | Same as flagged.                                                                                  |
| `helpfulness`   | Continuous (1.0-5.0) | `minmax`   | Range queries for dimension-specific filtering.                                                   |
| `accuracy`      | Continuous (1.0-5.0) | `minmax`   | Same.                                                                                             |
| `confidence`    | Continuous (0.0-1.0) | `minmax`   | Filter low-confidence evaluations (`< 0.7`).                                                      |

GRANULARITY 4 means the index covers 4 granules (4 x 8192 = 32,768 rows) per index entry. This is the platform standard (matching `messages.idx_pii` and `traces.idx_type`).

---

### 5.6 Storage Estimation

#### Base Table: `quality_evaluations`

Per-row size estimate:

| Field Group                                             | Fields                                          | Estimated Bytes  |
| ------------------------------------------------------- | ----------------------------------------------- | ---------------- |
| Identity (tenant_id, project_id, session_id)            | 3 strings (~36 bytes each)                      | 108              |
| Timestamps (session_started_at, processed_at)           | 2 x 8 bytes                                     | 16               |
| Context (agent_name, agent_version, channel)            | 3 x ~20 bytes (LowCardinality refs)             | 60               |
| Scores (overall_score, method, 3 denormalized)          | 5 x 4 bytes + 20 bytes                          | 40               |
| Arrays (names, scores, rationales)                      | ~100 + ~40 + ~500 bytes (compressed rationales) | 640              |
| Flags (flagged, critical)                               | 2 x 1 byte                                      | 2                |
| Judge reasoning (compressed)                            | ~800 bytes (after gzip)                         | 800              |
| Provenance (model_id, config_version, confidence, etc.) | ~50 bytes                                       | 50               |
| **Total per row (uncompressed)**                        |                                                 | **~1,716 bytes** |

ClickHouse compression (ZSTD, column-oriented):

- String columns: ~5-8x compression ratio.
- Numeric columns: ~10-20x (T64, Gorilla, DoubleDelta).
- Estimated compressed row size: **~250-350 bytes**.

#### Volume Projections

| Scenario                      | Conversations/Day | Rows/Year  | Uncompressed/Year | Compressed/Year |
| ----------------------------- | ----------------- | ---------- | ----------------- | --------------- |
| Small tenant (startup)        | 100               | 36,500     | ~60 MB            | ~10 MB          |
| Medium tenant (enterprise)    | 5,000             | 1,825,000  | ~3 GB             | ~500 MB         |
| Large tenant (contact center) | 50,000            | 18,250,000 | ~30 GB            | ~5 GB           |

#### MV Storage

MVs store aggregated rows. Per MV:

| MV                              | Rows/Day (medium tenant)  | Row Size   | Annual Storage (compressed) |
| ------------------------------- | ------------------------- | ---------- | --------------------------- |
| `mv_daily_quality_scores`       | ~20 (agents x channels)   | ~200 bytes | ~1.5 MB                     |
| `mv_weekly_quality_dimensions`  | ~50 (agents x dimensions) | ~150 bytes | ~0.4 MB                     |
| `mv_quality_score_distribution` | ~100 (agents x buckets)   | ~80 bytes  | ~0.3 MB                     |
| **MV total**                    |                           |            | **~2.2 MB/year**            |

MV overhead is negligible relative to the base table.

#### Platform-Wide (100 tenants)

| Component                             | Storage/Year    |
| ------------------------------------- | --------------- |
| Base table (100 tenants, mixed sizes) | ~50 GB          |
| MVs (100 tenants)                     | ~220 MB         |
| **Total**                             | **~50 GB/year** |

With 730-day retention, steady-state disk usage: ~100 GB. Well within typical ClickHouse deployment capacity.

---

### 5.7 Data Lifecycle

```
Day 0                    Day 90                  Day 365                Day 730
  |--- HOT (SSD) ----------|--- WARM (HDD/S3) -----|--- COLD (Object) ----|--- DELETE

  Active dashboards        Historical trends        Compliance retention    Purged
  Real-time queries        QBR reports              Annual comparisons
  Full query speed         Slightly slower           Rare access
```

TTL policies (from table DDL):

```
toDateTime(session_started_at) + INTERVAL 90  DAY TO VOLUME 'warm'
toDateTime(session_started_at) + INTERVAL 365 DAY TO VOLUME 'cold'
toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
```

MV TTL: `date/week + INTERVAL 730 DAY DELETE` (aligned with base table).

**Important**: The base table TTL is based on `session_started_at`, not `processed_at`. A backfill that re-processes a 30-day-old conversation writes a row with `session_started_at` 30 days ago, so it follows the same lifecycle as the original evaluation. This prevents backfill results from extending data retention beyond the original conversation's timeline.

---

### 5.8 MongoDB Indices

Pipeline configuration indices (already defined in Phase 2, repeated here for completeness):

```javascript
// Primary lookup: find config for a specific pipeline in a project
db.pipeline_configs.createIndex({ tenantId: 1, pipelineType: 1, projectId: 1 }, { unique: true });

// Find all enabled pipelines for a tenant (scheduler/backfill)
db.pipeline_configs.createIndex({ tenantId: 1, enabled: 1, pipelineType: 1 });

// Find configs by backfill status (admin monitoring)
db.pipeline_configs.createIndex({ backfillStatus: 1, tenantId: 1 });
```

---

### 5.9 Query Performance Expectations

Performance targets and testing plan for each query type at realistic data volumes:

| Query                             | Target Volume                                  | Target Latency | Test Method              |
| --------------------------------- | ---------------------------------------------- | -------------- | ------------------------ |
| Scorecard (MV, cached)            | 10K rows in MV                                 | < 50ms         | Warm cache hit           |
| Scorecard (MV, cold)              | 10K rows in MV                                 | < 100ms        | Direct MV query          |
| Time-series (MV, 30 days daily)   | 30 rows per agent x 10 agents = 300 rows       | < 100ms        | Direct MV query          |
| Agent breakdown (MV)              | 10-50 agents                                   | < 100ms        | Direct MV query          |
| Dimension breakdown (MV)          | 10 dimensions x 10 agents x 4 weeks = 400 rows | < 150ms        | Direct MV query          |
| Score distribution (MV)           | 9 buckets x 10 agents x 30 days = 2,700 rows   | < 100ms        | Direct MV query          |
| Conversation list (base, FINAL)   | 1M rows, filtered to ~5K, paginated to 20      | < 500ms        | Base table with FINAL    |
| Single conversation (primary key) | 1M rows                                        | < 50ms         | Primary key point lookup |
| Export (streaming, 30 days)       | 150K rows                                      | < 10s          | Streaming CSV            |

**Testing approach**: Generate synthetic data at medium-tenant volume (5K conversations/day x 90 days = 450K rows). Insert via `INSERT INTO ... SELECT` with randomized scores. Run each query with `EXPLAIN` to verify index usage, then measure wall-clock time.

```sql
-- Synthetic data generation (for testing)
INSERT INTO abl_platform.quality_evaluations
SELECT
    'test-tenant' AS tenant_id,
    'test-project' AS project_id,
    concat('sess-', toString(number)) AS session_id,
    now() - INTERVAL (number % 90) DAY - INTERVAL (rand() % 86400) SECOND AS session_started_at,
    now() AS processed_at,
    arrayElement(['BillingAgent', 'NetworkAgent', 'AccountAgent', 'CoverageAgent', 'SupportAgent'],
                 1 + number % 5) AS agent_name,
    '1.0.0' AS agent_version,
    arrayElement(['web_chat', 'voice', 'whatsapp'], 1 + number % 3) AS channel,
    1.0 + rand() * 4.0 / 4294967295 AS overall_score,
    'weighted' AS overall_method,
    ['helpfulness', 'accuracy', 'professionalism'] AS dimension_names,
    [1.0 + rand() * 4.0 / 4294967295,
     1.0 + rand() * 4.0 / 4294967295,
     1.0 + rand() * 4.0 / 4294967295] AS dimension_scores,
    ['rationale 1', 'rationale 2', 'rationale 3'] AS dimension_rationales,
    dimension_scores[1] AS helpfulness,
    dimension_scores[2] AS accuracy,
    dimension_scores[3] AS professionalism,
    if(overall_score < 3.0, 1, 0) AS flagged,
    if(overall_score < 2.0, 1, 0) AS critical,
    'Full reasoning text...' AS judge_reasoning,
    'claude-haiku-4-5' AS model_id,
    7 AS config_version,
    0.85 + rand() * 0.15 / 4294967295 AS confidence,
    3000 + rand() % 5000 AS processing_ms,
    2000 + rand() % 3000 AS input_tokens,
    500 + rand() % 1000 AS output_tokens
FROM numbers(450000);
```

---

### 5.10 Redis Cache Strategy

#### Cache Key Patterns

```
analytics:{tenantId}:{projectId}:quality:summary:{period}:{granularity}
analytics:{tenantId}:{projectId}:quality:breakdown:{period}:{dimension}
analytics:{tenantId}:{projectId}:quality:distribution:{period}
analytics:{tenantId}:{projectId}:quality:conversation:{sessionId}
```

#### TTL Policy

| Cache Key        | TTL            | Rationale                                                                         |
| ---------------- | -------------- | --------------------------------------------------------------------------------- |
| `summary:*`      | 300s (5 min)   | Dashboard loads frequently. Balance freshness vs query cost.                      |
| `breakdown:*`    | 300s (5 min)   | Same dashboard, usually loaded together with summary.                             |
| `distribution:*` | 600s (10 min)  | Histogram is a secondary view, slightly staler is acceptable.                     |
| `conversation:*` | 3600s (1 hour) | Immutable once processed (evaluation result does not change unless re-processed). |

**NOT cached**:

- Conversation list (filter/sort/page combinations are too varied to cache effectively).
- Export (streaming, one-off).

#### Cache Implementation

Uses the existing `RedisCacheProvider` from `packages/eventstore/src/query/cache-providers.ts`:

```typescript
// Cache key construction
function qualityCacheKey(tenantId: string, projectId: string, ...segments: string[]): string {
  return `analytics:${tenantId}:${projectId}:quality:${segments.join(':')}`;
}

// Cache-aside pattern for summary endpoint
async function getQualitySummary(
  tenantId: string,
  projectId: string,
  period: string,
  granularity: string,
): Promise<QualitySummaryResponse> {
  const cacheKey = qualityCacheKey(tenantId, projectId, 'summary', period, granularity);

  // Check cache
  const cached = await cache.get(cacheKey);
  if (cached) return JSON.parse(cached);

  // Query ClickHouse
  const result = await queryClickHouse(/* ... */);

  // Cache result
  await cache.set(cacheKey, JSON.stringify(result), 300);

  return result;
}
```

#### Cache Invalidation

Three invalidation triggers:

1. **Pipeline batch completion**: When the pipeline processes a batch of conversations, invalidate summary + breakdown + distribution for the affected tenant+project.

   ```typescript
   async function invalidateQualityCache(tenantId: string, projectId: string): Promise<void> {
     // SCAN + DEL pattern (not KEYS -- KEYS blocks Redis)
     const pattern = `analytics:${tenantId}:${projectId}:quality:*`;
     // Use Redis SCAN with COUNT 100, then DEL each batch
   }
   ```

2. **Config change**: When the customer modifies the pipeline configuration, invalidate all cache for that tenant+project+pipeline.

3. **TTL expiry**: Automatic. No action needed.

**Conversation cache** is invalidated only on re-processing (when a specific session's evaluation is replaced). This is a targeted delete:

```typescript
await cache.del(qualityCacheKey(tenantId, projectId, 'conversation', sessionId));
```

#### Cache Size Estimation

Per tenant+project:

- Summary (7 period variants x 3 granularities): ~21 keys x ~5 KB = ~105 KB
- Breakdown (7 periods x 3 dimensions): ~21 keys x ~10 KB = ~210 KB
- Distribution (7 periods): ~7 keys x ~3 KB = ~21 KB
- Conversations (recent accessed, ~100): ~100 keys x ~20 KB = ~2 MB

**Per tenant+project**: ~2.3 MB
**Platform-wide (100 tenants, 5 projects avg)**: ~1.15 GB

This is well within typical Redis deployment capacity (4-8 GB allocated for analytics cache).

---

## Summary of All SQL Objects

### Tables

| Name                               | Engine                                       | Purpose                    |
| ---------------------------------- | -------------------------------------------- | -------------------------- |
| `abl_platform.quality_evaluations` | `ReplicatedReplacingMergeTree(processed_at)` | Primary evaluation results |

### Materialized Views

| Name                                         | Engine             | Source                             | Purpose                                         |
| -------------------------------------------- | ------------------ | ---------------------------------- | ----------------------------------------------- |
| `abl_platform.mv_daily_quality_scores`       | `SummingMergeTree` | `quality_evaluations`              | Scorecard, time-series, agent/channel breakdown |
| `abl_platform.mv_weekly_quality_dimensions`  | `SummingMergeTree` | `quality_evaluations` (ARRAY JOIN) | Per-dimension breakdown and heatmap             |
| `abl_platform.mv_quality_score_distribution` | `SummingMergeTree` | `quality_evaluations`              | Score histogram                                 |

### Skip Indices

| Index               | Column          | Type     | Purpose                    |
| ------------------- | --------------- | -------- | -------------------------- |
| `idx_overall_score` | `overall_score` | `minmax` | Range filter `< threshold` |
| `idx_flagged`       | `flagged`       | `set(2)` | Equality filter `= 1`      |
| `idx_critical`      | `critical`      | `set(2)` | Equality filter `= 1`      |
| `idx_helpfulness`   | `helpfulness`   | `minmax` | Dimension range filter     |
| `idx_accuracy`      | `accuracy`      | `minmax` | Dimension range filter     |
| `idx_confidence`    | `confidence`    | `minmax` | Low-confidence filter      |

### MongoDB Indices

| Collection         | Index                                                     | Purpose          |
| ------------------ | --------------------------------------------------------- | ---------------- |
| `pipeline_configs` | `{ tenantId: 1, pipelineType: 1, projectId: 1 }` (unique) | Config lookup    |
| `pipeline_configs` | `{ tenantId: 1, enabled: 1, pipelineType: 1 }`            | Scheduler scan   |
| `pipeline_configs` | `{ backfillStatus: 1, tenantId: 1 }`                      | Admin monitoring |

### Redis Cache Keys

| Pattern                                                  | TTL   | Purpose                           |
| -------------------------------------------------------- | ----- | --------------------------------- |
| `analytics:{tid}:{pid}:quality:summary:{period}:{gran}`  | 300s  | Scorecard + trend                 |
| `analytics:{tid}:{pid}:quality:breakdown:{period}:{dim}` | 300s  | Agent/channel/dimension breakdown |
| `analytics:{tid}:{pid}:quality:distribution:{period}`    | 600s  | Score histogram                   |
| `analytics:{tid}:{pid}:quality:conversation:{sid}`       | 3600s | Single conversation detail        |

---

## Drill-Down Path: Complete Flow

The most important user journey, end-to-end:

```
1. Executive opens Quality dashboard
   -> GET /analytics/quality/summary?period=7d&granularity=daily
   -> Redis cache hit (< 50ms) or MV query (< 100ms)
   -> Sees: "Quality score 3.82, 127 flagged conversations"

2. Executive clicks "127 flagged" number
   -> GET /analytics/quality/conversations?period=7d&filter=flagged&sortBy=overall_score&sortOrder=asc
   -> Base table query with FINAL (< 500ms)
   -> Sees: Paginated list of worst-scoring conversations

3. QA manager clicks the worst conversation (score 1.4)
   -> GET /analytics/quality/conversation/sess-a8f32c1e
   -> Primary key lookup (< 50ms) + message decrypt (~200ms)
   -> Redis cache for subsequent views (3600s TTL)
   -> Sees: Full transcript + per-dimension scores + judge reasoning
   -> Can identify: factual error (accuracy 1.0), missed empathy (professionalism 1.4)

4. QA manager clicks "View Full Trace"
   -> Navigates to existing trace viewer (already built)
   -> Sees: LLM calls, tool call with wrong interpretation, flow steps
```

Total time from dashboard open to root cause identification: < 30 seconds (if caches are warm) to < 2 minutes (cold path).
