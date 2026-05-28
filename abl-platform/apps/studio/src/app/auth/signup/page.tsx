'use client';

import { Suspense, useState, useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, Check, X } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { KoreIcon } from '@/components/ui/KoreLogo';
import { AccessRequestForm } from '@/components/auth/AccessRequestForm';

export default function SignupPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-muted animate-spin" />
        </div>
      }
    >
      <SignupContent />
    </Suspense>
  );
}

function SignupContent() {
  const t = useTranslations('auth.signup_page');
  const tSignup = useTranslations('auth.signup');
  const tPwChecks = useTranslations('auth.password_checks');
  const router = useRouter();
  const searchParams = useSearchParams();
  const inviteToken = searchParams.get('invite');

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [showAccessRequest, setShowAccessRequest] = useState(false);

  useEffect(() => {
    const ref = searchParams.get('ref');
    const prefillEmail = searchParams.get('email');
    if (prefillEmail) {
      setEmail(prefillEmail);
    }
    if (ref === 'login') {
      setInfo(t('new_user_banner'));
    }
  }, [searchParams, t]);

  const passwordChecks = {
    length: password.length >= 8,
    uppercase: /[A-Z]/.test(password),
    lowercase: /[a-z]/.test(password),
    number: /[0-9]/.test(password),
  };
  const allChecksPassed = Object.values(passwordChecks).every(Boolean);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setInfo('');
    setShowAccessRequest(false);

    if (!allChecksPassed) {
      setError(t('password_requirements_error'));
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email,
          password,
          name,
          ...(inviteToken ? { inviteToken } : {}),
        }),
      });

      const data = await response.json();

      if (!response.ok) {
        if (data.code === 'DOMAIN_NOT_ALLOWED') {
          setShowAccessRequest(true);
        }
        setError(data.error || tSignup('error_generic'));
        setIsLoading(false);
        return;
      }

      if (data.accountExists) {
        const params = new URLSearchParams({ email, ref: 'signup' });
        if (inviteToken) params.set('invite', inviteToken);
        router.push(`/auth/login?${params}`);
        // Keep loading visible during navigation
        return;
      }

      // Success — keep loading hidden via success screen
      setSuccess(true);
      setIsLoading(false);
      setTimeout(() => {
        const params = new URLSearchParams({ email });
        if (inviteToken) params.set('invite', inviteToken);
        router.push(`/auth/verify-email?${params}`);
      }, 1500);
    } catch {
      setError(t('error_generic'));
      setIsLoading(false);
    }
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

  if (success) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="text-center">
          <div className="w-12 h-12 bg-accent-subtle rounded-full flex items-center justify-center mx-auto mb-4">
            <Check className="w-6 h-6 text-accent" />
          </div>
          <h1 className="text-xl font-semibold text-foreground mb-2">{t('success_title')}</h1>
          <p className="text-muted text-sm">{t('success_subtitle')}</p>
        </div>
      </div>
    );
  }

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

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-error-subtle border border-default rounded-lg text-error text-sm">
              {error}
            </div>
          )}
          {showAccessRequest && <AccessRequestForm email={email.trim()} />}

          <div>
            <label htmlFor="name" className="block text-sm font-medium text-foreground mb-1.5">
              {t('name_label')}
            </label>
            <input
              id="name"
              type="text"
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="w-full px-3 py-2.5 bg-background border border-default rounded-lg text-foreground text-sm placeholder-subtle focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:border-foreground/30 transition-default"
              placeholder={tSignup('name_placeholder')}
            />
          </div>

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-foreground mb-1.5">
              {tSignup('email_label')}
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2.5 bg-background border border-default rounded-lg text-foreground text-sm placeholder-subtle focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:border-foreground/30 transition-default"
              placeholder={tSignup('email_placeholder')}
            />
          </div>

          <div>
            <label htmlFor="password" className="block text-sm font-medium text-foreground mb-1.5">
              {tSignup('password_label')}
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full px-3 py-2.5 bg-background border border-default rounded-lg text-foreground text-sm placeholder-subtle focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:border-foreground/30 transition-default"
              placeholder={tSignup('password_placeholder')}
            />
            {password.length > 0 && (
              <div className="mt-2 space-y-1">
                <PasswordCheck label={tPwChecks('length')} passed={passwordChecks.length} />
                <PasswordCheck label={tPwChecks('uppercase')} passed={passwordChecks.uppercase} />
                <PasswordCheck label={tPwChecks('lowercase')} passed={passwordChecks.lowercase} />
                <PasswordCheck label={tPwChecks('number')} passed={passwordChecks.number} />
              </div>
            )}
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 bg-accent text-accent-foreground rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm flex items-center justify-center gap-2 transition-default btn-press"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {t('create_account')}
          </button>
        </form>

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

        <p className="mt-8 text-center text-sm text-muted">
          {t('has_account')}{' '}
          <a
            href={inviteToken ? `/auth/login?invite=${inviteToken}` : '/auth/login'}
            className="text-foreground font-medium hover:underline"
          >
            {t('signin_link')}
          </a>
        </p>
      </div>
    </div>
  );
}

function PasswordCheck({ label, passed }: { label: string; passed: boolean }) {
  return (
    <div className="flex items-center gap-2 text-xs">
      {passed ? <Check className="w-3 h-3 text-success" /> : <X className="w-3 h-3 text-subtle" />}
      <span className={passed ? 'text-success' : 'text-subtle'}>{label}</span>
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
