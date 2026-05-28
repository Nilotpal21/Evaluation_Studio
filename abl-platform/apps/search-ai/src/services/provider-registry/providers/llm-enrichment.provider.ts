/**
 * LLM Enrichment Provider
 *
 * Wraps the llm-enrichment-worker capabilities as a registered provider.
 * Uses LLM to extract metadata, generate summaries, and enrich documents.
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:llm-enrichment');

export interface LLMEnrichmentConfig {
  /** Fields to extract from document content */
  extractFields?: string[];
  /** Whether to generate document summary */
  generateSummary?: boolean;
  /** Maximum tokens for LLM context */
  maxContextTokens?: number;
}

/**
 * LLM Enrichment Provider
 *
 * Enriches document chunks with LLM-generated metadata including
 * entity extraction, summarization, and classification.
 */
export class LLMEnrichmentProvider implements PipelineStageProvider<
  unknown,
  unknown,
  LLMEnrichmentConfig
> {
  readonly id = 'llm-enrichment';
  readonly name = 'LLM Metadata Enrichment';
  readonly type = 'enrichment' as const;
  readonly version = '1.0.0';
  readonly description =
    'Enrich documents with LLM-generated metadata: entity extraction, summaries, classification';

  async execute(input: unknown, config: LLMEnrichmentConfig): Promise<unknown> {
    logger.warn('Direct provider execution not yet wired — use BullMQ worker pipeline');
    throw new ProviderExecutionError(
      'Direct execution not supported. Use BullMQ worker pipeline.',
      this.id,
    );
  }

  validateConfig(config: unknown): config is LLMEnrichmentConfig {
    if (typeof config !== 'object' || config === null) {
      return false;
    }

    const c = config as Record<string, unknown>;

    if (c.extractFields !== undefined && !Array.isArray(c.extractFields)) {
      return false;
    }

    if (c.generateSummary !== undefined && typeof c.generateSummary !== 'boolean') {
      return false;
    }

    if (c.maxContextTokens !== undefined) {
      if (
        typeof c.maxContextTokens !== 'number' ||
        c.maxContextTokens < 100 ||
        c.maxContextTokens > 128000
      ) {
        return false;
      }
    }

    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'LLM Enrichment Configuration',
      description: 'Configure LLM-based document enrichment',
      properties: {
        extractFields: {
          type: 'array',
          description: 'Metadata fields to extract (e.g., author, date, category)',
          items: { type: 'string' },
        },
        generateSummary: {
          type: 'boolean',
          description: 'Generate a summary for each chunk',
          default: false,
        },
        maxContextTokens: {
          type: 'number',
          description: 'Maximum tokens for LLM context window',
          minimum: 100,
          maximum: 128000,
          default: 4096,
        },
      },
    };
  }

  async estimateDuration(): Promise<number> {
    return 60_000; // ~1 minute for LLM enrichment
  }
}
