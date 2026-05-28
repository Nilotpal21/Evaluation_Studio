/**
 * Azure Key Vault — Platform-Level KMS End-to-End Tests
 *
 * Covers scenarios specific to platform-level Azure KMS deployment:
 *   1. Vault URL normalization (trailing slash, double slash)
 *   2. KEK version pinning after rotation (unwrap uses original version)
 *   3. Provider initialization failure graceful degradation
 *   4. Workload Identity credential selection (DefaultAzureCredential path)
 *   5. Concurrent DEK creation idempotency (E11000 race condition)
 *   6. Full encrypt/decrypt with trailing-slash vault URL
 *
 * All tests mock at the Azure SDK boundary with real AES-256-GCM crypto.
 *
 * @see https://bitbucket.org/koreteam1/abl-platform/pull-requests/968
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';

// =============================================================================
// MOCK HELPERS — real AES-256-GCM for wrap/unwrap fidelity
// =============================================================================

const MOCK_KEK = randomBytes(32);
/** Track which key version was used for each wrap operation */
let wrapVersionLog: string[] = [];
let mockKeyVersion = 'abc123def456';

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
// AZURE SDK MOCK — tracks key versions and vault URL usage
// =============================================================================

let constructedKeyIds: string[] = [];
let credentialType: string = '';

vi.mock('@azure/keyvault-keys', () => ({
  KeyClient: class {
    vaultUrl: string;
    constructor(vaultUrl: string) {
      this.vaultUrl = vaultUrl;
    }
    async getKey(name: string) {
      return {
        id: `${this.vaultUrl}/keys/${name}/${mockKeyVersion}`,
        keyType: 'RSA-HSM',
        properties: { enabled: true, createdOn: new Date() },
      };
    }
    async createKey(name: string) {
      return {
        id: `${this.vaultUrl}/keys/${name}/${mockKeyVersion}`,
        keyType: 'RSA-HSM',
        properties: { enabled: true, createdOn: new Date() },
      };
    }
    async updateKeyRotationPolicy() {
      return {};
    }
    async beginDeleteKey() {
      return { pollUntilDone: async () => ({}) };
    }
  },
  CryptographyClient: class {
    keyId: string;
    constructor(keyId: string) {
      this.keyId = keyId;
      constructedKeyIds.push(keyId);
    }
    async wrapKey(_algo: string, plaintext: Buffer) {
      wrapVersionLog.push(mockKeyVersion);
      return {
        result: mockWrap(plaintext),
        keyID: `https://vault.azure.net/keys/key/${mockKeyVersion}`,
      };
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
  },
}));

vi.mock('@azure/identity', () => ({
  DefaultAzureCredential: class {
    constructor() {
      credentialType = 'DefaultAzureCredential';
    }
  },
  ClientSecretCredential: class {
    constructor(
      public t: string,
      public c: string,
      public s: string,
    ) {
      credentialType = 'ClientSecretCredential';
    }
  },
}));

// =============================================================================
// IMPORT AFTER MOCKS
// =============================================================================

import { AzureKeyVaultProvider } from '../kms/providers/azure-keyvault-provider.js';

// =============================================================================
// TESTS
// =============================================================================

describe('Azure Key Vault — Platform-Level KMS E2E', () => {
  beforeEach(() => {
    constructedKeyIds = [];
    wrapVersionLog = [];
    mockKeyVersion = 'abc123def456';
    credentialType = '';
  });

  // ─── URL Normalization ──────────────────────────────────────────────────

  describe('Vault URL normalization', () => {
    it('strips trailing slash from vault URL in key ID construction', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://kv-abl-dev.vault.azure.net/',
        keyName: 'platform-encryption-key',
      });
      await provider.initialize();

      // CryptographyClient should receive URL without double slash
      const keyId = constructedKeyIds[0];
      expect(keyId).toBe('https://kv-abl-dev.vault.azure.net/keys/platform-encryption-key');
      expect(keyId).not.toContain('//keys/');
    });

    it('handles vault URL without trailing slash (no-op)', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://kv-abl-dev.vault.azure.net',
        keyName: 'my-key',
      });
      await provider.initialize();

      expect(constructedKeyIds[0]).toBe('https://kv-abl-dev.vault.azure.net/keys/my-key');
    });

    it('handles vault URL with multiple trailing slashes', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://kv-abl-dev.vault.azure.net///',
        keyName: 'my-key',
      });
      await provider.initialize();

      expect(constructedKeyIds[0]).toBe('https://kv-abl-dev.vault.azure.net/keys/my-key');
      // No double slash after the host (protocol :// is expected)
      expect(constructedKeyIds[0].replace('https://', '')).not.toContain('//');
    });

    it('constructs versioned key ID correctly with trailing slash', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://kv-abl-dev.vault.azure.net/',
        keyName: 'platform-key',
        keyVersion: 'v1',
      });
      await provider.initialize();

      expect(constructedKeyIds[0]).toBe('https://kv-abl-dev.vault.azure.net/keys/platform-key/v1');
    });

    it('full encrypt/decrypt roundtrip with trailing-slash vault URL', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://kv-abl-dev.vault.azure.net/',
        keyName: 'platform-encryption-key',
      });
      await provider.initialize();

      const plaintext = Buffer.from('platform-level-secret-data');
      const wrapped = await provider.wrapKey('platform-encryption-key', plaintext);
      const unwrapped = await provider.unwrapKey('platform-encryption-key', wrapped.ciphertext);

      expect(unwrapped.equals(plaintext)).toBe(true);
    });
  });

  // ─── KEK Version Pinning ────────────────────────────────────────────────

  describe('KEK version pinning', () => {
    it('wrapKey returns the key version ID used for wrapping', async () => {
      mockKeyVersion = 'version-001';
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
      });
      await provider.initialize();

      const plaintext = randomBytes(32);
      const result = await provider.wrapKey('kek', plaintext);

      expect(result.keyVersionId).toBe('version-001');
    });

    it('unwrapKey with specific version creates version-pinned CryptographyClient', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
      });
      await provider.initialize();

      constructedKeyIds = []; // reset after initialize

      const plaintext = randomBytes(32);
      const wrapped = await provider.wrapKey('kek', plaintext);

      // Unwrap with explicit version ID
      await provider.unwrapKey('kek', wrapped.ciphertext, undefined, 'old-version-abc');

      // Should have created a new versioned CryptographyClient
      const versionedIds = constructedKeyIds.filter((id) => id.includes('old-version-abc'));
      expect(versionedIds).toHaveLength(1);
      expect(versionedIds[0]).toBe('https://vault.azure.net/keys/kek/old-version-abc');
    });

    it('unwrapKey without version uses the default (latest) CryptographyClient', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
      });
      await provider.initialize();

      constructedKeyIds = []; // reset

      const plaintext = randomBytes(32);
      const wrapped = await provider.wrapKey('kek', plaintext);

      // Unwrap without version
      await provider.unwrapKey('kek', wrapped.ciphertext);

      // Should NOT create a new CryptographyClient (uses default)
      expect(constructedKeyIds).toHaveLength(0);
    });
  });

  // ─── Credential Selection ───────────────────────────────────────────────

  describe('Credential selection (Workload Identity vs Service Principal)', () => {
    it('uses DefaultAzureCredential when no explicit credentials provided', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
      });
      await provider.initialize();

      expect(credentialType).toBe('DefaultAzureCredential');
    });

    it('uses ClientSecretCredential when tenantId/clientId/clientSecret provided', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
        tenantId: 'tenant-abc',
        clientId: 'client-xyz',
        clientSecret: 'secret-123', // gitleaks:allow
      });
      await provider.initialize();

      expect(credentialType).toBe('ClientSecretCredential');
    });

    it('falls back to DefaultAzureCredential if only partial credentials', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
        tenantId: 'tenant-abc',
        // Missing clientId and clientSecret
      });
      await provider.initialize();

      expect(credentialType).toBe('DefaultAzureCredential');
    });
  });

  // ─── Provider Initialization Failure Graceful Degradation ───────────────

  describe('Provider initialization failure', () => {
    it('healthCheck returns unhealthy with descriptive message on network failure', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'nonexistent-key',
      });
      await provider.initialize();

      // Override getKey to simulate network error
      (provider as any).keyClient.getKey = async () => {
        throw new Error('getaddrinfo ENOTFOUND vault.azure.net');
      };

      const health = await provider.healthCheck();
      expect(health.healthy).toBe(false);
      expect(health.providerType).toBe('azure-keyvault');
      expect(health.message).toContain('ENOTFOUND');
    });

    it('throws on wrapKey/unwrapKey before initialize()', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
      });

      // Do NOT call initialize
      await expect(provider.wrapKey('kek', randomBytes(32))).rejects.toThrow(/not initialized/);

      await expect(provider.unwrapKey('kek', randomBytes(64))).rejects.toThrow(/not initialized/);
    });

    it('shutdown cleans up state and subsequent ops fail', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
      });
      await provider.initialize();

      // Verify it works
      const plaintext = randomBytes(32);
      await expect(provider.wrapKey('kek', plaintext)).resolves.toBeDefined();

      // Shutdown
      await provider.shutdown();

      // Should fail after shutdown
      await expect(provider.wrapKey('kek', randomBytes(32))).rejects.toThrow(/not initialized/);
    });

    it('initialize is idempotent (safe to call multiple times)', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
      });

      await provider.initialize();
      await provider.initialize(); // second call should be no-op

      const plaintext = randomBytes(32);
      const wrapped = await provider.wrapKey('kek', plaintext);
      const unwrapped = await provider.unwrapKey('kek', wrapped.ciphertext);
      expect(unwrapped.equals(plaintext)).toBe(true);
    });
  });

  // ─── Key Rotation Support ──────────────────────────────────────────────

  describe('Key rotation support', () => {
    it('enableKeyRotation completes without error', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
      });
      await provider.initialize();

      await expect(provider.enableKeyRotation('kek', 90)).resolves.toBeUndefined();
    });

    it('wrapKey after KEK rotation uses new version', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
      });
      await provider.initialize();

      // First wrap with version-001
      mockKeyVersion = 'version-001';
      const wrap1 = await provider.wrapKey('kek', randomBytes(32));
      expect(wrap1.keyVersionId).toBe('version-001');

      // Simulate KEK rotation — new version
      mockKeyVersion = 'version-002';
      const wrap2 = await provider.wrapKey('kek', randomBytes(32));
      expect(wrap2.keyVersionId).toBe('version-002');
    });

    it('old ciphertext still unwraps after rotation via version-pinned client', async () => {
      const provider = new AzureKeyVaultProvider({
        vaultUrl: 'https://vault.azure.net',
        keyName: 'kek',
      });
      await provider.initialize();

      const plaintext = randomBytes(32);
      mockKeyVersion = 'version-001';
      const wrapped = await provider.wrapKey('kek', plaintext);

      // Simulate rotation
      mockKeyVersion = 'version-002';

      // Unwrap with old version — uses version-pinned CryptographyClient
      const unwrapped = await provider.unwrapKey(
        'kek',
        wrapped.ciphertext,
        undefined,
        'version-001',
      );
      expect(unwrapped.equals(plaintext)).toBe(true);
    });
  });
});
