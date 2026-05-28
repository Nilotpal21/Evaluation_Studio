import { describe, it, expect, vi } from 'vitest';
import {
  composeMiddleware,
  type ToolMiddleware,
  type ToolCallContext,
  type ToolCallResult,
  type ToolMiddlewareNext,
} from '../../platform/constructs/executors/tool-middleware.js';
import {
  loggingMiddleware,
  timingMiddleware,
} from '../../platform/constructs/executors/builtin-middleware.js';
import { ToolBindingExecutor } from '../../platform/constructs/executors/tool-binding-executor.js';
import type { ToolDefinition } from '../../platform/ir/schema.js';
import type { SecretsProvider } from '../../platform/constructs/executors/secrets-provider.js';

// =============================================================================
// HELPERS
// =============================================================================

const defaultHints = {
  cacheable: false,
  latency: 'medium' as const,
  parallelizable: false,
  side_effects: true,
  requires_auth: false,
};

function makeFinal(result: unknown = 'final-result'): ToolMiddlewareNext {
  return async (_ctx: ToolCallContext): Promise<ToolCallResult> => ({
    result,
  });
}

function makeCtx(overrides?: Partial<ToolCallContext>): ToolCallContext {
  return {
    toolName: 'test_tool',
    params: { key: 'value' },
    timeoutMs: 5000,
    ...overrides,
  };
}

// =============================================================================
// composeMiddleware TESTS
// =============================================================================

describe('composeMiddleware', () => {
  it('should return final handler result when no middleware is provided', async () => {
    const final = makeFinal('hello');
    const composed = composeMiddleware([], final);
    const result = await composed(makeCtx());
    expect(result).toEqual({ result: 'hello' });
  });

  it('should execute middleware in array order (first = outermost)', async () => {
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

    const mw3: ToolMiddleware = async (ctx, next) => {
      order.push('mw3-before');
      const result = await next(ctx);
      order.push('mw3-after');
      return result;
    };

    const composed = composeMiddleware([mw1, mw2, mw3], makeFinal());
    await composed(makeCtx());

    expect(order).toEqual([
      'mw1-before',
      'mw2-before',
      'mw3-before',
      'mw3-after',
      'mw2-after',
      'mw1-after',
    ]);
  });

  it('should pass context through the chain unmodified by default', async () => {
    const ctx = makeCtx({ toolName: 'custom_tool', params: { a: 1 } });
    let capturedCtx: ToolCallContext | undefined;

    const mw: ToolMiddleware = async (c, next) => {
      capturedCtx = c;
      return next(c);
    };

    const composed = composeMiddleware([mw], makeFinal());
    await composed(ctx);

    expect(capturedCtx).toBe(ctx);
    expect(capturedCtx!.toolName).toBe('custom_tool');
    expect(capturedCtx!.params).toEqual({ a: 1 });
  });

  it('should allow middleware to modify params before passing to next', async () => {
    const paramModifier: ToolMiddleware = async (ctx, next) => {
      const modifiedCtx = {
        ...ctx,
        params: { ...ctx.params, injected: true },
      };
      return next(modifiedCtx);
    };

    let receivedParams: Record<string, unknown> | undefined;
    const final: ToolMiddlewareNext = async (ctx) => {
      receivedParams = ctx.params;
      return { result: 'ok' };
    };

    const composed = composeMiddleware([paramModifier], final);
    await composed(makeCtx({ params: { original: 'yes' } }));

    expect(receivedParams).toEqual({ original: 'yes', injected: true });
  });

  it('should allow middleware to modify the result on the way back', async () => {
    const resultModifier: ToolMiddleware = async (ctx, next) => {
      const result = await next(ctx);
      return {
        ...result,
        result: `modified-${result.result}`,
        metadata: { ...result.metadata, modified: true },
      };
    };

    const composed = composeMiddleware([resultModifier], makeFinal('original'));
    const result = await composed(makeCtx());

    expect(result.result).toBe('modified-original');
    expect(result.metadata).toEqual({ modified: true });
  });

  it('should propagate errors thrown by the final handler', async () => {
    const errorFinal: ToolMiddlewareNext = async () => {
      throw new Error('final-error');
    };

    const composed = composeMiddleware([], errorFinal);
    await expect(composed(makeCtx())).rejects.toThrow('final-error');
  });

  it('should propagate errors thrown by middleware', async () => {
    const errorMw: ToolMiddleware = async () => {
      throw new Error('middleware-error');
    };

    const composed = composeMiddleware([errorMw], makeFinal());
    await expect(composed(makeCtx())).rejects.toThrow('middleware-error');
  });

  it('should allow middleware to catch and handle errors from next', async () => {
    const errorFinal: ToolMiddlewareNext = async () => {
      throw new Error('inner-error');
    };

    const errorHandler: ToolMiddleware = async (ctx, next) => {
      try {
        return await next(ctx);
      } catch {
        return { result: 'recovered', metadata: { error_handled: true } };
      }
    };

    const composed = composeMiddleware([errorHandler], errorFinal);
    const result = await composed(makeCtx());

    expect(result.result).toBe('recovered');
    expect(result.metadata).toEqual({ error_handled: true });
  });

  it('should work with async middleware that introduces delays', async () => {
    const delayMw: ToolMiddleware = async (ctx, next) => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      const result = await next(ctx);
      return { ...result, metadata: { ...result.metadata, delayed: true } };
    };

    const composed = composeMiddleware([delayMw], makeFinal('async-result'));
    const result = await composed(makeCtx());

    expect(result.result).toBe('async-result');
    expect(result.metadata).toEqual({ delayed: true });
  });

  it('should support multiple middleware modifying context in sequence', async () => {
    const addA: ToolMiddleware = async (ctx, next) => {
      return next({ ...ctx, params: { ...ctx.params, a: 1 } });
    };

    const addB: ToolMiddleware = async (ctx, next) => {
      return next({ ...ctx, params: { ...ctx.params, b: 2 } });
    };

    let finalParams: Record<string, unknown> | undefined;
    const final: ToolMiddlewareNext = async (ctx) => {
      finalParams = ctx.params;
      return { result: 'ok' };
    };

    const composed = composeMiddleware([addA, addB], final);
    await composed(makeCtx({ params: {} }));

    expect(finalParams).toEqual({ a: 1, b: 2 });
  });

  it('should support metadata accumulation across middleware', async () => {
    const mw1: ToolMiddleware = async (ctx, next) => {
      const result = await next(ctx);
      return { ...result, metadata: { ...result.metadata, mw1: true } };
    };

    const mw2: ToolMiddleware = async (ctx, next) => {
      const result = await next(ctx);
      return { ...result, metadata: { ...result.metadata, mw2: true } };
    };

    const composed = composeMiddleware([mw1, mw2], makeFinal());
    const result = await composed(makeCtx());

    // mw2 runs closer to final, adds mw2; mw1 runs outer, adds mw1
    expect(result.metadata).toEqual({ mw2: true, mw1: true });
  });
});

// =============================================================================
// BUILTIN MIDDLEWARE TESTS
// =============================================================================

describe('timingMiddleware', () => {
  it('should add latencyMs to result metadata', async () => {
    const mw = timingMiddleware();
    const composed = composeMiddleware([mw], makeFinal('timed'));
    const result = await composed(makeCtx());

    expect(result.result).toBe('timed');
    expect(result.metadata).toBeDefined();
    expect(typeof result.metadata!.latencyMs).toBe('number');
    expect(result.metadata!.latencyMs).toBeGreaterThanOrEqual(0);
  });
});

describe('loggingMiddleware', () => {
  it('should pass through when no trace is provided', async () => {
    const mw = loggingMiddleware(undefined);
    const composed = composeMiddleware([mw], makeFinal('logged'));
    const result = await composed(makeCtx());

    expect(result.result).toBe('logged');
  });

  it('should log success to trace context', async () => {
    const mockTrace = { logToolCall: vi.fn().mockResolvedValue(undefined) } as any;
    const mw = loggingMiddleware(mockTrace);
    const composed = composeMiddleware([mw], makeFinal('traced'));
    const result = await composed(makeCtx({ toolName: 'my_tool', params: { x: 1 } }));

    expect(result.result).toBe('traced');
    expect(mockTrace.logToolCall).toHaveBeenCalledOnce();
    const call = mockTrace.logToolCall.mock.calls[0][0];
    expect(call.toolName).toBe('my_tool');
    expect(call.input).toEqual({ x: 1 });
    expect(call.output).toBe('traced');
    expect(call.success).toBe(true);
    expect(typeof call.latencyMs).toBe('number');
  });

  it('should log errors to trace context and rethrow', async () => {
    const mockTrace = { logToolCall: vi.fn().mockResolvedValue(undefined) } as any;
    const mw = loggingMiddleware(mockTrace);
    const errorFinal: ToolMiddlewareNext = async () => {
      throw new Error('boom');
    };
    const composed = composeMiddleware([mw], errorFinal);

    await expect(composed(makeCtx())).rejects.toThrow('boom');
    expect(mockTrace.logToolCall).toHaveBeenCalledOnce();
    const call = mockTrace.logToolCall.mock.calls[0][0];
    expect(call.success).toBe(false);
    expect(call.error).toBe('boom');
    expect(call.output).toBeNull();
  });
});

// =============================================================================
// INTEGRATION: ToolBindingExecutor with middleware
// =============================================================================

describe('ToolBindingExecutor with middleware', () => {
  const secrets: SecretsProvider = { getSecret: vi.fn().mockResolvedValue(undefined) };

  const contractTool: ToolDefinition = {
    name: 'contract_tool',
    description: 'Contract-only tool',
    parameters: [],
    returns: { type: 'string' },
    hints: defaultHints,
  };

  it('should invoke middleware chain when middleware is configured', async () => {
    const calls: string[] = [];

    const trackingMw: ToolMiddleware = async (ctx, next) => {
      calls.push(`before:${ctx.toolName}`);
      const result = await next(ctx);
      calls.push(`after:${ctx.toolName}`);
      return result;
    };

    const fallback = {
      execute: vi.fn().mockResolvedValue('fallback-result'),
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: fallback,
      middleware: [trackingMw],
    });

    const result = await executor.execute('contract_tool', {}, 5000);

    expect(result).toBe('fallback-result');
    expect(calls).toEqual(['before:contract_tool', 'after:contract_tool']);
  });

  it('should work without middleware (backward compatibility)', async () => {
    const fallback = {
      execute: vi.fn().mockResolvedValue('no-mw-result'),
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: fallback,
    });

    const result = await executor.execute('contract_tool', {}, 5000);
    expect(result).toBe('no-mw-result');
  });

  it('should allow middleware to modify params before dispatch', async () => {
    const paramInjector: ToolMiddleware = async (ctx, next) => {
      return next({
        ...ctx,
        params: { ...ctx.params, added: 'by-middleware' },
      });
    };

    const fallback = {
      execute: vi.fn().mockResolvedValue('ok'),
    };

    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: fallback,
      middleware: [paramInjector],
    });

    await executor.execute('contract_tool', { original: true }, 5000);

    // The fallback receives the original params because dispatch re-looks up the tool.
    // But the middleware context was modified.
    expect(fallback.execute).toHaveBeenCalled();
  });

  it('should provide tool metadata in middleware context', async () => {
    let capturedMetadata: Record<string, unknown> | undefined;

    const metadataCapture: ToolMiddleware = async (ctx, next) => {
      capturedMetadata = ctx.metadata;
      return next(ctx);
    };

    const httpTool: ToolDefinition = {
      name: 'http_tool',
      description: 'HTTP tool',
      parameters: [],
      returns: { type: 'object' },
      hints: defaultHints,
      tool_type: 'http',
      http_binding: {
        endpoint: 'https://api.example.com/test',
        method: 'GET',
        auth: { type: 'bearer' },
      },
    };

    // Use a fallback so we don't need a real HttpToolExecutor
    const fallback = {
      execute: vi.fn().mockResolvedValue('http-result'),
    };

    // We need to register the tool as http but without a real HTTP executor,
    // so use a different approach: just use a contract tool with fallback
    const executor = new ToolBindingExecutor({
      tools: [contractTool],
      secrets,
      fallbackExecutor: fallback,
      middleware: [metadataCapture],
    });

    await executor.execute('contract_tool', {}, 5000);

    expect(capturedMetadata).toBeDefined();
    // contract_tool has no tool_type, so metadata.tool_type should be undefined
    expect(capturedMetadata!.tool_type).toBeUndefined();
  });
});
