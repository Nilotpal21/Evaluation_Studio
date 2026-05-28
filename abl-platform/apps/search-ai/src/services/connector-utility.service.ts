/**
 * Connector Utility Service
 *
 * Provides site-statuses, filter-analysis, and check-site-access
 * for error states (T-34) and empty states (T-35).
 */

import { createLogger } from '@abl/compiler/platform';
import { ConnectorError } from './connector.service.js';
import * as repo from '../repos/connector.repository.js';
import { getLazyModel } from '../db/index.js';
import type { IConnectorConfig } from '@agent-platform/database/models';
import type { IConnectorDiscovery } from '@agent-platform/database/models';

const logger = createLogger('connector-utility-service');

// ─── Types ──────────────────────────────────────────────────────────────

interface SiteStatus {
  siteName: string;
  status: 'ok' | 'failed';
  docsSynced: number;
  docsTotal: number;
  errorReason: string | null;
}

interface FilterExclusion {
  filterType: string;
  excludedCount: number;
  detail: string;
}

// ─── Service Functions ──────────────────────────────────────────────────

/** Returns per-site sync statuses for partial failure display. */
export async function getSiteStatuses(
  connectorId: string,
  tenantId: string,
): Promise<SiteStatus[]> {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const doc = connector as any;

  // Try to read from syncState.perSiteProgress (added by T-29)
  const perSiteProgress = doc.syncState?.perSiteProgress as
    | Array<{
        siteName: string;
        percentage: number;
        docsProcessed: number;
        docsTotal: number;
      }>
    | undefined;

  if (perSiteProgress && perSiteProgress.length > 0) {
    return perSiteProgress.map((site) => ({
      siteName: site.siteName,
      status: site.docsProcessed === site.docsTotal ? ('ok' as const) : ('failed' as const),
      docsSynced: site.docsProcessed,
      docsTotal: site.docsTotal,
      errorReason: null,
    }));
  }

  // Fall back to discovery profile data
  const ConnectorDiscovery = getLazyModel<IConnectorDiscovery>('ConnectorDiscovery');
  const discovery = await ConnectorDiscovery.findOne({
    connectorId,
    tenantId,
    status: 'completed',
  })
    .sort({ discoveredAt: -1 })
    .lean();

  if (!discovery || !discovery.resources) {
    return [];
  }

  const sites = discovery.resources.filter((r: any) => r.resourceType === 'site');
  return sites.map((site: any) => {
    const profile = discovery.profiles?.find((p: any) => p.resourceId === site.id);
    return {
      siteName: site.displayName || site.name,
      status: 'ok' as const,
      docsSynced: (profile as any)?.totalDocuments ?? 0,
      docsTotal: (profile as any)?.totalDocuments ?? 0,
      errorReason: null,
    };
  });
}

/** Returns filter exclusion analysis for zero-document empty state. */
export async function getFilterAnalysis(
  connectorId: string,
  tenantId: string,
): Promise<{
  exclusions: FilterExclusion[];
  totalDiscoveredFiles: number;
}> {
  const connector = await repo.findConnectorByIdAndTenantLean(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const doc = connector as any;
  const filterConfig = doc.filterConfig;

  // Load discovery data for file counts
  const ConnectorDiscovery = getLazyModel<IConnectorDiscovery>('ConnectorDiscovery');
  const discovery = await ConnectorDiscovery.findOne({
    connectorId,
    tenantId,
    status: 'completed',
  })
    .sort({ discoveredAt: -1 })
    .lean();

  const totalDiscoveredFiles =
    discovery?.profiles?.reduce((sum: number, p: any) => sum + (p.totalDocuments || 0), 0) ?? 0;

  const exclusions: FilterExclusion[] = [];

  // Estimate file extension exclusions
  if (filterConfig?.standard?.fileExtensions) {
    const ext = filterConfig.standard.fileExtensions;
    if (ext.mode === 'allowlist' && ext.extensions.length > 0) {
      // Count files NOT matching allowed extensions
      let matchedCount = 0;
      if (discovery?.profiles) {
        for (const profile of discovery.profiles) {
          const dist = (profile as any).fileTypeDistribution as Record<string, number> | undefined;
          if (dist) {
            for (const [fileType, count] of Object.entries(dist)) {
              if (ext.extensions.some((e: string) => fileType.endsWith(e))) {
                matchedCount += count;
              }
            }
          }
        }
      }
      const excluded = totalDiscoveredFiles - matchedCount;
      if (excluded > 0) {
        exclusions.push({
          filterType: 'File extension (allowlist)',
          excludedCount: excluded,
          detail: `Only ${ext.extensions.join(', ')} are allowed`,
        });
      }
    } else if (ext.mode === 'denylist' && ext.extensions.length > 0) {
      let deniedCount = 0;
      if (discovery?.profiles) {
        for (const profile of discovery.profiles) {
          const dist = (profile as any).fileTypeDistribution as Record<string, number> | undefined;
          if (dist) {
            for (const [fileType, count] of Object.entries(dist)) {
              if (ext.extensions.some((e: string) => fileType.endsWith(e))) {
                deniedCount += count;
              }
            }
          }
        }
      }
      if (deniedCount > 0) {
        exclusions.push({
          filterType: 'File extension (denylist)',
          excludedCount: deniedCount,
          detail: `${ext.extensions.join(', ')} are excluded`,
        });
      }
    }
  }

  // Estimate size filter exclusions
  if (
    filterConfig?.standard?.maxFileSizeBytes !== null &&
    filterConfig?.standard?.maxFileSizeBytes !== undefined
  ) {
    exclusions.push({
      filterType: 'Max file size',
      excludedCount: 0, // Cannot estimate without per-file sizes
      detail: `Files over ${Math.round(filterConfig.standard.maxFileSizeBytes / (1024 * 1024))}MB are excluded`,
    });
  }

  // Date filter exclusions
  if (filterConfig?.standard?.modifiedAfter) {
    exclusions.push({
      filterType: 'Modified after',
      excludedCount: 0,
      detail: `Only files modified after ${new Date(filterConfig.standard.modifiedAfter).toLocaleDateString(undefined)} are included`,
    });
  }

  return { exclusions, totalDiscoveredFiles };
}

/** Checks if a site URL is accessible with current connector credentials. */
export async function checkSiteAccess(
  connectorId: string,
  tenantId: string,
  siteUrl: string,
): Promise<{
  accessible: boolean;
  siteName?: string;
  error?: string;
}> {
  // Load connector to get OAuth token
  const connector = await repo.findConnectorByIdAndTenant(connectorId, tenantId);
  if (!connector) {
    throw new ConnectorError('NOT_FOUND', 'Connector not found', 404);
  }

  const doc = connector as any;
  if (!doc.oauthTokenId) {
    return {
      accessible: false,
      error: 'Connector is not authenticated',
    };
  }

  // Load OAuth token
  const token = await repo.findOAuthToken(doc.oauthTokenId, tenantId);
  if (!token) {
    return {
      accessible: false,
      error: 'OAuth token not found',
    };
  }

  const tokenDoc = token as any;
  const accessToken = tokenDoc.accessToken;

  if (!accessToken) {
    return {
      accessible: false,
      error: 'Access token is not available',
    };
  }

  // Parse site URL to extract hostname and path
  let parsedUrl: URL;
  try {
    parsedUrl = new URL(siteUrl);
  } catch {
    return {
      accessible: false,
      error: 'Invalid URL format',
    };
  }

  const hostname = parsedUrl.hostname;
  const sitePath = parsedUrl.pathname.replace(/^\//, '').replace(/\/$/, '');

  // Call Graph API: GET https://graph.microsoft.com/v1.0/sites/{hostname}:/{path}
  const graphUrl = sitePath
    ? `https://graph.microsoft.com/v1.0/sites/${hostname}:/${sitePath}`
    : `https://graph.microsoft.com/v1.0/sites/${hostname}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 10_000);

  try {
    const response = await fetch(graphUrl, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (response.ok) {
      const data = await response.json();
      return {
        accessible: true,
        siteName: (data as any).displayName ?? (data as any).name ?? hostname,
      };
    }

    return {
      accessible: false,
      error: `${response.status} ${response.statusText}`,
    };
  } catch (error) {
    clearTimeout(timeoutId);
    const msg = error instanceof Error ? error.message : String(error);
    logger.warn('Check site access failed', { connectorId, siteUrl, error: msg });
    return {
      accessible: false,
      error: msg,
    };
  }
}
