/**
 * GET /api/projects/:id/import/status?operationId=xxx
 *
 * Poll the status of a shared import operation.
 */

export const dynamic = 'force-dynamic';

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { StudioPermission } from '@/lib/permissions';
import { ImportOperation, type IImportOperation } from '@agent-platform/database/models';

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.PROJECT_READ,
    rateLimit: { limit: 30, windowMs: 60_000, scope: 'user' },
  },
  async (ctx) => {
    const { tenantId, request } = ctx;
    const projectId = ctx.params.id;

    const url = new URL(request.url);
    const operationId = url.searchParams.get('operationId');

    if (!operationId) {
      return NextResponse.json(
        { success: false, error: { code: 'MISSING_PARAM', message: 'operationId is required' } },
        { status: 400 },
      );
    }

    const operation = (await ImportOperation.findOne({
      _id: operationId,
      projectId,
      tenantId,
    }).lean()) as IImportOperation | null;

    if (!operation) {
      return NextResponse.json(
        {
          success: false,
          error: { code: 'NOT_FOUND', message: 'Import operation not found' },
        },
        { status: 404 },
      );
    }

    return NextResponse.json({
      success: true,
      data: {
        operationId: String(operation._id),
        status: operation.status,
        layers: operation.layers ?? {},
        error: operation.error ?? null,
        createdAt: operation.createdAt,
        updatedAt: operation.updatedAt,
      },
    });
  },
);
