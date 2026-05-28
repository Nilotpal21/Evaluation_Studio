import type { AttachmentConfig } from '@agent-platform/shared';
import type { ResolvedAttachmentConfig } from './attachment-config-resolver.js';

const DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE = 10;
const DEFAULT_TOTAL_STORAGE_BYTES_PER_TENANT = 10 * 1024 * 1024 * 1024;
const DEFAULT_RETENTION_DAYS = { image: 90, document: 90, audio: 90, video: 90 };
const DEFAULT_ALLOWED_CATEGORIES: AttachmentConfig['allowedCategories'] = [
  'image',
  'document',
  'audio',
  'video',
];

const UPLOAD_EXTENSION_TO_MIME = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.txt': 'text/plain',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.doc': 'application/msword',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
} as const;

const MIME_TYPE_ALIASES = {
  'application/x-pdf': 'application/pdf',
  'application/acrobat': 'application/pdf',
  'text/x-markdown': 'text/markdown',
  'text/md': 'text/markdown',
  'image/jpg': 'image/jpeg',
} as const;

function getFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

function normalizeDeclaredMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized) {
    return 'application/octet-stream';
  }
  return MIME_TYPE_ALIASES[normalized as keyof typeof MIME_TYPE_ALIASES] ?? normalized;
}

export function normalizeUploadMimeType(fileName: string, declaredMimeType: string): string {
  const extension = getFileExtension(fileName);
  const extensionMime =
    UPLOAD_EXTENSION_TO_MIME[extension as keyof typeof UPLOAD_EXTENSION_TO_MIME];

  if (extensionMime) {
    return extensionMime;
  }

  return normalizeDeclaredMimeType(declaredMimeType);
}

export function mimeTypeMatchesAllowed(mimeType: string, allowedMimeTypes: string[]): boolean {
  if (allowedMimeTypes.length === 0) {
    return true;
  }

  return allowedMimeTypes.some((allowed) => {
    if (allowed === mimeType) {
      return true;
    }
    if (allowed.endsWith('/*')) {
      const prefix = allowed.slice(0, -1);
      return mimeType.startsWith(prefix);
    }
    return false;
  });
}

export function buildMultimodalUploadConfig(config: ResolvedAttachmentConfig): AttachmentConfig {
  return {
    enabled: config.enabled,
    maxFileSizeBytes: config.maxFileSizeBytes,
    maxAttachmentsPerMessage: DEFAULT_MAX_ATTACHMENTS_PER_MESSAGE,
    maxAttachmentsPerSession: config.maxFilesPerSession,
    maxTotalStorageBytesPerTenant: DEFAULT_TOTAL_STORAGE_BYTES_PER_TENANT,
    allowedCategories: DEFAULT_ALLOWED_CATEGORIES,
    retentionDays: DEFAULT_RETENTION_DAYS,
    allowedMimeTypes: config.allowedMimeTypes,
    quotas: { maxUploadsPerMinute: 60, maxConcurrentProcessingJobs: 10 },
  };
}
