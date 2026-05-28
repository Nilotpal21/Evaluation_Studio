/**
 * Interaction Aggregator
 *
 * Queries ClickHouse facet_interactions table to compute rolling-window
 * interaction statistics (impressions, clicks, unique users) per attribute.
 * Fail-open: returns empty map when ClickHouse is unavailable.
 *
 * The returned Map is bounded by the GROUP BY result set (one entry per
 * attribute_type in the ClickHouse table for the given tenant+index).
 * ClickHouse queries enforce tenant_id + index_id scoping and a time window.
 */

import { createLogger } from '@abl/compiler/platform';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { ClickHouseClient } from '@clickhouse/client';
import type { InteractionStats } from './types.js';

const log = createLogger('interaction-aggregator');

const TABLE = 'abl_platform.facet_interactions';

/** Maximum number of attribute types to aggregate (prevents unbounded results) */
const MAX_ATTRIBUTE_TYPES = 10_000;

/** Row shape returned by the aggregation query */
interface InteractionRow {
  attribute_type: string;
  impressions: string;
  clicks: string;
  unique_users: string;
}

export class InteractionAggregator {
  private client: ClickHouseClient | null = null;

  constructor() {
    try {
      if (process.env.CLICKHOUSE_URL || process.env.CLICKHOUSE_HOST) {
        this.client = getClickHouseClient();
      }
    } catch (error) {
      log.warn('ClickHouse unavailable for interaction aggregation', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.client = null;
    }
  }

  /**
   * Aggregate interaction stats per attribute for a given index over a rolling window.
   * Returns a Map keyed by attribute_type (attributeId), bounded by MAX_ATTRIBUTE_TYPES.
   */
  async aggregateInteractions(
    tenantId: string,
    indexId: string,
    windowDays: number,
  ): Promise<Map<string, InteractionStats>> {
    if (!this.client) return new Map();

    if (windowDays <= 0) {
      log.warn('Invalid windowDays for interaction aggregation', { tenantId, indexId, windowDays });
      return new Map();
    }

    try {
      const result = await this.client.query({
        query: `
          SELECT
            attribute_type,
            countIf(interaction_type = 'impression') AS impressions,
            countIf(interaction_type = 'click') AS clicks,
            uniqExact(user_id) AS unique_users
          FROM ${TABLE}
          WHERE tenant_id = {tenantId:String}
            AND index_id = {indexId:String}
            AND created_at >= now() - INTERVAL {windowDays:UInt32} DAY
          GROUP BY attribute_type
          LIMIT {maxTypes:UInt32}
        `,
        query_params: { tenantId, indexId, windowDays, maxTypes: MAX_ATTRIBUTE_TYPES },
        format: 'JSONEachRow',
      });

      const rows = await result.json<InteractionRow>();

      const stats = new Map<string, InteractionStats>();
      for (const row of rows) {
        const impressions = parseInt(row.impressions, 10) || 0;
        const clicks = parseInt(row.clicks, 10) || 0;
        const uniqueUsers = parseInt(row.unique_users, 10) || 0;
        stats.set(row.attribute_type, {
          impressions,
          clicks,
          uniqueUsers,
          clickRate: impressions > 0 ? clicks / impressions : 0,
        });
      }
      return stats;
    } catch (error) {
      log.error('Failed to aggregate interactions', {
        tenantId,
        indexId,
        error: error instanceof Error ? error.message : String(error),
      });
      return new Map(); // fail-open
    }
  }
}
