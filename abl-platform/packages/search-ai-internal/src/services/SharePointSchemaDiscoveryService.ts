import { createLogger, type Logger } from '@agent-platform/shared-observability';
import {
  SchemaDiscoveryService,
  type DiscoveredSchema,
  type DiscoveredField,
  type SchemaDiscoveryOptions,
} from './SchemaDiscoveryService.js';

const defaultLogger = createLogger('sp-schema-discovery');

// ─── Local Graph API Types ──────────────────────────────────────────────────
// Defined locally to avoid cyclic dependency with @agent-platform/connector-sharepoint.
// Canonical source: packages/connectors/sharepoint/src/client/graph-types.ts
// Keep in sync with GraphColumnDefinition and GraphList when adding new column types.

/** Subset of GraphColumnDefinition fields used during schema discovery */
export interface SPColumnDefinition {
  id: string;
  name: string;
  displayName: string;
  description: string;
  readOnly: boolean;
  hidden: boolean;
  required: boolean;
  indexed: boolean;
  text?: { allowMultipleLines: boolean; maxLength: number };
  number?: { decimalPlaces: string; maximum: number; minimum: number };
  dateTime?: { displayAs: string; format: string };
  boolean?: Record<string, never>;
  choice?: { allowTextEntry: boolean; choices: string[]; displayAs: string };
  lookup?: { allowMultipleValues: boolean; columnName: string; listId: string };
  personOrGroup?: { allowMultipleSelection: boolean; chooseFromType: string };
  currency?: { locale: string };
  calculated?: { format: string; formula: string; outputType: string };
  hyperlinkOrPicture?: { isPicture: boolean };
  contentApprovalStatus?: Record<string, never>;
}

/** Subset of GraphList fields used during schema discovery */
export interface SPListInfo {
  id: string;
  name: string;
  displayName: string;
  list: { hidden: boolean };
}

/** Minimal Graph client interface for schema discovery operations */
export interface SPGraphClient {
  getLists(siteId: string): Promise<SPListInfo[]>;
  getListColumns(siteId: string, listId: string): Promise<SPColumnDefinition[]>;
  getSites(): Promise<unknown[]>;
}

// ─── Error Codes ────────────────────────────────────────────────────────────

/** Error codes for SharePoint schema discovery */
export const SP_ERROR_CODES = {
  AUTH_FAILED: 'ERR_SP_AUTH_FAILED',
  LIST_NOT_FOUND: 'ERR_SP_LIST_NOT_FOUND',
} as const;

// ─── Options & Config Interfaces ────────────────────────────────────────────

/** Options specific to SharePoint schema discovery */
export interface SharePointDiscoveryOptions extends SchemaDiscoveryOptions {
  /** Optional siteId to scope discovery (otherwise uses connector's configured site) */
  siteId?: string;
  /** Optional listId to discover a specific list (otherwise discovers all lists) */
  listId?: string;
}

/** Dependency interface for connector config lookup */
export interface ConnectorConfigProvider {
  getConnectorConfig(
    connectorId: string,
    tenantId: string,
  ): Promise<SharePointConnectorInfo | null>;
}

/** Minimal connector info needed for schema discovery */
export interface SharePointConnectorInfo {
  connectorId: string;
  tenantId: string;
  /** Primary site (legacy single-site) */
  siteId: string;
  /** All selected sites for multi-site discovery */
  siteIds?: string[];
  connectionConfig: {
    tenantUrl?: string;
    clientId?: string;
    scopes?: string[];
  };
}

/** Dependency interface for creating a Graph client from connector config */
export interface GraphClientFactory {
  createClient(config: SharePointConnectorInfo): Promise<SPGraphClient>;
}

// ─── Service Implementation ─────────────────────────────────────────────────

/**
 * SharePoint Schema Discovery Service
 *
 * Discovers field schemas from SharePoint lists via Microsoft Graph API.
 * Extends the abstract SchemaDiscoveryService with SharePoint-specific logic.
 */
export class SharePointSchemaDiscoveryService extends SchemaDiscoveryService {
  private connectorConfigProvider: ConnectorConfigProvider;
  private graphClientFactory: GraphClientFactory;

  constructor(
    connectorConfigProvider: ConnectorConfigProvider,
    graphClientFactory: GraphClientFactory,
    logger?: Logger,
  ) {
    super(logger ?? defaultLogger);
    this.connectorConfigProvider = connectorConfigProvider;
    this.graphClientFactory = graphClientFactory;
  }

  async discoverSchema(options: SharePointDiscoveryOptions): Promise<DiscoveredSchema> {
    const { connectorId, tenantId, siteId, listId } = options;

    // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.start' when TraceStore is injected
    this.logger.info('SharePoint schema discovery started', { tenantId, connectorId });

    const connectorConfig = await this.connectorConfigProvider.getConnectorConfig(
      connectorId,
      tenantId,
    );
    if (!connectorConfig) {
      throw new Error(`Connector not found: ${connectorId} for tenant ${tenantId}`);
    }

    let client: SPGraphClient;
    try {
      client = await this.graphClientFactory.createClient(connectorConfig);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.error' when TraceStore is injected
      this.logger.error('SharePoint auth failed', { tenantId, connectorId, error: errorMsg });
      throw Object.assign(new Error(`${SP_ERROR_CODES.AUTH_FAILED}: ${errorMsg}`), {
        code: SP_ERROR_CODES.AUTH_FAILED,
      });
    }

    const allFields: DiscoveredField[] = [];

    try {
      // For file-based connectors (syncing documents from drives), the schema
      // is the well-known DriveItem metadata — no API call needed.
      // List-based discovery is only relevant for structured data (SharePoint Lists).
      if (listId) {
        // Specific list requested — query its columns via Graph API
        const targetSiteId = siteId ?? connectorConfig.siteId;
        const columns = await client.getListColumns(targetSiteId, listId);
        allFields.push(...this.mapColumns(columns, listId));
      } else {
        // Default: return standard DriveItem metadata fields
        allFields.push(...SHAREPOINT_DRIVE_ITEM_FIELDS);
      }
    } catch (err: unknown) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      const status = (err as { status?: number }).status;

      if (status === 401 || status === 403) {
        this.logger.error('SharePoint auth failed during discovery', {
          tenantId,
          connectorId,
          error: errorMsg,
        });
        throw Object.assign(new Error(`${SP_ERROR_CODES.AUTH_FAILED}: ${errorMsg}`), {
          code: SP_ERROR_CODES.AUTH_FAILED,
        });
      }

      if (status === 404) {
        this.logger.error('SharePoint list not found', {
          tenantId,
          connectorId,
          error: errorMsg,
        });
        throw Object.assign(new Error(`${SP_ERROR_CODES.LIST_NOT_FOUND}: ${errorMsg}`), {
          code: SP_ERROR_CODES.LIST_NOT_FOUND,
        });
      }

      throw err;
    }

    // TODO(Story 1.8): emit TraceEvent 'search-ai.schema-discovery.complete' when TraceStore is injected
    this.logger.info('SharePoint schema discovery complete', {
      tenantId,
      connectorId,
      fieldCount: allFields.length,
    });

    return {
      connectorId,
      tenantId,
      fields: allFields,
      discoveryMethod: 'api',
      discoveredAt: new Date(),
      metadata: {
        connectorType: 'sharepoint',
        version: 'v1.0',
      },
    };
  }

  async validateCredentials(connectorId: string, tenantId: string): Promise<boolean> {
    const connectorConfig = await this.connectorConfigProvider.getConnectorConfig(
      connectorId,
      tenantId,
    );
    if (!connectorConfig) return false;

    try {
      const client = await this.graphClientFactory.createClient(connectorConfig);
      await client.getSites();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Map SharePoint columns to DiscoveredField array, filtering out hidden/system fields.
   */
  private mapColumns(columns: SPColumnDefinition[], listId: string): DiscoveredField[] {
    return columns
      .filter((col) => !col.hidden && !col.readOnly)
      .map((col) => this.mapColumn(col, listId));
  }

  /**
   * Map a single SharePoint column to a DiscoveredField.
   */
  private mapColumn(column: SPColumnDefinition, listId: string): DiscoveredField {
    return {
      name: column.name,
      type: mapSharePointType(column),
      path: `lists/${listId}/columns/${column.name}`,
      metadata: {
        description: column.displayName ? column.displayName : undefined,
        required: column.required ? true : undefined,
        enumValues: column.choice?.choices,
        format: getColumnFormat(column),
      },
    };
  }
}

// ─── Type Mapping Utilities ─────────────────────────────────────────────────

/**
 * Map SharePoint column type to canonical type string.
 */
export function mapSharePointType(column: SPColumnDefinition): string {
  if (column.text) return 'string';
  if (column.number) return 'number';
  if (column.currency) return 'number';
  if (column.dateTime) return 'date';
  if (column.boolean) return 'boolean';
  if (column.choice) return 'string';
  if (column.lookup) return 'string';
  if (column.personOrGroup) return 'string';
  if (column.calculated) return 'string';
  if (column.hyperlinkOrPicture) return 'string';
  return 'string';
}

function getColumnFormat(column: SPColumnDefinition): string | undefined {
  if (column.dateTime) return column.dateTime.format;
  if (column.number) return `decimal:${column.number.decimalPlaces}`;
  if (column.currency) return `currency:${column.currency.locale}`;
  return undefined;
}

// ─── Static DriveItem Schema ────────────────────────────────────────────────

/**
 * Well-known DriveItem metadata fields for SharePoint file-based connectors.
 * These are standard across all sites and drives — no API call needed.
 * Matches the FILE_STORAGE connector-type template field patterns.
 */
const SHAREPOINT_DRIVE_ITEM_FIELDS: DiscoveredField[] = [
  {
    name: 'itemName',
    type: 'string',
    path: 'sharepoint.itemName',
    metadata: { description: 'File or folder name' },
  },
  {
    name: 'createdBy',
    type: 'string',
    path: 'sharepoint.createdBy',
    metadata: { description: 'User who created the item' },
  },
  {
    name: 'lastModifiedBy',
    type: 'string',
    path: 'sharepoint.lastModifiedBy',
    metadata: { description: 'User who last modified the item' },
  },
  {
    name: 'createdDateTime',
    type: 'date',
    path: 'sharepoint.createdDateTime',
    metadata: { description: 'Date and time the item was created', format: 'dateTimeOffset' },
  },
  {
    name: 'lastModifiedDateTime',
    type: 'date',
    path: 'sharepoint.lastModifiedDateTime',
    metadata: { description: 'Date and time the item was last modified', format: 'dateTimeOffset' },
  },
  {
    name: 'itemWebUrl',
    type: 'string',
    path: 'sharepoint.itemWebUrl',
    metadata: { description: 'URL to access the item in a browser' },
  },
  {
    name: 'size',
    type: 'number',
    path: 'sharepoint.size',
    metadata: { description: 'File size in bytes' },
  },
  {
    name: 'mimeType',
    type: 'string',
    path: 'sharepoint.mimeType',
    metadata: {
      description: 'MIME type of the file',
      enumValues: [
        'application/pdf',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'application/vnd.openxmlformats-officedocument.presentationml.presentation',
        'text/plain',
        'text/csv',
        'text/html',
      ],
    },
  },
  {
    name: 'parentPath',
    type: 'string',
    path: 'sharepoint.parentPath',
    metadata: { description: 'Path of the parent folder' },
  },
  {
    name: 'siteId',
    type: 'string',
    path: 'sharepoint.siteId',
    metadata: { description: 'SharePoint site containing this item' },
  },
  {
    name: 'driveId',
    type: 'string',
    path: 'sharepoint.driveId',
    metadata: { description: 'Document library (drive) containing this item' },
  },
];
