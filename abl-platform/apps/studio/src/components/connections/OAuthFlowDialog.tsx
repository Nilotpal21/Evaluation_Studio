/**
 * OAuthFlowDialog Component
 *
 * Dialog/modal that manages the OAuth2 authorization flow.
 * Step 1: Show connector info and "Authorize" button.
 * Step 2: Calls server-side initiate endpoint to get full auth URL.
 * Step 3: Opens popup window for the constructed OAuth authorization URL.
 * Step 4: Listens for popup callback message (postMessage).
 * Step 5: Exchanges code for tokens via callback endpoint.
 * Step 6: Shows success/error result.
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ExternalLink, CheckCircle, XCircle, Loader2, ShieldCheck } from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';

// =============================================================================
// TYPES
// =============================================================================

interface OAuthFlowDialogProps {
  open: boolean;
  connector: {
    name: string;
    authorizationUrl: string;
    displayName?: string;
    connectionConfig?: Record<string, string>;
  };
  projectId: string;
  /** Auth profile ID to use for OAuth credentials resolution */
  authProfileId?: string | null;
  onSuccess: () => void;
  onClose: () => void;
}

type FlowStep = 'authorize' | 'initiating' | 'waiting' | 'exchanging' | 'success' | 'error';

// =============================================================================
// CONSTANTS
// =============================================================================

const POPUP_WIDTH = 600;
const POPUP_HEIGHT = 700;
const POPUP_POLL_INTERVAL_MS = 500;
/** Auth profile OAuth callback page sends this message type */
const OAUTH_MESSAGE_TYPE = 'auth-profile-oauth-callback';

// =============================================================================
// COMPONENT
// =============================================================================

export function OAuthFlowDialog({
  open,
  connector,
  projectId,
  authProfileId,
  onSuccess,
  onClose,
}: OAuthFlowDialogProps) {
  const [step, setStep] = useState<FlowStep>('authorize');
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const popupRef = useRef<Window | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const bcRef = useRef<BroadcastChannel | null>(null);

  // Reset state when dialog opens
  useEffect(() => {
    if (open) {
      setStep('authorize');
      setErrorMessage(null);
    }
  }, [open]);

  // Clean up popup and polling on unmount or close
  useEffect(() => {
    return () => {
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
      bcRef.current?.close();
      bcRef.current = null;
    };
  }, []);

  // Listen for postMessage from OAuth popup
  const handleMessage = useCallback(
    async (event: MessageEvent) => {
      // Validate origin to prevent cross-origin postMessage attacks.
      // Allow empty origin for BroadcastChannel events (BC is same-origin by design).
      if (event.origin !== window.location.origin && event.origin !== '') return;

      // Validate message structure
      if (!event.data || event.data.type !== OAUTH_MESSAGE_TYPE) return;

      const { code, state, error, success, exchanged, callbackResult } = event.data as {
        code?: string;
        state?: string;
        error?: string;
        success?: boolean;
        exchanged?: boolean;
        callbackResult?: {
          id: string;
        };
      };

      // Close popup
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      bcRef.current?.close();
      bcRef.current = null;

      if (error || success === false) {
        setErrorMessage(typeof error === 'string' ? error : 'Authorization was denied');
        setStep('error');
        return;
      }

      if (exchanged === true && callbackResult) {
        // Callback page already completed token exchange.
        onSuccess();
        onClose();
        return;
      }

      if (!code || !state) {
        setErrorMessage('Missing authorization code or state parameter');
        setStep('error');
        return;
      }

      // Exchange code for tokens via auth profile OAuth callback
      setStep('exchanging');
      try {
        const response = await apiFetch(
          `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/oauth/callback`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ code, state }),
          },
        );
        if (!response.ok) {
          const data = await response.json().catch(() => ({ error: 'Authorization failed' }));
          throw new Error(data.error || `Server error (${response.status})`);
        }
        // Skip showing success step in this dialog — the parent (CreateConnectionModal)
        // shows its own success screen after onSuccess creates the connection binding.
        onSuccess();
        onClose();
        return;
      } catch (err) {
        const message = sanitizeError(err, 'Authorization failed');
        setErrorMessage(message);
        setStep('error');
      }
    },
    [projectId, onSuccess, onClose],
  );

  // Only listen while open. The same `auth-profile-oauth-callback` message type
  // is shared with AuthProfileOAuthDialog. If multiple dialog instances subscribe
  // permanently, a single popup callback fans out to all of them, causing
  // duplicate POSTs to /oauth/callback — the first consumes the OAuth state
  // (GETDEL) and the rest return `INVALID_STATE` (400).
  //
  // BroadcastChannel fallback is opened per-flow in handleAuthorize (keyed on
  // the OAuth `state` value) to avoid cross-tab fan-out.
  useEffect(() => {
    if (!open) return;
    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [open, handleMessage]);

  const handleAuthorize = async () => {
    setStep('initiating');
    setErrorMessage(null);

    // Call auth profile OAuth initiate endpoint to get the full authorization URL
    let authUrl: string;
    try {
      const response = await apiFetch(
        `/api/projects/${encodeURIComponent(projectId)}/auth-profiles/oauth/initiate`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            connectorName: connector.name,
            authProfileId: authProfileId ?? undefined,
            ...(connector.connectionConfig && Object.keys(connector.connectionConfig).length > 0
              ? { connectionConfig: connector.connectionConfig }
              : {}),
          }),
        },
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({ error: 'Failed to initiate OAuth' }));
        throw new Error(data.error || `Server error (${response.status})`);
      }

      const data = await response.json();
      if (!data.success || !data.data?.authUrl) {
        throw new Error(data.error || 'Failed to get authorization URL');
      }

      authUrl = data.data.authUrl;
    } catch (err) {
      setErrorMessage(sanitizeError(err, 'Failed to initiate OAuth flow'));
      setStep('error');
      return;
    }

    // Calculate popup position (centered on screen)
    const left = Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
    const top = Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);

    const popup = window.open(
      authUrl,
      'oauth-popup',
      `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`,
    );

    if (!popup) {
      setErrorMessage(
        'Popup was blocked by the browser. Please allow popups for this site and try again.',
      );
      setStep('error');
      return;
    }

    popupRef.current = popup;

    // Open a per-flow BroadcastChannel keyed on the OAuth state so the
    // COOP fallback in the callback page reaches only this dialog instance,
    // even if the user has multiple tabs open.
    try {
      const flowState = new URL(authUrl).searchParams.get('state');
      if (flowState) {
        bcRef.current?.close();
        bcRef.current = new BroadcastChannel(`oauth-cb-${flowState}`);
        bcRef.current.onmessage = handleMessage;
      }
    } catch {
      // URL parse failed; BC fallback unavailable, postMessage still works
    }

    setStep('waiting');

    // Poll to detect if user closed the popup manually
    pollTimerRef.current = setInterval(() => {
      if (popup.closed) {
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        // Only set error if we're still in waiting state (not already handled via postMessage)
        setStep((currentStep) => {
          if (currentStep === 'waiting') {
            setErrorMessage('Authorization window was closed before completing');
            return 'error';
          }
          return currentStep;
        });
      }
    }, POPUP_POLL_INTERVAL_MS);
  };

  const handleDone = () => {
    onSuccess();
    onClose();
  };

  const handleRetry = () => {
    setStep('authorize');
    setErrorMessage(null);
  };

  return (
    <Dialog open={open} onClose={onClose} title="Connect Account" maxWidth="sm">
      <div className="space-y-6">
        {/* Connector info */}
        <div className="flex items-center gap-3 p-4 rounded-lg bg-background-muted">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-accent-subtle text-accent">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">{connector.name}</p>
            <p className="text-xs text-muted">OAuth 2.0 Authorization</p>
          </div>
        </div>

        {/* Step content */}
        {step === 'authorize' && (
          <div className="text-center space-y-4">
            <p className="text-sm text-muted">
              You will be redirected to authorize access to your {connector.name} account. A popup
              window will open for you to complete the authorization.
            </p>
            <Button
              icon={<ExternalLink className="w-4 h-4" />}
              onClick={handleAuthorize}
              className="w-full"
            >
              Authorize {connector.name}
            </Button>
          </div>
        )}

        {(step === 'initiating' || step === 'exchanging') && (
          <div className="text-center space-y-4 py-4">
            <Loader2 className="w-8 h-8 text-accent mx-auto animate-spin" />
            <div>
              <p className="text-sm font-medium text-foreground">
                {step === 'initiating' ? 'Preparing authorization...' : 'Completing connection...'}
              </p>
            </div>
          </div>
        )}

        {step === 'waiting' && (
          <div className="text-center space-y-4 py-4">
            <Loader2 className="w-8 h-8 text-accent mx-auto animate-spin" />
            <div>
              <p className="text-sm font-medium text-foreground">Waiting for authorization</p>
              <p className="text-xs text-muted mt-1">
                Complete the authorization in the popup window
              </p>
            </div>
          </div>
        )}

        {step === 'success' && (
          <div className="text-center space-y-4 py-4">
            <CheckCircle className="w-8 h-8 text-success mx-auto" />
            <div>
              <p className="text-sm font-medium text-foreground">Successfully connected</p>
              <p className="text-xs text-muted mt-1">
                Your {connector.name} account has been linked
              </p>
            </div>
            <Button onClick={handleDone} className="w-full">
              Done
            </Button>
          </div>
        )}

        {step === 'error' && (
          <div className="text-center space-y-4 py-4">
            <XCircle className="w-8 h-8 text-error mx-auto" />
            <div>
              <p className="text-sm font-medium text-foreground">Authorization failed</p>
              {errorMessage && <p className="text-xs text-error mt-1">{errorMessage}</p>}
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose} className="flex-1">
                Cancel
              </Button>
              <Button onClick={handleRetry} className="flex-1">
                Try Again
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
