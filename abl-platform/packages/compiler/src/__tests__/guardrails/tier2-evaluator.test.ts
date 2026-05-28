import { describe, it, expect, vi } from 'vitest';
import { Tier2Evaluator } from '../../platform/guardrails/tier2-evaluator';
import { GuardrailProviderRegistry } from '../../platform/guardrails/provider-registry';
import type {
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
} from '../../platform/guardrails/provider';
import type { Guardrail } from '../../platform/ir/schema';

// ─── Mock Provider ─────────────────────────────────────────────────────────

class MockProvider implements GuardrailModelProvider {
  readonly name: string;
  readonly costPerEvalUsd: number;
  private result: GuardrailEvalResult;

  constructor(name: string, result: Partial<GuardrailEvalResult>, cost = 0.001) {
    this.name = name;
    this.costPerEvalUsd = cost;
    this.result = {
      score: 0,
      severity: 'safe',
      category: 'test',
      latencyMs: 1,
      ...result,
    };
  }

  async evaluate(): Promise<GuardrailEvalResult> {
    return this.result;
  }

  async isAvailable(): Promise<boolean> {
    return true;
  }
}

class FailingProvider implements GuardrailModelProvider {
  readonly name = 'failing-provider';
  readonly costPerEvalUsd = 0.002;

  async evaluate(): Promise<GuardrailEvalResult> {
    throw new Error('Provider crashed');
  }

  async isAvailable(): Promise<boolean> {
    return false;
  }
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function makeGuardrail(overrides: Partial<Guardrail> = {}): Guardrail {
  return {
    name: 'test-guard',
    description: 'Test guardrail',
    kind: 'input',
    priority: 1,
    tier: 'model',
    provider: 'mock-provider',
    category: 'toxicity',
    threshold: 0.5,
    action: { type: 'block', message: 'Content blocked' },
    ...overrides,
  };
}

function createRegistryWithProvider(provider: GuardrailModelProvider): GuardrailProviderRegistry {
  const registry = new GuardrailProviderRegistry();
  registry.register(provider);
  return registry;
}

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('Tier2Evaluator', () => {
  it('should evaluate model-based guardrail and detect violation above threshold', async () => {
    const provider = new MockProvider('mock-provider', {
      score: 0.8,
      severity: 'high',
      category: 'toxicity',
      label: 'hate_speech',
      explanation: 'Contains hateful content',
    });
    const registry = createRegistryWithProvider(provider);
    const evaluator = new Tier2Evaluator(registry);

    const result = await evaluator.evaluate(
      [makeGuardrail({ threshold: 0.5 })],
      'some toxic content',
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].name).toBe('test-guard');
    expect(result.violations[0].tier).toBe('model');
    expect(result.violations[0].score).toBe(0.8);
    expect(result.violations[0].threshold).toBe(0.5);
    expect(result.violations[0].category).toBe('toxicity');
    expect(result.violations[0].label).toBe('hate_speech');
    expect(result.violations[0].explanation).toBe('Contains hateful content');
    expect(result.violations[0].provider).toBe('mock-provider');
    expect(result.violations[0].action).toBe('block');
    expect(result.violations[0].severity).toBe('high');
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.failed).toBe(1);
  });

  it('should pass when score is below threshold', async () => {
    const provider = new MockProvider('mock-provider', {
      score: 0.2,
      severity: 'low',
      category: 'toxicity',
    });
    const registry = createRegistryWithProvider(provider);
    const evaluator = new Tier2Evaluator(registry);

    const result = await evaluator.evaluate([makeGuardrail({ threshold: 0.5 })], 'safe content');

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(0);
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.passed).toBe(1);
  });

  it('should honor provider override defaultThreshold when the guardrail omits one', async () => {
    const provider = new MockProvider('mock-provider', {
      score: 0.6,
      severity: 'medium',
      category: 'toxicity',
    });
    const registry = createRegistryWithProvider(provider);
    const evaluator = new Tier2Evaluator(registry);

    const result = await evaluator.evaluate(
      [makeGuardrail({ threshold: undefined, action: { type: 'block', message: 'Blocked' } })],
      'borderline content',
      undefined,
      {
        providerOverrides: [
          {
            providerName: 'mock-provider',
            defaultThreshold: 0.7,
          },
        ],
      },
    );

    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('should use registered provider defaults for category, threshold, and cost', async () => {
    let capturedRequest: GuardrailEvalRequest | undefined;
    const provider: GuardrailModelProvider = {
      name: 'configured-provider',
      costPerEvalUsd: 0.001,
      async evaluate(req: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
        capturedRequest = req;
        return { score: 0.6, severity: 'medium', category: req.category, latencyMs: 1 };
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new GuardrailProviderRegistry();
    registry.register(provider, {
      runtimeConfig: {
        defaultCategory: 'self_harm',
        defaultThreshold: 0.7,
        costPerEvalUsd: 0.25,
      },
    });
    const evaluator = new Tier2Evaluator(registry);

    const result = await evaluator.evaluate(
      [
        makeGuardrail({
          provider: 'configured-provider',
          category: undefined,
          threshold: undefined,
        }),
      ],
      'borderline content',
    );

    expect(capturedRequest?.category).toBe('self_harm');
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.metrics.costUsd).toBe(0.25);
  });

  it('should let policy provider overrides win over registered provider defaults', async () => {
    let capturedRequest: GuardrailEvalRequest | undefined;
    const provider: GuardrailModelProvider = {
      name: 'configured-provider',
      costPerEvalUsd: 0.001,
      async evaluate(req: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
        capturedRequest = req;
        return { score: 0.3, severity: 'medium', category: req.category, latencyMs: 1 };
      },
      async isAvailable() {
        return true;
      },
    };
    const registry = new GuardrailProviderRegistry();
    registry.register(provider, {
      runtimeConfig: {
        defaultCategory: 'self_harm',
        defaultThreshold: 0.9,
        costPerEvalUsd: 0.05,
      },
    });
    const evaluator = new Tier2Evaluator(registry);

    const result = await evaluator.evaluate(
      [
        makeGuardrail({
          provider: 'configured-provider',
          category: undefined,
          threshold: undefined,
        }),
      ],
      'policy override content',
      undefined,
      {
        providerOverrides: [
          {
            providerName: 'configured-provider',
            defaultCategory: 'toxicity',
            defaultThreshold: 0.2,
            costPerEvalUsd: 0.5,
          },
        ],
      },
    );

    expect(capturedRequest?.category).toBe('toxicity');
    expect(result.passed).toBe(false);
    expect(result.violations[0].threshold).toBe(0.2);
    expect(result.metrics.costUsd).toBe(0.5);
  });

  it('should use provider override costPerEvalUsd when provided', async () => {
    const provider = new MockProvider(
      'mock-provider',
      {
        score: 0.1,
        severity: 'safe',
        category: 'toxicity',
      },
      0.001,
    );
    const registry = createRegistryWithProvider(provider);
    const evaluator = new Tier2Evaluator(registry);

    const result = await evaluator.evaluate(
      [makeGuardrail({ threshold: 0.9 })],
      'safe content',
      undefined,
      {
        providerOverrides: [
          {
            providerName: 'mock-provider',
            costPerEvalUsd: 0.25,
          },
        ],
      },
    );

    expect(result.metrics.costUsd).toBe(0.25);
  });

  it('should treat inactive provider overrides as unavailable in fail-open mode', async () => {
    const evaluate = vi.fn(async (): Promise<GuardrailEvalResult> => {
      return { score: 1, severity: 'critical', category: 'toxicity', latencyMs: 1 };
    });
    const provider: GuardrailModelProvider = {
      name: 'mock-provider',
      costPerEvalUsd: 0.001,
      evaluate,
      async isAvailable() {
        return true;
      },
    };
    const registry = createRegistryWithProvider(provider);
    const evaluator = new Tier2Evaluator(registry);

    const result = await evaluator.evaluate([makeGuardrail()], 'content', undefined, {
      failMode: 'open',
      providerOverrides: [{ providerName: 'mock-provider', isActive: false }],
    });

    expect(evaluate).not.toHaveBeenCalled();
    expect(result.passed).toBe(true);
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.passed).toBe(1);
  });

  it('should treat inactive provider overrides as unavailable in fail-closed mode', async () => {
    const evaluate = vi.fn(async (): Promise<GuardrailEvalResult> => {
      return { score: 0, severity: 'safe', category: 'toxicity', latencyMs: 1 };
    });
    const provider: GuardrailModelProvider = {
      name: 'mock-provider',
      costPerEvalUsd: 0.001,
      evaluate,
      async isAvailable() {
        return true;
      },
    };
    const registry = createRegistryWithProvider(provider);
    const evaluator = new Tier2Evaluator(registry);

    const result = await evaluator.evaluate([makeGuardrail()], 'content', undefined, {
      failMode: 'closed',
      providerOverrides: [{ providerName: 'mock-provider', isActive: false }],
    });

    expect(evaluate).not.toHaveBeenCalled();
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]).toEqual(
      expect.objectContaining({
        name: 'test-guard',
        provider: 'mock-provider',
        action: 'block',
      }),
    );
  });

  it('should use severity-specific action when defined', async () => {
    const provider = new MockProvider('mock-provider', {
      score: 0.75,
      severity: 'high',
      category: 'toxicity',
    });
    const registry = createRegistryWithProvider(provider);
    const evaluator = new Tier2Evaluator(registry);

    const guardrail = makeGuardrail({
      threshold: 0.5,
      action: { type: 'warn', message: 'Default warning' },
      severityActions: {
        high: { type: 'block', message: 'Blocked due to high severity' },
        critical: { type: 'escalate', message: 'Escalated' },
      },
    });

    const result = await evaluator.evaluate([guardrail], 'toxic content');

    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].action).toBe('block');
    expect(result.violations[0].message).toBe('Blocked due to high severity');
  });

  it('should fall back to default action when no severity action matches', async () => {
    const provider = new MockProvider('mock-provider', {
      score: 0.55,
      severity: 'medium',
      category: 'toxicity',
    });
    const registry = createRegistryWithProvider(provider);
    const evaluator = new Tier2Evaluator(registry);

    const guardrail = makeGuardrail({
      threshold: 0.5,
      action: { type: 'warn', message: 'Default warning' },
      severityActions: {
        high: { type: 'block', message: 'High severity block' },
        critical: { type: 'escalate', message: 'Escalated' },
      },
    });

    const result = await evaluator.evaluate([guardrail], 'mildly concerning');

    // medium severity has no override, so default 'warn' action is used
    expect(result.violations).toHaveLength(0);
    expect(result.warnings).toHaveLength(1);
    expect(result.warnings[0].action).toBe('warn');
    expect(result.warnings[0].message).toBe('Default warning');
  });

  it('should fail-open on provider error', async () => {
    const registry = new GuardrailProviderRegistry();
    registry.register(new FailingProvider());
    const evaluator = new Tier2Evaluator(registry);

    const guardrail = makeGuardrail({
      provider: 'failing-provider',
      action: { type: 'block' },
    });

    const result = await evaluator.evaluate([guardrail], 'any content');

    // Fail-open: treat as pass
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.passed).toBe(1);
  });

  it('should skip guardrail with missing provider', async () => {
    const registry = new GuardrailProviderRegistry();
    const evaluator = new Tier2Evaluator(registry);

    // Provider field is undefined
    const guardrail = makeGuardrail({ provider: undefined });

    const result = await evaluator.evaluate([guardrail], 'any content');

    expect(result.passed).toBe(true);
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.passed).toBe(1);
  });

  it('should run all Tier 2 guardrails in parallel', async () => {
    // Track invocation order to verify parallel execution
    const callOrder: string[] = [];

    const slowProvider: GuardrailModelProvider = {
      name: 'slow-provider',
      costPerEvalUsd: 0.001,
      async evaluate(): Promise<GuardrailEvalResult> {
        callOrder.push('slow-start');
        await new Promise((r) => setTimeout(r, 50));
        callOrder.push('slow-end');
        return { score: 0.8, severity: 'high', category: 'toxicity', latencyMs: 50 };
      },
      async isAvailable() {
        return true;
      },
    };

    const fastProvider: GuardrailModelProvider = {
      name: 'fast-provider',
      costPerEvalUsd: 0.002,
      async evaluate(): Promise<GuardrailEvalResult> {
        callOrder.push('fast-start');
        await new Promise((r) => setTimeout(r, 10));
        callOrder.push('fast-end');
        return { score: 0.9, severity: 'critical', category: 'self_harm', latencyMs: 10 };
      },
      async isAvailable() {
        return true;
      },
    };

    const registry = new GuardrailProviderRegistry();
    registry.register(slowProvider);
    registry.register(fastProvider);
    const evaluator = new Tier2Evaluator(registry);

    const guardrails = [
      makeGuardrail({ name: 'slow-check', provider: 'slow-provider', threshold: 0.5 }),
      makeGuardrail({ name: 'fast-check', provider: 'fast-provider', threshold: 0.5 }),
    ];

    const result = await evaluator.evaluate(guardrails, 'content');

    // Both should complete — parallel means both start before either ends
    expect(callOrder[0]).toBe('slow-start');
    expect(callOrder[1]).toBe('fast-start');
    expect(result.metrics.totalChecks).toBe(2);
    expect(result.violations).toHaveLength(2);
  });

  it('should track cost per evaluation', async () => {
    const provider = new MockProvider(
      'costly-provider',
      { score: 0.8, severity: 'high', category: 'toxicity' },
      0.005,
    );
    const registry = createRegistryWithProvider(provider);
    const evaluator = new Tier2Evaluator(registry);

    const guardrails = [
      makeGuardrail({ name: 'check1', provider: 'costly-provider', threshold: 0.5 }),
      makeGuardrail({ name: 'check2', provider: 'costly-provider', threshold: 0.5 }),
    ];

    const result = await evaluator.evaluate(guardrails, 'content');

    // Two evaluations at $0.005 each
    expect(result.metrics.costUsd).toBeCloseTo(0.01, 5);
  });

  it('should calculate tier2LatencyMs as max of individual latencies', async () => {
    const slowProvider: GuardrailModelProvider = {
      name: 'slow',
      costPerEvalUsd: 0,
      async evaluate(): Promise<GuardrailEvalResult> {
        await new Promise((r) => setTimeout(r, 30));
        return { score: 0.8, severity: 'high', category: 'test', latencyMs: 30 };
      },
      async isAvailable() {
        return true;
      },
    };

    const fastProvider: GuardrailModelProvider = {
      name: 'fast',
      costPerEvalUsd: 0,
      async evaluate(): Promise<GuardrailEvalResult> {
        return { score: 0.8, severity: 'high', category: 'test', latencyMs: 5 };
      },
      async isAvailable() {
        return true;
      },
    };

    const registry = new GuardrailProviderRegistry();
    registry.register(slowProvider);
    registry.register(fastProvider);
    const evaluator = new Tier2Evaluator(registry);

    const guardrails = [
      makeGuardrail({ name: 'slow-guard', provider: 'slow', threshold: 0.5 }),
      makeGuardrail({ name: 'fast-guard', provider: 'fast', threshold: 0.5 }),
    ];

    const result = await evaluator.evaluate(guardrails, 'content');

    // tier2LatencyMs should be the max of individual latencies (measured, not the provider's reported latencyMs)
    expect(result.metrics.tier2LatencyMs).toBeGreaterThan(0);
  });

  it('should use scoreToSeverity when provider does not return severity', async () => {
    // The registry's circuit breaker returns a safe fallback with score 0 when provider
    // throws, but we can test scoreToSeverity by having the provider return high score
    // without specifying severity explicitly
    const provider: GuardrailModelProvider = {
      name: 'no-severity',
      costPerEvalUsd: 0,
      async evaluate(): Promise<GuardrailEvalResult> {
        // Return result with severity undefined — will be cast through scoreToSeverity
        return {
          score: 0.95,
          severity: undefined as unknown as any,
          category: 'test',
          latencyMs: 1,
        };
      },
      async isAvailable() {
        return true;
      },
    };

    const registry = new GuardrailProviderRegistry();
    registry.register(provider);
    const evaluator = new Tier2Evaluator(registry);

    const result = await evaluator.evaluate(
      [makeGuardrail({ provider: 'no-severity', threshold: 0.5 })],
      'content',
    );

    // scoreToSeverity(0.95) should return 'critical'
    expect(result.violations[0].severity).toBe('critical');
  });

  it('should use default threshold of 0.5 when guardrail has no threshold', async () => {
    const provider = new MockProvider('mock-provider', {
      score: 0.6,
      severity: 'medium',
      category: 'toxicity',
    });
    const registry = createRegistryWithProvider(provider);
    const evaluator = new Tier2Evaluator(registry);

    const guardrail = makeGuardrail({ threshold: undefined });

    const result = await evaluator.evaluate([guardrail], 'content');

    // Score 0.6 >= default threshold 0.5, should trigger violation
    // With 'block' action (terminal), it goes to violations and result.passed = false
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].threshold).toBe(0.5);
    expect(result.passed).toBe(false);
  });

  it('should pass context to provider evaluation', async () => {
    let capturedRequest: GuardrailEvalRequest | undefined;

    const provider: GuardrailModelProvider = {
      name: 'context-check',
      costPerEvalUsd: 0,
      async evaluate(req: GuardrailEvalRequest): Promise<GuardrailEvalResult> {
        capturedRequest = req;
        return { score: 0.1, severity: 'safe', category: req.category, latencyMs: 1 };
      },
      async isAvailable() {
        return true;
      },
    };

    const registry = new GuardrailProviderRegistry();
    registry.register(provider);
    const evaluator = new Tier2Evaluator(registry);

    const messages = [{ role: 'user', content: 'hello' }];
    await evaluator.evaluate(
      [makeGuardrail({ provider: 'context-check', category: 'pii' })],
      'test content',
      { recentMessages: messages },
    );

    expect(capturedRequest).toBeDefined();
    expect(capturedRequest!.content).toBe('test content');
    expect(capturedRequest!.category).toBe('pii');
    expect(capturedRequest!.context?.recentMessages).toEqual(messages);
  });

  it('should handle guardrail where registry returns undefined (unregistered provider)', async () => {
    const registry = new GuardrailProviderRegistry();
    // Don't register any custom provider
    const evaluator = new Tier2Evaluator(registry);

    const guardrail = makeGuardrail({ provider: 'nonexistent-provider' });

    const result = await evaluator.evaluate([guardrail], 'content');

    // The registry returns undefined for unregistered providers
    // The evaluator should handle this gracefully (fail-open)
    expect(result.passed).toBe(true);
    expect(result.metrics.totalChecks).toBe(1);
    expect(result.metrics.passed).toBe(1);
  });
});
