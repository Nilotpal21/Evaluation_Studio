/**
 * Mapping Routes
 *
 * Field mapping management between connector schemas and canonical schemas.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import type {
  IFieldMapping,
  ICanonicalSchema,
  IConnectorSchema,
  IDiscoveredSchema,
  IConnectorConfig,
  ISearchIndex,
  IKnowledgeBase,
} from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';
import { getCanonicalMapperService } from '../services/canonical-mapping/index.js';
import { applyProjectScopeFilter } from './project-scope.js';

const FieldMapping = getLazyModel<IFieldMapping>('FieldMapping');
const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');
const ConnectorSchema = getLazyModel<IConnectorSchema>('ConnectorSchema');
const DiscoveredSchema = getLazyModel<IDiscoveredSchema>('DiscoveredSchema');
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const SearchIndex = getLazyModel<ISearchIndex>('SearchIndex');
const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase');
import { mappingSuggestionService } from '../services/mapping-suggestion/index.js';
import { batchReviewService } from '../services/mapping-review/index.js';
import { createLogger } from '@abl/compiler/platform';
import { searchAiRateLimit } from '../middleware/rate-limit.js';
import { queueAuditEntry } from '../services/connector-audit.service.js';

const router: RouterType = Router();
const logger = createLogger('mappings-routes');

type MappingAuditOperation =
  | 'confirm'
  | 'reject'
  | 'batch_confirm'
  | 'batch_needs_review'
  | 'batch_reject'
  | 'update'
  | 'manual_create'
  | 'bulk_action'
  | 'delete';

interface MappingAuditTarget {
  connectorId: string;
  mappingId: string;
  canonicalSchemaId?: string;
  canonicalField?: string;
  sourcePath?: string;
}

interface MappingListRow extends Record<string, unknown> {
  _id: string;
  connectorId: string;
  canonicalField?: string | null;
}

interface ConnectorTypeRow {
  _id: string;
  connectorType?: string | null;
}

interface MappingAuditRow {
  _id: string;
  connectorId: string;
  canonicalSchemaId?: string | null;
  canonicalField?: string | null;
  sourcePath?: string | null;
}

async function findProjectScopedCanonicalSchemaById(
  schemaId: string,
  tenantId: string,
  tenantContext: NonNullable<Request['tenantContext']>,
): Promise<ICanonicalSchema | null> {
  const schema = await CanonicalSchema.findOne({ _id: schemaId, tenantId }).lean();
  if (!schema?.knowledgeBaseId) {
    return null;
  }

  if (!tenantContext.projectId && !tenantContext.projectScope?.length) {
    return schema;
  }

  const indexById = await SearchIndex.findOne(
    applyProjectScopeFilter(
      {
        _id: String(schema.knowledgeBaseId),
        tenantId,
      },
      tenantContext,
    ),
  )
    .select('_id')
    .lean();
  if (indexById) {
    return schema;
  }

  const knowledgeBase = await KnowledgeBase.findOne(
    applyProjectScopeFilter(
      {
        _id: String(schema.knowledgeBaseId),
        tenantId,
      },
      tenantContext,
    ),
  )
    .select('_id searchIndexId')
    .lean();

  if (!knowledgeBase) {
    return null;
  }

  const searchIndexId = (knowledgeBase as { searchIndexId?: string | null }).searchIndexId;
  if (!searchIndexId) {
    return schema;
  }

  const linkedIndex = await SearchIndex.findOne(
    applyProjectScopeFilter({ _id: searchIndexId, tenantId }, tenantContext),
  )
    .select('_id')
    .lean();

  return linkedIndex ? schema : null;
}

function getAuditActor(userId?: string): { actor: string; actorType: 'user' | 'system' } {
  if (typeof userId === 'string' && userId.length > 0 && userId !== 'system') {
    return { actor: userId, actorType: 'user' };
  }
  return { actor: 'system', actorType: 'system' };
}

function queueMappingAuditEvent(
  operation: MappingAuditOperation,
  tenantId: string,
  userId: string | undefined,
  targets: MappingAuditTarget[],
  details?: Record<string, unknown>,
): void {
  if (targets.length === 0) {
    return;
  }

  const groupedTargets = new Map<string, MappingAuditTarget[]>();
  for (const target of targets) {
    const existing = groupedTargets.get(target.connectorId) ?? [];
    existing.push(target);
    groupedTargets.set(target.connectorId, existing);
  }

  const { actor, actorType } = getAuditActor(userId);

  for (const [connectorId, connectorTargets] of groupedTargets) {
    queueAuditEntry({
      connectorId,
      tenantId,
      actor,
      actorType,
      event: `mapping.${operation}`,
      category: 'config',
      metadata: {
        mappingIds: connectorTargets.map((target) => target.mappingId),
        mappingCount: connectorTargets.length,
        mappings: connectorTargets.map((target) => ({
          mappingId: target.mappingId,
          canonicalSchemaId: target.canonicalSchemaId ?? null,
          canonicalField: target.canonicalField ?? null,
          sourcePath: target.sourcePath ?? null,
        })),
        ...(details ?? {}),
      },
    });
  }
}

/**
 * GET / - List field mappings
 *
 * Query params:
 *   - schemaId: Filter by canonical schema ID
 *   - connectorId: Filter by connector ID
 *   - status: Filter by status (suggested, confirmed, rejected)
 *   - includeSystemFields: If true and status=active, includes system-populated fields
 */
router.get('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { schemaId, connectorId, status, includeSystemFields } = req.query;
    const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
    const skip = parseInt(req.query.skip as string) || 0;

    let scopedSchema: ICanonicalSchema | null = null;
    if (typeof schemaId === 'string') {
      scopedSchema = await findProjectScopedCanonicalSchemaById(
        schemaId,
        tenantId,
        req.tenantContext!,
      );
      if (!scopedSchema) {
        res.status(404).json({ error: 'Canonical schema not found' });
        return;
      }
    }

    const filter: Record<string, unknown> = { tenantId };
    if (schemaId) filter.canonicalSchemaId = schemaId;
    if (connectorId) filter.connectorId = connectorId;
    if (status) filter.status = status;

    const [mappings, total] = await Promise.all([
      FieldMapping.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limit).lean(),
      FieldMapping.countDocuments(filter),
    ]);

    // Enrich mappings with alias names + connector info
    let enrichedMappings = mappings as MappingListRow[];

    // Build alias map from CanonicalSchema
    if (schemaId) {
      const schema = scopedSchema;
      if (schema?.fields) {
        const aliasMap = new Map<string, { alias: string; label: string }>();
        for (const f of schema.fields as any[]) {
          if (f.storageField) {
            aliasMap.set(f.storageField, { alias: f.name, label: f.label });
          }
        }
        enrichedMappings = enrichedMappings.map((mapping) => {
          const aliasInfo = aliasMap.get(mapping.canonicalField ?? '');
          return {
            ...mapping,
            aliasName: aliasInfo?.alias ?? null,
            aliasLabel: aliasInfo?.label ?? null,
          };
        });
      }
    }

    // Build connector info map from ConnectorConfig
    const connectorIds = [...new Set(enrichedMappings.map((mapping) => mapping.connectorId))];
    if (connectorIds.length > 0) {
      const connectors = await ConnectorConfig.find(
        { _id: { $in: connectorIds }, tenantId },
        { _id: 1, connectorType: 1 },
      ).lean<ConnectorTypeRow[]>();
      const connectorMap = new Map(
        connectors.map((connector) => [connector._id, connector.connectorType ?? null]),
      );
      enrichedMappings = enrichedMappings.map((mapping) => ({
        ...mapping,
        connectorType: connectorMap.get(mapping.connectorId) ?? null,
      }));
    }

    // Add system-populated fields for manual uploads if requested
    let finalTotal = total;
    if (includeSystemFields === 'true' && status === 'active' && schemaId) {
      logger.info('[SYSTEM-FIELDS] Checking for system fields', { schemaId, status });
      // Try by _id first, then by knowledgeBaseId (schema lookup)
      let schema = scopedSchema;
      if (!schema) {
        const index = await SearchIndex.findOne(
          applyProjectScopeFilter({ _id: schemaId, tenantId }, req.tenantContext!),
        )
          .select('_id documentCount')
          .lean();
        schema = index
          ? await CanonicalSchema.findOne({ knowledgeBaseId: schemaId, tenantId }).lean()
          : null;
        logger.info('[SYSTEM-FIELDS] Schema lookup by knowledgeBaseId', { found: !!schema });
      } else {
        logger.info('[SYSTEM-FIELDS] Schema found by _id', { schemaId: String(schema._id) });
      }

      if (schema) {
        const index = (await SearchIndex.findOne(
          applyProjectScopeFilter({ _id: schema.knowledgeBaseId, tenantId }, req.tenantContext!),
        )
          .select('documentCount')
          .lean()) as { documentCount?: number } | null;

        const discoveredSchemas = await DiscoveredSchema.find({
          knowledgeBaseId: schema.knowledgeBaseId,
          tenantId,
        }).lean();

        logger.info('[SYSTEM-FIELDS] Checking conditions', {
          documentCount: index?.documentCount,
          discoveredCount: discoveredSchemas.length,
          fieldsLength: schema.fields?.length,
        });

        // If documents exist but no connectors discovered, show system-populated core fields.
        // But ONLY for pure document uploads (PDF, DOCX) — NOT for JSON uploads.
        // JSON uploads create their own FieldMapping records, so we detect them by checking
        // whether any real mappings already exist. If they do, skip doc metadata entirely.
        const hasRealMappings = enrichedMappings.length > 0;
        if ((index?.documentCount ?? 0) > 0 && discoveredSchemas.length === 0 && !hasRealMappings) {
          // Show static metadata fields + any user-filled fields from uploads.
          // User-filled fields have FieldMappings with connectorId 'manual-upload:*'.
          // If none exist (crash during upload), fall back to just the static 3.
          const STATIC_DOC_FIELDS = new Set(['source_type', 'created_date', 'mime_type']);
          const FieldMappingModel = getLazyModel('FieldMapping');
          const userMappings = await FieldMappingModel.find({
            canonicalSchemaId: String(schema._id),
            tenantId,
            connectorId: { $regex: /^manual-upload:/ },
            status: 'active',
          }).lean();
          const userMappedFields = new Set(userMappings.map((m: any) => m.canonicalField));

          const coreFields = ((schema.fields as any[]) || []).filter((f: any) => {
            return STATIC_DOC_FIELDS.has(f.storageField) || userMappedFields.has(f.storageField);
          });

          logger.info('[SYSTEM-FIELDS] Adding system mappings (pure doc upload)', {
            coreFieldCount: coreFields.length,
          });

          if (coreFields.length > 0) {
            const systemMappings = coreFields.map((field: any) => ({
              _id: `system-${field.storageField}`,
              tenantId,
              canonicalSchemaId: String(schema._id),
              canonicalField: field.storageField,
              connectorId: 'system',
              sourcePath: field.storageField,
              transform: { type: 'direct' },
              confidence: 1.0,
              status: 'active',
              suggestedBy: 'system',
              reviewedBy: 'system',
              aliasName: field.name,
              aliasLabel: field.label,
              connectorType: 'manual-upload',
              isSystemField: true,
            }));

            enrichedMappings = [...systemMappings, ...enrichedMappings];
            finalTotal = total + systemMappings.length;
          }
        }
      }
    }

    res.json({
      mappings: enrichedMappings,
      total: finalTotal,
      pagination: { skip, limit, hasMore: skip + limit < finalTotal },
    });
  } catch (error) {
    logger.error('Failed to list mappings', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to list mappings' });
  }
});

/**
 * POST /suggest - Trigger auto-mapping suggestion
 *
 * Uses LLM to suggest field mappings between a connector schema and canonical schema.
 * Creates FieldMapping documents with status=suggested.
 *
 * M-2 FIX: Rate limited to 10 requests/minute/tenant (LLM calls are expensive).
 */
router.post(
  '/suggest',
  searchAiRateLimit({ limit: 10, windowMs: 60_000 }),
  async (req: Request, res: Response) => {
    try {
      if (!req.tenantContext) {
        res.status(401).json({ error: 'Tenant context required' });
        return;
      }

      const { canonicalSchemaId, connectorId, indexId } = req.body;

      const tenantId = req.tenantContext!.tenantId;

      if (!canonicalSchemaId || !connectorId || !indexId) {
        res.status(400).json({ error: 'canonicalSchemaId, connectorId, and indexId are required' });
        return;
      }

      // Verify canonical schema exists and belongs to tenant
      const canonicalSchema = await findProjectScopedCanonicalSchemaById(
        canonicalSchemaId,
        tenantId,
        req.tenantContext!,
      );
      if (!canonicalSchema) {
        res.status(404).json({ error: 'Canonical schema not found' });
        return;
      }

      // Fetch connector schema
      const connectorSchema = await ConnectorSchema.findOne({
        connectorId,
        tenantId,
        status: 'active',
      })
        .sort({ version: -1 })
        .lean();

      if (!connectorSchema) {
        res.status(404).json({ error: 'Connector schema not found' });
        return;
      }

      // Fetch existing mappings
      const existingMappings = await FieldMapping.find({
        connectorId,
        canonicalSchemaId,
        tenantId,
      }).lean();

      // Generate LLM suggestions
      const suggestionResult = await mappingSuggestionService.suggestMappings(tenantId, indexId, {
        sourceFields: connectorSchema.fields,
        canonicalFields: canonicalSchema.fields,
        connectorType: connectorSchema.connectorId,
        existingMappings: existingMappings as any[],
      });

      // Create FieldMapping documents for suggestions
      const mappingsToCreate = suggestionResult.suggestions.map((suggestion) => ({
        tenantId,
        canonicalSchemaId,
        canonicalField: suggestion.canonicalField,
        connectorId,
        sourcePath: suggestion.sourcePath,
        transform: suggestion.transform,
        confidence: suggestion.confidence,
        status: 'suggested',
        suggestedBy: 'llm',
        reviewedBy: null,
        reviewedAt: null,
      }));

      // Bulk insert suggested mappings
      const createdMappings = await FieldMapping.insertMany(mappingsToCreate);

      logger.info('Mapping suggestions created', {
        tenantId,
        canonicalSchemaId,
        connectorId,
        count: createdMappings.length,
        averageConfidence: suggestionResult.averageConfidence,
      });

      res.json({
        message: 'Mapping suggestions generated',
        suggestions: createdMappings,
        stats: {
          totalSuggestions: suggestionResult.suggestions.length,
          averageConfidence: suggestionResult.averageConfidence,
          processingTimeMs: suggestionResult.processingTimeMs,
        },
      });
    } catch (error) {
      logger.error('Failed to generate mapping suggestions', {
        error: error instanceof Error ? error.message : String(error),
      });
      res.status(500).json({ error: 'Failed to generate mapping suggestions' });
    }
  },
);

// ─── Input Validation Helpers (Stories 2.4/2.5/2.6) ─────────────────────────

const VALID_TRANSFORM_TYPES = [
  'direct',
  'lowercase',
  'uppercase',
  'split',
  'join',
  'parse_date',
  'value_map',
] as const;

function isValidAlias(alias: unknown): alias is string {
  return (
    typeof alias === 'string' && alias.length > 0 && alias.length <= 100 && /^[\w ]+$/.test(alias)
  );
}

function isValidEnumValueMap(map: unknown): map is Record<string, string> {
  if (!map || typeof map !== 'object' || Array.isArray(map)) return false;
  const entries = Object.entries(map as Record<string, unknown>);
  if (entries.length === 0 || entries.length > 100) return false;
  return entries.every(
    ([k, v]) =>
      typeof k === 'string' && k.length <= 200 && typeof v === 'string' && v.length <= 200,
  );
}

function isValidTransform(transform: unknown): transform is {
  type: string;
  valueMap?: Record<string, string>;
  delimiter?: string;
  sourceFormat?: string;
} {
  if (!transform || typeof transform !== 'object' || Array.isArray(transform)) return false;
  const t = transform as Record<string, unknown>;
  if (!t.type || !VALID_TRANSFORM_TYPES.includes(t.type as any)) return false;
  if (t.valueMap !== undefined && !isValidEnumValueMap(t.valueMap)) return false;
  if (t.delimiter !== undefined && (typeof t.delimiter !== 'string' || t.delimiter.length > 10))
    return false;
  if (
    t.sourceFormat !== undefined &&
    (typeof t.sourceFormat !== 'string' || t.sourceFormat.length > 100)
  )
    return false;
  return true;
}

/**
 * POST / - Manually create a field mapping
 *
 * Creates a new FieldMapping with status='active', confidence=1.0, suggestedBy='user'.
 * Returns 409 if a mapping already exists for the same (canonicalSchemaId, canonicalField, connectorId).
 */
router.post('/', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const {
      sourcePath,
      canonicalField,
      connectorId,
      canonicalSchemaId,
      transform,
      alias,
      enumValueMap,
    } = req.body;

    // Validate required fields
    if (!sourcePath || !canonicalField || !connectorId || !canonicalSchemaId) {
      res.status(400).json({
        error: 'sourcePath, canonicalField, connectorId, and canonicalSchemaId are required',
      });
      return;
    }

    // Validate canonicalField exists in the CanonicalSchema
    const schema = await findProjectScopedCanonicalSchemaById(
      canonicalSchemaId,
      tenantId,
      req.tenantContext!,
    );
    if (!schema) {
      res.status(404).json({ error: 'Canonical schema not found' });
      return;
    }

    const fieldExists = (schema.fields as any[]).some(
      (f: any) => f.storageField === canonicalField,
    );
    if (!fieldExists) {
      res.status(404).json({ error: 'canonicalField not found in schema' });
      return;
    }

    // Validate input types
    if (alias !== undefined && !isValidAlias(alias)) {
      res
        .status(400)
        .json({ error: 'alias must be 1-100 chars, alphanumeric/underscore/space only' });
      return;
    }
    if (enumValueMap !== undefined && !isValidEnumValueMap(enumValueMap)) {
      res.status(400).json({
        error: 'enumValueMap must be a flat object with string keys/values, max 100 entries',
      });
      return;
    }
    if (transform !== undefined && !isValidTransform(transform)) {
      res.status(400).json({
        error: 'transform must have a valid type and optional valueMap/delimiter/sourceFormat',
      });
      return;
    }

    // Validate alias uniqueness within knowledgeBaseId scope if provided
    if (alias) {
      const aliasConflict = (schema.fields as any[]).some(
        (f: any) => f.name === alias && f.storageField !== canonicalField,
      );
      if (aliasConflict) {
        res.status(409).json({ error: 'Alias already in use within this knowledge base' });
        return;
      }
    }

    const userId =
      req.tenantContext?.userId ??
      (typeof req.body.reviewedBy === 'string' ? req.body.reviewedBy : undefined);

    // Build the mapping document
    const mappingDoc: Record<string, unknown> = {
      tenantId,
      canonicalSchemaId,
      canonicalField,
      connectorId,
      sourcePath,
      transform: transform || { type: 'direct' },
      confidence: 1.0,
      status: 'active',
      suggestedBy: 'user',
      reviewedBy: userId,
      reviewedAt: new Date(),
    };

    // If enumValueMap is provided, store it in transform.valueMap
    if (enumValueMap) {
      const xform = mappingDoc.transform as Record<string, unknown>;
      xform.type = 'value_map';
      xform.valueMap = enumValueMap;
    }

    const created = await FieldMapping.create(mappingDoc);

    // Invalidate cache
    try {
      const service = getCanonicalMapperService();
      await service.invalidateCache(connectorId, tenantId);
    } catch (cacheErr) {
      logger.warn('Failed to invalidate cache after manual mapping creation', {
        error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      });
    }

    queueMappingAuditEvent(
      'manual_create',
      tenantId,
      userId,
      [
        {
          connectorId,
          mappingId: String(created._id),
          canonicalSchemaId,
          canonicalField,
          sourcePath,
        },
      ],
      { createdBy: 'manual' },
    );

    res.status(201).json({ mapping: created });
  } catch (error: unknown) {
    // Handle MongoDB duplicate key error (unique index on canonicalSchemaId + canonicalField + connectorId)
    if (error && typeof error === 'object' && 'code' in error && (error as any).code === 11000) {
      res.status(409).json({
        error:
          'Mapping already exists for this canonicalSchemaId, canonicalField, and connectorId combination',
      });
      return;
    }
    logger.error('Failed to create mapping', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to create mapping' });
  }
});

/**
 * POST /bulk-action - Bulk confirm or reject mappings
 *
 * Design Decision: This is a NEW endpoint separate from POST /batch-update.
 * The existing /batch-update delegates to batchReviewService which supports 'approve'|'reject'|'needs_review'.
 * This endpoint implements 'confirm'|'reject' directly with updateMany to avoid coupling
 * to batchReviewService's API, which may not match the AC requirements exactly.
 * 'confirm' maps to status='active', 'reject' maps to status='rejected'.
 */
router.post('/bulk-action', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { action, mappingIds } = req.body;

    // Validate action
    if (!action || !['confirm', 'reject'].includes(action)) {
      res.status(400).json({ error: 'action must be confirm or reject' });
      return;
    }

    // Validate mappingIds
    if (!mappingIds || !Array.isArray(mappingIds) || mappingIds.length === 0) {
      res.status(400).json({ error: 'mappingIds must be a non-empty array' });
      return;
    }

    if (mappingIds.length > 200) {
      res.status(400).json({ error: 'mappingIds array must not exceed 200 items' });
      return;
    }

    const userId =
      req.tenantContext?.userId ??
      (typeof req.body.reviewedBy === 'string' ? req.body.reviewedBy : undefined);

    // Validate all mappingIds belong to tenant
    const tenantMappings = await FieldMapping.find({
      _id: { $in: mappingIds },
      tenantId,
    })
      .select('_id connectorId canonicalSchemaId')
      .lean();

    const tenantMappingIds = new Set(
      (tenantMappings as MappingAuditRow[]).map((mapping) => String(mapping._id)),
    );
    const invalidIds = mappingIds.filter((id: string) => !tenantMappingIds.has(id));

    if (invalidIds.length > 0) {
      res.status(404).json({
        error: 'Some mappingIds were not found',
      });
      return;
    }

    const scopedSchemaResults = await Promise.all(
      (tenantMappings as MappingAuditRow[]).map((mapping) =>
        findProjectScopedCanonicalSchemaById(
          String(mapping.canonicalSchemaId),
          tenantId,
          req.tenantContext!,
        ),
      ),
    );
    if (scopedSchemaResults.some((schema) => !schema)) {
      res.status(404).json({
        error: 'Some mappingIds were not found',
      });
      return;
    }

    // Determine new status based on action
    const newStatus = action === 'confirm' ? 'active' : 'rejected';

    // Bulk update
    const result = await FieldMapping.updateMany(
      { _id: { $in: mappingIds }, tenantId },
      {
        $set: {
          status: newStatus,
          reviewedBy: userId,
          reviewedAt: new Date(),
        },
      },
    );

    // Invalidate cache for each unique connectorId
    const connectorIds = Array.from(
      new Set((tenantMappings as MappingAuditRow[]).map((mapping) => mapping.connectorId)),
    ) as string[];

    try {
      const service = getCanonicalMapperService();
      for (const cid of connectorIds) {
        await service.invalidateCache(cid, tenantId);
      }
    } catch (cacheErr) {
      logger.warn('Failed to invalidate cache after bulk action', {
        error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      });
    }

    queueMappingAuditEvent(
      action === 'confirm' ? 'batch_confirm' : 'batch_reject',
      tenantId,
      userId,
      (tenantMappings as MappingAuditRow[]).map((mapping) => ({
        connectorId: mapping.connectorId,
        mappingId: String(mapping._id),
      })),
      {
        action,
        count: result.modifiedCount ?? mappingIds.length,
      },
    );

    res.json({
      success: true,
      processedCount: result.modifiedCount ?? mappingIds.length,
    });
  } catch (error) {
    logger.error('Failed to perform bulk action on mappings', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to perform bulk action on mappings' });
  }
});

/**
 * GET /tab-stats - Get counts for FieldsTab badge display
 *
 * Query params:
 *   - knowledgeBaseId: Required. The SearchIndex ID to get stats for.
 */
router.get('/tab-stats', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { knowledgeBaseId } = req.query;

    if (!knowledgeBaseId) {
      return res
        .status(400)
        .json({ error: { code: 'MISSING_PARAM', message: 'knowledgeBaseId required' } });
    }

    const scopedIndex = (await SearchIndex.findOne(
      applyProjectScopeFilter({ _id: knowledgeBaseId, tenantId }, req.tenantContext!),
    )
      .select('documentCount')
      .lean()) as { documentCount?: number } | null;
    if (!scopedIndex) {
      return res.json({ confirmedCount: 0, suggestedCount: 0, unmappedCount: 0, totalFields: 0 });
    }

    const schema = await CanonicalSchema.findOne({
      knowledgeBaseId,
      tenantId,
      status: 'active',
    })
      .sort({ version: -1 })
      .lean();
    if (!schema) {
      return res.json({ confirmedCount: 0, suggestedCount: 0, unmappedCount: 0, totalFields: 0 });
    }

    let [confirmedCount, suggestedCount] = await Promise.all([
      FieldMapping.countDocuments({ canonicalSchemaId: schema._id, tenantId, status: 'active' }),
      FieldMapping.countDocuments({ canonicalSchemaId: schema._id, tenantId, status: 'suggested' }),
    ]);

    const discoveredSchemas = await DiscoveredSchema.find({ knowledgeBaseId, tenantId }).lean();
    let totalDiscoveredFields = 0;
    let mappedFieldCount = 0;

    for (const ds of discoveredSchemas) {
      totalDiscoveredFields += ds.fields?.length ?? 0;
      const mappedForConnector = await FieldMapping.countDocuments({
        canonicalSchemaId: schema._id,
        connectorId: ds.connectorId,
        tenantId,
      });
      mappedFieldCount += mappedForConnector;
    }

    // Check if there are documents from manual uploads (no connectors)
    // Only add system fields that are NOT already counted via real FieldMapping records.
    // For pure document uploads (no real mappings), only count metadata fields
    // that document processing actually populates.
    // Only add doc metadata system fields for pure document uploads (no real mappings).
    // JSON uploads create their own FieldMapping records — don't add extra system fields.
    const hasRealMappings = confirmedCount > 0 || suggestedCount > 0;
    if (
      (scopedIndex.documentCount ?? 0) > 0 &&
      discoveredSchemas.length === 0 &&
      !hasRealMappings
    ) {
      // Document uploads always populate these metadata fields.
      const DOCUMENT_METADATA_FIELDS = new Set(['source_type', 'created_date', 'mime_type']);

      const docFieldCount = ((schema.fields as any[]) || []).filter(
        (f: any) => f.indexed === true && DOCUMENT_METADATA_FIELDS.has(f.storageField),
      ).length;
      confirmedCount += docFieldCount;
    }

    const unmappedCount = Math.max(0, totalDiscoveredFields - mappedFieldCount);

    res.json({ confirmedCount, suggestedCount, unmappedCount, totalFields: totalDiscoveredFields });
  } catch (error) {
    logger.error('Failed to get tab stats', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get tab stats' } });
  }
});

/**
 * PATCH /:mappingId - Edit a field mapping (alias, enumValueMap, transform)
 *
 * Alias is stored on CanonicalSchema.fields[].name (where storageField === mapping.canonicalField),
 * not on FieldMapping directly, because alias = ICanonicalField.name per the architecture.
 * enumValueMap is stored in FieldMapping.transform.valueMap for ingestion-time coercion.
 */
router.patch('/:mappingId', async (req: Request, res: Response) => {
  try {
    const { mappingId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { alias, enumValueMap, transform } = req.body;

    // Validate at least one field is provided
    if (alias === undefined && enumValueMap === undefined && transform === undefined) {
      res
        .status(400)
        .json({ error: 'At least one of alias, enumValueMap, or transform must be provided' });
      return;
    }

    // Validate input types
    if (alias !== undefined && !isValidAlias(alias)) {
      res
        .status(400)
        .json({ error: 'alias must be 1-100 chars, alphanumeric/underscore/space only' });
      return;
    }
    if (enumValueMap !== undefined && !isValidEnumValueMap(enumValueMap)) {
      res.status(400).json({
        error: 'enumValueMap must be a flat object with string keys/values, max 100 entries',
      });
      return;
    }
    if (transform !== undefined && !isValidTransform(transform)) {
      res.status(400).json({
        error: 'transform must have a valid type and optional valueMap/delimiter/sourceFormat',
      });
      return;
    }

    // Read before-state for audit
    const beforeMapping = await FieldMapping.findOne({ _id: mappingId, tenantId }).lean();
    if (!beforeMapping) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    const scopedSchema = await findProjectScopedCanonicalSchemaById(
      String(beforeMapping.canonicalSchemaId),
      tenantId,
      req.tenantContext!,
    );
    if (!scopedSchema) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    // Build update set
    const updateSet: Record<string, unknown> = {};

    // Handle enumValueMap: store in transform.valueMap
    if (enumValueMap !== undefined) {
      updateSet['transform.type'] = 'value_map';
      updateSet['transform.valueMap'] = enumValueMap;
    }

    // Handle full transform replacement
    if (transform !== undefined) {
      updateSet.transform = transform;
    }

    // Handle alias: validate uniqueness and update CanonicalSchema
    if (alias !== undefined) {
      const schema = scopedSchema;

      if (schema) {
        // Check alias uniqueness: no other field in this schema should have the same alias name
        const aliasConflict = (schema.fields as any[]).some(
          (f: any) => f.name === alias && f.storageField !== beforeMapping.canonicalField,
        );
        if (aliasConflict) {
          res.status(409).json({ error: 'Alias already in use within this knowledge base' });
          return;
        }

        // Update the alias on CanonicalSchema.fields[].name where storageField matches
        await CanonicalSchema.findOneAndUpdate(
          {
            _id: beforeMapping.canonicalSchemaId,
            tenantId,
            'fields.storageField': beforeMapping.canonicalField,
          },
          { $set: { 'fields.$.name': alias } },
        );
      }
    }

    // Apply FieldMapping updates (if any transform/enumValueMap changes)
    let updatedMapping;
    if (Object.keys(updateSet).length > 0) {
      updatedMapping = await FieldMapping.findOneAndUpdate(
        { _id: mappingId, tenantId },
        { $set: updateSet },
        { new: true },
      ).lean();
    } else {
      // Re-fetch if only alias was updated (alias lives on CanonicalSchema, not FieldMapping)
      updatedMapping = await FieldMapping.findOne({ _id: mappingId, tenantId }).lean();
    }

    // Invalidate cache
    try {
      const service = getCanonicalMapperService();
      await service.invalidateCache(beforeMapping.connectorId, tenantId);
    } catch (cacheErr) {
      logger.warn('Failed to invalidate cache after mapping update', {
        error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      });
    }

    const userId =
      req.tenantContext?.userId ??
      (typeof req.body.reviewedBy === 'string' ? req.body.reviewedBy : undefined);
    queueMappingAuditEvent(
      'update',
      tenantId,
      userId,
      [
        {
          connectorId: beforeMapping.connectorId,
          mappingId,
          canonicalSchemaId: String(beforeMapping.canonicalSchemaId),
          canonicalField: beforeMapping.canonicalField,
          sourcePath: beforeMapping.sourcePath,
        },
      ],
      {
        before: { transform: beforeMapping.transform },
        after: { alias, enumValueMap, transform },
      },
    );

    res.json({ mapping: updatedMapping });
  } catch (error) {
    logger.error('Failed to update mapping', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to update mapping' });
  }
});

/**
 * POST /:mappingId/confirm - Confirm a suggested mapping
 */
router.post('/:mappingId/confirm', async (req: Request, res: Response) => {
  try {
    const { mappingId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { reviewedBy } = req.body;

    const beforeMapping = await FieldMapping.findOne({ _id: mappingId, tenantId }).lean();
    if (!beforeMapping) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    const scopedSchema = await findProjectScopedCanonicalSchemaById(
      String(beforeMapping.canonicalSchemaId),
      tenantId,
      req.tenantContext!,
    );
    if (!scopedSchema) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    const mapping = await FieldMapping.findOneAndUpdate(
      { _id: mappingId, tenantId },
      {
        $set: {
          status: 'active',
          isActive: true,
          reviewedBy: reviewedBy || 'user',
          reviewedAt: new Date(),
        },
      },
      { new: true },
    ).lean();

    if (!mapping) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    // ✅ MUST-HAVE: Invalidate cache after confirming mapping
    const service = getCanonicalMapperService();
    await service.invalidateCache(mapping.connectorId, tenantId);

    queueMappingAuditEvent(
      'confirm',
      tenantId,
      req.tenantContext?.userId ?? reviewedBy,
      [
        {
          connectorId: mapping.connectorId,
          mappingId,
          canonicalSchemaId: String(mapping.canonicalSchemaId),
          canonicalField: mapping.canonicalField,
          sourcePath: mapping.sourcePath,
        },
      ],
      { reviewedBy: reviewedBy || null },
    );

    res.json({ mapping });
  } catch (error) {
    logger.error('Failed to confirm mapping', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to confirm mapping' });
  }
});

/**
 * POST /:mappingId/reject - Reject a suggested mapping
 */
router.post('/:mappingId/reject', async (req: Request, res: Response) => {
  try {
    const { mappingId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { reviewedBy } = req.body;

    const beforeMapping = await FieldMapping.findOne({ _id: mappingId, tenantId }).lean();
    if (!beforeMapping) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    const scopedSchema = await findProjectScopedCanonicalSchemaById(
      String(beforeMapping.canonicalSchemaId),
      tenantId,
      req.tenantContext!,
    );
    if (!scopedSchema) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    const mapping = await FieldMapping.findOneAndUpdate(
      { _id: mappingId, tenantId },
      {
        $set: {
          status: 'rejected',
          isActive: false, // Rejected mappings are inactive
          reviewedBy: reviewedBy || 'user',
          reviewedAt: new Date(),
        },
      },
      { new: true },
    ).lean();

    if (!mapping) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    // ✅ MUST-HAVE: Invalidate cache after rejecting mapping
    const service = getCanonicalMapperService();
    await service.invalidateCache(mapping.connectorId, tenantId);

    queueMappingAuditEvent(
      'reject',
      tenantId,
      req.tenantContext?.userId ?? reviewedBy,
      [
        {
          connectorId: mapping.connectorId,
          mappingId,
          canonicalSchemaId: String(mapping.canonicalSchemaId),
          canonicalField: mapping.canonicalField,
          sourcePath: mapping.sourcePath,
        },
      ],
      { reviewedBy: reviewedBy || null },
    );

    res.json({ mapping });
  } catch (error) {
    logger.error('Failed to reject mapping', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to reject mapping' });
  }
});

/**
 * POST /:mappingId/test - Test a mapping against sample data
 */
router.post('/:mappingId/test', async (req: Request, res: Response) => {
  try {
    const { mappingId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { sampleData } = req.body;

    const mapping = await FieldMapping.findOne({ _id: mappingId, tenantId }).lean();
    if (!mapping) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    const scopedSchema = await findProjectScopedCanonicalSchemaById(
      String(mapping.canonicalSchemaId),
      tenantId,
      req.tenantContext!,
    );
    if (!scopedSchema) {
      res.status(404).json({ error: 'Mapping not found' });
      return;
    }

    if (!sampleData) {
      res.status(400).json({ error: 'sampleData is required' });
      return;
    }

    // TODO: Apply the mapping transform to the sample data
    // For now, return a stub result showing the mapping would be applied

    res.json({
      mappingId,
      sourcePath: mapping.sourcePath,
      canonicalField: mapping.canonicalField,
      transform: mapping.transform,
      testResult: {
        success: true,
        inputSample: sampleData,
        outputSample: null, // Populated when transform engine is wired
        message: 'Transform test not yet implemented',
      },
    });
  } catch (error) {
    logger.error('Failed to test mapping', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to test mapping' });
  }
});

/**
 * GET /review - Get mappings for batch review
 *
 * Query params:
 *   - canonicalSchemaId: Filter by canonical schema
 *   - connectorId: Filter by connector
 *   - status: Filter by status (comma-separated for multiple)
 *   - minConfidence: Minimum confidence threshold
 *   - maxConfidence: Maximum confidence threshold
 *   - sortBy: Sort field (confidence, createdAt, canonicalField, sourcePath)
 *   - sortOrder: Sort order (asc, desc)
 *   - limit: Page size (default: 50)
 *   - offset: Page offset (default: 0)
 */
router.get('/review', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const {
      canonicalSchemaId,
      connectorId,
      status,
      minConfidence,
      maxConfidence,
      sortBy,
      sortOrder,
      limit,
      offset,
    } = req.query;

    const filter: Record<string, unknown> = {};
    if (canonicalSchemaId) {
      const scopedSchema = await findProjectScopedCanonicalSchemaById(
        canonicalSchemaId as string,
        tenantId,
        req.tenantContext!,
      );
      if (!scopedSchema) {
        res.status(404).json({ error: 'Canonical schema not found' });
        return;
      }
      filter.canonicalSchemaId = canonicalSchemaId as string;
    }
    if (connectorId) filter.connectorId = connectorId as string;
    if (status) filter.status = (status as string).split(',');
    if (minConfidence) filter.minConfidence = parseFloat(minConfidence as string);
    if (maxConfidence) filter.maxConfidence = parseFloat(maxConfidence as string);

    const sort = sortBy
      ? {
          field: sortBy as any,
          order: (sortOrder as 'asc' | 'desc') || 'desc',
        }
      : undefined;

    const result = await batchReviewService.getMappingsForReview({
      tenantId,
      filter,
      sort,
      limit: limit ? parseInt(limit as string) : 50,
      offset: offset ? parseInt(offset as string) : 0,
    });

    res.json(result);
  } catch (error) {
    logger.error('Failed to get mappings for review', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get mappings for review' });
  }
});

/**
 * POST /batch-update - Batch update mapping statuses
 *
 * Body:
 *   - mappingIds: Array of mapping IDs
 *   - action: 'approve' | 'reject' | 'needs_review'
 *   - reviewedBy: User ID performing the action
 */
router.post('/batch-update', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { mappingIds, action, reviewedBy } = req.body;

    if (!mappingIds || !Array.isArray(mappingIds) || mappingIds.length === 0) {
      res.status(400).json({ error: 'mappingIds array is required' });
      return;
    }

    if (!action || !['approve', 'reject', 'needs_review'].includes(action)) {
      res.status(400).json({ error: 'action must be approve, reject, or needs_review' });
      return;
    }

    if (!reviewedBy) {
      res.status(400).json({ error: 'reviewedBy is required' });
      return;
    }

    const scopedMappings = await FieldMapping.find({
      _id: { $in: mappingIds },
      tenantId,
    })
      .select('_id connectorId canonicalSchemaId canonicalField sourcePath')
      .lean<MappingAuditRow[]>();
    if (scopedMappings.length !== mappingIds.length) {
      res.status(404).json({ error: 'Some mappingIds were not found' });
      return;
    }
    const scopedSchemaResults = await Promise.all(
      scopedMappings.map((mapping) =>
        findProjectScopedCanonicalSchemaById(
          String(mapping.canonicalSchemaId),
          tenantId,
          req.tenantContext!,
        ),
      ),
    );
    if (scopedSchemaResults.some((schema) => !schema)) {
      res.status(404).json({ error: 'Some mappingIds were not found' });
      return;
    }

    const result = await batchReviewService.batchUpdateMappings({
      tenantId,
      mappingIds,
      action,
      reviewedBy,
    });

    // Invalidate cache if any mappings were updated
    if (result.updatedCount > 0) {
      const service = getCanonicalMapperService();
      // Get unique connector IDs from updated mappings
      const updatedMappings = scopedMappings;

      const connectorIds = Array.from(
        new Set(updatedMappings.map((mapping) => mapping.connectorId)),
      ) as string[];
      for (const connectorId of connectorIds) {
        await service.invalidateCache(connectorId, tenantId);
      }
      queueMappingAuditEvent(
        action === 'approve'
          ? 'batch_confirm'
          : action === 'needs_review'
            ? 'batch_needs_review'
            : 'batch_reject',
        tenantId,
        req.tenantContext?.userId ?? reviewedBy,
        updatedMappings.map((mapping) => ({
          connectorId: mapping.connectorId,
          mappingId: String(mapping._id),
          canonicalSchemaId: String(mapping.canonicalSchemaId),
          canonicalField: mapping.canonicalField ?? undefined,
          sourcePath: mapping.sourcePath ?? undefined,
        })),
        { action, reviewedBy },
      );
    }

    res.json(result);
  } catch (error) {
    logger.error('Failed to batch update mappings', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to batch update mappings' });
  }
});

/**
 * GET /stats/:canonicalSchemaId - Get review statistics
 *
 * Returns counts by status and average confidence for a canonical schema.
 */
router.get('/stats/:canonicalSchemaId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { canonicalSchemaId } = req.params;

    const scopedSchema = await findProjectScopedCanonicalSchemaById(
      canonicalSchemaId,
      tenantId,
      req.tenantContext!,
    );
    if (!scopedSchema) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Schema not found' } });
    }

    const stats = await batchReviewService.getReviewStats(tenantId, canonicalSchemaId);

    res.json(stats);
  } catch (error) {
    logger.error('Failed to get review stats', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get review stats' });
  }
});

/**
 * GET /:mappingId - Get a single field mapping with alias info
 *
 * IMPORTANT: Must be registered AFTER all static GET routes (/tab-stats, /review,
 * /stats/:id) to avoid capturing those paths as mappingId.
 */
router.get('/:mappingId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { mappingId } = req.params;

    const mapping = await FieldMapping.findOne({ _id: mappingId, tenantId }).lean();
    if (!mapping) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mapping not found' } });
    }

    const schema = await findProjectScopedCanonicalSchemaById(
      String(mapping.canonicalSchemaId),
      tenantId,
      req.tenantContext!,
    );
    if (!schema) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mapping not found' } });
    }
    const aliasField = schema?.fields?.find((f: any) => f.storageField === mapping.canonicalField);

    res.json({
      mapping: {
        ...mapping,
        aliasName: aliasField?.name ?? null,
        aliasLabel: aliasField?.label ?? null,
      },
    });
  } catch (error) {
    logger.error('Failed to get mapping', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to get mapping' } });
  }
});

/**
 * DELETE /:mappingId - Delete a field mapping
 *
 * Removes the mapping document. Returns 404 if not found or wrong tenant.
 */
router.delete('/:mappingId', async (req: Request, res: Response) => {
  try {
    const tenantId = req.tenantContext!.tenantId;
    const { mappingId } = req.params;

    const beforeMapping = await FieldMapping.findOne({ _id: mappingId, tenantId }).lean();
    if (!beforeMapping) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mapping not found' } });
    }

    const scopedSchema = await findProjectScopedCanonicalSchemaById(
      String(beforeMapping.canonicalSchemaId),
      tenantId,
      req.tenantContext!,
    );
    if (!scopedSchema) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mapping not found' } });
    }

    const mapping = await FieldMapping.findOneAndDelete({ _id: mappingId, tenantId }).lean();
    if (!mapping) {
      return res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Mapping not found' } });
    }

    // Invalidate cache
    try {
      const service = getCanonicalMapperService();
      await service.invalidateCache(mapping.connectorId, tenantId);
    } catch (cacheErr) {
      logger.warn('Failed to invalidate cache after mapping deletion', {
        error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
      });
    }

    const userId =
      req.tenantContext?.userId ??
      (typeof req.body?.reviewedBy === 'string' ? (req.body.reviewedBy as string) : undefined);
    queueMappingAuditEvent(
      'delete',
      tenantId,
      userId,
      [
        {
          connectorId: mapping.connectorId,
          mappingId,
          canonicalSchemaId: String(mapping.canonicalSchemaId),
          canonicalField: mapping.canonicalField,
          sourcePath: mapping.sourcePath,
        },
      ],
      { action: 'delete' },
    );

    res.json({ success: true });
  } catch (error) {
    logger.error('Failed to delete mapping', {
      error: error instanceof Error ? error.message : String(error),
    });
    res
      .status(500)
      .json({ error: { code: 'INTERNAL_ERROR', message: 'Failed to delete mapping' } });
  }
});

export default router;
