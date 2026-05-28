/**
 * POST /api/projects/:id/git/promote
 *
 * Promote changes between environment branches (e.g., main → staging → production).
 * Creates a PR for the promotion, providing an audit trail.
 *
 * Body: { from: string, to: string }
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { GitIntegration } from '@agent-platform/database/models';
import { createGitProvider, BranchManager } from '@agent-platform/project-io/git';
import { resolveGitCredentials } from '@/lib/git-credentials';
import {
  acquireGitOperationLock,
  gitOperationLockedResponse,
  type GitOperationLockResult,
} from '@/lib/git-operation-lock';
import { AuditActions, logAuditEvent } from '@/services/audit-service';

const log = createLogger('git-promote-route');

const VALID_ENVIRONMENT_BRANCHES = new Set(['main', 'staging', 'production']);
const ORDERED_PROMOTIONS = new Set(['main:staging', 'staging:production']);

/** Reject branch names containing path traversal, control chars, or unsafe characters */
const SAFE_BRANCH_PATTERN = /^[a-zA-Z0-9._\/-]+$/;

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_DEPLOY,
    rateLimit: { limit: 5, windowMs: 60_000, scope: 'tenant' },
  },
  async (ctx) => {
    const { tenantId, request, user } = ctx;
    const projectId = ctx.params.id;

    let body: { from?: string; to?: string };
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_JSON', message: 'Request body must be valid JSON' },
        },
        { status: 400 },
      );
    }

    const { from, to } = body;

    if (!from || !to) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'MISSING_PARAMS', message: '"from" and "to" branch names are required' },
        },
        { status: 400 },
      );
    }

    if (
      from.includes('..') ||
      to.includes('..') ||
      !SAFE_BRANCH_PATTERN.test(from) ||
      !SAFE_BRANCH_PATTERN.test(to)
    ) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_BRANCH_NAME',
            message: 'Branch names contain invalid characters',
          },
        },
        { status: 400 },
      );
    }

    if (!VALID_ENVIRONMENT_BRANCHES.has(to)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_TARGET',
            message: `Target branch must be one of: ${[...VALID_ENVIRONMENT_BRANCHES].join(', ')}`,
          },
        },
        { status: 400 },
      );
    }

    if (from === to) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'SAME_BRANCH', message: 'Source and target branches must be different' },
        },
        { status: 400 },
      );
    }

    if (!ORDERED_PROMOTIONS.has(`${from}:${to}`)) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_PROMOTION_ORDER',
            message: 'Promotion must follow main to staging to production order',
          },
        },
        { status: 400 },
      );
    }

    let operationLock: GitOperationLockResult | null = null;
    try {
      operationLock = await acquireGitOperationLock({ tenantId, projectId, operation: 'promote' });
      if (!operationLock.acquired) {
        return gitOperationLockedResponse(operationLock);
      }

      // Get git integration config
      const integration = await GitIntegration.findOne({ projectId, tenantId }).lean();
      if (!integration) {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'GIT_NOT_CONFIGURED',
              message: 'Git integration is not configured for this project',
            },
          },
          { status: 400 },
        );
      }

      let credentials;
      try {
        credentials = await resolveGitCredentials(integration.authProfileId, tenantId, {
          projectId,
          userId: user.id,
        });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error('Failed to resolve git credentials', { projectId, error: message });
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'CREDENTIAL_RESOLUTION_FAILED',
              message: 'Failed to resolve git credentials for this integration',
            },
          },
          { status: 400 },
        );
      }

      const provider = createGitProvider(
        { provider: integration.provider, repositoryUrl: integration.repositoryUrl },
        credentials,
      );

      const branchManager = new BranchManager(provider);

      // Ensure target branch exists
      await branchManager.createEnvironmentBranch(to as 'staging' | 'production', from);

      const result = await branchManager.promoteBranch(from, to);

      if (!result.success) {
        log.error('Branch promotion failed', { projectId, from, to, error: result.error });
        return NextResponse.json({ success: false, error: result.error }, { status: 500 });
      }

      try {
        await logAuditEvent({
          userId: user.id,
          tenantId,
          action: AuditActions.GIT_PROMOTION_COMPLETED,
          ip: request.headers.get('x-forwarded-for') || undefined,
          userAgent: request.headers.get('user-agent') || undefined,
          metadata: {
            projectId,
            resourceType: 'git_integration',
            resourceId: String(integration._id),
            fromBranch: result.fromBranch,
            toBranch: result.toBranch,
            commitSha: result.commitSha ?? null,
          },
        });
      } catch (auditError) {
        const auditMessage = auditError instanceof Error ? auditError.message : String(auditError);
        log.warn('Git promotion audit event failed after promote', {
          projectId,
          error: auditMessage,
        });
      }

      return NextResponse.json({
        success: true,
        data: {
          fromBranch: result.fromBranch,
          toBranch: result.toBranch,
          commitSha: result.commitSha,
        },
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error('Branch promotion failed unexpectedly', { projectId, from, to, error: message });
      return NextResponse.json(
        {
          success: false,
          error: { code: 'PROMOTION_FAILED', message: 'Branch promotion failed' },
        },
        { status: 500 },
      );
    } finally {
      if (operationLock?.acquired) {
        await operationLock.release();
      }
    }
  },
);
