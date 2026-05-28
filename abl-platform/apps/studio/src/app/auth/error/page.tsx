'use client';

import { useSearchParams } from 'next/navigation';
import { Suspense } from 'react';
import { WifiOff } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { AccessRequestForm } from '@/components/auth/AccessRequestForm';

function AuthErrorContent() {
  const t = useTranslations('auth.error_page');
  const searchParams = useSearchParams();
  const rawError = searchParams?.get('error') || '';
  const email = searchParams?.get('email') || '';

  // Allowlist only — anything not in this map gets the default message.
  // Never pass raw query-param values through to the UI.
  const AUTH_ERROR_MAP: Record<string, string> = {
    OAuthSignin: t('oauth_signin'),
    OAuthCallback: t('oauth_callback'),
    OAuthAccountNotLinked: t('oauth_account_not_linked'),
    AccessDenied: t('access_denied'),
    Verification: t('verification'),
    service_unavailable: t('service_unavailable'),
    account_conflict: t('account_conflict'),
    oauth_failed: t('default'),
    oauth_not_configured: t('default'),
    invalid_state: t('default'),
    no_code: t('default'),
    sso_required: t('default'),
    domain_not_allowed: t('domain_not_allowed'),
  };

  const error = AUTH_ERROR_MAP[rawError] || t('default');
  const showAccessRequest = rawError === 'domain_not_allowed' && email.includes('@');

  return (
    <div className="h-screen bg-background flex flex-col items-center justify-center">
      <div className="text-center">
        <div className="w-16 h-16 rounded-full bg-error-subtle flex items-center justify-center mx-auto mb-4">
          <WifiOff className="w-8 h-8 text-error" />
        </div>
        <h1 className="text-xl font-semibold text-foreground mb-2">{t('title')}</h1>
        <p className="text-muted mb-4">{error}</p>
        {showAccessRequest && (
          <div className="mx-auto mb-4 w-full max-w-sm text-left">
            <AccessRequestForm email={email} />
          </div>
        )}
        <a
          href="/"
          className="px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:bg-accent/90 inline-block"
        >
          {t('return_to_app')}
        </a>
      </div>
    </div>
  );
}

export default function AuthErrorPage() {
  return (
    <Suspense fallback={<div className="h-screen bg-background" />}>
      <AuthErrorContent />
    </Suspense>
  );
}
