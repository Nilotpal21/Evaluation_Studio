'use client';

import { Suspense, useEffect, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { Loader2, CheckCircle, Mail } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/auth-store';
import { scheduleTokenRefresh } from '@/api/auth';

export default function VerifyEmailPage() {
  return (
    <Suspense
      fallback={
        <div className="min-h-screen bg-background flex items-center justify-center">
          <Loader2 className="w-6 h-6 text-muted animate-spin" />
        </div>
      }
    >
      <VerifyEmailContent />
    </Suspense>
  );
}

function VerifyEmailContent() {
  const t = useTranslations('auth.verify_email_page');
  const router = useRouter();
  const searchParams = useSearchParams();
  const token = searchParams.get('token');
  const email = searchParams.get('email');
  const inviteToken = searchParams.get('invite');
  const { setAuth } = useAuthStore();

  const [status, setStatus] = useState<'waiting' | 'verifying' | 'success' | 'error'>('waiting');
  const [error, setError] = useState('');
  const [isResending, setIsResending] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);

  useEffect(() => {
    if (token) {
      verifyToken(token);
    }
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const verifyToken = async (verificationToken: string) => {
    setStatus('verifying');

    try {
      const response = await fetch('/api/auth/verify-email', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: verificationToken }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || t('error_generic'));
        setStatus('error');
        return;
      }

      setAuth(data.user, data.accessToken);
      scheduleTokenRefresh(data.expiresIn);
      setStatus('success');

      setTimeout(() => {
        if (inviteToken && data.needsOnboarding) {
          // Auto-accept failed — send user back to the invite page to accept manually
          router.push(`/invite/${inviteToken}`);
        } else if (data.pendingInvitationChoice) {
          router.push('/invitations/choose');
        } else if (data.needsOnboarding) {
          router.push('/onboarding');
        } else {
          router.push('/');
        }
      }, 1500);
    } catch {
      setError(t('error_generic'));
      setStatus('error');
    }
  };

  const handleResend = async () => {
    if (!email || isResending) return;
    setIsResending(true);

    try {
      const response = await fetch('/api/auth/resend-verification', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });
      if (response.ok) {
        setResendSuccess(true);
        setTimeout(() => setResendSuccess(false), 5000);
      }
    } catch {
      // Ignore errors
    } finally {
      setIsResending(false);
    }
  };

  if (status === 'verifying') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="text-center">
          <Loader2 className="w-12 h-12 text-accent animate-spin mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-foreground">{t('verifying_title')}</h1>
        </div>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="text-center">
          <CheckCircle className="w-12 h-12 text-accent mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-foreground mb-2">{t('success_title')}</h1>
          <p className="text-muted text-sm">{t('redirecting')}</p>
        </div>
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="w-12 h-12 bg-error-subtle rounded-full flex items-center justify-center mx-auto mb-4">
            <Mail className="w-6 h-6 text-error" />
          </div>
          <h1 className="text-xl font-semibold text-foreground mb-2">{t('error_title')}</h1>
          <p className="text-muted mb-4">{error}</p>
          <a
            href="/auth/signup"
            className="inline-block px-4 py-2.5 bg-accent text-accent-foreground rounded-lg hover:opacity-90 font-medium text-sm transition-default btn-press"
          >
            {t('try_signup_again')}
          </a>
        </div>
      </div>
    );
  }

  // Waiting state — user needs to check email
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="text-center max-w-sm">
        <div className="w-12 h-12 bg-accent-subtle rounded-full flex items-center justify-center mx-auto mb-4">
          <Mail className="w-6 h-6 text-accent" />
        </div>
        <h1 className="text-xl font-semibold text-foreground mb-2">{t('check_email_title')}</h1>
        <p className="text-muted mb-6">
          {email ? t('check_email_message', { email }) : t('check_email_message_no_email')}
        </p>

        {email && (
          <button
            onClick={handleResend}
            disabled={isResending || resendSuccess}
            className="text-sm text-muted hover:text-foreground transition-default disabled:opacity-50"
          >
            {resendSuccess ? t('resent') : isResending ? t('resending') : t('resend')}
          </button>
        )}

        <p className="mt-6 text-xs text-subtle">
          {t('wrong_email')}{' '}
          <a href="/auth/signup" className="text-muted hover:text-foreground transition-default">
            {t('signup_again')}
          </a>
        </p>
      </div>
    </div>
  );
}
