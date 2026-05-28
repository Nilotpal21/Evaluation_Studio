/**
 * GET /api/projects/:id/evals/runs/:runId/heatmap
 *
 * Returns the heatmap data for an eval run: per-(persona, scenario, evaluator)
 * average scores. Reads from the mv_eval_heatmap_dest materialized view for
 * sub-second aggregation.
 *
 * Response shape:
 *   { success: true, cells: Array<{ personaId, scenarioId, evaluatorId, avgScore, count, variance }> }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findRunById } from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';

const CH_DATABASE = 'abl_platform';

type RouteParams = { params: Promise<{ id: string; runId: string }> };
type HeatmapCellRow = {
  personaId: string;
  scenarioId: string;
  evaluatorId: string;
  avgScore: number;
  count: string | number;
  passRate: number;
  variance: number | null;
  minScore: number;
  maxScore: number;
};

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, runId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const client = getClickHouseClient();

    // Run MongoDB ownership check and ClickHouse query in parallel — the CH
    // query is already tenant+project+run scoped so it's safe to fire immediately.
    const [run, result] = await Promise.all([
      findRunById(runId, user.tenantId, projectId),
      // Read directly from eval_scores with per-variant dedup. The pipeline's
      // score writer is not idempotent under Restate replay, so the same
      // (run, persona, scenario, evaluator, variant) can have multiple rows;
      // mv_eval_heatmap_dest aggregates all of them and inflates count + skews
      // averages toward zero (failure-path writes use score=0). argMax(...,
      // created_at) keeps the latest score per variant before aggregating.
      client.query({
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
        query_params: { tenantId: user.tenantId, projectId, runId },
        format: 'JSONEachRow',
      }),
    ]);

    if (!run) {
      return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
    }

    // ClickHouse JSONEachRow serializes UInt64/count() as strings. Coerce to
    // numbers here so the client receives the correct types.
    const raw = await result.json<HeatmapCellRow>();
    const cells = raw.map((c) => ({ ...c, count: Number(c.count) }));
    return NextResponse.json({ success: true, cells });
  } catch (error) {
    return handleApiError(error, 'EvalRuns.heatmap');
  }
}
