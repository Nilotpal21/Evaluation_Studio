/**
 * Language Detection Task
 *
 * Wraps the existing language.ts module with consistent NLUContext API.
 */

import type { NLUContext, LanguageResult, NLUModelLayerConfig } from '../types.js';
import type { ModelRouter } from '../model-router.js';
import { detectLanguage as detectLangLLM } from '../language.js';
import { detectLanguageFallback } from '../fallbacks.js';

export async function detectLanguageFromContext(
  ctx: NLUContext,
  router: ModelRouter,
): Promise<LanguageResult> {
  const { primary } = router.getLayerForTask('language_detection');

  try {
    return await detectLangLLM(ctx.userMessage, primary);
  } catch {
    return detectLanguageFallback(ctx.userMessage);
  }
}
