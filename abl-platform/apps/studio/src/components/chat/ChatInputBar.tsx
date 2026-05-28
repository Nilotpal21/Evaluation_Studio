'use client';

import React, {
  useRef,
  useState,
  useEffect,
  useCallback,
  type KeyboardEvent,
  type ChangeEvent,
  type ClipboardEvent,
} from 'react';
import {
  AlertCircle,
  ArrowUp,
  Check,
  Clock3,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Loader2,
  Paperclip,
  Square,
  X,
} from 'lucide-react';
import { clsx } from 'clsx';
import { ARCH_AI_FILES } from '@/lib/arch-ai/constants';

const ACCEPTED_FILE_TYPES = ARCH_AI_FILES.ACCEPTED_UPLOAD_EXTENSIONS.join(',');
const MAX_ATTACHMENT_COUNT = ARCH_AI_FILES.MAX_FILES;
const ATTACHMENT_CAPTION = `Up to ${ARCH_AI_FILES.MAX_FILES} files, ${(ARCH_AI_FILES.MAX_FILE_SIZE_BYTES / (1024 * 1024)).toFixed(0)}MB each`;

function getFileKey(file: File): string {
  return `${file.name}:${file.size}:${file.lastModified}:${file.type}`;
}

function formatBytes(size: number): string {
  if (size < 1024) {
    return `${size} B`;
  }
  if (size < 1024 * 1024) {
    return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KB`;
  }
  return `${(size / (1024 * 1024)).toFixed(size < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

export type ChatInputAttachmentState = 'uploading' | 'processing' | 'ready' | 'failed';

export interface ChatInputAttachment {
  id: string;
  name: string;
  size: number;
  mediaType: string;
  status: ChatInputAttachmentState;
  progress?: number;
  detail?: string | null;
}

interface ChatInputBarProps {
  onSend: (text: string, files: File[]) => void;
  disabled?: boolean;
  disabledReason?: 'project-created' | 'streaming' | 'connecting' | 'widget-pending' | 'generating';
  placeholder?: string;
  isStreaming?: boolean;
  onStop?: () => void;
  variant?: 'default' | 'compact';
  showModelLabel?: boolean;
  footer?: React.ReactNode;
  autoFocus?: boolean;
  maxLength?: number;
  ariaLabel?: string;
  inputTestId?: string;
  sendButtonTestId?: string;
  attachments?: ChatInputAttachment[];
  onAttachFiles?: (files: File[]) => void;
  onRemoveAttachment?: (attachmentId: string) => void;
  attachmentHelperText?: string | null;
}

function buildLocalAttachment(file: File): ChatInputAttachment {
  return {
    id: getFileKey(file),
    name: file.name,
    size: file.size,
    mediaType: file.type,
    status: 'ready',
  };
}

function getAttachmentSummary(attachments: ChatInputAttachment[]): string | null {
  if (attachments.length === 0) {
    return null;
  }

  const readyCount = attachments.filter((attachment) => attachment.status === 'ready').length;
  const failedCount = attachments.filter((attachment) => attachment.status === 'failed').length;
  const activeCount = attachments.length - readyCount - failedCount;

  const parts: string[] = [];
  if (readyCount > 0) {
    parts.push(`${readyCount} ready`);
  }
  if (activeCount > 0) {
    parts.push(`${activeCount} preparing`);
  }
  if (failedCount > 0) {
    parts.push(`${failedCount} failed`);
  }

  return parts.join(' • ');
}

function getDerivedAttachmentHelperText(
  attachments: ChatInputAttachment[],
  text: string,
  explicitHelper: string | null | undefined,
): string | null {
  if (explicitHelper) {
    return explicitHelper;
  }

  if (attachments.length === 0) {
    return null;
  }

  const hasFailedAttachments = attachments.some((attachment) => attachment.status === 'failed');
  if (hasFailedAttachments) {
    return 'Remove failed attachments before sending.';
  }

  const hasPendingAttachments = attachments.some(
    (attachment) => attachment.status === 'uploading' || attachment.status === 'processing',
  );
  if (hasPendingAttachments) {
    return "Preparing attachments. You can send when they're ready.";
  }

  if (text.trim().length === 0) {
    return 'Your attachments are ready. You can send without adding more text.';
  }

  return null;
}

function AttachmentStatusIcon({ status }: { status: ChatInputAttachmentState }) {
  switch (status) {
    case 'ready':
      return <Check className="h-3.5 w-3.5 text-success" />;
    case 'failed':
      return <AlertCircle className="h-3.5 w-3.5 text-error" />;
    case 'processing':
      return <Clock3 className="h-3.5 w-3.5 text-accent" />;
    case 'uploading':
    default:
      return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />;
  }
}

export function ChatInputBar({
  onSend,
  disabled = false,
  disabledReason,
  placeholder = 'Type a message...',
  isStreaming = false,
  onStop,
  variant = 'default',
  showModelLabel = true,
  footer,
  autoFocus = false,
  maxLength = 10000,
  ariaLabel,
  inputTestId = 'chat-input-textarea',
  sendButtonTestId,
  attachments,
  onAttachFiles,
  onRemoveAttachment,
  attachmentHelperText,
}: ChatInputBarProps) {
  const [text, setText] = useState('');
  const [files, setFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const dragCounterRef = useRef(0);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isComposingRef = useRef(false);

  const isCompact = variant === 'compact';
  const usesControlledAttachments = Array.isArray(attachments);
  const displayAttachments = usesControlledAttachments
    ? attachments
    : files.map((file) => buildLocalAttachment(file));
  const hasPendingAttachments = displayAttachments.some(
    (attachment) => attachment.status === 'uploading' || attachment.status === 'processing',
  );
  const hasFailedAttachments = displayAttachments.some(
    (attachment) => attachment.status === 'failed',
  );
  const hasReadyAttachments =
    displayAttachments.length > 0 &&
    displayAttachments.every((attachment) => attachment.status === 'ready');
  const allowAttachmentOnlySend =
    hasReadyAttachments && !hasPendingAttachments && !hasFailedAttachments;
  const canSend =
    !disabled &&
    text.length <= maxLength &&
    !hasPendingAttachments &&
    !hasFailedAttachments &&
    (text.trim().length > 0 || allowAttachmentOnlySend);
  const showCharCount = maxLength > 0 && text.length > maxLength * 0.8;
  const overLimit = text.length > maxLength;
  const summaryText = getAttachmentSummary(displayAttachments);
  const helperText = getDerivedAttachmentHelperText(displayAttachments, text, attachmentHelperText);

  const appendFiles = useCallback(
    (selectedFiles: File[]) => {
      if (selectedFiles.length === 0) return;

      if (onAttachFiles) {
        onAttachFiles(selectedFiles);
        return;
      }

      setFiles((prev) => {
        const merged = [...prev];
        const seen = new Set(prev.map(getFileKey));

        for (const file of selectedFiles) {
          const fileKey = getFileKey(file);
          if (seen.has(fileKey)) continue;
          if (merged.length >= MAX_ATTACHMENT_COUNT) break;
          seen.add(fileKey);
          merged.push(file);
        }

        return merged;
      });
    },
    [onAttachFiles],
  );

  useEffect(() => {
    if (autoFocus) {
      textareaRef.current?.focus();
    }
  }, [autoFocus]);

  function clearInputAfterSend() {
    setText('');
    if (!usesControlledAttachments) {
      setFiles([]);
    }
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  function handleSend() {
    if (!canSend) return;
    onSend(text.trim(), usesControlledAttachments ? [] : files);
    clearInputAfterSend();
  }

  function handleActionClick() {
    if (isStreaming && onStop) {
      onStop();
      setTimeout(() => textareaRef.current?.focus(), 0);
      return;
    }
    handleSend();
  }

  function handleKeyDown(e: KeyboardEvent<HTMLTextAreaElement>) {
    if (isComposingRef.current) return;
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  function handleTextChange(e: ChangeEvent<HTMLTextAreaElement>) {
    setText(e.target.value);
    const el = e.target;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 128)}px`;
  }

  function handleFileChange(e: ChangeEvent<HTMLInputElement>) {
    const selectedFiles = Array.from(e.target.files ?? []);
    appendFiles(selectedFiles);
    e.target.value = '';
    setTimeout(() => textareaRef.current?.focus(), 0);
  }

  const handlePaste = useCallback(
    (e: ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return;
      const items = e.clipboardData?.items;
      if (!items) return;

      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          const blob = item.getAsFile();
          if (!blob) return;

          const extension = item.type.split('/')[1] ?? 'png';
          const timestamp = Date.now();
          const namedFile = new File([blob], `screenshot-${timestamp}.${extension}`, {
            type: item.type,
          });

          appendFiles([namedFile]);
          return;
        }
      }
    },
    [appendFiles, disabled],
  );

  const handleDragEnter = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (disabled) return;
      dragCounterRef.current += 1;
      if (dragCounterRef.current === 1) {
        setIsDragging(true);
      }
    },
    [disabled],
  );

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragCounterRef.current -= 1;
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0;
      setIsDragging(false);
    }
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      dragCounterRef.current = 0;
      setIsDragging(false);
      if (disabled) return;

      const droppedFiles = Array.from(e.dataTransfer.files);
      if (droppedFiles.length > 0) {
        appendFiles(droppedFiles);
        setTimeout(() => textareaRef.current?.focus(), 0);
      }
    },
    [appendFiles, disabled],
  );

  function removeAttachment(attachmentId: string) {
    if (usesControlledAttachments) {
      onRemoveAttachment?.(attachmentId);
      return;
    }

    setFiles((prev) => prev.filter((file) => getFileKey(file) !== attachmentId));
  }

  const effectivePlaceholder =
    disabled && disabledReason === 'connecting'
      ? 'Connecting...'
      : disabled && disabledReason === 'generating'
        ? 'Generating agents...'
        : disabled && disabledReason === 'widget-pending'
          ? 'Waiting for your input above...'
          : disabled && disabledReason === 'streaming'
            ? 'Thinking...'
            : placeholder;

  const btnSize = isCompact ? 'h-7 w-7' : 'h-8 w-8';
  const iconSize = isCompact ? 'h-3.5 w-3.5' : 'h-4 w-4';

  return (
    <div
      className={clsx(isCompact ? 'bg-transparent' : 'bg-background')}
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div
        data-testid="chat-input-bar"
        className={clsx(
          'relative flex flex-col transition-all',
          isCompact ? 'rounded-xl' : 'rounded-2xl',
          isDragging
            ? 'border-info/50 shadow-[0_0_0_2px_hsl(var(--info)/0.2)]'
            : disabledReason === 'generating'
              ? 'border-accent/30 animate-pulse'
              : 'border-foreground/[0.08]',
          isCompact
            ? 'rounded-xl'
            : 'rounded-2xl shadow-sm focus-within:border-foreground/15 focus-within:shadow-md',
        )}
      >
        {isDragging && (
          <div className="absolute inset-0 z-10 flex items-center justify-center rounded-2xl bg-info/5">
            <span className="text-sm font-medium text-info">Drop files to attach</span>
          </div>
        )}

        {displayAttachments.length > 0 && (
          <div
            className={clsx(
              'border-b border-foreground/[0.06]',
              isCompact ? 'px-3 pb-2 pt-2' : 'px-4 pb-3 pt-3',
            )}
            role="status"
            aria-live="polite"
          >
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="min-w-0">
                <div className="text-[11px] font-medium uppercase tracking-[0.2em] text-foreground/45">
                  Attachments
                </div>
                {summaryText ? (
                  <div className="mt-1 text-xs text-foreground/55">{summaryText}</div>
                ) : null}
              </div>
              <div className="shrink-0 text-[11px] text-foreground/35">
                {displayAttachments.length}/{MAX_ATTACHMENT_COUNT}
              </div>
            </div>

            <div
              className={clsx(
                'flex gap-2 overflow-x-auto pb-1',
                isCompact ? 'snap-x snap-mandatory' : '',
              )}
              data-testid="chat-input-attachments"
            >
              {displayAttachments.map((attachment) => {
                const isImage = attachment.mediaType.startsWith('image/');
                return (
                  <div
                    key={attachment.id}
                    className={clsx(
                      'min-w-[200px] rounded-xl border border-foreground/[0.08] bg-foreground/[0.03]',
                      isCompact ? 'snap-start px-2.5 py-2' : 'px-3 py-2.5',
                    )}
                  >
                    <div className="flex items-start gap-2">
                      <div className="mt-0.5 rounded-lg bg-background p-1.5 text-foreground/50">
                        {isImage ? (
                          <ImageIcon className="h-3.5 w-3.5" />
                        ) : (
                          <FileText className="h-3.5 w-3.5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-start gap-2">
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm font-medium text-foreground/80">
                              {attachment.name}
                            </div>
                            <div className="mt-1 flex items-center gap-1.5 text-[11px] text-foreground/45">
                              <AttachmentStatusIcon status={attachment.status} />
                              <span className="capitalize">{attachment.status}</span>
                              <span>•</span>
                              <span>{formatBytes(attachment.size)}</span>
                            </div>
                          </div>
                          <button
                            type="button"
                            onClick={() => removeAttachment(attachment.id)}
                            className="rounded-md p-1 text-foreground/30 transition-colors hover:bg-foreground/[0.05] hover:text-foreground/55"
                            aria-label={`Remove ${attachment.name}`}
                          >
                            <X className="h-3.5 w-3.5" />
                          </button>
                        </div>

                        {typeof attachment.progress === 'number' &&
                        attachment.status === 'uploading' &&
                        attachment.progress > 0 &&
                        attachment.progress < 1 ? (
                          <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-accent/15">
                            <div
                              className="h-full rounded-full bg-accent transition-all"
                              style={{
                                width: `${Math.max(6, Math.round(attachment.progress * 100))}%`,
                              }}
                            />
                          </div>
                        ) : null}

                        {attachment.detail ? (
                          <div className="mt-2 text-[11px] leading-4 text-foreground/45">
                            {attachment.detail}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {disabled && disabledReason === 'project-created' && (
          <div className="absolute left-3 top-1/2 flex -translate-y-1/2 items-center gap-1.5 rounded-md bg-purple/[0.06] px-2 py-1 text-xs whitespace-nowrap text-purple/60 pointer-events-none">
            <ExternalLink className="h-3 w-3" />
            <span>Project ready</span>
          </div>
        )}

        <textarea
          data-testid={inputTestId}
          ref={textareaRef}
          value={text}
          onChange={handleTextChange}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onCompositionStart={() => {
            isComposingRef.current = true;
          }}
          onCompositionEnd={() => {
            isComposingRef.current = false;
          }}
          placeholder={effectivePlaceholder}
          disabled={disabled}
          rows={1}
          aria-label={ariaLabel ?? 'Message input'}
          className={clsx(
            'w-full resize-none bg-transparent text-foreground outline-none placeholder:text-foreground/30',
            isCompact
              ? 'min-h-[36px] max-h-[128px] px-3 pt-2.5 pb-1 text-sm'
              : 'min-h-[44px] max-h-[128px] px-4 pt-3 pb-1 text-[15px]',
          )}
        />

        <div
          className={clsx(
            'flex items-center justify-between',
            isCompact ? 'px-2 pb-2' : 'px-3 pb-2.5',
          )}
        >
          <div className="flex items-center gap-2">
            <button
              type="button"
              aria-label="Attach files"
              title="Attach files"
              disabled={disabled}
              onClick={() => fileInputRef.current?.click()}
              className={clsx(
                'flex items-center justify-center rounded-lg text-foreground/30 transition-colors hover:bg-foreground/[0.04] hover:text-foreground/60 disabled:opacity-40',
                btnSize,
              )}
            >
              <Paperclip className={iconSize} />
            </button>
            <input
              data-testid="chat-input-file-input"
              ref={fileInputRef}
              type="file"
              accept={ACCEPTED_FILE_TYPES}
              multiple
              className="hidden"
              onChange={handleFileChange}
            />
            {!isCompact && <span className="text-xs text-foreground/30">{ATTACHMENT_CAPTION}</span>}
          </div>

          <div className="flex items-center gap-2">
            {showCharCount && (
              <span
                className={clsx(
                  'text-[10px] tabular-nums',
                  overLimit ? 'font-medium text-error' : 'text-foreground/25',
                )}
              >
                {text.length.toLocaleString()} / {maxLength.toLocaleString()}
              </span>
            )}
            {showModelLabel && !isCompact && (
              <span className="text-xs text-foreground/25">Default</span>
            )}
            <button
              type="button"
              data-testid={sendButtonTestId}
              aria-label={isStreaming ? 'Stop generating' : 'Send message'}
              disabled={!canSend && !isStreaming}
              onClick={handleActionClick}
              className={clsx(
                'flex items-center justify-center rounded-lg transition-all',
                btnSize,
                isStreaming
                  ? 'text-foreground/40 hover:text-foreground/60'
                  : canSend
                    ? 'bg-foreground text-background hover:bg-foreground/90'
                    : 'bg-foreground/[0.06] text-foreground/20',
              )}
            >
              {isStreaming ? (
                <Square className={clsx(isCompact ? 'h-3 w-3' : 'h-3.5 w-3.5', 'fill-current')} />
              ) : (
                <ArrowUp className={iconSize} />
              )}
            </button>
          </div>
        </div>

        {helperText ? (
          <div
            className={clsx(
              'border-t border-foreground/[0.05] text-xs',
              hasFailedAttachments ? 'text-error' : 'text-foreground/45',
              isCompact ? 'px-3 pb-2 pt-2' : 'px-4 pb-3 pt-2',
            )}
          >
            {helperText}
          </div>
        ) : isCompact ? (
          <div className="px-3 pb-2 text-[11px] text-foreground/30">{ATTACHMENT_CAPTION}</div>
        ) : null}
      </div>

      {footer}
    </div>
  );
}
