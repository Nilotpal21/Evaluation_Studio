import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HttpToolExecutor } from '../../platform/constructs/executors/http-tool-executor.js';
import { assertUrlSafeForSSRF } from '@agent-platform/shared-kernel/security';
import type { ToolDefinition } from '../../platform/ir/schema.js';
import type { SecretsProvider } from '../../platform/constructs/executors/secrets-provider.js';

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

beforeEach(() => {
  vi.restoreAllMocks();
  mockAssertUrlSafeForFetch.mockResolvedValue(undefined);
  mockSafeFetch.mockImplementation((url: string | URL, init?: RequestInit) =>
    globalThis.fetch(url, init),
  );
  (HttpToolExecutor as any)._undiciModule = undefined;
  (HttpToolExecutor as any)._defaultAgent = null;
});

const mockSecrets: SecretsProvider = {
  async getSecret(key: string) {
    if (key === 'api_key_token') return 'test-api-key';
    if (key === 'bearer_token') return 'test-bearer-token';
    if (key === 'json_special_secret') return 'secret "quoted"\nline';
    return undefined;
  },
  async getEnvVar(key: string) {
    if (key === 'JSON_SPECIAL_ENV') return 'env "quoted"\nline';
    return undefined;
  },
};

const VALID_MTLS_CERT = `-----BEGIN CERTIFICATE-----
MIIDCTCCAfGgAwIBAgIUSpitCsKu2Wt63V2BGz7GqAfvu+gwDQYJKoZIhvcNAQEL
BQAwFDESMBAGA1UEAwwJbXRscy50ZXN0MB4XDTI2MDUwNjE0MTc1M1oXDTI3MDUw
NjE0MTc1M1owFDESMBAGA1UEAwwJbXRscy50ZXN0MIIBIjANBgkqhkiG9w0BAQEF
AAOCAQ8AMIIBCgKCAQEApnuaKNnteh9vlKnfqMA5JUiwS+5xepzMOzY6bYd/9rFo
AvzdTSgJ80ApQOo1+k1gUNLTuns23rH2+I2+XmjAF1ONK5QeXFXGpS6m/NT4Q0Q6
F/fd+kjbyMikVtqLAVRpSnCULCvQFICScbsr+OwO50NxD8375KBvUgZ7rOEutJLd
8cnRQ6tLmAd7VLudZSVYCxmBO8cUbndbkd938ATSVmx3p65d9S42C1NejiaWZ3TS
mTwG57niKMJ3YxcyKD8gZS9Z2AGWkfVIzYO6agq1tRjFLe8DJ96+qy/Pi8WhSYDU
xrvbPmJZJF6B0V8y+xMmF4i2Byv2uOVI3fkhi9714wIDAQABo1MwUTAdBgNVHQ4E
FgQUr2+J6HEmrIbqdiHMhQjv8uDjbsYwHwYDVR0jBBgwFoAUr2+J6HEmrIbqdiHM
hQjv8uDjbsYwDwYDVR0TAQH/BAUwAwEB/zANBgkqhkiG9w0BAQsFAAOCAQEAh7Rt
kmxAmdnFK+6ZN2dX4dXds1MuMJnGvah6fy/plgzEkpfVUL5qF+NHum6NGfMOTXFe
HpIhEMNFmdOfYLKN6w97J88IRbtybxcTKZn2v+qH9EVQPnuQjTMbUIEh+bp3bdEE
mZCeKJ7Q/3NiOPCOjKt92UELQdN4gaXGE3ezBI8ei8hiY44xlO39nx9+WEt1tcIv
6wzMfVs97oenwueSSRRNo6j2TKXMbRTpLeTL+Y55pu6eZsA1GYG3FzECF6L5t233
cx2sjtx4tHzzOQJ8sIBzJ0TWXa8mdbyJwmvz5c9fCsmQcoNEZ/PMr+lTFWyDUg15
M33AWC/5akar1x+8ug==
-----END CERTIFICATE-----`;

const VALID_MTLS_KEY = `-----BEGIN PRIVATE KEY-----
MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQCme5oo2e16H2+U
qd+owDklSLBL7nF6nMw7Njpth3/2sWgC/N1NKAnzQClA6jX6TWBQ0tO6ezbesfb4
jb5eaMAXU40rlB5cVcalLqb81PhDRDoX9936SNvIyKRW2osBVGlKcJQsK9AUgJJx
uyv47A7nQ3EPzfvkoG9SBnus4S60kt3xydFDq0uYB3tUu51lJVgLGYE7xxRud1uR
33fwBNJWbHenrl31LjYLU16OJpZndNKZPAbnueIowndjFzIoPyBlL1nYAZaR9UjN
g7pqCrW1GMUt7wMn3r6rL8+LxaFJgNTGu9s+YlkkXoHRXzL7EyYXiLYHK/a45Ujd
+SGL3vXjAgMBAAECggEAA+TuRThbyriDhqm2lp7wd0PNA+mu89xJFrV9BmTeBGo/
8Znyn0RpfywoCuGvo4w9zYYw97K8JNdq3IOMSW8P1zvYGIXdc/F5tRFzTIS6zfAB
n9/nbFxZ78dpuLJiAAT2dYxOmv3nXyNmyYxESg1Th+tW8LSzyLRMBlIqgG/ABO9E
40dmvgIHne1d7ikZQ8cYt7B+PzxtGpBkEft+EmCBJLHBFfeRhHHnT8MNJwVwA9Tw
0A2/xlDueL9mUUytK3wGCqkqKcT7nIShrS2m0Es1l6RU/eaaRxP2lFF8Q6V0/DRq
/fBuAmks33tSm04PKxzZKW+EXX9gY7qiM/Eip//ZkQKBgQDPKHb4Diyk5qU5K+xh
lbzXa7l17baarEz9WPvzeQdLzQ5R75oX6sWP8AA79qPai4+3F8KRXfLml06fB416
BysoPlL0tcdiMdnalmctTV6zHEKaDbow6WmeZj83koWfKjxHxichrVfIbDt+94I1
Ca9IjFUUqQzsv4Oe618Gk6euywKBgQDNvBU5fte4kX2rRt0F5GOTsgsOMGTq0HG8
LUWzPp4V80IhFv0lzw5YrYzDD1AhAvqKuVK+1k8eBbN1YYz7EQOu5QgCc7IKteag
2Inuz9nzwm4xbsK8QRbVE1UGqvoZjsBtNsiAUI0bNq9FNZkdJFHzihYbGl2DXDzF
EkYs0LiaSQKBgQCA8NbcHzZ6jXVZ2JURSHp6O3r8hDGcpJJnPvPT4AlCjSfUqCZp
rJ+7r871g9cJOMUDWa6pfKisDpHJOpI82ilqqyBHYL3xyMWo4OTntbi0E2sBKHoz
55TuGwZOOM0i/M74fcXtmE+DWJrPtI8/JAAOUArFCVQaKDpsuGQ1W8KLcQKBgHUn
zc5X9PAdqbqHOAXK8QmCMdl6pX0yBhJqlW5lEhDd3aKKPM3zAvBso+PQLIkf8Rxe
PEiAMb2e8Xq+elHedoJ52f3LdG+09ghSRvm/UxYEekucDzi0uBPOVnTdmF5FdD69
G6A2PqRol5aJ1w9JR4Gv+LamZOoQ9Gok5eFPWlBBAoGAf0kvnLcgQ0z8IVOBoovb
rO0aSvG8/FuxYoE/Ck1wNrwcW0v47MqmupX7aE6h+s0cJDEeBOvrDAOuuGvTk81R
11UqsEZERliMVxN0CYDgLd5GJxyQEjnCpS5YLmGH876EIkF47nNspEnuX2cYtZXJ
vMa/rc3cKxiPlKSx5cTL1ic=
-----END PRIVATE KEY-----`;

function createHttpTool(overrides: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'test_api',
    description: 'Test API',
    parameters: [{ name: 'query', type: 'string', required: true }],
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'slow',
      parallelizable: false,
      side_effects: true,
      requires_auth: false,
    },
    tool_type: 'http',
    http_binding: {
      endpoint: 'https://api.example.com/search',
      method: 'POST',
      auth: { type: 'none' },
      timeout_ms: 5000,
    },
    ...overrides,
  };
}

function getHeaderValue(
  headers: RequestInit['headers'] | undefined,
  name: string,
): string | undefined {
  return new Headers(headers ?? {}).get(name) ?? undefined;
}

function getHeaderNames(headers: RequestInit['headers'] | undefined): string[] {
  return Array.from(new Headers(headers ?? {}).keys());
}

describe('HttpToolExecutor', () => {
  it('should construct with HTTP tools only', () => {
    const tools: ToolDefinition[] = [
      createHttpTool(),
      {
        name: 'non_http',
        description: 'Not HTTP',
        parameters: [],
        returns: { type: 'string' },
        hints: {
          cacheable: false,
          latency: 'fast',
          parallelizable: false,
          side_effects: false,
          requires_auth: false,
        },
        tool_type: 'mcp',
        mcp_binding: { server: 'test', tool: 'test' },
      },
    ];

    const executor = new HttpToolExecutor({ tools, secrets: mockSecrets });
    expect(executor).toBeDefined();
  });

  it('should throw for non-existent HTTP tool', async () => {
    const executor = new HttpToolExecutor({
      tools: [createHttpTool()],
      secrets: mockSecrets,
    });
    await expect(executor.execute('nonexistent', {}, 5000)).rejects.toThrow('HTTP tool not found');
  });

  it('should throw when circuit breaker is open', async () => {
    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/fail',
        method: 'GET',
        auth: { type: 'none' },
        circuit_breaker: { threshold: 1, reset_ms: 60000 },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });

    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Connection refused')));

    // First call fails and trips breaker
    await expect(executor.execute('test_api', {}, 5000)).rejects.toThrow();

    // Second call gets circuit breaker error
    await expect(executor.execute('test_api', {}, 5000)).rejects.toThrow('circuit breaker open');

    vi.unstubAllGlobals();
  });

  it('should report circuit breaker state', () => {
    const executor = new HttpToolExecutor({
      tools: [createHttpTool()],
      secrets: mockSecrets,
    });
    expect(executor.getCircuitBreakerState('test_api')).toBeUndefined();
  });

  it('should execute successful GET request', async () => {
    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/items/{id}',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const mockResponse = { id: '123', name: 'Test Item' };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve(mockResponse),
      }),
    );

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    const result = await executor.execute('test_api', { id: '123' }, 5000);
    expect(result).toEqual(mockResponse);

    const fetchCall = (fetch as any).mock.calls[0];
    expect(fetchCall[0]).toBe('https://api.example.com/items/123');

    vi.unstubAllGlobals();
  });

  it('should execute POST request with body', async () => {
    const mockResponse = { results: [] };
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve(mockResponse),
      }),
    );

    const executor = new HttpToolExecutor({
      tools: [createHttpTool()],
      secrets: mockSecrets,
    });
    const result = await executor.execute('test_api', { query: 'test' }, 5000);
    expect(result).toEqual(mockResponse);

    const fetchCall = (fetch as any).mock.calls[0];
    expect(fetchCall[1].method).toBe('POST');
    expect(JSON.parse(fetchCall[1].body)).toEqual({ query: 'test' });

    vi.unstubAllGlobals();
  });

  it('injects callback URL and secret into async HTTP request bodies', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 200,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ state: 'queued' }),
      }),
    );

    const executor = new HttpToolExecutor({
      tools: [createHttpTool()],
      secrets: mockSecrets,
    });
    const result = await executor.execute('test_api', { query: 'test' }, 5000, undefined, {
      executionMode: 'async_wait',
      callback: {
        url: 'https://engine.example.com/api/v1/workflows/callbacks/exec-1/step-1',
        secret: 'callback-secret-1',
      },
      callbackConfig: {
        enabled: true,
        location: 'body',
        callbackUrlKey: 'callbackUrl',
        callbackSecretKey: 'callbackSecret',
      },
    });

    expect(result).toEqual({
      __toolExecutionStatus: 'accepted',
      output: { state: 'queued' },
      responseStatus: 200,
    });
    const fetchCall = (fetch as any).mock.calls[0];
    expect(JSON.parse(fetchCall[1].body)).toEqual({
      query: 'test',
      callbackUrl: 'https://engine.example.com/api/v1/workflows/callbacks/exec-1/step-1',
      callbackSecret: 'callback-secret-1',
    });

    vi.unstubAllGlobals();
  });

  it('treats successful async HTTP handoff responses as accepted by default', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 201,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ accepted: true, jobId: 'job-201' }),
      }),
    );

    const executor = new HttpToolExecutor({
      tools: [createHttpTool()],
      secrets: mockSecrets,
    });
    const result = await executor.execute('test_api', { query: 'test' }, 5000, undefined, {
      executionMode: 'async_wait',
      callback: {
        url: 'https://engine.example.com/api/v1/workflows/callbacks/exec-4/step-4',
        secret: 'callback-secret-4',
      },
      callbackConfig: {
        enabled: true,
        location: 'body',
        callbackUrlKey: 'callbackUrl',
        callbackSecretKey: 'callbackSecret',
      },
    });

    expect(result).toEqual({
      __toolExecutionStatus: 'accepted',
      output: { accepted: true, jobId: 'job-201' },
      responseStatus: 201,
    });

    vi.unstubAllGlobals();
  });

  it('injects callback URL and secret into async HTTP headers', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 202,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ state: 'queued' }),
      }),
    );

    const executor = new HttpToolExecutor({
      tools: [createHttpTool()],
      secrets: mockSecrets,
    });
    await executor.execute('test_api', { query: 'test' }, 5000, undefined, {
      executionMode: 'async_wait',
      callback: {
        url: 'https://engine.example.com/api/v1/workflows/callbacks/exec-2/step-2',
        secret: 'callback-secret-2',
      },
      callbackConfig: {
        enabled: true,
        location: 'header',
        callbackUrlKey: 'X-Callback-Url',
        callbackSecretKey: 'X-Callback-Secret',
      },
    });

    const fetchCall = (fetch as any).mock.calls[0];
    expect(getHeaderValue(fetchCall[1].headers, 'X-Callback-Url')).toBe(
      'https://engine.example.com/api/v1/workflows/callbacks/exec-2/step-2',
    );
    expect(getHeaderValue(fetchCall[1].headers, 'X-Callback-Secret')).toBe('callback-secret-2');

    vi.unstubAllGlobals();
  });

  it('injects callback URL and secret into async HTTP query params', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 202,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ state: 'queued' }),
      }),
    );

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/jobs',
        method: 'GET',
        auth: { type: 'none' },
      },
    });
    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
    });
    await executor.execute('test_api', { query: 'test' }, 5000, undefined, {
      executionMode: 'async_wait',
      callback: {
        url: 'https://engine.example.com/api/v1/workflows/callbacks/exec-3/step-3',
        secret: 'callback-secret-3',
      },
      callbackConfig: {
        enabled: true,
        location: 'query',
        callbackUrlKey: 'callbackUrl',
        callbackSecretKey: 'callbackSecret',
      },
    });

    const fetchCall = (fetch as any).mock.calls[0];
    expect(fetchCall[0]).toContain('query=test');
    expect(fetchCall[0]).toContain(
      encodeURIComponent('https://engine.example.com/api/v1/workflows/callbacks/exec-3/step-3'),
    );
    expect(fetchCall[0]).toContain('callbackSecret=callback-secret-3');

    vi.unstubAllGlobals();
  });

  it('classifies async HTTP responses as completed when accepted body criteria do not match', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        status: 202,
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ state: 'done' }),
      }),
    );

    const executor = new HttpToolExecutor({
      tools: [createHttpTool()],
      secrets: mockSecrets,
    });
    const result = await executor.execute('test_api', { query: 'test' }, 5000, undefined, {
      executionMode: 'async_wait',
      asyncHttpSuccess: {
        acceptedBodyPath: '$.state',
        acceptedBodyEquals: 'queued',
      },
    });

    expect(result).toEqual({
      __toolExecutionStatus: 'completed',
      output: { state: 'done' },
      responseStatus: 202,
    });

    vi.unstubAllGlobals();
  });

  it('resolves config-backed runtime numeric fields before resilience and retry execution', async () => {
    const limiterAcquire = vi.fn().mockResolvedValue(undefined);
    const breaker = {
      isOpen: vi.fn().mockResolvedValue(false),
      recordSuccess: vi.fn().mockResolvedValue(undefined),
      recordFailure: vi.fn().mockResolvedValue(undefined),
      getState: vi.fn().mockResolvedValue('closed' as const),
    };
    const resilienceFactory = {
      createCircuitBreaker: vi.fn().mockReturnValue(breaker),
      createRateLimiter: vi.fn().mockReturnValue({ acquire: limiterAcquire }),
    };
    const secrets: SecretsProvider = {
      ...mockSecrets,
      getConfigVar: vi.fn(async (key: string) => {
        const values: Record<string, string> = {
          HTTP_TIMEOUT_MS: '2500',
          HTTP_RETRY_COUNT: '1',
          HTTP_RETRY_DELAY_MS: '0',
          HTTP_RATE_LIMIT: '42',
          HTTP_CB_THRESHOLD: '7',
          HTTP_CB_RESET_MS: '9000',
        };
        return values[key];
      }),
    };
    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/items',
        method: 'GET',
        auth: { type: 'none' },
        timeout_ms: '{{config.HTTP_TIMEOUT_MS}}',
        retry: {
          count: '{{config.HTTP_RETRY_COUNT}}',
          delay_ms: '{{config.HTTP_RETRY_DELAY_MS}}',
        },
        rate_limit_per_minute: '{{config.HTTP_RATE_LIMIT}}',
        circuit_breaker: {
          threshold: '{{config.HTTP_CB_THRESHOLD}}',
          reset_ms: '{{config.HTTP_CB_RESET_MS}}',
        },
      } as unknown as ToolDefinition['http_binding'],
    });

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockRejectedValueOnce(new Error('temporary failure'))
        .mockResolvedValueOnce({
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ ok: true }),
        }),
    );

    const executor = new HttpToolExecutor({ tools: [tool], secrets, resilienceFactory });
    const result = await executor.execute('test_api', {}, 30_000);

    expect(result).toEqual({ ok: true });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(resilienceFactory.createRateLimiter).toHaveBeenCalledWith('test_api', 42);
    expect(resilienceFactory.createCircuitBreaker).toHaveBeenCalledWith('test_api', {
      threshold: 7,
      resetMs: 9000,
    });
    expect(limiterAcquire).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('should throw when a required path param is undefined', async () => {
    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/users/{userId}/orders/{orderId}',
        method: 'GET',
        auth: { type: 'none' },
      },
    });
    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });

    await expect(executor.execute('test_api', { userId: '123' }, 5000)).rejects.toThrow('orderId');
  });

  it('should throw when a path param is null', async () => {
    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/users/{userId}',
        method: 'GET',
        auth: { type: 'none' },
      },
    });
    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });

    await expect(executor.execute('test_api', { userId: null }, 5000)).rejects.toThrow('userId');
  });
});

// =============================================================================
// SSRF Protection Tests
// =============================================================================

describe('SSRF Protection', () => {
  describe('scheme blocking', () => {
    it('should block file:// scheme', () => {
      expect(() => assertUrlSafeForSSRF('file:///etc/passwd')).toThrow('Blocked URL scheme');
    });

    it('should block ftp:// scheme', () => {
      expect(() => assertUrlSafeForSSRF('ftp://evil.com/data')).toThrow('Blocked URL scheme');
    });

    it('should block javascript: scheme', () => {
      expect(() => assertUrlSafeForSSRF('javascript:alert(1)')).toThrow('Blocked URL scheme');
    });

    it('should allow https:// scheme', () => {
      expect(() => assertUrlSafeForSSRF('https://api.example.com/data')).not.toThrow();
    });

    it('should allow http:// scheme', () => {
      expect(() => assertUrlSafeForSSRF('http://api.example.com/data')).not.toThrow();
    });
  });

  describe('private IP blocking', () => {
    it('should block 127.0.0.1 (loopback)', () => {
      expect(() => assertUrlSafeForSSRF('http://127.0.0.1/admin')).toThrow(
        'Blocked localhost connection',
      );
    });

    it('should block 127.x.x.x range', () => {
      expect(() => assertUrlSafeForSSRF('http://127.0.0.2/')).toThrow(
        'Blocked localhost connection',
      );
    });

    it('should block 10.x.x.x (RFC 1918 Class A)', () => {
      expect(() => assertUrlSafeForSSRF('http://10.0.0.1/')).toThrow('Blocked private/reserved IP');
    });

    it('should block 172.16-31.x.x (RFC 1918 Class B)', () => {
      expect(() => assertUrlSafeForSSRF('http://172.16.0.1/')).toThrow(
        'Blocked private/reserved IP',
      );
      expect(() => assertUrlSafeForSSRF('http://172.31.255.255/')).toThrow(
        'Blocked private/reserved IP',
      );
    });

    it('should not block 172.32.x.x (outside RFC 1918 Class B)', () => {
      expect(() => assertUrlSafeForSSRF('http://172.32.0.1/')).not.toThrow();
    });

    it('should block 192.168.x.x (RFC 1918 Class C)', () => {
      expect(() => assertUrlSafeForSSRF('http://192.168.1.1/')).toThrow(
        'Blocked private/reserved IP',
      );
    });

    it('should block 169.254.169.254 (cloud metadata)', () => {
      expect(() => assertUrlSafeForSSRF('http://169.254.169.254/latest/meta-data/')).toThrow(
        'Blocked cloud metadata endpoint',
      );
    });

    it('should block 0.0.0.0', () => {
      expect(() => assertUrlSafeForSSRF('http://0.0.0.0/')).toThrow('Blocked private/reserved IP');
    });
  });

  describe('IPv6 blocking', () => {
    it('should block ::1 (IPv6 loopback)', () => {
      expect(() => assertUrlSafeForSSRF('http://[::1]/')).toThrow('Blocked localhost connection');
    });

    it('should block fc00: (IPv6 unique local)', () => {
      expect(() => assertUrlSafeForSSRF('http://[fc00::1]/')).toThrow(
        'Blocked private/reserved IP',
      );
    });

    it('should block fe80: (IPv6 link-local)', () => {
      expect(() => assertUrlSafeForSSRF('http://[fe80::1]/')).toThrow(
        'Blocked private/reserved IP',
      );
    });

    it('should block ::ffff:127.0.0.1 (IPv6-mapped IPv4)', () => {
      expect(() => assertUrlSafeForSSRF('http://[::ffff:127.0.0.1]/')).toThrow(
        'Blocked private/reserved IP',
      );
    });

    it('should block [::] (IPv6 unspecified)', () => {
      expect(() => assertUrlSafeForSSRF('http://[::]/')).toThrow('Blocked private/reserved IP');
    });
  });

  describe('IP encoding bypass prevention', () => {
    it('should block decimal IP encoding (2130706433 = 127.0.0.1)', () => {
      expect(() => assertUrlSafeForSSRF('http://2130706433/')).toThrow(
        'Blocked localhost connection',
      );
    });

    it('should block decimal IP for 169.254.169.254 (2852039166)', () => {
      expect(() => assertUrlSafeForSSRF('http://2852039166/')).toThrow(
        'Blocked cloud metadata endpoint',
      );
    });

    it('should block octal IP encoding (0177.0.0.01 = 127.0.0.1)', () => {
      expect(() => assertUrlSafeForSSRF('http://0177.0.0.01/')).toThrow(
        'Blocked localhost connection',
      );
    });

    it('should block octal IP encoding for 10.0.0.1 (012.0.0.01)', () => {
      expect(() => assertUrlSafeForSSRF('http://012.0.0.01/')).toThrow(
        'Blocked private/reserved IP',
      );
    });
  });

  describe('userinfo bypass prevention', () => {
    it('should block @ userinfo URLs (http://evil.com@169.254.169.254/)', () => {
      expect(() => assertUrlSafeForSSRF('http://evil.com@169.254.169.254/')).toThrow(
        'Blocked URL with userinfo (@)',
      );
    });

    it('should block @ userinfo with credentials (http://user:pass@10.0.0.1/)', () => {
      expect(() => assertUrlSafeForSSRF('http://user:pass@10.0.0.1/')).toThrow(
        'Blocked URL with userinfo (@)',
      );
    });

    it('should not block @ in query parameters', () => {
      expect(() =>
        assertUrlSafeForSSRF('https://api.example.com/search?email=user@example.com'),
      ).not.toThrow();
    });
  });

  describe('hostname blocking', () => {
    it('should block metadata.google.internal', () => {
      expect(() =>
        assertUrlSafeForSSRF('http://metadata.google.internal/computeMetadata/v1/'),
      ).toThrow('Blocked cloud metadata endpoint');
    });

    it('should block localhost', () => {
      expect(() => assertUrlSafeForSSRF('http://localhost/admin')).toThrow(
        'Blocked localhost connection',
      );
    });

    it('should block metadata', () => {
      expect(() => assertUrlSafeForSSRF('http://metadata/')).toThrow(
        'Blocked cloud metadata endpoint',
      );
    });
  });

  describe('allowLocalhost mode', () => {
    it('should allow localhost when allowLocalhost=true', () => {
      expect(() =>
        assertUrlSafeForSSRF('http://localhost/api', { allowLocalhost: true }),
      ).not.toThrow();
    });

    it('should allow 127.0.0.1 when allowLocalhost=true', () => {
      expect(() =>
        assertUrlSafeForSSRF('http://127.0.0.1/api', { allowLocalhost: true }),
      ).not.toThrow();
    });

    it('should still block 10.x when allowLocalhost=true', () => {
      expect(() => assertUrlSafeForSSRF('http://10.0.0.1/', { allowLocalhost: true })).toThrow(
        'Blocked private/reserved IP',
      );
    });

    it('should still block 169.254.169.254 when allowLocalhost=true', () => {
      expect(() =>
        assertUrlSafeForSSRF('http://169.254.169.254/', { allowLocalhost: true }),
      ).toThrow('Blocked cloud metadata endpoint');
    });
  });
});

// =============================================================================
// Redirect following tests (integration with HttpToolExecutor)
// =============================================================================

describe('Redirect Following', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    mockAssertUrlSafeForFetch.mockResolvedValue(undefined);
    mockSafeFetch.mockReset();
  });

  it('should not follow redirects to private IPs', async () => {
    mockSafeFetch.mockRejectedValueOnce(
      Object.assign(new Error('Blocked cloud metadata endpoint'), {
        name: 'SSRFError',
        code: 'SSRF_BLOCKED',
      }),
    );

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await expect(executor.execute('test_api', {}, 5000)).rejects.toThrow(
      'HTTP tool target blocked by SSRF protection',
    );

    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('should not follow redirects to localhost', async () => {
    mockSafeFetch.mockRejectedValueOnce(
      Object.assign(new Error('Blocked localhost connection'), {
        name: 'SSRFError',
        code: 'SSRF_BLOCKED',
      }),
    );

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await expect(executor.execute('test_api', {}, 5000)).rejects.toThrow(
      'HTTP tool target blocked by SSRF protection',
    );
  });

  it('should follow safe redirects and return the final response', async () => {
    mockSafeFetch.mockResolvedValueOnce({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve(JSON.stringify({ result: 'success' })),
    } as Response);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    const result = await executor.execute('test_api', {}, 5000);
    expect(result).toEqual({ result: 'success' });
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
  });

  it('should refuse to follow redirects on AWS IAM requests', async () => {
    // safeFetch is configured with maxRedirects:0 when sigv4_auth is set, so a
    // 302 from the upstream surfaces as SSRFError("Too many redirects (max 0)")
    // before any redirect is followed. Asserts on the credential-bearing
    // semantics: zero redirect hops were permitted with SigV4 active.
    mockSafeFetch.mockRejectedValueOnce(
      Object.assign(new Error('Too many redirects (max 0)'), {
        name: 'SSRFError',
        code: 'SSRF_BLOCKED',
      }),
    );

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
        sigv4_auth: {
          accessKeyId: 'AKIA_TEST',
          secretAccessKey: 'secret-key',
          sessionToken: 'session-token',
          region: 'us-east-1',
          service: 'execute-api',
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });

    await expect(executor.execute('test_api', {}, 5000)).rejects.toThrow(/SSRF/i);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockSafeFetch.mock.calls[0][2]).toEqual(expect.objectContaining({ maxRedirects: 0 }));
  });

  it('should limit redirect hops to 5', async () => {
    mockSafeFetch.mockRejectedValueOnce(
      Object.assign(new Error('Too many redirects (max 5)'), {
        name: 'SSRFError',
        code: 'SSRF_BLOCKED',
      }),
    );

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await expect(executor.execute('test_api', {}, 5000)).rejects.toThrow(
      'HTTP tool target blocked by SSRF protection',
    );
  });

  it('should delegate redirect validation and cap to safeFetch', async () => {
    mockSafeFetch.mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve(JSON.stringify({ ok: true })),
    } as Response);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', {}, 5000);

    expect(mockSafeFetch.mock.calls[0][2]).toEqual(expect.objectContaining({ maxRedirects: 5 }));
  });
});

// =============================================================================
// Header Injection Tests
// =============================================================================

describe('Header Injection', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should strip \\r\\n from header values', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });

    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
        headers: {
          'X-Custom': 'value\r\nInjected-Header: evil',
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', {}, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'X-Custom')).toBe('valueInjected-Header: evil');

    vi.unstubAllGlobals();
  });

  it('should strip \\r\\n from header names', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });

    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
        headers: {
          'X-Header\r\nEvil': 'safe-value',
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', {}, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    // The key should have CRLF stripped
    expect(getHeaderValue(fetchHeaders, 'X-HeaderEvil')).toBe('safe-value');
    expect(
      getHeaderNames(fetchHeaders).some((name) => name.includes('\r') || name.includes('\n')),
    ).toBe(false);

    vi.unstubAllGlobals();
  });

  it('should sanitize secret values in headers', async () => {
    const maliciousSecrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'api_key_token') return 'key-value\r\nX-Injected: malicious';
        return undefined;
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });

    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'api_key' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: maliciousSecrets });
    await executor.execute('test_api', {}, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    // The API key header value should have CRLF stripped
    const apiKeyValue = getHeaderValue(fetchHeaders, 'X-API-Key');
    expect(apiKeyValue).toBeDefined();
    expect(apiKeyValue).not.toContain('\r');
    expect(apiKeyValue).not.toContain('\n');

    vi.unstubAllGlobals();
  });
});

// =============================================================================
// Header Secret Resolution Tests
// =============================================================================

describe('Header Secret Resolution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve the correct secret for the specific header name', async () => {
    const specificSecrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'TRACKING_KEY') return 'tracking-value';
        if (key === 'AUTH_TOKEN') return 'correct-auth-token';
        return undefined;
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: () => Promise.resolve('{"ok":true}'),
      }),
    );

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'bearer' },
        headers: {
          'X-Tracking-Key': '{{secrets.TRACKING_KEY}}',
          Authorization: '{{secrets.AUTH_TOKEN}}',
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: specificSecrets });
    await executor.execute('test_api', {}, 5000);

    const fetchHeaders = (fetch as any).mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'Authorization')).toContain('correct-auth-token');

    vi.unstubAllGlobals();
  });
});

// =============================================================================
// Auth Handling Tests
// =============================================================================

describe('Auth Handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should apply bearer token from secrets', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ authenticated: true }),
    });

    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/secure',
        method: 'GET',
        auth: { type: 'bearer' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', {}, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'Authorization')).toBe('Bearer test-bearer-token');

    vi.unstubAllGlobals();
  });

  it('should apply API key to configured header', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });

    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: {
          type: 'api_key',
          config: { headerName: 'X-API-Key' },
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', {}, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'X-API-Key')).toBe('test-api-key');

    vi.unstubAllGlobals();
  });

  it('should throw TOOL_AUTH_FAILED for missing bearer secret', async () => {
    const emptySecrets: SecretsProvider = {
      async getSecret() {
        return undefined;
      },
    };

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'bearer' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: emptySecrets });
    await expect(executor.execute('test_api', {}, 5000)).rejects.toThrow(
      'Bearer token secret not found',
    );
  });

  it('should throw TOOL_AUTH_FAILED for missing api_key secret', async () => {
    const emptySecrets: SecretsProvider = {
      async getSecret() {
        return undefined;
      },
    };

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'api_key' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: emptySecrets });
    await expect(executor.execute('test_api', {}, 5000)).rejects.toThrow(
      'API key secret not found',
    );
  });

  it('should prepend Bearer prefix if not already present', async () => {
    const tokenSecrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'bearer_token') return 'raw-token-no-prefix';
        return undefined;
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });

    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'bearer' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: tokenSecrets });
    await executor.execute('test_api', {}, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'Authorization')).toBe('Bearer raw-token-no-prefix');

    vi.unstubAllGlobals();
  });

  it('should not double-prefix Bearer token if already prefixed', async () => {
    const tokenSecrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'bearer_token') return 'Bearer already-prefixed';
        return undefined;
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });

    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'bearer' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: tokenSecrets });
    await executor.execute('test_api', {}, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'Authorization')).toBe('Bearer already-prefixed');

    vi.unstubAllGlobals();
  });
  it('should not crash when OAuth scopes is undefined', async () => {
    const getSecret = vi.fn(async (key: string) => {
      if (key === 'oauth_client_id') return 'client-123';
      if (key === 'oauth_client_secret') return 'secret-456';
      return undefined;
    });
    const oauthSecrets: SecretsProvider = { getSecret };

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: () => Promise.resolve({ access_token: 'token-abc', expires_in: 3600 }),
        })
        .mockResolvedValueOnce({
          ok: true,
          status: 200,
          headers: new Headers({ 'content-type': 'application/json' }),
          body: null,
          text: () => Promise.resolve('{"data":"ok"}'),
        }),
    );

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: {
          type: 'oauth2_client',
          config: {
            oauth: {
              tokenUrl: 'https://auth.example.com/token',
              clientId: 'client-123',
              scopes: undefined as unknown as string[],
            },
          },
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: oauthSecrets });
    await expect(executor.execute('test_api', {}, 5000)).resolves.toBeDefined();
    expect(getSecret).toHaveBeenCalledWith('oauth_client_id', { toolName: 'test_api' });
    expect(getSecret).toHaveBeenCalledWith('oauth_client_secret', { toolName: 'test_api' });

    vi.unstubAllGlobals();
  });
});

// =============================================================================
// Response Size Limits Tests
// =============================================================================

describe('Response Size Limits', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should gracefully truncate response when Content-Length exceeds limit', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': '20000000', // 20MB
      }),
      text: async () => 'x'.repeat(20_000_000),
      body: null,
    });

    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      maxResponseBytes: 1024 * 1024, // 1MB limit
    });

    // Fix 6: readBoundedResponse now returns truncated data instead of throwing
    const result = await executor.execute('test_api', {}, 5000);
    expect(result).toBeDefined();
    const resultObj = result as Record<string, unknown>;
    expect(resultObj.truncated).toBe(true);
    expect(typeof resultObj.warning).toBe('string');

    vi.unstubAllGlobals();
  });

  it('should allow response within size limit', async () => {
    const smallResponse = JSON.stringify({ data: 'small' });
    const encoder = new TextEncoder();
    const encoded = encoder.encode(smallResponse);

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': String(encoded.length),
      }),
      body: {
        getReader: () => {
          let done = false;
          return {
            read: () => {
              if (done) return Promise.resolve({ done: true, value: undefined });
              done = true;
              return Promise.resolve({ done: false, value: encoded });
            },
            cancel: vi.fn(),
          };
        },
      },
    });

    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      maxResponseBytes: 1024 * 1024,
    });

    const result = await executor.execute('test_api', {}, 5000);
    expect(result).toEqual({ data: 'small' });

    vi.unstubAllGlobals();
  });

  it('should use default 10MB limit when not configured', () => {
    const tool = createHttpTool();
    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
    });
    // Just verify construction succeeds — default is used internally
    expect(executor).toBeDefined();
  });

  // G3: When tenantId is missing, circuit breaker state should still be accessible
  // (using _no_tenant_ prefix internally)
  it('should report circuit breaker state consistently without tenantId', () => {
    const executor = new HttpToolExecutor({
      tools: [createHttpTool()],
      secrets: mockSecrets,
    });
    // No breaker created yet — undefined expected
    expect(executor.getCircuitBreakerState('test_api')).toBeUndefined();
  });

  it('should handle text responses within size limit', async () => {
    const textResponse = 'Hello, World!';
    const encoder = new TextEncoder();
    const encoded = encoder.encode(textResponse);

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({
        'content-type': 'text/plain',
      }),
      body: {
        getReader: () => {
          let done = false;
          return {
            read: () => {
              if (done) return Promise.resolve({ done: true, value: undefined });
              done = true;
              return Promise.resolve({ done: false, value: encoded });
            },
            cancel: vi.fn(),
          };
        },
      },
    });

    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
    });

    const result = await executor.execute('test_api', {}, 5000);
    expect(result).toBe('Hello, World!');

    vi.unstubAllGlobals();
  });

  it('should fall back to text() when no streaming body available', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({
        'content-type': 'application/json',
      }),
      body: null,
      text: () => Promise.resolve(JSON.stringify({ fallback: true })),
    });

    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
    });

    const result = await executor.execute('test_api', {}, 5000);
    expect(result).toEqual({ fallback: true });

    vi.unstubAllGlobals();
  });
});

// =============================================================================
// Query Params Tests
// =============================================================================

describe('Query Params from Binding', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should append binding-level query_params to GET request URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
        query_params: { format: 'json', version: '2' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', { q: 'test' }, 5000);

    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('format=json');
    expect(fetchUrl).toContain('version=2');
    expect(fetchUrl).toContain('q=test');

    vi.unstubAllGlobals();
  });

  it('should append binding-level query_params to POST request URL (not body)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'POST',
        auth: { type: 'none' },
        query_params: { api_key: 'static-key' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', { payload: 'test' }, 5000);

    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('api_key=static-key');

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody).toEqual({ payload: 'test' });

    vi.unstubAllGlobals();
  });

  it('should resolve {{secrets.X}} in query_params', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
        query_params: { api_key: '{{secrets.api_key_token}}' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', {}, 5000);

    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('api_key=test-api-key');

    vi.unstubAllGlobals();
  });

  it('passes the executing tool name when resolving secret placeholders', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const getSecret = vi.fn(async (key: string, options?: { toolName?: string }) =>
      key === 'SHARED_TOKEN' && options?.toolName === 'test_api' ? 'scoped-token' : undefined,
    );
    const scopedSecrets: SecretsProvider = { getSecret };
    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
        headers: { Authorization: 'Bearer {{secrets.SHARED_TOKEN}}' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: scopedSecrets });
    await executor.execute('test_api', {}, 5000);

    expect(getSecret).toHaveBeenCalledWith('SHARED_TOKEN', { toolName: 'test_api' });
    const requestHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(requestHeaders.Authorization ?? requestHeaders.authorization).toBe(
      'Bearer scoped-token',
    );

    vi.unstubAllGlobals();
  });

  it('resolves {{config.X}} in runtime HTTP binding fields from the scoped provider', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const getConfigVar = vi.fn(async (key: string) => {
      if (key === 'API_BASE') return 'https://tenant.example.com';
      if (key === 'REGION') return 'us-east-2';
      if (key === 'TENANT_SLUG') return 'tenant-a';
      return undefined;
    });
    const configSecrets: SecretsProvider = {
      getSecret: vi.fn(async () => undefined),
      getConfigVar,
    };
    const tool = createHttpTool({
      http_binding: {
        endpoint: '{{config.API_BASE}}/events',
        method: 'POST',
        auth: { type: 'none' },
        headers: { 'X-Region': '{{config.REGION}}' },
        body_template: '{"tenant":"{{config.TENANT_SLUG}}","message":"{{input.message}}"}',
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: configSecrets });
    await executor.execute('test_api', { message: 'hello' }, 5000);

    expect(getConfigVar).toHaveBeenCalledWith('API_BASE');
    expect(getConfigVar).toHaveBeenCalledWith('REGION');
    expect(getConfigVar).toHaveBeenCalledWith('TENANT_SLUG');
    expect(mockFetch.mock.calls[0][0]).toBe('https://tenant.example.com/events');
    const requestHeaders = mockFetch.mock.calls[0][1].headers as Record<string, string>;
    expect(requestHeaders['X-Region'] ?? requestHeaders['x-region']).toBe('us-east-2');
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      tenant: 'tenant-a',
      message: 'hello',
    });

    vi.unstubAllGlobals();
  });
});

// =============================================================================
// Input Placeholder Tests
// =============================================================================

describe('Input Placeholder Resolution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve {{input.X}} in query_params from tool call args', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
        query_params: { q: '{{input.query}}', limit: '10' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', { query: 'hello world' }, 5000);

    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('q=hello+world');
    expect(fetchUrl).toContain('limit=10');

    vi.unstubAllGlobals();
  });

  it('should resolve {{input.X}} in headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
        headers: { 'X-Tenant': '{{input.tenant_id}}' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', { tenant_id: 'tenant-123' }, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'X-Tenant')).toBe('tenant-123');

    vi.unstubAllGlobals();
  });

  it('should resolve {{input.X}} in endpoint URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://{{input.host}}/api/data',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', { host: 'custom.example.com' }, 5000);

    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toBe('https://custom.example.com/api/data');

    vi.unstubAllGlobals();
  });

  it('should resolve {{input.X}} with empty string for missing params', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
        query_params: { q: '{{input.missing_param}}' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', {}, 5000);

    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('q=');

    vi.unstubAllGlobals();
  });
});

// =============================================================================
// Body Template Tests
// =============================================================================

describe('Body Template', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should use body_template with {{input.X}} resolution for POST', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/users',
        method: 'POST',
        auth: { type: 'none' },
        body_template: '{"name": "{{input.name}}", "email": "{{input.email}}"}',
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', { name: 'Alice', email: 'alice@test.com' }, 5000);

    const fetchBody = mockFetch.mock.calls[0][1].body;
    expect(fetchBody).toBe('{"name": "Alice", "email": "alice@test.com"}');

    vi.unstubAllGlobals();
  });

  it('should JSON-escape special characters when body_template interpolates string inputs', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/users',
        method: 'POST',
        auth: { type: 'none' },
        body_template: '{"note":"{{input.note}}","email":"{{input.email}}"}',
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    const note = 'Alice "Ace"\nBob';

    await executor.execute('test_api', { note, email: 'alice@test.com' }, 5000);

    const fetchBody = String(mockFetch.mock.calls[0][1].body);
    expect(JSON.parse(fetchBody)).toEqual({
      note,
      email: 'alice@test.com',
    });

    vi.unstubAllGlobals();
  });

  it('should keep external JSON APIs happy when body_template interpolates Slack text and runtime metadata', async () => {
    const mockFetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
      const body = String(init?.body ?? '');

      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        return {
          status: 200,
          ok: true,
          headers: new Headers({ 'content-type': 'application/json' }),
          json: () => Promise.resolve({ ok: true, parsed }),
        };
      } catch {
        return {
          status: 400,
          ok: false,
          headers: new Headers({ 'content-type': 'application/json' }),
          text: () => Promise.resolve('JSON parse error at external API'),
        };
      }
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/cost-estimate',
        method: 'POST',
        auth: { type: 'none' },
        body_template:
          '{"prompt":"{{input.prompt}}","channel":"{{_context.channel_label}}","sessionId":"{{session.id}}"}',
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    const prompt = 'Need a "premium"\nestimate';
    const channelLabel = 'slack "thread"';

    await expect(
      executor.execute(
        'test_api',
        {
          prompt,
          _context: { channel_label: channelLabel },
          _session: {
            id: 'sess-slack-1',
            tenantId: 'tenant-1',
            projectId: 'project-1',
            agentName: 'Cost_Estimator',
          },
        },
        5000,
      ),
    ).resolves.toEqual({
      ok: true,
      parsed: {
        prompt,
        channel: channelLabel,
        sessionId: 'sess-slack-1',
      },
    });

    vi.unstubAllGlobals();
  });

  it('should resolve {{secrets.X}} in body_template', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'POST',
        auth: { type: 'none' },
        body_template: '{"key": "{{secrets.api_key_token}}", "data": "{{input.data}}"}',
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', { data: 'payload' }, 5000);

    const fetchBody = mockFetch.mock.calls[0][1].body;
    expect(fetchBody).toBe('{"key": "test-api-key", "data": "payload"}');

    vi.unstubAllGlobals();
  });

  it('should JSON-escape secrets and env vars in body_template', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/notes',
        method: 'POST',
        auth: { type: 'none' },
        body_template:
          '{"secret":"{{secrets.json_special_secret}}","note":"{{env.JSON_SPECIAL_ENV}}"}',
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', {}, 5000);

    const fetchBody = String(mockFetch.mock.calls[0][1].body);
    expect(JSON.parse(fetchBody)).toEqual({
      secret: 'secret "quoted"\nline',
      note: 'env "quoted"\nline',
    });

    vi.unstubAllGlobals();
  });

  it('should fall back to JSON.stringify(params) when no body_template', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const executor = new HttpToolExecutor({
      tools: [createHttpTool()],
      secrets: mockSecrets,
    });
    await executor.execute('test_api', { query: 'test' }, 5000);

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody).toEqual({ query: 'test' });

    vi.unstubAllGlobals();
  });

  it('should send urlencoded auto-body when body_type is form', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://login.microsoftonline.com/oauth2/v2.0/token',
        method: 'POST',
        auth: { type: 'none' },
        body_type: 'form',
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      {
        grant_type: 'client_credentials',
        client_id: 'client 123',
        scope: 'https://graph.microsoft.com/.default',
      },
      5000,
    );

    const fetchInit = mockFetch.mock.calls[0][1] as RequestInit;
    expect(getHeaderValue(fetchInit.headers, 'Content-Type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(fetchInit.body).toBe(
      'grant_type=client_credentials&client_id=client+123&scope=https%3A%2F%2Fgraph.microsoft.com%2F.default',
    );

    vi.unstubAllGlobals();
  });

  it('should urlencode placeholders in form body_template', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://login.example.com/oauth2/token',
        method: 'POST',
        auth: { type: 'none' },
        body_type: 'form',
        body_template:
          'grant_type=client_credentials&client_id={{input.client_id}}&scope={{input.scope}}&claims={{input.claims}}',
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      {
        client_id: 'client+123',
        scope: 'read write:all',
        claims: { tenant: 'acme & sons' },
      },
      5000,
    );

    const fetchInit = mockFetch.mock.calls[0][1] as RequestInit;
    expect(getHeaderValue(fetchInit.headers, 'Content-Type')).toBe(
      'application/x-www-form-urlencoded',
    );
    expect(fetchInit.body).toBe(
      'grant_type=client_credentials&client_id=client%2B123&scope=read+write%3Aall&claims=%7B%22tenant%22%3A%22acme+%26+sons%22%7D',
    );

    vi.unstubAllGlobals();
  });

  it('should not include consumed {{input.X}} params in fallback body', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'POST',
        auth: { type: 'none' },
        query_params: { search: '{{input.query}}' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', { query: 'test', extra: 'value' }, 5000);

    const fetchUrl = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('search=test');

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody).toEqual({ extra: 'value' });
    expect(fetchBody.query).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('should handle query_params + path params + body coexisting correctly', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/users/{userId}/orders',
        method: 'POST',
        auth: { type: 'none' },
        query_params: { status: '{{input.filterStatus}}', apiKey: '{{secrets.api_key_token}}' },
        body_template: '{"item": "{{input.itemName}}", "qty": {{input.quantity}}}',
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      { userId: '42', filterStatus: 'active', itemName: 'Widget', quantity: 3, extra: 'ignored' },
      5000,
    );

    const fetchUrl = mockFetch.mock.calls[0][0];
    // Path param substituted
    expect(fetchUrl).toContain('/users/42/orders');
    // Binding-level query params resolved
    expect(fetchUrl).toContain('status=active');
    expect(fetchUrl).toContain('apiKey=test-api-key');
    // Extra params NOT appended as query string (POST method)
    expect(fetchUrl).not.toContain('extra=');

    const fetchBody = mockFetch.mock.calls[0][1].body;
    // Body template resolved
    expect(fetchBody).toBe('{"item": "Widget", "qty": 3}');

    vi.unstubAllGlobals();
  });
});

// =============================================================================
// Inline auth_config fields (token, apiKey, clientSecret)
// =============================================================================

describe('Inline auth_config fields', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should use inline bearer token from auth.config.token', async () => {
    const secrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'MY_TOKEN') return 'resolved-bearer-token';
        return undefined;
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: {
          type: 'bearer',
          config: { token: '{{secrets.MY_TOKEN}}' },
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets });
    await executor.execute('test_api', {}, 5000);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(headers, 'Authorization')).toBe('Bearer resolved-bearer-token');

    vi.unstubAllGlobals();
  });

  it('should use inline API key from auth.config.apiKey', async () => {
    const secrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'MY_API_KEY') return 'resolved-api-key';
        return undefined;
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: {
          type: 'api_key',
          config: {
            apiKey: '{{secrets.MY_API_KEY}}',
            headerName: 'X-API-Key',
          },
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets });
    await executor.execute('test_api', {}, 5000);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(headers, 'X-API-Key')).toBe('resolved-api-key');

    vi.unstubAllGlobals();
  });

  it('should fall back to secrets provider when no inline token', async () => {
    const secrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'bearer_token') return 'fallback-token';
        return undefined;
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: {
          type: 'bearer',
          config: {}, // No inline token
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets });
    await executor.execute('test_api', {}, 5000);

    const headers = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(headers, 'Authorization')).toBe('Bearer fallback-token');

    vi.unstubAllGlobals();
  });
});

// =============================================================================
// _context Handling Tests
// =============================================================================

describe('_context handling', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should NOT include _context in GET query parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      { query: 'hello', _context: { api_key: 'ctx-key-123', session_id: 'sess-1' } },
      5000,
    );

    const fetchUrl: string = mockFetch.mock.calls[0][0];
    // Regular params appear in query string
    expect(fetchUrl).toContain('query=hello');
    // _context must NOT leak into query string
    expect(fetchUrl).not.toContain('_context');
    expect(fetchUrl).not.toContain('api_key');
    expect(fetchUrl).not.toContain('session_id');

    vi.unstubAllGlobals();
  });

  it('should NOT include context vars in POST body when the tool does not declare context', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'POST',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      { query: 'test', _context: { tenant_id: 't-1', locale: 'en-US' } },
      5000,
    );

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.query).toBe('test');
    expect(fetchBody.context).toBeUndefined();
    expect(fetchBody._context).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('should include context vars in POST body under "context" key when the tool declares context', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      parameters: [
        { name: 'query', type: 'string', required: true },
        { name: 'context', type: 'object', required: false },
      ],
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'POST',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      { query: 'test', _context: { tenant_id: 't-1', locale: 'en-US' } },
      5000,
    );

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(fetchBody.query).toBe('test');
    expect(fetchBody.context).toEqual({ tenant_id: 't-1', locale: 'en-US' });
    expect(fetchBody._context).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('should resolve {{_context.api_key}} placeholders in headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'GET',
        auth: { type: 'none' },
        headers: {
          'X-Api-Key': '{{_context.api_key}}',
          'X-Session': 'session-{{_context.session_id}}',
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      { _context: { api_key: 'my-secret-key', session_id: '42' } },
      5000,
    );

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'X-Api-Key')).toBe('my-secret-key');
    expect(getHeaderValue(fetchHeaders, 'X-Session')).toBe('session-42');

    vi.unstubAllGlobals();
  });

  it('should work normally when params have no _context (regression)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/data',
        method: 'POST',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', { query: 'test', limit: 10 }, 5000);

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    // All params in body, no "context" key injected
    expect(fetchBody).toEqual({ query: 'test', limit: 10 });
    expect(fetchBody.context).toBeUndefined();

    vi.unstubAllGlobals();
  });
});

// =============================================================================
// SearchAI Auth Type Tests
// =============================================================================

describe('SearchAI Auth Type', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve searchai token from env var via headers', async () => {
    const searchaiSecrets: SecretsProvider = {
      async getSecret() {
        return undefined;
      },
      async getEnvVar(key: string) {
        if (key === 'AFG_SEARCHAI_TOKEN') return 'env-jwt-token-123';
        return undefined;
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"results":[]}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://searchai.example.com/search',
        method: 'POST',
        auth: {
          type: 'searchai',
          config: { headerName: 'Auth' },
        },
        headers: {
          Auth: '{{env.AFG_SEARCHAI_TOKEN}}',
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: searchaiSecrets });
    await executor.execute('test_api', { query: 'test' }, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'Auth')).toBe('env-jwt-token-123');

    vi.unstubAllGlobals();
  });

  it('should resolve searchai token from secrets provider fallback', async () => {
    const searchaiSecrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'searchai_token') return 'secret-jwt-token-456';
        return undefined;
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"results":[]}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://searchai.example.com/search',
        method: 'POST',
        auth: {
          type: 'searchai',
          config: { headerName: 'Auth' },
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: searchaiSecrets });
    await executor.execute('test_api', { query: 'test' }, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'Auth')).toBe('secret-jwt-token-456');

    vi.unstubAllGlobals();
  });

  it('should throw TOOL_AUTH_FAILED when no searchai token is available', async () => {
    const emptySecrets: SecretsProvider = {
      async getSecret() {
        return undefined;
      },
      async getEnvVar() {
        return undefined;
      },
    };

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://searchai.example.com/search',
        method: 'POST',
        auth: {
          type: 'searchai',
          config: { headerName: 'Auth' },
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: emptySecrets });
    await expect(executor.execute('test_api', { query: 'test' }, 5000)).rejects.toThrow(
      'SearchAI token not found',
    );
  });

  it('should fetch token from token endpoint when searchai config has tokenUrl', async () => {
    const getSecret = vi.fn(async (key: string) => {
      if (key === 'SEARCHAI_CLIENT_ID') return 'my-client-id';
      if (key === 'SEARCHAI_SECRET') return 'my-client-secret';
      return undefined;
    });
    const searchaiSecrets: SecretsProvider = { getSecret };

    const mockFetch = vi
      .fn()
      // First call: token endpoint
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ jwt: 'fresh-jwt-token', expires_in: 3600 }),
      })
      // Second call: actual API
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: () => Promise.resolve('{"results":[]}'),
      });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://searchai.example.com/search',
        method: 'POST',
        auth: {
          type: 'searchai',
          config: {
            headerName: 'Auth',
            searchai: {
              tokenUrl: 'https://platform.example.com/api/jwt/generate',
              clientId: '{{secrets.SEARCHAI_CLIENT_ID}}',
              clientSecret: '{{secrets.SEARCHAI_SECRET}}',
              headerName: 'Auth',
            },
          },
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: searchaiSecrets });
    await executor.execute('test_api', { query: 'test' }, 5000);

    // Verify token endpoint was called with correct body
    const tokenCall = mockFetch.mock.calls[0];
    expect(tokenCall[0]).toBe('https://platform.example.com/api/jwt/generate');
    const tokenBody = JSON.parse(tokenCall[1].body);
    expect(tokenBody.clientId).toBe('my-client-id');
    expect(tokenBody.clientSecret).toBe('my-client-secret');
    expect(getSecret).toHaveBeenCalledWith('SEARCHAI_CLIENT_ID', { toolName: 'test_api' });
    expect(getSecret).toHaveBeenCalledWith('SEARCHAI_SECRET', { toolName: 'test_api' });

    // Verify API call used the fetched token
    const apiHeaders = mockFetch.mock.calls[1][1].headers;
    expect(getHeaderValue(apiHeaders, 'Auth')).toBe('fresh-jwt-token');

    vi.unstubAllGlobals();
  });

  it('should cache searchai token and reuse on subsequent calls', async () => {
    const searchaiSecrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'searchai_client_secret') return 'my-client-secret';
        return undefined;
      },
    };

    const mockFetch = vi
      .fn()
      // Token endpoint (called once)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ jwt: 'cached-jwt-token', expires_in: 3600 }),
      })
      // First API call
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: () => Promise.resolve('{"results":[]}'),
      })
      // Second API call (no token fetch needed)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: () => Promise.resolve('{"results":[]}'),
      });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://searchai.example.com/search',
        method: 'POST',
        auth: {
          type: 'searchai',
          config: {
            headerName: 'Auth',
            searchai: {
              tokenUrl: 'https://platform.example.com/api/jwt/generate',
              clientId: 'my-client-id',
              headerName: 'Auth',
            },
          },
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: searchaiSecrets });
    await executor.execute('test_api', { query: 'test1' }, 5000);
    await executor.execute('test_api', { query: 'test2' }, 5000);

    // Token endpoint called only once, API called twice
    expect(mockFetch).toHaveBeenCalledTimes(3);
    // Both API calls use the cached token
    expect(getHeaderValue(mockFetch.mock.calls[1][1].headers, 'Auth')).toBe('cached-jwt-token');
    expect(getHeaderValue(mockFetch.mock.calls[2][1].headers, 'Auth')).toBe('cached-jwt-token');

    vi.unstubAllGlobals();
  });

  it('should retry on 401 with fresh token for searchai auth', async () => {
    const searchaiSecrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'searchai_client_secret') return 'my-client-secret';
        return undefined;
      },
    };

    let tokenCallCount = 0;
    const mockFetch = vi
      .fn()
      // First token fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => {
          tokenCallCount++;
          return Promise.resolve({ jwt: 'expired-token', expires_in: 3600 });
        },
      })
      // First API call returns 401
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers({ 'content-type': 'text/plain' }),
        text: () => Promise.resolve('Unauthorized'),
      })
      // Second token fetch (after invalidation)
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => {
          tokenCallCount++;
          return Promise.resolve({ jwt: 'fresh-token', expires_in: 3600 });
        },
      })
      // Second API call succeeds
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: null,
        text: () => Promise.resolve('{"results":["success"]}'),
      });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://searchai.example.com/search',
        method: 'POST',
        auth: {
          type: 'searchai',
          config: {
            headerName: 'Auth',
            searchai: {
              tokenUrl: 'https://platform.example.com/api/jwt/generate',
              clientId: 'my-client-id',
              headerName: 'Auth',
            },
          },
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: searchaiSecrets });
    const result = await executor.execute('test_api', { query: 'test' }, 5000);

    expect(result).toEqual({ results: ['success'] });
    // Token was fetched twice (initial + refresh after 401)
    expect(tokenCallCount).toBe(2);
    // Total 4 fetch calls: token, 401 API, token refresh, successful API
    expect(mockFetch).toHaveBeenCalledTimes(4);

    vi.unstubAllGlobals();
  });

  it('should not retry 401 more than once for searchai auth', async () => {
    const searchaiSecrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'searchai_client_secret') return 'my-client-secret';
        return undefined;
      },
    };

    const mockFetch = vi
      .fn()
      // First token fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ jwt: 'token-1', expires_in: 3600 }),
      })
      // First API call returns 401
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: () => Promise.resolve('Unauthorized'),
      })
      // Second token fetch
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ jwt: 'token-2', expires_in: 3600 }),
      })
      // Second API call also returns 401 (credentials are wrong, not just expired)
      .mockResolvedValueOnce({
        ok: false,
        status: 401,
        headers: new Headers(),
        text: () => Promise.resolve('Unauthorized'),
      });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://searchai.example.com/search',
        method: 'POST',
        auth: {
          type: 'searchai',
          config: {
            headerName: 'Auth',
            searchai: {
              tokenUrl: 'https://platform.example.com/api/jwt/generate',
              clientId: 'my-client-id',
              headerName: 'Auth',
            },
          },
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: searchaiSecrets });
    await expect(executor.execute('test_api', { query: 'test' }, 5000)).rejects.toThrow('HTTP 401');

    vi.unstubAllGlobals();
  });

  it('should use default Auth header name when not specified', async () => {
    const searchaiSecrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'searchai_token') return 'default-header-token';
        return undefined;
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://searchai.example.com/search',
        method: 'POST',
        auth: {
          type: 'searchai',
          // No headerName specified — should default to 'Auth'
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: searchaiSecrets });
    await executor.execute('test_api', { query: 'test' }, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'Auth')).toBe('default-header-token');

    vi.unstubAllGlobals();
  });

  it('should resolve tool-scoped searchai secret before generic', async () => {
    const searchaiSecrets: SecretsProvider = {
      async getSecret(key: string) {
        if (key === 'searchai_token_test_api') return 'tool-scoped-token';
        if (key === 'searchai_token') return 'generic-token';
        return undefined;
      },
    };

    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://searchai.example.com/search',
        method: 'POST',
        auth: {
          type: 'searchai',
          config: { headerName: 'Auth' },
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: searchaiSecrets });
    await executor.execute('test_api', { query: 'test' }, 5000);

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'Auth')).toBe('tool-scoped-token');

    vi.unstubAllGlobals();
  });
});

// =============================================================================
// _session Placeholder Tests
// =============================================================================

describe('{{session.X}} placeholder resolution', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('should resolve {{session.id}} in query_params', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
        query_params: {
          sessionId: '{{session.id}}',
          tenant: '{{session.tenantId}}',
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      {
        query: 'hello',
        _session: {
          id: 'sess-abc-123',
          tenantId: 'tenant-xyz',
          projectId: 'proj-1',
          agentName: 'advisor',
        },
      },
      5000,
    );

    const fetchUrl: string = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('sessionId=sess-abc-123');
    expect(fetchUrl).toContain('tenant=tenant-xyz');
    // _session must NOT leak into query string
    expect(fetchUrl).not.toContain('_session');

    vi.unstubAllGlobals();
  });

  it('should resolve {{session.X}} in headers', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
        headers: {
          'X-Session-Id': '{{session.id}}',
          'X-Tenant': '{{session.tenantId}}',
          'X-Agent': 'agent-{{session.agentName}}',
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      {
        _session: {
          id: 'sess-456',
          tenantId: 'tenant-abc',
          projectId: 'proj-2',
          agentName: 'support',
        },
      },
      5000,
    );

    const fetchHeaders = mockFetch.mock.calls[0][1].headers;
    expect(getHeaderValue(fetchHeaders, 'X-Session-Id')).toBe('sess-456');
    expect(getHeaderValue(fetchHeaders, 'X-Tenant')).toBe('tenant-abc');
    expect(getHeaderValue(fetchHeaders, 'X-Agent')).toBe('agent-support');

    vi.unstubAllGlobals();
  });

  it('should resolve {{session.X}} in endpoint URL', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/tenants/{{session.tenantId}}/search',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      {
        query: 'hello',
        _session: { id: 'sess-1', tenantId: 'tenant-99', projectId: 'p1', agentName: 'bot' },
      },
      5000,
    );

    const fetchUrl: string = mockFetch.mock.calls[0][0];
    expect(fetchUrl).toContain('/tenants/tenant-99/search');

    vi.unstubAllGlobals();
  });

  it('should resolve {{session.X}} in body_template', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/search',
        method: 'POST',
        auth: { type: 'none' },
        body_template:
          '{"sessionId":"{{session.id}}","agent":"{{session.agentName}}","q":"{{input.query}}"}',
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      {
        query: 'find products',
        _session: { id: 'sess-body-1', tenantId: 't-1', projectId: 'p-1', agentName: 'advisor' },
      },
      5000,
    );

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(fetchBody.sessionId).toBe('sess-body-1');
    expect(fetchBody.agent).toBe('advisor');
    expect(fetchBody.q).toBe('find products');

    vi.unstubAllGlobals();
  });

  it('should NOT include _session in POST body when no body_template', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/search',
        method: 'POST',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute(
      'test_api',
      {
        query: 'test',
        _session: { id: 'sess-strip', tenantId: 't-1', projectId: 'p-1', agentName: 'bot' },
      },
      5000,
    );

    const fetchBody = JSON.parse(mockFetch.mock.calls[0][1].body as string);
    expect(fetchBody.query).toBe('test');
    // _session must NOT appear in the body
    expect(fetchBody._session).toBeUndefined();

    vi.unstubAllGlobals();
  });

  it('should handle missing _session gracefully (no placeholders resolved)', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
        query_params: {
          sessionId: '{{session.id}}',
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    // No _session in params — placeholders resolve to empty string
    await executor.execute('test_api', { query: 'hello' }, 5000);

    const fetchUrl: string = mockFetch.mock.calls[0][0];
    // Session placeholder resolves to empty string when _session is absent
    expect(fetchUrl).toContain('sessionId=');
    expect(fetchUrl).not.toContain('sess-');

    vi.unstubAllGlobals();
  });

  it('should pass auth-profile mTLS tls_options to safeFetch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);
    (HttpToolExecutor as any)._undiciModule = null;

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://mtls.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
        tls_options: {
          cert: VALID_MTLS_CERT,
          key: VALID_MTLS_KEY,
          ca: VALID_MTLS_CERT,
          rejectUnauthorized: true,
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', { query: 'hello' }, 5000);

    expect(mockSafeFetch).toHaveBeenCalledWith(
      'https://mtls.example.com/search?query=hello',
      expect.any(Object),
      expect.objectContaining({
        tls: expect.objectContaining({
          cert: VALID_MTLS_CERT,
          key: VALID_MTLS_KEY,
          ca: VALID_MTLS_CERT,
          rejectUnauthorized: true,
        }),
      }),
    );

    vi.unstubAllGlobals();
  });

  it('should route proxy-matched tools through ProxyAgent without leaking proxy auth to origin headers', async () => {
    mockSafeFetch.mockClear();
    mockAssertUrlSafeForFetch.mockClear();
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const proxyAgentConstructor = vi.fn().mockImplementation(function ProxyAgent(
      this: any,
      options: unknown,
    ) {
      this.options = options;
      this.close = vi.fn();
    });
    (HttpToolExecutor as any)._undiciModule = { ProxyAgent: proxyAgentConstructor };

    const proxyResolver = {
      resolve: vi.fn(() => ({
        proxyUrl: 'https://proxy.example.com:8443',
        authType: 'basic' as const,
        username: 'proxy-user',
        password: 'proxy-pass',
      })),
      applyProxyAuth: vi.fn(),
    };

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      proxyResolver: proxyResolver as any,
    });
    await executor.execute('test_api', { query: 'hello' }, 5000);

    const expectedToken = `Basic ${Buffer.from('proxy-user:proxy-pass').toString('base64')}`;
    expect(proxyAgentConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        uri: 'https://proxy.example.com:8443',
        token: expectedToken,
      }),
    );
    expect(proxyResolver.applyProxyAuth).not.toHaveBeenCalled();
    expect(mockSafeFetch).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls[0][0]).toBe('https://api.example.com/search?query=hello');
    expect(mockFetch.mock.calls[0][1].dispatcher).toBeDefined();
    expect(new Headers(mockFetch.mock.calls[0][1].headers).has('Proxy-Authorization')).toBe(false);

    vi.unstubAllGlobals();
  });

  it('should not treat proxied 304 responses as redirects', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 304,
      ok: false,
      headers: new Headers({ 'content-type': 'text/plain' }),
      body: null,
      text: () => Promise.resolve('not modified'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const proxyAgentConstructor = vi.fn().mockImplementation(function ProxyAgent(this: any) {
      this.close = vi.fn();
    });
    (HttpToolExecutor as any)._undiciModule = { ProxyAgent: proxyAgentConstructor };

    const proxyResolver = {
      resolve: vi.fn(() => ({
        proxyUrl: 'https://proxy.example.com:8443',
        authType: 'none' as const,
      })),
      applyProxyAuth: vi.fn(),
    };

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://api.example.com/cacheable',
        method: 'GET',
        auth: { type: 'none' },
      },
    });

    const executor = new HttpToolExecutor({
      tools: [tool],
      secrets: mockSecrets,
      proxyResolver: proxyResolver as any,
    });

    await expect(executor.execute('test_api', {}, 5000)).rejects.toThrow('HTTP 304');
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });

  it('should fail closed when mTLS certificate material is invalid', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://mtls.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
        tls_options: {
          cert: 'bad-cert',
          key: 'bad-key',
          rejectUnauthorized: true,
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await expect(executor.execute('test_api', { query: 'hello' }, 5000)).rejects.toThrow(
      'mTLS client certificate or private key is invalid',
    );
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('should execute non-proxy mTLS requests even when undici is unavailable', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      json: () => Promise.resolve({ ok: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    (HttpToolExecutor as any)._undiciModule = null;

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://mtls.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
        tls_options: {
          cert: VALID_MTLS_CERT,
          key: VALID_MTLS_KEY,
          rejectUnauthorized: true,
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await expect(executor.execute('test_api', { query: 'hello' }, 5000)).resolves.toEqual(
      expect.objectContaining({ ok: true }),
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockSafeFetch).toHaveBeenCalledTimes(1);
    expect(mockSafeFetch.mock.calls[0]?.[2]).toMatchObject({
      tls: {
        cert: VALID_MTLS_CERT,
        key: VALID_MTLS_KEY,
        rejectUnauthorized: true,
      },
    });

    vi.unstubAllGlobals();
  });

  it('should fail closed when mTLS is configured on a plain HTTP endpoint', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'http://mtls.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
        tls_options: {
          cert: 'CLIENT_CERT',
          key: 'CLIENT_KEY',
          rejectUnauthorized: true,
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await expect(executor.execute('test_api', { query: 'hello' }, 5000)).rejects.toThrow(
      'mTLS auth requires an https:// endpoint on the HTTP tool path',
    );
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('should sign AWS IAM requests before dispatch', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      status: 200,
      ok: true,
      headers: new Headers({ 'content-type': 'application/json' }),
      body: null,
      text: () => Promise.resolve('{"ok":true}'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://execute-api.us-east-1.amazonaws.com/prod/resource?fixed=1',
        method: 'POST',
        auth: { type: 'none' },
        headers: {
          'X-Custom-Header': 'custom-value',
        },
        sigv4_auth: {
          accessKeyId: 'AKIA_TEST',
          secretAccessKey: 'secret-key',
          sessionToken: 'session-token',
          region: 'us-east-1',
          service: 'execute-api',
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await executor.execute('test_api', { query: 'hello' }, 5000);

    const fetchCall = mockFetch.mock.calls[0];
    const headers = fetchCall[1].headers as Record<string, string>;
    const authorization = headers['Authorization'] ?? headers['authorization'];
    const amzDate = headers['X-Amz-Date'] ?? headers['x-amz-date'];
    const securityToken = headers['X-Amz-Security-Token'] ?? headers['x-amz-security-token'];

    expect(authorization).toContain('AWS4-HMAC-SHA256');
    expect(authorization).toContain('/us-east-1/execute-api/aws4_request');
    expect(amzDate).toBeTruthy();
    expect(securityToken).toBe('session-token');
    expect(headers['X-Custom-Header'] ?? headers['x-custom-header']).toBe('custom-value');

    vi.unstubAllGlobals();
  });

  it('should fail closed when AWS IAM signing context is incomplete', async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal('fetch', mockFetch);

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://execute-api.us-east-1.amazonaws.com/prod/resource',
        method: 'GET',
        auth: { type: 'none' },
        sigv4_auth: {
          accessKeyId: 'AKIA_TEST',
          secretAccessKey: 'secret-key',
          region: 'us-east-1',
        } as any,
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await expect(executor.execute('test_api', { query: 'hello' }, 5000)).rejects.toThrow(
      'AWS IAM auth requires both region and service before a request can be signed.',
    );
    expect(mockFetch).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
  });

  it('should surface expired mTLS certificates as auth failures', async () => {
    const tlsExpiredError = Object.assign(new Error('certificate has expired'), {
      code: 'CERT_HAS_EXPIRED',
    });
    const mockFetch = vi.fn().mockRejectedValue(tlsExpiredError);
    vi.stubGlobal('fetch', mockFetch);

    (HttpToolExecutor as any)._undiciModule = null;

    const tool = createHttpTool({
      http_binding: {
        endpoint: 'https://mtls.example.com/search',
        method: 'GET',
        auth: { type: 'none' },
        retry: { count: 2, delay_ms: 1 },
        tls_options: {
          cert: VALID_MTLS_CERT,
          key: VALID_MTLS_KEY,
          rejectUnauthorized: true,
        },
      },
    });

    const executor = new HttpToolExecutor({ tools: [tool], secrets: mockSecrets });
    await expect(executor.execute('test_api', { query: 'hello' }, 5000)).rejects.toThrow(
      'mTLS client certificate has expired',
    );
    expect(mockFetch).toHaveBeenCalledTimes(1);

    vi.unstubAllGlobals();
  });
});
