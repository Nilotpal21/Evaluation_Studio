/**
 * Shared utilities for all layer disassemblers.
 *
 * These are pure functions with no DB access — designed for testability
 * and consistent behavior across all disassemblers.
 */

import type { StagedRecord, SupersededRecord } from '../staged-importer.js';
import type { LayerName } from '../../types.js';

type ExistingRecord = { _id: string; [key: string]: unknown };

const IMPORT_CONTEXT_FIELDS = new Set([
  '__v',
  '_v',
  'id',
  'tenantId',
  'projectId',
  'createdBy',
  'updatedBy',
  'modifiedBy',
  'ownerId',
  'ownerTeamId',
  'lastEditedBy',
  'createdAt',
  'updatedAt',
]);

const IMPORT_CONFIG_CONTEXT_FIELDS = new Set([...IMPORT_CONTEXT_FIELDS, '_id']);

export function stripImportedContextFields(data: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !IMPORT_CONTEXT_FIELDS.has(key)),
  );
}

export function stripImportedConfigContextFields(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(data).filter(([key]) => !IMPORT_CONFIG_CONTEXT_FIELDS.has(key)),
  );
}

/**
 * Parse a JSON file safely. Returns null and appends a warning on failure.
 */
export function safeParseJSON(
  filePath: string,
  content: string,
  warnings: string[],
): Record<string, unknown> | null {
  try {
    return JSON.parse(content);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    warnings.push(`Failed to parse ${filePath}: ${msg}`);
    return null;
  }
}

/**
 * Parse a JSON file that contains an array. Returns empty array on failure.
 */
export function safeParseJSONArray(
  filePath: string,
  content: string,
  warnings: string[],
): Array<Record<string, unknown>> {
  const parsed = safeParseJSON(filePath, content, warnings);
  if (!parsed) return [];
  if (!Array.isArray(parsed)) {
    warnings.push(`${filePath}: expected array, got ${typeof parsed}`);
    return [];
  }
  return parsed as Array<Record<string, unknown>>;
}

/**
 * Inject standard ownership fields into a document before staging.
 *
 * [R1 Fix: VULN-4] This function ALWAYS overwrites projectId, tenantId, and createdBy
 * from the server-side context. It never trusts these fields from imported data.
 * Any pre-existing tenantId/projectId in the imported data is explicitly removed
 * first via the spread, then overwritten with the server-side values. This ensures
 * every record has a valid tenantId, preventing the conditional logic flaw where
 * records without tenantId could bypass tenant isolation checks.
 */
export function injectOwnership(
  data: Record<string, unknown>,
  ctx: { projectId: string; tenantId: string; userId: string },
): Record<string, unknown> {
  // Strip any client-supplied ownership fields before injecting server-side values
  const cleanData = stripImportedContextFields(data);
  return {
    ...cleanData,
    projectId: ctx.projectId, // Always from server context
    tenantId: ctx.tenantId, // Always from server context — never omitted
    createdBy: ctx.userId, // Always from authenticated user
  };
}

/**
 * Build a StagedRecord from a parsed JSON document.
 */
export function buildRecord(
  layer: LayerName,
  collection: string,
  data: Record<string, unknown>,
): StagedRecord {
  return { layer, collection, data };
}

/**
 * Build SupersededRecord entries from existing active records for a collection.
 */
export function buildSuperseded(
  layer: LayerName,
  collection: string,
  existingRecords: Array<{ _id: string }> | undefined,
): SupersededRecord[] {
  if (!existingRecords) return [];
  return existingRecords.map((r) => ({
    layer,
    collection,
    recordId: r._id,
  }));
}

function keyFor(record: Record<string, unknown>, fields: readonly string[]): string | null {
  const values: string[] = [];
  for (const field of fields) {
    const value = record[field];
    if (value === null || value === undefined) {
      return null;
    }
    values.push(String(value));
  }
  return values.join('\u0000');
}

/**
 * Build SupersededRecord entries for imported records that match active records
 * by stable natural keys. This powers merge/upsert imports without hiding
 * unrelated active records in the same layer.
 */
export function buildMatchingSuperseded(
  layer: LayerName,
  collection: string,
  existingRecords: ExistingRecord[] | undefined,
  importedRecords: Array<{ data: Record<string, unknown> }>,
  matchFields: string | readonly string[],
): SupersededRecord[] {
  if (!existingRecords || importedRecords.length === 0) {
    return [];
  }

  const fields = typeof matchFields === 'string' ? [matchFields] : matchFields;
  const importedKeys = new Set(
    importedRecords
      .map((record) => keyFor(record.data, fields))
      .filter((key): key is string => key !== null),
  );

  if (importedKeys.size === 0) {
    return [];
  }

  return existingRecords
    .filter((record) => {
      const key = keyFor(record, fields);
      return key !== null && importedKeys.has(key);
    })
    .map((record) => ({
      layer,
      collection,
      recordId: record._id,
    }));
}

/**
 * Build SupersededRecord entries for active records whose field value is present
 * in the imported records. Useful when a child collection is owned by a parent
 * being merged, such as workflow versions keyed by workflowId.
 */
export function buildSupersededByImportedValues(
  layer: LayerName,
  collection: string,
  existingRecords: ExistingRecord[] | undefined,
  existingMatchField: string,
  importedValues: Iterable<unknown>,
): SupersededRecord[] {
  if (!existingRecords) {
    return [];
  }

  const values = new Set(
    [...importedValues]
      .filter((value) => value !== null && value !== undefined)
      .map((value) => String(value)),
  );

  if (values.size === 0) {
    return [];
  }

  return existingRecords
    .filter((record) => {
      const value = record[existingMatchField];
      return value !== null && value !== undefined && values.has(String(value));
    })
    .map((record) => ({
      layer,
      collection,
      recordId: record._id,
    }));
}

/**
 * Build SupersededRecord entries for singleton collections only when the import
 * includes a replacement singleton document.
 */
export function buildImportedSingletonSuperseded(
  layer: LayerName,
  collection: string,
  existingRecords: ExistingRecord[] | undefined,
  importedRecords: Array<{ data: Record<string, unknown> }>,
): SupersededRecord[] {
  return importedRecords.length > 0 ? buildSuperseded(layer, collection, existingRecords) : [];
}

/**
 * Strip REDACTED placeholder values from config objects.
 * These are injected by the assembler's stripSecrets() and must not be imported.
 */
export function stripRedactedValues(obj: Record<string, unknown>): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj)) {
    if (value === '***REDACTED***') continue;
    if (Array.isArray(value)) {
      result[key] = value
        .map((item) =>
          item && typeof item === 'object' && !Array.isArray(item)
            ? stripRedactedValues(item as Record<string, unknown>)
            : item === '***REDACTED***'
              ? undefined
              : item,
        )
        .filter((item) => item !== undefined);
    } else if (value && typeof value === 'object') {
      result[key] = stripRedactedValues(value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Extract a name from a file path using a known suffix pattern.
 *
 * Example: extractNameFromPath('guardrails/pii-filter.guardrail.json', '.guardrail.json')
 *          -> 'pii-filter'
 */
export function extractNameFromPath(filePath: string, suffix: string): string | null {
  const fileName = filePath.split('/').pop();
  if (!fileName || !fileName.endsWith(suffix)) return null;
  return fileName.slice(0, -suffix.length);
}
