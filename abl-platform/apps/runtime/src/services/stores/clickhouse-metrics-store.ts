/**
 * ClickHouse Metrics Store
 *
 * Implements MetricsStore for ClickHouse backend.
 * No encryption — token counts and costs are not PII.
 * Uses BufferedWriter for batched inserts (10K rows / 5s flush).
 */

import type { ClickHouseClient } from '@clickhouse/client';
import {
  MetricsStore,
  type MetricsStoreConfig,
  type LLMMetricInput,
  type MetricsQueryParams,
  type TenantMetricsQueryParams,
  type UsageSummary,
  type CostBreakdown,
  type DailyUsage,
  type ProjectUsage,
} from '@abl/compiler/platform/stores/metrics-store.js';
import {
  BufferedClickHouseWriter,
  toClickHouseDateTime,
} from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('clickhouse-metrics-store');
const CLICKHOUSE_FLUSH_BACKOFF_MS = 60_000;

interface ClickHouseMetricsRow {
  tenant_id: string;
  timestamp: string;
  model_id: string;
  provider: string;
  session_id: string;
  project_id: string;
  user_id: string;
  operation_type: string;
  agent_name: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  estimated_cost: number;
  latency_ms: number;
  streaming_used: number;
  tool_call_count: number;
  success: number;
  error_type: string;
  known_source: string;
}

export interface ClickHouseMetricsStoreOptions {
  client: ClickHouseClient;
  /** @deprecated Metrics use per-record tenantId from metric.tenantId */
  tenantId?: string;
}

export class ClickHouseMetricsStore extends MetricsStore {
  private client: ClickHouseClient;
  private tenantId: string;
  private writer: BufferedClickHouseWriter<ClickHouseMetricsRow>;
  private flushRetryAfter = 0;

  constructor(config: MetricsStoreConfig, options: ClickHouseMetricsStoreOptions) {
    super(config);
    this.client = options.client;
    this.tenantId = options.tenantId ?? '';
    this.writer = new BufferedClickHouseWriter(this.client, {
      table: 'abl_platform.llm_metrics',
      suppressErrorLogs: true,
      onError: (err, ctx) => {
        log.error('Buffered writer flush error', {
          error: err instanceof Error ? err.message : String(err),
          ctx,
        });
      },
    });
  }

  async record(metric: LLMMetricInput): Promise<void> {
    const row: ClickHouseMetricsRow = {
      tenant_id: metric.tenantId || this.tenantId,
      timestamp: toClickHouseDateTime(new Date()),
      model_id: metric.modelId,
      provider: metric.provider,
      session_id: metric.sessionId,
      project_id: metric.projectId,
      user_id: metric.userId || '',
      operation_type: metric.operationType || '',
      agent_name: metric.agentName || '',
      input_tokens: metric.inputTokens,
      output_tokens: metric.outputTokens,
      total_tokens: metric.totalTokens,
      estimated_cost: metric.estimatedCost ?? 0,
      latency_ms: metric.latencyMs,
      streaming_used: metric.streamingUsed ? 1 : 0,
      tool_call_count: metric.toolCallCount,
      success: 1,
      error_type: '',
      known_source: metric.knownSource ?? 'production',
    };

    this.writer.insert(row);
    if (Date.now() < this.flushRetryAfter) {
      return;
    }

    try {
      await this.writer.flush();
      this.flushRetryAfter = 0;
    } catch (err) {
      this.flushRetryAfter = Date.now() + CLICKHOUSE_FLUSH_BACKOFF_MS;
      log.warn('Immediate metrics flush failed, backing off', {
        error: err instanceof Error ? err.message : String(err),
        retryInMs: CLICKHOUSE_FLUSH_BACKOFF_MS,
      });
    }
  }

  async getUsage(params: MetricsQueryParams): Promise<UsageSummary> {
    const conditions = [`tenant_id = {tenantId:String}`, `project_id = {projectId:String}`];
    const queryParams: Record<string, string> = {
      tenantId: this.tenantId,
      projectId: params.projectId,
    };

    if (params.startDate) {
      conditions.push(`timestamp >= {startDate:DateTime64(3)}`);
      queryParams.startDate = toClickHouseDateTime(params.startDate);
    }
    if (params.endDate) {
      conditions.push(`timestamp <= {endDate:DateTime64(3)}`);
      queryParams.endDate = toClickHouseDateTime(params.endDate);
    }

    const result = await this.client.query({
      query: `
        SELECT
          count() AS totalRequests,
          sum(input_tokens) AS inputTokens,
          sum(output_tokens) AS outputTokens,
          sum(total_tokens) AS totalTokens,
          sum(estimated_cost) AS estimatedCost,
          avg(latency_ms) AS avgLatencyMs
        FROM abl_platform.llm_metrics
        WHERE ${conditions.join(' AND ')}
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const rows = await result.json<Record<string, string>>();
    const row = rows[0];

    return {
      totalRequests: parseInt(row?.totalRequests || '0', 10),
      inputTokens: parseInt(row?.inputTokens || '0', 10),
      outputTokens: parseInt(row?.outputTokens || '0', 10),
      totalTokens: parseInt(row?.totalTokens || '0', 10),
      estimatedCost: parseFloat(row?.estimatedCost || '0'),
      avgLatencyMs: Math.round(parseFloat(row?.avgLatencyMs || '0')),
    };
  }

  async getCostBreakdown(params: MetricsQueryParams): Promise<CostBreakdown[]> {
    const conditions = [`tenant_id = {tenantId:String}`, `project_id = {projectId:String}`];
    const queryParams: Record<string, string> = {
      tenantId: this.tenantId,
      projectId: params.projectId,
    };

    if (params.startDate) {
      conditions.push(`timestamp >= {startDate:DateTime64(3)}`);
      queryParams.startDate = toClickHouseDateTime(params.startDate);
    }
    if (params.endDate) {
      conditions.push(`timestamp <= {endDate:DateTime64(3)}`);
      queryParams.endDate = toClickHouseDateTime(params.endDate);
    }

    const result = await this.client.query({
      query: `
        SELECT
          model_id AS modelId,
          provider,
          count() AS requests,
          sum(input_tokens) AS inputTokens,
          sum(output_tokens) AS outputTokens,
          sum(total_tokens) AS totalTokens,
          sum(estimated_cost) AS estimatedCost
        FROM abl_platform.llm_metrics
        WHERE ${conditions.join(' AND ')}
        GROUP BY model_id, provider
        ORDER BY estimatedCost DESC
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const rows = await result.json<Record<string, string>>();

    return rows.map((row: Record<string, string>) => ({
      modelId: row.modelId,
      provider: row.provider,
      requests: parseInt(row.requests, 10),
      inputTokens: parseInt(row.inputTokens, 10),
      outputTokens: parseInt(row.outputTokens, 10),
      totalTokens: parseInt(row.totalTokens, 10),
      estimatedCost: parseFloat(row.estimatedCost),
    }));
  }

  // =========================================================================
  // TENANT-LEVEL QUERY METHODS
  // =========================================================================

  private buildTenantConditions(params: TenantMetricsQueryParams): {
    conditions: string[];
    queryParams: Record<string, string>;
  } {
    const conditions = [`tenant_id = {tenantId:String}`];
    const queryParams: Record<string, string> = { tenantId: params.tenantId };

    if (params.projectId) {
      conditions.push(`project_id = {projectId:String}`);
      queryParams.projectId = params.projectId;
    }
    if (params.startDate) {
      conditions.push(`timestamp >= {startDate:DateTime64(3)}`);
      queryParams.startDate = toClickHouseDateTime(params.startDate);
    }
    if (params.endDate) {
      conditions.push(`timestamp <= {endDate:DateTime64(3)}`);
      queryParams.endDate = toClickHouseDateTime(params.endDate);
    }

    return { conditions, queryParams };
  }

  async getTenantUsage(params: TenantMetricsQueryParams): Promise<UsageSummary> {
    const { conditions, queryParams } = this.buildTenantConditions(params);

    const result = await this.client.query({
      query: `
        SELECT
          count() AS totalRequests,
          sum(input_tokens) AS inputTokens,
          sum(output_tokens) AS outputTokens,
          sum(total_tokens) AS totalTokens,
          sum(estimated_cost) AS estimatedCost,
          avg(latency_ms) AS avgLatencyMs
        FROM abl_platform.llm_metrics
        WHERE ${conditions.join(' AND ')}
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const rows = await result.json<Record<string, string>>();
    const row = rows[0];

    return {
      totalRequests: parseInt(row?.totalRequests || '0', 10),
      inputTokens: parseInt(row?.inputTokens || '0', 10),
      outputTokens: parseInt(row?.outputTokens || '0', 10),
      totalTokens: parseInt(row?.totalTokens || '0', 10),
      estimatedCost: parseFloat(row?.estimatedCost || '0'),
      avgLatencyMs: Math.round(parseFloat(row?.avgLatencyMs || '0')),
    };
  }

  async getTenantCostBreakdown(params: TenantMetricsQueryParams): Promise<CostBreakdown[]> {
    const { conditions, queryParams } = this.buildTenantConditions(params);

    const result = await this.client.query({
      query: `
        SELECT
          model_id AS modelId,
          provider,
          count() AS requests,
          sum(input_tokens) AS inputTokens,
          sum(output_tokens) AS outputTokens,
          sum(total_tokens) AS totalTokens,
          sum(estimated_cost) AS estimatedCost
        FROM abl_platform.llm_metrics
        WHERE ${conditions.join(' AND ')}
        GROUP BY model_id, provider
        ORDER BY estimatedCost DESC
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const rows = await result.json<Record<string, string>>();

    return rows.map((row: Record<string, string>) => ({
      modelId: row.modelId,
      provider: row.provider,
      requests: parseInt(row.requests, 10),
      inputTokens: parseInt(row.inputTokens, 10),
      outputTokens: parseInt(row.outputTokens, 10),
      totalTokens: parseInt(row.totalTokens, 10),
      estimatedCost: parseFloat(row.estimatedCost),
    }));
  }

  async getTenantDailyUsage(params: TenantMetricsQueryParams): Promise<DailyUsage[]> {
    const { conditions, queryParams } = this.buildTenantConditions(params);

    const result = await this.client.query({
      query: `
        SELECT
          toDate(timestamp) AS date,
          count() AS requests,
          sum(total_tokens) AS totalTokens,
          sum(input_tokens) AS inputTokens,
          sum(output_tokens) AS outputTokens,
          sum(estimated_cost) AS estimatedCost
        FROM abl_platform.llm_metrics
        WHERE ${conditions.join(' AND ')}
        GROUP BY toDate(timestamp)
        ORDER BY date ASC
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const rows = await result.json<Record<string, string>>();

    return rows.map((row: Record<string, string>) => ({
      date: row.date,
      requests: parseInt(row.requests, 10),
      totalTokens: parseInt(row.totalTokens, 10),
      inputTokens: parseInt(row.inputTokens, 10),
      outputTokens: parseInt(row.outputTokens, 10),
      estimatedCost: parseFloat(row.estimatedCost),
    }));
  }

  async getTenantProjectUsage(params: TenantMetricsQueryParams): Promise<ProjectUsage[]> {
    const { conditions, queryParams } = this.buildTenantConditions(params);

    const result = await this.client.query({
      query: `
        SELECT
          project_id AS projectId,
          count() AS requests,
          sum(total_tokens) AS totalTokens,
          sum(estimated_cost) AS estimatedCost
        FROM abl_platform.llm_metrics
        WHERE ${conditions.join(' AND ')}
        GROUP BY project_id
        ORDER BY estimatedCost DESC
        SETTINGS max_execution_time = 15
      `,
      query_params: queryParams,
      format: 'JSONEachRow',
    });

    const rows = await result.json<Record<string, string>>();

    return rows.map((row: Record<string, string>) => ({
      projectId: row.projectId,
      requests: parseInt(row.requests, 10),
      totalTokens: parseInt(row.totalTokens, 10),
      estimatedCost: parseFloat(row.estimatedCost),
    }));
  }

  async close(): Promise<void> {
    await this.writer.close();
  }
}
