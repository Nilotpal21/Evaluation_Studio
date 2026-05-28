'use client';

import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { Loader2, Paperclip, Send } from 'lucide-react';
import { useTranslations } from 'next-intl';

interface PendingUpload {
  attachmentId: string;
  name: string;
}

interface PreviewChatComposerProps {
  value: string;
  onValueChange: (value: string) => void;
  onSend: (text: string, attachmentIds?: string[]) => void;
  disabled?: boolean;
  placeholder: string;
  primaryColor: string;
  onUploadFile?: (file: File) => Promise<string>;
}

export function PreviewChatComposer({
  value,
  onValueChange,
  onSend,
  disabled = false,
  placeholder,
  primaryColor,
  onUploadFile,
}: PreviewChatComposerProps) {
  const t = useTranslations('preview');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [pendingUploads, setPendingUploads] = useState<PendingUpload[]>([]);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  useLayoutEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const next = Math.min(Math.max(el.scrollHeight, 44), 120);
    el.style.height = `${next}px`;
  }, [value]);

  const handleFileSelection = useCallback(
    async (files: FileList | null) => {
      if (!files || !onUploadFile) return;

      setUploadError(null);
      setIsUploading(true);
      try {
        for (const file of Array.from(files)) {
          const attachmentId = await onUploadFile(file);
          setPendingUploads((current) => [...current, { attachmentId, name: file.name }]);
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setUploadError(message);
      } finally {
        setIsUploading(false);
      }
    },
    [onUploadFile],
  );

  const handleSend = useCallback(() => {
    if (disabled || isUploading) return;

    const trimmed = value.trim();
    if (!trimmed && pendingUploads.length === 0) return;

    onSend(
      trimmed,
      pendingUploads.length > 0 ? pendingUploads.map((upload) => upload.attachmentId) : undefined,
    );
    onValueChange('');
    setPendingUploads([]);
    setUploadError(null);
  }, [disabled, isUploading, onSend, onValueChange, pendingUploads, value]);

  const canSend =
    !disabled && !isUploading && (value.trim().length > 0 || pendingUploads.length > 0);

  return (
    <div className="space-y-2" data-testid="preview-chat-composer">
      {pendingUploads.length > 0 ? (
        <p className="text-xs text-muted" data-testid="preview-chat-pending-uploads">
          {t('pending_files', { count: pendingUploads.length })}:{' '}
          {pendingUploads.map((upload) => upload.name).join(', ')}
        </p>
      ) : null}

      {uploadError ? (
        <p className="text-xs text-error" role="alert">
          {t('upload_failed', { message: uploadError })}
        </p>
      ) : null}

      <div className="flex items-center gap-2">
        {onUploadFile ? (
          <>
            <button
              type="button"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || isUploading}
              className="inline-flex h-10 w-10 items-center justify-center rounded-xl border border-default bg-background-subtle text-foreground transition-colors hover:bg-background-muted disabled:opacity-50"
              aria-label={t('attach_file')}
            >
              {isUploading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Paperclip className="h-4 w-4" />
              )}
            </button>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              data-testid="preview-chat-file-input"
              onChange={(event) => {
                void handleFileSelection(event.target.files);
                event.currentTarget.value = '';
              }}
            />
          </>
        ) : null}

        <textarea
          ref={textareaRef}
          rows={1}
          value={value}
          onChange={(event) => onValueChange(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              handleSend();
            }
          }}
          placeholder={placeholder}
          className="flex-1 bg-background-subtle text-foreground px-4 py-2.5 rounded-xl border border-default focus:outline-none focus:border-border-focus placeholder-subtle resize-none whitespace-pre-wrap leading-relaxed"
          style={{ minHeight: '44px', maxHeight: '120px' }}
          disabled={disabled}
        />

        <button
          type="button"
          onClick={handleSend}
          disabled={!canSend}
          className="p-2.5 rounded-xl transition-colors disabled:opacity-50"
          style={{ backgroundColor: primaryColor }}
          aria-label={t('send_button')}
        >
          <Send className="w-5 h-5 text-white" />
        </button>
      </div>
    </div>
  );
}
