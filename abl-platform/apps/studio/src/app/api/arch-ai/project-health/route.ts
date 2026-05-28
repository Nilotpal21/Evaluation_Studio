/**
 * GET /api/arch-ai/project-health — Lightweight health summary for overlay
 *
 * Returns agent health counts (passing/warnings/errors) and the top issue.
 * Used by the ProjectHealthBar component in ArchOverlay.
 *
 * Auth: Studio requireTenantAuth pattern (same as files route)
 * Response: { totalAgents, passing, warnings, errors, overall, topIssue }
 */

import { NextRequest, NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { requireTenantAuth, isAuthError } from '@/lib/auth';
import { requireProjectAccess, isAccessError } from '@/lib/project-access';
import { buildHealthScore, getHealthTopIssue } from '@/lib/arch-ai/health-score';
import type { HealthCheckReport } from '@/lib/arch-ai/types/arch';

export const dynamic = 'force-dynamic';

const log = createLogger('api:arch-ai:project-health');

export async function GET(req: NextRequest) {
  try {
    const projectId = req.nextUrl.searchParams.get('projectId');
    if (!projectId) {
      return NextResponse.json(
        { success: false, error: { code: 'missing_param', message: 'projectId required' } },
        { status: 400 },
      );
    }

    const authResult = await requireTenantAuth(req);
    if (isAuthError(authResult)) return authResult;

    const auth = authResult;

    const access = await requireProjectAccess(projectId, auth);
    if (isAccessError(access)) return access;

    const { executeHealthCheck } = await import('@/lib/arch-ai/tools/health-check');
    const result = await executeHealthCheck(
      { action: 'full_check' },
      {
        projectId,
        user: { permissions: auth.permissions, tenantId: auth.tenantId, userId: auth.id },
      },
    );

    if (!result.success || !result.data) {
      const errorDetail = (result as { error?: { code?: string; message?: string } }).error;
      log.warn('Health check failed', { projectId, error: errorDetail });
      return NextResponse.json(
        {
          totalAgents: 0,
          passing: 0,
          warnings: 0,
          errors: 0,
          overall: 'Unknown',
          topIssue: null,
          error: errorDetail?.code ?? 'HEALTH_CHECK_FAILED',
        },
        { status: 503 },
      );
    }

    const report = result.data as HealthCheckReport;
    const score = report.score ?? buildHealthScore(report);

    return NextResponse.json({
      totalAgents: score.totalAgents,
      passing: score.healthyAgents,
      warnings: score.warningAgents,
      errors: score.failingAgents,
      healthPercent: score.percent,
      passedChecks: score.passedChecks,
      totalChecks: score.totalChecks,
      projectWarnings: score.projectWarnings,
      projectErrors: score.projectErrors,
      deployReady: score.deployReady,
      blockingFindings: score.blockingFindings,
      overall: report.overall,
      topIssue: getHealthTopIssue(report),
    });
  } catch (err) {
    log.error('Project health check failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json(
      { success: false, error: { code: 'health_check_failed', message: 'Health check failed' } },
      { status: 500 },
    );
  }
}
