'use client';

import { useState, useCallback, useRef } from 'react';
import { clsx } from 'clsx';
import { Paperclip, X, FileText, Image as ImageIcon } from 'lucide-react';
import { normalizeArchUploadMimeType } from '@/lib/arch-ai/file-mime';

const TEXT_TYPES = [
  'application/pdf',
  'text/markdown',
  'application/json',
  'application/yaml',
  'application/x-yaml',
  'text/yaml',
  'text/plain',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
];

const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

const ALL_ACCEPTED = [...TEXT_TYPES, ...IMAGE_TYPES];

export const ACCEPT_EXTENSIONS = '.pdf,.md,.json,.yaml,.yml,.txt,.docx,.png,.jpg,.jpeg,.webp,.gif';

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB
const MAX_TEXT_FILES = 10; // S1-F10 req 3
const MAX_IMAGE_FILES = 5; // S1-F11 req 7

export interface PendingFile {
  file: File;
  preview?: string; // Data URL for image thumbnails
}

interface FileAttachmentProps {
  files: PendingFile[];
  onChange: (files: PendingFile[]) => void;
  disabled?: boolean;
}

/**
 * FileAttachment — chat input file attachment area.
 * S1-F10: text file upload (PDF, MD, JSON, YAML, TXT, DOCX)
 * S1-F11: image upload with thumbnails (PNG, JPEG, WebP, GIF)
 * Contract 1: files sent as FileAttachment[] in MessageRequest
 */
export function FileAttachment({ files, onChange, disabled }: FileAttachmentProps) {
  const [errors, setErrors] = useState<string[]>([]);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(
    (newFiles: FileList | File[]) => {
      const fileArray = Array.from(newFiles);
      const newErrors: string[] = [];
      const toAdd: PendingFile[] = [];

      const currentTextCount = files.filter(
        (f) => !IMAGE_TYPES.includes(normalizeArchUploadMimeType(f.file.name, f.file.type)),
      ).length;
      const currentImageCount = files.filter((f) =>
        IMAGE_TYPES.includes(normalizeArchUploadMimeType(f.file.name, f.file.type)),
      ).length;

      let addedText = 0;
      let addedImages = 0;

      for (const file of fileArray) {
        if (file.size > MAX_FILE_SIZE) {
          newErrors.push(`${file.name}: File too large (max 10MB)`);
          continue;
        }

        const normalizedType = normalizeArchUploadMimeType(file.name, file.type);

        if (!ALL_ACCEPTED.includes(normalizedType)) {
          newErrors.push(`${file.name}: Unsupported file type`);
          continue;
        }

        const isImage = IMAGE_TYPES.includes(normalizedType);

        if (isImage && currentImageCount + addedImages >= MAX_IMAGE_FILES) {
          newErrors.push(`Maximum ${MAX_IMAGE_FILES} images per message`);
          continue;
        }

        if (!isImage && currentTextCount + addedText >= MAX_TEXT_FILES) {
          newErrors.push(`Maximum ${MAX_TEXT_FILES} files per message`);
          continue;
        }

        if (isImage) {
          addedImages++;
          const preview = URL.createObjectURL(file);
          toAdd.push({ file, preview });
        } else {
          addedText++;
          toAdd.push({ file });
        }
      }

      setErrors(newErrors);
      if (toAdd.length > 0) {
        onChange([...files, ...toAdd]);
      }
    },
    [files, onChange],
  );

  const removeFile = useCallback(
    (index: number) => {
      const removed = files[index];
      if (removed.preview) {
        URL.revokeObjectURL(removed.preview);
      }
      onChange(files.filter((_, i) => i !== index));
    },
    [files, onChange],
  );

  return (
    <>
      {/* File previews */}
      {files.length > 0 && (
        <div className="flex flex-wrap gap-2 px-3 pt-2">
          {files.map((pf, i) => (
            <div
              key={`${pf.file.name}-${i}`}
              className="group relative flex items-center gap-1.5 rounded-lg border border-border bg-background-muted/30 px-2 py-1.5 text-xs"
            >
              {pf.preview ? (
                <img src={pf.preview} alt={pf.file.name} className="h-8 w-8 rounded object-cover" />
              ) : (
                <FileText className="h-3.5 w-3.5 text-foreground-muted" />
              )}
              <span className="max-w-[120px] truncate">{pf.file.name}</span>
              {!disabled && (
                <button
                  onClick={() => removeFile(i)}
                  className="text-foreground-muted hover:text-destructive"
                >
                  <X className="h-3 w-3" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Errors */}
      {errors.length > 0 && (
        <div className="px-3 pt-1">
          {errors.map((err, i) => (
            <p key={i} className="text-xs text-destructive">
              {err}
            </p>
          ))}
        </div>
      )}

      {/* Hidden file input */}
      <input
        ref={fileInputRef}
        type="file"
        multiple
        accept={ACCEPT_EXTENSIONS}
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files);
          e.target.value = '';
        }}
        className="hidden"
      />
    </>
  );
}

/**
 * Attachment button for the chat input toolbar.
 */
export function AttachButton({ onClick, disabled }: { onClick: () => void; disabled?: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className="rounded-lg p-2 text-foreground-muted hover:bg-background-muted hover:text-foreground disabled:opacity-50"
      title="Attach file"
    >
      <Paperclip className="h-4 w-4" />
    </button>
  );
}

/**
 * Convert PendingFile[] to FileAttachment[] for the MessageRequest.
 * Contract 1: { name, size, type, content: base64 }
 */
export async function encodeFilesForRequest(
  files: PendingFile[],
): Promise<Array<{ name: string; size: number; type: string; content: string }>> {
  return Promise.all(
    files.map(
      (pf) =>
        new Promise<{ name: string; size: number; type: string; content: string }>((resolve) => {
          const reader = new FileReader();
          reader.onload = () => {
            const base64 = (reader.result as string).split(',')[1] ?? '';
            resolve({
              name: pf.file.name,
              size: pf.file.size,
              type: normalizeArchUploadMimeType(pf.file.name, pf.file.type),
              content: base64,
            });
          };
          reader.readAsDataURL(pf.file);
        }),
    ),
  );
}
