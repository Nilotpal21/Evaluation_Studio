/**
 * Multi-Provider Reranker Factory (RFC-003)
 *
 * Unified interface for reranking with multiple providers:
 * - Voyage AI (primary - cheapest at $0.50/1K)
 * - Cohere (fallback - industry standard)
 * - Jina AI (fallback - multilingual)
 *
 * Features:
 * - Automatic fallback if primary fails
 * - Circuit breaker to prevent cascade failures
 * - Cost tracking per provider
 * - Health checks
 * - Configurable via constructor OR env vars (Model Library integration)
 */

import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('reranker-factory');

// ─── Types ──────────────────────────────────────────────────────────────────

export interface RerankRequest {
  /** Query text */
  query: string;
  /** Documents to rerank (array of text content) */
  documents: string[];
  /** Number of top results to return (optional, returns all if not set) */
  topN?: number;
}

export interface RerankResult {
  /** Original index in input documents array */
  index: number;
  /** Relevance score (0-1, higher = more relevant) */
  score: number;
  /** Document text (only if returnDocuments was true) */
  document?: string;
}

export interface RerankResponse {
  /** Reranked results sorted by relevance */
  results: RerankResult[];
  /** Provider that serviced this request */
  provider: string;
  /** Model used for reranking */
  model: string;
  /** Latency in milliseconds */
  latencyMs: number;
  /** Cost in USD for this request */
  cost?: number;
}

// ─── Provider Interface ─────────────────────────────────────────────────────

export interface RerankerProvider {
  /** Provider name (e.g., 'voyage', 'cohere', 'jina') */
  readonly name: string;

  /** Rerank documents by relevance to query */
  rerank(request: RerankRequest): Promise<RerankResponse>;

  /** Health check */
  healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }>;
}

// ─── Voyage AI Provider ─────────────────────────────────────────────────────

export class VoyageReranker implements RerankerProvider {
  readonly name = 'voyage';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; model?: string; timeoutMs?: number }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'rerank-1';
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.baseUrl = 'https://api.voyageai.com/v1';
  }

  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          query: request.query,
          documents: request.documents,
          top_k: request.topN ?? request.documents.length,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Voyage API error [${response.status}]: ${errorText}`);
      }

      const data: any = await response.json();
      const latencyMs = Date.now() - start;

      return {
        results: data.data.map((item: any) => ({
          index: item.index,
          score: item.relevance_score,
        })),
        provider: 'voyage',
        model: this.model,
        latencyMs,
        cost: 0.5 * (request.documents.length / 1000), // $0.50 per 1K queries
      };
    } catch (error) {
      clearTimeout(timeout);
      if ((error as any).name === 'AbortError') {
        throw new Error(`Voyage reranker timeout after ${this.timeoutMs}ms`);
      }
      throw error;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.rerank({ query: 'test', documents: ['test document'] });
      return { ok: true, latencyMs: Date.now() - start };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ─── Cohere Provider ────────────────────────────────────────────────────────

export class CohereReranker implements RerankerProvider {
  readonly name = 'cohere';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; model?: string; timeoutMs?: number }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'rerank-english-v3.0';
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.baseUrl = 'https://api.cohere.ai/v1';
  }

  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          query: request.query,
          documents: request.documents,
          top_n: request.topN ?? request.documents.length,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Cohere API error [${response.status}]: ${errorText}`);
      }

      const data: any = await response.json();
      const latencyMs = Date.now() - start;

      return {
        results: data.results.map((item: any) => ({
          index: item.index,
          score: item.relevance_score,
        })),
        provider: 'cohere',
        model: this.model,
        latencyMs,
        cost: 2.0 * (request.documents.length / 1000), // $2.00 per 1K queries
      };
    } catch (error) {
      clearTimeout(timeout);
      if ((error as any).name === 'AbortError') {
        throw new Error(`Cohere reranker timeout after ${this.timeoutMs}ms`);
      }
      throw error;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.rerank({ query: 'test', documents: ['test document'] });
      return { ok: true, latencyMs: Date.now() - start };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ─── Jina AI Provider ───────────────────────────────────────────────────────

export class JinaReranker implements RerankerProvider {
  readonly name = 'jina';
  private readonly apiKey: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly baseUrl: string;

  constructor(config: { apiKey: string; model?: string; timeoutMs?: number }) {
    this.apiKey = config.apiKey;
    this.model = config.model ?? 'jina-reranker-v2-base-multilingual';
    this.timeoutMs = config.timeoutMs ?? 5000;
    this.baseUrl = 'https://api.jina.ai/v1';
  }

  async rerank(request: RerankRequest): Promise<RerankResponse> {
    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/rerank`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: this.model,
          query: request.query,
          documents: request.documents.map((text, idx) => ({ index: idx, text })),
          top_n: request.topN ?? request.documents.length,
        }),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Jina API error [${response.status}]: ${errorText}`);
      }

      const data: any = await response.json();
      const latencyMs = Date.now() - start;

      return {
        results: data.results.map((item: any) => ({
          index: item.index,
          score: item.relevance_score,
        })),
        provider: 'jina',
        model: this.model,
        latencyMs,
        cost: 1.0 * (request.documents.length / 1000), // $1.00 per 1K queries
      };
    } catch (error) {
      clearTimeout(timeout);
      if ((error as any).name === 'AbortError') {
        throw new Error(`Jina reranker timeout after ${this.timeoutMs}ms`);
      }
      throw error;
    }
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
    const start = Date.now();
    try {
      await this.rerank({ query: 'test', documents: ['test document'] });
      return { ok: true, latencyMs: Date.now() - start };
    } catch (error) {
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }
}

// ─── Factory with Circuit Breaker & Fallback ────────────────────────────────

/** Circuit breaker reset timeout in ms (default: 60 seconds) */
const CB_RESET_TIMEOUT_MS = 60_000;

/**
 * Optional config for per-index or per-tenant reranker settings.
 * Falls back to environment variables when not provided.
 */
export interface RerankerConfig {
  /** Preferred provider name: 'voyage', 'cohere', or 'jina' */
  preferredProvider?: string;
  /** Provider-specific API keys (overrides env vars when set) */
  voyageApiKey?: string;
  cohereApiKey?: string;
  jinaApiKey?: string;
  /** Override model for preferred provider */
  model?: string;
}

export class RerankerFactory {
  private providers: RerankerProvider[] = [];
  private failureCount = new Map<string, number>();
  private circuitOpenedAt = new Map<string, number>();
  private readonly maxFailures = 3;

  constructor(config?: RerankerConfig) {
    // Priority order: Voyage (cheapest) → Cohere → Jina
    // Use config API keys if provided, otherwise fall back to env vars
    const voyageKey = config?.voyageApiKey || process.env.VOYAGE_API_KEY;
    const cohereKey = config?.cohereApiKey || process.env.COHERE_API_KEY;
    const jinaKey = config?.jinaApiKey || process.env.JINA_API_KEY;

    if (voyageKey) {
      this.providers.push(
        new VoyageReranker({
          apiKey: voyageKey,
          model: config?.preferredProvider === 'voyage' ? config.model : undefined,
        }),
      );
    }

    if (cohereKey) {
      this.providers.push(
        new CohereReranker({
          apiKey: cohereKey,
          model: config?.preferredProvider === 'cohere' ? config.model : undefined,
        }),
      );
    }

    if (jinaKey) {
      this.providers.push(
        new JinaReranker({
          apiKey: jinaKey,
          model: config?.preferredProvider === 'jina' ? config.model : undefined,
        }),
      );
    }

    // If preferred provider is set, reorder so it comes first
    if (config?.preferredProvider && this.providers.length > 1) {
      const preferredIdx = this.providers.findIndex((p) => p.name === config.preferredProvider);
      if (preferredIdx > 0) {
        const [preferred] = this.providers.splice(preferredIdx, 1);
        this.providers.unshift(preferred);
      }
    }

    if (this.providers.length === 0) {
      logger.warn('No reranker API keys found. Reranking will be disabled.');
    }
  }

  /**
   * Rerank with automatic fallback.
   * Tries providers in priority order until one succeeds.
   */
  async rerank(request: RerankRequest): Promise<RerankResponse | null> {
    if (this.providers.length === 0) {
      logger.warn('No providers available, skipping rerank');
      return null;
    }

    const errors: Array<{ provider: string; error: string }> = [];

    for (const provider of this.providers) {
      // Skip if circuit breaker is open
      if (this.isCircuitOpen(provider.name)) {
        logger.warn('Skipping provider (circuit open)', { provider: provider.name });
        continue;
      }

      try {
        const result = await provider.rerank(request);
        this.recordSuccess(provider.name);
        return result;
      } catch (error) {
        this.recordFailure(provider.name);
        const errorMsg = error instanceof Error ? error.message : String(error);
        errors.push({ provider: provider.name, error: errorMsg });
        logger.error('Provider rerank failed', { provider: provider.name, error: errorMsg });
      }
    }

    // All providers failed
    logger.error('All reranker providers failed', { errors });
    return null; // Graceful degradation - return null instead of throwing
  }

  /**
   * Check if circuit breaker is open for a provider.
   * Circuit opens after maxFailures consecutive failures, and resets
   * after CB_RESET_TIMEOUT_MS to allow a probe request (half-open).
   */
  private isCircuitOpen(providerName: string): boolean {
    const failures = this.failureCount.get(providerName) ?? 0;
    if (failures < this.maxFailures) return false;

    // Check if reset timeout has elapsed — allow a probe request (half-open)
    const openedAt = this.circuitOpenedAt.get(providerName) ?? 0;
    if (Date.now() - openedAt >= CB_RESET_TIMEOUT_MS) {
      // Transition to half-open: reset failures to allow one probe
      this.failureCount.set(providerName, 0);
      this.circuitOpenedAt.delete(providerName);
      return false;
    }

    return true;
  }

  /**
   * Record successful rerank (resets failure count and clears circuit timer).
   */
  private recordSuccess(providerName: string): void {
    this.failureCount.set(providerName, 0);
    this.circuitOpenedAt.delete(providerName);
  }

  /**
   * Record failed rerank (increments failure count, records open timestamp).
   */
  private recordFailure(providerName: string): void {
    const current = this.failureCount.get(providerName) ?? 0;
    const next = current + 1;
    this.failureCount.set(providerName, next);
    if (next >= this.maxFailures && !this.circuitOpenedAt.has(providerName)) {
      this.circuitOpenedAt.set(providerName, Date.now());
    }
  }

  /**
   * Get status of all providers (for health checks / monitoring).
   */
  async getStatus(): Promise<
    Array<{
      name: string;
      healthy: boolean;
      latencyMs: number;
      circuitOpen: boolean;
      error?: string;
    }>
  > {
    const checks = await Promise.all(
      this.providers.map(async (p) => {
        const health = await p.healthCheck();
        return {
          name: p.name,
          healthy: health.ok,
          latencyMs: health.latencyMs,
          circuitOpen: this.isCircuitOpen(p.name),
          error: health.error,
        };
      }),
    );
    return checks;
  }

  /**
   * Check if any provider is available.
   */
  isAvailable(): boolean {
    return this.providers.length > 0;
  }
}
