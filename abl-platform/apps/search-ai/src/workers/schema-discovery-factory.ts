/**
 * Schema Discovery Service Factory
 *
 * Wires connector-specific discovery services with real DB adapters
 * for use by the schema-discovery-worker. Called at worker startup
 * via setDiscoveryServiceFactory().
 *
 * Adapts ConnectorConfig (DB) + GraphClient (OAuth) into the
 * ConnectorConfigProvider + GraphClientFactory interfaces expected
 * by SharePointSchemaDiscoveryService.
 */

import type { IConnectorConfig, IEndUserOAuthToken } from '@agent-platform/database/models';
import {
  type SchemaDiscoveryService,
  SharePointSchemaDiscoveryService,
  type ConnectorConfigProvider,
  type GraphClientFactory,
  type SharePointConnectorInfo,
  type SPGraphClient,
} from '@agent-platform/search-ai-internal/services';
import { GraphClient, MicrosoftOAuthProvider } from '@agent-platform/connector-sharepoint';
import { TokenManager } from '@agent-platform/connectors-base';
import { getLazyModel } from '../db/index.js';

const ConnectorConfig = getLazyModel<IConnectorConfig>('ConnectorConfig');
const EndUserOAuthToken = getLazyModel<IEndUserOAuthToken>('EndUserOAuthToken');

// ─── Adapters ────────────────────────────────────────────────────────────────

/**
 * Adapter: looks up ConnectorConfig from MongoDB and maps to SharePointConnectorInfo.
 */
const sharePointConfigProvider: ConnectorConfigProvider = {
  async getConnectorConfig(
    connectorId: string,
    tenantId: string,
  ): Promise<SharePointConnectorInfo | null> {
    const config = await ConnectorConfig.findOne({ _id: connectorId, tenantId });
    if (!config) return null;

    const scope = (config.filterConfig?.scope ?? {}) as Record<string, unknown>;
    const siteIds = (scope.siteIds ?? []) as string[];

    return {
      connectorId: config._id,
      tenantId: config.tenantId,
      siteId: siteIds[0] ?? '',
      siteIds,
      connectionConfig: {
        tenantUrl: config.connectionConfig.tenantUrl,
        clientId: config.connectionConfig.clientId,
        scopes: config.connectionConfig.scopes,
      },
    };
  },
};

/**
 * Adapter: creates a GraphClient with OAuth token refresh, matching
 * the same pattern used by SharePointConnector.initialize().
 *
 * Returns the GraphClient which satisfies the SPGraphClient interface
 * (getLists, getListColumns, getSites are all native methods).
 */
const sharePointGraphClientFactory: GraphClientFactory = {
  async createClient(info: SharePointConnectorInfo): Promise<SPGraphClient> {
    const config = await ConnectorConfig.findOne({
      _id: info.connectorId,
      tenantId: info.tenantId,
    });
    if (!config) {
      throw new Error(`ConnectorConfig not found: ${info.connectorId}`);
    }

    if (!config.oauthTokenId) {
      throw new Error('No OAuth token linked to this connector. Please authenticate first.');
    }

    const oauthToken = await EndUserOAuthToken.findOne({
      _id: config.oauthTokenId,
      tenantId: config.tenantId,
      revokedAt: null,
    });
    if (!oauthToken) {
      throw new Error('OAuth token not found or revoked. Please re-authenticate.');
    }

    const oauthProvider = new MicrosoftOAuthProvider({
      clientId: config.connectionConfig.clientId || '',
      tenantId: config.connectionConfig.tenantId as string | undefined,
    });

    const tokenManager = new TokenManager(
      oauthProvider,
      config.tenantId,
      oauthToken.userId,
      EndUserOAuthToken,
    );

    const graphClient = new GraphClient({
      tokenManager,
      rateLimit: config.connectionConfig.rateLimit as
        | { maxRequests?: number; requestsPerSecond?: number }
        | undefined,
    });

    // GraphClient natively implements getLists, getListColumns, getSites
    return graphClient as unknown as SPGraphClient;
  },
};

// ─── Factory Function ────────────────────────────────────────────────────────

/**
 * Create the discovery service factory for use with setDiscoveryServiceFactory().
 * Returns a function that maps connectorType → SchemaDiscoveryService instance.
 */
export function createDiscoveryServiceFactory(): (connectorType: string) => SchemaDiscoveryService {
  return (connectorType: string): SchemaDiscoveryService => {
    switch (connectorType) {
      case 'sharepoint':
        return new SharePointSchemaDiscoveryService(
          sharePointConfigProvider,
          sharePointGraphClientFactory,
        );
      default:
        throw new Error(`Schema discovery not supported for connector type: ${connectorType}`);
    }
  };
}
