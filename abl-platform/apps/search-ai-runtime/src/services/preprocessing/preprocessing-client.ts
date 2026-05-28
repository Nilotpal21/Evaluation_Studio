/**
 * Preprocessing Service Client
 *
 * HTTP client for the Python multilingual preprocessing microservice.
 * Supports language detection (55+ languages), spell correction (20+ languages),
 * synonym expansion (30+ languages), and entity extraction.
 *
 * Features:
 * - Automatic timeout handling
 * - Structured error messages
 * - Health check support
 * - Optional preprocessing stages
 */

import { createLogger } from '@abl/compiler/platform';
import type {
  PreprocessingRequest,
  PreprocessingResponse,
  PreprocessingConfig,
  PreprocessingHealthResponse,
  LanguagesResponse,
} from './types.js';

const logger = createLogger('preprocessing-client');

// ─── Configuration ──────────────────────────────────────────────────────────

export interface PreprocessingClientConfig {
  /** Base URL of preprocessing service (default: http://localhost:8003) */
  baseUrl?: string;
  /** Request timeout in milliseconds (default: 100ms) */
  timeoutMs?: number;
  /** Enable preprocessing (feature flag, default: true) */
  enabled?: boolean;
}

// ─── Client ─────────────────────────────────────────────────────────────────

export class PreprocessingClient {
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly enabled: boolean;

  constructor(config?: PreprocessingClientConfig) {
    this.baseUrl =
      config?.baseUrl ?? process.env.PREPROCESSING_SERVICE_URL ?? 'http://localhost:8003';
    this.timeoutMs =
      config?.timeoutMs ?? parseInt(process.env.PREPROCESSING_TIMEOUT_MS || '100', 10);
    this.enabled = config?.enabled ?? process.env.PREPROCESSING_ENABLED === 'true';

    logger.info('Preprocessing client initialized', {
      baseUrl: this.baseUrl,
      timeoutMs: this.timeoutMs,
      enabled: this.enabled,
    });
  }

  /**
   * Preprocess a query with multilingual support
   *
   * @param query - Query text to preprocess
   * @param tenantId - Tenant ID for tenant-specific dictionaries
   * @param config - Optional preprocessing configuration
   * @returns Preprocessing response with processed query and metadata
   *
   * @example
   * const result = await client.preprocess(
   *   'show me docuemnts about kuberntes',
   *   'tenant-123',
   *   { enableSpellCorrection: true }
   * );
   * console.log(result.processedQuery); // "show me documents about kubernetes"
   */
  async preprocess(
    query: string,
    tenantId: string,
    config?: PreprocessingConfig,
  ): Promise<PreprocessingResponse> {
    // If preprocessing is disabled, return original query with no-op response
    if (!this.enabled) {
      return this.createNoOpResponse(query);
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const request: PreprocessingRequest = {
        query,
        tenantId,
        config: config ?? {
          enableSpellCorrection: true,
          enableSynonymExpansion: true,
          enableEntityExtraction: true,
          maxSynonyms: 3,
        },
      };

      const response = await fetch(`${this.baseUrl}/v1/preprocess`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: controller.signal,
      });

      clearTimeout(timeout);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Preprocessing service error [${response.status}]: ${errorText}`);
      }

      const data = (await response.json()) as PreprocessingResponse;

      return data;
    } catch (error) {
      clearTimeout(timeout);

      // On timeout or error, return original query with error metadata
      if ((error as any).name === 'AbortError') {
        logger.warn('Preprocessing timeout, using original query', { timeoutMs: this.timeoutMs });
        return this.createNoOpResponse(query, `Timeout after ${this.timeoutMs}ms`);
      }

      logger.error('Preprocessing error', {
        error: error instanceof Error ? error.message : String(error),
      });
      return this.createNoOpResponse(query, error instanceof Error ? error.message : String(error));
    }
  }

  /**
   * Health check for preprocessing service
   *
   * @returns Health status with service info
   */
  async healthCheck(): Promise<{
    ok: boolean;
    latencyMs: number;
    error?: string;
    service?: string;
    version?: string;
  }> {
    if (!this.enabled) {
      return { ok: true, latencyMs: 0 };
    }

    const start = Date.now();
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000); // 5s timeout for health check

    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: controller.signal,
      });

      clearTimeout(timeout);

      const latencyMs = Date.now() - start;

      if (!response.ok) {
        return {
          ok: false,
          latencyMs,
          error: `HTTP ${response.status}: ${response.statusText}`,
        };
      }

      const data = (await response.json()) as PreprocessingHealthResponse;

      return {
        ok: data.status === 'healthy',
        latencyMs,
        service: data.service,
        version: data.version,
      };
    } catch (error) {
      clearTimeout(timeout);
      return {
        ok: false,
        latencyMs: Date.now() - start,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Get list of supported languages
   *
   * @returns Supported languages for each stage
   */
  async getSupportedLanguages(): Promise<LanguagesResponse | null> {
    if (!this.enabled) {
      return null;
    }

    try {
      const response = await fetch(`${this.baseUrl}/v1/languages`, {
        method: 'GET',
      });

      if (!response.ok) {
        logger.error('Failed to fetch supported languages', { status: response.statusText });
        return null;
      }

      return (await response.json()) as LanguagesResponse;
    } catch (error) {
      logger.error('Error fetching supported languages', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /**
   * Create a no-op response (preprocessing disabled or failed)
   *
   * Returns the original query with empty preprocessing results
   */
  private createNoOpResponse(query: string, error?: string): PreprocessingResponse {
    return {
      processedQuery: query,
      language: 'en', // Default to English
      confidence: 0.5,
      stages: {
        spellCorrection: [],
        synonymExpansion: [],
        entities: [],
      },
      metadata: {
        originalQuery: query,
        processingTimeMs: 0,
        stagesExecuted: [],
        error,
      },
    };
  }
}

// ─── Singleton Instance ─────────────────────────────────────────────────────

/**
 * Default preprocessing client instance
 *
 * Can be configured via environment variables:
 * - PREPROCESSING_SERVICE_URL: Base URL (default: http://localhost:8003)
 * - PREPROCESSING_ENABLED: Enable/disable preprocessing (default: true)
 * - PREPROCESSING_TIMEOUT_MS: Request timeout (default: 100)
 */
export const preprocessingClient = new PreprocessingClient({
  baseUrl: process.env.PREPROCESSING_SERVICE_URL,
  timeoutMs: process.env.PREPROCESSING_TIMEOUT_MS
    ? parseInt(process.env.PREPROCESSING_TIMEOUT_MS, 10)
    : undefined,
  enabled: process.env.PREPROCESSING_ENABLED !== 'false',
});
