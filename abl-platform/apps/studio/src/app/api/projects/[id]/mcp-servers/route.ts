/**
 * GET  /api/projects/:id/mcp-servers - List MCP servers
 * POST /api/projects/:id/mcp-servers - Create MCP server config
 */

import { withRouteHandler } from '@/lib/route-handler';
import { errorJson, ErrorCode } from '@/lib/api-response';
import { mcpServerListResponse, mcpServerResponse } from '@/lib/mcp-server-response';
import { formatUserLabel } from '@/lib/auth';
import {
  findMcpServerConfigsWithToolCount,
  createMcpServerConfig,
} from '@agent-platform/shared/repos';
import { StudioPermission } from '@/lib/permissions';
import { validateMcpAuthConfig, validateMcpHeaders } from '@/lib/mcp-server-validation';
import { validateUrlWithPlaceholders } from '@/lib/resolve-and-validate-url';
import {
  validateMcpAuthProfileCompatibility,
  validateMcpEnvProfileCompatibility,
} from '@/lib/mcp-auth-profile-compat';
import { refreshProjectAgentDraftMetadataForMcpServerMutation } from '@/lib/project-mcp-draft-invalidation';
import { createLogger } from '@abl/compiler/platform/logger.js';
import { isTenantEncryptionReady, isDEKEnvelopeFormat } from '@agent-platform/shared/encryption';

const log = createLogger('api:projects:mcp-servers');

const MAX_NAME_LENGTH = 128;
const MAX_URL_LENGTH = 2048;
const MAX_ENV_VARS = 50;

function validateTransport(body: Record<string, unknown>): string | null {
  const transport = typeof body.transport === 'string' ? body.transport : '';
  if (!['sse', 'http'].includes(transport)) return 'transport must be "sse" or "http"';
  if (!body.url) return `${transport} transport requires url`;
  return null;
}

// ─── GET ─────────────────────────────────────────────────────────────────

export const GET = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_READ },
  async ({ tenantId, params }) => {
    const servers = await findMcpServerConfigsWithToolCount(tenantId, params.id);

    return mcpServerListResponse(servers);
  },
);

// ─── POST ────────────────────────────────────────────────────────────────

export const POST = withRouteHandler(
  { requireProject: true, permissions: StudioPermission.TOOL_WRITE },
  async ({ request, tenantId, user, params }) => {
    const body = await request.json();
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

    if (!name || !transport) {
      return errorJson('Missing required fields: name, transport', 400, ErrorCode.VALIDATION_ERROR);
    }
    if (String(name).length > MAX_NAME_LENGTH) {
      return errorJson(
        `name exceeds ${MAX_NAME_LENGTH} characters`,
        400,
        ErrorCode.VALIDATION_ERROR,
      );
    }

    const transportError = validateTransport(body);
    if (transportError) return errorJson(transportError, 400, ErrorCode.VALIDATION_ERROR);

    // SSRF protection — resolve template placeholders then validate
    if (serverUrl) {
      const ssrfResult = await validateUrlWithPlaceholders(String(serverUrl), tenantId, params.id);
      if (!ssrfResult.safe)
        return errorJson(
          ssrfResult.reason ?? 'URL blocked by SSRF protection',
          400,
          ErrorCode.VALIDATION_ERROR,
        );
      if (String(serverUrl).length > MAX_URL_LENGTH) {
        return errorJson(
          `url exceeds ${MAX_URL_LENGTH} characters`,
          400,
          ErrorCode.VALIDATION_ERROR,
        );
      }
    }

    // Encrypt env vars
    let encryptedEnv: string | undefined;
    if (env && typeof env === 'object' && !Array.isArray(env)) {
      const entries = Object.entries(env);
      if (entries.length > MAX_ENV_VARS) {
        return errorJson(`env exceeds ${MAX_ENV_VARS} variables`, 400, ErrorCode.VALIDATION_ERROR);
      }
      for (const [k, v] of entries) {
        if (typeof v !== 'string') {
          return errorJson(
            `env values must be strings (key: ${k})`,
            400,
            ErrorCode.VALIDATION_ERROR,
          );
        }
      }
      // Plugin encrypts encryptedEnv transparently in pre-save hook
      encryptedEnv = JSON.stringify(env);
    }

    let tagsJson: string | undefined;
    if (tags) {
      if (!Array.isArray(tags))
        return errorJson('tags must be an array', 400, ErrorCode.VALIDATION_ERROR);
      tagsJson = JSON.stringify(tags);
    }

    // Validate custom headers (plain-text, not encrypted — may contain {{session.X}} templates)
    let headersJson: string | undefined;
    if (rawHeaders !== undefined && rawHeaders !== null) {
      const headerError = validateMcpHeaders(rawHeaders);
      if (headerError) {
        return errorJson(headerError, 400, ErrorCode.VALIDATION_ERROR);
      }
      headersJson = JSON.stringify(rawHeaders);
    }

    const normalizedAuthProfileId =
      typeof authProfileId === 'string' && authProfileId.trim().length > 0
        ? authProfileId.trim()
        : null;
    const normalizedEnvProfileId =
      typeof envProfileId === 'string' && envProfileId.trim().length > 0
        ? envProfileId.trim()
        : null;

    // Validate and encrypt inline auth config only when auth profiles are not used.
    let authType: string | undefined;
    let encryptedAuthConfig: string | undefined;
    if (!normalizedAuthProfileId && rawAuthType && rawAuthType !== 'none') {
      const authError = validateMcpAuthConfig(String(rawAuthType), authConfig);
      if (authError) return errorJson(authError, 400, ErrorCode.VALIDATION_ERROR);
      authType = String(rawAuthType);
      // Plugin encrypts encryptedAuthConfig transparently in pre-save hook
      encryptedAuthConfig = JSON.stringify(authConfig);
      log.debug('MCP auth config pre-save', {
        authType,
        encryptionAvailable: isTenantEncryptionReady(),
        plainValueLength: encryptedAuthConfig.length,
      });
    }

    if (normalizedAuthProfileId) {
      const compatibility = await validateMcpAuthProfileCompatibility({
        tenantId,
        projectId: params.id,
        authProfileId: normalizedAuthProfileId,
        transport: String(transport) as 'http' | 'sse',
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

    if (normalizedEnvProfileId) {
      const compatibility = await validateMcpEnvProfileCompatibility({
        tenantId,
        projectId: params.id,
        envProfileId: normalizedEnvProfileId,
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

    const server = await createMcpServerConfig({
      tenantId,
      projectId: params.id,
      name: String(name),
      description: description ? String(description).slice(0, 500) : undefined,
      transport: String(transport) as 'http' | 'sse',
      url: serverUrl ? String(serverUrl) : undefined,
      encryptedEnv,
      authType,
      encryptedAuthConfig,
      headers: headersJson,
      authProfileId: normalizedAuthProfileId,
      envProfileId: normalizedEnvProfileId,
      priority: typeof priority === 'number' ? priority : 0,
      tags: tagsJson,
      connectionTimeoutMs: typeof connectionTimeoutMs === 'number' ? connectionTimeoutMs : 30000,
      requestTimeoutMs: typeof requestTimeoutMs === 'number' ? requestTimeoutMs : 30000,
      autoReconnect: autoReconnect !== undefined ? Boolean(autoReconnect) : true,
      maxReconnectAttempts: typeof maxReconnectAttempts === 'number' ? maxReconnectAttempts : 3,
      createdBy: formatUserLabel(user),
    });

    if (authType && authType !== 'none') {
      const storedAuthConfig = (server as Record<string, unknown>).encryptedAuthConfig as
        | string
        | null
        | undefined;
      const storedIsEncrypted =
        typeof storedAuthConfig === 'string' && isDEKEnvelopeFormat(storedAuthConfig);
      log.debug('MCP auth config post-save', {
        authType,
        storedValueLength: typeof storedAuthConfig === 'string' ? storedAuthConfig.length : 0,
        storedIsDEKEnvelope: storedIsEncrypted,
        diagnosis: !storedAuthConfig
          ? 'NULL: value was not saved'
          : !storedIsEncrypted
            ? 'NOT_ENCRYPTED: plugin did not encrypt — facade likely unavailable at save time'
            : 'OK: stored as DEK envelope',
      });
    }
    await refreshProjectAgentDraftMetadataForMcpServerMutation({
      projectId: params.id,
      tenantId,
    });

    return mcpServerResponse({ ...server, discoveredToolCount: 0 }, 201);
  },
);
