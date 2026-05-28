/**
 * OpenAI Embedding Provider
 *
 * Uses the OpenAI embeddings API (text-embedding-3-small/large, ada-002).
 * Handles batching and rate limiting.
 */

import type { EmbeddingProvider, EmbeddingProviderConfig, EmbeddingResult } from './interface.js';
import { countTokens } from '../tokenizer/index.js';

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'openai';
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  /** Whether dimensions was explicitly configured by the user */
  private readonly explicitDimensions: boolean;

  constructor(config: EmbeddingProviderConfig) {
    this.apiKey = config.apiKey;
    this.modelId = config.model;
    this.explicitDimensions = config.dimensions != null;
    this.dimensions = config.dimensions ?? this.defaultDimensions(config.model);
    this.maxBatchSize = config.maxBatchSize ?? 100;
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.baseUrl = (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/$/, '');
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult> {
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
      await this.callAPI(['health check']);
      return { ok: true, latencyMs: Date.now() - start };
    } catch {
      return { ok: false, latencyMs: Date.now() - start };
    }
  }

  // ─── Private ──────────────────────────────────────────────────────────────

  private async callAPI(texts: string[]): Promise<{ embeddings: number[][]; totalTokens: number }> {
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const body: Record<string, unknown> = {
          input: texts,
          model: this.modelId,
        };

        // Send dimensions for text-embedding-3 models when explicitly configured
        // or when dimensions differ from the model's default output size.
        if (
          this.modelId.includes('text-embedding-3') &&
          (this.explicitDimensions || this.dimensions !== this.defaultDimensions(this.modelId))
        ) {
          body.dimensions = this.dimensions;
        }

        const response = await fetch(`${this.baseUrl}/embeddings`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        });

        if (response.status === 429 && attempt < maxRetries) {
          clearTimeout(timeout);
          const retryAfterHeader = response.headers.get('retry-after');
          const retryAfterSec = retryAfterHeader ? parseInt(retryAfterHeader, 10) : 0;
          const backoffMs = Math.max(retryAfterSec * 1000, 1000 * 2 ** attempt);
          await new Promise((resolve) => setTimeout(resolve, backoffMs));
          continue;
        }

        if (!response.ok) {
          const errorText = await response.text().catch(() => '');
          throw new Error(`OpenAI embeddings API failed (${response.status}): ${errorText}`);
        }

        const data = (await response.json()) as {
          data: Array<{ embedding: number[]; index: number }>;
          usage: { prompt_tokens: number; total_tokens: number };
        };

        const sorted = data.data.sort((a, b) => a.index - b.index);

        return {
          embeddings: sorted.map((d) => d.embedding),
          totalTokens: data.usage.total_tokens,
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    throw new Error('OpenAI embeddings API: max retries exceeded');
  }

  private defaultDimensions(model: string): number {
    if (model.includes('text-embedding-3-large')) return 3072;
    if (model.includes('text-embedding-3-small')) return 1536;
    if (model.includes('ada-002')) return 1536;
    return 1536;
  }
}
