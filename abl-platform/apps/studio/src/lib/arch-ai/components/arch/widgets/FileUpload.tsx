'use client';
import { motion } from 'framer-motion';

import { useState, useCallback, useRef } from 'react';
import { clsx } from 'clsx';
import type { FileUploadInput, FileUploadAnswer } from './types';
import { archFileMatchesAccept, normalizeArchUploadMimeType } from '@/lib/arch-ai/file-mime';

interface FileUploadProps {
  input: FileUploadInput;
  onSubmit: (answer: FileUploadAnswer[]) => void;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB per contract 5

/**
 * FileUpload widget — Contract 5
 * Drag-drop zone + browse button. Type filter. Max file count.
 * Returns base64-encoded file content.
 */
export function FileUpload({ input, onSubmit }: FileUploadProps) {
  const { accept, maxFiles = 1 } = input;
  const [files, setFiles] = useState<File[]>([]);
  const [errors, setErrors] = useState<string[]>([]);
  const [submitted, setSubmitted] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const validateFile = useCallback(
    (file: File): string | null => {
      if (file.size > MAX_FILE_SIZE) {
        return `${file.name}: File too large (max 10MB)`;
      }
      if (accept && accept.length > 0) {
        const matches = accept.some((pattern) =>
          archFileMatchesAccept(file.name, file.type, pattern),
        );
        if (!matches) {
          return `${file.name}: Wrong file type`;
        }
      }
      return null;
    },
    [accept],
  );

  const addFiles = useCallback(
    (newFiles: FileList | File[]) => {
      const fileArray = Array.from(newFiles);
      const newErrors: string[] = [];
      const validFiles: File[] = [];

      for (const file of fileArray) {
        const error = validateFile(file);
        if (error) {
          newErrors.push(error);
        } else {
          validFiles.push(file);
        }
      }

      setErrors(newErrors);
      setFiles((prev) => {
        const combined = [...prev, ...validFiles];
        return combined.slice(0, maxFiles);
      });
    },
    [validateFile, maxFiles],
  );

  const handleSubmit = useCallback(async () => {
    if (files.length === 0 || submitted) return;
    setSubmitted(true);

    const results: FileUploadAnswer[] = await Promise.all(
      files.map(
        (file) =>
          new Promise<FileUploadAnswer>((resolve) => {
            const reader = new FileReader();
            reader.onload = () => {
              const base64 = (reader.result as string).split(',')[1] ?? '';
              resolve({
                name: file.name,
                size: file.size,
                type: normalizeArchUploadMimeType(file.name, file.type),
                content: base64,
              });
            };
            reader.readAsDataURL(file);
          }),
      ),
    );

    onSubmit(results);
  }, [files, submitted, onSubmit]);

  const removeFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  if (submitted) {
    return (
      <div className="my-3 rounded-lg border border-border/50 bg-background-muted/30 px-4 py-3 text-sm text-foreground-muted">
        {files.map((f) => f.name).join(', ')}
      </div>
    );
  }

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3 flex flex-col gap-2"
    >
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setIsDragOver(true);
        }}
        onDragLeave={() => setIsDragOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setIsDragOver(false);
          addFiles(e.dataTransfer.files);
        }}
        onClick={() => fileInputRef.current?.click()}
        className={clsx(
          'flex cursor-pointer flex-col items-center justify-center rounded-lg border-2 border-dashed px-6 py-8 text-sm transition-colors',
          isDragOver ? 'border-accent bg-accent/5' : 'border-border hover:border-accent/50',
        )}
      >
        <p className="text-foreground-muted">
          Drop files here or <span className="text-accent">browse</span>
        </p>
        {accept && (
          <p className="mt-1 text-xs text-foreground-muted/60">Accepted: {accept.join(', ')}</p>
        )}
        <input
          ref={fileInputRef}
          type="file"
          multiple={maxFiles > 1}
          accept={accept?.join(',')}
          onChange={(e) => {
            const selectedFiles = Array.from(e.target.files ?? []);
            if (selectedFiles.length > 0) addFiles(selectedFiles);
            e.target.value = '';
          }}
          className="hidden"
        />
      </div>

      {files.map((file, i) => (
        <div
          key={`${file.name}-${i}`}
          className="flex items-center justify-between rounded-lg border border-border px-3 py-2 text-sm"
        >
          <span className="truncate">{file.name}</span>
          <button
            onClick={() => removeFile(i)}
            className="ml-2 text-foreground-muted hover:text-destructive"
          >
            &times;
          </button>
        </div>
      ))}

      {errors.map((error, i) => (
        <p key={i} className="text-xs text-destructive">
          {error}
        </p>
      ))}

      <button
        onClick={handleSubmit}
        disabled={files.length === 0}
        className="btn-press self-end rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-foreground transition-colors hover:bg-accent-muted disabled:opacity-50"
      >
        Upload
      </button>
    </motion.div>
  );
}
