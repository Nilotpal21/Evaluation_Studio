/**
 * Base Sync Coordinator
 *
 * Abstract base class implementing template method pattern for sync operations.
 * Concrete connectors extend this and implement provider-specific logic.
 */

import type {
  ISearchDocument,
  ISyncCheckpoint,
  IConnectorConfig,
  ISearchSource,
  IDriveDeltaToken,
} from '@agent-platform/database';
import type { HydratedDocument, Model } from 'mongoose';
import type {
  ISyncCoordinator,
  SourceDocument,
  SyncProgressCallback,
} from '../interfaces/sync-coordinator.interface.js';
import type { SyncResult } from '../interfaces/connector.interface.js';
import type { IFilterEngine } from '../interfaces/filter-engine.interface.js';

// ─── Model Dependencies ─────────────────────────────────────────────────

/**
 * Models that must be injected by the host application.
 * In SearchAI's dual-database setup, models from `@agent-platform/database`
 * have no connection — they must be provided via `getLazyModel()`.
 */
export interface SyncCoordinatorModels {
  SearchDocument: Model<ISearchDocument>;
  SearchSource: Model<ISearchSource>;
  SyncCheckpoint: Model<ISyncCheckpoint>;
  ConnectorConfig: Model<IConnectorConfig>;
  DriveDeltaToken: Model<IDriveDeltaToken>;
}

// ─── Base Sync Coordinator ──────────────────────────────────────────────

export abstract class BaseSyncCoordinator implements ISyncCoordinator {
  protected readonly config: IConnectorConfig;
  protected readonly filterEngine: IFilterEngine;
  protected readonly models: SyncCoordinatorModels;
  private resolvedIndexId: string | null = null;
  private resolvedSourceName: string | null = null;

  constructor(
    config: IConnectorConfig,
    filterEngine: IFilterEngine,
    models: SyncCoordinatorModels,
  ) {
    this.config = config;
    this.filterEngine = filterEngine;
    this.models = models;
  }

  /**
   * Perform synchronization (template method).
   */
  async performSync(
    syncType: 'full' | 'delta',
    checkpoint?: HydratedDocument<ISyncCheckpoint>,
    progressCallback?: SyncProgressCallback,
  ): Promise<SyncResult> {
    // File logging
    const fs = await import('fs/promises');
    const logPath = '/home/mounikavemula/kore/abl-platform/logs/sync-debug.log';
    const log = async (msg: string) => {
      const timestamp = new Date().toISOString();
      await fs.appendFile(logPath, `[${timestamp}] ${msg}\n`).catch(() => {});
      console.log(msg);
    };

    const startTime = Date.now();
    let processedCount = 0;
    let failedCount = 0;
    let filteredOutCount = 0;
    const documentsForPermissionCrawl: Array<{ searchDocId: string; sourceMetadata: any }> = [];

    try {
      // 1. Initialize sync
      const activeCheckpoint = checkpoint || (await this.createCheckpoint(syncType));

      // 2. Update SearchSource status
      await this.updateSourceStatus('syncing');

      // 3. Fetch documents (connector-specific)
      await log('[BaseSyncCoordinator] ======== STARTING DOCUMENT PROCESSING ========');
      await log('[BaseSyncCoordinator] Fetching documents...');
      const documents = await this.fetchDocuments(activeCheckpoint);

      // 4. Process documents
      for (const doc of documents) {
        // Check if sync should be paused (every 10 documents for responsiveness)
        if (processedCount % 10 === 0) {
          const shouldPause = await this.checkShouldPause();
          if (shouldPause) {
            console.log(
              `[BaseSyncCoordinator] Pause requested, saving checkpoint at ${processedCount} documents`,
            );
            await this.updateCheckpoint(activeCheckpoint, processedCount);
            await this.updateSourceStatus('paused', processedCount);

            return {
              success: true,
              syncType,
              documentsProcessed: processedCount,
              documentsFailed: failedCount,
              durationMs: Date.now() - startTime,
              paused: true,
              checkpointId: activeCheckpoint._id,
            };
          }
        }

        try {
          // Apply filters
          const filterResult = this.filterEngine.evaluate(doc);
          if (!filterResult.include) {
            filteredOutCount++;
            continue; // Skip excluded documents
          }

          await log(
            `[BaseSyncCoordinator] Processing document ${processedCount + 1}: ${doc.name} (${doc.contentType})`,
          );

          // Create SearchDocument record
          const searchDoc = await this.createSearchDocument(doc);
          await log(`[BaseSyncCoordinator] Created SearchDocument with ID: ${searchDoc._id}`);

          // Download document content from source
          await log(`[BaseSyncCoordinator] Downloading document: ${doc.name}`);
          const documentBuffer = await this.downloadDocument(doc);
          await log(`[BaseSyncCoordinator] Downloaded ${documentBuffer.length} bytes`);

          // Upload to storage (S3 or local filesystem)
          await log(`[BaseSyncCoordinator] Uploading to storage: ${doc.name}`);
          const storageUrl = await this.uploadToStorage(documentBuffer, doc, searchDoc._id);
          await log(`[BaseSyncCoordinator] Uploaded to: ${storageUrl}`);

          // Update SearchDocument with storage URL
          await this.models.SearchDocument.findOneAndUpdate(
            { _id: searchDoc._id },
            {
              sourceUrl: storageUrl,
            },
          );

          // Trigger ingestion
          await log(`[BaseSyncCoordinator] Triggering ingestion for: ${doc.name}`);
          await this.triggerIngestion(searchDoc._id, doc);
          await log(
            `[BaseSyncCoordinator] ✓ Document ${processedCount + 1} completed: ${doc.name}`,
          );

          // Collect documents for permission crawl (if enabled)
          if (this.config.permissionConfig.mode !== 'disabled') {
            documentsForPermissionCrawl.push({
              searchDocId: searchDoc._id,
              sourceMetadata: doc.metadata,
            });
          }

          processedCount++;

          // Update checkpoint periodically (every 100 documents)
          if (processedCount % 100 === 0) {
            await this.updateCheckpoint(activeCheckpoint, processedCount);
          }

          // Report progress
          if (progressCallback) {
            progressCallback({
              processedCount,
              currentResource: doc.name,
              documentsPerSecond: processedCount / ((Date.now() - startTime) / 1000),
            });
          }
        } catch (error: any) {
          failedCount++;
          await log(`[BaseSyncCoordinator] ✗ FAILED to process document: ${doc.name}`);
          await log(`[BaseSyncCoordinator] Error: ${error.message}`);
          await log(`[BaseSyncCoordinator] Stack: ${error.stack}`);
          console.error(
            `[BaseSyncCoordinator] Failed to process document ${doc.id} (${doc.name}):`,
            error,
          );
          console.error(`[BaseSyncCoordinator] Error stack:`, error.stack);
        }
      }

      await log('[BaseSyncCoordinator] ======== PROCESSING COMPLETE ========');
      await log(`[BaseSyncCoordinator] Total documents from fetch: ${documents.length}`);
      await log(`[BaseSyncCoordinator] Filtered out: ${filteredOutCount}`);
      await log(`[BaseSyncCoordinator] Successfully processed: ${processedCount}`);
      await log(`[BaseSyncCoordinator] Failed: ${failedCount}`);
      await log('[BaseSyncCoordinator] ===================================');

      // 5. Crawl permissions for ALL documents in this source (if enabled)
      //    Permission crawl must run for ALL documents, not just newly processed ones,
      //    because permissions can change independently of document content.
      //    (Bug 2/7 fix: decouple permission crawl from content sync)
      if (this.config.permissionConfig.mode !== 'disabled') {
        try {
          const allSourceDocs = await this.getAllSourceDocumentsForPermissionCrawl();
          if (allSourceDocs.length > 0) {
            await log(
              `[BaseSyncCoordinator] Crawling permissions for ${allSourceDocs.length} documents (all source docs, not just changed)`,
            );
            await this.crawlPermissionsBatch(allSourceDocs);
          } else if (documentsForPermissionCrawl.length > 0) {
            // Fallback: if getAllSourceDocuments is not overridden, use newly processed docs
            await this.crawlPermissionsBatch(documentsForPermissionCrawl);
          }
        } catch (error: unknown) {
          await log(
            `[BaseSyncCoordinator] Permission crawl failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          // Don't fail the entire sync if permission crawl fails
        }
      }

      // 6. Finalize sync
      await this.finalizeSync(syncType, processedCount);

      // 7. Update SearchSource
      await this.updateSourceStatus('active', processedCount);

      return {
        success: true,
        syncType,
        documentsProcessed: processedCount,
        documentsFailed: failedCount,
        durationMs: Date.now() - startTime,
      };
    } catch (error: any) {
      // Update source with error
      await this.updateSourceStatus('error', processedCount, error.message);

      return {
        success: false,
        syncType,
        documentsProcessed: processedCount,
        documentsFailed: failedCount,
        durationMs: Date.now() - startTime,
        error: {
          code: error.code || 'SYNC_FAILED',
          message: error.message,
        },
      };
    }
  }

  /**
   * Fetch documents from source system.
   * Must be implemented by concrete connectors.
   */
  abstract fetchDocuments(checkpoint: ISyncCheckpoint | null): Promise<SourceDocument[]>;

  /**
   * Get delta token for incremental sync.
   * Must be implemented by concrete connectors.
   */
  abstract getDeltaToken(): Promise<string | null>;

  /**
   * Crawl permissions for a batch of documents.
   * Must be implemented by concrete connectors.
   *
   * @param documents - Array of documents with SearchDocument ID and source metadata
   */
  protected abstract crawlPermissionsBatch(
    documents: Array<{ searchDocId: string; sourceMetadata: any }>,
  ): Promise<void>;

  /**
   * Get ALL documents in this source for permission crawling.
   *
   * Returns all SearchDocuments for this connector, regardless of whether
   * their content changed. Permissions can change independently of content,
   * so we must re-crawl permissions for all docs on every sync.
   *
   * Concrete connectors can override this for connector-specific metadata needs.
   *
   * @returns Array of documents with SearchDocument ID and source metadata
   */
  protected async getAllSourceDocumentsForPermissionCrawl(): Promise<
    Array<{ searchDocId: string; sourceMetadata: any }>
  > {
    const docs = await this.models.SearchDocument.find(
      {
        tenantId: this.config.tenantId,
        sourceId: this.config.sourceId,
        isDeleted: { $ne: true },
      },
      { _id: 1, sourceMetadata: 1 },
    ).lean();

    return docs
      .filter((doc) => doc.sourceMetadata)
      .map((doc) => ({
        searchDocId: doc._id as string,
        sourceMetadata: doc.sourceMetadata,
      }));
  }

  /**
   * Create SearchDocument record from source document.
   */
  protected async createSearchDocument(doc: SourceDocument): Promise<ISearchDocument> {
    // Resolve indexId and source name from SearchSource (connector config only has sourceId, not indexId)
    if (!this.resolvedIndexId) {
      const source = await this.models.SearchSource.findOne({
        _id: this.config.sourceId,
        tenantId: this.config.tenantId,
      });
      this.resolvedIndexId = source?.indexId ?? this.config.sourceId;
      this.resolvedSourceName = source?.name ?? doc.name;
    }
    const indexId = this.resolvedIndexId;
    const documentName = this.resolvedSourceName ?? doc.name;

    // Compute content hash for deduplication
    const contentHash = await this.computeContentHash(doc);

    // Check if document already exists
    const existing = await this.models.SearchDocument.findOne({
      tenantId: this.config.tenantId,
      indexId,
      contentHash,
    });

    // Generate platform-hosted internal file URL
    const publicBase = process.env.SEARCH_AI_PUBLIC_URL || process.env.SEARCH_AI_URL || '';
    const buildInternalFileUrl = (docId: string) => {
      if (!publicBase) return undefined;
      return publicBase.includes('/api/search-ai')
        ? `${publicBase}/documents/${docId}/internal-file`
        : `${publicBase}/api/documents/${docId}/internal-file`;
    };

    if (existing) {
      // Update existing document — single save to avoid race conditions
      existing.name = documentName;
      existing.originalReference = doc.url;
      existing.contentType = doc.contentType;
      existing.contentSizeBytes = doc.sizeBytes;
      existing.sourceMetadata = doc.metadata;
      existing.connectorId = this.config._id;
      existing.downloadUrl = doc.url;
      existing.internalFileUrl = buildInternalFileUrl(existing._id) ?? existing.internalFileUrl;
      existing.status = 'pending';
      await existing.save();

      // Generate platform-hosted internal file URL
      const publicBase = process.env.SEARCH_AI_PUBLIC_URL || process.env.SEARCH_AI_URL || '';
      if (publicBase) {
        const fileUrl = publicBase.includes('/api/search-ai')
          ? `${publicBase}/documents/${existing._id}/internal-file`
          : `${publicBase}/api/documents/${existing._id}/internal-file`;
        existing.internalFileUrl = fileUrl;
        await existing.save();
      }

      return existing;
    } else {
      // Create new document
      const created = await this.models.SearchDocument.create({
        tenantId: this.config.tenantId,
        indexId,
        sourceId: this.config.sourceId,
        connectorId: this.config._id,
        contentHash,
        name: documentName,
        originalReference: doc.url,
        downloadUrl: doc.url,
        contentType: doc.contentType,
        contentSizeBytes: doc.sizeBytes,
        sourceMetadata: doc.metadata,
        internalFileUrl: buildInternalFileUrl(contentHash) ?? undefined,
        status: 'pending',
      });

      // Update internalFileUrl with actual document ID (wasn't available at create time)
      const internalUrl = buildInternalFileUrl(created._id);
      if (internalUrl) {
        await this.models.SearchDocument.findOneAndUpdate(
          { _id: created._id },
          { internalFileUrl: internalUrl },
        );
      }

      return created;
    }
  }

  /**
   * Download document content from source system.
   * Concrete coordinators must implement this to fetch file content.
   */
  protected abstract downloadDocument(doc: SourceDocument): Promise<Buffer>;

  /**
   * Upload document to storage (S3 or local filesystem) and return accessible URL.
   * Returns a URL that Docling service can use to download the document.
   */
  protected async uploadToStorage(
    documentBuffer: Buffer,
    doc: SourceDocument,
    searchDocId: string,
  ): Promise<string> {
    const provider = process.env.STORAGE_PROVIDER || 'local';
    const useS3 = provider === 's3' || provider === 'minio';

    if (useS3) {
      const { S3StorageService } = await import('@agent-platform/shared');
      const s3Service = new S3StorageService({
        bucket: process.env.STORAGE_BUCKET || 'abl-platform-documents',
        region: process.env.STORAGE_REGION || process.env.AWS_REGION || 'us-east-1',
        endpoint: process.env.STORAGE_ENDPOINT,
        encryption: 'AES256',
      });

      const s3Key = `${this.config.tenantId}/${this.config.sourceId}/${searchDocId}/${doc.name}`;
      const result = await s3Service.upload(s3Key, documentBuffer, {
        contentType: doc.contentType,
        metadata: {
          sourceId: this.config.sourceId,
          documentId: searchDocId,
        },
      });

      return result.url;
    } else {
      const path = await import('path');
      const fs = await import('fs/promises');
      const basePath = path.resolve(process.env.STORAGE_BASE_PATH || './uploads');

      const uploadDir = path.join(
        basePath,
        this.config.tenantId,
        this.config.sourceId,
        searchDocId,
      );

      await fs.mkdir(uploadDir, { recursive: true });
      const filePath = path.join(uploadDir, doc.name);
      await fs.writeFile(filePath, documentBuffer);

      // Return container path for Docker volume mount
      const relativePath = path.relative(basePath, filePath);
      return `/uploads/${relativePath}`;
    }
  }

  /**
   * Trigger ingestion pipeline for document.
   * Concrete coordinators can override to use custom queue integration.
   */
  protected async triggerIngestion(searchDocId: string, doc: SourceDocument): Promise<void> {
    // Default implementation: does nothing
    // Coordinators that need ingestion must override this method
    console.log(
      `[BaseSyncCoordinator] triggerIngestion called for ${searchDocId} - override this method to integrate with ingestion queue`,
    );
  }

  /**
   * Create sync checkpoint.
   */
  private async createCheckpoint(
    syncType: 'full' | 'delta',
  ): Promise<HydratedDocument<ISyncCheckpoint>> {
    return await this.models.SyncCheckpoint.create({
      tenantId: this.config.tenantId,
      connectorId: this.config._id,
      syncType,
      startedAt: new Date(),
      checkpointedAt: new Date(),
      state: {
        currentSiteUrl: null,
        currentLibraryId: null,
        nextLink: null,
        processedCount: 0,
        remainingCount: null,
      },
      progress: {
        percentage: 0,
        eta: null,
        documentsPerSecond: 0,
      },
    });
  }

  /**
   * Update checkpoint with progress.
   */
  private async updateCheckpoint(
    checkpoint: HydratedDocument<ISyncCheckpoint>,
    processedCount: number,
  ): Promise<void> {
    checkpoint.state.processedCount = processedCount;
    checkpoint.checkpointedAt = new Date();
    await checkpoint.save();
  }

  /**
   * Save checkpoint.
   */
  async saveCheckpoint(checkpoint: HydratedDocument<ISyncCheckpoint>): Promise<void> {
    await checkpoint.save();
  }

  /**
   * Load latest checkpoint.
   */
  async loadCheckpoint(connectorId: string): Promise<ISyncCheckpoint | null> {
    return await this.models.SyncCheckpoint.findOne({
      tenantId: this.config.tenantId,
      connectorId,
    }).sort({ checkpointedAt: -1 });
  }

  /**
   * Check if sync should pause.
   * Reloads config from DB to get latest pause state.
   */
  private async checkShouldPause(): Promise<boolean> {
    const freshConfig = await this.models.ConnectorConfig.findOne({
      _id: this.config._id,
      tenantId: this.config.tenantId,
    }).lean();
    return freshConfig?.errorState?.isPaused || false;
  }

  /**
   * Update SearchSource status.
   */
  private async updateSourceStatus(
    status: 'syncing' | 'active' | 'error' | 'paused',
    documentCount?: number,
    error?: string,
  ): Promise<void> {
    const update: any = { status };

    if (status === 'active') {
      update.lastSyncAt = new Date();
      if (documentCount !== undefined) {
        update.documentCount = documentCount;
      }
      update.syncError = null;
    } else if (status === 'error') {
      update.syncError = error;
    }

    await this.models.SearchSource.findOneAndUpdate({ _id: this.config.sourceId }, update);
  }

  /**
   * Finalize sync (update config state).
   */
  private async finalizeSync(syncType: 'full' | 'delta', count: number): Promise<void> {
    // Update config sync state
    // This will be implemented when ConnectorConfig model is used
  }

  /**
   * Compute content hash for deduplication.
   */
  private async computeContentHash(doc: SourceDocument): Promise<string> {
    // Simple hash based on ID and modified timestamp
    // In production, might use SHA-256 of actual content
    const crypto = await import('crypto');
    const hash = crypto.createHash('sha256');
    hash.update(`${doc.id}:${doc.modifiedAt.toISOString()}`);
    return hash.digest('hex');
  }
}
