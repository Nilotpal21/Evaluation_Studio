/**
 * Web Crawler API Client
 *
 * Functions for web crawling, job tracking, and user preferences.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES
// =============================================================================

export interface CrawlFilters {
  includePaths?: string[];
  excludePaths?: string[];
  contentKeywords?: string[];
}

export interface PreviewUrlEntry {
  url: string;
  lastmod?: string;
  priority?: number;
}

export interface PreviewUrlsResponse {
  success: boolean;
  urls: PreviewUrlEntry[];
  source: 'sitemap' | 'none';
  total: number;
}

/** A single step in the sitemap discovery process (from profiler) */
export interface SitemapDiscoveryStep {
  source: 'default' | 'robots.txt' | 'user-provided';
  url: string;
  status: 'found' | 'not_found' | 'error';
  urlCount?: number;
  type?: 'sitemap' | 'index';
}

/** A resolved sitemap file summary (from profiler) */
export interface SitemapFileSummary {
  url: string;
  origin: 'default' | 'robots.txt' | 'index' | 'user-provided';
  parentUrl?: string;
  urlCount: number;
}

/** Sitemap discovery result returned by the profile endpoint */
export interface SitemapDiscovery {
  steps: SitemapDiscoveryStep[];
  sitemapFiles: SitemapFileSummary[];
  totalUrls: number;
  /** All discovered sitemap URLs — pass to cluster-urls to avoid re-fetching */
  allUrls?: string[];
}

export interface ProfileResponse {
  success: boolean;
  domain: string;
  siteType: string;
  estimatedSize: number;
  hasSitemap: boolean;
  jsRequired: boolean;
  avgResponseTime: number;
  recommendedStrategy?: 'browser' | 'bulk' | 'hybrid';
  recommendationReasoning?: string;
  recommendationConfidence?: number;
  estimatedDuration?: {
    min: number;
    max: number;
    unit: 'seconds' | 'minutes';
    formatted: string;
  };
  metadata: {
    title: string;
    description: string;
    favicon: string;
  };
  platform?: string; // V6 — detected platform (e.g. "wordpress", "shopify")
  discoveryMethod?: string; // V6 — how URLs were discovered
  platformCategory?: string; // V8 — platform category for cluster-urls
  apiEndpoints?: string[]; // V8 — discovered API endpoints (relative paths)
  /** Sitemap discovery trail — which sitemaps were checked and found */
  sitemapDiscovery?: SitemapDiscovery;
}

export interface CrawlJob {
  _id: string;
  tenantId: string;
  userId?: string;
  status: 'queued' | 'crawling' | 'ingesting' | 'indexing' | 'completed' | 'failed' | 'cancelled';
  strategy: 'browser' | 'bulk' | 'hybrid' | 'single-page' | 'sitemap' | 'smart' | 'intelligence';
  urls: {
    original: string[];
    expanded: string[];
    crawled: number;
    failed: number;
    blocked?: number; // V6 — pages excluded by quality filter
    unchanged?: number; // Recrawl: pages skipped because content hash matched
  };
  timeline: {
    submittedAt: string;
    startedAt?: string;
    completedAt?: string;
  };
  results: {
    documentsCreated: number;
    documentsIndexed: number;
    documentsFailed: number;
    chunksCreated: number;
  };
  indexId?: string;
  sourceId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CrawlHistoryResponse {
  success: boolean;
  jobs: CrawlJob[];
  cursor: string | null;
  hasMore: boolean;
}

export interface BatchSubmitResponse {
  success: boolean;
  needsUserInput: boolean;
  jobId?: string;
  pendingId?: string;
  questions?: Array<{
    id: string;
    text: string;
    options: Array<{
      value: string;
      label: string;
      description: string;
    }>;
  }>;
}

export interface DashboardResponse {
  success: boolean;
  jobId: string;
  phase:
    | 'queued'
    | 'crawling'
    | 'ingesting'
    | 'extracting'
    | 'enriching'
    | 'embedding'
    | 'indexing'
    | 'indexed'
    | 'completed'
    | 'failed'
    | 'cancelled';
  crawl: {
    urlsCrawled: number;
    urlsFailed: number;
    totalUrls: number;
    progress: number;
    errorBreakdown?: Array<{ type: string; count: number }>;
  };
  ingestion: {
    documentsCreated: number;
    documentsFailed: number;
    documentsIndexed: number;
    progress: number;
    qualityDistribution?: Record<string, number>;
  };
  extraction: {
    chunksCreated: number;
    progress: number;
  };
  embedding: {
    chunksEmbedded: number;
    progress: number;
  };
  indexing: {
    chunksIndexed: number;
    progress: number;
  };
  timeline?: {
    submitted: number | null;
    started: number | null;
    completed: number | null;
    duration: number | null;
  };
}

export interface UserCrawlPreference {
  _id: string;
  tenantId: string;
  userId: string;
  domainPattern: string;
  strategy: 'browser' | 'bulk' | 'hybrid';
  autoDecide: boolean;
  batchSize?: number;
  concurrency?: number;
  useCount: number;
  lastUsed: string;
}

export type CrawlErrorType =
  | 'http_4xx'
  | 'http_5xx'
  | 'connection_error'
  | 'timeout'
  | 'robots_blocked'
  | 'quality_gated'
  | 'content_filtered'
  | 'ssrf_blocked'
  | 'crawl_error';

export interface CrawlErrorEntry {
  url: string;
  type: CrawlErrorType;
  error: string;
  statusCode?: number;
  timestamp: string;
}

export interface CrawledPage {
  url: string;
  status: string;
  documentId: string;
  chunks: number;
  crawledAt: string;
  error?: string;
  handlerReused?: boolean;
  quality?: 'rich' | 'standard' | 'thin';
  qualityScore?: number;
  method?: 'http' | 'playwright';
  blockReason?: string;
}

/** Unwrapped data from GET /api/crawl/pages/:jobId (backend wraps in { success, data }) */
export interface CrawledPagesResponse {
  pages: CrawledPage[];
  crawlErrors: CrawlErrorEntry[];
  totalFailed: number;
  totalBlocked: number;
  totalErrors: number;
  pagination: { total: number; offset: number; limit: number; hasMore: boolean };
  errorPagination: { total: number; offset: number; limit: number; hasMore: boolean };
}

// =============================================================================
// URL HELPER
// =============================================================================

function crawlUrl(path: string): string {
  return `/api/search-ai/crawl${path}`;
}

// =============================================================================
// CRAWLER API
// =============================================================================

// =============================================================================
// ROBOTS.TXT ANALYSIS
// =============================================================================

/** Result of analyzing a site's robots.txt */
export interface RobotsTxtAnalysisResult {
  found: boolean;
  crawlDelay: number | null;
  disallowedPaths: string[];
  sitemapUrls: string[];
  userAgent: string;
  rawContent?: string;
}

/**
 * Analyze a site's robots.txt for crawl constraints.
 */
export async function analyzeRobotsTxt(url: string): Promise<RobotsTxtAnalysisResult> {
  const response = await apiFetch(crawlUrl('/robots'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  const result = await handleResponse<{
    success: boolean;
    data: RobotsTxtAnalysisResult;
  }>(response);
  return result.data;
}

// =============================================================================
// SITE PROFILING
// =============================================================================

/**
 * Profile a website to analyze its structure and characteristics
 */
export async function profileSite(url: string): Promise<ProfileResponse> {
  const response = await apiFetch(crawlUrl('/profile'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return handleResponse(response);
}

/**
 * Submit a batch crawl job
 */
export interface SectionMappingEntry {
  sectionId: string;
  pattern: string;
  name: string;
  urls: string[];
  strategy?: 'http' | 'browser';
}

export async function submitBatchCrawl(data: {
  urls: string[];
  indexId: string;
  sourceId: string;
  strategy?: string;
  limits?: { maxPages?: number; maxDepth?: number };
  filters?: CrawlFilters;
  sectionMapping?: SectionMappingEntry[];
  options?: Record<string, unknown>;
  crawlSettings?: {
    crawlDelay: number;
    respectRobotsTxt: boolean;
    cleanupLevel: 'standard' | 'aggressive' | 'none';
    deduplicate: boolean;
    cookieConsent: boolean;
    reuseHandlers: boolean;
    forceReprocess?: boolean;
  };
}): Promise<BatchSubmitResponse> {
  const response = await apiFetch(crawlUrl('/batch'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Recrawl a source using stored backend configuration.
 *
 * The backend reads all config (URLs, strategy, settings, sections) from
 * SearchSource.crawlConfig + latest CrawlJob. Frontend only sends the IDs.
 */
export async function recrawlSource(data: {
  sourceId: string;
  indexId: string;
  forceReprocess?: boolean;
}): Promise<BatchSubmitResponse> {
  const response = await apiFetch(crawlUrl('/recrawl'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Preview URLs discovered from a site's sitemap
 */
export async function previewUrls(url: string, limit = 500): Promise<PreviewUrlsResponse> {
  const params = new URLSearchParams({ url, limit: limit.toString() });
  const response = await apiFetch(crawlUrl(`/preview-urls?${params.toString()}`));
  return handleResponse(response);
}

/**
 * Respond to crawl configuration questions
 */
export async function respondToQuestions(
  pendingId: string,
  responses: Array<{ questionId: string; value: string }>,
): Promise<BatchSubmitResponse> {
  const response = await apiFetch(crawlUrl('/batch/respond'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pendingId, responses }),
  });
  return handleResponse(response);
}

/**
 * Get crawl job status
 */
export async function getCrawlStatus(jobId: string): Promise<{
  success: boolean;
  jobId: string;
  state: string;
  progress: number | object;
  urls: number;
  crawled?: number;
  failed?: number;
}> {
  const response = await apiFetch(crawlUrl(`/status?jobId=${jobId}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Get comprehensive crawl job dashboard
 */
export async function getCrawlDashboard(jobId: string): Promise<DashboardResponse> {
  const response = await apiFetch(crawlUrl(`/dashboard/${jobId}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Get crawl job history with cursor pagination
 */
export async function getCrawlHistory(
  indexId: string,
  limit = 20,
  cursor?: string,
): Promise<CrawlHistoryResponse> {
  const params = new URLSearchParams({ indexId, limit: limit.toString() });
  if (cursor) params.append('cursor', cursor);

  const response = await apiFetch(crawlUrl(`/history?${params.toString()}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Get crawled pages for a job
 */
export async function getCrawledPages(
  jobId: string,
  options?: {
    limit?: number;
    offset?: number;
    status?: 'all' | 'indexed' | 'processing' | 'error';
    search?: string;
    errorLimit?: number;
    errorOffset?: number;
    errorType?: string;
  },
): Promise<CrawledPagesResponse> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.append('limit', options.limit.toString());
  if (options?.offset != null) params.append('offset', options.offset.toString());
  if (options?.status) params.append('status', options.status);
  if (options?.search) params.append('search', options.search);
  if (options?.errorLimit != null) params.append('errorLimit', options.errorLimit.toString());
  if (options?.errorOffset != null) params.append('errorOffset', options.errorOffset.toString());
  if (options?.errorType) params.append('errorType', options.errorType);

  const queryString = params.toString();
  const url = crawlUrl(`/pages/${jobId}${queryString ? `?${queryString}` : ''}`);

  const response = await apiFetch(url, {
    headers: { 'Content-Type': 'application/json' },
  });
  const result = await handleResponse<{ success: boolean; data: CrawledPagesResponse }>(response);
  return result.data;
}

/**
 * Get user's saved crawl preferences
 */
export async function getCrawlPreferences(): Promise<{
  success: boolean;
  preferences: UserCrawlPreference[];
}> {
  const response = await apiFetch(crawlUrl('/preferences'), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Create or update a crawl preference
 */
export async function saveCrawlPreference(data: {
  domainPattern: string;
  strategy: 'browser' | 'bulk' | 'hybrid';
  autoDecide?: boolean;
  batchSize?: number;
  concurrency?: number;
}): Promise<{ success: boolean; preference: UserCrawlPreference }> {
  const response = await apiFetch(crawlUrl('/preferences'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Delete a saved crawl preference
 */
export async function deleteCrawlPreference(id: string): Promise<{ success: boolean }> {
  const response = await apiFetch(crawlUrl(`/preferences/${id}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Cancel a running crawl job
 */
export async function cancelCrawlJob(jobId: string): Promise<{ success: boolean }> {
  const response = await apiFetch(crawlUrl(`/jobs/${jobId}/cancel`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Delete a crawl job and all associated documents/chunks
 */
export async function deleteCrawlJob(
  jobId: string,
): Promise<{ success: boolean; deleted?: { documents: number; chunks: number } }> {
  const response = await apiFetch(crawlUrl(`/jobs/${jobId}`), {
    method: 'DELETE',
  });
  return handleResponse(response);
}

/**
 * Delete all crawled pages for a job (keeps the job record)
 */
export async function deleteAllCrawledPages(
  jobId: string,
): Promise<{ success: boolean; deleted?: { documents: number; chunks: number } }> {
  const response = await apiFetch(crawlUrl(`/jobs/${jobId}/pages`), {
    method: 'DELETE',
  });
  return handleResponse(response);
}

/**
 * Delete a single crawled page (document) by ID
 */
export async function deleteCrawledPage(indexId: string, documentId: string): Promise<void> {
  const response = await apiFetch(`/api/search-ai/indexes/${indexId}/documents/${documentId}`, {
    method: 'DELETE',
  });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ error: 'Failed to delete page' }));
    throw new Error((data as Record<string, string>).error || `Delete failed: ${response.status}`);
  }
}

// =============================================================================
// INTELLIGENCE ANALYSIS
// =============================================================================

/** UI-facing analysis result (mirrors @abl/crawler IntelligenceAnalysisResult) */
export interface IntelligenceAnalysisResult {
  title?: string;
  body: string;
  bodyLength: number;
  quality: 'rich' | 'standard' | 'thin';
  handler: { steps: number; urlPattern: string };
  llmCallCount: number;
  totalTokens: number;
}

export interface SaveToKBRequest {
  jobId: string;
  indexId: string;
  name?: string;
}

export interface SaveToKBResponse {
  success: boolean;
  data?: { sourceId: string; documentId: string };
  error?: { code: string; message: string };
}

export interface IntelligenceAnalyzeRequest {
  url: string;
  intent?: string;
  indexId: string;
}

export interface IntelligenceAnalyzeResponse {
  success: boolean;
  jobId?: string;
  error?: { code: string; message: string };
}

/**
 * Start an intelligence analysis job for a URL
 */
export async function startIntelligenceAnalysis(
  data: IntelligenceAnalyzeRequest,
): Promise<IntelligenceAnalyzeResponse> {
  const response = await apiFetch(crawlUrl('/intelligence/analyze'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse<IntelligenceAnalyzeResponse>(response);
}

/** Response shape for the intelligence status polling endpoint */
export interface IntelligenceStatusResponse {
  success: boolean;
  data: {
    status: 'pending' | 'running' | 'completed' | 'failed';
    result?: IntelligenceAnalysisResult;
  };
}

/**
 * Poll for intelligence analysis job status (HTTP fallback for WebSocket)
 */
export async function getIntelligenceStatus(jobId: string): Promise<IntelligenceStatusResponse> {
  const response = await apiFetch(crawlUrl(`/intelligence/status/${jobId}`));
  return handleResponse<IntelligenceStatusResponse>(response);
}

/**
 * Save intelligence analysis results to a knowledge base
 */
export async function saveToKnowledgeBase(data: SaveToKBRequest): Promise<SaveToKBResponse> {
  const response = await apiFetch(crawlUrl('/intelligence/save'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse<SaveToKBResponse>(response);
}

// =============================================================================
// EXTRACTION PREVIEW
// =============================================================================

export interface PreviewResponse {
  success: boolean;
  data: {
    url: string;
    title: string;
    excerpt: string;
    cleanedHtml: string;
    wordCount: number;
    imageCount: number;
    metadata: {
      contentLength: number;
      textContentLength: number;
      sizeReduction: number;
      originalSize: number;
      cleanedSize: number;
    };
    jsRenderingAdvised: boolean;
  };
}

/**
 * Preview extraction results for a single URL.
 * Used in Step 3 to let users inspect extraction quality before crawling.
 */
export async function previewExtraction(
  url: string,
  baseUrl: string,
): Promise<PreviewResponse['data']> {
  const response = await apiFetch(crawlUrl('/preview'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, baseUrl }),
  });
  const result = await handleResponse<PreviewResponse>(response);
  return result.data;
}

// =============================================================================
// SOURCE-BASED CRAWL CONFIG & DISCOVERY STATE (Draft Elimination)
// =============================================================================

/**
 * Helper to build source-scoped URLs under the search-ai engine.
 */
function sourceUrl(indexId: string, sourceId: string, path = ''): string {
  return `/api/search-ai/indexes/${indexId}/sources/${sourceId}${path}`;
}

/**
 * Update crawl config on a source (OCC via configVersion).
 * Maps to PATCH /:indexId/sources/:sourceId/crawl-config
 */
export async function updateCrawlConfig(
  indexId: string,
  sourceId: string,
  data: {
    configVersion: number;
    wizardStep?: string | null;
    strategy?: string | null;
    profile?: Record<string, unknown> | null;
    sections?: Array<Record<string, unknown>>;
    settings?: Record<string, unknown> | null;
    auth?: Record<string, unknown> | null;
    groupStrategies?: Array<Record<string, unknown>>;
    crawlJobId?: string | null;
  },
): Promise<{ success: boolean; source: Record<string, unknown> }> {
  const response = await apiFetch(sourceUrl(indexId, sourceId, '/crawl-config'), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Get discovery state for a source (from SourceConfigState).
 * Maps to GET /:indexId/sources/:sourceId/discovery-state
 */
export async function getDiscoveryState(
  indexId: string,
  sourceId: string,
): Promise<{
  success: boolean;
  data: {
    discoveryState: Record<string, unknown> | null;
    discoveryStatus: string;
  };
}> {
  const response = await apiFetch(sourceUrl(indexId, sourceId, '/discovery-state'));
  return handleResponse(response);
}

/**
 * Save/update discovery state for a source (upserts SourceConfigState).
 * Maps to PUT /:indexId/sources/:sourceId/discovery-state
 */
export async function updateDiscoveryState(
  indexId: string,
  sourceId: string,
  data: {
    discoveryState: Record<string, unknown>;
    discoveryStatus?: 'idle' | 'running' | 'complete' | 'stopped';
  },
): Promise<{ success: boolean }> {
  const response = await apiFetch(sourceUrl(indexId, sourceId, '/discovery-state'), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Bulk-write URLs for a source section (replaces existing).
 * Maps to PUT /:indexId/sources/:sourceId/sections/:sectionId/urls
 */
export async function putSourceSectionUrls(
  indexId: string,
  sourceId: string,
  sectionId: string,
  urls: BucketUrl[],
): Promise<{ success: boolean; data: { urlCount: number; buckets: number } }> {
  const response = await apiFetch(sourceUrl(indexId, sourceId, `/sections/${sectionId}/urls`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ urls }),
  });
  return handleResponse(response);
}

/**
 * Fetch paginated URLs for a source section.
 * Maps to GET /:indexId/sources/:sourceId/sections/:sectionId/urls
 */
export async function getSourceSectionUrls(
  indexId: string,
  sourceId: string,
  sectionId: string,
  options?: { offset?: number; limit?: number },
): Promise<{
  success: boolean;
  data: {
    urls: BucketUrl[];
    pagination: { offset: number; limit: number; total: number };
  };
}> {
  const params = new URLSearchParams();
  if (options?.offset != null) params.set('offset', String(options.offset));
  if (options?.limit != null) params.set('limit', String(options.limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const response = await apiFetch(sourceUrl(indexId, sourceId, `/sections/${sectionId}/urls${qs}`));
  return handleResponse(response);
}

// =============================================================================
// V6 — URL clustering + group strategies
// =============================================================================

export interface UrlGroup {
  pattern: string;
  count: number;
  examples: string[];
  depth: number;
  /** Sitemap file this group's URLs came from (set by cluster endpoint) */
  sitemapFile?: string;
  /** How the sitemap was discovered: default /sitemap.xml, robots.txt, or sitemap index */
  sitemapOrigin?: 'default' | 'robots.txt' | 'index';
}

export interface GroupStrategy {
  pattern: string;
  method: 'http' | 'playwright';
  llmEstimate: number;
  reason: string;
  count?: number;
}

/** Response from POST /validate-sitemap */
export interface ValidateSitemapResponse {
  success: boolean;
  valid: boolean;
  urlCount: number;
  sitemapFiles?: SitemapFileSummary[];
  type?: 'sitemap' | 'index';
  error?: 'timeout' | 'unreachable' | 'invalid' | 'no_urls';
  message?: string;
}

/**
 * Cluster discovered URLs into groups by URL pattern.
 * If `urls` is provided, clusters those directly (used by browser discovery).
 * Otherwise fetches sitemap from the URL.
 */
export async function clusterUrls(
  url: string,
  options?: {
    platform?: string;
    apiEndpoints?: string[];
    urls?: string[];
    sampleUrls?: string[];
    sourceId?: string;
    /** User-provided sitemap URL — backend will fetch and include its URLs in discovery */
    customSitemapUrl?: string;
  },
): Promise<{
  success: boolean;
  groups: (UrlGroup & { scoreTier?: string; avgScore?: number })[];
  ungrouped?: string[];
  stats?: { totalUrls: number; groupedUrls: number; groupCount: number };
}> {
  const body: Record<string, unknown> = { url };
  if (options?.platform) body.platform = options.platform;
  if (options?.apiEndpoints && options.apiEndpoints.length > 0) {
    body.apiEndpoints = options.apiEndpoints;
  }
  if (options?.urls && options.urls.length > 0) {
    body.sitemapUrls = options.urls;
  }
  if (options?.sampleUrls && options.sampleUrls.length > 0) {
    body.sampleUrls = options.sampleUrls;
  }
  if (options?.sourceId) {
    body.sourceId = options.sourceId;
  }
  if (options?.customSitemapUrl) {
    body.customSitemapUrl = options.customSitemapUrl;
  }
  const response = await apiFetch(crawlUrl('/cluster-urls'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return handleResponse(response);
}

/**
 * Validate a user-provided sitemap URL.
 * Returns validity, URL count, sitemap file summaries, and error classification.
 */
export async function validateSitemap(url: string): Promise<ValidateSitemapResponse> {
  const response = await apiFetch(crawlUrl('/validate-sitemap'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url }),
  });
  return handleResponse(response);
}

/**
 * Sample URL groups and determine optimal crawl strategy per group
 */
// TODO: Remove truncation after pagination support is added to sample-groups.
// With pagination, groups will be sampled in batches instead of all-at-once.
const SAMPLE_GROUPS_MAX = 200;

export async function sampleGroups(
  groups: UrlGroup[],
): Promise<{ success: boolean; strategies: GroupStrategy[] }> {
  // Truncate to backend limit; excess groups default to 'http' strategy
  const sampled = groups.slice(0, SAMPLE_GROUPS_MAX);
  const response = await apiFetch(crawlUrl('/sample-groups'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ groups: sampled }),
  });
  const result: { success: boolean; strategies: GroupStrategy[] } = await handleResponse(response);

  // Fill in default strategies for any groups beyond the limit
  if (groups.length > SAMPLE_GROUPS_MAX) {
    const sampledPatterns = new Set(result.strategies.map((s) => s.pattern));
    for (const g of groups.slice(SAMPLE_GROUPS_MAX)) {
      if (!sampledPatterns.has(g.pattern)) {
        result.strategies.push({
          pattern: g.pattern,
          method: 'http',
          llmEstimate: 0,
          reason: 'default',
        });
      }
    }
  }

  return result;
}

// =============================================================================
// CRAWL-SITE (V5 — multi-page intelligence crawl)
// =============================================================================

export interface CrawlSiteRequest {
  url: string;
  indexId: string;
  sourceId?: string;
  intent?: string;
  limits?: { maxPages?: number; maxDepth?: number; maxLlmCalls?: number };
  filters?: { includePaths?: string[]; excludePaths?: string[] };
  discovery?: { useSitemap?: boolean; followLinks?: boolean };
  groupStrategies?: GroupStrategy[]; // V6 — pre-computed group strategies
}

export interface CrawlSiteResponse {
  success: boolean;
  jobId?: string;
  sourceId?: string;
  status?: 'queued' | 'crawling' | 'ingesting' | 'indexing' | 'completed' | 'failed' | 'cancelled';
  discovery?: { source: 'sitemap' | 'entry-only'; urlCount: number; sitemapUrls: number };
  estimatedLlmCalls?: number;
  error?: { code: string; message: string };
}

export interface CrawlSiteStatusResponse {
  success: boolean;
  jobId: string;
  summary: {
    totalPages: number;
    discovered: number;
    completed: number;
    inProgress: number;
    failed: number;
    reused: number;
    llmCallsTotal: number;
    llmCallsRemaining: number;
    tokensTotal: number;
    estimatedCostUsd: number;
  };
  pages: CrawlSitePage[];
  pagination: { limit: number; offset: number; hasMore: boolean };
}

export interface CrawlSitePage {
  url: string;
  status: 'queued' | 'analyzing' | 'reused' | 'completed' | 'failed' | 'saved';
  handlerReused: boolean;
  llmCalls: number;
  title?: string;
  quality?: 'rich' | 'standard' | 'thin';
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

/**
 * Start a multi-page intelligence crawl-site job
 */
export async function startCrawlSite(data: CrawlSiteRequest): Promise<CrawlSiteResponse> {
  const response = await apiFetch(crawlUrl('/intelligence/crawl-site'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse<CrawlSiteResponse>(response);
}

/**
 * Get crawl-site job status with page-level details
 */
export async function getCrawlSiteStatus(
  jobId: string,
  options?: { limit?: number; offset?: number; status?: string },
): Promise<CrawlSiteStatusResponse> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  if (options?.status) params.set('status', options.status);
  const qs = params.toString() ? `?${params.toString()}` : '';
  const response = await apiFetch(crawlUrl(`/intelligence/crawl-site/${jobId}${qs}`));
  return handleResponse<CrawlSiteStatusResponse>(response);
}

// =============================================================================
// LEGACY TYPES — kept for conversion helpers in CrawlFlowV5
// =============================================================================

/** @deprecated Use CrawlConfigSection from search-ai.ts instead */
export interface CrawlDraftSection {
  sectionId: string;
  pattern: string;
  name: string;
  source: 'sitemap' | 'explored' | 'auto' | 'direct';
  depth: number;
  pageCount: number;
  included: boolean;
  estimatedTime: number;
  warnings: string[];
  strategy?: 'http' | 'browser';
  /** Sitemap file this section came from */
  sitemapFile?: string;
  /** How the sitemap was discovered */
  sitemapOrigin?: 'default' | 'robots.txt' | 'index' | 'user-provided';
}

export interface BucketUrl {
  url: string;
  title: string | null;
  score: number | null;
  depth: number;
}
