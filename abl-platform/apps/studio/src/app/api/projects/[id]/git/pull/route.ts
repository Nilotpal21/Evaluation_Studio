/**
 * POST /api/projects/:id/git/pull — Pull from git
 */

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { resolveGitCredentials } from '@/lib/git-credentials';
import {
  acquireGitOperationLock,
  gitOperationLockedResponse,
  type GitOperationLockResult,
} from '@/lib/git-operation-lock';
import { AuditActions, logAuditEvent } from '@/services/audit-service';
import { ensureConnected, GitIntegration, GitSyncHistory } from '@agent-platform/database/models';
import {
  createGitProvider,
  GitSyncService,
  GitCircuitBreakerError,
} from '@agent-platform/project-io/git';
import type { ImportPreviewV2, LayerName } from '@agent-platform/project-io';
import {
  applyStudioLayeredImportV2,
  previewStudioLayeredImportV2,
} from '@/lib/project-import/layered-import-support';
import { notifyRuntimeModelConfigChanged } from '@/lib/runtime-model-cache-invalidation';

const log = createLogger('git-pull-route');

interface ChangesSummary {
  added: string[];
  modified: string[];
  deleted: string[];
}

interface GitPullPlanSummary {
  changes: ChangesSummary;
  agentsAffected: string[];
}

interface GitPullRequestBody {
  branch?: string;
  dryRun?: boolean;
  previewDigest?: string | null;
  acknowledgedIssueIds?: string[];
}

const EMPTY_CHANGES_SUMMARY: ChangesSummary = {
  added: [],
  modified: [],
  deleted: [],
};

function sanitizeGitLifecycleError(
  message: string,
  sensitiveValues: Array<string | null | undefined>,
): string {
  let sanitized = message || 'Git operation failed';
  for (const value of sensitiveValues) {
    if (value) {
      sanitized = sanitized.split(value).join('[redacted]');
    }
  }
  sanitized = sanitized
    .replace(/https:\/\/[^@\s]+@/gi, 'https://[redacted]@')
    .replace(/\bsecret[-_a-z0-9]*\b/gi, '[redacted]');
  return sanitized;
}

function hasModelPolicyMutations(
  applied:
    | {
        modelPoliciesUpserted?: number;
        modelPoliciesDeleted?: number;
      }
    | undefined,
): boolean {
  if (!applied) {
    return false;
  }
  return (applied.modelPoliciesUpserted ?? 0) + (applied.modelPoliciesDeleted ?? 0) > 0;
}

function addValues(target: Set<string>, values: Array<string | null | undefined>): void {
  for (const value of values) {
    if (value) {
      target.add(value);
    }
  }
}

const DETAILED_PREVIEW_LAYERS = new Set<LayerName>(['core']);

function addLayerChangeLabels(
  preview: ImportPreviewV2,
  changes: { added: Set<string>; modified: Set<string>; deleted: Set<string> },
): void {
  for (const layer of preview.layers) {
    if (DETAILED_PREVIEW_LAYERS.has(layer)) {
      continue;
    }

    const counts = preview.layerChanges[layer];
    if (!counts) {
      continue;
    }

    if (counts.added > 0) {
      changes.added.add(`${layer}:added(${counts.added})`);
    }
    if (counts.modified > 0) {
      changes.modified.add(`${layer}:modified(${counts.modified})`);
    }
    if (counts.removed > 0) {
      changes.deleted.add(`${layer}:removed(${counts.removed})`);
    }
  }
}

function summarizeLayeredGitPullPreview(preview: ImportPreviewV2): GitPullPlanSummary {
  const changes = {
    added: new Set<string>(),
    modified: new Set<string>(),
    deleted: new Set<string>(),
  };
  const agentsAffected = new Set<string>();

  addValues(changes.added, preview.agentChanges.added);
  addValues(
    changes.modified,
    preview.agentChanges.modified.map((change) => change.name),
  );
  addValues(changes.deleted, preview.agentChanges.removed);
  addValues(changes.added, preview.toolChanges.added);
  addValues(changes.modified, preview.toolChanges.modified);
  addValues(changes.deleted, preview.toolChanges.removed);
  addValues(changes.added, preview.localeChanges?.added ?? []);
  addValues(changes.modified, preview.localeChanges?.modified ?? []);
  addValues(changes.deleted, preview.localeChanges?.removed ?? []);
  addValues(changes.added, preview.profileChanges?.added ?? []);
  addValues(changes.modified, preview.profileChanges?.modified ?? []);
  addValues(changes.deleted, preview.profileChanges?.removed ?? []);
  addLayerChangeLabels(preview, changes);

  addValues(agentsAffected, preview.agentChanges.added);
  addValues(
    agentsAffected,
    preview.agentChanges.modified.map((change) => change.name),
  );
  addValues(agentsAffected, preview.agentChanges.removed);

  return {
    changes: {
      added: [...changes.added].sort(),
      modified: [...changes.modified].sort(),
      deleted: [...changes.deleted].sort(),
    },
    agentsAffected: [...agentsAffected].sort(),
  };
}

async function recordGitPullFailure(input: {
  projectId: string;
  tenantId: string;
  userId: string;
  branch: string;
  commitSha: string | null;
  changesSummary: ChangesSummary;
  agentsAffected: string[];
  errorMessage: string;
}): Promise<void> {
  const safeError = sanitizeGitLifecycleError(input.errorMessage, [
    input.projectId,
    input.tenantId,
    input.userId,
  ]);

  await GitSyncHistory.create({
    projectId: input.projectId,
    tenantId: input.tenantId,
    direction: 'pull',
    commitSha: input.commitSha,
    branch: input.branch,
    status: 'failed',
    error: safeError,
    agentsAffected: input.agentsAffected,
    changesSummary: input.changesSummary,
    triggeredBy: input.userId,
  });

  await GitIntegration.findOneAndUpdate(
    { projectId: input.projectId, tenantId: input.tenantId },
    {
      lastSyncAt: new Date(),
      lastSyncStatus: 'failed',
      lastSyncError: safeError,
    },
  );
}

async function recordGitPullSuccess(input: {
  projectId: string;
  tenantId: string;
  userId: string;
  branch: string;
  commitSha: string | null;
  changesSummary: ChangesSummary;
  agentsAffected: string[];
}): Promise<void> {
  await GitSyncHistory.create({
    projectId: input.projectId,
    tenantId: input.tenantId,
    direction: 'pull',
    commitSha: input.commitSha,
    branch: input.branch,
    status: 'success',
    agentsAffected: input.agentsAffected,
    changesSummary: input.changesSummary,
    triggeredBy: input.userId,
  });

  await GitIntegration.findOneAndUpdate(
    { projectId: input.projectId, tenantId: input.tenantId },
    {
      lastSyncAt: new Date(),
      lastSyncStatus: 'success',
      lastSyncCommit: input.commitSha,
      lastSyncError: null,
    },
  );
}

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_GIT,
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'tenant' },
  },
  async (ctx) => {
    const { tenantId, user, request } = ctx;
    const projectId = ctx.params.id;

    let body: GitPullRequestBody;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const dryRun = body.dryRun ?? false;

    if (body.branch !== undefined) {
      const BRANCH_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9/_.\-]*$/;
      if (
        typeof body.branch !== 'string' ||
        body.branch.length === 0 ||
        body.branch.length > 256 ||
        !BRANCH_NAME_RE.test(body.branch) ||
        body.branch.includes('..') ||
        body.branch.startsWith('/')
      ) {
        return NextResponse.json(
          { error: 'Invalid branch name: must be alphanumeric with slashes, dashes, dots only' },
          { status: 400 },
        );
      }
    }

    let operationLock: GitOperationLockResult | null = null;
    try {
      if (!dryRun) {
        operationLock = await acquireGitOperationLock({ tenantId, projectId, operation: 'pull' });
        if (!operationLock.acquired) {
          return gitOperationLockedResponse(operationLock);
        }
      }

      await ensureConnected();

      const integration = await GitIntegration.findOne({ projectId, tenantId }).lean();
      if (!integration) {
        return NextResponse.json({ error: 'No git integration configured' }, { status: 404 });
      }

      const branch = body.branch ?? integration.defaultBranch;
      const sensitiveValues = [
        projectId,
        tenantId,
        user.id,
        typeof integration.authProfileId === 'string' ? integration.authProfileId : null,
      ];

      const credentials = await resolveGitCredentials(integration.authProfileId, tenantId, {
        projectId,
        userId: user.id,
      });
      const provider = createGitProvider(
        { provider: integration.provider, repositoryUrl: integration.repositoryUrl },
        credentials,
      );
      const syncService = new GitSyncService(provider);
      const syncPath = typeof integration.syncPath === 'string' ? integration.syncPath : '/';
      const pulledProject = await syncService.pullProjectFiles(branch, syncPath);

      if (dryRun) {
        const previewResult = await previewStudioLayeredImportV2({
          files: pulledProject.files,
          projectId,
          tenantId,
          userId: user.id,
          conflictStrategy: 'replace',
        });

        if (!previewResult.success || !previewResult.preview) {
          const failureMessage = sanitizeGitLifecycleError(
            previewResult.error?.message ?? 'Git pull preview failed',
            sensitiveValues,
          );
          log.error('Git pull preview failed', {
            projectId,
            error: previewResult.error,
            preview: previewResult.preview,
          });

          return NextResponse.json(
            {
              error: failureMessage,
              ...(previewResult.preview ? { preview: previewResult.preview } : {}),
            },
            { status: 500 },
          );
        }

        const summary = summarizeLayeredGitPullPreview(previewResult.preview);
        return NextResponse.json({
          success: true,
          dryRun: true,
          branch: pulledProject.branch,
          commitSha: pulledProject.commitSha,
          changes: summary.changes,
          previewDigest: previewResult.preview.previewDigest,
          preview: previewResult.preview,
          ...(previewResult.warnings.length > 0 ? { warnings: previewResult.warnings } : {}),
        });
      }

      const executionResult = await applyStudioLayeredImportV2({
        files: pulledProject.files,
        projectId,
        tenantId,
        userId: user.id,
        conflictStrategy: 'replace',
        previewDigest: body.previewDigest ?? null,
        acknowledgedIssueIds: body.acknowledgedIssueIds ?? [],
      });

      const summary = executionResult.preview
        ? summarizeLayeredGitPullPreview(executionResult.preview)
        : { changes: EMPTY_CHANGES_SUMMARY, agentsAffected: [] };

      if (!executionResult.success) {
        const failureMessage = sanitizeGitLifecycleError(
          executionResult.error.message,
          sensitiveValues,
        );
        log.error('Git pull layered import failed', {
          projectId,
          stage: executionResult.stage,
          error: executionResult.error,
          preview: executionResult.preview,
        });

        await recordGitPullFailure({
          projectId,
          tenantId,
          userId: user.id,
          branch: pulledProject.branch,
          commitSha: pulledProject.commitSha,
          changesSummary: summary.changes,
          agentsAffected: summary.agentsAffected,
          errorMessage: failureMessage,
        });

        return NextResponse.json(
          {
            error: failureMessage,
            ...(executionResult.preview ? { preview: executionResult.preview } : {}),
          },
          { status: executionResult.stage === 'apply' ? 500 : 400 },
        );
      }

      await recordGitPullSuccess({
        projectId,
        tenantId,
        userId: user.id,
        branch: pulledProject.branch,
        commitSha: pulledProject.commitSha,
        changesSummary: summary.changes,
        agentsAffected: summary.agentsAffected,
      });

      try {
        await logAuditEvent({
          userId: user.id,
          tenantId,
          action: AuditActions.GIT_PULL_COMPLETED,
          ip: request.headers.get('x-forwarded-for') || undefined,
          userAgent: request.headers.get('user-agent') || undefined,
          metadata: {
            projectId,
            resourceType: 'git_integration',
            resourceId: String(integration._id),
            branch,
            commitSha: pulledProject.commitSha ?? null,
            dryRun: false,
            added: summary.changes.added.length,
            modified: summary.changes.modified.length,
            deleted: summary.changes.deleted.length,
          },
        });
      } catch (auditError) {
        const auditMessage = auditError instanceof Error ? auditError.message : String(auditError);
        log.warn('Git pull audit event failed after apply', { projectId, error: auditMessage });
      }

      const warnings: string[] = [];
      if (hasModelPolicyMutations(executionResult.applied)) {
        try {
          await notifyRuntimeModelConfigChanged({
            tenantId,
            authorization: request.headers.get('authorization'),
          });
        } catch (cacheError) {
          const cacheMessage =
            cacheError instanceof Error ? cacheError.message : String(cacheError);
          log.warn('Runtime model cache invalidation failed after git pull', {
            projectId,
            error: cacheMessage,
          });
          warnings.push('Git pull applied, but runtime model cache invalidation failed');
        }
      }

      return NextResponse.json({
        success: true,
        branch: pulledProject.branch,
        commitSha: pulledProject.commitSha,
        changes: summary.changes,
        previewDigest: executionResult.preview?.previewDigest,
        preview: executionResult.preview,
        ...([...warnings, ...executionResult.warnings].length > 0
          ? { warnings: [...warnings, ...executionResult.warnings] }
          : {}),
      });
    } catch (error) {
      if (error instanceof GitCircuitBreakerError) {
        const retryAfterSec = Math.ceil(error.retryAfterMs / 1000);
        log.warn('Git pull blocked by circuit breaker', {
          projectId,
          retryAfterMs: error.retryAfterMs,
        });
        return NextResponse.json(
          { error: 'Git provider temporarily unavailable', retryAfterMs: error.retryAfterMs },
          { status: 503, headers: { 'Retry-After': String(retryAfterSec) } },
        );
      }
      const message = error instanceof Error ? error.message : String(error);
      const stack = error instanceof Error ? error.stack : undefined;
      log.error('Git pull failed', { projectId, error: message, stack });
      return NextResponse.json({ error: 'Failed to pull from git' }, { status: 500 });
    } finally {
      if (operationLock?.acquired) {
        await operationLock.release();
      }
    }
  },
);
