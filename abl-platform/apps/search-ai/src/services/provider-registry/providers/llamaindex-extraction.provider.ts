/**
 * LlamaIndex Extraction Provider
 *
 * Wraps the legacy extraction-worker as a registered provider.
 * Handles plain text, markdown, and simple formats.
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:llamaindex-extraction');

export interface LlamaIndexExtractionConfig {
  /** Maximum content length to extract (bytes) */
  maxContentLength?: number;
}

/**
 * LlamaIndex Simple Extraction Provider
 *
 * Simple text extraction for plain text, markdown, and basic formats.
 * Used as fallback when Docling is not available or not needed.
 */
export class LlamaIndexExtractionProvider implements PipelineStageProvider<
  unknown,
  unknown,
  LlamaIndexExtractionConfig
> {
  readonly id = 'llamaindex';
  readonly name = 'LlamaIndex Simple';
  readonly type = 'extraction' as const;
  readonly version = '1.0.0';
  readonly description = 'Simple text extraction for plain text, markdown, and basic formats';

  async execute(input: unknown, config: LlamaIndexExtractionConfig): Promise<unknown> {
    logger.warn('Direct provider execution not yet wired — use BullMQ worker pipeline');
    throw new ProviderExecutionError(
      'Direct execution not supported. Use BullMQ worker pipeline.',
      this.id,
    );
  }

  validateConfig(config: unknown): config is LlamaIndexExtractionConfig {
    if (typeof config !== 'object' || config === null) {
      return false;
    }

    const c = config as Record<string, unknown>;

    if (c.maxContentLength !== undefined && typeof c.maxContentLength !== 'number') {
      return false;
    }

    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'LlamaIndex Simple Extraction',
      description: 'Simple text extraction for plain formats',
      properties: {
        maxContentLength: {
          type: 'number',
          description: 'Maximum content length to extract (bytes)',
          minimum: 1000,
          maximum: 100_000_000,
          default: 10_000_000,
        },
      },
    };
  }

  async estimateDuration(): Promise<number> {
    return 10_000; // ~10 seconds for simple extraction
  }
}
