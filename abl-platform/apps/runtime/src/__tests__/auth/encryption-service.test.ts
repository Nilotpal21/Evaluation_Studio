/**
 * Encryption Engine Tests
 *
 * Tests for user-scoped encrypt/decrypt and constructor validation.
 * Tenant-scoped encryption is covered by TenantEncryptionFacade tests
 * in packages/shared-encryption.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import crypto from 'crypto';

// Generate a valid 32-byte hex master key for tests
const TEST_MASTER_KEY = crypto.randomBytes(32).toString('hex');

import { EncryptionService } from '@agent-platform/shared/encryption';

// =============================================================================
// ENCRYPTION SERVICE
// =============================================================================

describe('EncryptionService', () => {
  let service: EncryptionService;

  beforeEach(() => {
    service = new EncryptionService({ masterKeyHex: TEST_MASTER_KEY });
  });

  describe('encrypt/decrypt', () => {
    test('should round-trip a string', () => {
      const plaintext = 'Hello, World!';
      const encrypted = service.encrypt(plaintext, 'user-1');
      const decrypted = service.decrypt(encrypted, 'user-1');
      expect(decrypted).toBe(plaintext);
    });

    test('should produce format iv:authTag:ciphertext (hex)', () => {
      const encrypted = service.encrypt('test', 'user-1');
      const parts = encrypted.split(':');
      expect(parts).toHaveLength(3);
      // IV = 12 bytes = 24 hex chars (NIST SP 800-38D recommended for AES-GCM)
      expect(parts[0]).toHaveLength(24);
      // Auth tag = 16 bytes = 32 hex chars
      expect(parts[1]).toHaveLength(32);
      // Ciphertext should be non-empty hex
      expect(parts[2].length).toBeGreaterThan(0);
    });

    test('should fail to decrypt with wrong user', () => {
      const encrypted = service.encrypt('secret', 'user-1');
      expect(() => service.decrypt(encrypted, 'user-2')).toThrow();
    });

    test('should fail on invalid format', () => {
      expect(() => service.decrypt('invalid', 'user-1')).toThrow('Invalid encrypted data format');
    });
  });

  describe('constructor', () => {
    test('should throw if master key is too short', () => {
      expect(() => new EncryptionService({ masterKeyHex: 'abc123' })).toThrow();
    });

    test('should throw if no master key provided', () => {
      expect(() => new EncryptionService({ masterKeyHex: '' })).toThrow();
    });
  });
});
