/**
 * Connector Registry Singleton
 *
 * Lazily initializes and caches the ConnectorRegistry and ConnectionResolver
 * for the runtime process. Provides:
 * - getConnectorRegistry(): the loaded ConnectorRegistry
 * - getConnectionResolver(): tenant-scoped ConnectionResolver
 * - buildConnectorToolResolver(): factory for the DI resolver used by resolveToolImplementations
 * - createConnectorToolExecutorAdapter(): creates a ToolExecutor adapter for ToolBindingExecutor
 *
 * Call initConnectorRegistry() at server startup (after DB and encryption init).
 */

import { createLogger } from '@abl/compiler/platform';
import type { ToolExecutor } from '@abl/compiler';
import type { ToolDefinitionLocal } from '@agent-platform/shared/tools';

const log = createLogger('connector-registry-singleton');

// Lazy-loaded types to avoid top-level imports of optional dependencies
type ConnectorRegistryType = import('@agent-platform/connectors').ConnectorRegistry;
type ConnectionResolverType = import('@agent-platform/connectors').ConnectionResolver;

let _registry: ConnectorRegistryType | null = null;
let _connectionResolver: ConnectionResolverType | null = null;
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

/**
 * Initialize the connector registry at startup.
 * Safe to call multiple times — only the first call performs initialization.
 */
export async function initConnectorRegistry(): Promise<void> {
  if (_initPromise) return _initPromise;

  _initPromise = (async () => {
    try {
      const { ConnectorRegistry, loadConnectors, connectorActionToToolDefinition } =
        await import('@agent-platform/connectors');
      _registry = new ConnectorRegistry();
      _connectorActionToToolDef = connectorActionToToolDefinition;
      await loadConnectors(_registry);
      log.info('Connector registry initialized', {
        connectorCount: _registry.listConnectors().length,
      });
    } catch (err) {
      log.warn('Failed to initialize connector registry — connector tools will be unavailable', {
        error: err instanceof Error ? err.message : String(err),
      });
      _registry = null;
      _initPromise = null; // Allow retry on transient failures
    }
  })();

  return _initPromise;
}

/**
 * Get the initialized ConnectorRegistry, or null if not yet initialized or failed.
 */
export function getConnectorRegistry(): ConnectorRegistryType | null {
  return _registry;
}

/**
 * Get or create a ConnectionResolver.
 * Requires encryption service and database to be available.
 */
export async function getConnectionResolver(): Promise<ConnectionResolverType | null> {
  if (_connectionResolver) return _connectionResolver;

  try {
    const { ConnectionResolver } = await import('@agent-platform/connectors');
    const { createAuthProfileResolver } = await import('@agent-platform/connectors/services');
    const { decryptForTenantAuto, isTenantEncryptionReady } =
      await import('@agent-platform/shared/encryption');
    const { ConnectorConnection, AuthProfile } = await import('@agent-platform/database/models');

    if (!isTenantEncryptionReady()) {
      log.warn('Tenant DEK encryption not ready — ConnectionResolver cannot be created');
      return null;
    }

    // Build the ConnectorConnectionModel adapter from the Mongoose model
    const connectionModel = {
      async findOne(filter: Record<string, unknown>) {
        return ConnectorConnection.findOne(filter).lean();
      },
    };

    const authProfileResolver = createAuthProfileResolver({
      authProfileModel: AuthProfile as any,
      decrypt: (ciphertext, tenantId) => decryptForTenantAuto(ciphertext, tenantId),
    });

    // ABLP-913 fallback: lets ConnectionResolver synthesise a connection
    // from an auth-profile id when the IR's connectionId is actually an
    // auth-profile reference rather than a ConnectorConnection id.
    const authProfileLookupModel = {
      async findOne(filter: Record<string, unknown>) {
        return (AuthProfile as any).findOne(filter).lean();
      },
    };

    _connectionResolver = new ConnectionResolver(
      connectionModel,
      authProfileResolver,
      undefined,
      authProfileLookupModel,
    );
    return _connectionResolver;
  } catch (err) {
    log.warn('Failed to create ConnectionResolver', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Build the connector tool resolver function for dependency injection into
 * resolveToolImplementations(). Converts connector actions into ToolDefinitionLocal
 * objects when a tool name matches the "connector.action" pattern.
 *
 * Returns undefined if the registry is not initialized.
 */
export function buildConnectorToolResolver():
  | ((connectorName: string, actionName: string) => Promise<ToolDefinitionLocal | null>)
  | undefined {
  if (!_registry) return undefined;

  const registry = _registry;

  return async (connectorName: string, actionName: string): Promise<ToolDefinitionLocal | null> => {
    try {
      if (!registry.has(connectorName)) return null;

      const action = await registry.getAction(connectorName, actionName);
      if (!action) return null;

      if (!_connectorActionToToolDef) return null;
      const connectorToolDef = _connectorActionToToolDef(connectorName, action);

      // Convert ConnectorToolDefinition → ToolDefinitionLocal
      const toolDef: ToolDefinitionLocal = {
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

      return toolDef;
    } catch (err) {
      log.debug('Connector tool resolution failed', {
        connectorName,
        actionName,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  };
}

/**
 * Create a ToolExecutor adapter that wraps ConnectorToolExecutor for use
 * with ToolBindingExecutor. Returns null if prerequisites are unavailable.
 */
export async function createConnectorToolExecutorAdapter(
  tenantId: string,
  projectId: string,
  userId?: string,
): Promise<ToolExecutor | null> {
  if (!_registry) return null;

  const connectionResolver = await getConnectionResolver();
  if (!connectionResolver) return null;

  try {
    const { ConnectorToolExecutor } = await import('@agent-platform/connectors');

    const executor = new ConnectorToolExecutor(_registry, connectionResolver, {
      tenantId,
      projectId,
      userId,
    });

    // Wrap as ToolExecutor (the interface used by ToolBindingExecutor)
    return {
      execute: (toolName: string, params: Record<string, unknown>, timeoutMs: number) =>
        executor.execute(toolName, params, timeoutMs),
      executeParallel: async (
        calls: Array<{ name: string; params: Record<string, unknown> }>,
        timeoutMs: number,
      ) => {
        return Promise.all(
          calls.map(async ({ name, params }) => {
            try {
              const result = await executor.execute(name, params, timeoutMs);
              return { name, result };
            } catch (error) {
              return {
                name,
                error: error instanceof Error ? error.message : 'Unknown error',
              };
            }
          }),
        );
      },
    };
  } catch (err) {
    log.warn('Failed to create ConnectorToolExecutor adapter', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Convert a JSON Schema object (from propsToJsonSchema) into ToolParameterLocal[].
 */
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
