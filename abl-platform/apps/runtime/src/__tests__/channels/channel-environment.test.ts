/**
 * Channel Environment Tests
 *
 * Tests environment-scoped channel behavior:
 * - SDK init: channel with environment + null deploymentId → env-specific active
 * - SDK init: channel with pinned deploymentId → uses pinned (ignores environment)
 * - SDK init: channel with no environment → uses working copy
 * - Channel CRUD with environment and followEnvironment fields
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS
// =============================================================================

const mockFindDeploymentBySlug = vi.fn();
const mockFindActiveDeployment = vi.fn();
const mockFindDeploymentById = vi.fn();

vi.mock('../../repos/deployment-repo.js', () => ({
  findDeploymentBySlug: (...args: any[]) => mockFindDeploymentBySlug(...args),
  findActiveDeployment: (...args: any[]) => mockFindActiveDeployment(...args),
  findDeploymentById: (...args: any[]) => mockFindDeploymentById(...args),
}));

const mockFindSDKChannelByName = vi.fn();
const mockCreateSDKChannel = vi.fn();
const mockFindSDKChannelById = vi.fn();
const mockFindPublicApiKey = vi.fn();
const mockFindSDKChannelsByPublicApiKeyId = vi.fn();
const mockUpdateSDKChannel = vi.fn();

vi.mock('../../repos/channel-repo.js', () => ({
  createPublicApiKey: vi.fn(),
  findSDKChannelByName: (...args: any[]) => mockFindSDKChannelByName(...args),
  createSDKChannel: (...args: any[]) => mockCreateSDKChannel(...args),
  deletePublicApiKey: vi.fn(),
  deleteSDKChannel: vi.fn(),
  findSDKChannelById: (...args: any[]) => mockFindSDKChannelById(...args),
  findPublicApiKey: (...args: any[]) => mockFindPublicApiKey(...args),
  findPublicApiKeys: vi.fn(),
  findPublicApiKeysByIds: vi.fn(),
  findSDKChannelsByPublicApiKeyId: (...args: any[]) => mockFindSDKChannelsByPublicApiKeyId(...args),
  findPublicApiKeyForSdk: vi.fn(),
  SDKChannelProjectScopeError: class SDKChannelProjectScopeError extends Error {},
  SDKChannelPublicApiKeyScopeError: class SDKChannelPublicApiKeyScopeError extends Error {},
  updatePublicApiKey: vi.fn(),
  updatePublicApiKeyLastUsed: vi.fn(),
  updateSDKChannel: (...args: any[]) => mockUpdateSDKChannel(...args),
  bulkUpdateChannelDeployment: vi.fn(),
}));

const mockSign = vi.fn().mockReturnValue('mock-jwt-token');
const mockVerify = vi.fn();
const mockCheckTenantOperationRateLimit = vi.fn();
const mockApplyRateLimitHeaders = vi.fn();
vi.mock('jsonwebtoken', () => ({
  default: {
    sign: (...args: any[]) => mockSign(...args),
    verify: (...args: any[]) => mockVerify(...args),
    TokenExpiredError: class TokenExpiredError extends Error {},
  },
}));

vi.mock('../../config/index.js', () => ({
  getConfig: () => ({
    env: 'test',
    jwt: { secret: 'test-secret' },
  }),
}));

const mockResolveSdkInitFromPublicKey = vi.fn();

vi.mock('../../middleware/sdk-auth.js', () => ({
  resolveSdkInitFromPublicKey: (...args: any[]) => mockResolveSdkInitFromPublicKey(...args),
  // Mirror the real expansion used by reauthorizePublicKeySession: a
  // `chat: true` public key resolves into the session/attachment permissions
  // that the SDK session payload is checked against.
  resolveSdkPublicApiKeyPermissions: (rawPermissions: unknown): string[] => {
    const permissions: Record<string, boolean> =
      typeof rawPermissions === 'string'
        ? JSON.parse(rawPermissions)
        : ((rawPermissions ?? {}) as Record<string, boolean>);
    const out = new Set<string>();
    if (permissions.chat) {
      out.add('session:send_message');
      out.add('session:read');
      out.add('attachment:read');
      out.add('attachment:write');
      out.add('attachment:delete');
    }
    if (permissions.voice) {
      out.add('session:voice');
      out.add('session:read');
    }
    return [...out];
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  mockResolveSdkInitFromPublicKey.mockResolvedValue({
    success: true,
    data: {
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      keyId: 'key-1',
      permissions: ['session:send_message'],
    },
  });
  mockCheckTenantOperationRateLimit.mockResolvedValue({
    allowed: true,
    limit: 20,
    resetMs: 1000,
  });
  mockFindDeploymentById.mockResolvedValue({
    id: 'deploy-pinned',
    projectId: 'proj-1',
    tenantId: 'tenant-1',
    environment: 'staging',
    status: 'active',
  });
  mockUpdateSDKChannel.mockResolvedValue(makeChannel({ deploymentId: 'deploy-pinned' }));
});

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
  SDK_TOKEN_ISSUER: 'agent-platform',
  SDK_TOKEN_AUDIENCE: 'sdk-client',
}));

vi.mock('../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  checkTenantOperationRateLimit: (...args: any[]) => mockCheckTenantOperationRateLimit(...args),
  applyRateLimitHeaders: (...args: any[]) => mockApplyRateLimitHeaders(...args),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// =============================================================================
// APP SETUP
// =============================================================================

import express from 'express';

let baseUrl: string;
let server: http.Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());

  const sdkInitRouter = (await import('../../routes/sdk-init.js')).default;
  app.use('/api/v1/sdk', sdkInitRouter);

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

// =============================================================================
// HELPERS
// =============================================================================

async function sdkInit(body: Record<string, unknown> = {}) {
  const res = await fetch(`${baseUrl}/api/v1/sdk/init`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Public-Key': 'pk_test_123',
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function sdkRefresh(token = 'mock-sdk-token') {
  const res = await fetch(`${baseUrl}/api/v1/sdk/refresh`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-SDK-Token': token,
    },
    body: JSON.stringify({}),
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

function makeChannel(overrides: Record<string, unknown> = {}) {
  return {
    id: 'chan-1',
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    name: 'default',
    channelType: 'web',
    deploymentId: null,
    publicApiKeyId: 'key-1',
    config: {},
    isActive: true,
    environment: null,
    followEnvironment: true,
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('Channel Environment — SDK Init', () => {
  test('channel with environment + null deploymentId → env-specific active deployment', async () => {
    // Channel exists with environment=staging but no pinned deployment
    const channel = makeChannel({ environment: 'staging', deploymentId: null });
    mockFindSDKChannelByName.mockResolvedValue(channel);
    mockFindActiveDeployment.mockResolvedValue({
      id: 'deploy-staging',
      projectId: 'proj-1',
      status: 'active',
    });

    const { status, body } = await sdkInit({ channelName: 'default' });

    expect(status).toBe(200);
    expect(body.deploymentId).toBe('deploy-staging');
    // Should call findActiveDeployment with the channel's environment
    expect(mockFindActiveDeployment).toHaveBeenCalledWith('proj-1', 'tenant-1', 'staging');
  });

  test('channel with pinned deploymentId → uses pinned deployment (ignores environment)', async () => {
    // Channel has a specific deployment pinned
    const channel = makeChannel({ environment: 'staging', deploymentId: 'deploy-pinned' });
    mockFindSDKChannelByName.mockResolvedValue(channel);
    mockFindDeploymentById.mockResolvedValue({
      id: 'deploy-pinned',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      environment: 'staging',
      status: 'active',
    });

    const { status, body } = await sdkInit({ channelName: 'default' });

    expect(status).toBe(200);
    expect(body.deploymentId).toBe('deploy-pinned');
    expect(mockFindDeploymentById).toHaveBeenCalledWith('deploy-pinned', 'proj-1', 'tenant-1');
    // Should NOT call findActiveDeployment since we have a pinned deployment
    expect(mockFindActiveDeployment).not.toHaveBeenCalled();
    expect(mockUpdateSDKChannel).not.toHaveBeenCalled();
  });

  test('retired environment-following pinned deployment falls back to the active deployment', async () => {
    const channel = makeChannel({
      environment: 'production',
      deploymentId: 'deploy-retired',
      followEnvironment: true,
    });
    mockFindSDKChannelByName.mockResolvedValue(channel);
    mockFindDeploymentById.mockResolvedValue({
      id: 'deploy-retired',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      environment: 'production',
      status: 'retired',
    });
    mockFindActiveDeployment.mockResolvedValue({
      id: 'deploy-active',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      environment: 'production',
      status: 'active',
    });
    mockUpdateSDKChannel.mockResolvedValue(
      makeChannel({
        environment: 'production',
        deploymentId: 'deploy-active',
        followEnvironment: true,
      }),
    );

    const { status, body } = await sdkInit({ channelName: 'default' });

    expect(status).toBe(200);
    expect(body.deploymentId).toBe('deploy-active');
    expect(mockFindActiveDeployment).toHaveBeenCalledWith('proj-1', 'tenant-1', 'production');
    expect(mockUpdateSDKChannel).toHaveBeenCalledWith('chan-1', 'proj-1', 'tenant-1', {
      deploymentId: 'deploy-active',
    });
  });

  test('retired environment-following pinned deployment returns 410 when no active replacement exists', async () => {
    const channel = makeChannel({
      environment: 'production',
      deploymentId: 'deploy-retired',
      followEnvironment: true,
    });
    mockFindSDKChannelByName.mockResolvedValue(channel);
    mockFindDeploymentById.mockResolvedValue({
      id: 'deploy-retired',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      environment: 'production',
      status: 'retired',
    });
    mockFindActiveDeployment.mockResolvedValue(null);

    const { status, body } = await sdkInit({ channelName: 'default' });

    expect(status).toBe(410);
    expect(body.error).toBe('Deployment is retired');
    expect(mockUpdateSDKChannel).not.toHaveBeenCalled();
  });

  test('retired explicit pinned deployment returns 410 without environment fallback', async () => {
    const channel = makeChannel({
      environment: 'production',
      deploymentId: 'deploy-retired',
      followEnvironment: false,
    });
    mockFindSDKChannelByName.mockResolvedValue(channel);
    mockFindDeploymentById.mockResolvedValue({
      id: 'deploy-retired',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      environment: 'production',
      status: 'retired',
    });
    mockFindActiveDeployment.mockResolvedValue({
      id: 'deploy-active',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      environment: 'production',
      status: 'active',
    });

    const { status, body } = await sdkInit({ channelName: 'default' });

    expect(status).toBe(410);
    expect(body.error).toBe('Deployment is retired');
    expect(mockFindActiveDeployment).not.toHaveBeenCalled();
    expect(mockUpdateSDKChannel).not.toHaveBeenCalled();
  });

  test('channel with no environment → uses working copy draft', async () => {
    // Channel exists with no environment set
    const channel = makeChannel({ environment: null, deploymentId: null });
    mockFindSDKChannelByName.mockResolvedValue(channel);

    const { status, body } = await sdkInit({ channelName: 'default' });

    expect(status).toBe(200);
    expect(body.deploymentId).toBeUndefined();
    expect(mockFindActiveDeployment).not.toHaveBeenCalled();
  });

  test('requested bootstrap channel must already exist and be bound to the public key', async () => {
    mockFindSDKChannelByName.mockResolvedValue(null);

    const { status, body } = await sdkInit({ channelName: 'new-channel' });

    expect(status).toBe(404);
    expect(body.error).toBe('SDK channel not found');
    expect(mockCreateSDKChannel).not.toHaveBeenCalled();
  });

  test('deploymentSlug takes priority over channel environment', async () => {
    const channel = makeChannel({ environment: 'staging', deploymentId: null });
    mockFindSDKChannelByName.mockResolvedValue(channel);
    mockFindDeploymentBySlug.mockResolvedValue({
      id: 'deploy-slug',
      projectId: 'proj-1',
      status: 'active',
    });

    const { status, body } = await sdkInit({
      channelName: 'default',
      deploymentSlug: 'proj-1-dev-abc123',
    });

    expect(status).toBe(200);
    expect(body.deploymentId).toBe('deploy-slug');
    // Should NOT call findActiveDeployment when slug is provided
    expect(mockFindActiveDeployment).not.toHaveBeenCalled();
  });

  test('handles no active deployment gracefully', async () => {
    const channel = makeChannel({ environment: 'staging', deploymentId: null });
    mockFindSDKChannelByName.mockResolvedValue(channel);
    mockFindActiveDeployment.mockResolvedValue(null);

    const { status, body } = await sdkInit({ channelName: 'default' });

    expect(status).toBe(200);
    expect(body.deploymentId).toBeUndefined();
  });

  test('refresh re-resolves the current channel binding instead of keeping stale deployment ids', async () => {
    mockVerify.mockReturnValue({
      type: 'sdk_session',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      channelId: 'chan-1',
      deploymentId: 'deploy-dev',
      environment: 'dev',
      sessionId: 'session-1',
      sessionPrincipal: 'session-1',
      permissions: ['session:send_message'],
      bootstrapType: 'public_key',
      bootstrapKeyId: 'key-1',
      authScope: 'session',
      identityTier: 0,
      verificationMethod: 'none',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    mockFindSDKChannelById.mockResolvedValue(
      makeChannel({ deploymentId: null, environment: null }),
    );
    mockFindPublicApiKey.mockResolvedValue({
      id: 'key-1',
      projectId: 'proj-1',
      tenantId: 'tenant-1',
      isActive: true,
      // Public key chat permissions must resolve into a superset of the
      // payload permissions (['session:send_message']) for
      // reauthorizePublicKeySession to accept the refresh.
      permissions: { chat: true },
    });

    const { status, body } = await sdkRefresh();

    expect(status).toBe(200);
    expect(body.deploymentId).toBeUndefined();
    expect(mockFindActiveDeployment).not.toHaveBeenCalled();
    expect(mockSign).toHaveBeenCalledWith(
      expect.not.objectContaining({
        deploymentId: 'deploy-dev',
        environment: 'dev',
      }),
      expect.any(String),
      expect.any(Object),
    );
  });
});
