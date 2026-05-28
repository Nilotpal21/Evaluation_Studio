/**
 * GET  /api/projects/:id/tools - List project tools (paginated, filterable)
 * POST /api/projects/:id/tools - Create a project tool
 */

import {
  findProjectToolsByProject,
  createProjectTool,
  findProjectToolByName,
  countProjectToolsByProject,
} from '@agent-platform/shared/repos';
import { CreateProjectToolSchema } from '@agent-platform/shared/validation';
import {
  serializeToolFormToDsl,
  computeSourceHash,
  type ProjectToolFormData,
  parseDslProperties,
} from '@agent-platform/shared';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { withRouteHandler } from '@/lib/route-handler';
import { projectToolListResponse, projectToolResponse } from '@/lib/tool-response';
import { errorJson, ErrorCode, isDuplicateKeyError } from '@/lib/api-response';
import { formatUserLabel } from '@/lib/auth';
import { StudioPermission } from '@/lib/permissions';
import { validateUrlWithPlaceholders } from '@/lib/resolve-and-validate-url';
import { isCodeToolsEnabled } from '@/lib/feature-gates';
import { getOrCreateDefaultVariableNamespaceIds } from '@/lib/default-variable-namespace';
import { validateProjectToolBindingsForSave } from '@/lib/project-tool-binding-validation';
import { refreshProjectAgentDraftMetadataForToolMutation } from '@/lib/project-tool-draft-invalidation';

// ─── GET (List) ─────────────────────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_READ },
  async ({ request, tenantId, params }) => {
    const url = new URL(request.url);
    const orderParam = url.searchParams.get('order') ?? undefined;

    const result = await findProjectToolsByProject(tenantId, params.id, {
      page: url.searchParams.get('page') ? Number(url.searchParams.get('page')) : undefined,
      limit: url.searchParams.get('limit') ? Number(url.searchParams.get('limit')) : undefined,
      sort: url.searchParams.get('sort') ?? undefined,
      order: orderParam === 'asc' || orderParam === 'desc' ? orderParam : undefined,
      toolType: url.searchParams.get('toolType') ?? undefined,
      search: url.searchParams.get('search') ?? undefined,
    });

    return projectToolListResponse({
      tools: result.data as unknown as Record<string, unknown>[],
      total: result.pagination.total,
      page: result.pagination.page,
      limit: result.pagination.limit,
    });
  },
);

// ─── POST (Create) ──────────────────────────────────────────────────────

export const POST = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.TOOL_WRITE,
    bodySchema: CreateProjectToolSchema,
  },
  async ({ body, tenantId, user, params }) => {
    // Block sandbox tool creation when code tools are disabled for the tenant
    if (body.toolType === 'sandbox') {
      const enabled = await isCodeToolsEnabled(tenantId);
      if (!enabled) {
        return errorJson(
          'Code tools are not enabled for this workspace',
          403,
          'CODE_TOOLS_DISABLED',
        );
      }
    }

    // Check name uniqueness within project
    const existing = await findProjectToolByName(tenantId, params.id, body.name);
    if (existing) {
      return errorJson(
        `A tool named "${body.name}" already exists in this project`,
        409,
        ErrorCode.NAME_CONFLICT,
      );
    }

    // Enforce max 500 tools per project (D80)
    const toolCount = await countProjectToolsByProject(tenantId, params.id);
    if (toolCount >= 500) {
      return errorJson(
        'E763: Maximum of 500 tools per project reached. Delete unused tools before creating new ones.',
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    // Serialize form data to DSL content string
    // Cast: Zod discriminated union output is structurally compatible with ProjectToolFormData
    const formData = (body.toolType === 'searchai'
      ? { ...body, tenantId }
      : body) as unknown as ProjectToolFormData;
    const dslContent = serializeToolFormToDsl(formData);
    const bindingValidation = await validateProjectToolBindingsForSave({
      tenantId,
      projectId: params.id,
      toolType: body.toolType,
      dslContent,
    });
    if (!bindingValidation.valid) {
      return errorJson(bindingValidation.message, bindingValidation.status, bindingValidation.code);
    }

    const sourceHash = computeSourceHash(dslContent);

    // Determine namespace IDs: use caller-supplied IDs if provided, otherwise auto-tag to default
    const namespaceIds =
      body.variableNamespaceIds && body.variableNamespaceIds.length > 0
        ? body.variableNamespaceIds
        : await getOrCreateDefaultVariableNamespaceIds({
            tenantId,
            projectId: params.id,
            createdBy: formatUserLabel(user),
          });

    // SSRF protection for HTTP tools — resolve template placeholders then validate
    if (body.toolType === 'http' && body.endpoint) {
      const ssrf = await validateUrlWithPlaceholders(body.endpoint, tenantId, params.id, 'dev', {
        allowUnresolvedEnvPlaceholders: true,
        variableNamespaceIds: namespaceIds,
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

    let tool: Awaited<ReturnType<typeof createProjectTool>>;
    try {
      tool = await createProjectTool({
        tenantId,
        projectId: params.id,
        name: body.name,
        slug: body.name,
        toolType: formData.toolType,
        description: formData.description ?? null,
        dslContent,
        sourceHash,
        variableNamespaceIds: namespaceIds,
        createdBy: formatUserLabel(user),
      });
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return errorJson('Tool with the same name already exists', 409, ErrorCode.NAME_CONFLICT);
      }

      throw error;
    }
    await refreshProjectAgentDraftMetadataForToolMutation({
      projectId: params.id,
      tenantId,
    });

    // Trigger Lambda runner deployment for sandbox tools (async, fire-and-forget)
    if (formData.toolType === 'sandbox' && process.env.SANDBOX_BACKEND === 'lambda') {
      import('@/services/lambda-deploy-trigger')
        .then(({ triggerLambdaDeployment }) =>
          triggerLambdaDeployment(tenantId, (formData as any).runtime || 'javascript'),
        )
        .catch((err: unknown) => {
          console.error(
            '[lambda-deploy] trigger failed:',
            err instanceof Error ? err.message : err,
          );
        });
    }

    // Audit: tool created
    logAuditEvent({
      userId: user?.id,
      tenantId,
      action: AuditActions.TOOL_CREATED,
      metadata: {
        toolId: tool.id,
        toolName: body.name,
        toolType: formData.toolType,
        projectId: params.id,
      },
    }).catch((err: unknown) => {
      console.error('[audit] tool_created failed:', err instanceof Error ? err.message : err);
    });

    return projectToolResponse(tool as unknown as Record<string, unknown>, 201);
  },
);
