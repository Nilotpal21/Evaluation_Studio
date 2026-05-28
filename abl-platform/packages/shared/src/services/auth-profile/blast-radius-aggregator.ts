/**
 * Blast-Radius Aggregator
 *
 * Aggregates consumer counts, affected users, and active sessions for a
 * given auth profile. Used by the revoke-preview route to show admins
 * what will be affected before they confirm a revoke or delete action.
 *
 * Consumer query logic is extracted from the Studio consumers route
 * (`apps/studio/src/app/api/projects/[id]/auth-profiles/[profileId]/consumers/route.ts`)
 * so both Studio and runtime can call it.
 */

import { createLogger } from '@agent-platform/shared-observability';
import { buildAuthProfileOAuthProviderKey } from '@agent-platform/shared-auth-profile';

const log = createLogger('blast-radius-aggregator');

// ─── Types ────────────────────────────────────────────────────────────

export interface BlastRadiusPayload {
  type: 'profile' | 'tokens';
  affectedConsumers: {
    tools: number;
    integrationNodes: number;
    mcpServers: number;
    a2aServers: number;
    connectorConnections: number;
    channelConnections: number;
    serviceNodes: number;
    gitIntegrations: number;
    triggerRegistrations: number;
  };
  affectedUsers: number;
  activeSessions: number;
  irreversible?: boolean;
  cascadeDeletesTokens?: number;
}

export interface BlastRadiusOptions {
  type: 'profile' | 'tokens';
  userId?: string;
}

/**
 * Injectable model dependencies for blast-radius aggregation.
 * When omitted, the aggregator uses the default dynamic import from
 * `@agent-platform/database/models`.
 */
export interface BlastRadiusDeps {
  ConnectorConnection: { countDocuments(filter: Record<string, unknown>): Promise<number> };
  ChannelConnection: { countDocuments(filter: Record<string, unknown>): Promise<number> };
  MCPServerConfig: { countDocuments(filter: Record<string, unknown>): Promise<number> };
  ServiceNode: { countDocuments(filter: Record<string, unknown>): Promise<number> };
  GitIntegration: { countDocuments(filter: Record<string, unknown>): Promise<number> };
  TriggerRegistration: { countDocuments(filter: Record<string, unknown>): Promise<number> };
  EndUserOAuthToken: {
    countDocuments(filter: Record<string, unknown>): Promise<number>;
    distinct(field: string, filter: Record<string, unknown>): Promise<string[]>;
  };
}

// ─── Aggregator ───────────────────────────────────────────────────────

/**
 * Aggregate the blast radius for a revoke or delete operation on an auth profile.
 *
 * @param profileId  The auth profile ID
 * @param tenantId   Tenant scope
 * @param projectId  Project scope
 * @param options    Type of operation and optional userId filter
 * @param deps       Optional DI — pass model stubs to avoid the dynamic import
 */
export async function aggregate(
  profileId: string,
  tenantId: string,
  projectId: string,
  options: BlastRadiusOptions,
  deps?: BlastRadiusDeps,
): Promise<BlastRadiusPayload> {
  try {
    let ConnectorConnection: BlastRadiusDeps['ConnectorConnection'];
    let ChannelConnection: BlastRadiusDeps['ChannelConnection'];
    let MCPServerConfig: BlastRadiusDeps['MCPServerConfig'];
    let ServiceNode: BlastRadiusDeps['ServiceNode'];
    let GitIntegration: BlastRadiusDeps['GitIntegration'];
    let TriggerRegistration: BlastRadiusDeps['TriggerRegistration'];
    let EndUserOAuthToken: BlastRadiusDeps['EndUserOAuthToken'];

    if (deps) {
      ({
        ConnectorConnection,
        ChannelConnection,
        MCPServerConfig,
        ServiceNode,
        GitIntegration,
        TriggerRegistration,
        EndUserOAuthToken,
      } = deps);
    } else {
      const models = await import('@agent-platform/database/models');
      ConnectorConnection =
        models.ConnectorConnection as unknown as BlastRadiusDeps['ConnectorConnection'];
      ChannelConnection =
        models.ChannelConnection as unknown as BlastRadiusDeps['ChannelConnection'];
      MCPServerConfig = models.MCPServerConfig as unknown as BlastRadiusDeps['MCPServerConfig'];
      ServiceNode = models.ServiceNode as unknown as BlastRadiusDeps['ServiceNode'];
      GitIntegration = models.GitIntegration as unknown as BlastRadiusDeps['GitIntegration'];
      TriggerRegistration =
        models.TriggerRegistration as unknown as BlastRadiusDeps['TriggerRegistration'];
      EndUserOAuthToken =
        models.EndUserOAuthToken as unknown as BlastRadiusDeps['EndUserOAuthToken'];
    }

    const provider = buildAuthProfileOAuthProviderKey(profileId);

    // Build token query filter
    const tokenFilter: Record<string, unknown> = {
      tenantId,
      provider,
      revokedAt: null,
    };
    if (options.userId) {
      tokenFilter.userId = options.userId;
    }

    // Run all queries in parallel
    const [
      connectorConnections,
      channelConnections,
      mcpServers,
      serviceNodes,
      gitIntegrations,
      triggers,
      tokenCount,
      affectedUserIds,
    ] = await Promise.all([
      ConnectorConnection.countDocuments({
        authProfileId: profileId,
        tenantId,
        projectId,
      }),
      ChannelConnection.countDocuments({
        authProfileId: profileId,
        tenantId,
        projectId,
      }),
      MCPServerConfig.countDocuments({
        authProfileId: profileId,
        tenantId,
        projectId,
      }),
      ServiceNode.countDocuments({
        authProfileId: profileId,
        tenantId,
        projectId,
      }),
      GitIntegration.countDocuments({
        authProfileId: profileId,
        tenantId,
        projectId,
      }),
      TriggerRegistration.countDocuments({
        authProfileId: profileId,
        tenantId,
        projectId,
      }),
      EndUserOAuthToken.countDocuments(tokenFilter),
      EndUserOAuthToken.distinct('userId', tokenFilter),
    ]);

    const payload: BlastRadiusPayload = {
      type: options.type,
      affectedConsumers: {
        // tools and a2aServers are Phase 4 extensions — return 0 for now
        tools: 0,
        integrationNodes: 0,
        mcpServers,
        a2aServers: 0,
        connectorConnections,
        channelConnections,
        serviceNodes,
        gitIntegrations,
        triggerRegistrations: triggers,
      },
      affectedUsers: affectedUserIds.length,
      activeSessions: 0, // Session count requires runtime context — deferred to Phase 3 wiring
    };

    // Profile-level revoke/delete is irreversible and cascade-deletes tokens
    if (options.type === 'profile') {
      payload.irreversible = true;
      payload.cascadeDeletesTokens = tokenCount;
    }

    return payload;
  } catch (err) {
    log.error('blast_radius_aggregation_failed', {
      profileId,
      tenantId,
      projectId,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}
