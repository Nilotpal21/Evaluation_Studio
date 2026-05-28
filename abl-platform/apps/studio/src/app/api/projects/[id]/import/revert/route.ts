/**
 * POST /api/projects/:id/import/revert
 *
 * Revert a layered import operation.
 *
 * The Studio import UI is wired to layered import v2 only. Legacy core-direct
 * snapshot revert remains as a compatibility fallback for operations created
 * before the layered-only cutover.
 */

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { revertStudioLayeredImportOperation } from '@/lib/project-import/layered-import-support';
import { notifyRuntimeModelConfigChanged } from '@/lib/runtime-model-cache-invalidation';
import { revertCoreImportOperationV2 } from '@agent-platform/project-io/import';
import {
  createStudioCoreImportApplyAdapter,
  createStudioCoreImportStore,
} from '@/lib/project-import/core-direct-apply-support';
import { validateProjectToolBindingsForSave } from '@/lib/project-tool-binding-validation';
import { createProjectRuntimeConfigSaveValidatorForFiles } from '@/lib/project-runtime-config-import-validation';

const log = createLogger('import-revert-route');

function hasModelPolicyMutations(applied: {
  modelPoliciesUpserted?: number;
  modelPoliciesDeleted?: number;
}): boolean {
  return (applied.modelPoliciesUpserted ?? 0) + (applied.modelPoliciesDeleted ?? 0) > 0;
}

async function revertLegacyCoreDirectSnapshot(input: {
  operationId: string;
  projectId: string;
  tenantId: string;
  userId: string;
}): Promise<NextResponse> {
  const adapter = createStudioCoreImportApplyAdapter({
    projectId: input.projectId,
    tenantId: input.tenantId,
    userId: input.userId,
  });
  const store = createStudioCoreImportStore({
    projectId: input.projectId,
    tenantId: input.tenantId,
  });

  const executionResult = await revertCoreImportOperationV2({
    operationId: input.operationId,
    planOptions: {
      projectId: input.projectId,
      tenantId: input.tenantId,
      userId: input.userId,
      deleteUnmatched: true,
      validateToolBindingForSave: ({ tenantId, projectId, toolType, dslContent }) =>
        validateProjectToolBindingsForSave({
          tenantId,
          projectId,
          toolType,
          dslContent,
        }),
    },
    resolvePlanOptionsFromSnapshot: async (snapshotFiles, basePlanOptions) => ({
      ...basePlanOptions,
      validateRuntimeConfigForSave: createProjectRuntimeConfigSaveValidatorForFiles(
        new Map(Object.entries(snapshotFiles)),
      ),
    }),
    adapter,
    store,
    snapshotDescription: 'Pre-revert snapshot',
    snapshotCompression: {
      onTooLarge: (size) => {
        log.warn('Pre-revert snapshot too large, skipping', {
          projectId: input.projectId,
          size,
        });
      },
    },
  });

  if (!executionResult.success) {
    if (executionResult.stage === 'snapshot') {
      log.error('Failed to decompress legacy import snapshot', {
        projectId: input.projectId,
        operationId: input.operationId,
        error: executionResult.error.message,
      });
    }

    return NextResponse.json(
      {
        success: false,
        error: executionResult.error,
        ...(executionResult.preview ? { preview: executionResult.preview } : {}),
      },
      {
        status:
          executionResult.stage === 'operation'
            ? executionResult.error.code === 'OPERATION_NOT_FOUND'
              ? 404
              : 400
            : executionResult.stage === 'plan'
              ? 400
              : 500,
      },
    );
  }

  log.info('Project reverted to pre-import state via legacy core-direct snapshot', {
    projectId: input.projectId,
    tenantId: input.tenantId,
    sourceOperationId: input.operationId,
    revertOperationId: executionResult.operationId,
    updated: executionResult.applied.updated,
    deleted: executionResult.applied.deleted,
    toolsUpdated: executionResult.applied.toolsUpdated,
    toolsDeleted: executionResult.applied.toolsDeleted,
    localesUpdated: executionResult.applied.localesUpdated,
    localesDeleted: executionResult.applied.localesDeleted,
    modelPoliciesUpserted: executionResult.applied.modelPoliciesUpserted ?? 0,
    modelPoliciesDeleted: executionResult.applied.modelPoliciesDeleted ?? 0,
    entryAgent: executionResult.entryAgentName,
  });

  return NextResponse.json({
    success: true,
    operationId: executionResult.operationId,
    applied: executionResult.applied,
  });
}

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_IMPORT,
    rateLimit: { limit: 5, windowMs: 60_000, scope: 'tenant' },
  },
  async (ctx) => {
    const { tenantId, request, user } = ctx;
    const projectId = ctx.params.id;

    const body = await ctx.request.json();
    const { operationId } = body as { operationId: string };

    if (!operationId || typeof operationId !== 'string') {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'MISSING_OPERATION_ID', message: 'operationId is required' },
        },
        { status: 400 },
      );
    }

    const executionResult = await revertStudioLayeredImportOperation({
      operationId,
      projectId,
      tenantId,
    });

    if (!executionResult.success) {
      if (executionResult.error.code === 'OPERATION_NOT_LAYERED') {
        const legacyResponse = await revertLegacyCoreDirectSnapshot({
          operationId,
          projectId,
          tenantId,
          userId: user.id,
        });
        if (legacyResponse.ok) {
          const legacyBody = await legacyResponse.clone().json();
          if (hasModelPolicyMutations(legacyBody.applied ?? {})) {
            await notifyRuntimeModelConfigChanged({
              tenantId,
              authorization: request.headers.get('authorization'),
            });
          }
        }
        return legacyResponse;
      }

      return NextResponse.json(
        {
          success: false,
          error: executionResult.error,
        },
        { status: executionResult.status },
      );
    }

    log.info('Project reverted to pre-import state via layered rollback', {
      projectId,
      tenantId,
      sourceOperationId: operationId,
      updated: executionResult.applied.updated,
      deleted: executionResult.applied.deleted,
      toolsUpdated: executionResult.applied.toolsUpdated,
      toolsDeleted: executionResult.applied.toolsDeleted,
      localesUpdated: executionResult.applied.localesUpdated,
      localesDeleted: executionResult.applied.localesDeleted,
      modelPoliciesUpserted: executionResult.applied.modelPoliciesUpserted ?? 0,
      modelPoliciesDeleted: executionResult.applied.modelPoliciesDeleted ?? 0,
    });

    if (hasModelPolicyMutations(executionResult.applied)) {
      await notifyRuntimeModelConfigChanged({
        tenantId,
        authorization: request.headers.get('authorization'),
      });
    }

    return NextResponse.json({
      success: true,
      operationId: executionResult.operationId,
      applied: executionResult.applied,
    });
  },
);
