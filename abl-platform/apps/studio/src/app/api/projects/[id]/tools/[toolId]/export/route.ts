/**
 * GET /api/projects/:id/tools/:toolId/export - Export project tool as JSON
 */

import { findProjectToolById } from '@agent-platform/shared/repos';
import { withRouteHandler } from '@/lib/route-handler';
import { errorJson, ErrorCode, successJson } from '@/lib/api-response';
import { sanitizeProjectTool } from '@/lib/tool-response';
import { StudioPermission } from '@/lib/permissions';

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_READ },
  async ({ tenantId, params }) => {
    const tool = await findProjectToolById(params.toolId, tenantId, params.id);
    if (!tool) return errorJson('Tool not found', 404, ErrorCode.NOT_FOUND);

    const {
      id: _id,
      projectId: _pid,
      ...exportData
    } = sanitizeProjectTool(tool as unknown as Record<string, unknown>);

    return successJson('export', { exportVersion: 2, tool: exportData });
  },
);
