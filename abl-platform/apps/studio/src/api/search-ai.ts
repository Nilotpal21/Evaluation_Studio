/**
 * SearchAI API Client
 *
 * Functions for search index management, schema/mapping CRUD,
 * and query execution against the SearchAI and SearchAI Runtime services.
 */

import { apiFetch, handleResponse } from '../lib/api-client';

// =============================================================================
// TYPES (frontend-only — no SDK import into browser bundle)
// =============================================================================

export interface AnalyzeResponseColumn {
  name: string;
  type: string;
  isEmbeddable: boolean;
  isFilterable: boolean;
  confidence: number;
  sampleValues: unknown[];
}

export interface AnalyzeResponse {
  schema: {
    tableName: string;
    columns: AnalyzeResponseColumn[];
    rowCount: number;
    primaryKey: string | null;
  };
  quality: {
    overallConfidence: number;
    warnings: string[];
    recommendations: string[];
  };
  estimates: {
    embeddingTokens: number;
    embeddingCost: number;
    storageBytes: number;
    processingTimeSeconds: number;
  };
}

export interface TokenChunkStrategy {
  method: 'fixed' | 'semantic' | 'sliding_window';
  chunkSize: number;
  chunkOverlap: number;
  separator?: string;
}

export interface VectorStoreConfig {
  provider: string;
  collectionName: string;
  connectionConfig?: unknown;
}

export interface SearchAIDefaults {
  topK: number;
  similarityThreshold: number;
  includeMetadata: boolean;
  includeContent: boolean;
  reranker?: { provider: string; model?: string; topN?: number };
  responseFields?: string[];
}

export interface SearchAIIndex {
  _id: string;
  tenantId: string;
  projectId: string;
  slug: string;
  name: string;
  description: string | null;
  embeddingModel: string;
  embeddingDimensions: number;
  tokenChunkStrategy?: TokenChunkStrategy | null;
  vectorStore: VectorStoreConfig;
  searchDefaults: SearchAIDefaults;
  llmConfig?: {
    enabled?: boolean;
    useCases?: {
      knowledgeGraph?: {
        enabled?: boolean;
        modelTier?: string;
        modelId?: string | null;
        configuredAt?: string | null;
        inheritedFrom?: string | null;
        enableCoOccurrence?: boolean;
      };
      [key: string]: unknown;
    };
  } | null;
  status: string;
  documentCount: number;
  chunkCount: number;
  sourceCount: number;
  lastIndexedAt: string | null;
  indexError: string | null;
  citationConfig?: {
    enabled: boolean;
    linkMode: 'direct' | 'time_limited' | 'click_limited' | 'disabled';
    linkTtlSeconds: number;
    maxClicks: number;
  } | null;
  createdAt: string;
  updatedAt: string;
}

/** Crawl config profile — site characteristics from profiling */
export interface CrawlConfigProfile {
  domain: string;
  siteType: string;
  hasSitemap: boolean;
  jsRequired: boolean;
  estimatedSize: number;
  avgResponseTime: number;
  platform: string | null;
}

/** Crawl config section — a URL pattern group */
export interface CrawlConfigSection {
  sectionId: string;
  pattern: string;
  name: string;
  source: string;
  depth: number;
  pageCount: number;
  included: boolean;
  estimatedTime: number;
  warnings: string[];
  strategy?: string;
  sitemapFile?: string;
  sitemapOrigin?: string;
}

/** Crawl config settings — crawl behavior */
export interface CrawlConfigSettings {
  scope: string;
  rendering: string;
  maxPages: number;
  maxDepth: number;
  respectRobotsTxt: boolean;
  includePaths: string[];
  excludePaths: string[];
}

/** Crawl config auth — auth credentials for protected sites.
 *  Field names match AuthConfig from crawl-flow/types.ts (what the wizard saves). */
export interface CrawlConfigAuth {
  method: string | null;
  basicUsername: string | null;
  basicPassword: string | null;
  bearerToken: string | null;
  customHeaders: Array<{ key: string; value: string }> | null;
  cookieString: string | null;
}

/** Per-group crawl strategy */
export interface CrawlConfigGroupStrategy {
  pattern: string;
  method: string;
  llmEstimate: number;
  reason: string;
}

/** Typed crawl config subdocument on SearchSource */
export interface CrawlConfig {
  wizardStep: string | null;
  strategy: string | null;
  profile: CrawlConfigProfile | null;
  sections: CrawlConfigSection[];
  settings: CrawlConfigSettings | null;
  auth: CrawlConfigAuth | null;
  groupStrategies: CrawlConfigGroupStrategy[];
  crawlJobId: string | null;
  configVersion: number;
  configExpiresAt: string | null;
}

export interface SearchAISource {
  _id: string;
  tenantId: string;
  indexId: string;
  name: string;
  sourceType: string;
  sourceConfig: unknown;
  status: string;
  extractionConfig: unknown | null;
  enrichmentConfig: unknown | null;
  syncSchedule: string | null;
  documentCount: number;
  lastSyncAt: string | null;
  syncError: string | null;
  createdBy: string | null;
  crawlConfig: CrawlConfig | null;
  createdAt: string;
  updatedAt: string;
}

export interface UploadFieldHint {
  storageField: string;
  type: string;
  label: string;
  category: 'core' | 'common';
}

export interface UploadHintsResponse {
  recentFields: string[];
  lastValues: Record<string, string>;
  allFields: UploadFieldHint[];
}

export interface CanonicalField {
  /** Alias name — business-friendly identifier */
  name: string;
  /** Display label */
  label: string;
  /** Data type: string, number, float, date, boolean, text, array */
  type: string;
  /** Description for LLM context */
  description?: string;
  /** Actual vector store field path under metadata.canonical.* */
  storageField: string;
  /** Whether the underlying field is indexed */
  indexed: boolean;
  /** Exposed for filtering */
  filterable: boolean;
  /** Exposed for aggregation/grouping */
  aggregatable: boolean;
  /** Exposed for sorting */
  sortable: boolean;
  /** Display value → stored value mapping for enums */
  enumValues?: Record<string, unknown>;
  /** Original connector field path */
  sourceConnectorField?: string;
}

export interface AnalyzeResponse {
  schema: {
    tableName: string;
    rowCount: number;
    columns: Array<{
      name: string;
      type: string;
      confidence: number;
      isEmbeddable: boolean;
      isFilterable: boolean;
      sampleValues: unknown[];
    }>;
    primaryKey: string | null;
  };
  quality: {
    overallConfidence: number;
    warnings: string[];
    recommendations: string[];
  };
  estimates: {
    embeddingTokens: number;
    embeddingCost: number;
    storageBytes: number;
    processingTimeSeconds: number;
  };
}

export interface CanonicalSchemaData {
  _id: string;
  tenantId: string;
  knowledgeBaseId: string;
  version: number;
  fields: CanonicalField[];
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface FieldMappingTransform {
  type: string;
  valueMap?: Record<string, string>;
  expression?: string;
  sources?: string[];
  computeExpression?: string;
  sourceFormat?: string;
  delimiter?: string;
}

/**
 * FieldMapping status values as stored in MongoDB.
 * UI labels differ: 'active' = "confirmed/mapped", 'suggested' = "pending review".
 */
export const MAPPING_STATUS = {
  /** Confirmed/mapped — displayed as "My Fields" in the UI */
  CONFIRMED: 'active',
  /** Pending review — displayed as "Suggested Mappings" in the UI */
  SUGGESTED: 'suggested',
  /** Rejected by admin */
  REJECTED: 'rejected',
} as const;

export type MappingStatus = (typeof MAPPING_STATUS)[keyof typeof MAPPING_STATUS];

export interface FieldMappingData {
  _id: string;
  tenantId: string;
  canonicalSchemaId: string;
  canonicalField: string;
  connectorId: string;
  sourcePath: string;
  transform: FieldMappingTransform;
  confidence: number;
  status: MappingStatus | string;
  suggestedBy: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** Alias name from CanonicalSchema (enriched by backend) */
  aliasName?: string | null;
  /** Alias display label (enriched by backend) */
  aliasLabel?: string | null;
  /** Connector type (enriched by backend) */
  connectorType?: string | null;
}

export interface UnmappedField {
  path: string;
  label: string;
  type: string;
  isCustom: boolean;
  sampleValues?: unknown[];
  enumValues?: string[];
}

export interface UnmappedFieldsResponse {
  connectorId: string;
  totalFields: number;
  mappedCount: number;
  unmappedFields: UnmappedField[];
}

export interface MetadataFilter {
  field: string;
  operator: string;
  value: unknown;
}

export interface SearchAILatency {
  vocabularyResolveMs: number;
  vectorSearchMs: number;
  structuredFilterMs: number;
  rerankMs: number;
  totalMs: number;
  // Detailed component timing (from search-ai-runtime instrumentation)
  embeddingMs?: number;
  opensearchMs?: number;
  questionParentMs?: number;
  dslBuildMs?: number;
}

export interface SearchAIResult {
  documentId: string;
  chunkId: string;
  score: number;
  content?: string;
  metadata?: Record<string, unknown>;
  source?: {
    sourceId: string;
    sourceType: string;
    sourceName: string;
    reference?: string;
  };
}

export interface StructuredDataResult {
  tableId: string;
  tableName: string;
  rowNumber: number;
  rowData: Record<string, unknown>;
  score: number;
  matchedFields?: string[];
}

export interface StructuredDataResponse {
  intent: { type: string; confidence: number; reasoning: string };
  results: StructuredDataResult[];
  totalCount: number;
  sqlGenerated?: string;
  executionTimeMs: number;
}

export interface SearchAIQueryResult {
  queryId: string;
  results: SearchAIResult[];
  totalCount?: number;
  latency: SearchAILatency;
  vocabularyTrace?: VocabularyTrace;
  structuredData?: StructuredDataResponse;
  debugTrace?: {
    stages: Record<string, unknown>;
    totalDurationMs: number;
  };
}

export interface VocabularyTrace {
  originalQuery: string;
  resolvedTerms: Array<{
    inputTerm: string;
    matchedTerm: string;
    matchType: string;
    confidence: number;
    resolution: unknown;
  }>;
  unresolvedSegments: string[];
  structuredFilters: MetadataFilter[];
  aggregationSpec?: unknown;
}

export interface VocabularyResolutionResult {
  originalQuery: string;
  resolvedTerms: Array<{
    inputTerm: string;
    matchedTerm: string;
    matchType: string;
    confidence: number;
    resolution: unknown;
  }>;
  unresolvedSegments: string[];
  structuredFilters: MetadataFilter[];
  aggregationSpec?: unknown;
}

// ─── Knowledge Base Types ────────────────────────────────────────────────

export interface KnowledgeBase {
  _id: string;
  tenantId: string;
  projectId: string;
  name: string;
  description: string | null;
  status: string;
  searchIndexId: string | null;
  canonicalSchemaId: string | null;
  connectorCount: number;
  documentCount: number;
  lastIndexedAt: string | null;
  indexError: string | null;
  isPublic: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface KnowledgeBaseDetail extends KnowledgeBase {
  index: SearchAIIndex | null;
}

// ─── Connector Types ─────────────────────────────────────────────────────

export type ConnectorType = 'file' | 'web' | 'database' | 'api' | 'sharepoint';

// ─── Enterprise Connector Types ─────────────────────────────────────────

export type EnterpriseConnectorType = 'sharepoint';

export type DiscoveryMode = 'discover_only' | 'discover_and_profile' | 'quick_setup';

export type DiscoveryStatus = 'pending' | 'discovering' | 'profiling' | 'completed' | 'failed';

export type RecommendationStatus = 'pending' | 'generated' | 'accepted' | 'rejected' | 'expired';

export interface EnterpriseConnector {
  _id: string;
  tenantId: string;
  sourceId: string;
  connectorType: EnterpriseConnectorType;
  oauthTokenId: string | null;
  connectionConfig: {
    tenantUrl?: string;
    clientId?: string;
    scopes?: string[];
    tenantId?: string;
    rateLimit?: { maxRequests?: number; requestsPerSecond?: number };
    [key: string]: unknown;
  };
  syncState: {
    lastFullSyncAt: string | null;
    lastDeltaSyncAt: string | null;
    totalDocuments: number;
    processedDocuments: number;
    failedDocuments: number;
    syncInProgress: boolean;
    currentJobId: string | null;
    lastSyncError: string | null;
  };
  filterConfig: {
    standard: {
      contentCategories: string[];
      fileExtensions: { mode: 'allowlist' | 'denylist'; extensions: string[] } | null;
      maxFileSizeBytes: number | null;
      minFileSizeBytes: number | null;
      modifiedAfter: string | null;
      modifiedBefore: string | null;
      createdAfter: string | null;
      createdBefore: string | null;
    };
    scope: Record<string, unknown>;
    advancedFilters: {
      enabled: boolean;
      rootOperator: 'AND' | 'OR';
      conditions: Array<{
        field: string;
        operator: string;
        value: unknown;
        caseInsensitive?: boolean;
      }>;
      groups: Array<{
        operator: 'AND' | 'OR';
        conditions: Array<{
          field: string;
          operator: string;
          value: unknown;
          caseInsensitive?: boolean;
        }>;
      }>;
    };
    version: number;
  };
  permissionConfig: {
    mode: 'full' | 'simplified' | 'disabled';
    crawlSchedule: string | null;
    lastCrawlAt: string | null;
    crawlInProgress: boolean;
    documentsProcessed: number;
    averageAccuracy: number;
    lastCrawlError: string | null;
  };
  errorState: {
    consecutiveFailures: number;
    lastErrorAt: string | null;
    lastErrorMessage: string | null;
    isPaused: boolean;
    pausedAt: string | null;
    pauseReason: string | null;
  };
  configurationSource: 'manual' | 'quick_setup' | 'imported';
  discoveryId: string | null;
  recommendationId: string | null;
  autoConfiguredAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AuthMethod = 'device_code' | 'authorization_code' | 'client_credentials';

export interface DeviceCodeAuthResponse {
  authMethod: 'device_code';
  sessionId: string;
  userCode: string;
  verificationUri: string;
  expiresAt: string;
  message: string;
}

export interface AuthCodeAuthResponse {
  authMethod: 'authorization_code';
  authorizationUrl: string;
  state: string;
  redirectUri: string;
  message: string;
}

export interface ClientCredentialsAuthResponse {
  authMethod: 'client_credentials';
  status: 'completed';
  connectorId: string;
  message: string;
}

export type AuthInitiateResponse =
  | DeviceCodeAuthResponse
  | AuthCodeAuthResponse
  | ClientCredentialsAuthResponse;

export interface AuthStatusResponse {
  status: 'pending' | 'completed' | 'expired' | 'error';
  message?: string;
  connectorId?: string;
}

export interface DiscoveredResource {
  id: string;
  name: string;
  displayName: string;
  url: string;
  resourceType: string;
  parentId: string | null;
  metadata: Record<string, unknown>;
}

export interface ContentProfile {
  resourceId: string;
  totalDocuments: number;
  totalSizeBytes: number;
  fileTypeDistribution: Record<string, number>;
  updateFrequency: string;
  sensitivityIndicators: string[];
}

export interface ConnectorDiscovery {
  _id: string;
  connectorId: string;
  tenantId: string;
  status: DiscoveryStatus;
  resources: DiscoveredResource[];
  profiles: ContentProfile[];
  totalResources: number;
  discoveredAt: string | null;
  durationMs: number | null;
  error: string | null;
  jobId: string | null;
  createdAt: string;
}

export interface ResourceScore {
  resourceId: string;
  resourceName: string;
  overallScore: number;
  recommended: boolean;
  factors: {
    activityScore: number;
    sizeScore: number;
    contentScore: number;
    sensitivityPenalty: number;
  };
  reasoning: string;
}

export interface SyncStrategyRecommendation {
  syncMode: string;
  fullSyncSchedule: string;
  deltaSyncSchedule: string | null;
  enableWebhooks: boolean;
  reasoning: string;
  confidence: number;
}

export interface CostEstimate {
  estimatedDocuments: number;
  estimatedStorageBytes: number;
  estimatedSyncDurationSeconds: number;
  estimatedMonthlyApiCalls: number;
}

export interface ConnectorRecommendation {
  _id: string;
  connectorId: string;
  tenantId: string;
  discoveryId: string;
  status: RecommendationStatus;
  resourceScores: ResourceScore[];
  syncStrategy: SyncStrategyRecommendation;
  permissionMode: { mode: string; reasoning: string; confidence: number };
  filterConfig: Record<string, unknown>;
  costEstimate: CostEstimate;
  overallConfidence: number;
  generatedAt: string;
  createdAt: string;
}

export interface FileConnectorConfig {
  fileTypeFilter?: string;
  maxFileSizeMb?: number;
}

export interface WebConnectorConfig {
  url: string;
  crawlDepth?: number;
  includePatterns?: string;
  excludePatterns?: string;
}

export interface DatabaseConnectorConfig {
  connectionString: string;
  collection?: string;
  table?: string;
  query?: string;
}

export interface ApiConnectorConfig {
  url: string;
  method: string;
  headers?: string;
  authType?: string;
  authConfig?: string;
}

// =============================================================================
// ATTRIBUTE TYPES
// =============================================================================

export type AttributeTier = 'permanent' | 'approved' | 'beta' | 'novel' | 'discarded';

export interface AttributeRegistryItem {
  _id: string;
  tenantId: string;
  indexId: string;
  attributeId: string;
  productScope: string;
  tier: AttributeTier;
  displayName: string;
  dataType: string;
  aliases: string[];
  extractionPatterns: string[];
  definition?: string;
  confidence?: number;
  documentCount?: number;
  discoverySource?: string;
  firstSeenAt?: string;
  lastSeenAt?: string;
  uniqueUsers?: number;
  totalInteractions?: number;
  createdAt: string;
  updatedAt: string;
}

export interface AttributeFilters {
  tier?: AttributeTier;
  product?: string;
  dataType?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface ReviewQueueResult {
  mergeConflicts: Array<{
    attributeId: string;
    attributes: AttributeRegistryItem[];
  }>;
  placementReview: AttributeRegistryItem[];
  typeConflicts: Array<{
    attributeId: string;
    attributes: AttributeRegistryItem[];
  }>;
  total: number;
}

export interface AttributeStatsResult {
  byTier: Record<string, number>;
  recentPromotions: AttributeRegistryItem[];
  recentDemotions: AttributeRegistryItem[];
  interactionStats: Record<
    string,
    {
      impressions: number;
      clicks: number;
      uniqueUsers: number;
      clickRate: number;
    }
  >;
}

// =============================================================================
// URL HELPERS
// =============================================================================

function engineUrl(path: string): string {
  return `/api/search-ai${path}`;
}

function runtimeUrl(path: string): string {
  return `/api/search-ai-runtime${path}`;
}

// =============================================================================
// INDEX API
// =============================================================================

export async function fetchIndexes(
  projectId: string,
): Promise<{ indexes: SearchAIIndex[]; total: number }> {
  const response = await apiFetch(engineUrl(`/indexes?projectId=${projectId}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createIndex(data: {
  tenantId: string;
  projectId: string;
  name: string;
  slug: string;
  description?: string;
  embeddingModel?: string;
}): Promise<{ index: SearchAIIndex }> {
  const response = await apiFetch(engineUrl('/indexes'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function getIndex(indexId: string): Promise<{
  index: SearchAIIndex;
  resolvedLLMConfig?: Record<string, unknown> | null;
  enhancedLLMConfig?: Record<string, unknown> | null;
  defaultModel?: { displayName: string; provider: string; tier: string } | null;
}> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function deleteIndex(indexId: string): Promise<{ deleted: boolean }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function rebuildIndex(indexId: string): Promise<{ message: string; status: string }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/rebuild`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

// =============================================================================
// KNOWLEDGE BASE API
// =============================================================================

export async function fetchKnowledgeBases(
  projectId: string,
): Promise<{ knowledgeBases: KnowledgeBase[]; total: number }> {
  const response = await apiFetch(engineUrl(`/knowledge-bases?projectId=${projectId}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function createKnowledgeBase(data: {
  tenantId: string;
  projectId: string;
  name: string;
  description?: string;
}): Promise<{ knowledgeBase: KnowledgeBase }> {
  const response = await apiFetch(engineUrl('/knowledge-bases'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function getKnowledgeBase(
  kbId: string,
): Promise<{ knowledgeBase: KnowledgeBaseDetail }> {
  const response = await apiFetch(engineUrl(`/knowledge-bases/${kbId}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function updateKnowledgeBase(
  kbId: string,
  data: { name?: string; description?: string },
): Promise<{ knowledgeBase: KnowledgeBase }> {
  const response = await apiFetch(engineUrl(`/knowledge-bases/${kbId}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function deleteKnowledgeBase(kbId: string): Promise<{ deleted: boolean }> {
  const response = await apiFetch(engineUrl(`/knowledge-bases/${kbId}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function rebuildKnowledgeBase(
  kbId: string,
): Promise<{ message: string; status: string }> {
  const response = await apiFetch(engineUrl(`/knowledge-bases/${kbId}/rebuild`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

// =============================================================================
// SOURCE API
// =============================================================================

export async function fetchSources(
  indexId: string,
): Promise<{ sources: SearchAISource[]; total: number }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/sources`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function addSource(
  indexId: string,
  data: { name: string; sourceType: string; sourceConfig?: unknown },
): Promise<{ source: SearchAISource }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/sources`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function deleteSource(
  indexId: string,
  sourceId: string,
): Promise<{ deleted: boolean }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/sources/${sourceId}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function renameSource(
  indexId: string,
  sourceId: string,
  data: { name: string },
): Promise<{ source: SearchAISource }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/sources/${sourceId}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

// ---------------------------------------------------------------------------
// Source Stats (analytics for the source detail panel)
// ---------------------------------------------------------------------------

export interface SourceStats {
  sourceId: string;
  documentCount: number;
  totalChunks: number;
  totalPages: number;
  size: {
    total: number;
    average: number;
    largest: number;
    largestDocName: string | null;
    smallest: number;
  };
  byFileType: Array<{
    type: string;
    mime: string;
    count: number;
    totalSize: number;
    percentage: number;
  }>;
  byStatus: Array<{
    status: string;
    count: number;
  }>;
  recentDocuments: Array<{
    _id: string;
    name: string | null;
    size: number;
    status: string;
    createdAt: string;
    contentType: string | null;
  }>;
}

export async function fetchSourceStats(indexId: string, sourceId: string): Promise<SourceStats> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/sources/${sourceId}/stats`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function deleteConnector(
  indexId: string,
  connectorId: string,
): Promise<{ deleted: boolean }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/connectors/${connectorId}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function uploadDocument(
  indexId: string,
  sourceId: string,
  file: File,
  metadata?: Record<string, unknown>,
  signal?: AbortSignal,
): Promise<{
  id: string;
  originalReference: string;
  contentType: string;
  contentSizeBytes: number;
  status: string;
}> {
  const formData = new FormData();
  formData.append('file', file);
  if (metadata) {
    formData.append('metadata', JSON.stringify(metadata));
  }
  // CRITICAL: Do NOT set Content-Type — browser must set multipart/form-data with boundary.
  // Every other function in this file sets 'Content-Type: application/json' — do NOT copy that pattern here.
  // apiFetch (lib/api-client.ts:62) only adds Authorization + X-Tenant-Id, no Content-Type.
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/sources/${sourceId}/documents?autoProcess=false`),
    {
      method: 'POST',
      body: formData,
      signal,
    },
  );
  return handleResponse(response);
}

export async function fetchUploadHints(indexId: string): Promise<UploadHintsResponse> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/upload-hints`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

// =============================================================================
// SCHEMA API
// =============================================================================

export async function getCanonicalSchema(
  knowledgeBaseId: string,
): Promise<{ schema: CanonicalSchemaData }> {
  const response = await apiFetch(engineUrl(`/schemas/${knowledgeBaseId}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function updateCanonicalSchema(
  knowledgeBaseId: string,
  data: { fields?: CanonicalField[]; status?: string; activeFields?: string[] },
): Promise<{ schema: CanonicalSchemaData }> {
  const response = await apiFetch(engineUrl(`/schemas/${knowledgeBaseId}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

// =============================================================================
// MAPPING API
// =============================================================================

export async function fetchMappings(
  schemaId: string,
): Promise<{ mappings: FieldMappingData[]; total: number }> {
  const response = await apiFetch(engineUrl(`/mappings?schemaId=${schemaId}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function confirmMapping(mappingId: string): Promise<{ mapping: FieldMappingData }> {
  const response = await apiFetch(engineUrl(`/mappings/${mappingId}/confirm`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function rejectMapping(mappingId: string): Promise<{ mapping: FieldMappingData }> {
  const response = await apiFetch(engineUrl(`/mappings/${mappingId}/reject`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function patchMapping(
  mappingId: string,
  data: {
    alias?: string;
    enumValueMap?: Record<string, string>;
    transform?: { type: string; valueMap?: Record<string, string> };
  },
): Promise<{ mapping: FieldMappingData }> {
  const response = await apiFetch(engineUrl(`/mappings/${mappingId}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function deleteMapping(mappingId: string): Promise<void> {
  const response = await apiFetch(engineUrl(`/mappings/${mappingId}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new Error(body.error?.message || body.error || 'Failed to delete mapping');
  }
}

export async function bulkActionMappings(
  action: 'confirm' | 'reject',
  mappingIds: string[],
): Promise<{ success: boolean; processedCount: number }> {
  const response = await apiFetch(engineUrl('/mappings/bulk-action'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, mappingIds }),
  });
  return handleResponse(response);
}

export async function createManualMapping(data: {
  sourcePath: string;
  canonicalField: string;
  connectorId: string;
  canonicalSchemaId: string;
  transform?: { type: string };
}): Promise<{ mapping: FieldMappingData }> {
  const response = await apiFetch(engineUrl('/mappings'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

export async function getUnmappedFields(
  knowledgeBaseId: string,
  connectorId: string,
): Promise<UnmappedFieldsResponse> {
  const response = await apiFetch(
    engineUrl(`/schemas/${knowledgeBaseId}/unmapped/${connectorId}`),
    { headers: { 'Content-Type': 'application/json' } },
  );
  return handleResponse(response);
}

// =============================================================================
// DOCUMENT TYPES & API
// =============================================================================

export interface SearchAIDocument {
  _id: string;
  title: string;
  status: string;
  chunkCount: number;
  sourceId?: string;
  contentType?: string | null;
  sourceMetadata: Record<string, unknown>;
  contentSizeBytes: number;
  processingError?: string | null;
  createdAt: string;
}

export async function fetchDocuments(
  indexId: string,
  options?: {
    sourceId?: string;
    sourceType?: string;
    status?: string;
    search?: string;
    limit?: number;
    offset?: number;
  },
): Promise<{
  documents: SearchAIDocument[];
  total: number;
  pagination: { limit: number; offset: number; hasMore: boolean };
}> {
  const params = new URLSearchParams();
  if (options?.sourceId) params.set('sourceId', options.sourceId);
  if (options?.sourceType) params.set('sourceType', options.sourceType);
  if (options?.status) params.set('status', options.status);
  if (options?.search) params.set('search', options.search);
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  const qs = params.toString() ? `?${params.toString()}` : '';
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/documents${qs}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export interface DocumentStatusSummary {
  documentStatuses: Array<{ _id: string; count: number }>;
  docsWithChunkErrors: number;
}

export async function fetchDocumentStatusSummary(indexId: string): Promise<DocumentStatusSummary> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/documents/status-summary`));
  return handleResponse(response);
}

// =============================================================================
// CHUNK TYPES & API
// =============================================================================

export interface SearchAIChunk {
  id: string;
  chunkIndex: number;
  content?: string;
  tokenCount: number;
  metadata: Record<string, unknown> | null;
  canonicalMetadata: Record<string, unknown> | null;
  status: string;
  documentId?: string;
  documentTitle?: string;
  createdAt: string;
  updatedAt: string;
}

export interface ChunkPagination {
  total: number;
  limit: number;
  offset: number;
  hasMore: boolean;
}

export async function fetchChunks(
  indexId: string,
  documentId: string,
  options?: { limit?: number; offset?: number; includeContent?: boolean },
): Promise<{ chunks: SearchAIChunk[]; pagination: ChunkPagination }> {
  const params = new URLSearchParams();
  if (options?.limit) params.set('limit', String(options.limit));
  if (options?.offset) params.set('offset', String(options.offset));
  if (options?.includeContent === false) params.set('includeContent', 'false');
  const qs = params.toString() ? `?${params.toString()}` : '';
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/documents/${documentId}/chunks${qs}`),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return handleResponse(response);
}

export interface FetchAllChunksOptions {
  limit?: number;
  offset?: number;
  status?: string[];
  sourceId?: string;
  documentId?: string;
  search?: string;
  minTokens?: number;
  maxTokens?: number;
  sort?: string;
  order?: 'asc' | 'desc';
  includeContent?: boolean;
}

export async function fetchAllChunks(
  indexId: string,
  options?: FetchAllChunksOptions,
): Promise<{
  chunks: SearchAIChunk[];
  pagination: ChunkPagination;
  statusCounts?: Record<string, number>;
}> {
  const params = new URLSearchParams();
  if (options?.limit != null) params.set('limit', String(options.limit));
  if (options?.offset != null) params.set('offset', String(options.offset));
  if (options?.status?.length) params.set('status', options.status.join(','));
  if (options?.sourceId) params.set('sourceId', options.sourceId);
  if (options?.documentId) params.set('documentId', options.documentId);
  if (options?.search) params.set('search', options.search);
  if (options?.minTokens !== undefined) params.set('minTokens', String(options.minTokens));
  if (options?.maxTokens !== undefined) params.set('maxTokens', String(options.maxTokens));
  if (options?.sort) params.set('sort', options.sort);
  if (options?.order) params.set('order', options.order);
  if (options?.includeContent === false) params.set('includeContent', 'false');
  const qs = params.toString() ? `?${params.toString()}` : '';
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/chunks${qs}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export async function deleteDocument(indexId: string, documentId: string): Promise<void> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/documents/${documentId}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({ error: 'Delete failed' }));
    throw new Error(body.error || 'Failed to delete document');
  }
}

/**
 * Bulk retry (reprocess) failed documents by resetting their status to PENDING.
 * Calls the admin errors bulk-retry endpoint.
 * @deprecated Use bulkReprocessDocuments for proper pipeline re-triggering.
 */
export async function bulkRetryDocuments(
  documentIds: string[],
): Promise<{ success: boolean; modifiedCount: number }> {
  const response = await apiFetch(engineUrl('/admin/errors/bulk-retry'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ documentIds }),
  });
  return handleResponse(response);
}

/**
 * Bulk reprocess documents: cleans old chunks, resets status, re-triggers pipeline.
 * Works on documents in ANY status — not just 'error'.
 * Auto-retries once on 429 (rate limit) after the server-indicated delay.
 */
export async function bulkReprocessDocuments(
  projectId: string,
  kbId: string,
  documentIds: string[],
): Promise<{ success: boolean; triggeredCount: number; totalFound: number }> {
  const doFetch = () =>
    apiFetch(engineUrl(`/projects/${projectId}/knowledge-bases/${kbId}/documents/bulk-reprocess`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ documentIds }),
    });

  let response = await doFetch();

  // Auto-retry once on rate limit
  if (response.status === 429) {
    const body = await response.json().catch(() => ({}));
    const retryMs = Math.min(body.retryAfterMs ?? 5000, 10_000);
    await new Promise((resolve) => setTimeout(resolve, retryMs));
    response = await doFetch();
  }

  return handleResponse(response);
}

/**
 * Bulk delete documents by ID.
 * Deletes in batches of BULK_DELETE_CONCURRENCY to avoid hammering the backend.
 * Returns the count of successfully deleted documents.
 */
const BULK_DELETE_CONCURRENCY = 5;

export async function bulkDeleteDocuments(
  indexId: string,
  documentIds: string[],
): Promise<{ deletedCount: number; failedCount: number }> {
  let deletedCount = 0;
  let failedCount = 0;

  // Process in batches to limit concurrent requests
  for (let i = 0; i < documentIds.length; i += BULK_DELETE_CONCURRENCY) {
    const batch = documentIds.slice(i, i + BULK_DELETE_CONCURRENCY);
    const results = await Promise.allSettled(batch.map((id) => deleteDocument(indexId, id)));
    deletedCount += results.filter((r) => r.status === 'fulfilled').length;
    failedCount += results.filter((r) => r.status === 'rejected').length;
  }

  return { deletedCount, failedCount };
}

// =============================================================================
// DOCUMENT DETAIL
// =============================================================================

/**
 * Get document detail with extracted text and chunks
 */
export async function getDocumentDetail(
  indexId: string,
  documentId: string,
): Promise<{
  document: {
    _id: string;
    title: string;
    url: string;
    status: string;
    contentType: string;
    contentSizeBytes: number;
    extractedText: string | null;
    sourceMetadata: Record<string, unknown>;
    rawHtmlUrl?: string;
    createdAt: string;
    updatedAt?: string;
  };
  chunks: Array<{
    _id: string;
    content: string;
    position: { order?: number; page?: number };
    chunkIndex?: number;
    status: string;
    tokenCount?: number;
  }>;
  chunkCount: number;
  pagination?: { total: number; limit: number; offset: number; hasMore: boolean };
}> {
  const response = await apiFetch(`/api/search-ai/indexes/${indexId}/documents/${documentId}`);
  return handleResponse(response);
}

// =============================================================================
// VOCABULARY API (NEW - API-1 to API-6)
// =============================================================================

/**
 * Vocabulary entry type matching the new OpenAPI spec
 */
export interface VocabularyEntry {
  id: string;
  term: string;
  aliases: string[];
  description?: string;
  fieldRef: string;
  capabilities: {
    canFilter: boolean;
    canDisplay: boolean;
    canAggregate: boolean;
    canSort: boolean;
  };
  relatedFields: {
    displayWith: string[];
    aggregateWith: string[];
  };
  enabled: boolean;
  confidence?: number;
  generatedBy: 'auto' | 'manual';
  usageCount?: number;
  lastUsed?: string;
  createdAt?: string;
  updatedAt?: string;
}

export interface CreateVocabularyEntryInput {
  term: string;
  aliases?: string[];
  description?: string;
  fieldRef: string;
  capabilities: {
    canFilter: boolean;
    canDisplay: boolean;
    canAggregate: boolean;
    canSort: boolean;
  };
  relatedFields: {
    displayWith: string[];
    aggregateWith: string[];
  };
  enabled?: boolean;
  confidence?: number;
  generatedBy: 'auto' | 'manual';
}

export interface UpdateVocabularyEntryInput {
  aliases?: string[];
  description?: string;
  capabilities?: {
    canFilter?: boolean;
    canDisplay?: boolean;
    canAggregate?: boolean;
    canSort?: boolean;
  };
  relatedFields?: {
    displayWith?: string[];
    aggregateWith?: string[];
  };
  enabled?: boolean;
  confidence?: number;
}

export interface VocabularyListResponse {
  entries: VocabularyEntry[];
  total: number;
  limit: number;
  offset: number;
  vocabulary: {
    _id: string;
    version: number;
    status: string;
    lastGeneratedAt?: string;
  };
}

export interface VocabularyTestResult {
  query: string;
  resolutions: Array<{
    term: string;
    entryId: string;
    fieldRef: string;
    confidence: number;
    matchType: string;
  }>;
}

/**
 * API-1: List vocabulary entries
 */
export async function listVocabularyEntries(
  indexId: string,
  filters?: {
    status?: 'active' | 'inactive' | 'all';
    generatedBy?: 'auto' | 'manual' | 'all';
    search?: string;
    limit?: number;
    offset?: number;
  },
): Promise<VocabularyListResponse> {
  const params = new URLSearchParams();
  if (filters?.status) params.append('status', filters.status);
  if (filters?.generatedBy) params.append('generatedBy', filters.generatedBy);
  if (filters?.search) params.append('search', filters.search);
  if (filters?.limit) params.append('limit', String(filters.limit));
  if (filters?.offset) params.append('offset', String(filters.offset));

  const queryString = params.toString();
  const url = engineUrl(`/indexes/${indexId}/vocabulary${queryString ? `?${queryString}` : ''}`);

  const response = await apiFetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * API-2: Create vocabulary entry
 */
export async function createVocabularyEntry(
  indexId: string,
  data: CreateVocabularyEntryInput,
): Promise<{ entryId: string; message: string }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/vocabulary`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * API-3: Update vocabulary entry
 */
export async function updateVocabularyEntry(
  indexId: string,
  entryId: string,
  data: UpdateVocabularyEntryInput,
): Promise<{ entry: VocabularyEntry; message: string }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/vocabulary/${entryId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * API-4: Delete vocabulary entry
 */
export async function deleteVocabularyEntry(
  indexId: string,
  entryId: string,
): Promise<{ deleted: boolean; message: string }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/vocabulary/${entryId}`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * API-5: Toggle vocabulary entry
 */
export async function toggleVocabularyEntry(
  indexId: string,
  entryId: string,
  enabled: boolean,
): Promise<{ entry: VocabularyEntry; message: string }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/vocabulary/${entryId}/toggle`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return handleResponse(response);
}

/**
 * API-6: Test vocabulary resolution
 */
export async function testVocabularyResolution(
  indexId: string,
  query: string,
  entryIds?: string[],
): Promise<VocabularyTestResult> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/vocabulary/test`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, entryIds }),
  });
  return handleResponse(response);
}

// =============================================================================
// VOCABULARY REVIEW API (Story 4.5 — FieldsTab vocabulary review dialog)
// =============================================================================

/**
 * Response shape for GET /:indexId/vocabulary/:fieldRef
 */
export interface VocabularyByFieldRefResponse {
  entries: VocabularyEntry[];
  total: number;
  fieldRef: string;
}

/**
 * Response shape for POST /:indexId/vocabulary/review
 */
export interface VocabularyReviewResponse {
  success: boolean;
  action: 'approve' | 'reject';
  updatedCount: number;
  updatedIds: string[];
  notFoundIds?: string[];
}

/**
 * Fetch vocabulary entries for a specific field alias (fieldRef).
 * Used by the VocabularyReviewDialog to show terms grouped by source.
 */
export async function getVocabularyByFieldRef(
  indexId: string,
  fieldRef: string,
): Promise<VocabularyByFieldRefResponse> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/vocabulary/${encodeURIComponent(fieldRef)}`),
    {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return handleResponse(response);
}

/**
 * Bulk approve or reject vocabulary terms by their IDs.
 * Approve sets `enabled: true`, reject sets `enabled: false`.
 */
export async function reviewVocabularyTerms(
  indexId: string,
  action: 'approve' | 'reject',
  termIds: string[],
): Promise<VocabularyReviewResponse> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/vocabulary/review`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, termIds }),
  });
  return handleResponse(response);
}

// =============================================================================
// QUERY API
// =============================================================================

export async function executeQuery(
  indexId: string,
  query: {
    query: string;
    queryType?: 'vector' | 'hybrid' | 'structured' | 'keyword';
    topK?: number;
    debug?: boolean;
    filters?: MetadataFilter[];
    documentIds?: string[];
    /** Skip multilingual preprocessing (spell correction, synonym expansion, entity extraction) */
    skipPreprocessing?: boolean;
  },
): Promise<SearchAIQueryResult> {
  const endpoint = 'query';
  const response = await apiFetch(runtimeUrl(`/search/${indexId}/${endpoint}`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(query),
  });
  return handleResponse(response);
}

// =============================================================================
// DISCOVERY API (search-ai-runtime)
// =============================================================================

export interface DiscoveryFilterField {
  name: string;
  /** Human-friendly label from vocabulary (e.g., "colour" instead of "custom_string_1") */
  label?: string;
  type: string;
  values: string[];
  sortable: boolean;
}

export interface DiscoveryVocabularyTerm {
  term: string;
  aliases: string[];
  field: string;
  values: string[];
  canFilter: boolean;
  canAggregate: boolean;
  usage: string;
}

export interface SearchDiscoveryResult {
  kb: { name: string; description: string | null; documentCount: number };
  capabilities: {
    filters: {
      available: boolean;
      fields: DiscoveryFilterField[];
      operators: string[];
    };
    vocabulary: {
      available: boolean;
      terms: DiscoveryVocabularyTerm[];
    };
  };
}

export async function getSearchDiscovery(indexId: string): Promise<SearchDiscoveryResult> {
  const response = await apiFetch(runtimeUrl(`/search/${indexId}/discover`));
  return handleResponse(response);
}

export async function resolveVocabulary(
  indexId: string,
  query: string,
  mode?: 'exact' | 'alias' | 'fuzzy',
): Promise<VocabularyResolutionResult> {
  const response = await apiFetch(runtimeUrl(`/search/${indexId}/resolve`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, mode }),
  });
  return handleResponse(response);
}

// =============================================================================
// KNOWLEDGE GRAPH API
// =============================================================================

export interface ProductDistribution {
  productId: string;
  name: string;
  count: number;
  percentage: number;
  avgConfidence: number;
}

export interface DepartmentDistribution {
  department: string;
  count: number;
  percentage: number;
}

export interface KGStats {
  totalDocuments: number;
  enrichedDocuments: number;
  pendingDocuments: number;
  skippedDocuments: number;
  productsDistribution: ProductDistribution[];
  departmentsDistribution: DepartmentDistribution[];
  avgConfidence: number;
  taxonomyVersion: string;
  createdAt: string;
  updatedAt: string;
}

export interface ClassifiedDocument {
  documentId: string;
  title: string;
  summary: string;
  primaryProduct: string;
  secondaryProducts: string[];
  confidence: number;
  department: string;
  category: string;
  enrichedAt: string;
  createdAt: string;
}

export interface ClassifiedDocumentsResult {
  documents: ClassifiedDocument[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export interface EntityDistribution {
  attributeId: string;
  name: string;
  dataType: string;
  count: number;
  sampleValues: string[];
}

export interface EntityDistributionResult {
  entities: EntityDistribution[];
  total: number;
}

/**
 * Get Knowledge Graph statistics for an index
 */
export async function getKGStats(indexId: string): Promise<KGStats> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/kg-enrich/stats`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Get classified documents with pagination and filtering
 */
export async function getClassifiedDocuments(
  indexId: string,
  params?: {
    page?: number;
    limit?: number;
    productId?: string;
    department?: string;
    minConfidence?: number;
    sortBy?: 'confidence' | 'createdAt';
    sortOrder?: 'asc' | 'desc';
  },
): Promise<ClassifiedDocumentsResult> {
  const queryParams = new URLSearchParams();
  if (params?.page) queryParams.set('page', params.page.toString());
  if (params?.limit) queryParams.set('limit', params.limit.toString());
  if (params?.productId) queryParams.set('productId', params.productId);
  if (params?.department) queryParams.set('department', params.department);
  if (params?.minConfidence) queryParams.set('minConfidence', params.minConfidence.toString());
  if (params?.sortBy) queryParams.set('sortBy', params.sortBy);
  if (params?.sortOrder) queryParams.set('sortOrder', params.sortOrder);

  const url = engineUrl(`/indexes/${indexId}/kg-enrich/documents?${queryParams.toString()}`);
  const response = await apiFetch(url, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Get entity distribution across the knowledge graph
 */
export async function getEntityDistribution(
  indexId: string,
  params?: {
    productId?: string;
    limit?: number;
  },
): Promise<EntityDistributionResult> {
  const queryParams = new URLSearchParams();
  if (params?.productId) queryParams.set('productId', params.productId);
  if (params?.limit) queryParams.set('limit', params.limit.toString());

  const url = engineUrl(`/indexes/${indexId}/kg-enrich/entities?${queryParams.toString()}`);
  const response = await apiFetch(url, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

export interface GraphNode {
  id: string;
  label: string;
  type: 'domain' | 'category' | 'product' | 'attribute' | 'entity_instance';
  properties: Record<string, any>;
}

export interface GraphEdge {
  from: string;
  to: string;
  type: string;
  properties?: Record<string, any>;
}

export interface GraphStructure {
  nodes: GraphNode[];
  edges: GraphEdge[];
  attributeSummaries?: Array<{
    attributeId: string;
    uniqueValues: number;
    topValues: Array<{ value: string; documentCount: number }>;
  }>;
  statistics: {
    totalNodes: number;
    totalEdges: number;
    nodeTypes: {
      domain: number;
      category: number;
      product: number;
      attribute: number;
      entity_instance: number;
    };
  };
}

// ─── Taxonomy Types ──────────────────────────────────────────────────────

export interface DomainSummary {
  id: string;
  name: string;
  version: string;
  categoriesCount: number;
  productsCount: number;
  attributesCount: number;
}

export interface DomainProduct {
  id: string;
  name: string;
  categoryId: string;
  department: string;
  subDepartment: string;
  disambiguationKeywords: string[];
}

export interface DomainCategory {
  id: string;
  name: string;
  department: string;
}

export interface DomainAttribute {
  id: string;
  name: string;
  dataType: string;
  applicableTo: string[];
  extraction: {
    method: string;
    patterns?: string[];
    keywords?: string[];
  };
}

export interface DomainDefinition {
  id: string;
  name: string;
  version: string;
  categories: DomainCategory[];
  products: DomainProduct[];
  attributes: DomainAttribute[];
  departmentBoundaries: Array<{
    product1: string;
    product2: string;
    reasoning: string;
  }>;
}

export interface TaxonomyDetail {
  taxonomyId: string;
  version: string;
  domains: string[];
  taxonomy: {
    domain: { id: string; name: string; version: string };
    categories: Array<{ id: string; name: string; department: string }>;
    products: Array<{
      id: string;
      name: string;
      categoryId: string;
      department: string;
      subDepartment: string;
    }>;
    attributes: Array<{
      id: string;
      name: string;
      dataType: string;
      applicableTo: string[];
    }>;
    departmentBoundaries: Array<{
      product1: string;
      product2: string;
      reasoning: string;
    }>;
  };
  statistics: {
    categoriesCount: number;
    productsCount: number;
    attributesCount: number;
    departmentBoundariesCount: number;
  };
  createdAt: string;
  updatedAt: string;
}

export interface TaxonomySetupJobStatus {
  jobId: string;
  status: 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
  progress: number;
  createdAt: string;
  processedAt: string | null;
  finishedAt: string | null;
  taxonomyId?: string;
  taxonomyVersion?: string;
  domains?: string[];
  productsCount?: number;
  attributesCount?: number;
  error?: string;
}

export interface OrgProfile {
  organizationName: string;
  industry: string;
  keyTerms: string[];
  acronyms: Record<string, string>;
  departmentBoundaries: Array<{
    product1: string;
    product2: string;
    reasoning: string;
  }>;
  productSpecificNames: Record<string, string[]>;
}

export interface GenerateOrgProfileResponse {
  success: boolean;
  data: {
    profile: OrgProfile;
    generatedBy: 'llm' | 'manual';
    cost: number;
    metadata: {
      mode: string;
      durationMs: number;
      circuitBreakerState: string;
    };
  };
}

// ─── Taxonomy API Functions ─────────────────────────────────────────────

/**
 * List available domain definitions
 */
export async function getKGDomains(): Promise<{ domains: DomainSummary[] }> {
  const response = await apiFetch(engineUrl('/indexes/kg-taxonomy/domains'), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Get full domain definition with products, attributes, and categories
 */
export async function getKGDomainDetails(domainId: string): Promise<DomainDefinition> {
  const response = await apiFetch(engineUrl(`/indexes/kg-taxonomy/domains/${domainId}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Generate organization profile using LLM
 * RFC-001 Phase 2: LLM-Assisted Org Profile Generation
 */
export async function generateOrgProfile(
  indexId: string,
  data: {
    mode: 'url' | 'name-industry' | 'paragraph';
    input: {
      url?: string;
      name?: string;
      industry?: string;
      description?: string;
    };
  },
): Promise<GenerateOrgProfileResponse> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/kg-taxonomy/generate-profile`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Generate custom domain definition from organization profile using LLM
 * RFC-001 Phase 3: Domain Auto-Generation
 */
export async function generateCustomDomain(
  indexId: string,
  orgProfile: OrgProfile,
): Promise<{
  success: true;
  data: {
    domain: DomainDefinition;
    generatedBy: 'llm';
    cost: number;
    metadata: {
      durationMs: number;
      circuitBreakerState: string;
      statistics: {
        categoriesCount: number;
        productsCount: number;
        attributesCount: number;
        departmentBoundariesCount: number;
      };
    };
  };
}> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/kg-taxonomy/domains/generate`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ orgProfile }),
  });
  return handleResponse(response);
}

/**
 * Save custom domain to database
 * RFC-001 Phase 3: Domain Auto-Generation
 */
export async function saveCustomDomain(
  indexId: string,
  domain: DomainDefinition,
  setAsActive = false,
): Promise<{
  success: true;
  data: {
    domainId: string;
    domain: DomainDefinition;
    taxonomySetupEnqueued: boolean;
  };
}> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/kg-taxonomy/domains`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ domain, setAsActive }),
  });
  return handleResponse(response);
}

/**
 * List all custom domains for an index's tenant
 * RFC-001 Phase 3: Domain Auto-Generation
 */
export async function listCustomDomains(indexId: string): Promise<{
  success: true;
  data: {
    domains: Array<{
      _id: string;
      name: string;
      version: string;
      industry: string;
      createdBy: string;
      createdAt: string;
      updatedAt: string;
      categoriesCount: number;
      productsCount: number;
      attributesCount: number;
    }>;
    total: number;
  };
}> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/kg-taxonomy/domains`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Get custom domain details by ID
 * RFC-001 Phase 3: Domain Auto-Generation
 */
export async function getCustomDomain(
  indexId: string,
  domainId: string,
): Promise<{
  success: true;
  data: { domain: DomainDefinition };
}> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/kg-taxonomy/domains/${domainId}`),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return handleResponse(response);
}

/**
 * Delete custom domain
 * RFC-001 Phase 3: Domain Auto-Generation
 */
export async function deleteCustomDomain(
  indexId: string,
  domainId: string,
): Promise<{
  success: true;
  data: { deleted: true; domainId: string };
}> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/kg-taxonomy/domains/${domainId}`),
    {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return handleResponse(response);
}

/**
 * Set up taxonomy for an index
 */
export async function setupTaxonomy(
  indexId: string,
  data: {
    domain: string;
    autoConfigureModelId?: string;
    organizationProfile?: {
      organizationName: string;
      products: Array<{
        productId: string;
        organizationSpecificNames: string[];
        attributeContext?: Record<string, { typicalRange?: string; aliases?: string[] }>;
      }>;
    };
    priority?: 'low' | 'normal' | 'high';
  },
): Promise<{ jobId: string; status: string; pollUrl: string }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/kg-taxonomy/setup`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Get taxonomy setup job status
 */
export async function getTaxonomySetupStatus(
  indexId: string,
  jobId: string,
): Promise<TaxonomySetupJobStatus> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/kg-taxonomy/setup/${encodeURIComponent(jobId)}`),
    {
      headers: { 'Content-Type': 'application/json' },
    },
  );
  return handleResponse(response);
}

/**
 * Get current taxonomy for an index
 */
export async function getTaxonomy(indexId: string): Promise<TaxonomyDetail> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/kg-taxonomy`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Delete taxonomy for an index
 */
export async function deleteTaxonomy(indexId: string): Promise<{ success: boolean }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/kg-taxonomy`), {
    method: 'DELETE',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Trigger KG enrichment for an index
 */
export async function triggerEnrichment(
  indexId: string,
  options?: { forceReclassify?: boolean },
): Promise<{ jobId: string; status: string }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/kg-enrich`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(options || {}),
  });
  return handleResponse(response);
}

/**
 * Toggle per-index KG enabled state
 */
export async function updateIndexKGEnabled(
  indexId: string,
  enabled: boolean,
): Promise<{ success: boolean; enabled: boolean }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/kg-toggle`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  return handleResponse(response);
}

/**
 * Update search defaults (topK, similarityThreshold) for an index.
 */
export async function updateSearchDefaults(
  indexId: string,
  searchDefaults: Partial<SearchAIDefaults>,
): Promise<{ index: SearchAIIndex }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}`), {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchDefaults }),
  });
  return handleResponse(response);
}

/**
 * Update citation configuration for an index.
 */
export async function updateCitationConfig(
  indexId: string,
  config: NonNullable<SearchAIIndex['citationConfig']>,
): Promise<{ success: boolean; data: NonNullable<SearchAIIndex['citationConfig']> }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/citation-config`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(config),
  });
  return handleResponse(response);
}

/**
 * Get knowledge graph structure for visualization
 */
export async function getGraphStructure(
  indexId: string,
  params?: {
    nodeId?: string;
    depth?: number;
    nodeType?: string;
    productId?: string;
    includeEntityInstances?: boolean;
    entityLimit?: number;
  },
): Promise<GraphStructure> {
  const queryParams = new URLSearchParams();
  if (params?.nodeId) queryParams.set('nodeId', params.nodeId);
  if (params?.depth) queryParams.set('depth', params.depth.toString());
  if (params?.nodeType) queryParams.set('nodeType', params.nodeType);
  if (params?.productId) queryParams.set('productId', params.productId);
  if (params?.includeEntityInstances !== undefined)
    queryParams.set('includeEntityInstances', params.includeEntityInstances.toString());
  if (params?.entityLimit) queryParams.set('entityLimit', params.entityLimit.toString());

  const url = engineUrl(`/indexes/${indexId}/kg-enrich/graph?${queryParams.toString()}`);
  const response = await apiFetch(url, {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

// =============================================================================
// ENTERPRISE CONNECTOR API
// =============================================================================

/**
 * List enterprise connectors for an index
 */
export async function fetchEnterpriseConnectors(
  indexId: string,
): Promise<{ success: boolean; data: { connectors: EnterpriseConnector[] } }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/connectors`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Create an enterprise connector
 */
export async function createEnterpriseConnector(
  indexId: string,
  data: {
    name: string;
    connectorType: EnterpriseConnectorType;
    connectionConfig?: Record<string, unknown>;
  },
): Promise<{ success: boolean; data: { connector: EnterpriseConnector } }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/connectors`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Initiate OAuth authentication for a connector.
 * The auth method is determined by connectionConfig.authMethod stored on the connector.
 */
export async function initiateConnectorAuth(
  connectorId: string,
): Promise<{ success: boolean; data: AuthInitiateResponse }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/auth/initiate`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Poll device code authentication status
 */
export async function getConnectorAuthStatus(
  connectorId: string,
): Promise<{ success: boolean; data: AuthStatusResponse }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/auth/status`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Exchange authorization code for tokens (Authorization Code flow callback)
 */
export async function exchangeAuthorizationCode(
  connectorId: string,
  data: { code: string; state: string },
): Promise<{ success: boolean; data: { status: string; connectorId: string } }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/auth/callback`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Trigger resource discovery for a connector
 */
export async function triggerConnectorDiscovery(
  connectorId: string,
  data: { mode?: DiscoveryMode; sampleSize?: number },
): Promise<{
  success: boolean;
  data: { discoveryId: string; jobId: string; status: string; message: string };
}> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/discover`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Get latest discovery results for a connector
 */
export async function getConnectorDiscovery(
  connectorId: string,
): Promise<{ success: boolean; data: ConnectorDiscovery }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/discovery`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Check if a connector name is available within an index
 */
export async function checkConnectorName(
  indexId: string,
  name: string,
): Promise<{ available: boolean; suggestion?: string }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/check-name?name=${encodeURIComponent(name)}`),
    { method: 'GET' },
  );
  return handleResponse(response);
}

/**
 * Generate an admin email template for connector setup
 */
export async function generateAdminEmail(
  indexId: string,
  type: string,
): Promise<{ subject: string; body: string; mailto: string }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/generate-admin-email`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type }),
    },
  );
  return handleResponse(response);
}

/**
 * Run a preview/dry-run of the connector's current filter configuration.
 * Maps the backend response shape (estimate + validation) to PreviewData.
 */
export async function runPreview(connectorId: string): Promise<PreviewData> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/filters/preview`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: '{}',
  });
  const raw = await handleResponse<{
    estimate?: {
      totalDocumentsInSource?: number | null;
      totalSitesInSource?: number | null;
      discoveryDataAge?: string | null;
      note?: string;
    };
    validation?: { valid: boolean; errors?: string[] };
    currentFilterConfig?: Record<string, unknown>;
  }>(response);

  // Map backend shape to PreviewData expected by the UI
  return {
    matchCount: raw.estimate?.totalDocumentsInSource ?? 0,
    excludedCount: 0,
    estimatedSizeBytes: 0,
    estimatedSyncMinutes: 0,
    sampleDocuments: [],
    skippedDocuments: [],
    contentTypeBreakdown: [],
    hasPreviousPreview: false,
  };
}

/**
 * Get configuration summary for a connector
 */
export async function getConfigSummary(
  indexId: string,
  connectorId: string,
): Promise<ConfigSummary> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/summary`),
    { method: 'GET' },
  );
  return handleResponse(response);
}

/** Preview data returned by runPreview */
export interface PreviewData {
  matchCount: number;
  excludedCount: number;
  estimatedSizeBytes: number;
  estimatedSyncMinutes: number;
  timeRange?: { earliest?: string; latest?: string };
  sampleDocuments: Array<{ name: string; type: string; sizeBytes: number }>;
  skippedDocuments: Array<{ name: string; reason: string }>;
  contentTypeBreakdown: Array<{ type: string; count: number; percentage: number }>;
  hasPreviousPreview: boolean;
  filterChanges?: Array<{ description: string; impact: string }>;
}

/** Config summary returned by getConfigSummary */
export interface ConfigSummary {
  connection: { authMethod: string; tenantId: string; clientId: string };
  scope: { variant: string; siteCount: number; sites: string[] };
  filters: {
    template: string;
    fileTypes: string[];
    dateRange?: { after?: string; before?: string };
  };
  schedule: { frequency: string; nextRun?: string };
  permissions: { mode: string; permissionAwareEnabled: boolean };
  security: { status: string; approvalRequired: boolean };
  estimatedSyncMinutes: number;
  totalDocuments: number;
  estimatedSizeBytes: number;
}

// =============================================================================
// PROPOSAL API
// =============================================================================

/**
 * Start proposal generation for a connector
 */
export async function startProposalGeneration(
  indexId: string,
  connectorId: string,
): Promise<Record<string, unknown>> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/generate`),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return handleResponse(response);
}

/**
 * Get proposal generation status (for polling during generation)
 */
export async function getProposalStatus(
  indexId: string,
  connectorId: string,
): Promise<{
  status: string;
  steps: Array<{ id: string; label: string; status: string; statusText: string }>;
}> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/status`),
    { method: 'GET' },
  );
  return handleResponse(response);
}

/**
 * Get the full proposal
 */
export async function getProposal(
  indexId: string,
  connectorId: string,
): Promise<Record<string, unknown>> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal`),
    { method: 'GET' },
  );
  return handleResponse(response);
}

/**
 * Accept a proposal section
 */
export async function acceptProposalSection(
  indexId: string,
  connectorId: string,
  sectionId: string,
): Promise<{ status: string }> {
  const response = await apiFetch(
    engineUrl(
      `/indexes/${indexId}/connectors/${connectorId}/proposal/sections/${sectionId}/accept`,
    ),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return handleResponse(response);
}

/**
 * Modify a proposal section with user-provided data
 */
export async function modifyProposalSection(
  indexId: string,
  connectorId: string,
  sectionId: string,
  data: Record<string, unknown>,
): Promise<{ status: string }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/sections/${sectionId}`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ data }),
    },
  );
  return handleResponse(response);
}

/**
 * Skip a proposal section
 */
export async function skipProposalSection(
  indexId: string,
  connectorId: string,
  sectionId: string,
): Promise<{ status: string }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/sections/${sectionId}/skip`),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return handleResponse(response);
}

/**
 * Accept all remaining unreviewed sections
 */
export async function acceptAllRemainingSections(
  indexId: string,
  connectorId: string,
): Promise<Record<string, unknown>> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/accept-all`),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return handleResponse(response);
}

/**
 * Abandon the proposal (do not sync)
 */
export async function abandonProposal(
  indexId: string,
  connectorId: string,
): Promise<{ abandoned: boolean }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/abandon`),
    { method: 'DELETE' },
  );
  return handleResponse(response);
}

/**
 * Export proposal as PDF/JSON/YAML
 */
export async function exportProposal(
  indexId: string,
  connectorId: string,
  format: 'pdf' | 'json' | 'yaml',
): Promise<Blob> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/export?format=${format}`),
    { method: 'GET' },
  );
  // For export, we return raw response data as blob
  if (response instanceof Response) {
    return response.blob();
  }
  return new Blob([JSON.stringify(response)], { type: 'application/json' });
}

/**
 * Re-run health check for a connector proposal
 */
export async function rerunProposalHealthCheck(
  indexId: string,
  connectorId: string,
): Promise<Record<string, unknown>> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/sections/health-check/rerun`),
    { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' },
  );
  return handleResponse(response);
}

/**
 * Disable permission-aware search (requires confirmation)
 */
export async function disableProposalPermissions(
  indexId: string,
  connectorId: string,
  confirmationText: string,
): Promise<{ disabled: boolean; auditRecord: { disabledBy: string; disabledAt: string } }> {
  const response = await apiFetch(
    engineUrl(
      `/indexes/${indexId}/connectors/${connectorId}/proposal/sections/permissions/disable`,
    ),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirmationText }),
    },
  );
  return handleResponse(response);
}

/**
 * Approve the connector proposal and start sync
 */
export async function approveProposal(
  indexId: string,
  connectorId: string,
): Promise<{ syncJobId: string }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/proposal/approve`),
    { method: 'POST', headers: { 'Content-Type': 'application/json' } },
  );
  return handleResponse(response);
}

/**
 * Generate recommendations from discovery results
 */
export async function generateConnectorRecommendations(
  connectorId: string,
  discoveryId: string,
): Promise<{ success: boolean; data: ConnectorRecommendation }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/recommendations`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ discoveryId }),
  });
  return handleResponse(response);
}

/**
 * Get latest recommendation for a connector
 */
export async function getConnectorRecommendation(
  connectorId: string,
): Promise<{ success: boolean; data: ConnectorRecommendation }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/recommendations`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Accept a recommendation and apply it
 */
export async function acceptConnectorRecommendation(
  connectorId: string,
  recommendationId: string,
  data: { overrides?: Record<string, unknown>; startSync?: boolean },
): Promise<{
  success: boolean;
  data: { connector: EnterpriseConnector; syncJobId: string | null; message: string };
}> {
  const response = await apiFetch(
    engineUrl(`/connectors/${connectorId}/recommendations/${recommendationId}/accept`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    },
  );
  return handleResponse(response);
}

/**
 * One-click quick setup: discover + profile + recommend + accept
 */
export async function quickSetupConnector(
  connectorId: string,
  data: { startSync?: boolean },
): Promise<{
  success: boolean;
  data: { discoveryId: string; jobId: string; status: string; startSync: boolean; message: string };
}> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/quick-setup`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Start sync for a connector
 */
export async function startConnectorSync(
  connectorId: string,
): Promise<{ success: boolean; data: { jobId: string; message: string } }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/sync/start`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Get connector sync status
 */
export async function getConnectorSyncStatus(
  connectorId: string,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/sync/status`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Get connector details with associated source
 */
export async function getConnectorDetails(
  indexId: string,
  connectorId: string,
): Promise<{
  success: boolean;
  data: { connector: EnterpriseConnector; source: SearchAISource | null };
}> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/connectors/${connectorId}`), {
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Update connector configuration (connectionConfig, filterConfig, permissionConfig)
 */
export async function updateConnectorConfig(
  indexId: string,
  connectorId: string,
  data: {
    connectionConfig?: Record<string, unknown>;
    filterConfig?: Record<string, unknown>;
    permissionConfig?: Record<string, unknown>;
  },
): Promise<{ success: boolean; data: { connector: EnterpriseConnector } }> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/connectors/${connectorId}`), {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  });
  return handleResponse(response);
}

/**
 * Pause connector sync
 */
export async function pauseConnectorSync(
  connectorId: string,
  reason?: string,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/sync/pause`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return handleResponse(response);
}

/**
 * Resume connector sync
 */
export async function resumeConnectorSync(
  connectorId: string,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/sync/resume`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

/**
 * Stop connector sync
 */
export async function stopConnectorSync(
  connectorId: string,
  reason?: string,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/sync/stop`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  return handleResponse(response);
}

/**
 * Save notification config for a connector
 */
export async function saveNotificationConfig(
  indexId: string,
  connectorId: string,
  config: Record<string, unknown>,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/notifications`),
    {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(config),
    },
  );
  return handleResponse(response);
}

/**
 * Test webhook for a connector
 */
export async function testConnectorWebhook(
  indexId: string,
  connectorId: string,
  url: string,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/notifications/test-webhook`),
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    },
  );
  return handleResponse(response);
}

/**
 * Trigger permission crawl for a connector
 */
export async function triggerPermissionCrawl(
  connectorId: string,
): Promise<{ success: boolean; data: Record<string, unknown> }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/permissions/crawl`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
  });
  return handleResponse(response);
}

// ─── Filter Templates & Preview ──────────────────────────────────────────

export interface FilterTemplate {
  id: string;
  name: string;
  description: string;
  connectorTypes: string[];
  category: string;
  filters: Record<string, unknown>;
}

/**
 * Get available filter templates for a connector
 */
export async function getFilterTemplates(
  connectorId: string,
): Promise<{ success: boolean; data: FilterTemplate[] }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/filters/templates`));
  return handleResponse(response);
}

/**
 * Apply a filter template to a connector
 */
export async function applyFilterTemplate(
  connectorId: string,
  templateId: string,
  merge: boolean = true,
): Promise<{
  success: boolean;
  data: { applied: string; templateName: string; filterConfig: unknown };
}> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/filters/apply-template`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ templateId, merge }),
  });
  return handleResponse(response);
}

/**
 * Preview filter impact
 */
export async function previewFilters(
  connectorId: string,
  filterConfig?: Record<string, unknown>,
): Promise<{
  success: boolean;
  data: {
    validation: { valid: boolean; errors: string[] };
    estimate: {
      totalDocumentsInSource: number | null;
      totalSitesInSource: number | null;
      discoveryDataAge: string | null;
      note: string;
    };
  };
}> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/filters/preview`), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filterConfig }),
  });
  return handleResponse(response);
}

/**
 * Validate connector filters
 */
export async function validateConnectorFilters(
  connectorId: string,
): Promise<{ success: boolean; valid: boolean; errors: string[] }> {
  const response = await apiFetch(engineUrl(`/connectors/${connectorId}/filters/validate`));
  return handleResponse(response);
}

// =============================================================================
// HEALTH SUMMARY API
// =============================================================================

export interface HealthSourceError {
  sourceId: string;
  sourceName: string;
  error: string;
  lastSyncAt: string | null;
}

export interface HealthSummaryResponse {
  sources: {
    total: number;
    syncing: number;
    errors: HealthSourceError[];
  };
  pipeline: {
    status: 'valid' | 'invalid' | 'pending' | 'not-configured';
    errors: Array<{ code: string; message: string; severity: string; path: string }>;
  };
  circuitBreaker: {
    state: string;
    failureRate: number;
    provider: string;
  } | null;
  documents: {
    total: number;
    errored: number;
    processing: number;
  };
  llm: {
    configured: boolean;
  };
}

export async function fetchHealthSummary(kbId: string): Promise<HealthSummaryResponse> {
  const res = await apiFetch(
    `/api/search-ai/knowledge-bases/${encodeURIComponent(kbId)}/health-summary`,
  );
  const json = await handleResponse<{ data: HealthSummaryResponse }>(res);
  return json.data;
}

// =============================================================================
// ACTIVITY FEED API
// =============================================================================

export interface ActivityItem {
  id: string;
  action: string;
  metadata: {
    resourceType: string;
    resourceId: string;
    [key: string]: unknown;
  };
  timestamp: string;
  userId: string;
}

export interface ActivityFeedResponse {
  activities: ActivityItem[];
  total: number;
  hasMore: boolean;
}

export async function fetchActivity(
  kbId: string,
  params?: { limit?: number; offset?: number },
): Promise<ActivityFeedResponse> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset != null) searchParams.set('offset', String(params.offset));
  const qs = searchParams.toString();
  const res = await apiFetch(
    `/api/search-ai/knowledge-bases/${encodeURIComponent(kbId)}/activity${qs ? `?${qs}` : ''}`,
  );
  const json = await handleResponse<{ data: ActivityFeedResponse }>(res);
  return json.data;
}

// =============================================================================
// QUERY HISTORY API
// =============================================================================

export interface QueryHistoryItem {
  queryId: string;
  queryType: string;
  queryText: string;
  resultCount: number;
  totalLatencyMs: number;
  vocabularyResolveMs: number;
  vectorSearchMs: number;
  rerankMs: number;
  cacheHit: boolean;
  timestamp: string;
  topK: number;
}

export interface QueryHistoryResponse {
  queries: QueryHistoryItem[];
  total: number;
  hasMore: boolean;
}

export async function fetchQueryHistory(
  indexId: string,
  params?: { limit?: number; offset?: number; from?: string; to?: string },
): Promise<QueryHistoryResponse> {
  const searchParams = new URLSearchParams();
  if (params?.limit) searchParams.set('limit', String(params.limit));
  if (params?.offset != null) searchParams.set('offset', String(params.offset));
  if (params?.from) searchParams.set('from', params.from);
  if (params?.to) searchParams.set('to', params.to);
  const qs = searchParams.toString();
  const res = await apiFetch(
    `/api/search-ai/indexes/${encodeURIComponent(indexId)}/query-history${qs ? `?${qs}` : ''}`,
  );
  // Transform ClickHouse string values to proper types
  const json = await handleResponse<{ data: Record<string, unknown> }>(res);
  const data = json.data as { queries: Record<string, string>[]; total: number; hasMore: boolean };
  return {
    queries: (data.queries || []).map((q: Record<string, string>) => ({
      queryId: q.query_id,
      queryType: q.query_type,
      queryText: q.query_text,
      resultCount: parseInt(q.result_count || '0', 10),
      totalLatencyMs: parseInt(q.total_latency_ms || '0', 10),
      vocabularyResolveMs: parseInt(q.vocabulary_resolve_ms || '0', 10),
      vectorSearchMs: parseInt(q.vector_search_ms || '0', 10),
      rerankMs: parseInt(q.rerank_ms || '0', 10),
      cacheHit: q.cache_hit === '1',
      timestamp: q.timestamp,
      topK: parseInt(q.top_k || '10', 10),
    })),
    total: data.total,
    hasMore: data.hasMore,
  };
}

// =============================================================================
// ATTRIBUTE API
// =============================================================================

export async function getAttributes(indexId: string, filters?: AttributeFilters) {
  const params = new URLSearchParams();
  if (filters?.tier) params.set('tier', filters.tier);
  if (filters?.product) params.set('product', filters.product);
  if (filters?.dataType) params.set('dataType', filters.dataType);
  if (filters?.search) params.set('search', filters.search);
  if (filters?.page) params.set('page', String(filters.page));
  if (filters?.limit) params.set('limit', String(filters.limit));
  const qs = params.toString() ? `?${params.toString()}` : '';
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes${qs}`)).then(handleResponse);
}

export async function getAttributeDetail(indexId: string, id: string) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/${id}`)).then(handleResponse);
}

export async function updateAttribute(
  indexId: string,
  id: string,
  data: Partial<{
    tier: AttributeTier;
    displayName: string;
    aliases: string[];
    definition: string;
  }>,
) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/${id}`), {
    method: 'PATCH',
    body: JSON.stringify(data),
    headers: { 'Content-Type': 'application/json' },
  }).then(handleResponse);
}

export async function getReviewQueue(indexId: string) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/review-queue`)).then(handleResponse);
}

export async function getAttributeStats(indexId: string) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/stats`)).then(handleResponse);
}

export async function bulkAttributeAction(
  indexId: string,
  action: 'approve' | 'discard' | 'changeTier',
  attributeIds: string[],
  targetTier?: AttributeTier,
) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/bulk`), {
    method: 'POST',
    body: JSON.stringify({ action, attributeIds, targetTier }),
    headers: { 'Content-Type': 'application/json' },
  }).then(handleResponse);
}

export async function mergeAttributes(
  indexId: string,
  sourceId: string,
  targetId: string,
  primaryId: string,
) {
  return apiFetch(engineUrl(`/indexes/${indexId}/attributes/merge`), {
    method: 'POST',
    body: JSON.stringify({ sourceId, targetId, primaryId }),
    headers: { 'Content-Type': 'application/json' },
  }).then(handleResponse);
}

// =============================================================================
// BROWSE API
// =============================================================================

export async function getBrowseTaxonomy(indexId: string, includeBeta = true) {
  return apiFetch(
    runtimeUrl(`/search/${indexId}/browse/taxonomy?include_beta=${includeBeta}`),
  ).then(handleResponse);
}

export async function getBrowseFacets(
  indexId: string,
  attribute: string,
  product?: string,
  limit = 50,
) {
  const params = new URLSearchParams({
    attribute,
    limit: String(limit),
  });
  if (product) params.set('product', product);
  return apiFetch(runtimeUrl(`/search/${indexId}/browse/facets?${params}`)).then(handleResponse);
}

export async function postBrowseFacetCounts(
  indexId: string,
  documentIds: string[],
  product?: string,
) {
  return apiFetch(runtimeUrl(`/search/${indexId}/browse/facet-counts`), {
    method: 'POST',
    body: JSON.stringify({ documentIds, product }),
    headers: { 'Content-Type': 'application/json' },
  }).then(handleResponse);
}

export async function getBrowseFacetDocuments(
  indexId: string,
  attributeType: string,
  value: string,
  product?: string,
  limit = 20,
) {
  const params = new URLSearchParams({
    value,
    limit: String(limit),
  });
  if (product) params.set('product', product);
  return apiFetch(
    runtimeUrl(`/search/${indexId}/browse/facets/${attributeType}/documents?${params}`),
  ).then(handleResponse);
}

export async function postBrowseInteraction(
  indexId: string,
  events: Array<{
    attributeType?: string;
    productType?: string;
    facetValue?: string;
    categoryId?: string;
    interactionType: string;
    sessionId?: string;
  }>,
) {
  return apiFetch(runtimeUrl(`/search/${indexId}/browse/interactions`), {
    method: 'POST',
    body: JSON.stringify({ events }),
    headers: { 'Content-Type': 'application/json' },
  }).then(handleResponse);
}

// =============================================================================
// JSON FIELD SELECTION
// =============================================================================

export interface JsonFieldPreview {
  fieldPath: string;
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  sampleValues: string[];
  /** Max character length seen across sampled records (un-truncated) */
  maxLength: number;
  suggested: boolean;
  suggestReason?: string;
  /** Auto-suggested canonical field mapping from the rule-based mapping pipeline */
  suggestedMapping?: {
    canonicalField: string;
    confidence: number;
    displayLabel: string;
    reasoning: string;
  } | null;
}

export interface CanonicalFieldOption {
  value: string;
  label: string;
  type: string;
  group?: 'core' | 'common' | 'custom';
}

export interface JsonSchemaPreviewResponse {
  fields: JsonFieldPreview[];
  /** Available canonical fields for the mapping dropdown */
  availableCanonicalFields?: CanonicalFieldOption[];
  recordCount: number;
  sampleCount: number;
  hasExistingConfig: boolean;
  existingConfig: {
    version: number;
    fields: Array<{
      fieldPath: string;
      fieldType: string;
      selected: boolean;
      sampleValues: string[];
      /** User's previously saved mapping override (persisted across uploads) */
      mappingOverride?: string;
      /** Final resolved canonical mapping (auto-suggest or manual) — persisted across uploads */
      canonicalMapping?: string;
    }>;
    autoSuggestApplied: boolean;
  } | null;
  /** True when all fields in the new file match the existing config — no user input needed */
  allFieldsKnown?: boolean;
  /** Field paths that are new (not in existing config) — only populated when hasExistingConfig */
  newFieldPaths?: string[];
}

export interface JsonFieldConfigPayload {
  fields: Array<{
    fieldPath: string;
    fieldType: string;
    selected: boolean;
    sampleValues?: string[];
    maxLength?: number;
    /** User-overridden canonical field mapping (if changed from auto-suggestion) */
    mappingOverride?: string;
    /** Final resolved canonical mapping (auto-suggest or manual) — persisted across uploads */
    canonicalMapping?: string;
  }>;
  autoSuggestApplied: boolean;
}

/**
 * Upload a JSON file and get schema preview with auto-suggestions.
 * Does NOT process the file — just previews fields for user selection.
 */
export async function fetchJsonSchemaPreview(
  indexId: string,
  file: File,
): Promise<JsonSchemaPreviewResponse> {
  const formData = new FormData();
  formData.append('file', file);
  // CRITICAL: Do NOT set Content-Type — browser must set multipart/form-data with boundary.
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/json-schema-preview`), {
    method: 'POST',
    body: formData,
  });
  const data = await handleResponse<{ data: JsonSchemaPreviewResponse }>(response);
  return data.data;
}

/**
 * Get current JSON field config for an index.
 */
export async function fetchJsonFieldConfig(
  indexId: string,
): Promise<JsonSchemaPreviewResponse['existingConfig']> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/json-field-config`));
  const data = await handleResponse<{
    data: JsonSchemaPreviewResponse['existingConfig'];
  }>(response);
  return data.data;
}

/**
 * Re-discover fields from a pending JSON document's stored file.
 * Used when user clicks "Configure Fields" on a pending document.
 */
export async function rediscoverJsonFields(indexId: string): Promise<JsonSchemaPreviewResponse> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/json-field-config/rediscover`));
  const data = await handleResponse<{ data: JsonSchemaPreviewResponse }>(response);
  return data.data;
}

/**
 * Save user's field selections. Triggers processing of pending JSON docs.
 */
export async function saveJsonFieldConfig(
  indexId: string,
  payload: JsonFieldConfigPayload,
): Promise<{
  version: number;
  fieldCount: number;
  selectedCount: number;
  pendingDocsEnqueued: number;
}> {
  const response = await apiFetch(engineUrl(`/indexes/${indexId}/json-field-config`), {
    method: 'PUT',
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' },
  });
  const data = await handleResponse<{
    data: {
      version: number;
      fieldCount: number;
      selectedCount: number;
      pendingDocsEnqueued: number;
    };
  }>(response);
  return data.data;
}

// ─── Connector Pre-Sync Field Mapping ────────────────────────────────────

export interface ConnectorFieldPreviewItem {
  sourcePath: string;
  displayName: string;
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'array';
  sampleValues: string[];
  suggestedMapping: {
    canonicalField: string;
    confidence: number;
    displayLabel: string;
    reasoning: string;
  } | null;
  suggestedForEmbedding: boolean;
  source: 'template' | 'introspection' | 'merged';
}

export interface ConnectorFieldPreviewResponse {
  fields: ConnectorFieldPreviewItem[];
  availableCanonicalFields: CanonicalFieldOption[];
  connectorType: string;
  hasIntrospectionData: boolean;
  templateFieldCount: number;
  introspectedFieldCount: number;
  existingConfig: ConnectorFieldConfig | null;
}

export interface ConnectorFieldConfig {
  version: number;
  fields: Array<{
    sourcePath: string;
    displayName: string;
    fieldType: string;
    selected: boolean;
    includeInEmbedding: boolean;
    canonicalMapping: string | null;
    confidence: number;
    mappingSource: string;
    sampleValues?: string[];
  }>;
  updatedAt: string;
  autoSuggestApplied: boolean;
  source: 'template' | 'introspection' | 'merged';
}

/**
 * Get field preview for a connector (pre-sync field mapping).
 * Returns template-based + introspected fields with auto-mapping suggestions.
 */
export async function getConnectorFieldPreview(
  indexId: string,
  connectorId: string,
): Promise<ConnectorFieldPreviewResponse> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/field-preview`),
  );
  const data = await handleResponse<{ data: ConnectorFieldPreviewResponse }>(response);
  return data.data;
}

/**
 * Save connector field configuration before sync.
 * Creates FieldMapping + CanonicalSchema records for mapped fields.
 */
export async function saveConnectorFieldConfig(
  indexId: string,
  connectorId: string,
  payload: {
    fields: Array<{
      sourcePath: string;
      displayName: string;
      fieldType: string;
      selected: boolean;
      includeInEmbedding: boolean;
      canonicalMapping: string | null;
      confidence: number;
      mappingSource: string;
      sampleValues?: string[];
    }>;
    autoSuggestApplied?: boolean;
  },
): Promise<{
  version: number;
  fieldCount: number;
  selectedCount: number;
  embeddingFieldCount: number;
  mappingCount: number;
}> {
  const response = await apiFetch(
    engineUrl(`/indexes/${indexId}/connectors/${connectorId}/field-config`),
    {
      method: 'PUT',
      body: JSON.stringify(payload),
      headers: { 'Content-Type': 'application/json' },
    },
  );
  const data = await handleResponse<{
    data: {
      version: number;
      fieldCount: number;
      selectedCount: number;
      embeddingFieldCount: number;
      mappingCount: number;
    };
  }>(response);
  return data.data;
}
