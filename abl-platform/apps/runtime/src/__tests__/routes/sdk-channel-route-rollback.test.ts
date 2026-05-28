import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import express from 'express';
import { injectTenantContext, makeTenantContext } from '../helpers/auth-context.js';

const mockRequireConcealedProjectPermission = vi.fn();
const mockEvaluateProjectPermission = vi.fn();
const mockFindPublicApiKey = vi.fn();
const mockFindPublicApiKeys = vi.fn();
const mockFindPublicApiKeysByIds = vi.fn();
const mockCreatePublicApiKey = vi.fn();
const mockDeletePublicApiKey = vi.fn();
const mockUpdatePublicApiKey = vi.fn();
const mockFindSDKChannels = vi.fn();
const mockFindSDKChannelById = vi.fn();
const mockFindSDKChannelsByTenant = vi.fn();
const mockFindSDKChannelByIdForTenant = vi.fn();
const mockFindSDKChannelsByPublicApiKeyId = vi.fn();
const mockCreateSDKChannel = vi.fn();
const mockUpdateSDKChannel = vi.fn();
const mockDeleteSDKChannel = vi.fn();
const mockFindDeploymentById = vi.fn();
const mockFindActiveDeployment = vi.fn();

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@agent-platform/shared-auth', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

vi.mock('../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireConcealedProjectPermission: (...args: unknown[]) =>
    mockRequireConcealedProjectPermission(...args),
  evaluateProjectPermission: (...args: unknown[]) => mockEvaluateProjectPermission(...args),
}));

vi.mock('../../repos/channel-repo.js', () => ({
  createPublicApiKey: (...args: unknown[]) => mockCreatePublicApiKey(...args),
  createSDKChannel: (...args: unknown[]) => mockCreateSDKChannel(...args),
  deletePublicApiKey: (...args: unknown[]) => mockDeletePublicApiKey(...args),
  deleteSDKChannel: (...args: unknown[]) => mockDeleteSDKChannel(...args),
  findPublicApiKey: (...args: unknown[]) => mockFindPublicApiKey(...args),
  findPublicApiKeys: (...args: unknown[]) => mockFindPublicApiKeys(...args),
  findPublicApiKeysByIds: (...args: unknown[]) => mockFindPublicApiKeysByIds(...args),
  findSDKChannels: (...args: unknown[]) => mockFindSDKChannels(...args),
  findSDKChannelsByPublicApiKeyId: (...args: unknown[]) =>
    mockFindSDKChannelsByPublicApiKeyId(...args),
  findSDKChannelsByTenant: (...args: unknown[]) => mockFindSDKChannelsByTenant(...args),
  findSDKChannelById: (...args: unknown[]) => mockFindSDKChannelById(...args),
  findSDKChannelByIdForTenant: (...args: unknown[]) => mockFindSDKChannelByIdForTenant(...args),
  SDKChannelProjectScopeError: class SDKChannelProjectScopeError extends Error {},
  SDKChannelPublicApiKeyScopeError: class SDKChannelPublicApiKeyScopeError extends Error {},
  updatePublicApiKey: (...args: unknown[]) => mockUpdatePublicApiKey(...args),
  updateSDKChannel: (...args: unknown[]) => mockUpdateSDKChannel(...args),
}));

vi.mock('../../repos/deployment-repo.js', () => ({
  findActiveDeployment: (...args: unknown[]) => mockFindActiveDeployment(...args),
  findDeploymentById: (...args: unknown[]) => mockFindDeploymentById(...args),
}));

const PROJECT_BASE = '/api/projects/proj-1/sdk-channels';
const TENANT_BASE = '/api/tenants/tenant-1/sdk-channels';

function buildChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'channel-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'Support Widget',
    channelType: 'web',
    deploymentId: null,
    publicApiKeyId: 'key-1',
    config: { mode: 'chat' },
    isActive: true,
    environment: null,
    followEnvironment: true,
    ...overrides,
  };
}

function buildPublicApiKey(overrides: Record<string, unknown> = {}) {
  return {
    id: 'key-1',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    keyPrefix: 'pk_testprefix',
    keyHash: 'hash',
    name: 'Default SDK Key',
    allowedOrigins: null,
    permissions: { chat: true, voice: false },
    expiresAt: null,
    isActive: true,
    ...overrides,
  };
}

async function createServer(
  mountPath: string,
  routerLoader: () => Promise<{ default: express.Router }>,
) {
  const app = express();
  app.use(express.json());
  app.use(injectTenantContext(makeTenantContext('tenant-1', 'user-1', 'OWNER')));
  const routerModule = await routerLoader();
  app.use(mountPath, routerModule.default);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${address.port}`, server });
    });
  });
}

async function request(
  baseUrl: string,
  method: string,
  path: string,
  body?: Record<string, unknown>,
) {
  const response = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await response.json().catch(() => null);
  return { status: response.status, body: json };
}

describe('SDK channel route rollback regressions', () => {
  let projectBaseUrl: string;
  let tenantBaseUrl: string;
  let projectServer: http.Server;
  let tenantServer: http.Server;

  beforeAll(async () => {
    ({ baseUrl: projectBaseUrl, server: projectServer } = await createServer(
      '/api/projects/:projectId/sdk-channels',
      () => import('../../routes/sdk-channels.js'),
    ));
    ({ baseUrl: tenantBaseUrl, server: tenantServer } = await createServer(
      '/api/tenants/:tenantId/sdk-channels',
      () => import('../../routes/tenant-sdk-channels.js'),
    ));
  });

  afterAll(async () => {
    await new Promise<void>((resolve, reject) =>
      projectServer.close((error) => (error ? reject(error) : resolve())),
    );
    await new Promise<void>((resolve, reject) =>
      tenantServer.close((error) => (error ? reject(error) : resolve())),
    );
  });

  beforeEach(() => {
    vi.clearAllMocks();
    mockRequireConcealedProjectPermission.mockResolvedValue(true);
    mockEvaluateProjectPermission.mockResolvedValue({ allowed: true });
    mockFindPublicApiKey.mockResolvedValue(buildPublicApiKey());
    mockFindPublicApiKeys.mockResolvedValue([]);
    mockFindPublicApiKeysByIds.mockResolvedValue([]);
    mockCreatePublicApiKey.mockResolvedValue(buildPublicApiKey({ id: 'key-created' }));
    mockDeletePublicApiKey.mockResolvedValue(true);
    mockUpdatePublicApiKey.mockResolvedValue({ id: 'key-1' });
    mockFindSDKChannels.mockResolvedValue([]);
    mockFindSDKChannelsByTenant.mockResolvedValue([]);
    mockFindSDKChannelsByPublicApiKeyId.mockResolvedValue([]);
    mockFindSDKChannelById.mockResolvedValue(buildChannel());
    mockFindSDKChannelByIdForTenant.mockResolvedValue(buildChannel());
    mockCreateSDKChannel.mockResolvedValue(buildChannel());
    mockUpdateSDKChannel.mockResolvedValue(buildChannel());
    mockDeleteSDKChannel.mockResolvedValue(true);
    mockFindDeploymentById.mockResolvedValue(null);
    mockFindActiveDeployment.mockResolvedValue(null);
  });

  test('project-scoped create deletes the channel when allowed-origin sync fails', async () => {
    mockCreateSDKChannel.mockResolvedValueOnce(buildChannel({ id: 'channel-created' }));
    mockUpdatePublicApiKey.mockResolvedValueOnce(null);

    const { status, body } = await request(projectBaseUrl, 'POST', PROJECT_BASE, {
      name: 'Support Widget',
      channelType: 'web',
      publicApiKeyId: 'key-1',
      allowedOrigins: ['https://widget.example.com'],
    });

    expect(status, JSON.stringify(body)).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { code: 'CREATE_FAILED', message: 'Failed to create SDK channel' },
    });
    expect(mockDeleteSDKChannel).toHaveBeenCalledWith('channel-created', 'proj-1', 'tenant-1');
    expect(mockDeletePublicApiKey).not.toHaveBeenCalled();
  });

  test('project-scoped update restores the previous channel when allowed-origin sync fails', async () => {
    const existingChannel = buildChannel();
    const updatedChannel = buildChannel({ name: 'Renamed Widget' });
    mockFindSDKChannelById.mockResolvedValueOnce(existingChannel);
    mockUpdateSDKChannel
      .mockResolvedValueOnce(updatedChannel)
      .mockResolvedValueOnce(existingChannel);
    mockUpdatePublicApiKey.mockResolvedValueOnce(null);

    const { status, body } = await request(projectBaseUrl, 'PATCH', `${PROJECT_BASE}/channel-1`, {
      name: 'Renamed Widget',
      allowedOrigins: ['https://widget.example.com'],
    });

    expect(status, JSON.stringify(body)).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update SDK channel' },
    });
    expect(mockUpdateSDKChannel).toHaveBeenNthCalledWith(
      1,
      'channel-1',
      'proj-1',
      'tenant-1',
      expect.objectContaining({ name: 'Renamed Widget' }),
    );
    expect(mockUpdateSDKChannel).toHaveBeenNthCalledWith(
      2,
      'channel-1',
      'proj-1',
      'tenant-1',
      expect.objectContaining({
        name: 'Support Widget',
        publicApiKeyId: 'key-1',
        deploymentId: null,
        config: { mode: 'chat' },
        isActive: true,
        environment: null,
        followEnvironment: true,
      }),
    );
  });

  test('tenant-scoped create deletes the channel and implicit key when allowed-origin sync fails', async () => {
    mockCreatePublicApiKey.mockResolvedValueOnce(buildPublicApiKey({ id: 'key-implicit' }));
    mockCreateSDKChannel.mockResolvedValueOnce(
      buildChannel({
        id: 'channel-created',
        publicApiKeyId: 'key-implicit',
      }),
    );
    mockUpdatePublicApiKey.mockResolvedValueOnce(null);

    const { status, body } = await request(tenantBaseUrl, 'POST', TENANT_BASE, {
      projectId: 'proj-1',
      name: 'Admin Widget',
      allowedOrigins: ['https://widget.example.com'],
    });

    expect(status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { code: 'CREATE_FAILED', message: 'Failed to create SDK channel' },
    });
    expect(mockCreateSDKChannel).toHaveBeenCalledWith(
      expect.objectContaining({ publicApiKeyId: 'key-implicit' }),
    );
    expect(mockDeleteSDKChannel).toHaveBeenCalledWith('channel-created', 'proj-1', 'tenant-1');
    expect(mockDeletePublicApiKey).toHaveBeenCalledWith('key-implicit', 'proj-1', 'tenant-1');
  });

  test('tenant-scoped update restores the channel and deletes the cloned key when sync fails', async () => {
    const existingChannel = buildChannel({ id: 'channel-tenant' });
    mockFindSDKChannelByIdForTenant.mockResolvedValueOnce(existingChannel);
    mockFindSDKChannelsByPublicApiKeyId.mockResolvedValueOnce([
      { id: 'channel-tenant' },
      { id: 'channel-sibling' },
    ]);
    mockFindPublicApiKey.mockResolvedValueOnce(
      buildPublicApiKey({ allowedOrigins: ['https://old.example.com'] }),
    );
    mockCreatePublicApiKey.mockResolvedValueOnce(buildPublicApiKey({ id: 'key-cloned' }));
    mockUpdateSDKChannel
      .mockResolvedValueOnce(buildChannel({ id: 'channel-tenant', publicApiKeyId: 'key-cloned' }))
      .mockResolvedValueOnce(existingChannel);
    mockUpdatePublicApiKey.mockResolvedValueOnce(null);

    const { status, body } = await request(tenantBaseUrl, 'PUT', `${TENANT_BASE}/channel-tenant`, {
      allowedOrigins: ['https://widget.example.com'],
    });

    expect(status).toBe(500);
    expect(body).toEqual({
      success: false,
      error: { code: 'UPDATE_FAILED', message: 'Failed to update SDK channel' },
    });
    expect(mockUpdateSDKChannel).toHaveBeenNthCalledWith(
      1,
      'channel-tenant',
      'proj-1',
      'tenant-1',
      expect.objectContaining({ publicApiKeyId: 'key-cloned' }),
    );
    expect(mockUpdateSDKChannel).toHaveBeenNthCalledWith(
      2,
      'channel-tenant',
      'proj-1',
      'tenant-1',
      expect.objectContaining({
        name: 'Support Widget',
        publicApiKeyId: 'key-1',
        deploymentId: null,
        config: { mode: 'chat' },
        isActive: true,
        environment: null,
        followEnvironment: true,
      }),
    );
    expect(mockDeletePublicApiKey).toHaveBeenCalledWith('key-cloned', 'proj-1', 'tenant-1');
  });

  test('tenant-scoped update auto-pins the active deployment when following an environment', async () => {
    const existingChannel = buildChannel({
      id: 'channel-tenant',
      deploymentId: 'deploy-retired',
      environment: null,
      followEnvironment: true,
    });
    mockFindSDKChannelByIdForTenant.mockResolvedValueOnce(existingChannel);
    mockFindActiveDeployment.mockResolvedValueOnce({ _id: 'deploy-active' });
    mockUpdateSDKChannel.mockImplementationOnce(
      async (
        _channelId: string,
        _projectId: string,
        _tenantId: string,
        updates: Record<string, unknown>,
      ) =>
        buildChannel({
          id: 'channel-tenant',
          ...updates,
        }),
    );

    const { status, body } = await request(
      tenantBaseUrl,
      'PATCH',
      `${TENANT_BASE}/channel-tenant`,
      {
        environment: 'production',
        followEnvironment: true,
      },
    );

    expect(status, JSON.stringify(body)).toBe(200);
    expect(mockFindActiveDeployment).toHaveBeenCalledWith('proj-1', 'tenant-1', 'production');
    expect(mockUpdateSDKChannel).toHaveBeenCalledWith(
      'channel-tenant',
      'proj-1',
      'tenant-1',
      expect.objectContaining({
        environment: 'production',
        followEnvironment: true,
        deploymentId: 'deploy-active',
      }),
    );
  });

  test('tenant-scoped update does not auto-pin when environment following is disabled', async () => {
    const existingChannel = buildChannel({
      id: 'channel-tenant',
      deploymentId: 'deploy-retired',
      environment: null,
      followEnvironment: true,
    });
    mockFindSDKChannelByIdForTenant.mockResolvedValueOnce(existingChannel);
    mockFindActiveDeployment.mockResolvedValueOnce({ _id: 'deploy-active' });
    mockUpdateSDKChannel.mockImplementationOnce(
      async (
        _channelId: string,
        _projectId: string,
        _tenantId: string,
        updates: Record<string, unknown>,
      ) =>
        buildChannel({
          id: 'channel-tenant',
          ...updates,
        }),
    );

    const { status, body } = await request(
      tenantBaseUrl,
      'PATCH',
      `${TENANT_BASE}/channel-tenant`,
      {
        environment: 'production',
        followEnvironment: false,
      },
    );

    expect(status, JSON.stringify(body)).toBe(200);
    expect(mockFindActiveDeployment).not.toHaveBeenCalled();
    expect(mockUpdateSDKChannel).toHaveBeenCalledWith(
      'channel-tenant',
      'proj-1',
      'tenant-1',
      expect.objectContaining({
        environment: 'production',
        followEnvironment: false,
        deploymentId: null,
      }),
    );
  });
});
