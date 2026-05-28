/**
 * MCP Server Manager
 *
 * Manages MCP server lifecycle and provides unified tool access.
 * Features:
 * - Server discovery and registration
 * - Automatic connection management
 * - Tool aggregation across servers
 * - Health monitoring
 * - Tenant-scoped server pools (tenant-first, global fallback)
 */

import { EventEmitter } from 'events';
import { MCPClient, type MCPClientConfig } from './client.js';
import type { MCPTool, MCPResource, MCPPrompt } from './protocol.js';
import { createLogger } from '../logger.js';

const log = createLogger('mcp-server-manager');

// =============================================================================
// TYPES
// =============================================================================

export interface MCPServerConfig extends MCPClientConfig {
  /** Whether this server is enabled (default: true) */
  enabled?: boolean;

  /** Priority for tool resolution (higher = preferred) */
  priority?: number;

  /** Tags for filtering */
  tags?: string[];
}

export interface MCPServerInfo {
  name: string;
  connected: boolean;
  serverName?: string;
  serverVersion?: string;
  toolCount: number;
  resourceCount: number;
  promptCount: number;
  tenantId?: string;
  lastError?: string;
  lastConnectedAt?: Date;
}

export interface MCPToolWithServer extends MCPTool {
  serverName: string;
}

export interface MCPResourceWithServer extends MCPResource {
  serverName: string;
}

export interface MCPPromptWithServer extends MCPPrompt {
  serverName: string;
}

// =============================================================================
// SERVER MANAGER
// =============================================================================

export class MCPServerManager extends EventEmitter {
  // Global (shared) servers
  private servers: Map<string, MCPClient> = new Map();
  private configs: Map<string, MCPServerConfig> = new Map();
  private connectionPromises: Map<string, Promise<void>> = new Map();

  // Per-tenant servers
  private tenantServers: Map<string, Map<string, MCPClient>> = new Map();
  private tenantConfigs: Map<string, Map<string, MCPServerConfig>> = new Map();
  private tenantConnectionPromises: Map<string, Map<string, Promise<void>>> = new Map();

  constructor() {
    super();
  }

  // ===========================================================================
  // SERVER MANAGEMENT
  // ===========================================================================

  /**
   * Register a server configuration.
   * If tenantId is provided, the server is scoped to that tenant only.
   */
  registerServer(config: MCPServerConfig, tenantId?: string): void {
    if (tenantId) {
      let tenantMap = this.tenantConfigs.get(tenantId);
      if (!tenantMap) {
        tenantMap = new Map();
        this.tenantConfigs.set(tenantId, tenantMap);
      }
      if (tenantMap.has(config.name)) {
        log.warn('Overwriting tenant server config', { name: config.name, tenantId });
      }
      // Ensure tenantId is set on the config for the MCPClient
      tenantMap.set(config.name, { ...config, tenantId });
      log.info('Tenant server registered', {
        name: config.name,
        tenantId,
        transport: config.transport,
      });
    } else {
      if (this.configs.has(config.name)) {
        log.warn('Overwriting existing server config', { name: config.name });
      }
      this.configs.set(config.name, config);
      log.info('Server registered', { name: config.name, transport: config.transport });
    }
  }

  /**
   * Register multiple servers
   */
  registerServers(configs: MCPServerConfig[], tenantId?: string): void {
    for (const config of configs) {
      this.registerServer(config, tenantId);
    }
  }

  /**
   * Unregister a server
   */
  async unregisterServer(name: string, tenantId?: string): Promise<void> {
    await this.disconnectServer(name, tenantId);
    if (tenantId) {
      this.tenantConfigs.get(tenantId)?.delete(name);
    } else {
      this.configs.delete(name);
    }
  }

  /**
   * Get server configuration (tenant-first, then global)
   */
  getServerConfig(name: string, tenantId?: string): MCPServerConfig | undefined {
    if (tenantId) {
      const tenantConfig = this.tenantConfigs.get(tenantId)?.get(name);
      if (tenantConfig) return tenantConfig;
    }
    return this.configs.get(name);
  }

  /**
   * List all registered servers visible to a tenant.
   * Returns tenant-specific servers + global servers.
   */
  listServers(tenantId?: string): MCPServerInfo[] {
    const infos: MCPServerInfo[] = [];
    const seen = new Set<string>();

    // Tenant-specific servers first
    if (tenantId) {
      const tenantConfigMap = this.tenantConfigs.get(tenantId);
      const tenantServerMap = this.tenantServers.get(tenantId);
      if (tenantConfigMap) {
        for (const [name] of tenantConfigMap) {
          const client = tenantServerMap?.get(name);
          infos.push({
            name,
            connected: client?.connected ?? false,
            serverName: client?.server?.name,
            serverVersion: client?.server?.version,
            toolCount: client?.toolCount ?? 0,
            resourceCount: client?.resourceCount ?? 0,
            promptCount: client?.promptCount ?? 0,
            tenantId,
          });
          seen.add(name);
        }
      }
    }

    // Global servers (skip if tenant has an override)
    for (const [name] of this.configs) {
      if (seen.has(name)) continue;
      const client = this.servers.get(name);
      infos.push({
        name,
        connected: client?.connected ?? false,
        serverName: client?.server?.name,
        serverVersion: client?.server?.version,
        toolCount: client?.toolCount ?? 0,
        resourceCount: client?.resourceCount ?? 0,
        promptCount: client?.promptCount ?? 0,
      });
    }

    return infos;
  }

  // ===========================================================================
  // CONNECTION MANAGEMENT
  // ===========================================================================

  /**
   * Connect to a specific server
   */
  async connectServer(name: string, tenantId?: string): Promise<void> {
    const config = this.getServerConfig(name, tenantId);
    if (!config) {
      throw new Error(`Server not registered: ${name}${tenantId ? ` (tenant: ${tenantId})` : ''}`);
    }

    // Determine which maps to use
    const isTenantScoped = tenantId && this.tenantConfigs.get(tenantId)?.has(name);

    const promisesMap = isTenantScoped
      ? this.getTenantMap(this.tenantConnectionPromises, tenantId!)
      : this.connectionPromises;

    const serversMap = isTenantScoped
      ? this.getTenantMap(this.tenantServers, tenantId!)
      : this.servers;

    // Check if already connecting
    const existing = promisesMap.get(name);
    if (existing) {
      return existing;
    }

    // Check if already connected
    const existingClient = serversMap.get(name);
    if (existingClient?.connected) {
      return;
    }

    const connectPromise = this.doConnect(name, config, serversMap);
    promisesMap.set(name, connectPromise);

    try {
      await connectPromise;
    } finally {
      promisesMap.delete(name);
    }
  }

  private async doConnect(
    name: string,
    config: MCPServerConfig,
    serversMap: Map<string, MCPClient>,
  ): Promise<void> {
    log.info('Connecting to server', { name, tenantId: config.tenantId });

    const client = new MCPClient(config);

    // Set up event handlers
    client.on('connected', () => {
      log.info('Server connected', { name, tenantId: config.tenantId });
      this.emit('serverConnected', name, config.tenantId);
    });

    client.on('disconnected', (reason) => {
      log.warn('Server disconnected', { name, reason, tenantId: config.tenantId });
      this.emit('serverDisconnected', name, reason, config.tenantId);
    });

    client.on('error', (error) => {
      log.error('Server error', { name, error: error.message, tenantId: config.tenantId });
      this.emit('serverError', name, error, config.tenantId);
    });

    client.on('toolsChanged', () => {
      this.emit('toolsChanged', name, config.tenantId);
    });

    client.on('resourcesChanged', () => {
      this.emit('resourcesChanged', name, config.tenantId);
    });

    try {
      await client.connect();
      serversMap.set(name, client);
    } catch (error) {
      log.error('Failed to connect to server', { name, tenantId: config.tenantId, error });
      throw error;
    }
  }

  /**
   * Disconnect from a specific server
   */
  async disconnectServer(name: string, tenantId?: string): Promise<void> {
    if (tenantId) {
      const tenantServerMap = this.tenantServers.get(tenantId);
      const client = tenantServerMap?.get(name);
      if (client) {
        await client.disconnect();
        tenantServerMap!.delete(name);
        return;
      }
    }

    const client = this.servers.get(name);
    if (client) {
      await client.disconnect();
      this.servers.delete(name);
    }
  }

  /**
   * Connect to all registered servers (global + tenant if specified)
   */
  async connectAll(tenantId?: string): Promise<void> {
    const names: string[] = [];

    // Global servers
    for (const name of this.configs.keys()) {
      names.push(name);
    }

    // Tenant-specific servers
    if (tenantId) {
      const tenantConfigMap = this.tenantConfigs.get(tenantId);
      if (tenantConfigMap) {
        for (const name of tenantConfigMap.keys()) {
          if (!names.includes(name)) {
            names.push(name);
          }
        }
      }
    }

    await Promise.all(
      names.map((name) =>
        this.connectServer(name, tenantId).catch((err) =>
          log.warn('Failed to connect server during connectAll', {
            name,
            tenantId,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      ),
    );
  }

  /**
   * Disconnect from all servers (global + all tenants)
   */
  async disconnectAll(): Promise<void> {
    // Disconnect global
    const globalNames = Array.from(this.servers.keys());
    await Promise.all(globalNames.map((name) => this.disconnectServer(name)));

    // Disconnect all tenant servers
    for (const [tenantId, serverMap] of this.tenantServers) {
      const tenantNames = Array.from(serverMap.keys());
      await Promise.all(tenantNames.map((name) => this.disconnectServer(name, tenantId)));
    }
  }

  /**
   * Get a connected client (tenant-first, then global)
   */
  getClient(name: string, tenantId?: string): MCPClient | undefined {
    if (tenantId) {
      const tenantClient = this.tenantServers.get(tenantId)?.get(name);
      if (tenantClient?.connected) return tenantClient;
    }
    const client = this.servers.get(name);
    return client?.connected ? client : undefined;
  }

  // ===========================================================================
  // TOOL ACCESS
  // ===========================================================================

  /**
   * Get all connected servers visible to a tenant (tenant-specific + global)
   */
  private getVisibleServers(
    tenantId?: string,
  ): Array<[string, MCPClient, MCPServerConfig | undefined]> {
    const result: Array<[string, MCPClient, MCPServerConfig | undefined]> = [];
    const seen = new Set<string>();

    // Tenant-specific servers first (higher priority)
    if (tenantId) {
      const tenantServerMap = this.tenantServers.get(tenantId);
      const tenantConfigMap = this.tenantConfigs.get(tenantId);
      if (tenantServerMap) {
        for (const [name, client] of tenantServerMap) {
          if (client.connected) {
            result.push([name, client, tenantConfigMap?.get(name)]);
            seen.add(name);
          }
        }
      }
    }

    // Global servers (skip overridden)
    for (const [name, client] of this.servers) {
      if (seen.has(name) || !client.connected) continue;
      result.push([name, client, this.configs.get(name)]);
    }

    return result;
  }

  /**
   * List all tools from all connected servers visible to a tenant
   */
  async listAllTools(tenantId?: string): Promise<MCPToolWithServer[]> {
    const tools: MCPToolWithServer[] = [];

    for (const [name, client] of this.getVisibleServers(tenantId)) {
      const serverTools = await client.listTools();
      for (const tool of serverTools) {
        tools.push({ ...tool, serverName: name });
      }
    }

    // Sort by server priority
    tools.sort((a, b) => {
      const priorityA = this.getServerConfig(a.serverName, tenantId)?.priority ?? 0;
      const priorityB = this.getServerConfig(b.serverName, tenantId)?.priority ?? 0;
      return priorityB - priorityA;
    });

    return tools;
  }

  /**
   * Find a tool by name (returns first match, tenant-first)
   */
  async findTool(name: string, tenantId?: string): Promise<MCPToolWithServer | undefined> {
    const tools = await this.listAllTools(tenantId);
    return tools.find((t) => t.name === name);
  }

  /**
   * Call a tool on the appropriate server (tenant-first, then global)
   */
  async callTool(
    toolName: string,
    args?: Record<string, unknown>,
    tenantId?: string,
  ): Promise<unknown> {
    for (const [serverName, client] of this.getVisibleServers(tenantId)) {
      const tool = client.getTool(toolName);
      if (tool) {
        log.debug('Calling tool', { toolName, serverName, tenantId, args });
        const result = await client.callTool(toolName, args);

        // Extract text content from result
        if (result.isError) {
          const errorText = result.content
            .filter((c) => c.type === 'text')
            .map((c) => (c as { text: string }).text)
            .join('\n');
          throw new Error(errorText || 'Tool execution failed');
        }

        // Return first text content or full result
        const textContent = result.content.find((c) => c.type === 'text');
        if (textContent && textContent.type === 'text') {
          return textContent.text;
        }

        return result;
      }
    }

    throw new Error(`Tool not found: ${toolName}`);
  }

  // ===========================================================================
  // RESOURCE ACCESS
  // ===========================================================================

  /**
   * List all resources from all connected servers visible to a tenant
   */
  async listAllResources(tenantId?: string): Promise<MCPResourceWithServer[]> {
    const resources: MCPResourceWithServer[] = [];

    for (const [name, client] of this.getVisibleServers(tenantId)) {
      const serverResources = await client.listResources();
      for (const resource of serverResources) {
        resources.push({ ...resource, serverName: name });
      }
    }

    return resources;
  }

  /**
   * Read a resource (tenant-first, then global)
   */
  async readResource(
    uri: string,
    tenantId?: string,
  ): Promise<{ serverName: string; contents: unknown[] }> {
    for (const [serverName, client] of this.getVisibleServers(tenantId)) {
      const resource = client.getResource(uri);
      if (resource) {
        const result = await client.readResource(uri);
        return { serverName, contents: result.contents };
      }
    }

    throw new Error(`Resource not found: ${uri}`);
  }

  // ===========================================================================
  // PROMPT ACCESS
  // ===========================================================================

  /**
   * List all prompts from all connected servers visible to a tenant
   */
  async listAllPrompts(tenantId?: string): Promise<MCPPromptWithServer[]> {
    const prompts: MCPPromptWithServer[] = [];

    for (const [name, client] of this.getVisibleServers(tenantId)) {
      const serverPrompts = await client.listPrompts();
      for (const prompt of serverPrompts) {
        prompts.push({ ...prompt, serverName: name });
      }
    }

    return prompts;
  }

  /**
   * Get a prompt (tenant-first, then global)
   */
  async fetchPrompt(
    name: string,
    args?: Record<string, string>,
    tenantId?: string,
  ): Promise<unknown> {
    for (const [, client] of this.getVisibleServers(tenantId)) {
      const prompt = client.getPrompt(name);
      if (prompt) {
        return client.fetchPrompt(name, args);
      }
    }

    throw new Error(`Prompt not found: ${name}`);
  }

  // ===========================================================================
  // HEALTH
  // ===========================================================================

  /**
   * Check health of all servers (global + tenant if specified)
   */
  checkHealth(tenantId?: string): { healthy: string[]; unhealthy: string[] } {
    const healthy: string[] = [];
    const unhealthy: string[] = [];

    // Check tenant-specific servers
    if (tenantId) {
      const tenantConfigMap = this.tenantConfigs.get(tenantId);
      const tenantServerMap = this.tenantServers.get(tenantId);
      if (tenantConfigMap) {
        for (const [name] of tenantConfigMap) {
          const client = tenantServerMap?.get(name);
          if (client?.connected) {
            healthy.push(name);
          } else {
            unhealthy.push(name);
          }
        }
      }
    }

    // Check global servers
    for (const [name] of this.configs) {
      const client = this.servers.get(name);
      if (client?.connected) {
        healthy.push(name);
      } else {
        unhealthy.push(name);
      }
    }

    return { healthy, unhealthy };
  }

  /**
   * Reconnect unhealthy servers
   */
  async reconnectUnhealthy(tenantId?: string): Promise<void> {
    const { unhealthy } = this.checkHealth(tenantId);
    await Promise.all(
      unhealthy.map((name) =>
        this.connectServer(name, tenantId).catch((err) =>
          log.warn('Failed to reconnect unhealthy server', {
            name,
            tenantId,
            error: err instanceof Error ? err.message : String(err),
          }),
        ),
      ),
    );
  }

  // ===========================================================================
  // HELPERS
  // ===========================================================================

  private getTenantMap<V>(map: Map<string, Map<string, V>>, tenantId: string): Map<string, V> {
    let tenantMap = map.get(tenantId);
    if (!tenantMap) {
      tenantMap = new Map();
      map.set(tenantId, tenantMap);
    }
    return tenantMap;
  }
}

// =============================================================================
// SINGLETON
// =============================================================================

let defaultManager: MCPServerManager | null = null;

/**
 * Get the default server manager
 */
export function getMCPServerManager(): MCPServerManager {
  if (!defaultManager) {
    defaultManager = new MCPServerManager();
  }
  return defaultManager;
}

/**
 * Reset the default manager (for testing)
 */
export function resetMCPServerManager(): void {
  if (defaultManager) {
    defaultManager.disconnectAll().catch((err) =>
      log.warn('Failed to disconnect all servers during reset', {
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    defaultManager = null;
  }
}
