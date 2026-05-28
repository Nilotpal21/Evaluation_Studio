/**
 * Trace Wiring Tests
 *
 * Verifies that trace context is properly passed to ToolBindingExecutor
 * and that tool-level trace events are emitted (Bug 1 fix).
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ToolBindingExecutor } from '@abl/compiler';
import type { ToolDefinition } from '@abl/compiler';
import type { SecretsProvider } from '@abl/compiler';
import type { TraceContextManager } from '@abl/compiler/platform';

const defaultHints = {
  cacheable: false,
  latency: 'medium' as const,
  parallelizable: false,
  side_effects: true,
  requires_auth: false,
};

function createContractTool(name = 'test_tool'): ToolDefinition {
  return {
    name,
    description: 'Test tool',
    parameters: [],
    returns: { type: 'string' },
    hints: defaultHints,
  };
}

describe('Trace Wiring', () => {
  let mockTrace: TraceContextManager;
  const secrets: SecretsProvider = { getSecret: vi.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTrace = {
      logToolCall: vi.fn().mockResolvedValue(undefined),
      logLLMCall: vi.fn().mockResolvedValue(undefined),
      logConstraintCheck: vi.fn().mockResolvedValue(undefined),
      logHandoff: vi.fn().mockResolvedValue(undefined),
      logEscalation: vi.fn().mockResolvedValue(undefined),
      logError: vi.fn().mockResolvedValue(undefined),
      end: vi.fn().mockResolvedValue(undefined),
      createChildSpan: vi.fn(),
      traceId: 'test-trace-id',
      spanId: 'test-span-id',
    } as unknown as TraceContextManager;
  });

  it('should pass trace to ToolBindingExecutor via config', () => {
    const executor = new ToolBindingExecutor({
      tools: [createContractTool()],
      secrets,
      trace: mockTrace,
      fallbackExecutor: {
        execute: vi.fn().mockResolvedValue('result'),
        executeParallel: vi.fn(),
      },
    });
    expect(executor).toBeDefined();
  });

  it('should emit trace events on successful tool call', async () => {
    const fallback = {
      execute: vi.fn().mockResolvedValue('tool-result'),
      executeParallel: vi.fn(),
    };

    const executor = new ToolBindingExecutor({
      tools: [createContractTool()],
      secrets,
      trace: mockTrace,
      fallbackExecutor: fallback,
    });

    await executor.execute('test_tool', { key: 'value' }, 5000);

    expect(mockTrace.logToolCall).toHaveBeenCalledTimes(1);
    expect(mockTrace.logToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'test_tool',
        input: { key: 'value' },
        output: 'tool-result',
        success: true,
      }),
    );
  });

  it('should emit trace events on failed tool call', async () => {
    const fallback = {
      execute: vi.fn().mockRejectedValue(new Error('tool-failure')),
      executeParallel: vi.fn(),
    };

    const executor = new ToolBindingExecutor({
      tools: [createContractTool()],
      secrets,
      trace: mockTrace,
      fallbackExecutor: fallback,
    });

    await expect(executor.execute('test_tool', {}, 5000)).rejects.toThrow('tool-failure');

    expect(mockTrace.logToolCall).toHaveBeenCalledTimes(1);
    expect(mockTrace.logToolCall).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'test_tool',
        success: false,
        error: 'tool-failure',
      }),
    );
  });

  it('should not crash when trace is undefined', async () => {
    const fallback = {
      execute: vi.fn().mockResolvedValue('result'),
      executeParallel: vi.fn(),
    };

    const executor = new ToolBindingExecutor({
      tools: [createContractTool()],
      secrets,
      // trace intentionally not passed
      fallbackExecutor: fallback,
    });

    const result = await executor.execute('test_tool', {}, 5000);
    expect(result).toBe('result');
  });
});
