/**
 * Document Vocabulary Generator
 *
 * Generates vocabulary entries for document uploads based on user-filled metadata fields.
 * NO LLM - uses static aliases from document-field-vocabulary.ts for core fields,
 * and generates basic entries (field name only) for custom fields.
 *
 * Key behaviors:
 * 1. Only caller-provided fields get entries (including mime_type/source_type)
 * 2. Core fields (author, category, etc.) → rich aliases from static definitions
 * 3. Custom fields (custom_string_1, etc.) → basic entry with field name only
 * 4. Empty fields → no vocabulary entry (prevents noise)
 */

import { createLogger } from '@abl/compiler/platform';
import { uuidv7 } from '@agent-platform/database/mongo';
import { getLazyModel } from '../db/index.js';
import {
  getDocumentFieldVocabulary,
  hasDocumentVocabulary,
} from '@agent-platform/search-ai-internal/canonical';
import type { IDomainVocabulary, IVocabularyEntry } from '@agent-platform/database';

const logger = createLogger('document-vocabulary-generator');
const DomainVocabularyModel = getLazyModel<IDomainVocabulary>('DomainVocabulary');

/**
 * Generate vocabulary entries for user-filled document metadata fields.
 *
 * @param metadata - User-provided metadata from upload form
 * @returns Array of vocabulary entries (core fields + custom fields)
 */
export function generateDocumentVocabularyEntries(
  metadata: Record<string, unknown>,
): IVocabularyEntry[] {
  const entries: IVocabularyEntry[] = [];

  // Start with an empty set — only user-provided fields get vocabulary entries.
  // The caller passes mime_type and source_type explicitly via metadata
  // when they should be included.
  const fieldsToProcess = new Set<string>();

  // Add all user-filled fields (non-empty values)
  for (const [key, value] of Object.entries(metadata)) {
    // Skip empty values
    if (value === null || value === undefined) continue;
    if (typeof value === 'string' && value.trim() === '') continue;
    if (Array.isArray(value) && value.length === 0) continue;

    // Skip internal/system fields
    if (key.startsWith('_') || key === 'tenantId' || key === 'indexId') continue;

    fieldsToProcess.add(key);
  }

  logger.info('Generating vocabulary for document metadata fields', {
    totalFields: fieldsToProcess.size,
    fields: Array.from(fieldsToProcess),
  });

  // Generate vocabulary entries
  for (const fieldRef of fieldsToProcess) {
    const definition = getDocumentFieldVocabulary(fieldRef);

    if (definition) {
      // ✅ Core field with rich aliases (from static definitions)
      entries.push({
        id: uuidv7(),
        term: definition.term.toLowerCase(),
        aliases: definition.aliases,
        description: definition.description,
        fieldRef: definition.fieldRef,
        capabilities: {
          canFilter: true,
          canDisplay: true,
          canAggregate: true,
          canSort: true,
        },
        relatedFields: {
          displayWith: [],
          aggregateWith: [],
        },
        enabled: true,
        confidence: 1.0,
        generatedBy: 'static',
      });

      logger.info('Created core field vocabulary entry', {
        fieldRef: definition.fieldRef,
        aliasCount: definition.aliases.length,
      });
    } else {
      // ✅ Custom/other field - create basic entry with no aliases
      const humanLabel = generateHumanLabel(fieldRef);

      entries.push({
        id: uuidv7(),
        term: humanLabel.toLowerCase(),
        aliases: [humanLabel.toLowerCase()], // Just the field name, no synonyms
        description: `Custom field: ${humanLabel}`,
        fieldRef: fieldRef,
        capabilities: {
          canFilter: true,
          canDisplay: true,
          canAggregate: true,
          canSort: true,
        },
        relatedFields: {
          displayWith: [],
          aggregateWith: [],
        },
        enabled: true,
        confidence: 0.7, // Lower confidence for auto-generated
        generatedBy: 'auto',
      });

      logger.info('Created custom field vocabulary entry', {
        fieldRef,
        humanLabel,
      });
    }
  }

  return entries;
}

/**
 * Generate human-readable label from field name.
 * Examples:
 *   custom_string_1 → Custom String 1
 *   myField → My Field
 *   InternalID → Internal ID
 */
function generateHumanLabel(fieldRef: string): string {
  return (
    fieldRef
      .replace(/_/g, ' ') // Replace underscores with spaces
      .replace(/([A-Z])/g, ' $1') // Add space before capitals
      .trim()
      .split(' ')
      // Capitalize each word
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
      .join(' ')
  );
}

/**
 * Upsert vocabulary entries for document uploads into DomainVocabulary.
 * Merges with existing entries (keeps manual, replaces auto-generated for same fields).
 *
 * @param tenantId - Tenant ID
 * @param knowledgeBaseId - Knowledge base / index ID
 * @param entries - New vocabulary entries to add/update
 */
export async function upsertDocumentVocabulary(
  tenantId: string,
  knowledgeBaseId: string,
  entries: IVocabularyEntry[],
): Promise<void> {
  if (entries.length === 0) {
    logger.info('No vocabulary entries to upsert', { knowledgeBaseId });
    return;
  }

  try {
    const existing = await DomainVocabularyModel.findOne({
      projectKnowledgeBaseId: knowledgeBaseId,
      tenantId,
    });

    if (existing) {
      // Merge strategy:
      // 1. Keep all manual entries (user-created, generatedBy 'manual')
      // 2. Replace ALL auto/static entries with the new set — this ensures
      //    stale entries from old seeders get cleaned up automatically.
      // 3. Add new entries

      const manualEntries = existing.entries.filter(
        (e: IVocabularyEntry) => e.generatedBy === 'manual',
      );

      const merged = [...manualEntries, ...entries];
      existing.entries = merged;
      existing.version += 1;
      existing.updatedAt = new Date();
      await existing.save();

      logger.info('Updated vocabulary with document metadata entries', {
        knowledgeBaseId,
        vocabularyId: existing._id,
        newEntries: entries.length,
        manualKept: manualEntries.length,
        totalEntries: merged.length,
      });
    } else {
      // Create new vocabulary with document entries
      await DomainVocabularyModel.create({
        tenantId,
        projectKnowledgeBaseId: knowledgeBaseId,
        version: 1,
        status: 'active',
        entries,
      });

      logger.info('Created vocabulary with document metadata entries', {
        knowledgeBaseId,
        entryCount: entries.length,
      });
    }
  } catch (error) {
    logger.error('Failed to upsert document vocabulary', {
      error: error instanceof Error ? error.message : String(error),
      knowledgeBaseId,
      entryCount: entries.length,
    });
    throw error;
  }
}

/**
 * Register fields in CanonicalSchema + FieldMappings (Fields tab).
 * Called BEFORE vocab — Fields is source of truth.
 */
export async function registerDocumentFields(
  tenantId: string,
  knowledgeBaseId: string,
  fieldNames: string[],
): Promise<void> {
  if (fieldNames.length === 0) return;
  const { getAvailableField, toCanonicalField } =
    await import('@agent-platform/search-ai-internal/canonical');
  const CanonicalSchemaModel = getLazyModel('CanonicalSchema');
  const FieldMappingModel = getLazyModel('FieldMapping');
  let schema: any = await CanonicalSchemaModel.findOne({
    knowledgeBaseId,
    tenantId,
    status: 'active',
  }).sort({ version: -1 });
  if (!schema) {
    schema = await CanonicalSchemaModel.create({
      tenantId,
      knowledgeBaseId,
      version: 1,
      fields: [],
      status: 'active',
    });
  }
  const existingStorage = new Set<string>(
    ((schema.fields as Array<{ storageField: string }>) || []).map((f) => f.storageField),
  );
  const newFields: Array<Record<string, unknown>> = [];
  for (const name of fieldNames) {
    const avail = getAvailableField(name);
    if (avail && !existingStorage.has(avail.storageField)) {
      newFields.push(toCanonicalField(avail) as unknown as Record<string, unknown>);
      existingStorage.add(avail.storageField);
    }
  }
  if (newFields.length > 0) {
    await CanonicalSchemaModel.findOneAndUpdate(
      { _id: schema._id, tenantId },
      { $push: { fields: { $each: newFields } } },
    );
  }
  const connectorId = `manual-upload:${knowledgeBaseId}`;
  const existingMaps = await FieldMappingModel.find({
    canonicalSchemaId: String(schema._id),
    tenantId,
    connectorId,
  }).lean();
  const mapped = new Set<string>(
    (existingMaps as unknown as Array<{ canonicalField: string }>).map((m) => m.canonicalField),
  );
  const toCreate: Array<Record<string, unknown>> = [];
  for (const name of fieldNames) {
    const avail = getAvailableField(name);
    if (avail && !mapped.has(avail.storageField)) {
      toCreate.push({
        tenantId,
        canonicalSchemaId: String(schema._id),
        canonicalField: avail.storageField,
        connectorId,
        sourcePath: avail.storageField,
        transform: { type: 'direct' },
        confidence: 1.0,
        status: 'active',
        suggestedBy: 'system',
        reviewedBy: 'system',
        reviewedAt: new Date(),
      });
    }
  }
  if (toCreate.length > 0) {
    await FieldMappingModel.insertMany(toCreate, { ordered: false }).catch((e: unknown) => {
      logger.warn('FieldMapping insert partial fail', {
        error: e instanceof Error ? e.message : String(e),
      });
    });
  }
  logger.info('Registered document fields', {
    knowledgeBaseId,
    newSchema: newFields.length,
    newMappings: toCreate.length,
  });
}
