'use client';

/**
 * ChatInput — Text area with send button, file upload (drag-drop, paste, picker).
 */

import React, { useState, useRef, useCallback, useEffect } from 'react';
import { SendIcon, AttachIcon } from './icons.js';
import { useStrings } from '../strings/StringsProvider.js';
import * as styles from './sdk-styles.js';

interface ChatInputProps {
  /** Called when the user sends a message */
  onSend: (text: string, attachmentIds?: string[]) => void;
  /** Called when the user uploads a file; returns the attachment ID */
  onUploadFile?: (file: File) => Promise<string>;
  /** Disable the input (e.g., while streaming) */
  disabled?: boolean;
  /** Custom placeholder text (falls back to strings) */
  placeholder?: string;
}

export function ChatInput({
  onSend,
  onUploadFile,
  disabled,
  placeholder,
}: ChatInputProps): React.ReactElement {
  const strings = useStrings();
  const [text, setText] = useState('');
  const [pendingUploads, setPendingUploads] = useState<string[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const [isSending, setIsSending] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const textAreaRef = useRef<HTMLTextAreaElement>(null);

  const [uploadError, setUploadError] = useState<string | null>(null);

  const handleUpload = useCallback(
    async (file: File) => {
      if (!onUploadFile) return;
      try {
        setUploadError(null);
        const id = await onUploadFile(file);
        setPendingUploads((prev) => [...prev, id]);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setUploadError(`Upload failed: ${message}`);
      }
    },
    [onUploadFile],
  );

  const handleSend = useCallback(async () => {
    const trimmed = text.trim();
    if (!trimmed && pendingUploads.length === 0) return;
    if (isSending) return;

    setIsSending(true);
    try {
      onSend(trimmed, pendingUploads.length > 0 ? pendingUploads : undefined);
      setText('');
      setPendingUploads([]);
    } finally {
      setIsSending(false);
    }
  }, [text, pendingUploads, onSend, isSending]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        void handleSend();
      }
    },
    [handleSend],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent) => {
      if (!onUploadFile) return;
      const files = Array.from(e.clipboardData.files);
      for (const file of files) {
        void handleUpload(file);
      }
    },
    [onUploadFile, handleUpload],
  );

  const handleDragOver = useCallback(
    (e: React.DragEvent) => {
      if (!onUploadFile) return;
      e.preventDefault();
      setIsDragging(true);
    },
    [onUploadFile],
  );

  const handleDragLeave = useCallback(() => {
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      if (!onUploadFile) return;
      const files = Array.from(e.dataTransfer.files);
      for (const file of files) {
        void handleUpload(file);
      }
    },
    [onUploadFile, handleUpload],
  );

  const handleFileSelect = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(e.target.files ?? []);
      for (const file of files) {
        void handleUpload(file);
      }
      // Reset input so the same file can be selected again
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    },
    [handleUpload],
  );

  // Auto-resize textarea to fit content
  useEffect(() => {
    const el = textAreaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }, [text]);

  const isDisabled = disabled || isSending;
  const canSend = (text.trim().length > 0 || pendingUploads.length > 0) && !isDisabled;

  return React.createElement(
    'div',
    {
      style: { ...styles.inputContainer, position: 'relative' },
      onDragOver: handleDragOver,
      onDragLeave: handleDragLeave,
      onDrop: handleDrop,
      'data-testid': 'chat-input',
    },
    // Drop zone overlay
    isDragging ? React.createElement('div', { style: styles.dropZone }, strings.dropFiles) : null,

    // Attach button
    onUploadFile
      ? React.createElement(
          'button',
          {
            type: 'button',
            style: styles.attachButton,
            onClick: () => fileInputRef.current?.click(),
            disabled: isDisabled,
            'aria-label': strings.attachFile,
          },
          React.createElement(AttachIcon, null),
        )
      : null,

    // Hidden file input
    onUploadFile
      ? React.createElement('input', {
          ref: fileInputRef,
          type: 'file',
          multiple: true,
          style: { display: 'none' },
          onChange: handleFileSelect,
        })
      : null,

    // Text area
    React.createElement('textarea', {
      ref: textAreaRef,
      style: styles.textArea,
      value: text,
      onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => setText(e.target.value),
      onKeyDown: handleKeyDown,
      onPaste: handlePaste,
      placeholder: placeholder ?? strings.inputPlaceholder,
      disabled: isDisabled,
      rows: 1,
      'aria-label': strings.inputPlaceholder,
    }),

    // Pending uploads indicator
    pendingUploads.length > 0
      ? React.createElement(
          'span',
          {
            style: {
              fontSize: '0.75em',
              color: 'var(--sdk-text-muted, #64748b)',
              alignSelf: 'center',
            },
          },
          strings.pendingFiles
            ? strings.pendingFiles.replace('{count}', String(pendingUploads.length))
            : `${pendingUploads.length} file${pendingUploads.length > 1 ? 's' : ''}`,
        )
      : null,

    // Upload error feedback
    uploadError
      ? React.createElement(
          'span',
          {
            role: 'alert',
            style: {
              fontSize: '0.75em',
              color: 'var(--sdk-error, #ef4444)',
              alignSelf: 'center',
            },
          },
          uploadError,
        )
      : null,

    // Send button
    React.createElement(
      'button',
      {
        type: 'button',
        style: canSend ? styles.sendButton : styles.sendButtonDisabled,
        onClick: () => void handleSend(),
        disabled: !canSend,
        'aria-label': strings.sendButton,
      },
      React.createElement(SendIcon, null),
    ),
  );
}
