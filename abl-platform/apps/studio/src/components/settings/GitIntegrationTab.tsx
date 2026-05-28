/**
 * GitIntegrationTab Component
 *
 * Git integration settings for a project: connect/disconnect repo, push, pull, history.
 */

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import {
  GitBranch,
  ArrowUpCircle,
  ArrowDownCircle,
  Link2,
  Unlink,
  Clock,
  Loader2,
  CheckCircle2,
  XCircle,
  Bot,
  Languages,
} from 'lucide-react';
import { useNavigationStore } from '../../store/navigation-store';
import { Card } from '../ui/Card';
import { Button } from '../ui/Button';
import { Input } from '../ui/Input';
import { Select } from '../ui/Select';
import { Badge } from '../ui/Badge';
import { EmptyState } from '../ui/EmptyState';
import { Dialog } from '../ui/Dialog';
import { ConfirmDialog } from '../ui/ConfirmDialog';
import {
  fetchGitIntegration,
  createGitIntegration,
  deleteGitIntegration,
  fetchGitStatus,
  pushToGit,
  pullFromGit,
  fetchGitHistory,
  type GitIntegration,
  type GitStatusResponse,
  type GitSyncHistoryEntry,
} from '../../api/project-io';
import { sanitizeError } from '../../lib/sanitize-error';
import { AuthProfilePicker } from '../auth-profiles/AuthProfilePicker';

const PROVIDER_OPTIONS = [
  { value: 'github', label: 'GitHub' },
  { value: 'gitlab', label: 'GitLab' },
  { value: 'bitbucket', label: 'Bitbucket' },
];

const CONFLICT_OPTIONS = [
  { value: 'manual', label: 'Manual' },
  { value: 'ours', label: 'Ours (local wins)' },
  { value: 'theirs', label: 'Theirs (remote wins)' },
];

/* Sub-components share the same 'settings' namespace */

export function GitIntegrationTab() {
  const t = useTranslations('settings');
  const { projectId } = useNavigationStore();
  const [integration, setIntegration] = useState<GitIntegration | null>(null);
  const [loading, setLoading] = useState(true);
  const [showSetup, setShowSetup] = useState(false);
  const [showDisconnect, setShowDisconnect] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [syncKey, setSyncKey] = useState(0);

  const loadIntegration = useCallback(async () => {
    if (!projectId) return;
    setLoading(true);
    try {
      const data = await fetchGitIntegration(projectId);
      setIntegration(data.integration);
    } catch (err) {
      console.error('Failed to load git integration:', err);
    } finally {
      setLoading(false);
    }
  }, [projectId]);

  useEffect(() => {
    loadIntegration();
  }, [loadIntegration]);

  const handleDisconnect = async () => {
    if (!projectId) return;
    setDisconnecting(true);
    try {
      await deleteGitIntegration(projectId);
      setIntegration(null);
      setShowDisconnect(false);
      toast.success(t('git.disconnected'));
    } catch (err) {
      console.error('Failed to disconnect:', err);
      toast.error(t('git.disconnect_failed'));
    } finally {
      setDisconnecting(false);
    }
  };

  if (loading) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6">
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-5 h-5 text-muted animate-spin" />
        </div>
      </div>
    );
  }

  if (!integration) {
    return (
      <div className="max-w-4xl mx-auto px-6 py-6 space-y-6">
        <div>
          <h2 className="text-lg font-semibold text-foreground">{t('git.page_title')}</h2>
          <p className="text-sm text-muted mt-1">{t('git.page_description')}</p>
        </div>
        <EmptyState
          icon={<GitBranch className="w-6 h-6" />}
          title={t('git.empty')}
          description={t('git.empty_description')}
          action={
            <Button icon={<Link2 className="w-4 h-4" />} onClick={() => setShowSetup(true)}>
              {t('git.connect_repo')}
            </Button>
          }
        />
        {projectId && (
          <SetupDialog
            open={showSetup}
            onClose={() => setShowSetup(false)}
            projectId={projectId}
            onConnected={(gi) => {
              setIntegration(gi);
              setShowSetup(false);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6 max-w-4xl mx-auto px-6 py-6">
      <div>
        <h2 className="text-lg font-semibold text-foreground">{t('git.page_title')}</h2>
        <p className="text-sm text-muted mt-1">{t('git.page_description')}</p>
      </div>
      {/* Connection info */}
      <ConnectionCard integration={integration} />

      {/* Push / Pull actions */}
      {projectId && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <PushCard
            projectId={projectId}
            branch={integration.defaultBranch}
            onSynced={() => setSyncKey((k) => k + 1)}
          />
          <PullCard
            projectId={projectId}
            branch={integration.defaultBranch}
            onSynced={() => setSyncKey((k) => k + 1)}
          />
        </div>
      )}

      {/* Status */}
      {projectId && <StatusSection projectId={projectId} syncKey={syncKey} />}

      {/* History */}
      {projectId && <HistorySection projectId={projectId} syncKey={syncKey} />}

      {/* Disconnect */}
      <div className="pt-4 border-t border-default">
        <Button
          variant="danger"
          size="sm"
          icon={<Unlink className="w-3.5 h-3.5" />}
          onClick={() => setShowDisconnect(true)}
        >
          {t('git.disconnect_repo')}
        </Button>
      </div>

      <ConfirmDialog
        open={showDisconnect}
        onClose={() => setShowDisconnect(false)}
        onConfirm={handleDisconnect}
        title={t('git.disconnect_dialog_title')}
        description={t('git.disconnect_dialog_description')}
        confirmLabel={t('git.disconnect_confirm')}
        variant="danger"
        loading={disconnecting}
      />
    </div>
  );
}

// =============================================================================
// SETUP DIALOG
// =============================================================================

function SetupDialog({
  open,
  onClose,
  projectId,
  onConnected,
}: {
  open: boolean;
  onClose: () => void;
  projectId: string;
  onConnected: (gi: GitIntegration) => void;
}) {
  const t = useTranslations('settings');
  const [provider, setProvider] = useState('github');
  const [repoUrl, setRepoUrl] = useState('');
  const [branch, setBranch] = useState('main');
  const [syncPath, setSyncPath] = useState('/');
  const [conflict, setConflict] = useState('manual');
  const [saving, setSaving] = useState(false);
  const [authProfileId, setAuthProfileId] = useState<string | null>(null);

  // Reset form when dialog opens
  const prevOpen = useRef(open);
  useEffect(() => {
    if (open && !prevOpen.current) {
      setProvider('github');
      setRepoUrl('');
      setBranch('main');
      setSyncPath('/');
      setConflict('manual');
      setAuthProfileId(null);
    }
    prevOpen.current = open;
  }, [open]);

  const handleSubmit = async () => {
    if (!repoUrl.trim()) {
      toast.error(t('git.url_required'));
      return;
    }
    if (!authProfileId) {
      toast.error(t('git.select_auth_profile_required'));
      return;
    }

    setSaving(true);
    try {
      const data = await createGitIntegration(projectId, {
        provider: provider as 'github' | 'gitlab' | 'bitbucket',
        repositoryUrl: repoUrl.trim(),
        defaultBranch: branch.trim() || 'main',
        syncPath: syncPath.trim() || '/',
        authProfileId,
        syncConfig: {
          conflictStrategy: conflict as 'manual' | 'ours' | 'theirs',
        },
      });
      toast.success(t('git.connected'));
      onConnected(data.integration);
    } catch (err) {
      console.error('Failed to connect repository:', err);
      toast.error(sanitizeError(err, t('git.connect_failed')));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={open} onClose={onClose} title={t('git.setup_dialog_title')} maxWidth="lg">
      <div className="space-y-4">
        <Select
          label={t('git.provider_label')}
          options={PROVIDER_OPTIONS}
          value={provider}
          onChange={setProvider}
        />
        <Input
          label={t('git.repo_url_label')}
          placeholder={t('git.repo_url_placeholder')}
          value={repoUrl}
          onChange={(e) => setRepoUrl(e.target.value)}
        />
        <div className="grid grid-cols-2 gap-4">
          <Input
            label={t('git.branch_label')}
            placeholder="main"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
          />
          <Input
            label={t('git.sync_path_label')}
            placeholder="/"
            value={syncPath}
            onChange={(e) => setSyncPath(e.target.value)}
          />
        </div>
        <AuthProfilePicker
          projectId={projectId}
          value={authProfileId}
          onChange={setAuthProfileId}
          filterAuthTypes={['bearer', 'api_key', 'oauth2_token']}
          consumerKind="http_tool"
          placeholder={t('git.auth_profile_placeholder')}
        />
        <Select
          label={t('git.conflict_strategy_label')}
          options={CONFLICT_OPTIONS}
          value={conflict}
          onChange={setConflict}
        />
        <div className="flex justify-end gap-3 pt-2">
          <Button variant="ghost" onClick={onClose}>
            {t('git.cancel')}
          </Button>
          <Button icon={<Link2 className="w-4 h-4" />} loading={saving} onClick={handleSubmit}>
            {t('git.connect')}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// =============================================================================
// CONNECTION CARD
// =============================================================================

function ConnectionCard({ integration }: { integration: GitIntegration }) {
  const t = useTranslations('settings');
  const syncBadge =
    integration.lastSyncStatus === 'success'
      ? { variant: 'success' as const, label: t('git.status_synced') }
      : integration.lastSyncStatus === 'failed'
        ? { variant: 'error' as const, label: t('git.status_failed') }
        : { variant: 'default' as const, label: t('git.status_never_synced') };

  return (
    <Card>
      <div className="flex items-start justify-between">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-lg bg-accent-subtle flex items-center justify-center shrink-0">
            <GitBranch className="w-5 h-5 text-accent" />
          </div>
          <div>
            <p className="text-sm font-semibold text-foreground">{integration.repositoryUrl}</p>
            <div className="flex items-center gap-3 mt-1 text-xs text-muted">
              <span className="capitalize">{integration.provider}</span>
              <span>{integration.defaultBranch}</span>
              {integration.lastSyncAt && (
                <span>
                  {t('git.last_sync', {
                    date: new Date(integration.lastSyncAt).toLocaleDateString(),
                  })}
                </span>
              )}
            </div>
          </div>
        </div>
        <Badge variant={syncBadge.variant} dot>
          {syncBadge.label}
        </Badge>
      </div>
    </Card>
  );
}

// =============================================================================
// PUSH / PULL CARDS
// =============================================================================

function PushCard({
  projectId,
  branch,
  onSynced,
}: {
  projectId: string;
  branch: string;
  onSynced: () => void;
}) {
  const t = useTranslations('settings');
  const [message, setMessage] = useState('');
  const [pushing, setPushing] = useState(false);

  const handlePush = async () => {
    setPushing(true);
    try {
      const result = await pushToGit(projectId, {
        commitMessage: message.trim() || undefined,
        branch,
      });
      toast.success(result.message || `Pushed ${result.agentsCount} agent(s)`);
      setMessage('');
      onSynced();
    } catch (err) {
      console.error('Push failed:', err);
      toast.error(sanitizeError(err, t('git.push_failed')));
    } finally {
      setPushing(false);
    }
  };

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ArrowUpCircle className="w-4 h-4 text-accent" />
          <h3 className="text-sm font-semibold text-foreground">{t('git.push_to_remote')}</h3>
        </div>
        <Input
          placeholder={t('git.commit_message_placeholder')}
          value={message}
          onChange={(e) => setMessage(e.target.value)}
        />
        <Button
          size="sm"
          icon={<ArrowUpCircle className="w-3.5 h-3.5" />}
          loading={pushing}
          onClick={handlePush}
        >
          {t('git.push')}
        </Button>
      </div>
    </Card>
  );
}

function PullCard({
  projectId,
  branch,
  onSynced,
}: {
  projectId: string;
  branch: string;
  onSynced: () => void;
}) {
  const t = useTranslations('settings');
  const [pulling, setPulling] = useState(false);

  const handlePull = async () => {
    setPulling(true);
    try {
      const result = await pullFromGit(projectId, { branch });
      toast.success(result.message || t('git.pull_complete'));
      onSynced();
    } catch (err) {
      console.error('Pull failed:', err);
      toast.error(sanitizeError(err, t('git.pull_failed')));
    } finally {
      setPulling(false);
    }
  };

  return (
    <Card>
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <ArrowDownCircle className="w-4 h-4 text-info" />
          <h3 className="text-sm font-semibold text-foreground">{t('git.pull_from_remote')}</h3>
        </div>
        <p className="text-xs text-muted">{t('git.pull_description')}</p>
        <Button
          size="sm"
          variant="secondary"
          icon={<ArrowDownCircle className="w-3.5 h-3.5" />}
          loading={pulling}
          onClick={handlePull}
        >
          {t('git.pull')}
        </Button>
      </div>
    </Card>
  );
}

// =============================================================================
// STATUS SECTION
// =============================================================================

export function StatusSection({ projectId, syncKey }: { projectId: string; syncKey: number }) {
  const t = useTranslations('settings');
  const [status, setStatus] = useState<GitStatusResponse | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchGitStatus(projectId)
      .then((data) => {
        if (!cancelled) setStatus(data);
      })
      .catch((err) => console.error('Failed to load git status:', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, syncKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-4 h-4 text-muted animate-spin" />
      </div>
    );
  }

  if (!status) return null;

  const defaultLayerSet = new Set(status.defaultLayers);
  const trackedLayers = status.localLayers.filter((layer) => defaultLayerSet.has(layer.name));
  const optionalLayers = status.localLayers.filter(
    (layer) => !defaultLayerSet.has(layer.name) && layer.entityCount > 0,
  );
  const hasAgents = status.localAgents.length > 0;
  const hasLocaleFiles = status.localLocaleFiles.length > 0;
  const hasTrackedLayers = trackedLayers.length > 0;
  const hasOptionalLayers = optionalLayers.length > 0;

  if (!hasAgents && !hasLocaleFiles && !hasTrackedLayers && !hasOptionalLayers) return null;

  return (
    <div className="space-y-4">
      <h2 className="text-sm font-medium text-subtle uppercase tracking-wider">
        {t('git.local_state')}
      </h2>

      {hasTrackedLayers && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-subtle">
            {t('git.git_managed_layers')}
          </p>
          <div className="space-y-1.5">
            {trackedLayers.map((layer) => (
              <div
                key={layer.name}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted"
              >
                <span className="text-sm text-foreground">{formatLayerLabel(layer.name)}</span>
                <Badge>{t('git.entity_count', { count: layer.entityCount })}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasOptionalLayers && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-subtle">
            {t('git.optional_layers')}
          </p>
          <p className="mb-2 text-xs text-muted">{t('git.optional_layers_hint')}</p>
          <div className="space-y-1.5">
            {optionalLayers.map((layer) => (
              <div
                key={layer.name}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted"
              >
                <span className="text-sm text-foreground">{formatLayerLabel(layer.name)}</span>
                <Badge variant="accent">
                  {t('git.entity_count', { count: layer.entityCount })}
                </Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasAgents && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-subtle">
            {t('git.local_agents')}
          </p>
          <div className="space-y-1.5">
            {status.localAgents.map((agent) => (
              <div
                key={agent.name}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted"
              >
                <div className="flex items-center gap-2">
                  <Bot className="w-3.5 h-3.5 text-muted" />
                  <span className="text-sm text-foreground">{agent.name}</span>
                </div>
                <span className="text-xs text-muted font-mono">
                  {agent.sourceHash ? agent.sourceHash.slice(0, 8) : 'n/a'}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {hasLocaleFiles && (
        <div>
          <p className="mb-2 text-xs font-medium uppercase tracking-wider text-subtle">
            {t('git.locale_assets')}
          </p>
          <div className="space-y-1.5">
            {status.localLocaleFiles.map((asset) => (
              <div
                key={asset.id}
                className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted"
              >
                <div className="flex items-center gap-2 min-w-0">
                  <Languages className="w-3.5 h-3.5 text-muted shrink-0" />
                  <div className="min-w-0">
                    <div className="truncate text-sm text-foreground">{asset.filePath}</div>
                    <div className="text-xs text-muted">
                      {asset.scope === 'shared' ? t('git.scope_shared') : t('git.scope_agent')}
                    </div>
                  </div>
                </div>
                <Badge variant="accent">{asset.localeCode}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function formatLayerLabel(layerName: string): string {
  return layerName
    .split('_')
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(' ');
}

function countLocaleFileChanges(entry: GitSyncHistoryEntry): number {
  return [
    ...entry.changesSummary.added,
    ...entry.changesSummary.modified,
    ...entry.changesSummary.deleted,
  ].filter((path) => path.startsWith('locales/')).length;
}

function countTotalChanges(entry: GitSyncHistoryEntry): number {
  return (
    entry.changesSummary.added.length +
    entry.changesSummary.modified.length +
    entry.changesSummary.deleted.length
  );
}

function HistorySection({ projectId, syncKey }: { projectId: string; syncKey: number }) {
  const t = useTranslations('settings');
  const [history, setHistory] = useState<GitSyncHistoryEntry[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetchGitHistory(projectId, { limit: 10 })
      .then((data) => {
        if (!cancelled) setHistory(data.history);
      })
      .catch((err) => console.error('Failed to load git history:', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, syncKey]);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-6">
        <Loader2 className="w-4 h-4 text-muted animate-spin" />
      </div>
    );
  }

  if (history.length === 0) return null;

  return (
    <div>
      <h2 className="text-sm font-medium text-subtle uppercase tracking-wider mb-3">
        {t('git.sync_history')}
      </h2>
      <div className="space-y-1.5">
        {history.map((entry, i) => (
          <div
            key={`${entry.commitSha}-${i}`}
            className="flex items-center justify-between px-3 py-2 rounded-lg bg-background-muted"
          >
            <div className="flex items-center gap-2.5">
              {entry.direction === 'push' ? (
                <ArrowUpCircle className="w-3.5 h-3.5 text-accent" />
              ) : (
                <ArrowDownCircle className="w-3.5 h-3.5 text-info" />
              )}
              <span className="text-sm text-foreground capitalize">{entry.direction}</span>
              <span className="text-xs text-muted font-mono">
                {entry.commitSha ? entry.commitSha.slice(0, 7) : 'pending'}
              </span>
              {entry.status === 'success' ? (
                <CheckCircle2 className="w-3.5 h-3.5 text-success" />
              ) : (
                <XCircle className="w-3.5 h-3.5 text-error" />
              )}
            </div>
            <div className="flex items-center gap-2 text-xs text-muted">
              <span>{t('git.file_change_count', { count: countTotalChanges(entry) })}</span>
              {countLocaleFileChanges(entry) > 0 && (
                <Badge variant="accent">
                  {t('git.locale_file_count', { count: countLocaleFileChanges(entry) })}
                </Badge>
              )}
              <Clock className="w-3 h-3" />
              <span>{new Date(entry.createdAt).toLocaleDateString()}</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
