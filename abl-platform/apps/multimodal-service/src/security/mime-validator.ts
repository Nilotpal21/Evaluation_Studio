/**
 * MIME Validation Utility
 *
 * Server-side magic-byte MIME detection using `file-type`.
 * Detects actual file type from buffer contents and compares against
 * the declared MIME type to prevent MIME spoofing attacks.
 */

import { fileTypeFromBuffer } from 'file-type';

// =============================================================================
// TYPES
// =============================================================================

export type AttachmentCategory = 'image' | 'document' | 'audio' | 'video';

export interface MimeValidationResult {
  /** Whether the declared MIME type matches the detected content category */
  valid: boolean;
  /** The MIME type detected from magic bytes, or 'unknown' if undetectable */
  detectedMimeType: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

/** MIME types classified under the 'document' category */
const DOCUMENT_MIMES = new Set([
  'application/pdf',
  'application/msword',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.ms-excel',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  'text/csv',
  'text/html',
  'text/plain',
  'text/markdown',
]);

/** Sentinel value returned when magic-byte detection finds no match */
const UNKNOWN_MIME_TYPE = 'unknown';

// =============================================================================
// PUBLIC API
// =============================================================================

/**
 * Validate a buffer's actual content type against its declared MIME type.
 *
 * Uses magic-byte detection (via `file-type`) to determine the real content type,
 * then compares the detected category against the declared category.
 * This prevents MIME spoofing (e.g., uploading an executable declared as image/png).
 *
 * Special handling:
 * - Plain text files have no magic bytes. `text/*` declarations are allowed
 *   when no magic bytes are detected.
 * - Validation compares attachment categories (image, document, audio, video),
 *   not exact MIME strings, to allow minor MIME variations within a category.
 *
 * @param buffer - The file content buffer to inspect
 * @param declaredMimeType - The MIME type declared by the client
 * @returns Validation result with detected MIME type
 */
export async function validateMime(
  buffer: Buffer,
  declaredMimeType: string,
): Promise<MimeValidationResult> {
  if (!buffer || buffer.length === 0) {
    return { valid: false, detectedMimeType: UNKNOWN_MIME_TYPE };
  }
  if (!declaredMimeType || !declaredMimeType.trim()) {
    return { valid: false, detectedMimeType: UNKNOWN_MIME_TYPE };
  }

  const detected = await fileTypeFromBuffer(buffer);

  if (!detected) {
    // Plain text files have no magic bytes — allow text/* declarations
    if (declaredMimeType.startsWith('text/')) {
      return { valid: true, detectedMimeType: declaredMimeType };
    }
    return { valid: false, detectedMimeType: UNKNOWN_MIME_TYPE };
  }

  const declaredCategory = mimeToCategory(declaredMimeType);
  const detectedCategory = mimeToCategory(detected.mime);

  return {
    valid: declaredCategory !== null && declaredCategory === detectedCategory,
    detectedMimeType: detected.mime,
  };
}

/**
 * Map a MIME type string to an attachment category.
 *
 * Categories:
 * - `image`: All `image/*` types
 * - `audio`: All `audio/*` types
 * - `video`: All `video/*` types
 * - `document`: PDFs, Office docs, and `text/*` types
 * - `null`: Unrecognized or uncategorized MIME types
 *
 * @param mime - The MIME type string to categorize
 * @returns The attachment category, or null if unrecognized
 */
export function mimeToCategory(mime: string): AttachmentCategory | null {
  if (mime.startsWith('image/')) return 'image';
  if (mime.startsWith('audio/')) return 'audio';
  if (mime.startsWith('video/')) return 'video';
  if (DOCUMENT_MIMES.has(mime) || mime.startsWith('text/')) return 'document';
  return null;
}
