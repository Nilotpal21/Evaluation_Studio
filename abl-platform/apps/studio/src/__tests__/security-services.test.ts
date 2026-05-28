/**
 * Security Services Tests
 *
 * Tests for:
 * - encryption-service (AES-256-GCM encrypt/decrypt, tenant-scoped, JSON helpers)
 * - key-rotation-service (key versioning, rotation policy, API key expiry)
 * - secret-masking-service (pattern detection, masking strategies, object walking)
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import crypto from 'crypto';

// Mock @/config for encryption-service
vi.mock('@/config', () => ({
  getConfig: () => ({
    encryption: { masterKey: undefined },
  }),
  isConfigLoaded: () => false,
}));

// =============================================================================
// ENCRYPTION SERVICE TESTS
// =============================================================================

describe('EncryptionService', () => {
  // Generate a consistent test master key
  const testMasterKey = crypto.randomBytes(32).toString('hex');
  let EncryptionService: typeof import('@agent-platform/shared/encryption').EncryptionService;
  let generateMasterKey: typeof import('@agent-platform/shared/encryption').generateMasterKey;
  let setGlobalEncryptionFacade: typeof import('@agent-platform/shared/encryption').setGlobalEncryptionFacade;
  let clearGlobalEncryptionFacade: typeof import('@agent-platform/shared/encryption').clearGlobalEncryptionFacade;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('@agent-platform/shared/encryption');
    EncryptionService = mod.EncryptionService;
    generateMasterKey = mod.generateMasterKey;
    setGlobalEncryptionFacade = mod.setGlobalEncryptionFacade;
    clearGlobalEncryptionFacade = mod.clearGlobalEncryptionFacade;
    clearGlobalEncryptionFacade();
  });

  describe('constructor', () => {
    test('initializes with valid 64-char hex key', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      expect(service).toBeDefined();
    });

    test('throws with short key', () => {
      expect(() => new EncryptionService({ masterKeyHex: 'short-key' })).toThrow(
        'ENCRYPTION_MASTER_KEY must be a 32-byte hex string (64 characters)',
      );
    });

    test('throws with empty key', () => {
      expect(() => new EncryptionService({ masterKeyHex: '' })).toThrow(
        'ENCRYPTION_MASTER_KEY must be a 32-byte hex string (64 characters)',
      );
    });
  });

  describe('encrypt / decrypt', () => {
    test('round-trips plaintext correctly', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      const plaintext = 'Hello, World! This is a secret message.';
      const userId = 'user-1';

      const encrypted = service.encrypt(plaintext, userId);
      const decrypted = service.decrypt(encrypted, userId);

      expect(decrypted).toBe(plaintext);
    });

    test('encrypted format is iv:authTag:ciphertext', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      const encrypted = service.encrypt('test', 'user-1');

      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);
      // IV should be 24 hex chars (12 bytes — NIST SP 800-38D recommended for AES-GCM)
      expect(parts[0].length).toBe(24);
      // Auth tag should be 32 hex chars (16 bytes)
      expect(parts[1].length).toBe(32);
      // Ciphertext should be non-empty hex
      expect(parts[2].length).toBeGreaterThan(0);
    });

    test('produces different ciphertext for same plaintext (random IV)', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      const encrypted1 = service.encrypt('same-text', 'user-1');
      const encrypted2 = service.encrypt('same-text', 'user-1');

      // Different IVs means different output
      expect(encrypted1).not.toBe(encrypted2);

      // Both should decrypt to same value
      expect(service.decrypt(encrypted1, 'user-1')).toBe('same-text');
      expect(service.decrypt(encrypted2, 'user-1')).toBe('same-text');
    });

    test('different users cannot decrypt each other data', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      const encrypted = service.encrypt('secret', 'user-1');

      expect(() => service.decrypt(encrypted, 'user-2')).toThrow();
    });

    test('rejects invalid encrypted data format', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });

      expect(() => service.decrypt('not-valid-format', 'user-1')).toThrow(
        'Invalid encrypted data format',
      );
      expect(() => service.decrypt('only:two', 'user-1')).toThrow('Invalid encrypted data format');
    });

    test('rejects tampered ciphertext', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      const encrypted = service.encrypt('secret', 'user-1');

      const parts = encrypted.split(':');
      // Tamper with the ciphertext
      parts[2] = '0000' + parts[2].slice(4);
      const tampered = parts.join(':');

      expect(() => service.decrypt(tampered, 'user-1')).toThrow();
    });

    test('handles empty string', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      const encrypted = service.encrypt('', 'user-1');
      const decrypted = service.decrypt(encrypted, 'user-1');
      expect(decrypted).toBe('');
    });

    test('handles unicode characters', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      const plaintext = 'Unicode test: \u00E9\u00E8\u00EA \u4F60\u597D \uD83D\uDE00';
      const encrypted = service.encrypt(plaintext, 'user-1');
      const decrypted = service.decrypt(encrypted, 'user-1');
      expect(decrypted).toBe(plaintext);
    });

    test('handles long plaintext', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      const plaintext = 'A'.repeat(10000);
      const encrypted = service.encrypt(plaintext, 'user-1');
      const decrypted = service.decrypt(encrypted, 'user-1');
      expect(decrypted).toBe(plaintext);
    });
  });

  describe('tenant-scoped encryption', () => {
    beforeEach(() => {
      setGlobalEncryptionFacade({
        encryptSync: (plaintext: string, scope: { tenantId: string }) =>
          `tenant-sync:${scope.tenantId}:${Buffer.from(plaintext, 'utf8').toString('base64')}`,
        decryptSync: (encryptedData: string, tenantId?: string) => {
          const [prefix, boundTenantId, encoded] = encryptedData.split(':');
          if (prefix !== 'tenant-sync' || !boundTenantId || !encoded) return null;
          if (tenantId !== boundTenantId) return null;
          return Buffer.from(encoded, 'base64').toString('utf8');
        },
      } as unknown as import('@agent-platform/shared/encryption').TenantEncryptionFacade);
    });

    afterEach(() => {
      clearGlobalEncryptionFacade();
    });

    test('encryptForTenant / decryptForTenant round-trips', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      const plaintext = 'tenant-secret-data';

      const encrypted = service.encryptForTenant(plaintext, 'tenant-1');
      const decrypted = service.decryptForTenant(encrypted, 'tenant-1');

      expect(decrypted).toBe(plaintext);
    });

    test('different tenants cannot decrypt each other data', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      const encrypted = service.encryptForTenant('secret', 'tenant-1');

      expect(() => service.decryptForTenant(encrypted, 'tenant-2')).toThrow();
    });

    test('tenant encryption uses different key from user encryption', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });
      const encrypted = service.encrypt('data', 'tenant-1');

      // Should not be decryptable as tenant data
      expect(() => service.decryptForTenant(encrypted, 'tenant-1')).toThrow();
    });

    test('rejects invalid format for tenant decryption', () => {
      const service = new EncryptionService({
        masterKeyHex: testMasterKey,
      });

      expect(() => service.decryptForTenant('bad-format', 'tenant-1')).toThrow(
        'Unsupported tenant ciphertext format',
      );
    });
  });

  describe('generateMasterKey', () => {
    test('returns a 64-character hex string', () => {
      const key = generateMasterKey();
      expect(key).toMatch(/^[0-9a-f]{64}$/);
    });

    test('generates unique keys', () => {
      const keys = new Set<string>();
      for (let i = 0; i < 10; i++) {
        keys.add(generateMasterKey());
      }
      expect(keys.size).toBe(10);
    });

    test('generated key is valid for EncryptionService', () => {
      const key = generateMasterKey();
      const service = new EncryptionService({ masterKeyHex: key });
      const encrypted = service.encrypt('test', 'user-1');
      expect(service.decrypt(encrypted, 'user-1')).toBe('test');
    });
  });
});

// =============================================================================
// KEY ROTATION SERVICE TESTS
// =============================================================================

describe('KeyRotationService', () => {
  let KeyRotationService: typeof import('../services/security/key-rotation-service').KeyRotationService;
  let InMemoryKeyStore: typeof import('../services/security/key-rotation-service').InMemoryKeyStore;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../services/security/key-rotation-service');
    KeyRotationService = mod.KeyRotationService;
    InMemoryKeyStore = mod.InMemoryKeyStore;
  });

  describe('InMemoryKeyStore', () => {
    test('starts empty', async () => {
      const store = new InMemoryKeyStore();
      const active = await store.getActiveKeyVersion();
      expect(active).toBeNull();
    });

    test('saves and retrieves key version', async () => {
      const store = new InMemoryKeyStore();
      const key = {
        id: 'key-1',
        version: 1,
        status: 'active' as const,
        algorithm: 'AES-256-GCM',
        createdAt: new Date(),
      };

      await store.saveKeyVersion(key);

      const active = await store.getActiveKeyVersion();
      expect(active).not.toBeNull();
      expect(active!.version).toBe(1);
    });

    test('getKeyVersion returns specific version', async () => {
      const store = new InMemoryKeyStore();
      await store.saveKeyVersion({
        id: 'key-1',
        version: 1,
        status: 'active',
        algorithm: 'AES-256-GCM',
        createdAt: new Date(),
      });
      await store.saveKeyVersion({
        id: 'key-2',
        version: 2,
        status: 'decrypt_only',
        algorithm: 'AES-256-GCM',
        createdAt: new Date(),
      });

      const v1 = await store.getKeyVersion(1);
      const v2 = await store.getKeyVersion(2);
      const v3 = await store.getKeyVersion(3);

      expect(v1!.id).toBe('key-1');
      expect(v2!.id).toBe('key-2');
      expect(v3).toBeNull();
    });

    test('listKeyVersions returns sorted by version descending', async () => {
      const store = new InMemoryKeyStore();
      await store.saveKeyVersion({
        id: 'key-1',
        version: 1,
        status: 'decrypt_only',
        algorithm: 'AES-256-GCM',
        createdAt: new Date(),
      });
      await store.saveKeyVersion({
        id: 'key-2',
        version: 2,
        status: 'active',
        algorithm: 'AES-256-GCM',
        createdAt: new Date(),
      });

      const versions = await store.listKeyVersions();
      expect(versions[0].version).toBe(2);
      expect(versions[1].version).toBe(1);
    });

    test('updateKeyVersionStatus updates status correctly', async () => {
      const store = new InMemoryKeyStore();
      await store.saveKeyVersion({
        id: 'key-1',
        version: 1,
        status: 'active',
        algorithm: 'AES-256-GCM',
        createdAt: new Date(),
      });

      await store.updateKeyVersionStatus(1, 'decrypt_only');

      const key = await store.getKeyVersion(1);
      expect(key!.status).toBe('decrypt_only');
      expect(key!.rotatedAt).toBeDefined();
    });

    test('updateKeyVersionStatus sets destroyedAt for destroyed status', async () => {
      const store = new InMemoryKeyStore();
      await store.saveKeyVersion({
        id: 'key-1',
        version: 1,
        status: 'decrypt_only',
        algorithm: 'AES-256-GCM',
        createdAt: new Date(),
      });

      await store.updateKeyVersionStatus(1, 'destroyed');

      const key = await store.getKeyVersion(1);
      expect(key!.status).toBe('destroyed');
      expect(key!.destroyedAt).toBeDefined();
    });

    test('clear removes all versions', async () => {
      const store = new InMemoryKeyStore();
      await store.saveKeyVersion({
        id: 'key-1',
        version: 1,
        status: 'active',
        algorithm: 'AES-256-GCM',
        createdAt: new Date(),
      });

      store.clear();

      const versions = await store.listKeyVersions();
      expect(versions).toHaveLength(0);
    });
  });

  describe('initialize', () => {
    test('creates first key version', async () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);

      const key = await service.initialize();

      expect(key.version).toBe(1);
      expect(key.status).toBe('active');
      expect(key.algorithm).toBe('AES-256-GCM');
    });

    test('returns existing active key on second call', async () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);

      const first = await service.initialize();
      const second = await service.initialize();

      expect(first.id).toBe(second.id);
      expect(first.version).toBe(second.version);
    });
  });

  describe('rotateMasterKey', () => {
    test('creates new key version and marks old as decrypt_only', async () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);
      await service.initialize();

      const { oldVersion, newVersion } = await service.rotateMasterKey();

      expect(oldVersion).toBe(1);
      expect(newVersion).toBe(2);

      const versions = await service.listVersions();
      expect(versions).toHaveLength(2);
      expect(versions[0].status).toBe('active');
      expect(versions[1].status).toBe('decrypt_only');
    });

    test('initializes if no active key exists', async () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);

      const { oldVersion, newVersion } = await service.rotateMasterKey();

      expect(oldVersion).toBe(0);
      expect(newVersion).toBe(1);
    });

    test('supports multiple rotations', async () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);
      await service.initialize();

      await service.rotateMasterKey(); // v1->v2
      const { newVersion } = await service.rotateMasterKey(); // v2->v3

      expect(newVersion).toBe(3);

      const versions = await service.listVersions();
      expect(versions).toHaveLength(3);
      expect(versions.filter((v) => v.status === 'active')).toHaveLength(1);
    });
  });

  describe('destroyKeyVersion', () => {
    test('destroys decrypt-only key', async () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);
      await service.initialize();
      await service.rotateMasterKey();

      await service.destroyKeyVersion(1);

      const versions = await service.listVersions();
      const destroyed = versions.find((v) => v.version === 1);
      expect(destroyed!.status).toBe('destroyed');
    });

    test('throws when destroying active key', async () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);
      await service.initialize();

      await service
        .destroyKeyVersion(1)
        .then(() => {
          throw new Error('Expected destroyKeyVersion to reject');
        })
        .catch((error: unknown) => {
          expect(error instanceof Error ? error.message : String(error)).toContain(
            'Cannot destroy active key version',
          );
        });
    });

    test('throws for non-existent key version', async () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);

      await service
        .destroyKeyVersion(99)
        .then(() => {
          throw new Error('Expected destroyKeyVersion to reject');
        })
        .catch((error: unknown) => {
          expect(error instanceof Error ? error.message : String(error)).toContain(
            'Key version 99 not found',
          );
        });
    });
  });

  describe('isRotationDue', () => {
    test('returns true when no key exists', async () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);

      const due = await service.isRotationDue();
      expect(due).toBe(true);
    });

    test('returns false for fresh key with default policy', async () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);
      await service.initialize();

      const due = await service.isRotationDue();
      expect(due).toBe(false);
    });

    test('returns true for old key with zero-day rotation policy', async () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store, { masterKeyRotationDays: 0 });
      await service.initialize();

      // Wait briefly
      await new Promise((r) => setTimeout(r, 10));

      const due = await service.isRotationDue();
      expect(due).toBe(true);
    });
  });

  describe('isApiKeyExpired', () => {
    test('returns expired for key past max age (365 days)', () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);

      const created = new Date(Date.now() - 400 * 24 * 60 * 60 * 1000);
      const result = service.isApiKeyExpired(created);

      expect(result.expired).toBe(true);
      expect(result.warningDays).toBe(0);
    });

    test('returns expired for explicitly expired key', () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);

      const created = new Date();
      const expiresAt = new Date(Date.now() - 1000);
      const result = service.isApiKeyExpired(created, expiresAt);

      expect(result.expired).toBe(true);
    });

    test('returns warning for key expiring within 30 days', () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);

      // 340 days old (25 days until 365-day max)
      const created = new Date(Date.now() - 340 * 24 * 60 * 60 * 1000);
      const result = service.isApiKeyExpired(created);

      expect(result.expired).toBe(false);
      expect(result.warningDays).toBeGreaterThan(0);
      expect(result.warningDays).toBeLessThanOrEqual(30);
    });

    test('returns safe for fresh key (-1 warning days)', () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);

      const result = service.isApiKeyExpired(new Date());

      expect(result.expired).toBe(false);
      expect(result.warningDays).toBe(-1);
    });

    test('custom policy changes max age', () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store, { apiKeyMaxAgeDays: 30 });

      // 35 days old
      const created = new Date(Date.now() - 35 * 24 * 60 * 60 * 1000);
      const result = service.isApiKeyExpired(created);

      expect(result.expired).toBe(true);
    });
  });

  describe('getPolicy', () => {
    test('returns default policy', () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);

      const policy = service.getPolicy();

      expect(policy.masterKeyRotationDays).toBe(90);
      expect(policy.tenantKeyRotationDays).toBe(180);
      expect(policy.apiKeyMaxAgeDays).toBe(365);
      expect(policy.apiKeyGracePeriodHours).toBe(24);
      expect(policy.oauthRefreshBufferSeconds).toBe(300);
    });

    test('returns custom policy when overridden', () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store, {
        masterKeyRotationDays: 30,
        apiKeyMaxAgeDays: 90,
      });

      const policy = service.getPolicy();

      expect(policy.masterKeyRotationDays).toBe(30);
      expect(policy.apiKeyMaxAgeDays).toBe(90);
      // Defaults preserved
      expect(policy.tenantKeyRotationDays).toBe(180);
    });

    test('returns a copy (not a reference)', () => {
      const store = new InMemoryKeyStore();
      const service = new KeyRotationService(store);

      const p1 = service.getPolicy();
      const p2 = service.getPolicy();

      expect(p1).toEqual(p2);
      expect(p1).not.toBe(p2);
    });
  });
});

// =============================================================================
// SECRET MASKING SERVICE TESTS
// =============================================================================

describe('SecretMaskingService', () => {
  let SecretMaskingService: typeof import('../services/security/secret-masking').SecretMaskingService;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../services/security/secret-masking');
    SecretMaskingService = mod.SecretMaskingService;
  });

  describe('maskString', () => {
    test('masks bearer tokens', () => {
      const masker = new SecretMaskingService();
      const input = 'Authorization: Bearer sk-ant-1234567890abcdef';
      const result = masker.maskString(input);

      expect(result).not.toContain('sk-ant-1234567890abcdef');
      expect(result).toContain('REDACTED');
    });

    test('masks email addresses', () => {
      const masker = new SecretMaskingService();
      const result = masker.maskString('Contact john@example.com for help');

      expect(result).not.toContain('john@example.com');
      expect(result).toContain('REDACTED');
    });

    test('masks SSN patterns', () => {
      const masker = new SecretMaskingService();
      const result = masker.maskString('SSN: 123-45-6789');

      expect(result).not.toContain('123-45-6789');
    });

    test('masks valid credit card numbers (Luhn-valid)', () => {
      const masker = new SecretMaskingService();
      const result = masker.maskString('Card: 4532015112830366');

      expect(result).not.toContain('4532015112830366');
    });

    test('does not mask Luhn-invalid digit sequences', () => {
      const masker = new SecretMaskingService();
      const result = masker.maskString('Order ref: ABCD-1111-2222-3333');

      expect(result).toContain('ABCD-1111-2222-3333');
    });

    test('masks key prefixes (sk-, pk-, abl_)', () => {
      const masker = new SecretMaskingService();
      const result = masker.maskString('Key is sk-abcdefghijklmnopqrstuvwxyz');

      expect(result).not.toContain('sk-abcdefghijklmnopqrstuvwxyz');
    });

    test('masks GitHub token prefixes (ghp_, gho_)', () => {
      const masker = new SecretMaskingService();
      const result = masker.maskString('Token: ghp_abcdefghijklmnopqrstuvwxyz0123456789');

      expect(result).not.toContain('ghp_abcdefghijklmnopqrstuvwxyz0123456789');
    });

    test('handles string with no secrets unchanged', () => {
      const masker = new SecretMaskingService();
      const input = 'Hello, this is a normal message with no secrets.';
      const result = masker.maskString(input);

      expect(result).toBe(input);
    });

    test('masks multiple patterns in same string', () => {
      const masker = new SecretMaskingService();
      const input = 'User john@example.com has SSN 123-45-6789';
      const result = masker.maskString(input);

      expect(result).not.toContain('john@example.com');
      expect(result).not.toContain('123-45-6789');
    });

    test('masks custom patterns', () => {
      const masker = new SecretMaskingService({
        patterns: {
          bearerTokens: true,
          apiKeys: true,
          emails: true,
          phones: true,
          ssns: true,
          creditCards: true,
          customPatterns: [{ name: 'internal_id', regex: /INTERNAL-[A-Z0-9]{10}/g }],
        },
      });

      const result = masker.maskString('Ref: INTERNAL-ABC1234567');
      expect(result).not.toContain('INTERNAL-ABC1234567');
    });
  });

  describe('maskObject', () => {
    test('walks nested objects and masks strings', () => {
      const masker = new SecretMaskingService();
      const input = {
        user: { email: 'test@example.com', name: 'John' },
        auth: { token: 'Bearer secret123456789012345' },
      };

      const result = masker.maskObject(input);

      expect(result.user.email).not.toContain('test@example.com');
      expect(result.auth.token).toContain('REDACTED');
    });

    test('detects secret-sounding key names', () => {
      const masker = new SecretMaskingService();
      const input = {
        api_key: 'my-secret-key-value',
        password: 'hunter2',
        name: 'not-a-secret',
      };

      const result = masker.maskObject(input);

      expect(result.api_key).toContain('REDACTED');
      expect(result.password).toContain('REDACTED');
      expect(result.name).toBe('not-a-secret');
    });

    test('handles arrays in objects', () => {
      const masker = new SecretMaskingService();
      const input = {
        emails: ['user1@example.com', 'user2@example.com'],
      };

      const result = masker.maskObject(input);

      expect(result.emails[0]).not.toContain('user1@example.com');
      expect(result.emails[1]).not.toContain('user2@example.com');
    });

    test('handles null and undefined gracefully', () => {
      const masker = new SecretMaskingService();

      expect(masker.maskObject(null)).toBeNull();
      expect(masker.maskObject(undefined)).toBeUndefined();
    });

    test('handles primitive types', () => {
      const masker = new SecretMaskingService();

      expect(masker.maskObject(42)).toBe(42);
      expect(masker.maskObject(true)).toBe(true);
    });

    test('detects various secret key names', () => {
      const masker = new SecretMaskingService();
      const input = {
        client_secret: 'abc123',
        access_key: 'def456',
        private_key: 'ghi789',
        credential: 'jkl012',
        auth_token: 'mno345',
        normal_key: 'visible',
      };

      const result = masker.maskObject(input);

      expect(result.client_secret).toContain('REDACTED');
      expect(result.access_key).toContain('REDACTED');
      expect(result.private_key).toContain('REDACTED');
      expect(result.credential).toContain('REDACTED');
      expect(result.auth_token).toContain('REDACTED');
      expect(result.normal_key).toBe('visible');
    });
  });

  describe('addSecretKey', () => {
    test('registers custom key for masking', () => {
      const masker = new SecretMaskingService();
      masker.addSecretKey('MY_CUSTOM_SECRET');

      const result = masker.maskObject({ my_custom_secret: 'sensitive-value' });
      expect(result.my_custom_secret).toContain('REDACTED');
    });

    test('key matching is case-insensitive', () => {
      const masker = new SecretMaskingService();
      masker.addSecretKey('Custom_Key');

      const result = masker.maskObject({ custom_key: 'value' });
      expect(result.custom_key).toContain('REDACTED');
    });
  });

  describe('masking strategies', () => {
    test('redact strategy produces ***REDACTED***', () => {
      const masker = new SecretMaskingService({ strategy: 'redact' });
      const result = masker.maskString('SSN: 123-45-6789');

      expect(result).toContain('***REDACTED***');
      expect(result).not.toContain('123-45-6789');
    });

    test('hash strategy produces [HASH:xxxxxxxx]', () => {
      const masker = new SecretMaskingService({ strategy: 'hash' });
      const result = masker.maskString('SSN: 123-45-6789');

      expect(result).toMatch(/\[HASH:[a-f0-9]{8}\]/);
      expect(result).not.toContain('123-45-6789');
    });

    test('partial strategy reveals first/last chars', () => {
      const masker = new SecretMaskingService({
        strategy: 'partial',
        partialReveal: 4,
      });
      const result = masker.maskString('SSN: 123-45-6789');

      expect(result).not.toContain('123-45-6789');
    });

    test('partial mask returns *** for very short values', () => {
      const masker = new SecretMaskingService({
        strategy: 'partial',
        partialReveal: 4,
      });
      // When a matched value is <= reveal*2 characters, it returns ***
      const result = masker.maskObject({ password: 'hi' });
      expect(result.password).toBe('***');
    });
  });

  describe('pattern toggling', () => {
    test('respects disabled email pattern', () => {
      const masker = new SecretMaskingService({
        patterns: {
          bearerTokens: true,
          apiKeys: true,
          emails: false,
          phones: true,
          ssns: true,
          creditCards: true,
          customPatterns: [],
        },
      });

      const result = masker.maskString('Contact user@example.com');
      expect(result).toContain('user@example.com');
    });

    test('respects disabled SSN pattern', () => {
      const masker = new SecretMaskingService({
        patterns: {
          bearerTokens: true,
          apiKeys: true,
          emails: true,
          phones: true,
          ssns: false,
          creditCards: true,
          customPatterns: [],
        },
      });

      const result = masker.maskString('SSN: 123-45-6789');
      expect(result).toContain('123-45-6789');
    });
  });

  describe('getSecretMaskingService singleton', () => {
    test('returns a SecretMaskingService instance', async () => {
      const mod = await import('../services/security/secret-masking');
      const service = mod.getSecretMaskingService();
      expect(service).toBeInstanceOf(SecretMaskingService);
    });
  });
});
