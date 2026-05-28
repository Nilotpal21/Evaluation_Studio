/**
 * Tree Builder Chunking Provider
 *
 * Wraps the tree-builder-worker capabilities as a registered provider.
 * Uses hierarchical tree structure for intelligent document chunking.
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:tree-builder-chunking');

export interface TreeBuilderChunkingConfig {
  /** Maximum tokens per chunk */
  maxChunkTokens?: number;
  /** Overlap tokens between chunks */
  overlap?: number;
}

/**
 * Tree Builder Chunking Provider
 *
 * Splits documents into semantically meaningful chunks using a hierarchical
 * tree structure. Respects document structure (headings, sections, paragraphs).
 */
export class TreeBuilderChunkingProvider implements PipelineStageProvider<
  unknown,
  unknown,
  TreeBuilderChunkingConfig
> {
  readonly id = 'tree-builder';
  readonly name = 'Tree Builder';
  readonly type = 'chunking' as const;
  readonly version = '1.0.0';
  readonly description =
    'Hierarchical tree-based chunking that respects document structure (headings, sections)';

  async execute(input: unknown, config: TreeBuilderChunkingConfig): Promise<unknown> {
    logger.warn('Direct provider execution not yet wired — use BullMQ worker pipeline');
    throw new ProviderExecutionError(
      'Direct execution not supported. Use BullMQ worker pipeline.',
      this.id,
    );
  }

  validateConfig(config: unknown): config is TreeBuilderChunkingConfig {
    if (typeof config !== 'object' || config === null) {
      return false;
    }

    const c = config as Record<string, unknown>;

    if (c.maxChunkTokens !== undefined) {
      if (
        typeof c.maxChunkTokens !== 'number' ||
        c.maxChunkTokens < 64 ||
        c.maxChunkTokens > 8192
      ) {
        return false;
      }
    }

    if (c.overlap !== undefined) {
      if (typeof c.overlap !== 'number' || c.overlap < 0 || c.overlap > 512) {
        return false;
      }
    }

    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'Tree Builder Chunking Configuration',
      description: 'Configure hierarchical tree-based document chunking',
      properties: {
        maxChunkTokens: {
          type: 'number',
          description: 'Maximum tokens per chunk',
          minimum: 64,
          maximum: 8192,
          default: 512,
        },
        overlap: {
          type: 'number',
          description: 'Token overlap between adjacent chunks',
          minimum: 0,
          maximum: 512,
          default: 50,
        },
      },
    };
  }

  async estimateDuration(): Promise<number> {
    return 30_000; // ~30 seconds for chunking
  }
}
