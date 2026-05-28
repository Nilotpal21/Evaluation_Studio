/**
 * WorkspaceSettingsPage Component
 *
 * Admin page for workspace (tenant) settings: name, slug, danger zone.
 * Only OWNER/ADMIN can access this page — server enforces.
 */

import { useState, useCallback } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { AlertTriangle, Loader2 } from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { useAuthStore } from '../../store/auth-store';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';

interface WorkspaceData {
  id: string;
  name: string;
  slug: string;
  status: string;
  ownerId: string;
  createdAt: string | null;
  updatedAt: string | null;
}

export function WorkspaceSettingsPage() {
  const t = useTranslations('admin.workspace_settings');
  const tenantId = useAuthStore((s) => s.tenantId);

  const { data, error, isLoading, mutate } = useSWR<{ success: boolean; workspace: WorkspaceData }>(
    tenantId ? `/api/workspaces/${tenantId}/settings` : null,
  );

  const workspace = data?.workspace;

  // ─── Edit State ─────────────────────────────────────────────────────────

  const [name, setName] = useState('');
  const [slug, setSlug] = useState('');
  const [nameInitialized, setNameInitialized] = useState(false);
  const [saving, setSaving] = useState(false);
  const [successMsg, setSuccessMsg] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);

  // Delete confirmation state
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteConfirmName, setDeleteConfirmName] = useState('');
  const [deleting, setDeleting] = useState(false);

  // Initialize form fields once data loads
  if (workspace && !nameInitialized) {
    setName(workspace.name);
    setSlug(workspace.slug);
    setNameInitialized(true);
  }

  const hasChanges =
    workspace && nameInitialized && (name !== workspace.name || slug !== workspace.slug);

  const handleSave = useCallback(async () => {
    if (!tenantId || !hasChanges) return;
    setSaving(true);
    setErrorMsg(null);
    setSuccessMsg(null);

    try {
      const updates: Record<string, string> = {};
      if (name !== workspace?.name) updates.name = name;
      if (slug !== workspace?.slug) updates.slug = slug;

      const res = await apiFetch(`/api/workspaces/${tenantId}/settings`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updates),
      });

      if (!res.ok) {
        const body = await res.json();
        const msg = body?.errors?.[0]?.msg || body?.error?.message || t('save_failed');
        setErrorMsg(msg);
        return;
      }

      setSuccessMsg(t('save_success'));
      mutate();
      setTimeout(() => setSuccessMsg(null), 3000);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMsg(message || t('save_failed'));
    } finally {
      setSaving(false);
    }
  }, [tenantId, hasChanges, name, slug, workspace, mutate, t]);

  const handleDelete = async () => {
    if (!tenantId || !workspace) return;
    if (deleteConfirmName !== workspace.name) return;

    setDeleting(true);
    setErrorMsg(null);

    try {
      const res = await apiFetch(`/api/workspaces/${tenantId}/archive`, {
        method: 'POST',
      });

      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        const msg = body?.error?.message || body?.error || t('delete_failed');
        setErrorMsg(typeof msg === 'string' ? msg : t('delete_failed'));
        setShowDeleteConfirm(false);
        return;
      }

      // Workspace archived — reload to trigger auth redirect
      window.location.href = '/';
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setErrorMsg(message || t('delete_failed'));
      setShowDeleteConfirm(false);
    } finally {
      setDeleting(false);
    }
  };

  // ─── Loading / Error ────────────────────────────────────────────────────

  if (!tenantId) {
    return (
      <div className="p-6">
        <PageHeader title={t('title')} description={t('description')} />
        <p className="mt-6 text-sm text-muted">{t('no_workspace')}</p>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="p-6">
        <PageHeader title={t('title')} description={t('description')} />
        <div className="mt-8 flex items-center gap-2 text-muted">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span className="text-sm">{t('loading')}</span>
        </div>
      </div>
    );
  }

  if (error || !workspace) {
    return (
      <div className="p-6">
        <PageHeader title={t('title')} description={t('description')} />
        <p className="mt-6 text-sm text-danger">{t('load_error')}</p>
      </div>
    );
  }

  // ─── Render ─────────────────────────────────────────────────────────────

  return (
    <div className="p-6 max-w-2xl">
      <PageHeader title={t('title')} description={t('description')} />

      {/* Status Banners */}
      {successMsg && (
        <div className="mt-4 px-3 py-2 rounded-lg bg-success/10 text-success text-sm">
          {successMsg}
        </div>
      )}
      {errorMsg && (
        <div className="mt-4 px-3 py-2 rounded-lg bg-danger/10 text-danger text-sm">{errorMsg}</div>
      )}

      {/* General Settings */}
      <section className="mt-8 space-y-5">
        <h2 className="text-base font-semibold text-foreground">{t('general')}</h2>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">{t('name_label')}</label>
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder={t('name_placeholder')}
          />
          <p className="text-xs text-muted">{t('name_help')}</p>
        </div>

        <div className="space-y-1.5">
          <label className="text-sm font-medium text-foreground">{t('slug_label')}</label>
          <Input
            value={slug}
            onChange={(e) => setSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, ''))}
            placeholder={t('slug_placeholder')}
          />
          <p className="text-xs text-muted">{t('slug_help')}</p>
        </div>

        <div className="flex items-center gap-3 pt-2">
          <Button
            variant="primary"
            onClick={handleSave}
            loading={saving}
            disabled={!hasChanges || saving}
          >
            {t('save')}
          </Button>
          {hasChanges && (
            <button
              onClick={() => {
                setName(workspace.name);
                setSlug(workspace.slug);
                setErrorMsg(null);
              }}
              className="text-sm text-muted hover:text-foreground transition-default"
            >
              {t('discard')}
            </button>
          )}
        </div>
      </section>

      {/* Info */}
      <section className="mt-10 space-y-3">
        <h2 className="text-base font-semibold text-foreground">{t('info')}</h2>
        <div className="space-y-2 text-sm">
          <div className="flex items-center gap-2">
            <span className="text-muted w-28">{t('workspace_id')}</span>
            <code className="text-xs px-1.5 py-0.5 rounded bg-background-muted text-foreground font-mono">
              {workspace.id}
            </code>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-muted w-28">{t('status')}</span>
            <span className="text-foreground capitalize">{workspace.status}</span>
          </div>
          {workspace.createdAt && (
            <div className="flex items-center gap-2">
              <span className="text-muted w-28">{t('created')}</span>
              <span className="text-foreground">
                {new Date(workspace.createdAt).toLocaleDateString()}
              </span>
            </div>
          )}
        </div>
      </section>

      {/* Danger Zone */}
      <section className="mt-10 border border-danger/30 rounded-lg p-5">
        <div className="flex items-center gap-2 mb-3">
          <AlertTriangle className="w-4 h-4 text-danger" />
          <h2 className="text-base font-semibold text-danger">{t('danger_zone')}</h2>
        </div>
        <p className="text-sm text-muted mb-4">{t('danger_description')}</p>
        <Button
          variant="danger"
          onClick={() => {
            setDeleteConfirmName('');
            setShowDeleteConfirm(true);
          }}
        >
          {t('delete_workspace')}
        </Button>
      </section>

      {/* Delete confirmation modal */}
      {showDeleteConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div
            className="absolute inset-0 bg-overlay"
            onClick={() => !deleting && setShowDeleteConfirm(false)}
          />
          <div className="relative bg-background-elevated border border-default rounded-xl shadow-lg p-6 max-w-md w-full mx-4">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="w-5 h-5 text-danger" />
              <h3 className="text-base font-semibold text-foreground">
                {t('delete_confirm_title')}
              </h3>
            </div>
            <p className="text-sm text-muted mb-4">{t('delete_confirm_description')}</p>
            <p className="text-sm text-foreground mb-2">
              {t('delete_confirm_prompt', { name: workspace.name })}
            </p>
            <Input
              value={deleteConfirmName}
              onChange={(e) => setDeleteConfirmName(e.target.value)}
              placeholder={workspace.name}
              autoFocus
            />
            <div className="flex items-center justify-end gap-2 mt-5">
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setShowDeleteConfirm(false)}
                disabled={deleting}
              >
                {t('delete_cancel')}
              </Button>
              <Button
                variant="danger"
                size="sm"
                loading={deleting}
                disabled={deleteConfirmName !== workspace.name || deleting}
                onClick={handleDelete}
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
