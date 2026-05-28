/**
 * Fixed Size Chunking Provider
 *
 * Simple fixed-size text splitter. Splits text into chunks of exact size
 * with configurable overlap. No semantic awareness.
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:fixed-size-chunking');

export interface FixedSizeChunkingConfig {
  chunkSize?: number;
  chunkOverlap?: number;
}

export class FixedSizeChunkingProvider implements PipelineStageProvider<
  string,
  string[],
  FixedSizeChunkingConfig
> {
  readonly id = 'fixed-size';
  readonly name = 'Fixed Size Splitter';
  readonly type = 'chunking' as const;
  readonly version = '1.0.0';
  readonly description =
    'Split text into fixed-size chunks by character count with configurable overlap';

  async execute(input: string, config: FixedSizeChunkingConfig): Promise<string[]> {
    const chunkSize = config.chunkSize ?? 1000;
    const chunkOverlap = config.chunkOverlap ?? 200;

    logger.info('Fixed size chunking', { inputLength: input.length, chunkSize, chunkOverlap });

    const chunks: string[] = [];
    let start = 0;

    while (start < input.length) {
      const end = Math.min(start + chunkSize, input.length);
      const chunk = input.slice(start, end).trim();
      if (chunk.length > 0) {
        chunks.push(chunk);
      }
      start += chunkSize - chunkOverlap;
      if (start >= input.length) break;
      // Prevent infinite loop if overlap >= chunkSize
      if (chunkSize - chunkOverlap <= 0) break;
    }

    return chunks;
  }

  validateConfig(config: unknown): config is FixedSizeChunkingConfig {
    if (typeof config !== 'object' || config === null) return false;
    const c = config as Record<string, unknown>;
    if (c.chunkSize !== undefined) {
      if (typeof c.chunkSize !== 'number' || c.chunkSize < 50 || c.chunkSize > 50000) return false;
    }
    if (c.chunkOverlap !== undefined) {
      if (typeof c.chunkOverlap !== 'number' || c.chunkOverlap < 0 || c.chunkOverlap > 25000)
        return false;
    }
    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'Fixed Size Splitter Configuration',
      description: 'Split text into equal-sized chunks',
      properties: {
        chunkSize: {
          type: 'number',
          description: 'Chunk size in characters',
          minimum: 50,
          maximum: 50000,
          default: 1000,
        },
        chunkOverlap: {
          type: 'number',
          description: 'Character overlap between chunks',
          minimum: 0,
          maximum: 25000,
          default: 200,
        },
      },
    };
  }
}
