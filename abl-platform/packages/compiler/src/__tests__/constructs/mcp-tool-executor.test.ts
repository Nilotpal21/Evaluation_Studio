import { describe, it, expect, vi } from 'vitest';
import {
  McpToolExecutor,
  _resolveContextPlaceholdersForTest as resolveContextPlaceholders,
  _resolveSessionPlaceholdersForTest as resolveSessionPlaceholders,
} from '../../platform/constructs/executors/mcp-tool-executor.js';
import { ToolExecutionError } from '@agent-platform/shared';
import type {
  McpClientProvider,
  McpClient,
} from '../../platform/constructs/executors/mcp-tool-executor.js';
import type { ToolDefinition } from '../../platform/ir/schema.js';

function createMcpTool(
  name: string,
  server: string,
  toolName: string,
  headers?: Record<string, string>,
): ToolDefinition {
  return {
    name,
    description: `MCP tool: ${name}`,
    parameters: [{ name: 'input', type: 'string', required: true }],
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'slow',
      parallelizable: false,
      side_effects: true,
      requires_auth: false,
    },
    tool_type: 'mcp',
    mcp_binding: { server, tool: toolName, headers },
  };
}

describe('McpToolExecutor', () => {
  it('should dispatch to correct MCP server and tool', async () => {
    const mockClient: McpClient = {
      callTool: vi.fn().mockResolvedValue({ temp: 72, conditions: 'sunny' }),
    };
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mockClient),
    };

    const executor = new McpToolExecutor({
      tools: [createMcpTool('get_weather', 'weather-service', 'get_current_weather')],
      mcpClients: mockProvider,
    });

    const result = await executor.execute('get_weather', { location: 'NYC' }, 5000);
    expect(result).toEqual({ temp: 72, conditions: 'sunny' });
    expect(mockProvider.getClient).toHaveBeenCalledWith('weather-service', undefined);
    expect(mockClient.callTool).toHaveBeenCalledWith(
      'get_current_weather',
      { location: 'NYC' },
      undefined,
    );
  });

  it('should throw for non-existent MCP tool', async () => {
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new McpToolExecutor({ tools: [], mcpClients: mockProvider });
    await expect(executor.execute('nonexistent', {}, 5000)).rejects.toThrow('MCP tool not found');
  });

  it('should throw when MCP server is unavailable', async () => {
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(undefined),
    };
    const executor = new McpToolExecutor({
      tools: [createMcpTool('get_weather', 'weather-service', 'get_current_weather')],
      mcpClients: mockProvider,
    });
    await expect(executor.execute('get_weather', {}, 5000)).rejects.toThrow(
      'MCP server not available',
    );
  });

  it('should resolve {{secrets.X}} placeholders in MCP tool params', async () => {
    const mockClient: McpClient = {
      callTool: vi.fn().mockResolvedValue({ status: 'ok' }),
    };
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mockClient),
    };

    const executor = new McpToolExecutor({
      tools: [createMcpTool('send_msg', 'slack-server', 'send_message')],
      mcpClients: mockProvider,
      secrets: {
        async getSecret(key: string) {
          if (key === 'SLACK_TOKEN') return 'xoxb-resolved-token';
          return undefined;
        },
      },
    });

    await executor.execute('send_msg', { token: '{{secrets.SLACK_TOKEN}}', text: 'hello' }, 5000);
    expect(mockClient.callTool).toHaveBeenCalledWith(
      'send_message',
      { token: 'xoxb-resolved-token', text: 'hello' },
      undefined,
    );
  });

  it('should resolve {{env.X}} placeholders in MCP tool params', async () => {
    const mockClient: McpClient = {
      callTool: vi.fn().mockResolvedValue({ status: 'ok' }),
    };
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mockClient),
    };

    const executor = new McpToolExecutor({
      tools: [createMcpTool('query', 'db-server', 'run_query')],
      mcpClients: mockProvider,
      secrets: {
        async getSecret() {
          return undefined;
        },
        async getEnvVar(key: string) {
          if (key === 'DB_HOST') return 'prod-db.example.com';
          return undefined;
        },
      },
    });

    await executor.execute('query', { host: '{{env.DB_HOST}}', sql: 'SELECT 1' }, 5000);
    expect(mockClient.callTool).toHaveBeenCalledWith(
      'run_query',
      { host: 'prod-db.example.com', sql: 'SELECT 1' },
      undefined,
    );
  });

  it('should resolve placeholders in nested MCP params', async () => {
    const mockClient: McpClient = {
      callTool: vi.fn().mockResolvedValue({ ok: true }),
    };
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mockClient),
    };

    const executor = new McpToolExecutor({
      tools: [createMcpTool('create_item', 'api-server', 'create')],
      mcpClients: mockProvider,
      secrets: {
        async getSecret(key: string) {
          if (key === 'API_KEY') return 'secret-key';
          return undefined;
        },
      },
    });

    await executor.execute(
      'create_item',
      {
        auth: { key: '{{secrets.API_KEY}}' },
        items: ['{{secrets.API_KEY}}', 'plain'],
      },
      5000,
    );
    expect(mockClient.callTool).toHaveBeenCalledWith(
      'create',
      { auth: { key: 'secret-key' }, items: ['secret-key', 'plain'] },
      undefined,
    );
  });

  it('should resolve {{_context.X}} placeholders in mcp_binding.headers', async () => {
    const mockClient: McpClient = {
      callTool: vi.fn().mockResolvedValue({ events: [] }),
    };
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mockClient),
    };

    const executor = new McpToolExecutor({
      tools: [
        createMcpTool('find_events', 'calendar-server', 'find_events', {
          Authorization: 'Bearer {{_context.token}}',
          'X-Tenant': '{{session.tenantId}}',
        }),
      ],
      mcpClients: mockProvider,
    });

    await executor.execute(
      'find_events',
      {
        query: 'meetings',
        _context: { token: 'ctx-token-abc' },
        _session: { tenantId: 'tenant-001' },
      },
      5000,
    );

    // Verify headers were resolved and passed
    expect(mockClient.callTool).toHaveBeenCalledWith(
      'find_events',
      { query: 'meetings' }, // _context and _session stripped from params
      { Authorization: 'Bearer ctx-token-abc', 'X-Tenant': 'tenant-001' },
    );
  });

  it('should resolve nested dot-path {{_context.session.token}} in headers', async () => {
    const mockClient: McpClient = {
      callTool: vi.fn().mockResolvedValue({ ok: true }),
    };
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mockClient),
    };

    const executor = new McpToolExecutor({
      tools: [
        createMcpTool('send_email', 'email-server', 'send', {
          auth: '{{_context.session.sessionToken}}',
        }),
      ],
      mcpClients: mockProvider,
    });

    await executor.execute(
      'send_email',
      {
        to: 'user@test.com',
        _context: { session: { sessionToken: 'nested-token-123', userId: 'u1' } },
      },
      5000,
    );

    expect(mockClient.callTool).toHaveBeenCalledWith(
      'send',
      { to: 'user@test.com' },
      { auth: 'nested-token-123' },
    );
  });

  it('should strip CRLF from resolved header values', async () => {
    const mockClient: McpClient = {
      callTool: vi.fn().mockResolvedValue({ ok: true }),
    };
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mockClient),
    };

    const executor = new McpToolExecutor({
      tools: [
        createMcpTool('test_tool', 'server', 'test', {
          'X-Custom': '{{_context.injected}}',
        }),
      ],
      mcpClients: mockProvider,
    });

    await executor.execute(
      'test_tool',
      { _context: { injected: 'value\r\nEvil-Header: injected' } },
      5000,
    );

    expect(mockClient.callTool).toHaveBeenCalledWith(
      'test',
      {},
      { 'X-Custom': 'valueEvil-Header: injected' },
    );
  });

  it('should pass undefined headers when mcp_binding has no headers', async () => {
    const mockClient: McpClient = {
      callTool: vi.fn().mockResolvedValue({ ok: true }),
    };
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mockClient),
    };

    const executor = new McpToolExecutor({
      tools: [createMcpTool('no_headers', 'server', 'tool')], // no headers
      mcpClients: mockProvider,
    });

    await executor.execute('no_headers', { input: 'test' }, 5000);
    expect(mockClient.callTool).toHaveBeenCalledWith('tool', { input: 'test' }, undefined);
  });

  it('retries once when in-flight call receives AUTH_REFRESH_RECONNECT envelope', async () => {
    const reconnectEnvelope = JSON.stringify({
      code: 'AUTH_REFRESH_RECONNECT',
      reconnectAfterMs: 1,
      message: 'Reconnect in progress',
    });
    const mockClient: McpClient = {
      callTool: vi
        .fn()
        .mockRejectedValueOnce(new Error(reconnectEnvelope))
        .mockResolvedValueOnce({ ok: true }),
    };
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mockClient),
    };
    const executor = new McpToolExecutor({
      tools: [createMcpTool('get_weather', 'weather-service', 'get_current_weather')],
      mcpClients: mockProvider,
    });

    const result = await executor.execute('get_weather', { location: 'NYC' }, 5000);
    expect(result).toEqual({ ok: true });
    expect(mockClient.callTool).toHaveBeenCalledTimes(2);
  });

  it('surfaces AUTH_REFRESH_RECONNECT envelope when reconnect retry is exhausted', async () => {
    const reconnectEnvelope = JSON.stringify({
      code: 'AUTH_REFRESH_RECONNECT',
      reconnectAfterMs: 1,
      message: 'Reconnect in progress',
    });
    const mockClient: McpClient = {
      callTool: vi.fn().mockRejectedValue(new Error(reconnectEnvelope)),
    };
    const mockProvider: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mockClient),
    };
    const executor = new McpToolExecutor({
      tools: [createMcpTool('get_weather', 'weather-service', 'get_current_weather')],
      mcpClients: mockProvider,
    });

    let thrown: unknown;
    try {
      await executor.execute('get_weather', { location: 'NYC' }, 5000);
    } catch (err) {
      thrown = err;
    }

    expect(mockClient.callTool).toHaveBeenCalledTimes(2);
    expect(thrown).toBeInstanceOf(ToolExecutionError);

    const reconnectError = thrown as ToolExecutionError;
    expect(reconnectError.code).toBe('TOOL_NETWORK_ERROR');
    const parsedMessage = JSON.parse(reconnectError.message) as Record<string, unknown>;
    expect(parsedMessage.code).toBe('AUTH_REFRESH_RECONNECT');
    expect(parsedMessage.reconnectAfterMs).toBe(1);
    expect(parsedMessage.toolName).toBe('get_weather');
  });
});

describe('resolveContextPlaceholders', () => {
  it('should resolve single-level keys', () => {
    expect(resolveContextPlaceholders('Bearer {{_context.token}}', { token: 'abc' })).toBe(
      'Bearer abc',
    );
  });

  it('should resolve nested dot-path keys', () => {
    const ctx = { session: { auth: { token: 'deep' } } };
    expect(resolveContextPlaceholders('{{_context.session.auth.token}}', ctx)).toBe('deep');
  });

  it('should return empty string for missing keys', () => {
    expect(resolveContextPlaceholders('{{_context.missing}}', { other: 'x' })).toBe('');
  });

  it('should return value unchanged when no context vars', () => {
    expect(resolveContextPlaceholders('{{_context.key}}', undefined)).toBe('{{_context.key}}');
  });
});

describe('resolveSessionPlaceholders', () => {
  it('should resolve session keys', () => {
    expect(resolveSessionPlaceholders('{{session.tenantId}}', { tenantId: 't1' })).toBe('t1');
  });

  it('should return empty string for missing session keys', () => {
    expect(resolveSessionPlaceholders('{{session.missing}}', { id: 's1' })).toBe('');
  });
});
