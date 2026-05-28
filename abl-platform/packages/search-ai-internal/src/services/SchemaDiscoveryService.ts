import { createLogger, type Logger } from '@agent-platform/shared-observability';

/**
 * Schema Discovery Service - Foundation Interface
 *
 * Purpose: Provides abstract interface for connector schema discovery
 * Implementations: SharePoint, Google Sheets, JSON, CSV (Stories 1.2-1.5)
 *
 * @see architecture.md#Decision-1 - API-Only Discovery baseline
 */

/**
 * Discovered field metadata structure
 */
export interface DiscoveredField {
  /** Field name from connector */
  name: string;
  /** Data type: 'string' | 'number' | 'date' | 'boolean' | 'array' */
  type: string;
  /** JSON path or API path to field */
  path: string;
  /** Additional field metadata */
  metadata: {
    /** Field description if available from API */
    description?: string;
    /** Whether field is required */
    required?: boolean;
    /** Possible enum values if detected */
    enumValues?: string[];
    /** Date format, number format, etc. */
    format?: string;
    /** Display names for enum values (from template patterns) */
    enumDisplayNames?: Record<string, string>;
    /** Whether enum values came from template or data inference */
    enumSource?: 'template' | 'inferred';
  };
}

/**
 * Complete discovered schema structure
 */
export interface DiscoveredSchema {
  /** Connector identifier */
  connectorId: string;
  /** Tenant identifier for isolation */
  tenantId: string;
  /** Array of discovered fields */
  fields: DiscoveredField[];
  /** Discovery method used: 'api' = API-only, 'hybrid' = API + samples */
  discoveryMethod: 'api' | 'hybrid';
  /** Timestamp of discovery */
  discoveredAt: Date;
  /** Schema metadata */
  metadata: {
    /** Connector type: 'sharepoint' | 'google-sheets' | etc. */
    connectorType: string;
    /** API version if applicable */
    version?: string;
  };
}

/**
 * Options for schema discovery
 */
export interface SchemaDiscoveryOptions {
  /** Connector identifier */
  connectorId: string;
  /** Tenant identifier for isolation */
  tenantId: string;
  /** Future: enable sample-based enhancement (default: false) */
  useSamples?: boolean;
}

/** Default logger for schema discovery (per AC-4: NFR-S1) */
const defaultLogger = createLogger('schema-discovery');

/**
 * Abstract base class for schema discovery services
 *
 * Implementations will extend this class for specific connector types
 * (SharePoint, Google Sheets, JSON, CSV) in Stories 1.2-1.5
 *
 * TraceEvent patterns for implementations (required by NFR-O1):
 *
 * Discovery start:
 *   TraceStore.createEvent({ type: 'search-ai.schema-discovery.start', tenantId, metadata: { connectorId, connectorType } })
 *
 * Discovery complete:
 *   TraceStore.createEvent({ type: 'search-ai.schema-discovery.complete', tenantId, metadata: { connectorId, fieldCount, discoveryMethod } })
 *
 * Discovery error:
 *   TraceStore.createEvent({ type: 'search-ai.schema-discovery.error', tenantId, metadata: { connectorId, error: errorMsg } })
 */
export abstract class SchemaDiscoveryService {
  protected logger: Logger;

  constructor(logger?: Logger) {
    this.logger = logger ?? defaultLogger;
  }

  /**
   * Discover schema from connector API
   *
   * @param options - Discovery options with connectorId and tenantId
   * @returns Discovered schema with fields array
   * @throws Error if connector not found or API authentication fails
   */
  abstract discoverSchema(options: SchemaDiscoveryOptions): Promise<DiscoveredSchema>;

  /**
   * Validate connector credentials before discovery
   *
   * @param connectorId - Connector ID
   * @param tenantId - Tenant ID for isolation
   * @returns true if credentials valid, false otherwise
   */
  abstract validateCredentials(connectorId: string, tenantId: string): Promise<boolean>;
}
