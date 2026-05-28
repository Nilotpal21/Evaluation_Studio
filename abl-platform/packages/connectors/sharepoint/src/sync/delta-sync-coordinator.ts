/**
 * SharePoint Delta Sync Coordinator
 *
 * Implements incremental sync using Microsoft Graph delta queries.
 * Only fetches changes since last sync using per-drive delta tokens.
 *
 * Delta tokens are drive-specific in Microsoft Graph. This coordinator:
 * - Maintains a separate token for each drive
 * - Handles item deletions via @removed flag
 * - Persists tokens after processing each drive
 * - Falls back to full sync if no token exists for a drive
 */

import {
  BaseSyncCoordinator,
  type SourceDocument,
  type SyncCoordinatorModels,
} from '@agent-platform/connectors-base';
import type { IConnectorConfig, ISyncCheckpoint } from '@agent-platform/database';
import type { IFilterEngine } from '@agent-platform/connectors-base';
import { SharePointFilterEngine } from '../filters/sharepoint-filter-engine.js';
import { GraphClient } from '../client/graph-client.js';
import type { Site, Drive } from '../client/graph-types.js';
import { DeltaTokenManager } from './delta-token-manager.js';
import { SharePointPermissionCrawler } from '../permissions/sharepoint-permission-crawler.js';
import type {
  DocumentToCrawl,
  PermissionCrawlConfig,
} from '../permissions/sharepoint-permission-crawler.js';

// ─── SharePoint Delta Sync Coordinator ───────────────────────────────────

export class SharePointDeltaSyncCoordinator extends BaseSyncCoordinator {
  private readonly graphClient: GraphClient;
  private readonly deltaTokenManager: DeltaTokenManager;

  constructor(
    config: IConnectorConfig,
    filterEngine: IFilterEngine,
    graphClient: GraphClient,
    models: SyncCoordinatorModels,
    deltaTokenManager?: DeltaTokenManager,
  ) {
    super(config, filterEngine, models);
    this.graphClient = graphClient;
    this.deltaTokenManager =
      deltaTokenManager ||
      new DeltaTokenManager(config.tenantId, config._id, models.DriveDeltaToken);
  }

  /**
   * Fetch documents using delta query with per-drive tokens.
   * Only returns changed documents since last sync.
   */
  async fetchDocuments(checkpoint: ISyncCheckpoint | null): Promise<SourceDocument[]> {
    const documents: SourceDocument[] = [];
    const deletedItemIds: string[] = [];

    // Get sites (filtered by connector config)
    const sites = await this.getSitesFiltered();

    for (const site of sites) {
      // Get drives (document libraries) in site
      const drives = await this.getDrivesFiltered(site);

      for (const drive of drives) {
        // Get delta token for this specific drive
        const deltaToken = await this.deltaTokenManager.getToken(drive.id);

        if (!deltaToken) {
          // No token exists - this drive needs a full sync first
          console.warn(
            `[DeltaSync] No delta token for drive ${drive.id} (${drive.name}). Skipping - run full sync first.`,
          );
          continue;
        }

        try {
          // Get delta changes for this drive
          const deltaResponse = await this.graphClient.getDeltaItems(drive.id, deltaToken);

          let itemsProcessed = 0;

          // Process changed items
          for (const item of deltaResponse.value) {
            // Skip folders
            if (item.folder) {
              continue;
            }

            // Handle deletions
            if ((item as any)['@removed']) {
              deletedItemIds.push(item.id);
              itemsProcessed++;
              continue;
            }

            // Map changed/new item to SourceDocument
            const sourceDoc = this.mapToSourceDocument(site, drive, item);
            documents.push(sourceDoc);
            itemsProcessed++;
          }

          // Persist new delta token for this drive
          if (deltaResponse['@odata.deltaLink']) {
            await this.deltaTokenManager.saveToken(
              drive.id,
              deltaResponse['@odata.deltaLink'],
              itemsProcessed,
            );

            console.log(
              `[DeltaSync] Processed ${itemsProcessed} changes for drive ${drive.id} (${drive.name})`,
            );
          }
        } catch (error: any) {
          console.error(
            `[DeltaSync] Failed to process drive ${drive.id} (${drive.name}):`,
            error.message,
          );
          // Continue with other drives instead of failing entire sync
          // Token will be reused on next attempt
        }
      }
    }

    // Mark deleted documents in bulk
    if (deletedItemIds.length > 0) {
      await this.markDocumentsDeleted(deletedItemIds);
      console.log(`[DeltaSync] Marked ${deletedItemIds.length} documents as deleted`);
    }

    return documents;
  }

  /**
   * Mark documents as deleted in the database.
   * Uses soft deletion to preserve document history and enable undelete workflows.
   */
  private async markDocumentsDeleted(itemIds: string[]): Promise<void> {
    await this.models.SearchDocument.updateMany(
      {
        tenantId: this.config.tenantId,
        sourceId: this.config.sourceId,
        'metadata.sharepoint.itemId': { $in: itemIds },
      },
      {
        $set: {
          isDeleted: true,
          deletedAt: new Date(),
        },
      },
    );
  }

  /**
   * Get delta token for incremental sync.
   * This method is required by BaseSyncCoordinator but not used directly.
   * Per-drive tokens are managed by DeltaTokenManager instead.
   *
   * @deprecated Use DeltaTokenManager.getToken(driveId) for per-drive tokens
   */
  async getDeltaToken(): Promise<string | null> {
    // Legacy method - not used in refactored implementation
    // Per-drive tokens accessed via this.deltaTokenManager.getToken(driveId)
    return null;
  }

  /**
   * Get sites with scope filter applied.
   */
  private async getSitesFiltered(): Promise<Site[]> {
    const allSites = await this.graphClient.getSites();

    const spEngine = this.filterEngine instanceof SharePointFilterEngine ? this.filterEngine : null;

    if (!spEngine) {
      return allSites;
    }

    const scope = spEngine.getSharePointScope();
    if (scope.siteMode === 'all') {
      return allSites;
    }

    return allSites.filter((site) => spEngine.shouldIncludeSite(site.id, site.webUrl));
  }

  /**
   * Get drives with scope filter applied.
   */
  private async getDrivesFiltered(site: Site): Promise<Drive[]> {
    const allDrives = await this.graphClient.getDrives(site.id);

    const spEngine = this.filterEngine instanceof SharePointFilterEngine ? this.filterEngine : null;

    if (!spEngine) {
      return allDrives;
    }

    const scope = spEngine.getSharePointScope();
    if (scope.libraryMode === 'all') {
      return allDrives;
    }

    return allDrives.filter((drive) => spEngine.shouldIncludeLibrary(drive.name));
  }

  /**
   * Map SharePoint DriveItem to SourceDocument.
   */
  private mapToSourceDocument(site: Site, drive: Drive, item: any): SourceDocument {
    return {
      id: item.id,
      name: item.name,
      url: item.webUrl,
      contentType: item.file?.mimeType || 'application/octet-stream',
      sizeBytes: item.size,
      modifiedAt: new Date(item.lastModifiedDateTime),
      createdAt: new Date(item.createdDateTime),
      content: null,
      metadata: {
        sharepoint: {
          siteId: site.id,
          siteName: site.name,
          siteUrl: site.webUrl,
          driveId: drive.id,
          driveName: drive.name,
          driveUrl: drive.webUrl,
          itemId: item.id,
          itemName: item.name,
          itemWebUrl: item.webUrl,
          createdBy: item.createdBy?.user?.displayName || 'Unknown',
          lastModifiedBy: item.lastModifiedBy?.user?.displayName || 'Unknown',
          createdDateTime: item.createdDateTime,
          lastModifiedDateTime: item.lastModifiedDateTime,
          mimeType: item.file?.mimeType || 'application/octet-stream',
          size: item.size,
          quickXorHash: item.file?.hashes?.quickXorHash,
          sha256Hash: item.file?.hashes?.sha256Hash,
          parentPath: item.parentReference?.path,
        },
      },
    };
  }

  /**
   * Download document content from SharePoint.
   */
  protected async downloadDocument(doc: SourceDocument): Promise<Buffer> {
    const metadata = doc.metadata?.sharepoint;
    if (!metadata || !metadata.driveId || !metadata.itemId) {
      throw new Error(`Missing SharePoint metadata for document ${doc.id}`);
    }

    console.log(
      `[DeltaSync] Downloading document ${doc.name} from SharePoint (driveId: ${metadata.driveId}, itemId: ${metadata.itemId})`,
    );

    // Use GraphClient to download file content
    const content = await this.graphClient.getDriveItemContent(metadata.driveId, metadata.itemId);

    console.log(`[DeltaSync] Downloaded ${content.length} bytes for ${doc.name}`);
    return content;
  }

  /**
   * Crawl permissions for a batch of documents.
   * Implements permission crawling integration with SharePoint.
   */
  protected async crawlPermissionsBatch(
    documents: Array<{ searchDocId: string; sourceMetadata: any }>,
  ): Promise<void> {
    if (this.config.permissionConfig.mode === 'disabled') {
      return; // Skip if permissions disabled
    }

    console.log(
      `[DeltaSync] Starting permission crawl for ${documents.length} documents (mode: ${this.config.permissionConfig.mode})`,
    );

    // Map documents to DocumentToCrawl format
    const documentsToCrawl: DocumentToCrawl[] = documents.map((doc) => ({
      documentId: doc.searchDocId,
      driveId: doc.sourceMetadata.sharepoint.driveId,
      itemId: doc.sourceMetadata.sharepoint.itemId,
      name: doc.sourceMetadata.sharepoint.itemName,
      path: doc.sourceMetadata.sharepoint.itemWebUrl,
    }));

    // Create permission crawler config (MongoDB-backed, Neo4j removed)
    const crawlerConfig: PermissionCrawlConfig = {
      mode: this.config.permissionConfig.mode,
      tenantId: this.config.tenantId,
      sourceId: this.config.sourceId,
    };

    // Create and run crawler
    const crawler = new SharePointPermissionCrawler(this.graphClient, crawlerConfig);
    const result = await crawler.crawlDocuments(documentsToCrawl);

    if (result.success) {
      console.log(
        `[DeltaSync] Permission crawl completed: ${result.documentsProcessed} documents, ${result.averageAccuracy}% accuracy, ${result.durationMs}ms`,
      );
    } else {
      console.error(`[DeltaSync] Permission crawl had errors:`, result.errors);
      // Don't throw - allow sync to complete even if permission crawl fails
    }
  }
}
