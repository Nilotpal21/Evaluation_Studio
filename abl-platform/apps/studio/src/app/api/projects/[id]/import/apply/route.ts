/**
 * POST /api/projects/:id/import/apply
 *
 * Apply import through the layered v2 importer.
 */

export const maxDuration = 60; // seconds
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import {
  LAYER_DEFAULTS,
  type ImportBindingResolutionInput,
  type LayerName,
} from '@agent-platform/project-io';
import { applyStudioLayeredImportV2 } from '@/lib/project-import/layered-import-support';
import { notifyRuntimeModelConfigChanged } from '@/lib/runtime-model-cache-invalidation';

const log = createLogger('import-apply-route');

// Limits — aligned with client-side constants
const MAX_FILE_SIZE = 1024 * 1024; // 1MB per file
const MAX_TOTAL_SIZE = 50 * 1024 * 1024; // 50MB total
const MAX_FILE_COUNT = 500;
const MAX_BODY_SIZE = 60 * 1024 * 1024; // 60MB (JSON overhead above 50MB content)
const VALID_LAYERS = new Set(Object.keys(LAYER_DEFAULTS));
const VALID_BINDING_RESOLUTION_ACTIONS = new Set(['map_existing']);

function getImportFailureStatus(error?: { code?: string; stage?: string }): number {
  if (error?.code === 'PREVIEW_STALE') {
    return 409;
  }

  if (error?.stage === 'apply') {
    return 500;
  }

  return 400;
}

function parseRequestedLayers(
  raw: unknown,
): { success: true; layers?: LayerName[] } | { success: false; response: NextResponse } {
  if (raw === undefined) {
    return { success: true };
  }

  if (!Array.isArray(raw) || !raw.every((layer) => typeof layer === 'string')) {
    return {
      success: false,
      response: NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_LAYERS',
            message: '"layers" must be an array of layer names when provided',
          },
        },
        { status: 400 },
      ),
    };
  }

  const invalidLayers = raw.filter((layer) => !VALID_LAYERS.has(layer));
  if (invalidLayers.length > 0) {
    return {
      success: false,
      response: NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_LAYERS',
            message: `Unsupported import layer(s): ${invalidLayers.join(', ')}`,
          },
        },
        { status: 400 },
      ),
    };
  }

  return {
    success: true,
    layers: [...new Set(raw)] as LayerName[],
  };
}

function parseBindingResolutions(
  raw: unknown,
):
  | { success: true; bindingResolutions?: Record<string, ImportBindingResolutionInput> }
  | { success: false; response: NextResponse } {
  if (raw === undefined) {
    return { success: true };
  }

  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return invalidBindingResolutionsResponse(
      '"bindingResolutions" must be an object keyed by resolution id',
    );
  }

  const parsed: Record<string, ImportBindingResolutionInput> = {};
  for (const [id, value] of Object.entries(raw)) {
    if (typeof id !== 'string' || id.length === 0) {
      return invalidBindingResolutionsResponse('Binding resolution ids must be non-empty strings');
    }
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      return invalidBindingResolutionsResponse(`Binding resolution "${id}" must be an object`);
    }
    const candidate = value as Record<string, unknown>;
    if (
      typeof candidate.action !== 'string' ||
      !VALID_BINDING_RESOLUTION_ACTIONS.has(candidate.action)
    ) {
      return invalidBindingResolutionsResponse(
        `Binding resolution "${id}" has an unsupported action`,
      );
    }
    const target = candidate.target;
    if (
      target !== undefined &&
      (typeof target !== 'object' || target === null || Array.isArray(target))
    ) {
      return invalidBindingResolutionsResponse(
        `Binding resolution "${id}" target must be an object`,
      );
    }
    if (target !== undefined) {
      for (const [targetKey, targetValue] of Object.entries(target as Record<string, unknown>)) {
        if (
          targetKey !== 'indexId' &&
          targetKey !== 'workflowId' &&
          targetKey !== 'workflowVersion' &&
          targetKey !== 'triggerId'
        ) {
          return invalidBindingResolutionsResponse(
            `Binding resolution "${id}" target contains unsupported field "${targetKey}"`,
          );
        }
        if (targetValue !== undefined && typeof targetValue !== 'string') {
          return invalidBindingResolutionsResponse(
            `Binding resolution "${id}" target.${targetKey} must be a string`,
          );
        }
      }
    }
    parsed[id] = {
      action: candidate.action as ImportBindingResolutionInput['action'],
      ...(target ? { target: target as ImportBindingResolutionInput['target'] } : {}),
    };
  }

  return { success: true, bindingResolutions: parsed };
}

function invalidBindingResolutionsResponse(message: string): {
  success: false;
  response: NextResponse;
} {
  return {
    success: false,
    response: NextResponse.json(
      {
        success: false,
        error: { code: 'INVALID_BINDING_RESOLUTIONS', message },
      },
      { status: 400 },
    ),
  };
}

function hasModelPolicyMutations(applied: {
  modelPoliciesUpserted?: number;
  modelPoliciesDeleted?: number;
}): boolean {
  return (applied.modelPoliciesUpserted ?? 0) + (applied.modelPoliciesDeleted ?? 0) > 0;
}

// ─── Validation Helper ──────────────────────────────────────────────────

function validateFiles(
  filesObj: Record<string, string>,
): { valid: true } | { valid: false; error: string; status: number } {
  const entries = Object.entries(filesObj);

  if (entries.length > MAX_FILE_COUNT) {
    return { valid: false, error: `Too many files (max ${MAX_FILE_COUNT})`, status: 400 };
  }

  let totalSize = 0;
  for (const [filePath, content] of entries) {
    if (typeof content !== 'string') {
      return { valid: false, error: `File content must be a string: ${filePath}`, status: 400 };
    }
    if (filePath.includes('..') || filePath.startsWith('/') || filePath.includes('\0')) {
      return { valid: false, error: `Invalid file path: ${filePath}`, status: 400 };
    }
    if (content.length > MAX_FILE_SIZE) {
      return { valid: false, error: `File too large (max 1MB): ${filePath}`, status: 400 };
    }
    totalSize += content.length;
    if (totalSize > MAX_TOTAL_SIZE) {
      return { valid: false, error: 'Total upload size exceeds 50MB', status: 400 };
    }
  }

  return { valid: true };
}

// ─── Route Handler ──────────────────────────────────────────────────────

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_IMPORT,
    rateLimit: { limit: 5, windowMs: 60_000, scope: 'tenant' },
  },
  async (ctx) => {
    const { tenantId, user, request } = ctx;
    const projectId = ctx.params.id;

    // Early reject oversized payloads before buffering
    const contentLength = request.headers.get('content-length');
    if (contentLength && parseInt(contentLength, 10) > MAX_BODY_SIZE) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large (max 60MB)' },
        },
        { status: 413 },
      );
    }

    let body: unknown;
    try {
      body = await request.json();
    } catch {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'INVALID_JSON', message: 'Invalid JSON body' },
        },
        { status: 400 },
      );
    }

    const {
      files: filesObj,
      deleteUnmatched = false,
      layers: rawLayers,
      previewDigest = null,
      acknowledgedIssueIds = [],
      bindingResolutions: rawBindingResolutions,
    } = body as {
      files: Record<string, string>;
      deleteUnmatched?: boolean;
      layers?: unknown;
      previewDigest?: string | null;
      acknowledgedIssueIds?: string[];
      bindingResolutions?: unknown;
    };

    const layerParse = parseRequestedLayers(rawLayers);
    if (!layerParse.success) {
      return layerParse.response;
    }
    const bindingResolutionParse = parseBindingResolutions(rawBindingResolutions);
    if (!bindingResolutionParse.success) {
      return bindingResolutionParse.response;
    }

    if (!filesObj || typeof filesObj !== 'object') {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'MISSING_FILES', message: 'files map is required' },
        },
        { status: 400 },
      );
    }

    const validation = validateFiles(filesObj);
    if (!validation.valid) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'VALIDATION_FAILED', message: validation.error },
        },
        { status: validation.status },
      );
    }

    return handleLayeredImport(
      projectId,
      tenantId,
      user.id,
      filesObj,
      deleteUnmatched,
      layerParse.layers,
      previewDigest,
      acknowledgedIssueIds,
      bindingResolutionParse.bindingResolutions,
      request.headers.get('authorization'),
    );
  },
);

// ─── Layered Import ────────────────────────────────────────────────────

async function handleLayeredImport(
  projectId: string,
  tenantId: string,
  userId: string,
  filesObj: Record<string, string>,
  deleteUnmatched: boolean,
  layers: LayerName[] | undefined,
  previewDigest: string | null,
  acknowledgedIssueIds: string[],
  bindingResolutions: Record<string, ImportBindingResolutionInput> | undefined,
  authorization: string | null,
): Promise<NextResponse> {
  const importFiles = new Map(Object.entries(filesObj));

  const executionResult = await applyStudioLayeredImportV2({
    files: importFiles,
    projectId,
    tenantId,
    userId,
    layers,
    conflictStrategy: deleteUnmatched ? 'replace' : 'merge',
    previewDigest,
    acknowledgedIssueIds,
    bindingResolutions,
  });

  if (!executionResult.success) {
    const error = executionResult.error
      ? {
          ...executionResult.error,
          stage: executionResult.stage,
        }
      : null;

    return NextResponse.json(
      {
        success: false,
        error,
        previewDigest: executionResult.preview?.previewDigest,
        warnings: executionResult.warnings,
        operationId: executionResult.operationId,
        ...(executionResult.preview ? { preview: executionResult.preview } : {}),
      },
      {
        status: getImportFailureStatus(error ?? { stage: executionResult.stage }),
      },
    );
  }

  log.info('Project imported via layered import v2', {
    projectId,
    tenantId,
    created: executionResult.applied.created,
    updated: executionResult.applied.updated,
    deleted: executionResult.applied.deleted,
    toolsCreated: executionResult.applied.toolsCreated,
    toolsUpdated: executionResult.applied.toolsUpdated,
    toolsDeleted: executionResult.applied.toolsDeleted,
    localesCreated: executionResult.applied.localesCreated,
    localesUpdated: executionResult.applied.localesUpdated,
    localesDeleted: executionResult.applied.localesDeleted,
    evalsCreated: executionResult.applied.evalsCreated ?? 0,
    evalsUpdated: executionResult.applied.evalsUpdated ?? 0,
    evalsDeleted: executionResult.applied.evalsDeleted ?? 0,
    modelPoliciesUpserted: executionResult.applied.modelPoliciesUpserted ?? 0,
    modelPoliciesDeleted: executionResult.applied.modelPoliciesDeleted ?? 0,
    entryAgent: executionResult.entryAgentName,
  });

  if (hasModelPolicyMutations(executionResult.applied)) {
    await notifyRuntimeModelConfigChanged({ tenantId, authorization });
  }

  return NextResponse.json({
    success: true,
    operationId: executionResult.operationId,
    applied: executionResult.applied,
    entryAgentName: executionResult.entryAgentName,
    warnings: executionResult.warnings,
  });
}
