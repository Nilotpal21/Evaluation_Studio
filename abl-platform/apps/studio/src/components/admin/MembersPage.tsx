/**
 * MembersPage Component
 *
 * Tenant-level admin page for managing workspace members and invitations.
 * Displays current members, pending invitations, and an invite form.
 * Supports role change, member removal, invitation resend, and revoke.
 */

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import {
  Users,
  Plus,
  Mail,
  Loader2,
  RefreshCw,
  RotateCw,
  X,
  UserX,
  UserCheck,
  LogOut,
  MoreVertical,
  Lock,
  Unlock,
  PauseCircle,
} from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { useAuthStore } from '../../store/auth-store';
import { useHasPermission } from '../../hooks/usePermissions';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { DropdownMenu, DropdownMenuItem, DropdownMenuSeparator } from '../ui/DropdownMenu';

// =============================================================================
// TYPES
// =============================================================================

type Role = 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER';
type MemberStatus = 'active' | 'deactivated' | 'suspended' | 'locked';

interface Member {
  id: string;
  userId: string;
  email: string;
  name?: string;
  role: Role;
  status?: MemberStatus;
  joinedAt: string;
}

interface Invitation {
  id: string;
  email: string;
  role: Role;
  status: string;
  createdAt: string;
  expiresAt?: string;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const ROLES: { value: Role; label: string }[] = [
  { value: 'OWNER', label: 'Owner' },
  { value: 'ADMIN', label: 'Admin' },
  { value: 'OPERATOR', label: 'Operator' },
  { value: 'MEMBER', label: 'Member' },
  { value: 'VIEWER', label: 'Viewer' },
];

const ROLE_BADGE_VARIANT: Record<Role, 'accent' | 'purple' | 'warning' | 'default' | 'info'> = {
  OWNER: 'accent',
  ADMIN: 'purple',
  OPERATOR: 'warning',
  MEMBER: 'default',
  VIEWER: 'info',
};

const STATUS_BADGE_VARIANT: Record<
  MemberStatus,
  'accent' | 'purple' | 'warning' | 'default' | 'info'
> = {
  active: 'accent',
  deactivated: 'default',
  suspended: 'warning',
  locked: 'purple',
};

// =============================================================================
// COMPONENT
// =============================================================================

export function MembersPage() {
  const t = useTranslations('admin');
  const tenantId = useAuthStore((s) => s.tenantId);
  const currentUserId = useAuthStore((s) => s.user?.id);
  // Gate SWR keys on the user actually having member-management permission so
  // non-admins do not generate 401/403 console noise on render.
  const canManageMembers = useHasPermission('tenant:manage_members');

  // SWR data fetching
  const membersKey = tenantId && canManageMembers ? `/api/workspaces/${tenantId}/members` : null;
  const invitationsKey =
    tenantId && canManageMembers ? `/api/workspaces/${tenantId}/invitations` : null;

  const {
    data: membersData,
    error: membersError,
    isLoading: loadingMembers,
    isValidating: refreshingMembers,
    mutate: mutateMembers,
  } = useSWR<Member[]>(membersKey, async (url: string) => {
    const res = await apiFetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to load members');
    }
    const data = await res.json();
    return Array.isArray(data) ? data : (data.members ?? []);
  });

  const {
    data: invitationsData,
    error: invitationsError,
    isLoading: loadingInvitations,
    mutate: mutateInvitations,
  } = useSWR<Invitation[]>(invitationsKey, async (url: string) => {
    const res = await apiFetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.error || 'Failed to load invitations');
    }
    const data = await res.json();
    return Array.isArray(data) ? data : (data.invitations ?? []);
  });

  const members = membersData ?? [];
  const invitations = invitationsData ?? [];

  const refreshAll = () => {
    mutateMembers();
    mutateInvitations();
  };

  // Invite form state
  const [inviteEmail, setInviteEmail] = useState('');
  const [inviteRole, setInviteRole] = useState<Role>('MEMBER');
  const [inviting, setInviting] = useState(false);
  const [showInviteForm, setShowInviteForm] = useState(false);

  // Action state
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<Member | null>(null);

  // Error / success state
  const [error, setError] = useState<string | null>(
    membersError
      ? sanitizeError(membersError, 'Failed to load members')
      : invitationsError
        ? sanitizeError(invitationsError, 'Failed to load invitations')
        : null,
  );
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  // Auto-dismiss success message
  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  // ---------------------------------------------------------------------------
  // INVITE HANDLER
  // ---------------------------------------------------------------------------

  const handleInvite = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!tenantId || !inviteEmail.trim()) return;

    setInviting(true);
    setError(null);
    setSuccessMessage(null);

    try {
      const res = await apiFetch(`/api/workspaces/${tenantId}/invitations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: inviteEmail.trim(), role: inviteRole }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to send invitation');
      }

      setSuccessMessage(t('members.invitation_sent', { email: inviteEmail.trim() }));
      setInviteEmail('');
      setInviteRole('MEMBER');
      setShowInviteForm(false);
      await mutateInvitations();
    } catch (err) {
      setError(sanitizeError(err, t('members.invite_failed')));
    } finally {
      setInviting(false);
    }
  };

  // ---------------------------------------------------------------------------
  // MEMBER ACTIONS
  // ---------------------------------------------------------------------------

  const handleChangeRole = async (member: Member, newRole: Role) => {
    if (!tenantId) return;
    setActionLoading(`role-${member.userId}`);
    setError(null);

    try {
      const res = await apiFetch(`/api/workspaces/${tenantId}/members/${member.userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to update role');
      }

      setSuccessMessage(t('members.role_changed', { role: newRole }));
      await mutateMembers();
    } catch (err) {
      setError(sanitizeError(err, t('members.role_change_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveMember = async (member: Member) => {
    if (!tenantId) return;
    setActionLoading(`remove-${member.userId}`);
    setError(null);
    setConfirmRemove(null);

    try {
      const res = await apiFetch(`/api/workspaces/${tenantId}/members/${member.userId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to remove member');
      }

      setSuccessMessage(t('members.member_removed'));
      await mutateMembers();
    } catch (err) {
      setError(sanitizeError(err, t('members.remove_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  // ---------------------------------------------------------------------------
  // LIFECYCLE ACTIONS
  // ---------------------------------------------------------------------------

  const handleDeactivate = async (member: Member) => {
    if (!tenantId) return;
    setActionLoading(`deactivate-${member.userId}`);
    setError(null);

    try {
      const res = await apiFetch(
        `/api/workspaces/${tenantId}/members/${member.userId}/deactivate`,
        { method: 'POST' },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || body.error || 'Failed to deactivate member');
      }

      setSuccessMessage(t('members.member_deactivated', { name: member.name || member.email }));
      await mutateMembers();
    } catch (err) {
      setError(sanitizeError(err, t('members.deactivate_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  const handleReactivate = async (member: Member) => {
    if (!tenantId) return;
    setActionLoading(`reactivate-${member.userId}`);
    setError(null);

    try {
      const res = await apiFetch(
        `/api/workspaces/${tenantId}/members/${member.userId}/reactivate`,
        { method: 'POST' },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || body.error || 'Failed to reactivate member');
      }

      setSuccessMessage(t('members.member_reactivated', { name: member.name || member.email }));
      await mutateMembers();
    } catch (err) {
      setError(sanitizeError(err, t('members.reactivate_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  const handleLock = async (member: Member) => {
    if (!tenantId) return;
    setActionLoading(`lock-${member.userId}`);
    setError(null);

    try {
      const res = await apiFetch(`/api/workspaces/${tenantId}/members/${member.userId}/lock`, {
        method: 'POST',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || body.error || 'Failed to lock member');
      }

      setSuccessMessage(`${member.name || member.email} has been locked`);
      await mutateMembers();
    } catch (err) {
      setError(sanitizeError(err, 'Failed to lock member'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleUnlock = async (member: Member) => {
    if (!tenantId) return;
    setActionLoading(`unlock-${member.userId}`);
    setError(null);

    try {
      const res = await apiFetch(`/api/workspaces/${tenantId}/members/${member.userId}/unlock`, {
        method: 'POST',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || body.error || 'Failed to unlock member');
      }

      setSuccessMessage(`${member.name || member.email} has been unlocked`);
      await mutateMembers();
    } catch (err) {
      setError(sanitizeError(err, 'Failed to unlock member'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleSuspend = async (member: Member) => {
    if (!tenantId) return;
    setActionLoading(`suspend-${member.userId}`);
    setError(null);

    try {
      const res = await apiFetch(`/api/workspaces/${tenantId}/members/${member.userId}/suspend`, {
        method: 'POST',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || body.error || 'Failed to suspend member');
      }

      setSuccessMessage(`${member.name || member.email} has been suspended`);
      await mutateMembers();
    } catch (err) {
      setError(sanitizeError(err, 'Failed to suspend member'));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRevokeSessions = async (member: Member) => {
    if (!tenantId) return;
    setActionLoading(`revoke-sessions-${member.userId}`);
    setError(null);

    try {
      const res = await apiFetch(
        `/api/workspaces/${tenantId}/members/${member.userId}/revoke-sessions`,
        { method: 'POST' },
      );

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error?.message || body.error || 'Failed to revoke sessions');
      }

      setSuccessMessage(t('members.sessions_revoked', { name: member.name || member.email }));
    } catch (err) {
      setError(sanitizeError(err, t('members.revoke_sessions_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  // ---------------------------------------------------------------------------
  // INVITATION ACTIONS
  // ---------------------------------------------------------------------------

  const handleResendInvitation = async (inv: Invitation) => {
    if (!tenantId) return;
    setActionLoading(`resend-${inv.id}`);
    setError(null);

    try {
      const res = await apiFetch(`/api/workspaces/${tenantId}/invitations/${inv.id}/resend`, {
        method: 'POST',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to resend invitation');
      }

      setSuccessMessage(t('members.invitation_resent', { email: inv.email }));
      await mutateInvitations();
    } catch (err) {
      setError(sanitizeError(err, t('members.resend_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRevokeInvitation = async (inv: Invitation) => {
    if (!tenantId) return;
    setActionLoading(`revoke-${inv.id}`);
    setError(null);

    try {
      const res = await apiFetch(`/api/workspaces/${tenantId}/invitations/${inv.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to revoke invitation');
      }

      setSuccessMessage(t('members.invitation_revoked'));
      await mutateInvitations();
    } catch (err) {
      setError(sanitizeError(err, t('members.revoke_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  // ---------------------------------------------------------------------------
  // HELPERS
  // ---------------------------------------------------------------------------

  const formatDate = (dateStr: string) => {
    try {
      return new Date(dateStr).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'short',
        day: 'numeric',
      });
    } catch {
      return dateStr;
    }
  };

  const canManageMember = (member: Member): boolean => {
    // Can't manage yourself or owners
    return member.userId !== currentUserId && member.role !== 'OWNER';
  };

  const refreshing = refreshingMembers;
  const isLoading = loadingMembers || loadingInvitations;
  const isMemberEmptyStateShown = !isLoading && members.length === 0;

  // ---------------------------------------------------------------------------
  // RENDER
  // ---------------------------------------------------------------------------

  return (
    <div className="flex-1 overflow-auto bg-noise">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        {/* Page header */}
        <PageHeader
          title={t('members.title')}
          description={t('members.description')}
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />}
                onClick={refreshAll}
                disabled={refreshing}
              >
                {t('members.refresh')}
              </Button>
              {!isMemberEmptyStateShown && (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Plus className="w-3.5 h-3.5" />}
                  onClick={() => setShowInviteForm(!showInviteForm)}
                >
                  {t('members.invite_member')}
                </Button>
              )}
            </div>
          }
        />

        {/* Error banner */}
        {error && (
          <div className="rounded-xl border border-error bg-error-subtle px-4 py-3 text-sm text-error flex items-center justify-between">
            <span>{error}</span>
            <button
              onClick={() => setError(null)}
              className="text-error hover:opacity-70 transition-default text-xs font-medium ml-4 shrink-0"
            >
              {t('members.dismiss')}
            </button>
          </div>
        )}

        {/* Success banner */}
        {successMessage && (
          <div className="rounded-xl border border-success bg-success-subtle px-4 py-3 text-sm text-success flex items-center gap-2">
            <Mail className="w-3.5 h-3.5 shrink-0" />
            <span>{successMessage}</span>
          </div>
        )}

        {/* Invite form card */}
        {showInviteForm && (
          <div className="rounded-xl border border-default bg-background-elevated p-5">
            <div className="flex items-center gap-2 mb-4">
              <Mail className="w-4 h-4 text-muted" />
              <h2 className="text-sm font-semibold text-foreground">
                {t('members.send_invitation')}
              </h2>
            </div>
            <form onSubmit={handleInvite} className="flex items-end gap-3">
              <div className="flex-1">
                <Input
                  label={t('members.email_label')}
                  type="email"
                  placeholder={t('members.email_placeholder')}
                  value={inviteEmail}
                  onChange={(e) => setInviteEmail(e.target.value)}
                  icon={<Mail className="w-4 h-4" />}
                  required
                />
              </div>
              <div className="w-40">
                <Select
                  label={t('members.role_label')}
                  options={ROLES}
                  value={inviteRole}
                  onChange={(v) => setInviteRole(v as Role)}
                />
              </div>
              <Button
                type="submit"
                variant="primary"
                size="md"
                loading={inviting}
                disabled={!inviteEmail.trim()}
              >
                {t('members.send_invite')}
              </Button>
            </form>
          </div>
        )}

        {/* Loading state */}
        {isLoading && !refreshing && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
          </div>
        )}

        {/* Members table */}
        {!isLoading && (
          <div className="space-y-6">
            {/* Active members */}
            <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
              <div className="px-5 py-3 border-b border-default flex items-center gap-2">
                <Users className="w-4 h-4 text-muted" />
                <h2 className="text-sm font-semibold text-foreground">
                  {t('members.members_title')}
                </h2>
                <Badge variant="default" className="ml-1">
                  {members.length}
                </Badge>
              </div>

              {members.length === 0 ? (
                <EmptyState
                  icon={<Users className="w-6 h-6" />}
                  title={t('members.empty_title')}
                  description={t('members.empty_description')}
                  action={
                    <Button
                      variant="primary"
                      size="sm"
                      icon={<Plus className="w-3.5 h-3.5" />}
                      onClick={() => setShowInviteForm(true)}
                    >
                      {t('members.invite_member')}
                    </Button>
                  }
                />
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-default">
                      <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                        {t('members.member_header')}
                      </th>
                      <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                        {t('members.role_header')}
                      </th>
                      <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                        {t('members.status_header')}
                      </th>
                      <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                        {t('members.joined_header')}
                      </th>
                      <th className="text-right text-sm font-medium text-muted px-5 py-2.5">
                        {t('members.actions_header')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {members.map((member) => (
                      <tr
                        key={member.id}
                        className="border-b border-default last:border-b-0 hover:bg-background-muted transition-default"
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-background-muted flex items-center justify-center text-sm font-medium text-muted shrink-0">
                              {(member.name || member.email).charAt(0).toUpperCase()}
                            </div>
                            <div className="min-w-0">
                              <p className="text-sm font-medium text-foreground truncate">
                                {member.name || member.email}
                              </p>
                              {member.name && (
                                <p className="text-sm text-muted truncate">{member.email}</p>
                              )}
                            </div>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          {canManageMember(member) ? (
                            <select
                              value={member.role}
                              onChange={(e) => handleChangeRole(member, e.target.value as Role)}
                              disabled={actionLoading === `role-${member.userId}`}
                              className="text-sm bg-background-muted border border-default rounded-lg px-2 py-1 text-foreground focus:outline-none focus:border-border-focus transition-default disabled:opacity-50"
                            >
                              {ROLES.map((r) => (
                                <option key={r.value} value={r.value}>
                                  {r.label}
                                </option>
                              ))}
                            </select>
                          ) : (
                            <Badge variant={ROLE_BADGE_VARIANT[member.role]}>{member.role}</Badge>
                          )}
                        </td>
                        <td className="px-5 py-3">
                          <Badge
                            variant={
                              STATUS_BADGE_VARIANT[(member.status || 'active') as MemberStatus]
                            }
                            dot
                          >
                            {member.status || 'active'}
                          </Badge>
                        </td>
                        <td className="px-5 py-3 text-sm text-muted">
                          {formatDate(member.joinedAt)}
                        </td>
                        <td className="px-5 py-3 text-right">
                          {canManageMember(member) && (
                            <DropdownMenu
                              trigger={
                                <button
                                  disabled={!!actionLoading}
                                  className="p-1 rounded-md text-muted hover:text-foreground hover:bg-background-muted transition-default disabled:opacity-50"
                                  aria-label={t('members.actions_header')}
                                >
                                  {actionLoading?.includes(member.userId) ? (
                                    <Loader2 className="w-4 h-4 animate-spin" />
                                  ) : (
                                    <MoreVertical className="w-4 h-4" />
                                  )}
                                </button>
                              }
                              className="w-48"
                            >
                              {(!member.status || member.status === 'active') && (
                                <DropdownMenuItem
                                  onSelect={() => handleSuspend(member)}
                                  icon={<PauseCircle className="w-3.5 h-3.5 text-warning" />}
                                >
                                  Suspend
                                </DropdownMenuItem>
                              )}
                              {(!member.status || member.status === 'active') && (
                                <DropdownMenuItem
                                  onSelect={() => handleLock(member)}
                                  icon={<Lock className="w-3.5 h-3.5 text-purple" />}
                                >
                                  Lock
                                </DropdownMenuItem>
                              )}
                              {(!member.status || member.status === 'active') && (
                                <DropdownMenuItem
                                  onSelect={() => handleDeactivate(member)}
                                  icon={<UserX className="w-3.5 h-3.5 text-warning" />}
                                >
                                  {t('members.deactivate')}
                                </DropdownMenuItem>
                              )}
                              {(member.status === 'deactivated' ||
                                member.status === 'suspended') && (
                                <DropdownMenuItem
                                  onSelect={() => handleReactivate(member)}
                                  icon={<UserCheck className="w-3.5 h-3.5 text-success" />}
                                >
                                  {t('members.reactivate')}
                                </DropdownMenuItem>
                              )}
                              {member.status === 'locked' && (
                                <DropdownMenuItem
                                  onSelect={() => handleUnlock(member)}
                                  icon={<Unlock className="w-3.5 h-3.5 text-success" />}
                                >
                                  Unlock
                                </DropdownMenuItem>
                              )}
                              {(!member.status || member.status === 'active') && (
                                <DropdownMenuItem
                                  onSelect={() => handleRevokeSessions(member)}
                                  icon={<LogOut className="w-3.5 h-3.5 text-muted" />}
                                >
                                  {t('members.revoke_sessions')}
                                </DropdownMenuItem>
                              )}
                              <DropdownMenuSeparator />
                              <DropdownMenuItem
                                onSelect={() => setConfirmRemove(member)}
                                icon={<X className="w-3.5 h-3.5" />}
                                variant="danger"
                              >
                                {t('members.remove_member')}
                              </DropdownMenuItem>
                            </DropdownMenu>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            {/* Pending invitations */}
            <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
              <div className="px-5 py-3 border-b border-default flex items-center gap-2">
                <Mail className="w-4 h-4 text-muted" />
                <h2 className="text-sm font-semibold text-foreground">
                  {t('members.invitations_title')}
                </h2>
                <Badge variant="default" className="ml-1">
                  {invitations.length}
                </Badge>
              </div>

              {invitations.length === 0 ? (
                <EmptyState
                  icon={<Mail className="w-6 h-6" />}
                  title={t('members.invitations_empty_title')}
                  description={t('members.invitations_empty_description')}
                />
              ) : (
                <table className="w-full">
                  <thead>
                    <tr className="border-b border-default">
                      <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                        {t('members.email_header')}
                      </th>
                      <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                        {t('members.role_header')}
                      </th>
                      <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                        {t('members.status_header')}
                      </th>
                      <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                        {t('members.sent_header')}
                      </th>
                      <th className="text-right text-sm font-medium text-muted px-5 py-2.5">
                        {t('members.actions_header')}
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((inv) => (
                      <tr
                        key={inv.id}
                        className="border-b border-default last:border-b-0 hover:bg-background-muted transition-default"
                      >
                        <td className="px-5 py-3">
                          <div className="flex items-center gap-3">
                            <div className="w-8 h-8 rounded-full bg-background-muted flex items-center justify-center shrink-0">
                              <Mail className="w-3.5 h-3.5 text-muted" />
                            </div>
                            <span className="text-sm text-foreground truncate">{inv.email}</span>
                          </div>
                        </td>
                        <td className="px-5 py-3">
                          <Badge variant={ROLE_BADGE_VARIANT[inv.role]}>{inv.role}</Badge>
                        </td>
                        <td className="px-5 py-3">
                          <Badge variant="warning" dot>
                            {inv.status || 'pending'}
                          </Badge>
                        </td>
                        <td className="px-5 py-3 text-sm text-muted">
                          {formatDate(inv.createdAt)}
                        </td>
                        <td className="px-5 py-3 text-right">
                          <div className="flex items-center justify-end gap-2">
                            {(inv.status === 'pending' || inv.status === 'expired') && (
                              <button
                                onClick={() => handleResendInvitation(inv)}
                                disabled={!!actionLoading}
                                className="text-xs text-info hover:text-info/80 transition-default disabled:opacity-50 font-medium flex items-center gap-1"
                              >
                                {actionLoading === `resend-${inv.id}` ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <RotateCw className="w-3 h-3" />
                                )}
                                {t('members.resend_invite')}
                              </button>
                            )}
                            {inv.status === 'pending' && (
                              <button
                                onClick={() => handleRevokeInvitation(inv)}
                                disabled={!!actionLoading}
                                className="text-xs text-error hover:text-error/80 transition-default disabled:opacity-50 font-medium flex items-center gap-1"
                              >
                                {actionLoading === `revoke-${inv.id}` ? (
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                ) : (
                                  <X className="w-3 h-3" />
                                )}
                                {t('members.revoke_invite')}
                              </button>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        )}
      </div>

      {/* Confirm remove modal */}
      {confirmRemove && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-overlay" onClick={() => setConfirmRemove(null)} />
          <div className="relative bg-background-elevated border border-default rounded-xl shadow-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-foreground mb-2">
              {t('members.remove_confirm_title')}
            </h3>
            <p className="text-sm text-muted mb-5">
              {t('members.remove_confirm_description', {
                name: confirmRemove.name || confirmRemove.email,
              })}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmRemove(null)}>
                {t('members.cancel')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={actionLoading === `remove-${confirmRemove.userId}`}
                onClick={() => handleRemoveMember(confirmRemove)}
              >
                {t('members.remove_confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
