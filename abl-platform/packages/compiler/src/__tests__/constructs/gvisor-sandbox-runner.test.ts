/**
 * GvisorSandboxRunner Tests
 *
 * Tests the direct gvisor pod runner that bypasses the tool service middleware.
 * Covers: pod URL selection, $-prefix preprocessing, request body format,
 * JWT auth, response mapping, error handling, code loading, caching,
 * response size limits, timeout, and SSRF validation.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { GvisorSandboxRunner } from '../../platform/constructs/executors/gvisor-sandbox-runner.js';
import type {
  GvisorSandboxConfig,
  GvisorSessionContext,
} from '../../platform/constructs/executors/gvisor-sandbox-runner.js';

// =============================================================================
// HELPERS
// =============================================================================

const DEFAULT_CONFIG: GvisorSandboxConfig = {
  pythonPodUrl: 'http://kr-python-svc',
  javascriptPodUrl: 'http://kr-javascript-svc',
  podPath: '/execute-script',
};

const DEFAULT_SESSION: GvisorSessionContext = {
  tenantId: 'tenant-1',
  sessionId: 'session-1',
  userId: 'user-1',
};

function createRunConfig(
  overrides: Partial<{
    functionName: string;
    codeContent: string;
    runtime: 'javascript' | 'python';
    params: unknown;
    limits: { timeoutMs: number; memoryMb: number };
  }> = {},
) {
  return {
    functionName: 'calculate_risk',
    codeContent: 'function run(input) { return input; }',
    runtime: 'javascript' as const,
    params: { income: 50000, region: 'US' },
    limits: { timeoutMs: 5000, memoryMb: 128 },
    ...overrides,
  };
}

/**
 * Mock a successful gvisor pod response.
 * Pod returns { response, logs, error } — note field is `response` not `result`.
 */
function mockFetchOk(result: unknown, logs: string[] = [], error?: string) {
  const json = JSON.stringify({ response: result, logs, error });
  const encoded = new TextEncoder().encode(json);
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({
        'content-type': 'application/json',
        'content-length': String(encoded.byteLength),
      }),
      body: {
        getReader: () => {
          let consumed = false;
          return {
            read: () => {
              if (consumed) return Promise.resolve({ done: true, value: undefined });
              consumed = true;
              return Promise.resolve({ done: false, value: encoded });
            },
            cancel: vi.fn(),
            releaseLock: vi.fn(),
          };
        },
      },
    }),
  );
}

function mockFetchError(status: number, body = 'Internal Server Error') {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      headers: new Headers(),
      text: () => Promise.resolve(body),
    }),
  );
}

// =============================================================================
// TESTS
// =============================================================================

describe('GvisorSandboxRunner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  // ---------------------------------------------------------------------------
  // Construction & URL validation
  // ---------------------------------------------------------------------------

  describe('constructor', () => {
    it('should construct with valid config', () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      expect(runner).toBeDefined();
    });

    it('should accept private IP ranges and Kubernetes service names', () => {
      for (const url of [
        'http://10.0.1.5',
        'http://172.16.0.1',
        'http://192.168.1.100',
        'http://kr-python-svc',
        'http://localhost',
      ]) {
        expect(
          () =>
            new GvisorSandboxRunner({
              ...DEFAULT_CONFIG,
              pythonPodUrl: url,
              javascriptPodUrl: url,
            }),
        ).not.toThrow();
      }
    });

    it('should warn for non-internal hosts (but not throw)', () => {
      const runner = new GvisorSandboxRunner({
        ...DEFAULT_CONFIG,
        pythonPodUrl: 'http://external.example.com',
      });
      expect(runner).toBeDefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Pod URL selection
  // ---------------------------------------------------------------------------

  describe('pod URL selection', () => {
    it('should route javascript runtime to javascriptPodUrl', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify({ score: 0.85 }));

      await runner.run(createRunConfig({ runtime: 'javascript' }));

      const callUrl = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(callUrl).toBe('http://kr-javascript-svc/execute-script');
    });

    it('should route python runtime to pythonPodUrl', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify({ sentiment: 'positive' }));

      await runner.run(
        createRunConfig({ runtime: 'python', codeContent: 'def run(input): return input' }),
      );

      const callUrl = vi.mocked(fetch).mock.calls[0][0] as string;
      expect(callUrl).toBe('http://kr-python-svc/execute-script');
    });
  });

  // ---------------------------------------------------------------------------
  // $-prefix preprocessing
  // ---------------------------------------------------------------------------

  describe('$-prefix preprocessing', () => {
    it('should $-prefix all input keys for javascript runtime', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(
        createRunConfig({
          runtime: 'javascript',
          params: { name: 'John', age: 30 },
        }),
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.args).toEqual({ $name: 'John', $age: 30 });
    });

    it('should filter "thought" system param from javascript input', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(
        createRunConfig({
          runtime: 'javascript',
          params: { name: 'John', thought: 'internal reasoning' },
        }),
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.args).toEqual({ $name: 'John' });
      expect(body.args).not.toHaveProperty('$thought');
      expect(body.args).not.toHaveProperty('thought');
    });

    it('should NOT $-prefix input keys for python runtime', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(
        createRunConfig({
          runtime: 'python',
          codeContent: 'def run(input): return input',
          params: { name: 'John', age: 30 },
        }),
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.args).toEqual({ name: 'John', age: 30 });
    });

    it('should passthrough non-object params for javascript', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(
        createRunConfig({
          runtime: 'javascript',
          params: 'just a string',
        }),
      );

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.args).toBe('just a string');
    });
  });

  // ---------------------------------------------------------------------------
  // Request body format
  // ---------------------------------------------------------------------------

  describe('request body format', () => {
    it('should send correct /execute-script request body', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify({ score: 0.85 }));

      await runner.run(createRunConfig());

      const callArgs = vi.mocked(fetch).mock.calls[0];
      const body = JSON.parse(callArgs[1]!.body as string);

      expect(body.script).toBe('function run(input) { return input; }');
      expect(body.args).toEqual({ $income: 50000, $region: 'US' });
      expect(body.envParams).toBe(JSON.stringify({}));
      expect(body.executionMode).toBe('execute');
      expect(body.mockMemoryData).toEqual({});
      expect(body.codeType).toBe('javascript');
    });

    it('should set Content-Type header', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(createRunConfig());

      const callArgs = vi.mocked(fetch).mock.calls[0];
      expect(callArgs[1]!.headers).toHaveProperty('Content-Type', 'application/json');
    });
  });

  // ---------------------------------------------------------------------------
  // JWT Authentication
  // ---------------------------------------------------------------------------

  describe('JWT authentication', () => {
    it('should set Authorization header when jwtSigner is provided', async () => {
      const jwtSigner = vi.fn().mockResolvedValue('jwt-token-123');
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG, DEFAULT_SESSION, jwtSigner);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(createRunConfig());

      const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers['Authorization']).toBe('jwt-token-123');
    });

    it('should NOT set Authorization header when jwtSigner is absent', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG, DEFAULT_SESSION);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(createRunConfig());

      const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });

    it('should pass session context claims to jwtSigner (including appvId)', async () => {
      const jwtSigner = vi.fn().mockResolvedValue('token');
      const session: GvisorSessionContext = {
        tenantId: 'tenant-1',
        sessionId: 'sess-1',
        userId: 'user-1',
        accountId: 'acct-1',
        appvId: 'appv-1',
        projectId: 'proj-1',
        envId: 'env-1',
      };
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG, session, jwtSigner);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(createRunConfig());

      expect(jwtSigner).toHaveBeenCalledWith({
        sessionId: 'sess-1',
        userId: 'user-1',
        accountId: 'acct-1',
        appvId: 'appv-1',
        projectId: 'proj-1',
        envId: 'env-1',
      });
    });

    it('should continue without auth when jwtSigner throws', async () => {
      const jwtSigner = vi.fn().mockRejectedValue(new Error('signing failed'));
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG, DEFAULT_SESSION, jwtSigner);
      mockFetchOk(JSON.stringify('ok'));

      // Should not throw — falls back to no auth
      const result = await runner.run(createRunConfig());
      expect(result).toEqual('ok');

      const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers['Authorization']).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant header
  // ---------------------------------------------------------------------------

  describe('tenant header', () => {
    it('should set X-Tenant-Id header when tenantId is provided', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG, DEFAULT_SESSION);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(createRunConfig());

      const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers['X-Tenant-Id']).toBe('tenant-1');
    });

    it('should not set X-Tenant-Id when no session context', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(createRunConfig());

      const headers = vi.mocked(fetch).mock.calls[0][1]!.headers as Record<string, string>;
      expect(headers['X-Tenant-Id']).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Pod response mapping
  // ---------------------------------------------------------------------------

  describe('pod response mapping', () => {
    it('should map response.response field to result', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify({ score: 0.85 }));

      const result = await runner.run(createRunConfig());
      expect(result).toEqual({ score: 0.85 });
    });

    it('should return string result when not valid JSON', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk('plain text result');

      const result = await runner.run(createRunConfig());
      expect(result).toBe('plain text result');
    });

    it('should return non-string result as-is', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(42);

      const result = await runner.run(createRunConfig());
      expect(result).toBe(42);
    });

    it('should throw when pod response has non-empty error field', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk('some result', [], 'execution failed: timeout');

      await expect(runner.run(createRunConfig())).rejects.toThrow('execution failed: timeout');
    });

    it('should throw on [Error] prefixed result', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk('[Error] SyntaxError: Unexpected token');

      await expect(runner.run(createRunConfig())).rejects.toThrow(
        '[Error] SyntaxError: Unexpected token',
      );
    });

    it('should throw on missing response field', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      const json = JSON.stringify({ logs: [] });
      const encoded = new TextEncoder().encode(json);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-length': String(encoded.byteLength) }),
          body: {
            getReader: () => {
              let consumed = false;
              return {
                read: () => {
                  if (consumed) return Promise.resolve({ done: true, value: undefined });
                  consumed = true;
                  return Promise.resolve({ done: false, value: encoded });
                },
                cancel: vi.fn(),
                releaseLock: vi.fn(),
              };
            },
          },
        }),
      );

      await expect(runner.run(createRunConfig())).rejects.toThrow(
        'Gvisor pod returned invalid response',
      );
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling
  // ---------------------------------------------------------------------------

  describe('error handling', () => {
    it('should throw on HTTP 500 with generic message', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchError(500);

      await expect(runner.run(createRunConfig())).rejects.toThrow(
        'Code tool internal error for tool "calculate_risk"',
      );
    });

    it('should throw on HTTP 4xx with configuration message', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchError(400, 'bad request details');

      await expect(runner.run(createRunConfig())).rejects.toThrow(
        'Code tool rejected request for tool "calculate_risk" — check tool configuration',
      );
    });

    it('should not leak response body or status code', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchError(500, 'secret-internal-stack-trace');

      try {
        await runner.run(createRunConfig());
      } catch (err) {
        expect((err as Error).message).not.toContain('secret-internal-stack-trace');
        expect((err as Error).message).not.toContain('500');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Timeout
  // ---------------------------------------------------------------------------

  describe('timeout', () => {
    it('should pass AbortSignal to fetch', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(createRunConfig({ limits: { timeoutMs: 3000, memoryMb: 128 } }));

      const callArgs = vi.mocked(fetch).mock.calls[0];
      expect(callArgs[1]!.signal).toBeDefined();
    });

    it('should surface AbortError as clear timeout message', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      const abortError = new Error('The operation was aborted');
      abortError.name = 'AbortError';
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(abortError));

      await expect(runner.run(createRunConfig())).rejects.toThrow(
        'Sandbox tool "calculate_risk" timed out after 5000ms',
      );
    });

    it('should fall back to config.timeoutMs when limits.timeoutMs is 0', async () => {
      const runner = new GvisorSandboxRunner({ ...DEFAULT_CONFIG, timeoutMs: 15000 });
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(createRunConfig({ limits: { timeoutMs: 0, memoryMb: 128 } }));
      expect(fetch).toHaveBeenCalled();
    });
  });

  // ---------------------------------------------------------------------------
  // Code loading
  // ---------------------------------------------------------------------------

  describe('code loading', () => {
    it('should send inline codeContent directly to the pod', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(createRunConfig({ codeContent: 'function calc(x) { return x * 2; }' }));

      const body = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      expect(body.script).toBe('function calc(x) { return x * 2; }');
    });

    it('should throw when codeContent is empty', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      await expect(runner.run(createRunConfig({ codeContent: '' }))).rejects.toThrow(
        /no code content/i,
      );
    });

    it('should use codeContent for every call', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      mockFetchOk(JSON.stringify('ok'));

      await runner.run(createRunConfig({ codeContent: 'code_v1()' }));
      await runner.run(createRunConfig({ codeContent: 'code_v2()' }));

      const body1 = JSON.parse(vi.mocked(fetch).mock.calls[0][1]!.body as string);
      const body2 = JSON.parse(vi.mocked(fetch).mock.calls[1][1]!.body as string);
      expect(body1.script).toBe('code_v1()');
      expect(body2.script).toBe('code_v2()');
    });
  });

  // ---------------------------------------------------------------------------
  // Response size limits
  // ---------------------------------------------------------------------------

  describe('response size limits', () => {
    it('should reject response when Content-Length exceeds limit', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers({ 'content-length': String(10 * 1024 * 1024) }),
          body: {
            getReader: () => ({
              read: () => Promise.resolve({ done: true, value: undefined }),
              cancel: vi.fn(),
              releaseLock: vi.fn(),
            }),
          },
        }),
      );

      await expect(runner.run(createRunConfig())).rejects.toThrow('Gvisor pod response too large');
    });

    it('should reject streaming response exceeding limit', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      const bigChunk = new Uint8Array(3 * 1024 * 1024);
      let callCount = 0;
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers(),
          body: {
            getReader: () => ({
              read: () => {
                callCount++;
                if (callCount > 2) return Promise.resolve({ done: true, value: undefined });
                return Promise.resolve({ done: false, value: bigChunk });
              },
              cancel: vi.fn(),
              releaseLock: vi.fn(),
            }),
          },
        }),
      );

      await expect(runner.run(createRunConfig())).rejects.toThrow('Gvisor pod response too large');
    });

    it('should fall back to text() when body has no getReader', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      const json = JSON.stringify({ response: 'ok', logs: [] });
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers(),
          body: null,
          text: () => Promise.resolve(json),
        }),
      );

      const result = await runner.run(createRunConfig());
      expect(result).toBe('ok');
    });

    it('should throw descriptive error when pod returns empty body (no reader)', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers(),
          body: null,
          text: () => Promise.resolve(''),
        }),
      );

      await expect(runner.run(createRunConfig())).rejects.toThrow(/empty.*response/i);
    });

    it('should throw descriptive error when streaming body is empty', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({
          ok: true,
          headers: new Headers(),
          body: {
            getReader: () => ({
              read: () => Promise.resolve({ done: true, value: undefined }),
              cancel: vi.fn(),
              releaseLock: vi.fn(),
            }),
          },
        }),
      );

      await expect(runner.run(createRunConfig())).rejects.toThrow(/empty.*response/i);
    });
  });

  // ---------------------------------------------------------------------------
  // Code size validation
  // ---------------------------------------------------------------------------

  describe('code size validation', () => {
    it('should reject code that exceeds size limit', async () => {
      const runner = new GvisorSandboxRunner(DEFAULT_CONFIG);
      const hugeCode = 'x'.repeat(2 * 1024 * 1024); // 2MB

      await expect(runner.run(createRunConfig({ codeContent: hugeCode }))).rejects.toThrow(
        /code.*exceeds.*size/i,
      );
    });
  });
});
