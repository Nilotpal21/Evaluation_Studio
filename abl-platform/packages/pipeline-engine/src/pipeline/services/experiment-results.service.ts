/**
 * Experiment Results Service
 *
 * Plain TypeScript class that computes A/B experiment results by querying
 * ClickHouse for assignment data and performing statistical significance
 * tests (t-test, chi-squared, power analysis).
 */

import { createLogger } from '@abl/compiler/platform';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';
import {
  tTest,
  chiSquared,
  normalCDF,
  minSampleSizeForEffect,
  confidenceInterval,
} from './experiment-stats.js';
import type {
  StoredExperimentResults,
  StoredSignificanceResult,
  IExperiment,
} from '../../schemas/experiment.schema.js';

const log = createLogger('experiment-results');

/** Significance threshold (p < 0.05). */
const SIGNIFICANCE_ALPHA = 0.05;

/** Minimum sample size per group when power analysis data is unavailable. */
const DEFAULT_MIN_SAMPLE_SIZE = 100;

export interface GroupMetrics {
  group: 'control' | 'experiment';
  sampleSize: number;
  metrics: Record<string, number>;
}

export interface SignificanceResult {
  metric: string;
  controlMean: number;
  experimentMean: number;
  pValue: number;
  significant: boolean;
  confidenceInterval: [number, number];
  lift: number;
}

export interface ExperimentResults {
  experimentId: string;
  controlGroup: GroupMetrics;
  experimentGroup: GroupMetrics;
  significance: SignificanceResult[];
  sampleSizeAdequate: boolean;
  minSampleSize: number;
}

// ─── ClickHouse Row Types ──────────────────────────────────────────────

interface SessionMetricsRow {
  experiment_group: string;
  sample_size: string;
  avg_duration: string;
  error_rate: string;
  avg_turns: string;
}

interface EvalScoresRow {
  experiment_group: string;
  avg_score: string;
  std_score: string;
  score_count: string;
}

export class ExperimentResultsService {
  /**
   * Compute experiment results by querying ClickHouse for session and eval
   * metrics, then running statistical significance tests for each success metric.
   *
   * @param experimentId - The experiment document ID
   * @param tenantId - Tenant scope for ClickHouse queries
   * @param experiment - The experiment document (must include successMetrics)
   * @returns StoredExperimentResults ready to persist on the experiment document
   */
  async computeExperimentResults(
    experimentId: string,
    tenantId: string,
    experiment: Pick<IExperiment, 'successMetrics'>,
  ): Promise<StoredExperimentResults> {
    const ch = getClickHouseClient();

    // ── Query 1: Session-level metrics (duration, error rate, turns) ──
    const sessionQuery = `
      SELECT
        experiment_group,
        count() AS sample_size,
        avg(overall_score) AS avg_duration,
        avg(flagged) AS error_rate,
        count() AS avg_turns
      FROM abl_platform.experiment_assignments AS ea
      LEFT JOIN abl_platform.quality_evaluations AS qe
        ON ea.session_id = qe.session_id AND ea.tenant_id = qe.tenant_id
      WHERE ea.experiment_id = {experimentId:String}
        AND ea.tenant_id = {tenantId:String}
      GROUP BY experiment_group
      SETTINGS max_execution_time = 30
    `;

    const sessionResult = await ch.query({
      query: sessionQuery,
      query_params: { experimentId, tenantId },
    });
    const sessionRows = ((await sessionResult.json()) as { data: SessionMetricsRow[] }).data;

    // ── Query 2: Eval production scores (per-evaluator scores) ──
    const evalQuery = `
      SELECT
        experiment_group,
        avg(score) AS avg_score,
        stddevPop(score) AS std_score,
        count() AS score_count
      FROM abl_platform.experiment_assignments AS ea
      LEFT JOIN abl_platform.eval_production_scores AS eps
        ON ea.session_id = eps.session_id AND ea.tenant_id = eps.tenant_id
      WHERE ea.experiment_id = {experimentId:String}
        AND ea.tenant_id = {tenantId:String}
      GROUP BY experiment_group
      SETTINGS max_execution_time = 30
    `;

    const evalResult = await ch.query({
      query: evalQuery,
      query_params: { experimentId, tenantId },
    });
    const evalRows = ((await evalResult.json()) as { data: EvalScoresRow[] }).data;

    // ── Map rows by group ──
    const controlSession = sessionRows.find((r) => r.experiment_group === 'control');
    const experimentSession = sessionRows.find((r) => r.experiment_group === 'experiment');
    const controlEval = evalRows.find((r) => r.experiment_group === 'control');
    const experimentEval = evalRows.find((r) => r.experiment_group === 'experiment');

    const controlSampleSize = Number(controlSession?.sample_size ?? 0);
    const experimentSampleSize = Number(experimentSession?.sample_size ?? 0);

    // ── Build per-group metric maps ──
    const controlMetrics: Record<string, number> = {
      avg_duration: Number(controlSession?.avg_duration ?? 0),
      error_rate: Number(controlSession?.error_rate ?? 0),
      avg_turns: Number(controlSession?.avg_turns ?? 0),
      avg_score: Number(controlEval?.avg_score ?? 0),
    };

    const experimentMetrics: Record<string, number> = {
      avg_duration: Number(experimentSession?.avg_duration ?? 0),
      error_rate: Number(experimentSession?.error_rate ?? 0),
      avg_turns: Number(experimentSession?.avg_turns ?? 0),
      avg_score: Number(experimentEval?.avg_score ?? 0),
    };

    // Standard deviations from eval scores (session metrics don't have std from the query)
    const controlStd: Record<string, number> = {
      avg_score: Number(controlEval?.std_score ?? 0),
    };
    const experimentStd: Record<string, number> = {
      avg_score: Number(experimentEval?.std_score ?? 0),
    };

    const controlEvalCount = Number(controlEval?.score_count ?? controlSampleSize);
    const experimentEvalCount = Number(experimentEval?.score_count ?? experimentSampleSize);

    // ── Compute significance for each success metric ──
    const significance: StoredSignificanceResult[] = experiment.successMetrics.map((metric) => {
      const cMean = controlMetrics[metric] ?? 0;
      const eMean = experimentMetrics[metric] ?? 0;
      const cStd = controlStd[metric] ?? 0;
      const eStd = experimentStd[metric] ?? 0;

      // Use eval count for score-based metrics, session count for session-based
      const isEvalMetric = metric === 'avg_score';
      const n1 = isEvalMetric ? controlEvalCount : controlSampleSize;
      const n2 = isEvalMetric ? experimentEvalCount : experimentSampleSize;

      // For metrics with known std dev, use t-test
      // For rate metrics (error_rate), use chi-squared
      let pValue: number;
      if (metric === 'error_rate' && controlSampleSize > 0 && experimentSampleSize > 0) {
        const successControl = Math.round(cMean * controlSampleSize);
        const successExperiment = Math.round(eMean * experimentSampleSize);
        const chi = this.chiSquared(
          successControl,
          controlSampleSize,
          successExperiment,
          experimentSampleSize,
        );
        pValue = chi.pValue;
      } else if (n1 > 0 && n2 > 0) {
        const tt = this.tTest(cMean, eMean, cStd, eStd, n1, n2);
        pValue = tt.pValue;
      } else {
        pValue = 1;
      }

      const ci =
        n1 > 0 && n2 > 0
          ? this.confidenceInterval(cMean, eMean, cStd, eStd, n1, n2)
          : ([0, 0] as [number, number]);
      const lift = cMean !== 0 ? (eMean - cMean) / cMean : 0;

      return {
        metric,
        controlMean: cMean,
        experimentMean: eMean,
        pValue,
        significant: pValue < SIGNIFICANCE_ALPHA,
        confidenceInterval: ci,
        lift: Math.round(lift * 10000) / 10000,
      };
    });

    const sampleSizeAdequate =
      controlSampleSize >= DEFAULT_MIN_SAMPLE_SIZE &&
      experimentSampleSize >= DEFAULT_MIN_SAMPLE_SIZE;

    log.info('Experiment results computed', {
      experimentId,
      tenantId,
      controlSampleSize,
      experimentSampleSize,
      metricsCount: significance.length,
      sampleSizeAdequate,
    });

    return {
      controlSampleSize,
      experimentSampleSize,
      significance,
      sampleSizeAdequate,
      computedAt: new Date(),
    };
  }

  tTest(
    mean1: number,
    mean2: number,
    std1: number,
    std2: number,
    n1: number,
    n2: number,
  ): { tStat: number; pValue: number } {
    return tTest(mean1, mean2, std1, std2, n1, n2);
  }

  normalCDF(x: number): number {
    return normalCDF(x);
  }

  chiSquared(
    successControl: number,
    totalControl: number,
    successExperiment: number,
    totalExperiment: number,
  ): { chiSq: number; pValue: number } {
    return chiSquared(successControl, totalControl, successExperiment, totalExperiment);
  }

  minSampleSizeForEffect(
    baseline: number,
    mde: number,
    _alpha: number = 0.05,
    _power: number = 0.8,
  ): number {
    return minSampleSizeForEffect(baseline, mde, _alpha, _power);
  }

  confidenceInterval(
    mean1: number,
    mean2: number,
    std1: number,
    std2: number,
    n1: number,
    n2: number,
    _alpha: number = 0.05,
  ): [number, number] {
    return confidenceInterval(mean1, mean2, std1, std2, n1, n2, _alpha);
  }
}
