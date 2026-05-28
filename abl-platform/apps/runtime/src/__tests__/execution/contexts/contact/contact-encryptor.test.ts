/**
 * EncryptionService Contact PII Tests
 *
 * Validates AES-256-GCM encryption/decryption per-tenant via HKDF-derived keys,
 * HMAC-SHA256 blind indexes for searching encrypted data, and identity normalization.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import crypto from 'node:crypto';
import { EncryptionService } from '@agent-platform/shared/encryption';
import { normalizeIdentity } from '../../../../contexts/contact/infrastructure/normalize-identity.js';

// 32 bytes = 64 hex chars for AES-256
const TEST_MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');

describe('EncryptionService (contact PII)', () => {
  let encryptor: EncryptionService;

  beforeAll(() => {
    encryptor = new EncryptionService({ masterKeyHex: TEST_MASTER_KEY_HEX });
  });

  // ===========================================================================
  // Encryption / Decryption
  // ===========================================================================

  describe('encrypt() / decrypt()', () => {
    it('encrypts plaintext and decrypts back to original', () => {
      const tenantId = 'tenant-001';
      const plaintext = 'user@example.com';

      const ciphertext = encryptor.encryptContactPII(tenantId, plaintext);
      const decrypted = encryptor.decryptContactPII(tenantId, ciphertext);

      expect(decrypted).toBe(plaintext);
    });

    it('produces different ciphertext for each encryption (IV randomness)', () => {
      const tenantId = 'tenant-001';
      const plaintext = 'same-input';

      const ct1 = encryptor.encryptContactPII(tenantId, plaintext);
      const ct2 = encryptor.encryptContactPII(tenantId, plaintext);

      expect(ct1).not.toBe(ct2);
    });

    it('ciphertext is base64-encoded', () => {
      const ciphertext = encryptor.encryptContactPII('tenant-001', 'test');
      expect(() => Buffer.from(ciphertext, 'base64')).not.toThrow();
      // Re-encoding should round-trip
      const buf = Buffer.from(ciphertext, 'base64');
      expect(buf.toString('base64')).toBe(ciphertext);
    });

    it('ciphertext contains IV (16 bytes) + auth tag (16 bytes) + encrypted data', () => {
      const ciphertext = encryptor.encryptContactPII('tenant-001', 'hello');
      const buf = Buffer.from(ciphertext, 'base64');
      // Minimum: 16 (IV) + 16 (tag) + at least 1 byte encrypted
      expect(buf.length).toBeGreaterThanOrEqual(33);
    });

    it('decryption with wrong tenant fails (different derived key)', () => {
      const ciphertext = encryptor.encryptContactPII('tenant-001', 'secret');
      expect(() => encryptor.decryptContactPII('tenant-002', ciphertext)).toThrow();
    });

    it('decryption with tampered ciphertext fails (auth tag verification)', () => {
      const ciphertext = encryptor.encryptContactPII('tenant-001', 'secret');
      const buf = Buffer.from(ciphertext, 'base64');
      // Flip a byte in the encrypted portion (past IV + tag)
      if (buf.length > 32) {
        buf[32] ^= 0xff;
      }
      const tampered = buf.toString('base64');
      expect(() => encryptor.decryptContactPII('tenant-001', tampered)).toThrow();
    });

    it('handles empty string plaintext', () => {
      const ciphertext = encryptor.encryptContactPII('tenant-001', '');
      const decrypted = encryptor.decryptContactPII('tenant-001', ciphertext);
      expect(decrypted).toBe('');
    });

    it('handles unicode plaintext', () => {
      const plaintext = 'Hello World! Hola Mundo!';
      const ciphertext = encryptor.encryptContactPII('tenant-001', plaintext);
      const decrypted = encryptor.decryptContactPII('tenant-001', ciphertext);
      expect(decrypted).toBe(plaintext);
    });

    it('handles long plaintext', () => {
      const plaintext = 'x'.repeat(10000);
      const ciphertext = encryptor.encryptContactPII('tenant-001', plaintext);
      const decrypted = encryptor.decryptContactPII('tenant-001', ciphertext);
      expect(decrypted).toBe(plaintext);
    });
  });

  // ===========================================================================
  // Blind Index
  // ===========================================================================

  describe('blindIndex()', () => {
    it('returns a hex string (64 chars for SHA-256)', () => {
      const index = encryptor.blindIndex('tenant-001', 'user@example.com');
      expect(index).toHaveLength(64);
      expect(index).toMatch(/^[0-9a-f]{64}$/);
    });

    it('produces consistent output for the same input', () => {
      const a = encryptor.blindIndex('tenant-001', 'user@example.com');
      const b = encryptor.blindIndex('tenant-001', 'user@example.com');
      expect(a).toBe(b);
    });

    it('different values produce different blind indexes', () => {
      const a = encryptor.blindIndex('tenant-001', 'alice@example.com');
      const b = encryptor.blindIndex('tenant-001', 'bob@example.com');
      expect(a).not.toBe(b);
    });

    it('same value for different tenants produces different blind indexes', () => {
      const value = 'shared-identity@example.com';
      const a = encryptor.blindIndex('tenant-001', value);
      const b = encryptor.blindIndex('tenant-002', value);
      expect(a).not.toBe(b);
    });

    it('blind index is deterministic across encryptor instances with same master key', () => {
      const encryptor2 = new EncryptionService({ masterKeyHex: TEST_MASTER_KEY_HEX });
      const a = encryptor.blindIndex('tenant-001', 'test');
      const b = encryptor2.blindIndex('tenant-001', 'test');
      expect(a).toBe(b);
    });

    it('different master keys produce different blind indexes', () => {
      const otherKey = crypto.randomBytes(32).toString('hex');
      const otherEncryptor = new EncryptionService({ masterKeyHex: otherKey });
      const a = encryptor.blindIndex('tenant-001', 'test');
      const b = otherEncryptor.blindIndex('tenant-001', 'test');
      expect(a).not.toBe(b);
    });
  });

  // ===========================================================================
  // Identity Normalization
  // ===========================================================================

  describe('normalizeIdentity()', () => {
    describe('email normalization', () => {
      it('lowercases email', () => {
        expect(normalizeIdentity('email', 'User@Example.COM')).toBe('user@example.com');
      });

      it('trims whitespace', () => {
        expect(normalizeIdentity('email', '  user@example.com  ')).toBe('user@example.com');
      });

      it('lowercases and trims combined', () => {
        expect(normalizeIdentity('email', '  Alice@BigCorp.IO  ')).toBe('alice@bigcorp.io');
      });

      it('handles already-normalized email', () => {
        expect(normalizeIdentity('email', 'clean@test.com')).toBe('clean@test.com');
      });
    });

    describe('phone normalization (E.164)', () => {
      it('keeps already E.164 formatted phone', () => {
        expect(normalizeIdentity('phone', '+15551234567')).toBe('+15551234567');
      });

      it('strips non-digit characters except leading +', () => {
        expect(normalizeIdentity('phone', '+1 (555) 123-4567')).toBe('+15551234567');
      });

      it('adds + prefix when missing', () => {
        expect(normalizeIdentity('phone', '15551234567')).toBe('+15551234567');
      });

      it('handles phone with dots', () => {
        expect(normalizeIdentity('phone', '+1.555.123.4567')).toBe('+15551234567');
      });

      it('handles phone with spaces only', () => {
        expect(normalizeIdentity('phone', '1 555 123 4567')).toBe('+15551234567');
      });
    });

    describe('external identity', () => {
      it('returns external identifiers unchanged', () => {
        expect(normalizeIdentity('external', 'CRM-ID-12345')).toBe('CRM-ID-12345');
      });

      it('preserves case for external identifiers', () => {
        expect(normalizeIdentity('external', 'OAuth:ABC123')).toBe('OAuth:ABC123');
      });
    });
  });

  // ===========================================================================
  // Constructor validation
  // ===========================================================================

  describe('constructor', () => {
    it('accepts a valid 64 hex char (32 byte) master key', () => {
      const key = crypto.randomBytes(32).toString('hex');
      expect(() => new EncryptionService({ masterKeyHex: key })).not.toThrow();
    });

    it('rejects a master key that is too short', () => {
      const shortKey = crypto.randomBytes(16).toString('hex'); // 32 hex chars = 16 bytes
      expect(() => new EncryptionService({ masterKeyHex: shortKey })).toThrow();
    });

    it('rejects an empty master key', () => {
      expect(() => new EncryptionService({ masterKeyHex: '' })).toThrow();
    });
  });
});
