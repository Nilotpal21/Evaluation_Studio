'use client';

import type { FileRef } from '@agent-platform/arch-ai';

interface FileListProps {
  files: FileRef[];
}

const TYPE_BADGES: Record<string, string> = {
  'application/json': 'JSON',
  'application/yaml': 'YAML',
  'text/yaml': 'YAML',
  'text/markdown': 'MD',
  'application/pdf': 'PDF',
  'text/plain': 'TXT',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'DOCX',
  'image/png': 'PNG',
  'image/jpeg': 'JPG',
};

function getTypeBadge(mimeType: string): string {
  return TYPE_BADGES[mimeType] ?? mimeType.split('/')[1]?.toUpperCase() ?? 'FILE';
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/**
 * FileList — displays uploaded file references with type badges.
 * S1-F12 req 16: icon, filename, size, type badge, remove button.
 */
export function FileList({ files }: FileListProps) {
  return (
    <div className="mt-1 flex flex-col gap-1.5">
      {files.map((file, i) => (
        <div
          key={`${file.name}-${i}`}
          className="flex items-center gap-2 rounded-lg border border-border/50 px-3 py-2 text-sm"
        >
          <span className="rounded bg-background-muted px-1.5 py-0.5 text-[10px] font-medium text-foreground-muted">
            {getTypeBadge(file.type)}
          </span>
          <span className="min-w-0 flex-1 truncate text-foreground">{file.name}</span>
          <span className="flex-shrink-0 text-xs text-foreground-muted">
            {formatSize(file.size)}
          </span>
        </div>
      ))}
    </div>
  );
}
