/**
 * Category Classification Task
 *
 * Creates pipeline steps for category classification:
 *   1. Fast LLM classification
 *   2. Regex/keyword fallback
 */

import type { NLUContext, CategoryResult, CategoryDefinition } from '../types.js';
import type { PipelineStep } from '../pipeline.js';
import type { ModelRouter } from '../model-router.js';
import { renderTemplate, loadPromptTemplate } from '../prompt-loader.js';
import { classifyCategoryFallback } from '../fallbacks.js';
import { parseJSON } from '../utils.js';
import { buildTemplateVars } from './intent-detector.js';

export const DEFAULT_CATEGORY_RESULT: CategoryResult = {
  category: null,
  confidence: 0,
  source: 'fallback',
};

export function createCategorySteps(router: ModelRouter): PipelineStep<CategoryResult>[] {
  const steps: PipelineStep<CategoryResult>[] = [];
  const { primary, primaryLayer } = router.getLayerForTask('category_classification');

  // 1. Fast LLM step
  steps.push({
    name: 'category_fast_llm',
    layer: primaryLayer,
    async execute(ctx: NLUContext, input: unknown): Promise<CategoryResult | null> {
      const categories = input as CategoryDefinition[];
      try {
        const template = loadPromptTemplate('category');
        const vars = buildTemplateVars(ctx, {
          categories: categories.map((c) => `- ${c.name}: ${c.patterns.join(', ')}`).join('\n'),
        });
        const systemPrompt = renderTemplate(template.system, vars);

        const response = await primary.provider.chat(
          systemPrompt,
          [{ role: 'user', content: ctx.userMessage }],
          { model: primary.model, timeoutMs: primary.timeoutMs ?? 2000 },
        );

        const parsed = parseJSON<{ category: string; confidence: number }>(response);
        if (parsed && parsed.category && parsed.category !== 'none') {
          return {
            category: parsed.category,
            confidence: parsed.confidence ?? 0.8,
            source: primaryLayer,
          };
        }
        return null;
      } catch {
        return null;
      }
    },
  });

  // 2. Regex fallback
  if (router.isFallbackEnabled()) {
    steps.push({
      name: 'category_regex_fallback',
      layer: 'fallback',
      async execute(ctx: NLUContext, input: unknown): Promise<CategoryResult | null> {
        const categories = input as CategoryDefinition[];
        return classifyCategoryFallback(ctx.userMessage, categories);
      },
    });
  }

  return steps;
}
