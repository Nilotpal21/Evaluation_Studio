import { createLogger } from '@abl/compiler/platform/logger.js';
import { checkToolPermission, isDangerousAction, type ToolPermissionContext } from '../guards';
import { consumeFlowSecrets } from './secret-store';
import { notifyRuntimeMcpServersChanged } from '@/lib/runtime-mcp-cache-invalidation';

const log = createLogger('arch-ai:mcp-server-ops');

const MCP_AUTH_TYPES = [
  'none',
  'bearer',
  'api_key',
  'custom_headers',
  'oauth2_client_credentials',
] as const;

type McpAuthType = (typeof MCP_AUTH_TYPES)[number];
type McpServerAction =
  | 'list'
  | 'read'
  | 'create'
  | 'update'
  | 'delete'
  | 'test_connection'
  | 'discover_preview'
  | 'import_tools'
  | 'list_tools'
  | 'test_tool';

interface McpServerOpsInput {
  action: McpServerAction;
  serverId?: string;
  name?: string;
  description?: string;
  transport?: 'sse' | 'http';
  url?: string;
  env?: Record<string, string>;
  authType?: McpAuthType;
  authConfig?: Record<string, unknown>;
  headers?: Record<string, string>;
  priority?: number;
  tags?: string[];
  connectionTimeoutMs?: number;
  requestTimeoutMs?: number;
  autoReconnect?: boolean;
  maxReconnectAttempts?: number;
  flowId?: string;
  toolNames?: string[];
  toolName?: string;
  testInput?: Record<string, unknown>;
  confirmed?: boolean;
}

interface McpServerOpsResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  needsSecrets?: boolean;
  flowId?: string;
  requiredSecrets?: string[];
  message?: string;
  needsConfirmation?: boolean;
  warning?: string;
}

function getStudioBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? 'http://localhost:5173';
}

function isSupportedAuthType(value: string): value is McpAuthType {
  return (MCP_AUTH_TYPES as readonly string[]).includes(value);
}

function missing(param: string, action: string): McpServerOpsResult {
  return {
    success: false,
    error: { code: 'MISSING_PARAM', message: `${param} is required for ${action}` },
  };
}

function requiredSecretFields(input: McpServerOpsInput): string[] {
  switch (input.authType) {
    case 'bearer':
      return ['token'];
    case 'api_key':
      return ['value'];
    case 'oauth2_client_credentials':
      return ['clientId', 'clientSecret'];
    case 'custom_headers': {
      const headerNames = Array.isArray(input.authConfig?.headerNames)
        ? input.authConfig.headerNames.filter((value): value is string => typeof value === 'string')
        : [];
      return headerNames.map((headerName) => `header:${headerName}`);
    }
    default:
      return [];
  }
}

function asStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const values = value.filter((item): item is string => typeof item === 'string');
  return values.length > 0 ? values : undefined;
}

async function buildAuthConfig(input: McpServerOpsInput): Promise<{
  result?: McpServerOpsResult;
  authConfig?: Record<string, unknown>;
}> {
  if (!input.authType || input.authType === 'none') {
    return {};
  }

  if (!isSupportedAuthType(input.authType)) {
    return {
      result: {
        success: false,
        error: {
          code: 'UNSUPPORTED_AUTH_TYPE',
          message: `MCP authType "${input.authType}" is not supported. Use: ${MCP_AUTH_TYPES.join(', ')}`,
        },
      },
    };
  }

  const requiredSecrets = requiredSecretFields(input);
  if (requiredSecrets.length > 0 && !input.flowId) {
    const flowId = crypto.randomUUID();
    return {
      result: {
        success: false,
        needsSecrets: true,
        flowId,
        requiredSecrets,
        message: `Use collect_secret with flowId "${flowId}" for each required MCP secret, then call mcp_server_ops again with the flowId.`,
      },
    };
  }

  let secrets: Record<string, string> = {};
  if (input.flowId) {
    const consumed = await consumeFlowSecrets(input.flowId);
    if (!consumed) {
      return {
        result: {
          success: false,
          error: {
            code: 'SECRETS_EXPIRED',
            message:
              'Secrets for this flow have expired or were already consumed. Start a new MCP auth flow.',
          },
        },
      };
    }
    secrets = consumed;
  }
  for (const field of requiredSecrets) {
    if (!secrets[field]) {
      return {
        result: {
          success: false,
          error: {
            code: 'MISSING_SECRET',
            message: `Missing collected MCP secret field "${field}".`,
          },
        },
      };
    }
  }

  const config = input.authConfig ?? {};
  switch (input.authType) {
    case 'bearer':
      return { authConfig: { token: secrets?.token } };
    case 'api_key':
      return {
        authConfig: {
          headerName:
            typeof config.headerName === 'string' && config.headerName.trim()
              ? config.headerName
              : 'X-API-Key',
          value: secrets?.value,
        },
      };
    case 'oauth2_client_credentials':
      return {
        authConfig: {
          ...config,
          clientId: secrets?.clientId,
          clientSecret: secrets?.clientSecret,
          ...(asStringArray(config.scopes) ? { scopes: asStringArray(config.scopes) } : {}),
        },
      };
    case 'custom_headers': {
      const headerNames = asStringArray(config.headerNames) ?? [];
      if (headerNames.length === 0 && !input.flowId) {
        const providedHeaders = config.headers;
        if (
          providedHeaders &&
          typeof providedHeaders === 'object' &&
          !Array.isArray(providedHeaders)
        ) {
          return { authConfig: { headers: providedHeaders } };
        }
      }
      const headers = Object.fromEntries(
        headerNames.map((headerName) => [headerName, secrets?.[`header:${headerName}`] ?? '']),
      );
      return { authConfig: { headers } };
    }
    default:
      return {};
  }
}

function buildServerPayload(
  input: McpServerOpsInput,
  authConfig?: Record<string, unknown>,
): Record<string, unknown> {
  const payload: Record<string, unknown> = {};
  for (const key of [
    'name',
    'description',
    'transport',
    'url',
    'env',
    'headers',
    'priority',
    'tags',
    'connectionTimeoutMs',
    'requestTimeoutMs',
    'autoReconnect',
    'maxReconnectAttempts',
  ] as const) {
    if (input[key] !== undefined) {
      payload[key] = input[key];
    }
  }
  if (input.authType !== undefined) {
    payload.authType = input.authType;
    if (input.authType !== 'none') {
      payload.authConfig = authConfig;
    }
  }
  return payload;
}

async function apiFetch(
  path: string,
  ctx: ToolPermissionContext,
  options?: RequestInit,
): Promise<Response> {
  const url = `${getStudioBaseUrl()}/api/projects/${ctx.projectId}${path}`;
  return fetch(url, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${ctx.authToken}`,
      'X-Tenant-Id': ctx.user.tenantId,
      'X-Project-Id': ctx.projectId,
      'X-User-Id': ctx.user.userId,
      ...(options?.headers ?? {}),
    },
    signal: AbortSignal.timeout(30_000),
  });
}

async function parseApiResult(res: Response, fallbackCode: string): Promise<McpServerOpsResult> {
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const error = (body as { error?: { code?: string; message?: string } }).error;
    return {
      success: false,
      error: {
        code: error?.code ?? fallbackCode,
        message: error?.message ?? `MCP server API failed: ${res.status}`,
      },
    };
  }
  return { success: true, data: body };
}

async function createServer(
  input: McpServerOpsInput,
  ctx: ToolPermissionContext,
): Promise<McpServerOpsResult> {
  if (!input.name) return missing('name', input.action);
  if (!input.transport) return missing('transport', input.action);

  const auth = await buildAuthConfig(input);
  if (auth.result) return auth.result;

  const res = await apiFetch('/mcp-servers', ctx, {
    method: 'POST',
    body: JSON.stringify(buildServerPayload(input, auth.authConfig)),
  });
  const result = await parseApiResult(res, 'CREATE_FAILED');
  if (result.success) {
    await notifyRuntimeMcpServersChanged(ctx.user.tenantId, ctx.projectId);
  }
  return result;
}

async function updateServer(
  input: McpServerOpsInput,
  ctx: ToolPermissionContext,
): Promise<McpServerOpsResult> {
  if (!input.serverId) return missing('serverId', input.action);

  const auth = await buildAuthConfig(input);
  if (auth.result) return auth.result;

  const res = await apiFetch(`/mcp-servers/${encodeURIComponent(input.serverId)}`, ctx, {
    method: 'PUT',
    body: JSON.stringify(buildServerPayload(input, auth.authConfig)),
  });
  const result = await parseApiResult(res, 'UPDATE_FAILED');
  if (result.success) {
    await notifyRuntimeMcpServersChanged(ctx.user.tenantId, ctx.projectId);
  }
  return result;
}

export async function executeMcpServerOps(
  input: McpServerOpsInput,
  ctx: ToolPermissionContext,
): Promise<McpServerOpsResult> {
  const action = input.action;
  const perm = await checkToolPermission('mcp_server_ops', action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  if (!ctx.authToken) {
    return {
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Auth token required for MCP server operations' },
    };
  }

  if (isDangerousAction('mcp_server_ops', action) && !input.confirmed) {
    return {
      needsConfirmation: true,
      warning: `Delete MCP server "${input.serverId}"? Imported MCP tools from this server will also be deleted.`,
    };
  }

  try {
    switch (action) {
      case 'list':
        return parseApiResult(await apiFetch('/mcp-servers', ctx), 'LIST_FAILED');
      case 'read':
        if (!input.serverId) return missing('serverId', action);
        return parseApiResult(
          await apiFetch(`/mcp-servers/${encodeURIComponent(input.serverId)}`, ctx),
          'READ_FAILED',
        );
      case 'create':
        return createServer(input, ctx);
      case 'update':
        return updateServer(input, ctx);
      case 'delete': {
        if (!input.serverId) return missing('serverId', action);
        const deleteResult = await parseApiResult(
          await apiFetch(`/mcp-servers/${encodeURIComponent(input.serverId)}`, ctx, {
            method: 'DELETE',
          }),
          'DELETE_FAILED',
        );
        if (deleteResult.success) {
          await notifyRuntimeMcpServersChanged(ctx.user.tenantId, ctx.projectId);
        }
        return deleteResult;
      }
      case 'test_connection':
        if (!input.serverId) return missing('serverId', action);
        return parseApiResult(
          await apiFetch(
            `/mcp-servers/${encodeURIComponent(input.serverId)}/test-connection`,
            ctx,
            { method: 'POST', body: '{}' },
          ),
          'TEST_CONNECTION_FAILED',
        );
      case 'discover_preview':
        if (!input.serverId) return missing('serverId', action);
        return parseApiResult(
          await apiFetch(
            `/mcp-servers/${encodeURIComponent(input.serverId)}/tools/discover/preview`,
            ctx,
            { method: 'POST', body: '{}' },
          ),
          'DISCOVER_PREVIEW_FAILED',
        );
      case 'import_tools':
        if (!input.serverId) return missing('serverId', action);
        return parseApiResult(
          await apiFetch(`/mcp-servers/${encodeURIComponent(input.serverId)}/tools/discover`, ctx, {
            method: 'POST',
            body: JSON.stringify(input.toolNames ? { toolNames: input.toolNames } : {}),
          }),
          'IMPORT_TOOLS_FAILED',
        );
      case 'list_tools':
        if (!input.serverId) return missing('serverId', action);
        return parseApiResult(
          await apiFetch(`/mcp-servers/${encodeURIComponent(input.serverId)}/tools`, ctx),
          'LIST_TOOLS_FAILED',
        );
      case 'test_tool':
        if (!input.serverId) return missing('serverId', action);
        if (!input.toolName) return missing('toolName', action);
        return parseApiResult(
          await apiFetch(
            `/mcp-servers/${encodeURIComponent(input.serverId)}/tools/${encodeURIComponent(input.toolName)}/test`,
            ctx,
            { method: 'POST', body: JSON.stringify({ input: input.testInput ?? {} }) },
          ),
          'TEST_TOOL_FAILED',
        );
      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${action}` },
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('mcp_server_ops action failed', { action, projectId: ctx.projectId, error: message });
    return { success: false, error: { code: 'INTERNAL_ERROR', message } };
  }
}
