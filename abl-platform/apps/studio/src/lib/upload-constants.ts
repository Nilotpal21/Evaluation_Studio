/**
 * Shared upload constants and helpers.
 *
 * Used by FileDropZone, FileUploadDialog, DocumentTable, and any component
 * that needs to validate uploadable file types or check source uploadability.
 */

/** File extensions accepted by the upload flow. */
export const ACCEPTED_EXTENSIONS = [
  '.pdf',
  '.docx',
  '.doc',
  '.pptx',
  '.ppt',
  '.html',
  '.htm',
  '.txt',
  '.md',
  '.json',
  '.csv',
  '.xlsx',
  '.xls',
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.bmp',
  '.tiff',
  '.tif',
  '.webp',
  '.svg',
];

/** Maximum file size in bytes (100 MB). */
export const MAX_FILE_SIZE = 100 * 1024 * 1024;

/** Extract the lowercase file extension (including the dot) from a filename. */
export function getExtension(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot).toLowerCase() : '';
}

/** Format a byte count as a human-readable string (B / KB / MB). */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Whether the given source type supports manual file uploads. */
export function isUploadableSource(sourceType: string): boolean {
  return sourceType === 'manual' || sourceType === 'file';
}

/** Map file extension to a human-friendly display type. Falls back to uppercase extension. */
const EXTENSION_DISPLAY_NAMES: Record<string, string> = {
  '.pdf': 'PDF',
  '.docx': 'DOCX',
  '.doc': 'DOC',
  '.pptx': 'PPTX',
  '.ppt': 'PPT',
  '.html': 'HTML',
  '.htm': 'HTML',
  '.txt': 'Text',
  '.md': 'Markdown',
  '.json': 'JSON',
  '.csv': 'CSV',
  '.xlsx': 'Excel',
  '.xls': 'Excel',
  '.png': 'PNG',
  '.jpg': 'JPEG',
  '.jpeg': 'JPEG',
  '.gif': 'GIF',
  '.bmp': 'BMP',
  '.tiff': 'TIFF',
  '.tif': 'TIFF',
  '.webp': 'WebP',
  '.svg': 'SVG',
};

export function getDisplayType(filename: string): string {
  const ext = getExtension(filename);
  return EXTENSION_DISPLAY_NAMES[ext] || ext.replace('.', '').toUpperCase() || 'Unknown';
}

/**
 * Normalize legacy source names for display.
 * Sources created before the rename still have "Document Upload" in the DB.
 */
export function getSourceDisplayName(name: string): string {
  if (name === 'Document Upload') return 'File Directory';
  return name;
}
