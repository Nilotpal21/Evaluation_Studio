/**
 * POST /api/projects/:id/tools/:toolId/test - Test tool execution
 */

import { z } from 'zod';
import { executeToolTest } from '@/services/tool-test-service';
import { withRouteHandler } from '@/lib/route-handler';
import { successJson, errorJson, ErrorCode } from '@/lib/api-response';
import { StudioPermission } from '@/lib/permissions';
import { hasPermission } from '@/lib/permission-resolver';

const TestToolSchema = z.object({
  input: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
});

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.TOOL_EXECUTE,
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'user' },
    sanitizeResponse: { redactHeaders: true, maxBodySize: 100_000 },
    bodySchema: TestToolSchema,
  },
  async ({ body, tenantId, user, params, request }) => {
    const debug = request.nextUrl?.searchParams?.get('debug') === 'true';

    if (debug) {
      if (!hasPermission(user.permissions, StudioPermission.TOOL_WRITE)) {
        return errorJson('Debug mode requires tool:write permission', 403, ErrorCode.FORBIDDEN);
      }
    }

    const result = await executeToolTest({
      toolId: params.toolId,
      tenantId,
      userId: user.id,
      projectId: params.id,
      input: body.input,
      timeoutMs: body.timeoutMs,
      debug,
    });

    if (result.errorCode === ErrorCode.NOT_FOUND) {
      return errorJson('Tool not found', 404, ErrorCode.NOT_FOUND);
    }

    return successJson('result', result);
  },
);
