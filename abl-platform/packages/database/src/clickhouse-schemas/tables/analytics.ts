/**
 * Analytics ClickHouse Table & MV DDL
 *
 * Moved from packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
 * All DDL is centralized here for the unified init path.
 */

const DATABASE = 'abl_platform';

// =============================================================================
// TABLE DDL
// =============================================================================

const ANALYTICS_TABLE_DDL: { name: string; ddl: string }[] = [
  {
    name: 'message_sentiment',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.message_sentiment (
    tenant_id        String,
    session_id       String,
    message_id       String,

    message_at       DateTime64(3),
    processed_at     DateTime64(3),

    role             LowCardinality(String),
    agent_name       LowCardinality(String),
    channel          LowCardinality(String),

    sentiment_score  Float32,
    sentiment_label  LowCardinality(String),
    frustration_detected  UInt8,
    frustration_signals   Array(String),

    model_id         LowCardinality(String),
    config_version   UInt32,
    confidence       Float32,
    processing_ms    UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.message_sentiment', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(message_at))
ORDER BY (tenant_id, session_id, message_id)
TTL toDateTime(message_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'conversation_sentiment',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.conversation_sentiment (
    tenant_id        String,
    project_id       String,
    session_id       String,

    session_started_at  DateTime64(3),
    processed_at        DateTime64(3),

    agent_name       LowCardinality(String),
    channel          LowCardinality(String),

    avg_sentiment           Float32,
    start_sentiment         Float32,
    end_sentiment           Float32,
    min_sentiment           Float32,
    max_sentiment           Float32,
    sentiment_trajectory    LowCardinality(String),
    sentiment_shift_count   UInt16,

    frustration_turn_count  UInt16,
    frustration_detected    UInt8,

    pivot_count             UInt16,
    worst_pivot_at          Nullable(DateTime64(3)),
    worst_pivot_delta       Nullable(Float32),

    model_id         LowCardinality(String),
    config_version   UInt32,
    message_count    UInt16,
    processing_ms    UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.conversation_sentiment', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'intent_classifications',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.intent_classifications (
    tenant_id        String,
    project_id       String,
    session_id       String,

    session_started_at  DateTime64(3),
    processed_at        DateTime64(3),

    agent_name       LowCardinality(String),
    channel          LowCardinality(String),

    intent           LowCardinality(String),
    intent_display   String,
    sub_intent       LowCardinality(String),
    confidence       Float32,
    secondary_intents Array(String),
    is_auto_discovered UInt8,

    model_id         LowCardinality(String),
    config_version   UInt32,
    taxonomy_version LowCardinality(String),
    processing_ms    UInt32,
    input_tokens     UInt32,
    output_tokens    UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.intent_classifications', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'quality_evaluations',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.quality_evaluations (
    tenant_id        String,
    project_id       String,
    session_id       String,

    session_started_at  DateTime64(3),
    processed_at        DateTime64(3),

    agent_name       LowCardinality(String),
    agent_version    LowCardinality(String),
    channel          LowCardinality(String),

    overall_score    Float32,
    helpfulness      Float32,
    accuracy         Float32,
    professionalism  Float32,
    instruction_following Float32,

    custom_dimensions String,

    flagged          UInt8,
    flag_reasons     Array(String),
    reasoning        String,

    model_id         LowCardinality(String),
    config_version   UInt32,
    pipeline_version LowCardinality(String),
    confidence       Float32,
    processing_ms    UInt32,
    input_tokens     UInt32,
    output_tokens    UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.quality_evaluations', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'custom_events',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.custom_events (
    tenant_id        String,
    project_id       String,
    session_id       String,
    event_name       String,
    properties       String,
    timestamp        DateTime64(3),
    inserted_at      DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.custom_events', '{replica}', inserted_at)
PARTITION BY (tenant_id, toYYYYMM(timestamp))
ORDER BY (tenant_id, project_id, event_name, timestamp, session_id)
TTL toDateTime(timestamp) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'conversation_tags',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.conversation_tags (
    tenant_id        String,
    project_id       String,
    session_id       String,
    tag_name         String,
    applied_at       DateTime64(3) DEFAULT now64(3),
    applied_by       String,
    rule_id          String
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.conversation_tags', '{replica}', applied_at)
PARTITION BY (tenant_id, toYYYYMM(applied_at))
ORDER BY (tenant_id, project_id, session_id, tag_name)
TTL toDateTime(applied_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'external_events',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.external_events (
    tenant_id        String,
    project_id       String,
    event_type       LowCardinality(String),
    event_id         String,
    title            String,
    description      String,
    properties       String,
    timestamp        DateTime64(3),
    duration_minutes Nullable(UInt32),
    severity         Nullable(String),
    inserted_at      DateTime64(3) DEFAULT now64(3)
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.external_events', '{replica}', inserted_at)
PARTITION BY (tenant_id, toYYYYMM(timestamp))
ORDER BY (tenant_id, project_id, event_type, timestamp)
TTL toDateTime(timestamp) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'hallucination_evaluations',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.hallucination_evaluations (
    tenant_id              String,
    project_id             String,
    session_id             String,
    session_started_at     DateTime64(3),
    agent_name             LowCardinality(String),
    channel                LowCardinality(String),
    processed_at           DateTime64(3) DEFAULT now64(3),
    evaluation_type        LowCardinality(String),
    overall_score          Float64,
    faithfulness_score     Float64,
    claims                 Array(String),
    unsupported_claims     Array(String),
    consistency_index      Float64,
    contradiction_detected UInt8,
    flagged                UInt8 DEFAULT 0,
    flag_reasons           Array(String) DEFAULT [],
    confidence             Float64,
    model_id               LowCardinality(String),
    config_version         UInt32,
    input_tokens           UInt32,
    output_tokens          UInt32,
    processing_ms          UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.hallucination_evaluations', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'knowledge_gap_evaluations',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.knowledge_gap_evaluations (
    tenant_id              String,
    project_id             String,
    session_id             String,
    session_started_at     DateTime64(3),
    agent_name             LowCardinality(String),
    channel                LowCardinality(String),
    processed_at           DateTime64(3) DEFAULT now64(3),
    evaluation_type        LowCardinality(String),
    overall_score          Float64,
    retrieval_precision    Float64,
    citation_rate          Float64,
    gap_detected           UInt8,
    gap_topics             Array(String),
    unused_articles        Array(String),
    article_ids_cited      Array(String),
    flagged                UInt8 DEFAULT 0,
    flag_reasons           Array(String) DEFAULT [],
    confidence             Float64,
    model_id               LowCardinality(String),
    config_version         UInt32,
    input_tokens           UInt32,
    output_tokens          UInt32,
    processing_ms          UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.knowledge_gap_evaluations', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'guardrail_evaluations',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.guardrail_evaluations (
    tenant_id              String,
    project_id             String,
    session_id             String,
    session_started_at     DateTime64(3),
    agent_name             LowCardinality(String),
    channel                LowCardinality(String),
    processed_at           DateTime64(3) DEFAULT now64(3),
    evaluation_type        LowCardinality(String),
    overall_score          Float64,
    false_positive_score   Float64,
    false_negative_score   Float64,
    bypass_detected        UInt8,
    bypass_technique       String DEFAULT '',
    severity               LowCardinality(String),
    violation_categories   Array(String),
    flagged                UInt8 DEFAULT 0,
    flag_reasons           Array(String) DEFAULT [],
    confidence             Float64,
    model_id               LowCardinality(String),
    config_version         UInt32,
    input_tokens           UInt32,
    output_tokens          UInt32,
    processing_ms          UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.guardrail_evaluations', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'context_evaluations',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.context_evaluations (
    tenant_id              String,
    project_id             String,
    session_id             String,
    session_started_at     DateTime64(3),
    agent_name             LowCardinality(String),
    channel                LowCardinality(String),
    processed_at           DateTime64(3) DEFAULT now64(3),
    evaluation_type        LowCardinality(String),
    overall_score          Float64,
    context_score          Float64,
    lost_context_items     Array(String),
    duplication_detected   UInt8,
    duplication_count      UInt16,
    handoff_count          UInt16,
    flagged                UInt8 DEFAULT 0,
    flag_reasons           Array(String) DEFAULT [],
    confidence             Float64,
    model_id               LowCardinality(String),
    config_version         UInt32,
    input_tokens           UInt32,
    output_tokens          UInt32,
    processing_ms          UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.context_evaluations', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'friction_detections',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.friction_detections (
    tenant_id              String,
    project_id             String,
    session_id             String,
    session_started_at     DateTime64(3),
    agent_name             LowCardinality(String),
    channel                LowCardinality(String),
    processed_at           DateTime64(3) DEFAULT now64(3),
    friction_score         Float64,
    rephrase_count         UInt16,
    message_length_trend   Float64,
    turn_count_zscore      Float64,
    caps_count             UInt16,
    exclamation_count      UInt16,
    flagged                UInt8 DEFAULT 0,
    processing_ms          UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.friction_detections', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'anomaly_detections',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.anomaly_detections (
    tenant_id              String,
    project_id             String,
    session_id             String,
    processed_at           DateTime64(3) DEFAULT now64(3),
    anomaly_flag           UInt8,
    severity               LowCardinality(String),
    z_score                Float64,
    metric_name            String,
    metric_value           Float64,
    expected_range_low     Float64,
    expected_range_high    Float64,
    contributing_factors   Array(String),
    spc_out_of_control     UInt16,
    processing_ms          UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.anomaly_detections', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(processed_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(processed_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'drift_detections',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.drift_detections (
    tenant_id              String,
    project_id             String,
    session_id             String,
    processed_at           DateTime64(3) DEFAULT now64(3),
    drift_score            Float64,
    drift_type             LowCardinality(String),
    baseline_mean          Float64,
    current_mean           Float64,
    trend_slope            Float64,
    flagged                UInt8 DEFAULT 0,
    processing_ms          UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.drift_detections', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(processed_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(processed_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'customer_predictive_features',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.customer_predictive_features (
    tenant_id              String,
    project_id             String,
    customer_id            String,
    avg_sentiment          Float64,
    escalation_rate        Float64,
    repeat_contact_count   UInt32,
    quality_trend          Float64,
    churn_risk_score       Float64,
    risk_level             Enum8('low' = 0, 'medium' = 1, 'high' = 2),
    processed_at           DateTime DEFAULT now()
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.customer_predictive_features', '{replica}')
ORDER BY (tenant_id, project_id, customer_id)
TTL processed_at + INTERVAL 730 DAY
`,
  },
  {
    name: 'churn_risk_scores',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.churn_risk_scores (
    tenant_id              String,
    project_id             String,
    customer_id            String,
    risk_score             Float64,
    risk_level             Enum8('low' = 0, 'medium' = 1, 'high' = 2),
    contributing_factors   Array(String),
    computed_at            DateTime DEFAULT now()
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.churn_risk_scores', '{replica}')
ORDER BY (tenant_id, project_id, customer_id)
TTL computed_at + INTERVAL 730 DAY
`,
  },
  {
    name: 'conversation_mentions',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.conversation_mentions (
    tenant_id              String,
    project_id             String,
    session_id             String,
    mention_type           Enum8('competitor' = 0, 'feature_request' = 1, 'bug_report' = 2, 'channel_switch' = 3),
    mention_text           String,
    confidence             Float64,
    processed_at           DateTime DEFAULT now()
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.conversation_mentions', '{replica}')
ORDER BY (tenant_id, project_id, session_id, mention_type, mention_text)
TTL processed_at + INTERVAL 730 DAY
`,
  },
  {
    name: 'conversation_outcomes',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.conversation_outcomes (
    tenant_id          LowCardinality(String),
    project_id         LowCardinality(String),
    session_id         String,

    session_started_at DateTime64(3),
    processed_at       DateTime64(3),

    outcome            LowCardinality(String),
    outcome_method     LowCardinality(String),
    confidence         Float32,

    goal_detected      Nullable(String),
    goal_achieved      Nullable(UInt8),
    outcome_reasoning  Nullable(String),

    agent_name         LowCardinality(String),
    channel            LowCardinality(String),
    message_count      UInt16,
    handoff_count      UInt8,
    escalation_reason  Nullable(String),
    duration_ms        UInt32,

    model_id           LowCardinality(String),
    config_version     UInt32,
    processing_ms      UInt32
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.conversation_outcomes', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'goal_completions',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.goal_completions (
    tenant_id             String,
    project_id            String,
    session_id            String,
    session_started_at    DateTime64(3),
    processed_at          DateTime64(3),
    agent_name            LowCardinality(String),
    channel               LowCardinality(String),

    overall_score         Float64,
    goal_detected         String DEFAULT '',
    goal_achieved         UInt8 DEFAULT 0,
    summary               String DEFAULT '',
    criteria              String DEFAULT '{}',

    model_id              LowCardinality(String),
    config_version        UInt32 DEFAULT 0,
    pipeline_id           LowCardinality(String) DEFAULT '',
    pipeline_type         LowCardinality(String) DEFAULT '',
    source                LowCardinality(String) DEFAULT 'batch',
    processing_ms         UInt32 DEFAULT 0,
    input_tokens          UInt32 DEFAULT 0,
    output_tokens         UInt32 DEFAULT 0
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.goal_completions', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(processed_at))
ORDER BY (tenant_id, project_id, session_id, processed_at)
TTL toDateTime(processed_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'toxicity_evaluations',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.toxicity_evaluations (
    tenant_id             String,
    project_id            String,
    session_id            String,
    session_started_at    DateTime64(3),
    processed_at          DateTime64(3),
    agent_name            LowCardinality(String),
    channel               LowCardinality(String),

    avg_toxicity          Float64,
    max_toxicity          Float64,
    flagged               UInt8 DEFAULT 0,
    status                LowCardinality(String) DEFAULT 'pass',
    threshold             Float64 DEFAULT 0.7,
    message_count         UInt16 DEFAULT 0,

    model_id              LowCardinality(String),
    config_version        UInt32 DEFAULT 0,
    pipeline_id           LowCardinality(String) DEFAULT '',
    pipeline_type         LowCardinality(String) DEFAULT '',
    source                LowCardinality(String) DEFAULT 'batch',
    processing_ms         UInt32 DEFAULT 0,
    input_tokens          UInt32 DEFAULT 0,
    output_tokens         UInt32 DEFAULT 0
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.toxicity_evaluations', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(processed_at))
ORDER BY (tenant_id, project_id, session_id, processed_at)
TTL toDateTime(processed_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'message_toxicity',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.message_toxicity (
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
    status                LowCardinality(String) DEFAULT 'pass',
    content_length        UInt32 DEFAULT 0,

    pipeline_id           LowCardinality(String) DEFAULT '',
    pipeline_type         LowCardinality(String) DEFAULT ''
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.message_toxicity', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(message_at))
ORDER BY (tenant_id, session_id, message_id)
TTL toDateTime(message_at) + INTERVAL 730 DAY DELETE
`,
  },
  {
    name: 'llm_evaluate',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.llm_evaluate (
    tenant_id          String,
    project_id         String,
    session_id         String,
    session_started_at DateTime64(3),
    tag                LowCardinality(String),
    score              Nullable(Float32),
    output             String,

    agent_name         LowCardinality(String),
    channel            LowCardinality(String),
    model_id           LowCardinality(String),
    input_tokens       UInt32,
    output_tokens      UInt32,
    processing_ms      UInt32,
    pipeline_id        String,
    pipeline_type      LowCardinality(String) DEFAULT '',
    source             LowCardinality(String) DEFAULT 'batch',
    config_version     UInt32 DEFAULT 1,
    processed_at       DateTime64(3),

    INDEX idx_tag tag TYPE set(100) GRANULARITY 4,
    INDEX idx_score score TYPE minmax GRANULARITY 4
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.llm_evaluate', '{replica}', processed_at)
PARTITION BY (tenant_id, toYYYYMM(processed_at))
ORDER BY (tenant_id, project_id, tag, session_id)
TTL toDateTime(processed_at) + INTERVAL 730 DAY DELETE
`,
  },
];

// Skip indices added via ALTER TABLE (safe to re-run: ADD INDEX IF NOT EXISTS)
const ANALYTICS_SKIP_INDICES: string[] = [
  `ALTER TABLE ${DATABASE}.conversation_sentiment
    ADD INDEX IF NOT EXISTS idx_trajectory sentiment_trajectory TYPE set(10) GRANULARITY 4`,
  `ALTER TABLE ${DATABASE}.conversation_sentiment
    ADD INDEX IF NOT EXISTS idx_frustration frustration_detected TYPE set(2) GRANULARITY 4`,
  `ALTER TABLE ${DATABASE}.intent_classifications
    ADD INDEX IF NOT EXISTS idx_intent intent TYPE set(200) GRANULARITY 4`,
  `ALTER TABLE ${DATABASE}.quality_evaluations
    ADD INDEX IF NOT EXISTS idx_overall_score overall_score TYPE minmax GRANULARITY 4`,
  `ALTER TABLE ${DATABASE}.quality_evaluations
    ADD INDEX IF NOT EXISTS idx_flagged flagged TYPE set(2) GRANULARITY 4`,
  `ALTER TABLE ${DATABASE}.conversation_outcomes
    ADD INDEX IF NOT EXISTS idx_outcome outcome TYPE set(10) GRANULARITY 4`,
];

// =============================================================================
// SCHEMA MIGRATIONS (idempotent via ADD COLUMN IF NOT EXISTS)
// =============================================================================

/**
 * Multi-trigger support: Add `source` column to all output tables and
 * real-time metadata columns to per-message tables.
 */
const ANALYTICS_MIGRATIONS: string[] = [
  // Source column on all output tables (default 'batch' for backward compat)
  `ALTER TABLE ${DATABASE}.conversation_sentiment ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'batch'`,
  `ALTER TABLE ${DATABASE}.message_sentiment ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'batch'`,
  `ALTER TABLE ${DATABASE}.intent_classifications ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'batch'`,
  `ALTER TABLE ${DATABASE}.quality_evaluations ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'batch'`,
  `ALTER TABLE ${DATABASE}.hallucination_evaluations ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'batch'`,
  `ALTER TABLE ${DATABASE}.knowledge_gap_evaluations ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'batch'`,
  `ALTER TABLE ${DATABASE}.guardrail_evaluations ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'batch'`,
  `ALTER TABLE ${DATABASE}.context_evaluations ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'batch'`,
  `ALTER TABLE ${DATABASE}.friction_detections ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'batch'`,
  `ALTER TABLE ${DATABASE}.anomaly_detections ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'batch'`,
  `ALTER TABLE ${DATABASE}.drift_detections ADD COLUMN IF NOT EXISTS source LowCardinality(String) DEFAULT 'batch'`,

  // Real-time metadata on per-message/per-response tables
  `ALTER TABLE ${DATABASE}.message_sentiment ADD COLUMN IF NOT EXISTS trigger_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.message_sentiment ADD COLUMN IF NOT EXISTS message_index UInt32 DEFAULT 0`,
  `ALTER TABLE ${DATABASE}.message_sentiment ADD COLUMN IF NOT EXISTS window_size UInt8 DEFAULT 0`,

  `ALTER TABLE ${DATABASE}.intent_classifications ADD COLUMN IF NOT EXISTS trigger_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.intent_classifications ADD COLUMN IF NOT EXISTS message_index UInt32 DEFAULT 0`,
  `ALTER TABLE ${DATABASE}.intent_classifications ADD COLUMN IF NOT EXISTS window_size UInt8 DEFAULT 0`,

  `ALTER TABLE ${DATABASE}.hallucination_evaluations ADD COLUMN IF NOT EXISTS trigger_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.hallucination_evaluations ADD COLUMN IF NOT EXISTS message_index UInt32 DEFAULT 0`,
  `ALTER TABLE ${DATABASE}.hallucination_evaluations ADD COLUMN IF NOT EXISTS window_size UInt8 DEFAULT 0`,

  `ALTER TABLE ${DATABASE}.guardrail_evaluations ADD COLUMN IF NOT EXISTS trigger_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.guardrail_evaluations ADD COLUMN IF NOT EXISTS message_index UInt32 DEFAULT 0`,
  `ALTER TABLE ${DATABASE}.guardrail_evaluations ADD COLUMN IF NOT EXISTS window_size UInt8 DEFAULT 0`,

  `ALTER TABLE ${DATABASE}.friction_detections ADD COLUMN IF NOT EXISTS trigger_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.friction_detections ADD COLUMN IF NOT EXISTS message_index UInt32 DEFAULT 0`,
  `ALTER TABLE ${DATABASE}.friction_detections ADD COLUMN IF NOT EXISTS window_size UInt8 DEFAULT 0`,

  // ── Pipeline provenance columns (2026-03-10) ────────────────────────────
  `ALTER TABLE ${DATABASE}.conversation_sentiment ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_sentiment ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.message_sentiment ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.message_sentiment ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.quality_evaluations ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.quality_evaluations ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_outcomes ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_outcomes ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.intent_classifications ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.intent_classifications ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_mentions ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_mentions ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.hallucination_evaluations ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.hallucination_evaluations ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.knowledge_gap_evaluations ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.knowledge_gap_evaluations ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.guardrail_evaluations ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.guardrail_evaluations ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.context_evaluations ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.context_evaluations ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.friction_detections ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.friction_detections ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.anomaly_detections ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.anomaly_detections ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.drift_detections ADD COLUMN IF NOT EXISTS pipeline_id LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.drift_detections ADD COLUMN IF NOT EXISTS pipeline_type LowCardinality(String) DEFAULT ''`,

  // ── Missing common columns (2026-03-10) ─────────────────────────────────
  `ALTER TABLE ${DATABASE}.message_sentiment ADD COLUMN IF NOT EXISTS project_id String DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.conversation_mentions ADD COLUMN IF NOT EXISTS channel LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.anomaly_detections ADD COLUMN IF NOT EXISTS channel LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.drift_detections ADD COLUMN IF NOT EXISTS channel LowCardinality(String) DEFAULT ''`,

  // ── Intent resolution columns on intent_classifications ─────────────────
  // Populated by evaluate-resolution step (batch strategy only). Empty
  // resolution_status means the row was not evaluated (realtime rows or
  // pre-feature data).
  `ALTER TABLE ${DATABASE}.intent_classifications ADD COLUMN IF NOT EXISTS resolution_status LowCardinality(String) DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.intent_classifications ADD COLUMN IF NOT EXISTS resolution_reason String DEFAULT ''`,
  `ALTER TABLE ${DATABASE}.intent_classifications ADD COLUMN IF NOT EXISTS resolution_confidence Float32 DEFAULT 0`,
];

// =============================================================================
// MATERIALIZED VIEW DDL
// =============================================================================

const ANALYTICS_MV_DDL: { name: string; ddl: string }[] = [
  {
    name: 'mv_daily_sentiment',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_daily_sentiment
ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.mv_daily_sentiment', '{replica}')
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    agent_name,
    count() AS conversation_count,
    sum(avg_sentiment) AS total_sentiment,
    sum(CASE WHEN sentiment_trajectory = 'declining' THEN 1 ELSE 0 END) AS declining_count,
    sum(CASE WHEN frustration_detected = 1 THEN 1 ELSE 0 END) AS frustrated_count
FROM ${DATABASE}.conversation_sentiment
WHERE source = 'batch' OR source = ''
GROUP BY tenant_id, project_id, date, agent_name
`,
  },
  {
    name: 'mv_daily_intent_distribution',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_daily_intent_distribution
ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.mv_daily_intent_distribution', '{replica}')
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, intent)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    intent,
    count() AS conversation_count,
    sum(confidence) AS total_confidence
FROM ${DATABASE}.intent_classifications
WHERE source = 'batch' OR source = ''
GROUP BY tenant_id, project_id, date, intent
`,
  },
  {
    name: 'mv_daily_quality_scores',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_daily_quality_scores
ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.mv_daily_quality_scores', '{replica}')
PARTITION BY (tenant_id, toYYYYMM(date))
ORDER BY (tenant_id, project_id, date, agent_name, channel)
TTL date + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS date,
    agent_name,
    channel,
    count() AS conversation_count,
    sum(overall_score) AS total_score,
    sum(helpfulness) AS total_helpfulness,
    sum(accuracy) AS total_accuracy,
    sum(professionalism) AS total_professionalism,
    sum(CASE WHEN flagged = 1 THEN 1 ELSE 0 END) AS flagged_count
FROM ${DATABASE}.quality_evaluations
WHERE source = 'batch' OR source = ''
GROUP BY tenant_id, project_id, date, agent_name, channel
`,
  },
  {
    name: 'mv_daily_custom_events',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_daily_custom_events
ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.mv_daily_custom_events', '{replica}')
PARTITION BY (tenant_id, toYYYYMM(day))
ORDER BY (tenant_id, project_id, event_name, day)
AS SELECT
    tenant_id,
    project_id,
    event_name,
    toDate(timestamp) AS day,
    count() AS event_count,
    uniqExact(session_id) AS unique_sessions
FROM ${DATABASE}.custom_events
GROUP BY tenant_id, project_id, event_name, day
`,
  },
  {
    name: 'mv_daily_outcomes',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_daily_outcomes
ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.mv_daily_outcomes', '{replica}')
PARTITION BY (tenant_id, toYYYYMM(day))
ORDER BY (tenant_id, project_id, day, agent_name, channel, outcome)
TTL day + INTERVAL 730 DAY DELETE
AS SELECT
    tenant_id,
    project_id,
    toDate(session_started_at) AS day,
    agent_name,
    channel,
    outcome,
    count()              AS session_count,
    sum(duration_ms)     AS total_duration_ms,
    sum(message_count)   AS total_message_count
FROM ${DATABASE}.conversation_outcomes
GROUP BY tenant_id, project_id, day, agent_name, channel, outcome
`,
  },
  {
    name: 'mv_daily_llm_evaluate',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.mv_daily_llm_evaluate
ENGINE = ReplicatedSummingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.mv_daily_llm_evaluate', '{replica}')
ORDER BY (tenant_id, project_id, day, tag, agent_name)
AS SELECT
    tenant_id,
    project_id,
    toDate(processed_at) AS day,
    tag,
    agent_name,
    count()                          AS eval_count,
    countIf(score IS NOT NULL)       AS scored_eval_count,
    sumIf(score, score IS NOT NULL)  AS total_score
FROM ${DATABASE}.llm_evaluate
WHERE source = 'batch' OR source = ''
GROUP BY tenant_id, project_id, day, tag, agent_name
`,
  },
];

// =============================================================================
// PUBLIC CONSTANTS
// =============================================================================

const ANALYTICS_TABLES = ANALYTICS_TABLE_DDL.map((t) => t.name);
const ANALYTICS_MVS = ANALYTICS_MV_DDL.map((v) => v.name);

export {
  ANALYTICS_TABLE_DDL,
  ANALYTICS_SKIP_INDICES,
  ANALYTICS_MIGRATIONS,
  ANALYTICS_MV_DDL,
  ANALYTICS_TABLES,
  ANALYTICS_MVS,
};
