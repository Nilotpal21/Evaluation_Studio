'use client';

/**
 * AuthChallengeMessage — Chat message component for JIT auth challenges (Phase 5).
 *
 * Renders an authentication prompt inline in the chat when a tool requires
 * user authorization mid-conversation. Shows:
 * - Profile name and auth type
 * - "Authorize" button that opens an OAuth popup
 * - Countdown timer showing remaining time
 * - Cancel button
 *
 * State transitions:
 *   pending → authorizing → completed | timed_out | cancelled
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { Shield, ExternalLink, Clock, X, Check, Loader2 } from 'lucide-react';
import clsx from 'clsx';
import { useWebSocketContext } from '../../contexts/WebSocketContext';

export interface AuthChallengeData {
  _type: 'auth_challenge';
  toolCallId: string;
  authType: string;
  authUrl?: string;
  profileId: string;
  profileName: string;
  prompt: string;
  timeoutMs: number;
  sessionId: string;
}

type ChallengeState =
  | 'pending'
  | 'authorizing'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

interface AuthChallengeMessageProps {
  data: AuthChallengeData;
}

function resolveAllowedCallbackOrigins(authUrl?: string): Set<string> {
  const origins = new Set<string>([window.location.origin]);
  if (!authUrl) {
    return origins;
  }

  try {
    const redirectUri = new URL(authUrl).searchParams.get('redirect_uri');
    if (redirectUri) {
      origins.add(new URL(redirectUri).origin);
    }
  } catch {
    // Ignore malformed URLs and fall back to the current origin only.
  }

  return origins;
}

export function AuthChallengeMessage({ data }: AuthChallengeMessageProps) {
  const { send } = useWebSocketContext();
  const [state, setState] = useState<ChallengeState>('pending');
  const [remainingMs, setRemainingMs] = useState(data.timeoutMs);
  const [errorMessage, setErrorMessage] = useState('');
  const popupRef = useRef<Window | null>(null);
  const startTimeRef = useRef(Date.now());
  const popupSettledRef = useRef(false);

  // Countdown timer
  useEffect(() => {
    if (state !== 'pending' && state !== 'authorizing') return;

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const remaining = Math.max(0, data.timeoutMs - elapsed);
      setRemainingMs(remaining);

      if (remaining <= 0) {
        setState('timed_out');
        clearInterval(interval);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [state, data.timeoutMs]);

  // Listen for OAuth completion via postMessage from the popup callback page.
  // Popup close without a postMessage means the user cancelled (closed the window).
  useEffect(() => {
    if (state !== 'authorizing') return;

    const allowedOrigins = resolveAllowedCallbackOrigins(data.authUrl);

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== popupRef.current) return;
      if (!allowedOrigins.has(event.origin)) return;
      if (event.data?.type !== 'oauth_complete') return;

      popupSettledRef.current = true;

      if (event.data?.success === false || typeof event.data?.error === 'string') {
        setErrorMessage(
          typeof event.data?.error === 'string'
            ? event.data.error
            : 'Authorization failed. Please try again.',
        );
        setState('failed');
        if (popupRef.current && !popupRef.current.closed) {
          popupRef.current.close();
        }
        return;
      }

      setState('completed');
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
    };

    window.addEventListener('message', handleMessage);

    // Also poll for popup close — if closed without postMessage, treat as cancelled
    const checkPopup = setInterval(() => {
      if (popupRef.current?.closed) {
        clearInterval(checkPopup);
        if (!popupSettledRef.current && state === 'authorizing') {
          setState('cancelled');
          send({
            type: 'auth_response',
            toolCallId: data.toolCallId,
            status: 'cancelled',
          });
        }
      }
    }, 500);

    return () => {
      window.removeEventListener('message', handleMessage);
      clearInterval(checkPopup);
    };
  }, [state, data.authUrl, data.toolCallId, send]);

  const handleAuthorize = useCallback(() => {
    if (!data.authUrl) {
      // No URL available — cannot open popup
      return;
    }

    popupSettledRef.current = false;
    setErrorMessage('');
    setState('authorizing');

    // Open OAuth popup
    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    popupRef.current = window.open(
      data.authUrl,
      `jit-auth-${data.toolCallId}`,
      `width=${width},height=${height},left=${left},top=${top},popup=true`,
    );
  }, [data.authUrl, data.toolCallId]);

  const handleCancel = useCallback(() => {
    popupSettledRef.current = true;
    setState('cancelled');
    send({
      type: 'auth_response',
      toolCallId: data.toolCallId,
      status: 'cancelled',
    });

    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close();
    }
  }, [data.toolCallId, send]);

  const formatTime = (ms: number): string => {
    const totalSeconds = Math.ceil(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  const isTerminal =
    state === 'completed' || state === 'failed' || state === 'timed_out' || state === 'cancelled';

  return (
    <div
      className={clsx(
        'mx-auto max-w-3xl px-6 py-4',
        'rounded-lg border',
        isTerminal ? 'border-border-muted bg-background-subtle' : 'border-accent bg-accent/5',
      )}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div
          className={clsx(
            'w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0',
            state === 'completed'
              ? 'bg-success-subtle text-success'
              : state === 'failed'
                ? 'bg-error-subtle text-error'
                : state === 'timed_out' || state === 'cancelled'
                  ? 'bg-background-muted text-muted'
                  : 'bg-accent/10 text-accent',
          )}
        >
          {state === 'completed' ? (
            <Check className="w-4 h-4" />
          ) : state === 'failed' ? (
            <X className="w-4 h-4" />
          ) : state === 'authorizing' ? (
            <Loader2 className="w-4 h-4 animate-spin" />
          ) : (
            <Shield className="w-4 h-4" />
          )}
        </div>

        {/* Content */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className="text-sm font-medium text-foreground">{data.profileName}</span>
            <span className="text-xs text-muted capitalize">{data.authType}</span>
          </div>

          <p className="text-sm text-muted mb-3">{data.prompt}</p>
          {state === 'failed' && errorMessage && (
            <p className="mb-3 text-sm text-error">{errorMessage}</p>
          )}

          {/* Action area */}
          <div className="flex items-center gap-3">
            {state === 'pending' && (
              <>
                <button
                  onClick={handleAuthorize}
                  disabled={!data.authUrl}
                  className={clsx(
                    'inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium',
                    'bg-accent text-accent-foreground hover:bg-accent/90',
                    'disabled:opacity-50 disabled:cursor-not-allowed',
                    'transition-default',
                  )}
                >
                  <ExternalLink className="w-3.5 h-3.5" />
                  Authorize
                </button>
                <button
                  onClick={handleCancel}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-muted hover:text-foreground hover:bg-background-muted transition-default"
                >
                  <X className="w-3.5 h-3.5" />
                  Cancel
                </button>
              </>
            )}

            {state === 'authorizing' && (
              <>
                <span className="text-sm text-muted">Waiting for authorization...</span>
                <button
                  onClick={handleCancel}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm text-muted hover:text-foreground hover:bg-background-muted transition-default"
                >
                  <X className="w-3.5 h-3.5" />
                  Cancel
                </button>
              </>
            )}

            {state === 'completed' && (
              <span className="text-sm text-success">Authorization completed</span>
            )}

            {state === 'timed_out' && (
              <span className="text-sm text-warning">Authorization timed out</span>
            )}

            {state === 'cancelled' && (
              <span className="text-sm text-muted">Authorization cancelled</span>
            )}

            {/* Countdown */}
            {!isTerminal && (
              <div className="ml-auto flex items-center gap-1.5 text-xs text-muted">
                <Clock className="w-3 h-3" />
                <span>{formatTime(remainingMs)}</span>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

/**
 * Try to parse a system message content as AuthChallengeData.
 * Returns null if the message is not an auth challenge.
 */
export function parseAuthChallengeData(content: string): AuthChallengeData | null {
  try {
    const parsed = JSON.parse(content);
    if (parsed?._type === 'auth_challenge' && typeof parsed.toolCallId === 'string') {
      return parsed as AuthChallengeData;
    }
  } catch {
    // Not JSON or not an auth challenge
  }
  return null;
}
