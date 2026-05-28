import { describe, it, expect } from 'vitest';
import { toToolDefinition, type ResolvedToolImpl } from '../tools/resolve-tool-implementations.js';

describe('toToolDefinition', () => {
  it('should parse parameters and returns from dslContent signature', () => {
    const resolved: ResolvedToolImpl = {
      name: 'get_user',
      toolType: 'http',
      projectToolId: '123',
      sourceHash: 'abc',
      description: 'Get user details',
      dslContent:
        'get_user(userId: string, includeProfile?: boolean) -> {name: string, email: string}\n  endpoint: https://api.example.com/users/{userId}\n  method: GET',
      httpBinding: {
        endpoint: 'https://api.example.com/users/{userId}',
        method: 'GET',
        auth: { type: 'none' },
      },
    };
    const td = toToolDefinition(resolved);
    expect(td.parameters).toEqual([
      { name: 'userId', type: 'string', required: true },
      { name: 'includeProfile', type: 'boolean', required: false },
    ]);
    expect(td.returns).toEqual({
      type: 'object',
      fields: {
        name: { type: 'string' },
        email: { type: 'string' },
      },
    });
    expect(td.tool_type).toBe('http');
    expect(td.http_binding).toBeDefined();
    expect(td.hints.side_effects).toBe(false); // GET
    expect(td.hints.requires_auth).toBe(false);
  });

  it('should handle tools with no parameters', () => {
    const resolved: ResolvedToolImpl = {
      name: 'health_check',
      toolType: 'http',
      projectToolId: '456',
      sourceHash: 'def',
      description: null,
      dslContent:
        'health_check() -> string\n  endpoint: https://api.example.com/health\n  method: GET',
      httpBinding: {
        endpoint: 'https://api.example.com/health',
        method: 'GET',
        auth: { type: 'none' },
      },
    };
    const td = toToolDefinition(resolved);
    expect(td.parameters).toEqual([]);
    expect(td.description).toBe('');
    expect(td.returns).toEqual({ type: 'string' });
  });

  it('should detect side_effects for non-GET methods', () => {
    const resolved: ResolvedToolImpl = {
      name: 'create_user',
      toolType: 'http',
      projectToolId: '789',
      sourceHash: 'ghi',
      description: 'Create a user',
      dslContent:
        'create_user(name: string, email: string) -> {id: string}\n  endpoint: https://api.example.com/users\n  method: POST',
      httpBinding: {
        endpoint: 'https://api.example.com/users',
        method: 'POST',
        auth: { type: 'none' },
      },
    };
    const td = toToolDefinition(resolved);
    expect(td.hints.side_effects).toBe(true); // POST
  });

  it('should detect requires_auth when auth is set', () => {
    const resolved: ResolvedToolImpl = {
      name: 'secure_endpoint',
      toolType: 'http',
      projectToolId: 'aaa',
      sourceHash: 'bbb',
      description: 'Secured endpoint',
      dslContent:
        'secure_endpoint(query: string) -> object\n  endpoint: https://api.example.com/secure\n  method: GET\n  auth: bearer',
      httpBinding: {
        endpoint: 'https://api.example.com/secure',
        method: 'GET',
        auth: { type: 'bearer' },
      },
    };
    const td = toToolDefinition(resolved);
    expect(td.hints.requires_auth).toBe(true);
  });

  it('should handle sandbox tools', () => {
    const resolved: ResolvedToolImpl = {
      name: 'run_calc',
      toolType: 'sandbox',
      projectToolId: 'ccc',
      sourceHash: 'ddd',
      description: 'Run calculation',
      dslContent:
        'run_calc(expression: string) -> number\n  runtime: javascript\n  code: |\n    return eval(expression);',
      sandboxBinding: {
        runtime: 'javascript',
        code_content: 'return eval(expression);',
      },
    };
    const td = toToolDefinition(resolved);
    expect(td.tool_type).toBe('sandbox');
    expect(td.sandbox_binding).toBeDefined();
    expect(td.http_binding).toBeUndefined();
    expect(td.mcp_binding).toBeUndefined();
    expect(td.parameters).toEqual([{ name: 'expression', type: 'string', required: true }]);
  });

  it('should handle mcp tools', () => {
    const resolved: ResolvedToolImpl = {
      name: 'mcp_search',
      toolType: 'mcp',
      projectToolId: 'eee',
      sourceHash: 'fff',
      description: 'MCP search tool',
      dslContent: 'mcp_search(query: string) -> object\n  server: my-server\n  server_tool: search',
      mcpBinding: {
        server: 'my-server',
        tool: 'search',
      },
    };
    const td = toToolDefinition(resolved);
    expect(td.tool_type).toBe('mcp');
    expect(td.mcp_binding).toBeDefined();
    expect(td.http_binding).toBeUndefined();
    expect(td.sandbox_binding).toBeUndefined();
  });

  it('should parse structured object return type', () => {
    const resolved: ResolvedToolImpl = {
      name: 'create_order',
      toolType: 'http',
      projectToolId: 'zzz',
      sourceHash: 'yyy',
      description: 'Create order',
      dslContent:
        'create_order(item: string, qty?: number) -> {orderId: string, total?: number}\n  endpoint: https://api.example.com/orders\n  method: POST',
      httpBinding: {
        endpoint: 'https://api.example.com/orders',
        method: 'POST',
        auth: { type: 'none' },
      },
    };
    const td = toToolDefinition(resolved);
    expect(td.returns).toEqual({
      type: 'object',
      fields: {
        orderId: { type: 'string' },
        total: { type: 'number', optional: true },
      },
    });
  });

  it('should parse array return type', () => {
    const resolved: ResolvedToolImpl = {
      name: 'list_names',
      toolType: 'http',
      projectToolId: 'xxx',
      sourceHash: 'www',
      description: 'List names',
      dslContent:
        'list_names() -> string[]\n  endpoint: https://api.example.com/names\n  method: GET',
      httpBinding: {
        endpoint: 'https://api.example.com/names',
        method: 'GET',
        auth: { type: 'none' },
      },
    };
    const td = toToolDefinition(resolved);
    expect(td.returns).toEqual({
      type: 'array',
      items: { type: 'string' },
    });
  });

  it('should include timeout in hints when specified', () => {
    const resolved: ResolvedToolImpl = {
      name: 'slow_tool',
      toolType: 'http',
      projectToolId: 'ggg',
      sourceHash: 'hhh',
      description: 'Slow tool',
      dslContent:
        'slow_tool() -> object\n  endpoint: https://api.example.com/slow\n  method: GET\n  timeout: 30000',
      httpBinding: {
        endpoint: 'https://api.example.com/slow',
        method: 'GET',
        auth: { type: 'none' },
        timeout_ms: 30000,
      },
    };
    const td = toToolDefinition(resolved);
    expect(td.hints.timeout).toBe(30000);
  });
});
