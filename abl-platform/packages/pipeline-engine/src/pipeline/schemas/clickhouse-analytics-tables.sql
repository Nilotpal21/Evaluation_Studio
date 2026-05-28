-- =========================================================================
-- Analytics Pipeline Output Tables
--
-- Dedicated ClickHouse tables for sentiment, intent, and quality
-- pipeline outputs. These tables use ReplacingMergeTree to support
-- idempotent reprocessing (dedup on processed_at version).
--
-- Created by: init-analytics-tables.ts (called at pipeline engine startup)
-- =========================================================================

-- =========================================================================
-- SENTIMENT: Per-message sentiment scores
-- =========================================================================
CREATE TABLE IF NOT EXISTS abl_platform.message_sentiment (
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
    processing_ms    UInt32,

    run_id           String DEFAULT '',
    pipeline_id      String DEFAULT '',
    INDEX idx_run_id run_id TYPE minmax GRANULARITY 1,
    INDEX idx_pipeline_id pipeline_id TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(message_at))
ORDER BY (tenant_id, session_id, message_id)
TTL toDateTime(message_at) + INTERVAL 730 DAY DELETE;

-- =========================================================================
-- SENTIMENT: Conversation-level aggregation
-- =========================================================================
CREATE TABLE IF NOT EXISTS abl_platform.conversation_sentiment (
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
    processing_ms    UInt32,

    run_id           String DEFAULT '',
    pipeline_id      String DEFAULT '',
    INDEX idx_run_id run_id TYPE minmax GRANULARITY 1,
    INDEX idx_pipeline_id pipeline_id TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE;

-- =========================================================================
-- INTENT: Per-conversation intent classification
-- =========================================================================
CREATE TABLE IF NOT EXISTS abl_platform.intent_classifications (
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
    output_tokens    UInt32,

    run_id           String DEFAULT '',
    pipeline_id      String DEFAULT '',
    INDEX idx_run_id run_id TYPE minmax GRANULARITY 1,
    INDEX idx_pipeline_id pipeline_id TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE;

-- =========================================================================
-- QUALITY: Per-conversation LLM-as-judge evaluation
-- =========================================================================
CREATE TABLE IF NOT EXISTS abl_platform.quality_evaluations (
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
    output_tokens    UInt32,

    run_id           String DEFAULT '',
    pipeline_id      String DEFAULT '',
    INDEX idx_run_id run_id TYPE minmax GRANULARITY 1,
    INDEX idx_pipeline_id pipeline_id TYPE minmax GRANULARITY 1
)
ENGINE = ReplacingMergeTree(processed_at)
PARTITION BY (tenant_id, toYYYYMM(session_started_at))
ORDER BY (tenant_id, project_id, session_id)
TTL toDateTime(session_started_at) + INTERVAL 730 DAY DELETE;

-- =========================================================================
-- SKIP INDICES
-- =========================================================================
ALTER TABLE abl_platform.conversation_sentiment
    ADD INDEX IF NOT EXISTS idx_trajectory sentiment_trajectory TYPE set(10) GRANULARITY 4;

ALTER TABLE abl_platform.conversation_sentiment
    ADD INDEX IF NOT EXISTS idx_frustration frustration_detected TYPE set(2) GRANULARITY 4;

ALTER TABLE abl_platform.intent_classifications
    ADD INDEX IF NOT EXISTS idx_intent intent TYPE set(200) GRANULARITY 4;

ALTER TABLE abl_platform.quality_evaluations
    ADD INDEX IF NOT EXISTS idx_overall_score overall_score TYPE minmax GRANULARITY 4;

ALTER TABLE abl_platform.quality_evaluations
    ADD INDEX IF NOT EXISTS idx_flagged flagged TYPE set(2) GRANULARITY 4;
