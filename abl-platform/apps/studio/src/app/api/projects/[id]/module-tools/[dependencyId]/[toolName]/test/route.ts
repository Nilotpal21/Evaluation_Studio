/**
 * POST /api/projects/:id/module-tools/:dependencyId/:toolName/test
 *
 * Test an imported module tool by resolving the tool binding from the module
 * release artifact and executing with the consumer project's credentials.
 */

import { z } from 'zod';
import { withRouteHandler } from '@/lib/route-handler';
import { successJson, errorJson, ErrorCode } from '@/lib/api-response';
import { StudioPermission } from '@/lib/permissions';
import { ensureDb } from '@/lib/ensure-db';
import { executeModuleToolTest } from '@/services/tool-test-service';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('api:module-tool-test');

const TestModuleToolSchema = z
  .object({
    input: z.record(z.unknown()).optional(),
    timeoutMs: z.number().int().min(1000).max(300_000).optional(),
  })
  .strict();

type TestModuleToolInput = z.infer<typeof TestModuleToolSchema>;

export const POST = withRouteHandler<TestModuleToolInput>(
  {
    requireProject: true,
    permissions: StudioPermission.TOOL_EXECUTE,
    requireFeature: 'reusable_modules',
    rateLimit: { limit: 10, windowMs: 60_000, scope: 'user' },
    sanitizeResponse: { redactHeaders: true, maxBodySize: 100_000 },
    bodySchema: TestModuleToolSchema,
  },
  async ({ body, tenantId, user, params }) => {
    await ensureDb();
    const projectId = params.id;
    const dependencyId = params.dependencyId;
    const toolName = params.toolName;

    if (!dependencyId || !toolName) {
      return errorJson('Dependency ID and tool name are required', 400, ErrorCode.VALIDATION_ERROR);
    }

    // 1. Load dependency scoped to project + tenant
    const { ProjectModuleDependency, ModuleRelease } =
      await import('@agent-platform/database/models');

    const dependency = await ProjectModuleDependency.findOne({
      _id: dependencyId,
      projectId,
      tenantId,
    }).lean();

    if (!dependency) {
      return errorJson('Module dependency not found', 404, ErrorCode.NOT_FOUND);
    }

    // 2. Load the resolved release — scope by moduleProjectId for integrity.
    //    projectId is the consumer; moduleProjectId is the source module's project.
    const release = await ModuleRelease.findOne({
      _id: dependency.resolvedReleaseId,
      tenantId,
      moduleProjectId: dependency.moduleProjectId,
    }).lean();

    if (!release) {
      return errorJson('Module release not found', 404, ErrorCode.NOT_FOUND);
    }

    // 3. Extract tool from artifact
    const artifact = release.artifact;
    const toolData = artifact?.tools?.[toolName];
    if (!toolData) {
      return errorJson(`Tool "${toolName}" not found in module release`, 404, ErrorCode.NOT_FOUND);
    }

    // 4. Execute the tool test using the consumer project's credentials
    const result = await executeModuleToolTest({
      toolName,
      dslContent: toolData.dslContent,
      toolType: toolData.toolType,
      tenantId,
      userId: user.id,
      projectId,
      input: body.input,
      timeoutMs: body.timeoutMs,
    });

    if (result.errorCode === ErrorCode.NOT_FOUND) {
      return errorJson('Tool not found', 404, ErrorCode.NOT_FOUND);
    }

    log.info('Module tool test executed', {
      projectId,
      dependencyId,
      toolName,
      toolType: toolData.toolType,
      latencyMs: result.latencyMs,
      hasError: !!result.error,
    });

    return successJson('result', result);
  },
);
