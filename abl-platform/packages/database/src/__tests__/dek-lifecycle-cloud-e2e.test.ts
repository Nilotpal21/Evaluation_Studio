/**
 * DEK Lifecycle — Cloud Provider End-to-End Test
 *
 * Exercises the FULL encryption stack with mocked cloud KMS:
 *   TenantEncryptionFacade → DEKManager → KMSResolver → KMSProviderPool → cloud provider
 *
 * Mocks:
 *   - Cloud SDKs (@aws-sdk/client-kms, @azure/keyvault-keys, @azure/identity, @google-cloud/kms)
 *     with real AES-256-GCM crypto at the SDK boundary
 *   - Mongoose models (DEKEntry, MaterializedKMSConfig, TenantKMSConfig) with in-memory stores
 *
 * Proves:
 *   - Full encrypt → decrypt roundtrip through AWS/Azure/GCP providers
 *   - DEK creation persisted and reused on second encrypt
 *   - Force rotation marks old DEK decrypt_only, new encrypt creates fresh DEK
 *   - Old ciphertext still decryptable after rotation (backward compat)
 *   - Cross-provider: encrypt with AWS, old data with Azure after config change
 *   - Sync encrypt/decrypt paths via cached DEKs
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// =============================================================================
// MOCK HELPERS (real AES-256-GCM at SDK boundary)
// =============================================================================

const MOCK_KEK = randomBytes(32);

function mockWrap(plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', MOCK_KEK, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([iv, encrypted, cipher.getAuthTag()]);
}

function mockUnwrap(ciphertext: Buffer): Buffer {
  const iv = ciphertext.subarray(0, 12);
  const authTag = ciphertext.subarray(ciphertext.length - 16);
  const encrypted = ciphertext.subarray(12, ciphertext.length - 16);
  const decipher = createDecipheriv('aes-256-gcm', MOCK_KEK, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]);
}

// =============================================================================
// SDK MOCKS
// =============================================================================

vi.mock('@aws-sdk/client-kms', () => {
  function makeCmd(name: string) {
    const c = class {
      constructor(public input: any) {}
    };
    Object.defineProperty(c, 'name', { value: name });
    return c;
  }

  class MockKMSClient {
    async send(cmd: any) {
      const name = cmd.constructor.name;
      if (name === 'GenerateDataKeyCommand') {
        const pt = randomBytes(32);
        return { Plaintext: pt, CiphertextBlob: mockWrap(pt), KeyId: cmd.input?.KeyId };
      }
      if (name === 'EncryptCommand')
        return {
          CiphertextBlob: mockWrap(Buffer.from(cmd.input?.Plaintext)),
          KeyId: cmd.input?.KeyId,
        };
      if (name === 'DecryptCommand')
        return {
          Plaintext: mockUnwrap(Buffer.from(cmd.input?.CiphertextBlob)),
          KeyId: cmd.input?.KeyId,
        };
      if (name === 'DescribeKeyCommand')
        return {
          KeyMetadata: {
            KeyId: cmd.input?.KeyId,
            Arn: 'arn:mock',
            KeyState: 'Enabled',
            Origin: 'AWS_KMS',
            CreationDate: new Date(),
          },
        };
      return {};
    }
    destroy() {}
  }

  return {
    KMSClient: MockKMSClient,
    GenerateDataKeyCommand: makeCmd('GenerateDataKeyCommand'),
    EncryptCommand: makeCmd('EncryptCommand'),
    DecryptCommand: makeCmd('DecryptCommand'),
    DescribeKeyCommand: makeCmd('DescribeKeyCommand'),
    CreateKeyCommand: makeCmd('CreateKeyCommand'),
    EnableKeyRotationCommand: makeCmd('EnableKeyRotationCommand'),
    ScheduleKeyDeletionCommand: makeCmd('ScheduleKeyDeletionCommand'),
    GetParametersForImportCommand: makeCmd('GetParametersForImportCommand'),
    ImportKeyMaterialCommand: makeCmd('ImportKeyMaterialCommand'),
  };
});

vi.mock('@azure/keyvault-keys', () => ({
  KeyClient: class {
    async getKey(n: string) {
      return { id: n, keyType: 'AES', properties: { enabled: true, createdOn: new Date() } };
    }
    async createKey(n: string) {
      return { id: n, keyType: 'AES', properties: { enabled: true, createdOn: new Date() } };
    }
    async updateKeyRotationPolicy() {
      return {};
    }
    async beginDeleteKey() {
      return { pollUntilDone: async () => ({}) };
    }
  },
  CryptographyClient: class {
    async wrapKey(_a: string, pt: Buffer) {
      return { result: mockWrap(pt) };
    }
    async unwrapKey(_a: string, ct: Buffer) {
      return { result: mockUnwrap(ct) };
    }
    async encrypt(_a: string, pt: Buffer) {
      return { result: mockWrap(pt) };
    }
    async decrypt(_a: string, ct: Buffer) {
      return { result: mockUnwrap(ct) };
    }
  },
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ClientSecretCredential: class {
    constructor(
      public t: string,
      public c: string,
      public s: string,
    ) {}
  },
}));

vi.mock('@google-cloud/kms', () => ({
  KeyManagementServiceClient: class {
    async encrypt(r: any) {
      return [{ ciphertext: mockWrap(Buffer.from(r.plaintext)) }];
    }
    async decrypt(r: any) {
      return [{ plaintext: mockUnwrap(Buffer.from(r.ciphertext)) }];
    }
    async getCryptoKey(r: any) {
      return [
        {
          name: r.name,
          versionTemplate: {
            algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION',
            protectionLevel: 'SOFTWARE',
          },
          createTime: new Date().toISOString(),
        },
      ];
    }
    async createCryptoKey(r: any) {
      return [{ name: r.parent, createTime: new Date().toISOString() }];
    }
    async updateCryptoKey() {
      return [{}];
    }
    async destroyCryptoKeyVersion() {
      return [{}];
    }
    async close() {}
  },
}));

// =============================================================================
// IN-MEMORY MONGOOSE MODEL MOCKS
// =============================================================================

/** In-memory DEKEntry store */
let dekStore: any[] = [];
let dekIdCounter = 0;

function generateTestDekId(): string {
  dekIdCounter++;
  return `test-dek-${dekIdCounter}-${randomBytes(4).toString('hex')}`;
}

function filterDekStore(filter: any): any[] {
  return dekStore.filter((d) => {
    for (const [key, val] of Object.entries(filter)) {
      if (key === 'status' && typeof val === 'object' && '$in' in (val as any)) {
        if (!(val as any).$in.includes(d.status)) return false;
      } else if (d[key] !== val) {
        return false;
      }
    }
    return true;
  });
}

function findDekForScope(input: {
  projectId: string;
  environment: string;
  status: 'active' | 'decrypt_only';
  providerType?: string;
}) {
  return dekStore.find((entry) => {
    if (
      entry.projectId !== input.projectId ||
      entry.environment !== input.environment ||
      entry.status !== input.status
    ) {
      return false;
    }

    if (input.providerType && entry.wrappingProvider?.providerType !== input.providerType) {
      return false;
    }

    return true;
  });
}

const mockDEKEntry = {
  findOne(filter: any) {
    const makeLean = () => ({
      lean() {
        const matches = filterDekStore(filter);
        matches.sort(
          (a: any, b: any) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        return matches[0] ?? null;
      },
    });
    return {
      sort(_s: any) {
        return makeLean();
      },
      // Direct .lean() (no .sort()) — used by unwrapDEK
      lean() {
        const matches = filterDekStore(filter);
        return matches[0] ?? null;
      },
    };
  },
  async create(doc: any) {
    // Check for unique constraint on { tenantId, projectId, environment, epoch }
    const dup = dekStore.find(
      (d) =>
        d.tenantId === doc.tenantId &&
        d.projectId === doc.projectId &&
        d.environment === doc.environment &&
        d.epoch === doc.epoch &&
        d.status === 'active',
    );
    if (dup) {
      const err: any = new Error('E11000 duplicate key');
      err.code = 11000;
      throw err;
    }
    const entry = { ...doc, _id: `dek-${dekStore.length}`, createdAt: new Date() };
    dekStore.push(entry);
    return entry;
  },
  updateOne(filter: any, update: any) {
    const entry = dekStore.find((d) => {
      for (const [key, val] of Object.entries(filter)) {
        if (d[key] !== val) return false;
      }
      return true;
    });
    if (entry && update.$set) {
      Object.assign(entry, update.$set);
    }
    if (entry && update.$inc) {
      for (const [k, v] of Object.entries(update.$inc)) {
        entry[k] = (entry[k] ?? 0) + (v as number);
      }
    }
    return Promise.resolve({ modifiedCount: entry ? 1 : 0 });
  },
  updateMany(filter: any, update: any) {
    let modified = 0;
    for (const entry of dekStore) {
      let match = true;
      for (const [key, val] of Object.entries(filter)) {
        if (entry[key] !== val) {
          match = false;
          break;
        }
      }
      if (match && update.$set) {
        Object.assign(entry, update.$set);
        modified++;
      }
    }
    return Promise.resolve({ modifiedCount: modified });
  },
};

// Mock models/index.js to return our in-memory stores
vi.mock('../models/index.js', () => ({
  DEKEntry: mockDEKEntry,
  generateDekId: generateTestDekId,
  MaterializedKMSConfig: {
    findOne(_filter: any) {
      return { lean: () => null }; // No materialized configs — force resolver to platform default
    },
  },
  TenantKMSConfig: {
    findOne(_filter: any) {
      return { lean: () => null }; // No tenant config — use platform default
    },
  },
  CrawlError: {},
  User: {
    findOne: vi.fn(() => ({ lean: () => null })),
  },
  PlatformAccessRequest: {
    find: vi.fn(() => ({ sort: () => ({ lean: () => [] }) })),
  },
  PlatformAdmin: {
    findOne: vi.fn(() => ({ lean: () => null })),
  },
  PlatformAllowedDomain: {
    findOne: vi.fn(() => ({ lean: () => null })),
  },
  PlatformAllowedEmail: {},
  WorkspaceInvitation: {},
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import { KMSProviderPool } from '../kms/kms-provider-pool.js';
import { setKMSProviderPool, _resetKMSRegistryForTesting } from '../kms/kms-registry.js';
import { KMSResolver } from '../kms/kms-resolver.js';
import { DEKManager } from '../kms/dek-manager.js';
import { TenantEncryptionFacade } from '@agent-platform/shared-encryption';

// =============================================================================
// TESTS
// =============================================================================

const TEST_MASTER_KEY = 'a'.repeat(64);

describe('DEK Lifecycle — Cloud Provider E2E', () => {
  let pool: KMSProviderPool;
  let resolver: KMSResolver;
  let dekManager: DEKManager;
  let facade: TenantEncryptionFacade;

  async function wirePlatformProvider(
    providerType: 'local' | 'aws-kms' | 'azure-keyvault',
  ): Promise<void> {
    if (pool) {
      await pool.shutdown();
    }
    _resetKMSRegistryForTesting();
    KMSResolver._resetPlatformDefaultForTesting();

    delete process.env.KMS_PROVIDER;
    delete process.env.KMS_AWS_REGION;
    delete process.env.KMS_AWS_KEY_ID;
    delete process.env.KMS_AZURE_VAULT_URL;
    delete process.env.KMS_AZURE_KEY_NAME;

    if (providerType === 'aws-kms') {
      process.env.KMS_PROVIDER = 'aws-kms';
      process.env.KMS_AWS_REGION = 'us-east-1';
      process.env.KMS_AWS_KEY_ID = 'arn:aws:kms:us-east-1:123:key/e2e-test';
    } else if (providerType === 'azure-keyvault') {
      process.env.KMS_PROVIDER = 'azure-keyvault';
      process.env.KMS_AZURE_VAULT_URL = 'https://e2e-test.vault.azure.net';
      process.env.KMS_AZURE_KEY_NAME = 'azure-platform-key';
    } else {
      process.env.KMS_PROVIDER = 'local';
    }

    pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY, maxSize: 10 });
    await pool.initialize();
    setKMSProviderPool(pool);

    resolver = new KMSResolver();
    dekManager = new DEKManager(resolver);
    facade = new TenantEncryptionFacade(dekManager);
  }

  beforeEach(async () => {
    // Reset state
    dekStore = [];
    dekIdCounter = 0;
    await wirePlatformProvider('aws-kms');
  });

  afterEach(async () => {
    await pool.shutdown();
    _resetKMSRegistryForTesting();
    KMSResolver._resetPlatformDefaultForTesting();
    delete process.env.KMS_PROVIDER;
    delete process.env.KMS_AWS_REGION;
    delete process.env.KMS_AWS_KEY_ID;
    delete process.env.KMS_AZURE_VAULT_URL;
    delete process.env.KMS_AZURE_KEY_NAME;
  });

  const scope = { tenantId: 'tenant-1', projectId: 'proj-1', environment: 'production' };

  // ─── Full Encrypt/Decrypt Roundtrip via AWS ─────────────────────────

  describe('AWS KMS full stack roundtrip', () => {
    it('encrypt → decrypt roundtrip through full stack', async () => {
      const plaintext = 'secret-data-via-aws-kms';
      const encrypted = await facade.encrypt(plaintext, scope);

      // Encrypted value should be base64 DEK envelope
      expect(encrypted).not.toBe(plaintext);
      expect(typeof encrypted).toBe('string');

      // Decrypt via the facade
      const decrypted = await facade.decrypt(encrypted, scope.tenantId);
      expect(decrypted).toBe(plaintext);
    });

    it('creates a DEKEntry on first encrypt', async () => {
      await facade.encrypt('test', scope);
      expect(dekStore.length).toBe(1);
      expect(dekStore[0].tenantId).toBe('tenant-1');
      expect(dekStore[0].projectId).toBe('proj-1');
      expect(dekStore[0].environment).toBe('production');
      expect(dekStore[0].status).toBe('active');
      expect(dekStore[0].wrappedDek).toBeTruthy();
    });

    it('reuses the same DEK on second encrypt (cache hit)', async () => {
      const enc1 = await facade.encrypt('first', scope);
      const enc2 = await facade.encrypt('second', scope);

      // Still only 1 DEK
      expect(dekStore.length).toBe(1);

      // Both decrypt correctly
      expect(await facade.decrypt(enc1, scope.tenantId)).toBe('first');
      expect(await facade.decrypt(enc2, scope.tenantId)).toBe('second');
    });

    it('JSON encrypt/decrypt roundtrip', async () => {
      const data = { user: 'alice', scores: [1, 2, 3], nested: { ok: true } };
      const encrypted = await facade.encryptJson(data, scope);
      const decrypted = await facade.decryptJson(encrypted, scope.tenantId);
      expect(decrypted).toEqual(data);
    });
  });

  // ─── Force Rotation ─────────────────────────────────────────────────

  describe('DEK force rotation', () => {
    it('rotation marks old DEK as decrypt_only and creates new on next encrypt', async () => {
      // First encrypt creates DEK
      const enc1 = await facade.encrypt('before-rotation', scope);
      expect(dekStore.length).toBe(1);
      const oldDekId = dekStore[0].dekId;

      // Force rotate
      const rotated = await facade.forceRotate(scope.tenantId, scope.projectId, scope.environment);
      expect(rotated).toBe(1);
      expect(dekStore[0].status).toBe('decrypt_only');

      // Next encrypt creates a fresh DEK
      const enc2 = await facade.encrypt('after-rotation', scope);
      expect(dekStore.length).toBe(2);
      expect(dekStore[1].status).toBe('active');
      expect(dekStore[1].dekId).not.toBe(oldDekId);

      // Both old and new ciphertext still decrypt correctly
      expect(await facade.decrypt(enc1, scope.tenantId)).toBe('before-rotation');
      expect(await facade.decrypt(enc2, scope.tenantId)).toBe('after-rotation');
    });

    it('default forceRotate targets the tenant-wide defaults', async () => {
      const sharedScope = { tenantId: 'tenant-1', projectId: '_shared', environment: '_shared' };

      await facade.encrypt('shared-data', sharedScope);
      await facade.encrypt('project-data', scope);
      expect(dekStore.length).toBe(2);

      // Omitting project/environment defaults to the tenant-wide scope.
      const rotated = await facade.forceRotate('tenant-1');
      expect(rotated).toBe(2);
      expect(
        dekStore.find(
          (d) =>
            d.tenantId === sharedScope.tenantId &&
            d.projectId === sharedScope.projectId &&
            d.environment === sharedScope.environment,
        )?.status,
      ).toBe('decrypt_only');
      expect(
        dekStore.find(
          (d) =>
            d.tenantId === scope.tenantId &&
            d.projectId === scope.projectId &&
            d.environment === scope.environment,
        )?.status,
      ).toBe('decrypt_only');
    });
  });

  // ─── Sync Encrypt/Decrypt ──────────────────────────────────────────

  describe('Sync encrypt/decrypt (cached DEK)', () => {
    it('sync encrypt returns null before async encrypt warms cache', () => {
      const result = facade.encryptSync('test', scope);
      expect(result).toBeNull();
    });

    it('sync encrypt works after async encrypt warms the cache', async () => {
      // Warm cache with async encrypt
      await facade.encrypt('warmup', scope);

      // Now sync encrypt should work
      const encrypted = facade.encryptSync('sync-data', scope);
      expect(encrypted).not.toBeNull();
      expect(typeof encrypted).toBe('string');

      // And it should decrypt correctly
      const decrypted = await facade.decrypt(encrypted!, scope.tenantId);
      expect(decrypted).toBe('sync-data');
    });

    it('sync decrypt works for cached DEKs', async () => {
      const encrypted = await facade.encrypt('cached-test', scope);

      // sync decrypt should work since DEK is cached
      const decrypted = facade.decryptSync(encrypted, scope.tenantId);
      expect(decrypted).toBe('cached-test');
    });
  });

  // ─── Multi-Scope Isolation ─────────────────────────────────────────

  describe('Multi-scope isolation', () => {
    it('different scopes get different DEKs', async () => {
      const scope2 = { tenantId: 'tenant-2', projectId: 'proj-1', environment: 'production' };

      const enc1 = await facade.encrypt('tenant-1-data', scope);
      const enc2 = await facade.encrypt('tenant-2-data', scope2);

      expect(dekStore.length).toBe(2);
      expect(dekStore[0].tenantId).toBe('tenant-1');
      expect(dekStore[1].tenantId).toBe('tenant-2');

      // Each decrypts correctly
      expect(await facade.decrypt(enc1, 'tenant-1')).toBe('tenant-1-data');
      expect(await facade.decrypt(enc2, 'tenant-2')).toBe('tenant-2-data');
    });

    it('cross-tenant decrypt is blocked (tenant isolation)', async () => {
      const enc1 = await facade.encrypt('cross-test', scope);

      // Decrypt using tenant-2's tenantId — should fail because
      // unwrapDEK now filters by tenantId, preventing cross-tenant access
      await expect(facade.decrypt(enc1, 'tenant-2')).rejects.toThrow(/DEK not found/);
    });
  });

  // ─── Double Encryption Guard ───────────────────────────────────────

  describe('Double encryption guard', () => {
    it('rejects double encryption', async () => {
      const encrypted = await facade.encrypt('test', scope);
      await expect(facade.encrypt(encrypted, scope)).rejects.toThrow('Double encryption detected');
    });
  });

  // ─── Azure KMS Full Stack ──────────────────────────────────────────

  describe('Azure Key Vault full stack roundtrip', () => {
    beforeEach(async () => {
      // Reconfigure for Azure
      await pool.shutdown();
      _resetKMSRegistryForTesting();
      KMSResolver._resetPlatformDefaultForTesting();

      process.env.KMS_PROVIDER = 'azure-keyvault';
      process.env.KMS_AZURE_VAULT_URL = 'https://e2e-test.vault.azure.net';
      process.env.KMS_AZURE_KEY_NAME = 'e2e-key';
      delete process.env.KMS_AWS_REGION;
      delete process.env.KMS_AWS_KEY_ID;

      pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY, maxSize: 10 });
      await pool.initialize();
      setKMSProviderPool(pool);

      resolver = new KMSResolver();
      dekManager = new DEKManager(resolver);
      facade = new TenantEncryptionFacade(dekManager);
    });

    afterEach(() => {
      delete process.env.KMS_AZURE_VAULT_URL;
      delete process.env.KMS_AZURE_KEY_NAME;
    });

    it('encrypt → decrypt roundtrip through Azure KV', async () => {
      const plaintext = 'azure-secret-data';
      const encrypted = await facade.encrypt(plaintext, scope);
      const decrypted = await facade.decrypt(encrypted, scope.tenantId);
      expect(decrypted).toBe(plaintext);
    });

    it('creates and reuses DEK via Azure provider', async () => {
      await facade.encrypt('first', scope);
      await facade.encrypt('second', scope);
      expect(dekStore.length).toBe(1);
    });
  });

  // ─── GCP Cloud KMS Full Stack ──────────────────────────────────────

  describe('GCP Cloud KMS full stack roundtrip', () => {
    beforeEach(async () => {
      // Reconfigure for GCP
      await pool.shutdown();
      _resetKMSRegistryForTesting();
      KMSResolver._resetPlatformDefaultForTesting();

      process.env.KMS_PROVIDER = 'gcp-cloud-kms';
      process.env.KMS_GCP_PROJECT_ID = 'test-project';
      process.env.KMS_GCP_LOCATION = 'us-central1';
      process.env.KMS_GCP_KEY_RING = 'test-ring';
      process.env.KMS_GCP_KEY_NAME = 'e2e-key';
      delete process.env.KMS_AWS_REGION;
      delete process.env.KMS_AWS_KEY_ID;

      pool = new KMSProviderPool({ masterKeyHex: TEST_MASTER_KEY, maxSize: 10 });
      await pool.initialize();
      setKMSProviderPool(pool);

      resolver = new KMSResolver();
      dekManager = new DEKManager(resolver);
      facade = new TenantEncryptionFacade(dekManager);
    });

    afterEach(() => {
      delete process.env.KMS_GCP_PROJECT_ID;
      delete process.env.KMS_GCP_LOCATION;
      delete process.env.KMS_GCP_KEY_RING;
      delete process.env.KMS_GCP_KEY_NAME;
    });

    it('encrypt → decrypt roundtrip through GCP Cloud KMS', async () => {
      const plaintext = 'gcp-secret-data';
      const encrypted = await facade.encrypt(plaintext, scope);
      const decrypted = await facade.decrypt(encrypted, scope.tenantId);
      expect(decrypted).toBe(plaintext);
    });
  });

  // ─── Backward Compatibility After Provider Switch ──────────────────

  describe('Backward compatibility after provider switch', () => {
    it('local-wrapped DEKs remain decryptable after platform default switches to AWS', async () => {
      await wirePlatformProvider('local');

      const encrypted = await facade.encrypt('local-era-data', scope);
      expect(dekStore).toHaveLength(1);
      expect(dekStore[0].wrappingProvider?.providerType).toBe('local');

      await wirePlatformProvider('aws-kms');
      const decrypted = await facade.decrypt(encrypted, scope.tenantId);
      expect(decrypted).toBe('local-era-data');

      const reusedScopeCiphertext = await facade.encrypt('same-scope-still-local', scope);
      expect(await facade.decrypt(reusedScopeCiphertext, scope.tenantId)).toBe(
        'same-scope-still-local',
      );
      expect(await facade.decrypt(encrypted, scope.tenantId)).toBe('local-era-data');

      const retiredLocalEntry = findDekForScope({
        projectId: scope.projectId,
        environment: scope.environment,
        status: 'decrypt_only',
        providerType: 'local',
      });
      const activeAwsEntry = findDekForScope({
        projectId: scope.projectId,
        environment: scope.environment,
        status: 'active',
        providerType: 'aws-kms',
      });
      expect(retiredLocalEntry).toBeTruthy();
      expect(activeAwsEntry).toBeTruthy();

      const newScope = { tenantId: 'tenant-1', projectId: 'proj-2', environment: 'production' };
      await facade.encrypt('aws-era-data', newScope);

      const awsEntry = findDekForScope({
        projectId: newScope.projectId,
        environment: newScope.environment,
        status: 'active',
        providerType: 'aws-kms',
      });
      expect(awsEntry?.wrappingProvider?.providerType).toBe('aws-kms');
    });

    it('missing wrappingProvider falls back to local after platform default switches', async () => {
      await wirePlatformProvider('local');

      const encrypted = await facade.encrypt('legacy-local-data', scope);
      expect(dekStore).toHaveLength(1);
      dekStore[0].wrappingProvider = null;

      await wirePlatformProvider('aws-kms');
      const decrypted = await facade.decrypt(encrypted, scope.tenantId);
      expect(decrypted).toBe('legacy-local-data');
    });

    it('local-wrapped DEKs migrate cleanly after platform default switches to Azure', async () => {
      await wirePlatformProvider('local');

      const encrypted = await facade.encrypt('local-era-data', scope);
      expect(dekStore).toHaveLength(1);
      expect(dekStore[0].wrappingProvider?.providerType).toBe('local');

      await wirePlatformProvider('azure-keyvault');

      const decrypted = await facade.decrypt(encrypted, scope.tenantId);
      expect(decrypted).toBe('local-era-data');

      const sameScopeCiphertext = await facade.encrypt('still-using-active-local-dek', scope);
      expect(await facade.decrypt(sameScopeCiphertext, scope.tenantId)).toBe(
        'still-using-active-local-dek',
      );
      expect(await facade.decrypt(encrypted, scope.tenantId)).toBe('local-era-data');

      const azureCiphertext = await facade.encrypt('azure-era-data', scope);
      expect(await facade.decrypt(azureCiphertext, scope.tenantId)).toBe('azure-era-data');

      const activeAzureEntry = findDekForScope({
        projectId: scope.projectId,
        environment: scope.environment,
        status: 'active',
        providerType: 'azure-keyvault',
      });
      const retiredLocalEntry = findDekForScope({
        projectId: scope.projectId,
        environment: scope.environment,
        status: 'decrypt_only',
        providerType: 'local',
      });

      expect(activeAzureEntry?.wrappingProvider?.providerType).toBe('azure-keyvault');
      expect(retiredLocalEntry?.wrappingProvider?.providerType).toBe('local');
    });
  });

  // ─── Cache Behavior ────────────────────────────────────────────────

  describe('Cache behavior', () => {
    it('clearCache forces re-unwrap on next decrypt', async () => {
      const encrypted = await facade.encrypt('cached', scope);

      // Clear cache
      facade.clearCache();

      // Decrypt should still work (re-reads from DB, re-unwraps)
      const decrypted = await facade.decrypt(encrypted, scope.tenantId);
      expect(decrypted).toBe('cached');
    });

    it('DEK manager cache size reflects acquired DEKs', async () => {
      expect(dekManager.cacheSize).toBe(0);
      await facade.encrypt('test', scope);
      expect(dekManager.cacheSize).toBe(1);

      const scope2 = { tenantId: 'tenant-2', projectId: 'proj-1', environment: 'prod' };
      await facade.encrypt('test2', scope2);
      expect(dekManager.cacheSize).toBe(2);
    });
  });
});
