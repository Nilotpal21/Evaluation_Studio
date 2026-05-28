/**
 * POST /api/projects/:id/import/preview
 *
 * Upload files and get an ImportPreviewV2 without applying changes (JWT auth only).
 * Uses the layered v2 importer so preview matches apply behavior.
 */

export const maxDuration = 60; // seconds
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import {
  LAYER_DEFAULTS,
  type ImportBindingResolutionInput,
  type LayerName,
} from '@agent-platform/project-io';
import { previewStudioLayeredImportV2 } from '@/lib/project-import/layered-import-support';

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
    return {
      success: false,
      response: NextResponse.json(
        {
          success: false,
          error: {
            code: 'INVALID_BINDING_RESOLUTIONS',
            message: '"bindingResolutions" must be an object keyed by resolution id',
          },
        },
        { status: 400 },
      ),
    };
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

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_READ,
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'tenant' },
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
      bindingResolutions: rawBindingResolutions,
    } = body as {
      files: Record<string, string>;
      deleteUnmatched?: boolean;
      layers?: unknown;
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
        { success: false, error: { code: 'MISSING_FILES', message: 'files map is required' } },
        { status: 400 },
      );
    }

    const entries = Object.entries(filesObj);

    if (entries.length > MAX_FILE_COUNT) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'FILE_LIMIT_EXCEEDED', message: `Too many files (max ${MAX_FILE_COUNT})` },
        },
        { status: 400 },
      );
    }

    let totalSize = 0;
    for (const [filePath, content] of entries) {
      if (typeof content !== 'string') {
        return NextResponse.json(
          {
            success: false,
            error: {
              code: 'INVALID_FILE_CONTENT',
              message: `File content must be a string: ${filePath}`,
            },
          },
          { status: 400 },
        );
      }
      // Path traversal check
      if (filePath.includes('..') || filePath.startsWith('/') || filePath.includes('\0')) {
        return NextResponse.json(
          {
            success: false,
            error: { code: 'INVALID_FILE_PATH', message: `Invalid file path: ${filePath}` },
          },
          { status: 400 },
        );
      }
      if (content.length > MAX_FILE_SIZE) {
        return NextResponse.json(
          {
            success: false,
            error: { code: 'FILE_TOO_LARGE', message: `File too large (max 1MB): ${filePath}` },
          },
          { status: 400 },
        );
      }
      totalSize += content.length;
      if (totalSize > MAX_TOTAL_SIZE) {
        return NextResponse.json(
          {
            success: false,
            error: { code: 'TOTAL_SIZE_EXCEEDED', message: 'Total upload size exceeds 50MB' },
          },
          { status: 400 },
        );
      }
    }

    const importFiles = new Map(Object.entries(filesObj));

    const result = await previewStudioLayeredImportV2({
      files: importFiles,
      projectId,
      tenantId,
      userId: user.id,
      layers: layerParse.layers,
      conflictStrategy: deleteUnmatched ? 'replace' : 'merge',
      bindingResolutions: bindingResolutionParse.bindingResolutions,
    });

    if (!result.success) {
      return NextResponse.json(
        {
          success: false,
          preview: result.preview,
          previewDigest: result.preview?.previewDigest,
          warnings: result.warnings,
          error: result.error,
        },
        {
          status: getImportFailureStatus(result.error),
        },
      );
    }

    return NextResponse.json({
      success: true,
      preview: result.preview,
      previewDigest: result.preview.previewDigest,
      warnings: result.warnings,
    });
  },
);
