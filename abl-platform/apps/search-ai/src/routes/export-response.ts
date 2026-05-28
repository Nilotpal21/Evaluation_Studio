import type { Response } from 'express';

const DEFAULT_EXPORT_FILENAME = 'export.txt';
const MAX_FILENAME_LENGTH = 180;

const EXPORT_CONTENT_TYPES = new Set([
  'application/json',
  'text/csv',
  'text/markdown',
  'text/yaml',
  'application/x-yaml',
]);

export interface GeneratedExport {
  contentType: string;
  data: string;
  filename: string;
}

function sanitizeAttachmentFilename(filename: string): string {
  const sanitized = filename
    .replace(/[\r\n"]/g, '_')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .slice(0, MAX_FILENAME_LENGTH);

  return sanitized || DEFAULT_EXPORT_FILENAME;
}

export function sendGeneratedExport(res: Response, result: GeneratedExport): void {
  const contentType = EXPORT_CONTENT_TYPES.has(result.contentType)
    ? result.contentType
    : 'application/octet-stream';
  const body = Buffer.from(result.data, 'utf8');

  res.status(200);
  res.setHeader('Content-Type', `${contentType}; charset=utf-8`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="${sanitizeAttachmentFilename(result.filename)}"`,
  );
  res.setHeader('Content-Length', body.length);
  // nosemgrep: javascript.express.security.audit.xss.direct-response-write.direct-response-write -- Generated export data is delivered as a typed attachment with sanitized headers.
  res.end(body);
}
