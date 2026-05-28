/**
 * POST /api/template-install/agent/[id]/apply
 *
 * Apply an agent template install into an existing project.
 * [id] = target projectId.
 * Auth: JWT with PROJECT_IMPORT permission on the target project.
 */

export const maxDuration = 120;
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import {
  applyStudioLayeredImportV2,
  previewStudioLayeredImportV2,
} from '@/lib/project-import/layered-import-support';
import { notifyRuntimeModelConfigChanged } from '@/lib/runtime-model-cache-invalidation';
import {
  AgentApplyBodySchema,
  fetchTemplateBundle,
  notifyInstallEvent,
  fetchTemplatePrerequisites,
} from '@/lib/template-install';

const log = createLogger('template-install-agent-apply');

function hasModelPolicyMutations(applied: {
  modelPoliciesUpserted?: number;
  modelPoliciesDeleted?: number;
}): boolean {
  return (applied.modelPoliciesUpserted ?? 0) + (applied.modelPoliciesDeleted ?? 0) > 0;
}

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_IMPORT,
    rateLimit: { limit: 5, windowMs: 60_000, scope: 'tenant' },
  },
  async (ctx) => {
    const { tenantId, user, request } = ctx;
    const projectId = ctx.params.id;

    // Parse body
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        { success: false, error: { code: 'INVALID_JSON', message: 'Invalid JSON body' } },
        { status: 400 },
      );
    }

    const parsed = AgentApplyBodySchema.safeParse(body);
    if (!parsed.success) {
      return NextResponse.json(
        {
          success: false,
          error: {
            code: 'VALIDATION_ERROR',
            message: parsed.error.issues.map((i) => i.message).join('; '),
          },
        },
        { status: 400 },
      );
    }

    const { templateSlug, version, previewDigest, acknowledgedIssueIds } = parsed.data;
    const authorization = request.headers.get('authorization') ?? '';

    try {
      // Fetch bundle server-side (pass tenantId for tenant-scoped templates)
      const files = await fetchTemplateBundle(templateSlug, version, authorization, tenantId);
      const fileMap = new Map(Object.entries(files));

      // Run preview first to get digest + auto-acknowledge non-blocking issues
      // (same pattern as project install — user already chose to install)
      const previewResult = await previewStudioLayeredImportV2({
        files: fileMap,
        projectId,
        tenantId,
        userId: user.id,
        conflictStrategy: 'merge',
        layers: ['core'],
      });

      const preview = previewResult.preview;
      if (preview?.hasBlockingIssues) {
        const blockingIssues = preview.issues?.filter((i) => i.blocking);
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'IMPORT_BLOCKED',
              message: 'Template bundle has blocking validation issues',
              blockingIssues: blockingIssues?.slice(0, 10),
            },
          },
          { status: 400 },
        );
      }

      // Auto-acknowledge all non-blocking issues for template installs
      const autoAcknowledgedIds = (preview?.issues ?? [])
        .filter((i) => !i.blocking && i.id)
        .map((i) => i.id);

      log.info('Auto-acknowledging non-blocking issues for agent template install', {
        projectId,
        templateSlug,
        issueCount: autoAcknowledgedIds.length,
      });

      // Apply with merge strategy, core layer only
      const result = await applyStudioLayeredImportV2({
        files: fileMap,
        projectId,
        tenantId,
        userId: user.id,
        conflictStrategy: 'merge',
        layers: ['core'],
        previewDigest: preview?.previewDigest,
        acknowledgedIssueIds: autoAcknowledgedIds,
      });

      if (!result.success) {
        const error = result.error
          ? { ...result.error, stage: result.stage }
          : { code: 'IMPORT_FAILED', message: 'Agent template import failed' };

        return NextResponse.json(
          {
            success: false,
            error,
            preview: result.preview,
            warnings: result.warnings,
            operationId: result.operationId,
          },
          { status: result.stage === 'apply' ? 500 : 400 },
        );
      }

      // Model cache invalidation
      if (hasModelPolicyMutations(result.applied)) {
        await notifyRuntimeModelConfigChanged({ tenantId, authorization }).catch((err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          log.warn('Model cache invalidation failed', { error: message });
        });
      }

      // Fetch prerequisites for provisioning report
      const provisioningRequired = await fetchTemplatePrerequisites(templateSlug, authorization);

      // Notify template-store of install event (fire-and-forget)
      notifyInstallEvent({
        slug: templateSlug,
        version,
        userId: user.id,
        tenantId,
        projectId,
        authorization,
      }).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('Install event notification failed', { error: message });
      });

      log.info('Agent template installed', {
        projectId,
        templateSlug,
        version,
        created: result.applied.created,
        toolsCreated: result.applied.toolsCreated,
      });

      return NextResponse.json({
        success: true,
        operationId: result.operationId,
        applied: result.applied,
        entryAgentName: result.entryAgentName ?? null,
        warnings: result.warnings,
        provisioningRequired,
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const appErr = err as { code: string; message: string; statusCode: number };
        return NextResponse.json(
          { success: false, error: { code: appErr.code, message: appErr.message } },
          { status: appErr.statusCode },
        );
      }

      log.error('Agent template apply failed', {
        projectId,
        templateSlug,
        error: err instanceof Error ? err.message : String(err),
      });

      return NextResponse.json(
        { success: false, error: { code: 'INTERNAL_ERROR', message: 'Apply failed' } },
        { status: 500 },
      );
    }
  },
);
