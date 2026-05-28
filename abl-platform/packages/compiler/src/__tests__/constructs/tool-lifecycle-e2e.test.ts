/**
 * Tool Lifecycle End-to-End Tests
 *
 * Exercises the full tool pipeline through ToolBindingExecutor for each
 * tool type (HTTP, MCP, Sandbox) including enterprise-readiness concerns:
 * - Tenant isolation (breakers, caches, secrets)
 * - Security (SSRF, header injection, path traversal, error sanitization)
 * - Resilience (circuit breakers, retries, rate limiting, timeouts)
 * - Observability (audit logging, trace integration, middleware chain)
 * - Parallel execution and concurrency limiting
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the DNS-pinning safeFetch to delegate to globalThis.fetch so tests
// that stub `globalThis.fetch` continue to work without requiring real DNS.
const mockSafeFetch = vi.hoisted(() => vi.fn());
const mockAssertUrlSafeForFetch = vi.hoisted(() => vi.fn());
vi.mock('@agent-platform/shared-kernel/security/safe-fetch', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@agent-platform/shared-kernel/security/safe-fetch')>();
  return {
    ...actual,
    assertUrlSafeForFetch: mockAssertUrlSafeForFetch,
    safeFetch: mockSafeFetch,
  };
});

beforeEach(async () => {
  // Apply real SSRF URL-shape validation (synchronous: rejects literal
  // private IPs, metadata addresses, decimal-encoded bypasses) but skip DNS
  // resolution so test hostnames like api.example.com don't require network.
  const { validateUrlForSSRF } = await import('@agent-platform/shared-kernel/security');
  const { SSRFError } = await import('@agent-platform/shared-kernel/security/safe-fetch');
  mockAssertUrlSafeForFetch.mockReset().mockImplementation(async (url: string | URL) => {
    const result = validateUrlForSSRF(typeof url === 'string' ? url : url.toString());
    if (!result.safe) {
      throw new SSRFError(result.reason ?? 'URL blocked by SSRF protection', {
        url: typeof url === 'string' ? url : url.toString(),
        reason: result.reason,
      });
    }
  });
  mockSafeFetch
    .mockReset()
    .mockImplementation((url: string | URL, init?: RequestInit) => globalThis.fetch(url, init));
});

import { ToolBindingExecutor } from '../../platform/constructs/executors/tool-binding-executor.js';
import type { ToolDefinition, HttpBindingIR } from '../../platform/ir/schema.js';
import type { SecretsProvider } from '../../platform/constructs/executors/secrets-provider.js';
import type {
  McpClientProvider,
  McpClient,
} from '../../platform/constructs/executors/mcp-tool-executor.js';
import type { SandboxRunner } from '../../platform/constructs/executors/sandbox-tool-executor.js';
import type {
  ResilienceFactory,
  ICircuitBreaker,
  IRateLimiter,
} from '../../platform/constructs/executors/resilience-interfaces.js';
import type {
  ToolMiddleware,
  ToolCallContext,
  ToolCallResult,
} from '../../platform/constructs/executors/tool-middleware.js';

// =============================================================================
// SHARED TEST FIXTURES
// =============================================================================

const defaultHints = {
  cacheable: false,
  latency: 'medium' as const,
  parallelizable: false,
  side_effects: true,
  requires_auth: false,
};

function getHeaderValue(
  headers: RequestInit['headers'] | undefined,
  name: string,
): string | undefined {
  return new Headers(headers ?? {}).get(name) ?? undefined;
}

function createHttpTool(
  name: string,
  overrides: Partial<ToolDefinition> & { http_binding?: Partial<HttpBindingIR> } = {},
): ToolDefinition {
  const { http_binding: httpOverrides, ...toolOverrides } = overrides;
  return {
    name,
    description: `HTTP tool: ${name}`,
    parameters: [{ name: 'query', type: 'string', required: true }],
    returns: { type: 'object' },
    hints: defaultHints,
    tool_type: 'http',
    http_binding: {
      endpoint: 'https://api.example.com/v1/search',
      method: 'POST',
      auth: { type: 'none' },
      timeout_ms: 5000,
      ...httpOverrides,
    },
    ...toolOverrides,
  };
}

function createMcpTool(name: string, server: string, tool: string): ToolDefinition {
  return {
    name,
    description: `MCP tool: ${name}`,
    parameters: [{ name: 'input', type: 'string', required: true }],
    returns: { type: 'object' },
    hints: defaultHints,
    tool_type: 'mcp',
    mcp_binding: { server, tool },
  };
}

function createSandboxTool(
  name: string,
  runtime: 'javascript' | 'python',
  codeContent: string,
): ToolDefinition {
  return {
    name,
    description: `Sandbox tool: ${name}`,
    parameters: [{ name: 'data', type: 'object', required: true }],
    returns: { type: 'object' },
    hints: defaultHints,
    tool_type: 'sandbox',
    sandbox_binding: { runtime, code_content: codeContent, timeout_ms: 5000, memory_mb: 128 },
  };
}

function createMockSecrets(overrides: Record<string, string> = {}): SecretsProvider {
  return {
    async getSecret(key: string) {
      return overrides[key];
    },
  };
}

function mockJsonResponse(data: unknown, status = 200, headers?: Record<string, string>): Response {
  const body = JSON.stringify(data);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: new Headers({
      'content-type': 'application/json',
      'content-length': String(body.length),
      ...headers,
    }),
    text: async () => body,
    json: async () => data,
    body: null,
  } as unknown as Response;
}

// =============================================================================
// HTTP TOOL E2E TESTS
// =============================================================================

describe('HTTP Tool E2E', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  describe('Full lifecycle: ToolBindingExecutor → HttpToolExecutor → fetch', () => {
    it('should execute a POST tool and return parsed JSON through the full pipeline', async () => {
      const tool = createHttpTool('search_api');
      const fetchMock = vi
        .fn()
        .mockResolvedValue(mockJsonResponse({ results: [{ id: 1, title: 'Result' }] }));
      vi.stubGlobal('fetch', fetchMock);

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets(),
        sessionContext: { tenantId: 'tenant-1', sessionId: 'sess-1', userId: 'user-1' },
      });

      const result = await executor.execute('search_api', { query: 'test search' }, 5000);
      expect(result).toEqual({ results: [{ id: 1, title: 'Result' }] });

      // Verify fetch was called with correct params
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, init] = fetchMock.mock.calls[0];
      expect(url).toBe('https://api.example.com/v1/search');
      expect(init.method).toBe('POST');
      expect(JSON.parse(init.body)).toEqual({ query: 'test search' });
    });

    it('should execute a GET tool with path parameter substitution', async () => {
      const tool = createHttpTool('get_user', {
        http_binding: {
          endpoint: 'https://api.example.com/users/{userId}',
          method: 'GET',
          auth: { type: 'none' },
        },
        parameters: [{ name: 'userId', type: 'string', required: true }],
      });
      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ id: 'u123', name: 'Alice' }));
      vi.stubGlobal('fetch', fetchMock);

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets(),
      });

      const result = await executor.execute('get_user', { userId: 'u123' }, 5000);
      expect(result).toEqual({ id: 'u123', name: 'Alice' });
      expect(fetchMock.mock.calls[0][0]).toBe('https://api.example.com/users/u123');
    });

    it('should apply Bearer auth from secrets', async () => {
      const tool = createHttpTool('auth_api', {
        http_binding: {
          endpoint: 'https://api.example.com/protected',
          method: 'GET',
          auth: { type: 'bearer' },
          headers: { Authorization: '{{secrets.bearer_token}}' },
        },
      });
      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
      vi.stubGlobal('fetch', fetchMock);

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets({ bearer_token: 'my-secret-token' }),
      });

      await executor.execute('auth_api', { query: 'test' }, 5000);

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(getHeaderValue(headers, 'Authorization')).toContain('my-secret-token');
    });

    it('should apply API key auth via custom header', async () => {
      const tool = createHttpTool('apikey_api', {
        http_binding: {
          endpoint: 'https://api.example.com/data',
          method: 'GET',
          auth: { type: 'api_key', config: { headerName: 'X-Api-Key' } },
          headers: { 'X-Api-Key': '{{secrets.api_key_token}}' },
        },
      });
      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ data: [] }));
      vi.stubGlobal('fetch', fetchMock);

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets({ api_key_token: 'key-12345' }),
      });

      await executor.execute('apikey_api', { query: 'test' }, 5000);

      const headers = fetchMock.mock.calls[0][1].headers;
      expect(getHeaderValue(headers, 'X-Api-Key')).toBe('key-12345');
    });
  });

  describe('SSRF protection through ToolBindingExecutor', () => {
    it('should block private IP in endpoint', async () => {
      const tool = createHttpTool('evil_api', {
        http_binding: {
          endpoint: 'http://192.168.1.1/admin',
          method: 'GET',
          auth: { type: 'none' },
        },
      });

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets(),
      });

      await expect(executor.execute('evil_api', { query: 'x' }, 5000)).rejects.toThrow(
        /Blocked|private/i,
      );
    });

    it('should block cloud metadata endpoint', async () => {
      const tool = createHttpTool('metadata_api', {
        http_binding: {
          endpoint: 'http://169.254.169.254/latest/meta-data',
          method: 'GET',
          auth: { type: 'none' },
        },
      });

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets(),
      });

      await expect(executor.execute('metadata_api', { query: 'x' }, 5000)).rejects.toThrow(/SSRF/i);
    });

    it('should block localhost', async () => {
      const tool = createHttpTool('local_api', {
        http_binding: {
          endpoint: 'http://localhost:8080/secret',
          method: 'GET',
          auth: { type: 'none' },
        },
      });

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets(),
      });

      await expect(executor.execute('local_api', { query: 'x' }, 5000)).rejects.toThrow(/SSRF/i);
    });

    it('should block decimal-encoded IP bypass (2130706433 = 127.0.0.1)', async () => {
      const tool = createHttpTool('decimal_bypass', {
        http_binding: {
          endpoint: 'http://2130706433/',
          method: 'GET',
          auth: { type: 'none' },
        },
      });

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets(),
      });

      await expect(executor.execute('decimal_bypass', { query: 'x' }, 5000)).rejects.toThrow(
        /SSRF/i,
      );
    });

    it('should block userinfo bypass (evil@169.254.169.254)', async () => {
      const tool = createHttpTool('userinfo_bypass', {
        http_binding: {
          endpoint: 'http://evil.com@169.254.169.254/latest',
          method: 'GET',
          auth: { type: 'none' },
        },
      });

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets(),
      });

      await expect(executor.execute('userinfo_bypass', { query: 'x' }, 5000)).rejects.toThrow(
        /userinfo|Blocked/,
      );
    });
  });

  describe('Header injection protection', () => {
    it('should strip CRLF from header values including parameter-derived ones', async () => {
      const tool = createHttpTool('header_inject', {
        http_binding: {
          endpoint: 'https://api.example.com/safe',
          method: 'POST',
          auth: { type: 'none' },
          headers: { 'X-Custom': 'value\r\nX-Injected: malicious' },
        },
      });
      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
      vi.stubGlobal('fetch', fetchMock);

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets(),
      });

      await executor.execute('header_inject', { query: 'test' }, 5000);

      const headers = fetchMock.mock.calls[0][1].headers;
      // CRLF should be stripped — no injected header
      expect(getHeaderValue(headers, 'X-Custom')).not.toContain('\r');
      expect(getHeaderValue(headers, 'X-Custom')).not.toContain('\n');
    });
  });

  describe('Retry and circuit breaker through ToolBindingExecutor', () => {
    it('should retry on transient failure then succeed', async () => {
      const tool = createHttpTool('retry_api', {
        http_binding: {
          endpoint: 'https://api.example.com/flaky',
          method: 'GET',
          auth: { type: 'none' },
          retry: { count: 2, delay_ms: 10 },
        },
      });

      let callCount = 0;
      const fetchMock = vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('ECONNRESET');
        return mockJsonResponse({ ok: true });
      });
      vi.stubGlobal('fetch', fetchMock);

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets(),
      });

      const result = await executor.execute('retry_api', { query: 'test' }, 10000);
      expect(result).toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(2);
    });

    it('should trip circuit breaker after threshold and reject subsequent calls', async () => {
      const tool = createHttpTool('breaker_api', {
        http_binding: {
          endpoint: 'https://api.example.com/fail',
          method: 'GET',
          auth: { type: 'none' },
          circuit_breaker: { threshold: 1, reset_ms: 60000 },
        },
      });

      const fetchMock = vi.fn().mockRejectedValue(new Error('Connection refused'));
      vi.stubGlobal('fetch', fetchMock);

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets(),
      });

      // First call fails and trips breaker
      await expect(executor.execute('breaker_api', { query: 'x' }, 5000)).rejects.toThrow();

      // Second call rejected by circuit breaker
      await expect(executor.execute('breaker_api', { query: 'y' }, 5000)).rejects.toThrow(
        /circuit breaker/i,
      );
    });
  });

  describe('Response size limits', () => {
    it('should gracefully truncate oversized responses', async () => {
      const tool = createHttpTool('large_api');
      const fetchMock = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({
          'content-type': 'application/json',
          'content-length': '20000000', // 20MB
        }),
        text: async () => 'x'.repeat(20_000_000),
        body: null,
      } as unknown as Response);
      vi.stubGlobal('fetch', fetchMock);

      const executor = new ToolBindingExecutor({
        tools: [tool],
        secrets: createMockSecrets(),
      });

      // Fix 6: readBoundedResponse now returns truncated data instead of throwing
      const result = await executor.execute('large_api', { query: 'x' }, 5000);
      expect(result).toBeDefined();
      const resultObj = result as Record<string, unknown>;
      expect(resultObj.truncated).toBe(true);
      expect(typeof resultObj.warning).toBe('string');
    });
  });
});

// =============================================================================
// MCP TOOL E2E TESTS
// =============================================================================

describe('MCP Tool E2E', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function createMockMcpProvider(clientMap: Record<string, McpClient>): McpClientProvider {
    return {
      getClient: vi.fn().mockImplementation(async (serverName: string) => clientMap[serverName]),
    };
  }

  describe('Full lifecycle: ToolBindingExecutor → McpToolExecutor → McpClient', () => {
    it('should route MCP tool call through to the correct server and tool', async () => {
      const mockClient: McpClient = {
        callTool: vi.fn().mockResolvedValue({ weather: 'sunny', temp: 72 }),
      };
      const mcpClients = createMockMcpProvider({ 'weather-service': mockClient });

      const executor = new ToolBindingExecutor({
        tools: [createMcpTool('get_weather', 'weather-service', 'current_weather')],
        secrets: createMockSecrets(),
        mcpClients,
        sessionContext: { tenantId: 'tenant-1', sessionId: 'sess-1' },
      });

      const result = await executor.execute('get_weather', { input: 'NYC' }, 5000);
      expect(result).toEqual({ weather: 'sunny', temp: 72 });
      expect(mockClient.callTool).toHaveBeenCalledWith(
        'current_weather',
        { input: 'NYC' },
        undefined,
      );
    });

    it('should handle multiple MCP tools on different servers', async () => {
      const weatherClient: McpClient = {
        callTool: vi.fn().mockResolvedValue({ temp: 72 }),
      };
      const dbClient: McpClient = {
        callTool: vi.fn().mockResolvedValue({ rows: [{ id: 1 }] }),
      };

      const mcpClients = createMockMcpProvider({
        'weather-mcp': weatherClient,
        'database-mcp': dbClient,
      });

      const executor = new ToolBindingExecutor({
        tools: [
          createMcpTool('get_weather', 'weather-mcp', 'current_weather'),
          createMcpTool('query_db', 'database-mcp', 'execute_query'),
        ],
        secrets: createMockSecrets(),
        mcpClients,
      });

      const weather = await executor.execute('get_weather', { input: 'NYC' }, 5000);
      expect(weather).toEqual({ temp: 72 });

      const db = await executor.execute('query_db', { input: 'SELECT 1' }, 5000);
      expect(db).toEqual({ rows: [{ id: 1 }] });
    });

    it('should fail when MCP server is unavailable', async () => {
      const mcpClients = createMockMcpProvider({});

      const executor = new ToolBindingExecutor({
        tools: [createMcpTool('missing_tool', 'missing-server', 'some_tool')],
        secrets: createMockSecrets(),
        mcpClients,
      });

      await expect(executor.execute('missing_tool', { input: 'x' }, 5000)).rejects.toThrow(
        /not available|not found/i,
      );
    });
  });

  describe('MCP circuit breaker tenant isolation', () => {
    it('should namespace circuit breaker keys by tenantId', async () => {
      const failClient: McpClient = {
        callTool: vi.fn().mockRejectedValue(new Error('MCP server error')),
      };
      const mcpClients = createMockMcpProvider({ 'flaky-server': failClient });

      // Breaker for tenant-A
      const executorA = new ToolBindingExecutor({
        tools: [createMcpTool('flaky_tool', 'flaky-server', 'do_thing')],
        secrets: createMockSecrets(),
        mcpClients,
        sessionContext: { tenantId: 'tenant-A' },
        resilienceFactory: createTestResilienceFactory(),
      });

      // Trip the breaker for tenant-A
      await expect(executorA.execute('flaky_tool', { input: 'x' }, 1000)).rejects.toThrow();

      // Tenant-B should NOT be affected (separate breaker)
      const okClient: McpClient = {
        callTool: vi.fn().mockResolvedValue({ ok: true }),
      };
      const mcpClientsB = createMockMcpProvider({ 'flaky-server': okClient });

      const executorB = new ToolBindingExecutor({
        tools: [createMcpTool('flaky_tool', 'flaky-server', 'do_thing')],
        secrets: createMockSecrets(),
        mcpClients: mcpClientsB,
        sessionContext: { tenantId: 'tenant-B' },
        resilienceFactory: createTestResilienceFactory(),
      });

      // Tenant-B should still work (their breaker is separate)
      const result = await executorB.execute('flaky_tool', { input: 'x' }, 1000);
      expect(result).toEqual({ ok: true });
    });
  });

  describe('MCP retry on transient errors', () => {
    it('should retry once on ECONNRESET', async () => {
      let callCount = 0;
      const client: McpClient = {
        callTool: vi.fn().mockImplementation(async () => {
          callCount++;
          if (callCount === 1) throw new Error('ECONNRESET');
          return { retried: true };
        }),
      };
      const mcpClients = createMockMcpProvider({ 'retry-server': client });

      const executor = new ToolBindingExecutor({
        tools: [createMcpTool('retry_tool', 'retry-server', 'do_thing')],
        secrets: createMockSecrets(),
        mcpClients,
      });

      const result = await executor.execute('retry_tool', { input: 'x' }, 10000);
      expect(result).toEqual({ retried: true });
      expect(client.callTool).toHaveBeenCalledTimes(2);
    });
  });
});

// =============================================================================
// SANDBOX TOOL E2E TESTS
// =============================================================================

describe('Sandbox Tool E2E', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  function createMockSandboxRunner(results: Record<string, unknown>): SandboxRunner {
    return {
      run: vi.fn().mockImplementation(async (config) => {
        const result = results[config.functionName];
        if (result instanceof Error) throw result;
        return result ?? { executed: true };
      }),
    };
  }

  describe('Full lifecycle: ToolBindingExecutor → SandboxToolExecutor → SandboxRunner', () => {
    it('should execute JavaScript sandbox tool through full pipeline', async () => {
      const runner = createMockSandboxRunner({
        calc_risk: { score: 0.85, factors: ['credit_score', 'income'] },
      });

      const executor = new ToolBindingExecutor({
        tools: [createSandboxTool('calc_risk', 'javascript', 'risk-calculator.js')],
        secrets: createMockSecrets(),
        sandboxRunner: runner,
        sessionContext: { tenantId: 'tenant-1', sessionId: 'sess-1' },
      });

      const result = await executor.execute('calc_risk', { data: { income: 50000 } }, 5000);
      expect(result).toEqual({ score: 0.85, factors: ['credit_score', 'income'] });

      expect(runner.run).toHaveBeenCalledWith(
        expect.objectContaining({
          functionName: 'calc_risk',
          codeContent: 'risk-calculator.js',
          runtime: 'javascript',
          params: { data: { income: 50000 } },
          limits: { timeoutMs: 5000, memoryMb: 128 },
        }),
      );
    });

    it('should execute Python sandbox tool through full pipeline', async () => {
      const runner = createMockSandboxRunner({
        analyze_sentiment: { sentiment: 'positive', confidence: 0.92 },
      });

      const executor = new ToolBindingExecutor({
        tools: [createSandboxTool('analyze_sentiment', 'python', 'sentiment.py')],
        secrets: createMockSecrets(),
        sandboxRunner: runner,
      });

      const result = await executor.execute(
        'analyze_sentiment',
        { data: { text: 'Great!' } },
        5000,
      );
      expect(result).toEqual({ sentiment: 'positive', confidence: 0.92 });

      expect(runner.run).toHaveBeenCalledWith(
        expect.objectContaining({ runtime: 'python', codeContent: 'sentiment.py' }),
      );
    });
  });

  describe('Sandbox path traversal security', () => {
    it('should block parent directory traversal through ToolBindingExecutor', async () => {
      const runner = createMockSandboxRunner({});

      const executor = new ToolBindingExecutor({
        tools: [createSandboxTool('evil_tool', 'javascript', '../../etc/passwd')],
        secrets: createMockSecrets(),
        sandboxRunner: runner,
      });

      await expect(executor.execute('evil_tool', { data: {} }, 5000)).rejects.toThrow(
        /path traversal/i,
      );
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('should block absolute paths through ToolBindingExecutor', async () => {
      const runner = createMockSandboxRunner({});

      const executor = new ToolBindingExecutor({
        tools: [createSandboxTool('evil_tool', 'javascript', '/etc/shadow')],
        secrets: createMockSecrets(),
        sandboxRunner: runner,
      });

      await expect(executor.execute('evil_tool', { data: {} }, 5000)).rejects.toThrow(
        /relative path/i,
      );
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('should block null bytes in code_content through ToolBindingExecutor', async () => {
      const runner = createMockSandboxRunner({});

      const executor = new ToolBindingExecutor({
        tools: [createSandboxTool('evil_tool', 'javascript', 'tool.js\0.txt')],
        secrets: createMockSecrets(),
        sandboxRunner: runner,
      });

      await expect(executor.execute('evil_tool', { data: {} }, 5000)).rejects.toThrow(
        /null bytes/i,
      );
      expect(runner.run).not.toHaveBeenCalled();
    });

    it('should block Windows-style absolute paths', async () => {
      const runner = createMockSandboxRunner({});

      const executor = new ToolBindingExecutor({
        tools: [createSandboxTool('evil_tool', 'javascript', 'C:\\Windows\\cmd.exe')],
        secrets: createMockSecrets(),
        sandboxRunner: runner,
      });

      await expect(executor.execute('evil_tool', { data: {} }, 5000)).rejects.toThrow(
        /relative path/i,
      );
    });
  });

  describe('Sandbox error handling', () => {
    it('should propagate runner errors as sanitized messages', async () => {
      const runner: SandboxRunner = {
        run: vi
          .fn()
          .mockRejectedValue(
            new Error(
              'Python traceback:\n  File "/app/sandbox/evil.py", line 42\n    raise ValueError("bad input")',
            ),
          ),
      };

      const executor = new ToolBindingExecutor({
        tools: [createSandboxTool('failing_tool', 'python', 'safe-tool.py')],
        secrets: createMockSecrets(),
        sandboxRunner: runner,
      });

      const err = await executor.execute('failing_tool', { data: {} }, 5000).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      // Error should be sanitized — no stack trace leaked
      expect(err.message).toContain('failing_tool');
      expect(err.message).not.toContain('File "/app/sandbox');
    });
  });
});

// =============================================================================
// MULTI-TOOL TYPE E2E (Mixed pipeline)
// =============================================================================

describe('Multi-Tool Type E2E', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should route HTTP, MCP, and Sandbox tools through single ToolBindingExecutor', async () => {
    // HTTP mock
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ result: 'http-ok' }));
    vi.stubGlobal('fetch', fetchMock);

    // MCP mock
    const mcpClient: McpClient = {
      callTool: vi.fn().mockResolvedValue({ result: 'mcp-ok' }),
    };
    const mcpClients: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mcpClient),
    };

    // Sandbox mock
    const sandboxRunner: SandboxRunner = {
      run: vi.fn().mockResolvedValue({ result: 'sandbox-ok' }),
    };

    const executor = new ToolBindingExecutor({
      tools: [
        createHttpTool('http_tool'),
        createMcpTool('mcp_tool', 'test-server', 'test_fn'),
        createSandboxTool('sandbox_tool', 'javascript', 'calc.js'),
      ],
      secrets: createMockSecrets(),
      mcpClients,
      sandboxRunner,
      sessionContext: { tenantId: 'tenant-1', sessionId: 'sess-1', userId: 'user-1' },
    });

    const httpResult = await executor.execute('http_tool', { query: 'test' }, 5000);
    expect(httpResult).toEqual({ result: 'http-ok' });

    const mcpResult = await executor.execute('mcp_tool', { input: 'test' }, 5000);
    expect(mcpResult).toEqual({ result: 'mcp-ok' });

    const sandboxResult = await executor.execute('sandbox_tool', { data: { x: 1 } }, 5000);
    expect(sandboxResult).toEqual({ result: 'sandbox-ok' });
  });

  describe('Parallel execution across tool types', () => {
    it('should execute mixed tool types in parallel and collect results', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ http: true }));
      vi.stubGlobal('fetch', fetchMock);

      const mcpClient: McpClient = {
        callTool: vi.fn().mockResolvedValue({ mcp: true }),
      };
      const mcpClients: McpClientProvider = {
        getClient: vi.fn().mockResolvedValue(mcpClient),
      };

      const sandboxRunner: SandboxRunner = {
        run: vi.fn().mockResolvedValue({ sandbox: true }),
      };

      const executor = new ToolBindingExecutor({
        tools: [
          createHttpTool('http_tool'),
          createMcpTool('mcp_tool', 'test-server', 'test_fn'),
          createSandboxTool('sandbox_tool', 'javascript', 'calc.js'),
        ],
        secrets: createMockSecrets(),
        mcpClients,
        sandboxRunner,
      });

      const results = await executor.executeParallel(
        [
          { name: 'http_tool', params: { query: 'test' } },
          { name: 'mcp_tool', params: { input: 'test' } },
          { name: 'sandbox_tool', params: { data: {} } },
        ],
        5000,
      );

      expect(results).toHaveLength(3);
      expect(results[0]).toEqual({ name: 'http_tool', result: { http: true } });
      expect(results[1]).toEqual({ name: 'mcp_tool', result: { mcp: true } });
      expect(results[2]).toEqual({ name: 'sandbox_tool', result: { sandbox: true } });
    });

    it('should capture individual tool errors in parallel execution without failing others', async () => {
      const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ http: true }));
      vi.stubGlobal('fetch', fetchMock);

      const mcpClients: McpClientProvider = {
        getClient: vi.fn().mockResolvedValue(undefined), // Server unavailable
      };

      const sandboxRunner: SandboxRunner = {
        run: vi.fn().mockResolvedValue({ sandbox: true }),
      };

      const executor = new ToolBindingExecutor({
        tools: [
          createHttpTool('http_tool'),
          createMcpTool('mcp_tool', 'missing-server', 'test_fn'),
          createSandboxTool('sandbox_tool', 'javascript', 'calc.js'),
        ],
        secrets: createMockSecrets(),
        mcpClients,
        sandboxRunner,
      });

      const results = await executor.executeParallel(
        [
          { name: 'http_tool', params: { query: 'test' } },
          { name: 'mcp_tool', params: { input: 'test' } },
          { name: 'sandbox_tool', params: { data: {} } },
        ],
        5000,
      );

      expect(results).toHaveLength(3);
      expect(results[0].result).toEqual({ http: true });
      expect(results[1].error).toBeDefined(); // MCP failed
      expect(results[2].result).toEqual({ sandbox: true });
    });
  });
});

// =============================================================================
// MIDDLEWARE & AUDIT TRAIL E2E
// =============================================================================

describe('Middleware & Audit Trail E2E', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should pass tool metadata through middleware chain', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const capturedContexts: ToolCallContext[] = [];
    const auditMiddleware: ToolMiddleware = async (ctx, next) => {
      capturedContexts.push({ ...ctx });
      return next(ctx);
    };

    const executor = new ToolBindingExecutor({
      tools: [createHttpTool('audited_tool')],
      secrets: createMockSecrets(),
      middleware: [auditMiddleware],
      sessionContext: { tenantId: 'tenant-1', sessionId: 'sess-1', userId: 'user-1' },
    });

    await executor.execute('audited_tool', { query: 'test' }, 5000);

    expect(capturedContexts).toHaveLength(1);
    const ctx = capturedContexts[0];
    expect(ctx.toolName).toBe('audited_tool');
    expect(ctx.metadata?.tool_type).toBe('http');
    expect(ctx.metadata?.tenantId).toBe('tenant-1');
    expect(ctx.metadata?.sessionId).toBe('sess-1');
    expect(ctx.metadata?.userId).toBe('user-1');
    expect(ctx.metadata?.endpoint).toBe('https://api.example.com/v1/search');
  });

  it('should chain multiple middleware layers in order', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const order: string[] = [];

    const mw1: ToolMiddleware = async (ctx, next) => {
      order.push('mw1-before');
      const result = await next(ctx);
      order.push('mw1-after');
      return result;
    };

    const mw2: ToolMiddleware = async (ctx, next) => {
      order.push('mw2-before');
      const result = await next(ctx);
      order.push('mw2-after');
      return result;
    };

    const executor = new ToolBindingExecutor({
      tools: [createHttpTool('mw_test')],
      secrets: createMockSecrets(),
      middleware: [mw1, mw2],
    });

    await executor.execute('mw_test', { query: 'test' }, 5000);

    // Onion model: mw1 wraps mw2
    expect(order).toEqual(['mw1-before', 'mw2-before', 'mw2-after', 'mw1-after']);
  });

  it('should execute middleware for MCP and Sandbox tool types too', async () => {
    const mcpClient: McpClient = {
      callTool: vi.fn().mockResolvedValue({ mcp: true }),
    };
    const mcpClients: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mcpClient),
    };
    const sandboxRunner: SandboxRunner = {
      run: vi.fn().mockResolvedValue({ sandbox: true }),
    };

    const toolTypes: string[] = [];
    const mw: ToolMiddleware = async (ctx, next) => {
      toolTypes.push(ctx.metadata?.tool_type as string);
      return next(ctx);
    };

    const executor = new ToolBindingExecutor({
      tools: [
        createMcpTool('mcp_tool', 'server', 'fn'),
        createSandboxTool('sandbox_tool', 'javascript', 'calc.js'),
      ],
      secrets: createMockSecrets(),
      mcpClients,
      sandboxRunner,
      middleware: [mw],
    });

    await executor.execute('mcp_tool', { input: 'x' }, 5000);
    await executor.execute('sandbox_tool', { data: {} }, 5000);

    expect(toolTypes).toEqual(['mcp', 'sandbox']);
  });
});

// =============================================================================
// ERROR SANITIZATION E2E
// =============================================================================

describe('Error Sanitization E2E', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should sanitize HTTP error stack traces before they reach caller', async () => {
    const fetchMock = vi.fn().mockRejectedValue(
      Object.assign(
        new Error(
          'ECONNREFUSED 10.0.0.5:3000\n    at TCPConnectWrap.afterConnect\n    at internal/net.js:123',
        ),
        {
          stack:
            'Error: ECONNREFUSED\n    at /app/node_modules/undici/lib/client.js:500\n    at process.emit',
        },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const executor = new ToolBindingExecutor({
      tools: [createHttpTool('leaky_api')],
      secrets: createMockSecrets(),
    });

    const err = await executor.execute('leaky_api', { query: 'x' }, 5000).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    // Should not contain file paths or stack trace lines
    expect(err.message).not.toContain('/app/node_modules');
    expect(err.message).not.toContain('at process.emit');
    expect(err.message).not.toContain('internal/net.js');
    // Should contain the tool name
    expect(err.message).toContain('leaky_api');
  });

  it('should sanitize MCP error stack traces', async () => {
    const mcpClient: McpClient = {
      callTool: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'Database error: password authentication failed for user "admin"\n    at /srv/mcp-server/db.js:42',
          ),
        ),
    };
    const mcpClients: McpClientProvider = {
      getClient: vi.fn().mockResolvedValue(mcpClient),
    };

    const executor = new ToolBindingExecutor({
      tools: [createMcpTool('db_tool', 'db-server', 'query')],
      secrets: createMockSecrets(),
      mcpClients,
    });

    const err = await executor.execute('db_tool', { input: 'x' }, 5000).catch((e) => e);
    expect(err.message).not.toContain('/srv/mcp-server/db.js');
    expect(err.message).toContain('db_tool');
  });

  it('should sanitize sandbox error stack traces', async () => {
    const runner: SandboxRunner = {
      run: vi
        .fn()
        .mockRejectedValue(
          new Error(
            'SyntaxError: Unexpected token\n    at /app/sandbox-tools/user-code.js:15\n    at Module._compile',
          ),
        ),
    };

    const executor = new ToolBindingExecutor({
      tools: [createSandboxTool('broken_tool', 'javascript', 'safe.js')],
      secrets: createMockSecrets(),
      sandboxRunner: runner,
    });

    const err = await executor.execute('broken_tool', { data: {} }, 5000).catch((e) => e);
    expect(err.message).not.toContain('/app/sandbox-tools');
    expect(err.message).not.toContain('Module._compile');
    expect(err.message).toContain('broken_tool');
  });
});

// =============================================================================
// INPUT VALIDATION E2E
// =============================================================================

describe('Input Validation E2E', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should reject missing required parameter', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const tool = createHttpTool('strict_tool', {
      parameters: [
        { name: 'required_field', type: 'string', required: true },
        { name: 'optional_field', type: 'string', required: false },
      ],
    });

    const executor = new ToolBindingExecutor({
      tools: [tool],
      secrets: createMockSecrets(),
    });

    await expect(executor.execute('strict_tool', { optional_field: 'test' }, 5000)).rejects.toThrow(
      /missing required parameter.*required_field/i,
    );
  });

  it('should coerce string numbers to actual numbers', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const tool = createHttpTool('typed_tool', {
      parameters: [
        { name: 'count', type: 'number', required: true },
        { name: 'name', type: 'string', required: true },
      ],
    });

    const executor = new ToolBindingExecutor({
      tools: [tool],
      secrets: createMockSecrets(),
    });

    // LLMs often send numbers as strings
    await executor.execute('typed_tool', { count: '42', name: 'test' }, 5000);

    // The body should contain the coerced number
    const body = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(body.count).toBe(42);
    expect(typeof body.count).toBe('number');
  });

  it('should reject oversized tool params (DoS protection)', async () => {
    const fetchMock = vi.fn().mockResolvedValue(mockJsonResponse({ ok: true }));
    vi.stubGlobal('fetch', fetchMock);

    const executor = new ToolBindingExecutor({
      tools: [createHttpTool('large_input_tool')],
      secrets: createMockSecrets(),
    });

    // Create params exceeding 512KB limit
    const hugeParams = { query: 'x'.repeat(600 * 1024) };
    await expect(executor.execute('large_input_tool', hugeParams, 5000)).rejects.toThrow(
      /too large/i,
    );
  });
});

// =============================================================================
// CONCURRENCY LIMITING E2E
// =============================================================================

describe('Concurrency Limiting E2E', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('should respect maxConcurrency during parallel execution', async () => {
    let peakConcurrency = 0;
    let currentConcurrency = 0;

    const fetchMock = vi.fn().mockImplementation(async () => {
      currentConcurrency++;
      peakConcurrency = Math.max(peakConcurrency, currentConcurrency);
      await new Promise((r) => setTimeout(r, 50));
      currentConcurrency--;
      return mockJsonResponse({ ok: true });
    });
    vi.stubGlobal('fetch', fetchMock);

    const executor = new ToolBindingExecutor({
      tools: [createHttpTool('concurrent_tool')],
      secrets: createMockSecrets(),
      maxConcurrency: 3,
    });

    // Launch 9 parallel calls with max concurrency of 3
    const calls = Array.from({ length: 9 }, (_, i) => ({
      name: 'concurrent_tool',
      params: { query: `test-${i}` },
    }));

    const results = await executor.executeParallel(calls, 10000);

    expect(results).toHaveLength(9);
    expect(results.every((r) => r.result)).toBe(true);
    // Peak should not exceed the configured max
    expect(peakConcurrency).toBeLessThanOrEqual(3);
  });
});

// =============================================================================
// INT-7: DSL→IR LOCKSTEP ROUND-TRIP (SOAP FIELDS)
// =============================================================================

describe('INT-7: DSL→IR SOAP field lockstep', () => {
  it('should produce SOAP fields when protocol/soap_version/soap_action are set in DSL props', async () => {
    const { buildHttpBindingFromProps } = await import('@agent-platform/shared/tools');

    const soapProps: Record<string, string> = {
      endpoint: 'https://soap.example.com/policy',
      method: 'POST',
      protocol: 'soap',
      soap_version: '1.1',
      soap_action: 'http://example.com/LookupPolicy',
    };

    const binding = buildHttpBindingFromProps(soapProps);

    expect(binding.protocol).toBe('soap');
    expect(binding.soap_version).toBe('1.1');
    expect(binding.soap_action).toBe('http://example.com/LookupPolicy');
    expect(binding.on_soap_fault).toBeUndefined();
  });

  it('should produce on_soap_fault when set in DSL props', async () => {
    const { buildHttpBindingFromProps } = await import('@agent-platform/shared/tools');

    const soapProps: Record<string, string> = {
      endpoint: 'https://soap.example.com/policy',
      method: 'POST',
      protocol: 'soap',
      soap_version: '1.2',
      soap_action: 'http://example.com/LookupPolicy',
      on_soap_fault: 'data',
    };

    const binding = buildHttpBindingFromProps(soapProps);

    expect(binding.protocol).toBe('soap');
    expect(binding.soap_version).toBe('1.2');
    expect(binding.soap_action).toBe('http://example.com/LookupPolicy');
    expect(binding.on_soap_fault).toBe('data');
  });

  it('should NOT produce SOAP fields for a REST DSL (no protocol line)', async () => {
    const { buildHttpBindingFromProps } = await import('@agent-platform/shared/tools');

    const restProps: Record<string, string> = {
      endpoint: 'https://api.example.com/users',
      method: 'GET',
    };

    const binding = buildHttpBindingFromProps(restProps);

    expect(binding.protocol).toBeUndefined();
    expect(binding.soap_version).toBeUndefined();
    expect(binding.soap_action).toBeUndefined();
    expect(binding.on_soap_fault).toBeUndefined();
  });

  it('should round-trip SOAP fields through DSL serialize → parse → build', async () => {
    const sharedTools = await import('@agent-platform/shared/tools');
    const { buildHttpBindingFromProps, parseDslProperties, serializeToolFormToDsl } = sharedTools;

    // Step 1: Build a SOAP form and serialize to DSL
    const soapForm = {
      name: 'lookup_policy',
      toolType: 'http' as const,
      description: 'Look up an insurance policy',
      parameters: [{ name: 'policy_number', type: 'string', required: true }],
      returnType: 'object',
      endpoint: 'https://soap.example.com/PolicyService',
      method: 'POST' as const,
      auth: 'none' as const,
      protocol: 'soap' as const,
      soapVersion: '1.1' as const,
      soapAction: 'http://example.com/PolicyService/LookupPolicy',
      onSoapFault: 'data' as const,
      bodyType: 'xml' as const,
      body: '<ns:LookupPolicy><ns:PolicyNumber>{{input.policy_number}}</ns:PolicyNumber></ns:LookupPolicy>',
    };

    const dslString = serializeToolFormToDsl(soapForm);

    // Step 2: Verify the serialized DSL contains SOAP lines
    expect(dslString).toContain('protocol: soap');
    expect(dslString).toContain('soap_version: 1.1');
    expect(dslString).toContain('soap_action:');
    expect(dslString).toContain('on_soap_fault: data');

    // Step 3: Parse the DSL back to properties
    const parsedProps = parseDslProperties(dslString);

    // Step 4: Build HTTP binding from the parsed properties
    const binding = buildHttpBindingFromProps(parsedProps, dslString);

    // Step 5: Verify the round-trip preserved all SOAP fields
    expect(binding.protocol).toBe('soap');
    expect(binding.soap_version).toBe('1.1');
    expect(binding.soap_action).toBe('http://example.com/PolicyService/LookupPolicy');
    expect(binding.on_soap_fault).toBe('data');
    expect(binding.endpoint).toBe('https://soap.example.com/PolicyService');
    expect(binding.method).toBe('POST');
  });
});

// =============================================================================
// HELPERS
// =============================================================================

/** Creates a real in-memory ResilienceFactory for testing */
function createTestResilienceFactory(): ResilienceFactory {
  return {
    createCircuitBreaker(
      _name: string,
      config: { threshold: number; resetMs: number },
    ): ICircuitBreaker {
      let failures = 0;
      let state: 'closed' | 'open' | 'half-open' = 'closed';
      return {
        isOpen: () => state === 'open',
        recordSuccess: () => {
          failures = 0;
          state = 'closed';
        },
        recordFailure: () => {
          failures++;
          if (failures >= config.threshold) state = 'open';
        },
        getState: () => state,
      };
    },
    createRateLimiter(_name: string, _rpm: number): IRateLimiter {
      return { acquire: async () => {} };
    },
  };
}
