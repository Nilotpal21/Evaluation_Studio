/**
 * GET /api/projects/:id/mcp-servers/:serverId/tools - List discovered tools for a server
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { errorJson } from '@/lib/api-response';
import { listDiscoveredTools } from '@/services/mcp-discovery-service';
import { StudioPermission } from '@/lib/permissions';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_READ },
  async ({ tenantId, params }) => {
    const result = await listDiscoveredTools(params.serverId, tenantId, params.id);
    if ('status' in result) {
      return errorJson(result.error, result.status);
    }

    return NextResponse.json({ success: true, tools: result });
  },
);
