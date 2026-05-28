'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, ArrowRight, Building2 } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useAuthStore } from '@/store/auth-store';
import { initializeAuth, scheduleTokenRefresh } from '@/api/auth';
import { buildDefaultWorkspaceName } from '@/lib/workspace-name';

export default function OnboardingPage() {
  const router = useRouter();
  const { accessToken, user, setAuth } = useAuthStore();
  const t = useTranslations('onboarding.workspace');
  const [workspaceName, setWorkspaceName] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState('');
  const [authReady, setAuthReady] = useState(false);

  // Initialize auth on mount — access token is memory-only, lost on hard redirect
  useEffect(() => {
    initializeAuth()
      .catch((err) => console.error('[Onboarding] Failed to initialize auth:', err))
      .finally(() => setAuthReady(true));
  }, []);

  useEffect(() => {
    // Pre-fill with user's name
    if (user?.name) {
      setWorkspaceName(buildDefaultWorkspaceName(user.name));
    }
  }, [user?.name]);

  // Redirect if not authenticated (only after auth initialization completes)
  useEffect(() => {
    if (authReady && !accessToken) {
      router.push('/auth/login');
    }
  }, [authReady, accessToken, router]);

  // Invited-only users cannot create workspaces
  if (authReady && accessToken && user?.canCreateWorkspace === false) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="w-full max-w-sm text-center">
          <div className="w-14 h-14 bg-accent-subtle rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Building2 className="w-7 h-7 text-accent" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground mb-2">Join a workspace</h1>
          <p className="text-muted text-sm">
            Workspace creation requires an allowlisted domain or email. Accept an invitation to join
            an existing workspace, or contact your platform administrator.
          </p>
        </div>
      </div>
    );
  }

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!workspaceName.trim() || workspaceName.trim().length < 2) {
      setError(t('name_min_error'));
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch('/api/auth/create-workspace', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ name: workspaceName.trim() }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || t('create_failed'));
        setIsLoading(false);
        return;
      }

      // Update auth state with new tokens (which include tenantId)
      if (user) {
        setAuth(user, data.accessToken);
        scheduleTokenRefresh(data.expiresIn);
      }

      // Keep loading visible — full page redirect follows
      window.location.href = '/';
    } catch {
      setError(t('error_generic'));
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="w-full max-w-sm">
        <div className="text-center mb-8">
          <div className="w-14 h-14 bg-accent-subtle rounded-2xl flex items-center justify-center mx-auto mb-4">
            <Building2 className="w-7 h-7 text-accent" />
          </div>
          <h1 className="text-2xl font-semibold text-foreground">{t('title')}</h1>
          <p className="text-muted text-sm mt-2">{t('subtitle')}</p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="p-3 bg-error-subtle border border-default rounded-lg text-error text-sm">
              {error}
            </div>
          )}

          <div>
            <label
              htmlFor="workspaceName"
              className="block text-sm font-medium text-foreground mb-1.5"
            >
              {t('name_label')}
            </label>
            <input
              id="workspaceName"
              type="text"
              value={workspaceName}
              onChange={(e) => setWorkspaceName(e.target.value)}
              required
              autoFocus
              className="w-full px-3 py-2.5 bg-background border border-default rounded-lg text-foreground text-sm placeholder-subtle focus:outline-none focus:ring-2 focus:ring-foreground/20 focus:border-foreground/30 transition-default"
              placeholder={t('name_placeholder')}
            />
            <p className="mt-1.5 text-xs text-subtle">{t('name_hint')}</p>
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full py-2.5 bg-accent text-accent-foreground rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm flex items-center justify-center gap-2 transition-default btn-press"
          >
            {isLoading ? (
              <Loader2 className="w-4 h-4 animate-spin" />
            ) : (
              <ArrowRight className="w-4 h-4" />
            )}
            {t('create_button')}
          </button>
        </form>
      </div>
    </div>
  );
}
