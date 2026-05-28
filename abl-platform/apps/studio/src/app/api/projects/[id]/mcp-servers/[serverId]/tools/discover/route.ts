/**
 * POST /api/projects/:id/mcp-servers/:serverId/tools/discover - Discover and persist MCP tools
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { errorJson } from '@/lib/api-response';
import { discoverAndPersist } from '@/services/mcp-discovery-service';
import { StudioPermission } from '@/lib/permissions';

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.TOOL_WRITE,
    rateLimit: { limit: 5, windowMs: 60_000, scope: 'user' },
  },
  async ({ request, tenantId, user, params }) => {
    const body = await request.json().catch(() => ({}));
    const toolNames = Array.isArray(body?.toolNames)
      ? (body.toolNames as unknown[]).filter((n): n is string => typeof n === 'string')
      : undefined;

    const result = await discoverAndPersist(
      params.serverId,
      tenantId,
      params.id,
      user.id,
      toolNames,
    );
    if ('status' in result) {
      return errorJson(result.error, result.status);
    }

    return NextResponse.json({ success: true, ...result });
  },
);
