import { createLogger } from '@abl/compiler/platform/logger.js';
import { getRuntimeUrl } from '@/config/runtime.server';
import { ensureDb } from '@/lib/ensure-db';
import { checkToolPermission, isDangerousAction, type ToolPermissionContext } from '../guards';
import { invalidateProjectCaches } from './cache-invalidation';

const log = createLogger('arch-ai:variable-ops');

type VariableType = 'env' | 'config';
type EnvironmentName = 'global' | 'dev' | 'staging' | 'production';

interface VariableOpsInput {
  action: 'list' | 'list_namespaces' | 'create' | 'update' | 'delete' | 'link_namespace';
  variableType?: VariableType;
  variableId?: string;
  key?: string;
  value?: string;
  description?: string | null;
  isSecret?: boolean;
  environment?: EnvironmentName | null;
  namespaceId?: string;
  variableNamespaceIds?: string[];
  confirmed?: boolean;
}

interface VariableOpsResult {
  success?: boolean;
  data?: unknown;
  error?: { code: string; message: string };
  needsConfirmation?: boolean;
  warning?: string;
}

interface LoadedVariableRecord {
  id: string;
  key: string;
  variableNamespaceIds: string[];
}

interface NamespaceMembershipSource {
  namespaceId?: unknown;
  variableType?: unknown;
}

interface VariableNamespaceSource {
  _id?: unknown;
  name?: string;
  displayName?: string;
  description?: string | null;
  icon?: string | null;
  color?: string | null;
  order?: number;
  isDefault?: boolean;
}

function getStudioBaseUrl(): string {
  return process.env.NEXTAUTH_URL ?? 'http://localhost:5173';
}

function missing(param: string, action: VariableOpsInput['action']): VariableOpsResult {
  return {
    success: false,
    error: { code: 'MISSING_PARAM', message: `${param} is required for ${action}` },
  };
}

function buildHeaders(ctx: ToolPermissionContext): Record<string, string> | null {
  if (!ctx.authToken) {
    return null;
  }

  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${ctx.authToken}`,
  };
}

function buildApiError(
  status: number,
  body: unknown,
  fallbackMessage: string,
): { code: string; message: string } {
  const bodyRecord =
    typeof body === 'object' && body !== null ? (body as Record<string, unknown>) : {};
  const nestedError =
    typeof bodyRecord.error === 'object' && bodyRecord.error !== null
      ? (bodyRecord.error as Record<string, unknown>)
      : null;
  const message =
    (typeof nestedError?.message === 'string' && nestedError.message) ||
    (typeof bodyRecord.error === 'string' && bodyRecord.error) ||
    fallbackMessage;

  if (status === 404) {
    return { code: 'NOT_FOUND', message };
  }

  if (status === 400) {
    return { code: 'INVALID_REQUEST', message };
  }

  if (status === 409) {
    return { code: 'CONFLICT', message };
  }

  return { code: 'FETCH_ERROR', message };
}

function normalizeEnvironment(environment: EnvironmentName | null | undefined): EnvironmentName {
  return environment ?? 'global';
}

function normalizeVariableNamespaceIds(ids: string[] | undefined): string[] | undefined {
  if (!ids) {
    return undefined;
  }

  const seen = new Set<string>();
  const normalized: string[] = [];
  for (const id of ids) {
    const trimmed = id.trim();
    if (!trimmed || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

async function fetchJson(
  url: string,
  options: RequestInit,
): Promise<{
  ok: boolean;
  status: number;
  body: unknown;
}> {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(10_000),
  });

  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    body = null;
  }

  return { ok: response.ok, status: response.status, body };
}

async function loadVariableRecord(params: {
  tenantId: string;
  projectId: string;
  variableType: VariableType;
  variableId: string;
}): Promise<LoadedVariableRecord | null> {
  await ensureDb();
  const { EnvironmentVariable, ProjectConfigVariable, VariableNamespaceMembership } =
    await import('@agent-platform/database/models');

  const baseFilter = {
    _id: params.variableId,
    tenantId: params.tenantId,
    projectId: params.projectId,
  };
  const doc =
    params.variableType === 'env'
      ? await EnvironmentVariable.findOne(baseFilter, { key: 1 }).lean()
      : await ProjectConfigVariable.findOne(baseFilter, { key: 1 }).lean();

  if (!doc) {
    return null;
  }

  const memberships = (await VariableNamespaceMembership.find(
    {
      tenantId: params.tenantId,
      projectId: params.projectId,
      variableId: params.variableId,
      variableType: params.variableType,
    },
    { namespaceId: 1 },
  ).lean()) as NamespaceMembershipSource[];

  return {
    id: params.variableId,
    key: String((doc as { key?: unknown }).key ?? ''),
    variableNamespaceIds: memberships.map((membership) => String(membership.namespaceId)),
  };
}

async function listNamespaces(ctx: ToolPermissionContext): Promise<VariableOpsResult> {
  await ensureDb();
  const { VariableNamespace, VariableNamespaceMembership } =
    await import('@agent-platform/database/models');

  let namespaces = (await VariableNamespace.find({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
  })
    .sort({ order: 1 })
    .lean()) as VariableNamespaceSource[];

  if (namespaces.length === 0) {
    try {
      await VariableNamespace.create({
        tenantId: ctx.user.tenantId,
        projectId: ctx.projectId,
        name: 'default',
        displayName: 'Default',
        isDefault: true,
        order: 0,
        createdBy: 'system:auto-provision',
      });
    } catch {
      // Another request may have created the default namespace.
    }

    namespaces = (await VariableNamespace.find({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
    })
      .sort({ order: 1 })
      .lean()) as VariableNamespaceSource[];
  }

  const namespaceIds = namespaces.map((namespace) => String(namespace._id));
  const memberships =
    namespaceIds.length > 0
      ? ((await VariableNamespaceMembership.find({
          tenantId: ctx.user.tenantId,
          projectId: ctx.projectId,
          namespaceId: { $in: namespaceIds },
        }).lean()) as NamespaceMembershipSource[])
      : [];

  const memberCounts = new Map<string, { env: number; config: number }>();
  for (const membership of memberships) {
    const namespaceId = String(membership.namespaceId);
    const existing = memberCounts.get(namespaceId) ?? { env: 0, config: 0 };
    if (membership.variableType === 'env') {
      existing.env += 1;
    } else {
      existing.config += 1;
    }
    memberCounts.set(namespaceId, existing);
  }

  return {
    success: true,
    data: {
      namespaces: namespaces.map((namespace) => ({
        id: String(namespace._id),
        name: namespace.name,
        displayName: namespace.displayName,
        description: namespace.description ?? null,
        icon: namespace.icon ?? null,
        color: namespace.color ?? null,
        order: namespace.order,
        isDefault: namespace.isDefault,
        memberCounts: memberCounts.get(String(namespace._id)) ?? { env: 0, config: 0 },
      })),
    },
  };
}

async function listEnvVariables(
  input: VariableOpsInput,
  ctx: ToolPermissionContext,
): Promise<VariableOpsResult> {
  const headers = buildHeaders(ctx);
  if (!headers) {
    return {
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Auth token required for environment variables' },
    };
  }

  const query = new URLSearchParams();
  query.set('limit', '100');
  if (input.environment !== undefined) {
    query.set('environment', normalizeEnvironment(input.environment));
  }
  if (input.namespaceId) {
    query.set('namespaceId', input.namespaceId);
  }

  const url = `${getRuntimeUrl()}/api/projects/${ctx.projectId}/env-vars?${query.toString()}`;
  const response = await fetchJson(url, { method: 'GET', headers });
  if (!response.ok) {
    return {
      success: false,
      error: buildApiError(
        response.status,
        response.body,
        `Failed to list environment variables: ${response.status}`,
      ),
    };
  }

  return {
    success: true,
    data: {
      variableType: 'env',
      ...(typeof response.body === 'object' && response.body !== null
        ? (response.body as Record<string, unknown>)
        : {}),
    },
  };
}

async function listConfigVariables(
  input: VariableOpsInput,
  ctx: ToolPermissionContext,
): Promise<VariableOpsResult> {
  const headers = buildHeaders(ctx);
  if (!headers) {
    return {
      success: false,
      error: { code: 'AUTH_REQUIRED', message: 'Auth token required for config variables' },
    };
  }

  const query = new URLSearchParams();
  if (input.namespaceId) {
    query.set('namespaceId', input.namespaceId);
  }

  const suffix = query.toString() ? `?${query.toString()}` : '';
  const url = `${getStudioBaseUrl()}/api/projects/${ctx.projectId}/config-variables${suffix}`;
  const response = await fetchJson(url, { method: 'GET', headers });
  if (!response.ok) {
    return {
      success: false,
      error: buildApiError(
        response.status,
        response.body,
        `Failed to list config variables: ${response.status}`,
      ),
    };
  }

  return {
    success: true,
    data: {
      variableType: 'config',
      ...(typeof response.body === 'object' && response.body !== null
        ? (response.body as Record<string, unknown>)
        : {}),
    },
  };
}

async function createVariable(
  input: VariableOpsInput,
  ctx: ToolPermissionContext,
): Promise<VariableOpsResult> {
  if (!input.variableType) {
    return missing('variableType', 'create');
  }
  if (!input.key || input.value === undefined) {
    return missing('key and value', 'create');
  }

  const headers = buildHeaders(ctx);
  if (!headers) {
    return {
      success: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Auth token required for variable creation',
      },
    };
  }

  const variableNamespaceIds = normalizeVariableNamespaceIds(input.variableNamespaceIds);
  const payload =
    input.variableType === 'env'
      ? {
          environment: normalizeEnvironment(input.environment),
          key: input.key,
          value: input.value,
          isSecret: input.isSecret ?? false,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(variableNamespaceIds ? { variableNamespaceIds } : {}),
        }
      : {
          key: input.key,
          value: input.value,
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(variableNamespaceIds ? { variableNamespaceIds } : {}),
        };

  const url =
    input.variableType === 'env'
      ? `${getRuntimeUrl()}/api/projects/${ctx.projectId}/env-vars`
      : `${getStudioBaseUrl()}/api/projects/${ctx.projectId}/config-variables`;
  const response = await fetchJson(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    return {
      success: false,
      error: buildApiError(
        response.status,
        response.body,
        `Failed to create ${input.variableType} variable: ${response.status}`,
      ),
    };
  }

  const body =
    typeof response.body === 'object' && response.body !== null
      ? (response.body as Record<string, unknown>)
      : {};
  const createdVariable =
    typeof body.variable === 'object' && body.variable !== null
      ? (body.variable as Record<string, unknown>)
      : null;
  const createdId = typeof createdVariable?.id === 'string' ? createdVariable.id : null;

  if (!createdId) {
    return { success: true, data: body };
  }

  const loaded = await loadVariableRecord({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    variableType: input.variableType,
    variableId: createdId,
  });

  if (loaded) {
    const { syncActiveDraftFromVariable } = await import('@/lib/arch-ai/integration-draft-service');
    await syncActiveDraftFromVariable({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      userId: ctx.user.userId,
      sessionId: ctx.sessionId,
      variableType: input.variableType,
      key: loaded.key,
      variableNamespaceIds: loaded.variableNamespaceIds,
    });
  }

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  return { success: true, data: body };
}

async function updateVariable(
  input: VariableOpsInput,
  ctx: ToolPermissionContext,
): Promise<VariableOpsResult> {
  if (!input.variableType) {
    return missing('variableType', 'update');
  }
  if (!input.variableId) {
    return missing('variableId', 'update');
  }

  const headers = buildHeaders(ctx);
  if (!headers) {
    return {
      success: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Auth token required for variable updates',
      },
    };
  }

  const payload =
    input.variableType === 'env'
      ? {
          ...(input.value !== undefined ? { value: input.value } : {}),
          ...(input.isSecret !== undefined ? { isSecret: input.isSecret } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.variableNamespaceIds !== undefined
            ? {
                variableNamespaceIds:
                  normalizeVariableNamespaceIds(input.variableNamespaceIds) ?? [],
              }
            : {}),
        }
      : {
          ...(input.value !== undefined ? { value: input.value } : {}),
          ...(input.description !== undefined ? { description: input.description } : {}),
          ...(input.variableNamespaceIds !== undefined
            ? {
                variableNamespaceIds:
                  normalizeVariableNamespaceIds(input.variableNamespaceIds) ?? [],
              }
            : {}),
        };

  const url =
    input.variableType === 'env'
      ? `${getRuntimeUrl()}/api/projects/${ctx.projectId}/env-vars/${input.variableId}`
      : `${getStudioBaseUrl()}/api/projects/${ctx.projectId}/config-variables/${input.variableId}`;
  const response = await fetchJson(url, {
    method: input.variableType === 'env' ? 'PUT' : 'PATCH',
    headers,
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    return {
      success: false,
      error: buildApiError(
        response.status,
        response.body,
        `Failed to update ${input.variableType} variable: ${response.status}`,
      ),
    };
  }

  const loaded = await loadVariableRecord({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    variableType: input.variableType,
    variableId: input.variableId,
  });

  if (loaded) {
    const { syncActiveDraftFromVariable } = await import('@/lib/arch-ai/integration-draft-service');
    await syncActiveDraftFromVariable({
      tenantId: ctx.user.tenantId,
      projectId: ctx.projectId,
      userId: ctx.user.userId,
      sessionId: ctx.sessionId,
      variableType: input.variableType,
      key: loaded.key,
      variableNamespaceIds: loaded.variableNamespaceIds,
    });
  }

  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  return {
    success: true,
    data:
      typeof response.body === 'object' && response.body !== null
        ? (response.body as Record<string, unknown>)
        : response.body,
  };
}

async function deleteVariable(
  input: VariableOpsInput,
  ctx: ToolPermissionContext,
): Promise<VariableOpsResult> {
  if (!input.variableType) {
    return missing('variableType', 'delete');
  }
  if (!input.variableId) {
    return missing('variableId', 'delete');
  }

  const headers = buildHeaders(ctx);
  if (!headers) {
    return {
      success: false,
      error: {
        code: 'AUTH_REQUIRED',
        message: 'Auth token required for variable deletion',
      },
    };
  }

  const existing = await loadVariableRecord({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    variableType: input.variableType,
    variableId: input.variableId,
  });
  if (!existing) {
    return {
      success: false,
      error: { code: 'NOT_FOUND', message: `Variable "${input.variableId}" not found` },
    };
  }

  const url =
    input.variableType === 'env'
      ? `${getRuntimeUrl()}/api/projects/${ctx.projectId}/env-vars/${input.variableId}`
      : `${getStudioBaseUrl()}/api/projects/${ctx.projectId}/config-variables/${input.variableId}`;
  const response = await fetchJson(url, {
    method: 'DELETE',
    headers,
  });

  if (!response.ok) {
    return {
      success: false,
      error: buildApiError(
        response.status,
        response.body,
        `Failed to delete ${input.variableType} variable: ${response.status}`,
      ),
    };
  }

  const { removeActiveDraftVariable } = await import('@/lib/arch-ai/integration-draft-service');
  await removeActiveDraftVariable({
    tenantId: ctx.user.tenantId,
    projectId: ctx.projectId,
    userId: ctx.user.userId,
    sessionId: ctx.sessionId,
    variableType: input.variableType,
    key: existing.key,
  });
  invalidateProjectCaches(ctx.user.tenantId, ctx.projectId);
  return {
    success: true,
    data:
      typeof response.body === 'object' && response.body !== null
        ? (response.body as Record<string, unknown>)
        : response.body,
  };
}

async function linkVariableNamespaces(
  input: VariableOpsInput,
  ctx: ToolPermissionContext,
): Promise<VariableOpsResult> {
  if (!input.variableType) {
    return missing('variableType', 'link_namespace');
  }
  if (!input.variableId) {
    return missing('variableId', 'link_namespace');
  }
  if (input.variableNamespaceIds === undefined) {
    return missing('variableNamespaceIds', 'link_namespace');
  }

  return updateVariable(
    {
      action: 'update',
      variableType: input.variableType,
      variableId: input.variableId,
      variableNamespaceIds: input.variableNamespaceIds,
    },
    ctx,
  );
}

export async function executeVariableOps(
  input: VariableOpsInput,
  ctx: ToolPermissionContext,
): Promise<VariableOpsResult> {
  const perm = await checkToolPermission('variable_ops', input.action, ctx);
  if (!perm.allowed) {
    return {
      success: false,
      error: { code: 'FORBIDDEN', message: perm.error ?? 'Permission denied' },
    };
  }

  if (isDangerousAction('variable_ops', input.action) && !input.confirmed) {
    return {
      needsConfirmation: true,
      warning: `Delete ${input.variableType ?? 'this'} variable "${input.variableId ?? input.key ?? 'unknown'}"?`,
    };
  }

  try {
    switch (input.action) {
      case 'list_namespaces':
        return listNamespaces(ctx);
      case 'list':
        if (input.variableType === 'env') {
          return listEnvVariables(input, ctx);
        }
        if (input.variableType === 'config') {
          return listConfigVariables(input, ctx);
        }
        {
          const [envResult, configResult] = await Promise.all([
            listEnvVariables(input, ctx),
            listConfigVariables(input, ctx),
          ]);
          if (!envResult.success) {
            return envResult;
          }
          if (!configResult.success) {
            return configResult;
          }
          return {
            success: true,
            data: {
              env: envResult.data ?? null,
              config: configResult.data ?? null,
            },
          };
        }
      case 'create':
        return createVariable(input, ctx);
      case 'update':
        return updateVariable(input, ctx);
      case 'delete':
        return deleteVariable(input, ctx);
      case 'link_namespace':
        return linkVariableNamespaces(input, ctx);
      default:
        return {
          success: false,
          error: { code: 'INVALID_ACTION', message: `Unknown action: ${input.action}` },
        };
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    log.error('variable_ops action failed', {
      action: input.action,
      projectId: ctx.projectId,
      variableType: input.variableType,
      error: message,
    });
    return { success: false, error: { code: 'INTERNAL_ERROR', message } };
  }
}
