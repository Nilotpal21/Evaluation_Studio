/**
 * Shared Field Mapping Pipeline Service
 *
 * Runs the 3-tier mapping pipeline: Rules → LLM → Fallback.
 * Used by both JSON field config (file uploads) and connector field preview
 * (pre-sync mapping). Single implementation, no code duplication.
 *
 * Tier 1 — Rule-Based: Uses connector-type-templates pattern matching (~70% coverage)
 * Tier 2 — LLM: Handles custom fields and unusual naming (remaining ~20%)
 * Tier 3 — Fallback: Assigns custom slots for anything still unmapped (~10%)
 */

import { createLogger } from '@abl/compiler/platform';
import type { IDiscoveredSchemaField } from '@agent-platform/database/models';
import type { IConnectorSchemaField } from '@agent-platform/database/models';
import {
  generateMappings,
  type RuleBasedMappingResult,
} from '@agent-platform/search-ai-internal/services';
import { getAvailableFieldsForLLM } from '@agent-platform/search-ai-internal/canonical';
import { mappingSuggestionService, type MappingSuggestion } from './mapping-suggestion/index.js';

const logger = createLogger('field-mapping-pipeline');

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Convert IDiscoveredSchemaField → IConnectorSchemaField for MappingSuggestionService */
function toConnectorSchemaField(field: IDiscoveredSchemaField): IConnectorSchemaField {
  return {
    path: field.path,
    label: field.name,
    type: field.type,
    isCustom: false,
    isRequired: field.required ?? false,
    enumValues: field.enumValues,
  };
}

/** Convert RuleBasedMappingResult → MappingSuggestion for merging */
function toMappingSuggestion(result: RuleBasedMappingResult): MappingSuggestion {
  return {
    canonicalField: result.canonicalField,
    sourcePath: result.sourcePath,
    transform: result.transform,
    confidence: result.confidence,
    reasoning: result.reasoning,
    suggestedAlias: result.suggestedAlias,
    suggestedLabel: result.suggestedLabel,
  };
}

// ─── Pipeline ─────────────────────────────────────────────────────────────

/**
 * Run the full mapping pipeline: Rule-Based → LLM → Fallback.
 * Returns a Map of sourcePath → best suggestion (rule wins on conflict).
 *
 * @param discoveredFields - Fields to map (from JSON schema, introspection, or templates)
 * @param connectorType - Connector type slug for rule-based template matching
 * @param tenantId - Tenant ID for LLM service calls
 * @param indexId - Index ID for LLM service calls
 */
export async function runMappingPipeline(
  discoveredFields: IDiscoveredSchemaField[],
  connectorType: string,
  tenantId: string,
  indexId: string,
): Promise<Map<string, MappingSuggestion>> {
  // ─── Tier 1: Rule-based mapping ─────────────────────────────────────
  const ruleResults = generateMappings({
    fields: discoveredFields,
    connectorType,
    logger,
  });

  logger.info('Rule-based mapping completed', {
    ruleMatchCount: ruleResults.length,
    fieldCount: discoveredFields.length,
    connectorType,
  });

  const ruleSourcePaths = new Set(ruleResults.map((r) => r.sourcePath));

  // ─── Tier 2: LLM mapping for fields not covered by rules ───────────
  const fieldsForLLM = discoveredFields.filter((f) => !ruleSourcePaths.has(f.path));
  let llmSuggestions: MappingSuggestion[] = [];

  if (fieldsForLLM.length > 0) {
    try {
      const availableFields = getAvailableFieldsForLLM();
      const llmResponse = await mappingSuggestionService.suggestMappings(tenantId, indexId, {
        sourceFields: fieldsForLLM.map(toConnectorSchemaField),
        canonicalFields: availableFields,
        connectorType,
        existingMappings: [],
      });
      llmSuggestions = llmResponse.suggestions;
      logger.info('LLM mapping completed', {
        llmSuggestionCount: llmSuggestions.length,
        averageConfidence: llmResponse.averageConfidence,
        processingTimeMs: llmResponse.processingTimeMs,
        connectorType,
      });
    } catch (llmErr) {
      logger.warn('LLM mapping failed, continuing with rule-based only', {
        error: llmErr instanceof Error ? llmErr.message : String(llmErr),
        connectorType,
      });
    }
  }

  // ─── Merge: rule-based wins on conflict, dedup by canonicalField ────
  const resultMap = new Map<string, MappingSuggestion>();
  const usedCanonicalFields = new Set<string>();

  // Rule-based first (highest priority)
  for (const r of ruleResults) {
    if (!usedCanonicalFields.has(r.canonicalField)) {
      resultMap.set(r.sourcePath, toMappingSuggestion(r));
      usedCanonicalFields.add(r.canonicalField);
    }
  }
  // LLM suggestions next (skip if sourcePath already mapped OR canonicalField already taken)
  for (const s of llmSuggestions) {
    if (!resultMap.has(s.sourcePath) && !usedCanonicalFields.has(s.canonicalField)) {
      resultMap.set(s.sourcePath, s);
      usedCanonicalFields.add(s.canonicalField);
    }
  }

  // ─── Tier 3: Fallback — assign custom slots for unmapped fields ─────
  // Initialize counters from the highest custom slot already used in Tier 1/2
  // to avoid assigning duplicate canonicalField values.
  const customSlotCounters = { string: 0, number: 0, date: 0, bool: 0 };
  for (const usedField of usedCanonicalFields) {
    const stringMatch = usedField.match(/^custom_string_(\d+)$/);
    if (stringMatch) {
      customSlotCounters.string = Math.max(customSlotCounters.string, parseInt(stringMatch[1], 10));
      continue;
    }
    const numberMatch = usedField.match(/^custom_number_(\d+)$/);
    if (numberMatch) {
      customSlotCounters.number = Math.max(customSlotCounters.number, parseInt(numberMatch[1], 10));
      continue;
    }
    const dateMatch = usedField.match(/^custom_date_(\d+)$/);
    if (dateMatch) {
      customSlotCounters.date = Math.max(customSlotCounters.date, parseInt(dateMatch[1], 10));
      continue;
    }
    const boolMatch = usedField.match(/^custom_bool_(\d+)$/);
    if (boolMatch) {
      customSlotCounters.bool = Math.max(customSlotCounters.bool, parseInt(boolMatch[1], 10));
      continue;
    }
  }

  for (const field of discoveredFields) {
    if (resultMap.has(field.path)) continue;

    const fieldType = field.type || 'string';
    let customField: string;
    let slotType: string;
    if (fieldType === 'number') {
      customSlotCounters.number += 1;
      customField = `custom_number_${customSlotCounters.number}`;
      slotType = 'number';
    } else if (fieldType === 'boolean') {
      customSlotCounters.bool += 1;
      customField = `custom_bool_${customSlotCounters.bool}`;
      slotType = 'boolean';
    } else if (fieldType === 'date') {
      customSlotCounters.date += 1;
      customField = `custom_date_${customSlotCounters.date}`;
      slotType = 'date';
    } else {
      customSlotCounters.string += 1;
      customField = `custom_string_${customSlotCounters.string}`;
      slotType = 'string';
    }

    const humanLabel = field.path
      .split(/[._-]/)
      .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
      .join(' ');

    resultMap.set(field.path, {
      canonicalField: customField,
      sourcePath: field.path,
      transform: { type: 'direct' },
      confidence: 0.5,
      reasoning: `No rule or LLM match — assigned custom ${slotType} slot "${customField}"`,
      suggestedAlias: humanLabel,
      suggestedLabel: humanLabel,
    });

    logger.info('Assigned custom slot for unmapped field', {
      fieldPath: field.path,
      customField,
      label: humanLabel,
    });
  }

  return resultMap;
}
