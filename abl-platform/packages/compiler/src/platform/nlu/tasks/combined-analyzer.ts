/**
 * Combined NLU Analysis Task
 *
 * Orchestrates multiple NLU tasks. Tries a single combined LLM prompt
 * first for efficiency, then falls back to individual task pipelines.
 */

import type {
  NLUContext,
  NLUModelLayerConfig,
  AnalysisResult,
  AnalyzeOptions,
  IntentResult,
  CategoryResult,
  EntityResult,
  CorrectionResult,
} from '../types.js';
import type { ModelRouter } from '../model-router.js';
import type { NLUTaskPipeline } from '../pipeline.js';
import { renderTemplate, loadPromptTemplate } from '../prompt-loader.js';
import { parseJSON } from '../utils.js';
import { buildTemplateVars } from './intent-detector.js';

export interface CombinedAnalyzerDeps {
  router: ModelRouter;
  intentPipeline: NLUTaskPipeline<IntentResult>;
  categoryPipeline: NLUTaskPipeline<CategoryResult>;
  entityPipeline: NLUTaskPipeline<EntityResult>;
  correctionPipeline: NLUTaskPipeline<CorrectionResult>;
  detectLanguage: (ctx: NLUContext) => Promise<import('../types.js').LanguageResult>;
}

export async function analyzeInputCombined(
  ctx: NLUContext,
  options: AnalyzeOptions,
  deps: CombinedAnalyzerDeps,
): Promise<AnalysisResult> {
  const result: AnalysisResult = {};

  // Try combined prompt for efficiency
  const { primary, primaryLayer } = deps.router.getLayerForTask('combined_analysis');

  try {
    const template = loadPromptTemplate('combined');

    const buildParts: string[] = [];
    if (options.detectIntent && options.intents) {
      buildParts.push(
        `Intent classification from: ${options.intents.map((i) => i.name).join(', ')}`,
      );
    }
    if (options.classifyCategory && options.categories) {
      buildParts.push(
        `Category classification from: ${options.categories.map((c) => c.name).join(', ')}`,
      );
    }
    if (options.extractEntities && options.entityFields) {
      buildParts.push(
        `Entity extraction for: ${options.entityFields.map((f) => f.name).join(', ')}`,
      );
    }
    if (options.detectCorrection) {
      buildParts.push('Correction detection');
    }

    const vars = buildTemplateVars(ctx, {
      detectIntent: options.detectIntent ? 'true' : '',
      classifyCategory: options.classifyCategory ? 'true' : '',
      extractEntities: options.extractEntities ? 'true' : '',
      detectCorrection: options.detectCorrection ? 'true' : '',
      intents:
        options.intents?.map((i) => `- ${i.name}: ${i.patterns.join(', ')}`).join('\n') || '',
      categories:
        options.categories?.map((c) => `- ${c.name}: ${c.patterns.join(', ')}`).join('\n') || '',
      entityFields:
        options.entityFields?.map((f) => `- ${f.name} (${f.type || 'string'})`).join('\n') || '',
    });

    const systemPrompt =
      renderTemplate(template.system, vars) + '\n\nAnalyze:\n' + buildParts.join('\n');

    const response = await primary.provider.chat(
      systemPrompt,
      [{ role: 'user', content: ctx.userMessage }],
      { model: primary.model, timeoutMs: primary.timeoutMs ?? 5000 },
    );

    const parsed = parseJSON<Record<string, unknown>>(response);

    if (parsed) {
      if (options.detectIntent && parsed.intent) {
        const intentData = parsed.intent as { intent: string; confidence: number };
        result.intent = {
          intent: intentData.intent === 'none' ? null : intentData.intent,
          confidence: intentData.confidence ?? 0.8,
          source: primaryLayer,
        };
      }

      if (options.classifyCategory && parsed.category) {
        const catData = parsed.category as { category: string; confidence: number };
        result.category = {
          category: catData.category === 'none' ? null : catData.category,
          confidence: catData.confidence ?? 0.8,
          source: primaryLayer,
        };
      }

      if (options.extractEntities && parsed.entities) {
        const entities = parsed.entities as Record<string, unknown>;
        const values: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(entities)) {
          if (v !== null && v !== undefined && v !== 'null') values[k] = v;
        }
        const fieldNames = options.entityFields?.map((f) => f.name) || [];
        result.entities = {
          values,
          missing: fieldNames.filter((f) => values[f] === undefined),
          confidence: Object.fromEntries(Object.keys(values).map((k) => [k, 0.8])),
          source: primaryLayer,
        };
      }

      if (options.detectCorrection && parsed.correction) {
        const corr = parsed.correction as { detected: boolean; field?: string; newValue?: unknown };
        result.correction = {
          detected: corr.detected,
          field: corr.field,
          newValue: corr.newValue,
          confidence: 0.8,
          source: primaryLayer,
        };
      }

      return result;
    }
  } catch {
    // Fall through to individual calls
  }

  // Fallback: run individual NLU task pipelines
  if (options.detectIntent && options.intents) {
    result.intent = await deps.intentPipeline.execute(ctx, options.intents);
  }
  if (options.classifyCategory && options.categories) {
    result.category = await deps.categoryPipeline.execute(ctx, options.categories);
  }
  if (options.extractEntities && options.entityFields) {
    result.entities = await deps.entityPipeline.execute(ctx, options.entityFields);
  }
  if (options.detectCorrection && options.collectedData) {
    result.correction = await deps.correctionPipeline.execute(ctx, options.collectedData);
  }
  if (options.detectLanguage) {
    result.language = await deps.detectLanguage(ctx);
  }

  return result;
}
