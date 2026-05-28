/**
 * Qdrant Vector Store Provider
 *
 * Implementation using Qdrant's HTTP API.
 * Requires `@qdrant/js-client-rest` as a peer dependency in consuming apps.
 */

import type {
  VectorStoreProvider,
  VectorRecord,
  VectorSearchParams,
  VectorSearchResult,
  CollectionConfig,
  CollectionInfo,
} from './interface.js';
import type { MetadataFilter } from '@agent-platform/search-ai-sdk/types';

export interface QdrantConfig {
  url: string;
  apiKey?: string;
  /** Timeout for requests in ms */
  timeoutMs?: number;
}

interface QdrantPoint {
  id: string;
  vector: number[];
  payload?: Record<string, unknown>;
}

interface QdrantSearchResult {
  id: string;
  score: number;
  payload?: Record<string, unknown>;
  vector?: number[];
}

export class QdrantVectorStore implements VectorStoreProvider {
  readonly name = 'qdrant';
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly timeoutMs: number;

  constructor(config: QdrantConfig) {
    this.url = config.url.replace(/\/$/, '');
    this.headers = {
      'Content-Type': 'application/json',
      ...(config.apiKey ? { 'api-key': config.apiKey } : {}),
    };
    this.timeoutMs = config.timeoutMs ?? 30_000;
  }

  async createCollection(config: CollectionConfig): Promise<void> {
    const distanceMap = {
      cosine: 'Cosine',
      euclidean: 'Euclid',
      dot_product: 'Dot',
    } as const;

    await this.request('PUT', `/collections/${config.name}`, {
      vectors: {
        size: config.dimensions,
        distance: distanceMap[config.distance],
      },
    });

    // Create payload indexes for metadata filtering
    if (config.metadataIndexes) {
      for (const idx of config.metadataIndexes) {
        const schemaType = {
          keyword: 'keyword',
          integer: 'integer',
          float: 'float',
          bool: 'bool',
        }[idx.type];

        await this.request('PUT', `/collections/${config.name}/index`, {
          field_name: idx.field,
          field_schema: schemaType,
        });
      }
    }
  }

  async deleteCollection(name: string): Promise<void> {
    await this.request('DELETE', `/collections/${name}`);
  }

  async getCollectionInfo(name: string): Promise<CollectionInfo | null> {
    try {
      const data = await this.request('GET', `/collections/${name}`);
      const result = data.result;
      return {
        name,
        vectorCount: result.points_count ?? 0,
        dimensions: result.config?.params?.vectors?.size ?? 0,
        distance: result.config?.params?.vectors?.distance ?? 'unknown',
        status: result.status === 'green' ? 'ready' : 'indexing',
      };
    } catch {
      return null;
    }
  }

  async collectionExists(name: string): Promise<boolean> {
    const info = await this.getCollectionInfo(name);
    return info !== null;
  }

  async upsert(collection: string, records: VectorRecord[]): Promise<void> {
    const points: QdrantPoint[] = records.map((r) => ({
      id: r.id,
      vector: r.vector,
      payload: {
        ...r.metadata,
        ...(r.content ? { _content: r.content } : {}),
      },
    }));

    // Qdrant supports batch upsert up to ~100 points per request
    const batchSize = 100;
    for (let i = 0; i < points.length; i += batchSize) {
      const batch = points.slice(i, i + batchSize);
      await this.request('PUT', `/collections/${collection}/points`, {
        points: batch,
      });
    }
  }

  async search(collection: string, params: VectorSearchParams): Promise<VectorSearchResult[]> {
    const body: Record<string, unknown> = {
      vector: params.vector,
      limit: params.topK,
      with_payload: params.includeMetadata !== false,
      with_vector: params.includeVectors === true,
    };

    if (params.scoreThreshold !== undefined) {
      body.score_threshold = params.scoreThreshold;
    }

    if (params.filters?.length) {
      body.filter = this.buildQdrantFilter(params.filters);
    }

    const data = await this.request('POST', `/collections/${collection}/points/search`, body);

    return (data.result as QdrantSearchResult[]).map((r) => ({
      id: String(r.id),
      score: r.score,
      metadata: r.payload,
      vector: r.vector,
      content: r.payload?._content as string | undefined,
    }));
  }

  async delete(collection: string, ids: string[]): Promise<void> {
    await this.request('POST', `/collections/${collection}/points/delete`, { points: ids });
  }

  async deleteByFilter(collection: string, filters: MetadataFilter[]): Promise<void> {
    await this.request('POST', `/collections/${collection}/points/delete`, {
      filter: this.buildQdrantFilter(filters),
    });
  }

  async getByIds(collection: string, ids: string[]): Promise<VectorRecord[]> {
    const data = await this.request('POST', `/collections/${collection}/points`, {
      ids,
      with_payload: true,
      with_vector: true,
    });

    return (data.result as QdrantPoint[]).map((p) => ({
      id: String(p.id),
      vector: p.vector,
      metadata: p.payload,
    }));
  }

  async count(collection: string): Promise<number> {
    const data = await this.request('POST', `/collections/${collection}/points/count`, {
      exact: true,
    });
    return data.result?.count ?? 0;
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      await this.request('GET', '/healthz');
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  async close(): Promise<void> {
    // HTTP client — no persistent connection to close
  }

  // ─── Filter Translation ─────────────────────────────────────────────────

  private buildQdrantFilter(filters: MetadataFilter[]): Record<string, unknown> {
    const must: Record<string, unknown>[] = [];

    for (const f of filters) {
      switch (f.operator) {
        case 'eq':
          must.push({ key: f.field, match: { value: f.value } });
          break;
        case 'neq':
          must.push({
            key: f.field,
            match: { value: f.value },
            // Qdrant uses must_not for negation — handled below
          });
          break;
        case 'gt':
          must.push({ key: f.field, range: { gt: f.value } });
          break;
        case 'gte':
          must.push({ key: f.field, range: { gte: f.value } });
          break;
        case 'lt':
          must.push({ key: f.field, range: { lt: f.value } });
          break;
        case 'lte':
          must.push({ key: f.field, range: { lte: f.value } });
          break;
        case 'in':
          must.push({
            key: f.field,
            match: { any: Array.isArray(f.value) ? f.value : [f.value] },
          });
          break;
        case 'not_in':
          // Handled via must_not
          break;
        case 'exists':
          must.push({
            is_empty: { key: f.field },
            // Inverted below
          });
          break;
        default:
          // Skip unsupported operators
          break;
      }
    }

    // Handle negations
    const mustNot: Record<string, unknown>[] = [];
    for (const f of filters) {
      if (f.operator === 'neq') {
        mustNot.push({ key: f.field, match: { value: f.value } });
      } else if (f.operator === 'not_in') {
        mustNot.push({
          key: f.field,
          match: { any: Array.isArray(f.value) ? f.value : [f.value] },
        });
      } else if (f.operator === 'not_exists') {
        mustNot.push({ is_empty: { key: f.field } });
      }
    }

    // Remove neq from must (it was added there too)
    const filteredMust = must.filter(
      (m) => !filters.some((f) => f.operator === 'neq' && (m as { key?: string }).key === f.field),
    );

    return {
      must: filteredMust.length > 0 ? filteredMust : undefined,
      must_not: mustNot.length > 0 ? mustNot : undefined,
    };
  }

  // ─── HTTP Client ──────────────────────────────────────────────────────────

  private async request(method: string, path: string, body?: unknown): Promise<any> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.url}${path}`, {
        method,
        headers: this.headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });

      if (!response.ok) {
        const text = await response.text().catch(() => '');
        throw new Error(`Qdrant ${method} ${path} failed (${response.status}): ${text}`);
      }

      const contentType = response.headers.get('content-type');
      if (contentType?.includes('application/json')) {
        return await response.json();
      }
      return {};
    } finally {
      clearTimeout(timeout);
    }
  }
}
