/**
 * Connector Field Preview Service
 *
 * Generic service for generating pre-sync field previews for any connector type.
 * No per-connector logic — uses connector-type-templates (static patterns) and
 * optional schema introspection (via ISchemaIntrospection interface on each connector).
 *
 * Field sources (merged in priority order):
 * 1. Schema Introspection — actual fields from source API (highest priority)
 * 2. Connector Type Templates — static field patterns per category (fallback)
 *
 * Mapping pipeline: same shared 3-tier pipeline (Rules → LLM → Fallback).
 */

import { createLogger } from '@abl/compiler/platform';
import type { IDiscoveredSchemaField } from '@agent-platform/database/models';
import {
  getTemplateForConnector,
  getFixedMappings,
  matchFieldByPattern,
  type ConnectorTypeTemplate,
} from '@agent-platform/search-ai-internal/canonical';
import {
  AVAILABLE_CANONICAL_FIELDS,
  getAvailableField,
} from '@agent-platform/search-ai-internal/canonical';
import { runMappingPipeline } from './field-mapping-pipeline.service.js';
import type { MappingSuggestion } from './mapping-suggestion/index.js';
import type { IntrospectedField } from '@agent-platform/connectors-base';

const logger = createLogger('connector-field-preview');

// ─── Types ────────────────────────────────────────────────────────────────

export interface FieldPreviewItem {
  sourcePath: string;
  displayName: string;
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'array';
  sampleValues: string[];
  suggestedMapping: {
    canonicalField: string;
    confidence: number;
    displayLabel: string;
    reasoning: string;
  } | null;
  suggestedForEmbedding: boolean;
  source: 'template' | 'introspection' | 'merged';
}

export interface FieldPreviewResult {
  fields: FieldPreviewItem[];
  availableCanonicalFields: Array<{
    value: string;
    label: string;
    type: string;
    group: string;
  }>;
  connectorType: string;
  hasIntrospectionData: boolean;
  templateFieldCount: number;
  introspectedFieldCount: number;
}

// ─── Embedding Heuristic ──────────────────────────────────────────────────

const EMBED_FIELDS = new Set([
  'title',
  'description',
  'body',
  'content',
  'tags',
  'labels',
  'comments',
  'content_summary',
]);

const NO_EMBED_FIELDS = new Set([
  'status',
  'priority',
  'assignee',
  'reporter',
  'author',
  'created_date',
  'modified_date',
  'source_type',
  'category',
  'file_size',
  'mime_type',
  'url',
  'version',
  'parent_id',
  'is_archived',
  'resolution',
  'due_date',
  'resolved_date',
  'comment_count',
  'severity',
]);

function isEmbeddableField(canonicalField: string): boolean {
  if (EMBED_FIELDS.has(canonicalField)) return true;
  if (canonicalField.startsWith('custom_string_')) return true;
  if (NO_EMBED_FIELDS.has(canonicalField)) return false;
  return true;
}

// ─── Humanize Helper ──────────────────────────────────────────────────────

function humanize(fieldPath: string): string {
  const lastSegment = fieldPath.includes('.') ? fieldPath.split('.').pop()! : fieldPath;
  return lastSegment
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .split(/[._-]/)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ');
}

// ─── Template → Field Preview ─────────────────────────────────────────────

function templateToFields(
  template: ConnectorTypeTemplate,
  connectorType: string,
): FieldPreviewItem[] {
  const fields: FieldPreviewItem[] = [];
  const addedCanonicalFields = new Set<string>();

  // 1. Fixed mappings (deterministic, confidence 1.0)
  const fixedMappings = getFixedMappings(connectorType);
  for (const fm of fixedMappings) {
    const canonical = getAvailableField(fm.canonicalField);
    if (addedCanonicalFields.has(fm.canonicalField)) continue;
    addedCanonicalFields.add(fm.canonicalField);

    fields.push({
      sourcePath: fm.sourcePath,
      displayName: humanize(fm.sourcePath),
      fieldType: (canonical?.type as FieldPreviewItem['fieldType']) ?? 'string',
      sampleValues: [],
      suggestedMapping: {
        canonicalField: fm.canonicalField,
        confidence: 1.0,
        displayLabel: canonical?.label ?? fm.canonicalField,
        reasoning: 'Fixed mapping from connector template',
      },
      suggestedForEmbedding: isEmbeddableField(fm.canonicalField),
      source: 'template',
    });
  }

  // 2. Pattern-based fields (from fieldPatterns)
  for (const [canonicalField, patterns] of Object.entries(template.fieldPatterns)) {
    if (addedCanonicalFields.has(canonicalField)) continue;
    addedCanonicalFields.add(canonicalField);

    const primaryPattern = patterns[0];
    const canonical = getAvailableField(canonicalField);

    // Determine type from enum patterns or canonical definition
    let fieldType: FieldPreviewItem['fieldType'] = 'string';
    if (
      canonical?.type === 'number' ||
      canonical?.type === 'float' ||
      canonical?.type === 'integer'
    )
      fieldType = 'number';
    else if (canonical?.type === 'date') fieldType = 'date';
    else if (canonical?.type === 'boolean') fieldType = 'boolean';

    // Get sample values from enum patterns if available
    const enumPattern = template.enumPatterns?.[canonicalField];
    const sampleValues = enumPattern ? enumPattern.values.slice(0, 5) : [];

    fields.push({
      sourcePath: primaryPattern,
      displayName: humanize(primaryPattern),
      fieldType,
      sampleValues,
      suggestedMapping: {
        canonicalField,
        confidence: 0.85,
        displayLabel: canonical?.label ?? humanize(canonicalField),
        reasoning: `Pattern match for ${connectorType} connector`,
      },
      suggestedForEmbedding: isEmbeddableField(canonicalField),
      source: 'template',
    });
  }

  return fields;
}

// ─── Merge Introspected + Template Fields ─────────────────────────────────

function mergeFields(
  introspected: IntrospectedField[],
  templateFields: FieldPreviewItem[],
  template: ConnectorTypeTemplate,
): FieldPreviewItem[] {
  if (introspected.length === 0) return templateFields;

  const merged: FieldPreviewItem[] = [];
  const templateByPath = new Map(templateFields.map((f) => [f.sourcePath.toLowerCase(), f]));
  const addedPaths = new Set<string>();

  // Introspected fields first (highest priority)
  for (const field of introspected) {
    const pathLower = field.path.toLowerCase();
    const existingTemplate = templateByPath.get(pathLower);
    addedPaths.add(pathLower);

    const fieldType = normalizeFieldType(field.type);
    const sampleValues = field.sampleValues?.map(String).slice(0, 5) ?? [];

    // Try to match against template patterns for mapping suggestion
    const canonicalMatch = matchFieldByPattern(field.path, template);
    const canonical = canonicalMatch ? getAvailableField(canonicalMatch) : null;

    merged.push({
      sourcePath: field.path,
      displayName: field.label || humanize(field.path),
      fieldType,
      sampleValues: sampleValues.length > 0 ? sampleValues : (existingTemplate?.sampleValues ?? []),
      suggestedMapping:
        existingTemplate?.suggestedMapping ??
        (canonicalMatch
          ? {
              canonicalField: canonicalMatch,
              confidence: 0.9,
              displayLabel: canonical?.label ?? humanize(canonicalMatch),
              reasoning: 'Pattern match from introspected field',
            }
          : null),
      suggestedForEmbedding:
        existingTemplate?.suggestedForEmbedding ??
        (canonicalMatch ? isEmbeddableField(canonicalMatch) : fieldType === 'string'),
      source: existingTemplate ? 'merged' : 'introspection',
    });
  }

  // Add remaining template fields not found in introspection
  for (const tf of templateFields) {
    if (!addedPaths.has(tf.sourcePath.toLowerCase())) {
      merged.push(tf);
    }
  }

  return merged;
}

function normalizeFieldType(type: string): FieldPreviewItem['fieldType'] {
  switch (type) {
    case 'number':
    case 'integer':
    case 'float':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'date':
    case 'datetime':
      return 'date';
    case 'array':
      return 'array';
    default:
      return 'string';
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/**
 * Generate field preview for a connector. Completely generic — no per-connector logic.
 *
 * @param connectorType - Connector type slug (e.g., 'jira', 'sharepoint')
 * @param introspectedFields - Fields from ISchemaIntrospection (empty if not available)
 * @param tenantId - For LLM mapping calls
 * @param indexId - For LLM mapping calls
 */
export async function generateFieldPreview(
  connectorType: string,
  introspectedFields: IntrospectedField[],
  tenantId: string,
  indexId: string,
): Promise<FieldPreviewResult> {
  // 1. Get template fields (always available)
  const template = getTemplateForConnector(connectorType);
  const templateFields = templateToFields(template, connectorType);

  logger.info('Template fields generated', {
    connectorType,
    templateCategory: template.category,
    templateFieldCount: templateFields.length,
    introspectedFieldCount: introspectedFields.length,
  });

  // 2. Merge introspected + template fields
  const mergedFields = mergeFields(introspectedFields, templateFields, template);

  // 3. For fields without a mapping suggestion, run the mapping pipeline
  const unmappedFields: IDiscoveredSchemaField[] = mergedFields
    .filter((f) => !f.suggestedMapping)
    .map((f) => ({
      path: f.sourcePath,
      name: f.displayName,
      type: f.fieldType,
      required: false,
      enumValues: f.sampleValues.length <= 10 ? f.sampleValues : undefined,
    }));

  if (unmappedFields.length > 0) {
    const pipelineResults = await runMappingPipeline(
      unmappedFields,
      connectorType,
      tenantId,
      indexId,
    );

    // Apply pipeline results to unmapped fields
    for (const field of mergedFields) {
      if (field.suggestedMapping) continue;
      const suggestion = pipelineResults.get(field.sourcePath);
      if (suggestion) {
        const canonical = getAvailableField(suggestion.canonicalField);
        field.suggestedMapping = {
          canonicalField: suggestion.canonicalField,
          confidence: suggestion.confidence,
          displayLabel:
            canonical?.label ??
            suggestion.suggestedLabel ??
            suggestion.suggestedAlias ??
            suggestion.canonicalField,
          reasoning: suggestion.reasoning ?? 'Pipeline suggestion',
        };
        field.suggestedForEmbedding = isEmbeddableField(suggestion.canonicalField);
      }
    }
  }

  // 4. Build available canonical fields dropdown
  const availableCanonicalFields = AVAILABLE_CANONICAL_FIELDS.map((f) => ({
    value: f.storageField,
    label: f.label,
    type: f.type,
    group: f.category,
  }));

  return {
    fields: mergedFields,
    availableCanonicalFields,
    connectorType,
    hasIntrospectionData: introspectedFields.length > 0,
    templateFieldCount: templateFields.length,
    introspectedFieldCount: introspectedFields.length,
  };
}
