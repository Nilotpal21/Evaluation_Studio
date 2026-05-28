import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ToolPermissionContext } from '@/lib/arch-ai/guards';

const {
  ensureDbMock,
  invalidateProjectCachesMock,
  syncActiveDraftFromVariableMock,
  removeActiveDraftVariableMock,
  fetchMock,
} = vi.hoisted(() => ({
  ensureDbMock: vi.fn().mockResolvedValue(undefined),
  invalidateProjectCachesMock: vi.fn(),
  syncActiveDraftFromVariableMock: vi.fn().mockResolvedValue(null),
  removeActiveDraftVariableMock: vi.fn().mockResolvedValue(null),
  fetchMock: vi.fn(),
}));

const envRecords = new Map<string, { key: string }>();
const configRecords = new Map<string, { key: string }>();
const membershipRecords = new Map<string, string[]>();

function makeLeanQuery<T>(value: T) {
  return {
    lean: vi.fn().mockResolvedValue(value),
  };
}

vi.mock('@/config/runtime.server', () => ({
  getRuntimeUrl: () => 'http://runtime.test',
}));

vi.mock('@/lib/ensure-db', () => ({
  ensureDb: ensureDbMock,
}));

vi.mock('@/lib/arch-ai/tools/cache-invalidation', () => ({
  invalidateProjectCaches: invalidateProjectCachesMock,
}));

vi.mock('@/lib/arch-ai/integration-draft-service', () => ({
  syncActiveDraftFromVariable: syncActiveDraftFromVariableMock,
  removeActiveDraftVariable: removeActiveDraftVariableMock,
}));

vi.mock('@agent-platform/database/models', () => ({
  EnvironmentVariable: {
    findOne: (filter: Record<string, unknown>) =>
      makeLeanQuery(
        typeof filter._id === 'string' && envRecords.has(filter._id)
          ? { _id: filter._id, key: envRecords.get(filter._id)?.key }
          : null,
      ),
  },
  ProjectConfigVariable: {
    findOne: (filter: Record<string, unknown>) =>
      makeLeanQuery(
        typeof filter._id === 'string' && configRecords.has(filter._id)
          ? { _id: filter._id, key: configRecords.get(filter._id)?.key }
          : null,
      ),
  },
  VariableNamespaceMembership: {
    find: (filter: Record<string, unknown>) =>
      makeLeanQuery(
        typeof filter.variableId === 'string'
          ? (membershipRecords.get(filter.variableId) ?? []).map((namespaceId) => ({
              namespaceId,
            }))
          : [],
      ),
  },
  VariableNamespace: {
    find: () => ({
      sort: () => makeLeanQuery([]),
    }),
    create: vi.fn(),
  },
}));

const TOOL_CONTEXT: ToolPermissionContext = {
  projectId: 'proj-1',
  sessionId: 'sess-1',
  authToken: 'token-1',
  user: {
    tenantId: 'tenant-1',
    userId: 'user-1',
    permissions: ['project:read', 'project:update'],
  },
};

function createJsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

describe('variable_ops', () => {
  beforeEach(() => {
    envRecords.clear();
    configRecords.clear();
    membershipRecords.clear();
    ensureDbMock.mockClear();
    invalidateProjectCachesMock.mockClear();
    syncActiveDraftFromVariableMock.mockClear();
    removeActiveDraftVariableMock.mockClear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('creates env vars through the runtime API and syncs the active draft', async () => {
    envRecords.set('env-1', { key: 'CRM_BASE_URL' });
    membershipRecords.set('env-1', ['ns-default']);
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        success: true,
        variable: { id: 'env-1', key: 'CRM_BASE_URL', environment: null },
      }),
    );

    const { executeVariableOps } = await import('@/lib/arch-ai/tools/variable-ops');
    const result = await executeVariableOps(
      {
        action: 'create',
        variableType: 'env',
        key: 'CRM_BASE_URL',
        value: 'https://crm.example.com',
        environment: 'global',
      },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://runtime.test/api/projects/proj-1/env-vars',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
        }),
        body: expect.any(String),
      }),
    );
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      environment: 'global',
      key: 'CRM_BASE_URL',
      value: 'https://crm.example.com',
      isSecret: false,
    });
    expect(syncActiveDraftFromVariableMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      variableType: 'env',
      key: 'CRM_BASE_URL',
      variableNamespaceIds: ['ns-default'],
    });
    expect(invalidateProjectCachesMock).toHaveBeenCalledWith('tenant-1', 'proj-1');
  });

  it('creates config vars through the Studio API and syncs explicit namespaces', async () => {
    configRecords.set('cfg-1', { key: 'CRM_AUTH_PROFILE' });
    membershipRecords.set('cfg-1', ['ns-crm']);
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        success: true,
        variable: { id: 'cfg-1', key: 'CRM_AUTH_PROFILE' },
      }),
    );

    const { executeVariableOps } = await import('@/lib/arch-ai/tools/variable-ops');
    const result = await executeVariableOps(
      {
        action: 'create',
        variableType: 'config',
        key: 'CRM_AUTH_PROFILE',
        value: 'crm-shared-auth',
        variableNamespaceIds: ['ns-crm'],
      },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5173/api/projects/proj-1/config-variables',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          Authorization: 'Bearer token-1',
        }),
      }),
    );
    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body));
    expect(requestBody).toMatchObject({
      key: 'CRM_AUTH_PROFILE',
      value: 'crm-shared-auth',
      variableNamespaceIds: ['ns-crm'],
    });
    expect(syncActiveDraftFromVariableMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      variableType: 'config',
      key: 'CRM_AUTH_PROFILE',
      variableNamespaceIds: ['ns-crm'],
    });
  });

  it('updates namespace memberships through link_namespace', async () => {
    configRecords.set('cfg-2', { key: 'CRM_REGION' });
    membershipRecords.set('cfg-2', ['ns-shared', 'ns-crm']);
    fetchMock.mockResolvedValueOnce(
      createJsonResponse({
        success: true,
        variable: { id: 'cfg-2', key: 'CRM_REGION' },
      }),
    );

    const { executeVariableOps } = await import('@/lib/arch-ai/tools/variable-ops');
    const result = await executeVariableOps(
      {
        action: 'link_namespace',
        variableType: 'config',
        variableId: 'cfg-2',
        variableNamespaceIds: ['ns-shared', 'ns-crm'],
      },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5173/api/projects/proj-1/config-variables/cfg-2',
      expect.objectContaining({
        method: 'PATCH',
        body: JSON.stringify({ variableNamespaceIds: ['ns-shared', 'ns-crm'] }),
      }),
    );
    expect(syncActiveDraftFromVariableMock).toHaveBeenCalledWith(
      expect.objectContaining({
        variableType: 'config',
        key: 'CRM_REGION',
        variableNamespaceIds: ['ns-shared', 'ns-crm'],
      }),
    );
  });

  it('requires confirmation before deleting a variable', async () => {
    const { executeVariableOps } = await import('@/lib/arch-ai/tools/variable-ops');
    const result = await executeVariableOps(
      {
        action: 'delete',
        variableType: 'env',
        variableId: 'env-9',
      },
      TOOL_CONTEXT,
    );

    expect(result.needsConfirmation).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('deletes variables and removes them from the active draft once confirmed', async () => {
    envRecords.set('env-9', { key: 'CRM_TIMEOUT' });
    membershipRecords.set('env-9', ['ns-default']);
    fetchMock.mockResolvedValueOnce(createJsonResponse({ success: true, deleted: 'env-9' }));

    const { executeVariableOps } = await import('@/lib/arch-ai/tools/variable-ops');
    const result = await executeVariableOps(
      {
        action: 'delete',
        variableType: 'env',
        variableId: 'env-9',
        confirmed: true,
      },
      TOOL_CONTEXT,
    );

    expect(result.success).toBe(true);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://runtime.test/api/projects/proj-1/env-vars/env-9',
      expect.objectContaining({ method: 'DELETE' }),
    );
    expect(removeActiveDraftVariableMock).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      userId: 'user-1',
      sessionId: 'sess-1',
      variableType: 'env',
      key: 'CRM_TIMEOUT',
    });
  });
});
