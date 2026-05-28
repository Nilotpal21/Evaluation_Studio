/**
 * BGE-M3 Embedding Provider
 *
 * Wraps the embedding-worker capabilities as a registered provider.
 * Uses BGE-M3 model for generating 1024-dimensional embeddings.
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:bge-m3-embedding');

export interface BGEM3EmbeddingConfig {
  /** Embedding model identifier */
  model?: string;
  /** Vector dimensions */
  dimensions?: number;
  /** Batch size for embedding generation */
  batchSize?: number;
}

/**
 * BGE-M3 Embedding Provider
 *
 * Generates dense vector embeddings using the BGE-M3 model.
 * Self-hosted, no external API calls. 1024-dimensional by default.
 */
export class BGEM3EmbeddingProvider implements PipelineStageProvider<
  unknown,
  unknown,
  BGEM3EmbeddingConfig
> {
  readonly id = 'bge-m3';
  readonly name = 'BGE-M3 Embeddings';
  readonly type = 'embedding' as const;
  readonly version = '1.0.0';
  readonly description =
    'Self-hosted BGE-M3 embeddings (1024-dim). No external API calls, runs locally.';

  async execute(input: unknown, config: BGEM3EmbeddingConfig): Promise<unknown> {
    logger.warn('Direct provider execution not yet wired — use BullMQ worker pipeline');
    throw new ProviderExecutionError(
      'Direct execution not supported. Use BullMQ worker pipeline.',
      this.id,
    );
  }

  validateConfig(config: unknown): config is BGEM3EmbeddingConfig {
    if (typeof config !== 'object' || config === null) {
      return false;
    }

    const c = config as Record<string, unknown>;

    if (c.model !== undefined && typeof c.model !== 'string') {
      return false;
    }

    if (c.dimensions !== undefined) {
      if (typeof c.dimensions !== 'number' || c.dimensions < 1 || c.dimensions > 4096) {
        return false;
      }
    }

    if (c.batchSize !== undefined) {
      if (typeof c.batchSize !== 'number' || c.batchSize < 1 || c.batchSize > 1000) {
        return false;
      }
    }

    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'BGE-M3 Embedding Configuration',
      description: 'Configure self-hosted BGE-M3 embedding generation',
      properties: {
        model: {
          type: 'string',
          description: 'Model identifier',
          default: 'bge-m3',
        },
        dimensions: {
          type: 'number',
          description: 'Vector dimensions (1024 for BGE-M3)',
          minimum: 1,
          maximum: 4096,
          default: 1024,
        },
        batchSize: {
          type: 'number',
          description: 'Number of chunks to embed per batch request',
          minimum: 1,
          maximum: 1000,
          default: 32,
        },
      },
    };
  }

  async estimateDuration(): Promise<number> {
    return 45_000; // ~45 seconds for embedding generation
  }
}
