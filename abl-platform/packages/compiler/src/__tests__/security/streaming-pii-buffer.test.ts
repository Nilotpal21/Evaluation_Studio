/**
 * Streaming PII Buffer Tests
 *
 * Tests the StreamingPIIBuffer class that handles PII detection across
 * streaming chunk boundaries using a 320-character trailing buffer.
 */
import { describe, test, expect, beforeEach } from 'vitest';
import { StreamingPIIBuffer } from '../../platform/security/streaming-pii-buffer.js';
import { detectPII } from '../../platform/security/pii-detector.js';
import type { PIIDetectionResult } from '../../platform/security/pii-detector.js';

describe('StreamingPIIBuffer', () => {
  let buffer: StreamingPIIBuffer;
  const detector = (text: string): PIIDetectionResult => detectPII(text);
  const maxLengthEmail = `${'l'.repeat(64)}@${'a'.repeat(63)}.${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}`;

  beforeEach(() => {
    buffer = new StreamingPIIBuffer();
  });

  // ===========================================================================
  // 1. PHONE NUMBER SPLIT ACROSS CHUNKS
  // ===========================================================================

  describe('Phone number split across chunks', () => {
    test('detects phone split as "555-12" | "3-4567"', () => {
      const r1 = buffer.processChunk('call me at 555-12', detector);
      const r2 = buffer.processChunk('3-4567 please', detector);
      const r3 = buffer.flush(detector);

      const allText = r1.safeText + r2.safeText + r3.safeText;
      const allDetections = [...r1.detections, ...r2.detections, ...r3.detections];

      expect(allDetections.some((d) => d.type === 'phone')).toBe(true);
      expect(allText).toContain('[REDACTED_PHONE]');
      expect(allText).not.toContain('555-123-4567');
    });
  });

  // ===========================================================================
  // 2. EMAIL SPLIT ACROSS CHUNKS
  // ===========================================================================

  describe('Email split across chunks', () => {
    test('detects email split as "john.doe@" | "example.com"', () => {
      const r1 = buffer.processChunk('email john.doe@', detector);
      const r2 = buffer.processChunk('example.com ok', detector);
      const r3 = buffer.flush(detector);

      const allText = r1.safeText + r2.safeText + r3.safeText;
      const allDetections = [...r1.detections, ...r2.detections, ...r3.detections];

      expect(allDetections.some((d) => d.type === 'email')).toBe(true);
      expect(allText).toContain('[REDACTED_EMAIL]');
      expect(allText).not.toContain('john.doe@example.com');
    });

    test('buffers enough trailing text to redact a 320-character email split across chunks', () => {
      expect(maxLengthEmail).toHaveLength(320);

      const r1 = buffer.processChunk(`prefix ${maxLengthEmail.slice(0, 180)}`, detector);
      const r2 = buffer.processChunk(`${maxLengthEmail.slice(180)} suffix`, detector);
      const r3 = buffer.flush(detector);

      const allText = r1.safeText + r2.safeText + r3.safeText;
      const allDetections = [...r1.detections, ...r2.detections, ...r3.detections];

      expect(r1.safeText).toBe('');
      expect(allDetections.some((d) => d.type === 'email')).toBe(true);
      expect(allText).toBe('prefix [REDACTED_EMAIL] suffix');
      expect(allText).not.toContain(maxLengthEmail.slice(0, 80));
      expect(allText).not.toContain(maxLengthEmail);
    });
  });

  // ===========================================================================
  // 3. NO PII IN CHUNKS
  // ===========================================================================

  describe('No PII in chunks', () => {
    test('text passes through with only buffer delay', () => {
      const r1 = buffer.processChunk('Hello, this is a normal message.', detector);
      const r2 = buffer.processChunk(' Nothing sensitive here.', detector);
      const r3 = buffer.flush(detector);

      const allText = r1.safeText + r2.safeText + r3.safeText;

      expect(allText).toBe('Hello, this is a normal message. Nothing sensitive here.');
      expect(r1.detections).toHaveLength(0);
      expect(r2.detections).toHaveLength(0);
      expect(r3.detections).toHaveLength(0);
    });
  });

  // ===========================================================================
  // 4. PII ENTIRELY WITHIN ONE CHUNK
  // ===========================================================================

  describe('PII entirely within one chunk', () => {
    test('detects PII normally when fully contained in a single chunk', () => {
      const r1 = buffer.processChunk('My email is user@example.com and that is all.', detector);
      const r2 = buffer.flush(detector);

      const allText = r1.safeText + r2.safeText;
      const allDetections = [...r1.detections, ...r2.detections];

      expect(allDetections.some((d) => d.type === 'email')).toBe(true);
      expect(allText).toContain('[REDACTED_EMAIL]');
      expect(allText).not.toContain('user@example.com');
    });
  });

  // ===========================================================================
  // 5. MULTIPLE PII ACROSS CHUNK BOUNDARIES
  // ===========================================================================

  describe('Multiple PII across chunk boundaries', () => {
    test('detects all PII spanning multiple chunks', () => {
      const r1 = buffer.processChunk('Contact: john@', detector);
      const r2 = buffer.processChunk('test.com or call 555-', detector);
      const r3 = buffer.processChunk('123-4567 thanks', detector);
      const r4 = buffer.flush(detector);

      const allText = r1.safeText + r2.safeText + r3.safeText + r4.safeText;
      const allDetections = [
        ...r1.detections,
        ...r2.detections,
        ...r3.detections,
        ...r4.detections,
      ];

      expect(allDetections.some((d) => d.type === 'email')).toBe(true);
      expect(allDetections.some((d) => d.type === 'phone')).toBe(true);
      expect(allText).toContain('[REDACTED_EMAIL]');
      expect(allText).toContain('[REDACTED_PHONE]');
      expect(allText).not.toContain('john@test.com');
      expect(allText).not.toContain('555-123-4567');
    });
  });

  // ===========================================================================
  // 6. FLUSH AT STREAM END
  // ===========================================================================

  describe('Flush at stream end', () => {
    test('remaining buffer content is processed on flush', () => {
      // Short text that fits entirely in buffer
      const r1 = buffer.processChunk('hi user@test.com', detector);
      // Everything may be in buffer still since chunk is short
      const r2 = buffer.flush(detector);

      const allText = r1.safeText + r2.safeText;
      const allDetections = [...r1.detections, ...r2.detections];

      expect(allDetections.some((d) => d.type === 'email')).toBe(true);
      expect(allText).toContain('[REDACTED_EMAIL]');
      expect(allText).not.toContain('user@test.com');
    });

    test('flush on empty buffer returns empty result', () => {
      const result = buffer.flush(detector);
      expect(result.safeText).toBe('');
      expect(result.detections).toHaveLength(0);
    });
  });

  // ===========================================================================
  // 7. EMPTY CHUNKS
  // ===========================================================================

  describe('Empty chunks', () => {
    test('handles empty string chunks gracefully', () => {
      const r1 = buffer.processChunk('', detector);
      expect(r1.safeText).toBe('');
      expect(r1.detections).toHaveLength(0);

      const r2 = buffer.processChunk('hello world', detector);
      const r3 = buffer.processChunk('', detector);
      const r4 = buffer.flush(detector);

      const allText = r2.safeText + r3.safeText + r4.safeText;
      expect(allText).toBe('hello world');
    });
  });

  // ===========================================================================
  // 8. BUFFER DOES NOT GROW UNBOUNDED
  // ===========================================================================

  describe('Buffer size management', () => {
    test('buffer stays at 320-char window', () => {
      // Feed many chunks — buffer should never exceed 320 chars internally
      for (let i = 0; i < 100; i++) {
        buffer.processChunk('abcdefghij', detector); // 10 chars each
      }
      // Access internal state via flush — the flush output should be at most 320 chars
      const flushed = buffer.flush(detector);
      expect(flushed.safeText.length).toBeLessThanOrEqual(320);
    });
  });

  // ===========================================================================
  // 9. CHUNK SMALLER THAN BUFFER SIZE
  // ===========================================================================

  describe('Chunk smaller than buffer size', () => {
    test('small chunks accumulate in buffer until threshold', () => {
      const r1 = buffer.processChunk('hi', detector);
      // "hi" is only 2 chars, should all be in buffer, nothing emitted yet
      expect(r1.safeText).toBe('');

      const r2 = buffer.processChunk(' there', detector);
      // Still accumulating: "hi there" = 8 chars < 320
      expect(r2.safeText).toBe('');

      const r3 = buffer.flush(detector);
      expect(r3.safeText).toBe('hi there');
    });
  });

  // ===========================================================================
  // 10. MULTIPLE CONSECUTIVE CHUNKS WITH PII SPANNING
  // ===========================================================================

  describe('Multiple consecutive chunks with PII spanning', () => {
    test('SSN split across three chunks', () => {
      const r1 = buffer.processChunk('SSN is 123-', detector);
      const r2 = buffer.processChunk('45-', detector);
      const r3 = buffer.processChunk('6789 end', detector);
      const r4 = buffer.flush(detector);

      const allText = r1.safeText + r2.safeText + r3.safeText + r4.safeText;
      const allDetections = [
        ...r1.detections,
        ...r2.detections,
        ...r3.detections,
        ...r4.detections,
      ];

      expect(allDetections.some((d) => d.type === 'ssn')).toBe(true);
      expect(allText).toContain('[REDACTED_SSN]');
      expect(allText).not.toContain('123-45-6789');
    });

    test('handles rapid small chunks with email', () => {
      const chunks = ['em', 'ail', ': u', 'ser', '@ex', 'amp', 'le.', 'com', ' ok'];
      const results = chunks.map((c) => buffer.processChunk(c, detector));
      const flushed = buffer.flush(detector);

      const allText = results.map((r) => r.safeText).join('') + flushed.safeText;
      const allDetections = results.flatMap((r) => r.detections).concat(flushed.detections);

      expect(allDetections.some((d) => d.type === 'email')).toBe(true);
      expect(allText).toContain('[REDACTED_EMAIL]');
      expect(allText).not.toContain('user@example.com');
    });
  });
});
