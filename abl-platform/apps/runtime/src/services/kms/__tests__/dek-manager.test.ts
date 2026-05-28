/**
 * DEK Manager Tests
 *
 * Validates: acquire/unwrap/batch, usage tracking,
 * force-rotate, cache behavior.
 *
 * DEKManager now lives in @agent-platform/database/kms. Tests use
 * setKMSProviderPool() to inject a mock pool rather than mocking modules.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import {
  DEKManager,
  KMSResolver,
  setKMSProviderPool,
  _resetKMSRegistryForTesting,
} from '@agent-platform/database/kms';

// =============================================================================
// MOCKS
// =============================================================================

const mockGenerateDataKey = vi.fn();
const mockUnwrapKey = vi.fn();

const mockKMSProvider = {
  generateDataKey: (...args: any[]) => mockGenerateDataKey(...args),
  unwrapKey: (...args: any[]) => mockUnwrapKey(...args),
  initialize: vi.fn(),
  shutdown: vi.fn(),
  healthCheck: vi.fn(),
  wrapKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  createKey: vi.fn(),
  describeKey: vi.fn(),
  enableKeyRotation: vi.fn(),
  scheduleKeyDeletion: vi.fn(),
  providerType: 'local',
};

const mockFindOne = vi.fn();
const mockCreate = vi.fn();
const mockUpdateOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockUpdateMany = vi.fn();
const mockCountDocuments = vi.fn();

let mockDekIdCounter = 0;

vi.mock('@agent-platform/database/models', () => ({
  MaterializedKMSConfig: {
    findOne: (..._args: any[]) => ({
      lean: () => Promise.resolve(null),
    }),
  },
  TenantKMSConfig: {
    findOne: (..._args: any[]) => ({
      select: () => ({
        lean: () => Promise.resolve(null),
      }),
      lean: () => Promise.resolve(null),
    }),
  },
  DEKEntry: {
    findOne: (...args: any[]) => {
      const chainable = {
        sort: () => chainable,
        read: () => chainable,
        lean: () => mockFindOne(...args),
      };
      return chainable;
    },
    create: (...args: any[]) => mockCreate(...args),
    updateOne: (...args: any[]) => {
      mockUpdateOne(...args);
      return Promise.resolve({ modifiedCount: 1 });
    },
    findOneAndUpdate: (...args: any[]) => mockFindOneAndUpdate(...args),
    updateMany: (...args: any[]) => mockUpdateMany(...args),
    countDocuments: (...args: any[]) => mockCountDocuments(...args),
  },
  generateDekId: () => `test-dek-${++mockDekIdCounter}`,
}));

// =============================================================================
// FIXTURES
// =============================================================================

const SCOPE = {
  tenantId: 'tenant-1',
  projectId: 'project-1',
  environment: 'dev',
};

const KEK_KEY_ID = 'kek-1';

// =============================================================================
// TESTS
// =============================================================================

describe('DEKManager', () => {
  let manager: DEKManager;

  beforeEach(() => {
    // Inject a mock KMS provider pool so getKMSProviderPool() returns our mock
    const mockPool = {
      getProvider: vi.fn().mockResolvedValue(mockKMSProvider),
      getLocalProvider: vi.fn().mockReturnValue(mockKMSProvider),
      initialize: vi.fn(),
      shutdown: vi.fn(),
    };
    setKMSProviderPool(mockPool as any);

    manager = new DEKManager();
    mockFindOne.mockReset();
    mockCreate.mockReset();
    mockUpdateOne.mockReset();
    mockFindOneAndUpdate.mockReset();
    mockUpdateMany.mockReset();
    mockCountDocuments.mockReset();
    mockGenerateDataKey.mockReset();
    mockUnwrapKey.mockReset();
    mockDekIdCounter = 0;
  });

  afterEach(() => {
    manager.clearCache();
    _resetKMSRegistryForTesting();
  });

  describe('ACTIVE_DEK_ID', () => {
    it('should have a fixed DEK identifier', () => {
      expect(DEKManager.ACTIVE_DEK_ID).toBe('active');
    });
  });

  describe('acquireDEK', () => {
    it('should create a new DEK when none exists', async () => {
      const plaintext = randomBytes(32);
      const ciphertext = randomBytes(60);

      // findOne for active entry returns null
      mockFindOne.mockResolvedValueOnce(null);
      mockGenerateDataKey.mockResolvedValueOnce({
        plaintext,
        ciphertext,
        keyId: KEK_KEY_ID,
        keyVersion: 1,
      });
      mockCreate.mockResolvedValueOnce({});

      const result = await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      // DEKCache stores a copy of plaintext via Buffer.from(), so use deep equality
      expect(result.plaintext).toEqual(plaintext);
      // KMSResolver falls through to platform default (keyId: 'platform-default')
      // when no MaterializedKMSConfig or TenantKMSConfig exists.
      // The resolvedKeyId = kmsConfig.keyId || kekKeyId, and kmsConfig.keyId = 'platform-default'.
      expect(result.kekKeyId).toBe('platform-default');
      expect(result.kekKeyVersion).toBe(1);
      // Decision 3: dekId is opaque (from generateDekId mock)
      expect(result.dekId).toBe('test-dek-1');
      expect(mockGenerateDataKey).toHaveBeenCalledWith('platform-default');
      expect(mockCreate).toHaveBeenCalledTimes(1);
      // Verify scope fields in create call
      const createArg = mockCreate.mock.calls[0][0];
      expect(createArg.tenantId).toBe('tenant-1');
      expect(createArg.projectId).toBe('project-1');
      expect(createArg.environment).toBe('dev');
      expect(createArg.dekId).toBe('test-dek-1');
    });

    it('should return existing DEK and unwrap it', async () => {
      const wrappedDek = randomBytes(60);
      const unwrappedDek = randomBytes(32);

      mockFindOne.mockResolvedValueOnce({
        _id: 'dek-1',
        dekId: 'opaque-id-1',
        epoch: '2026-03-25T00',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 2,
        wrappedDek: wrappedDek.toString('base64'),
        status: 'active',
        usageCount: 0,
        maxUsageCount: 2 ** 30,
        expiresAt: new Date(Date.now() + 86400000),
      });
      mockUnwrapKey.mockResolvedValueOnce(unwrappedDek);

      const result = await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      expect(result.plaintext).toEqual(unwrappedDek);
      expect(result.dekId).toBe('opaque-id-1');
      expect(result.kekKeyVersion).toBe(2);
      expect(mockGenerateDataKey).not.toHaveBeenCalled();
    });

    it('should use cache on second acquire', async () => {
      const wrappedDek = randomBytes(60);
      const unwrappedDek = randomBytes(32);

      mockFindOne.mockResolvedValueOnce({
        _id: 'dek-1',
        dekId: 'opaque-id-1',
        epoch: '2026-03-25T00',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: wrappedDek.toString('base64'),
        status: 'active',
        usageCount: 0,
        maxUsageCount: 2 ** 30,
        expiresAt: new Date(Date.now() + 86400000),
      });
      mockUnwrapKey.mockResolvedValueOnce(unwrappedDek);

      await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      // Second call should hit cache — no new findOne or unwrap
      const result = await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      // DEKCache stores a copy of plaintext via Buffer.from(), so use deep equality
      expect(result.plaintext).toEqual(unwrappedDek);
      expect(mockFindOne).toHaveBeenCalledTimes(1);
      expect(mockUnwrapKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('unwrapDEK', () => {
    it('should unwrap a DEK by identifier (Decision 3: no scope needed)', async () => {
      const wrappedDek = randomBytes(60);
      const unwrapped = randomBytes(32);

      mockFindOne.mockResolvedValueOnce({
        dekId: 'opaque-id-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        environment: 'dev',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: wrappedDek.toString('base64'),
        status: 'decrypt_only',
      });
      mockUnwrapKey.mockResolvedValueOnce(unwrapped);

      const result = await manager.unwrapDEK('opaque-id-1', 'tenant-1');

      expect(result).toEqual(unwrapped);
    });

    it('should throw when DEK not found', async () => {
      mockFindOne.mockResolvedValueOnce(null);

      await expect(manager.unwrapDEK('nonexistent', 'tenant-1')).rejects.toThrow('DEK not found');
    });

    it('should cache unwrapped DEK', async () => {
      const wrappedDek = randomBytes(60);
      const unwrapped = randomBytes(32);

      mockFindOne.mockResolvedValueOnce({
        dekId: 'opaque-id-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        environment: 'dev',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: wrappedDek.toString('base64'),
        status: 'active',
      });
      mockUnwrapKey.mockResolvedValueOnce(unwrapped);

      await manager.unwrapDEK('opaque-id-1', 'tenant-1');
      await manager.unwrapDEK('opaque-id-1', 'tenant-1');

      expect(mockUnwrapKey).toHaveBeenCalledTimes(1);
    });
  });

  describe('batchUnwrapDEKs', () => {
    it('should batch unwrap multiple DEK IDs', async () => {
      const dekIds = ['id-1', 'id-2', 'id-3'];

      // Pre-warm cache by unwrapping each individually
      for (const id of dekIds) {
        mockFindOne.mockResolvedValueOnce({
          dekId: id,
          tenantId: 'tenant-1',
          projectId: 'project-1',
          environment: 'dev',
          kekKeyId: KEK_KEY_ID,
          kekKeyVersion: 1,
          wrappedDek: randomBytes(60).toString('base64'),
          status: 'active',
        });
        mockUnwrapKey.mockResolvedValueOnce(randomBytes(32));
        await manager.unwrapDEK(id, 'tenant-1');
      }

      // Decision 3: no scope needed for batch unwrap — all from cache
      const results = await manager.batchUnwrapDEKs(dekIds, 'tenant-1');

      expect(results.size).toBe(3);
      for (const id of dekIds) {
        expect(results.has(id)).toBe(true);
      }
      expect(mockUnwrapKey).toHaveBeenCalledTimes(3);
    });

    it('should deduplicate repeated DEK IDs', async () => {
      mockFindOne.mockResolvedValueOnce({
        dekId: 'id-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        environment: 'dev',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: randomBytes(60).toString('base64'),
        status: 'active',
      });
      mockUnwrapKey.mockResolvedValueOnce(randomBytes(32));

      const results = await manager.batchUnwrapDEKs(['id-1', 'id-1', 'id-1'], 'tenant-1');

      expect(results.size).toBe(1);
    });

    it('should skip failed DEK IDs without throwing', async () => {
      mockFindOne.mockResolvedValueOnce({
        dekId: 'id-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        environment: 'dev',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: randomBytes(60).toString('base64'),
        status: 'active',
      });
      mockUnwrapKey.mockResolvedValueOnce(randomBytes(32));

      // Pre-warm id-1
      await manager.unwrapDEK('id-1', 'tenant-1');

      // id-2 will not be found
      mockFindOne.mockResolvedValueOnce(null);

      const results = await manager.batchUnwrapDEKs(['id-1', 'id-2'], 'tenant-1');

      expect(results.size).toBe(1);
      expect(results.has('id-1')).toBe(true);
    });
  });

  describe('forceRotateDEK', () => {
    it('should mark all active DEKs as decrypt_only and clear cache', async () => {
      mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 2 });

      const rotated = await manager.forceRotateDEK(SCOPE);

      expect(rotated).toBe(2);
      expect(mockUpdateMany).toHaveBeenCalledWith(
        {
          tenantId: SCOPE.tenantId,
          status: 'active',
          projectId: SCOPE.projectId,
          environment: SCOPE.environment,
        },
        { $set: { status: 'decrypt_only', retiredAt: expect.any(Date) } },
      );
    });
  });

  describe('FR-3: epoch dedup concurrent creation (E11000 retry)', () => {
    let originalSetTimeout: typeof globalThis.setTimeout;

    beforeEach(() => {
      // Replace setTimeout with immediate resolution to avoid real delays
      originalSetTimeout = globalThis.setTimeout;
      globalThis.setTimeout = ((fn: (...args: any[]) => void) => {
        return originalSetTimeout(fn, 0);
      }) as any;
    });

    afterEach(() => {
      globalThis.setTimeout = originalSetTimeout;
    });

    it('should retry and find winner DEK on E11000 duplicate key error', async () => {
      const plaintext = randomBytes(32);
      const ciphertext = randomBytes(60);
      const winnerWrappedDek = randomBytes(60);
      const winnerUnwrapped = randomBytes(32);

      const winnerEntry = {
        _id: 'winner-dek',
        dekId: 'winner-opaque-id',
        epoch: '2026-03-25T00',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: winnerWrappedDek.toString('base64'),
        status: 'active',
        usageCount: 0,
        maxUsageCount: 2 ** 30,
        expiresAt: new Date(Date.now() + 86400000),
      };

      // First call: no active DEK found → triggers create
      mockFindOne.mockResolvedValueOnce(null);
      mockGenerateDataKey.mockResolvedValueOnce({
        plaintext,
        ciphertext,
        keyId: KEK_KEY_ID,
        keyVersion: 1,
      });

      // Create throws E11000 (another pod created it first — epoch index)
      const e11000 = Object.assign(new Error('E11000 duplicate key error'), {
        code: 11000,
        keyPattern: { tenantId: 1, projectId: 1, environment: 1, epoch: 1 },
      });
      mockCreate.mockRejectedValueOnce(e11000);

      // Primary read for winner check: finds the active winner
      mockFindOne.mockResolvedValueOnce(winnerEntry);
      // Retry _doAcquireDEK: findOne for active DEK returns the winner
      mockFindOne.mockResolvedValueOnce(winnerEntry);
      mockUnwrapKey.mockResolvedValueOnce(winnerUnwrapped);

      const result = await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      // Should return the winner's DEK, not the one we tried to create
      expect(result.dekId).toBe('winner-opaque-id');
      expect(result.plaintext).toEqual(winnerUnwrapped);
      // Original plaintext should have been zero-filled
      expect(plaintext.every((b) => b === 0)).toBe(true);
    });

    it('should throw after exceeding max retries on repeated E11000', async () => {
      const e11000 = Object.assign(new Error('E11000 duplicate key error'), {
        code: 11000,
        keyPattern: { tenantId: 1, projectId: 1, environment: 1, epoch: 1 },
      });

      // Simulate repeated pod-race: each attempt finds no active DEK initially,
      // generates a key, E11000 on create, finds a "winner" (triggering retry),
      // but the retry also fails because on re-entry findOne returns null again.
      // This exhausts MAX_ACQUIRE_RETRIES (3).
      const winnerEntry = {
        _id: 'winner-dek',
        dekId: 'winner-opaque-id',
        epoch: '2026-03-25T00',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: randomBytes(60).toString('base64'),
        status: 'active',
        usageCount: 0,
        maxUsageCount: 2 ** 30,
        expiresAt: new Date(Date.now() + 86400000),
      };

      for (let i = 0; i < 4; i++) {
        // _doAcquireDEK: no active DEK → generate → create → E11000
        mockFindOne.mockResolvedValueOnce(null);
        mockGenerateDataKey.mockResolvedValueOnce({
          plaintext: randomBytes(32),
          ciphertext: randomBytes(60),
          keyId: KEK_KEY_ID,
          keyVersion: 1,
        });
        mockCreate.mockRejectedValueOnce(e11000);
        // Primary read for winner: return a winner so it takes the retry path
        mockFindOne.mockResolvedValueOnce(winnerEntry);
      }

      await expect(manager.acquireDEK(SCOPE, KEK_KEY_ID)).rejects.toThrow(/exceeded max retries/);
    });

    it('should free retired epoch slot and retry when no active winner exists', async () => {
      const newPlaintext = randomBytes(32);
      const newCiphertext = randomBytes(60);

      // First attempt: no active DEK → generate → create → E11000 (epoch index)
      mockFindOne.mockResolvedValueOnce(null);
      mockGenerateDataKey.mockResolvedValueOnce({
        plaintext: randomBytes(32),
        ciphertext: randomBytes(60),
        keyId: KEK_KEY_ID,
        keyVersion: 1,
      });
      const e11000 = Object.assign(new Error('E11000 duplicate key error'), {
        code: 11000,
        keyPattern: { tenantId: 1, projectId: 1, environment: 1, epoch: 1 },
      });
      mockCreate.mockRejectedValueOnce(e11000);

      // Primary read for winner: null (no active winner)
      mockFindOne.mockResolvedValueOnce(null);
      // findOneAndUpdate frees the retired entry's epoch slot
      mockFindOneAndUpdate.mockResolvedValueOnce({
        _id: 'retired-dek',
        dekId: 'old-id',
        status: 'decrypt_only',
      });

      // Retry _doAcquireDEK: no active DEK → generate fresh → create succeeds
      mockFindOne.mockResolvedValueOnce(null);
      mockGenerateDataKey.mockResolvedValueOnce({
        plaintext: newPlaintext,
        ciphertext: newCiphertext,
        keyId: KEK_KEY_ID,
        keyVersion: 1,
      });
      mockCreate.mockResolvedValueOnce({});

      const result = await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      // Verify key material is valid (32 bytes, not zeroed)
      expect(result.plaintext).toBeInstanceOf(Buffer);
      expect(result.plaintext.length).toBe(32);
      expect(result.plaintext.every((b: number) => b === 0)).toBe(false);
      // Verify findOneAndUpdate was called to free the epoch slot
      expect(mockFindOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: SCOPE.tenantId,
          projectId: SCOPE.projectId,
          environment: SCOPE.environment,
          status: { $ne: 'active' },
        }),
        expect.anything(),
      );
    });

    it('should not run epoch-slot recovery for unknown E11000 keyPattern', async () => {
      const newPlaintext = randomBytes(32);
      const newCiphertext = randomBytes(60);

      // First attempt: no active DEK → generate → create → E11000 with unknown keyPattern
      mockFindOne.mockResolvedValueOnce(null);
      mockGenerateDataKey.mockResolvedValueOnce({
        plaintext: randomBytes(32),
        ciphertext: randomBytes(60),
        keyId: KEK_KEY_ID,
        keyVersion: 1,
      });
      const e11000 = Object.assign(new Error('E11000 duplicate key error'), {
        code: 11000,
        keyPattern: { someUnknownField: 1 },
      });
      mockCreate.mockRejectedValueOnce(e11000);

      // Retry _doAcquireDEK: no active DEK → generate fresh → create succeeds
      mockFindOne.mockResolvedValueOnce(null);
      mockGenerateDataKey.mockResolvedValueOnce({
        plaintext: newPlaintext,
        ciphertext: newCiphertext,
        keyId: KEK_KEY_ID,
        keyVersion: 1,
      });
      mockCreate.mockResolvedValueOnce({});

      const result = await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      expect(result.plaintext).toEqual(newPlaintext);
      // findOneAndUpdate must NOT be called — no epoch-slot mutation for unknown indexes
      expect(mockFindOneAndUpdate).not.toHaveBeenCalled();
    });
  });

  describe('FR-4: maxUsageCount auto-rotation trigger', () => {
    it('should auto-rotate DEK when usageCount >= maxUsageCount', async () => {
      const overusedWrappedDek = randomBytes(60);
      const newPlaintext = randomBytes(32);
      const newCiphertext = randomBytes(60);

      // findOne returns a DEK that has hit its usage ceiling
      mockFindOne.mockResolvedValueOnce({
        _id: 'overused-dek',
        dekId: 'overused-id',
        epoch: '2026-03-25T00',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: overusedWrappedDek.toString('base64'),
        status: 'active',
        usageCount: 1000,
        maxUsageCount: 1000, // At ceiling
        expiresAt: new Date(Date.now() + 86400000),
      });

      // generateDataKey for the new DEK
      mockGenerateDataKey.mockResolvedValueOnce({
        plaintext: newPlaintext,
        ciphertext: newCiphertext,
        keyId: KEK_KEY_ID,
        keyVersion: 1,
      });
      mockCreate.mockResolvedValueOnce({});

      const result = await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      // New DEK was created (old one auto-rotated to decrypt_only)
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(result.plaintext).toBe(newPlaintext);
      expect(result.dekId).toBe('test-dek-1');
      // The old DEK's key material should NOT be returned
      expect(mockUnwrapKey).not.toHaveBeenCalled();
    });

    it('should auto-rotate DEK when it has expired', async () => {
      const expiredWrappedDek = randomBytes(60);
      const newPlaintext = randomBytes(32);
      const newCiphertext = randomBytes(60);

      // findOne returns an expired DEK
      mockFindOne.mockResolvedValueOnce({
        _id: 'expired-dek',
        dekId: 'expired-id',
        epoch: '2026-03-24T00',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: expiredWrappedDek.toString('base64'),
        status: 'active',
        usageCount: 5,
        maxUsageCount: 2 ** 30,
        expiresAt: new Date(Date.now() - 1000), // Already expired
      });

      // New DEK generation
      mockGenerateDataKey.mockResolvedValueOnce({
        plaintext: newPlaintext,
        ciphertext: newCiphertext,
        keyId: KEK_KEY_ID,
        keyVersion: 1,
      });
      mockCreate.mockResolvedValueOnce({});

      const result = await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      // New DEK was created — expired one was rotated out
      expect(mockCreate).toHaveBeenCalledTimes(1);
      expect(result.plaintext).toBe(newPlaintext);
      expect(mockUnwrapKey).not.toHaveBeenCalled();
    });

    it('should auto-rotate DEK when active provider drifts from platform default', async () => {
      const localWrappedDek = randomBytes(60);
      const newPlaintext = randomBytes(32);
      const newCiphertext = randomBytes(60);
      const azureProvider = {
        providerType: 'azure-keyvault',
        keyId: 'abl-platform-kms',
        region: null,
        vaultUrl: 'https://kv-abl-dev.vault.azure.net/',
        externalEndpoint: null,
        authMethod: 'default-credentials',
        authConfigEncrypted: null,
      };

      manager = new DEKManager({
        resolve: vi.fn().mockResolvedValue({
          provider: azureProvider,
          keyId: 'abl-platform-kms',
          dekEpochIntervalHours: 24,
          dekMaxUsageCount: 2 ** 30,
          failurePolicy: 'fail-closed',
          sourceConfigVersion: 0,
        }),
      } as any);

      mockFindOne.mockResolvedValueOnce({
        _id: 'local-active-dek',
        dekId: 'local-active-id',
        epoch: '2026-03-25T00',
        kekKeyId: 'platform-default',
        kekKeyVersion: 1,
        wrappedDek: localWrappedDek.toString('base64'),
        wrappingProvider: { providerType: 'local', keyId: 'platform-default' },
        wrappingSourceConfigVersion: 0,
        status: 'active',
        usageCount: 10,
        maxUsageCount: 2 ** 30,
        expiresAt: new Date(Date.now() + 86400000),
      });
      mockGenerateDataKey.mockResolvedValue({
        plaintext: newPlaintext,
        ciphertext: newCiphertext,
        keyId: 'abl-platform-kms',
        keyVersion: 3,
      });
      mockCreate.mockResolvedValue({});

      const result = await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      expect(mockUpdateOne).toHaveBeenCalledWith(
        { _id: 'local-active-dek' },
        { $set: { status: 'decrypt_only', retiredAt: expect.any(Date) } },
      );
      expect(mockGenerateDataKey).toHaveBeenCalledWith('abl-platform-kms');
      expect(mockUnwrapKey).not.toHaveBeenCalled();
      expect(result.dekId).toBe('test-dek-1');
      expect(result.kekKeyId).toBe('abl-platform-kms');
      expect(result.kekKeyVersion).toBe(3);

      const createArg = mockCreate.mock.calls[0][0];
      expect(createArg.kekKeyId).toBe('abl-platform-kms');
      expect(createArg.wrappingProvider).toEqual(azureProvider);
    });
  });

  describe('FR-16: scoped lastAcquiredDekId', () => {
    it('getActiveDEKId returns sentinel when no DEK acquired', () => {
      expect(manager.getActiveDEKId(SCOPE)).toBe(DEKManager.ACTIVE_DEK_ID);
      expect(manager.getActiveDEKId()).toBe(DEKManager.ACTIVE_DEK_ID);
    });

    it('getActiveDEKId returns per-scope dekId after acquire', async () => {
      const wrappedDek = randomBytes(60);
      const unwrapped = randomBytes(32);

      mockFindOne.mockResolvedValueOnce({
        _id: 'dek-1',
        dekId: 'scope-a-dek',
        epoch: '2026-03-25T00',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: wrappedDek.toString('base64'),
        status: 'active',
        usageCount: 0,
        maxUsageCount: 2 ** 30,
        expiresAt: new Date(Date.now() + 86400000),
      });
      mockUnwrapKey.mockResolvedValueOnce(unwrapped);

      await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      expect(manager.getActiveDEKId(SCOPE)).toBe('scope-a-dek');
    });

    it('different scopes track separate dekIds', async () => {
      const SCOPE_B = { tenantId: 'tenant-2', projectId: 'project-2', environment: 'prod' };

      // Acquire for SCOPE A
      mockFindOne.mockResolvedValueOnce({
        _id: 'dek-a',
        dekId: 'dek-for-scope-a',
        epoch: '2026-03-25T00',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: randomBytes(60).toString('base64'),
        status: 'active',
        usageCount: 0,
        maxUsageCount: 2 ** 30,
        expiresAt: new Date(Date.now() + 86400000),
      });
      mockUnwrapKey.mockResolvedValueOnce(randomBytes(32));

      await manager.acquireDEK(SCOPE, KEK_KEY_ID);

      // Acquire for SCOPE B
      mockFindOne.mockResolvedValueOnce({
        _id: 'dek-b',
        dekId: 'dek-for-scope-b',
        epoch: '2026-03-25T00',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: randomBytes(60).toString('base64'),
        status: 'active',
        usageCount: 0,
        maxUsageCount: 2 ** 30,
        expiresAt: new Date(Date.now() + 86400000),
      });
      mockUnwrapKey.mockResolvedValueOnce(randomBytes(32));

      await manager.acquireDEK(SCOPE_B, KEK_KEY_ID);

      // Each scope has its own tracked dekId
      expect(manager.getActiveDEKId(SCOPE)).toBe('dek-for-scope-a');
      expect(manager.getActiveDEKId(SCOPE_B)).toBe('dek-for-scope-b');
    });

    it('forceRotateDEK clears the scoped lastAcquiredDekId', async () => {
      const wrappedDek = randomBytes(60);
      mockFindOne.mockResolvedValueOnce({
        _id: 'dek-1',
        dekId: 'pre-rotate-dek',
        epoch: '2026-03-25T00',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: wrappedDek.toString('base64'),
        status: 'active',
        usageCount: 0,
        maxUsageCount: 2 ** 30,
        expiresAt: new Date(Date.now() + 86400000),
      });
      mockUnwrapKey.mockResolvedValueOnce(randomBytes(32));

      await manager.acquireDEK(SCOPE, KEK_KEY_ID);
      expect(manager.getActiveDEKId(SCOPE)).toBe('pre-rotate-dek');

      // Force rotate
      mockUpdateMany.mockResolvedValueOnce({ modifiedCount: 1 });
      await manager.forceRotateDEK(SCOPE);

      // Should revert to sentinel after rotation
      expect(manager.getActiveDEKId(SCOPE)).toBe(DEKManager.ACTIVE_DEK_ID);
    });
  });

  describe('cache management', () => {
    it('should report cache size', async () => {
      expect(manager.cacheSize).toBe(0);

      const wrappedDek = randomBytes(60);
      const unwrapped = randomBytes(32);
      mockFindOne.mockResolvedValue({
        dekId: 'id-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        environment: 'dev',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: wrappedDek.toString('base64'),
        status: 'active',
      });
      mockUnwrapKey.mockResolvedValue(unwrapped);

      await manager.unwrapDEK('id-1', 'tenant-1');
      expect(manager.cacheSize).toBe(1);
    });

    it('should clear cache', async () => {
      const wrappedDek = randomBytes(60);
      mockFindOne.mockResolvedValue({
        dekId: 'id-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        environment: 'dev',
        kekKeyId: KEK_KEY_ID,
        kekKeyVersion: 1,
        wrappedDek: wrappedDek.toString('base64'),
        status: 'active',
      });
      mockUnwrapKey.mockResolvedValue(randomBytes(32));

      await manager.unwrapDEK('id-1', 'tenant-1');
      expect(manager.cacheSize).toBe(1);

      manager.clearCache();
      expect(manager.cacheSize).toBe(0);
    });
  });
});
