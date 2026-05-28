import { createLogger, type Logger } from '@agent-platform/shared-observability';
import {
  getTemplateForConnector,
  matchFieldByPattern,
  type ConnectorTypeTemplate,
  type EnumPattern,
} from '../canonical/connector-type-templates.js';
import type { DiscoveredSchema, DiscoveredField } from './SchemaDiscoveryService.js';

const defaultLogger = createLogger('template-enum-enrichment');

/**
 * Apply connector-type template enum patterns to a discovered schema.
 *
 * For each field in the schema, checks if the template has a matching
 * enum pattern (by exact field name or pattern match). If found:
 * - If field has NO existing enumValues → set from template
 * - If field HAS existing enumValues → template values replace inferred (template priority)
 * - Store displayNames in field metadata if available
 * - Mark enumSource as 'template' for template-applied fields
 *
 * Returns a new DiscoveredSchema (does not mutate input).
 */
export function applyTemplateEnumPatterns(
  schema: DiscoveredSchema,
  connectorType: string,
  logger?: Logger,
): DiscoveredSchema {
  const log = logger ?? defaultLogger;
  const template = getTemplateForConnector(connectorType);

  // TODO(Story 1.8): emit TraceEvent 'search-ai.template-enum.start' when TraceStore is injected
  log.info('Template enum enrichment started', {
    tenantId: schema.tenantId,
    connectorId: schema.connectorId,
    connectorType,
    templateCategory: template.category,
  });

  if (!template.enumPatterns || Object.keys(template.enumPatterns).length === 0) {
    log.info('Template has no enum patterns, skipping enrichment', {
      tenantId: schema.tenantId,
      connectorId: schema.connectorId,
      templateCategory: template.category,
    });
    // Still tag inferred fields for consistency
    const taggedFields = schema.fields.map((field) => {
      if (field.metadata.enumValues && field.metadata.enumSource === undefined) {
        return { ...field, metadata: { ...field.metadata, enumSource: 'inferred' as const } };
      }
      return field;
    });
    const hasChanges = taggedFields.some((f, i) => f !== schema.fields[i]);
    return hasChanges ? { ...schema, fields: taggedFields } : schema;
  }

  let appliedCount = 0;
  const enrichedFields: DiscoveredField[] = schema.fields.map((field) => {
    const enumPattern = resolveEnumPattern(field.name, template);

    if (!enumPattern) {
      // No template match — preserve existing metadata, mark inferred if has enums
      if (field.metadata.enumValues && field.metadata.enumSource === undefined) {
        return {
          ...field,
          metadata: { ...field.metadata, enumSource: 'inferred' as const },
        };
      }
      return field;
    }

    appliedCount++;

    return {
      ...field,
      metadata: {
        ...field.metadata,
        enumValues: enumPattern.values,
        enumSource: 'template' as const,
        enumDisplayNames: enumPattern.displayNames,
      },
    };
  });

  // TODO(Story 1.8): emit TraceEvent 'search-ai.template-enum.complete' when TraceStore is injected
  log.info('Template enum enrichment complete', {
    tenantId: schema.tenantId,
    connectorId: schema.connectorId,
    templateCategory: template.category,
    appliedCount,
    fieldCount: schema.fields.length,
  });

  return {
    ...schema,
    fields: enrichedFields,
  };
}

/**
 * Resolve an enum pattern for a field name.
 *
 * Strategy:
 * 1. Exact match: field name matches an enum pattern key (case-insensitive)
 * 2. Pattern match: use full template fieldPatterns to resolve canonical name → enum pattern
 */
function resolveEnumPattern(
  fieldName: string,
  template: ConnectorTypeTemplate,
): EnumPattern | null {
  const enumPatterns = template.enumPatterns;
  if (!enumPatterns) return null;

  const fieldLower = fieldName.toLowerCase();

  // 1. Exact match (case-insensitive)
  for (const [patternKey, pattern] of Object.entries(enumPatterns)) {
    if (fieldLower === patternKey.toLowerCase()) {
      return pattern;
    }
  }

  // 2. Pattern match via full template fieldPatterns
  // e.g., source field "state" → canonical "status" → status enum pattern
  const canonicalName = matchFieldByPattern(fieldName, template);
  if (canonicalName && enumPatterns[canonicalName]) {
    return enumPatterns[canonicalName];
  }

  return null;
}
