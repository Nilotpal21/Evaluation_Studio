/**
 * Sub-Intent Detection Task
 *
 * Delegates to intent detection by converting SubIntentCandidate[] to IntentCandidate[].
 */

import type {
  NLUContext,
  SubIntentResult,
  SubIntentCandidate,
  IntentCandidate,
  IntentResult,
} from '../types.js';
import type { NLUTaskPipeline } from '../pipeline.js';

export async function detectSubIntent(
  ctx: NLUContext,
  subIntents: SubIntentCandidate[],
  intentPipeline: NLUTaskPipeline<IntentResult>,
): Promise<SubIntentResult> {
  const candidates: IntentCandidate[] = subIntents.map((s) => ({
    name: s.name,
    patterns: s.patterns || [s.name],
  }));

  const result = await intentPipeline.execute(ctx, candidates);

  return {
    subIntent: result.intent,
    confidence: result.confidence,
    source: result.source,
  };
}
