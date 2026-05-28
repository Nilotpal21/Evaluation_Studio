/**
 * Recursive Character Chunking Provider
 *
 * Standard recursive text splitter that splits by separators in order:
 * paragraph breaks → line breaks → spaces → characters.
 * Configurable chunk size and overlap.
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:recursive-character-chunking');

export interface RecursiveCharacterChunkingConfig {
  chunkSize?: number;
  chunkOverlap?: number;
  separators?: string[];
}

export class RecursiveCharacterChunkingProvider implements PipelineStageProvider<
  string,
  string[],
  RecursiveCharacterChunkingConfig
> {
  readonly id = 'recursive-character';
  readonly name = 'Recursive Character Splitter';
  readonly type = 'chunking' as const;
  readonly version = '1.0.0';
  readonly description =
    'Split text by paragraph → line → space → character boundaries with configurable size and overlap';

  async execute(input: string, config: RecursiveCharacterChunkingConfig): Promise<string[]> {
    const chunkSize = config.chunkSize ?? 1000;
    const chunkOverlap = config.chunkOverlap ?? 200;
    const separators = config.separators ?? ['\n\n', '\n', ' ', ''];

    logger.info('Recursive character chunking', {
      inputLength: input.length,
      chunkSize,
      chunkOverlap,
    });

    return this.splitText(input, separators, chunkSize, chunkOverlap);
  }

  private splitText(
    text: string,
    separators: string[],
    chunkSize: number,
    chunkOverlap: number,
  ): string[] {
    const chunks: string[] = [];

    if (text.length <= chunkSize) {
      return [text.trim()].filter((t) => t.length > 0);
    }

    // Find the best separator that exists in the text
    let separator = '';
    for (const sep of separators) {
      if (sep === '' || text.includes(sep)) {
        separator = sep;
        break;
      }
    }

    // Split by the chosen separator
    const splits = separator ? text.split(separator) : [...text];

    let currentChunk = '';

    for (const split of splits) {
      const piece = separator ? split + separator : split;

      if ((currentChunk + piece).length > chunkSize && currentChunk.length > 0) {
        chunks.push(currentChunk.trim());

        // Keep overlap from end of current chunk
        if (chunkOverlap > 0 && currentChunk.length > chunkOverlap) {
          currentChunk = currentChunk.slice(-chunkOverlap) + piece;
        } else {
          currentChunk = piece;
        }
      } else {
        currentChunk += piece;
      }
    }

    if (currentChunk.trim().length > 0) {
      chunks.push(currentChunk.trim());
    }

    return chunks.filter((c) => c.length > 0);
  }

  validateConfig(config: unknown): config is RecursiveCharacterChunkingConfig {
    if (typeof config !== 'object' || config === null) return false;
    const c = config as Record<string, unknown>;
    if (c.chunkSize !== undefined) {
      if (typeof c.chunkSize !== 'number' || c.chunkSize < 100 || c.chunkSize > 50000) return false;
    }
    if (c.chunkOverlap !== undefined) {
      if (typeof c.chunkOverlap !== 'number' || c.chunkOverlap < 0 || c.chunkOverlap > 10000)
        return false;
    }
    if (c.separators !== undefined && !Array.isArray(c.separators)) return false;
    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'Recursive Character Splitter Configuration',
      description: 'Split text recursively by separator hierarchy',
      properties: {
        chunkSize: {
          type: 'number',
          description: 'Target chunk size in characters',
          minimum: 100,
          maximum: 50000,
          default: 1000,
        },
        chunkOverlap: {
          type: 'number',
          description: 'Character overlap between chunks',
          minimum: 0,
          maximum: 10000,
          default: 200,
        },
        separators: {
          type: 'array',
          description: 'Custom separator hierarchy (default: paragraph → line → space)',
          items: { type: 'string' },
        },
      },
    };
  }
}
