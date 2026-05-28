import { ARCH_AI_FILES } from '@/lib/arch-ai/constants';

const ARCH_UPLOAD_EXTENSION_TO_MIME: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.md': 'text/markdown',
  '.markdown': 'text/markdown',
  '.json': 'application/json',
  '.yaml': 'application/x-yaml',
  '.yml': 'application/x-yaml',
  '.txt': 'text/plain',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const ARCH_MIME_TYPE_ALIASES: Record<string, string> = {
  'application/acrobat': 'application/pdf',
  'application/x-pdf': 'application/pdf',
  'application/yaml': 'application/x-yaml',
  'text/md': 'text/markdown',
  'text/x-markdown': 'text/markdown',
  'text/x-yaml': 'application/x-yaml',
  'image/jpg': 'image/jpeg',
};

export function getArchFileExtension(fileName: string): string {
  const dotIndex = fileName.lastIndexOf('.');
  return dotIndex >= 0 ? fileName.slice(dotIndex).toLowerCase() : '';
}

export function normalizeArchDeclaredMimeType(mimeType: string): string {
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized) {
    return 'application/octet-stream';
  }
  return ARCH_MIME_TYPE_ALIASES[normalized] ?? normalized;
}

export function normalizeArchUploadMimeType(fileName: string, declaredMimeType: string): string {
  return (
    ARCH_UPLOAD_EXTENSION_TO_MIME[getArchFileExtension(fileName)] ??
    normalizeArchDeclaredMimeType(declaredMimeType)
  );
}

export function isAcceptedArchUploadMimeType(mimeType: string): boolean {
  return ARCH_AI_FILES.ACCEPTED_UPLOAD_MIME_TYPES.includes(
    mimeType as (typeof ARCH_AI_FILES.ACCEPTED_UPLOAD_MIME_TYPES)[number],
  );
}

export function resolveAcceptedArchUploadMimeType(
  fileName: string,
  declaredMimeType: string,
): string | null {
  const mimeType = normalizeArchUploadMimeType(fileName, declaredMimeType);
  return isAcceptedArchUploadMimeType(mimeType) ? mimeType : null;
}

export function archFileMatchesAccept(fileName: string, declaredMimeType: string, accept: string) {
  const normalizedMimeType = normalizeArchUploadMimeType(fileName, declaredMimeType);
  const normalizedAccept = accept.trim().toLowerCase();

  if (!normalizedAccept) {
    return false;
  }
  if (normalizedAccept.startsWith('.')) {
    return getArchFileExtension(fileName) === normalizedAccept;
  }
  if (normalizedAccept.endsWith('/*')) {
    return normalizedMimeType.startsWith(normalizedAccept.replace('/*', '/'));
  }
  return normalizedMimeType === normalizeArchDeclaredMimeType(normalizedAccept);
}
