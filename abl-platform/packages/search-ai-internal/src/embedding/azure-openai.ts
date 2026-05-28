/**
 * Azure OpenAI Embedding Provider
 *
 * Uses the Azure OpenAI Service embeddings API.
 * Key differences from vanilla OpenAI:
 *   - URL: https://{resource}.openai.azure.com/openai/deployments/{deployment}/embeddings?api-version={version}
 *   - Auth header: `api-key` (not `Authorization: Bearer`)
 *   - No `model` field in request body (determined by deployment)
 *   - Requires resourceName + deploymentId + apiVersion
 */

import type { EmbeddingProvider, EmbeddingProviderConfig, EmbeddingResult } from './interface.js';
import { countTokens } from '../tokenizer/index.js';

const AZURE_DEFAULT_API_VERSION = '2024-10-21';

export interface AzureOpenAIEmbeddingConfig extends EmbeddingProviderConfig {
  /** Azure resource name (e.g., 'my-openai-resource') */
  resourceName: string;
  /** Deployment name in Azure (e.g., 'text-embedding-3-small') */
  deploymentId: string;
  /** Azure API version (default: 2024-10-21) */
  apiVersion?: string;
}

export class AzureOpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'azure';
  readonly modelId: string;
  readonly dimensions: number;
  readonly maxBatchSize: number;

  private readonly apiKey: string;
  private readonly endpointUrl: string;
  private readonly timeoutMs: number;
  /** Whether dimensions was explicitly configured (always send to Azure API) */
  private readonly explicitDimensions: boolean;

  constructor(config: AzureOpenAIEmbeddingConfig) {
    if (!config.resourceName) {
      throw new Error('Azure OpenAI embedding provider requires resourceName');
    }
    if (!config.deploymentId) {
      throw new Error('Azure OpenAI embedding provider requires deploymentId');
    }
    if (!config.apiKey) {
      throw new Error('Azure OpenAI embedding provider requires apiKey');
    }

    this.apiKey = config.apiKey;
    this.modelId = config.model || config.deploymentId;
    this.explicitDimensions = config.dimensions != null;
    this.dimensions = config.dimensions ?? this.defaultDimensions(config.deploymentId);
    this.maxBatchSize = config.maxBatchSize ?? 100;
    this.timeoutMs = config.timeoutMs ?? 30_000;

    const apiVersion = config.apiVersion || AZURE_DEFAULT_API_VERSION;
    const resourceName = config.resourceName.replace(/\.openai\.azure\.com.*$/, '');
    this.endpointUrl = `https://${resourceName}.openai.azure.com/openai/deployments/${config.deploymentId}/embeddings?api-version=${apiVersion}`;
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
    const maxRetries = 3;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), this.timeoutMs);

      try {
        const headers: Record<string, string> = {
          'Content-Type': 'application/json',
          'api-key': this.apiKey,
        };

        const body: Record<string, unknown> = {
          input: texts,
        };

        // Azure deployments: always send dimensions when explicitly configured.
        // Unlike vanilla OpenAI (where model is in the body), Azure uses a fixed
        // deployment — the deployment may be text-embedding-3-large (3072 default)
        // but the pipeline config requests 1536. We must always tell Azure the
        // desired output dimension to avoid vector index mismatches.
        if (this.explicitDimensions) {
          body.dimensions = this.dimensions;
        }

        const response = await fetch(this.endpointUrl, {
          method: 'POST',
          headers,
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
          throw new Error(`Azure OpenAI embeddings API failed (${response.status}): ${errorText}`);
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

    throw new Error('Azure OpenAI embeddings API: max retries exceeded');
  }

  private defaultDimensions(model: string): number {
    if (model.includes('text-embedding-3-large')) return 3072;
    if (model.includes('text-embedding-3-small')) return 1536;
    if (model.includes('ada-002') || model.includes('ada')) return 1536;
    return 1536;
  }
}
