/**
 * Schema Routes
 *
 * Connector schema discovery and canonical schema management.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import type {
  IConnectorSchema,
  ICanonicalSchema,
  IConnectorSchemaField,
  IConnectorConfig,
  ISearchSource,
  IDiscoveredSchema,
  IFieldMapping,
  IKnowledgeBase,
} from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';
import { applyProjectScopeFilter } from './project-scope.js';

const ConnectorSchema = getLazyModel<IConnectorSchema>('ConnectorSchema');
const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const SearchSource = getLazyModel<ISearchSource>('SearchSource');
const DiscoveredSchemaModel = getLazyModel<IDiscoveredSchema>('DiscoveredSchema');
const FieldMapping = getLazyModel<IFieldMapping>('FieldMapping');
const KnowledgeBase = getLazyModel<IKnowledgeBase>('KnowledgeBase');
import { QUEUE_SCHEMA_SYNC, QUEUE_SCHEMA_DISCOVERY } from '@agent-platform/search-ai-sdk';
import { createQueue } from '../workers/shared.js';
import type { SchemaSyncJobData } from '../workers/schema-sync-worker.js';
import type { SchemaDiscoveryJobData } from '../workers/schema-discovery-worker.js';
import { createLogger } from '@abl/compiler/platform';
import { assertConnectorIndexAccess, assertSearchIndexAccess } from './searchai-route-ownership.js';

const router: RouterType = Router();
const logger = createLogger('schemas-routes');

function sendScopedNotFound(res: Response, message: string): void {
  res.status(404).json({
    success: false,
    error: { code: 'NOT_FOUND', message },
  });
}

function hasProjectRestriction(req: Request): boolean {
  return Boolean(req.tenantContext?.projectId || req.tenantContext?.projectScope?.length);
}

async function findLatestCanonicalSchema(
  schemaKeys: string[],
  tenantId: string,
  extraFilter: Record<string, unknown> = {},
): Promise<ICanonicalSchema | null> {
  for (const knowledgeBaseId of schemaKeys) {
    const schema = await CanonicalSchema.findOne({
      knowledgeBaseId,
      tenantId,
      ...extraFilter,
    })
      .sort({ version: -1 })
      .lean();
    if (schema) {
      return schema;
    }
  }

  return null;
}

async function resolveCanonicalSchemaKeys(
  req: Request,
  knowledgeBaseId: string,
): Promise<string[] | null> {
  const tenantContext = req.tenantContext;
  const tenantId = tenantContext?.tenantId;
  if (!tenantContext || !tenantId) {
    return null;
  }

  if (await assertSearchIndexAccess(req, knowledgeBaseId)) {
    return [knowledgeBaseId];
  }

  const kb = await KnowledgeBase.findOne(
    applyProjectScopeFilter({ _id: knowledgeBaseId, tenantId }, tenantContext),
  )
    .select('_id searchIndexId')
    .lean();

  if (!kb) {
    return null;
  }

  const searchIndexId = (kb as { searchIndexId?: string | null }).searchIndexId;
  return searchIndexId ? [knowledgeBaseId, searchIndexId] : [knowledgeBaseId];
}

/**
 * POST /connectors/:connectorId/discover - Trigger schema discovery
 *
 * Enqueues a schema sync job to discover and update the connector's schema.
 *
 * M-3 FIX: Accepts connectorConfigId instead of raw credentials.
 */
router.post('/connectors/:connectorId/discover', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { connectorType, connectorConfigId, trigger = 'manual' } = req.body;

    if (!connectorType || !connectorConfigId) {
      res.status(400).json({ error: 'connectorType and connectorConfigId are required' });
      return;
    }

    if (hasProjectRestriction(req) && !(await assertConnectorIndexAccess(req, connectorId))) {
      sendScopedNotFound(res, 'Connector not found');
      return;
    }

    // Enqueue schema discovery job
    const queue = createQueue(QUEUE_SCHEMA_SYNC);
    try {
      const job = await queue.add(
        `schema-sync:${connectorId}`,
        {
          connectorId,
          tenantId,
          connectorType,
          connectorConfigId,
          trigger,
        } as SchemaSyncJobData,
        {
          jobId: `schema-sync:${tenantId}:${connectorId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 5_000 },
        },
      );

      res.json({ jobId: job.id, status: 'queued' });
    } finally {
      await queue.close();
    }
  } catch (error) {
    logger.error('Failed to trigger schema discovery', {
      connectorId: req.params.connectorId,
      tenantId: req.tenantContext?.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to trigger schema discovery' });
  }
});

/**
 * POST /connectors/:connectorId/discover-schema - Trigger enriched schema discovery
 *
 * Enqueues a SchemaDiscoveryWorker job (Stories 1.1-1.8 pipeline).
 * Resolves connectorId → sourceId → indexId (knowledgeBaseId) chain.
 */
router.post('/connectors/:connectorId/discover-schema', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    // 1. Validate connector exists and belongs to tenant
    const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
    if (!connector) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Connector not found' },
      });
      return;
    }

    // 2. Validate connector is authenticated
    if (!connector.oauthTokenId) {
      res.status(400).json({
        success: false,
        error: {
          code: 'NOT_AUTHENTICATED',
          message: 'Connector must be authenticated before schema discovery',
        },
      });
      return;
    }

    // 3. Resolve knowledgeBaseId via source → index chain
    const source = await SearchSource.findOne({ _id: connector.sourceId, tenantId }).lean();
    if (!source) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Source not found for connector' },
      });
      return;
    }

    const knowledgeBaseId = source.indexId;
    if (hasProjectRestriction(req) && !(await assertSearchIndexAccess(req, knowledgeBaseId))) {
      sendScopedNotFound(res, 'Connector not found');
      return;
    }

    // 4. Enqueue enriched schema discovery job
    const queue = createQueue(QUEUE_SCHEMA_DISCOVERY);
    try {
      const job = await queue.add(
        `schema-discovery:${connectorId}`,
        {
          tenantId,
          connectorId,
          knowledgeBaseId,
          connectorType: connector.connectorType,
          discoveryTrigger: 'manual',
        } as SchemaDiscoveryJobData,
        {
          jobId: `schema-discovery:${tenantId}:${connectorId}`,
          attempts: 3,
          backoff: { type: 'exponential', delay: 10_000 },
        },
      );

      res.status(202).json({
        data: { jobId: job.id, status: 'queued' },
        meta: { message: 'Schema discovery initiated' },
      });
    } finally {
      await queue.close();
    }
  } catch (error) {
    logger.error('Failed to trigger enriched schema discovery', {
      connectorId: req.params.connectorId,
      tenantId: req.tenantContext?.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'DISCOVERY_FAILED', message: 'Failed to trigger schema discovery' },
    });
  }
});

/**
 * GET /connectors/:connectorId/discovered - Get latest discovered schema
 *
 * Returns the enriched DiscoveredSchema (Stories 1.1-1.7 pipeline result).
 */
router.get('/connectors/:connectorId/discovered', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    if (hasProjectRestriction(req) && !(await assertConnectorIndexAccess(req, connectorId))) {
      sendScopedNotFound(res, 'Discovered schema not found');
      return;
    }

    const schema = await DiscoveredSchemaModel.findOne({ connectorId, tenantId })
      .sort({ version: -1 })
      .lean();

    if (!schema) {
      res.status(404).json({
        success: false,
        error: { code: 'NOT_FOUND', message: 'Discovered schema not found' },
      });
      return;
    }

    res.json({ data: schema });
  } catch (error) {
    logger.error('Failed to get discovered schema', {
      connectorId: req.params.connectorId,
      tenantId: req.tenantContext?.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({
      success: false,
      error: { code: 'INTERNAL_ERROR', message: 'Failed to get discovered schema' },
    });
  }
});

/**
 * GET /connectors/:connectorId - Get connector schema (Layer 1)
 *
 * Returns the discovered schema from a source connector.
 */
router.get('/connectors/:connectorId', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { version } = req.query;

    if (hasProjectRestriction(req) && !(await assertConnectorIndexAccess(req, connectorId))) {
      res.status(404).json({ error: 'Connector schema not found' });
      return;
    }

    const filter: Record<string, unknown> = { connectorId, tenantId };
    if (version) {
      filter.version = parseInt(version as string, 10);
    }

    // Get latest version if no version specified
    const schema = await ConnectorSchema.findOne(filter).sort({ version: -1 }).lean();

    if (!schema) {
      res.status(404).json({ error: 'Connector schema not found' });
      return;
    }

    res.json({ schema });
  } catch (error) {
    logger.error('Failed to get connector schema', {
      connectorId: req.params.connectorId,
      tenantId: req.tenantContext?.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get connector schema' });
  }
});

/**
 * GET /connectors/:connectorId/versions - Get all schema versions
 *
 * Returns all versions of a connector's schema for version history.
 */
router.get('/connectors/:connectorId/versions', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    if (hasProjectRestriction(req) && !(await assertConnectorIndexAccess(req, connectorId))) {
      res.json({ versions: [] });
      return;
    }

    const schemas = await ConnectorSchema.find({ connectorId, tenantId })
      .sort({ version: -1 })
      .select('_id version status discoveredAt fieldCount customFieldCount')
      .lean();

    res.json({ versions: schemas });
  } catch (error) {
    logger.error('Failed to get schema versions', {
      connectorId: req.params.connectorId,
      tenantId: req.tenantContext?.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get schema versions' });
  }
});

/**
 * GET /connectors/:connectorId/changes - Get schema change history
 *
 * Returns the differences between consecutive schema versions.
 */
router.get('/connectors/:connectorId/changes', async (req: Request, res: Response) => {
  try {
    const { connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { fromVersion, toVersion } = req.query;

    if (!fromVersion || !toVersion) {
      res.status(400).json({ error: 'fromVersion and toVersion query params are required' });
      return;
    }

    if (hasProjectRestriction(req) && !(await assertConnectorIndexAccess(req, connectorId))) {
      res.status(404).json({ error: 'One or both schema versions not found' });
      return;
    }

    const oldSchema = await ConnectorSchema.findOne({
      connectorId,
      tenantId,
      version: parseInt(fromVersion as string, 10),
    }).lean();

    const newSchema = await ConnectorSchema.findOne({
      connectorId,
      tenantId,
      version: parseInt(toVersion as string, 10),
    }).lean();

    if (!oldSchema || !newSchema) {
      res.status(404).json({ error: 'One or both schema versions not found' });
      return;
    }

    // Calculate changes
    const oldFieldMap = new Map(oldSchema.fields.map((f: IConnectorSchemaField) => [f.path, f]));
    const newFieldMap = new Map(newSchema.fields.map((f: IConnectorSchemaField) => [f.path, f]));

    const addedFields = newSchema.fields.filter(
      (f: IConnectorSchemaField) => !oldFieldMap.has(f.path),
    );
    const removedFields = oldSchema.fields.filter(
      (f: IConnectorSchemaField) => !newFieldMap.has(f.path),
    );
    const typeChanges = newSchema.fields
      .filter((newField: IConnectorSchemaField) => {
        const oldField = oldFieldMap.get(newField.path) as IConnectorSchemaField | undefined;
        return oldField && oldField.type !== newField.type;
      })
      .map((newField: IConnectorSchemaField) => {
        const oldField = oldFieldMap.get(newField.path) as IConnectorSchemaField;
        return {
          path: newField.path,
          oldType: oldField.type,
          newType: newField.type,
        };
      });

    res.json({
      fromVersion: oldSchema.version,
      toVersion: newSchema.version,
      changes: {
        addedFields: addedFields.map((f: IConnectorSchemaField) => ({
          path: f.path,
          type: f.type,
          label: f.label,
        })),
        removedFields: removedFields.map((f: IConnectorSchemaField) => ({
          path: f.path,
          type: f.type,
          label: f.label,
        })),
        typeChanges,
      },
    });
  } catch (error) {
    logger.error('Failed to get schema changes', {
      connectorId: req.params.connectorId,
      tenantId: req.tenantContext?.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get schema changes' });
  }
});

/**
 * GET /:knowledgeBaseId - Get canonical schema (Layer 2)
 *
 * Returns the canonical (normalized) field schema for a knowledge base.
 */
router.get('/:knowledgeBaseId', async (req: Request, res: Response) => {
  try {
    const { knowledgeBaseId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { version } = req.query;

    const schemaKeys = await resolveCanonicalSchemaKeys(req, knowledgeBaseId);
    if (!schemaKeys) {
      res.status(404).json({ error: 'Canonical schema not found' });
      return;
    }

    const filter: Record<string, unknown> = {};
    if (version) {
      filter.version = parseInt(version as string, 10);
    }

    // Get latest version if no version specified
    const schema = await findLatestCanonicalSchema(schemaKeys, tenantId, filter);

    if (!schema) {
      res.status(404).json({ error: 'Canonical schema not found' });
      return;
    }

    res.json({ schema });
  } catch (error) {
    logger.error('Failed to get canonical schema', {
      knowledgeBaseId: req.params.knowledgeBaseId,
      tenantId: req.tenantContext?.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get canonical schema' });
  }
});

/**
 * PATCH /:knowledgeBaseId - Update canonical schema
 *
 * Updates the canonical schema fields for a knowledge base.
 * Creates a new version if fields change.
 */
router.patch('/:knowledgeBaseId', async (req: Request, res: Response) => {
  try {
    const { knowledgeBaseId } = req.params;
    const tenantId = req.tenantContext!.tenantId;
    const { fields, status, activeFields } = req.body;

    const schemaKeys = await resolveCanonicalSchemaKeys(req, knowledgeBaseId);
    if (!schemaKeys) {
      res.status(404).json({ error: 'Canonical schema not found' });
      return;
    }

    // Get current schema (tenant-scoped)
    const currentSchema = await findLatestCanonicalSchema(schemaKeys, tenantId);

    if (!currentSchema) {
      res.status(404).json({ error: 'Canonical schema not found' });
      return;
    }

    if (fields) {
      // Create a new version with updated fields
      const newVersion = currentSchema.version + 1;
      const newSchema = await CanonicalSchema.create({
        tenantId,
        knowledgeBaseId: currentSchema.knowledgeBaseId,
        version: newVersion,
        fields,
        status: status || 'draft',
      });

      // Carry forward: find ALL mappings from the old schema version
      // so active mappings survive version upgrades
      const oldSchemaId = String(currentSchema._id);
      const oldMappings = await FieldMapping.find({
        canonicalSchemaId: oldSchemaId,
        tenantId,
      }).lean();
      const oldActiveFields = new Set<string>();
      const oldMappingByField = new Map<string, Record<string, unknown>>();
      for (const m of oldMappings as any[]) {
        if (m.status === 'active') {
          oldActiveFields.add(m.canonicalField);
          oldMappingByField.set(m.canonicalField, m);
        }
      }

      // Merge: activeFields from request + carried-forward active mappings
      const activeFieldSet = new Set<string>([
        ...oldActiveFields,
        ...(Array.isArray(activeFields) ? (activeFields as string[]) : []),
      ]);

      const schemaId = String(newSchema._id);
      const seen = new Set<string>();
      const mappingDocs = (fields as Array<{ name: string; storageField?: string }>)
        .filter((f) => {
          if (seen.has(f.name)) return false;
          seen.add(f.name);
          return true;
        })
        .map((f) => {
          const isActive = activeFieldSet.has(f.name);
          const oldMapping = oldMappingByField.get(f.name);
          return {
            tenantId,
            canonicalSchemaId: schemaId,
            canonicalField: f.name,
            connectorId: (oldMapping?.connectorId as string) || 'manual-upload',
            sourcePath: (oldMapping?.sourcePath as string) || f.storageField || f.name,
            transform: (oldMapping?.transform as { type: string }) || {
              type: 'direct' as const,
            },
            confidence: isActive ? ((oldMapping?.confidence as number) ?? 1.0) : 1.0,
            status: isActive ? 'active' : 'auto-applied',
            suggestedBy: isActive ? (oldMapping?.suggestedBy as string) || 'user' : 'schema-auto',
            reviewedBy: isActive ? (oldMapping?.reviewedBy as string) || 'user' : undefined,
            reviewedAt: isActive ? (oldMapping?.reviewedAt as Date) || new Date() : undefined,
          };
        });

      if (mappingDocs.length > 0) {
        try {
          await FieldMapping.insertMany(mappingDocs, { ordered: false });
          logger.info('Auto-created field mappings for new schema version', {
            schemaId,
            version: newVersion,
            mappingCount: mappingDocs.length,
            carriedForward: oldActiveFields.size,
            newActive: activeFieldSet.size - oldActiveFields.size,
          });
        } catch (err: unknown) {
          if ((err as any)?.code !== 11000) {
            logger.warn('Failed to auto-create some field mappings', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      }

      res.json({ schema: newSchema.toObject() });
    } else if (status) {
      // Just update status on current version
      const updated = await CanonicalSchema.findOneAndUpdate(
        { _id: currentSchema._id, tenantId },
        { $set: { status } },
        { new: true },
      ).lean();

      res.json({ schema: updated });
    } else {
      res.status(400).json({ error: 'fields or status is required' });
    }
  } catch (error) {
    logger.error('Failed to update canonical schema', {
      knowledgeBaseId: req.params.knowledgeBaseId,
      tenantId: req.tenantContext?.tenantId,
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to update canonical schema' });
  }
});

/**
 * GET /:knowledgeBaseId/unmapped/:connectorId - Get unmapped connector fields
 *
 * Returns connector fields that don't have a FieldMapping to any canonical field.
 * Used by the UI to show "Unmapped Fields" section.
 */
router.get('/:knowledgeBaseId/unmapped/:connectorId', async (req: Request, res: Response) => {
  try {
    const { knowledgeBaseId, connectorId } = req.params;
    const tenantId = req.tenantContext!.tenantId;

    if (
      !(await resolveCanonicalSchemaKeys(req, knowledgeBaseId)) ||
      !(await assertConnectorIndexAccess(req, connectorId, knowledgeBaseId))
    ) {
      res.status(404).json({ error: 'Canonical schema not found' });
      return;
    }

    // Get canonical schema
    const schemaKeys = await resolveCanonicalSchemaKeys(req, knowledgeBaseId);
    const schema = schemaKeys
      ? await findLatestCanonicalSchema(schemaKeys, tenantId, { status: 'active' })
      : null;

    if (!schema) {
      res.status(404).json({ error: 'Canonical schema not found' });
      return;
    }

    // Get all active mappings for this connector
    const mappings = await FieldMapping.find({
      canonicalSchemaId: schema._id,
      connectorId,
      tenantId,
      status: { $in: ['suggested', 'confirmed'] },
    }).lean();

    const mappedSourcePaths = new Set(mappings.map((m: any) => m.sourcePath));

    // Get connector schema
    const connectorSchema = await ConnectorSchema.findOne({
      connectorId,
      tenantId,
    })
      .sort({ version: -1 })
      .lean();

    if (!connectorSchema) {
      res.json({ unmappedFields: [], connectorId });
      return;
    }

    // Filter to unmapped fields
    const unmappedFields = (connectorSchema.fields as IConnectorSchemaField[]).filter(
      (f) => !mappedSourcePaths.has(f.path),
    );

    res.json({
      connectorId,
      totalFields: connectorSchema.fields.length,
      mappedCount: mappedSourcePaths.size,
      unmappedFields: unmappedFields.map((f) => ({
        path: f.path,
        label: f.label,
        type: f.type,
        isCustom: f.isCustom,
        sampleValues: f.sampleValues?.slice(0, 5),
        enumValues: f.enumValues,
      })),
    });
  } catch (error) {
    logger.error('Failed to get unmapped fields', {
      error: error instanceof Error ? error.message : String(error),
    });
    res.status(500).json({ error: 'Failed to get unmapped fields' });
  }
});

export default router;
