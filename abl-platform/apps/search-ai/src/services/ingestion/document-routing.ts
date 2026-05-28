/**
 * Document Routing
 *
 * Single source of truth for routing documents to the correct extraction
 * pipeline based on MIME type. Used by both the upload route and the
 * ingestion worker so that format support stays in sync.
 */

export type ExtractionRoute = 'docling' | 'legacy' | 'json-chunking' | 'structured';

/**
 * MIME types supported by Docling (validated 2026-02-23)
 * CSV and JSON temporarily removed - need specialized structured data handling
 */
const DOCLING_SUPPORTED_TYPES = new Set([
  // Documents
  'application/pdf',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document', // .docx
  'application/msword', // .doc
  'application/vnd.openxmlformats-officedocument.presentationml.presentation', // .pptx
  'application/vnd.ms-powerpoint', // .ppt
  'text/html',

  // Images (with OCR)
  'image/png',
  'image/jpeg',
  'image/jpg',
  'image/tiff',
  'image/bmp',
  'image/webp',
]);

/**
 * MIME types that use legacy extraction (LlamaIndex path)
 * Plain text and markdown - extracted as single page, chunked in page-processing
 */
const LEGACY_TYPES = new Set([
  'text/plain',
  'text/markdown', // Markdown goes through LlamaIndex (Docling service doesn't support MD yet)
]);

/**
 * MIME types for structured data (CSV, Excel)
 * These files use the structured data ingestion API with metadata-only chunking
 */
const STRUCTURED_DATA_TYPES = new Set([
  'text/csv',
  'application/csv',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel', // .xls
]);

/**
 * MIME types for JSON record chunking
 * Each JSON record becomes a separate chunk (unstructured approach)
 */
const JSON_RECORD_TYPES = new Set(['application/json']);

/**
 * Map file extensions to MIME types.
 * Used when contentType is a bare extension (e.g. "pdf") or when
 * the browser sends "application/octet-stream".
 */
const EXTENSION_TO_MIME: Record<string, string> = {
  md: 'text/markdown',
  markdown: 'text/markdown',
  txt: 'text/plain',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  html: 'text/html',
  htm: 'text/html',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  tiff: 'image/tiff',
  bmp: 'image/bmp',
  webp: 'image/webp',
  csv: 'text/csv',
  json: 'application/json',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  xls: 'application/vnd.ms-excel',
};

/**
 * Detect MIME type from file extension when the stored contentType
 * is generic ("application/octet-stream") or a bare extension ("pdf").
 */
export function detectMimeTypeFromExtension(filename: string): string | null {
  const ext = filename.toLowerCase().split('.').pop();
  return ext ? EXTENSION_TO_MIME[ext] || null : null;
}

/**
 * Normalize a contentType value that may be a full MIME type, a bare
 * extension, or contain parameters (e.g. "application/pdf; charset=utf-8").
 * Returns a clean MIME type suitable for routing, or null.
 */
export function normalizeMimeType(contentType: string | null): string | null {
  if (contentType == null) return null;

  // Strip MIME parameters ("application/pdf; charset=utf-8" → "application/pdf")
  const base = contentType.split(';')[0].trim().toLowerCase();

  // If it looks like a full MIME type, return as-is
  if (base.includes('/')) return base;

  // Bare extension (e.g. "pdf", ".docx") → resolve via extension map
  const ext = base.replace(/^\./, '');
  return EXTENSION_TO_MIME[ext] || null;
}

/**
 * Check whether a MIME type or file extension is accepted for upload.
 * Returns true for any type that has a known extraction route.
 */
export function isSupportedUploadType(mimeTypeOrExt: string): boolean {
  // Try as MIME type first
  const normalized = normalizeMimeType(mimeTypeOrExt);
  if (normalized) {
    return (
      DOCLING_SUPPORTED_TYPES.has(normalized) ||
      LEGACY_TYPES.has(normalized) ||
      JSON_RECORD_TYPES.has(normalized) ||
      STRUCTURED_DATA_TYPES.has(normalized)
    );
  }
  // Unknown type
  return false;
}

/**
 * Route document to the appropriate extraction pipeline based on MIME type.
 * - Docling: PDF, Office docs, HTML, images (with OCR)
 * - Legacy: Plain text, markdown
 * - JSON Chunking: JSON files (each record becomes a chunk)
 * - Structured: CSV, Excel (metadata-only chunking)
 */
export function routeDocument(contentType: string | null): ExtractionRoute {
  const mime = normalizeMimeType(contentType);
  if (mime == null) return 'docling'; // Unknown → Docling (quality-first)

  if (DOCLING_SUPPORTED_TYPES.has(mime)) return 'docling';
  if (JSON_RECORD_TYPES.has(mime)) return 'json-chunking';
  if (STRUCTURED_DATA_TYPES.has(mime)) return 'structured';
  if (LEGACY_TYPES.has(mime)) return 'legacy';

  // Default to Docling for unknown types (quality-first approach)
  return 'docling';
}
