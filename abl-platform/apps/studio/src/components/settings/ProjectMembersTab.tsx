/**
 * ProjectMembersTab Component
 *
 * Manages project members: list, add, change role, remove.
 * Fetches from /api/projects/:id/members plus the project-scoped
 * /available endpoint for the add-member dialog. Only users who can
 * manage project membership see mutation controls.
 */

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { Users, Plus, Loader2, RefreshCw, Shield, Search } from 'lucide-react';
import { clsx } from 'clsx';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { useAuthStore } from '../../store/auth-store';
import { useNavigationStore } from '../../store/navigation-store';
import { Button } from '../ui/Button';
import { Select } from '../ui/Select';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Dialog } from '../ui/Dialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';

// =============================================================================
// TYPES
// =============================================================================

interface ProjectMember {
  id: string;
  userId: string;
  email: string;
  name: string;
  role: string;
  customRoleId?: string | null;
  joinedAt: string;
}

interface AvailableWorkspaceMember {
  id: string;
  userId: string;
  email: string;
  name?: string;
  workspaceRole: string;
  status: string;
  joinedAt?: string | null;
}

interface ProjectMembersResponse {
  members: ProjectMember[];
  canManageMembers?: boolean;
}

// =============================================================================
// CONSTANTS
// =============================================================================

const PROJECT_ROLES: { value: string; label: string }[] = [
  { value: 'admin', label: 'Admin' },
  { value: 'developer', label: 'Developer' },
  { value: 'tester', label: 'Tester' },
  { value: 'viewer', label: 'Viewer' },
];

const ROLE_BADGE_VARIANT: Record<string, 'accent' | 'purple' | 'warning' | 'default' | 'info'> = {
  admin: 'accent',
  developer: 'purple',
  tester: 'warning',
  viewer: 'default',
  custom: 'info',
};

// =============================================================================
// COMPONENT
// =============================================================================

export function ProjectMembersTab() {
  const t = useTranslations('settings.members');
  const { projectId } = useNavigationStore();
  const tenantId = useAuthStore((s) => s.tenantId);
  const currentUser = useAuthStore((s) => s.user);

  // ── Data fetching ───────────────────────────────────────────────────────
  const membersKey = projectId ? `/api/projects/${projectId}/members` : null;

  const {
    data: membersData,
    error: membersError,
    isLoading,
    isValidating: refreshing,
    mutate: mutateMembers,
  } = useSWR<ProjectMembersResponse>(membersKey, async (url: string) => {
    const res = await apiFetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.errors?.[0]?.msg || 'Failed to load members');
    }
    return res.json();
  });

  const members = useMemo(() => membersData?.members ?? [], [membersData?.members]);
  const canManageMembers = membersData?.canManageMembers === true;

  // ── Add member dialog state ─────────────────────────────────────────────
  const [showAddDialog, setShowAddDialog] = useState(false);
  const [addUserId, setAddUserId] = useState('');
  const [addRole, setAddRole] = useState('developer');
  const [memberSearch, setMemberSearch] = useState('');
  const [adding, setAdding] = useState(false);
  const [availableWorkspaceMembers, setAvailableWorkspaceMembers] = useState<
    AvailableWorkspaceMember[]
  >([]);
  const [loadingAvailableMembers, setLoadingAvailableMembers] = useState(false);

  // ── Action state ────────────────────────────────────────────────────────
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState<ProjectMember | null>(null);

  // ── Error / success ─────────────────────────────────────────────────────
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (membersError) {
      setError(sanitizeError(membersError, t('load_failed')));
    }
  }, [membersError, t]);

  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  // ── Fetch workspace members when add dialog opens ───────────────────────
  useEffect(() => {
    if (!showAddDialog || !projectId || !tenantId || !canManageMembers) return;
    let cancelled = false;

    async function loadAvailableMembers() {
      setLoadingAvailableMembers(true);
      try {
        const res = await apiFetch(`/api/projects/${projectId}/members/available`);
        if (!res.ok) {
          const body = await res.json().catch(() => ({}));
          throw new Error(body.errors?.[0]?.msg || 'Failed to load available members');
        }
        const data = await res.json();
        const list: AvailableWorkspaceMember[] = Array.isArray(data) ? data : (data.members ?? []);
        if (!cancelled) setAvailableWorkspaceMembers(list);
      } catch (err) {
        if (!cancelled) {
          setError(sanitizeError(err, t('available_load_failed')));
        }
      } finally {
        if (!cancelled) setLoadingAvailableMembers(false);
      }
    }

    loadAvailableMembers();
    return () => {
      cancelled = true;
    };
  }, [canManageMembers, projectId, showAddDialog, t, tenantId]);

  // Filter out users already in the project
  const existingUserIds = useMemo(() => new Set(members.map((m) => m.userId)), [members]);
  const availableMembers = useMemo(
    () => availableWorkspaceMembers.filter((member) => !existingUserIds.has(member.userId)),
    [availableWorkspaceMembers, existingUserIds],
  );
  const filteredAvailableMembers = useMemo(() => {
    const query = memberSearch.trim().toLowerCase();
    if (!query) return availableMembers;

    return availableMembers.filter((member) =>
      [member.name, member.email, member.userId]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(query)),
    );
  }, [availableMembers, memberSearch]);

  useEffect(() => {
    if (!addUserId) return;
    if (filteredAvailableMembers.some((member) => member.userId === addUserId)) return;
    setAddUserId('');
  }, [addUserId, filteredAvailableMembers]);

  // ── Handlers ────────────────────────────────────────────────────────────

  const closeAddDialog = () => {
    setShowAddDialog(false);
    setAddUserId('');
    setAddRole('developer');
    setMemberSearch('');
  };

  const handleAddMember = async () => {
    if (!projectId || !addUserId) return;
    setAdding(true);
    setError(null);

    try {
      const res = await apiFetch(`/api/projects/${projectId}/members`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: addUserId, role: addRole }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.errors?.[0]?.msg || 'Failed to add member');
      }

      setSuccessMessage(t('member_added'));
      closeAddDialog();
      await mutateMembers();
    } catch (err) {
      setError(sanitizeError(err, t('add_failed')));
    } finally {
      setAdding(false);
    }
  };

  const handleChangeRole = async (member: ProjectMember, newRole: string) => {
    if (!projectId) return;
    setActionLoading(`role-${member.userId}`);
    setError(null);

    try {
      const res = await apiFetch(`/api/projects/${projectId}/members/${member.userId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ role: newRole }),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.errors?.[0]?.msg || 'Failed to update role');
      }

      setSuccessMessage(t('role_changed', { role: newRole }));
      await mutateMembers();
    } catch (err) {
      setError(sanitizeError(err, t('role_change_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  const handleRemoveMember = async (member: ProjectMember) => {
    if (!projectId) return;
    setActionLoading(`remove-${member.userId}`);
    setError(null);
    setConfirmRemove(null);

    try {
      const res = await apiFetch(`/api/projects/${projectId}/members/${member.userId}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.errors?.[0]?.msg || 'Failed to remove member');
      }

      setSuccessMessage(t('member_removed'));
      await mutateMembers();
    } catch (err) {
      setError(sanitizeError(err, t('remove_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  // ── Helpers ─────────────────────────────────────────────────────────────

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

  const canManageMember = (member: ProjectMember): boolean => {
    return canManageMembers && member.userId !== currentUser?.id;
  };

  // ── Render ──────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 text-muted animate-spin" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto px-6 py-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('title')}</h2>
          <p className="text-sm text-muted mt-1">{t('description')}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            icon={<RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />}
            onClick={() => mutateMembers()}
            disabled={refreshing}
          >
            {t('refresh')}
          </Button>
          {canManageMembers && members.length > 0 && (
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => setShowAddDialog(true)}
            >
              {t('add_member')}
            </Button>
          )}
        </div>
      </div>

      {/* Error banner */}
      {error && (
        <div className="rounded-xl border border-error bg-error-subtle px-4 py-3 text-sm text-error flex items-center justify-between">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-error hover:opacity-70 transition-default text-xs font-medium ml-4 shrink-0"
          >
            {t('dismiss')}
          </button>
        </div>
      )}

      {/* Success banner */}
      {successMessage && (
        <div className="rounded-xl border border-success bg-success-subtle px-4 py-3 text-sm text-success flex items-center gap-2">
          <Shield className="w-3.5 h-3.5 shrink-0" />
          <span>{successMessage}</span>
        </div>
      )}

      {/* Members table */}
      {members.length === 0 ? (
        <EmptyState
          icon={<Users className="w-6 h-6" />}
          title={t('empty_title')}
          description={t('empty_description')}
          action={
            canManageMembers ? (
              <Button
                variant="primary"
                size="sm"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={() => setShowAddDialog(true)}
              >
                {t('add_member')}
              </Button>
            ) : undefined
          }
        />
      ) : (
        <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
          <div className="px-5 py-3 border-b border-default flex items-center gap-2">
            <Users className="w-4 h-4 text-muted" />
            <h3 className="text-sm font-semibold text-foreground">{t('title')}</h3>
            <Badge variant="default" className="ml-1">
              {members.length}
            </Badge>
          </div>

          <table className="w-full">
            <thead>
              <tr className="border-b border-default">
                <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                  {t('member_header')}
                </th>
                <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                  {t('role_header')}
                </th>
                <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                  {t('joined_header')}
                </th>
                {canManageMembers && (
                  <th className="text-right text-sm font-medium text-muted px-5 py-2.5">
                    {t('actions_header')}
                  </th>
                )}
              </tr>
            </thead>
            <tbody>
              {members.map((member) => (
                <tr
                  key={member.userId}
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
                      <Select
                        value={member.role}
                        onChange={(value) => handleChangeRole(member, value)}
                        disabled={actionLoading === `role-${member.userId}`}
                        className="w-36"
                        options={PROJECT_ROLES}
                      />
                    ) : (
                      <Badge variant={ROLE_BADGE_VARIANT[member.role] || 'default'}>
                        <Shield className="w-3 h-3 mr-1 inline" />
                        {member.role}
                      </Badge>
                    )}
                  </td>
                  <td className="px-5 py-3 text-sm text-muted">
                    {member.joinedAt ? formatDate(member.joinedAt) : '-'}
                  </td>
                  {canManageMembers && (
                    <td className="px-5 py-3 text-right">
                      {canManageMember(member) && (
                        <button
                          onClick={() => setConfirmRemove(member)}
                          disabled={!!actionLoading}
                          className="text-xs text-error hover:text-error/80 transition-default disabled:opacity-50 font-medium"
                        >
                          {actionLoading === `remove-${member.userId}` ? (
                            <Loader2 className="w-3.5 h-3.5 animate-spin inline" />
                          ) : (
                            t('remove')
                          )}
                        </button>
                      )}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {/* Add member dialog */}
      <Dialog
        open={showAddDialog}
        onClose={closeAddDialog}
        title={t('add_member_title')}
        description={t('add_member_description')}
        maxWidth="md"
      >
        <div className="space-y-4">
          {loadingAvailableMembers ? (
            <div className="flex items-center justify-center py-6">
              <Loader2 className="w-4 h-4 text-muted animate-spin" />
            </div>
          ) : (
            <>
              <div className="space-y-2">
                <label
                  htmlFor="project-member-search"
                  className="block text-sm font-medium text-foreground"
                >
                  {t('user_label')}
                </label>
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted" />
                  <input
                    id="project-member-search"
                    type="search"
                    value={memberSearch}
                    onChange={(event) => setMemberSearch(event.target.value)}
                    placeholder={t('user_search_placeholder')}
                    className="w-full rounded-lg border border-default bg-background py-2 pl-8 pr-3 text-sm text-foreground placeholder:text-subtle transition-default focus:border-border-focus focus:outline-none focus:ring-1 focus:ring-border-focus"
                  />
                </div>
                {availableMembers.length === 0 ? (
                  <p className="text-sm text-muted">{t('no_available_members')}</p>
                ) : filteredAvailableMembers.length === 0 ? (
                  <p className="rounded-lg border border-default bg-background-muted px-3 py-2 text-sm text-muted">
                    {t('no_matching_members')}
                  </p>
                ) : (
                  <div className="max-h-56 overflow-y-auto rounded-lg border border-default bg-background">
                    {filteredAvailableMembers.map((member) => {
                      const selected = member.userId === addUserId;
                      return (
                        <button
                          key={member.userId}
                          type="button"
                          aria-pressed={selected}
                          onClick={() => setAddUserId(member.userId)}
                          className={clsx(
                            'flex w-full items-center gap-3 border-b border-default px-3 py-2 text-left transition-default last:border-b-0',
                            selected
                              ? 'bg-background-muted text-foreground'
                              : 'text-foreground hover:bg-background-muted',
                          )}
                        >
                          <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-background-muted text-sm font-medium text-muted">
                            {(member.name || member.email || member.userId).charAt(0).toUpperCase()}
                          </span>
                          <span className="min-w-0">
                            <span className="block truncate text-sm font-medium">
                              {member.name || member.email || member.userId}
                            </span>
                            {(member.name || member.email) && (
                              <span className="block truncate text-xs text-muted">
                                {member.email || member.userId}
                              </span>
                            )}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
              <Select
                label={t('role_label')}
                options={PROJECT_ROLES}
                value={addRole}
                onChange={setAddRole}
                placeholder={t('role_label')}
              />
            </>
          )}

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={closeAddDialog}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={adding}
              disabled={!addUserId || loadingAvailableMembers}
              onClick={handleAddMember}
            >
              {t('add')}
            </Button>
          </div>
        </div>
      </Dialog>

      <ConfirmDialog
        open={!!confirmRemove}
        onClose={() => setConfirmRemove(null)}
        onConfirm={() => confirmRemove && handleRemoveMember(confirmRemove)}
        title={t('remove_confirm_title')}
        description={
          confirmRemove
            ? t('remove_confirm_description', {
                name: confirmRemove.name || confirmRemove.email,
              })
            : ''
        }
        confirmLabel={t('remove_confirm')}
        loading={!!confirmRemove && actionLoading === `remove-${confirmRemove.userId}`}
      />
    </div>
  );
}
