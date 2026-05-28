/**
 * Connector Config Model
 *
 * Stores configuration and state for enterprise data connectors (SharePoint, Jira, etc.).
 * Tracks authentication, sync state, filters, permissions settings, and error handling.
 */

import mongoose, { Schema, model } from 'mongoose';
import { uuidv7 } from '../mongo/base-document.js';
import { tenantIsolationPlugin } from '../mongo/plugins/tenant-isolation.plugin.js';
import { ModelRegistry } from '../model-registry.js';

// ─── Document Interface ──────────────────────────────────────────────────

export interface IConnectorConfig {
  _id: string;
  tenantId: string;
  /** References SearchSource._id */
  sourceId: string;
  /** Connector type identifier */
  connectorType:
    | 'sharepoint'
    | 'jira'
    | 'confluence'
    | 'hubspot'
    | 'servicenow'
    | 'salesforce'
    | 'file_upload'
    | 'zendesk';

  // ─── Authentication ────────────────────────────────────────────────────

  /** References EndUserOAuthToken._id */
  oauthTokenId: string | null;
  /** Optional reference to an AuthProfile for credential resolution */
  authProfileId?: string;
  /** Provider-specific connection settings */
  connectionConfig: {
    /** Base URL (e.g., https://contoso.sharepoint.com) */
    tenantUrl?: string;
    /** OAuth client ID */
    clientId?: string;
    /** Required OAuth scopes */
    scopes?: string[];
    /** Additional provider-specific config */
    [key: string]: any;
  };

  // ─── Sync State ────────────────────────────────────────────────────────

  syncState: {
    lastFullSyncAt: Date | null;
    lastDeltaSyncAt: Date | null;
    /** Delta token for incremental sync */
    deltaToken: string | null;
    /** Checkpoint data for pause/resume */
    checkpointData: any | null;
    totalDocuments: number;
    processedDocuments: number;
    failedDocuments: number;
    /** Current background job ID (if sync in progress) */
    currentJobId: string | null;
    /** Whether sync is currently running */
    syncInProgress: boolean;
    /** Last sync error message */
    lastSyncError: string | null;
    /** Sync type for the current/last sync */
    syncType: string | null;
    /** When the current sync started */
    syncStartedAt: Date | null;
    /** Total size in bytes of content to sync */
    sizeTotal: number | null;
  };

  // ─── Filters ───────────────────────────────────────────────────────────

  filterConfig: {
    /** Standard document-level filters (common to all connectors) */
    standard: {
      /** Content categories to sync (e.g., ['files', 'pages']). Empty = all. */
      contentCategories: string[];
      /** File extension filtering. Null = use connector defaults. */
      fileExtensions: {
        mode: 'allowlist' | 'denylist';
        extensions: string[];
      } | null;
      /** Maximum file size in bytes. Null = no limit. */
      maxFileSizeBytes: number | null;
      /** Minimum file size in bytes. Null = no limit. */
      minFileSizeBytes: number | null;
      /** Only sync documents modified after this date */
      modifiedAfter: Date | null;
      /** Only sync documents modified before this date */
      modifiedBefore: Date | null;
      /** Only sync documents created after this date */
      createdAfter: Date | null;
      /** Only sync documents created before this date */
      createdBefore: Date | null;
    };

    /**
     * Connector-specific scope configuration.
     * Schema varies by connectorType — validated at connector level.
     *
     * SharePoint: { siteMode, siteIds, sitePatterns, libraryMode, libraryNames, libraryPatterns, folderPaths }
     * Jira: { projectMode, projectKeys, issueTypes }
     */
    scope: Record<string, unknown>;

    /** Advanced field/operator/value conditions */
    advancedFilters: {
      enabled: boolean;
      rootOperator: 'AND' | 'OR';
      conditions: Array<{
        field: string;
        operator: string;
        value: unknown;
        caseInsensitive?: boolean;
      }>;
      groups: Array<{
        operator: 'AND' | 'OR';
        conditions: Array<{
          field: string;
          operator: string;
          value: unknown;
          caseInsensitive?: boolean;
        }>;
      }>;
    };

    /** Filter configuration version (incremented on each change) */
    version: number;
  };

  // ─── Permissions ───────────────────────────────────────────────────────

  permissionConfig: {
    /** Permission crawling mode */
    mode: 'enabled' | 'disabled';
    /** Cron expression for recrawl schedule */
    crawlSchedule: string | null;
    lastCrawlAt: Date | null;
    /** Current permission crawl job ID (if crawl in progress) */
    currentJobId: string | null;
    /** Whether permission crawl is currently running */
    crawlInProgress: boolean;
    /** Number of documents processed in last crawl */
    documentsProcessed: number;
    /** Average accuracy percentage (100 for enabled, 0 for disabled) */
    averageAccuracy: number;
    /** Last crawl error message */
    lastCrawlError: string | null;
  };

  // ─── Error Tracking ────────────────────────────────────────────────────

  errorState: {
    consecutiveFailures: number;
    lastErrorAt: Date | null;
    lastErrorMessage: string | null;
    isPaused: boolean;
    pausedAt: Date | null;
    pauseReason: string | null;
  };

  // ─── Setup Metadata ───────────────────────────────────────────────────

  /** How this connector was configured */
  configurationSource: 'manual' | 'quick_setup' | 'imported';
  /** Discovery record used for auto-configuration (if any) */
  discoveryId: string | null;
  /** Recommendation record used for auto-configuration (if any) */
  recommendationId: string | null;
  /** When auto-configuration was applied */
  autoConfiguredAt: Date | null;

  // ─── Notifications ─────────────────────────────────────────────────────

  notifications?: {
    emailAlertsEnabled: boolean;
    emailEvents: string[];
    webhookUrl: string | null;
    webhookEvents: string[];
  };

  /** Upload field hints for file_upload connectors (sticky fields) */
  uploadFieldHints?: {
    recentFields: string[];
    lastValues: Record<string, string>;
    updatedAt: Date;
  } | null;

  // ─── Pre-Sync Field Configuration ─────────────────────────────────────

  /** Pre-sync field mapping configuration (set before first sync) */
  fieldConfig?: {
    /** Version (incremented on each save) */
    version: number;
    /** Per-field configuration */
    fields: Array<{
      /** Source field path (e.g., "fields.summary", "Title") */
      sourcePath: string;
      /** Human-readable display name */
      displayName: string;
      /** Detected or declared field type (accepts connector-native types: text, keyword, integer, etc.) */
      fieldType: string;
      /** Whether this field should be synced */
      selected: boolean;
      /** Whether this field should be included in embedding text */
      includeInEmbedding: boolean;
      /** Mapped canonical field (e.g., "title", "status", "custom_string_1") */
      canonicalMapping: string | null;
      /** Mapping confidence (0-1) */
      confidence: number;
      /** How the mapping was determined */
      mappingSource: 'template' | 'introspection' | 'rule' | 'llm' | 'fallback' | 'user';
      /** Sample values for display */
      sampleValues?: string[];
    }>;
    /** When the config was last saved */
    updatedAt: Date;
    /** Whether auto-suggest was applied */
    autoSuggestApplied: boolean;
    /** Source of the field config */
    source: 'template' | 'introspection' | 'merged';
  } | null;

  _v: number;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Schema ──────────────────────────────────────────────────────────────

const ConnectorConfigSchema = new Schema<IConnectorConfig>(
  {
    _id: { type: String, default: uuidv7 },
    tenantId: { type: String, required: true },
    sourceId: { type: String, required: true },
    connectorType: {
      type: String,
      required: true,
      enum: [
        'sharepoint',
        'jira',
        'confluence',
        'hubspot',
        'servicenow',
        'salesforce',
        'file_upload',
        'zendesk',
      ],
    },

    // Authentication
    oauthTokenId: { type: String, default: null },
    authProfileId: { type: String, default: null },
    connectionConfig: {
      type: Schema.Types.Mixed,
      default: {},
    },

    // Sync State
    syncState: {
      type: {
        lastFullSyncAt: { type: Date, default: null },
        lastDeltaSyncAt: { type: Date, default: null },
        deltaToken: { type: String, default: null },
        checkpointData: { type: Schema.Types.Mixed, default: null },
        totalDocuments: { type: Number, default: 0 },
        processedDocuments: { type: Number, default: 0 },
        failedDocuments: { type: Number, default: 0 },
        currentJobId: { type: String, default: null },
        syncInProgress: { type: Boolean, default: false },
        lastSyncError: { type: String, default: null },
        syncType: { type: String, default: null },
        syncStartedAt: { type: Date, default: null },
        sizeTotal: { type: Number, default: null },
      },
      default: () => ({
        lastFullSyncAt: null,
        lastDeltaSyncAt: null,
        deltaToken: null,
        checkpointData: null,
        totalDocuments: 0,
        processedDocuments: 0,
        failedDocuments: 0,
        currentJobId: null,
        syncInProgress: false,
        lastSyncError: null,
        syncType: null,
        syncStartedAt: null,
        sizeTotal: null,
      }),
    },

    // Filters
    filterConfig: {
      type: {
        standard: {
          type: {
            contentCategories: { type: [String], default: ['files'] },
            fileExtensions: {
              type: Schema.Types.Mixed,
              default: null,
            },
            maxFileSizeBytes: { type: Number, default: null },
            minFileSizeBytes: { type: Number, default: null },
            modifiedAfter: { type: Date, default: null },
            modifiedBefore: { type: Date, default: null },
            createdAfter: { type: Date, default: null },
            createdBefore: { type: Date, default: null },
          },
          default: () => ({
            contentCategories: ['files'],
            fileExtensions: null,
            maxFileSizeBytes: null,
            minFileSizeBytes: null,
            modifiedAfter: null,
            modifiedBefore: null,
            createdAfter: null,
            createdBefore: null,
          }),
        },
        scope: {
          type: Schema.Types.Mixed,
          default: () => ({}),
        },
        advancedFilters: {
          type: Schema.Types.Mixed,
          default: () => ({
            enabled: false,
            rootOperator: 'AND',
            conditions: [],
            groups: [],
          }),
        },
        version: { type: Number, default: 1 },
      },
      default: () => ({
        standard: {
          contentCategories: ['files'],
          fileExtensions: null,
          maxFileSizeBytes: null,
          minFileSizeBytes: null,
          modifiedAfter: null,
          modifiedBefore: null,
          createdAfter: null,
          createdBefore: null,
        },
        scope: {},
        advancedFilters: {
          enabled: false,
          rootOperator: 'AND',
          conditions: [],
          groups: [],
        },
        version: 1,
      }),
    },

    // Permissions
    permissionConfig: {
      type: {
        mode: { type: String, enum: ['enabled', 'disabled'], default: 'disabled' },
        crawlSchedule: { type: String, default: null },
        lastCrawlAt: { type: Date, default: null },
        currentJobId: { type: String, default: null },
        crawlInProgress: { type: Boolean, default: false },
        documentsProcessed: { type: Number, default: 0 },
        averageAccuracy: { type: Number, default: 0 },
        lastCrawlError: { type: String, default: null },
      },
      default: () => ({
        mode: 'disabled',
        crawlSchedule: null,
        lastCrawlAt: null,
        currentJobId: null,
        crawlInProgress: false,
        documentsProcessed: 0,
        averageAccuracy: 0,
        lastCrawlError: null,
      }),
    },

    // Error Tracking
    errorState: {
      type: {
        consecutiveFailures: { type: Number, default: 0 },
        lastErrorAt: { type: Date, default: null },
        lastErrorMessage: { type: String, default: null },
        isPaused: { type: Boolean, default: false },
        pausedAt: { type: Date, default: null },
        pauseReason: { type: String, default: null },
      },
      default: () => ({
        consecutiveFailures: 0,
        lastErrorAt: null,
        lastErrorMessage: null,
        isPaused: false,
        pausedAt: null,
        pauseReason: null,
      }),
    },

    // Setup Metadata
    configurationSource: {
      type: String,
      enum: ['manual', 'quick_setup', 'imported'],
      default: 'manual',
    },
    discoveryId: { type: String, default: null },
    recommendationId: { type: String, default: null },
    autoConfiguredAt: { type: Date, default: null },

    // Notifications
    notifications: {
      type: {
        emailAlertsEnabled: { type: Boolean, default: false },
        emailEvents: { type: [String], default: [] },
        webhookUrl: { type: String, default: null },
        webhookEvents: { type: [String], default: [] },
      },
      default: () => ({
        emailAlertsEnabled: false,
        emailEvents: [],
        webhookUrl: null,
        webhookEvents: [],
      }),
    },

    uploadFieldHints: {
      type: Schema.Types.Mixed,
      default: null,
    },

    // Pre-Sync Field Configuration
    fieldConfig: {
      type: Schema.Types.Mixed,
      default: null,
    },

    _v: { type: Number, default: 1 },
  },
  { timestamps: true, collection: 'connector_configs' },
);

// ─── Plugins ─────────────────────────────────────────────────────────────

ConnectorConfigSchema.plugin(tenantIsolationPlugin);

// ─── Indexes ─────────────────────────────────────────────────────────────

// Primary lookup: connector by source
ConnectorConfigSchema.index({ tenantId: 1, sourceId: 1 }, { unique: true });

// Lookup by connector type
ConnectorConfigSchema.index({ tenantId: 1, connectorType: 1 });

// Find connectors needing sync (not paused, has auth)
ConnectorConfigSchema.index({ 'errorState.isPaused': 1, oauthTokenId: 1 });

// Find connectors with errors
ConnectorConfigSchema.index({ 'errorState.consecutiveFailures': 1 });

// ─── Model ───────────────────────────────────────────────────────────────

// Register with ModelRegistry for dual-database support
ModelRegistry.registerModelDefinition('ConnectorConfig', ConnectorConfigSchema, 'platform');

export const ConnectorConfig =
  (mongoose.models.ConnectorConfig as mongoose.Model<IConnectorConfig>) ||
  model<IConnectorConfig>('ConnectorConfig', ConnectorConfigSchema);
