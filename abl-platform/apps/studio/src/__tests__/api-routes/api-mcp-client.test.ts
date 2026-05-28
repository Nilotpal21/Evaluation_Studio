/**
 * Tests for the MCP Servers API client (apps/studio/src/api/mcp-servers.ts)
 *
 * Validates that every exported function builds the correct URL, HTTP method,
 * request body, and propagates errors from handleResponse.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const mockClearAuth = vi.fn();
const mockSetTokens = vi.fn();

vi.mock('../../store/auth-store', () => ({
  useAuthStore: {
    getState: () => ({
      accessToken: 'test-access-token',
      tenantId: 'test-tenant-id',
      clearAuth: mockClearAuth,
      setTokens: mockSetTokens,
    }),
  },
}));

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const mockFetch = vi.fn();

beforeEach(() => {
  mockFetch.mockReset();
  mockClearAuth.mockReset();
  mockSetTokens.mockReset();
  global.fetch = mockFetch;
});

afterEach(() => {
  vi.restoreAllMocks();
});

/** Mock a successful fetch response */
function mockOk(data: unknown) {
  mockFetch.mockResolvedValue({
    ok: true,
    json: () => Promise.resolve(data),
  });
}

/** Mock a failed fetch response */
function mockError(status: number, error = 'Error') {
  mockFetch.mockResolvedValue({
    ok: false,
    status,
    json: () => Promise.resolve({ error }),
  });
}

// ===========================================================================
// MCP Servers API
// ===========================================================================

describe('MCP Servers API', () => {
  let mcpServers: typeof import('../api/mcp-servers');

  beforeEach(async () => {
    mcpServers = await import('../../api/mcp-servers');
  });

  // ── CRUD ────────────────────────────────────────────────────────────────

  describe('fetchMcpServers', () => {
    it('should call the correct URL', async () => {
      mockOk({ success: true, servers: [] });

      await mcpServers.fetchMcpServers('proj-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/mcp-servers');
    });

    it('should return the response data', async () => {
      const data = {
        success: true,
        servers: [{ id: 'srv-1', name: 'My MCP Server' }],
      };
      mockOk(data);

      const result = await mcpServers.fetchMcpServers('proj-1');

      expect(result.servers).toHaveLength(1);
      expect(result.servers[0].id).toBe('srv-1');
    });

    it('should throw on error', async () => {
      mockError(500, 'Server error');

      await expect(mcpServers.fetchMcpServers('proj-1')).rejects.toThrow();
    });
  });

  describe('fetchMcpServer', () => {
    it('should fetch a specific server by ID', async () => {
      mockOk({ success: true, server: { id: 'srv-1', name: 'Test' } });

      await mcpServers.fetchMcpServer('proj-1', 'srv-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/mcp-servers/srv-1');
    });

    it('should return the server detail', async () => {
      const server = { id: 'srv-1', name: 'Test', transport: 'sse' };
      mockOk({ success: true, server });

      const result = await mcpServers.fetchMcpServer('proj-1', 'srv-1');

      expect(result.server.name).toBe('Test');
    });

    it('should throw on 404', async () => {
      mockError(404, 'Not found');

      await expect(mcpServers.fetchMcpServer('proj-1', 'missing')).rejects.toThrow();
    });
  });

  describe('createMcpServer', () => {
    it('should POST to the correct URL', async () => {
      mockOk({ success: true, server: { id: 'srv-new' } });

      await mcpServers.createMcpServer('proj-1', {
        name: 'New Server',
        transport: 'sse',
        url: 'http://localhost:3000/sse',
      });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/mcp-servers');
      expect(opts.method).toBe('POST');
    });

    it('should include the payload in the body', async () => {
      mockOk({ success: true, server: { id: 'srv-new' } });

      const payload = {
        name: 'New Server',
        transport: 'http' as const,
        url: 'http://localhost:8080',
      };

      await mcpServers.createMcpServer('proj-1', payload);

      const [, opts] = mockFetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual(payload);
    });

    it('should set Content-Type header', async () => {
      mockOk({ success: true, server: { id: 'srv-new' } });

      await mcpServers.createMcpServer('proj-1', {
        name: 'S',
        transport: 'sse',
      });

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers).toEqual(expect.objectContaining({ 'Content-Type': 'application/json' }));
    });

    it('should throw on validation error', async () => {
      mockError(400, 'Name is required');

      await expect(
        mcpServers.createMcpServer('proj-1', {
          name: '',
          transport: 'sse',
        }),
      ).rejects.toThrow();
    });
  });

  describe('updateMcpServer', () => {
    it('should PUT to the correct URL', async () => {
      mockOk({ success: true, server: { id: 'srv-1' } });

      await mcpServers.updateMcpServer('proj-1', 'srv-1', { name: 'Updated' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/mcp-servers/srv-1');
      expect(opts.method).toBe('PUT');
    });

    it('should include updated fields in the body', async () => {
      mockOk({ success: true, server: { id: 'srv-1' } });

      const updates = { name: 'Renamed', priority: 5 };
      await mcpServers.updateMcpServer('proj-1', 'srv-1', updates);

      const [, opts] = mockFetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual(updates);
    });

    it('should set Content-Type header', async () => {
      mockOk({ success: true, server: { id: 'srv-1' } });

      await mcpServers.updateMcpServer('proj-1', 'srv-1', {});

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers).toEqual(expect.objectContaining({ 'Content-Type': 'application/json' }));
    });

    it('should throw on error', async () => {
      mockError(500, 'Internal error');

      await expect(mcpServers.updateMcpServer('proj-1', 'srv-1', { name: 'X' })).rejects.toThrow();
    });
  });

  describe('deleteMcpServer', () => {
    it('should DELETE the correct URL', async () => {
      mockOk({ success: true });

      await mcpServers.deleteMcpServer('proj-1', 'srv-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/mcp-servers/srv-1');
      expect(opts.method).toBe('DELETE');
    });

    it('should resolve without returning data', async () => {
      mockOk({ success: true });

      const result = await mcpServers.deleteMcpServer('proj-1', 'srv-1');

      expect(result).toBeUndefined();
    });

    it('should throw on error', async () => {
      mockError(404, 'Not found');

      await expect(mcpServers.deleteMcpServer('proj-1', 'not-found')).rejects.toThrow();
    });
  });

  // ── Operations ──────────────────────────────────────────────────────────

  describe('testMcpServerConnection', () => {
    it('should POST to the test-connection endpoint', async () => {
      mockOk({
        success: true,
        result: { connected: true, toolCount: 5, latencyMs: 42 },
      });

      await mcpServers.testMcpServerConnection('proj-1', 'srv-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/mcp-servers/srv-1/test-connection');
      expect(opts.method).toBe('POST');
    });

    it('should send an empty JSON body', async () => {
      mockOk({
        success: true,
        result: { connected: true, latencyMs: 10 },
      });

      await mcpServers.testMcpServerConnection('proj-1', 'srv-1');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body).toBe('{}');
    });

    it('should return the connection result', async () => {
      const connectionResult = {
        connected: true,
        toolCount: 3,
        latencyMs: 55,
      };
      mockOk({ success: true, result: connectionResult });

      const result = await mcpServers.testMcpServerConnection('proj-1', 'srv-1');

      expect(result.success).toBe(true);
      expect(result.result.connected).toBe(true);
      expect(result.result.toolCount).toBe(3);
    });

    it('should throw on error', async () => {
      mockError(500, 'Connection failed');

      await expect(mcpServers.testMcpServerConnection('proj-1', 'srv-1')).rejects.toThrow();
    });
  });

  describe('discoverToolsPreview', () => {
    it('should POST to the discover/preview endpoint', async () => {
      mockOk({ success: true, tools: [], totalDiscovered: 0 });

      await mcpServers.discoverToolsPreview('proj-1', 'srv-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/mcp-servers/srv-1/tools/discover/preview');
      expect(opts.method).toBe('POST');
    });

    it('should send an empty JSON body', async () => {
      mockOk({ success: true, tools: [], totalDiscovered: 0 });

      await mcpServers.discoverToolsPreview('proj-1', 'srv-1');

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.body).toBe('{}');
    });

    it('should return the discovered tools preview', async () => {
      const tools = [
        { name: 'search', description: 'Search tool', inputSchema: null, suggestedSlug: 'search' },
      ];
      mockOk({ success: true, tools, totalDiscovered: 1 });

      const result = await mcpServers.discoverToolsPreview('proj-1', 'srv-1');

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].name).toBe('search');
      expect(result.totalDiscovered).toBe(1);
    });

    it('should throw on error', async () => {
      mockError(500, 'Discovery failed');

      await expect(mcpServers.discoverToolsPreview('proj-1', 'srv-1')).rejects.toThrow();
    });
  });

  describe('discoverAndImportTools', () => {
    it('should POST to the discover endpoint', async () => {
      mockOk({
        success: true,
        successful: 2,
        failed: [],
        schemaDrift: [],
        conflicting: [],
        totalDiscovered: 2,
      });

      await mcpServers.discoverAndImportTools('proj-1', 'srv-1');

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/mcp-servers/srv-1/tools/discover');
      expect(opts.method).toBe('POST');
    });

    it('should send empty body when no tool names specified', async () => {
      mockOk({
        success: true,
        successful: 0,
        failed: [],
        schemaDrift: [],
        conflicting: [],
        totalDiscovered: 0,
      });

      await mcpServers.discoverAndImportTools('proj-1', 'srv-1');

      const [, opts] = mockFetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({});
    });

    it('should include toolNames in the body when specified', async () => {
      mockOk({
        success: true,
        successful: 2,
        failed: [],
        schemaDrift: [],
        conflicting: [],
        totalDiscovered: 2,
      });

      await mcpServers.discoverAndImportTools('proj-1', 'srv-1', ['search', 'fetch']);

      const [, opts] = mockFetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({
        toolNames: ['search', 'fetch'],
      });
    });

    it('should return the import result', async () => {
      const data = {
        success: true,
        successful: 1,
        failed: [{ toolName: 'bad', error: 'Schema conflict' }],
        schemaDrift: [],
        conflicting: [],
        totalDiscovered: 2,
      };
      mockOk(data);

      const result = await mcpServers.discoverAndImportTools('proj-1', 'srv-1');

      expect(result.successful).toBe(1);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0].toolName).toBe('bad');
    });

    it('should throw on error', async () => {
      mockError(500, 'Import failed');

      await expect(mcpServers.discoverAndImportTools('proj-1', 'srv-1')).rejects.toThrow();
    });
  });

  describe('fetchServerTools', () => {
    it('should GET the server tools endpoint', async () => {
      mockOk({ success: true, tools: [] });

      await mcpServers.fetchServerTools('proj-1', 'srv-1');

      const [url] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/mcp-servers/srv-1/tools');
    });

    it('should not set a method (defaults to GET)', async () => {
      mockOk({ success: true, tools: [] });

      await mcpServers.fetchServerTools('proj-1', 'srv-1');

      const [, opts] = mockFetch.mock.calls[0];
      // apiFetch does not set method for GET - it stays undefined
      expect(opts.method).toBeUndefined();
    });

    it('should return the tools list', async () => {
      const tools = [
        {
          id: 't-1',
          toolName: 'search',
          description: 'Search tool',
          inputSchema: {},
          serverName: 'srv-1',
          discoveredAt: '2024-01-01',
          lastVerifiedAt: '2024-01-01',
          isAvailable: true,
        },
      ];
      mockOk({ success: true, tools });

      const result = await mcpServers.fetchServerTools('proj-1', 'srv-1');

      expect(result.tools).toHaveLength(1);
      expect(result.tools[0].toolName).toBe('search');
    });

    it('should throw on error', async () => {
      mockError(500, 'Server error');

      await expect(mcpServers.fetchServerTools('proj-1', 'srv-1')).rejects.toThrow();
    });
  });

  describe('testMcpTool', () => {
    it('should POST to the tool test endpoint with encoded tool name', async () => {
      mockOk({ success: true, output: {}, latencyMs: 15 });

      await mcpServers.testMcpTool('proj-1', 'srv-1', 'my tool', { q: 'hi' });

      const [url, opts] = mockFetch.mock.calls[0];
      expect(url).toBe('/api/projects/proj-1/mcp-servers/srv-1/tools/my%20tool/test');
      expect(opts.method).toBe('POST');
    });

    it('should include input in the body', async () => {
      mockOk({ success: true, output: { result: 42 }, latencyMs: 20 });

      const input = { query: 'test', limit: 10 };
      await mcpServers.testMcpTool('proj-1', 'srv-1', 'search', input);

      const [, opts] = mockFetch.mock.calls[0];
      expect(JSON.parse(opts.body)).toEqual({ input });
    });

    it('should set Content-Type header', async () => {
      mockOk({ success: true, output: null, latencyMs: 5 });

      await mcpServers.testMcpTool('proj-1', 'srv-1', 'ping', {});

      const [, opts] = mockFetch.mock.calls[0];
      expect(opts.headers).toEqual(expect.objectContaining({ 'Content-Type': 'application/json' }));
    });

    it('should return the test result', async () => {
      const data = {
        success: true,
        output: { answer: 'hello' },
        latencyMs: 30,
        logs: ['started', 'done'],
      };
      mockOk(data);

      const result = await mcpServers.testMcpTool('proj-1', 'srv-1', 'greet', {
        name: 'world',
      });

      expect(result.success).toBe(true);
      expect(result.output).toEqual({ answer: 'hello' });
      expect(result.latencyMs).toBe(30);
      expect(result.logs).toEqual(['started', 'done']);
    });

    it('should URL-encode special characters in tool name', async () => {
      mockOk({ success: true, output: null, latencyMs: 1 });

      await mcpServers.testMcpTool('proj-1', 'srv-1', 'ns/tool-name', {});

      const [url] = mockFetch.mock.calls[0];
      expect(url).toContain('ns%2Ftool-name');
    });

    it('should throw on error', async () => {
      mockError(400, 'Invalid input');

      await expect(mcpServers.testMcpTool('proj-1', 'srv-1', 'search', {})).rejects.toThrow();
    });
  });
});
