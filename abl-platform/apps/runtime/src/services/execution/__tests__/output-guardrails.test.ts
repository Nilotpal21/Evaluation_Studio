import { describe, it, expect, vi, beforeEach } from 'vitest';
import { checkOutputGuardrails } from '../output-guardrails.js';

// Mock the pipeline factory
vi.mock('../../guardrails/pipeline-factory.js', () => {
  const executeMock = vi.fn();
  return {
    createGuardrailPipeline: vi.fn(() => ({ execute: executeMock })),
    __executeMock: executeMock,
  };
});

describe('checkOutputGuardrails', () => {
  let executeMock: ReturnType<typeof vi.fn>;

  beforeEach(async () => {
    vi.clearAllMocks();
    const mod = await import('../../guardrails/pipeline-factory.js');
    executeMock = (mod as any).__executeMock;
    executeMock.mockResolvedValue({ passed: true, modifiedContent: undefined });
  });

  it('passes context to pipeline.execute instead of empty object', async () => {
    const guardrails = [{ name: 'pii-check', kind: 'output' as const, rules: [], priority: 1 }];
    const context = { sourceAgent: 'agent-1', targetAgent: 'agent-2' };

    await checkOutputGuardrails('Hello world', guardrails as any, context);

    // 4th argument should be context, not {}
    expect(executeMock).toHaveBeenCalledWith(
      expect.anything(), // guardrails
      'Hello world', // text
      'output', // kind
      context, // context — NOT {}
      undefined, // llmEval
      undefined, // policy
    );
  });

  it('passes policy to pipeline.execute', async () => {
    const guardrails = [{ name: 'pii-check', kind: 'output' as const, rules: [], priority: 1 }];
    const context = { sourceAgent: 'agent-1' };
    const policy = {
      disabledGuardrails: [],
      ruleOverrides: [],
      settings: { failMode: 'open' as const },
    };

    await checkOutputGuardrails('Hello', guardrails as any, context, policy as any);

    expect(executeMock).toHaveBeenCalledWith(
      expect.anything(),
      'Hello',
      'output',
      context,
      undefined,
      policy,
    );
  });

  it('returns modifiedContent when guardrails pass but modify output', async () => {
    executeMock.mockResolvedValue({ passed: true, modifiedContent: 'Redacted output' });
    const guardrails = [{ name: 'pii-check', kind: 'output' as const, rules: [], priority: 1 }];

    const result = await checkOutputGuardrails('Sensitive data', guardrails as any, {});

    expect(result.passed).toBe(true);
    expect(result.text).toBe('Redacted output');
    expect(result.modifiedContent).toBe('Redacted output');
  });
});
