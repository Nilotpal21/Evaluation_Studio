import { createLogger } from '@agent-platform/shared-observability';
import type { DiscoveredSchema, DiscoveredField } from './SchemaDiscoveryService.js';
import type { IDiscoveredSchema, IDiscoveredSchemaField } from '@agent-platform/database/models';

const logger = createLogger('discovered-schema-persistence');

// ─── Types ──────────────────────────────────────────────────────────────

export interface PersistDiscoveredSchemaOptions {
  /** Discovered schema from the discovery pipeline */
  schema: DiscoveredSchema;
  /** Links to SearchIndex._id */
  knowledgeBaseId: string;
}

// ─── Field Conversion ───────────────────────────────────────────────────

/**
 * Convert service-layer DiscoveredField to MongoDB IDiscoveredSchemaField.
 * Flattens the metadata object into top-level fields.
 */
export function toSchemaField(field: DiscoveredField): IDiscoveredSchemaField {
  return {
    name: field.name,
    type: field.type,
    path: field.path,
    description: field.metadata.description,
    required: field.metadata.required,
    enumValues: field.metadata.enumValues,
    format: field.metadata.format,
    enumDisplayNames: field.metadata.enumDisplayNames,
    enumSource: field.metadata.enumSource,
  };
}

// ─── Persistence Functions ──────────────────────────────────────────────

/**
 * Upsert a discovered schema to MongoDB.
 *
 * Uses compound key {tenantId, knowledgeBaseId, connectorId} for upsert.
 * Increments version on update, sets version=1 on insert.
 */
export async function upsertDiscoveredSchema(
  options: PersistDiscoveredSchemaOptions,
  // Injected model for testability — production callers pass the Mongoose model
  model: {
    findOneAndUpdate: (...args: any[]) => any;
  },
): Promise<IDiscoveredSchema> {
  const { schema, knowledgeBaseId } = options;
  const { tenantId, connectorId, discoveryMethod, discoveredAt, metadata } = schema;

  // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-persist.start' when TraceStore is injected
  logger.info('Persisting discovered schema', {
    tenantId,
    connectorId,
    knowledgeBaseId,
    fieldCount: schema.fields.length,
  });

  const fields = schema.fields.map(toSchemaField);

  try {
    const result = await model.findOneAndUpdate(
      { tenantId, knowledgeBaseId, connectorId },
      {
        $set: {
          fields,
          fieldCount: fields.length,
          discoveryMethod,
          discoveredAt,
          status: 'active',
          metadata,
        },
        $inc: { version: 1, _v: 1 },
      },
      { upsert: true, new: true },
    );

    // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-persist.complete' when TraceStore is injected
    logger.info('Discovered schema persisted', {
      tenantId,
      connectorId,
      knowledgeBaseId,
      schemaId: result._id,
      version: result.version,
      fieldCount: result.fieldCount,
    });

    return result;
  } catch (err: unknown) {
    // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-persist.error' when TraceStore is injected
    const message = err instanceof Error ? err.message : String(err);
    logger.error('Failed to persist discovered schema', {
      tenantId,
      connectorId,
      knowledgeBaseId,
      error: message,
    });
    throw err;
  }
}

/**
 * Get the latest discovered schema for a connector + knowledge base.
 * Returns null if no schema has been discovered yet.
 */
export async function getDiscoveredSchema(
  tenantId: string,
  knowledgeBaseId: string,
  connectorId: string,
  model: {
    findOne: (...args: any[]) => any;
  },
): Promise<IDiscoveredSchema | null> {
  return model.findOne({ tenantId, knowledgeBaseId, connectorId }).lean();
}

/**
 * Get all discovered schemas for a knowledge base.
 * Used by FieldsTab UI to show all connector schemas.
 */
export async function getSchemasByKnowledgeBase(
  tenantId: string,
  knowledgeBaseId: string,
  model: {
    find: (...args: any[]) => any;
  },
): Promise<IDiscoveredSchema[]> {
  return model.find({ tenantId, knowledgeBaseId }).lean();
}
