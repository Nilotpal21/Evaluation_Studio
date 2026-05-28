/**
 * AuthProfileOAuthDialog
 *
 * Dialog for the Auth Profile OAuth popup flow.
 * Reuses the same pattern as OAuthFlowDialog but with
 * auth-profile-specific endpoints and message type.
 */

'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import {
  ExternalLink,
  CheckCircle,
  XCircle,
  Loader2,
  ShieldCheck,
  AlertTriangle,
} from 'lucide-react';
import { Dialog } from '../ui/Dialog';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import {
  initiateOAuth,
  handleOAuthProfileCallback,
  initiateWorkspaceOAuth,
  handleWorkspaceOAuthProfileCallback,
} from '../../api/auth-profiles';
import { sanitizeError } from '../../lib/sanitize-error';

// =============================================================================
// TYPES
// =============================================================================

interface AuthProfileOAuthDialogProps {
  open: boolean;
  projectId?: string;
  scope?: 'project' | 'workspace';
  authProfileId: string;
  connectorName?: string;
  displayName?: string;
  /** Connection config field names required by the connector's OAuth URLs (e.g. ['subdomain']) */
  connectionConfigFields?: string[];
  onSuccess: (tokenProfileId: string) => void;
  onClose: () => void;
}

type FlowStep =
  | 'collect_config'
  | 'authorize'
  | 'initiating'
  | 'waiting'
  | 'exchanging'
  | 'success'
  | 'error';

// =============================================================================
// CONSTANTS
// =============================================================================

const POPUP_WIDTH = 600;
const POPUP_HEIGHT = 700;
const POPUP_POLL_INTERVAL_MS = 500;
const POPUP_TIMEOUT_MS = 300_000;
const MESSAGE_TYPE = 'auth-profile-oauth-callback';
const CALLBACK_STORAGE_PREFIX = 'auth-profile-oauth-callback:';
const CALLBACK_CONSUMED_ONCE_PREFIX = 'auth-profile-oauth-callback-consumed:';

interface OAuthCallbackPayload {
  type: string;
  success?: boolean;
  code?: string;
  state?: string;
  error?: string;
  exchanged?: boolean;
  callbackResult?: {
    id: string;
    refreshTokenStored: boolean;
  };
}

function buildCallbackStorageKey(state: string): string {
  return `${CALLBACK_STORAGE_PREFIX}${state}`;
}

function markCallbackStateConsumed(state: string): boolean {
  try {
    const key = `${CALLBACK_CONSUMED_ONCE_PREFIX}${state}`;
    if (window.sessionStorage.getItem(key) === '1') {
      return false;
    }
    window.sessionStorage.setItem(key, '1');
    return true;
  } catch {
    // Best effort fallback when sessionStorage is unavailable.
    return true;
  }
}

function getConfiguredAppOrigin(): string | null {
  const configured = process.env.NEXT_PUBLIC_APP_URL;
  if (!configured) {
    return null;
  }

  try {
    return new URL(configured).origin;
  } catch {
    return null;
  }
}

// =============================================================================
// COMPONENT
// =============================================================================

export function AuthProfileOAuthDialog({
  open,
  projectId,
  scope = 'project',
  authProfileId,
  connectorName,
  displayName,
  connectionConfigFields,
  onSuccess,
  onClose,
}: AuthProfileOAuthDialogProps) {
  const t = useTranslations('auth_profiles.oauth');
  const connectorLabel = connectorName?.trim() || displayName?.trim() || 'OAuth';
  const needsConfig = (connectionConfigFields?.length ?? 0) > 0;
  const [step, setStep] = useState<FlowStep>(needsConfig ? 'collect_config' : 'authorize');
  const [configValues, setConfigValues] = useState<Record<string, string>>({});
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  // True after a successful exchange that did NOT return a refresh token.
  // Surfaced as a warning in the success step so users discover at authorize
  // time that the grant cannot auto-renew (rather than 1 hour later when a
  // workflow run fails).
  const [showRefreshWarning, setShowRefreshWarning] = useState(false);
  const popupRef = useRef<Window | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consumedStatesRef = useRef<Set<string>>(new Set());
  const callbackInFlightRef = useRef<Set<string>>(new Set());
  const activeStateRef = useRef<string | null>(null);
  const popupStartedAtRef = useRef<number | null>(null);
  const authorizeInFlightRef = useRef(false);

  useEffect(() => {
    if (open) {
      setStep(needsConfig ? 'collect_config' : 'authorize');
      setConfigValues({});
      setErrorMessage(null);
      setShowRefreshWarning(false);
      consumedStatesRef.current.clear();
      callbackInFlightRef.current.clear();
      activeStateRef.current = null;
      popupStartedAtRef.current = null;
    }
  }, [open, needsConfig]);

  useEffect(() => {
    return () => {
      if (pollTimerRef.current) clearInterval(pollTimerRef.current);
      if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
    };
  }, []);

  const handleCallbackPayload = useCallback(
    async (payload: OAuthCallbackPayload) => {
      const { code, error } = payload;
      const callbackState =
        typeof payload.state === 'string' && payload.state.trim().length > 0
          ? payload.state.trim()
          : null;

      if (callbackState && activeStateRef.current && callbackState !== activeStateRef.current) {
        // Ignore stale or unrelated popup callbacks while this dialog is open.
        return;
      }

      if (callbackState) {
        if (!markCallbackStateConsumed(callbackState)) {
          return;
        }
        if (
          consumedStatesRef.current.has(callbackState) ||
          callbackInFlightRef.current.has(callbackState)
        ) {
          return;
        }
        callbackInFlightRef.current.add(callbackState);
      }

      try {
        if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
        if (pollTimerRef.current) {
          clearInterval(pollTimerRef.current);
          pollTimerRef.current = null;
        }
        activeStateRef.current = null;

        if (callbackState) {
          try {
            window.localStorage.removeItem(buildCallbackStorageKey(callbackState));
          } catch {
            // Best effort cleanup only.
          }
        }

        if (error) {
          if (callbackState) {
            consumedStatesRef.current.add(callbackState);
          }
          setErrorMessage(typeof error === 'string' ? error : t('authorization_denied'));
          setStep('error');
          return;
        }

        if (payload.exchanged === true) {
          if (!callbackState || !payload.callbackResult) {
            setErrorMessage(t('missing_code_or_state'));
            setStep('error');
            return;
          }
          consumedStatesRef.current.add(callbackState);
          setShowRefreshWarning(payload.callbackResult.refreshTokenStored === false);
          setStep('success');
          onSuccess(payload.callbackResult.id);
          return;
        }

        if (!code || !callbackState) {
          if (callbackState) {
            consumedStatesRef.current.add(callbackState);
          }
          setErrorMessage(t('missing_code_or_state'));
          setStep('error');
          return;
        }

        // Ignore duplicate callback payloads for the same OAuth state.
        // This avoids replaying callback exchange when popup/page emits
        // duplicate postMessage events during development StrictMode.
        consumedStatesRef.current.add(callbackState);

        setStep('exchanging');
        try {
          if (scope === 'project' && !projectId) {
            throw new Error('Missing projectId for project-scoped OAuth callback');
          }

          let result: Awaited<ReturnType<typeof handleWorkspaceOAuthProfileCallback>>;
          if (scope === 'workspace') {
            result = await handleWorkspaceOAuthProfileCallback({
              code,
              state: callbackState,
              displayName: displayName ?? `${connectorLabel} token`,
            });
          } else {
            const projectScopeId = projectId;
            if (!projectScopeId) {
              throw new Error('Missing projectId for project-scoped OAuth callback');
            }

            result = await handleOAuthProfileCallback(projectScopeId, {
              code,
              state: callbackState,
              displayName: displayName ?? `${connectorLabel} token`,
            });
          }
          setShowRefreshWarning(result.data.refreshTokenStored === false);
          setStep('success');
          onSuccess(result.data.id);
        } catch (err) {
          setErrorMessage(sanitizeError(err, t('token_exchange_failed')));
          setStep('error');
        }
      } finally {
        if (callbackState) {
          callbackInFlightRef.current.delete(callbackState);
        }
      }
    },
    [scope, projectId, connectorLabel, displayName, onSuccess, t],
  );

  const handleMessage = useCallback(
    (event: MessageEvent) => {
      if (!open) return;
      if (!event.data || event.data.type !== MESSAGE_TYPE) return;

      const configuredAppOrigin = getConfiguredAppOrigin();
      if (event.origin !== window.location.origin && event.origin !== configuredAppOrigin) {
        return;
      }

      // Do not require strict event.source identity checks here.
      // Some OAuth providers/window managers can re-parent the popup browsing
      // context and produce a different WindowProxy on callback, while still
      // posting from a trusted same-origin callback page.

      void handleCallbackPayload(event.data as OAuthCallbackPayload);
    },
    [open, handleCallbackPayload],
  );

  useEffect(() => {
    if (!open) {
      activeStateRef.current = null;
      if (pollTimerRef.current) {
        clearInterval(pollTimerRef.current);
        pollTimerRef.current = null;
      }
      if (popupRef.current && !popupRef.current.closed) {
        popupRef.current.close();
      }
      return;
    }

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [open, handleMessage]);

  const handleAuthorize = async () => {
    if (authorizeInFlightRef.current) {
      return;
    }

    if (scope === 'project' && !projectId) {
      setErrorMessage(t('initiate_failed'));
      setStep('error');
      return;
    }

    authorizeInFlightRef.current = true;
    setStep('initiating');
    setErrorMessage(null);

    try {
      const result =
        scope === 'workspace'
          ? await initiateWorkspaceOAuth({
              ...(connectorName ? { connectorName } : {}),
              authProfileId,
              ...(needsConfig ? { connectionConfig: configValues } : {}),
            })
          : await (() => {
              const projectScopeId = projectId;
              if (!projectScopeId) {
                throw new Error('Missing projectId for project-scoped OAuth initiate');
              }

              return initiateOAuth(projectScopeId, {
                ...(connectorName ? { connectorName } : {}),
                authProfileId,
                ...(needsConfig ? { connectionConfig: configValues } : {}),
              });
            })();
      const activeState = result.data.state;
      activeStateRef.current = activeState;
      popupStartedAtRef.current = Date.now();
      try {
        window.localStorage.removeItem(buildCallbackStorageKey(activeState));
      } catch {
        // Best effort cleanup only.
      }

      const left = Math.round(window.screenX + (window.outerWidth - POPUP_WIDTH) / 2);
      const top = Math.round(window.screenY + (window.outerHeight - POPUP_HEIGHT) / 2);

      const popup = window.open(
        result.data.authUrl,
        'auth-profile-oauth-popup',
        `width=${POPUP_WIDTH},height=${POPUP_HEIGHT},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`,
      );

      if (!popup) {
        setErrorMessage(t('popup_blocked'));
        setStep('error');
        return;
      }

      popupRef.current = popup;
      setStep('waiting');

      pollTimerRef.current = setInterval(() => {
        const startedAt = popupStartedAtRef.current;
        if (startedAt && Date.now() - startedAt >= POPUP_TIMEOUT_MS) {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          if (!popup.closed) {
            popup.close();
          }
          setStep((current) => {
            if (current === 'waiting' || current === 'exchanging') {
              setErrorMessage(t('window_closed'));
              return 'error';
            }
            return current;
          });
          return;
        }

        const activeState = activeStateRef.current;
        if (activeState) {
          try {
            const raw = window.localStorage.getItem(buildCallbackStorageKey(activeState));
            if (raw) {
              window.localStorage.removeItem(buildCallbackStorageKey(activeState));
              const storedPayload = JSON.parse(raw) as OAuthCallbackPayload;
              void handleCallbackPayload(storedPayload);
              return;
            }
          } catch {
            // Ignore malformed/non-JSON fallback payloads.
          }
        }

        if (popup.closed) {
          if (pollTimerRef.current) {
            clearInterval(pollTimerRef.current);
            pollTimerRef.current = null;
          }
          setStep((current) => {
            if (current === 'waiting') {
              setErrorMessage(t('window_closed'));
              return 'error';
            }
            return current;
          });
        }
      }, POPUP_POLL_INTERVAL_MS);
    } catch (err) {
      activeStateRef.current = null;
      setErrorMessage(sanitizeError(err, t('initiate_failed')));
      setStep('error');
    } finally {
      authorizeInFlightRef.current = false;
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('title')} maxWidth="sm">
      <div className="space-y-6">
        <div className="flex items-center gap-3 p-4 rounded-lg bg-background-muted">
          <div className="w-10 h-10 rounded-lg flex items-center justify-center bg-info-subtle text-info">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">{connectorLabel}</p>
            <p className="text-xs text-muted">{t('oauth2_authorization')}</p>
          </div>
        </div>

        {step === 'collect_config' && connectionConfigFields && (
          <div className="space-y-4">
            <p className="text-sm text-muted">{t('config_required_description')}</p>
            {connectionConfigFields.map((field) => (
              <div key={field} className="space-y-1">
                <label className="text-xs font-medium text-foreground capitalize">
                  {field.replace(/_/g, ' ')}
                </label>
                <Input
                  value={configValues[field] ?? ''}
                  onChange={(e) =>
                    setConfigValues((prev) => ({ ...prev, [field]: e.target.value }))
                  }
                  placeholder={field}
                />
              </div>
            ))}
            <Button
              icon={<ExternalLink className="w-4 h-4" />}
              onClick={() => setStep('authorize')}
              className="w-full"
              disabled={connectionConfigFields.some((f) => !configValues[f]?.trim())}
            >
              {t('continue_to_authorize')}
            </Button>
          </div>
        )}

        {step === 'authorize' && (
          <div className="text-center space-y-4">
            <p className="text-sm text-muted">{t('authorize_description')}</p>
            <Button
              icon={<ExternalLink className="w-4 h-4" />}
              onClick={handleAuthorize}
              className="w-full"
            >
              {t('authorize_button', { connector: connectorLabel })}
            </Button>
          </div>
        )}

        {(step === 'initiating' || step === 'exchanging') && (
          <div className="text-center space-y-4 py-4">
            <Loader2 className="w-8 h-8 text-info mx-auto animate-spin" />
            <p className="text-sm font-medium text-foreground">
              {step === 'initiating' ? t('preparing') : t('completing')}
            </p>
          </div>
        )}

        {step === 'waiting' && (
          <div className="text-center space-y-4 py-4">
            <Loader2 className="w-8 h-8 text-info mx-auto animate-spin" />
            <p className="text-sm font-medium text-foreground">{t('waiting')}</p>
            <p className="text-xs text-muted">{t('waiting_description')}</p>
          </div>
        )}

        {step === 'success' && (
          <div className="space-y-4 py-4">
            <div className="text-center space-y-2">
              {showRefreshWarning ? (
                <AlertTriangle className="w-8 h-8 text-warning mx-auto" />
              ) : (
                <CheckCircle className="w-8 h-8 text-success mx-auto" />
              )}
              <p className="text-sm font-medium text-foreground">{t('success')}</p>
            </div>
            {showRefreshWarning && (
              <div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/10 px-3 py-3 text-xs text-warning-foreground">
                <AlertTriangle
                  className="w-4 h-4 shrink-0 mt-0.5 text-warning"
                  aria-hidden="true"
                />
                <div className="space-y-1">
                  <p className="font-medium">{t('refresh_warning_title')}</p>
                  <p className="text-muted">{t('refresh_warning_message')}</p>
                </div>
              </div>
            )}
            <Button onClick={onClose} className="w-full">
              {t('done')}
            </Button>
          </div>
        )}

        {step === 'error' && (
          <div className="text-center space-y-4 py-4">
            <XCircle className="w-8 h-8 text-error mx-auto" />
            <p className="text-sm font-medium text-foreground">{t('authorization_failed')}</p>
            {errorMessage && <p className="text-xs text-error mt-1">{errorMessage}</p>}
            <div className="flex gap-2">
              <Button variant="secondary" onClick={onClose} className="flex-1">
                {t('cancel')}
              </Button>
              <Button
                onClick={() => {
                  setStep('authorize');
                  setErrorMessage(null);
                }}
                className="flex-1"
              >
                {t('try_again')}
              </Button>
            </div>
          </div>
        )}
      </div>
    </Dialog>
  );
}
