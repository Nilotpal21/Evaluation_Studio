/**
 * Schema Sync Worker
 *
 * Discovers source connector schema on-demand or via scheduled sync.
 * Creates ConnectorSchema documents and marks affected FieldMappings for review.
 */

import { Worker, type Job } from 'bullmq';
import { QUEUE_SCHEMA_SYNC } from '@agent-platform/search-ai-sdk';
import { withTenantContext } from '@agent-platform/database/mongo';
import { getLazyModel } from '../db/index.js';
import { createWorkerOptions, workerLog, workerError, withTraceContext } from './shared.js';
import { getDiscoveryService } from '../services/schema-discovery/index.js';

// M-3 FIX: ConnectorConfig interface (simplified - full model TBD)
interface IConnectorConfig {
  _id: string;
  tenantId: string;
  oauthTokenId: string | null;
  connectionConfig: Record<string, unknown>;
}

// Models accessed via getLazyModel (dual-database pattern)
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');

// ─── Job Data ────────────────────────────────────────────────────────────────

/**
 * M-3 FIX: Store reference to credentials, not raw credentials in Redis.
 * connectorConfigId references ConnectorConfig.oauthTokenId or connectionConfig.
 */
export interface SchemaSyncJobData {
  connectorId: string;
  tenantId: string;
  connectorType: string;
  connectorConfigId: string; // References ConnectorConfig._id
  trigger: 'manual' | 'scheduled' | 'on_connect';
}

// ─── Processor ───────────────────────────────────────────────────────────────

export async function processSchemaSync(job: Job<SchemaSyncJobData>): Promise<void> {
  const { connectorId, tenantId, connectorType, connectorConfigId, trigger } = job.data;

  workerLog('schema-sync', `Starting schema discovery for connector ${connectorId}`, {
    connectorId,
    tenantId,
    connectorType,
    trigger,
  });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      try {
        // M-3 FIX: Fetch credentials from database, not from Redis job data
        const connectorConfig = await ConnectorConfig.findOne({
          _id: connectorConfigId,
          tenantId,
        });

        if (!connectorConfig) {
          throw new Error(`ConnectorConfig ${connectorConfigId} not found for tenant ${tenantId}`);
        }

        // Build credentials object from config (OAuth token or connection config)
        const credentials = connectorConfig.oauthTokenId
          ? { oauthTokenId: connectorConfig.oauthTokenId }
          : connectorConfig.connectionConfig;

        // Get discovery service for connector type
        const discoveryService = getDiscoveryService(connectorType);

        // Discover schema
        const discoveryResult = await discoveryService.discover(connectorId, tenantId, credentials);

        // Save schema (creates new version if changes detected)
        const schema = await discoveryService.saveSchema(connectorId, tenantId, discoveryResult);

        workerLog('schema-sync', `Schema discovery completed for connector ${connectorId}`, {
          connectorId,
          tenantId,
          schemaId: schema._id,
          version: schema.version,
          fieldCount: discoveryResult.fieldCount,
          customFieldCount: discoveryResult.customFieldCount,
        });
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : 'Unknown error during schema discovery';

        workerError(
          'schema-sync',
          `Schema discovery failed for connector ${connectorId}: ${errorMessage}`,
          error instanceof Error ? error : new Error(errorMessage),
        );

        throw error;
      }
    }),
  );
}

// ─── Worker Factory ──────────────────────────────────────────────────────────

export default function createSchemaSyncWorker(concurrency = 2): Worker<SchemaSyncJobData> {
  const worker = new Worker(QUEUE_SCHEMA_SYNC, processSchemaSync, createWorkerOptions(concurrency));

  worker.on('failed', (job, err) =>
    workerError(
      'schema-sync',
      `Job ${job?.id} failed`,
      err instanceof Error ? err : new Error(String(err)),
    ),
  );

  worker.on('completed', (job) =>
    workerLog('schema-sync', `Job ${job.id} completed`, { connectorId: job.data.connectorId }),
  );

  return worker;
}
