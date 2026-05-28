/**
 * ClickHouse DDL for workflow event-sourcing tables.
 *
 * Three tables wired together:
 * - `workflow_execution_events` — append-only event stream (MergeTree)
 * - `workflow_executions_latest` — per-execution projection target
 *   (ReplacingMergeTree, collapsed on merge by `_version`)
 * - `workflow_executions_latest_mv` — per-row MV (HLD §5.3 Q1 decision,
 *   NOT aggregation-based). Projects each event 1:1 into the target;
 *   ReplacingMergeTree keeps the row with the highest `_version`.
 *
 * Codec conventions mirror `platform_events`:
 * - `LowCardinality(String)` for enum-like fields
 * - `ZSTD(1)` for identifiers, `ZSTD(3)` for JSON blobs
 * - `DoubleDelta, LZ4` for timestamps, `T64, LZ4` for small ints
 *
 * DDL is template-literal-embedded (matching `platform-events-table.ts` and
 * `init-analytics-tables.ts`) so the compiled dist/ is self-contained —
 * no runtime file reads, no .sql migration runner needed.
 *
 * HLD §5.3 errata E-2 + E-4: `payload_truncated`, `started_at`, and
 * `completed_at` columns are added to the event stream to carry cumulative
 * state for the per-row MV projection.
 */

const DATABASE = 'abl_platform';

export const WORKFLOW_EXECUTION_EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${DATABASE}.workflow_execution_events
(
    event_id          UUID,
    event_version     LowCardinality(String),
    execution_id      String               CODEC(ZSTD(1)),
    tenant_id         LowCardinality(String),
    project_id        LowCardinality(String),
    workflow_id       String               CODEC(ZSTD(1)),
    workflow_version  String               CODEC(ZSTD(1)),
    event_type        LowCardinality(String),
    status            LowCardinality(String),
    started_at        DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4),
    completed_at      Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
    duration_ms       UInt32               CODEC(T64, LZ4),
    step_id           String               CODEC(ZSTD(1)),
    step_name         String               CODEC(ZSTD(1)),
    step_type         LowCardinality(String),
    trigger_type      LowCardinality(String),
    error_code        LowCardinality(String),
    error_message     String               CODEC(ZSTD(3)),
    payload           String               CODEC(ZSTD(3)),
    payload_truncated UInt8                DEFAULT 0,
    occurred_at       DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4),
    ingested_at       DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, project_id, execution_id, occurred_at)
SETTINGS index_granularity = 8192
`;

export const WORKFLOW_EXECUTIONS_LATEST_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${DATABASE}.workflow_executions_latest
(
    execution_id     String               CODEC(ZSTD(1)),
    tenant_id        LowCardinality(String),
    project_id       LowCardinality(String),
    workflow_id      String               CODEC(ZSTD(1)),
    workflow_version String               CODEC(ZSTD(1)),
    status           LowCardinality(String),
    trigger_type     LowCardinality(String),
    started_at       DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4),
    completed_at     Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
    duration_ms      UInt32               CODEC(T64, LZ4),
    last_event_at    DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4),
    _version         UInt64               CODEC(T64, LZ4)
)
ENGINE = ReplacingMergeTree(_version)
PARTITION BY toYYYYMM(started_at)
ORDER BY (tenant_id, project_id, workflow_id, execution_id)
SETTINGS index_granularity = 8192
`;

export const WORKFLOW_EXECUTIONS_LATEST_MV_DDL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.workflow_executions_latest_mv
TO ${DATABASE}.workflow_executions_latest AS
SELECT
    execution_id,
    tenant_id,
    project_id,
    workflow_id,
    workflow_version,
    status,
    trigger_type,
    started_at,
    completed_at,
    duration_ms,
    occurred_at AS last_event_at,
    toUnixTimestamp64Milli(occurred_at) AS _version
FROM ${DATABASE}.workflow_execution_events
`;
