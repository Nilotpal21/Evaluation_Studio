/**
 * SearchAI Client
 *
 * HTTP client for communicating with the SearchAI Runtime and SearchAI services.
 * Used by agent runtime (search tools), Studio (proxy), and MCP CLI.
 */

import type {
  VectorSearchQuery,
  StructuredSearchQuery,
  AggregationQuery,
  SuggestQuery,
  SimilarQuery,
  SearchResponse,
  AggregationResponse,
  SearchResult,
  VocabularyResolutionResult,
  SearchIndexSummary,
  SearchIndexDetail,
  SearchSourceSummary,
  SourceConfig,
  CanonicalSchemaSummary,
  CanonicalField,
  SourceFieldMapping,
  VocabularySummary,
  VocabularyEntry,
  IngestionProgress,
} from './types/index.js';
import { SearchError } from './errors.js';

// Observability context for trace propagation (lazy import to avoid hard dependency)
let _getObservabilityContext:
  | (() => { traceId: string; spanId: string } | undefined)
  | null
  | undefined;
function getObservabilityContextSafe(): { traceId: string; spanId: string } | undefined {
  if (_getObservabilityContext === null) return undefined;
  if (_getObservabilityContext) return _getObservabilityContext();
  // Not yet resolved — will be set on first call via lazy init
  return undefined;
}
// Lazy init: resolve import once. Exported for tests to await deterministically.
export const _observabilityReady = import('@abl/compiler/platform/observability')
  .then((mod) => {
    _getObservabilityContext = mod.getObservabilityContext as typeof _getObservabilityContext;
  })
  .catch(() => {
    _getObservabilityContext = null; // @abl/compiler not available
  });

/**
 * Format a W3C traceparent header from trace/span IDs.
 * Inlined to avoid a hard dependency on shared-observability in this SDK package.
 * Matches the format from @agent-platform/shared-observability/tracing formatTraceparent.
 */
function formatTraceparentHeader(traceId: string, spanId: string): string {
  return `00-${traceId}-${spanId}-01`;
}

// ─── Client Configuration ────────────────────────────────────────────────────

export interface SearchAIClientConfig {
  /** Search Runtime base URL (e.g., http://localhost:3004) */
  runtimeUrl: string;
  /** Search Engine base URL (e.g., http://localhost:3005) */
  engineUrl: string;
  /** Auth token (JWT or API key) */
  authToken?: string;
  /** Request timeout in ms */
  timeoutMs?: number;
  /** Custom headers */
  headers?: Record<string, string>;
}

// ─── Document Ingestion Types ────────────────────────────────────────────────

export interface IngestDocumentResult {
  documentId: string;
  title: string;
  chunkCount: number;
}

interface IngestDocumentResponse {
  results: IngestDocumentResult[];
  totalDocuments: number;
  totalChunks: number;
  errors?: Array<{ documentId?: string; message: string }>;
}

// ─── Search Client ───────────────────────────────────────────────────────────

export class SearchAIClient {
  private readonly runtimeUrl: string;
  private readonly engineUrl: string;
  private readonly authToken?: string;
  private readonly timeoutMs: number;
  private readonly headers: Record<string, string>;

  constructor(config: SearchAIClientConfig) {
    this.runtimeUrl = config.runtimeUrl.replace(/\/$/, '');
    this.engineUrl = config.engineUrl.replace(/\/$/, '');
    this.authToken = config.authToken;
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.headers = config.headers ?? {};
  }

  // ─── Query API (Search Runtime) ──────────────────────────────────────

  async vectorSearch(query: VectorSearchQuery): Promise<SearchResponse> {
    return this.post(`${this.runtimeUrl}/api/search/${query.indexId}/query`, query);
  }

  async structuredSearch(query: StructuredSearchQuery): Promise<SearchResponse> {
    return this.post(`${this.runtimeUrl}/api/search/${query.indexId}/structured`, query);
  }

  async aggregate(query: AggregationQuery): Promise<AggregationResponse> {
    return this.post(`${this.runtimeUrl}/api/search/${query.indexId}/aggregate`, query);
  }

  async suggest(query: SuggestQuery): Promise<SearchResult[]> {
    return this.post(`${this.runtimeUrl}/api/search/${query.indexId}/suggest`, query);
  }

  async findSimilar(query: SimilarQuery): Promise<SearchResponse> {
    return this.post(`${this.runtimeUrl}/api/search/${query.indexId}/similar`, query);
  }

  async resolveVocabulary(
    projectKbId: string,
    query: string,
    mode?: 'exact' | 'alias' | 'fuzzy',
  ): Promise<VocabularyResolutionResult> {
    return this.post(`${this.runtimeUrl}/api/search/${projectKbId}/resolve`, { query, mode });
  }

  /**
   * Discover KB capabilities (vocabulary, classification, filters, etc.)
   * Used by agents at session start to build dynamic tool descriptions.
   */
  async discover(indexId: string): Promise<any> {
    return this.get(`${this.runtimeUrl}/api/search/${indexId}/discover`);
  }

  /**
   * Unified search endpoint supporting all 4 query types.
   * Used by KB-as-tool executor for all search operations.
   */
  async unifiedSearch(indexId: string, body: Record<string, unknown>): Promise<any> {
    return this.post(`${this.runtimeUrl}/api/search/${indexId}/query`, body);
  }

  // ─── Admin API (Search Engine) ───────────────────────────────────────

  async listIndexes(): Promise<SearchIndexSummary[]> {
    return this.get(`${this.engineUrl}/api/indexes`);
  }

  async getIndex(indexId: string): Promise<SearchIndexDetail> {
    return this.get(`${this.engineUrl}/api/indexes/${indexId}`);
  }

  async createIndex(input: {
    name: string;
    slug: string;
    projectId: string;
    description?: string;
    config: Partial<import('./types/search-index.js').SearchIndexConfig>;
  }): Promise<SearchIndexDetail> {
    return this.post(`${this.engineUrl}/api/indexes`, input);
  }

  async updateIndex(indexId: string, update: Record<string, unknown>): Promise<SearchIndexDetail> {
    return this.patch(`${this.engineUrl}/api/indexes/${indexId}`, update);
  }

  async deleteIndex(indexId: string): Promise<void> {
    return this.del(`${this.engineUrl}/api/indexes/${indexId}`);
  }

  async rebuildIndex(indexId: string): Promise<{ jobId: string }> {
    return this.post(`${this.engineUrl}/api/indexes/${indexId}/rebuild`, {});
  }

  // ─── Document Ingestion ───────────────────────────────────────────────

  async ingestDocument(
    indexId: string,
    document: { title: string; rawText: string; sourceMetadata?: Record<string, unknown> },
  ): Promise<IngestDocumentResult> {
    const response = await this.post<IngestDocumentResponse>(
      `${this.engineUrl}/api/indexes/${indexId}/documents/ingest`,
      { documents: [document] },
    );

    const result = response.results[0];
    if (!result) {
      throw new SearchError('Ingestion returned no results', 500);
    }
    return result;
  }

  // ─── Source Management ───────────────────────────────────────────────

  async listSources(indexId: string): Promise<SearchSourceSummary[]> {
    return this.get(`${this.engineUrl}/api/indexes/${indexId}/sources`);
  }

  async addSource(
    indexId: string,
    config: SourceConfig & { name: string },
  ): Promise<SearchSourceSummary> {
    return this.post(`${this.engineUrl}/api/indexes/${indexId}/sources`, config);
  }

  async removeSource(indexId: string, sourceId: string): Promise<void> {
    return this.del(`${this.engineUrl}/api/indexes/${indexId}/sources/${sourceId}`);
  }

  async getIngestionStatus(indexId: string, sourceId: string): Promise<IngestionProgress> {
    return this.get(`${this.engineUrl}/api/indexes/${indexId}/sources/${sourceId}/status`);
  }

  /**
   * Upload a document file to a source
   *
   * @param indexId - The search index ID
   * @param sourceId - The source ID
   * @param file - The file to upload (File or Blob)
   * @param options - Optional metadata and force flag
   * @returns Upload result with document ID and status
   */
  async uploadDocument(
    indexId: string,
    sourceId: string,
    file: File | Blob,
    options?: {
      metadata?: Record<string, unknown>;
      force?: boolean;
      filename?: string;
    },
  ): Promise<{
    id: string;
    originalReference: string;
    contentType: string;
    contentSizeBytes: number;
    status: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
  }> {
    const formData = new FormData();

    // Add file with optional custom filename
    if (options?.filename) {
      formData.append('file', file, options.filename);
    } else if (file instanceof File) {
      formData.append('file', file);
    } else {
      // Blob without name - provide a default
      formData.append('file', file, 'document.bin');
    }

    // Add metadata if provided
    if (options?.metadata) {
      formData.append('metadata', JSON.stringify(options.metadata));
    }

    // Add force flag if provided
    if (options?.force) {
      formData.append('force', 'true');
    }

    const url = `${this.engineUrl}/api/indexes/${indexId}/sources/${sourceId}/documents`;

    // Use specialized request for FormData (don't set Content-Type)
    return this.upload(url, formData);
  }

  // ─── Schema Management ──────────────────────────────────────────────

  async getConnectorSchema(
    connectorId: string,
  ): Promise<{ fields: import('./types/schema.js').ConnectorSchemaField[]; version: number }> {
    return this.get(`${this.engineUrl}/api/schemas/connectors/${connectorId}`);
  }

  async getCanonicalSchema(
    knowledgeBaseId: string,
  ): Promise<CanonicalSchemaSummary & { fields: CanonicalField[] }> {
    return this.get(`${this.engineUrl}/api/schemas/${knowledgeBaseId}`);
  }

  async updateCanonicalSchema(
    knowledgeBaseId: string,
    fields: CanonicalField[],
  ): Promise<CanonicalSchemaSummary> {
    return this.patch(`${this.engineUrl}/api/schemas/${knowledgeBaseId}`, { fields });
  }

  // ─── Mapping Management ─────────────────────────────────────────────

  async listMappings(canonicalSchemaId: string): Promise<SourceFieldMapping[]> {
    return this.get(`${this.engineUrl}/api/mappings?schemaId=${canonicalSchemaId}`);
  }

  async suggestMappings(
    canonicalSchemaId: string,
    connectorId: string,
  ): Promise<SourceFieldMapping[]> {
    return this.post(`${this.engineUrl}/api/mappings/suggest`, { canonicalSchemaId, connectorId });
  }

  async confirmMapping(mappingId: string): Promise<SourceFieldMapping> {
    return this.post(`${this.engineUrl}/api/mappings/${mappingId}/confirm`, {});
  }

  async rejectMapping(mappingId: string): Promise<SourceFieldMapping> {
    return this.post(`${this.engineUrl}/api/mappings/${mappingId}/reject`, {});
  }

  async testMapping(
    mappingId: string,
    sampleDocuments?: unknown[],
  ): Promise<{ results: unknown[] }> {
    return this.post(`${this.engineUrl}/api/mappings/${mappingId}/test`, { sampleDocuments });
  }

  // ─── Vocabulary Management ──────────────────────────────────────────

  async getVocabulary(
    projectKbId: string,
  ): Promise<VocabularySummary & { entries: VocabularyEntry[] }> {
    return this.get(`${this.engineUrl}/api/vocabularies/${projectKbId}`);
  }

  async createVocabularyEntry(
    projectKbId: string,
    entry: VocabularyEntry,
  ): Promise<VocabularyEntry> {
    return this.post(`${this.engineUrl}/api/vocabularies/${projectKbId}/entries`, entry);
  }

  async updateVocabularyEntry(
    projectKbId: string,
    term: string,
    entry: Partial<VocabularyEntry>,
  ): Promise<VocabularyEntry> {
    return this.patch(
      `${this.engineUrl}/api/vocabularies/${projectKbId}/entries/${encodeURIComponent(term)}`,
      entry,
    );
  }

  async deleteVocabularyEntry(projectKbId: string, term: string): Promise<void> {
    return this.del(
      `${this.engineUrl}/api/vocabularies/${projectKbId}/entries/${encodeURIComponent(term)}`,
    );
  }

  async suggestVocabulary(projectKbId: string): Promise<VocabularyEntry[]> {
    return this.post(`${this.engineUrl}/api/vocabularies/${projectKbId}/suggest`, {});
  }

  async testVocabularyQuery(
    projectKbId: string,
    query: string,
  ): Promise<VocabularyResolutionResult> {
    return this.post(`${this.engineUrl}/api/vocabularies/${projectKbId}/test`, { query });
  }

  async deleteDocument(indexId: string, documentId: string): Promise<void> {
    return this.del(
      `${this.engineUrl}/api/indexes/${encodeURIComponent(indexId)}/documents/${encodeURIComponent(documentId)}`,
    );
  }

  // ─── HTTP Helpers ────────────────────────────────────────────────────

  private buildHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...this.headers,
    };
    if (this.authToken) {
      headers['Authorization'] = `Bearer ${this.authToken}`;
    }

    // Inject W3C traceparent and X-Trace-Id for cross-service trace propagation
    const obsCtx = getObservabilityContextSafe();
    if (obsCtx?.traceId) {
      headers['traceparent'] = formatTraceparentHeader(obsCtx.traceId, obsCtx.spanId);
      headers['X-Trace-Id'] = obsCtx.traceId;
    }

    return headers;
  }

  private async request<T>(url: string, options: RequestInit): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(url, {
        ...options,
        headers: this.buildHeaders(),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new SearchError(
          `Search API error: ${response.status} ${response.statusText} — ${body}`,
          response.status,
        );
      }

      if (response.status === 204) return undefined as T;
      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof SearchError) throw err;
      if (
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        throw new SearchError(`Request to ${url} timed out after ${this.timeoutMs}ms`, 408);
      }
      throw new SearchError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private get<T>(url: string): Promise<T> {
    return this.request(url, { method: 'GET' });
  }

  private post<T>(url: string, body: unknown): Promise<T> {
    return this.request(url, { method: 'POST', body: JSON.stringify(body) });
  }

  private patch<T>(url: string, body: unknown): Promise<T> {
    return this.request(url, { method: 'PATCH', body: JSON.stringify(body) });
  }

  private del<T>(url: string): Promise<T> {
    return this.request(url, { method: 'DELETE' });
  }

  /**
   * Upload with FormData (don't set Content-Type to let browser set multipart boundary)
   */
  private async upload<T>(url: string, formData: FormData): Promise<T> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      // Build headers WITHOUT Content-Type (browser will set it with boundary)
      const headers: Record<string, string> = {
        ...this.headers,
      };
      if (this.authToken) {
        headers['Authorization'] = `Bearer ${this.authToken}`;
      }

      // Inject W3C traceparent and X-Trace-Id for cross-service trace propagation
      const obsCtx = getObservabilityContextSafe();
      if (obsCtx?.traceId) {
        headers['traceparent'] = formatTraceparentHeader(obsCtx.traceId, obsCtx.spanId);
        headers['X-Trace-Id'] = obsCtx.traceId;
      }

      const response = await fetch(url, {
        method: 'POST',
        headers,
        body: formData,
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => '');
        throw new SearchError(
          `Search API error: ${response.status} ${response.statusText} — ${body}`,
          response.status,
        );
      }

      return (await response.json()) as T;
    } catch (err) {
      if (err instanceof SearchError) throw err;
      if (
        (err instanceof DOMException && err.name === 'AbortError') ||
        (err instanceof Error && err.name === 'AbortError')
      ) {
        throw new SearchError(`Request to ${url} timed out after ${this.timeoutMs}ms`, 408);
      }
      throw new SearchError(
        `Network error: ${err instanceof Error ? err.message : String(err)}`,
        502,
      );
    } finally {
      clearTimeout(timeoutId);
    }
  }
}
