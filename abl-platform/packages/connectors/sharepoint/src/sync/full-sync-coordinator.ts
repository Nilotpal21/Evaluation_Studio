/**
 * SharePoint Full Sync Coordinator
 *
 * Orchestrates complete document synchronization from SharePoint.
 * Enumerates sites → drives → items, applies filters, creates SearchDocument records.
 *
 * After processing each drive, establishes a delta token to enable future incremental syncs.
 */

import {
  BaseSyncCoordinator,
  type SourceDocument,
  type SyncCoordinatorModels,
} from '@agent-platform/connectors-base';
import type { IConnectorConfig, ISyncCheckpoint } from '@agent-platform/database';
import type { IFilterEngine } from '@agent-platform/connectors-base';
import { SharePointFilterEngine } from '../filters/sharepoint-filter-engine.js';
import { FolderPathMatcher } from '@agent-platform/connectors-base';
import type { HydratedDocument } from 'mongoose';
import { GraphClient } from '../client/graph-client.js';
import type { Site, Drive, DriveItem } from '../client/graph-types.js';
import { DeltaTokenManager } from './delta-token-manager.js';
import { SharePointPermissionCrawler } from '../permissions/sharepoint-permission-crawler.js';
import type {
  DocumentToCrawl,
  PermissionCrawlConfig,
} from '../permissions/sharepoint-permission-crawler.js';

// ─── SharePoint Full Sync Coordinator ────────────────────────────────────

export class SharePointFullSyncCoordinator extends BaseSyncCoordinator {
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
   * Fetch documents from SharePoint.
   * Implements site → drive → item enumeration with pagination.
   *
   * After processing each drive, establishes a delta token for future incremental syncs.
   */
  async fetchDocuments(
    checkpoint: HydratedDocument<ISyncCheckpoint> | null,
  ): Promise<SourceDocument[]> {
    const documents: SourceDocument[] = [];

    // Get sites (filtered by connector config)
    const sites = await this.getSitesFiltered();
    console.log(`[FullSync] Found ${sites.length} sites after filtering`);

    for (const site of sites) {
      console.log(`[FullSync] Processing site: ${site.displayName} (${site.webUrl})`);

      // Get drives (document libraries) in site
      let drives: Drive[];
      try {
        drives = await this.getDrivesFiltered(site);
      } catch (error: any) {
        console.warn(`[FullSync] Skipping site ${site.displayName}: ${error.message}`);
        continue; // Skip inaccessible sites
      }
      console.log(`[FullSync] Found ${drives.length} drives in site ${site.displayName}`);

      for (const drive of drives) {
        console.log(`[FullSync] Processing drive: ${drive.name} (${drive.id})`);

        // Get items in drive
        let items: SourceDocument[];
        try {
          items = await this.getItemsRecursive(site, drive, checkpoint);
        } catch (error: any) {
          console.warn(
            `[FullSync] Skipping drive ${drive.name} in ${site.displayName}: ${error.message}`,
          );
          continue; // Skip inaccessible drives
        }
        console.log(`[FullSync] Found ${items.length} items in drive ${drive.name}`);
        documents.push(...items);

        // Establish delta token for this drive to enable future incremental syncs
        try {
          const deltaResponse = await this.graphClient.getDeltaItems(drive.id, undefined);

          if (deltaResponse['@odata.deltaLink']) {
            await this.deltaTokenManager.saveToken(
              drive.id,
              deltaResponse['@odata.deltaLink'],
              items.length,
            );

            console.log(
              `[FullSync] Established delta token for drive ${drive.id} (${drive.name}) with ${items.length} items`,
            );
          }
        } catch (error: any) {
          console.warn(
            `[FullSync] Failed to establish delta token for drive ${drive.id} (${drive.name}):`,
            error.message,
          );
          // Continue sync even if delta token establishment fails
        }

        // Save checkpoint periodically
        if (checkpoint && documents.length % 100 === 0) {
          checkpoint.state.currentSiteUrl = site.webUrl;
          checkpoint.state.currentLibraryId = drive.id;
          checkpoint.state.processedCount = documents.length;
          await this.saveCheckpoint(checkpoint);
        }
      }
    }

    return documents;
  }

  /**
   * Get delta token for incremental sync.
   * Returns the stored delta token from connector config.
   */
  async getDeltaToken(): Promise<string | null> {
    return this.config.syncState.deltaToken || null;
  }

  /**
   * Get sites with scope filter applied.
   * Uses SharePointFilterEngine for consistent site selection logic.
   */
  private async getSitesFiltered(): Promise<Site[]> {
    const allSites = await this.graphClient.getSites();

    // Use filter engine for site filtering if it's a SharePointFilterEngine
    const spEngine = this.filterEngine instanceof SharePointFilterEngine ? this.filterEngine : null;

    if (!spEngine) {
      return allSites;
    }

    const scope = spEngine.getSharePointScope();
    if (scope.siteMode === 'all') {
      return allSites;
    }

    const filtered = allSites.filter((site) => spEngine.shouldIncludeSite(site.id, site.webUrl));
    console.log(
      `[FullSync] Site filter (${scope.siteMode}): ${allSites.length} → ${filtered.length} sites`,
    );
    return filtered;
  }

  /**
   * Get drives with scope filter applied.
   * Uses SharePointFilterEngine for consistent library selection logic.
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
   * Get all items in a drive recursively.
   * Uses streaming to avoid memory exhaustion on large drives (100K+ items).
   */
  private async getItemsRecursive(
    site: Site,
    drive: Drive,
    checkpoint: HydratedDocument<ISyncCheckpoint> | null,
  ): Promise<SourceDocument[]> {
    const items: SourceDocument[] = [];

    // Use checkpoint nextLink if resuming
    const startLink =
      checkpoint?.state.currentLibraryId === drive.id
        ? checkpoint.state.nextLink || undefined
        : undefined;

    // Get items using streaming to prevent memory exhaustion
    // Processes batches of 100 items at a time instead of loading all into memory
    for await (const batch of this.graphClient.getDriveItemsStream(drive.id, 100)) {
      // Map each item in the batch to SourceDocument format
      for (const item of batch) {
        // Skip folders
        if (item.folder) {
          continue;
        }

        // Map to SourceDocument
        const sourceDoc = this.mapToSourceDocument(site, drive, item);
        items.push(sourceDoc);
      }
    }

    return items;
  }

  /**
   * Map SharePoint DriveItem to SourceDocument.
   */
  private mapToSourceDocument(site: Site, drive: Drive, item: DriveItem): SourceDocument {
    return {
      id: item.id,
      name: item.name,
      url: item.webUrl,
      contentType: item.file?.mimeType || 'application/octet-stream',
      sizeBytes: item.size,
      modifiedAt: new Date(item.lastModifiedDateTime),
      createdAt: new Date(item.createdDateTime),
      content: null, // Will be fetched separately during ingestion
      metadata: {
        // Generic folder path for base filter engine (connector-agnostic convention)
        folderPath: item.parentReference?.path ?? null,
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

    const content = await this.graphClient.getDriveItemContent(metadata.driveId, metadata.itemId);
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
      `[FullSync] Starting permission crawl for ${documents.length} documents (mode: ${this.config.permissionConfig.mode})`,
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
        `[FullSync] Permission crawl completed: ${result.documentsProcessed} documents, ${result.averageAccuracy}% accuracy, ${result.durationMs}ms`,
      );
    } else {
      console.error(`[FullSync] Permission crawl had errors:`, result.errors);
      // Don't throw - allow sync to complete even if permission crawl fails
    }
  }
}
