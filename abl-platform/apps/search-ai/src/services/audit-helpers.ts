/**
 * Audit Helper Functions
 *
 * Fire-and-forget audit event creators for search engine operations.
 * Each function writes an audit log entry for compliance and traceability.
 */

import { createLogger } from '@abl/compiler/platform';
import {
  buildSearchAIAuditPipelineEvent,
  publishSearchAIAuditPipelineEvent,
} from './search-ai-audit-pipeline-writer.js';

// =============================================================================
// TYPES
// =============================================================================

const logger = createLogger('search-ai-audit-helpers');

interface AuditEventBase {
  tenantId: string;
  userId?: string;
}

interface IndexAuditEvent extends AuditEventBase {
  indexId: string;
  indexName: string;
  projectId: string;
}

interface SourceAuditEvent extends AuditEventBase {
  indexId: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  projectId?: string;
}

interface SchemaAuditEvent extends AuditEventBase {
  connectorId?: string;
  knowledgeBaseId?: string;
  projectId?: string;
  version: number;
  fieldCount: number;
}

interface MappingAuditEvent extends AuditEventBase {
  mappingId: string;
  canonicalSchemaId: string;
  connectorId: string;
  canonicalField: string;
  sourcePath: string;
  projectId?: string;
  reviewedBy?: string;
}

interface VocabularyAuditEvent extends AuditEventBase {
  projectKnowledgeBaseId: string;
  projectId?: string;
  version: number;
  entryCount: number;
}

// =============================================================================
// AUDIT WRITER
// =============================================================================

interface SharedAuditWriteOptions {
  tenantId: string;
  userId?: string;
  projectId?: string;
  resourceType: string;
  resourceId: string;
}

async function writeAuditLog(
  action: string,
  metadata: Record<string, unknown>,
  options: SharedAuditWriteOptions,
): Promise<void> {
  try {
    const event = buildSearchAIAuditPipelineEvent({
      eventType: action,
      action,
      actorId: options.userId ?? null,
      actorType: options.userId ? 'user' : 'system',
      tenantId: options.tenantId,
      projectId: options.projectId ?? null,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      metadata,
    });
    publishSearchAIAuditPipelineEvent(event, options.tenantId);
  } catch (error) {
    logger.warn('SearchAI audit helper publish failed', {
      action,
      tenantId: options.tenantId,
      resourceType: options.resourceType,
      resourceId: options.resourceId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

// =============================================================================
// INDEX EVENTS
// =============================================================================

export function auditIndexCreated(event: IndexAuditEvent): void {
  writeAuditLog(
    'search.index.created',
    {
      tenantId: event.tenantId,
      userId: event.userId,
      indexId: event.indexId,
      indexName: event.indexName,
      projectId: event.projectId,
      resourceType: 'index',
      resourceId: event.indexId,
    },
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      resourceType: 'index',
      resourceId: event.indexId,
    },
  );
}

export function auditIndexUpdated(
  event: IndexAuditEvent & { changes: Record<string, unknown> },
): void {
  writeAuditLog(
    'search.index.updated',
    {
      tenantId: event.tenantId,
      userId: event.userId,
      indexId: event.indexId,
      indexName: event.indexName,
      projectId: event.projectId,
      changes: event.changes,
      resourceType: 'index',
      resourceId: event.indexId,
    },
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      resourceType: 'index',
      resourceId: event.indexId,
    },
  );
}

export function auditIndexDeleted(event: IndexAuditEvent): void {
  writeAuditLog(
    'search.index.deleted',
    {
      tenantId: event.tenantId,
      userId: event.userId,
      indexId: event.indexId,
      indexName: event.indexName,
      projectId: event.projectId,
      resourceType: 'index',
      resourceId: event.indexId,
    },
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      resourceType: 'index',
      resourceId: event.indexId,
    },
  );
}

// =============================================================================
// SOURCE EVENTS
// =============================================================================

export function auditSourceAdded(event: SourceAuditEvent): void {
  writeAuditLog(
    'search.source.added',
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      indexId: event.indexId,
      sourceId: event.sourceId,
      sourceName: event.sourceName,
      sourceType: event.sourceType,
      resourceType: 'source',
      resourceId: event.sourceId,
    },
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      resourceType: 'source',
      resourceId: event.sourceId,
    },
  );
}

export function auditSourceRemoved(event: SourceAuditEvent): void {
  writeAuditLog(
    'search.source.removed',
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      indexId: event.indexId,
      sourceId: event.sourceId,
      sourceName: event.sourceName,
      sourceType: event.sourceType,
      resourceType: 'source',
      resourceId: event.sourceId,
    },
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      resourceType: 'source',
      resourceId: event.sourceId,
    },
  );
}

// =============================================================================
// SCHEMA EVENTS
// =============================================================================

export function auditSchemaDiscovered(event: SchemaAuditEvent): void {
  writeAuditLog(
    'search.schema.discovered',
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      connectorId: event.connectorId,
      knowledgeBaseId: event.knowledgeBaseId,
      version: event.version,
      fieldCount: event.fieldCount,
      resourceType: event.connectorId ? 'connector' : 'knowledge_base',
      resourceId: event.connectorId ?? event.knowledgeBaseId ?? 'unknown',
    },
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      resourceType: event.connectorId ? 'connector' : 'knowledge_base',
      resourceId: event.connectorId ?? event.knowledgeBaseId ?? 'unknown',
    },
  );
}

// =============================================================================
// MAPPING EVENTS
// =============================================================================

export function auditMappingConfirmed(event: MappingAuditEvent): void {
  writeAuditLog(
    'search.mapping.confirmed',
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      mappingId: event.mappingId,
      canonicalSchemaId: event.canonicalSchemaId,
      connectorId: event.connectorId,
      canonicalField: event.canonicalField,
      sourcePath: event.sourcePath,
      reviewedBy: event.reviewedBy,
      resourceType: 'mapping',
      resourceId: event.mappingId,
    },
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      resourceType: 'mapping',
      resourceId: event.mappingId,
    },
  );
}

export function auditMappingRejected(event: MappingAuditEvent): void {
  writeAuditLog(
    'search.mapping.rejected',
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      mappingId: event.mappingId,
      canonicalSchemaId: event.canonicalSchemaId,
      connectorId: event.connectorId,
      canonicalField: event.canonicalField,
      sourcePath: event.sourcePath,
      reviewedBy: event.reviewedBy,
      resourceType: 'mapping',
      resourceId: event.mappingId,
    },
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      resourceType: 'mapping',
      resourceId: event.mappingId,
    },
  );
}

// =============================================================================
// VOCABULARY EVENTS
// =============================================================================

export function auditVocabularyUpdated(event: VocabularyAuditEvent): void {
  writeAuditLog(
    'search.vocabulary.updated',
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      projectKnowledgeBaseId: event.projectKnowledgeBaseId,
      version: event.version,
      entryCount: event.entryCount,
      resourceType: 'knowledge_base',
      resourceId: event.projectKnowledgeBaseId,
    },
    {
      tenantId: event.tenantId,
      userId: event.userId,
      projectId: event.projectId,
      resourceType: 'knowledge_base',
      resourceId: event.projectKnowledgeBaseId,
    },
  );
}
