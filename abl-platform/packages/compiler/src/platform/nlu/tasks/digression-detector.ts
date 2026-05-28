/**
 * Digression Detection Task
 *
 * Delegates to intent detection by converting DigressionCandidate[] to IntentCandidate[].
 */

import type {
  NLUContext,
  DigressionResult,
  DigressionCandidate,
  IntentCandidate,
  IntentResult,
} from '../types.js';
import type { NLUTaskPipeline } from '../pipeline.js';

export const DEFAULT_DIGRESSION_RESULT: DigressionResult = {
  detected: false,
  confidence: 0,
  source: 'fallback',
};

export async function detectDigression(
  ctx: NLUContext,
  digressions: DigressionCandidate[],
  intentPipeline: NLUTaskPipeline<IntentResult>,
): Promise<DigressionResult> {
  const candidates: IntentCandidate[] = digressions.map((d) => ({
    name: d.intent,
    patterns: d.keywords ?? [],
  }));

  const result = await intentPipeline.execute(ctx, candidates);

  return {
    detected: result.intent !== null,
    intent: result.intent || undefined,
    confidence: result.confidence,
    source: result.source,
  };
}
