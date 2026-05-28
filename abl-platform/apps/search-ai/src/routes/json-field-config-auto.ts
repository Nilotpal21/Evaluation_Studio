/**
 * Auto-extend JSON field configuration on document upload.
 *
 * When a user uploads a JSON file and the KB either has no field config
 * or the file contains new fields not yet configured, this module
 * auto-detects, maps, and persists the fields — so canonical metadata
 * is always populated without manual intervention.
 *
 * Production-grade: handles bulk uploads (no warnings, auto-extends silently),
 * idempotent (same fields = no-op), and non-blocking (failure is non-fatal).
 *
 * This delegates to `saveFieldConfigInternal` which creates:
 * - jsonFieldConfig on the SearchIndex
 * - CanonicalSchema + FieldMappings (in content DB)
 * - DomainVocabulary (1 entry per mapped field)
 */

import { createLogger } from '@abl/compiler/platform';
import { runMappingPipeline } from '../services/field-mapping-pipeline.service.js';
import { saveFieldConfigInternal } from './json-field-config.js';
import type { TenantContextData } from '@agent-platform/shared-auth';

const logger = createLogger('json-field-config-auto');

interface FieldEntry {
  fieldPath: string;
  fieldType: string;
  selected: boolean;
  sampleValues: string[];
  maxLength: number;
  canonicalMapping?: string;
}

interface JsonFieldConfig {
  version: number;
  fields: FieldEntry[];
  autoSuggestApplied: boolean;
  updatedAt: Date;
}

/**
 * Detect field type from sample values across records.
 */
function detectFieldType(values: any[]): string {
  const nonNull = values.filter((v) => v !== null && v !== undefined);
  if (nonNull.length === 0) return 'string';

  if (nonNull.every((v) => typeof v === 'number')) return 'number';
  if (nonNull.every((v) => typeof v === 'boolean')) return 'boolean';
  if (nonNull.every((v) => Array.isArray(v))) return 'array';

  // Check for date strings
  const datePattern = /^\d{4}-\d{2}-\d{2}/;
  if (nonNull.every((v) => typeof v === 'string' && datePattern.test(v))) return 'date';

  return 'string';
}

/**
 * Extract fields from sample records, detecting types and collecting sample values.
 */
function extractFieldsFromRecords(records: Record<string, any>[]): FieldEntry[] {
  const fieldMap = new Map<string, { values: any[]; type: string }>();

  const collectFields = (obj: any, prefix = '') => {
    for (const [key, val] of Object.entries(obj)) {
      const path = prefix ? `${prefix}.${key}` : key;
      if (val && typeof val === 'object' && !Array.isArray(val)) {
        collectFields(val, path);
      } else {
        if (!fieldMap.has(path)) {
          fieldMap.set(path, { values: [], type: 'string' });
        }
        fieldMap.get(path)!.values.push(val);
      }
    }
  };

  for (const rec of records) {
    collectFields(rec);
  }

  const fields: FieldEntry[] = [];
  for (const [path, info] of fieldMap) {
    const fieldType = detectFieldType(info.values);
    const sampleValues = info.values
      .filter((v) => v !== null && v !== undefined)
      .map((v) => (Array.isArray(v) ? v.map(String).join(', ') : String(v)))
      .slice(0, 5);
    const maxLength =
      fieldType === 'string' ? sampleValues.reduce((max, v) => Math.max(max, v.length), 0) : 0;

    fields.push({
      fieldPath: path,
      fieldType,
      selected: true,
      sampleValues,
      maxLength,
    });
  }

  return fields;
}

/**
 * Auto-configure fields from scratch when a JSON file is uploaded
 * and the KB has no jsonFieldConfig yet.
 *
 * Equivalent to: schema-preview + autoSave=true, but triggered at upload time.
 * Creates the full pipeline: jsonFieldConfig → CanonicalSchema → FieldMappings → DomainVocabulary
 */
export async function saveFieldConfigFromUpload(
  indexId: string,
  tenantId: string,
  sampleRecords: Record<string, any>[],
  tenantContext: TenantContextData,
): Promise<JsonFieldConfig | null> {
  // Extract fields from sample records
  const fields = extractFieldsFromRecords(sampleRecords);
  if (fields.length === 0) return null;

  // Run mapping pipeline to get canonical mappings
  // runMappingPipeline expects IDiscoveredSchemaField[] with name, type, path
  const discoveredFields = fields.map((f) => ({
    name: f.fieldPath.split('.').pop() || f.fieldPath,
    type: f.fieldType,
    path: f.fieldPath,
    enumValues: f.sampleValues,
  }));

  let mappingByField: Map<string, any>;
  try {
    mappingByField = await runMappingPipeline(discoveredFields, 'file_upload', tenantId, indexId);
  } catch (err) {
    logger.warn('Mapping pipeline failed during auto-config — using field paths as-is', {
      error: err instanceof Error ? err.message : String(err),
    });
    mappingByField = new Map();
  }

  // Build field entries with canonical mappings
  const configFields: FieldEntry[] = fields.map((f) => {
    const mapping = mappingByField.get(f.fieldPath);
    return {
      ...f,
      canonicalMapping: mapping?.canonicalField || undefined,
    };
  });

  // Delegate to saveFieldConfigInternal which:
  // 1. Saves jsonFieldConfig on the SearchIndex
  // 2. Creates/updates CanonicalSchema
  // 3. Creates FieldMappings
  // 4. Generates DomainVocabulary (1 entry per mapped field)
  try {
    const result = await saveFieldConfigInternal(
      indexId,
      tenantId,
      configFields,
      mappingByField,
      tenantContext,
    );

    logger.info('Auto-configured full pipeline from uploaded file', {
      indexId,
      fieldCount: result.fieldCount,
      mappingCount: result.mappingCount,
      vocabTriggered: result.vocabTriggered,
    });
  } catch (err) {
    logger.warn('saveFieldConfigInternal failed during auto-config — partial config saved', {
      error: err instanceof Error ? err.message : String(err),
      indexId,
    });
  }

  // Return the config we built (it's been saved by saveFieldConfigInternal)
  const config: JsonFieldConfig = {
    version: 1,
    fields: configFields,
    autoSuggestApplied: true,
    updatedAt: new Date(),
  };
  return config;
}

/**
 * Extend existing field config when new fields are detected in an uploaded file.
 *
 * Only adds new fields — never modifies or removes existing mappings.
 * Idempotent: calling with same fields is a no-op.
 * Creates CanonicalSchema + FieldMappings + DomainVocabulary for the extended set.
 */
export async function extendFieldConfig(
  indexId: string,
  tenantId: string,
  newFieldPaths: string[],
  sampleRecords: Record<string, any>[],
  existingConfig: JsonFieldConfig,
  tenantContext: TenantContextData,
): Promise<JsonFieldConfig | null> {
  // Extract field info for just the new fields
  const allFields = extractFieldsFromRecords(sampleRecords);
  const newFields = allFields.filter((f) => newFieldPaths.includes(f.fieldPath));
  if (newFields.length === 0) return existingConfig;

  // Run mapping pipeline for new fields only
  const discoveredFields = newFields.map((f) => ({
    name: f.fieldPath.split('.').pop() || f.fieldPath,
    type: f.fieldType,
    path: f.fieldPath,
    enumValues: f.sampleValues,
  }));

  let mappingByField: Map<string, any>;
  try {
    mappingByField = await runMappingPipeline(discoveredFields, 'file_upload', tenantId, indexId);
  } catch (err) {
    logger.warn('Mapping pipeline failed during field extension — adding fields without mappings', {
      error: err instanceof Error ? err.message : String(err),
    });
    mappingByField = new Map();
  }

  // Build new field entries
  const newConfigFields: FieldEntry[] = newFields.map((f) => {
    const mapping = mappingByField.get(f.fieldPath);
    return {
      ...f,
      canonicalMapping: mapping?.canonicalField || undefined,
    };
  });

  // Merge: existing fields + new fields
  const mergedFields = [...existingConfig.fields, ...newConfigFields];

  // Delegate to saveFieldConfigInternal for the FULL merged set.
  // This re-creates mappings and vocab for all fields (idempotent — existing mappings
  // are deleted and re-created with the same values, plus new fields added).
  // Also rebuild the mappingByField for existing fields from their canonicalMapping.
  const fullMappingByField = new Map(mappingByField);
  for (const f of existingConfig.fields) {
    if (f.canonicalMapping && !fullMappingByField.has(f.fieldPath)) {
      fullMappingByField.set(f.fieldPath, {
        canonicalField: f.canonicalMapping,
        sourcePath: f.fieldPath,
        transform: { type: 'direct' },
        confidence: 0.9,
        reasoning: 'Existing mapping preserved during field extension',
        suggestedAlias: f.fieldPath,
        suggestedLabel: f.fieldPath,
      });
    }
  }

  try {
    const result = await saveFieldConfigInternal(
      indexId,
      tenantId,
      mergedFields,
      fullMappingByField,
      tenantContext,
    );

    logger.info('Extended full pipeline with new fields from upload', {
      indexId,
      newFieldCount: newConfigFields.length,
      totalFieldCount: mergedFields.length,
      mappingCount: result.mappingCount,
      vocabTriggered: result.vocabTriggered,
    });
  } catch (err) {
    logger.warn('saveFieldConfigInternal failed during field extension', {
      error: err instanceof Error ? err.message : String(err),
      indexId,
    });
  }

  // Return the merged config
  const updatedConfig: JsonFieldConfig = {
    version: existingConfig.version + 1,
    fields: mergedFields,
    autoSuggestApplied: true,
    updatedAt: new Date(),
  };
  return updatedConfig;
}
