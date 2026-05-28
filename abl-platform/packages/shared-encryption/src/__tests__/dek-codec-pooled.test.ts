/**
 * Pooled DEK Codec Tests
 *
 * Verifies that the pooled codec:
 *   1. Produces wire-format-compatible output (decryptable by original codec)
 *   2. Handles all edge cases identically to the original
 *   3. IV pool produces cryptographically unique IVs
 *   4. Buffer pool handles large payloads
 *   5. AAD cache works correctly
 */

import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import * as dekCodec from '../dek-codec.js';
import { encryptWithDEKPooled, getPoolStats } from '../dek-codec-pooled.js';

describe('dek-codec-pooled', () => {
  const testDEK = randomBytes(32);
  const testDekId = 'active';

  describe('wire-format compatibility — pooled encrypt, original decrypt', () => {
    it('should roundtrip ASCII plaintext', () => {
      const plaintext = 'hello world';
      const ciphertext = encryptWithDEKPooled(plaintext, testDEK, testDekId);

      expect(ciphertext).toBeTruthy();
      expect(typeof ciphertext).toBe('string');

      // Decrypt with ORIGINAL codec — proves wire format is identical
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK);
      expect(result.plaintext).toBe(plaintext);
      expect(result.dekId).toBe(testDekId);
    });

    it('should roundtrip empty string', () => {
      const plaintext = '';
      const ciphertext = encryptWithDEKPooled(plaintext, testDEK, testDekId);
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK);

      expect(result.plaintext).toBe(plaintext);
      expect(result.dekId).toBe(testDekId);
    });

    it('should roundtrip UTF-8 with special characters', () => {
      const plaintext = '你好世界 🌍 émojis & symbols: ñ ü ö ß';
      const ciphertext = encryptWithDEKPooled(plaintext, testDEK, testDekId);
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK);

      expect(result.plaintext).toBe(plaintext);
      expect(result.dekId).toBe(testDekId);
    });

    it('should roundtrip large payload (100KB)', () => {
      const plaintext = 'x'.repeat(1024 * 100);
      const ciphertext = encryptWithDEKPooled(plaintext, testDEK, testDekId);
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK);

      expect(result.plaintext).toBe(plaintext);
      expect(result.dekId).toBe(testDekId);
    });

    it('should roundtrip JSON session data (realistic payload)', () => {
      const sessionData = JSON.stringify({
        threads: [
          {
            id: 'thread-1',
            messages: Array(20).fill({ role: 'user', content: 'test message with some content' }),
          },
        ],
        dataValues: { key1: 'value1', nested: { deep: Array(50).fill('repeated data') } },
        executionTreeValues: { step1: { result: 'ok', metadata: { ts: Date.now() } } },
      });
      const ciphertext = encryptWithDEKPooled(sessionData, testDEK, testDekId);
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK);

      expect(result.plaintext).toBe(sessionData);
      expect(result.dekId).toBe(testDekId);
    });
  });

  describe('DEK ID handling', () => {
    it('should handle various DEK ID formats', () => {
      const dekIds = ['active', 'active:R1', 'active:R99', 'a', 'x'.repeat(255)];
      for (const dekId of dekIds) {
        const ciphertext = encryptWithDEKPooled('test', testDEK, dekId);
        const result = dekCodec.decryptWithDEK(ciphertext, testDEK);
        expect(result.dekId).toBe(dekId);
        expect(result.plaintext).toBe('test');
      }
    });

    it('should reject DEK ID > 255 characters', () => {
      expect(() => encryptWithDEKPooled('test', testDEK, 'x'.repeat(256))).toThrow(
        /≤255 characters/,
      );
    });

    it('should reject invalid key length', () => {
      expect(() => encryptWithDEKPooled('test', randomBytes(16), testDekId)).toThrow(
        /exactly 32 bytes/,
      );
    });
  });

  describe('AAD (Additional Authenticated Data)', () => {
    it('should produce valid ciphertext with string AAD', () => {
      const plaintext = 'sensitive data';
      const aad = 'tenant:abc123';
      const ciphertext = encryptWithDEKPooled(plaintext, testDEK, testDekId, aad);
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK, aad);

      expect(result.plaintext).toBe(plaintext);
    });

    it('should produce valid ciphertext with Buffer AAD', () => {
      const plaintext = 'sensitive data';
      const aad = Buffer.from('tenant:abc123', 'utf8');
      const ciphertext = encryptWithDEKPooled(plaintext, testDEK, testDekId, aad);
      const result = dekCodec.decryptWithDEK(ciphertext, testDEK, aad);

      expect(result.plaintext).toBe(plaintext);
    });

    it('should fail decryption with wrong AAD', () => {
      const ciphertext = encryptWithDEKPooled('test', testDEK, testDekId, 'tenant:abc');
      expect(() => dekCodec.decryptWithDEK(ciphertext, testDEK, 'tenant:xyz')).toThrow();
    });

    it('should cache AAD buffers (same string reuses buffer)', () => {
      const statsBefore = getPoolStats();
      // Encrypt multiple times with same AAD
      for (let i = 0; i < 10; i++) {
        encryptWithDEKPooled(`msg-${i}`, testDEK, testDekId, 'tenant:cached-test');
      }
      const statsAfter = getPoolStats();
      // AAD cache should have at most 1 new entry for this AAD string
      expect(statsAfter.aadCacheSize - statsBefore.aadCacheSize).toBeLessThanOrEqual(1);
    });
  });

  describe('IV uniqueness (security critical)', () => {
    it('should produce unique ciphertexts for same plaintext (IVs differ)', () => {
      const ciphertexts = new Set<string>();
      for (let i = 0; i < 200; i++) {
        ciphertexts.add(encryptWithDEKPooled('identical plaintext', testDEK, testDekId));
      }
      // All 200 encryptions must produce different ciphertexts (IV uniqueness)
      expect(ciphertexts.size).toBe(200);
    });

    it('should produce unique IVs across IV pool refill boundaries', () => {
      // The pool holds 128 IVs. Encrypt 300 times to cross refill boundaries.
      const ciphertexts = new Set<string>();
      for (let i = 0; i < 300; i++) {
        ciphertexts.add(encryptWithDEKPooled('same', testDEK, testDekId));
      }
      expect(ciphertexts.size).toBe(300);
    });
  });

  describe('output buffer growth', () => {
    it('should handle payloads that grow the output buffer', () => {
      // Start small, then go large — tests buffer resize
      const small = encryptWithDEKPooled('small', testDEK, testDekId);
      const large = encryptWithDEKPooled('x'.repeat(200_000), testDEK, testDekId);
      const smallAgain = encryptWithDEKPooled('small again', testDEK, testDekId);

      expect(dekCodec.decryptWithDEK(small, testDEK).plaintext).toBe('small');
      expect(dekCodec.decryptWithDEK(large, testDEK).plaintext).toBe('x'.repeat(200_000));
      expect(dekCodec.decryptWithDEK(smallAgain, testDEK).plaintext).toBe('small again');
    });
  });

  describe('concurrent usage simulation', () => {
    it('should handle rapid sequential encryptions (simulates event loop concurrency)', () => {
      // In Node.js single-threaded model, "concurrent" means rapid sequential calls
      const results: Array<{ plaintext: string; ciphertext: string }> = [];

      for (let i = 0; i < 500; i++) {
        const plaintext = `session-data-${i}-${JSON.stringify({ turn: i, data: 'x'.repeat(100) })}`;
        const ciphertext = encryptWithDEKPooled(plaintext, testDEK, testDekId, `tenant:t${i % 5}`);
        results.push({ plaintext, ciphertext });
      }

      // Verify all decrypt correctly
      for (const { plaintext, ciphertext } of results) {
        const idx = results.indexOf({ plaintext, ciphertext });
        const tenantAad = `tenant:t${results.indexOf({ plaintext, ciphertext }) % 5}`;
        // Use index from plaintext
        const i = parseInt(plaintext.split('-')[2]);
        const result = dekCodec.decryptWithDEK(ciphertext, testDEK, `tenant:t${i % 5}`);
        expect(result.plaintext).toBe(plaintext);
      }
    });
  });
});
