'use client';

/**
 * Invitation Picker Page
 *
 * Shown when a user has multiple pending workspace invitations.
 * They choose which workspace to join, or can create their own.
 */

import { useEffect, useState } from 'react';
import { Loader2, Building2, UserPlus, ArrowRight } from 'lucide-react';
import { useAuthStore } from '@/store/auth-store';
import { fetchCurrentUser, scheduleTokenRefresh } from '@/api/auth';
import { sanitizeError } from '@/lib/sanitize-error';

interface PendingInvitation {
  id: string;
  workspaceName: string;
  role: string;
  inviterName: string | null;
  expiresAt: string;
}

export default function InvitationChoosePage() {
  const [invitations, setInvitations] = useState<PendingInvitation[]>([]);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { user, accessToken, tenantId, setAuth } = useAuthStore();

  useEffect(() => {
    async function loadInvitations() {
      try {
        const response = await fetch('/api/invitations/pending', {
          headers: accessToken ? { Authorization: `Bearer ${accessToken}` } : {},
          credentials: 'same-origin',
        });

        if (!response.ok) {
          throw new Error('Failed to fetch invitations');
        }

        const data = await response.json();
        setInvitations(data.invitations || []);

        // If no invitations (expired/revoked since redirect), show empty state
        if (!data.invitations || data.invitations.length === 0) {
          setError('no_invitations');
        }
      } catch (err) {
        console.error('Failed to load invitations:', err);
        setError('load_failed');
      } finally {
        setLoading(false);
      }
    }

    // If user already has a tenantId, redirect to home
    if (tenantId) {
      window.location.href = '/';
      return;
    }

    loadInvitations();
  }, [accessToken, tenantId]);

  async function handleAccept(invitationId: string) {
    setAccepting(invitationId);
    setError(null);

    try {
      const response = await fetch('/api/invitations/accept-by-id', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
        },
        credentials: 'same-origin',
        body: JSON.stringify({ invitationId }),
      });

      if (!response.ok) {
        const data = await response.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to accept invitation');
      }

      const data = await response.json();

      // Update auth state with the new access token (scoped to the accepted workspace)
      if (data.accessToken) {
        const updatedUser = await fetchCurrentUser(data.accessToken);
        setAuth(updatedUser, data.accessToken);
        if (data.expiresIn) {
          scheduleTokenRefresh(data.expiresIn);
        }
      }

      // Redirect to home
      window.location.href = '/';
    } catch (err) {
      console.error('Failed to accept invitation:', err);
      setError(sanitizeError(err, 'Failed to accept invitation'));
      setAccepting(null);
    }
  }

  if (loading) {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 text-accent animate-spin" />
      </div>
    );
  }

  if (error === 'no_invitations') {
    return (
      <div className="h-screen bg-background flex items-center justify-center">
        <div className="text-center max-w-md">
          <Building2 className="w-12 h-12 text-muted mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-foreground mb-2">No pending invitations</h1>
          <p className="text-muted mb-6">
            {user?.canCreateWorkspace !== false
              ? 'Your invitations may have expired. You can create your own workspace instead.'
              : 'Your invitations may have expired. Contact your workspace administrator for a new invitation.'}
          </p>
          {user?.canCreateWorkspace !== false && (
            <a
              href="/onboarding"
              className="inline-flex items-center gap-2 px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-default"
            >
              Create workspace
              <ArrowRight className="w-4 h-4" />
            </a>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen bg-background flex items-center justify-center p-4">
      <div className="w-full max-w-lg">
        <div className="text-center mb-8">
          <UserPlus className="w-12 h-12 text-accent mx-auto mb-4" />
          <h1 className="text-xl font-semibold text-foreground mb-2">Choose a workspace</h1>
          <p className="text-muted">You have been invited to join the following workspaces.</p>
        </div>

        {error && error !== 'no_invitations' && error !== 'load_failed' && (
          <div className="mb-4 p-3 bg-error-subtle text-error rounded-lg text-sm">{error}</div>
        )}

        {error === 'load_failed' && (
          <div className="text-center">
            <p className="text-error mb-4">Failed to load invitations. Please try again.</p>
            <button
              onClick={() => window.location.reload()}
              className="px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-default"
            >
              Retry
            </button>
          </div>
        )}

        <div className="space-y-3">
          {invitations.map((inv) => (
            <div
              key={inv.id}
              className="border border-default rounded-lg p-4 bg-background-muted hover:bg-background-elevated transition-default"
            >
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="font-medium text-foreground">{inv.workspaceName}</h3>
                  <p className="text-sm text-muted">
                    Role: <span className="font-medium">{inv.role}</span>
                    {inv.inviterName && <> &middot; Invited by {inv.inviterName}</>}
                  </p>
                  <p className="text-xs text-muted mt-1">
                    Expires {new Date(inv.expiresAt).toLocaleDateString()}
                  </p>
                </div>
                <button
                  onClick={() => handleAccept(inv.id)}
                  disabled={accepting !== null}
                  className="px-4 py-2 bg-accent text-accent-foreground rounded-lg hover:opacity-90 transition-default disabled:opacity-50 flex items-center gap-2"
                >
                  {accepting === inv.id ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Accept'}
                </button>
              </div>
            </div>
          ))}
        </div>

        {user?.canCreateWorkspace !== false && (
          <div className="mt-6 text-center">
            <a
              href="/onboarding"
              className="text-sm text-muted hover:text-foreground transition-default"
            >
              Create my own workspace instead
            </a>
          </div>
        )}
      </div>
    </div>
  );
}
