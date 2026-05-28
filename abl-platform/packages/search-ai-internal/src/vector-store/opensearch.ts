/**
 * OpenSearch Vector Store Provider
 *
 * Implementation using OpenSearch k-NN plugin for vector search.
 * Requires `@opensearch-project/opensearch` as a peer dependency in consuming apps.
 */

import { Client as OpenSearchClient } from '@opensearch-project/opensearch';
import type {
  VectorStoreProvider,
  VectorRecord,
  VectorSearchParams,
  VectorSearchResult,
  HybridSearchParams,
  CollectionConfig,
  CollectionInfo,
} from './interface.js';
import type { MetadataFilter } from '@agent-platform/search-ai-sdk/types';
import { getVectorIndexMapping } from './opensearch-mappings.js';
import { createLogger } from '@abl/compiler/platform';

type OpenSearchCreateIndexBody = NonNullable<
  Parameters<OpenSearchClient['indices']['create']>[0]['body']
>;
type OpenSearchProperty = NonNullable<
  NonNullable<NonNullable<OpenSearchCreateIndexBody['mappings']>['properties']>[string]
>;
type OpenSearchKnnVectorProperty = Extract<OpenSearchProperty, { type: 'knn_vector' }>;

export interface OpenSearchConfig {
  url: string;
  apiKey?: string;
  /** Timeout for requests in ms */
  timeoutMs?: number;
}

// ─── Cluster-Aware Shard/Replica Derivation ─────────────────────────────────
// Derives optimal shard and replica count from OPENSEARCH_DATA_NODES env var
// (injected by Helm from opensearch.dataNodes.replicas).
//
// Priority chain:
//   1. OPENSEARCH_SHARED_SHARDS / OPENSEARCH_SHARED_REPLICAS (explicit override)
//   2. Derived from OPENSEARCH_DATA_NODES (shards = nodes, replicas = nodes > 1 ? 1 : 0)
//   3. Fallback: shards = 1, replicas = 1 (backward-compatible default)

/**
 * Derive the optimal number of shards and replicas based on the
 * configured OpenSearch data node count in the cluster.
 *
 * Formula:
 *   shards  = dataNodes (1 shard per node for full parallelism)
 *   replicas = dataNodes > 1 ? 1 : 0 (1 copy for HA, 0 for single-node dev)
 *
 * Env var priority:
 *   OPENSEARCH_SHARED_SHARDS > derived from OPENSEARCH_DATA_NODES > default 1
 *   OPENSEARCH_SHARED_REPLICAS > derived from OPENSEARCH_DATA_NODES > default 1
 */
export function deriveShardConfig(): { shards: number; replicas: number } {
  const dataNodes = parseInt(process.env.OPENSEARCH_DATA_NODES || '0', 10);

  // If OPENSEARCH_DATA_NODES is set, derive from it
  if (dataNodes > 0) {
    const derivedShards = dataNodes;
    const derivedReplicas = dataNodes > 1 ? 1 : 0;

    // Explicit overrides take precedence
    const shards = process.env.OPENSEARCH_SHARED_SHARDS
      ? parseInt(process.env.OPENSEARCH_SHARED_SHARDS, 10)
      : derivedShards;

    const replicas = process.env.OPENSEARCH_SHARED_REPLICAS
      ? parseInt(process.env.OPENSEARCH_SHARED_REPLICAS, 10)
      : derivedReplicas;

    return { shards, replicas };
  }

  // Fallback: explicit env vars or hardcoded defaults (backward-compatible)
  return {
    shards: parseInt(process.env.OPENSEARCH_SHARED_SHARDS || '1', 10),
    replicas: parseInt(process.env.OPENSEARCH_SHARED_REPLICAS || '1', 10),
  };
}

function isKnnVectorProperty(property: unknown): property is OpenSearchKnnVectorProperty {
  return (
    typeof property === 'object' &&
    property !== null &&
    'type' in property &&
    (property as { type?: unknown }).type === 'knn_vector'
  );
}

function getTotalHitsValue(
  total: number | { value: number } | undefined,
  fallback: number,
): number {
  if (typeof total === 'number') {
    return total;
  }

  return total?.value ?? fallback;
}

const logger = createLogger('OpenSearchVectorStore');

export class OpenSearchVectorStore implements VectorStoreProvider {
  readonly name = 'opensearch';
  private readonly client: OpenSearchClient;
  private readonly timeoutMs: number;

  constructor(config: OpenSearchConfig) {
    this.client = new OpenSearchClient({
      node: config.url,
      // OpenSearch client auth: uses username/password, not apiKey directly
      // For API key auth, pass as header in the node URL or use plugin
      auth: config.apiKey
        ? {
            username: 'admin',
            password: config.apiKey,
          }
        : undefined,
      requestTimeout: config.timeoutMs ?? 30_000,
      // OPTIMIZATION: Connection pooling to reuse TCP connections (saves 5-10ms per query)
      // Without this, each query creates a new TCP connection (3-way handshake + TLS)
      agent: {
        keepAlive: true,
        keepAliveMsecs: 60_000, // Keep connections alive for 60s
        maxSockets: 256, // Max concurrent connections
        maxFreeSockets: 128, // Max idle connections in pool
      },
      // OPTIMIZATION: Enable response compression (saves 2-5ms on large result sets)
      compression: 'gzip',
    });
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async createCollection(config: CollectionConfig): Promise<void> {
    // Derive shard/replica count from cluster topology (OPENSEARCH_DATA_NODES)
    // or explicit env overrides (OPENSEARCH_SHARED_SHARDS/REPLICAS)
    const { shards, replicas } = deriveShardConfig();

    const mappingTemplate = getVectorIndexMapping({
      dimensions: config.dimensions,
      distance: config.distance,
      shards,
      replicas,
      refreshInterval: process.env.OPENSEARCH_REFRESH_INTERVAL || '5s',
    }) as OpenSearchCreateIndexBody;

    await this.client.indices.create({
      index: config.name,
      body: mappingTemplate,
    });

    logger.info(
      `Created index ${config.name} with strict mappings (${config.dimensions}d, ${config.distance}, ${shards} shards, ${replicas} replicas)`,
    );
  }

  async deleteCollection(name: string): Promise<void> {
    await this.client.indices.delete({ index: name });
  }

  async getCollectionInfo(name: string): Promise<CollectionInfo | null> {
    try {
      const statsResponse = await this.client.indices.stats({ index: name });
      const mappingResponse = await this.client.indices.getMapping({ index: name });

      const stats = statsResponse.body.indices?.[name];
      const mapping = mappingResponse.body[name]?.mappings?.properties?.vector;

      if (!stats || !isKnnVectorProperty(mapping)) {
        return null;
      }

      return {
        name,
        vectorCount: stats.total?.docs?.count ?? 0,
        dimensions: mapping.dimension ?? 0,
        distance: mapping.method?.space_type ?? 'unknown',
        status: 'ready',
      };
    } catch {
      return null;
    }
  }

  async collectionExists(name: string): Promise<boolean> {
    try {
      const response = await this.client.indices.exists({ index: name });
      return response.body;
    } catch {
      return false;
    }
  }

  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    const batchSize = 100;
    for (let i = 0; i < records.length; i += batchSize) {
      const batch = records.slice(i, i + batchSize);
      const bulkBody = batch.flatMap((r) => [
        { index: { _index: collection, _id: r.id } },
        {
          vector: r.vector,
          metadata: r.metadata ?? {},
          content: r.content ?? '',
          ...(r.permissions ? { permissions: r.permissions } : {}),
        },
      ]);

      const response = await this.client.bulk({
        body: bulkBody,
        refresh: 'wait_for',
      });

      // Check for errors in bulk response
      if (response.body.errors) {
        const failedItems = response.body.items.filter((item: any) => item.index?.error);
        const errorDetails = failedItems
          .map((item: any) => `${item.index._id}: ${JSON.stringify(item.index.error)}`)
          .join('; ');
        throw new Error(
          `OpenSearch bulk upsert failed for ${failedItems.length}/${batch.length} items in collection ${collection}: ${errorDetails}`,
        );
      }
    }
  }

  async search(collection: string, params: VectorSearchParams): Promise<VectorSearchResult[]> {
    const query: any = {
      bool: {
        must: [
          {
            knn: {
              vector: {
                vector: params.vector,
                k: params.topK,
              },
            },
          },
        ],
      },
    };

    // Add metadata filters if provided
    if (params.filters?.length) {
      const filterClauses = this.buildFilter(params.filters);
      if (filterClauses.must.length > 0) {
        query.bool.must.push(...filterClauses.must);
      }
      if (filterClauses.must_not.length > 0) {
        query.bool.must_not = filterClauses.must_not;
      }
    }

    const response = await this.client.search({
      index: collection,
      body: {
        size: params.topK,
        query,
        min_score: params.scoreThreshold,
      },
    });

    return response.body.hits.hits.map((hit: any) => ({
      id: hit._id,
      score: hit._score,
      metadata: params.includeMetadata !== false ? hit._source.metadata : undefined,
      vector: params.includeVectors ? hit._source.vector : undefined,
      content: hit._source.content,
    }));
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    const bulkBody = ids.flatMap((id) => [{ delete: { _index: collection, _id: id } }]);
    await this.client.bulk({ body: bulkBody });
  }

  async deleteByFilter(collection: string, filters: MetadataFilter[]): Promise<void> {
    const filterClauses = this.buildFilter(filters);
    const query: any = { bool: {} };

    if (filterClauses.must.length > 0) {
      query.bool.must = filterClauses.must;
    }
    if (filterClauses.must_not.length > 0) {
      query.bool.must_not = filterClauses.must_not;
    }

    await this.client.deleteByQuery({
      index: collection,
      body: { query },
    });
  }

  async getByIds(collection: string, ids: string[]): Promise<VectorRecord[]> {
    const response = await this.client.mget({
      index: collection,
      body: { ids },
    });

    return response.body.docs
      .filter((doc: any) => doc.found)
      .map((doc: any) => ({
        id: doc._id,
        vector: doc._source.vector,
        metadata: doc._source.metadata,
        content: doc._source.content,
      }));
  }

  async count(collection: string): Promise<number> {
    const response = await this.client.count({ index: collection });
    return response.body.count ?? 0;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.client.cluster.health();
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  // ─── Hybrid Search (RFC-003) ────────────────────────────────────────────

  /**
   * Hybrid search combining vector similarity and BM25 keyword matching.
   * Supports both RRF (native OpenSearch 2.11+) and RSF (client-side) fusion.
   */
  async hybridSearch(
    collection: string,
    params: HybridSearchParams,
  ): Promise<VectorSearchResult[]> {
    const fusionMethod = params.fusion?.method ?? 'rrf';

    if (fusionMethod === 'rrf') {
      return this.hybridSearchRRF(collection, params);
    } else {
      return this.hybridSearchRSF(collection, params);
    }
  }

  /**
   * Native OpenSearch hybrid search with RRF score fusion.
   * Requires OpenSearch 2.11+.
   */
  private async hybridSearchRRF(
    collection: string,
    params: HybridSearchParams,
  ): Promise<VectorSearchResult[]> {
    // Check OpenSearch version
    const version = await this.getVersion();
    if (this.compareVersions(version, '2.11.0') < 0) {
      console.warn(`[OpenSearch] Version ${version} < 2.11, falling back to client-side fusion`);
      return this.hybridSearchRSF(collection, params);
    }

    // Build hybrid query
    const hybridQuery: any = {
      hybrid: {
        queries: [
          // Query 1: k-NN vector similarity
          {
            knn: {
              vector: {
                vector: params.vector,
                k: params.topK * 2, // Fetch more for better fusion
              },
            },
          },
          // Query 2: BM25 full-text search
          {
            multi_match: {
              query: params.queryText,
              fields: ['content^2', 'metadata.title^3'], // Boosted fields
              type: 'best_fields',
              operator: 'or',
            },
          },
        ],
      },
    };

    // Add metadata filters (applied to both vector and BM25)
    if (params.filters?.length) {
      const filterClauses = this.buildFilter(params.filters);
      const filterQuery: any = { bool: {} };
      if (filterClauses.must.length > 0) {
        filterQuery.bool.must = filterClauses.must;
      }
      if (filterClauses.must_not.length > 0) {
        filterQuery.bool.must_not = filterClauses.must_not;
      }
      hybridQuery.hybrid.queries.push(filterQuery);
    }

    const rankConstant = params.fusion?.rankConstant ?? 60;

    const response = await this.client.search({
      index: collection,
      body: {
        size: params.topK,
        query: hybridQuery,
        // RRF score fusion
        rank: {
          rrf: {
            window_size: params.topK * 2,
            rank_constant: rankConstant,
          },
        },
        min_score: params.scoreThreshold,
      },
    });

    return response.body.hits.hits.map((hit: any) => ({
      id: hit._id,
      score: hit._score, // RRF fused score
      metadata: params.includeMetadata !== false ? hit._source.metadata : undefined,
      vector: params.includeVectors ? hit._source.vector : undefined,
      content: hit._source.content,
    }));
  }

  /**
   * Client-side hybrid search with RSF (Relative Score Fusion).
   * Works with any OpenSearch version.
   * Runs vector and BM25 queries separately, then fuses scores.
   */
  private async hybridSearchRSF(
    collection: string,
    params: HybridSearchParams,
  ): Promise<VectorSearchResult[]> {
    const alpha = params.fusion?.alpha ?? 0.7;

    // Run vector and BM25 searches in parallel
    const [vectorResults, bm25Results] = await Promise.all([
      this.search(collection, {
        vector: params.vector,
        topK: params.topK * 2,
        scoreThreshold: params.scoreThreshold,
        filters: params.filters,
        includeMetadata: params.includeMetadata,
        includeVectors: params.includeVectors,
      }),
      this.bm25Search(collection, {
        queryText: params.queryText,
        topK: params.topK * 2,
        filters: params.filters,
      }),
    ]);

    // Normalize scores to [0, 1]
    const normalizedVector = this.normalizeScores(vectorResults.map((r) => r.score));
    const normalizedBM25 = this.normalizeScores(bm25Results.map((r) => r.score));

    // Create score map for BM25 results
    const bm25ScoreMap = new Map<string, number>();
    bm25Results.forEach((r, idx) => {
      bm25ScoreMap.set(r.id, normalizedBM25[idx]);
    });

    // Fuse scores: finalScore = alpha * vectorScore + (1 - alpha) * bm25Score
    const fusedResults = vectorResults.map((r, idx) => {
      const vectorScore = normalizedVector[idx];
      const bm25Score = bm25ScoreMap.get(r.id) ?? 0;
      const fusedScore = alpha * vectorScore + (1 - alpha) * bm25Score;

      return {
        ...r,
        score: fusedScore,
        _vectorScore: r.score,
        _bm25Score: bm25ScoreMap.get(r.id) ?? 0,
      };
    });

    // Sort by fused score and return top K
    fusedResults.sort((a, b) => b.score - a.score);
    return fusedResults.slice(0, params.topK);
  }

  /**
   * BM25 full-text search (keyword only, no vector).
   * Helper for client-side RSF fusion.
   */
  private async bm25Search(
    collection: string,
    params: { queryText: string; topK: number; filters?: MetadataFilter[] },
  ): Promise<VectorSearchResult[]> {
    const query: any = {
      bool: {
        must: [
          {
            multi_match: {
              query: params.queryText,
              fields: ['content^2', 'metadata.title^3'],
              type: 'best_fields',
              operator: 'or',
            },
          },
        ],
      },
    };

    // Add filters
    if (params.filters?.length) {
      const filterClauses = this.buildFilter(params.filters);
      if (filterClauses.must.length > 0) {
        query.bool.must.push(...filterClauses.must);
      }
      if (filterClauses.must_not.length > 0) {
        query.bool.must_not = filterClauses.must_not;
      }
    }

    const response = await this.client.search({
      index: collection,
      body: {
        size: params.topK,
        query,
      },
    });

    return response.body.hits.hits.map((hit: any) => ({
      id: hit._id,
      score: hit._score,
      metadata: hit._source.metadata,
      content: hit._source.content,
    }));
  }

  /**
   * Normalize scores to [0, 1] using min-max normalization.
   */
  private normalizeScores(scores: number[]): number[] {
    if (scores.length === 0) return [];

    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const range = max - min;

    if (range === 0) {
      return scores.map(() => 1); // All same score
    }

    return scores.map((s) => (s - min) / range);
  }

  /**
   * Get OpenSearch version.
   */
  private async getVersion(): Promise<string> {
    try {
      const info = await this.client.info();
      return info.body.version.number;
    } catch (error) {
      console.error('[OpenSearch] Failed to get version:', error);
      return '0.0.0'; // Fallback
    }
  }

  /**
   * Compare semantic versions (e.g., "2.11.0" vs "2.10.0").
   * Returns: 1 if a > b, -1 if a < b, 0 if equal
   */
  private compareVersions(a: string, b: string): number {
    const partsA = a.split('.').map(Number);
    const partsB = b.split('.').map(Number);

    for (let i = 0; i < 3; i++) {
      if (partsA[i] > partsB[i]) return 1;
      if (partsA[i] < partsB[i]) return -1;
    }
    return 0;
  }

  // ─── Filter Translation ─────────────────────────────────────────────────

  private buildFilter(filters: MetadataFilter[]): { must: any[]; must_not: any[] } {
    const must: any[] = [];
    const mustNot: any[] = [];

    for (const f of filters) {
      const fieldPath = `metadata.${f.field}`;

      switch (f.operator) {
        case 'eq':
          must.push({ term: { [fieldPath]: f.value } });
          break;
        case 'neq':
          mustNot.push({ term: { [fieldPath]: f.value } });
          break;
        case 'gt':
          must.push({ range: { [fieldPath]: { gt: f.value } } });
          break;
        case 'gte':
          must.push({ range: { [fieldPath]: { gte: f.value } } });
          break;
        case 'lt':
          must.push({ range: { [fieldPath]: { lt: f.value } } });
          break;
        case 'lte':
          must.push({ range: { [fieldPath]: { lte: f.value } } });
          break;
        case 'in':
          must.push({ terms: { [fieldPath]: Array.isArray(f.value) ? f.value : [f.value] } });
          break;
        case 'not_in':
          mustNot.push({ terms: { [fieldPath]: Array.isArray(f.value) ? f.value : [f.value] } });
          break;
        case 'exists':
          if (f.value) {
            must.push({ exists: { field: fieldPath } });
          } else {
            mustNot.push({ exists: { field: fieldPath } });
          }
          break;
        case 'not_exists':
          mustNot.push({ exists: { field: fieldPath } });
          break;
        default:
          // Skip unsupported operators
          break;
      }
    }

    return { must, must_not: mustNot };
  }

  /**
   * Execute an arbitrary OpenSearch DSL query body.
   * Used by the unified pipeline to execute queries built by HybridSearchBuilder.
   *
   * @param collection - OpenSearch index name
   * @param body - DSL query body. If it contains a `search_pipeline` field,
   *   it is extracted and passed as a query parameter to OpenSearch (required
   *   for native hybrid search with score normalization).
   */
  async executeQuery(
    collection: string,
    body: Record<string, unknown>,
  ): Promise<{
    hits: Array<{ id: string; score: number; source: Record<string, unknown> }>;
    aggregations?: Record<string, unknown>;
    total: number;
  }> {
    // Extract search_pipeline from body (it's a query param, not part of DSL body)
    const searchPipeline = body.search_pipeline as string | undefined;
    const { search_pipeline: _, ...dslBody } = body;

    const searchParams: any = {
      index: collection,
      body: dslBody,
    };

    // search_pipeline is a recognized query parameter on the OpenSearch client
    if (searchPipeline) {
      searchParams.search_pipeline = searchPipeline;
    }

    const osStart = Date.now();
    const response = await this.client.search(searchParams);
    const osMs = Date.now() - osStart;

    logger.info('TIMING: OpenSearch raw query', {
      collection,
      osMs,
      took: response.body.took, // OpenSearch internal timing
      hitsCount: response.body.hits?.hits?.length ?? 0,
    });

    const hits = (response.body.hits?.hits ?? []).map((hit: any) => ({
      id: hit._id as string,
      score: (hit._score as number) ?? 0,
      source: (hit._source as Record<string, unknown>) ?? {},
    }));

    return {
      hits,
      aggregations: response.body.aggregations as Record<string, unknown> | undefined,
      total: getTotalHitsValue(response.body.hits?.total, hits.length),
    };
  }

  /**
   * Ensure the hybrid search pipeline exists in OpenSearch.
   * Creates it if missing. Idempotent — safe to call on every startup.
   *
   * The pipeline uses min-max normalization to bring each sub-query's scores
   * into 0-1 range, then combines with weighted arithmetic mean
   * (0.7 kNN vector, 0.3 BM25 text) for a final 0-1 relevance score.
   *
   * Why min-max + arithmetic_mean instead of RRF:
   * - RRF is rank-based and produces tiny scores (0.001-0.033) that are
   *   meaningless to users and downstream systems
   * - min-max normalization handles the BM25 vs kNN score range mismatch
   *   (BM25: 0-30+, kNN cosine: 0-1) by normalizing each to 0-1 first
   * - Weighted arithmetic mean gives tunable control (70% semantic, 30% keyword)
   * - Final scores are always 0-1 and directly interpretable as relevance
   */
  async ensureHybridSearchPipeline(pipelineName: string): Promise<void> {
    // Always PUT the pipeline to keep it in sync with the latest config.
    // OpenSearch PUT is idempotent — it creates or updates the pipeline.
    try {
      await this.client.transport.request({
        method: 'PUT',
        path: `/_search/pipeline/${pipelineName}`,
        body: {
          description:
            'Hybrid search pipeline — min-max normalization + weighted arithmetic mean (0.7 kNN, 0.3 BM25)',
          phase_results_processors: [
            {
              'normalization-processor': {
                normalization: {
                  technique: 'min_max',
                },
                combination: {
                  technique: 'arithmetic_mean',
                  parameters: {
                    weights: [0.7, 0.3],
                  },
                },
              },
            },
          ],
        },
      });
    } catch {
      // Non-fatal: hybrid search will still work via legacy bool path
    }
  }
}
