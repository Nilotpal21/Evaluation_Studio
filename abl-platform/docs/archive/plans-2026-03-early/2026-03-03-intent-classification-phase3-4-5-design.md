# Phase 3 + 4 + 5: Output Schema, Presentation, & Index Design -- Intent Classification Pipeline

> **Pipeline**: Intent Classification
> **Pipeline Type Key**: `intent_classification`
> **Output Table**: `abl_platform.intent_classifications` (ClickHouse)
> **Config Collection**: `pipeline_configs` (MongoDB)
> **Prerequisite Documents**:
>
> - Phase 1: Input Data Readiness (in analytics skill)
> - Phase 2: `/docs/plans/2026-03-03-intent-classification-phase2-config-schema.md`
>   **Date**: 2026-03-03

---

## Table of Contents

1. [Phase 3: Output Schema Design](#phase-3-output-schema-design)
2. [Phase 4: Presentation Design](#phase-4-presentation-design)
3. [Phase 5: Index & Performance Design](#phase-5-index--performance-design)

---

# Phase 3: Output Schema Design

## Checklist

- [x] 3.1 Define the primary output record (one per conversation? per message? per time bucket?)
- [x] 3.2 Define all output fields with types and descriptions
- [x] 3.3 Include provenance fields (model_version, config_version, processed_at)
- [x] 3.4 Include confidence/quality indicators
- [x] 3.5 Design for both per-record queries AND aggregation queries
- [x] 3.6 Choose storage: ClickHouse (analytics) vs MongoDB (config/lookup) vs both
- [x] 3.7 Define ClickHouse table engine, partitioning, and ORDER BY
- [x] 3.8 Define TTL policy aligned with source data TTLs
- [x] 3.9 Design materialized views for common aggregation patterns
- [x] 3.10 Ensure tenant isolation (tenant_id in every table, every query)
- [x] 3.11 Plan for re-processing: how to replace old results when config changes

---

### 3.1 Primary Output Record Granularity

**One row per conversation per classification run.**

In single-label mode (`multiLabel: false`), each conversation produces exactly one row. The primary intent is stored in the `intent` column and any runner-up intents in `secondary_intents`.

In multi-label mode (`multiLabel: true`), each conversation still produces **one row**. The primary intent (highest confidence) is in `intent`, and all additional intents populate `secondary_intents`. This one-row-per-conversation design was chosen over one-row-per-intent for three reasons:

1. **Aggregation simplicity** -- `COUNT(*)` = conversation count, no deduplication required.
2. **Dashboard performance** -- "Top intents" is `GROUP BY intent`, no window functions.
3. **Re-processing** -- `ReplacingMergeTree` deduplicates by `(tenant_id, project_id, session_id)`, one row to replace.

If a future requirement needs per-intent-per-conversation rows (e.g., per-intent confidence tracking in multi-label mode), a secondary table can be added without disrupting the primary table.

---

### 3.2 Complete Output Field Definitions

```sql
CREATE TABLE IF NOT EXISTS abl_platform.intent_classifications (
    -- ─── Identity ─────────────────────────────────────────────────────
    tenant_id              String           COMMENT 'Tenant isolation key. Present in every query.',
    project_id             String           COMMENT 'Project scope. Present in every query.',
    session_id             String           COMMENT 'Conversation session ID. Unique within tenant+project.',

    -- ─── Timing ───────────────────────────────────────────────────────
    session_started_at     DateTime64(3)    COMMENT 'When the conversation began. Used for time-range partitioning and trend queries.',
    processed_at           DateTime64(3)    COMMENT 'When this classification was produced. ReplacingMergeTree version column -- latest wins on re-processing.',

    -- ─── Context Dimensions (for GROUP BY) ────────────────────────────
    agent_name             LowCardinality(String) COMMENT 'Primary agent that handled the conversation. Used for per-agent intent breakdown.',
    channel                LowCardinality(String) COMMENT 'Conversation channel (web_chat, voice, whatsapp, slack, etc.). Used for per-channel filtering.',

    -- ─── Classification Output ────────────────────────────────────────
    intent                 LowCardinality(String) COMMENT 'Primary classified intent label. Machine-readable name from taxonomy (e.g., billing_refund). Or auto-discovered label.',
    intent_display         String                 COMMENT 'Human-readable display name for the intent (e.g., "Billing - Refund Request"). Denormalized from taxonomy for dashboard display without join.',
    parent_intent          LowCardinality(String) COMMENT 'Parent category in hierarchical taxonomy (e.g., "billing" for "billing_refund"). Empty string if top-level or no taxonomy.',
    confidence             Float32                COMMENT 'Model confidence in primary intent. Range 0.0-1.0. Used for quality filtering and threshold application.',
    secondary_intents      Array(String)          COMMENT 'Additional detected intents in multi-label mode. Empty array in single-label mode. Each element is an intent name.',
    secondary_confidences  Array(Float32)         COMMENT 'Confidence scores corresponding to secondary_intents. Same length and order as secondary_intents.',
    is_auto_discovered     UInt8                  COMMENT '1 if this intent was not in the customer taxonomy and was auto-discovered. 0 if it matched a taxonomy category.',

    -- ─── Input Context ────────────────────────────────────────────────
    input_message_count    UInt16                 COMMENT 'Number of messages sent to the classifier. Depends on inputMessageStrategy config. Useful for debugging classification quality.',
    input_strategy         LowCardinality(String) COMMENT 'Which message selection strategy was used: first_user, first_n_user, all_user, full_transcript. Provenance for reproducibility.',

    -- ─── Session Outcome (denormalized from session metadata) ────────
    session_status         LowCardinality(String) COMMENT 'Session outcome: completed, escalated, abandoned, error. Denormalized for cross-filtering intent vs outcome without join.',
    session_message_count  UInt16                 COMMENT 'Total messages in the conversation (not just input to classifier). For volume context.',

    -- ─── Provenance ───────────────────────────────────────────────────
    model_id               LowCardinality(String) COMMENT 'LLM model used for classification (e.g., claude-haiku-4-5). For reproducibility and cost attribution.',
    provider               LowCardinality(String) COMMENT 'LLM provider (anthropic, openai, gemini). For cost and performance comparison.',
    config_version         UInt32                 COMMENT 'Pipeline config version at time of processing. Allows detecting mixed-version results.',
    taxonomy_version       UInt32                 COMMENT 'Taxonomy version at time of processing. Allows detecting results from stale taxonomy.',
    pipeline_version       LowCardinality(String) COMMENT 'Code version of the classification pipeline. For debugging pipeline regressions.',
    processing_ms          UInt32                 COMMENT 'Wall-clock time in milliseconds for this classification. For performance monitoring.',
    input_tokens           UInt32                 COMMENT 'LLM input tokens consumed. For cost tracking.',
    output_tokens          UInt32                 COMMENT 'LLM output tokens consumed. For cost tracking.',
    estimated_cost         Float32                COMMENT 'Estimated USD cost of this classification. Computed from token counts and model pricing.'
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL session_started_at + INTERVAL 730 DAY DELETE
COMMENT 'Per-conversation intent classification results. One row per conversation. ReplacingMergeTree deduplicates by (tenant_id, project_id, session_id), keeping the row with the latest processed_at.';
```

#### Field Justification Table

| Field                   | Purpose                                                       | Query Pattern                                              |
| ----------------------- | ------------------------------------------------------------- | ---------------------------------------------------------- |
| `tenant_id`             | Isolation. In every WHERE clause.                             | `WHERE tenant_id = ?`                                      |
| `project_id`            | Scoping. In every WHERE clause.                               | `WHERE project_id = ?`                                     |
| `session_id`            | Record identity. Drill-down to conversation.                  | `WHERE session_id = ?`                                     |
| `session_started_at`    | Time-range filtering, partitioning, trend analysis.           | `WHERE session_started_at BETWEEN ? AND ?`                 |
| `processed_at`          | ReplacingMergeTree version. Identifies latest classification. | Implicit (dedup), explicit: `argMax(intent, processed_at)` |
| `agent_name`            | Breakdown by agent.                                           | `GROUP BY agent_name`                                      |
| `channel`               | Breakdown by channel.                                         | `GROUP BY channel`                                         |
| `intent`                | Primary classification label. Core output.                    | `GROUP BY intent`, `WHERE intent = ?`                      |
| `intent_display`        | Denormalized for dashboards. Avoids taxonomy lookup.          | `SELECT intent_display`                                    |
| `parent_intent`         | Hierarchical drill-down (category > subcategory).             | `GROUP BY parent_intent`, `WHERE parent_intent = ?`        |
| `confidence`            | Quality indicator. Threshold filtering.                       | `WHERE confidence >= ?`, `avg(confidence)`                 |
| `secondary_intents`     | Multi-label support.                                          | `arrayExists(x -> x = ?, secondary_intents)`               |
| `secondary_confidences` | Paired confidence for secondary intents.                      | Analysis queries only.                                     |
| `is_auto_discovered`    | Distinguish taxonomy matches from discoveries.                | `WHERE is_auto_discovered = 1`, `sum(is_auto_discovered)`  |
| `input_message_count`   | Debugging. Understanding why a classification differs.        | SELECT only (detail view).                                 |
| `input_strategy`        | Provenance. Reproducibility.                                  | SELECT only (detail view).                                 |
| `session_status`        | Cross-analysis: intent by outcome.                            | `GROUP BY session_status`, pivot charts.                   |
| `session_message_count` | Context. Correlate conversation length with intent.           | `avg(session_message_count)` in breakdowns.                |
| `model_id`              | Provenance. Cost attribution.                                 | `WHERE model_id = ?`, cost breakdown.                      |
| `provider`              | Provenance. Provider comparison.                              | `GROUP BY provider`                                        |
| `config_version`        | Provenance. Detect mixed-version results.                     | `SELECT DISTINCT config_version`                           |
| `taxonomy_version`      | Provenance. Detect stale-taxonomy results.                    | `SELECT DISTINCT taxonomy_version`                         |
| `pipeline_version`      | Provenance. Debug regressions.                                | Diagnostic queries.                                        |
| `processing_ms`         | Performance monitoring.                                       | `avg(processing_ms)`, `quantile(0.95)(processing_ms)`      |
| `input_tokens`          | Cost tracking.                                                | `sum(input_tokens)`                                        |
| `output_tokens`         | Cost tracking.                                                | `sum(output_tokens)`                                       |
| `estimated_cost`        | Cost tracking. Daily cost cap enforcement.                    | `sum(estimated_cost)`                                      |

---

### 3.3 Provenance Fields

Every classification record includes a full provenance chain enabling exact reproduction and debugging:

| Provenance Field                 | Source                                                       | Purpose                                              |
| -------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------- |
| `processed_at`                   | Pipeline clock at write time                                 | Ordering, deduplication, "when was this classified?" |
| `model_id`                       | Resolved from `IntentModelConfig` or tenant default          | Which LLM produced this output                       |
| `provider`                       | Resolved alongside `model_id`                                | Provider attribution                                 |
| `config_version`                 | `pipeline_configs.version` at processing time                | Link back to exact config snapshot                   |
| `taxonomy_version`               | `pipeline_configs.config.taxonomyVersion` at processing time | Link back to exact taxonomy snapshot                 |
| `pipeline_version`               | Build constant (e.g., git SHA or semver)                     | Code version that ran the classification             |
| `input_strategy`                 | `config.inputMessageStrategy` at processing time             | Which messages were selected                         |
| `input_message_count`            | Count of messages actually sent to LLM                       | Exact input size                                     |
| `input_tokens` / `output_tokens` | LLM response metadata                                        | Token-level cost attribution                         |
| `estimated_cost`                 | Computed from tokens + model pricing                         | Dollar cost attribution                              |

**Provenance query**: "Which conversations were classified with an older taxonomy?"

```sql
SELECT count() AS stale_count, taxonomy_version
FROM abl_platform.intent_classifications FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= today() - 30
GROUP BY taxonomy_version
ORDER BY taxonomy_version ASC
```

---

### 3.4 Confidence and Quality Indicators

**Primary quality indicator**: `confidence` (Float32, 0.0-1.0).

The confidence score serves multiple purposes:

1. **Threshold application**: At query time, results with `confidence < confidenceThreshold` are labeled as the `unknownIntentLabel`. This is applied at read time, not write time, so changing the threshold does not require re-processing.

2. **Quality monitoring**: `avg(confidence)` per day/agent/intent tracks classifier reliability over time. A declining average signals taxonomy drift or model degradation.

3. **Export filtering**: CSV exports can include a confidence column so analysts can apply their own thresholds.

**Secondary quality indicators**:

| Indicator             | Usage                                                                            |
| --------------------- | -------------------------------------------------------------------------------- |
| `is_auto_discovered`  | High ratio of auto-discovered intents suggests the taxonomy needs expansion.     |
| `processing_ms`       | Unusually high values may indicate token-heavy conversations or LLM degradation. |
| `input_message_count` | Low counts (1 message) may correlate with lower confidence.                      |

**Quality query**: "Distribution of confidence scores"

```sql
SELECT
    multiIf(
        confidence >= 0.9, '0.9-1.0 (high)',
        confidence >= 0.7, '0.7-0.9 (good)',
        confidence >= 0.5, '0.5-0.7 (marginal)',
        '0.0-0.5 (low)'
    ) AS confidence_band,
    count() AS conversation_count,
    round(count() * 100.0 / sum(count()) OVER (), 1) AS pct
FROM abl_platform.intent_classifications FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
  AND session_started_at < {to:DateTime64(3)}
GROUP BY confidence_band
ORDER BY confidence_band
```

---

### 3.5 Per-Record vs Aggregation Query Design

The schema supports both patterns:

**Per-record queries** (drill-down, single conversation detail):

- Primary key lookup: `WHERE tenant_id = ? AND project_id = ? AND session_id = ?` -- ORDER BY aligned, O(1).
- Conversation list with filters: `WHERE tenant_id = ? AND project_id = ? AND intent = ? ORDER BY session_started_at DESC LIMIT 50` -- requires skip index on `intent`.
- Full record detail: `SELECT * FROM ... FINAL WHERE session_id = ?` -- returns all provenance fields.

**Aggregation queries** (dashboard charts):

- Served primarily from materialized views (Section 3.9), not the base table.
- Base table aggregation for custom filters: `GROUP BY intent` with `count()`, `avg(confidence)`.
- Cross-dimension: `GROUP BY intent, agent_name` for intent-by-agent heatmaps.

**Design trade-off**: The ORDER BY `(tenant_id, project_id, session_id)` optimizes per-record lookups. For time-series aggregations, materialized views pre-sort by date. This is the standard pattern used across all pipeline output tables in the platform.

---

### 3.6 Storage Decision

| Concern                         | ClickHouse                                                                    | MongoDB                                                                                                                                                            |
| ------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Classification results          | Primary. High-volume append-only, time-series aggregation, dashboard queries. | No.                                                                                                                                                                |
| Pipeline configuration          | No.                                                                           | Primary. `pipeline_configs` collection. Low-volume, document-level updates. See Phase 2 doc.                                                                       |
| Auto-discovered intent clusters | No.                                                                           | Future consideration. If auto-discovery produces cluster metadata (centroids, exemplar messages), store in MongoDB for review workflows. Not in scope for Phase 3. |

**Decision: ClickHouse only for output.** MongoDB is already used for configuration (Phase 2). No additional MongoDB collections are needed for Phase 3.

---

### 3.7 Table Engine, Partitioning, and ORDER BY

**Engine**: `ReplacingMergeTree(processed_at)`

- **Why ReplacingMergeTree**: When the pipeline re-processes a conversation (config change, model update, backfill), it inserts a new row with an updated `processed_at`. ClickHouse deduplicates by ORDER BY key during background merges, retaining only the row with the latest `processed_at`. This is the standard pattern for pipeline output tables (see analytics-pipeline-development skill, Section "ReplacingMergeTree for Re-processing").
- **Important**: Deduplication is eventual. Queries requiring exact dedup use `FINAL` or `argMax(field, processed_at)`.

**Partitioning**: `PARTITION BY (tenant_id, toYYYYMM(session_started_at))`

- `tenant_id` in partition key ensures physical tenant isolation. DROP PARTITION for tenant offboarding is O(metadata), not O(data).
- `toYYYYMM(session_started_at)` enables monthly partition pruning for time-range queries.
- Every query includes both `tenant_id` and a time range, so partition pruning is always effective.
- Monthly granularity balances partition count (12 per tenant per year) against partition size.

**ORDER BY**: `(tenant_id, project_id, session_id)`

- Optimized for the most common per-record lookup: "Get classification for session X".
- Also supports "list all sessions for project Y" efficiently.
- Time-series aggregations use materialized views (Section 3.9) which have their own ORDER BY with date.

---

### 3.8 TTL Policy

```sql
TTL session_started_at + INTERVAL 730 DAY DELETE
```

**730 days (2 years)**. Rationale:

| Source Data        | Source TTL                   | Pipeline Output TTL | Rationale                                                                                                                                                  |
| ------------------ | ---------------------------- | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messages.content` | 90 days                      | 730 days            | Pipeline output is a derived summary -- the original message text is gone after 90 days, but the intent label remains useful for long-term trend analysis. |
| `traces`           | 90 days (7d warm / 30d cold) | 730 days            | Same as above.                                                                                                                                             |
| `llm_metrics`      | 730 days                     | 730 days            | Aligned. Both are analytical data with the same retention horizon.                                                                                         |
| `pipeline_configs` | No TTL (MongoDB)             | N/A                 | Config is never auto-expired.                                                                                                                              |

**Why 730 days for a 90-day source?** Intent distribution trends are valuable for year-over-year comparison ("Is billing intent increasing vs last Q1?"). The classification label and confidence are small (< 500 bytes/row) and cheap to store. The source conversation text is not needed once the classification is produced.

**Materialized view TTLs**: All MVs use the same 730-day TTL to remain consistent with the base table.

---

### 3.9 Materialized Views

#### MV 1: Daily Intent Distribution

Pre-aggregates intent counts per day. Backs the time-series trend chart and the intent breakdown bar chart.

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_intent_distribution
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, intent, agent_name, channel)
TTL date + INTERVAL 730 DAY DELETE
COMMENT 'Daily intent distribution. SummingMergeTree: query with sum(conversation_count), sum(total_confidence). Avg confidence = total_confidence / conversation_count.'
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at)                              AS date,
    intent,
    agent_name,
    channel,
    count()                                                 AS conversation_count,
    sum(confidence)                                         AS total_confidence,
    sum(toUInt64(is_auto_discovered))                       AS auto_discovered_count,
    sum(toUInt64(session_status = 'escalated'))              AS escalated_count,
    sum(estimated_cost)                                     AS total_cost,
    sum(input_tokens)                                       AS total_input_tokens,
    sum(output_tokens)                                      AS total_output_tokens
FROM abl_platform.intent_classifications
GROUP BY tenant_id, project_id, date, intent, agent_name, channel;
```

**Usage notes**:

- Average confidence = `sum(total_confidence) / sum(conversation_count)`.
- Escalation rate per intent = `sum(escalated_count) / sum(conversation_count)`.
- The `agent_name` and `channel` dimensions are included so a single MV powers multiple breakdown views (by intent, by agent, by channel). Queries that do not need all dimensions aggregate them away: `GROUP BY tenant_id, project_id, date, intent` sums across agents and channels.

**Why SummingMergeTree**: The SummingMergeTree engine auto-merges rows with matching ORDER BY keys by summing the numeric columns. This makes incremental inserts from the base table collapse into efficient aggregates. Queries must use `sum()` on all numeric columns to get correct results across unmerged parts.

#### MV 2: Daily Parent-Intent Distribution

Pre-aggregates at the parent category level for hierarchical drill-down.

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_parent_intent_distribution
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, parent_intent)
TTL date + INTERVAL 730 DAY DELETE
COMMENT 'Daily parent-intent distribution for hierarchical views. Use parent_intent for top-level category breakdown.'
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at)                 AS date,
    if(parent_intent = '', intent, parent_intent) AS parent_intent,
    count()                                    AS conversation_count,
    sum(confidence)                            AS total_confidence,
    sum(toUInt64(is_auto_discovered))          AS auto_discovered_count
FROM abl_platform.intent_classifications
GROUP BY tenant_id, project_id, date, parent_intent;
```

#### MV 3: Daily Intent-by-Outcome Cross-Tab

Powers the intent vs outcome heatmap and escalation-rate-by-intent analysis.

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_intent_outcome
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, intent, session_status)
TTL date + INTERVAL 730 DAY DELETE
COMMENT 'Daily intent x outcome cross-tab. For analyzing which intents lead to escalation or abandonment.'
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at)    AS date,
    intent,
    session_status,
    count()                       AS conversation_count,
    sum(confidence)               AS total_confidence
FROM abl_platform.intent_classifications
GROUP BY tenant_id, project_id, date, intent, session_status;
```

#### MV 4: Weekly Intent Comparison

Pre-aggregates at weekly granularity for week-over-week comparison views. Avoids summing 7 daily rows at query time.

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_weekly_intent_distribution
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(week_start))
ORDER BY (tenant_id, project_id, week_start, intent)
TTL week_start + INTERVAL 730 DAY DELETE
COMMENT 'Weekly intent distribution for period-over-period comparison.'
AS SELECT
    tenant_id,
    project_id,
    toMonday(session_started_at)              AS week_start,
    intent,
    count()                                   AS conversation_count,
    sum(confidence)                           AS total_confidence,
    sum(toUInt64(is_auto_discovered))         AS auto_discovered_count,
    sum(estimated_cost)                       AS total_cost
FROM abl_platform.intent_classifications
GROUP BY tenant_id, project_id, week_start, intent;
```

---

### 3.10 Tenant Isolation

**Every table and materialized view includes `tenant_id`**:

- In the `PARTITION BY` clause (physical isolation).
- As the first column in the `ORDER BY` (query performance).
- In every query's `WHERE` clause (logical isolation, enforced by the API layer).

**Enforcement points**:

1. **API layer**: `requireProjectScope('projectId')` middleware extracts `tenantId` from auth context. Every ClickHouse query parameterizes `{tenantId:String}`.
2. **ClickHouse**: No cross-tenant queries are possible without explicitly providing a `tenant_id` value. The ORDER BY prefix ensures queries without `tenant_id` scan all partitions (slow enough to be caught in testing).
3. **GDPR cascade**: `DELETE FROM abl_platform.intent_classifications WHERE tenant_id = ?` purges all tenant data. Monthly partitioning means `DROP PARTITION` can be used for efficient bulk deletion.
4. **Pipeline processing**: The pipeline processor always receives `tenantId` from the trigger event and includes it in every output row.

---

### 3.11 Re-Processing Strategy

**Trigger**: Customer changes a config parameter in the `INTENT_REPROCESS_KEYS` set (taxonomy, model, prompt, strategy, etc.) and clicks "Re-process" in Studio.

**Mechanism**: `ReplacingMergeTree(processed_at)` handles idempotent upserts.

```
1. Backfill job queries sessions within lookbackDays
2. For each session, run the classifier with the new config
3. INSERT a new row with the same (tenant_id, project_id, session_id) and a newer processed_at
4. ClickHouse background merges collapse old + new rows, keeping the latest processed_at
5. Until merge completes, queries using FINAL or argMax() return the correct latest result
```

**Mixed-version detection**: During and after backfill, the dashboard shows a banner if multiple `config_version` or `taxonomy_version` values exist in the queried time range:

```sql
SELECT
    count(DISTINCT config_version) AS config_versions,
    count(DISTINCT taxonomy_version) AS taxonomy_versions,
    min(config_version) AS oldest_config,
    max(config_version) AS newest_config
FROM abl_platform.intent_classifications FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
  AND session_started_at < {to:DateTime64(3)}
```

If `config_versions > 1`, show: "Some results were produced with an older configuration (v{oldest_config}). {count} conversations have not been re-processed."

**Materialized view handling**: MVs built on `SummingMergeTree` will contain rows from both old and new inserts. After a full backfill, the old MV rows are not removed (SummingMergeTree only sums, it does not replace). This causes double-counting in the MV.

**Mitigation options** (in priority order):

1. **Preferred**: After a full backfill completes, truncate and rebuild the affected MVs:
   ```sql
   -- Detach MV, truncate target table, re-populate from base
   TRUNCATE TABLE abl_platform.mv_daily_intent_distribution;
   INSERT INTO abl_platform.mv_daily_intent_distribution
   SELECT ... FROM abl_platform.intent_classifications FINAL
   GROUP BY tenant_id, project_id, date, intent, agent_name, channel;
   ```
2. **Alternative**: Query the base table with `FINAL` for the affected time range instead of the MV. Slower but accurate. Use this for small backfills.
3. **Future**: ClickHouse `ReplacingMergeTree` MVs (once stable) would solve this natively.

**Cache invalidation**: After backfill batch completion, invalidate all Redis cache keys matching `analytics:{tenantId}:{projectId}:intent:*`.

---

# Phase 4: Presentation Design

## Checklist

- [x] 4.1 Identify the primary dashboard/widget this pipeline powers
- [x] 4.2 Define the "At a Glance" metric (single number the exec sees)
- [x] 4.3 Define the time-series chart (trend over time)
- [x] 4.4 Define the breakdown/distribution view (by agent, by intent, by channel)
- [x] 4.5 Define the drill-down path (from metric -> conversations -> single conversation)
- [x] 4.6 Define the comparison view (this week vs last, agent A vs agent B)
- [x] 4.7 Define export/report format (CSV, scheduled email)
- [x] 4.8 Define alert presentation (in-app notification, email, Slack)
- [x] 4.9 Specify the API endpoints needed to serve each view
- [x] 4.10 For each view, write the ClickHouse query that backs it

---

### 4.1 Primary Dashboard Widget

The intent classification pipeline powers the **"Intent Analysis" tab** within the Project Analytics section of Studio.

**Navigation**: `Project > Analytics > Intent Analysis`
**Route**: `/projects/:projectId/analytics/intent`

This tab contains four zones:

```
┌────────────────────────────────────────────────────────────────────────────────┐
│  Intent Analysis                                           [7d ▼] [Export ▼]  │
│                                                                                │
│  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐  ┌──────────────┐      │
│  │ Conversations │  │ Top Intent   │  │ Auto-         │  │ Avg          │      │
│  │  Classified   │  │              │  │ Discovered    │  │ Confidence   │      │
│  │    1,247      │  │   billing    │  │    12.3%      │  │   0.83       │      │
│  │  +8.2% vs 7d  │  │  31.2% share │  │  -2.1pp vs 7d │  │  +0.02 vs 7d │      │
│  └──────────────┘  └──────────────┘  └──────────────┘  └──────────────┘      │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────┐      │
│  │  Intent Distribution Over Time                          [daily ▼]  │      │
│  │                                                                     │      │
│  │  100%┤████████████████████████████████████████████████████████████  │      │
│  │      │████  billing  ██  tech_support  ██  account  ██  other ███  │      │
│  │   75%┤████████████████████████████████████████████████████████████  │      │
│  │      │                                                              │      │
│  │   50%┤████████████████████████████████████████████████████████████  │      │
│  │      │                                                              │      │
│  │   25%┤████████████████████████████████████████████████████████████  │      │
│  │      │                                                              │      │
│  │    0%┤────────────────────────────────────────────────────────────  │      │
│  │       Feb 25   Feb 26   Feb 27   Feb 28   Mar 01   Mar 02   Mar 03 │      │
│  └─────────────────────────────────────────────────────────────────────┘      │
│                                                                                │
│  ┌───────────────────────────────┐  ┌────────────────────────────────────┐    │
│  │  Intent Breakdown             │  │  Intent vs Outcome                  │    │
│  │                               │  │                                     │    │
│  │  billing        ████████ 31%  │  │           Completed Escalated Aband │    │
│  │  tech_support   ██████   24%  │  │  billing     68%      22%     10%  │    │
│  │  account_mgmt   █████    19%  │  │  tech_sup    55%      35%     10%  │    │
│  │  cancellation   ████     14%  │  │  account     82%      10%      8%  │    │
│  │  auto:shipping  ██        5%  │  │  cancel      45%      40%     15%  │    │
│  │  unknown        ██        7%  │  │                                     │    │
│  └───────────────────────────────┘  └────────────────────────────────────┘    │
│                                                                                │
│  ┌─────────────────────────────────────────────────────────────────────┐      │
│  │  Recent Conversations                    [Filter by intent ▼] [▼]  │      │
│  │                                                                     │      │
│  │  Session ID     Intent          Confidence  Agent       Time        │      │
│  │  sess_a1b2c3    billing_refund  0.92        Billing     2m ago     │      │
│  │  sess_d4e5f6    tech_connect    0.78        Network     5m ago     │      │
│  │  sess_g7h8i9    cancellation    0.85        Retention   12m ago    │      │
│  │  sess_j1k2l3    unknown         0.45        Billing     15m ago    │      │
│  │                                          [1] [2] [3] ... [25] [>]  │      │
│  └─────────────────────────────────────────────────────────────────────┘      │
└────────────────────────────────────────────────────────────────────────────────┘
```

---

### 4.2 "At a Glance" Metrics (Scorecard)

Four KPI cards at the top of the dashboard:

| Metric                       | Definition                                         | Comparison                                | Query Source                       |
| ---------------------------- | -------------------------------------------------- | ----------------------------------------- | ---------------------------------- |
| **Conversations Classified** | `count()` of classification records in period      | Absolute count + % change vs prior period | MV: `mv_daily_intent_distribution` |
| **Top Intent**               | Intent with highest `conversation_count`           | Share percentage + rank stability         | MV: `mv_daily_intent_distribution` |
| **Auto-Discovered %**        | `auto_discovered_count / conversation_count * 100` | Percentage point change vs prior period   | MV: `mv_daily_intent_distribution` |
| **Avg Confidence**           | `total_confidence / conversation_count`            | Score change vs prior period              | MV: `mv_daily_intent_distribution` |

**Backing query: Summary scorecard**

```sql
-- Current period
SELECT
    sum(conversation_count)                                        AS total_conversations,
    sum(total_confidence) / greatest(sum(conversation_count), 1)   AS avg_confidence,
    sum(auto_discovered_count) * 100.0
        / greatest(sum(conversation_count), 1)                     AS auto_discovered_pct,
    sum(total_cost)                                                AS total_cost
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
```

```sql
-- Top intent
SELECT
    intent,
    sum(conversation_count) AS cnt
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY intent
ORDER BY cnt DESC
LIMIT 1
```

```sql
-- Prior period (for comparison)
-- Same queries with {prior_from:Date} and {prior_to:Date}
-- prior_from = from - (to - from), prior_to = from
```

**API**: `GET /api/projects/:projectId/analytics/intent/summary?period=7d`

**Response**:

```json
{
  "success": true,
  "data": {
    "period": { "from": "2026-02-24", "to": "2026-03-03" },
    "totalConversations": 1247,
    "totalConversationsChange": 8.2,
    "topIntent": {
      "intent": "billing",
      "intentDisplay": "Billing",
      "count": 389,
      "sharePct": 31.2
    },
    "avgConfidence": 0.83,
    "avgConfidenceChange": 0.02,
    "autoDiscoveredPct": 12.3,
    "autoDiscoveredPctChange": -2.1,
    "totalCost": 1.87,
    "mixedVersions": false,
    "configVersion": 3,
    "taxonomyVersion": 3
  }
}
```

---

### 4.3 Time-Series Chart (Trend Over Time)

**Chart type**: Stacked area chart (100% mode available as toggle).

**X-axis**: Date (daily or weekly granularity).
**Y-axis**: Conversation count per intent (absolute) or percentage of total (100% mode).
**Series**: One per intent. Top N intents shown individually; remainder grouped as "Other".

**Backing query: Time-series trend**

```sql
SELECT
    date,
    intent,
    sum(conversation_count) AS cnt,
    sum(total_confidence) / greatest(sum(conversation_count), 1) AS avg_conf
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY date, intent
ORDER BY date ASC, cnt DESC
```

Post-processing in the API layer: group intents beyond top N into "other", compute percentages per day.

**API**: `GET /api/projects/:projectId/analytics/intent/summary?period=7d&granularity=daily`

**Response**:

```json
{
  "success": true,
  "data": {
    "period": { "from": "2026-02-24", "to": "2026-03-03" },
    "granularity": "daily",
    "series": [
      {
        "date": "2026-02-24",
        "total": 178,
        "intents": [
          {
            "intent": "billing",
            "intentDisplay": "Billing",
            "count": 55,
            "pct": 30.9,
            "avgConfidence": 0.84
          },
          {
            "intent": "tech_support",
            "intentDisplay": "Technical Support",
            "count": 43,
            "pct": 24.2,
            "avgConfidence": 0.81
          },
          {
            "intent": "account_mgmt",
            "intentDisplay": "Account Management",
            "count": 34,
            "pct": 19.1,
            "avgConfidence": 0.86
          },
          {
            "intent": "other",
            "intentDisplay": "Other",
            "count": 46,
            "pct": 25.8,
            "avgConfidence": 0.79
          }
        ]
      }
    ]
  }
}
```

---

### 4.4 Breakdown / Distribution Views

Three breakdown dimensions, selectable via tabs or dropdown:

#### 4.4a By Intent (primary view -- horizontal bar chart)

```
Intent Breakdown (7d)                          [▼ By intent]

billing          ████████████████████████████████  389  31.2%   conf: 0.84
tech_support     ████████████████████████          299  24.0%   conf: 0.81
account_mgmt     ███████████████████               237  19.0%   conf: 0.86
cancellation     █████████████                     175  14.0%   conf: 0.83
auto:shipping    ███                                62   5.0%   conf: 0.72  (auto)
unknown          ███                                85   6.8%   conf: 0.41
```

**Backing query**:

```sql
SELECT
    intent,
    sum(conversation_count) AS cnt,
    sum(total_confidence) / greatest(sum(conversation_count), 1) AS avg_confidence,
    sum(auto_discovered_count) AS auto_count,
    sum(escalated_count) AS esc_count
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY intent
ORDER BY cnt DESC
LIMIT 50
```

#### 4.4b By Agent

```
Intent by Agent (7d)                           [▼ By agent]

BillingAgent     billing: 65%  |  account: 20%  |  cancellation: 15%     (412 convs)
NetworkAgent     tech_support: 78%  |  billing: 12%  |  other: 10%       (301 convs)
RetentionAgent   cancellation: 55%  |  billing: 30%  |  account: 15%     (198 convs)
```

**Backing query**:

```sql
SELECT
    agent_name,
    intent,
    sum(conversation_count) AS cnt
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY agent_name, intent
ORDER BY agent_name ASC, cnt DESC
```

#### 4.4c By Channel

Same structure as By Agent but grouped by `channel`.

**API**: `GET /api/projects/:projectId/analytics/intent/breakdown?period=7d&dimension=intent`

Dimension options: `intent`, `agent`, `channel`, `parent_intent`, `outcome`.

**Response**:

```json
{
  "success": true,
  "data": {
    "period": { "from": "2026-02-24", "to": "2026-03-03" },
    "dimension": "intent",
    "totalConversations": 1247,
    "items": [
      {
        "key": "billing",
        "display": "Billing",
        "count": 389,
        "pct": 31.2,
        "avgConfidence": 0.84,
        "isAutoDiscovered": false,
        "escalationRate": 22.1,
        "children": [
          {
            "key": "billing_refund",
            "display": "Billing - Refund Request",
            "count": 201,
            "pct": 16.1
          },
          {
            "key": "billing_dispute",
            "display": "Billing - Charge Dispute",
            "count": 188,
            "pct": 15.1
          }
        ]
      }
    ]
  }
}
```

---

### 4.5 Drill-Down Path

```
Level 0: Scorecard           "1,247 conversations classified"
    |
    v  click "billing" in breakdown chart
Level 1: Filtered list       "389 conversations with intent: billing"
    |
    v  click session row
Level 2: Conversation detail  Full transcript + classification provenance
    |
    v  click "View Trace"
Level 3: Trace detail         LLM calls, tool executions, flow steps (existing trace UI)
```

#### Level 1: Conversation List

```
Conversations: billing (389)                   [Filter ▼] [Sort: newest ▼]

Session          Intent            Confidence  Agent       Channel    Status     Time
sess_a1b2c3d4    billing_refund    0.92        Billing     web_chat   completed  2m ago
sess_e5f6g7h8    billing_dispute   0.78        Billing     whatsapp   escalated  5m ago
sess_i9j0k1l2    billing_refund    0.85        Billing     voice      completed  12m ago
...
                                                [1] [2] [3] ... [8] [>]
```

**Backing query: Conversation list**

```sql
SELECT
    session_id,
    intent,
    intent_display,
    parent_intent,
    confidence,
    agent_name,
    channel,
    session_status,
    session_started_at,
    is_auto_discovered,
    model_id,
    config_version,
    taxonomy_version
FROM abl_platform.intent_classifications FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
  AND session_started_at < {to:DateTime64(3)}
  AND intent = {intent:String}
ORDER BY session_started_at DESC
LIMIT {pageSize:UInt32}
OFFSET {offset:UInt32}
```

**API**: `GET /api/projects/:projectId/analytics/intent/conversations?period=7d&filter=intent:billing&page=1&pageSize=50`

**Response**:

```json
{
  "success": true,
  "data": {
    "filter": { "intent": "billing" },
    "total": 389,
    "page": 1,
    "pageSize": 50,
    "conversations": [
      {
        "sessionId": "sess_a1b2c3d4",
        "intent": "billing_refund",
        "intentDisplay": "Billing - Refund Request",
        "parentIntent": "billing",
        "confidence": 0.92,
        "agentName": "BillingAgent",
        "channel": "web_chat",
        "sessionStatus": "completed",
        "sessionStartedAt": "2026-03-03T14:20:00.000Z",
        "isAutoDiscovered": false,
        "modelId": "claude-haiku-4-5",
        "configVersion": 3,
        "taxonomyVersion": 3
      }
    ]
  }
}
```

#### Level 2: Single Conversation Classification Detail

**API**: `GET /api/projects/:projectId/analytics/intent/conversation/:sessionId`

**Backing queries**: Two parallel queries:

```sql
-- 1. Classification record
SELECT *
FROM abl_platform.intent_classifications FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_id = {sessionId:String}
```

```sql
-- 2. Conversation messages (first N, matching input_strategy)
SELECT message_id, role, content, created_at, channel
FROM abl_platform.messages
WHERE tenant_id = {tenantId:String}
  AND session_id = {sessionId:String}
ORDER BY created_at ASC
LIMIT 20
```

**Response**:

```json
{
  "success": true,
  "data": {
    "classification": {
      "sessionId": "sess_a1b2c3d4",
      "intent": "billing_refund",
      "intentDisplay": "Billing - Refund Request",
      "parentIntent": "billing",
      "confidence": 0.92,
      "secondaryIntents": ["account_mgmt"],
      "secondaryConfidences": [0.31],
      "isAutoDiscovered": false,
      "agentName": "BillingAgent",
      "channel": "web_chat",
      "sessionStatus": "completed",
      "sessionStartedAt": "2026-03-03T14:20:00.000Z",
      "processedAt": "2026-03-03T14:25:12.000Z",
      "inputMessageCount": 3,
      "inputStrategy": "first_n_user",
      "sessionMessageCount": 8,
      "provenance": {
        "modelId": "claude-haiku-4-5",
        "provider": "anthropic",
        "configVersion": 3,
        "taxonomyVersion": 3,
        "pipelineVersion": "1.2.0",
        "processingMs": 823,
        "inputTokens": 412,
        "outputTokens": 87,
        "estimatedCost": 0.0012
      }
    },
    "messages": [
      {
        "role": "user",
        "content": "I was charged twice for my subscription last month",
        "timestamp": "2026-03-03T14:20:00.000Z"
      },
      {
        "role": "assistant",
        "content": "I'm sorry to hear that...",
        "timestamp": "2026-03-03T14:20:02.000Z"
      }
    ]
  }
}
```

---

### 4.6 Comparison View

Two comparison modes:

#### 4.6a Period-over-Period (this week vs last week)

```
Intent Comparison: This Week vs Last Week

                      This Week    Last Week    Change
Total classified       1,247        1,152       +8.2%
billing                31.2%        28.5%       +2.7pp
tech_support           24.0%        26.1%       -2.1pp
cancellation           14.0%        11.3%       +2.7pp  !
auto-discovered        12.3%        14.4%       -2.1pp
avg confidence         0.83         0.81        +0.02
```

**Backing query**:

```sql
SELECT
    multiIf(
        date >= {from:Date} AND date < {to:Date}, 'current',
        date >= {priorFrom:Date} AND date < {priorTo:Date}, 'prior',
        'other'
    ) AS period,
    intent,
    sum(conversation_count) AS cnt,
    sum(total_confidence) / greatest(sum(conversation_count), 1) AS avg_confidence,
    sum(auto_discovered_count) AS auto_count
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {priorFrom:Date}
  AND date < {to:Date}
GROUP BY period, intent
HAVING period != 'other'
ORDER BY period, cnt DESC
```

#### 4.6b Agent-vs-Agent or Channel-vs-Channel

```
Intent Comparison: BillingAgent vs RetentionAgent (7d)

                   BillingAgent    RetentionAgent
billing              65.2%            30.1%
cancellation         15.1%            55.3%
account_mgmt         19.7%            14.6%
avg confidence       0.85             0.82
total convs          412              198
```

**Backing query**: Same MV query as breakdown, filtered to two agent_name values.

**API**: `GET /api/projects/:projectId/analytics/intent/summary?period=7d&compare=prior_period`
**API**: `GET /api/projects/:projectId/analytics/intent/breakdown?period=7d&dimension=intent&compareAgents=BillingAgent,RetentionAgent`

---

### 4.7 Export / Report Format

#### CSV Export

**API**: `GET /api/projects/:projectId/analytics/intent/export?period=30d&format=csv`

**Behavior**:

- Streams results as `text/csv` with `Content-Disposition: attachment; filename=intent-classifications-{projectId}-{date}.csv`.
- Maximum export: 100,000 rows (enforced by LIMIT). For larger exports, use date-range pagination.
- Includes all fields except internal provenance (pipeline_version).

**CSV columns**:

```csv
session_id,session_started_at,agent_name,channel,intent,intent_display,parent_intent,confidence,secondary_intents,is_auto_discovered,session_status,session_message_count,model_id,config_version,taxonomy_version,processing_ms,input_tokens,output_tokens,estimated_cost
```

**Backing query**:

```sql
SELECT
    session_id,
    session_started_at,
    agent_name,
    channel,
    intent,
    intent_display,
    parent_intent,
    confidence,
    arrayStringConcat(secondary_intents, ';') AS secondary_intents,
    is_auto_discovered,
    session_status,
    session_message_count,
    model_id,
    config_version,
    taxonomy_version,
    processing_ms,
    input_tokens,
    output_tokens,
    estimated_cost
FROM abl_platform.intent_classifications FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
  AND session_started_at < {to:DateTime64(3)}
ORDER BY session_started_at DESC
LIMIT 100000
```

#### Scheduled Report (future)

Not in initial scope. When implemented, the report will use the same queries as the summary and breakdown endpoints, rendered as an HTML email with embedded charts. Delivery via the existing BullMQ webhook/email pipeline.

---

### 4.8 Alert Presentation

Intent classification generates alerts for two conditions:

#### Alert 1: New Auto-Discovered Intent Cluster

**Trigger**: Pipeline discovers N conversations (configurable, default 10) assigned to an auto-discovered intent not in the taxonomy.

**Presentation**:

- **In-app**: Notification bell badge + toast: "New intent discovered: 'shipping_delay' (23 conversations in the last 7 days). Consider adding it to your taxonomy."
- **Email**: Subject: "[ABL] New intent discovered in {projectName}: shipping_delay". Body includes count, example conversations, and a link to the taxonomy editor.
- **Slack**: Formatted message with intent name, count, and link.

#### Alert 2: Intent Distribution Anomaly

**Trigger**: Anomaly detection pipeline (separate pipeline, cross-pipeline dependency) detects a significant shift in intent distribution (e.g., cancellation intent spikes 3x).

**Presentation**:

- **In-app**: Red badge on the Intent Analysis tab. Banner: "Cancellation intent spiked to 28% (normally 14%) in the last 24 hours."
- **Email/Slack**: Formatted alert with the anomalous intent, current vs baseline rate, and top contributing factors.

Alert routing uses the existing `AlertChannel` configuration from `AnomalyDetectionConfig`.

---

### 4.9 API Endpoint Specification

All endpoints mounted at `/api/projects/:projectId/analytics/intent/`.

All require:

- `requireAuth` middleware
- `requireProjectScope('projectId')` middleware
- `requireProjectPermission(req, res, 'session:read')` for GET
- `tenantRateLimit('request')` middleware
- `tenantId` extracted from auth context, included in every ClickHouse query

| #   | Method | Path                       | Description                                                      | Cache    |
| --- | ------ | -------------------------- | ---------------------------------------------------------------- | -------- |
| 1   | GET    | `/summary`                 | Scorecard + time-series data                                     | 5 min    |
| 2   | GET    | `/breakdown`               | Distribution by dimension                                        | 5 min    |
| 3   | GET    | `/conversations`           | Paginated conversation list                                      | No cache |
| 4   | GET    | `/conversation/:sessionId` | Single conversation detail                                       | 1 hour   |
| 5   | GET    | `/export`                  | CSV export (streaming)                                           | No cache |
| 6   | GET    | `/health`                  | Pipeline health: config version, backfill status, mixed versions | 1 min    |

#### Endpoint 1: Summary

```
GET /api/projects/:projectId/analytics/intent/summary

Query params:
  period      string  REQUIRED  "7d", "14d", "30d", "90d", or "custom"
  from        string  OPTIONAL  ISO 8601 date (required if period=custom)
  to          string  OPTIONAL  ISO 8601 date (required if period=custom)
  granularity string  OPTIONAL  "daily" (default) or "weekly"
  compare     string  OPTIONAL  "prior_period" (default) or "none"
  agent       string  OPTIONAL  Filter to specific agent
  channel     string  OPTIONAL  Filter to specific channel
  topN        number  OPTIONAL  Number of intents in time-series (default: 10)
```

#### Endpoint 2: Breakdown

```
GET /api/projects/:projectId/analytics/intent/breakdown

Query params:
  period      string  REQUIRED  "7d", "14d", "30d", "90d", or "custom"
  from        string  OPTIONAL  ISO 8601 date
  to          string  OPTIONAL  ISO 8601 date
  dimension   string  REQUIRED  "intent" | "parent_intent" | "agent" | "channel" | "outcome"
  agent       string  OPTIONAL  Filter by agent
  channel     string  OPTIONAL  Filter by channel
  intent      string  OPTIONAL  Filter by intent (for sub-intent breakdown)
  limit       number  OPTIONAL  Max items (default: 50)
```

#### Endpoint 3: Conversations

```
GET /api/projects/:projectId/analytics/intent/conversations

Query params:
  period      string  REQUIRED  "7d", "14d", "30d", "90d", or "custom"
  from        string  OPTIONAL  ISO 8601 date
  to          string  OPTIONAL  ISO 8601 date
  filter      string  OPTIONAL  "intent:billing_refund", "confidence_lt:0.5", "auto_discovered:1", "status:escalated"
  agent       string  OPTIONAL  Filter by agent
  channel     string  OPTIONAL  Filter by channel
  sort        string  OPTIONAL  "newest" (default), "oldest", "confidence_asc", "confidence_desc"
  page        number  OPTIONAL  Page number (default: 1)
  pageSize    number  OPTIONAL  Items per page (default: 50, max: 100)
```

#### Endpoint 4: Conversation Detail

```
GET /api/projects/:projectId/analytics/intent/conversation/:sessionId

No query params. Returns the classification record + decrypted conversation messages.
Messages are decrypted via EncryptionService.decryptAndDecompressForTenant().
```

#### Endpoint 5: Export

```
GET /api/projects/:projectId/analytics/intent/export

Query params:
  period      string  REQUIRED  "7d", "14d", "30d", "90d", or "custom"
  from        string  OPTIONAL  ISO 8601 date
  to          string  OPTIONAL  ISO 8601 date
  format      string  OPTIONAL  "csv" (default). Future: "json".
  filter      string  OPTIONAL  Same filter syntax as conversations endpoint.

Response: streaming text/csv
```

#### Endpoint 6: Health

```
GET /api/projects/:projectId/analytics/intent/health

No query params.

Response:
{
  "success": true,
  "data": {
    "pipelineEnabled": true,
    "configVersion": 3,
    "taxonomyVersion": 3,
    "lastProcessedAt": "2026-03-03T14:25:12.000Z",
    "backfillStatus": "idle",
    "conversationsClassified7d": 1247,
    "mixedVersions": false,
    "oldestConfigVersionInRange": 3,
    "dailyCostUsed": 1.87,
    "dailyCostLimit": 50.0
  }
}
```

---

### 4.10 Backing ClickHouse Queries

All queries use parameterized `{name:Type}` syntax for ClickHouse prepared statements. All include `tenant_id` and `project_id` in the WHERE clause.

#### Q1: Summary Scorecard (Endpoint 1)

```sql
-- Current period totals
SELECT
    sum(conversation_count)                                         AS total_conversations,
    sum(total_confidence) / greatest(sum(conversation_count), 1)    AS avg_confidence,
    sum(auto_discovered_count) * 100.0
        / greatest(sum(conversation_count), 1)                      AS auto_discovered_pct,
    sum(total_cost)                                                 AS total_cost,
    sum(total_input_tokens)                                         AS total_input_tokens,
    sum(total_output_tokens)                                        AS total_output_tokens
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
```

#### Q2: Top Intent (Endpoint 1)

```sql
SELECT
    intent,
    sum(conversation_count) AS cnt
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY intent
ORDER BY cnt DESC
LIMIT 1
```

#### Q3: Time-Series by Intent (Endpoint 1, granularity=daily)

```sql
SELECT
    date,
    intent,
    sum(conversation_count) AS cnt,
    sum(total_confidence) / greatest(sum(conversation_count), 1) AS avg_confidence
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY date, intent
ORDER BY date ASC, cnt DESC
```

#### Q4: Time-Series by Intent (Endpoint 1, granularity=weekly)

```sql
SELECT
    week_start,
    intent,
    sum(conversation_count) AS cnt,
    sum(total_confidence) / greatest(sum(conversation_count), 1) AS avg_confidence
FROM abl_platform.mv_weekly_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND week_start >= {from:Date}
  AND week_start < {to:Date}
GROUP BY week_start, intent
ORDER BY week_start ASC, cnt DESC
```

#### Q5: Breakdown by Intent (Endpoint 2, dimension=intent)

```sql
SELECT
    intent,
    sum(conversation_count) AS cnt,
    sum(total_confidence) / greatest(sum(conversation_count), 1) AS avg_confidence,
    sum(auto_discovered_count) AS auto_count,
    sum(escalated_count) AS escalated_count,
    sum(escalated_count) * 100.0 / greatest(sum(conversation_count), 1) AS escalation_rate
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY intent
ORDER BY cnt DESC
LIMIT {limit:UInt32}
```

#### Q6: Breakdown by Parent Intent (Endpoint 2, dimension=parent_intent)

```sql
SELECT
    parent_intent,
    sum(conversation_count) AS cnt,
    sum(total_confidence) / greatest(sum(conversation_count), 1) AS avg_confidence,
    sum(auto_discovered_count) AS auto_count
FROM abl_platform.mv_daily_parent_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY parent_intent
ORDER BY cnt DESC
LIMIT {limit:UInt32}
```

#### Q7: Breakdown by Agent (Endpoint 2, dimension=agent)

```sql
SELECT
    agent_name,
    intent,
    sum(conversation_count) AS cnt
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY agent_name, intent
ORDER BY agent_name ASC, cnt DESC
```

#### Q8: Breakdown by Outcome (Endpoint 2, dimension=outcome)

```sql
SELECT
    intent,
    session_status,
    sum(conversation_count) AS cnt,
    sum(total_confidence) / greatest(sum(conversation_count), 1) AS avg_confidence
FROM abl_platform.mv_daily_intent_outcome
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY intent, session_status
ORDER BY intent ASC, cnt DESC
```

#### Q9: Period Comparison (Endpoint 1, compare=prior_period)

```sql
SELECT
    multiIf(
        date >= {from:Date} AND date < {to:Date}, 'current',
        date >= {priorFrom:Date} AND date < {from:Date}, 'prior',
        'other'
    ) AS period,
    sum(conversation_count) AS total_conversations,
    sum(total_confidence) / greatest(sum(conversation_count), 1) AS avg_confidence,
    sum(auto_discovered_count) * 100.0
        / greatest(sum(conversation_count), 1) AS auto_discovered_pct,
    sum(total_cost) AS total_cost
FROM abl_platform.mv_daily_intent_distribution
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {priorFrom:Date}
  AND date < {to:Date}
GROUP BY period
HAVING period != 'other'
```

#### Q10: Conversation List (Endpoint 3)

```sql
SELECT
    session_id,
    intent,
    intent_display,
    parent_intent,
    confidence,
    agent_name,
    channel,
    session_status,
    session_started_at,
    is_auto_discovered,
    model_id,
    config_version,
    taxonomy_version
FROM abl_platform.intent_classifications FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
  AND session_started_at < {to:DateTime64(3)}
  -- Dynamic filters (added by API layer based on filter param):
  -- AND intent = {filterIntent:String}
  -- AND confidence < {filterConfidenceLt:Float32}
  -- AND is_auto_discovered = {filterAutoDiscovered:UInt8}
  -- AND session_status = {filterStatus:String}
ORDER BY session_started_at DESC
LIMIT {pageSize:UInt32}
OFFSET {offset:UInt32}
```

**Count query** (for pagination total):

```sql
SELECT count() AS total
FROM abl_platform.intent_classifications FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
  AND session_started_at < {to:DateTime64(3)}
  -- Same dynamic filters
```

#### Q11: Single Conversation (Endpoint 4)

```sql
SELECT *
FROM abl_platform.intent_classifications FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_id = {sessionId:String}
```

#### Q12: Mixed Version Detection (Endpoint 6)

```sql
SELECT
    count(DISTINCT config_version) AS config_version_count,
    count(DISTINCT taxonomy_version) AS taxonomy_version_count,
    min(config_version) AS oldest_config_version,
    max(config_version) AS newest_config_version,
    min(taxonomy_version) AS oldest_taxonomy_version,
    max(taxonomy_version) AS newest_taxonomy_version,
    count() AS total_classified
FROM abl_platform.intent_classifications FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= today() - 7
```

#### Q13: Export (Endpoint 5)

```sql
SELECT
    session_id,
    formatDateTime(session_started_at, '%Y-%m-%dT%H:%i:%S') AS session_started_at,
    agent_name,
    channel,
    intent,
    intent_display,
    parent_intent,
    confidence,
    arrayStringConcat(secondary_intents, ';') AS secondary_intents,
    is_auto_discovered,
    session_status,
    session_message_count,
    model_id,
    config_version,
    taxonomy_version,
    processing_ms,
    input_tokens,
    output_tokens,
    estimated_cost
FROM abl_platform.intent_classifications FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
  AND session_started_at < {to:DateTime64(3)}
ORDER BY session_started_at DESC
LIMIT 100000
```

---

# Phase 5: Index & Performance Design

## Checklist

- [x] 5.1 For each Phase 4 query, verify the ClickHouse ORDER BY covers the WHERE + GROUP BY
- [x] 5.2 Design materialized views for high-frequency aggregation queries
- [x] 5.3 Design projection tables for alternative query patterns
- [x] 5.4 Verify partition pruning -- every query must filter by tenant_id + time range
- [x] 5.5 Add skip indices for low-cardinality filter columns
- [x] 5.6 Estimate storage size (rows x row size x retention period)
- [x] 5.7 Plan data lifecycle (warm -> cold -> delete TTLs)
- [x] 5.8 For MongoDB pipeline_configs: add compound index on (tenantId, pipelineType)
- [x] 5.9 Test query performance with realistic data volume
- [x] 5.10 Design cache strategy (Redis cache for dashboard queries, TTL-based invalidation)

---

### 5.1 ORDER BY Coverage Verification

For each Phase 4 query, verify that the ClickHouse ORDER BY prefix covers the WHERE clause for efficient index usage:

| Query             | Table                                 | ORDER BY                                                     | WHERE Columns                                                 | Covered? | Notes                                                                                        |
| ----------------- | ------------------------------------- | ------------------------------------------------------------ | ------------------------------------------------------------- | -------- | -------------------------------------------------------------------------------------------- |
| Q1 (scorecard)    | `mv_daily_intent_distribution`        | `(tenant_id, project_id, date, intent, agent_name, channel)` | `tenant_id, project_id, date`                                 | YES      | Prefix match on first 3 columns.                                                             |
| Q2 (top intent)   | `mv_daily_intent_distribution`        | same as Q1                                                   | `tenant_id, project_id, date` + GROUP BY `intent`             | YES      | WHERE prefix + GROUP BY uses 4th column.                                                     |
| Q3 (time-series)  | `mv_daily_intent_distribution`        | same as Q1                                                   | `tenant_id, project_id, date` + GROUP BY `date, intent`       | YES      | Full prefix match.                                                                           |
| Q4 (weekly)       | `mv_weekly_intent_distribution`       | `(tenant_id, project_id, week_start, intent)`                | `tenant_id, project_id, week_start`                           | YES      | Prefix match.                                                                                |
| Q5 (by intent)    | `mv_daily_intent_distribution`        | same as Q1                                                   | `tenant_id, project_id, date` + GROUP BY `intent`             | YES      |                                                                                              |
| Q6 (by parent)    | `mv_daily_parent_intent_distribution` | `(tenant_id, project_id, date, parent_intent)`               | `tenant_id, project_id, date`                                 | YES      |                                                                                              |
| Q7 (by agent)     | `mv_daily_intent_distribution`        | same as Q1                                                   | `tenant_id, project_id, date` + GROUP BY `agent_name, intent` | YES      | agent_name is 5th in ORDER BY, but date filters partition-prune first.                       |
| Q8 (by outcome)   | `mv_daily_intent_outcome`             | `(tenant_id, project_id, date, intent, session_status)`      | `tenant_id, project_id, date`                                 | YES      |                                                                                              |
| Q9 (comparison)   | `mv_daily_intent_distribution`        | same as Q1                                                   | `tenant_id, project_id, date`                                 | YES      | Wide date range covers both periods.                                                         |
| Q10 (conv list)   | `intent_classifications`              | `(tenant_id, project_id, session_id)`                        | `tenant_id, project_id, session_started_at`                   | PARTIAL  | `session_started_at` is not in ORDER BY. Relies on partition pruning (monthly) + skip index. |
| Q11 (single conv) | `intent_classifications`              | `(tenant_id, project_id, session_id)`                        | `tenant_id, project_id, session_id`                           | YES      | Full ORDER BY match. O(1) lookup.                                                            |
| Q12 (mixed ver.)  | `intent_classifications`              | `(tenant_id, project_id, session_id)`                        | `tenant_id, project_id, session_started_at`                   | PARTIAL  | Same as Q10. Partition prune + scan within partition.                                        |
| Q13 (export)      | `intent_classifications`              | `(tenant_id, project_id, session_id)`                        | `tenant_id, project_id, session_started_at`                   | PARTIAL  | Same as Q10. Acceptable for export (background, not real-time).                              |

**Q10/Q12/Q13 mitigation**: The conversation list query filters by `session_started_at` which is not in the ORDER BY. However:

1. `PARTITION BY (tenant_id, toYYYYMM(session_started_at))` ensures monthly partition pruning.
2. Within a monthly partition, a full scan of ~30K rows (10K convs/day x 30 days) is fast in ClickHouse (< 100ms).
3. Adding a skip index on `session_started_at` (see Section 5.5) further accelerates the scan.
4. The `FINAL` keyword on `ReplacingMergeTree` adds overhead; for list queries this is acceptable.

---

### 5.2 Materialized Views (Summary)

Already defined in Section 3.9. Summary of all MVs:

| MV                                    | Engine           | ORDER BY                                                     | Backs Queries          | Frequency                        |
| ------------------------------------- | ---------------- | ------------------------------------------------------------ | ---------------------- | -------------------------------- |
| `mv_daily_intent_distribution`        | SummingMergeTree | `(tenant_id, project_id, date, intent, agent_name, channel)` | Q1, Q2, Q3, Q5, Q7, Q9 | Every dashboard load             |
| `mv_daily_parent_intent_distribution` | SummingMergeTree | `(tenant_id, project_id, date, parent_intent)`               | Q6                     | When hierarchical view selected  |
| `mv_daily_intent_outcome`             | SummingMergeTree | `(tenant_id, project_id, date, intent, session_status)`      | Q8                     | When outcome view selected       |
| `mv_weekly_intent_distribution`       | SummingMergeTree | `(tenant_id, project_id, week_start, intent)`                | Q4                     | When weekly granularity selected |

All MVs are populated automatically on INSERT to the base table. No manual refresh needed for ongoing processing. Re-processing / backfill requires MV rebuild (see Section 3.11).

---

### 5.3 Projection Tables

No additional projection tables are needed for Phase 3. The materialized views cover all high-frequency access patterns. If a future requirement arises for queries ordered by `(tenant_id, project_id, session_started_at)` (e.g., "latest N classified conversations regardless of intent"), a projection can be added:

```sql
-- FUTURE: Only add if conversation list queries become a performance bottleneck
ALTER TABLE abl_platform.intent_classifications
    ADD PROJECTION proj_by_time
    (
        SELECT *
        ORDER BY (tenant_id, project_id, session_started_at, session_id)
    );

ALTER TABLE abl_platform.intent_classifications
    MATERIALIZE PROJECTION proj_by_time;
```

This is deferred because partition pruning + skip index is expected to be sufficient.

---

### 5.4 Partition Pruning Verification

**Rule**: Every query MUST include `tenant_id` (for partition pruning by tenant) AND a time range filter (for partition pruning by month).

| Query              | `tenant_id` filter | Time filter                                          | Partitions scanned                                                           |
| ------------------ | ------------------ | ---------------------------------------------------- | ---------------------------------------------------------------------------- |
| Q1-Q9 (MV queries) | YES                | `date >= ? AND date < ?`                             | Only months in range                                                         |
| Q10 (conv list)    | YES                | `session_started_at >= ? AND session_started_at < ?` | Only months in range                                                         |
| Q11 (single conv)  | YES                | None (exact session_id)                              | ALL partitions for tenant (mitigated: ORDER BY lookup is O(1) per partition) |
| Q12 (mixed ver)    | YES                | `session_started_at >= today() - 7`                  | 1-2 monthly partitions                                                       |
| Q13 (export)       | YES                | `session_started_at >= ? AND session_started_at < ?` | Only months in range                                                         |

**Q11 mitigation**: Looking up a single session_id without a time filter scans all partitions for the tenant. For a tenant with 2 years of data, that is 24 partitions. Each partition lookup is O(log n) on the ORDER BY (binary search), so the total is 24 x O(log n) -- still sub-millisecond for typical partition sizes. If this becomes an issue, the API layer can require `session_started_at` in the request (available from the conversation list that preceded the drill-down).

---

### 5.5 Skip Indices

```sql
-- Intent filter: used in conversation list (Q10) and export (Q13)
-- Type: set(100) -- bloom-like index for up to 100 distinct values per granule
ALTER TABLE abl_platform.intent_classifications
    ADD INDEX idx_intent intent TYPE set(100) GRANULARITY 4;

-- Session started time: used in conversation list queries within a partition
-- Type: minmax -- stores min/max per granule, enables range pruning
ALTER TABLE abl_platform.intent_classifications
    ADD INDEX idx_session_time session_started_at TYPE minmax GRANULARITY 4;

-- Confidence: used for "low confidence" filters (confidence < threshold)
-- Type: minmax -- enables range pruning on confidence bands
ALTER TABLE abl_platform.intent_classifications
    ADD INDEX idx_confidence confidence TYPE minmax GRANULARITY 4;

-- Auto-discovered flag: used for "show only auto-discovered" filter
-- Type: set(2) -- only two values (0, 1)
ALTER TABLE abl_platform.intent_classifications
    ADD INDEX idx_auto_discovered is_auto_discovered TYPE set(2) GRANULARITY 4;

-- Session status: used for "show escalated only" filter
-- Type: set(10) -- few distinct values (completed, escalated, abandoned, error)
ALTER TABLE abl_platform.intent_classifications
    ADD INDEX idx_session_status session_status TYPE set(10) GRANULARITY 4;
```

**GRANULARITY 4**: Index metadata is stored per 4 granules (4 x 8192 = 32,768 rows). Lower granularity = more precision but more index overhead. 4 is the standard value used across the platform.

---

### 5.6 Storage Estimation

#### Base Table: `intent_classifications`

| Field                 | Type                   | Avg bytes          |
| --------------------- | ---------------------- | ------------------ |
| tenant_id             | String                 | 20                 |
| project_id            | String                 | 24                 |
| session_id            | String                 | 36                 |
| session_started_at    | DateTime64(3)          | 8                  |
| processed_at          | DateTime64(3)          | 8                  |
| agent_name            | LowCardinality(String) | 4 (dict ref)       |
| channel               | LowCardinality(String) | 4                  |
| intent                | LowCardinality(String) | 4                  |
| intent_display        | String                 | 30                 |
| parent_intent         | LowCardinality(String) | 4                  |
| confidence            | Float32                | 4                  |
| secondary_intents     | Array(String)          | 20 (avg 1 item)    |
| secondary_confidences | Array(Float32)         | 8                  |
| is_auto_discovered    | UInt8                  | 1                  |
| input_message_count   | UInt16                 | 2                  |
| input_strategy        | LowCardinality(String) | 4                  |
| session_status        | LowCardinality(String) | 4                  |
| session_message_count | UInt16                 | 2                  |
| model_id              | LowCardinality(String) | 4                  |
| provider              | LowCardinality(String) | 4                  |
| config_version        | UInt32                 | 4                  |
| taxonomy_version      | UInt32                 | 4                  |
| pipeline_version      | LowCardinality(String) | 4                  |
| processing_ms         | UInt32                 | 4                  |
| input_tokens          | UInt32                 | 4                  |
| output_tokens         | UInt32                 | 4                  |
| estimated_cost        | Float32                | 4                  |
| **Total**             |                        | **~220 bytes/row** |

#### Volume Projections

| Scale         | Convs/day | Rows/year  | Uncompressed/year | Compressed (5-10x) | With MVs (+30%) |
| ------------- | --------- | ---------- | ----------------- | ------------------ | --------------- |
| Small tenant  | 100       | 36,500     | 8 MB              | 0.8-1.6 MB         | 1-2 MB          |
| Medium tenant | 1,000     | 365,000    | 80 MB             | 8-16 MB            | 10-21 MB        |
| Large tenant  | 10,000    | 3,650,000  | 800 MB            | 80-160 MB          | 104-208 MB      |
| Enterprise    | 50,000    | 18,250,000 | 4 GB              | 400-800 MB         | 520 MB - 1 GB   |

#### Platform-Wide Estimation

| Scenario                           | Tenants | Total rows/year | Compressed storage |
| ---------------------------------- | ------- | --------------- | ------------------ |
| 50 small tenants                   | 50      | 1.8M            | 80 MB              |
| 20 medium + 5 large                | 25      | 25.6M           | 350 MB             |
| 10 medium + 3 large + 1 enterprise | 14      | 32.3M           | 500 MB             |

**Conclusion**: Storage is not a concern. Even at enterprise scale with 730-day retention, a single pipeline's output fits comfortably within a single-node ClickHouse deployment. Total across all pipelines (intent + sentiment + quality + anomaly) would be 4x, still under 2 GB compressed for the largest scenario.

---

### 5.7 Data Lifecycle (Warm -> Cold -> Delete)

| Phase      | Age          | Storage Tier       | TTL Expression                                               | Description                                                   |
| ---------- | ------------ | ------------------ | ------------------------------------------------------------ | ------------------------------------------------------------- |
| **Hot**    | 0-30 days    | Default disk (SSD) | N/A                                                          | Active dashboard queries. Highest query frequency.            |
| **Warm**   | 30-180 days  | Default disk (SSD) | N/A                                                          | Trend analysis, period comparisons. Moderate query frequency. |
| **Cold**   | 180-730 days | Volume (HDD) or S3 | `TTL session_started_at + INTERVAL 180 DAY TO VOLUME 'cold'` | Year-over-year analysis. Low query frequency.                 |
| **Delete** | 730+ days    | N/A                | `TTL session_started_at + INTERVAL 730 DAY DELETE`           | Auto-purged.                                                  |

**Note**: The cold tier TTL is only activated if a `cold` volume is configured in ClickHouse's storage policy. In development and small deployments (single disk), all data stays on the default disk and only the DELETE TTL applies.

```sql
-- Storage policy (defined in ClickHouse config, not in DDL):
-- <storage_configuration>
--   <disks>
--     <default><path>/var/lib/clickhouse/</path></default>
--     <cold><path>/mnt/cold-storage/clickhouse/</path></cold>
--   </disks>
--   <policies>
--     <tiered>
--       <volumes>
--         <hot><disk>default</disk></hot>
--         <cold><disk>cold</disk></cold>
--       </volumes>
--       <move_factor>0.1</move_factor>
--     </tiered>
--   </policies>
-- </storage_configuration>
```

**GDPR cascade**: Tenant offboarding drops all partitions for the tenant:

```sql
-- Efficient: drops metadata, doesn't scan rows
ALTER TABLE abl_platform.intent_classifications
    DROP PARTITION ('{tenantId}', toYYYYMM(now()));
-- Repeat for each month partition or use a loop
```

For session-level deletion (right to erasure):

```sql
ALTER TABLE abl_platform.intent_classifications
    DELETE WHERE tenant_id = {tenantId:String}
    AND session_id IN ({sessionIds:Array(String)})
```

---

### 5.8 MongoDB Indices for Pipeline Config

These indices are shared across all pipeline types (defined once in the `pipeline_configs` collection):

```javascript
// Primary lookup: "Get the intent classification config for this project"
db.pipeline_configs.createIndex(
  { tenantId: 1, pipelineType: 1, projectId: 1 },
  { unique: true, name: 'idx_tenant_pipeline_project' },
);

// List enabled pipelines: "Which pipelines are active for this tenant?"
db.pipeline_configs.createIndex({ tenantId: 1, enabled: 1 }, { name: 'idx_tenant_enabled' });

// Backfill scheduling: "Find pipelines with pending backfills"
db.pipeline_configs.createIndex(
  { backfillStatus: 1, enabled: 1 },
  { name: 'idx_backfill_status', partialFilterExpression: { backfillStatus: 'running' } },
);
```

---

### 5.9 Performance Testing Plan

#### Test Data Generation

```
Generate test data with:
- 3 tenants (small: 100/day, medium: 1K/day, large: 10K/day)
- 90 days of history = 999K rows total
- 15 distinct intents + 5 auto-discovered
- 5 agents, 3 channels
- Realistic confidence distribution (mean 0.82, stddev 0.12)
```

#### Query Benchmark Targets

| Query                    | Target Latency | Table        | Data Volume                   | Expected |
| ------------------------ | -------------- | ------------ | ----------------------------- | -------- |
| Q1 (scorecard)           | < 100ms        | MV           | 90 MV rows                    | < 10ms   |
| Q2 (top intent)          | < 100ms        | MV           | 90 MV rows                    | < 10ms   |
| Q3 (time-series)         | < 200ms        | MV           | 90 x 15 = 1,350 MV rows       | < 20ms   |
| Q5 (breakdown)           | < 300ms        | MV           | 90 x 15 = 1,350 MV rows       | < 20ms   |
| Q8 (outcome)             | < 300ms        | MV           | 90 x 15 x 4 = 5,400 MV rows   | < 30ms   |
| Q10 (conv list, 50 rows) | < 500ms        | Base (FINAL) | 300K rows (large tenant, 30d) | < 200ms  |
| Q11 (single conv)        | < 200ms        | Base (FINAL) | Primary key lookup            | < 5ms    |
| Q13 (export, 30d)        | < 10s          | Base (FINAL) | 300K rows streaming           | < 3s     |

#### Stress Test Scenarios

1. **Concurrent dashboard loads**: 10 simultaneous scorecard + time-series queries for different tenants.
2. **Large export**: 100K row CSV export while dashboard queries are running.
3. **Backfill + live queries**: Re-processing 10K conversations while serving dashboard queries.
4. **MV rebuild**: Truncate + repopulate MV while dashboard queries fall back to base table.

---

### 5.10 Redis Cache Strategy

#### Cache Key Patterns

```
analytics:{tenantId}:{projectId}:intent:summary:{period}:{filters_hash}
analytics:{tenantId}:{projectId}:intent:timeseries:{period}:{granularity}:{filters_hash}
analytics:{tenantId}:{projectId}:intent:breakdown:{period}:{dimension}:{filters_hash}
analytics:{tenantId}:{projectId}:intent:conversation:{sessionId}
analytics:{tenantId}:{projectId}:intent:health
```

Where `{filters_hash}` is a deterministic hash of any additional filter parameters (agent, channel, intent) to ensure cache isolation for different filter combinations.

#### Cache TTLs

| Cache Key Pattern          | TTL            | Rationale                                                                            |
| -------------------------- | -------------- | ------------------------------------------------------------------------------------ |
| `summary:*`                | 300s (5 min)   | Scorecard is the first thing users see. Balance freshness vs ClickHouse load.        |
| `timeseries:*`             | 600s (10 min)  | Time-series charts don't change rapidly. Historical days are immutable.              |
| `breakdown:*`              | 300s (5 min)   | Breakdown changes when new conversations are classified.                             |
| `conversation:{sessionId}` | 3600s (1 hour) | Single conversation classification is immutable once produced (unless re-processed). |
| `health`                   | 60s (1 min)    | Health check is lightweight but should reflect recent changes.                       |

Conversation list queries (`conversations:*`) are NOT cached because pagination and filter combinations create too many cache keys with low hit rates.

#### Cache Invalidation

```
Trigger                                    Keys Invalidated
─────────────────────────────────────────  ─────────────────────────────────────────────────
New classification batch completes         analytics:{tenantId}:{projectId}:intent:summary:*
                                           analytics:{tenantId}:{projectId}:intent:timeseries:*
                                           analytics:{tenantId}:{projectId}:intent:breakdown:*
                                           analytics:{tenantId}:{projectId}:intent:health

Config change (PUT to pipeline config)     analytics:{tenantId}:{projectId}:intent:*

Re-processing completes                    analytics:{tenantId}:{projectId}:intent:*
                                           analytics:{tenantId}:{projectId}:intent:conversation:*

TTL expiry                                 Automatic
```

**Implementation**: Use Redis `SCAN` with pattern matching + `DEL`. Never use `KEYS` (blocks Redis). The invalidation is performed as a fire-and-forget call from the pipeline processing completion callback.

#### Cache Miss Behavior

On cache miss:

1. Execute ClickHouse query.
2. If query succeeds, cache result with appropriate TTL.
3. If query fails (ClickHouse unavailable), return 503 with `{ success: false, error: "Analytics service temporarily unavailable" }`.
4. Do not cache error responses.

#### Cache Warming

No proactive cache warming. The cache is populated lazily on first access. Given the 5-minute TTL, the cache is warm within one dashboard visit. For high-traffic dashboards, the first user after TTL expiry pays the ClickHouse query cost; subsequent users within the TTL window get cached results.

---

## Appendix A: Complete DDL Script

```sql
-- =============================================================================
-- Intent Classification Pipeline: Full DDL
-- Run this script to create all tables, MVs, and indices.
-- Idempotent: uses IF NOT EXISTS / IF NOT EXISTS patterns.
-- =============================================================================

-- ─── Base Table ──────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS abl_platform.intent_classifications (
    tenant_id              String,
    project_id             String,
    session_id             String,
    session_started_at     DateTime64(3),
    processed_at           DateTime64(3),
    agent_name             LowCardinality(String),
    channel                LowCardinality(String),
    intent                 LowCardinality(String),
    intent_display         String,
    parent_intent          LowCardinality(String),
    confidence             Float32,
    secondary_intents      Array(String),
    secondary_confidences  Array(Float32),
    is_auto_discovered     UInt8,
    input_message_count    UInt16,
    input_strategy         LowCardinality(String),
    session_status         LowCardinality(String),
    session_message_count  UInt16,
    model_id               LowCardinality(String),
    provider               LowCardinality(String),
    config_version         UInt32,
    taxonomy_version       UInt32,
    pipeline_version       LowCardinality(String),
    processing_ms          UInt32,
    input_tokens           UInt32,
    output_tokens          UInt32,
    estimated_cost         Float32
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL session_started_at + INTERVAL 730 DAY DELETE;

-- ─── Skip Indices ────────────────────────────────────────────────────────────

ALTER TABLE abl_platform.intent_classifications
    ADD INDEX IF NOT EXISTS idx_intent intent TYPE set(100) GRANULARITY 4;

ALTER TABLE abl_platform.intent_classifications
    ADD INDEX IF NOT EXISTS idx_session_time session_started_at TYPE minmax GRANULARITY 4;

ALTER TABLE abl_platform.intent_classifications
    ADD INDEX IF NOT EXISTS idx_confidence confidence TYPE minmax GRANULARITY 4;

ALTER TABLE abl_platform.intent_classifications
    ADD INDEX IF NOT EXISTS idx_auto_discovered is_auto_discovered TYPE set(2) GRANULARITY 4;

ALTER TABLE abl_platform.intent_classifications
    ADD INDEX IF NOT EXISTS idx_session_status session_status TYPE set(10) GRANULARITY 4;

-- ─── MV 1: Daily Intent Distribution ─────────────────────────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_intent_distribution
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, intent, agent_name, channel)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at)                         AS date,
    intent,
    agent_name,
    channel,
    count()                                            AS conversation_count,
    sum(confidence)                                    AS total_confidence,
    sum(toUInt64(is_auto_discovered))                  AS auto_discovered_count,
    sum(toUInt64(session_status = 'escalated'))         AS escalated_count,
    sum(estimated_cost)                                AS total_cost,
    sum(input_tokens)                                  AS total_input_tokens,
    sum(output_tokens)                                 AS total_output_tokens
FROM abl_platform.intent_classifications
GROUP BY tenant_id, project_id, date, intent, agent_name, channel;

-- ─── MV 2: Daily Parent Intent Distribution ──────────────────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_parent_intent_distribution
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, parent_intent)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at)                         AS date,
    if(parent_intent = '', intent, parent_intent)      AS parent_intent,
    count()                                            AS conversation_count,
    sum(confidence)                                    AS total_confidence,
    sum(toUInt64(is_auto_discovered))                  AS auto_discovered_count
FROM abl_platform.intent_classifications
GROUP BY tenant_id, project_id, date, parent_intent;

-- ─── MV 3: Daily Intent x Outcome ───────────────────────────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_intent_outcome
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, intent, session_status)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at)    AS date,
    intent,
    session_status,
    count()                       AS conversation_count,
    sum(confidence)               AS total_confidence
FROM abl_platform.intent_classifications
GROUP BY tenant_id, project_id, date, intent, session_status;

-- ─── MV 4: Weekly Intent Distribution ────────────────────────────────────────

CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_weekly_intent_distribution
ENGINE = SummingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(week_start))
ORDER BY (tenant_id, project_id, week_start, intent)
TTL week_start + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toMonday(session_started_at)                      AS week_start,
    intent,
    count()                                           AS conversation_count,
    sum(confidence)                                   AS total_confidence,
    sum(toUInt64(is_auto_discovered))                 AS auto_discovered_count,
    sum(estimated_cost)                               AS total_cost
FROM abl_platform.intent_classifications
GROUP BY tenant_id, project_id, week_start, intent;
```

---

## Appendix B: MongoDB Index Script

```javascript
// Run against the pipeline_configs collection

// Primary config lookup
db.pipeline_configs.createIndex(
  { tenantId: 1, pipelineType: 1, projectId: 1 },
  { unique: true, name: 'idx_tenant_pipeline_project' },
);

// List enabled pipelines for a tenant
db.pipeline_configs.createIndex({ tenantId: 1, enabled: 1 }, { name: 'idx_tenant_enabled' });

// Find running backfills (sparse -- only active when backfills exist)
db.pipeline_configs.createIndex(
  { backfillStatus: 1, enabled: 1 },
  { name: 'idx_backfill_status', partialFilterExpression: { backfillStatus: 'running' } },
);
```

---

## Appendix C: Redis Cache Key Reference

```
# Summary (scorecard + comparison)
SET analytics:{tenantId}:{projectId}:intent:summary:7d:{hash} "{json}" EX 300

# Time-series
SET analytics:{tenantId}:{projectId}:intent:timeseries:7d:daily:{hash} "{json}" EX 600

# Breakdown
SET analytics:{tenantId}:{projectId}:intent:breakdown:7d:intent:{hash} "{json}" EX 300

# Single conversation (immutable)
SET analytics:{tenantId}:{projectId}:intent:conversation:{sessionId} "{json}" EX 3600

# Health
SET analytics:{tenantId}:{projectId}:intent:health "{json}" EX 60

# Invalidation pattern (on new batch or config change)
SCAN 0 MATCH analytics:{tenantId}:{projectId}:intent:* COUNT 100
# Then DEL each matching key
```

---

## Appendix D: Design Decisions Log

| Decision                                  | Chosen | Alternative Considered                           | Rationale                                                                                                                                                                    |
| ----------------------------------------- | ------ | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| One row per conversation (not per intent) | YES    | One row per intent per conversation              | Simplifies aggregation, avoids dedup in GROUP BY, aligns with ReplacingMergeTree                                                                                             |
| `secondary_intents` as Array(String)      | YES    | Separate table with one row per secondary intent | Array type is queryable in ClickHouse, avoids JOIN, keeps one-row-per-conversation invariant                                                                                 |
| Denormalize `intent_display`              | YES    | Lookup from taxonomy at query time               | Avoids cross-system join (ClickHouse -> MongoDB). Display name is immutable at classification time.                                                                          |
| Denormalize `session_status`              | YES    | JOIN with MongoDB sessions collection            | Enables intent-vs-outcome analysis in pure ClickHouse. Small storage cost (1 byte LowCardinality).                                                                           |
| SummingMergeTree for MVs                  | YES    | AggregatingMergeTree                             | SummingMergeTree is simpler (just use `sum()`), sufficient for count/sum aggregations. AggregatingMergeTree needed only for quantiles/uniqExact, which we don't pre-compute. |
| 730-day TTL                               | YES    | 90-day (matching source) or 365-day              | Year-over-year comparison is a core analytics use case. Storage is cheap (~200 MB/year for large tenants).                                                                   |
| No projection table initially             | YES    | Add `proj_by_time` immediately                   | Partition pruning + skip index expected to be sufficient. Add projection only if benchmarks show bottleneck.                                                                 |
| `estimated_cost` as Float32               | YES    | Compute at query time from tokens                | Pre-computing avoids per-query pricing lookup. Float32 precision (7 decimal digits) is sufficient for USD amounts < $10.                                                     |
| Cache conversations list: NO              | YES    | Cache with short TTL                             | Filter + pagination combinations create cache key explosion. ClickHouse is fast enough for < 500ms target.                                                                   |
