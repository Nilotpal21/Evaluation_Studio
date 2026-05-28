-- ClickHouse DDL Init Script
-- All tables use ReplicatedMergeTree (Keeper required in dev via Docker Compose)
-- Run via: clickhouse-client --multiquery < 01-init.sql
-- Or programmatically via packages/database/src/clickhouse-schemas/init.ts

CREATE DATABASE IF NOT EXISTS abl_platform;

-- =============================================================================
-- MESSAGES (~300M writes/day)
-- Encrypted: content (compress-then-encrypt, ZSTD + AES-256-GCM + Base64)
-- =============================================================================

CREATE TABLE IF NOT EXISTS abl_platform.messages
(
    tenant_id         String               CODEC(ZSTD(1)),
    session_id        String               CODEC(ZSTD(1)),
    created_at        DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    message_id        String               CODEC(NONE),
    contact_id        String               DEFAULT '' CODEC(ZSTD(1)),

    role              LowCardinality(String) CODEC(ZSTD(1)),
    channel           LowCardinality(String) CODEC(ZSTD(1)),

    content           String               CODEC(NONE),
    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    encrypted         UInt8                DEFAULT 1 CODEC(T64, ZSTD(1)),
    key_version       UInt16               DEFAULT 1 CODEC(T64, ZSTD(1)),

    has_pii           UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    scrubbed          UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),

    trace_id          String               DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_contact contact_id       TYPE bloom_filter GRANULARITY 4,
    INDEX idx_pii     (has_pii, scrubbed) TYPE set(4)   GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.messages', '{replica}')
PARTITION BY toYYYYMMDD(created_at)
ORDER BY (tenant_id, session_id, created_at)
TTL
    toDateTime(created_at) + INTERVAL 14 DAY
        SET content = if(has_pii AND scrubbed = 0, '[PII_EXPIRED]', content),
            scrubbed = if(has_pii, 1, scrubbed),
    toDateTime(created_at) + INTERVAL 30 DAY TO VOLUME 'warm',
    toDateTime(created_at) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(created_at) + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;

-- =============================================================================
-- LLM METRICS (~100M writes/day)
-- No encryption
-- =============================================================================

CREATE TABLE IF NOT EXISTS abl_platform.llm_metrics
(
    tenant_id         String               CODEC(ZSTD(1)),
    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    model_id          LowCardinality(String) CODEC(ZSTD(1)),
    provider          LowCardinality(String) CODEC(ZSTD(1)),

    session_id        String               CODEC(ZSTD(1)),
    project_id        String               CODEC(ZSTD(1)),
    user_id           String               DEFAULT '' CODEC(ZSTD(1)),
    operation_type    LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    agent_name        LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    input_tokens      UInt32               CODEC(T64, ZSTD(1)),
    output_tokens     UInt32               CODEC(T64, ZSTD(1)),
    total_tokens      UInt32               CODEC(T64, ZSTD(1)),

    estimated_cost    Float64              DEFAULT 0 CODEC(Gorilla, ZSTD(1)),
    latency_ms        UInt32               CODEC(T64, ZSTD(1)),
    streaming_used    UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    tool_call_count   UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),

    success           UInt8                DEFAULT 1 CODEC(T64, ZSTD(1)),
    error_type        LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_session   session_id     TYPE bloom_filter GRANULARITY 4,
    INDEX idx_operation operation_type TYPE set(10)      GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.llm_metrics', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, toStartOfHour(timestamp), model_id, provider)
TTL
    toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 365 DAY TO VOLUME 'cold',
    toDateTime(timestamp) + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;

-- =============================================================================
-- LLM METRICS - HOURLY ROLLUP (AggregatingMergeTree)
-- =============================================================================

CREATE TABLE IF NOT EXISTS abl_platform.llm_metrics_hourly_dest
(
    tenant_id           String,
    project_id          String,
    model_id            LowCardinality(String),
    provider            LowCardinality(String),
    agent_name          LowCardinality(String),
    hour                DateTime,

    total_input_tokens  SimpleAggregateFunction(sum, UInt64),
    total_output_tokens SimpleAggregateFunction(sum, UInt64),
    total_tokens        SimpleAggregateFunction(sum, UInt64),
    call_count          SimpleAggregateFunction(sum, UInt64),
    error_count         SimpleAggregateFunction(sum, UInt64),
    total_cost          SimpleAggregateFunction(sum, Float64),
    total_tool_calls    SimpleAggregateFunction(sum, UInt64),
    sum_latency_ms      SimpleAggregateFunction(sum, UInt64),
    max_latency_ms      SimpleAggregateFunction(max, UInt32),
    min_latency_ms      SimpleAggregateFunction(min, UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, project_id, model_id, provider, agent_name, hour)
TTL hour + INTERVAL 1095 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.llm_metrics_hourly
TO abl_platform.llm_metrics_hourly_dest
AS SELECT
    tenant_id, project_id, model_id, provider, agent_name,
    toStartOfHour(timestamp) AS hour,
    sumSimpleState(toUInt64(input_tokens))           AS total_input_tokens,
    sumSimpleState(toUInt64(output_tokens))           AS total_output_tokens,
    sumSimpleState(toUInt64(total_tokens))             AS total_tokens,
    sumSimpleState(toUInt64(1))                        AS call_count,
    sumSimpleState(toUInt64(if(success = 0, 1, 0)))    AS error_count,
    sumSimpleState(toFloat64(estimated_cost))           AS total_cost,
    sumSimpleState(toUInt64(tool_call_count))            AS total_tool_calls,
    sumSimpleState(toUInt64(latency_ms))                AS sum_latency_ms,
    maxSimpleState(latency_ms)                          AS max_latency_ms,
    minSimpleState(latency_ms)                          AS min_latency_ms
FROM abl_platform.llm_metrics
GROUP BY tenant_id, project_id, model_id, provider, agent_name, hour;

-- =============================================================================
-- LLM METRICS - DAILY ROLLUP (AggregatingMergeTree)
-- =============================================================================

CREATE TABLE IF NOT EXISTS abl_platform.llm_metrics_daily_dest
(
    tenant_id           String,
    project_id          String,
    model_id            LowCardinality(String),
    provider            LowCardinality(String),
    day                 Date,

    total_input_tokens  SimpleAggregateFunction(sum, UInt64),
    total_output_tokens SimpleAggregateFunction(sum, UInt64),
    total_tokens        SimpleAggregateFunction(sum, UInt64),
    call_count          SimpleAggregateFunction(sum, UInt64),
    error_count         SimpleAggregateFunction(sum, UInt64),
    total_cost          SimpleAggregateFunction(sum, Float64),
    total_tool_calls    SimpleAggregateFunction(sum, UInt64),
    sum_latency_ms      SimpleAggregateFunction(sum, UInt64),
    max_latency_ms      SimpleAggregateFunction(max, UInt32),
    min_latency_ms      SimpleAggregateFunction(min, UInt32)
)
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, project_id, model_id, provider, day)
TTL day + INTERVAL 1095 DAY DELETE
SETTINGS index_granularity = 8192;

CREATE MATERIALIZED VIEW IF NOT EXISTS abl_platform.llm_metrics_daily
TO abl_platform.llm_metrics_daily_dest
AS SELECT
    tenant_id, project_id, model_id, provider,
    toDate(timestamp) AS day,
    sumSimpleState(toUInt64(input_tokens))           AS total_input_tokens,
    sumSimpleState(toUInt64(output_tokens))           AS total_output_tokens,
    sumSimpleState(toUInt64(total_tokens))             AS total_tokens,
    sumSimpleState(toUInt64(1))                        AS call_count,
    sumSimpleState(toUInt64(if(success = 0, 1, 0)))    AS error_count,
    sumSimpleState(toFloat64(estimated_cost))           AS total_cost,
    sumSimpleState(toUInt64(tool_call_count))            AS total_tool_calls,
    sumSimpleState(toUInt64(latency_ms))                AS sum_latency_ms,
    maxSimpleState(latency_ms)                          AS max_latency_ms,
    minSimpleState(latency_ms)                          AS min_latency_ms
FROM abl_platform.llm_metrics
GROUP BY tenant_id, project_id, model_id, provider, day;

-- =============================================================================
-- LOGS (~65M writes/day)
-- No encryption
-- =============================================================================

CREATE TABLE IF NOT EXISTS abl_platform.logs
(
    tenant_id         String               DEFAULT '' CODEC(ZSTD(1)),
    timestamp         DateTime             CODEC(Delta, ZSTD(1)),
    service           LowCardinality(String) CODEC(ZSTD(1)),
    level             LowCardinality(String) CODEC(ZSTD(1)),

    session_id        String               DEFAULT '' CODEC(ZSTD(1)),
    request_id        String               DEFAULT '' CODEC(ZSTD(1)),

    message           String               CODEC(ZSTD(3)),
    data              String               DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_level   level      TYPE set(5)                 GRANULARITY 4,
    INDEX idx_message message    TYPE tokenbf_v1(512, 3, 0)  GRANULARITY 4,
    INDEX idx_session session_id TYPE bloom_filter            GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.logs', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, timestamp, service, level)
TTL
    timestamp + INTERVAL 3 DAY TO VOLUME 'warm',
    timestamp + INTERVAL 14 DAY TO VOLUME 'cold',
    timestamp + INTERVAL 30 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;

-- =============================================================================
-- AUDIT EVENTS (~10M writes/day)
-- No encryption, no delete TTL (regulatory retention)
-- =============================================================================

CREATE TABLE IF NOT EXISTS abl_platform.audit_events
(
    tenant_id         String               CODEC(ZSTD(1)),
    timestamp         DateTime             CODEC(Delta, ZSTD(1)),
    action            LowCardinality(String) CODEC(ZSTD(1)),

    event_id          String               CODEC(NONE),

    actor_id          String               DEFAULT '' CODEC(ZSTD(1)),
    actor_type        LowCardinality(String) DEFAULT 'user' CODEC(ZSTD(1)),
    actor_ip          String               DEFAULT '' CODEC(ZSTD(1)),
    actor_user_agent  String               DEFAULT '' CODEC(ZSTD(1)),

    resource_type     LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    resource_id       String               DEFAULT '' CODEC(ZSTD(1)),

    session_id        String               DEFAULT '' CODEC(ZSTD(1)),
    project_id        String               DEFAULT '' CODEC(ZSTD(1)),

    old_value         String               DEFAULT '' CODEC(ZSTD(3)),
    new_value         String               DEFAULT '' CODEC(ZSTD(3)),
    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    success           UInt8                DEFAULT 1 CODEC(T64, ZSTD(1)),
    failure_reason    String               DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_action   action        TYPE set(100)     GRANULARITY 4,
    INDEX idx_actor    actor_id      TYPE bloom_filter GRANULARITY 4,
    INDEX idx_session  session_id    TYPE bloom_filter GRANULARITY 4,
    INDEX idx_resource resource_type TYPE set(20)      GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.audit_events', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, timestamp, action)
TTL
    timestamp + INTERVAL 90 DAY TO VOLUME 'cold'
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 86400;

-- =============================================================================
-- PLATFORM EVENTS (~500M writes/day)
-- Unified table for all platform events (traces, analytics, audit)
-- =============================================================================

CREATE TABLE IF NOT EXISTS abl_platform.platform_events
(
    tenant_id         String               CODEC(ZSTD(1)),
    project_id        String               CODEC(ZSTD(1)),

    event_id          String               CODEC(ZSTD(1)),
    event_type        LowCardinality(String) CODEC(ZSTD(1)),
    category          LowCardinality(String) CODEC(ZSTD(1)),

    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    session_id        String               DEFAULT '' CODEC(ZSTD(1)),
    trace_id          String               DEFAULT '' CODEC(ZSTD(1)),
    span_id           String               DEFAULT '' CODEC(ZSTD(1)),
    parent_span_id    String               DEFAULT '' CODEC(ZSTD(1)),
    agent_name        String               DEFAULT '' CODEC(ZSTD(1)),
    deployment_id     String               DEFAULT '' CODEC(ZSTD(1)),

    channel           String               DEFAULT '' CODEC(ZSTD(1)),

    actor_id          String               DEFAULT '' CODEC(ZSTD(1)),
    actor_type        LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    duration_ms       UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),

    has_error         UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    error_message     String               DEFAULT '' CODEC(ZSTD(1)),
    error_type        String               DEFAULT '' CODEC(ZSTD(1)),

    data              String               CODEC(ZSTD(3)),

    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    custom_dimensions Map(String, String)  DEFAULT map() CODEC(ZSTD(3)),

    _enc              String               DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_session      session_id              TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_trace        trace_id                TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_span         span_id                 TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_project      project_id              TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_error        has_error               TYPE set(2)                GRANULARITY 4,
    INDEX idx_custom_dims  mapKeys(custom_dimensions) TYPE ngrambf_v1(3, 256, 2, 0) GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.platform_events', '{replica}')
PARTITION BY toDate(timestamp)
ORDER BY (tenant_id, category, event_type, timestamp)
TTL
    toDateTime(timestamp) + INTERVAL 30 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(timestamp) + INTERVAL 730 DAY DELETE
SETTINGS
    storage_policy = 'tiered',
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;

-- Migration: add span columns for existing deployments (idempotent)
ALTER TABLE abl_platform.platform_events ADD COLUMN IF NOT EXISTS span_id String DEFAULT '' CODEC(ZSTD(1));
ALTER TABLE abl_platform.platform_events ADD COLUMN IF NOT EXISTS parent_span_id String DEFAULT '' CODEC(ZSTD(1));
ALTER TABLE abl_platform.platform_events ADD INDEX IF NOT EXISTS idx_span span_id TYPE bloom_filter GRANULARITY 4;
ALTER TABLE abl_platform.platform_events MATERIALIZE INDEX idx_span;

-- =============================================================================
-- SPATIAL TRACE RECORDS (STI — Structured Trace Identifiers)
-- Stores span-level records keyed by STI taxonomy paths
-- =============================================================================

CREATE TABLE IF NOT EXISTS abl_platform.spatial_trace_records
(
    tenant_id         String               CODEC(ZSTD(1)),
    project_id        String               CODEC(ZSTD(1)),
    trace_id          String               CODEC(ZSTD(1)),
    span_id           String               CODEC(ZSTD(1)),
    parent_span_id    String               DEFAULT '' CODEC(ZSTD(1)),

    sti_path          LowCardinality(String) CODEC(ZSTD(1)),

    session_id        String               DEFAULT '' CODEC(ZSTD(1)),
    agent_name        String               DEFAULT '' CODEC(ZSTD(1)),
    deployment_id     String               DEFAULT '' CODEC(ZSTD(1)),
    config_hash       String               DEFAULT '' CODEC(ZSTD(1)),

    started_at        DateTime64(3, 'UTC') CODEC(DoubleDelta, ZSTD(1)),
    ended_at          DateTime64(3, 'UTC') CODEC(DoubleDelta, ZSTD(1)),
    duration_ms       UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),

    has_error         UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    error_type        LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    error_message     String               DEFAULT '' CODEC(ZSTD(1)),

    input_tokens      UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    output_tokens     UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    total_tokens      UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),

    model_id          LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    provider          LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    tool_name         LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    attributes        String               DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_trace      trace_id        TYPE bloom_filter       GRANULARITY 4,
    INDEX idx_span       span_id         TYPE bloom_filter       GRANULARITY 4,
    INDEX idx_session    session_id      TYPE bloom_filter       GRANULARITY 4,
    INDEX idx_sti_path   sti_path        TYPE set(50)            GRANULARITY 4,
    INDEX idx_error      has_error       TYPE set(2)             GRANULARITY 4,
    INDEX idx_config     config_hash     TYPE bloom_filter       GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/abl_platform.spatial_trace_records', '{replica}')
PARTITION BY toDate(started_at)
ORDER BY (tenant_id, project_id, sti_path, started_at)
TTL
    toDateTime(started_at) + INTERVAL 30 DAY TO VOLUME 'warm',
    toDateTime(started_at) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(started_at) + INTERVAL 730 DAY DELETE
SETTINGS
    storage_policy = 'tiered',
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400;

-- =============================================================================
-- ANALYTICS PIPELINE OUTPUT TABLES
-- Created at runtime by: packages/pipeline-engine/src/pipeline/schemas/init-analytics-tables.ts
-- Reference SQL: packages/pipeline-engine/src/pipeline/schemas/clickhouse-analytics-tables.sql
-- Tables: message_sentiment, conversation_sentiment, intent_classifications, quality_evaluations
-- MVs: mv_daily_sentiment, mv_daily_intent_distribution, mv_daily_quality_scores
-- =============================================================================
