'use client';

/**
 * BatchConsentGate — wraps chat panel children.
 * If auth_required with pending connectors, shows consent UI.
 * If no pending, renders children directly (no flash).
 */

import { type ReactNode, useCallback } from 'react';
import { useBatchConsentStore } from '../../store/batch-consent-store';
import { BatchConsentPanel } from './BatchConsentPanel';
import { useBatchOAuth } from '../../hooks/useBatchOAuth';
import type { ClientMessage } from '../../types';

export interface BatchConsentGateProps {
  children: ReactNode;
  /** WebSocket send function for consent_satisfy messages */
  sendMessage?: (msg: ClientMessage) => void;
  /** Session ID for the current chat */
  sessionId?: string | null;
  /** Project ID for auth-profile OAuth endpoints */
  projectId?: string | null;
}

export function BatchConsentGate({
  children,
  sendMessage,
  sessionId,
  projectId,
}: BatchConsentGateProps) {
  const active = useBatchConsentStore((s) => s.active);
  const connectors = useBatchConsentStore((s) => s.connectors);
  const setAuthorizing = useBatchConsentStore((s) => s.setAuthorizing);
  const setConnected = useBatchConsentStore((s) => s.setConnected);
  const setFailed = useBatchConsentStore((s) => s.setFailed);
  const setSkipped = useBatchConsentStore((s) => s.setSkipped);

  const { startOAuth, connectAll } = useBatchOAuth({
    projectId,
    onAuthorizing: setAuthorizing,
    onConnected: useCallback(
      (requirementKey: string) => {
        setConnected(requirementKey);
        const connector = useBatchConsentStore
          .getState()
          .connectors.find(
            (candidate) =>
              (candidate.requirementKey || candidate.authProfileRef) === requirementKey,
          );
        if (!connector) {
          return;
        }

        // Notify runtime
        if (sendMessage && sessionId) {
          sendMessage({
            type: 'consent_satisfy',
            sessionId,
            authProfileRef: connector.authProfileRef,
            requirementKey: connector.requirementKey,
          });
        }
      },
      [setConnected, sendMessage, sessionId],
    ),
    onFailed: setFailed,
    connectors,
  });

  const handleAuthorize = useCallback(
    (requirementKey: string) => {
      startOAuth(requirementKey);
    },
    [startOAuth],
  );

  const handleSkip = useCallback(
    (requirementKey: string) => {
      setSkipped(requirementKey);
    },
    [setSkipped],
  );

  const handleContinue = useCallback(() => {
    if (!sendMessage || !sessionId) {
      return;
    }

    const connected = useBatchConsentStore
      .getState()
      .connectors.filter((connector) => connector.status === 'connected');

    for (const connector of connected) {
      sendMessage({
        type: 'consent_satisfy',
        sessionId,
        authProfileRef: connector.authProfileRef,
        requirementKey: connector.requirementKey,
      });
    }
  }, [sendMessage, sessionId]);

  // If no auth gate is active, render children directly
  if (!active) {
    return <>{children}</>;
  }

  return (
    <BatchConsentPanel
      onAuthorize={handleAuthorize}
      onConnectAll={connectAll}
      onSkip={handleSkip}
      onContinue={handleContinue}
    />
  );
}
