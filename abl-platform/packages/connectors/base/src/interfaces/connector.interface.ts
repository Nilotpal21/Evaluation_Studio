/**
 * Core Connector Interface
 *
 * All enterprise connectors (SharePoint, Jira, Confluence, etc.) must implement this interface.
 * Provides a consistent API for authentication, sync, permissions, and webhooks.
 */

import type { IConnectorConfig } from '@agent-platform/database';
import type { IResourceDiscovery } from './resource-discovery.interface.js';
import type { ISchemaIntrospection } from './schema-introspection.interface.js';

// ─── Result Types ────────────────────────────────────────────────────────

export interface ValidationResult {
  valid: boolean;
  errors: Array<{
    field: string;
    message: string;
  }>;
}

export interface ConnectionTestResult {
  success: boolean;
  message: string;
  metadata?: {
    tenantUrl?: string;
    authenticatedUser?: string;
    scopes?: string[];
    [key: string]: any;
  };
}

export interface SyncResult {
  success: boolean;
  syncType: 'full' | 'delta';
  documentsProcessed: number;
  documentsFailed: number;
  durationMs: number;
  paused?: boolean; // True if sync was paused by user
  checkpointId?: string; // Checkpoint ID for resuming paused sync
  error?: {
    code: string;
    message: string;
  };
}

export interface PermissionCrawlResult {
  success: boolean;
  mode: 'full' | 'simplified' | 'enabled' | 'disabled';
  documentsProcessed: number;
  averageAccuracy: number;
  durationMs: number;
  error?: {
    code: string;
    message: string;
  };
}

export interface WebhookSubscription {
  subscriptionId: string;
  notificationUrl: string;
  resource: string;
  expiresAt: Date;
}

// ─── Main Interface ──────────────────────────────────────────────────────

export interface IConnector {
  /** Connector type identifier (e.g., 'sharepoint', 'jira') */
  readonly connectorType: string;

  /** Connector configuration */
  readonly config: IConnectorConfig;

  // ─── Lifecycle ─────────────────────────────────────────────────────────

  /**
   * Initialize the connector.
   * Load configuration, setup HTTP clients, validate credentials.
   */
  initialize(): Promise<void>;

  /**
   * Validate connector configuration.
   * Check required fields, OAuth token validity, filter syntax.
   */
  validateConfig(): Promise<ValidationResult>;

  /**
   * Test connection to the data source.
   * Verify authentication and basic API access.
   */
  testConnection(): Promise<ConnectionTestResult>;

  // ─── Sync Operations ───────────────────────────────────────────────────

  /**
   * Perform a full sync of all documents.
   * Enumerates all resources from scratch, applies filters, creates SearchDocument records.
   */
  performFullSync(): Promise<SyncResult>;

  /**
   * Perform a delta (incremental) sync.
   * Only fetches changes since last sync using provider-specific delta tokens.
   */
  performDeltaSync(): Promise<SyncResult>;

  /**
   * Pause an in-progress sync.
   * Saves checkpoint state for later resumption.
   */
  pauseSync(jobId: string): Promise<void>;

  /**
   * Resume a paused sync.
   * Loads checkpoint state and continues from where it left off.
   */
  resumeSync(jobId: string): Promise<void>;

  // ─── Permission Operations ─────────────────────────────────────────────

  /**
   * Crawl permissions for indexed documents.
   * Creates DocumentPermission records for query-time filtering.
   *
   * @param mode - 'full'/'simplified'/'enabled' (crawl) or 'disabled' (skip)
   */
  crawlPermissions(
    mode: 'full' | 'simplified' | 'enabled' | 'disabled',
  ): Promise<PermissionCrawlResult>;

  // ─── Webhook Operations (Optional) ─────────────────────────────────────

  /**
   * Set up webhook subscription for real-time updates.
   * Optional - not all connectors support webhooks.
   *
   * @param notificationUrl - Platform endpoint to receive webhook notifications
   */
  setupWebhook?(notificationUrl: string): Promise<WebhookSubscription>;

  /**
   * Handle incoming webhook notification.
   * Processes real-time change events from the data source.
   */
  handleWebhookNotification?(payload: any): Promise<void>;

  /**
   * Get resource discovery implementation for this connector.
   * Returns null if the connector does not support auto-discovery.
   */
  getResourceDiscovery?(): IResourceDiscovery;

  /**
   * Get schema introspection implementation for this connector.
   * Returns null if the connector does not support pre-sync schema introspection.
   * Schema introspection uses the source system's metadata API to discover
   * available fields without fetching documents.
   */
  getSchemaIntrospection?(): ISchemaIntrospection;
}
