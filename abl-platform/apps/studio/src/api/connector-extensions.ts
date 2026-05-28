/**
 * Connector Extensions API
 *
 * Additional API functions for Phase 3 features:
 * - Stop sync (hybrid cancellation)
 * - Site selection (discovered sites, select sites)
 * - Real-time progress streaming
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// UTILITY
// =============================================================================

function engineUrl(path: string): string {
  const baseUrl = process.env.NEXT_PUBLIC_SEARCH_AI_URL || 'http://localhost:3005';
  return `${baseUrl}/api${path}`;
}

// =============================================================================
// TYPES
// =============================================================================

export interface DiscoveredSite {
  id: string;
  name: string;
  displayName: string;
  url: string;
  metadata?: Record<string, unknown>;
  profile?: {
    totalDocuments: number;
    totalSizeBytes: number;
    fileTypeDistribution: Record<string, number>;
    updateFrequency: string;
    lastActivityDate: string;
  } | null;
}

export interface DiscoveredSitesResponse {
  success: boolean;
  data: {
    sites: DiscoveredSite[];
    pagination: {
      page: number;
      limit: number;
      total: number;
      totalPages: number;
    };
  };
}

export interface SelectedSitesResponse {
  success: boolean;
  data: {
    mode: 'all' | 'selected' | 'excluded';
    siteIds: string[];
    selectedCount: number;
  };
}

export interface SyncProgressEvent {
  type: 'documents_processed';
  jobId: string;
  timestamp: string;
  data: {
    currentDocument: string;
    rate: number;
    eta?: string;
    progress: {
      total: number;
      completed: number;
      failed: number;
      percentage: number;
    };
  };
}

// =============================================================================
// STOP SYNC
// =============================================================================

/**
 * Stop connector sync with hybrid cancellation (Redis + DB)
 */
export async function stopConnectorSync(
  connectorId: string,
  reason?: string,
): Promise<{ success: boolean; data: { stopped: boolean; reason: string } }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/sync/stop`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return handleResponse(response);
}

// =============================================================================
// SITE SELECTION
// =============================================================================

/**
 * Get discovered sites for a connector with pagination and search
 */
export async function getDiscoveredSites(
  connectorId: string,
  options?: {
    search?: string;
    page?: number;
    limit?: number;
  },
): Promise<DiscoveredSitesResponse> {
  const params = new URLSearchParams();
  if (options?.search) params.set('search', options.search);
  if (options?.page) params.set('page', options.page.toString());
  if (options?.limit) params.set('limit', options.limit.toString());

  const queryString = params.toString();
  const url = engineUrl(
    `/connectors/${connectorId}/discovered-sites${queryString ? `?${queryString}` : ''}`,
  );

  const response = await apiFetch(url, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Get current site selection configuration
 */
export async function getSelectedSites(connectorId: string): Promise<SelectedSitesResponse> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/selected-sites`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Update site selection
 */
export async function selectSites(
  connectorId: string,
  siteIds: string[],
  mode: 'selected' | 'excluded' = 'selected',
): Promise<{
  success: boolean;
  data: { selectedCount: number; mode: string; message: string };
}> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/select-sites`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ siteIds, mode }),
  });
  return handleResponse(response);
}

// =============================================================================
// REAL-TIME PROGRESS
// =============================================================================

/**
 * Create WebSocket connection for real-time sync progress
 */
export function connectToSyncProgress(
  jobId: string,
  onProgress: (event: SyncProgressEvent) => void,
  onError?: (error: Event) => void,
  onClose?: (event: CloseEvent) => void,
): WebSocket {
  const wsUrl =
    process.env.NEXT_PUBLIC_SEARCH_AI_WS_URL || 'ws://localhost:3005/api/admin/progress/subscribe';
  // NOTE: In production, WebSocket connections go through NGINX ingress which
  // rewrites /api/search-ai/* → /api/*. The NEXT_PUBLIC_SEARCH_AI_WS_URL env var
  // should be left unset — the hooks in useCrawlProgress/useIntelligenceProgress
  // use same-origin URLs with the /api/search-ai/ prefix instead of this function.
  // This function is only used in local dev where the WS URL points directly at
  // the backend (no prefix stripping needed).
  const url = `${wsUrl}?jobId=${encodeURIComponent(jobId)}&type=connector-sync`;

  const ws = new WebSocket(url);

  ws.onmessage = (event) => {
    try {
      const data = JSON.parse(event.data) as SyncProgressEvent;
      onProgress(data);
    } catch (error) {
      console.error('[SyncProgress] Failed to parse WebSocket message:', error);
    }
  };

  ws.onerror = (event) => {
    console.error('[SyncProgress] WebSocket error:', event);
    if (onError) onError(event);
  };

  ws.onclose = (event) => {
    console.log('[SyncProgress] WebSocket closed:', event.code, event.reason);
    if (onClose) onClose(event);
  };

  return ws;
}
