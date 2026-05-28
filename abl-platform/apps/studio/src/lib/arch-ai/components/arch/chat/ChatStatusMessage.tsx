'use client';

/**
 * ChatStatusMessage — inline status messages shown in the chat stream.
 *
 * Renders as subtle system messages between user messages and assistant responses.
 * Used for: thinking timeout warnings, BUILD progress, error context.
 */

import { memo, useCallback, useEffect, useRef, useState } from 'react';
import { clsx } from 'clsx';
import type { StatusMessage, ArchError } from '@/lib/arch-ai/ui/hook';

// ─── Status Message List ──────────────────────────────────────────────────

interface ChatStatusMessagesProps {
  messages: StatusMessage[];
}

/** Renders a list of accumulated status messages as subtle inline indicators. */
export const ChatStatusMessages = memo(function ChatStatusMessages({
  messages,
}: ChatStatusMessagesProps) {
  if (messages.length === 0) return null;

  return (
    <div className="flex flex-col gap-0.5 px-4 py-1">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={clsx(
            'flex items-center gap-2 text-xs',
            msg.type === 'info' && 'text-foreground-muted/60',
            msg.type === 'warning' && 'text-warning/70',
            msg.type === 'error' && 'text-error/70',
            msg.type === 'success' && 'text-success/70',
          )}
        >
          <StatusDot type={msg.type} />
          <span>{msg.text}</span>
        </div>
      ))}
    </div>
  );
});

// ─── Inline Status Indicator ──────────────────────────────────────────────

interface InlineStatusProps {
  message: string | null;
  isStreaming: boolean;
}

/** Shows the current status message with a spinner during streaming. */
export const InlineStatus = memo(function InlineStatus({
  message,
  isStreaming,
}: InlineStatusProps) {
  if (!message) return null;

  return (
    <div className="flex items-center gap-2 px-4 py-2 text-xs text-foreground-muted/60">
      {isStreaming && (
        <span className="flex h-3 w-3 shrink-0 items-center justify-center">
          <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-foreground-muted/20 border-t-foreground-muted/60" />
        </span>
      )}
      <span>{message}</span>
    </div>
  );
});

// ─── Error Detail Bar (legacy — kept for non-Arch consumers) ─────────────

interface ErrorDetailBarProps {
  error: ArchError;
  onRetry?: () => void;
  onStartFresh?: () => void;
}

/** @deprecated Use ChatErrorToast for Arch AI chat. Kept for backward compat. */
export const ErrorDetailBar = memo(function ErrorDetailBar({
  error,
  onRetry,
  onStartFresh,
}: ErrorDetailBarProps) {
  return <ChatErrorToast error={error} onRetry={onRetry} onStartFresh={onStartFresh} />;
});

// ─── Chat Error Toast (subtle top-of-chat notification) ──────────────────

const AUTO_DISMISS_MS = 8_000;

const TRANSIENT_ERROR_TYPES: ReadonlySet<ArchError['type']> = new Set([
  'stream_timeout',
  'session_building',
  'network_error',
]);

interface ChatErrorToastProps {
  error: ArchError;
  onRetry?: () => void;
  onStartFresh?: () => void;
  onDismiss?: () => void;
}

export const ChatErrorToast = memo(function ChatErrorToast({
  error,
  onRetry,
  onStartFresh,
  onDismiss,
}: ChatErrorToastProps) {
  const [visible, setVisible] = useState(true);
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    setVisible(true);
    if (timerRef.current) clearTimeout(timerRef.current);

    if (TRANSIENT_ERROR_TYPES.has(error.type) && error.recoverable) {
      timerRef.current = setTimeout(() => {
        setVisible(false);
        onDismiss?.();
      }, AUTO_DISMISS_MS);
    }
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [error, onDismiss]);

  const handleDismiss = useCallback(() => {
    setVisible(false);
    onDismiss?.();
  }, [onDismiss]);

  const copyDetails = useCallback(async () => {
    const details = [
      `Error: ${error.message}`,
      `Type: ${error.type}`,
      error.technicalDetails ? `Details: ${error.technicalDetails}` : '',
      `Timestamp: ${new Date().toISOString()}`,
      `Recoverable: ${error.recoverable}`,
    ]
      .filter(Boolean)
      .join('\n');

    try {
      await navigator.clipboard.writeText(details);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // Clipboard API not available
    }
  }, [error]);

  if (!visible) return null;

  const isInfo = error.type === 'session_building';
  const isCritical = !error.recoverable && !isInfo;

  return (
    <div
      className={clsx(
        'sticky top-0 z-10 mx-4 mt-1 flex items-center gap-2 rounded-md backdrop-blur-sm transition-all',
        isCritical
          ? 'border border-error/20 bg-error/10 px-4 py-2.5 text-sm text-error'
          : isInfo
            ? 'border border-accent/15 bg-accent/[0.06] px-3 py-1.5 text-xs text-foreground-muted'
            : 'border border-warning/15 bg-warning/[0.06] px-3 py-1.5 text-xs text-foreground-muted',
      )}
    >
      {/* Icon */}
      <svg
        className={clsx(
          'shrink-0',
          isCritical
            ? 'h-4 w-4 text-error'
            : isInfo
              ? 'h-3.5 w-3.5 text-accent/70'
              : 'h-3.5 w-3.5 text-warning/70',
        )}
        fill="none"
        viewBox="0 0 24 24"
        stroke="currentColor"
        strokeWidth={2}
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d={
            isCritical
              ? 'M12 9v3.75m-9.303 3.376c-.866 1.5.217 3.374 1.948 3.374h14.71c1.73 0 2.813-1.874 1.948-3.374L13.949 3.378c-.866-1.5-3.032-1.5-3.898 0L2.697 16.126zM12 15.75h.007v.008H12v-.008z'
              : 'M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z'
          }
        />
      </svg>

      {/* Message */}
      <span className={clsx('min-w-0', isCritical ? 'break-words' : 'truncate')}>
        {error.message}
      </span>

      {/* Actions */}
      <div className="ml-auto flex shrink-0 items-center gap-1.5">
        {isCritical && (
          <a
            href="/admin/arch"
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/10"
          >
            Arch Settings
          </a>
        )}
        {error.recoverable && onRetry && (
          <button
            onClick={onRetry}
            className="rounded px-1.5 py-0.5 text-[11px] font-medium text-accent transition-colors hover:bg-accent/10"
          >
            Retry
          </button>
        )}
        {!isInfo && onStartFresh && (
          <button
            onClick={onStartFresh}
            className="rounded px-1.5 py-0.5 text-[11px] text-foreground-muted/70 transition-colors hover:bg-foreground/5"
          >
            New
          </button>
        )}
        <button
          onClick={copyDetails}
          className="rounded p-0.5 text-foreground-muted/50 transition-colors hover:bg-foreground/5 hover:text-foreground-muted"
          title="Copy error details"
        >
          {copied ? (
            <svg
              className="h-3 w-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
            </svg>
          ) : (
            <svg
              className="h-3 w-3"
              fill="none"
              viewBox="0 0 24 24"
              stroke="currentColor"
              strokeWidth={2}
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z"
              />
            </svg>
          )}
        </button>
        <button
          onClick={handleDismiss}
          className="rounded p-0.5 text-foreground-muted/40 transition-colors hover:text-foreground-muted"
          title="Dismiss"
        >
          <svg
            className="h-3 w-3"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      </div>
    </div>
  );
});

// ─── Helpers ──────────────────────────────────────────────────────────────

function StatusDot({ type }: { type: StatusMessage['type'] }) {
  return (
    <span
      className={clsx(
        'h-1 w-1 shrink-0 rounded-full',
        type === 'info' && 'bg-foreground-muted/40',
        type === 'warning' && 'bg-warning/60',
        type === 'error' && 'bg-error/60',
        type === 'success' && 'bg-success/60',
      )}
    />
  );
}
