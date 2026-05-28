/**
 * SecretsPage Component
 *
 * Tenant-level admin page for managing Proxy Configs and OAuth Tokens.
 * All data is fetched from the runtime backend, not the studio backend.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Globe, Lock, Plus, Loader2, Trash2, RefreshCw } from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { PageHeader } from '../ui/PageHeader';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Badge } from '../ui/Badge';
import { Tabs } from '../ui/Tabs';
import { Toggle } from '../ui/Toggle';
import { EmptyState } from '../ui/EmptyState';
import { Dialog } from '../ui/Dialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { toast } from 'sonner';
import { sanitizeError } from '../../lib/sanitize-error';
import { useNavigationStore } from '../../store/navigation-store';
import { getRuntimeUrl } from '../../config/runtime';

// =============================================================================
// TYPES
// =============================================================================

interface ProxyConfig {
  id: string;
  name: string;
  proxyUrl: string;
  proxyAuthType: string | null;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

interface OAuthToken {
  provider: string;
  scope: string | null;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

// =============================================================================
// HELPERS
// =============================================================================

function formatDate(dateStr: string | null): string {
  if (!dateStr) return '--';
  return new Date(dateStr).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  if (diffHours < 24) return `${diffHours}h ago`;
  if (diffDays < 30) return `${diffDays}d ago`;
  return formatDate(dateStr);
}

function isExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const expiry = new Date(expiresAt);
  const now = new Date();
  const daysLeft = (expiry.getTime() - now.getTime()) / 86400000;
  return daysLeft > 0 && daysLeft <= 7;
}

function isExpired(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  return new Date(expiresAt).getTime() < Date.now();
}

function maskUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname;
    if (host.length <= 8) return `${parsed.protocol}//${host}/***`;
    return `${parsed.protocol}//${host.slice(0, 4)}****${host.slice(-4)}/***`;
  } catch {
    if (url.length <= 12) return url;
    return `${url.slice(0, 8)}****${url.slice(-4)}`;
  }
}

// =============================================================================
// PROXY CONFIGS TAB
// =============================================================================

function ProxyConfigsTab() {
  const t = useTranslations('admin');
  const [configs, setConfigs] = useState<ProxyConfig[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Create dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [createForm, setCreateForm] = useState({
    name: '',
    proxyUrl: '',
    proxyAuthType: '',
    enabled: true,
  });
  const [isCreating, setIsCreating] = useState(false);

  // Delete state
  const [deleteTarget, setDeleteTarget] = useState<ProxyConfig | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch(`${getRuntimeUrl()}/api/proxy-configs?page=${page}&limit=25`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setConfigs(data.configs || data.data || []);
      setTotalPages(data.totalPages || Math.ceil((data.total || 0) / 25) || 1);
    } catch {
      toast.error(t('secrets.proxy_configs.load_failed'));
    } finally {
      setIsLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (!createForm.name.trim() || !createForm.proxyUrl.trim()) return;
    setIsCreating(true);
    try {
      const body: Record<string, string | boolean> = {
        name: createForm.name.trim(),
        proxyUrl: createForm.proxyUrl.trim(),
        enabled: createForm.enabled,
      };
      if (createForm.proxyAuthType.trim()) body.proxyAuthType = createForm.proxyAuthType.trim();

      const res = await apiFetch(`${getRuntimeUrl()}/api/proxy-configs`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        throw new Error(err.message || 'Failed to create');
      }
      toast.success(t('secrets.proxy_configs.created'));
      setShowCreate(false);
      setCreateForm({ name: '', proxyUrl: '', proxyAuthType: '', enabled: true });
      await load();
    } catch (err) {
      toast.error(sanitizeError(err, t('secrets.proxy_configs.create_failed')));
    } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      const res = await apiFetch(`${getRuntimeUrl()}/api/proxy-configs/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete');
      toast.success(t('secrets.proxy_configs.deleted'));
      setDeleteTarget(null);
      await load();
    } catch {
      toast.error(t('secrets.proxy_configs.delete_failed'));
    } finally {
      setIsDeleting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted">
            {t('secrets.proxy_configs.count', { count: configs.length })}
          </p>
          <button
            onClick={() => load()}
            className="p-1 text-muted hover:text-foreground rounded transition-default"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
        {configs.length > 0 && (
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={() => setShowCreate(true)}
          >
            {t('secrets.proxy_configs.add')}
          </Button>
        )}
      </div>

      {/* Cards */}
      {configs.length === 0 ? (
        <EmptyState
          icon={<Globe className="w-6 h-6" />}
          title={t('secrets.proxy_configs.empty_title')}
          description={t('secrets.proxy_configs.empty_description')}
          action={
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => setShowCreate(true)}
            >
              {t('secrets.proxy_configs.add')}
            </Button>
          }
        />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-3">
            {configs.map((config) => (
              <div
                key={config.id}
                className="flex items-center gap-4 p-4 rounded-lg bg-background-elevated border border-default"
              >
                <div className="w-10 h-10 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
                  <Globe className="w-5 h-5 text-muted" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground truncate">{config.name}</p>
                    {config.enabled ? (
                      <Badge variant="success" dot>
                        Enabled
                      </Badge>
                    ) : (
                      <Badge variant="default" dot>
                        Disabled
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-3 mt-1">
                    <span className="text-xs text-muted font-mono truncate">
                      {maskUrl(config.proxyUrl)}
                    </span>
                    {config.proxyAuthType && <Badge variant="info">{config.proxyAuthType}</Badge>}
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <span className="text-xs text-muted mr-2">{formatDate(config.createdAt)}</span>
                  <button
                    onClick={() => setDeleteTarget(config)}
                    className="p-1.5 text-muted hover:text-error rounded transition-default"
                    title={t('secrets.proxy_configs.delete_config')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-muted">
                {t('secrets.proxy_configs.page_info', { current: page, total: totalPages })}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Create dialog */}
      <Dialog
        open={showCreate}
        onClose={() => {
          setShowCreate(false);
          setCreateForm({ name: '', proxyUrl: '', proxyAuthType: '', enabled: true });
        }}
        maxWidth="sm"
      >
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-foreground">
            {t('secrets.proxy_configs.add_title')}
          </h3>
          <p className="text-sm text-muted">{t('secrets.proxy_configs.add_description')}</p>
          <Input
            label={t('secrets.proxy_configs.name_label')}
            placeholder={t('secrets.proxy_configs.name_placeholder')}
            value={createForm.name}
            onChange={(e) => setCreateForm((f) => ({ ...f, name: e.target.value }))}
          />
          <Input
            label={t('secrets.proxy_configs.proxy_url_label')}
            placeholder={t('secrets.proxy_configs.proxy_url_placeholder')}
            value={createForm.proxyUrl}
            onChange={(e) => setCreateForm((f) => ({ ...f, proxyUrl: e.target.value }))}
          />
          <Input
            label={t('secrets.proxy_configs.auth_type_label')}
            placeholder={t('secrets.proxy_configs.auth_type_placeholder')}
            value={createForm.proxyAuthType}
            onChange={(e) => setCreateForm((f) => ({ ...f, proxyAuthType: e.target.value }))}
          />
          <Toggle
            checked={createForm.enabled}
            onChange={(checked) => setCreateForm((f) => ({ ...f, enabled: checked }))}
            label={t('secrets.proxy_configs.enable_immediately')}
          />
          <div className="flex gap-3 pt-2">
            <Button
              variant="secondary"
              onClick={() => {
                setShowCreate(false);
                setCreateForm({ name: '', proxyUrl: '', proxyAuthType: '', enabled: true });
              }}
              className="flex-1"
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={handleCreate}
              loading={isCreating}
              disabled={!createForm.name.trim() || !createForm.proxyUrl.trim()}
              className="flex-1"
            >
              {t('secrets.proxy_configs.add')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Delete confirmation */}
      <ConfirmDialog
        open={!!deleteTarget}
        onClose={() => setDeleteTarget(null)}
        onConfirm={handleDelete}
        title={t('secrets.proxy_configs.delete_title')}
        description={t('secrets.proxy_configs.delete_description', {
          name: deleteTarget?.name ?? '',
        })}
        confirmLabel={t('secrets.proxy_configs.delete_confirm')}
        variant="danger"
        loading={isDeleting}
      />
    </div>
  );
}

// =============================================================================
// OAUTH TOKENS TAB
// =============================================================================

function OAuthTokensTab() {
  const t = useTranslations('admin');
  const [tokens, setTokens] = useState<OAuthToken[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  // Revoke state
  const [revokeTarget, setRevokeTarget] = useState<OAuthToken | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const load = useCallback(async () => {
    setIsLoading(true);
    try {
      const res = await apiFetch(`${getRuntimeUrl()}/api/v1/oauth/tokens?page=${page}&limit=25`);
      if (!res.ok) throw new Error('Failed to fetch');
      const data = await res.json();
      setTokens(data.tokens || data.data || []);
      setTotalPages(data.totalPages || Math.ceil((data.total || 0) / 25) || 1);
    } catch {
      toast.error(t('secrets.oauth_tokens.load_failed'));
    } finally {
      setIsLoading(false);
    }
  }, [page]);

  useEffect(() => {
    load();
  }, [load]);

  const handleRevoke = async () => {
    if (!revokeTarget) return;
    setIsRevoking(true);
    try {
      const res = await apiFetch(
        `${getRuntimeUrl()}/api/v1/oauth/tokens/${encodeURIComponent(revokeTarget.provider)}`,
        { method: 'DELETE' },
      );
      if (!res.ok) throw new Error('Failed to revoke');
      toast.success(t('secrets.oauth_tokens.revoked', { provider: revokeTarget.provider }));
      setRevokeTarget(null);
      await load();
    } catch {
      toast.error(t('secrets.oauth_tokens.revoke_failed'));
    } finally {
      setIsRevoking(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="w-5 h-5 text-muted animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <p className="text-sm text-muted">
            {t('secrets.oauth_tokens.count', { count: tokens.length })}
          </p>
          <button
            onClick={() => load()}
            className="p-1 text-muted hover:text-foreground rounded transition-default"
            title="Refresh"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {/* Token list */}
      {tokens.length === 0 ? (
        <EmptyState
          icon={<Lock className="w-6 h-6" />}
          title={t('secrets.oauth_tokens.empty_title')}
          description={t('secrets.oauth_tokens.empty_description')}
        />
      ) : (
        <>
          <div className="space-y-2">
            {tokens.map((token) => (
              <div
                key={token.provider}
                className="flex items-center gap-4 p-4 rounded-lg bg-background-elevated border border-default"
              >
                <div className="w-10 h-10 rounded-lg bg-background-muted flex items-center justify-center shrink-0">
                  <Lock className="w-5 h-5 text-muted" />
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <p className="text-sm font-medium text-foreground">{token.provider}</p>
                    {token.expiresAt && isExpired(token.expiresAt) ? (
                      <Badge variant="error" dot>
                        {t('secrets.oauth_tokens.expired')}
                      </Badge>
                    ) : token.expiresAt && isExpiringSoon(token.expiresAt) ? (
                      <Badge variant="warning" dot>
                        {t('secrets.oauth_tokens.expiring_soon')}
                      </Badge>
                    ) : (
                      <Badge variant="success" dot>
                        Active
                      </Badge>
                    )}
                  </div>
                  <div className="flex items-center gap-4 mt-1">
                    {token.scope && (
                      <span className="text-xs text-muted">
                        {t('secrets.oauth_tokens.scopes', { scope: token.scope })}
                      </span>
                    )}
                    {token.expiresAt && (
                      <span className="text-xs text-muted">
                        {t('secrets.oauth_tokens.expires', { date: formatDate(token.expiresAt) })}
                      </span>
                    )}
                    <span className="text-xs text-muted">
                      {t('secrets.oauth_tokens.last_used', {
                        time: formatRelativeDate(token.lastUsedAt),
                      })}
                    </span>
                  </div>
                </div>
                <div className="shrink-0">
                  <button
                    onClick={() => setRevokeTarget(token)}
                    className="p-1.5 text-muted hover:text-error rounded transition-default"
                    title={t('secrets.oauth_tokens.revoke_authorization')}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Pagination */}
          {totalPages > 1 && (
            <div className="flex items-center justify-between pt-2">
              <p className="text-xs text-muted">
                {t('secrets.oauth_tokens.page_info', { current: page, total: totalPages })}
              </p>
              <div className="flex items-center gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page <= 1}
                  onClick={() => setPage((p) => p - 1)}
                >
                  Previous
                </Button>
                <Button
                  variant="secondary"
                  size="sm"
                  disabled={page >= totalPages}
                  onClick={() => setPage((p) => p + 1)}
                >
                  Next
                </Button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Revoke confirmation */}
      <ConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title={t('secrets.oauth_tokens.revoke_title')}
        description={t('secrets.oauth_tokens.revoke_description', {
          provider: revokeTarget?.provider ?? '',
        })}
        confirmLabel={t('secrets.oauth_tokens.revoke_confirm')}
        variant="danger"
        loading={isRevoking}
      />
    </div>
  );
}

// =============================================================================
// MAIN PAGE
// =============================================================================

export function SecretsPage() {
  const t = useTranslations('admin');
  const { tab, setTab } = useNavigationStore();
  const activeTab = tab || 'proxy-configs';

  const tabs = [
    {
      id: 'proxy-configs',
      label: t('secrets.tabs.proxy_configs'),
      icon: <Globe className="w-4 h-4" />,
    },
    {
      id: 'oauth-tokens',
      label: t('secrets.tabs.oauth_tokens'),
      icon: <Lock className="w-4 h-4" />,
    },
  ];

  return (
    <div className="h-full overflow-y-auto bg-noise">
      <div className="max-w-4xl mx-auto px-6 py-8">
        <PageHeader title={t('secrets.title')} description={t('secrets.description')} />

        <div className="mt-6">
          <Tabs
            tabs={tabs}
            activeTab={activeTab}
            onTabChange={(id) => setTab(id === 'proxy-configs' ? null : id)}
            layoutId="secrets-tabs"
          />
        </div>

        <div className="mt-6">
          {activeTab === 'proxy-configs' && <ProxyConfigsTab />}
          {activeTab === 'oauth-tokens' && <OAuthTokensTab />}
        </div>
      </div>
    </div>
  );
}
