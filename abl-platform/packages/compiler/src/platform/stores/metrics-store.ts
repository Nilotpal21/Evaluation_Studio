/**
 * Metrics Store
 *
 * Abstract interface for LLM usage metric recording and querying.
 * Extracted from direct DB calls in chat routes.
 *
 * This separation enables Phase 2 migration to ClickHouse for metrics
 * without changing application code.
 */

// =============================================================================
// INTERFACES
// =============================================================================

export interface MetricsStoreConfig {
  type: 'postgres' | 'clickhouse' | 'memory' | 'mongodb';
  connectionString?: string;
}

export interface LLMMetricInput {
  tenantId?: string;
  sessionId: string;
  projectId: string;
  userId?: string;
  modelId: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number | null;
  latencyMs: number;
  streamingUsed: boolean;
  toolCallCount: number;
  operationType?: string;
  agentName?: string;
  knownSource?: 'production' | 'eval' | 'synthetic';
}

export interface MetricsQueryParams {
  projectId: string;
  startDate?: Date;
  endDate?: Date;
}

export interface TenantMetricsQueryParams {
  tenantId: string;
  projectId?: string;
  startDate?: Date;
  endDate?: Date;
}

export interface UsageSummary {
  totalRequests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
  avgLatencyMs: number;
}

export interface CostBreakdown {
  modelId: string;
  provider: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  estimatedCost: number;
}

export interface DailyUsage {
  date: string;
  requests: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  estimatedCost: number;
}

export interface ProjectUsage {
  projectId: string;
  requests: number;
  totalTokens: number;
  estimatedCost: number;
}

// =============================================================================
// ABSTRACT STORE
// =============================================================================

export abstract class MetricsStore {
  protected config: MetricsStoreConfig;

  constructor(config: MetricsStoreConfig) {
    this.config = config;
  }

  abstract record(metric: LLMMetricInput): Promise<void>;
  abstract getUsage(params: MetricsQueryParams): Promise<UsageSummary>;
  abstract getCostBreakdown(params: MetricsQueryParams): Promise<CostBreakdown[]>;

  async getTenantUsage(_params: TenantMetricsQueryParams): Promise<UsageSummary> {
    throw new Error('getTenantUsage not implemented');
  }

  async getTenantCostBreakdown(_params: TenantMetricsQueryParams): Promise<CostBreakdown[]> {
    throw new Error('getTenantCostBreakdown not implemented');
  }

  async getTenantDailyUsage(_params: TenantMetricsQueryParams): Promise<DailyUsage[]> {
    throw new Error('getTenantDailyUsage not implemented');
  }

  async getTenantProjectUsage(_params: TenantMetricsQueryParams): Promise<ProjectUsage[]> {
    throw new Error('getTenantProjectUsage not implemented');
  }
}

// =============================================================================
// IN-MEMORY IMPLEMENTATION (for development/testing)
// =============================================================================

export class InMemoryMetricsStore extends MetricsStore {
  private metrics: LLMMetricInput[] = [];

  async record(metric: LLMMetricInput): Promise<void> {
    this.metrics.push({ ...metric });
  }

  async getUsage(params: MetricsQueryParams): Promise<UsageSummary> {
    const filtered = this.filterByParams(params);

    if (filtered.length === 0) {
      return {
        totalRequests: 0,
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCost: 0,
        avgLatencyMs: 0,
      };
    }

    const totalRequests = filtered.length;
    const inputTokens = filtered.reduce((sum, m) => sum + m.inputTokens, 0);
    const outputTokens = filtered.reduce((sum, m) => sum + m.outputTokens, 0);
    const totalTokens = filtered.reduce((sum, m) => sum + m.totalTokens, 0);
    const estimatedCost = filtered.reduce((sum, m) => sum + (m.estimatedCost || 0), 0);
    const avgLatencyMs = Math.round(
      filtered.reduce((sum, m) => sum + m.latencyMs, 0) / totalRequests,
    );

    return {
      totalRequests,
      inputTokens,
      outputTokens,
      totalTokens,
      estimatedCost,
      avgLatencyMs,
    };
  }

  async getCostBreakdown(params: MetricsQueryParams): Promise<CostBreakdown[]> {
    const filtered = this.filterByParams(params);

    const groups = new Map<string, LLMMetricInput[]>();
    for (const m of filtered) {
      const key = `${m.modelId}:${m.provider}`;
      const group = groups.get(key) || [];
      group.push(m);
      groups.set(key, group);
    }

    return Array.from(groups.entries()).map(([, items]) => ({
      modelId: items[0].modelId,
      provider: items[0].provider,
      requests: items.length,
      inputTokens: items.reduce((sum, m) => sum + m.inputTokens, 0),
      outputTokens: items.reduce((sum, m) => sum + m.outputTokens, 0),
      totalTokens: items.reduce((sum, m) => sum + m.totalTokens, 0),
      estimatedCost: items.reduce((sum, m) => sum + (m.estimatedCost || 0), 0),
    }));
  }

  private filterByParams(params: MetricsQueryParams): LLMMetricInput[] {
    return this.metrics.filter((m) => m.projectId === params.projectId);
  }
}

// =============================================================================
// FACTORY
// =============================================================================

export function createMetricsStore(config: MetricsStoreConfig): MetricsStore {
  switch (config.type) {
    case 'memory':
      return new InMemoryMetricsStore(config);
    case 'postgres':
      throw new Error('PostgreSQL metrics store not yet implemented');
    case 'clickhouse':
      // ClickHouseMetricsStore requires a ClickHouse client;
      // use runtime's ClickHouseMetricsStore directly instead of this factory.
      throw new Error(
        'ClickHouse metrics store requires runtime dependencies — use ClickHouseMetricsStore from @abl/runtime',
      );
    default:
      throw new Error(`Unknown metrics store type: ${config.type}`);
  }
}
