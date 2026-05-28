/**
 * ConnectorDetailPanel Component
 *
 * Slide-over panel that shows full connector details when a row is clicked
 * in the ConnectorsTab. Displays:
 * - Connection status and configuration
 * - Sync state with start/pause/resume controls
 * - Filter configuration (view & edit)
 * - Permission mode
 * - Error state
 */

import { useState, useEffect, useCallback } from 'react';
import {
  X,
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Loader2,
  Play,
  Pause,
  RotateCw,
  Globe,
  Key,
  Shield,
  Filter,
  Settings,
  Check,
  ChevronDown,
  ChevronUp,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { sanitizeError } from '@/lib/sanitize-error';
import { Button } from '../ui/Button';
import { Badge, type BadgeVariant } from '../ui/Badge';
import { Input } from '../ui/Input';
import { toast } from 'sonner';
import type { EnterpriseConnector, SearchAISource } from '../../api/search-ai';
import {
  getConnectorDetails,
  updateConnectorConfig,
  startConnectorSync,
  pauseConnectorSync,
  resumeConnectorSync,
  getConnectorSyncStatus,
  initiateConnectorAuth,
  exchangeAuthorizationCode,
} from '../../api/search-ai';
import { ConnectorFilterSection } from './ConnectorFilterSection';

interface ConnectorDetailPanelProps {
  open: boolean;
  onClose: () => void;
  indexId: string;
  connectorId: string;
  onRefresh: () => void;
}

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export function ConnectorDetailPanel({
  open,
  onClose,
  indexId,
  connectorId,
  onRefresh,
}: ConnectorDetailPanelProps) {
  const t = useTranslations('search_ai.connectors');

  const [connector, setConnector] = useState<EnterpriseConnector | null>(null);
  const [source, setSource] = useState<SearchAISource | null>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Edit mode for config sections
  const [editingSection, setEditingSection] = useState<string | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});

  // Collapsible sections
  const [expandedSections, setExpandedSections] = useState<Set<string>>(
    new Set(['connection', 'sync']),
  );

  const toggleSection = (section: string) => {
    setExpandedSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  // ─── Fetch connector details ───────────────────────────────────────────

  const fetchDetails = useCallback(async () => {
    if (!connectorId || !open) return;
    setLoading(true);
    setError(null);

    try {
      const result = await getConnectorDetails(indexId, connectorId);
      setConnector(result.data.connector);
      setSource(result.data.source);
    } catch (err) {
      const msg = sanitizeError(err, t('detail_error_load'));
      setError(msg);
    } finally {
      setLoading(false);
    }
  }, [connectorId, indexId, open, t]);

  useEffect(() => {
    if (open && connectorId) {
      fetchDetails();
    }
  }, [open, connectorId, fetchDetails]);

  // ─── Sync actions ──────────────────────────────────────────────────────

  const handleStartSync = async () => {
    setActionLoading('sync-start');
    try {
      await startConnectorSync(connectorId);
      toast.success(t('detail_sync_started'));
      fetchDetails();
      onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, t('detail_sync_start_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  const handlePauseSync = async () => {
    setActionLoading('sync-pause');
    try {
      await pauseConnectorSync(connectorId);
      toast.success(t('detail_sync_paused'));
      fetchDetails();
    } catch (err) {
      toast.error(sanitizeError(err, t('detail_sync_pause_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  const handleResumeSync = async () => {
    setActionLoading('sync-resume');
    try {
      await resumeConnectorSync(connectorId);
      toast.success(t('detail_sync_resumed'));
      fetchDetails();
    } catch (err) {
      toast.error(sanitizeError(err, t('detail_sync_resume_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  const handleReauthenticate = async () => {
    setActionLoading('reauth');
    try {
      const result = await initiateConnectorAuth(connectorId);
      const authData = result.data as any;

      if (authData.deviceCode) {
        // Device code flow
        const message = `Please visit ${authData.verificationUri} and enter code: ${authData.userCode}`;
        toast.info(message, { duration: 30000 });
        window.open(authData.verificationUri, '_blank');
      } else if (authData.authorizationUrl) {
        // Authorization code flow — open popup and listen for callback message
        const popup = window.open(
          authData.authorizationUrl,
          'oauth_popup',
          'width=600,height=700,popup=yes',
        );

        if (popup) {
          const handleMessage = async (event: MessageEvent) => {
            if (event.origin !== window.location.origin) return;
            if (event.data?.type !== 'oauth_callback') return;
            cleanup();

            if (event.data.error) {
              toast.error(`Authentication failed: ${event.data.error}`);
              return;
            }
            if (event.data.code && event.data.state) {
              try {
                await exchangeAuthorizationCode(connectorId, {
                  code: event.data.code,
                  state: event.data.state,
                });
                toast.success(t('detail_reauth_initiated'));
                fetchDetails();
                onRefresh();
              } catch (err) {
                toast.error(sanitizeError(err, 'Failed to exchange authorization code'));
              }
            }
          };
          window.addEventListener('message', handleMessage);

          // Clean up listener if popup is closed without completing auth
          const popupCheck = setInterval(() => {
            if (popup.closed) {
              cleanup();
            }
          }, 1000);

          function cleanup() {
            clearInterval(popupCheck);
            window.removeEventListener('message', handleMessage);
          }
        } else {
          toast.error('Popup blocked. Please allow popups for this site and try again.');
        }

        setActionLoading(null);
        return;
      }

      toast.success(t('detail_reauth_initiated'));
    } catch (err) {
      toast.error(sanitizeError(err, 'Failed to initiate re-authentication'));
    } finally {
      setActionLoading(null);
    }
  };

  // ─── Config editing ───────────────────────────────────────────────────

  const startEditing = (section: string) => {
    if (!connector) return;
    if (section === 'connection') {
      setEditValues({
        clientId: connector.connectionConfig?.clientId || '',
        tenantId: (connector.connectionConfig?.tenantId as string) || '',
        tenantUrl: connector.connectionConfig?.tenantUrl || '',
      });
    } else if (section === 'filter') {
      // Filter section uses ConnectorFilterSection component — no editValues needed
    }
    setEditingSection(section);
  };

  const cancelEditing = () => {
    setEditingSection(null);
    setEditValues({});
  };

  const saveConnectionConfig = async () => {
    setActionLoading('save-connection');
    try {
      const connectionConfig: Record<string, unknown> = {};
      if (editValues.tenantUrl?.trim()) connectionConfig.tenantUrl = editValues.tenantUrl.trim();
      if (editValues.clientId?.trim()) connectionConfig.clientId = editValues.clientId.trim();
      if (editValues.tenantId?.trim()) connectionConfig.tenantId = editValues.tenantId.trim();

      await updateConnectorConfig(indexId, connectorId, { connectionConfig });
      toast.success(t('detail_config_saved'));
      setEditingSection(null);
      fetchDetails();
      onRefresh();
    } catch (err) {
      toast.error(sanitizeError(err, t('detail_config_save_failed')));
    } finally {
      setActionLoading(null);
    }
  };

  // Filter save is now handled by ConnectorFilterSection component

  // ─── Status helpers ───────────────────────────────────────────────────

  const getAuthStatus = (): { label: string; variant: BadgeVariant } => {
    if (!connector) return { label: t('detail_status_unknown'), variant: 'default' };
    if (connector.oauthTokenId)
      return { label: t('detail_status_authenticated'), variant: 'success' };
    return { label: t('detail_status_not_authenticated'), variant: 'error' };
  };

  const getSyncStatus = (): { label: string; variant: BadgeVariant } => {
    if (!connector) return { label: t('detail_status_unknown'), variant: 'default' };
    if (connector.errorState.isPaused)
      return { label: t('detail_status_paused'), variant: 'warning' };
    if (connector.syncState.syncInProgress)
      return { label: t('detail_status_syncing'), variant: 'info' };
    if (connector.syncState.lastFullSyncAt)
      return { label: t('detail_status_synced'), variant: 'success' };
    return { label: t('detail_status_not_synced'), variant: 'default' };
  };

  // ─── Section header component ─────────────────────────────────────────

  const SectionHeader = ({
    id,
    icon,
    title,
    badge,
    onEdit,
  }: {
    id: string;
    icon: React.ReactNode;
    title: string;
    badge?: React.ReactNode;
    onEdit?: () => void;
  }) => (
    <div
      role="button"
      tabIndex={0}
      onClick={() => toggleSection(id)}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleSection(id);
        }
      }}
      className="w-full flex items-center justify-between py-2 text-left cursor-pointer"
    >
      <div className="flex items-center gap-2">
        <span className="text-muted">{icon}</span>
        <span className="text-sm font-medium text-foreground">{title}</span>
        {badge}
      </div>
      <div className="flex items-center gap-2">
        {onEdit && expandedSections.has(id) && editingSection !== id && (
          <button
            onClick={(e) => {
              e.stopPropagation();
              onEdit();
            }}
            className="text-xs text-info hover:text-info/80"
          >
            {t('detail_edit')}
          </button>
        )}
        {expandedSections.has(id) ? (
          <ChevronUp className="w-4 h-4 text-muted" />
        ) : (
          <ChevronDown className="w-4 h-4 text-muted" />
        )}
      </div>
    </div>
  );

  // ─── Render ───────────────────────────────────────────────────────────

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-overlay" onClick={onClose} />

      {/* Panel */}
      <div className="relative w-full max-w-lg bg-background border-l border-default shadow-xl overflow-y-auto">
        {/* Header */}
        <div className="sticky top-0 z-10 flex items-center justify-between p-4 border-b border-default bg-background">
          <div>
            <h2 className="text-base font-semibold text-foreground">
              {source?.name || t('detail_title')}
            </h2>
            <p className="text-xs text-muted">
              {connector?.connectorType
                ? connector.connectorType.charAt(0).toUpperCase() + connector.connectorType.slice(1)
                : ''}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content */}
        <div className="p-4 space-y-1">
          {loading ? (
            <div className="flex flex-col items-center gap-4 py-12">
              <Loader2 className="w-8 h-8 text-accent animate-spin" />
              <p className="text-sm text-muted">{t('detail_loading')}</p>
            </div>
          ) : error ? (
            <div className="flex flex-col items-center gap-4 py-12">
              <XCircle className="w-8 h-8 text-error" />
              <p className="text-sm text-error">{error}</p>
              <Button size="sm" variant="secondary" onClick={fetchDetails}>
                {t('enterprise_retry')}
              </Button>
            </div>
          ) : connector ? (
            <>
              {/* ─── Connection Section ───────────────────────────────── */}
              <div className="border-b border-default">
                <SectionHeader
                  id="connection"
                  icon={<Key className="w-4 h-4" />}
                  title={t('detail_section_connection')}
                  badge={
                    <Badge variant={getAuthStatus().variant} dot>
                      {getAuthStatus().label}
                    </Badge>
                  }
                  onEdit={() => startEditing('connection')}
                />
                {expandedSections.has('connection') && (
                  <div className="pb-3 space-y-2">
                    {editingSection === 'connection' ? (
                      <div className="space-y-3">
                        <Input
                          label={t('enterprise_config_client_id_label')}
                          value={editValues.clientId || ''}
                          onChange={(e) =>
                            setEditValues((prev) => ({ ...prev, clientId: e.target.value }))
                          }
                          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                        />
                        <Input
                          label={t('enterprise_config_tenant_id_label')}
                          value={editValues.tenantId || ''}
                          onChange={(e) =>
                            setEditValues((prev) => ({ ...prev, tenantId: e.target.value }))
                          }
                          placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
                        />
                        <Input
                          label={t('enterprise_config_tenant_url_label')}
                          value={editValues.tenantUrl || ''}
                          onChange={(e) =>
                            setEditValues((prev) => ({ ...prev, tenantUrl: e.target.value }))
                          }
                          placeholder="https://contoso.sharepoint.com"
                          type="url"
                        />
                        <p className="text-xs text-muted">
                          {t('enterprise_config_tenant_url_help')}
                        </p>
                        <div className="flex gap-2">
                          <Button size="sm" variant="secondary" onClick={cancelEditing}>
                            {t('enterprise_cancel')}
                          </Button>
                          <Button
                            size="sm"
                            icon={<Check className="w-3.5 h-3.5" />}
                            loading={actionLoading === 'save-connection'}
                            onClick={saveConnectionConfig}
                          >
                            {t('detail_save')}
                          </Button>
                        </div>
                      </div>
                    ) : (
                      <div className="space-y-1.5 text-sm">
                        <div className="flex justify-between">
                          <span className="text-muted">
                            {t('enterprise_config_client_id_label')}
                          </span>
                          <span className="text-foreground font-mono text-xs truncate max-w-[250px]">
                            {connector.connectionConfig?.clientId
                              ? `${connector.connectionConfig.clientId.slice(0, 8)}...`
                              : '—'}
                          </span>
                        </div>
                        <div className="flex justify-between">
                          <span className="text-muted">
                            {t('enterprise_config_tenant_id_label')}
                          </span>
                          <span className="text-foreground font-mono text-xs truncate max-w-[250px]">
                            {(connector.connectionConfig?.tenantId as string) || '—'}
                          </span>
                        </div>
                        {connector.connectionConfig?.tenantUrl && (
                          <div className="flex justify-between">
                            <span className="text-muted">
                              {t('enterprise_config_tenant_url_label')}
                            </span>
                            <span className="text-foreground font-mono text-xs truncate max-w-[250px]">
                              {connector.connectionConfig.tenantUrl}
                            </span>
                          </div>
                        )}
                        {/* Re-authenticate button */}
                        <div className="mt-3 pt-3 border-t border-default">
                          <Button
                            size="sm"
                            variant="secondary"
                            icon={<RotateCw className="w-3.5 h-3.5" />}
                            loading={actionLoading === 'reauth'}
                            onClick={handleReauthenticate}
                            className="w-full"
                          >
                            {t('detail_reauth')}
                          </Button>
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ─── Sync Section ──────────────────────────────────────── */}
              <div className="border-b border-default">
                <SectionHeader
                  id="sync"
                  icon={<RotateCw className="w-4 h-4" />}
                  title={t('detail_section_sync')}
                  badge={
                    <Badge variant={getSyncStatus().variant} dot>
                      {getSyncStatus().label}
                    </Badge>
                  }
                />
                {expandedSections.has('sync') && (
                  <div className="pb-3 space-y-3">
                    {/* Sync stats */}
                    <div className="grid grid-cols-3 gap-2">
                      <div className="p-2 rounded-lg bg-background-subtle border border-default text-center">
                        <p className="text-lg font-semibold text-foreground">
                          {connector.syncState.totalDocuments.toLocaleString()}
                        </p>
                        <p className="text-xs text-muted">{t('detail_sync_total')}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-background-subtle border border-default text-center">
                        <p className="text-lg font-semibold text-foreground">
                          {connector.syncState.processedDocuments.toLocaleString()}
                        </p>
                        <p className="text-xs text-muted">{t('detail_sync_processed')}</p>
                      </div>
                      <div className="p-2 rounded-lg bg-background-subtle border border-default text-center">
                        <p className="text-lg font-semibold text-error">
                          {connector.syncState.failedDocuments.toLocaleString()}
                        </p>
                        <p className="text-xs text-muted">{t('detail_sync_failed')}</p>
                      </div>
                    </div>

                    {/* Sync timestamps */}
                    <div className="space-y-1.5 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted">{t('detail_sync_last_full')}</span>
                        <span className="text-foreground text-xs">
                          {formatDate(connector.syncState.lastFullSyncAt)}
                        </span>
                      </div>
                      <div className="flex justify-between">
                        <span className="text-muted">{t('detail_sync_last_delta')}</span>
                        <span className="text-foreground text-xs">
                          {formatDate(connector.syncState.lastDeltaSyncAt)}
                        </span>
                      </div>
                    </div>

                    {/* Sync error */}
                    {connector.syncState.lastSyncError && (
                      <div className="flex items-start gap-2 p-2 rounded-lg bg-error/10 border border-error/20">
                        <AlertTriangle className="w-4 h-4 text-error shrink-0 mt-0.5" />
                        <p className="text-xs text-error">{connector.syncState.lastSyncError}</p>
                      </div>
                    )}

                    {/* Sync controls */}
                    <div className="flex gap-2">
                      {connector.errorState.isPaused ? (
                        <Button
                          size="sm"
                          icon={<Play className="w-3.5 h-3.5" />}
                          loading={actionLoading === 'sync-resume'}
                          onClick={handleResumeSync}
                        >
                          {t('detail_sync_resume')}
                        </Button>
                      ) : connector.syncState.syncInProgress ? (
                        <Button
                          size="sm"
                          variant="secondary"
                          icon={<Pause className="w-3.5 h-3.5" />}
                          loading={actionLoading === 'sync-pause'}
                          onClick={handlePauseSync}
                        >
                          {t('detail_sync_pause')}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          icon={<Play className="w-3.5 h-3.5" />}
                          loading={actionLoading === 'sync-start'}
                          onClick={handleStartSync}
                          disabled={!connector.oauthTokenId}
                        >
                          {t('detail_sync_start')}
                        </Button>
                      )}
                    </div>
                  </div>
                )}
              </div>

              {/* ─── Filter Section ────────────────────────────────────── */}
              <div className="border-b border-default">
                <SectionHeader
                  id="filter"
                  icon={<Filter className="w-4 h-4" />}
                  title={t('detail_section_filters')}
                  badge={
                    (connector.filterConfig?.version || 0) > 1
                      ? `v${connector.filterConfig?.version}`
                      : undefined
                  }
                  onEdit={() => startEditing('filter')}
                />
                {expandedSections.has('filter') && (
                  <div className="pb-3">
                    <ConnectorFilterSection
                      connector={connector}
                      indexId={indexId}
                      connectorId={connectorId}
                      editing={editingSection === 'filter'}
                      onStartEdit={() => startEditing('filter')}
                      onCancelEdit={cancelEditing}
                      onSaved={() => {
                        setEditingSection(null);
                        fetchDetails();
                        onRefresh();
                      }}
                    />
                  </div>
                )}
              </div>

              {/* ─── Permissions Section ───────────────────────────────── */}
              <div className="border-b border-default">
                <SectionHeader
                  id="permissions"
                  icon={<Shield className="w-4 h-4" />}
                  title={t('detail_section_permissions')}
                  badge={
                    <Badge
                      variant={
                        connector.permissionConfig?.mode === 'full'
                          ? 'success'
                          : connector.permissionConfig?.mode === 'simplified'
                            ? 'info'
                            : 'default'
                      }
                    >
                      {connector.permissionConfig?.mode || 'none'}
                    </Badge>
                  }
                />
                {expandedSections.has('permissions') && (
                  <div className="pb-3 space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted">{t('detail_perm_last_crawl')}</span>
                      <span className="text-foreground text-xs">
                        {formatDate(connector.permissionConfig?.lastCrawlAt || null)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">{t('detail_perm_docs_processed')}</span>
                      <span className="text-foreground">
                        {(connector.permissionConfig?.documentsProcessed || 0).toLocaleString()}
                      </span>
                    </div>
                    {(connector.permissionConfig?.averageAccuracy || 0) > 0 && (
                      <div className="flex justify-between">
                        <span className="text-muted">{t('detail_perm_accuracy')}</span>
                        <span className="text-foreground">
                          {connector.permissionConfig?.averageAccuracy}%
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* ─── Error State ──────────────────────────────────────── */}
              {(connector.errorState.consecutiveFailures > 0 ||
                connector.errorState.lastErrorMessage) && (
                <div className="border-b border-default">
                  <SectionHeader
                    id="errors"
                    icon={<AlertTriangle className="w-4 h-4" />}
                    title={t('detail_section_errors')}
                    badge={
                      <Badge variant="error">
                        {connector.errorState.consecutiveFailures} {t('detail_errors_failures')}
                      </Badge>
                    }
                  />
                  {expandedSections.has('errors') && (
                    <div className="pb-3 space-y-1.5 text-sm">
                      <div className="flex justify-between">
                        <span className="text-muted">{t('detail_errors_last_error')}</span>
                        <span className="text-foreground text-xs">
                          {formatDate(connector.errorState.lastErrorAt)}
                        </span>
                      </div>
                      {connector.errorState.lastErrorMessage && (
                        <div className="p-2 rounded-lg bg-error/10 border border-error/20">
                          <p className="text-xs text-error font-mono">
                            {connector.errorState.lastErrorMessage}
                          </p>
                        </div>
                      )}
                      {connector.errorState.isPaused && connector.errorState.pauseReason && (
                        <div className="flex justify-between">
                          <span className="text-muted">{t('detail_errors_pause_reason')}</span>
                          <span className="text-foreground text-xs">
                            {connector.errorState.pauseReason}
                          </span>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}

              {/* ─── Metadata ─────────────────────────────────────────── */}
              <div>
                <SectionHeader
                  id="metadata"
                  icon={<Settings className="w-4 h-4" />}
                  title={t('detail_section_metadata')}
                />
                {expandedSections.has('metadata') && (
                  <div className="pb-3 space-y-1.5 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted">{t('detail_meta_config_source')}</span>
                      <Badge variant="default">{connector.configurationSource}</Badge>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">{t('detail_meta_created')}</span>
                      <span className="text-foreground text-xs">
                        {formatDate(connector.createdAt)}
                      </span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted">{t('detail_meta_updated')}</span>
                      <span className="text-foreground text-xs">
                        {formatDate(connector.updatedAt)}
                      </span>
                    </div>
                    {connector.autoConfiguredAt && (
                      <div className="flex justify-between">
                        <span className="text-muted">{t('detail_meta_auto_configured')}</span>
                        <span className="text-foreground text-xs">
                          {formatDate(connector.autoConfiguredAt)}
                        </span>
                      </div>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : null}
        </div>
      </div>
    </div>
  );
}
