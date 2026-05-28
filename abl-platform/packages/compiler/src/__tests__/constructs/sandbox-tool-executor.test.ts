import { describe, it, expect, vi } from 'vitest';
import { SandboxToolExecutor } from '../../platform/constructs/executors/sandbox-tool-executor.js';
import type { SandboxRunner } from '../../platform/constructs/executors/sandbox-tool-executor.js';
import type { ToolDefinition } from '../../platform/ir/schema.js';

function createSandboxTool(
  name: string,
  runtime: 'javascript' | 'python',
  codeContent: string,
): ToolDefinition {
  return {
    name,
    description: `Sandbox: ${name}`,
    parameters: [{ name: 'data', type: 'object', required: true }],
    returns: { type: 'object' },
    hints: {
      cacheable: false,
      latency: 'medium',
      parallelizable: false,
      side_effects: true,
      requires_auth: false,
    },
    tool_type: 'sandbox',
    sandbox_binding: { runtime, code_content: codeContent, timeout_ms: 5000, memory_mb: 128 },
  };
}

describe('SandboxToolExecutor', () => {
  it('should run JavaScript sandbox', async () => {
    const mockRunner: SandboxRunner = {
      run: vi.fn().mockResolvedValue({ score: 0.85, factors: ['credit_score'] }),
    };
    const executor = new SandboxToolExecutor({
      tools: [createSandboxTool('calculate_risk', 'javascript', 'calculateRisk')],
      runner: mockRunner,
    });

    const result = await executor.execute('calculate_risk', { income: 50000 });
    expect(result).toEqual({ score: 0.85, factors: ['credit_score'] });
    expect(mockRunner.run).toHaveBeenCalledWith({
      functionName: 'calculate_risk',
      codeContent: 'calculateRisk',
      runtime: 'javascript',
      params: { income: 50000 },
      limits: { timeoutMs: 5000, memoryMb: 128 },
    });
  });

  it('should run Python sandbox', async () => {
    const mockRunner: SandboxRunner = {
      run: vi.fn().mockResolvedValue({ sentiment: 'positive', confidence: 0.92 }),
    };
    const executor = new SandboxToolExecutor({
      tools: [createSandboxTool('analyze_sentiment', 'python', 'analyze')],
      runner: mockRunner,
    });

    const result = await executor.execute('analyze_sentiment', { text: 'Great product!' });
    expect(result).toEqual({ sentiment: 'positive', confidence: 0.92 });
    expect(mockRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ runtime: 'python', codeContent: 'analyze' }),
    );
  });

  it('should throw for non-existent sandbox tool', async () => {
    const mockRunner: SandboxRunner = { run: vi.fn() };
    const executor = new SandboxToolExecutor({ tools: [], runner: mockRunner });
    await expect(executor.execute('nonexistent', {})).rejects.toThrow('Sandbox tool not found');
  });

  // -------------------------------------------------------------------------
  // Path traversal edge cases
  // -------------------------------------------------------------------------

  it('should pass code_content directly to runner without file I/O', async () => {
    const mockRunner: SandboxRunner = { run: vi.fn().mockResolvedValue({ ok: true }) };
    const executor = new SandboxToolExecutor({
      tools: [createSandboxTool('inline_code', 'javascript', 'function run(x) { return x; }')],
      runner: mockRunner,
    });
    const result = await executor.execute('inline_code', { data: {} });
    expect(result).toEqual({ ok: true });
    expect(mockRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ codeContent: 'function run(x) { return x; }' }),
    );
  });

  it('should use default memory when not specified in binding', async () => {
    const tool: ToolDefinition = {
      name: 'simple_calc',
      description: 'Simple calc',
      parameters: [],
      returns: { type: 'number' },
      hints: {
        cacheable: false,
        latency: 'medium',
        parallelizable: false,
        side_effects: false,
        requires_auth: false,
      },
      tool_type: 'sandbox',
      sandbox_binding: { runtime: 'javascript', code_content: 'function calc() {}' },
    };
    const mockRunner: SandboxRunner = { run: vi.fn().mockResolvedValue(42) };
    const executor = new SandboxToolExecutor({ tools: [tool], runner: mockRunner });
    await executor.execute('simple_calc', {});

    expect(mockRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ limits: { timeoutMs: 5000, memoryMb: 128 } }),
    );
  });

  it('resolves config-backed runtime numeric fields before invoking runner limits', async () => {
    const tool = {
      ...createSandboxTool('config_limits', 'javascript', 'function run() {}'),
      sandbox_binding: {
        runtime: 'javascript',
        code_content: 'function run() {}',
        timeout_ms: '{{config.SANDBOX_TIMEOUT_MS}}',
        memory_mb: '{{config.SANDBOX_MEMORY_MB}}',
      },
    } as unknown as ToolDefinition;
    const mockRunner: SandboxRunner = { run: vi.fn().mockResolvedValue({ ok: true }) };
    const executor = new SandboxToolExecutor({
      tools: [tool],
      runner: mockRunner,
      secrets: {
        getSecret: vi.fn().mockResolvedValue(undefined),
        getConfigVar: vi.fn(async (key: string) => {
          const values: Record<string, string> = {
            SANDBOX_TIMEOUT_MS: '2500',
            SANDBOX_MEMORY_MB: '512',
          };
          return values[key];
        }),
      },
    });

    await executor.execute('config_limits', {});

    expect(mockRunner.run).toHaveBeenCalledWith(
      expect.objectContaining({ limits: { timeoutMs: 2500, memoryMb: 512 } }),
    );
  });

  it('passes the current tool name to sandbox secret lookups', async () => {
    const getSecret = vi.fn().mockResolvedValue('resolved-secret');
    const mockRunner: SandboxRunner = {
      run: vi.fn(async (config) => {
        const secrets = config.globals?.secrets as
          | { get: (key: string) => Promise<string | undefined> }
          | undefined;
        return secrets?.get('API_TOKEN');
      }),
    };
    const executor = new SandboxToolExecutor({
      tools: [createSandboxTool('call_partner_api', 'javascript', 'function run() {}')],
      runner: mockRunner,
      secrets: { getSecret },
    });

    const result = await executor.execute('call_partner_api', {});

    expect(result).toBe('resolved-secret');
    expect(getSecret).toHaveBeenCalledWith('API_TOKEN', { toolName: 'call_partner_api' });
  });
});
