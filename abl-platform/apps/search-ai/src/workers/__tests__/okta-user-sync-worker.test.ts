/**
 * Okta User Sync Worker Tests
 *
 * Unit tests for Okta user synchronization worker.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Job } from 'bullmq';
import type { OktaUserSyncJobData } from '../shared.js';

const mockResolveTenantPlaintextValue = vi.fn();

// Mock database layer
const mockLLMCredential = {
  findOne: vi.fn(),
  findOneAndUpdate: vi.fn(),
};

vi.mock('@agent-platform/database', () => ({
  resolveTenantPlaintextValue: (...args: unknown[]) => mockResolveTenantPlaintextValue(...args),
}));

vi.mock('../../db/index.js', () => ({
  getLazyModel: vi.fn((name: string) => {
    if (name === 'LLMCredential') return mockLLMCredential;
    return {};
  }),
}));

// Mock database context
vi.mock('@agent-platform/database/mongo', () => ({
  withTenantContext: vi.fn((_context: any, callback: any) => callback()),
}));

// Mock MongoPermissionStore (replaces PermissionGraphService)
const mockPermissionService = {
  upsertUser: vi.fn().mockResolvedValue(undefined),
};

vi.mock('@agent-platform/search-ai-internal/permissions', () => ({
  MongoPermissionStore: {
    getInstance: vi.fn(() => mockPermissionService),
  },
}));

// Mock Redis (uses SCAN instead of KEYS for non-blocking operation)
const mockRedis = {
  scan: vi.fn().mockResolvedValue(['0', []]), // Default: no keys found
  del: vi.fn(),
  quit: vi.fn(),
};

vi.mock('ioredis', () => ({
  Redis: vi.fn(() => mockRedis),
}));

// Mock shared functions
vi.mock('../shared.js', async () => {
  const actual = await vi.importActual<typeof import('../shared.js')>('../shared.js');
  return {
    ...actual,
    createWorkerOptions: vi.fn(),
    workerLog: vi.fn(),
    workerError: vi.fn(),
    getRedisConnection: vi.fn(() => ({ host: 'localhost', port: 6379 })),
    // Stubs for encryption helpers that normally require ENCRYPTION_MASTER_KEY
    createBlindIndexFn: () => () => 'mock-blind-index',
    createEncryptFn: () => () => 'mock-encrypted-value',
  };
});

// Mock logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })),
}));

// Mock global fetch
global.fetch = vi.fn();

describe('Okta User Sync Worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveTenantPlaintextValue.mockImplementation(
      async (value: string | null | undefined) => value ?? null,
    );
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('should sync users from Okta successfully', async () => {
    // Mock credential lookup
    mockLLMCredential.findOne.mockResolvedValue({
      _id: 'cred-123',
      tenantId: 'tenant-123',
      encryptedApiKey: 'ciphertext-okta-token',
      isActive: true,
    });
    mockResolveTenantPlaintextValue.mockResolvedValueOnce('resolved-okta-token');

    // Mock Okta API response
    const mockOktaUsers = [
      {
        id: 'okta-user-1',
        status: 'ACTIVE',
        profile: {
          email: 'user1@example.com',
          login: 'user1@example.com',
          firstName: 'John',
          lastName: 'Doe',
        },
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'okta-user-2',
        status: 'ACTIVE',
        profile: {
          email: 'user2@example.com',
          login: 'user2@example.com',
          firstName: 'Jane',
          lastName: 'Smith',
        },
        lastUpdated: '2024-01-02T00:00:00.000Z',
      },
    ];

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      headers: {
        get: vi.fn(() => null), // No pagination
      },
      json: vi.fn().mockResolvedValue(mockOktaUsers),
    });

    // Mock credential update
    mockLLMCredential.findOneAndUpdate.mockResolvedValue({});

    // Create job data
    const jobData: OktaUserSyncJobData = {
      tenantId: 'tenant-123',
      credentialId: 'cred-123',
      syncMode: 'full',
      oktaDomain: 'company.okta.com',
    };

    // Import and run worker processor
    const { processOktaUserSync } = await import('../okta-user-sync-worker.js');

    // Create mock job
    const mockJob = {
      data: jobData,
      updateProgress: vi.fn(),
      id: 'job-123',
    } as unknown as Job<OktaUserSyncJobData>;

    // Process job
    await processOktaUserSync(mockJob);

    // Verify credential was loaded
    expect(mockLLMCredential.findOne).toHaveBeenCalledWith({
      _id: 'cred-123',
      tenantId: 'tenant-123',
      isActive: true,
    });

    // Verify Okta API was called
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining('https://company.okta.com/api/v1/users'),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'SSWS resolved-okta-token',
        }),
      }),
    );
    expect(mockResolveTenantPlaintextValue).toHaveBeenCalledWith(
      'ciphertext-okta-token',
      'tenant-123',
      { decryptionFailed: false },
    );

    // Verify users were upserted
    expect(mockPermissionService.upsertUser).toHaveBeenCalledTimes(2);
    expect(mockPermissionService.upsertUser).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-123',
        email: 'user1@example.com',
        idpUserId: 'okta-user-1',
        idpProvider: 'okta',
        displayName: 'John Doe',
      }),
    );

    // Verify timestamp was stored
    expect(mockLLMCredential.findOneAndUpdate).toHaveBeenCalledWith(
      { _id: 'cred-123', tenantId: 'tenant-123' },
      expect.objectContaining({
        $set: expect.objectContaining({
          'metadata.oktaUserSyncLastUpdated': expect.any(String),
          'metadata.lastUserSync': expect.any(Date),
        }),
      }),
    );

    // Note: Cache invalidation is non-fatal and tested separately
  });

  test('should handle pagination correctly', async () => {
    mockLLMCredential.findOne.mockResolvedValue({
      _id: 'cred-123',
      tenantId: 'tenant-123',
      encryptedApiKey: 'mock-okta-token',
      isActive: true,
    });

    // Mock first page
    const page1Users = [
      {
        id: 'okta-user-1',
        status: 'ACTIVE',
        profile: { email: 'user1@example.com', login: 'user1@example.com' },
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
    ];

    // Mock second page
    const page2Users = [
      {
        id: 'okta-user-2',
        status: 'ACTIVE',
        profile: { email: 'user2@example.com', login: 'user2@example.com' },
        lastUpdated: '2024-01-02T00:00:00.000Z',
      },
    ];

    // First fetch with pagination link
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      headers: {
        get: vi.fn(() => '<https://company.okta.com/api/v1/users?after=abc123>; rel="next"'),
      },
      json: vi.fn().mockResolvedValue(page1Users),
    });

    // Second fetch without pagination
    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      headers: {
        get: vi.fn(() => null),
      },
      json: vi.fn().mockResolvedValue(page2Users),
    });

    mockLLMCredential.findOneAndUpdate.mockResolvedValue({});
    mockRedis.scan.mockResolvedValue(['0', []]);
    mockRedis.quit.mockResolvedValue(undefined);

    const jobData: OktaUserSyncJobData = {
      tenantId: 'tenant-123',
      credentialId: 'cred-123',
      syncMode: 'full',
      oktaDomain: 'company.okta.com',
    };

    const { processOktaUserSync } = await import('../okta-user-sync-worker.js');

    const mockJob = {
      data: jobData,
      updateProgress: vi.fn(),
      id: 'job-123',
    } as unknown as Job<OktaUserSyncJobData>;

    await processOktaUserSync(mockJob);

    // Verify both API calls were made
    expect(global.fetch).toHaveBeenCalledTimes(2);

    // Verify all users were synced
    expect(mockPermissionService.upsertUser).toHaveBeenCalledTimes(2);
  });

  test('should handle delta sync with lastUpdated filter', async () => {
    mockLLMCredential.findOne.mockResolvedValue({
      _id: 'cred-123',
      tenantId: 'tenant-123',
      encryptedApiKey: 'mock-okta-token',
      isActive: true,
    });

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      headers: { get: vi.fn(() => null) },
      json: vi.fn().mockResolvedValue([]),
    });

    mockLLMCredential.findOneAndUpdate.mockResolvedValue({});
    mockRedis.scan.mockResolvedValue(['0', []]);
    mockRedis.quit.mockResolvedValue(undefined);

    const lastUpdated = '2024-01-01T00:00:00.000Z';
    const jobData: OktaUserSyncJobData = {
      tenantId: 'tenant-123',
      credentialId: 'cred-123',
      syncMode: 'delta',
      lastUpdated,
      oktaDomain: 'company.okta.com',
    };

    const { processOktaUserSync } = await import('../okta-user-sync-worker.js');

    const mockJob = {
      data: jobData,
      updateProgress: vi.fn(),
      id: 'job-123',
    } as unknown as Job<OktaUserSyncJobData>;

    await processOktaUserSync(mockJob);

    // Verify delta filter was applied
    expect(global.fetch).toHaveBeenCalledWith(
      expect.stringContaining(`filter=lastUpdated+gt+%22${encodeURIComponent(lastUpdated)}%22`),
      expect.any(Object),
    );
  });

  test('should filter out inactive users', async () => {
    mockLLMCredential.findOne.mockResolvedValue({
      _id: 'cred-123',
      tenantId: 'tenant-123',
      encryptedApiKey: 'mock-okta-token',
      isActive: true,
    });

    const mockOktaUsers = [
      {
        id: 'okta-user-1',
        status: 'ACTIVE',
        profile: { email: 'active@example.com', login: 'active@example.com' },
        lastUpdated: '2024-01-01T00:00:00.000Z',
      },
      {
        id: 'okta-user-2',
        status: 'SUSPENDED',
        profile: { email: 'suspended@example.com', login: 'suspended@example.com' },
        lastUpdated: '2024-01-02T00:00:00.000Z',
      },
      {
        id: 'okta-user-3',
        status: 'PROVISIONED',
        profile: { email: 'provisioned@example.com', login: 'provisioned@example.com' },
        lastUpdated: '2024-01-03T00:00:00.000Z',
      },
    ];

    (global.fetch as any).mockResolvedValueOnce({
      ok: true,
      headers: { get: vi.fn(() => null) },
      json: vi.fn().mockResolvedValue(mockOktaUsers),
    });

    mockLLMCredential.findOneAndUpdate.mockResolvedValue({});
    mockRedis.scan.mockResolvedValue(['0', []]);
    mockRedis.quit.mockResolvedValue(undefined);

    const jobData: OktaUserSyncJobData = {
      tenantId: 'tenant-123',
      credentialId: 'cred-123',
      syncMode: 'full',
      oktaDomain: 'company.okta.com',
    };

    const { processOktaUserSync } = await import('../okta-user-sync-worker.js');

    const mockJob = {
      data: jobData,
      updateProgress: vi.fn(),
      id: 'job-123',
    } as unknown as Job<OktaUserSyncJobData>;

    await processOktaUserSync(mockJob);

    // Only ACTIVE and PROVISIONED users should be synced
    expect(mockPermissionService.upsertUser).toHaveBeenCalledTimes(2);
    expect(mockPermissionService.upsertUser).not.toHaveBeenCalledWith(
      expect.objectContaining({
        email: 'suspended@example.com',
      }),
    );
  });

  test('should handle API errors gracefully', async () => {
    mockLLMCredential.findOne.mockResolvedValue({
      _id: 'cred-123',
      tenantId: 'tenant-123',
      encryptedApiKey: 'mock-okta-token',
      isActive: true,
    });

    // Mock API error
    (global.fetch as any).mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: vi.fn().mockResolvedValue('Unauthorized'),
    });

    const jobData: OktaUserSyncJobData = {
      tenantId: 'tenant-123',
      credentialId: 'cred-123',
      syncMode: 'full',
      oktaDomain: 'company.okta.com',
    };

    const { processOktaUserSync } = await import('../okta-user-sync-worker.js');

    const mockJob = {
      data: jobData,
      updateProgress: vi.fn(),
      id: 'job-123',
    } as unknown as Job<OktaUserSyncJobData>;

    // Should throw error
    await expect(processOktaUserSync(mockJob)).rejects.toThrow('Okta API error');
  });

  test('should handle missing credential', async () => {
    mockLLMCredential.findOne.mockResolvedValue(null);

    const jobData: OktaUserSyncJobData = {
      tenantId: 'tenant-123',
      credentialId: 'cred-123',
      syncMode: 'full',
      oktaDomain: 'company.okta.com',
    };

    const { processOktaUserSync } = await import('../okta-user-sync-worker.js');

    const mockJob = {
      data: jobData,
      updateProgress: vi.fn(),
      id: 'job-123',
    } as unknown as Job<OktaUserSyncJobData>;

    await expect(processOktaUserSync(mockJob)).rejects.toThrow(
      'LLM Credential cred-123 not found or inactive',
    );
  });
});
