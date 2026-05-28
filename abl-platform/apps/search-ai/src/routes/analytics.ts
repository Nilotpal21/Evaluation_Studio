/**
 * Analytics Routes
 *
 * Cross-cutting analytics endpoints for field mapping coverage metrics.
 * Aggregates FieldMapping data to show rule-based vs. LLM vs. manual mapping coverage.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { requirePermission } from '@agent-platform/shared-auth';
import type { IFieldMapping, IConnectorConfig } from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';
import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';
import { getSharedRedisClient } from '../workers/shared.js';

const FieldMapping = getLazyModel<IFieldMapping>('FieldMapping');
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');

const router: RouterType = Router();
const logger = createLogger('analytics-routes');

// ─── Redis Cache ──────────────────────────────────────────────────────────────

const CACHE_KEY_PREFIX = 'search-ai:analytics:mapping-coverage';
const CACHE_TTL_SECONDS = 300; // 5 minutes

let redisClient: RedisClient | null = null;

function getAnalyticsRedis(): RedisClient | null {
  if (!redisClient) {
    redisClient = getSharedRedisClient();
  }
  return redisClient;
}

async function getCachedOrCompute<T>(
  key: string,
  ttlSeconds: number,
  computeFn: () => Promise<T>,
): Promise<T> {
  const redis = getAnalyticsRedis();
  if (redis) {
    try {
      const cached = await redis.get(key);
      if (cached) {
        return JSON.parse(cached);
      }
    } catch (err) {
      logger.warn('Redis cache read failed, falling back to MongoDB', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const result = await computeFn();

  if (redis) {
    try {
      await redis.setex(key, ttlSeconds, JSON.stringify(result));
    } catch (err) {
      logger.warn('Redis cache write failed', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}

// ─── Coverage Response Types ──────────────────────────────────────────────────

interface ConnectorCoverage {
  connectorId: string;
  connectorType: string | null;
  totalMappings: number;
  ruleBasedCount: number;
  llmCount: number;
  manualCount: number;
  ruleBasedPercentage: number;
  statusBreakdown: {
    active: number;
    suggested: number;
    rejected: number;
  };
}

// ─── Routes ───────────────────────────────────────────────────────────────────

/**
 * GET /mapping-coverage
 *
 * Returns aggregated mapping coverage metrics grouped by connectorId.
 * Shows rule-based vs. LLM vs. manual mapping counts and percentages.
 *
 * Query params:
 *   - canonicalSchemaId: Optional filter by canonical schema ID
 *
 * Response:
 * {
 *   success: true,
 *   data: {
 *     coverage: ConnectorCoverage[]
 *   }
 * }
 */
router.get(
  '/mapping-coverage',
  requirePermission('admin:analytics:read'),
  async (req: Request, res: Response) => {
    try {
      const tenantId = req.tenantContext!.tenantId;
      const { canonicalSchemaId } = req.query;

      // Build cache key
      const schemaFilter = canonicalSchemaId ? String(canonicalSchemaId) : 'all';
      const cacheKey = `${CACHE_KEY_PREFIX}:${tenantId}:${schemaFilter}`;

      const coverageData = await getCachedOrCompute<{ coverage: ConnectorCoverage[] }>(
        cacheKey,
        CACHE_TTL_SECONDS,
        async () => {
          // Build match stage
          const matchStage: Record<string, unknown> = { tenantId };
          if (canonicalSchemaId) {
            matchStage.canonicalSchemaId = String(canonicalSchemaId);
          }

          // Aggregation pipeline:
          // 1. Match by tenantId (and optional canonicalSchemaId)
          // 2. Group by connectorId + suggestedBy to get counts per source type
          // 3. Group by connectorId + status to get status breakdown
          // We run two aggregations for clarity and correctness.

          // Aggregation 1: Group by connectorId and suggestedBy
          const suggestedByPipeline = [
            { $match: matchStage },
            {
              $group: {
                _id: { connectorId: '$connectorId', suggestedBy: '$suggestedBy' },
                count: { $sum: 1 },
              },
            },
          ];

          // Aggregation 2: Group by connectorId and status
          const statusPipeline = [
            { $match: matchStage },
            {
              $group: {
                _id: { connectorId: '$connectorId', status: '$status' },
                count: { $sum: 1 },
              },
            },
          ];

          const [suggestedByResults, statusResults] = await Promise.all([
            FieldMapping.aggregate(suggestedByPipeline).exec(),
            FieldMapping.aggregate(statusPipeline).exec(),
          ]);

          // Build per-connector maps
          const connectorMap = new Map<
            string,
            {
              ruleBasedCount: number;
              llmCount: number;
              manualCount: number;
              totalMappings: number;
              statusBreakdown: { active: number; suggested: number; rejected: number };
            }
          >();

          for (const row of suggestedByResults) {
            const connectorId = row._id.connectorId as string;
            const suggestedBy = row._id.suggestedBy as string;
            const count = row.count as number;

            if (!connectorMap.has(connectorId)) {
              connectorMap.set(connectorId, {
                ruleBasedCount: 0,
                llmCount: 0,
                manualCount: 0,
                totalMappings: 0,
                statusBreakdown: { active: 0, suggested: 0, rejected: 0 },
              });
            }

            const entry = connectorMap.get(connectorId)!;
            entry.totalMappings += count;

            if (suggestedBy === 'rules') {
              entry.ruleBasedCount += count;
            } else if (suggestedBy === 'llm') {
              entry.llmCount += count;
            } else if (suggestedBy === 'user') {
              entry.manualCount += count;
            }
          }

          for (const row of statusResults) {
            const connectorId = row._id.connectorId as string;
            const status = row._id.status as string;
            const count = row.count as number;

            if (!connectorMap.has(connectorId)) {
              connectorMap.set(connectorId, {
                ruleBasedCount: 0,
                llmCount: 0,
                manualCount: 0,
                totalMappings: 0,
                statusBreakdown: { active: 0, suggested: 0, rejected: 0 },
              });
            }

            const entry = connectorMap.get(connectorId)!;
            if (status === 'active') {
              entry.statusBreakdown.active += count;
            } else if (status === 'suggested') {
              entry.statusBreakdown.suggested += count;
            } else if (status === 'rejected') {
              entry.statusBreakdown.rejected += count;
            }
          }

          // Resolve connectorType via ConnectorConfig lookup
          const connectorIds = Array.from(connectorMap.keys());
          const connectorTypeMap = new Map<string, string>();

          if (connectorIds.length > 0) {
            try {
              const configs = await ConnectorConfig.find({
                _id: { $in: connectorIds },
                tenantId,
              })
                .select('_id connectorType')
                .lean();

              for (const config of configs) {
                connectorTypeMap.set(String(config._id), config.connectorType);
              }
            } catch (err) {
              logger.warn('Failed to resolve connectorType from ConnectorConfig', {
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }

          // Build final coverage array
          const coverage: ConnectorCoverage[] = [];
          for (const [connectorId, entry] of connectorMap) {
            const ruleBasedPercentage =
              entry.totalMappings > 0
                ? Math.round((entry.ruleBasedCount / entry.totalMappings) * 10000) / 100
                : 0;

            coverage.push({
              connectorId,
              connectorType: connectorTypeMap.get(connectorId) ?? null,
              totalMappings: entry.totalMappings,
              ruleBasedCount: entry.ruleBasedCount,
              llmCount: entry.llmCount,
              manualCount: entry.manualCount,
              ruleBasedPercentage,
              statusBreakdown: entry.statusBreakdown,
            });
          }

          return { coverage };
        },
      );

      res.json({
        success: true,
        data: coverageData,
      });
    } catch (error) {
      logger.error('Failed to compute mapping coverage analytics', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        error: {
          code: 'ANALYTICS_FAILED',
          message: 'Failed to compute mapping coverage',
        },
      });
    }
  },
);

export default router;
