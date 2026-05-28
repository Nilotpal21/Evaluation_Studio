/**
 * Custom LLM Stage Provider
 *
 * Lets users configure a custom LLM call within the pipeline — specify
 * a prompt template, select a model tier, and map the LLM output back
 * into chunk content or metadata. Similar to http-webhook but uses the
 * platform's LLM infrastructure instead of an external endpoint.
 *
 * Use cases:
 * - Custom classification (add category/topic labels to chunks)
 * - Custom summarization with specific prompts
 * - Entity extraction with domain-specific instructions
 * - Content rewriting (simplify, translate, expand)
 * - Metadata generation (keywords, tags, sentiment)
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:llm-stage');

export interface LlmStageConfig {
  /** The prompt template — use {{content}} and {{metadata}} as placeholders */
  promptTemplate: string;
  /** What to do with the LLM response */
  outputMapping: 'replace-content' | 'append-metadata' | 'both';
  /** If append-metadata, the key to store the result under */
  metadataKey?: string;
  /** LLM model tier */
  modelTier?: 'fast' | 'balanced' | 'powerful';
  /** Max tokens for LLM response */
  maxTokens?: number;
  /** Temperature (0-1) */
  temperature?: number;
  /** System prompt (optional) */
  systemPrompt?: string;
}

export class LlmStageProvider implements PipelineStageProvider<unknown, unknown, LlmStageConfig> {
  readonly id = 'llm-stage';
  readonly name = 'Custom LLM';
  readonly type = 'llm-stage' as const;
  readonly version = '1.0.0';
  readonly description =
    'Run a custom LLM prompt against chunk content — classify, summarize, extract, translate, or rewrite';

  async execute(input: unknown, config: LlmStageConfig): Promise<unknown> {
    logger.warn('Direct provider execution not yet wired — use BullMQ worker pipeline');
    throw new ProviderExecutionError(
      'Direct execution not supported. Use BullMQ worker pipeline.',
      this.id,
    );
  }

  validateConfig(config: unknown): config is LlmStageConfig {
    if (typeof config !== 'object' || config === null) return false;
    const c = config as Record<string, unknown>;

    if (typeof c.promptTemplate !== 'string' || c.promptTemplate.trim().length === 0) return false;

    const validMappings = ['replace-content', 'append-metadata', 'both'];
    if (c.outputMapping !== undefined && !validMappings.includes(c.outputMapping as string))
      return false;

    if (c.metadataKey !== undefined && typeof c.metadataKey !== 'string') return false;

    const validTiers = ['fast', 'balanced', 'powerful'];
    if (c.modelTier !== undefined && !validTiers.includes(c.modelTier as string)) return false;

    if (c.maxTokens !== undefined) {
      if (typeof c.maxTokens !== 'number' || c.maxTokens < 10 || c.maxTokens > 4000) return false;
    }
    if (c.temperature !== undefined) {
      if (typeof c.temperature !== 'number' || c.temperature < 0 || c.temperature > 1) return false;
    }
    if (c.systemPrompt !== undefined && typeof c.systemPrompt !== 'string') return false;

    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'Custom LLM Configuration',
      description:
        'Run a custom LLM prompt against chunk content. Use {{content}} as placeholder in the template.',
      properties: {
        promptTemplate: {
          type: 'string',
          description:
            'Prompt template. Use {{content}} for chunk text and {{metadata}} for chunk metadata.',
          default:
            'Classify the following text into one of these categories: [Technical, Business, Legal, General].\n\nText: {{content}}\n\nCategory:',
        },
        outputMapping: {
          type: 'string',
          description:
            'How to use the LLM response: replace chunk content, append to metadata, or both',
          enum: ['replace-content', 'append-metadata', 'both'],
          default: 'append-metadata',
        },
        metadataKey: {
          type: 'string',
          description:
            'Metadata key for the LLM output (when outputMapping is append-metadata or both)',
          default: 'llmResult',
        },
        modelTier: {
          type: 'string',
          description: 'LLM model tier: fast (cheap), balanced, powerful (expensive)',
          enum: ['fast', 'balanced', 'powerful'],
          default: 'fast',
        },
        maxTokens: {
          type: 'number',
          description: 'Max tokens for LLM response',
          minimum: 10,
          maximum: 4000,
          default: 500,
        },
        temperature: {
          type: 'number',
          description: 'LLM temperature (0 = deterministic, 1 = creative)',
          minimum: 0,
          maximum: 1,
          default: 0,
        },
        systemPrompt: {
          type: 'string',
          description: 'Optional system prompt for the LLM',
        },
      },
      required: ['promptTemplate'],
    };
  }

  async estimateDuration(): Promise<number> {
    return 30_000;
  }
}
