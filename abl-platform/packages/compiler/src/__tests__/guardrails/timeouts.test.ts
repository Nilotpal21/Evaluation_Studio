import { describe, it, expect } from 'vitest';
import { GuardrailPipelineImpl } from '../../platform/guardrails/pipeline';
import { GuardrailProviderRegistry } from '../../platform/guardrails/provider-registry';
import type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
} from '../../platform/guardrails/provider';
import type { Guardrail } from '../../platform/ir/schema';

function makeGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'timeout-guard',
    description: 'timeout guardrail',
    kind: 'input',
    priority: 1,
    tier: 'local',
    check: 'true',
    action: { type: 'block', message: 'Timed out' },
    ...overrides,
  };
}

function busyWait(ms: number): void {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    // Busy loop used only in tests to simulate a slow synchronous CEL check.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class SlowProvider implements GuardrailModelProvider {
  readonly name = 'slow-provider';
  readonly costPerEvalUsd = 0;

  async evaluate(_request: GuardrailEvalRequest) {
    await delay(25);
    return {
      score: 0,
      severity: 'safe' as const,
      category: 'general',
      latencyMs: 25,
    };
  }

  async isAvailable() {
    return true;
  }
}

describe('Guardrail timeout threading', () => {
  it('treats slow local checks as failures when the local timeout is exceeded', async () => {
    const pipeline = new GuardrailPipelineImpl();
    (pipeline as any).tier1.env = {
      evaluate: () => {
        busyWait(15);
        return false;
      },
    };

    const result = await pipeline.execute(
      [makeGuardrail({ name: 'slow-local', check: 'slow_local()' })],
      'test content',
      'input',
      {},
      undefined,
      {
        settings: {
          failMode: 'closed',
          timeouts: { local: 1 },
        },
      } as any,
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].name).toBe('slow-local');
  });

  it('treats slow model checks as failures when the model timeout is exceeded', async () => {
    const registry = new GuardrailProviderRegistry();
    registry.register(new SlowProvider());
    const pipeline = new GuardrailPipelineImpl(registry);

    const result = await pipeline.execute(
      [
        makeGuardrail({
          name: 'slow-model',
          tier: 'model',
          provider: 'slow-provider',
          check: undefined,
        }),
      ],
      'test content',
      'input',
      {},
      undefined,
      {
        settings: {
          failMode: 'closed',
          timeouts: { model: 1 },
        },
      } as any,
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].name).toBe('slow-model');
  });

  it('treats slow llm checks as failures when the llm timeout is exceeded', async () => {
    const slowLlm = async () => {
      await delay(25);
      return JSON.stringify({ score: 0, explanation: 'safe' });
    };
    const pipeline = new GuardrailPipelineImpl(undefined, slowLlm);

    const result = await pipeline.execute(
      [
        makeGuardrail({
          name: 'slow-llm',
          tier: 'llm',
          llmCheck: 'Evaluate this content',
          check: undefined,
        }),
      ],
      'test content',
      'input',
      {},
      undefined,
      {
        settings: {
          failMode: 'closed',
          timeouts: { llm: 1 },
        },
      } as any,
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].name).toBe('slow-llm');
  });
});
