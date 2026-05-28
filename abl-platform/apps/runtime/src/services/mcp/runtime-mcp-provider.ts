/**
 * Runtime MCP Client Provider
 *
 * Bridges the runtime's tool executor with the compiler's MCPServerManager.
 * All MCP server configs are loaded from the DB via MCPServerRegistryService,
 * scoped per project. Servers are loaded lazily when a session is created.
 *
 * Resolution: project-scoped servers (built into MCPServerManager).
 */

import type { McpClientProvider, McpClient } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import {
  createRedisConnection,
  resolveRedisOptionsFromEnv,
  type RedisClient,
  type RedisConnectionHandle,
} from '@agent-platform/redis';
import { randomUUID } from 'node:crypto';
import {
  getMCPServerManager,
  MCPServerManager,
} from '@abl/compiler/platform/mcp/server-manager.js';
import type {
  MCPServerRegistryService,
  MCPServerConfigOutput,
} from '@agent-platform/shared/services/mcp-registry';
import type { ProxyResolver } from '@abl/compiler/platform/constructs/executors/proxy-resolver.js';

type MCPServerConfig =
  InstanceType<typeof MCPServerManager> extends { registerServer(c: infer C, ...args: any[]): void }
    ? C
    : never;

const log = createLogger('runtime-mcp-provider');

function isMcpAuthProfileEnabled(): boolean {
  return process.env.MCP_AUTH_PROFILE_ENABLED !== 'false';
}

interface ServerAuthRefreshMetadata {
  projectId: string;
  serverId: string;
  tenantId: string;
  authProfileId: string;
  authType?: string;
  transport: 'http' | 'sse';
  expiresAt?: string;
  profileVersion?: number;
}

interface AuthProfileTracePayload extends Record<string, unknown> {
  authType: string;
  profileScope: 'project' | 'tenant';
  profileId: string;
  profileVersion?: number;
  principalKind: 'tenant' | 'user';
  refreshOutcome: 'resolved' | 'refreshed' | 'failed';
  latencyMs?: number;
  errorCode?: string;
}

interface PendingReconnectState {
  reason: 'AUTH_REFRESH_RECONNECT' | 'AUTH_REFRESH_FAILED';
  reconnectAfterMs: number;
}

interface PendingCloseEnvelopeAwareClient {
  setPendingCloseErrorEnvelope?(envelope: {
    code: 'AUTH_REFRESH_RECONNECT' | 'AUTH_REFRESH_FAILED';
    reconnectAfterMs?: number;
    message?: string;
  }): void;
}

interface RefreshLockRedisLike {
  set(key: string, value: string, ...args: (string | number)[]): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
  eval(script: string, numKeys: number, ...args: (string | number)[]): Promise<number>;
  on?(event: string, listener: (...args: unknown[]) => void): unknown;
}

type MCPAuthTlsOptions = NonNullable<MCPServerConfigOutput['tlsOptions']>;

/**
 * Implements McpClientProvider by delegating to MCPServerManager.
 * The MCPClient class already satisfies the McpClient interface
 * (it has callTool(name, args) -> Promise<unknown>).
 */
export class RuntimeMcpClientProvider implements McpClientProvider {
  private manager: InstanceType<typeof MCPServerManager>;
  private registry?: MCPServerRegistryService;
  private projectInitialized = new Map<string, number>();
  private projectLoadPromises = new Map<string, Promise<void>>();
  private serverAuthRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private serverAuthRefreshInFlight = new Map<string, Promise<void>>();
  private serverAuthMetadata = new Map<string, ServerAuthRefreshMetadata>();
  private serverRegistrationConfigs = new Map<string, MCPServerConfig & { name: string }>();
  private pendingReconnects = new Map<string, PendingReconnectState>();
  private refreshLockRedisClient: RefreshLockRedisLike | null | undefined;
  private refreshLockRedisHandle: RedisConnectionHandle | null | undefined;
  private projectResetGen = new Map<string, number>();
  private static PROJECT_INIT_TTL_MS = 5 * 60_000; // 5 minutes
  private static AUTH_REFRESH_LEAD_MS = 30_000;
  private static AUTH_REFRESH_JITTER_MAX_MS = 5_000;
  private static AUTH_REFRESH_RECONNECT_DELAY_MS = 1000;
  private static AUTH_REFRESH_LOCK_RETRY_MS = 2000;
  /** Optional proxy resolver — set by ToolBindingExecutor.setProxyResolver() */
  proxyResolver?: ProxyResolver;

  constructor(registry?: MCPServerRegistryService) {
    this.manager = getMCPServerManager();
    this.registry = registry;
  }

  /** Attach a registry after construction (e.g. DB became available after startup). */
  setRegistry(registry: MCPServerRegistryService): void {
    this.registry = registry;
    log.info('MCPServerRegistryService attached to provider');
  }

  hasRegistry(): boolean {
    return this.registry !== undefined;
  }

  /**
   * Ensure project-scoped MCP servers are loaded and connected from the DB.
   * Called from wireToolExecutor which has both tenantId and projectId.
   * Uses promise-based dedup to prevent concurrent loads for the same project.
   */
  async ensureProjectServers(tenantId: string, projectId: string): Promise<void> {
    if (!this.hasRegistry()) return;

    // TTL check — skip if recently initialized
    const initTime = this.projectInitialized.get(projectId);
    if (initTime && Date.now() - initTime < RuntimeMcpClientProvider.PROJECT_INIT_TTL_MS) return;

    // Dedup: if already loading this project, return the existing promise
    const existing = this.projectLoadPromises.get(projectId);
    if (existing) return existing;

    const gen = this.projectResetGen.get(projectId) ?? 0;
    const loadPromise = this._loadProjectServers(tenantId, projectId, gen);
    this.projectLoadPromises.set(projectId, loadPromise);

    try {
      await loadPromise;
    } finally {
      this.projectLoadPromises.delete(projectId);
    }
  }

  private isResetStale(projectId: string, capturedGen: number): boolean {
    return (this.projectResetGen.get(projectId) ?? 0) !== capturedGen;
  }

  /** Maximum MCP servers to connect per project (DoS protection) */
  private static readonly MAX_MCP_SERVERS_PER_PROJECT = 20;

  private async _loadProjectServers(
    tenantId: string,
    projectId: string,
    gen: number,
  ): Promise<void> {
    const start = Date.now();
    let configs = await this.registry!.getServerConfigs(tenantId, projectId);
    if (configs.length === 0) {
      if (!this.isResetStale(projectId, gen)) {
        this.projectInitialized.set(projectId, Date.now());
      }
      return;
    }
    if (configs.length > RuntimeMcpClientProvider.MAX_MCP_SERVERS_PER_PROJECT) {
      log.warn('MCP server count capped per project', {
        tenantId,
        projectId,
        requested: configs.length,
        cap: RuntimeMcpClientProvider.MAX_MCP_SERVERS_PER_PROJECT,
      });
      configs = configs.slice(0, RuntimeMcpClientProvider.MAX_MCP_SERVERS_PER_PROJECT);
    }

    for (const config of configs) {
      const fetchDispatcher = await this.resolveProxyDispatcher(config.url, config.tlsOptions);
      // Register by DB _id so executor can look up servers by serverId
      // (mcp_binding.server stores the DB _id, not the human-readable name)
      const registrationConfig = {
        ...config,
        name: config.id,
        ...(fetchDispatcher ? { fetchDispatcher } : {}),
      } as MCPServerConfig & { name: string };
      const serverKey = this.buildServerKey(projectId, config.id);
      this.serverRegistrationConfigs.set(serverKey, registrationConfig);
      this.manager.registerServer(registrationConfig, projectId);
      try {
        await this.manager.connectServer(config.id, projectId);
        this.trackServerAuthRefresh(serverKey, tenantId, projectId, config);
        log.info('Connected project MCP server', {
          tenantId,
          projectId,
          serverId: config.id,
          serverName: config.name,
        });
        log.info('MCP server access', {
          event: 'connect',
          tenantId,
          projectId,
          serverId: config.id,
          timestamp: new Date().toISOString(),
        });
      } catch (err) {
        log.warn('Failed to connect project MCP server', {
          tenantId,
          projectId,
          serverId: config.id,
          serverName: config.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.debug('Project MCP servers loaded', {
      projectId,
      count: configs.length,
      latencyMs: Date.now() - start,
    });
    if (!this.isResetStale(projectId, gen)) {
      this.projectInitialized.set(projectId, Date.now());
    }
  }

  /**
   * McpClientProvider.getClient — project-scoped resolution.
   * ensureProjectServers must be called beforehand by wireToolExecutor.
   * Servers are registered by their DB _id, so serverId is the lookup key.
   */
  async getClient(serverId: string, projectId?: string): Promise<McpClient | undefined> {
    if (projectId) {
      await this.reconnectIfPending(projectId, serverId);
    }

    const client = this.manager.getClient(serverId, projectId);
    log.debug('MCP getClient', { serverId, projectId, found: !!client });
    if (client) {
      log.info('MCP server access', {
        event: 'getClient',
        serverId,
        projectId,
        timestamp: new Date().toISOString(),
      });
    }
    return client as McpClient | undefined;
  }

  /**
   * Validate that all MCP tool bindings have connected servers with matching tools.
   * Returns an array of warning messages for any issues found.
   */
  async validateMcpBindings(
    tools: Array<{
      name: string;
      tool_type?: string;
      mcp_binding?: { server: string; tool: string };
    }>,
    projectId?: string,
  ): Promise<string[]> {
    const warnings: string[] = [];
    const mcpTools = tools.filter((t) => t.tool_type === 'mcp' && t.mcp_binding);

    for (const tool of mcpTools) {
      const binding = tool.mcp_binding!;
      // binding.server is the DB _id of the MCP server config
      const client = await this.getClient(binding.server, projectId);

      if (!client) {
        warnings.push(
          `MCP server '${binding.server}' not connected (required by tool '${tool.name}')`,
        );
        continue;
      }

      // Verify tool exists on the MCP server
      const hasTool = (
        client as { getTool?: (name: string) => { name: string } | undefined }
      ).getTool?.(binding.tool);
      if (!hasTool) {
        warnings.push(
          `MCP tool '${binding.tool}' not found on server '${binding.server}' (bound to tool '${tool.name}')`,
        );
      }
    }

    return warnings;
  }

  /**
   * Ensure only the MCP servers required by the agent's tools are connected.
   * More efficient than ensureProjectServers when only a subset of servers is needed.
   * Falls back to ensureProjectServers if registry is not available.
   */
  async ensureServersForTools(
    tenantId: string,
    projectId: string,
    requiredServers: Set<string>,
  ): Promise<void> {
    if (requiredServers.size === 0) return;
    if (!this.hasRegistry()) return;

    // Use the same dedup/TTL mechanism via ensureProjectServers for now.
    // The MCPServerManager already lazily connects, and registering all configs
    // is cheap — connection only happens when connectServer is called.
    // We load all configs but only connect the required ones.
    const initTime = this.projectInitialized.get(projectId);
    if (initTime && Date.now() - initTime < RuntimeMcpClientProvider.PROJECT_INIT_TTL_MS) return;

    const existing = this.projectLoadPromises.get(projectId);
    if (existing) return existing;

    const gen = this.projectResetGen.get(projectId) ?? 0;
    const loadPromise = this._loadServersForTools(tenantId, projectId, requiredServers, gen);
    this.projectLoadPromises.set(projectId, loadPromise);

    try {
      await loadPromise;
    } finally {
      this.projectLoadPromises.delete(projectId);
    }
  }

  private async _loadServersForTools(
    tenantId: string,
    projectId: string,
    requiredServers: Set<string>,
    gen: number,
  ): Promise<void> {
    const start = Date.now();
    let configs = await this.registry!.getServerConfigs(tenantId, projectId);
    // Filter to only required servers (requiredServers contains DB _ids from mcp_binding.server)
    configs = configs.filter((c) => requiredServers.has(c.id));
    if (configs.length === 0) {
      if (!this.isResetStale(projectId, gen)) {
        this.projectInitialized.set(projectId, Date.now());
      }
      return;
    }

    for (const config of configs) {
      const fetchDispatcher = await this.resolveProxyDispatcher(config.url, config.tlsOptions);
      // Register by DB _id
      const registrationConfig = {
        ...config,
        name: config.id,
        ...(fetchDispatcher ? { fetchDispatcher } : {}),
      } as MCPServerConfig & { name: string };
      const serverKey = this.buildServerKey(projectId, config.id);
      this.serverRegistrationConfigs.set(serverKey, registrationConfig);
      this.manager.registerServer(registrationConfig, projectId);
      try {
        await this.manager.connectServer(config.id, projectId);
        this.trackServerAuthRefresh(serverKey, tenantId, projectId, config);
        log.info('Connected required MCP server', {
          tenantId,
          projectId,
          serverId: config.id,
          serverName: config.name,
        });
      } catch (err) {
        log.warn('Failed to connect required MCP server', {
          tenantId,
          projectId,
          serverId: config.id,
          serverName: config.name,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.debug('Required MCP servers loaded', {
      projectId,
      required: requiredServers.size,
      connected: configs.length,
      latencyMs: Date.now() - start,
    });
    if (!this.isResetStale(projectId, gen)) {
      this.projectInitialized.set(projectId, Date.now());
    }
  }

  /**
   * Reset the project-init cache for (tenantId, projectId) so the next
   * ensureProjectServers / ensureServersForTools call re-reads from the registry.
   *
   * Called by Studio when an MCP server is created/updated/deleted via Arch chat,
   * so the new config is visible to existing pod sessions without waiting for the
   * 5-minute TTL to expire. Does NOT disconnect already-connected servers — use
   * disconnectProject for that.
   *
   * Note: `tenantId` is included for log context and signature symmetry with
   * other provider methods; the underlying caches are keyed by globally-unique
   * `projectId` alone. Both the TTL marker (`projectInitialized`) and any
   * in-flight load promise (`projectLoadPromises`) are cleared so the next
   * caller does not join a stale load that started before the cache-invalidating
   * mutation.
   */
  public resetProjectInit(tenantId: string, projectId: string): void {
    this.projectResetGen.set(projectId, (this.projectResetGen.get(projectId) ?? 0) + 1);
    this.projectInitialized.delete(projectId);
    this.projectLoadPromises.delete(projectId);
    log.info('mcp_provider_project_init_reset', { tenantId, projectId });
  }

  private buildServerKey(projectId: string, serverId: string): string {
    return `${projectId}:${serverId}`;
  }

  private buildTraceSessionId(projectId: string, serverId: string): string {
    return `mcp:${projectId}:${serverId}`;
  }

  private async emitMcpAuthTraceEvent(
    eventType: 'mcp.auth_resolved' | 'mcp.auth_refreshed',
    metadata: ServerAuthRefreshMetadata,
    payload: AuthProfileTracePayload,
  ): Promise<void> {
    try {
      const { getTraceStore } = await import('../trace-store.js');
      const sessionId = this.buildTraceSessionId(metadata.projectId, metadata.serverId);
      getTraceStore().addEvent(sessionId, {
        id: randomUUID(),
        sessionId,
        type: eventType,
        timestamp: new Date(),
        data: payload,
        tenantId: metadata.tenantId,
      });
    } catch (err) {
      log.warn('Failed to emit MCP auth trace event', {
        eventType,
        tenantId: metadata.tenantId,
        projectId: metadata.projectId,
        serverId: metadata.serverId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private clearServerAuthRefreshState(serverKey: string): void {
    const timer = this.serverAuthRefreshTimers.get(serverKey);
    if (timer) {
      clearTimeout(timer);
      this.serverAuthRefreshTimers.delete(serverKey);
    }
    this.serverAuthRefreshInFlight.delete(serverKey);
    this.serverAuthMetadata.delete(serverKey);
    this.serverRegistrationConfigs.delete(serverKey);
    this.pendingReconnects.delete(serverKey);
  }

  private clearProjectAuthRefreshState(projectId: string): void {
    const prefix = `${projectId}:`;
    for (const key of this.serverAuthRefreshTimers.keys()) {
      if (key.startsWith(prefix)) {
        this.clearServerAuthRefreshState(key);
      }
    }
    for (const key of this.serverAuthMetadata.keys()) {
      if (key.startsWith(prefix)) {
        this.clearServerAuthRefreshState(key);
      }
    }
    for (const key of this.serverRegistrationConfigs.keys()) {
      if (key.startsWith(prefix)) {
        this.clearServerAuthRefreshState(key);
      }
    }
  }

  private trackServerAuthRefresh(
    serverKey: string,
    tenantId: string,
    projectId: string,
    config: MCPServerConfigOutput,
  ): void {
    if (!isMcpAuthProfileEnabled()) {
      this.clearServerAuthRefreshState(serverKey);
      return;
    }

    const authProfileId =
      typeof config.authProfileId === 'string' && config.authProfileId.trim().length > 0
        ? config.authProfileId.trim()
        : null;
    const transport =
      config.transport === 'sse' ? 'sse' : config.transport === 'http' ? 'http' : null;

    if (!authProfileId || !transport) {
      this.clearServerAuthRefreshState(serverKey);
      return;
    }

    const metadata: ServerAuthRefreshMetadata = {
      projectId,
      serverId: config.id,
      tenantId,
      authProfileId,
      authType: typeof config.authType === 'string' ? config.authType : undefined,
      transport,
      expiresAt:
        typeof config.authProfileExpiresAt === 'string' ? config.authProfileExpiresAt : undefined,
      profileVersion:
        typeof config.authProfileVersion === 'number' ? config.authProfileVersion : undefined,
    };

    this.serverAuthMetadata.set(serverKey, metadata);

    log.info('MCP auth profile resolved', {
      event: 'mcp.auth_resolved',
      tenantId,
      projectId,
      serverId: config.id,
      authProfileId,
      transport,
      profileVersion: metadata.profileVersion,
    });
    void this.emitMcpAuthTraceEvent('mcp.auth_resolved', metadata, {
      authType: metadata.authType ?? 'none',
      profileScope: 'project',
      profileId: metadata.authProfileId,
      ...(typeof metadata.profileVersion === 'number'
        ? { profileVersion: metadata.profileVersion }
        : {}),
      principalKind: 'tenant',
      refreshOutcome: 'resolved',
    });

    if (metadata.expiresAt) {
      this.scheduleServerAuthRefresh(serverKey, metadata.expiresAt);
    }
  }

  private scheduleServerAuthRefresh(serverKey: string, expiresAtIso: string): void {
    const expiresAtMs = new Date(expiresAtIso).getTime();
    if (!Number.isFinite(expiresAtMs)) {
      return;
    }

    const existingTimer = this.serverAuthRefreshTimers.get(serverKey);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const jitterMs = Math.floor(
      Math.random() * RuntimeMcpClientProvider.AUTH_REFRESH_JITTER_MAX_MS,
    );
    const refreshLeadMs = RuntimeMcpClientProvider.AUTH_REFRESH_LEAD_MS + jitterMs;
    const delayMs = Math.max(0, expiresAtMs - Date.now() - refreshLeadMs);

    const timer = setTimeout(() => {
      void this.refreshServerAuth(serverKey);
    }, delayMs);

    this.serverAuthRefreshTimers.set(serverKey, timer);
  }

  private async refreshServerAuth(serverKey: string): Promise<void> {
    const existingRefresh = this.serverAuthRefreshInFlight.get(serverKey);
    if (existingRefresh) {
      await existingRefresh;
      return;
    }

    const refreshPromise = this.refreshServerAuthInternal(serverKey).finally(() => {
      this.serverAuthRefreshInFlight.delete(serverKey);
    });
    this.serverAuthRefreshInFlight.set(serverKey, refreshPromise);
    await refreshPromise;
  }

  private async refreshServerAuthInternal(serverKey: string): Promise<void> {
    const metadata = this.serverAuthMetadata.get(serverKey);
    if (!metadata) {
      return;
    }
    const refreshStartedAt = Date.now();

    try {
      const refreshExecuted = await this.withAuthRefreshLock(metadata, async () => {
        const { resolveAuthHeadersFromProfileDetailed } =
          await import('@agent-platform/shared/services/mcp-auth-resolver');
        const resolved = await resolveAuthHeadersFromProfileDetailed({
          authProfileId: metadata.authProfileId,
          tenantId: metadata.tenantId,
          projectId: metadata.projectId,
          transport: metadata.transport,
          minValidityMs:
            RuntimeMcpClientProvider.AUTH_REFRESH_LEAD_MS +
            RuntimeMcpClientProvider.AUTH_REFRESH_JITTER_MAX_MS,
        });

        await this.applyRefreshedHeaders(
          serverKey,
          metadata,
          resolved.headers,
          resolved.tlsOptions,
        );

        const updatedMetadata: ServerAuthRefreshMetadata = {
          ...metadata,
          expiresAt: resolved.expiresAt,
          profileVersion: resolved.profileVersion,
        };
        this.serverAuthMetadata.set(serverKey, updatedMetadata);

        if (resolved.expiresAt) {
          this.scheduleServerAuthRefresh(serverKey, resolved.expiresAt);
        }

        log.info('MCP auth profile refreshed', {
          event: 'mcp.auth_refreshed',
          tenantId: metadata.tenantId,
          projectId: metadata.projectId,
          serverId: metadata.serverId,
          authProfileId: metadata.authProfileId,
          transport: metadata.transport,
          profileVersion: resolved.profileVersion,
        });
        void this.emitMcpAuthTraceEvent('mcp.auth_refreshed', updatedMetadata, {
          authType: updatedMetadata.authType ?? resolved.authType ?? 'unknown',
          profileScope: 'project',
          profileId: updatedMetadata.authProfileId,
          ...(typeof updatedMetadata.profileVersion === 'number'
            ? { profileVersion: updatedMetadata.profileVersion }
            : {}),
          principalKind: 'tenant',
          refreshOutcome: 'refreshed',
          latencyMs: Date.now() - refreshStartedAt,
        });
      });

      if (!refreshExecuted) {
        const retryTimer = setTimeout(() => {
          void this.refreshServerAuth(serverKey);
        }, RuntimeMcpClientProvider.AUTH_REFRESH_LOCK_RETRY_MS);
        this.serverAuthRefreshTimers.set(serverKey, retryTimer);
      }
    } catch (err) {
      await this.handleAuthRefreshFailure(serverKey, metadata, err, Date.now() - refreshStartedAt);
    }
  }

  private async withAuthRefreshLock(
    metadata: ServerAuthRefreshMetadata,
    refreshTask: () => Promise<void>,
  ): Promise<boolean> {
    const redisClient = await this.getRefreshLockRedisClient();
    if (!redisClient) {
      await refreshTask();
      return true;
    }

    const { acquireRefreshLock } = await import('@agent-platform/shared/services/auth-profile');
    const lock = await acquireRefreshLock(metadata.authProfileId, metadata.tenantId, {
      redis: redisClient as unknown as RedisClient,
    });

    if (!lock.acquired) {
      log.debug('MCP auth refresh lock not acquired; another worker is refreshing', {
        tenantId: metadata.tenantId,
        projectId: metadata.projectId,
        serverId: metadata.serverId,
        authProfileId: metadata.authProfileId,
      });
      return false;
    }

    try {
      await refreshTask();
      return true;
    } finally {
      await lock.release();
    }
  }

  private async getRefreshLockRedisClient(): Promise<RefreshLockRedisLike | null> {
    if (this.refreshLockRedisClient !== undefined) {
      return this.refreshLockRedisClient;
    }

    const redisOpts = resolveRedisOptionsFromEnv();
    if (!redisOpts?.url && !redisOpts?.host && !redisOpts?.port) {
      this.refreshLockRedisClient = null;
      this.refreshLockRedisHandle = null;
      return null;
    }

    try {
      const handle = createRedisConnection({
        ...redisOpts,
        maxRetriesPerRequest: 1,
        enableReadyCheck: false,
        lazyConnect: true,
      });
      const client = handle.client as unknown as RefreshLockRedisLike;
      client.on?.('error', (err: unknown) =>
        log.warn('MCP auth refresh lock Redis client error', {
          error: err instanceof Error ? err.message : String(err),
        }),
      );
      this.refreshLockRedisClient = client;
      this.refreshLockRedisHandle = handle;
    } catch (err) {
      log.warn('Failed to initialize Redis client for MCP auth refresh locks', {
        error: err instanceof Error ? err.message : String(err),
      });
      this.refreshLockRedisClient = null;
      this.refreshLockRedisHandle = null;
    }

    return this.refreshLockRedisClient;
  }

  private async applyRefreshedHeaders(
    serverKey: string,
    metadata: ServerAuthRefreshMetadata,
    headers: Record<string, string>,
    tlsOptions?: MCPAuthTlsOptions,
  ): Promise<void> {
    const registrationConfig = this.serverRegistrationConfigs.get(serverKey);
    let fetchDispatcher: unknown = registrationConfig?.fetchDispatcher;
    if (registrationConfig?.url) {
      const resolvedFetchDispatcher = await this.resolveProxyDispatcher(
        registrationConfig.url,
        tlsOptions,
      );
      if (resolvedFetchDispatcher !== undefined) {
        fetchDispatcher = resolvedFetchDispatcher;
      }
    }

    if (registrationConfig) {
      const updatedConfig = {
        ...registrationConfig,
        headers,
        ...(tlsOptions ? { tlsOptions } : {}),
        ...(fetchDispatcher ? { fetchDispatcher } : {}),
      };
      this.serverRegistrationConfigs.set(serverKey, updatedConfig);
      this.manager.registerServer(updatedConfig, metadata.projectId);
    }

    if (metadata.transport === 'http') {
      this.hotSwapHttpHeaders(
        metadata.projectId,
        metadata.serverId,
        headers,
        tlsOptions,
        fetchDispatcher,
      );
      return;
    }

    const activeClient = this.manager.getClient(metadata.serverId, metadata.projectId) as
      | PendingCloseEnvelopeAwareClient
      | undefined;
    activeClient?.setPendingCloseErrorEnvelope?.({
      code: 'AUTH_REFRESH_RECONNECT',
      reconnectAfterMs: RuntimeMcpClientProvider.AUTH_REFRESH_RECONNECT_DELAY_MS,
      message: 'MCP auth refresh in progress; reconnect and retry this tool call.',
    });

    await this.manager.disconnectServer(metadata.serverId, metadata.projectId).catch((err) =>
      log.warn('Failed to close SSE MCP transport during auth refresh', {
        projectId: metadata.projectId,
        serverId: metadata.serverId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );

    this.pendingReconnects.set(serverKey, {
      reason: 'AUTH_REFRESH_RECONNECT',
      reconnectAfterMs: RuntimeMcpClientProvider.AUTH_REFRESH_RECONNECT_DELAY_MS,
    });
  }

  private hotSwapHttpHeaders(
    projectId: string,
    serverId: string,
    headers: Record<string, string>,
    tlsOptions?: MCPAuthTlsOptions,
    fetchDispatcher?: unknown,
  ): void {
    const client = this.manager.getClient(serverId, projectId) as
      | {
          config?: {
            headers?: Record<string, string>;
            tlsOptions?: MCPAuthTlsOptions;
            fetchDispatcher?: unknown;
          };
          transport?: { customHeaders?: Record<string, string>; fetchDispatcher?: unknown };
        }
      | undefined;
    if (!client) {
      return;
    }

    if (client.config && typeof client.config === 'object') {
      client.config.headers = headers;
      if (tlsOptions) {
        client.config.tlsOptions = tlsOptions;
      }
      if (fetchDispatcher) {
        client.config.fetchDispatcher = fetchDispatcher;
      }
    }

    if (client.transport && typeof client.transport === 'object') {
      client.transport.customHeaders = headers;
      if (fetchDispatcher) {
        client.transport.fetchDispatcher = fetchDispatcher;
      }
    }
  }

  private async handleAuthRefreshFailure(
    serverKey: string,
    metadata: ServerAuthRefreshMetadata,
    err: unknown,
    latencyMs?: number,
  ): Promise<void> {
    log.warn('MCP auth refresh failed; scheduling reconnect on next tool call', {
      tenantId: metadata.tenantId,
      projectId: metadata.projectId,
      serverId: metadata.serverId,
      authProfileId: metadata.authProfileId,
      error: err instanceof Error ? err.message : String(err),
      code: 'AUTH_REFRESH_FAILED',
    });

    await this.manager
      .disconnectServer(metadata.serverId, metadata.projectId)
      .catch((disconnectErr) =>
        log.warn('MCP auth refresh failure disconnect failed', {
          projectId: metadata.projectId,
          serverId: metadata.serverId,
          error: disconnectErr instanceof Error ? disconnectErr.message : String(disconnectErr),
        }),
      );

    void this.emitMcpAuthTraceEvent('mcp.auth_refreshed', metadata, {
      authType: metadata.authType ?? 'none',
      profileScope: 'project',
      profileId: metadata.authProfileId,
      ...(typeof metadata.profileVersion === 'number'
        ? { profileVersion: metadata.profileVersion }
        : {}),
      principalKind: 'tenant',
      refreshOutcome: 'failed',
      ...(typeof latencyMs === 'number' ? { latencyMs } : {}),
      errorCode: 'AUTH_REFRESH_FAILED',
    });

    this.pendingReconnects.set(serverKey, {
      reason: 'AUTH_REFRESH_FAILED',
      reconnectAfterMs: RuntimeMcpClientProvider.AUTH_REFRESH_RECONNECT_DELAY_MS,
    });
  }

  private async reconnectIfPending(projectId: string, serverId: string): Promise<void> {
    const serverKey = this.buildServerKey(projectId, serverId);
    const pending = this.pendingReconnects.get(serverKey);
    if (!pending) {
      return;
    }

    this.pendingReconnects.delete(serverKey);
    try {
      await this.manager.connectServer(serverId, projectId);
    } catch (err) {
      const reason = pending.reason;
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`${reason}: ${message}`);
    }
  }

  /**
   * Disconnect all MCP servers for a project and remove from tracking maps.
   * Call when a project is deleted, disabled, or when session cleanup evicts it.
   */
  async disconnectProject(projectId: string): Promise<void> {
    this.projectResetGen.set(projectId, (this.projectResetGen.get(projectId) ?? 0) + 1);
    this.projectInitialized.delete(projectId);
    this.projectLoadPromises.delete(projectId);
    this.clearProjectAuthRefreshState(projectId);
    try {
      // Disconnect all servers registered under this projectId scope
      // s.name is now the DB _id since we register by ID
      const servers = this.manager.listServers(projectId);
      await Promise.all(
        servers.map((s) =>
          this.manager.disconnectServer(s.name, projectId).catch((err) =>
            log.warn('MCP server disconnect failed', {
              serverId: s.name,
              projectId,
              error: err instanceof Error ? err.message : String(err),
            }),
          ),
        ),
      );
      log.info('Disconnected project MCP servers', { projectId, count: servers.length });
    } catch (err) {
      log.warn('Error disconnecting project MCP servers', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /**
   * Gracefully disconnect all servers.
   */
  async shutdown(): Promise<void> {
    this.projectInitialized.clear();
    this.projectLoadPromises.clear();
    for (const timer of this.serverAuthRefreshTimers.values()) {
      clearTimeout(timer);
    }
    this.serverAuthRefreshTimers.clear();
    this.serverAuthRefreshInFlight.clear();
    this.serverAuthMetadata.clear();
    this.serverRegistrationConfigs.clear();
    this.pendingReconnects.clear();
    await this.refreshLockRedisHandle?.disconnect();
    this.refreshLockRedisHandle = undefined;
    this.refreshLockRedisClient = undefined;
    await this.manager.disconnectAll();
  }

  /**
   * Resolve a proxy dispatcher for MCP HTTP/SSE connections.
   * Uses the same undici ProxyAgent pattern as InlineMcpClientProvider.
   * Returns undefined if no proxy is configured or resolution fails.
   */
  private async resolveProxyDispatcher(
    url?: string,
    tlsOptions?: MCPAuthTlsOptions,
  ): Promise<unknown> {
    if (!url || !this.proxyResolver) {
      return undefined;
    }

    const proxyConfig = this.proxyResolver.resolve(url);
    if (!proxyConfig) return undefined;

    try {
      const mod = 'undici';
      const undici = await import(/* @vite-ignore */ mod);
      const ProxyAgentCtor = (undici as Record<string, unknown>).ProxyAgent as
        | (new (opts: Record<string, unknown>) => unknown)
        | undefined;
      if (!ProxyAgentCtor) return undefined;

      const proxyOpts: Record<string, unknown> = { uri: proxyConfig.proxyUrl };
      if (proxyConfig.caCertificate || proxyConfig.clientCert || tlsOptions) {
        const requestTls: Record<string, unknown> = {};
        if (proxyConfig.caCertificate) requestTls.ca = proxyConfig.caCertificate;
        if (proxyConfig.clientCert) requestTls.cert = proxyConfig.clientCert;
        if (proxyConfig.clientKey) requestTls.key = proxyConfig.clientKey;
        if (tlsOptions?.ca) requestTls.ca = tlsOptions.ca;
        if (tlsOptions?.cert) requestTls.cert = tlsOptions.cert;
        if (tlsOptions?.key) requestTls.key = tlsOptions.key;
        proxyOpts.requestTls = requestTls;
      }

      log.debug('MCP proxy dispatcher created for RuntimeMcpClientProvider', {
        proxyUrl: proxyConfig.proxyUrl,
      });
      return new ProxyAgentCtor(proxyOpts);
    } catch (err) {
      log.warn('Failed to create MCP proxy dispatcher — connections will be direct', {
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }
}

// Singleton instance
let instance: RuntimeMcpClientProvider | undefined;

export function getRuntimeMcpProvider(
  registry?: MCPServerRegistryService,
): RuntimeMcpClientProvider {
  if (!instance) {
    instance = new RuntimeMcpClientProvider(registry);
  } else if (registry && !instance.hasRegistry()) {
    instance.setRegistry(registry);
  }
  return instance;
}
