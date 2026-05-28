/**
 * ClickHouse DDL for human-task event-sourcing tables.
 *
 * Mirrors workflow-execution-events-table.ts (append-only stream +
 * ReplacingMergeTree projection + per-row MV). Key differences:
 * - Keyed on `task_id` rather than `execution_id`.
 * - Carries human-task fields: `assigned_to`, `claimed_by`, `responded_by`,
 *   `decision`, `due_at`, `sla_breached_at`, `priority`.
 * - MV filters `WHERE mailbox = 'workflow'` (HLD §5.3 errata E-5) —
 *   belt-and-suspenders scope enforcement alongside the Zod literal guard
 *   and separate Kafka topic.
 *
 * HLD §5.3 errata E-2 + E-4: `payload_truncated` and `created_at` columns
 * are added to carry cumulative state for the per-row MV projection.
 * `created_at` is distinct from `occurred_at` (the per-event timestamp).
 */

const DATABASE = 'abl_platform';

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
ENGINE = MergeTree
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
ENGINE = ReplacingMergeTree(_version)
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
