/**
 * Predictive Features Service
 *
 * Restate activity service that aggregates per-customer signals from ClickHouse
 * analytics tables and computes a weighted churn risk score.
 *
 * Exports the pure `computeChurnRisk` function for direct testing and reuse.
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import type { PipelineStepContext, StepOutput } from '../types.js';

const log = createLogger('compute-predictive-features');

// ---------------------------------------------------------------------------
// Feature weights for churn risk scoring
// ---------------------------------------------------------------------------

const FEATURE_WEIGHTS = {
  lowSentiment: 0.3,
  highEscalation: 0.25,
  repeatContact: 0.25,
  qualityTrend: 0.2,
} as const;

const THRESHOLDS = {
  lowSentimentThreshold: 0.3,
  highEscalationRate: 0.2,
  repeatContactDays: 7,
  repeatContactMin: 3,
  qualityDeclineSlope: -0.05,
} as const;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PredictiveFeatures {
  customerId: string;
  avgSentiment: number;
  escalationRate: number;
  repeatContactCount: number;
  qualityTrend: number;
  churnRiskScore: number;
  riskLevel: 'low' | 'medium' | 'high';
}

// ---------------------------------------------------------------------------
// Pure function — exported for testing and reuse
// ---------------------------------------------------------------------------

export function computeChurnRisk(features: {
  avgSentiment: number;
  escalationRate: number;
  repeatContactCount: number;
  qualityTrend: number;
}): { score: number; riskLevel: 'low' | 'medium' | 'high' } {
  let score = 0;

  if (features.avgSentiment < THRESHOLDS.lowSentimentThreshold) {
    score += FEATURE_WEIGHTS.lowSentiment * (1 - features.avgSentiment);
  }

  if (features.escalationRate > THRESHOLDS.highEscalationRate) {
    score += FEATURE_WEIGHTS.highEscalation * Math.min(features.escalationRate, 1);
  }

  if (features.repeatContactCount >= THRESHOLDS.repeatContactMin) {
    score += FEATURE_WEIGHTS.repeatContact * Math.min(features.repeatContactCount / 10, 1);
  }

  if (features.qualityTrend < THRESHOLDS.qualityDeclineSlope) {
    score += FEATURE_WEIGHTS.qualityTrend * Math.min(Math.abs(features.qualityTrend), 1);
  }

  score = Math.min(Math.round(score * 1000) / 1000, 1);
  const riskLevel = score >= 0.6 ? 'high' : score >= 0.3 ? 'medium' : 'low';

  return { score, riskLevel };
}

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export const computePredictiveFeaturesService = restate.service({
  name: 'ComputePredictiveFeatures',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const tenantId = input.tenantId;
      const projectId = input.projectId;

      if (!tenantId || !projectId) {
        return {
          status: 'fail',
          data: { error: 'Missing tenantId or projectId' },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        const lookbackDays = (input.config.lookbackDays as number) ?? 30;

        // Query aggregate customer features from ClickHouse
        const features = await ctx.run('query-features', async () => {
          const ch = getClickHouseClient();

          const result = await ch.query({
            query: `
              SELECT
                session_id as customer_id,
                avg(avg_sentiment) as avg_sentiment,
                countIf(avg_sentiment < 0.3) / count() as escalation_rate,
                count() as contact_count,
                0 as quality_trend
              FROM abl_platform.conversation_sentiment
              WHERE tenant_id = {tenantId:String}
                AND project_id = {projectId:String}
                AND session_started_at >= now() - INTERVAL ${lookbackDays} DAY
              GROUP BY session_id
              HAVING count() >= 1
              LIMIT 1000
            `,
            query_params: { tenantId, projectId },
          });

          return (
            (await result.json()) as {
              data: Array<{
                customer_id: string;
                avg_sentiment: number;
                escalation_rate: number;
                contact_count: number;
                quality_trend: number;
              }>;
            }
          ).data;
        });

        // Compute churn risk for each customer
        const results: PredictiveFeatures[] = [];
        for (const f of features) {
          const risk = computeChurnRisk({
            avgSentiment: Number(f.avg_sentiment),
            escalationRate: Number(f.escalation_rate),
            repeatContactCount: Number(f.contact_count),
            qualityTrend: Number(f.quality_trend),
          });

          results.push({
            customerId: f.customer_id,
            avgSentiment: Number(f.avg_sentiment),
            escalationRate: Number(f.escalation_rate),
            repeatContactCount: Number(f.contact_count),
            qualityTrend: Number(f.quality_trend),
            churnRiskScore: risk.score,
            riskLevel: risk.riskLevel,
          });
        }

        // Write results to ClickHouse
        if (results.length > 0) {
          await ctx.run('write-results', async () => {
            const ch = getClickHouseClient();
            await ch.insert({
              table: 'abl_platform.customer_predictive_features',
              values: results.map((r) => ({
                tenant_id: tenantId,
                project_id: projectId,
                customer_id: r.customerId,
                avg_sentiment: r.avgSentiment,
                escalation_rate: r.escalationRate,
                repeat_contact_count: r.repeatContactCount,
                quality_trend: r.qualityTrend,
                churn_risk_score: r.churnRiskScore,
                risk_level: r.riskLevel,
                run_id: (input.pipelineInput?.runId as string) ?? '',
                pipeline_id: input.pipelineId ?? '',
              })),
              format: 'JSONEachRow',
            });
          });
        }

        log.info('Predictive features computed', {
          tenantId,
          projectId,
          customerCount: results.length,
          highRisk: results.filter((r) => r.riskLevel === 'high').length,
        });

        return {
          status: 'success',
          data: {
            customersAnalyzed: results.length,
            highRisk: results.filter((r) => r.riskLevel === 'high').length,
            mediumRisk: results.filter((r) => r.riskLevel === 'medium').length,
            lowRisk: results.filter((r) => r.riskLevel === 'low').length,
          },
          durationMs: Date.now() - startTime,
        };
      } catch (error) {
        log.error('Failed to compute predictive features', {
          error: error instanceof Error ? error.message : String(error),
        });
        return {
          status: 'fail',
          data: { error: error instanceof Error ? error.message : String(error) },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type ComputePredictiveFeaturesService = typeof computePredictiveFeaturesService;
