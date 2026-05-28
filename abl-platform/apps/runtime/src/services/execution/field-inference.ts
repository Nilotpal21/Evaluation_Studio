/**
 * LLM field inference — infers missing field values from collected context.
 * Uses fast-tier LLM, gated by confidence threshold.
 * Inferred values are marked as inferred in session metadata.
 */

import { createLogger, renderSensitiveValue } from '@abl/compiler/platform';
import type { GatherField } from '@abl/compiler';
import { promptTemplateLoader } from './prompt-template-loader.js';
import { interpolateTemplate } from './value-resolution.js';

const log = createLogger('field-inference');

export interface InferableField {
  name: string;
  type: string;
  infer?: boolean;
  infer_confidence?: number;
  infer_confirm?: boolean;
  validation?: { type: string; rule: string; error_message: string };
}

export interface InferenceConfig {
  confidence: number; // default 0.8
  confirm: boolean; // default true
  model_tier: 'fast' | 'balanced'; // default 'fast'
  max_fields_per_pass: number; // default 3
}

export interface InferenceResult {
  field: string;
  value: unknown;
  confidence: number;
  reasoning: string;
  accepted: boolean;
}

/** Default inference configuration */
export const DEFAULT_INFERENCE_CONFIG: InferenceConfig = {
  confidence: 0.8,
  confirm: true,
  model_tier: 'fast',
  max_fields_per_pass: 3,
};

/** Check if inference should be attempted for a field. */
export function shouldAttemptInference(
  field: InferableField,
  collectedValues: Record<string, unknown>,
): boolean {
  if (!field.infer) return false;
  if (field.name in collectedValues && collectedValues[field.name] != null) return false;
  return true;
}

/** Build the LLM prompt for inferring missing field values. */
export function buildInferencePrompt(
  fields: InferableField[],
  context: Record<string, unknown>,
  promptOverride?: string,
): string {
  const contextStr = Object.entries(context)
    .map(([k, v]) => `  ${k}: ${JSON.stringify(v)}`)
    .join('\n');

  const fieldDescriptions = fields
    .map((f) => {
      let desc = `- ${f.name} (type: ${f.type})`;
      if (f.validation?.rule) {
        desc += ` [valid values: ${f.validation.rule}]`;
      }
      return desc;
    })
    .join('\n');

  return interpolateTemplate(
    promptOverride ?? promptTemplateLoader.getLLMPrompt('field_inference'),
    { contextStr, fieldDescriptions },
  );
}

/** Parse LLM inference response and apply confidence gating. */
export function parseInferenceResponse(
  response: unknown,
  confidenceThreshold: number,
): InferenceResult[] {
  if (!response || typeof response !== 'object') return [];

  const data = response as {
    inferences?: Array<{
      field: string;
      value: unknown;
      confidence: number;
      reasoning: string;
    }>;
  };

  if (!Array.isArray(data.inferences)) return [];

  return data.inferences.map((inf) => ({
    field: inf.field,
    value: inf.value,
    confidence: inf.confidence,
    reasoning: inf.reasoning ?? '',
    accepted: inf.confidence >= confidenceThreshold,
  }));
}

/**
 * Apply accepted inferences to session values and mark them as inferred.
 * Returns the applied values and an optional confirmation message.
 */
export function applyInferences(
  results: InferenceResult[],
  values: Record<string, unknown>,
  confirm: boolean,
  gatherFields?: GatherField[],
): { applied: Record<string, unknown>; confirmationMessage: string | null } {
  const applied: Record<string, unknown> = {};
  const inferred: Record<string, { confidence: number; reasoning: string }> = {};

  const fieldMap = new Map<string, GatherField>();
  if (gatherFields) {
    for (const f of gatherFields) {
      fieldMap.set(f.name, f);
    }
  }

  for (const r of results) {
    if (!r.accepted) continue;
    applied[r.field] = r.value;
    inferred[r.field] = { confidence: r.confidence, reasoning: r.reasoning };
  }

  if (Object.keys(inferred).length > 0) {
    const existing = (values._inferred as Record<string, unknown>) ?? {};
    values._inferred = { ...existing, ...inferred };
  }

  let confirmationMessage: string | null = null;
  if (confirm && Object.keys(applied).length > 0) {
    const parts = Object.entries(applied).map(([field, value]) => {
      const gatherField = fieldMap.get(field);
      const displayValue =
        gatherField && gatherField.sensitive
          ? renderSensitiveValue(value, gatherField)
          : JSON.stringify(value);
      return `${field.replace(/_/g, ' ')}: ${displayValue}`;
    });
    confirmationMessage = `I'll assume ${parts.join(', ')}. Does that work?`;
  }

  return { applied, confirmationMessage };
}

/**
 * Filter inferable fields from a gather field list, returning only those
 * that are eligible for inference (infer=true and not yet collected).
 */
export function getInferableFields(
  gatherFields: Array<{
    name: string;
    type?: string;
    infer?: boolean;
    infer_confidence?: number;
    infer_confirm?: boolean;
    validation?: { type: string; rule: string; error_message: string };
  }>,
  collectedValues: Record<string, unknown>,
  maxFields: number,
): InferableField[] {
  const eligible: InferableField[] = [];

  for (const field of gatherFields) {
    if (eligible.length >= maxFields) break;

    const inferableField: InferableField = {
      name: field.name,
      type: field.type ?? 'string',
      infer: field.infer,
      infer_confidence: field.infer_confidence,
      infer_confirm: field.infer_confirm,
      validation: field.validation,
    };

    if (shouldAttemptInference(inferableField, collectedValues)) {
      eligible.push(inferableField);
    }
  }

  log.debug('Identified inferable fields', {
    total: gatherFields.length,
    eligible: eligible.length,
    fields: eligible.map((f) => f.name),
  });

  return eligible;
}
