/**
 * Connector Permission Crawl Worker
 *
 * Background worker for crawling document permissions from connectors.
 * Runs permission crawl as a long-running job with progress tracking.
 *
 * Job types:
 * - connector:permission-crawl — Crawl permissions for all documents in a connector
 *
 * Flow: API triggers job → Worker executes crawl → Updates status in DB
 */

import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import type {
  IConnectorConfig,
  ISearchSource,
  ISearchDocument,
  IEndUserOAuthToken,
} from '@agent-platform/database/models';
import {
  Contact,
  AclGroupHierarchy,
  AclDocumentPermissions,
} from '@agent-platform/database/models';
import type { ISyncCheckpoint, IDriveDeltaToken } from '@agent-platform/database';
import { withTenantContext } from '@agent-platform/database/mongo';
import { MongoPermissionStore } from '@agent-platform/search-ai-internal/permissions';
import { getLazyModel } from '../db/index.js';
import {
  createWorkerOptions,
  workerLog,
  workerError,
  withTraceContext,
  createBlindIndexFn,
  createEncryptFn,
} from './shared.js';
import { SharePointConnector } from '@agent-platform/connector-sharepoint';
import type { PermissionCrawlResult } from '@agent-platform/connectors-base';

// Models bound to correct databases via dual-connection
const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const SearchSource = getLazyModel<ISearchSource>('SearchSource');
const SearchDocument = getLazyModel<ISearchDocument>('SearchDocument');
const SyncCheckpoint = getLazyModel<ISyncCheckpoint>('SyncCheckpoint');
const EndUserOAuthToken = getLazyModel<IEndUserOAuthToken>('EndUserOAuthToken');
const DriveDeltaToken = getLazyModel<IDriveDeltaToken>('DriveDeltaToken');

// ============================================================================
// Queue Names
// ============================================================================

export const QUEUE_CONNECTOR_PERMISSION_CRAWL = 'connector-permission-crawl';

// ============================================================================
// Job Data Interface
// ============================================================================

export interface ConnectorPermissionCrawlJobData {
  connectorId: string;
  tenantId: string;
  mode: 'full' | 'simplified' | 'enabled' | 'disabled';
}

// ============================================================================
// Worker Processor
// ============================================================================

async function processPermissionCrawlJob(job: Job<ConnectorPermissionCrawlJobData>): Promise<void> {
  const { connectorId, tenantId, mode } = job.data;

  workerLog('connector-permission-crawl', `Processing permission crawl job ${job.id}`, {
    connectorId,
    tenantId,
    mode,
  });

  await withTraceContext(job.data as unknown as Record<string, unknown>, () =>
    withTenantContext({ tenantId }, async () => {
      // 1. Load connector configuration
      const config = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
      if (!config) {
        throw new Error(`Connector ${connectorId} not found`);
      }

      try {
        // 2. Update permission state to in-progress
        await ConnectorConfig.findOneAndUpdate(
          { _id: connectorId, tenantId },
          {
            'permissionConfig.currentJobId': job.id,
            'permissionConfig.crawlInProgress': true,
            'permissionConfig.lastCrawlError': null,
          },
        );

        // 3. Initialize connector
        let connector: any;
        switch (config.connectorType) {
          case 'sharepoint':
            connector = new SharePointConnector(config.toObject(), EndUserOAuthToken, {
              SearchDocument,
              SearchSource,
              SyncCheckpoint,
              ConnectorConfig,
              DriveDeltaToken,
            });
            await connector.initialize();
            break;
          default:
            throw new Error(`Unsupported connector type: ${config.connectorType}`);
        }

        // 4. Perform permission crawl
        const result: PermissionCrawlResult = await connector.crawlPermissions(mode);

        // 5. BFS recompute effective groups for all contacts in the tenant.
        //    The permission crawler calls setMembership() which populates
        //    acl.directGroups, but the query-time getUserGroups() reads
        //    acl.effectiveGroups. Without this step, user-mode queries
        //    return 0 results because effectiveGroups stays empty.
        const mongoPermissionStore = MongoPermissionStore.getInstance({
          contactModel: Contact as any,
          groupHierarchyModel: AclGroupHierarchy as any,
          documentPermissionsModel: AclDocumentPermissions as any,
          blindIndexFn: createBlindIndexFn(),
          encryptFn: createEncryptFn(),
        });
        const recomputedContacts =
          await mongoPermissionStore.recomputeEffectiveGroupsForTenant(tenantId);

        workerLog('connector-permission-crawl', 'BFS effective groups recomputation complete', {
          connectorId,
          tenantId,
          contactsRecomputed: recomputedContacts,
        });

        // 6. Update progress to 100%
        await job.updateProgress(100);

        // 7. Update permission state with success
        const now = new Date();
        await ConnectorConfig.findOneAndUpdate(
          { _id: connectorId, tenantId },
          {
            'permissionConfig.currentJobId': null,
            'permissionConfig.crawlInProgress': false,
            'permissionConfig.lastCrawlAt': now,
            'permissionConfig.documentsProcessed': result.documentsProcessed,
            'permissionConfig.averageAccuracy': result.averageAccuracy,
            'permissionConfig.lastCrawlError': null,
          },
        );

        workerLog('connector-permission-crawl', `Permission crawl completed successfully`, {
          connectorId,
          documentsProcessed: result.documentsProcessed,
          averageAccuracy: result.averageAccuracy,
          duration: result.durationMs,
        });
      } catch (error) {
        // Update permission state with error
        const errMsg = error instanceof Error ? error.message : String(error);
        await ConnectorConfig.findOneAndUpdate(
          { _id: connectorId, tenantId },
          {
            'permissionConfig.currentJobId': null,
            'permissionConfig.crawlInProgress': false,
            'permissionConfig.lastCrawlError': errMsg,
          },
        );

        workerError('connector-permission-crawl', `Permission crawl failed`, error);
        throw error;
      }
    }),
  );
}

// ============================================================================
// Worker Instance
// ============================================================================

export const connectorPermissionCrawlWorker = new Worker(
  QUEUE_CONNECTOR_PERMISSION_CRAWL,
  processPermissionCrawlJob,
  createWorkerOptions(2), // Process two crawls concurrently per worker
);

connectorPermissionCrawlWorker.on('completed', (job) => {
  workerLog('connector-permission-crawl', `Job ${job.id} completed`);
});

connectorPermissionCrawlWorker.on('failed', (job, err) => {
  workerError('connector-permission-crawl', `Job ${job?.id} failed`, err);
});

export default connectorPermissionCrawlWorker;
