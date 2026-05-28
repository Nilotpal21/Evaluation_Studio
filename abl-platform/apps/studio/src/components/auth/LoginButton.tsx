/**
 * Login Button Component
 *
 * Full auth options: email login, Google OAuth, and dev login.
 * Uses semantic design tokens for theme-awareness.
 */

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import { getGoogleLoginUrl } from '../../api/auth';
import { useAuthStore } from '../../store/auth-store';
import { useRuntimeConfig } from '../../contexts/RuntimeConfigContext';

interface LoginButtonProps {
  className?: string;
}

export function LoginButton({ className = '' }: LoginButtonProps) {
  const t = useTranslations('auth.login_button');
  const { googleClientId, enableDevLogin } = useRuntimeConfig();
  const showDevLogin = enableDevLogin || !googleClientId;
  const [isDevLoggingIn, setIsDevLoggingIn] = useState(false);
  const { setAuth } = useAuthStore();

  const handleGoogleLogin = () => {
    window.location.href = getGoogleLoginUrl();
  };

  const handleMicrosoftLogin = () => {
    window.location.href = '/api/auth/microsoft';
  };

  const handleLinkedInLogin = () => {
    window.location.href = '/api/auth/linkedin';
  };

  const handleEmailLogin = () => {
    window.location.href = '/auth/login';
  };

  const handleDevLogin = async () => {
    setIsDevLoggingIn(true);
    try {
      const response = await fetch('/api/auth/dev-login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: 'dev@kore.ai',
          name: 'Developer',
        }),
      });

      if (response.ok) {
        const data = await response.json();
        setAuth(data.user, data.accessToken);
      } else {
        const error = await response.json();
        alert(t('dev_login_failed', { error: error.error || t('unknown_error') }));
      }
    } catch {
      alert(t('dev_login_server_unreachable'));
    } finally {
      setIsDevLoggingIn(false);
    }
  };

  return (
    <div className={`flex flex-col gap-2 ${className}`}>
      <button
        onClick={handleEmailLogin}
        className="flex items-center justify-center gap-2 px-4 py-2.5 bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-default font-medium text-sm btn-press"
      >
        {t('sign_in_email')}
      </button>

      <div className="flex items-center justify-center gap-4">
        <button
          onClick={handleGoogleLogin}
          title={t('sign_in_google')}
          className="flex items-center justify-center w-20 h-12 bg-background border border-default rounded-lg hover:bg-background-muted transition-default btn-press"
        >
          <GoogleIcon />
        </button>

        <button
          onClick={handleMicrosoftLogin}
          title="Sign in with Microsoft"
          className="flex items-center justify-center w-20 h-12 bg-background border border-default rounded-lg hover:bg-background-muted transition-default btn-press"
        >
          <MicrosoftIcon />
        </button>

        <button
          onClick={handleLinkedInLogin}
          title="Sign in with LinkedIn"
          className="flex items-center justify-center w-20 h-12 bg-background border border-default rounded-lg hover:bg-background-muted transition-default btn-press"
        >
          <LinkedInIcon />
        </button>
      </div>

      {showDevLogin && (
        <button
          onClick={handleDevLogin}
          disabled={isDevLoggingIn}
          className="flex items-center justify-center gap-2 px-4 py-2.5 bg-background-muted text-muted border border-default rounded-lg hover:bg-background-elevated transition-default text-sm disabled:opacity-50 btn-press"
        >
          {isDevLoggingIn ? t('signing_in') : t('dev_login')}
        </button>
      )}

      <p className="text-center text-xs text-subtle mt-1">
        {t('no_account')}{' '}
        <a href="/auth/signup" className="text-info hover:underline">
          {t('sign_up')}
        </a>
      </p>
    </div>
  );
}

function GoogleIcon() {
  return (
    <svg className="w-4 h-4" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg">
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
