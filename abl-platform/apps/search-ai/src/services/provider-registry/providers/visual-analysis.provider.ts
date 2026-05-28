/**
 * Visual Analysis Provider
 *
 * Replaces the visual/multimodal portion of the old `enrichment` stage.
 * Analyzes images, screenshots, charts, and tables via vision models.
 *
 * Maps to the `search-visual-enrichment` BullMQ queue. The visual
 * enrichment worker reads these providerConfig fields when the stage
 * type is `visual-analysis`.
 */

import { type PipelineStageProvider, type JSONSchema, ProviderExecutionError } from '../types.js';
import { createLogger } from '@abl/compiler/platform';

const logger = createLogger('provider:visual-analysis');

export interface VisualAnalysisConfig {
  /** Analyze embedded images */
  analyzeImages?: boolean;
  /** Detect and analyze screenshots */
  analyzeScreenshots?: boolean;
  /** Analyze charts/graphs */
  analyzeCharts?: boolean;
  /** Generate table summaries */
  summarizeTables?: boolean;
  /** Merge multi-page tables */
  enhanceTableContinuations?: boolean;
  /** Vision model tier: balanced / powerful */
  modelTier?: 'balanced' | 'powerful';
  /** Max tokens for descriptions */
  maxTokens?: number;
}

export class VisualAnalysisProvider implements PipelineStageProvider<
  unknown,
  unknown,
  VisualAnalysisConfig
> {
  readonly id = 'visual-analysis';
  readonly name = 'Visual Analysis';
  readonly type = 'visual-analysis' as const;
  readonly version = '1.0.0';
  readonly description = 'Analyze images, screenshots, charts, and tables with vision models';

  async execute(input: unknown, config: VisualAnalysisConfig): Promise<unknown> {
    logger.warn('Direct provider execution not yet wired — use BullMQ worker pipeline');
    throw new ProviderExecutionError(
      'Direct execution not supported. Use BullMQ worker pipeline.',
      this.id,
    );
  }

  validateConfig(config: unknown): config is VisualAnalysisConfig {
    if (typeof config !== 'object' || config === null) {
      return false;
    }

    const c = config as Record<string, unknown>;

    if (c.analyzeImages !== undefined && typeof c.analyzeImages !== 'boolean') return false;
    if (c.analyzeScreenshots !== undefined && typeof c.analyzeScreenshots !== 'boolean')
      return false;
    if (c.analyzeCharts !== undefined && typeof c.analyzeCharts !== 'boolean') return false;
    if (c.summarizeTables !== undefined && typeof c.summarizeTables !== 'boolean') return false;
    if (
      c.enhanceTableContinuations !== undefined &&
      typeof c.enhanceTableContinuations !== 'boolean'
    )
      return false;

    if (c.modelTier !== undefined) {
      if (!['balanced', 'powerful'].includes(c.modelTier as string)) return false;
    }

    if (c.maxTokens !== undefined) {
      if (typeof c.maxTokens !== 'number' || c.maxTokens < 200 || c.maxTokens > 2000) return false;
    }

    return true;
  }

  getSchema(): JSONSchema {
    return {
      type: 'object',
      title: 'Visual Analysis Configuration',
      description: 'Configure vision-model analysis of images, charts, and tables',
      properties: {
        analyzeImages: {
          type: 'boolean',
          description: 'Analyze embedded images',
          default: true,
        },
        analyzeScreenshots: {
          type: 'boolean',
          description: 'Detect and analyze screenshots',
          default: true,
        },
        analyzeCharts: {
          type: 'boolean',
          description: 'Analyze charts and graphs',
          default: true,
        },
        summarizeTables: {
          type: 'boolean',
          description: 'Generate table summaries',
          default: true,
        },
        enhanceTableContinuations: {
          type: 'boolean',
          description: 'Merge multi-page tables',
          default: true,
        },
        modelTier: {
          type: 'string',
          description: 'Vision model tier: balanced or powerful',
          enum: ['balanced', 'powerful'],
          default: 'balanced',
        },
        maxTokens: {
          type: 'number',
          description: 'Max tokens for visual descriptions',
          minimum: 200,
          maximum: 2000,
          default: 500,
        },
      },
    };
  }

  async estimateDuration(): Promise<number> {
    return 120_000; // ~2 minutes for visual analysis
  }
}
