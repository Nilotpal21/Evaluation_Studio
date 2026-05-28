/**
 * Cohere Embedding Provider
 *
 * Uses Cohere embeddings API (embed-english-v3.0, embed-multilingual-v3.0).
 * Optimized for semantic search with separate query/document modes.
 */

import type { EmbeddingProvider, EmbeddingProviderConfig, EmbeddingResult } from './interface.js';
import { countTokens } from '../tokenizer/index.js';

export class CohereEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'cohere';
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;

  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly inputType: 'search_document' | 'search_query';

  constructor(config: EmbeddingProviderConfig) {
    this.apiKey = config.apiKey;
    this.modelId = config.model;
    this.dimensions = config.dimensions ?? this.defaultDimensions(config.model);
    this.maxBatchSize = config.maxBatchSize ?? 96; // Cohere max batch
    this.timeoutMs = config.timeoutMs ?? 30_000;
    this.baseUrl = (config.baseUrl ?? 'https://api.cohere.ai/v1').replace(/\/$/, '');
    this.inputType = 'search_document'; // Default for indexing
  }

  async embed(text: string): Promise<number[]> {
    const result = await this.embedBatch([text]);
    return result.embeddings[0];
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult> {
    const allEmbeddings: number[][] = [];
    let totalTokens = 0;

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
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const response = await fetch(`${this.baseUrl}/embed`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify({
          texts,
          model: this.modelId,
          input_type: this.inputType,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Cohere embeddings API failed (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as {
        embeddings: number[][];
        meta: { billed_units: { input_tokens: number } };
      };

      return {
        embeddings: data.embeddings,
        totalTokens: data.meta.billed_units.input_tokens,
      };
    } finally {
      clearTimeout(timeout);
    }
  }

  private defaultDimensions(model: string): number {
    if (model.includes('embed-english-v3')) return 1024;
    if (model.includes('embed-multilingual-v3')) return 1024;
    return 1024;
  }
}
