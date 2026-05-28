/**
 * Experiment ClickHouse Table DDL
 *
 * Moved from packages/pipeline-engine/src/pipeline/schemas/init-experiment-tables.ts
 */

const DATABASE = 'abl_platform';

export const EXPERIMENT_TABLE_DDL: { name: string; ddl: string }[] = [
  {
    name: 'experiment_assignments',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.experiment_assignments (
    tenant_id           String               CODEC(ZSTD(1)),
    project_id          String               CODEC(ZSTD(1)),
    experiment_id       String               CODEC(ZSTD(1)),
    session_id          String               CODEC(ZSTD(1)),
    experiment_group    LowCardinality(String) CODEC(ZSTD(1)),
    agent_version_id    String               CODEC(ZSTD(1)),
    assignment_mode     LowCardinality(String) DEFAULT 'version' CODEC(ZSTD(1)),
    deployment_id       String               DEFAULT '' CODEC(ZSTD(1)),
    assigned_at         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_experiment experiment_id       TYPE bloom_filter GRANULARITY 4,
    INDEX idx_session    session_id          TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.experiment_assignments', '{replica}')
PARTITION BY toYYYYMM(assigned_at)
ORDER BY (tenant_id, project_id, experiment_id, experiment_group, assigned_at)
TTL toDateTime(assigned_at) + INTERVAL 730 DAY DELETE
SETTINGS index_granularity = 8192
`,
  },
];

export const EXPERIMENT_TABLES = EXPERIMENT_TABLE_DDL.map((t) => t.name);
