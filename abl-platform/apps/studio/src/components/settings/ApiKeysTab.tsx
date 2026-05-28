/**
 * ApiKeysTab Component
 *
 * Tabbed layout: "SDK Keys" (existing PublicApiKey management) and
 * "Platform Keys" (new ApiKey CRUD). SDK key behavior is preserved exactly.
 */

import { useState, useEffect, useCallback } from 'react';
import { useTranslations } from 'next-intl';
import { Key, Plus, Trash2, Copy, Check, Loader2 } from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { apiFetch } from '../../lib/api-client';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Dialog } from '../ui/Dialog';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import { Tabs } from '../ui/Tabs';
import { PlatformKeysTab } from './PlatformKeysTab';
import { toast } from 'sonner';

interface SdkKey {
  id: string;
  name: string;
  keyPrefix: string;
  permissions: Record<string, boolean>;
  isActive: boolean;
  expiresAt: string | null;
  lastUsedAt: string | null;
  createdAt: string;
}

export function ApiKeysTab() {
  const t = useTranslations('settings');
  const { projectId } = useNavigationStore();
  const [activeTab, setActiveTab] = useState('sdk-keys');
  const [keys, setKeys] = useState<SdkKey[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [newKeyName, setNewKeyName] = useState('');
  const [isCreating, setIsCreating] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<SdkKey | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const load = useCallback(async () => {
    if (!projectId) return;
    setIsLoading(true);
    try {
      const res = await apiFetch(`/api/sdk/keys?projectId=${projectId}`);
      const data = await res.json();
      setKeys(data.keys || []);
    } catch {
      toast.error(t('api_keys.load_failed'));
    } finally {
      setIsLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    load();
  }, [load]);

  const handleCreate = async () => {
    if (!projectId || !newKeyName.trim()) return;
    setIsCreating(true);
    try {
      const res = await apiFetch('/api/sdk/keys', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId, name: newKeyName.trim() }),
      });
      const data = await res.json();
      if (data.key) {
        setRawKey(data.key);
        toast.success(t('api_keys.created'));
        await load();
      }
    } catch {
      toast.error(t('api_keys.create_failed'));
    } finally {
      setIsCreating(false);
    }
  };

  const handleDelete = async () => {
    if (!deleteTarget) return;
    setIsDeleting(true);
    try {
      await apiFetch(`/api/sdk/keys/${deleteTarget.id}`, {
        method: 'DELETE',
      });
      toast.success(t('api_keys.deleted'));
      setDeleteTarget(null);
      await load();
    } catch {
      toast.error(t('api_keys.delete_failed'));
    } finally {
      setIsDeleting(false);
    }
  };

  const handleCopyKey = () => {
    if (rawKey) {
      navigator.clipboard.writeText(rawKey);
      setCopiedKey(true);
      setTimeout(() => setCopiedKey(false), 2000);
    }
  };

  const tabs = [
    { id: 'sdk-keys', label: t('api_keys.tab_sdk_keys') },
    { id: 'platform-keys', label: t('api_keys.tab_platform_keys') },
  ];

  return (
    <div className="max-w-4xl mx-auto px-6 py-6">
      <div className="mb-6">
        <h2 className="text-lg font-semibold text-foreground">{t('api_keys.page_title')}</h2>
        <p className="text-sm text-muted mt-1">{t('api_keys.page_description')}</p>
      </div>

      <Tabs tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} layoutId="api-keys-tabs" />

      {activeTab === 'platform-keys' && <PlatformKeysTab />}

      {activeTab === 'sdk-keys' && isLoading && (
        <div className="flex items-center justify-center py-12">
          <Loader2 className="w-5 h-5 text-muted animate-spin" />
        </div>
      )}

      {activeTab === 'sdk-keys' && !isLoading && (
        <div className="space-y-6 mt-6">
          {/* Header - only show when keys exist */}
          {keys.length > 0 && (
            <div className="flex items-center justify-between">
              <p className="text-sm text-muted">{t('api_keys.count', { count: keys.length })}</p>
              <Button
                variant="primary"
                size="sm"
                icon={<Plus className="w-3.5 h-3.5" />}
                onClick={() => setShowCreate(true)}
              >
                {t('api_keys.create_key')}
              </Button>
            </div>
          )}

          {/* Key list */}
          {keys.length === 0 ? (
            <EmptyState
              icon={<Key className="w-6 h-6" />}
              title={t('api_keys.empty_title')}
              description={t('api_keys.empty_description')}
              action={
                <Button
                  variant="primary"
                  size="sm"
                  icon={<Plus className="w-3.5 h-3.5" />}
                  onClick={() => setShowCreate(true)}
                >
                  {t('api_keys.create_key')}
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
                    <p className="text-xs text-muted font-mono">{key.keyPrefix}...</p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    {key.lastUsedAt && (
                      <span className="text-xs text-muted">
                        {t('api_keys.last_used', {
                          date: new Date(key.lastUsedAt).toLocaleDateString(),
                        })}
                      </span>
                    )}
                    <button
                      onClick={() => setDeleteTarget(key)}
                      className="p-1.5 text-muted hover:text-error rounded transition-default"
                      title={t('api_keys.delete_key')}
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {/* Create dialog */}
          <Dialog
            open={showCreate}
            onClose={() => {
              setShowCreate(false);
              setRawKey(null);
              setNewKeyName('');
            }}
            maxWidth="md"
          >
            <div className="space-y-4">
              {rawKey ? (
                <>
                  <h3 className="text-lg font-semibold text-foreground">
                    {t('api_keys.created_title')}
                  </h3>
                  <p className="text-sm text-muted">{t('api_keys.created_warning')}</p>
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
                  <Button
                    variant="primary"
                    onClick={() => {
                      setShowCreate(false);
                      setRawKey(null);
                      setNewKeyName('');
                    }}
                    className="w-full"
                  >
                    {t('api_keys.done')}
                  </Button>
                </>
              ) : (
                <>
                  <h3 className="text-lg font-semibold text-foreground">{t('api_keys.create')}</h3>
                  <Input
                    label={t('api_keys.key_name_label')}
                    placeholder={t('api_keys.key_name_placeholder')}
                    value={newKeyName}
                    onChange={(e) => setNewKeyName(e.target.value)}
                  />
                  <div className="flex gap-3">
                    <Button
                      variant="secondary"
                      onClick={() => setShowCreate(false)}
                      className="flex-1"
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      onClick={handleCreate}
                      loading={isCreating}
                      disabled={!newKeyName.trim()}
                      className="flex-1"
                    >
                      Create
                    </Button>
                  </div>
                </>
              )}
            </div>
          </Dialog>

          {/* Delete confirmation */}
          <ConfirmDialog
            open={!!deleteTarget}
            onClose={() => setDeleteTarget(null)}
            onConfirm={handleDelete}
            title={t('api_keys.delete_title')}
            description={t('api_keys.delete_description', { name: deleteTarget?.name || '' })}
            confirmLabel={t('api_keys.delete_confirm')}
            variant="danger"
            loading={isDeleting}
          />
        </div>
      )}
    </div>
  );
}
