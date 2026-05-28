'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { Clock, ExternalLink, Loader2, Shield, X, Check } from 'lucide-react';
import clsx from 'clsx';
import { useTranslations } from 'next-intl';
import type { AuthChallengeMessage } from '@agent-platform/web-sdk';

type ChallengeState =
  | 'pending'
  | 'authorizing'
  | 'completed'
  | 'failed'
  | 'timed_out'
  | 'cancelled';

interface PreviewAuthChallengeCardProps {
  challenge: AuthChallengeMessage;
  onAuthResponse: (toolCallId: string, status: 'completed' | 'cancelled') => void;
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

function formatTime(ms: number): string {
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function PreviewAuthChallengeCard({
  challenge,
  onAuthResponse,
}: PreviewAuthChallengeCardProps) {
  const t = useTranslations('preview.auth');
  const [state, setState] = useState<ChallengeState>('pending');
  const [remainingMs, setRemainingMs] = useState(challenge.timeoutMs);
  const [errorMessage, setErrorMessage] = useState('');
  const popupRef = useRef<Window | null>(null);
  const startTimeRef = useRef(Date.now());
  const popupSettledRef = useRef(false);
  const responseSentRef = useRef(false);

  const sendAuthResponse = useCallback(
    (status: 'completed' | 'cancelled') => {
      if (responseSentRef.current) {
        return;
      }
      responseSentRef.current = true;
      onAuthResponse(challenge.toolCallId, status);
    },
    [challenge.toolCallId, onAuthResponse],
  );

  useEffect(() => {
    if (state !== 'pending' && state !== 'authorizing') {
      return;
    }

    const interval = setInterval(() => {
      const elapsed = Date.now() - startTimeRef.current;
      const remaining = Math.max(0, challenge.timeoutMs - elapsed);
      setRemainingMs(remaining);

      if (remaining <= 0) {
        clearInterval(interval);
        popupSettledRef.current = true;
        setState('timed_out');
        sendAuthResponse('cancelled');
        if (popupRef.current && !popupRef.current.closed) {
          popupRef.current.close();
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [challenge.timeoutMs, sendAuthResponse, state]);

  useEffect(() => {
    if (state !== 'authorizing') {
      return;
    }

    const allowedOrigins = resolveAllowedCallbackOrigins(challenge.authUrl);

    const handleMessage = (event: MessageEvent) => {
      if (event.source !== popupRef.current) {
        return;
      }
      if (!allowedOrigins.has(event.origin)) {
        return;
      }
      if (event.data?.type !== 'oauth_complete') {
        return;
      }

      popupSettledRef.current = true;

      if (event.data?.success === false || typeof event.data?.error === 'string') {
        setErrorMessage(
          typeof event.data?.error === 'string' ? event.data.error : t('failed_default'),
        );
        setState('failed');
        if (popupRef.current && !popupRef.current.closed) {
          popupRef.current.close();
        }
        return;
      }

      sendAuthResponse('completed');
      setState('completed');
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
    };

    window.addEventListener('message', handleMessage);

    const checkPopup = setInterval(() => {
      if (popupRef.current?.closed) {
        clearInterval(checkPopup);
        if (!popupSettledRef.current) {
          setState('cancelled');
          sendAuthResponse('cancelled');
        }
      }
    }, 500);

    return () => {
      window.removeEventListener('message', handleMessage);
      clearInterval(checkPopup);
    };
  }, [challenge.authUrl, sendAuthResponse, state, t]);

  const handleAuthorize = useCallback(() => {
    if (!challenge.authUrl) {
      setErrorMessage(t('missing_url'));
      setState('failed');
      return;
    }

    popupSettledRef.current = false;
    responseSentRef.current = false;
    setErrorMessage('');
    setState('authorizing');

    const width = 600;
    const height = 700;
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;

    popupRef.current = window.open(
      challenge.authUrl,
      `preview-jit-auth-${challenge.toolCallId}`,
      `width=${width},height=${height},left=${left},top=${top},popup=true`,
    );

    if (!popupRef.current) {
      setErrorMessage(t('popup_blocked'));
      setState('failed');
    }
  }, [challenge.authUrl, challenge.toolCallId, t]);

  const handleCancel = useCallback(() => {
    popupSettledRef.current = true;
    setState('cancelled');
    sendAuthResponse('cancelled');

    if (popupRef.current && !popupRef.current.closed) {
      popupRef.current.close();
    }
  }, [sendAuthResponse]);

  const isTerminal =
    state === 'completed' || state === 'failed' || state === 'timed_out' || state === 'cancelled';

  return (
    <div
      className={clsx(
        'max-w-[85%] rounded-2xl border px-4 py-3',
        isTerminal ? 'border-default bg-background-subtle' : 'border-accent/40 bg-accent/5',
      )}
      data-testid="preview-auth-challenge"
    >
      <div className="flex items-start gap-3">
        <div
          className={clsx(
            'mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg',
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
            <Check className="h-4 w-4" />
          ) : state === 'failed' ? (
            <X className="h-4 w-4" />
          ) : state === 'authorizing' ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Shield className="h-4 w-4" />
          )}
        </div>

        <div className="min-w-0 flex-1">
          <div className="mb-1 flex items-center gap-2">
            <span className="text-sm font-medium text-foreground">{challenge.profileName}</span>
            <span className="text-xs capitalize text-muted">{challenge.authType}</span>
          </div>

          <p className="mb-3 whitespace-pre-wrap text-sm text-muted">{challenge.prompt}</p>

          {state === 'failed' && errorMessage ? (
            <p className="mb-3 text-sm text-error">{errorMessage}</p>
          ) : null}

          <div className="flex items-center gap-3">
            {state === 'pending' || state === 'failed' ? (
              <>
                <button
                  type="button"
                  onClick={handleAuthorize}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-accent-foreground hover:bg-accent/90"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  {t('authorize')}
                </button>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted hover:bg-background-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                  {t('cancel')}
                </button>
              </>
            ) : null}

            {state === 'authorizing' ? (
              <>
                <span className="text-sm text-muted">{t('waiting')}</span>
                <button
                  type="button"
                  onClick={handleCancel}
                  className="inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm text-muted hover:bg-background-muted hover:text-foreground"
                >
                  <X className="h-3.5 w-3.5" />
                  {t('cancel')}
                </button>
              </>
            ) : null}

            {state === 'completed' ? (
              <span className="text-sm text-success">{t('completed')}</span>
            ) : null}

            {state === 'timed_out' ? (
              <span className="text-sm text-warning">{t('timed_out')}</span>
            ) : null}

            {state === 'cancelled' ? (
              <span className="text-sm text-muted">{t('cancelled')}</span>
            ) : null}

            {!isTerminal ? (
              <div className="ml-auto flex items-center gap-1.5 text-xs text-muted">
                <Clock className="h-3 w-3" />
                <span>{formatTime(remainingMs)}</span>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}
