'use client';

import { useState } from 'react';
import { Loader2, Check, ArrowLeft } from 'lucide-react';
import { useTranslations } from 'next-intl';

export default function ForgotPasswordPage() {
  const t = useTranslations('auth.forgot_password_page');
  const tForgot = useTranslations('auth.forgot_password');
  const [email, setEmail] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [success, setSuccess] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setIsLoading(true);

    try {
      const response = await fetch('/api/auth/forgot-password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
      });

      if (!response.ok) {
        const data = await response.json();
        setError(data.error || t('error_generic'));
        return;
      }

      setSuccess(true);
    } catch {
      setError(t('error_generic'));
    } finally {
      setIsLoading(false);
    }
  };

  if (success) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <div className="w-12 h-12 bg-accent-subtle rounded-full flex items-center justify-center mx-auto mb-4">
            <Check className="w-6 h-6 text-accent" />
          </div>
          <h1 className="text-xl font-semibold text-foreground mb-2">{t('success_title')}</h1>
          <p className="text-muted mb-6">{t('success_message')}</p>
          <a
            href="/auth/login"
            className="text-sm text-muted hover:text-foreground transition-default"
          >
            {t('back_to_sign_in')}
          </a>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <a
          href="/auth/login"
          className="flex items-center gap-1 text-sm text-muted hover:text-foreground mb-6"
        >
          <ArrowLeft className="w-4 h-4" />
          {t('back_to_sign_in')}
        </a>

        <div className="mb-8">
          <h1 className="text-2xl font-semibold text-foreground">{t('heading')}</h1>
          <p className="text-muted text-sm mt-2">{t('subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-error-subtle border border-default rounded-lg text-error text-sm">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="email" className="block text-sm font-medium text-foreground mb-1.5">
              {tForgot('email_label')}
            </label>
            <input
              id="email"
              type="email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
              className="w-full px-3 py-2.5 bg-background border border-default rounded-lg text-foreground text-sm placeholder-subtle focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:border-foreground/30 transition-default"
              placeholder={tForgot('email_placeholder')}
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 bg-accent text-accent-foreground rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm flex items-center justify-center gap-2 transition-default btn-press"
          >
            {isLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
            {t('send_reset_link')}
          </button>
        </form>
      </div>
    </div>
  );
}
