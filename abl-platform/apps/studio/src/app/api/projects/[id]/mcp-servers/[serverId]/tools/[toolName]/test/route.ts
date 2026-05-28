/**
 * POST /api/projects/:id/mcp-servers/:serverId/tools/:toolName/test - Test a single MCP tool
 */

import { NextResponse } from 'next/server';
import { withRouteHandler } from '@/lib/route-handler';
import { errorJson } from '@/lib/api-response';
import { testMcpTool } from '@/services/mcp-discovery-service';
import { StudioPermission } from '@/lib/permissions';

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.TOOL_EXECUTE,
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'user' },
    sanitizeResponse: { redactHeaders: true, maxBodySize: 100_000 },
  },
  async ({ request, tenantId, params }) => {
    const body = await request.json().catch(() => ({}));
    const input = body?.input || {};

    const result = await testMcpTool(params.serverId, tenantId, params.id, params.toolName, input);
    if ('status' in result) {
      return errorJson(result.error, result.status);
    }

    return NextResponse.json({ success: true, result });
  },
);
