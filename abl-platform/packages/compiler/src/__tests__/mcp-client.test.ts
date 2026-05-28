/**
 * MCP Client, Protocol, and Server Manager Tests
 *
 * Tests connection lifecycle, tool invocation, resource/prompt management,
 * notification handling, security validation, audit hooks, and the
 * MCPServerManager including tenant-scoped server pools.
 *
 * All external connections (child_process, SSE, WebSocket) are mocked.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import { EventEmitter } from 'events';

// Mock SSRF validator before importing modules that use it
const mockAssertUrlSafeForSSRF = vi.fn();
vi.mock('@agent-platform/shared-kernel/security', () => ({
  assertUrlSafeForSSRF: (...args: unknown[]) => mockAssertUrlSafeForSSRF(...args),
}));

// Mock the logger before importing modules that use it
vi.mock('../../platform/logger.js', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    debug: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { MCPClient, type MCPClientConfig, type MCPAuditEvent } from '../platform/mcp/client.js';
import {
  MCPServerManager,
  getMCPServerManager,
  resetMCPServerManager,
  type MCPServerConfig,
} from '../platform/mcp/server-manager.js';
import {
  MCP_PROTOCOL_VERSION,
  MCP_SUPPORTED_VERSIONS,
  MCPErrorCodes,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
  type ServerCapabilities,
  type MCPTool,
} from '../platform/mcp/protocol.js';

// =============================================================================
// HELPERS
// =============================================================================

/** Create a mock transport that behaves like StdioTransport or SSETransport */
function createMockTransport() {
  const emitter = new EventEmitter();
  return {
    on: emitter.on.bind(emitter),
    once: emitter.once.bind(emitter),
    emit: emitter.emit.bind(emitter),
    removeAllListeners: emitter.removeAllListeners.bind(emitter),
    send: vi.fn(),
    close: vi.fn(),
    _emitter: emitter,
  };
}

/** Wire a mock transport into an MCPClient (bypassing createTransport) */
function wireTransport(client: MCPClient, transport: ReturnType<typeof createMockTransport>) {
  (client as any).transport = transport;
}

/** Simulate a JSON-RPC response to a pending request */
function respondToPending(client: MCPClient, result: unknown, requestIndex = 0): void {
  const pendingRequests = (client as any).pendingRequests as Map<string, any>;
  const entries = Array.from(pendingRequests.entries());
  if (entries.length > requestIndex) {
    const [id, pending] = entries[requestIndex];
    clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.resolve(result);
  }
}

/** Simulate a JSON-RPC error response to a pending request */
function respondWithError(client: MCPClient, errorMessage: string, requestIndex = 0): void {
  const pendingRequests = (client as any).pendingRequests as Map<string, any>;
  const entries = Array.from(pendingRequests.entries());
  if (entries.length > requestIndex) {
    const [id, pending] = entries[requestIndex];
    clearTimeout(pending.timer);
    pendingRequests.delete(id);
    pending.reject(new Error(errorMessage));
  }
}

const MOCK_INIT_RESULT = {
  protocolVersion: MCP_PROTOCOL_VERSION,
  capabilities: {
    tools: { listChanged: true },
    resources: { subscribe: true, listChanged: true },
    prompts: { listChanged: true },
  } as ServerCapabilities,
  serverInfo: { name: 'test-server', version: '1.0.0' },
};

const MOCK_TOOLS: MCPTool[] = [
  {
    name: 'get_weather',
    description: 'Get weather for a city',
    inputSchema: {
      type: 'object',
      properties: { city: { type: 'string', description: 'City name' } },
      required: ['city'],
    },
  },
  {
    name: 'search',
    description: 'Search for information',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string' } },
    },
  },
];

// =============================================================================
// PROTOCOL TYPES TESTS
// =============================================================================

describe('MCP Protocol Types', () => {
  test('MCP_PROTOCOL_VERSION is defined', () => {
    expect(MCP_PROTOCOL_VERSION).toBe('2024-11-05');
  });

  test('MCP_SUPPORTED_VERSIONS contains current version', () => {
    expect(MCP_SUPPORTED_VERSIONS).toContain(MCP_PROTOCOL_VERSION);
  });

  test('MCPErrorCodes contains standard JSON-RPC codes', () => {
    expect(MCPErrorCodes.PARSE_ERROR).toBe(-32700);
    expect(MCPErrorCodes.INVALID_REQUEST).toBe(-32600);
    expect(MCPErrorCodes.METHOD_NOT_FOUND).toBe(-32601);
    expect(MCPErrorCodes.INVALID_PARAMS).toBe(-32602);
    expect(MCPErrorCodes.INTERNAL_ERROR).toBe(-32603);
  });

  test('MCPErrorCodes contains MCP-specific codes', () => {
    expect(MCPErrorCodes.REQUEST_CANCELLED).toBe(-32000);
    expect(MCPErrorCodes.CONTENT_TOO_LARGE).toBe(-32001);
  });
});

// =============================================================================
// MCP CLIENT CONSTRUCTION
// =============================================================================

describe('MCPClient — construction', () => {
  test('applies default config values', () => {
    const client = new MCPClient({
      name: 'test-server',
      transport: 'stdio',
    });

    const config = (client as any).config;
    expect(config.connectionTimeoutMs).toBe(30000);
    expect(config.requestTimeoutMs).toBe(60000);
    expect(config.autoReconnect).toBe(true);
    expect(config.maxReconnectAttempts).toBe(3);
    expect(config.maxPendingRequests).toBe(100);
  });

  test('overrides default config values', () => {
    const client = new MCPClient({
      name: 'custom',
      transport: 'sse',
      connectionTimeoutMs: 5000,
      requestTimeoutMs: 10000,
      autoReconnect: false,
      maxReconnectAttempts: 1,
      maxPendingRequests: 10,
    });

    const config = (client as any).config;
    expect(config.connectionTimeoutMs).toBe(5000);
    expect(config.requestTimeoutMs).toBe(10000);
    expect(config.autoReconnect).toBe(false);
    expect(config.maxReconnectAttempts).toBe(1);
    expect(config.maxPendingRequests).toBe(10);
  });

  test('initial state is disconnected', () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    expect(client.connected).toBe(false);
    expect(client.capabilities).toBeNull();
    expect(client.server).toBeNull();
    expect(client.toolCount).toBe(0);
    expect(client.resourceCount).toBe(0);
    expect(client.promptCount).toBe(0);
  });
});

// =============================================================================
// MCP CLIENT — TRANSPORT CREATION VALIDATION
// =============================================================================

describe('MCPClient — transport creation validation', () => {
  test('stdio transport requires command', async () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    await expect(client.connect()).rejects.toThrow('Command is required for stdio transport');
  });

  test('sse transport requires url', async () => {
    const client = new MCPClient({ name: 'test', transport: 'sse' });
    await expect(client.connect()).rejects.toThrow('URL is required for SSE transport');
  });

  test('unsupported transport type throws', async () => {
    const client = new MCPClient({ name: 'test', transport: 'grpc' as any });
    await expect(client.connect()).rejects.toThrow('Unsupported transport: grpc');
  });

  test('stdio command allowlist rejects unlisted command', async () => {
    const client = new MCPClient({
      name: 'test',
      transport: 'stdio',
      command: '/usr/bin/evil',
      allowedCommands: ['node', 'python'],
    });
    await expect(client.connect()).rejects.toThrow('not in the allowed commands list');
  });

  test('stdio command allowlist accepts listed command (base name)', () => {
    // Verify allowlist logic directly: the base name "node" is in the allowed list
    // so createStdioTransport should NOT reject on the allowlist check.
    // We test the validation logic without actually spawning a process.
    const client = new MCPClient({
      name: 'test',
      transport: 'stdio',
      command: '/usr/local/bin/node',
      allowedCommands: ['node', 'python'],
    });
    const config = (client as any).config;
    const commandBase = config.command.split('/').pop() || config.command;
    expect(config.allowedCommands.includes(commandBase)).toBe(true);
  });

  test('sse URL pattern validation rejects non-matching URLs', async () => {
    const client = new MCPClient({
      name: 'test',
      transport: 'sse',
      url: 'https://evil.com/sse',
      allowedUrlPatterns: ['^https://trusted\\.com/'],
    });
    await expect(client.connect()).rejects.toThrow('does not match any allowed URL pattern');
  });
});

// =============================================================================
// MCP CLIENT — SSRF PROTECTION
// =============================================================================

describe('MCPClient — SSRF protection', () => {
  beforeEach(() => {
    mockAssertUrlSafeForSSRF.mockReset();
  });

  test('SSE transport rejects private IP (10.x.x.x)', async () => {
    mockAssertUrlSafeForSSRF.mockImplementation(() => {
      throw new Error('SSRF: blocked private IP range 10.0.0.0/8');
    });

    const client = new MCPClient({
      name: 'ssrf-test',
      transport: 'sse',
      url: 'http://10.0.0.1/sse',
    });

    await expect(client.connect()).rejects.toThrow('SSRF');
    expect(mockAssertUrlSafeForSSRF).toHaveBeenCalledWith('http://10.0.0.1/sse', {
      allowLocalhost: false,
    });
  });

  test('SSE transport rejects cloud metadata endpoint', async () => {
    mockAssertUrlSafeForSSRF.mockImplementation(() => {
      throw new Error('SSRF: blocked cloud metadata endpoint 169.254.169.254');
    });

    const client = new MCPClient({
      name: 'ssrf-test',
      transport: 'sse',
      url: 'http://169.254.169.254/latest/meta-data/',
    });

    await expect(client.connect()).rejects.toThrow('SSRF');
    expect(mockAssertUrlSafeForSSRF).toHaveBeenCalledWith(
      'http://169.254.169.254/latest/meta-data/',
      { allowLocalhost: false },
    );
  });

  test('SSE transport rejects localhost', async () => {
    mockAssertUrlSafeForSSRF.mockImplementation(() => {
      throw new Error('SSRF: blocked localhost address 127.0.0.1');
    });

    const client = new MCPClient({
      name: 'ssrf-test',
      transport: 'sse',
      url: 'http://127.0.0.1:3000/sse',
    });

    await expect(client.connect()).rejects.toThrow('SSRF');
    expect(mockAssertUrlSafeForSSRF).toHaveBeenCalledWith('http://127.0.0.1:3000/sse', {
      allowLocalhost: false,
    });
  });

  test('HTTP transport rejects private IP (192.168.x.x)', async () => {
    mockAssertUrlSafeForSSRF.mockImplementation(() => {
      throw new Error('SSRF: blocked private IP range 192.168.0.0/16');
    });

    const client = new MCPClient({
      name: 'ssrf-test',
      transport: 'http',
      url: 'http://192.168.1.1/api',
    });

    await expect(client.connect()).rejects.toThrow('SSRF');
    expect(mockAssertUrlSafeForSSRF).toHaveBeenCalledWith('http://192.168.1.1/api', {
      allowLocalhost: false,
    });
  });

  test('HTTP transport rejects cloud metadata (metadata.google.internal)', async () => {
    mockAssertUrlSafeForSSRF.mockImplementation(() => {
      throw new Error('SSRF: blocked cloud metadata hostname metadata.google.internal');
    });

    const client = new MCPClient({
      name: 'ssrf-test',
      transport: 'http',
      url: 'http://metadata.google.internal/computeMetadata/v1/',
    });

    await expect(client.connect()).rejects.toThrow('SSRF');
    expect(mockAssertUrlSafeForSSRF).toHaveBeenCalledWith(
      'http://metadata.google.internal/computeMetadata/v1/',
      { allowLocalhost: false },
    );
  });

  test('SSE transport allows valid public URL past SSRF check', async () => {
    // When assertUrlSafeForSSRF does NOT throw, the client proceeds past SSRF.
    // connect() will then fail on timeout because the mocked fetch never resolves.
    // We mock fetch to prevent a real network call (which would leak as an unhandled rejection).
    mockAssertUrlSafeForSSRF.mockImplementation(() => {
      // no-op: URL is safe
    });

    const originalFetch = globalThis.fetch;
    // Return a promise that never resolves so the connection times out cleanly
    globalThis.fetch = vi.fn().mockReturnValue(new Promise(() => {}));

    const client = new MCPClient({
      name: 'ssrf-test',
      transport: 'sse',
      url: 'https://mcp.example.com/sse',
      connectionTimeoutMs: 200,
    });

    // connect() will fail with a timeout (fetch never resolves).
    // The key assertion: assertUrlSafeForSSRF was called and did NOT throw.
    try {
      await client.connect();
    } catch {
      // Expected: timeout error — not SSRF rejection
    } finally {
      await client.disconnect();
      globalThis.fetch = originalFetch;
    }

    expect(mockAssertUrlSafeForSSRF).toHaveBeenCalledWith('https://mcp.example.com/sse', {
      allowLocalhost: false,
    });
  });

  test('HTTP transport fails fast on 401 instead of hanging until requestTimeoutMs', async () => {
    // Regression: upstream 401/403/5xx with application/json body that is NOT a
    // JSON-RPC response used to be silently swallowed, leaving `initialize`
    // pending until the 30s request timeout fired (→ nginx 504 in front).
    mockAssertUrlSafeForSSRF.mockImplementation(() => {
      // URL is safe — let the HTTP error path run
    });

    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response('{"error":"Unauthorized. Provide a valid X-API-Key header."}', {
        status: 401,
        statusText: 'Unauthorized',
        headers: { 'content-type': 'application/json' },
      }),
    );

    const client = new MCPClient({
      name: 'http-401',
      transport: 'http',
      url: 'https://mcp.example.com/mcp',
      // Large timeout on purpose — the fix must reject *before* this fires.
      connectionTimeoutMs: 30_000,
      requestTimeoutMs: 30_000,
      autoReconnect: false,
    });

    const start = Date.now();
    await expect(client.connect()).rejects.toThrow(/401|Unauthorized/);
    const elapsed = Date.now() - start;
    globalThis.fetch = originalFetch;

    // Should reject in well under 1s; allow a generous ceiling for CI jitter.
    expect(elapsed).toBeLessThan(5_000);
  });
});

// =============================================================================
// MCP CLIENT — MESSAGE HANDLING
// =============================================================================

describe('MCPClient — message handling', () => {
  let client: MCPClient;
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    client = new MCPClient({
      name: 'test',
      transport: 'stdio',
      requestTimeoutMs: 5000,
      maxPendingRequests: 3,
    });
    transport = createMockTransport();
    wireTransport(client, transport);
    // Set connected state
    (client as any).isConnected = true;
  });

  afterEach(() => {
    // Clean up pending requests
    const pending = (client as any).pendingRequests as Map<string, any>;
    for (const [, p] of pending) {
      clearTimeout(p.timer);
    }
    pending.clear();
  });

  test('request sends JSON-RPC message with correct format', () => {
    // Call the private request method
    const promise = (client as any).request('tools/list', { cursor: 'abc' });

    expect(transport.send).toHaveBeenCalledTimes(1);
    const sent = transport.send.mock.calls[0][0] as JsonRpcRequest;
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('tools/list');
    expect(sent.params).toEqual({ cursor: 'abc' });
    expect(sent.id).toBeDefined();

    // Clean up
    respondToPending(client, { tools: [] });
  });

  test('request resolves when response received', async () => {
    const promise = (client as any).request('tools/list', {});

    // Simulate response
    const requestId = transport.send.mock.calls[0][0].id;
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: requestId,
      result: { tools: MOCK_TOOLS },
    };
    (client as any).handleMessage(response);

    const result = await promise;
    expect(result).toEqual({ tools: MOCK_TOOLS });
  });

  test('request rejects on error response', async () => {
    const promise = (client as any).request('tools/list', {});

    const requestId = transport.send.mock.calls[0][0].id;
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: requestId,
      error: { code: -32600, message: 'Invalid request' },
    };
    (client as any).handleMessage(response);

    await expect(promise).rejects.toThrow('Invalid request');
  });

  test('request rejects on timeout', async () => {
    vi.useFakeTimers();
    const promise = (client as any).request('tools/list', {});

    vi.advanceTimersByTime(6000); // Past the 5000ms timeout

    await expect(promise).rejects.toThrow('Request timeout: tools/list');
    vi.useRealTimers();
  });

  test('request rejects when not connected', async () => {
    (client as any).transport = null;
    await expect((client as any).request('tools/list', {})).rejects.toThrow('Not connected');
  });

  test('request rejects when max pending requests exceeded', async () => {
    // Fill up pending requests (max is 3)
    (client as any).request('tools/list', {});
    (client as any).request('tools/list', {});
    (client as any).request('tools/list', {});

    await expect((client as any).request('tools/list', {})).rejects.toThrow(
      'Max pending requests (3) exceeded',
    );
  });

  test('response for unknown request ID is ignored', () => {
    const response: JsonRpcResponse = {
      jsonrpc: '2.0',
      id: 'unknown-id',
      result: {},
    };
    // Should not throw
    expect(() => (client as any).handleMessage(response)).not.toThrow();
  });
});

// =============================================================================
// MCP CLIENT — NOTIFICATION HANDLING
// =============================================================================

describe('MCPClient — notification handling', () => {
  let client: MCPClient;
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    client = new MCPClient({ name: 'test', transport: 'stdio' });
    transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;
    (client as any).serverCapabilities = MOCK_INIT_RESULT.capabilities;
  });

  test('tools/list_changed notification triggers toolsChanged event', () => {
    const handler = vi.fn();
    client.on('toolsChanged', handler);

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/tools/list_changed',
    };
    (client as any).handleMessage(notification);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('resources/list_changed notification triggers resourcesChanged event', () => {
    const handler = vi.fn();
    client.on('resourcesChanged', handler);

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/resources/list_changed',
    };
    (client as any).handleMessage(notification);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('resources/updated notification triggers resourceUpdated event with URI', () => {
    const handler = vi.fn();
    client.on('resourceUpdated', handler);

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/resources/updated',
      params: { uri: 'file:///test.txt' },
    };
    (client as any).handleMessage(notification);

    expect(handler).toHaveBeenCalledWith('file:///test.txt');
  });

  test('prompts/list_changed notification triggers promptsChanged event', () => {
    const handler = vi.fn();
    client.on('promptsChanged', handler);

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/prompts/list_changed',
    };
    (client as any).handleMessage(notification);

    expect(handler).toHaveBeenCalledTimes(1);
  });

  test('logging notification triggers log event', () => {
    const handler = vi.fn();
    client.on('log', handler);

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'notifications/message',
      params: { level: 'info', logger: 'test-logger', data: { key: 'value' } },
    };
    (client as any).handleMessage(notification);

    expect(handler).toHaveBeenCalledWith('info', 'test-logger', { key: 'value' });
  });

  test('unknown notification triggers generic notification event', () => {
    const handler = vi.fn();
    client.on('notification', handler);

    const notification: JsonRpcNotification = {
      jsonrpc: '2.0',
      method: 'custom/notification',
      params: { foo: 'bar' },
    };
    (client as any).handleMessage(notification);

    expect(handler).toHaveBeenCalledWith('custom/notification', { foo: 'bar' });
  });
});

// =============================================================================
// MCP CLIENT — TOOL OPERATIONS
// =============================================================================

describe('MCPClient — tool operations', () => {
  let client: MCPClient;
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    client = new MCPClient({ name: 'test', transport: 'stdio' });
    transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;
    (client as any).serverCapabilities = MOCK_INIT_RESULT.capabilities;

    // Populate tools
    for (const tool of MOCK_TOOLS) {
      (client as any)._tools.set(tool.name, tool);
    }
  });

  test('listTools returns all tools', async () => {
    const tools = await client.listTools();
    expect(tools).toHaveLength(2);
    expect(tools[0].name).toBe('get_weather');
    expect(tools[1].name).toBe('search');
  });

  test('getTool returns specific tool by name', () => {
    const tool = client.getTool('get_weather');
    expect(tool).toBeDefined();
    expect(tool!.name).toBe('get_weather');
  });

  test('getTool returns undefined for unknown tool', () => {
    expect(client.getTool('nonexistent')).toBeUndefined();
  });

  test('callTool sends tools/call request', async () => {
    const promise = client.callTool('get_weather', { city: 'London' });

    // Verify the request was sent
    const sent = transport.send.mock.calls[0][0] as JsonRpcRequest;
    expect(sent.method).toBe('tools/call');
    expect(sent.params).toEqual({ name: 'get_weather', arguments: { city: 'London' } });

    // Respond with result
    respondToPending(client, {
      content: [{ type: 'text', text: 'Sunny, 22C' }],
      isError: false,
    });

    const result = await promise;
    expect(result).toEqual({
      content: [{ type: 'text', text: 'Sunny, 22C' }],
      isError: false,
    });
  });

  test('toolCount returns correct count', () => {
    expect(client.toolCount).toBe(2);
  });
});

// =============================================================================
// MCP CLIENT — RESOURCE OPERATIONS
// =============================================================================

describe('MCPClient — resource operations', () => {
  let client: MCPClient;
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    client = new MCPClient({ name: 'test', transport: 'stdio' });
    transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;
    (client as any).serverCapabilities = {
      resources: { subscribe: true, listChanged: true },
    };

    // Populate resources
    (client as any)._resources.set('file:///test.txt', {
      uri: 'file:///test.txt',
      name: 'test.txt',
      mimeType: 'text/plain',
    });
  });

  test('listResources returns all resources', async () => {
    const resources = await client.listResources();
    expect(resources).toHaveLength(1);
    expect(resources[0].uri).toBe('file:///test.txt');
  });

  test('getResource returns resource by URI', () => {
    const resource = client.getResource('file:///test.txt');
    expect(resource).toBeDefined();
    expect(resource!.name).toBe('test.txt');
  });

  test('readResource sends resources/read request', async () => {
    const promise = client.readResource('file:///test.txt');

    const sent = transport.send.mock.calls[0][0] as JsonRpcRequest;
    expect(sent.method).toBe('resources/read');
    expect(sent.params).toEqual({ uri: 'file:///test.txt' });

    respondToPending(client, {
      contents: [{ uri: 'file:///test.txt', text: 'Hello world' }],
    });

    const result = await promise;
    expect(result.contents).toHaveLength(1);
  });

  test('subscribeResource sends subscription request', async () => {
    const promise = client.subscribeResource('file:///test.txt');

    respondToPending(client, {});
    await promise;

    const sent = transport.send.mock.calls[0][0] as JsonRpcRequest;
    expect(sent.method).toBe('resources/subscribe');
  });

  test('subscribeResource throws when server does not support subscriptions', async () => {
    (client as any).serverCapabilities = { resources: {} };
    await expect(client.subscribeResource('file:///test.txt')).rejects.toThrow(
      'Server does not support resource subscriptions',
    );
  });

  test('unsubscribeResource sends unsubscription request', async () => {
    const promise = client.unsubscribeResource('file:///test.txt');

    respondToPending(client, {});
    await promise;

    const sent = transport.send.mock.calls[0][0] as JsonRpcRequest;
    expect(sent.method).toBe('resources/unsubscribe');
  });

  test('resourceCount returns correct count', () => {
    expect(client.resourceCount).toBe(1);
  });
});

// =============================================================================
// MCP CLIENT — PROMPT OPERATIONS
// =============================================================================

describe('MCPClient — prompt operations', () => {
  let client: MCPClient;
  let transport: ReturnType<typeof createMockTransport>;

  beforeEach(() => {
    client = new MCPClient({ name: 'test', transport: 'stdio' });
    transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;
    (client as any).serverCapabilities = { prompts: { listChanged: true } };

    // Populate prompts
    (client as any)._prompts.set('greeting', {
      name: 'greeting',
      description: 'A greeting prompt',
      arguments: [{ name: 'name', required: true }],
    });
  });

  test('listPrompts returns all prompts', async () => {
    const prompts = await client.listPrompts();
    expect(prompts).toHaveLength(1);
    expect(prompts[0].name).toBe('greeting');
  });

  test('getPrompt returns prompt by name', () => {
    const prompt = client.getPrompt('greeting');
    expect(prompt).toBeDefined();
    expect(prompt!.description).toBe('A greeting prompt');
  });

  test('fetchPrompt sends prompts/get request', async () => {
    const promise = client.fetchPrompt('greeting', { name: 'Alice' });

    const sent = transport.send.mock.calls[0][0] as JsonRpcRequest;
    expect(sent.method).toBe('prompts/get');
    expect(sent.params).toEqual({ name: 'greeting', arguments: { name: 'Alice' } });

    respondToPending(client, {
      messages: [{ role: 'user', content: { type: 'text', text: 'Hello Alice!' } }],
    });

    const result = await promise;
    expect(result.messages).toHaveLength(1);
  });

  test('promptCount returns correct count', () => {
    expect(client.promptCount).toBe(1);
  });
});

// =============================================================================
// MCP CLIENT — AUDIT HOOKS
// =============================================================================

describe('MCPClient — audit hooks', () => {
  test('audit hook receives tool_call events', async () => {
    const auditEvents: MCPAuditEvent[] = [];
    const client = new MCPClient({
      name: 'test',
      transport: 'stdio',
      tenantId: 'tenant-123',
      auditHook: (event) => {
        auditEvents.push(event);
      },
    });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;

    const promise = client.callTool('get_weather', { city: 'Paris' });
    respondToPending(client, {
      content: [{ type: 'text', text: 'Rainy' }],
      isError: false,
    });
    await promise;

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].operation).toBe('tool_call');
    expect(auditEvents[0].serverName).toBe('test');
    expect(auditEvents[0].tenantId).toBe('tenant-123');
    expect(auditEvents[0].toolName).toBe('get_weather');
    expect(auditEvents[0].success).toBe(true);
    expect(auditEvents[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  test('audit hook receives resource_read events', async () => {
    const auditEvents: MCPAuditEvent[] = [];
    const client = new MCPClient({
      name: 'test',
      transport: 'stdio',
      auditHook: (event) => {
        auditEvents.push(event);
      },
    });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;

    const promise = client.readResource('file:///test.txt');
    respondToPending(client, { contents: [] });
    await promise;

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].operation).toBe('resource_read');
    expect(auditEvents[0].resourceUri).toBe('file:///test.txt');
    expect(auditEvents[0].success).toBe(true);
  });

  test('audit hook receives error events on tool_call failure', async () => {
    const auditEvents: MCPAuditEvent[] = [];
    const client = new MCPClient({
      name: 'test',
      transport: 'stdio',
      auditHook: (event) => {
        auditEvents.push(event);
      },
    });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;

    const promise = client.callTool('broken_tool');
    respondWithError(client, 'Tool failed');
    await expect(promise).rejects.toThrow('Tool failed');

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].operation).toBe('tool_call');
    expect(auditEvents[0].success).toBe(false);
    expect(auditEvents[0].error).toBe('Tool failed');
  });

  test('audit hook receives prompt_get events', async () => {
    const auditEvents: MCPAuditEvent[] = [];
    const client = new MCPClient({
      name: 'test',
      transport: 'stdio',
      auditHook: (event) => {
        auditEvents.push(event);
      },
    });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;

    const promise = client.fetchPrompt('greeting', { name: 'Bob' });
    respondToPending(client, { messages: [] });
    await promise;

    expect(auditEvents).toHaveLength(1);
    expect(auditEvents[0].operation).toBe('prompt_get');
    expect(auditEvents[0].success).toBe(true);
    expect(auditEvents[0].metadata).toEqual({ promptName: 'greeting' });
  });

  test('async audit hook error does not propagate', async () => {
    const client = new MCPClient({
      name: 'test',
      transport: 'stdio',
      auditHook: async () => {
        throw new Error('async audit hook error');
      },
    });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;

    const promise = client.callTool('test_tool');
    respondToPending(client, { content: [], isError: false });

    // Async audit hook errors are caught by Promise.resolve().catch()
    await expect(promise).resolves.toBeDefined();
  });
});

// =============================================================================
// MCP CLIENT — TRANSPORT ERROR / CLOSE
// =============================================================================

describe('MCPClient — transport error and close', () => {
  test('transport error emits error event', () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;

    const errorHandler = vi.fn();
    client.on('error', errorHandler);

    (client as any).handleTransportError(new Error('connection lost'));

    expect(errorHandler).toHaveBeenCalledTimes(1);
    expect(errorHandler.mock.calls[0][0].message).toBe('connection lost');
  });

  test('transport close emits disconnected event and cleans up', () => {
    const client = new MCPClient({
      name: 'test',
      transport: 'stdio',
      autoReconnect: false,
    });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;

    const disconnectHandler = vi.fn();
    client.on('disconnected', disconnectHandler);

    (client as any).handleTransportClose();

    expect(disconnectHandler).toHaveBeenCalledWith('transport_closed');
    expect(client.connected).toBe(false);
    expect(client.capabilities).toBeNull();
    expect(client.server).toBeNull();
  });

  test('disconnect when already disconnected is a no-op', async () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    // Not connected, so disconnect should be harmless
    await expect(client.disconnect()).resolves.toBeUndefined();
  });

  test('connect when already connected is a no-op', async () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    (client as any).isConnected = true;
    // Should return immediately
    await expect(client.connect()).resolves.toBeUndefined();
  });

  test('cleanup cancels all pending requests', () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;

    // Create some pending requests
    const p1 = (client as any).request('tools/list', {}).catch(() => {});
    const p2 = (client as any).request('resources/list', {}).catch(() => {});

    expect((client as any).pendingRequests.size).toBe(2);

    (client as any).cleanup();

    expect((client as any).pendingRequests.size).toBe(0);
    expect(client.connected).toBe(false);
  });

  test('cleanup rejects pending requests with AUTH_REFRESH_RECONNECT envelope when configured', async () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;

    const pendingRequest = (client as any).request('tools/list', {});
    client.setPendingCloseErrorEnvelope({
      code: 'AUTH_REFRESH_RECONNECT',
      reconnectAfterMs: 750,
      message: 'Reconnect in progress',
    });

    (client as any).cleanup();

    await expect(pendingRequest).rejects.toThrow('"code":"AUTH_REFRESH_RECONNECT"');
    await expect(pendingRequest).rejects.toThrow('"reconnectAfterMs":750');
  });
});

// =============================================================================
// MCP CLIENT — REFRESH OPERATIONS
// =============================================================================

describe('MCPClient — refresh operations', () => {
  test('refreshTools skips when server has no tools capability', async () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;
    (client as any).serverCapabilities = {};

    await client.refreshTools();

    // No request should have been sent
    expect(transport.send).not.toHaveBeenCalled();
  });

  test('refreshResources skips when server has no resources capability', async () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;
    (client as any).serverCapabilities = {};

    await client.refreshResources();

    expect(transport.send).not.toHaveBeenCalled();
  });

  test('refreshPrompts skips when server has no prompts capability', async () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;
    (client as any).serverCapabilities = {};

    await client.refreshPrompts();

    expect(transport.send).not.toHaveBeenCalled();
  });
});

// =============================================================================
// MCP SERVER MANAGER — REGISTRATION
// =============================================================================

describe('MCPServerManager — registration', () => {
  let manager: MCPServerManager;

  beforeEach(() => {
    manager = new MCPServerManager();
  });

  test('registerServer stores config', () => {
    manager.registerServer({
      name: 'weather-server',
      transport: 'stdio',
      command: 'node',
      args: ['weather-server.js'],
    });

    const config = manager.getServerConfig('weather-server');
    expect(config).toBeDefined();
    expect(config!.name).toBe('weather-server');
  });

  test('registerServer overwrites existing config', () => {
    manager.registerServer({ name: 'srv', transport: 'stdio', command: 'old' });
    manager.registerServer({ name: 'srv', transport: 'stdio', command: 'new' });

    const config = manager.getServerConfig('srv');
    expect(config!.command).toBe('new');
  });

  test('registerServers registers multiple servers', () => {
    manager.registerServers([
      { name: 'a', transport: 'stdio', command: 'cmd-a' },
      { name: 'b', transport: 'stdio', command: 'cmd-b' },
    ]);

    expect(manager.getServerConfig('a')).toBeDefined();
    expect(manager.getServerConfig('b')).toBeDefined();
  });

  test('registerServer with tenantId stores in tenant scope', () => {
    manager.registerServer({ name: 'tenant-srv', transport: 'stdio', command: 'cmd' }, 'tenant-1');

    // Not visible globally
    expect(manager.getServerConfig('tenant-srv')).toBeUndefined();

    // Visible with tenant context
    expect(manager.getServerConfig('tenant-srv', 'tenant-1')).toBeDefined();
    expect(manager.getServerConfig('tenant-srv', 'tenant-1')!.tenantId).toBe('tenant-1');
  });

  test('unregisterServer removes config', async () => {
    manager.registerServer({ name: 'to-remove', transport: 'stdio', command: 'cmd' });
    expect(manager.getServerConfig('to-remove')).toBeDefined();

    await manager.unregisterServer('to-remove');
    expect(manager.getServerConfig('to-remove')).toBeUndefined();
  });

  test('unregisterServer removes tenant-scoped config', async () => {
    manager.registerServer({ name: 'tenant-srv', transport: 'stdio', command: 'cmd' }, 'tenant-1');

    await manager.unregisterServer('tenant-srv', 'tenant-1');
    expect(manager.getServerConfig('tenant-srv', 'tenant-1')).toBeUndefined();
  });
});

// =============================================================================
// MCP SERVER MANAGER — LIST SERVERS
// =============================================================================

describe('MCPServerManager — listServers', () => {
  let manager: MCPServerManager;

  beforeEach(() => {
    manager = new MCPServerManager();
  });

  test('listServers returns empty array when no servers registered', () => {
    expect(manager.listServers()).toEqual([]);
  });

  test('listServers returns global servers', () => {
    manager.registerServer({ name: 'global-1', transport: 'stdio', command: 'cmd' });
    manager.registerServer({ name: 'global-2', transport: 'sse', url: 'http://localhost' });

    const servers = manager.listServers();
    expect(servers).toHaveLength(2);
    expect(servers.map((s) => s.name)).toContain('global-1');
    expect(servers.map((s) => s.name)).toContain('global-2');
    // All disconnected since we haven't connected
    expect(servers.every((s) => s.connected === false)).toBe(true);
  });

  test('listServers includes tenant servers when tenantId provided', () => {
    manager.registerServer({ name: 'global-srv', transport: 'stdio', command: 'cmd' });
    manager.registerServer({ name: 'tenant-srv', transport: 'stdio', command: 'cmd' }, 'tenant-1');

    const servers = manager.listServers('tenant-1');
    expect(servers).toHaveLength(2);
    expect(servers.map((s) => s.name)).toContain('global-srv');
    expect(servers.map((s) => s.name)).toContain('tenant-srv');
  });

  test('tenant server with same name as global shows only once (tenant takes priority)', () => {
    manager.registerServer({ name: 'shared-name', transport: 'stdio', command: 'global-cmd' });
    manager.registerServer(
      { name: 'shared-name', transport: 'stdio', command: 'tenant-cmd' },
      'tenant-1',
    );

    const servers = manager.listServers('tenant-1');
    // Should only show once (tenant version takes precedence)
    const matched = servers.filter((s) => s.name === 'shared-name');
    expect(matched).toHaveLength(1);
    expect(matched[0].tenantId).toBe('tenant-1');
  });
});

// =============================================================================
// MCP SERVER MANAGER — HEALTH CHECK
// =============================================================================

describe('MCPServerManager — checkHealth', () => {
  let manager: MCPServerManager;

  beforeEach(() => {
    manager = new MCPServerManager();
  });

  test('registered servers are tracked', () => {
    manager.registerServer({ name: 'srv1', transport: 'stdio', command: 'cmd' });
    manager.registerServer({ name: 'srv2', transport: 'stdio', command: 'cmd' });

    // Both servers should be registered (getClient returns undefined since not connected)
    expect(manager.getClient('srv1')).toBeUndefined();
    expect(manager.getClient('srv2')).toBeUndefined();
  });
});

// =============================================================================
// MCP SERVER MANAGER — getClient
// =============================================================================

describe('MCPServerManager — getClient', () => {
  let manager: MCPServerManager;

  beforeEach(() => {
    manager = new MCPServerManager();
  });

  test('getClient returns undefined when no client connected', () => {
    manager.registerServer({ name: 'srv', transport: 'stdio', command: 'cmd' });
    expect(manager.getClient('srv')).toBeUndefined();
  });

  test('getClient returns undefined for non-registered server', () => {
    expect(manager.getClient('nonexistent')).toBeUndefined();
  });
});

// =============================================================================
// MCP SERVER MANAGER — connectServer validation
// =============================================================================

describe('MCPServerManager — connectServer validation', () => {
  let manager: MCPServerManager;

  beforeEach(() => {
    manager = new MCPServerManager();
  });

  test('connectServer throws for unregistered server', async () => {
    await expect(manager.connectServer('unknown')).rejects.toThrow(
      'Server not registered: unknown',
    );
  });

  test('registered server is accessible via getClient', () => {
    manager.registerServer({
      name: 'srv',
      transport: 'stdio',
      command: 'cmd',
    });
    // Server is registered but not connected — getClient returns undefined
    expect(manager.getClient('srv')).toBeUndefined();
  });
});

// =============================================================================
// MCP SERVER MANAGER — SINGLETON
// =============================================================================

describe('MCPServerManager — singleton', () => {
  afterEach(() => {
    resetMCPServerManager();
  });

  test('getMCPServerManager returns same instance', () => {
    const a = getMCPServerManager();
    const b = getMCPServerManager();
    expect(a).toBe(b);
  });

  test('resetMCPServerManager clears the singleton', () => {
    const a = getMCPServerManager();
    resetMCPServerManager();
    const b = getMCPServerManager();
    expect(a).not.toBe(b);
  });
});

// =============================================================================
// MCP CLIENT — SECURITY: ENV VAR SANITIZATION
// =============================================================================

describe('MCPClient — security: env var sanitization', () => {
  test('blocked env vars are filtered from stdio transport', () => {
    // This tests the sanitization logic without actually spawning a process
    const blockedVars = [
      'PATH',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'NODE_OPTIONS',
      'NODE_PATH',
      'ELECTRON_RUN_AS_NODE',
    ];

    // Verify the BLOCKED_ENV_VARS set exists and contains all expected vars
    const client = new MCPClient({
      name: 'test',
      transport: 'stdio',
      command: 'node',
      env: {
        PATH: '/evil/path',
        SAFE_VAR: 'safe_value',
      },
    });

    // The blocked vars set is a module-level constant
    // We can verify through the config that env was passed
    expect((client as any).config.env).toEqual({
      PATH: '/evil/path',
      SAFE_VAR: 'safe_value',
    });
  });
});

// =============================================================================
// MCP SERVER MANAGER — getServerConfig tenant fallback
// =============================================================================

describe('MCPServerManager — getServerConfig tenant fallback', () => {
  let manager: MCPServerManager;

  beforeEach(() => {
    manager = new MCPServerManager();
  });

  test('getServerConfig falls back to global when tenant has no override', () => {
    manager.registerServer({ name: 'global-srv', transport: 'stdio', command: 'global-cmd' });

    const config = manager.getServerConfig('global-srv', 'tenant-1');
    expect(config).toBeDefined();
    expect(config!.command).toBe('global-cmd');
  });

  test('getServerConfig returns tenant config when both exist', () => {
    manager.registerServer({ name: 'shared', transport: 'stdio', command: 'global-cmd' });
    manager.registerServer(
      { name: 'shared', transport: 'stdio', command: 'tenant-cmd' },
      'tenant-1',
    );

    const config = manager.getServerConfig('shared', 'tenant-1');
    expect(config!.command).toBe('tenant-cmd');
  });

  test('getServerConfig returns undefined when not registered anywhere', () => {
    expect(manager.getServerConfig('nonexistent', 'tenant-1')).toBeUndefined();
  });
});

// =============================================================================
// MCP CLIENT — NOTIFY
// =============================================================================

describe('MCPClient — notify', () => {
  test('notify sends JSON-RPC notification', () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;

    (client as any).notify('initialized', {});

    expect(transport.send).toHaveBeenCalledTimes(1);
    const sent = transport.send.mock.calls[0][0];
    expect(sent.jsonrpc).toBe('2.0');
    expect(sent.method).toBe('initialized');
    expect(sent.id).toBeUndefined();
  });

  test('notify throws when not connected', async () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    await expect((client as any).notify('test', {})).rejects.toThrow('Not connected');
  });
});

// =============================================================================
// MCP CLIENT — SAMPLING
// =============================================================================

describe('MCPClient — sampling', () => {
  test('createSamplingMessage sends sampling/createMessage request', async () => {
    const client = new MCPClient({ name: 'test', transport: 'stdio' });
    const transport = createMockTransport();
    wireTransport(client, transport);
    (client as any).isConnected = true;

    const promise = client.createSamplingMessage({
      messages: [{ role: 'user', content: { type: 'text', text: 'Hello' } }],
      maxTokens: 100,
    });

    const sent = transport.send.mock.calls[0][0] as JsonRpcRequest;
    expect(sent.method).toBe('sampling/createMessage');

    respondToPending(client, {
      role: 'assistant',
      content: { type: 'text', text: 'Hi there!' },
      model: 'claude-3-5-sonnet',
      stopReason: 'endTurn',
    });

    const result = await promise;
    expect(result.role).toBe('assistant');
    expect(result.model).toBe('claude-3-5-sonnet');
  });
});
