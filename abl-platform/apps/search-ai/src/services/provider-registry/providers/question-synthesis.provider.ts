/**
 * Question Synthesis Enrichment Provider
 *
 * Wraps the existing question-synthesis-worker.
 * Generates questions answerable by each chunk for HyDE-style retrieval.
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:question-synthesis');

export interface QuestionSynthesisConfig {
  questionsPerChunk?: number;
  llmProvider?: string;
  model?: string;
}

export class QuestionSynthesisProvider implements PipelineStageProvider<
  unknown,
  unknown,
  QuestionSynthesisConfig
> {
  readonly id = 'question-synthesis';
  readonly name = 'Question Synthesis';
  readonly type = 'enrichment' as const;
  readonly version = '1.0.0';
  readonly description =
    'Generate questions answerable by each chunk to improve retrieval quality (HyDE-style)';

  async execute(input: unknown, config: QuestionSynthesisConfig): Promise<unknown> {
    logger.warn('Direct provider execution not yet wired — use BullMQ worker pipeline');
    throw new ProviderExecutionError(
      'Direct execution not supported. Use BullMQ worker pipeline.',
      this.id,
    );
  }

  validateConfig(config: unknown): config is QuestionSynthesisConfig {
    if (typeof config !== 'object' || config === null) return false;
    const c = config as Record<string, unknown>;
    if (c.questionsPerChunk !== undefined) {
      if (
        typeof c.questionsPerChunk !== 'number' ||
        c.questionsPerChunk < 1 ||
        c.questionsPerChunk > 20
      )
        return false;
    }
    if (c.llmProvider !== undefined && typeof c.llmProvider !== 'string') return false;
    if (c.model !== undefined && typeof c.model !== 'string') return false;
    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'Question Synthesis Configuration',
      description: 'Configure LLM-based question generation per chunk',
      properties: {
        questionsPerChunk: {
          type: 'number',
          description: 'Number of questions to generate per chunk',
          minimum: 1,
          maximum: 20,
          default: 3,
        },
        llmProvider: {
          type: 'string',
          description: 'LLM provider for generation (resolved via credential system)',
        },
        model: {
          type: 'string',
          description: 'LLM model name (e.g., gemini-flash, gpt-4o-mini)',
        },
      },
    };
  }
}
