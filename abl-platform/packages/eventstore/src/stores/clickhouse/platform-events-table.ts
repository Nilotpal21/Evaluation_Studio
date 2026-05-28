/**
 * ClickHouse DDL for platform_events table.
 *
 * Single unified table for all platform events with:
 * - Hot/warm/cold tiered storage (30d → 90d → 730d DELETE)
 * - Tenant isolation (ORDER BY tenant_id first)
 * - Category-based indexing (ORDER BY category, event_type)
 * - Skip indexes for common query patterns (session_id, project_id, has_error)
 * - LowCardinality for enum-like columns
 * - JSON data column (schema-on-read, validated at application layer)
 */

const DATABASE = 'abl_platform';

export const PLATFORM_EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${DATABASE}.platform_events
(
    -- Core identifiers (tenant isolation + filtering)
    tenant_id         String               CODEC(ZSTD(1)),
    project_id        String               CODEC(ZSTD(1)),

    -- Event metadata
    event_id          String               CODEC(ZSTD(1)),
    event_type        LowCardinality(String) CODEC(ZSTD(1)),
    category          LowCardinality(String) CODEC(ZSTD(1)),

    -- Timestamp
    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    -- Session/Agent context (optional)
    session_id        String               DEFAULT '' CODEC(ZSTD(1)),
    trace_id          String               DEFAULT '' CODEC(ZSTD(1)),
    span_id           String               DEFAULT '' CODEC(ZSTD(1)),
    parent_span_id    String               DEFAULT '' CODEC(ZSTD(1)),
    turn_id           String               DEFAULT '' CODEC(ZSTD(1)),
    execution_id      String               DEFAULT '' CODEC(ZSTD(1)),
    parent_execution_id String             DEFAULT '' CODEC(ZSTD(1)),
    agent_run_id      String               DEFAULT '' CODEC(ZSTD(1)),
    decision_id       String               DEFAULT '' CODEC(ZSTD(1)),
    parent_decision_id String              DEFAULT '' CODEC(ZSTD(1)),
    cause_event_id    String               DEFAULT '' CODEC(ZSTD(1)),
    phase             LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    reason_code       LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    agent_name        String               DEFAULT '' CODEC(ZSTD(1)),
    deployment_id     String               DEFAULT '' CODEC(ZSTD(1)),
    known_source      LowCardinality(String) DEFAULT 'production' CODEC(ZSTD(1)),
    environment       LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    -- Channel context (optional)
    channel           String               DEFAULT '' CODEC(ZSTD(1)),

    -- Actor context (optional - for audit trail)
    actor_id          String               DEFAULT '' CODEC(ZSTD(1)),
    actor_type        LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    -- Duration (for operation events)
    duration_ms       UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),

    -- Error tracking
    has_error         UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    error_message     String               DEFAULT '' CODEC(ZSTD(1)),
    error_type        String               DEFAULT '' CODEC(ZSTD(1)),

    -- Event-specific data payload (JSON string, schema-on-read)
    -- Validated at application layer via Zod
    data              String               CODEC(ZSTD(3)),

    -- Optional metadata (tags, labels, custom fields)
    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    -- Custom dimensions (for analytics queries)
    custom_dimensions Map(String, String)  DEFAULT map() CODEC(ZSTD(3)),

    -- Encryption marker
    _enc              String               DEFAULT '' CODEC(ZSTD(1)),

    -- Skip indexes for common query patterns
    INDEX idx_session      session_id              TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_trace        trace_id                TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_span         span_id                 TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_turn         turn_id                 TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_execution    execution_id            TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_agent_run    agent_run_id            TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_decision     decision_id             TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_project      project_id              TYPE bloom_filter           GRANULARITY 4,
    INDEX idx_error        has_error               TYPE set(2)                GRANULARITY 4,
    INDEX idx_custom_dims  mapKeys(custom_dimensions) TYPE ngrambf_v1(3, 256, 2, 0) GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.platform_events', '{replica}')
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
    merge_with_ttl_timeout = 86400
`;

/**
 * Materialized views for common query patterns (deploy lazily when queries prove slow).
 *
 * These are pre-designed but NOT created by default.
 * Deploy them via ClickHouse admin when specific dashboards become slow (>2s).
 */

export const SESSION_METRICS_DAILY_MV_DDL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.session_metrics_daily_mv
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, project_id, day, channel)
POPULATE
AS SELECT
    tenant_id,
    project_id,
    toDate(timestamp) AS day,
    channel,
    countState() AS session_count,
    sumState(JSONExtractUInt(data, 'total_duration_ms')) AS total_duration_ms,
    sumState(JSONExtractFloat(data, 'estimated_cost')) AS total_cost,
    avgState(JSONExtractUInt(data, 'total_turns')) AS avg_turns
FROM ${DATABASE}.platform_events
WHERE event_type = 'session.ended'
GROUP BY tenant_id, project_id, day, channel
`;

/**
 * Materialized view for per-session trace queries.
 *
 * The base platform_events table is ORDER BY (tenant_id, category, event_type, timestamp)
 * which is optimal for category/type analytics but forces full granule scanning when
 * querying by session_id (bloom_filter skip index degrades at 500M+ events/day).
 *
 * This MV reorders data for direct key lookup by (tenant_id, session_id, timestamp, event_id),
 * eliminating bloom filter overhead for session trace queries.
 *
 * Target table uses ReplacingMergeTree to deduplicate on event_id naturally.
 */
export const PLATFORM_EVENTS_BY_SESSION_MV_DDL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.platform_events_by_session_mv
TO ${DATABASE}.platform_events_by_session
AS SELECT
    tenant_id,
    project_id,
    event_id,
    event_type,
    category,
    timestamp,
    session_id,
    trace_id,
    span_id,
    parent_span_id,
    turn_id,
    execution_id,
    parent_execution_id,
    agent_run_id,
    decision_id,
    parent_decision_id,
    cause_event_id,
    phase,
    reason_code,
    agent_name,
    deployment_id,
    known_source,
    environment,
    channel,
    actor_id,
    actor_type,
    duration_ms,
    has_error,
    error_message,
    error_type,
    data,
    metadata,
    custom_dimensions,
    _enc
FROM ${DATABASE}.platform_events
WHERE session_id != ''
`;

/**
 * Target table for the per-session materialized view.
 *
 * Uses ReplicatedReplacingMergeTree for deduplication on event_id
 * (same semantics as the source table's ReplicatedMergeTree but with session-optimized ordering).
 * Same TTL policy as the source table to keep storage aligned.
 */
export const PLATFORM_EVENTS_BY_SESSION_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${DATABASE}.platform_events_by_session
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
    turn_id           String               DEFAULT '' CODEC(ZSTD(1)),
    execution_id      String               DEFAULT '' CODEC(ZSTD(1)),
    parent_execution_id String             DEFAULT '' CODEC(ZSTD(1)),
    agent_run_id      String               DEFAULT '' CODEC(ZSTD(1)),
    decision_id       String               DEFAULT '' CODEC(ZSTD(1)),
    parent_decision_id String              DEFAULT '' CODEC(ZSTD(1)),
    cause_event_id    String               DEFAULT '' CODEC(ZSTD(1)),
    phase             LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    reason_code       LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    agent_name        String               DEFAULT '' CODEC(ZSTD(1)),
    deployment_id     String               DEFAULT '' CODEC(ZSTD(1)),
    known_source      LowCardinality(String) DEFAULT 'production' CODEC(ZSTD(1)),
    environment       LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
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
    _enc              String               DEFAULT '' CODEC(ZSTD(1))
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.platform_events_by_session', '{replica}')
PARTITION BY toDate(timestamp)
ORDER BY (tenant_id, session_id, timestamp, event_id)
TTL
    toDateTime(timestamp) + INTERVAL 30 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(timestamp) + INTERVAL 730 DAY DELETE
SETTINGS
    storage_policy = 'tiered',
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`;

/**
 * Returns the DDL statements for the per-session materialized view in the
 * correct creation order: target table first, then the MV that writes to it.
 *
 * ClickHouse requires the target table to exist before a `TO <table>` MV can
 * be created. Executing these out of order will fail with "Unknown table".
 */
export function getSessionMVDDLStatements(): [table: string, mv: string] {
  return [PLATFORM_EVENTS_BY_SESSION_TABLE_DDL, PLATFORM_EVENTS_BY_SESSION_MV_DDL];
}

/**
 * PLATFORM_EVENTS_BY_SESSION_TABLE_DDL and PLATFORM_EVENTS_BY_SESSION_MV_DDL
 * have an ordering dependency: the table must be created before the MV.
 * Use {@link getSessionMVDDLStatements} to get them in the correct order.
 *
 * SESSION_METRICS_DAILY_MV_DDL and LLM_COST_HOURLY_MV_DDL are self-contained
 * (ENGINE = AggregatingMergeTree with no TO clause) and can be created independently.
 */

export const LLM_COST_HOURLY_MV_DDL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.llm_cost_hourly_mv
ENGINE = AggregatingMergeTree()
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, project_id, hour, model, provider)
POPULATE
AS SELECT
    tenant_id,
    project_id,
    toStartOfHour(timestamp) AS hour,
    agent_name,
    JSONExtractString(data, 'model') AS model,
    JSONExtractString(data, 'provider') AS provider,
    countState() AS call_count,
    sumState(JSONExtractUInt(data, 'input_tokens')) AS total_input_tokens,
    sumState(JSONExtractUInt(data, 'output_tokens')) AS total_output_tokens,
    sumState(JSONExtractFloat(data, 'estimated_cost')) AS total_cost,
    avgState(JSONExtractUInt(data, 'latency_ms')) AS avg_latency_ms
FROM ${DATABASE}.platform_events
WHERE event_type = 'llm.call.completed'
GROUP BY tenant_id, project_id, hour, agent_name, model, provider
`;
