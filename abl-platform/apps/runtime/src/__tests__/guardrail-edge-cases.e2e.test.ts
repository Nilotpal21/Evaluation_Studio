/**
 * Edge case e2e tests for guardrail system resilience.
 *
 * Tests circuit breaker behavior, fail-open/fail-closed modes,
 * budget enforcement schema, and caching schema validation
 * through the pipeline and provider registry.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type {
  Guardrail,
  GuardrailModelProvider,
  GuardrailEvalRequest,
  GuardrailEvalResult,
  PipelinePolicy,
} from '@abl/compiler';
import {
  GuardrailPipelineImpl,
  GuardrailProviderRegistry,
  CircuitBreaker,
  createEmptyPipelineResult,
} from '@abl/compiler';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeModelGuardrail(
  name: string,
  provider: string,
  overrides: Partial<Guardrail> = {},
): Guardrail {
  return {
    name,
    description: `Test: ${name}`,
    kind: 'output',
    priority: 1,
    tier: 'model',
    provider,
    check: undefined,
    action: { type: 'block', message: `Blocked by ${name}` },
    threshold: 0.5,
    ...overrides,
  };
}

function makeLocalGuardrail(
  name: string,
  check: string,
  overrides: Partial<Guardrail> = {},
): Guardrail {
  return {
    name,
    description: `Test: ${name}`,
    kind: 'input',
    priority: 1,
    tier: 'local',
    check,
    action: { type: 'block', message: `Blocked by ${name}` },
    ...overrides,
  };
}

function createProvider(
  name: string,
  evaluateFn: (req: GuardrailEvalRequest) => Promise<GuardrailEvalResult>,
): GuardrailModelProvider {
  return {
    name,
    costPerEvalUsd: 0.001,
    evaluate: evaluateFn,
    isAvailable: async () => true,
  };
}

function buildPipeline(providers: GuardrailModelProvider[]): GuardrailPipelineImpl {
  const registry = new GuardrailProviderRegistry();
  for (const p of providers) registry.register(p);
  return new GuardrailPipelineImpl(registry);
}

// ===========================================================================
// 1. Circuit Breaker — Provider fails N times → circuit opens → recovery
// ===========================================================================

describe('Circuit breaker end-to-end', () => {
  it('circuit opens after threshold failures, requests short-circuit to safe', async () => {
    let callCount = 0;
    const failingProvider = createProvider('flaky-api', async (req) => {
      callCount++;
      throw new Error(`Failure #${callCount}`);
    });

    // Use a registry with a low threshold (2 failures to open)
    const registry = new GuardrailProviderRegistry({ failureThreshold: 2, resetTimeoutMs: 60000 });
    registry.register(failingProvider);
    const pipeline = new GuardrailPipelineImpl(registry);
    const guardrails = [makeModelGuardrail('flaky-check', 'flaky-api')];

    // First evaluation — provider fails, circuit records failure 1
    const result1 = await pipeline.execute(guardrails, 'test content 1', 'output', {});
    expect(result1.passed).toBe(true); // fail-open default

    // Second evaluation — provider fails, circuit records failure 2, circuit opens
    const result2 = await pipeline.execute(guardrails, 'test content 2', 'output', {});
    expect(result2.passed).toBe(true); // still fail-open

    // Third evaluation — circuit is open, provider not called, short-circuits to safe
    const result3 = await pipeline.execute(guardrails, 'test content 3', 'output', {});
    expect(result3.passed).toBe(true);

    // Provider should have been called only twice (not for the third request)
    expect(callCount).toBe(2);
  });

  it('circuit breaker with fail-closed blocks when circuit is open', async () => {
    let callCount = 0;
    const failingProvider = createProvider('strict-api', async () => {
      callCount++;
      throw new Error('Service down');
    });

    const registry = new GuardrailProviderRegistry({ failureThreshold: 1, resetTimeoutMs: 60000 });
    registry.register(failingProvider);
    const pipeline = new GuardrailPipelineImpl(registry);
    const guardrails = [makeModelGuardrail('strict-check', 'strict-api')];
    const policy: PipelinePolicy = { settings: { failMode: 'closed' } };

    // First call fails, opens circuit
    const result1 = await pipeline.execute(guardrails, 'test', 'output', {}, undefined, policy);
    expect(result1.passed).toBe(false); // fail-closed blocks

    // Second call — circuit is open, provider not called but fail-closed blocks
    const result2 = await pipeline.execute(guardrails, 'test2', 'output', {}, undefined, policy);
    expect(result2.passed).toBe(false);

    // Provider called only once (first call; second is short-circuited by open breaker)
    expect(callCount).toBe(1);
  });

  it('circuit breaker recovers after reset timeout (half-open → success → closed)', async () => {
    let callCount = 0;
    let shouldFail = true;
    const recoveringProvider = createProvider('recovering-api', async (req) => {
      callCount++;
      if (shouldFail) throw new Error('Temporarily down');
      return { score: 0.0, severity: 'safe' as const, category: req.category, latencyMs: 5 };
    });

    // Very short reset timeout for testing
    const registry = new GuardrailProviderRegistry({ failureThreshold: 1, resetTimeoutMs: 50 });
    registry.register(recoveringProvider);
    const pipeline = new GuardrailPipelineImpl(registry);
    const guardrails = [makeModelGuardrail('recover-check', 'recovering-api')];

    // Fail once — opens circuit
    await pipeline.execute(guardrails, 'test', 'output', {});
    expect(callCount).toBe(1);

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));

    // Provider "recovers"
    shouldFail = false;

    // Circuit should be half-open, allows one test request
    const result = await pipeline.execute(guardrails, 'test', 'output', {});
    expect(result.passed).toBe(true);
    expect(callCount).toBe(2);

    // Circuit should be closed again — next call also succeeds
    const result2 = await pipeline.execute(guardrails, 'test', 'output', {});
    expect(result2.passed).toBe(true);
    expect(callCount).toBe(3);
  });

  it('policy providerOverrides can customize circuit breaker thresholds', async () => {
    let callCount = 0;
    const provider = createProvider('configurable-api', async () => {
      callCount++;
      throw new Error('Always fails');
    });

    // Default circuit breaker has high threshold
    const registry = new GuardrailProviderRegistry({
      failureThreshold: 100,
      resetTimeoutMs: 60000,
    });
    registry.register(provider);
    const pipeline = new GuardrailPipelineImpl(registry);
    const guardrails = [makeModelGuardrail('config-check', 'configurable-api')];

    // Policy overrides circuit breaker to open after 1 failure
    const policy: PipelinePolicy = {
      providerOverrides: [
        {
          providerName: 'configurable-api',
          circuitBreaker: { failureThreshold: 1, resetTimeoutMs: 60000 },
        },
      ],
    };

    // First call — fails, circuit opens (due to policy override threshold=1)
    await pipeline.execute(guardrails, 'test1', 'output', {}, undefined, policy);
    expect(callCount).toBe(1);

    // Second call — circuit should be open, provider not called
    await pipeline.execute(guardrails, 'test2', 'output', {}, undefined, policy);
    // With the override applied, the second call should not invoke the provider
    // The registry replaces the breaker with the new threshold
    expect(callCount).toBe(1);
  });
});

// ===========================================================================
// 2. Fail-open mode — provider errors allow content through
// ===========================================================================

describe('Fail-open mode', () => {
  it('provider throwing error passes content through (default fail-open)', async () => {
    const provider = createProvider('error-api', async () => {
      throw new Error('Provider timeout');
    });

    const pipeline = buildPipeline([provider]);
    const guardrails = [makeModelGuardrail('error-check', 'error-api')];

    const result = await pipeline.execute(guardrails, 'some content', 'output', {});
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });

  it('unregistered provider passes in fail-open mode', async () => {
    const pipeline = buildPipeline([]); // no custom providers registered
    const guardrails = [makeModelGuardrail('missing-provider-check', 'nonexistent-api')];

    const result = await pipeline.execute(guardrails, 'content', 'output', {});
    expect(result.passed).toBe(true);
  });

  it('Tier 1 CEL evaluation error passes in fail-open (default)', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [makeLocalGuardrail('cel-error', 'INVALID_FUNCTION()', { kind: 'output' })];

    const result = await pipeline.execute(guardrails, 'test', 'output', {});
    expect(result.passed).toBe(true);
  });

  it('Tier 3 LLM unavailable passes in fail-open', async () => {
    // No LLM function provided — Tier 3 skips gracefully
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'llm-check',
        description: 'LLM safety check',
        kind: 'output',
        priority: 1,
        tier: 'llm',
        llmCheck: 'Is this content safe?',
        action: { type: 'block' },
      },
    ];

    const result = await pipeline.execute(guardrails, 'test content', 'output', {});
    expect(result.passed).toBe(true);
    expect(result.violations).toHaveLength(0);
  });
});

// ===========================================================================
// 3. Fail-closed mode — provider errors block content
// ===========================================================================

describe('Fail-closed mode', () => {
  it('provider throwing error blocks content with fail-closed policy', async () => {
    const provider = createProvider('error-api', async () => {
      throw new Error('Service unavailable');
    });

    const pipeline = buildPipeline([provider]);
    const guardrails = [makeModelGuardrail('closed-check', 'error-api')];
    const policy: PipelinePolicy = { settings: { failMode: 'closed' } };

    const result = await pipeline.execute(guardrails, 'content', 'output', {}, undefined, policy);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
    expect(result.violations[0].action).toBe('block');
  });

  it('unregistered provider blocks in fail-closed mode', async () => {
    const pipeline = buildPipeline([]);
    const guardrails = [makeModelGuardrail('no-provider-check', 'nonexistent-api')];
    const policy: PipelinePolicy = { settings: { failMode: 'closed' } };

    const result = await pipeline.execute(guardrails, 'content', 'output', {}, undefined, policy);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
  });

  it('Tier 1 CEL error blocks with fail-closed', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails = [makeLocalGuardrail('cel-fail-closed', 'INVALID()', { kind: 'output' })];
    const policy: PipelinePolicy = { settings: { failMode: 'closed' } };

    const result = await pipeline.execute(guardrails, 'test', 'output', {}, undefined, policy);
    expect(result.passed).toBe(false);
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].action).toBe('block');
  });

  it('Tier 3 LLM unavailable blocks with fail-closed', async () => {
    const pipeline = new GuardrailPipelineImpl();
    const guardrails: Guardrail[] = [
      {
        name: 'llm-closed-check',
        description: 'LLM safety check',
        kind: 'output',
        priority: 1,
        tier: 'llm',
        llmCheck: 'Check safety',
        action: { type: 'block' },
      },
    ];
    const policy: PipelinePolicy = { settings: { failMode: 'closed' } };

    const result = await pipeline.execute(guardrails, 'content', 'output', {}, undefined, policy);
    expect(result.passed).toBe(false);
    expect(result.violations.length).toBeGreaterThanOrEqual(1);
  });

  it('mixed fail modes: fail-open for Tier 1 + fail-closed for Tier 2 via single policy', async () => {
    // With fail-closed policy, both tiers use the same fail mode
    const provider = createProvider('mixed-api', async () => {
      throw new Error('Down');
    });
    const pipeline = buildPipeline([provider]);

    const guardrails = [
      makeLocalGuardrail('local-invalid', 'INVALID_CEL()', { kind: 'output' }),
      makeModelGuardrail('model-down', 'mixed-api'),
    ];

    // Default (fail-open) — both errors pass
    const resultOpen = await pipeline.execute(guardrails, 'test', 'output', {});
    expect(resultOpen.passed).toBe(true);

    // fail-closed — both errors block
    const policy: PipelinePolicy = { settings: { failMode: 'closed' } };
    const resultClosed = await pipeline.execute(
      guardrails,
      'test',
      'output',
      {},
      undefined,
      policy,
    );
    expect(resultClosed.passed).toBe(false);
    expect(resultClosed.violations.length).toBeGreaterThanOrEqual(1);
  });
});

// ===========================================================================
// 4. Budget enforcement — schema validation and overspend actions
// ===========================================================================

describe('Budget enforcement schema', () => {
  it('budget fields exist in the guardrail policy model schema', async () => {
    // Validate the budget interface structure by importing and inspecting the model
    const { GuardrailPolicy } = await import('@agent-platform/database/models');
    const schema = GuardrailPolicy.schema;

    // Verify budget sub-schema paths exist
    expect(schema.path('budget.monthlyLimitUsd')).toBeDefined();
    expect(schema.path('budget.currentSpendUsd')).toBeDefined();
    expect(schema.path('budget.overspendAction')).toBeDefined();
  });

  it('overspendAction enum validates correctly', async () => {
    const { GuardrailPolicy } = await import('@agent-platform/database/models');
    const schema = GuardrailPolicy.schema;
    const overspendPath = schema.path('budget.overspendAction');

    // The enum should include the three valid values
    expect(overspendPath).toBeDefined();
    const enumValues = (overspendPath as any).enumValues;
    expect(enumValues).toContain('downgrade');
    expect(enumValues).toContain('disable_model_checks');
    expect(enumValues).toContain('alert_only');
  });

  it('pipeline tracks cost per evaluation via metrics', async () => {
    const provider = createProvider('costed-api', async (req) => ({
      score: 0.1,
      severity: 'safe' as const,
      category: req.category,
      latencyMs: 5,
    }));
    // Override cost
    (provider as any).costPerEvalUsd = 0.05;

    const pipeline = buildPipeline([provider]);
    const guardrails = [makeModelGuardrail('cost-track', 'costed-api')];

    const result = await pipeline.execute(guardrails, 'test content', 'output', {});
    expect(result.passed).toBe(true);
    expect(result.metrics.costUsd).toBeGreaterThan(0);
  });

  it('multiple evaluations accumulate cost in metrics', async () => {
    const provider = createProvider('multi-cost-api', async (req) => ({
      score: 0.1,
      severity: 'safe' as const,
      category: req.category,
      latencyMs: 2,
    }));
    (provider as any).costPerEvalUsd = 0.01;

    const pipeline = buildPipeline([provider]);

    // Two guardrails using the same provider — parallel execution
    const guardrails = [
      makeModelGuardrail('cost-1', 'multi-cost-api'),
      makeModelGuardrail('cost-2', 'multi-cost-api', { priority: 2 }),
    ];

    const result = await pipeline.execute(guardrails, 'test', 'output', {});
    expect(result.passed).toBe(true);
    // Both evaluations should have accumulated cost
    expect(result.metrics.costUsd).toBeCloseTo(0.02, 5);
  });
});

// ===========================================================================
// 5. Caching — schema validation and TTL fields
// ===========================================================================

describe('Caching schema and configuration', () => {
  it('caching fields exist in the guardrail policy model schema', async () => {
    const { GuardrailPolicy } = await import('@agent-platform/database/models');
    const schema = GuardrailPolicy.schema;

    expect(schema.path('caching.enabled')).toBeDefined();
    expect(schema.path('caching.exactMatch')).toBeDefined();
    expect(schema.path('caching.semanticMatch')).toBeDefined();
    expect(schema.path('caching.semanticThreshold')).toBeDefined();
    expect(schema.path('caching.defaultTtlSeconds')).toBeDefined();
  });

  it('caching metrics fields exist in pipeline result', () => {
    const emptyResult = createEmptyPipelineResult();
    expect(emptyResult.metrics.cacheHits).toBe(0);
    expect(emptyResult.metrics.cacheMisses).toBe(0);
  });

  it('pipeline result includes cache metrics even without caching enabled', async () => {
    const provider = createProvider('cache-test-api', async (req) => ({
      score: 0.0,
      severity: 'safe' as const,
      category: req.category,
      latencyMs: 1,
    }));

    const pipeline = buildPipeline([provider]);
    const guardrails = [makeModelGuardrail('cache-check', 'cache-test-api')];

    const result = await pipeline.execute(guardrails, 'content', 'output', {});
    expect(result.metrics.cacheHits).toBeDefined();
    expect(result.metrics.cacheMisses).toBeDefined();
    // Without caching, both should be 0
    expect(result.metrics.cacheHits).toBe(0);
    expect(result.metrics.cacheMisses).toBe(0);
  });

  it('streaming settings fields exist in the policy model schema', async () => {
    const { GuardrailPolicy } = await import('@agent-platform/database/models');
    const schema = GuardrailPolicy.schema;

    expect(schema.path('settings.streaming.enabled')).toBeDefined();
    expect(schema.path('settings.streaming.defaultInterval')).toBeDefined();
    expect(schema.path('settings.streaming.chunkSize')).toBeDefined();
    expect(schema.path('settings.streaming.maxLatencyMs')).toBeDefined();
    expect(schema.path('settings.streaming.earlyTermination')).toBeDefined();
  });
});

// ===========================================================================
// 6. Circuit breaker state machine edge cases (integration with registry)
// ===========================================================================

describe('Circuit breaker state machine integration', () => {
  it('half-open state allows probe request through registry', async () => {
    let callCount = 0;
    let shouldFail = true;
    const provider = createProvider('halfopen-api', async (req) => {
      callCount++;
      if (shouldFail) throw new Error('Down');
      return { score: 0.0, severity: 'safe' as const, category: req.category, latencyMs: 1 };
    });

    const registry = new GuardrailProviderRegistry({ failureThreshold: 1, resetTimeoutMs: 50 });
    registry.register(provider);

    // Fail once — opens circuit
    await registry.evaluate('halfopen-api', { content: 'test', category: 'general' });
    expect(callCount).toBe(1);

    // Immediate retry — circuit is open, should not call provider
    const openResult = await registry.evaluate('halfopen-api', {
      content: 'test',
      category: 'general',
    });
    expect(callCount).toBe(1); // not incremented
    expect(openResult?.score).toBe(0.0); // safe fallback (fail-open)

    // Wait for reset timeout
    await new Promise((r) => setTimeout(r, 60));

    // Circuit is now half-open — next call should reach provider
    shouldFail = false;
    const halfOpenResult = await registry.evaluate('halfopen-api', {
      content: 'test',
      category: 'general',
    });
    expect(callCount).toBe(2);
    expect(halfOpenResult?.score).toBe(0.0); // safe result from provider
  });

  it('registry returns fail-closed result when circuit is open', async () => {
    const provider = createProvider('closed-circuit-api', async () => {
      throw new Error('Always fails');
    });

    const registry = new GuardrailProviderRegistry({ failureThreshold: 1, resetTimeoutMs: 60000 });
    registry.register(provider);

    // Fail once — opens circuit
    await registry.evaluate('closed-circuit-api', { content: 'test', category: 'general' });

    // Circuit is open — with fail-closed, should return high score
    const result = await registry.evaluate(
      'closed-circuit-api',
      { content: 'test', category: 'general' },
      { failMode: 'closed' },
    );
    expect(result?.score).toBe(1.0);
    expect(result?.severity).toBe('critical');
  });

  it('multiple providers have independent circuit breakers', async () => {
    let apiACallCount = 0;
    let apiBCallCount = 0;

    const providerA = createProvider('api-a', async () => {
      apiACallCount++;
      throw new Error('A is down');
    });
    const providerB = createProvider('api-b', async (req) => {
      apiBCallCount++;
      return { score: 0.0, severity: 'safe' as const, category: req.category, latencyMs: 1 };
    });

    const registry = new GuardrailProviderRegistry({ failureThreshold: 1, resetTimeoutMs: 60000 });
    registry.register(providerA);
    registry.register(providerB);

    // Fail provider A — opens its circuit
    await registry.evaluate('api-a', { content: 'test', category: 'general' });
    expect(apiACallCount).toBe(1);

    // Provider A circuit is open — not called again
    await registry.evaluate('api-a', { content: 'test', category: 'general' });
    expect(apiACallCount).toBe(1);

    // Provider B should still work — independent circuit
    const resultB = await registry.evaluate('api-b', { content: 'test', category: 'general' });
    expect(apiBCallCount).toBe(1);
    expect(resultB?.score).toBe(0.0);
  });
});
