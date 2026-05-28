/**
 * Device Authorization Page
 *
 * Allows users to authorize CLI/MCP clients via device code flow.
 */

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { CheckCircle, XCircle, Shield, Loader2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '../store/auth-store';
import { sanitizeError } from '../lib/sanitize-error';
import { KoreIcon } from '../components/ui/KoreLogo';
import { Button } from './ui/Button';

const API_URL = process.env.NEXT_PUBLIC_API_URL || '';

type Status = 'input' | 'loading' | 'confirm' | 'success' | 'error' | 'denied';

interface DeviceRequest {
  userCode: string;
  scopes: string[];
  expiresAt: string;
}

export function DeviceAuth() {
  const t = useTranslations('auth.device_page');
  const router = useRouter();
  const params = new URLSearchParams(window.location.search);
  const initialCode = params.get('code') || '';

  const [code, setCode] = useState(initialCode);
  const [status, setStatus] = useState<Status>(initialCode ? 'loading' : 'input');
  const [request, setRequest] = useState<DeviceRequest | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Scope descriptions for display
  const SCOPE_LABELS: Record<string, string> = {
    read_traces: t('scope_read_traces'),
    read_state: t('scope_read_state'),
    subscribe: t('scope_subscribe'),
    execute_tools: t('scope_execute_tools'),
  };

  const { isAuthenticated, isLoading: authLoading, accessToken, user } = useAuthStore();

  // Auto-lookup if code provided in URL, or redirect to login if not authenticated
  useEffect(() => {
    if (authLoading) return;

    if (!isAuthenticated) {
      // Redirect to login, preserving the device code in the return URL
      const returnUrl = code ? `/auth/device?code=${encodeURIComponent(code)}` : '/auth/device';
      router.push(`/auth/login?redirect=${encodeURIComponent(returnUrl)}`);
      return;
    }

    if (initialCode) {
      handleLookup(initialCode);
    }
  }, [initialCode, isAuthenticated, authLoading]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleLookup = async (lookupCode?: string) => {
    const codeToLookup = lookupCode || code;
    if (!codeToLookup.trim()) return;

    setStatus('loading');
    setError(null);

    try {
      const response = await fetch(
        `${API_URL}/api/auth/device/lookup?code=${encodeURIComponent(codeToLookup.toUpperCase())}`,
        {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
        },
      );

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Invalid code');
      }

      const data = await response.json();
      setRequest(data);
      setStatus('confirm');
    } catch (err) {
      setError(sanitizeError(err, 'Failed to lookup code'));
      setStatus('error');
    }
  };

  const handleAuthorize = async (allow: boolean) => {
    if (!accessToken) return;

    setStatus('loading');

    try {
      const response = await fetch(`${API_URL}/api/auth/device/authorize`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        credentials: 'same-origin',
        body: JSON.stringify({
          user_code: code.toUpperCase(),
          allow,
        }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Authorization failed');
      }

      setStatus(allow ? 'success' : 'denied');
    } catch (err) {
      setError(sanitizeError(err, 'Authorization failed'));
      setStatus('error');
    }
  };

  // Still loading auth state or redirecting
  if (authLoading || !isAuthenticated) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center p-4">
        <div className="w-full max-w-sm">
          <div className="flex justify-start mb-10">
            <KoreIcon className="text-foreground" size={28} />
          </div>
          <div className="text-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted mx-auto mb-4" />
            <p className="text-muted text-sm">{t('redirecting_to_sign_in')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        {/* Logo */}
        <div className="flex justify-start mb-10">
          <KoreIcon className="text-foreground" size={28} />
        </div>

        {/* Code Input */}
        {status === 'input' && (
          <>
            <div className="mb-6">
              <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
              <p className="text-muted text-sm mt-2">{t('subtitle')}</p>
            </div>

            <input
              type="text"
              value={code}
              onChange={(e) => setCode(e.target.value.toUpperCase())}
              placeholder={t('code_placeholder')}
              className="w-full p-4 bg-background border border-default rounded-lg text-center text-2xl font-mono tracking-widest text-foreground placeholder-subtle focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:border-foreground/30 transition-default"
              maxLength={9}
              autoFocus
            />

            <Button
              onClick={() => handleLookup()}
              disabled={code.length < 8}
              className="w-full mt-4"
            >
              {t('continue')}
            </Button>
          </>
        )}

        {/* Loading */}
        {status === 'loading' && (
          <div className="text-center py-12">
            <Loader2 className="w-8 h-8 animate-spin text-muted mx-auto mb-4" />
            <p className="text-muted text-sm">{t('verifying')}</p>
          </div>
        )}

        {/* Confirmation */}
        {status === 'confirm' && request && (
          <>
            <div className="mb-6">
              <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
              <p className="text-muted text-sm mt-2">{t('cli_requesting')}</p>
            </div>

            {/* Code display */}
            <div className="bg-background-muted border border-default rounded-lg p-4 mb-5">
              <p className="text-xs text-muted mb-1">{t('confirmation_code')}</p>
              <p className="text-lg font-mono font-bold text-foreground tracking-widest">
                {request.userCode}
              </p>
              <p className="text-xs text-subtle mt-2">{t('code_match_hint')}</p>
            </div>

            {/* Scopes */}
            <div className="mb-5">
              <div className="flex items-center gap-2 mb-2.5">
                <Shield className="w-4 h-4 text-muted" />
                <p className="text-sm font-medium text-foreground">{t('permissions_requested')}</p>
              </div>
              <ul className="space-y-1.5 pl-6">
                {request.scopes.map((scope) => (
                  <li key={scope} className="text-sm text-muted flex items-center gap-2">
                    <span className="w-1 h-1 rounded-full bg-muted shrink-0" />
                    {SCOPE_LABELS[scope] || scope}
                  </li>
                ))}
              </ul>
            </div>

            {/* User context */}
            {user && (
              <p className="text-xs text-subtle mb-5">
                {t('signing_in_as', { email: user.email })}
              </p>
            )}

            {/* Actions */}
            <div className="flex gap-3">
              <button
                onClick={() => handleAuthorize(false)}
                className="flex-1 py-2.5 text-sm font-medium text-foreground bg-background border border-default rounded-lg hover:bg-background-muted transition-default btn-press"
              >
                {t('deny')}
              </button>
              <button
                onClick={() => handleAuthorize(true)}
                className="flex-1 py-2.5 text-sm font-medium text-accent-foreground bg-accent rounded-lg hover:opacity-90 transition-default btn-press"
              >
                {t('approve')}
              </button>
            </div>
          </>
        )}

        {/* Success */}
        {status === 'success' && (
          <div className="text-center py-12">
            <CheckCircle className="w-10 h-10 text-success mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-foreground mb-2">{t('success_title')}</h1>
            <p className="text-muted text-sm">{t('success_message')}</p>
          </div>
        )}

        {/* Denied */}
        {status === 'denied' && (
          <div className="text-center py-12">
            <XCircle className="w-10 h-10 text-muted mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-foreground mb-2">{t('denied_title')}</h1>
            <p className="text-muted text-sm mb-4">{t('denied_message')}</p>
            <button
              onClick={() => {
                setCode('');
                setStatus('input');
              }}
              className="text-sm text-foreground font-medium hover:underline"
            >
              {t('enter_another_code')}
            </button>
          </div>
        )}

        {/* Error */}
        {status === 'error' && (
          <div className="text-center py-12">
            <XCircle className="w-10 h-10 text-error mx-auto mb-4" />
            <h1 className="text-xl font-semibold text-foreground mb-2">{t('error_title')}</h1>
            <p className="text-muted text-sm mb-4">{error || t('error_default')}</p>
            <button
              onClick={() => {
                setCode('');
                setError(null);
                setStatus('input');
              }}
              className="text-sm text-foreground font-medium hover:underline"
            >
              {t('try_again')}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
