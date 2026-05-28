import { describe, it, expect } from 'vitest';
import sharp from 'sharp';
import { ImageProcessor } from '../image-processor.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

/**
 * Create a test image buffer of the given dimensions using sharp.
 * Generates a solid red JPEG by default.
 */
const createTestImage = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 255, g: 0, b: 0 },
    },
  })
    .jpeg()
    .toBuffer();

/**
 * Create a PNG test image buffer of the given dimensions.
 */
const createTestPng = (width: number, height: number): Promise<Buffer> =>
  sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 128, b: 255 },
    },
  })
    .png()
    .toBuffer();

/**
 * Create a noisy test image that compresses differently at various quality
 * levels. Solid-color images compress to near-identical sizes regardless of
 * quality; noise introduces entropy that makes lossy quality visible.
 */
const createNoisyTestImage = async (width: number, height: number): Promise<Buffer> => {
  const channels = 3;
  const pixelCount = width * height * channels;
  const raw = Buffer.alloc(pixelCount);
  // Simple deterministic pseudo-noise: alternating gradient patterns
  for (let i = 0; i < pixelCount; i++) {
    raw[i] = (i * 7 + (i % 3) * 97) % 256;
  }
  return sharp(raw, { raw: { width, height, channels } }).jpeg().toBuffer();
};

// =============================================================================
// TESTS
// =============================================================================

describe('ImageProcessor', () => {
  const processor = new ImageProcessor();

  describe('EXIF stripping', () => {
    it('strips EXIF metadata from the output', async () => {
      // Create a JPEG with EXIF data injected via sharp
      const inputBuffer = await sharp({
        create: {
          width: 400,
          height: 300,
          channels: 3,
          background: { r: 100, g: 200, b: 50 },
        },
      })
        .jpeg()
        .withExifMerge({
          IFD0: {
            ImageDescription: 'test image with exif',
          },
        })
        .toBuffer();

      // Verify the input has EXIF data
      const inputMeta = await sharp(inputBuffer).metadata();
      expect(inputMeta.exif).toBeDefined();

      const result = await processor.process(inputBuffer);

      // The output should have EXIF stripped
      const outputMeta = await sharp(result.resized).metadata();
      expect(outputMeta.exif).toBeUndefined();
      expect(result.exifStripped).toBe(true);
    });
  });

  describe('resize behavior', () => {
    it('resizes large image to max 2048px preserving aspect ratio', async () => {
      const inputBuffer = await createTestImage(4000, 3000);

      const result = await processor.process(inputBuffer);

      // Longest side should be capped at 2048
      expect(result.resizedWidth).toBe(2048);
      // Aspect ratio 4000:3000 = 4:3, so height = 2048 * (3/4) = 1536
      expect(result.resizedHeight).toBe(1536);
    });

    it('does not enlarge small images', async () => {
      const inputBuffer = await createTestImage(100, 100);

      const result = await processor.process(inputBuffer);

      expect(result.resizedWidth).toBe(100);
      expect(result.resizedHeight).toBe(100);
    });

    it('resizes when only width exceeds max dimension', async () => {
      const inputBuffer = await createTestImage(3000, 1000);

      const result = await processor.process(inputBuffer);

      expect(result.resizedWidth).toBe(2048);
      // Aspect ratio 3000:1000 = 3:1, so height = 2048 / 3 ~= 683
      expect(result.resizedHeight).toBe(Math.round(2048 * (1000 / 3000)));
    });

    it('resizes when only height exceeds max dimension', async () => {
      const inputBuffer = await createTestImage(1000, 3000);

      const result = await processor.process(inputBuffer);

      // Height is the longest side, so it becomes 2048
      expect(result.resizedHeight).toBe(2048);
      // Width = 2048 * (1000/3000) ~= 683
      expect(result.resizedWidth).toBe(Math.round(2048 * (1000 / 3000)));
    });

    it('handles square images', async () => {
      const inputBuffer = await createTestImage(3000, 3000);

      const result = await processor.process(inputBuffer);

      expect(result.resizedWidth).toBe(2048);
      expect(result.resizedHeight).toBe(2048);
    });

    it('does not resize images exactly at the max dimension', async () => {
      const inputBuffer = await createTestImage(2048, 1024);

      const result = await processor.process(inputBuffer);

      expect(result.resizedWidth).toBe(2048);
      expect(result.resizedHeight).toBe(1024);
    });
  });

  describe('thumbnail generation', () => {
    it('generates a 256px square thumbnail', async () => {
      const inputBuffer = await createTestImage(800, 600);

      const result = await processor.process(inputBuffer);

      expect(result.thumbnailWidth).toBe(256);
      expect(result.thumbnailHeight).toBe(256);
      expect(result.thumbnailSizeBytes).toBeGreaterThan(0);
    });

    it('generates a thumbnail from a very large image', async () => {
      const inputBuffer = await createTestImage(4000, 3000);

      const result = await processor.process(inputBuffer);

      expect(result.thumbnailWidth).toBe(256);
      expect(result.thumbnailHeight).toBe(256);
    });

    it('generates a thumbnail from a very small image', async () => {
      // Even for a 50x50 image, the thumbnail is upscaled to 256x256 (cover mode)
      const inputBuffer = await createTestImage(50, 50);

      const result = await processor.process(inputBuffer);

      expect(result.thumbnailWidth).toBe(256);
      expect(result.thumbnailHeight).toBe(256);
    });
  });

  describe('output format', () => {
    it('outputs WebP format by default', async () => {
      // Input is a PNG
      const inputBuffer = await createTestPng(400, 300);

      const result = await processor.process(inputBuffer);

      expect(result.format).toBe('webp');

      // Verify by checking the actual output metadata
      const outputMeta = await sharp(result.resized).metadata();
      expect(outputMeta.format).toBe('webp');

      const thumbMeta = await sharp(result.thumbnail).metadata();
      expect(thumbMeta.format).toBe('webp');
    });

    it('outputs JPEG when configured', async () => {
      const jpegProcessor = new ImageProcessor({ outputFormat: 'jpeg' });
      const inputBuffer = await createTestPng(400, 300);

      const result = await jpegProcessor.process(inputBuffer);

      expect(result.format).toBe('jpeg');
      const outputMeta = await sharp(result.resized).metadata();
      expect(outputMeta.format).toBe('jpeg');
    });

    it('outputs PNG when configured', async () => {
      const pngProcessor = new ImageProcessor({ outputFormat: 'png' });
      const inputBuffer = await createTestImage(400, 300);

      const result = await pngProcessor.process(inputBuffer);

      expect(result.format).toBe('png');
      const outputMeta = await sharp(result.resized).metadata();
      expect(outputMeta.format).toBe('png');
    });
  });

  describe('custom config', () => {
    it('respects custom maxDimension', async () => {
      const customProcessor = new ImageProcessor({ maxDimension: 512 });
      const inputBuffer = await createTestImage(1000, 800);

      const result = await customProcessor.process(inputBuffer);

      expect(result.resizedWidth).toBe(512);
      // 1000:800 = 5:4, so height = 512 * (800/1000) = 409.6 ~= 410
      expect(result.resizedHeight).toBe(Math.round(512 * (800 / 1000)));
    });

    it('respects custom thumbnailSize', async () => {
      const customProcessor = new ImageProcessor({ thumbnailSize: 128 });
      const inputBuffer = await createTestImage(800, 600);

      const result = await customProcessor.process(inputBuffer);

      expect(result.thumbnailWidth).toBe(128);
      expect(result.thumbnailHeight).toBe(128);
    });

    it('respects custom quality setting', async () => {
      const highQ = new ImageProcessor({ quality: 100 });
      const lowQ = new ImageProcessor({ quality: 10 });
      // Use a noisy image so lossy quality differences are measurable
      const inputBuffer = await createNoisyTestImage(400, 300);

      const highResult = await highQ.process(inputBuffer);
      const lowResult = await lowQ.process(inputBuffer);

      // Higher quality should produce a larger file than lower quality
      expect(highResult.resizedSizeBytes).toBeGreaterThan(lowResult.resizedSizeBytes);
    });
  });

  describe('result metadata', () => {
    it('populates all result fields', async () => {
      const inputBuffer = await createTestImage(800, 600);

      const result = await processor.process(inputBuffer);

      // Resized fields
      expect(result.resized).toBeInstanceOf(Buffer);
      expect(result.resizedWidth).toBeGreaterThan(0);
      expect(result.resizedHeight).toBeGreaterThan(0);
      expect(result.resizedSizeBytes).toBe(result.resized.length);

      // Thumbnail fields
      expect(result.thumbnail).toBeInstanceOf(Buffer);
      expect(result.thumbnailWidth).toBeGreaterThan(0);
      expect(result.thumbnailHeight).toBeGreaterThan(0);
      expect(result.thumbnailSizeBytes).toBe(result.thumbnail.length);

      // Metadata fields
      expect(result.format).toBe('webp');
      expect(result.exifStripped).toBe(true);
    });
  });
});
