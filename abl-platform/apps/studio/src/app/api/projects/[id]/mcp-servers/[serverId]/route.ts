/**
 * GET    /api/projects/:id/mcp-servers/:serverId - Get single server
 * PUT    /api/projects/:id/mcp-servers/:serverId - Update server config
 * DELETE /api/projects/:id/mcp-servers/:serverId - Delete server
 */

import { withRouteHandler } from '@/lib/route-handler';
import { errorJson, ErrorCode, actionJson } from '@/lib/api-response';
import { mcpServerResponse } from '@/lib/mcp-server-response';
import { formatUserLabel } from '@/lib/auth';
import {
  findMcpServerConfigById,
  updateProjectScopedMcpServerConfig,
  deleteProjectScopedMcpServerConfigWithCascade,
  findProjectToolsByProject,
} from '@agent-platform/shared/repos';
import { StudioPermission } from '@/lib/permissions';
import { validateMcpAuthConfig, validateMcpHeaders } from '@/lib/mcp-server-validation';
import { validateUrlWithPlaceholders } from '@/lib/resolve-and-validate-url';
import {
  validateMcpAuthProfileCompatibility,
  validateMcpEnvProfileCompatibility,
} from '@/lib/mcp-auth-profile-compat';
import { refreshProjectAgentDraftMetadataForMcpServerMutation } from '@/lib/project-mcp-draft-invalidation';

// ─── GET ─────────────────────────────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_READ },
  async ({ tenantId, params }) => {
    const server = await findMcpServerConfigById(params.serverId, tenantId);
    if (!server || server.projectId !== params.id)
      return errorJson('MCP server not found', 404, ErrorCode.NOT_FOUND);

    // Count MCP tools discovered from this server (name prefix convention: servername__)
    const serverPrefix = server.name.toLowerCase().replace(/[^a-z0-9_]+/g, '_');
    const result = await findProjectToolsByProject(tenantId, server.projectId, {
      toolType: 'mcp',
      search: `${serverPrefix}__`,
      limit: 1,
    });

    return mcpServerResponse({ ...server, discoveredToolCount: result.pagination.total });
  },
);

// ─── PUT ─────────────────────────────────────────────────────────────────

export const PUT = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_WRITE },
  async ({ request, tenantId, user, params }) => {
    const existing = await findMcpServerConfigById(params.serverId, tenantId);
    if (!existing || existing.projectId !== params.id)
      return errorJson('MCP server not found', 404, ErrorCode.NOT_FOUND);

    const body = await request.json();
    const updateData: Record<string, unknown> = { modifiedBy: formatUserLabel(user) };
    const {
      name,
      description,
      transport,
      url: serverUrl,
      env,
      authType: rawAuthType,
      authConfig,
      headers: rawHeaders,
      authProfileId,
      envProfileId,
      priority,
      tags,
      connectionTimeoutMs,
      requestTimeoutMs,
      autoReconnect,
      maxReconnectAttempts,
    } = body;

    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (trimmed.length < 2)
        return errorJson('name must be at least 2 characters', 400, ErrorCode.VALIDATION_ERROR);
      if (trimmed.length > 128)
        return errorJson('name exceeds 128 characters', 400, ErrorCode.VALIDATION_ERROR);
      updateData.name = trimmed;
    }

    if (description !== undefined) {
      updateData.description = description ? String(description).slice(0, 500) : null;
    }

    if (transport !== undefined) updateData.transport = String(transport);

    // SSRF protection on URL update — resolve template placeholders then validate
    if (serverUrl !== undefined && serverUrl !== null) {
      const finalTransport = transport !== undefined ? String(transport) : existing.transport;
      if (finalTransport === 'sse' || finalTransport === 'http') {
        const ssrfResult = await validateUrlWithPlaceholders(
          String(serverUrl),
          tenantId,
          params.id,
        );
        if (!ssrfResult.safe)
          return errorJson(
            ssrfResult.reason ?? 'URL blocked by SSRF protection',
            400,
            ErrorCode.VALIDATION_ERROR,
          );
      }
      updateData.url = serverUrl ? String(serverUrl) : null;
    }

    if (typeof priority === 'number') updateData.priority = priority;
    if (typeof connectionTimeoutMs === 'number')
      updateData.connectionTimeoutMs = connectionTimeoutMs;
    if (typeof requestTimeoutMs === 'number') updateData.requestTimeoutMs = requestTimeoutMs;
    if (autoReconnect !== undefined) updateData.autoReconnect = Boolean(autoReconnect);
    if (typeof maxReconnectAttempts === 'number')
      updateData.maxReconnectAttempts = maxReconnectAttempts;

    if (tags !== undefined) {
      updateData.tags = tags ? JSON.stringify(tags) : null;
    }

    // Re-encrypt env
    if (env !== undefined) {
      if (env === null) {
        updateData.encryptedEnv = null;
      } else if (typeof env === 'object' && !Array.isArray(env)) {
        // Plugin encrypts encryptedEnv transparently in pre-save hook
        updateData.encryptedEnv = JSON.stringify(env);
      }
    }

    // Custom headers update (plain-text, may contain {{session.X}} templates)
    if (rawHeaders !== undefined) {
      if (rawHeaders === null) {
        updateData.headers = null;
      } else if (typeof rawHeaders === 'object' && !Array.isArray(rawHeaders)) {
        const headerError = validateMcpHeaders(rawHeaders);
        if (headerError) {
          return errorJson(headerError, 400, ErrorCode.VALIDATION_ERROR);
        }
        updateData.headers = JSON.stringify(rawHeaders);
      } else {
        return errorJson('headers must be an object', 400, ErrorCode.VALIDATION_ERROR);
      }
    }

    const normalizedRequestedAuthProfileId =
      authProfileId === undefined
        ? undefined
        : authProfileId === null
          ? null
          : typeof authProfileId === 'string'
            ? authProfileId.trim() || null
            : '__invalid__';

    if (normalizedRequestedAuthProfileId === '__invalid__') {
      return errorJson('authProfileId must be a string or null', 400, ErrorCode.VALIDATION_ERROR);
    }

    // Auth config update: ignore inline auth updates when request explicitly selects authProfileId.
    if (
      rawAuthType !== undefined &&
      !(typeof normalizedRequestedAuthProfileId === 'string' && normalizedRequestedAuthProfileId)
    ) {
      const authError = validateMcpAuthConfig(String(rawAuthType), authConfig);
      if (authError) return errorJson(authError, 400, ErrorCode.VALIDATION_ERROR);

      updateData.authType = String(rawAuthType);
      if (rawAuthType === 'none') {
        updateData.encryptedAuthConfig = null;
      } else {
        // Plugin encrypts encryptedAuthConfig transparently in pre-save hook
        updateData.encryptedAuthConfig = JSON.stringify(authConfig);
      }
    }

    if (authProfileId !== undefined) {
      if (normalizedRequestedAuthProfileId === null) {
        updateData.authProfileId = null;
      } else if (typeof normalizedRequestedAuthProfileId === 'string') {
        const compatibility = await validateMcpAuthProfileCompatibility({
          tenantId,
          projectId: params.id,
          authProfileId: normalizedRequestedAuthProfileId,
          transport:
            (updateData.transport as 'http' | 'sse' | undefined) ??
            (existing.transport as unknown as 'http' | 'sse') ??
            'sse',
          userId: user.id,
        });
        if (!compatibility.ok) {
          return errorJson(
            compatibility.message ?? 'Auth profile is not compatible with MCP',
            compatibility.status ?? 400,
            compatibility.code ?? ErrorCode.VALIDATION_ERROR,
          );
        }

        updateData.authProfileId = normalizedRequestedAuthProfileId;
        updateData.authType = 'none';
        updateData.encryptedAuthConfig = null;
      }
    }

    if (transport !== undefined && authProfileId === undefined) {
      const existingAuthProfileIdValue = (existing as Record<string, unknown>).authProfileId;
      const existingAuthProfileId =
        typeof existingAuthProfileIdValue === 'string' ? existingAuthProfileIdValue.trim() : '';
      if (existingAuthProfileId.length > 0) {
        const compatibility = await validateMcpAuthProfileCompatibility({
          tenantId,
          projectId: params.id,
          authProfileId: existingAuthProfileId,
          transport:
            (updateData.transport as 'http' | 'sse' | undefined) ??
            (existing.transport as unknown as 'http' | 'sse') ??
            'sse',
          userId: user.id,
        });
        if (!compatibility.ok) {
          return errorJson(
            compatibility.message ?? 'Auth profile is not compatible with MCP',
            compatibility.status ?? 400,
            compatibility.code ?? ErrorCode.VALIDATION_ERROR,
          );
        }
      }
    }

    if (envProfileId !== undefined) {
      if (envProfileId === null || envProfileId === '') {
        updateData.envProfileId = null;
      } else if (typeof envProfileId === 'string') {
        const trimmed = envProfileId.trim();
        if (trimmed.length > 0) {
          const compatibility = await validateMcpEnvProfileCompatibility({
            tenantId,
            projectId: params.id,
            envProfileId: trimmed,
            userId: user.id,
          });
          if (!compatibility.ok) {
            return errorJson(
              compatibility.message ?? 'Env profile is not compatible with MCP',
              compatibility.status ?? 400,
              compatibility.code ?? ErrorCode.VALIDATION_ERROR,
            );
          }
        }
        updateData.envProfileId = trimmed.length > 0 ? trimmed : null;
      } else {
        return errorJson('envProfileId must be a string or null', 400, ErrorCode.VALIDATION_ERROR);
      }
    }

    const updated = await updateProjectScopedMcpServerConfig(
      params.serverId,
      tenantId,
      params.id,
      updateData,
    );
    if (!updated) {
      return errorJson(
        'Version conflict - server was modified by another request',
        409,
        ErrorCode.NAME_CONFLICT,
      );
    }
    await refreshProjectAgentDraftMetadataForMcpServerMutation({
      projectId: params.id,
      tenantId,
    });

    return mcpServerResponse(updated);
  },
);

// ─── DELETE ──────────────────────────────────────────────────────────────

export const DELETE = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_DELETE },
  async ({ tenantId, params }) => {
    const existing = await findMcpServerConfigById(params.serverId, tenantId);
    if (!existing || existing.projectId !== params.id)
      return errorJson('MCP server not found', 404, ErrorCode.NOT_FOUND);

    await deleteProjectScopedMcpServerConfigWithCascade(params.serverId, tenantId, params.id);
    await refreshProjectAgentDraftMetadataForMcpServerMutation({
      projectId: params.id,
      tenantId,
    });

    return actionJson({ deleted: params.serverId });
  },
);
