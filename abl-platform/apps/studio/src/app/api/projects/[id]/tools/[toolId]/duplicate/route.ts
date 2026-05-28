/**
 * POST /api/projects/:id/tools/:toolId/duplicate - Duplicate a project tool
 */

import {
  findProjectToolById,
  createProjectTool,
  findProjectToolByName,
} from '@agent-platform/shared/repos';
import { withRouteHandler } from '@/lib/route-handler';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { projectToolResponse } from '@/lib/tool-response';
import { formatUserLabel } from '@/lib/auth';
import { StudioPermission } from '@/lib/permissions';
import {
  isProjectToolType,
  prepareProjectToolDslForPersistence,
  rewriteToolDslSignatureName,
} from '@/lib/tool-dsl-consistency';
import { refreshProjectAgentDraftMetadataForToolMutation } from '@/lib/project-tool-draft-invalidation';
import { validateProjectToolBindingsForSave } from '@/lib/project-tool-binding-validation';

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_WRITE },
  async ({ tenantId, user, params }) => {
    const source = await findProjectToolById(params.toolId, tenantId, params.id);
    if (!source) return errorJson('Tool not found', 404, ErrorCode.NOT_FOUND);

    // Generate a unique copy name (DSL-safe: lowercase, underscores only)
    let copyName = `${source.name}_copy`;
    let suffix = 2;
    while (await findProjectToolByName(tenantId, params.id, copyName)) {
      copyName = `${source.name}_copy_${suffix++}`;
    }

    if (!isProjectToolType(source.toolType)) {
      return errorJson('Unsupported source tool type', 400, ErrorCode.VALIDATION_ERROR);
    }

    const newDslContent = rewriteToolDslSignatureName(source.dslContent, copyName);
    const prepared = prepareProjectToolDslForPersistence({
      tenantId,
      projectId: params.id,
      name: copyName,
      toolType: source.toolType,
      dslContent: newDslContent,
    });
    if (!prepared.valid) {
      return errorJson(prepared.message, 400, ErrorCode.VALIDATION_ERROR);
    }

    const bindingValidation = await validateProjectToolBindingsForSave({
      tenantId,
      projectId: params.id,
      toolType: source.toolType,
      dslContent: prepared.dslContent,
    });
    if (!bindingValidation.valid) {
      return errorJson(
        bindingValidation.message,
        bindingValidation.status,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const newTool = await createProjectTool({
      tenantId,
      projectId: params.id,
      name: copyName,
      slug: copyName,
      toolType: source.toolType,
      description: source.description,
      dslContent: prepared.dslContent,
      sourceHash: prepared.sourceHash,
      variableNamespaceIds: source.variableNamespaceIds ?? [],
      createdBy: formatUserLabel(user),
    });
    await refreshProjectAgentDraftMetadataForToolMutation({
      projectId: params.id,
      tenantId,
    });

    // Audit: tool duplicated
    logAuditEvent({
      userId: user?.id,
      tenantId,
      action: AuditActions.TOOL_CREATED,
      metadata: {
        toolId: newTool.id,
        toolName: copyName,
        toolType: source.toolType,
        projectId: params.id,
        duplicatedFrom: params.toolId,
        duplicatedFromName: source.name,
      },
    }).catch((err: unknown) => {
      console.error('[audit] tool_duplicated failed:', err instanceof Error ? err.message : err);
    });

    return projectToolResponse(newTool as unknown as Record<string, unknown>, 201);
  },
);
