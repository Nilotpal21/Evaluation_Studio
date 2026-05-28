/**
 * GET /api/projects/:id/evals/runs/compare?runIds=a,b
 *
 * Compare two eval runs side-by-side. Returns per-evaluator average scores
 * for each run, enabling regression detection in the UI.
 *
 * Query params:
 *   runIds: comma-separated run IDs (exactly 2 required)
 *
 * Response shape:
 *   {
 *     success: true,
 *     comparison: {
 *       runs: [{ runId, name, status, createdAt }, ...],
 *       evaluators: [{ evaluatorId, scores: [{ runId, avgScore, count, passRate }, ...] }, ...]
 *     }
 *   }
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { handleApiError } from '@/lib/api-response';
import { ensureDb } from '@/lib/ensure-db';
import { getClickHouseClient } from '@agent-platform/database/clickhouse';

const CH_DATABASE = 'abl_platform';
const MAX_COMPARE_RUNS = 2;

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  const runIdsParam = request.nextUrl.searchParams.get('runIds');
  if (!runIdsParam) {
    return NextResponse.json(
      { success: false, error: 'runIds query parameter is required (comma-separated)' },
      { status: 400 },
    );
  }

  const runIds = runIdsParam
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  if (runIds.length !== MAX_COMPARE_RUNS) {
    return NextResponse.json(
      { success: false, error: `Exactly ${MAX_COMPARE_RUNS} run IDs are required for comparison` },
      { status: 400 },
    );
  }

  try {
    // Fetch run metadata from MongoDB
    await ensureDb();
    const { EvalRun } = await import('@agent-platform/database/models');
    const runs = await EvalRun.find({
      _id: { $in: runIds },
      tenantId: user.tenantId,
      projectId,
    })
      .select('_id name status createdAt')
      .lean();

    if (runs.length !== MAX_COMPARE_RUNS) {
      return NextResponse.json(
        { success: false, error: 'One or more runs not found' },
        { status: 404 },
      );
    }

    const runMeta = runs.map((r) => ({
      runId: String(r._id),
      name: r.name,
      status: r.status,
      createdAt: r.createdAt,
    }));

    // Query per-evaluator aggregates for both runs from the MV
    const client = getClickHouseClient();
    const result = await client.query({
      query: `
        SELECT
          run_id                          AS runId,
          evaluator_id                    AS evaluatorId,
          avgMerge(avg_score)             AS avgScore,
          countMerge(total_scores)        AS count,
          countIfMerge(passed_count)      AS passedCount
        FROM ${CH_DATABASE}.mv_eval_run_evaluator_summary_dest
        WHERE tenant_id = {tenantId: String}
          AND project_id = {projectId: String}
          AND run_id IN ({runId0: String}, {runId1: String})
        GROUP BY run_id, evaluator_id
        ORDER BY evaluator_id, run_id
      `,
      query_params: {
        tenantId: user.tenantId,
        projectId,
        runId0: runIds[0],
        runId1: runIds[1],
      },
      format: 'JSONEachRow',
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const rows: any[] = await result.json();

    // Group by evaluator
    const evaluatorMap = new Map<
      string,
      Array<{ runId: string; avgScore: number; count: number; passRate: number }>
    >();
    for (const row of rows) {
      const list = evaluatorMap.get(row.evaluatorId) ?? [];
      const count = Number(row.count);
      const passedCount = Number(row.passedCount);
      list.push({
        runId: row.runId,
        avgScore: Number(row.avgScore),
        count,
        passRate: count > 0 ? passedCount / count : 0,
      });
      evaluatorMap.set(row.evaluatorId, list);
    }

    const evaluators = Array.from(evaluatorMap.entries()).map(([evaluatorId, scores]) => ({
      evaluatorId,
      scores,
    }));

    return NextResponse.json({
      success: true,
      comparison: { runs: runMeta, evaluators },
    });
  } catch (error) {
    return handleApiError(error, 'EvalRuns.compare');
  }
}
