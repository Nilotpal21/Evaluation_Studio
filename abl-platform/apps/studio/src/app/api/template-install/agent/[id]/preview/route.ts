/**
 * POST /api/template-install/agent/[id]/preview
 *
 * Preview an agent template install into an existing project (dry-run).
 * [id] = target projectId.
 * Auth: JWT with PROJECT_READ permission on the target project.
 */

export const maxDuration = 60;
export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { previewStudioLayeredImportV2 } from '@/lib/project-import/layered-import-support';
import { AgentPreviewBodySchema, fetchTemplateBundle } from '@/lib/template-install';

const log = createLogger('template-install-agent-preview');

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_READ,
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'tenant' },
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

    const parsed = AgentPreviewBodySchema.safeParse(body);
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

    const { templateSlug, version } = parsed.data;
    const authorization = request.headers.get('authorization') ?? '';

    try {
      // Fetch bundle server-side (pass tenantId for tenant-scoped templates)
      const files = await fetchTemplateBundle(templateSlug, version, authorization, tenantId);
      const fileMap = new Map(Object.entries(files));

      // Run dry-run preview with merge strategy, core layer only
      const result = await previewStudioLayeredImportV2({
        files: fileMap,
        projectId,
        tenantId,
        userId: user.id,
        conflictStrategy: 'merge',
        layers: ['core'],
      });

      if (!result.success) {
        return NextResponse.json(
          {
            success: false,
            preview: result.preview,
            warnings: result.warnings,
            error: result.error,
          },
          { status: 400 },
        );
      }

      return NextResponse.json({
        success: true,
        preview: result.preview,
        previewDigest: result.preview?.previewDigest ?? null,
        warnings: result.warnings,
      });
    } catch (err) {
      if (err && typeof err === 'object' && 'statusCode' in err) {
        const appErr = err as { code: string; message: string; statusCode: number };
        return NextResponse.json(
          { success: false, error: { code: appErr.code, message: appErr.message } },
          { status: appErr.statusCode },
        );
      }

      log.error('Agent template preview failed', {
        projectId,
        templateSlug,
        error: err instanceof Error ? err.message : String(err),
      });

      return NextResponse.json(
        { success: false, error: { code: 'INTERNAL_ERROR', message: 'Preview failed' } },
        { status: 500 },
      );
    }
  },
);
