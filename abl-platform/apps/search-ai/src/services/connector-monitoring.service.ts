/**
 * Connector Monitoring Service
 *
 * Provides overview data, content breakdown aggregations, and sync history
 * for the monitoring/overview tab. Each function is scoped by tenantId.
 */

import { createLogger } from '@abl/compiler/platform';
import { ConnectorError } from './connector.service.js';
import * as repo from '../repos/connector.repository.js';
import type { IConnectorConfig, IConnectorDiscovery } from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';
import { getAuditLog } from './connector-audit.service.js';

const logger = createLogger('connector-monitoring-service');

// ─── Types ──────────────────────────────────────────────────────────────

export interface OverviewData {
  connectorName: string;
  status: 'healthy' | 'syncing' | 'error' | 'paused' | 'disconnected';
  connectedDate: string;
  authenticatedBy: string;
  totalDocuments: number;
  totalSize: number;
  siteCount: number;
  libraryCount: number;
  configSummary: {
    scope: string;
    filters: string;
    schedule: string;
    permissionMode: string;
  };
  contentFreshness: {
    lastSuccessfulSync: string | null;
    scheduledInterval: string | null;
    recentFailedAttempts: number;
  };
  permissionSync: {
    permissionMode: string;
    lastCrawled: string | null;
    coverageTotal: number;
    coverageMapped: number;
    stalenessWarning: boolean;
    nextCrawl: string | null;
  };
}

interface TypeBreakdown {
  type: string;
  count: number;
  percentage: number;
}

interface SiteBreakdown {
  siteName: string;
  docCount: number;
  size: number;
}

export interface SyncHistoryEntry {
  date: string;
  type: 'full' | 'delta';
  docsAdded: number;
  docsRemoved: number;
  docsModified: number;
  duration: number;
  status: 'done' | 'failed' | 'cancelled';
}

// ─── Helpers ────────────────────────────────────────────────────────────

function deriveStatus(
  connector: IConnectorConfig,
): 'healthy' | 'syncing' | 'error' | 'paused' | 'disconnected' {
  const doc = connector as any;
  if (doc.syncState?.syncInProgress) return 'syncing';
  if (doc.errorState?.isPaused) return 'paused';
  if (!doc.oauthTokenId) return 'disconnected';
  if (doc.errorState?.consecutiveFailures > 0) return 'error';
  return 'healthy';
}

function buildScopeString(filterConfig: IConnectorConfig['filterConfig']): string {
  const scope = filterConfig?.scope as Record<string, unknown> | undefined;
  if (!scope) return 'Default';
  const siteMode = scope.siteMode as string | undefined;
  if (siteMode === 'all') return 'All sites';
  if (siteMode === 'selected') {
    const siteIds = scope.siteIds as string[] | undefined;
    return `${siteIds?.length ?? 0} selected sites`;
  }
  return siteMode ?? 'Default';
}

function buildFiltersString(filterConfig: IConnectorConfig['filterConfig']): string {
  const parts: string[] = [];
  const std = filterConfig?.standard;
  if (std?.fileExtensions) {
    const ext = std.fileExtensions;
    parts.push(`${ext.mode}: ${ext.extensions.length} extensions`);
  }
  if (std?.maxFileSizeBytes !== null && std?.maxFileSizeBytes !== undefined) {
    parts.push(`max ${Math.round(std.maxFileSizeBytes / (1024 * 1024))}MB`);
  }
  if (filterConfig?.advancedFilters?.enabled) {
    parts.push(`${filterConfig.advancedFilters.conditions.length} advanced rules`);
  }
  return parts.length > 0 ? parts.join(', ') : 'None';
}

function buildScheduleString(connector: IConnectorConfig): string {
  const doc = connector as any;
  const schedule = doc.permissionConfig?.crawlSchedule;
  if (!schedule) return 'Manual';
  return schedule;
}

// ─── Service Functions ──────────────────────────────────────────────────

/** Fast overview (<500ms): KPIs, config summary, content freshness, permission sync. */
export async function getOverview(connectorId: string, tenantId: string): Promise<OverviewData> {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const doc = connector as any;
  const status = deriveStatus(connector);

  const connectorName =
    doc.connectionConfig?.name || doc.connectionConfig?.tenantUrl || 'SharePoint Connector';

  const connectedDate = doc.createdAt ? new Date(doc.createdAt).toISOString() : '';
  const authenticatedBy = doc.connectionConfig?.authenticatedBy || '';

  // Content freshness
  const lastSuccessfulSync = doc.syncState?.lastFullSyncAt
    ? new Date(doc.syncState.lastFullSyncAt).toISOString()
    : doc.syncState?.lastDeltaSyncAt
      ? new Date(doc.syncState.lastDeltaSyncAt).toISOString()
      : null;

  const recentFailedAttempts = doc.errorState?.consecutiveFailures ?? 0;

  // Permission sync
  const permissionMode = doc.permissionConfig?.mode ?? 'disabled';
  const lastCrawled = doc.permissionConfig?.lastCrawlAt
    ? new Date(doc.permissionConfig.lastCrawlAt).toISOString()
    : null;

  // Discovery data for site/library counts
  const ConnectorDiscovery = getLazyModel<IConnectorDiscovery>('ConnectorDiscovery');
  const discovery = await ConnectorDiscovery.findOne({
    connectorId,
    tenantId,
    status: 'completed',
  })
    .sort({ discoveredAt: -1 })
    .lean();

  const siteCount = discovery?.resources?.filter((r: any) => r.resourceType === 'site').length ?? 0;
  const libraryCount =
    discovery?.resources?.filter((r: any) => r.resourceType === 'library').length ?? 0;

  // Total size from profiles
  const totalSize =
    discovery?.profiles?.reduce((sum: number, p: any) => sum + (p.totalSizeBytes || 0), 0) ?? 0;

  return {
    connectorName,
    status,
    connectedDate,
    authenticatedBy,
    totalDocuments: doc.syncState?.totalDocuments ?? 0,
    totalSize,
    siteCount,
    libraryCount,
    configSummary: {
      scope: buildScopeString(doc.filterConfig),
      filters: buildFiltersString(doc.filterConfig),
      schedule: buildScheduleString(connector),
      permissionMode,
    },
    contentFreshness: {
      lastSuccessfulSync,
      scheduledInterval: doc.permissionConfig?.crawlSchedule ?? null,
      recentFailedAttempts,
    },
    permissionSync: {
      permissionMode,
      lastCrawled,
      coverageTotal: doc.syncState?.totalDocuments ?? 0,
      coverageMapped: doc.permissionConfig?.documentsProcessed ?? 0,
      stalenessWarning:
        permissionMode === 'enabled' &&
        lastCrawled !== null &&
        Date.now() - new Date(lastCrawled).getTime() > 7 * 24 * 60 * 60 * 1000,
      nextCrawl: null, // Computed from scheduler — not available yet
    },
  };
}

/** Content breakdown (1-2s): aggregations by type and site. */
export async function getContentBreakdown(
  connectorId: string,
  tenantId: string,
): Promise<{ byType: TypeBreakdown[]; bySite: SiteBreakdown[] }> {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const ConnectorDiscovery = getLazyModel<IConnectorDiscovery>('ConnectorDiscovery');
  const discovery = await ConnectorDiscovery.findOne({
    connectorId,
    tenantId,
    status: 'completed',
  })
    .sort({ discoveredAt: -1 })
    .lean();

  if (!discovery || !discovery.profiles || discovery.profiles.length === 0) {
    return { byType: [], bySite: [] };
  }

  // Aggregate by file type across all profiles
  const typeMap = new Map<string, number>();
  for (const profile of discovery.profiles) {
    const dist = (profile as any).fileTypeDistribution as Record<string, number> | undefined;
    if (dist) {
      for (const [ext, count] of Object.entries(dist)) {
        typeMap.set(ext, (typeMap.get(ext) ?? 0) + count);
      }
    }
  }

  const totalDocs = Array.from(typeMap.values()).reduce((s, c) => s + c, 0);
  const byType: TypeBreakdown[] = Array.from(typeMap.entries())
    .map(([type, count]) => ({
      type,
      count,
      percentage: totalDocs > 0 ? Math.round((count / totalDocs) * 100) : 0,
    }))
    .sort((a, b) => b.count - a.count);

  // Aggregate by site (resources with type 'site')
  const siteResources = discovery.resources?.filter((r: any) => r.resourceType === 'site') ?? [];
  const bySite: SiteBreakdown[] = siteResources.map((site: any) => {
    const profile = discovery.profiles?.find((p: any) => p.resourceId === site.id);
    return {
      siteName: site.displayName || site.name,
      docCount: (profile as any)?.totalDocuments ?? 0,
      size: (profile as any)?.totalSizeBytes ?? 0,
    };
  });

  return { byType, bySite };
}

/** Paginated sync history. */
export async function getSyncHistory(
  connectorId: string,
  tenantId: string,
  options: { page: number; limit: number },
): Promise<{
  history: SyncHistoryEntry[];
  total: number;
  page: number;
  limit: number;
}> {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const { entries, total } = await getAuditLog(connectorId, tenantId, {
    category: 'sync',
    page: options.page,
    limit: options.limit,
  });

  const history: SyncHistoryEntry[] = entries.map((entry: any) => {
    const meta = entry.metadata ?? {};
    const eventName = entry.event as string;

    // Derive sync type from metadata or event name
    const syncType: 'full' | 'delta' = meta.syncType === 'delta' ? 'delta' : 'full';

    // Derive status from event name
    let status: 'done' | 'failed' | 'cancelled' = 'done';
    if (eventName.includes('fail') || eventName.includes('error')) {
      status = 'failed';
    } else if (eventName.includes('cancel') || eventName.includes('stop')) {
      status = 'cancelled';
    }

    return {
      date: entry.timestamp ? new Date(entry.timestamp).toISOString() : '',
      type: syncType,
      docsAdded: (meta.docsAdded as number) ?? 0,
      docsRemoved: (meta.docsRemoved as number) ?? 0,
      docsModified: (meta.docsModified as number) ?? 0,
      duration:
        typeof meta.durationSeconds === 'number'
          ? meta.durationSeconds
          : typeof meta.durationMs === 'number'
            ? Math.round(meta.durationMs / 1000)
            : 0,
      status,
    };
  });

  return {
    history,
    total,
    page: options.page,
    limit: options.limit,
  };
}

/** Update permission crawl schedule. */
export async function updatePermissionSchedule(
  connectorId: string,
  tenantId: string,
  schedule: string,
  cronExpression?: string,
): Promise<{ schedule: string; nextCrawl: string | null }> {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  // Map schedule labels to cron expressions
  let cronValue: string | null = null;
  switch (schedule) {
    case 'daily':
      cronValue = '0 2 * * *';
      break;
    case 'weekly':
      cronValue = '0 2 * * 0';
      break;
    case 'manual':
      cronValue = null;
      break;
    case 'custom':
      cronValue = cronExpression ?? null;
      break;
    default:
      cronValue = null;
  }

  const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
  await ConnectorConfig.findOneAndUpdate(
    { _id: connectorId, tenantId },
    { $set: { 'permissionConfig.crawlSchedule': cronValue } },
    { new: true },
  );

  logger.info('Permission schedule updated', { connectorId, schedule, cronValue });

  return {
    schedule,
    nextCrawl: null, // Computed from scheduler — not available yet
  };
}
