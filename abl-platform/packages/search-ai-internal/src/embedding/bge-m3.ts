/**
 * BGE-M3 Embedding Provider (In-House)
 *
 * BAAI/bge-m3 is a multilingual embedding model with:
 * - 1024 dimensions
 * - 512 token max context
 * - Supports 100+ languages
 * - Self-hosted (Docker/K8s)
 * - Zero per-token cost
 *
 * Batch size strategy:
 *   CPU: 8 texts per request (conservative, avoids memory spikes)
 *   GPU: 32 texts per request (fills GPU compute, fewer round trips)
 *
 *   The service auto-detects GPU at startup and reports recommended_batch_size
 *   via /health. If EMBEDDING_MAX_BATCH_SIZE is not set, we probe /health on
 *   first call and use the server's recommended value.
 *
 * Resilience (mirrors platform http-tool-executor pattern):
 *   - Retry with exponential backoff + jitter (3 attempts)
 *   - Circuit breaker (5 consecutive failures → open 10s → half-open probe)
 *   - Retries only on transient errors (503, 429, ECONNRESET, timeout)
 *   - Node.js 24 fetch() provides default keep-alive connection reuse
 *
 * Expected API: OpenAI-compatible embeddings endpoint
 *   POST /v1/embeddings
 *   { "input": ["text1", "text2"], "model": "bge-m3" }
 */

import { CircuitBreaker } from '@abl/compiler';
import type { EmbeddingProvider, EmbeddingProviderConfig, EmbeddingResult } from './interface.js';
import { countTokens } from '../tokenizer/index.js';

// ─── Provider ───────────────────────────────────────────────────────────────

export class BGEm3EmbeddingProvider implements EmbeddingProvider {
  readonly name = 'bge-m3';
  readonly modelId = 'BAAI/bge-m3';
  readonly dimensions = 1024; // Fixed for BGE-M3
  maxBatchSize: number;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private _batchSizeResolved = false;

  // Circuit breaker — reuses platform's CircuitBreaker from @abl/compiler
  // (same class used by http-tool-executor for all outbound HTTP calls)
  private readonly circuitBreaker: CircuitBreaker;

  // Retry configuration (mirrors http-tool-executor pattern)
  private readonly maxRetries = 3;
  private readonly baseRetryDelayMs = 1_000;

  constructor(config: EmbeddingProviderConfig) {
    this.apiKey = config.apiKey; // Optional for self-hosted
    this.baseUrl = (config.baseUrl ?? 'http://localhost:8000').replace(/\/$/, '');
    // Default to 8 (CPU-safe). If no explicit config, we'll auto-detect from
    // the server's /health response on first embedBatch() call.
    this.maxBatchSize = config.maxBatchSize ?? 8;
    this._batchSizeResolved = config.maxBatchSize != null;
    this.timeoutMs = config.timeoutMs ?? 120_000; // 2min timeout for CPU-based self-hosted inference

    // Circuit breaker: trip after 5 consecutive failures, recover after 10s
    this.circuitBreaker = new CircuitBreaker(5, 10_000);
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult> {
    // Auto-detect optimal batch size from server on first call
    if (!this._batchSizeResolved) {
      await this._resolveBatchSize();
    }

    const allEmbeddings: number[][] = [];
    let totalTokens = 0;

    // Batch in chunks of maxBatchSize
    for (let i = 0; i < texts.length; i += this.maxBatchSize) {
      const batch = texts.slice(i, i + this.maxBatchSize);
      const result = await this.callAPI(batch);
      allEmbeddings.push(...result.embeddings);
      totalTokens += result.totalTokens;
    }

    return {
      embeddings: allEmbeddings,
      totalTokens,
      model: this.modelId,
      dimensions: this.dimensions,
    };
  }

  estimateTokens(text: string): number {
    return countTokens(text);
  }

  async healthCheck(): Promise<{ ok: boolean; latencyMs: number }> {
    const start = Date.now();
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      const ok = response.ok;
      return { ok, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  /**
   * Probe the embedding server's /health to discover GPU vs CPU and
   * set maxBatchSize accordingly. Called once on first embedBatch().
   *
   * GPU server returns recommended_batch_size=32, CPU returns 8.
   * Falls back to 8 if /health is unreachable (retries on next call).
   */
  private async _resolveBatchSize(): Promise<void> {
    try {
      const response = await fetch(`${this.baseUrl}/health`, {
        method: 'GET',
        signal: AbortSignal.timeout(5_000),
      });
      if (response.ok) {
        const health = (await response.json()) as {
          recommended_batch_size?: number;
          max_batch_size?: number;
          gpu_available?: boolean;
          device?: string;
        };
        if (health.recommended_batch_size && health.recommended_batch_size > this.maxBatchSize) {
          this.maxBatchSize = health.recommended_batch_size;
        }
        // Only mark resolved on successful probe — if server was loading (503)
        // or unreachable, retry on next embedBatch() call.
        this._batchSizeResolved = true;
      }
      // 503 = model still loading, don't mark resolved — retry next time
    } catch {
      // Unreachable — keep default of 8, retry on next call
    }
  }

  /**
   * Determine if an error or HTTP status is transient and worth retrying.
   * Mirrors the retryable logic in http-tool-executor (429, 5xx, network errors).
   */
  private isTransientError(status?: number, error?: unknown): boolean {
    // Transient HTTP statuses (same as http-tool-executor: 429 + 5xx)
    if (status === 429 || (status !== undefined && status >= 500)) {
      return true;
    }

    // Network-level transient errors
    if (error instanceof Error) {
      // Node.js fetch() wraps network errors as TypeError("fetch failed") with the
      // real error in .cause — check both .message and .cause for transient patterns
      const msg = error.message.toLowerCase();
      const cause = (error as { cause?: unknown }).cause;
      const causeMsg =
        cause instanceof Error
          ? cause.message.toLowerCase()
          : typeof cause === 'object' && cause !== null
            ? String(
                (cause as { code?: string }).code || (cause as { message?: string }).message || '',
              ).toLowerCase()
            : typeof cause === 'string'
              ? cause.toLowerCase()
              : '';

      const fullMsg = `${msg} ${causeMsg}`;
      const transientPatterns = [
        'econnreset',
        'econnrefused',
        'epipe',
        'etimedout',
        'socket hang up',
        'network',
        'abort',
      ];
      return transientPatterns.some((p) => fullMsg.includes(p));
    }

    return false;
  }

  private async callAPI(texts: string[]): Promise<{ embeddings: number[][]; totalTokens: number }> {
    // Circuit breaker gate — fast-fail if service is down
    if (this.circuitBreaker.isOpen()) {
      throw new Error(
        `BGE-M3 circuit breaker OPEN: service at ${this.baseUrl} has failed ` +
          `consecutively. Will retry after recovery window.`,
      );
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      // Re-check circuit breaker before retry attempts (same as http-tool-executor)
      if (attempt > 0 && this.circuitBreaker.isOpen()) {
        throw new Error(`BGE-M3 circuit breaker opened during retries for ${this.baseUrl}`);
      }

      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        let response: Response;
        try {
          response = await fetch(`${this.baseUrl}/v1/embeddings`, {
            method: 'POST',
            headers,
            body: JSON.stringify({
              input: texts,
              model: 'bge-m3',
            }),
            signal: controller.signal,
          });
        } catch (fetchErr) {
          clearTimeout(timeout);

          // Check if this is a transient network error worth retrying
          if (this.isTransientError(undefined, fetchErr) && attempt < this.maxRetries) {
            lastError = fetchErr instanceof Error ? fetchErr : new Error(String(fetchErr));
            // Exponential backoff with jitter (same pattern as http-tool-executor line 2132)
            const jitter = 0.5 + Math.random() * 0.5;
            const backoffMs = this.baseRetryDelayMs * Math.pow(2, attempt) * jitter;
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
            continue;
          }

          // Non-transient or final attempt — record failure and throw
          this.circuitBreaker.recordFailure();
          const cause = (fetchErr as Record<string, unknown>)?.cause;
          const causeMsg =
            (cause as Record<string, unknown>)?.message ||
            (cause as Record<string, unknown>)?.code ||
            String(cause || 'no cause');
          throw new Error(
            `BGE-M3 fetch failed (url=${this.baseUrl}/v1/embeddings, texts=${texts.length}, ` +
              `attempt=${attempt + 1}/${this.maxRetries + 1}): ` +
              `${fetchErr instanceof Error ? fetchErr.message : String(fetchErr)} [cause: ${causeMsg}]`,
          );
        }

        clearTimeout(timeout);

        // Retry on transient HTTP status codes
        if (this.isTransientError(response.status) && attempt < this.maxRetries) {
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 0;
          const jitter = 0.5 + Math.random() * 0.5;
          const backoffMs = Math.max(
            retryAfterSec * 1000,
            this.baseRetryDelayMs * Math.pow(2, attempt) * jitter,
          );
          lastError = new Error(
            `BGE-M3 API returned ${response.status} (attempt ${attempt + 1}/${this.maxRetries + 1})`,
          );
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          this.circuitBreaker.recordFailure();
          throw new Error(`BGE-M3 API failed (${response.status}): ${errorText}`);
        }

        const data = (await response.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
          usage: { prompt_tokens: number; total_tokens: number };
        };

        // Sort by index to preserve input order
        const sorted = data.data.sort((a, b) => a.index - b.index);

        // Success — reset circuit breaker
        this.circuitBreaker.recordSuccess();

        return {
          embeddings: sorted.map((d) => d.embedding),
          totalTokens: data.usage.total_tokens,
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    // All retries exhausted
    this.circuitBreaker.recordFailure();
    throw new Error(
      `BGE-M3 embeddings API: max retries (${this.maxRetries}) exceeded. ` +
        `Last error: ${lastError?.message ?? 'unknown'}`,
    );
  }
}
