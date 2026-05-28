/**
 * PlatformKeysTab Component
 *
 * Platform API key management: list, create, edit, revoke.
 * Uses studio API at /api/keys for ApiKey documents.
 */

import { useState, useEffect, useCallback } from 'react';
import useSWR from 'swr';
import { useTranslations } from 'next-intl';
import { Key, Plus, Trash2, Copy, Check, Loader2, Pencil } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { swrFetcher } from '../../lib/swr-config';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Dialog } from '../ui/Dialog';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { SkeletonTable } from '../ui/Skeleton';
import { Checkbox } from '../ui/Checkbox';
import { RadioGroup } from '../ui/RadioGroup';
import { toast } from 'sonner';

interface PlatformKey {
  id: string;
  prefix: string;
  name: string;
  clientId: string;
  scopes: string[];
  projectIds: string[];
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

type ExpirationPreset = 'none' | '30d' | '90d' | 'custom';
type ScopeCategory = 'execution' | 'management' | 'knowledge_base' | 'analytics' | 'admin';
type ScopeGroupCategory = ScopeCategory | 'legacy';

interface ScopeInfo {
  scope: string;
  label: string;
  description: string;
  category: ScopeCategory;
}

interface ScopeRegistryResponse {
  scopes: ScopeInfo[];
}

interface ScopeOption {
  scope: string;
  label: string;
  description: string;
  category: ScopeGroupCategory;
}

interface ScopeCeilingErrorResponse {
  error?: string;
  code?: string;
  denied?: string[];
}

const SCOPE_CATEGORY_ORDER: ScopeGroupCategory[] = [
  'execution',
  'management',
  'knowledge_base',
  'analytics',
  'admin',
  'legacy',
];

const SCOPE_CATEGORY_LABELS: Record<ScopeGroupCategory, string> = {
  execution: 'Execution',
  management: 'Management',
  knowledge_base: 'Knowledge Base',
  analytics: 'Analytics',
  admin: 'Admin',
  legacy: 'Legacy',
};

function groupScopeOptions(scopes: ScopeOption[]): Array<{
  category: ScopeGroupCategory;
  label: string;
  scopes: ScopeOption[];
}> {
  const groups = new Map<
    ScopeGroupCategory,
    { category: ScopeGroupCategory; label: string; scopes: ScopeOption[] }
  >();

  for (const category of SCOPE_CATEGORY_ORDER) {
    groups.set(category, {
      category,
      label: SCOPE_CATEGORY_LABELS[category],
      scopes: [],
    });
  }

  for (const scope of scopes) {
    groups.get(scope.category)?.scopes.push(scope);
  }

  return SCOPE_CATEGORY_ORDER.map((category) => groups.get(category)!).filter(
    (group) => group.scopes.length > 0,
  );
}

/** Labels for search-related scopes that belong under "Knowledge Base". */
const KNOWLEDGE_BASE_SCOPE_META: Record<string, { label: string; description: string }> = {
  'search:query': {
    label: 'Query Knowledge Base',
    description: 'Execute search queries against knowledge bases',
  },
  'search:read': {
    label: 'Read Knowledge Base',
    description: 'Read knowledge base metadata and configurations',
  },
};

function buildEditScopeOptions(
  registryScopes: ScopeInfo[],
  currentScopes: string[],
): ScopeOption[] {
  const options: ScopeOption[] = registryScopes.map((scope) => ({ ...scope }));
  const knownScopes = new Set(registryScopes.map((scope) => scope.scope));

  for (const scope of currentScopes) {
    if (knownScopes.has(scope)) {
      continue;
    }

    const kbMeta = KNOWLEDGE_BASE_SCOPE_META[scope];
    if (kbMeta) {
      options.push({
        scope,
        label: kbMeta.label,
        description: kbMeta.description,
        category: 'knowledge_base',
      });
    } else {
      options.push({
        scope,
        label: scope,
        description: 'Existing scope retained for backwards compatibility.',
        category: 'legacy',
      });
    }
  }

  return options;
}

export function PlatformKeysTab() {
  const t = useTranslations('settings');
  const { projectId } = useNavigationStore();

  // List state
  const [keys, setKeys] = useState<PlatformKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Create dialog state
  const [showCreate, setShowCreate] = useState(false);
  const [createName, setCreateName] = useState('');
  const [createScopes, setCreateScopes] = useState<string[]>(['workflows.execute']);
  const [createExpiration, setCreateExpiration] = useState<ExpirationPreset>('none');
  const [createCustomDate, setCreateCustomDate] = useState('');
  const [isCreating, setIsCreating] = useState(false);

  // Raw key reveal state
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);

  // Edit dialog state
  const [editTarget, setEditTarget] = useState<PlatformKey | null>(null);
  const [editName, setEditName] = useState('');
  const [editScopes, setEditScopes] = useState<string[]>([]);
  const [isEditing, setIsEditing] = useState(false);

  // Revoke dialog state
  const [revokeTarget, setRevokeTarget] = useState<PlatformKey | null>(null);
  const [isRevoking, setIsRevoking] = useState(false);

  const {
    data: scopeRegistry,
    error: scopeRegistryError,
    isLoading: isLoadingScopeRegistry,
  } = useSWR<ScopeRegistryResponse>(projectId ? '/api/keys/scopes' : null, swrFetcher, {
    revalidateOnFocus: false,
  });

  const availableScopes = scopeRegistry?.scopes ?? [];
  const createScopeGroups = groupScopeOptions(availableScopes.map((scope) => ({ ...scope })));
  const editScopeGroups = groupScopeOptions(buildEditScopeOptions(availableScopes, editScopes));
  const scopeLabelByName = new Map(availableScopes.map((scope) => [scope.scope, scope.label]));

  const load = useCallback(async () => {
    if (!projectId) {
      setKeys([]);
      setIsLoading(false);
      return;
    }
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/keys?projectId=${projectId}`);
      const data = await res.json();
      setKeys(data.keys || []);
    } catch {
      toast.error(t('platform_keys.load_failed'));
    } finally {
      setIsLoading(false);
    }
  }, [projectId, t]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (scopeRegistryError) {
      toast.error(t('platform_keys.load_failed'));
    }
  }, [scopeRegistryError, t]);

  // ─── Create ───────────────────────────────────────────────────────────

  const resetCreate = () => {
    setShowCreate(false);
    setRawKey(null);
    setCreateName('');
    setCreateScopes(['workflows.execute']);
    setCreateExpiration('none');
    setCreateCustomDate('');
  };

  const handleCreate = async () => {
    if (!projectId || !createName.trim() || createScopes.length === 0) return;
    setIsCreating(true);
    try {
      const body: Record<string, unknown> = {
        name: createName.trim(),
        scopes: createScopes,
        projectIds: [projectId],
      };

      if (createExpiration === 'custom' && createCustomDate) {
        body.expiresAt = new Date(createCustomDate).toISOString();
      } else if (createExpiration === '30d') {
        const d = new Date();
        d.setDate(d.getDate() + 30);
        body.expiresAt = d.toISOString();
      } else if (createExpiration === '90d') {
        const d = new Date();
        d.setDate(d.getDate() + 90);
        body.expiresAt = d.toISOString();
      }

      const res = await apiFetch('/api/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = (await res.json().catch(() => ({}))) as PlatformKey &
        ScopeCeilingErrorResponse & { key?: string };
      if (!res.ok) {
        if (handleScopeCeilingError(data)) {
          return;
        }
        throw new Error(typeof data.error === 'string' ? data.error : 'Create platform key failed');
      }
      if (data.key) {
        setRawKey(data.key);
        toast.success(t('platform_keys.created'));
        await load();
      }
    } catch {
      toast.error(t('platform_keys.create_failed'));
    } finally {
      setIsCreating(false);
    }
  };

  // ─── Edit ─────────────────────────────────────────────────────────────

  const openEdit = (key: PlatformKey) => {
    setEditTarget(key);
    setEditName(key.name);
    setEditScopes([...key.scopes]);
  };

  const resolveScopeLabel = (scope: string): string => scopeLabelByName.get(scope) ?? scope;

  const handleScopeCeilingError = (body: ScopeCeilingErrorResponse): boolean => {
    if (body.code !== 'SCOPE_CEILING_EXCEEDED' || !Array.isArray(body.denied)) {
      return false;
    }

    const deniedLabels = body.denied.map(resolveScopeLabel).join(', ');
    toast.error(`${body.error ?? 'Scope ceiling exceeded'}: ${deniedLabels}`);
    return true;
  };

  const handleEdit = async () => {
    if (!editTarget || !projectId || !editName.trim()) return;
    setIsEditing(true);
    try {
      const res = await apiFetch(`/api/keys/${editTarget.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projectId,
          name: editName.trim(),
          scopes: editScopes,
        }),
      });
      const data = (await res.json().catch(() => ({}))) as PlatformKey & ScopeCeilingErrorResponse;
      if (!res.ok) {
        if (handleScopeCeilingError(data)) {
          return;
        }
        throw new Error(typeof data.error === 'string' ? data.error : 'Update platform key failed');
      }

      toast.success(t('platform_keys.updated'));
      setEditTarget(null);
      await load();
    } catch {
      toast.error(t('platform_keys.update_failed'));
    } finally {
      setIsEditing(false);
    }
  };

  // ─── Revoke ───────────────────────────────────────────────────────────

  const handleRevoke = async () => {
    if (!revokeTarget || !projectId) return;
    setIsRevoking(true);
    try {
      await apiFetch(`/api/keys/${revokeTarget.id}?projectId=${projectId}`, {
        method: 'DELETE',
      });
      toast.success(t('platform_keys.revoked'));
      setRevokeTarget(null);
      await load();
    } catch {
      toast.error(t('platform_keys.revoke_failed'));
    } finally {
      setIsRevoking(false);
    }
  };

  // ─── Copy ─────────────────────────────────────────────────────────────

  const handleCopyKey = () => {
    if (rawKey) {
      navigator.clipboard.writeText(rawKey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  };

  // ─── Scope toggle ─────────────────────────────────────────────────────

  const toggleScope = (scope: string, current: string[], setter: (s: string[]) => void) => {
    if (current.includes(scope)) {
      const next = current.filter((s) => s !== scope);
      if (next.length > 0) setter(next);
    } else {
      setter([...current, scope]);
    }
  };

  // ─── Render ───────────────────────────────────────────────────────────

  if (isLoading) {
    return <SkeletonTable rows={4} cols={4} />;
  }

  return (
    <div className="space-y-6 mt-6">
      {/* Header - only show when keys exist */}
      {keys.length > 0 && (
        <div className="flex items-center justify-between">
          <p className="text-sm text-muted">
            {keys.length} platform {keys.length === 1 ? 'key' : 'keys'}
          </p>
          <Button
            variant="primary"
            size="sm"
            icon={<Plus className="w-3.5 h-3.5" />}
            onClick={() => setShowCreate(true)}
          >
            {t('platform_keys.create_key')}
          </Button>
        </div>
      )}

      {/* Key list */}
      {keys.length === 0 ? (
        <EmptyState
          icon={<Key className="w-6 h-6" />}
          title={t('platform_keys.empty_title')}
          description={t('platform_keys.empty_description')}
          action={
            <Button
              variant="primary"
              size="sm"
              icon={<Plus className="w-3.5 h-3.5" />}
              onClick={() => setShowCreate(true)}
            >
              {t('platform_keys.create_key')}
            </Button>
          }
        />
      ) : (
        <div className="space-y-2">
          {keys.map((key) => (
            <div
              key={key.id}
              className="flex items-center gap-4 p-4 rounded-lg bg-background-elevated border border-default"
            >
              <Key className="w-4 h-4 text-muted shrink-0" />
              <div className="flex-1 min-w-0">
                <p className="text-sm font-medium text-foreground">{key.name}</p>
                <div className="flex items-center gap-2 mt-1">
                  <code className="text-xs text-muted font-mono">{key.prefix}...</code>
                  {key.scopes.map((scope) => (
                    <Badge key={scope} variant="default">
                      {resolveScopeLabel(scope)}
                    </Badge>
                  ))}
                </div>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                {key.expiresAt && (
                  <span className="text-xs text-muted">
                    {t('platform_keys.expires', {
                      date: new Date(key.expiresAt).toLocaleDateString(),
                    })}
                  </span>
                )}
                {key.lastUsedAt && (
                  <span className="text-xs text-muted">
                    {t('platform_keys.last_used', {
                      date: new Date(key.lastUsedAt).toLocaleDateString(),
                    })}
                  </span>
                )}
                <button
                  onClick={() => openEdit(key)}
                  className="p-1.5 text-muted hover:text-foreground rounded transition-default"
                  title="Edit key"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button
                  onClick={() => setRevokeTarget(key)}
                  className="p-1.5 text-muted hover:text-error rounded transition-default"
                  title="Revoke key"
                >
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Create dialog */}
      <Dialog open={showCreate} onClose={resetCreate} maxWidth="md">
        <div className="space-y-4">
          {rawKey ? (
            <>
              <h3 className="text-lg font-semibold text-foreground">
                {t('platform_keys.created_title')}
              </h3>
              <p className="text-sm text-muted">{t('platform_keys.created_warning')}</p>
              <div className="flex items-center gap-2 p-3 rounded-lg bg-background-muted border border-default font-mono text-sm break-all">
                <span className="flex-1 text-foreground">{rawKey}</span>
                <button
                  onClick={handleCopyKey}
                  className="p-1 text-muted hover:text-foreground shrink-0"
                  aria-label="Copy API key"
                >
                  {copiedKey ? (
                    <Check className="w-4 h-4 text-success" />
                  ) : (
                    <Copy className="w-4 h-4" />
                  )}
                </button>
              </div>
              <Button variant="primary" onClick={resetCreate} className="w-full">
                {t('platform_keys.done')}
              </Button>
            </>
          ) : (
            <>
              <h3 className="text-lg font-semibold text-foreground">
                {t('platform_keys.create_key')}
              </h3>

              <Input
                label={t('platform_keys.key_name_label')}
                placeholder={t('platform_keys.key_name_placeholder')}
                value={createName}
                onChange={(e) => setCreateName(e.target.value)}
              />

              {/* Scopes */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  {t('platform_keys.scopes_label')}
                </label>
                {isLoadingScopeRegistry ? (
                  <div className="flex items-center gap-2 text-sm text-muted">
                    <Loader2 className="w-4 h-4 animate-spin" />
                    <span>Loading scopes...</span>
                  </div>
                ) : (
                  <div className="space-y-4">
                    {createScopeGroups.map((group) => (
                      <div key={group.category} className="space-y-2">
                        <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                          {group.label}
                        </p>
                        <div className="space-y-2">
                          {group.scopes.map((scope) => (
                            <div
                              key={scope.scope}
                              className="rounded-lg border border-default bg-background-muted/40 px-3 py-2"
                            >
                              <Checkbox
                                checked={createScopes.includes(scope.scope)}
                                onChange={() =>
                                  toggleScope(scope.scope, createScopes, setCreateScopes)
                                }
                                label={scope.label}
                                description={scope.description}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* Expiration */}
              <div>
                <label className="block text-sm font-medium text-foreground mb-2">
                  {t('platform_keys.expiration_label')}
                </label>
                <RadioGroup
                  name="expiration"
                  direction="vertical"
                  value={createExpiration}
                  onChange={(value) => setCreateExpiration(value as ExpirationPreset)}
                  options={(['none', '30d', '90d', 'custom'] as ExpirationPreset[]).map(
                    (preset) => ({
                      value: preset,
                      label: t(`platform_keys.expiration_${preset}`),
                    }),
                  )}
                />
                {createExpiration === 'custom' && (
                  <input
                    type="date"
                    value={createCustomDate}
                    onChange={(e) => setCreateCustomDate(e.target.value)}
                    min={new Date().toISOString().split('T')[0]}
                    className="mt-2 w-full px-3 py-2 text-sm rounded-lg border border-default bg-background text-foreground"
                  />
                )}
              </div>

              <div className="flex gap-3">
                <Button variant="secondary" onClick={resetCreate} className="flex-1">
                  {t('platform_keys.cancel')}
                </Button>
                <Button
                  variant="primary"
                  onClick={handleCreate}
                  loading={isCreating}
                  disabled={
                    !createName.trim() || createScopes.length === 0 || isLoadingScopeRegistry
                  }
                  className="flex-1"
                >
                  {t('platform_keys.create_key')}
                </Button>
              </div>
            </>
          )}
        </div>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={!!editTarget} onClose={() => setEditTarget(null)} maxWidth="md">
        <div className="space-y-4">
          <h3 className="text-lg font-semibold text-foreground">{t('platform_keys.edit_title')}</h3>

          <Input
            label={t('platform_keys.key_name_label')}
            value={editName}
            onChange={(e) => setEditName(e.target.value)}
          />

          {/* Scopes */}
          <div>
            <label className="block text-sm font-medium text-foreground mb-2">
              {t('platform_keys.scopes_label')}
            </label>
            {isLoadingScopeRegistry ? (
              <div className="flex items-center gap-2 text-sm text-muted">
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Loading scopes...</span>
              </div>
            ) : (
              <div className="space-y-4">
                {editScopeGroups.map((group) => (
                  <div key={group.category} className="space-y-2">
                    <p className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">
                      {group.label}
                    </p>
                    <div className="space-y-2">
                      {group.scopes.map((scope) => (
                        <div
                          key={scope.scope}
                          className="rounded-lg border border-default bg-background-muted/40 px-3 py-2"
                        >
                          <Checkbox
                            checked={editScopes.includes(scope.scope)}
                            onChange={() => toggleScope(scope.scope, editScopes, setEditScopes)}
                            label={scope.label}
                            description={scope.description}
                          />
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Read-only projectIds */}
          {editTarget && (
            <div>
              <label className="block text-sm font-medium text-foreground mb-2">
                {t('platform_keys.projects_label')}
              </label>
              <div className="flex flex-wrap gap-1">
                {editTarget.projectIds.map((pid) => (
                  <Badge key={pid} variant="default">
                    {pid}
                  </Badge>
                ))}
              </div>
            </div>
          )}

          <div className="flex gap-3">
            <Button variant="secondary" onClick={() => setEditTarget(null)} className="flex-1">
              {t('platform_keys.cancel')}
            </Button>
            <Button
              variant="primary"
              onClick={handleEdit}
              loading={isEditing}
              disabled={!editName.trim() || editScopes.length === 0}
              className="flex-1"
            >
              {t('platform_keys.save')}
            </Button>
          </div>
        </div>
      </Dialog>

      {/* Revoke confirmation */}
      <ConfirmDialog
        open={!!revokeTarget}
        onClose={() => setRevokeTarget(null)}
        onConfirm={handleRevoke}
        title={t('platform_keys.revoke_title')}
        description={t('platform_keys.revoke_warning')}
        confirmLabel={t('platform_keys.revoke_confirm')}
        variant="danger"
        loading={isRevoking}
      />
    </div>
  );
}
