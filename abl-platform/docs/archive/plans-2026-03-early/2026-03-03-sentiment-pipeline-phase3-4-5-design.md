# Phase 3 + 4 + 5: Output Schema, Presentation, and Index Design -- Sentiment Analysis Pipeline

> **Pipeline**: Sentiment Analysis
> **Date**: 2026-03-03
> **Status**: Design
> **Depends on**: Phase 1 (Input Data Readiness) -- completed, Phase 2 (Config Schema) -- completed
> **Feeds**: Implementation plan (compute-sentiment activity, analytics API, Studio dashboard)

---

## Phase 3: Output Schema Design

**Goal**: Design the storage schema for sentiment pipeline results. Schema is designed backwards from Phase 4 presentation needs, ensuring every dashboard widget, query, and export can be served efficiently.

---

### 3.1 Primary Output Records

The sentiment pipeline produces **two granularity levels** of output, matching the `granularity` config parameter (`'message'`, `'conversation'`, or `'both'`):

| Record Type              | Granularity      | Cardinality                 | Description                                                                                                                   |
| ------------------------ | ---------------- | --------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `message_sentiment`      | Per-message      | ~8-12 rows per conversation | One row per scored message. When `analyzeRoles: ['user']` (default), only user messages produce rows (~4-6 per conversation). |
| `conversation_sentiment` | Per-conversation | 1 row per conversation      | Aggregated metrics for the entire session: averages, trajectory, pivot points, frustration summary.                           |

**Why two tables instead of one?**

- Per-message rows are needed for drill-down (show sentiment arc within a conversation) and for message-level frustration flagging.
- Per-conversation rows are needed for dashboard scorecards, time-series, breakdowns, and conversation lists. These queries run on every dashboard load and must be fast.
- Combining them into a single table would force either denormalization (duplicating conversation-level fields on every message row) or complex subqueries on every dashboard query. Separate tables give clean separation of concerns.

**Why not use the generic `insight_results` table?**

The `insight_results` table (used by `compute-toxicity`, `compute-tool-effectiveness`) is a flexible single-table design with a JSON `dimensions` column. It works well for simple score-per-session insights but is poorly suited for sentiment because:

1. Sentiment produces per-message rows (high cardinality) with structured fields that benefit from native column types and skip indices.
2. Dashboard queries need `GROUP BY agent_name, channel` with `ORDER BY` optimization -- impossible when these are buried in a JSON `dimensions` string.
3. Materialized views cannot efficiently aggregate JSON fields.
4. The `conversation_sentiment` table has ~15 specific numeric columns (avg, min, max, trajectory, pivot_count, etc.) that would all live in a single JSON blob, destroying query performance.

Dedicated tables are the right choice for high-volume, high-query-frequency pipeline outputs. The `insight_results` table remains appropriate for lower-frequency, simpler insights.

---

### 3.2 All Output Fields with Types and Descriptions

#### Table: `message_sentiment`

| #   | Field                  | Type                     | Description                                                                                                                                                             |
| --- | ---------------------- | ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `tenant_id`            | `String`                 | Tenant isolation key. Present in every row, every query.                                                                                                                |
| 2   | `project_id`           | `String`                 | Project scope. Required for API route `/api/projects/:projectId/...`.                                                                                                   |
| 3   | `session_id`           | `String`                 | Conversation identifier. Links to `conversation_sentiment` and `messages` tables.                                                                                       |
| 4   | `message_id`           | `String`                 | Unique message identifier. Part of the deduplication key.                                                                                                               |
| 5   | `message_at`           | `DateTime64(3)`          | Original message timestamp. Partition key for time-range pruning.                                                                                                       |
| 6   | `processed_at`         | `DateTime64(3)`          | When this result was computed. Used by `ReplacingMergeTree` for deduplication on re-processing.                                                                         |
| 7   | `role`                 | `LowCardinality(String)` | Message author: `'user'` or `'assistant'`. Low cardinality -- only 2 values.                                                                                            |
| 8   | `agent_name`           | `LowCardinality(String)` | Agent handling the conversation at this message. Enables per-agent breakdown queries.                                                                                   |
| 9   | `channel`              | `LowCardinality(String)` | Conversation channel: `'web_chat'`, `'voice'`, `'slack'`, etc. Enables per-channel breakdown.                                                                           |
| 10  | `sentiment_score`      | `Float32`                | Sentiment score: -1.0 (very negative) to +1.0 (very positive). For `ternary` scale, values are snapped to {-1.0, 0.0, 1.0}. For `binary`, values are {-1.0, 1.0}.       |
| 11  | `sentiment_label`      | `LowCardinality(String)` | Human-readable label derived from score: `'positive'` (>0.2), `'neutral'` (-0.2 to 0.2), `'negative'` (<-0.2). Thresholds are fixed (not configurable) for consistency. |
| 12  | `frustration_detected` | `UInt8`                  | Boolean (0/1). Whether this specific message exhibited frustration signals.                                                                                             |
| 13  | `frustration_signals`  | `Array(String)`          | List of detected signals: `['ALL_CAPS', 'repetition', 'excessive_punctuation', 'keyword:cancel']`. Empty array when no frustration.                                     |
| 14  | `model_id`             | `LowCardinality(String)` | LLM model used for scoring (e.g., `'claude-haiku-4-5'`). Provenance tracking.                                                                                           |
| 15  | `config_version`       | `UInt32`                 | Pipeline config version at time of processing. Links to `pipeline_configs.version` for auditability.                                                                    |
| 16  | `confidence`           | `Float32`                | Model's self-reported confidence in the score, 0.0 to 1.0. Extracted from the LLM structured output.                                                                    |
| 17  | `processing_ms`        | `UInt32`                 | Wall-clock time to produce this score (LLM call latency). Used for pipeline performance monitoring.                                                                     |

#### Table: `conversation_sentiment`

| #   | Field                    | Type                      | Description                                                                                                                                                           |
| --- | ------------------------ | ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `tenant_id`              | `String`                  | Tenant isolation key.                                                                                                                                                 |
| 2   | `project_id`             | `String`                  | Project scope.                                                                                                                                                        |
| 3   | `session_id`             | `String`                  | Conversation identifier. Deduplication key with tenant_id.                                                                                                            |
| 4   | `session_started_at`     | `DateTime64(3)`           | When the conversation began. Partition key for time-range queries.                                                                                                    |
| 5   | `processed_at`           | `DateTime64(3)`           | When this result was computed. `ReplacingMergeTree` version field.                                                                                                    |
| 6   | `agent_name`             | `LowCardinality(String)`  | Primary agent (the agent that handled the most turns).                                                                                                                |
| 7   | `channel`                | `LowCardinality(String)`  | Conversation channel.                                                                                                                                                 |
| 8   | `avg_sentiment`          | `Float32`                 | Mean sentiment score across all scored messages. The primary aggregate metric.                                                                                        |
| 9   | `start_sentiment`        | `Float32`                 | Sentiment of the first scored user message. Captures initial customer mood.                                                                                           |
| 10  | `end_sentiment`          | `Float32`                 | Sentiment of the last scored user message. Captures resolution mood.                                                                                                  |
| 11  | `min_sentiment`          | `Float32`                 | Lowest sentiment score in the conversation. Identifies the worst moment.                                                                                              |
| 12  | `max_sentiment`          | `Float32`                 | Highest sentiment score.                                                                                                                                              |
| 13  | `sentiment_trajectory`   | `LowCardinality(String)`  | Overall trend: `'improving'` (end > start + threshold), `'declining'` (end < start - threshold), `'stable'` (within threshold), `'volatile'` (>2 significant shifts). |
| 14  | `sentiment_shift_count`  | `UInt16`                  | Number of consecutive-message score changes exceeding `pivotThreshold`. Measures volatility.                                                                          |
| 15  | `frustration_turn_count` | `UInt16`                  | Number of messages with `frustration_detected = 1`.                                                                                                                   |
| 16  | `frustration_detected`   | `UInt8`                   | Boolean (0/1). Whether ANY message in the conversation had frustration. Enables fast filtering.                                                                       |
| 17  | `pivot_count`            | `UInt16`                  | Number of sentiment pivot points detected (score changes exceeding `pivotThreshold`).                                                                                 |
| 18  | `worst_pivot_at`         | `Nullable(DateTime64(3))` | Timestamp of the most negative pivot (largest downward score change). Null if no pivots.                                                                              |
| 19  | `worst_pivot_delta`      | `Nullable(Float32)`       | Score change at the worst pivot (negative value, e.g., -0.6). Null if no pivots.                                                                                      |
| 20  | `model_id`               | `LowCardinality(String)`  | LLM model used.                                                                                                                                                       |
| 21  | `config_version`         | `UInt32`                  | Pipeline config version.                                                                                                                                              |
| 22  | `message_count`          | `UInt16`                  | Number of messages that were scored (not total messages -- excludes system messages and filtered roles).                                                              |
| 23  | `processing_ms`          | `UInt32`                  | Total processing time for the entire conversation (sum of all message scoring calls).                                                                                 |

---

### 3.3 Provenance Fields

Every output row includes provenance fields that enable:

| Field            | Purpose                                | Used For                                                                                  |
| ---------------- | -------------------------------------- | ----------------------------------------------------------------------------------------- |
| `model_id`       | Which LLM scored this conversation     | Debugging score drift when models change. Filtering results by model version.             |
| `config_version` | Which pipeline config was active       | Identifying results that need re-processing after config changes. Auditing score changes. |
| `processed_at`   | When the pipeline produced this result | `ReplacingMergeTree` deduplication. Identifying stale results. Backfill tracking.         |

**Provenance query example**: "Show me all conversations scored with config version 2 that have not been re-processed with config version 3":

```sql
SELECT session_id, config_version, processed_at
FROM conversation_sentiment FINAL
WHERE tenant_id = {tenantId:String}
  AND config_version < 3
  AND session_started_at >= now() - INTERVAL 30 DAY
ORDER BY session_started_at DESC
LIMIT 100
```

---

### 3.4 Confidence and Quality Indicators

| Indicator                                        | Location                 | Range     | Meaning                                                                                                                                |
| ------------------------------------------------ | ------------------------ | --------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| `confidence`                                     | `message_sentiment`      | 0.0 - 1.0 | LLM's self-assessed confidence in the sentiment score. Low confidence (<0.5) indicates ambiguous messages (sarcasm, mixed signals).    |
| `processing_ms`                                  | Both tables              | 0 - 60000 | Latency indicator. Values >10000ms suggest LLM throttling or network issues.                                                           |
| `message_count`                                  | `conversation_sentiment` | 1 - 65535 | Number of messages scored. Conversations with `message_count < 3` produce less reliable trajectory/pivot data.                         |
| `sentiment_label` derived from `sentiment_score` | `message_sentiment`      | enum      | Provides a human-readable quality gate: if the label disagrees with the score range, the LLM may have produced an inconsistent result. |

**Quality filtering at query time**: Dashboard queries should exclude low-confidence results when computing aggregates:

```sql
-- High-confidence average (excludes ambiguous scores)
SELECT avg(sentiment_score) AS avg_sentiment_high_conf
FROM message_sentiment FINAL
WHERE tenant_id = {tenantId:String}
  AND confidence >= 0.5
  AND message_at >= {from:DateTime64(3)}
```

---

### 3.5 Design for Per-Record and Aggregation Queries

The schema supports both query patterns:

#### Per-Record Queries (drill-down to single conversation)

```sql
-- All message scores for a single conversation (drill-down view)
SELECT message_id, role, message_at, sentiment_score, sentiment_label,
       frustration_detected, frustration_signals, confidence
FROM message_sentiment FINAL
WHERE tenant_id = {tenantId:String}
  AND session_id = {sessionId:String}
ORDER BY message_at ASC
```

This query is efficient because `ORDER BY (tenant_id, session_id, message_id)` means `tenant_id + session_id` is a prefix match.

#### Aggregation Queries (dashboard widgets)

```sql
-- Average sentiment by agent over last 7 days
SELECT agent_name,
       avg(avg_sentiment) AS mean_sentiment,
       count() AS conversation_count,
       sum(frustration_detected) AS frustrated_conversations
FROM conversation_sentiment FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
  AND session_started_at < {to:DateTime64(3)}
GROUP BY agent_name
ORDER BY mean_sentiment ASC
```

This query benefits from the `mv_daily_sentiment` materialized view (defined in 3.9) for the time-series case, and directly queries `conversation_sentiment` for breakdown dimensions not covered by MVs.

---

### 3.6 Storage Choice: ClickHouse (Analytics) + MongoDB (Config)

| Data                                   | Store                                           | Rationale                                                                                   |
| -------------------------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------- |
| `message_sentiment` rows               | **ClickHouse**                                  | High volume (millions of rows), append-only, time-series aggregation, ORDER BY optimization |
| `conversation_sentiment` rows          | **ClickHouse**                                  | Same -- analytics workload, GROUP BY dimensions, time-range queries                         |
| Materialized views (daily aggregation) | **ClickHouse**                                  | Pre-computed rollups for dashboard scorecards and time-series charts                        |
| Pipeline configuration                 | **MongoDB** (`pipeline_configs`)                | Low volume, document structure, flexible schema, per-tenant/project scoping                 |
| Backfill workflow state                | **MongoDB** (`pipeline_configs.backfillStatus`) | Workflow state requires atomic updates, not analytics queries                               |

No MongoDB collections are needed for sentiment results. All output goes to ClickHouse.

---

### 3.7 ClickHouse Table DDL (Complete, Production-Ready)

#### `message_sentiment`

```sql
CREATE TABLE IF NOT EXISTS abl_platform.message_sentiment
(
    tenant_id             String                   CODEC(ZSTD(1)),
    project_id            String                   CODEC(ZSTD(1)),
    session_id            String                   CODEC(ZSTD(1)),
    message_id            String                   CODEC(ZSTD(1)),
    message_at            DateTime64(3)            CODEC(DoubleDelta, ZSTD(1)),
    processed_at          DateTime64(3)            CODEC(DoubleDelta, ZSTD(1)),

    role                  LowCardinality(String)   CODEC(ZSTD(1)),
    agent_name            LowCardinality(String)   CODEC(ZSTD(1)),
    channel               LowCardinality(String)   CODEC(ZSTD(1)),

    sentiment_score       Float32                  CODEC(Gorilla, ZSTD(1)),
    sentiment_label       LowCardinality(String)   CODEC(ZSTD(1)),
    frustration_detected  UInt8                    CODEC(T64, ZSTD(1)),
    frustration_signals   Array(String)            CODEC(ZSTD(3)),

    model_id              LowCardinality(String)   CODEC(ZSTD(1)),
    config_version        UInt32                   CODEC(T64, ZSTD(1)),
    confidence            Float32                  CODEC(Gorilla, ZSTD(1)),
    processing_ms         UInt32                   CODEC(T64, ZSTD(1)),

    -- Skip indices
    INDEX idx_frustration frustration_detected TYPE set(2) GRANULARITY 4,
    INDEX idx_label       sentiment_label      TYPE set(5) GRANULARITY 4,
    INDEX idx_session     session_id           TYPE bloom_filter GRANULARITY 4,
    INDEX idx_project     project_id           TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplicatedMergeTree(
    '/clickhouse/tables/{shard}/abl_platform.message_sentiment',
    '{replica}'
)
PARTITION BY (tenant_id, toYYYYMM(message_at))
ORDER BY (tenant_id, session_id, message_id)
TTL
    toDateTime(message_at) + INTERVAL 90 DAY TO VOLUME 'warm',
    toDateTime(message_at) + INTERVAL 365 DAY TO VOLUME 'cold',
    toDateTime(message_at) + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;
```

**Design choices:**

- `ENGINE = ReplicatedMergeTree(processed_at)` -- Latest result wins during re-processing. The `processed_at` field is the version column; when a backfill re-scores a message, the newer `processed_at` causes the old row to be replaced during merges.
- `PARTITION BY (tenant_id, toYYYYMM(message_at))` -- Tenant-level storage isolation. Monthly partitions for efficient time-range pruning. Dashboard queries always include `tenant_id` + time range, so partition pruning is guaranteed.
- `ORDER BY (tenant_id, session_id, message_id)` -- Optimized for the most common access pattern: "get all message scores for a conversation" (drill-down). The tenant_id prefix ensures cross-tenant queries never scan other tenants' data.
- **CODEC choices**: `Gorilla` for float scores (good for slowly changing values), `DoubleDelta` for timestamps, `T64` for small integers, `ZSTD(3)` for the variable-length `frustration_signals` array.
- **TTL tiers**: 90 days hot (SSD), 90-365 days warm (HDD), 365-730 days cold (object storage), delete after 730 days. Aligned with platform retention policy.

**Refinement vs plan**: The plan's `message_sentiment` table lacked `project_id`, skip indices, CODEC specifications, and tiered TTL. These additions are necessary for production: `project_id` is required for API route scoping, skip indices accelerate filtered scans, CODECs reduce storage 3-5x, and tiered TTL manages cost.

#### `conversation_sentiment`

```sql
CREATE TABLE IF NOT EXISTS abl_platform.conversation_sentiment
(
    tenant_id               String                   CODEC(ZSTD(1)),
    project_id              String                   CODEC(ZSTD(1)),
    session_id              String                   CODEC(ZSTD(1)),
    session_started_at      DateTime64(3)            CODEC(DoubleDelta, ZSTD(1)),
    processed_at            DateTime64(3)            CODEC(DoubleDelta, ZSTD(1)),

    agent_name              LowCardinality(String)   CODEC(ZSTD(1)),
    channel                 LowCardinality(String)   CODEC(ZSTD(1)),

    avg_sentiment           Float32                  CODEC(Gorilla, ZSTD(1)),
    start_sentiment         Float32                  CODEC(Gorilla, ZSTD(1)),
    end_sentiment           Float32                  CODEC(Gorilla, ZSTD(1)),
    min_sentiment           Float32                  CODEC(Gorilla, ZSTD(1)),
    max_sentiment           Float32                  CODEC(Gorilla, ZSTD(1)),
    sentiment_trajectory    LowCardinality(String)   CODEC(ZSTD(1)),
    sentiment_shift_count   UInt16                   CODEC(T64, ZSTD(1)),

    frustration_turn_count  UInt16                   CODEC(T64, ZSTD(1)),
    frustration_detected    UInt8                    CODEC(T64, ZSTD(1)),

    pivot_count             UInt16                   CODEC(T64, ZSTD(1)),
    worst_pivot_at          Nullable(DateTime64(3))  CODEC(ZSTD(1)),
    worst_pivot_delta       Nullable(Float32)        CODEC(ZSTD(1)),

    model_id                LowCardinality(String)   CODEC(ZSTD(1)),
    config_version          UInt32                   CODEC(T64, ZSTD(1)),
    message_count           UInt16                   CODEC(T64, ZSTD(1)),
    processing_ms           UInt32                   CODEC(T64, ZSTD(1)),

    -- Skip indices
    INDEX idx_trajectory    sentiment_trajectory TYPE set(10)       GRANULARITY 4,
    INDEX idx_frustration   frustration_detected TYPE set(2)        GRANULARITY 4,
    INDEX idx_project       project_id           TYPE bloom_filter  GRANULARITY 4,
    INDEX idx_avg_sentiment avg_sentiment        TYPE minmax        GRANULARITY 4,
    INDEX idx_channel       channel              TYPE set(20)       GRANULARITY 4
)
ENGINE = ReplicatedMergeTree(
    '/clickhouse/tables/{shard}/abl_platform.conversation_sentiment',
    '{replica}'
)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL
    toDateTime(session_started_at) + INTERVAL 90 DAY TO VOLUME 'warm',
    toDateTime(session_started_at) + INTERVAL 365 DAY TO VOLUME 'cold',
    toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;
```

**Design choices:**

- `ORDER BY (tenant_id, project_id, session_id)` -- Optimized for: (a) single-conversation lookup by session_id (full prefix match), (b) project-scoped aggregations (tenant_id + project_id prefix). The `project_id` in ORDER BY is critical because every API endpoint filters by project.
- `idx_avg_sentiment TYPE minmax` -- Enables efficient filtering for "show me conversations with sentiment below X" without full partition scans.
- `idx_trajectory TYPE set(10)` -- Only 4 distinct values (`improving`, `declining`, `stable`, `volatile`), so set index is optimal.

**Refinements vs plan**: Added `project_id` to ORDER BY (was missing, causing project-scoped queries to scan entire tenant partitions), added skip indices, CODECs, and tiered TTL.

---

### 3.8 TTL Policy

| Table                      | Hot (SSD)                | Warm (HDD)  | Cold (Object Store) | Delete    |
| -------------------------- | ------------------------ | ----------- | ------------------- | --------- |
| `message_sentiment`        | 0-90 days                | 90-365 days | 365-730 days        | >730 days |
| `conversation_sentiment`   | 0-90 days                | 90-365 days | 365-730 days        | >730 days |
| `mv_daily_sentiment_dest`  | No tiering (small table) | --          | --                  | >730 days |
| `mv_hourly_sentiment_dest` | No tiering (small table) | --          | --                  | >90 days  |

**Alignment with source data**:

- Source `messages` table TTL: 730 days (delete). Sentiment results use the same 730-day retention.
- Source `traces` table TTL: 90 days (delete). Sentiment results outlive traces because the derived scores remain valuable for trend analysis even after raw traces expire.
- Source `sessions` MongoDB: No TTL. Session metadata remains available for joins indefinitely.

**Re-processing window**: The TTL structure ensures that data remains hot (fast to re-process) for 90 days, which exceeds the maximum `lookbackDays` config value of 90. This means backfills always read from hot storage.

---

### 3.9 Materialized Views

#### MV 1: Daily Sentiment Aggregation (backs time-series and scorecard)

**Destination table:**

```sql
CREATE TABLE IF NOT EXISTS abl_platform.mv_daily_sentiment_dest
(
    tenant_id           String,
    project_id          String,
    date                Date,
    agent_name          LowCardinality(String),
    channel             LowCardinality(String),

    conversation_count  SimpleAggregateFunction(sum, UInt64),
    total_sentiment     SimpleAggregateFunction(sum, Float64),
    declining_count     SimpleAggregateFunction(sum, UInt64),
    improving_count     SimpleAggregateFunction(sum, UInt64),
    frustrated_count    SimpleAggregateFunction(sum, UInt64),
    total_frustration_turns  SimpleAggregateFunction(sum, UInt64),
    total_pivot_count   SimpleAggregateFunction(sum, UInt64),
    total_message_count SimpleAggregateFunction(sum, UInt64),
    total_processing_ms SimpleAggregateFunction(sum, UInt64),
    min_avg_sentiment   SimpleAggregateFunction(min, Float32),
    max_avg_sentiment   SimpleAggregateFunction(max, Float32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name, channel)
TTL date + INTERVAL 730 DAY DELETE
SETTINGS index_granularity = 8192;
```

**Materialized view:**

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_sentiment
TO abl_platform.mv_daily_sentiment_dest
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    agent_name,
    channel,
    sumSimpleState(toUInt64(1))                                                           AS conversation_count,
    sumSimpleState(toFloat64(avg_sentiment))                                               AS total_sentiment,
    sumSimpleState(toUInt64(if(sentiment_trajectory = 'declining', 1, 0)))                  AS declining_count,
    sumSimpleState(toUInt64(if(sentiment_trajectory = 'improving', 1, 0)))                  AS improving_count,
    sumSimpleState(toUInt64(if(frustration_detected = 1, 1, 0)))                           AS frustrated_count,
    sumSimpleState(toUInt64(frustration_turn_count))                                        AS total_frustration_turns,
    sumSimpleState(toUInt64(pivot_count))                                                   AS total_pivot_count,
    sumSimpleState(toUInt64(message_count))                                                 AS total_message_count,
    sumSimpleState(toUInt64(processing_ms))                                                 AS total_processing_ms,
    minSimpleState(avg_sentiment)                                                           AS min_avg_sentiment,
    maxSimpleState(avg_sentiment)                                                           AS max_avg_sentiment
FROM abl_platform.conversation_sentiment
GROUP BY tenant_id, project_id, date, agent_name, channel;
```

**Usage**: Average sentiment = `total_sentiment / conversation_count`. Declining rate = `declining_count / conversation_count`. This MV covers the scorecard, time-series, and breakdown-by-agent views.

**Refinement vs plan**: The plan's `mv_daily_sentiment` used `SummingMergeTree` and lacked `channel`, `improving_count`, min/max sentiment, and message counts. The refined version uses `AggregatingMergeTree` with `SimpleAggregateFunction` for correct incremental merging and adds the missing dimensions.

#### MV 2: Hourly Sentiment (backs real-time monitoring)

**Destination table:**

```sql
CREATE TABLE IF NOT EXISTS abl_platform.mv_hourly_sentiment_dest
(
    tenant_id           String,
    project_id          String,
    hour                DateTime,
    agent_name          LowCardinality(String),

    conversation_count  SimpleAggregateFunction(sum, UInt64),
    total_sentiment     SimpleAggregateFunction(sum, Float64),
    frustrated_count    SimpleAggregateFunction(sum, UInt64),
    declining_count     SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(hour))
ORDER BY (tenant_id, project_id, hour, agent_name)
TTL hour + INTERVAL 90 DAY DELETE
SETTINGS index_granularity = 8192;
```

**Materialized view:**

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_hourly_sentiment
TO abl_platform.mv_hourly_sentiment_dest
AS SELECT
    tenant_id,
    project_id,
    toStartOfHour(session_started_at) AS hour,
    agent_name,
    sumSimpleState(toUInt64(1))                                             AS conversation_count,
    sumSimpleState(toFloat64(avg_sentiment))                                 AS total_sentiment,
    sumSimpleState(toUInt64(if(frustration_detected = 1, 1, 0)))            AS frustrated_count,
    sumSimpleState(toUInt64(if(sentiment_trajectory = 'declining', 1, 0)))  AS declining_count
FROM abl_platform.conversation_sentiment
GROUP BY tenant_id, project_id, hour, agent_name;
```

**Usage**: Hourly granularity for the time-series chart when `granularity=hourly` is requested. 90-day TTL keeps this table small. Drops to daily MV for older data.

#### MV 3: Daily Message-Level Frustration Distribution (backs frustration breakdown)

**Destination table:**

```sql
CREATE TABLE IF NOT EXISTS abl_platform.mv_daily_frustration_dest
(
    tenant_id           String,
    project_id          String,
    date                Date,
    agent_name          LowCardinality(String),

    total_messages      SimpleAggregateFunction(sum, UInt64),
    frustrated_messages SimpleAggregateFunction(sum, UInt64)
)
ENGINE = AggregatingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name)
TTL date + INTERVAL 730 DAY DELETE
SETTINGS index_granularity = 8192;
```

**Materialized view:**

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_frustration
TO abl_platform.mv_daily_frustration_dest
AS SELECT
    tenant_id,
    project_id,
    toDate(message_at) AS date,
    agent_name,
    sumSimpleState(toUInt64(1))                                        AS total_messages,
    sumSimpleState(toUInt64(if(frustration_detected = 1, 1, 0)))       AS frustrated_messages
FROM abl_platform.message_sentiment
GROUP BY tenant_id, project_id, date, agent_name;
```

---

### 3.10 Tenant Isolation

**Invariant**: Every table has `tenant_id` as the first column in the ORDER BY and as part of the PARTITION BY key.

| Enforcement Layer | Mechanism                                                                                                                                         |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Storage**       | `PARTITION BY (tenant_id, ...)` -- Tenant data is physically separated into distinct partitions.                                                  |
| **Query**         | Every query includes `WHERE tenant_id = {tenantId:String}` as the first filter. The analytics API injects this from `req.tenantContext.tenantId`. |
| **API**           | Route handlers extract `tenantId` from the authenticated session. Never from query parameters.                                                    |
| **Pipeline**      | The `compute-sentiment` activity receives `tenantId` from `pipelineInput` (injected by PipelineTrigger from the Kafka event).                     |
| **Backfill**      | Backfill queries are scoped: `WHERE tenant_id = {tenantId:String}`.                                                                               |

**Cross-tenant access returns 404**: If a query returns no results (because the session belongs to a different tenant), the API returns 404, not 403, to avoid leaking existence.

---

### 3.11 Re-Processing Strategy

When a customer changes a re-processing parameter (scale, analyzeRoles, frustration keywords, etc.), the system must replace old results:

**Mechanism**: `ReplacingMergeTree(processed_at)`

1. The backfill workflow re-scores affected conversations.
2. New rows are inserted with the same `(tenant_id, session_id, message_id)` key (for `message_sentiment`) or `(tenant_id, project_id, session_id)` key (for `conversation_sentiment`) but with a newer `processed_at`.
3. ClickHouse eventually deduplicates during background merges, keeping only the row with the latest `processed_at`.
4. Queries use `FINAL` for point lookups or `argMax` for aggregations to get correct results before merges complete.

**Config version tracking**: Every output row includes `config_version`. After re-processing:

```sql
-- Verify re-processing completion: count rows still on old config
SELECT config_version, count() AS row_count
FROM conversation_sentiment FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= now() - INTERVAL 30 DAY
GROUP BY config_version
```

**Partial re-processing**: When only `frustrationKeywords` changes, the system can optimize by re-running only the frustration detection step (zero-cost pattern matching) without re-invoking the LLM for sentiment scoring. The `compute-sentiment` activity should accept a `reprocessMode` parameter: `'full'` (re-score everything) or `'frustration_only'` (re-run frustration detection, keep existing scores).

---

## Phase 4: Presentation Design

**Goal**: Define every view the customer sees for sentiment analytics. Each view maps to a ClickHouse query and an API endpoint, validating the Phase 3 schema.

---

### 4.1 Primary Dashboard Widget

The sentiment pipeline powers the **Sentiment tab** within the Analytics page:

```
Studio > Project > Analytics > Sentiment
```

The tab contains four sections, visible without scrolling:

1. **Scorecard strip** (4.2) -- single-number metrics at the top
2. **Time-series chart** (4.3) -- sentiment trend over time
3. **Breakdown panel** (4.4) -- sentiment by agent/channel
4. **Conversation list** (4.5) -- drill-down table

```
┌─────────────────────────────────────────────────────────────────────────────────┐
│  Analytics > [Overview] [Sessions] [LLM] [Sentiment*] [Quality] [Intents]      │
│                                                                                 │
│  Period: [Last 7 days ▼]   Compare: [Previous period ▼]   Agent: [All ▼]       │
│                                                                                 │
│  ┌────────────┐ ┌────────────┐ ┌────────────┐ ┌────────────┐                   │
│  │ Avg Score   │ │ Positive % │ │ Declining  │ │ Frustrated │                   │
│  │   +0.42     │ │   68.3%    │ │   12.4%    │ │   8.7%     │                   │
│  │  +0.05      │ │  +2.1pp    │ │  -1.8pp    │ │  -0.5pp    │                   │
│  │ vs prior    │ │ vs prior   │ │ vs prior   │ │ vs prior   │                   │
│  └────────────┘ └────────────┘ └────────────┘ └────────────┘                   │
│                                                                                 │
│  Sentiment Trend                                              [Daily|Hourly]    │
│  +1.0 ┤                                                                        │
│  +0.5 ┤       ╭──╮    ╭───────╮                                                │
│   0.0 ┤╭─────╯    ╰──╯         ╰────╮                                          │
│  -0.5 ┤╯                              ╰─╮                                      │
│  -1.0 ┤                                  ╰──                                   │
│       └─────────────────────────────────────                                    │
│        Mon   Tue   Wed   Thu   Fri   Sat   Sun                                  │
│        --- avg sentiment   ··· frustration rate                                 │
│                                                                                 │
│  ┌─ By Agent ──────────────────────┐  ┌─ By Channel ─────────────────────────┐  │
│  │ BillingAgent  ████████████ +0.62│  │ web_chat   █████████████████  +0.48  │  │
│  │ SalesAgent    ██████████   +0.48│  │ voice      ███████████████    +0.41  │  │
│  │ SupportAgent  ████████     +0.31│  │ slack      █████████████      +0.35  │  │
│  │ ReturnAgent   ██████       +0.18│  │ email      ███████████        +0.29  │  │
│  └─────────────────────────────────┘  └──────────────────────────────────────┘  │
│                                                                                 │
│  Conversations                      Filter: [All ▼] [Declining ▼] [Frustrated] │
│  ┌──────────────────────────────────────────────────────────────────────────┐   │
│  │ Session          │ Agent       │ Avg   │ Trajectory │ Frust │ Time      │   │
│  │──────────────────│─────────────│───────│────────────│───────│───────────│   │
│  │ sess-abc-1234    │ SupportAgent│ -0.45 │ declining  │  3    │ 2h ago    │   │
│  │ sess-def-5678    │ ReturnAgent │ -0.32 │ volatile   │  2    │ 3h ago    │   │
│  │ sess-ghi-9012    │ BillingAgent│ +0.71 │ improving  │  0    │ 4h ago    │   │
│  │ ...              │             │       │            │       │           │   │
│  └──────────────────────────────────────────────────────────────────────────┘   │
│  Showing 1-50 of 1,247        [< Previous]  [Next >]                            │
└─────────────────────────────────────────────────────────────────────────────────┘
```

---

### 4.2 "At a Glance" Scorecard Metrics

Four KPI cards displayed at the top of the dashboard:

| Card           | Metric                                                 | Computation                                                      | Comparison                                                    |
| -------------- | ------------------------------------------------------ | ---------------------------------------------------------------- | ------------------------------------------------------------- |
| **Avg Score**  | Mean `avg_sentiment` across all conversations          | `total_sentiment / conversation_count` from `mv_daily_sentiment` | Delta vs prior period (same-length window immediately before) |
| **Positive %** | Percentage of conversations with `avg_sentiment > 0.2` | Count where `avg_sentiment > 0.2` / total count                  | Percentage point change vs prior                              |
| **Declining**  | Percentage with `sentiment_trajectory = 'declining'`   | `declining_count / conversation_count` from MV                   | Percentage point change vs prior                              |
| **Frustrated** | Percentage with `frustration_detected = 1`             | `frustrated_count / conversation_count` from MV                  | Percentage point change vs prior                              |

**Backing query (single query for all 4 cards):**

```sql
SELECT
    -- Current period
    sum(conversation_count) AS total_conversations,
    sum(total_sentiment) / sum(conversation_count) AS avg_sentiment,
    sum(declining_count) AS total_declining,
    sum(frustrated_count) AS total_frustrated,
    -- We need positive count from the base table (not in MV)
    -- Handled by a secondary query or an additional MV column
    sum(improving_count) AS total_improving
FROM abl_platform.mv_daily_sentiment_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
```

For the **Positive %** metric, we need a count of conversations where `avg_sentiment > 0.2`. This is not directly available in the MV (which sums, not counts conditionals on continuous values). Two options:

**Option A** (chosen): Add `positive_count` to the MV:

```sql
sumSimpleState(toUInt64(if(avg_sentiment > 0.2, 1, 0))) AS positive_count,
sumSimpleState(toUInt64(if(avg_sentiment < -0.2, 1, 0))) AS negative_count,
sumSimpleState(toUInt64(if(avg_sentiment >= -0.2 AND avg_sentiment <= 0.2, 1, 0))) AS neutral_count
```

These are added to the `mv_daily_sentiment_dest` table and the MV definition (see Phase 5 for the complete updated DDL).

**Option B**: Query `conversation_sentiment` directly for the scorecard (fallback if MV is insufficient).

**Comparison query** (prior period): The same query with `date >= {prior_from:Date} AND date < {prior_to:Date}` where the prior period is the same-length window immediately before the current period (e.g., last 7 days vs the 7 days before that).

**API endpoint:**

```
GET /api/projects/:projectId/analytics/sentiment/summary?period=7d
```

---

### 4.3 Time-Series Chart

A dual-axis line chart showing sentiment trend and frustration rate over time.

**Primary line**: Average sentiment score (left Y axis, -1.0 to +1.0)
**Secondary line**: Frustration rate as percentage (right Y axis, 0% to 100%)
**X axis**: Time buckets (daily or hourly based on selected granularity)

**Granularity selection:**

| Period        | Default Granularity | Available     |
| ------------- | ------------------- | ------------- |
| Last 24 hours | Hourly              | Hourly        |
| Last 7 days   | Daily               | Daily, Hourly |
| Last 30 days  | Daily               | Daily         |
| Last 90 days  | Daily               | Daily         |

**Backing query (daily granularity):**

```sql
SELECT
    date,
    sum(conversation_count) AS conversations,
    sum(total_sentiment) / sum(conversation_count) AS avg_sentiment,
    sum(frustrated_count) / sum(conversation_count) AS frustration_rate,
    sum(declining_count) / sum(conversation_count) AS declining_rate,
    sum(improving_count) / sum(conversation_count) AS improving_rate
FROM abl_platform.mv_daily_sentiment_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY date
ORDER BY date ASC
```

**Backing query (hourly granularity):**

```sql
SELECT
    hour,
    sum(conversation_count) AS conversations,
    sum(total_sentiment) / sum(conversation_count) AS avg_sentiment,
    sum(frustrated_count) / sum(conversation_count) AS frustration_rate,
    sum(declining_count) / sum(conversation_count) AS declining_rate
FROM abl_platform.mv_hourly_sentiment_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND hour >= {from:DateTime}
  AND hour < {to:DateTime}
GROUP BY hour
ORDER BY hour ASC
```

**API endpoint:**

```
GET /api/projects/:projectId/analytics/sentiment/summary?period=7d&granularity=daily
```

Response:

```json
{
  "success": true,
  "data": {
    "scorecard": {
      "avgSentiment": 0.42,
      "avgSentimentDelta": 0.05,
      "positiveRate": 0.683,
      "positiveRateDelta": 0.021,
      "decliningRate": 0.124,
      "decliningRateDelta": -0.018,
      "frustrationRate": 0.087,
      "frustrationRateDelta": -0.005,
      "totalConversations": 1247,
      "period": { "from": "2026-02-24T00:00:00Z", "to": "2026-03-03T00:00:00Z" },
      "comparisonPeriod": { "from": "2026-02-17T00:00:00Z", "to": "2026-02-24T00:00:00Z" }
    },
    "timeSeries": [
      { "date": "2026-02-24", "avgSentiment": 0.38, "frustrationRate": 0.092, "decliningRate": 0.14, "improvingRate": 0.32, "conversations": 178 },
      { "date": "2026-02-25", "avgSentiment": 0.41, "frustrationRate": 0.088, "decliningRate": 0.13, "improvingRate": 0.34, "conversations": 185 },
      ...
    ]
  }
}
```

---

### 4.4 Breakdown / Distribution View

Two side-by-side bar charts showing sentiment broken down by dimension.

**Dimensions available:**

| Dimension              | Column                                        | Use Case                                               |
| ---------------------- | --------------------------------------------- | ------------------------------------------------------ |
| `agent_name`           | `conversation_sentiment.agent_name`           | Which agents produce the best/worst customer sentiment |
| `channel`              | `conversation_sentiment.channel`              | How does sentiment differ across web, voice, Slack     |
| `sentiment_trajectory` | `conversation_sentiment.sentiment_trajectory` | Distribution of improving/declining/stable/volatile    |
| `sentiment_label`      | Derived from `avg_sentiment`                  | Positive/neutral/negative distribution pie chart       |

**Backing query (by agent):**

```sql
SELECT
    agent_name,
    sum(conversation_count) AS conversations,
    sum(total_sentiment) / sum(conversation_count) AS avg_sentiment,
    sum(declining_count) / sum(conversation_count) AS declining_rate,
    sum(frustrated_count) / sum(conversation_count) AS frustration_rate
FROM abl_platform.mv_daily_sentiment_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY agent_name
ORDER BY avg_sentiment ASC
```

**Backing query (by channel):**

```sql
SELECT
    channel,
    sum(conversation_count) AS conversations,
    sum(total_sentiment) / sum(conversation_count) AS avg_sentiment,
    sum(frustrated_count) / sum(conversation_count) AS frustration_rate
FROM abl_platform.mv_daily_sentiment_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {from:Date}
  AND date < {to:Date}
GROUP BY channel
ORDER BY avg_sentiment ASC
```

**Backing query (trajectory distribution):**

```sql
SELECT
    sentiment_trajectory,
    count() AS conversations
FROM abl_platform.conversation_sentiment FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
  AND session_started_at < {to:DateTime64(3)}
GROUP BY sentiment_trajectory
ORDER BY conversations DESC
```

**API endpoint:**

```
GET /api/projects/:projectId/analytics/sentiment/breakdown?period=7d&dimension=agent_name
```

Response:

```json
{
  "success": true,
  "data": {
    "dimension": "agent_name",
    "period": { "from": "2026-02-24T00:00:00Z", "to": "2026-03-03T00:00:00Z" },
    "buckets": [
      {
        "key": "BillingAgent",
        "avgSentiment": 0.62,
        "conversations": 312,
        "decliningRate": 0.08,
        "frustrationRate": 0.05
      },
      {
        "key": "SalesAgent",
        "avgSentiment": 0.48,
        "conversations": 287,
        "decliningRate": 0.11,
        "frustrationRate": 0.07
      },
      {
        "key": "SupportAgent",
        "avgSentiment": 0.31,
        "conversations": 412,
        "decliningRate": 0.16,
        "frustrationRate": 0.12
      },
      {
        "key": "ReturnAgent",
        "avgSentiment": 0.18,
        "conversations": 236,
        "decliningRate": 0.22,
        "frustrationRate": 0.15
      }
    ]
  }
}
```

---

### 4.5 Drill-Down Path

```
Level 1: Scorecard         "Avg sentiment is +0.42"
   |
   v  (click declining rate card)
Level 2: Conversation List  "154 conversations with declining sentiment"
   |
   v  (click a row)
Level 3: Conversation Detail  Sentiment arc chart + message-level scores
   |
   v  (click a message)
Level 4: Trace Detail       LLM call, tool execution, flow steps (existing trace viewer)
```

**Level 2 -- Conversation List:**

```
GET /api/projects/:projectId/analytics/sentiment/conversations
    ?period=7d&filter=trajectory:declining&sort=avg_sentiment:asc&page=1&pageSize=50
```

**Backing query:**

```sql
SELECT
    session_id,
    session_started_at,
    agent_name,
    channel,
    avg_sentiment,
    sentiment_trajectory,
    frustration_turn_count,
    frustration_detected,
    pivot_count,
    message_count,
    start_sentiment,
    end_sentiment
FROM abl_platform.conversation_sentiment FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
  AND session_started_at < {to:DateTime64(3)}
  AND sentiment_trajectory = 'declining'
ORDER BY avg_sentiment ASC
LIMIT 50 OFFSET 0
```

Response:

```json
{
  "success": true,
  "data": {
    "conversations": [
      {
        "sessionId": "sess-abc-1234",
        "sessionStartedAt": "2026-03-03T07:12:00.000Z",
        "agentName": "SupportAgent",
        "channel": "web_chat",
        "avgSentiment": -0.45,
        "trajectory": "declining",
        "frustrationTurnCount": 3,
        "frustrationDetected": true,
        "pivotCount": 2,
        "messageCount": 11,
        "startSentiment": 0.15,
        "endSentiment": -0.72
      }
    ],
    "total": 154,
    "page": 1,
    "pageSize": 50,
    "hasMore": true
  }
}
```

**Level 3 -- Single Conversation Detail:**

```
GET /api/projects/:projectId/analytics/sentiment/conversation/:sessionId
```

**Backing query (two parallel queries):**

```sql
-- Query 1: Conversation summary
SELECT *
FROM abl_platform.conversation_sentiment FINAL
WHERE tenant_id = {tenantId:String}
  AND session_id = {sessionId:String}

-- Query 2: Per-message sentiment arc
SELECT
    message_id,
    message_at,
    role,
    sentiment_score,
    sentiment_label,
    frustration_detected,
    frustration_signals,
    confidence
FROM abl_platform.message_sentiment FINAL
WHERE tenant_id = {tenantId:String}
  AND session_id = {sessionId:String}
ORDER BY message_at ASC
```

Response:

```json
{
  "success": true,
  "data": {
    "summary": {
      "sessionId": "sess-abc-1234",
      "avgSentiment": -0.45,
      "trajectory": "declining",
      "startSentiment": 0.15,
      "endSentiment": -0.72,
      "pivotCount": 2,
      "worstPivotAt": "2026-03-03T07:18:32.000Z",
      "worstPivotDelta": -0.55,
      "frustrationTurnCount": 3,
      "messageCount": 11
    },
    "messages": [
      {
        "messageId": "msg-001",
        "messageAt": "2026-03-03T07:12:00.000Z",
        "role": "user",
        "sentimentScore": 0.15,
        "sentimentLabel": "neutral",
        "frustrationDetected": false,
        "frustrationSignals": [],
        "confidence": 0.82
      },
      {
        "messageId": "msg-003",
        "messageAt": "2026-03-03T07:14:22.000Z",
        "role": "user",
        "sentimentScore": -0.1,
        "sentimentLabel": "neutral",
        "frustrationDetected": false,
        "frustrationSignals": [],
        "confidence": 0.78
      },
      {
        "messageId": "msg-005",
        "messageAt": "2026-03-03T07:18:32.000Z",
        "role": "user",
        "sentimentScore": -0.65,
        "sentimentLabel": "negative",
        "frustrationDetected": true,
        "frustrationSignals": ["ALL_CAPS", "keyword:cancel"],
        "confidence": 0.91
      }
    ]
  }
}
```

---

### 4.6 Comparison View

Two comparison modes:

**Mode A: Period-over-Period** (default, shown in scorecard deltas)

Compares the selected period against the immediately prior period of equal length. The scorecard delta values ("+0.05", "+2.1pp") already provide this.

For a dedicated comparison view, the time-series chart overlays both periods:

```
Sentiment: This Week vs Last Week
+1.0 ┤
+0.5 ┤       ╭──╮                  ╭──╮
 0.0 ┤╭─────╯    ╰──╮          ╭──╯    ╰──╮
-0.5 ┤╯              ╰──       ╯            ╰──
     └──────────────────────────────────────────
      Mon   Tue   Wed   Thu   Fri   Sat   Sun
      ── This week   -- Last week
```

**Backing query:**

```sql
SELECT
    toDayOfWeek(date) AS day_of_week,
    sum(if(date >= {current_from:Date}, total_sentiment, 0)) /
        nullIf(sum(if(date >= {current_from:Date}, conversation_count, 0)), 0) AS current_avg,
    sum(if(date < {current_from:Date}, total_sentiment, 0)) /
        nullIf(sum(if(date < {current_from:Date}, conversation_count, 0)), 0) AS prior_avg
FROM abl_platform.mv_daily_sentiment_dest
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND date >= {prior_from:Date}
  AND date < {current_to:Date}
GROUP BY day_of_week
ORDER BY day_of_week ASC
```

**Mode B: Agent-to-Agent Comparison**

Side-by-side comparison of two agents' sentiment metrics:

```
┌──────────────────────────────────────┐
│ SupportAgent vs BillingAgent          │
│                                       │
│              Support    Billing        │
│ Avg Score      +0.31      +0.62       │
│ Declining      16.0%       8.0%       │
│ Frustrated     12.0%       5.0%       │
│ Avg Pivots      2.1        0.8        │
│                                       │
│ Δ Sentiment: -0.31 (Support is lower) │
└──────────────────────────────────────┘
```

**Backing query:** Same as breakdown query (4.4) with `agent_name IN ({agent1:String}, {agent2:String})`.

No dedicated API endpoint for comparison -- the frontend computes the delta from the breakdown response.

---

### 4.7 Export / Report Format

**CSV Export:**

```
GET /api/projects/:projectId/analytics/sentiment/export?period=30d&format=csv&level=conversation
```

Two export levels:

**Conversation-level CSV** (default):

```csv
session_id,session_started_at,agent_name,channel,avg_sentiment,start_sentiment,end_sentiment,trajectory,frustration_detected,frustration_turn_count,pivot_count,message_count
sess-abc-1234,2026-03-03T07:12:00.000Z,SupportAgent,web_chat,-0.45,0.15,-0.72,declining,true,3,2,11
sess-def-5678,2026-03-03T08:30:00.000Z,BillingAgent,web_chat,0.62,0.10,0.75,improving,false,0,1,8
```

**Message-level CSV:**

```csv
session_id,message_id,message_at,role,sentiment_score,sentiment_label,frustration_detected,frustration_signals,confidence
sess-abc-1234,msg-001,2026-03-03T07:12:00.000Z,user,0.15,neutral,false,,0.82
sess-abc-1234,msg-003,2026-03-03T07:14:22.000Z,user,-0.10,neutral,false,,0.78
sess-abc-1234,msg-005,2026-03-03T07:18:32.000Z,user,-0.65,negative,true,"ALL_CAPS,keyword:cancel",0.91
```

**Backing query (conversation-level):**

```sql
SELECT
    session_id,
    formatDateTime(session_started_at, '%Y-%m-%dT%H:%i:%S.000Z') AS session_started_at,
    agent_name,
    channel,
    avg_sentiment,
    start_sentiment,
    end_sentiment,
    sentiment_trajectory AS trajectory,
    if(frustration_detected, 'true', 'false') AS frustration_detected,
    frustration_turn_count,
    pivot_count,
    message_count
FROM abl_platform.conversation_sentiment FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
  AND session_started_at < {to:DateTime64(3)}
ORDER BY session_started_at DESC
FORMAT CSVWithNames
```

**Implementation**: For exports under 10,000 rows, stream directly from the API response. For larger exports, enqueue a background job via Restate that writes to object storage (S3/MinIO) and returns a download URL.

**Scheduled reports**: Not in initial scope. Future enhancement via the anomaly detection / alerting pipeline.

---

### 4.8 Alert Presentation

Sentiment alerts are triggered by the `evaluate-policy` step in the pipeline definition. Three presentation channels:

| Channel                 | Presentation                                                                                          | Trigger                                                                                        |
| ----------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| **In-app (Watchtower)** | Banner notification in Studio with link to the conversation. Badge count on Analytics tab.            | `frustration_detected = 1` or `sentiment_trajectory = 'declining'` with `avg_sentiment < -0.3` |
| **Email**               | Daily digest: "12 conversations had declining sentiment yesterday. 5 triggered frustration alerts."   | Batched daily summary, not per-conversation.                                                   |
| **Slack/Webhook**       | Real-time message: "Declining sentiment detected in session sess-abc-1234 (SupportAgent, avg: -0.45)" | Per-conversation, rate-limited to 1 per minute per channel.                                    |

**In-app alert data structure** (stored in MongoDB `watchtower_alerts`):

```json
{
  "tenantId": "tenant_acme",
  "projectId": "proj_support",
  "type": "sentiment_alert",
  "severity": "warning",
  "sessionId": "sess-abc-1234",
  "agentName": "SupportAgent",
  "data": {
    "avgSentiment": -0.45,
    "trajectory": "declining",
    "frustrationTurnCount": 3
  },
  "createdAt": "2026-03-03T07:25:00.000Z",
  "acknowledged": false
}
```

---

### 4.9 API Endpoints (Complete Specification)

All endpoints are mounted at `/api/projects/:projectId/analytics/sentiment`.

**Middleware chain** (same as existing analytics routes):

```
authMiddleware -> requireProjectScope('projectId') -> tenantRateLimit('request')
```

**Permission**: `session:read` (same as existing analytics endpoints -- sentiment is read-only derived data).

| #   | Method | Path                       | Purpose                        | Cache      |
| --- | ------ | -------------------------- | ------------------------------ | ---------- |
| 1   | GET    | `/summary`                 | Scorecard + time-series        | Redis 5min |
| 2   | GET    | `/breakdown`               | By dimension                   | Redis 5min |
| 3   | GET    | `/conversations`           | Conversation list with filters | No cache   |
| 4   | GET    | `/conversation/:sessionId` | Single conversation detail     | Redis 1hr  |
| 5   | GET    | `/export`                  | CSV download                   | No cache   |

#### Endpoint 1: Summary

```
GET /api/projects/:projectId/analytics/sentiment/summary
    ?period=7d
    &granularity=daily     // daily | hourly (default: daily)
    &agent=                // optional: filter to one agent
    &channel=              // optional: filter to one channel
```

#### Endpoint 2: Breakdown

```
GET /api/projects/:projectId/analytics/sentiment/breakdown
    ?period=7d
    &dimension=agent_name  // agent_name | channel | sentiment_trajectory
    &agent=                // optional pre-filter
    &channel=              // optional pre-filter
```

#### Endpoint 3: Conversation List

```
GET /api/projects/:projectId/analytics/sentiment/conversations
    ?period=7d
    &filter=trajectory:declining,frustration:true  // comma-separated filters
    &sort=avg_sentiment:asc                       // sort field:direction
    &page=1
    &pageSize=50           // max 200
    &agent=                // optional pre-filter
    &channel=              // optional pre-filter
```

**Supported filters:**

| Filter      | Syntax                 | ClickHouse WHERE clause              |
| ----------- | ---------------------- | ------------------------------------ |
| Trajectory  | `trajectory:declining` | `sentiment_trajectory = 'declining'` |
| Frustration | `frustration:true`     | `frustration_detected = 1`           |
| Score range | `score_lt:-0.2`        | `avg_sentiment < -0.2`               |
| Score range | `score_gt:0.5`         | `avg_sentiment > 0.5`                |
| Min pivots  | `pivots_gt:2`          | `pivot_count > 2`                    |

**Supported sort fields:** `avg_sentiment`, `session_started_at`, `frustration_turn_count`, `pivot_count`

#### Endpoint 4: Single Conversation

```
GET /api/projects/:projectId/analytics/sentiment/conversation/:sessionId
```

No query parameters. Returns conversation summary + all message-level scores.

#### Endpoint 5: Export

```
GET /api/projects/:projectId/analytics/sentiment/export
    ?period=30d
    &format=csv           // csv (only format initially)
    &level=conversation   // conversation | message
    &filter=              // same filter syntax as conversations endpoint
```

Returns `Content-Type: text/csv` with `Content-Disposition: attachment; filename="sentiment-export-2026-03-03.csv"`.

---

### 4.10 Backing ClickHouse Queries (Complete Reference)

All queries for all views are documented inline in sections 4.2 through 4.7 above. Summary index:

| View                    | Section | Query Source                                                | MV Used?             |
| ----------------------- | ------- | ----------------------------------------------------------- | -------------------- |
| Scorecard (4 KPIs)      | 4.2     | `mv_daily_sentiment_dest`                                   | Yes                  |
| Time-series (daily)     | 4.3     | `mv_daily_sentiment_dest`                                   | Yes                  |
| Time-series (hourly)    | 4.3     | `mv_hourly_sentiment_dest`                                  | Yes                  |
| Breakdown by agent      | 4.4     | `mv_daily_sentiment_dest`                                   | Yes                  |
| Breakdown by channel    | 4.4     | `mv_daily_sentiment_dest`                                   | Yes                  |
| Breakdown by trajectory | 4.4     | `conversation_sentiment FINAL`                              | No (low cardinality) |
| Conversation list       | 4.5     | `conversation_sentiment FINAL`                              | No (pagination)      |
| Single conversation     | 4.5     | `conversation_sentiment FINAL` + `message_sentiment FINAL`  | No (point lookup)    |
| Period comparison       | 4.6     | `mv_daily_sentiment_dest`                                   | Yes                  |
| CSV export              | 4.7     | `conversation_sentiment FINAL` or `message_sentiment FINAL` | No (streaming)       |

---

## Phase 5: Index and Performance Design

**Goal**: Ensure every Phase 4 query runs with sub-second latency at production scale. Design indices, MVs, projections, caching, and data lifecycle.

---

### 5.1 ORDER BY Validation for Each Query

For each Phase 4 query, verify that the ClickHouse ORDER BY key covers the `WHERE` clause prefix:

| Query                          | Table                      | WHERE Prefix                                           | ORDER BY                                             | Prefix Match?                                          | Performance                                  |
| ------------------------------ | -------------------------- | ------------------------------------------------------ | ---------------------------------------------------- | ------------------------------------------------------ | -------------------------------------------- |
| Scorecard                      | `mv_daily_sentiment_dest`  | `tenant_id, project_id, date >= ...`                   | `(tenant_id, project_id, date, agent_name, channel)` | Full prefix                                            | Index scan                                   |
| Time-series daily              | `mv_daily_sentiment_dest`  | `tenant_id, project_id, date range`                    | `(tenant_id, project_id, date, ...)`                 | Full prefix                                            | Index scan                                   |
| Time-series hourly             | `mv_hourly_sentiment_dest` | `tenant_id, project_id, hour range`                    | `(tenant_id, project_id, hour, ...)`                 | Full prefix                                            | Index scan                                   |
| Breakdown by agent             | `mv_daily_sentiment_dest`  | `tenant_id, project_id, date range` + GROUP BY agent   | `(tenant_id, project_id, date, agent_name, ...)`     | Full prefix, agent in ORDER BY                         | Index scan + group                           |
| Breakdown by channel           | `mv_daily_sentiment_dest`  | `tenant_id, project_id, date range` + GROUP BY channel | `(tenant_id, project_id, date, agent_name, channel)` | Full prefix, channel in ORDER BY tail                  | Scan within date range (acceptable)          |
| Trajectory distribution        | `conversation_sentiment`   | `tenant_id, project_id, time range`                    | `(tenant_id, project_id, session_id)`                | tenant_id + project_id match, time via partition prune | Partition scan + skip index                  |
| Conversation list              | `conversation_sentiment`   | `tenant_id, project_id, time range, trajectory filter` | `(tenant_id, project_id, session_id)`                | tenant_id + project_id prefix                          | Partition scan + skip index `idx_trajectory` |
| Single conversation (summary)  | `conversation_sentiment`   | `tenant_id, session_id`                                | `(tenant_id, project_id, session_id)`                | Full prefix (tenant + session)                         | Point lookup                                 |
| Single conversation (messages) | `message_sentiment`        | `tenant_id, session_id`                                | `(tenant_id, session_id, message_id)`                | Full prefix                                            | Point lookup                                 |
| CSV export                     | Both tables                | `tenant_id, project_id, time range`                    | Same as above                                        | Partition pruning                                      | Streaming scan                               |

**Gaps identified and resolved:**

1. **Conversation list sorted by `avg_sentiment`**: The ORDER BY is `(tenant_id, project_id, session_id)`, not `avg_sentiment`. Sorting by sentiment requires a full scan within the partition range. **Mitigation**: The `idx_avg_sentiment TYPE minmax` skip index helps ClickHouse skip granules that are entirely outside the score filter range. For `LIMIT 50`, ClickHouse's top-K optimization keeps this fast (<500ms at 100K conversations).

2. **Conversation list filtered by `trajectory`**: Not in ORDER BY prefix. **Mitigation**: `idx_trajectory TYPE set(10)` skip index prunes granules that do not contain the target trajectory value.

---

### 5.2 Materialized Views (Complete List)

Three MVs defined in Phase 3.9. Here is the **complete, final DDL** with the `positive_count`, `negative_count`, and `neutral_count` columns added per Phase 4.2 requirements:

#### MV 1 (UPDATED): `mv_daily_sentiment`

Destination table:

```sql
CREATE TABLE IF NOT EXISTS abl_platform.mv_daily_sentiment_dest
(
    tenant_id             String,
    project_id            String,
    date                  Date,
    agent_name            LowCardinality(String),
    channel               LowCardinality(String),

    conversation_count    SimpleAggregateFunction(sum, UInt64),
    total_sentiment       SimpleAggregateFunction(sum, Float64),
    positive_count        SimpleAggregateFunction(sum, UInt64),
    neutral_count         SimpleAggregateFunction(sum, UInt64),
    negative_count        SimpleAggregateFunction(sum, UInt64),
    declining_count       SimpleAggregateFunction(sum, UInt64),
    improving_count       SimpleAggregateFunction(sum, UInt64),
    frustrated_count      SimpleAggregateFunction(sum, UInt64),
    total_frustration_turns  SimpleAggregateFunction(sum, UInt64),
    total_pivot_count     SimpleAggregateFunction(sum, UInt64),
    total_message_count   SimpleAggregateFunction(sum, UInt64),
    total_processing_ms   SimpleAggregateFunction(sum, UInt64),
    min_avg_sentiment     SimpleAggregateFunction(min, Float32),
    max_avg_sentiment     SimpleAggregateFunction(max, Float32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name, channel)
TTL date + INTERVAL 730 DAY DELETE
SETTINGS index_granularity = 8192;
```

Materialized view:

```sql
CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.mv_daily_sentiment
TO abl_platform.mv_daily_sentiment_dest
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    agent_name,
    channel,
    sumSimpleState(toUInt64(1))                                                           AS conversation_count,
    sumSimpleState(toFloat64(avg_sentiment))                                               AS total_sentiment,
    sumSimpleState(toUInt64(if(avg_sentiment > 0.2, 1, 0)))                                AS positive_count,
    sumSimpleState(toUInt64(if(avg_sentiment >= -0.2 AND avg_sentiment <= 0.2, 1, 0)))     AS neutral_count,
    sumSimpleState(toUInt64(if(avg_sentiment < -0.2, 1, 0)))                               AS negative_count,
    sumSimpleState(toUInt64(if(sentiment_trajectory = 'declining', 1, 0)))                  AS declining_count,
    sumSimpleState(toUInt64(if(sentiment_trajectory = 'improving', 1, 0)))                  AS improving_count,
    sumSimpleState(toUInt64(if(frustration_detected = 1, 1, 0)))                           AS frustrated_count,
    sumSimpleState(toUInt64(frustration_turn_count))                                        AS total_frustration_turns,
    sumSimpleState(toUInt64(pivot_count))                                                   AS total_pivot_count,
    sumSimpleState(toUInt64(message_count))                                                 AS total_message_count,
    sumSimpleState(toUInt64(processing_ms))                                                 AS total_processing_ms,
    minSimpleState(avg_sentiment)                                                           AS min_avg_sentiment,
    maxSimpleState(avg_sentiment)                                                           AS max_avg_sentiment
FROM abl_platform.conversation_sentiment
GROUP BY tenant_id, project_id, date, agent_name, channel;
```

#### MV 2: `mv_hourly_sentiment` (unchanged from Phase 3.9)

(See Phase 3.9 for complete DDL.)

#### MV 3: `mv_daily_frustration` (unchanged from Phase 3.9)

(See Phase 3.9 for complete DDL.)

---

### 5.3 Projection Tables for Alternative Query Patterns

One additional projection is needed for the **conversation list sorted by time** (the most common sort):

**Projection on `conversation_sentiment` (sorted by time within project):**

```sql
ALTER TABLE abl_platform.conversation_sentiment
    ADD PROJECTION proj_by_time
    (
        SELECT *
        ORDER BY (tenant_id, project_id, session_started_at, session_id)
    );

ALTER TABLE abl_platform.conversation_sentiment
    MATERIALIZE PROJECTION proj_by_time;
```

This projection enables efficient queries like:

```sql
-- Conversation list sorted by time (most recent first)
SELECT ...
FROM conversation_sentiment FINAL
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
  AND session_started_at >= {from:DateTime64(3)}
ORDER BY session_started_at DESC
LIMIT 50
```

Without this projection, the base ORDER BY `(tenant_id, project_id, session_id)` would require ClickHouse to scan and sort. With the projection, the data is pre-sorted by time within each project.

**No projection needed for `message_sentiment`**: The base ORDER BY `(tenant_id, session_id, message_id)` already optimizes the only common access pattern (all messages for a conversation).

---

### 5.4 Partition Pruning Verification

**Every query MUST filter by `tenant_id` + time range** to achieve partition pruning.

| Query                          | Partition Key                               | Filter Columns                                                 | Partitions Scanned                                                                                                                 |
| ------------------------------ | ------------------------------------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| MV queries                     | `(tenant_id, toYYYYMM(date))`               | `tenant_id = ? AND date >= ? AND date < ?`                     | Exactly the months in range for that tenant                                                                                        |
| Conversation list              | `(tenant_id, toYYYYMM(session_started_at))` | `tenant_id = ? AND project_id = ? AND session_started_at >= ?` | Months in range for that tenant                                                                                                    |
| Single conversation (summary)  | `(tenant_id, toYYYYMM(session_started_at))` | `tenant_id = ? AND session_id = ?`                             | Worst case: all tenant partitions (session_started_at unknown). Mitigated by: API passes time hint from the conversation list row. |
| Single conversation (messages) | `(tenant_id, toYYYYMM(message_at))`         | `tenant_id = ? AND session_id = ?`                             | Worst case: all tenant partitions. Mitigated by: bloom filter on session_id.                                                       |

**Mitigation for single-conversation lookups**: When the frontend navigates from the conversation list to the detail view, it passes `session_started_at` as a query parameter, allowing the API to add a time range filter:

```sql
-- With time hint from conversation list (optimal)
WHERE tenant_id = {tenantId:String}
  AND session_id = {sessionId:String}
  AND session_started_at >= toDate({startedAt:String}) - 1
  AND session_started_at <= toDate({startedAt:String}) + 1
```

---

### 5.5 Skip Indices (Complete List)

#### On `message_sentiment`:

```sql
-- Already defined in CREATE TABLE above
INDEX idx_frustration frustration_detected TYPE set(2) GRANULARITY 4
INDEX idx_label       sentiment_label      TYPE set(5) GRANULARITY 4
INDEX idx_session     session_id           TYPE bloom_filter GRANULARITY 4
INDEX idx_project     project_id           TYPE bloom_filter GRANULARITY 4
```

| Index             | Type           | Purpose                                                                       |
| ----------------- | -------------- | ----------------------------------------------------------------------------- |
| `idx_frustration` | `set(2)`       | Fast filter for `WHERE frustration_detected = 1` (only 2 values: 0, 1)        |
| `idx_label`       | `set(5)`       | Fast filter for `WHERE sentiment_label = 'negative'` (3-5 values)             |
| `idx_session`     | `bloom_filter` | Accelerate point lookups by `session_id` when not in ORDER BY prefix position |
| `idx_project`     | `bloom_filter` | Accelerate project-scoped queries (project_id is not in ORDER BY)             |

#### On `conversation_sentiment`:

```sql
-- Already defined in CREATE TABLE above
INDEX idx_trajectory    sentiment_trajectory TYPE set(10)       GRANULARITY 4
INDEX idx_frustration   frustration_detected TYPE set(2)        GRANULARITY 4
INDEX idx_project       project_id           TYPE bloom_filter  GRANULARITY 4
INDEX idx_avg_sentiment avg_sentiment        TYPE minmax        GRANULARITY 4
INDEX idx_channel       channel              TYPE set(20)       GRANULARITY 4
```

| Index               | Type           | Purpose                                                                                                                                    |
| ------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `idx_trajectory`    | `set(10)`      | Fast filter for `WHERE sentiment_trajectory = 'declining'` (4 values)                                                                      |
| `idx_frustration`   | `set(2)`       | Fast filter for `WHERE frustration_detected = 1`                                                                                           |
| `idx_project`       | `bloom_filter` | Accelerate project-scoped queries. Critical because many queries filter by `project_id` which is in ORDER BY position 2 (after tenant_id). |
| `idx_avg_sentiment` | `minmax`       | Range filter for `WHERE avg_sentiment < -0.2` (conversation list score filter)                                                             |
| `idx_channel`       | `set(20)`      | Fast filter for `WHERE channel = 'web_chat'` (typically <10 distinct values)                                                               |

---

### 5.6 Storage Size Estimation

#### Assumptions

| Parameter                        | Value                                                    | Source                                                                                           |
| -------------------------------- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| Conversations per tenant per day | 500 (small), 5,000 (medium), 50,000 (large)              | Industry benchmarks                                                                              |
| Messages scored per conversation | 5 (user messages only, default `analyzeRoles: ['user']`) | Platform data                                                                                    |
| Message sentiment row size       | ~180 bytes (uncompressed)                                | Column sum: 32+32+32+32+8+8+32+32+32+4+32+1+32+32+4+4 = ~349 bytes raw, ~180 with LowCardinality |
| Conversation sentiment row size  | ~250 bytes (uncompressed)                                | Column sum: similar calculation, ~250 bytes                                                      |
| ClickHouse compression ratio     | 7x (typical for ZSTD + LowCardinality + Gorilla)         | Measured on similar tables                                                                       |
| Retention                        | 730 days                                                 | TTL policy                                                                                       |

#### Per-Tenant Storage

| Tenant Size     | Conversations/Day | message_sentiment             | conversation_sentiment     | MVs         | Total/Year | Total/2yr |
| --------------- | ----------------- | ----------------------------- | -------------------------- | ----------- | ---------- | --------- |
| Small (500/day) | 500               | 500 _ 5 _ 180 / 7 = 64 KB/day | 500 \* 250 / 7 = 18 KB/day | ~5 KB/day   | ~29 MB     | ~58 MB    |
| Medium (5K/day) | 5,000             | 640 KB/day                    | 180 KB/day                 | ~50 KB/day  | ~290 MB    | ~580 MB   |
| Large (50K/day) | 50,000            | 6.4 MB/day                    | 1.8 MB/day                 | ~500 KB/day | ~2.9 GB    | ~5.8 GB   |

#### Platform-Wide Storage (100 tenants, mixed sizes)

```
Assumption: 70 small + 25 medium + 5 large tenants

message_sentiment:  70*29 + 25*290 + 5*2900 = 2030 + 7250 + 14500 = ~23.8 GB/year
conversation_sentiment: proportionally ~7 GB/year
MVs: ~1.5 GB/year

Total: ~32 GB/year (compressed, all tenants, all tables + MVs)
Total at 2-year retention: ~64 GB
```

This is well within typical ClickHouse cluster capacity. No sharding or extraordinary measures needed.

---

### 5.7 Data Lifecycle

```
                    Hot (SSD)           Warm (HDD)          Cold (Object Store)     Deleted
                    ─────────           ──────────          ───────────────────     ───────
message_sentiment:  0-90 days      →    90-365 days    →    365-730 days      →    >730 days
conversation_sent:  0-90 days      →    90-365 days    →    365-730 days      →    >730 days
mv_daily_dest:      0-730 days (no tiering, small table)                      →    >730 days
mv_hourly_dest:     0-90 days (no tiering)                                    →    >90 days
mv_frustration:     0-730 days (no tiering)                                   →    >730 days
```

**Lifecycle rationale:**

- **Hot tier (90 days)**: Covers the typical dashboard period selections (7d, 30d) and the max `lookbackDays` config (90). All active queries hit hot storage.
- **Warm tier (90-365 days)**: Quarterly and annual trend analysis. Queries are less frequent, tolerate slightly higher latency.
- **Cold tier (365-730 days)**: Year-over-year comparisons. Rare queries, high latency acceptable.
- **Hourly MV (90 days)**: Only needed for recent data. Older data uses daily MV. Short retention keeps the table small.

---

### 5.8 MongoDB Index for `pipeline_configs`

Already defined in Phase 2 config schema. Verified here for completeness:

```javascript
// Primary lookup: find config for a tenant + pipeline type + project
db.pipeline_configs.createIndex({ tenantId: 1, pipelineType: 1, projectId: 1 }, { unique: true });

// Find all enabled pipelines for a tenant (used by PipelineTrigger)
db.pipeline_configs.createIndex({ tenantId: 1, enabled: 1 });

// Find all pipelines of a type across tenants (used by admin tooling)
db.pipeline_configs.createIndex({ pipelineType: 1, enabled: 1 });
```

The third index is new -- it supports admin operations like "how many tenants have sentiment analysis enabled?" without collection scans.

---

### 5.9 Query Performance Testing Plan

Testing should be performed against a ClickHouse instance seeded with realistic data volumes.

#### Test Data Seeding

```
Seed parameters:
  - 10 tenants, each with 2-5 projects
  - Per tenant: 30 days of data
  - Small tenants (5): 500 conversations/day * 5 messages = 75K message rows
  - Medium tenants (4): 5K conversations/day * 5 messages = 750K message rows
  - Large tenant (1): 50K conversations/day * 5 messages = 7.5M message rows
  - Total: ~12M message_sentiment rows, ~2.4M conversation_sentiment rows
```

#### Test Queries and Targets

| #   | Query                                                     | Target Latency | Verify                           |
| --- | --------------------------------------------------------- | -------------- | -------------------------------- |
| 1   | Scorecard (MV, 7 days)                                    | <100ms         | MV query plan shows no full scan |
| 2   | Time-series daily (MV, 30 days)                           | <200ms         | Returns ~30 rows                 |
| 3   | Time-series hourly (MV, 24 hours)                         | <150ms         | Returns ~24 rows                 |
| 4   | Breakdown by agent (MV, 7 days)                           | <200ms         | GROUP BY agent_name              |
| 5   | Breakdown by channel (MV, 7 days)                         | <200ms         | GROUP BY channel                 |
| 6   | Trajectory distribution (base, 7 days, FINAL)             | <300ms         | 4 result rows                    |
| 7   | Conversation list (base, FINAL, sorted by time, LIMIT 50) | <500ms         | Verify projection usage          |
| 8   | Conversation list with trajectory filter                  | <500ms         | Verify skip index usage          |
| 9   | Single conversation summary                               | <50ms          | Point lookup by tenant+session   |
| 10  | Single conversation messages (10 messages)                | <50ms          | Point lookup by tenant+session   |
| 11  | CSV export (30 days, large tenant, streaming)             | <10s           | Verify no OOM                    |
| 12  | Scorecard with prior period comparison                    | <200ms         | Two-range query                  |

#### Diagnostic Queries

```sql
-- Check partition pruning (should show parts_selected < total_parts)
EXPLAIN indexes = 1
SELECT count()
FROM abl_platform.conversation_sentiment FINAL
WHERE tenant_id = 'tenant_medium_1'
  AND project_id = 'proj_1'
  AND session_started_at >= '2026-02-01'
  AND session_started_at < '2026-03-01';

-- Check skip index effectiveness
EXPLAIN indexes = 1
SELECT count()
FROM abl_platform.conversation_sentiment FINAL
WHERE tenant_id = 'tenant_large'
  AND project_id = 'proj_1'
  AND sentiment_trajectory = 'declining'
  AND session_started_at >= '2026-02-01';
```

---

### 5.10 Redis Cache Strategy

#### Cache Key Patterns

```
Scorecard:
  analytics:{tenantId}:{projectId}:sentiment:summary:{period}:{agent}:{channel}
  TTL: 300s (5 minutes)

Time-series:
  analytics:{tenantId}:{projectId}:sentiment:timeseries:{period}:{granularity}:{agent}:{channel}
  TTL: 300s (5 minutes)

Breakdown:
  analytics:{tenantId}:{projectId}:sentiment:breakdown:{period}:{dimension}:{agent}:{channel}
  TTL: 300s (5 minutes)

Single conversation:
  analytics:{tenantId}:{projectId}:sentiment:conversation:{sessionId}
  TTL: 3600s (1 hour) -- immutable once processed

Conversation list:
  NOT CACHED (pagination + variable filters make cache keys too numerous)

Export:
  NOT CACHED (streaming, one-time use)
```

#### Cache Size Estimation

```
Per project: ~20 cache keys (4 periods * {summary, timeseries, 3 breakdowns})
Per conversation: 1 key (detail view)

Average value size: ~2-10 KB (JSON response body)
Per project: 20 * 5 KB = 100 KB
Per conversation viewed: ~5 KB

100 projects active * 100 KB + 500 conversations viewed * 5 KB = ~12.5 MB
```

Negligible Redis memory impact.

#### Cache Invalidation

Invalidation occurs in three scenarios:

| Trigger                              | Action                                                        | Implementation                                                                                         |
| ------------------------------------ | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Pipeline processes new conversations | Delete summary + timeseries + breakdown keys for that project | `store-results` activity calls `invalidateSentimentCache(tenantId, projectId)` after ClickHouse insert |
| Config change (save in Studio)       | Delete ALL sentiment cache keys for that project              | Config API handler calls `invalidateSentimentCache(tenantId, projectId)`                               |
| TTL expiry                           | Automatic                                                     | Redis TTL                                                                                              |

```
Invalidation pattern:
  SCAN for keys matching analytics:{tenantId}:{projectId}:sentiment:*
  DEL matched keys

Note: Use SCAN (not KEYS) to avoid blocking Redis.
Batch SCAN with COUNT 100 for efficiency.
```

#### Cache Warming

No proactive cache warming. Cache is populated on first request (cache-aside pattern). The 5-minute TTL means the first dashboard load after cache expiry incurs a ClickHouse query (~100-300ms), which is still under the 500ms target.

---

## Cross-Cutting Concerns

### ReplacingMergeTree and FINAL

All base table queries use `FINAL` to get correct results in the presence of un-merged duplicates (from re-processing). Performance implications:

- `FINAL` adds ~20-50% overhead on scan queries (ClickHouse must check for duplicates).
- For point lookups (single conversation), overhead is negligible.
- For aggregation queries, the MVs use `AggregatingMergeTree` which handles merging natively -- no `FINAL` needed on MV queries.
- For the conversation list, `FINAL` is acceptable because the query is already LIMIT-bounded.

**Alternative**: For queries where `FINAL` is too slow, use `argMax`:

```sql
-- Instead of FINAL, use argMax for the latest processed_at
SELECT
    session_id,
    argMax(avg_sentiment, processed_at) AS avg_sentiment,
    argMax(sentiment_trajectory, processed_at) AS trajectory
FROM conversation_sentiment
WHERE tenant_id = {tenantId:String}
  AND project_id = {projectId:String}
GROUP BY session_id
```

This is reserved as a fallback if `FINAL` proves too slow in performance testing (Step 5.9).

### Error Handling in API Endpoints

All sentiment API endpoints follow the platform pattern:

```json
{
  "success": false,
  "error": {
    "code": "ANALYTICS_UNAVAILABLE",
    "message": "Sentiment analytics service is unavailable"
  }
}
```

ClickHouse unavailability returns HTTP 503. Invalid query parameters return HTTP 400.

### Registration in `initClickHouseSchema()`

The two new tables, three MV destination tables, and three MVs will be added to the `TABLES` and `MATERIALIZED_VIEWS` arrays in `packages/database/src/clickhouse-schemas/init.ts`. The projection is applied via a separate migration script (projections cannot be defined in CREATE TABLE).

**Table registration order:**

1. `message_sentiment` (base table)
2. `conversation_sentiment` (base table)
3. `mv_daily_sentiment_dest` (MV destination)
4. `mv_hourly_sentiment_dest` (MV destination)
5. `mv_daily_frustration_dest` (MV destination)
6. `mv_daily_sentiment` (MV, references `conversation_sentiment`)
7. `mv_hourly_sentiment` (MV, references `conversation_sentiment`)
8. `mv_daily_frustration` (MV, references `message_sentiment`)

**Projection migration (post-deploy):**

```sql
ALTER TABLE abl_platform.conversation_sentiment
    ADD PROJECTION proj_by_time
    (SELECT * ORDER BY (tenant_id, project_id, session_started_at, session_id));

ALTER TABLE abl_platform.conversation_sentiment
    MATERIALIZE PROJECTION proj_by_time;
```

---

## Appendix A: Complete SQL Reference

All SQL statements consolidated for implementation convenience.

### Base Tables

(See Section 3.7 for `message_sentiment` and `conversation_sentiment` DDL.)

### MV Destination Tables + Materialized Views

(See Sections 3.9 and 5.2 for complete DDL.)

### Skip Indices

(Defined inline in the CREATE TABLE statements. See Section 5.5 for the reference table.)

### Projection

(See Section 5.3.)

---

## Appendix B: API Response Type Definitions

```typescript
// GET /summary response
interface SentimentSummaryResponse {
  success: true;
  data: {
    scorecard: {
      avgSentiment: number; // -1.0 to 1.0
      avgSentimentDelta: number; // change vs prior period
      positiveRate: number; // 0.0 to 1.0
      positiveRateDelta: number;
      decliningRate: number;
      decliningRateDelta: number;
      frustrationRate: number;
      frustrationRateDelta: number;
      totalConversations: number;
      period: { from: string; to: string };
      comparisonPeriod: { from: string; to: string };
    };
    timeSeries: Array<{
      date: string; // ISO date (daily) or ISO datetime (hourly)
      avgSentiment: number;
      frustrationRate: number;
      decliningRate: number;
      improvingRate: number;
      conversations: number;
    }>;
  };
}

// GET /breakdown response
interface SentimentBreakdownResponse {
  success: true;
  data: {
    dimension: 'agent_name' | 'channel' | 'sentiment_trajectory';
    period: { from: string; to: string };
    buckets: Array<{
      key: string;
      avgSentiment: number;
      conversations: number;
      decliningRate: number;
      frustrationRate: number;
    }>;
  };
}

// GET /conversations response
interface SentimentConversationsResponse {
  success: true;
  data: {
    conversations: Array<{
      sessionId: string;
      sessionStartedAt: string;
      agentName: string;
      channel: string;
      avgSentiment: number;
      trajectory: string;
      frustrationTurnCount: number;
      frustrationDetected: boolean;
      pivotCount: number;
      messageCount: number;
      startSentiment: number;
      endSentiment: number;
    }>;
    total: number;
    page: number;
    pageSize: number;
    hasMore: boolean;
  };
}

// GET /conversation/:sessionId response
interface SentimentConversationDetailResponse {
  success: true;
  data: {
    summary: {
      sessionId: string;
      avgSentiment: number;
      trajectory: string;
      startSentiment: number;
      endSentiment: number;
      pivotCount: number;
      worstPivotAt: string | null;
      worstPivotDelta: number | null;
      frustrationTurnCount: number;
      messageCount: number;
      modelId: string;
      configVersion: number;
    };
    messages: Array<{
      messageId: string;
      messageAt: string;
      role: string;
      sentimentScore: number;
      sentimentLabel: string;
      frustrationDetected: boolean;
      frustrationSignals: string[];
      confidence: number;
    }>;
  };
}
```
