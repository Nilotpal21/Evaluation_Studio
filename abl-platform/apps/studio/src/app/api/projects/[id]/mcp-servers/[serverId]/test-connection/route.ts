/**
 * POST /api/projects/:id/mcp-servers/:serverId/test-connection - Test MCP server connectivity
 */

import { withRouteHandler } from '@/lib/route-handler';
import { successJson } from '@/lib/api-response';
import { testConnection } from '@/services/mcp-discovery-service';
import { errorJson } from '@/lib/api-response';
import { StudioPermission } from '@/lib/permissions';

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.TOOL_READ,
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'user' },
    sanitizeResponse: { redactHeaders: true, maxBodySize: 100_000 },
  },
  async ({ tenantId, params }) => {
    const result = await testConnection(params.serverId, tenantId, params.id);
    if ('status' in result) {
      return errorJson(result.error, result.status);
    }

    return successJson('result', result);
  },
);
