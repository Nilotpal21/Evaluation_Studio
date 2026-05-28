/**
 * ClickHouse Schema Initialization
 *
 * Generates and executes DDL for all ClickHouse tables and materialized views.
 * All tables use ReplicatedMergeTree (Keeper required — included in Docker Compose for dev).
 *
 * Usage:
 *   import { initClickHouseSchema } from '@agent-platform/database/clickhouse-schemas/init';
 *   await initClickHouseSchema(client);
 */

import type { ClickHouseClient } from '@clickhouse/client';
import { detectClusterName, injectOnClusterForStatement } from './cluster.js';
import { resolveClickHouseDatabaseName } from './database.js';
import { resolveDDLTransformOptions, transformDDL } from './ddl-transform.js';

const DATABASE = 'abl_platform';

export type ClickHouseAuditDeploymentEnvironment = 'dev' | 'staging' | 'production';

export interface ClickHouseAuditRetentionConfig {
  deploymentEnvironment: ClickHouseAuditDeploymentEnvironment;
  auditEvents: {
    coldVolumeDays: number | null;
    deleteDays: number;
  };
  kmsAudit: {
    warmVolumeDays: number | null;
    deleteDays: number;
  };
  archAudit: {
    deleteDays: number;
  };
  omnichannelAudit: {
    deleteDays: number;
  };
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function getStatementPreview(query: string): string {
  return query.replace(/\s+/g, ' ').trim().slice(0, 240);
}

const CLICKHOUSE_AUDIT_RETENTION_PROFILES: Record<
  ClickHouseAuditDeploymentEnvironment,
  Omit<ClickHouseAuditRetentionConfig, 'deploymentEnvironment'>
> = {
  dev: {
    auditEvents: {
      coldVolumeDays: null,
      deleteDays: 30,
    },
    kmsAudit: {
      warmVolumeDays: null,
      deleteDays: 90,
    },
    archAudit: {
      deleteDays: 90,
    },
    omnichannelAudit: {
      deleteDays: 30,
    },
  },
  staging: {
    auditEvents: {
      coldVolumeDays: 30,
      deleteDays: 180,
    },
    kmsAudit: {
      warmVolumeDays: 90,
      deleteDays: 365,
    },
    archAudit: {
      deleteDays: 90,
    },
    omnichannelAudit: {
      deleteDays: 90,
    },
  },
  production: {
    auditEvents: {
      coldVolumeDays: 90,
      deleteDays: 730,
    },
    kmsAudit: {
      warmVolumeDays: 365,
      deleteDays: 1095,
    },
    archAudit: {
      deleteDays: 90,
    },
    omnichannelAudit: {
      deleteDays: 180,
    },
  },
};

function normalizeClickHouseAuditDeploymentEnvironment(
  value: string | undefined,
): ClickHouseAuditDeploymentEnvironment {
  const normalized = value?.trim().toLowerCase();
  if (!normalized) {
    return 'dev';
  }

  if (normalized === 'production' || normalized === 'prod') {
    return 'production';
  }

  if (
    normalized === 'staging' ||
    normalized === 'stage' ||
    normalized === 'qa' ||
    normalized === 'uat' ||
    normalized === 'preprod' ||
    normalized === 'preview'
  ) {
    return 'staging';
  }

  return 'dev';
}

function parsePositiveIntegerOverride(
  value: string | undefined,
  fallback: number | null,
): number | null {
  if (value === undefined) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return fallback;
  }

  return parsed;
}

export function resolveClickHouseAuditRetentionConfig(
  env: Record<string, string | undefined> = process.env,
): ClickHouseAuditRetentionConfig {
  const deploymentEnvironment = normalizeClickHouseAuditDeploymentEnvironment(
    env.DEPLOYMENT_ENVIRONMENT ?? env.RUNTIME_ENV ?? env.APP_ENV ?? env.NODE_ENV,
  );
  const profile = CLICKHOUSE_AUDIT_RETENTION_PROFILES[deploymentEnvironment];

  return {
    deploymentEnvironment,
    auditEvents: {
      coldVolumeDays: parsePositiveIntegerOverride(
        env.AUDIT_EVENTS_COLD_TTL_DAYS,
        profile.auditEvents.coldVolumeDays,
      ),
      deleteDays: parsePositiveIntegerOverride(
        env.AUDIT_EVENTS_DELETE_TTL_DAYS,
        profile.auditEvents.deleteDays,
      )!,
    },
    kmsAudit: {
      warmVolumeDays: parsePositiveIntegerOverride(
        env.KMS_AUDIT_WARM_TTL_DAYS,
        profile.kmsAudit.warmVolumeDays,
      ),
      deleteDays: parsePositiveIntegerOverride(
        env.KMS_AUDIT_DELETE_TTL_DAYS,
        profile.kmsAudit.deleteDays,
      )!,
    },
    archAudit: {
      deleteDays: parsePositiveIntegerOverride(
        env.ARCH_AUDIT_LOG_TTL_DAYS,
        profile.archAudit.deleteDays,
      )!,
    },
    omnichannelAudit: {
      deleteDays: parsePositiveIntegerOverride(
        env.OMNICHANNEL_AUDIT_LOG_TTL_DAYS,
        profile.omnichannelAudit.deleteDays,
      )!,
    },
  };
}

function buildAuditEventsTtlExpressions(
  config: ClickHouseAuditRetentionConfig,
  useTieredStorage: boolean,
): string[] {
  const expressions: string[] = [];

  if (useTieredStorage && config.auditEvents.coldVolumeDays !== null) {
    expressions.push(
      `timestamp + INTERVAL ${config.auditEvents.coldVolumeDays} DAY TO VOLUME 'cold'`,
    );
  }

  expressions.push(`timestamp + INTERVAL ${config.auditEvents.deleteDays} DAY DELETE`);
  return expressions;
}

function buildKmsAuditTtlExpressions(
  config: ClickHouseAuditRetentionConfig,
  useTieredStorage: boolean,
): string[] {
  const expressions: string[] = [];

  if (useTieredStorage && config.kmsAudit.warmVolumeDays !== null) {
    expressions.push(
      `toDateTime(timestamp) + INTERVAL ${config.kmsAudit.warmVolumeDays} DAY TO VOLUME 'warm'`,
    );
  }

  expressions.push(`toDateTime(timestamp) + INTERVAL ${config.kmsAudit.deleteDays} DAY DELETE`);
  return expressions;
}

function buildArchAuditTtlExpressions(config: ClickHouseAuditRetentionConfig): string[] {
  return [`toDateTime(timestamp) + INTERVAL ${config.archAudit.deleteDays} DAY DELETE`];
}

function buildPiiAuditTtlExpressions(): string[] {
  return ['toDateTime(expire_at) DELETE'];
}

function buildOmnichannelAuditTtlExpressions(config: ClickHouseAuditRetentionConfig): string[] {
  return [`toDateTime(timestamp) + INTERVAL ${config.omnichannelAudit.deleteDays} DAY DELETE`];
}

function buildAuditEventsTableDDL(
  config: ClickHouseAuditRetentionConfig,
  useTieredStorage: boolean,
): string {
  const ttlExpressions = buildAuditEventsTtlExpressions(config, useTieredStorage).join(',\n    ');

  return `
CREATE TABLE IF NOT EXISTS ${DATABASE}.audit_events
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

    _enc              String               DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_action   action        TYPE set(100)     GRANULARITY 4,
    INDEX idx_actor    actor_id      TYPE bloom_filter GRANULARITY 4,
    INDEX idx_session  session_id    TYPE bloom_filter GRANULARITY 4,
    INDEX idx_resource resource_type TYPE set(20)      GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.audit_events', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, timestamp, action)
TTL
    ${ttlExpressions}
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 86400
`;
}

function buildKmsAuditLogTableDDL(
  config: ClickHouseAuditRetentionConfig,
  useTieredStorage: boolean,
): string {
  const ttlExpressions = buildKmsAuditTtlExpressions(config, useTieredStorage).join(',\n    ');

  return `
CREATE TABLE IF NOT EXISTS ${DATABASE}.kms_audit_log
(
    tenant_id         String               CODEC(ZSTD(1)),
    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    event_id          String               CODEC(NONE),

    operation         LowCardinality(String) CODEC(ZSTD(1)),
    key_id            String               CODEC(ZSTD(1)),
    key_version       UInt32               CODEC(T64, ZSTD(1)),
    key_purpose       LowCardinality(String) CODEC(ZSTD(1)),

    provider_type     LowCardinality(String) CODEC(ZSTD(1)),

    project_id        String               DEFAULT '' CODEC(ZSTD(1)),
    environment       LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    epoch             String               DEFAULT '' CODEC(ZSTD(1)),

    actor_id          String               DEFAULT '' CODEC(ZSTD(1)),
    actor_type        LowCardinality(String) DEFAULT 'system' CODEC(ZSTD(1)),
    actor_ip          String               DEFAULT '' CODEC(ZSTD(1)),

    success           UInt8                DEFAULT 1 CODEC(T64, ZSTD(1)),
    error_message     String               DEFAULT '' CODEC(ZSTD(1)),
    latency_ms        UInt32               CODEC(T64, ZSTD(1)),

    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_operation operation  TYPE set(20)       GRANULARITY 4,
    INDEX idx_key_id    key_id     TYPE bloom_filter  GRANULARITY 4,
    INDEX idx_actor     actor_id   TYPE bloom_filter  GRANULARITY 4,
    INDEX idx_success   success    TYPE set(2)        GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.kms_audit_log', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, timestamp, operation)
TTL
    ${ttlExpressions}
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`;
}

function buildPiiAuditLogTableDDL(): string {
  return `
CREATE TABLE IF NOT EXISTS ${DATABASE}.pii_audit_log
(
    tenant_id         String               CODEC(ZSTD(1)),
    project_id        String               DEFAULT '' CODEC(ZSTD(1)),
    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    event_id          String               CODEC(NONE),

    session_id        String               DEFAULT '' CODEC(ZSTD(1)),
    token_id          String               CODEC(ZSTD(1)),
    pii_type          LowCardinality(String) CODEC(ZSTD(1)),
    consumer          LowCardinality(String) CODEC(ZSTD(1)),
    render_mode       LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    action            LowCardinality(String) CODEC(ZSTD(1)),
    trace_id          String               DEFAULT '' CODEC(ZSTD(1)),

    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),
    expire_at         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_session   session_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_token     token_id   TYPE bloom_filter GRANULARITY 4,
    INDEX idx_consumer  consumer   TYPE set(10)      GRANULARITY 4,
    INDEX idx_action    action     TYPE set(10)      GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.pii_audit_log', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, session_id, timestamp, token_id)
TTL
    toDateTime(expire_at) DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`;
}

function buildConnectorAuditLogTableDDL(): string {
  return `
CREATE TABLE IF NOT EXISTS ${DATABASE}.connector_audit_log
(
    tenant_id         String               CODEC(ZSTD(1)),
    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    event_id          String               CODEC(NONE),

    connector_id      String               CODEC(ZSTD(1)),
    actor             String               CODEC(ZSTD(1)),
    actor_type        LowCardinality(String) CODEC(ZSTD(1)),
    event             LowCardinality(String) CODEC(ZSTD(1)),
    category          LowCardinality(String) CODEC(ZSTD(1)),

    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_connector connector_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_actor     actor        TYPE bloom_filter GRANULARITY 4,
    INDEX idx_event     event        TYPE set(50)      GRANULARITY 4,
    INDEX idx_category  category     TYPE set(10)      GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.connector_audit_log', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, connector_id, timestamp, event)
SETTINGS
    index_granularity = 8192
`;
}

function buildCrawlAuditEventsTableDDL(): string {
  return `
CREATE TABLE IF NOT EXISTS ${DATABASE}.crawl_audit_events
(
    tenant_id         String               CODEC(ZSTD(1)),
    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    event_id          String               CODEC(NONE),

    crawl_job_id      String               CODEC(ZSTD(1)),
    user_id           String               DEFAULT '' CODEC(ZSTD(1)),
    event_type        LowCardinality(String) CODEC(ZSTD(1)),
    description       String               CODEC(ZSTD(1)),
    changes_before    String               DEFAULT '{}' CODEC(ZSTD(3)),
    changes_after     String               DEFAULT '{}' CODEC(ZSTD(3)),
    context           String               DEFAULT '{}' CODEC(ZSTD(3)),
    severity          LowCardinality(String) CODEC(ZSTD(1)),
    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_crawl_job  crawl_job_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_event_type event_type   TYPE set(50)      GRANULARITY 4,
    INDEX idx_user       user_id      TYPE bloom_filter GRANULARITY 4,
    INDEX idx_severity   severity     TYPE set(10)      GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.crawl_audit_events', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, crawl_job_id, timestamp, event_type)
SETTINGS
    index_granularity = 8192
`;
}

function buildArchAuditLogTableDDL(config: ClickHouseAuditRetentionConfig): string {
  const ttlExpressions = buildArchAuditTtlExpressions(config).join(',\n    ');

  return `
CREATE TABLE IF NOT EXISTS ${DATABASE}.arch_audit_log
(
    tenant_id         String               CODEC(ZSTD(1)),
    user_id           String               CODEC(ZSTD(1)),
    session_id        String               CODEC(ZSTD(1)),
    project_id        String               DEFAULT '' CODEC(ZSTD(1)),
    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    event_id          String               CODEC(NONE),

    category          LowCardinality(String) CODEC(ZSTD(1)),
    severity          LowCardinality(String) CODEC(ZSTD(1)),
    summary           String               CODEC(ZSTD(1)),
    detail            String               DEFAULT '{}' CODEC(ZSTD(3)),
    specialist        String               DEFAULT '' CODEC(ZSTD(1)),
    phase             String               DEFAULT '' CODEC(ZSTD(1)),
    duration_ms       UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    input_tokens      UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    output_tokens     UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    total_tokens      UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    estimated_cost    Float64              DEFAULT 0 CODEC(Gorilla, ZSTD(1)),
    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    turn_id           String               DEFAULT '' CODEC(ZSTD(1)),
    parent_event_id   String               DEFAULT '' CODEC(ZSTD(1)),
    phase_label       LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    retry_of          String               DEFAULT '' CODEC(ZSTD(1)),
    retry_index       UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    nesting_depth     UInt8                DEFAULT 255 CODEC(T64, ZSTD(1)),
    span_kind         LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_session   session_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_category  category   TYPE set(20)      GRANULARITY 4,
    INDEX idx_severity  severity   TYPE set(10)      GRANULARITY 4,
    INDEX idx_project   project_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_turn_id   turn_id    TYPE bloom_filter GRANULARITY 4,
    INDEX idx_span_kind span_kind  TYPE set(10)      GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.arch_audit_log', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, session_id, timestamp, category)
TTL
    ${ttlExpressions}
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`;
}

function buildArchAuditPayloadsTableDDL(config: ClickHouseAuditRetentionConfig): string {
  const retentionDays = config.archAudit.deleteDays;
  return `
CREATE TABLE IF NOT EXISTS ${DATABASE}.arch_audit_payloads
(
    tenant_id          String               CODEC(ZSTD(1)),
    session_id         String               CODEC(ZSTD(1)),
    event_id           String               CODEC(ZSTD(1)),
    timestamp          DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    payload_type       Enum8('prompt' = 1, 'response' = 2, 'tool_input' = 3, 'tool_output' = 4) CODEC(ZSTD(1)),
    content            String               CODEC(ZSTD(3)),
    content_size_bytes UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),

    INDEX idx_session session_id TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.arch_audit_payloads', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, session_id, event_id)
TTL
    toDateTime(timestamp) + INTERVAL ${retentionDays} DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`;
}

function buildOmnichannelAuditLogTableDDL(config: ClickHouseAuditRetentionConfig): string {
  const ttlExpressions = buildOmnichannelAuditTtlExpressions(config).join(',\n    ');
  return `
CREATE TABLE IF NOT EXISTS ${DATABASE}.omnichannel_audit_log
(
    tenant_id         String                 CODEC(ZSTD(1)),
    project_id        String                 DEFAULT '' CODEC(ZSTD(1)),
    session_id        String                 CODEC(ZSTD(1)),
    timestamp         DateTime64(3)          CODEC(DoubleDelta, ZSTD(1)),
    event_id          String                 CODEC(NONE),

    event_type        LowCardinality(String) CODEC(ZSTD(1)),
    description       String                 CODEC(ZSTD(1)),
    data              String                 DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_session   session_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_event     event_type TYPE set(20)      GRANULARITY 4,
    INDEX idx_project   project_id TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.omnichannel_audit_log', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, project_id, session_id, timestamp, event_type)
TTL
    ${ttlExpressions}
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`;
}

export const PLATFORM_EVENTS_VOICE_HOURLY_DEST_DDL = `
CREATE TABLE IF NOT EXISTS ${DATABASE}.platform_events_voice_hourly_dest
(
    tenant_id                String,
    project_id               String,
    hour                     DateTime,

    session_count            SimpleAggregateFunction(sum, UInt64),
    error_count              SimpleAggregateFunction(sum, UInt64),
    sum_call_duration_ms     SimpleAggregateFunction(sum, UInt64),

    -- Homer QoS Metrics (sum + count for avg calculation)
    sum_inbound_mos          SimpleAggregateFunction(sum, Float64),
    sum_outbound_mos         SimpleAggregateFunction(sum, Float64),
    sum_inbound_jitter_ms    SimpleAggregateFunction(sum, Float64),
    sum_outbound_jitter_ms   SimpleAggregateFunction(sum, Float64),
    sum_inbound_packet_loss  SimpleAggregateFunction(sum, Float64),
    sum_outbound_packet_loss SimpleAggregateFunction(sum, Float64),
    mos_sample_count         SimpleAggregateFunction(sum, UInt64),

    -- Voice Quality Metrics (sum + count for avg calculation)
    sum_e2e_latency_ms       SimpleAggregateFunction(sum, Float64),
    sum_barge_in_rate        SimpleAggregateFunction(sum, Float64),
    sum_dtmf_fallback_rate   SimpleAggregateFunction(sum, Float64),
    sum_asr_score            SimpleAggregateFunction(sum, Float64),
    sum_tts_proxy_mos        SimpleAggregateFunction(sum, Float64),
    sum_silence_percent      SimpleAggregateFunction(sum, Float64),
    metric_sample_count      SimpleAggregateFunction(sum, UInt64),

    -- Aggregate Counts
    total_turns              SimpleAggregateFunction(sum, UInt64),
    total_barge_in_count     SimpleAggregateFunction(sum, UInt64),
    total_dtmf_turn_count    SimpleAggregateFunction(sum, UInt64)
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.platform_events_voice_hourly_dest', '{replica}')
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, project_id, hour)
TTL hour + INTERVAL 1095 DAY DELETE
SETTINGS index_granularity = 8192
`;

export const PLATFORM_EVENTS_VOICE_HOURLY_SELECT = `
SELECT
    tenant_id,
    project_id,
    toStartOfHour(timestamp) AS hour,

    sumSimpleState(toUInt64(if(event_type = 'voice.session.ended', 1, 0))) AS session_count,
    sumSimpleState(toUInt64(if(has_error = 1, 1, 0))) AS error_count,
    sumSimpleState(toUInt64(if(event_type = 'voice.session.ended', duration_ms, 0))) AS sum_call_duration_ms,

    -- Homer QoS Metrics (sum for averaging at query time)
    -- Support both camelCase (new) and snake_case (old) field names
    sumSimpleState(toFloat64(if(JSONHas(data, 'inboundNetworkMos'), JSONExtractFloat(data, 'inboundNetworkMos'), JSONExtractFloat(data, 'inbound_network_mos')))) AS sum_inbound_mos,
    sumSimpleState(toFloat64(if(JSONHas(data, 'outboundNetworkMos'), JSONExtractFloat(data, 'outboundNetworkMos'), JSONExtractFloat(data, 'outbound_network_mos')))) AS sum_outbound_mos,
    sumSimpleState(toFloat64(if(JSONHas(data, 'inboundJitterMs'), JSONExtractFloat(data, 'inboundJitterMs'), JSONExtractFloat(data, 'inbound_jitter_ms')))) AS sum_inbound_jitter_ms,
    sumSimpleState(toFloat64(if(JSONHas(data, 'outboundJitterMs'), JSONExtractFloat(data, 'outboundJitterMs'), JSONExtractFloat(data, 'outbound_jitter_ms')))) AS sum_outbound_jitter_ms,
    sumSimpleState(toFloat64(if(JSONHas(data, 'inboundPacketLoss'), JSONExtractFloat(data, 'inboundPacketLoss'), JSONExtractFloat(data, 'inbound_packet_loss')))) AS sum_inbound_packet_loss,
    sumSimpleState(toFloat64(if(JSONHas(data, 'outboundPacketLoss'), JSONExtractFloat(data, 'outboundPacketLoss'), JSONExtractFloat(data, 'outbound_packet_loss')))) AS sum_outbound_packet_loss,
    sumSimpleState(toUInt64(if(event_type = 'voice.session.ended' AND (JSONHas(data, 'homerAvailable') OR JSONHas(data, 'homer_available')), 1, 0))) AS mos_sample_count,

    -- Voice Quality Metrics (sum for averaging at query time)
    sumSimpleState(toFloat64(if(JSONHas(data, 'avgE2eLatencyMs'), JSONExtractFloat(data, 'avgE2eLatencyMs'), JSONExtractFloat(data, 'avg_e2e_latency_ms')))) AS sum_e2e_latency_ms,
    sumSimpleState(toFloat64(if(JSONHas(data, 'bargeInRate'), JSONExtractFloat(data, 'bargeInRate'), JSONExtractFloat(data, 'barge_in_rate')))) AS sum_barge_in_rate,
    sumSimpleState(toFloat64(if(JSONHas(data, 'dtmfFallbackRate'), JSONExtractFloat(data, 'dtmfFallbackRate'), JSONExtractFloat(data, 'dtmf_fallback_rate')))) AS sum_dtmf_fallback_rate,
    sumSimpleState(toFloat64(if(JSONHas(data, 'overallAsrScore'), JSONExtractFloat(data, 'overallAsrScore'), JSONExtractFloat(data, 'overall_asr_score')))) AS sum_asr_score,
    sumSimpleState(toFloat64(if(JSONHas(data, 'avgTtsProxyMos'), JSONExtractFloat(data, 'avgTtsProxyMos'), JSONExtractFloat(data, 'avg_tts_proxy_mos')))) AS sum_tts_proxy_mos,
    sumSimpleState(toFloat64(if(JSONHas(data, 'silencePercent'), JSONExtractFloat(data, 'silencePercent'), JSONExtractFloat(data, 'silence_percent')))) AS sum_silence_percent,
    sumSimpleState(toUInt64(if(event_type = 'voice.session.ended', 1, 0))) AS metric_sample_count,

    -- Aggregate Counts
    sumSimpleState(toUInt64(if(JSONHas(data, 'totalTurns'), JSONExtractUInt(data, 'totalTurns'), JSONExtractUInt(data, 'total_turns')))) AS total_turns,
    sumSimpleState(toUInt64(if(JSONHas(data, 'bargeInCount'), JSONExtractUInt(data, 'bargeInCount'), JSONExtractUInt(data, 'barge_in_count')))) AS total_barge_in_count,
    sumSimpleState(toUInt64(if(JSONHas(data, 'dtmfTurnCount'), JSONExtractUInt(data, 'dtmfTurnCount'), JSONExtractUInt(data, 'dtmf_turn_count')))) AS total_dtmf_turn_count

FROM ${DATABASE}.platform_events
WHERE category = 'voice' AND event_type = 'voice.session.ended'
GROUP BY tenant_id, project_id, hour
`;

export const PLATFORM_EVENTS_VOICE_HOURLY_MV_DDL = `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.platform_events_voice_hourly
TO ${DATABASE}.platform_events_voice_hourly_dest
AS ${PLATFORM_EVENTS_VOICE_HOURLY_SELECT}
`;

// =============================================================================
// TABLE DDL DEFINITIONS
// =============================================================================

const TABLES: { name: string; ddl: string }[] = [
  {
    name: 'messages',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.messages
(
    tenant_id         String               CODEC(ZSTD(1)),
    session_id        String               CODEC(ZSTD(1)),
    created_at        DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    message_id        String               CODEC(NONE),
    contact_id        String               DEFAULT '' CODEC(ZSTD(1)),

    role              LowCardinality(String) CODEC(ZSTD(1)),
    channel           LowCardinality(String) CODEC(ZSTD(1)),
    agent_name        LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    content           String               CODEC(NONE),
    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    encrypted         UInt8                DEFAULT 1 CODEC(T64, ZSTD(1)),
    key_version       UInt16               DEFAULT 1 CODEC(T64, ZSTD(1)),

    has_pii           UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    scrubbed          UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),

    trace_id          String               DEFAULT '' CODEC(ZSTD(1)),

    _enc              String               DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_contact contact_id       TYPE bloom_filter GRANULARITY 4,
    INDEX idx_pii     (has_pii, scrubbed) TYPE set(4)   GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.messages', '{replica}')
PARTITION BY toYYYYMMDD(created_at)
ORDER BY (tenant_id, session_id, created_at)
-- PII scrubbing (SET content='[PII_EXPIRED]' after 14 days) is handled by
-- the retention-scheduler job, not TTL SET rules (ClickHouse TTL SET does
-- not support if() expressions with commas).
TTL
    toDateTime(created_at) + INTERVAL 30 DAY TO VOLUME 'warm',
    toDateTime(created_at) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(created_at) + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`,
  },
  {
    name: 'llm_metrics',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.llm_metrics
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
    known_source      LowCardinality(String) DEFAULT 'production' CODEC(ZSTD(1)),

    INDEX idx_session   session_id     TYPE bloom_filter GRANULARITY 4,
    INDEX idx_operation operation_type TYPE set(10)      GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.llm_metrics', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, toStartOfHour(timestamp), model_id, provider)
TTL
    toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 365 DAY TO VOLUME 'cold',
    toDateTime(timestamp) + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`,
  },
  {
    name: 'llm_metrics_hourly_dest',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.llm_metrics_hourly_dest
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
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.llm_metrics_hourly_dest', '{replica}')
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, project_id, model_id, provider, agent_name, hour)
TTL hour + INTERVAL 1095 DAY DELETE
SETTINGS index_granularity = 8192
`,
  },
  {
    name: 'llm_metrics_daily_dest',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.llm_metrics_daily_dest
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
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.llm_metrics_daily_dest', '{replica}')
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, project_id, model_id, provider, day)
TTL day + INTERVAL 1095 DAY DELETE
SETTINGS index_granularity = 8192
`,
  },
  {
    name: 'logs',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.logs
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
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.logs', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, timestamp, service, level)
TTL
    timestamp + INTERVAL 3 DAY TO VOLUME 'warm',
    timestamp + INTERVAL 14 DAY TO VOLUME 'cold',
    timestamp + INTERVAL 30 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`,
  },
  {
    name: 'facts',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.facts
(
    id                String               CODEC(NONE),
    key               String               CODEC(ZSTD(1)),
    value             String               CODEC(ZSTD(3)),
    created_at        DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    updated_at        DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    expires_at        Nullable(DateTime64(3)) CODEC(ZSTD(1)),
    source_type       LowCardinality(String) DEFAULT 'system' CODEC(ZSTD(1)),
    source_agent_name String               DEFAULT '' CODEC(ZSTD(1)),
    source_session_id String               DEFAULT '' CODEC(ZSTD(1)),
    source_trace_id   String               DEFAULT '' CODEC(ZSTD(1)),
    metadata          String               DEFAULT '{}' CODEC(ZSTD(3)),

    INDEX idx_expires   expires_at   TYPE minmax GRANULARITY 4,
    INDEX idx_source    source_type  TYPE set(10) GRANULARITY 4
)
ENGINE = ReplacingMergeTree(updated_at)
ORDER BY (key)
SETTINGS
    index_granularity = 8192
`,
  },
  {
    name: 'audit_events',
    ddl: '',
  },
  {
    name: 'pii_audit_log',
    ddl: '',
  },
  {
    name: 'connector_audit_log',
    ddl: '',
  },
  {
    name: 'crawl_audit_events',
    ddl: '',
  },
  {
    name: 'arch_audit_log',
    ddl: '',
  },
  {
    name: 'arch_audit_payloads',
    ddl: '',
  },
  {
    name: 'omnichannel_audit_log',
    ddl: '',
  },
  {
    name: 'platform_events',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.platform_events
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

    _enc              String               DEFAULT '' CODEC(ZSTD(1)),

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
`,
  },
  {
    name: 'search_queries',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.search_queries
(
    tenant_id             String               CODEC(ZSTD(1)),
    timestamp             DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    query_id              String               CODEC(NONE),
    index_id              String               CODEC(ZSTD(1)),
    project_id            String               CODEC(ZSTD(1)),
    session_id            String               DEFAULT '' CODEC(ZSTD(1)),
    user_id               String               DEFAULT '' CODEC(ZSTD(1)),

    query_text            String               CODEC(NONE),
    query_type            LowCardinality(String) CODEC(ZSTD(1)),
    filters               String               DEFAULT '' CODEC(ZSTD(3)),
    vocabulary_terms      String               DEFAULT '' CODEC(ZSTD(3)),

    result_count          UInt32               CODEC(T64, ZSTD(1)),
    top_k                 UInt16               CODEC(T64, ZSTD(1)),
    vocabulary_resolve_ms UInt32               CODEC(T64, ZSTD(1)),
    vector_search_ms      UInt32               CODEC(T64, ZSTD(1)),
    structured_filter_ms  UInt32               CODEC(T64, ZSTD(1)),
    rerank_ms             UInt32               CODEC(T64, ZSTD(1)),
    total_latency_ms      UInt32               CODEC(T64, ZSTD(1)),
    cache_hit             UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),

    results_json          String               DEFAULT '' CODEC(NONE),
    feedback_score        Float32              DEFAULT 0 CODEC(Gorilla, ZSTD(1)),
    click_position        Int16                DEFAULT -1 CODEC(T64, ZSTD(1)),

    encrypted             UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    key_version           UInt8                DEFAULT 1 CODEC(T64, ZSTD(1)),

    INDEX idx_session   session_id   TYPE bloom_filter GRANULARITY 4,
    INDEX idx_user      user_id      TYPE bloom_filter GRANULARITY 4,
    INDEX idx_type      query_type   TYPE set(10)      GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.search_queries', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, index_id, timestamp)
TTL
    toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 365 DAY TO VOLUME 'cold',
    toDateTime(timestamp) + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`,
  },
  {
    name: 'search_ingestion_events',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.search_ingestion_events
(
    tenant_id             String               CODEC(ZSTD(1)),
    timestamp             DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    event_id              String               CODEC(NONE),
    index_id              String               CODEC(ZSTD(1)),
    source_id             String               CODEC(ZSTD(1)),
    document_id           String               DEFAULT '' CODEC(ZSTD(1)),

    stage                 LowCardinality(String) CODEC(ZSTD(1)),
    status                LowCardinality(String) CODEC(ZSTD(1)),

    duration_ms           UInt32               CODEC(T64, ZSTD(1)),
    chunk_count           UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    token_count           UInt32               DEFAULT 0 CODEC(T64, ZSTD(1)),
    embedding_cost        Float64              DEFAULT 0 CODEC(Gorilla, ZSTD(1)),
    fields_mapped         UInt16               DEFAULT 0 CODEC(T64, ZSTD(1)),

    has_error             UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    error_message         String               DEFAULT '' CODEC(ZSTD(1)),
    retry_count           UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),

    content_type          LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    content_size_bytes    UInt64               DEFAULT 0 CODEC(T64, ZSTD(1)),

    INDEX idx_stage     stage      TYPE set(10)      GRANULARITY 4,
    INDEX idx_status    status     TYPE set(5)       GRANULARITY 4,
    INDEX idx_error     has_error  TYPE set(2)       GRANULARITY 4,
    INDEX idx_document  document_id TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.search_ingestion_events', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, index_id, source_id, timestamp)
TTL
    toDateTime(timestamp) + INTERVAL 30 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'cold',
    toDateTime(timestamp) + INTERVAL 365 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`,
  },
  {
    name: 'dead_letter_events',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.dead_letter_events
(
    event_id       UUID                   CODEC(NONE),
    event_type     LowCardinality(String) CODEC(ZSTD(1)),
    tenant_id      String                 CODEC(ZSTD(1)),
    session_id     String                 CODEC(ZSTD(1)),
    payload        String                 CODEC(ZSTD(3)),
    error_message  String                 CODEC(ZSTD(1)),
    retry_count    UInt8                  CODEC(T64, ZSTD(1)),
    failed_at      DateTime64(3, 'UTC')   CODEC(DoubleDelta, ZSTD(1)),
    replayed       Bool                   DEFAULT 0 CODEC(T64, ZSTD(1))
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.dead_letter_events', '{replica}')
ORDER BY (tenant_id, failed_at, event_type)
TTL toDateTime(failed_at) + INTERVAL 30 DAY DELETE
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 86400
`,
  },
  {
    name: 'platform_events_agent_hourly_dest',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.platform_events_agent_hourly_dest
(
    tenant_id           String,
    project_id          String,
    agent_name          String,
    hour                DateTime,

    invocation_count    SimpleAggregateFunction(sum, UInt64),
    exit_count          SimpleAggregateFunction(sum, UInt64),
    error_count         SimpleAggregateFunction(sum, UInt64),
    escalation_count    SimpleAggregateFunction(sum, UInt64),
    handoff_count       SimpleAggregateFunction(sum, UInt64),
    tool_call_count     SimpleAggregateFunction(sum, UInt64),
    tool_error_count    SimpleAggregateFunction(sum, UInt64),
    sum_duration_ms     SimpleAggregateFunction(sum, UInt64),
    max_duration_ms     SimpleAggregateFunction(max, UInt32),
    min_duration_ms     SimpleAggregateFunction(min, UInt32)
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.platform_events_agent_hourly_dest', '{replica}')
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, project_id, agent_name, hour)
TTL hour + INTERVAL 1095 DAY DELETE
SETTINGS index_granularity = 8192
`,
  },
  {
    name: 'platform_events_tool_daily_dest',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.platform_events_tool_daily_dest
(
    tenant_id           String,
    project_id          String,
    tool_name           String,
    day                 Date,

    call_count          SimpleAggregateFunction(sum, UInt64),
    success_count       SimpleAggregateFunction(sum, UInt64),
    error_count         SimpleAggregateFunction(sum, UInt64),
    retry_count         SimpleAggregateFunction(sum, UInt64),
    sum_latency_ms      SimpleAggregateFunction(sum, UInt64),
    max_latency_ms      SimpleAggregateFunction(max, UInt32),
    min_latency_ms      SimpleAggregateFunction(min, UInt32)
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.platform_events_tool_daily_dest', '{replica}')
PARTITION BY toYYYYMM(day)
ORDER BY (tenant_id, project_id, tool_name, day)
TTL day + INTERVAL 1095 DAY DELETE
SETTINGS index_granularity = 8192
`,
  },
  {
    name: 'platform_events_error_hourly_dest',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.platform_events_error_hourly_dest
(
    tenant_id           String,
    project_id          String,
    event_type          LowCardinality(String),
    error_type          String,
    hour                DateTime,

    error_count         SimpleAggregateFunction(sum, UInt64),
    total_count         SimpleAggregateFunction(sum, UInt64)
)
ENGINE = ReplicatedAggregatingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.platform_events_error_hourly_dest', '{replica}')
PARTITION BY toYYYYMM(hour)
ORDER BY (tenant_id, project_id, event_type, error_type, hour)
TTL hour + INTERVAL 1095 DAY DELETE
SETTINGS index_granularity = 8192
`,
  },
  {
    name: 'platform_events_voice_hourly_dest',
    ddl: PLATFORM_EVENTS_VOICE_HOURLY_DEST_DDL,
  },
  {
    name: 'kms_audit_log',
    ddl: '',
  },
  {
    name: 'spatial_trace_records',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.spatial_trace_records
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
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.spatial_trace_records', '{replica}')
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
    merge_with_ttl_timeout = 86400
`,
  },
  {
    name: 'insight_results',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.insight_results
(
    tenant_id        String                 CODEC(ZSTD(1)),
    project_id       String                 CODEC(ZSTD(1)),
    insight_type     LowCardinality(String) CODEC(ZSTD(1)),

    granularity      Enum8(
                       'message' = 1,
                       'span' = 2,
                       'session' = 3,
                       'agent' = 4,
                       'project' = 5
                     ),

    session_id       Nullable(String)       CODEC(ZSTD(1)),
    message_id       Nullable(String)       CODEC(ZSTD(1)),
    span_id          Nullable(String)       CODEC(ZSTD(1)),
    agent_name       Nullable(String)       CODEC(ZSTD(1)),

    score            Float64                CODEC(Gorilla, ZSTD(1)),
    status           Enum8('pass' = 1, 'warn' = 2, 'fail' = 3),

    dimensions       String                 DEFAULT '{}' CODEC(ZSTD(3)),

    pipeline_id      String                 CODEC(ZSTD(1)),
    run_id           String                 CODEC(ZSTD(1)),

    evaluated_at     DateTime64(3, 'UTC')   CODEC(DoubleDelta, ZSTD(1)),
    event_timestamp  DateTime64(3, 'UTC')   CODEC(DoubleDelta, ZSTD(1)),
    expires_at       DateTime64(3, 'UTC')   CODEC(DoubleDelta, ZSTD(1)),

    _enc             String                 DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_insight_type insight_type TYPE set(100)      GRANULARITY 4,
    INDEX idx_session_id   session_id   TYPE bloom_filter  GRANULARITY 4,
    INDEX idx_status        status       TYPE set(3)        GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.insight_results', '{replica}')
PARTITION BY (tenant_id, toYYYYMM(evaluated_at))
ORDER BY (tenant_id, project_id, insight_type, granularity, evaluated_at)
TTL toDateTime(expires_at) DELETE
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 86400
`,
  },
  {
    name: 'custom_pipeline_results',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.custom_pipeline_results
(
    tenant_id          String                 CODEC(ZSTD(1)),
    project_id         String                 CODEC(ZSTD(1)),
    pipeline_id        String                 CODEC(ZSTD(1)),
    pipeline_name      LowCardinality(String) CODEC(ZSTD(1)),
    pipeline_kind      LowCardinality(String) DEFAULT 'custom' CODEC(ZSTD(1)),
    run_id             String                 CODEC(ZSTD(1)),
    session_id         String                 DEFAULT '' CODEC(ZSTD(1)),

    store_step_id      String                 DEFAULT '' CODEC(ZSTD(1)),
    source_step_id     String                 DEFAULT '' CODEC(ZSTD(1)),
    source_step_status LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    trigger_id         String                 DEFAULT '' CODEC(ZSTD(1)),
    execution_mode     LowCardinality(String) DEFAULT 'batch' CODEC(ZSTD(1)),
    source             LowCardinality(String) DEFAULT 'batch' CODEC(ZSTD(1)),

    score_name         LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    score_path         String                 DEFAULT '' CODEC(ZSTD(1)),
    score_value        Nullable(Float64)      CODEC(Gorilla, ZSTD(1)),
    output_json        String                 CODEC(ZSTD(3)),
    created_at         DateTime64(3, 'UTC')   CODEC(DoubleDelta, ZSTD(1)),

    _enc               String                 DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_pipeline_id   pipeline_id   TYPE bloom_filter GRANULARITY 4,
    INDEX idx_pipeline_name pipeline_name TYPE set(1000)     GRANULARITY 4,
    INDEX idx_score_name    score_name    TYPE set(1000)     GRANULARITY 4,
    INDEX idx_run_id        run_id        TYPE bloom_filter GRANULARITY 4,
    INDEX idx_session_id    session_id    TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.custom_pipeline_results', '{replica}')
PARTITION BY (tenant_id, toYYYYMM(created_at))
ORDER BY (tenant_id, project_id, pipeline_name, created_at, run_id)
TTL toDateTime(created_at) + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    merge_with_ttl_timeout = 86400
`,
  },
  {
    name: 'platform_events_by_session',
    ddl: `
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
`,
  },
  {
    name: 'entity_instances',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.entity_instances
(
    tenant_id        String               CODEC(ZSTD(1)),
    index_id         String               CODEC(ZSTD(1)),
    document_id      String               CODEC(ZSTD(1)),
    chunk_id         String               DEFAULT '' CODEC(ZSTD(1)),

    attribute_type   LowCardinality(String) CODEC(ZSTD(1)),
    product_type     LowCardinality(String) CODEC(ZSTD(1)),
    data_type        LowCardinality(String) CODEC(ZSTD(1)),

    raw_value        String               CODEC(ZSTD(1)),
    normalized_value String               CODEC(ZSTD(1)),

    enriched_at      DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),
    taxonomy_version String               DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_doc    document_id          TYPE bloom_filter GRANULARITY 4,
    INDEX idx_attr   attribute_type       TYPE set(0)       GRANULARITY 4
)
ENGINE = ReplicatedReplacingMergeTree('/clickhouse/tables/{shard}/${DATABASE}.entity_instances', '{replica}')
ORDER BY (tenant_id, index_id, product_type, attribute_type, document_id, chunk_id)
SETTINGS index_granularity = 8192
`,
  },
  {
    name: 'facet_interactions',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.facet_interactions
(
    tenant_id        String               CODEC(ZSTD(1)),
    index_id         String               CODEC(ZSTD(1)),
    user_id          String               CODEC(ZSTD(1)),
    session_id       String               CODEC(ZSTD(1)),

    attribute_type   LowCardinality(String) CODEC(ZSTD(1)),
    product_type     LowCardinality(String) CODEC(ZSTD(1)),
    facet_value      String               CODEC(ZSTD(1)),
    category_id      LowCardinality(String) CODEC(ZSTD(1)),

    interaction_type LowCardinality(String) CODEC(ZSTD(1)),
    created_at       DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    INDEX idx_user   user_id              TYPE bloom_filter GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.facet_interactions', '{replica}')
ORDER BY (tenant_id, index_id, attribute_type, product_type, created_at)
TTL toDateTime(created_at) + INTERVAL 730 DAY DELETE
SETTINGS index_granularity = 8192
`,
  },
  {
    name: 'feedback',
    ddl: `
CREATE TABLE IF NOT EXISTS ${DATABASE}.feedback
(
    tenant_id         String               CODEC(ZSTD(1)),
    project_id        String               CODEC(ZSTD(1)),
    feedback_id       String               CODEC(ZSTD(1)),
    timestamp         DateTime64(3)        CODEC(DoubleDelta, ZSTD(1)),

    session_id        String               CODEC(ZSTD(1)),
    message_id        String               CODEC(ZSTD(1)),
    agent_name        LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    user_id           String               DEFAULT '' CODEC(ZSTD(1)),
    channel           LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    rating_type       LowCardinality(String) CODEC(ZSTD(1)),
    rating_value      Float32              CODEC(Gorilla, ZSTD(1)),
    feedback_text     String               DEFAULT '' CODEC(ZSTD(3)),

    has_pii           UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    encrypted         UInt8                DEFAULT 0 CODEC(T64, ZSTD(1)),
    key_version       UInt16               DEFAULT 1 CODEC(T64, ZSTD(1)),

    source            LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),
    ingress_type      LowCardinality(String) DEFAULT '' CODEC(ZSTD(1)),

    _enc              String               DEFAULT '' CODEC(ZSTD(1)),

    INDEX idx_session session_id TYPE bloom_filter GRANULARITY 4,
    INDEX idx_user    user_id    TYPE bloom_filter GRANULARITY 4,
    INDEX idx_agent   agent_name TYPE set(100)     GRANULARITY 4,
    INDEX idx_pii     has_pii    TYPE set(2)       GRANULARITY 4
)
ENGINE = ReplicatedMergeTree('/clickhouse/tables/{shard}/${DATABASE}.feedback', '{replica}')
PARTITION BY toYYYYMM(timestamp)
ORDER BY (tenant_id, project_id, timestamp, session_id)
TTL
    toDateTime(timestamp) + INTERVAL 90 DAY TO VOLUME 'warm',
    toDateTime(timestamp) + INTERVAL 365 DAY TO VOLUME 'cold',
    toDateTime(timestamp) + INTERVAL 730 DAY DELETE
SETTINGS
    index_granularity = 8192,
    ttl_only_drop_parts = 1,
    merge_with_ttl_timeout = 86400
`,
  },
];

// Materialized views (must be created after their source tables)
const MATERIALIZED_VIEWS: { name: string; ddl: string }[] = [
  {
    name: 'llm_metrics_hourly',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.llm_metrics_hourly
TO ${DATABASE}.llm_metrics_hourly_dest
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
FROM ${DATABASE}.llm_metrics
GROUP BY tenant_id, project_id, model_id, provider, agent_name, hour
`,
  },
  {
    name: 'llm_metrics_daily',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.llm_metrics_daily
TO ${DATABASE}.llm_metrics_daily_dest
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
FROM ${DATABASE}.llm_metrics
GROUP BY tenant_id, project_id, model_id, provider, day
`,
  },
  {
    name: 'platform_events_agent_hourly',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.platform_events_agent_hourly
TO ${DATABASE}.platform_events_agent_hourly_dest
AS SELECT
    tenant_id, project_id, agent_name,
    toStartOfHour(timestamp) AS hour,
    sumSimpleState(toUInt64(if(event_type = 'agent.entered', 1, 0)))   AS invocation_count,
    sumSimpleState(toUInt64(if(event_type = 'agent.exited', 1, 0)))    AS exit_count,
    sumSimpleState(toUInt64(if(has_error = 1, 1, 0)))                  AS error_count,
    sumSimpleState(toUInt64(if(event_type = 'agent.escalated', 1, 0))) AS escalation_count,
    sumSimpleState(toUInt64(if(event_type = 'agent.handoff', 1, 0)))   AS handoff_count,
    sumSimpleState(toUInt64(if(event_type IN ('tool.call.completed', 'tool.call.failed'), 1, 0))) AS tool_call_count,
    sumSimpleState(toUInt64(if(event_type = 'tool.call.failed', 1, 0))) AS tool_error_count,
    sumSimpleState(toUInt64(duration_ms))                               AS sum_duration_ms,
    maxSimpleState(duration_ms)                                         AS max_duration_ms,
    minSimpleState(duration_ms)                                         AS min_duration_ms
FROM ${DATABASE}.platform_events
WHERE agent_name != ''
GROUP BY tenant_id, project_id, agent_name, hour
`,
  },
  {
    name: 'platform_events_tool_daily',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.platform_events_tool_daily
TO ${DATABASE}.platform_events_tool_daily_dest
AS SELECT
    tenant_id, project_id,
    JSONExtractString(data, 'tool_name') AS tool_name,
    toDate(timestamp) AS day,
    sumSimpleState(toUInt64(1))                                        AS call_count,
    sumSimpleState(toUInt64(if(event_type = 'tool.call.completed' AND has_error = 0, 1, 0))) AS success_count,
    sumSimpleState(toUInt64(if(has_error = 1, 1, 0)))                  AS error_count,
    sumSimpleState(toUInt64(if(event_type = 'tool.call.retried', 1, 0))) AS retry_count,
    sumSimpleState(toUInt64(duration_ms))                               AS sum_latency_ms,
    maxSimpleState(duration_ms)                                         AS max_latency_ms,
    minSimpleState(duration_ms)                                         AS min_latency_ms
FROM ${DATABASE}.platform_events
WHERE event_type IN ('tool.call.completed', 'tool.call.failed', 'tool.call.retried')
GROUP BY tenant_id, project_id, tool_name, day
`,
  },
  {
    name: 'platform_events_error_hourly',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.platform_events_error_hourly
TO ${DATABASE}.platform_events_error_hourly_dest
AS SELECT
    tenant_id, project_id, event_type,
    JSONExtractString(data, 'error_type') AS error_type,
    toStartOfHour(timestamp) AS hour,
    sumSimpleState(toUInt64(1))            AS error_count,
    sumSimpleState(toUInt64(1))            AS total_count
FROM ${DATABASE}.platform_events
WHERE has_error = 1
GROUP BY tenant_id, project_id, event_type, error_type, hour
`,
  },
  {
    name: 'platform_events_voice_hourly',
    ddl: PLATFORM_EVENTS_VOICE_HOURLY_MV_DDL,
  },
  {
    name: 'platform_events_by_session_mv',
    ddl: `
CREATE MATERIALIZED VIEW IF NOT EXISTS ${DATABASE}.platform_events_by_session_mv
TO ${DATABASE}.platform_events_by_session
AS SELECT
    tenant_id, project_id, event_id, event_type, category, timestamp,
    session_id, trace_id, span_id, parent_span_id,
    turn_id, execution_id, parent_execution_id, agent_run_id,
    decision_id, parent_decision_id, cause_event_id, phase, reason_code,
    agent_name,
    deployment_id, known_source, environment, channel, actor_id, actor_type,
    duration_ms, has_error, error_message, error_type,
    data, metadata, custom_dimensions, _enc
FROM ${DATABASE}.platform_events
WHERE session_id != ''
`,
  },
];

// =============================================================================
// INITIALIZATION
// =============================================================================

export async function initClickHouseSchema(client: ClickHouseClient): Promise<void> {
  // Resolve transform options before defining runSchemaCommand
  // so the closure can capture the cluster value for ON CLUSTER injection.
  const transformOptions = resolveDDLTransformOptions();
  const cluster = transformOptions.useReplicated ? await detectClusterName(client) : undefined;
  const db = resolveClickHouseDatabaseName();

  const runSchemaCommand = async (operation: string, query: string): Promise<void> => {
    let finalQuery = query;
    if (cluster) {
      finalQuery = injectOnClusterForStatement(query, cluster);
    }
    try {
      await client.command({ query: finalQuery });
    } catch (error) {
      throw new Error(
        `ClickHouse schema command failed (${operation}): ${getErrorMessage(
          error,
        )}; statement="${getStatementPreview(finalQuery)}"`,
      );
    }
  };

  // Create database
  await runSchemaCommand('create-database', `CREATE DATABASE IF NOT EXISTS ${db}`);
  console.log(`[CH Schema] Database '${db}' ready`);

  const auditRetention = resolveClickHouseAuditRetentionConfig(process.env);
  const tables = TABLES.map((table) => {
    if (table.name === 'audit_events') {
      return {
        ...table,
        ddl: buildAuditEventsTableDDL(auditRetention, transformOptions.useTieredStorage),
      };
    }
    if (table.name === 'pii_audit_log') {
      return {
        ...table,
        ddl: buildPiiAuditLogTableDDL(),
      };
    }
    if (table.name === 'connector_audit_log') {
      return {
        ...table,
        ddl: buildConnectorAuditLogTableDDL(),
      };
    }
    if (table.name === 'crawl_audit_events') {
      return {
        ...table,
        ddl: buildCrawlAuditEventsTableDDL(),
      };
    }
    if (table.name === 'arch_audit_log') {
      return {
        ...table,
        ddl: buildArchAuditLogTableDDL(auditRetention),
      };
    }
    if (table.name === 'arch_audit_payloads') {
      return {
        ...table,
        ddl: buildArchAuditPayloadsTableDDL(auditRetention),
      };
    }
    if (table.name === 'omnichannel_audit_log') {
      return {
        ...table,
        ddl: buildOmnichannelAuditLogTableDDL(auditRetention),
      };
    }
    if (table.name === 'kms_audit_log') {
      return {
        ...table,
        ddl: buildKmsAuditLogTableDDL(auditRetention, transformOptions.useTieredStorage),
      };
    }
    return table;
  });

  // Create tables (order matters: dest tables before materialized views)
  for (const table of tables) {
    const ddl = transformDDL(table.ddl, transformOptions);
    await runSchemaCommand(`create-table:${table.name}`, ddl);
  }
  console.log(`[CH Schema] ${tables.length} core tables created/verified`);

  const auditEventsTtlQuery = `ALTER TABLE ${db}.audit_events MODIFY TTL ${buildAuditEventsTtlExpressions(
    auditRetention,
    transformOptions.useTieredStorage,
  ).join(', ')}`;
  await runSchemaCommand('alter-ttl:audit_events', auditEventsTtlQuery);

  const kmsAuditTtlQuery = `ALTER TABLE ${db}.kms_audit_log MODIFY TTL ${buildKmsAuditTtlExpressions(
    auditRetention,
    transformOptions.useTieredStorage,
  ).join(', ')}`;
  await runSchemaCommand('alter-ttl:kms_audit_log', kmsAuditTtlQuery);

  const piiAuditTtlQuery = `ALTER TABLE ${db}.pii_audit_log MODIFY TTL ${buildPiiAuditTtlExpressions().join(
    ', ',
  )}`;
  await runSchemaCommand('alter-ttl:pii_audit_log', piiAuditTtlQuery);

  const archAuditTtlQuery = `ALTER TABLE ${db}.arch_audit_log MODIFY TTL ${buildArchAuditTtlExpressions(
    auditRetention,
  ).join(', ')}`;
  await runSchemaCommand('alter-ttl:arch_audit_log', archAuditTtlQuery);

  const omnichannelAuditTtlQuery = `ALTER TABLE ${db}.omnichannel_audit_log MODIFY TTL ${buildOmnichannelAuditTtlExpressions(
    auditRetention,
  ).join(', ')}`;
  await runSchemaCommand('alter-ttl:omnichannel_audit_log', omnichannelAuditTtlQuery);
  console.log('[CH Schema] Audit retention TTLs applied');

  // ========================================================================
  // MIGRATIONS: Run migrations BEFORE creating materialized views so views
  // can safely reference new columns
  // ========================================================================

  // Migration: add _enc column to existing tables that support encryption.
  // ALTER TABLE ADD COLUMN IF NOT EXISTS is idempotent — safe for re-runs.
  const TABLES_NEEDING_ENC_COLUMN = [
    'messages',
    'platform_events',
    'audit_events',
    'insight_results',
    'custom_pipeline_results',
  ];
  for (const table of TABLES_NEEDING_ENC_COLUMN) {
    await runSchemaCommand(
      `alter-add-column:${table}._enc`,
      `ALTER TABLE ${db}.${table} ADD COLUMN IF NOT EXISTS _enc String DEFAULT '' CODEC(ZSTD(1))`,
    );
  }

  await runSchemaCommand(
    'alter-add-column:custom_pipeline_results.score_name',
    `ALTER TABLE ${db}.custom_pipeline_results ADD COLUMN IF NOT EXISTS score_name LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:custom_pipeline_results.score_path',
    `ALTER TABLE ${db}.custom_pipeline_results ADD COLUMN IF NOT EXISTS score_path String DEFAULT '' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:custom_pipeline_results.score_value',
    `ALTER TABLE ${db}.custom_pipeline_results ADD COLUMN IF NOT EXISTS score_value Nullable(Float64) CODEC(Gorilla, ZSTD(1))`,
  );

  // Migration: add custom_dimensions Map column to platform_events.
  // Idempotent — ADD COLUMN IF NOT EXISTS is safe for re-runs.
  await runSchemaCommand(
    'alter-add-column:platform_events.custom_dimensions',
    `ALTER TABLE ${db}.platform_events ADD COLUMN IF NOT EXISTS custom_dimensions Map(String, String) DEFAULT map() CODEC(ZSTD(3))`,
  );
  await runSchemaCommand(
    'alter-add-index:platform_events.idx_custom_dims',
    `ALTER TABLE ${db}.platform_events ADD INDEX IF NOT EXISTS idx_custom_dims mapKeys(custom_dimensions) TYPE ngrambf_v1(3, 256, 2, 0) GRANULARITY 4`,
  );

  // Migration: add known_source to platform_events and session-ordered copy.
  // Existing rows default to production for backward-compatible analytics filtering.
  await runSchemaCommand(
    'alter-add-column:platform_events.known_source',
    `ALTER TABLE ${db}.platform_events ADD COLUMN IF NOT EXISTS known_source LowCardinality(String) DEFAULT 'production' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:platform_events_by_session.known_source',
    `ALTER TABLE ${db}.platform_events_by_session ADD COLUMN IF NOT EXISTS known_source LowCardinality(String) DEFAULT 'production' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:platform_events.environment',
    `ALTER TABLE ${db}.platform_events ADD COLUMN IF NOT EXISTS environment LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:platform_events_by_session.environment',
    `ALTER TABLE ${db}.platform_events_by_session ADD COLUMN IF NOT EXISTS environment LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'drop-view:platform_events_by_session_mv',
    `DROP VIEW IF EXISTS ${db}.platform_events_by_session_mv`,
  );

  // Migration: add span_id and parent_span_id to platform_events for trace consolidation.
  // Idempotent — ADD COLUMN IF NOT EXISTS is safe for re-runs.
  await runSchemaCommand(
    'alter-add-column:platform_events.span_id',
    `ALTER TABLE ${db}.platform_events ADD COLUMN IF NOT EXISTS span_id String DEFAULT '' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:platform_events.parent_span_id',
    `ALTER TABLE ${db}.platform_events ADD COLUMN IF NOT EXISTS parent_span_id String DEFAULT '' CODEC(ZSTD(1))`,
  );
  // Migration: add idx_span bloom_filter index for existing deployments.
  await runSchemaCommand(
    'alter-add-index:platform_events.idx_span',
    `ALTER TABLE ${db}.platform_events ADD INDEX IF NOT EXISTS idx_span span_id TYPE bloom_filter GRANULARITY 4`,
  );

  // Migration: add dedicated causal trace columns for indexed runtime trace filtering.
  const PLATFORM_EVENT_CAUSAL_COLUMNS: Array<{
    name: string;
    ddl: string;
    indexName?: string;
  }> = [
    { name: 'turn_id', ddl: "String DEFAULT '' CODEC(ZSTD(1))", indexName: 'idx_turn' },
    {
      name: 'execution_id',
      ddl: "String DEFAULT '' CODEC(ZSTD(1))",
      indexName: 'idx_execution',
    },
    { name: 'parent_execution_id', ddl: "String DEFAULT '' CODEC(ZSTD(1))" },
    { name: 'agent_run_id', ddl: "String DEFAULT '' CODEC(ZSTD(1))", indexName: 'idx_agent_run' },
    { name: 'decision_id', ddl: "String DEFAULT '' CODEC(ZSTD(1))", indexName: 'idx_decision' },
    { name: 'parent_decision_id', ddl: "String DEFAULT '' CODEC(ZSTD(1))" },
    { name: 'cause_event_id', ddl: "String DEFAULT '' CODEC(ZSTD(1))" },
    { name: 'phase', ddl: "LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))" },
    { name: 'reason_code', ddl: "LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))" },
  ];
  for (const column of PLATFORM_EVENT_CAUSAL_COLUMNS) {
    await runSchemaCommand(
      `alter-add-column:platform_events.${column.name}`,
      `ALTER TABLE ${db}.platform_events ADD COLUMN IF NOT EXISTS ${column.name} ${column.ddl}`,
    );
    await runSchemaCommand(
      `alter-add-column:platform_events_by_session.${column.name}`,
      `ALTER TABLE ${db}.platform_events_by_session ADD COLUMN IF NOT EXISTS ${column.name} ${column.ddl}`,
    );
    if (column.indexName) {
      await runSchemaCommand(
        `alter-add-index:platform_events.${column.indexName}`,
        `ALTER TABLE ${db}.platform_events ADD INDEX IF NOT EXISTS ${column.indexName} ${column.name} TYPE bloom_filter GRANULARITY 4`,
      );
    }
  }
  // Do not materialize existing data in the default init path.
  // That is repair/backfill work, not converge-only schema initialization.

  // Migration: add project_id to messages for project-scoped analytics queries.
  // Idempotent — ADD COLUMN IF NOT EXISTS is safe for re-runs.
  // Existing rows will have project_id = '' (default); new rows carry the real value.
  await runSchemaCommand(
    'alter-add-column:messages.project_id',
    `ALTER TABLE ${db}.messages ADD COLUMN IF NOT EXISTS project_id String DEFAULT '' CODEC(ZSTD(1))`,
  );

  // Migration: add agent_name to messages for per-agent analytics and feedback
  // target lookups (ABLP-1068). Idempotent.
  await runSchemaCommand(
    'alter-add-column:messages.agent_name',
    `ALTER TABLE ${db}.messages ADD COLUMN IF NOT EXISTS agent_name LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))`,
  );

  // Migration: add session inspector hierarchy columns to arch_audit_log.
  // Idempotent — ADD COLUMN IF NOT EXISTS is safe for re-runs.
  await runSchemaCommand(
    'alter-add-column:arch_audit_log.turn_id',
    `ALTER TABLE ${db}.arch_audit_log ADD COLUMN IF NOT EXISTS turn_id String DEFAULT '' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:arch_audit_log.parent_event_id',
    `ALTER TABLE ${db}.arch_audit_log ADD COLUMN IF NOT EXISTS parent_event_id String DEFAULT '' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:arch_audit_log.phase_label',
    `ALTER TABLE ${db}.arch_audit_log ADD COLUMN IF NOT EXISTS phase_label LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:arch_audit_log.retry_of',
    `ALTER TABLE ${db}.arch_audit_log ADD COLUMN IF NOT EXISTS retry_of String DEFAULT '' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:arch_audit_log.retry_index',
    `ALTER TABLE ${db}.arch_audit_log ADD COLUMN IF NOT EXISTS retry_index UInt8 DEFAULT 0 CODEC(T64, ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:arch_audit_log.nesting_depth',
    `ALTER TABLE ${db}.arch_audit_log ADD COLUMN IF NOT EXISTS nesting_depth UInt8 DEFAULT 255 CODEC(T64, ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-column:arch_audit_log.span_kind',
    `ALTER TABLE ${db}.arch_audit_log ADD COLUMN IF NOT EXISTS span_kind LowCardinality(String) DEFAULT '' CODEC(ZSTD(1))`,
  );
  await runSchemaCommand(
    'alter-add-index:arch_audit_log.idx_turn_id',
    `ALTER TABLE ${db}.arch_audit_log ADD INDEX IF NOT EXISTS idx_turn_id turn_id TYPE bloom_filter GRANULARITY 4`,
  );
  await runSchemaCommand(
    'alter-add-index:arch_audit_log.idx_span_kind',
    `ALTER TABLE ${db}.arch_audit_log ADD INDEX IF NOT EXISTS idx_span_kind span_kind TYPE set(10) GRANULARITY 4`,
  );

  console.log('[CH Schema] Column migrations applied');

  // Create materialized views (now that all column migrations are complete)
  for (const view of MATERIALIZED_VIEWS) {
    await runSchemaCommand(`create-materialized-view:${view.name}`, view.ddl);
  }
  console.log(`[CH Schema] ${MATERIALIZED_VIEWS.length} core materialized views created`);
}

export {
  DATABASE,
  TABLES,
  MATERIALIZED_VIEWS,
  buildAuditEventsTableDDL,
  buildKmsAuditLogTableDDL,
  buildPiiAuditLogTableDDL,
  buildConnectorAuditLogTableDDL,
  buildCrawlAuditEventsTableDDL,
  buildArchAuditLogTableDDL,
  buildArchAuditPayloadsTableDDL,
  buildOmnichannelAuditLogTableDDL,
};
