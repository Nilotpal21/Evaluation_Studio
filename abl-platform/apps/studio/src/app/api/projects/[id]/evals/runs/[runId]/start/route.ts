/**
 * POST /api/projects/:id/evals/runs/:runId/start
 *
 * Trigger execution of a pending eval run. Uses atomic findOneAndUpdate
 * with status:'pending' condition to prevent race conditions. Calls
 * PipelineTrigger.triggerManual via Restate ingress.
 */

import { NextRequest, NextResponse } from 'next/server';
import { requireTenantAuth, isAuthError, formatUserLabel } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { findEvalSetById } from '@/repos/eval-repo';
import { handleApiError } from '@/lib/api-response';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { getRestateIngressUrl } from '@/lib/restate-url';

const log = createLogger('eval-runs-start');

type RouteParams = { params: Promise<{ id: string; runId: string }> };

export async function POST(request: NextRequest, { params }: RouteParams) {
  const user = await requireTenantAuth(request);
  if (isAuthError(user)) return user;

  const { id: projectId, runId } = await params;
  const access = await requireProjectAccess(projectId, user);
  if (isAccessError(access)) return access;

  try {
    // Atomic transition: only update if currently 'pending'
    // This prevents TOCTOU race conditions from concurrent requests
    const { ensureDb } = await import('@/lib/ensure-db');
    await ensureDb();
    const { EvalRun } = await import('@agent-platform/database/models');

    const updated = await EvalRun.findOneAndUpdate(
      { _id: runId, tenantId: user.tenantId, projectId, status: 'pending' },
      { $set: { status: 'running', startedAt: new Date() } },
      { new: true },
    ).lean();

    if (!updated) {
      // Either not found or not in 'pending' status
      const existing = await EvalRun.findOne({
        _id: runId,
        tenantId: user.tenantId,
        projectId,
      }).lean();

      if (!existing) {
        return NextResponse.json({ success: false, error: 'Not found' }, { status: 404 });
      }

      return NextResponse.json(
        {
          success: false,
          error: `Cannot start run with status '${existing.status}'. Only pending runs can be started.`,
        },
        { status: 409 },
      );
    }

    // Verify the eval set still exists
    const evalSet = await findEvalSetById(updated.evalSetId as string, user.tenantId, projectId);
    if (!evalSet) {
      // Revert status back to pending since we can't start
      await EvalRun.findOneAndUpdate(
        { _id: runId, tenantId: user.tenantId, projectId },
        { $set: { status: 'pending', startedAt: null } },
      );
      return NextResponse.json(
        { success: false, error: 'Eval set referenced by this run no longer exists' },
        { status: 409 },
      );
    }

    // Trigger the eval workflow via Restate ingress.
    // Wrap fetch + HTTP-error check in a single try/catch so that both
    // network-level throws (ECONNREFUSED, AbortError) and non-OK HTTP
    // responses revert the run to 'failed' before propagating the error.
    const triggerUrl = `${getRestateIngressUrl()}/EvalRunWorkflow/${runId}/run/send`;
    const triggerPayload = {
      tenantId: user.tenantId,
      projectId,
      runId,
      evalSetId: updated.evalSetId,
    };

    try {
      // 15s timeout: covers Restate ingress accept latency under cluster failover.
      // Normal accept is sub-second; this only triggers when ingress is unreachable.
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 15_000);
      let triggerResponse: Response;
      try {
        triggerResponse = await fetch(triggerUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(triggerPayload),
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timeoutId);
      }

      if (!triggerResponse.ok) {
        const text = await triggerResponse.text().catch(() => '');
        log.error('Failed to trigger eval run via Restate', {
          runId,
          status: triggerResponse.status,
          body: text,
        });
        throw new Error(`Restate trigger failed: ${triggerResponse.status}`);
      }
    } catch (triggerError) {
      // Revert to 'failed' so the run doesn't stay stuck in 'running'.
      // This covers both HTTP errors and network-level throws.
      await EvalRun.findOneAndUpdate(
        { _id: runId, tenantId: user.tenantId, projectId },
        { $set: { status: 'failed', completedAt: new Date() } },
      ).catch((revertErr) => {
        log.error('Failed to revert run status after trigger failure', {
          runId,
          error: revertErr instanceof Error ? revertErr.message : String(revertErr),
        });
      });
      throw triggerError;
    }

    return NextResponse.json(
      { success: true, run: { ...JSON.parse(JSON.stringify(updated)), id: updated._id } },
      { status: 202 },
    );
  } catch (error) {
    return handleApiError(error, 'EvalRuns.start');
  }
}
