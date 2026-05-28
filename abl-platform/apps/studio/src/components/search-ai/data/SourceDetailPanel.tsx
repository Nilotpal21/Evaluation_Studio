/**
 * SourceDetailPanel Component
 *
 * Slide panel for non-enterprise sources (manual/file, web, database, api).
 * Shows overview, configuration, actions, and danger zone.
 *
 * For web sources, renders an enhanced tabbed view with:
 *   Overview | Pages | History | Progress
 */

import { useState, useEffect, useMemo } from 'react';
import { useTranslations } from 'next-intl';
import useSWR, { useSWRConfig } from 'swr';
import {
  X,
  RotateCcw,
  AlertTriangle,
  Upload,
  Globe,
  FileText,
  Clock,
  Activity,
  HardDrive,
  Layers,
} from 'lucide-react';
import { SlidePanel } from '../../ui/SlidePanel';
import { Badge, type BadgeVariant } from '../../ui/Badge';
import { Button } from '../../ui/Button';
import { Card } from '../../ui/Card';
import { Tabs } from '../../ui/Tabs';
import { Progress } from '../../ui/Progress';
import type { SearchAISource } from '../../../api/search-ai';
import {
  deleteSource,
  deleteConnector,
  startConnectorSync,
  fetchSourceStats,
  type SourceStats,
} from '../../../api/search-ai';
import { useConnectorStore } from '../../../store/connector-store';
import { getCrawlHistory } from '../../../api/crawl';
import type { CrawlJob } from '../../../api/crawl';
import { CrawlJobProgress } from '../CrawlJobProgress';
import { CrawledPagesView } from '../CrawledPagesView';
import { CrawlJobHistory } from '../CrawlJobHistory';
import { useMultiPageProgress } from '../../../hooks/useMultiPageProgress';
import { sanitizeError } from '@/lib/sanitize-error';
import { getSourceDisplayName } from '@/lib/upload-constants';
import { toast } from 'sonner';

interface SourceDetailPanelProps {
  open: boolean;
  onClose: () => void;
  source: SearchAISource | null;
  indexId: string;
  /** Enterprise connector ID linked to this source (enables sync actions) */
  connectorId?: string | null;
  onRefresh: () => void;
  onViewDocuments: () => void;
  onUploadFiles?: () => void;
}

const statusVariant: Record<string, BadgeVariant> = {
  active: 'success',
  pending: 'default',
  syncing: 'info',
  error: 'error',
};

type WebTab = 'overview' | 'pages' | 'history' | 'progress';

const TERMINAL_STATUSES = new Set(['completed', 'failed', 'cancelled']);

function formatDate(iso: string | null): string {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatDuration(startedAt?: string, completedAt?: string): string {
  if (!startedAt || !completedAt) return '—';
  const ms = new Date(completedAt).getTime() - new Date(startedAt).getTime();
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  if (mins < 60) return `${mins}m ${secs}s`;
  const hrs = Math.floor(mins / 60);
  return `${hrs}h ${mins % 60}m`;
}

function sourceTypeLabel(sourceType: string, t: (key: string) => string): string {
  switch (sourceType) {
    case 'manual':
    case 'file':
      return t('type_manual');
    case 'web':
      return t('type_web');
    case 'database':
      return t('type_database');
    case 'api':
      return t('type_api');
    case 'sharepoint':
      return t('type_sharepoint');
    default:
      return sourceType;
  }
}

export function SourceDetailPanel({
  open,
  onClose,
  source,
  indexId,
  connectorId,
  onRefresh,
  onViewDocuments,
  onUploadFiles,
}: SourceDetailPanelProps) {
  const t = useTranslations('search_ai.source_detail');
  const { mutate: globalMutate } = useSWRConfig();
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [activeTab, setActiveTab] = useState<WebTab>('overview');

  // Reset transient state when source changes
  useEffect(() => {
    setConfirmingDelete(false);
    setDeleting(false);
    setRetrying(false);
    setActiveTab('overview');
  }, [source?._id]);

  // ---------------------------------------------------------------------------
  // Web source data fetching
  // ---------------------------------------------------------------------------

  const isWeb = source?.sourceType === 'web';

  const { data: historyData } = useSWR(isWeb ? ['crawl-history', indexId] : null, () =>
    getCrawlHistory(indexId, 100),
  );

  // Filter jobs by sourceId client-side
  const sourceJobs = useMemo(() => {
    if (!historyData?.jobs) return [];
    return historyData.jobs.filter((job: CrawlJob) => job.sourceId === source?._id);
  }, [historyData, source?._id]);

  // Find active job (latest non-terminal status)
  const activeJob = useMemo(() => {
    return sourceJobs.find((job: CrawlJob) => !TERMINAL_STATUSES.has(job.status));
  }, [sourceJobs]);

  // Latest completed job (for pages view)
  const latestCompletedJob = useMemo(() => {
    return sourceJobs.find((job: CrawlJob) => job.status === 'completed');
  }, [sourceJobs]);

  // Auto-switch to Progress tab when crawl is active
  useEffect(() => {
    if (activeJob && activeTab === 'overview') {
      setActiveTab('progress');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeJob]);

  // Multi-page progress for SWR invalidation (H-5)
  const multiPageProgress = useMultiPageProgress(
    activeJob?.strategy === 'intelligence' ? activeJob._id : null,
  );

  useEffect(() => {
    if (multiPageProgress.isComplete || multiPageProgress.isFailed) {
      globalMutate(['crawl-history', indexId]);
      onRefresh();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [multiPageProgress.isComplete, multiPageProgress.isFailed]);

  if (!source) return null;

  const config = source.sourceConfig as Record<string, unknown> | null;
  const isManual = source.sourceType === 'manual' || source.sourceType === 'file';

  // Panel positioning: starts below KB header + section tabs (matches SharePoint panel layout).
  // top-[9.5rem] clears breadcrumb + header + tabs. Width 640px matches SharePoint panel.
  const panelClassName = [
    '!top-[9.5rem] !h-[calc(100vh-9.5rem)] !rounded-tl-xl',
    'shadow-2xl',
    '!max-w-[640px]',
  ].join(' ');

  const panelHeader = (
    <div className="-mx-6 -mt-6 px-6 pt-5 pb-3 border-b border-default mb-5">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3 min-w-0">
          <h2 className="text-lg font-semibold text-foreground truncate">
            {getSourceDisplayName(source.name)}
          </h2>
          <Badge variant={statusVariant[source.status] ?? 'default'} dot>
            {source.status}
          </Badge>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-muted hover:text-foreground hover:bg-background-muted rounded-lg transition-default shrink-0"
          aria-label="Close panel"
        >
          <X className="w-4 h-4" />
        </button>
      </div>
      <p className="text-sm text-muted mt-1">{sourceTypeLabel(source.sourceType, t)}</p>
    </div>
  );

  const handleDelete = async () => {
    setDeleting(true);
    try {
      // For SharePoint connectors, use the connector DELETE endpoint
      // which cleans up connector + source + OAuth tokens
      if (source.sourceType === 'sharepoint' || source.sourceType === 'connector') {
        // Find the connector ID from the source's config or connector store
        const connectorId =
          (source.sourceConfig as any)?.connectorId ??
          useConnectorStore.getState().activeConnectorId;
        if (connectorId) {
          await deleteConnector(indexId, connectorId);
        } else {
          await deleteSource(indexId, source._id);
        }
      } else {
        await deleteSource(indexId, source._id);
      }
      toast.success(t('delete_success'));
      // Close both this panel and the SharePoint detail panel
      useConnectorStore.getState().closePanel();
      onClose();
      onRefresh();
    } catch (err: unknown) {
      const msg = sanitizeError(err, t('delete_error'));
      toast.error(msg);
    } finally {
      setDeleting(false);
      setConfirmingDelete(false);
    }
  };

  const handleRetrySync = async () => {
    if (!connectorId) return;
    setRetrying(true);
    try {
      await startConnectorSync(connectorId);
      toast.success(t('retry_sync_success'));
      onRefresh();
    } catch (err: unknown) {
      const msg = sanitizeError(err, t('retry_sync_error'));
      toast.error(msg);
    } finally {
      setRetrying(false);
    }
  };

  // ---------------------------------------------------------------------------
  // Web source tabbed view
  // ---------------------------------------------------------------------------

  const webTabs = useMemo(() => {
    const tabs: Array<{ id: string; label: string; icon: React.ReactNode }> = [
      {
        id: 'overview',
        label: t('tab_overview'),
        icon: <Globe className="w-3.5 h-3.5" />,
      },
      { id: 'pages', label: t('tab_pages'), icon: <FileText className="w-3.5 h-3.5" /> },
      { id: 'history', label: t('tab_history'), icon: <Clock className="w-3.5 h-3.5" /> },
    ];
    if (activeJob) {
      tabs.push({
        id: 'progress',
        label: t('tab_progress'),
        icon: <Activity className="w-3.5 h-3.5" />,
      });
    }
    return tabs;
  }, [t, activeJob]);

  const latestJob = sourceJobs[0] as CrawlJob | undefined;

  if (isWeb) {
    return (
      <SlidePanel open={open} onClose={onClose} className={panelClassName} nonBlocking>
        {panelHeader}
        <div className="space-y-4">
          {/* Tab bar */}
          <Tabs
            tabs={webTabs}
            activeTab={activeTab}
            onTabChange={(id) => setActiveTab(id as WebTab)}
            layoutId="source-detail-tab"
          />

          {/* Overview Tab */}
          {activeTab === 'overview' && (
            <div className="space-y-6">
              <section>
                <h3 className="text-sm font-semibold text-foreground mb-3">{t('overview')}</h3>
                <div className="space-y-2">
                  <DetailRow
                    label={t('documents_label')}
                    value={source.documentCount.toLocaleString()}
                  />
                  <DetailRow label={t('last_crawl_label')} value={formatDate(source.lastSyncAt)} />
                  <DetailRow
                    label={t('strategy_label')}
                    value={
                      latestJob?.strategy === 'intelligence'
                        ? t('strategy_intelligence')
                        : latestJob?.strategy
                          ? t('strategy_bulk')
                          : '—'
                    }
                  />
                  <div className="flex items-center justify-between">
                    <span className="text-sm text-muted">{t('status')}</span>
                    <Badge variant={statusVariant[source.status] ?? 'default'} dot>
                      {source.status}
                    </Badge>
                  </div>
                </div>
              </section>

              {/* Latest crawl summary card */}
              {latestJob && (
                <section>
                  <h3 className="text-sm font-semibold text-foreground mb-3">
                    {t('latest_crawl')}
                  </h3>
                  <Card padding="md" hoverable={false}>
                    <div className="space-y-2 text-sm">
                      <div className="flex items-center justify-between">
                        <Badge
                          variant={
                            latestJob.status === 'completed'
                              ? 'success'
                              : latestJob.status === 'failed'
                                ? 'error'
                                : 'accent'
                          }
                          dot
                        >
                          {latestJob.status}
                        </Badge>
                        <span className="text-xs text-muted">
                          {formatDate(latestJob.timeline.submittedAt)}
                        </span>
                      </div>
                      <DetailRow
                        label={t('pages_crawled', { crawled: latestJob.urls.crawled })}
                        value={t('pages_failed', { failed: latestJob.urls.failed })}
                      />
                      <DetailRow
                        label={t('duration', {
                          time: formatDuration(
                            latestJob.timeline.startedAt,
                            latestJob.timeline.completedAt,
                          ),
                        })}
                        value={t('documents_created_count', {
                          count: latestJob.results.documentsCreated,
                        })}
                      />
                    </div>
                  </Card>
                </section>
              )}

              {/* Actions */}
              <section>
                <div className="flex flex-wrap gap-2">
                  <Button size="sm" variant="secondary" onClick={onViewDocuments}>
                    {t('view_documents')}
                  </Button>
                </div>
              </section>

              {/* Danger Zone */}
              <section className="border-t border-default pt-4">
                <h3 className="text-sm font-semibold text-error mb-3">{t('danger_zone')}</h3>
                {confirmingDelete ? (
                  <div className="space-y-3">
                    <p className="text-sm text-muted">{t('delete_confirm')}</p>
                    <div className="flex gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => setConfirmingDelete(false)}
                        disabled={deleting}
                      >
                        {t('delete_cancel')}
                      </Button>
                      <Button
                        size="sm"
                        variant="danger"
                        onClick={handleDelete}
                        loading={deleting}
                        disabled={deleting}
                      >
                        {t('delete_proceed')}
                      </Button>
                    </div>
                  </div>
                ) : (
                  <Button size="sm" variant="danger" onClick={() => setConfirmingDelete(true)}>
                    {t('delete_source')}
                  </Button>
                )}
              </section>
            </div>
          )}

          {/* Pages Tab */}
          {activeTab === 'pages' && (
            <div>
              {latestCompletedJob ? (
                <CrawledPagesView
                  jobId={latestCompletedJob._id}
                  indexId={indexId}
                  sourceId={source._id}
                />
              ) : (
                <div className="text-center py-8 text-sm text-muted">{t('no_pages')}</div>
              )}
            </div>
          )}

          {/* History Tab */}
          {activeTab === 'history' && (
            <CrawlJobHistory
              indexId={indexId}
              externalJobs={sourceJobs}
              onSelectJob={() => setActiveTab('pages')}
              onDeleteJob={() => {
                globalMutate(['crawl-history', indexId]);
                onRefresh();
              }}
            />
          )}

          {/* Progress Tab */}
          {activeTab === 'progress' && (
            <div>
              {activeJob ? (
                <CrawlJobProgress jobId={activeJob._id} strategy={activeJob.strategy} />
              ) : (
                <div className="text-center py-8 text-sm text-muted">{t('no_pages')}</div>
              )}
            </div>
          )}
        </div>
      </SlidePanel>
    );
  }

  // ---------------------------------------------------------------------------
  // Non-web sources (unchanged)
  // ---------------------------------------------------------------------------

  const renderConfiguration = () => {
    switch (source.sourceType) {
      case 'manual':
      case 'file': {
        if (!config || Object.keys(config).length === 0) {
          return <p className="text-sm text-muted">{t('no_config')}</p>;
        }
        return (
          <div className="space-y-2">
            <p className="text-sm text-foreground">{sourceTypeLabel(source.sourceType, t)}</p>
            {config.fileTypes !== undefined && (
              <DetailRow label={t('file_types')} value={String(config.fileTypes)} />
            )}
            {config.maxFileSize !== undefined && (
              <DetailRow label={t('max_file_size')} value={String(config.maxFileSize)} />
            )}
          </div>
        );
      }
      case 'database': {
        const conn = config?.connectionString ? String(config.connectionString) : '';
        // Redact credentials: show only protocol + host, replace user:pass with ***
        const masked = conn.replace(/:\/\/[^@]+@/, '://***@').replace(/(\?|$).*/, '');
        return (
          <div className="space-y-2">
            {conn && <DetailRow label={t('connection')} value={masked} />}
            {config?.collection !== undefined && (
              <DetailRow label={t('collection')} value={String(config.collection)} />
            )}
            {config?.query !== undefined && (
              <DetailRow label={t('query')} value={String(config.query)} />
            )}
          </div>
        );
      }
      case 'api':
        return (
          <div className="space-y-2">
            {config?.url !== undefined && <DetailRow label={t('url')} value={String(config.url)} />}
            {config?.method !== undefined && (
              <DetailRow label={t('method')} value={String(config.method)} />
            )}
            {config?.authType !== undefined && (
              <DetailRow label={t('auth_type')} value={String(config.authType)} />
            )}
          </div>
        );
      default:
        return <p className="text-sm text-muted">{t('no_config')}</p>;
    }
  };

  return (
    <SlidePanel open={open} onClose={onClose} className={panelClassName} nonBlocking>
      {panelHeader}
      <div className="space-y-6">
        {/* Overview */}
        <section>
          <h3 className="text-sm font-semibold text-foreground mb-3">{t('overview')}</h3>
          <div className="space-y-2">
            <DetailRow label={t('documents')} value={source.documentCount.toLocaleString()} />
            {!isManual && (
              <DetailRow label={t('last_sync')} value={formatDate(source.lastSyncAt)} />
            )}
          </div>
        </section>

        {/* Error detail */}
        {source.status === 'error' && source.syncError && (
          <section className="rounded-lg border border-error/30 bg-error/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 text-error mt-0.5 shrink-0" />
              <div className="space-y-2 min-w-0">
                <h3 className="text-sm font-semibold text-error">{t('sync_error')}</h3>
                <p className="text-xs text-error/80 break-words font-mono">{source.syncError}</p>
                {source.lastSyncAt && (
                  <p className="text-xs text-muted">
                    {t('error_occurred_at', { date: formatDate(source.lastSyncAt) })}
                  </p>
                )}
                {connectorId ? (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<RotateCcw className="w-3.5 h-3.5" />}
                    loading={retrying}
                    onClick={handleRetrySync}
                  >
                    {t('retry_sync')}
                  </Button>
                ) : (
                  <p className="text-xs text-muted">{t('no_sync_controls')}</p>
                )}
              </div>
            </div>
          </section>
        )}

        {/* Manual source: rich analytics dashboard */}
        {isManual ? (
          <ManualSourceOverview
            source={source}
            indexId={indexId}
            onUploadFiles={onUploadFiles}
            onViewDocuments={onViewDocuments}
          />
        ) : (
          <>
            {/* Configuration (connector sources only) */}
            <section>
              <h3 className="text-sm font-semibold text-foreground mb-3">{t('configuration')}</h3>
              {renderConfiguration()}
            </section>

            {/* Sync info for non-enterprise connector sources */}
            {!connectorId && (
              <section className="rounded-lg border border-default bg-background-muted px-3 py-2">
                <p className="text-xs text-muted">{t('sync_automated')}</p>
              </section>
            )}

            {/* Actions */}
            <section>
              <h3 className="text-sm font-semibold text-foreground mb-3">{t('actions')}</h3>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" onClick={onViewDocuments}>
                  {t('view_documents')}
                </Button>
                {connectorId && source.status !== 'error' && (
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<RotateCcw className="w-3.5 h-3.5" />}
                    loading={retrying}
                    onClick={handleRetrySync}
                  >
                    {t('sync_now')}
                  </Button>
                )}
              </div>
            </section>
          </>
        )}

        {/* Danger Zone */}
        <section className="border-t border-default pt-4">
          <h3 className="text-sm font-semibold text-error mb-3">{t('danger_zone')}</h3>
          {confirmingDelete ? (
            <div className="space-y-3">
              <p className="text-sm text-muted">{t('delete_confirm')}</p>
              <div className="flex gap-2">
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setConfirmingDelete(false)}
                  disabled={deleting}
                >
                  {t('delete_cancel')}
                </Button>
                <Button
                  size="sm"
                  variant="danger"
                  onClick={handleDelete}
                  loading={deleting}
                  disabled={deleting}
                >
                  {t('delete_proceed')}
                </Button>
              </div>
            </div>
          ) : (
            <Button size="sm" variant="danger" onClick={() => setConfirmingDelete(true)}>
              {t('delete_source')}
            </Button>
          )}
        </section>
      </div>
    </SlidePanel>
  );
}

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between">
      <span className="text-sm text-muted">{label}</span>
      <span className="text-sm text-foreground font-mono">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Metric card for KPI row (mirrors SharePoint OverviewTab MetricCard)
// ---------------------------------------------------------------------------

function MetricCard({
  icon,
  value,
  label,
}: {
  icon: React.ReactNode;
  value: string | number;
  label: string;
}) {
  return (
    <div className="flex items-center gap-3 p-3 rounded-lg bg-background-subtle border border-default">
      <div className="w-9 h-9 rounded-lg bg-background-muted flex items-center justify-center text-muted">
        {icon}
      </div>
      <div>
        <p className="text-lg font-semibold text-foreground">{value}</p>
        <p className="text-xs text-muted">{label}</p>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Format bytes → human-readable
// ---------------------------------------------------------------------------

function formatSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

// ---------------------------------------------------------------------------
// Status color mapping for document processing status dots
// ---------------------------------------------------------------------------

const DOC_STATUS_COLORS: Record<string, string> = {
  completed: 'bg-success',
  indexed: 'bg-success',
  processed: 'bg-success',
  failed: 'bg-error',
  error: 'bg-error',
  pending: 'bg-warning',
  extracting: 'bg-accent',
  enriching: 'bg-accent',
  embedding: 'bg-accent',
};

// ---------------------------------------------------------------------------
// ManualSourceOverview — Rich analytics dashboard for file/manual sources
// ---------------------------------------------------------------------------

function ManualSourceOverview({
  source,
  indexId,
  onUploadFiles,
  onViewDocuments,
}: {
  source: SearchAISource;
  indexId: string;
  onUploadFiles?: () => void;
  onViewDocuments: () => void;
}) {
  const t = useTranslations('search_ai.source_detail');

  const { data: stats, isLoading } = useSWR<SourceStats>(
    ['source-stats', indexId, source._id],
    () => fetchSourceStats(indexId, source._id),
    {
      revalidateOnFocus: true,
      refreshInterval: (latestData?: SourceStats) => {
        // Poll at 1s only while this source has documents still processing
        const activeStatuses = new Set(['pending', 'extracting', 'enriching', 'embedding']);
        const hasActive = latestData?.byStatus?.some(
          (s) => activeStatuses.has(s.status) && s.count > 0,
        );
        return hasActive ? 1_000 : 0;
      },
      dedupingInterval: 0,
    },
  );

  // Empty state — no documents yet
  if (!isLoading && source.documentCount === 0) {
    return (
      <section>
        {onUploadFiles ? (
          <div className="rounded-lg border border-dashed border-default bg-background-muted p-4 text-center space-y-2">
            <Upload className="w-6 h-6 text-muted mx-auto" />
            <p className="text-sm font-medium text-foreground">{t('manual_empty_title')}</p>
            <p className="text-xs text-muted">{t('manual_empty_desc')}</p>
            <Button size="sm" icon={<Upload className="w-3.5 h-3.5" />} onClick={onUploadFiles}>
              {t('upload_files')}
            </Button>
          </div>
        ) : (
          <p className="text-sm text-muted">{t('manual_empty_desc')}</p>
        )}
      </section>
    );
  }

  // Loading skeleton
  if (isLoading || !stats) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-16 bg-background-muted rounded-lg animate-pulse" />
          ))}
        </div>
        <div className="space-y-2">
          {[1, 2, 3].map((i) => (
            <div key={i} className="h-6 bg-background-muted rounded animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* KPI Metric Cards — 2-col grid matching SharePoint overview style */}
      <section>
        <div className="grid grid-cols-2 gap-3">
          <MetricCard
            icon={<FileText className="w-4 h-4" />}
            value={stats.documentCount.toLocaleString()}
            label={t('kpi_documents')}
          />
          <MetricCard
            icon={<HardDrive className="w-4 h-4" />}
            value={formatSize(stats.size.total)}
            label={t('kpi_total_size')}
          />
          <MetricCard
            icon={<Layers className="w-4 h-4" />}
            value={stats.totalChunks.toLocaleString()}
            label={t('kpi_chunks')}
          />
          {stats.totalPages > 0 && (
            <MetricCard
              icon={<FileText className="w-4 h-4" />}
              value={stats.totalPages.toLocaleString()}
              label={t('kpi_pages')}
            />
          )}
        </div>
      </section>

      {/* Content Breakdown by File Type */}
      {stats.byFileType.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-foreground mb-3">{t('content_breakdown')}</h3>
          <div className="space-y-2">
            <p className="text-xs text-muted font-medium uppercase tracking-wider">
              {t('by_file_type')}
            </p>
            {stats.byFileType.slice(0, 6).map((ft) => (
              <div key={ft.type} className="space-y-1">
                <div className="flex items-center justify-between text-xs">
                  <span className="text-foreground uppercase font-medium">{ft.type}</span>
                  <span className="text-muted">
                    {ft.count} ({ft.percentage}%)
                  </span>
                </div>
                <Progress value={ft.percentage} />
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Document Processing Status */}
      {stats.byStatus.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-foreground mb-3">{t('processing_status')}</h3>
          <div className="flex flex-wrap gap-3">
            {stats.byStatus.map((s) => (
              <div key={s.status} className="flex items-center gap-1.5 text-xs">
                <span
                  className={`w-2 h-2 rounded-full ${DOC_STATUS_COLORS[s.status] ?? 'bg-muted'}`}
                />
                <span className="text-muted capitalize">{s.status}</span>
                <span className="text-foreground font-semibold">{s.count}</span>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Storage Summary */}
      <section>
        <h3 className="text-sm font-semibold text-foreground mb-3">{t('storage_summary')}</h3>
        <Card padding="md" hoverable={false}>
          <div className="space-y-2 text-sm">
            <DetailRow label={t('storage_total')} value={formatSize(stats.size.total)} />
            <DetailRow label={t('storage_avg')} value={formatSize(stats.size.average)} />
            {stats.size.largest > 0 && (
              <DetailRow label={t('storage_largest')} value={formatSize(stats.size.largest)} />
            )}
          </div>
        </Card>
      </section>

      {/* Recent Activity */}
      {stats.recentDocuments.length > 0 && (
        <section>
          <h3 className="text-sm font-semibold text-foreground mb-3">{t('recent_activity')}</h3>
          <div className="space-y-1.5">
            {stats.recentDocuments.map((doc) => (
              <div
                key={doc._id}
                className="flex items-center justify-between text-xs py-1.5 border-b border-default last:border-0"
              >
                <span className="text-foreground truncate max-w-[50%]">
                  {doc.name?.split('/').pop() ?? t('untitled_doc')}
                </span>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-muted">{formatSize(doc.size)}</span>
                  <span className="text-muted">{formatDate(doc.createdAt)}</span>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* Actions */}
      <section>
        <div className="flex flex-wrap gap-2">
          {onUploadFiles && (
            <Button
              size="sm"
              variant="secondary"
              icon={<Upload className="w-3.5 h-3.5" />}
              onClick={onUploadFiles}
            >
              {t('upload_files')}
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={onViewDocuments}>
            {t('view_documents')}
          </Button>
        </div>
      </section>
    </div>
  );
}
