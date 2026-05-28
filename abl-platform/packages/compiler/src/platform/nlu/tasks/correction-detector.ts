/**
 * Correction Detection Task
 *
 * Creates pipeline steps for detecting user corrections:
 *   1. Fast LLM detection
 *   2. Regex pattern fallback
 */

import type { NLUContext, CorrectionResult } from '../types.js';
import type { PipelineStep } from '../pipeline.js';
import type { ModelRouter } from '../model-router.js';
import { renderTemplate, loadPromptTemplate } from '../prompt-loader.js';
import { detectCorrectionFallback } from '../fallbacks.js';
import { parseJSON } from '../utils.js';
import { buildTemplateVars } from './intent-detector.js';

export const DEFAULT_CORRECTION_RESULT: CorrectionResult = {
  detected: false,
  confidence: 0,
  source: 'fallback',
};

export function createCorrectionSteps(router: ModelRouter): PipelineStep<CorrectionResult>[] {
  const steps: PipelineStep<CorrectionResult>[] = [];
  const { primary, primaryLayer } = router.getLayerForTask('correction_detection');

  // 1. Fast LLM step
  steps.push({
    name: 'correction_fast_llm',
    layer: primaryLayer,
    async execute(ctx: NLUContext, input: unknown): Promise<CorrectionResult | null> {
      const collected = input as Record<string, unknown>;
      try {
        const template = loadPromptTemplate('correction');
        const vars = buildTemplateVars(ctx, {
          collectedData: JSON.stringify(collected, null, 2),
        });
        const systemPrompt = renderTemplate(template.system, vars);

        const response = await primary.provider.chat(
          systemPrompt,
          [{ role: 'user', content: ctx.userMessage }],
          { model: primary.model, timeoutMs: primary.timeoutMs ?? 2000 },
        );

        const parsed = parseJSON<{
          detected: boolean;
          field?: string;
          newValue?: unknown;
          confidence?: number;
        }>(response);

        if (parsed) {
          return {
            detected: parsed.detected,
            field: parsed.field || undefined,
            newValue: parsed.newValue,
            oldValue: parsed.field ? collected[parsed.field] : undefined,
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
      name: 'correction_regex_fallback',
      layer: 'fallback',
      async execute(ctx: NLUContext, input: unknown): Promise<CorrectionResult | null> {
        const collected = input as Record<string, unknown>;
        return detectCorrectionFallback(ctx.userMessage, collected);
      },
    });
  }

  return steps;
}
