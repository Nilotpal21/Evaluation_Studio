/**
 * POST /api/projects/:id/tools/import - Import project tool from exported JSON
 */

import { z } from 'zod';
import { createProjectTool, findProjectToolByName } from '@agent-platform/shared/repos';
import { computeSourceHash, parseDslProperties } from '@agent-platform/shared';
import { MAX_DSL_SIZE, TOOL_NAME_REGEX } from '@agent-platform/shared/validation';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { withRouteHandler } from '@/lib/route-handler';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { projectToolResponse } from '@/lib/tool-response';
import { formatUserLabel } from '@/lib/auth';
import { StudioPermission } from '@/lib/permissions';
import { isCodeToolsEnabled } from '@/lib/feature-gates';
import { validateUrlWithPlaceholders } from '@/lib/resolve-and-validate-url';
import { getOrCreateDefaultVariableNamespaceIds } from '@/lib/default-variable-namespace';
import { validateProjectToolBindingsForSave } from '@/lib/project-tool-binding-validation';
import {
  PROJECT_TOOL_TYPES,
  isProjectToolType,
  validateProjectToolDslForPersistence,
} from '@/lib/tool-dsl-consistency';
import { refreshProjectAgentDraftMetadataForToolMutation } from '@/lib/project-tool-draft-invalidation';

const ImportPayloadSchema = z
  .object({
    // v2 format (flat project tool)
    tool: z.record(z.unknown()).optional(),
    // v1 wrapped format
    export: z
      .object({
        tool: z.record(z.unknown()),
        version: z.record(z.unknown()).optional(),
      })
      .optional(),
  })
  .refine(
    (d) => d.tool || d.export?.tool,
    'Invalid import format. Expected { tool: {...} } or { export: { tool: {...} } }',
  );

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.TOOL_WRITE,
    bodySchema: ImportPayloadSchema,
  },
  async ({ body, tenantId, user, params }) => {
    const toolData = (body.tool || body.export?.tool) as Record<string, unknown> | undefined;
    if (!toolData) {
      return errorJson(
        'Invalid import format. Expected { tool: {...} }',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Extract required fields
    const name = typeof toolData.name === 'string' ? toolData.name : '';
    const toolType = typeof toolData.toolType === 'string' ? toolData.toolType : '';
    const dslContent = typeof toolData.dslContent === 'string' ? toolData.dslContent : '';
    const description = typeof toolData.description === 'string' ? toolData.description : null;

    if (!name || !TOOL_NAME_REGEX.test(name)) {
      return errorJson(
        `Invalid tool name "${name}". Must be lowercase with underscores only (2-64 chars).`,
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Block sandbox tool import when code tools are disabled for the tenant
    if (toolType === 'sandbox') {
      const enabled = await isCodeToolsEnabled(tenantId);
      if (!enabled) {
        return errorJson(
          'Code tools are not enabled for this workspace',
          403,
          'CODE_TOOLS_DISABLED',
        );
      }
    }

    if (!isProjectToolType(toolType)) {
      return errorJson(
        `Invalid toolType "${toolType}". Must be ${PROJECT_TOOL_TYPES.join(', ')}.`,
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    if (!dslContent) {
      return errorJson('Missing dslContent in import payload', 400, ErrorCode.VALIDATION_ERROR);
    }

    if (dslContent.length > MAX_DSL_SIZE) {
      return errorJson(
        `ABL content exceeds maximum size of ${MAX_DSL_SIZE} bytes`,
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const consistency = validateProjectToolDslForPersistence({
      tenantId,
      projectId: params.id,
      name,
      toolType,
      dslContent,
    });
    if (!consistency.valid) {
      return errorJson(consistency.message, 400, ErrorCode.VALIDATION_ERROR);
    }
    const bindingValidation = await validateProjectToolBindingsForSave({
      tenantId,
      projectId: params.id,
      toolType,
      dslContent,
    });
    if (!bindingValidation.valid) {
      return errorJson(bindingValidation.message, bindingValidation.status, bindingValidation.code);
    }

    // Check name uniqueness
    const existing = await findProjectToolByName(tenantId, params.id, name);
    if (existing) {
      return errorJson(
        `A tool named "${name}" already exists in this project`,
        409,
        ErrorCode.NAME_CONFLICT,
      );
    }

    const createdBy = formatUserLabel(user);
    const variableNamespaceIds = await getOrCreateDefaultVariableNamespaceIds({
      tenantId,
      projectId: params.id,
      createdBy,
    });

    // SSRF protection: resolve template placeholders before validating imported HTTP tools
    if (toolType === 'http') {
      const endpoint = parseDslProperties(dslContent).endpoint;
      if (endpoint) {
        const ssrf = await validateUrlWithPlaceholders(endpoint, tenantId, params.id, 'dev', {
          allowUnresolvedEnvPlaceholders: true,
          variableNamespaceIds,
          useDefaultNamespaceFallback: true,
        });
        if (!ssrf.safe) {
          return errorJson(
            ssrf.reason || 'Endpoint blocked by SSRF protection',
            400,
            ErrorCode.VALIDATION_ERROR,
          );
        }
      }
    }

    const sourceHash = computeSourceHash(dslContent);

    const tool = await createProjectTool({
      tenantId,
      projectId: params.id,
      name,
      slug: name,
      toolType,
      description,
      dslContent,
      sourceHash,
      variableNamespaceIds,
      createdBy,
    });
    await refreshProjectAgentDraftMetadataForToolMutation({
      projectId: params.id,
      tenantId,
    });

    // Audit: tool imported
    logAuditEvent({
      userId: user?.id,
      tenantId,
      action: AuditActions.TOOL_CREATED,
      metadata: {
        toolId: tool.id,
        toolName: name,
        toolType,
        projectId: params.id,
        imported: true,
      },
    }).catch((err: unknown) => {
      console.error('[audit] tool_imported failed:', err instanceof Error ? err.message : err);
    });

    return projectToolResponse(tool as unknown as Record<string, unknown>, 201);
  },
);
