/**
 * AggregateEvalRun — Restate activity for computing run-level aggregates.
 *
 * After all conversations are judged, this activity:
 * 1. Flushes buffered ClickHouse writers (ensure all scores are written)
 * 2. Queries eval_scores for the run's scores
 * 3. Computes summary statistics (mean, stdDev, 95% CI, Pass@k, Pass^k)
 * 4. Detects regressions against baseline run (R3)
 * 5. Updates EvalRun document in MongoDB with summary + status
 *
 * Config:
 *   runId:               string
 *   tenantId:            string
 *   projectId:           string
 *   evalSetId:           string
 *   baselineRunId:       string — optional, for regression detection
 *   regressionThreshold: number — max acceptable score drop (default: 0.5)
 */
import * as restate from '@restatedev/restate-sdk';
import { createLogger } from '@abl/compiler/platform';
import { evalMetrics } from './eval-metrics.js';
import { getConversationWriter, getScoreWriter } from './eval-clickhouse-writers.js';
import { releaseRunSlot } from './eval-rate-limiter.js';
import type { PipelineStepContext, StepOutput } from '../../types.js';
import type { RunSummary, RegressionDetail } from './eval-types.js';
import { CH_DATABASE } from './eval-types.js';

const log = createLogger('eval-aggregate');

// ── ClickHouse Query Interface ──────────────────────────────────────

interface ClickHouseQueryClient {
  query(params: {
    query: string;
    query_params?: Record<string, unknown>;
    format: 'JSONEachRow';
  }): Promise<{ json(): Promise<unknown[]> }>;
}

async function getQueryClient(): Promise<ClickHouseQueryClient | null> {
  try {
    const mod = await import('@agent-platform/database/clickhouse');
    return mod.getClickHouseClient() as unknown as ClickHouseQueryClient;
  } catch {
    log.warn('ClickHouse client not available for aggregation');
    return null;
  }
}

// ── MongoDB Update Interface ────────────────────────────────────────

async function updateEvalRun(
  runId: string,
  tenantId: string,
  projectId: string,
  update: Record<string, unknown>,
): Promise<void> {
  const mongoose = await import('mongoose');
  const db = mongoose.default.connection;
  // Eval models use uuidv7 string _id, not ObjectId
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  await db
    .collection('eval_runs')
    .updateOne(
      { _id: runId as any, tenantId, projectId, status: { $ne: 'cancelled' } },
      { $set: update },
    );
}

// ── Statistical Helpers ─────────────────────────────────────────────

function computeStdDev(values: number[], mean: number): number {
  if (values.length < 2) return 0;
  const sumSquaredDiffs = values.reduce((sum, v) => sum + (v - mean) ** 2, 0);
  return Math.sqrt(sumSquaredDiffs / (values.length - 1)); // Sample std dev
}

function compute95CI(mean: number, stdDev: number, n: number): [number, number] {
  if (n < 2) return [mean, mean];
  // t-value for 95% CI approximation (normal for large n)
  const tValue = n > 30 ? 1.96 : 2.045; // Simplified
  const margin = tValue * (stdDev / Math.sqrt(n));
  return [mean - margin, mean + margin];
}

/**
 * Pass@k: Probability that at least 1 of k variants passes the threshold.
 * P(at least 1 pass in k) = 1 - (1 - passRate)^k
 */
function computePassAtK(passRate: number, k: number): number {
  return 1 - Math.pow(1 - passRate, k);
}

/**
 * Pass^k: Probability that ALL k variants pass the threshold.
 * P(all pass in k) = passRate^k
 */
function computePassExpK(passRate: number, k: number): number {
  return Math.pow(passRate, k);
}

// ── Service Definition ──────────────────────────────────────────────

export const aggregateEvalRunService = restate.service({
  name: 'AggregateEvalRun',
  handlers: {
    execute: async (ctx: restate.Context, input: PipelineStepContext): Promise<StepOutput> => {
      const startTime = Date.now();
      const {
        runId,
        tenantId: configTenantId,
        projectId: configProjectId,
        evalSetId,
        baselineRunId,
        regressionThreshold = 0.5,
        variants = 3,
      } = input.config as {
        runId: string;
        tenantId?: string;
        projectId?: string;
        evalSetId: string;
        baselineRunId?: string;
        regressionThreshold?: number;
        variants?: number;
      };

      const tenantId = configTenantId ?? input.tenantId;
      const projectId = configProjectId ?? input.projectId ?? '';
      const attrs = { tenant_id: tenantId, project_id: projectId };

      if (!runId) {
        return {
          status: 'fail',
          data: { error: 'AggregateEvalRun requires runId in config' },
          durationMs: Date.now() - startTime,
        };
      }

      try {
        // Step 1: Flush buffered writers to ensure all data is written
        await ctx.run('flush-writers', async () => {
          await Promise.all([getConversationWriter().flushAll(), getScoreWriter().flushAll()]);
          // Small delay for ClickHouse eventual consistency
          await new Promise((resolve) => setTimeout(resolve, 1_000));
        });

        // Step 2: Query scores from ClickHouse
        const client = await getQueryClient();
        if (!client) {
          return {
            status: 'fail',
            data: { error: 'ClickHouse client not available for aggregation' },
            durationMs: Date.now() - startTime,
          };
        }

        const scoresResult = await ctx.run('query-scores', async () => {
          const result = await client.query({
            query: `
              SELECT
                evaluator_id,
                score,
                passed,
                confidence,
                judge_cost,
                judge_tokens_used,
                persona_id,
                scenario_id,
                variant_index
              FROM ${CH_DATABASE}.eval_scores
              WHERE tenant_id = {tenantId:String}
                AND project_id = {projectId:String}
                AND run_id = {runId:String}
              ORDER BY evaluator_id, persona_id, scenario_id, variant_index
            `,
            query_params: { tenantId, projectId, runId },
            format: 'JSONEachRow',
          });
          return result.json();
        });

        const scores = scoresResult as Array<{
          evaluator_id: string;
          score: number;
          passed: number;
          confidence: number;
          judge_cost: number;
          judge_tokens_used: number;
          persona_id: string;
          scenario_id: string;
          variant_index: number;
        }>;

        // Query conversation count and cost aggregates
        const convResult = await ctx.run('query-conversations', async () => {
          const result = await client.query({
            query: `
              SELECT
                count() as cnt,
                sum(duration_ms) as total_duration,
                sum(estimated_cost) as total_cost,
                sum(customer_visible_cost) as total_customer_visible_cost,
                sum(has_error) as error_count
              FROM ${CH_DATABASE}.eval_conversations
              WHERE tenant_id = {tenantId:String}
                AND project_id = {projectId:String}
                AND run_id = {runId:String}
            `,
            query_params: { tenantId, projectId, runId },
            format: 'JSONEachRow',
          });
          return result.json();
        });

        const convStats = (
          convResult as Array<{
            cnt: number;
            total_duration: number;
            total_cost: number;
            total_customer_visible_cost: number;
            error_count: number;
          }>
        )[0] ?? {
          cnt: 0,
          total_duration: 0,
          total_cost: 0,
          total_customer_visible_cost: 0,
          error_count: 0,
        };

        // Query per-model cost breakdown (aggregate cost_by_model JSON across conversations)
        const costByModelResult = await ctx.run('query-cost-by-model', async () => {
          const result = await client.query({
            query: `
              SELECT cost_by_model
              FROM ${CH_DATABASE}.eval_conversations
              WHERE tenant_id = {tenantId:String}
                AND project_id = {projectId:String}
                AND run_id = {runId:String}
                AND cost_by_model != ''
                AND cost_by_model != '{}'
            `,
            query_params: { tenantId, projectId, runId },
            format: 'JSONEachRow',
          });
          return result.json();
        });

        // Aggregate cost_by_model across all conversations
        const aggregatedCostByModel: Record<string, number> = {};
        for (const row of costByModelResult as Array<{ cost_by_model: string }>) {
          try {
            const parsed = JSON.parse(row.cost_by_model) as Record<string, number>;
            for (const [model, cost] of Object.entries(parsed)) {
              aggregatedCostByModel[model] = (aggregatedCostByModel[model] ?? 0) + Number(cost);
            }
          } catch {
            // Skip malformed JSON rows
          }
        }

        // Step 3: Compute summary statistics
        const allScores = scores.map((s) => Number(s.score));
        const avgScore =
          allScores.length > 0 ? allScores.reduce((a, b) => a + b, 0) / allScores.length : 0;
        const stdDev = computeStdDev(allScores, avgScore);
        const ci = compute95CI(avgScore, stdDev, allScores.length);
        const passRate =
          allScores.length > 0 ? scores.filter((s) => s.passed === 1).length / scores.length : 0;

        // Scores by evaluator
        const scoresByEvaluator: Record<string, number> = {};
        const evaluatorScores = new Map<string, number[]>();
        for (const s of scores) {
          if (!evaluatorScores.has(s.evaluator_id)) {
            evaluatorScores.set(s.evaluator_id, []);
          }
          evaluatorScores.get(s.evaluator_id)!.push(Number(s.score));
        }
        for (const [evalId, evalScores] of evaluatorScores) {
          scoresByEvaluator[evalId] = evalScores.reduce((a, b) => a + b, 0) / evalScores.length;
        }

        const totalJudgeCost = scores.reduce((sum, s) => sum + Number(s.judge_cost), 0);
        const durationMs = Date.now() - startTime;

        // Determine if the run is partial (some conversations had errors)
        const hasPartialResults = Number(convStats.error_count) > 0;

        const summary: RunSummary = {
          totalConversations: Number(convStats.cnt),
          totalEvaluations: scores.length,
          avgScore: Math.round(avgScore * 1000) / 1000,
          scoresByEvaluator,
          durationMs: Number(convStats.total_duration),
          estimatedCost: Number(convStats.total_cost),
          estimatedCostByModel: aggregatedCostByModel,
          customerVisibleCost: Number(convStats.total_customer_visible_cost),
          actualCost: totalJudgeCost + Number(convStats.total_cost),
          stdDev: Math.round(stdDev * 1000) / 1000,
          confidenceInterval: [Math.round(ci[0] * 1000) / 1000, Math.round(ci[1] * 1000) / 1000],
          passAtK: Math.round(computePassAtK(passRate, variants) * 1000) / 1000,
          passExpK: Math.round(computePassExpK(passRate, variants) * 1000) / 1000,
          partial: hasPartialResults,
        };

        // Step 4: Regression detection (R3)
        let regressionDetected = false;
        const regressionDetails: RegressionDetail[] = [];

        if (baselineRunId) {
          const baselineResult = await ctx.run('query-baseline', async () => {
            const result = await client.query({
              query: `
                SELECT
                  evaluator_id,
                  persona_id,
                  scenario_id,
                  avg(score) as avg_score
                FROM ${CH_DATABASE}.eval_scores
                WHERE tenant_id = {tenantId:String}
                  AND project_id = {projectId:String}
                  AND run_id = {baselineRunId:String}
                GROUP BY evaluator_id, persona_id, scenario_id
              `,
              query_params: { tenantId, projectId, baselineRunId },
              format: 'JSONEachRow',
            });
            return result.json();
          });

          const baselineScores = baselineResult as Array<{
            evaluator_id: string;
            persona_id: string;
            scenario_id: string;
            avg_score: number;
          }>;

          // Build baseline lookup
          const baselineMap = new Map<string, number>();
          for (const b of baselineScores) {
            const key = `${b.evaluator_id}:${b.persona_id}:${b.scenario_id}`;
            baselineMap.set(key, Number(b.avg_score));
          }

          // Compare current averages against baseline
          const currentAvgs = new Map<
            string,
            {
              sum: number;
              count: number;
              evaluatorId: string;
              personaId: string;
              scenarioId: string;
            }
          >();
          for (const s of scores) {
            const key = `${s.evaluator_id}:${s.persona_id}:${s.scenario_id}`;
            const existing = currentAvgs.get(key) ?? {
              sum: 0,
              count: 0,
              evaluatorId: s.evaluator_id,
              personaId: s.persona_id,
              scenarioId: s.scenario_id,
            };
            existing.sum += Number(s.score);
            existing.count++;
            currentAvgs.set(key, existing);
          }

          for (const [key, current] of currentAvgs) {
            const baselineScore = baselineMap.get(key);
            if (baselineScore === undefined) continue;

            const currentScore = current.sum / current.count;
            const delta = currentScore - baselineScore;

            if (delta < -regressionThreshold) {
              regressionDetected = true;
              regressionDetails.push({
                evaluatorId: current.evaluatorId,
                personaId: current.personaId,
                scenarioId: current.scenarioId,
                baselineScore,
                currentScore: Math.round(currentScore * 1000) / 1000,
                delta: Math.round(delta * 1000) / 1000,
              });
            }
          }

          if (regressionDetected) {
            log.warn('Regression detected', {
              runId,
              baselineRunId,
              regressionCount: regressionDetails.length,
              threshold: regressionThreshold,
            });
            evalMetrics.regressionCount.add(regressionDetails.length, attrs);
          }
        }

        // Step 5: Update EvalRun in MongoDB
        // Restate retries transient failures; permanent failures propagate to the catch block
        // which does a best-effort status=failed update.
        await ctx.run('update-run', async () => {
          await updateEvalRun(runId, tenantId, projectId, {
            status: 'completed',
            summary,
            regressionDetected,
            regressionDetails: regressionDetails.length > 0 ? regressionDetails : undefined,
            completedAt: new Date(),
          });
        });

        // Release run slot
        releaseRunSlot(tenantId);

        // Record metrics
        evalMetrics.runsCompleted.add(1, attrs);
        evalMetrics.runDuration.record(durationMs, attrs);
        evalMetrics.runCost.record(summary.actualCost, attrs);

        log.info('Eval run completed', {
          runId,
          avgScore: summary.avgScore,
          totalConversations: summary.totalConversations,
          totalEvaluations: summary.totalEvaluations,
          totalCost: summary.actualCost,
          regressionDetected,
          durationMs,
        });

        return {
          status: 'success',
          data: {
            summary,
            regressionDetected,
            regressionDetails,
          },
          durationMs,
        };
      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        log.error('Eval run aggregation failed', { runId, error: msg });

        // Best-effort: mark run as failed (swallow errors so we still return the failure result)
        await updateEvalRun(runId, tenantId, projectId, {
          status: 'failed',
          completedAt: new Date(),
        }).catch((updateErr) => {
          log.error('Failed to mark EvalRun as failed in MongoDB', {
            runId,
            error: updateErr instanceof Error ? updateErr.message : String(updateErr),
          });
        });

        releaseRunSlot(tenantId);
        evalMetrics.runsFailed.add(1, attrs);

        return {
          status: 'fail',
          data: { error: msg },
          durationMs: Date.now() - startTime,
        };
      }
    },
  },
});

export type AggregateEvalRunService = typeof aggregateEvalRunService;
