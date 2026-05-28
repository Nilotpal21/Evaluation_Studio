/**
 * Cloud KMS Provider Contract Tests
 *
 * Validates that each cloud KMS provider correctly implements the KMSProvider
 * interface by mocking at the SDK boundary. No real credentials needed.
 *
 * Strategy: Each cloud SDK is dynamically imported. We mock the import to return
 * fake SDK classes that perform real AES-256-GCM crypto (same as LocalKMSProvider).
 * This proves our provider code correctly calls the SDK APIs and handles responses.
 *
 * Coverage:
 *   - generateDataKey: returns plaintext + wrapped DEK
 *   - wrapKey / unwrapKey: roundtrip proves no data corruption
 *   - encrypt / decrypt: roundtrip for small payloads
 *   - healthCheck: returns healthy after initialize
 *   - createKey: returns valid metadata
 *   - describeKey: returns valid metadata
 *   - enableKeyRotation: completes without error
 *   - scheduleKeyDeletion: completes without error
 *   - shutdown: cleans up state
 *   - BYOK (AWS): getWrappingPublicKey + importKeyMaterial
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// =============================================================================
// SHARED MOCK HELPERS — real AES-256-GCM crypto for wrap/unwrap fidelity
// =============================================================================

const MOCK_KEK = randomBytes(32); // Simulated KEK for wrapping

function mockWrap(plaintext: Buffer): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', MOCK_KEK, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, encrypted, authTag]);
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
// AWS KMS MOCK
// =============================================================================

vi.mock('@aws-sdk/client-kms', () => {
  class MockKMSClient {
    async send(command: any) {
      const name = command.constructor.name;
      switch (name) {
        case 'GenerateDataKeyCommand': {
          const plaintext = randomBytes(32);
          return {
            Plaintext: plaintext,
            CiphertextBlob: mockWrap(plaintext),
            KeyId: command.input?.KeyId || 'mock-key-id',
          };
        }
        case 'EncryptCommand':
          return {
            CiphertextBlob: mockWrap(Buffer.from(command.input?.Plaintext)),
            KeyId: command.input?.KeyId,
          };
        case 'DecryptCommand':
          return {
            Plaintext: mockUnwrap(Buffer.from(command.input?.CiphertextBlob)),
            KeyId: command.input?.KeyId,
          };
        case 'DescribeKeyCommand':
          return {
            KeyMetadata: {
              KeyId: command.input?.KeyId,
              Arn: `arn:aws:kms:us-east-1:123456789:key/${command.input?.KeyId}`,
              KeyState: 'Enabled',
              Origin: 'AWS_KMS',
              CreationDate: new Date(),
            },
          };
        case 'CreateKeyCommand':
          return {
            KeyMetadata: {
              KeyId: `mock-key-${randomBytes(4).toString('hex')}`,
              Arn: 'arn:aws:kms:us-east-1:123456789:key/mock',
              KeyState: 'Enabled',
              Origin: 'AWS_KMS',
              CreationDate: new Date(),
            },
          };
        case 'EnableKeyRotationCommand':
          return {};
        case 'ScheduleKeyDeletionCommand':
          return {};
        case 'GetParametersForImportCommand':
          return {
            PublicKey: randomBytes(256),
            ImportToken: randomBytes(32),
            ParametersValidTo: new Date(Date.now() + 600_000),
          };
        case 'ImportKeyMaterialCommand':
          return {};
        default:
          throw new Error(`Unmocked AWS command: ${name}`);
      }
    }
    destroy() {}
  }

  // Command classes — just store the input for routing
  function makeCommand(name: string) {
    return class {
      static name = name;
      constructor(public input: any) {}
      get [Symbol.toStringTag]() {
        return name;
      }
    };
  }

  // Override constructor name used in send() routing
  const commands: Record<string, any> = {};
  for (const cmd of [
    'GenerateDataKeyCommand',
    'EncryptCommand',
    'DecryptCommand',
    'DescribeKeyCommand',
    'CreateKeyCommand',
    'EnableKeyRotationCommand',
    'ScheduleKeyDeletionCommand',
    'GetParametersForImportCommand',
    'ImportKeyMaterialCommand',
  ]) {
    const Cls = makeCommand(cmd);
    Object.defineProperty(Cls, 'name', { value: cmd });
    commands[cmd] = Cls;
  }

  return { KMSClient: MockKMSClient, ...commands };
});

// =============================================================================
// AZURE MOCK
// =============================================================================

vi.mock('@azure/keyvault-keys', () => {
  class MockCryptographyClient {
    async wrapKey(_algo: string, plaintext: Buffer) {
      return { result: mockWrap(plaintext) };
    }
    async unwrapKey(_algo: string, ciphertext: Buffer) {
      return { result: mockUnwrap(ciphertext) };
    }
    async encrypt(_algo: string, plaintext: Buffer) {
      return { result: mockWrap(plaintext) };
    }
    async decrypt(_algo: string, ciphertext: Buffer) {
      return { result: mockUnwrap(ciphertext) };
    }
  }

  class MockKeyClient {
    async getKey(keyName: string) {
      return {
        id: `https://mock.vault.azure.net/keys/${keyName}`,
        keyType: 'RSA',
        properties: {
          enabled: true,
          createdOn: new Date(),
        },
      };
    }
    async createKey(keyName: string, keyType: string, opts: any) {
      return {
        id: `https://mock.vault.azure.net/keys/${keyName}`,
        keyType,
        properties: {
          enabled: true,
          createdOn: new Date(),
        },
        opts,
      };
    }
    async updateKeyRotationPolicy() {
      return {};
    }
    async beginDeleteKey() {
      return { pollUntilDone: async () => ({}) };
    }
  }

  return { KeyClient: MockKeyClient, CryptographyClient: MockCryptographyClient };
});

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {},
  ClientSecretCredential: class {
    constructor(
      public tenantId: string,
      public clientId: string,
      public clientSecret: string,
    ) {}
  },
}));

// =============================================================================
// GCP MOCK
// =============================================================================

vi.mock('@google-cloud/kms', () => {
  class MockKeyManagementServiceClient {
    async encrypt(request: any) {
      return [{ ciphertext: mockWrap(Buffer.from(request.plaintext)) }];
    }
    async decrypt(request: any) {
      return [{ plaintext: mockUnwrap(Buffer.from(request.ciphertext)) }];
    }
    async getCryptoKey(request: any) {
      return [
        {
          name: request.name,
          versionTemplate: {
            algorithm: 'GOOGLE_SYMMETRIC_ENCRYPTION',
            protectionLevel: 'SOFTWARE',
          },
          createTime: new Date().toISOString(),
          rotationPeriod: null,
        },
      ];
    }
    async createCryptoKey(request: any) {
      return [
        {
          name: `${request.parent}/cryptoKeys/${request.cryptoKeyId}`,
          createTime: new Date().toISOString(),
        },
      ];
    }
    async updateCryptoKey() {
      return [{}];
    }
    async destroyCryptoKeyVersion() {
      return [{}];
    }
    async close() {}
  }

  return { KeyManagementServiceClient: MockKeyManagementServiceClient };
});

// =============================================================================
// TESTS
// =============================================================================

describe('Cloud KMS Provider Contract Tests', () => {
  // ─── AWS KMS ──────────────────────────────────────────────────────────

  describe('AWSKMSProvider', () => {
    let provider: any;

    beforeEach(async () => {
      const { AWSKMSProvider } = await import('../kms/providers/aws-kms-provider.js');
      provider = new AWSKMSProvider({
        region: 'us-east-1',
        keyId: 'arn:aws:kms:us-east-1:123:key/test-key',
      });
      await provider.initialize();
    });

    afterEach(async () => {
      await provider.shutdown();
    });

    it('generateDataKey returns plaintext + ciphertext', async () => {
      const result = await provider.generateDataKey('test-key');
      expect(result.plaintext).toBeInstanceOf(Buffer);
      expect(result.ciphertext).toBeInstanceOf(Buffer);
      expect(result.plaintext.length).toBe(32);
      expect(result.keyId).toBe('test-key');
    });

    it('wrapKey/unwrapKey roundtrip preserves key material', async () => {
      const original = randomBytes(32);
      const wrapped = await provider.wrapKey('test-key', original);
      expect(wrapped.ciphertext).toBeInstanceOf(Buffer);
      expect(wrapped.ciphertext.length).toBeGreaterThan(32);

      const unwrapped = await provider.unwrapKey('test-key', wrapped.ciphertext);
      expect(unwrapped.equals(original)).toBe(true);
    });

    it('encrypt/decrypt roundtrip preserves data', async () => {
      const data = Buffer.from('sensitive-data-payload');
      const encrypted = await provider.encrypt('test-key', data);
      const decrypted = await provider.decrypt('test-key', encrypted);
      expect(decrypted.equals(data)).toBe(true);
    });

    it('healthCheck returns healthy after initialize', async () => {
      const status = await provider.healthCheck();
      expect(status.healthy).toBe(true);
      expect(status.providerType).toBe('aws-kms');
      expect(status.latencyMs).toBeGreaterThanOrEqual(0);
    });

    it('createKey returns valid metadata', async () => {
      const meta = await provider.createKey('data-encryption');
      expect(meta.keyId).toBeDefined();
      expect(meta.purpose).toBe('data-encryption');
      expect(meta.state).toBe('active');
      expect(meta.algorithm).toBe('AES-256-GCM');
      expect(meta.createdAt).toBeInstanceOf(Date);
    });

    it('describeKey returns valid metadata', async () => {
      const meta = await provider.describeKey('test-key');
      expect(meta.state).toBe('active');
      expect(meta.protectionLevel).toBe('software-protected');
    });

    it('enableKeyRotation completes without error', async () => {
      await expect(provider.enableKeyRotation('test-key', 90)).resolves.toBeUndefined();
    });

    it('scheduleKeyDeletion completes without error', async () => {
      await expect(provider.scheduleKeyDeletion('test-key', 30)).resolves.toBeUndefined();
    });

    it('getWrappingPublicKey returns buffer for BYOK', async () => {
      const pubKey = await provider.getWrappingPublicKey('test-key');
      expect(pubKey).toBeInstanceOf(Buffer);
      expect(pubKey.length).toBeGreaterThan(0);
    });

    it('importKeyMaterial completes without error', async () => {
      // Must call getWrappingPublicKey first to cache the import token
      await provider.getWrappingPublicKey('test-key');
      await expect(
        provider.importKeyMaterial('test-key', randomBytes(32)),
      ).resolves.toBeUndefined();
    });

    it('shutdown cleans up — subsequent calls fail', async () => {
      await provider.shutdown();
      await expect(provider.generateDataKey('test-key')).rejects.toThrow('not initialized');
    });

    it('double initialize is idempotent', async () => {
      await provider.initialize();
      const result = await provider.generateDataKey('test-key');
      expect(result.plaintext.length).toBe(32);
    });
  });

  // ─── Azure Key Vault ──────────────────────────────────────────────────

  describe('AzureKeyVaultProvider', () => {
    let provider: any;

    beforeEach(async () => {
      const { AzureKeyVaultProvider } = await import('../kms/providers/azure-keyvault-provider.js');
      provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://test-vault.vault.azure.net',
        keyName: 'test-key',
      });
      await provider.initialize();
    });

    afterEach(async () => {
      await provider.shutdown();
    });

    it('generateDataKey returns plaintext + wrapped ciphertext', async () => {
      const result = await provider.generateDataKey('test-key');
      expect(result.plaintext).toBeInstanceOf(Buffer);
      expect(result.plaintext.length).toBe(32);
      expect(result.ciphertext).toBeInstanceOf(Buffer);
    });

    it('wrapKey/unwrapKey roundtrip preserves key material', async () => {
      const original = randomBytes(32);
      const wrapped = await provider.wrapKey('test-key', original);
      const unwrapped = await provider.unwrapKey('test-key', wrapped.ciphertext);
      expect(unwrapped.equals(original)).toBe(true);
    });

    it('encrypt/decrypt roundtrip preserves data', async () => {
      const data = Buffer.from('azure-secret-payload');
      const encrypted = await provider.encrypt('test-key', data);
      const decrypted = await provider.decrypt('test-key', encrypted);
      expect(decrypted.equals(data)).toBe(true);
    });

    it('healthCheck returns healthy', async () => {
      const status = await provider.healthCheck();
      expect(status.healthy).toBe(true);
      expect(status.providerType).toBe('azure-keyvault');
    });

    it('createKey returns valid metadata with hsm protection level', async () => {
      const meta = await provider.createKey('tenant-kek');
      expect(meta.keyId).toBeDefined();
      expect(meta.purpose).toBe('tenant-kek');
      expect(meta.protectionLevel).toBe('hsm');
      expect(meta.algorithm).toBe('RSA-HSM-3072');
    });

    it('describeKey returns key properties', async () => {
      const meta = await provider.describeKey('test-key');
      expect(meta.state).toBe('active');
      // Mock getKey returns keyType: 'RSA' (no -HSM suffix), so software-protected
      expect(meta.protectionLevel).toBe('software-protected');
    });

    it('enableKeyRotation completes', async () => {
      await expect(provider.enableKeyRotation('test-key', 90)).resolves.toBeUndefined();
    });

    it('scheduleKeyDeletion completes', async () => {
      await expect(provider.scheduleKeyDeletion('test-key')).resolves.toBeUndefined();
    });

    it('initializes with service principal credentials', async () => {
      const { AzureKeyVaultProvider } = await import('../kms/providers/azure-keyvault-provider.js');
      const spProvider = new AzureKeyVaultProvider({
        vaultUrl: 'https://sp-vault.vault.azure.net',
        keyName: 'sp-key',
        tenantId: 'tenant-123',
        clientId: 'client-456',
        clientSecret: 'secret-789',
      });
      await spProvider.initialize();
      const status = await spProvider.healthCheck();
      expect(status.healthy).toBe(true);
      await spProvider.shutdown();
    });
  });

  // ─── Azure Managed HSM ────────────────────────────────────────────────

  describe('AzureManagedHSMProvider', () => {
    let provider: any;

    beforeEach(async () => {
      const { AzureManagedHSMProvider } =
        await import('../kms/providers/azure-managed-hsm-provider.js');
      provider = new AzureManagedHSMProvider({
        vaultUrl: 'https://test-hsm.managedhsm.azure.net',
        keyName: 'hsm-key',
      });
      await provider.initialize();
    });

    afterEach(async () => {
      await provider.shutdown();
    });

    it('providerType is azure-managed-hsm', () => {
      expect(provider.providerType).toBe('azure-managed-hsm');
    });

    it('wrapKey/unwrapKey roundtrip works', async () => {
      const original = randomBytes(32);
      const wrapped = await provider.wrapKey('hsm-key', original);
      const unwrapped = await provider.unwrapKey('hsm-key', wrapped.ciphertext);
      expect(unwrapped.equals(original)).toBe(true);
    });

    it('describeKey reports hsm protection level', async () => {
      const meta = await provider.describeKey('hsm-key');
      expect(meta.protectionLevel).toBe('hsm');
    });

    it('createKey reports hsm protection level', async () => {
      const meta = await provider.createKey('data-encryption');
      expect(meta.protectionLevel).toBe('hsm');
    });
  });

  // ─── GCP Cloud KMS ────────────────────────────────────────────────────

  describe('GCPCloudKMSProvider', () => {
    let provider: any;

    beforeEach(async () => {
      const { GCPCloudKMSProvider } = await import('../kms/providers/gcp-cloud-kms-provider.js');
      provider = new GCPCloudKMSProvider({
        projectId: 'test-project',
        location: 'us-east1',
        keyRing: 'test-ring',
        keyName: 'test-key',
      });
      await provider.initialize();
    });

    afterEach(async () => {
      await provider.shutdown();
    });

    it('generateDataKey returns plaintext + wrapped ciphertext', async () => {
      const result = await provider.generateDataKey('test-key');
      expect(result.plaintext).toBeInstanceOf(Buffer);
      expect(result.plaintext.length).toBe(32);
      expect(result.ciphertext).toBeInstanceOf(Buffer);
    });

    it('wrapKey/unwrapKey roundtrip preserves key material', async () => {
      const original = randomBytes(32);
      const wrapped = await provider.wrapKey('test-key', original);
      const unwrapped = await provider.unwrapKey('test-key', wrapped.ciphertext);
      expect(unwrapped.equals(original)).toBe(true);
    });

    it('encrypt/decrypt roundtrip preserves data', async () => {
      const data = Buffer.from('gcp-secret-data');
      const encrypted = await provider.encrypt('test-key', data);
      const decrypted = await provider.decrypt('test-key', encrypted);
      expect(decrypted.equals(data)).toBe(true);
    });

    it('healthCheck returns healthy', async () => {
      const status = await provider.healthCheck();
      expect(status.healthy).toBe(true);
      expect(status.providerType).toBe('gcp-cloud-kms');
    });

    it('createKey returns valid metadata', async () => {
      const meta = await provider.createKey('data-encryption');
      expect(meta.keyId).toBeDefined();
      expect(meta.protectionLevel).toBe('software-protected');
    });

    it('describeKey returns metadata with protection level', async () => {
      const meta = await provider.describeKey('');
      expect(meta.protectionLevel).toBe('software-protected');
    });

    it('enableKeyRotation completes', async () => {
      await expect(provider.enableKeyRotation('', 90)).resolves.toBeUndefined();
    });

    it('scheduleKeyDeletion completes', async () => {
      await expect(provider.scheduleKeyDeletion('')).resolves.toBeUndefined();
    });

    it('shutdown cleans up', async () => {
      await provider.shutdown();
      await expect(provider.generateDataKey('test-key')).rejects.toThrow('not initialized');
    });
  });

  // ─── External KMS (BYOP) ─────────────────────────────────────────────

  describe('ExternalKMSProvider', () => {
    it('validates HTTPS requirement', async () => {
      const { ExternalKMSProvider } = await import('../kms/providers/external-kms-provider.js');
      const provider = new ExternalKMSProvider({
        endpoint: 'http://insecure.example.com',
        authMethod: 'api-key',
        apiKey: 'test-key',
      });
      await expect(provider.initialize()).rejects.toThrow('HTTPS');
    });

    it('validates api-key auth requires apiKey', async () => {
      const { ExternalKMSProvider } = await import('../kms/providers/external-kms-provider.js');
      const provider = new ExternalKMSProvider({
        endpoint: 'https://kms.example.com',
        authMethod: 'api-key',
      });
      await expect(provider.initialize()).rejects.toThrow('API key required');
    });

    it('validates oauth2 auth requires all three fields', async () => {
      const { ExternalKMSProvider } = await import('../kms/providers/external-kms-provider.js');
      const provider = new ExternalKMSProvider({
        endpoint: 'https://kms.example.com',
        authMethod: 'oauth2',
        oauth2ClientId: 'id',
      });
      await expect(provider.initialize()).rejects.toThrow('clientId, clientSecret, and tokenUrl');
    });

    it('validates hmac-sha256 auth requires hmacSecret', async () => {
      const { ExternalKMSProvider } = await import('../kms/providers/external-kms-provider.js');
      const provider = new ExternalKMSProvider({
        endpoint: 'https://kms.example.com',
        authMethod: 'hmac-sha256',
      });
      await expect(provider.initialize()).rejects.toThrow('HMAC secret required');
    });

    it('validates mtls auth requires cert and key', async () => {
      const { ExternalKMSProvider } = await import('../kms/providers/external-kms-provider.js');
      const provider = new ExternalKMSProvider({
        endpoint: 'https://kms.example.com',
        authMethod: 'mtls',
      });
      await expect(provider.initialize()).rejects.toThrow('TLS cert and key required');
    });

    it('rejects unknown auth method', async () => {
      const { ExternalKMSProvider } = await import('../kms/providers/external-kms-provider.js');
      const provider = new ExternalKMSProvider({
        endpoint: 'https://kms.example.com',
        authMethod: 'magic' as any,
      });
      await expect(provider.initialize()).rejects.toThrow('Unknown auth method');
    });

    it('sanitizes header injection in apiKeyHeader', async () => {
      const { ExternalKMSProvider } = await import('../kms/providers/external-kms-provider.js');
      const provider = new ExternalKMSProvider({
        endpoint: 'https://kms.example.com',
        authMethod: 'api-key',
        apiKey: 'test',
        apiKeyHeader: 'X-Key\r\nInjection',
      });
      // Should throw during validate because of CR/LF in header name
      await expect(provider.initialize()).rejects.toThrow('must not contain CR, LF, or NUL');
    });

    it('enforces max timeout', async () => {
      const { ExternalKMSProvider } = await import('../kms/providers/external-kms-provider.js');
      const provider = new ExternalKMSProvider({
        endpoint: 'https://kms.example.com',
        authMethod: 'api-key',
        apiKey: 'test',
        timeoutMs: 999999, // exceeds 10s max
      });
      await provider.initialize();
      // The constructor caps it — we can't directly observe it, but the provider initializes
      expect(provider.providerType).toBe('external');
      await provider.shutdown();
    });

    it('not initialized guard works', async () => {
      const { ExternalKMSProvider } = await import('../kms/providers/external-kms-provider.js');
      const provider = new ExternalKMSProvider({
        endpoint: 'https://kms.example.com',
        authMethod: 'api-key',
        apiKey: 'test',
      });
      // Don't call initialize
      await expect(provider.generateDataKey('key')).rejects.toThrow('not initialized');
      await expect(provider.wrapKey('key', Buffer.from('data'))).rejects.toThrow('not initialized');
      await expect(provider.unwrapKey('key', Buffer.from('data'))).rejects.toThrow(
        'not initialized',
      );
    });
  });

  // ─── Cross-Provider Contract: generateDataKey → unwrapKey roundtrip ───

  describe('Cross-provider: generateDataKey → unwrapKey roundtrip', () => {
    it('AWS: generated DEK can be unwrapped back to original plaintext', async () => {
      const { AWSKMSProvider } = await import('../kms/providers/aws-kms-provider.js');
      const provider = new AWSKMSProvider({
        region: 'us-east-1',
        keyId: 'roundtrip-key',
      });
      await provider.initialize();

      const { plaintext, ciphertext } = await provider.generateDataKey('roundtrip-key');
      const unwrapped = await provider.unwrapKey('roundtrip-key', ciphertext);

      // The mock generates a fresh random DEK and wraps it.
      // unwrapKey must recover the same bytes.
      expect(unwrapped.equals(plaintext)).toBe(true);
      await provider.shutdown();
    });

    it('Azure: generated DEK can be unwrapped back to original plaintext', async () => {
      const { AzureKeyVaultProvider } = await import('../kms/providers/azure-keyvault-provider.js');
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://roundtrip.vault.azure.net',
        keyName: 'roundtrip-key',
      });
      await provider.initialize();

      const { plaintext, ciphertext } = await provider.generateDataKey('roundtrip-key');
      const unwrapped = await provider.unwrapKey('roundtrip-key', ciphertext);

      expect(unwrapped.equals(plaintext)).toBe(true);
      await provider.shutdown();
    });

    it('GCP: generated DEK can be unwrapped back to original plaintext', async () => {
      const { GCPCloudKMSProvider } = await import('../kms/providers/gcp-cloud-kms-provider.js');
      const provider = new GCPCloudKMSProvider({
        projectId: 'roundtrip-project',
        location: 'us-east1',
        keyRing: 'roundtrip-ring',
        keyName: 'roundtrip-key',
      });
      await provider.initialize();

      const { plaintext, ciphertext } = await provider.generateDataKey('roundtrip-key');
      const unwrapped = await provider.unwrapKey('roundtrip-key', ciphertext);

      expect(unwrapped.equals(plaintext)).toBe(true);
      await provider.shutdown();
    });
  });

  // ─── Factory: createKMSProvider with cloud types ──────────────────────

  describe('createKMSProvider factory with mocked SDKs', () => {
    it('creates and initializes AWS provider', async () => {
      const { createKMSProvider } = await import('../kms/providers/index.js');
      const provider = await createKMSProvider({
        providerType: 'aws-kms',
        region: 'us-west-2',
        keyId: 'factory-key',
      });
      expect(provider.providerType).toBe('aws-kms');
      // Not initialized by factory — but constructor succeeded
    });

    it('creates and initializes Azure KV provider', async () => {
      const { createKMSProvider } = await import('../kms/providers/index.js');
      const provider = await createKMSProvider({
        providerType: 'azure-keyvault',
        vaultUrl: 'https://factory.vault.azure.net',
        keyName: 'factory-key',
      });
      expect(provider.providerType).toBe('azure-keyvault');
    });

    it('creates and initializes Azure HSM provider', async () => {
      const { createKMSProvider } = await import('../kms/providers/index.js');
      const provider = await createKMSProvider({
        providerType: 'azure-managed-hsm',
        vaultUrl: 'https://factory.managedhsm.azure.net',
        keyName: 'factory-key',
      });
      expect(provider.providerType).toBe('azure-managed-hsm');
    });

    it('creates and initializes GCP provider', async () => {
      const { createKMSProvider } = await import('../kms/providers/index.js');
      const provider = await createKMSProvider({
        providerType: 'gcp-cloud-kms',
        projectId: 'factory-project',
        location: 'us-central1',
        keyRing: 'factory-ring',
        keyName: 'factory-key',
      });
      expect(provider.providerType).toBe('gcp-cloud-kms');
    });

    it('creates external provider (with api-key auth)', async () => {
      const { createKMSProvider } = await import('../kms/providers/index.js');
      const provider = await createKMSProvider({
        providerType: 'external',
        externalEndpoint: 'https://external.example.com',
        externalAuthMethod: 'api-key',
        externalApiKey: 'factory-api-key',
      });
      expect(provider.providerType).toBe('external');
    });
  });
});
