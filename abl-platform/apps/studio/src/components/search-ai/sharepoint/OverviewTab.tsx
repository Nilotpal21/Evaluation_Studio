'use client';

/**
 * OverviewTab
 *
 * Default landing view for existing (non-draft) connectors.
 * Orchestrates all overview sections with progressive loading:
 * - KPIs and config summary first (fast from useConnector)
 * - Content breakdown (separate slower query)
 * - Sync history (separate paginated query)
 *
 * When sync is active, renders SyncProgressView instead.
 * Includes placeholders for T-27, T-30, T-32, T-34, T-35 integrations.
 */

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { toast } from 'sonner';
import { FileText, HardDrive, Globe, Library } from 'lucide-react';
import { Badge } from '../../ui/Badge';
import { useConnector, type ConnectorDetail } from '../../../hooks/useConnector';
import { useConnectorOverview, type OverviewData } from '../../../hooks/useConnectorOverview';
import {
  startConnectorSync,
  pauseConnectorSync,
  resumeConnectorSync,
} from '../../../api/search-ai';
import { ContentBreakdown } from './ContentBreakdown';
import { ConfigSummary } from './ConfigSummary';
import { ContentFreshnessWarning } from './ContentFreshnessWarning';
import { SyncHistoryTable } from './SyncHistoryTable';
import { QuickActionsBar } from './QuickActionsBar';
import { SyncProgressView } from './SyncProgressView';
import { NotificationConfig } from './NotificationConfig';
import { PermissionSyncStatus } from './PermissionSyncStatus';
import type { ConnectorTab } from '../../../store/connector-store';

interface OverviewTabProps {
  indexId: string;
  connectorId: string;
  onNavigateToTab: (tab: ConnectorTab) => void;
  onRefresh: () => void;
}

type StatusVariant = 'success' | 'accent' | 'error' | 'warning' | 'default';

const STATUS_BADGE_MAP: Record<OverviewData['status'], StatusVariant> = {
  healthy: 'success',
  syncing: 'accent',
  error: 'error',
  paused: 'warning',
  disconnected: 'default',
};

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
}

interface MetricCardProps {
  icon: React.ReactNode;
  value: string | number;
  label: string;
}

function MetricCard({ icon, value, label }: MetricCardProps) {
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

export function OverviewTab({
  indexId,
  connectorId,
  onNavigateToTab,
  onRefresh,
}: OverviewTabProps) {
  const t = useTranslations('search_ai.sharepoint.overview');
  const { connector, mutate: mutateConnector } = useConnector(indexId, connectorId);
  const {
    overview,
    isLoading: overviewLoading,
    mutate: mutateOverview,
  } = useConnectorOverview(indexId, connectorId);

  const syncInProgress = connector?.syncState?.syncInProgress === true;
  const isPaused = connector?.errorState?.isPaused === true;

  const connectorName = useMemo(() => {
    const config = connector?.connectionConfig as Record<string, unknown> | undefined;
    return String(config?.displayName ?? config?.siteName ?? 'SharePoint');
  }, [connector]);

  // Handle sync completion: refresh all data
  const handleSyncComplete = useCallback(() => {
    mutateConnector();
    mutateOverview();
    onRefresh();
  }, [mutateConnector, mutateOverview, onRefresh]);

  const [syncLoading, setSyncLoading] = useState(false);

  const handleSyncNow = useCallback(async () => {
    setSyncLoading(true);
    try {
      await startConnectorSync(connectorId);
      toast.success(t('sync_started'));
      mutateConnector();
      mutateOverview();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    } finally {
      setSyncLoading(false);
    }
  }, [connectorId, t, mutateConnector, mutateOverview]);

  const handlePause = useCallback(async () => {
    try {
      await pauseConnectorSync(connectorId);
      toast.success(t('pause_success'));
      mutateConnector();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [connectorId, t, mutateConnector]);

  const handleResume = useCallback(async () => {
    try {
      await resumeConnectorSync(connectorId);
      toast.success(t('resume_success'));
      mutateConnector();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : String(err));
    }
  }, [connectorId, t, mutateConnector]);

  // If sync is in progress, show SyncProgressView
  if (syncInProgress && connector) {
    return (
      <SyncProgressView
        indexId={indexId}
        connectorId={connectorId}
        connectorName={connectorName}
        onPause={() => {
          /* handled by SyncProgressView internally */
        }}
        onStop={() => {
          /* handled by SyncProgressView internally */
        }}
        onSyncComplete={handleSyncComplete}
      />
    );
  }

  // KPI data — use overview data if available, fallback to connector data
  const totalDocs = overview?.totalDocuments ?? connector?.syncState?.totalDocuments ?? 0;
  const totalSize = overview?.totalSize ?? 0;
  const siteCount = overview?.siteCount ?? 0;
  const libraryCount = overview?.libraryCount ?? 0;
  const status = overview?.status ?? 'healthy';

  return (
    <div className="p-6 space-y-6">
      {/* Status + Connection info */}
      <div className="flex items-center gap-3">
        <Badge variant={STATUS_BADGE_MAP[status]} dot pulse={status === 'syncing'}>
          {t(`status_${status}`)}
        </Badge>
        {overview?.connectedDate && overview?.authenticatedBy && (
          <span className="text-xs text-muted">
            {t('connected_info', {
              date: new Date(overview.connectedDate).toLocaleDateString(undefined, {
                month: 'short',
                day: 'numeric',
                year: 'numeric',
              }),
              email: overview.authenticatedBy,
            })}
          </span>
        )}
      </div>

      {/* KPI MetricCards */}
      <div className="grid grid-cols-2 gap-3">
        <MetricCard
          icon={<FileText className="w-4 h-4" />}
          value={totalDocs.toLocaleString()}
          label={t('kpi_documents')}
        />
        <MetricCard
          icon={<HardDrive className="w-4 h-4" />}
          value={formatSize(totalSize)}
          label={t('kpi_size')}
        />
        <MetricCard icon={<Globe className="w-4 h-4" />} value={siteCount} label={t('kpi_sites')} />
        <MetricCard
          icon={<Library className="w-4 h-4" />}
          value={libraryCount}
          label={t('kpi_libraries')}
        />
      </div>

      {/* Content Freshness Warning */}
      {overview?.contentFreshness && (
        <ContentFreshnessWarning
          lastSuccessfulSync={overview.contentFreshness.lastSuccessfulSync}
          recentFailedAttempts={overview.contentFreshness.recentFailedAttempts}
          scheduledInterval={overview.contentFreshness.scheduledInterval}
          onSyncNow={handleSyncNow}
          onViewHistory={() => onNavigateToTab('history')}
        />
      )}

      {/* Config Summary */}
      {connector && (
        <ConfigSummary
          connector={connector}
          overview={overview}
          onEditConfig={() => onNavigateToTab('scope-filters')}
          onViewFullConfig={() => onNavigateToTab('preview')}
        />
      )}

      {/* Content Breakdown (independent loading) */}
      <ContentBreakdown indexId={indexId} connectorId={connectorId} />

      {/* Permission Sync Status */}
      {connector && (
        <PermissionSyncStatus
          connectorId={connectorId}
          indexId={indexId}
          permissionConfig={connector.permissionConfig}
          permissionSync={overview?.permissionSync ?? null}
          isLoading={overviewLoading}
        />
      )}

      {/* Issues section */}
      <div className="space-y-2">
        <h3 className="text-sm font-medium text-foreground">{t('issues_title')}</h3>
        <p className="text-xs text-muted">{t('no_issues')}</p>
      </div>

      {/* Notification Config */}
      <NotificationConfig indexId={indexId} connectorId={connectorId} />

      {/* Sync History Table */}
      <SyncHistoryTable indexId={indexId} connectorId={connectorId} />

      {/* Quick Actions Bar */}
      <QuickActionsBar
        connectorId={connectorId}
        indexId={indexId}
        isPaused={isPaused}
        syncInProgress={syncInProgress || syncLoading}
        onSyncNow={handleSyncNow}
        onPause={handlePause}
        onResume={handleResume}
        onEditConfig={() => onNavigateToTab('scope-filters')}
        onReAuth={() => onNavigateToTab('connect')}
        onHealthCheck={() => onNavigateToTab('overview')}
        onSearchDocuments={() => onNavigateToTab('preview')}
      />
    </div>
  );
}
