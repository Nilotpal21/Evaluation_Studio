/**
 * ClickHouseEventStore - production event storage implementation.
 *
 * Implements IEventStore using ClickHouse with:
 * - BufferedClickHouseWriter for fire-and-forget writes (10K batch / 5s flush / 100K max)
 * - Parameterized queries for safety
 * - JSON extraction for data field queries
 * - Tenant isolation (all queries scoped by tenant_id)
 * - Plan-based retention (purgeExpired, scrubPII)
 * - GDPR compliance (deleteBySessionIds, anonymizeActor, deleteTenant)
 */

import type { ClickHouseClient } from '@clickhouse/client';
import { createLogger } from '@agent-platform/shared-observability';
import { BufferedClickHouseWriter } from '@agent-platform/database/clickhouse.js';
import type { IEventStore } from '../../interfaces/event-store.js';
import type {
  EventQueryParams,
  EventQueryResult,
  EventAggregateParams,
  EventAggregateResult,
  EventCountParams,
  EventCountResult,
  PurgeResult,
} from '../../interfaces/types.js';
import type { PlatformEvent } from '../../schema/platform-event.js';
import { ClickHouseRowMapper, type ClickHouseEventRow } from './clickhouse-row-mapper.js';

const log = createLogger('eventstore:clickhouse-store');

type AggregateGroupByField = EventAggregateParams['groupBy'][number];
type AggregateMetricName = EventAggregateParams['metrics'][number];
type CountGroupByField = EventCountParams['groupBy'];

const AGGREGATE_GROUP_BY_FIELDS = new Set<AggregateGroupByField>([
  'category',
  'event_type',
  'agent_name',
  'channel',
  'hour',
  'day',
  'data_model',
  'data_provider',
]);

const AGGREGATE_METRIC_NAMES = new Set<AggregateMetricName>([
  'count',
  'avg_duration',
  'error_rate',
  'p95_duration',
  'sum_tokens',
  'sum_cost',
]);

const COUNT_GROUP_BY_FIELDS = new Set<CountGroupByField>([
  'category',
  'event_type',
  'agent_name',
  'channel',
]);
const WAIT_FOR_LOCAL_MUTATION_SETTING = 'SETTINGS mutations_sync = 1';

function assertAggregateGroupByField(field: string): asserts field is AggregateGroupByField {
  if (!AGGREGATE_GROUP_BY_FIELDS.has(field as AggregateGroupByField)) {
    throw new Error(`Unsupported aggregate groupBy dimension: ${field}`);
  }
}

function assertAggregateMetricName(metric: string): asserts metric is AggregateMetricName {
  if (!AGGREGATE_METRIC_NAMES.has(metric as AggregateMetricName)) {
    throw new Error(`Unsupported aggregate metric: ${metric}`);
  }
}

function assertCountGroupByField(field: string): asserts field is CountGroupByField {
  if (!COUNT_GROUP_BY_FIELDS.has(field as CountGroupByField)) {
    throw new Error(`Unsupported count groupBy dimension: ${field}`);
  }
}

export interface ClickHouseEventStoreConfig {
  client: ClickHouseClient;
  table?: string; // default: 'abl_platform.platform_events'
  batchSize?: number; // default: 10000
  flushIntervalMs?: number; // default: 5000
  maxBufferSize?: number; // default: 100000
  maxRetries?: number; // default: 3
}

export class ClickHouseEventStore implements IEventStore {
  readonly backendName = 'clickhouse';
  private writer: BufferedClickHouseWriter<ClickHouseEventRow>;
  private client: ClickHouseClient;
  private table: string;
  private rowMapper: ClickHouseRowMapper;

  constructor(config: ClickHouseEventStoreConfig) {
    this.client = config.client;
    this.table = config.table ?? 'abl_platform.platform_events';
    this.rowMapper = new ClickHouseRowMapper();

    // Create buffered writer for fire-and-forget inserts
    this.writer = new BufferedClickHouseWriter(this.client, {
      table: this.table,
      batchSize: config.batchSize ?? 10_000,
      flushIntervalMs: config.flushIntervalMs ?? 5_000,
      maxBufferSize: config.maxBufferSize ?? 100_000,
      maxRetries: config.maxRetries ?? 3,
      onError: (err, context) => {
        log.error('Buffer error', {
          error: err instanceof Error ? err.message : String(err),
          context,
          table: this.table,
        });
      },
    });
  }

  private getLifecycleMutationTables(): string[] {
    if (this.table === 'abl_platform.platform_events') {
      return [this.table, 'abl_platform.platform_events_by_session'];
    }
    return [this.table];
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IEventWriter Implementation
  // ═══════════════════════════════════════════════════════════════════════════

  write(event: unknown): void {
    const platformEvent = event as PlatformEvent;
    const row = this.rowMapper.toRow(platformEvent);
    this.writer.insert(row);
  }

  writeBatch(events: unknown[]): void {
    const platformEvents = events as PlatformEvent[];
    const rows = this.rowMapper.toRows(platformEvents);
    this.writer.insertMany(rows);
  }

  async flush(): Promise<void> {
    await this.writer.flush();
  }

  async close(): Promise<void> {
    await this.writer.close();
  }

  get pendingCount(): number {
    return this.writer.pending;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IEventReader Implementation
  // ═══════════════════════════════════════════════════════════════════════════

  async query(params: EventQueryParams): Promise<EventQueryResult> {
    const limit = Math.min(params.limit ?? 100, 10_000);
    const offset = params.offset ?? 0;

    // Build WHERE clause
    const conditions: string[] = [
      'tenant_id = {tenantId:String}',
      'project_id = {projectId:String}',
      'timestamp >= {from:DateTime64(3)}',
      'timestamp <= {to:DateTime64(3)}',
    ];

    if (params.category) {
      conditions.push('category = {category:String}');
    }

    if (params.eventTypes && params.eventTypes.length > 0) {
      conditions.push('event_type IN {eventTypes:Array(String)}');
    }

    if (params.sessionId) {
      conditions.push('session_id = {sessionId:String}');
    }

    if (params.agentName) {
      conditions.push('agent_name = {agentName:String}');
    }

    if (params.hasError !== undefined) {
      conditions.push('has_error = {hasError:UInt8}');
    }

    const whereClause = conditions.join(' AND ');

    // Query with pagination
    const query = `
      SELECT *
      FROM ${this.table}
      WHERE ${whereClause}
      ORDER BY timestamp DESC
      LIMIT {limit:UInt32}
      OFFSET {offset:UInt32}
    `;

    const queryParams = {
      tenantId: params.tenantId,
      projectId: params.projectId,
      from: params.timeRange.from,
      to: params.timeRange.to,
      category: params.category,
      eventTypes: params.eventTypes,
      sessionId: params.sessionId,
      agentName: params.agentName,
      hasError: params.hasError ? 1 : 0,
      limit,
      offset,
    };

    // Execute query
    const resultSet = await this.client.query({
      query,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const rows = (await resultSet.json()) as ClickHouseEventRow[];
    const events = this.rowMapper.fromRows(rows);

    // Get total count (for pagination)
    const countQuery = `
      SELECT count() as total
      FROM ${this.table}
      WHERE ${whereClause}
    `;

    const countResult = await this.client.query({
      query: countQuery,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const countRows = (await countResult.json()) as Array<{ total: string }>;
    const total = parseInt(countRows[0]?.total ?? '0', 10);

    return {
      events,
      total,
      hasMore: offset + events.length < total,
    };
  }

  async aggregate(params: EventAggregateParams): Promise<EventAggregateResult> {
    // Build WHERE clause (same as query)
    const conditions: string[] = [
      'tenant_id = {tenantId:String}',
      'project_id = {projectId:String}',
      'timestamp >= {from:DateTime64(3)}',
      'timestamp <= {to:DateTime64(3)}',
    ];

    if (params.filters?.category) {
      conditions.push('category = {category:String}');
    }

    if (params.filters?.eventTypes && params.filters.eventTypes.length > 0) {
      conditions.push('event_type IN {eventTypes:Array(String)}');
    }

    if (params.filters?.hasError !== undefined) {
      conditions.push('has_error = {hasError:UInt8}');
    }

    const whereClause = conditions.join(' AND ');

    // Build GROUP BY clause
    const groupByFields = params.groupBy.map((field) => {
      assertAggregateGroupByField(field);

      switch (field) {
        case 'hour':
          return 'toStartOfHour(timestamp) AS hour';
        case 'day':
          return 'toDate(timestamp) AS day';
        case 'category':
          return 'category';
        case 'event_type':
          return 'event_type';
        case 'agent_name':
          return 'agent_name';
        case 'channel':
          return 'channel';
        case 'data_model':
          return "JSONExtractString(data, 'model') AS model";
        case 'data_provider':
          return "JSONExtractString(data, 'provider') AS provider";
      }
    });

    // Build SELECT clause with metrics
    const metricFields = params.metrics.map((metric) => {
      assertAggregateMetricName(metric);

      switch (metric) {
        case 'count':
          return 'count() AS count';
        case 'avg_duration':
          return 'avg(duration_ms) AS avg_duration';
        case 'error_rate':
          return 'countIf(has_error = 1) / count() * 100 AS error_rate';
        case 'p95_duration':
          return 'quantile(0.95)(duration_ms) AS p95_duration';
        case 'sum_tokens':
          // Extract total_tokens from JSON data field (fallback to custom dataField)
          return `sum(JSONExtractUInt(data, '${params.dataField || 'total_tokens'}')) AS sum_tokens`;
        case 'sum_cost':
          // Extract estimated_cost from JSON data field
          return `sum(JSONExtractFloat(data, 'estimated_cost')) AS sum_cost`;
      }
    });

    const selectFields = [...groupByFields, ...metricFields];

    const resolveGroupByAlias = (f: string): string => {
      switch (f) {
        case 'hour':
          return 'hour';
        case 'day':
          return 'day';
        case 'data_model':
          return 'model';
        case 'data_provider':
          return 'provider';
        default:
          return f;
      }
    };

    const hasGroupBy = params.groupBy.length > 0;
    const groupByClause = hasGroupBy
      ? `GROUP BY ${params.groupBy.map(resolveGroupByAlias).join(', ')}`
      : '';
    const orderByClause = hasGroupBy
      ? `ORDER BY ${resolveGroupByAlias(params.groupBy[0])} DESC`
      : '';

    const query = `
      SELECT ${selectFields.join(', ')}
      FROM ${this.table}
      WHERE ${whereClause}
      ${groupByClause}
      ${orderByClause}
      LIMIT 1000
    `;

    const queryParams = {
      tenantId: params.tenantId,
      projectId: params.projectId,
      from: params.timeRange.from,
      to: params.timeRange.to,
      category: params.filters?.category,
      eventTypes: params.filters?.eventTypes,
      hasError: params.filters?.hasError ? 1 : 0,
    };

    const resultSet = await this.client.query({
      query,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const buckets = (await resultSet.json()) as Record<string, unknown>[];

    return { buckets };
  }

  async count(params: EventCountParams): Promise<EventCountResult> {
    assertCountGroupByField(params.groupBy);

    // Build WHERE clause
    const conditions: string[] = [
      'tenant_id = {tenantId:String}',
      'project_id = {projectId:String}',
      'timestamp >= {from:DateTime64(3)}',
      'timestamp <= {to:DateTime64(3)}',
    ];

    if (params.filters?.category) {
      conditions.push('category = {category:String}');
    }

    if (params.filters?.hasError !== undefined) {
      conditions.push('has_error = {hasError:UInt8}');
    }

    const whereClause = conditions.join(' AND ');

    const query = `
      SELECT
        ${params.groupBy} AS key,
        count() AS count,
        countIf(has_error = 1) AS errorCount
      FROM ${this.table}
      WHERE ${whereClause}
      GROUP BY ${params.groupBy}
      ORDER BY count DESC
      LIMIT 100
    `;

    const queryParams = {
      tenantId: params.tenantId,
      projectId: params.projectId,
      from: params.timeRange.from,
      to: params.timeRange.to,
      category: params.filters?.category,
      hasError: params.filters?.hasError ? 1 : 0,
    };

    const resultSet = await this.client.query({
      query,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const counts = (await resultSet.json()) as Array<{
      key: string;
      count: string;
      errorCount: string;
    }>;

    return {
      counts: counts.map((row) => ({
        key: row.key,
        count: parseInt(row.count, 10),
        errorCount: parseInt(row.errorCount, 10),
      })),
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // IEventLifecycle Implementation
  // ═══════════════════════════════════════════════════════════════════════════

  async purgeExpired(tenantId: string, olderThan: Date): Promise<PurgeResult> {
    // ClickHouse ALTER TABLE ... DELETE (lightweight delete, async)
    await Promise.all(
      this.getLifecycleMutationTables().map((table) =>
        this.client.command({
          query: `
            ALTER TABLE ${table}
            DELETE WHERE tenant_id = {tenantId:String}
              AND timestamp < {olderThan:DateTime64(3)}
            ${WAIT_FOR_LOCAL_MUTATION_SETTING}
          `,
          query_params: {
            tenantId,
            olderThan,
          },
        }),
      ),
    );

    // ClickHouse ALTER DELETE is async - return estimate
    // For accurate count, would need SELECT count() before delete (expensive)
    return { deletedEstimate: -1 };
  }

  async scrubPII(tenantId: string, olderThan: Date, eventTypes: string[]): Promise<void> {
    if (eventTypes.length === 0) return;

    // ClickHouse ALTER TABLE ... UPDATE (replace data, metadata, and top-level
    // error text with anonymized markers). Runtime emitters may populate
    // error_message or metadata from raw provider/tool errors and user-provided
    // trace dimensions, so scrubbing only the JSON payload is not sufficient.
    await Promise.all(
      this.getLifecycleMutationTables().map((table) =>
        this.client.command({
          query: `
            ALTER TABLE ${table}
            UPDATE
              data = '{"anonymized":true}',
              error_message = '',
              error_type = '',
              metadata = '{}',
              custom_dimensions = map()
            WHERE tenant_id = {tenantId:String}
              AND timestamp < {olderThan:DateTime64(3)}
              AND event_type IN {eventTypes:Array(String)}
            ${WAIT_FOR_LOCAL_MUTATION_SETTING}
          `,
          query_params: {
            tenantId,
            olderThan,
            eventTypes,
          },
        }),
      ),
    );
  }

  async deleteBySessionIds(tenantId: string, sessionIds: string[]): Promise<void> {
    if (sessionIds.length === 0) return;

    await Promise.all(
      this.getLifecycleMutationTables().map((table) =>
        this.client.command({
          query: `
            ALTER TABLE ${table}
            DELETE WHERE tenant_id = {tenantId:String}
              AND session_id IN {sessionIds:Array(String)}
            ${WAIT_FOR_LOCAL_MUTATION_SETTING}
          `,
          query_params: {
            tenantId,
            sessionIds,
          },
        }),
      ),
    );
  }

  async anonymizeActor(tenantId: string, actorId: string): Promise<void> {
    // Replace actor_id with anonymized hash
    const anonymizedId = `[ANONYMIZED:${actorId.slice(0, 8)}]`;

    await Promise.all(
      this.getLifecycleMutationTables().map((table) =>
        this.client.command({
          query: `
            ALTER TABLE ${table}
            UPDATE actor_id = {anonymizedId:String}
            WHERE tenant_id = {tenantId:String}
              AND actor_id = {actorId:String}
            ${WAIT_FOR_LOCAL_MUTATION_SETTING}
          `,
          query_params: {
            tenantId,
            actorId,
            anonymizedId,
          },
        }),
      ),
    );
  }

  async deleteTenant(tenantId: string): Promise<void> {
    await Promise.all(
      this.getLifecycleMutationTables().map((table) =>
        this.client.command({
          query: `
            ALTER TABLE ${table}
            DELETE WHERE tenant_id = {tenantId:String}
            ${WAIT_FOR_LOCAL_MUTATION_SETTING}
          `,
          query_params: {
            tenantId,
          },
        }),
      ),
    );
  }
}
