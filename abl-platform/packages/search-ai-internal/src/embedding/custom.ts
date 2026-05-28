/**
 * Custom Embedding Provider
 *
 * Generic provider for any OpenAI-compatible embeddings API.
 * Allows customers to use:
 * - Self-hosted Sentence Transformers (text-embeddings-inference)
 * - Hugging Face Inference Endpoints
 * - Custom fine-tuned models
 * - Air-gapped deployments
 *
 * Expected API: OpenAI-compatible
 *   POST {baseUrl}/embeddings
 *   { "input": [...], "model": "..." }
 */

import type { EmbeddingProvider, EmbeddingProviderConfig, EmbeddingResult } from './interface.js';
import { countTokens } from '../tokenizer/index.js';

export class CustomEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'custom';
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;

  private readonly apiKey?: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;

  constructor(config: EmbeddingProviderConfig) {
    if (!config.baseUrl) {
      throw new Error('Custom provider requires baseUrl');
    }
    if (!config.dimensions) {
      throw new Error('Custom provider requires dimensions');
    }

    this.apiKey = config.apiKey;
    this.modelId = config.model;
    this.dimensions = config.dimensions;
    this.maxBatchSize = config.maxBatchSize ?? 50;
    this.timeoutMs = config.timeoutMs ?? 60_000;
    this.baseUrl = config.baseUrl.replace(/\/$/, '');
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
      const headers: Record<string, string> = {
        'Content-Type': 'application/json',
      };

      if (this.apiKey) {
        headers.Authorization = `Bearer ${this.apiKey}`;
      }

      const response = await fetch(`${this.baseUrl}/embeddings`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          input: texts,
          model: this.modelId,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => '');
        throw new Error(`Custom embedding API failed (${response.status}): ${errorText}`);
      }

      const data = (await response.json()) as {
        data: Array<{ embedding: number[]; index: number }>;
        usage?: { prompt_tokens?: number; total_tokens?: number };
      };

      const sorted = data.data.sort((a, b) => a.index - b.index);

      return {
        embeddings: sorted.map((d) => d.embedding),
        totalTokens: data.usage?.total_tokens ?? 0,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
