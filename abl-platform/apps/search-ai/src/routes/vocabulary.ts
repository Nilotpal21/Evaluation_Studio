/**
 * Vocabulary CRUD + Bulk Import Routes
 *
 * GET    /:indexId/vocabulary              — List vocabulary entries
 * GET    /:indexId/vocabulary/:fieldRef    — Get terms for a specific field
 * POST   /:indexId/vocabulary/review      — Bulk approve/reject terms
 * POST   /:indexId/vocabulary             — Add single entry
 * POST   /:indexId/vocabulary/bulk        — Bulk import (upsert)
 * DELETE /:indexId/vocabulary/:term       — Remove entry by term
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import type {
  ICanonicalSchema,
  IDomainVocabulary,
  IFieldMapping,
  ISearchIndex,
  IVocabularyEntry,
} from '@agent-platform/database/models';
import { getLazyModel, getDualConnection } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';

const DomainVocabulary = getLazyModel<IDomainVocabulary>('DomainVocabulary');
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');

/**
 * FieldMapping lives in the platform DB (abl_platform), not the content DB.
 * Use the platform connection directly to get the model.
 */
function getFieldMappingModel() {
  const platformConn = getDualConnection().getPlatformConnection();
  return platformConn.model<IFieldMapping>('FieldMapping');
}
import { createLogger } from '@abl/compiler/platform';
import type { RedisClient } from '@agent-platform/redis';
import { auditVocabularyUpdated } from '../services/audit-helpers.js';
import { getSharedRedisClient } from '../workers/shared.js';

const logger = createLogger('vocabulary-routes');

const VOCABULARY_INVALIDATE_CHANNEL = 'vocabulary:invalidate';

// ─── Redis Pub/Sub for cross-service cache invalidation ─────────────────────

let redisPublisher: RedisClient | null = null;

function getRedisPublisher(): RedisClient | null {
  if (!redisPublisher) {
    redisPublisher = getSharedRedisClient();
  }
  return redisPublisher;
}

/**
 * Broadcast cache invalidation to all pods (including search-ai-runtime).
 * Both search-ai and search-ai-runtime subscribe to the same Redis instance.
 */
async function invalidateVocabularyCache(indexId: string, tenantId: string): Promise<void> {
  const publisher = getRedisPublisher();
  if (!publisher) return;

  try {
    await publisher.publish(
      VOCABULARY_INVALIDATE_CHANNEL,
      JSON.stringify({ projectKbId: indexId, tenantId }),
    );
    logger.info('Vocabulary cache invalidation broadcast', { indexId, tenantId });
  } catch (error) {
    logger.error('Failed to broadcast vocabulary cache invalidation', {
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

const router: RouterType = Router();

/**
 * Extract tenantId from request, returning 401 if missing.
 * Avoids non-null assertion (req.tenantContext!) that the lint flags.
 */
function getTenantId(req: Request, res: Response): string | null {
  if (!req.tenantContext) {
    res.status(401).json({ error: 'Missing tenant context' });
    return null;
  }
  return req.tenantContext.tenantId;
}

/**
 * Strip keys that could cause prototype pollution or NoSQL injection.
 */
function sanitizeObject(obj: unknown): Record<string, unknown> {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const result: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
    if (key.startsWith('$') || key.startsWith('__')) continue;
    result[key] = value;
  }
  return result;
}

/**
 * Validate that a fieldRef (alias name) exists in the active CanonicalSchema
 * for the given SearchIndex. Returns the schema if valid, null otherwise.
 */
async function validateFieldRef(
  indexId: string,
  tenantId: string,
  fieldRef: string,
): Promise<ICanonicalSchema | null> {
  const schema = await CanonicalSchema.findOne({
    knowledgeBaseId: indexId,
    tenantId,
    status: 'active',
  })
    .sort({ version: -1 })
    .lean();

  if (!schema) return null;

  // fieldRef is the alias name (ICanonicalField.name), not storageField
  const fieldExists = (schema.fields as any[]).some((f: any) => f.name === fieldRef);
  if (!fieldExists) return null;

  return schema as ICanonicalSchema;
}

/**
 * Get or auto-create the DomainVocabulary document for an index.
 * Handles race condition: if two concurrent requests both try to create,
 * the second one catches the duplicate key error and retries the find.
 */
async function getOrCreateVocabulary(indexId: string, tenantId: string) {
  let vocab = await DomainVocabulary.findOne({ projectKnowledgeBaseId: indexId, tenantId });
  if (!vocab) {
    try {
      vocab = await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: indexId,
        version: 1,
        status: 'active',
        entries: [],
      });
    } catch (err: unknown) {
      // Handle duplicate key error from concurrent creation
      if (
        err &&
        typeof err === 'object' &&
        'code' in err &&
        (err as { code: number }).code === 11000
      ) {
        vocab = await DomainVocabulary.findOne({ projectKnowledgeBaseId: indexId, tenantId });
        if (!vocab) throw new Error('Failed to create or find vocabulary document');
      } else {
        throw err;
      }
    }
  }
  return vocab;
}

// =============================================================================
// GET /:indexId/vocabulary — List entries
// =============================================================================

router.get('/:indexId/vocabulary', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = getTenantId(req, res);
    if (!tenantId) return;

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    const vocab = await DomainVocabulary.findOne({
      projectKnowledgeBaseId: indexId,
      tenantId,
    }).lean();

    // Return empty entries if no vocabulary doc exists yet
    const entries = (vocab?.entries ?? []).map((e: IVocabularyEntry, i: number) => ({
      id: e.id || String(i),
      term: e.term,
      aliases: e.aliases,
      description: e.description,
      fieldRef: e.fieldRef,
      capabilities: e.capabilities,
      relatedFields: e.relatedFields,
      enabled: e.enabled,
      confidence: e.confidence,
      generatedBy: e.generatedBy,
    }));

    res.json({ entries, total: entries.length });
  } catch (error) {
    logger.error('Failed to list vocabulary entries', {
      indexId: req.params.indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to list vocabulary entries' });
  }
});

// =============================================================================
// GET /:indexId/vocabulary/:fieldRef — Get terms for a specific field
// =============================================================================

router.get('/:indexId/vocabulary/:fieldRef', async (req: Request, res: Response) => {
  try {
    const { indexId, fieldRef } = req.params;
    const tenantId = getTenantId(req, res);
    if (!tenantId) return;

    // Validate SearchIndex exists and belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Index not found' } });
    }

    // Validate fieldRef exists in CanonicalSchema
    const schema = await validateFieldRef(indexId, tenantId, fieldRef);
    if (!schema) {
      return res
        .status(404)
        .json({ error: { code: 'FIELD_NOT_FOUND', message: 'fieldRef not found in schema' } });
    }

    // Fetch vocabulary document
    const vocab = await DomainVocabulary.findOne({
      projectKnowledgeBaseId: indexId,
      tenantId,
    }).lean();

    // Filter entries by fieldRef, sort by confidence desc then usageCount desc
    const filtered = (vocab?.entries ?? [])
      .filter((e: IVocabularyEntry) => e.fieldRef === fieldRef)
      .sort((a: IVocabularyEntry, b: IVocabularyEntry) => {
        const confDiff = (b.confidence ?? 0) - (a.confidence ?? 0);
        if (confDiff !== 0) return confDiff;
        return (b.usageCount ?? 0) - (a.usageCount ?? 0);
      })
      .map((e: IVocabularyEntry) => ({
        id: e.id,
        term: e.term,
        aliases: e.aliases,
        description: e.description,
        fieldRef: e.fieldRef,
        capabilities: e.capabilities,
        relatedFields: e.relatedFields,
        enabled: e.enabled,
        confidence: e.confidence ?? null,
        generatedBy: e.generatedBy,
        usageCount: e.usageCount ?? 0,
        lastUsed: e.lastUsed ?? null,
        createdAt: e.createdAt ?? null,
        updatedAt: e.updatedAt ?? null,
      }));

    res.json({ entries: filtered, total: filtered.length, fieldRef });
  } catch (error) {
    logger.error('Failed to get vocabulary entries by fieldRef', {
      indexId: req.params.indexId,
      fieldRef: req.params.fieldRef,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get vocabulary entries' },
    });
  }
});

// =============================================================================
// POST /:indexId/vocabulary/review — Bulk approve/reject terms
// =============================================================================

router.post('/:indexId/vocabulary/review', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = getTenantId(req, res);
    if (!tenantId) return;
    const { action, termIds } = req.body;

    // Validate action
    if (!action || !['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        error: { code: 'INVALID_ACTION', message: 'action must be approve or reject' },
      });
    }

    // Validate termIds
    if (!termIds || !Array.isArray(termIds) || termIds.length === 0) {
      return res.status(400).json({
        error: { code: 'INVALID_TERM_IDS', message: 'termIds must be a non-empty array' },
      });
    }

    if (termIds.length > 500) {
      return res.status(400).json({
        error: { code: 'TOO_MANY_TERMS', message: 'termIds array must not exceed 500 items' },
      });
    }

    // Validate SearchIndex exists and belongs to tenant
    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Index not found' } });
    }

    // Fetch vocabulary document (mutable — need to save)
    const vocab = await DomainVocabulary.findOne({
      projectKnowledgeBaseId: indexId,
      tenantId,
    });

    if (!vocab) {
      return res
        .status(404)
        .json({ error: { code: 'NOT_FOUND', message: 'Vocabulary not found' } });
    }

    // Build a lookup set of requested term IDs
    const requestedIds = new Set(termIds as string[]);

    // Track which IDs were actually found and updated
    const updatedIds: string[] = [];
    const newEnabled = action === 'approve';

    for (const entry of vocab.entries as IVocabularyEntry[]) {
      if (requestedIds.has(entry.id)) {
        entry.enabled = newEnabled;
        (entry as any).updatedAt = new Date();
        updatedIds.push(entry.id);
      }
    }

    // Check if any requested IDs were not found
    const updatedSet = new Set(updatedIds);
    const notFoundIds = termIds.filter((id: string) => !updatedSet.has(id));
    if (updatedIds.length === 0) {
      return res.status(404).json({
        error: { code: 'TERMS_NOT_FOUND', message: 'No matching term IDs found' },
      });
    }

    await vocab.save();

    // Invalidate cache across all pods
    await invalidateVocabularyCache(indexId, tenantId);

    // Audit logging
    const userId = (req as any).userId || 'user';
    auditVocabularyUpdated({
      tenantId,
      userId,
      projectKnowledgeBaseId: indexId,
      version: vocab.version ?? 1,
      entryCount: vocab.entries.length,
    });

    logger.info('Vocabulary review completed', {
      tenantId,
      indexId,
      action,
      updatedCount: updatedIds.length,
      userId,
    });

    res.json({
      success: true,
      action,
      updatedCount: updatedIds.length,
      updatedIds,
      notFoundIds: notFoundIds.length > 0 ? notFoundIds : undefined,
    });
  } catch (error) {
    logger.error('Failed to review vocabulary terms', {
      indexId: req.params.indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Failed to review vocabulary terms' },
    });
  }
});

// =============================================================================
// POST /:indexId/vocabulary — Add single entry
// =============================================================================

router.post('/:indexId/vocabulary', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = getTenantId(req, res);
    if (!tenantId) return;
    const { term, aliases, description, fieldRef, capabilities, relatedFields } = req.body;

    if (!term) {
      res.status(400).json({ error: 'term is required' });
      return;
    }

    if (!fieldRef) {
      res.status(400).json({ error: 'fieldRef is required' });
      return;
    }

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    const vocab = await getOrCreateVocabulary(indexId, tenantId);

    // Generate unique ID for the entry
    const entryId = `entry_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`;

    const entry: IVocabularyEntry = {
      id: entryId,
      term: String(term).trim(),
      aliases: Array.isArray(aliases) ? aliases.map(String) : [],
      description: description ? String(description) : undefined,
      fieldRef: String(fieldRef).trim(),
      capabilities: capabilities || {
        canFilter: true,
        canDisplay: true,
        canAggregate: false,
        canSort: false,
      },
      relatedFields: relatedFields || {
        displayWith: [],
        aggregateWith: [],
      },
      enabled: true,
      generatedBy: 'manual',
      createdAt: new Date(),
      updatedAt: new Date(),
    };

    vocab.entries.push(entry);
    await vocab.save();

    // Ensure the referenced field has an active mapping in the Fields tab.
    // When a vocab entry references a canonical field, that field should appear
    // in My Fields so users can filter/sort/aggregate by it.
    try {
      const schema = await CanonicalSchema.findOne({
        knowledgeBaseId: indexId,
        tenantId,
        status: 'active',
      })
        .sort({ version: -1 })
        .lean();

      if (schema) {
        const schemaId = String(schema._id);
        const fieldName = String(fieldRef).trim();
        const FM = getFieldMappingModel();

        // Check if an active mapping already exists for this field
        const existingActive = await FM.findOne({
          canonicalSchemaId: schemaId,
          canonicalField: fieldName,
          tenantId,
          status: 'active',
        }).lean();

        if (!existingActive) {
          // Try to promote an existing auto-applied mapping to active
          const promoted = await FM.findOneAndUpdate(
            {
              canonicalSchemaId: schemaId,
              canonicalField: fieldName,
              tenantId,
              status: 'auto-applied',
            },
            {
              $set: {
                status: 'active',
                suggestedBy: 'vocabulary',
                reviewedBy: 'vocabulary-auto',
                reviewedAt: new Date(),
              },
            },
            { new: true },
          ).lean();

          if (promoted) {
            logger.info('Promoted field mapping to active via vocabulary entry', {
              fieldRef: fieldName,
              schemaId,
              mappingId: String(promoted._id),
            });
          } else {
            // No auto-applied mapping exists — create one
            const schemaField = (schema.fields as any[]).find((f: any) => f.name === fieldName);
            if (schemaField) {
              await FM.create({
                tenantId,
                canonicalSchemaId: schemaId,
                canonicalField: fieldName,
                connectorId: 'manual-upload',
                sourcePath: schemaField.storageField || fieldName,
                transform: { type: 'direct' },
                confidence: 1.0,
                status: 'active',
                suggestedBy: 'vocabulary',
                reviewedBy: 'vocabulary-auto',
                reviewedAt: new Date(),
              });
              logger.info('Created active field mapping via vocabulary entry', {
                fieldRef: fieldName,
                schemaId,
              });
            }
          }
        }
      }
    } catch (mappingErr) {
      // Non-fatal: vocab entry still created, mapping activation is best-effort
      logger.warn('Failed to activate field mapping for vocabulary entry', {
        fieldRef,
        error: mappingErr instanceof Error ? mappingErr.message : String(mappingErr),
      });
    }

    // Invalidate cache across all pods (including search-ai-runtime)
    await invalidateVocabularyCache(indexId, tenantId);

    // Audit log
    auditVocabularyUpdated({
      tenantId,
      userId: (req as any).userId,
      projectKnowledgeBaseId: indexId,
      version: vocab.version ?? 1,
      entryCount: vocab.entries.length,
    });

    res.status(201).json({ entry, index: vocab.entries.length - 1 });
  } catch (error) {
    logger.error('Failed to add vocabulary entry', {
      indexId: req.params.indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to add vocabulary entry' });
  }
});

// =============================================================================
// POST /:indexId/vocabulary/bulk — Bulk import (upsert by term)
// =============================================================================

router.post('/:indexId/vocabulary/bulk', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const tenantId = getTenantId(req, res);
    if (!tenantId) return;
    const { entries } = req.body;

    if (!Array.isArray(entries) || entries.length === 0) {
      res.status(400).json({ error: 'entries array is required and must not be empty' });
      return;
    }

    if (entries.length > 500) {
      res.status(400).json({ error: 'Maximum 500 vocabulary entries per bulk import' });
      return;
    }

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: 'Index not found' });
      return;
    }

    const vocab = await getOrCreateVocabulary(indexId, tenantId);

    // Build a map of existing entries by term for upsert
    const existingByTerm = new Map<string, number>();
    vocab.entries.forEach((e: IVocabularyEntry, i: number) =>
      existingByTerm.set(e.term.toLowerCase(), i),
    );

    let imported = 0;
    for (const entry of entries) {
      if (!entry.term) continue;

      // Validate required fields for bulk import
      if (!entry.fieldRef) {
        logger.warn('Skipping entry without fieldRef in bulk import', { term: entry.term });
        continue;
      }

      const existingIdx = existingByTerm.get(String(entry.term).trim().toLowerCase());
      const now = new Date();

      const normalized: IVocabularyEntry = {
        id: entry.id || `entry_${Date.now()}_${Math.random().toString(36).substring(2, 9)}`,
        term: String(entry.term).trim(),
        aliases: Array.isArray(entry.aliases) ? entry.aliases.map(String) : [],
        description: entry.description ? String(entry.description) : undefined,
        fieldRef: String(entry.fieldRef).trim(),
        capabilities: entry.capabilities || {
          canFilter: true,
          canDisplay: true,
          canAggregate: false,
          canSort: false,
        },
        relatedFields: entry.relatedFields || {
          displayWith: [],
          aggregateWith: [],
        },
        enabled: entry.enabled !== false,
        generatedBy: entry.generatedBy || 'manual',
        confidence: entry.confidence,
        usageCount: entry.usageCount,
        lastUsed: entry.lastUsed,
        createdAt: entry.createdAt || now,
        updatedAt: now,
      };

      if (existingIdx !== undefined) {
        // Update existing entry (preserve createdAt from original)
        const existing = vocab.entries[existingIdx];
        normalized.createdAt = existing.createdAt || now;
        vocab.entries[existingIdx] = normalized;
      } else {
        // Add new entry
        vocab.entries.push(normalized);
        existingByTerm.set(normalized.term.toLowerCase(), vocab.entries.length - 1);
      }
      imported++;
    }

    await vocab.save();

    // Invalidate cache across all pods (including search-ai-runtime)
    await invalidateVocabularyCache(indexId, tenantId);

    // Audit log
    auditVocabularyUpdated({
      tenantId,
      userId: (req as any).userId,
      projectKnowledgeBaseId: indexId,
      version: vocab.version ?? 1,
      entryCount: vocab.entries.length,
    });

    res.json({ imported, total: vocab.entries.length });
  } catch (error) {
    logger.error('Bulk vocabulary import failed', {
      indexId: req.params.indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Bulk import failed' });
  }
});

// =============================================================================
// POST /:indexId/vocabulary/test — Test vocabulary resolution against a query
// =============================================================================

router.post('/:indexId/vocabulary/test', async (req: Request, res: Response) => {
  try {
    const { indexId } = req.params;
    const { query, entryIds } = req.body;

    if (!query || typeof query !== 'string') {
      res.status(400).json({ error: 'query field is required and must be a string' });
      return;
    }

    const tenantId = getTenantId(req, res);
    if (!tenantId) return;
    const vocab = await DomainVocabulary.findOne({ projectKnowledgeBaseId: indexId, tenantId });
    if (!vocab) {
      res.status(404).json({ error: 'Vocabulary not found for this index' });
      return;
    }

    // Filter entries if entryIds provided
    const entries: IVocabularyEntry[] = entryIds?.length
      ? vocab.entries.filter((e: IVocabularyEntry) => entryIds.includes(e.id))
      : vocab.entries;

    // Keyword matching: find entries whose term or aliases appear in the query
    const queryLower = query.toLowerCase();
    const matches = entries.filter((e: IVocabularyEntry) => {
      const termMatch = queryLower.includes(e.term.toLowerCase());
      const aliasMatch = e.aliases?.some((alias: string) =>
        queryLower.includes(alias.toLowerCase()),
      );
      return termMatch || aliasMatch;
    });

    const resolutions = matches.map((entry: IVocabularyEntry) => {
      // Determine which token matched
      const matchedToken = queryLower.includes(entry.term.toLowerCase())
        ? entry.term
        : entry.aliases?.find((a: string) => queryLower.includes(a.toLowerCase())) || entry.term;

      return {
        term: entry.term,
        entryId: entry.id,
        fieldRef: entry.fieldRef,
        matchType: queryLower.includes(entry.term.toLowerCase()) ? 'term' : 'alias',
        matchedToken,
        resolvedAs: 'filter',
        confidence: 0.9,
        reasoning: `Keyword "${matchedToken}" found in query`,
        matchedEntry: {
          id: entry.id,
          term: entry.term,
          fieldRef: entry.fieldRef,
          aliases: entry.aliases,
          capabilities: entry.capabilities,
        },
        resolvedFields: [entry.fieldRef, ...(entry.relatedFields?.displayWith?.slice(0, 3) || [])],
      };
    });

    logger.info('Vocabulary test resolution', {
      indexId,
      query,
      matchCount: resolutions.length,
    });

    res.json({
      query,
      resolutions,
      unresolvedSegments: [],
      suggestions:
        resolutions.length === 0 ? ['No matching vocabulary entries found for this query'] : [],
    });
  } catch (error) {
    logger.error('Failed to test vocabulary resolution', {
      indexId: req.params.indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to test vocabulary resolution' });
  }
});

// =============================================================================
// DELETE /:indexId/vocabulary/:termOrId — Remove entry by ID or term
// =============================================================================

router.delete('/:indexId/vocabulary/:termOrId', async (req: Request, res: Response) => {
  try {
    const { indexId, termOrId } = req.params;
    const decoded = decodeURIComponent(termOrId);

    if (!decoded) {
      res.status(400).json({ error: { code: 'INVALID_INPUT', message: 'Invalid term or ID' } });
      return;
    }

    const tenantId = getTenantId(req, res);
    if (!tenantId) return;
    const vocab = await DomainVocabulary.findOne({ projectKnowledgeBaseId: indexId, tenantId });
    if (!vocab) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Vocabulary not found' } });
      return;
    }

    // Try to find by entry ID first, then fall back to term name
    let idx = vocab.entries.findIndex((e: IVocabularyEntry) => e.id === decoded);
    if (idx === -1) {
      const termLower = decoded.toLowerCase();
      idx = vocab.entries.findIndex((e: IVocabularyEntry) => e.term.toLowerCase() === termLower);
    }

    if (idx === -1) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Entry not found' } });
      return;
    }

    vocab.entries.splice(idx, 1);
    await vocab.save();

    // Invalidate cache across all pods (including search-ai-runtime)
    await invalidateVocabularyCache(indexId, tenantId);

    // Audit log
    auditVocabularyUpdated({
      tenantId,
      userId: (req as any).userId,
      projectKnowledgeBaseId: indexId,
      version: vocab.version ?? 1,
      entryCount: vocab.entries.length,
    });

    res.json({ deleted: true, total: vocab.entries.length });
  } catch (error) {
    logger.error('Failed to delete vocabulary entry', {
      indexId: req.params.indexId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to delete vocabulary entry' });
  }
});

// =============================================================================
// PATCH /:indexId/vocabulary/:entryId/toggle — Toggle entry enabled/disabled
// =============================================================================

router.patch('/:indexId/vocabulary/:entryId/toggle', async (req: Request, res: Response) => {
  try {
    const { indexId, entryId } = req.params;
    const { enabled } = req.body;

    if (typeof enabled !== 'boolean') {
      res
        .status(400)
        .json({ error: { code: 'INVALID_INPUT', message: 'enabled must be a boolean' } });
      return;
    }

    const tenantId = getTenantId(req, res);
    if (!tenantId) return;

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Index not found' } });
      return;
    }

    const vocab = await DomainVocabulary.findOne({
      projectKnowledgeBaseId: indexId,
      tenantId,
    });

    if (!vocab) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Vocabulary not found' } });
      return;
    }

    const entry = vocab.entries.find((e: IVocabularyEntry) => e.id === entryId);
    if (!entry) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Entry not found' } });
      return;
    }

    entry.enabled = enabled;
    (entry as any).updatedAt = new Date();
    await vocab.save();

    await invalidateVocabularyCache(indexId, tenantId);

    auditVocabularyUpdated({
      tenantId,
      userId: (req as any).userId,
      projectKnowledgeBaseId: indexId,
      version: vocab.version ?? 1,
      entryCount: vocab.entries.length,
    });

    res.json({ entry, message: `Entry ${enabled ? 'enabled' : 'disabled'}` });
  } catch (error) {
    logger.error('Failed to toggle vocabulary entry', {
      indexId: req.params.indexId,
      entryId: req.params.entryId,
      error: error instanceof Error ? error.message : String(error),
    });
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to toggle vocabulary entry' } });
  }
});

// =============================================================================
// PUT /:indexId/vocabulary/:entryId — Update vocabulary entry by ID
// =============================================================================

router.put('/:indexId/vocabulary/:entryId', async (req: Request, res: Response) => {
  try {
    const { indexId, entryId } = req.params;
    const tenantId = getTenantId(req, res);
    if (!tenantId) return;

    const index = await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: indexId, tenantId }, req.tenantContext!),
    ).lean();
    if (!index) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Index not found' } });
      return;
    }

    const vocab = await DomainVocabulary.findOne({
      projectKnowledgeBaseId: indexId,
      tenantId,
    });

    if (!vocab) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Vocabulary not found' } });
      return;
    }

    const entry = vocab.entries.find((e: IVocabularyEntry) => e.id === entryId);
    if (!entry) {
      res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Entry not found' } });
      return;
    }

    // Update mutable fields (term and fieldRef are immutable)
    const { aliases, description, capabilities, relatedFields, enabled } = req.body;

    if (aliases !== undefined) {
      entry.aliases = Array.isArray(aliases) ? aliases.map(String) : entry.aliases;
    }
    if (description !== undefined) {
      entry.description = String(description);
    }
    if (capabilities !== undefined) {
      entry.capabilities = {
        canFilter: capabilities.canFilter ?? entry.capabilities.canFilter,
        canDisplay: capabilities.canDisplay ?? entry.capabilities.canDisplay,
        canAggregate: capabilities.canAggregate ?? entry.capabilities.canAggregate,
        canSort: capabilities.canSort ?? entry.capabilities.canSort,
      };
    }
    if (relatedFields !== undefined) {
      entry.relatedFields = {
        displayWith: Array.isArray(relatedFields.displayWith)
          ? relatedFields.displayWith.map(String)
          : entry.relatedFields.displayWith,
        aggregateWith: Array.isArray(relatedFields.aggregateWith)
          ? relatedFields.aggregateWith.map(String)
          : entry.relatedFields.aggregateWith,
      };
    }
    if (typeof enabled === 'boolean') {
      entry.enabled = enabled;
    }

    (entry as any).updatedAt = new Date();
    await vocab.save();

    await invalidateVocabularyCache(indexId, tenantId);

    auditVocabularyUpdated({
      tenantId,
      userId: (req as any).userId,
      projectKnowledgeBaseId: indexId,
      version: vocab.version ?? 1,
      entryCount: vocab.entries.length,
    });

    res.json({ entry, message: 'Entry updated' });
  } catch (error) {
    logger.error('Failed to update vocabulary entry', {
      indexId: req.params.indexId,
      entryId: req.params.entryId,
      error: error instanceof Error ? error.message : String(error),
    });
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to update vocabulary entry' } });
  }
});

export default router;
