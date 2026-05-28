/**
 * Connector Field Configuration Routes
 *
 * Pre-sync field mapping endpoints — allows users to configure field mappings
 * and embedding selections before the first sync starts.
 *
 * GET  /:indexId/connectors/:connectorId/field-preview  — Get field preview with auto-suggestions
 * PUT  /:indexId/connectors/:connectorId/field-config   — Save field config before sync
 *
 * Completely generic — no per-connector logic. Uses connector-type-templates
 * and optional ISchemaIntrospection for field discovery.
 */

import { Router, type Router as RouterType } from 'express';
import type { Request, Response } from 'express';
import { z } from 'zod';
import { createLogger } from '@abl/compiler/platform';
import { getLazyModel } from '../db/index.js';
import type {
  IConnectorConfig,
  ICanonicalSchema,
  IFieldMapping,
} from '@agent-platform/database/models';
import { getAvailableField, toCanonicalField } from '@agent-platform/search-ai-internal/canonical';
import { generateFieldPreview } from '../services/connector-field-preview.service.js';
import { getCanonicalMapperService } from '../services/canonical-mapping/index.js';
import type { IntrospectedField } from '@agent-platform/connectors-base';
import { requireConnectorIndexAccessFromParams } from './searchai-route-ownership.js';

const logger = createLogger('connector-field-config');
const router: RouterType = Router();
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const CanonicalSchema = getLazyModel<ICanonicalSchema>('CanonicalSchema');
const FieldMapping = getLazyModel<IFieldMapping>('FieldMapping');

router.use('/:indexId/connectors/:connectorId', requireConnectorIndexAccessFromParams());

// ─── Validation ───────────────────────────────────────────────────────────

const fieldConfigBody = z.strictObject({
  fields: z.array(
    z.strictObject({
      sourcePath: z.string().min(1),
      displayName: z.string().min(1),
      fieldType: z.string().min(1),
      selected: z.boolean(),
      includeInEmbedding: z.boolean(),
      canonicalMapping: z.string().nullable(),
      confidence: z.number().min(0).max(1),
      mappingSource: z.enum(['template', 'introspection', 'rule', 'llm', 'fallback', 'user']),
      sampleValues: z.array(z.string()).optional(),
    }),
  ),
  autoSuggestApplied: z.boolean().optional(),
});

// ─── GET field-preview ────────────────────────────────────────────────────

/**
 * GET /:indexId/connectors/:connectorId/field-preview
 *
 * Returns merged field list with auto-suggestions for the pre-sync mapping screen.
 * Sources: connector-type-templates (always) + ISchemaIntrospection (when available).
 */
router.get(
  '/:indexId/connectors/:connectorId/field-preview',
  async (req: Request, res: Response) => {
    try {
      const { indexId, connectorId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      // Load connector config
      const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId }).lean();
      if (!connector) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Connector not found' },
        });
        return;
      }

      // Try schema introspection (generic — calls connector.getSchemaIntrospection())
      // For now, pass empty array. Each connector will implement introspectSchema()
      // incrementally. Until then, templates provide the fields.
      const introspectedFields: IntrospectedField[] = [];

      // TODO: When connector factory is available, do:
      // const connectorInstance = await connectorFactory.create(connector);
      // const introspection = connectorInstance.getSchemaIntrospection?.();
      // if (introspection) introspectedFields = await introspection.introspectSchema();

      // Generate field preview (generic — works for all connector types)
      const preview = await generateFieldPreview(
        connector.connectorType,
        introspectedFields,
        tenantId,
        indexId,
      );

      res.json({
        success: true,
        data: {
          ...preview,
          existingConfig: connector.fieldConfig ?? null,
        },
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to generate field preview', { error: msg });
      res.status(500).json({
        success: false,
        error: { code: 'FIELD_PREVIEW_FAILED', message: msg },
      });
    }
  },
);

// ─── PUT field-config ─────────────────────────────────────────────────────

/**
 * PUT /:indexId/connectors/:connectorId/field-config
 *
 * Save the user's field mapping selections before sync.
 * Creates FieldMapping + CanonicalSchema records for mapped fields.
 */
router.put(
  '/:indexId/connectors/:connectorId/field-config',
  async (req: Request, res: Response) => {
    try {
      const { indexId, connectorId } = req.params;
      const tenantId = req.tenantContext!.tenantId;

      // Validate body
      const parsed = fieldConfigBody.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({
          success: false,
          error: { code: 'INVALID_BODY', message: parsed.error.message },
        });
        return;
      }

      // Load connector
      const connector = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
      if (!connector) {
        res.status(404).json({
          success: false,
          error: { code: 'NOT_FOUND', message: 'Connector not found' },
        });
        return;
      }

      const existingVersion = connector.fieldConfig?.version ?? 0;
      const { fields, autoSuggestApplied } = parsed.data;
      const selectedFields = fields.filter((f) => f.selected);
      const embeddingFields = selectedFields.filter((f) => f.includeInEmbedding);

      // 1. Save fieldConfig on ConnectorConfig
      await ConnectorConfig.findOneAndUpdate(
        { _id: connectorId, tenantId },
        {
          $set: {
            fieldConfig: {
              version: existingVersion + 1,
              fields,
              updatedAt: new Date(),
              autoSuggestApplied: autoSuggestApplied ?? false,
              source: 'merged',
            },
          },
        },
      );

      // 2. Create/update CanonicalSchema + FieldMapping records
      let mappingCount = 0;
      try {
        // Find canonical schema for this KB
        let canonicalSchema = await CanonicalSchema.findOne({
          knowledgeBaseId: indexId,
          tenantId,
          status: 'active',
        });

        if (!canonicalSchema) {
          canonicalSchema = await CanonicalSchema.create({
            tenantId,
            knowledgeBaseId: indexId,
            version: 1,
            fields: [],
            status: 'active',
          });
          logger.info('Auto-created CanonicalSchema for connector field config', {
            canonicalSchemaId: canonicalSchema._id,
            connectorId,
          });
        }

        // Delete existing pre-sync mappings for this connector
        await FieldMapping.deleteMany({
          canonicalSchemaId: canonicalSchema._id,
          connectorId,
          tenantId,
        });

        // Build new FieldMapping docs + canonical fields
        const newMappingDocs: Partial<IFieldMapping>[] = [];
        const newCanonicalFields: ReturnType<typeof toCanonicalField>[] = [];
        const existingStorageFields = new Set(
          ((canonicalSchema.fields as any[]) || []).map((f: any) => f.storageField),
        );

        for (const field of selectedFields) {
          if (!field.canonicalMapping) continue;

          newMappingDocs.push({
            tenantId,
            canonicalSchemaId: canonicalSchema._id,
            canonicalField: field.canonicalMapping,
            connectorId,
            sourcePath: field.sourcePath,
            transform: { type: 'direct' },
            confidence: field.confidence,
            status: 'active',
            suggestedBy: field.mappingSource === 'user' ? 'user' : 'rules',
            reviewedBy: 'system',
            reviewedAt: new Date(),
          } as Partial<IFieldMapping>);

          // Ensure canonical field exists in schema
          if (!existingStorageFields.has(field.canonicalMapping)) {
            const availField = getAvailableField(field.canonicalMapping);
            if (availField) {
              const cf = toCanonicalField(availField);
              cf.name = field.displayName;
              cf.label = field.displayName;
              newCanonicalFields.push(cf);
              existingStorageFields.add(field.canonicalMapping);
            }
          }
        }

        // Update canonical schema with new fields
        if (newCanonicalFields.length > 0) {
          const existingFields = canonicalSchema.fields || [];
          await CanonicalSchema.findOneAndUpdate(
            { _id: canonicalSchema._id, tenantId },
            { $set: { fields: [...existingFields, ...newCanonicalFields] } },
          );
        }

        // Bulk insert field mappings
        if (newMappingDocs.length > 0) {
          await FieldMapping.insertMany(newMappingDocs);
          mappingCount = newMappingDocs.length;
          logger.info('Created field mappings for connector pre-sync config', {
            connectorId,
            mappingCount,
            canonicalSchemaId: canonicalSchema._id,
          });
        }

        // Invalidate mapping cache
        try {
          const service = getCanonicalMapperService();
          await service.invalidateCache(connectorId, tenantId);
        } catch (cacheErr) {
          logger.warn('Failed to invalidate cache after field config save', {
            error: cacheErr instanceof Error ? cacheErr.message : String(cacheErr),
          });
        }
      } catch (mappingError) {
        // Non-fatal — field config is saved, mappings are best-effort
        logger.warn('Failed to create field mappings for connector', {
          error: mappingError instanceof Error ? mappingError.message : String(mappingError),
          connectorId,
        });
      }

      res.json({
        success: true,
        data: {
          version: existingVersion + 1,
          fieldCount: fields.length,
          selectedCount: selectedFields.length,
          embeddingFieldCount: embeddingFields.length,
          mappingCount,
        },
      });

      logger.info('Connector field config saved', {
        connectorId,
        indexId,
        version: existingVersion + 1,
        selectedFields: selectedFields.length,
        embeddingFields: embeddingFields.length,
        mappingCount,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      logger.error('Failed to save connector field config', { error: msg });
      res.status(500).json({
        success: false,
        error: { code: 'SAVE_FIELD_CONFIG_FAILED', message: msg },
      });
    }
  },
);

export default router;
