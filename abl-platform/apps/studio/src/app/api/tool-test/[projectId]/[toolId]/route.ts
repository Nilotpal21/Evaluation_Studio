/**
 * GET/PATCH/POST /api/tool-test/:projectId/:toolId
 *
 * Turbopack workaround: the canonical deep path
 * /api/projects/[id]/tools/[toolId]/test (6 segments) is not matched by Turbopack's
 * dev-server route resolver. proxy.ts rewrites that URL to this 4-segment flat handler.
 * withRouteHandler picks up params.projectId (falls back from params.id) so project
 * access and permission checks work identically to the original route.
 */

import { z } from 'zod';
import { executeToolTest } from '@/services/tool-test-service';
import { withRouteHandler } from '@/lib/route-handler';
import { successJson, errorJson, ErrorCode } from '@/lib/api-response';
import { StudioPermission } from '@/lib/permissions';
import { hasPermission } from '@/lib/permission-resolver';
import {
  getToolTestEndpointFixture,
  ToolTestEndpointInputError,
  updateToolTestEndpointFixture,
  type JsonValue,
} from '@/lib/tool-test-endpoint-service';

const TestToolSchema = z.object({
  input: z.record(z.unknown()).optional(),
  timeoutMs: z.number().int().min(1000).max(300_000).optional(),
});

const JsonValueSchema: z.ZodType<JsonValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(JsonValueSchema),
    z.record(z.unknown()),
  ]),
);

const ToolTestEndpointPatchSchema = z
  .object({
    staticResponse: JsonValueSchema.optional(),
    sampleInput: z.record(z.unknown()).nullable().optional(),
  })
  .strict()
  .refine((value) => value.staticResponse !== undefined || value.sampleInput !== undefined, {
    message: 'Provide staticResponse, sampleInput, or both',
  });

export const GET = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.TOOL_READ,
    rateLimit: { limit: 60, windowMs: 60_000, scope: 'user' },
  },
  async ({ tenantId, params }) => {
    const endpoint = await getToolTestEndpointFixture({
      tenantId,
      projectId: params.projectId,
      projectToolId: params.toolId,
    });

    if (!endpoint) {
      return errorJson('Tool test endpoint not found', 404, ErrorCode.NOT_FOUND);
    }

    return successJson('endpoint', endpoint);
  },
);

export const PATCH = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.TOOL_WRITE,
    rateLimit: { limit: 30, windowMs: 60_000, scope: 'user' },
    sanitizeResponse: { maxBodySize: 100_000 },
    bodySchema: ToolTestEndpointPatchSchema,
  },
  async ({ body, tenantId, user, params }) => {
    try {
      const endpoint = await updateToolTestEndpointFixture({
        tenantId,
        projectId: params.projectId,
        projectToolId: params.toolId,
        staticResponse: body.staticResponse,
        sampleInput: body.sampleInput,
        actorId: user.id,
      });

      if (!endpoint) {
        return errorJson('Tool not found', 404, ErrorCode.NOT_FOUND);
      }

      return successJson('endpoint', endpoint);
    } catch (err) {
      if (err instanceof ToolTestEndpointInputError) {
        return errorJson(err.messages, 400, ErrorCode.VALIDATION_ERROR);
      }
      throw err;
    }
  },
);

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
      projectId: params.projectId,
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
