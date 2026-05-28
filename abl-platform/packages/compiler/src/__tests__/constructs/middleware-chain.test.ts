/**
 * Middleware Chain Tests (T2, T4)
 *
 * T2: Verify ToolBindingExecutor wires middleware chain correctly
 * T4: Verify no duplicate trace logging when middleware is present
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

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
beforeEach(() => {
  mockAssertUrlSafeForFetch.mockReset().mockResolvedValue(undefined);
  mockSafeFetch
    .mockReset()
    .mockImplementation((url: string | URL, init?: RequestInit) => globalThis.fetch(url, init));
});

import { ToolBindingExecutor } from '../../platform/constructs/executors/tool-binding-executor.js';
import {
  loggingMiddleware,
  timingMiddleware,
} from '../../platform/constructs/executors/builtin-middleware.js';
import { composeMiddleware } from '../../platform/constructs/executors/tool-middleware.js';
import type {
  ToolMiddleware,
  ToolCallContext,
  ToolCallResult,
  ToolMiddlewareNext,
} from '../../platform/constructs/executors/tool-middleware.js';
import type { ToolDefinition } from '../../platform/ir/schema.js';
import type { SecretsProvider } from '../../platform/constructs/executors/secrets-provider.js';
import type { ToolExecutor } from '../../platform/constructs/types.js';
import type { TraceContextManager } from '../../platform/stores/trace-store.js';

const secrets: SecretsProvider = { getSecret: vi.fn().mockResolvedValue(undefined) };
const defaultHints = {
  cacheable: false,
  latency: 'medium' as const,
  parallelizable: false,
  side_effects: true,
  requires_auth: false,
};

const contractTool: ToolDefinition = {
  name: 'test_tool',
  description: 'Test tool',
  parameters: [],
  returns: { type: 'string' },
  hints: defaultHints,
};

function createFallback(result: unknown = 'result'): ToolExecutor {
  return {
    execute: vi.fn().mockResolvedValue(result),
    executeParallel: vi.fn(),
  };
}

function createMockTrace(): TraceContextManager & { calls: any[] } {
  const calls: any[] = [];
  return {
    calls,
    logToolCall: vi.fn(async (entry: any) => {
      calls.push(entry);
    }),
    logEvent: vi.fn(),
    logLLMCall: vi.fn(),
    logDecision: vi.fn(),
    logConstraintCheck: vi.fn(),
    logHandoff: vi.fn(),
    logEscalation: vi.fn(),
    logError: vi.fn(),
    getTraceId: vi.fn().mockReturnValue('trace-1'),
    getSpanId: vi.fn().mockReturnValue('span-1'),
    startSpan: vi.fn(),
    endSpan: vi.fn(),
  } as any;
}

function getHeaderValue(
  headers: RequestInit['headers'] | undefined,
  name: string,
): string | undefined {
  return new Headers(headers ?? {}).get(name) ?? undefined;
}

// =============================================================================
// T2: Middleware chain wiring
// =============================================================================

describe('ToolBindingExecutor middleware wiring', () => {
  it('should execute middleware in registration order', async () => {
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
      tools: [contractTool],
      secrets,
      fallbackExecutor: createFallback(),
      middleware: [mw1, mw2],
    });

    await executor.execute('test_tool', {}, 5000);

    expect(order).toEqual(['mw1-before', 'mw2-before', 'mw2-after', 'mw1-after']);
  });

  it('should pass tool metadata through middleware context', async () => {
    let capturedCtx: ToolCallContext | undefined;

    const captureMw: ToolMiddleware = async (ctx, next) => {
      capturedCtx = ctx;
      return next(ctx);
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: createFallback(),
      middleware: [captureMw],
    });

    await executor.execute('test_tool', { key: 'value' }, 5000);

    expect(capturedCtx).toBeDefined();
    expect(capturedCtx!.toolName).toBe('test_tool');
    expect(capturedCtx!.params).toEqual({ key: 'value' });
    expect(capturedCtx!.timeoutMs).toBe(5000);
  });

  it('should allow middleware to modify params before dispatch', async () => {
    const fallback = createFallback();

    const addParamMw: ToolMiddleware = async (ctx, next) => {
      return next({
        ...ctx,
        params: { ...ctx.params, injected: true },
      });
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: fallback,
      middleware: [addParamMw],
    });

    await executor.execute('test_tool', { original: true }, 5000);

    // The dispatch still uses the original toolName
    expect(fallback.execute).toHaveBeenCalledWith('test_tool', expect.any(Object), 5000);
  });

  it('should dispatch middleware-modified HTTP tool definitions', async () => {
    const httpTool: ToolDefinition = {
      name: 'http_tool',
      description: 'HTTP tool',
      parameters: [{ name: 'query', type: 'string', required: true }],
      returns: { type: 'object' },
      hints: defaultHints,
      tool_type: 'http',
      http_binding: {
        endpoint: 'https://api.example.com/search',
        method: 'POST',
        auth: { type: 'none' },
        headers: {
          'X-Test': 'original',
        },
      },
    };

    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({
        ok: true,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: () => Promise.resolve({ ok: true }),
      }),
    );

    const mutateToolMw: ToolMiddleware = async (ctx, next) => {
      expect(ctx.tool?.http_binding?.headers?.['X-Test']).toBe('original');

      return next({
        ...ctx,
        tool: {
          ...ctx.tool!,
          http_binding: {
            ...ctx.tool!.http_binding!,
            headers: {
              ...ctx.tool!.http_binding!.headers,
              'X-Test': 'mutated',
              'X-Added': 'from-middleware',
            },
          },
        },
      });
    };

    try {
      const executor = new ToolBindingExecutor({
        tools: [httpTool],
        secrets,
        middleware: [mutateToolMw],
      });

      const result = await executor.execute('http_tool', { query: 'hello' }, 5000);

      expect(result).toEqual({ ok: true });
      expect(fetch).toHaveBeenCalledTimes(1);

      const [, init] = (fetch as any).mock.calls[0] as [string, RequestInit];
      expect(getHeaderValue(init.headers, 'Content-Type')).toBe('application/json');
      expect(getHeaderValue(init.headers, 'X-Test')).toBe('mutated');
      expect(getHeaderValue(init.headers, 'X-Added')).toBe('from-middleware');
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('should propagate errors through middleware chain', async () => {
    const errorFallback: ToolExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('tool failed')),
      executeParallel: vi.fn(),
    };

    let caughtInMw = false;
    const errorCaptureMw: ToolMiddleware = async (ctx, next) => {
      try {
        return await next(ctx);
      } catch (err) {
        caughtInMw = true;
        throw err;
      }
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: errorFallback,
      middleware: [errorCaptureMw],
    });

    await expect(executor.execute('test_tool', {}, 5000)).rejects.toThrow('tool failed');
    expect(caughtInMw).toBe(true);
  });

  it('should work with zero middleware (backward compatible)', async () => {
    const fallback = createFallback('direct-result');

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: fallback,
      middleware: [],
    });

    const result = await executor.execute('test_tool', {}, 5000);
    expect(result).toBe('direct-result');
  });
});

// =============================================================================
// T4: No duplicate trace logging when middleware is present
// =============================================================================

describe('ToolBindingExecutor trace deduplication', () => {
  it('should log trace via middleware when middleware is configured', async () => {
    const trace = createMockTrace();

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: createFallback('ok'),
      trace,
      middleware: [loggingMiddleware(trace)],
    });

    await executor.execute('test_tool', { x: 1 }, 5000);

    // loggingMiddleware logs to trace
    expect(trace.logToolCall).toHaveBeenCalledTimes(1);
    expect(trace.calls[0].toolName).toBe('test_tool');
    expect(trace.calls[0].success).toBe(true);
  });

  it('should NOT double-log when both middleware and inline trace are present', async () => {
    const trace = createMockTrace();

    // Even though trace is set on the executor AND in middleware,
    // the executor should skip inline trace when middleware is present
    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: createFallback('ok'),
      trace,
      middleware: [loggingMiddleware(trace)],
    });

    await executor.execute('test_tool', {}, 5000);

    // Should only be called once (by middleware), not twice
    expect(trace.logToolCall).toHaveBeenCalledTimes(1);
  });

  it('should use inline trace when no middleware is configured', async () => {
    const trace = createMockTrace();

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: createFallback('ok'),
      trace,
      // No middleware — inline trace should activate
    });

    await executor.execute('test_tool', {}, 5000);

    expect(trace.logToolCall).toHaveBeenCalledTimes(1);
    expect(trace.calls[0].success).toBe(true);
  });

  it('should trace errors via middleware on failure', async () => {
    const trace = createMockTrace();

    const errorFallback: ToolExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('tool broke')),
      executeParallel: vi.fn(),
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: errorFallback,
      trace,
      middleware: [loggingMiddleware(trace)],
    });

    await expect(executor.execute('test_tool', {}, 5000)).rejects.toThrow('tool broke');

    expect(trace.logToolCall).toHaveBeenCalledTimes(1);
    expect(trace.calls[0].success).toBe(false);
    expect(trace.calls[0].error).toBe('tool broke');
  });

  it('should trace errors inline when no middleware on failure', async () => {
    const trace = createMockTrace();

    const errorFallback: ToolExecutor = {
      execute: vi.fn().mockRejectedValue(new Error('inline error')),
      executeParallel: vi.fn(),
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: errorFallback,
      trace,
      // No middleware
    });

    await expect(executor.execute('test_tool', {}, 5000)).rejects.toThrow('inline error');

    expect(trace.logToolCall).toHaveBeenCalledTimes(1);
    expect(trace.calls[0].success).toBe(false);
  });
});

// =============================================================================
// composeMiddleware standalone tests
// =============================================================================

describe('composeMiddleware', () => {
  it('should compose middleware in onion order', async () => {
    const order: string[] = [];

    const mw1: ToolMiddleware = async (ctx, next) => {
      order.push('1-in');
      const r = await next(ctx);
      order.push('1-out');
      return r;
    };
    const mw2: ToolMiddleware = async (ctx, next) => {
      order.push('2-in');
      const r = await next(ctx);
      order.push('2-out');
      return r;
    };
    const mw3: ToolMiddleware = async (ctx, next) => {
      order.push('3-in');
      const r = await next(ctx);
      order.push('3-out');
      return r;
    };

    const final = async (ctx: ToolCallContext) => {
      order.push('final');
      return { result: 'done' };
    };

    const composed = composeMiddleware([mw1, mw2, mw3], final);
    const ctx = { toolName: 'test', params: {}, timeoutMs: 5000 };

    await composed(ctx);

    expect(order).toEqual(['1-in', '2-in', '3-in', 'final', '3-out', '2-out', '1-out']);
  });

  it('should pass through with empty middleware array', async () => {
    const final = async (ctx: ToolCallContext) => ({ result: ctx.toolName });
    const composed = composeMiddleware([], final);

    const result = await composed({ toolName: 'my-tool', params: {}, timeoutMs: 1000 });
    expect(result.result).toBe('my-tool');
  });

  it('should handle async middleware correctly', async () => {
    const mw: ToolMiddleware = async (ctx, next) => {
      await new Promise((r) => setTimeout(r, 1));
      return next(ctx);
    };

    const final = async () => ({ result: 'async-ok' });
    const composed = composeMiddleware([mw], final);

    const result = await composed({ toolName: 'test', params: {}, timeoutMs: 1000 });
    expect(result.result).toBe('async-ok');
  });
});

// =============================================================================
// loggingMiddleware standalone tests
// =============================================================================

describe('loggingMiddleware', () => {
  it('should log successful call to trace', async () => {
    const trace = createMockTrace();
    const mw = loggingMiddleware(trace);

    const result = await mw(
      { toolName: 'my_tool', params: { a: 1 }, timeoutMs: 3000, metadata: { tool_type: 'http' } },
      async () => ({ result: { data: 'ok' } }),
    );

    expect(result.result).toEqual({ data: 'ok' });
    expect(trace.logToolCall).toHaveBeenCalledTimes(1);
    expect(trace.calls[0]).toMatchObject({
      toolName: 'my_tool',
      success: true,
    });
  });

  it('should log failed call to trace', async () => {
    const trace = createMockTrace();
    const mw = loggingMiddleware(trace);

    await expect(
      mw({ toolName: 'my_tool', params: {}, timeoutMs: 3000 }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');

    expect(trace.logToolCall).toHaveBeenCalledTimes(1);
    expect(trace.calls[0]).toMatchObject({
      toolName: 'my_tool',
      success: false,
      error: 'boom',
    });
  });

  it('should work without trace (no-op)', async () => {
    const mw = loggingMiddleware(undefined);

    const result = await mw({ toolName: 'test', params: {}, timeoutMs: 1000 }, async () => ({
      result: 42,
    }));

    expect(result.result).toBe(42);
  });
});

// =============================================================================
// timingMiddleware tests
// =============================================================================

describe('timingMiddleware', () => {
  it('should add latencyMs to result metadata', async () => {
    const mw = timingMiddleware();

    const result = await mw({ toolName: 'test', params: {}, timeoutMs: 1000 }, async () => ({
      result: 'ok',
    }));

    expect(result.result).toBe('ok');
    expect(result.metadata?.latencyMs).toBeDefined();
    expect(typeof result.metadata?.latencyMs).toBe('number');
  });
});
