/**
 * JSON Field Configuration Routes
 *
 * POST /:indexId/json-schema-preview  — Parse a JSON file and return extracted schema
 * GET  /:indexId/json-field-config    — Get current field config for this index
 * PUT  /:indexId/json-field-config    — Save user's field selections
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import multer from 'multer';
import path from 'path';
import fs from 'fs';
import type { RedisClient } from '@agent-platform/redis';
import { resolveRedisOptionsFromEnv, createRedisConnection } from '@agent-platform/redis';
import { createLogger } from '@abl/compiler/platform';
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';
import type {
  ISearchIndex,
  ICanonicalSchema,
  IFieldMapping,
  IDomainVocabulary,
} from '@agent-platform/database';
import type { IDiscoveredSchemaField } from '@agent-platform/database/models';
import {
  AVAILABLE_CANONICAL_FIELDS,
  getAvailableField,
  toCanonicalField,
} from '@agent-platform/search-ai-internal/canonical';
import { type MappingSuggestion } from '../services/mapping-suggestion/index.js';
import { runMappingPipeline } from '../services/field-mapping-pipeline.service.js';
import type { FieldMapping } from '../services/json-schema-mapping/json-schema-llm-mapper.js';

const logger = createLogger('json-field-config');
const router: RouterType = Router();
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');

// ─── Mapping Cache (preview → save, avoids duplicate LLM call) ────────────
// Key: `${tenantId}:${indexId}` → cached pipeline results
// TTL: 10 minutes — user previews, adjusts, then saves within that window
const MAPPING_CACHE_TTL_MS = 10 * 60 * 1000;
const MAPPING_CACHE_MAX_SIZE = 100;
const mappingCache = new Map<
  string,
  { mappings: Map<string, MappingSuggestion>; expiresAt: number }
>();

function getCachedMappings(
  tenantId: string,
  indexId: string,
): Map<string, MappingSuggestion> | null {
  const key = `${tenantId}:${indexId}`;
  const cached = mappingCache.get(key);
  if (!cached) return null;
  if (Date.now() > cached.expiresAt) {
    mappingCache.delete(key);
    return null;
  }
  return cached.mappings;
}

function setCachedMappings(
  tenantId: string,
  indexId: string,
  mappings: Map<string, MappingSuggestion>,
): void {
  const key = `${tenantId}:${indexId}`;
  // Evict oldest if at capacity
  if (mappingCache.size >= MAPPING_CACHE_MAX_SIZE) {
    const firstKey = mappingCache.keys().next().value;
    if (firstKey) mappingCache.delete(firstKey);
  }
  mappingCache.set(key, { mappings, expiresAt: Date.now() + MAPPING_CACHE_TTL_MS });
}

// ─── Helpers ──────────────────────────────────────────────────────────────

// runMappingPipeline is imported from ../services/field-mapping-pipeline.service.js
// (shared with connector field preview — same 3-tier pipeline: Rules → LLM → Fallback)

// ─── Multer for schema preview (temp file, not permanent) ───────────────

const previewUpload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => {
      const tmpDir = path.join(process.cwd(), 'uploads', 'temp');
      if (!fs.existsSync(tmpDir)) {
        fs.mkdirSync(tmpDir, { recursive: true });
      }
      cb(null, tmpDir);
    },
    filename: (_req, file, cb) => {
      cb(null, `preview-${Date.now()}-${file.originalname}`);
    },
  }),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50MB for preview
  fileFilter: (_req, file, cb) => {
    const ext = file.originalname.toLowerCase().split('.').pop();
    if (ext === 'json') {
      cb(null, true);
    } else {
      cb(new Error('Only JSON files are supported for schema preview'));
    }
  },
});

// ─── Types ──────────────────────────────────────────────────────────────

interface FieldPreview {
  fieldPath: string;
  fieldType: 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object';
  sampleValues: string[];
  /** Max character length seen across sampled records (un-truncated) */
  maxLength: number;
  suggested: boolean;
  suggestReason?: string;
  /** Auto-suggested canonical field mapping from rule-based engine */
  suggestedMapping?: {
    canonicalField: string;
    confidence: number;
    displayLabel: string;
    reasoning: string;
  } | null;
}

// ─── Auto-suggest logic ─────────────────────────────────────────────────

/** Fields to skip (internal/system) */
const SKIP_PATTERNS = [
  /^_id$/i,
  /^id$/i,
  /^uuid$/i,
  /^guid$/i,
  /url$/i,
  /^href$/i,
  /^uri$/i,
  /^sku$/i,
  /^barcode$/i,
  /^slug$/i,
  /created_?at$/i,
  /updated_?at$/i,
  /deleted_?at$/i,
  /timestamp$/i,
  /^__/,
  /^\$/,
];

function shouldSkipField(fieldPath: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(fieldPath));
}

function suggestField(
  fieldPath: string,
  fieldType: string,
  sampleValues: string[],
): { suggested: boolean; reason?: string } {
  if (shouldSkipField(fieldPath)) {
    return { suggested: false, reason: 'Internal/system field' };
  }

  // Numbers are almost always useful for filtering/sorting
  if (fieldType === 'number') {
    return { suggested: true, reason: 'Numeric field — good for filtering and sorting' };
  }

  // Booleans are good for filtering
  if (fieldType === 'boolean') {
    return { suggested: true, reason: 'Boolean field — good for filtering' };
  }

  // Short strings with varied values → likely a category/attribute
  if (fieldType === 'string') {
    const avgLen =
      sampleValues.length > 0
        ? sampleValues.reduce((sum, v) => sum + v.length, 0) / sampleValues.length
        : 0;

    // Long text (descriptions, etc.) — skip for filtering but note it
    if (avgLen > 200) {
      return { suggested: false, reason: 'Long text — better for full-text search' };
    }

    // Short strings → likely filterable attributes
    if (avgLen > 0 && avgLen <= 100) {
      return { suggested: true, reason: 'Short text — likely a category or attribute' };
    }
  }

  // Arrays of strings → tags, categories
  if (fieldType === 'array') {
    return { suggested: true, reason: 'Array field — likely tags or categories' };
  }

  return { suggested: false };
}

// ─── JSON Schema → FieldPreview Extraction ──────────────────────────────
// When a user provides a JSON Schema (draft-04/06/07/2020-12) we read types
// directly from the schema definition — no value inference needed.
// Current behaviour (value-based) is untouched; this is an additive path.

interface JsonSchemaProperty {
  type?: string | string[];
  /** MongoDB $jsonSchema uses bsonType instead of type */
  bsonType?: string | string[];
  format?: string;
  enum?: unknown[];
  description?: string;
  maxLength?: number;
  items?: JsonSchemaProperty;
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
}

interface JsonSchemaInput {
  type?: string;
  /** MongoDB $jsonSchema uses bsonType instead of type */
  bsonType?: string | string[];
  properties?: Record<string, JsonSchemaProperty>;
  required?: string[];
  items?: JsonSchemaProperty;
  definitions?: Record<string, JsonSchemaProperty>;
  $defs?: Record<string, JsonSchemaProperty>;
}

/**
 * Map a BSON type string to our normalized type.
 * MongoDB $jsonSchema uses bsonType with values like "int", "double",
 * "objectId", "date", "bool", "long", "decimal", etc.
 */
function normalizeBsonType(
  bsonType: string,
): 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' {
  switch (bsonType) {
    case 'int':
    case 'long':
    case 'double':
    case 'decimal':
    case 'number':
      return 'number';
    case 'bool':
    case 'boolean':
      return 'boolean';
    case 'date':
    case 'timestamp':
      return 'date';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    case 'objectId':
    case 'string':
    case 'binData':
    case 'regex':
      return 'string';
    default:
      return 'string';
  }
}

function resolveSchemaType(
  prop: JsonSchemaProperty,
): 'string' | 'number' | 'boolean' | 'date' | 'array' | 'object' {
  // Support MongoDB $jsonSchema bsonType (takes precedence if present)
  const rawBsonType = prop.bsonType;
  if (rawBsonType) {
    if (Array.isArray(rawBsonType)) {
      // Pick the first non-null bsonType
      const primary = rawBsonType.find((t) => t !== 'null') || 'string';
      return normalizeBsonType(primary);
    }
    return normalizeBsonType(rawBsonType);
  }

  // Standard JSON Schema type handling
  let rawType = prop.type;
  if (Array.isArray(rawType)) {
    // Pick the first non-null type
    rawType = rawType.find((t) => t !== 'null') || 'string';
  }

  switch (rawType) {
    case 'integer':
    case 'number':
      return 'number';
    case 'boolean':
      return 'boolean';
    case 'array':
      return 'array';
    case 'object':
      return 'object';
    case 'string':
      // Check format for date detection
      if (prop.format === 'date' || prop.format === 'date-time' || prop.format === 'time') {
        return 'date';
      }
      return 'string';
    default:
      return 'string';
  }
}

/**
 * Extract FieldPreview[] from a JSON Schema definition.
 * Recursively walks `properties` up to maxDepth, using schema-declared types
 * instead of value inference.
 */
function extractFieldsFromSchema(schema: JsonSchemaInput, maxDepth = 2): FieldPreview[] {
  const fields: FieldPreview[] = [];
  const requiredSet = new Set(schema.required || []);

  function walkProperties(
    properties: Record<string, JsonSchemaProperty>,
    parentRequired: Set<string>,
    prefix: string,
    depth: number,
  ): void {
    if (depth > maxDepth) return;

    for (const [key, prop] of Object.entries(properties)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      const fieldType = resolveSchemaType(prop);

      // For objects with sub-properties, recurse
      if (fieldType === 'object' && prop.properties) {
        const childRequired = new Set(prop.required || []);
        walkProperties(prop.properties, childRequired, fullPath, depth + 1);
        continue; // Skip the object node itself (same as extractSchema)
      }

      // For arrays of objects with sub-properties, recurse into items
      if (fieldType === 'array' && prop.items?.properties) {
        const itemType = resolveSchemaType(prop.items);
        if (itemType === 'object') {
          const childRequired = new Set(prop.items.required || []);
          walkProperties(prop.items.properties, childRequired, fullPath, depth + 1);
          continue; // Skip the array node itself — show its children
        }
      }

      // Build sampleValues from enum if available
      const sampleValues: string[] = [];
      if (prop.enum && Array.isArray(prop.enum)) {
        for (const v of prop.enum.slice(0, 5)) {
          if (v !== null && v !== undefined) {
            sampleValues.push(String(v));
          }
        }
      }

      // Determine maxLength from schema
      const maxLength = prop.maxLength ?? 0;

      // Use the suggest logic (same as value-based path)
      const suggestion = suggestField(fullPath, fieldType, sampleValues);

      // Boost required fields that weren't already suggested
      const isRequired = parentRequired.has(key);
      const suggested = suggestion.suggested || isRequired;
      const suggestReason =
        isRequired && !suggestion.suggested ? 'Required field in schema' : suggestion.reason;

      fields.push({
        fieldPath: fullPath,
        fieldType,
        sampleValues,
        maxLength,
        suggested,
        suggestReason,
      });
    }
  }

  if (schema.properties) {
    walkProperties(schema.properties, requiredSet, '', 0);
  }

  // Sort: suggested first, then alphabetically (same as extractSchema)
  fields.sort((a, b) => {
    if (a.suggested !== b.suggested) return a.suggested ? -1 : 1;
    return a.fieldPath.localeCompare(b.fieldPath);
  });

  return fields;
}

// ─── Schema Extraction (value-based — original behaviour) ───────────────

function extractSchema(records: Record<string, unknown>[], maxDepth = 2): FieldPreview[] {
  const fieldMap = new Map<
    string,
    {
      types: Set<string>;
      values: Set<string>;
      maxLen: number;
    }
  >();

  function processValue(key: string, value: unknown, depth: number, prefix: string): void {
    if (depth > maxDepth) return;
    const fullPath = prefix ? `${prefix}.${key}` : key;

    if (!fieldMap.has(fullPath)) {
      fieldMap.set(fullPath, { types: new Set(), values: new Set(), maxLen: 0 });
    }
    const entry = fieldMap.get(fullPath)!;

    if (value === null || value === undefined) {
      entry.types.add('null');
    } else if (Array.isArray(value)) {
      entry.types.add('array');
      if (entry.values.size < 5 && value.length > 0) {
        for (const v of value.slice(0, 3)) {
          if (typeof v !== 'object') {
            entry.values.add(String(v));
          }
        }
      }
    } else if (typeof value === 'object') {
      entry.types.add('object');
      // Recurse into nested objects
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        processValue(k, v, depth + 1, fullPath);
      }
    } else if (typeof value === 'number') {
      entry.types.add('number');
      if (entry.values.size < 5) {
        entry.values.add(String(value));
      }
    } else if (typeof value === 'boolean') {
      entry.types.add('boolean');
      entry.values.add(String(value));
    } else if (typeof value === 'string') {
      // Check if date
      if (/^\d{4}-\d{2}-\d{2}/.test(value) && !isNaN(Date.parse(value))) {
        entry.types.add('date');
      } else {
        entry.types.add('string');
      }
      if (entry.values.size < 5) {
        const truncated = value.length > 80 ? value.slice(0, 80) + '...' : value;
        entry.values.add(truncated);
      }
      entry.maxLen = Math.max(entry.maxLen, value.length);
    }
  }

  // Process sample records
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      processValue(key, value, 0, '');
    }
  }

  // Convert to FieldPreview array
  const fields: FieldPreview[] = [];
  for (const [fieldPath, entry] of fieldMap) {
    // Skip pure object parents (they just contain children)
    if (entry.types.size === 1 && entry.types.has('object')) continue;
    // Skip null-only fields
    if (entry.types.size === 1 && entry.types.has('null')) continue;

    const primaryType = entry.types.has('number')
      ? 'number'
      : entry.types.has('boolean')
        ? 'boolean'
        : entry.types.has('date')
          ? 'date'
          : entry.types.has('array')
            ? 'array'
            : 'string';

    const sampleValues = Array.from(entry.values).slice(0, 5);
    const suggestion = suggestField(fieldPath, primaryType, sampleValues);

    fields.push({
      fieldPath,
      fieldType: primaryType,
      sampleValues,
      maxLength: entry.maxLen,
      suggested: suggestion.suggested,
      suggestReason: suggestion.reason,
    });
  }

  // Sort: suggested first, then alphabetically
  fields.sort((a, b) => {
    if (a.suggested !== b.suggested) return a.suggested ? -1 : 1;
    return a.fieldPath.localeCompare(b.fieldPath);
  });

  return fields;
}

// ─── Routes ─────────────────────────────────────────────────────────────

/**
 * POST /:indexId/json-schema-preview
 *
 * Upload a JSON file and get back the extracted schema with auto-suggestions.
 * Does NOT process/embed the file — just previews the schema for field selection.
 */
router.post(
  '/:indexId/json-schema-preview',
  previewUpload.single('file') as any,
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const { indexId } = req.params;
      const tenantId = req.tenantContext.tenantId;

      // Verify index exists and belongs to tenant
      const index = await SearchIndex.findOne(
        applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      ).lean();
      if (!index) {
        res.status(404).json({ error: 'Index not found' });
        return;
      }

      // Accept: file upload, sampleData in body, OR schema in body
      // Priority: schema (if provided) determines types; sampleData/file enriches with values
      let userSchema: JsonSchemaInput | undefined = req.body?.schema;
      let data: unknown;
      let records: Record<string, unknown>[] = [];

      if (req.file) {
        const fsP = await import('fs/promises');
        const fileBuffer = await fsP.readFile(req.file.path);
        const jsonText = fileBuffer.toString('utf-8');
        try {
          data = JSON.parse(jsonText);
        } catch (parseErr) {
          res.status(400).json({ error: 'Invalid JSON file' });
          return;
        }
        await fsP.unlink(req.file.path).catch((unlinkErr: unknown) => {
          logger.warn('Failed to clean preview temp file', { error: String(unlinkErr) });
        });

        // Auto-detect JSON Schema files:
        // 1. Standard JSON Schema: {"type": "object", "properties": {...}}
        // 2. MongoDB $jsonSchema wrapper: {"$jsonSchema": {"bsonType": "object", "properties": {...}}}
        // 3. MongoDB bsonType without wrapper: {"bsonType": "object", "properties": {...}}
        if (!userSchema && typeof data === 'object' && data !== null && !Array.isArray(data)) {
          let schemaCandidate: any = data;

          // Unwrap MongoDB $jsonSchema wrapper if present
          if ('$jsonSchema' in data && typeof (data as any).$jsonSchema === 'object') {
            schemaCandidate = (data as any).$jsonSchema;
            logger.info('Detected MongoDB $jsonSchema wrapper — unwrapping', { indexId });
          }

          // Detect schema: standard JSON Schema (type: "object") OR MongoDB (bsonType: "object")
          const hasProperties =
            'properties' in schemaCandidate && typeof schemaCandidate.properties === 'object';
          const isStandardSchema = schemaCandidate.type === 'object';
          const isMongoSchema =
            schemaCandidate.bsonType === 'object' ||
            (Array.isArray(schemaCandidate.bsonType) &&
              schemaCandidate.bsonType.includes('object'));

          if (hasProperties && (isStandardSchema || isMongoSchema)) {
            userSchema = schemaCandidate as JsonSchemaInput;
            data = null;
            logger.info('Uploaded file detected as JSON Schema — using schema-based extraction', {
              indexId,
              propertyCount: Object.keys((userSchema as JsonSchemaInput).properties!).length,
              format: isMongoSchema ? 'mongodb-$jsonSchema' : 'standard-json-schema',
            });
          }
        }
      } else if (req.body?.sampleData) {
        data = req.body.sampleData;
      } else if (userSchema && userSchema.properties) {
        // Schema-only mode — no data needed
        data = null;
      } else {
        res.status(400).json({
          error: 'Provide a file upload, sampleData, or schema in request body',
        });
        return;
      }

      // Extract records from data (if data is provided)
      if (data !== null && data !== undefined) {
        if (Array.isArray(data)) {
          records = data;
        } else if (
          typeof data === 'object' &&
          data !== null &&
          'data' in data &&
          Array.isArray((data as any).data)
        ) {
          records = (data as any).data;
        } else if (
          typeof data === 'object' &&
          data !== null &&
          'records' in data &&
          Array.isArray((data as any).records)
        ) {
          records = (data as any).records;
        } else if (typeof data === 'object' && data !== null) {
          records = [data as Record<string, unknown>];
        } else {
          res.status(400).json({ error: 'JSON must be an array or object' });
          return;
        }
      }

      // Require at least schema OR records
      if (records.length === 0 && !userSchema?.properties) {
        res.status(400).json({ error: 'JSON file contains no records' });
        return;
      }

      // ── Field extraction: schema-based vs value-based ──────────────────
      // If schema is provided → use schema for types (authoritative).
      //   If sampleData also present → enrich schema fields with sample values.
      // If no schema → use value inference (current behaviour, unchanged).
      let fields: FieldPreview[];
      let sampleRecords: Record<string, unknown>[];

      if (userSchema && userSchema.properties) {
        // Schema-based extraction
        fields = extractFieldsFromSchema(userSchema);

        // Enrich with sample values from data if available
        if (records.length > 0) {
          sampleRecords = records.slice(0, 10);
          const valueFields = extractSchema(sampleRecords);
          const valueMap = new Map(valueFields.map((f) => [f.fieldPath, f]));

          fields = fields.map((schemaField) => {
            const valueField = valueMap.get(schemaField.fieldPath);
            if (valueField) {
              return {
                ...schemaField,
                // Use sample values from actual data
                sampleValues:
                  schemaField.sampleValues.length > 0
                    ? schemaField.sampleValues // enum values take priority
                    : valueField.sampleValues,
                // Use real maxLength from data if schema didn't specify
                maxLength: schemaField.maxLength || valueField.maxLength,
              };
            }
            return schemaField;
          });
        } else {
          sampleRecords = [];
        }

        logger.info('Using JSON Schema for type extraction', {
          indexId,
          schemaFieldCount: fields.length,
          hasRecords: records.length > 0,
        });
      } else {
        // Value-based extraction (original behaviour — unchanged)
        sampleRecords = records.slice(0, 10);
        fields = extractSchema(sampleRecords);
      }

      // Check if index already has field config
      const existingConfig = (index as any).jsonFieldConfig;

      // Temp file cleanup already handled above (line ~341) inside req.file block

      // ── Smart field detection: skip LLM pipeline if all fields already configured ──
      // Compare new fields against existing config. If every field in the new file
      // already has a saved selection, return `allFieldsKnown: true` so the frontend
      // can auto-proceed without showing the dialog.
      let allFieldsKnown = false;
      let newFieldPaths: string[] = [];
      if (
        existingConfig &&
        Array.isArray(existingConfig.fields) &&
        existingConfig.fields.length > 0
      ) {
        const existingPaths = new Set(
          existingConfig.fields.map((f: { fieldPath: string }) => f.fieldPath),
        );
        newFieldPaths = fields.map((f) => f.fieldPath).filter((fp) => !existingPaths.has(fp));
        allFieldsKnown = newFieldPaths.length === 0;

        if (allFieldsKnown) {
          logger.info('All fields match existing config — skipping LLM mapping pipeline', {
            indexId,
            existingFieldCount: existingConfig.fields.length,
            newFileFieldCount: fields.length,
          });
        } else {
          logger.info(
            'New fields detected in upload — running mapping pipeline for new fields only',
            {
              indexId,
              newFields: newFieldPaths,
              existingFieldCount: existingConfig.fields.length,
            },
          );
        }
      }

      // ── Run mapping pipeline: skip if allFieldsKnown, otherwise run smart ──
      let mappingByField: Map<string, MappingSuggestion>;
      if (allFieldsKnown) {
        // No LLM call needed — all fields already configured
        mappingByField = new Map();
      } else {
        mappingByField = new Map();

        // Step A: Restore saved mappings for existing fields that have them
        const fieldsNeedingPipeline: FieldPreview[] = [];
        if (
          existingConfig &&
          Array.isArray(existingConfig.fields) &&
          existingConfig.fields.length > 0
        ) {
          const existingFieldMap = new Map<string, any>(
            existingConfig.fields.map((ef: any) => [ef.fieldPath, ef]),
          );
          for (const f of fields) {
            const ef = existingFieldMap.get(f.fieldPath);
            if (ef) {
              const savedMapping = ef.canonicalMapping || ef.mappingOverride;
              if (savedMapping) {
                // Existing field with saved mapping — restore it directly
                const canonicalDef = AVAILABLE_CANONICAL_FIELDS.find(
                  (c) => c.storageField === savedMapping,
                );
                mappingByField.set(f.fieldPath, {
                  canonicalField: savedMapping,
                  sourcePath: f.fieldPath,
                  transform: { type: 'direct' },
                  confidence: ef.mappingOverride ? 1.0 : 0.9,
                  reasoning: 'Previously saved configuration',
                  suggestedAlias: canonicalDef?.label || savedMapping,
                  suggestedLabel: canonicalDef?.label || savedMapping,
                });
              } else {
                // Existing field WITHOUT saved mapping (legacy data) — needs pipeline
                fieldsNeedingPipeline.push(f);
              }
            } else {
              // New field — needs pipeline
              fieldsNeedingPipeline.push(f);
            }
          }
          logger.info('Restored saved mappings for existing fields', {
            indexId,
            restoredCount: mappingByField.size,
            needPipelineCount: fieldsNeedingPipeline.length,
          });
        } else {
          // No existing config — all fields need pipeline
          fieldsNeedingPipeline.push(...fields);
        }

        // Step B: Run LLM/rule pipeline only for fields that need it
        if (fieldsNeedingPipeline.length > 0) {
          const discoveredFields: IDiscoveredSchemaField[] = fieldsNeedingPipeline.map((f) => ({
            path: f.fieldPath,
            name: f.fieldPath,
            type: f.fieldType,
            required: false,
            enumValues:
              f.fieldType === 'string' && f.sampleValues.length > 0 && f.sampleValues.length <= 10
                ? f.sampleValues
                : undefined,
          }));

          try {
            const pipelineResults = await runMappingPipeline(
              discoveredFields,
              'file_upload',
              tenantId,
              indexId,
            );
            // Merge pipeline results (don't overwrite restored mappings)
            for (const [path, suggestion] of pipelineResults) {
              if (!mappingByField.has(path)) {
                mappingByField.set(path, suggestion);
              }
            }
            logger.info('Mapping pipeline results for JSON preview', {
              resultCount: pipelineResults.size,
              fieldsProcessed: fieldsNeedingPipeline.map((f) => f.fieldPath),
              mappedFields: Array.from(pipelineResults.entries()).map(
                ([src, s]) => `${src} → ${s.canonicalField} (${s.confidence})`,
              ),
            });
          } catch (mapErr) {
            logger.warn('Mapping pipeline failed during preview, continuing without suggestions', {
              error: mapErr instanceof Error ? mapErr.message : String(mapErr),
            });
          }
        }

        // Cache for save endpoint — avoids duplicate LLM call
        setCachedMappings(tenantId, indexId, mappingByField);
      }

      const fieldsWithMappings = fields.map((f) => {
        const mapping = mappingByField.get(f.fieldPath);
        // Resolve human-readable label from the canonical field definition
        const canonicalDef = mapping
          ? AVAILABLE_CANONICAL_FIELDS.find((c) => c.storageField === mapping.canonicalField)
          : null;
        return {
          ...f,
          suggestedMapping: mapping
            ? {
                canonicalField: mapping.canonicalField,
                confidence: mapping.confidence,
                displayLabel:
                  canonicalDef?.label ||
                  mapping.suggestedLabel ||
                  mapping.suggestedAlias ||
                  mapping.canonicalField,
                reasoning: mapping.reasoning,
              }
            : null,
        };
      });

      // Build available canonical fields for the dropdown (core + common + custom)
      const availableFields = AVAILABLE_CANONICAL_FIELDS.map((f) => ({
        value: f.storageField,
        label: f.label,
        type: f.type,
        group: f.category,
      }));

      // ── autoSave: save field config + create schema + trigger vocab in one shot ──
      const autoSave = req.query.autoSave === 'true' || req.body?.autoSave === true;
      let saveResult: any = null;

      if (autoSave && !allFieldsKnown) {
        try {
          // Build fields in PUT-compatible format using suggestions
          const fieldsForSave = fieldsWithMappings.map((f: any) => ({
            fieldPath: f.fieldPath,
            fieldType: f.fieldType,
            selected: true,
            canonicalMapping: f.suggestedMapping?.canonicalField || undefined,
            sampleValues: f.sampleValues || [],
            maxLength: f.maxLength || 0,
          }));

          // Internally invoke the save logic (reuse the PUT handler's core)
          saveResult = await saveFieldConfigInternal(
            indexId,
            tenantId,
            fieldsForSave,
            mappingByField,
            req.tenantContext!,
          );
          logger.info('autoSave completed in preview endpoint', {
            indexId,
            mappingCount: saveResult?.mappingCount,
            vocabTriggered: saveResult?.vocabTriggered,
          });
        } catch (saveErr) {
          logger.warn('autoSave failed during preview (non-fatal)', {
            error: saveErr instanceof Error ? saveErr.message : String(saveErr),
          });
        }
      }

      res.json({
        success: true,
        data: {
          fields: fieldsWithMappings,
          availableCanonicalFields: availableFields,
          recordCount: records.length,
          sampleCount: sampleRecords.length,
          hasExistingConfig: !!existingConfig,
          existingConfig: existingConfig || null,
          allFieldsKnown,
          newFieldPaths,
          schemaProvided: !!(userSchema && userSchema.properties),
          saved: autoSave ? !!saveResult : undefined,
          saveResult: autoSave ? saveResult : undefined,
        },
      });

      logger.info('JSON schema preview generated', {
        indexId,
        fieldCount: fields.length,
        recordCount: records.length,
        suggestedCount: fields.filter((f) => f.suggested).length,
        allFieldsKnown,
        newFieldCount: newFieldPaths.length,
        schemaProvided: !!(userSchema && userSchema.properties),
        autoSave,
      });
    } catch (error) {
      // Clean up temp file on error
      if (req.file?.path) {
        const fsPromises = await import('fs/promises');
        await fsPromises.unlink(req.file.path).catch(() => {
          /* non-critical */
        });
      }

      logger.error('JSON schema preview failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({
        success: false,
        error: { code: 'SCHEMA_PREVIEW_FAILED', message: 'Failed to extract JSON schema' },
      });
    }
  },
);

/**
 * GET /:indexId/json-field-config
 *
 * Get the current JSON field configuration for this index.
 */
router.get('/:indexId/json-field-config', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    res.json({
      success: true,
      data: (index as any).jsonFieldConfig || null,
    });
  } catch (error) {
    logger.error('Get JSON field config failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'GET_CONFIG_FAILED', message: 'Failed to get field config' },
    });
  }
});

/**
 * GET /:indexId/json-field-config/rediscover
 *
 * Re-discover fields from a pending JSON document's stored file.
 * Used when the user clicks "Configure Fields" on a document that
 * was uploaded but the field selection dialog was never completed.
 */
router.get('/:indexId/json-field-config/rediscover', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Find the stored file from a pending document
    const SearchDocument = getLazyModel('SearchDocument');
    const pendingDoc = (await SearchDocument.findOne({
      indexId,
      tenantId,
      status: 'pending_field_selection',
      sourceUrl: { $ne: null },
    })
      .sort({ createdAt: -1 })
      .lean()) as any;

    if (!pendingDoc?.sourceUrl) {
      res.status(404).json({ error: 'No pending JSON document found. Please re-upload.' });
      return;
    }

    // Read stored file — resolve relative /uploads/ paths against cwd
    const fsPromises = await import('fs/promises');
    const pathModule = await import('path');
    const filePath = pendingDoc.sourceUrl.startsWith('/uploads/')
      ? pathModule.join(process.cwd(), pendingDoc.sourceUrl)
      : pendingDoc.sourceUrl;

    let fileBuffer: Buffer;
    try {
      fileBuffer = await fsPromises.readFile(filePath);
    } catch (err) {
      logger.warn('Stored JSON file not readable for rediscovery', {
        filePath,
        error: err instanceof Error ? err.message : String(err),
      });
      res.status(404).json({ error: 'Stored file not accessible. Please re-upload.' });
      return;
    }

    // Write to temp file and set req.file so the schema-preview handler can process it
    const tmpDir = pathModule.join(process.cwd(), 'uploads', 'temp');
    if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });
    const tmpPath = pathModule.join(tmpDir, `rediscover-${Date.now()}.json`);
    await fsPromises.writeFile(tmpPath, fileBuffer);
    req.file = {
      path: tmpPath,
      originalname: pendingDoc.originalReference || 'rediscovered.json',
    } as any;

    // Delegate to the schema-preview route handler — reuses the exact same
    // parsing, schema extraction, mapping pipeline, and response building.
    // The preview handler is the second middleware in the route stack
    // (first is multer upload, which we bypass by setting req.file directly).
    const previewRoute = router.stack.find(
      (layer: any) => layer.route?.path === '/:indexId/json-schema-preview',
    );
    const handler = previewRoute?.route?.stack?.[1]?.handle;
    if (handler) {
      await handler(req, res, () => {
        logger.warn('Rediscover: schema-preview handler called next() unexpectedly');
      });
    } else {
      await fsPromises.unlink(tmpPath).catch((e: unknown) => {
        logger.warn('Failed to clean temp file', { error: String(e) });
      });
      res.status(500).json({ error: 'Schema preview handler not available' });
    }
  } catch (error) {
    logger.error('JSON field rediscovery failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Failed to rediscover JSON fields' });
    }
  }
});

/**
 * PUT /:indexId/json-field-config
 *
 * Save user's field selections. This triggers processing of any
 * pending JSON documents that were waiting for field selection.
 *
 * Accepts BOTH formats:
 * 1. Native: {fieldPath, fieldType, selected, canonicalMapping}
 * 2. Preview output: {fieldPath, fieldType, suggestedMapping: {canonicalField, confidence}}
 *    (auto-flattened: selected defaults to true, canonicalMapping from suggestedMapping)
 */
router.put('/:indexId/json-field-config', async (req: Request, res: Response) => {
  try {
    if (!req.tenantContext) {
      res.status(401).json({ error: 'Tenant context required' });
      return;
    }

    const { indexId } = req.params;
    const tenantId = req.tenantContext.tenantId;
    let { fields } = req.body;

    if (!fields || !Array.isArray(fields)) {
      res.status(400).json({ error: 'fields array is required' });
      return;
    }

    // Auto-flatten preview output format → native format
    // If a field has suggestedMapping but no canonicalMapping, convert it
    fields = fields.map((f: any) => {
      const normalized = { ...f };
      // Default selected to true if not provided
      if (typeof normalized.selected !== 'boolean') {
        normalized.selected = true;
      }
      // Flatten suggestedMapping.canonicalField → canonicalMapping
      if (
        !normalized.canonicalMapping &&
        !normalized.mappingOverride &&
        normalized.suggestedMapping
      ) {
        normalized.canonicalMapping = normalized.suggestedMapping.canonicalField;
      }
      return normalized;
    });

    // Validate field entries
    for (const field of fields) {
      if (!field.fieldPath) {
        res.status(400).json({
          error: 'Each field must have fieldPath (string)',
        });
        return;
      }
    }

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    );
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    // Get existing config version for increment
    const existingVersion = (index as any).jsonFieldConfig?.version || 0;

    // Save field config — persist BOTH mappingOverride AND canonicalMapping
    // canonicalMapping = the final resolved mapping (auto-suggest or manual),
    // so that on the next upload, existing fields retain their mapping.
    await SearchIndex.findOneAndUpdate(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
      {
        $set: {
          jsonFieldConfig: {
            version: existingVersion + 1,
            fields: fields.map((f: any) => ({
              fieldPath: f.fieldPath,
              fieldType: f.fieldType || 'string',
              selected: f.selected,
              sampleValues: f.sampleValues || [],
              maxLength: f.maxLength ?? 0,
              mappingOverride: f.mappingOverride || undefined,
              canonicalMapping: f.canonicalMapping || f.mappingOverride || undefined,
            })),
            autoSuggestApplied: req.body.autoSuggestApplied ?? false,
            updatedAt: new Date(),
          },
        },
      },
    );

    // ── Resolve mappings FIRST, then enqueue chunks WITH them ──────────
    // This ensures the chunking worker uses the user's saved mappings
    // (including manual overrides) instead of running a separate LLM call.
    const { createQueue } = await import('../workers/shared.js');
    const SearchDocument = getLazyModel('SearchDocument');

    // ── Create canonical schema + field mappings for JSON fields ──────
    let mappingCount = 0;
    let allMappings: Map<string, MappingSuggestion> | null = null;
    try {
      const CanonicalSchemaModel = getLazyModel<ICanonicalSchema>('CanonicalSchema');
      const FieldMappingModel = getLazyModel<IFieldMapping>('FieldMapping');

      // CanonicalSchema.knowledgeBaseId stores SearchIndex._id (set at KB creation).
      // Use indexId directly — NOT KnowledgeBase._id — so we find the existing schema
      // and link FieldMappings to the same canonicalSchemaId that tab-stats queries.
      const schemaKbId = indexId;

      // Look up actual KnowledgeBase._id (only needed for vocab queue, not schema lookup)
      const KnowledgeBase = getLazyModel('KnowledgeBase');
      const kb = await KnowledgeBase.findOne({ searchIndexId: indexId, tenantId }).lean();
      const actualKbId = (kb as any)?._id || indexId;

      // Get or create CanonicalSchema
      let canonicalSchema = await CanonicalSchemaModel.findOne({
        knowledgeBaseId: schemaKbId,
        tenantId,
        status: 'active',
      });

      if (!canonicalSchema) {
        canonicalSchema = await CanonicalSchemaModel.create({
          tenantId,
          knowledgeBaseId: schemaKbId,
          version: 1,
          fields: [],
          status: 'active',
        });
        logger.info('Auto-created CanonicalSchema for JSON KB', {
          canonicalSchemaId: canonicalSchema._id,
          knowledgeBaseId: schemaKbId,
        });
      }

      // Convert selected fields to IDiscoveredSchemaField format
      const selectedFields = fields.filter((f: any) => f.selected);
      const discoveredFields: IDiscoveredSchemaField[] = selectedFields.map((f: any) => ({
        path: f.fieldPath,
        name: f.fieldPath,
        type: f.fieldType || 'string',
        required: false,
      }));

      // Reuse cached mappings from preview (avoids duplicate LLM call).
      // Only fall back to running the full pipeline if cache expired or missed.
      allMappings = getCachedMappings(tenantId, indexId);
      if (allMappings) {
        logger.info('Using cached mapping pipeline results from preview', {
          cachedCount: allMappings.size,
          selectedCount: selectedFields.length,
        });
      } else {
        logger.info('No cached mappings — running full pipeline on save', {
          selectedCount: selectedFields.length,
        });
        allMappings = await runMappingPipeline(discoveredFields, 'file_upload', tenantId, indexId);
      }

      // Apply user's mapping choices — prefer mappingOverride (manual), fall back
      // to canonicalMapping (saved final mapping from frontend's getEffectiveMapping)
      for (const f of fields) {
        const finalMapping = f.mappingOverride || f.canonicalMapping;
        if (finalMapping && f.selected) {
          const existing = allMappings.get(f.fieldPath);
          // Don't overwrite if pipeline already resolved to the same field
          if (existing && existing.canonicalField === finalMapping) continue;
          const overrideField = AVAILABLE_CANONICAL_FIELDS.find(
            (c) => c.storageField === finalMapping,
          );
          allMappings.set(f.fieldPath, {
            canonicalField: finalMapping,
            sourcePath: f.fieldPath,
            transform: existing?.transform ?? { type: 'direct' },
            confidence: f.mappingOverride ? 1.0 : (existing?.confidence ?? 0.9),
            reasoning: f.mappingOverride
              ? 'Manually selected by user'
              : 'Restored from saved configuration',
            suggestedAlias: overrideField?.label ?? finalMapping,
            suggestedLabel: overrideField?.label ?? finalMapping,
          });
        }
      }

      // Use a synthetic connectorId for JSON file uploads
      const connectorId = `json-upload:${indexId}`;

      // Delete existing JSON-upload mappings for this schema (clean re-mapping)
      await FieldMappingModel.deleteMany({
        canonicalSchemaId: canonicalSchema._id,
        connectorId,
        tenantId,
      });

      // Track used custom slot indices per type
      const usedCustomSlots = { string: 0, number: 0, date: 0, bool: 0 };

      // Build FieldMapping docs and canonical fields
      const newMappingDocs: Partial<IFieldMapping>[] = [];
      const newCanonicalFields: any[] = [];
      const existingStorageFields = new Set(
        (canonicalSchema.fields || []).map((f: any) => f.storageField),
      );
      const mappedSourcePaths = new Set(allMappings.keys());

      // 1) Pipeline-matched fields → map to known canonical fields
      for (const [, result] of allMappings) {
        newMappingDocs.push({
          tenantId,
          canonicalSchemaId: canonicalSchema._id,
          canonicalField: result.canonicalField,
          connectorId,
          sourcePath: result.sourcePath,
          transform: { type: result.transform?.type || 'direct' },
          confidence: result.confidence,
          // User explicitly selected these fields — always 'active', not 'suggested'
          status: 'active',
          suggestedBy: result.confidence >= 0.8 ? 'rules' : 'llm',
          reviewedBy: 'system',
          reviewedAt: new Date(),
        } as Partial<IFieldMapping>);

        // Ensure canonical field exists in schema
        if (!existingStorageFields.has(result.canonicalField)) {
          const availField = getAvailableField(result.canonicalField);
          if (availField) {
            const cf = toCanonicalField(availField);
            // Override name/label with source field name so filtering
            // by original field name works (alias = source field humanized).
            // The canonical label goes into description for discoverability.
            const sourceHumanized = result.sourcePath
              .replace(/([a-z])([A-Z])/g, '$1 $2')
              .split(/[._-]/)
              .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ');
            cf.name = sourceHumanized;
            cf.label = sourceHumanized;
            cf.sourceConnectorField = result.sourcePath;
            if (!cf.description) {
              cf.description = `${sourceHumanized} (mapped to ${availField.label})`;
            }
            newCanonicalFields.push(cf);
            existingStorageFields.add(result.canonicalField);
          }
        }
      }

      // 2) Unmatched selected fields → assign to custom slots
      for (const field of selectedFields) {
        const fieldPath = (field as any).fieldPath;
        if (mappedSourcePaths.has(fieldPath)) continue;

        const fieldType = (field as any).fieldType || 'string';
        let customField: string;
        if (fieldType === 'number') {
          usedCustomSlots.number += 1;
          customField = `custom_number_${usedCustomSlots.number}`;
        } else if (fieldType === 'boolean') {
          usedCustomSlots.bool += 1;
          customField = `custom_bool_${usedCustomSlots.bool}`;
        } else if (fieldType === 'date') {
          usedCustomSlots.date += 1;
          customField = `custom_date_${usedCustomSlots.date}`;
        } else {
          usedCustomSlots.string += 1;
          customField = `custom_string_${usedCustomSlots.string}`;
        }

        const humanLabel = fieldPath
          .split(/[._]/)
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');

        newMappingDocs.push({
          tenantId,
          canonicalSchemaId: canonicalSchema._id,
          canonicalField: customField,
          connectorId,
          sourcePath: fieldPath,
          transform: { type: 'direct' },
          confidence: 0.7,
          status: 'active',
          suggestedBy: 'rules',
          reviewedBy: 'system',
          reviewedAt: new Date(),
        });

        if (!existingStorageFields.has(customField)) {
          const availField = getAvailableField(customField);
          if (availField) {
            const cf = toCanonicalField(availField);
            cf.name = humanLabel;
            cf.label = humanLabel;
            newCanonicalFields.push(cf);
            existingStorageFields.add(customField);
          }
        }
      }

      // Update canonical schema: add new fields AND enrich existing ones
      // with sourceConnectorField (so alias resolver can find them by source name).
      // Build a reverse map: canonicalField → sourcePath for quick lookup.
      const canonicalToSource = new Map<string, { sourcePath: string; humanized: string }>();
      for (const [, result] of allMappings!) {
        const humanized = result.sourcePath
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .split(/[._-]/)
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        canonicalToSource.set(result.canonicalField, {
          sourcePath: result.sourcePath,
          humanized,
        });
      }

      const existingFields: any[] = (canonicalSchema.fields || []).map((f: any) =>
        typeof f.toObject === 'function' ? f.toObject() : { ...f },
      );
      const updatedFields = existingFields.map((f: any) => {
        const src = canonicalToSource.get(f.storageField);
        if (!src) return f;
        return {
          ...f,
          sourceConnectorField: src.sourcePath,
          name: src.humanized,
          label: src.humanized,
        };
      });
      const mergedFields = [...updatedFields, ...newCanonicalFields];
      await CanonicalSchemaModel.findOneAndUpdate(
        { _id: canonicalSchema._id, tenantId },
        { $set: { fields: mergedFields } },
      );

      // Bulk insert field mappings — deduplicate by canonicalField before inserting,
      // and use ordered:false so one duplicate key doesn't abort the entire batch.
      if (newMappingDocs.length > 0) {
        const seenCanonical = new Set<string>();
        const dedupedDocs = newMappingDocs.filter((doc: any) => {
          const key = doc.canonicalField;
          if (seenCanonical.has(key)) return false;
          seenCanonical.add(key);
          return true;
        });

        try {
          await FieldMappingModel.insertMany(dedupedDocs, { ordered: false });
        } catch (bulkErr: any) {
          // E11000 duplicate key errors are expected when re-saving — ignore them
          if (bulkErr?.code !== 11000 && !bulkErr?.message?.includes('E11000')) {
            throw bulkErr;
          }
          logger.debug('Some field mappings already existed (E11000), continuing', {
            indexId,
          });
        }
        mappingCount = dedupedDocs.length;
        logger.info('Created field mappings for JSON upload', {
          indexId,
          mappingCount,
          canonicalSchemaId: canonicalSchema._id,
        });
      }

      // Invalidate alias resolver cache in search-ai-runtime so filters
      // using sourceConnectorField resolve immediately without restart.
      let aliasPub: RedisClient | null = null;
      try {
        const opts = resolveRedisOptionsFromEnv();
        if (!opts) throw new Error('Redis not configured');
        const handle = createRedisConnection(opts);
        aliasPub = handle.client;
        await aliasPub.publish(
          'alias-resolver:invalidate',
          JSON.stringify({ knowledgeBaseId: schemaKbId, tenantId }),
        );
        logger.info('Published alias-resolver cache invalidation', {
          indexId,
          knowledgeBaseId: schemaKbId,
        });
      } catch (redisErr) {
        logger.warn('Failed to publish alias cache invalidation (non-fatal)', {
          error: redisErr instanceof Error ? redisErr.message : String(redisErr),
        });
      } finally {
        if (aliasPub) {
          aliasPub.quit().catch((quitErr: unknown) => {
            logger.warn('Redis quit failed during alias invalidation', {
              error: quitErr instanceof Error ? quitErr.message : String(quitErr),
            });
          });
        }
      }

      // Generate vocabulary entries INLINE from field mappings
      if (allMappings && allMappings.size > 0) {
        try {
          const DomainVocabularyModel = getLazyModel<IDomainVocabulary>('DomainVocabulary');
          const { uuidv7 } = await import('@agent-platform/database/mongo');

          const vocabEntries: any[] = [];
          for (const [sourcePath, mapping] of allMappings) {
            const humanLabel = sourcePath
              .replace(/([a-z])([A-Z])/g, '$1 $2')
              .split(/[._-]/)
              .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
              .join(' ');

            const fieldDef = fields.find((f: any) => f.fieldPath === sourcePath);
            const isStringField = !fieldDef || fieldDef.fieldType === 'string';
            const isNumberField = fieldDef?.fieldType === 'number';

            vocabEntries.push({
              id: uuidv7(),
              term: humanLabel.toLowerCase(),
              aliases: [
                sourcePath,
                humanLabel,
                sourcePath.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
                ...(sourcePath.includes('_') ? [sourcePath.replace(/_/g, ' ')] : []),
              ].filter((a: string, i: number, arr: string[]) => arr.indexOf(a) === i),
              description: `${humanLabel} field (mapped to ${mapping.canonicalField})`,
              fieldRef: mapping.canonicalField,
              capabilities: {
                canFilter: true,
                canDisplay: true,
                canAggregate: isStringField,
                canSort: isNumberField || fieldDef?.fieldType === 'date',
              },
              relatedFields: { displayWith: [], aggregateWith: [] },
              enabled: true,
              confidence: mapping.confidence,
              generatedBy: 'auto',
            });

            // NOTE: No value-type entries generated here. Vocabulary should only contain
            // one entry per mapped field (the field-term). Sample values belong in the
            // canonical metadata on chunks, not in the vocabulary. The query resolver uses
            // vocab to understand which field a user term refers to, not to enumerate values.
          }

          // Upsert DomainVocabulary
          const vocabKbId = indexId;
          const existingVocab = await DomainVocabularyModel.findOne({
            projectKnowledgeBaseId: vocabKbId,
            tenantId,
          });

          if (existingVocab) {
            const newFieldRefs = new Set(vocabEntries.map((e: any) => e.fieldRef));
            const kept = existingVocab.entries.filter(
              (e: any) => !(e.generatedBy === 'auto' && newFieldRefs.has(e.fieldRef)),
            );
            existingVocab.entries = [...kept, ...vocabEntries];
            existingVocab.version += 1;
            existingVocab.status = 'active';
            await existingVocab.save();
          } else {
            await DomainVocabularyModel.create({
              tenantId,
              projectKnowledgeBaseId: vocabKbId,
              version: 1,
              status: 'active',
              entries: vocabEntries,
            });
          }

          logger.info('Inline vocabulary generation completed (PUT)', {
            indexId,
            knowledgeBaseId: vocabKbId,
            entryCount: vocabEntries.length,
          });
        } catch (vocabErr) {
          logger.warn('Inline vocabulary generation failed in PUT (non-fatal)', {
            error: vocabErr instanceof Error ? vocabErr.message : String(vocabErr),
          });
        }
      }
      // ── Backfill canonicalMapping in jsonFieldConfig so future uploads
      //    see the final resolved mapping for every field. This covers:
      //    (a) first-time saves where frontend didn't send canonicalMapping
      //    (b) legacy data migrated before the canonicalMapping feature ──
      if (allMappings && allMappings.size > 0) {
        const backfilledFields = fields.map((f: any) => {
          const resolved = allMappings!.get(f.fieldPath);
          return {
            fieldPath: f.fieldPath,
            fieldType: f.fieldType || 'string',
            selected: f.selected,
            sampleValues: f.sampleValues || [],
            maxLength: f.maxLength ?? 0,
            mappingOverride: f.mappingOverride || undefined,
            canonicalMapping:
              f.canonicalMapping || f.mappingOverride || resolved?.canonicalField || undefined,
          };
        });
        await SearchIndex.findOneAndUpdate(
          applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
          { $set: { 'jsonFieldConfig.fields': backfilledFields } },
        );
        logger.info('Backfilled canonicalMapping in jsonFieldConfig', {
          indexId,
          backfilledCount: backfilledFields.filter((f: any) => f.canonicalMapping).length,
          totalFields: backfilledFields.length,
        });
      }
    } catch (mappingError) {
      // Non-fatal — field config is saved, mappings are best-effort
      logger.warn('Failed to create field mappings for JSON upload', {
        error: mappingError instanceof Error ? mappingError.message : String(mappingError),
        indexId,
      });
    }

    // ── Convert allMappings → FieldMapping[] for the chunking worker ──
    // CRITICAL: Exclude long text fields (maxLength > 200).
    // Long text is for embedding only (via recordToText), NOT for
    // structured canonical metadata. Uses un-truncated maxLength from
    // the preview API (same threshold as the frontend's isLongTextField).
    const resolvedMappings: FieldMapping[] = [];
    if (allMappings) {
      for (const [sourcePath, suggestion] of allMappings) {
        const fieldEntry = fields.find((f: any) => f.fieldPath === sourcePath);
        const fieldType = fieldEntry?.fieldType || 'string';

        // Skip long text fields — use maxLength (un-truncated), not sample
        // value lengths which may be truncated to ~80 chars by the preview API.
        // Threshold 200 matches the frontend's isLongTextField() check.
        if (fieldType === 'string') {
          const maxLength = fieldEntry?.maxLength ?? 0;
          if (maxLength > 200) {
            logger.info('Skipping long text field from resolvedMappings', {
              fieldPath: sourcePath,
              maxLength,
              canonicalField: suggestion.canonicalField,
            });
            continue; // Embedding only, not canonical metadata
          }
        }

        const canonicalDef = AVAILABLE_CANONICAL_FIELDS.find(
          (c) => c.storageField === suggestion.canonicalField,
        );
        const isNumeric = fieldType === 'number';
        const isDate = fieldType === 'date';

        // Build alias: use the SOURCE field name (humanized) as the primary term.
        // This ensures filtering by the original field name works directly.
        const humanized = sourcePath
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .split(/[._-]/)
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        const alias = humanized;

        // Build synonyms: include canonical field label, raw source path,
        // and canonical field storage name so users can filter by either
        // the original name OR the mapped canonical name.
        const synonymSet = new Set<string>();
        if (sourcePath !== alias) synonymSet.add(sourcePath);
        if (canonicalDef?.label && canonicalDef.label !== alias) {
          synonymSet.add(canonicalDef.label);
        }
        if (
          suggestion.canonicalField !== sourcePath &&
          suggestion.canonicalField !== alias.toLowerCase()
        ) {
          synonymSet.add(suggestion.canonicalField);
        }
        const canonicalHumanized = suggestion.canonicalField
          .replace(/_/g, ' ')
          .replace(/([a-z])([A-Z])/g, '$1 $2')
          .split(/\s+/)
          .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
          .join(' ');
        if (canonicalHumanized !== alias) {
          synonymSet.add(canonicalHumanized);
        }

        // Build description from mapping reasoning + sample values
        const samplePreview = fieldEntry?.sampleValues?.slice(0, 3)?.join(', ') || '';
        const description = samplePreview
          ? `${alias} — ${suggestion.reasoning || `mapped from ${sourcePath}`}. Examples: ${samplePreview}`
          : `${alias} — ${suggestion.reasoning || `mapped from ${sourcePath}`}`;

        resolvedMappings.push({
          sourceField: sourcePath,
          canonicalField: suggestion.canonicalField,
          type: isNumeric ? 'number' : isDate ? 'date' : 'keyword',
          filterable: true,
          sortable: isNumeric || isDate,
          aggregatable: isNumeric,
          alias,
          synonyms: [...synonymSet],
          description,
          sampleValues: fieldEntry?.sampleValues || undefined,
        });
      }

      logger.info('Built resolved FieldMapping[] for chunking worker', {
        total: resolvedMappings.length,
        skippedLongText: allMappings.size - resolvedMappings.length,
        mappings: resolvedMappings.map(
          (m) =>
            `${m.sourceField} → ${m.canonicalField} (alias: ${m.alias}, synonyms: [${m.synonyms.join(', ')}])`,
        ),
      });
    }

    // ── Now enqueue pending docs WITH the resolved mappings ─────────────
    const pendingDocs = await SearchDocument.find({
      indexId,
      tenantId,
      status: 'pending_field_selection',
      contentType: 'application/json',
    }).lean();

    if (pendingDocs.length > 0) {
      const QUEUE_JSON_RECORD_CHUNKING = 'json-record-chunking';
      const jsonQueue = createQueue(QUEUE_JSON_RECORD_CHUNKING);
      try {
        for (const doc of pendingDocs) {
          await jsonQueue.add(`json-chunk:${doc._id}`, {
            indexId,
            documentId: String(doc._id),
            sourceUrl: doc.sourceUrl,
            tenantId,
            resolvedMappings,
          });

          await SearchDocument.findOneAndUpdate(
            { _id: doc._id, tenantId },
            { $set: { status: 'pending' } },
          );
        }

        logger.info('Enqueued pending JSON documents with resolved mappings', {
          indexId,
          documentCount: pendingDocs.length,
          resolvedMappingCount: resolvedMappings.length,
        });
      } finally {
        await jsonQueue.close();
      }
    }

    res.json({
      success: true,
      data: {
        version: existingVersion + 1,
        fieldCount: fields.length,
        selectedCount: fields.filter((f: any) => f.selected).length,
        pendingDocsEnqueued: pendingDocs.length,
        mappingCount,
      },
    });

    logger.info('JSON field config saved', {
      indexId,
      version: existingVersion + 1,
      selectedFields: fields.filter((f: any) => f.selected).length,
      totalFields: fields.length,
      pendingDocsEnqueued: pendingDocs.length,
      mappingCount,
    });
  } catch (error) {
    logger.error('Save JSON field config failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'SAVE_CONFIG_FAILED', message: 'Failed to save field config' },
    });
  }
});

// ─── Internal Save Logic (shared between PUT and autoSave) ──────────────

/**
 * Core logic to save field config, create CanonicalSchema + FieldMappings,
 * and trigger vocabulary generation. Used by both PUT handler and autoSave.
 */
async function saveFieldConfigInternal(
  indexId: string,
  tenantId: string,
  fields: any[],
  mappingByField: Map<string, MappingSuggestion>,
  tenantContext: any,
): Promise<{
  version: number;
  mappingCount: number;
  vocabTriggered: boolean;
  fieldCount: number;
  selectedCount: number;
}> {
  const index = await SearchIndex.findOne(
    applyProjectScopeFilter({ _id: indexId, tenantId }, tenantContext),
  );
  if (!index) throw new Error('Index not found');

  const existingVersion = (index as any).jsonFieldConfig?.version || 0;

  // Save field config on SearchIndex
  await SearchIndex.findOneAndUpdate(
    applyProjectScopeFilter({ _id: indexId, tenantId }, tenantContext),
    {
      $set: {
        jsonFieldConfig: {
          version: existingVersion + 1,
          fields: fields.map((f: any) => ({
            fieldPath: f.fieldPath,
            fieldType: f.fieldType || 'string',
            selected: f.selected !== false,
            sampleValues: f.sampleValues || [],
            maxLength: f.maxLength ?? 0,
            mappingOverride: f.mappingOverride || undefined,
            canonicalMapping: f.canonicalMapping || f.mappingOverride || undefined,
          })),
          autoSuggestApplied: true,
          updatedAt: new Date(),
        },
      },
    },
  );

  // ── Create CanonicalSchema + FieldMappings ──────────────────────────
  let mappingCount = 0;
  let vocabTriggered = false;
  const { createQueue } = await import('../workers/shared.js');

  try {
    const CanonicalSchemaModel = getLazyModel<ICanonicalSchema>('CanonicalSchema');
    const FieldMappingModel = getLazyModel<IFieldMapping>('FieldMapping');
    const schemaKbId = indexId;

    // Look up actual KnowledgeBase._id (needed for vocab)
    const KnowledgeBase = getLazyModel('KnowledgeBase');
    const kb = await KnowledgeBase.findOne({ searchIndexId: indexId, tenantId }).lean();
    const actualKbId = (kb as any)?._id || indexId;

    // Get or create CanonicalSchema
    let canonicalSchema = await CanonicalSchemaModel.findOne({
      knowledgeBaseId: schemaKbId,
      tenantId,
      status: 'active',
    });

    if (!canonicalSchema) {
      canonicalSchema = await CanonicalSchemaModel.create({
        tenantId,
        knowledgeBaseId: schemaKbId,
        version: 1,
        fields: [],
        status: 'active',
      });
      logger.info('Auto-created CanonicalSchema', {
        canonicalSchemaId: canonicalSchema._id,
        indexId,
      });
    }

    // Build field mappings
    const selectedFields = fields.filter((f: any) => f.selected !== false);
    const connectorId = `json-upload:${indexId}`;

    // Delete existing JSON-upload mappings (clean re-mapping)
    await FieldMappingModel.deleteMany({
      canonicalSchemaId: canonicalSchema._id,
      connectorId,
      tenantId,
    });

    const newMappingDocs: Partial<IFieldMapping>[] = [];
    const newCanonicalFields: any[] = [];
    const existingStorageFields = new Set(
      (canonicalSchema.fields || []).map((f: any) => f.storageField),
    );

    // Apply user's mapping choices or use suggestions from mappingByField
    const allMappings = new Map(mappingByField);
    for (const f of fields) {
      const finalMapping = f.canonicalMapping || f.mappingOverride;
      if (finalMapping && f.selected !== false) {
        if (
          allMappings.has(f.fieldPath) &&
          allMappings.get(f.fieldPath)!.canonicalField === finalMapping
        )
          continue;
        const overrideField = AVAILABLE_CANONICAL_FIELDS.find(
          (c) => c.storageField === finalMapping,
        );
        allMappings.set(f.fieldPath, {
          canonicalField: finalMapping,
          sourcePath: f.fieldPath,
          transform: { type: 'direct' },
          confidence: 1.0,
          reasoning: 'User-selected or auto-suggested mapping',
          suggestedAlias: overrideField?.label ?? finalMapping,
          suggestedLabel: overrideField?.label ?? finalMapping,
        });
      }
    }

    // Create FieldMapping docs + canonical fields for mapped fields
    for (const [, result] of allMappings) {
      newMappingDocs.push({
        tenantId,
        canonicalSchemaId: canonicalSchema._id,
        canonicalField: result.canonicalField,
        connectorId,
        sourcePath: result.sourcePath,
        transform: { type: result.transform?.type || 'direct' },
        confidence: result.confidence,
        status: 'active',
        suggestedBy: result.confidence >= 0.8 ? 'rules' : 'llm',
        reviewedBy: 'system',
        reviewedAt: new Date(),
      } as Partial<IFieldMapping>);

      if (!existingStorageFields.has(result.canonicalField)) {
        const availField = getAvailableField(result.canonicalField);
        if (availField) {
          const cf = toCanonicalField(availField);
          const sourceHumanized = result.sourcePath
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .split(/[._-]/)
            .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
          cf.name = sourceHumanized;
          cf.label = sourceHumanized;
          cf.sourceConnectorField = result.sourcePath;
          newCanonicalFields.push(cf);
          existingStorageFields.add(result.canonicalField);
        }
      }
    }

    // Compute highest used custom slot numbers from ALL mappings (existing + new)
    // so that unmatched fields get slots that don't conflict.
    const usedCustomSlots = { string: 0, number: 0, date: 0, bool: 0 };
    for (const [, mapping] of allMappings) {
      const cf = mapping.canonicalField;
      const stringMatch = cf.match(/^custom_string_(\d+)$/);
      if (stringMatch) {
        usedCustomSlots.string = Math.max(usedCustomSlots.string, parseInt(stringMatch[1], 10));
        continue;
      }
      const numberMatch = cf.match(/^custom_number_(\d+)$/);
      if (numberMatch) {
        usedCustomSlots.number = Math.max(usedCustomSlots.number, parseInt(numberMatch[1], 10));
        continue;
      }
      const boolMatch = cf.match(/^custom_bool_(\d+)$/);
      if (boolMatch) {
        usedCustomSlots.bool = Math.max(usedCustomSlots.bool, parseInt(boolMatch[1], 10));
        continue;
      }
      const dateMatch = cf.match(/^custom_date_(\d+)$/);
      if (dateMatch) {
        usedCustomSlots.date = Math.max(usedCustomSlots.date, parseInt(dateMatch[1], 10));
        continue;
      }
    }
    // Also scan existingStorageFields to avoid conflicts with schema fields
    for (const sf of existingStorageFields) {
      const stringMatch = sf.match(/^custom_string_(\d+)$/);
      if (stringMatch) {
        usedCustomSlots.string = Math.max(usedCustomSlots.string, parseInt(stringMatch[1], 10));
        continue;
      }
      const numberMatch = sf.match(/^custom_number_(\d+)$/);
      if (numberMatch) {
        usedCustomSlots.number = Math.max(usedCustomSlots.number, parseInt(numberMatch[1], 10));
        continue;
      }
      const boolMatch = sf.match(/^custom_bool_(\d+)$/);
      if (boolMatch) {
        usedCustomSlots.bool = Math.max(usedCustomSlots.bool, parseInt(boolMatch[1], 10));
        continue;
      }
      const dateMatch = sf.match(/^custom_date_(\d+)$/);
      if (dateMatch) {
        usedCustomSlots.date = Math.max(usedCustomSlots.date, parseInt(dateMatch[1], 10));
        continue;
      }
    }

    // Assign unmatched selected fields to custom slots
    for (const field of selectedFields) {
      if (allMappings.has(field.fieldPath)) continue;
      const fieldType = field.fieldType || 'string';
      let customField: string;
      if (fieldType === 'number') {
        usedCustomSlots.number += 1;
        customField = `custom_number_${usedCustomSlots.number}`;
      } else if (fieldType === 'boolean') {
        usedCustomSlots.bool += 1;
        customField = `custom_bool_${usedCustomSlots.bool}`;
      } else if (fieldType === 'date') {
        usedCustomSlots.date += 1;
        customField = `custom_date_${usedCustomSlots.date}`;
      } else {
        usedCustomSlots.string += 1;
        customField = `custom_string_${usedCustomSlots.string}`;
      }

      newMappingDocs.push({
        tenantId,
        canonicalSchemaId: canonicalSchema._id,
        canonicalField: customField,
        connectorId,
        sourcePath: field.fieldPath,
        transform: { type: 'direct' },
        confidence: 0.7,
        status: 'active',
        suggestedBy: 'rules',
        reviewedBy: 'system',
        reviewedAt: new Date(),
      });

      if (!existingStorageFields.has(customField)) {
        const availField = getAvailableField(customField);
        if (availField) {
          const cf = toCanonicalField(availField);
          const humanLabel = field.fieldPath
            .split(/[._]/)
            .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');
          cf.name = humanLabel;
          cf.label = humanLabel;
          cf.sourceConnectorField = field.fieldPath;
          newCanonicalFields.push(cf);
          existingStorageFields.add(customField);
        }
      }
    }

    // Update canonical schema fields
    const existingFields: any[] = (canonicalSchema.fields || []).map((f: any) =>
      typeof f.toObject === 'function' ? f.toObject() : { ...f },
    );
    const canonicalToSource = new Map<string, { sourcePath: string; humanized: string }>();
    for (const [, result] of allMappings) {
      const humanized = result.sourcePath
        .replace(/([a-z])([A-Z])/g, '$1 $2')
        .split(/[._-]/)
        .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
        .join(' ');
      canonicalToSource.set(result.canonicalField, { sourcePath: result.sourcePath, humanized });
    }
    const updatedFields = existingFields.map((f: any) => {
      const src = canonicalToSource.get(f.storageField);
      if (!src) return f;
      return {
        ...f,
        sourceConnectorField: src.sourcePath,
        name: src.humanized,
        label: src.humanized,
      };
    });
    const mergedFields = [...updatedFields, ...newCanonicalFields];
    await CanonicalSchemaModel.findOneAndUpdate(
      { _id: canonicalSchema._id, tenantId },
      { $set: { fields: mergedFields } },
    );

    // Insert field mappings — deduplicate by canonicalField before inserting,
    // and use ordered:false so one duplicate key doesn't abort the entire batch.
    if (newMappingDocs.length > 0) {
      // Deduplicate: if multiple source fields map to same canonical slot, keep first
      const seenCanonical = new Set<string>();
      const dedupedDocs = newMappingDocs.filter((doc: any) => {
        const key = doc.canonicalField;
        if (seenCanonical.has(key)) return false;
        seenCanonical.add(key);
        return true;
      });

      try {
        await FieldMappingModel.insertMany(dedupedDocs, { ordered: false });
      } catch (bulkErr: any) {
        // E11000 duplicate key errors are expected when re-saving — ignore them
        if (bulkErr?.code !== 11000 && !bulkErr?.message?.includes('E11000')) {
          throw bulkErr;
        }
        logger.debug('Some field mappings already existed (E11000), continuing', {
          indexId,
        });
      }
      mappingCount = dedupedDocs.length;
    }

    // Generate vocabulary entries INLINE from field mappings
    // (No queue/worker dependency — creates DomainVocabulary immediately)
    // Runs whenever we have mappings (new or existing) to ensure vocab is populated
    if (allMappings.size > 0) {
      try {
        const DomainVocabularyModel = getLazyModel<IDomainVocabulary>('DomainVocabulary');
        const { uuidv7 } = await import('@agent-platform/database/mongo');

        // Build vocabulary entries from our known mappings
        const vocabEntries: any[] = [];
        for (const [sourcePath, mapping] of allMappings) {
          const humanLabel = sourcePath
            .replace(/([a-z])([A-Z])/g, '$1 $2')
            .split(/[._-]/)
            .map((w: string) => w.charAt(0).toUpperCase() + w.slice(1))
            .join(' ');

          // Determine field type for capabilities
          const fieldDef = fields.find((f: any) => f.fieldPath === sourcePath);
          const isStringField = !fieldDef || fieldDef.fieldType === 'string';
          const isNumberField = fieldDef?.fieldType === 'number';

          vocabEntries.push({
            id: uuidv7(),
            term: humanLabel.toLowerCase(),
            aliases: [
              sourcePath,
              humanLabel,
              sourcePath.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase(),
              ...(sourcePath.includes('_') ? [sourcePath.replace(/_/g, ' ')] : []),
            ].filter((a, i, arr) => arr.indexOf(a) === i), // deduplicate
            description: `${humanLabel} field (mapped to ${mapping.canonicalField})`,
            fieldRef: mapping.canonicalField,
            capabilities: {
              canFilter: true,
              canDisplay: true,
              canAggregate: isStringField,
              canSort: isNumberField || fieldDef?.fieldType === 'date',
            },
            relatedFields: {
              displayWith: [],
              aggregateWith: [],
            },
            enabled: true,
            confidence: mapping.confidence,
            generatedBy: 'auto',
          });

          // NOTE: No value-type entries generated here. Vocabulary = one entry per mapped field.
          // Sample values belong in canonical metadata on chunks, not vocab.
        }

        // Upsert DomainVocabulary doc
        const vocabKbId = indexId;
        const existingVocab = await DomainVocabularyModel.findOne({
          projectKnowledgeBaseId: vocabKbId,
          tenantId,
        });

        if (existingVocab) {
          // Merge: remove old auto entries for same fieldRefs, add new ones
          const newFieldRefs = new Set(vocabEntries.map((e: any) => e.fieldRef));
          const kept = existingVocab.entries.filter(
            (e: any) => !(e.generatedBy === 'auto' && newFieldRefs.has(e.fieldRef)),
          );
          existingVocab.entries = [...kept, ...vocabEntries];
          existingVocab.version += 1;
          existingVocab.status = 'active';
          await existingVocab.save();
        } else {
          await DomainVocabularyModel.create({
            tenantId,
            projectKnowledgeBaseId: vocabKbId,
            version: 1,
            status: 'active',
            entries: vocabEntries,
          });
        }

        vocabTriggered = true;
        logger.info('Inline vocabulary generation completed', {
          indexId,
          knowledgeBaseId: vocabKbId,
          entryCount: vocabEntries.length,
        });
      } catch (vocabErr) {
        logger.warn('Inline vocabulary generation failed (non-fatal)', {
          error: vocabErr instanceof Error ? vocabErr.message : String(vocabErr),
        });
        // Fallback: try to enqueue for async worker
        try {
          const vocabQueue = createQueue('vocabulary-generation');
          await vocabQueue.add(`vocab-gen:json:${indexId}`, {
            connectorId,
            projectKbId: actualKbId,
            knowledgeBaseId: actualKbId,
            tenantId,
            connectorType: 'file_upload',
            indexId,
          });
          await vocabQueue.close();
          vocabTriggered = true;
        } catch (queueErr) {
          logger.debug('Queue fallback also failed', {
            error: queueErr instanceof Error ? queueErr.message : String(queueErr),
          });
        }
      }
    }

    // Invalidate alias resolver cache
    let aliasPub: RedisClient | null = null;
    try {
      const opts = resolveRedisOptionsFromEnv();
      if (!opts) throw new Error('Redis not configured');
      const handle = createRedisConnection(opts);
      aliasPub = handle.client;
      await aliasPub.publish(
        'alias-resolver:invalidate',
        JSON.stringify({ knowledgeBaseId: schemaKbId, tenantId }),
      );
    } catch (redisInvalidateErr) {
      logger.warn('Alias cache invalidation failed (non-fatal)', {
        error:
          redisInvalidateErr instanceof Error
            ? redisInvalidateErr.message
            : String(redisInvalidateErr),
      });
    } finally {
      if (aliasPub)
        aliasPub.quit().catch((quitErr: unknown) => {
          logger.debug('Redis quit error', { error: String(quitErr) });
        });
    }
  } catch (err) {
    logger.warn('saveFieldConfigInternal: schema/mapping creation failed', {
      error: err instanceof Error ? err.message : String(err),
      indexId,
    });
  }

  return {
    version: existingVersion + 1,
    mappingCount,
    vocabTriggered,
    fieldCount: fields.length,
    selectedCount: fields.filter((f: any) => f.selected !== false).length,
  };
}

// ─── Exported for testing ───────────────────────────────────────────────
export {
  extractFieldsFromSchema,
  extractSchema,
  resolveSchemaType,
  normalizeBsonType,
  saveFieldConfigInternal,
};
export type { JsonSchemaInput, JsonSchemaProperty, FieldPreview };

export default router;
