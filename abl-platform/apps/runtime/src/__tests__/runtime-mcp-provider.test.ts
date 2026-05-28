/**
 * Tests for RuntimeMcpClientProvider
 *
 * Coverage:
 * - Constructor & registry attachment
 * - ensureProjectServers (TTL, dedup, cap, error handling)
 * - getClient delegation
 * - validateMcpBindings warnings
 * - ensureServersForTools selective loading
 * - disconnectProject cleanup
 * - resetProjectInit (cache invalidation, in-flight promise clearing)
 * - shutdown
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';

// ─── Mock Setup ──────────────────────────────────────────────────────────

const mockManager = {
  registerServer: vi.fn(),
  connectServer: vi.fn(),
  getClient: vi.fn(),
  listServers: vi.fn().mockReturnValue([]),
  disconnectServer: vi.fn(),
  disconnectAll: vi.fn(),
};

const { mockResolveAuthHeadersFromProfileDetailed, mockTraceStoreAddEvent } = vi.hoisted(() => ({
  mockResolveAuthHeadersFromProfileDetailed: vi.fn(),
  mockTraceStoreAddEvent: vi.fn(),
}));

vi.mock('@abl/compiler', () => ({
  platform: {
    getMCPServerManager: () => mockManager,
    MCPServerManager: class {},
  },
}));

vi.mock('@abl/compiler/platform/mcp/server-manager.js', () => ({
  getMCPServerManager: () => mockManager,
  MCPServerManager: class {},
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@agent-platform/shared/services/mcp-auth-resolver', () => ({
  resolveAuthHeadersFromProfileDetailed: (...args: unknown[]) =>
    mockResolveAuthHeadersFromProfileDetailed(...args),
}));

vi.mock('../services/trace-store.js', () => ({
  getTraceStore: () => ({
    addEvent: (...args: unknown[]) => mockTraceStoreAddEvent(...args),
  }),
}));

// Mock the server module to prevent circular import in trackForHealthMonitoring
vi.mock('../../server.js', () => ({
  getMcpHealthMonitor: vi.fn().mockReturnValue(undefined),
}));

import { RuntimeMcpClientProvider } from '../services/mcp/runtime-mcp-provider.js';

// ─── Helpers ─────────────────────────────────────────────────────────────

function createMockRegistry(configs: any[] = []) {
  return {
    getServerConfigs: vi.fn().mockResolvedValue(configs),
  };
}

const mockConfigs = [
  {
    id: 'server-1',
    name: 'Slack',
    transport: 'stdio',
    command: '/usr/bin/node',
    priority: 1,
  },
  {
    id: 'server-2',
    name: 'GitHub',
    transport: 'sse',
    url: 'http://localhost:3001/sse',
    priority: 2,
  },
];

function getAuthTraceEvent(
  type: 'mcp.auth_resolved' | 'mcp.auth_refreshed',
): Record<string, unknown> | undefined {
  const call = mockTraceStoreAddEvent.mock.calls.find(
    (_entry: unknown[]) =>
      typeof _entry[1] === 'object' &&
      _entry[1] !== null &&
      (_entry[1] as { type?: unknown }).type === type,
  );
  return call?.[1] as Record<string, unknown> | undefined;
}

function assertAuthTracePayloadShape(payload: unknown): void {
  expect(payload).toBeTruthy();
  const data = (payload as { data: Record<string, unknown> }).data;
  expect(data).toBeDefined();
  expect(data).toEqual(
    expect.objectContaining({
      authType: expect.any(String),
      profileScope: 'project',
      profileId: expect.any(String),
      principalKind: 'tenant',
      refreshOutcome: expect.any(String),
    }),
  );
  expect(data).not.toHaveProperty('tenantId');
  expect(data).not.toHaveProperty('projectId');
  expect(data).not.toHaveProperty('serverId');
  expect(data).not.toHaveProperty('authProfileId');
  expect(data).not.toHaveProperty('transport');
  expect(data).not.toHaveProperty('expiresAt');
}

// ─── Tests ───────────────────────────────────────────────────────────────

describe('RuntimeMcpClientProvider', () => {
  let provider: RuntimeMcpClientProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    mockResolveAuthHeadersFromProfileDetailed.mockReset();
    mockTraceStoreAddEvent.mockReset();
    process.env.REDIS_URL = '';
  });

  // ── Constructor & Registry ──────────────────────────────────────────

  describe('constructor & registry', () => {
    test('creates provider without registry', () => {
      provider = new RuntimeMcpClientProvider();
      expect(provider.hasRegistry()).toBe(false);
    });

    test('creates provider with registry', () => {
      const registry = createMockRegistry();
      provider = new RuntimeMcpClientProvider(registry as any);
      expect(provider.hasRegistry()).toBe(true);
    });

    test('setRegistry attaches registry after construction', () => {
      provider = new RuntimeMcpClientProvider();
      expect(provider.hasRegistry()).toBe(false);

      const registry = createMockRegistry();
      provider.setRegistry(registry as any);
      expect(provider.hasRegistry()).toBe(true);
    });

    test('hasRegistry returns false when no registry, true when set', () => {
      provider = new RuntimeMcpClientProvider();
      expect(provider.hasRegistry()).toBe(false);

      provider.setRegistry(createMockRegistry() as any);
      expect(provider.hasRegistry()).toBe(true);
    });
  });

  // ── ensureProjectServers ────────────────────────────────────────────

  describe('ensureProjectServers', () => {
    test('does nothing when no registry', async () => {
      provider = new RuntimeMcpClientProvider();
      await provider.ensureProjectServers('tenant-1', 'project-1');
      expect(mockManager.registerServer).not.toHaveBeenCalled();
      expect(mockManager.connectServer).not.toHaveBeenCalled();
    });

    test('loads and connects servers from registry configs', async () => {
      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      await provider.ensureProjectServers('tenant-1', 'project-1');

      expect(registry.getServerConfigs).toHaveBeenCalledWith('tenant-1', 'project-1');
      expect(mockManager.registerServer).toHaveBeenCalledTimes(2);
      expect(mockManager.connectServer).toHaveBeenCalledTimes(2);
      expect(mockManager.connectServer).toHaveBeenCalledWith('server-1', 'project-1');
      expect(mockManager.connectServer).toHaveBeenCalledWith('server-2', 'project-1');
    });

    test('registers servers by DB _id (config.name = config.id)', async () => {
      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      await provider.ensureProjectServers('tenant-1', 'project-1');

      // First call should register with name overridden to id
      const firstCall = mockManager.registerServer.mock.calls[0];
      expect(firstCall[0].name).toBe('server-1');
      expect(firstCall[0].id).toBe('server-1');
      expect(firstCall[1]).toBe('project-1');

      const secondCall = mockManager.registerServer.mock.calls[1];
      expect(secondCall[0].name).toBe('server-2');
      expect(secondCall[0].id).toBe('server-2');
      expect(secondCall[1]).toBe('project-1');
    });

    test('skips if recently initialized (within 5-min TTL)', async () => {
      vi.useFakeTimers();
      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      await provider.ensureProjectServers('tenant-1', 'project-1');
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(1);

      vi.clearAllMocks();

      // Advance 2 minutes — still within TTL
      vi.advanceTimersByTime(2 * 60_000);
      await provider.ensureProjectServers('tenant-1', 'project-1');
      expect(registry.getServerConfigs).not.toHaveBeenCalled();

      // Advance past TTL (total 6 minutes)
      vi.advanceTimersByTime(4 * 60_000);
      await provider.ensureProjectServers('tenant-1', 'project-1');
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(1);
    });

    test('caps servers at 20 per project', async () => {
      const manyConfigs = Array.from({ length: 25 }, (_, i) => ({
        id: `server-${i}`,
        name: `Server ${i}`,
        transport: 'stdio',
        command: '/usr/bin/node',
        priority: i,
      }));
      const registry = createMockRegistry(manyConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      await provider.ensureProjectServers('tenant-1', 'project-1');

      expect(mockManager.registerServer).toHaveBeenCalledTimes(20);
      expect(mockManager.connectServer).toHaveBeenCalledTimes(20);
    });

    test('handles connection failure gracefully (warns, continues to next server)', async () => {
      mockManager.connectServer
        .mockRejectedValueOnce(new Error('Connection refused'))
        .mockResolvedValueOnce(undefined);

      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      // Should not throw
      await provider.ensureProjectServers('tenant-1', 'project-1');

      // Both servers should have been attempted
      expect(mockManager.registerServer).toHaveBeenCalledTimes(2);
      expect(mockManager.connectServer).toHaveBeenCalledTimes(2);
    });

    test('promise dedup: concurrent calls for same project share one promise', async () => {
      let resolveLoad!: () => void;
      const registry = createMockRegistry([]);
      registry.getServerConfigs.mockReturnValue(
        new Promise<any[]>((resolve) => {
          resolveLoad = () => resolve(mockConfigs);
        }),
      );
      provider = new RuntimeMcpClientProvider(registry as any);

      const p1 = provider.ensureProjectServers('tenant-1', 'project-1');
      const p2 = provider.ensureProjectServers('tenant-1', 'project-1');

      resolveLoad();
      await Promise.all([p1, p2]);

      // Only one call to getServerConfigs despite two concurrent ensureProjectServers calls
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(1);
    });
  });

  // ── getClient ───────────────────────────────────────────────────────

  describe('getClient', () => {
    test('delegates to manager.getClient with serverId and projectId', async () => {
      const fakeClient = { callTool: vi.fn() };
      mockManager.getClient.mockReturnValue(fakeClient);

      provider = new RuntimeMcpClientProvider();
      const client = await provider.getClient('server-1', 'project-1');

      expect(mockManager.getClient).toHaveBeenCalledWith('server-1', 'project-1');
      expect(client).toBe(fakeClient);
    });

    test('returns undefined when no client found', async () => {
      mockManager.getClient.mockReturnValue(undefined);

      provider = new RuntimeMcpClientProvider();
      const client = await provider.getClient('nonexistent', 'project-1');

      expect(client).toBeUndefined();
    });
  });

  // ── validateMcpBindings ─────────────────────────────────────────────

  describe('validateMcpBindings', () => {
    test('returns empty warnings for non-MCP tools', async () => {
      provider = new RuntimeMcpClientProvider();
      const tools = [
        { name: 'http-tool', tool_type: 'http' },
        { name: 'sandbox-tool', tool_type: 'sandbox' },
      ];

      const warnings = await provider.validateMcpBindings(tools, 'project-1');
      expect(warnings).toEqual([]);
    });

    test('warns when MCP server not connected', async () => {
      mockManager.getClient.mockReturnValue(undefined);

      provider = new RuntimeMcpClientProvider();
      const tools = [
        {
          name: 'slack-post',
          tool_type: 'mcp',
          mcp_binding: { server: 'server-1', tool: 'post_message' },
        },
      ];

      const warnings = await provider.validateMcpBindings(tools, 'project-1');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("MCP server 'server-1' not connected");
      expect(warnings[0]).toContain("tool 'slack-post'");
    });

    test('warns when MCP tool not found on connected server', async () => {
      const fakeClient = { callTool: vi.fn(), getTool: vi.fn().mockReturnValue(undefined) };
      mockManager.getClient.mockReturnValue(fakeClient);

      provider = new RuntimeMcpClientProvider();
      const tools = [
        {
          name: 'slack-post',
          tool_type: 'mcp',
          mcp_binding: { server: 'server-1', tool: 'post_message' },
        },
      ];

      const warnings = await provider.validateMcpBindings(tools, 'project-1');
      expect(warnings).toHaveLength(1);
      expect(warnings[0]).toContain("MCP tool 'post_message' not found");
      expect(warnings[0]).toContain("server 'server-1'");
    });
  });

  // ── ensureServersForTools ───────────────────────────────────────────

  describe('ensureServersForTools', () => {
    test('only connects required servers (filters by ID)', async () => {
      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      const required = new Set(['server-1']);
      await provider.ensureServersForTools('tenant-1', 'project-1', required);

      expect(registry.getServerConfigs).toHaveBeenCalledWith('tenant-1', 'project-1');
      // Only server-1 should be registered and connected
      expect(mockManager.registerServer).toHaveBeenCalledTimes(1);
      expect(mockManager.connectServer).toHaveBeenCalledTimes(1);
      expect(mockManager.connectServer).toHaveBeenCalledWith('server-1', 'project-1');
    });

    test('does nothing when requiredServers is empty', async () => {
      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      await provider.ensureServersForTools('tenant-1', 'project-1', new Set());

      expect(registry.getServerConfigs).not.toHaveBeenCalled();
      expect(mockManager.registerServer).not.toHaveBeenCalled();
    });
  });

  // ── disconnectProject ──────────────────────────────────────────────

  describe('disconnectProject', () => {
    test('disconnects all servers for a project and clears tracking maps', async () => {
      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      // Initialize the project first
      await provider.ensureProjectServers('tenant-1', 'project-1');

      mockManager.listServers.mockReturnValue([{ name: 'server-1' }, { name: 'server-2' }]);
      mockManager.disconnectServer.mockResolvedValue(undefined);

      await provider.disconnectProject('project-1');

      expect(mockManager.listServers).toHaveBeenCalledWith('project-1');
      expect(mockManager.disconnectServer).toHaveBeenCalledWith('server-1', 'project-1');
      expect(mockManager.disconnectServer).toHaveBeenCalledWith('server-2', 'project-1');

      // After disconnect, the TTL should be cleared so next ensureProjectServers reloads
      vi.clearAllMocks();
      registry.getServerConfigs.mockResolvedValue(mockConfigs);
      await provider.ensureProjectServers('tenant-1', 'project-1');
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(1);
    });
  });

  // ── resetProjectInit ────────────────────────────────────────────────

  describe('resetProjectInit', () => {
    test('forces re-initialization on next ensureProjectServers call', async () => {
      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      // First call hits the registry
      await provider.ensureProjectServers('tenant-1', 'project-1');
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(1);

      // Second call (without reset) is cached — does NOT hit the registry
      await provider.ensureProjectServers('tenant-1', 'project-1');
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(1);

      // After reset, next call re-reads from the registry
      provider.resetProjectInit('tenant-1', 'project-1');
      await provider.ensureProjectServers('tenant-1', 'project-1');
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(2);
    });

    test("only resets the specified projectId, leaves other projects' caches intact", async () => {
      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      // Initialize two distinct projects
      await provider.ensureProjectServers('tenant-1', 'project-A');
      await provider.ensureProjectServers('tenant-1', 'project-B');
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(2);

      // Reset only project-A
      provider.resetProjectInit('tenant-1', 'project-A');

      // project-A reloads
      await provider.ensureProjectServers('tenant-1', 'project-A');
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(3);
      expect(registry.getServerConfigs).toHaveBeenLastCalledWith('tenant-1', 'project-A');

      // project-B remains cached — no extra call
      await provider.ensureProjectServers('tenant-1', 'project-B');
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(3);
    });

    test('is a no-op for an unknown project', async () => {
      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      // No prior initialization — should not throw
      expect(() => provider.resetProjectInit('tenant-1', 'never-seen')).not.toThrow();

      // Subsequent ensureProjectServers behaves normally
      await provider.ensureProjectServers('tenant-1', 'never-seen');
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(1);
    });

    test('clears in-flight load promise so next ensure starts a fresh load', async () => {
      // This test must distinguish buggy from fixed behavior of resetProjectInit.
      // The bug: if resetProjectInit does NOT clear projectLoadPromises, a caller
      // that calls ensureProjectServers WHILE the prior load is still in flight
      // will join the stale promise instead of starting a fresh load.
      //
      // To exercise this, the SECOND ensureProjectServers call must happen
      // BEFORE the first load resolves — otherwise the `finally` block in
      // ensureProjectServers will have already removed the in-flight promise
      // and the test would pass regardless of resetProjectInit's behavior.
      let resolveFirstLoad!: (configs: any[]) => void;
      const registry = createMockRegistry([]);
      registry.getServerConfigs.mockImplementationOnce(
        () =>
          new Promise<any[]>((resolve) => {
            resolveFirstLoad = resolve;
          }),
      );
      provider = new RuntimeMcpClientProvider(registry as any);

      // 1. Start the first load. Do NOT await — keep the promise pending so
      //    projectLoadPromises retains the entry for project-1.
      const inFlight = provider.ensureProjectServers('tenant-1', 'project-1');

      // 2. While the first load is still pending, reset the cache.
      //    With the fix:    projectLoadPromises is cleared.
      //    Without the fix: projectLoadPromises still holds the stale promise.
      provider.resetProjectInit('tenant-1', 'project-1');

      // 3. Set up the registry to return a fresh response on the NEXT call.
      registry.getServerConfigs.mockResolvedValueOnce(mockConfigs);

      // 4. Issue the SECOND ensureProjectServers BEFORE the first load resolves.
      //    With the fix:    no entry in projectLoadPromises → fresh load (call #2).
      //    Without the fix: stale entry in projectLoadPromises → joins it (no new call).
      const second = provider.ensureProjectServers('tenant-1', 'project-1');

      // 5. Now release the first load so both promises can settle.
      resolveFirstLoad([]);
      await Promise.all([inFlight, second]);

      // With the fix in place, both calls hit the registry independently.
      // Without the fix, the second call would have joined the first and the
      // count would be 1.
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(2);
    });
  });

  // ── shutdown ────────────────────────────────────────────────────────

  describe('shutdown', () => {
    test('clears all state and disconnects all servers', async () => {
      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);

      // Initialize a project
      await provider.ensureProjectServers('tenant-1', 'project-1');

      await provider.shutdown();

      expect(mockManager.disconnectAll).toHaveBeenCalledTimes(1);

      // After shutdown, ensureProjectServers should reload (TTL cleared)
      vi.clearAllMocks();
      registry.getServerConfigs.mockResolvedValue(mockConfigs);
      await provider.ensureProjectServers('tenant-1', 'project-1');
      expect(registry.getServerConfigs).toHaveBeenCalledTimes(1);
    });
  });

  // ── Auth headers pass through to registration ───────────────────

  describe('auth headers', () => {
    test('passes auth headers from registry config to registerServer', async () => {
      const configsWithAuth = [
        {
          id: 'server-auth',
          name: 'AuthServer',
          transport: 'sse',
          url: 'http://localhost:3001/sse',
          priority: 1,
          authType: 'bearer',
          headers: { Authorization: 'Bearer my-token' },
        },
      ];
      const registry = createMockRegistry(configsWithAuth);
      provider = new RuntimeMcpClientProvider(registry as any);

      await provider.ensureProjectServers('tenant-1', 'project-1');

      expect(mockManager.registerServer).toHaveBeenCalledTimes(1);
      const registeredConfig = mockManager.registerServer.mock.calls[0][0];
      expect(registeredConfig.headers).toEqual({ Authorization: 'Bearer my-token' });
    });

    test('passes mTLS tlsOptions from registry config to registerServer', async () => {
      const configsWithAuth = [
        {
          id: 'server-auth-mtls',
          name: 'AuthServerMtls',
          transport: 'http',
          url: 'https://mcp.example.com/http',
          authType: 'mtls',
          headers: {},
          tlsOptions: {
            cert: 'cert-pem',
            key: 'key-pem',
            ca: 'ca-pem',
          },
        },
      ];
      const registry = createMockRegistry(configsWithAuth);
      provider = new RuntimeMcpClientProvider(registry as any);

      await provider.ensureProjectServers('tenant-1', 'project-1');

      expect(mockManager.registerServer).toHaveBeenCalledTimes(1);
      const registeredConfig = mockManager.registerServer.mock.calls[0][0];
      expect(registeredConfig.tlsOptions).toEqual({
        cert: 'cert-pem',
        key: 'key-pem',
        ca: 'ca-pem',
      });
    });
  });

  describe('auth refresh', () => {
    test('pre-expiry refresh hot-swaps headers for HTTP transport', async () => {
      vi.useFakeTimers();
      const configsWithAuth = [
        {
          id: 'server-http',
          name: 'AuthServer',
          transport: 'http',
          url: 'https://mcp.example.com/http',
          authProfileId: 'ap-http-1',
          authProfileVersion: 1,
          authProfileExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          headers: { Authorization: 'Bearer old-token' },
        },
      ];
      const registry = createMockRegistry(configsWithAuth);
      provider = new RuntimeMcpClientProvider(registry as any);

      const fakeClient = {
        callTool: vi.fn(),
        config: {
          headers: { Authorization: 'Bearer old-token' },
          tlsOptions: { cert: 'old-cert', key: 'old-key' },
        },
        transport: { customHeaders: { Authorization: 'Bearer old-token' } },
      };
      mockManager.getClient.mockReturnValue(fakeClient);
      mockResolveAuthHeadersFromProfileDetailed.mockResolvedValue({
        headers: { Authorization: 'Bearer new-token' },
        tlsOptions: { cert: 'new-cert', key: 'new-key', ca: 'new-ca' },
        authType: 'oauth2_token',
        profileVersion: 2,
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
      });

      await provider.ensureProjectServers('tenant-1', 'project-1');
      await vi.advanceTimersByTimeAsync(35_000);

      expect(mockTraceStoreAddEvent).toHaveBeenCalledWith(
        'mcp:project-1:server-http',
        expect.objectContaining({ type: 'mcp.auth_resolved' }),
      );
      expect(mockTraceStoreAddEvent).toHaveBeenCalledWith(
        'mcp:project-1:server-http',
        expect.objectContaining({ type: 'mcp.auth_refreshed' }),
      );
      const resolvedEvent = getAuthTraceEvent('mcp.auth_resolved');
      const refreshedEvent = getAuthTraceEvent('mcp.auth_refreshed');
      assertAuthTracePayloadShape(resolvedEvent);
      assertAuthTracePayloadShape(refreshedEvent);
      expect((resolvedEvent as { data: Record<string, unknown> }).data.refreshOutcome).toBe(
        'resolved',
      );
      expect((refreshedEvent as { data: Record<string, unknown> }).data.refreshOutcome).toBe(
        'refreshed',
      );
      expect((refreshedEvent as { data: Record<string, unknown> }).data).toHaveProperty(
        'latencyMs',
      );
      expect(mockResolveAuthHeadersFromProfileDetailed).toHaveBeenCalledWith(
        expect.objectContaining({
          authProfileId: 'ap-http-1',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          transport: 'http',
          minValidityMs: 35_000,
        }),
      );
      expect(fakeClient.config.headers).toEqual({ Authorization: 'Bearer new-token' });
      expect(fakeClient.config.tlsOptions).toEqual({
        cert: 'new-cert',
        key: 'new-key',
        ca: 'new-ca',
      });
      expect(fakeClient.transport.customHeaders).toEqual({ Authorization: 'Bearer new-token' });
    });

    test('SSE refresh closes connection and next getClient reconnects', async () => {
      vi.useFakeTimers();
      const configsWithAuth = [
        {
          id: 'server-sse',
          name: 'AuthServer',
          transport: 'sse',
          url: 'https://mcp.example.com/sse',
          authProfileId: 'ap-sse-1',
          authProfileVersion: 1,
          authProfileExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          headers: { Authorization: 'Bearer old-token' },
        },
      ];
      const registry = createMockRegistry(configsWithAuth);
      provider = new RuntimeMcpClientProvider(registry as any);

      const setPendingCloseErrorEnvelope = vi.fn();
      const fakeClient = { callTool: vi.fn() };
      Object.assign(fakeClient, { setPendingCloseErrorEnvelope });
      mockManager.getClient.mockReturnValue(fakeClient);
      mockResolveAuthHeadersFromProfileDetailed.mockResolvedValue({
        headers: { Authorization: 'Bearer refreshed-token' },
        authType: 'oauth2_token',
        profileVersion: 2,
        expiresAt: new Date(Date.now() + 180_000).toISOString(),
      });

      await provider.ensureProjectServers('tenant-1', 'project-1');
      const connectCallsAfterInit = mockManager.connectServer.mock.calls.length;

      await vi.advanceTimersByTimeAsync(35_000);
      expect(mockManager.disconnectServer).toHaveBeenCalledWith('server-sse', 'project-1');
      expect(setPendingCloseErrorEnvelope).toHaveBeenCalledWith(
        expect.objectContaining({
          code: 'AUTH_REFRESH_RECONNECT',
          reconnectAfterMs: 1000,
        }),
      );

      await provider.getClient('server-sse', 'project-1');
      expect(mockManager.connectServer).toHaveBeenCalledTimes(connectCallsAfterInit + 1);
      expect(mockManager.connectServer).toHaveBeenCalledWith('server-sse', 'project-1');
    });

    test('refresh failure disconnects and surfaces AUTH_REFRESH_FAILED on reconnect', async () => {
      vi.useFakeTimers();
      const configsWithAuth = [
        {
          id: 'server-fail',
          name: 'AuthServer',
          transport: 'http',
          url: 'https://mcp.example.com/http',
          authProfileId: 'ap-fail-1',
          authProfileVersion: 1,
          authProfileExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          headers: { Authorization: 'Bearer old-token' },
        },
      ];
      const registry = createMockRegistry(configsWithAuth);
      provider = new RuntimeMcpClientProvider(registry as any);

      mockManager.connectServer
        .mockResolvedValueOnce(undefined)
        .mockRejectedValueOnce(new Error('reconnect failed'));
      mockResolveAuthHeadersFromProfileDetailed.mockRejectedValue(new Error('refresh failed'));

      await provider.ensureProjectServers('tenant-1', 'project-1');
      await vi.advanceTimersByTimeAsync(35_000);

      expect(mockManager.disconnectServer).toHaveBeenCalledWith('server-fail', 'project-1');
      const refreshEvent = getAuthTraceEvent('mcp.auth_refreshed');
      assertAuthTracePayloadShape(refreshEvent);
      expect((refreshEvent as { data: Record<string, unknown> }).data.refreshOutcome).toBe(
        'failed',
      );
      expect((refreshEvent as { data: Record<string, unknown> }).data.errorCode).toBe(
        'AUTH_REFRESH_FAILED',
      );
      await expect(provider.getClient('server-fail', 'project-1')).rejects.toThrow(
        'AUTH_REFRESH_FAILED: reconnect failed',
      );
    });
  });

  // ── proxyResolver ─────────────────────────────────────────────────

  describe('proxyResolver', () => {
    test('accepts proxyResolver field for MCP proxy support', () => {
      provider = new RuntimeMcpClientProvider();
      expect(provider.proxyResolver).toBeUndefined();

      const mockResolver = { resolve: vi.fn().mockReturnValue(null) };
      provider.proxyResolver = mockResolver;
      expect(provider.proxyResolver).toBe(mockResolver);
    });

    test('proxyResolver.resolve returning null skips proxy', async () => {
      const registry = createMockRegistry(mockConfigs);
      provider = new RuntimeMcpClientProvider(registry as any);
      provider.proxyResolver = { resolve: vi.fn().mockReturnValue(null) };

      await provider.ensureProjectServers('tenant-1', 'project-1');

      // Servers should still register and connect (no fetchDispatcher)
      expect(mockManager.registerServer).toHaveBeenCalledTimes(2);
      expect(mockManager.connectServer).toHaveBeenCalledTimes(2);
    });
  });
});
