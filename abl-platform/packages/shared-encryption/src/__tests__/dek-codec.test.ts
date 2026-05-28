/**
 * DEK Codec Tests
 *
 * UT-1 through UT-8 from test spec.
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as dekCodec from '../dek-codec.js';

describe('dek-codec', () => {
  const testDEK = randomBytes(32); // 256-bit key
  const testDekId = 'active';

  describe('encrypt/decrypt roundtrip (UT-1, UT-2, UT-3)', () => {
    it('should roundtrip ASCII plaintext', () => {
      const plaintext = 'hello world';
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId);

      expect(ciphertext).toBeTruthy();
      expect(typeof ciphertext).toBe('string');

      const result = dekCodec.decryptWithDEK(ciphertext, testDEK);
      expect(result.plaintext).toBe(plaintext);
      expect(result.dekId).toBe(testDekId);
    });

    it('should roundtrip empty string (UT-2)', () => {
      const plaintext = '';
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId);
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK);

      expect(result.plaintext).toBe(plaintext);
      expect(result.dekId).toBe(testDekId);
    });

    it('should roundtrip UTF-8 with special chars (UT-3)', () => {
      const plaintext = '你好世界 🌍 émojis & symbols: ñ ü ö ß';
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId);
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK);

      expect(result.plaintext).toBe(plaintext);
      expect(result.dekId).toBe(testDekId);
    });

    it('should roundtrip large payload (UT-3)', () => {
      const plaintext = 'x'.repeat(1024 * 100); // 100KB
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId);
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK);

      expect(result.plaintext).toBe(plaintext);
      expect(result.dekId).toBe(testDekId);
    });
  });

  describe('DEK ID handling (UT-1)', () => {
    it('should embed and extract DEK ID correctly', () => {
      const plaintext = 'test';
      const dekIds = ['active', 'active:R1', 'active:R99', 'a', 'x'.repeat(255)];

      for (const dekId of dekIds) {
        const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, dekId);
        const result = dekCodec.decryptWithDEK(ciphertext, testDEK);
        expect(result.dekId).toBe(dekId);
      }
    });

    it('should reject DEK ID longer than 255 chars', () => {
      const longId = 'x'.repeat(256);
      expect(() => dekCodec.encryptWithDEK('test', testDEK, longId)).toThrow(
        'DEK identifier must be ≤255 characters',
      );
    });
  });

  describe('randomness (UT-4)', () => {
    it('should produce different ciphertexts for same plaintext (random IV)', () => {
      const plaintext = 'same input';
      const ct1 = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId);
      const ct2 = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId);

      // Different IVs → different ciphertexts
      expect(ct1).not.toBe(ct2);

      // But both decrypt to same plaintext
      expect(dekCodec.decryptWithDEK(ct1, testDEK).plaintext).toBe(plaintext);
      expect(dekCodec.decryptWithDEK(ct2, testDEK).plaintext).toBe(plaintext);
    });
  });

  describe('error handling', () => {
    it('should reject wrong key (UT-5 — GCM auth tag error)', () => {
      const plaintext = 'secret';
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId);

      const wrongDEK = randomBytes(32);
      expect(() => dekCodec.decryptWithDEK(ciphertext, wrongDEK)).toThrow();
    });

    it('should reject truncated ciphertext (UT-6)', () => {
      const plaintext = 'test';
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId);

      // Truncate the ciphertext
      const truncated = ciphertext.slice(0, 20);
      expect(() => dekCodec.decryptWithDEK(truncated, testDEK)).toThrow(
        'Invalid ciphertext format',
      );
    });

    it('should reject tampered ciphertext (UT-7)', () => {
      const plaintext = 'test';
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId);

      // Tamper with the ciphertext by flipping a bit
      const buffer = Buffer.from(ciphertext, 'base64');
      buffer[buffer.length - 1] ^= 1; // Flip last bit
      const tampered = buffer.toString('base64');

      expect(() => dekCodec.decryptWithDEK(tampered, testDEK)).toThrow();
    });

    it('should reject invalid DEK size on encrypt', () => {
      const shortDEK = randomBytes(16); // 128-bit, not 256-bit
      expect(() => dekCodec.encryptWithDEK('test', shortDEK, testDekId)).toThrow(
        'DEK must be exactly 32 bytes',
      );
    });

    it('should reject invalid DEK size on decrypt', () => {
      const ciphertext = dekCodec.encryptWithDEK('test', testDEK, testDekId);
      const shortDEK = randomBytes(16);
      expect(() => dekCodec.decryptWithDEK(ciphertext, shortDEK)).toThrow(
        'DEK must be exactly 32 bytes',
      );
    });
  });

  describe('AAD tenant binding', () => {
    it('should roundtrip with AAD (tenantId)', () => {
      const plaintext = 'tenant-scoped secret';
      const tenantId = 'tenant-123';
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId, tenantId);
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK, tenantId);

      expect(result.plaintext).toBe(plaintext);
      expect(result.dekId).toBe(testDekId);
    });

    it('should reject decryption with wrong tenantId (cross-tenant swap)', () => {
      const plaintext = 'tenant-A secret';
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId, 'tenant-A');

      // Attempting to decrypt with tenant-B's AAD must fail
      expect(() => dekCodec.decryptWithDEK(ciphertext, testDEK, 'tenant-B')).toThrow();
    });

    it('should reject decryption without AAD when encrypted with AAD', () => {
      const plaintext = 'aad-bound';
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId, 'tenant-X');

      // No AAD on decrypt — GCM auth tag mismatch
      expect(() => dekCodec.decryptWithDEK(ciphertext, testDEK)).toThrow();
    });

    it('should reject decryption with AAD when encrypted without AAD', () => {
      const plaintext = 'no-aad';
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId);

      // AAD on decrypt but not on encrypt — GCM auth tag mismatch
      expect(() => dekCodec.decryptWithDEK(ciphertext, testDEK, 'tenant-X')).toThrow();
    });

    it('backward compat: no AAD roundtrip still works', () => {
      const plaintext = 'legacy no-aad';
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, testDekId);
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK);
      expect(result.plaintext).toBe(plaintext);
    });
  });

  describe('wire format overhead (UT-8)', () => {
    it('should have expected overhead for typical DEK ID', () => {
      const plaintext = 'x'.repeat(1000); // 1KB payload
      const dekId = 'active'; // 6 chars
      const ciphertext = dekCodec.encryptWithDEK(plaintext, testDEK, dekId);

      const buffer = Buffer.from(ciphertext, 'base64');
      const overhead = buffer.length - plaintext.length;

      // Overhead = id_len[1] + dekId[6] + iv[12] + authTag[16] = 35 bytes
      expect(overhead).toBe(1 + dekId.length + 12 + 16);
    });
  });
});
