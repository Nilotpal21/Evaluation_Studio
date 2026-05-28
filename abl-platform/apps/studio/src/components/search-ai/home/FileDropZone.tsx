/**
 * FileDropZone Component
 *
 * Reusable drag-and-drop zone for file uploads.
 * Validates file extensions and size before accepting.
 * Used by SetupGuide (Home tab) and potentially other upload flows.
 */

import { useState, useRef, useCallback } from 'react';
import { Upload } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { ACCEPTED_EXTENSIONS, MAX_FILE_SIZE, getExtension } from '@/lib/upload-constants';
import { Button } from '../../ui/Button';

interface FileDropZoneProps {
  onFilesSelected: (files: File[]) => void;
  disabled?: boolean;
}

function validateFiles(
  files: File[],
  t: (key: string, values?: Record<string, unknown>) => string,
): { valid: File[]; errors: string[] } {
  const valid: File[] = [];
  const errors: string[] = [];

  for (const file of files) {
    const ext = getExtension(file.name);
    if (!ACCEPTED_EXTENSIONS.includes(ext)) {
      errors.push(t('error_unsupported_type', { name: file.name }));
      continue;
    }
    if (file.size > MAX_FILE_SIZE) {
      errors.push(t('error_file_too_large', { name: file.name }));
      continue;
    }
    if (file.size === 0) {
      errors.push(t('error_empty_file', { name: file.name }));
      continue;
    }
    valid.push(file);
  }

  return { valid, errors };
}

export function FileDropZone({ onFilesSelected, disabled }: FileDropZoneProps) {
  const t = useTranslations('search_ai.file_drop_zone');
  const [isDragOver, setIsDragOver] = useState(false);
  const [validationErrors, setValidationErrors] = useState<string[]>([]);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = useCallback(
    (fileList: FileList | null) => {
      if (!fileList || fileList.length === 0) return;
      const files = Array.from(fileList);
      const { valid, errors } = validateFiles(
        files,
        t as (key: string, values?: Record<string, unknown>) => string,
      );
      setValidationErrors(errors);
      if (valid.length > 0) {
        onFilesSelected(valid);
      }
    },
    [onFilesSelected, t],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (!disabled) setIsDragOver(true);
    },
    [disabled],
  );

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragOver(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragOver(false);
      if (!disabled) {
        handleFiles(e.dataTransfer.files);
      }
    },
    [disabled, handleFiles],
  );

  const handleBrowse = useCallback(() => {
    inputRef.current?.click();
  }, []);

  const handleInputChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      handleFiles(e.target.files);
      // Reset so the same file can be re-selected
      if (inputRef.current) inputRef.current.value = '';
    },
    [handleFiles],
  );

  return (
    <div className="space-y-2">
      <div
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        onDrop={handleDrop}
        className={`
          flex flex-col items-center justify-center gap-3 rounded-xl border-2 border-dashed p-8
          transition-default
          ${disabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer'}
          ${
            isDragOver
              ? 'border-accent bg-accent/5'
              : 'border-default hover:border-border-focus hover:bg-background-muted'
          }
        `}
        onClick={disabled ? undefined : handleBrowse}
        role="button"
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(e) => {
          if (!disabled && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            handleBrowse();
          }
        }}
        aria-label={t('aria_drop_zone')}
      >
        <Upload className={`w-8 h-8 ${isDragOver ? 'text-accent' : 'text-muted'}`} />
        <div className="text-center">
          <p className="text-sm font-medium text-foreground">{t('drop_files_here')}</p>
          <p className="text-xs text-muted mt-1">{t('supported_formats')}</p>
          <p className="text-xs text-muted">{t('max_file_size')}</p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={disabled}
          onClick={(e) => {
            e.stopPropagation();
            handleBrowse();
          }}
        >
          {t('browse_files')}
        </Button>
      </div>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPTED_EXTENSIONS.join(',')}
        className="hidden"
        onChange={handleInputChange}
      />

      {validationErrors.length > 0 && (
        <div className="space-y-1">
          {validationErrors.map((err, i) => (
            <p key={i} className="text-xs text-error">
              {err}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}
