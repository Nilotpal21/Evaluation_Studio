/**
 * Discovery API Client
 *
 * Functions for BFS site discovery: start, stream SSE progress,
 * explore branches, stop, retrieve tree, select URLs, and domain lookup.
 */

import { apiFetch, authHeaders, handleResponse } from '../lib/api-client';

// =============================================================================
// CONSTANTS
// =============================================================================

const SEARCH_AI_URL = process.env.NEXT_PUBLIC_SEARCH_AI_URL ?? '';

// =============================================================================
// TYPES
// =============================================================================

export interface DiscoverySeed {
  type: 'nav-section' | 'target-url';
  url: string;
  label?: string;
}

export interface StartDiscoveryRequest {
  primaryUrl: string;
  sampleUrls?: string[];
  seeds: DiscoverySeed[];
  maxDepth?: number;
  sourceId?: string;
}

export interface StartDiscoveryResponse {
  discoveryId: string;
  tenantDiscoveryId: string;
  domain: string;
  streamUrl: string;
}

export interface DiscoverMoreRequest {
  type: 'explore-branch' | 'explore-all';
  url: string;
}

export interface SelectUrlsRequest {
  selectedUrls: string[];
  selectionPatterns?: string[];
}

// ---------------------------------------------------------------------------
// BFS SSE Event Types (discriminated union)
// ---------------------------------------------------------------------------

export interface BfsPhaseEvent {
  type: 'phase';
  phase: 0 | '1a' | '1b' | 2 | 3;
  label: string;
  timestamp: number;
}

export interface BfsPageVisitEvent {
  type: 'page-visit';
  url: string;
  status: 'visiting' | 'visited' | 'error';
  linksFound: number;
  newLinksFound: number;
  pageRole?: 'hub' | 'leaf' | 'mixed';
  renderMethod?: 'http' | 'browser' | 'unknown';
  errorMessage?: string;
  timestamp: number;
}

export interface BfsUrlDiscoveredEvent {
  type: 'url-discovered';
  url: string;
  foundOn: string;
  timestamp: number;
}

/** @deprecated Removed from SSE union — kept for type reference only */
export interface BfsTreeUpdateEvent {
  type: 'tree-update';
  totalUrls: number;
  totalVisited: number;
  newNodes: Array<{
    url: string;
    label: string;
    parentUrl: string | null;
    depth: number;
  }>;
  timestamp: number;
}

export interface BfsTreeSnapshotEvent {
  type: 'tree-snapshot';
  tree: Array<{
    url: string;
    label: string;
    children: BfsTreeSnapshotEvent['tree'];
    depth: number;
    visited: boolean;
    renderMethod: 'http' | 'browser' | 'unknown';
    pageRole?: 'hub' | 'leaf' | 'mixed';
    status: 'discovered' | 'visiting' | 'visited' | 'error';
  }>;
  discoveredPages?: Array<[string, unknown]>;
  totalUrls: number;
  totalVisited: number;
  timestamp: number;
}

export interface BfsProgressCounterEvent {
  type: 'progress';
  totalUrls: number;
  totalVisited: number;
  timestamp: number;
}

export interface BfsActivityEvent {
  type: 'activity';
  message: string;
  level: 'info' | 'warn' | 'detail';
  timestamp: number;
}

export interface BfsCompleteEvent {
  type: 'complete';
  totalUrls: number;
  totalVisited: number;
  totalPhasesRun: number;
  durationMs: number;
  stoppedBy: 'exhausted' | 'user-stop' | 'yield-limit' | 'url-cap' | 'timeout';
  tree?: BfsTreeSnapshotEvent['tree'];
  timestamp: number;
}

export interface BfsErrorEvent {
  type: 'error';
  message: string;
  phase?: string;
  timestamp: number;
}

export type BfsSSEEvent =
  | BfsPhaseEvent
  | BfsTreeSnapshotEvent
  | BfsProgressCounterEvent
  | BfsActivityEvent
  | BfsCompleteEvent
  | BfsErrorEvent;

// ---------------------------------------------------------------------------
// Tree response types
// ---------------------------------------------------------------------------

export interface BfsDiscoveredPage {
  url: string;
  title: string;
  depth: number;
  foundOn: string;
  renderMethod?: 'http' | 'browser' | 'unknown';
  visited: boolean;
}

export interface BfsTreeNode {
  url: string;
  label: string;
  parentUrl: string | null;
  depth: number;
  children: BfsTreeNode[];
  pageCount: number;
  visited: boolean;
}

export interface DiscoveryTreeResponse {
  discoveryId: string;
  domain: string;
  status: string;
  tree: BfsTreeNode[];
  pages: BfsDiscoveredPage[];
  totalUrls: number;
  totalVisited: number;
}

// =============================================================================
// HELPERS
// =============================================================================

/** Build a discovery API path with the /api/search-ai/ prefix for routing. */
function discoveryUrl(path: string): string {
  return `/api/search-ai/crawl/discovery${path}`;
}

/**
 * Build an SSE stream URL for EventSource.
 *
 * EventSource cannot set custom headers, so auth token and tenantId
 * are passed as query parameters. In dev mode, the URL points directly
 * at the SearchAI service; in production it uses the relative path
 * routed through NGINX ingress.
 */
export function sseStreamUrl(discoveryId: string): string {
  const headers = authHeaders() as Record<string, string>;
  const token = headers['Authorization']?.replace('Bearer ', '') ?? '';
  const tenantId = headers['X-Tenant-Id'] ?? '';

  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (tenantId) params.set('tenantId', tenantId);

  const queryString = params.toString();
  const suffix = queryString ? `?${queryString}` : '';

  if (SEARCH_AI_URL) {
    // Local dev: direct URL to SearchAI service
    return `${SEARCH_AI_URL}/api/crawl/discovery/${discoveryId}/stream${suffix}`;
  }

  // Production: relative URL through NGINX ingress
  return `/api/search-ai/crawl/discovery/${discoveryId}/stream${suffix}`;
}

// =============================================================================
// API FUNCTIONS
// =============================================================================

/** Start a new BFS discovery session. */
export async function startDiscovery(req: StartDiscoveryRequest): Promise<StartDiscoveryResponse> {
  const res = await apiFetch(discoveryUrl('/start'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  const envelope = await handleResponse<{
    success: boolean;
    data: StartDiscoveryResponse;
  }>(res);
  return envelope.data;
}

/** Connect to a discovery SSE stream. Returns an EventSource instance. */
export function connectDiscoveryStream(discoveryId: string): EventSource {
  return new EventSource(sseStreamUrl(discoveryId));
}

/** Request further exploration of a branch or all unexplored nodes. */
export async function discoverMore(discoveryId: string, req: DiscoverMoreRequest): Promise<void> {
  const res = await apiFetch(discoveryUrl(`/${discoveryId}/discover-more`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  await handleResponse<{ success: boolean }>(res);
}

/** Stop an active discovery session. */
export async function stopDiscovery(discoveryId: string): Promise<void> {
  const res = await apiFetch(discoveryUrl(`/${discoveryId}/stop`), {
    method: 'POST',
  });
  await handleResponse<{ success: boolean }>(res);
}

/** Retrieve the full discovery tree and pages for a completed discovery. */
export async function getDiscoveryTree(discoveryId: string): Promise<DiscoveryTreeResponse> {
  const res = await apiFetch(discoveryUrl(`/${discoveryId}/tree`));
  const envelope = await handleResponse<{
    success: boolean;
    data: DiscoveryTreeResponse;
  }>(res);
  return envelope.data;
}

/** Finalize URL selection from a discovery session. */
export async function selectDiscoveryUrls(
  discoveryId: string,
  req: SelectUrlsRequest,
): Promise<void> {
  const res = await apiFetch(discoveryUrl(`/${discoveryId}/select`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(req),
  });
  await handleResponse<{ success: boolean }>(res);
}

/** Look up the most recent discovery for a given domain. */
export async function getDiscoveryByDomain(domain: string): Promise<DiscoveryTreeResponse | null> {
  const res = await apiFetch(discoveryUrl(`/domain/${encodeURIComponent(domain)}`));
  if (res.status === 404) return null;
  const envelope = await handleResponse<{
    success: boolean;
    data: DiscoveryTreeResponse;
  }>(res);
  return envelope.data;
}
