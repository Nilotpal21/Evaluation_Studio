/**
 * Image Processing Pipeline
 *
 * Transforms uploaded images for storage and display:
 * - Strips EXIF metadata (privacy / compliance)
 * - Resizes to a maximum dimension cap while preserving aspect ratio
 * - Generates a square thumbnail (cover crop, center gravity)
 * - Converts to an optimized output format (WebP by default)
 *
 * Uses `sharp` for all pixel operations. All methods are fully async.
 */

import sharp from 'sharp';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Maximum width or height for the resized output (pixels). */
const MAX_DIMENSION = 2048;

/** Width and height of the square thumbnail (pixels). */
const THUMBNAIL_SIZE = 256;

/** Default output format when none is specified. */
const DEFAULT_OUTPUT_FORMAT: OutputFormat = 'webp';

/** Default compression quality (1-100). */
const DEFAULT_QUALITY = 80;

// =============================================================================
// TYPES
// =============================================================================

export type OutputFormat = 'webp' | 'jpeg' | 'png';

export interface ImageProcessorConfig {
  /** Maximum width or height for the resized image. Default: 2048. */
  maxDimension: number;
  /** Width and height of the square thumbnail. Default: 256. */
  thumbnailSize: number;
  /** Output format for both resized image and thumbnail. Default: 'webp'. */
  outputFormat: OutputFormat;
  /** Compression quality (1-100). Default: 80. */
  quality: number;
}

export interface ImageProcessResult {
  /** The resized/optimized image buffer. */
  resized: Buffer;
  resizedWidth: number;
  resizedHeight: number;
  resizedSizeBytes: number;
  /** The thumbnail buffer. */
  thumbnail: Buffer;
  thumbnailWidth: number;
  thumbnailHeight: number;
  thumbnailSizeBytes: number;
  /** Output format used (e.g. 'webp'). */
  format: string;
  /** Whether EXIF metadata was stripped. */
  exifStripped: boolean;
}

// =============================================================================
// IMAGE PROCESSOR
// =============================================================================

export class ImageProcessor {
  private readonly config: ImageProcessorConfig;

  constructor(config?: Partial<ImageProcessorConfig>) {
    this.config = {
      maxDimension: config?.maxDimension ?? MAX_DIMENSION,
      thumbnailSize: config?.thumbnailSize ?? THUMBNAIL_SIZE,
      outputFormat: config?.outputFormat ?? DEFAULT_OUTPUT_FORMAT,
      quality: config?.quality ?? DEFAULT_QUALITY,
    };
  }

  /**
   * Process an input image buffer through the full pipeline:
   * 1. Auto-rotate from EXIF orientation then strip all EXIF metadata
   * 2. Resize to fit within maxDimension x maxDimension (no upscaling)
   * 3. Convert to the configured output format
   * 4. Generate a square thumbnail (cover crop, centered)
   *
   * @param inputBuffer - Raw image bytes (any format sharp can decode)
   * @returns Processed image buffers with metadata
   */
  async process(inputBuffer: Buffer): Promise<ImageProcessResult> {
    // Load and inspect the original image
    const metadata = await sharp(inputBuffer).metadata();
    const originalWidth = metadata.width ?? 0;
    const originalHeight = metadata.height ?? 0;

    // -------------------------------------------------------------------------
    // Step 1 & 2: Strip EXIF (via .rotate()) and resize
    // -------------------------------------------------------------------------
    // .rotate() with no arguments auto-rotates based on EXIF orientation and
    // then removes EXIF data from the pipeline.
    const basePipeline = sharp(inputBuffer).rotate();

    const needsResize =
      originalWidth > this.config.maxDimension || originalHeight > this.config.maxDimension;

    if (needsResize) {
      basePipeline.resize(this.config.maxDimension, this.config.maxDimension, {
        fit: 'inside',
        withoutEnlargement: true,
      });
    }

    // -------------------------------------------------------------------------
    // Step 3: Convert to output format
    // -------------------------------------------------------------------------
    this.applyOutputFormat(basePipeline);
    const resizedBuffer = await basePipeline.toBuffer();

    // Read back the actual dimensions of the resized output
    const resizedMeta = await sharp(resizedBuffer).metadata();
    const resizedWidth = resizedMeta.width ?? 0;
    const resizedHeight = resizedMeta.height ?? 0;

    // -------------------------------------------------------------------------
    // Step 4: Generate thumbnail (cover crop, centered)
    // -------------------------------------------------------------------------
    const thumbnailPipeline = sharp(inputBuffer)
      .rotate()
      .resize(this.config.thumbnailSize, this.config.thumbnailSize, {
        fit: 'cover',
        position: 'centre',
      });

    this.applyOutputFormat(thumbnailPipeline);
    const thumbnailBuffer = await thumbnailPipeline.toBuffer();

    const thumbnailMeta = await sharp(thumbnailBuffer).metadata();
    const thumbnailWidth = thumbnailMeta.width ?? 0;
    const thumbnailHeight = thumbnailMeta.height ?? 0;

    return {
      resized: resizedBuffer,
      resizedWidth,
      resizedHeight,
      resizedSizeBytes: resizedBuffer.length,
      thumbnail: thumbnailBuffer,
      thumbnailWidth,
      thumbnailHeight,
      thumbnailSizeBytes: thumbnailBuffer.length,
      format: this.config.outputFormat,
      exifStripped: true,
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Apply the configured output format and quality to a sharp pipeline.
   */
  private applyOutputFormat(pipeline: sharp.Sharp): sharp.Sharp {
    switch (this.config.outputFormat) {
      case 'webp':
        return pipeline.webp({ quality: this.config.quality });
      case 'jpeg':
        return pipeline.jpeg({ quality: this.config.quality });
      case 'png':
        // PNG quality maps to compressionLevel (0-9). We scale from 1-100 range.
        return pipeline.png({
          compressionLevel: Math.round((this.config.quality / 100) * 9),
        });
      default: {
        // Exhaustive check — will cause a compile error if a format is added
        // to OutputFormat but not handled here.
        const _exhaustive: never = this.config.outputFormat;
        throw new Error(`Unsupported output format: ${_exhaustive}`);
      }
    }
  }
}
