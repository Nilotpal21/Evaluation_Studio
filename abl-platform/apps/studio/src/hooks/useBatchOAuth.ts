'use client';

/**
 * useBatchOAuth — processes pending connectors one-by-one via OAuth popups.
 * Browsers block multiple simultaneous popups, so we process sequentially.
 */

import { useCallback, useRef, useState } from 'react';
import { handleOAuthProfileCallback, initiateOAuth } from '../api/auth-profiles';
import type { ConsentConnector } from '../store/batch-consent-store';

const INTER_POPUP_DELAY_MS = 500;
const POPUP_WIDTH = 600;
const POPUP_HEIGHT = 700;
const POPUP_POLL_INTERVAL_MS = 500;
const POPUP_TIMEOUT_MS = 300_000;
const MESSAGE_TYPE = 'auth-profile-oauth-callback';

interface UseBatchOAuthOptions {
  projectId?: string | null;
  onAuthorizing: (requirementKeyOrAuthProfileRef: string) => void;
  onConnected: (requirementKeyOrAuthProfileRef: string) => void;
  onFailed: (requirementKeyOrAuthProfileRef: string, error: string) => void;
  connectors: ConsentConnector[];
}

interface UseBatchOAuthResult {
  startOAuth: (requirementKeyOrAuthProfileRef: string) => void;
  connectAll: () => void;
  isConnecting: boolean;
}

function getConnectorIdentity(connector: ConsentConnector): string {
  return connector.requirementKey || connector.authProfileRef;
}

function waitForPopupCallback(
  popup: Window,
  expectedState: string,
): Promise<
  | {
      code: string;
      state: string;
      exchanged: false;
    }
  | {
      state: string;
      exchanged: true;
    }
> {
  return new Promise((resolve, reject) => {
    let settled = false;

    const cleanup = () => {
      window.removeEventListener('message', messageHandler);
      clearInterval(pollInterval);
      clearTimeout(timeout);
    };

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!popup.closed) {
        popup.close();
      }
      reject(new Error(message));
    };

    const succeed = (
      payload:
        | {
            code: string;
            state: string;
            exchanged: false;
          }
        | {
            state: string;
            exchanged: true;
          },
    ) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (!popup.closed) {
        popup.close();
      }
      resolve(payload);
    };

    const messageHandler = (event: MessageEvent) => {
      if (event.origin !== window.location.origin) return;
      if (event.source !== popup) return;
      if (!event.data || event.data.type !== MESSAGE_TYPE) return;

      const { code, state, error, exchanged } = event.data as {
        code?: string;
        state?: string;
        error?: string;
        exchanged?: boolean;
      };

      if (error) {
        fail(error);
        return;
      }

      if (!state) {
        fail('Missing OAuth state parameter');
        return;
      }
      if (state !== expectedState) {
        return;
      }

      if (exchanged === true) {
        succeed({ state, exchanged: true });
        return;
      }

      if (!code) {
        fail('Missing authorization code parameter');
        return;
      }

      succeed({ code, state, exchanged: false });
    };

    window.addEventListener('message', messageHandler);

    const pollInterval = setInterval(() => {
      if (popup.closed) {
        fail('Authorization window was closed before completion');
      }
    }, POPUP_POLL_INTERVAL_MS);

    const timeout = setTimeout(() => {
      fail('Authorization timed out. Please try again.');
    }, POPUP_TIMEOUT_MS);
  });
}

async function openOAuthPopup(projectId: string, connector: ConsentConnector): Promise<void> {
  const result = await initiateOAuth(
    projectId,
    connector.authProfileId
      ? {
          connectorName: connector.connector,
          authProfileId: connector.authProfileId,
          isUserConsent: connector.connectionMode === 'per_user',
        }
      : {
          connectorName: connector.connector,
          authProfileRef: connector.authProfileRef,
          isUserConsent: connector.connectionMode === 'per_user',
          ...(connector.environment !== undefined ? { environment: connector.environment } : {}),
        },
  );

  const left = Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
  const top = Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);
  const popup = window.open(
    result.data.authUrl,
    `oauth_${connector.requirementKey}`,
    `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`,
  );

  if (!popup) {
    throw new Error('Popup was blocked by the browser');
  }

  const callback = await waitForPopupCallback(popup, result.data.state);
  if (callback.exchanged) {
    return;
  }
  await handleOAuthProfileCallback(projectId, {
    code: callback.code,
    state: callback.state,
  });
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function useBatchOAuth({
  projectId,
  onAuthorizing,
  onConnected,
  onFailed,
  connectors,
}: UseBatchOAuthOptions): UseBatchOAuthResult {
  const connectingRef = useRef(false);
  const activeAuthorizationRef = useRef<string | null>(null);
  const [isConnecting, setIsConnecting] = useState(false);

  const runAuthorization = useCallback(
    async (requirementKeyOrAuthProfileRef: string, partOfBatch = false) => {
      const connector =
        connectors.find(
          (candidate) =>
            getConnectorIdentity(candidate) === requirementKeyOrAuthProfileRef &&
            candidate.status !== 'connected',
        ) ??
        connectors.find(
          (candidate) => getConnectorIdentity(candidate) === requirementKeyOrAuthProfileRef,
        );
      if (!connector) {
        onFailed(
          requirementKeyOrAuthProfileRef,
          'Connector is no longer available for authorization',
        );
        return;
      }
      const connectorKey = connector.requirementKey || requirementKeyOrAuthProfileRef;
      if (!projectId) {
        onFailed(connectorKey, 'Project context is required for authorization');
        return;
      }

      if (connectingRef.current && !partOfBatch) {
        onFailed(
          connectorKey,
          'Connect All is already in progress. Finish the current authorization before starting another connector.',
        );
        return;
      }
      if (activeAuthorizationRef.current) {
        if (activeAuthorizationRef.current !== connectorKey) {
          onFailed(
            connectorKey,
            'Another authorization is already in progress. Finish it before starting a different connector.',
          );
        }
        return;
      }

      activeAuthorizationRef.current = connectorKey;
      if (!connectingRef.current) {
        setIsConnecting(true);
      }
      onAuthorizing(connectorKey);

      try {
        await openOAuthPopup(projectId, connector);
        onConnected(connectorKey);
      } catch (err) {
        onFailed(connectorKey, err instanceof Error ? err.message : String(err));
      } finally {
        activeAuthorizationRef.current = null;
        if (!connectingRef.current) {
          setIsConnecting(false);
        }
      }
    },
    [connectors, onAuthorizing, onConnected, onFailed, projectId],
  );

  const startOAuth = useCallback(
    (requirementKeyOrAuthProfileRef: string) => {
      void runAuthorization(requirementKeyOrAuthProfileRef, false);
    },
    [runAuthorization],
  );

  const connectAll = useCallback(async () => {
    if (connectingRef.current || activeAuthorizationRef.current) return;

    connectingRef.current = true;
    setIsConnecting(true);

    try {
      const pending = connectors.filter(
        (c) => c.status === 'pending' || c.status === 'failed' || c.status === 'skipped',
      );

      for (let index = 0; index < pending.length; index += 1) {
        await runAuthorization(
          pending[index].requirementKey || pending[index].authProfileRef,
          true,
        );
        if (index < pending.length - 1) {
          await delay(INTER_POPUP_DELAY_MS);
        }
      }
    } finally {
      connectingRef.current = false;
      if (!activeAuthorizationRef.current) {
        setIsConnecting(false);
      }
    }
  }, [activeAuthorizationRef, connectors, runAuthorization]);

  return {
    startOAuth,
    connectAll,
    isConnecting,
  };
}
