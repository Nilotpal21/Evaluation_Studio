/**
 * Schema Discovery Worker
 *
 * BullMQ worker for enriched schema discovery (Stories 1.1-1.7 pipeline).
 * Orchestrates: resolve service → discover → template enrich → persist to MongoDB.
 *
 * DISTINCT from schema-sync-worker.ts (Layer 1 raw ConnectorSchema)
 * and connector-discovery-worker.ts (resource/drive discovery).
 */

import { Worker, type Job } from 'bullmq';
import {
  QUEUE_SCHEMA_DISCOVERY,
  QUEUE_FIELD_MAPPING_SUGGESTION,
} from '@agent-platform/search-ai-sdk';
import { withTenantContext } from '@agent-platform/database/mongo';
import {
  type SchemaDiscoveryService,
  type SchemaDiscoveryOptions,
  applyTemplateEnumPatterns,
  upsertDiscoveredSchema,
} from '@agent-platform/search-ai-internal/services';
import type { IDiscoveredSchema, ISearchSource } from '@agent-platform/database/models';
import { getLazyModel } from '../db/index.js';
import { createQueue, createWorkerOptions, workerLog, workerError } from './shared.js';
import type { FieldMappingSuggestionJobData } from './field-mapping-suggestion-worker.js';

const DiscoveredSchemaModel = getLazyModel<IDiscoveredSchema>('DiscoveredSchema');
const SearchSourceModel = getLazyModel<ISearchSource>('SearchSource');

// ─── Job Data ────────────────────────────────────────────────────────────────

export interface SchemaDiscoveryJobData {
  tenantId: string;
  connectorId: string;
  knowledgeBaseId: string;
  connectorType: string;
  discoveryTrigger: 'activation' | 'manual';
}

// ─── Service Resolver ────────────────────────────────────────────────────────

/**
 * Registry of connector-type → discovery service factory functions.
 *
 * Each factory receives the worker-level dependencies needed to construct
 * the connector-specific discovery service.  New connector types are added
 * by registering a factory here.
 *
 * NOTE: The discovery services in @agent-platform/search-ai-internal require
 * injected ConnectorConfigProvider and ClientFactory dependencies.  Full wiring
 * of these adapters (ConnectorConfig lookup, OAuth token resolution, API client
 * creation) is deferred to Story 1.9 where the API endpoint provides the
 * integration surface.  For now the resolver throws for unsupported types, and
 * tests mock `resolveDiscoveryService` directly.
 */
export type DiscoveryServiceFactory = (connectorType: string) => SchemaDiscoveryService;

let serviceFactory: DiscoveryServiceFactory | undefined;

/**
 * Set the factory used to resolve discovery services.
 * Called at worker startup or overridden in tests.
 */
export function setDiscoveryServiceFactory(factory: DiscoveryServiceFactory): void {
  serviceFactory = factory;
}

/**
 * Resolve a discovery service for the given connector type.
 * Delegates to the registered factory, or throws if none is set.
 */
export function resolveDiscoveryService(connectorType: string): SchemaDiscoveryService {
  if (!serviceFactory) {
    throw new Error(
      'Schema discovery service factory not configured. Call setDiscoveryServiceFactory() at startup.',
    );
  }
  return serviceFactory(connectorType);
}

// ─── Job Processor ───────────────────────────────────────────────────────────

export async function processSchemaDiscoveryJob(job: Job<SchemaDiscoveryJobData>): Promise<void> {
  const { tenantId, connectorId, knowledgeBaseId, connectorType, discoveryTrigger } = job.data;

  // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.started'
  workerLog('schema-discovery', 'Starting schema discovery', {
    connectorId,
    tenantId,
    knowledgeBaseId,
    connectorType,
    discoveryTrigger,
    jobId: job.id,
  });

  await withTenantContext({ tenantId }, async () => {
    try {
      // 1. Resolve connector-specific discovery service
      const discoveryService = resolveDiscoveryService(connectorType);

      // 2. Discover schema via connector API
      const options: SchemaDiscoveryOptions = { connectorId, tenantId };
      const discoveredSchema = await discoveryService.discoverSchema(options);

      await job.updateProgress(50);

      // 3. Apply template enum enrichment
      const enrichedSchema = applyTemplateEnumPatterns(discoveredSchema, connectorType);

      await job.updateProgress(75);

      // 4. Persist to MongoDB
      const persisted = await upsertDiscoveredSchema(
        { schema: enrichedSchema, knowledgeBaseId },
        DiscoveredSchemaModel,
      );

      await job.updateProgress(90);

      // 5. Chain to field-mapping-suggestion worker
      const source = await SearchSourceModel.findOne({
        tenantId,
        indexId: knowledgeBaseId,
      });
      if (source) {
        const fieldMappingQueue = createQueue(QUEUE_FIELD_MAPPING_SUGGESTION);
        await fieldMappingQueue.add(
          'field-mapping-suggestion',
          {
            tenantId,
            connectorId,
            knowledgeBaseId,
            discoveredSchemaId: persisted._id,
            indexId: knowledgeBaseId,
            connectorType,
          } as FieldMappingSuggestionJobData,
          {
            jobId: `${connectorId}-field-mapping-${Date.now()}`,
            removeOnComplete: { age: 86400 },
            removeOnFail: { age: 604800 },
          },
        );

        workerLog('schema-discovery', 'Chained to field-mapping-suggestion worker', {
          connectorId,
          tenantId,
          knowledgeBaseId,
          discoveredSchemaId: persisted._id,
        });
      }

      await job.updateProgress(100);

      // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.completed'
      workerLog('schema-discovery', 'Schema discovery completed', {
        connectorId,
        tenantId,
        knowledgeBaseId,
        schemaId: persisted._id,
        version: persisted.version,
        fieldCount: persisted.fieldCount,
        discoveryTrigger,
      });
    } catch (error: unknown) {
      const errMsg = error instanceof Error ? error.message : String(error);

      // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.failed'
      workerError('schema-discovery', `Schema discovery failed: ${errMsg}`, error);
      throw error; // BullMQ retries based on job options
    }
  });
}

// ─── Worker Factory ──────────────────────────────────────────────────────────

export default function createSchemaDiscoveryWorker(
  concurrency = 2,
): Worker<SchemaDiscoveryJobData> {
  const worker = new Worker<SchemaDiscoveryJobData>(
    QUEUE_SCHEMA_DISCOVERY,
    processSchemaDiscoveryJob,
    createWorkerOptions(concurrency),
  );

  worker.on('completed', (job) => {
    workerLog('schema-discovery', `Job ${job.id} completed`);
  });

  worker.on('failed', (job, err) => {
    workerError('schema-discovery', `Job ${job?.id} failed`, err);
  });

  worker.on('error', (err) => {
    workerError('schema-discovery', 'Worker error', err);
  });

  workerLog('schema-discovery', `Started with concurrency=${concurrency}`);
  return worker;
}
