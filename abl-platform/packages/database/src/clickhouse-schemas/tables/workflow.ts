/**
 * Workflow Event-Sourcing ClickHouse Table DDL
 *
 * Copied from packages/eventstore/src/stores/clickhouse/
 *   - workflow-execution-events-table.ts
 *   - human-task-events-table.ts
 *
 * Note: The original files in eventstore are NOT deleted — they export
 * DDL constants used by the ClickHouse event store reader/writer.
 * This file is a copy for the centralized init path.
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
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.workflow_execution_events', '{replica}')
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
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.workflow_executions_latest', '{replica}', _version)
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

export const HUMAN_TASK_EVENTS_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${DATABASE}.human_task_events
(
    event_id          UUID,
    event_version     LowCardinality(String),
    task_id           String                 CODEC(ZSTD(1)),
    tenant_id         LowCardinality(String),
    project_id        LowCardinality(String),
    execution_id      String                 CODEC(ZSTD(1)),
    workflow_id       String                 CODEC(ZSTD(1)),
    step_id           String                 CODEC(ZSTD(1)),
    task_type         LowCardinality(String),
    mailbox           LowCardinality(String),
    status            LowCardinality(String),
    priority          LowCardinality(String),
    event_type        LowCardinality(String),
    assigned_to       Array(LowCardinality(String))  CODEC(ZSTD(1)),
    claimed_by        LowCardinality(String),
    responded_by      LowCardinality(String),
    decision          LowCardinality(String),
    due_at            Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
    sla_breached_at   Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
    created_at        DateTime64(3, 'UTC')   CODEC(DoubleDelta, LZ4),
    payload           String                 CODEC(ZSTD(3)),
    payload_truncated UInt8                  DEFAULT 0,
    occurred_at       DateTime64(3, 'UTC')   CODEC(DoubleDelta, LZ4),
    ingested_at       DateTime64(3, 'UTC')   CODEC(DoubleDelta, LZ4)
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.human_task_events', '{replica}')
PARTITION BY toYYYYMM(occurred_at)
ORDER BY (tenant_id, project_id, task_id, occurred_at)
SETTINGS index_granularity = 8192
`;

export const HUMAN_TASKS_LATEST_TABLE_DDL = `
CREATE TABLE IF NOT EXISTS ${DATABASE}.human_tasks_latest
(
    task_id          String               CODEC(ZSTD(1)),
    tenant_id        LowCardinality(String),
    project_id       LowCardinality(String),
    execution_id     String               CODEC(ZSTD(1)),
    workflow_id      String               CODEC(ZSTD(1)),
    task_type        LowCardinality(String),
    status           LowCardinality(String),
    priority         LowCardinality(String),
    assigned_to      Array(LowCardinality(String)) CODEC(ZSTD(1)),
    claimed_by       LowCardinality(String),
    responded_by     LowCardinality(String),
    decision         LowCardinality(String),
    due_at           Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
    sla_breached_at  Nullable(DateTime64(3, 'UTC')) CODEC(DoubleDelta, LZ4),
    created_at       DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4),
    last_event_at    DateTime64(3, 'UTC') CODEC(DoubleDelta, LZ4),
    _version         UInt64               CODEC(T64, LZ4)
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.human_tasks_latest', '{replica}', _version)
PARTITION BY toYYYYMM(created_at)
ORDER BY (tenant_id, project_id, task_id)
SETTINGS index_granularity = 8192
`;

export const HUMAN_TASKS_LATEST_MV_DDL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.human_tasks_latest_mv
TO ${DATABASE}.human_tasks_latest AS
SELECT
    task_id,
    tenant_id,
    project_id,
    execution_id,
    workflow_id,
    task_type,
    status,
    priority,
    assigned_to,
    claimed_by,
    responded_by,
    decision,
    due_at,
    sla_breached_at,
    created_at,
    occurred_at AS last_event_at,
    toUnixTimestamp64Milli(occurred_at) AS _version
FROM ${DATABASE}.human_task_events
WHERE mailbox = 'workflow'
`;

export const WORKFLOW_TABLES = [
  'workflow_execution_events',
  'workflow_executions_latest',
  'human_task_events',
  'human_tasks_latest',
];

export const WORKFLOW_MVS = ['workflow_executions_latest_mv', 'human_tasks_latest_mv'];
