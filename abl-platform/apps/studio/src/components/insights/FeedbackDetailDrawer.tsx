/**
 * FeedbackDetailDrawer (ABLP-1084)
 *
 * Slide-out panel showing one feedback record plus the full conversation
 * of the session it belongs to. The agent message the operator rated is
 * highlighted in the timeline so it's obvious what the feedback was on.
 *
 * Messages come from `GET /api/runtime/sessions/:id/messages?projectId=...`
 * which serves the canonical persisted + live-merge conversation already
 * used by the admin Session Explorer.
 */

'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Check, Copy } from 'lucide-react';
import useSWR from 'swr';
import { SlidePanel } from '../ui/SlidePanel';
import { Button } from '../ui/Button';
import { Badge } from '../ui/Badge';
import { Skeleton } from '../ui/Skeleton';
import type { FeedbackItem } from '../../hooks/useFeedback';

// =============================================================================
// TYPES
// =============================================================================

interface FeedbackDetailDrawerProps {
  feedback: FeedbackItem | null;
  projectId: string;
  onClose: () => void;
}

interface SessionMessage {
  id: string;
  role: string;
  content: string;
  timestamp: string;
  metadata?: Record<string, unknown>;
}

interface MessagesResponse {
  success: boolean;
  messages?: SessionMessage[];
  nextCursor?: string | null;
  hasMore?: boolean;
  error?: string | { code: string; message: string };
}

// =============================================================================
// HELPERS
// =============================================================================

function formatTimestamp(ts: string): string {
  if (!ts) return '';
  try {
    const d = new Date(ts.endsWith('Z') ? ts : `${ts.replace(' ', 'T')}Z`);
    return d.toLocaleString();
  } catch {
    return ts;
  }
}

function formatRating(item: FeedbackItem): string {
  if (item.ratingType === 'thumbs') {
    return item.ratingValue === 1 ? '\u{1F44D} Thumbs up' : '\u{1F44E} Thumbs down';
  }
  if (item.ratingType === 'star') {
    return `${item.ratingValue} ★`;
  }
  return 'Text feedback';
}

// =============================================================================
// COPY BUTTON
// =============================================================================

export function CopyButton({
  value,
  label,
  className,
}: {
  value: string;
  label?: string;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, []);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(() => setCopied(false), 1500);
    } catch {
      // Clipboard write may fail silently in unsecured contexts — nothing the
      // user can do, so we don't surface an error toast.
    }
  };

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        void handleCopy();
      }}
      className={
        className ??
        'inline-flex items-center justify-center w-6 h-6 rounded text-muted hover:text-foreground hover:bg-background-muted transition-colors'
      }
      aria-label={label ?? `Copy ${value}`}
      title={copied ? 'Copied' : 'Copy'}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-success" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
}

// =============================================================================
// MESSAGE BUBBLE
// =============================================================================

function MessageBubble({
  message,
  highlighted,
  scrollRef,
}: {
  message: SessionMessage;
  highlighted: boolean;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
}) {
  const isUser = message.role === 'user';
  const isSystem = message.role === 'system' || message.role === 'tool';
  return (
    <div
      ref={highlighted ? scrollRef : undefined}
      className={
        'rounded-lg border px-4 py-3 ' +
        (highlighted
          ? 'border-accent bg-accent-subtle'
          : isUser
            ? 'border-default bg-background-elevated'
            : isSystem
              ? 'border-default bg-background-muted'
              : 'border-default bg-background')
      }
    >
      <div className="flex items-center justify-between mb-2">
        <div className="flex items-center gap-2">
          <Badge variant={isUser ? 'default' : isSystem ? 'warning' : 'info'} appearance="subtle">
            {message.role}
          </Badge>
          {highlighted && (
            <Badge variant="success" appearance="subtle">
              Rated message
            </Badge>
          )}
        </div>
        <span className="text-xs text-muted">{formatTimestamp(message.timestamp)}</span>
      </div>
      <div className="text-sm text-foreground whitespace-pre-wrap break-words">
        {message.content || <span className="text-muted">(empty)</span>}
      </div>
      <div className="mt-2 flex items-center gap-2 text-[10px] text-muted">
        <span className="font-mono" title={message.id}>
          {message.id}
        </span>
        <CopyButton value={message.id} label={`Copy message id ${message.id}`} />
      </div>
    </div>
  );
}

// =============================================================================
// DRAWER
// =============================================================================

export function FeedbackDetailDrawer({ feedback, projectId, onClose }: FeedbackDetailDrawerProps) {
  const open = !!feedback;
  const swrKey = useMemo(() => {
    if (!feedback || !projectId) return null;
    const params = new URLSearchParams();
    params.set('projectId', projectId);
    params.set('limit', '200');
    params.set('direction', 'asc');
    return `/api/runtime/sessions/${encodeURIComponent(feedback.sessionId)}/messages?${params.toString()}`;
  }, [feedback, projectId]);

  const { data, error, isLoading } = useSWR<MessagesResponse>(swrKey, {
    revalidateOnFocus: false,
    revalidateOnReconnect: false,
    revalidateIfStale: false,
    refreshInterval: 0,
    shouldRetryOnError: false,
  });

  const messages = data?.messages ?? [];
  const highlightedRef = useRef<HTMLDivElement | null>(null);

  // Scroll the rated message into view when the conversation loads.
  useEffect(() => {
    if (!open || messages.length === 0) return;
    const t = setTimeout(() => {
      highlightedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 50);
    return () => clearTimeout(t);
  }, [open, messages.length]);

  if (!feedback) {
    return null;
  }

  const errorMessage =
    !error && data && data.success === false
      ? typeof data.error === 'string'
        ? data.error
        : (data.error?.message ?? 'Failed to load session')
      : error
        ? String(error)
        : null;

  return (
    <SlidePanel
      open={open}
      onClose={onClose}
      width="2xl"
      title="Feedback detail"
      description={`Session ${feedback.sessionId}`}
    >
      <div className="space-y-6">
        {/* Feedback metadata */}
        <section className="rounded-lg border border-default bg-background-elevated p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Feedback</h3>
            <Badge variant="info" appearance="subtle">
              {formatRating(feedback)}
            </Badge>
          </div>
          <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm">
            <div>
              <dt className="text-xs text-muted">When</dt>
              <dd className="text-foreground">{formatTimestamp(feedback.timestamp)}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Agent</dt>
              <dd className="text-foreground">{feedback.agentName || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Channel</dt>
              <dd className="text-foreground">{feedback.channel || '—'}</dd>
            </div>
            <div>
              <dt className="text-xs text-muted">Ingress</dt>
              <dd className="text-foreground">{feedback.ingress || '—'}</dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-muted">Session ID</dt>
              <dd className="flex items-center gap-2 font-mono text-xs text-foreground">
                <span className="break-all">{feedback.sessionId}</span>
                <CopyButton value={feedback.sessionId} label="Copy session id" />
              </dd>
            </div>
            <div className="col-span-2">
              <dt className="text-xs text-muted">Rated message ID</dt>
              <dd className="flex items-center gap-2 font-mono text-xs text-foreground">
                <span className="break-all">{feedback.messageId}</span>
                <CopyButton value={feedback.messageId} label="Copy message id" />
              </dd>
            </div>
            {feedback.hasText && (
              <div className="col-span-2">
                <dt className="text-xs text-muted">Comment</dt>
                <dd className="text-foreground whitespace-pre-wrap break-words">
                  {feedback.feedbackText}
                </dd>
              </div>
            )}
          </dl>
        </section>

        {/* Conversation */}
        <section className="space-y-2">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-foreground">Conversation</h3>
            {messages.length > 0 && (
              <span className="text-xs text-muted">
                {messages.length} message{messages.length === 1 ? '' : 's'}
              </span>
            )}
          </div>

          {errorMessage && (
            <div className="rounded-lg border border-error/30 bg-error-subtle p-3 text-sm text-error">
              {errorMessage}
            </div>
          )}

          {isLoading ? (
            <div className="space-y-2">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 rounded" />
              ))}
            </div>
          ) : messages.length > 0 ? (
            <div className="space-y-3">
              {messages.map((m) => (
                <MessageBubble
                  key={m.id}
                  message={m}
                  highlighted={m.id === feedback.messageId}
                  scrollRef={highlightedRef}
                />
              ))}
            </div>
          ) : (
            !errorMessage && (
              <div className="rounded-lg border border-default bg-background-elevated p-4 text-sm text-muted">
                No conversation messages found for this session.
              </div>
            )
          )}
        </section>

        <div className="pt-2 flex justify-end">
          <Button variant="secondary" size="sm" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </SlidePanel>
  );
}
