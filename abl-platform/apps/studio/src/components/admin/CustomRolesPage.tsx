/**
 * CustomRolesPage Component
 *
 * Workspace-level admin page for managing custom role definitions.
 * CRUD operations against /api/workspaces/:tenantId/roles.
 */

import { useState, useEffect } from 'react';
import { useTranslations } from 'next-intl';
import useSWR from 'swr';
import { UserCog, Plus, Loader2, RefreshCw, Trash2, Pencil, Shield } from 'lucide-react';
import { PERMISSION_REGISTRY } from '@agent-platform/shared/rbac';
import { apiFetch } from '../../lib/api-client';
import { sanitizeError } from '../../lib/sanitize-error';
import { useAuthStore } from '../../store/auth-store';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Dialog } from '../ui/Dialog';

// =============================================================================
// TYPES
// =============================================================================

interface CustomRole {
  id: string;
  name: string;
  description: string | null;
  permissions: string[];
  parentRoleId: string | null;
  createdBy: string;
  createdAt: string | null;
  updatedAt: string | null;
}

// =============================================================================
// PERMISSION CATEGORIES — derived from the single source of truth
// =============================================================================

const PERMISSION_CATEGORIES = PERMISSION_REGISTRY.map((c) => ({
  label: c.label,
  permissions: [...c.permissions],
}));

// =============================================================================
// COMPONENT
// =============================================================================

export function CustomRolesPage() {
  const t = useTranslations('admin.roles');
  const tenantId = useAuthStore((s) => s.tenantId);

  // ── Data fetching ───────────────────────────────────────────────────────
  const rolesKey = tenantId ? `/api/workspaces/${tenantId}/roles` : null;

  const {
    data: rolesData,
    error: rolesError,
    isLoading,
    isValidating: refreshing,
    mutate: mutateRoles,
  } = useSWR<{ roles: CustomRole[] }>(rolesKey, async (url: string) => {
    const res = await apiFetch(url);
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error(body.errors?.[0]?.msg || 'Failed to load roles');
    }
    return res.json();
  });

  const roles = rolesData?.roles ?? [];

  // ── Dialog state ────────────────────────────────────────────────────────
  const [showDialog, setShowDialog] = useState(false);
  const [editingRole, setEditingRole] = useState<CustomRole | null>(null);
  const [roleName, setRoleName] = useState('');
  const [roleDescription, setRoleDescription] = useState('');
  const [selectedPermissions, setSelectedPermissions] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  // ── Delete confirm ──────────────────────────────────────────────────────
  const [confirmDelete, setConfirmDelete] = useState<CustomRole | null>(null);
  const [deleting, setDeleting] = useState(false);

  // ── Error / success ─────────────────────────────────────────────────────
  const [error, setError] = useState<string | null>(null);
  const [successMessage, setSuccessMessage] = useState<string | null>(null);

  useEffect(() => {
    if (rolesError) {
      setError(sanitizeError(rolesError, t('load_failed')));
    }
  }, [rolesError, t]);

  useEffect(() => {
    if (!successMessage) return;
    const timer = setTimeout(() => setSuccessMessage(null), 4000);
    return () => clearTimeout(timer);
  }, [successMessage]);

  // ── Dialog open helpers ─────────────────────────────────────────────────

  const openCreate = () => {
    setEditingRole(null);
    setRoleName('');
    setRoleDescription('');
    setSelectedPermissions(new Set());
    setShowDialog(true);
  };

  const openEdit = (role: CustomRole) => {
    setEditingRole(role);
    setRoleName(role.name);
    setRoleDescription(role.description || '');
    setSelectedPermissions(new Set(role.permissions));
    setShowDialog(true);
  };

  const closeDialog = () => {
    setShowDialog(false);
    setEditingRole(null);
  };

  // ── Permission toggle ───────────────────────────────────────────────────

  const togglePermission = (perm: string) => {
    setSelectedPermissions((prev) => {
      const next = new Set(prev);
      if (next.has(perm)) {
        next.delete(perm);
      } else {
        next.add(perm);
      }
      return next;
    });
  };

  const toggleCategory = (perms: string[]) => {
    setSelectedPermissions((prev) => {
      const next = new Set(prev);
      const allSelected = perms.every((p) => next.has(p));
      if (allSelected) {
        for (const p of perms) next.delete(p);
      } else {
        for (const p of perms) next.add(p);
      }
      return next;
    });
  };

  // ── Save handler ────────────────────────────────────────────────────────

  const handleSave = async () => {
    if (!tenantId || !roleName.trim() || selectedPermissions.size === 0) return;
    setSaving(true);
    setError(null);

    try {
      const payload: Record<string, unknown> = {
        name: roleName.trim(),
        description: roleDescription.trim() || null,
        permissions: [...selectedPermissions],
      };

      const url = editingRole
        ? `/api/workspaces/${tenantId}/roles/${editingRole.id}`
        : `/api/workspaces/${tenantId}/roles`;
      const method = editingRole ? 'PATCH' : 'POST';

      const res = await apiFetch(url, {
        method,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          body.errors?.[0]?.msg || `Failed to ${editingRole ? 'update' : 'create'} role`,
        );
      }

      setSuccessMessage(t(editingRole ? 'role_updated' : 'role_created'));
      closeDialog();
      await mutateRoles();
    } catch (err) {
      setError(sanitizeError(err, t(editingRole ? 'update_failed' : 'create_failed')));
    } finally {
      setSaving(false);
    }
  };

  // ── Delete handler ──────────────────────────────────────────────────────

  const handleDelete = async (role: CustomRole) => {
    if (!tenantId) return;
    setDeleting(true);
    setError(null);
    setConfirmDelete(null);

    try {
      const res = await apiFetch(`/api/workspaces/${tenantId}/roles/${role.id}`, {
        method: 'DELETE',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.errors?.[0]?.msg || 'Failed to delete role');
      }

      setSuccessMessage(t('role_deleted'));
      await mutateRoles();
    } catch (err) {
      setError(sanitizeError(err, t('delete_failed')));
    } finally {
      setDeleting(false);
    }
  };

  // ── Helpers ─────────────────────────────────────────────────────────────

  const formatDate = (dateStr: string | null) => {
    if (!dateStr) return '-';
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

  // ── Render ──────────────────────────────────────────────────────────────

  return (
    <div className="flex-1 overflow-auto bg-noise">
      <div className="max-w-4xl mx-auto px-6 py-8 space-y-6">
        <PageHeader
          title={t('title')}
          description={t('description')}
          actions={
            <div className="flex items-center gap-2">
              <Button
                variant="ghost"
                size="sm"
                icon={<RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />}
                onClick={() => mutateRoles()}
                disabled={refreshing}
              >
                {t('refresh')}
              </Button>
              {roles.length > 0 && (
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Plus className="w-3.5 h-3.5" />}
                  onClick={openCreate}
                >
                  {t('create_role')}
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

        {/* Loading state */}
        {isLoading && (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
          </div>
        )}

        {/* Roles list */}
        {!isLoading && roles.length === 0 && (
          <EmptyState
            icon={<UserCog className="w-6 h-6" />}
            title={t('empty_title')}
            description={t('empty_description')}
            action={
              <Button
                variant="primary"
                size="sm"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={openCreate}
              >
                {t('create_role')}
              </Button>
            }
          />
        )}

        {!isLoading && roles.length > 0 && (
          <div className="rounded-xl border border-default bg-background-elevated overflow-hidden">
            <div className="px-5 py-3 border-b border-default flex items-center gap-2">
              <UserCog className="w-4 h-4 text-muted" />
              <h2 className="text-sm font-semibold text-foreground">{t('title')}</h2>
              <Badge variant="default" className="ml-1">
                {roles.length}
              </Badge>
            </div>

            <table className="w-full">
              <thead>
                <tr className="border-b border-default">
                  <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                    {t('name_header')}
                  </th>
                  <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                    {t('permissions_header')}
                  </th>
                  <th className="text-left text-sm font-medium text-muted px-5 py-2.5">
                    {t('created_header')}
                  </th>
                  <th className="text-right text-sm font-medium text-muted px-5 py-2.5">
                    {t('actions_header')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {roles.map((role) => (
                  <tr
                    key={role.id}
                    className="border-b border-default last:border-b-0 hover:bg-background-muted transition-default"
                  >
                    <td className="px-5 py-3">
                      <div>
                        <p className="text-sm font-medium text-foreground">{role.name}</p>
                        {role.description && (
                          <p className="text-xs text-muted mt-0.5">{role.description}</p>
                        )}
                      </div>
                    </td>
                    <td className="px-5 py-3">
                      <Badge variant="info">
                        {t('permissions_count', { count: role.permissions.length })}
                      </Badge>
                    </td>
                    <td className="px-5 py-3 text-sm text-muted">{formatDate(role.createdAt)}</td>
                    <td className="px-5 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <button
                          onClick={() => openEdit(role)}
                          className="text-xs text-info hover:text-info/80 transition-default font-medium flex items-center gap-1"
                        >
                          <Pencil className="w-3 h-3" />
                          {t('edit')}
                        </button>
                        <button
                          onClick={() => setConfirmDelete(role)}
                          className="text-xs text-error hover:text-error/80 transition-default font-medium flex items-center gap-1"
                        >
                          <Trash2 className="w-3 h-3" />
                          {t('delete')}
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {/* Create / Edit dialog */}
      <Dialog
        open={showDialog}
        onClose={closeDialog}
        title={t(editingRole ? 'edit_role_title' : 'create_role_title')}
        description={t(editingRole ? 'edit_role_description' : 'create_role_description')}
        maxWidth="lg"
      >
        <div className="space-y-4">
          <Input
            label={t('name_label')}
            value={roleName}
            onChange={(e) => setRoleName(e.target.value)}
            placeholder={t('name_placeholder')}
          />

          <Input
            label={t('description_label')}
            value={roleDescription}
            onChange={(e) => setRoleDescription(e.target.value)}
            placeholder={t('description_placeholder')}
          />

          {/* Permissions grid */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('permissions_label')}
            </label>
            <div className="max-h-64 overflow-y-auto border border-default rounded-lg p-3 space-y-3">
              {PERMISSION_CATEGORIES.map((cat) => {
                const allSelected = cat.permissions.every((p) => selectedPermissions.has(p));
                const someSelected =
                  !allSelected && cat.permissions.some((p) => selectedPermissions.has(p));

                return (
                  <div key={cat.label}>
                    <label className="flex items-center gap-2 text-sm font-medium text-foreground cursor-pointer">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        ref={(el) => {
                          if (el) el.indeterminate = someSelected;
                        }}
                        onChange={() => toggleCategory(cat.permissions)}
                        className="rounded border-default text-accent focus:ring-accent"
                      />
                      {cat.label}
                    </label>
                    <div className="ml-6 mt-1 flex flex-wrap gap-x-4 gap-y-1">
                      {cat.permissions.map((perm) => (
                        <label
                          key={perm}
                          className="flex items-center gap-1.5 text-xs text-muted cursor-pointer"
                        >
                          <input
                            type="checkbox"
                            checked={selectedPermissions.has(perm)}
                            onChange={() => togglePermission(perm)}
                            className="rounded border-default text-accent focus:ring-accent"
                          />
                          {perm}
                        </label>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            <p className="text-xs text-muted mt-1">
              {t('permissions_count', { count: selectedPermissions.size })}
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            <Button variant="ghost" size="sm" onClick={closeDialog}>
              {t('cancel')}
            </Button>
            <Button
              variant="primary"
              size="sm"
              loading={saving}
              disabled={!roleName.trim() || selectedPermissions.size === 0}
              onClick={handleSave}
            >
              {t(editingRole ? 'save' : 'create')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Confirm delete modal */}
      {confirmDelete && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-overlay" onClick={() => setConfirmDelete(null)} />
          <div className="relative bg-background-elevated border border-default rounded-xl shadow-lg p-6 max-w-sm w-full mx-4">
            <h3 className="text-sm font-semibold text-foreground mb-2">
              {t('delete_confirm_title')}
            </h3>
            <p className="text-sm text-muted mb-5">
              {t('delete_confirm_description', { name: confirmDelete.name })}
            </p>
            <div className="flex items-center justify-end gap-2">
              <Button variant="ghost" size="sm" onClick={() => setConfirmDelete(null)}>
                {t('cancel')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={deleting}
                onClick={() => handleDelete(confirmDelete)}
              >
                {t('delete_confirm')}
              </Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
