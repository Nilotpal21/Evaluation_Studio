/**
 * Connection Service Singleton — Studio
 *
 * Instantiates ConnectionService with Studio-specific deps
 * (MongoDB model, connector registry).
 *
 * Connections are pure binding records — all credential storage
 * is handled by the auth profile system.
 *
 * Lazy-initialized on first access so import doesn't fail if DB isn't ready.
 */

import { createLogger } from '@abl/compiler/platform/logger.js';
import { ConnectionService, createAuthProfileResolver } from '@agent-platform/connectors/services';
import { ConnectorRegistry } from '@agent-platform/connectors/registry';
import { loadConnectors } from '@agent-platform/connectors';
import { repairLegacyConnectorConnectionIndexes } from '@agent-platform/database/mongo';
import { ConnectorConnection } from '@agent-platform/database/models';
import type { ToolDefinitionLocal } from '@agent-platform/shared/tools';
import { CONNECTION_BACKED_AGENT_DESKTOP_PROVIDERS } from '@/components/connections/agent-desktop-registry';

let _connectionService: ConnectionService | null = null;
let _registry: ConnectorRegistry | null = null;
let _initPromise: Promise<void> | null = null;
let _connectorActionToToolDef:
  | ((
      connectorName: string,
      action: any,
    ) => {
      name: string;
      description: string;
      parameters: Record<string, unknown>;
      tool_type: 'connector';
    })
  | null = null;
const log = createLogger('studio-connection-service');

async function ensureInitialized(): Promise<void> {
  if (_connectionService) return;
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    const { ensureDb } = await import('@/lib/ensure-db');
    await ensureDb();

    const { AuthProfile } = await import('@agent-platform/database/models');

    try {
      await repairLegacyConnectorConnectionIndexes(log);
    } catch (err: unknown) {
      log.warn(
        'Failed to reconcile connector connection indexes before initializing ConnectionService',
        {
          error: err instanceof Error ? err.message : String(err),
        },
      );
    }

    _registry = new ConnectorRegistry();
    const { connectorActionToToolDefinition } = await import('@agent-platform/connectors');
    _connectorActionToToolDef = connectorActionToToolDefinition as NonNullable<
      typeof _connectorActionToToolDef
    >;
    await loadConnectors(_registry);

    // Studio uses Mongoose auto-decrypt plugin — no explicit decrypt function needed.
    const authProfileResolver = createAuthProfileResolver({
      authProfileModel: AuthProfile as any,
    });

    _connectionService = new ConnectionService({
      connectionModel: ConnectorConnection as any,
      registry: _registry,
      authProfileResolver,
      allowedConnectorNames: new Set(CONNECTION_BACKED_AGENT_DESKTOP_PROVIDERS.map((p) => p.id)),
    });
  })()
    .then(() => {
      _initPromise = null;
    })
    .catch((err) => {
      _initPromise = null;
      _connectionService = null;
      _registry = null;
      throw err;
    });

  return _initPromise;
}

export async function getConnectionService(): Promise<ConnectionService> {
  await ensureInitialized();
  return _connectionService!;
}

export async function buildStudioConnectorToolResolver(): Promise<
  ((connectorName: string, actionName: string) => Promise<ToolDefinitionLocal | null>) | undefined
> {
  await ensureInitialized();
  const connectorActionToToolDef = _connectorActionToToolDef;
  if (!_registry || !connectorActionToToolDef) {
    return undefined;
  }

  const registry = _registry;

  return async (connectorName: string, actionName: string): Promise<ToolDefinitionLocal | null> => {
    try {
      if (!registry.has(connectorName)) {
        return null;
      }

      const action = await registry.getAction(connectorName, actionName);
      if (!action) {
        return null;
      }

      const connectorToolDef = connectorActionToToolDef(connectorName, action);
      return {
        name: connectorToolDef.name,
        description: connectorToolDef.description,
        parameters: convertJsonSchemaToParams(connectorToolDef.parameters),
        returns: { type: 'object' },
        hints: {
          cacheable: false,
          latency: 'medium',
          parallelizable: true,
          side_effects: true,
          requires_auth: true,
        },
        tool_type: 'connector',
        connector_binding: {
          connector: connectorName,
          action: actionName,
        },
      };
    } catch (err) {
      log.debug('Failed to resolve Studio connector tool', {
        connectorName,
        actionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
}

/**
 * Returns the live ConnectorRegistry — needed by routes that want to invoke
 * runtime hooks like `auth.validateAuth` (the per-connector "test connection"
 * function surfaced by Activepieces pieces).
 */
export async function getConnectorRegistry(): Promise<ConnectorRegistry> {
  await ensureInitialized();
  return _registry!;
}

function convertJsonSchemaToParams(schema: Record<string, unknown>): Array<{
  name: string;
  type: string;
  required: boolean;
  description?: string;
  enum?: unknown[];
  default?: unknown;
}> {
  const properties = (schema.properties ?? {}) as Record<string, Record<string, unknown>>;
  const required = new Set((schema.required ?? []) as string[]);

  return Object.entries(properties).map(([name, prop]) => ({
    name,
    type: (prop.type as string) ?? 'string',
    required: required.has(name),
    ...(prop.description ? { description: prop.description as string } : {}),
    ...(prop.enum ? { enum: prop.enum as unknown[] } : {}),
    ...(prop.default !== undefined ? { default: prop.default } : {}),
  }));
}
