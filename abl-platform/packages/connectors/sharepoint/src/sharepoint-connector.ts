/**
 * SharePoint Connector
 *
 * Main connector implementation for Microsoft SharePoint.
 * Implements IConnector interface with SharePoint-specific logic.
 */

import type {
  IConnector,
  IResourceDiscovery,
  ValidationResult,
  ConnectionTestResult,
  SyncResult,
  PermissionCrawlResult,
  WebhookSubscription,
  SyncCoordinatorModels,
} from '@agent-platform/connectors-base';
import { TokenManager, DeviceCodeFlowAuthenticator } from '@agent-platform/connectors-base';
import type { IConnectorConfig, IEndUserOAuthToken } from '@agent-platform/database';
import type { Model } from 'mongoose';
import { MicrosoftOAuthProvider } from './auth/microsoft-oauth-provider.js';
import { GraphClient } from './client/graph-client.js';
import { SharePointFullSyncCoordinator } from './sync/full-sync-coordinator.js';
import { SharePointDeltaSyncCoordinator } from './sync/delta-sync-coordinator.js';
import { SharePointFilterEngine } from './filters/sharepoint-filter-engine.js';
import { SharePointPermissionCrawler } from './permissions/sharepoint-permission-crawler.js';
import type { DocumentToCrawl } from './permissions/sharepoint-permission-crawler.js';
import { SharePointResourceDiscovery } from './discovery/sharepoint-resource-discovery.js';

// ─── SharePoint Connector ────────────────────────────────────────────────

export class SharePointConnector implements IConnector {
  readonly connectorType = 'sharepoint';
  readonly config: IConnectorConfig;

  private oauthProvider: MicrosoftOAuthProvider | null = null;
  private tokenManager: TokenManager | null = null;
  private graphClient: GraphClient | null = null;
  private filterEngine: SharePointFilterEngine | null = null;
  private fullSyncCoordinator: SharePointFullSyncCoordinator | null = null;
  private deltaSyncCoordinator: SharePointDeltaSyncCoordinator | null = null;

  private readonly tokenModel?: Model<IEndUserOAuthToken>;
  private readonly syncModels?: SyncCoordinatorModels;
  private readonly doclingQueue?: any; // Queue from bullmq

  constructor(
    config: IConnectorConfig,
    tokenModel?: Model<IEndUserOAuthToken>,
    syncModels?: SyncCoordinatorModels,
    doclingQueue?: any,
  ) {
    this.config = config;
    this.tokenModel = tokenModel;
    this.syncModels = syncModels;
    this.doclingQueue = doclingQueue;
  }

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Initialize the connector.
   * Sets up OAuth provider, token manager, Graph client, and sync coordinators.
   */
  async initialize(): Promise<void> {
    // Validate configuration
    const validation = await this.validateConfig();
    if (!validation.valid) {
      throw new Error(`Invalid connector configuration: ${JSON.stringify(validation.errors)}`);
    }

    // Initialize OAuth provider
    this.oauthProvider = new MicrosoftOAuthProvider({
      clientId: this.config.connectionConfig.clientId || '',
      tenantId: this.config.connectionConfig.tenantId as string | undefined,
    });

    // Load OAuth token directly by ID (linked during auth flow)
    if (!this.tokenModel) {
      throw new Error(
        'SharePointConnector requires an EndUserOAuthToken model. Pass it via the constructor.',
      );
    }
    if (!this.config.oauthTokenId) {
      throw new Error('No OAuth token linked to this connector. Please authenticate first.');
    }

    const oauthToken = await this.tokenModel.findOne({
      _id: this.config.oauthTokenId,
      tenantId: this.config.tenantId,
      revokedAt: null,
    });
    if (!oauthToken) {
      throw new Error('OAuth token not found or revoked. Please re-authenticate.');
    }

    // Initialize TokenManager for automatic token refresh
    this.tokenManager = new TokenManager(
      this.oauthProvider,
      this.config.tenantId,
      oauthToken.userId,
      this.tokenModel,
    );

    // Initialize Graph client with TokenManager for automatic token refresh
    this.graphClient = new GraphClient({
      tokenManager: this.tokenManager,
      rateLimit: this.config.connectionConfig.rateLimit as
        | { maxRequests?: number; requestsPerSecond?: number }
        | undefined,
    });

    // Initialize filter engine with new structured config
    // Cast needed because Mongoose schema types are slightly different from FilterConfig interface
    this.filterEngine = new SharePointFilterEngine(
      this.config.filterConfig as unknown as import('@agent-platform/connectors-base').FilterConfig,
    );

    // Initialize sync coordinators (requires injected models for dual-database support)
    if (this.syncModels) {
      this.fullSyncCoordinator = new SharePointFullSyncCoordinator(
        this.config,
        this.filterEngine,
        this.graphClient,
        this.syncModels,
      );

      this.deltaSyncCoordinator = new SharePointDeltaSyncCoordinator(
        this.config,
        this.filterEngine,
        this.graphClient,
        this.syncModels,
      );
    }
  }

  /**
   * Validate connector configuration.
   */
  async validateConfig(): Promise<ValidationResult> {
    const errors: Array<{ field: string; message: string }> = [];

    // Validate connection config
    if (!this.config.connectionConfig.clientId) {
      errors.push({ field: 'connectionConfig.clientId', message: 'Client ID is required' });
    }

    if (this.config.connectionConfig.tenantUrl) {
      try {
        new URL(this.config.connectionConfig.tenantUrl);
      } catch {
        errors.push({ field: 'connectionConfig.tenantUrl', message: 'Invalid tenant URL format' });
      }
    }

    // Validate OAuth token exists
    if (!this.config.oauthTokenId) {
      errors.push({ field: 'oauthTokenId', message: 'OAuth token not configured' });
    }

    // Validate filter config
    const filterEngine = new SharePointFilterEngine(
      this.config.filterConfig as unknown as import('@agent-platform/connectors-base').FilterConfig,
    );
    const filterValidation = filterEngine.validate();
    for (const err of filterValidation.errors) {
      errors.push({ field: `filterConfig.${err.field}`, message: err.message });
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  /**
   * Test connection to SharePoint.
   */
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      if (!this.graphClient) {
        await this.initialize();
      }

      // Try to fetch sites
      const sites = await this.graphClient!.getSites();

      return {
        success: true,
        message: `Successfully connected to SharePoint. Found ${sites.length} sites.`,
        metadata: {
          tenantUrl: this.config.connectionConfig.tenantUrl,
          siteCount: sites.length,
        },
      };
    } catch (error: any) {
      return {
        success: false,
        message: `Connection failed: ${error.message}`,
        metadata: {
          error: error.message,
        },
      };
    }
  }

  // ─── Sync Operations ───────────────────────────────────────────────────

  /**
   * Perform full sync.
   */
  async performFullSync(
    checkpoint?: any,
    progressCallback?: (progress: {
      processedCount: number;
      totalCount?: number;
      currentResource: string;
      documentsPerSecond: number;
    }) => void,
  ): Promise<SyncResult> {
    if (!this.fullSyncCoordinator) {
      await this.initialize();
    }

    return await this.fullSyncCoordinator!.performSync('full', checkpoint, progressCallback);
  }

  /**
   * Perform delta sync.
   */
  async performDeltaSync(): Promise<SyncResult> {
    if (!this.deltaSyncCoordinator) {
      await this.initialize();
    }

    return await this.deltaSyncCoordinator!.performSync('delta');
  }

  /**
   * Pause sync.
   *
   * The service layer handles the actual pause by setting `errorState.isPaused`
   * in the DB and publishing a Redis cancel signal. The BaseSyncCoordinator's
   * `checkShouldPause()` polls the DB flag every 10 documents and saves a
   * checkpoint before returning.
   *
   * This method is a no-op — the connector does not hold in-process state
   * that needs to be cleaned up on pause.
   */
  async pauseSync(_jobId: string): Promise<void> {
    // Pause is handled by the service layer (DB flag + Redis signal).
    // BaseSyncCoordinator.checkShouldPause() picks it up during processing.
  }

  /**
   * Resume sync — loads the saved checkpoint and delegates to the full sync
   * coordinator to continue from where it left off.
   */
  async resumeSync(_jobId: string): Promise<void> {
    if (!this.fullSyncCoordinator) {
      await this.initialize();
    }

    // Load checkpoint and resume — performSync accepts a checkpoint parameter.
    // loadCheckpoint returns ISyncCheckpoint from findOne() which is actually
    // a HydratedDocument at runtime; the cast is safe.
    const checkpoint = await this.fullSyncCoordinator!.loadCheckpoint(this.config._id);
    if (checkpoint) {
      await this.fullSyncCoordinator!.performSync('full', checkpoint as any);
    } else {
      // No checkpoint found — start fresh
      await this.fullSyncCoordinator!.performSync('full');
    }
  }

  // ─── Permission Operations ─────────────────────────────────────────────

  /**
   * Crawl permissions for all documents.
   * Fetches permissions from SharePoint and writes to MongoDB via MongoPermissionStore.
   */
  async crawlPermissions(
    mode: 'full' | 'simplified' | 'enabled' | 'disabled',
  ): Promise<PermissionCrawlResult> {
    if (!this.graphClient) {
      await this.initialize();
    }

    if (mode === 'disabled') {
      return {
        success: true,
        mode: 'disabled',
        documentsProcessed: 0,
        averageAccuracy: 0,
        durationMs: 0,
      };
    }

    // Initialize permission crawler (MongoDB-backed, Neo4j removed)
    const crawler = new SharePointPermissionCrawler(this.graphClient!, {
      mode,
      tenantId: this.config.tenantId,
      sourceId: this.config._id,
    });

    try {
      // Fetch all documents for this connector from SearchDocument
      if (!this.syncModels) {
        throw new Error('Sync models not provided. Pass syncModels via the constructor.');
      }
      const searchDocs = await this.syncModels.SearchDocument.find({
        tenantId: this.config.tenantId,
        connectorId: this.config._id,
        isDeleted: false,
      })
        .select('_id sourceMetadata.sharepoint.driveId sourceMetadata.sharepoint.itemId name path')
        .lean()
        .exec();

      // Map to DocumentToCrawl format
      const docsToCrawl: DocumentToCrawl[] = searchDocs
        .map((doc: any) => ({
          documentId: doc._id,
          driveId: doc.sourceMetadata?.sharepoint?.driveId,
          itemId: doc.sourceMetadata?.sharepoint?.itemId,
          name: doc.name,
          path: doc.path,
        }))
        .filter(
          (doc: Partial<DocumentToCrawl>): doc is DocumentToCrawl =>
            doc.driveId != null && doc.itemId != null,
        ); // Skip documents without SharePoint metadata

      // Crawl permissions
      const result = await crawler.crawlDocuments(docsToCrawl);

      return result;
    } finally {
      await crawler.close();
    }
  }

  // ─── Resource Discovery ──────────────────────────────────────────────

  /**
   * Get resource discovery implementation for SharePoint.
   * Requires the connector to be initialized (GraphClient must exist).
   */
  getResourceDiscovery(): IResourceDiscovery {
    if (!this.graphClient) {
      throw new Error('Connector must be initialized before calling getResourceDiscovery()');
    }
    return new SharePointResourceDiscovery(this.graphClient);
  }

  // ─── Webhook Operations (Phase 2) ──────────────────────────────────────

  /**
   * Setup webhook subscription.
   */
  async setupWebhook(notificationUrl: string): Promise<WebhookSubscription> {
    if (!this.graphClient) {
      await this.initialize();
    }

    // TODO: Implement webhook setup for all drives
    throw new Error('Webhook setup not implemented yet (Phase 2)');
  }

  /**
   * Handle webhook notification.
   */
  async handleWebhookNotification(payload: any): Promise<void> {
    // TODO: Implement webhook notification handling
    throw new Error('Webhook handling not implemented yet (Phase 2)');
  }
}
