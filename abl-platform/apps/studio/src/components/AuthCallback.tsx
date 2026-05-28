/**
 * Auth Callback Page
 *
 * Handles OAuth callback from Google, OIDC SSO, and SAML SSO.
 * Exchanges the one-time auth code for tokens and redirects to main app.
 */

import { useEffect, useRef, useState } from 'react';
import { Loader2, CheckCircle, XCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '../store/auth-store';
import { handleOAuthCallback, fetchCurrentUser, scheduleTokenRefresh } from '../api/auth';
import { Button } from './ui/Button';

type Status = 'loading' | 'success' | 'error';

interface AuthCallbackProps {
  onComplete: () => void;
}

export function AuthCallback({ onComplete }: AuthCallbackProps) {
  const t = useTranslations('auth.callback_page');
  const [status, setStatus] = useState<Status>('loading');
  const [error, setError] = useState<string | null>(null);
  const { setAuth } = useAuthStore();
  const exchangeCalledRef = useRef(false);

  useEffect(() => {
    async function processCallback() {
      // Guard against React StrictMode double-execution — the auth code is
      // single-use, so a second exchange call would always fail with 400.
      if (exchangeCalledRef.current) return;
      exchangeCalledRef.current = true;

      const params = new URLSearchParams(window.location.search);

      // Check for error
      const errorParam = params.get('error');
      if (errorParam) {
        const errorMessages: Record<string, string> = {
          oauth_failed: t('error_oauth_failed'),
          access_denied: t('error_access_denied'),
          invalid_state: t('error_invalid_state'),
          server_error: t('error_server_error'),
        };
        setError(errorMessages[errorParam] || t('error_oauth_failed'));
        setStatus('error');
        return;
      }

      try {
        // Exchange the one-time auth code for tokens
        const tokens = await handleOAuthCallback(params);
        if (!tokens) {
          setError(t('error_missing_code'));
          setStatus('error');
          return;
        }

        // Fetch user info
        const user = await fetchCurrentUser(tokens.accessToken);

        // Save auth state
        setAuth(user, tokens.accessToken);

        // Schedule token refresh
        scheduleTokenRefresh(tokens.expiresIn);

        setStatus('success');

        // Check if user needs onboarding or invitation choice (from exchange response metadata)
        const needsOnboarding = tokens.needsOnboarding === true;
        const pendingInvitationChoice = tokens.pendingInvitationChoice === true;
        const inviteToken = tokens.inviteToken;

        // Clean URL and redirect
        window.history.replaceState({}, '', '/');

        // Small delay for user feedback, then redirect
        setTimeout(() => {
          if (inviteToken) {
            window.location.href = `/invite/${inviteToken}`;
          } else if (pendingInvitationChoice) {
            window.location.href = '/invitations/choose';
          } else if (needsOnboarding) {
            window.location.href = '/onboarding';
          } else {
            onComplete();
          }
        }, 500);
      } catch (err) {
        console.error('Auth callback error:', err);
        setError(t('error_generic'));
        setStatus('error');
      }
    }

    processCallback();
  }, [setAuth, onComplete]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="min-h-screen bg-background flex flex-col items-center justify-center">
      <div className="text-center">
        {status === 'loading' && (
          <>
            <Loader2 className="w-12 h-12 text-accent animate-spin mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-foreground mb-2">{t('completing')}</h1>
          </>
        )}

        {status === 'success' && (
          <>
            <CheckCircle className="w-12 h-12 text-accent mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-foreground mb-2">{t('success_title')}</h1>
            <p className="text-muted text-sm">{t('redirecting')}</p>
          </>
        )}

        {status === 'error' && (
          <>
            <XCircle className="w-12 h-12 text-error mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-foreground mb-2">{t('failed_title')}</h1>
            <p className="text-muted mb-4">{error}</p>
            <Button onClick={() => (window.location.href = '/')}>{t('return_to_app')}</Button>
          </>
        )}
      </div>
    </div>
  );
}
