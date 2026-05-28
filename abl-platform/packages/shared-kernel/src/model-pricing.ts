/**
 * Model Pricing — Canonical LLM pricing table for cost estimation.
 *
 * Single source of truth used by:
 * - apps/studio/src/utils/llm-cost.ts (UI cost display)
 *
 * Per-1M token pricing for common models. Used as fallback when the LLM
 * provider response doesn't include an actual cost. Keeps analytics non-zero
 * even before a full pricing service is wired in.
 */

export interface ModelPricing {
  inputPer1M: number;
  outputPer1M: number;
}

export const MODEL_PRICING: Record<string, ModelPricing> = {
  // Anthropic Claude
  'claude-opus-4-7': { inputPer1M: 5, outputPer1M: 25 },
  'claude-opus-4-20250514': { inputPer1M: 15, outputPer1M: 75 },
  'claude-opus-4': { inputPer1M: 15, outputPer1M: 75 },
  'claude-sonnet-4-20250514': { inputPer1M: 3, outputPer1M: 15 },
  'claude-sonnet-4': { inputPer1M: 3, outputPer1M: 15 },
  'claude-3-5-sonnet-20241022': { inputPer1M: 3, outputPer1M: 15 },
  'claude-3-5-sonnet-20240620': { inputPer1M: 3, outputPer1M: 15 },
  'claude-3.5-sonnet': { inputPer1M: 3, outputPer1M: 15 },
  'claude-haiku-4-5-20251001': { inputPer1M: 0.8, outputPer1M: 4 },
  'claude-3-5-haiku-20241022': { inputPer1M: 0.8, outputPer1M: 4 },
  'claude-3.5-haiku': { inputPer1M: 0.8, outputPer1M: 4 },
  // OpenAI
  'gpt-4.1': { inputPer1M: 2, outputPer1M: 8 },
  'gpt-4.1-mini': { inputPer1M: 0.4, outputPer1M: 1.6 },
  'gpt-4.1-nano': { inputPer1M: 0.1, outputPer1M: 0.4 },
  'gpt-4o': { inputPer1M: 2.5, outputPer1M: 10 },
  'gpt-4o-mini': { inputPer1M: 0.15, outputPer1M: 0.6 },
  o3: { inputPer1M: 10, outputPer1M: 40 },
  'o3-mini': { inputPer1M: 1.1, outputPer1M: 4.4 },
  'o4-mini': { inputPer1M: 1.1, outputPer1M: 4.4 },
  // Google
  'gemini-2.5-pro': { inputPer1M: 1.25, outputPer1M: 10 },
  'gemini-2.5-flash': { inputPer1M: 0.15, outputPer1M: 0.6 },
  'gemini-2.0-flash': { inputPer1M: 0.1, outputPer1M: 0.4 },
};

/** Default — Sonnet-tier pricing as reasonable middle ground */
export const DEFAULT_PRICING: ModelPricing = { inputPer1M: 3, outputPer1M: 15 };

/**
 * Estimate the cost of an LLM call based on model and token counts.
 * Tries exact match first, then substring match for versioned model IDs.
 */
export function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  if (inputTokens === 0 && outputTokens === 0) return 0;

  // Try exact match first, then substring match for versioned model IDs
  let pricing = MODEL_PRICING[model];
  if (!pricing) {
    const lowerModel = model.toLowerCase();
    for (const [key, val] of Object.entries(MODEL_PRICING)) {
      if (lowerModel.includes(key) || key.includes(lowerModel)) {
        pricing = val;
        break;
      }
    }
  }
  if (!pricing) pricing = DEFAULT_PRICING;

  return (
    (inputTokens / 1_000_000) * pricing.inputPer1M +
    (outputTokens / 1_000_000) * pricing.outputPer1M
  );
}
