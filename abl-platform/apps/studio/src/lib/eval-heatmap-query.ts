/**
 * Pure query builder for the eval heatmap ClickHouse query.
 *
 * Extracted so the dedup logic (argMax per variant) can be unit-tested
 * without a live ClickHouse connection.
 */

const CH_DATABASE = 'abl_platform';

export interface EvalHeatmapQueryParams extends Record<string, string> {
  tenantId: string;
  projectId: string;
  runId: string;
}

/**
 * Builds the ClickHouse query spec that deduplicates variant rows with
 * argMax(score, created_at) before computing per-cell aggregates.
 *
 * The pipeline score writer is not idempotent under Restate replay, so the
 * same (run, persona, scenario, evaluator, variant) can have multiple rows.
 * Keeping only the latest score per variant avoids inflated counts and
 * zero-skewed averages that occurred with the mv_eval_heatmap_dest MV.
 */
export function buildEvalHeatmapQuery(params: EvalHeatmapQueryParams): {
  query: string;
  query_params: Record<string, string>;
  format: 'JSONEachRow';
} {
  return {
    query: `
      SELECT
        personaId,
        scenarioId,
        evaluatorId,
        avg(score)                AS avgScore,
        count()                   AS count,
        avg(passed)               AS passRate,
        ifNull(varSamp(score), 0) AS variance,
        min(score)                AS minScore,
        max(score)                AS maxScore
      FROM (
        SELECT
          persona_id   AS personaId,
          scenario_id  AS scenarioId,
          evaluator_id AS evaluatorId,
          variant_index,
          argMax(score,  created_at) AS score,
          argMax(passed, created_at) AS passed
        FROM ${CH_DATABASE}.eval_scores
        WHERE tenant_id  = {tenantId: String}
          AND project_id = {projectId: String}
          AND run_id     = {runId: String}
        GROUP BY persona_id, scenario_id, evaluator_id, variant_index
      )
      GROUP BY personaId, scenarioId, evaluatorId
      ORDER BY personaId, scenarioId, evaluatorId
    `,
    query_params: params,
    format: 'JSONEachRow',
  };
}
