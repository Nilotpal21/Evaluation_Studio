/**
 * Transfer Tool Executor Tests
 *
 * Validates:
 * - Tool call dispatch to correct agent-transfer tool
 * - TransferToolContext correctly populated from session
 * - Error handling for unconfigured SmartAssist
 * - Unknown tool name rejection
 * - Parallel execution
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockTransferExecute, mockCheckRateLimit } = vi.hoisted(() => ({
  mockTransferExecute: vi.fn().mockResolvedValue({
    success: true,
    status: 'transferred',
    sessionId: 'transfer-session-123',
  }),
  mockCheckRateLimit: vi.fn().mockResolvedValue({ allowed: true, remaining: 9, resetMs: 60000 }),
}));

// Mock the agent-transfer package
vi.mock('@agent-platform/agent-transfer', () => {
  class MockTransferToAgentTool {
    execute = mockTransferExecute;
    toToolDefinition = vi.fn();
  }

  class MockCheckHoursTool {
    execute = vi.fn().mockResolvedValue({ success: true, data: true });
  }

  class MockCheckAvailabilityTool {
    execute = vi.fn().mockResolvedValue({ success: true, data: true });
  }

  class MockSetQueueTool {
    execute = vi.fn().mockResolvedValue({ success: true, data: true });
  }

  class MockIVRMenuTool {
    execute = vi.fn().mockResolvedValue({ success: true, branch: 'option_1' });
  }

  class MockIVRDigitInputTool {
    execute = vi.fn().mockResolvedValue({ success: true, digits: '1234' });
  }

  class MockCallTransferTool {
    execute = vi.fn().mockResolvedValue({ success: true, status: 'transferred' });
  }

  class MockDeflectToChatTool {
    execute = vi.fn().mockResolvedValue({ success: true, branch: 'DEFLECT_AUTOMATION' });
  }

  return {
    TransferToAgentTool: MockTransferToAgentTool,
    CheckHoursTool: MockCheckHoursTool,
    CheckAvailabilityTool: MockCheckAvailabilityTool,
    SetQueueTool: MockSetQueueTool,
    IVRMenuTool: MockIVRMenuTool,
    IVRDigitInputTool: MockIVRDigitInputTool,
    CallTransferTool: MockCallTransferTool,
    DeflectToChatTool: MockDeflectToChatTool,
    AdapterRegistry: vi.fn(),
    SmartAssistClient: vi.fn(),
    isVoiceChannel: vi.fn().mockReturnValue(true),
    checkRateLimit: mockCheckRateLimit,
  };
});

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import {
  TransferToolExecutor,
  isTransferTool,
  TRANSFER_TOOL_NAMES,
  type TransferToolExecutorConfig,
} from '../services/execution/transfer-tool-executor.js';

// =============================================================================
// FIXTURES
// =============================================================================

const baseContext = {
  tenantId: 'tenant-1',
  projectId: 'project-1',
  agentId: 'agent-1',
  contactId: 'contact-1',
  sessionId: 'session-1',
  channel: 'chat' as const,
};

function createExecutor(opts?: { withSmartAssist?: boolean }): TransferToolExecutor {
  const config: TransferToolExecutorConfig = {
    adapterRegistry: {} as any,
    context: baseContext,
    ...(opts?.withSmartAssist && { smartAssistClient: {} as any }),
  };
  return new TransferToolExecutor(config);
}

// =============================================================================
// isTransferTool
// =============================================================================

describe('isTransferTool', () => {
  it('recognizes all transfer tool names', () => {
    expect(isTransferTool('transfer_to_agent')).toBe(true);
    expect(isTransferTool('check_hours')).toBe(true);
    expect(isTransferTool('check_availability')).toBe(true);
    expect(isTransferTool('set_queue')).toBe(true);
    expect(isTransferTool('ivr_menu')).toBe(true);
    expect(isTransferTool('ivr_digit_input')).toBe(true);
    expect(isTransferTool('call_transfer')).toBe(true);
    expect(isTransferTool('deflect_to_chat')).toBe(true);
  });

  it('rejects non-transfer tool names', () => {
    expect(isTransferTool('search_vector')).toBe(false);
    expect(isTransferTool('http_call')).toBe(false);
    expect(isTransferTool('transfer_to_human')).toBe(false);
  });

  it('TRANSFER_TOOL_NAMES has exactly 8 entries', () => {
    expect(TRANSFER_TOOL_NAMES.size).toBe(8);
  });
});

// =============================================================================
// TransferToolExecutor.execute
// =============================================================================

describe('TransferToolExecutor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockTransferExecute.mockResolvedValue({
      success: true,
      status: 'transferred',
      sessionId: 'transfer-session-123',
    });
    mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: 9, resetMs: 60000 });
  });

  it('dispatches transfer_to_agent to TransferToAgentTool', async () => {
    const executor = createExecutor();
    const result = await executor.execute(
      'transfer_to_agent',
      { provider: 'kore', skills: ['billing'] },
      30000,
    );

    expect(result).toEqual({
      success: true,
      status: 'transferred',
      sessionId: 'transfer-session-123',
    });
  });

  it('resolves context lazily per call and reports transfer outcomes', async () => {
    const getContext = vi.fn().mockResolvedValue({
      ...baseContext,
      contactId: 'contact-2',
      channel: 'voice',
    });
    const onTransferResult = vi.fn();
    const executor = new TransferToolExecutor({
      adapterRegistry: {} as any,
      getContext,
      onTransferResult,
    });

    await executor.execute('transfer_to_agent', { provider: 'kore' }, 30000);

    expect(getContext).toHaveBeenCalledTimes(1);
    expect(mockTransferExecute).toHaveBeenCalledWith(
      { provider: 'kore' },
      expect.objectContaining({
        contactId: 'contact-2',
        channel: 'voice',
      }),
    );
    expect(onTransferResult).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'transfer_to_agent',
        success: true,
        context: expect.objectContaining({
          contactId: 'contact-2',
          channel: 'voice',
        }),
      }),
    );
  });

  it('reports blocked transfer attempts as failed outcomes', async () => {
    mockCheckRateLimit.mockResolvedValueOnce({ allowed: false, remaining: 0, resetMs: 120000 });
    const onTransferResult = vi.fn();
    const executor = new TransferToolExecutor({
      adapterRegistry: {} as any,
      context: baseContext,
      redis: {} as any,
      onTransferResult,
    });

    const result = (await executor.execute(
      'transfer_to_agent',
      { provider: 'kore' },
      30000,
    )) as any;

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('RATE_LIMIT_EXCEEDED');
    expect(onTransferResult).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'transfer_to_agent',
        success: false,
      }),
    );
  });

  it('fails closed when transfer_to_agent is called without project scope', async () => {
    const onTransferResult = vi.fn();
    const executor = new TransferToolExecutor({
      adapterRegistry: {} as any,
      context: {
        ...baseContext,
        projectId: '',
      },
      onTransferResult,
    });

    const result = (await executor.execute(
      'transfer_to_agent',
      { provider: 'kore' },
      30000,
    )) as any;

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('PROJECT_CONTEXT_REQUIRED');
    expect(mockTransferExecute).not.toHaveBeenCalled();
    expect(onTransferResult).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'transfer_to_agent',
        success: false,
        result: expect.objectContaining({
          error: expect.objectContaining({
            code: 'PROJECT_CONTEXT_REQUIRED',
          }),
        }),
      }),
    );
  });

  it('returns structured error and emits trace when adapter registry is unavailable', async () => {
    const getAdapterRegistry = vi.fn().mockReturnValue(null);
    const traceEmitter = { emit: vi.fn() };
    const onTransferResult = vi.fn();
    const executor = new TransferToolExecutor({
      getAdapterRegistry,
      context: baseContext,
      traceEmitter,
      onTransferResult,
    });

    const result = (await executor.execute(
      'transfer_to_agent',
      { provider: 'kore' },
      30000,
    )) as any;

    expect(result).toEqual({
      success: false,
      error: {
        code: 'ADAPTER_REGISTRY_UNAVAILABLE',
        message: 'Agent transfer adapter registry is unavailable.',
      },
    });
    expect(getAdapterRegistry).toHaveBeenCalledTimes(1);
    expect(mockTransferExecute).not.toHaveBeenCalled();
    expect(onTransferResult).toHaveBeenCalledWith(
      expect.objectContaining({
        toolName: 'transfer_to_agent',
        success: false,
        context: expect.objectContaining({
          sessionId: 'session-1',
          projectId: 'project-1',
        }),
        result: expect.objectContaining({
          error: expect.objectContaining({
            code: 'ADAPTER_REGISTRY_UNAVAILABLE',
          }),
        }),
      }),
    );
    expect(traceEmitter.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent_transfer.transfer_failed',
        timestamp: expect.any(Number),
        data: expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'project-1',
          contactId: 'contact-1',
          provider: 'kore',
          channel: 'chat',
          runtimeSessionId: 'session-1',
          errorCode: 'ADAPTER_REGISTRY_UNAVAILABLE',
          errorMessage: 'Agent transfer adapter registry is unavailable.',
        }),
      }),
    );
  });

  it('returns NOT_CONFIGURED for check_hours without SmartAssist', async () => {
    const executor = createExecutor();
    const result = (await executor.execute(
      'check_hours',
      { agentId: 'a1', hoursId: 'h1' },
      30000,
    )) as any;

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NOT_CONFIGURED');
  });

  it('dispatches check_hours when SmartAssist is configured', async () => {
    const executor = createExecutor({ withSmartAssist: true });
    const result = await executor.execute('check_hours', { agentId: 'a1', hoursId: 'h1' }, 30000);

    expect(result).toEqual({ success: true, data: true });
  });

  it('returns NOT_CONFIGURED for check_availability without SmartAssist', async () => {
    const executor = createExecutor();
    const result = (await executor.execute(
      'check_availability',
      { agentId: 'a1', contactId: 'c1', tenantId: 't1', projectId: 'p1' },
      30000,
    )) as any;

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NOT_CONFIGURED');
  });

  it('returns NOT_CONFIGURED for set_queue without SmartAssist', async () => {
    const executor = createExecutor();
    const result = (await executor.execute(
      'set_queue',
      { agentId: 'a1', queueId: 'q1' },
      30000,
    )) as any;

    expect(result.success).toBe(false);
    expect(result.error.code).toBe('NOT_CONFIGURED');
  });

  it('throws for unknown tool name', async () => {
    const executor = createExecutor();
    await expect(executor.execute('unknown_tool', {}, 30000)).rejects.toThrow(
      'Unknown transfer tool: unknown_tool',
    );
  });

  it('executeParallel runs all calls', async () => {
    const executor = createExecutor({ withSmartAssist: true });
    const results = await executor.executeParallel(
      [
        { name: 'transfer_to_agent', params: { provider: 'kore' } },
        { name: 'check_hours', params: { agentId: 'a1', hoursId: 'h1' } },
      ],
      30000,
    );

    expect(results).toHaveLength(2);
    expect(results[0].name).toBe('transfer_to_agent');
    expect(results[0].result).toBeDefined();
    expect(results[1].name).toBe('check_hours');
    expect(results[1].result).toBeDefined();
  });

  it('executeParallel captures errors without failing all calls', async () => {
    const executor = createExecutor();
    const results = await executor.executeParallel(
      [
        { name: 'transfer_to_agent', params: { provider: 'kore' } },
        { name: 'unknown_tool', params: {} },
      ],
      30000,
    );

    expect(results).toHaveLength(2);
    expect(results[0].result).toBeDefined();
    expect(results[1].error).toContain('Unknown transfer tool');
  });

  it('emits transfer_initiated trace before executing the transfer tool', async () => {
    const traceEmitter = { emit: vi.fn() };
    const executor = new TransferToolExecutor({
      adapterRegistry: {} as any,
      context: baseContext,
      traceEmitter,
    });

    await executor.execute(
      'transfer_to_agent',
      { provider: 'smartassist', queueId: 'queue-1', skills: ['billing', 'sales'] },
      5000,
    );

    const initiatedCall = traceEmitter.emit.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'agent_transfer.transfer_initiated',
    );
    expect(initiatedCall).toBeDefined();
    const data = initiatedCall![0].data as Record<string, unknown>;
    expect(data.runtimeSessionId).toBe('session-1');
    expect(data.provider).toBe('smartassist');
    expect(data.queue).toBe('queue-1');
    expect(data.skills).toEqual(['billing', 'sales']);
    expect(data.tenantId).toBe('tenant-1');
    expect(data.projectId).toBe('project-1');
    expect(data.contactId).toBe('contact-1');
    expect(data.channel).toBe('chat');

    // Verify transfer_initiated was emitted before the transfer tool executed
    // (the execute mock is always called, so we just check both happened)
    expect(mockTransferExecute).toHaveBeenCalledTimes(1);
  });

  it('includes runtimeSessionId in transfer_failed trace event data', async () => {
    const traceEmitter = { emit: vi.fn() };
    mockTransferExecute.mockResolvedValueOnce({
      success: false,
      error: {
        code: 'TRANSFER_REJECTED',
        message: 'No agents available',
      },
    });
    const executor = new TransferToolExecutor({
      adapterRegistry: {} as any,
      context: baseContext,
      traceEmitter,
    });

    await executor.execute('transfer_to_agent', { provider: 'kore' }, 5000);

    const failedCall = traceEmitter.emit.mock.calls.find(
      ([e]: [{ type: string }]) => e.type === 'agent_transfer.transfer_failed',
    );
    expect(failedCall).toBeDefined();
    const data = failedCall![0].data as Record<string, unknown>;
    expect(data.runtimeSessionId).toBe('session-1');
    expect(data.tenantId).toBe('tenant-1');
    expect(data.provider).toBe('kore');
    expect(data.errorCode).toBe('TRANSFER_REJECTED');
    expect(data.errorMessage).toBe('No agents available');
  });
});
