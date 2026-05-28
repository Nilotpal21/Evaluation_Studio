'use client';

import { Suspense, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';

function getLoginErrorMessage(error: string): string {
  const messages: Record<string, string> = {
    sso_not_configured: 'No enterprise SSO configuration was found for this email domain.',
    sso_misconfigured:
      'Enterprise SSO is configured for this domain, but the identity provider settings are incomplete.',
    sso_unavailable: 'Enterprise SSO is temporarily unavailable. Please try again.',
    oauth_failed: 'The social login provider could not complete the sign-in flow.',
    oauth_not_configured: 'This social login provider is not configured in Studio.',
    service_unavailable: 'Studio could not load the social-login profile details.',
    studio_account_required:
      'This Google or Microsoft email must already belong to a Studio account before it can access Admin.',
    account_conflict:
      'This email is already linked to a different Studio sign-in method and cannot be used here.',
    email_not_verified:
      'The selected Google or Microsoft account does not have a verified email address.',
    sso_required: 'This account must use the organization SSO flow instead of social login.',
    no_code: 'The social login provider did not return an authorization code.',
    oidc_auth_failed: 'The identity provider could not complete the OIDC sign-in flow.',
    saml_auth_failed: 'The identity provider could not complete the SAML sign-in flow.',
    mfa_unsupported: 'MFA-enabled Studio accounts are not yet supported in the Admin app.',
    invalid_state: 'The SSO session expired or could not be verified. Please try again.',
    access_denied: 'The identity provider denied access to this sign-in request.',
    domain_not_allowed: 'This email domain is not approved for platform access.',
  };

  return messages[error] || error;
}

function LoginForm() {
  const searchParams = useSearchParams();
  const redirect = searchParams.get('redirect') || '/';
  const errorParam = searchParams.get('error');

  const [email, setEmail] = useState('superadmin@platform.internal');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [loading, setLoading] = useState(false);
  const [ssoLoading, setSsoLoading] = useState(false);
  const [providerLoading, setProviderLoading] = useState<'google' | 'microsoft' | null>(null);
  const [devLoading, setDevLoading] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState<{ role: string } | null>(null);

  useEffect(() => {
    if (!errorParam) {
      return;
    }

    setError(getLoginErrorMessage(errorParam));
  }, [errorParam]);

  const finishLogin = (role: string) => {
    setSuccess({ role: role || 'Unknown' });
    setTimeout(() => {
      window.location.href = redirect;
    }, 500);
  };

  const handlePasswordLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      const data = (await response.json()) as { error?: string; role?: string };

      if (!response.ok) {
        setError(data.error || 'Login failed');
        return;
      }

      finishLogin(data.role || 'Unknown');
    } catch {
      setError('Studio login is currently unavailable.');
    } finally {
      setLoading(false);
    }
  };

  const handleDevLogin = async () => {
    setError('');
    setDevLoading(true);

    try {
      const response = await fetch('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, name: name || undefined }),
      });

      const data = (await response.json()) as { error?: string; role?: string };

      if (!response.ok) {
        setError(data.error || 'Dev login failed');
        return;
      }

      finishLogin(data.role || 'Unknown');
    } catch {
      setError('Server not reachable. Is Studio running?');
    } finally {
      setDevLoading(false);
    }
  };

  const handleSsoLogin = () => {
    if (!email.trim()) {
      setError('Enter your work email to continue with SSO.');
      return;
    }

    setError('');
    setSsoLoading(true);

    const params = new URLSearchParams({ email: email.trim() });
    if (redirect !== '/') {
      params.set('redirect', redirect);
    }

    window.location.href = `/api/auth/sso?${params.toString()}`;
  };

  const handleProviderLogin = (provider: 'google' | 'microsoft') => {
    setError('');
    setProviderLoading(provider);

    const params = new URLSearchParams();
    if (redirect !== '/') {
      params.set('redirect', redirect);
    }

    const suffix = params.toString();
    window.location.href = `/api/auth/${provider}${suffix ? `?${suffix}` : ''}`;
  };

  return (
    <div className="w-full max-w-md animate-fade-in-scale">
      <div className="bg-background-muted border border-default rounded-[var(--radius-xl)] p-8">
        <div className="text-center mb-8">
          <h1 className="text-2xl font-bold text-foreground">Admin Dashboard</h1>
          <p className="text-sm text-muted mt-1">Agent Platform</p>
        </div>

        {success ? (
          <div className="text-center py-4">
            <span className="inline-block px-3 py-1 rounded-full text-sm font-medium bg-success-subtle text-success">
              {success.role}
            </span>
            <p className="text-sm text-muted mt-3">Redirecting...</p>
          </div>
        ) : (
          <form onSubmit={handlePasswordLogin} className="space-y-4">
            <div>
              <label htmlFor="email" className="block text-sm font-medium text-muted mb-1">
                Email
              </label>
              <input
                id="email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="w-full px-3 py-2 input-dark text-sm focus-ring"
                placeholder="admin@example.com"
              />
            </div>

            <div>
              <label htmlFor="password" className="block text-sm font-medium text-muted mb-1">
                Password
              </label>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-3 py-2 input-dark text-sm focus-ring"
                placeholder="Studio account password"
                autoComplete="current-password"
              />
            </div>

            {error && (
              <div className="px-3 py-2 rounded-[var(--radius-md)] bg-error-subtle text-sm text-error border border-error-muted">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading || ssoLoading || providerLoading !== null}
              className="w-full py-2 px-4 bg-accent text-accent-foreground rounded-[var(--radius-md)] text-sm font-medium btn-press focus-ring disabled:opacity-50 disabled:cursor-not-allowed transition-default"
            >
              {loading ? 'Signing in...' : 'Sign In'}
            </button>

            <button
              type="button"
              onClick={handleSsoLogin}
              disabled={ssoLoading || loading || providerLoading !== null}
              className="w-full py-2 px-4 bg-background text-foreground border border-default rounded-[var(--radius-md)] text-sm font-medium btn-press focus-ring disabled:opacity-50 disabled:cursor-not-allowed transition-default"
            >
              {ssoLoading ? 'Starting SSO...' : 'Continue with SSO'}
            </button>

            <div className="grid grid-cols-2 gap-3">
              <button
                type="button"
                onClick={() => handleProviderLogin('google')}
                disabled={loading || ssoLoading || providerLoading !== null}
                className="flex items-center justify-center gap-2 py-2 px-4 bg-background text-foreground border border-default rounded-[var(--radius-md)] text-sm font-medium btn-press focus-ring disabled:opacity-50 disabled:cursor-not-allowed transition-default"
              >
                <GoogleIcon />
                {providerLoading === 'google' ? 'Starting...' : 'Google'}
              </button>

              <button
                type="button"
                onClick={() => handleProviderLogin('microsoft')}
                disabled={loading || ssoLoading || providerLoading !== null}
                className="flex items-center justify-center gap-2 py-2 px-4 bg-background text-foreground border border-default rounded-[var(--radius-md)] text-sm font-medium btn-press focus-ring disabled:opacity-50 disabled:cursor-not-allowed transition-default"
              >
                <MicrosoftIcon />
                {providerLoading === 'microsoft' ? 'Starting...' : 'Microsoft'}
              </button>
            </div>

            <div className="pt-3 border-t border-default space-y-3">
              <div>
                <label htmlFor="name" className="block text-sm font-medium text-muted mb-1">
                  Name <span className="text-subtle">(optional, dev login only)</span>
                </label>
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  className="w-full px-3 py-2 input-dark text-sm focus-ring"
                  placeholder="Display name"
                />
              </div>

              <button
                type="button"
                onClick={handleDevLogin}
                disabled={devLoading || loading || ssoLoading || providerLoading !== null}
                className="w-full py-2 px-4 bg-background text-foreground border border-default rounded-[var(--radius-md)] text-sm font-medium btn-press focus-ring disabled:opacity-50 disabled:cursor-not-allowed transition-default"
              >
                {devLoading ? 'Starting dev login...' : 'Dev Login'}
              </button>
            </div>

            <p className="text-xs text-subtle text-center mt-4">
              Sign in with a Studio super-admin account. Google and Microsoft sign-ins are still
              checked against the returned Studio super-admin access. Dev login is only available
              when Studio enables it.
            </p>
          </form>
        )}
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
      <path
        fill="#4285F4"
        d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"
      />
      <path
        fill="#34A853"
        d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"
      />
      <path
        fill="#FBBC05"
        d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z"
      />
      <path
        fill="#EA4335"
        d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"
      />
    </svg>
  );
}

function MicrosoftIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 21 21" aria-hidden="true">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

export default function LoginPage() {
  return (
    <Suspense fallback={<div className="w-full max-w-md animate-fade-in-scale">Loading...</div>}>
      <LoginForm />
    </Suspense>
  );
}
