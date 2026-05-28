/**
 * Eval ClickHouse Table & MV DDL
 *
 * Moved from packages/pipeline-engine/src/pipeline/schemas/init-eval-tables.ts
 */
import {
  CH_EVAL_DATA_TTL_DAYS,
  CH_PRODUCTION_SCORES_TTL_DAYS,
} from '../../constants/eval-limits.js';
import { buildEvalRetentionTtlColumnsMigrationQueries } from '../migrations/eval-retention-ttl-columns.js';
import { buildCostBreakdownMigrationQueries } from '../migrations/add-cost-breakdown-to-eval-conversations.js';

const DATABASE = 'abl_platform';

// =============================================================================
// TABLE DDL
// =============================================================================

export const EVAL_TABLE_DDL: { name: string; ddl: string }[] = [
  {
    name: 'eval_conversations',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.eval_conversations (
    tenant_id         String               CODEC(ZSTD(1)),
    project_id        String               CODEC(ZSTD(1)),
    run_id            String               CODEC(ZSTD(1)),
    persona_id        String               CODEC(ZSTD(1)),
    scenario_id       String               CODEC(ZSTD(1)),
    variant_index     UInt8                CODEC(T64, ZSTD(1)),

    -- Conversation data (gzipped at app layer for payloads > 1KB)
    conversation      String               CODEC(ZSTD(3)),
    trace_events      String               CODEC(ZSTD(3)),
    tool_calls        String               DEFAULT '[]' CODEC(ZSTD(3)),

    -- Metrics
    turn_count        UInt16               CODEC(T64, ZSTD(1)),
    duration_ms       UInt32               CODEC(T64, ZSTD(1)),
    token_usage       UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    estimated_cost    Float32              DEFAULT 0,
    customer_visible_cost Float32          DEFAULT 0,
    cost_by_model     String               DEFAULT '{}' CODEC(ZSTD(1)),

    -- Trajectory (R5)
    milestones_hit    Array(String)        CODEC(ZSTD(1)),
    actual_agent_path Array(String)        CODEC(ZSTD(1)),
    tool_call_count   UInt16               DEFAULT 0 CODEC(T64, ZSTD(1)),

    -- Status
    known_source      LowCardinality(String) DEFAULT 'eval' CODEC(ZSTD(1)),
    ttl_override_days UInt16              DEFAULT ${CH_EVAL_DATA_TTL_DAYS} CODEC(T64, ZSTD(1)),
    has_error         UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    error_message     String               DEFAULT '' CODEC(ZSTD(1)),

    -- Versioning snapshot (R7)
    persona_version   UInt16               DEFAULT 1,
    scenario_version  UInt16               DEFAULT 1,

    created_at        DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_run       run_id             TYPE bloom_filter GRANULARITY 4,
    INDEX idx_persona   persona_id         TYPE bloom_filter GRANULARITY 4,
    INDEX idx_scenario  scenario_id        TYPE bloom_filter GRANULARITY 4,
    INDEX idx_error     has_error          TYPE set(2) GRANULARITY 4,
    INDEX idx_turns     turn_count         TYPE minmax GRANULARITY 4,
    INDEX idx_duration  duration_ms        TYPE minmax GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.eval_conversations', '{replica}')
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, project_id, run_id, persona_id, scenario_id, variant_index)
TTL toDateTime(created_at) + toIntervalDay(ttl_override_days) DELETE
SETTINGS index_granularity = 8192
`,
  },
  {
    name: 'eval_scores',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.eval_scores (
    tenant_id           String               CODEC(ZSTD(1)),
    project_id          String               CODEC(ZSTD(1)),
    run_id              String               CODEC(ZSTD(1)),
    persona_id          String               CODEC(ZSTD(1)),
    scenario_id         String               CODEC(ZSTD(1)),
    variant_index       UInt8                CODEC(T64, ZSTD(1)),
    evaluator_id        String               CODEC(ZSTD(1)),

    -- Score
    score               Float32              CODEC(ZSTD(1)),
    passed              UInt8                DEFAULT 0,
    reasoning           String               CODEC(ZSTD(3)),
    evidence            String               DEFAULT '' CODEC(ZSTD(3)),
    confidence          Float32              DEFAULT 1.0,

    -- Bias mitigation (R1)
    score_original      Float32              DEFAULT 0,
    score_swapped       Float32              DEFAULT 0,
    was_position_swapped UInt8               DEFAULT 0,

    -- Trajectory scores (R5)
    milestone_completion_rate Float32        DEFAULT 0,
    handoff_correctness_rate  Float32        DEFAULT 0,
    path_efficiency_score     Float32        DEFAULT 0,

    -- Human review (R9)
    known_source       LowCardinality(String) DEFAULT 'eval' CODEC(ZSTD(1)),
    ttl_override_days  UInt16               DEFAULT ${CH_EVAL_DATA_TTL_DAYS} CODEC(T64, ZSTD(1)),
    needs_human_review  UInt8                DEFAULT 0,
    human_score         Nullable(Float32),
    human_reviewed_at   Nullable(DateTime64(3)),

    -- Cost
    judge_tokens_used   UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    judge_cost          Float32              DEFAULT 0,
    judge_latency_ms    UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),

    -- Versioning (R7)
    evaluator_version   UInt16               DEFAULT 1,

    created_at          DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_run       run_id               TYPE bloom_filter GRANULARITY 4,
    INDEX idx_evaluator evaluator_id         TYPE bloom_filter GRANULARITY 4,
    INDEX idx_review    needs_human_review   TYPE set(2) GRANULARITY 4,
    INDEX idx_score     score                TYPE minmax GRANULARITY 4,
    INDEX idx_passed    passed               TYPE set(2) GRANULARITY 4,
    INDEX idx_persona   persona_id           TYPE bloom_filter GRANULARITY 4,
    INDEX idx_scenario  scenario_id          TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.eval_scores', '{replica}')
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, project_id, run_id, evaluator_id, persona_id, scenario_id, variant_index)
TTL toDateTime(created_at) + toIntervalDay(ttl_override_days) DELETE
SETTINGS index_granularity = 8192
`,
  },
  {
    name: 'eval_production_scores',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.eval_production_scores (
    tenant_id         String               CODEC(ZSTD(1)),
    project_id        String               CODEC(ZSTD(1)),
    session_id        String               CODEC(ZSTD(1)),
    agent_name        LowCardinality(String) CODEC(ZSTD(1)),
    evaluator_name    LowCardinality(String) CODEC(ZSTD(1)),
    evaluator_type    LowCardinality(String) CODEC(ZSTD(1)),

    score             Float32              CODEC(ZSTD(1)),
    passed            UInt8                DEFAULT 0,
    reasoning         String               CODEC(ZSTD(3)),
    confidence        Float32              DEFAULT 1.0,

    tokens_used       UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    cost              Float32              DEFAULT 0,
    latency_ms        UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    ttl_override_days UInt16               DEFAULT ${CH_PRODUCTION_SCORES_TTL_DAYS} CODEC(T64, ZSTD(1)),

    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_session session_id           TYPE bloom_filter GRANULARITY 4,
    INDEX idx_agent   agent_name           TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.eval_production_scores', '{replica}')
PARTITION BY toDate(timestamp)
ORDER BY (tenant_id, project_id, evaluator_name, timestamp)
TTL
    toDateTime(timestamp) + toIntervalDay(ttl_override_days) DELETE
    -- TODO(production): Add warm tier when storage policies configured:
    -- toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'warm',
    -- toDateTime(timestamp) + INTERVAL 365 DAY DELETE
SETTINGS index_granularity = 8192
`,
  },
];

const DEFAULT_EVAL_RETENTION_TTL_QUERIES = buildEvalRetentionTtlColumnsMigrationQueries({
  database: DATABASE,
});

const EVAL_RETENTION_TTL_ALTER_NAMES = [
  'eval_conversations_retention_columns',
  'eval_scores_retention_columns',
  'eval_production_scores_retention_columns',
] as const;

const DEFAULT_COST_BREAKDOWN_QUERIES = buildCostBreakdownMigrationQueries({
  database: DATABASE,
});

const COST_BREAKDOWN_ALTER_NAMES = [
  'eval_conversations_customer_visible_cost',
  'eval_conversations_cost_by_model',
] as const;

export const EVAL_TABLE_ALTER_DDL: { name: string; ddl: string }[] = [
  ...EVAL_RETENTION_TTL_ALTER_NAMES.map((name, index) => {
    const ddl = DEFAULT_EVAL_RETENTION_TTL_QUERIES[index];
    if (!ddl) {
      throw new Error(`Missing eval retention TTL migration query for ${name}`);
    }
    return { name, ddl };
  }),
  // Backfill cost-breakdown columns on eval_conversations for environments
  // where the table was created before ABLP-945 added customer_visible_cost
  // and cost_by_model to the CREATE TABLE DDL. CREATE TABLE IF NOT EXISTS is
  // a no-op on those instances, so the canonical migration in
  // @agent-platform/database/clickhouse-schemas/migrations/add-cost-breakdown-to-eval-conversations
  // is composed in here as ADD COLUMN IF NOT EXISTS — idempotent on
  // already-correct schemas. Manifest entry:
  // change-management/manifest.ts → clickhouse.add-cost-breakdown-to-eval-conversations.
  ...COST_BREAKDOWN_ALTER_NAMES.map((name, index) => {
    const ddl = DEFAULT_COST_BREAKDOWN_QUERIES[index];
    if (!ddl) {
      throw new Error(`Missing cost-breakdown migration query for ${name}`);
    }
    return { name, ddl };
  }),
];

// =============================================================================
// MATERIALIZED VIEW DDL
// =============================================================================

export const EVAL_MV_DDL: { name: string; ddl: string }[] = [
  {
    name: 'mv_eval_heatmap',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_eval_heatmap_dest
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.mv_eval_heatmap_dest', '{replica}')
PARTITION BY toYYYYMM(month_date)
ORDER BY (tenant_id, project_id, run_id, evaluator_id, persona_id, scenario_id)
AS SELECT
    tenant_id,
    project_id,
    run_id,
    evaluator_id,
    persona_id,
    scenario_id,
    toDate(created_at)           AS month_date,
    avgState(score)              AS avg_score,
    countState()                 AS variant_count,
    varSampState(score)          AS score_variance,
    minState(score)              AS min_score,
    maxState(score)              AS max_score,
    sumState(judge_cost)         AS total_judge_cost,
    sumState(judge_tokens_used)  AS total_judge_tokens,
    minState(created_at)         AS min_created_at
FROM ${DATABASE}.eval_scores
GROUP BY tenant_id, project_id, run_id, evaluator_id, persona_id, scenario_id, month_date
`,
  },
  {
    name: 'mv_eval_run_evaluator_summary',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_eval_run_evaluator_summary_dest
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.mv_eval_run_evaluator_summary_dest', '{replica}')
PARTITION BY toYYYYMM(month_date)
ORDER BY (tenant_id, project_id, run_id, evaluator_id)
AS SELECT
    tenant_id,
    project_id,
    run_id,
    evaluator_id,
    toDate(created_at)            AS month_date,
    avgState(score)               AS avg_score,
    countState()                  AS total_scores,
    countIfState(passed = 1)      AS passed_count,
    varSampState(score)           AS score_variance,
    quantileState(0.05)(score)    AS p5_score,
    quantileState(0.50)(score)    AS p50_score,
    quantileState(0.95)(score)    AS p95_score,
    sumState(judge_cost)          AS total_cost,
    minState(created_at)          AS min_created_at
FROM ${DATABASE}.eval_scores
GROUP BY tenant_id, project_id, run_id, evaluator_id, month_date
`,
  },
  {
    name: 'mv_eval_score_trend',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_eval_score_trend_dest
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.mv_eval_score_trend_dest', '{replica}')
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, project_id, evaluator_id, day, run_id)
AS SELECT
    tenant_id,
    project_id,
    evaluator_id,
    toDate(created_at)       AS day,
    run_id,
    avgState(score)          AS avg_score,
    countState()             AS score_count,
    varSampState(score)      AS score_variance,
    minState(created_at)     AS min_created_at
FROM ${DATABASE}.eval_scores
GROUP BY tenant_id, project_id, evaluator_id, day, run_id
`,
  },
  {
    name: 'mv_eval_production_hourly',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_eval_production_hourly_dest
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.mv_eval_production_hourly_dest', '{replica}')
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, project_id, evaluator_name, agent_name, hour)
TTL hour + INTERVAL ${CH_PRODUCTION_SCORES_TTL_DAYS} DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    evaluator_name,
    agent_name,
    toStartOfHour(timestamp)     AS hour,
    avgState(score)              AS avg_score,
    countState()                 AS eval_count,
    countIfState(passed = 0)     AS failed_count,
    quantileState(0.05)(score)   AS p5_score,
    sumState(cost)               AS total_cost,
    avgState(latency_ms)         AS avg_latency,
    minState(timestamp)          AS min_timestamp
FROM ${DATABASE}.eval_production_scores
GROUP BY tenant_id, project_id, evaluator_name, agent_name, hour
`,
  },
];

// =============================================================================
// TABLE & MV NAME ARRAYS (for logging)
// =============================================================================

export const EVAL_TABLES = EVAL_TABLE_DDL.map((t) => t.name);
export const EVAL_MVS = EVAL_MV_DDL.map((v) => v.name);
