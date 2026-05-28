/**
 * GET  /api/projects/:id/evals/runs - List eval runs for a project
 * POST /api/projects/:id/evals/runs - Create an eval run
 */

import { NextRequest, NextResponse } from 'next/server';
import { z } from 'zod';
import { requireTenantAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import {
  findRunsPageByProject,
  createRun,
  findEvalSetById,
  findPersonaById,
  findScenarioById,
  findEvaluatorById,
} from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import { parseEvalListQuery } from '@/lib/eval-list-query';
import {
  EVAL_NAME_MAX_LENGTH,
  EVAL_NOTES_MAX_LENGTH,
} from '@agent-platform/database/constants/eval-limits';
import { normalizeEvalKnownSource } from '@agent-platform/database';

const createSchema = z.object({
  evalSetId: z.string().min(1),
  name: z.string().max(EVAL_NAME_MAX_LENGTH).optional(),
  notes: z.string().max(EVAL_NOTES_MAX_LENGTH).optional(),
  triggerSource: z.enum(['manual', 'ci', 'scheduled']).default('manual'),
  source: z
    .object({
      knownSource: z.enum(['production', 'eval', 'synthetic']).optional(),
    })
    .strict()
    .optional(),
});

type RouteParams = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    const query = parseEvalListQuery(new URL(request.url).searchParams);
    const result = await findRunsPageByProject(projectId, user.tenantId, query);
    return NextResponse.json({
      success: true,
      runs: result.items,
      pagination: result.pagination,
    });
  } catch (error) {
    return handleApiError(error, 'EvalRuns.list');
  }
}

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ success: false, error: 'Invalid JSON body' }, { status: 400 });
  }

  const result = createSchema.safeParse(body);
  if (!result.success) {
    return NextResponse.json(
      { success: false, error: 'Invalid request', details: result.error.issues },
      { status: 400 },
    );
  }

  try {
    const evalSet = await findEvalSetById(result.data.evalSetId, user.tenantId, projectId);
    if (!evalSet)
      return NextResponse.json({ success: false, error: 'Eval set not found' }, { status: 404 });
    const personaVersions: Record<string, number> = {};
    const scenarioVersions: Record<string, number> = {};
    const evaluatorVersions: Record<string, number> = {};

    await Promise.all([
      ...evalSet.personaIds.map(async (pid: string) => {
        const p = await findPersonaById(pid, user.tenantId, projectId);
        if (p) personaVersions[pid] = p.version ?? 1;
      }),
      ...evalSet.scenarioIds.map(async (sid: string) => {
        const s = await findScenarioById(sid, user.tenantId, projectId);
        if (s) scenarioVersions[sid] = s.version ?? 1;
      }),
      ...evalSet.evaluatorIds.map(async (eid: string) => {
        const e = await findEvaluatorById(eid, user.tenantId, projectId);
        if (e) evaluatorVersions[eid] = e.version ?? 1;
      }),
    ]);

    const run = await createRun({
      ...result.data,
      tenantId: user.tenantId,
      projectId,
      knownSource: normalizeEvalKnownSource(result.data.source?.knownSource),
      triggeredBy: formatUserLabel(user),
      snapshot: { personaVersions, scenarioVersions, evaluatorVersions },
    });
    return NextResponse.json({ success: true, run }, { status: 201 });
  } catch (error) {
    return handleApiError(error, 'EvalRuns.create');
  }
}
