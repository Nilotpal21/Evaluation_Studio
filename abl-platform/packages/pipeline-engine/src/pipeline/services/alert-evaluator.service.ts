/**
 * AlertEvaluator — Restate activity service for threshold-based alert evaluation.
 *
 * Loads enabled alert rules from MongoDB for a given tenant/project, queries
 * ClickHouse for each rule's metric value within its configured time window,
 * and fires alerts when thresholds are breached (respecting cooldown periods).
 *
 * Updates each rule's lastEvaluatedAt, lastFiredAt, and status in MongoDB.
 *
 * Input config: { tenantId: string; projectId: string }
 */
import * as restate from '@restatedev/restate-sdk';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import { createLogger } from '@abl/compiler/platform';
import type { PipelineStepContext, StepOutput } from '../types.js';

const log = createLogger('alert-evaluator');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface AlertInfo {
  ruleId: string;
  ruleName: string;
  metric: string;
  sourceTable: string;
  aggregation: string;
  windowMinutes: number;
  condition: string;
  threshold: number;
  actualValue: number;
  channels: Array<{ type: string; config: Record<string, unknown> }>;
  firedAt: Date;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Evaluate a threshold condition.
 * Returns true when the value satisfies the condition relative to the threshold.
 */
export function evaluateCondition(value: number, condition: string, threshold: number): boolean {
  if (isNaN(value)) return false;
  switch (condition) {
    case 'gt':
      return value > threshold;
    case 'lt':
      return value < threshold;
    case 'gte':
      return value >= threshold;
    case 'lte':
      return value <= threshold;
    default:
      return false;
  }
}

/**
 * Validate a ClickHouse identifier (table name, column name).
 * Only allows alphanumeric characters, underscores, and dots (for qualified names).
 */
const SAFE_IDENTIFIER_RE = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;

function isSafeIdentifier(value: string): boolean {
  return SAFE_IDENTIFIER_RE.test(value) && value.length <= 128;
}

/**
 * Build the ClickHouse aggregation expression.
 * Handles standard functions and quantile-based percentiles.
 */
function buildAggregationExpr(aggregation: string, metric: string): string {
  switch (aggregation) {
    case 'p95':
      return `quantile(0.95)(${metric})`;
    case 'p99':
      return `quantile(0.99)(${metric})`;
    default:
      return `${aggregation}(${metric})`;
  }
}

/**
 * Check whether a rule is within its cooldown period.
 */
function isInCooldown(lastFiredAt: Date | undefined, cooldownMinutes: number): boolean {
  if (!lastFiredAt || cooldownMinutes <= 0) return false;
  const cooldownMs = cooldownMinutes * 60 * 1000;
  return Date.now() - new Date(lastFiredAt).getTime() < cooldownMs;
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const alertEvaluatorService = restate.service({
  name: 'AlertEvaluator',
  handlers: {
    execute: async (
      ctx: restate.Context,
      input: { stepContext?: PipelineStepContext; config: { tenantId: string; projectId: string } },
    ): Promise<StepOutput> => {
      const startTime = Date.now();
      const { tenantId, projectId } = input.config;

      if (!tenantId || !projectId) {
        return {
          status: 'fail',
          data: { error: 'AlertEvaluator requires tenantId and projectId in config' },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        // Load enabled alert rules from MongoDB
        const rules = await ctx.run('load-alert-rules', async () => {
          const { AlertRuleModel } = await import('../../schemas/alert-rule.schema.js');
          const MAX_RULES_PER_EVAL = 100;
          const query = AlertRuleModel.find({
            tenantId,
            projectId,
            enabled: true,
          });
          // Apply limit if supported (Mongoose query builder)
          const docs = await (typeof query.limit === 'function'
            ? query.limit(MAX_RULES_PER_EVAL)
            : query);
          return docs;
        });

        if (!rules || rules.length === 0) {
          log.debug('No enabled alert rules found', { tenantId, projectId });
          return {
            status: 'success',
            data: {
              alerts: [],
              summary: { totalRules: 0, fired: 0, ok: 0, cooldown: 0 },
            },
            durationMs: Date.now() - startTime,
          };
        }

        const alerts: AlertInfo[] = [];
        let firedCount = 0;
        let okCount = 0;
        let cooldownCount = 0;

        // Evaluate each rule
        for (const rule of rules) {
          const now = new Date();

          // Validate identifiers before interpolating into SQL
          if (!isSafeIdentifier(rule.sourceTable) || !isSafeIdentifier(rule.metric)) {
            log.warn('Alert rule has unsafe identifier, skipping', {
              ruleId: String(rule._id),
              sourceTable: rule.sourceTable,
              metric: rule.metric,
            });
            okCount++;
            continue;
          }

          // Query ClickHouse for metric value
          const metricValue = await ctx.run(`query-metric-${String(rule._id)}`, async () => {
            const ch = getClickHouseClient();
            const aggExpr = buildAggregationExpr(rule.aggregation, rule.metric);
            const result = await ch.query({
              query: `SELECT ${aggExpr} as value FROM ${rule.sourceTable} WHERE tenant_id = {tenantId:String} AND project_id = {projectId:String} AND session_started_at >= now() - INTERVAL ${rule.windowMinutes} MINUTE`,
              query_params: { tenantId, projectId },
            });
            const rows = await result.json();
            const data = rows as unknown as Array<{ value: number }>;
            if (!data || data.length === 0) return null;
            return Number(data[0].value);
          });

          // Update lastEvaluatedAt for every rule
          await ctx.run(`update-evaluated-${String(rule._id)}`, async () => {
            const { AlertRuleModel } = await import('../../schemas/alert-rule.schema.js');
            await AlertRuleModel.updateOne(
              { _id: rule._id, tenantId },
              { $set: { lastEvaluatedAt: now } },
            );
          });

          // Handle null metric value (no data)
          if (metricValue === null || isNaN(metricValue)) {
            log.debug('No metric data for rule', {
              ruleId: String(rule._id),
              ruleName: rule.name,
            });
            okCount++;
            continue;
          }

          const conditionMet = evaluateCondition(metricValue, rule.condition, rule.threshold);

          if (conditionMet) {
            // Check cooldown
            if (isInCooldown(rule.lastFiredAt, rule.cooldownMinutes)) {
              log.debug('Rule in cooldown, skipping', {
                ruleId: String(rule._id),
                ruleName: rule.name,
              });
              cooldownCount++;

              await ctx.run(`update-cooldown-${String(rule._id)}`, async () => {
                const { AlertRuleModel } = await import('../../schemas/alert-rule.schema.js');
                await AlertRuleModel.updateOne(
                  { _id: rule._id, tenantId },
                  { $set: { status: 'cooldown' } },
                );
              });
              continue;
            }

            // Fire alert
            log.info('Alert fired', {
              ruleId: String(rule._id),
              ruleName: rule.name,
              metric: rule.metric,
              value: metricValue,
              threshold: rule.threshold,
              condition: rule.condition,
            });

            firedCount++;

            await ctx.run(`update-firing-${String(rule._id)}`, async () => {
              const { AlertRuleModel } = await import('../../schemas/alert-rule.schema.js');
              await AlertRuleModel.updateOne(
                { _id: rule._id, tenantId },
                { $set: { status: 'firing', lastFiredAt: now } },
              );
            });

            alerts.push({
              ruleId: String(rule._id),
              ruleName: rule.name,
              metric: rule.metric,
              sourceTable: rule.sourceTable,
              aggregation: rule.aggregation,
              windowMinutes: rule.windowMinutes,
              condition: rule.condition,
              threshold: rule.threshold,
              actualValue: metricValue,
              channels: rule.channels,
              firedAt: now,
            });
          } else {
            // Condition not met — mark as ok
            okCount++;

            await ctx.run(`update-ok-${String(rule._id)}`, async () => {
              const { AlertRuleModel } = await import('../../schemas/alert-rule.schema.js');
              await AlertRuleModel.updateOne(
                { _id: rule._id, tenantId },
                { $set: { status: 'ok' } },
              );
            });
          }
        }

        log.debug('Alert evaluation complete', {
          tenantId,
          projectId,
          totalRules: rules.length,
          fired: firedCount,
          ok: okCount,
          cooldown: cooldownCount,
        });

        return {
          status: 'success',
          data: {
            alerts,
            summary: {
              totalRules: rules.length,
              fired: firedCount,
              ok: okCount,
              cooldown: cooldownCount,
            },
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('AlertEvaluator failed', {
          tenantId,
          projectId,
          error: msg,
        });
        return {
          status: 'fail',
          data: { error: 'Alert evaluation failed' },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

/** Export the type for use by other Restate services calling this one. */
export type AlertEvaluatorService = typeof alertEvaluatorService;
