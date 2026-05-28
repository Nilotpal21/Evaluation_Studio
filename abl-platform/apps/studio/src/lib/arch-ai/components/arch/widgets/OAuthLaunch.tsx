'use client';

import { useState, useCallback, useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { useBatchOAuth } from '@/hooks/useBatchOAuth';
import type { ConsentConnector } from '@/store/batch-consent-store';

/**
 * OAuthLaunch widget input — Contract 5
 *
 * Receives the full ConsentConnector shape via the ask_user widget input
 * with widgetType: 'OAuthLaunch'. The widget runs the existing
 * useBatchOAuth machinery and submits a tool answer reflecting the result.
 */
export interface OAuthLaunchInput {
  widgetType?: 'OAuthLaunch';
  authProfileId: string;
  authProfileRef: string;
  connectorName: string;
  connectionMode: 'shared' | 'per_user';
  scopes: string[];
  requirementKey?: string;
  environment?: string | null;
  providerLabel: string;
  /** Optional explanatory question */
  question?: string;
}

export interface OAuthLaunchAnswer {
  status: 'connected' | 'failed' | 'canceled';
  oauthTokenProfileId?: string;
  expiresAt?: number;
  error?: string;
}

interface Props {
  input: OAuthLaunchInput;
  onSubmit: (answer: OAuthLaunchAnswer) => void;
  /** Optional project ID — required by useBatchOAuth for actual OAuth flow */
  projectId?: string | null;
}

const CANCEL_PATTERNS = [/closed before completion/i, /canceled/i, /cancelled/i, /dismissed/i];

function classifyError(message: string): 'canceled' | 'failed' {
  return CANCEL_PATTERNS.some((pattern) => pattern.test(message)) ? 'canceled' : 'failed';
}

export function OAuthLaunch({ input, onSubmit, projectId }: Props) {
  const requirementKey = input.requirementKey ?? `oauth-${input.authProfileId}`;

  const [running, setRunning] = useState(false);
  const [submitted, setSubmitted] = useState(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const submittedRef = useRef(false);

  // Single-connector ConsentConnector shape for the hook.
  const connector: ConsentConnector = {
    requirementKey,
    connector: input.connectorName,
    authProfileRef: input.authProfileRef,
    authProfileId: input.authProfileId,
    environment: input.environment ?? null,
    scopes: input.scopes,
    connectionMode: input.connectionMode,
    status: 'pending',
  };

  const finalize = useCallback(
    (answer: OAuthLaunchAnswer) => {
      if (submittedRef.current) return;
      submittedRef.current = true;
      setSubmitted(true);
      setRunning(false);
      onSubmit(answer);
    },
    [onSubmit],
  );

  const handleAuthorizing = useCallback(() => {
    setRunning(true);
  }, []);

  const handleConnected = useCallback(() => {
    // The runtime-side OAuth callback persists tokens. The widget only needs
    // to communicate that the user completed the popup successfully — the
    // runtime fills in oauthTokenProfileId/expiresAt out of band.
    finalize({ status: 'connected' });
  }, [finalize]);

  const handleFailed = useCallback(
    (_key: string, error: string) => {
      const status = classifyError(error);
      setErrorMessage(status === 'failed' ? error : null);
      if (status === 'canceled') {
        finalize({ status: 'canceled' });
      } else {
        finalize({ status: 'failed', error });
      }
    },
    [finalize],
  );

  const { startOAuth, isConnecting } = useBatchOAuth({
    projectId: projectId ?? null,
    onAuthorizing: handleAuthorizing,
    onConnected: handleConnected,
    onFailed: handleFailed,
    connectors: [connector],
  });

  useEffect(() => {
    if (!isConnecting && running && !submittedRef.current) {
      // Hook finished without invoking onConnected/onFailed (rare). Keep
      // the button enabled so the user can retry.
      setRunning(false);
    }
  }, [isConnecting, running]);

  const handleClick = useCallback(() => {
    if (submittedRef.current || running) return;
    setErrorMessage(null);
    setRunning(true);
    startOAuth(requirementKey);
  }, [running, startOAuth, requirementKey]);

  if (submitted) {
    return (
      <div
        data-widget="OAuthLaunch"
        className="my-3 rounded-lg border border-border/50 bg-background-muted/30 px-4 py-3 text-sm text-foreground-muted"
      >
        Authorization complete.
      </div>
    );
  }

  return (
    <motion.div
      data-widget="OAuthLaunch"
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2, ease: 'easeOut' }}
      className="my-3 rounded-lg border border-border bg-background-muted/30 p-4"
    >
      <p className="mb-3 text-sm text-foreground/80">
        Authorize Arch to use your {input.providerLabel} account.
      </p>
      <button
        type="button"
        onClick={handleClick}
        disabled={running}
        className={`btn-press rounded-lg px-5 py-2.5 text-sm font-medium transition-colors ${
          running
            ? 'cursor-not-allowed border border-border bg-background-subtle text-foreground/40'
            : 'bg-accent text-accent-foreground hover:bg-accent-muted'
        }`}
      >
        {running ? 'Waiting for consent…' : `Connect to ${input.providerLabel}`}
      </button>
      {errorMessage ? (
        <p className="mt-2 text-sm text-error" role="alert">
          {errorMessage}
        </p>
      ) : null}
    </motion.div>
  );
}
