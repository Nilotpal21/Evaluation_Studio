/**
 * GET    /api/projects/:id/tools/:toolId - Get project tool
 * PUT    /api/projects/:id/tools/:toolId - Update project tool
 * DELETE /api/projects/:id/tools/:toolId - Delete project tool
 */

import {
  findProjectToolById,
  findProjectToolByName,
  updateProjectTool,
  deleteProjectTool,
} from '@agent-platform/shared/repos';
import { UpdateProjectToolSchema } from '@agent-platform/shared/validation';
import { computeSourceHash, parseDslProperties } from '@agent-platform/shared';
import { logAuditEvent, AuditActions } from '@/services/audit-service';
import { withRouteHandler } from '@/lib/route-handler';
import { errorJson, actionJson, ErrorCode } from '@/lib/api-response';
import { projectToolResponse } from '@/lib/tool-response';
import { formatUserLabel } from '@/lib/auth';
import { StudioPermission } from '@/lib/permissions';
import { validateUrlWithPlaceholders } from '@/lib/resolve-and-validate-url';
import { isCodeToolsEnabled } from '@/lib/feature-gates';
import { validateProjectToolBindingsForSave } from '@/lib/project-tool-binding-validation';
import { refreshProjectAgentDraftMetadataForToolMutation } from '@/lib/project-tool-draft-invalidation';
import {
  rewriteToolDslSignatureName,
  validateProjectToolDslForPersistence,
} from '@/lib/tool-dsl-consistency';

// ─── GET ─────────────────────────────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_READ },
  async ({ tenantId, params }) => {
    const tool = await findProjectToolById(params.toolId, tenantId, params.id);
    if (!tool) return errorJson('Tool not found', 404, ErrorCode.NOT_FOUND);

    return projectToolResponse(tool as unknown as Record<string, unknown>);
  },
);

// ─── PUT ─────────────────────────────────────────────────────────────────

export const PUT = withRouteHandler(
  {
    requireProject: true,
    permissions: StudioPermission.TOOL_WRITE,
    bodySchema: UpdateProjectToolSchema,
  },
  async ({ body, tenantId, user, params }) => {
    // Verify tool exists
    const existing = await findProjectToolById(params.toolId, tenantId, params.id);
    if (!existing) return errorJson('Tool not found', 404, ErrorCode.NOT_FOUND);

    // Block sandbox tool updates when code tools are disabled for the tenant
    if (existing.toolType === 'sandbox') {
      const enabled = await isCodeToolsEnabled(tenantId);
      if (!enabled) {
        return errorJson(
          'Code tools are not enabled for this workspace',
          403,
          'CODE_TOOLS_DISABLED',
        );
      }
    }

    // Check name uniqueness when renaming
    if (body.name !== undefined && body.name !== existing.name) {
      const conflict = await findProjectToolByName(tenantId, params.id, body.name);
      if (conflict) {
        return errorJson(
          `A tool named "${body.name}" already exists in this project`,
          409,
          ErrorCode.NAME_CONFLICT,
        );
      }
    }

    const targetName = body.name ?? existing.name;
    const generatedDslContent =
      body.dslContent === undefined && body.name !== undefined && body.name !== existing.name
        ? rewriteToolDslSignatureName(existing.dslContent, body.name)
        : undefined;
    const nextDslContent = body.dslContent ?? generatedDslContent;

    if (nextDslContent !== undefined) {
      const consistency = validateProjectToolDslForPersistence({
        tenantId,
        projectId: params.id,
        name: targetName,
        toolType: existing.toolType,
        dslContent: nextDslContent,
      });
      if (!consistency.valid) {
        return errorJson(consistency.message, 400, ErrorCode.VALIDATION_ERROR);
      }
      const bindingValidation = await validateProjectToolBindingsForSave({
        tenantId,
        projectId: params.id,
        toolType: existing.toolType,
        dslContent: nextDslContent,
      });
      if (!bindingValidation.valid) {
        return errorJson(
          bindingValidation.message,
          bindingValidation.status,
          bindingValidation.code,
        );
      }
    }

    // SSRF protection: if dslContent changes and tool is HTTP, resolve placeholders then validate
    if (nextDslContent !== undefined && existing.toolType === 'http') {
      const endpoint = parseDslProperties(nextDslContent).endpoint;
      if (endpoint) {
        const variableNamespaceIds =
          body.variableNamespaceIds ?? existing.variableNamespaceIds ?? [];
        const ssrf = await validateUrlWithPlaceholders(endpoint, tenantId, params.id, 'dev', {
          allowUnresolvedEnvPlaceholders: true,
          variableNamespaceIds,
          useDefaultNamespaceFallback: false,
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

    // Build update payload
    const updateData: {
      name?: string;
      description?: string | null;
      dslContent?: string;
      sourceHash?: string;
      variableNamespaceIds?: string[];
      lastEditedBy?: string;
    } = {
      lastEditedBy: formatUserLabel(user),
    };

    if (body.name !== undefined) {
      updateData.name = body.name;
    }

    if (body.description !== undefined) {
      updateData.description = body.description;
    }

    if (nextDslContent !== undefined) {
      updateData.dslContent = nextDslContent;
      updateData.sourceHash = computeSourceHash(nextDslContent);
    }

    // Validate namespace-variable resolution when namespaces or DSL references are being updated
    let unresolvedWarnings: string[] = [];
    if (body.variableNamespaceIds !== undefined || nextDslContent !== undefined) {
      const effectiveVariableNamespaceIds =
        body.variableNamespaceIds ?? existing.variableNamespaceIds ?? [];

      if (body.variableNamespaceIds !== undefined) {
        updateData.variableNamespaceIds = body.variableNamespaceIds;
      }

      // Extract DB-backed placeholder references from the DSL
      const dsl = nextDslContent ?? existing.dslContent ?? '';
      const secretRefs = new Set<string>();
      const placeholderRegex = /\{\{(?:secrets|env|config)\.(\w+)\}\}/g;
      let match: RegExpExecArray | null;
      while ((match = placeholderRegex.exec(dsl)) !== null) {
        secretRefs.add(match[1]);
      }

      if (secretRefs.size > 0 && effectiveVariableNamespaceIds.length > 0) {
        try {
          const { EnvironmentVariable, ProjectConfigVariable, VariableNamespaceMembership } =
            await import('@agent-platform/database/models');

          for (const key of secretRefs) {
            // Check env vars
            const envVar = await EnvironmentVariable.findOne({
              tenantId,
              projectId: params.id,
              key,
            })
              .select('_id')
              .lean();

            if (envVar) {
              const membership = await VariableNamespaceMembership.findOne({
                tenantId,
                projectId: params.id,
                variableId: envVar._id,
                variableType: 'env',
                namespaceId: { $in: effectiveVariableNamespaceIds },
              }).lean();
              if (!membership) {
                unresolvedWarnings.push(
                  `Variable "${key}" exists but is not in any of the tool's linked namespaces`,
                );
              }
              continue;
            }

            // Check config vars
            const configVar = await ProjectConfigVariable.findOne({
              tenantId,
              projectId: params.id,
              key,
            })
              .select('_id')
              .lean();

            if (configVar) {
              const membership = await VariableNamespaceMembership.findOne({
                tenantId,
                projectId: params.id,
                variableId: configVar._id,
                variableType: 'config',
                namespaceId: { $in: effectiveVariableNamespaceIds },
              }).lean();
              if (!membership) {
                unresolvedWarnings.push(
                  `Variable "${key}" exists but is not in any of the tool's linked namespaces`,
                );
              }
              continue;
            }

            unresolvedWarnings.push(`Variable "${key}" not found in project`);
          }
        } catch {
          // Non-fatal: validation failure shouldn't block save
        }
      } else if (secretRefs.size > 0 && effectiveVariableNamespaceIds.length === 0) {
        unresolvedWarnings = Array.from(secretRefs).map(
          (key) => `Variable "${key}" will not resolve — tool has no linked namespaces`,
        );
      }
    }

    const updated = await updateProjectTool(params.toolId, tenantId, params.id, updateData);
    if (!updated) {
      return errorJson('Tool not found', 404, ErrorCode.NOT_FOUND);
    }
    await refreshProjectAgentDraftMetadataForToolMutation({
      projectId: params.id,
      tenantId,
    });

    // Trigger Lambda runner deployment for sandbox tools (async, fire-and-forget)
    if (existing.toolType === 'sandbox' && process.env.SANDBOX_BACKEND === 'lambda') {
      import('@/services/lambda-deploy-trigger')
        .then(({ triggerLambdaDeployment }) => triggerLambdaDeployment(tenantId, 'javascript'))
        .catch((err: unknown) => {
          console.error(
            '[lambda-deploy] trigger failed:',
            err instanceof Error ? err.message : err,
          );
        });
    }

    // Audit: tool updated
    const changedFields = Object.keys(body);
    logAuditEvent({
      userId: user?.id,
      tenantId,
      action: AuditActions.TOOL_UPDATED,
      metadata: {
        toolId: params.toolId,
        toolName: existing.name,
        toolType: existing.toolType,
        projectId: params.id,
        changedFields,
      },
    }).catch((err: unknown) => {
      console.error('[audit] tool_updated failed:', err instanceof Error ? err.message : err);
    });

    const response = projectToolResponse(updated as unknown as Record<string, unknown>);

    // Attach unresolved variable warnings if any
    if (unresolvedWarnings.length > 0) {
      const responseBody = await response.json();
      return new (await import('next/server')).NextResponse(
        JSON.stringify({ ...responseBody, warnings: unresolvedWarnings }),
        { status: response.status, headers: response.headers },
      );
    }

    return response;
  },
);

// ─── DELETE ──────────────────────────────────────────────────────────────

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_DELETE },
  async ({ request, tenantId, user, params }) => {
    const existing = await findProjectToolById(params.toolId, tenantId, params.id);
    if (!existing) return errorJson('Tool not found', 404, ErrorCode.NOT_FOUND);

    // Check if any agents reference this tool
    const { ProjectAgent } = await import('@agent-platform/database/models');
    const toolName = existing.name;
    const escapedToolName = toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const impactedAgents = await ProjectAgent.find(
      {
        tenantId,
        projectId: params.id,
        dslContent: { $regex: `\\b${escapedToolName}\\s*\\(`, $options: 'm' },
      },
      { name: 1, _id: 0 },
    ).lean();
    const agentNames = impactedAgents.map((a: { name: string }) => a.name);

    // If agents are impacted, require ?force=true
    if (agentNames.length > 0) {
      const url = new URL(request.url);
      const force = url.searchParams.get('force') === 'true';
      if (!force) {
        return errorJson(
          `Cannot delete tool "${toolName}" — it is used by ${agentNames.length} agent(s): ${agentNames.join(', ')}. Use ?force=true to delete anyway.`,
          409,
          ErrorCode.NAME_CONFLICT,
        );
      }
    }

    const deleted = await deleteProjectTool(params.toolId, tenantId, params.id);
    if (!deleted) return errorJson('Tool not found', 404, ErrorCode.NOT_FOUND);
    await refreshProjectAgentDraftMetadataForToolMutation({
      projectId: params.id,
      tenantId,
    });

    // Cascade-delete transient inline-hosted auth profiles for this tool
    try {
      const { cleanupInlineHostsForTool } =
        await import('@agent-platform/shared/services/auth-profile');
      await cleanupInlineHostsForTool(params.toolId, { tenantId });
    } catch (err: unknown) {
      // Non-critical — log and continue
      const { createLogger } = await import('@abl/compiler/platform/logger.js');
      const toolLog = createLogger('tool-delete-inline-cleanup');
      toolLog.warn('Failed to cleanup inline-hosted auth profiles for deleted tool', {
        toolId: params.toolId,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Audit: tool deleted
    logAuditEvent({
      userId: user?.id,
      tenantId,
      action: AuditActions.TOOL_DELETED,
      metadata: {
        toolId: params.toolId,
        toolName: existing.name,
        toolType: existing.toolType,
        projectId: params.id,
        impactedAgents: agentNames,
      },
    }).catch((err: unknown) => {
      console.error('[audit] tool_deleted failed:', err instanceof Error ? err.message : err);
    });

    return actionJson({ deleted: params.toolId });
  },
);
