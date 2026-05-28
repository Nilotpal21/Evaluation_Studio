/**
 * Intent Detection Task
 *
 * Creates pipeline steps for intent detection:
 *   1. Embedding match (optional)
 *   2. Fast LLM
 *   3. Balanced LLM (optional)
 *   4. Regex/keyword fallback
 */

import type {
  NLUContext,
  NLUModelLayerConfig,
  IntentResult,
  IntentCandidate,
  MultiIntentResult,
  IntentRelationship,
} from '../types.js';
import type { PipelineStep } from '../pipeline.js';
import type { ModelRouter } from '../model-router.js';
import type { EmbeddingIntentIndex } from '../engine.js';
import { renderTemplate, loadPromptTemplate } from '../prompt-loader.js';
import { detectIntentFallback } from '../fallbacks.js';
import { parseJSON } from '../utils.js';

export const DEFAULT_INTENT_RESULT: IntentResult = {
  intent: null,
  confidence: 0,
  source: 'fallback',
};

/**
 * Parse an LLM intent detection response into a MultiIntentResult.
 *
 * Handles two formats:
 *   - Multi-intent: { intents: [{ intent, confidence }], relationships: { type, reasoning } }
 *   - Legacy single-intent: { intent, confidence }
 *
 * Applies confidence threshold filtering, sorts by confidence descending,
 * and caps the total number of returned intents at maxIntents.
 */
export function parseIntentResponse(
  json: Record<string, unknown>,
  maxIntents: number,
  threshold: number,
): MultiIntentResult {
  // Handle new multi-intent format
  if (Array.isArray(json.intents)) {
    const intents = (json.intents as Array<{ intent: string; confidence: number }>)
      .filter((i) => i.confidence >= threshold)
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, maxIntents);

    const primary: IntentResult = intents[0]
      ? { intent: intents[0].intent, confidence: intents[0].confidence, source: 'fast' }
      : { intent: null, confidence: 0, source: 'fast' };

    return {
      primary,
      alternatives: intents.slice(1).map((i) => ({
        intent: i.intent,
        confidence: i.confidence,
        source: 'fast' as const,
      })),
      relationships: (json.relationships as IntentRelationship) ?? {
        type: 'ambiguous',
        reasoning: '',
      },
    };
  }

  // Handle legacy single-intent format (backward compatible)
  return {
    primary: {
      intent: (json.intent as string) ?? null,
      confidence: (json.confidence as number) ?? 0.8,
      source: 'fast',
    },
    alternatives: [],
    relationships: { type: 'ambiguous', reasoning: '' },
  };
}

export function createIntentSteps(
  router: ModelRouter,
  embeddingIndex?: EmbeddingIntentIndex,
  embeddingThreshold?: number,
): PipelineStep<IntentResult>[] {
  const steps: PipelineStep<IntentResult>[] = [];
  const { primary, primaryLayer, fallback, fallbackLayer } =
    router.getLayerForTask('intent_detection');

  // 1. Embedding step (optional)
  if (embeddingIndex) {
    steps.push({
      name: 'intent_embedding',
      layer: 'embedding',
      async execute(ctx: NLUContext): Promise<IntentResult | null> {
        const result = await embeddingIndex.match(ctx.userMessage);
        if (result && result.confidence >= (embeddingThreshold ?? 0.85)) {
          return result;
        }
        return null;
      },
    });
  }

  // 2. Fast LLM step
  steps.push({
    name: 'intent_fast_llm',
    layer: primaryLayer,
    async execute(ctx: NLUContext, input: unknown): Promise<IntentResult | null> {
      const candidates = input as IntentCandidate[];
      return detectIntentWithLLM(ctx, candidates, primary, primaryLayer);
    },
  });

  // 3. Balanced LLM step (optional)
  if (fallback && fallbackLayer) {
    steps.push({
      name: 'intent_balanced_llm',
      layer: fallbackLayer,
      async execute(ctx: NLUContext, input: unknown): Promise<IntentResult | null> {
        const candidates = input as IntentCandidate[];
        return detectIntentWithLLM(ctx, candidates, fallback, fallbackLayer);
      },
    });
  }

  // 4. Regex/keyword fallback
  if (router.isFallbackEnabled()) {
    steps.push({
      name: 'intent_regex_fallback',
      layer: 'fallback',
      async execute(ctx: NLUContext, input: unknown): Promise<IntentResult | null> {
        const candidates = input as IntentCandidate[];
        const result = detectIntentFallback(ctx.userMessage, candidates);
        // Always return from fallback (it has its own confidence)
        return result;
      },
    });
  }

  return steps;
}

/** Default confidence threshold for multi-intent filtering */
const DEFAULT_MULTI_INTENT_THRESHOLD = 0.5;

/** Default maximum number of intents to return */
const DEFAULT_MAX_INTENTS = 3;

async function detectIntentWithLLM(
  ctx: NLUContext,
  candidates: IntentCandidate[],
  layer: NLUModelLayerConfig,
  layerName: string,
): Promise<IntentResult | null> {
  try {
    const template = loadPromptTemplate('intent');

    const intentsList = candidates
      .map((c) => {
        let desc = `- ${c.name}: keywords=[${c.patterns.join(', ')}]`;
        if (c.examples && c.examples.length > 0) {
          desc += ` examples=[${c.examples.slice(0, 3).join('; ')}]`;
        }
        return desc;
      })
      .join('\n');

    let fewShotStr = '';
    if (ctx.fewShotExamples && ctx.fewShotExamples.length > 0) {
      fewShotStr = ctx.fewShotExamples
        .slice(0, 5)
        .map((e) => `User: "${e.input}" → ${e.output}`)
        .join('\n');
    }

    const vars = buildTemplateVars(ctx, {
      intents: intentsList,
      fewShotExamples: fewShotStr,
    });
    const systemPrompt = renderTemplate(template.system, vars);

    const response = await layer.provider.chat(
      systemPrompt,
      [{ role: 'user', content: ctx.userMessage }],
      { model: layer.model, timeoutMs: layer.timeoutMs ?? 2000 },
    );

    const parsed = parseJSON<Record<string, unknown>>(response);
    if (!parsed) {
      return null;
    }

    // Use parseIntentResponse for both multi-intent and legacy formats
    const multiResult = parseIntentResponse(
      parsed,
      DEFAULT_MAX_INTENTS,
      DEFAULT_MULTI_INTENT_THRESHOLD,
    );

    const primary = multiResult.primary;
    if (primary.intent && primary.intent !== 'none') {
      return {
        intent: primary.intent,
        confidence: primary.confidence,
        source: layerName as IntentResult['source'],
        alternatives: multiResult.alternatives.map((alt) => ({
          intent: alt.intent!,
          confidence: alt.confidence,
        })),
      };
    }

    return {
      intent: null,
      confidence: primary.confidence,
      source: layerName as IntentResult['source'],
    };
  } catch {
    return null;
  }
}

export function buildTemplateVars(
  ctx: NLUContext,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    agentGoal: ctx.agentGoal,
    agentDomain: ctx.agentDomain,
    language: ctx.detectedLanguage || ctx.sessionLanguage,
    conversationPhase: ctx.conversationPhase,
    pendingQuestion: ctx.pendingQuestion,
    collectedData: JSON.stringify(ctx.collectedData),
    missingFields: ctx.missingFields?.join(', '),
    glossary: ctx.glossary?.join(', '),
    ...extra,
  };
}
