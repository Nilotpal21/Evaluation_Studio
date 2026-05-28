/**
 * POST /api/projects/:id/mcp-servers/:serverId/tools/discover/preview - Preview MCP tools without persisting
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { errorJson } from '@/lib/api-response';
import { discoverPreview } from '@/services/mcp-discovery-service';
import { StudioPermission } from '@/lib/permissions';

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.TOOL_READ,
    rateLimit: { limit: 5, windowMs: 60_000, scope: 'user' },
  },
  async ({ tenantId, params }) => {
    const result = await discoverPreview(params.serverId, tenantId, params.id);
    if ('status' in result) {
      return errorJson(result.error, result.status);
    }

    return NextResponse.json({ success: true, ...result });
  },
);
