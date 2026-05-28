/**
 * LambdaSandboxRunner Tests
 *
 * Tests the strict execution contract for the Lambda-based sandbox runner.
 * Covers:
 * - tenantId requirement
 * - Deployment store status validation (not deployed, deploying, failed, active)
 * - Code content validation (empty, oversized)
 * - $-prefix preprocessing for JavaScript runtime
 * - Health check gating
 * - Successful Lambda invocation and response parsing
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolExecutionError } from '@agent-platform/shared';
import { LambdaSandboxRunner } from '../../platform/constructs/executors/lambda-sandbox-runner.js';
import type {
  LambdaSandboxConfig,
  LambdaDeploymentStore,
  LambdaDeploymentRecord,
} from '../../platform/constructs/executors/lambda-sandbox-runner.js';
import type { GvisorSessionContext } from '../../platform/constructs/executors/gvisor-sandbox-runner.js';

// =============================================================================
// AWS SDK MOCK
// =============================================================================

vi.mock('@aws-sdk/client-lambda', () => {
  const MockLambdaClient = vi.fn().mockImplementation(function (this: any) {
    this.send = vi.fn();
  });
  const MockInvokeCommand = vi.fn().mockImplementation(function (this: any, input: any) {
    this.input = input;
  });
  return { LambdaClient: MockLambdaClient, InvokeCommand: MockInvokeCommand };
});

// =============================================================================
// HELPERS
// =============================================================================

const DEFAULT_CONFIG: LambdaSandboxConfig = {
  region: 'us-east-1',
  memoryApiBaseUrl: 'https://memory.example.com',
  healthTtlMs: 300_000,
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

function createActiveDeployment(
  overrides: Partial<LambdaDeploymentRecord> = {},
): LambdaDeploymentRecord {
  return {
    tenantId: 'tenant-1',
    runtime: 'javascript',
    functionName: 'abl-sandbox-tenant-1-javascript',
    status: 'active',
    region: 'us-east-1',
    createdAt: '2025-01-01T00:00:00.000Z',
    updatedAt: '2025-01-01T00:00:00.000Z',
    lastHealthCheck: new Date().toISOString(), // fresh health check
    ...overrides,
  };
}

function createMockStore(overrides: Partial<LambdaDeploymentStore> = {}): LambdaDeploymentStore {
  return {
    get: vi.fn().mockResolvedValue(createActiveDeployment()),
    upsert: vi.fn().mockResolvedValue(undefined),
    updateStatus: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    listByTenant: vi.fn().mockResolvedValue([]),
    ...overrides,
  };
}

function createMockLambdaClient(): any {
  return { send: vi.fn() };
}

/**
 * Build a mock Lambda response with the double-encoded structure:
 * outer: { statusCode, body: JSON string }
 * inner (body): { response, logs, error }
 */
function buildLambdaResponse(inner: { response?: unknown; logs?: string[]; error?: string }) {
  return {
    StatusCode: 200,
    Payload: new TextEncoder().encode(
      JSON.stringify({
        statusCode: 200,
        body: JSON.stringify(inner),
      }),
    ),
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('LambdaSandboxRunner', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation — tenantId required
  // ---------------------------------------------------------------------------

  describe('tenant isolation', () => {
    it('throws TOOL_SANDBOX_ERROR when tenantId is missing', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(DEFAULT_CONFIG, store, createMockLambdaClient()); // no session context

      try {
        await runner.run(createRunConfig());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_SANDBOX_ERROR');
        expect((err as ToolExecutionError).message).toContain('tenantId');
        expect((err as ToolExecutionError).retryable).toBe(false);
      }
    });

    it('throws TOOL_SANDBOX_ERROR when session context has no tenantId', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(DEFAULT_CONFIG, store, createMockLambdaClient(), {
        sessionId: 'sess-1',
        userId: 'user-1',
      });

      try {
        await runner.run(createRunConfig());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_SANDBOX_ERROR');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Code content validation
  // ---------------------------------------------------------------------------

  describe('code content validation', () => {
    it('throws TOOL_NOT_FOUND when code content is empty', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      try {
        await runner.run(createRunConfig({ codeContent: '' }));
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_NOT_FOUND');
        expect((err as ToolExecutionError).message).toContain('no code content');
      }
    });

    it('rejects code exceeding 1MB', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );
      const hugeCode = 'x'.repeat(1024 * 1024 + 1); // Just over 1MB

      try {
        await runner.run(createRunConfig({ codeContent: hugeCode }));
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_EXECUTION_ERROR');
        expect((err as ToolExecutionError).message).toContain('exceeds size limit');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Deployment status validation — strict contract
  // ---------------------------------------------------------------------------

  describe('deployment status validation', () => {
    it('throws TOOL_SANDBOX_NOT_DEPLOYED when no deployment exists', async () => {
      const store = createMockStore({
        get: vi.fn().mockResolvedValue(null),
      });
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      try {
        await runner.run(createRunConfig());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_SANDBOX_NOT_DEPLOYED');
        expect((err as ToolExecutionError).message).toContain('Deploy via Studio');
        expect((err as ToolExecutionError).retryable).toBe(false);
      }
    });

    it('throws TOOL_SANDBOX_DEPLOYING (retryable) when status is deploying', async () => {
      const store = createMockStore({
        get: vi.fn().mockResolvedValue(createActiveDeployment({ status: 'deploying' })),
      });
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      try {
        await runner.run(createRunConfig());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_SANDBOX_DEPLOYING');
        expect((err as ToolExecutionError).retryable).toBe(true);
        expect((err as ToolExecutionError).message).toContain('currently deploying');
      }
    });

    it('throws TOOL_SANDBOX_DEPLOY_FAILED when status is failed', async () => {
      const store = createMockStore({
        get: vi.fn().mockResolvedValue(
          createActiveDeployment({
            status: 'failed',
            failureReason: 'IAM role not found',
          }),
        ),
      });
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      try {
        await runner.run(createRunConfig());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_SANDBOX_DEPLOY_FAILED');
        expect((err as ToolExecutionError).message).toContain('IAM role not found');
        expect((err as ToolExecutionError).message).toContain('Redeploy via Studio');
        expect((err as ToolExecutionError).retryable).toBe(false);
      }
    });

    it('throws TOOL_SANDBOX_DEPLOY_FAILED with "unknown" when failureReason is missing', async () => {
      const store = createMockStore({
        get: vi.fn().mockResolvedValue(createActiveDeployment({ status: 'failed' })),
      });
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      try {
        await runner.run(createRunConfig());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_SANDBOX_DEPLOY_FAILED');
        expect((err as ToolExecutionError).message).toContain('unknown');
      }
    });

    it('throws TOOL_SANDBOX_ERROR for unexpected status (deleting)', async () => {
      const store = createMockStore({
        get: vi.fn().mockResolvedValue(createActiveDeployment({ status: 'deleting' })),
      });
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      try {
        await runner.run(createRunConfig());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_SANDBOX_ERROR');
        expect((err as ToolExecutionError).message).toContain('unexpected state');
        expect((err as ToolExecutionError).message).toContain('deleting');
        expect((err as ToolExecutionError).retryable).toBe(false);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Successful invocation
  // ---------------------------------------------------------------------------

  describe('successful invocation', () => {
    it('invokes Lambda when deployment is active', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      // Mock LambdaClient.send on the instance
      const mockSend = vi
        .fn()
        .mockResolvedValue(buildLambdaResponse({ response: { result: 42 }, logs: [], error: '' }));
      (runner as any).lambdaClient = { send: mockSend };

      const result = await runner.run(createRunConfig());

      expect(result).toEqual({ result: 42 });
      expect(mockSend).toHaveBeenCalledTimes(1);
    });

    it('returns undefined response field when handler returns no response', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      const mockSend = vi.fn().mockResolvedValue(buildLambdaResponse({ logs: [], error: '' }));
      (runner as any).lambdaClient = { send: mockSend };

      const result = await runner.run(createRunConfig());
      expect(result).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // $-prefix preprocessing
  // ---------------------------------------------------------------------------

  describe('$-prefix preprocessing', () => {
    it('preprocesses JS params with $ prefix', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      const mockSend = vi
        .fn()
        .mockResolvedValue(buildLambdaResponse({ response: 'ok', logs: [], error: '' }));
      (runner as any).lambdaClient = { send: mockSend };

      await runner.run(
        createRunConfig({
          runtime: 'javascript',
          params: { income: 50000, region: 'US' },
        }),
      );

      // Capture InvokeCommand constructor call to inspect payload
      const { InvokeCommand: MockedCommand } = await import('@aws-sdk/client-lambda');
      const lastCall = (MockedCommand as any).mock.calls.at(-1)[0];
      const payload = JSON.parse(new TextDecoder().decode(lastCall.Payload));
      expect(payload.params).toHaveProperty('$income', 50000);
      expect(payload.params).toHaveProperty('$region', 'US');
      expect(payload.params).not.toHaveProperty('income');
      expect(payload.params).not.toHaveProperty('region');
    });

    it('filters thought param from JS params', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      const mockSend = vi
        .fn()
        .mockResolvedValue(buildLambdaResponse({ response: 'ok', logs: [], error: '' }));
      (runner as any).lambdaClient = { send: mockSend };

      await runner.run(
        createRunConfig({
          runtime: 'javascript',
          params: { name: 'John', thought: 'internal reasoning' },
        }),
      );

      const { InvokeCommand: MockedCommand } = await import('@aws-sdk/client-lambda');
      const lastCall = (MockedCommand as any).mock.calls.at(-1)[0];
      const payload = JSON.parse(new TextDecoder().decode(lastCall.Payload));
      expect(payload.params).toEqual({ $name: 'John' });
    });

    it('does NOT $-prefix params for python runtime', async () => {
      const store = createMockStore({
        get: vi.fn().mockResolvedValue(createActiveDeployment({ runtime: 'python' })),
      });
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      const mockSend = vi
        .fn()
        .mockResolvedValue(buildLambdaResponse({ response: 'ok', logs: [], error: '' }));
      (runner as any).lambdaClient = { send: mockSend };

      await runner.run(
        createRunConfig({
          runtime: 'python',
          codeContent: 'def run(input): return input',
          params: { name: 'John', age: 30 },
        }),
      );

      const { InvokeCommand: MockedCommand } = await import('@aws-sdk/client-lambda');
      const lastCall = (MockedCommand as any).mock.calls.at(-1)[0];
      const payload = JSON.parse(new TextDecoder().decode(lastCall.Payload));
      expect(payload.params).toEqual({ name: 'John', age: 30 });
    });
  });

  // ---------------------------------------------------------------------------
  // Lambda payload structure
  // ---------------------------------------------------------------------------

  describe('Lambda payload structure', () => {
    it('sends correct InvokeCommand payload with context', async () => {
      const store = createMockStore();
      const jwtSigner = vi.fn().mockResolvedValue('jwt-token-123');
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
        jwtSigner,
      );

      const mockSend = vi
        .fn()
        .mockResolvedValue(buildLambdaResponse({ response: 'ok', logs: [], error: '' }));
      (runner as any).lambdaClient = { send: mockSend };

      await runner.run(createRunConfig());

      const { InvokeCommand: MockedCommand } = await import('@aws-sdk/client-lambda');
      const lastCall = (MockedCommand as any).mock.calls.at(-1)[0];
      const payload = JSON.parse(new TextDecoder().decode(lastCall.Payload));

      expect(payload.runtime).toBe('javascript');
      expect(payload.code).toBe('function run(input) { return input; }');
      expect(payload.functionName).toBe('calculate_risk');
      expect(payload.context.accessToken).toBe('jwt-token-123');
      expect(payload.context.executionMode).toBe('execute');
      expect(payload.context.mockMemoryData).toEqual({});
      expect(payload.context.blockDangerousModules).toBe(true);
      expect(payload.context.memoryApiBaseUrl).toBe('https://memory.example.com');
    });

    it('sends empty accessToken when jwtSigner is not provided', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      const mockSend = vi
        .fn()
        .mockResolvedValue(buildLambdaResponse({ response: 'ok', logs: [], error: '' }));
      (runner as any).lambdaClient = { send: mockSend };

      await runner.run(createRunConfig());

      const { InvokeCommand: MockedCommand } = await import('@aws-sdk/client-lambda');
      const lastCall = (MockedCommand as any).mock.calls.at(-1)[0];
      const payload = JSON.parse(new TextDecoder().decode(lastCall.Payload));

      expect(payload.context.accessToken).toBe('');
    });
  });

  // ---------------------------------------------------------------------------
  // Error handling — Lambda response errors
  // ---------------------------------------------------------------------------

  describe('Lambda response error handling', () => {
    it('throws on [Error] prefixed error in response body', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      const mockSend = vi.fn().mockResolvedValue(
        buildLambdaResponse({
          response: null,
          logs: [],
          error: '[Error] SyntaxError: Unexpected token',
        }),
      );
      (runner as any).lambdaClient = { send: mockSend };

      try {
        await runner.run(createRunConfig());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_EXECUTION_ERROR');
        expect((err as ToolExecutionError).message).toContain('[Error] SyntaxError');
      }
    });

    it('does NOT throw on non-[Error] error strings', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      const mockSend = vi.fn().mockResolvedValue(
        buildLambdaResponse({
          response: { data: 'ok' },
          logs: [],
          error: 'warning: deprecated API usage',
        }),
      );
      (runner as any).lambdaClient = { send: mockSend };

      // Should not throw — only [Error] prefix triggers a throw
      const result = await runner.run(createRunConfig());
      expect(result).toEqual({ data: 'ok' });
    });

    it('throws TOOL_SANDBOX_ERROR when Lambda returns no payload', async () => {
      const store = createMockStore();
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      const mockSend = vi.fn().mockResolvedValue({
        StatusCode: 200,
        Payload: undefined,
      });
      (runner as any).lambdaClient = { send: mockSend };

      try {
        await runner.run(createRunConfig());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_SANDBOX_ERROR');
        expect((err as ToolExecutionError).message).toContain('no payload');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Health check gating
  // ---------------------------------------------------------------------------

  describe('health check', () => {
    it('triggers health check when lastHealthCheck is stale', async () => {
      const staleDeployment = createActiveDeployment({
        lastHealthCheck: '2020-01-01T00:00:00.000Z', // very stale
      });
      const store = createMockStore({
        get: vi.fn().mockResolvedValue(staleDeployment),
      });
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      // Mock send: first call = health check (ping), second call = actual invocation
      const mockSend = vi
        .fn()
        .mockResolvedValueOnce({ StatusCode: 200, Payload: new TextEncoder().encode('{}') }) // health check
        .mockResolvedValueOnce(
          buildLambdaResponse({ response: { result: 'ok' }, logs: [], error: '' }),
        ); // invocation
      (runner as any).lambdaClient = { send: mockSend };

      const result = await runner.run(createRunConfig());

      expect(result).toEqual({ result: 'ok' });
      expect(mockSend).toHaveBeenCalledTimes(2);
      expect(store.updateStatus).toHaveBeenCalledWith(
        'tenant-1',
        'javascript',
        'active',
        expect.objectContaining({ lastHealthCheck: expect.any(String) }),
      );
    });

    it('triggers health check when lastHealthCheck is missing', async () => {
      const noHealthDeployment = createActiveDeployment();
      delete noHealthDeployment.lastHealthCheck;

      const store = createMockStore({
        get: vi.fn().mockResolvedValue(noHealthDeployment),
      });
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      const mockSend = vi
        .fn()
        .mockResolvedValueOnce({ StatusCode: 200, Payload: new TextEncoder().encode('{}') })
        .mockResolvedValueOnce(buildLambdaResponse({ response: 'ok', logs: [], error: '' }));
      (runner as any).lambdaClient = { send: mockSend };

      await runner.run(createRunConfig());
      expect(mockSend).toHaveBeenCalledTimes(2);
    });

    it('throws TOOL_SANDBOX_UNHEALTHY when health check fails', async () => {
      const staleDeployment = createActiveDeployment({
        lastHealthCheck: '2020-01-01T00:00:00.000Z',
      });
      const store = createMockStore({
        get: vi.fn().mockResolvedValue(staleDeployment),
      });
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      // Health check returns non-200
      const mockSend = vi.fn().mockResolvedValueOnce({ StatusCode: 500 });
      (runner as any).lambdaClient = { send: mockSend };

      try {
        await runner.run(createRunConfig());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_SANDBOX_UNHEALTHY');
        expect((err as ToolExecutionError).message).toContain('failed health check');
        expect((err as ToolExecutionError).retryable).toBe(false);
      }
    });

    it('throws TOOL_SANDBOX_UNHEALTHY when health check throws', async () => {
      const staleDeployment = createActiveDeployment({
        lastHealthCheck: '2020-01-01T00:00:00.000Z',
      });
      const store = createMockStore({
        get: vi.fn().mockResolvedValue(staleDeployment),
      });
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      // Health check throws network error
      const mockSend = vi.fn().mockRejectedValueOnce(new Error('Network unreachable'));
      (runner as any).lambdaClient = { send: mockSend };

      try {
        await runner.run(createRunConfig());
        expect.fail('should have thrown');
      } catch (err) {
        expect(err).toBeInstanceOf(ToolExecutionError);
        expect((err as ToolExecutionError).code).toBe('TOOL_SANDBOX_UNHEALTHY');
      }
    });

    it('skips health check when lastHealthCheck is fresh', async () => {
      const freshDeployment = createActiveDeployment({
        lastHealthCheck: new Date().toISOString(), // just now
      });
      const store = createMockStore({
        get: vi.fn().mockResolvedValue(freshDeployment),
      });
      const runner = new LambdaSandboxRunner(
        DEFAULT_CONFIG,
        store,
        createMockLambdaClient(),
        DEFAULT_SESSION,
      );

      const mockSend = vi
        .fn()
        .mockResolvedValueOnce(
          buildLambdaResponse({ response: { result: 'ok' }, logs: [], error: '' }),
        );
      (runner as any).lambdaClient = { send: mockSend };

      await runner.run(createRunConfig());

      // Only one send call (the invocation) — no health check
      expect(mockSend).toHaveBeenCalledTimes(1);
    });
  });
});
