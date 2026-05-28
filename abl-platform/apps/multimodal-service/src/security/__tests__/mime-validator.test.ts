import { describe, it, expect } from 'vitest';
import { validateMime, mimeToCategory } from '../mime-validator.js';

/**
 * Minimal valid PNG: 8-byte signature + IHDR chunk (4 len + 4 type + 13 data + 4 CRC).
 * file-type needs the IHDR chunk header to confirm PNG detection.
 */
const MINIMAL_PNG = Buffer.from([
  // PNG signature (8 bytes)
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  // IHDR chunk length (13 bytes of data)
  0x00,
  0x00,
  0x00,
  0x0d,
  // IHDR chunk type
  0x49,
  0x48,
  0x44,
  0x52,
  // IHDR data: 1x1 pixel, 8-bit RGB
  0x00,
  0x00,
  0x00,
  0x01, // width: 1
  0x00,
  0x00,
  0x00,
  0x01, // height: 1
  0x08, // bit depth: 8
  0x02, // color type: RGB
  0x00, // compression method
  0x00, // filter method
  0x00, // interlace method
  // IHDR CRC (pre-computed for this exact data)
  0x90,
  0x77,
  0x53,
  0xde,
]);

describe('MIME Validator', () => {
  describe('validateMime', () => {
    it('validates a real PNG file', async () => {
      const result = await validateMime(MINIMAL_PNG, 'image/png');
      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('image/png');
    });

    it('rejects MIME spoofing (declared PNG, actually executable)', async () => {
      // ELF header (Linux executable) — needs enough bytes for file-type to parse
      const elfBuffer = Buffer.alloc(32, 0);
      // ELF magic bytes
      elfBuffer[0] = 0x7f;
      elfBuffer[1] = 0x45; // E
      elfBuffer[2] = 0x4c; // L
      elfBuffer[3] = 0x46; // F
      const result = await validateMime(elfBuffer, 'image/png');
      expect(result.valid).toBe(false);
    });

    it('allows text/* declarations when no magic bytes detected', async () => {
      // Plain text has no magic bytes
      const textBuffer = Buffer.from('Hello, world!', 'utf-8');
      const result = await validateMime(textBuffer, 'text/plain');
      expect(result.valid).toBe(true);
      expect(result.detectedMimeType).toBe('text/plain');
    });

    it('rejects non-text declarations when no magic bytes detected', async () => {
      const textBuffer = Buffer.from('Hello, world!', 'utf-8');
      const result = await validateMime(textBuffer, 'application/octet-stream');
      expect(result.valid).toBe(false);
      expect(result.detectedMimeType).toBe('unknown');
    });

    it('rejects when declared category differs from detected category', async () => {
      // PNG file but declared as audio
      const result = await validateMime(MINIMAL_PNG, 'audio/mpeg');
      expect(result.valid).toBe(false);
      expect(result.detectedMimeType).toBe('image/png');
    });

    it('rejects empty buffer', async () => {
      const result = await validateMime(Buffer.alloc(0), 'image/png');
      expect(result.valid).toBe(false);
      expect(result.detectedMimeType).toBe('unknown');
    });

    it('rejects empty declared MIME type', async () => {
      const result = await validateMime(MINIMAL_PNG, '');
      expect(result.valid).toBe(false);
      expect(result.detectedMimeType).toBe('unknown');
    });
  });

  describe('mimeToCategory', () => {
    it('maps image MIME types to image category', () => {
      expect(mimeToCategory('image/png')).toBe('image');
      expect(mimeToCategory('image/jpeg')).toBe('image');
      expect(mimeToCategory('image/webp')).toBe('image');
      expect(mimeToCategory('image/gif')).toBe('image');
    });

    it('maps document MIME types to document category', () => {
      expect(mimeToCategory('application/pdf')).toBe('document');
      expect(mimeToCategory('application/msword')).toBe('document');
      expect(
        mimeToCategory('application/vnd.openxmlformats-officedocument.wordprocessingml.document'),
      ).toBe('document');
      expect(
        mimeToCategory('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'),
      ).toBe('document');
      expect(mimeToCategory('application/vnd.ms-excel')).toBe('document');
      expect(
        mimeToCategory('application/vnd.openxmlformats-officedocument.presentationml.presentation'),
      ).toBe('document');
      expect(mimeToCategory('text/csv')).toBe('document');
      expect(mimeToCategory('text/html')).toBe('document');
      expect(mimeToCategory('text/plain')).toBe('document');
      expect(mimeToCategory('text/markdown')).toBe('document');
    });

    it('maps audio MIME types to audio category', () => {
      expect(mimeToCategory('audio/mpeg')).toBe('audio');
      expect(mimeToCategory('audio/wav')).toBe('audio');
      expect(mimeToCategory('audio/ogg')).toBe('audio');
    });

    it('maps video MIME types to video category', () => {
      expect(mimeToCategory('video/mp4')).toBe('video');
      expect(mimeToCategory('video/webm')).toBe('video');
    });

    it('returns null for unrecognized MIME types', () => {
      expect(mimeToCategory('application/octet-stream')).toBeNull();
      expect(mimeToCategory('application/json')).toBeNull();
      expect(mimeToCategory('application/zip')).toBeNull();
    });
  });
});
