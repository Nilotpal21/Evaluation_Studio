/**
 * Tenant Encryption Facade Tests
 *
 * UT-9 through UT-12 from test spec.
 *
 * Key API changes (Decision 3):
 * - encrypt(plaintext, scope) — scope has tenantId+projectId+environment
 * - decrypt(ciphertext, tenantId) — only tenantId needed (dekId from ciphertext)
 * - decryptJson(ciphertext, tenantId) — same
 */

import { describe, it, expect, vi } from 'vitest';
import { randomBytes } from 'node:crypto';
import { TenantEncryptionFacade } from '../tenant-encryption-facade.js';
import type { DEKScope, DEKManagerLike, AcquiredDEK } from '../tenant-encryption-facade.js';
import * as dekCodec from '../dek-codec.js';

describe('TenantEncryptionFacade', () => {
  const testDEK = randomBytes(32);
  const testDekId = 'active';
  const testScope: DEKScope = {
    tenantId: 'test-tenant',
    projectId: 'test-project',
    environment: 'dev',
  };

  // Mock DEKManager — unwrapDEK requires tenantId for cross-tenant isolation
  const mockDEKManager: DEKManagerLike = {
    acquireDEK: vi.fn(async () => ({
      plaintext: testDEK,
      dekId: testDekId,
      kekKeyId: 'test-kek',
      kekKeyVersion: 1,
    })),
    unwrapDEK: vi.fn(async () => testDEK),
  };

  describe('encrypt (UT-9)', () => {
    it('should call dekManager.acquireDEK and encode with DEK ID', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      const plaintext = 'hello world';

      const ciphertext = await facade.encrypt(plaintext, testScope);

      expect(ciphertext).toBeTruthy();
      expect(typeof ciphertext).toBe('string');

      // Verify acquireDEK was called with full scope
      expect(mockDEKManager.acquireDEK).toHaveBeenCalledWith(testScope, 'platform-default');
    });

    it('should reject double encryption (UT-9)', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);

      // Encrypt once
      const ciphertext = await facade.encrypt('test', testScope);

      // Try to encrypt again
      await expect(facade.encrypt(ciphertext, testScope)).rejects.toThrow(
        'Double encryption detected',
      );
    });
  });

  describe('decrypt (UT-10)', () => {
    it('should decrypt DEK envelope by parsing DEK ID with tenant isolation', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      const plaintext = 'secret data';

      // Encrypt
      const ciphertext = await facade.encrypt(plaintext, testScope);

      // Reset mock
      vi.clearAllMocks();

      // Decrypt — tenantId passed for tenant isolation enforcement
      const decrypted = await facade.decrypt(ciphertext, testScope.tenantId);

      expect(decrypted).toBe(plaintext);
      // unwrapDEK called with dekId + tenantId for tenant isolation
      expect(mockDEKManager.unwrapDEK).toHaveBeenCalledWith(testDekId, testScope.tenantId);
    });

    it('should reject legacy tenant ciphertext (UT-10)', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      const legacyHex = 'a1b2c3d4e5f60011:223344556677:aabbccddeeff';

      await expect(facade.decrypt(legacyHex, 'test-tenant')).rejects.toThrow(
        'Unsupported tenant ciphertext format. Expected DEK envelope.',
      );
    });

    it('should reject non-DEK-envelope data', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      const plaintext = 'AAAA corrupted base64 data';

      await expect(facade.decrypt(plaintext, 'test-tenant')).rejects.toThrow(
        'Unsupported tenant ciphertext format. Expected DEK envelope.',
      );
    });

    it('throws a typed LEGACY_CIPHERTEXT_FORMAT AppError so callers can downgrade severity', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      const legacyHex = 'a1b2c3d4e5f60011:223344556677:aabbccddeeff';

      await expect(facade.decrypt(legacyHex, 'test-tenant')).rejects.toMatchObject({
        code: 'LEGACY_CIPHERTEXT_FORMAT',
        statusCode: 503,
      });
    });

    it('should decrypt legacy no-AAD envelope when tenantId is provided', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      const ciphertext = dekCodec.encryptWithDEK('legacy secret', testDEK, testDekId);

      await expect(facade.decrypt(ciphertext, testScope.tenantId)).resolves.toBe('legacy secret');
      expect(mockDEKManager.unwrapDEK).toHaveBeenCalledWith(testDekId, testScope.tenantId);
    });
  });

  describe('encryptJson / decryptJson (UT-11, UT-12)', () => {
    it('should roundtrip JSON objects (UT-11)', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      const data = {
        name: 'test',
        nested: { value: 42 },
        array: [1, 2, 3],
      };

      const ciphertext = await facade.encryptJson(data, testScope);
      expect(typeof ciphertext).toBe('string');

      // decryptJson takes tenantId only (Decision 3)
      const decrypted = await facade.decryptJson(ciphertext, testScope.tenantId);
      expect(decrypted).toEqual(data);
    });

    it('should throw on invalid JSON (UT-12)', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      const notJSON = await facade.encrypt('not json {', testScope);

      await expect(facade.decryptJson(notJSON, testScope.tenantId)).rejects.toThrow();
    });

    it('should handle null and arrays', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);

      const nullCiphertext = await facade.encryptJson(null, testScope);
      expect(await facade.decryptJson(nullCiphertext, testScope.tenantId)).toBe(null);

      const arrayCiphertext = await facade.encryptJson([1, 2, 3], testScope);
      expect(await facade.decryptJson(arrayCiphertext, testScope.tenantId)).toEqual([1, 2, 3]);
    });
  });

  describe('integration with DEKManager', () => {
    it('should pass through DEKManager errors', async () => {
      const failingManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => {
          throw new Error('KMS unavailable');
        }),
        unwrapDEK: vi.fn(async () => {
          throw new Error('KMS unavailable');
        }),
      };

      const facade = new TenantEncryptionFacade(failingManager);

      await expect(facade.encrypt('test', testScope)).rejects.toThrow('KMS unavailable');
    });

    it('forceRotate defaults to _tenant (tenant-wide) scope', async () => {
      const rotateManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: 'active',
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
        forceRotateDEK: vi.fn(async () => 1),
      };

      const facade = new TenantEncryptionFacade(rotateManager);
      await facade.forceRotate('test-tenant');

      // '_tenant' is the tenant-wide sentinel — DEKManager omits projectId/environment
      // from the filter, rotating ALL active DEKs for the tenant.
      expect(rotateManager.forceRotateDEK).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        projectId: '_tenant',
        environment: '_tenant',
      });
    });

    it('should support custom KEK key ID', async () => {
      const customManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: 'active',
          kekKeyId: 'custom-kek',
          kekKeyVersion: 2,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
      };

      const facade = new TenantEncryptionFacade(customManager, 'custom-kek');

      await facade.encrypt('test', testScope);

      expect(customManager.acquireDEK).toHaveBeenCalledWith(testScope, 'custom-kek');
    });
  });

  describe('encryptSync / decryptSync', () => {
    it('returns null when getCachedDEK is not provided', () => {
      const minimalManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: testDekId,
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
        // getCachedDEK and getActiveDEKId intentionally omitted
      };

      const facade = new TenantEncryptionFacade(minimalManager);
      expect(facade.encryptSync('test', testScope)).toBeNull();
    });

    it('returns null when cache misses', () => {
      const cacheMissManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: testDekId,
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
        getCachedDEK: vi.fn(() => null),
        getActiveDEKId: vi.fn(() => 'active'),
      };

      const facade = new TenantEncryptionFacade(cacheMissManager);
      expect(facade.encryptSync('test', testScope)).toBeNull();
    });

    it('encrypts synchronously on cache hit', () => {
      const cacheHitManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: testDekId,
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
        getCachedDEK: vi.fn(() => testDEK),
        getActiveDEKId: vi.fn(() => testDekId),
      };

      const facade = new TenantEncryptionFacade(cacheHitManager);
      const result = facade.encryptSync('hello sync', testScope);
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
    });

    it('rejects double encryption in sync path', () => {
      const cacheHitManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: testDekId,
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
        getCachedDEK: vi.fn(() => testDEK),
        getActiveDEKId: vi.fn(() => testDekId),
      };

      const facade = new TenantEncryptionFacade(cacheHitManager);
      const encrypted = facade.encryptSync('test', testScope);
      expect(encrypted).not.toBeNull();

      expect(() => facade.encryptSync(encrypted!, testScope)).toThrow('Double encryption detected');
    });

    it('decryptSync roundtrips with encryptSync', () => {
      const cacheHitManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: testDekId,
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
        getCachedDEK: vi.fn(() => testDEK),
        getActiveDEKId: vi.fn(() => testDekId),
      };

      const facade = new TenantEncryptionFacade(cacheHitManager);
      const encrypted = facade.encryptSync('sync roundtrip', testScope);
      expect(encrypted).not.toBeNull();

      const decrypted = facade.decryptSync(encrypted!, testScope.tenantId);
      expect(decrypted).toBe('sync roundtrip');
    });

    it('decryptSync returns null for legacy format', () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      const legacyHex = 'a1b2c3d4e5f60011:223344556677:aabbccddeeff';
      expect(facade.decryptSync(legacyHex, 'test-tenant')).toBeNull();
    });

    it('decryptSync returns null when getCachedDEK is not provided', () => {
      const minimalManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: testDekId,
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
      };

      const facade = new TenantEncryptionFacade(minimalManager);
      // Need valid DEK envelope format — encrypt async first, then try sync decrypt
      // Without getCachedDEK, decryptSync should return null
      // Craft a minimal valid-looking base64 that passes isDEKEnvelopeFormat
      const fakeDekId = 'active';
      const idBuf = Buffer.from(fakeDekId, 'utf8');
      const combined = Buffer.concat([
        Buffer.from([idBuf.length]),
        idBuf,
        Buffer.alloc(12), // iv
        Buffer.alloc(16), // authTag
        Buffer.alloc(10), // ciphertext
      ]);
      const fakeEnvelope = combined.toString('base64');

      expect(facade.decryptSync(fakeEnvelope, 'test-tenant')).toBeNull();
    });

    it('decryptSync returns null on decryption error (corrupted data)', () => {
      const cacheHitManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: testDekId,
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
        getCachedDEK: vi.fn(() => testDEK),
        getActiveDEKId: vi.fn(() => testDekId),
      };

      const facade = new TenantEncryptionFacade(cacheHitManager);
      // Craft a valid-looking envelope with wrong ciphertext (will fail auth tag check)
      const fakeDekId = 'active';
      const idBuf = Buffer.from(fakeDekId, 'utf8');
      const combined = Buffer.concat([
        Buffer.from([idBuf.length]),
        idBuf,
        Buffer.alloc(12, 1), // iv (non-zero)
        Buffer.alloc(16, 2), // authTag (non-zero, wrong)
        Buffer.alloc(10, 3), // ciphertext (garbage)
      ]);
      const corruptedEnvelope = combined.toString('base64');

      // Should return null instead of throwing
      expect(facade.decryptSync(corruptedEnvelope, 'test-tenant')).toBeNull();
    });
  });

  describe('clearCache', () => {
    it('calls dekManager.clearCache when available', () => {
      const clearableManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: testDekId,
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
        clearCache: vi.fn(),
      };

      const facade = new TenantEncryptionFacade(clearableManager);
      facade.clearCache();
      expect(clearableManager.clearCache).toHaveBeenCalledOnce();
    });

    it('does nothing when dekManager.clearCache is not available', () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      // Should not throw
      facade.clearCache();
    });
  });

  describe('decrypt edge cases', () => {
    it('rejects corrupted DEK ID header (idLen > buffer length)', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      // Craft a base64 string that passes isDEKEnvelopeFormat but has idLen > remaining bytes
      // idLen=50, but buffer only has a few bytes after
      const fakeDekId = 'active';
      const idBuf = Buffer.from(fakeDekId, 'utf8');
      // Build valid-looking envelope: correct idLen, id, iv, authTag, tiny ciphertext
      const validEnvelope = Buffer.concat([
        Buffer.from([idBuf.length]),
        idBuf,
        Buffer.alloc(12), // iv
        Buffer.alloc(16), // authTag
        Buffer.alloc(1), // minimal ciphertext
      ]);
      // Now corrupt: set idLen to 200 (way beyond buffer)
      validEnvelope[0] = 200;
      const corrupted = validEnvelope.toString('base64');

      // This won't pass isDEKEnvelopeFormat (idLen=200 > 50 max), so it hits "Unsupported" error
      await expect(facade.decrypt(corrupted, 'test-tenant')).rejects.toThrow(
        'Unsupported tenant ciphertext format',
      );
    });
  });

  describe('forceRotate edge cases', () => {
    it('passes custom project and environment', async () => {
      const rotateManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: 'active',
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
        forceRotateDEK: vi.fn(async () => 3),
      };

      const facade = new TenantEncryptionFacade(rotateManager);
      const result = await facade.forceRotate('test-tenant', 'my-project', 'production');

      expect(result).toBe(3);
      expect(rotateManager.forceRotateDEK).toHaveBeenCalledWith({
        tenantId: 'test-tenant',
        projectId: 'my-project',
        environment: 'production',
      });
    });

    it('returns 0 when forceRotateDEK is not available', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);
      const result = await facade.forceRotate('test-tenant');
      expect(result).toBe(0);
    });
  });

  describe('decryptSync without tenantId', () => {
    it('decryptSync returns null without tenantId (AAD mismatch)', () => {
      const cacheHitManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: testDekId,
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
        getCachedDEK: vi.fn(() => testDEK),
        getActiveDEKId: vi.fn(() => testDekId),
      };

      const facade = new TenantEncryptionFacade(cacheHitManager);
      const encrypted = facade.encryptSync('aad-bound data', testScope);
      expect(encrypted).not.toBeNull();

      // Decrypt without tenantId — AAD mismatch causes GCM auth failure,
      // decryptSync catches the error and returns null
      const decrypted = facade.decryptSync(encrypted!);
      expect(decrypted).toBeNull();
    });
  });

  describe('AAD cross-tenant isolation', () => {
    it('decrypt rejects ciphertext encrypted for a different tenant', async () => {
      const facade = new TenantEncryptionFacade(mockDEKManager);

      const tenantAScope: DEKScope = { tenantId: 'tenant-A', projectId: 'p1', environment: 'dev' };
      const ciphertext = await facade.encrypt('tenant-A secret', tenantAScope);

      // Attempt to decrypt with tenant-B — AAD mismatch
      await expect(facade.decrypt(ciphertext, 'tenant-B')).rejects.toThrow();
    });

    it('encryptSync/decryptSync rejects cross-tenant AAD', () => {
      const cacheHitManager: DEKManagerLike = {
        acquireDEK: vi.fn(async () => ({
          plaintext: testDEK,
          dekId: testDekId,
          kekKeyId: 'test-kek',
          kekKeyVersion: 1,
        })),
        unwrapDEK: vi.fn(async () => testDEK),
        getCachedDEK: vi.fn(() => testDEK),
        getActiveDEKId: vi.fn(() => testDekId),
      };

      const facade = new TenantEncryptionFacade(cacheHitManager);
      const tenantAScope: DEKScope = { tenantId: 'tenant-A', projectId: 'p1', environment: 'dev' };
      const encrypted = facade.encryptSync('tenant-A data', tenantAScope);
      expect(encrypted).not.toBeNull();

      // Wrong tenant — returns null (AAD mismatch caught gracefully)
      expect(facade.decryptSync(encrypted!, 'tenant-B')).toBeNull();

      // Correct tenant — works
      expect(facade.decryptSync(encrypted!, 'tenant-A')).toBe('tenant-A data');
    });
  });
});
