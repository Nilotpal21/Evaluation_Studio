'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { KoreIcon } from '@/components/ui/KoreLogo';
import { useAuthStore } from '@/store/auth-store';
import { scheduleTokenRefresh } from '@/api/auth';
import { useRuntimeConfig } from '@/contexts/RuntimeConfigContext';
import { AccessRequestForm } from '@/components/auth/AccessRequestForm';

export default function LoginPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-muted animate-spin" />
        </div>
      }
    >
      <LoginContent />
    </Suspense>
  );
}

function LoginContent() {
  const t = useTranslations('auth.login_page');
  const tLogin = useTranslations('auth.login');
  const { googleClientId, enableDevLogin } = useRuntimeConfig();
  const showDevLogin = enableDevLogin || !googleClientId;
  const router = useRouter();
  const searchParams = useSearchParams();
  const { setAuth } = useAuthStore();

  const [step, setStep] = useState<'email' | 'password'>('email');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [isDevLoading, setIsDevLoading] = useState(false);
  const [showVerificationPrompt, setShowVerificationPrompt] = useState(false);
  const [showAccessRequest, setShowAccessRequest] = useState(false);
  const [isResendingVerification, setIsResendingVerification] = useState(false);
  const [verificationResent, setVerificationResent] = useState(false);

  const inviteToken = searchParams.get('invite');

  useEffect(() => {
    const ref = searchParams.get('ref');
    const prefillEmail = searchParams.get('email');
    if (ref === 'signup') {
      setInfo(t('existing_user_banner'));
    }
    if (prefillEmail) {
      setEmail(prefillEmail);
    }
  }, [searchParams, t]);

  const handleEmailContinue = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setShowAccessRequest(false);

    if (!email.trim()) return;

    setIsLoading(true);
    try {
      const response = await fetch('/api/auth/resolve-account', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: email.trim(),
          ...(inviteToken ? { inviteToken } : {}),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (data.code === 'DOMAIN_NOT_ALLOWED') {
          setShowAccessRequest(true);
        }
        setError(data.error || t('error_generic'));
        setIsLoading(false);
        return;
      }

      if (data.status === 'new') {
        const params = new URLSearchParams({ email: email.trim(), ref: 'login' });
        if (inviteToken) params.set('invite', inviteToken);
        router.push(`/auth/signup?${params}`);
        // Keep loading visible during navigation
        return;
      }

      setStep('password');
      setIsLoading(false);
    } catch {
      setError(t('error_generic'));
      setIsLoading(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setShowAccessRequest(false);
    setIsLoading(true);

    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({
          email,
          password,
          ...(inviteToken ? { inviteToken } : {}),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        const requiresEmailVerification =
          response.status === 403 &&
          typeof data.error === 'string' &&
          data.error.toLowerCase().includes('verify your email');

        if (requiresEmailVerification) {
          setShowVerificationPrompt(true);
          setVerificationResent(false);
          setError('');
        } else if (data.code === 'DOMAIN_NOT_ALLOWED') {
          setShowVerificationPrompt(false);
          setShowAccessRequest(true);
          setError(data.error || tLogin('error_generic'));
        } else {
          setShowVerificationPrompt(false);
          setError(data.error || tLogin('error_generic'));
        }
        setIsLoading(false);
        return;
      }

      if (data.mfaRequired) {
        router.push('/auth/mfa');
        // Keep loading visible during navigation
        return;
      }

      // Merge isSuperAdmin from response into user for auth store
      const user = data.isSuperAdmin ? { ...data.user, isSuperAdmin: true } : data.user;
      setAuth(user, data.accessToken);
      scheduleTokenRefresh(data.expiresIn);

      // Keep loading visible — full page redirect follows
      if (inviteToken) {
        window.location.href = `/invite/${inviteToken}`;
      } else if (data.pendingInvitationChoice) {
        window.location.href = '/invitations/choose';
      } else if (data.needsOnboarding) {
        window.location.href = '/onboarding';
      } else {
        window.location.href = '/';
      }
    } catch {
      setError(t('error_generic'));
      setIsLoading(false);
    }
  };

  const handleResendVerification = async () => {
    if (isResendingVerification) return;
    setIsResendingVerification(true);
    try {
      await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      setVerificationResent(true);
    } catch {
      // Ignore — anti-enumeration means we always show success
    } finally {
      setIsResendingVerification(false);
    }
  };

  const handleBackToEmail = () => {
    setStep('email');
    setPassword('');
    setError('');
    setInfo('');
    setShowVerificationPrompt(false);
    setShowAccessRequest(false);
    setVerificationResent(false);
  };

  const handleGoogleLogin = () => {
    const url = inviteToken ? `/api/auth/google?invite=${inviteToken}` : '/api/auth/google';
    window.location.href = url;
  };

  const handleMicrosoftLogin = () => {
    const url = inviteToken ? `/api/auth/microsoft?invite=${inviteToken}` : '/api/auth/microsoft';
    window.location.href = url;
  };

  const handleLinkedInLogin = () => {
    const url = inviteToken ? `/api/auth/linkedin?invite=${inviteToken}` : '/api/auth/linkedin';
    window.location.href = url;
  };

  const handleDevLogin = async () => {
    setIsDevLoading(true);
    setError('');
    try {
      const response = await fetch('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ email: 'dev@kore.ai', name: 'Developer' }),
      });
      const data = await response.json();
      if (!response.ok) {
        setError(data.error || t('dev_login_failed'));
        setIsDevLoading(false);
        return;
      }
      setAuth(data.user, data.accessToken);
      scheduleTokenRefresh(data.expiresIn);
      // Keep loading visible — full page redirect follows
      if (inviteToken) {
        window.location.href = `/invite/${inviteToken}`;
      } else {
        window.location.href = '/';
      }
    } catch {
      setError(t('dev_login_server_error'));
      setIsDevLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="flex justify-start mb-10">
          <KoreIcon className="text-foreground" size={28} />
        </div>

        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-foreground">{t('heading')}</h1>
          <p className="text-muted text-sm mt-2">{t('subtitle')}</p>
        </div>

        {info && (
          <div className="mb-4 p-3 bg-accent/10 border border-accent/20 rounded-lg text-sm text-foreground">
            {info}
          </div>
        )}

        {step === 'email' ? (
          <form onSubmit={handleEmailContinue} className="space-y-4">
            {error && (
              <div className="p-3 bg-error-subtle border border-default rounded-lg text-error text-sm">
                {error}
              </div>
            )}
            {showAccessRequest && <AccessRequestForm email={email.trim()} />}

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-foreground mb-1.5">
                {t('email_address_label')}
              </label>
              <input
                id="email"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                autoFocus
                className="w-full px-3 py-2.5 bg-background border border-default rounded-lg text-foreground text-sm placeholder-subtle focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:border-foreground/30 transition-default"
                placeholder={tLogin('email_placeholder')}
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 bg-accent text-accent-foreground rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm flex items-center justify-center gap-2 transition-default btn-press"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('continue_email')}
            </button>
          </form>
        ) : (
          <form onSubmit={handleLogin} className="space-y-4">
            {error && (
              <div className="p-3 bg-error-subtle border border-default rounded-lg text-error text-sm">
                {error}
              </div>
            )}
            {showAccessRequest && <AccessRequestForm email={email.trim()} />}

            {showVerificationPrompt && (
              <div className="p-3 bg-warning-subtle border border-warning/30 rounded-lg text-sm">
                <p className="text-foreground font-medium mb-1">
                  {tLogin('email_not_verified_title')}
                </p>
                <p className="text-muted mb-3">{tLogin('email_not_verified_message')}</p>
                <button
                  type="button"
                  onClick={handleResendVerification}
                  disabled={isResendingVerification || verificationResent}
                  className="text-sm font-medium text-accent hover:text-accent/80 disabled:opacity-50"
                >
                  {verificationResent
                    ? tLogin('verification_resent')
                    : isResendingVerification
                      ? tLogin('verification_resending')
                      : tLogin('resend_verification')}
                </button>
              </div>
            )}

            <div>
              <button
                type="button"
                onClick={handleBackToEmail}
                className="flex items-center gap-1.5 text-sm text-muted hover:text-foreground transition-default mb-3"
              >
                <ArrowLeft className="w-3.5 h-3.5" />
                {t('back_to_email')}
              </button>
              <div className="px-3 py-2.5 bg-background-muted border border-default rounded-lg text-foreground text-sm">
                {email}
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label htmlFor="password" className="block text-sm font-medium text-foreground">
                  {tLogin('password_label')}
                </label>
                <a
                  href="/auth/forgot-password"
                  className="text-sm text-muted hover:text-foreground transition-default"
                >
                  {tLogin('forgot_password')}
                </a>
              </div>
              <input
                id="password"
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                autoFocus
                className="w-full px-3 py-2.5 bg-background border border-default rounded-lg text-foreground text-sm placeholder-subtle focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:border-foreground/30 transition-default"
                placeholder={tLogin('password_placeholder')}
              />
            </div>

            <button
              type="submit"
              disabled={isLoading}
              className="w-full py-2.5 bg-accent text-accent-foreground rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm flex items-center justify-center gap-2 transition-default btn-press"
            >
              {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {tLogin('submit')}
            </button>
          </form>
        )}

        <div className="my-6 flex items-center gap-3">
          <div className="flex-1 h-px bg-border-muted" />
          <span className="text-xs text-subtle">{t('or')}</span>
          <div className="flex-1 h-px bg-border-muted" />
        </div>

        <div className="flex items-center justify-center gap-4">
          <button
            onClick={handleGoogleLogin}
            title="Continue with Google"
            className="flex items-center justify-center w-20 h-12 bg-background border border-default rounded-lg hover:bg-background-muted transition-default btn-press"
          >
            <GoogleIcon />
          </button>

          <button
            onClick={handleMicrosoftLogin}
            title="Continue with Microsoft"
            className="flex items-center justify-center w-20 h-12 bg-background border border-default rounded-lg hover:bg-background-muted transition-default btn-press"
          >
            <MicrosoftIcon />
          </button>

          <button
            onClick={handleLinkedInLogin}
            title="Continue with LinkedIn"
            className="flex items-center justify-center w-20 h-12 bg-background border border-default rounded-lg hover:bg-background-muted transition-default btn-press"
          >
            <LinkedInIcon />
          </button>
        </div>

        {showDevLogin && (
          <>
            <div className="my-6 flex items-center gap-3">
              <div className="flex-1 h-px bg-border-muted" />
              <span className="text-xs text-subtle">{t('dev_section')}</span>
              <div className="flex-1 h-px bg-border-muted" />
            </div>
            <button
              onClick={handleDevLogin}
              disabled={isDevLoading}
              className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-background-muted text-muted border border-default rounded-lg hover:bg-background-elevated font-medium text-sm disabled:opacity-50 transition-default btn-press"
            >
              {isDevLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('dev_login')}
            </button>
          </>
        )}

        <p className="mt-8 text-center text-sm text-muted">
          {t('signup_prompt')}{' '}
          <a
            href={inviteToken ? `/auth/signup?invite=${inviteToken}` : '/auth/signup'}
            className="text-foreground font-medium hover:underline"
          >
            {t('signup_link')}
          </a>
        </p>
      </div>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24">
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
    <svg className="w-4 h-4" viewBox="0 0 21 21">
      <rect x="1" y="1" width="9" height="9" fill="#F25022" />
      <rect x="1" y="11" width="9" height="9" fill="#00A4EF" />
      <rect x="11" y="1" width="9" height="9" fill="#7FBA00" />
      <rect x="11" y="11" width="9" height="9" fill="#FFB900" />
    </svg>
  );
}

function LinkedInIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24">
      <path
        fill="#0A66C2"
        d="M20.447 20.452h-3.554v-5.569c0-1.328-.027-3.037-1.852-3.037-1.853 0-2.136 1.445-2.136 2.939v5.667H9.351V9h3.414v1.561h.046c.477-.9 1.637-1.85 3.37-1.85 3.601 0 4.267 2.37 4.267 5.455v6.286zM5.337 7.433a2.062 2.062 0 01-2.063-2.065 2.064 2.064 0 112.063 2.065zm1.782 13.019H3.555V9h3.564v11.452zM22.225 0H1.771C.792 0 0 .774 0 1.729v20.542C0 23.227.792 24 1.771 24h20.451C23.2 24 24 23.227 24 22.271V1.729C24 .774 23.2 0 22.222 0h.003z"
      />
    </svg>
  );
}
