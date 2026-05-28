'use client';

import { useEffect, useState } from 'react';
import { useRouter, useParams } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { Loader2, CheckCircle, XCircle, Users } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { initializeAuth, scheduleTokenRefresh } from '@/api/auth';

interface InvitationDetails {
  email: string;
  role: string;
  status: string;
  workspaceName: string;
  inviterName: string | null;
  expiresAt: string;
  canSignUp: boolean;
}

/**
 * Check if an email could match a masked email like "ab***@domain.com".
 * Returns true if the visible parts match, false if they definitely don't.
 */
function emailMatchesMask(fullEmail: string, maskedEmail: string): boolean {
  if (!maskedEmail.includes('***')) return fullEmail.toLowerCase() === maskedEmail.toLowerCase();
  const [maskedLocal, maskedDomain] = maskedEmail.split('@');
  const [fullLocal, fullDomain] = fullEmail.toLowerCase().split('@');
  if (!maskedLocal || !maskedDomain || !fullLocal || !fullDomain) return false;
  if (maskedDomain.toLowerCase() !== fullDomain) return false;
  const visiblePrefix = maskedLocal.replace('***', '');
  return fullLocal.startsWith(visiblePrefix.toLowerCase());
}

export default function InviteAcceptPage() {
  const t = useTranslations('auth.invite');
  const router = useRouter();
  const params = useParams();
  const token = params.token as string;
  const { accessToken, user, setAuth } = useAuthStore();

  const [invitation, setInvitation] = useState<InvitationDetails | null>(null);
  const [status, setStatus] = useState<'loading' | 'ready' | 'accepting' | 'success' | 'error'>(
    'loading',
  );
  const [error, setError] = useState('');

  useEffect(() => {
    // Restore auth from httpOnly refresh cookie (access token is not persisted)
    initializeAuth();
    fetchInvitation();
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchInvitation = async () => {
    try {
      const response = await fetch(`/api/invitations/${token}`);
      const data = await response.json();

      if (!response.ok) {
        setError(data.error || t('not_found'));
        setStatus('error');
        return;
      }

      setInvitation(data.invitation);

      if (data.invitation.status !== 'pending') {
        setError(t('already_used'));
        setStatus('error');
        return;
      }

      if (new Date(data.invitation.expiresAt) < new Date()) {
        setError(t('expired'));
        setStatus('error');
        return;
      }

      setStatus('ready');
    } catch {
      setError(t('load_failed'));
      setStatus('error');
    }
  };

  const handleAccept = async () => {
    if (!accessToken) return;
    setStatus('accepting');

    try {
      const response = await fetch('/api/invitations/accept', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({ token }),
      });

      const data = await response.json();

      if (!response.ok) {
        setError(data.error || t('accept_failed'));
        setStatus('error');
        return;
      }

      // Update auth with new tokens scoped to the workspace
      if (user) {
        setAuth(user, data.accessToken);
        scheduleTokenRefresh(data.expiresIn);
      }

      setStatus('success');
      setTimeout(() => router.push('/'), 1500);
    } catch {
      setError(t('error_generic'));
      setStatus('error');
    }
  };

  if (status === 'loading') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-6 h-6 text-muted animate-spin" />
      </div>
    );
  }

  if (status === 'error') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center px-4">
        <div className="text-center max-w-sm">
          <XCircle className="w-12 h-12 text-error mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-foreground mb-2">{t('unavailable_title')}</h1>
          <p className="text-muted text-sm mb-6">{error}</p>
          <a href="/" className="text-sm text-muted hover:text-foreground transition-default">
            {t('go_home')}
          </a>
        </div>
      </div>
    );
  }

  if (status === 'success') {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <div className="text-center">
          <CheckCircle className="w-12 h-12 text-accent mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-foreground mb-2">{t('success_title')}</h1>
          <p className="text-muted text-sm">
            {t('redirecting_to', { workspace: invitation?.workspaceName ?? '' })}
          </p>
        </div>
      </div>
    );
  }

  // Ready state
  return (
    <div className="min-h-screen bg-background flex items-center justify-center px-4">
      <div className="text-center max-w-sm">
        <div className="w-14 h-14 bg-accent-subtle rounded-2xl flex items-center justify-center mx-auto mb-4">
          <Users className="w-7 h-7 text-accent" />
        </div>
        <h1 className="text-xl font-semibold text-foreground mb-2">{t('invited_title')}</h1>
        <p className="text-muted text-sm mb-6">
          {t('invited_description', {
            inviter: invitation?.inviterName ?? '',
            workspace: invitation?.workspaceName ?? '',
            role: invitation?.role ?? '',
          })}
        </p>

        {accessToken ? (
          <div className="space-y-3">
            {user?.email &&
              invitation?.email &&
              !emailMatchesMask(user.email, invitation.email) && (
                <div className="p-3 bg-warning-subtle border border-warning/30 rounded-lg text-sm text-foreground">
                  {t('email_mismatch', {
                    loggedInEmail: user.email,
                    invitedEmail: invitation.email,
                  })}
                </div>
              )}
            <button
              onClick={handleAccept}
              disabled={status === 'accepting'}
              className="w-full py-2.5 bg-accent text-accent-foreground rounded-lg hover:opacity-90 disabled:opacity-50 disabled:cursor-not-allowed font-medium text-sm flex items-center justify-center gap-2 transition-default btn-press"
            >
              {status === 'accepting' ? <Loader2 className="w-4 h-4 animate-spin" /> : null}
              {t('accept')}
            </button>
          </div>
        ) : (
          <div className="space-y-3">
            {invitation?.canSignUp && (
              <a
                href={`/auth/signup?invite=${token}`}
                className="block w-full py-2.5 bg-accent text-accent-foreground rounded-lg hover:opacity-90 font-medium text-sm text-center transition-default btn-press"
              >
                {t('signup_to_accept')}
              </a>
            )}
            <a
              href={`/auth/login?invite=${token}`}
              className="block w-full py-2.5 bg-background border border-default text-foreground rounded-lg hover:bg-background-muted font-medium text-sm text-center transition-default btn-press"
            >
              {t('signin_to_accept')}
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
