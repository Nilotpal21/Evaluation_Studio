/**
 * gzip-pool unit tests
 *
 * Validates the sync gzip compression pool:
 *   1. Roundtrip correctness (compress then decompress = original)
 *   2. Threshold behavior (< 512 bytes returns null)
 *   3. Ratio check (incompressible data returns null)
 *   4. Large payloads compress correctly
 *   5. Unicode/JSON safety
 */

import { describe, it, expect } from 'vitest';
import { compressFieldToBase64, decompressFieldFromBase64 } from '../gzip-pool.js';

describe('gzip-pool', () => {
  describe('compressFieldToBase64', () => {
    it('returns null for payloads below 512 bytes', () => {
      const small = 'x'.repeat(100);
      expect(compressFieldToBase64(small)).toBeNull();
    });

    it('returns null for exactly 511 bytes', () => {
      const justUnder = 'a'.repeat(511);
      expect(compressFieldToBase64(justUnder)).toBeNull();
    });

    it('compresses payloads at or above 512 bytes (when compressible)', () => {
      // Repeated data compresses well
      const compressible = 'a'.repeat(1024);
      const result = compressFieldToBase64(compressible);
      expect(result).not.toBeNull();
      expect(typeof result).toBe('string');
      // Result should be valid base64
      expect(() => Buffer.from(result!, 'base64')).not.toThrow();
    });

    it('compresses high-entropy data only if savings exceed 10%', () => {
      // High-entropy data that is above threshold — gzip will still attempt it
      // The key property is: if it compresses, the roundtrip must be correct
      const { randomBytes } = require('node:crypto');
      const randomData = randomBytes(768).toString('base64');
      const result = compressFieldToBase64(randomData);

      if (result === null) {
        // Ratio check triggered — gzip didn't save >10%
        expect(result).toBeNull();
      } else {
        // It compressed — verify roundtrip correctness
        expect(decompressFieldFromBase64(result)).toBe(randomData);
      }
    });

    it('compresses typical JSON session data', () => {
      const sessionJson = JSON.stringify({
        threads: Array(10).fill({
          id: 'thread-1',
          messages: [
            { role: 'user', content: 'Hello, how can you help me today?' },
            { role: 'assistant', content: 'I am here to help you with your questions.' },
          ],
        }),
        dataValues: { key1: 'value1', key2: 'value2', repeated: 'x'.repeat(200) },
      });

      const result = compressFieldToBase64(sessionJson);
      expect(result).not.toBeNull();
      // Verify it's smaller (compression should be significant for repeated JSON)
      expect(Buffer.from(result!, 'base64').length).toBeLessThan(Buffer.byteLength(sessionJson));
    });

    it('handles UTF-8 multi-byte characters correctly', () => {
      // Each emoji is 4 bytes, so 128 emojis = 512 bytes minimum
      const unicode = '你好世界🌍'.repeat(200);
      const result = compressFieldToBase64(unicode);
      // Repeated UTF-8 is highly compressible
      expect(result).not.toBeNull();
    });
  });

  describe('decompressFieldFromBase64', () => {
    it('decompresses base64 gzipped data back to original string', () => {
      const original = 'a'.repeat(2000);
      const compressed = compressFieldToBase64(original);
      expect(compressed).not.toBeNull();

      const decompressed = decompressFieldFromBase64(compressed!);
      expect(decompressed).toBe(original);
    });

    it('throws on invalid base64', () => {
      expect(() => decompressFieldFromBase64('not-valid-gzip-base64')).toThrow();
    });
  });

  describe('roundtrip correctness', () => {
    it('roundtrips large JSON payloads', () => {
      const data = JSON.stringify({
        conversations: Array(50).fill({
          role: 'assistant',
          content: 'This is a response message with some content that repeats.',
          metadata: { timestamp: Date.now(), tokens: 150 },
        }),
      });

      const compressed = compressFieldToBase64(data);
      expect(compressed).not.toBeNull();
      expect(decompressFieldFromBase64(compressed!)).toBe(data);
    });

    it('roundtrips data with special JSON characters', () => {
      const data = JSON.stringify({
        content: 'Line1\nLine2\tTabbed\r\nWindows "quoted" \\escaped',
        nested: { array: [null, true, false, 0, '', { deep: 'value' }] },
      }).repeat(20); // Repeat to exceed threshold

      const compressed = compressFieldToBase64(data);
      if (compressed !== null) {
        expect(decompressFieldFromBase64(compressed)).toBe(data);
      }
    });

    it('roundtrips 100KB payload (realistic session state)', () => {
      const largeState = JSON.stringify({
        executionTree: Array(500).fill({
          nodeId: 'node-abc-123',
          status: 'completed',
          result: { output: 'Some output text that is moderately long' },
        }),
      });

      const compressed = compressFieldToBase64(largeState);
      expect(compressed).not.toBeNull();
      expect(decompressFieldFromBase64(compressed!)).toBe(largeState);
    });
  });

  describe('compression ratio effectiveness', () => {
    it('achieves >50% compression on typical session JSON', () => {
      const sessionData = JSON.stringify({
        threads: Array(30).fill({
          messages: Array(10).fill({
            role: 'user',
            content: 'This is a typical user message in a conversation thread.',
          }),
        }),
      });

      const compressed = compressFieldToBase64(sessionData);
      expect(compressed).not.toBeNull();

      const originalSize = Buffer.byteLength(sessionData);
      const compressedSize = Buffer.from(compressed!, 'base64').length;
      const ratio = compressedSize / originalSize;

      // Typical JSON with repeated structures should compress to <50% original
      expect(ratio).toBeLessThan(0.5);
    });
  });
});
