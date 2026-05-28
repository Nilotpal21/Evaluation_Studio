import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import type { Server } from 'http';

const {
  mockAcquireLock,
  mockAuthProfileCountDocuments,
  mockAuthProfileFindOne,
  mockAuthProfileFindOneAndUpdate,
  mockConsumerCountDocuments,
  mockInvalidateAuthProfileCache,
  mockLoggerError,
  mockReleaseLock,
  mockRequirePermissionInline,
  mockSDKChannelCountDocuments,
} = vi.hoisted(() => ({
  mockAcquireLock: vi.fn(),
  mockAuthProfileCountDocuments: vi.fn(),
  mockAuthProfileFindOne: vi.fn(),
  mockAuthProfileFindOneAndUpdate: vi.fn(),
  mockConsumerCountDocuments: vi.fn(),
  mockInvalidateAuthProfileCache: vi.fn(),
  mockLoggerError: vi.fn(),
  mockReleaseLock: vi.fn(),
  mockRequirePermissionInline: vi.fn(),
  mockSDKChannelCountDocuments: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: mockLoggerError,
  }),
}));

vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();

  return {
    ...actual,
    DistributedLockManager: class DistributedLockManager {
      async acquire(resourceId: string, options: { keyPrefix: string }) {
        return mockAcquireLock(resourceId, options);
      }

      async release(lock: { key: string; value: string }) {
        return mockReleaseLock(lock);
      }
    },
  };
});

vi.mock('../../services/redis/redis-client.js', () => ({
  isRedisAvailable: () => true,
  getRedisClient: () => ({}),
  getRedisHandle: () => ({
    client: {},
    isReady: () => true,
    duplicate: () => ({}).duplicate ? {}.duplicate() : {},
    disconnect: async () => {},
  }),
}));

vi.mock('../../services/auth-profile-resolver.js', () => ({
  getAuthProfileCache: () => ({
    invalidate: mockInvalidateAuthProfileCache,
  }),
  getAuthProfileCache: vi.fn(),
  resolveAuthProfileCredentials: vi.fn(),
}));

vi.mock('../../middleware/rbac.js', async () => {
  const actual = await vi.importActual<typeof import('../../middleware/rbac.js')>(
    '../../middleware/rbac.js',
  );
  return {
    ...actual,
    requirePermissionInline: (...args: unknown[]) => mockRequirePermissionInline(...args),
  };
});

vi.mock('@agent-platform/database/models', () => {
  const consumerModel = {
    countDocuments: (...args: unknown[]) => mockConsumerCountDocuments(...args),
  };

  return {
    AuthProfile: {
      findOne: (...args: unknown[]) => mockAuthProfileFindOne(...args),
      findOneAndUpdate: (...args: unknown[]) => mockAuthProfileFindOneAndUpdate(...args),
      countDocuments: (...args: unknown[]) => mockAuthProfileCountDocuments(...args),
    },
    ChannelConnection: consumerModel,
    TenantModel: consumerModel,
    ConnectorConfig: consumerModel,
    ConnectorConnection: consumerModel,
    EndUserOAuthToken: consumerModel,
    MCPServerConfig: consumerModel,
    ServiceNode: consumerModel,
    TenantGuardrailProviderConfig: consumerModel,
    GuardrailPolicy: consumerModel,
    GitIntegration: consumerModel,
    SDKChannel: {
      countDocuments: (...args: unknown[]) => mockSDKChannelCountDocuments(...args),
    },
    WebhookSubscription: consumerModel,
    WebhookSubscriptionConnector: consumerModel,
    ModelConfig: consumerModel,
    TenantServiceInstance: consumerModel,
    OrgProxyConfig: consumerModel,
    ArchWorkspaceConfig: consumerModel,
    TriggerRegistration: consumerModel,
  };
});

import { authProfileRoutes } from '../../routes/auth-profiles.js';
import { injectTenantContext, makeTenantContext } from '../helpers/auth-context.js';

const TEST_TENANT = 'tenant-auth-profile-delete-sdk-channel-compat';
const TEST_USER = 'user-auth-profile-delete-sdk-channel-compat';
const TEST_PROFILE_ID = 'profile-delete-sdk-channel-compat';

let app: express.Express;
let server: Server;

beforeAll(() => {
  app = express();
  app.use(express.json());
  app.use(injectTenantContext(makeTenantContext(TEST_TENANT, TEST_USER, 'ADMIN')));
  app.use('/api/auth-profiles', authProfileRoutes);
  server = app.listen(0);
});

beforeEach(() => {
  const activeProfile = {
    _id: TEST_PROFILE_ID,
    tenantId: TEST_TENANT,
    projectId: null,
    scope: 'tenant',
    visibility: 'shared',
    name: 'SDK channel compatibility cleanup profile',
    status: 'active',
    updatedAt: new Date('2026-04-03T00:00:00.000Z'),
  };

  mockAcquireLock.mockReset();
  mockAcquireLock.mockResolvedValue({
    key: `auth-profile:op-lock:${TEST_TENANT}:${TEST_PROFILE_ID}`,
    value: 'lock-owner',
    expiresAt: new Date('2026-04-03T00:01:00.000Z'),
  });
  mockAuthProfileCountDocuments.mockReset();
  mockAuthProfileCountDocuments.mockResolvedValue(0);
  mockAuthProfileFindOne.mockReset();
  mockAuthProfileFindOne.mockResolvedValue(activeProfile);
  mockAuthProfileFindOneAndUpdate.mockReset();
  mockAuthProfileFindOneAndUpdate.mockResolvedValue({
    ...activeProfile,
    status: 'revoked',
  });
  mockConsumerCountDocuments.mockReset();
  mockConsumerCountDocuments.mockResolvedValue(0);
  mockInvalidateAuthProfileCache.mockReset();
  mockLoggerError.mockReset();
  mockReleaseLock.mockReset();
  mockReleaseLock.mockResolvedValue(true);
  mockRequirePermissionInline.mockReset();
  mockRequirePermissionInline.mockReturnValue(true);
  mockSDKChannelCountDocuments.mockReset();
  mockSDKChannelCountDocuments.mockResolvedValue(4);
});

afterAll(() => {
  server?.close();
});

describe('DELETE /api/auth-profiles/:id with retired SDKChannel authProfileId data', () => {
  it('does not query SDKChannel as an auth profile consumer', async () => {
    const response = await request(server).delete(`/api/auth-profiles/${TEST_PROFILE_ID}`);

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(mockSDKChannelCountDocuments).not.toHaveBeenCalled();
    expect(mockInvalidateAuthProfileCache).toHaveBeenCalledWith(TEST_TENANT, TEST_PROFILE_ID);
    expect(mockLoggerError).not.toHaveBeenCalled();
  });
});
