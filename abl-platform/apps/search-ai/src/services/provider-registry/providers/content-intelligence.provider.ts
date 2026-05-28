/**
 * Content Intelligence Provider
 *
 * Replaces the text enrichment portion of the old `enrichment` stage.
 * Generates per-chunk summaries, document-level summaries, per-chunk
 * questions, and document-level questions via LLM.
 *
 * Maps to the `search-enrichment` BullMQ queue. The enrichment worker
 * reads these providerConfig fields when the stage type is
 * `content-intelligence`.
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:content-intelligence');

export interface ContentIntelligenceConfig {
  /** Per-chunk summarization */
  generateSummary?: boolean;
  /** Max tokens per chunk summary */
  summaryMaxTokens?: number;
  /** Whole-document summary */
  documentSummary?: boolean;
  /** Max tokens for doc summary */
  documentSummaryMaxTokens?: number;
  /** Per-chunk question synthesis */
  generateQuestions?: boolean;
  /** Questions generated per chunk */
  questionsPerChunk?: number;
  /** Whole-document questions */
  documentQuestions?: boolean;
  /** Questions for whole doc */
  documentQuestionsCount?: number;
  /** LLM model selection tier: fast / balanced / powerful */
  modelTier?: 'fast' | 'balanced' | 'powerful';
}

export class ContentIntelligenceProvider implements PipelineStageProvider<
  unknown,
  unknown,
  ContentIntelligenceConfig
> {
  readonly id = 'content-intelligence';
  readonly name = 'Content Intelligence';
  readonly type = 'content-intelligence' as const;
  readonly version = '1.0.0';
  readonly description = 'Generate per-chunk and document-level summaries and questions via LLM';

  async execute(input: unknown, config: ContentIntelligenceConfig): Promise<unknown> {
    logger.warn('Direct provider execution not yet wired — use BullMQ worker pipeline');
    throw new ProviderExecutionError(
      'Direct execution not supported. Use BullMQ worker pipeline.',
      this.id,
    );
  }

  validateConfig(config: unknown): config is ContentIntelligenceConfig {
    if (typeof config !== 'object' || config === null) {
      return false;
    }

    const c = config as Record<string, unknown>;

    if (c.generateSummary !== undefined && typeof c.generateSummary !== 'boolean') return false;
    if (c.documentSummary !== undefined && typeof c.documentSummary !== 'boolean') return false;
    if (c.generateQuestions !== undefined && typeof c.generateQuestions !== 'boolean') return false;
    if (c.documentQuestions !== undefined && typeof c.documentQuestions !== 'boolean') return false;

    if (c.summaryMaxTokens !== undefined) {
      if (
        typeof c.summaryMaxTokens !== 'number' ||
        c.summaryMaxTokens < 100 ||
        c.summaryMaxTokens > 1000
      )
        return false;
    }
    if (c.documentSummaryMaxTokens !== undefined) {
      if (
        typeof c.documentSummaryMaxTokens !== 'number' ||
        c.documentSummaryMaxTokens < 200 ||
        c.documentSummaryMaxTokens > 2000
      )
        return false;
    }
    if (c.questionsPerChunk !== undefined) {
      if (
        typeof c.questionsPerChunk !== 'number' ||
        c.questionsPerChunk < 1 ||
        c.questionsPerChunk > 10
      )
        return false;
    }
    if (c.documentQuestionsCount !== undefined) {
      if (
        typeof c.documentQuestionsCount !== 'number' ||
        c.documentQuestionsCount < 1 ||
        c.documentQuestionsCount > 20
      )
        return false;
    }
    if (c.modelTier !== undefined) {
      if (!['fast', 'balanced', 'powerful'].includes(c.modelTier as string)) return false;
    }

    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'Content Intelligence Configuration',
      description: 'Configure LLM-powered content intelligence: summaries and questions',
      properties: {
        generateSummary: {
          type: 'boolean',
          description: 'Generate per-chunk summaries',
          default: true,
        },
        summaryMaxTokens: {
          type: 'number',
          description: 'Max tokens per chunk summary',
          minimum: 100,
          maximum: 1000,
          default: 300,
        },
        documentSummary: {
          type: 'boolean',
          description: 'Generate a whole-document summary',
          default: true,
        },
        documentSummaryMaxTokens: {
          type: 'number',
          description: 'Max tokens for document summary',
          minimum: 200,
          maximum: 2000,
          default: 500,
        },
        generateQuestions: {
          type: 'boolean',
          description: 'Generate synthetic questions per chunk',
          default: true,
        },
        questionsPerChunk: {
          type: 'number',
          description: 'Number of questions generated per chunk',
          minimum: 1,
          maximum: 10,
          default: 3,
        },
        documentQuestions: {
          type: 'boolean',
          description: 'Generate whole-document questions',
          default: true,
        },
        documentQuestionsCount: {
          type: 'number',
          description: 'Number of questions for the whole document',
          minimum: 1,
          maximum: 20,
          default: 5,
        },
        modelTier: {
          type: 'string',
          description: 'LLM model tier: fast (cheap), balanced, powerful (expensive)',
          enum: ['fast', 'balanced', 'powerful'],
          default: 'fast',
        },
      },
    };
  }

  async estimateDuration(): Promise<number> {
    return 90_000; // ~1.5 minutes for content intelligence
  }
}
