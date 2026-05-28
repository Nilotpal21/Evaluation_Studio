/**
 * Entity Extraction Task
 *
 * Creates pipeline steps for entity extraction:
 *   1. Fast LLM extraction
 *   2. Balanced LLM extraction (optional)
 *   3. Pattern-based fallback
 */

import type {
  NLUContext,
  NLUModelLayerConfig,
  EntityResult,
  EntityField,
  EntityDefinition,
} from '../types.js';
import type { PipelineStep } from '../pipeline.js';
import type { ModelRouter } from '../model-router.js';
import { renderTemplate, loadPromptTemplate } from '../prompt-loader.js';
import { extractEntitiesFallback } from '../fallbacks.js';
import { createLogger } from '../../logger.js';

const log = createLogger('entity-extractor');
import { parseJSON } from '../utils.js';
import { buildTemplateVars } from './intent-detector.js';

export const DEFAULT_ENTITY_RESULT: EntityResult = {
  values: {},
  missing: [],
  confidence: {},
  source: 'fallback',
};

export function createEntitySteps(router: ModelRouter): PipelineStep<EntityResult>[] {
  const steps: PipelineStep<EntityResult>[] = [];
  const { primary, primaryLayer, fallback, fallbackLayer } =
    router.getLayerForTask('entity_extraction');

  // 1. Fast LLM step
  steps.push({
    name: 'entity_fast_llm',
    layer: primaryLayer,
    async execute(ctx: NLUContext, input: unknown): Promise<EntityResult | null> {
      const fields = input as EntityField[];
      return extractEntitiesWithLLM(ctx, fields, primary, primaryLayer);
    },
  });

  // 2. Balanced LLM step (optional)
  if (fallback && fallbackLayer) {
    steps.push({
      name: 'entity_balanced_llm',
      layer: fallbackLayer,
      async execute(ctx: NLUContext, input: unknown): Promise<EntityResult | null> {
        const fields = input as EntityField[];
        return extractEntitiesWithLLM(ctx, fields, fallback, fallbackLayer);
      },
    });
  }

  // 3. Pattern fallback
  if (router.isFallbackEnabled()) {
    steps.push({
      name: 'entity_pattern_fallback',
      layer: 'fallback',
      async execute(ctx: NLUContext, input: unknown): Promise<EntityResult | null> {
        const fields = input as EntityField[];
        const entityDefs: EntityDefinition[] = ctx.declaredEntities || [];
        return extractEntitiesFallback(ctx.userMessage, fields, entityDefs);
      },
    });
  }

  return steps;
}

async function extractEntitiesWithLLM(
  ctx: NLUContext,
  fields: EntityField[],
  layer: NLUModelLayerConfig,
  layerName: string,
): Promise<EntityResult | null> {
  try {
    const template = loadPromptTemplate('entity');
    const entityFieldsStr = fields
      .map((f) => {
        let desc = `- ${f.name} (${f.type || 'string'})`;
        if (f.prompt) desc += `: ${f.prompt}`;
        if (f.values) desc += ` [allowed: ${f.values.join(', ')}]`;
        if (f.synonyms) {
          const synStr = Object.entries(f.synonyms)
            .map(([k, v]) => `${k}=${v.join('/')}`)
            .join(', ');
          desc += ` [synonyms: ${synStr}]`;
        }
        return desc;
      })
      .join('\n');

    const entityDefs = ctx.declaredEntities
      ?.map((e) => {
        let desc = `- ${e.name} (${e.type})`;
        if (e.values) desc += `: ${e.values.join(', ')}`;
        if (e.synonyms) {
          const synStr = Object.entries(e.synonyms)
            .map(([k, v]) => `${k}=${v.join('/')}`)
            .join('; ');
          desc += ` [synonyms: ${synStr}]`;
        }
        return desc;
      })
      .join('\n');

    const vars = buildTemplateVars(ctx, {
      entityFields: entityFieldsStr,
      entityDefinitions: entityDefs,
    });
    const systemPrompt = renderTemplate(template.system, vars);

    const schema = `{${fields.map((f) => `"${f.name}": "value or null"`).join(', ')}}`;

    let result: Record<string, unknown>;

    if (layer.provider.extractJson) {
      result = await layer.provider.extractJson(
        systemPrompt,
        [{ role: 'user', content: ctx.userMessage }],
        schema,
        { model: layer.model, timeoutMs: layer.timeoutMs ?? 3000 },
      );
    } else {
      const response = await layer.provider.chat(
        systemPrompt,
        [{ role: 'user', content: ctx.userMessage }],
        { model: layer.model, timeoutMs: layer.timeoutMs ?? 3000 },
      );
      result = parseJSON<Record<string, unknown>>(response) || {};
    }

    // Filter nulls
    const values: Record<string, unknown> = {};
    const confidence: Record<string, number> = {};
    for (const [key, value] of Object.entries(result)) {
      if (value !== null && value !== undefined && value !== 'null') {
        values[key] = value;
        confidence[key] = 0.8;
      }
    }

    const missing = fields.filter((f) => values[f.name] === undefined).map((f) => f.name);

    return {
      values,
      missing,
      confidence,
      source: layerName as EntityResult['source'],
    };
  } catch (err) {
    log.warn('Entity extraction LLM call failed', {
      error: err instanceof Error ? err.message : String(err),
      fields: fields.map((f) => f.name),
    });
    return null;
  }
}
